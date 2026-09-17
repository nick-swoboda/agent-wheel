'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const paths = require('../paths');
const { validate, TRIAL_KIT, EXECUTION_SUBMISSION, REVIEW_RESULT, NODE_SCHEMAS, DESIGN_PROPOSAL } = require('../schema');
const { sendApi, probeApi, providerFor } = require('./api');
const outcomes = require('./outcomes');

const CONVOBUS_UPSTREAM_VERSION = '0.2.0';
const ADAPTER_VERSION = '2.1.5';
const ROOT = paths.transportRoot;
const CORE = paths.convobusLib;
const RUNNER = path.join(paths.appRoot, 'seats', 'runner.js');

function executable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

function axHelperPath() {
  const candidates = [];
  if (process.env.AGENT_WHEEL_APP_BUNDLE) {
    candidates.push(path.join(process.env.AGENT_WHEEL_APP_BUNDLE, 'Contents', 'MacOS', 'ax-helper'));
  }
  candidates.push(path.join(paths.appRoot, 'native', 'build', 'ax-helper'));
  return candidates.find(executable) || null;
}

const SHIMS = {
  'bundle-helper.js': {
    PROTOCOL_VERSION: 3,
    readBundleManifest: () => null,
    bundleExecutable: (bundle, name) => (name === 'ax-helper' ? axHelperPath() : null),
    compatibleBundleExecutable: (bundle, name) => (name === 'ax-helper' ? axHelperPath() : null),
  },
  'loops.js': {
    loopsSnapshot: () => ({ runs: [], active: null }),
  },
};

let hooked = false;
function installResolveHook() {
  if (hooked) return;
  hooked = true;
  for (const [name, exportsObj] of Object.entries(SHIMS)) {
    const filename = path.join(CORE, name);
    const m = new Module(filename, null);
    m.filename = filename;
    m.loaded = true;
    m.exports = exportsObj;
    require.cache[filename] = m;
  }
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.startsWith(CORE + path.sep)) {
      const base = path.basename(request).replace(/\.js$/, '') + '.js';
      if (SHIMS[base] && /^\.\.?\//.test(request)) return path.join(CORE, base);
    }
    return original.call(this, request, parent, ...rest);
  };
}
installResolveHook();

const card = require(path.join(CORE, 'card.js'));
const providers = require(path.join(CORE, 'providers.js'));
const seats = require(path.join(CORE, 'seats.js'));
const turn = require(path.join(CORE, 'turn.js'));
const control = require(path.join(CORE, 'control.js'));
const cstore = require(path.join(CORE, 'store.js'));

if (!card.METHODS.has('api')) {
  throw new Error('vendored card.js does not admit the api method: apply lib/transport/patches/card-api-method.patch');
}

const ROUTE_IDS = {
  'claude/app/chat': 'claude:app:chat',
  'claude/app/cowork': 'claude:app:cowork',
  'claude/app/claude-code': 'claude:app:code',
  'claude/cli/claude-cli': 'claude:cli',
  'chatgpt/app/classic': 'chatgpt:app:classic',
  'chatgpt/app/chat': 'chatgpt:app:chat',
  'chatgpt/app/work': 'chatgpt:app:work',
  'chatgpt/cli/codex': 'chatgpt:codex',
  'cursor/app/cursor': 'cursor:app',
  'cursor/cli/cursor-cli': 'cursor:cli',
  'grok/cli/grok-cli': 'grok:cli',
};
function lawRouteId(r) {
  const id = ROUTE_IDS[`${r.provider}/${r.surface}/${r.type}`];
  if (!id) throw new Error(`Core route ${r.provider}/${r.surface}/${r.type} has no Agent Wheel route id`);
  return id;
}

const ROUTES = [
  ...providers.ROUTES.map((r) => ({
    id: lawRouteId(r),
    provider: r.provider,
    providerName: r.providerName,
    surface: r.surface,
    type: r.type,
    label: r.label,
    seat: r.seat,
    variant: r.variant,
    method: seats.defaultMethod(r.seat) || 'stdio',
    command: r.command || null,
    appPath: r.appPath || null,
  })),
  ...['anthropic', 'openai', 'xai'].map((p) => ({
    id: `api:${p}`, provider: p, providerName: p, surface: 'api', type: p, label: 'API', seat: null,
    variant: null, method: 'api', command: null, appPath: null,
  })),
];
const ROUTE_BY_ID = new Map(ROUTES.map((r) => [r.id, r]));

