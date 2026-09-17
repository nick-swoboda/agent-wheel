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
const gates = require('../lib/gates');
const cargo = require('./tiny-cargo');
const { publicState } = require('../surfaces/helper');

function ok(r) {
  assert.equal(r.ok, true, r.error || 'turn failed');
  return r;
}

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
  ok(cargo.submitSpec(wheel, outDir, '25', ['claude:cli']));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
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

function review(wheel, decision, extra) {
  const cardId = dispatch(wheel);
  assert.equal(wheel.state.pending_seat.kind, 'review');
  return ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: { decision: decision || 'accept', references: ['reviewed'], notes: 'fresh context', ...(extra || {}) } }));
}

function closeCircle(wheel) {
  while (wheel.state.frontier.stage === 'execution') {
    ok(wheel.runTurn({ type: 'execute', submission: cargo.executionSubmission(wheel.state.frontier.leaves) }));
    ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  }
  ok(wheel.runTurn({ type: 'finalize' }));
  review(wheel, 'accept');
  ok(wheel.runTurn({ type: 'project_done' }));
  assert.equal(wheel.state.status, 'purple');
}

function leafStates(wheel) {
  const plan = wheel.state.nodes.plan.versions.filter((v) => v.state === 'accepted').at(-1).content;
  return Object.fromEntries(collectLeaves(plan.root).map((l) => [l.id, leafState(l, wheel.state.leaves)]));
}

test('the last response a seat gave is a seat\'s: a human execution note and a human review note are never attributed to one', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  ok(wheel.runTurn({ type: 'execute', submission: cargo.executionSubmission(wheel.state.frontier.leaves) }));
  const staged = Object.values(wheel.state.executions).filter((e) => e.state === 'staged');
  assert.equal(staged.length, 1, 'a human-run execution is staged');
  assert.ok(staged[0].notes, 'and it carries the human\'s notes');
  assert.equal(staged[0].author.route, null, 'written by the human, on no route');
  assert.equal(publicState(wheel.state, wheel, []).last_response, null,
    'the human\'s own execution notes are not a seat\'s response');

  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  const byValidate = wheel.state.reviews.filter((r) => r.reviewer && r.reviewer.seat === 'validate');
  assert.ok(byValidate.length, 'the deterministic validate seat left a record');
  assert.ok(byValidate.every((r) => !r.reviewer.route), 'with no route, because no card was sent');
  const lr = publicState(wheel.state, wheel, []).last_response;
  if (lr) {
    assert.ok(lr.route, 'anything shown as a response names the route that produced it');
    assert.ok(!['human', 'validate', 'system'].includes(lr.seat), 'and is not the human');
  }
  wheel.close();
});

