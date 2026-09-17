'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  paths,
  ensureDir,
  withStateLock,
  readJson,
  writeJson,
  appendLog,
  readLog,
  logRevision,
  liveCards,
  removeInflight,
} = require('./store');
const { makeCard } = require('./card');
const { routeFor, publicRoute, canonicalProject, projectExists } = require('./providers');
const { runTurn } = require('./turn');

const LOOP_SCHEMA_VERSION = 2;
const MIN_CYCLES = 1;
const MAX_CYCLES = 50;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_HANDOFF_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_RECEIPTS = 128;
const MAX_HISTORY_PAGE = 100;
const RUNNER_PROMISES = new Map();
const LOOP_HISTORY_CACHE = new Map();
const TERMINAL_STATES = new Set(['complete', 'stopped']);

class LoopError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = 'LoopError';
    this.status = status || 400;
    this.code = code || 'invalid-loop-request';
    if (details) this.details = details;
  }
}

function nowIso(opts) {
  return (opts && opts.now ? opts.now() : new Date()).toISOString();
}

function newId(prefix, opts) {
  const value = opts && opts.id ? opts.id(prefix) : crypto.randomUUID();
  return `${prefix}_${value}`;
}

function byteLength(value) {
  return Buffer.byteLength(String(value == null ? '' : value), 'utf8');
}

function requiredText(value, label, maxBytes = MAX_TEXT_BYTES) {
  const text = String(value == null ? '' : value);
  if (!text.trim()) throw new LoopError(`${label} is required`, 400, 'missing-field');
  if (byteLength(text) > maxBytes) throw new LoopError(`${label} is too long`, 413, 'text-too-large');
  return text;
}

function optionalText(value, label, maxBytes = MAX_TEXT_BYTES) {
  if (value == null || value === '') return '';
  const text = String(value);
  if (byteLength(text) > maxBytes) throw new LoopError(`${label} is too long`, 413, 'text-too-large');
  return text;
}

