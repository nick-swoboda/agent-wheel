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
const { planClosureProof } = require('../lib/proof');
const { claimsOf } = require('../lib/claims');
const forms = require('../lib/forms');
const { replay } = require('../lib/reducers');
const storelib = require('../lib/store');
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

function driveToDesign(wheel) {
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(wheel.state.frontier.stage, 'design');
}

function acceptDesign(wheel, design) {
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: design || cargo.design() }));
  assert.equal(wheel.state.gate.id, 'DESIGN_READY');
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
}

function driveToPlanDraft(wheel, spec, design) {
  driveToDesign(wheel);
  acceptDesign(wheel, design);
  cargo.configure(wheel, '25', SOLO);
  ok(wheel.runTurn({ type: 'form', kind: 'spec', content: spec }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
}

function tryAndAccept(wheel) {
  const kit = cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft));
  ok(wheel.runTurn({ type: 'plan_trial', kit }));
  return ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
}

function designWithOrphanClaim() {
  const design = cargo.design();
  design.states.push({ id: 'T2', screen: 'S9', state: 'lost', transition: 'a transition on a screen the Design never declares' });
  return design;
}

test('A9: the plan closure proof maps every Design, Spec, Experience, and Idea claim to a passed leaf through claim_refs; PLAN_READY follows; EXECUTION_UNLOCKED stays false until PLAN_READY is approved', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, cargo.spec(outDir));

  const dup = cargo.design();
  dup.visual.push({ id: 'V1', rule: 'MARKER-4b1e: a second rule under the same id' });
  let admitted = forms.admit(wheel.state, 'design', dup);
  assert.equal(admitted.ok, false);
  assert.equal(admitted.stage, 'invariant');
  assert.equal(admitted.errors[0], '$: duplicate claim ids: V1');
  admitted = forms.admit(wheel.state, 'design', { ...cargo.design(), extra: 1 });
  assert.equal(admitted.stage, 'schema', 'an unknown field is refused by the schema before the invariants run');
  assert.equal(forms.admit(wheel.state, 'design', cargo.design()).ok, true);

  const accepted = tryAndAccept(wheel);
  assert.deepEqual(accepted.result.closure_proof, { all_ok: true, claims: 14, steps: 5, responsible: null, first_failure: null });
  const cp = wheel.state.closure_proof;
  assert.equal(cp.kind, 'plan_closure');
  assert.equal(cp.all_ok, true);
  assert.deepEqual(cp.targets, { plan: 1, idea: 1, experience: 1, design: 1, spec: 1 });
  assert.deepEqual(cp.steps.map((s) => s.from + '->' + s.to), ['plan->spec', 'plan->design', 'plan->experience', 'plan->idea', 'plan->closure']);
  assert.ok(cp.steps.every((s) => s.ok));
  const design = wheel.state.nodes.design.versions[0].content;
  const designIds = claimsOf('design', design).map((c) => c.id);
  assert.deepEqual(designIds, ['S1', 'V1', 'T1', 'I1', 'N1', 'D1']);
  for (const id of [...designIds, 'A1', 'R1', 'C1', 'release', 'problem', 'solution', 'plan:closed', 'plan:ancestors_current']) {
    const c = cp.claims.find((x) => x.id === id);
    assert.ok(c, 'claim recorded: ' + id);
    assert.equal(c.status, 'pass');
    assert.equal(c.evidence[0].executor, 'engine');
    assert.equal(c.owner, 'engine');
    assert.equal(c.earliest_repair, null);
  }
  assert.deepEqual(cp.claims.find((c) => c.id === 'T1').plan_refs, ['L1.6.S1'], 'a state is served by its screen leaf');
  assert.deepEqual(cp.claims.find((c) => c.id === 'D1').plan_refs, ['L1.9.D1']);
  assert.deepEqual(cp.claims.find((c) => c.id === 'V1').source, { kind: 'design', v: 1 });
  assert.match(cp.claims.find((c) => c.id === 'plan:closed').evidence[0].detail, /10 leaves passed; decision ALT1/);

  assert.equal(wheel.state.gate.id, 'PLAN_READY');
  assert.equal(wheel.state.gate.def.question, 'Plan Trial is complete and the closure proof passed. Summarize, skip optional review, or approve?');
  assert.equal(wheel.state.frontier.stage, 'execution');
  assert.equal(wheel.state.execution.unlocked, false);
  assert.match(wheel.state.execution.reason, /PLAN_READY has not been approved for plan v1/);
  assert.deepEqual(wheel.state.frontier.next_legal, ['gate']);
  assert.deepEqual(Object.keys(wheel.state.executions), []);
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  assert.equal(wheel.state.execution.unlocked, true, 'execution unlocks after the proof passed and PLAN_READY was approved');
  assert.ok(wheel.state.frontier.next_legal.includes('execute'));
  assert.ok(wheel.state.frontier.next_legal.includes('seat_dispatch'));
  assert.deepEqual(wheel.state.frontier.leaves, ['L1.1.A1', 'L1.2.R1', 'L1.3.C1', 'L1.6.S1', 'L1.7', 'L1.8', 'L1.9.D1'], 'the first after[]-ordered group');
  assert.equal(JSON.stringify(planClosureProof(wheel.state).claims), JSON.stringify(cp.claims), 'the pure proof recomputes the same record');
  wheel.close();
});

