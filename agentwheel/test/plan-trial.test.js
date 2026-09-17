'use strict';
const { resetStore } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const planlib = require('../lib/plan');
const { scratchRoot, repoRoot } = require('../lib/paths');
const cargo = require('./tiny-cargo');
const { validate, NODE_SCHEMAS, TRIAL_KIT } = require('../lib/schema');
const { Wheel } = require('../lib/wheel');
const gates = require('../lib/gates');

const idea = { problem: 'p'.repeat(30), solution: 's'.repeat(30) };
const scratch = (name) => path.join(scratchRoot, `test-${name}-${process.pid}`);

function ok(r) {
  assert.equal(r.ok, true, r.error || 'turn failed');
  return r;
}

test('trial scratch lives outside the repo', () => {
  assert.ok(!scratchRoot.startsWith(repoRoot + path.sep));
  assert.ok(scratchRoot.startsWith(os.tmpdir()));
});

test('generateStructure maps acceptance, requirements, constraints, design claims, a decision, and release into a DAG with kinds, dependencies, legal order, and upward proof; leaf ids are keyed by claim', () => {
  const root = planlib.generateStructure(idea, cargo.experience(), cargo.design(), cargo.spec('/tmp/out'));
  const leaves = planlib.collectLeaves(root);
  const byId = planlib.nodesById(root);
  const titles = leaves.map((l) => l.title);
  assert.ok(titles.some((t) => t.startsWith('A1:')));
  assert.ok(titles.some((t) => t.startsWith('R1:')));
  assert.ok(titles.some((t) => t.startsWith('C1:')));
  assert.equal(byId.get('L1').kind, 'expected_result');
  assert.equal(byId.get('L1.1.A1').kind, 'expected_result');
  assert.equal(byId.get('L1.2.R1').kind, 'action');
  assert.equal(byId.get('L1.3.C1').kind, 'assumption');
  assert.equal(byId.get('L1.4').kind, 'decision');
  assert.ok(leaves.every((l) => planlib.KINDS.includes(l.kind)));
  assert.deepEqual(byId.get('L1.4').after, ['L1.1', 'L1.2', 'L1.3', 'L1.6', 'L1.7', 'L1.8', 'L1.9']);
  assert.equal(byId.get('L1.6.S1').kind, 'expected_result');
  assert.deepEqual(byId.get('L1.6.S1').claim_refs, ['S1', 'T1', 'I1']);
  assert.deepEqual(byId.get('L1.7').claim_refs, ['V1']);
  assert.deepEqual(byId.get('L1.8').claim_refs, ['N1']);
  assert.deepEqual(byId.get('L1.9.D1').claim_refs, ['D1']);
  assert.deepEqual(leaves.map((l) => l.id), ['L1.1.A1', 'L1.2.R1', 'L1.3.C1', 'L1.6.S1', 'L1.7', 'L1.8', 'L1.9.D1', 'L1.4', 'L1.5.1', 'L1.5.2']);
  assert.deepEqual(byId.get('L1.5.1').needs, ['L1.4']);
  assert.deepEqual(byId.get('L1.5.2').needs, ['L1.5.1']);
  assert.deepEqual(byId.get('L1.1.A1').serves, ['L1.1']);
  assert.deepEqual(byId.get('L1.1.A1').claim_refs, ['A1', 'solution']);
  assert.deepEqual(byId.get('L1').claim_refs, ['problem', 'solution']);
  assert.ok(leaves.every((l) => !('before' in l)), 'the inverse of after is derived, never stored');
  assert.equal(planlib.assertDag(root), true);
  const stages = planlib.topologicalStages(root);
  assert.deepEqual(stages[0], ['L1.1.A1', 'L1.2.R1', 'L1.3.C1', 'L1.6.S1', 'L1.7', 'L1.8', 'L1.9.D1']);
  assert.deepEqual(stages[1], ['L1.4']);
  assert.deepEqual(stages[2], ['L1.5.1']);
  assert.deepEqual(stages[3], ['L1.5.2']);
  assert.equal(planlib.rollupOk(root), false);
  assert.equal(planlib.planClosed({ root, decision: null }).ok, false);
});

