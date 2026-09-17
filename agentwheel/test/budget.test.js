'use strict';
const { resetStore } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../lib/paths');
const { Wheel } = require('../lib/wheel');
const { createStubTransport } = require('../lib/transport');
const { replay, budgetUsed, budgetExhausted, WINDOW_MS, SCALE } = require('../lib/reducers');
const { NODE_SCHEMAS, templateFor, BUDGET_SET } = require('../lib/schema');
const storelib = require('../lib/store');
const { snapshotBytes } = require('../lib/commit');
const { collectLeaves } = require('../lib/plan');
const gates = require('../lib/gates');
const cargo = require('./tiny-cargo');

function ok(r) {
  assert.equal(r.ok, true, r.error || 'turn failed');
  return r;
}

const SOLO = ['claude:cli'];

function clock(startIso) {
  let t = Date.parse(startIso);
  const fn = () => new Date(t).toISOString();
  fn.advance = (ms) => { t += ms; };
  fn.set = (iso) => { t = Date.parse(iso); };
  return fn;
}

function driveToPlanDraft(wheel, outDir, authority, window) {
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  const spec = cargo.spec(outDir);
  cargo.configure(wheel, authority, SOLO, window || '1 day');
  ok(wheel.runTurn({ type: 'form', kind: 'spec', content: spec }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
}

function stage(wheel, now) {
  if (wheel.state.pending_dispatch) return;
  if (wheel.state.gate && wheel.state.gate.id === 'ROUTE_ATTENTION') ok(wheel.runTurn({ type: 'gate', action: 'COMPLETE_ACTION' }));
  if (wheel.state.pending_redispatch) {
    const due = Date.parse(wheel.state.pending_redispatch.due_at);
    if (Date.parse(now()) < due) now.set(new Date(due).toISOString());
    ok(wheel.runTurn({ type: 'redispatch' }));
  } else {
    ok(wheel.runTurn({ type: 'seat_dispatch' }));
  }
}

function dispatchAndTimeOut(wheel, now) {
  stage(wheel, now);
  const r = wheel.runTurn({ type: 'egress' });
  if (!r.ok) return r;
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'timeout', detail: 'model never answered' }));
  return r;
}

