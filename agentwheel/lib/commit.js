'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const paths = require('./paths');
const { NODE_SCHEMAS, LEGACY_SPEC, KINDS, validate } = require('./schema');
const { assertScoped } = require('./broker');
const { GATES } = require('./gates');
const { rollupOk, planClosed, collectLeaves, allRequiredDone } = require('./plan');
const { audit, currentAccepted } = require('./store');
const { SCHEMA_VERSION, AUTHORS, SCALE } = require('./reducers');
const { nowIso, sha256 } = require('./ids');
const { frame } = require('./events');
const { pidAlive } = require('./lease');

class CommitError extends Error {}
class LockBusyError extends CommitError {}

const STATUSES = ['green', 'yellow', 'red', 'purple'];
const VERSION_STATES = ['staged', 'accepted', 'stale', 'rejected', 'shelved'];

const testHooks = { crashAt: null, seq: null, onApplying: null };

function crashIf(point, seq) {
  if (testHooks.crashAt === point && (testHooks.seq == null || testHooks.seq === seq)) {
    process.kill(process.pid, 'SIGKILL');
  }
}

function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // directory fsync is best effort
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function readLock(pp) {
  try { return JSON.parse(fs.readFileSync(pp.lockPath, 'utf8')); } catch { return null; }
}

function inspectLock(pp) {
  if (!fs.existsSync(pp.lockPath)) return { present: false };
  const holder = readLock(pp);
  const alive = Boolean(holder && pidAlive(holder.pid));
  return { present: true, holder, alive, ours: Boolean(holder && holder.pid === process.pid) };
}

