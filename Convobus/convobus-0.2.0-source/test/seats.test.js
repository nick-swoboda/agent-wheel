'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { convobus, tmpDir } = require('./helpers');
const { HANDLES } = require('../lib/seats');

const HANDLES_NOW = [
  'stdio',
  'human',
  'grok-cli',
  'claude-cli',
  'claude-app',
  'chatgpt-cli',
  'chatgpt-chat-app',
  'chatgpt-modern-chat-app',
  'chatgpt-app',
  'cursor-cli',
  'cursor-app',
];

const GONE = ['antigravity-cli', 'antigravity-app', 'agy', 'cursor-agent'];

test('discover prints the remaining handles and does not list stripped seats', () => {
  const dir = tmpDir('seats-');
  const r = convobus(['seats'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  for (const h of HANDLES_NOW) {
    assert.match(r.stdout, new RegExp('\\b' + h + '\\b'), r.stdout);
  }
  assert.equal(HANDLES.length, 11);
  assert.deepEqual(
    HANDLES.map((h) => h.handle),
    HANDLES_NOW,
  );
  assert.match(r.stdout, /\b(missing|open|ready)\b/);
  assert.match(r.stdout, /\bcursor-cli\b/);
  for (const gone of GONE) {
    assert.doesNotMatch(r.stdout, new RegExp('^' + gone + '\\s', 'm'), r.stdout);
  }
  assert.ok(!HANDLES.some((h) => h.handle === 'cursor-agent'));
  assert.doesNotMatch(r.stdout, /\bgrok-app\b/);
});

test('ax app seats print fragile when dump has not returned roles', () => {
  const dir = tmpDir('seats-frag-');
  const r = convobus(['seats'], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /cursor-app[\s\S]*fragile|fragile[\s\S]*cursor-app/);
});
