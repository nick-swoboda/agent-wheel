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
const gates = require('../lib/gates');
const cargo = require('./tiny-cargo');

function ok(r) {
  assert.equal(r.ok, true, r.error || 'turn failed');
  return r;
}

const SOLO = ['claude:cli'];

function newWheel() {
  const transport = createStubTransport();
  return { wheel: new Wheel({ transport }), transport };
}

function driveToPlanDraft(wheel, outDir, routes) {
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(cargo.submitSpec(wheel, outDir, '25', routes || SOLO));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
}

function dispatch(wheel) {
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  ok(wheel.runTurn({ type: 'egress' }));
  return wheel.state.pending_seat.card_id;
}

function authorPlan(wheel, extraInput) {
  const cardId = dispatch(wheel);
  const kit = cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft));
  return ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: kit, ...(extraInput || {}) }));
}

test('A4: solo mode - the staging turn cannot accept its own result; a rung-2 review (same route, fresh context) accepts, and the record names the rung', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel, transport } = newWheel();
  driveToPlanDraft(wheel, outDir, SOLO);
  assert.equal(wheel.state.routes.solo, true, 'one human, one configured route');

  const staged = authorPlan(wheel, { review: { decision: 'accept', by: 'author' } });
  const stagingTurn = staged.turn;
  const pv = wheel.state.pending_validation;
  assert.equal(pv.kind, 'plan');
  assert.equal(pv.author.seat, 'leader');
  assert.equal(pv.author.route, 'claude:cli');
  assert.equal(pv.staged_by_turn, stagingTurn);
  assert.equal(wheel.state.nodes.plan.versions[0].state, 'staged', 'not accepted by its author');
  assert.ok(auditTail(30, wheel.paths).some((a) => a.event === 'self_acceptance_refused'), 'the refusal is audited');
  assert.ok(wheel.state.frontier.next_legal.includes('seat_dispatch'), 'an independent review is the only way forward');
  assert.ok(!wheel.state.frontier.next_legal.includes('validate'));
  const forced = wheel.runTurn({ type: 'validate', action: 'ACCEPT' });
  assert.equal(forced.ok, false);
  assert.match(forced.error, /illegal input/);

  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.kind, 'review');
  assert.equal(pd.seat, 'reviewer');
  assert.equal(pd.route, 'claude:cli');
  assert.equal(pd.route, pv.author.route, 'same route');
  assert.deepEqual(pd.review, { subject: { kind: 'plan', v: 1 }, rung: 2, author_route: 'claude:cli', route: 'claude:cli', context: 'fresh' });
  assert.equal(pd.superdoc.prefix, gates.prefixText('REVIEW_ONLY_V1'));
  assert.equal(pd.superdoc.binding.seat, 'reviewer');
  assert.deepEqual(pd.superdoc.binding.permissions, {}, 'the reviewer modifies nothing');
  assert.equal(pd.superdoc.review_subject.kind, 'plan');
  assert.equal(pd.superdoc.review_subject.author_seat, 'leader');
  assert.ok(Array.isArray(pd.superdoc.review_subject.evidence));
  const docText = JSON.stringify(pd.superdoc);
  assert.ok(!docText.includes(gates.prefixText('PLAN_TRIAL_READ_ONLY_V1')), 'the author\'s prefix is not supplied');
  assert.ok(!('schema_errors' in pd.superdoc.binding));
  assert.equal(pd.superdoc.review_subject.content.decision.chosen, 'ALT1', 'the presented result is what is reviewed');
  assert.match(pd.superdoc.system_prompt, /judged as a kit/, 'a trial is reviewed as a kit, not as an artifact');
  const served = new Set(collectLeaves(wheel.state.nodes.plan.versions[0].content.root).flatMap((l) => l.claim_refs || []));
  for (const kind of ['idea', 'experience', 'design', 'spec']) {
    const cited = pd.superdoc.expanded_context[kind].cited_claims;
    assert.ok(cited.length && cited.every((c) => served.has(c.id) && c.text), kind + ' cites the claims the Plan serves');
  }
  assert.equal(pd.result_schema, 'REVIEW_RESULT');
  ok(wheel.runTurn({ type: 'egress' }));
  const reviewCard = wheel.state.pending_seat.card_id;
  assert.notEqual(reviewCard, pv.author.card_id, 'a fresh card, a fresh context');

  const r = ok(wheel.runTurn({
    type: 'seat_result', card_id: reviewCard, outcome: 'result',
    result: { decision: 'accept', references: ['plan v1', 'L1.1.A1'], notes: 'every leaf settled; ALT1 feasible' },
  }));
  assert.equal(r.result.rung, 2);
  const ver = wheel.state.nodes.plan.versions[0];
  assert.equal(ver.state, 'accepted');
  assert.equal(ver.accepted_by, 'reviewer');
  assert.notEqual(ver.accepted_by_turn, ver.staged_by_turn);
  assert.equal(wheel.state.pending_validation, null);
  const record = wheel.state.reviews.at(-1);
  assert.equal(record.decision, 'accept');
  assert.deepEqual(record.subject, { kind: 'plan', v: 1 });
  assert.equal(record.author.turn, stagingTurn);
  assert.equal(record.author.seat, 'leader');
  assert.equal(record.reviewer.rung, 2, 'the review record names the rung');
  assert.equal(record.reviewer.route, record.author.route);
  assert.equal(record.reviewer.context, 'fresh');
  assert.equal(record.reviewer.author_reasoning_supplied, false);
  assert.equal(record.reviewer.card_id, reviewCard);
  assert.deepEqual(record.references, ['plan v1', 'L1.1.A1']);
  assert.equal(transport.listCards().length, 2, 'author dispatch + review dispatch');
  wheel.close();
});