test('a cycle is refused: repetition is a typed loop node, not a graph cycle', () => {
  const root = planlib.generateStructure(idea, cargo.experience(), cargo.design(), cargo.spec('/tmp/out'));
  const byId = planlib.nodesById(root);
  byId.get('L1.1.A1').needs.push('L1.5.2');
  assert.throws(() => planlib.topologicalStages(root), /cycle/);
  const loop = planlib.generateStructure(idea, cargo.experience(), cargo.design(), cargo.spec('/tmp/out'));
  planlib.nodesById(loop).get('L1.2').decomposes_into.push({
    ...planlib.nodesById(loop).get('L1.2.R1'), id: 'L1.2.R2', title: 'retry the build until it is green', kind: 'loop',
    loop: { over: 'build attempts', until: 'exit 0', max_iterations: 3 },
  });
  assert.equal(planlib.assertDag(loop), true, 'a loop node is not a cycle');
});

test('the engine executes the kit in scratch: every basis recorded with its executor; evidence rolls up bottom-up', () => {
  const root = planlib.generateStructure(idea, cargo.experience(), cargo.design(), cargo.spec('/tmp/out'));
  const kit = cargo.trialKit(planlib.collectLeaves(root));
  assert.equal(validate(TRIAL_KIT, kit).ok, true, 'the kit meets its schema');
  const scratchDir = scratch('trial');
  const content = planlib.applyTrialKit(root, kit, { scratchDir });

  assert.equal(planlib.rollupOk(content.root), true);
  assert.equal(content.decision.leaf, 'L1.4');
  assert.equal(content.decision.chosen, 'ALT1');
  assert.equal(content.decision.basis, 'compared_two');
  assert.deepEqual(content.trial_stages, [['L1.1.A1', 'L1.2.R1', 'L1.3.C1', 'L1.6.S1', 'L1.7', 'L1.8', 'L1.9.D1'], ['L1.4'], ['L1.5.1'], ['L1.5.2']]);
  const leaves = planlib.collectLeaves(content.root);
  const a1 = leaves.find((l) => l.title.startsWith('A1:'));
  assert.equal(a1.trial.status, 'passed');
  assert.deepEqual(a1.trial.evidence.map((e) => [e.basis, e.executor, e.ok]), [['executable_test', 'engine', true]]);
  assert.match(a1.trial.evidence[0].detail, /exit=0/);
  assert.deepEqual(Object.keys(a1.trial.not_applicable).sort(), ['first_principles', 'inspection', 'math', 'physics', 'trusted_method']);
  assert.ok(Object.values(a1.trial.not_applicable).every((r) => r.length >= 5), 'a real reason for every non-applicable basis');
  const c1 = leaves.find((l) => l.title.startsWith('C1:'));
  assert.deepEqual(c1.trial.evidence.map((e) => [e.basis, e.executor]), [['first_principles', 'model']]);
  const decision = leaves.find((l) => l.kind === 'decision');
  assert.equal(decision.trial.alternatives.length, 2);
  assert.ok(decision.trial.alternatives.every((a) => a.feasible && a.evidence[0].executor === 'engine'));
  assert.equal(decision.trial.basis_of_decision, 'compared_two');
  assert.equal(decision.trial.chosen, 'ALT1');
  assert.equal(decision.trial.rationale, 'both build, but a single file honors the single_file_html release type directly');
  assert.deepEqual(Object.keys(require('../lib/schema').NODE_SCHEMAS), ['idea', 'experience', 'design', 'spec', 'plan']);
  assert.equal(content.summary.passed, 10);
  assert.equal(content.summary.untried, 0);
  assert.ok(fs.existsSync(scratchDir), 'executed evidence really ran in scratch');
  assert.equal(validate(NODE_SCHEMAS.plan, content).ok, true, 'the staged content is schema-valid canonical plan content');
  assert.equal(planlib.planClosed(content).ok, true);
});

