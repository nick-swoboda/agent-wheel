'use strict';
const { resetStore } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wheel } = require('../lib/wheel');
const { collectLeaves } = require('../lib/plan');
const { auditTail } = require('../lib/store');
const transportLib = require('../lib/transport');
const gates = require('../lib/gates');
const cargo = require('./tiny-cargo');

function ok(r) {
  assert.equal(r.ok, true, r.error || 'turn failed');
  return r;
}

function driveToPlanDraft(wheel, outDir, authority) {
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(cargo.submitSpec(wheel, outDir, authority || '25'));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
}

function driveToExecution(wheel, outDir) {
  driveToPlanDraft(wheel, outDir);
  ok(wheel.runTurn({ type: 'plan_trial', kit: cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft)) }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  assert.equal(wheel.state.execution.unlocked, true);
}

test('the wheel closes a full circle: spool -> ... -> purple', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const transport = transportLib.createStubTransport();
  const wheel = new Wheel({ transport });

  let r = ok(wheel.runTurn({ type: 'spool', via: 'mcp', ...cargo.ideaText() }));
  assert.equal(r.status, 'yellow');
  assert.deepEqual(r.frontier.next_legal, ['validate']);
  r = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(r.status, 'green');
  assert.equal(r.frontier.stage, 'experience');

  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  r = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(r.frontier.stage, 'design');
  assert.deepEqual(r.frontier.next_legal, ['form:design', 'seat_dispatch', 'reopen']);

  r = ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  assert.equal(r.status, 'yellow');
  assert.equal(r.gate.id, 'DESIGN_READY');
  assert.deepEqual(r.gate.actions, ['APPROVE', 'REPLY_ASK', 'SUMMARY', 'REJECT']);
  assert.equal(r.gate.question, 'The Design is ready. Approve, reply/ask, summary, or reject?');
  r = ok(wheel.runTurn({ type: 'gate', action: 'SUMMARY' }));
  assert.ok(wheel.state.gate, 'SUMMARY is informational; gate stays open');
  r = ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  assert.equal(wheel.state.gate, null);
  assert.equal(wheel.state.nodes.design.versions[0].state, 'accepted');
  assert.equal(r.frontier.stage, 'spec');

  ok(cargo.submitSpec(wheel, outDir, '25'));
  r = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(wheel.state.budget.authority, '25');

  r = ok(wheel.runTurn({ type: 'plan_generate' }));
  assert.ok(wheel.state.nodes.plan.draft);
  const kit = cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft));
  r = ok(wheel.runTurn({ type: 'plan_trial', kit }));
  assert.equal(r.result.decision.chosen, 'ALT1');
  assert.equal(r.result.decision.basis, 'compared_two');
  assert.equal(r.result.closed.ok, true);
  r = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(r.result.closure_proof.all_ok, true);
  assert.equal(wheel.state.gate.id, 'PLAN_READY');
  assert.equal(wheel.state.gate.def.question, 'Plan Trial is complete and the closure proof passed. Summarize, skip optional review, or approve?');
  assert.equal(wheel.state.execution.unlocked, false);
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  assert.equal(wheel.state.execution.unlocked, true);
  assert.equal(wheel.state.frontier.stage, 'execution');

  const groups = [];
  while (wheel.state.frontier.stage === 'execution') {
    const leaves = wheel.state.frontier.leaves;
    groups.push(leaves);
    r = ok(wheel.runTurn({ type: 'execute', submission: cargo.executionSubmission(leaves) }));
    assert.equal(r.result.tests.failed, 0);
    assert.equal(wheel.state.pending_validation.kind, 'execution');
    for (const id of leaves) assert.equal(wheel.state.leaves[id].state, 'executing');
    ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
    for (const id of leaves) assert.equal(wheel.state.leaves[id].state, 'done');
  }
  assert.deepEqual(groups, [['L1.1.A1', 'L1.2.R1', 'L1.3.C1', 'L1.6.S1', 'L1.7', 'L1.8', 'L1.9.D1'], ['L1.4']], 'after[]-ordered groups; the release leaves L1.5.1 and L1.5.2 are executed by the final closure');
  const promoted = path.join(outDir, 'index.html');
  assert.ok(fs.existsSync(promoted), 'artifact promoted to the spec output dir');
  assert.match(wheel.state.artifact.product_link, /^file:\/\//);
  assert.deepEqual(wheel.state.main.merged, ['b_1', 'b_2']);
  assert.ok(fs.existsSync(path.join(wheel.state.main.dir, 'index.html')), 'the artifact grew on main');
  for (const b of ['b_1', 'b_2']) assert.equal(wheel.state.branches[b].state, 'merged');
  assert.equal(wheel.state.frontier.stage, 'closure');

  r = ok(wheel.runTurn({ type: 'finalize' }));
  const finalizeTurn = r.turn;
  assert.equal(r.result.proof_steps, 6);
  assert.equal(wheel.state.closure.state, 'staged');
  assert.equal(wheel.state.pending_validation.kind, 'closure');
  assert.deepEqual(wheel.state.frontier.next_legal, ['seat_dispatch'], 'the final closure is the Reviewer\'s to read');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  assert.equal(wheel.state.pending_dispatch.kind, 'review');
  assert.ok(wheel.state.pending_dispatch.superdoc.prefixes.includes(gates.prefixText('FINAL_CLOSURE_READ_ONLY_V1')));
  ok(wheel.runTurn({ type: 'egress' }));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result', result: { decision: 'accept', references: ['closure'], notes: 'every step ok' } }));
  assert.equal(wheel.state.closure.state, 'accepted');
  assert.deepEqual(wheel.state.frontier.next_legal, ['project_done', 'reopen']);
  ok(wheel.runTurn({ type: 'project_done' }));
  assert.equal(wheel.state.status, 'purple');
  assert.equal(wheel.state.wheel.phase, 'DONE');
  assert.deepEqual(wheel.state.frontier.next_legal, ['reopen'], 'Done is read-only until explicit Reopen or Fork');
  assert.equal(wheel.state.closure.all_ok, true);
  assert.deepEqual(wheel.state.closure.steps.map((s) => s.from + '->' + s.to), ['artifact->plan', 'plan->spec', 'spec->design', 'design->experience', 'experience->idea', 'idea->closure']);
  assert.ok(wheel.state.project_done);

  const audit = auditTail(2000, wheel.paths);
  const phases = new Set(audit.filter((a) => a.turn === finalizeTurn).map((a) => a.phase));
  for (const phase of ['OPEN', 'STAGING', 'WATCH_FRONTIER', 'COMPILE', 'AGREE_OR_ESCALATE', 'APPLYING', 'REBUILD']) {
    assert.ok(phases.has(phase), 'missing phase ' + phase + ' in ' + [...phases]);
  }
  assert.ok(audit.some((a) => a.event === 'PROJECT_DONE'));

  assert.equal(transportLib.listCards().length, 1);
  wheel.close();
});