test('rung 1: with two configured routes the review goes to a different route than the author', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir, ['claude:cli', 'chatgpt:codex']);
  assert.equal(wheel.state.routes.solo, false);
  authorPlan(wheel);
  assert.equal(wheel.state.pending_validation.author.route, 'claude:cli');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.kind, 'review');
  assert.equal(pd.route, 'chatgpt:codex');
  assert.equal(pd.review.rung, 1);
  ok(wheel.runTurn({ type: 'egress' }));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result',
    result: { decision: 'accept', references: ['plan v1'], notes: 'ok' } }));
  const record = wheel.state.reviews.at(-1);
  assert.equal(record.reviewer.rung, 1);
  assert.notEqual(record.reviewer.route, record.author.route);
  wheel.close();
});

test('A19: switching the Reviewer\'s route emits an audited event, drops nothing down, and the next review record shows rung 1 when the route differs from the author\'s', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir, ['claude:cli', 'chatgpt:codex']);
  assert.deepEqual(wheel.state.seats, { leader: { route: 'claude:cli', cfg: {} }, builder: { route: 'claude:cli', cfg: {} }, reviewer: { route: 'chatgpt:codex', cfg: {} } }, 'the project controls choose a different route for the Reviewer');
  const seq = wheel.state.seq;
  const same = ok(wheel.runTurn({ type: 'seat_assignment', seat: 'reviewer', route: 'claude:cli' }));
  assert.deepEqual(same.result, { seat: 'reviewer', route: 'claude:cli', from: 'chatgpt:codex', outside_allowlist: false, dropped: [] });
  assert.equal(wheel.state.seq, seq + 1, 'an event of its own');
  assert.ok(wheel.state.nodes.plan.draft, 'the plan draft stands');
  assert.equal(wheel.state.frontier.stale.length, 0, 'nothing stale: never a drop-down');
  const { events } = require('../lib/store').readEvents(wheel.paths);
  assert.deepEqual(events.at(-1).input, { type: 'seat_assignment', seat: 'reviewer', route: 'claude:cli' });
  assert.ok(auditTail(10, wheel.paths).some((a) => a.event === 'commit' && /seat assignment reviewer: chatgpt:codex -> claude:cli/.test(a.reason)), 'audited');
  authorPlan(wheel);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  assert.equal(wheel.state.pending_dispatch.route, 'claude:cli');
  assert.equal(wheel.state.pending_dispatch.review.rung, 2, 'same route as the author: rung 2, recorded');
  ok(wheel.runTurn({ type: 'egress' }));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result',
    result: { decision: 'gap', references: ['L1.1.A1'], notes: 'thin', earliest_repair: 'plan' } }));
  assert.equal(wheel.state.reviews.at(-1).reviewer.rung, 2);
  ok(wheel.runTurn({ type: 'seat_assignment', seat: 'reviewer', route: 'chatgpt:codex' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
  authorPlan(wheel);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  assert.equal(wheel.state.pending_dispatch.route, 'chatgpt:codex');
  assert.equal(wheel.state.pending_dispatch.review.rung, 1);
  ok(wheel.runTurn({ type: 'egress' }));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result',
    result: { decision: 'accept', references: ['plan v2'], notes: 'ok' } }));
  const record = wheel.state.reviews.at(-1);
  assert.equal(record.reviewer.rung, 1);
  assert.equal(record.reviewer.route, 'chatgpt:codex');
  assert.equal(record.author.route, 'claude:cli');
  wheel.close();
});