test('A5: one untried leaf keeps its parent from passing', () => {
  const root = planlib.generateStructure(idea, cargo.experience(), cargo.design(), cargo.spec('/tmp/out'));
  const kit = cargo.trialKit(planlib.collectLeaves(root));
  delete kit.leaves['L1.2.R1'];
  const content = planlib.applyTrialKit(root, kit, { scratchDir: scratch('untried') });
  const byId = planlib.nodesById(content.root);
  assert.equal(byId.get('L1.2.R1').trial.status, 'untried');
  assert.equal(byId.get('L1.2').trial.status, 'untried', 'the parent cannot pass');
  assert.match(byId.get('L1.2').trial.reason, /untried, gap, conflict, or missing evidence/);
  assert.equal(byId.get('L1').trial.status, 'untried', 'nor the root');
  assert.equal(byId.get('L1.1').trial.status, 'passed', 'siblings with settled children still pass');
  assert.equal(planlib.rollupOk(content.root), false);
  assert.equal(content.summary.untried, 1);
  assert.match(planlib.planClosed(content).reason, /1 required leaf/);
});

test('A5: a decision leaf with one alternative and no engine evidence fails', () => {
  const root = planlib.generateStructure(idea, cargo.experience(), cargo.design(), cargo.spec('/tmp/out'));
  const kit = cargo.trialKit(planlib.collectLeaves(root));
  kit.leaves['L1.4'] = {
    bases: cargo.basesNone('decided by the alternatives'),
    alternatives: [{ id: 'ALT1', name: 'the only way', summary: 'asserted without a build kit' }],
    chosen: 'ALT1', rationale: 'it is the obvious way',
  };
  assert.equal(validate(TRIAL_KIT, kit).ok, true);
  const content = planlib.applyTrialKit(root, kit, { scratchDir: scratch('one-alt') });
  const decision = planlib.nodesById(content.root).get('L1.4');
  assert.equal(decision.trial.status, 'gap');
  assert.match(decision.trial.reason, /one alternative and no engine evidence/);
  assert.equal(content.decision.chosen, null);
  assert.equal(planlib.rollupOk(content.root), false);

  const kit2 = cargo.trialKit(planlib.collectLeaves(root));
  kit2.leaves['L1.4'].alternatives = [kit2.leaves['L1.4'].alternatives[0]];
  const content2 = planlib.applyTrialKit(root, kit2, { scratchDir: scratch('one-alt-built') });
  assert.equal(planlib.nodesById(content2.root).get('L1.4').trial.status, 'gap');
  assert.match(planlib.nodesById(content2.root).get('L1.4').trial.reason, /not a comparison/);

  const kit3 = cargo.trialKit(planlib.collectLeaves(root));
  kit3.leaves['L1.4'].alternatives[1].build.files['b.js'] = 'process.exit(1);';
  const content3 = planlib.applyTrialKit(root, kit3, { scratchDir: scratch('one-feasible') });
  const d3 = planlib.nodesById(content3.root).get('L1.4');
  assert.equal(d3.trial.status, 'passed');
  assert.equal(content3.decision.basis, 'only_one_feasible');
  assert.deepEqual(d3.trial.alternatives.map((a) => a.feasible), [true, false]);
  assert.equal(d3.trial.alternatives[1].evidence[0].executor, 'engine');
});

test('choosing an alternative the engine proved infeasible is a conflict on the decision leaf', () => {
  const root = planlib.generateStructure(idea, cargo.experience(), cargo.design(), cargo.spec('/tmp/out'));
  const kit = cargo.trialKit(planlib.collectLeaves(root));
  kit.leaves['L1.4'].alternatives[0].build.files['a.js'] = 'process.exit(1);';
  const content = planlib.applyTrialKit(root, kit, { scratchDir: scratch('conflict') });
  const decision = planlib.nodesById(content.root).get('L1.4');
  assert.equal(decision.trial.status, 'conflict');
  assert.match(decision.trial.reason, /ALT1 is infeasible by engine evidence/);
  assert.equal(content.summary.conflicts, 1);
  assert.equal(planlib.rollupOk(content.root), false);
});

