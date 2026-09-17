'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { convobus, tmpDir, linesOf, writePlan, minGraph } = require('./helpers');

function seed(dir) {
  const r = convobus(['seats'], { cwd: dir });
  assert.equal(r.status, 0);
  return r;
}

test('empty body is stop, exit 2', () => {
  const dir = tmpDir('check-empty-');
  seed(dir);
  const r = convobus(['check', ''], { cwd: dir });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /stop — empty body/);
  assert.ok(linesOf(r.stdout).length <= 6);
});

test('empty reply is stop, exit 2', () => {
  const dir = tmpDir('check-empty-r-');
  seed(dir);
  const r = convobus(['check', '--reply', '--stdin'], { cwd: dir, input: '' });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /stop — empty reply/);
});

test('trusted-method miss is stop', () => {
  const dir = tmpDir('check-method-');
  seed(dir);
  const card = {
    id: 'card_method',
    seat: 'stdio',
    method: 'clipboard',
    from: 'human',
    body: 'hello',
    state: 'out',
    reply: null,
  };
  const r = convobus(['check', '--stdin'], { cwd: dir, input: JSON.stringify(card) });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /stop — method not trusted/);
});

test('one-card-per-seat is stop', () => {
  const dir = tmpDir('check-one-');
  seed(dir);
  const a = convobus(
    ['next', '--seat', 'stdio', '--method', 'stdio', '--from', 'human', '--body', 'first'],
    { cwd: dir },
  );
  assert.equal(a.status, 0);
  const live = JSON.parse(a.stdout);
  const other = {
    id: 'card_other',
    seat: 'stdio',
    method: 'stdio',
    from: 'human',
    body: 'second',
    state: 'out',
    reply: null,
  };
  const r = convobus(['check', '--stdin'], { cwd: dir, input: JSON.stringify(other) });
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /stop — seat already has a live card/);
  assert.equal(live.seat, 'stdio');
});

test('two live seats and inbound reply missing id is stop', () => {
  const dir = tmpDir('check-cross-');
  seed(dir);
  convobus(['bind', '--seat', 'grok-cli', '--cwd', dir], { cwd: dir });
  convobus(['next', '--seat', 'stdio', '--body', 'a'], { cwd: dir });
  convobus(['next', '--seat', 'grok-cli', '--body', 'b'], { cwd: dir });
  const r = convobus(['check', '--reply', '--stdin'], {
    cwd: dir,
    input: JSON.stringify({ reply: 'hi', body: 'x', method: 'stdio', seat: 'stdio', state: 'waiting' }),
  });
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /stop — inbound reply missing id/);
});

test('ok line shape, non-empty body and reply, ≤ six lines, exit 0', () => {
  const dir = tmpDir('check-ok-');
  seed(dir);
  const body = convobus(['check', 'a non-empty body for the bus'], { cwd: dir });
  assert.equal(body.status, 0, body.stdout);
  assert.match(body.stdout, /ok — .+ · (out|waiting|back) · nothing crosses/);
  assert.ok(linesOf(body.stdout).length <= 6);

  const reply = convobus(['check', '--reply', '--stdin'], { cwd: dir, input: 'a non-empty reply' });
  assert.equal(reply.status, 0, reply.stdout);
  assert.match(reply.stdout, /ok — .+ · (out|waiting|back) · nothing crosses/);
  assert.ok(linesOf(reply.stdout).length <= 6);
});

test('seat not in seats and state missing', () => {
  const dir = tmpDir('check-seat-');
  seed(dir);
  const unknown = convobus(['check', '--stdin'], {
    cwd: dir,
    input: JSON.stringify({
      id: 'card_x',
      seat: 'not-a-seat',
      method: 'stdio',
      from: 'human',
      body: 'hello',
      state: 'out',
      reply: null,
    }),
  });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stdout, /stop — seat not in seats/);

  const nostate = convobus(['check', '--stdin'], {
    cwd: dir,
    input: JSON.stringify({
      id: 'card_y',
      seat: 'stdio',
      method: 'stdio',
      from: 'human',
      body: 'hello',
      reply: null,
    }),
  });
  assert.equal(nostate.status, 2);
  assert.match(nostate.stdout, /stop — state missing/);
});

test('checker rejects an unknown card state with the existing stop shape', () => {
  const dir = tmpDir('invalid-state-');
  convobus(['seats'], { cwd: dir });
  const result = convobus(
    ['check', JSON.stringify({ id: 'bad-state', seat: 'stdio', method: 'stdio', from: 'human', body: 'x', state: 'future', reply: null })],
    { cwd: dir },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, 'stop — state invalid\n');
});

test('checker died is exit 1', () => {
  const dir = tmpDir('check-die-');
  seed(dir);
  fs.writeFileSync(path.join(dir, '.convobus', 'seats.json'), '{not-json');
  const r = convobus(['check', 'a non-empty body'], { cwd: dir });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /checker died|JSON|Unexpected/);
});

test('plan layer four findings cap at six lines', () => {
  const dir = tmpDir('check-plan-');
  seed(dir);
  writePlan(dir, minGraph());
  const cases = [
    ['touch declared-constraints please', /constraint|already ruled out/],
    ['work-item is the work now', /held|redo/],
    ['please do unknown-kebab-id-xyz', /not a node|unresolved/],
    ['a-leaf needs a try', /leaf with no try|novel part/],
  ];
  for (const [msg, re] of cases) {
    const r = convobus(['check', msg], { cwd: dir });
    assert.equal(r.status, 2, msg + '\n' + r.stdout);
    assert.match(r.stdout, re);
    assert.ok(linesOf(r.stdout).length <= 6, r.stdout);
  }
});