test('gap: the review reopens the earliest responsible node and the restage carries EARLIEST_REPAIR_ONLY_V1', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir, SOLO);
  authorPlan(wheel);
  const cardId = dispatch(wheel);
  const r = ok(wheel.runTurn({
    type: 'seat_result', card_id: cardId, outcome: 'result',
    result: { decision: 'gap', references: ['L1.1.A1'], notes: 'leaf evidence does not reach the criterion', earliest_repair: 'plan' },
  }));
  assert.equal(r.result.review, 'gap');
  assert.equal(r.result.reopened, 'plan');
  assert.equal(wheel.state.nodes.plan.versions[0].state, 'rejected');
  assert.equal(wheel.state.nodes.plan.reopened, true);
  assert.equal(wheel.state.last_failure.kind, 'plan');
  assert.equal(wheel.state.reviews.at(-1).decision, 'gap');
  assert.equal(wheel.state.pending_validation, null);
  ok(wheel.runTurn({ type: 'plan_generate' }));
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const prefixes = wheel.state.pending_dispatch.superdoc.prefixes;
  assert.ok(prefixes.includes(gates.prefixText('EARLIEST_REPAIR_ONLY_V1')), 'earliest repair prefix injected');
  assert.ok(prefixes.includes(gates.prefixText('PLAN_TRIAL_READ_ONLY_V1')));
  const sys = wheel.state.pending_dispatch.superdoc.system_prompt;
  assert.match(sys, /LAST REVIEW \(gap; repair exactly this before anything else\):/);
  assert.ok(sys.includes('leaf evidence does not reach the criterion'), 'the review notes reach the seat');
  assert.ok(sys.includes('"references":["L1.1.A1"]'), 'and its references');
  wheel.close();
});

test('needs_human: HUMAN_ESCALATION opens with the review cause; CHOOSE_DIRECTION accepts as the human\'s fresh turn', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir, SOLO);
  authorPlan(wheel);
  const cardId = dispatch(wheel);
  ok(wheel.runTurn({
    type: 'seat_result', card_id: cardId, outcome: 'result',
    result: { decision: 'needs_human', references: ['plan v1'], notes: 'two alternatives look equally feasible' },
  }));
  assert.equal(wheel.state.gate.id, 'HUMAN_ESCALATION');
  assert.match(wheel.state.gate.def.question, /\(review needs_human: two alternatives look equally feasible\)/);
  assert.equal(wheel.state.status, 'yellow');
  assert.ok(wheel.state.pending_validation, 'the staged result waits for the human');
  const r = ok(wheel.runTurn({ type: 'gate', action: 'CHOOSE_DIRECTION', reply: 'ALT1 as tried' }));
  assert.deepEqual(r.result.accepted, { kind: 'plan', v: 1 });
  assert.equal(wheel.state.nodes.plan.versions[0].state, 'accepted');
  assert.equal(wheel.state.nodes.plan.versions[0].accepted_by, 'human');
  const record = wheel.state.reviews.at(-1);
  assert.equal(record.reviewer.seat, 'human');
  assert.equal(record.notes, 'ALT1 as tried');
  assert.equal(wheel.state.gate.id, 'PLAN_READY', 'an accepted plan with a passing closure proof opens PLAN_READY');
  wheel.close();
});