test('A17: executing a leaf writes only on its branch; the Reviewer\'s accept merges and marks it done; the next Super Document shows that leaf collapsed as done and the frontier moved', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  const first = wheel.state.frontier.leaves;
  assert.deepEqual(first, ['L1.1.A1', 'L1.2.R1', 'L1.3.C1', 'L1.6.S1', 'L1.7', 'L1.8', 'L1.9.D1']);

  const builderCard = dispatch(wheel);
  assert.equal(wheel.state.pending_seat.kind, 'execute');
  let doc = wheel.state.dispatches[wheel.state.pending_seat.dispatch_id].superdoc;
  assert.deepEqual(doc.expanded_context.plan_leaves.expanded.map((l) => l.id), first);
  assert.deepEqual(doc.expanded_context.plan_leaves.stubs.map((l) => [l.id, l.state]), [['L1.4', 'passed'], ['L1.5.1', 'passed'], ['L1.5.2', 'passed']]);
  assert.deepEqual(doc.main_files, {}, 'main is empty before the first merge');

  ok(wheel.runTurn({ type: 'seat_result', card_id: builderCard, outcome: 'result', result: cargo.executionSubmission(first) }));
  const ex = wheel.state.executions.b_1;
  assert.equal(ex.state, 'staged');
  assert.ok(fs.existsSync(path.join(ex.workspace, 'index.html')), 'written on the branch');
  assert.ok(!fs.existsSync(wheel.paths.mainDir), 'nothing on main');
  assert.equal(wheel.state.main, null);
  assert.ok(!fs.existsSync(path.join(outDir, 'index.html')), 'nothing promoted');
  for (const id of first) assert.equal(wheel.state.leaves[id].state, 'executing');
  assert.equal(path.relative(wheel.paths.branchesDir, ex.workspace).startsWith('..'), false, 'the branch lives under the project\'s branches/');

  const r = review(wheel, 'accept');
  assert.deepEqual(r.result.done, first);
  assert.equal(wheel.state.executions.b_1.state, 'accepted');
  assert.equal(wheel.state.branches.b_1.state, 'merged');
  assert.ok(fs.existsSync(path.join(wheel.paths.mainDir, 'index.html')), 'merged to main');
  assert.ok(fs.existsSync(path.join(outDir, 'index.html')), 'promoted');
  assert.deepEqual(wheel.state.main.merged, ['b_1']);
  for (const id of first) assert.equal(wheel.state.leaves[id].state, 'done');
  assert.deepEqual(wheel.state.frontier.leaves, ['L1.4'], 'the frontier moved to the next after[]-ordered group');

  dispatch(wheel);
  doc = wheel.state.dispatches[wheel.state.pending_seat.dispatch_id].superdoc;
  assert.deepEqual(doc.expanded_context.plan_leaves.expanded.map((l) => l.id), ['L1.4']);
  const stubs = Object.fromEntries(doc.expanded_context.plan_leaves.stubs.map((l) => [l.id, l.state]));
  for (const id of first) assert.equal(stubs[id], 'done', id + ' collapsed as done');
  assert.deepEqual(Object.keys(doc.main_files), ['index.html', 'test.js'], 'main as it stands rides with the Builder');
  assert.match(doc.wiki_temp_snapshot.plan.leaves, /^7\/10 done/);
  wheel.close();
});

