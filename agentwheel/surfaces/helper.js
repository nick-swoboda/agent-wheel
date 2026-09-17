'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const paths = require('../lib/paths');
const schemalib = require('../lib/schema');
const { Wheel, LeaseBusyError } = require('../lib/wheel');
const { resolve } = require('../lib/frontier');
const storelib = require('../lib/store');
const commitlib = require('../lib/commit');
const { wikiTempSnapshot } = require('../lib/compile');
const { productSpec } = require('../lib/schema');
const { createTransport } = require('../lib/transport');
const { CHIPS } = require('../lib/chips');
const { previewDropDown } = require('../lib/traversal');
const { nowIso } = require('../lib/ids');
const { SCALE, WINDOW_MS } = require('../lib/reducers');
const WINDOWS = Object.keys(WINDOW_MS);
const pkg = require('../package.json');

const PROVIDERS = ['anthropic', 'openai', 'xai'];

const FORM_TEMPLATES = Object.fromEntries(['experience', 'design', 'spec'].map((k) => [k, schemalib.templateFor(schemalib.NODE_SCHEMAS[k])]));

function projectRow(wheel) {
  const s = wheel.state;
  return {
    id: wheel.projectId,
    name: s ? s.project.name : null,
    created: s ? s.project.created : null,
    status: wheel.status(),
    stage: wheel.frontier().stage,
  };
}

function successorPreview(state, kind, v) {
  const node = state.nodes && state.nodes[kind];
  if (!node || !['idea', 'experience', 'design', 'spec'].includes(kind)) return null;
  const ver = node.versions.find((x) => x.v === v);
  const previous = node.versions.filter((x) => x.state === 'accepted' && x.v < v).at(-1) || null;
  if (!ver || !previous) return null;
  return previewDropDown(state, kind, previous.content, ver.content);
}

function validationView(state) {
  const pv = state.pending_validation;
  if (!pv || !(!pv.author || pv.author.seat === 'human')) return pv;
  const preview = successorPreview(state, pv.kind, pv.v);
  return preview ? { ...pv, preview } : pv;
}

function gateStagedPreview(state, gate) {
  if (!gate || gate.id !== 'DESIGN_READY' || !gate.staged) return null;
  return successorPreview(state, gate.staged.kind, gate.staged.v);
}

const REFUSAL_BACKOFF_MS = [5000, 30000, 60000];
function refusalBackoff(prev, seq, nowMs, schedule) {
  const s = schedule || REFUSAL_BACKOFF_MS;
  const attempt = prev && prev.seq === seq ? prev.attempt + 1 : 1;
  const wait = s[Math.min(attempt, s.length) - 1];
  return { seq, attempt, wait, due: nowMs + wait };
}
function backoffHolds(record, seq, nowMs) {
  return Boolean(record) && record.seq === seq && nowMs < record.due;
}

function activityView(state) {
  const ps = state.pending_seat;
  const pd = state.pending_dispatch;
  const pr = state.pending_redispatch;
  return {
    working: ps ? {
      seat: ps.seat, kind: ps.kind, route: ps.route, since: ps.sent_ts || null,
      attempt: Number(ps.attempts || 0), review: Boolean(ps.review), leaves: ps.leaves || null,
    } : null,
    staged: pd ? { seat: pd.seat, kind: pd.kind, route: pd.route, attempt: Number(pd.attempt || 0) } : null,
    waiting: pr ? {
      route: pr.route, outcome: pr.outcome, due_at: pr.due_at || null, failures: Number(pr.failures || 0),
    } : null,
    pull: state.pending_pull ? { seat: state.pending_pull.seat, ids: state.pending_pull.ids || [] } : null,
    stopped: Boolean(state.stopped),
    interrupted: state.interrupted ? { cause: state.interrupted.cause } : null,
    last_failure: state.last_failure ? { kind: state.last_failure.kind, reason: state.last_failure.reason } : null,
    refused: state.last_egress_refusal ? {
      guard: state.last_egress_refusal.guard,
      reason: state.last_egress_refusal.reason,
      route: state.last_egress_refusal.route || null,
      ts: state.last_egress_refusal.ts || null,
      dispatch_id: state.last_egress_refusal.dispatch_id || null,
    } : null,
  };
}

