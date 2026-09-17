'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { convobus, tmpDir, FIXTURE, readLog, REPO, NODE } = require('./helpers');

const APPEND = path.join(REPO, 'scripts', 'fixture-append-jsonl.js');

function writeOld(session, text) {
  fs.writeFileSync(
    session,
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        timestamp: '2026-08-28T00:00:00.000Z',
      }) +
      '\n',
  );
}

test('file-wins does not treat a pre-existing last assistant as the reply', () => {
  const dir = tmpDir('fw-old-');
  convobus(['seats'], { cwd: dir });
  const session = path.join(dir, 'session.jsonl');
  writeOld(session, 'old-assistant-already-in-file');
  const r = convobus(
    [
      'turn',
      '--seat',
      'stdio',
      '--from',
      'human',
      '--body',
      'fresh-prompt',
      '--file-wins',
      '--session-file',
      session,
      '--',
      process.execPath,
      FIXTURE,
    ],
    { cwd: dir },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const card = JSON.parse(r.stdout);
  assert.equal(card.state, 'back');
  assert.ok(card.reply.includes('fresh-prompt'), card.reply);
  assert.ok(!String(card.reply).includes('old-assistant-already-in-file'), card.reply);
});

test('file-wins reply is only bytes appended after the pre-send snapshot', () => {
  const dir = tmpDir('fw-new-');
  convobus(['seats'], { cwd: dir });
  const session = path.join(dir, 'session.jsonl');
  writeOld(session, 'old-assistant-already-in-file');
  const r = convobus(
    [
      'turn',
      '--seat',
      'stdio',
      '--from',
      'human',
      '--body',
      'fresh-prompt',
      '--file-wins',
      '--session-file',
      session,
      '--',
      process.execPath,
      APPEND,
      session,
    ],
    { cwd: dir },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const card = JSON.parse(r.stdout);
  assert.equal(card.state, 'back');
  assert.equal(card.reply, 'after-mark:fresh-prompt');
  assert.ok(!String(card.reply).includes('old-assistant-already-in-file'));
  const staged = readLog(dir).find((e) => e.event === 'stage');
  assert.ok(staged);
  assert.equal(staged.card.id, card.id);
  assert.equal(staged.card.reply, 'after-mark:fresh-prompt');
});

test('claude-app send that does not append does not pick the old last assistant', () => {
  const dir = tmpDir('fw-claude-');
  convobus(['seats'], { cwd: dir });
  const session = path.join(dir, 'session.jsonl');
  writeOld(session, 'old-assistant-already-in-file');
  const r = convobus(
    [
      'turn',
      '--seat',
      'claude-app',
      '--method',
      'stdio',
      '--from',
      'human',
      '--body',
      'hello from convobus',
      '--file-wins',
      '--session-file',
      session,
    ],
    { cwd: dir },
  );
  assert.notEqual(r.status, 0);
  let card;
  try {
    card = JSON.parse(r.stdout);
  } catch {
    card = null;
  }
  if (card) {
    assert.notEqual(card.state, 'back');
    assert.notEqual(card.reply, 'old-assistant-already-in-file');
  }
  const staged = readLog(dir).find((e) => e.event === 'stage');
  assert.ok(!staged || staged.card.reply !== 'old-assistant-already-in-file');
});

test('codex jsonl file-wins is only bytes after the snapshot on the attached session, not a minted file', () => {
  const dir = tmpDir('fw-codex-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const sess = path.join(home, '.codex', 'sessions', '2026', '08', '28');
  fs.mkdirSync(sess, { recursive: true });
  const file = path.join(sess, 'rollout-old.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session_meta', payload: { cwd: project } }) +
      '\n' +
      JSON.stringify({
        type: 'response_item',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'old-codex' }] },
      }) +
      '\n',
  );
  const { snapshotCodexSessions, readAfterCodexSnapshot, extractAssistantText } = require('../lib/methods/filewins');
  assert.equal(
    extractAssistantText({
      type: 'response_item',
      payload: { role: 'assistant', content: [{ type: 'output_text', text: 'PONG-new' }] },
    }),
    'PONG-new',
  );
  const snap = snapshotCodexSessions(home, { cwd: project, attachOnly: true });
  assert.equal(snap.matched, true);
  assert.equal(readAfterCodexSnapshot(snap, home), null);
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'PONG-new' },
    }) + '\n',
  );
  assert.equal(readAfterCodexSnapshot(snap, home), 'PONG-new');
  const neu = path.join(sess, 'rollout-new.jsonl');
  fs.writeFileSync(
    neu,
    JSON.stringify({ type: 'session_meta', payload: { cwd: project } }) +
      '\n' +
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'from-minted-chat' },
      }) +
      '\n',
  );
  assert.equal(readAfterCodexSnapshot(snap, home), 'PONG-new');
});

test('cwd+seat resolver finds the vendor-store session, not a jsonl inside the project', () => {
  const dir = tmpDir('fw-resolve-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo Claude App');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, 'inside.jsonl'),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'from-inside-project' }] },
    }) + '\n',
  );
  const encodings = require('../lib/methods/filewins').claudeProjectEncodings(project);
  const storeDir = path.join(
    home,
    '.claude',
    'projects',
    encodings.find((e) => e.includes('Convobus-test')) || encodings[0],
  );
  fs.mkdirSync(storeDir, { recursive: true });
  const session = path.join(storeDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  writeOld(session, 'old-assistant-already-in-file');
  const { resolveVendorSession, snapshotFile, readAfterSnapshot } = require('../lib/methods/filewins');
  const found = resolveVendorSession('claude-app', project, home);
  assert.ok(found.file, JSON.stringify(found));
  assert.equal(found.file, session);
  assert.ok(!String(found.file).startsWith(project + path.sep), found.file);
  const snap = snapshotFile(found.file);
  assert.equal(readAfterSnapshot(found.file, snap), null);
  fs.appendFileSync(
    session,
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'after-mark:ok' }] },
    }) + '\n',
  );
  assert.equal(readAfterSnapshot(found.file, snap), 'after-mark:ok');
});

