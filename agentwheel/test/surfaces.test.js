'use strict';
const { resetStore } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cargo = require('./tiny-cargo');
const { auditTail } = require('../lib/store');

function auth(token) {
  return { authorization: 'Bearer ' + token, connection: 'close' };
}
async function getJson(url, token) {
  const res = await fetch(url, { headers: auth(token) });
  return res.json();
}
async function postJson(url, body, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...auth(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the helper serves the tokened loopback API: MCP spool + HTTP turns + watcher plan generation', async () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const token = crypto.randomBytes(24).toString('hex');
  const h = await require('../surfaces/helper').start({ port: 0, token, watchMs: 120 });
  const base = `http://127.0.0.1:${h.port}`;

  try {
    const who = await getJson(base + '/api/status', token);
    assert.equal(who.surface, 'helper');
    assert.equal(who.status, 'unspooled');
    const page = await fetch(base + '/', { headers: auth(token) });
    assert.equal(page.status, 404);

    const spool = await postJson(base + '/api/spool', cargo.ideaText(), token);
    assert.equal(spool.mcp, true, JSON.stringify(spool).slice(0, 300));
    const spoolText = JSON.parse(spool.result.content[0].text);
    assert.equal(spoolText.ok, true);

    let s = await getJson(base + '/api/state', token);
    assert.equal(s.project.name, 'Tiny Note');
    assert.equal(s.pending_validation.kind, 'idea');
    let r = await postJson(base + '/api/turn', { input: { type: 'validate', action: 'ACCEPT' } }, token);
    assert.equal(r.ok, true, r.error);

    r = await postJson(base + '/api/turn', { input: { type: 'form', kind: 'experience', content: cargo.experience() } }, token);
    assert.equal(r.ok, true, r.error);
    await postJson(base + '/api/turn', { input: { type: 'validate', action: 'ACCEPT' } }, token);
    r = await postJson(base + '/api/turn', { input: { type: 'form', kind: 'design', content: cargo.design() } }, token);
    assert.equal(r.ok, true, r.error);
    s = await getJson(base + '/api/state', token);
    assert.equal(s.gate && s.gate.id, 'DESIGN_READY', 'a human Design waits at DESIGN_READY; the watcher proposes nothing on its own');
    await postJson(base + '/api/turn', { input: { type: 'gate', action: 'APPROVE' } }, token);
    for (const input of cargo.controlInputs('25', ['api:anthropic'])) assert.equal((await postJson(base + '/api/turn', { input }, token)).ok, true);
    await postJson(base + '/api/turn', { input: { type: 'form', kind: 'spec', content: cargo.spec(outDir) } }, token);
    await postJson(base + '/api/turn', { input: { type: 'validate', action: 'ACCEPT' } }, token);

    let planned = false;
    for (let i = 0; i < 30 && !planned; i++) {
      await wait(120);
      s = await getJson(base + '/api/state', token);
      planned = Boolean(s.nodes.plan && s.nodes.plan.draft);
    }
    assert.ok(planned, 'watcher auto-generated the plan draft');
    assert.match(s.nodes.plan.line, /draft/);

    const audit = await getJson(base + '/api/audit?n=10', token);
    assert.ok(Array.isArray(audit) && audit.length > 0);
    const cards = await getJson(base + '/api/cards?n=10', token);
    assert.ok(Array.isArray(cards));
    for (let i = 0; i < 40; i++) {
      s = await getJson(base + '/api/state', token);
      if (s.gate && s.gate.id === 'ROUTE_ATTENTION') break;
      await wait(120);
    }
    assert.equal(s.gate && s.gate.id, 'ROUTE_ATTENTION');
    assert.match(s.gate.def.question, /not_ready: api:anthropic/);
    const routes = await getJson(base + '/api/routes', token);
    assert.equal(routes.routes.length, 14);
    assert.ok(!('allowlist' in routes));
    assert.equal(routes.seats.leader.route, 'api:anthropic');
    const held = await postJson(base + '/api/secrets', { provider: 'anthropic', key: 'sk-test-only' }, token);
    assert.deepEqual(held.providers, ['anthropic']);
    assert.ok(!JSON.stringify(await getJson(base + '/api/secrets', token)).includes('sk-test-only'));
    assert.ok(!fs.readFileSync(path.join(require('../lib/paths').storeDir, 'audit.jsonl'), 'utf8').includes('sk-test-only'));

    const bad = await fetch(base + '/api/turn', {
      method: 'POST', headers: { ...auth(token), 'content-type': 'application/json' },
      body: JSON.stringify({ input: { type: 'finalize' } }),
    });
    assert.equal(bad.status, 422);
  } finally {
    clearInterval(h.watcher);
    h.closeAll();
    h.server.close();
  }
});

