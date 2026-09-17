'use strict';
const { resetStore } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('../lib/paths');
const { appRoot } = paths;
const pp = paths.projectPaths('commit-test');
const { lockPath, snapshotPath, eventsPath, mainDir } = pp;
const storeDir = pp.dir;
const commitlib = require('../lib/commit');
const { emptyNode, auditTail } = require('../lib/store');
const { KINDS } = require('../lib/schema');
const { nowIso, uuidv7 } = require('../lib/ids');

function baseState() {
  return {
    schema_version: 5,
    seq: 1,
    law: 'Agent-Wheel-ascii-diagram.txt',
    project: { id: pp.id, name: 'commit test', created: nowIso() },
    wheel: { phase: 'OPEN' },
    status: 'green',
    turns: { last_id: 1, last_event: null },
    budget: { authority: '25', window: '1 day', dispatches: [], used: 0, limit: 25 },
    nodes: Object.fromEntries(KINDS.map((k) => [k, emptyNode(k)])),
    pending_validation: null,
    pending_seat: null,
    gate: null,
    reviews: [],
    branches: {},
    leaves: {},
    executions: {},
    main: null,
    artifact: null,
    closure: null,
    quarantine: [],
    last_touched: [],
    last_failure: null,
    last_schema_reject: null,
    last_recovery: null,
    stopped: false,
    frontier: null,
  };
}

function eventFor(seq, turn) {
  return {
    seq, id: uuidv7(), ts: nowIso(), turn, turn_number: Number(turn.slice(2)),
    type: 'turn', input: { type: 'test' }, facts: {},
  };
}

function commit(prev, next, extra, seat) {
  const seq = (prev ? prev.seq : 0) + 1;
  next.seq = seq;
  return commitlib.commitEvent(prev, eventFor(seq, 't_' + seq), { state: next, ...(extra || {}) }, { seat: seat || 'system-commit' }, pp);
}

function ideaVersion(state, versionState, stagedBy, acceptedBy) {
  state.nodes.idea.versions.push({
    v: state.nodes.idea.versions.length + 1,
    id: uuidv7(),
    content: {
      problem: 'People cannot hand a note around without an app in the way.',
      solution: 'A single local file that opens instantly and shows the note.',
    },
    state: versionState,
    authored_by: 'human',
    staged_by_turn: stagedBy,
    accepted_by_turn: acceptedBy,
    ts: nowIso(),
  });
  return state;
}

test('only the commit-handler seat may write canonical state', () => {
  resetStore();
  assert.throws(() => commit(null, baseState(), {}, 'leader'), /commit handler seat/);
  assert.ok(!fs.existsSync(eventsPath), 'nothing was appended');
  commit(null, baseState());
  assert.ok(fs.existsSync(snapshotPath));
  assert.ok(fs.existsSync(eventsPath));
  const index = JSON.parse(fs.readFileSync(paths.projectsIndexPath, 'utf8'));
  assert.deepEqual(index.projects.map((p) => p.id), ['commit-test'], 'the first commit lists the project for the rail');
  const other = baseState();
  other.project.id = 'someone-else';
  assert.throws(() => commit(null, other), /state names project someone-else, the store commit-test/);
});

test('static discipline: no module besides commit.js writes the journal or the snapshot', () => {
  const libDir = path.join(appRoot, 'lib');
  const writesCanonical = /(writeFileSync|appendFileSync|openSync|renameSync|truncateSync)\([^)]*(statePath|snapshotPath|eventsPath)/;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);
  const modules = walk(libDir);
  assert.ok(modules.length > 10, 'lib modules found');
  for (const file of modules) {
    if (path.basename(file) === 'commit.js') continue;
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(
      !writesCanonical.test(src),
      `${path.relative(libDir, file)} writes canonical files; canonical writes belong to commit.js`
    );
  }
  const surfacesDir = path.join(appRoot, 'surfaces');
  for (const file of fs.readdirSync(surfacesDir)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(surfacesDir, file), 'utf8');
    assert.ok(!/statePath|snapshotPath|eventsPath/.test(src), `${file} must not touch canonical paths at all`);
  }
});