test('slash-kept-space encoding is also tried', () => {
  const dir = tmpDir('fw-slash-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo Claude App');
  fs.mkdirSync(project, { recursive: true });
  const { encodeClaudeProject, resolveVendorSession } = require('../lib/methods/filewins');
  const encSlash = encodeClaudeProject(project);
  assert.match(encSlash, /Convobus test projects/);
  const storeDir = path.join(home, '.claude', 'projects', encSlash);
  fs.mkdirSync(storeDir, { recursive: true });
  const session = path.join(storeDir, 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff.jsonl');
  writeOld(session, 'slash-encoding-assistant');
  const found = resolveVendorSession('claude-app', project, home);
  assert.equal(found.file, session);
});

test('cursor-cli resolver finds the CLI project transcript, not Convo Cursor App', () => {
  const dir = tmpDir('fw-cur-cli-');
  const home = path.join(dir, 'home');
  const cliProject = path.join(dir, 'Convobus test projects', 'Convo Cursor CLI');
  const appProject = path.join(dir, 'Convobus test projects', 'Convo Cursor App');
  fs.mkdirSync(cliProject, { recursive: true });
  fs.mkdirSync(appProject, { recursive: true });
  const { cursorProjectEncodings, resolveVendorSession } = require('../lib/methods/filewins');
  const appEnc = cursorProjectEncodings(appProject)[0];
  const cliEnc = cursorProjectEncodings(cliProject)[0];
  const appDir = path.join(home, '.cursor', 'projects', appEnc, 'agent-transcripts', '66293212-2adc-4b56-b4df-4703c1dc14fc');
  const cliDir = path.join(home, '.cursor', 'projects', cliEnc, 'agent-transcripts', '40e423c7-6af1-4c45-9a93-fc1de951f32d');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(cliDir, { recursive: true });
  const appFile = path.join(appDir, '66293212-2adc-4b56-b4df-4703c1dc14fc.jsonl');
  const cliFile = path.join(cliDir, '40e423c7-6af1-4c45-9a93-fc1de951f32d.jsonl');
  fs.writeFileSync(
    appFile,
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'from-app' }] } }) + '\n',
  );
  fs.writeFileSync(
    cliFile,
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'convobus ready' }] } }) + '\n',
  );
  const found = resolveVendorSession('cursor-cli', cliProject, home);
  assert.equal(found.file, cliFile, JSON.stringify(found));
  assert.equal(found.id, '40e423c7-6af1-4c45-9a93-fc1de951f32d');
  assert.notEqual(found.id, '66293212-2adc-4b56-b4df-4703c1dc14fc');
  assert.match(String(found.why), /convobus ready/);
});

test('cursor-app resolver finds agent-transcripts in the vendor store, not under the project', () => {
  const dir = tmpDir('fw-cursor-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo Cursor App');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'inside.jsonl'), '{"role":"assistant","message":{"content":[{"type":"text","text":"from-project"}]}}\n');
  const { cursorProjectEncodings, resolveVendorSession, snapshotFile, readAfterSnapshot } = require('../lib/methods/filewins');
  const enc = cursorProjectEncodings(project).find((e) => e.includes('Convobus-test')) || cursorProjectEncodings(project)[0];
  const storeDir = path.join(home, '.cursor', 'projects', enc, 'agent-transcripts', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  fs.mkdirSync(storeDir, { recursive: true });
  const session = path.join(storeDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  fs.writeFileSync(
    session,
    JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'old-cursor-assistant' }] },
    }) + '\n',
  );
  const found = resolveVendorSession('cursor-app', project, home);
  assert.equal(found.file, session);
  assert.equal(found.id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.ok(!String(found.file).startsWith(project + path.sep));
  const snap = snapshotFile(found.file);
  assert.equal(readAfterSnapshot(found.file, snap), null);
  fs.appendFileSync(
    session,
    JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'after-mark:ok' }] },
    }) + '\n',
  );
  assert.equal(readAfterSnapshot(found.file, snap), 'after-mark:ok');
});

