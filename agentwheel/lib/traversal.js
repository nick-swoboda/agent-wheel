'use strict';

const planlib = require('./plan');
const { claimIds, diffClaims } = require('./claims');
const { currentAccepted } = require('./nodes');

const SPINE = ['idea', 'experience', 'design', 'spec', 'plan'];

function spineIndex(kind) {
  const i = SPINE.indexOf(kind);
  if (i < 0) throw new Error('unknown kind: ' + kind);
  return i;
}

function reopenEffects(state, kind) {
  if (state.pending_redispatch) state.pending_redispatch = null;
  if (kind !== 'plan' && state.nodes.plan && state.nodes.plan.draft) state.nodes.plan.draft = null;
  staleWaivers(state, [kind]);
}

function failUp(state, responsibleKind, reason) {
  const idx = spineIndex(responsibleKind);
  const node = state.nodes[responsibleKind];
  node.reopened = true;
  node.open = true;
  for (const v of node.versions) {
    if (v.state === 'staged') v.state = 'rejected';
  }
  if (state.pending_validation && state.pending_validation.kind === responsibleKind) {
    state.pending_validation = null;
  }
  reopenEffects(state, responsibleKind);
  if (responsibleKind === 'plan') suspendExecution(state);
  state.last_failure = { kind: responsibleKind, reason: String(reason || ''), spine_index: idx };
  return { reopened: responsibleKind, dropped: [] };
}

function suspendExecution(state, staledBy) {
  for (const [id, o] of Object.entries(state.leaves || {})) {
    if (o.executing) delete o.executing;
    if (o.state === 'executing') delete state.leaves[id];
  }
  for (const ex of Object.values(state.executions || {})) {
    if (ex.state === 'staged') {
      ex.state = 'stale';
      ex.staled_by = staledBy || { kind: 'plan', v: planVersionOf(state), claims: [] };
    }
  }
  for (const b of Object.values(state.branches || {})) {
    if (b.state === 'returned') b.state = 'stale';
  }
  if (state.pending_validation && ['execution', 'closure'].includes(state.pending_validation.kind)) {
    state.pending_validation = null;
  }
  state.closure = null;
  state.closure_proof = null;
  state.plan_review = null;
  state.project_done = null;
}

function reachedBy(root, moving) {
  const byId = planlib.nodesById(root);
  const affected = new Set();
  planlib.walk(root, (n) => { if ((n.claim_refs || []).some((c) => moving.has(c))) affected.add(n.id); });
  const close = () => {
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of [...affected]) {
        planlib.walk(byId.get(id), (n) => { if (!affected.has(n.id)) { affected.add(n.id); grew = true; } });
      }
      planlib.walk(root, (n) => {
        if (affected.has(n.id)) return;
        const dependsOn = (dep) => {
          const target = byId.get(dep);
          if (!target) return false;
          let hit = false;
          planlib.walk(target, (t) => { if (affected.has(t.id)) hit = true; });
          return hit;
        };
        if ((n.needs || []).some(dependsOn)) { affected.add(n.id); grew = true; }
      });
    }
  };
  close();
  return affected;
}

function previewDropDown(state, kind, prevContent, nextContent) {
  const diff = prevContent
    ? diffClaims(kind, prevContent, nextContent)
    : { changed: [], removed: [], added: claimIds(kind, nextContent), unchanged: [] };
  const plan = currentAccepted(state.nodes.plan);
  const moving = new Set([...diff.changed, ...diff.removed]);
  const regenerates = Boolean(prevContent && plan && (moving.size || diff.added.length));
  let leaves = [];
  if (regenerates && moving.size) {
    const affected = reachedBy(plan.content.root, moving);
    leaves = planlib.collectLeaves(plan.content.root).filter((l) => affected.has(l.id)).map((l) => l.id);
  }
  return { kind, changed: diff.changed, removed: diff.removed, added: diff.added, unchanged: diff.unchanged, leaves, regenerates };
}

function dropDown(state, kind, prevContent, nextContent) {
  const diff = previewDropDown(state, kind, prevContent, nextContent);
  const result = { kind, changed: diff.changed, removed: diff.removed, added: diff.added, unchanged: diff.unchanged, leaves: [] };
  if (!diff.regenerates) {
    if (prevContent && state.closure_proof && state.closure_proof.targets && kind in state.closure_proof.targets) {
      state.closure_proof.targets[kind] = successorVersion(state, kind);
    }
    return result;
  }
  const plan = currentAccepted(state.nodes.plan);
  const moving = new Set([...diff.changed, ...diff.removed]);
  if (moving.size) {
    const going = new Set(diff.leaves);
    const leaves = planlib.collectLeaves(plan.content.root).filter((l) => going.has(l.id));
    for (const leaf of leaves) {
      const before = state.leaves[leaf.id] || null;
      state.leaves[leaf.id] = {
        state: 'untried',
        moved_by: { kind, claims: (leaf.claim_refs || []).filter((c) => moving.has(c)) },
        ...(before && before.execution ? { last_execution: before.execution } : {}),
      };
    }
    result.leaves = leaves.map((l) => l.id);
    for (const w of state.waivers || []) if (moving.has(w.claim)) w.stale = true;
    const movedIds = new Set(result.leaves);
    const claimsOfLeaf = new Map(leaves.map((l) => [l.id, (l.claim_refs || []).filter((c) => moving.has(c))]));
    for (const ex of Object.values(state.executions || {})) {
      if (!['staged', 'rejected', 'shelved', 'stale'].includes(ex.state)) continue;
      const hit = (ex.leaves || []).filter((id) => movedIds.has(id));
      if (!hit.length) continue;
      const claims = [...new Set(hit.flatMap((id) => claimsOfLeaf.get(id) || []))].sort();
      ex.staled_by = { kind, v: successorVersion(state, kind), claims };
    }
  }
  state.plan_dirty = { kind, changed: diff.changed, removed: diff.removed, added: diff.added, leaves: result.leaves };
  state.last_claim_change = { kind, changed: diff.changed, removed: diff.removed, added: diff.added, leaves: result.leaves };
  state.nodes.plan.draft = null;
  const pv = state.pending_validation;
  if (pv && pv.kind === 'plan') {
    const ver = state.nodes.plan.versions.find((x) => x.v === pv.v);
    if (ver && ver.state === 'staged') ver.state = 'rejected';
    state.pending_validation = null;
  }
  suspendExecution(state, { kind, v: successorVersion(state, kind), claims: [...diff.changed, ...diff.removed] });
  if (state.pending_redispatch) state.pending_redispatch = null;
  return result;
}

function planVersionOf(state) {
  const plan = state.nodes && state.nodes.plan && currentAccepted(state.nodes.plan);
  return plan ? plan.v : null;
}

function successorVersion(state, kind) {
  const cur = state.nodes && state.nodes[kind] && currentAccepted(state.nodes[kind]);
  return cur ? cur.v : null;
}

function staleWaivers(state, kinds) {
  for (const w of state.waivers || []) {
    if (w.target && kinds.includes(w.target.kind)) w.stale = true;
  }
}

module.exports = { SPINE, spineIndex, failUp, dropDown, previewDropDown, reachedBy, reopenEffects, staleWaivers, suspendExecution };
