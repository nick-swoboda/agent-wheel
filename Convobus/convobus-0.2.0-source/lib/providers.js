'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const { loadSeats } = require('./seats');
const { liveCards, readLog, logRevision } = require('./store');
const { resolveVendorSession } = require('./methods/filewins');
const { PROVIDERS } = require('./catalog');

const ROUTES = PROVIDERS.flatMap((provider) =>
  provider.routes.map((route) => ({ ...route, provider: provider.id, providerName: provider.name })),
);

const PROJECT_PATH_CACHE = new Map();
const PROJECT_EXISTS_CACHE = new Map();
const PROJECT_CHECK_TTL_MS = 30000;
const SESSION_STATUS_CACHE = new Map();
const CARD_RECORD_CACHE = new Map();
const SESSION_STATUS_TTL_MS = 2000;
const resolverRequests = new Map();
let resolverWorker = null;
let resolverRequestId = 0;

function startResolverWorker() {
  if (resolverWorker) return resolverWorker;
  const worker = new Worker(path.join(__dirname, 'resolver-worker.js'));
  worker.on('message', (message) => {
    const pending = resolverRequests.get(message.id);
    if (!pending) return;
    resolverRequests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.value || null);
    if (resolverRequests.size === 0) worker.unref();
  });
  const fail = (error) => {
    if (resolverWorker !== worker) return;
    resolverWorker = null;
    for (const pending of resolverRequests.values()) pending.reject(error);
    resolverRequests.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => {
    if (code !== 0) fail(new Error(`resolver worker exited ${code}`));
    else if (resolverWorker === worker) resolverWorker = null;
  });
  resolverWorker = worker;
  worker.unref();
  return worker;
}

function resolveVendorSessionAsync(seat, project, home, variant) {
  return new Promise((resolve, reject) => {
    const id = ++resolverRequestId;
    resolverRequests.set(id, { resolve, reject });
    const worker = startResolverWorker();
    worker.ref();
    worker.postMessage({ id, seat, project, home, variant });
  });
}

