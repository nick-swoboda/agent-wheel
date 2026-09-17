'use strict';
const { resetStore } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wheel } = require('../lib/wheel');
const { createStubTransport, createTransport } = require('../lib/transport');
const { GUARDS } = require('../lib/egress');
const { auditTail } = require('../lib/store');
const { baseVersions } = require('../lib/nodes');
const cargo = require('./tiny-cargo');

function ok(r) {
  assert.equal(r.ok, true, r.error || 'turn failed');
  return r;
}

function driveToPlanDraft(wheel, outDir, routes) {
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(cargo.submitSpec(wheel, outDir, '25', routes));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
}

test('A3: a card whose frozen base versions are stale by one drop-down never reaches ConvoBus; the audit names the exact failed guard', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const transport = createStubTransport();
  const wheel = new Wheel({ transport });
  driveToPlanDraft(wheel, outDir);

  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  assert.ok(pd, 'dispatch staged');
  assert.equal(pd.seat, 'leader');
  assert.deepEqual(pd.base_versions, baseVersions(wheel.state));
  assert.match(pd.context_hash, /^[0-9a-f]{64}$/);
  assert.equal(wheel.state.wheel.phase, 'STAGING');
  assert.ok(wheel.state.frontier.next_legal.includes('egress'));
  assert.equal(transport.listCards().length, 0, 'nothing has reached ConvoBus');

  const r1 = ok(wheel.runTurn({ type: 'reopen', kind: 'experience' }));
  assert.deepEqual(r1.result.dropped, []);
  assert.equal(wheel.state.nodes.experience.reopened, true);
  assert.equal(wheel.state.nodes.plan.draft, null, 'the untried draft derived from the old version is discarded');
  assert.ok(wheel.state.pending_dispatch, 'the staged dispatch is still there; the guard is the enforcement point');

  const r2 = wheel.runTurn({ type: 'egress' });
  assert.equal(r2.ok, false);
  assert.equal(r2.guard, 'frozen_base_versions');
  assert.match(r2.error, /frozen_base_versions/);
  assert.equal(transport.listCards().length, 0, 'the card never reached ConvoBus');
  assert.equal(transport.inflight().length, 0);
  assert.equal(wheel.state.pending_dispatch, null, 'back to Staging');
  assert.equal(wheel.state.pending_seat, null);
  assert.equal(wheel.state.last_egress_refusal.guard, 'frozen_base_versions');

  const refused = auditTail(50, wheel.paths).find((a) => a.phase === 'EGRESS_GUARD' && a.ok === false);
  assert.ok(refused, 'egress refusal audited');
  assert.equal(refused.guard, 'frozen_base_versions');
  assert.match(refused.reason, /experience was v1:accepted at staging, is v1:accepted:reopened now/);
  assert.deepEqual(refused.checked, ['project_seat_identity', 'legal_stage_phase']);
  assert.equal(refused.dispatch_id, pd.dispatch_id);
  assert.equal(wheel.state.seq, r1.seq + 1);
  wheel.close();
});

test('egress passes when Look 2 equals Look 1: every guard checked in the law\'s order, then ConvoBus creates the bound card', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const transport = createStubTransport();
  const wheel = new Wheel({ transport });
  driveToPlanDraft(wheel, outDir);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  const r = ok(wheel.runTurn({ type: 'egress' }));
  assert.deepEqual(r.result.guards, GUARDS, 'all fourteen guards, in order');
  const cards = transport.listCards();
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.state, 'out');
  assert.equal(card.id, wheel.state.pending_seat.card_id);
  assert.equal(card.seat, 'claude-cli');
  assert.equal(card.method, 'stdio');
  const envelope = JSON.parse(card.body);
  assert.equal(envelope.type, 'dispatch');
  assert.equal(envelope.dispatch_id, pd.dispatch_id);
  assert.equal(envelope.context_hash, pd.context_hash);
  assert.equal(envelope.superdoc.hash, pd.context_hash, 'the sealed document carries the staged hash');
  const binding = wheel.state.cardbindings[card.id];
  assert.equal(binding.context_hash, pd.context_hash);
  assert.deepEqual(binding.base_versions, pd.base_versions);
  assert.equal(binding.result_schema, 'TRIAL_KIT');
  assert.equal(binding.route, 'claude:cli');
  assert.equal(binding.project_id, wheel.state.project.id);
  assert.equal(wheel.state.wheel.phase, 'CLOSED_RUNNING');
  const passed = auditTail(50, wheel.paths).find((a) => a.phase === 'EGRESS_GUARD' && a.ok === true);
  assert.deepEqual(passed.checked, GUARDS);
  assert.ok(auditTail(50, wheel.paths).some((a) => a.event === 'card_out' && a.card === card.id));
  wheel.close();
});

