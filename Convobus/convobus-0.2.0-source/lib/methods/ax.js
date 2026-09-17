'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  paths,
  ensureDir,
  createPrivateTemp,
  removePrivateFile,
  writePrivateText,
} = require('../store');
const { markSeatRoles } = require('../seats');
const { compatibleBundleExecutable } = require('../bundle-helper');
const { sendCursorComposer } = require('./cursor-cdp');

const JXA_PATH = path.join(__dirname, '..', 'jxa', 'ax.js');
const APP_EXE = path.join(__dirname, '..', '..', 'app', 'Convobus.app', 'Contents', 'MacOS', 'Convobus');
const HELPER = path.join(__dirname, '..', '..', 'app', 'Convobus.app', 'Contents', 'MacOS', 'ax-helper');

function convobusExe() {
  return compatibleBundleExecutable(path.join(__dirname, '..', '..', 'app', 'Convobus.app'), 'Convobus');
}

function axHelper() {
  return compatibleBundleExecutable(path.join(__dirname, '..', '..', 'app', 'Convobus.app'), 'ax-helper');
}

const PROCESS_FOR_SEAT = {
  'claude-app': 'Claude',
  'chatgpt-chat-app': 'com.openai.chat',
  'chatgpt-modern-chat-app': 'com.openai.codex',
  'chatgpt-app': 'com.openai.codex',
  'cursor-app': 'Cursor',
};

function jxaSource() {
  return fs.readFileSync(JXA_PATH, 'utf8');
}

function runOsascript(args, opts) {
  const o = opts || {};
  return spawnSync('osascript', args, {
    encoding: 'utf8',
    timeout: o.timeout || 8000,
    env: o.env || process.env,
    input: o.input,
    killSignal: 'SIGKILL',
  });
}

function parseRolesFromDump(text) {
  const composers = [];
  const buttons = [];
  const statics = [];
  for (const line of String(text).split('\n')) {
    const parts = line.split(' | ');
    if (parts.length < 3) continue;
    const role = parts[0].trim();
    const title = (parts[1] || '').trim();
    const desc = (parts[2] || '').trim();
    if (/AXTextArea|AXTextField|AXComboBox/i.test(role)) {
      composers.push({ role: role.replace(/^\s+/, ''), title, description: desc });
    }
    if (/AXButton/i.test(role)) {
      buttons.push({ role: 'AXButton', title, description: desc });
    }
    if (/AXStaticText/i.test(role)) {
      statics.push({ role: 'AXStaticText', title, description: desc });
    }
  }
  const composer = composers.length ? composers[composers.length - 1] : null;
  let send = null;
  for (const b of buttons) {
    const blob = `${b.title} ${b.description}`;
    if (/send|发送|paper plane|prompt/i.test(blob)) {
      send = b;
      break;
    }
  }
  if (!send && buttons.length) {
    const last = buttons[buttons.length - 1];
    send = {
      role: 'AXButton',
      title: last.title,
      description: last.description,
      unlabeled: !last.title,
    };
  }
  const reply = statics.length ? statics[statics.length - 1] : null;
  const fragile = !composer || !send;
  return { composer, send, reply, fragile };
}

function lastClaudeRespondedFromDump(text) {
  let last = null;
  for (const line of String(text).split('\n')) {
    const m = line.match(/Claude responded:\s*([^|\n]+)/i);
    if (m) last = m[1].trim();
  }
  return last;
}

function lastJsonLine(text) {
  const lines = String(text || '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* next */
    }
  }
  return null;
}