function sessionSignature(files) {
  return (files || []).map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${file}:missing`;
    }
  }).join('|');
}

function cachedVendorSession(seat, project, home, variant) {
  const key = JSON.stringify([seat, canonicalProject(project), home || '', variant || '']);
  const now = Date.now();
  const cached = SESSION_STATUS_CACHE.get(key);
  if (cached && now - cached.at < SESSION_STATUS_TTL_MS) {
    const watched = [cached.value && cached.value.file, ...((cached.value && cached.value.looked) || [])]
      .filter(Boolean);
    if (sessionSignature(watched) === cached.signature) return cached.value;
  }
  const value = resolveVendorSession(seat, project, home, { variant });
  const watched = [value && value.file, ...((value && value.looked) || [])].filter(Boolean);
  SESSION_STATUS_CACHE.set(key, { at: now, signature: sessionSignature(watched), value });
  return value;
}

function cachedVendorSessionAsync(seat, project, home, variant) {
  const key = JSON.stringify([seat, canonicalProject(project), home || '', variant || '']);
  const now = Date.now();
  const cached = SESSION_STATUS_CACHE.get(key);
  if (cached && cached.promise) return cached.promise;
  if (cached && now - cached.at < SESSION_STATUS_TTL_MS) {
    const watched = [cached.value && cached.value.file, ...((cached.value && cached.value.looked) || [])]
      .filter(Boolean);
    if (sessionSignature(watched) === cached.signature) return Promise.resolve(cached.value);
  }
  const promise = resolveVendorSessionAsync(seat, project, home, variant)
    .then((value) => {
      const watched = [value && value.file, ...((value && value.looked) || [])].filter(Boolean);
      SESSION_STATUS_CACHE.set(key, {
        at: Date.now(),
        signature: sessionSignature(watched),
        value,
      });
      return value;
    })
    .catch((error) => {
      SESSION_STATUS_CACHE.delete(key);
      throw error;
    });
  SESSION_STATUS_CACHE.set(key, { at: now, signature: '', value: null, promise });
  return promise;
}

function canonicalProject(project) {
  const raw = project == null ? '' : String(project).trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  if (PROJECT_PATH_CACHE.has(resolved)) return PROJECT_PATH_CACHE.get(resolved);
  // Desktop/Documents access can wait on macOS privacy UI. Resolve in a
  // bounded child so provider lists and polling can never freeze the app.
  const result = spawnSync('/bin/realpath', [resolved], {
    encoding: 'utf8',
    timeout: 150,
    killSignal: 'SIGKILL',
  });
  const canonical = result.status === 0 && String(result.stdout || '').trim()
    ? String(result.stdout).trim()
    : resolved;
  PROJECT_PATH_CACHE.set(resolved, canonical);
  return canonical;
}

function projectExists(project) {
  const canonical = canonicalProject(project);
  if (!canonical) return false;
  const now = Date.now();
  const cached = PROJECT_EXISTS_CACHE.get(canonical);
  if (cached && now - cached.at < PROJECT_CHECK_TTL_MS) return cached.exists;
  const result = spawnSync('/bin/test', ['-d', canonical], {
    timeout: 150,
    killSignal: 'SIGKILL',
  });
  // A privacy wait is not evidence that a previously registered folder is
  // missing. Keep it selectable and let an intentional action request access.
  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  const exists = timedOut || result.status === 0;
  PROJECT_EXISTS_CACHE.set(canonical, { at: now, exists });
  return exists;
}

function routeFor(input) {
  const o = input || {};
  return (
    ROUTES.find(
      (route) =>
        route.provider === o.provider &&
        route.surface === o.surface &&
        route.type === o.type,
    ) || null
  );
}

function defaultRouteForSeat(seat) {
  if (seat === 'claude-app') {
    return routeFor({ provider: 'claude', surface: 'app', type: 'cowork' });
  }
  return ROUTES.find((route) => route.seat === seat) || null;
}

function publicRoute(route) {
  if (!route) return null;
  return {
    provider: route.provider,
    providerName: route.providerName,
    surface: route.surface,
    type: route.type,
    label: route.label,
    seat: route.seat,
    variant: route.variant,
    appPath: route.appPath || null,
    command: route.command || null,
    bundleIdentifier: route.bundleIdentifier || null,
    projectBound: route.projectBound !== false,
  };
}

function normalizedRoute(input) {
  const route = routeFor(input);
  if (!route) return null;
  const project = canonicalProject(input && input.project);
  return {
    provider: route.provider,
    project,
    surface: route.surface,
    type: route.type,
    seat: route.seat,
    variant: route.variant,
  };
}

function inferredRoute(seat, kind) {
  if (seat === 'claude-app') {
    if (kind === 'cloud') return publicRoute(routeFor({ provider: 'claude', surface: 'app', type: 'cowork' }));
    if (kind === 'chat') return publicRoute(routeFor({ provider: 'claude', surface: 'app', type: 'chat' }));
    if (kind === 'jsonl' || kind === 'code') {
      return publicRoute(routeFor({ provider: 'claude', surface: 'app', type: 'claude-code' }));
    }
    return {
      provider: 'claude',
      providerName: 'Claude',
      surface: 'app',
      type: 'other',
      label: 'Other',
      seat,
      variant: null,
      inferred: true,
    };
  }
  const route = defaultRouteForSeat(seat);
  if (route) return { ...publicRoute(route), inferred: true };
  return {
    provider: 'other',
    providerName: 'Other',
    surface: 'other',
    type: 'other',
    label: 'Other',
    seat: seat || null,
    variant: null,
    inferred: true,
  };
}

function cardRecords(root) {
  const revision = logRevision(root);
  const cached = CARD_RECORD_CACHE.get(path.resolve(root));
  if (cached && cached.revision === revision) return cached.records;
  const records = new Map();
  const attach = new Map();
  for (const event of readLog(root) || []) {
    const id = (event.card && event.card.id) || event.id || null;
    if (!id) continue;
    if (event.event === 'attach') attach.set(id, event);
    if (!event.card || !event.card.id) continue;
    const old = records.get(id) || {};
    records.set(id, {
      card: event.card,
      t: event.t || old.t || null,
      route: event.route || old.route || null,
      loopId: event.loopId || old.loopId || null,
      runId: event.runId || old.runId || null,
      segmentId: event.segmentId || old.segmentId || null,
      stepId: event.stepId || old.stepId || null,
      cycle: event.cycle != null ? event.cycle : old.cycle,
      role: event.role || old.role || null,
    });
  }
  const result = [...records.entries()].map(([id, record]) => {
    const linked = attach.get(id);
    // 0.1.4 originally called ChatGPT Classic `chat` and used
    // chatgpt-chat-app. Keep those immutable lifecycle records under Classic;
    // the new Chat route has its own seat, so future records stay unambiguous.
    const legacyClassic =
      record.route &&
      record.route.provider === 'chatgpt' &&
      record.route.surface === 'app' &&
      record.route.type === 'chat' &&
      record.card.seat === 'chatgpt-chat-app';
    const explicitInput = legacyClassic
      ? { ...record.route, type: 'classic' }
      : record.route;
    const explicit = explicitInput && routeFor(explicitInput) ? normalizedRoute(explicitInput) : null;
    const route = explicit
      ? { ...publicRoute(routeFor(explicit)), project: explicit.project }
      : {
          ...inferredRoute(record.card.seat, linked && linked.kind),
          project: canonicalProject(record.card.cwd),
        };
    return Object.freeze({
      id,
      card: Object.freeze({ ...record.card }),
      t: record.t,
      route: Object.freeze({ ...route }),
      sessionId: linked && linked.sessionId ? linked.sessionId : null,
      sessionFile: linked && linked.sessionFile ? linked.sessionFile : null,
      kind: linked && linked.kind ? linked.kind : null,
      inferred: !explicit,
      loopId: record.loopId || null,
      runId: record.runId || null,
      segmentId: record.segmentId || null,
      stepId: record.stepId || null,
      cycle: record.cycle == null ? null : record.cycle,
      role: record.role || null,
    });
  });
  const immutable = Object.freeze(result);
  CARD_RECORD_CACHE.set(path.resolve(root), { revision, records: immutable });
  return immutable;
}

function normalizeUi(ui) {
  const input = ui && typeof ui === 'object' ? ui : {};
  const routeCatalogVersion = Number(input.routeCatalogVersion || 0);
  const projects = [];
  for (const entry of Array.isArray(input.projects) ? input.projects : []) {
    const project = canonicalProject(entry && entry.path);
    if (!project || projects.some((row) => row.path === project)) continue;
    const routes = {};
    const sourceRoutes = entry && entry.routes && typeof entry.routes === 'object' ? entry.routes : {};
    for (const [provider, selected] of Object.entries(sourceRoutes)) {
      const surface = selected && selected.surface;
      let type = selected && selected.type;
      // Before route catalog v2, ChatGPT App `chat` meant the separate
      // ChatGPT Classic bundle. Migrate that saved choice exactly once.
      if (routeCatalogVersion < 2 && provider === 'chatgpt' && surface === 'app' && type === 'chat') {
        type = 'classic';
      }
      const route = routeFor({ provider, surface, type });
      if (route) routes[provider] = { surface: route.surface, type: route.type };
    }
    projects.push({
      path: project,
      lastUsedAt: entry.lastUsedAt || null,
      routes,
    });
  }
  const lastProjectByProvider = {};
  const sourceLast =
    input.lastProjectByProvider && typeof input.lastProjectByProvider === 'object'
      ? input.lastProjectByProvider
      : {};
  for (const provider of PROVIDERS) {
    const project = canonicalProject(sourceLast[provider.id]);
    if (project) lastProjectByProvider[provider.id] = project;
  }
  return {
    routeCatalogVersion: 2,
    selectedProvider: PROVIDERS.some((provider) => provider.id === input.selectedProvider)
      ? input.selectedProvider
      : null,
    selectedProject: canonicalProject(input.selectedProject),
    lastProjectByProvider,
    projects,
  };
}

function addProject(map, project, props) {
  const canonical = canonicalProject(project);
  if (!canonical) return;
  const old = map.get(canonical) || {
    path: canonical,
    name: path.basename(canonical) || canonical,
    lastUsedAt: null,
    providers: new Set(),
    routes: {},
  };
  const p = props || {};
  if (p.lastUsedAt && (!old.lastUsedAt || p.lastUsedAt > old.lastUsedAt)) old.lastUsedAt = p.lastUsedAt;
  if (p.provider) old.providers.add(p.provider);
  if (p.routes && typeof p.routes === 'object') old.routes = { ...old.routes, ...p.routes };
  map.set(canonical, old);
}

function discoverProjects(root, prefs) {
  const map = new Map();
  const ui = normalizeUi(prefs && prefs.ui);
  const seats = loadSeats(root).seats || [];
  for (const seat of seats) {
    const route = defaultRouteForSeat(seat.handle);
    if (seat.cwd) {
      addProject(map, seat.cwd, {
        provider: route && route.provider,
        routes: route
          ? { [route.provider]: { surface: route.surface, type: route.type } }
          : {},
      });
    }
  }
  for (const record of cardRecords(root)) {
    if (record.runId) continue;
    if (!record.route.project) continue;
    const configured = routeFor(record.route);
    addProject(map, record.route.project, {
      provider: record.route.provider,
      lastUsedAt: record.t,
      routes: configured
        ? { [configured.provider]: { surface: configured.surface, type: configured.type } }
        : {},
    });
  }
  for (const project of ui.projects) {
    addProject(map, project.path, {
      lastUsedAt: project.lastUsedAt,
      routes: project.routes,
    });
  }
  return [...map.values()]
    .map((project) => ({
      path: project.path,
      name: project.name,
      lastUsedAt: project.lastUsedAt,
      providers: [...project.providers],
      routes: project.routes,
      exists: projectExists(project.path),
    }))
    .sort((a, b) => String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')) || a.name.localeCompare(b.name));
}

function projectMatchesProvider(project, provider) {
  if (!project || !provider) return false;
  if (project.routes && project.routes[provider]) return true;
  return Array.isArray(project.providers) && project.providers.includes(provider);
}

function projectsForProvider(root, prefs, provider) {
  if (!PROVIDERS.some((entry) => entry.id === provider)) return [];
  return discoverProjects(root, prefs).filter((project) => projectMatchesProvider(project, provider));
}

function resolvedLastProjects(root, prefs, projects) {
  const ui = normalizeUi(prefs && prefs.ui);
  const rows = projects || discoverProjects(root, prefs);
  const result = {};
  for (const provider of PROVIDERS) {
    const saved = canonicalProject(ui.lastProjectByProvider[provider.id]);
    if (saved && rows.some((project) => project.path === saved && projectMatchesProvider(project, provider.id))) {
      result[provider.id] = saved;
      continue;
    }
    if (
      ui.selectedProvider === provider.id &&
      ui.selectedProject &&
      rows.some(
        (project) =>
          project.path === ui.selectedProject && projectMatchesProvider(project, provider.id),
      )
    ) {
      result[provider.id] = ui.selectedProject;
      continue;
    }
    const recent = rows.find((project) => projectMatchesProvider(project, provider.id));
    if (recent) result[provider.id] = recent.path;
  }
  return result;
}

function selectedContext(root, prefs) {
  const ui = normalizeUi(prefs && prefs.ui);
  const projects = discoverProjects(root, prefs);
  const lastProjectByProvider = resolvedLastProjects(root, prefs, projects);
  let provider = ui.selectedProvider;
  let project = ui.selectedProject;
  const currentRoute = defaultRouteForSeat(prefs && prefs.currentSeat);
  if (!provider && currentRoute) provider = currentRoute.provider;
  if (!provider) provider = PROVIDERS[0].id;
  const providerRows = projects.filter((row) => projectMatchesProvider(row, provider));
  if (!project || !providerRows.some((row) => row.path === project)) {
    const seat = (loadSeats(root).seats || []).find((row) => row.handle === (prefs && prefs.currentSeat));
    const seatProject = canonicalProject(seat && seat.cwd);
    project =
      lastProjectByProvider[provider] ||
      (seatProject && providerRows.some((row) => row.path === seatProject) ? seatProject : null) ||
      (providerRows[0] && providerRows[0].path) ||
      null;
  }
  const savedProject = projects.find((row) => row.path === project);
  const saved = savedProject && savedProject.routes && savedProject.routes[provider];
  let route = saved && routeFor({ provider, surface: saved.surface, type: saved.type });
  const currentSeat = (loadSeats(root).seats || []).find((row) => row.handle === (prefs && prefs.currentSeat));
  if (
    !route &&
    currentRoute &&
    currentRoute.provider === provider &&
    canonicalProject(currentSeat && currentSeat.cwd) === project
  ) {
    route = currentRoute;
  }
  if (!route) route = ROUTES.find((row) => row.provider === provider) || ROUTES[0];
  return {
    provider,
    project,
    surface: route.surface,
    type: route.type,
  };
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function routeStatus(root, input, opts) {
  const o = opts || {};
  const normalized = normalizedRoute(input);
  if (!normalized) return { status: 'blocked', reason: 'unknown route', route: null };
  const route = routeFor(normalized);
  const project = normalized.project;
  const publicValue = { ...publicRoute(route), project };
  if (!project) return { status: 'blocked', reason: 'choose a project', route: publicValue };
  if (!projectExists(project)) {
    return {
      status: 'blocked',
      reason: 'project folder is missing',
      action: 'choose-folder',
      route: publicValue,
    };
  }

  const seat = (loadSeats(root).seats || []).find((row) => row.handle === route.seat);
  if (!seat || seat.state === 'missing' || !seat.path) {
    return { status: 'blocked', reason: 'provider surface is not installed', route: publicValue };
  }

  const liveIds = new Set(liveCards(root).map((card) => card.id));
  const waiting = cardRecords(root).find(
    (record) =>
      liveIds.has(record.id) &&
      record.route.provider === normalized.provider &&
      record.route.surface === normalized.surface &&
      record.route.type === normalized.type &&
      record.route.project === project,
  );
  if (waiting) return { status: 'waiting', reason: 'waiting for reply', route: publicValue };

  if (route.seat === 'chatgpt-chat-app' || route.seat === 'chatgpt-modern-chat-app') {
    const classic = route.seat === 'chatgpt-chat-app';
    const routeName = classic ? 'ChatGPT Classic' : 'ChatGPT Chat';
    const kind = classic ? 'chatgpt-classic' : 'chatgpt-chat';
    const method = o.accessibility ? 'ax' : 'none';
    if (!o.accessibility) {
      return {
        status: 'blocked',
        reason: `Accessibility is required for ${routeName}`,
        action: 'allow-accessibility',
        route: publicValue,
        sessionId: null,
        sessionFile: null,
        kind,
        method,
      };
    }
    const probe = o.chatgptProbe || (classic ? o.chatgptClassicProbe : o.chatgptChatProbe) || {};
    if (probe.error) {
      return {
        status: 'blocked',
        reason: probe.error,
        ...(/accessibility/i.test(String(probe.error)) ? { action: 'allow-accessibility' } : {}),
        route: publicValue,
        sessionId: null,
        sessionFile: null,
        kind,
        method,
      };
    }
    if (probe.tcc) {
      return {
        status: 'blocked',
        reason: `Accessibility could not inspect ${routeName}`,
        action: 'allow-accessibility',
        route: publicValue,
        sessionId: null,
        sessionFile: null,
        kind,
        method,
      };
    }
    const exactSurface = classic || probe.mode === 'chat';
    if (probe.running && probe.composer && exactSurface) {
      return {
        status: 'attached',
        reason: null,
        route: publicValue,
        sessionId: null,
        sessionFile: null,
        kind,
        method,
      };
    }
    const wrongSurface = !classic && probe.running && probe.composer && probe.mode && probe.mode !== 'chat';
    return {
      status: 'needs-session',
      reason: !probe.running
        ? `${routeName} is not running`
        : wrongSurface
          ? 'ChatGPT is showing Work, not Chat'
          : `${routeName} composer is not available`,
      route: publicValue,
      sessionId: null,
      sessionFile: null,
      kind,
      method,
      attach: {
        mode: 'app',
        appPath: route.appPath,
        title: classic ? 'Open ChatGPT Classic' : 'Open ChatGPT Chat',
        instruction: classic
          ? 'Open ChatGPT Classic and select the existing conversation. Convobus will attach when its composer is ready.'
          : 'Open the Chat side of ChatGPT and select the existing conversation. Convobus will attach only to Chat, never Work.',
      },
    };
  }

  if (route.seat === 'claude-app') {
    const method = o.accessibility ? 'ax' : 'none';
    if (!o.accessibility) {
      return {
        status: 'blocked',
        reason: 'Accessibility is required for Claude App routes',
        action: 'allow-accessibility',
        route: publicValue,
        sessionId: null,
        sessionFile: null,
        kind: route.variant || null,
        method,
      };
    }
    const probe = o.appProbe || {};
    if (probe.error || probe.tcc) {
      return {
        status: 'blocked',
        reason: probe.error || 'Accessibility could not inspect Claude',
        ...(probe.tcc || /accessibility/i.test(String(probe.error || ''))
          ? { action: 'allow-accessibility' }
          : {}),
        route: publicValue,
        sessionId: null,
        sessionFile: null,
        kind: route.variant || null,
        method,
      };
    }
    if (!probe.running || !probe.composer) {
      return {
        status: 'needs-session',
        reason: probe.running ? 'Claude composer is not available' : 'Claude is not running',
        route: publicValue,
        sessionId: null,
        sessionFile: null,
        kind: route.variant || null,
        method,
        attach: {
          mode: 'app',
          appPath: route.appPath,
          title: 'Open Claude',
          instruction: `Open ${route.label} in Claude and select the existing ${path.basename(project)} session. Convobus will attach when its composer is ready.`,
        },
      };
    }
  }

  const home = o.home || process.env.HOME || os.homedir();
  // An explicit route resolves only its exact provider/type/project session; missing never falls through.
  if (o.deferResolution) return { status: 'resolving', reason: null, route: publicValue, method: 'stdio' };
  const resolved = Object.prototype.hasOwnProperty.call(o, 'resolvedSession')
    ? o.resolvedSession
    : cachedVendorSession(route.seat, project, home, route.variant);
  const attached = !!(resolved && (resolved.id || resolved.file));
  let method = 'stdio';
  if (route.seat === 'claude-app') method = o.accessibility ? 'ax' : 'none';
  if (attached) {
    return {
      status: 'attached',
      reason: null,
      route: publicValue,
      sessionId: resolved.id || null,
      sessionFile: resolved.file || null,
      kind: resolved.kind || null,
      method,
    };
  }

  const attach = route.surface === 'app'
    ? {
        mode: 'app',
        appPath: route.appPath || null,
        title: `Open ${route.providerName}`,
        instruction: `Open ${route.label} in ${route.providerName}, create or select the session for ${path.basename(project)}, and Convobus will attach automatically.`,
      }
    : {
        mode: 'cli',
        appPath: '/System/Applications/Utilities/Terminal.app',
        title: 'Open Terminal',
        command: `cd ${shellQuote(project)} && ${route.command}`,
        instruction: `Open Terminal in ${path.basename(project)} and run ${route.command}. Convobus will attach automatically.`,
      };
  return {
    status: 'needs-session',
    reason: 'no matching session is attached',
    route: publicValue,
    method,
    attach,
  };
}

async function routeStatusAsync(root, input, opts) {
  const o = opts || {};
  const preflight = routeStatus(root, input, { ...o, deferResolution: true });
  if (preflight.status !== 'resolving') return preflight;
  const normalized = normalizedRoute(input);
  const route = routeFor(normalized);
  const home = o.home || process.env.HOME || os.homedir();
  let resolved = null;
  try {
    resolved = await cachedVendorSessionAsync(route.seat, normalized.project, home, route.variant);
  } catch {
    resolved = null;
  }
  return routeStatus(root, input, { ...o, resolvedSession: resolved });
}

function providerCatalog(root, prefs) {
  const seats = new Map((loadSeats(root).seats || []).map((seat) => [seat.handle, seat]));
  const projects = discoverProjects(root, prefs);
  return {
    providers: PROVIDERS.map((provider) => ({
      id: provider.id,
      name: provider.name,
      routes: provider.routes.map((route) => {
        const seat = seats.get(route.seat);
        return {
          ...publicRoute({ ...route, provider: provider.id, providerName: provider.name }),
          installed: !!(seat && seat.state !== 'missing' && seat.path),
        };
      }),
    })),
    projects,
    selection: selectedContext(root, prefs),
    lastProjectByProvider: resolvedLastProjects(root, prefs, projects),
    unassigned: cardRecords(root).some((record) => !record.route.project),
  };
}

module.exports = {
  PROVIDERS,
  ROUTES,
  canonicalProject,
  projectExists,
  routeFor,
  publicRoute,
  normalizedRoute,
  inferredRoute,
  cardRecords,
  normalizeUi,
  discoverProjects,
  projectMatchesProvider,
  projectsForProvider,
  resolvedLastProjects,
  selectedContext,
  routeStatus,
  routeStatusAsync,
  providerCatalog,
};