function routeById(id) {
  return ROUTE_BY_ID.get(id) || null;
}

function listRoutes() {
  return ROUTES.map((r) => ({ ...r }));
}

const invocations = require('./invocations');
const models = require('./models');

const CLI_AUTH = {
  'claude:cli': { status: ['auth', 'status'], out: ['auth', 'logout'], in: 'claude auth login' },
  'chatgpt:codex': { status: ['login', 'status'], out: ['logout'], in: 'codex login' },
  'cursor:cli': { status: ['status'], out: ['logout'], in: 'cursor-agent login' },
};

function cliAuth(routeId) {
  return Object.prototype.hasOwnProperty.call(CLI_AUTH, routeId) ? CLI_AUTH[routeId] : null;
}
function providerCommand(route, cfg) {
  if (cfg && Array.isArray(cfg.command) && cfg.command.length) return cfg.command.map(String);
  return invocations.commandForRoute(route.id, cfg);
}

function transportDir() {
  return cstore.paths(ROOT).dir;
}

function journalPath() {
  return path.join(transportDir(), 'cards.jsonl');
}

function inflightPath() {
  return path.join(transportDir(), 'inflight-agent-wheel.json');
}

function journal(c) {
  return cstore.withStateLock(ROOT, () => {
    fs.mkdirSync(transportDir(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(journalPath(), JSON.stringify(c) + '\n', { mode: 0o600 });
    return c;
  });
}

function listCards(limit) {
  const file = journalPath();
  if (!fs.existsSync(file)) return [];
  const byId = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const c = card.parseMaybeCard(line);
    if (c && c.id) byId.set(c.id, c);
  }
  const all = [...byId.values()];
  return limit ? all.slice(-limit) : all;
}

function readInflight() {
  try { return JSON.parse(fs.readFileSync(inflightPath(), 'utf8')); } catch { return []; }
}

function writeInflight(rows) {
  fs.mkdirSync(transportDir(), { recursive: true, mode: 0o700 });
  const tmp = inflightPath() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
  fs.renameSync(tmp, inflightPath());
}

function inflightAdd(row) {
  return cstore.withStateLock(ROOT, () => {
    const rows = readInflight().filter((r) => r.card_id !== row.card_id);
    rows.push(row);
    writeInflight(rows);
  });
}

function inflightRemove(cardId) {
  return cstore.withStateLock(ROOT, () => {
    writeInflight(readInflight().filter((r) => r.card_id !== cardId));
  });
}

const READINESS_CODES = Object.freeze(new Set([
  'ok', 'unknown_route', 'no_key', 'no_command', 'missing_binary', 'not_signed_in',
  'gate_new_session', 'gate_new_idea', 'gate_first_time_ax', 'gate_other',
  'detect_failed', 'surface_unknown', 'app_unavailable', 'no_session', 'check_failed',
]));
const GATE_CODES = {
  'new session': 'gate_new_session', 'new idea': 'gate_new_idea', 'first-time AX': 'gate_first_time_ax',
};
const AX_GATED_SEATS = new Set(['claude-app']);
const SURFACE_TTL_MS = 5000;
const SURFACE_CACHE = new Map();

function freshSurfaces(cwd) {
  try {
    return { detect: control.detectSurfaces(ROOT, { cwd }), prefs: control.readPrefs(ROOT) };
  } catch (err) {
    return { error: err };
  }
}

function lookSurfaces(cwd, nowMs) {
  const hit = SURFACE_CACHE.get(cwd);
  if (hit && nowMs - hit.at < SURFACE_TTL_MS) return hit.value;
  const value = freshSurfaces(cwd);
  if (SURFACE_CACHE.size > 4) SURFACE_CACHE.clear();
  SURFACE_CACHE.set(cwd, { at: nowMs, value });
  return value;
}

function gateAnswer(reason, extra) {
  return { ready: false, code: GATE_CODES[reason] || 'gate_other', reason, ...extra };
}

function authAnswer(bin, argv) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = require('child_process').execFile(
        bin, argv, { timeout: 8000, windowsHide: true }, (err) => finish(!err)
      );
      child.on('error', () => finish(false));
    } catch { finish(false); }
  });
}

