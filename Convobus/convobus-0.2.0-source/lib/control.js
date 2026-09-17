'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  paths,
  ensureDir,
  withStateLock,
  writeJson,
  readJson,
  removePrivateFile,
  liveCards,
  readLog,
} = require('./store');
const { loadSeats, HANDLE_MAP, bindSeat } = require('./seats');
const { resolveVendorSession } = require('./methods/filewins');
const { axProbe, axProbeAsync } = require('./methods/ax');
const { runTurn } = require('./turn');
const { loadGraph, hasPlan, isLeaf, nothingBuilt } = require('./graph');
const { LEGACY_SURFACES } = require('./catalog');
const {
  PROVIDERS,
  canonicalProject,
  projectExists,
  routeFor,
  publicRoute,
  normalizedRoute,
  normalizeUi,
  discoverProjects,
  selectedContext,
  routeStatus,
  routeStatusAsync,
  providerCatalog,
  cardRecords,
} = require('./providers');
const { loopsSnapshot } = require('./loops');

const SURFACE_SEATS = LEGACY_SURFACES.map((surface) => ({ ...surface }));

const METHODS = new Set(['stdio', 'ax', 'none']);
const ATTACHED = new Set(['attached', 'not', 'blocked']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MENU_STATUS_CACHE = new Map();
const MENU_STATUS_TTL_MS = 5000;
const MENU_DETECT_CACHE = new Map();
const CHATGPT_CLASSIC_BUNDLE = 'com.openai.chat';
const CHATGPT_APP_BUNDLE = 'com.openai.codex';
// AX helper startup can take several seconds on a cold launch. Keep one result
// long enough that the window and menu-bar polls share it instead of forming a
// request queue behind duplicate probes.
const ACCESSIBILITY_PROBE_TTL_MS = 15000;
const ACCESSIBILITY_PROBE_CACHE = new Map();
const ACCESSIBILITY_PROBE_PENDING = new Map();

function prefsPath(root) {
  return path.join(paths(root).dir, 'prefs.json');
}

function pendingPath(root) {
  return path.join(paths(root).dir, 'gate.json');
}

function readPrefs(root) {
  ensureDir(root);
  const p = prefsPath(root);
  const d = fs.existsSync(p) ? readJson(p, {}) : {};
  return {
    accessibility: !!d.accessibility,
    axAccepted: !!d.axAccepted,
    currentSeat: d.currentSeat || null,
    board: d.board || null,
    ui: normalizeUi(d.ui),
  };
}

function mergeStoredUi(previous, next) {
  const oldUi = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
  const newUi = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
  const merged = { ...oldUi, ...newUi };
  if (newUi.lastProjectByProvider && typeof newUi.lastProjectByProvider === 'object') {
    merged.lastProjectByProvider = {
      ...(oldUi.lastProjectByProvider && typeof oldUi.lastProjectByProvider === 'object'
        ? oldUi.lastProjectByProvider
        : {}),
      ...newUi.lastProjectByProvider,
    };
  }
  if (Array.isArray(newUi.projects)) {
    const oldProjects = Array.isArray(oldUi.projects) ? oldUi.projects : [];
    const used = new Set();
    merged.projects = newUi.projects.map((project) => {
      const projectPath = canonicalProject(project && project.path);
      const index = oldProjects.findIndex(
        (candidate, i) => !used.has(i) && canonicalProject(candidate && candidate.path) === projectPath,
      );
      if (index < 0) return project;
      used.add(index);
      const oldProject = oldProjects[index] || {};
      const routes = { ...(oldProject.routes || {}) };
      for (const [provider, route] of Object.entries((project && project.routes) || {})) {
        routes[provider] = { ...((oldProject.routes && oldProject.routes[provider]) || {}), ...route };
      }
      return { ...oldProject, ...project, routes };
    });
    for (let i = 0; i < oldProjects.length; i += 1) {
      if (!used.has(i)) merged.projects.push(oldProjects[i]);
    }
  }
  return merged;
}

function writePrefs(root, patch) {
  return withStateLock(root, () => {
    ensureDir(root);
    const file = prefsPath(root);
    const raw = fs.existsSync(file) ? readJson(file, {}) : {};
    const next = Object.assign({}, raw, patch || {});
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'ui')) {
      next.ui = mergeStoredUi(raw.ui, patch.ui);
    }
    writeJson(file, next);
    return readPrefs(root);
  });
}