test('unresolved cursor-app lists ~/.cursor/projects look places', () => {
  const dir = tmpDir('fw-cur-miss-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'empty-pick');
  fs.mkdirSync(project, { recursive: true });
  const { resolveVendorSession, formatMissing } = require('../lib/methods/filewins');
  const found = resolveVendorSession('cursor-app', project, home);
  assert.equal(found.file, null);
  assert.ok(found.looked.some((p) => p.includes('.cursor/projects')));
  assert.match(formatMissing(found.looked), /^missing$/m);
});

test('claude-app skipIds of Code jsonl uuid attaches the cowork map', () => {
  const dir = tmpDir('fw-cowork-wake-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convo Claude App');
  fs.mkdirSync(project, { recursive: true });
  const { claudeProjectEncodings, resolveVendorSession } = require('../lib/methods/filewins');
  const enc = claudeProjectEncodings(project)[0];
  const storeDir = path.join(home, '.claude', 'projects', enc);
  fs.mkdirSync(storeDir, { recursive: true });
  const jsonl = path.join(storeDir, 'cb99ed1a-2b03-42b0-8ec9-d0088dead7dc.jsonl');
  writeOld(jsonl, 'convobus ready');
  const mapDir = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'local-agent-mode-sessions',
    'acct',
    'org',
  );
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(
    path.join(mapDir, 'remote-session-spaces.json'),
    JSON.stringify({
      entries: [{ sessionId: 'session_01GJrmfqVoJveULXszaBHCoF', folders: [project] }],
    }),
  );
  const idbDir = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'IndexedDB',
    'https_claude.ai_0.indexeddb.leveldb',
  );
  fs.mkdirSync(idbDir, { recursive: true });
  const idb = path.join(idbDir, '000152.log');
  fs.writeFileSync(idb, 'Claude responded: convobus ready\n');
  const found = resolveVendorSession('claude-app', project, home, {
    skipIds: ['cb99ed1a-2b03-42b0-8ec9-d0088dead7dc'],
  });
  assert.equal(found.id, 'session_01GJrmfqVoJveULXszaBHCoF', JSON.stringify(found));
  assert.equal(found.kind, 'cloud');
  assert.notEqual(found.id, 'cb99ed1a-2b03-42b0-8ec9-d0088dead7dc');
});

test('claude-app skipIds of cowork cloud ids still attaches the Code jsonl', () => {
  const dir = tmpDir('fw-code-wake-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convo Claude App');
  fs.mkdirSync(project, { recursive: true });
  const { claudeProjectEncodings, resolveVendorSession } = require('../lib/methods/filewins');
  const enc = claudeProjectEncodings(project)[0];
  const storeDir = path.join(home, '.claude', 'projects', enc);
  fs.mkdirSync(storeDir, { recursive: true });
  const jsonl = path.join(storeDir, 'cb99ed1a-2b03-42b0-8ec9-d0088dead7dc.jsonl');
  writeOld(jsonl, 'convobus ready');
  const mapDir = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'local-agent-mode-sessions',
    'acct',
    'org',
  );
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(
    path.join(mapDir, 'remote-session-spaces.json'),
    JSON.stringify({
      entries: [{ sessionId: 'session_01GJrmfqVoJveULXszaBHCoF', folders: [project] }],
    }),
  );
  const found = resolveVendorSession('claude-app', project, home, {
    skipIds: ['session_01GJrmfqVoJveULXszaBHCoF'],
  });
  assert.equal(found.file, jsonl, JSON.stringify(found));
  assert.equal(found.id, 'cb99ed1a-2b03-42b0-8ec9-d0088dead7dc');
  assert.notEqual(found.kind, 'cloud');
});

test('claude-app skipIds ignores Code jsonl and Cowork and attaches the claude.ai chat blob', () => {
  const dir = tmpDir('fw-plain-chat-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convo Claude App');
  fs.mkdirSync(project, { recursive: true });
  const { claudeProjectEncodings, resolveVendorSession } = require('../lib/methods/filewins');
  const enc = claudeProjectEncodings(project)[0];
  const storeDir = path.join(home, '.claude', 'projects', enc);
  fs.mkdirSync(storeDir, { recursive: true });
  const jsonl = path.join(storeDir, 'cb99ed1a-2b03-42b0-8ec9-d0088dead7dc.jsonl');
  writeOld(jsonl, 'convobus ready');
  const mapDir = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'local-agent-mode-sessions',
    'acct',
    'org',
  );
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(
    path.join(mapDir, 'remote-session-spaces.json'),
    JSON.stringify({
      entries: [{ sessionId: 'session_01GJrmfqVoJveULXszaBHCoF', folders: [project] }],
    }),
  );
  const blobDir = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'IndexedDB',
    'https_claude.ai_0.indexeddb.blob',
    '1',
    'd5',
  );
  fs.mkdirSync(blobDir, { recursive: true });
  const blob = path.join(blobDir, 'd5d7');
  fs.writeFileSync(
    blob,
    '"uuid"$fb4a4a32-0501-4cff-a9b6-b50df6380ccf"name"Convobus readiness check"summary"reply only convobus ready"',
  );
  const found = resolveVendorSession('claude-app', project, home, {
    skipIds: ['cb99ed1a-2b03-42b0-8ec9-d0088dead7dc', 'session_01GJrmfqVoJveULXszaBHCoF'],
  });
  assert.equal(found.id, 'fb4a4a32-0501-4cff-a9b6-b50df6380ccf', JSON.stringify(found));
  assert.equal(found.file, blob);
  assert.equal(found.kind, 'chat');
  assert.ok(!String(found.file).includes('cb99ed1a'));
  assert.ok(!String(found.id).includes('GJrmfq'));
});

test('claude-app ready Code jsonl wins over cowork IndexedDB for the same cwd', () => {
  const dir = tmpDir('fw-code-pref-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convo Claude App');
  fs.mkdirSync(project, { recursive: true });
  const { claudeProjectEncodings, resolveVendorSession } = require('../lib/methods/filewins');
  const enc = claudeProjectEncodings(project)[0];
  const storeDir = path.join(home, '.claude', 'projects', enc);
  fs.mkdirSync(storeDir, { recursive: true });
  const jsonl = path.join(storeDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  writeOld(jsonl, 'convobus ready');
  const mapDir = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'local-agent-mode-sessions',
    'acct',
    'org',
  );
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(
    path.join(mapDir, 'remote-session-spaces.json'),
    JSON.stringify({
      entries: [
        {
          sessionId: 'session_01GJrmfqVoJveULXszaBHCoF',
          spaceId: 'c36c41bb-c8d6-4032-b18e-5ff7426b91b4',
          folders: [project],
        },
      ],
    }),
  );
  const idbDir = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'IndexedDB',
    'https_claude.ai_0.indexeddb.leveldb',
  );
  fs.mkdirSync(idbDir, { recursive: true });
  const idb = path.join(idbDir, '000152.log');
  fs.writeFileSync(idb, 'Claude responded: convobus ready\n');
  const app = resolveVendorSession('claude-app', project, home);
  assert.equal(app.file, jsonl, JSON.stringify(app));
  assert.notEqual(app.id, 'session_01GJrmfqVoJveULXszaBHCoF');
  assert.ok(!String(app.file).includes('IndexedDB'), app.file);
  assert.match(String(app.why), /convobus ready/);
  const cli = resolveVendorSession('claude-cli', project, home);
  assert.equal(cli.file, jsonl, JSON.stringify(cli));
});