test('A9: a Design claim with no passed leaf in claim_refs opens REPAIR_REQUIRED on design before any execution; WAIVE (reason required) records a WaiverRecord; the waiver is in the drop-down stale set; replay is byte-identical', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, cargo.spec(outDir), designWithOrphanClaim());
  const leaves = collectLeaves(wheel.state.nodes.plan.draft);
  assert.ok(!leaves.some((l) => l.claim_refs.includes('T2')), 'no leaf serves T2');

  const r = tryAndAccept(wheel);
  assert.equal(r.result.closure_proof.all_ok, false);
  assert.equal(r.result.closure_proof.responsible, 'design');
  assert.equal(r.result.closure_proof.first_failure.claim, 'T2');
  assert.equal(wheel.state.nodes.plan.versions[0].state, 'accepted', 'the trial itself was complete');
  const g = wheel.state.gate;
  assert.equal(g.id, 'REPAIR_REQUIRED');
  assert.equal(g.def.kind, 'design');
  assert.equal(g.def.question, gates.humanText('REPAIR_REQUIRED_V1'));
  assert.deepEqual(g.def.actions, ['REPAIR', 'REPLY', 'WAIVE', 'STOP']);
  assert.equal(g.claim, 'T2');
  assert.equal(g.responsible, 'design');
  assert.equal(g.detail, 'plan closure proof gap at T2: no passed leaf names T2 in claim_refs');
  assert.equal(wheel.state.closure_proof.all_ok, false);
  assert.equal(wheel.state.closure_proof.steps[1].ok, false, 'the plan->design step fails');
  assert.equal(wheel.state.status, 'yellow');
  assert.equal(wheel.state.execution.unlocked, false);
  assert.match(wheel.state.execution.reason, /plan closure proof has not passed/);
  assert.deepEqual(wheel.state.frontier.next_legal, ['gate'], 'nothing executes');
  assert.deepEqual(Object.keys(wheel.state.executions), []);

  ok(wheel.runTurn({ type: 'gate', action: 'REPLY', reply: 'which screen carries T2?' }));
  assert.equal(wheel.state.gate.id, 'REPAIR_REQUIRED');
  const noReason = wheel.runTurn({ type: 'gate', action: 'WAIVE' });
  assert.equal(noReason.ok, false);
  assert.match(noReason.error, /WAIVE requires a reason/);

  const waived = ok(wheel.runTurn({ type: 'gate', action: 'WAIVE', reply: 'T2 describes a transition the single screen already covers' }));
  assert.equal(wheel.state.waivers.length, 1);
  const w = wheel.state.waivers[0];
  assert.equal(w.id, waived.result.waiver);
  assert.equal(w.claim, 'T2');
  assert.equal(w.reason, 'T2 describes a transition the single screen already covers');
  assert.equal(w.authorizer, 'human');
  assert.deepEqual(w.target, { kind: 'plan', v: 1 });
  assert.equal(w.stale, false);
  assert.equal(wheel.state.gate.id, 'PLAN_READY', 'the proof passes with the waiver: PLAN_READY follows');
  const cp = wheel.state.closure_proof;
  assert.equal(cp.all_ok, true);
  assert.deepEqual(cp.waivers, [w.id]);
  const claim = cp.claims.find((c) => c.id === 'T2');
  assert.equal(claim.status, 'waiver');
  assert.deepEqual(claim.waiver, { id: w.id, reason: w.reason, authorizer: 'human', target: { kind: 'plan', v: 1 } });
  assert.match(cp.steps[1].detail, /some waived/);
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  assert.equal(wheel.state.execution.unlocked, true);
  assert.equal(wheel.state.status, 'green');

  assert.equal(JSON.stringify(planClosureProof(wheel.state).claims), JSON.stringify(cp.claims));
  const { events, torn } = storelib.readEvents(wheel.paths);
  assert.equal(torn, null);
  assert.equal(JSON.stringify(replay(events)), JSON.stringify(wheel.state));

  const reopened = ok(wheel.runTurn({ type: 'reopen', kind: 'spec' }));
  assert.deepEqual(reopened.result.dropped, []);
  assert.equal(wheel.state.execution.unlocked, false);
  assert.match(wheel.state.execution.reason, /spec is reopened/);
  assert.equal(wheel.state.waivers[0].stale, false, 'the waiver stands until its claim moves');
  const spec2 = cargo.spec(outDir);
  spec2.requirements[0].requirement = 'a single html page prints hello twice';
  ok(wheel.runTurn({ type: 'form', kind: 'spec', content: spec2 }));
  const moved = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.deepEqual(moved.result.dropped, ['L1.2.R1']);
  assert.equal(wheel.state.waivers[0].stale, false);
  assert.equal(wheel.state.closure_proof, null, 'the Plan must be looked at again');
  assert.equal(wheel.state.plan_review, null);
  assert.match(wheel.state.execution.reason, /plan closure proof has not passed/, 'the proof fell with the plan: it must pass again for the new trial');
  wheel.close();
});

