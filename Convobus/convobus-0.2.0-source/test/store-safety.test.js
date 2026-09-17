'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpDir, NODE, REPO } = require('./helpers');
const {
  ensureDir,
  paths,
  readInflight,
  upsertInflight,
  writeJson,
  readJson,
  appendLogWithTurn,
  appendLog,
  readLog,
} = require('../lib/store');
const { readPrefs, writePrefs } = require('../lib/control');

function child(script, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE, ['-e', script, ...args], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`child ${code}: ${stderr || stdout}`));
    });
  });
}

test('private state uses 0700/0600 and unique atomic replacements', () => {
  const root = tmpDir('store-private-');
  const dir = ensureDir(root);
  const prefs = path.join(dir, 'prefs.json');
  const legacyPayload = path.join(dir, 'ax-payload.json');
  writeJson(prefs, { keep: true });
  fs.writeFileSync(legacyPayload, '{"legacy":true}\n', { mode: 0o644 });
  fs.chmodSync(legacyPayload, 0o644);
  ensureDir(root);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(prefs).mode & 0o777, 0o600);
  assert.equal(fs.statSync(legacyPayload).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(legacyPayload, 'utf8'), '{"legacy":true}\n');
  assert.deepEqual(readJson(prefs, null), { keep: true });
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('32 concurrent state writers retain every inflight card', async () => {
  const root = tmpDir('store-concurrent-');
  const script = [
    "const {upsertInflight}=require('./lib/store')",
    "const root=process.argv[1]",
    "const id=process.argv[2]",
    "upsertInflight(root,{id,seat:'stdio',method:'stdio',from:'human',body:id,state:'waiting',reply:null})",
  ].join(';');
  await Promise.all(Array.from({ length: 32 }, (_, i) => child(script, [root, `card_${i}`])));
  const cards = readInflight(root);
  assert.equal(cards.length, 32);
  assert.deepEqual(new Set(cards.map((card) => card.id)).size, 32);
});

test('32 concurrent context writes retain every registered project', async () => {
  const root = tmpDir('store-context-writers-');
  require('../lib/seats').discover(root);
  const projects = Array.from({ length: 32 }, (_, index) => path.join(root, `project-${index}`));
  for (const project of projects) fs.mkdirSync(project);
  const script = [
    "const {setContext}=require('./lib/control')",
    "const root=process.argv[1]",
    "const project=process.argv[2]",
    "const result=setContext(root,{provider:'grok',project,surface:'cli',type:'grok-cli'},{skipStatus:true})",
    "if(!result.ok){process.stderr.write(JSON.stringify(result));process.exit(2)}",
  ].join(';');
  await Promise.all(projects.map((project) => child(script, [root, project])));
  const registered = new Set(readPrefs(root).ui.projects.map((project) => project.path));
  assert.deepEqual(registered, new Set(projects));
});

test('turn allocation and delivery append share one cross-process transaction', async () => {
  const root = tmpDir('store-turns-');
  const script = [
    "const {appendLogWithTurn}=require('./lib/store')",
    "const root=process.argv[1]",
    "const id=process.argv[2]",
    "const value=appendLogWithTurn(root,{event:'deliver',id})",
    "process.stdout.write(String(value.turn))",
  ].join(';');
  const turns = await Promise.all(
    Array.from({ length: 32 }, (_, i) => child(script, [root, `deliver_${i}`])),
  );
  assert.deepEqual(turns.map(Number).sort((a, b) => a - b), Array.from({ length: 32 }, (_, i) => i + 1));
});

test('simultaneous same-seat reservations admit exactly one card', async () => {
  const root = tmpDir('store-seat-reservation-');
  const script = [
    "const {cmdNext}=require('./lib/turn')",
    "const root=process.argv[1]",
    "const id=process.argv[2]",
    "const result=cmdNext(root,{seat:'stdio',body:id,newId:id})",
    "process.stdout.write(String(result.code))",
  ].join(';');
  const results = await Promise.all(
    Array.from({ length: 32 }, (_, i) => child(script, [root, `reserve_${i}`])),
  );
  assert.equal(results.filter((value) => Number(value) === 0).length, 1);
  assert.equal(readInflight(root).length, 1);
});

test('a stale dead-owner lock is reclaimed without touching live state', () => {
  const root = tmpDir('store-stale-');
  const dir = ensureDir(root);
  const lock = path.join(dir, '.state.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, token: 'dead' }) + '\n', { mode: 0o600 });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  writeJson(path.join(dir, 'prefs.json'), { recovered: true });
  assert.deepEqual(readJson(path.join(dir, 'prefs.json'), null), { recovered: true });
  assert.equal(fs.existsSync(lock), false);
});

test('state writes refuse a symlink target and preserve its destination', () => {
  const root = tmpDir('store-symlink-');
  const dir = ensureDir(root);
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, '{"safe":true}\n');
  fs.symlinkSync(outside, paths(root).seats);
  assert.throws(() => writeJson(paths(root).seats, { safe: false }), /unsafe symlink/);
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"safe":true}\n');
});