test('claude-app cowork map in Application Support resolves the session id', () => {
  const dir = tmpDir('fw-map-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convo Claude App');
  fs.mkdirSync(project, { recursive: true });
  const mapDir = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'local-agent-mode-sessions',
    'acct',
    'org',
  );
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(
    path.join(mapDir, 'remote-session-spaces.json'),
    JSON.stringify({
      entries: [
        {
          sessionId: 'session_01GJrmfqVoJveULXszaBHCoF',
          spaceId: 'c36c41bb-c8d6-4032-b18e-5ff7426b91b4',
          folders: [project],
        },
      ],
    }),
  );
  const { resolveVendorSession } = require('../lib/methods/filewins');
  const found = resolveVendorSession('claude-app', project, home);
  assert.equal(found.id, 'session_01GJrmfqVoJveULXszaBHCoF');
  assert.ok(!found.file || !String(found.file).startsWith(project + path.sep));
});

test('claude-app IndexedDB file-wins is only Claude responded after the snapshot', () => {
  const dir = tmpDir('fw-idb-');
  const home = path.join(dir, 'home');
  const idb = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'IndexedDB',
    'https_claude.ai_0.indexeddb.leveldb',
  );
  fs.mkdirSync(idb, { recursive: true });
  const file = path.join(idb, '000148.log');
  fs.writeFileSync(file, 'Claude responded: OLD-REPLY\n');
  const { snapshotClaudeIdb, readAfterClaudeIdb } = require('../lib/methods/filewins');
  const snap = snapshotClaudeIdb(home);
  assert.equal(readAfterClaudeIdb(snap), null);
  fs.appendFileSync(file, 'Claude responded: after-mark:ok\n');
  assert.equal(readAfterClaudeIdb(snap), 'after-mark:ok');
  const neu = path.join(idb, '000152.log');
  fs.writeFileSync(neu, 'Claude responded: from-rotated-log\n');
  assert.equal(readAfterClaudeIdb(snap), 'from-rotated-log');
});

test('unresolved vendor session lists the places looked', () => {
  const dir = tmpDir('fw-look-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'empty-pick');
  fs.mkdirSync(project, { recursive: true });
  const { resolveVendorSession, formatMissing } = require('../lib/methods/filewins');
  const found = resolveVendorSession('claude-app', project, home);
  assert.equal(found.file, null);
  assert.equal(found.id, null);
  assert.ok(found.looked.length);
  assert.ok(found.looked.some((p) => p.includes('.claude/projects')));
  assert.ok(found.looked.some((p) => p.includes('Application Support')));
  const text = formatMissing(found.looked);
  assert.match(text, /^missing$/m);
  assert.match(text, /Application Support/);
});

test('codex attach matches session_meta cwd even when the first jsonl line is long', () => {
  const dir = tmpDir('fw-cwd-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const sess = path.join(home, '.codex', 'sessions', '2026', '08', '28');
  fs.mkdirSync(sess, { recursive: true });
  const file = path.join(sess, 'rollout-long.jsonl');
  const pad = 'x'.repeat(20000);
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'session_meta',
      payload: { cwd: project, pad, session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    }) + '\n',
  );
  const { snapshotCodexSessions } = require('../lib/methods/filewins');
  const snap = snapshotCodexSessions(home, { cwd: project, attachOnly: true });
  assert.equal(snap.matched, true);
  assert.ok(snap.files[file]);
  const { existingCodexSession } = require('../lib/methods/filewins');
  const found = existingCodexSession(home, project);
  assert.ok(found);
  assert.equal(found.file, file);
  assert.equal(found.id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('chatgpt-cli resolver finds the Codex vendor-store jsonl, not a file inside the project', () => {
  const dir = tmpDir('fw-cc-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo ChatGPT CLI');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'inside.jsonl'), '{"type":"assistant","content":"from-project"}\n');
  const sess = path.join(home, '.codex', 'sessions', '2026', '08', '28');
  fs.mkdirSync(sess, { recursive: true });
  const file = path.join(sess, 'rollout-cli.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'session_meta',
      payload: { cwd: project, session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    }) +
      '\n' +
      JSON.stringify({
        type: 'response_item',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'old-cli' }] },
      }) +
      '\n',
  );
  const { resolveVendorSession, snapshotFile, readAfterSnapshot } = require('../lib/methods/filewins');
  const found = resolveVendorSession('chatgpt-cli', project, home);
  assert.equal(found.file, file);
  assert.equal(found.id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.ok(!String(found.file).startsWith(project + path.sep), found.file);
  const snap = snapshotFile(found.file);
  assert.equal(readAfterSnapshot(found.file, snap), null);
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'after-mark:ok' },
    }) + '\n',
  );
  assert.equal(readAfterSnapshot(found.file, snap), 'after-mark:ok');
});