async function authSweep(ids, cfg) {
  const out = new Map();
  await Promise.all(ids.map(async (id) => {
    const route = routeById(id);
    const auth = route && route.surface === 'cli' ? cliAuth(id) : null;
    if (!auth) return;
    const argv = providerCommand(route, cfg);
    const bin = argv && argv[0];
    const resolved = bin ? (bin.includes('/') ? (executable(bin) ? bin : null) : seats.which(bin)) : null;
    if (!resolved) return;
    out.set(id, { signed_in: await authAnswer(resolved, auth.status), sign_in: auth.in });
  }));
  return out;
}

// `surfaces` is a look taken by a sweep. readiness() never passes one, so a dispatch is never answered from a cached view.
function readinessWith(routeId, cfg, ctx, surfaces, auth) {
  const route = routeById(routeId);
  if (!route) return { ready: false, code: 'unknown_route', reason: 'unknown route' };
  const axGated = route.surface === 'app' && AX_GATED_SEATS.has(route.seat);
  const base = { ax_gated: axGated, accessibility: null };
  if (route.method === 'api') {
    const key = ctx && ctx.secrets && ctx.secrets.get(route.provider);
    if (!key) {
      return { ...base, ready: false, code: 'no_key', reason: 'no provider key held for ' + route.provider, provider: route.provider };
    }
    return { ...base, ready: true, code: 'ok', reason: 'key present', provider: route.provider };
  }
  if (route.surface === 'cli') {
    const argv = providerCommand(route, cfg);
    if (!argv) return { ...base, ready: false, code: 'no_command', reason: 'no command for ' + routeId };
    const bin = argv[0];
    const resolved = bin === 'node' ? process.execPath : bin.includes('/') ? (executable(bin) ? bin : null) : seats.which(bin);
    if (!resolved) return { ...base, ready: false, code: 'missing_binary', reason: 'missing binary: ' + bin, binary: bin };
    const reason = control.gateReason(ROOT, { body: 'agent wheel dispatch', argv }, { attached: 'attached', method: 'stdio' }, {});
    if (reason) return gateAnswer(reason, base);
    const signin = auth && auth.get(routeId);
    if (signin && !signin.signed_in) {
      return {
        ...base, ready: false, code: 'not_signed_in', reason: 'not signed in: ' + routeId,
        binary: resolved, sign_in: signin.sign_in,
      };
    }
    return {
      ...base, ready: true, code: 'ok', reason: 'binary ' + resolved, binary: resolved,
      signed_in: signin ? true : null, sign_out: cliAuth(routeId) ? true : false,
    };
  }
  const look = surfaces || freshSurfaces(cfg && cfg.project ? cfg.project : ROOT);
  if (look.error) {
    // Never report accessibility as missing when we could not look for it.
    return { ...base, ready: false, code: 'detect_failed', reason: 'surface detection failed: ' + look.error.message };
  }
  const { detect, prefs } = look;
  const ax = { ax_gated: axGated, accessibility: detect.accessibility === undefined ? null : Boolean(detect.accessibility) };
  const row = (detect.seats || []).find((s) => s.handle === route.seat) || null;
  if (!row) return { ...ax, ready: false, code: 'surface_unknown', reason: 'seat not in surfaces: ' + route.seat, seat: route.seat };
  if (row.attached !== 'attached') {
    return {
      ...ax,
      ready: false,
      code: row.attached === 'blocked' ? 'app_unavailable' : 'no_session',
      reason: (row.attached === 'blocked' ? 'app unavailable: ' : 'no session attached: ') + route.seat,
      seat: route.seat,
    };
  }
  const reason = control.gateReason(ROOT, { body: 'agent wheel dispatch', method: row.method }, row, prefs);
  if (reason) return gateAnswer(reason, ax);
  return { ...ax, ready: true, code: 'ok', reason: 'attached', session: row.sessionId || null };
}

