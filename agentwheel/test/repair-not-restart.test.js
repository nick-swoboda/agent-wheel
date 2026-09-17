'use strict';
const { resetStore } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wheel } = require('../lib/wheel');
const { collectLeaves, leafState } = require('../lib/plan');
const { createStubTransport } = require('../lib/transport');
const outcomes = require('../lib/transport/outcomes');
const { validate, TRIAL_KIT } = require('../lib/schema');
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
}

function dispatch(wheel) {
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  ok(wheel.runTurn({ type: 'egress' }));
  return wheel.state.pending_seat.card_id;
}

function buildOverBus(wheel, extra) {
  const cardId = dispatch(wheel);
  assert.equal(wheel.state.pending_seat.kind, 'execute');
  const leaves = wheel.state.pending_seat.leaves;
  return ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: cargo.executionSubmission(leaves, extra) }));
}

function reviewOverBus(wheel, result) {
  const cardId = dispatch(wheel);
  assert.equal(wheel.state.pending_seat.kind, 'review');
  return ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result }));
}

function retryAndApprove(wheel) {
  ok(wheel.runTurn({ type: 'plan_generate' }));
  ok(wheel.runTurn({ type: 'plan_trial', kit: cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft).filter((l) => l.trial.status !== 'passed')) }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
}

function leafStates(wheel) {
  const plan = wheel.state.nodes.plan.versions.filter((v) => v.state === 'accepted').at(-1).content;
  return Object.fromEntries(collectLeaves(plan.root).map((l) => [l.id, leafState(l, wheel.state.leaves)]));
}

test('A24: after a Design change stales branch b_n over two leaves of a group while every other leaf is done, the next Builder Super Document names b_n as the previous attempt marked staled by design v<n>: <claim ids>, carries its files, and the done leaves stay done on main', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  buildOverBus(wheel);
  reviewOverBus(wheel, { decision: 'accept', references: ['b_1'], notes: 'fresh context' });
  const done = Object.entries(leafStates(wheel)).filter(([, s]) => s === 'done').map(([id]) => id);
  assert.ok(done.includes('L1.7') && done.includes('L1.8') && done.length >= 5, 'the group is done');
  assert.deepEqual(wheel.state.main.merged, ['b_1']);
  ok(wheel.runTurn({ type: 'reopen', kind: 'design' }));
  const d2 = cargo.design();
  d2.visual[0].rule = 'dark text on a plain light page, one line, no decoration, centered';
  d2.content[0].rule = 'the body text is exactly the word hello, centered';
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: d2 }));
  const approved = ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  assert.deepEqual(approved.result.dropped, ['L1.7', 'L1.8']);
  retryAndApprove(wheel);
  assert.deepEqual(wheel.state.frontier.leaves, ['L1.7', 'L1.8'], 'only the moved leaves execute');
  buildOverBus(wheel, { files: { 'index.html': '<!doctype html>\n<html><body>hello there</body></html>\n', 'test.js': cargo.TEST_JS } });
  assert.equal(wheel.state.executions.b_2.state, 'staged');
  assert.deepEqual(wheel.state.executions.b_2.leaves, ['L1.7', 'L1.8']);
  reviewOverBus(wheel, { decision: 'gap', references: ['b_2 index.html'], notes: 'the body says hello there, not exactly hello', earliest_repair: 'plan' });
  assert.equal(wheel.state.executions.b_2.state, 'rejected');
  ok(wheel.runTurn({ type: 'reopen', kind: 'design' }));
  const d3 = structuredClone(d2);
  d3.visual[0].rule = 'dark text on a plain light page, one line, no decoration, centered, in a serif face';
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: d3 }));
  const approved3 = ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  assert.deepEqual(approved3.result.dropped, ['L1.7']);
  assert.deepEqual(wheel.state.executions.b_2.staled_by, { kind: 'design', v: 3, claims: ['V1'] });
  const after = leafStates(wheel);
  for (const id of done.filter((x) => !['L1.7', 'L1.8'].includes(x))) assert.equal(after[id], 'done', id + ' stays done');
  retryAndApprove(wheel);
  assert.deepEqual(wheel.state.frontier.leaves, ['L1.7', 'L1.8']);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.kind, 'execute');
  assert.deepEqual(pd.leaves, ['L1.7', 'L1.8']);
  const prev = pd.superdoc.previous_attempt;
  assert.equal(prev.branch, 'b_2');
  assert.equal(prev.why, 'staled by design v3: V1');
  assert.ok(prev.files['index.html'].includes('hello there'), 'its files are offered as the starting point');
  const sp = String(pd.superdoc.system_prompt);
  assert.equal((sp.match(/PREVIOUS ATTEMPT[^\n]*/) || [''])[0], 'PREVIOUS ATTEMPT (branch b_2; staled by design v3: V1) PASSED ITS TESTS BUT WAS NOT MERGED; repair it, do not start over. Test output tail:', 'the block prints the mark');
  ok(wheel.runTurn({ type: 'egress' }));
  const cardId = wheel.state.pending_seat.card_id;
  ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: cargo.executionSubmission(['L1.7', 'L1.8']) }));
  assert.equal(wheel.state.executions.b_3.state, 'staged', 'the Builder repaired on a new branch cut from main');
  reviewOverBus(wheel, { decision: 'accept', references: ['b_3'], notes: 'fresh context' });
  assert.deepEqual(wheel.state.main.merged, ['b_1', 'b_3'], 'the done leaves were never re-executed');
  const finalStates = leafStates(wheel);
  for (const id of done) assert.equal(finalStates[id], 'done', id + ' is done: the group is whole again');
  wheel.close();
});