function routeInput(payload) {
  const o = payload || {};
  const source = o.route && typeof o.route === 'object' ? o.route : o;
  return {
    provider: source.provider,
    project: source.project || o.project || o.cwd,
    surface: source.surface,
    type: source.type,
  };
}

function probeAccessibilityApp(selector, opts) {
  const o = opts || {};
  if (Object.prototype.hasOwnProperty.call(o, 'appProbe')) {
    return o.appProbe || { running: false, composer: false, tcc: false, error: null };
  }
  const now = Date.now();
  const cached = ACCESSIBILITY_PROBE_CACHE.get(selector);
  const cacheTtl =
    selector === CHATGPT_APP_BUNDLE && cached && !cached.value.mode
      ? 1000
      : ACCESSIBILITY_PROBE_TTL_MS;
  if (
    cached &&
    now - cached.at < cacheTtl
  ) {
    return cached.value;
  }
  const dump = axProbe(selector, { timeout: 5000 });
  const value = {
    running: !!dump.running,
    composer: !!dump.composer,
    send: !!dump.send,
    mode: dump.mode || null,
    pid: dump.pid || null,
    tcc: !!dump.tcc,
    error: dump.ok ? null : dump.error || 'Accessibility probe failed',
  };
  if (
    selector === CHATGPT_APP_BUNDLE &&
    value.running &&
    value.composer &&
    !value.mode &&
    cached &&
    cached.value.mode &&
    cached.value.pid &&
    cached.value.pid === value.pid
  ) {
    value.mode = cached.value.mode;
  }
  ACCESSIBILITY_PROBE_CACHE.set(selector, { at: now, value });
  return value;
}

function probeAccessibilityAppAsync(selector, opts) {
  const o = opts || {};
  if (Object.prototype.hasOwnProperty.call(o, 'appProbe')) {
    return Promise.resolve(o.appProbe || { running: false, composer: false, tcc: false, error: null });
  }
  const now = Date.now();
  const cached = ACCESSIBILITY_PROBE_CACHE.get(selector);
  const cacheTtl =
    selector === CHATGPT_APP_BUNDLE && cached && !cached.value.mode
      ? 1000
      : ACCESSIBILITY_PROBE_TTL_MS;
  if (cached && now - cached.at < cacheTtl) return Promise.resolve(cached.value);
  if (ACCESSIBILITY_PROBE_PENDING.has(selector)) return ACCESSIBILITY_PROBE_PENDING.get(selector);
  const pending = axProbeAsync(selector, { timeout: 5000 }).then((dump) => {
    const value = {
      running: !!dump.running,
      composer: !!dump.composer,
      send: !!dump.send,
      mode: dump.mode || null,
      pid: dump.pid || null,
      tcc: !!dump.tcc,
      error: dump.ok ? null : dump.error || 'Accessibility probe failed',
    };
    if (
      selector === CHATGPT_APP_BUNDLE &&
      value.running &&
      value.composer &&
      !value.mode &&
      cached &&
      cached.value.mode &&
      cached.value.pid &&
      cached.value.pid === value.pid
    ) {
      value.mode = cached.value.mode;
    }
    ACCESSIBILITY_PROBE_CACHE.set(selector, { at: Date.now(), value });
    return value;
  }).finally(() => {
    ACCESSIBILITY_PROBE_PENDING.delete(selector);
  });
  ACCESSIBILITY_PROBE_PENDING.set(selector, pending);
  return pending;
}

function probeChatGPTClassic(opts) {
  const o = opts || {};
  if (Object.prototype.hasOwnProperty.call(o, 'chatgptClassicProbe')) {
    return o.chatgptClassicProbe || { running: false, composer: false, tcc: false, error: null };
  }
  return probeAccessibilityApp(CHATGPT_CLASSIC_BUNDLE, o);
}

function probeChatGPTChat(opts) {
  const o = opts || {};
  if (Object.prototype.hasOwnProperty.call(o, 'chatgptChatProbe')) {
    return o.chatgptChatProbe || { running: false, composer: false, mode: null, tcc: false, error: null };
  }
  return probeAccessibilityApp(CHATGPT_APP_BUNDLE, o);
}

