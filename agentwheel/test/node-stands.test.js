'use strict';
const { resetStore } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wheel } = require('../lib/wheel');
const { collectLeaves } = require('../lib/plan');
const { createStubTransport } = require('../lib/transport');
const { auditTail } = require('../lib/store');
const { sha256 } = require('../lib/ids');
const { refusalBackoff, backoffHolds, REFUSAL_BACKOFF_MS } = require('../surfaces/helper');
const cargo = require('./tiny-cargo');

function ok(r) {
  assert.equal(r.ok, true, r.error || 'turn failed');
  return r;
}

const ROUTES = ['claude:cli', 'chatgpt:codex'];

function newWheel() {
  const transport = createStubTransport();
  return { wheel: new Wheel({ transport }), transport };
}

function driveToExecution(wheel, outDir) {
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(cargo.submitSpec(wheel, outDir, '25', ROUTES));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'seat_assignment', seat: 'reviewer', route: 'chatgpt:codex' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
  ok(wheel.runTurn({ type: 'plan_trial', kit: cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft)) }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  assert.equal(wheel.state.execution.unlocked, true);
}

function dispatch(wheel) {
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  ok(wheel.runTurn({ type: 'egress' }));
  return wheel.state.pending_seat.card_id;
}

function buildOverBus(wheel) {
  const cardId = dispatch(wheel);
  assert.equal(wheel.state.pending_seat.kind, 'execute');
  const leaves = wheel.state.pending_seat.leaves;
  return ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: cargo.executionSubmission(leaves) }));
}

function reviewOverBus(wheel, result) {
  const cardId = dispatch(wheel);
  assert.equal(wheel.state.pending_seat.kind, 'review');
  return ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result }));
}

function versionHash(wheel, kind) {
  const v = wheel.state.nodes[kind].versions.filter((x) => x.state === 'accepted').at(-1);
  return sha256(JSON.stringify(v.content));
}

