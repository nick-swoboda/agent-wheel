'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { tmpDir, FIXTURE, readLog, REPO, NODE, convobus } = require('./helpers');
const { PAGE, listenGui } = require('../lib/gui');
const { SURFACE_SEATS } = require('../lib/control');
const APPEND = path.join(REPO, 'scripts', 'fixture-append-jsonl.js');

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let t = '';
        res.on('data', (d) => {
          t += d;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: t }));
      })
      .on('error', reject);
  });
}

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

function plantCodex(home, project, sessionId) {
  fs.mkdirSync(project, { recursive: true });
  const sess = path.join(home, '.codex', 'sessions', '2026', '08', '29');
  fs.mkdirSync(sess, { recursive: true });
  const file = path.join(sess, 'rollout-surface.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'session_meta',
      payload: { cwd: project, session_id: sessionId },
    }) +
      '\n' +
      JSON.stringify({ type: 'user', content: 'convobus ready' }) +
      '\n',
  );
  return file;
}

test('detect payload is exactly the four named seats with attached/not/blocked and stdio|ax|none', async () => {
  const dir = tmpDir('surf-detect-');
  convobus(['seats'], { cwd: dir });
  const g = await listenGui(dir, 0);
  try {
    const r = await get(g.url + '/api/detect');
    assert.equal(r.status, 200, r.body);
    const data = JSON.parse(r.body);
    assert.equal(data.seats.length, 4);
    assert.deepEqual(
      data.seats.map((s) => s.name),
      SURFACE_SEATS.map((s) => s.name),
    );
    assert.deepEqual(
      data.seats.map((s) => s.handle),
      ['claude-app', 'claude-cli', 'cursor-app', 'chatgpt-app'],
    );
    for (const s of data.seats) {
      assert.ok(['attached', 'not', 'blocked'].includes(s.attached), JSON.stringify(s));
      assert.ok(['stdio', 'ax', 'none'].includes(s.method), JSON.stringify(s));
    }
    assert.ok(['idle', 'attached', 'waiting', 'blocked'].includes(data.icon));
    assert.match(PAGE, /Claude\.app Cowork/);
    assert.match(PAGE, /Claude Code CLI/);
    assert.match(PAGE, /Cursor/);
    assert.match(PAGE, /ChatGPT/);
    assert.match(PAGE, /id="ax"/);
    assert.match(PAGE, /id="accept"/);
    assert.match(PAGE, /id="edit"/);
    assert.match(PAGE, /fetch\('\/api\/send'/);
    assert.doesNotMatch(PAGE, /test card|testSend|Last token|Last card|Session id/i);
    const control = fs.readFileSync(path.join(REPO, 'lib', 'control.js'), 'utf8');
    assert.match(control, /never --cloud/);
    assert.match(control, /never claude:\/\/cowork\/new/);
    assert.match(control, /never mint/);
    assert.doesNotMatch(PAGE, /--cloud/);
    assert.doesNotMatch(PAGE, /claude:\/\/cowork\/new/);
    assert.doesNotMatch(control, /security dump-keychain|find-generic-password/);
    assert.doesNotMatch(control + PAGE, /Grok\.app|wiki|orchestrator|Agent Wheel/);
  } finally {
    g.server.close();
  }
});

test('test-send on an already-attached ChatGPT seat returns a token and fills the board', async () => {
  const dir = tmpDir('surf-send-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convo ChatGPT App');
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const file = plantCodex(home, project, sid);
  convobus(['seats'], { cwd: dir, env: { HOME: home } });
  convobus(['bind', '--seat', 'chatgpt-app', '--cwd', project], { cwd: dir, env: { HOME: home } });
  const g = await listenGui(dir, 0);
  try {
    const r = await post(g.url + '/api/test-send', {
      seat: 'chatgpt-app',
      cwd: project,
      home,
      argv: [NODE, APPEND, file],
      token: 'CONV-surface1',
      forceTokenBody: true,
    }, g.token);
    assert.ok(r.status === 200 || r.status === 400, r.body);
    const data = JSON.parse(r.body);
    if (data.gate) {
      assert.fail('did not expect gate: ' + JSON.stringify(data));
    }
    assert.ok(data.token && String(data.token).trim(), JSON.stringify(data));
    assert.ok(data.board);
    assert.equal(data.board.lastCard, data.card.id);
    assert.equal(data.board.lastToken, data.token);
    assert.equal(data.board.method, 'stdio');
    assert.ok(data.sessionId === sid || data.board.sessionId === sid || data.sessionId, JSON.stringify(data));
    const argvBlob = JSON.stringify(data);
    assert.doesNotMatch(argvBlob, /--cloud/);
    assert.doesNotMatch(argvBlob, /claude:\/\/cowork\/new/);
    const log = readLog(dir);
    assert.ok(log.some((e) => e.event === 'deliver'));
    assert.ok(!JSON.stringify(log).includes('--cloud'));
  } finally {
    g.server.close();
  }
});

test('new session, new idea, and first-time AX gate Accept/Edit and do not send until Accept', async () => {
  const dir = tmpDir('surf-gate-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convo ChatGPT App');
  const sid = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const file = plantCodex(home, project, sid);
  convobus(['seats'], { cwd: dir, env: { HOME: home } });
  convobus(['bind', '--seat', 'chatgpt-app', '--cwd', project], { cwd: dir, env: { HOME: home } });
  const g = await listenGui(dir, 0);
  try {
    const idea = await post(g.url + '/api/test-send', {
      seat: 'chatgpt-app',
      cwd: project,
      home,
      argv: [NODE, APPEND, file],
      want: 'new idea',
      body: 'new idea',
      token: 'CONV-gate1',
      forceTokenBody: true,
    }, g.token);
    const ideaData = JSON.parse(idea.body);
    assert.ok(ideaData.gate, idea.body);
    assert.equal(ideaData.proceed, false);
    assert.deepEqual(ideaData.gate.choices, ['Accept', 'Edit']);
    assert.equal(ideaData.gate.reason, 'new idea');
    assert.ok(!readLog(dir).some((e) => e.event === 'deliver'), JSON.stringify(readLog(dir)));

    const edited = await post(g.url + '/api/gate', { action: 'edit', pendingId: ideaData.pendingId }, g.token);
    const editedData = JSON.parse(edited.body);
    assert.equal(editedData.proceed, false);
    assert.equal(editedData.edited, true);
    assert.ok(!readLog(dir).some((e) => e.event === 'deliver'));

    const idea2 = await post(g.url + '/api/test-send', {
      seat: 'chatgpt-app',
      cwd: project,
      home,
      argv: [NODE, APPEND, file],
      want: 'new idea',
      body: 'new idea',
      token: 'CONV-gate2',
      forceTokenBody: true,
    }, g.token);
    const idea2Data = JSON.parse(idea2.body);
    assert.ok(idea2Data.gate, idea2.body);
    const accepted = await post(g.url + '/api/gate', { action: 'accept', pendingId: idea2Data.pendingId }, g.token);
    const acc = JSON.parse(accepted.body);
    assert.equal(acc.proceed, true, accepted.body);
    assert.ok(acc.token && String(acc.token).trim(), accepted.body);
    assert.ok(readLog(dir).some((e) => e.event === 'deliver'));

    const ax = await post(g.url + '/api/test-send', {
      seat: 'claude-app',
      method: 'ax',
      want: 'first-time AX',
      argv: [NODE, FIXTURE],
    }, g.token);
    const axData = JSON.parse(ax.body);
    assert.ok(axData.gate, ax.body);
    assert.equal(axData.gate.reason, 'first-time AX');
    assert.equal(axData.proceed, false);

    const fresh = await post(g.url + '/api/test-send', {
      seat: 'claude-app',
      want: 'new session',
    }, g.token);
    const freshData = JSON.parse(fresh.body);
    assert.ok(freshData.gate, fresh.body);
    assert.equal(freshData.gate.reason, 'new session');
    const noMint = await post(g.url + '/api/gate', { action: 'accept', pendingId: freshData.pendingId }, g.token);
    const noMintData = JSON.parse(noMint.body);
    assert.ok(noMintData.error === 'not attached' || noMintData.proceed === false, noMint.body);
    assert.doesNotMatch(noMint.body, /--cloud/);
    assert.doesNotMatch(noMint.body, /claude:\/\/cowork\/new/);
  } finally {
    g.server.close();
  }
});

test('window and menu bar source include the required surfaces and refuse Keychain/--cloud', () => {
  const swift = fs.readFileSync(path.join(REPO, 'lib', 'app-main.swift'), 'utf8');
  const gui = fs.readFileSync(path.join(REPO, 'lib', 'gui.js'), 'utf8');
  const control = fs.readFileSync(path.join(REPO, 'lib', 'control.js'), 'utf8');
  const blob = swift + gui + control;
  assert.match(swift, /statusItem/);
  assert.match(swift, /Open window/);
  assert.match(swift, /Projects/);
  assert.match(swift, /NSButton\(title: "Send"/);
  assert.match(swift, /path: "\/api\/send"/);
  assert.doesNotMatch(swift, /Send test card/i);
  assert.match(swift, /Quit/);
  assert.match(swift, /idle/);
  assert.match(swift, /attached/);
  assert.match(swift, /waiting/);
  assert.match(swift, /blocked/);
  assert.match(swift, /Accessibility/);
  assert.match(PAGE, /id="ax"/);
  assert.doesNotMatch(PAGE, /id="board"|test card|testSend/i);
  assert.doesNotMatch(blob, /find-generic-password|dump-keychain/);
  assert.match(control, /never --cloud/);
  assert.match(control, /never claude:\/\/cowork\/new/);
  assert.match(control, /fast && !allowResolve/);
});
