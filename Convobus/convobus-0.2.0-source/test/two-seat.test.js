'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { convobus, tmpDir, FIXTURE, readLog, linesOf } = require('./helpers');

test('two seats loop: A reply becomes B card, ids do not swap, check both directions', () => {
  const dir = tmpDir('ab-');
  convobus(['seats'], { cwd: dir });
  convobus(['bind', '--seat', 'grok-cli', '--cwd', dir], { cwd: dir });
  const r = convobus(
    [
      'loop',
      '--seat',
      'stdio',
      '--to',
      'grok-cli',
      '--method',
      'stdio',
      '--body',
      'alpha-one',
      '--',
      process.execPath,
      FIXTURE,
    ],
    { cwd: dir },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const pair = JSON.parse(r.stdout);
  assert.equal(pair.a.seat, 'stdio');
  assert.equal(pair.b.seat, 'grok-cli');
  assert.notEqual(pair.a.id, pair.b.id);
  assert.equal(pair.b.body, pair.a.reply);
  assert.ok(pair.a.reply.includes('alpha-one'));
  assert.ok(pair.b.reply.includes(pair.a.reply));
  assert.equal(pair.a.from, 'stdio');
  assert.equal(pair.b.from, 'stdio');
  assert.notEqual(pair.a.from, 'human');
  assert.notEqual(pair.b.from, 'human');
  const log = readLog(dir);
  const stages = log.filter((e) => e.event === 'stage');
  assert.equal(stages.length, 2);
  assert.equal(stages[0].card.id, pair.a.id);
  assert.equal(stages[1].card.id, pair.b.id);
  assert.equal(stages[0].card.reply, pair.a.reply);
  assert.equal(stages[1].card.reply, pair.b.reply);

  const checkBody = convobus(['check', '--stdin'], {
    cwd: dir,
    input: JSON.stringify({
      id: pair.a.id,
      seat: pair.a.seat,
      method: 'stdio',
      from: pair.a.from,
      body: 'alpha-one',
      state: 'back',
      reply: pair.a.reply,
    }),
  });
  const checkReply = convobus(['check', '--reply', '--stdin'], {
    cwd: dir,
    input: JSON.stringify({
      id: pair.b.id,
      seat: pair.b.seat,
      method: 'stdio',
      from: pair.b.from,
      body: pair.b.body,
      state: 'back',
      reply: pair.b.reply,
    }),
  });
  assert.equal(checkBody.status, 0, checkBody.stdout);
  assert.equal(checkReply.status, 0, checkReply.stdout);
  assert.match(checkBody.stdout, /nothing crosses/);
  assert.match(checkReply.stdout, /nothing crosses/);
  assert.ok(linesOf(checkBody.stdout).length <= 6);
  assert.ok(linesOf(checkReply.stdout).length <= 6);

  const human = convobus(
    [
      'turn',
      '--seat',
      'stdio',
      '--method',
      'stdio',
      '--from',
      'human',
      '--body',
      'human-to-harness',
      '--',
      process.execPath,
      FIXTURE,
    ],
    { cwd: dir },
  );
  assert.equal(human.status, 0, human.stderr + human.stdout);
  const humanCard = JSON.parse(human.stdout);
  assert.equal(humanCard.from, 'human');
  assert.equal(humanCard.state, 'back');
  assert.ok(humanCard.reply.includes('human-to-harness'));
  const log2 = readLog(dir);
  assert.ok(log2.some((e) => e.card && e.card.from === 'human' && e.event === 'stage'));
});

test('parallel inflight cards stage onto matching ids; from human lands in log', () => {
  const dir = tmpDir('par-');
  convobus(['seats'], { cwd: dir });
  convobus(['bind', '--seat', 'chatgpt-cli', '--cwd', dir], { cwd: dir });
  const a = JSON.parse(
    convobus(['next', '--seat', 'stdio', '--from', 'human', '--body', 'alpha-one'], { cwd: dir })
      .stdout,
  );
  const b = JSON.parse(
    convobus(['next', '--seat', 'chatgpt-cli', '--from', 'human', '--body', 'beta-two'], {
      cwd: dir,
    }).stdout,
  );
  assert.notEqual(a.id, b.id);
  const inf = convobus(['inflight'], { cwd: dir });
  assert.match(inf.stdout, new RegExp(a.id));
  assert.match(inf.stdout, new RegExp(b.id));

  const ta = convobus(['turn', '--id', a.id, '--', process.execPath, FIXTURE], { cwd: dir });
  const tb = convobus(['turn', '--id', b.id, '--', process.execPath, FIXTURE], { cwd: dir });
  assert.equal(ta.status, 0, ta.stdout + ta.stderr);
  assert.equal(tb.status, 0, tb.stdout + tb.stderr);
  const backA = JSON.parse(ta.stdout);
  const backB = JSON.parse(tb.stdout);
  assert.equal(backA.id, a.id);
  assert.equal(backB.id, b.id);
  assert.ok(backA.reply.includes('alpha-one'));
  assert.ok(backB.reply.includes('beta-two'));
  assert.ok(!backA.reply.includes('beta-two'));
  assert.ok(!backB.reply.includes('alpha-one'));
  const log = readLog(dir);
  const human = log.filter((e) => e.card && e.card.from === 'human');
  assert.ok(human.length >= 2);
});