function acquireLock(turn, pp) {
  fs.mkdirSync(pp.dir, { recursive: true });
  const body = JSON.stringify({ pid: process.pid, turn, ts: nowIso() });
  try {
    fs.writeFileSync(pp.lockPath, body, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const holder = readLock(pp);
    if (holder && pidAlive(holder.pid) && holder.pid !== process.pid) {
      throw new LockBusyError('storage lock held by live pid ' + holder.pid);
    }
    throw new LockBusyError(
      'storage lock present (crash residue); it is never cleared by code, only by the human RECOVERY_REQUIRED gate action'
    );
  }
  return body;
}

// Releases only the lock this commit wrote (compared by content).
function releaseLock(body, pp) {
  try {
    if (fs.readFileSync(pp.lockPath, 'utf8') === body) fs.unlinkSync(pp.lockPath);
  } catch {
  }
}

function clearLockByHumanGate(meta, pp) {
  if (!meta || meta.gate !== 'RECOVERY_REQUIRED' || !GATES.RECOVERY_REQUIRED.actions.includes(meta.action)) {
    throw new CommitError('a stale lock is cleared only by a RECOVERY_REQUIRED gate action');
  }
  const lock = inspectLock(pp);
  if (!lock.present) return false;
  fs.unlinkSync(pp.lockPath);
  audit({
    phase: 'RECOVERY', event: 'stale_lock_cleared_by_human', action: meta.action, turn: meta.turn,
    holder: lock.holder, holder_alive: lock.alive,
  }, pp);
  return true;
}

function validateShape(state) {
  if (!state || typeof state !== 'object') throw new CommitError('state not an object');
  if (state.schema_version !== SCHEMA_VERSION) throw new CommitError('bad schema_version: ' + state.schema_version);
  if (!Number.isInteger(state.seq) || state.seq < 1) throw new CommitError('bad seq');
  if (!state.project || !state.project.id) throw new CommitError('missing project');
  if (!STATUSES.includes(state.status)) throw new CommitError('bad status: ' + state.status);
  if (!state.nodes) throw new CommitError('missing nodes');
  for (const kind of KINDS) {
    const node = state.nodes[kind];
    if (!node) throw new CommitError('missing node: ' + kind);
    for (const v of node.versions) {
      if (!VERSION_STATES.includes(v.state)) {
        throw new CommitError(`bad version state ${kind} v${v.v}: ${v.state}`);
      }
      if (!AUTHORS.includes(v.authored_by)) {
        throw new CommitError(`version ${kind} v${v.v} lacks authored_by (human | seat | system)`);
      }
      const res = validate(kind === 'spec' && ('route_allowlist' in v.content || 'budget' in v.content) ? LEGACY_SPEC : NODE_SCHEMAS[kind], v.content);
      if (!res.ok) {
        throw new CommitError(
          `schema: ${kind} v${v.v}: ` + res.errors.slice(0, 4).join('; ')
        );
      }
    }
  }
  if (!state.budget || !SCALE.includes(state.budget.authority)) {
    throw new CommitError('bad budget');
  }
}

function validateVersions(prev, next) {
  if (!prev) return;
  if (next.project.id !== prev.project.id) throw new CommitError('project identity changed');
  for (const kind of KINDS) {
    const before = (prev.nodes[kind] || { versions: [] }).versions;
    const after = (next.nodes[kind] || { versions: [] }).versions;
    if (after.length < before.length) {
      throw new CommitError(`versions removed on ${kind}`);
    }
    before.forEach((bv, i) => {
      const av = after[i];
      if (!av || av.v !== bv.v) {
        throw new CommitError(`version renumbered on ${kind} at index ${i}`);
      }
      // Accepted content remains immutable even after its version becomes stale.
      if (!isDeepStrictEqual(av.content, bv.content)) {
        if (bv.state === 'accepted' || bv.state === 'stale' || bv.state === 'rejected') {
          throw new CommitError(`immutable content changed on ${kind} v${bv.v}`);
        }
      }
      if (bv.state === 'accepted' && !['accepted', 'stale'].includes(av.state)) {
        throw new CommitError(`illegal transition on ${kind} v${bv.v}: accepted->${av.state}`);
      }
    });
    after.forEach((v, i) => {
      if (v.v !== i + 1) throw new CommitError(`non-monotonic version number on ${kind}`);
      if (kind === 'spec' && next.controls_version && (!before[i] || !isDeepStrictEqual(before[i].content, v.content))) {
        const result = validate(NODE_SCHEMAS.spec, v.content);
        if (!result.ok) throw new CommitError('invalid product Spec: ' + result.errors.join('; '));
      }
    });
  }
}

function validateEvidence(next, outcome, pp) {
  if (outcome.accepts_execution) {
    const ex = next.executions[outcome.accepts_execution];
    if (!ex || ex.state !== 'accepted') throw new CommitError('accepts an execution not marked accepted: ' + outcome.accepts_execution);
    if (!ex.accepted_by_turn || ex.accepted_by_turn === ex.staged_by_turn) {
      throw new CommitError(`self-acceptance forbidden: execution ${ex.branch} staged and accepted by ${ex.staged_by_turn}`);
    }
    const t = ex.tests;
    if (t.exit_code !== 0 || t.failed !== 0 || t.passed < 1) {
      throw new CommitError(`execution evidence insufficient: exit=${t.exit_code} passed=${t.passed} failed=${t.failed}`);
    }
    const review = next.reviews.find((r) => r.subject && r.subject.kind === 'execution' && r.subject.branch === ex.branch && r.decision === 'accept');
    if (!review) throw new CommitError('execution acceptance without a review record: ' + ex.branch);
    if (!outcome.merge || outcome.merge.branch !== ex.branch) throw new CommitError('execution acceptance carries no merge');
    if (path.resolve(outcome.merge.to) !== path.resolve(pp.mainDir)) throw new CommitError('merge target is not main');
    for (const id of ex.leaves) {
      const o = next.leaves[id];
      if (!o || o.state !== 'done') throw new CommitError(`accepted execution leaf ${id} is not done`);
    }
  }
  if (outcome.accepts_closure) {
    if (!next.closure || next.closure.state !== 'accepted' || !next.closure.all_ok) throw new CommitError('closure acceptance without an accepted, all-ok closure');
    if (next.gate) throw new CommitError('closure accepted with an open gate');
    const plan = currentAccepted(next.nodes.plan);
    if (!plan || !allRequiredDone(plan.content, next.leaves || {})) throw new CommitError('closure accepted with leaves not done');
    for (const k of KINDS) {
      const n = next.nodes[k];
      if (n.stale || n.reopened) throw new CommitError(`closure accepted with stale/reopened node: ${k}`);
      if (!currentAccepted(n)) throw new CommitError(`closure accepted with unaccepted node: ${k}`);
    }
  }
  if (!outcome.accepts) return;
  const { kind } = outcome.accepts;
  const node = next.nodes[kind];
  const version = node.versions.find((v) => v.v === outcome.accepts.v);
  if (!version) throw new CommitError(`accepts unknown version ${kind} v${outcome.accepts.v}`);
  if (version.state !== 'accepted') {
    throw new CommitError(`accepts a version not marked accepted: ${kind} v${version.v}`);
  }
  if (!version.accepted_by_turn || version.accepted_by_turn === version.staged_by_turn) {
    throw new CommitError(
      `self-acceptance forbidden: ${kind} v${version.v} staged and accepted by ${version.staged_by_turn}`
    );
  }
  const content = version.content;
  if (kind === 'plan') {
    if (!rollupOk(content.root)) {
      throw new CommitError('plan has untried/gap/conflict descendants; cannot accept');
    }
    const closed = planClosed(content);
    if (!closed.ok) throw new CommitError('plan not closed: ' + closed.reason);
    const leaf = collectLeaves(content.root).find((l) => l.id === content.decision.leaf);
    if (!leaf || !leaf.trial.alternatives) throw new CommitError('decision leaf has no compared alternatives');
    const feasible = leaf.trial.alternatives.filter((a) => a.feasible).length;
    if (content.decision.basis === 'compared_two' && feasible < 2) {
      throw new CommitError('decision claims compared_two but fewer than 2 feasible alternatives');
    }
    if (content.decision.basis === 'only_one_feasible' && feasible !== 1) {
      throw new CommitError('decision claims only_one_feasible but feasible count is ' + feasible);
    }
    const chosen = leaf.trial.alternatives.find((a) => a.id === content.decision.chosen);
    if (!chosen || !chosen.feasible) throw new CommitError('chosen alternative not feasible');
  }
  if (kind === 'design') {
    const meta = outcome.gate_meta;
    if (!meta || meta.id !== 'DESIGN_READY' || meta.action !== 'APPROVE') {
      throw new CommitError('design acceptance requires DESIGN_READY APPROVE');
    }
  }
}

function performMerge(merge, pp) {
  assertScoped('system-commit', 'fs_write', merge.to, pp.dir);
  fs.mkdirSync(merge.to, { recursive: true });
  for (const name of merge.files) {
    const from = path.join(merge.from, name);
    const to = path.join(merge.to, name);
    assertScoped('system-commit', 'fs_write', to, merge.to);
    if (!fs.existsSync(from)) throw new CommitError('merge source missing: ' + from);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const tmp = to + '.tmp.' + process.pid;
    fs.copyFileSync(from, tmp);
    fs.renameSync(tmp, to);
  }
}

// Artifact promotion is a canonical write too, so it happens here and only here, under the same lock.
function performPromotion(promote, artifactMeta) {
  const buf = fs.readFileSync(promote.from);
  const digest = sha256(buf);
  if (digest !== promote.sha256) {
    throw new CommitError(
      `promotion sha mismatch: workspace ${digest.slice(0, 12)} != evidence ${promote.sha256.slice(0, 12)}`
    );
  }
  if (!artifactMeta || artifactMeta.path !== promote.to) {
    throw new CommitError('state.artifact does not describe the promotion target');
  }
  const outDir = path.dirname(promote.to);
  fs.mkdirSync(outDir, { recursive: true });
  assertScoped('system-commit', 'fs_write', promote.to, outDir);
  const tmp = promote.to + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, promote.to);
}

