'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const BIN = path.join(REPO, 'convobus');
const FIXTURE = path.join(REPO, 'scripts', 'fixture-agent.js');
const NODE = process.execPath;

function tmpDir(prefix) {
  const base = path.join(__dirname, '.tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix || 'c-'));
}

function convobus(args, opts = {}) {
  return spawnSync(NODE, [BIN, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd,
    input: opts.input,
    env: { ...process.env, ...(opts.env || {}) },
    timeout: opts.timeout || 20000,
  });
}

function logPath(dir) {
  return path.join(dir, '.convobus', 'log.ndjson');
}

function readLog(dir) {
  const p = logPath(dir);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readJson(dir, name) {
  const p = path.join(dir, '.convobus', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function linesOf(text) {
  return String(text)
    .replace(/\n$/, '')
    .split('\n')
    .filter((l) => l.length > 0);
}

function writePlan(dir, files) {
  fs.mkdirSync(path.join(dir, 'plan'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, 'plan', name)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan', name), body);
  }
}

function minGraph(extra) {
  const files = {
    'what-a-person-gets.md': `# what-a-person-gets

idea

The question.
`,
    'the-experience.md': `# the-experience

experience

[[serves::what-a-person-gets]]

Sensor.
`,
    'declared-constraints.md': `# declared-constraints

constraint

[[serves::what-a-person-gets]]

Never paste a URL.
`,
    'work-item.md': `# work-item

plan

[[serves::the-experience]]

Held parent.

done (none yet) — already exercised.
`,
    'a-leaf.md': `# a-leaf

plan

open

A leaf with no try.

[[serves::the-experience]]
`,
  };
  Object.assign(files, extra || {});
  return files;
}

module.exports = {
  REPO,
  BIN,
  FIXTURE,
  NODE,
  tmpDir,
  convobus,
  logPath,
  readLog,
  readJson,
  linesOf,
  writePlan,
  minGraph,
};