const HUMAN_AUTHORS = new Set(['human', 'validate', 'system']);
function seatSpoke(by) {
  return Boolean(by && by.route && by.seat && !HUMAN_AUTHORS.has(by.seat));
}

function lastResponseView(state) {
  const said = [];
  for (const r of state.reviews || []) {
    if (!r.notes || !seatSpoke(r.reviewer)) continue;
    said.push({
      seat: r.reviewer.seat,
      route: r.reviewer.route,
      about: r.subject || null,
      decision: r.decision || null,
      text: String(r.notes),
      repair: r.earliest_repair || null,
      ts: r.ts || null,
    });
  }
  for (const e of Object.values(state.executions || {})) {
    if (!e.notes || !seatSpoke(e.author)) continue;
    said.push({
      seat: e.author.seat,
      route: e.author.route,
      about: e.main_file || null,
      decision: e.state || null,
      text: String(e.notes),
      repair: null,
      ts: e.ts || null,
    });
  }
  if (!said.length) return null;
  said.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  const last = said[said.length - 1];
  return { ...last, text: last.text.slice(0, 1200) };
}

function publicState(state, wheel, projects) {
  const recovery = wheel && wheel.recovery ? { cause: wheel.recovery.cause, detected: wheel.recovery.detected } : null;
  const rail = projects || (wheel && wheel.state ? [projectRow(wheel)] : []);
  if (!state) {
    return {
      project: null, projects: rail, status: wheel ? wheel.status() : 'unspooled',
      frontier: wheel ? wheel.frontier() : resolve(null),
      chips: CHIPS, nodes: {}, budget: null, budget_scale: SCALE, budget_windows: WINDOWS,
      gate: wheel ? wheel.gateView() : null,
      pending_validation: null, pending_seat: null, artifact: null, branches: {},
      leaves: {}, executions: {}, main: null, closure: null, closure_proof: null, execution: null, plan_review: null, project_done: null,
      recovery, seq: 0,
      activity: null,
      last_response: null,
    };
  }
  const nodes = {};
  const wiki = wikiTempSnapshot(state);
  for (const [kind, node] of Object.entries(state.nodes)) {
    const accepted = node.versions.filter((v) => v.state === 'accepted').at(-1) || null;
    const staged = node.versions.filter((v) => v.state === 'staged').at(-1) || null;
    nodes[kind] = {
      kind,
      line: wiki[kind] ? wiki[kind].line : 'empty',
      stale: node.stale,
      reopened: node.reopened,
      versions: node.versions.map((v) => ({ v: v.v, state: v.state, ts: v.ts })),
      accepted: accepted ? { v: accepted.v, content: kind === 'spec' ? productSpec(accepted.content) : accepted.content } : null,
      staged: staged ? { v: staged.v, content: kind === 'spec' ? productSpec(staged.content) : staged.content, staged_by_turn: staged.staged_by_turn } : null,
      draft: kind === 'spec' ? productSpec(node.draft) : node.draft,
      rejected_note: node.rejected_note || null,
    };
  }
  const gate = wheel ? wheel.gateView() : state.gate;
  return {
    project: state.project,
    projects: rail,
    form_templates: FORM_TEMPLATES,
    budget_scale: SCALE,
    budget_windows: WINDOWS,
    status: wheel ? wheel.status() : state.status,
    frontier: wheel ? wheel.frontier() : (state.frontier || resolve(state)),
    chips: CHIPS,
    nodes,
    budget: state.budget,
    gate: gate ? {
      id: gate.id, def: gate.id === 'BUDGET_GATE' ? { ...gate.def, kind: 'wheel' } : gate.def, staged: gate.staged || null,
      opened_by_turn: gate.opened_by_turn || null, preview: gateStagedPreview(state, gate),
    } : null,
    recovery,
    seq: state.seq,
    pending_validation: validationView(state),
    pending_seat: state.pending_seat || null,
    artifact: state.artifact,
    branches: state.branches,
    leaves: state.leaves || {},
    executions: Object.fromEntries(Object.entries(state.executions || {}).map(([b, e]) => [b, {
      branch: b, leaves: e.leaves, state: e.state, main_file: e.main_file, files: e.files, tests: e.tests,
      authored_by: e.authored_by, staged_by_turn: e.staged_by_turn, accepted_by_turn: e.accepted_by_turn || null,
    }])),
    main: state.main ? { main_file: state.main.main_file, sha256: state.main.sha256, bytes: state.main.bytes, merged: state.main.merged } : null,
    closure: state.closure ? { state: state.closure.state, steps: state.closure.steps, artifact: state.closure.artifact } : null,
    closure_proof: state.closure_proof ? { all_ok: state.closure_proof.all_ok, claims: state.closure_proof.claims.length, steps: state.closure_proof.steps, first_failure: state.closure_proof.first_failure } : null,
    execution: state.execution || null,
    plan_review: state.plan_review || null,
    project_done: state.project_done || null,
    seats: state.seats || null,
    routes: state.routes || null,
    route_health: state.route_health || {},
    activity: activityView(state),
    last_response: lastResponseView(state),
    turns: state.turns,
  };
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, null, 1));
}