test('A17: a change to one Experience criterion sends back to untried exactly the leaves whose claim_refs name it; every other leaf stays done; the next Super Document shows the changed claim expanded beside the leaves that still stand; the circle closes again', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  closeCircle(wheel);
  assert.ok(Object.values(leafStates(wheel)).every((s) => s === 'done'));

  const preview = wheel.previewReopen('experience');
  assert.deepEqual(preview.leaves_back_to_untried.map((l) => l.id), ['L1.1.A1'], 'the preview names the leaves that serve the node\'s claims');
  ok(wheel.runTurn({ type: 'reopen', kind: 'experience' }));
  assert.ok(Object.values(leafStates(wheel)).every((s) => s === 'done'), 'done stays done until the successor is accepted');
  assert.equal(wheel.state.execution.unlocked, false);
  assert.match(wheel.state.execution.reason, /experience is reopened/);
  assert.equal(wheel.state.nodes.design.versions[0].state, 'accepted', 'nothing below is staled by position');
  assert.equal(wheel.state.nodes.spec.versions[0].state, 'accepted');

  const exp = cargo.experience();
  exp.acceptance[0].criterion = 'the page body contains the word hello, in bold';
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: exp }));
  const accepted = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.deepEqual(accepted.result.dropped, ['L1.1.A1']);
  const after = leafStates(wheel);
  assert.equal(after['L1.1.A1'], 'untried');
  for (const id of Object.keys(after).filter((x) => x !== 'L1.1.A1')) assert.equal(after[id], 'done', id + ' stays done');
  assert.equal(wheel.state.status, 'green', 'purple is removed the moment any leaf leaves done');
  assert.equal(wheel.state.closure, null);
  assert.equal(wheel.state.project_done, null);
  assert.equal(wheel.state.nodes.design.versions[0].state, 'accepted');
  assert.equal(wheel.state.nodes.spec.versions[0].state, 'accepted');
  assert.equal(wheel.state.nodes.plan.versions[0].state, 'accepted', 'the plan version stands; its leaf moved');
  assert.deepEqual(wheel.state.plan_dirty, { kind: 'experience', changed: ['A1'], removed: [], added: [], leaves: ['L1.1.A1'] });
  assert.equal(wheel.state.frontier.stage, 'plan');
  assert.ok(wheel.state.frontier.next_legal.includes('plan_generate'));

  const gen = ok(wheel.runTurn({ type: 'plan_generate' }));
  assert.equal(gen.result.carried, 9);
  assert.deepEqual(gen.result.to_try, ['L1.1.A1']);
  const draft = collectLeaves(wheel.state.nodes.plan.draft);
  assert.equal(draft.find((l) => l.id === 'L1.1.A1').trial.status, 'untried');
  assert.equal(draft.find((l) => l.id === 'L1.1.A1').title, 'A1: the page body contains the word hello, in bold');
  assert.equal(draft.find((l) => l.id === 'L1.2.R1').trial.status, 'passed');

  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.kind, 'plan_trial');
  const ctx = pd.superdoc.expanded_context;
  assert.deepEqual(ctx.changed_claims, {
    kind: 'experience',
    changed: [{ id: 'A1', text: 'the page body contains the word hello, in bold' }],
    added: [], removed: [], leaves_back_to_untried: ['L1.1.A1'],
  });
  assert.deepEqual(ctx.plan_leaves.expanded.map((l) => [l.id, l.state]), [['L1.1.A1', 'untried']]);
  const stubs = Object.fromEntries(ctx.plan_leaves.stubs.map((l) => [l.id, l.state]));
  assert.equal(Object.keys(stubs).length, 9);
  assert.ok(Object.values(stubs).every((s) => s === 'done'), 'the leaves that still stand, collapsed as done');
  assert.match(pd.superdoc.system_prompt, /PLAN LEAVES TO TRY[^\n]*\n- L1\.1\.A1 \[expected_result\]/);
  assert.match(pd.superdoc.system_prompt, /LEAVES THAT STILL STAND[\s\S]*- L1\.2\.R1 \[action, passed\]/);
  assert.match(pd.superdoc.system_prompt, /WHAT CHANGED/);
  assert.ok(pd.superdoc.prefixes.includes(gates.prefixText('PLAN_TRIAL_READ_ONLY_V1')));

  ok(wheel.runTurn({ type: 'egress' }));
  const kit = cargo.trialKit(draft.filter((l) => l.trial.status !== 'passed'));
  assert.deepEqual(Object.keys(kit.leaves), ['L1.1.A1']);
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result', result: kit }));
  assert.equal(wheel.state.nodes.plan.versions.at(-1).v, 2);
  review(wheel, 'accept');
  assert.equal(wheel.state.nodes.plan.versions[1].state, 'accepted');
  assert.equal(wheel.state.closure_proof.all_ok, true);
  assert.deepEqual(wheel.state.closure_proof.targets, { plan: 2, idea: 1, experience: 2, design: 1, spec: 1 });
  assert.equal(wheel.state.gate.id, 'PLAN_READY');
  assert.equal(wheel.state.plan_dirty, null);
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  const resumed = leafStates(wheel);
  assert.equal(resumed['L1.1.A1'], 'passed', 'the re-tried leaf stands on the new trial');
  assert.equal(Object.values(resumed).filter((s) => s === 'done').length, 9, 'every other leaf still done');
  assert.deepEqual(wheel.state.frontier.leaves, ['L1.1.A1'], 'only the moved leaf executes');
  closeCircle(wheel);
  assert.deepEqual(wheel.state.main.merged, ['b_1', 'b_2', 'b_3'], 'the release leaves are the closure\'s, not a Builder group');
  wheel.close();
});