test('an executable basis closes only with an engine-executed entry; a failing test is a gap; derivation length is never evidence', () => {
  const root = planlib.generateStructure(idea, cargo.experience(), cargo.design(), cargo.spec('/tmp/out'));
  const kit = cargo.trialKit(planlib.collectLeaves(root));
  kit.leaves['L1.1.A1'].bases.executable_test.exec = { files: { 'boom.js': 'process.exit(3);' }, entry: 'boom.js' };
  kit.leaves['L1.3.C1'].bases.first_principles = { applicable: true, derivation: 'trust me, it holds' };
  const content = planlib.applyTrialKit(root, kit, { scratchDir: scratch('gaps') });
  const byId = planlib.nodesById(content.root);
  assert.equal(byId.get('L1.1.A1').trial.status, 'gap');
  assert.match(byId.get('L1.1.A1').trial.reason, /engine-executed test failed/);
  assert.equal(byId.get('L1.1.A1').trial.evidence[0].executor, 'engine');
  assert.equal(byId.get('L1.1.A1').trial.evidence[0].ok, false);
  assert.equal(byId.get('L1.3.C1').trial.status, 'passed', 'an assumption leaf passes on a derivation of any length');
  assert.equal(content.summary.gaps, 1);
  const none = cargo.trialKit(planlib.collectLeaves(root));
  none.leaves['L1.3.C1'] = { bases: cargo.basesNone('nothing applies') };
  const c2 = planlib.applyTrialKit(root, none, { scratchDir: scratch('none') });
  const bare = planlib.nodesById(c2.root).get('L1.3.C1');
  assert.equal(bare.trial.status, 'gap');
  assert.match(bare.trial.reason, /no applicable basis recorded/);
});

test('a high-risk leaf needs two independent evidence methods', () => {
  const spec = cargo.spec('/tmp/out');
  spec.constraints.push({ id: 'C2', constraint: 'the page never makes a network request' });
  const root = planlib.generateStructure(idea, cargo.experience(), cargo.design(), spec);
  const c2 = planlib.collectLeaves(root).find((l) => l.title.startsWith('C2:'));
  assert.equal(c2.risk, 'high');
  const kit = cargo.trialKit(planlib.collectLeaves(root));
  kit.leaves[c2.id] = { bases: { ...cargo.basesNone('static file'), first_principles: { applicable: true, derivation: 'a static string with no script or src cannot initiate a request' } } };
  let content = planlib.applyTrialKit(root, kit, { scratchDir: scratch('risk-one') });
  const tried = planlib.nodesById(content.root).get(c2.id);
  assert.equal(tried.trial.status, 'gap');
  assert.match(tried.trial.reason, /two independent evidence methods/);
  kit.leaves[c2.id].bases.executable_test = { applicable: true, exec: { files: { 't.js': "if (/fetch|src=|href=/.test('<p>hello</p>')) process.exit(1);" }, entry: 't.js' } };
  content = planlib.applyTrialKit(root, kit, { scratchDir: scratch('risk-two') });
  const tried2 = planlib.nodesById(content.root).get(c2.id);
  assert.equal(tried2.trial.status, 'passed');
  assert.deepEqual(tried2.trial.evidence.map((e) => e.basis).sort(), ['executable_test', 'first_principles']);
  assert.deepEqual(content.summary.high_risk, [c2.id]);
});