test('unresolved chatgpt-cli lists ~/.codex/sessions look places', () => {
  const dir = tmpDir('fw-cc-miss-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'empty-pick');
  fs.mkdirSync(project, { recursive: true });
  const { resolveVendorSession, formatMissing } = require('../lib/methods/filewins');
  const found = resolveVendorSession('chatgpt-cli', project, home);
  assert.equal(found.file, null);
  assert.ok(found.looked.some((p) => p.includes('.codex/sessions')));
  assert.match(formatMissing(found.looked), /^missing$/m);
  assert.match(formatMissing(found.looked), /\.codex\/sessions/);
});

test('grok-cli resolver finds chat_history.jsonl in the percent-encoded vendor store, not the project', () => {
  const dir = tmpDir('fw-grok-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo Grok CLI');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'inside.jsonl'), '{"type":"assistant","content":"from-project"}\n');
  const { grokProjectEncodings, resolveVendorSession, snapshotFile, readAfterSnapshot, extractAssistantText } =
    require('../lib/methods/filewins');
  assert.equal(extractAssistantText({ type: 'assistant', content: 'GROK-token' }), 'GROK-token');
  const encs = grokProjectEncodings(project);
  assert.ok(encs.some((e) => e.includes('%2F') && e.includes('Convo')));
  assert.ok(encs.some((e) => e.includes('%20')) || encs.some((e) => e.includes('+')));
  const storeDir = path.join(home, '.grok', 'sessions', encs[0], 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  fs.mkdirSync(storeDir, { recursive: true });
  const file = path.join(storeDir, 'chat_history.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'hello' }] }) +
      '\n' +
      JSON.stringify({ type: 'assistant', content: 'old-grok-assistant' }) +
      '\n',
  );
  const found = resolveVendorSession('grok-cli', project, home);
  assert.equal(found.file, file);
  assert.equal(found.id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.ok(!String(found.file).startsWith(project + path.sep), found.file);
  const snap = snapshotFile(found.file);
  assert.equal(readAfterSnapshot(found.file, snap), null);
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', content: 'after-mark:ok' }) + '\n');
  assert.equal(readAfterSnapshot(found.file, snap), 'after-mark:ok');
});

test('grok-cli plus-space encoding is also tried', () => {
  const dir = tmpDir('fw-grok-plus-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo Grok CLI');
  fs.mkdirSync(project, { recursive: true });
  const { grokProjectEncodings, resolveVendorSession } = require('../lib/methods/filewins');
  const plus = grokProjectEncodings(project).find((e) => e.includes('+'));
  assert.ok(plus, grokProjectEncodings(project).join(','));
  const storeDir = path.join(home, '.grok', 'sessions', plus, 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
  fs.mkdirSync(storeDir, { recursive: true });
  const file = path.join(storeDir, 'chat_history.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', content: 'plus-encoding-assistant' }) + '\n');
  const found = resolveVendorSession('grok-cli', project, home);
  assert.equal(found.file, file);
});

test('unresolved grok-cli lists ~/.grok/sessions look places', () => {
  const dir = tmpDir('fw-grok-miss-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'empty-pick');
  fs.mkdirSync(project, { recursive: true });
  const { resolveVendorSession, formatMissing } = require('../lib/methods/filewins');
  const found = resolveVendorSession('grok-cli', project, home);
  assert.equal(found.file, null);
  assert.ok(found.looked.some((p) => p.includes('.grok/sessions')));
  const text = formatMissing(found.looked);
  assert.match(text, /^missing$/m);
  assert.match(text, /\.grok\/sessions/);
});

test('chatgpt-cli turn attach writes the vendor-store session path into log.ndjson', () => {
  const dir = tmpDir('fw-cc-turn-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convo ChatGPT CLI');
  fs.mkdirSync(project, { recursive: true });
  const sess = path.join(home, '.codex', 'sessions', '2026', '08', '28');
  fs.mkdirSync(sess, { recursive: true });
  const file = path.join(sess, 'rollout-attach.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'session_meta',
      payload: { cwd: project, session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    }) + '\n',
  );
  const env = { HOME: home };
  convobus(['seats'], { cwd: dir, env });
  convobus(['bind', '--seat', 'chatgpt-cli', '--cwd', project], { cwd: dir, env });
  const r = convobus(
    ['turn', '--seat', 'chatgpt-cli', '--from', 'human', '--body', 'ping-cli', '--', NODE, APPEND, file],
    { cwd: dir, env },
  );
  assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || '') + ' status=' + r.status);
  const attach = readLog(dir).find((e) => e.event === 'attach');
  assert.ok(attach, JSON.stringify(readLog(dir)));
  assert.equal(attach.sessionFile, file);
  assert.equal(attach.sessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.ok(!String(attach.sessionFile).startsWith(project + path.sep));
});

test('grok-cli turn attach writes the vendor-store chat_history path into log.ndjson', () => {
  const dir = tmpDir('fw-grok-turn-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convo Grok CLI');
  fs.mkdirSync(project, { recursive: true });
  const { grokProjectEncodings } = require('../lib/methods/filewins');
  const enc = grokProjectEncodings(project)[0];
  const storeDir = path.join(home, '.grok', 'sessions', enc, 'cccccccc-dddd-eeee-ffff-000000000000');
  fs.mkdirSync(storeDir, { recursive: true });
  const file = path.join(storeDir, 'chat_history.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', content: 'old' }) + '\n');
  const env = { HOME: home };
  convobus(['seats'], { cwd: dir, env });
  convobus(['bind', '--seat', 'grok-cli', '--cwd', project], { cwd: dir, env });
  const r = convobus(
    ['turn', '--seat', 'grok-cli', '--from', 'human', '--body', 'ping-grok', '--', NODE, FIXTURE],
    { cwd: dir, env },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const attach = readLog(dir).find((e) => e.event === 'attach');
  assert.ok(attach, JSON.stringify(readLog(dir)));
  assert.equal(attach.sessionFile, file);
  assert.equal(attach.sessionId, 'cccccccc-dddd-eeee-ffff-000000000000');
  assert.ok(!String(attach.sessionFile).startsWith(project + path.sep));
});

