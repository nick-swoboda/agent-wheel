'use strict';
require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const { failUp, dropDown, previewDropDown, reachedBy, SPINE } = require('../lib/traversal');
const { emptyNode } = require('../lib/store');
const planlib = require('../lib/plan');
const cargo = require('./tiny-cargo');

function doneState() {
  const state = {
    status: 'purple',
    nodes: Object.fromEntries(SPINE.map((k) => [k, emptyNode(k)])),
    branches: {},
    leaves: {},
    executions: {},
    waivers: [],
    pending_validation: null,
    pending_redispatch: null,
    closure: { state: 'accepted' },
    closure_proof: { all_ok: true },
    plan_review: { v: 1 },
    project_done: { turn: 't_9' },
    plan_dirty: null,
    last_claim_change: null,
  };
  const content = { idea: cargo.ideaText(), experience: cargo.experience(), design: cargo.design(), spec: cargo.spec('/tmp/out') };
  delete content.idea.name;
  let v = 0;
  for (const kind of ['idea', 'experience', 'design', 'spec']) {
    state.nodes[kind].versions.push({ v: 1, content: content[kind], state: 'accepted', authored_by: 'human', staged_by_turn: 't_' + ++v, accepted_by_turn: 't_' + ++v });
  }
  const root = planlib.generateStructure(content.idea, content.experience, content.design, content.spec);
  planlib.walk(root, (n) => { n.trial = { status: 'passed', evidence: [], not_applicable: {} }; });
  const plan = { root, trial_stages: planlib.topologicalStages(root), decision: { leaf: 'L1.4', chosen: 'ALT1', rationale: 'r', basis: 'compared_two' }, summary: planlib.summarize(root) };
  state.nodes.plan.versions.push({ v: 1, content: plan, state: 'accepted', authored_by: 'system', staged_by_turn: 't_20', accepted_by_turn: 't_21' });
  for (const leaf of planlib.collectLeaves(root)) state.leaves[leaf.id] = { state: 'done', execution: { branch: 'b_1', turn: 't_30' } };
  state.executions.b_1 = { branch: 'b_1', leaves: planlib.collectLeaves(root).map((l) => l.id), state: 'accepted' };
  return state;
}

function states(state) {
  const plan = state.nodes.plan.versions[0].content;
  return Object.fromEntries(planlib.collectLeaves(plan.root).map((l) => [l.id, planlib.leafState(l, state.leaves)]));
}

test('drop-down walks by claim: a changed Experience criterion sends back exactly the leaves whose claim_refs name it (and what needs them); every other leaf stays done; purple is gone', () => {
  const state = doneState();
  const before = state.nodes.experience.versions[0].content;
  const after = structuredClone(before);
  after.acceptance[0].criterion = 'the page body contains the word hello, in bold';
  const walk = dropDown(state, 'experience', before, after);
  assert.deepEqual([walk.changed, walk.removed, walk.added], [['A1'], [], []]);
  assert.deepEqual(walk.leaves, ['L1.1.A1']);
  const s = states(state);
  assert.equal(s['L1.1.A1'], 'untried');
  for (const id of Object.keys(s).filter((x) => x !== 'L1.1.A1')) assert.equal(s[id], 'done', id + ' stays done');
  assert.deepEqual(state.leaves['L1.1.A1'].moved_by, { kind: 'experience', claims: ['A1'] });
  assert.deepEqual(state.leaves['L1.1.A1'].last_execution, { branch: 'b_1', turn: 't_30' }, 'its execution went with it');
  assert.equal(state.executions.b_1.state, 'accepted', 'the accepted execution of the other leaves stands');
  assert.deepEqual(state.plan_dirty.leaves, ['L1.1.A1']);
  assert.equal(state.closure, null);
  assert.equal(state.project_done, null, 'purple is removed the moment any leaf leaves done');
  assert.equal(state.plan_review, null);
  assert.equal(state.closure_proof, null);
  assert.equal(state.nodes.design.versions[0].state, 'accepted', 'nothing below is staled by position');
  assert.equal(state.nodes.spec.versions[0].state, 'accepted');
  assert.equal(state.nodes.plan.versions[0].state, 'accepted');
  assert.equal(state.nodes.design.stale, false);
});

