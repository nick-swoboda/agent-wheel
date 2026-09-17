'use strict';
const { resetStore, homeDir } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('../lib/paths');
const storelib = require('../lib/store');
const lease = require('../lib/lease');
const { replay } = require('../lib/reducers');
const { snapshotBytes } = require('../lib/commit');
const { nowIso } = require('../lib/ids');
const gates = require('../lib/gates');

const worker = path.join(__dirname, 'fixtures', 'commit-worker.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function runLife(opts) {
  return new Promise((resolve, reject) => {
    const args = [worker, opts.crashAt || '-', String(opts.crashSeq || 0)];
    const child = spawn(process.execPath, args, {
      env: { ...process.env, AGENT_WHEEL_HOME: homeDir, AGENT_WHEEL_STORE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = [];
    let buf = '';
    let stderr = '';
    let committed = 0;
    let killed = false;
    let applyingAt = 0;
    let commitMs = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('worker life timed out; lines=' + JSON.stringify(lines.slice(-5)) + ' stderr=' + stderr.slice(-500)));
    }, 15000);
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        lines.push(msg);
        if (msg.event === 'booted') {
          opts.onBooted(msg);
          if (msg.recovery) child.stdin.write('RESUME\n');
        }
        if (msg.event === 'recovered') opts.onRecovered(msg);
        if (msg.event === 'applying') {
          applyingAt = process.hrtime.bigint();
          if (opts.mode === 'random' && committed >= 1 && !killed) {
            killed = true;
            const delay = Math.random() * 2 * Math.max(commitMs, 0.2);
            setTimeout(() => child.kill('SIGKILL'), delay);
          }
        }
        if (msg.event === 'committed') {
          committed += 1;
          if (applyingAt) commitMs = Number(process.hrtime.bigint() - applyingAt) / 1e6;
        }
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, lines, stderr });
    });
  });
}

function projectPaths() {
  const known = storelib.listProjects()[0];
  assert.ok(known, 'the project is listed in store/projects.json');
  return paths.projectPaths(known.id);
}

function inspectStore() {
  const pp = projectPaths();
  const { events, torn } = storelib.readEvents(pp);
  assert.ok(!torn || torn.trailing === 0, 'corruption beyond the tail: ' + JSON.stringify(torn));
  const seq = events.length;
  const replayed = replay(events);
  const snapBytes = fs.readFileSync(pp.snapshotPath, 'utf8');
  let which;
  if (snapBytes === snapshotBytes(seq, replayed)) {
    which = 'new';
  } else {
    const snap = JSON.parse(snapBytes);
    assert.equal(snap.seq, seq - 1, `snapshot seq ${snap.seq} is neither new (${seq}) nor old (${seq - 1})`);
    assert.equal(snapBytes, snapshotBytes(snap.seq, replay(events.slice(0, snap.seq))), 'old snapshot must be byte-identical to its replay');
    which = 'old';
  }
  return { seq, torn, which };
}

test('A2: kill -9 during APPLYING, 100 lives: old-or-new state, INTERRUPTED lease, RECOVERY_REQUIRED, lock never cleared by code', async () => {
  resetStore();
  const POINTS = ['before_append', 'mid_append', 'after_append', 'after_snapshot'];
  const stats = { lives: 0, lockedKills: 0, recoveries: 0, old: 0, new: 0, torn: 0, byPoint: {} };
  let expectResidue = false;
  let expectLock = false;
  let seqAfterKill = 0;

  for (let i = 0; i < 100; i++) {
    const injected = i >= 60;
    const crashAt = injected ? POINTS[(i - 60) % POINTS.length] : null;
    const crashSeq = injected ? seqAfterKill + (expectResidue ? 1 : 0) + 2 : 0;

    let booted = null;
    let recovered = null;
    const life = await runLife({
      mode: injected ? 'inject' : 'random',
      crashAt,
      crashSeq,
      onBooted: (msg) => { booted = msg; },
      onRecovered: (msg) => { recovered = msg; },
    });
    stats.lives += 1;
    assert.ok(booted, 'worker booted: ' + life.stderr.slice(-400));

    if (expectResidue) {
      assert.ok(booted.recovery, 'restart after a kill reports RECOVERY_REQUIRED');
      assert.equal(booted.status, 'red');
      assert.equal(booted.gate, 'RECOVERY_REQUIRED');
      assert.deepEqual(booted.next_legal, ['gate']);
      assert.equal(booted.lock_present, expectLock, 'the lock is exactly as the crash left it: never cleared by code');
      assert.ok(recovered, 'the human RESUME was applied: ' + life.stderr.slice(-400));
      assert.equal(recovered.ok, true, recovered.error);
      assert.equal(recovered.lock_present, false, 'the human gate action cleared the lock');
      assert.ok(recovered.lease && recovered.lease.pid !== 0, 'a fresh lease was taken');
      stats.recoveries += 1;
    } else {
      assert.equal(booted.recovery, null, 'a clean store boots without recovery');
    }

    assert.ok(life.signal === 'SIGKILL' || life.code === null, `worker died by SIGKILL, not ${life.code}/${life.signal}`);

    const found = inspectStore();
    stats[found.which] += 1;
    if (found.torn) stats.torn += 1;
    seqAfterKill = found.seq;

    const pp = projectPaths();
    const leaseInfo = lease.inspect(nowIso(), pp);
    assert.equal(leaseInfo.present, true, 'the dead helper left its lease');
    assert.equal(leaseInfo.alive, false, 'the lease names a dead pid');
    assert.equal(leaseInfo.interrupted, true, 'the lease reports INTERRUPTED');

    const lockPresent = fs.existsSync(pp.lockPath);
    if (lockPresent) stats.lockedKills += 1;
    if (injected) {
      assert.equal(lockPresent, true, `crash injected at ${crashAt} happens inside APPLYING, so the lock stays`);
      stats.byPoint[crashAt] = (stats.byPoint[crashAt] || 0) + 1;
      if (crashAt === 'mid_append') assert.ok(found.torn, 'mid-append kill leaves a torn tail');
      if (crashAt === 'after_append' || crashAt === 'after_snapshot') assert.equal(found.seq, crashSeq, 'the appended event is durable');
      if (crashAt === 'before_append' || crashAt === 'mid_append') assert.equal(found.seq, crashSeq - 1, 'nothing partial entered the journal');
      if (crashAt === 'after_append') assert.equal(found.which, 'old', 'snapshot is the complete old state');
      if (crashAt === 'after_snapshot') assert.equal(found.which, 'new', 'snapshot is the complete new state');
    }
    expectResidue = true;
    expectLock = lockPresent;
  }

  assert.ok(stats.lockedKills >= 55, 'kills inside APPLYING: ' + JSON.stringify(stats));
  assert.equal(stats.recoveries, 99, 'every restart after a kill went through RECOVERY_REQUIRED');
  assert.ok(stats.old >= 10 && stats.new >= 10, 'both old and new complete states were observed: ' + JSON.stringify(stats));

  const audit = storelib.auditTail(20000, projectPaths());
  assert.ok(audit.filter((a) => a.event === 'stale_lock_cleared_by_human').length >= stats.lockedKills - 1);
  assert.equal(audit.filter((a) => a.event === 'recovery_required').length, 99);
  assert.equal(gates.gateDef('RECOVERY_REQUIRED').question,
    'Agent Wheel recovered an interrupted turn. Review the last durable state, then Retry, Resume, Discard the late result, or Stop.');
  console.log('recovery loop stats: ' + JSON.stringify(stats));
});