test('A17: a version whose claims did not change stales nothing; a change to the Idea\'s solution reaches every leaf', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  closeCircle(wheel);

  ok(wheel.runTurn({ type: 'reopen', kind: 'experience' }));
  const same = cargo.experience();
  same.usability.push('and it never needs a manual');
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: same }));
  const r = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.deepEqual(r.result.dropped, []);
  assert.equal(wheel.state.plan_dirty, null);
  assert.ok(Object.values(leafStates(wheel)).every((s) => s === 'done'));
  assert.equal(wheel.state.status, 'purple', 'a version whose claims did not change stales nothing');
  assert.equal(wheel.state.nodes.experience.versions[1].state, 'accepted');

  ok(wheel.runTurn({ type: 'reopen', kind: 'idea' }));
  ok(wheel.runTurn({ type: 'prompt', text: 'A single local html file that shows the word hello and the date the moment it opens.', target: { kind: 'idea', field: 'solution' } }));
  const accepted = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(accepted.result.dropped.length, 10, 'every leaf went back');
  assert.ok(Object.values(leafStates(wheel)).every((s) => s === 'untried'));
  assert.equal(wheel.state.status, 'green');
  assert.deepEqual(wheel.state.plan_dirty.changed, ['solution']);
  assert.equal(wheel.state.frontier.stage, 'plan');
  const gen = ok(wheel.runTurn({ type: 'plan_generate' }));
  assert.equal(gen.result.carried, 0, 'nothing carried: every leaf is tried again');
  wheel.close();
});

test('a failed execution fails up and the repair dispatch carries the previous attempt: its files and the failing test output; a green execution clears it', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  const leaves = wheel.state.frontier.leaves;
  const failing = cargo.executionSubmission(leaves, { files: {
    'index.html': '<!doctype html>\n<html><body>hullo</body></html>\n',
    'test.js': cargo.TEST_JS,
  } });
  const r = ok(wheel.runTurn({ type: 'execute', submission: failing }));
  assert.equal(r.result.failed, true);
  assert.equal(r.result.branch, 'b_1');
  assert.equal(wheel.state.last_failure.failed_branch, 'b_1');
  assert.equal(wheel.state.last_failure.tests.exit_code, 1);
  assert.match(wheel.state.last_failure.tests.output_tail, /TESTS passed=1 failed=1/);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.kind, 'execute');
  assert.equal(pd.superdoc.previous_attempt.branch, 'b_1');
  assert.ok(pd.superdoc.previous_attempt.files['index.html'].includes('hullo'), 'the previous file rides along');
  const sys = pd.superdoc.system_prompt;
  assert.ok(sys.includes('PREVIOUS ATTEMPT (branch b_1; failed its tests) FAILED ITS TESTS (exit 1); repair it, do not start over.'), 'the repair instruction names why the attempt is there');
  assert.ok(sys.includes('TESTS passed=1 failed=1'), 'the failing output tail');
  assert.ok(sys.includes('--- index.html (previous attempt) ---'), 'the file, named as the previous attempt');
  ok(wheel.runTurn({ type: 'egress' }));
  const cardId = wheel.state.pending_seat.card_id;
  const fixed = cargo.executionSubmission(leaves);
  const r2 = ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: fixed }));
  assert.equal(r2.result.failed, undefined);
  assert.equal(wheel.state.executions.b_2.state, 'staged');
  assert.equal(wheel.readPreviousAttempt(wheel.state), null, 'nothing to repair once an execution stands');
  wheel.close();
});

