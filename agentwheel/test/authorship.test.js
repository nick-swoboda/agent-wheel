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
const { AUTHORS } = require('../lib/reducers');
const cargo = require('./tiny-cargo');

function ok(r) {
  assert.equal(r.ok, true, r.error || 'turn failed');
  return r;
}

const SOLO = ['claude:cli'];
const ACCEPT = { type: 'validate', action: 'ACCEPT' };

function newWheel() {
  const transport = createStubTransport();
  return { wheel: new Wheel({ transport }), transport };
}

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
}

function driveToDesign(wheel) {
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn(ACCEPT));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn(ACCEPT));
}

function acceptDesign(wheel) {
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
}

function driveToPlanDraft(wheel, dir) {
  driveToDesign(wheel);
  acceptDesign(wheel);
  ok(cargo.submitSpec(wheel, dir, '25', SOLO));
  ok(wheel.runTurn(ACCEPT));
  ok(wheel.runTurn({ type: 'plan_generate' }));
}

function dispatch(wheel, input) {
  ok(wheel.runTurn({ type: 'seat_dispatch', ...(input || {}) }));
  ok(wheel.runTurn({ type: 'egress' }));
  return wheel.state.pending_seat.card_id;
}

function seatPlan(wheel) {
  const cardId = dispatch(wheel);
  const kit = cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft));
  return ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: kit }));
}

function review(wheel, result) {
  const cardId = dispatch(wheel);
  assert.equal(wheel.state.pending_seat.kind, 'review');
  return ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result }));
}

function gappingKit(wheel, prefixes) {
  const leaves = collectLeaves(wheel.state.nodes.plan.draft);
  const kit = cargo.trialKit(leaves);
  for (const leaf of leaves) {
    if (prefixes.some((p) => leaf.title.startsWith(p))) {
      kit.leaves[leaf.id] = { bases: cargo.basesNone('the kit believes this needs no run') };
    }
  }
  return kit;
}

function versionsOf(wheel, kind) {
  return wheel.state.nodes[kind].versions;
}

test('A14: authored_by is a field on every version - human for idea, experience, spec and human forms; system for plan; seat for seat results - and the store refuses a version without it', () => {
  resetStore();
  assert.deepEqual(AUTHORS, ['human', 'seat', 'system']);
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir());
  assert.equal(versionsOf(wheel, 'idea')[0].authored_by, 'human');
  assert.equal(versionsOf(wheel, 'experience')[0].authored_by, 'human');
  assert.equal(versionsOf(wheel, 'design')[0].authored_by, 'human');
  assert.equal(versionsOf(wheel, 'spec')[0].authored_by, 'human');
  seatPlan(wheel);
  assert.equal(versionsOf(wheel, 'plan')[0].authored_by, 'system', 'the plan is system-built from the seat\'s kit');
  assert.equal(wheel.state.pending_validation.def, null, 'plan is not a VALIDATE kind: the review seat and PLAN_READY are its acceptance');
  review(wheel, { decision: 'accept', references: ['L1'], notes: 'closed' });
  assert.equal(versionsOf(wheel, 'plan')[0].state, 'accepted');
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  for (const kind of ['idea', 'experience', 'design', 'spec', 'plan']) {
    assert.ok(versionsOf(wheel, kind).every((v) => AUTHORS.includes(v.authored_by)), kind + ' versions all carry authored_by');
  }
  wheel.close();

  resetStore();
  const second = newWheel().wheel;
  driveToDesign(second);
  const leaderCard = dispatch(second, { kind: 'design' });
  assert.equal(second.state.pending_seat.kind, 'design');
  ok(second.runTurn({ type: 'seat_result', card_id: leaderCard, outcome: 'result', result: cargo.design() }));
  assert.equal(versionsOf(second, 'design')[0].authored_by, 'seat');
  assert.equal(second.state.gate.id, 'DESIGN_READY');
  ok(second.runTurn({ type: 'gate', action: 'REJECT', reply: 'tighter' }));
  ok(second.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  assert.equal(versionsOf(second, 'design')[1].authored_by, 'human');
  assert.ok(versionsOf(second, 'design').every((v) => AUTHORS.includes(v.authored_by)));
  second.close();
});

