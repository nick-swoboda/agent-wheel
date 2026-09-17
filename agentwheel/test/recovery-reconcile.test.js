'use strict';
const { resetStore, homeDir } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const paths = require('../lib/paths');
const storelib = require('../lib/store');
const cargo = require('./tiny-cargo');

const bin = path.join(paths.appRoot, 'bin', 'agentwheel.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function auth(token) {
  return { authorization: 'Bearer ' + token, connection: 'close' };
}
async function getJson(base, pathname, token) {
  const res = await fetch(base + pathname, { headers: auth(token) });
  return res.json();
}
async function postTurn(base, input, token, project) {
  const res = await fetch(base + '/api/turn', {
    method: 'POST', headers: { ...auth(token), 'content-type': 'application/json' },
    body: JSON.stringify({ input, ...(project ? { project } : {}) }),
  });
  return res.json();
}

function spawnHelper(token) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'helper'], {
      env: { ...process.env, AGENT_WHEEL_HOME: homeDir, AGENT_WHEEL_STORE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('helper never became ready: ' + out)); }, 20000);
    child.stdout.on('data', (c) => {
      out += c;
      const nl = out.indexOf('\n');
      if (nl >= 0) { clearTimeout(timer); resolve({ child, ready: JSON.parse(out.slice(0, nl)) }); }
    });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdin.write(JSON.stringify({ token }) + '\n');
  });
}

async function waitFor(fn, what, ms) {
  const deadline = Date.now() + (ms || 30000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) assert.fail('timed out waiting for ' + what);
    await wait(150);
  }
}

function killSleepers(dir) {
  for (const name of fs.readdirSync(dir)) {
    const m = /^pid\.(\d+)\.(\d+)$/.exec(name);
    if (!m) continue;
    for (const pid of [Number(m[1]), Number(m[2])]) {
      if (pid > 1 && pid !== process.pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  }
}

function inflightRows() {
  try { return JSON.parse(fs.readFileSync(path.join(homeDir, '.convobus', 'inflight-agent-wheel.json'), 'utf8')); } catch { return []; }
}

test('A22: kill the helper with a card in flight; after RETRY the adapter shows no occupied route, the dead card is closed as transport_error in the audit, and the watcher stages exactly once', async () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const sleeperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-sleeper-'));
  const providerPath = path.join(sleeperDir, 'sleeper.js');
  fs.writeFileSync(providerPath,
    "require('fs').writeFileSync(require('path').join(__dirname, 'pid.' + process.pid + '.' + process.ppid), '');\n" +
    "process.stdin.resume(); process.stdin.on('end', () => {}); setTimeout(() => {}, 300000);\n");
  const token = crypto.randomBytes(24).toString('hex');
  const first = await spawnHelper(token);
  const base = `http://127.0.0.1:${first.ready.port}`;
  let projectId = null;
  let deadCard = null;
  try {
    const spool = await postTurn(base, { type: 'spool', ...cargo.ideaText() }, token);
    assert.equal(spool.ok, true, spool.error);
    projectId = spool.project_id;
    for (const seat of ['leader', 'builder', 'reviewer']) {
      assert.equal((await postTurn(base, { type: 'seat_assignment', seat, route: 'claude:cli', config: { command: ['node', providerPath] } }, token)).ok, true);
    }
    assert.equal((await postTurn(base, { type: 'validate', action: 'ACCEPT' }, token)).ok, true);
    assert.equal((await postTurn(base, { type: 'form', kind: 'experience', content: cargo.experience() }, token)).ok, true);
    assert.equal((await postTurn(base, { type: 'validate', action: 'ACCEPT' }, token)).ok, true);
    assert.equal((await postTurn(base, { type: 'form', kind: 'design', content: cargo.design() }, token)).ok, true);
    assert.equal((await postTurn(base, { type: 'gate', action: 'APPROVE' }, token)).ok, true);
    assert.equal((await postTurn(base, { type: 'form', kind: 'spec', content: cargo.spec(outDir) }, token)).ok, true);
    assert.equal((await postTurn(base, { type: 'validate', action: 'ACCEPT' }, token)).ok, true);
    const s = await waitFor(async () => {
      const x = await getJson(base, '/api/state', token);
      return x.pending_seat && x.pending_seat.kind === 'plan_trial' ? x : null;
    }, 'a plan_trial card in flight');
    deadCard = s.pending_seat.card_id;
    const rows = inflightRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].card_id, deadCard);
    assert.equal(rows[0].pid, first.child.pid, 'the row names the helper whose delivery holds the card');
  } finally {
    first.child.kill('SIGKILL');
  }
  await waitFor(async () => { try { process.kill(first.child.pid, 0); return null; } catch { return true; } }, 'the helper to die');
  await wait(300);
  assert.equal(inflightRows().length, 1, 'the dead card still occupies the route: nothing is cleared by code');
  const pp = paths.projectPaths(projectId);

  const h = await require('../surfaces/helper').start({ port: 0, token, watchMs: 100 });
  const base2 = `http://127.0.0.1:${h.port}`;
  try {
    const wheel = h.wheelFor(projectId);
    assert.ok(wheel, 'the project reopened');
    assert.ok(wheel.recovery, 'crash residue detected');
    assert.equal(wheel.status(), 'red');
    assert.equal(wheel.gateView().id, 'RECOVERY_REQUIRED');
    assert.equal(inflightRows().length, 1, 'RECOVERY_REQUIRED is open; the row waits for the human');
    assert.equal(h.transport.capacity('claude:cli', { command: ['node', providerPath] }, { project_id: projectId }).ok, false, 'the route is occupied by the dead card');
    const stagedBefore = storelib.auditTail(5000, pp).filter((a) => a.phase === 'APPLYING' && /seat dispatch staged/.test(a.reason || '')).length;
    const cardsBefore = storelib.auditTail(5000, pp).filter((a) => a.event === 'card_out').length;

    const r = await postTurn(base2, { type: 'gate', action: 'RETRY' }, token, projectId);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.result.action, 'RETRY');
    assert.deepEqual(inflightRows().filter((row) => row.project_id === projectId), [], 'the adapter shows no occupied route');
    assert.equal(h.transport.capacity('claude:cli', { command: ['node', providerPath] }, { project_id: projectId }).ok, true, 'the route is free again');
    const closed = storelib.auditTail(5000, pp).find((a) => a.event === 'dead_card_closed');
    assert.ok(closed, 'the dead card is closed in the audit');
    assert.equal(closed.card, deadCard);
    assert.equal(closed.outcome, 'transport_error');
    assert.equal(closed.route, 'claude:cli');
    assert.match(closed.detail, /dead card: no live seat holds it/);
    const back = h.transport.listCards().find((c) => c.id === deadCard);
    assert.equal(back.state, 'back', 'a genuine back card closed it');
    assert.match(back.reply, /"outcome":"transport_error"/);
    assert.equal(wheel.state.last_recovery.action, 'RETRY');
    assert.deepEqual(wheel.state.last_recovery.reconciled, [{ card_id: deadCard, route: 'claude:cli', outcome: 'transport_error' }]);
    assert.equal(wheel.state.pending_seat, null, 'RETRY: a fresh dispatch, not a resurrected card');
    assert.equal(wheel.recovery, null);

    await waitFor(() => (wheel.state.pending_seat ? wheel.state : null), 'the fresh dispatch to leave');
    await wait(1200);
    const audit = storelib.auditTail(5000, pp);
    const staged = audit.filter((a) => a.phase === 'APPLYING' && /seat dispatch staged/.test(a.reason || '')).length - stagedBefore;
    const cardsOut = audit.filter((a) => a.event === 'card_out').length - cardsBefore;
    assert.equal(staged, 1, 'the watcher stages exactly once after RETRY');
    assert.equal(cardsOut, 1, 'exactly one new card left');
    assert.equal(audit.filter((a) => a.phase === 'EGRESS_GUARD' && a.ok === false && a.guard === 'route_capacity').length, 0, 'no capacity refusal: the dead card no longer occupies the route');
    assert.notEqual(wheel.state.pending_seat.card_id, deadCard);
    const live = inflightRows().filter((row) => row.project_id === projectId);
    assert.equal(live.length, 1);
    assert.equal(live[0].card_id, wheel.state.pending_seat.card_id);
    assert.equal(live[0].pid, process.pid, 'the new row names this helper');
  } finally {
    clearInterval(h.watcher);
    h.closeAll();
    h.server.close();
    killSleepers(sleeperDir);
  }
});