test('schema gate: invalid node content cannot enter canonical storage', () => {
  resetStore();
  const s = baseState();
  s.nodes.idea.versions.push({
    v: 1, id: uuidv7(), content: { problem: 'too short', solution: 'also too short' },
    state: 'staged', staged_by_turn: 't_1', ts: nowIso(), authored_by: 'human',
  });
  assert.throws(() => commit(null, s), /schema: idea v1/);
  const unsigned = baseState();
  unsigned.nodes.idea.versions.push({
    v: 1, id: uuidv7(), content: { problem: 'p'.repeat(30), solution: 's'.repeat(30) },
    state: 'staged', staged_by_turn: 't_1', ts: nowIso(),
  });
  assert.throws(() => commit(null, unsigned), /lacks authored_by/);
  assert.ok(!fs.existsSync(eventsPath), 'nothing entered the journal');
});

test('accepted versions are immutable', () => {
  resetStore();
  const prev = commit(null, ideaVersion(baseState(), 'accepted', 't_1', 't_2'));
  const next = structuredClone(prev);
  next.turns.last_id = 3;
  next.nodes.idea.versions[0].content.problem =
    'Rewritten history is still long enough to pass schema checks here.';
  assert.throws(() => commit(prev, next), /immutable content changed on idea v1/);
  const gone = structuredClone(prev);
  gone.nodes.idea.versions = [];
  assert.throws(() => commit(prev, gone), /versions removed/);
});

test('one turn cannot accept its own staging', () => {
  resetStore();
  const s = ideaVersion(baseState(), 'accepted', 't_5', 't_5');
  assert.throws(() => commit(null, s, { accepts: { kind: 'idea', v: 1 } }), /self-acceptance forbidden/);
  resetStore();
  const ok = ideaVersion(baseState(), 'accepted', 't_5', 't_6');
  commit(null, ok, { accepts: { kind: 'idea', v: 1 } });
});

test('design acceptance demands APPROVE at the DESIGN_READY gate', () => {
  resetStore();
  const s = baseState();
  s.nodes.design.versions.push({
    v: 1, id: uuidv7(),
    content: require('./tiny-cargo').design(),
    state: 'accepted', staged_by_turn: 't_1', accepted_by_turn: 't_2', ts: nowIso(), authored_by: 'human',
  });
  const accepts = { kind: 'design', v: 1 };
  assert.throws(() => commit(null, structuredClone(s), { accepts }), /DESIGN_READY APPROVE/);
  assert.throws(
    () => commit(null, structuredClone(s), { accepts, gate_meta: { id: 'DESIGN_READY', action: 'SUMMARY' } }),
    /DESIGN_READY APPROVE/
  );
  assert.throws(
    () => commit(null, structuredClone(s), { accepts, gate_meta: { id: 'REPAIR_REQUIRED', action: 'WAIVE' } }),
    /DESIGN_READY APPROVE/
  );
  commit(null, s, { accepts, gate_meta: { id: 'DESIGN_READY', action: 'APPROVE' } });
});