test('A5: Plan Skip after a complete trial skips only the human review', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const wheel = new Wheel();
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(cargo.submitSpec(wheel, outDir, '25'));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));

  const partial = cargo.trialKit(planlib.collectLeaves(wheel.state.nodes.plan.draft));
  delete partial.leaves['L1.2.R1'];
  let r = ok(wheel.runTurn({ type: 'plan_trial', kit: partial }));
  assert.equal(r.result.closed.ok, false);
  r = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(r.result.gap, '1 required leaf/leaves untried');
  assert.equal(wheel.state.nodes.plan.versions[0].state, 'rejected');
  assert.equal(wheel.state.gate, null, 'PLAN_READY never opened on an open trial');
  assert.equal(wheel.state.reviews.at(-1).decision, 'gap');
  assert.deepEqual(wheel.state.reviews.at(-1).references, ['L1.2.R1']);
  assert.ok(wheel.state.frontier.next_legal.includes('plan_generate'));

  ok(wheel.runTurn({ type: 'plan_generate' }));
  const full = cargo.trialKit(planlib.collectLeaves(wheel.state.nodes.plan.draft));
  r = ok(wheel.runTurn({ type: 'plan_trial', kit: full }));
  assert.equal(r.result.closed.ok, true);
  r = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(wheel.state.gate.id, 'PLAN_READY');
  assert.equal(wheel.state.gate.def.question, gates.humanText('PLAN_READY_V1'));
  assert.deepEqual(wheel.state.gate.def.actions, ['SUMMARIZE', 'SKIP_REVIEW', 'APPROVE']);
  assert.equal(wheel.state.status, 'yellow');
  const acceptedPlan = wheel.state.nodes.plan.versions.at(-1);
  assert.equal(acceptedPlan.state, 'accepted');

  r = ok(wheel.runTurn({ type: 'gate', action: 'SUMMARIZE' }));
  assert.match(r.result.reply, /10 leaves, 10 passed, 0 untried, 0 gaps, 0 conflicts; decision ALT1 \(compared_two\)/);
  assert.equal(wheel.state.gate.id, 'PLAN_READY');
  assert.equal(wheel.state.execution.unlocked, false, 'nothing executes before the human review or its skip');
  assert.match(wheel.state.execution.reason, /PLAN_READY has not been approved/);
  r = ok(wheel.runTurn({ type: 'gate', action: 'SKIP_REVIEW' }));
  assert.deepEqual(r.result.skipped, ['optional human review']);
  assert.equal(wheel.state.gate, null);
  assert.equal(wheel.state.plan_review.action, 'SKIP_REVIEW');
  assert.deepEqual(wheel.state.plan_review.not_skipped, ['leaf', 'evidence', 'gap', 'conflict', 'write lock']);
  assert.equal(wheel.state.frontier.stage, 'execution');
  assert.deepEqual(wheel.state.nodes.plan.versions.at(-1).content, acceptedPlan.content, 'no leaf, evidence, gap, or conflict was touched');
  assert.equal(wheel.state.nodes.plan.versions.at(-1).content.summary.untried, 0);
  assert.equal(wheel.state.closure_proof.all_ok, true, 'the closure proof was not skipped: it passed on its own');
  assert.equal(wheel.state.execution.unlocked, true, 'the write lock opens only because proof and review are both settled');
  assert.deepEqual(Object.keys(wheel.state.executions), [], 'skipping the review executes nothing');
  wheel.close();
});

test('Plan Skip is refused while a high-risk leaf lacks its human gate, unless Spec preauthorizes it', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const risky = () => {
    const s = cargo.spec(outDir);
    s.constraints.push({ id: 'C2', constraint: 'the page never makes a network request' });
    return s;
  };
  const drive = (spec) => {
    const wheel = new Wheel();
    ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
    ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
    ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
    ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
    ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
    ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
    ok(wheel.runTurn({ type: 'form', kind: 'spec', content: spec }));
    ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
    ok(wheel.runTurn({ type: 'plan_generate' }));
    const leaves = planlib.collectLeaves(wheel.state.nodes.plan.draft);
    const kit = cargo.trialKit(leaves);
    const c2 = leaves.find((l) => l.title.startsWith('C2:'));
    kit.leaves[c2.id] = { bases: { ...cargo.basesNone('static file'),
      first_principles: { applicable: true, derivation: 'a static string with no script or src cannot initiate a request' },
      executable_test: { applicable: true, exec: { files: { 't.js': "if (/fetch|src=|href=/.test('<p>hello</p>')) process.exit(1);" }, entry: 't.js' } } } };
    ok(wheel.runTurn({ type: 'plan_trial', kit }));
    ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
    assert.equal(wheel.state.gate.id, 'PLAN_READY');
    return wheel;
  };
  let wheel = drive(risky());
  let r = wheel.runTurn({ type: 'gate', action: 'SKIP_REVIEW' });
  assert.equal(r.ok, false);
  assert.match(r.error, /high-risk leaves need the human gate/);
  assert.equal(wheel.state.gate.id, 'PLAN_READY', 'the gate stays');
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  assert.equal(wheel.state.plan_review.action, 'APPROVE');
  wheel.close();

  resetStore();
  const preauthorized = risky();
  preauthorized.preauthorized_high_risk = ['C2'];
  wheel = drive(preauthorized);
  ok(wheel.runTurn({ type: 'gate', action: 'SKIP_REVIEW' }));
  assert.equal(wheel.state.gate, null);
  wheel.close();
});

