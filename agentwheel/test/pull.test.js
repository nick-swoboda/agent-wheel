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
const { DESIGN_PROPOSAL, NODE_SCHEMAS, validate } = require('../lib/schema');
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

function driveToPlanDraft(wheel, outDir) {
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
}

function dispatch(wheel) {
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  ok(wheel.runTurn({ type: 'egress' }));
  return wheel.state.pending_seat.card_id;
}

function eventsOf(wheel) {
  return fs.readFileSync(wheel.paths.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('A25: the cap - a Plan-stage Super Document carries the five kinds and every leaf as stubs, expands exactly the current node and the leaves to try, and carries Idea, Experience, Design, and Spec as stubs plus the claims those leaves cite; the hash inputs say so', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const doc = wheel.state.pending_dispatch.superdoc;
  assert.deepEqual(Object.keys(doc.wiki_temp_snapshot), ['idea', 'experience', 'design', 'spec', 'plan']);
  const allLeaves = collectLeaves(wheel.state.nodes.plan.draft).map((l) => l.id);
  assert.deepEqual(doc.wiki_temp_snapshot.plan.leaf_stubs.map((l) => l.id), allLeaves, 'every leaf as a stub');
  assert.deepEqual(Object.keys(doc.wiki_temp_snapshot.plan.leaf_stubs[0]).sort(), ['claim_refs', 'id', 'kind', 'state', 'title']);
  const ctx = doc.expanded_context;
  assert.ok(ctx.plan.draft && ctx.plan.draft.decomposes_into, 'the drafted Plan is the current node');
  for (const kind of ['idea', 'experience', 'design', 'spec']) {
    assert.equal(ctx[kind].accepted, undefined, kind + ' is not expanded in full');
    assert.equal(ctx[kind].stub, 'accepted v1');
    assert.ok(Array.isArray(ctx[kind].cited_claims));
  }
  const cited = new Set(allLeaves.flatMap((id) => collectLeaves(wheel.state.nodes.plan.draft).find((l) => l.id === id).claim_refs));
  const shown = new Set(['idea', 'experience', 'design', 'spec'].flatMap((k) => ctx[k].cited_claims.map((c) => c.id)));
  assert.deepEqual([...shown].sort(), [...cited].sort());
  assert.equal(ctx.experience.cited_claims.find((c) => c.id === 'A1').text, cargo.experience().acceptance[0].criterion);
  assert.ok(!JSON.stringify(ctx.experience).includes(cargo.experience().journeys[0].steps[0]), 'a journey line is not a claim: it is not in the slice');
  assert.match(doc.hash, /^[0-9a-f]{64}$/);
  const inputs = JSON.parse(JSON.stringify({ ...doc, hash: undefined }));
  assert.equal(inputs.expanded_context.experience.stub, 'accepted v1');
  assert.ok(doc.system_prompt.includes('"stub":"accepted v1"'));
  ok(wheel.runTurn({ type: 'egress' }));
  const cardId = wheel.state.pending_seat.card_id;
  ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft)) }));
  const rc = dispatch(wheel);
  ok(wheel.runTurn({ type: 'seat_result', card_id: rc, outcome: 'result', result: { decision: 'accept', references: ['plan v1'], notes: 'fresh' } }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const exec = wheel.state.pending_dispatch.superdoc;
  const view = exec.expanded_context.plan_leaves;
  assert.deepEqual(view.expanded.map((l) => l.id), wheel.state.pending_dispatch.leaves, 'the next group');
  assert.ok(view.stubs.length > 0);
  assert.equal(exec.expanded_context.plan.accepted.root, undefined, 'the accepted Plan body carries no second copy of the tree');
  assert.equal(exec.expanded_context.plan.accepted.v, 1);
  assert.equal(exec.expanded_context.experience.stub, 'accepted v1');
  wheel.close();
});

