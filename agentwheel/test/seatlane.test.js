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
const gates = require('../lib/gates');
const cargo = require('./tiny-cargo');

function ok(r) {
  assert.equal(r.ok, true, r.error || 'turn failed');
  return r;
}

function newWheel() {
  const transport = createStubTransport();
  return { wheel: new Wheel({ transport }), transport };
}

function cardOf(transport, wheel) {
  const id = wheel.state.pending_seat.card_id;
  const card = transport.listCards().find((c) => c.id === id);
  return { card, envelope: JSON.parse(card.body) };
}

function driveToPlanDraft(wheel, outDir) {
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(cargo.submitSpec(wheel, outDir, '25'));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
}

function driveToExecution(wheel, outDir) {
  driveToPlanDraft(wheel, outDir);
  ok(wheel.runTurn({ type: 'plan_trial', kit: cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft)) }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
}

function dispatch(wheel) {
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  ok(wheel.runTurn({ type: 'egress' }));
  return wheel.state.pending_seat.card_id;
}

function review(wheel, decision, extra) {
  const cardId = dispatch(wheel);
  assert.equal(wheel.state.pending_seat.kind, 'review');
  return ok(wheel.runTurn({
    type: 'seat_result', card_id: cardId, outcome: 'result',
    result: { decision: decision || 'accept', references: ['reviewed'], notes: 'reviewed in a fresh context', ...(extra || {}) },
  }));
}