test('a kit entry written as the command ("node t.js") or quoted runs the file it names; a missing entry file is a clear failure', () => {
  const { entryFile, collectLeaves } = require('../lib/plan');
  assert.equal(entryFile({ 't.js': '' }, 'node t.js'), 't.js');
  assert.equal(entryFile({ 't.js': '' }, '"t.js"'), 't.js');
  assert.equal(entryFile({ 'run.js': '' }, 'node run.js --flag'), 'run.js');
  assert.equal(entryFile({ 'only.js': '' }, ''), 'only.js');
  assert.equal(entryFile({ 'a.js': '' }, 'missing.js'), 'missing.js');
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const wheel = new Wheel();
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(cargo.submitSpec(wheel, outDir, '25'));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
  const leaves = collectLeaves(wheel.state.nodes.plan.draft);
  const kit = cargo.trialKit(leaves);
  kit.leaves['L1.1.A1'].bases.executable_test.exec.entry = 'node proto.js';
  kit.leaves['L1.5.1'].bases.executable_test.exec.entry = 'nowhere.js';
  const r = ok(wheel.runTurn({ type: 'plan_trial', kit }));
  const tried = collectLeaves(r.result.content ? r.result.content.root : wheel.state.nodes.plan.versions.at(-1).content.root);
  const a1 = tried.find((l) => l.id === 'L1.1.A1');
  assert.equal(a1.trial.status, 'passed', 'the command form ran the file');
  const rel = tried.find((l) => l.id === 'L1.5.1');
  assert.equal(rel.trial.status, 'gap');
  assert.match(rel.trial.evidence.find((e) => e.basis === 'executable_test').detail, /names no file in the kit/);
  wheel.close();
});