function eventsOf(wheel) {
  return fs.readFileSync(wheel.paths.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('A23: NODE_STANDS - the named human node is byte-identical before and after; the staged result is rejected with the Reviewer\'s finding; the producing seat is redispatched on its route with that finding as its previous attempt, one counted dispatch; the same finding again comes back to the gate with the count', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  const designBefore = versionHash(wheel, 'design');
  const designVersions = wheel.state.nodes.design.versions.length;

  buildOverBus(wheel);
  assert.equal(wheel.state.executions.b_1.state, 'staged');
  const builderRoute = wheel.state.pending_validation.author.route;
  const finding = { decision: 'gap', references: ['design accepted v1 N1', 'index.html body'], notes: 'the body carries a second word; N1 says exactly hello', earliest_repair: 'design' };
  reviewOverBus(wheel, finding);
  assert.equal(wheel.state.gate.id, 'HUMAN_ESCALATION');
  assert.equal(wheel.state.gate.target, 'design');
  assert.equal(wheel.state.gate.count, 1);
  assert.equal(wheel.state.executions.b_1.state, 'staged', 'the staged result stays staged until the human acts');
  assert.ok(wheel.state.gate.def.actions.includes('NODE_STANDS'), 'the fifth action is offered');
  const usedBefore = wheel.state.budget.used;

  const r = ok(wheel.runTurn({ type: 'gate', action: 'NODE_STANDS' }));
  assert.equal(r.result.target, 'design');
  assert.equal(r.result.seat, 'builder');
  assert.equal(versionHash(wheel, 'design'), designBefore, 'the named node is unchanged, byte for byte');
  assert.equal(wheel.state.nodes.design.versions.length, designVersions, 'no version was added');
  assert.equal(wheel.state.nodes.design.reopened, false, 'nothing reopened');
  assert.equal(wheel.state.executions.b_1.state, 'rejected', 'the staged result is rejected with the finding');
  assert.equal(wheel.state.pending_validation, null);
  assert.equal(wheel.state.gate, null);
  assert.match(wheel.state.last_failure.reason, /node stands \(design\): the body carries a second word/);
  assert.equal(wheel.state.last_failure.failed_branch, 'b_1');
  assert.deepEqual(wheel.state.node_stands, { 'design:N1': 1 });
  assert.equal(wheel.state.status, 'green');

  assert.deepEqual(wheel.state.frontier.next_legal, ['seat_dispatch', 'execute', 'reopen']);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.kind, 'execute');
  assert.equal(pd.seat, 'builder');
  assert.equal(pd.route, builderRoute, 'same route');
  assert.equal(pd.superdoc.previous_attempt.branch, 'b_1');
  assert.equal(pd.superdoc.previous_attempt.why, 'returned by review');
  assert.ok(Object.keys(pd.superdoc.previous_attempt.files).includes('index.html'), 'its files are offered');
  assert.match(pd.superdoc.prompt + JSON.stringify(pd.superdoc), /LAST REVIEW \(gap/, 'the finding rides with it');
  assert.match(JSON.stringify(pd.superdoc), /the body carries a second word/);
  ok(wheel.runTurn({ type: 'egress' }));
  assert.equal(wheel.state.budget.used, usedBefore + 1, 'one dispatch, counted');
  const audit = auditTail(400, wheel.paths).map((l) => JSON.stringify(l));
  assert.ok(audit.some((l) => /"reason":"gate human NODE_STANDS: design stands; execution b_1 returned to the builder seat with the finding \(1\)"/.test(l)), 'audited');

  const cardId = wheel.state.pending_seat.card_id;
  ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: cargo.executionSubmission(wheel.state.pending_seat.leaves) }));
  reviewOverBus(wheel, finding);
  assert.equal(wheel.state.gate.id, 'HUMAN_ESCALATION');
  assert.equal(wheel.state.gate.count, 2, 'the identical-finding count keeps running across NODE_STANDS');
  assert.match(wheel.state.gate.def.question, /the same finding returned 1 time before/);
  assert.equal(versionHash(wheel, 'design'), designBefore);
  wheel.close();
});

test('A23: EDIT_NODE shelves the staged seat result under the reopened node with exactly one shelved event: never validated, never staged again, no restage, no drop_down_complete refusal; the shelved attempt is the next dispatch\'s previous attempt', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  buildOverBus(wheel);
  reviewOverBus(wheel, { decision: 'gap', references: ['experience accepted v1 A1'], notes: 'A1 wants bold', earliest_repair: 'experience' });
  assert.equal(wheel.state.gate.target, 'experience');
  const auditBefore = auditTail(100000, wheel.paths).length;

  ok(wheel.runTurn({ type: 'gate', action: 'EDIT_NODE' }));
  const events = eventsOf(wheel);
  const shelved = events.filter((e) => e.type === 'shelved');
  assert.equal(shelved.length, 1, 'one shelved event');
  assert.deepEqual(shelved[0].input.subject, { kind: 'execution', branch: 'b_1' });
  assert.equal(shelved[0].input.under, 'experience');
  assert.equal(wheel.state.executions.b_1.state, 'shelved');
  assert.equal(wheel.state.branches.b_1.state, 'shelved');
  assert.equal(wheel.state.pending_validation, null, 'nothing waits for validation');
  assert.equal(wheel.state.shelved.length, 1);
  assert.equal(wheel.state.nodes.experience.reopened, true);
  assert.ok(wheel.state.frontier.next_legal.includes('form:experience') && !wheel.state.frontier.next_legal.includes('seat_dispatch'), 'the reopened node\'s form; no seat dispatch to stage');
  const refused = wheel.runTurn({ type: 'seat_dispatch' });
  assert.equal(refused.ok, false, 'nothing to stage');
  const next = cargo.experience();
  next.usability.push('one more usability line');
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: next }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(wheel.state.executions.b_1.state, 'shelved', 'a shelved result is never staged again');
  assert.equal(wheel.state.pending_validation, null);
  assert.deepEqual(wheel.state.frontier.next_legal, ['seat_dispatch', 'execute', 'reopen']);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.kind, 'execute');
  assert.equal(pd.superdoc.previous_attempt.branch, 'b_1');
  assert.match(pd.superdoc.previous_attempt.why, /^shelved under experience/);
  ok(wheel.runTurn({ type: 'egress' }));
  const all = auditTail(100000, wheel.paths);
  const audit = all.slice(auditBefore).map((l) => JSON.stringify(l));
  assert.ok(audit.some((l) => /"event":"shelved"/.test(l)), 'the shelving is audited');
  assert.ok(!audit.some((l) => /"guard":"drop_down_complete"/.test(l)), 'no drop_down_complete refusal');
  assert.equal(audit.filter((l) => /"reason":"seat dispatch staged review"/.test(l)).length, 0, 'no restage of the review');
  wheel.close();
});