test('A25: the pull - a result with requested_expansions naming one kind and one leaf triggers exactly one redispatch, counted and audited with those ids, with both expanded in the slice; a second pull, an id not in the map, or "all" is refused and audited, and the result is read on its content', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir);
  const cardId = dispatch(wheel);
  const dispatchId = wheel.state.pending_seat.dispatch_id;
  const attempt0 = wheel.state.dispatches[dispatchId].attempt;
  const usedBefore = wheel.state.budget.used;
  const versionsBefore = wheel.state.nodes.plan.versions.length;
  const pulling = { leaves: {}, requested_expansions: ['experience', 'L1.1.A1'] };
  wheel.state.route_health[wheel.state.pending_seat.route] = {
    degraded: true, failures: 2, last_outcome: 'timeout', last_failure: '2026-09-01T00:00:00.000Z', last_ok: null,
  };
  const pullingRoute = wheel.state.pending_seat.route;
  const r = ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: pulling }));
  assert.deepEqual(r.result.pull_requested, ['experience', 'L1.1.A1']);
  assert.equal(wheel.state.route_health[pullingRoute].degraded, false, 'a pull is an answer; the mark clears');
  assert.equal(wheel.state.route_health[pullingRoute].failures, 0);
  assert.ok(wheel.state.route_health[pullingRoute].last_ok, 'and when it answered is recorded');
  assert.equal(wheel.state.nodes.plan.versions.length, versionsBefore, 'not staged');
  assert.equal(wheel.state.pending_validation, null, 'not reviewed');
  assert.ok(wheel.state.nodes.plan.draft, 'the draft stands, untried');
  const events = eventsOf(wheel);
  const pr = events.filter((e) => e.type === 'pull_requested');
  assert.equal(pr.length, 1);
  assert.deepEqual(pr[0].input.ids, ['experience', 'L1.1.A1']);
  assert.equal(pr[0].turn, pr[0].turn, 'the turn id is kept');
  assert.deepEqual(wheel.state.pending_pull.ids, ['experience', 'L1.1.A1']);
  assert.ok(wheel.state.frontier.next_legal.includes('seat_dispatch') && !wheel.state.frontier.next_legal.includes('plan_trial'), 'the same seat is looked at again');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.dispatch_id, dispatchId);
  assert.equal(pd.attempt, attempt0 + 1, 'a new attempt id');
  assert.equal(pd.seat, 'leader');
  assert.deepEqual(pd.pull, ['experience', 'L1.1.A1']);
  const ctx = pd.superdoc.expanded_context;
  assert.deepEqual(ctx.experience.accepted, cargo.experience(), 'the pulled kind is in the slice in full');
  assert.equal(ctx.design.stub, 'accepted v1', 'an unnamed stub stays a stub');
  assert.deepEqual(ctx.pull, ['experience', 'L1.1.A1']);
  assert.ok(pd.superdoc.system_prompt.includes('YOUR PREVIOUS RESULT ASKED TO SEE: experience, L1.1.A1.'), 'the pulling result rides as the previous attempt');
  ok(wheel.runTurn({ type: 'egress' }));
  assert.equal(wheel.state.budget.used, usedBefore + 1, 'a pull is a dispatch: counted');
  assert.equal(wheel.state.pending_pull, null);
  const audit = auditTail(100000, wheel.paths).map((l) => JSON.stringify(l));
  assert.ok(audit.some((l) => /"event":"pull_requested".*"ids":\["experience","L1.1.A1"\]/.test(l)), 'audited with the ids');
  assert.ok(audit.some((l) => /"event":"card_out".*"pull":\["experience","L1.1.A1"\]/.test(l)), 'the redispatch is audited with the ids');
  assert.notEqual(wheel.state.pending_seat.card_id, cardId, 'a new sealed card');
  const card2 = wheel.state.pending_seat.card_id;
  const kit = cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft));
  const r2 = ok(wheel.runTurn({ type: 'seat_result', card_id: card2, outcome: 'result', result: { ...kit, requested_expansions: ['design'] } }));
  assert.ok(r2.result.staged, 'read on its content: the kit was tried and staged');
  const refused = eventsOf(wheel).filter((e) => e.type === 'pull_refused');
  assert.equal(refused.length, 1);
  assert.deepEqual(refused[0].input.entries, ['design']);
  assert.match(refused[0].input.reason, /one pull per turn/);
  assert.equal(wheel.state.nodes.plan.versions.length, versionsBefore + 1, 'staged once the pull was refused');
  assert.equal(wheel.state.nodes.plan.versions.at(-1).content.requested_expansions, undefined, 'no node body carries a pull');
  assert.deepEqual(wheel.state.dispatches[dispatchId].pull_refused.map((x) => x.entries), [['design']]);
  wheel.close();

  resetStore();
  const { wheel: w2 } = newWheel();
  driveToPlanDraft(w2, fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-')));
  const c = dispatch(w2);
  const kit2 = cargo.trialKit(collectLeaves(w2.state.nodes.plan.draft));
  const bad = ['all', 'the repo', 'lib/*.js', 'L9.9', 'experience'];
  const r3 = ok(w2.runTurn({ type: 'seat_result', card_id: c, outcome: 'result', result: { ...kit2, requested_expansions: bad } }));
  assert.ok(r3.result.staged, 'read on its content');
  const ref2 = eventsOf(w2).filter((e) => e.type === 'pull_refused');
  assert.equal(ref2.length, 1);
  assert.deepEqual(ref2[0].input.entries, ['all', 'the repo', 'lib/*.js', 'L9.9'], 'the offending entries; the one good id does not rescue the pull');
  assert.equal(eventsOf(w2).filter((e) => e.type === 'pull_requested').length, 0);
  assert.equal(w2.state.pending_pull, null);
  w2.close();
});