test('the deterministic validate seat records its review as a fresh turn and never accepts a seat-authored result', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir, SOLO);
  const kit = cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft));
  ok(wheel.runTurn({ type: 'plan_trial', kit }));
  assert.equal(wheel.state.pending_validation.author.seat, 'human');
  assert.deepEqual(wheel.state.frontier.next_legal, ['validate']);
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  const record = wheel.state.reviews.at(-1);
  assert.equal(record.reviewer.seat, 'validate');
  assert.equal(record.reviewer.deterministic, true);
  assert.equal(record.reviewer.context, 'fresh turn');
  assert.notEqual(record.turn, record.author.turn);
  assert.equal(record.decision, 'accept');
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  const cardId = dispatch(wheel);
  assert.equal(wheel.state.pending_seat.kind, 'execute');
  ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: cargo.executionSubmission(wheel.state.pending_seat.leaves) }));
  assert.equal(wheel.state.pending_validation.kind, 'execution');
  assert.equal(wheel.state.pending_validation.author.seat, 'builder');
  assert.ok(!wheel.state.frontier.next_legal.includes('validate'));
  const forced = wheel.runTurn({ type: 'validate', action: 'ACCEPT' });
  assert.equal(forced.ok, false);
  const reviewCard = dispatch(wheel);
  assert.equal(wheel.state.pending_dispatch, null);
  assert.equal(wheel.state.pending_seat.kind, 'review');
  const group = wheel.state.executions.b_1.leaves;
  const r = ok(wheel.runTurn({ type: 'seat_result', card_id: reviewCard, outcome: 'result',
    result: { decision: 'gap', references: ['b_1', 'L1.1.A1'], notes: 'the test suite does not check the criterion', earliest_repair: 'plan' } }));
  assert.deepEqual(r.result.reopened, group);
  assert.equal(wheel.state.executions.b_1.state, 'rejected');
  assert.equal(wheel.state.branches.b_1.state, 'stale');
  assert.equal(wheel.state.nodes.plan.reopened, false, 'the Plan stands; the leaves go back');
  for (const id of group) assert.equal(wheel.state.leaves[id].state, 'gap');
  assert.deepEqual(wheel.state.frontier.leaves, group, 'the same group is next again');
  wheel.close();
});

test('a review gap that names leaves is repaired by re-trying exactly those: the regenerated draft carries every other passed trial from the rejected version, the repair dispatch lists only the named leaves, a kit for them alone closes the plan; a review naming no leaf carries nothing', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir, SOLO);
  authorPlan(wheel);
  const all = collectLeaves(wheel.state.nodes.plan.versions[0].content.root).map((l) => l.id);
  ok(wheel.runTurn({
    type: 'seat_result', card_id: dispatch(wheel), outcome: 'result',
    result: { decision: 'gap', references: ['plan v1 L1.1.A1', 'experience accepted A1'], notes: 'A1 evidence does not reach the criterion', earliest_repair: 'plan' },
  }));
  assert.equal(wheel.state.nodes.plan.versions[0].state, 'rejected');
  assert.deepEqual(wheel.state.last_failure.leaves, ['L1.1.A1']);
  assert.equal(wheel.state.last_failure.from_version, 1);
  const gen = ok(wheel.runTurn({ type: 'plan_generate' }));
  assert.equal(gen.result.carried, all.length - 1, 'every other passed trial carried from the rejected version');
  assert.deepEqual(gen.result.to_try, ['L1.1.A1'], 'the named leaf is what the repair tries');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const sys = wheel.state.pending_dispatch.superdoc.system_prompt;
  const toTry = sys.slice(sys.indexOf('PLAN LEAVES TO TRY'), sys.indexOf('LEAVES THAT STILL STAND'));
  assert.ok(toTry.includes('- L1.1.A1 ['), 'listed to try');
  assert.ok(!toTry.includes('- L1.2.R1 ['), 'a carried leaf is not listed to try');
  assert.ok(sys.includes('LEAVES THAT STILL STAND'));
  assert.ok(sys.includes('LAST REVIEW (gap'), 'the Reviewer\'s finding rides along');
  ok(wheel.runTurn({ type: 'egress' }));
  const cardId = wheel.state.pending_seat.card_id;
  const draftLeaves = collectLeaves(wheel.state.nodes.plan.draft).filter((l) => l.id === 'L1.1.A1');
  const r = ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: cargo.trialKit(draftLeaves) }));
  assert.equal(r.result.staged.kind, 'plan');
  const v2 = wheel.state.nodes.plan.versions.find((v) => v.v === 2);
  assert.equal(v2.content.summary.passed, all.length);
  assert.equal(v2.content.summary.untried, 0);
  assert.equal(wheel.state.last_failure, null, 'staging the repair trial clears the recorded failure');

  ok(wheel.runTurn({
    type: 'seat_result', card_id: dispatch(wheel), outcome: 'result',
    result: { decision: 'conflict', references: ['plan v2'], notes: 'the kit as a whole contradicts the spec', earliest_repair: 'plan' },
  }));
  assert.deepEqual(wheel.state.last_failure.leaves, []);
  assert.equal(wheel.state.last_failure.from_version, null);
  const gen2 = ok(wheel.runTurn({ type: 'plan_generate' }));
  assert.equal(gen2.result.carried, 0);
  assert.equal(gen2.result.to_try.length, all.length);
  wheel.close();
});