test('the Reviewer of an execution reads the files themselves; a review gap on a green branch carries that attempt into the Builder\'s repair dispatch', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  const leaves = wheel.state.frontier.leaves;
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  assert.equal(wheel.state.pending_dispatch.kind, 'execute');
  ok(wheel.runTurn({ type: 'egress' }));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result', result: cargo.executionSubmission(leaves) }));
  assert.equal(wheel.state.pending_validation.kind, 'execution');
  assert.equal(wheel.state.pending_validation.author.seat, 'builder');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.kind, 'review');
  const subject = pd.superdoc.review_subject;
  assert.deepEqual(subject.content.files, ['index.html', 'test.js']);
  assert.ok(subject.content.file_contents['index.html'].includes('hello'), 'the artifact bytes are in the review document');
  assert.ok(subject.content.file_contents['test.js'].includes('TESTS passed='), 'and the test suite');
  assert.ok(pd.superdoc.system_prompt.includes('"file_contents"'), 'the Reviewer sees them');
  ok(wheel.runTurn({ type: 'egress' }));
  const cardId = wheel.state.pending_seat.card_id;
  ok(wheel.runTurn({ type: 'seat_result', card_id: cardId, outcome: 'result', result: { decision: 'gap', references: ['execution b_1', 'L1.1.A1'], notes: 'the page says hello but the criterion wants it in bold', earliest_repair: 'plan' } }));
  assert.equal(wheel.state.executions.b_1.state, 'rejected');
  assert.equal(wheel.state.last_failure.failed_branch, 'b_1');
  assert.equal(wheel.state.last_failure.tests.exit_code, 0);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const sys = wheel.state.pending_dispatch.superdoc.system_prompt;
  assert.ok(sys.includes('PREVIOUS ATTEMPT (branch b_1; returned by review) PASSED ITS TESTS BUT WAS NOT MERGED - THE REVIEWER RETURNED IT (see LAST REVIEW)'), 'the repair instruction names the return');
  assert.ok(sys.includes('the criterion wants it in bold'), 'with the Reviewer\'s note');
  assert.ok(sys.includes('--- index.html (previous attempt) ---'), 'and the files');
  wheel.close();
});

test('the closure Reviewer sees the reruns with their outputs, the released artifact\'s bytes, and the files on main', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  for (let i = 0; i < 12 && wheel.state.frontier.stage !== 'closure'; i++) {
    ok(wheel.runTurn({ type: 'seat_dispatch' }));
    ok(wheel.runTurn({ type: 'egress' }));
    ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result', result: cargo.executionSubmission(wheel.state.pending_seat.leaves || wheel.state.pending_dispatch_leaves || wheel.state.frontier.leaves) }));
    review(wheel, 'accept');
  }
  ok(wheel.runTurn({ type: 'finalize' }));
  assert.equal(wheel.state.closure.state, 'staged');
  assert.ok(wheel.state.closure.reruns.length >= 1, 'reruns recorded');
  const rr = wheel.state.closure.reruns[0];
  assert.equal(rr.exit_code, 0);
  assert.equal(rr.failed, 0);
  assert.match(rr.output_tail, /TESTS passed=\d+ failed=0/);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.kind, 'review');
  const subject = pd.superdoc.review_subject;
  assert.equal(subject.kind, 'closure');
  assert.ok(subject.content.artifact_content.includes('hello'), 'the released artifact\'s bytes');
  assert.ok(subject.content.main_files['index.html'].includes('hello'), 'the files on main');
  assert.equal(subject.content.reruns.length, wheel.state.closure.reruns.length);
  assert.ok(pd.superdoc.system_prompt.includes('TESTS passed='), 'the outputs reach the Reviewer');
  wheel.close();
});

test('the engine confines an execution\'s tests to the branch: a suite that writes into the release directory fails and writes nothing there', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  const leaves = wheel.state.frontier.leaves;
  const escape = path.join(outDir, 'index.html');
  const suite = cargo.executionSubmission(leaves, { files: {
    'index.html': '<!doctype html>\n<html><body>hello</body></html>\n',
    'test.js': `require('fs').writeFileSync(${JSON.stringify(escape)}, 'released by a test'); console.log('TESTS passed=1 failed=0'); process.exit(0);`,
  } });
  const r = ok(wheel.runTurn({ type: 'execute', submission: suite }));
  assert.equal(r.result.failed, true, 'the suite fails: ' + JSON.stringify(r.result.tests).slice(0, 300));
  assert.ok(!fs.existsSync(escape), 'nothing was written into the release directory');
  assert.match(r.result.tests.output_tail, /ERR_ACCESS_DENIED|permission|Access to this API has been restricted/i);
  wheel.close();
});