test('A18: New Project creates store/projects/<uuidv7>/ with its own events.jsonl and lease; two projects show in the rail; each replays byte-identical alone', async () => {
  resetStore();
  const paths = require('../lib/paths');
  const storelib = require('../lib/store');
  const { replay } = require('../lib/reducers');
  const { isUuidv7 } = require('../lib/ids');
  const token = crypto.randomBytes(24).toString('hex');
  const h = await require('../surfaces/helper').start({ port: 0, token, watchMs: 5000 });
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const first = await postJson(base + '/api/spool', cargo.ideaText(), token);
    assert.equal(first.mcp, true);
    assert.ok(isUuidv7(first.project_id), 'the new project is named by a UUIDv7');
    const second = await postJson(base + '/api/spool', { name: 'Second Note', problem: 'p'.repeat(30), solution: 's'.repeat(30) }, token);
    assert.ok(isUuidv7(second.project_id) && second.project_id !== first.project_id);
    const rail = await getJson(base + '/api/projects', token);
    assert.deepEqual(rail.projects.map((p) => [p.id, p.name, p.status]), [[first.project_id, 'Tiny Note', 'yellow'], [second.project_id, 'Second Note', 'yellow']], 'two projects show in the rail');
    assert.equal(rail.current, second.project_id, 'the newest spool is current');
    for (const id of [first.project_id, second.project_id]) {
      const pp = paths.projectPaths(id);
      assert.equal(pp.dir, path.join(paths.projectsDir, id));
      assert.ok(fs.existsSync(pp.eventsPath), 'its own events.jsonl');
      assert.ok(fs.existsSync(pp.leasePath), 'its own lease');
      const { events, torn } = storelib.readEvents(pp);
      assert.equal(torn, null);
      assert.equal(events.length, 1);
      const snap = JSON.parse(fs.readFileSync(pp.snapshotPath, 'utf8'));
      assert.equal(JSON.stringify(replay(events)), JSON.stringify(snap.state), 'replays byte-identical alone');
    }
    const index = JSON.parse(fs.readFileSync(paths.projectsIndexPath, 'utf8'));
    assert.deepEqual(index.projects.map((p) => p.id), [first.project_id, second.project_id]);
    const one = await getJson(base + '/api/state?project=' + first.project_id, token);
    assert.equal(one.project.name, 'Tiny Note');
    assert.equal(one.projects.length, 2);
    const r = await postJson(base + '/api/turn', { input: { type: 'validate', action: 'ACCEPT' }, project: first.project_id }, token);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.project_id, first.project_id);
    assert.equal((await getJson(base + '/api/state?project=' + first.project_id, token)).frontier.stage, 'experience');
    assert.equal((await getJson(base + '/api/state?project=' + second.project_id, token)).frontier.stage, 'idea', 'the other project did not move');
    assert.equal((await getJson(base + '/api/state', token)).project.name, 'Second Note', 'no project named: the current one');
    const missing = await fetch(base + '/api/state?project=nope', { headers: auth(token) });
    assert.equal(missing.status, 404);
    const { spawnSync } = require('child_process');
    const status = spawnSync(process.execPath, [path.join(paths.appRoot, 'bin', 'agentwheel.js'), 'status'], { encoding: 'utf8', env: { ...process.env } });
    assert.match(status.stdout, /Tiny Note: green/);
    assert.match(status.stdout, /Second Note: yellow/);
  } finally {
    clearInterval(h.watcher);
    h.closeAll();
    h.server.close();
  }
});

test('A18: the helper archives a 2.0.x single-project store before it reads the project list - even with no project of its own yet', async () => {
  resetStore();
  const paths = require('../lib/paths');
  const storelib = require('../lib/store');
  fs.mkdirSync(paths.storeDir, { recursive: true });
  const spool = {
    seq: 1, id: '01a00000-0000-7000-8000-00000000a17a', ts: '2026-09-02T07:20:35.299Z', turn: 't_1', type: 'turn',
    input: { type: 'spool', name: 'Old', problem: 'p'.repeat(30), solution: 's'.repeat(30) },
    facts: { project_id: 'p_old', version_id: 'v_old', schema_version: 3 },
  };
  const journal = JSON.stringify(spool) + '\n';
  fs.writeFileSync(paths.eventsPath, journal);
  fs.writeFileSync(paths.snapshotPath, JSON.stringify({ seq: 1, state: { schema_version: 3, project: { id: 'p_old', name: 'Old' } } }));
  const token = crypto.randomBytes(24).toString('hex');
  const h = await require('../surfaces/helper').start({ port: 0, token, watchMs: 5000 });
  try {
    assert.ok(h.legacyArchive && h.legacyArchive.includes('store-archive-2.0.x-'), 'archived beside itself at start: ' + h.legacyArchive);
    assert.equal(fs.readFileSync(path.join(h.legacyArchive, 'events.jsonl'), 'utf8'), journal, 'the journal moved intact');
    assert.ok(!fs.existsSync(paths.eventsPath), 'nothing canonical stays at the top level');
    assert.equal(h.wheels.size, 0, 'the old store was never read as a project');
    const rail = await getJson(`http://127.0.0.1:${h.port}/api/projects`, token);
    assert.deepEqual(rail.projects, []);
    const row = storelib.auditTail(5).find((a) => a.event === 'legacy_store_archived');
    assert.equal(row.store, '2.0.x');
    assert.equal(row.schema_version, 3);
    const again = await require('../surfaces/helper').start({ port: 0, token, watchMs: 5000 });
    try { assert.equal(again.legacyArchive, null); } finally { clearInterval(again.watcher); again.closeAll(); again.server.close(); }
  } finally {
    clearInterval(h.watcher);
    h.closeAll();
    h.server.close();
  }
});