function appendEvent(event, pp) {
  const { line } = frame(event);
  fs.mkdirSync(pp.dir, { recursive: true });
  const fd = fs.openSync(pp.eventsPath, 'a');
  try {
    if (testHooks.crashAt === 'mid_append' && (testHooks.seq == null || testHooks.seq === event.seq)) {
      fs.writeSync(fd, line.slice(0, Math.floor(line.length / 2)));
      fs.fsyncSync(fd);
      process.kill(process.pid, 'SIGKILL');
    }
    fs.writeSync(fd, line + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDir(pp.dir);
  return line;
}

function snapshotBytes(seq, state) {
  return JSON.stringify({ seq, state });
}

function writeSnapshot(seq, state, pp) {
  const tmp = path.join(pp.dir, `.snapshot.${process.pid}.${seq}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, snapshotBytes(seq, state));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, pp.snapshotPath);
  fsyncDir(pp.dir);
}

function writeProjectsIndex(project) {
  fs.mkdirSync(paths.storeDir, { recursive: true });
  let projects = [];
  try {
    const obj = JSON.parse(fs.readFileSync(paths.projectsIndexPath, 'utf8'));
    if (obj && Array.isArray(obj.projects)) projects = obj.projects;
  } catch {   }
  const row = { id: project.id, name: project.name, created: project.created };
  const i = projects.findIndex((p) => p.id === row.id);
  if (i >= 0) {
    if (JSON.stringify(projects[i]) === JSON.stringify(row)) return false;
    projects[i] = row;
  } else {
    projects.push(row);
  }
  const tmp = paths.projectsIndexPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects }, null, 1) + '\n');
  fs.renameSync(tmp, paths.projectsIndexPath);
  fsyncDir(paths.storeDir);
  return true;
}

// A project archived beside itself (an earlier schema) leaves the rail: the same atomic write.
function removeFromProjectsIndex(id) {
  let projects = [];
  try {
    const obj = JSON.parse(fs.readFileSync(paths.projectsIndexPath, 'utf8'));
    if (obj && Array.isArray(obj.projects)) projects = obj.projects;
  } catch { return false; }
  const next = projects.filter((p) => p.id !== id);
  if (next.length === projects.length) return false;
  const tmp = paths.projectsIndexPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects: next }, null, 1) + '\n');
  fs.renameSync(tmp, paths.projectsIndexPath);
  fsyncDir(paths.storeDir);
  return true;
}

function commitEvent(prev, event, outcome, meta, pp) {
  if (!meta || meta.seat !== 'system-commit') {
    throw new CommitError('only the commit handler seat writes canonical state');
  }
  if (!pp || !pp.dir) throw new CommitError('a commit needs the project paths');
  assertScoped('system-commit', 'fs_write', pp.snapshotPath, pp.dir);
  assertScoped('system-commit', 'fs_write', pp.eventsPath, pp.dir);
  const next = outcome.state;
  const prevSeq = prev ? prev.seq : 0;
  if (event.seq !== prevSeq + 1) throw new CommitError(`event seq ${event.seq} is not next after ${prevSeq}`);
  if (next.seq !== event.seq) throw new CommitError('reduced state seq does not match the event');
  if (next.project && next.project.id !== pp.id) throw new CommitError(`state names project ${next.project.id}, the store ${pp.id}`);
  validateShape(next);
  validateVersions(prev, next);
  validateEvidence(next, outcome, pp);

  const lock = acquireLock(event.turn, pp);
  try {
    if (testHooks.onApplying) testHooks.onApplying(event.seq);
    if (outcome.merge) performMerge(outcome.merge, pp);
    if (outcome.promote) performPromotion(outcome.promote, next.artifact);
    crashIf('before_append', event.seq);
    appendEvent(event, pp);
    crashIf('after_append', event.seq);
    writeSnapshot(event.seq, next, pp);
    crashIf('after_snapshot', event.seq);
    if (!prev || prev.project.name !== next.project.name) writeProjectsIndex(next.project);
  } finally {
    releaseLock(lock, pp);
  }
  audit({
    phase: 'APPLYING',
    event: 'commit',
    turn: event.turn,
    seq: event.seq,
    event_id: event.id,
    accepts: outcome.accepts || null,
    gate: outcome.gate_meta || null,
    reason: outcome.reason || event.type,
  }, pp);
  return next;
}

// Only human recovery may truncate a torn journal; preserve corruption beyond the tail.
function repairTornTail(torn, meta, pp) {
  if (!meta || meta.gate !== 'RECOVERY_REQUIRED' || !GATES.RECOVERY_REQUIRED.actions.includes(meta.action)) {
    throw new CommitError('a torn journal tail is repaired only by a RECOVERY_REQUIRED gate action');
  }
  if (!torn || typeof torn.offset !== 'number') return false;
  const lock = acquireLock('journal-repair', pp);
  try {
    if (torn.trailing > 0) {
      const keep = pp.eventsPath.replace(/\.jsonl$/, '') + '.corrupt-' + nowIso().replace(/[:.]/g, '-') + '.jsonl';
      fs.copyFileSync(pp.eventsPath, keep);
      audit({ phase: 'RECOVERY', event: 'corrupt_journal_kept', copy: keep, torn }, pp);
    }
    fs.truncateSync(pp.eventsPath, torn.offset);
    fsyncDir(pp.dir);
  } finally {
    releaseLock(lock, pp);
  }
  audit({ phase: 'RECOVERY', event: 'torn_tail_removed', action: meta.action, turn: meta.turn, torn }, pp);
  return true;
}

function repairSnapshot(seq, state, pp) {
  const lock = acquireLock('snapshot-repair', pp);
  try {
    writeSnapshot(seq, state, pp);
  } finally {
    releaseLock(lock, pp);
  }
  audit({ phase: 'STORE', event: 'snapshot_repaired', seq }, pp);
}

module.exports = {
  commitEvent,
  repairSnapshot,
  repairTornTail,
  snapshotBytes,
  CommitError,
  LockBusyError,
  inspectLock,
  clearLockByHumanGate,
  acquireLock,
  releaseLock,
  validateShape,
  writeProjectsIndex,
  removeFromProjectsIndex,
  testHooks,
};