function exactRouteStatus(root, input, prefs, opts) {
  const route = routeFor(input);
  const statusOpts = {
    home: opts && opts.home,
    accessibility: !!(prefs && prefs.accessibility),
  };
  if (route && route.seat === 'chatgpt-chat-app' && statusOpts.accessibility) {
    statusOpts.chatgptProbe = probeChatGPTClassic(opts);
  }
  if (route && route.seat === 'chatgpt-modern-chat-app' && statusOpts.accessibility) {
    statusOpts.chatgptProbe = probeChatGPTChat(opts);
  }
  if (route && route.seat === 'claude-app' && statusOpts.accessibility) {
    statusOpts.appProbe = probeAccessibilityApp('Claude', opts);
  }
  return routeStatus(root, input, statusOpts);
}

async function exactRouteStatusAsync(root, input, prefs, opts) {
  const route = routeFor(input);
  const statusOpts = {
    home: opts && opts.home,
    accessibility: !!(prefs && prefs.accessibility),
  };
  if (route && route.seat === 'chatgpt-chat-app' && statusOpts.accessibility) {
    statusOpts.chatgptProbe = Object.prototype.hasOwnProperty.call(opts || {}, 'chatgptClassicProbe')
      ? (opts.chatgptClassicProbe || {})
      : await probeAccessibilityAppAsync(CHATGPT_CLASSIC_BUNDLE, opts);
  }
  if (route && route.seat === 'chatgpt-modern-chat-app' && statusOpts.accessibility) {
    statusOpts.chatgptProbe = Object.prototype.hasOwnProperty.call(opts || {}, 'chatgptChatProbe')
      ? (opts.chatgptChatProbe || {})
      : await probeAccessibilityAppAsync(CHATGPT_APP_BUNDLE, opts);
  }
  if (route && route.seat === 'claude-app' && statusOpts.accessibility) {
    statusOpts.appProbe = await probeAccessibilityAppAsync('Claude', opts);
  }
  return routeStatusAsync(root, input, statusOpts);
}

function contextStatus(root, payload, opts) {
  const prefs = readPrefs(root);
  const input = payload && Object.keys(payload).length ? routeInput(payload) : selectedContext(root, prefs);
  return exactRouteStatus(root, input, prefs, opts);
}

async function contextStatusAsync(root, payload, opts) {
  const prefs = readPrefs(root);
  const input = payload && Object.keys(payload).length ? routeInput(payload) : selectedContext(root, prefs);
  return exactRouteStatusAsync(root, input, prefs, opts);
}

function providerModel(root, opts) {
  const prefs = readPrefs(root);
  const model = providerCatalog(root, prefs);
  const status = contextStatus(root, model.selection, opts);
  return {
    ...model,
    status,
  };
}

async function providerModelAsync(root, opts) {
  const prefs = readPrefs(root);
  const model = providerCatalog(root, prefs);
  const status = await exactRouteStatusAsync(root, model.selection, prefs, opts);
  return { ...model, status };
}

function setContext(root, payload, opts) {
  const normalized = normalizedRoute(routeInput(payload));
  if (!normalized) {
    return { ok: false, code: 400, error: 'unknown route' };
  }
  if (!normalized.project) {
    return { ok: false, code: 400, error: 'choose a project' };
  }
  if (!projectExists(normalized.project)) {
    return { ok: false, code: 400, error: 'project folder is missing' };
  }

  const route = routeFor(normalized);
  const transaction = withStateLock(root, () => {
    const bound = bindSeat(root, route.seat, normalized.project);
    if (!bound || bound.code !== 0) {
      return {
        error: String((bound && bound.text) || 'could not bind project').trim(),
      };
    }

    const prefs = readPrefs(root);
    const ui = normalizeUi(prefs.ui);
    let project = ui.projects.find((entry) => entry.path === normalized.project);
    if (!project) {
      project = { path: normalized.project, lastUsedAt: null, routes: {} };
      ui.projects.push(project);
    }
    project.lastUsedAt = new Date().toISOString();
    project.routes = project.routes || {};
    project.routes[normalized.provider] = {
      surface: normalized.surface,
      type: normalized.type,
    };
    ui.selectedProvider = normalized.provider;
    ui.selectedProject = normalized.project;
    ui.lastProjectByProvider = ui.lastProjectByProvider || {};
    ui.lastProjectByProvider[normalized.provider] = normalized.project;
    return { next: writePrefs(root, { ui, currentSeat: route.seat }) };
  });
  if (transaction.error) return { ok: false, code: 400, error: transaction.error };

  const context = { ...publicRoute(route), project: normalized.project };
  return {
    ok: true,
    code: 0,
    context,
    status: opts && opts.skipStatus ? null : contextStatus(root, context, opts),
    prefs: transaction.next,
  };
}

