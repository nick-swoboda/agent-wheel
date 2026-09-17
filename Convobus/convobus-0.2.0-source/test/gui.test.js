'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { tmpDir, FIXTURE, readLog, readJson, convobus, REPO, NODE } = require('./helpers');
const { PAGE, listenGui } = require('../lib/gui');

const APPEND = path.join(REPO, 'scripts', 'fixture-append-jsonl.js');

function post(url, obj, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(obj);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Convobus-Token': token,
        },
      },
      (res) => {
        let t = '';
        res.on('data', (d) => {
          t += d;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: t }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

test('GUI page is a composer, not a raw NDJSON pre', () => {
  assert.match(PAGE, /<form id="composer"/);
  assert.match(PAGE, /<select id="seat"/);
  assert.match(PAGE, /id="directory"/);
  assert.match(PAGE, /<textarea id="body"/);
  assert.match(PAGE, /<button type="submit" id="send"/);
  assert.match(PAGE, /fetch\('\/api\/send'/);
  assert.doesNotMatch(PAGE, /test card|testSend|Last token|Last card|Session id/i);
  assert.doesNotMatch(PAGE, /<pre id="log">/);
});

test('production send rejects an empty message without creating a test card', async () => {
  const dir = tmpDir('gui-production-send-');
  const g = await listenGui(dir, 0);
  try {
    const r = await post(g.url + '/api/send', { body: '   ' }, g.token);
    assert.equal(r.status, 400, r.body);
    assert.equal(JSON.parse(r.body).error, 'message is empty');
    assert.deepEqual(readLog(dir), []);
  } finally {
    g.server.close();
  }
});

test('GUI composer originate path writes a card into log.ndjson', async () => {
  const dir = tmpDir('gui-');
  convobus(['seats'], { cwd: dir });
  const g = await listenGui(dir, 0);
  try {
    const r = await post(g.url + '/api/turn', {
      seat: 'stdio',
      from: 'human',
      body: 'typed-in-gui',
      argv: [process.execPath, FIXTURE],
    }, g.token);
    assert.equal(r.status, 200, r.body);
    const data = JSON.parse(r.body);
    assert.equal(data.card.state, 'back');
    assert.ok(data.card.reply.includes('typed-in-gui'), data.card.reply);
    const log = readLog(dir);
    const staged = log.find((e) => e.event === 'stage');
    assert.ok(staged);
    assert.equal(staged.card.id, data.card.id);
    assert.equal(staged.card.from, 'human');
  } finally {
    g.server.close();
  }
});

test('GUI composer /api/turn with cwd binds and attaches the vendor-store session, not a project jsonl', async () => {
  const dir = tmpDir('gui-bind-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convo ChatGPT CLI');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'inside.jsonl'), '{"type":"assistant","content":"from-project"}\n');
  const sess = path.join(home, '.codex', 'sessions', '2026', '08', '28');
  fs.mkdirSync(sess, { recursive: true });
  const file = path.join(sess, 'rollout-gui.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'session_meta',
      payload: { cwd: project, session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    }) + '\n',
  );
  convobus(['seats'], { cwd: dir, env: { HOME: home } });
  const g = await listenGui(dir, 0);
  try {
    const r = await post(g.url + '/api/turn', {
      seat: 'chatgpt-cli',
      from: 'human',
      body: 'typed-in-composer',
      cwd: project,
      argv: [NODE, APPEND, file],
      home,
    }, g.token);
    assert.equal(r.status, 200, r.body);
    const data = JSON.parse(r.body);
    assert.equal(data.card.state, 'back');
    assert.equal(data.card.cwd, path.resolve(project));
    assert.ok(data.card.reply.includes('typed-in-composer') || data.card.reply.includes('after-mark'), data.card.reply);
    const log = readLog(dir);
    const attach = log.find((e) => e.event === 'attach');
    assert.ok(attach, JSON.stringify(log));
    assert.equal(attach.sessionFile, file);
    assert.ok(!String(attach.sessionFile).startsWith(project + path.sep), attach.sessionFile);
    const seats = readJson(dir, 'seats.json');
    const row = (seats.seats || []).find((s) => s.handle === 'chatgpt-cli');
    assert.ok(row);
    assert.equal(row.cwd, path.resolve(project));
  } finally {
    g.server.close();
  }
});

test('GUI composer empty directory refuses and does not deliver', async () => {
  const dir = tmpDir('gui-empty-');
  convobus(['seats'], { cwd: dir });
  const g = await listenGui(dir, 0);
  try {
    const r = await post(g.url + '/api/turn', {
      seat: 'grok-cli',
      from: 'human',
      body: 'needs a folder',
    }, g.token);
    assert.equal(r.status, 400, r.body);
    const data = JSON.parse(r.body);
    assert.match(String(data.error || data.text || ''), /stop — empty directory/);
    assert.ok(!readLog(dir).some((e) => e.event === 'deliver'));
    const seats = JSON.parse(convobus(['seats', '--json'], { cwd: dir }).stdout);
    const grok = (seats.seats || []).find((s) => s.handle === 'grok-cli');
    assert.ok(grok);
    assert.equal(grok.state, 'open');
    assert.ok(!grok.cwd);
  } finally {
    g.server.close();
  }
});