test('claude-app and claude-cli both try slash-kept-space and dash encodings', () => {
  const dir = tmpDir('fw-claude-both-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo Claude CLI');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, 'inside.jsonl'),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'from-inside-project' }] },
    }) + '\n',
  );
  const { claudeProjectEncodings, resolveVendorSession } = require('../lib/methods/filewins');
  const encs = claudeProjectEncodings(project);
  assert.ok(encs.length >= 2, JSON.stringify(encs));
  const slash = encs.find((e) => e.includes(' '));
  const dash = encs.find((e) => e.includes('Convobus-test-projects'));
  assert.ok(slash && dash && slash !== dash, JSON.stringify(encs));
  fs.mkdirSync(path.join(home, '.claude', 'projects', slash), { recursive: true });
  const storeDir = path.join(home, '.claude', 'projects', dash);
  fs.mkdirSync(storeDir, { recursive: true });
  const session = path.join(storeDir, 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb.jsonl');
  writeOld(session, 'dash-encoding-assistant');
  for (const seat of ['claude-app', 'claude-cli']) {
    const found = resolveVendorSession(seat, project, home);
    assert.equal(found.file, session, seat + ' ' + JSON.stringify(found));
    assert.ok(!String(found.file).startsWith(project + path.sep), found.file);
  }
});

test('unresolved claude-cli missing lists both project encodings plus Application Support', () => {
  const dir = tmpDir('fw-cli-miss-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo Claude CLI');
  fs.mkdirSync(project, { recursive: true });
  const { claudeProjectEncodings, resolveVendorSession, formatMissing } = require('../lib/methods/filewins');
  const encs = claudeProjectEncodings(project);
  const found = resolveVendorSession('claude-cli', project, home);
  assert.equal(found.file, null);
  assert.equal(found.id, null);
  for (const enc of encs) {
    assert.ok(
      found.looked.some((p) => p.endsWith(enc) || p.includes(enc)),
      enc + ' not in ' + JSON.stringify(found.looked),
    );
  }
  assert.ok(found.looked.some((p) => p.includes('Application Support')));
  assert.ok(found.looked.some((p) => p.includes('.claude.json')));
  assert.ok(found.looked.some((p) => p.includes(path.join('.claude', 'sessions'))));
  assert.ok(found.looked.some((p) => p.includes('indexeddb.blob') || p.includes('IndexedDB')));
  assert.ok(found.looked.some((p) => p.includes('Local Storage')));
  const text = formatMissing(found.looked);
  assert.match(text, /^missing$/m);
  assert.match(text, /Application Support/);
  assert.match(text, /\.claude\/sessions/);
});

test('claude-cli live ~/.claude/sessions row without a jsonl is missing and does not mint', () => {
  const dir = tmpDir('fw-cli-live-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo Claude CLI');
  fs.mkdirSync(project, { recursive: true });
  const sessDir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessDir, '81926.json'),
    JSON.stringify({
      pid: 81926,
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: project,
      entrypoint: 'cli',
    }),
  );
  const { resolveVendorSession } = require('../lib/methods/filewins');
  const found = resolveVendorSession('claude-cli', project, home);
  assert.equal(found.file, null);
  assert.equal(found.id, null);
});

test('cursor-app space-kept encoding is also tried', () => {
  const dir = tmpDir('fw-cur-space-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo Cursor App');
  fs.mkdirSync(project, { recursive: true });
  const { cursorProjectEncodings, resolveVendorSession } = require('../lib/methods/filewins');
  const encs = cursorProjectEncodings(project);
  assert.ok(encs.length >= 2, JSON.stringify(encs));
  const spacey = encs.find((e) => e.includes(' '));
  assert.ok(spacey, JSON.stringify(encs));
  const storeDir = path.join(home, '.cursor', 'projects', spacey, 'agent-transcripts', 'eeeeeeee-ffff-aaaa-bbbb-cccccccccccc');
  fs.mkdirSync(storeDir, { recursive: true });
  const session = path.join(storeDir, 'eeeeeeee-ffff-aaaa-bbbb-cccccccccccc.jsonl');
  fs.writeFileSync(
    session,
    JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'space-encoding-assistant' }] },
    }) + '\n',
  );
  const found = resolveVendorSession('cursor-app', project, home);
  assert.equal(found.file, session);
  assert.ok(!String(found.file).startsWith(project + path.sep));
});