async function setContextAsync(root, payload, opts) {
  const result = setContext(root, payload, { ...(opts || {}), skipStatus: true });
  if (!result.ok) return result;
  result.status = await contextStatusAsync(root, result.context, opts);
  return result;
}

function cardsForContext(root, payload, opts) {
  const normalized = normalizedRoute(routeInput(payload));
  if (!normalized || !normalized.project) return [];
  const includeLoops = !!(opts && opts.includeLoops);
  return cardRecords(root)
    .filter(
      (record) =>
        (includeLoops || !record.runId) &&
        record.route.provider === normalized.provider &&
        record.route.project === normalized.project &&
        record.route.surface === normalized.surface &&
        record.route.type === normalized.type,
    )
    .sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')));
}

function setAccessibility(root, granted) {
  return writePrefs(root, { accessibility: !!granted });
}

function refuseForbidden(payload) {
  const o = payload || {};
  const argv = Array.isArray(o.argv) ? o.argv.map(String) : [];
  const blob = [o.body, o.sessionId, o.sessionFile, argv.join(' ')].map((x) => String(x || '')).join(' ');
  if (argv.includes('--cloud') || /\b--cloud\b/.test(blob)) {
    return 'never --cloud';
  }
  if (/claude:\/\/cowork\/new/i.test(blob)) {
    return 'never claude://cowork/new';
  }
  if (o.mint === true || o.fork === true) {
    return 'never mint';
  }
  return null;
}

function installed(def, row) {
  if (!def) return false;
  if (def.kind === 'cli') return !!(row && row.path) && row.state !== 'missing';
  if (def.kind === 'app') return !!(row && row.path) && row.state !== 'missing';
  return row && row.state !== 'missing';
}

function sessionFor(handle, cwd, home, skipIds) {
  if (!cwd) return { id: null, file: null, kind: null, why: null };
  const sess = resolveVendorSession(handle, cwd, home, { skipIds: skipIds || [] }) || {};
  if (handle === 'claude-app') {
    if (sess.kind === 'jsonl' || sess.kind === 'code' || (sess.id && UUID_RE.test(String(sess.id)))) {
      return { id: null, file: null, kind: null, why: null, skippedCode: true };
    }
  }
  return {
    id: sess.id || null,
    file: sess.file || null,
    kind: sess.kind || null,
    why: sess.why || null,
  };
}

function methodFor(handle, attach, prefs) {
  if (attach !== 'attached') return 'none';
  if (handle === 'claude-app') return prefs.accessibility ? 'ax' : 'none';
  if (handle === 'claude-cli' || handle === 'cursor-app' || handle === 'chatgpt-app') return 'stdio';
  return 'none';
}

function attachState(handle, row, def, sess, prefs) {
  if (!installed(def, row)) return 'blocked';
  if (handle === 'claude-app' && sess && sess.id && !prefs.accessibility) return 'blocked';
  if (sess && sess.id) return 'attached';
  return 'not';
}

function detectSurfaces(root, opts) {
  const o = opts || {};
  const home = o.home || process.env.HOME || require('os').homedir();
  const prefs = readPrefs(root);
  const data = loadSeats(root);
  const byHandle = new Map((data.seats || []).map((s) => [s.handle, s]));
  const seats = SURFACE_SEATS.map((spec) => {
    const def = HANDLE_MAP.get(spec.handle);
    const row = byHandle.get(spec.handle) || {};
    const cwd = o.cwd || row.cwd || null;
    const sess = sessionFor(spec.handle, cwd, home, o.skipIds);
    const attached = attachState(spec.handle, row, def, sess, prefs);
    const method = methodFor(spec.handle, attached, prefs);
    return {
      handle: spec.handle,
      name: spec.name,
      attached,
      method,
      sessionId: attached === 'attached' ? sess.id : null,
      sessionFile: attached === 'attached' ? sess.file : null,
      why: sess.why || null,
      cwd: cwd || null,
    };
  });
  const live = liveCards(root) || [];
  let icon = 'idle';
  if (live.length) icon = 'waiting';
  else if (seats.some((s) => s.attached === 'blocked') && !seats.some((s) => s.attached === 'attached')) icon = 'blocked';
  else if (seats.some((s) => s.attached === 'attached')) icon = 'attached';
  const current = prefs.currentSeat && seats.find((s) => s.handle === prefs.currentSeat);
  if (current && current.attached === 'blocked' && icon === 'attached') icon = 'blocked';
  return {
    seats,
    icon,
    accessibility: prefs.accessibility,
    currentSeat: prefs.currentSeat || (seats.find((s) => s.attached === 'attached') || seats[0]).handle,
  };
}

