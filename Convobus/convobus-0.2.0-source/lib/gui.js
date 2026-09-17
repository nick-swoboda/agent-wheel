'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  paths,
  liveCards,
  ensureDir,
  withStateLock,
  writePrivateText,
  writeJson,
  readJson,
  readLog,
  stateRevision,
} = require('./store');
const { loadSeats, formatSeats, bindSeat } = require('./seats');
const { runTurn } = require('./turn');
const {
  detectSurfaces,
  board,
  setAccessibility,
  readPrefs,
  writePrefs,
  sendMessage,
  testSend,
  decideGate,
  menuModel,
  menuModelAsync,
  providerModelAsync,
  setContextAsync,
  contextStatusAsync,
  cardsForContext,
  SURFACE_SEATS,
} = require('./control');
const { cardRecords } = require('./providers');
const {
  LoopError,
  listLoops,
  mutateLoop,
  startLoopRun,
  loopRunAction,
  getLoopRun,
  projectLoopHistory,
  loopsSnapshot,
  reconcileActiveRun,
  pauseActiveRunForShutdown,
} = require('./loops');

const GUI_PROTOCOL_VERSION = 3;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const TOKEN_HEADER = 'x-convobus-token';
const SESSION_COOKIE = 'convobus_session';
const SHUTDOWN_ROOTS = new Set();
let shutdownHandlersInstalled = false;

