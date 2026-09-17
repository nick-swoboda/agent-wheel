'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { convobus, tmpDir, FIXTURE, readLog, readJson, writePlan, minGraph } = require('./helpers');
const { gateReason } = require('../lib/control');

test('a named leaf with no try triggers the new-idea gate through Map values', () => {
  const dir = tmpDir('gate-map-values-');
  writePlan(dir, minGraph());
  const reason = gateReason(
    dir,
    { body: 'Please continue a-leaf.' },
    { attached: 'attached', method: 'stdio' },
    { axAccepted: true },
  );
  assert.equal(reason, 'new idea');
});

test('check exit 2 does not deliver; empty body never stages', () => {
  const dir = tmpDir('gate-');
  convobus(['seats'], { cwd: dir });
  const empty = convobus(
    ['turn', '--seat', 'stdio', '--from', 'human', '--', process.execPath, FIXTURE],
    { cwd: dir },
  );
  assert.equal(empty.status, 2, empty.stdout);
  assert.match(empty.stdout, /stop — empty body/);
  const log = readLog(dir);
  assert.ok(!log.some((e) => e.event === 'deliver'), JSON.stringify(log));
  assert.equal(log.filter((e) => e.event === 'stage').length, 0);
});

test('discovered-missing seat never check-oks and is not delivered', () => {
  const dir = tmpDir('miss-');
  const isolatedHome = tmpDir('home-miss-');
  const env = { PATH: '/usr/bin:/bin', HOME: isolatedHome };
  const seats = convobus(['seats'], { cwd: dir, env });
  assert.match(seats.stdout, /claude-cli[\s\S]*missing|missing[\s\S]*claude-cli/);
  const chk = convobus(['check', '--stdin'], {
    cwd: dir,
    env,
    input: JSON.stringify({
      id: 'card_miss',
      seat: 'claude-cli',
      method: 'stdio',
      from: 'human',
      body: 'hello missing seat',
      state: 'out',
      reply: null,
    }),
  });
  assert.equal(chk.status, 2, chk.stdout);
  assert.match(chk.stdout, /stop — seat missing/);
  assert.doesNotMatch(chk.stdout, /^ok —/);
  const turn = convobus(
    ['turn', '--seat', 'claude-cli', '--from', 'human', '--body', 'hello missing seat'],
    { cwd: dir, env },
  );
  assert.equal(turn.status, 2);
  assert.ok(!readLog(dir).some((e) => e.event === 'deliver' && e.card && e.card.seat === 'claude-cli'));
});

test('empty directory refuses and the vendor seat stays open', () => {
  const dir = tmpDir('empty-cwd-');
  convobus(['seats'], { cwd: dir });
  const chk = convobus(['check', '--stdin'], {
    cwd: dir,
    input: JSON.stringify({
      id: 'card_nodir',
      seat: 'grok-cli',
      method: 'stdio',
      from: 'human',
      body: 'needs a folder',
      state: 'out',
      reply: null,
    }),
  });
  assert.equal(chk.status, 2, chk.stdout);
  assert.match(chk.stdout, /stop — empty directory/);
  const turn = convobus(['turn', '--seat', 'grok-cli', '--from', 'human', '--body', 'needs a folder'], {
    cwd: dir,
  });
  assert.equal(turn.status, 2, turn.stdout);
  assert.match(turn.stdout, /stop — empty directory/);
  assert.ok(!readLog(dir).some((e) => e.event === 'deliver'));
  const seats = JSON.parse(convobus(['seats', '--json'], { cwd: dir }).stdout);
  const grok = (seats.seats || []).find((s) => s.handle === 'grok-cli');
  assert.ok(grok);
  assert.equal(grok.state, 'open', JSON.stringify(grok));
  assert.ok(!grok.cwd);
});

test('bind stores the picked folder; missing session file prints missing', () => {
  const dir = tmpDir('bind-miss-');
  const picked = tmpDir('picked-');
  convobus(['seats'], { cwd: dir });
  const bind = convobus(['bind', '--seat', 'chatgpt-app', '--cwd', picked], { cwd: dir });
  assert.equal(bind.status, 0, bind.stdout);
  const bound = JSON.parse(bind.stdout);
  assert.equal(bound.handle, 'chatgpt-app');
  assert.equal(bound.cwd, require('path').resolve(picked));
  assert.equal(bound.state, 'open');
  const turn = convobus(
    ['turn', '--seat', 'chatgpt-app', '--from', 'human', '--body', 'attach existing'],
    { cwd: dir },
  );
  assert.equal(turn.status, 2, turn.stdout);
  assert.match(turn.stdout, /^missing$/m);
  const seats = JSON.parse(convobus(['seats', '--json'], { cwd: dir }).stdout);
  const row = (seats.seats || []).find((s) => s.handle === 'chatgpt-app');
  assert.equal(row.state, 'open');
});

test('second next on a busy seat refuses; inflight has one out row', () => {
  const dir = tmpDir('busy-');
  convobus(['seats'], { cwd: dir });
  const a = convobus(['next', '--seat', 'stdio', '--body', 'first-live'], { cwd: dir });
  assert.equal(a.status, 0, a.stdout);
  const first = JSON.parse(a.stdout);
  const b = convobus(['next', '--seat', 'stdio', '--body', 'second-live'], { cwd: dir });
  assert.equal(b.status, 2, b.stdout);
  assert.match(b.stdout, /stop — seat already has a live card/);
  const inf = JSON.parse(convobus(['inflight', '--json'], { cwd: dir }).stdout);
  const outs = (inf.cards || []).filter((c) => c.seat === 'stdio' && c.state === 'out');
  assert.equal(outs.length, 1);
  assert.equal(outs[0].id, first.id);
  const stored = readJson(dir, 'inflight.json');
  const outRows = (stored.cards || []).filter((c) => c.seat === 'stdio' && c.state === 'out');
  assert.equal(outRows.length, 1);
});
