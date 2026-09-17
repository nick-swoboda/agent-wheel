'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { HANDLE_MAP, which } = require('../seats');

const MAX_PROVIDER_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_STDERR_BYTES = 256 * 1024;

const CHATGPT_APP = '/Applications/ChatGPT.app';
const CHATGPT_BIN = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
const CHATGPT_BUNDLE = 'com.openai.codex';
const CLAUDE_APP = '/Applications/Claude.app';
const CLAUDE_BIN = '/Applications/Claude.app/Contents/MacOS/Claude';
const CURSOR_APP = '/Applications/Cursor.app';
const CURSOR_BIN = '/Applications/Cursor.app/Contents/MacOS/Cursor';

function chatgptAppRunning() {
  const r = spawnSync('pgrep', ['-f', CHATGPT_BIN], { encoding: 'utf8' });
  return r.status === 0 && String(r.stdout || '').trim().length > 0;
}

async function ensureChatGPTAppUnfocused() {
  if (chatgptAppRunning()) return { running: true, launched: false };
  spawnSync('open', ['-g', '-b', CHATGPT_BUNDLE], { encoding: 'utf8', timeout: 15000 });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (chatgptAppRunning()) return { running: true, launched: true };
  }
  return { running: chatgptAppRunning(), launched: true };
}

function claudeAppRunning() {
  const r = spawnSync('pgrep', ['-f', CLAUDE_BIN], { encoding: 'utf8' });
  return r.status === 0 && String(r.stdout || '').trim().length > 0;
}

async function ensureClaudeAppUnfocused() {
  if (claudeAppRunning()) return { running: true, launched: false };
  spawnSync('open', ['-g', '-a', CLAUDE_APP], { encoding: 'utf8', timeout: 15000 });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (claudeAppRunning()) return { running: true, launched: true };
  }
  return { running: claudeAppRunning(), launched: true };
}

function cursorAppRunning() {
  const r = spawnSync('pgrep', ['-f', CURSOR_BIN], { encoding: 'utf8' });
  return r.status === 0 && String(r.stdout || '').trim().length > 0;
}

async function ensureCursorAppUnfocused() {
  if (cursorAppRunning()) return { running: true, launched: false };
  spawnSync('open', ['-g', '-a', CURSOR_APP], { encoding: 'utf8', timeout: 15000 });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (cursorAppRunning()) return { running: true, launched: true };
  }
  return { running: cursorAppRunning(), launched: true };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOUD_ID_RE = /^(session_|cse_)[A-Za-z0-9]+$/;

function vendorArgv(handle, body, binPath, opts) {
  const def = HANDLE_MAP.get(handle);
  const bin = binPath || (def && def.binary);
  if (!bin) return null;
  const o = opts || {};
  switch (handle) {
    case 'grok-cli': {
      const args = [bin, '-p', body, '--max-turns', '1'];
      const sid = o.sessionId || o.resume;
      if (sid) args.push('--resume', String(sid));
      else args.push('--continue');
      return args;
    }
    case 'claude-cli': {
      const args = [bin, '-p', body];
      const sid = o.sessionId || o.resume;
      if (sid && UUID_RE.test(String(sid))) args.push('-r', String(sid));
      return args;
    }
    case 'claude-app': {
      const args = [bin, '-p', body];
      const sid = o.sessionId || o.resume;
      if (sid && /claude\.ai\/chat\//i.test(String(sid))) {
        args.push('--cloud', String(sid));
      } else if (sid && o.kind === 'chat' && UUID_RE.test(String(sid))) {
        args.push('--cloud', 'https://claude.ai/chat/' + String(sid));
      } else if (sid && UUID_RE.test(String(sid))) args.push('-r', String(sid));
      else if (sid && CLOUD_ID_RE.test(String(sid))) args.push('--cloud', String(sid));
      return args;
    }
    case 'chatgpt-cli':
      return [bin, 'exec', body];
    default:
      return null;
  }
}

function resolveArgv(argv) {
  if (!argv || !argv.length) return null;
  const out = argv.slice();
  if (out[0] === 'node') out[0] = process.execPath;
  else if (!out[0].includes('/')) {
    const resolved = which(out[0]);
    if (!resolved) return null;
    out[0] = resolved;
  }
  return out;
}