function installShutdownHandlers(root) {
  SHUTDOWN_ROOTS.add(path.resolve(root));
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  const checkpointAndExit = () => {
    for (const stateRoot of SHUTDOWN_ROOTS) {
      try { pauseActiveRunForShutdown(stateRoot); } catch { /* retain the last durable checkpoint */ }
    }
    process.exit(0);
  };
  process.once('SIGTERM', checkpointAndExit);
  process.once('SIGINT', checkpointAndExit);
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Convobus</title>
<style>
  body { font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; margin: 1.5rem; background: #111; color: #eee; max-width: 42rem; }
  h1 { font-size: 1.1rem; font-weight: 600; }
  .muted { color: #888; font-size: 0.9rem; }
  label { display: block; margin: 0.6rem 0 0.2rem; }
  select, textarea, button, input[type=text] { font: inherit; }
  textarea { width: 100%; min-height: 5rem; background: #1c1c1c; color: #eee; border: 1px solid #333; padding: 0.5rem; }
  select, input[type=text] { background: #1c1c1c; color: #eee; border: 1px solid #333; padding: 0.3rem; }
  button { margin-top: 0.4rem; padding: 0.4rem 0.9rem; }
  table { width: 100%; border-collapse: collapse; margin: 0.6rem 0 1rem; }
  th, td { text-align: left; padding: 0.35rem 0.4rem; border-bottom: 1px solid #333; }
  .row-on { background: #1a2420; }
  #gate { display: none; border: 1px solid #c84; padding: 0.8rem; margin: 0.8rem 0; }
  #gate.open { display: block; }
  ol#cards { list-style: none; padding: 0; }
  ol#cards li { border: 1px solid #333; padding: 0.6rem 0.8rem; margin: 0.5rem 0; }
  .meta { color: #9ab; font-size: 0.8rem; }
  .reply { white-space: pre-wrap; margin-top: 0.4rem; }
</style>
<h1>Convobus</h1>
<p class="muted">One transcript. This window reads <code>.convobus/log.ndjson</code>. It does not keep a second store.</p>
<table id="detect">
  <thead><tr><th>Seat</th><th>Status</th><th>Method</th></tr></thead>
  <tbody>
    <tr><td>Claude.app Cowork</td><td></td><td></td></tr>
    <tr><td>Claude Code CLI</td><td></td><td></td></tr>
    <tr><td>Cursor</td><td></td><td></td></tr>
    <tr><td>ChatGPT</td><td></td><td></td></tr>
  </tbody>
</table>
<label><input type="checkbox" id="ax"> Accessibility</label>
<div id="gate">
  <p id="gateReason"></p>
  <button type="button" id="accept">Accept</button>
  <button type="button" id="edit">Edit</button>
</div>
<form id="composer">
  <label for="seat">Seat</label>
  <select id="seat" name="seat"></select>
  <label for="directory">Directory</label>
  <input id="directory" name="directory" placeholder="Pick a folder" autocomplete="off">
  <label for="body">Message</label>
  <textarea id="body" name="body" placeholder="Type here. Send lands on the named seat."></textarea>
  <button type="submit" id="send">Send</button>
</form>
<p id="status" class="muted"></p>
<ol id="cards"></ol>
<script>
let pendingId = null;
async function loadDetect() {
  const r = await fetch('/api/detect', { cache: 'no-store' });
  const data = await r.json();
  const tb = document.querySelector('#detect tbody');
  tb.innerHTML = '';
  const sel = document.getElementById('seat');
  const keep = sel.value;
  sel.innerHTML = '';
  for (const s of data.seats || []) {
    const tr = document.createElement('tr');
    if (s.handle === data.currentSeat) tr.className = 'row-on';
    tr.innerHTML = '<td>' + s.name + '</td><td>' + s.attached + '</td><td>' + s.method + '</td>';
    tr.addEventListener('click', async () => {
      await fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentSeat: s.handle }) });
      loadDetect();
    });
    tb.appendChild(tr);
    const opt = document.createElement('option');
    opt.value = s.handle;
    opt.textContent = s.name + ' · ' + s.attached + ' · ' + s.method;
    sel.appendChild(opt);
  }
  if (keep) sel.value = keep;
  else if (data.currentSeat) sel.value = data.currentSeat;
  document.getElementById('ax').checked = !!data.accessibility;
}
async function loadSeats() { return loadDetect(); }
async function loadCards() {
  const r = await fetch('/api/cards', { cache: 'no-store' });
  const data = await r.json();
  const ol = document.getElementById('cards');
  ol.innerHTML = '';
  for (const c of data.cards || []) {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = (c.id || '') + ' · ' + (c.seat || '') + ' · ' + (c.state || '') + ' · from ' + (c.from || '');
    const body = document.createElement('div');
    body.textContent = c.body || '';
    li.appendChild(meta);
    li.appendChild(body);
    if (c.reply) {
      const reply = document.createElement('div');
      reply.className = 'reply';
      reply.textContent = c.reply;
      li.appendChild(reply);
    }
    ol.appendChild(li);
  }
}
function showGate(g, id) {
  pendingId = id || null;
  const el = document.getElementById('gate');
  if (!g) { el.classList.remove('open'); return; }
  document.getElementById('gateReason').textContent = (g.reason || '') + ' — Accept / Edit';
  el.classList.add('open');
}
async function sendMessageFromComposer() {
  const status = document.getElementById('status');
  status.textContent = 'sending…';
  const r = await fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seat: document.getElementById('seat').value,
      cwd: document.getElementById('directory').value,
      body: document.getElementById('body').value,
    }),
  });
  const data = await r.json();
  if (data.gate) {
    showGate(data.gate, data.pendingId);
    status.textContent = data.gate.reason || 'gate';
    return;
  }
  showGate(null);
  status.textContent = data.error || ((data.card && data.card.state === 'waiting') ? 'Waiting for reply…' : 'Sent');
  loadCards();
  loadDetect();
}
document.getElementById('composer').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  sendMessageFromComposer();
});
document.getElementById('ax').addEventListener('change', async function (ev) {
  await fetch('/api/accessibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ granted: ev.target.checked }),
  });
  loadDetect();
});
document.getElementById('accept').addEventListener('click', async function () {
  const r = await fetch('/api/gate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'accept', pendingId: pendingId }),
  });
  const data = await r.json();
  showGate(null);
  document.getElementById('status').textContent = data.error || 'Sent';
  loadCards();
  loadDetect();
});
document.getElementById('edit').addEventListener('click', async function () {
  await fetch('/api/gate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'edit', pendingId: pendingId }),
  });
  showGate(null);
  document.getElementById('status').textContent = 'edit';
});
loadDetect();
loadCards();
setInterval(loadCards, 1200);
</script>
`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
      const err = new Error('request body too large');
      err.code = 'CONVO_BODY_TOO_LARGE';
      req.resume();
      reject(err);
      return;
    }
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_REQUEST_BYTES) {
        settled = true;
        const err = new Error('request body too large');
        err.code = 'CONVO_BODY_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function requestOrigin(identity) {
  return `http://127.0.0.1:${identity.port}`;
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function authorizedRequest(req, identity) {
  // Official callers must prove the launch token; browser mutations also prove the exact loopback origin.
  if (!identity || !identity.token) return false;
  const header = String(req.headers[TOKEN_HEADER] || '');
  if (
    header.length === identity.token.length &&
    crypto.timingSafeEqual(Buffer.from(header), Buffer.from(identity.token))
  ) return true;
  const cookie = cookieValue(req, SESSION_COOKIE);
  if (!cookie || cookie.length !== identity.token.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(identity.token))) return false;
  return String(req.headers.origin || '') === requestOrigin(identity);
}