test('bus circle: staged dispatch, guarded egress, genuine cards out, schema-bound results back, purple', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel, transport } = newWheel();
  driveToPlanDraft(wheel, outDir);

  assert.ok(wheel.state.frontier.next_legal.includes('seat_dispatch'));
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  assert.equal(wheel.state.pending_dispatch.seat, 'leader');
  assert.ok(wheel.state.frontier.next_legal.includes('egress'));
  assert.equal(transport.listCards().length, 0, 'no card before egress');
  ok(wheel.runTurn({ type: 'egress' }));
  assert.equal(wheel.state.pending_seat.seat, 'leader');
  assert.ok(wheel.state.frontier.next_legal.includes('seat_result'));
  let { card, envelope } = cardOf(transport, wheel);
  assert.equal(card.seat, 'claude-cli');
  assert.equal(card.method, 'stdio');
  assert.equal(card.state, 'out');
  assert.equal(envelope.kind, 'plan_trial');
  assert.equal(envelope.result_schema, 'TRIAL_KIT');
  const doc = envelope.superdoc;
  assert.equal(doc.prefix, gates.prefixText('PLAN_TRIAL_READ_ONLY_V1'));
  assert.equal(doc.binding.seat, 'leader');
  assert.ok(doc.binding.result_schema.properties.leaves, 'kit schema bound');
  assert.equal(doc.expanded_context.idea.stub, 'accepted v1', 'governing ancestors as stubs');
  assert.equal(doc.expanded_context.idea.accepted, undefined, 'never an ancestor in full');
  assert.equal(doc.expanded_context.design.stub, 'accepted v1', 'the Design governs the plan as its cited claims');
  assert.ok(doc.expanded_context.design.cited_claims.some((c) => c.id === 'D1'), 'the claims the leaves to try cite, with their text');
  assert.ok(doc.expanded_context.plan.draft, 'plan draft in context');
  assert.equal(doc.hash, wheel.state.cardbindings[card.id].context_hash);

  let r = wheel.runTurn({ type: 'seat_result', card_id: 'card_bogus', result: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not match pending/);

  const kit = cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft));
  r = ok(wheel.runTurn({ type: 'seat_result', card_id: card.id, outcome: 'result', result: kit }));
  assert.equal(wheel.state.pending_seat, null);
  assert.equal(wheel.state.pending_validation.kind, 'plan');
  const back = transport.listCards().find((c) => c.id === card.id);
  assert.equal(back.state, 'back');
  assert.match(back.reply, /"outcome":"result"/);
  assert.ok(wheel.state.frontier.next_legal.includes('seat_dispatch'));
  assert.ok(!wheel.state.frontier.next_legal.includes('validate'));
  review(wheel, 'accept');
  assert.equal(wheel.state.nodes.plan.versions[0].state, 'accepted');
  assert.equal(wheel.state.reviews.at(-1).reviewer.rung, 2, 'solo mode: rung 2');
  assert.equal(wheel.state.gate.id, 'PLAN_READY');
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));

  let executions = 0;
  while (wheel.state.frontier.stage === 'execution') {
    const group = wheel.state.frontier.leaves;
    const builderCard = dispatch(wheel);
    ({ card, envelope } = cardOf(transport, wheel));
    assert.equal(card.id, builderCard);
    assert.equal(envelope.kind, 'execute');
    assert.equal(envelope.result_schema, 'EXECUTION_SUBMISSION');
    assert.deepEqual(envelope.leaves, group, 'the card names exactly the dispatched leaves');
    assert.equal(envelope.superdoc.binding.seat, 'builder');
    assert.equal(envelope.superdoc.prefix, gates.prefixText('EXECUTE_LEAF_V1'));
    assert.deepEqual(envelope.superdoc.expanded_context.plan_leaves.expanded.map((l) => l.id), group, 'the Super Document carries the frontier leaves expanded');
    assert.ok(envelope.superdoc.expanded_context.plan_leaves.stubs.length > 0, 'and the rest as stubs');
    for (const id of group) assert.equal(wheel.state.leaves[id].executing, wheel.state.pending_seat.dispatch_id, 'the Builder holds its leaves');
    if (executions > 0) assert.ok(envelope.superdoc.main_files['index.html'], 'main as it stands rides with the Builder');
    r = ok(wheel.runTurn({ type: 'seat_result', card_id: builderCard, outcome: 'result', result: cargo.executionSubmission(group) }));
    assert.equal(r.result.tests.failed, 0);
    assert.equal(wheel.state.pending_validation.kind, 'execution');
    assert.equal(wheel.state.pending_validation.author.seat, 'builder');
    review(wheel, 'accept');
    executions++;
    for (const id of group) assert.equal(wheel.state.leaves[id].state, 'done');
  }
  assert.equal(executions, 2, 'the release leaves are executed by the final closure, not by a Builder group');
  assert.ok(fs.existsSync(path.join(outDir, 'index.html')));
  assert.equal(wheel.state.branches.b_1.state, 'merged');

  ok(wheel.runTurn({ type: 'finalize' }));
  const closureCard = dispatch(wheel);
  ({ card, envelope } = cardOf(transport, wheel));
  assert.equal(envelope.kind, 'review');
  assert.equal(envelope.superdoc.review_subject.kind, 'closure');
  assert.ok(envelope.superdoc.prefixes.includes(gates.prefixText('FINAL_CLOSURE_READ_ONLY_V1')));
  ok(wheel.runTurn({ type: 'seat_result', card_id: closureCard, outcome: 'result', result: { decision: 'accept', references: ['closure'], notes: 'all ok' } }));
  ok(wheel.runTurn({ type: 'project_done' }));
  assert.equal(wheel.state.status, 'purple');
  assert.ok(transport.listCards().every((c) => c.state === 'back'), 'every card went out and came back');
  assert.equal(Object.keys(wheel.state.cardbindings).length, 2 + 2 * executions + 1, 'the trial and its review, each execution and its review, the closure review');
  wheel.close();
});

test('malformed: the next staged dispatch carries SCHEMA_REPAIR_ONLY_V1 and the errors, once per attempt', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel, transport } = newWheel();
  driveToPlanDraft(wheel, outDir);
  const firstCard = dispatch(wheel);

  let r = ok(wheel.runTurn({ type: 'seat_result', card_id: firstCard, outcome: 'result', result: { unparseable: 'not a kit' } }));
  assert.equal(r.result.schema_repair, true);
  assert.equal(wheel.state.pending_seat, null);
  assert.equal(wheel.state.last_schema_reject.attempts, 1);
  assert.match(transport.listCards().find((c) => c.id === firstCard).reply, /"outcome":"malformed"/);

  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.attempt, 1);
  assert.equal(pd.superdoc.prefix, gates.prefixText('SCHEMA_REPAIR_ONLY_V1'));
  assert.ok(pd.superdoc.binding.schema_errors.length > 0);
  ok(wheel.runTurn({ type: 'egress' }));
  const secondCard = wheel.state.pending_seat.card_id;
  assert.notEqual(secondCard, firstCard, 'a fresh dispatch card was posted');

  const kit = cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft));
  r = ok(wheel.runTurn({ type: 'seat_result', card_id: secondCard, outcome: 'result', result: kit }));
  assert.equal(wheel.state.pending_validation.kind, 'plan');
  assert.equal(wheel.state.last_schema_reject, null);
  wheel.close();
});

