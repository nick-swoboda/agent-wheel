'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO, convobus } = require('./helpers');
const { PROVIDERS } = require('../lib/providers');
const { STATES, METHODS } = require('../lib/card');
const { USAGE } = require('../lib/cli');

const fixtureDir = path.join(__dirname, 'fixtures', 'parity', 'v0.1.4');
const contract = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'contracts.json'), 'utf8'));

test('0.1.4 provider, route, card, and CLI contracts remain frozen', () => {
  const providers = PROVIDERS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    routes: provider.routes.map((route) => [
      route.surface,
      route.type,
      route.label,
      route.seat,
      route.variant,
    ]),
  }));
  assert.deepEqual(providers, contract.providers);
  assert.deepEqual([...STATES], contract.cardStates);
  assert.deepEqual([...METHODS], contract.methods);
  assert.equal(USAGE, fs.readFileSync(path.join(fixtureDir, 'cli-help.txt'), 'utf8'));
  const help = convobus(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout, USAGE);
});

test('0.1.4 HTTP endpoint and native presentation vocabulary remain declared', () => {
  const gui = fs.readFileSync(path.join(REPO, 'lib', 'gui.js'), 'utf8');
  for (const [method, route] of contract.http) {
    assert.match(gui, new RegExp(`req\\.method === '${method}'[\\s\\S]{0,220}url\\.pathname === '${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
  const swift = fs.readFileSync(path.join(REPO, 'lib', 'app-main.swift'), 'utf8');
  const catalog = fs.readFileSync(path.join(REPO, 'lib', 'provider-catalog.json'), 'utf8');
  const nativeVocabulary = `${swift}\n${catalog}`;
  for (const label of [
    ...contract.window.providerOrder,
    ...contract.window.surfaceLabels,
    ...contract.window.statusLabels,
    ...contract.window.settingsLabels,
  ]) {
    assert.ok(nativeVocabulary.includes(label), label);
  }
  assert.match(swift, /width: 1040, height: 760/);
  assert.match(swift, /width: 720, height: 520/);
});