function axFeed(processName, opts) {
  const name = processName || 'Claude';
  const exe = convobusExe();
  if (!exe) return { stdout: '', stderr: 'compatible AX helper is missing', status: 2 };
  const r = spawnSync(exe, ['--ax-feed', name], {
    encoding: 'utf8',
    timeout: (opts && opts.timeout) || 15000,
    killSignal: 'SIGKILL',
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function axDump(processName, opts) {
  const name = processName || 'Claude';
  const exe = convobusExe();
  const helper = axHelper();
  if (exe || helper) {
    const target = exe || helper;
    const args = target === exe ? ['--ax-dump', name] : ['dump', name];
    const r = spawnSync(target, args, {
      encoding: 'utf8',
      timeout: (opts && opts.timeout) || 8000,
      killSignal: 'SIGKILL',
    });
    const stdout = r.stdout || '';
    const stderr = r.stderr || '';
    const tcc =
      !!(r.error && (r.error.code === 'ETIMEDOUT' || r.error.killed)) ||
      /not allowed|not authorized|(-25211)|(-1719)|(-1743)|accessibility/i.test(
        stdout + stderr + (r.error ? r.error.message : ''),
      );
    const roles = parseRolesFromDump(stdout);
    return {
      ok: r.status === 0 && stdout.length > 0 && !/not running/.test(stdout.split('\n')[0] || ''),
      stdout,
      stderr,
      status: r.status,
      tcc,
      roles,
      fragile: roles.fragile || /not running/.test(stdout),
      error: r.error ? String(r.error.message) : stderr.trim() || null,
    };
  }
  const r = runOsascript(['-l', 'JavaScript', JXA_PATH, 'dump', name], {
    timeout: (opts && opts.timeout) || 8000,
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const combined = stdout || stderr;
  const tcc =
    !!(r.error && (r.error.code === 'ETIMEDOUT' || r.error.killed)) ||
    /not allowed|not authorized|(-25211)|(-1719)|(-1743)|accessibility|Apple Event/i.test(
      combined + (r.error ? r.error.message : ''),
    );
  const roles = parseRolesFromDump(stdout);
  return {
    ok: r.status === 0 && stdout.length > 0 && !/not running/.test(stdout.split('\n')[0] || ''),
    stdout,
    stderr,
    status: r.status,
    tcc,
    roles,
    fragile: roles.fragile || /not running/.test(stdout),
    error: r.error ? String(r.error.message) : stderr.trim() || null,
  };
}

function axProbe(processName, opts) {
  const name = processName || 'Claude';
  const exe = convobusExe();
  const helper = axHelper();
  const target = exe || helper;
  if (!target) {
    return { ok: false, running: false, composer: false, tcc: false, error: 'AX helper is missing' };
  }
  const args = target === exe ? ['--ax-probe', name] : ['probe', name];
  const r = spawnSync(target, args, {
    encoding: 'utf8',
    timeout: (opts && opts.timeout) || 5000,
    killSignal: 'SIGKILL',
  });
  const parsed = lastJsonLine(r.stdout || '') || lastJsonLine(r.stderr || '') || {};
  return {
    ok: r.status === 0 && parsed.ok === true,
    running: parsed.running === true,
    composer: parsed.composer === true,
    send: parsed.send === true,
    mode: parsed.mode || null,
    pid: parsed.pid || null,
    nearby: parsed.nearby || '',
    tcc: parsed.tcc === true,
    trusted: parsed.trusted === true,
    hits: parsed.hits || 0,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    status: r.status,
    error: r.error ? String(r.error.message) : parsed.error || null,
  };
}

function axProbeAsync(processName, opts) {
  const name = processName || 'Claude';
  const exe = convobusExe();
  const helper = axHelper();
  const target = exe || helper;
  if (!target) {
    return Promise.resolve({
      ok: false,
      running: false,
      composer: false,
      tcc: false,
      error: 'AX helper is missing',
    });
  }
  const args = target === exe ? ['--ax-probe', name] : ['probe', name];
  const timeout = (opts && opts.timeout) || 5000;
  return new Promise((resolve) => {
    const child = spawn(target, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0 };
    let processError = null;
    let timedOut = false;
    const capture = (kind, chunk) => {
      const bytesKey = `${kind}Bytes`;
      if (chunks[bytesKey] >= 262144) return;
      const remaining = 262144 - chunks[bytesKey];
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks[kind].push(kept);
      chunks[bytesKey] += kept.length;
    };
    child.stdout.on('data', (chunk) => capture('stdout', chunk));
    child.stderr.on('data', (chunk) => capture('stderr', chunk));
    child.on('error', (error) => { processError = error; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.on('close', (status) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks.stdout).toString('utf8');
      const stderr = Buffer.concat(chunks.stderr).toString('utf8');
      const parsed = lastJsonLine(stdout) || lastJsonLine(stderr) || {};
      resolve({
        ok: status === 0 && parsed.ok === true,
        running: parsed.running === true,
        composer: parsed.composer === true,
        send: parsed.send === true,
        mode: parsed.mode || null,
        pid: parsed.pid || null,
        nearby: parsed.nearby || '',
        tcc: parsed.tcc === true,
        trusted: parsed.trusted === true,
        hits: parsed.hits || 0,
        stdout,
        stderr,
        status,
        error: processError
          ? String(processError.message)
          : timedOut
            ? 'AX probe timed out'
            : parsed.error || null,
      });
    });
  });
}

async function sendAx(card, opts) {
  const o = opts || {};
  if (card.seat === 'cursor-app' && !o.skipCursorCdp) {
    const cdp = await sendCursorComposer(card.body, o);
    if (cdp && cdp.submitted) return cdp;
  }
  const processName = o.processName || PROCESS_FOR_SEAT[card.seat] || 'Claude';
  const dir = o.root ? paths(o.root).dir : null;
  if (dir) ensureDir(o.root);
  const payload = JSON.stringify({
      processName,
      text: card.body,
      roles: o.roles || null,
      timeoutMs: o.axTimeoutMs || o.timeout || 90000,
      attachNeedle:
        o.attachNeedle === false
          ? null
          : typeof o.attachNeedle === 'string'
            ? o.attachNeedle
            : o.cwd
              ? path.basename(String(o.cwd))
              : null,
      expectedMode:
        typeof o.expectedMode === 'string'
          ? o.expectedMode
          : card.seat === 'chatgpt-chat-app'
            ? 'classic'
            : card.seat === 'chatgpt-modern-chat-app'
              ? 'chat'
              : null,
    });
  let temporaryDirectory = null;
  let payloadPath;
  if (o.root) {
    payloadPath = createPrivateTemp(o.root, 'ax-payload', payload);
  } else {
    temporaryDirectory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'convobus-ax-'));
    fs.chmodSync(temporaryDirectory, 0o700);
    payloadPath = path.join(temporaryDirectory, 'payload.json');
    fs.writeFileSync(payloadPath, payload, { flag: 'wx', mode: 0o600 });
  }

  const env = Object.assign({}, process.env, { CONVO_AX_PAYLOAD: payloadPath });
  const exe = convobusExe();
  const helper = axHelper();
  let r;
  try {
    r = exe
      ? spawnSync(exe, ['--ax-send'], {
        encoding: 'utf8',
        timeout: o.timeout || 120000,
        env,
        killSignal: 'SIGKILL',
      })
      : helper
        ? spawnSync(helper, ['send'], {
          encoding: 'utf8',
          timeout: o.timeout || 120000,
          env,
          killSignal: 'SIGKILL',
        })
        : runOsascript(['-l', 'JavaScript', JXA_PATH, 'send'], {
          timeout: o.timeout || 120000,
          env,
        });
  } finally {
    if (o.root) {
      try { removePrivateFile(payloadPath); } catch { /* leave an unsafe replacement untouched */ }
    } else if (temporaryDirectory) {
      try { fs.unlinkSync(payloadPath); } catch { /* ignore the operation's private file */ }
      try { fs.rmdirSync(temporaryDirectory); } catch { /* ignore the operation's private directory */ }
    }
  }
  const stdout = (r.stdout || '').trim();
  let parsed = lastJsonLine(stdout) || lastJsonLine(r.stderr || '');
  const tcc =
    /not allowed|not authorized|(-25211)|(-1719)|(-1743)|accessibility/i.test(
      (r.stderr || '') + stdout,
    );
  if (dir) {
    writePrivateText(
      path.join(dir, 'ax-last.json'),
      stdout || JSON.stringify({ stderr: r.stderr, error: r.error && r.error.message }),
    );
  }
  const reply = parsed && parsed.reply ? String(parsed.reply).trim() : '';
  const submitted = !!(parsed && (parsed.submitted || parsed.ok));
  const fragile = !!(parsed && parsed.fragile) || tcc;
  const completed = !!(parsed && parsed.ok && reply);
  if (o.root && card.seat) {
    markSeatRoles(o.root, card.seat, parsed && parsed.roles, fragile || !reply);
  }
  const dumpBits =
    parsed && (parsed.dump || parsed.hits != null)
      ? ` trusted=${parsed.trusted} pid=${parsed.pid} hits=${parsed.hits}\n${parsed.dump || ''}`
      : '';
  return {
    ok: !!(parsed && parsed.ok && reply),
    miss: !(parsed && (parsed.ok || parsed.submitted)),
    submitted,
    fragile,
    tcc,
    method: 'ax',
    reply: reply || null,
    reason: completed
      ? null
      : ((parsed && parsed.error) || r.stderr || (tcc ? 'osascript/TCC denied' : reply ? null : 'empty reply') || '') +
        dumpBits,
    stdout,
    stderr: r.stderr,
    snapshot: parsed && parsed.snapshot,
  };
}

module.exports = {
  JXA_PATH,
  HELPER,
  APP_EXE,
  convobusExe,
  jxaSource,
  axDump,
  axProbe,
  axProbeAsync,
  axFeed,
  sendAx,
  parseRolesFromDump,
  lastClaudeRespondedFromDump,
  PROCESS_FOR_SEAT,
  sendCursorComposer,
};