test('A24: a malformed reply keeps its raw bytes on the card, capped at 256 KiB with the cut recorded; the SCHEMA_REPAIR_ONLY_V1 dispatch is compiled from that payload; a second malformed still ends in INTERRUPTED + HUMAN_ESCALATION naming malformed', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(cargo.submitSpec(wheel, outDir, '25', ROUTES));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
  const cardId = dispatch(wheel);
  const dispatchId = wheel.state.pending_seat.dispatch_id;
  const big = '{"leaves": {"L1.1.A1": "' + 'x'.repeat(300 * 1024) + '\n';
  const kept = outcomes.keepRaw(big);
  assert.equal(kept.raw_cut.bytes, Buffer.byteLength(big));
  assert.equal(kept.raw_cut.kept, 256 * 1024);
  ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'malformed', detail: 'unparseable JSON: Unterminated string', raw: kept.raw, raw_cut: kept.raw_cut, normalizations: [] }));
  const rec = wheel.state.dispatches[dispatchId].outcomes.at(-1);
  assert.equal(rec.outcome, 'malformed');
  assert.equal(rec.raw.length, 256 * 1024, 'the card keeps the raw bytes, capped');
  assert.deepEqual(rec.raw_cut, { bytes: Buffer.byteLength(big), kept: 256 * 1024, cap: 256 * 1024 }, 'the cut is recorded');
  assert.equal(wheel.state.last_schema_reject.raw.length, 256 * 1024);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.dispatch_id, dispatchId, 'the same dispatch, its schema repair');
  assert.match(pd.superdoc.prefix, /^Return the stored result in the exact required schema/);
  assert.equal(pd.superdoc.binding.previous_reply.length, 256 * 1024);
  assert.ok(pd.superdoc.system_prompt.includes('YOUR PREVIOUS REPLY, AS RECEIVED (' + Buffer.byteLength(big) + ' bytes; the first 262144 kept, cut at 262144):'));
  assert.ok(pd.superdoc.system_prompt.includes('{"leaves": {"L1.1.A1": "xxxx'), 'the payload rides in the repair dispatch');
  ok(wheel.runTurn({ type: 'egress' }));
  const cardId2 = wheel.state.pending_seat.card_id;
  ok(wheel.runTurn({ type: 'seat_result', card_id: cardId2, outcome: 'result', result: { leaves: { 'L1.1.A1': { bases: 'not an object' } } } }));
  assert.equal(wheel.state.gate.id, 'HUMAN_ESCALATION', 'a second malformed on the same dispatch');
  assert.equal(wheel.state.interrupted.cause, 'malformed');
  assert.match(wheel.state.gate.def.question, /\(malformed\)\./);
  const rec2 = wheel.state.dispatches[dispatchId].outcomes.at(-1);
  assert.equal(rec2.outcome, 'malformed');
  assert.equal(rec2.raw, JSON.stringify({ leaves: { 'L1.1.A1': { bases: 'not an object' } } }), 'the parsed object is the kept payload');
  wheel.close();
});

test('A24: the classifier has exactly three normalizations, each recorded on the result - the first complete JSON object, trial-kit leaf folding, escape repair - and no fourth: an echoed dialect key is refused by the schema', () => {
  assert.deepEqual(outcomes.NORMALIZATIONS, ['first_object', 'fold', 'escapes']);
  const clean = outcomes.extractJson('{"a":1}');
  assert.deepEqual([clean.ok, clean.normalizations], [true, []]);
  const cropped = outcomes.extractJson('Here it is:\n{"a":1}\nDone.');
  assert.deepEqual([cropped.value, cropped.normalizations], [{ a: 1 }, ['first_object']]);
  const escaped = outcomes.extractJson('{"re":"\\d+"}');
  assert.deepEqual([escaped.value, escaped.repaired, escaped.normalizations], [{ re: '\\d+' }, 'escapes', ['escapes']]);
  const folded = outcomes.foldTrialKitLeaves('TRIAL_KIT', { leaves: { 'L1.1': { bases: {} } }, 'L1.2': { bases: {} } });
  assert.deepEqual(folded.folded, ['L1.2']);
  const echoed = outcomes.classifyParsed(outcomes.extractJson(JSON.stringify({ $schema: 'x', leaves: {} })), TRIAL_KIT, validate);
  assert.equal(echoed.outcome, 'malformed', 'no fourth normalization: the bound schema refuses the echoed key');
  assert.match(echoed.errors[0], /\$schema/);
  assert.equal(echoed.raw, JSON.stringify({ $schema: 'x', leaves: {} }), 'the payload the repair reads');
  const broken = outcomes.extractJson('{"a":');
  assert.equal(broken.ok, false);
  assert.equal(broken.raw, '{"a":', 'the raw bytes, not a 400-byte head');
  assert.equal(broken.raw_cut, null);
});
