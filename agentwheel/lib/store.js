'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { nowIso } = require('./ids');
const { parseEvents } = require('./events');
const { replay, SCHEMA_VERSION } = require('./reducers');
const nodes = require('./nodes');

function ensureDirs(pp) {
  fs.mkdirSync(paths.storeDir, { recursive: true });
  fs.mkdirSync(paths.projectsDir, { recursive: true });
  if (pp) {
    fs.mkdirSync(pp.dir, { recursive: true });
    fs.mkdirSync(pp.branchesDir, { recursive: true });
  }
}

function readEvents(pp) {
  if (!fs.existsSync(pp.eventsPath)) return { events: [], torn: null };
  return parseEvents(fs.readFileSync(pp.eventsPath, 'utf8'));
}

function loadSnapshot(pp) {
  try {
    const obj = JSON.parse(fs.readFileSync(pp.snapshotPath, 'utf8'));
    if (!obj || typeof obj.seq !== 'number' || !('state' in obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

function loadDetailed(pp) {
  const { events, torn } = readEvents(pp);
  const state = events.length ? replay(events) : null;
  const snapshot = loadSnapshot(pp);
  let snapshotFresh;
  if (!snapshot) snapshotFresh = events.length === 0;
  else snapshotFresh = snapshot.seq === events.length && JSON.stringify(snapshot.state) === JSON.stringify(state);
  return { state, seq: events.length, events, torn, snapshot, snapshot_fresh: snapshotFresh };
}

function load(pp) {
  return loadDetailed(pp).state;
}

function audit(event, pp) {
  const file = pp ? pp.auditPath : paths.auditPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { ts: nowIso(), ...event };
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

function auditTail(limit, pp) {
  const file = pp ? pp.auditPath : paths.auditPath;
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-(limit || 50)).map((l) => {
    try { return JSON.parse(l); } catch { return { bad_line: l }; }
  });
}

function journalSchemaVersion(eventsPath) {
  const first = fs.readFileSync(eventsPath, 'utf8').split('\n').find((l) => l.trim());
  if (!first) return null;
  let ev;
  try { ev = JSON.parse(first); } catch { return null; }
  if (!ev || typeof ev !== 'object' || !ev.facts) return null;
  return Number.isInteger(ev.facts.schema_version) ? ev.facts.schema_version : 2;
}

function stamp() {
  return nowIso().replace(/[:.]/g, '-');
}

function archiveLegacyStoreIfPresent() {
  let label = null;
  let declared = null;
  if (fs.existsSync(paths.legacyStatePath) && !fs.existsSync(paths.eventsPath)) {
    label = '1x';
  } else if (fs.existsSync(paths.eventsPath)) {
    declared = journalSchemaVersion(paths.eventsPath);
    if (declared !== null) label = declared === 2 ? '2.0.0' : declared === 3 ? '2.0.x' : `schema${declared}`;
  }
  if (!label) return null;
  const archive = `${paths.storeDir}-archive-${label}-${stamp()}`;
  fs.renameSync(paths.storeDir, archive);
  fs.mkdirSync(paths.storeDir, { recursive: true });
  audit({ phase: 'STORE', event: 'legacy_store_archived', from: paths.storeDir, to: archive, store: label, schema_version: declared === null ? 1 : declared });
  return archive;
}

function archiveLegacyProjectIfPresent(pp) {
  if (!fs.existsSync(pp.eventsPath)) return null;
  const declared = journalSchemaVersion(pp.eventsPath);
  if (declared === null || declared === SCHEMA_VERSION) return null;
  const archive = `${pp.dir}-archive-schema${declared}-${stamp()}`;
  fs.renameSync(pp.dir, archive);
  audit({ phase: 'STORE', event: 'legacy_project_archived', from: pp.dir, to: archive, schema_version: declared });
  return archive;
}

function readProjectsIndex() {
  try {
    const obj = JSON.parse(fs.readFileSync(paths.projectsIndexPath, 'utf8'));
    if (obj && Array.isArray(obj.projects)) return obj.projects;
  } catch {   }
  return null;
}

function listProjects() {
  const indexed = readProjectsIndex();
  if (indexed) return indexed;
  if (!fs.existsSync(paths.projectsDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(paths.projectsDir).sort()) {
    let pp;
    try { pp = paths.projectPaths(name); } catch { continue; }
    if (!fs.existsSync(pp.eventsPath)) continue;
    const snap = loadSnapshot(pp);
    const project = snap && snap.state && snap.state.project ? snap.state.project : null;
    out.push({ id: name, name: project ? project.name : name, created: project ? project.created : null });
  }
  return out;
}

module.exports = {
  ensureDirs,
  readEvents,
  loadSnapshot,
  loadDetailed,
  load,
  audit,
  auditTail,
  archiveLegacyStoreIfPresent,
  archiveLegacyProjectIfPresent,
  journalSchemaVersion,
  readProjectsIndex,
  listProjects,
  emptyNode: nodes.emptyNode,
  currentAccepted: nodes.currentAccepted,
  stagedVersion: nodes.stagedVersion,
};