function readiness(routeId, cfg, ctx) {
  return readinessWith(routeId, cfg, ctx, null);
}

async function signOut(routeId, cfg) {
  const route = routeById(routeId);
  const auth = route && route.surface === 'cli' ? cliAuth(routeId) : null;
  if (!auth) return { ok: false, error: 'this route has no sign-out of its own' };
  const argv = providerCommand(route, cfg);
  const bin = argv && argv[0];
  const resolved = bin ? (bin.includes('/') ? (executable(bin) ? bin : null) : seats.which(bin)) : null;
  if (!resolved) return { ok: false, error: 'the command is not on the app\'s PATH' };
  const ok = await authAnswer(resolved, auth.out);
  return ok ? { ok: true } : { ok: false, error: 'the sign-out command did not succeed' };
}

function setAccessibility(granted) {
  control.setAccessibility(ROOT, Boolean(granted));
  freshSurfaces.cache = null;
  return { ok: true, accessibility: Boolean(granted) };
}

function attachSeat(routeId, cwd) {
  const route = routeById(routeId);
  if (!route || route.surface !== 'app') return { ok: false, error: 'not an app route' };
  const bound = seats.bindSeat(ROOT, route.seat, cwd);
  if (!bound || bound.code !== 0) {
    return { ok: false, error: String((bound && bound.text) || 'could not bind the folder').trim() };
  }
  return { ok: true, seat: route.seat, cwd: cwd };
}

async function readinessSweep(ids, opts) {
  const o = opts || {};
  const ts = o.ts || new Date().toISOString();
  const nowMs = Date.parse(ts);
  const ctx = { secrets: o.secrets, probes: o.probes, ts };
  const auth = o.deep ? await authSweep(ids, {}) : null;
  const rows = [];
  for (const id of ids) {
    const route = routeById(id);
    let row;
    try {
      const look = route && route.surface === 'app' ? lookSurfaces(ROOT, nowMs) : null;
      row = { id, ...readinessWith(id, {}, ctx, look, auth) };
    } catch (err) {
      row = { id, ready: false, code: 'check_failed', reason: 'could not be checked: ' + String(err && err.message) };
    }
    rows.push(row);
    if (o.yield) await o.yield();
  }
  return rows;
}

function capacity(routeId, cfg, ctx) {
  const route = routeById(routeId);
  if (!route) return { ok: false, reason: 'unknown route' };
  const rows = readInflight();
  if (route.method === 'ax' || route.method === 'applescript') {
    const gui = rows.filter((r) => r.method === 'ax' || r.method === 'applescript');
    if (gui.length) return { ok: false, reason: `GUI route busy (${gui[0].route} in flight)` };
    return { ok: true };
  }
  if (route.method === 'stdio') {
    const argv = providerCommand(route, cfg) || [];
    const binary = argv[0] || route.seat;
    const stdio = rows.filter((r) => r.method === 'stdio');
    if (stdio.length >= 3) return { ok: false, reason: 'three stdio processes already in flight machine-wide' };
    if (stdio.some((r) => r.binary === binary && r.project_id === (ctx && ctx.project_id))) {
      return { ok: false, reason: `${binary} already in flight for this project` };
    }
    return { ok: true };
  }
  const backoff = ctx && ctx.apiBackoff && ctx.apiBackoff.get(route.provider);
  if (backoff && Date.parse(backoff.until) > Date.parse(ctx.ts || new Date().toISOString())) {
    return { ok: false, reason: `${route.provider} rate limited until ${backoff.until}` };
  }
  return { ok: true };
}

function schemaFor(name) {
  return name === 'TRIAL_KIT' ? TRIAL_KIT : name === 'EXECUTION_SUBMISSION' ? EXECUTION_SUBMISSION
    : name === 'REVIEW_RESULT' ? REVIEW_RESULT : name === 'DESIGN_PROPOSAL' ? DESIGN_PROPOSAL : name === 'DESIGN' ? NODE_SCHEMAS.design : { type: 'object' };
}