test('REPAIR at REPAIR_REQUIRED fails up to the claim author with EARLIEST_REPAIR_ONLY_V1 on the restage; the repaired Design closes the proof', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, cargo.spec(outDir), designWithOrphanClaim());
  tryAndAccept(wheel);
  assert.equal(wheel.state.gate.id, 'REPAIR_REQUIRED');
  const r = ok(wheel.runTurn({ type: 'gate', action: 'REPAIR' }));
  assert.equal(r.result.repair, 'design');
  assert.equal(r.result.claim, 'T2');
  assert.equal(wheel.state.gate, null);
  assert.equal(wheel.state.nodes.design.reopened, true, 'the claim author reopened');
  assert.equal(wheel.state.nodes.design.versions[0].state, 'accepted', 'the accepted version stands until a successor is accepted');
  assert.equal(wheel.state.nodes.spec.versions[0].state, 'accepted', 'nothing below is staled by position');
  assert.equal(wheel.state.nodes.plan.versions[0].state, 'accepted');
  assert.equal(wheel.state.last_failure.kind, 'design');
  assert.match(wheel.state.last_failure.reason, /plan closure proof gap at T2/);
  assert.equal(wheel.state.frontier.stale[0], 'design');
  assert.ok(wheel.state.frontier.next_legal.includes('form:design'));
  assert.ok(wheel.state.frontier.next_legal.includes('seat_dispatch'));

  ok(wheel.runTurn({ type: 'seat_dispatch', kind: 'design' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.kind, 'design');
  assert.equal(pd.seat, 'leader');
  assert.ok(pd.superdoc.prefixes.includes(gates.prefixText('EARLIEST_REPAIR_ONLY_V1')));
  assert.equal(pd.superdoc.prefix, gates.prefixText('EARLIEST_REPAIR_ONLY_V1'));
  ok(wheel.runTurn({ type: 'egress' }));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result', result: cargo.design() }));
  assert.equal(wheel.state.gate.id, 'DESIGN_READY');
  assert.equal(wheel.state.nodes.design.versions[1].authored_by, 'seat');
  const approved = ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  assert.equal(wheel.state.nodes.design.versions[1].state, 'accepted');
  assert.equal(wheel.state.last_failure, null);
  assert.deepEqual(approved.result.claims, { changed: [], removed: ['T2'], added: [] }, 'the repair removed the orphan claim');
  assert.deepEqual(approved.result.dropped, [], 'no leaf served T2, so no leaf moves');

  assert.equal(wheel.state.frontier.stage, 'plan');
  const gen = ok(wheel.runTurn({ type: 'plan_generate' }));
  assert.equal(gen.result.carried, 10);
  assert.deepEqual(gen.result.to_try, []);
  assert.deepEqual(wheel.state.frontier.next_legal.filter((t) => t !== 'reopen'), ['plan_trial'], 'nothing for a seat to try');
  ok(wheel.runTurn({ type: 'plan_trial', kit: { leaves: {} } }));
  const second = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(second.result.closure_proof.all_ok, true);
  assert.deepEqual(wheel.state.closure_proof.waivers, []);
  assert.deepEqual(wheel.state.closure_proof.targets, { plan: 2, idea: 1, experience: 1, design: 2, spec: 1 });
  assert.equal(wheel.state.gate.id, 'PLAN_READY');
  wheel.close();
});