function cycleCount(value) {
  const count = Number(value == null ? 1 : value);
  if (!Number.isInteger(count) || count < MIN_CYCLES || count > MAX_CYCLES) {
    throw new LoopError(`cycles must be between ${MIN_CYCLES} and ${MAX_CYCLES}`, 400, 'invalid-cycles');
  }
  return count;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function requestHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function routeKey(route) {
  return [route.provider, route.surface, route.type].join('/');
}

function projectDirectoryExists(project) {
  try {
    return fs.statSync(project).isDirectory();
  } catch {
    return false;
  }
}

function normalizeRoute(input, project) {
  const value = input && input.route && typeof input.route === 'object' ? input.route : input;
  const route = routeFor(value || {});
  if (!route) throw new LoopError('choose an available provider route', 400, 'unknown-route');
  return {
    ...publicRoute(route),
    project,
  };
}

function normalizeParticipant(input, project, role) {
  if (role === 'leader' && (input === 'me' || input === 'human' || (input && input.kind === 'human'))) {
    return { kind: 'human' };
  }
  if (input == null || input === '') {
    if (role === 'leader') throw new LoopError('Leader is required', 400, 'missing-leader');
    return null;
  }
  return { kind: 'route', route: normalizeRoute(input, project) };
}

function definitionRoleOrder(definition) {
  const roles = [{ role: 'leader', participant: definition.leader }];
  if (definition.builder) roles.push({ role: 'builder', participant: definition.builder });
  if (definition.reviewer) roles.push({ role: 'reviewer', participant: definition.reviewer });
  return roles;
}

function validateDistinctRoutes(definition) {
  const seen = new Set();
  for (const slot of definitionRoleOrder(definition)) {
    if (!slot.participant || slot.participant.kind !== 'route') continue;
    const key = routeKey(slot.participant.route);
    if (seen.has(key)) {
      throw new LoopError('Leader, Builder, and Reviewer routes must be distinct', 400, 'duplicate-route');
    }
    seen.add(key);
  }
}

function normalizedDefinition(input, previous, opts) {
  const source = input || {};
  const project = canonicalProject(source.project != null ? source.project : previous && previous.project);
  if (!project) throw new LoopError('Project is required', 400, 'missing-project');
  if (!projectExists(project)) throw new LoopError('Project folder is missing', 400, 'missing-project-folder');
  const createdAt = (previous && previous.createdAt) || nowIso(opts);
  const definition = {
    ...(previous || {}),
    id: (previous && previous.id) || newId('loop', opts),
    name: requiredText(source.name != null ? source.name : previous && previous.name, 'Name', 512).trim(),
    project,
    leader: normalizeParticipant(
      Object.prototype.hasOwnProperty.call(source, 'leader') ? source.leader : previous && previous.leader,
      project,
      'leader',
    ),
    builder: normalizeParticipant(
      Object.prototype.hasOwnProperty.call(source, 'builder') ? source.builder : previous && previous.builder,
      project,
      'builder',
    ),
    reviewer: normalizeParticipant(
      Object.prototype.hasOwnProperty.call(source, 'reviewer') ? source.reviewer : previous && previous.reviewer,
      project,
      'reviewer',
    ),
    defaultCycles: cycleCount(
      source.defaultCycles != null ? source.defaultCycles : previous && previous.defaultCycles,
    ),
    createdAt,
    updatedAt: nowIso(opts),
  };
  if (!definition.builder && !definition.reviewer) {
    throw new LoopError('Choose a Builder, a Reviewer, or both', 400, 'missing-team-role');
  }
  validateDistinctRoutes(definition);
  return definition;
}

function emptyLoopDocument() {
  return { schemaVersion: LOOP_SCHEMA_VERSION, definitions: [], requests: [] };
}

function emptyRunDocument() {
  return { schemaVersion: LOOP_SCHEMA_VERSION, active: null, requests: [] };
}

function readDocument(file, fallback) {
  try {
    const value = readJson(file, fallback);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch (error) {
    if (error instanceof SyntaxError) throw new LoopError('Loop data could not be read', 500, 'invalid-loop-storage');
    throw error;
  }
}

function readLoopDefinitions(root) {
  ensureDir(root);
  const raw = readDocument(paths(root).loops, emptyLoopDocument());
  return {
    ...raw,
    schemaVersion: Number(raw.schemaVersion) || LOOP_SCHEMA_VERSION,
    definitions: Array.isArray(raw.definitions) ? raw.definitions : [],
    requests: Array.isArray(raw.requests) ? raw.requests : [],
  };
}

function definitionTime(definition) {
  const value = Date.parse((definition && (definition.updatedAt || definition.createdAt)) || '');
  return Number.isFinite(value) ? value : 0;
}

function workspaceDefinitions(document) {
  const groups = new Map();
  for (const definition of document.definitions || []) {
    const project = canonicalProject(definition && definition.project);
    if (!project) continue;
    const values = groups.get(project) || [];
    values.push(definition);
    groups.set(project, values);
  }
  const result = [];
  for (const values of groups.values()) {
    const explicit = values.filter((definition) => definition.workspace === true);
    const candidates = explicit.length ? explicit : values;
    result.push(candidates.slice().sort((a, b) => definitionTime(b) - definitionTime(a))[0]);
  }
  return result.sort((a, b) => definitionTime(b) - definitionTime(a));
}

function migrateWorkspaceProfiles(root) {
  return withStateLock(root, () => {
    const document = readLoopDefinitions(root);
    let changed = Number(document.schemaVersion || 0) !== LOOP_SCHEMA_VERSION;
    const selected = new Set(workspaceDefinitions(document).map((definition) => definition.id));
    document.schemaVersion = LOOP_SCHEMA_VERSION;
    document.definitions = document.definitions.map((definition) => {
      const workspace = selected.has(definition.id);
      if (definition.workspace !== workspace || definition.legacy === workspace) changed = true;
      return {
        ...definition,
        workspace,
        ...(workspace ? { legacy: false } : { legacy: true }),
      };
    });
    if (changed) writeLoopDefinitions(root, document);
    return document;
  });
}

function readLoopRuns(root) {
  ensureDir(root);
  const raw = readDocument(paths(root).loopRuns, emptyRunDocument());
  return {
    ...raw,
    schemaVersion: Number(raw.schemaVersion) || LOOP_SCHEMA_VERSION,
    active: raw.active && typeof raw.active === 'object' ? raw.active : null,
    requests: Array.isArray(raw.requests) ? raw.requests : [],
  };
}

function writeLoopDefinitions(root, document) {
  writeJson(paths(root).loops, document);
}

function writeLoopRuns(root, document) {
  writeJson(paths(root).loopRuns, document);
}

function receiptFor(document, requestId, hash) {
  const receipt = (document.requests || []).find((item) => item && item.id === requestId);
  if (!receipt) return null;
  if (receipt.hash !== hash) {
    throw new LoopError('request ID was already used for a different action', 409, 'request-id-conflict');
  }
  return receipt.response;
}

function addReceipt(document, requestId, hash, response) {
  const requests = (document.requests || []).filter((item) => item && item.id !== requestId);
  requests.push({ id: requestId, hash, response, at: new Date().toISOString() });
  document.requests = requests.slice(-MAX_REQUEST_RECEIPTS);
}

function requireRequest(payload) {
  const requestId = String((payload && payload.requestId) || '').trim();
  if (!requestId) throw new LoopError('requestId is required', 400, 'missing-request-id');
  return requestId;
}

function definitionSummary(definition, activeRun) {
  const isCurrent = !!(activeRun && activeRun.loopId === definition.id);
  const last = isCurrent ? runSummary(activeRun) : definition.lastRun || null;
  return {
    id: definition.id,
    name: definition.name,
    project: definition.project,
    leader: definition.leader,
    builder: definition.builder || null,
    reviewer: definition.reviewer || null,
    defaultCycles: definition.defaultCycles || 1,
    revision: Number(definition.revision || 0),
    createdAt: definition.createdAt || null,
    updatedAt: definition.updatedAt || null,
    workspace: definition.workspace === true,
    state: last && last.state ? last.state : null,
    progress: last && last.progress ? last.progress : null,
    active: isCurrent && !TERMINAL_STATES.has(activeRun.state),
    runId: isCurrent ? activeRun.id : last && last.id,
  };
}

function workspaceSummary(definition, activeRun, latestRun) {
  const active = !!(
    activeRun &&
    activeRun.project === canonicalProject(definition.project) &&
    !TERMINAL_STATES.has(activeRun.internalState || activeRun.state)
  );
  const latest = active ? activeRun : latestRun;
  return {
    id: definition.id,
    project: definition.project,
    leader: definition.leader,
    builder: definition.builder || null,
    reviewer: definition.reviewer || null,
    defaultCycles: definition.defaultCycles || 1,
    revision: Number(definition.revision || 0),
    createdAt: definition.createdAt || null,
    updatedAt: definition.updatedAt || null,
    active,
    state: latest && latest.state ? latest.state : null,
    progress: latest && latest.progress ? latest.progress : null,
    latestRun: latest || null,
  };
}

function listLoops(root, project) {
  const document = readLoopDefinitions(root);
  const definitions = document.definitions;
  const active = readLoopRuns(root).active;
  const activeSummary = active ? runSummary(active) : null;
  const history = projectRunSummaries(root);
  const workspaces = workspaceDefinitions(document).map((definition) => {
    const key = canonicalProject(definition.project);
    const values = history.get(key) || [];
    return workspaceSummary(definition, activeSummary, values.at(-1) || null);
  });
  const selectedProject = canonicalProject(project);
  return {
    loops: definitions.map((definition) => definitionSummary(definition, active)),
    workspaces,
    workspace: selectedProject
      ? workspaces.find((workspace) => canonicalProject(workspace.project) === selectedProject) || null
      : null,
    activeRun: activeSummary,
  };
}

function mutateLoop(root, payload, opts) {
  const source = payload || {};
  const action = String(source.action || (source.id ? 'update' : 'create')).toLowerCase();
  const requestId = requireRequest(source);
  const hash = requestHash({ ...source, requestId: undefined });
  return withStateLock(root, () => {
    const document = readLoopDefinitions(root);
    const prior = receiptFor(document, requestId, hash);
    if (prior) return prior;
    const runs = readLoopRuns(root);
    let response;
    if (action === 'save-project-profile') {
      const project = canonicalProject(source.project);
      if (!project) throw new LoopError('Project is required', 400, 'missing-project');
      const previous = workspaceDefinitions(document).find(
        (definition) => canonicalProject(definition.project) === project,
      ) || null;
      const definition = normalizedDefinition({
        ...source,
        project,
        name: (previous && previous.name) || path.basename(project) || 'Loops',
        defaultCycles: source.defaultCycles != null ? source.defaultCycles : source.cycles,
      }, previous, opts);
      definition.workspace = true;
      definition.legacy = false;
      definition.revision = previous ? Number(previous.revision || 0) + 1 : 0;
      if (previous) {
        const index = document.definitions.findIndex((item) => item.id === previous.id);
        document.definitions[index] = definition;
      } else {
        document.definitions.push(definition);
      }
      for (const item of document.definitions) {
        if (item.id === definition.id || canonicalProject(item.project) !== project) continue;
        item.workspace = false;
        item.legacy = true;
      }
      document.schemaVersion = LOOP_SCHEMA_VERSION;
      appendLog(root, { event: 'loop-workspace-saved', loopId: definition.id, project, definition: { ...definition } });
      const activeSummary = runs.active ? runSummary(runs.active) : null;
      response = {
        ok: true,
        workspace: workspaceSummary(definition, activeSummary, definition.lastRun || null),
      };
    } else if (action === 'create') {
      const definition = normalizedDefinition(source, null, opts);
      document.definitions.push(definition);
      appendLog(root, { event: 'loop-created', loopId: definition.id, definition: { ...definition } });
      response = { ok: true, loop: definitionSummary(definition, runs.active) };
    } else if (action === 'update') {
      const index = document.definitions.findIndex((item) => item.id === source.id);
      if (index < 0) throw new LoopError('Loop was not found', 404, 'loop-not-found');
      const old = document.definitions[index];
      if (source.revision != null && Number(source.revision) !== Number(old.revision || 0)) {
        throw new LoopError('Loop changed before this edit was saved', 409, 'stale-loop');
      }
      const definition = normalizedDefinition(source, old, opts);
      definition.revision = Number(old.revision || 0) + 1;
      document.definitions[index] = definition;
      appendLog(root, { event: 'loop-updated', loopId: definition.id, definition: { ...definition } });
      response = { ok: true, loop: definitionSummary(definition, runs.active) };
    } else if (action === 'delete') {
      const index = document.definitions.findIndex((item) => item.id === source.id);
      if (index < 0) throw new LoopError('Loop was not found', 404, 'loop-not-found');
      if (runs.active && runs.active.loopId === source.id && !TERMINAL_STATES.has(runs.active.state)) {
        throw new LoopError('Stop this Loop before deleting it', 409, 'loop-active');
      }
      const [definition] = document.definitions.splice(index, 1);
      appendLog(root, { event: 'loop-deleted', loopId: definition.id });
      response = { ok: true, deleted: definition.id };
    } else {
      throw new LoopError('unknown Loop action', 400, 'unknown-loop-action');
    }
    addReceipt(document, requestId, hash, response);
    writeLoopDefinitions(root, document);
    return response;
  });
}

function frozenDefinition(definition) {
  return {
    id: definition.id,
    name: definition.name,
    project: definition.project,
    leader: definition.leader,
    builder: definition.builder || null,
    reviewer: definition.reviewer || null,
  };
}

function newSegment(run, cycles, guidance, opts) {
  const number = (run.segments || []).length + 1;
  const segment = {
    id: newId('segment', opts),
    number,
    cycles,
    guidance: guidance || '',
    startedAt: nowIso(opts),
    completedAt: null,
  };
  run.segments = [...(run.segments || []), segment];
  run.cursor = { segment: number, cycle: 1, slot: 0 };
  return segment;
}

function currentSegment(run) {
  return (run.segments || []).find((segment) => segment.number === run.cursor.segment) || null;
}

function currentSlot(run) {
  return definitionRoleOrder(run.definition)[run.cursor.slot] || null;
}

function roleLabel(role) {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
}

function cursorIdentity(run) {
  return [run.cursor.segment, run.cursor.cycle, run.cursor.slot].join(':');
}

function sharesExclusiveAppSurface(previous, next) {
  if (!previous || !next || previous.surface !== 'app' || next.surface !== 'app') return false;
  if (routeKey(previous) === routeKey(next)) return false;
  if (previous.bundleIdentifier && next.bundleIdentifier) {
    return previous.bundleIdentifier === next.bundleIdentifier;
  }
  return !!(previous.appPath && next.appPath && previous.appPath === next.appPath);
}

function visibleState(state) {
  if (state === 'needs-input') return 'your-turn';
  if (state === 'complete') return 'complete';
  if (state === 'needs-attention') return 'needs-attention';
  if (state === 'paused' || state === 'stopped') return state;
  return 'waiting';
}

function runProgress(run) {
  const segment = currentSegment(run) || (run.segments || []).at(-1) || null;
  if (!segment) return null;
  const slots = definitionRoleOrder(run.definition).length;
  const completed = run.state === 'complete'
    ? segment.cycles * slots
    : Math.max(0, ((run.cursor && run.cursor.cycle ? run.cursor.cycle : 1) - 1) * slots + (run.cursor ? run.cursor.slot : 0));
  return {
    segment: segment.number,
    cycle: Math.min(run.cursor && run.cursor.cycle ? run.cursor.cycle : segment.cycles, segment.cycles),
    cycles: segment.cycles,
    step: completed,
    steps: segment.cycles * slots,
  };
}

function runSummary(run) {
  const slot = run && run.cursor ? currentSlot(run) : null;
  return {
    id: run.id,
    loopId: run.loopId,
    name: run.name,
    runName: run.runName || null,
    project: run.project,
    state: visibleState(run.state),
    internalState: run.state,
    reason: run.reason || null,
    action: run.attention && run.attention.action ? run.attention.action : null,
    progress: runProgress(run),
    nextRole: slot ? slot.role : null,
    nextRoute: slot && slot.participant.kind === 'route' ? slot.participant.route : null,
    pauseRequested: !!run.pauseRequested,
    stopRequested: !!run.stopRequested,
    active: !TERMINAL_STATES.has(run.state),
    revision: Number(run.revision || 0),
    startedAt: run.createdAt || null,
    updatedAt: run.updatedAt || null,
    completedAt: run.completedAt || null,
  };
}

function abandonCurrentStep(root, run, reason) {
  const step = run.currentStep;
  if (!step) return;
  removeInflight(root, step.cardId);
  appendLog(root, {
    event: 'loop-turn-stopped',
    loopId: run.loopId,
    runId: run.id,
    segmentId: step.segmentId,
    stepId: step.id,
    cardId: step.cardId,
    segment: step.segment,
    cycle: step.cycle,
    slot: step.slot,
    role: step.role,
    route: step.route,
    reason: reason || null,
  });
  run.currentStep = null;
}

function updateDefinitionLastRun(root, run) {
  const document = readLoopDefinitions(root);
  const definition = document.definitions.find((item) => item.id === run.loopId);
  if (!definition) return;
  definition.lastRun = runSummary(run);
  writeLoopDefinitions(root, document);
}

function saveRun(root, document, run, opts) {
  run.revision = Number(run.revision || 0) + 1;
  run.updatedAt = nowIso(opts);
  document.active = run;
  writeLoopRuns(root, document);
  updateDefinitionLastRun(root, run);
  return run;
}

function logGoal(root, run, segment, content, humanLeader) {
  appendLog(root, {
    event: 'loop-goal',
    loopId: run.loopId,
    runId: run.id,
    runName: run.runName || null,
    segmentId: segment.id,
    segment: segment.number,
    cycle: 1,
    role: 'leader',
    actor: humanLeader ? 'human' : 'goal',
    content,
  });
}

function advanceCursor(run, opts) {
  const slots = definitionRoleOrder(run.definition);
  const segment = currentSegment(run);
  if (!segment) throw new LoopError('Loop segment is missing', 500, 'invalid-run');
  if (run.cursor.slot + 1 < slots.length) {
    run.cursor.slot += 1;
    return false;
  }
  if (run.cursor.cycle < segment.cycles) {
    run.cursor.cycle += 1;
    run.cursor.slot = 0;
    return false;
  }
  segment.completedAt = nowIso(opts);
  run.state = 'complete';
  run.completedAt = segment.completedAt;
  run.reason = null;
  return true;
}

function appendHumanTurn(root, run, content, replacedRole, opts) {
  const slot = currentSlot(run);
  const segment = currentSegment(run);
  const stepId = newId('step', opts);
  appendLog(root, {
    event: 'loop-human-turn',
    loopId: run.loopId,
    runId: run.id,
    segmentId: segment.id,
    stepId,
    segment: segment.number,
    cycle: run.cursor.cycle,
    slot: run.cursor.slot,
    role: slot.role,
    actor: 'human',
    replacedRole: replacedRole || null,
    content,
  });
  run.lastOutput = content;
  run.lastStepId = stepId;
  run.currentStep = null;
  run.reason = null;
  run.attention = null;
  const completed = advanceCursor(run, opts);
  if (completed) {
    appendLog(root, {
      event: 'loop-segment-completed',
      loopId: run.loopId,
      runId: run.id,
      segmentId: segment.id,
      segment: segment.number,
      finalRole: slot.role,
    });
    appendLog(root, { event: 'loop-completed', loopId: run.loopId, runId: run.id, segmentId: segment.id });
  }
  return completed;
}

function startLoopRun(root, payload, opts) {
  const source = payload || {};
  const requestId = requireRequest(source);
  const hash = requestHash({ ...source, requestId: undefined });
  const result = withStateLock(root, () => {
    const loops = readLoopDefinitions(root);
    const document = readLoopRuns(root);
    const prior = receiptFor(document, requestId, hash);
    if (prior) return prior;
    if (document.active && !TERMINAL_STATES.has(document.active.state)) {
      throw new LoopError('Another Loop is already active', 409, 'active-loop-exists', {
        activeRun: runSummary(document.active),
      });
    }
    const definition = loops.definitions.find((item) => item.id === source.loopId);
    if (!definition) throw new LoopError('Loop was not found', 404, 'loop-not-found');
    if (!projectDirectoryExists(definition.project)) {
      throw new LoopError('Project folder is missing', 409, 'missing-project-folder');
    }
    const goal = requiredText(source.goal, 'Goal');
    const runName = optionalText(source.runName, 'Name', 512).trim() || null;
    const cycles = cycleCount(source.cycles != null ? source.cycles : definition.defaultCycles);
    const stamp = nowIso(opts);
    const run = {
      id: newId('run', opts),
      loopId: definition.id,
      name: runName || definition.name,
      runName,
      project: definition.project,
      definition: frozenDefinition(definition),
      goal,
      state: 'preflight',
      reason: null,
      attention: null,
      revision: 0,
      segments: [],
      cursor: null,
      bindings: {},
      currentStep: null,
      lastOutput: '',
      pendingCorrection: '',
      pauseRequested: false,
      stopRequested: false,
      createdAt: stamp,
      updatedAt: stamp,
      completedAt: null,
    };
    const segment = newSegment(run, cycles, '', opts);
    logGoal(root, run, segment, goal, definition.leader.kind === 'human');
    appendLog(root, {
      event: 'loop-run-started',
      loopId: run.loopId,
      runId: run.id,
      runName,
      segmentId: segment.id,
      segment: segment.number,
      cycles,
      definition: run.definition,
    });
    appendLog(root, {
      event: 'loop-segment-started',
      loopId: run.loopId,
      runId: run.id,
      segmentId: segment.id,
      segment: segment.number,
      cycles,
    });
    if (definition.leader.kind === 'human') {
      run.lastOutput = goal;
      advanceCursor(run, opts);
    }
    run.state = currentSlot(run).participant.kind === 'human' ? 'needs-input' : 'running';
    saveRun(root, document, run, opts);
    const response = { ok: true, run: runSummary(run) };
    addReceipt(document, requestId, hash, response);
    writeLoopRuns(root, document);
    return response;
  });
  schedulePump(root, opts);
  return result;
}

function exactBinding(status) {
  return {
    sessionId: status.sessionId || null,
    sessionFile: status.sessionFile || null,
    kind: status.kind || null,
    method: status.method || null,
  };
}

function bindingMatches(previous, current) {
  if (!previous) return true;
  for (const key of ['sessionId', 'sessionFile', 'kind', 'method']) {
    if (previous[key] != null && current[key] !== previous[key]) return false;
  }
  return true;
}

function attentionForStatus(status) {
  const action = status && status.action
    ? status.action
    : status && status.status === 'needs-session'
      ? 'open-provider'
      : 'check-route';
  return {
    action,
    reason: (status && status.reason) || 'This route needs attention',
    status: status && status.status,
    route: status && status.route,
    attach: status && status.attach ? status.attach : null,
  };
}

function formatHandoff(run, slot) {
  const segment = currentSegment(run);
  const parts = [
    'Request',
    run.goal,
    '',
    'Your role',
    roleLabel(slot.role),
    '',
    'Cycle',
    `${run.cursor.cycle} of ${segment.cycles}`,
  ];
  if (run.lastOutput !== '') parts.push('', 'Previous reply', run.lastOutput);
  if (run.pendingCorrection) parts.push('', 'Correction', run.pendingCorrection);
  const body = parts.join('\n');
  if (byteLength(body) > MAX_HANDOFF_BYTES) {
    throw new LoopError('The next handoff is too large', 413, 'handoff-too-large');
  }
  return body;
}

function runnerOptions(opts) {
  return {
    contextStatus: (opts && opts.contextStatus) || ((root, route, statusOpts) => {
      return require('./control').contextStatusAsync(root, route, statusOpts);
    }),
    turn: (opts && opts.runTurn) || runTurn,
    now: opts && opts.now,
    id: opts && opts.id,
    home: opts && opts.home,
  };
}

function sameStep(run, step) {
  return !!(
    run && run.currentStep && step &&
    run.currentStep.id === step.id &&
    run.currentStep.cardId === step.cardId
  );
}

function markAttention(root, runId, attention, opts) {
  return withStateLock(root, () => {
    const document = readLoopRuns(root);
    const run = document.active;
    if (!run || run.id !== runId || TERMINAL_STATES.has(run.state)) return null;
    run.state = 'needs-attention';
    run.reason = attention.reason;
    run.attention = attention;
    run.pauseRequested = false;
    appendLog(root, {
      event: 'loop-needs-attention',
      loopId: run.loopId,
      runId: run.id,
      segmentId: currentSegment(run) && currentSegment(run).id,
      stepId: run.currentStep && run.currentStep.id,
      reason: attention.reason,
      action: attention.action,
    });
    saveRun(root, document, run, opts);
    return runSummary(run);
  });
}

async function executeCurrentTurn(root, initialRun, opts) {
  const dependencies = runnerOptions(opts);
  const slot = currentSlot(initialRun);
  if (!slot || slot.participant.kind !== 'route') return;
  const route = slot.participant.route;
  if (!projectDirectoryExists(initialRun.project)) {
    markAttention(root, initialRun.id, {
      action: 'choose-folder',
      reason: 'Project folder is missing',
      route,
    }, opts);
    return;
  }
  if (
    sharesExclusiveAppSurface(initialRun.lastRoute, route) &&
    initialRun.confirmedSurfaceStep !== cursorIdentity(initialRun)
  ) {
    markAttention(root, initialRun.id, {
      action: 'switch-surface',
      reason: `Open ${route.label || route.providerName} before continuing`,
      route,
    }, opts);
    return;
  }
  let status;
  try {
    status = await dependencies.contextStatus(root, route, { home: dependencies.home });
  } catch (error) {
    markAttention(root, initialRun.id, {
      action: 'check-route',
      reason: String(error && error.message ? error.message : error),
      route,
    }, opts);
    return;
  }
  if (!status || status.status !== 'attached') {
    markAttention(root, initialRun.id, attentionForStatus(status), opts);
    return;
  }
  if (status.method === 'ax' && !require('./control').readPrefs(root).axAccepted) {
    markAttention(root, initialRun.id, {
      action: 'accept-gate',
      reason: 'Allow this Loop to send through Accessibility',
      route,
    }, opts);
    return;
  }

  let prepared;
  try {
    prepared = withStateLock(root, () => {
      const document = readLoopRuns(root);
      const run = document.active;
      if (!run || run.id !== initialRun.id || run.state !== 'running' || run.pauseRequested || run.stopRequested) {
        return null;
      }
      const current = currentSlot(run);
      if (!current || current.role !== slot.role || current.participant.kind !== 'route' || routeKey(current.participant.route) !== routeKey(route)) {
        return null;
      }
      const competing = liveCards(root).find((card) => card.seat === route.seat);
      if (competing) {
        run.state = 'needs-attention';
        run.reason = 'This route is already handling another message';
        run.attention = { action: 'wait-for-route', reason: run.reason, route };
        saveRun(root, document, run, opts);
        return null;
      }
      const key = routeKey(route);
      const binding = exactBinding(status);
      if (run.bindings[key] && !bindingMatches(run.bindings[key], binding)) {
        run.state = 'needs-attention';
        run.reason = 'The selected provider session changed';
        run.attention = {
          action: 'confirm-session',
          reason: run.reason,
          route,
          previous: run.bindings[key],
          current: binding,
        };
        saveRun(root, document, run, opts);
        return null;
      }
      run.bindings[key] = run.bindings[key] || binding;
      const segment = currentSegment(run);
      const step = {
        id: newId('step', opts),
        cardId: newId('card', opts),
        phase: 'prepared',
        segmentId: segment.id,
        segment: segment.number,
        cycle: run.cursor.cycle,
        slot: run.cursor.slot,
        role: current.role,
        route,
        binding: run.bindings[key],
        correction: run.pendingCorrection || '',
        preparedAt: nowIso(opts),
      };
      run.currentStep = step;
      run.state = 'waiting';
      run.reason = null;
      run.attention = null;
      appendLog(root, {
        event: 'loop-turn-started',
        loopId: run.loopId,
        runId: run.id,
        segmentId: segment.id,
        stepId: step.id,
        cardId: step.cardId,
        segment: segment.number,
        cycle: step.cycle,
        slot: step.slot,
        role: step.role,
        route,
      });
      saveRun(root, document, run, opts);
      return { run, step, body: formatHandoff(run, current), binding: run.bindings[key] };
    });
  } catch (error) {
    markAttention(root, initialRun.id, {
      action: error && error.code === 'handoff-too-large' ? 'shorten-handoff' : 'check-route',
      reason: String(error && error.message ? error.message : error),
      route,
    }, opts);
    return;
  }
  if (!prepared) return;

  const eventMeta = {
    loopId: prepared.run.loopId,
    runId: prepared.run.id,
    segmentId: prepared.step.segmentId,
    stepId: prepared.step.id,
    segment: prepared.step.segment,
    cycle: prepared.step.cycle,
    slot: prepared.step.slot,
    role: prepared.step.role,
  };
  const card = makeCard({
    id: prepared.step.cardId,
    seat: route.seat,
    method: status.method,
    from: `loop:${prepared.step.role}`,
    body: prepared.body,
    cwd: prepared.run.project,
    stripAddress: false,
  });
  let outcome;
  try {
    outcome = await dependencies.turn(root, {
      card,
      route: {
        provider: route.provider,
        project: prepared.run.project,
        surface: route.surface,
        type: route.type,
      },
      variant: route.variant,
      method: status.method,
      methodExplicit: true,
      cwd: prepared.run.project,
      sessionId: prepared.binding.sessionId || undefined,
      sessionFile: prepared.binding.sessionFile || undefined,
      kind: prepared.binding.kind || undefined,
      attachNeedle: route.projectBound === false ? false : undefined,
      fileWins: route.projectBound === false ? false : true,
      home: dependencies.home,
      eventMeta,
      writeNext: false,
      suppressAppLaunch: true,
    });
  } catch (error) {
    outcome = { code: 2, error, text: String(error && error.message ? error.message : error), card };
  }

  withStateLock(root, () => {
    const document = readLoopRuns(root);
    const run = document.active;
    if (!run || run.id !== prepared.run.id || !sameStep(run, prepared.step)) return;
    const activeSlot = currentSlot(run);
    const reply = outcome && outcome.card && outcome.card.reply != null ? String(outcome.card.reply) : '';
    if (!outcome || outcome.code !== 0 || !reply.trim()) {
      if (run.stopRequested) {
        abandonCurrentStep(root, run, 'Loop stopped after the submitted turn finished');
        run.state = 'stopped';
        run.reason = null;
        run.attention = null;
        run.stopRequested = false;
        run.pauseRequested = false;
        appendLog(root, { event: 'loop-stopped', loopId: run.loopId, runId: run.id });
        saveRun(root, document, run, opts);
        return;
      }
      run.state = 'needs-attention';
      run.reason = String(
        (outcome && outcome.error) ||
        (outcome && outcome.sent && (outcome.sent.reason || outcome.sent.stderr)) ||
        (outcome && outcome.text) ||
        'The provider reply could not be confirmed',
      ).trim();
      run.attention = {
        action: outcome && outcome.gated ? 'check-message' : 'check-reply',
        reason: run.reason,
        route,
        cardId: prepared.step.cardId,
      };
      run.currentStep = { ...run.currentStep, phase: 'uncertain', finishedAt: nowIso(opts) };
      appendLog(root, {
        event: 'loop-needs-attention',
        ...eventMeta,
        reason: run.reason,
        action: run.attention.action,
        cardId: prepared.step.cardId,
      });
      saveRun(root, document, run, opts);
      return;
    }
    run.lastOutput = reply;
    run.lastRoute = route;
    run.confirmedSurfaceStep = null;
    run.lastStepId = prepared.step.id;
    run.pendingCorrection = '';
    run.currentStep = null;
    appendLog(root, {
      event: 'loop-turn-completed',
      ...eventMeta,
      cardId: prepared.step.cardId,
      actor: 'route',
      route,
      reply,
      method: (outcome.card && outcome.card.method) || status.method,
      sessionId: prepared.binding.sessionId || null,
      sessionFile: prepared.binding.sessionFile || null,
      kind: prepared.binding.kind || null,
    });
    const completed = advanceCursor(run, opts);
    if (completed) {
      const segment = currentSegment(run);
      appendLog(root, {
        event: 'loop-segment-completed',
        loopId: run.loopId,
        runId: run.id,
        segmentId: segment.id,
        segment: segment.number,
        finalRole: activeSlot.role,
      });
      appendLog(root, { event: 'loop-completed', loopId: run.loopId, runId: run.id, segmentId: segment.id });
    } else if (run.stopRequested) {
      run.state = 'stopped';
      run.reason = null;
      appendLog(root, { event: 'loop-stopped', loopId: run.loopId, runId: run.id });
    } else if (run.pauseRequested) {
      run.state = 'paused';
      run.pauseRequested = false;
      run.reason = null;
      appendLog(root, { event: 'loop-paused', loopId: run.loopId, runId: run.id });
    } else {
      const next = currentSlot(run);
      run.state = next.participant.kind === 'human' ? 'needs-input' : 'running';
      run.reason = null;
    }
    saveRun(root, document, run, opts);
  });
}

async function pump(root, opts) {
  for (;;) {
    const run = readLoopRuns(root).active;
    if (!run || run.state !== 'running' || run.pauseRequested || run.stopRequested) return;
    const slot = currentSlot(run);
    if (!slot) {
      markAttention(root, run.id, { action: 'check-loop', reason: 'The next Loop role is missing' }, opts);
      return;
    }
    if (slot.participant.kind === 'human') {
      withStateLock(root, () => {
        const document = readLoopRuns(root);
        if (!document.active || document.active.id !== run.id || document.active.state !== 'running') return;
        document.active.state = 'needs-input';
        document.active.reason = null;
        saveRun(root, document, document.active, opts);
      });
      return;
    }
    await executeCurrentTurn(root, run, opts);
    const after = readLoopRuns(root).active;
    if (!after || after.id !== run.id || after.state !== 'running') return;
  }
}

function schedulePump(root, opts) {
  const key = path.resolve(root);
  if (RUNNER_PROMISES.has(key)) return RUNNER_PROMISES.get(key);
  const promise = Promise.resolve()
    .then(() => pump(root, opts))
    .finally(() => RUNNER_PROMISES.delete(key));
  RUNNER_PROMISES.set(key, promise);
  return promise;
}

function validateRunRevision(run, payload) {
  if (payload.revision == null || Number(payload.revision) !== Number(run.revision || 0)) {
    throw new LoopError('Loop changed before this action was applied', 409, 'stale-run', {
      run: runSummary(run),
    });
  }
}

function actionName(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function loopRunAction(root, runId, payload, opts) {
  const source = payload || {};
  const requestId = requireRequest(source);
  const hash = requestHash({ ...source, requestId: undefined, runId });
  let shouldPump = false;
  const response = withStateLock(root, () => {
    const document = readLoopRuns(root);
    const prior = receiptFor(document, requestId, hash);
    if (prior) return prior;
    const run = document.active;
    if (!run || run.id !== runId) throw new LoopError('Loop run was not found', 404, 'run-not-found');
    validateRunRevision(run, source);
    const action = actionName(source.action);
    const slot = currentSlot(run);
    const segment = currentSegment(run);

    if (action === 'pause') {
      if (TERMINAL_STATES.has(run.state)) throw new LoopError('This Loop is not running', 409, 'run-not-active');
      if (run.currentStep && run.state === 'waiting') {
        const delivered = readLog(root).some(
          (event) =>
            event.runId === run.id &&
            event.stepId === run.currentStep.id &&
            event.event === 'deliver' &&
            cardIdOf(event) === run.currentStep.cardId,
        );
        if (delivered) {
          run.pauseRequested = true;
          appendLog(root, { event: 'loop-pause-requested', loopId: run.loopId, runId: run.id, stepId: run.currentStep.id });
        } else {
          run.currentStep = null;
          run.state = 'paused';
          run.pauseRequested = false;
          run.reason = null;
          appendLog(root, { event: 'loop-paused', loopId: run.loopId, runId: run.id });
        }
      } else {
        run.state = 'paused';
        run.pauseRequested = false;
        run.reason = null;
        appendLog(root, { event: 'loop-paused', loopId: run.loopId, runId: run.id });
      }
    } else if (action === 'resume' || action === 'continue') {
      if (!['paused', 'needs-attention'].includes(run.state)) {
        throw new LoopError('This Loop is not paused', 409, 'run-not-paused');
      }
      if (run.currentStep && run.currentStep.phase === 'uncertain') {
        throw new LoopError('Confirm the submitted message before resuming', 409, 'delivery-uncertain');
      }
      if (run.attention && run.attention.action === 'switch-surface') {
        run.confirmedSurfaceStep = cursorIdentity(run);
      }
      run.state = slot.participant.kind === 'human' ? 'needs-input' : 'running';
      run.reason = null;
      run.attention = null;
      run.pauseRequested = false;
      appendLog(root, { event: 'loop-resumed', loopId: run.loopId, runId: run.id });
      shouldPump = run.state === 'running';
    } else if (action === 'stop') {
      if (TERMINAL_STATES.has(run.state)) throw new LoopError('This Loop has already ended', 409, 'run-ended');
      if (run.currentStep && run.state === 'waiting') {
        const delivered = readLog(root).some(
          (event) =>
            event.runId === run.id &&
            event.stepId === run.currentStep.id &&
            event.event === 'deliver' &&
            cardIdOf(event) === run.currentStep.cardId,
        );
        if (delivered) {
          run.stopRequested = true;
          appendLog(root, { event: 'loop-stop-requested', loopId: run.loopId, runId: run.id, stepId: run.currentStep.id });
        } else {
          abandonCurrentStep(root, run, 'Loop stopped before provider submission');
          run.state = 'stopped';
          run.stopRequested = false;
          run.pauseRequested = false;
          run.reason = null;
          run.attention = null;
          appendLog(root, { event: 'loop-stopped', loopId: run.loopId, runId: run.id });
        }
      } else {
        abandonCurrentStep(root, run, 'Loop stopped before another turn');
        run.state = 'stopped';
        run.stopRequested = false;
        run.pauseRequested = false;
        run.reason = null;
        run.attention = null;
        appendLog(root, { event: 'loop-stopped', loopId: run.loopId, runId: run.id });
      }
    } else if (action === 'human-turn') {
      if (run.state !== 'needs-input' || !slot || slot.participant.kind !== 'human') {
        throw new LoopError('It is not your turn', 409, 'not-human-turn');
      }
      const content = requiredText(source.body, 'Reply');
      const completed = appendHumanTurn(root, run, content, null, opts);
      if (!completed) {
        run.state = currentSlot(run).participant.kind === 'human' ? 'needs-input' : 'running';
        shouldPump = run.state === 'running';
      }
    } else if (action === 'reply-as-me') {
      if (run.state !== 'paused' || !slot || slot.participant.kind !== 'route') {
        throw new LoopError('Pause before replying for this role', 409, 'takeover-not-available');
      }
      const content = requiredText(source.body, 'Reply');
      const completed = appendHumanTurn(root, run, content, slot.role, opts);
      if (!completed) {
        run.state = currentSlot(run).participant.kind === 'human' ? 'needs-input' : 'running';
        shouldPump = run.state === 'running';
      }
    } else if (action === 'add-correction') {
      if (run.state !== 'paused' || !slot || slot.participant.kind !== 'route') {
        throw new LoopError('Pause before adding a correction', 409, 'correction-not-available');
      }
      run.pendingCorrection = requiredText(source.body, 'Correction');
      appendLog(root, {
        event: 'loop-correction',
        loopId: run.loopId,
        runId: run.id,
        segmentId: segment.id,
        segment: segment.number,
        cycle: run.cursor.cycle,
        slot: run.cursor.slot,
        role: slot.role,
        content: run.pendingCorrection,
      });
      run.state = 'running';
      shouldPump = true;
    } else if (action === 'continue-segment') {
      if (run.state !== 'complete') throw new LoopError('This segment is not complete', 409, 'segment-not-complete');
      const cycles = cycleCount(source.cycles);
      const guidance = optionalText(source.guidance, 'Guidance');
      const previous = run.lastOutput;
      const segmentValue = newSegment(run, cycles, guidance, opts);
      run.completedAt = null;
      run.currentStep = null;
      run.pendingCorrection = '';
      run.pauseRequested = false;
      run.stopRequested = false;
      run.lastOutput = guidance ? `${previous}\n\n${guidance}` : previous;
      appendLog(root, {
        event: 'loop-continued',
        loopId: run.loopId,
        runId: run.id,
        segmentId: segmentValue.id,
        segment: segmentValue.number,
        cycles,
        guidance,
      });
      appendLog(root, {
        event: 'loop-segment-started',
        loopId: run.loopId,
        runId: run.id,
        segmentId: segmentValue.id,
        segment: segmentValue.number,
        cycles,
      });
      run.state = run.definition.leader.kind === 'human' ? 'needs-input' : 'running';
      shouldPump = run.state === 'running';
    } else if (action === 'confirm-session') {
      if (run.state !== 'needs-attention' || !run.attention || run.attention.action !== 'confirm-session') {
        throw new LoopError('There is no changed session to confirm', 409, 'confirmation-not-needed');
      }
      const route = run.attention.route;
      run.bindings[routeKey(route)] = run.attention.current;
      run.currentStep = null;
      run.state = 'running';
      run.reason = null;
      run.attention = null;
      appendLog(root, { event: 'loop-session-confirmed', loopId: run.loopId, runId: run.id, route });
      shouldPump = true;
    } else if (action === 'accept-gate') {
      if (run.state !== 'needs-attention' || !run.attention || run.attention.action !== 'accept-gate') {
        throw new LoopError('There is no gate to accept', 409, 'gate-not-needed');
      }
      require('./control').writePrefs(root, { axAccepted: true, accessibility: true });
      run.currentStep = null;
      run.state = 'running';
      run.reason = null;
      run.attention = null;
      appendLog(root, { event: 'loop-gate-accepted', loopId: run.loopId, runId: run.id });
      shouldPump = true;
    } else if (action === 'edit-gate') {
      if (run.state !== 'needs-attention' || !run.attention || run.attention.action !== 'accept-gate') {
        throw new LoopError('There is no gate to edit', 409, 'gate-not-needed');
      }
      run.currentStep = null;
      run.state = 'paused';
      run.reason = null;
      run.attention = null;
      appendLog(root, { event: 'loop-gate-edited', loopId: run.loopId, runId: run.id });
    } else {
      throw new LoopError('unknown Loop run action', 400, 'unknown-run-action');
    }
    saveRun(root, document, run, opts);
    const result = { ok: true, run: runSummary(run) };
    addReceipt(document, requestId, hash, result);
    writeLoopRuns(root, document);
    return result;
  });
  if (shouldPump) schedulePump(root, opts);
  return response;
}

function cardIdOf(event) {
  return event.cardId || event.id || (event.card && event.card.id) || null;
}

function runMessages(root, runId) {
  const cacheKey = `${path.resolve(root)}\0${runId}`;
  const revision = logRevision(root);
  const cached = LOOP_HISTORY_CACHE.get(cacheKey);
  if (cached && cached.revision === revision) return cached.messages;
  const messages = [];
  const aiByStep = new Map();
  for (const event of readLog(root)) {
    if (event.runId !== runId) continue;
    if (event.event === 'loop-goal') {
      messages.push({
        id: `goal:${event.segmentId}`,
        kind: 'goal',
        role: 'leader',
        actor: event.actor || 'goal',
        content: event.content || '',
        t: event.t || null,
        segment: event.segment || 1,
        cycle: 1,
        state: 'complete',
      });
    } else if (event.event === 'loop-human-turn') {
      messages.push({
        id: event.stepId,
        kind: 'response',
        role: event.role,
        actor: 'human',
        replacedRole: event.replacedRole || null,
        content: event.content || '',
        t: event.t || null,
        segment: event.segment,
        cycle: event.cycle,
        state: 'complete',
      });
    } else if (event.event === 'deliver' && event.stepId) {
      const message = {
        id: event.stepId,
        cardId: cardIdOf(event),
        kind: 'response',
        role: event.role,
        actor: 'route',
        route: event.route || null,
        content: '',
        sent: event.card && event.card.body,
        t: event.t || null,
        segment: event.segment,
        cycle: event.cycle,
        state: 'waiting',
        details: { method: event.card && event.card.method, turn: event.turn || null },
      };
      aiByStep.set(event.stepId, message);
      messages.push(message);
    } else if (event.event === 'loop-turn-completed' && event.stepId) {
      let message = aiByStep.get(event.stepId);
      if (!message) {
        message = {
          id: event.stepId,
          cardId: cardIdOf(event),
          kind: 'response',
          role: event.role,
          actor: 'route',
          route: event.route || null,
          content: '',
          sent: null,
          t: event.t || null,
          segment: event.segment,
          cycle: event.cycle,
          state: 'waiting',
          details: {},
        };
        aiByStep.set(event.stepId, message);
        messages.push(message);
      }
      if (message) {
        message.content = event.reply || '';
        message.state = 'complete';
        message.completedAt = event.t || null;
        message.details = {
          ...message.details,
          method: event.method || message.details.method || null,
          sessionId: event.sessionId || null,
          sessionFile: event.sessionFile || null,
          kind: event.kind || null,
        };
      }
    } else if (event.event === 'loop-turn-stopped' && event.stepId) {
      const message = aiByStep.get(event.stepId);
      if (message) {
        message.state = 'stopped';
        message.completedAt = event.t || null;
      }
    } else if (event.event === 'loop-correction') {
      messages.push({
        id: `correction:${event.t}:${event.slot}`,
        kind: 'correction',
        role: event.role,
        actor: 'human',
        content: event.content || '',
        t: event.t || null,
        segment: event.segment,
        cycle: event.cycle,
        state: 'complete',
      });
    } else if (event.event === 'loop-continued' && event.guidance) {
      messages.push({
        id: `guidance:${event.segmentId}`,
        kind: 'guidance',
        role: 'leader',
        actor: 'human',
        content: event.guidance,
        t: event.t || null,
        segment: event.segment,
        cycle: 1,
        state: 'complete',
      });
    }
  }
  LOOP_HISTORY_CACHE.set(cacheKey, { revision, messages });
  if (LOOP_HISTORY_CACHE.size > 64) {
    const oldest = LOOP_HISTORY_CACHE.keys().next().value;
    LOOP_HISTORY_CACHE.delete(oldest);
  }
  return messages;
}

function historyCursor(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function projectRunSummaries(root) {
  const byId = new Map();
  const order = [];
  for (const event of readLog(root)) {
    if (event.event === 'loop-run-started' && event.runId) {
      const project = canonicalProject(
        (event.definition && event.definition.project) || event.project,
      );
      if (!project) continue;
      const summary = {
        id: event.runId,
        loopId: event.loopId,
        name: event.runName || (event.definition && event.definition.name) || null,
        runName: event.runName || null,
        project,
        state: 'waiting',
        progress: {
          segment: event.segment || 1,
          cycle: 1,
          cycles: event.cycles || 1,
          step: 0,
          steps: (event.cycles || 1) * Math.max(1, event.definition ? definitionRoleOrder(event.definition).length : 1),
        },
        startedAt: event.t || null,
        completedAt: null,
      };
      byId.set(event.runId, summary);
      order.push(event.runId);
      continue;
    }
    if (!event.runId || !byId.has(event.runId)) continue;
    const summary = byId.get(event.runId);
    if (event.event === 'loop-completed') {
      summary.state = 'complete';
      summary.completedAt = event.t || null;
    } else if (event.event === 'loop-stopped') {
      summary.state = 'stopped';
      summary.completedAt = event.t || null;
    } else if (event.event === 'loop-paused' || event.event === 'loop-checkpointed') {
      summary.state = event.state === 'needs-attention' ? 'needs-attention' : 'paused';
    } else if (event.event === 'loop-needs-attention') {
      summary.state = 'needs-attention';
    } else if (event.event === 'loop-resumed' || event.event === 'loop-turn-started') {
      summary.state = 'waiting';
    }
  }
  const active = readLoopRuns(root).active;
  if (active && byId.has(active.id)) {
    const summary = byId.get(active.id);
    Object.assign(summary, runSummary(active), { startedAt: summary.startedAt });
  }
  const grouped = new Map();
  for (const id of order) {
    const summary = byId.get(id);
    if (!summary) continue;
    const values = grouped.get(summary.project) || [];
    values.push(summary);
    grouped.set(summary.project, values);
  }
  return grouped;
}

function projectLoopHistory(root, project, query) {
  const selectedProject = canonicalProject(project);
  if (!selectedProject) throw new LoopError('Project is required', 400, 'missing-project');
  const runs = projectRunSummaries(root).get(selectedProject) || [];
  const items = [];
  for (const run of runs) {
    items.push({
      id: `run:${run.id}`,
      kind: 'run',
      runId: run.id,
      runName: run.runName || null,
      name: run.name || null,
      project: selectedProject,
      state: run.state,
      progress: run.progress || null,
      startedAt: run.startedAt || null,
      completedAt: run.completedAt || null,
    });
    for (const message of runMessages(root, run.id)) {
      items.push({ ...message, runId: run.id, runName: run.runName || null });
    }
  }
  const offset = historyCursor(query && query.cursor);
  const limit = Math.min(MAX_HISTORY_PAGE, Math.max(1, Number(query && query.limit) || 50));
  const page = items.slice(offset, offset + limit);
  return {
    project: selectedProject,
    items: page,
    nextCursor: offset + page.length < items.length ? String(offset + page.length) : null,
  };
}

function getLoopRun(root, runId, query) {
  const document = readLoopRuns(root);
  let run = document.active && document.active.id === runId ? document.active : null;
  if (!run) {
    const started = readLog(root).find((event) => event.event === 'loop-run-started' && event.runId === runId);
    if (!started) throw new LoopError('Loop run was not found', 404, 'run-not-found');
    run = {
      id: runId,
      loopId: started.loopId,
      name: started.runName || (started.definition && started.definition.name),
      runName: started.runName || null,
      project: started.definition && started.definition.project,
      definition: started.definition,
      state: 'complete',
      revision: 0,
      updatedAt: started.t,
      createdAt: started.t,
      segments: [{ id: started.segmentId, number: started.segment || 1, cycles: started.cycles || 1 }],
      cursor: { segment: started.segment || 1, cycle: started.cycles || 1, slot: Math.max(0, definitionRoleOrder(started.definition).length - 1) },
    };
  }
  const messages = runMessages(root, runId);
  const offset = historyCursor(query && query.cursor);
  const limit = Math.min(MAX_HISTORY_PAGE, Math.max(1, Number(query && query.limit) || 50));
  const page = messages.slice(offset, offset + limit);
  return {
    run: { ...runSummary(run), definition: run.definition, goal: run.goal || null },
    messages: page,
    nextCursor: offset + page.length < messages.length ? String(offset + page.length) : null,
  };
}

function loopsSnapshot(root, project) {
  return listLoops(root, project);
}

function clearStoppedRunCards(root) {
  const events = readLog(root);
  const stoppedRuns = new Set(
    events.filter((event) => event.event === 'loop-stopped' && event.runId).map((event) => event.runId),
  );
  if (!stoppedRuns.size) return;
  const deliveries = new Map();
  for (const event of events) {
    const cardId = cardIdOf(event);
    if (event.event === 'deliver' && cardId && stoppedRuns.has(event.runId)) {
      deliveries.set(cardId, event);
    }
  }
  for (const card of liveCards(root)) {
    const delivery = deliveries.get(card.id);
    if (!delivery) continue;
    removeInflight(root, card.id);
    appendLog(root, {
      event: 'loop-turn-stopped',
      loopId: delivery.loopId,
      runId: delivery.runId,
      segmentId: delivery.segmentId,
      stepId: delivery.stepId,
      cardId: card.id,
      segment: delivery.segment,
      cycle: delivery.cycle,
      slot: delivery.slot,
      role: delivery.role,
      route: delivery.route,
      reason: 'Recovered an explicitly stopped Loop',
    });
  }
}

function reconcileActiveRun(root, opts) {
  return withStateLock(root, () => {
    migrateWorkspaceProfiles(root);
    clearStoppedRunCards(root);
    const document = readLoopRuns(root);
    const run = document.active;
    if (!run || TERMINAL_STATES.has(run.state)) return run ? runSummary(run) : null;
    const step = run.currentStep;
    if (step) {
      const events = readLog(root).filter((event) => event.runId === run.id && event.stepId === step.id);
      const completed = events.find((event) => event.event === 'loop-turn-completed');
      const delivered = events.find((event) => event.event === 'send' && cardIdOf(event) === step.cardId);
      const staged = events.find((event) => event.event === 'stage' && cardIdOf(event) === step.cardId);
      if (completed || staged) {
        const reply = (completed && completed.reply) || (staged && staged.card && staged.card.reply) || '';
        if (reply) {
          if (!completed) {
            appendLog(root, {
              event: 'loop-turn-completed',
              loopId: run.loopId,
              runId: run.id,
              segmentId: step.segmentId,
              stepId: step.id,
              cardId: step.cardId,
              segment: step.segment,
              cycle: step.cycle,
              slot: step.slot,
              role: step.role,
              actor: 'route',
              route: step.route,
              reply: String(reply),
              method: staged && staged.card && staged.card.method,
              sessionId: step.binding && step.binding.sessionId,
              sessionFile: step.binding && step.binding.sessionFile,
              kind: step.binding && step.binding.kind,
              recovered: true,
            });
          }
          run.lastOutput = String(reply);
          run.currentStep = null;
          run.pendingCorrection = '';
          advanceCursor(run, opts);
          if (run.state !== 'complete') run.state = 'paused';
          run.reason = null;
          run.attention = null;
          appendLog(root, { event: 'loop-recovered-completed', loopId: run.loopId, runId: run.id, stepId: step.id });
        }
      } else if (delivered) {
        run.state = 'needs-attention';
        run.reason = 'A submitted message has no confirmed reply';
        run.attention = { action: 'check-reply', reason: run.reason, cardId: step.cardId, route: step.route };
      } else {
        removeInflight(root, step.cardId);
        run.currentStep = null;
        run.state = 'paused';
        run.reason = null;
        run.attention = null;
        appendLog(root, { event: 'loop-recovered-unsent', loopId: run.loopId, runId: run.id, stepId: step.id });
      }
    } else {
      run.state = run.state === 'needs-attention' ? 'needs-attention' : 'paused';
    }
    run.pauseRequested = false;
    run.stopRequested = false;
    saveRun(root, document, run, opts);
    return runSummary(run);
  });
}

function pauseActiveRunForShutdown(root, opts) {
  return withStateLock(root, () => {
    const document = readLoopRuns(root);
    const run = document.active;
    if (!run || TERMINAL_STATES.has(run.state)) return run ? runSummary(run) : null;
    if (run.currentStep && run.state === 'waiting') {
      run.state = 'needs-attention';
      run.reason = 'Convobus quit while a provider message was in progress';
      run.attention = {
        action: 'check-reply',
        reason: run.reason,
        cardId: run.currentStep.cardId,
        route: run.currentStep.route,
      };
    } else {
      run.state = 'paused';
      run.reason = null;
      run.attention = null;
    }
    run.pauseRequested = false;
    run.stopRequested = false;
    appendLog(root, { event: 'loop-checkpointed', loopId: run.loopId, runId: run.id, state: run.state });
    saveRun(root, document, run, opts);
    return runSummary(run);
  });
}

module.exports = {
  LOOP_SCHEMA_VERSION,
  MIN_CYCLES,
  MAX_CYCLES,
  MAX_TEXT_BYTES,
  MAX_HANDOFF_BYTES,
  MAX_HISTORY_PAGE,
  LoopError,
  routeKey,
  definitionRoleOrder,
  formatHandoff,
  readLoopDefinitions,
  readLoopRuns,
  listLoops,
  migrateWorkspaceProfiles,
  mutateLoop,
  startLoopRun,
  loopRunAction,
  getLoopRun,
  projectLoopHistory,
  loopsSnapshot,
  runSummary,
  schedulePump,
  reconcileActiveRun,
  pauseActiveRunForShutdown,
};