test('A18: a listed project journal an earlier schema_version wrote is archived beside itself at start, never replayed, and leaves the rail; no Wheel opens in its name', async () => {
  resetStore();
  const paths = require('../lib/paths');
  const storelib = require('../lib/store');
  const { SCHEMA_VERSION } = require('../lib/reducers');
  const id = '01a00000-0000-7000-8000-00000000a18a';
  const pp = paths.projectPaths(id);
  fs.mkdirSync(pp.dir, { recursive: true });
  const spool = {
    seq: 1, id: '01a00000-0000-7000-8000-00000000a18b', ts: '2026-09-03T02:22:57.614Z', turn: 't_1', type: 'turn',
    input: { type: 'spool', name: 'Bookmaker', problem: 'p'.repeat(30), solution: 's'.repeat(30) },
    facts: { project_id: id, version_id: 'v_old', schema_version: SCHEMA_VERSION - 1 },
  };
  const journal = JSON.stringify(spool) + '\n';
  fs.writeFileSync(pp.eventsPath, journal);
  fs.mkdirSync(paths.storeDir, { recursive: true });
  fs.writeFileSync(paths.projectsIndexPath, JSON.stringify({ version: 1, projects: [{ id, name: 'Bookmaker', created: '2026-09-03T02:22:57.614Z' }] }, null, 1) + '\n');
  const token = crypto.randomBytes(24).toString('hex');
  const h = await require('../surfaces/helper').start({ port: 0, token, watchMs: 5000 });
  try {
    assert.equal(h.wheels.size, 0, 'no Wheel opened on the archived project');
    assert.ok(!fs.existsSync(pp.dir), 'no empty directory was recreated in its name');
    const archives = fs.readdirSync(paths.projectsDir).filter((n) => n.startsWith(id + '-archive-schema' + (SCHEMA_VERSION - 1)));
    assert.equal(archives.length, 1, 'archived beside itself');
    assert.equal(fs.readFileSync(path.join(paths.projectsDir, archives[0], 'events.jsonl'), 'utf8'), journal, 'the journal moved intact, never replayed');
    const rail = await getJson(`http://127.0.0.1:${h.port}/api/projects`, token);
    assert.deepEqual(rail.projects, [], 'it left the rail');
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.projectsIndexPath, 'utf8')).projects, []);
    const rows = storelib.auditTail(10);
    assert.ok(rows.some((a) => a.event === 'legacy_project_archived' && a.schema_version === SCHEMA_VERSION - 1));
    assert.ok(rows.some((a) => a.event === 'legacy_project_dropped_from_rail' && a.id === id));
  } finally {
    clearInterval(h.watcher);
    h.closeAll();
    h.server.close();
  }
});

test('a request without the launch token is 401 and audited', async () => {
  resetStore();
  const token = crypto.randomBytes(24).toString('hex');
  const h = await require('../surfaces/helper').start({ port: 0, token, watchMs: 5000 });
  const base = `http://127.0.0.1:${h.port}`;
  try {
    const bare = await fetch(base + '/api/state', { headers: { connection: 'close' } });
    assert.equal(bare.status, 401);
    const wrong = await fetch(base + '/api/state', { headers: auth('not-the-token-at-all-0000') });
    assert.equal(wrong.status, 401);
    const turn = await fetch(base + '/api/turn', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ input: { type: 'spool', ...cargo.ideaText() } }),
    });
    assert.equal(turn.status, 401, 'no turn enters without the token');
    const refused = auditTail(50).filter((a) => a.event === 'auth_refused');
    assert.ok(refused.length >= 3, 'every refusal is audited');
    assert.ok(refused.some((a) => a.path === '/api/turn' && a.method === 'POST'));
    const ok = await fetch(base + '/api/state', { headers: auth(token) });
    assert.equal(ok.status, 200);
    assert.deepEqual(require('../lib/store').listProjects(), [], 'the refused spool never entered the store');
  } finally {
    clearInterval(h.watcher);
    h.closeAll();
    h.server.close();
  }
});