test('chatgpt-app resolver finds the Codex vendor-store jsonl, not a file inside the project', () => {
  const dir = tmpDir('fw-ca-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo ChatGPT App');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'inside.jsonl'), '{"type":"assistant","content":"from-project"}\n');
  const sess = path.join(home, '.codex', 'sessions', '2026', '08', '28');
  fs.mkdirSync(sess, { recursive: true });
  const file = path.join(sess, 'rollout-app.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'session_meta',
      payload: { cwd: project, session_id: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd' },
    }) +
      '\n' +
      JSON.stringify({
        type: 'response_item',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'old-app' }] },
      }) +
      '\n',
  );
  const { resolveVendorSession, snapshotFile, readAfterSnapshot } = require('../lib/methods/filewins');
  const found = resolveVendorSession('chatgpt-app', project, home);
  assert.equal(found.file, file);
  assert.equal(found.id, 'ffffffff-aaaa-bbbb-cccc-dddddddddddd');
  assert.ok(!String(found.file).startsWith(project + path.sep), found.file);
  const snap = snapshotFile(found.file);
  assert.equal(readAfterSnapshot(found.file, snap), null);
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'after-mark:ok' },
    }) + '\n',
  );
  assert.equal(readAfterSnapshot(found.file, snap), 'after-mark:ok');
});

test('when several cwd files match, the newest containing convobus ready wins', () => {
  const dir = tmpDir('fw-ready-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo Grok CLI');
  fs.mkdirSync(project, { recursive: true });
  const { grokProjectEncodings, resolveVendorSession, READY_LINE } = require('../lib/methods/filewins');
  const enc = grokProjectEncodings(project)[0];
  const olderId = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
  const newerId = 'bbbbbbbb-cccc-dddd-eeee-222222222222';
  const olderDir = path.join(home, '.grok', 'sessions', enc, olderId);
  const newerDir = path.join(home, '.grok', 'sessions', enc, newerId);
  fs.mkdirSync(olderDir, { recursive: true });
  fs.mkdirSync(newerDir, { recursive: true });
  const older = path.join(olderDir, 'chat_history.jsonl');
  const newer = path.join(newerDir, 'chat_history.jsonl');
  fs.writeFileSync(
    older,
    JSON.stringify({ type: 'user', content: 'Hi Grok, reply only: "convobus ready"' }) +
      '\n' +
      JSON.stringify({ type: 'assistant', content: READY_LINE }) +
      '\n',
  );
  const then = Date.now() - 60_000;
  fs.utimesSync(older, then / 1000, then / 1000);
  fs.writeFileSync(newer, JSON.stringify({ type: 'assistant', content: 'later-a2a-not-ready' }) + '\n');
  const found = resolveVendorSession('grok-cli', project, home);
  assert.equal(found.file, older, JSON.stringify(found));
  assert.equal(found.id, olderId);
  assert.match(String(found.why), /convobus ready/);
  assert.ok(!String(found.file).startsWith(project + path.sep));
});

test('when two ready files match, the newest ready file wins', () => {
  const dir = tmpDir('fw-ready-new-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo Claude App');
  fs.mkdirSync(project, { recursive: true });
  const { claudeProjectEncodings, resolveVendorSession } = require('../lib/methods/filewins');
  const enc = claudeProjectEncodings(project).find((e) => e.includes('Convobus-test')) || claudeProjectEncodings(project)[0];
  const storeDir = path.join(home, '.claude', 'projects', enc);
  fs.mkdirSync(storeDir, { recursive: true });
  const oldReady = path.join(storeDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  const newReady = path.join(storeDir, 'ffffffff-aaaa-bbbb-cccc-dddddddddddd.jsonl');
  writeOld(oldReady, 'convobus ready');
  const then = Date.now() - 60_000;
  fs.utimesSync(oldReady, then / 1000, then / 1000);
  writeOld(newReady, 'convobus ready');
  const found = resolveVendorSession('claude-app', project, home);
  assert.equal(found.file, newReady, JSON.stringify(found));
  assert.match(String(found.why), /convobus ready/);
});

test('chatgpt resolver prefers the ready Codex jsonl over a newer cwd match without it', () => {
  const dir = tmpDir('fw-ready-cx-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'Convobus test projects', 'Convo ChatGPT App');
  fs.mkdirSync(project, { recursive: true });
  const sess = path.join(home, '.codex', 'sessions', '2026', '08', '29');
  fs.mkdirSync(sess, { recursive: true });
  const readyFile = path.join(sess, 'rollout-ready.jsonl');
  const laterFile = path.join(sess, 'rollout-later.jsonl');
  fs.writeFileSync(
    readyFile,
    JSON.stringify({
      type: 'session_meta',
      payload: { cwd: project, session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    }) +
      '\n' +
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'convobus ready' },
      }) +
      '\n',
  );
  const then = Date.now() - 60_000;
  fs.utimesSync(readyFile, then / 1000, then / 1000);
  fs.writeFileSync(
    laterFile,
    JSON.stringify({
      type: 'session_meta',
      payload: { cwd: project, session_id: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd' },
    }) +
      '\n' +
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'not-the-primed-chat' },
      }) +
      '\n',
  );
  const { resolveVendorSession, chatgptLookPlaces } = require('../lib/methods/filewins');
  const found = resolveVendorSession('chatgpt-app', project, home);
  assert.equal(found.file, readyFile, JSON.stringify(found));
  assert.equal(found.id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.match(String(found.why), /convobus ready/);
  const looked = chatgptLookPlaces(home);
  assert.ok(looked.some((p) => p.includes('.codex/sessions')));
  assert.ok(looked.some((p) => p.includes('com.openai.chat')));
});