test('drop-down: a version whose claims did not change stales nothing; a removed claim and everything that needs its leaves go back; a waiver on a moved claim is stale', () => {
  const same = doneState();
  const before = same.nodes.experience.versions[0].content;
  const identical = structuredClone(before);
  identical.usability.push('a sentence that is not a claim');
  const walk = dropDown(same, 'experience', before, identical);
  assert.deepEqual(walk.leaves, []);
  assert.equal(same.plan_dirty, null);
  assert.equal(same.project_done.turn, 't_9', 'purple stands');
  assert.ok(Object.values(states(same)).every((s) => s === 'done'));

  const removed = doneState();
  removed.waivers.push({ id: 'w1', claim: 'release', target: { kind: 'plan', v: 1 }, stale: false });
  const spec = removed.nodes.spec.versions[0].content;
  const next = structuredClone(spec);
  next.release.link_kind = 'https_url';
  const w = dropDown(removed, 'spec', spec, next);
  assert.deepEqual(w.changed, ['release']);
  assert.deepEqual(w.leaves, ['L1.5.1', 'L1.5.2'], 'the release leaves, and L1.5.2 which needs L1.5.1');
  assert.equal(removed.waivers[0].stale, true, 'the WaiverRecord on the moved claim went with it');
  assert.equal(states(removed)['L1.1.A1'], 'done');

  const gone = doneState();
  const exp = gone.nodes.experience.versions[0].content;
  const fewer = structuredClone(exp);
  fewer.acceptance = [{ id: 'A2', criterion: 'a different criterion under a new id' }];
  const g = dropDown(gone, 'experience', exp, fewer);
  assert.deepEqual([g.removed, g.added], [['A1'], ['A2']]);
  assert.deepEqual(g.leaves, ['L1.1.A1']);
  assert.deepEqual(gone.plan_dirty.added, ['A2'], 'a new claim generates a new untried leaf when the Plan is regenerated');
});

test('drop-down: a change to the Idea\'s solution reaches every leaf by claim - the root serves it and everything decomposes from the root', () => {
  const state = doneState();
  const idea = state.nodes.idea.versions[0].content;
  const next = { ...idea, solution: 'A single local html file that shows the word hello and the date the moment it opens.' };
  const walk = dropDown(state, 'idea', idea, next);
  assert.deepEqual(walk.changed, ['solution']);
  const all = Object.keys(states(state));
  assert.deepEqual(walk.leaves.sort(), all.slice().sort(), 'every leaf went back');
  assert.ok(Object.values(states(state)).every((s) => s === 'untried'));
  assert.equal(state.project_done, null);
  const reached = reachedBy(state.nodes.plan.versions[0].content.root, new Set(['A1']));
  assert.deepEqual([...reached], ['L1.1.A1'], 'reachedBy is the walk: claim -> node -> descendants and dependents');
});

test('fail-up: reopens the responsible ancestor, kills its staged version, drops the waiting redispatch and the plan draft; nothing below is staled by position', () => {
  const state = doneState();
  state.nodes.spec.versions.push({ v: 2, content: {}, state: 'staged', staged_by_turn: 't_9', authored_by: 'human' });
  state.pending_validation = { kind: 'spec', v: 2, staged_by_turn: 't_9' };
  state.pending_redispatch = { dispatch_id: 'd1' };
  state.nodes.plan.draft = { id: 'L1', decomposes_into: [] };
  const res = failUp(state, 'spec', 'review rejected');
  assert.deepEqual(res, { reopened: 'spec', dropped: [] });
  assert.equal(state.nodes.spec.reopened, true);
  assert.equal(state.nodes.spec.versions[1].state, 'rejected');
  assert.equal(state.nodes.spec.versions[0].state, 'accepted', 'the accepted version stands until its successor');
  assert.equal(state.pending_validation, null);
  assert.equal(state.pending_redispatch, null, 'a sealed document waiting out its backoff never leaves');
  assert.equal(state.nodes.plan.draft, null, 'an untried draft derived from the old version is discarded');
  assert.equal(state.nodes.plan.versions[0].state, 'accepted', 'not staled by position');
  assert.ok(Object.values(states(state)).every((s) => s === 'done'), 'done stays done until the successor version says otherwise');
  assert.equal(state.last_failure.kind, 'spec');
});

test('drop-down preview: previewDropDown is the walk dropDown performs, computed without touching the state - Reopen previews every leaf that will go back, then confirms', () => {
  const state = doneState();
  const idea = state.nodes.idea.versions[0].content;
  const next = {
    problem: 'A different person hurts in a different moment, and there is still no note that opens on its own.',
    solution: 'A single local html file that shows the word hello and the date the moment it opens.',
  };
  const snapshot = JSON.stringify(state);
  const preview = previewDropDown(state, 'idea', idea, next);
  assert.deepEqual(preview.changed, ['problem', 'solution']);
  assert.equal(preview.regenerates, true);
  assert.deepEqual(preview.leaves.slice().sort(), Object.keys(states(state)).sort(), 'every leaf will go back');
  assert.equal(JSON.stringify(state), snapshot, 'the preview touched nothing');
  assert.equal(state.project_done.turn, 't_9', 'purple stands until the human confirms');
  const walk = dropDown(state, 'idea', idea, next);
  assert.deepEqual(walk.leaves, preview.leaves, 'accept walks exactly what the preview showed');
  assert.equal(state.project_done, null);

  const same = doneState();
  const exp = same.nodes.experience.versions[0].content;
  const identical = structuredClone(exp);
  identical.usability.push('a sentence that is not a claim');
  const none = previewDropDown(same, 'experience', exp, identical);
  assert.deepEqual([none.regenerates, none.leaves, none.changed], [false, [], []], 'a version whose claims did not change previews nothing going back');
});