test('A14: a Reviewer naming a human-authored node opens HUMAN_ESCALATION carrying the target and reopens nothing; naming a system-built node fails up there; the field decides, not the kind', () => {
  resetStore();
  let { wheel, transport } = newWheel();
  driveToPlanDraft(wheel, outDir());
  seatPlan(wheel);
  const r = review(wheel, { decision: 'gap', references: ['R1'], notes: 'R1 asks for a page the spec never sizes', earliest_repair: 'spec' });
  assert.equal(r.result.escalated, 'HUMAN_ESCALATION');
  assert.equal(r.result.target, 'spec');
  assert.equal(r.result.reopened, null);
  assert.equal(wheel.state.gate.id, 'HUMAN_ESCALATION');
  assert.equal(wheel.state.gate.target, 'spec');
  assert.match(wheel.state.gate.def.question, /\(review gap named spec: R1 asks for a page the spec never sizes; target: spec\)\./);
  assert.equal(wheel.state.nodes.spec.reopened, false, 'nothing reopened');
  assert.equal(versionsOf(wheel, 'spec')[0].state, 'accepted');
  assert.equal(versionsOf(wheel, 'plan')[0].state, 'staged', 'the reviewed plan stays staged');
  assert.equal(wheel.state.pending_validation.kind, 'plan');
  assert.equal(wheel.state.reviews.at(-1).earliest_repair, 'spec');
  assert.equal(transport.listCards().filter((c) => c.state === 'out').length, 0, 'no model in the loop after the review');
  ok(wheel.runTurn({ type: 'gate', action: 'EDIT_NODE' }));
  assert.equal(wheel.state.gate, null);
  assert.equal(wheel.state.nodes.spec.reopened, true, 'the human answered: spec reopened');
  assert.equal(wheel.state.last_failure.kind, 'spec');
  wheel.close();

  resetStore();
  ({ wheel } = newWheel());
  driveToPlanDraft(wheel, outDir());
  seatPlan(wheel);
  const d = review(wheel, { decision: 'gap', references: ['S1'], notes: 'the screen cannot show what A1 asks', earliest_repair: 'design' });
  assert.equal(d.result.escalated, 'HUMAN_ESCALATION');
  assert.equal(wheel.state.gate.target, 'design');
  assert.equal(wheel.state.nodes.design.reopened, false);
  wheel.close();

  resetStore();
  ({ wheel } = newWheel());
  driveToPlanDraft(wheel, outDir());
  seatPlan(wheel);
  const up = review(wheel, { decision: 'conflict', references: ['L1.4'], notes: 'the chosen alternative contradicts the kit', earliest_repair: 'plan' });
  assert.equal(up.result.reopened, 'plan');
  assert.equal(wheel.state.gate, null);
  assert.equal(wheel.state.nodes.plan.reopened, true);
  assert.equal(versionsOf(wheel, 'plan')[0].state, 'rejected');
  wheel.close();

  resetStore();
  ({ wheel } = newWheel());
  driveToDesign(wheel);
  const leaderCard = dispatch(wheel, { kind: 'design' });
  ok(wheel.runTurn({ type: 'seat_result', card_id: leaderCard, outcome: 'result', result: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  assert.equal(versionsOf(wheel, 'design')[0].authored_by, 'seat');
  ok(cargo.submitSpec(wheel, outDir(), '25', SOLO));
  ok(wheel.runTurn(ACCEPT));
  ok(wheel.runTurn({ type: 'plan_generate' }));
  seatPlan(wheel);
  const seatDesign = review(wheel, { decision: 'gap', references: ['S1'], notes: 'the proposed screen cannot carry A1', earliest_repair: 'design' });
  assert.equal(seatDesign.result.reopened, 'design');
  assert.equal(wheel.state.gate, null);
  assert.equal(wheel.state.nodes.design.reopened, true, 'a seat-authored design fails up');
  assert.equal(wheel.state.nodes.spec.stale, false, 'nothing staled by position: the successor Design decides what moves');
  assert.equal(versionsOf(wheel, 'plan')[0].state, 'rejected', 'the reviewed plan died with the walk');
  wheel.close();

  resetStore();
  ({ wheel } = newWheel());
  driveToPlanDraft(wheel, outDir());
  seatPlan(wheel);
  wheel.state.nodes.plan.versions[0].authored_by = 'human';
  const field = review(wheel, { decision: 'gap', references: ['L1'], notes: 'incomplete', earliest_repair: 'plan' });
  assert.equal(field.result.escalated, 'HUMAN_ESCALATION');
  assert.equal(wheel.state.gate.target, 'plan');
  assert.equal(wheel.state.nodes.plan.reopened, false);
  wheel.close();
});

test('A14: the second identical gap - same claim author version, same claim id, two consecutive trials - reopens the author (experience, design, or spec) mechanically; the count resets with the author\'s version; the Idea is not a walk target', () => {
  resetStore();
  let { wheel, transport } = newWheel();
  driveToPlanDraft(wheel, outDir());
  ok(wheel.runTurn({ type: 'plan_trial', kit: gappingKit(wheel, ['A1:']) }));
  assert.equal(versionsOf(wheel, 'plan')[0].state, 'staged');
  assert.deepEqual(Object.keys(wheel.state.identical_gaps), ['experience:v1:A1'], 'keyed on the claim author version and claim id, never the leaf; the Idea\'s solution claim is not a walk target');
  assert.equal(wheel.state.identical_gaps['experience:v1:A1'].count, 1);
  const first = ok(wheel.runTurn(ACCEPT));
  assert.equal(first.result.reopened, 'plan', 'first move: a trial-time gap suspects the kit');
  assert.equal(wheel.state.nodes.experience.reopened, false);
  ok(wheel.runTurn({ type: 'plan_generate' }));
  const second = ok(wheel.runTurn({ type: 'plan_trial', kit: gappingKit(wheel, ['A1:']) }));
  assert.deepEqual(second.result.identical_gap.author, { kind: 'experience', v: 1 });
  assert.equal(second.result.identical_gap.claim, 'A1');
  assert.equal(second.result.identical_gap.count, 2);
  assert.equal(second.result.reopened, 'experience');
  assert.equal(wheel.state.nodes.experience.reopened, true, 'the claim author reopened');
  assert.equal(wheel.state.nodes.idea.reopened, false, 'the Idea is not reached');
  assert.equal(wheel.state.pending_validation, null);
  assert.ok(versionsOf(wheel, 'plan').every((v) => v.state !== 'staged'), 'the gapped plan died with the walk');
  assert.equal(transport.listCards().length, 0, 'no model in that loop');
  assert.match(wheel.state.last_failure.reason, /identical gap: claim A1 of experience v1 gapped on trials 1 and 2/);
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn(ACCEPT));
  assert.equal(versionsOf(wheel, 'experience')[1].authored_by, 'human');
  assert.equal(versionsOf(wheel, 'design')[0].state, 'accepted');
  assert.equal(versionsOf(wheel, 'spec')[0].state, 'accepted');
  ok(wheel.runTurn({ type: 'plan_generate' }));
  const third = ok(wheel.runTurn({ type: 'plan_trial', kit: gappingKit(wheel, ['A1:']) }));
  assert.equal(third.result.identical_gap, undefined);
  assert.equal(wheel.state.nodes.experience.reopened, false);
  assert.deepEqual(Object.keys(wheel.state.identical_gaps), ['experience:v2:A1']);
  assert.equal(wheel.state.identical_gaps['experience:v2:A1'].count, 1);
  ok(wheel.runTurn(ACCEPT));
  ok(wheel.runTurn({ type: 'plan_generate' }));
  ok(wheel.runTurn({ type: 'plan_trial', kit: cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft)) }));
  assert.deepEqual(wheel.state.identical_gaps, {});
  wheel.close();

  resetStore();
  ({ wheel } = newWheel());
  driveToPlanDraft(wheel, outDir());
  ok(wheel.runTurn({ type: 'plan_trial', kit: gappingKit(wheel, ['R1:']) }));
  assert.deepEqual(Object.keys(wheel.state.identical_gaps), ['spec:v1:R1']);
  ok(wheel.runTurn(ACCEPT));
  ok(wheel.runTurn({ type: 'plan_generate' }));
  const spec = ok(wheel.runTurn({ type: 'plan_trial', kit: gappingKit(wheel, ['R1:']) }));
  assert.deepEqual(spec.result.identical_gap.author, { kind: 'spec', v: 1 });
  assert.equal(spec.result.reopened, 'spec');
  assert.equal(wheel.state.nodes.spec.reopened, true);
  assert.equal(wheel.state.nodes.experience.reopened, false);
  wheel.close();

  resetStore();
  ({ wheel } = newWheel());
  driveToPlanDraft(wheel, outDir());
  ok(wheel.runTurn({ type: 'plan_trial', kit: gappingKit(wheel, ['D1:']) }));
  assert.deepEqual(Object.keys(wheel.state.identical_gaps), ['design:v1:D1']);
  ok(wheel.runTurn(ACCEPT));
  ok(wheel.runTurn({ type: 'plan_generate' }));
  const design = ok(wheel.runTurn({ type: 'plan_trial', kit: gappingKit(wheel, ['D1:']) }));
  assert.deepEqual(design.result.identical_gap.author, { kind: 'design', v: 1 });
  assert.equal(design.result.reopened, 'design');
  assert.equal(wheel.state.nodes.design.reopened, true);
  assert.equal(wheel.state.nodes.spec.versions[0].state, 'accepted', 'nothing staled by position');
  wheel.close();
});