function classifyRunnerReply(res) {
  if (res && res.reason === 'timeout') return { outcome: 'timeout', detail: 'runner killed at the transport timeout' };
  if (!res || res.miss || res.ok === false) {
    return { outcome: 'transport_error', detail: (res && (res.reason || 'no reply')) + (res && res.stderr ? ' | ' + String(res.stderr).slice(-400) : '') };
  }
  const lines = String(res.reply || '').trim().split('\n').filter(Boolean);
  let parsed = null;
  for (let i = lines.length - 1; i >= 0 && !parsed; i--) {
    try { const obj = JSON.parse(lines[i]); if (obj && outcomes.OUTCOMES.includes(obj.outcome)) parsed = obj; } catch {}
  }
  if (!parsed) return { outcome: 'transport_error', detail: 'unreadable runner envelope: ' + String(res.reply || '').slice(-300) };
  return parsed;
}

function classifyText(res, schema) {
  if (res && res.reason === 'timeout') return { outcome: 'timeout', detail: 'route timed out' };
  if (!res || res.miss || res.ok === false) return { outcome: 'transport_error', detail: (res && res.reason) || 'no reply' };
  return outcomes.classifyParsed(outcomes.extractJson(res.reply), schema, validate);
}

function createTransport(opts) {
  const o = opts || {};
  const secrets = o.secrets || new Map();
  const probes = new Map();
  const apiBackoff = new Map();

  async function deliverReal(c, envelope, route, cfg) {
    const schema = schemaFor(envelope.result_schema);
    if (route.method === 'api') {
      const r = await sendApi({
        route: route.id, key: secrets.get(route.provider), model: cfg && cfg.model, endpoint: cfg && cfg.endpoint,
        system: envelope.system_prompt, prompt: envelope.prompt, timeoutMs: envelope.timeout_ms,
      });
      if (r.outcome === 'refused' && r.http_status === 429) {
        apiBackoff.set(route.provider, { until: new Date(Date.now() + 60000).toISOString() });
      }
      if (r.outcome !== 'answered') return { outcome: r.outcome, detail: r.detail };
      return outcomes.classifyParsed(outcomes.extractJson(r.text), schema, validate);
    }
    if (route.surface === 'cli') {
      const res = await turn.dispatchSend(ROOT, c, {
        argv: [process.execPath, RUNNER, 'run'],
        encoding: 'raw',
        cwd: ROOT,
        env: process.env,
        timeout: (envelope.timeout_ms || 600000) + 60000,
        home: process.env.HOME,
      });
      return classifyRunnerReply(res);
    }
    const res = await turn.dispatchSend(ROOT, c, {
      methodExplicit: true,
      cwd: (cfg && cfg.project) || ROOT,
      timeout: envelope.timeout_ms || 600000,
      home: process.env.HOME,
      variant: route.variant,
    });
    return classifyText(res, schema);
  }

  const deliver = o.deliver || deliverReal;

  function send(args) {
    const route = routeById(args.route);
    if (!route) throw new Error('unknown route ' + args.route);
    const cfg = args.cfg || {};
    const envelope = { ...args.envelope, provider: { command: providerCommand(route, cfg), model: cfg.model || null } };
    const body = route.method === 'stdio' || route.method === 'api'
      ? JSON.stringify(envelope)
      : `${envelope.system_prompt}\n\n${envelope.prompt}`;
    const c = card.makeCard({
      seat: route.seat || route.provider,
      method: route.method,
      from: 'agent-wheel',
      body,
      state: 'out',
      stripAddress: false,
      cwd: ROOT,
    });
    if (!card.isCardState(c.state)) throw new Error('illegal card state');
    journal(c);
    inflightAdd({
      card_id: c.id, route: route.id, method: route.method, project_id: args.binding.project_id,
      binary: (envelope.provider.command || [route.seat || route.provider])[0], since: new Date().toISOString(),
      pid: process.pid,
    });
    const delivery = Promise.resolve()
      .then(() => deliver(c, envelope, route, cfg))
      .then((classified) => settle(c, classified), (err) => settle(c, { outcome: 'transport_error', detail: String(err && err.message) }));
    return { card: c, delivery };
  }

  function settle(c, classified) {
    const back = card.cloneCard(c);
    back.state = 'back';
    back.reply = JSON.stringify(classified).slice(0, 200000);
    journal(back);
    inflightRemove(c.id);
    return { card: back, ...classified };
  }

  function settleById(cardId, classified) {
    const c = listCards().find((x) => x.id === cardId);
    if (!c) return null;
    if (c.state === 'back') return { card: c, ...classified };
    return settle(c, classified);
  }

  function reconcile(projectId, liveCardIds) {
    const live = new Set(liveCardIds || []);
    const dead = readInflight().filter((r) => r.project_id === projectId && !live.has(r.card_id));
    const closed = [];
    for (const row of dead) {
      const detail = `dead card: no live seat holds it (helper pid ${row.pid || 'unknown'} is gone); closed by recovery against CardBinding`;
      const back = settleById(row.card_id, { outcome: 'transport_error', detail });
      if (!back) inflightRemove(row.card_id);
      closed.push({ card_id: row.card_id, route: row.route, binary: row.binary, since: row.since, pid: row.pid || null, outcome: 'transport_error', detail });
    }
    return closed;
  }

  async function probe(provider, cfg) {
    const r = await probeApi({ route: 'api:' + provider, key: secrets.get(provider), model: cfg && cfg.model, endpoint: cfg && cfg.endpoint });
    probes.set(provider, { ok: r.ok, at: new Date().toISOString(), outcome: r.outcome, detail: r.detail });
    return probes.get(provider);
  }

  return {
    send,
    settleById,
    listCards,
    readiness: (routeId, cfg, ctx) => readiness(routeId, cfg, { secrets, probes, ...(ctx || {}) }),
    readinessSweep: (ids, o) => readinessSweep(ids, { secrets, probes, ...(o || {}) }),
    signOut: (routeId, o) => signOut(routeId, o || {}),
    setAccessibility,
    attachSeat,
    modelChoices: (o) => models.discover({ resolve: (b) => seats.which(b), ...(o || {}) }),
    choicesFor: (id) => models.choicesFor(id),
    capacity: (routeId, cfg, ctx) => capacity(routeId, cfg, { apiBackoff, ...(ctx || {}) }),
    probe,
    reconcile,
    secrets,
    probes,
    routeById,
    listRoutes,
    inflight: readInflight,
    versions: { convobus_upstream_version: CONVOBUS_UPSTREAM_VERSION, convobus_adapter_version: ADAPTER_VERSION },
    root: ROOT,
    dir: transportDir,
    core: {
      makeCard: card.makeCard, cloneCard: card.cloneCard, parseMaybeCard: card.parseMaybeCard,
      routeFor: providers.routeFor, normalizedRoute: providers.normalizedRoute, publicRoute: providers.publicRoute,
      discover: seats.discover, getSeat: seats.getSeat, bindSeat: seats.bindSeat,
      dispatchSend: turn.dispatchSend, resolveIncomingCard: turn.resolveIncomingCard,
      detectSurfaces: control.detectSurfaces, gateReason: control.gateReason, sendMessage: control.sendMessage,
      withStateLock: cstore.withStateLock, paths: cstore.paths,
    },
  };
}

function createStubTransport(opts) {
  const o = opts || {};
  const t = createTransport({ ...o, deliver: () => new Promise(() => {}) });
  t.readiness = (routeId) => (routeById(routeId)
    ? { ready: true, code: 'ok', reason: 'stub', ax_gated: false, accessibility: null }
    : { ready: false, code: 'unknown_route', reason: 'unknown route', ax_gated: false, accessibility: null });
  t.readinessSweep = async (ids) => ids.map((id) => ({ id, ...t.readiness(id) }));
  t.capacity = () => ({ ok: true });
  t.stub = true;
  return t;
}

module.exports = {
  createTransport, createStubTransport, listRoutes, routeById, providerCommand, listCards,
  CONVOBUS_UPSTREAM_VERSION, ADAPTER_VERSION, ROOT, providerFor, classifyRunnerReply, classifyText, READINESS_CODES,
};