function readBody(req, limit) {
  return new Promise((ok, bad) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > limit) req.destroy(new Error('body too large')); });
    req.on('end', () => ok(raw));
    req.on('error', bad);
  });
}

function bearer(req) {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

function tokenMatches(presented, token) {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function spoolViaMcp(args, port, token) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [path.join(paths.appRoot, 'mcp', 'spool-server.js')], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    child.stdio[3].end(JSON.stringify({ port, token }) + '\n');
    const timer = setTimeout(() => {
      child.kill(); rejectP(new Error('MCP spool timed out'));
    }, 15000);
    let buf = '';
    const pendings = new Map();
    let idSeq = 0;
    const send = (method, params) => {
      const id = ++idSeq;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((ok, bad) => pendings.set(id, { ok, bad }));
    };
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const waiter = pendings.get(msg.id);
        if (waiter) {
          pendings.delete(msg.id);
          if (msg.error) waiter.bad(new Error(msg.error.message));
          else waiter.ok(msg.result);
        }
      }
    });
    child.on('error', (err) => { clearTimeout(timer); rejectP(err); });
    (async () => {
      await send('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'agent-wheel-composer', version: pkg.version },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const result = await send('tools/call', { name: 'spool_project', arguments: args });
      clearTimeout(timer);
      child.stdin.end();
      resolveP(result);
    })().catch((err) => { clearTimeout(timer); child.kill(); rejectP(err); });
  });
}