test('a node reopened above a staged result (HUMAN_ESCALATION EDIT_NODE) is the frontier\'s move: its form is legal, the review dispatch is not, and the review resumes once the successor is accepted', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir, SOLO);
  authorPlan(wheel);
  assert.equal(wheel.state.pending_validation.kind, 'plan');
  ok(wheel.runTurn({
    type: 'seat_result', card_id: dispatch(wheel), outcome: 'result',
    result: { decision: 'conflict', references: ['experience accepted v1 edge_cases[0]', 'spec accepted v1 R1'], notes: 'the edge case contradicts R1', earliest_repair: 'experience' },
  }));
  assert.equal(wheel.state.gate.id, 'HUMAN_ESCALATION');
  assert.equal(wheel.state.gate.target, 'experience');
  assert.equal(wheel.state.pending_validation.kind, 'plan', 'the staged Plan still waits');
  const stagedV = wheel.state.pending_validation.v;
  ok(wheel.runTurn({ type: 'gate', action: 'EDIT_NODE' }));
  assert.equal(wheel.state.nodes.experience.reopened, true);
  assert.equal(wheel.state.pending_validation, null, 'nothing waits for validation');
  assert.equal(wheel.state.nodes.plan.versions.find((v) => v.v === stagedV).state, 'shelved');
  const events = fs.readFileSync(wheel.paths.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.type === 'shelved').length, 1, 'one shelved event');
  assert.ok(wheel.state.frontier.next_legal.includes('form:experience') && !wheel.state.frontier.next_legal.includes('seat_dispatch'), 'the reopened node\'s form, not the review dispatch');
  const refused = wheel.runTurn({ type: 'seat_dispatch' });
  assert.equal(refused.ok, false, 'nothing to stage while the reopened node is unsettled');
  const next = cargo.experience();
  next.edge_cases = ['a manuscript with no headings becomes one chapter'];
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: next }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(wheel.state.nodes.experience.versions.at(-1).state, 'accepted');
  assert.equal(wheel.state.nodes.experience.reopened, false);
  assert.equal(wheel.state.nodes.plan.versions.find((v) => v.v === stagedV).state, 'shelved', 'a shelved result is never staged again');
  assert.equal(wheel.state.pending_validation, null);
  assert.ok(wheel.state.frontier.next_legal.includes('plan_generate'), 'the Plan is looked at again');
  const gen = ok(wheel.runTurn({ type: 'plan_generate' }));
  assert.equal(gen.result.carried, collectLeaves(wheel.state.nodes.plan.draft).length, 'the shelved version\'s passed trials stand for the regenerated draft');
  assert.deepEqual(wheel.state.frontier.next_legal, ['plan_trial', 'reopen'], 'nothing left for a seat to try');
  ok(wheel.runTurn({ type: 'plan_trial', kit: { leaves: {} } }));
  assert.equal(wheel.state.pending_validation.engine_closed, true);
  wheel.close();
});

test('a regenerated Plan whose every leaf carried its trial is closed by the engine: the empty re-trial is accepted by the validate seat on a fresh turn, no human click and no review dispatch, and PLAN_READY follows', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir, SOLO);
  authorPlan(wheel);
  ok(wheel.runTurn({ type: 'seat_result', card_id: dispatch(wheel), outcome: 'result', result: { decision: 'accept', references: ['plan v1'], notes: 'fresh' } }));
  assert.equal(wheel.state.nodes.plan.versions[0].state, 'accepted');
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(wheel.runTurn({ type: 'reopen', kind: 'plan' }));
  assert.ok(wheel.state.frontier.next_legal.includes('plan_generate'));
  const gen = ok(wheel.runTurn({ type: 'plan_generate' }));
  assert.equal(gen.result.to_try.length, 0, 'nothing to try');
  assert.ok(wheel.state.frontier.next_legal.includes('plan_trial') && !wheel.state.frontier.next_legal.includes('seat_dispatch'), 'nothing for a seat to try');
  ok(wheel.runTurn({ type: 'plan_trial', kit: { leaves: {} } }));
  const pv = wheel.state.pending_validation;
  assert.equal(pv.kind, 'plan');
  assert.equal(pv.engine_closed, true);
  assert.deepEqual(wheel.state.frontier.next_legal, ['validate'], 'the validate seat, not a review dispatch');
  const r = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(r.result.accepted.kind, 'plan');
  assert.equal(wheel.state.nodes.plan.versions.at(-1).state, 'accepted');
  assert.equal(wheel.state.gate.id, 'PLAN_READY', 'the human gate still follows');
  wheel.close();
});