function detectSurfacesFast(root) {
  const prefs = readPrefs(root);
  const data = loadSeats(root);
  const byHandle = new Map((data.seats || []).map((seat) => [seat.handle, seat]));
  const seats = SURFACE_SEATS.map((spec) => {
    const row = byHandle.get(spec.handle) || {};
    const def = HANDLE_MAP.get(spec.handle);
    return {
      handle: spec.handle,
      name: spec.name,
      attached: installed(def, row) ? 'not' : 'blocked',
      method: 'none',
      sessionId: null,
      sessionFile: null,
      why: null,
      cwd: row.cwd || null,
    };
  });
  return {
    seats,
    icon: liveCards(root).length ? 'waiting' : 'idle',
    accessibility: prefs.accessibility,
    currentSeat: prefs.currentSeat || seats[0].handle,
  };
}

function board(root) {
  const prefs = readPrefs(root);
  const recs = readLog(root) || [];
  let last = null;
  let sessionId = null;
  const sessionByCard = new Map();
  for (const rec of recs) {
    if (rec.runId) continue;
    if (rec.event === 'attach' && rec.sessionId) {
      sessionId = rec.sessionId;
      const id = rec.id || (rec.card && rec.card.id);
      if (id) sessionByCard.set(id, rec.sessionId);
    }
    if (rec.event === 'stage' && rec.card) last = rec;
    if (rec.event === 'reply' && rec.card && rec.card.reply) last = rec;
  }
  if (!last || !last.card) {
    if (prefs.board && prefs.board.lastCard) return prefs.board;
    return { lastCard: null, lastToken: null, method: null, sessionId: sessionId || null };
  }
  return {
    lastCard: last.card.id || null,
    lastToken: last.card.reply ? String(last.card.reply).trim() : null,
    method: last.card.method || last.method || null,
    sessionId: sessionByCard.get(last.card.id) || last.sessionId || sessionId || null,
  };
}

function newIdeaFromPlan(root, body) {
  const text = String(body || '');
  if (/\bnew idea\b/i.test(text)) return true;
  if (!root || !hasPlan(root)) return false;
  const graph = loadGraph(root);
  if (!graph || !graph.nodes) return false;
  for (const n of graph.nodes.values()) {
    if (!n || !n.id) continue;
    if (text.includes(n.id) && isLeaf(n) && nothingBuilt(n) && n.kind !== 'constraint') return true;
  }
  return false;
}

function gateReason(root, payload, row, prefs) {
  const o = payload || {};
  const body = String(o.body || '');
  const method = o.method || (row && row.method) || 'none';
  if (o.want === 'new session' || /\bnew session\b/i.test(body)) return 'new session';
  if (row && row.attached !== 'attached' && !(o.argv && o.argv.length) && !o.sessionFile) return 'new session';
  if (o.want === 'new idea' || newIdeaFromPlan(root, body)) return 'new idea';
  if ((method === 'ax' || o.want === 'ax' || o.want === 'first-time AX') && !prefs.axAccepted) {
    return 'first-time AX';
  }
  return null;
}

function readPending(root) {
  const p = pendingPath(root);
  if (!fs.existsSync(p)) return null;
  return readJson(p, null);
}

function savePending(root, rec) {
  ensureDir(root);
  const id = rec.id || 'gate_' + crypto.randomBytes(4).toString('hex');
  const row = Object.assign({ id }, rec);
  writeJson(pendingPath(root), row);
  return row;
}

function clearPending(root) {
  return removePrivateFile(pendingPath(root));
}