test('a closure review that names one leaf of an accepted execution reopens that leaf alone: the execution and its merge stand for its other leaves, and the repair dispatch shows that branch', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  closeCircle(wheel);
  assert.equal(wheel.state.status, 'purple');
  const first = wheel.state.executions.b_1;
  assert.ok(first.leaves.length >= 2, 'the first group executed several leaves together');
  const [named, other] = first.leaves;
  ok(wheel.runTurn({ type: 'reopen', kind: 'plan' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
  ok(wheel.runTurn({ type: 'plan_trial', kit: { leaves: {} } }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(wheel.runTurn({ type: 'finalize' }));
  assert.equal(wheel.state.closure.state, 'staged');
  ok(wheel.runTurn({ type: 'seat_result', card_id: dispatch(wheel), outcome: 'result', result: { decision: 'gap', references: ['closure', named], notes: 'the artifact misses ' + named, earliest_repair: 'plan' } }));
  assert.equal(wheel.state.leaves[named].state, 'gap', 'the named leaf reopened');
  assert.equal(wheel.state.leaves[other].state, 'done', 'its sibling stays done');
  assert.equal(wheel.state.executions.b_1.state, 'accepted', 'the accepted execution stands');
  assert.equal(wheel.state.last_failure.failed_branch, 'b_1', 'the repair dispatch will show that branch');
  assert.deepEqual(wheel.state.frontier.leaves, [named], 'only the named leaf is executed again');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const line = (String(wheel.state.pending_dispatch.superdoc.system_prompt).match(/PREVIOUS ATTEMPT[^\n]*/) || [''])[0];
  assert.equal(line, 'PREVIOUS ATTEMPT (branch b_1; returned by the final closure) PASSED ITS TESTS AND WAS MERGED; repair it, do not start over. Test output tail:', 'a merged branch is never called unmerged');
  wheel.close();
});

test('a reopened Idea takes the typed form: both fields change in one successor version; the window\'s state previews every leaf that will go back before the human confirms; accept walks exactly those', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToExecution(wheel, outDir);
  closeCircle(wheel);

  ok(wheel.runTurn({ type: 'reopen', kind: 'experience' }));
  const same = cargo.experience();
  same.usability.push('and it never needs a manual');
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: same }));
  const noWalk = publicState(wheel.state, wheel, []).pending_validation.preview;
  assert.deepEqual([noWalk.kind, noWalk.regenerates, noWalk.leaves, noWalk.changed], ['experience', false, [], []]);
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(wheel.state.status, 'purple');

  ok(wheel.runTurn({ type: 'reopen', kind: 'idea' }));
  assert.ok(wheel.state.frontier.next_legal.includes('form:idea'), 'the typed Idea form is legal on a reopened Idea');
  assert.deepEqual(Object.keys(wheel.state.nodes.idea.draft).sort(), ['problem', 'solution']);
  const next = {
    problem: 'There is no way to hand someone a note that opens instantly without any app, and none that says when it was written.',
    solution: 'A single local html file that shows the word hello and the date the moment it opens.',
  };
  const staged = ok(wheel.runTurn({ type: 'form', kind: 'idea', content: next }));
  assert.deepEqual(staged.result.staged, { kind: 'idea', v: 2 });
  assert.equal(wheel.state.nodes.idea.versions.length, 2, 'one successor version carries both changes');
  assert.deepEqual(wheel.state.nodes.idea.versions[1].content, next);
  const view = publicState(wheel.state, wheel, []);
  const preview = view.pending_validation.preview;
  assert.deepEqual(preview.changed, ['problem', 'solution']);
  assert.equal(preview.regenerates, true);
  assert.equal(preview.leaves.length, 10, 'every leaf will go back: the root serves both Idea claims');
  assert.ok(Object.values(leafStates(wheel)).every((s) => s === 'done'), 'nothing moves before the human confirms');
  assert.ok(wheel.state.project_done, 'purple is not removed by a preview');
  const accepted = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.deepEqual(accepted.result.dropped, preview.leaves, 'accept walks exactly what the preview showed');
  assert.ok(Object.values(leafStates(wheel)).every((s) => s === 'untried'));
  assert.equal(wheel.state.project_done, null);
  assert.equal(wheel.state.status, 'green');
  assert.deepEqual(wheel.state.plan_dirty.changed, ['problem', 'solution']);
  assert.equal(publicState(wheel.state, wheel, []).pending_validation, null);
  wheel.close();
});