test('A6: 25 dispatches inside a 1-day sliding window block the 26th and open BUDGET_GATE (yellow); review and human turns do not count; replay is byte-identical', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const now = clock('2026-09-01T09:00:00.000Z');
  const transport = createStubTransport();
  const wheel = new Wheel({ transport, now });
  driveToPlanDraft(wheel, outDir, '25', '1 day');
  assert.deepEqual([wheel.state.budget.authority, wheel.state.budget.window, wheel.state.budget.used], ['25', '1 day', 0]);
  const humanTurns = wheel.state.turns.last_id;
  assert.ok(humanTurns >= 9, 'human replies, the Design gate, and the validate seat ran');
  assert.equal(wheel.state.budget.used, 0, 'none of them was a dispatch');

  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  ok(wheel.runTurn({ type: 'egress' }));
  now.advance(60000);
  const kit = cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result', result: kit }));
  assert.equal(wheel.state.budget.used, 1);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  assert.equal(wheel.state.pending_dispatch.kind, 'review');
  ok(wheel.runTurn({ type: 'egress' }));
  assert.equal(wheel.state.budget.used, 2, 'the Reviewer dispatch counts');
  now.advance(60000);
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result',
    result: { decision: 'gap', references: ['L1.1.A1'], notes: 'thin evidence', earliest_repair: 'plan' } }));
  assert.equal(wheel.state.budget.used, 2, 'a review result turn (the return leg) is not a dispatch');
  ok(wheel.runTurn({ type: 'plan_generate' }));

  for (let i = 3; i <= 25; i++) {
    now.advance(10 * 60000);
    ok(dispatchAndTimeOut(wheel, now));
    assert.equal(wheel.state.budget.used, i);
  }
  assert.equal(wheel.state.budget.used, 25);
  assert.equal(wheel.state.gate && wheel.state.gate.id, 'ROUTE_ATTENTION', 'the route has failed the same document repeatedly');
  assert.equal(wheel.state.status, 'yellow');
  assert.ok(wheel.state.route_health[SOLO[0]].degraded);

  const preview = wheel.previewReopen('experience');
  assert.equal(preview.ok, true);
  assert.equal(wheel.state.budget.used, 25);

  now.advance(60000);
  stage(wheel, now);
  const blocked = wheel.runTurn({ type: 'egress' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.guard, 'prompt_budget');
  assert.equal(wheel.state.gate.id, 'BUDGET_GATE');
  assert.equal(wheel.state.gate.def.question, gates.humanText('BUDGET_GATE_V1'));
  assert.deepEqual(wheel.state.gate.def.actions, ['EXTEND', 'REPLAN', 'WAIT', 'STOP']);
  assert.equal(wheel.state.status, 'yellow', 'yellow, not red: red is for paused, interrupted, fatal');
  assert.equal(wheel.state.budget.used, 25, 'the blocked dispatch never left, so it did not count');
  assert.equal(transport.listCards().length, 25, 'exactly 25 cards reached ConvoBus');
  const totalTurns = wheel.state.turns.last_id;
  assert.ok(totalTurns > 25 + humanTurns, 'many more turns ran than dispatches');

  const { events, torn } = storelib.readEvents(wheel.paths);
  assert.equal(torn, null);
  const replayed = replay(events);
  assert.equal(JSON.stringify(replayed.budget), JSON.stringify(wheel.state.budget));
  assert.equal(JSON.stringify(replayed), JSON.stringify(wheel.state));
  assert.equal(fs.readFileSync(wheel.paths.snapshotPath, 'utf8'), snapshotBytes(wheel.state.seq, replayed));
  assert.ok(events.every((e) => !('now' in e)), 'time entered only as event fields');
  assert.equal(events.filter((e) => e.type === 'turn' && e.input.type === 'egress').length, 25);

  const later = new Date(Date.parse(now()) + WINDOW_MS['1 day'] + 1000).toISOString();
  assert.equal(budgetUsed(wheel.state, later), 0);
  assert.equal(budgetExhausted(wheel.state, later), false);
  assert.equal(budgetUsed(wheel.state, now()), 25);

  ok(wheel.runTurn({ type: 'gate', action: 'WAIT' }));
  assert.equal(wheel.state.gate.id, 'BUDGET_GATE');
  assert.equal(wheel.state.gate.waiting, true);
  assert.equal(wheel.state.wheel.phase, 'WAITING_GATED');
  assert.ok(wheel.state.frontier.next_legal.includes('budget_admit'));
  let admit = wheel.runTurn({ type: 'budget_admit' });
  assert.equal(admit.ok, false, 'the window is still full');
  now.set(later);
  admit = ok(wheel.runTurn({ type: 'budget_admit' }));
  assert.equal(wheel.state.gate, null);
  assert.equal(wheel.state.budget.used, 0, 'the day slid past every dispatch');
  assert.equal(wheel.state.status, 'green');
  wheel.close();
});

test('a dispatch refused before the provider was reached does not count; a timed-out one does', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const now = clock('2026-09-01T09:00:00.000Z');
  const wheel = new Wheel({ transport: createStubTransport(), now });
  driveToPlanDraft(wheel, outDir, '25', '5 hours');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  ok(wheel.runTurn({ type: 'egress' }));
  assert.equal(wheel.state.budget.used, 1);
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'refused', detail: 'HTTP 401' }));
  assert.equal(wheel.state.budget.used, 0, 'refused before the provider ran: uncounted');
  ok(dispatchAndTimeOut(wheel, now));
  assert.equal(wheel.state.budget.used, 1, 'timed out: the model may have run, so it counts');
  assert.equal(wheel.state.budget.limit, 25);
  wheel.close();
});