function lastAttachId(root, cardId) {
  const recs = readLog(root) || [];
  let sid = null;
  for (const rec of recs) {
    if (rec.event !== 'attach') continue;
    if (cardId && rec.id && rec.id !== cardId && !(rec.card && rec.card.id === cardId)) continue;
    if (rec.sessionId) sid = rec.sessionId;
  }
  return sid;
}

async function testSendRoute(root, payload) {
  const o = payload || {};
  const normalized = normalizedRoute(routeInput(o));
  if (!normalized) {
    return { ok: false, code: 400, error: 'unknown route', proceed: false };
  }
  if (!normalized.project) {
    return { ok: false, code: 400, error: 'choose a project', proceed: false };
  }
  const route = routeFor(normalized);
  const bound = bindSeat(root, route.seat, normalized.project);
  if (!bound || bound.code !== 0) {
    return {
      ok: false,
      code: 400,
      error: String((bound && bound.text) || 'project folder is missing').trim(),
      proceed: false,
    };
  }

  const prefs = readPrefs(root);
  const status = await contextStatusAsync(root, normalized, { home: o.home });
  if (status.status !== 'attached') {
    return {
      ok: false,
      code: 400,
      error: status.reason || 'route is not attached',
      proceed: false,
      status,
    };
  }
  if (o.method && o.method !== status.method) {
    return { ok: false, code: 400, error: 'method does not match route', proceed: false, status };
  }

  const row = { attached: 'attached', method: status.method };
  if (!o.accept) {
    const reason = gateReason(root, o, row, prefs);
    if (reason) {
      const pending = savePending(root, {
        payload: o,
        reason,
        seat: route.seat,
        cardId: o.id || null,
      });
      return {
        ok: true,
        proceed: false,
        gate: { reason, choices: ['Accept', 'Edit'] },
        pendingId: pending.id,
        board: board(root),
        status,
      };
    }
  }

  const token = o.token || 'CONV-' + crypto.randomBytes(3).toString('hex');
  const body =
    o.body && !o.forceTokenBody
      ? String(o.body)
      : `Convobus test ${token}. Reply with exactly ${token} and no other text.`;
  const routeValue = {
    provider: normalized.provider,
    project: normalized.project,
    surface: normalized.surface,
    type: normalized.type,
  };
  const r = await runTurn(root, {
    seat: route.seat,
    variant: route.variant,
    route: routeValue,
    method: status.method,
    methodExplicit: true,
    from: 'human',
    body,
    cwd: normalized.project,
    sessionFile: status.sessionFile || undefined,
    sessionId: status.sessionId || undefined,
    kind: status.kind || undefined,
    attachNeedle: route.projectBound === false ? false : undefined,
    fileWins: route.projectBound === false ? false : o.fileWins !== false,
    timeout: o.timeout,
    home: o.home,
    newId: o.id,
  });

  const card = r.card || null;
  const outToken = card && card.reply != null ? String(card.reply).trim() : '';
  const sessionId = lastAttachId(root, card && card.id) || status.sessionId || null;
  const b = {
    lastCard: card && card.id ? card.id : null,
    lastToken: outToken || null,
    method: (card && card.method) || status.method,
    sessionId,
  };
  writePrefs(root, { board: b, currentSeat: route.seat });
  return {
    ok: r.code === 0,
    proceed: true,
    code: r.code,
    token: outToken,
    card,
    route: routeValue,
    method: b.method,
    sessionId,
    board: b,
    error: r.gated ? String(r.text || '').trim() : r.code ? String(r.text || '').trim() : undefined,
    text: r.text,
  };
}