test('OPEN rejects illegal inputs against the frontier', () => {
  resetStore();
  const wheel = new Wheel();
  let r = wheel.runTurn({ type: 'validate', action: 'ACCEPT' });
  assert.equal(r.ok, false);
  assert.match(r.error, /illegal input/);
  r = wheel.runTurn({ type: 'form', kind: 'spec', content: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /illegal input/);
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  r = wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() });
  assert.equal(r.ok, false);
  assert.match(r.error, /illegal input/);
  wheel.close();
});

test('a turn cannot accept its own staging (solo mode fresh-turn rule)', () => {
  resetStore();
  const wheel = new Wheel();
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  wheel.state.pending_validation.staged_by_turn = 't_2';
  const r = wheel.runTurn({ type: 'validate', action: 'ACCEPT' });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot accept its own staging/);
  wheel.close();
});

test('budget: dispatches count, human replies and the validate seat do not; exhaustion opens BUDGET_GATE yellow; EXTEND takes the next scale step', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  let t = Date.parse('2026-09-01T09:00:00.000Z');
  const now = () => new Date(t).toISOString();
  const wheel = new Wheel({ transport: transportLib.createStubTransport(), now });
  driveToPlanDraft(wheel, outDir, '25');
  assert.equal(wheel.state.turns.last_id, 13);
  assert.equal(wheel.state.budget.used, 0, 'human/system turns and project control changes do not count as dispatches');
  const stage = () => {
    if (wheel.state.gate && wheel.state.gate.id === 'ROUTE_ATTENTION') ok(wheel.runTurn({ type: 'gate', action: 'COMPLETE_ACTION' }));
    if (wheel.state.pending_redispatch) {
      t = Math.max(t, Date.parse(wheel.state.pending_redispatch.due_at));
      ok(wheel.runTurn({ type: 'redispatch' }));
    } else {
      ok(wheel.runTurn({ type: 'seat_dispatch' }));
    }
  };
  for (let i = 1; i <= 25; i++) {
    stage();
    ok(wheel.runTurn({ type: 'egress' }));
    assert.equal(wheel.state.budget.used, i);
    ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'timeout', detail: 'no answer' }));
  }
  stage();
  let r = wheel.runTurn({ type: 'egress' });
  assert.equal(r.ok, false);
  assert.equal(r.guard, 'prompt_budget');
  assert.equal(wheel.state.gate.id, 'BUDGET_GATE');
  assert.equal(wheel.state.gate.def.question, gates.humanText('BUDGET_GATE_V1'));
  assert.deepEqual(wheel.state.gate.def.actions, ['EXTEND', 'REPLAN', 'WAIT', 'STOP']);
  assert.equal(wheel.state.status, 'yellow');
  r = ok(wheel.runTurn({ type: 'gate', action: 'EXTEND' }));
  assert.equal(wheel.state.budget.authority, '50');
  stage();
  ok(wheel.runTurn({ type: 'egress' }));
  assert.equal(wheel.state.budget.used, 26);
  wheel.close();
});