test('A21: the project setting offers exactly {25, 50, unlimited} and refuses anything below 25; EXTEND steps 25 -> 50 -> unlimited; REPLAN reopens Plan without changing Spec; STOP pauses', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const now = clock('2026-09-01T09:00:00.000Z');
  const wheel = new Wheel({ transport: createStubTransport(), now });
  assert.deepEqual(SCALE, ['25', '50', 'unlimited']);
  assert.deepEqual(BUDGET_SET.properties.authority.enum, SCALE, 'the setting offers exactly the scale');
  assert.ok(!('budget' in templateFor(NODE_SCHEMAS.spec)), 'and the Spec form does not ask for one');
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  assert.deepEqual([wheel.state.budget.authority, wheel.state.budget.window], ['25', '1 day'],
    'a new project starts at the law\'s default, 1 day x 25');
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  const refused = wheel.runTurn({ type: 'budget_set', authority: '5', window: '1 week' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /authority: not in enum \["25","50","unlimited"\]/);
  assert.equal(wheel.state.budget.authority, '25');
  const seqBefore = wheel.state.seq;
  const specVersionsBefore = wheel.state.nodes.spec.versions.length;
  ok(wheel.runTurn({ type: 'budget_set', authority: '25', window: '1 week' }));
  assert.deepEqual([wheel.state.budget.authority, wheel.state.budget.window], ['25', '1 week']);
  assert.equal(wheel.state.seq, seqBefore + 1, 'one event, and only one');
  assert.equal(wheel.state.gate, null, 'and no gate opened');
  assert.equal(wheel.state.nodes.spec.versions.length, specVersionsBefore, 'and no node moved');
  const spec = cargo.spec(outDir);
  ok(wheel.runTurn({ type: 'form', kind: 'spec', content: spec }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.deepEqual([wheel.state.budget.authority, wheel.state.budget.limit], ['25', 25],
    'accepting a Spec that carries no budget leaves the project\'s own alone');
  assert.equal(wheel.state.budget.window, '1 week', 'including the window it was given');
  ok(wheel.runTurn({ type: 'plan_generate' }));

  for (let i = 0; i < 25; i++) { now.advance(1000); ok(dispatchAndTimeOut(wheel, now)); }
  assert.equal(wheel.state.budget.used, 25);
  stage(wheel, now);
  assert.equal(wheel.runTurn({ type: 'egress' }).guard, 'prompt_budget');
  assert.equal(wheel.state.gate.id, 'BUDGET_GATE');
  assert.equal(wheel.state.gate.def.transitions[0], 'next scale step (25 -> 50 -> unlimited)');
  ok(wheel.runTurn({ type: 'gate', action: 'EXTEND' }));
  assert.deepEqual([wheel.state.budget.authority, wheel.state.budget.limit], ['50', 50]);
  assert.equal(wheel.state.gate, null);
  for (let i = 0; i < 25; i++) { now.advance(1000); ok(dispatchAndTimeOut(wheel, now)); }
  assert.equal(wheel.state.budget.used, 50);
  stage(wheel, now);
  assert.equal(wheel.runTurn({ type: 'egress' }).guard, 'prompt_budget');
  assert.equal(wheel.state.gate.id, 'BUDGET_GATE');
  ok(wheel.runTurn({ type: 'gate', action: 'EXTEND' }));
  assert.deepEqual([wheel.state.budget.authority, wheel.state.budget.limit], ['unlimited', null]);
  assert.equal(budgetExhausted(wheel.state, now()), false);
  ok(dispatchAndTimeOut(wheel, now));
  assert.equal(wheel.state.budget.used, 51);

  wheel.state.budget.authority = '25';
  stage(wheel, now);
  assert.equal(wheel.runTurn({ type: 'egress' }).guard, 'look2_fresh');
  assert.equal(wheel.state.pending_redispatch, null);
  stage(wheel, now);
  assert.equal(wheel.state.pending_dispatch.attempt, 0, 'a fresh dispatch');
  assert.equal(wheel.runTurn({ type: 'egress' }).guard, 'prompt_budget');
  const r = ok(wheel.runTurn({ type: 'gate', action: 'REPLAN' }));
  assert.equal(wheel.state.nodes.spec.reopened, false);
  assert.equal(wheel.state.nodes.plan.reopened, true);
  assert.equal(wheel.state.frontier.stale[0], 'plan');
  assert.equal(wheel.state.budget.authority, '25');
  ok(wheel.runTurn({ type: 'budget_set', authority: 'unlimited', window: '1 week' }));
  assert.equal(wheel.state.budget.authority, 'unlimited');
  assert.equal(wheel.state.budget.limit, null);
  assert.equal(budgetExhausted(wheel.state, now()), false);

  assert.equal(wheel.state.pending_redispatch, null, 'the drop-down dropped the waiting redispatch');
  wheel.state.budget.authority = '25';
  stage(wheel, now);
  wheel.runTurn({ type: 'egress' });
  ok(wheel.runTurn({ type: 'gate', action: 'STOP' }));
  assert.equal(wheel.state.stopped, true);
  assert.equal(wheel.state.status, 'red');
  assert.equal(wheel.state.wheel.phase, 'PAUSED');
  wheel.close();
});
