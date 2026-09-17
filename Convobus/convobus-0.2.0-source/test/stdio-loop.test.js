'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { convobus, tmpDir, FIXTURE, readLog } = require('./helpers');
const {
  spawnOnce,
  MAX_PROVIDER_STDOUT_BYTES,
  MAX_PROVIDER_STDERR_BYTES,
} = require('../lib/methods/stdio');

function runTwoTurn(dir, body, body2) {
  convobus(['seats'], { cwd: dir });
  return convobus(
    [
      'loop',
      '--seat',
      'stdio',
      '--method',
      'stdio',
      '--from',
      'human',
      '--turns',
      '2',
      '--body',
      body,
      '--body2',
      body2,
      '--',
      process.execPath,
      FIXTURE,
    ],
    { cwd: dir },
  );
}

function assertTwoTurnLog(dir) {
  const log = readLog(dir);
  const delivers = log.filter((e) => e.event === 'deliver');
  const sends = log.filter((e) => e.event === 'send');
  const replies = log.filter((e) => e.event === 'reply');
  const stages = log.filter((e) => e.event === 'stage');
  assert.ok(log.length >= 4, 'expected four+ events, got ' + log.length);
  assert.equal(delivers.length, 2);
  assert.equal(sends.length, 2);
  assert.equal(replies.length, 2);
  assert.equal(stages.length, 2);
  const turns = new Set(delivers.map((e) => e.turn));
  assert.equal(turns.size, 2);
  for (const s of stages) {
    assert.equal(s.card.state, 'back');
    assert.ok(s.card.reply && String(s.card.reply).length > 0);
    assert.equal(s.card.from, 'human');
  }
  return log;
}

test('two-turn stdio loop against fixture agent, twice, from human', () => {
  const dir1 = tmpDir('loop1-');
  const r1 = runTwoTurn(dir1, 'ping-1', 'ping-2');
  assert.equal(r1.status, 0, r1.stderr + r1.stdout);
  assertTwoTurnLog(dir1);
  assert.match(r1.stdout, /fixture-reply:ping-1/);
  assert.match(r1.stdout, /fixture-reply:ping-2/);

  const dir2 = tmpDir('loop2-');
  const r2 = runTwoTurn(dir2, 'pong-1', 'pong-2');
  assert.equal(r2.status, 0, r2.stderr + r2.stdout);
  assertTwoTurnLog(dir2);
});

test('provider stdout is bounded and oversized output fails explicitly', async () => {
  const result = await spawnOnce(
    [process.execPath, '-e', `process.stdout.write(Buffer.alloc(${MAX_PROVIDER_STDOUT_BYTES + 1}, 120))`],
    { timeout: 20000 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.miss, true);
  assert.equal(result.reason, 'provider output too large');
  assert.ok(Buffer.byteLength(result.stdout) <= MAX_PROVIDER_STDOUT_BYTES);
});

test('provider stderr retains only the bounded diagnostic tail', async () => {
  const size = MAX_PROVIDER_STDERR_BYTES + 1024;
  const result = await spawnOnce(
    [process.execPath, '-e', `process.stderr.write(Buffer.alloc(${size}, 101));process.stdout.write('ok')`],
    { timeout: 20000 },
  );
  assert.equal(result.reply, 'ok');
  assert.equal(Buffer.byteLength(result.stderr), MAX_PROVIDER_STDERR_BYTES);
});