test('schema reject stages nothing and arms the schema-repair prefix', () => {
  resetStore();
  const wheel = new Wheel();
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  const bad = cargo.experience();
  delete bad.acceptance;
  let r = wheel.runTurn({ type: 'form', kind: 'experience', content: bad });
  assert.equal(r.ok, false);
  assert.equal(r.schema_repair, true);
  assert.equal(wheel.state.nodes.experience.versions.length, 0, 'nothing entered storage');
  assert.equal(wheel.state.last_schema_reject.input_type, 'form');
  r = ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  assert.equal(wheel.state.last_schema_reject, null);
  wheel.close();
});

test('review rejection fails up: restages via chips, then accepts', () => {
  resetStore();
  const wheel = new Wheel();
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  let r = ok(wheel.runTurn({ type: 'validate', action: 'REJECT_RESTAGE', note: 'sharpen the problem' }));
  assert.equal(wheel.state.nodes.idea.reopened, true);
  assert.equal(wheel.state.nodes.idea.versions[0].state, 'rejected');
  r = ok(wheel.runTurn({
    type: 'prompt',
    text: 'Splitting a bill by hand stalls the whole table at the end of dinner.',
    target: { kind: 'idea', field: 'problem' },
  }));
  assert.equal(r.result.staged, null, 'one field alone does not stage');
  r = ok(wheel.runTurn({
    type: 'prompt',
    text: 'One screen shows tip, total, and an even per-person share instantly.',
    target: { kind: 'idea', field: 'solution' },
  }));
  assert.deepEqual(r.result.staged, { kind: 'idea', v: 2 });
  r = ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(wheel.state.nodes.idea.versions[1].state, 'accepted');
  assert.equal(wheel.state.nodes.idea.reopened, false);
  wheel.close();
});

test('design REJECT prepends the exact REJECTED_OPTIMIZE_V1 bytes and fails up', () => {
  resetStore();
  const wheel = new Wheel();
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  let r = ok(wheel.runTurn({ type: 'gate', action: 'REJECT', reply: 'fewer moving parts' }));
  assert.ok(wheel.state.nodes.design.rejected_note.startsWith(gates.prefixText('REJECTED_OPTIMIZE_V1')));
  assert.match(wheel.state.nodes.design.rejected_note, /^rejected, optimize - fewer/);
  assert.equal(wheel.state.nodes.design.reopened, true);
  r = ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  assert.equal(r.status, 'yellow');
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  assert.equal(wheel.state.nodes.design.versions.at(-1).state, 'accepted');
  assert.equal(wheel.state.nodes.design.rejected_note, null);
  wheel.close();
});

test('failing execution tests fail up and reopen the executed leaves, not the Plan', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const wheel = new Wheel();
  driveToExecution(wheel, outDir);
  const leaves = wheel.state.frontier.leaves;
  const broken = cargo.executionSubmission(leaves);
  broken.files['index.html'] = '<!doctype html><html><body>goodbye</body></html>';
  const r = ok(wheel.runTurn({ type: 'execute', submission: broken }));
  assert.equal(r.result.failed, true);
  assert.deepEqual(r.result.reopened, leaves);
  for (const id of leaves) {
    assert.equal(wheel.state.leaves[id].state, 'gap', id + ' reopened');
    assert.equal(wheel.state.leaves[id].attempts, 1);
  }
  assert.equal(wheel.state.nodes.plan.reopened, false, 'the first move is the leaf, not the Plan');
  assert.equal(wheel.state.nodes.plan.versions.at(-1).state, 'accepted');
  assert.equal(wheel.state.branches.b_1.state, 'stale');
  assert.equal(wheel.state.pending_validation, null);
  assert.equal(wheel.state.last_failure.kind, 'plan');
  assert.deepEqual(wheel.state.last_failure.leaves, leaves);
  assert.deepEqual(wheel.state.frontier.leaves, leaves, 'the same group is next again');
  ok(wheel.runTurn({ type: 'execute', submission: cargo.executionSubmission(leaves) }));
  assert.equal(wheel.state.executions.b_2.state, 'staged');
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  for (const id of leaves) assert.equal(wheel.state.leaves[id].state, 'done');
  assert.ok(wheel.state.artifact);
  assert.equal(wheel.state.last_failure, null);
  wheel.close();
});