function start(opts) {
  const o = opts || {};
  const token = String(o.token || '');
  if (token.length < 16) throw new Error('helper needs a launch token of at least 16 characters');
  const port = o.port != null ? o.port : 0;
  const secrets = new Map(); // Provider keys stay in memory and are never logged.
  let sweeping = null;
  const yieldToLoop = () => new Promise((r) => setImmediate(r));
  function sweepOnce() {
    if (!sweeping) {
      sweeping = transport.readinessSweep(transport.listRoutes().map((r) => r.id),
        { ts: nowIso(), yield: yieldToLoop, deep: true })
        .finally(() => { sweeping = null; });
    }
    return sweeping;
  }
  const transport = o.transport || createTransport({ secrets });
  const wheels = new Map();
  let currentId = null;
  const seenAgents = new Set(); /* first authorized request per client is audited (never the token) */
  let chain = Promise.resolve();
  let listening = 0;

  function wire(wheel) {
    wheel.onBack = (back) => {
      chain = chain.then(() => {
        try {
          wheel.runTurn({
            type: 'seat_result', card_id: back.card.id, outcome: back.outcome, result: back.result,
            detail: back.detail, errors: back.errors, via: 'delivery',
            ...(back.raw != null ? { raw: back.raw, raw_cut: back.raw_cut || null } : {}),
            ...(back.normalizations ? { normalizations: back.normalizations } : {}),
          });
        } catch (err) {
          wheel.audit({ phase: 'CLOSED_RUNNING', event: 'back_card_error', card: back.card.id, detail: String(err.message) });
        }
      });
    };
    wheels.set(wheel.projectId, wheel);
    return wheel;
  }

  storelib.ensureDirs();
  const legacyArchive = storelib.archiveLegacyStoreIfPresent();
  for (const p of storelib.listProjects()) {
    const archived = storelib.archiveLegacyProjectIfPresent(paths.projectPaths(p.id));
    if (archived) {
      commitlib.removeFromProjectsIndex(p.id);
      storelib.audit({ phase: 'STORE', event: 'legacy_project_dropped_from_rail', id: p.id, name: p.name, to: archived });
      continue;
    }
    try {
      wire(new Wheel({ transport, project: p.id }));
      currentId = currentId || p.id;
    } catch (err) {
      storelib.audit({ phase: 'SHELL', event: err instanceof LeaseBusyError ? 'project_lease_busy' : 'project_open_failed', project: p.id, detail: String(err.message) });
    }
  }

  const current = () => (currentId && wheels.get(currentId)) || null;
  const wheelFor = (id) => (id ? wheels.get(String(id)) || null : current());
  const rail = () => [...wheels.values()].filter((w) => w.state).map(projectRow);

  const statusLine = () => {
    const w = current();
    return {
      surface: 'helper', pid: process.pid, version: pkg.version,
      status: w ? w.status() : 'unspooled',
      project: w && w.state ? w.state.project.name : null,
      projects: rail().length,
      stage: w ? w.frontier().stage : 'unspooled',
      budget: w && w.state ? w.state.budget : null,
      gate: w && w.gateView() ? w.gateView().id : null,
      recovery: w && w.recovery ? w.recovery.cause : null,
    };
  };

  function runTurn(input, projectId) {
    if (input.type === 'spool') {
      const wheel = new Wheel({ transport });
      const result = wheel.runTurn(input);
      if (wheel.state) {
        wire(wheel);
        currentId = wheel.projectId;
        result.project_id = wheel.projectId;
      } else {
        wheel.close();
      }
      return result;
    }
    const wheel = wheelFor(projectId);
    if (!wheel) return { ok: false, error: projectId ? 'unknown project ' + projectId : 'no project; spool one first', status: 'unspooled', frontier: resolve(null) };
    const result = wheel.runTurn(input);
    result.project_id = wheel.projectId;
    return result;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!tokenMatches(bearer(req), token)) {
      storelib.audit({
        phase: 'SECURITY', event: 'auth_refused', method: req.method, path: url.pathname,
        remote: req.socket.remoteAddress,
      });
      return json(res, 401, { error: 'launch token required' });
    }
    const agent = String(req.headers['user-agent'] || 'unknown').slice(0, 80);
    if (!seenAgents.has(agent)) {
      seenAgents.add(agent);
      storelib.audit({ phase: 'SHELL', event: 'client_connected', agent, path: url.pathname });
    }
    const projectParam = url.searchParams.get('project');
    if (req.method === 'GET' && (url.pathname === '/api/status' || url.pathname === '/api/whoami')) {
      return json(res, 200, statusLine());
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      return json(res, 200, { current: currentId, projects: rail() });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const w = wheelFor(projectParam);
      if (projectParam && !w) return json(res, 404, { error: 'unknown project ' + projectParam });
      return json(res, 200, publicState(w ? w.state : null, w, rail()));
    }
    if (req.method === 'GET' && url.pathname === '/api/audit') {
      const w = wheelFor(projectParam);
      const rows = storelib.auditTail(Number(url.searchParams.get('n') || 60), w ? w.paths : null);
      // `since` is the newest ts the caller already holds, so it asks only for what is new.
      const since = url.searchParams.get('since');
      return json(res, 200, since ? rows.filter((r) => r && r.ts && r.ts > since) : rows);
    }
    if (req.method === 'GET' && url.pathname === '/api/cards') {
      return json(res, 200, transport.listCards(Number(url.searchParams.get('n') || 40)));
    }
    if (req.method === 'GET' && url.pathname === '/api/routes') {
      const w = wheelFor(projectParam);
      const seats = w && w.state ? w.state.seats : null;
      const withReadiness = url.searchParams.get('ready') === '1';
      if (transport.modelChoices) {
        try { await transport.modelChoices({ fresh: withReadiness || url.searchParams.get('models') === '1' }); } catch {   }
      }
      const table = transport.listRoutes().map((r) => ({
        id: r.id, provider: r.providerName, surface: r.surface, label: r.label, method: r.method,
        app_path: r.appPath || null,
        choices: transport.choicesFor ? transport.choicesFor(r.id) : null,
      }));
      if (!withReadiness) return json(res, 200, { routes: table, seats, checked: false });
      const t0 = process.hrtime.bigint();
      const checks = await sweepOnce();
      const byId = new Map(checks.map((c) => [c.id, c]));
      const routes = table.map((row) => {
        const c = byId.get(row.id) || {};
        return {
          ...row,
          ready: Boolean(c.ready), code: c.code || 'check_failed', reason: c.reason || '',
          ax_gated: Boolean(c.ax_gated), accessibility: c.accessibility === undefined ? null : c.accessibility,
          binary: c.binary || null, seat: c.seat || null,
          signed_in: c.signed_in === undefined ? null : c.signed_in,
          sign_in: c.sign_in || null, sign_out: Boolean(c.sign_out),
        };
      });
      storelib.audit({
        phase: 'SHELL', event: 'routes_checked', ready: routes.filter((r) => r.ready).length, of: routes.length,
        ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
      });
      return json(res, 200, { routes, seats, checked: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/accessibility') {
      let msg;
      try { msg = JSON.parse(await readBody(req, 4096)); } catch { return json(res, 400, { error: 'bad json' }); }
      const out = transport.setAccessibility(Boolean(msg && msg.granted));
      storelib.audit({ phase: 'SHELL', event: 'accessibility_set', granted: Boolean(msg && msg.granted) });
      return json(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/api/routes/attach') {
      let msg;
      try { msg = JSON.parse(await readBody(req, 4096)); } catch { return json(res, 400, { error: 'bad json' }); }
      const routeId = msg && typeof msg.route === 'string' ? msg.route : '';
      const w = wheelFor(msg && msg.project ? String(msg.project) : projectParam);
      if (!w) return json(res, 200, { ok: false, error: 'no project' });
      const out = transport.attachSeat(routeId, w.paths.mainDir);
      storelib.audit({ phase: 'SHELL', event: 'route_attach', route: routeId, ok: Boolean(out.ok) });
      return json(res, 200, { ...out, app_path: (transport.routeById(routeId) || {}).appPath || null });
    }
    if (req.method === 'POST' && url.pathname === '/api/routes/signout') {
      let msg;
      try { msg = JSON.parse(await readBody(req, 4096)); } catch { return json(res, 400, { error: 'bad json' }); }
      const routeId = msg && typeof msg.route === 'string' ? msg.route : '';
      if (!transport.routeById(routeId)) return json(res, 400, { ok: false, error: 'unknown route' });
      const out = await transport.signOut(routeId);
      storelib.audit({ phase: 'SHELL', event: 'route_signed_out', route: routeId, ok: Boolean(out.ok) });
      return json(res, 200, out);
    }
    if (req.method === 'GET' && url.pathname === '/api/reopen/preview') {
      const w = wheelFor(projectParam);
      if (!w) return json(res, 200, { ok: false, error: 'no project' });
      return json(res, 200, w.previewReopen(String(url.searchParams.get('kind') || '')));
    }
    if (req.method === 'GET' && url.pathname === '/api/secrets') {
      return json(res, 200, { providers: [...secrets.keys()].sort() });
    }
    if (req.method === 'POST' && url.pathname === '/api/secrets') {
      let msg;
      try { msg = JSON.parse(await readBody(req, 65536)); } catch { return json(res, 400, { error: 'bad json' }); }
      if (!msg || !PROVIDERS.includes(msg.provider)) return json(res, 400, { error: 'unknown provider' });
      if (typeof msg.key === 'string' && msg.key.length > 0) secrets.set(msg.provider, msg.key);
      else secrets.delete(msg.provider);
      storelib.audit({ phase: 'SECURITY', event: 'secret_' + (secrets.has(msg.provider) ? 'held' : 'cleared'), provider: msg.provider });
      return json(res, 200, { ok: true, providers: [...secrets.keys()].sort() });
    }
    if (req.method === 'POST' && url.pathname === '/api/spool') {
      let args;
      try { args = JSON.parse(await readBody(req, 65536)); } catch { return json(res, 400, { error: 'bad json' }); }
      try {
        const result = await spoolViaMcp(args, listening, token);
        return json(res, 200, { mcp: true, result, project_id: currentId });
      } catch (err) {
        return json(res, 502, { error: 'spool_project via MCP failed: ' + err.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/turn') {
      let body;
      try { body = JSON.parse(await readBody(req, 5e6)); } catch { return json(res, 400, { error: 'bad json' }); }
      const input = body && body.input;
      if (!input || typeof input.type !== 'string') return json(res, 400, { error: 'missing input.type' });
      const projectId = body.project || projectParam || null;
      chain = chain.then(() => {
        try {
          const result = runTurn(input, projectId);
          json(res, result.ok ? 200 : 422, result);
        } catch (err) {
          json(res, 500, { error: String(err && err.message) });
        }
      });
      return;
    }
    json(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: String(err && err.message) });
    });
  });

  const backoffs = new Map();
  const ownSeq = new Map();
  const backoffSchedule = o.backoffMs || REFUSAL_BACKOFF_MS;
  function tick(wheel) {
    const state = wheel.state;
    if (wheel.recovery) return;
    if (!state) return;
    const held = backoffs.get(wheel.projectId);
    if (held) {
      if (state.seq !== ownSeq.get(wheel.projectId)) backoffs.delete(wheel.projectId);
      else if (backoffHolds(held, held.seq, Date.now())) return;
    }
    if (state.gate) {
      if (state.gate.id === 'BUDGET_GATE' && state.gate.waiting && !require('../lib/reducers').budgetExhausted(state, nowIso())) {
        try { wheel.runTurn({ type: 'budget_admit' }); } catch (err) {
          wheel.audit({ phase: 'WATCH_FRONTIER', event: 'watcher_error', detail: String(err.message) });
        }
      }
      return;
    }
    const pv = state.pending_validation;
    if (pv && pv.kind === 'plan' && pv.engine_closed && !state.pending_dispatch && !state.pending_seat) {
      try { wheel.runTurn({ type: 'validate', action: 'ACCEPT' }); } catch (err) {
        wheel.audit({ phase: 'WATCH_FRONTIER', event: 'watcher_error', detail: String(err.message) });
      }
      return;
    }
    if (pv && (!pv.author || pv.author.seat === 'human') && !state.pending_dispatch && !state.pending_seat) return;
    if (['red', 'purple'].includes(state.status)) return;
    const frontier = resolve(state);
    try {
      if (frontier.next_legal.includes('plan_generate')) {
        wheel.runTurn({ type: 'plan_generate' });
      } else if (frontier.next_legal.includes('finalize')) {
        // PROOF TRAVERSAL "before Done": the final read-only closure is the engine's own walk; the Reviewer then reads it independently.
        wheel.runTurn({ type: 'finalize' });
      } else if (frontier.next_legal.includes('project_done')) {
        wheel.runTurn({ type: 'project_done' });
      } else if (frontier.next_legal.includes('plan_trial') && !frontier.next_legal.includes('seat_dispatch')) {
        wheel.runTurn({ type: 'plan_trial', kit: { leaves: {} } });
      } else if (frontier.next_legal.includes('seat_dispatch') && !(frontier.stage === 'design' && !state.pending_validation)) {
        wheel.runTurn({ type: 'seat_dispatch' });
      } else if (frontier.next_legal.includes('egress')) {
        const r = wheel.runTurn({ type: 'egress' });
        if (r && r.ok === false && r.guard) {
          const prevRecord = backoffs.get(wheel.projectId) || null;
          const record = refusalBackoff(prevRecord, prevRecord ? prevRecord.seq : wheel.state.seq, Date.now(), backoffSchedule);
          backoffs.set(wheel.projectId, record);
          wheel.audit({ phase: 'WATCH_FRONTIER', event: 'backoff', guard: r.guard, attempt: record.attempt, wait_ms: record.wait });
        } else {
          backoffs.delete(wheel.projectId);
        }
      } else if (state.pending_redispatch && Date.parse(nowIso()) >= Date.parse(state.pending_redispatch.due_at)) {
        wheel.runTurn({ type: 'redispatch' });
      } else if (state.pending_seat && !wheel.deliveries.has(state.pending_seat.card_id)) {
        wheel.runTurn({
          type: 'seat_result', card_id: state.pending_seat.card_id, outcome: 'transport_error',
          detail: 'delivery lost at helper restart', via: 'lost',
        });
      }
    } catch (err) {
      wheel.audit({ phase: 'WATCH_FRONTIER', event: 'watcher_error', detail: String(err.message) });
    }
    if (wheel.state) ownSeq.set(wheel.projectId, wheel.state.seq);
  }
  const watcher = setInterval(() => {
    chain = chain.then(() => {
      for (const wheel of wheels.values()) tick(wheel);
    });
  }, o.watchMs || 2000);
  watcher.unref();

  function closeAll() {
    for (const wheel of wheels.values()) wheel.close();
  }

  return new Promise((ok, bad) => {
    server.once('error', bad);
    server.listen(port, '127.0.0.1', () => {
      listening = server.address().port;
      const handle_ = { server, port: listening, watcher, token, secrets, transport, wheels, current, wheelFor, closeAll, runTurn, legacyArchive };
      Object.defineProperty(handle_, 'wheel', { get: current, enumerable: true });
      ok(handle_);
    });
  });
}

function readFirstLine(stream) {
  return new Promise((ok, bad) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        stream.off('data', onData);
        ok(buf.slice(0, nl));
      }
    };
    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.once('end', () => ok(buf));
    stream.once('error', bad);
  });
}

