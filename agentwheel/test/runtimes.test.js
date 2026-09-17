'use strict';
require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const runner = require('../scripts/test-runtimes');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'test-runtimes.js');

test('A11: every test file belongs to exactly one runtime group; the GUI group is excluded by name, never skipped', () => {
  const files = runner.testFiles();
  assert.ok(files.length >= 21, 'test files: ' + files.length);
  const p = runner.plan({ gui: false });
  assert.deepEqual(p.groups, ['engine', 'schemas', 'storage', 'transport', 'gui']);
  assert.deepEqual(p.excluded, [{ file: 'test/gui.test.js', group: 'gui', reason: runner.GUI_REASON }]);
  assert.equal(p.run.length + p.excluded.length, files.length, 'every file runs or is excluded by name');
  assert.ok(p.run.every((r) => r.group !== 'gui'));
  for (const group of ['engine', 'schemas', 'storage', 'transport']) {
    assert.ok(p.run.some((r) => r.group === group), group + ' has tests');
  }
  const withGui = runner.plan({ gui: true });
  assert.deepEqual(withGui.excluded, []);
  assert.equal(withGui.run.length, files.length);
  assert.deepEqual(runner.checkNoSkips(), []);
  const groups = runner.GROUPS;
  const saved = groups.engine.slice();
  groups.engine.splice(groups.engine.indexOf('wheel'), 1);
  assert.throws(() => runner.plan({ gui: false }), /test files in no group.*wheel\.test\.js/);
  groups.engine.length = 0;
  groups.engine.push(...saved);
});

test('A11: zero runtime npm dependencies, checked in code: no declared dependencies, no node_modules, only builtin or relative requires', () => {
  const deps = runner.checkDependencies();
  assert.deepEqual(deps.problems, []);
  assert.equal(deps.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies, {});
  assert.equal(fs.existsSync(path.join(ROOT, 'node_modules')), false);
  assert.match(deps.node, /^v(2[2-9]|[3-9][0-9])\./, 'Node 22 or newer: ' + deps.node);
});

test('A11: the runner prints the plan by name and exits 0 with --list; --no-gui names the excluded GUI file and its reason', () => {
  const r = spawnSync(process.execPath, [RUNNER, '--list', '--no-gui'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^agentwheel runtimes: node v\d+\.\d+\.\d+ \w+\/\w+$/m);
  assert.match(r.stdout, /^  engine: test\/authorship\.test\.js test\/budget\.test\.js .*test\/wheel\.test\.js$/m);
  assert.match(r.stdout, /^  schemas: test\/schema\.test\.js$/m);
  assert.match(r.stdout, /^  storage: test\/commit\.test\.js test\/events\.test\.js test\/recovery-loop\.test\.js test\/recovery-reconcile\.test\.js$/m);
  assert.match(r.stdout, /^  transport: test\/invocations\.test\.js test\/outcomes\.test\.js test\/seat-runner\.test\.js test\/seatlane\.test\.js test\/transport\.test\.js$/m);
  assert.match(r.stdout, /^  gui: \(none: excluded by name\)$/m);
  assert.match(r.stdout, /^  EXCLUDED by name: test\/gui\.test\.js - GUI: the window page/m);
  assert.match(r.stdout, /^  dependencies: zero runtime npm dependencies$/m);
  assert.match(r.stdout, /^  skips: none/m);
  const withGui = spawnSync(process.execPath, [RUNNER, '--list', '--gui'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(withGui.status, 0);
  assert.match(withGui.stdout, /^  gui: test\/gui\.test\.js$/m);
  assert.ok(!/EXCLUDED/.test(withGui.stdout));
  const bad = spawnSync(process.execPath, [RUNNER, '--bogus'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown argument/);
});
