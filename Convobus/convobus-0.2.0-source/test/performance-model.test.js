'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const { appendLog, readLog, paths, writeSeatsFile } = require('../lib/store');
const { providerModel, providerModelAsync, menuModel, cardsForContext, writePrefs } = require('../lib/control');
const { discover } = require('../lib/seats');

test('unchanged lifecycle data is fully read once and later appends are incremental', () => {
  const root = tmpDir('log-index-');
  discover(root);
  const route = { provider: 'grok', project: root, surface: 'cli', type: 'grok-cli' };
  appendLog(root, {
    event: 'stage',
    route,
    card: { id: 'indexed', seat: 'grok-cli', method: 'stdio', from: 'human', body: 'x', state: 'back', reply: 'one', cwd: root },
  });
  const logFile = paths(root).log;
  const original = fs.readFileSync;
  let fullReads = 0;
  fs.readFileSync = function patched(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(logFile)) fullReads += 1;
    return original.call(this, file, ...args);
  };
  try {
    assert.equal(readLog(root).length, 1);
    providerModel(root, { home: path.join(root, 'empty-home') });
    menuModel(root, { fast: true });
    cardsForContext(root, route);
    assert.equal(fullReads, 1);
    appendLog(root, { event: 'reply', route, card: { id: 'indexed', seat: 'grok-cli', method: 'stdio', from: 'human', body: 'x', state: 'waiting', reply: 'two', cwd: root } });
    assert.equal(readLog(root).length, 2);
    assert.equal(fullReads, 1, 'append should be consumed from the previous byte offset');
  } finally {
    fs.readFileSync = original;
  }
});

test('cold provider-session resolution yields the request thread', async () => {
  const root = tmpDir('provider-worker-');
  const home = path.join(root, 'empty-home');
  fs.mkdirSync(home, { recursive: true });
  const seats = discover(root);
  const grok = seats.seats.find((seat) => seat.handle === 'grok-cli');
  grok.path = '/usr/bin/true';
  grok.state = 'open';
  writeSeatsFile(root, seats);
  writePrefs(root, {
    currentSeat: 'grok-cli',
    ui: {
      routeCatalogVersion: 2,
      selectedProvider: 'grok',
      selectedProject: root,
      lastProjectByProvider: { grok: root },
      projects: [{
        path: root,
        lastUsedAt: new Date().toISOString(),
        routes: { grok: { surface: 'cli', type: 'grok-cli' } },
      }],
    },
  });
  let eventLoopAdvanced = false;
  setImmediate(() => { eventLoopAdvanced = true; });
  const model = await providerModelAsync(root, { home });
  assert.equal(eventLoopAdvanced, true);
  assert.equal(model.selection.provider, 'grok');
  assert.equal(model.status.status, 'needs-session');
});