function spawnOnce(argv, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convobus-provider-'));
    fs.chmodSync(tempDir, 0o700);
    const stdoutFile = path.join(tempDir, 'stdout');
    let stdoutFd = fs.openSync(stdoutFile, 'wx', 0o600);
    const child = spawn(argv[0], argv.slice(1), {
      cwd: o.cwd,
      env: o.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let settled = false;
    const timeout = o.timeout || 60000;
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish((stdout, stderr) => ({
        ok: false,
        miss: true,
        reason: 'timeout',
        stdout,
        stderr,
        reply: null,
      }));
    }, timeout);

    function finish(makeResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutFd != null) {
        try { fs.fsyncSync(stdoutFd); } catch { /* ignore */ }
        try { fs.closeSync(stdoutFd); } catch { /* ignore */ }
        stdoutFd = null;
      }
      let stdout = '';
      try { stdout = fs.readFileSync(stdoutFile, 'utf8'); } catch { /* ignore */ }
      const stderr = stderrTail.toString('utf8');
      const result = makeResult(stdout, stderr);
      try { fs.unlinkSync(stdoutFile); } catch { /* ignore */ }
      try { fs.rmdirSync(tempDir); } catch { /* ignore */ }
      resolve(result);
    }

    child.stdout.on('data', (d) => {
      if (settled) return;
      const chunk = Buffer.from(d);
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PROVIDER_STDOUT_BYTES) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        finish((stdout, stderr) => ({
          ok: false,
          miss: true,
          reason: 'provider output too large',
          stdout,
          stderr,
          reply: null,
        }));
        return;
      }
      fs.writeSync(stdoutFd, chunk);
    });
    child.stderr.on('data', (d) => {
      if (settled) return;
      stderrTail = Buffer.concat([stderrTail, Buffer.from(d)]);
      if (stderrTail.length > MAX_PROVIDER_STDERR_BYTES) {
        stderrTail = stderrTail.subarray(stderrTail.length - MAX_PROVIDER_STDERR_BYTES);
      }
    });
    child.on('error', (err) => {
      finish((stdout, stderr) => ({
        ok: false,
        miss: true,
        reason: err && err.message ? err.message : String(err),
        stdout,
        stderr,
        reply: null,
      }));
    });
    child.on('close', (code) => {
      finish((stdout, stderr) => {
        const reply = String(stdout || '').trim();
        return {
          ok: reply.length > 0,
          code,
          stdout,
          stderr,
          reply: reply.length ? reply : null,
          miss: reply.length === 0,
          reason: reply.length ? null : 'empty stdout',
        };
      });
    });
    if (o.input) child.stdin.end(o.input);
    else child.stdin.end();
  });
}

async function sendStdio(card, opts) {
  const o = opts || {};
  if (card.seat === 'human') {
    return { ok: true, reply: null, waitingHuman: true, method: 'stdio' };
  }
  let argv;
  let encoding;
  if (o.argv && o.argv.length) {
    argv = resolveArgv(o.argv);
    encoding = o.encoding || 'raw';
    if (!argv) {
      return { ok: false, miss: true, reason: 'missing binary', method: 'stdio' };
    }
  } else {
    const def = HANDLE_MAP.get(card.seat);
    const bin = o.binPath || (def && def.binary ? which(def.binary) : null);
    if (card.seat === 'stdio' && !o.argv) {
      return { ok: false, miss: true, reason: 'stdio seat needs argv', method: 'stdio' };
    }
    if (!bin) {
      return { ok: false, miss: true, reason: 'missing binary', method: 'stdio' };
    }
    argv = vendorArgv(card.seat, card.body, bin, o);
    encoding = o.encoding || 'argv';
    if (!argv) {
      return { ok: false, miss: true, reason: 'missing binary', method: 'stdio' };
    }
    if (
      (card.seat === 'claude-app' || card.seat === 'claude-cli') &&
      !argv.includes('-r') &&
      !argv.includes('--cloud')
    ) {
      return { ok: false, miss: true, reason: 'missing', method: 'stdio' };
    }
    argv = resolveArgv(argv);
    if (!argv) {
      return { ok: false, miss: true, reason: 'missing binary', method: 'stdio' };
    }
  }

  const input = encoding === 'raw' ? JSON.stringify(card) + '\n' : '';
  const result = await spawnOnce(argv, {
    cwd: o.cwd,
    env: o.env,
    input,
    timeout: o.timeout,
  });
  result.method = 'stdio';
  result.argv = argv;
  result.encoding = encoding;
  return result;
}

async function queueExistingCodex(sessionId, body, opts) {
  const o = opts || {};
  const bin = which('codex');
  if (!bin) return { ok: false, miss: true, reason: 'missing', method: 'stdio' };
  const argv = [bin, 'queue', '--thread', String(sessionId), '--message', String(body)];
  const result = await spawnOnce(argv, {
    cwd: o.cwd,
    env: o.env,
    timeout: o.timeout || 60000,
  });
  result.method = 'stdio';
  result.argv = argv;
  result.reply = null;
  result.ok = false;
  if (result.code === 0) {
    result.miss = false;
    result.submitted = true;
    result.reason = null;
  } else {
    result.miss = true;
    result.submitted = false;
    result.reason = result.reason || result.stderr || 'queue failed';
  }
  return result;
}