test('execution acceptance demands green tests, an independent acceptance, a review record, done leaves, and a merge into main', () => {
  resetStore();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ws-'));
  fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><html><body>hello</body></html>');
  const execution = (tests, staged, accepted) => ({
    branch: 'b_1', leaves: ['L1.1.A1'], main_file: 'index.html', files: ['index.html'],
    artifact: { workspace_path: path.join(workspace, 'index.html'), sha256: 'a'.repeat(64), bytes: 10 },
    tests, notes: 'n/a', workspace, base_versions: {}, author: { seat: 'builder', route: null }, authored_by: 'seat',
    staged_by_turn: staged, accepted_by_turn: accepted, ts: nowIso(), state: 'accepted',
  });
  const green = { command: 'node test.js', exit_code: 0, passed: 2, failed: 0, output_tail: 'TESTS passed=2 failed=0' };
  const red = { command: 'node test.js', exit_code: 1, passed: 1, failed: 1, output_tail: 'boom' };
  const review = { id: uuidv7(), turn: 't_2', subject: { kind: 'execution', branch: 'b_1', leaves: ['L1.1.A1'] }, decision: 'accept', references: [], notes: '', ts: nowIso() };
  const merge = { branch: 'b_1', from: workspace, to: mainDir, files: ['index.html'] };
  const build = (tests, staged, accepted, extra) => {
    const s = baseState();
    s.executions.b_1 = execution(tests, staged, accepted);
    s.leaves['L1.1.A1'] = { state: 'done', execution: { branch: 'b_1' } };
    s.reviews = [review];
    Object.assign(s, extra || {});
    return s;
  };
  assert.throws(() => commit(null, build(red, 't_1', 't_2'), { accepts_execution: 'b_1', merge }), /execution evidence insufficient/);
  assert.throws(() => commit(null, build(green, 't_2', 't_2'), { accepts_execution: 'b_1', merge }), /self-acceptance forbidden/);
  assert.throws(() => commit(null, build(green, 't_1', 't_2', { reviews: [] }), { accepts_execution: 'b_1', merge }), /without a review record/);
  assert.throws(() => commit(null, build(green, 't_1', 't_2', { leaves: {} }), { accepts_execution: 'b_1', merge }), /leaf L1\.1\.A1 is not done/);
  assert.throws(() => commit(null, build(green, 't_1', 't_2'), { accepts_execution: 'b_1' }), /carries no merge/);
  assert.throws(() => commit(null, build(green, 't_1', 't_2'), { accepts_execution: 'b_1', merge: { ...merge, to: workspace } }), /merge target is not main/);
  assert.ok(!fs.existsSync(path.join(mainDir, 'index.html')), 'nothing reached main past a refusal');
  commit(null, build(green, 't_1', 't_2'), { accepts_execution: 'b_1', merge });
  assert.equal(fs.readFileSync(path.join(mainDir, 'index.html'), 'utf8'), '<!doctype html><html><body>hello</body></html>', 'the merge is the single writer\'s');
});

test('crash residue: a stale lock is refused and never cleared by code; only the human gate action clears it', async () => {
  resetStore();
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, turn: 't_9', ts: nowIso() }));
  const seen = commitlib.inspectLock(pp);
  assert.equal(seen.present, true);
  assert.equal(seen.alive, false);

  assert.throws(() => commit(null, baseState()), (err) => {
    assert.ok(err instanceof commitlib.LockBusyError);
    assert.match(err.message, /never cleared by code/);
    return true;
  });
  assert.ok(fs.existsSync(lockPath), 'the stale lock is still there after the refusal');
  assert.ok(!fs.existsSync(eventsPath), 'nothing was written past a stale lock');

  assert.equal(typeof commitlib.clearStaleLock, 'undefined');
  assert.equal(typeof commitlib.hasStaleLock, 'undefined');
  assert.throws(() => commitlib.clearLockByHumanGate({ gate: 'BUDGET_GATE', action: 'STOP' }, pp), /RECOVERY_REQUIRED/);
  assert.throws(() => commitlib.clearLockByHumanGate({ gate: 'RECOVERY_REQUIRED', action: 'SHIP_IT' }, pp), /RECOVERY_REQUIRED/);
  assert.ok(fs.existsSync(lockPath));

  assert.equal(commitlib.clearLockByHumanGate({ gate: 'RECOVERY_REQUIRED', action: 'RESUME', turn: 't_1' }, pp), true);
  assert.ok(!fs.existsSync(lockPath));
  const cleared = auditTail(10, pp).find((a) => a.event === 'stale_lock_cleared_by_human');
  assert.ok(cleared && cleared.action === 'RESUME' && cleared.holder.pid === 999999);
  commit(null, baseState());

  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: sleeper.pid, turn: 't_9', ts: nowIso() }));
    const prev = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).state;
    assert.throws(() => commit(prev, structuredClone(prev)), /held by live pid/);
    assert.ok(fs.existsSync(lockPath));
  } finally {
    sleeper.kill();
    fs.unlinkSync(lockPath);
  }
});
