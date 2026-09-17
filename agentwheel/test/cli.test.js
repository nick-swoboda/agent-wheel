'use strict';
require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const { appRoot } = require('../lib/paths');

const bin = path.join(appRoot, 'bin', 'agentwheel.js');

function runCli(args, env) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15000,
  });
}

function spawnHelper(home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'helper'], {
      env: { ...process.env, AGENT_WHEEL_HOME: home, AGENT_WHEEL_STORE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('helper never became ready: ' + out)); }, 15000);
    child.stdout.on('data', (c) => {
      out += c;
      const nl = out.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        const ready = JSON.parse(out.slice(0, nl));
        resolve({ child, ready });
      }
    });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdin.write(JSON.stringify({ token: crypto.randomBytes(24).toString('hex') }) + '\n');
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('status reads the store the env points at', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cli-'));
  const r = runCli(['status'], { AGENT_WHEEL_STORE: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /unspooled/);
});

test('reset archives the store instead of deleting it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cli-'));
  const storeDir = path.join(dir, 'store');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'audit.jsonl'), '{"kept":true}\n');
  const env = { AGENT_WHEEL_STORE: storeDir };
  const r = runCli(['reset'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /archived to/);
  assert.ok(!fs.existsSync(storeDir), 'store moved away');
  const archived = fs.readdirSync(dir).find((n) => n.startsWith('store-archive-'));
  assert.ok(archived, 'archive dir exists');
  assert.equal(
    fs.readFileSync(path.join(dir, archived, 'audit.jsonl'), 'utf8'),
    '{"kept":true}\n',
    'audit journal preserved'
  );
  const again = runCli(['reset'], env);
  assert.match(again.stdout, /already empty/);
});

test('reset refuses while the helper is alive', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cli-'));
  const { child, ready } = await spawnHelper(home);
  try {
    assert.equal(ready.ready, true);
    const info = JSON.parse(fs.readFileSync(path.join(home, 'store', 'helper.json'), 'utf8'));
    assert.equal(info.pid, child.pid);
    assert.equal(info.port, ready.port);
    assert.ok(!('token' in info), 'the token is never on disk');
    const r = runCli(['reset'], { AGENT_WHEEL_HOME: home, AGENT_WHEEL_STORE: '' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing/);
  } finally {
    child.kill('SIGTERM');
  }
});

test('stop kills only the live helper named by helper.json', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cli-'));
  const { child } = await spawnHelper(home);
  const env = { AGENT_WHEEL_HOME: home, AGENT_WHEEL_STORE: '' };
  const r = runCli(['stop'], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /stopped helper \(pid /);
  for (let i = 0; i < 40 && pidAlive(child.pid); i++) await wait(50);
  assert.ok(!pidAlive(child.pid), 'helper was terminated');

  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  try {
    fs.writeFileSync(path.join(home, 'store', 'helper.json'), JSON.stringify({ pid: sleeper.pid, port: 1 }));
    const forged = runCli(['stop'], env);
    assert.equal(forged.status, 1);
    assert.match(forged.stdout, /not a live helper/);
    assert.ok(pidAlive(sleeper.pid), 'the bystander process is untouched');
  } finally {
    try { sleeper.kill(); } catch {}
  }
});