test('A25: the Design proposal\'s result schema is the Design form plus requested_expansions; the Form Service strips it before the node body is validated, so no node body ever carries a pull; the pull redispatches the Leader with the named kinds in the slice', () => {
  assert.deepEqual(Object.keys(DESIGN_PROPOSAL.properties).sort(), [...Object.keys(NODE_SCHEMAS.design.properties), 'requested_expansions'].sort());
  assert.equal(validate(NODE_SCHEMAS.design, { ...cargo.design(), requested_expansions: ['idea'] }).ok, false, 'a node body never carries a pull');
  assert.equal(validate(DESIGN_PROPOSAL, { ...cargo.design(), requested_expansions: ['idea'] }).ok, true);
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'seat_dispatch', kind: 'design' }));
  const first = wheel.state.pending_dispatch.superdoc;
  assert.equal(first.binding.result_schema.properties.requested_expansions.maxItems, 8);
  assert.equal(first.expanded_context.idea.stub, 'accepted v1');
  assert.equal(first.expanded_context.experience.stub, 'accepted v1');
  ok(wheel.runTurn({ type: 'egress' }));
  const cardId = wheel.state.pending_seat.card_id;
  ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: { ...cargo.design(), requested_expansions: ['idea', 'experience'] } }));
  assert.equal(wheel.state.nodes.design.versions.length, 0, 'not staged');
  assert.equal(wheel.state.gate, null, 'not gated');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const second = wheel.state.pending_dispatch.superdoc;
  assert.deepEqual(second.expanded_context.idea.accepted, { problem: cargo.ideaText().problem, solution: cargo.ideaText().solution });
  assert.deepEqual(second.expanded_context.experience.accepted, cargo.experience());
  ok(wheel.runTurn({ type: 'egress' }));
  const card2 = wheel.state.pending_seat.card_id;
  ok(wheel.runTurn({ type: 'seat_result', card_id: card2, outcome: 'result', result: cargo.design() }));
  assert.equal(wheel.state.gate.id, 'DESIGN_READY');
  assert.equal(wheel.state.nodes.design.versions[0].content.requested_expansions, undefined);
  wheel.close();
});