test('A22: RESUME reconciles too; a card of another project is left alone', async () => {
  resetStore();
  const token = crypto.randomBytes(24).toString('hex');
  const h = await require('../surfaces/helper').start({ port: 0, token, watchMs: 5000, transport: require('../lib/transport').createStubTransport() });
  try {
    const t = h.transport;
    const mine = t.send({ route: 'claude:cli', cfg: {}, binding: { project_id: 'p_mine' }, envelope: { type: 'dispatch', seat: 'leader', kind: 'plan_trial', superdoc: { binding: {} }, result_schema: 'TRIAL_KIT', timeout_ms: 1000 } });
    const other = t.send({ route: 'claude:cli', cfg: {}, binding: { project_id: 'p_other' }, envelope: { type: 'dispatch', seat: 'leader', kind: 'plan_trial', superdoc: { binding: {} }, result_schema: 'TRIAL_KIT', timeout_ms: 1000 } });
    assert.equal(t.inflight().length, 2);
    const closed = t.reconcile('p_mine', []);
    assert.deepEqual(closed.map((c) => [c.card_id, c.outcome]), [[mine.card.id, 'transport_error']]);
    assert.deepEqual(t.inflight().map((r) => r.card_id), [other.card.id], 'the other project\'s card is untouched');
    assert.equal(t.listCards().find((c) => c.id === mine.card.id).state, 'back');
    assert.equal(t.reconcile('p_mine', []).length, 0, 'nothing left to reconcile');
    const live = t.send({ route: 'claude:cli', cfg: {}, binding: { project_id: 'p_mine' }, envelope: { type: 'dispatch', seat: 'leader', kind: 'plan_trial', superdoc: { binding: {} }, result_schema: 'TRIAL_KIT', timeout_ms: 1000 } });
    assert.equal(t.reconcile('p_mine', [live.card.id]).length, 0);
    assert.ok(t.inflight().some((r) => r.card_id === live.card.id));
  } finally {
    clearInterval(h.watcher);
    h.closeAll();
    h.server.close();
  }
});