async function testSend(root, payload) {
  const o = payload || {};
  const forbidden = refuseForbidden(o);
  if (forbidden) {
    return { ok: false, code: 400, error: forbidden, proceed: false };
  }
  if (o.route && typeof o.route === 'object') return testSendRoute(root, o);
  if (o.cwd && o.seat) bindSeat(root, o.seat, o.cwd);
  const prefs = readPrefs(root);
  const detect = detectSurfaces(root, o);
  const seat = o.seat || detect.currentSeat;
  const row = (detect.seats || []).find((s) => s.handle === seat);
  if (!row) return { ok: false, code: 400, error: 'seat not in surfaces', proceed: false };

  if (!o.accept) {
    const reason = gateReason(root, o, row, prefs);
    if (reason) {
      const pending = savePending(root, { payload: o, reason, seat, cardId: o.id || null });
      return {
        ok: true,
        proceed: false,
        gate: { reason, choices: ['Accept', 'Edit'] },
        pendingId: pending.id,
        board: board(root),
      };
    }
  }

  if (row.attached !== 'attached' && !(o.argv && o.argv.length) && !o.sessionFile) {
    return { ok: false, code: 400, error: 'not attached', proceed: false };
  }

  let method = o.method || row.method;
  if (method !== 'stdio' && method !== 'ax') {
    if (o.argv && o.argv.length) method = 'stdio';
    else return { ok: false, code: 400, error: 'no send method', proceed: false };
  }

  const token = o.token || 'CONV-' + crypto.randomBytes(3).toString('hex');
  const body =
    o.body && !o.forceTokenBody
      ? String(o.body)
      : `Convobus test ${token}. Reply with exactly ${token} and no other text.`;

  const r = await runTurn(root, {
    seat,
    method,
    methodExplicit: true,
    from: 'human',
    body,
    cwd: o.cwd,
    argv: o.argv,
    sessionFile: o.sessionFile,
    sessionId: o.sessionId,
    fileWins: o.fileWins !== false,
    timeout: o.timeout,
    home: o.home,
    newId: o.id,
  });

  const card = r.card || null;
  const outToken = card && card.reply != null ? String(card.reply).trim() : '';
  const sessionId = lastAttachId(root, card && card.id) || row.sessionId || null;
  const b = {
    lastCard: card && card.id ? card.id : null,
    lastToken: outToken || null,
    method: (card && card.method) || method,
    sessionId,
  };
  writePrefs(root, { board: b, currentSeat: seat });
  return {
    ok: r.code === 0,
    proceed: true,
    code: r.code,
    token: outToken,
    card,
    method: b.method,
    sessionId,
    board: b,
    error: r.gated ? String(r.text || '').trim() : r.code ? String(r.text || '').trim() : undefined,
    text: r.text,
  };
}

async function sendMessage(root, payload) {
  const o = { ...(payload || {}) };
  if (typeof o.body !== 'string' || !o.body.trim()) {
    return { ok: false, code: 400, error: 'message is empty', proceed: false };
  }
  delete o.forceTokenBody;
  delete o.token;
  return testSend(root, o);
}

async function decideGate(root, action, pendingId) {
  const decision = withStateLock(root, () => {
    const pending = readPending(root);
    if (!pending) return { response: { ok: false, code: 400, error: 'no pending gate', proceed: false } };
    if (pendingId && pending.id !== pendingId) {
      return { response: { ok: false, code: 400, error: 'unknown pending gate', proceed: false } };
    }
    if (action === 'edit') {
      clearPending(root);
      return {
        response: {
          ok: true,
          proceed: false,
          edited: true,
          gate: pending.gate || { reason: pending.reason, choices: ['Accept', 'Edit'] },
        },
      };
    }
    if (action !== 'accept') {
      return { response: { ok: false, code: 400, error: 'unknown gate action', proceed: false } };
    }
    if (pending.reason === 'first-time AX') {
      writePrefs(root, { axAccepted: true, accessibility: true });
    }
    clearPending(root);
    return { payload: Object.assign({}, pending.payload, { accept: true }) };
  });
  if (decision.response) return decision.response;
  return testSend(root, decision.payload);
}