test('a second malformed result on the same dispatch is INTERRUPTED + HUMAN_ESCALATION naming malformed; RETRY re-arms the seat', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir);
  for (let i = 0; i < 2; i++) {
    const cardId = dispatch(wheel);
    ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: { garbage: i } }));
  }
  assert.equal(wheel.state.gate.id, 'HUMAN_ESCALATION');
  assert.match(wheel.state.gate.def.question, /\(malformed\)/);
  assert.equal(wheel.state.wheel.phase, 'INTERRUPTED');
  assert.equal(wheel.state.status, 'red');
  assert.equal(wheel.state.pending_seat, null);
  ok(wheel.runTurn({ type: 'gate', action: 'RETRY' }));
  assert.ok(wheel.state.frontier.next_legal.includes('seat_dispatch'), 'fresh dispatch legal again');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  assert.equal(wheel.state.pending_dispatch.attempt, 0, 'attempts reset on a fresh dispatch');
  wheel.close();
});

test('an execution naming a main_file it did not send, or a leaf it was not dispatched, is malformed', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  let cardId = dispatch(wheel);
  assert.equal(wheel.state.pending_seat.kind, 'execute');
  const group = wheel.state.pending_seat.leaves;
  const bad = cargo.executionSubmission(group);
  bad.main_file = 'not-a-submitted-file.html';
  let r = ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: bad }));
  assert.equal(r.result.schema_repair, true);
  assert.match(wheel.state.last_schema_reject.errors[0], /main_file/);
  for (const id of group) assert.equal(wheel.state.leaves[id] && wheel.state.leaves[id].executing, undefined, 'the held leaves are released');
  cardId = dispatch(wheel);
  const overreach = cargo.executionSubmission([...group, 'L1.5.2']);
  r = ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: overreach }));
  assert.equal(wheel.state.gate.id, 'HUMAN_ESCALATION', 'the second malformed on the same dispatch escalates');
  assert.match(wheel.state.last_schema_reject.errors[0], /only the dispatched leaves may be claimed/);
  wheel.close();
});

test('a transport failure never enters schema validation and is not a schema attempt', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel, transport } = newWheel();
  driveToPlanDraft(wheel, outDir);
  const cardId = dispatch(wheel);
  const r = ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'timeout', detail: 'runner killed at 1200000ms' }));
  assert.equal(r.result.outcome, 'timeout');
  assert.equal(wheel.state.pending_seat, null);
  assert.equal(wheel.state.last_schema_reject, null, 'not a schema attempt');
  assert.equal(wheel.state.last_transport_failure.outcome, 'timeout');
  assert.equal(wheel.state.last_transport_failure.route, 'claude:cli');
  const dispatchRecord = Object.values(wheel.state.dispatches)[0];
  assert.deepEqual(dispatchRecord.outcomes.map((o) => o.outcome), ['timeout']);
  assert.match(transport.listCards().find((c) => c.id === cardId).reply, /"outcome":"timeout"/);
  assert.equal(wheel.state.pending_redispatch.dispatch_id, dispatchRecord.dispatch_id);
  assert.equal(dispatchRecord.superdoc.prefix, gates.prefixText('PLAN_TRIAL_READ_ONLY_V1'));
  assert.ok(wheel.state.frontier.next_legal.includes('redispatch'));
  wheel.close();
});

test('a back card built on base versions a reopen has staled is quarantined, never applied', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir);
  const kit = cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft));
  const cardId = dispatch(wheel);
  ok(wheel.runTurn({ type: 'reopen', kind: 'experience' }));
  const r = ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: kit }));
  assert.equal(r.result.discarded, true);
  assert.equal(wheel.state.quarantine.length, 1);
  assert.equal(wheel.state.quarantine[0].card_id, cardId);
  assert.equal(wheel.state.pending_validation, null, 'nothing was staged from the late card');
  wheel.close();
});
