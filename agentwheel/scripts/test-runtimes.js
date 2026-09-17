#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { builtinModules } = require('module');

const ROOT = path.resolve(__dirname, '..');

const GROUPS = {
  engine: [
    'budget', 'cli', 'closure-proof', 'egress', 'gates-cards-broker', 'mcp', 'plan-trial', 'reject',
    'review', 'runtimes', 'release', 'surfaces', 'traversal', 'wheel', 'authorship', 'living-plan', 'node-stands', 'repair-not-restart', 'pull',
  ],
  schemas: ['schema'],
  storage: ['commit', 'events', 'recovery-loop', 'recovery-reconcile'],
  transport: ['invocations', 'transport', 'outcomes', 'seat-runner', 'seatlane'],
  gui: ['gui'],
};

const GUI_REASON = 'GUI: the window page (surfaces/ui/main.html) belongs to the macOS shell; excluded by name off macOS';

const SOURCE_DIRS = ['lib', 'surfaces', 'bin', 'seats', 'mcp', 'scripts', 'test'];

function testFiles() {
  // Dotfiles (AppleDouble "._x.test.js" metadata on a foreign filesystem) are never tests.
  return fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js') && !f.startsWith('.')).sort();
}

function plan(opts) {
  opts = opts || {};
  const files = testFiles();
  const named = new Map();
  for (const [group, names] of Object.entries(GROUPS)) {
    for (const n of names) {
      const f = `${n}.test.js`;
      if (named.has(f)) throw new Error(`${f} is listed in two groups (${named.get(f)}, ${group})`);
      named.set(f, group);
    }
  }
  const unclassified = files.filter((f) => !named.has(f));
  if (unclassified.length) throw new Error('test files in no group (classify them in scripts/test-runtimes.js): ' + unclassified.join(', '));
  const missing = [...named.keys()].filter((f) => !files.includes(f));
  if (missing.length) throw new Error('grouped test files missing from test/: ' + missing.join(', '));
  const runGui = opts.gui === true ? true : opts.gui === false ? false : process.platform === 'darwin';
  const run = [];
  const excluded = [];
  for (const f of files) {
    const group = named.get(f);
    if (group === 'gui' && !runGui) excluded.push({ file: 'test/' + f, group, reason: GUI_REASON });
    else run.push({ file: 'test/' + f, group });
  }
  return { run, excluded, groups: Object.keys(GROUPS), gui: runGui };
}

function walkJs(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'runtime') continue;
      walkJs(p, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

function isBuiltin(spec) {
  if (spec.startsWith('node:')) return true;
  const bare = spec.split('/')[0];
  return builtinModules.includes(spec) || builtinModules.includes(bare);
}

function checkDependencies() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const problems = [];
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    const names = Object.keys(pkg[field] || {});
    if (names.length) problems.push(`package.json ${field}: ${names.join(', ')}`);
  }
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) problems.push('node_modules/ exists; a zero-dependency package needs none');
  const offenders = new Map();
  for (const dir of SOURCE_DIRS) {
    for (const file of walkJs(path.join(ROOT, dir), [])) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) {
        const spec = m[2];
        if (spec.startsWith('.') || spec.startsWith('/') || isBuiltin(spec)) continue;
        if (!offenders.has(spec)) offenders.set(spec, []);
        offenders.get(spec).push(path.relative(ROOT, file));
      }
    }
  }
  for (const [spec, files] of offenders) problems.push(`non-builtin module '${spec}' required in ${files.join(', ')}`);
  return { ok: problems.length === 0, problems, node: process.version, platform: `${process.platform}/${process.arch}` };
}

// "never skipped silently": no test file may use skip; exclusion happens only here, by name.
function checkNoSkips() {
  const found = [];
  for (const f of testFiles()) {
    const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
    if (/\btest\.skip\(|\bskip:\s*true|\bt\.skip\(|\bit\.skip\(|\bdescribe\.skip\(/.test(src)) found.push('test/' + f);
  }
  return found;
}

function parseArgs(argv) {
  const opts = { gui: null, list: false };
  for (const a of argv) {
    if (a === '--no-gui') opts.gui = false;
    else if (a === '--gui') opts.gui = true;
    else if (a === '--list') opts.list = true;
    else throw new Error('unknown argument: ' + a);
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const p = plan(opts);
  const deps = checkDependencies();
  const skips = checkNoSkips();
  console.log(`agentwheel runtimes: node ${process.version} ${process.platform}/${process.arch}`);
  for (const g of p.groups) {
    const files = p.run.filter((r) => r.group === g).map((r) => r.file);
    console.log(`  ${g}: ${files.length ? files.join(' ') : '(none: excluded by name)'}`);
  }
  for (const e of p.excluded) console.log(`  EXCLUDED by name: ${e.file} - ${e.reason}`);
  console.log(`  dependencies: ${deps.ok ? 'zero runtime npm dependencies' : 'PROBLEMS'}`);
  for (const pr of deps.problems) console.log('    - ' + pr);
  console.log(`  skips: ${skips.length ? 'FOUND in ' + skips.join(', ') : 'none (exclusion only by name, above)'}`);
  if (!deps.ok || skips.length) return 2;
  if (opts.list) return 0;
  const r = spawnSync(process.execPath, ['--test', ...p.run.map((x) => x.file)], { cwd: ROOT, stdio: 'inherit' });
  return r.status == null ? 1 : r.status;
}

module.exports = { GROUPS, GUI_REASON, plan, checkDependencies, checkNoSkips, parseArgs, testFiles };

if (require.main === module) {
  let code;
  try {
    code = main(process.argv.slice(2));
  } catch (err) {
    console.error('test-runtimes: ' + err.message);
    code = 2;
  }
  process.exit(code);
}