test('appendLogWithTurn remains available in-process', () => {
  const root = tmpDir('store-turn-local-');
  assert.equal(appendLogWithTurn(root, { event: 'deliver', id: 'one' }).turn, 1);
  assert.equal(appendLogWithTurn(root, { event: 'deliver', id: 'two' }).turn, 2);
});

test('historical final lifecycle records without a newline remain readable', () => {
  const root = tmpDir('store-final-line-');
  const file = paths(root).log;
  ensureDir(root);
  fs.writeFileSync(file, JSON.stringify({ event: 'stage', id: 'legacy-final-line' }), { mode: 0o600 });
  assert.equal(readLog(root)[0].id, 'legacy-final-line');
  appendLog(root, { event: 'reply', id: 'new-line' });
  assert.equal(readLog(root).length, 1, 'concatenated malformed history is not invented as two records');
  assert.equal(readLog(root)[0].event, 'broken');
});

test('preference updates preserve unknown top-level, UI, project, and route fields', () => {
  const root = tmpDir('store-prefs-unknown-');
  const file = path.join(ensureDir(root), 'prefs.json');
  writeJson(file, {
    futureTop: { enabled: true },
    accessibility: false,
    ui: {
      futureUi: 'keep',
      projects: [
        {
          path: root,
          futureProject: 7,
          routes: { claude: { surface: 'app', type: 'chat', futureRoute: 'keep' } },
        },
      ],
    },
  });
  const prefs = readPrefs(root);
  const ui = prefs.ui;
  ui.projects[0].routes.claude = { surface: 'app', type: 'cowork' };
  writePrefs(root, { accessibility: true, ui });
  const raw = readJson(file, null);
  assert.deepEqual(raw.futureTop, { enabled: true });
  assert.equal(raw.ui.futureUi, 'keep');
  assert.equal(raw.ui.projects[0].futureProject, 7);
  assert.equal(raw.ui.projects[0].routes.claude.futureRoute, 'keep');
  assert.equal(raw.ui.projects[0].routes.claude.type, 'cowork');
});

test('inflight and seat transactions preserve unknown additive fields', () => {
  const root = tmpDir('store-state-unknown-');
  writeJson(paths(root).inflight, { futureInflight: { keep: true }, cards: [] });
  upsertInflight(root, {
    id: 'future-card',
    seat: 'stdio',
    method: 'stdio',
    from: 'human',
    body: 'x',
    state: 'waiting',
    reply: null,
  });
  assert.deepEqual(readJson(paths(root).inflight, null).futureInflight, { keep: true });

  const { HANDLES, discover } = require('../lib/seats');
  const seats = HANDLES.map((definition) => ({
    handle: definition.handle,
    futureSeat: definition.handle === 'stdio' ? 'keep' : undefined,
  }));
  writeJson(paths(root).seats, { futureSeatsDocument: 9, seats });
  const refreshed = discover(root);
  assert.equal(refreshed.futureSeatsDocument, 9);
  assert.equal(refreshed.seats.find((seat) => seat.handle === 'stdio').futureSeat, 'keep');
});