function validHost(req, identity) {
  if (!identity) return true;
  return String(req.headers.host || '') === `127.0.0.1:${identity.port}`;
}

function bodyError(res, err) {
  if (err && err.code === 'CONVO_BODY_TOO_LARGE') {
    json(res, 413, { error: 'request body too large' });
  } else {
    json(res, 400, { error: 'invalid json' });
  }
}

function cardsFromLog(root) {
  const byId = new Map();
  for (const event of readLog(root)) {
    if (event.runId) continue;
    if (event.card && event.card.id) byId.set(event.card.id, event.card);
  }
  return [...byId.values()];
}

function loopError(res, error) {
  const status = error instanceof LoopError ? error.status : 500;
  const payload = {
    error: String(error && error.message ? error.message : error),
  };
  if (error instanceof LoopError) {
    payload.code = error.code;
    if (error.details) payload.details = error.details;
  }
  json(res, status, payload);
}

function contextCardsResponse(root, payload) {
  const records = cardsForContext(root, payload);
  const ids = new Set(records.map((record) => record.id));
  return {
    cards: records.map((record) => record.card),
    records,
    inflight: liveCards(root).filter((card) => ids.has(card.id)),
  };
}

async function handleGuiRequest(root, req, res, identity) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!validHost(req, identity)) {
    json(res, 403, { error: 'forbidden host' });
    return;
  }
  if (req.method === 'POST') {
    if (!authorizedRequest(req, identity)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      json(res, 415, { error: 'application/json required' });
      return;
    }
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    };
    if (identity && identity.token) {
      headers['Set-Cookie'] = `${SESSION_COOKIE}=${identity.token}; HttpOnly; SameSite=Strict; Path=/`;
    }
    res.writeHead(200, headers);
    res.end(PAGE);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/log') {
    const file = paths(root).log;
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(text);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/seats') {
    json(res, 200, loadSeats(root));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const healthy = { ok: true };
    if (authorizedRequest(req, identity)) {
      Object.assign(healthy, {
        protocolVersion: identity.protocolVersion,
        root: identity.root,
        instanceId: identity.instanceId,
        pid: process.pid,
      });
    }
    json(res, 200, healthy);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/detect') {
    json(res, 200, detectSurfaces(root, { home: url.searchParams.get('home') || undefined }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/providers') {
    json(res, 200, await providerModelAsync(root, { home: url.searchParams.get('home') || undefined }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/native-snapshot') {
    if (!authorizedRequest(req, identity)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    const requested = {};
    for (const key of ['provider', 'project', 'surface', 'type']) {
      if (url.searchParams.has(key)) requested[key] = url.searchParams.get(key);
    }
    const build = async () => {
      const providers = await providerModelAsync(root, { home: url.searchParams.get('home') || undefined });
      const context = Object.keys(requested).length === 4 ? requested : providers.selection;
      return {
        providers,
        menu: menuModel(root, { fast: true, catalog: providers, activeStatus: providers.status }),
        cards: context ? contextCardsResponse(root, context) : { cards: [], records: [], inflight: [] },
        loops: loopsSnapshot(root, context && context.project),
      };
    };
    let before = stateRevision(root);
    let snapshot = await build();
    let after = stateRevision(root);
    if (before !== after) {
      before = after;
      snapshot = await build();
      after = stateRevision(root);
    }
    json(res, 200, { revision: after, ...snapshot });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/route-status') {
    const payload = {};
    for (const key of ['provider', 'project', 'surface', 'type']) {
      if (url.searchParams.has(key)) payload[key] = url.searchParams.get(key);
    }
    json(res, 200, await contextStatusAsync(root, payload, { home: url.searchParams.get('home') || undefined }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/board') {
    json(res, 200, board(root));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/menu') {
    json(res, 200, await menuModelAsync(root, { fast: url.searchParams.get('fast') === '1' }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/accessibility') {
    json(res, 200, { granted: !!readPrefs(root).accessibility });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/loops') {
    if (!authorizedRequest(req, identity)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    json(res, 200, listLoops(root, url.searchParams.get('project')));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/loop-history') {
    if (!authorizedRequest(req, identity)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    try {
      json(res, 200, projectLoopHistory(root, url.searchParams.get('project'), {
        cursor: url.searchParams.get('cursor'),
        limit: url.searchParams.get('limit'),
      }));
    } catch (error) {
      loopError(res, error);
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/loops') {
    try {
      const payload = JSON.parse((await readBody(req)) || '{}');
      json(res, 200, mutateLoop(root, payload));
    } catch (error) {
      if (error instanceof SyntaxError) bodyError(res, error);
      else loopError(res, error);
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/loop-runs') {
    try {
      const payload = JSON.parse((await readBody(req)) || '{}');
      json(res, 200, startLoopRun(root, payload, { home: payload.home }));
    } catch (error) {
      if (error instanceof SyntaxError) bodyError(res, error);
      else loopError(res, error);
    }
    return;
  }
  const loopRunMatch = url.pathname.match(/^\/api\/loop-runs\/([^/]+)$/);
  if (req.method === 'GET' && loopRunMatch) {
    if (!authorizedRequest(req, identity)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    try {
      json(res, 200, getLoopRun(root, decodeURIComponent(loopRunMatch[1]), {
        cursor: url.searchParams.get('cursor'),
        limit: url.searchParams.get('limit'),
      }));
    } catch (error) {
      loopError(res, error);
    }
    return;
  }
  const loopActionMatch = url.pathname.match(/^\/api\/loop-runs\/([^/]+)\/action$/);
  if (req.method === 'POST' && loopActionMatch) {
    try {
      const payload = JSON.parse((await readBody(req)) || '{}');
      json(res, 200, loopRunAction(root, decodeURIComponent(loopActionMatch[1]), payload, { home: payload.home }));
    } catch (error) {
      if (error instanceof SyntaxError) bodyError(res, error);
      else loopError(res, error);
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/accessibility') {
    let payload = {};
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      bodyError(res, err);
      return;
    }
    const prefs = setAccessibility(root, !!payload.granted);
    json(res, 200, { granted: !!prefs.accessibility });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/prefs') {
    let payload = {};
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      bodyError(res, err);
      return;
    }
    const patch = {};
    if (payload.currentSeat) patch.currentSeat = payload.currentSeat;
    json(res, 200, writePrefs(root, patch));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/context') {
    let payload = {};
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      bodyError(res, err);
      return;
    }
    const result = await setContextAsync(root, payload, { home: payload.home });
    json(res, result.ok ? 200 : 400, result);
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/api/send' || url.pathname === '/api/test-send')) {
    let payload = {};
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      bodyError(res, err);
      return;
    }
    const r = url.pathname === '/api/send' ? await sendMessage(root, payload) : await testSend(root, payload);
    json(res, r.code && r.code !== 0 && !r.gate ? 400 : 200, r);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/gate') {
    let payload = {};
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      bodyError(res, err);
      return;
    }
    const r = await decideGate(root, payload.action, payload.pendingId);
    json(res, r.code && r.code !== 0 && !r.gate && !r.edited ? 400 : 200, r);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/cards') {
    const hasContext = ['provider', 'project', 'surface', 'type'].every((key) => url.searchParams.has(key));
    if (hasContext) {
      const payload = {
        provider: url.searchParams.get('provider'),
        project: url.searchParams.get('project'),
        surface: url.searchParams.get('surface'),
        type: url.searchParams.get('type'),
      };
      json(res, 200, contextCardsResponse(root, payload));
      return;
    }
    const records = cardRecords(root).filter((record) => !record.runId);
    const ids = new Set(records.map((record) => record.id));
    json(res, 200, {
      cards: cardsFromLog(root),
      records,
      inflight: liveCards(root).filter((card) => ids.has(card.id)),
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/inflight') {
    json(res, 200, { cards: liveCards(root) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/bind') {
    let payload = {};
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      bodyError(res, err);
      return;
    }
    const r = bindSeat(root, payload.seat, payload.cwd);
    json(res, r.code === 0 ? 200 : 400, { seat: r.seat, error: r.code ? String(r.text || '').trim() : undefined });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/turn') {
    let payload = {};
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      bodyError(res, err);
      return;
    }
    if (payload.cwd) bindSeat(root, payload.seat, payload.cwd);
    const argv = Array.isArray(payload.argv) ? payload.argv.map(String) : [];
    if (argv.includes('--cloud') || payload.cloud || /claude:\/\/cowork\/new/i.test(String(payload.body || ''))) {
      json(res, 400, { error: 'never --cloud' });
      return;
    }
    const r = await runTurn(root, {
      seat: payload.seat,
      method: payload.method,
      from: payload.from || 'human',
      body: payload.body,
      cwd: payload.cwd,
      argv: payload.argv,
      sessionFile: payload.sessionFile,
      fileWins: payload.fileWins,
      timeout: payload.timeout,
      home: payload.home,
    });
    json(res, r.code === 0 ? 200 : 400, {
      card: r.card,
      code: r.code,
      error: r.gated ? String(r.text || '').trim() : undefined,
      text: r.text,
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
}

function listenGui(root, port, opts) {
  const o = opts || {};
  ensureDir(root);
  reconcileActiveRun(root);
  installShutdownHandlers(root);
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  const identity = {
    token: String(o.token || process.env.CONVO_GUI_TOKEN || crypto.randomBytes(32).toString('hex')),
    instanceId: String(o.instanceId || process.env.CONVO_GUI_INSTANCE || crypto.randomUUID()),
    protocolVersion: GUI_PROTOCOL_VERSION,
    root: canonicalRoot,
    port: null,
  };
  const requested = port == null ? 7421 : Number(port);
  const wantAuto = port == null || requested === 7421;
  function tryListen(p) {
    if (p === 7420) return tryListen(p + 1);
    const server = http.createServer((req, res) => {
      handleGuiRequest(root, req, res, identity).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: String(err && err.message ? err.message : err) });
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', (err) => {
        if (wantAuto && err && err.code === 'EADDRINUSE' && p < 7435) {
          tryListen(p + 1).then(resolve, reject);
          return;
        }
        reject(err);
      });
      server.listen({ port: p, host: '127.0.0.1', exclusive: true }, () => {
        const addr = server.address();
        identity.port = addr.port;
        try {
          if (process.env.CONVO_NO_PORT_FILE !== '1') {
            ensureDir(root);
            writePrivateText(path.join(paths(root).dir, 'gui.port'), String(addr.port) + '\n');
          }
          writeJson(path.join(paths(root).dir, 'gui.json'), {
            token: identity.token,
            pid: process.pid,
            port: addr.port,
            root: identity.root,
            protocolVersion: identity.protocolVersion,
            instanceId: identity.instanceId,
            startedAt: new Date().toISOString(),
          });
        } catch {
          /* ignore */
        }
        server.once('close', () => {
          try { pauseActiveRunForShutdown(root); } catch { /* preserve an existing checkpoint on shutdown */ }
          try {
            withStateLock(root, () => {
              const registry = readJson(path.join(paths(root).dir, 'gui.json'), null);
              if (registry && registry.instanceId === identity.instanceId) {
                fs.unlinkSync(path.join(paths(root).dir, 'gui.json'));
              }
            });
          } catch {
            /* a stale registry is rejected by authenticated identity checks */
          }
        });
        resolve({
          server,
          port: addr.port,
          url: 'http://127.0.0.1:' + addr.port,
          token: identity.token,
          instanceId: identity.instanceId,
          protocolVersion: identity.protocolVersion,
          root: identity.root,
        });
      });
    });
  }
  return tryListen(requested === 0 ? 0 : requested);
}

async function startGui(root, port) {
  const g = await listenGui(root, port);
  process.stdout.write(`convobus window ${g.url}/ (reads log.ndjson)\n`);
  return new Promise(() => {});
}

module.exports = {
  startGui,
  listenGui,
  handleGuiRequest,
  PAGE,
  GUI_PROTOCOL_VERSION,
  MAX_REQUEST_BYTES,
  TOKEN_HEADER,
  readBody,
  formatSeats,
  detectSurfaces,
  SURFACE_SEATS,
};