test('Look 2 restages when the Super Document changed without a version change', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const transport = createStubTransport();
  const wheel = new Wheel({ transport });
  driveToPlanDraft(wheel, outDir);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  wheel.state.nodes.plan.draft.title = 'changed between Look 1 and Look 2';
  const r = wheel.runTurn({ type: 'egress' });
  assert.equal(r.ok, false);
  assert.equal(r.guard, 'look2_fresh');
  assert.equal(transport.listCards().length, 0);
  const refused = auditTail(20, wheel.paths).find((a) => a.phase === 'EGRESS_GUARD' && a.ok === false);
  assert.equal(refused.guard, 'look2_fresh');
  assert.deepEqual(refused.checked, ['project_seat_identity', 'legal_stage_phase', 'frozen_base_versions', 'drop_down_complete', 'frontier_rebuilt']);
  wheel.close();
});

test('egress with no ready route opens ROUTE_ATTENTION naming the route; no card leaves; CHOOSE_ROUTE updates the project agent', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const transport = createTransport();
  const wheel = new Wheel({ transport });
  driveToPlanDraft(wheel, outDir, ['api:anthropic', 'api:openai']);
  assert.ok(!('allowlist' in wheel.state.routes));
  assert.equal(wheel.state.seats.leader.route, 'api:anthropic', 'the project configured the Leader before the Spec');
  assert.equal(wheel.state.seats.reviewer.route, 'api:openai', 'the Reviewer took a different configured route: rung 1 stays the default');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  assert.equal(wheel.state.pending_dispatch.route, 'api:anthropic');
  const r = wheel.runTurn({ type: 'egress' });
  assert.equal(r.ok, false);
  assert.equal(r.guard, 'route_ready');
  assert.equal(wheel.state.gate.id, 'ROUTE_ATTENTION');
  assert.equal(wheel.state.gate.def.question,
    'This exact route is not ready (not_ready: api:anthropic). Complete the shown route action, choose another allowed route, or pause the project.');
  assert.equal(wheel.state.status, 'yellow');
  assert.equal(transport.listCards().length, 0);
  assert.match(auditTail(10, wheel.paths).find((a) => a.phase === 'EGRESS_GUARD' && a.ok === false).reason, /no provider key held/);
  const outside = wheel.runTurn({ type: 'gate', action: 'CHOOSE_ROUTE', route: 'unknown:route' });
  assert.equal(outside.ok, false);
  assert.match(outside.error, /unknown route/);
  assert.equal(wheel.state.gate.id, 'ROUTE_ATTENTION');
  const chosen = ok(wheel.runTurn({ type: 'gate', action: 'CHOOSE_ROUTE', route: 'api:openai' }));
  assert.deepEqual([chosen.result.seat, chosen.result.route], ['leader', 'api:openai']);
  assert.equal(wheel.state.seats.leader.route, 'api:openai', 'a seat assignment change, audited');
  assert.equal(wheel.state.nodes.plan.stale, false, 'nothing dropped down');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  assert.equal(wheel.state.pending_dispatch.route, 'api:openai');
  const r2 = wheel.runTurn({ type: 'egress' });
  assert.equal(r2.guard, 'route_ready');
  wheel.close();
});

test('project agents can use every registered route without changing the Spec', () => {
  resetStore();
  const transport = createStubTransport();
  const wheel = new Wheel({ transport });
  driveToPlanDraft(wheel, fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-')), ['claude:cli']);
  const before = JSON.stringify(wheel.state.nodes);
  const moved = ok(wheel.runTurn({ type: 'seat_assignment', seat: 'leader', route: 'grok:cli' }));
  assert.equal(moved.result.outside_allowlist, false);
  assert.equal(JSON.stringify(wheel.state.nodes), before);
  const refused = wheel.runTurn({ type: 'seat_assignment', seat: 'leader', route: 'unknown:route' });
  assert.equal(refused.ok, false);
  assert.equal(wheel.state.seats.leader.route, 'grok:cli');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const sent = ok(wheel.runTurn({ type: 'egress' }));
  assert.equal(wheel.state.pending_seat.route, 'grok:cli');
  assert.deepEqual(sent.result.guards, GUARDS);
  assert.equal(GUARDS.length, 14);
  assert.ok(auditTail(30, wheel.paths).some(a => a.event === 'commit' && /seat assignment leader/.test(a.reason)));
  wheel.close();
});
