'use strict';
require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const gates = require('../lib/gates');
const { createStubTransport } = require('../lib/transport');
const { assertScoped, BrokerError } = require('../lib/broker');
const { scratchRoot, repoRoot } = require('../lib/paths');

test('gate engine: the catalog is the law; fixed actions only; model cannot invent or bypass', () => {
  assert.deepEqual(Object.keys(gates.GATES), [
    'VALIDATE', 'DESIGN_READY', 'PLAN_READY', 'TEST_READY', 'BUDGET_GATE',
    'ROUTE_ATTENTION', 'HUMAN_ESCALATION', 'RECOVERY_REQUIRED', 'REPAIR_REQUIRED',
  ]);
  const def = gates.gateDef('DESIGN_READY');
  assert.equal(def.kind, 'design');
  assert.deepEqual(def.actions, ['APPROVE', 'REPLY_ASK', 'SUMMARY', 'REJECT']);
  assert.equal(def.question, 'The Design is ready. Approve, reply/ask, summary, or reject?');
  assert.deepEqual(def.transitions, ['Spec', 'same gate', 'same gate', 'fail-up to target (default design) under REJECTED_OPTIMIZE_V1']);
  assert.deepEqual(def.params, { REJECT: { target: { enum: ['idea', 'experience', 'design'], default: 'design' } } });
  assert.deepEqual(gates.gateDef('PLAN_READY').transitions, ['same gate', 'execution unlocked', 'execution unlocked']);
  assert.throws(() => gates.gateDef('APPROACH_READY'), gates.GateError);
  assert.throws(() => gates.gateDef('SOLUTION_UNSATISFIED'), gates.GateError);
  assert.throws(() => gates.gateDef('IDEA_CONFIRM'), gates.GateError);
  assert.throws(() => gates.gateDef('NODE_GATE', { kind: 'spec' }), gates.GateError);
  assert.throws(() => gates.assertLegal('DESIGN_READY', 'SHIP_IT'), gates.GateError);
  assert.throws(() => gates.assertLegal('made_up_gate', 'APPROVE'), gates.GateError);
  assert.throws(() => gates.gateDef('approach_review'), gates.GateError);
  assert.equal(gates.assertLegal('BUDGET_GATE', 'EXTEND'), true);
  assert.deepEqual(gates.gateDef('RECOVERY_REQUIRED').actions, ['RETRY', 'RESUME', 'DISCARD_LATE', 'STOP']);
  const route = gates.gateDef('ROUTE_ATTENTION', { outcome: 'timeout', route: 'api:anthropic' });
  assert.equal(route.question,
    'This exact route is not ready (timeout: api:anthropic). Complete the shown route action, choose another allowed route, or pause the project.');
  const esc = gates.gateDef('HUMAN_ESCALATION', { cause: 'malformed' });
  assert.match(esc.question, /\(malformed\)\./, 'no target: {target} prints nothing');
  const named = gates.gateDef('HUMAN_ESCALATION', { cause: 'review gap named spec', target: 'spec' });
  assert.match(named.question, /\(review gap named spec; target: spec\)\./);
  assert.match(named.note, /^Opens with \{cause\}; with \{target\} when a seat named a human-authored node\. NODE_STANDS: the named node is unchanged, byte for byte/);
  assert.deepEqual(named.actions, ['CHOOSE_DIRECTION', 'RETRY', 'EDIT_NODE', 'NODE_STANDS', 'STOP']);
  assert.match(named.question, /let the node stand and return the finding to the seat, or stop\.$/);
  const spec = gates.gateDef('VALIDATE', { kind: 'spec' });
  assert.equal(spec.kind, 'spec');
  assert.deepEqual(spec.actions, ['ACCEPT', 'REJECT_RESTAGE']);
  assert.deepEqual(spec.transitions, ['next stage', 'Reopen of this node']);
  assert.equal(spec.question, 'Confirm the requirements, constraints, and release target. Accept, or reject and restage, when ready.');
  assert.equal(gates.gateDef('VALIDATE', { kind: 'experience' }).question, 'Describe the intended behavior and experience, or answer the guided questions. Accept, or reject and restage, when ready.');
  assert.equal(gates.gateDef('VALIDATE', { kind: 'idea' }).question, null, 'the law prints no idea text; the UI says only what the catalog says');
  assert.equal(spec.note, 'A fresh turn, deterministic, not a dispatch, never the staging turn.');
  assert.deepEqual(gates.GATES.VALIDATE.applies_to, ['idea', 'experience', 'spec', 'executions']);
  assert.throws(() => gates.assertLegal('VALIDATE', 'REJECT'), gates.GateError);
});

test('reject prepends the exact bytes of REJECTED_OPTIMIZE_V1', () => {
  assert.equal(gates.rejectBody(), 'rejected, optimize');
  assert.equal(Buffer.from(gates.rejectBody('tighten the plan')).subarray(0, 18).toString(), 'rejected, optimize');
  assert.match(gates.rejectBody('tighten the plan'), /^rejected, optimize - tighten/);
});

test('convobus cards are genuine ConvoBus cards with out->back lifecycle in the private transport store', () => {
  const t = createStubTransport();
  const { card } = t.send({
    route: 'claude:cli', cfg: {}, binding: { project_id: 'p_test' },
    envelope: { type: 'dispatch', seat: 'leader', kind: 'plan_trial', superdoc: { binding: {} }, result_schema: 'TRIAL_KIT', timeout_ms: 1000 },
  });
  assert.match(card.id, /^card_[0-9a-f]{12}$/);
  assert.equal(card.state, 'out');
  assert.equal(card.seat, 'claude-cli');
  assert.equal(card.method, 'stdio');
  const back = t.settleById(card.id, { outcome: 'result', result: {} });
  assert.equal(back.card.state, 'back');
  assert.equal(back.card.id, card.id);
  const mine = t.listCards().find((c) => c.id === card.id);
  assert.equal(mine.state, 'back');
  assert.match(mine.reply, /"outcome":"result"/);
  assert.equal(path.basename(t.dir()), '.convobus', 'cards live in the private transport store, not the canonical store');
});

test('tool broker scopes writes and blocks escapes', () => {
  const ok = assertScoped('system', 'fs_write', path.join(scratchRoot, 'x', 'y.js'), scratchRoot);
  assert.equal(ok.seat, 'system');
  assert.throws(
    () => assertScoped('system', 'fs_write', path.join(repoRoot, 'evil.js'), scratchRoot),
    BrokerError
  );
  assert.throws(() => assertScoped('builder', 'canonical', '/x', '/x'), BrokerError);
  assert.throws(
    () => assertScoped('system', 'exec', scratchRoot + '-sibling', scratchRoot),
    BrokerError
  );
});
