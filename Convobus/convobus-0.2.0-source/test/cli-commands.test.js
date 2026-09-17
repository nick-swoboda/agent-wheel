'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { convobus, tmpDir, FIXTURE, readJson, readLog, REPO } = require('./helpers');
const { USAGE, parseArgv } = require('../lib/cli');

const COMMANDS = ['seats', 'loop', 'inflight', 'reply', 'next', 'check', 'stage', 'turn', 'bind'];

test('global --root before the command selects the project', () => {
  const dir = tmpDir('rootflag-');
  const r = convobus(['--root', dir, 'seats']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /\bgrok-cli\b/);
});

test('global root parsing stops at the child-command delimiter', () => {
  const parsed = parseArgv([
    process.execPath,
    'convobus',
    'turn',
    '--seat',
    'stdio',
    '--',
    'tool',
    '--root',
    'child-root',
    'tail',
  ]);
  assert.equal(parsed.flags.root, undefined);
  assert.deepEqual(parsed.argvRest, ['tool', '--root', 'child-root', 'tail']);
});

test('global --root= form and child arguments remain exact', () => {
  const childArguments = ['tool', '--root=child-root', 'two words', '$literal', 'λ'];
  const parsed = parseArgv([
    process.execPath,
    'convobus',
    '--root=/selected/root',
    'turn',
    '--seat=stdio',
    '--',
    ...childArguments,
  ]);
  assert.equal(parsed.flags.root, '/selected/root');
  assert.deepEqual(parsed.argvRest, childArguments);
});

test('check --reply is boolean and does not consume its positional reply', () => {
  const dir = tmpDir('check-reply-flag-');
  const result = convobus(['check', '--reply', 'hello'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stdout, /empty reply/);
});

test('stage --reply remains a valued flag', () => {
  const parsed = parseArgv([process.execPath, 'convobus', 'stage', '--reply', 'exact reply']);
  assert.equal(parsed.flags.reply, 'exact reply');
  assert.deepEqual(parsed.positional, []);
});

test('bundled help is side-effect free for a nonexistent root', () => {
  const parent = tmpDir('bundled-help-root-');
  const missing = path.join(parent, 'not-created');
  const executable = path.join(REPO, 'app', 'Convobus.app', 'Contents', 'MacOS', 'Convobus');
  const result = spawnSync(executable, ['--root', missing, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, USAGE);
  assert.equal(fs.existsSync(missing), false);
});

test('usage names every command', () => {
  const r = convobus(['--help']);
  assert.equal(r.status, 0);
  for (const c of COMMANDS) {
    assert.match(r.stdout, new RegExp('\\b' + c + '\\b'));
    assert.match(USAGE, new RegExp('\\b' + c + '\\b'));
  }
});

test('card out → waiting → back with reply filled via real CLI', () => {
  const dir = tmpDir('card-');
  const seats = convobus(['seats'], { cwd: dir });
  assert.equal(seats.status, 0);
  const next = convobus(
    ['next', '--seat', 'stdio', '--method', 'stdio', '--from', 'human', '--body', 'hello-card'],
    { cwd: dir },
  );
  assert.equal(next.status, 0);
  const card = JSON.parse(next.stdout);
  assert.equal(card.state, 'out');
  assert.equal(card.reply, null);
  assert.equal(card.seat, 'stdio');
  assert.equal(card.method, 'stdio');
  assert.equal(card.from, 'human');
  assert.match(card.id, /^card_/);
  const stored = readJson(dir, 'next.json');
  assert.equal(stored.id, card.id);
  assert.equal(stored.state, 'out');

  const turn = convobus(['turn', '--id', card.id, '--', process.execPath, FIXTURE], { cwd: dir });
  assert.equal(turn.status, 0, turn.stderr + turn.stdout);
  const back = JSON.parse(turn.stdout);
  assert.equal(back.id, card.id);
  assert.equal(back.state, 'back');
  assert.ok(back.reply && back.reply.includes('hello-card'), back.reply);
  const log = readLog(dir);
  const events = log.map((e) => e.event);
  assert.ok(events.includes('deliver'));
  assert.ok(events.includes('send'));
  assert.ok(events.includes('reply'));
  assert.ok(events.includes('stage'));
  const staged = log.find((e) => e.event === 'stage');
  assert.equal(staged.card.id, card.id);
  assert.equal(staged.card.state, 'back');
});

test('reply then stage fill the same card id; next parses seat/method address', () => {
  const dir = tmpDir('reply-');
  convobus(['seats'], { cwd: dir });
  const next = convobus(
    [
      'next',
      '--from',
      'human',
      '--body',
      '[[seat::human]] by [[method::stdio]] please sit',
    ],
    { cwd: dir },
  );
  assert.equal(next.status, 0, next.stdout);
  const card = JSON.parse(next.stdout);
  assert.equal(card.seat, 'human');
  assert.equal(card.method, 'stdio');
  assert.match(card.body, /please sit/);
  const held = convobus(['turn', '--id', card.id], { cwd: dir });
  assert.equal(JSON.parse(held.stdout).state, 'waiting');
  const reply = convobus(['reply', '--id', card.id, '--stdin'], {
    cwd: dir,
    input: 'typed-in-the-middle',
  });
  assert.equal(reply.status, 0, reply.stdout);
  assert.equal(JSON.parse(reply.stdout).reply, 'typed-in-the-middle');
  const staged = convobus(['stage', '--id', card.id], { cwd: dir });
  assert.equal(staged.status, 0, staged.stdout);
  const back = JSON.parse(staged.stdout);
  assert.equal(back.id, card.id);
  assert.equal(back.state, 'back');
  assert.equal(back.reply, 'typed-in-the-middle');
  const inflight = convobus(['inflight'], { cwd: dir });
  assert.match(inflight.stdout, /\(none\)/);
});