// The launch token arrives on stdin; EOF stops the helper when its parent exits.
async function main() {
  const line = await readFirstLine(process.stdin);
  let launch;
  try { launch = JSON.parse(line); } catch { launch = null; }
  if (!launch || typeof launch.token !== 'string') {
    process.stderr.write('helper: expected a JSON launch line with the token on stdin\n');
    process.exit(2);
  }
  const started = await start({ port: 0, token: launch.token });
  fs.mkdirSync(paths.storeDir, { recursive: true });
  fs.writeFileSync(paths.helperInfoPath, JSON.stringify({
    pid: process.pid, port: started.port, version: pkg.version, started: nowIso(),
  }));
  storelib.audit({ phase: 'SHELL', event: 'helper_start', pid: process.pid, port: started.port, projects: started.wheels.size, legacy_archive: started.legacyArchive || null });
  process.stdout.write(JSON.stringify({ ready: true, port: started.port, pid: process.pid, version: pkg.version }) + '\n');

  let stopping = false;
  const shutdown = (why) => {
    if (stopping) return;
    stopping = true;
    clearInterval(started.watcher);
    started.closeAll(); /* releases our own project leases; residue is never touched here */
    try { fs.unlinkSync(paths.helperInfoPath); } catch {}
    storelib.audit({ phase: 'SHELL', event: 'helper_stop', why });
    started.server.close();
    setTimeout(() => process.exit(0), 50).unref();
  };
  process.stdin.on('end', () => shutdown('stdin closed'));
  process.stdin.on('error', () => shutdown('stdin error'));
  process.stdin.resume();
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { start, main, publicState, spoolViaMcp, refusalBackoff, backoffHolds, REFUSAL_BACKOFF_MS };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('helper crashed: ' + err.message + '\n');
    process.exit(1);
  });
}