test('A13: kind-owned trial - an action or expected_result leaf whose kit marks executable_test not applicable is a gap whatever its derivations say; an assumption leaf passes on derivation; a derivation\'s length changes nothing', () => {
  const root = planlib.generateStructure(idea, cargo.experience(), cargo.design(), cargo.spec('/tmp/out'));
  const leaves = planlib.collectLeaves(root);
  const a1 = leaves.find((l) => l.title.startsWith('A1:'));
  const r1 = leaves.find((l) => l.title.startsWith('R1:'));
  const c1 = leaves.find((l) => l.title.startsWith('C1:'));
  assert.deepEqual([a1.kind, r1.kind, c1.kind], ['expected_result', 'action', 'assumption']);
  assert.deepEqual([...planlib.EXECUTION_REQUIRED].sort(), ['action', 'expected_result', 'loop']);
  const long = 'A very thorough derivation. '.repeat(40) + 'Therefore the requirement holds by construction.';
  const short = 'It holds by construction.';
  const derivedOnly = (text) => ({
    ...cargo.basesNone('the kit opted out of running anything'),
    first_principles: { applicable: true, derivation: text },
    trusted_method: { applicable: true, derivation: text },
    inspection: { applicable: true, observation: text },
  });

  const kit = cargo.trialKit(leaves);
  kit.leaves[a1.id] = { bases: derivedOnly(long) };
  kit.leaves[r1.id] = { bases: derivedOnly(long) };
  kit.leaves[c1.id] = { bases: { ...cargo.basesNone('static'), first_principles: { applicable: true, derivation: short } } };
  const content = planlib.applyTrialKit(root, kit, { scratchDir: scratch('a13-derived') });
  const byId = planlib.nodesById(content.root);
  for (const leaf of [a1, r1]) {
    const tried = byId.get(leaf.id);
    assert.equal(tried.trial.status, 'gap', leaf.id + ' is a gap without an engine-run test');
    assert.equal(tried.trial.reason, `${leaf.kind} leaf requires an engine-executed test; the kit marked executable_test not applicable`);
    assert.equal(tried.trial.evidence.length, 3, 'the derivations are recorded');
    assert.ok(tried.trial.evidence.every((e) => e.executor === 'model'));
    assert.ok(tried.trial.evidence.every((e) => e.detail.startsWith('recorded, not proven: ')), 'nothing model-authored is reported as proven');
  }
  assert.equal(byId.get(c1.id).trial.status, 'passed', 'an assumption leaf passes on a short derivation');
  assert.equal(byId.get(c1.id).trial.evidence[0].executor, 'model');
  assert.equal(content.summary.gaps, 2);

  const kit2 = cargo.trialKit(leaves);
  kit2.leaves[a1.id] = { bases: { ...derivedOnly(short), executable_test: { applicable: true, exec: { files: { 't.js': 'process.exit(0);' }, entry: 't.js' } } } };
  kit2.leaves[r1.id] = { bases: { ...derivedOnly(long), executable_test: { applicable: true, exec: { files: { 't.js': 'process.exit(0);' }, entry: 't.js' } } } };
  const c2 = planlib.applyTrialKit(root, kit2, { scratchDir: scratch('a13-run') });
  const byId2 = planlib.nodesById(c2.root);
  for (const leaf of [a1, r1]) {
    assert.equal(byId2.get(leaf.id).trial.status, 'passed');
    const engine = byId2.get(leaf.id).trial.evidence.filter((e) => e.executor === 'engine');
    assert.equal(engine.length, 1);
    assert.equal(engine[0].ok, true);
  }
  assert.equal(c2.summary.gaps, 0);

  const kit3 = cargo.trialKit(leaves);
  kit3.leaves[r1.id] = { bases: { ...derivedOnly(long), executable_test: { applicable: true, exec: { files: { 't.js': 'process.exit(2);' }, entry: 't.js' } } } };
  const c3 = planlib.applyTrialKit(root, kit3, { scratchDir: scratch('a13-fail') });
  assert.equal(planlib.nodesById(c3.root).get(r1.id).trial.status, 'gap');
  assert.match(planlib.nodesById(c3.root).get(r1.id).trial.reason, /engine-executed test failed/);
});

test('the engine confines every kit it runs to its scratch directory: a probe that writes outside it fails, and the gap names the refusal', () => {
  const idea = cargo.ideaText(); delete idea.name;
  const root = planlib.generateStructure(idea, cargo.experience(), cargo.design(), cargo.spec('/tmp/out'));
  const leaves = planlib.collectLeaves(root);
  const r1 = leaves.find((l) => l.id === 'L1.2.R1');
  const kit = cargo.trialKit(leaves);
  const escape = path.join(os.tmpdir(), 'aw-escape-' + process.pid + '.txt');
  kit.leaves[r1.id] = { bases: cargo.basesExec({ 't.js': `require('fs').writeFileSync(${JSON.stringify(escape)}, 'out'); process.exit(0);` }, 't.js', 'a probe that writes outside its directory') };
  const content = planlib.applyTrialKit(root, kit, { scratchDir: scratch('a-confined') });
  const tried = planlib.nodesById(content.root).get(r1.id);
  assert.equal(tried.trial.status, 'gap', 'the write outside scratch fails the probe');
  assert.ok(!fs.existsSync(escape), 'nothing was written outside the scratch directory');
  const evidence = JSON.stringify(tried.trial.evidence);
  assert.match(evidence, /ERR_ACCESS_DENIED|permission|Access to this API has been restricted/i, 'the refusal is recorded: ' + evidence.slice(0, 300));
});