async function resumeExistingCodex(sessionId, body, opts) {
  const o = opts || {};
  const bin = which('codex');
  if (!bin) return { ok: false, miss: true, reason: 'missing', method: 'stdio' };
  if (!sessionId || !UUID_RE.test(String(sessionId))) {
    return { ok: false, miss: true, reason: 'missing', method: 'stdio' };
  }
  const argv = [bin, 'exec', 'resume', '--skip-git-repo-check', String(sessionId), String(body)];
  if (o.cwd) argv.splice(2, 0, '-C', String(o.cwd));
  const result = await spawnOnce(argv, {
    cwd: o.cwd,
    env: o.env,
    timeout: o.timeout || 180000,
  });
  result.method = 'stdio';
  result.argv = argv;
  const text = String(result.reply || result.stdout || '').trim();
  if (text && text !== String(body) && !/^Queued message/i.test(text)) {
    result.reply = text;
    result.ok = true;
    result.miss = false;
    result.submitted = true;
    result.reason = null;
  } else if (result.code === 0) {
    result.reply = null;
    result.ok = false;
    result.miss = false;
    result.submitted = true;
    result.reason = null;
  } else {
    result.reply = null;
    result.miss = true;
    result.submitted = false;
    result.reason = result.stderr || result.reason || 'resume failed';
  }
  return result;
}

async function queueExistingCursor(sess, body, opts) {
  const o = opts || {};
  const bin = which('cursor-agent');
  if (!bin) return { ok: false, miss: true, reason: 'missing binary', method: 'stdio' };
  const sid = sess && sess.id;
  if (!sid || !UUID_RE.test(String(sid))) {
    return { ok: false, miss: true, reason: 'missing', method: 'stdio' };
  }
  const argv = [bin, '-p', String(body), '--resume', String(sid), '--trust', '--mode', 'ask'];
  if (o.cwd) argv.push('--workspace', String(o.cwd));
  const result = await spawnOnce(argv, {
    cwd: o.cwd,
    env: o.env,
    timeout: o.timeout || 180000,
  });
  result.method = 'stdio';
  result.argv = argv;
  if (result.reply && String(result.reply).trim()) {
    result.ok = true;
    result.miss = false;
    result.submitted = true;
    result.reason = null;
  } else if (result.code === 0) {
    result.ok = false;
    result.miss = false;
    result.submitted = true;
    result.reply = null;
    result.reason = null;
  } else {
    result.miss = true;
    result.submitted = false;
    const err = String(result.stderr || result.reason || '').trim();
    result.reason = err || result.reason || 'empty stdout';
  }
  return result;
}

async function queueExistingClaude(sess, body, opts) {
  const o = opts || {};
  const bin = which('claude');
  if (!bin) return { ok: false, miss: true, reason: 'missing binary', method: 'stdio' };
  const sid = sess && sess.id;
  const argv = vendorArgv('claude-app', body, bin, { sessionId: sid, kind: sess && sess.kind });
  if (!argv || (!argv.includes('-r') && !argv.includes('--cloud'))) {
    return { ok: false, miss: true, reason: 'missing', method: 'stdio' };
  }
  const result = await spawnOnce(argv, {
    cwd: o.cwd,
    env: o.env,
    timeout: o.timeout || 180000,
  });
  result.method = 'stdio';
  result.argv = argv;
  if (result.reply && String(result.reply).trim()) {
    result.ok = true;
    result.miss = false;
    result.submitted = true;
    result.reason = null;
  } else if (result.code === 0) {
    result.ok = false;
    result.miss = false;
    result.submitted = true;
    result.reply = null;
    result.reason = null;
  } else {
    result.miss = true;
    result.submitted = false;
    const err = String(result.stderr || result.reason || '').trim();
    result.reason = err || result.reason || 'empty stdout';
  }
  return result;
}

module.exports = {
  MAX_PROVIDER_STDOUT_BYTES,
  MAX_PROVIDER_STDERR_BYTES,
  vendorArgv,
  resolveArgv,
  spawnOnce,
  sendStdio,
  queueExistingCodex,
  resumeExistingCodex,
  queueExistingClaude,
  queueExistingCursor,
  chatgptAppRunning,
  ensureChatGPTAppUnfocused,
  claudeAppRunning,
  ensureClaudeAppUnfocused,
  cursorAppRunning,
  ensureCursorAppUnfocused,
  UUID_RE,
  CLOUD_ID_RE,
};