test('A23: after a forced egress refusal the refusal is audited once (only a changed guard set is recorded again) and the watcher backs off 5 s, 30 s, then every 60 s until a new event on the project resets it', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel, transport } = newWheel();
  driveToExecution(wheel, outDir);
  transport.capacity = () => ({ ok: false, reason: 'one process per binary per project; busy' });
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const seqStaged = wheel.state.seq;
  const first = wheel.runTurn({ type: 'egress' });
  assert.equal(first.ok, false);
  assert.equal(first.guard, 'route_capacity');
  assert.equal(wheel.state.seq, seqStaged + 1, 'the first refusal is one recorded event');
  assert.equal(wheel.state.pending_dispatch, null, 'back to Staging');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const second = wheel.runTurn({ type: 'egress' });
  assert.equal(second.ok, false);
  assert.equal(second.repeat, true, 'the same guard set again is answered, not recorded');
  assert.equal(wheel.state.seq, seqStaged + 2, 'no second refusal event: only the restage');
  assert.ok(wheel.state.pending_dispatch, 'the restaged dispatch stays staged for the next attempt');
  const audit = auditTail(400, wheel.paths).map((l) => JSON.stringify(l));
  assert.equal(audit.filter((l) => /"phase":"EGRESS_GUARD".*"guard":"route_capacity"/.test(l)).length, 1, 'the refusal is audited once');
  assert.equal(eventsOf(wheel).filter((e) => e.type === 'egress_refused').length, 1);
  transport.capacity = () => ({ ok: true });
  ok(wheel.runTurn({ type: 'egress' }));
  assert.ok(wheel.state.pending_seat, 'the same sealed document left once the guard set changed');
  wheel.close();

  assert.deepEqual(REFUSAL_BACKOFF_MS, [5000, 30000, 60000]);
  const t0 = 1_000_000;
  const a = refusalBackoff(null, 10, t0);
  assert.deepEqual([a.attempt, a.wait, a.due], [1, 5000, t0 + 5000]);
  assert.equal(backoffHolds(a, 10, t0 + 4999), true);
  assert.equal(backoffHolds(a, 10, t0 + 5000), false);
  const b = refusalBackoff(a, 10, t0 + 5000);
  assert.deepEqual([b.attempt, b.wait], [2, 30000]);
  const c = refusalBackoff(b, 10, t0 + 35000);
  assert.deepEqual([c.attempt, c.wait], [3, 60000]);
  const d = refusalBackoff(c, 10, t0 + 95000);
  assert.deepEqual([d.attempt, d.wait], [4, 60000], 'every 60 s after the third');
  assert.equal(backoffHolds(d, 11, t0 + 95001), false, 'a new event on the project resets the hold');
  assert.deepEqual([refusalBackoff(d, 11, t0 + 95001).attempt, refusalBackoff(d, 11, t0 + 95001).wait], [1, 5000]);
});