test('unresolved chatgpt-app lists ~/.codex/sessions look places', () => {
  const dir = tmpDir('fw-ca-miss-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'empty-pick');
  fs.mkdirSync(project, { recursive: true });
  const { resolveVendorSession, formatMissing } = require('../lib/methods/filewins');
  const found = resolveVendorSession('chatgpt-app', project, home);
  assert.equal(found.file, null);
  assert.ok(found.looked.some((p) => p.includes('.codex/sessions')));
  assert.match(formatMissing(found.looked), /^missing$/m);
});

test('exact Codex snapshot ignores a sibling session with the same cwd', () => {
  const root = tmpDir('fw-codex-exact-');
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const dir = path.join(home, '.codex', 'sessions', '2026', '08', '31');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const selected = path.join(dir, 'selected.jsonl');
  const sibling = path.join(dir, 'sibling.jsonl');
  for (const [file, id] of [[selected, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'], [sibling, 'ffffffff-1111-2222-3333-444444444444']]) {
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { cwd: project, session_id: id } }) + '\n');
  }
  const { snapshotCodexSessions, readAfterCodexSnapshot } = require('../lib/methods/filewins');
  const snap = snapshotCodexSessions(home, { cwd: project, sessionFile: selected });
  fs.appendFileSync(sibling, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'wrong sibling' } }) + '\n');
  assert.equal(readAfterCodexSnapshot(snap, home), null);
  fs.appendFileSync(selected, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'selected reply' } }) + '\n');
  assert.equal(readAfterCodexSnapshot(snap, home), 'selected reply');
});

test('exact Claude snapshot ignores a sibling project transcript', () => {
  const root = tmpDir('fw-claude-exact-');
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const encoded = project.replace(/\//g, '-');
  const dir = path.join(home, '.claude', 'projects', encoded);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const selected = path.join(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  const sibling = path.join(dir, 'ffffffff-1111-2222-3333-444444444444.jsonl');
  fs.writeFileSync(selected, '');
  fs.writeFileSync(sibling, '');
  const { snapshotClaudeProjects, readAfterClaudeSnapshot } = require('../lib/methods/filewins');
  const snap = snapshotClaudeProjects(home, project, {
    sessionFile: selected,
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });
  fs.appendFileSync(sibling, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'wrong sibling' } }) + '\n');
  assert.equal(readAfterClaudeSnapshot(snap, home, snap.sessionId), null);
  fs.appendFileSync(selected, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'selected reply' } }) + '\n');
  assert.equal(readAfterClaudeSnapshot(snap, home, snap.sessionId), 'selected reply');
});

test('Cowork LevelDB capture requires the selected session id in appended bytes', () => {
  const root = tmpDir('fw-cowork-provenance-');
  const home = path.join(root, 'home');
  const dir = path.join(home, 'Library', 'Application Support', 'Claude', 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '000001.log');
  fs.writeFileSync(file, 'before\n');
  const { snapshotClaudeIdb, readAfterClaudeIdb } = require('../lib/methods/filewins');
  const selectedId = 'session_selected123';
  const snap = snapshotClaudeIdb(home, selectedId);
  fs.appendFileSync(file, 'session_other Claude responded: wrong sibling\n');
  assert.equal(readAfterClaudeIdb(snap), null);
  fs.appendFileSync(file, `${selectedId} Claude responded: selected cowork reply\n`);
  assert.equal(readAfterClaudeIdb(snap), 'selected cowork reply');
});

test('readiness scanning uses the bounded tail and rejects distant Claude UUIDs', () => {
  const root = tmpDir('fw-ready-tail-');
  const file = path.join(root, 'large-store.log');
  const far = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  fs.writeFileSync(file, far + Buffer.alloc(9 * 1024 * 1024, 120).toString() + ' convobus ready ');
  const { fileContainsReady, extractChatUuidNearReady } = require('../lib/methods/filewins');
  assert.equal(fileContainsReady(file), true);
  assert.equal(extractChatUuidNearReady(file), null);
  fs.appendFileSync(file, ' bbbbbbbb-cccc-dddd-eeee-ffffffffffff convobus ready');
  assert.equal(extractChatUuidNearReady(file), 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
});

test('Cursor selected-agent lookup uses embedded node:sqlite with no Python', () => {
  const root = tmpDir('fw-cursor-sqlite-');
  const home = path.join(root, 'home');
  const storage = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  fs.mkdirSync(storage, { recursive: true });
  const database = path.join(storage, 'state.vscdb');
  const emitWarning = process.emitWarning;
  let DatabaseSync;
  try {
    process.emitWarning = () => {};
    ({ DatabaseSync } = require('node:sqlite'));
  } finally {
    process.emitWarning = emitWarning;
  }
  const db = new DatabaseSync(database);
  db.exec('create table ItemTable (key text primary key, value text)');
  db.prepare('insert into ItemTable (key, value) values (?, ?)').run(
    'cursor/glass.selectedAgent',
    '12345678-1234-1234-1234-123456789abc',
  );
  db.close();
  const { cursorSelectedAgentId } = require('../lib/methods/filewins');
  assert.equal(cursorSelectedAgentId(home), '12345678-1234-1234-1234-123456789abc');
  assert.doesNotMatch(fs.readFileSync(path.join(REPO, 'lib', 'methods', 'filewins.js'), 'utf8'), /spawnSync\(\s*['"]python3/);
});

test('an explicitly selected session is never replaced by a discoverable sibling', async () => {
  const root = tmpDir('fw-selected-dispatch-');
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const encoded = project.replace(/\//g, '-');
  const sessionDir = path.join(home, '.claude', 'projects', encoded);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
    JSON.stringify({ cwd: project, type: 'user', message: { content: 'convobus ready' } }) + '\n',
  );
  const { dispatchSend } = require('../lib/turn');
  const result = await dispatchSend(
    root,
    { seat: 'claude-cli', method: 'stdio', body: 'exact', state: 'waiting' },
    { cwd: project, home, sessionId: 'not-the-selected-session' },
  );
  assert.equal(result.miss, true);
  assert.equal(result.reason, 'missing');
});