test('crash residue: INTERRUPTED with RECOVERY_REQUIRED; the lock and lease are cleared only by the human gate action', () => {
  resetStore();
  const wheel = new Wheel();
  const { lockPath, leasePath } = wheel.paths;
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  const seqBefore = wheel.state.seq;
  wheel.close();
  const old = new Date(Date.now() - 45000).toISOString();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, turn: 't_99', ts: old }));
  fs.writeFileSync(leasePath, JSON.stringify({ instance: 'dead-instance', pid: 999999, started: old, heartbeat: old }));

  const revived = new Wheel({ project: wheel.projectId });
  assert.ok(revived.recovery, 'residue detected');
  assert.equal(revived.status(), 'red');
  assert.deepEqual(revived.frontier().next_legal, ['gate']);
  assert.equal(revived.gateView().id, 'RECOVERY_REQUIRED');
  assert.equal(revived.gateView().def.question, gates.humanText('RECOVERY_REQUIRED_V1'));
  assert.ok(fs.existsSync(lockPath), 'the stale lock is never cleared by code');
  assert.ok(fs.existsSync(leasePath), 'the stale lease is never cleared by code');
  assert.equal(revived.state.seq, seqBefore, 'the last durable state was replayed');

  let r = revived.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() });
  assert.equal(r.ok, false);
  assert.match(r.error, /RECOVERY_REQUIRED/);
  r = revived.runTurn({ type: 'gate', action: 'SHIP_IT' });
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(lockPath));

  r = ok(revived.runTurn({ type: 'gate', action: 'RESUME' }));
  assert.ok(!fs.existsSync(lockPath), 'the human action cleared the lock');
  assert.equal(revived.recovery, null);
  assert.equal(revived.state.seq, seqBefore + 1, 'the recovery is an event of its own');
  assert.equal(revived.state.last_recovery.action, 'RESUME');
  assert.equal(revived.state.last_recovery.residue.lock.holder.pid, 999999);
  assert.notEqual(revived.state.status, 'red');
  const audit = auditTail(50, revived.paths);
  assert.ok(audit.some((a) => a.event === 'recovery_required' && a.phase === 'INTERRUPTED'));
  assert.ok(audit.some((a) => a.event === 'stale_lock_cleared_by_human' && a.action === 'RESUME'));
  ok(revived.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  revived.close();
});

test('execution: an optional build_command generates the artifact in the branch workspace before the tests; a failed build fails up', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const wheel = new Wheel();
  driveToExecution(wheel, outDir);
  const leaves = wheel.state.frontier.leaves;
  const base = cargo.executionSubmission(leaves);
  const built = {
    ...base,
    files: { 'build.js': "require('fs').writeFileSync('index.html', '<!doctype html>\\n<html><body>hello</body></html>\\n'); console.log('built');", 'test.js': base.files['test.js'] },
    build_command: 'node build.js',
  };
  const noBuild = { ...built };
  delete noBuild.build_command;
  const refused = wheel.runTurn({ type: 'execute', submission: noBuild });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /main_file must be one of the submitted files, or produced by build_command/);
  const broken = { ...built, files: { ...built.files, 'build.js': "console.error('no inputs'); process.exit(3);" } };
  let r = ok(wheel.runTurn({ type: 'execute', submission: broken }));
  assert.equal(r.result.failed, true);
  assert.match(r.result.tests.output_tail, /build failed: no inputs/);
  for (const id of leaves) assert.equal(wheel.state.leaves[id].state, 'gap');
  r = ok(wheel.runTurn({ type: 'execute', submission: built }));
  assert.equal(r.result.tests.failed, 0);
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  const ex = wheel.state.executions.b_2;
  assert.equal(ex.state, 'accepted');
  assert.equal(ex.build.command, 'node build.js');
  assert.equal(ex.build.exit_code, 0);
  assert.ok(ex.files.includes('index.html'), 'the built artifact is part of the recorded files');
  assert.ok(fs.existsSync(path.join(outDir, 'index.html')), 'artifact promoted');
  assert.ok(fs.existsSync(path.join(wheel.state.main.dir, 'index.html')), 'merged to main');
  wheel.close();
});