test('a seat-proposed Design meets the same Form Service as the human\'s: duplicate claim ids are refused before staging and repaired once', () => {
  resetStore();
  const { wheel } = newWheel();
  driveToDesign(wheel);
  ok(wheel.runTurn({ type: 'seat_dispatch', kind: 'design' }));
  assert.equal(wheel.state.pending_dispatch.kind, 'design');
  assert.equal(wheel.state.pending_dispatch.result_schema, 'DESIGN_PROPOSAL');
  assert.match(wheel.state.pending_dispatch.superdoc.system_prompt, /DESIGN INPUTS/);
  ok(wheel.runTurn({ type: 'egress' }));
  const wrong = cargo.design();
  wrong.acceptance.push({ id: 'D1', criterion: 'a second criterion under the same id' });
  let r = ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result', result: wrong }));
  assert.equal(r.result.schema_repair, true);
  assert.equal(wheel.state.nodes.design.versions.length, 0, 'nothing staged');
  assert.equal(wheel.state.gate, null);
  assert.equal(wheel.state.last_schema_reject.errors[0], '$: duplicate claim ids: D1');
  ok(wheel.runTurn({ type: 'seat_dispatch', kind: 'design' }));
  const repair = wheel.state.pending_dispatch;
  assert.equal(repair.superdoc.prefix, gates.prefixText('SCHEMA_REPAIR_ONLY_V1'));
  assert.match(repair.superdoc.binding.schema_errors[0], /duplicate claim ids/);
  ok(wheel.runTurn({ type: 'egress' }));
  r = ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result', result: cargo.design() }));
  assert.equal(wheel.state.gate.id, 'DESIGN_READY');
  assert.equal(wheel.state.gate.author.seat, 'leader');
  assert.equal(wheel.state.nodes.design.versions.length, 1);
  assert.equal(wheel.state.nodes.design.versions[0].authored_by, 'seat');
  wheel.close();
});