function menuModel(root, opts) {
  const fast = !!(opts && opts.fast);
  const prefs = readPrefs(root);
  const detectKey = [path.resolve(root), (opts && opts.home) || ''].join('\0');
  const detectCached = MENU_DETECT_CACHE.get(detectKey);
  const detect =
    fast
      ? detectSurfacesFast(root)
      : detectCached && Date.now() - detectCached.at < MENU_STATUS_TTL_MS
      ? detectCached.value
      : detectSurfaces(root, opts);
  if (!fast && (!detectCached || detect !== detectCached.value)) {
    MENU_DETECT_CACHE.set(detectKey, { at: Date.now(), value: detect });
  }
  const b = board(root);
  const catalog = (opts && opts.catalog) || providerCatalog(root, prefs);
  const recentProjects = catalog.projects.slice(0, 10);
  const now = Date.now();
  const statusFor = (input, allowResolve = false) => {
    const key = [
      path.resolve(root),
      input.provider,
      input.project,
      input.surface,
      input.type,
      (opts && opts.home) || '',
      prefs.accessibility ? 'ax' : 'no-ax',
    ].join('\0');
    const cached = MENU_STATUS_CACHE.get(key);
    if (cached && now - cached.at < MENU_STATUS_TTL_MS) return cached.value;
    if (fast && !allowResolve) return { status: 'idle', reason: null };
    const value = exactRouteStatus(root, input, prefs, opts);
    MENU_STATUS_CACHE.set(key, { at: now, value });
    return value;
  };
  const activeStatus = (opts && opts.activeStatus) || statusFor(catalog.selection, true);
  const projectsByProvider = PROVIDERS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    projects: recentProjects
      .filter(
        (project) =>
          (project.routes && project.routes[provider.id]) ||
          (project.providers || []).includes(provider.id) ||
          (catalog.selection.provider === provider.id && catalog.selection.project === project.path),
      )
      .map((project) => {
      const saved = project.routes && project.routes[provider.id];
      const route =
        (saved && routeFor({ provider: provider.id, surface: saved.surface, type: saved.type })) ||
        provider.routes[0];
      const input = {
        provider: provider.id,
        project: project.path,
        surface: route.surface,
        type: route.type,
      };
      const status = statusFor(input);
      return {
        path: project.path,
        name: project.name,
        selected:
          catalog.selection.provider === provider.id && catalog.selection.project === project.path,
        route: { ...publicRoute({ ...route, provider: provider.id, providerName: provider.name }), project: project.path },
        status: status.status,
        reason: status.reason || null,
      };
      }),
  }));
  const activeLiveIds = new Set(liveCards(root).map((card) => card.id));
  const activeRecord = cardRecords(root)
    .filter(
      (record) =>
        !record.runId &&
        record.route.provider === catalog.selection.provider &&
        record.route.project === canonicalProject(catalog.selection.project) &&
        record.route.surface === catalog.selection.surface &&
        record.route.type === catalog.selection.type,
    )
    .sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')))[0];
  let icon = 'idle';
  if (activeStatus.action || activeStatus.status === 'blocked') {
    icon = 'blocked';
  } else if (
    activeStatus.status === 'waiting' ||
    (activeRecord && activeLiveIds.has(activeRecord.id))
  ) {
    icon = 'waiting';
  } else if (activeRecord && activeRecord.card && String(activeRecord.card.reply || '').trim()) {
    icon = 'attached';
  }
  const loopModel = loopsSnapshot(root);
  const loopRun = loopModel.activeRun && loopModel.activeRun.active ? loopModel.activeRun : null;
  if (loopRun) {
    if (loopRun.state === 'needs-attention') icon = 'blocked';
    else if (loopRun.state === 'waiting' || loopRun.state === 'your-turn') icon = 'waiting';
    else icon = 'idle';
  }
  return {
    icon,
    seats: detect.seats.map((s) => ({
      handle: s.handle,
      name: s.name,
      attached: s.attached,
      method: s.method,
    })),
    currentSeat: detect.currentSeat,
    lastToken: b.lastToken,
    board: b,
    accessibility: detect.accessibility,
    context: catalog.selection,
    routeStatus: activeStatus,
    projectsByProvider,
    loop: loopRun,
    loops: loopModel.loops,
    open: ['Open window'],
    items: loopRun
      ? ['Open Loop', loopRun.state === 'paused' ? 'Resume Loop' : 'Pause Loop', 'Stop Loop', 'Projects', 'Quit Convobus']
      : ['Open window', 'Projects', 'Quit Convobus'],
  };
}

async function menuModelAsync(root, opts) {
  const prefs = readPrefs(root);
  const catalog = providerCatalog(root, prefs);
  const activeStatus = await exactRouteStatusAsync(root, catalog.selection, prefs, opts);
  return menuModel(root, { ...(opts || {}), catalog, activeStatus });
}

module.exports = {
  SURFACE_SEATS,
  METHODS,
  ATTACHED,
  detectSurfaces,
  board,
  readPrefs,
  writePrefs,
  setContextAsync,
  setAccessibility,
  refuseForbidden,
  gateReason,
  sendMessage,
  testSend,
  decideGate,
  menuModel,
  menuModelAsync,
  contextStatusAsync,
  providerModelAsync,
  readPending,
  providerModel,
  setContext,
  contextStatus,
  cardsForContext,
  probeChatGPTClassic,
  probeChatGPTChat,
  probeAccessibilityApp,
};
