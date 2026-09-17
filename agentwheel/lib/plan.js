'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { scratchRoot } = require('./paths');
const { assertScoped, confinedNodeArgs } = require('./broker');

const KINDS = ['decision', 'action', 'assumption', 'expected_result', 'loop'];
const BASES = ['first_principles', 'trusted_method', 'executable_test', 'inspection', 'math', 'physics'];
const HIGH_RISK_RE = /\b(network|internet|https?:|credential|password|secret|token|delete|remove|erase|publish|deploy|release to|sudo|root access|irreversible|payment|purchase)\b/i;

function node(id, title, kind, extra) {
  return {
    id,
    title,
    kind,
    needs: [],
    after: [],
    serves: [],
    claim_refs: [],
    decomposes_into: [],
    required: true,
    risk: 'normal',
    trial: { status: 'untried', evidence: [], not_applicable: {} },
    ...(extra || {}),
  };
}

function riskOf(text) {
  return HIGH_RISK_RE.test(String(text)) ? 'high' : 'normal';
}

function generateStructure(idea, experience, design, spec) {
  const acc = experience.acceptance.map((a) =>
    node(`L1.1.${a.id}`, `${a.id}: ${a.criterion}`, 'expected_result', {
      serves: ['L1.1'], claim_refs: [a.id, 'solution'], risk: riskOf(a.criterion),
    })
  );
  const reqs = spec.requirements.map((r) =>
    node(`L1.2.${r.id}`, `${r.id}: ${r.requirement}`, 'action', {
      serves: ['L1.2'], claim_refs: [r.id], risk: riskOf(r.requirement),
    })
  );
  const cons = spec.constraints.map((c) =>
    node(`L1.3.${c.id}`, `${c.id}: ${c.constraint}`, 'assumption', {
      serves: ['L1.3'], claim_refs: [c.id], risk: riskOf(c.constraint),
    })
  );
  const d = design || { screens: [], visual: [], states: [], interactions: [], content: [], acceptance: [] };
  const screens = d.screens.map((s) => {
    const text = `${s.id}: ${s.name} - ${s.contents.join('; ')}`;
    const refs = [
      s.id,
      ...d.states.filter((x) => x.screen === s.id).map((x) => x.id),
      ...d.interactions.filter((x) => x.screen === s.id).map((x) => x.id),
    ];
    return node(`L1.6.${s.id}`, text, 'expected_result', { serves: ['L1.6'], claim_refs: refs, risk: riskOf(text) });
  });
  const visual = d.visual.length
    ? [node('L1.7', 'Layout and visual system: ' + d.visual.map((v) => `${v.id} ${v.rule}`).join('; '), 'expected_result', {
      serves: ['L1'], claim_refs: d.visual.map((v) => v.id),
    })]
    : [];
  const content = d.content.length
    ? [node('L1.8', 'Content rules: ' + d.content.map((n) => `${n.id} ${n.rule}`).join('; '), 'expected_result', {
      serves: ['L1'], claim_refs: d.content.map((n) => n.id),
    })]
    : [];
  const dacc = d.acceptance.map((x) =>
    node(`L1.9.${x.id}`, `${x.id}: ${x.criterion}`, 'expected_result', {
      serves: ['L1.9'], claim_refs: [x.id], risk: riskOf(x.criterion),
    })
  );
  const before = ['L1.1', 'L1.2', 'L1.3', ...(screens.length ? ['L1.6'] : []), ...(visual.length ? ['L1.7'] : []), ...(content.length ? ['L1.8'] : []), ...(dacc.length ? ['L1.9'] : [])];
  const decision = node('L1.4', 'Choose the build method that satisfies the solution: compare alternatives', 'decision', {
    serves: ['L1'], claim_refs: ['solution'],
    after: before,
  });
  const release = [
    node('L1.5.1', `Artifact type "${spec.release.artifact_type}" is buildable`, 'action', {
      needs: ['L1.4'], serves: ['L1.5'], claim_refs: ['release'],
    }),
    node('L1.5.2', `Product link kind "${spec.release.link_kind}" resolves`, 'expected_result', {
      needs: ['L1.5.1'], serves: ['L1.5'], claim_refs: ['release'],
    }),
  ];
  const root = node('L1', 'Deliver the accepted solution as a released artifact', 'expected_result', {
    claim_refs: ['problem', 'solution'],
    decomposes_into: [
      node('L1.1', 'Satisfy every acceptance criterion', 'expected_result', { serves: ['L1'], claim_refs: ['solution'], decomposes_into: acc }),
      node('L1.2', 'Meet every requirement', 'action', { serves: ['L1'], decomposes_into: reqs }),
      node('L1.3', 'Honor every constraint', 'assumption', { serves: ['L1'], decomposes_into: cons }),
      ...(screens.length ? [node('L1.6', 'Realize every screen with its states and interactions', 'expected_result', { serves: ['L1'], decomposes_into: screens })] : []),
      ...visual,
      ...content,
      ...(dacc.length ? [node('L1.9', 'Satisfy every design acceptance criterion', 'expected_result', { serves: ['L1'], decomposes_into: dacc })] : []),
      decision,
      node('L1.5', 'Release mechanics', 'action', { serves: ['L1'], claim_refs: ['release'], after: ['L1.4'], decomposes_into: release }),
    ],
  });
  return root;
}

function walk(root, fn, parent) {
  fn(root, parent || null);
  for (const child of root.decomposes_into) walk(child, fn, root);
}

function collectLeaves(root) {
  const leaves = [];
  walk(root, (n) => { if (n.decomposes_into.length === 0) leaves.push(n); });
  return leaves;
}

function nodesById(root) {
  const map = new Map();
  walk(root, (n) => { map.set(n.id, n); });
  return map;
}

function dependencyEdges(root) {
  const byId = nodesById(root);
  const edges = [];
  walk(root, (n, parent) => {
    for (const dep of [...n.needs, ...n.after]) {
      if (!byId.has(dep)) throw new Error(`plan node ${n.id} depends on unknown node ${dep}`);
      edges.push([n.id, dep]);
    }
    if (parent) edges.push([parent.id, n.id]);
  });
  return edges;
}

function assertDag(root) {
  const byId = nodesById(root);
  const edges = dependencyEdges(root);
  const out = new Map([...byId.keys()].map((id) => [id, []]));
  for (const [from, to] of edges) out.get(from).push(to);
  const state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'active') throw new Error('plan graph has a cycle through ' + [...stack, id].join(' -> '));
    state.set(id, 'active');
    for (const next of out.get(id)) visit(next, [...stack, id]);
    state.set(id, 'done');
  };
  for (const id of byId.keys()) visit(id, []);
  return true;
}

function topologicalStages(root) {
  assertDag(root);
  const byId = nodesById(root);
  const leaves = collectLeaves(root);
  const leafIds = new Set(leaves.map((l) => l.id));
  const leavesUnder = (id) => collectLeaves(byId.get(id)).map((l) => l.id);
  const prereqs = new Map();
  for (const leaf of leaves) {
    const set = new Set();
    let cur = leaf;
    const chain = [];
    walk(root, (n, parent) => { if (n.id === leaf.id) { let p = parent; while (p) { chain.push(p); p = findParent(root, p.id); } } });
    for (const n of [cur, ...chain]) {
      for (const dep of [...n.needs, ...n.after]) for (const lid of leavesUnder(dep)) if (lid !== leaf.id) set.add(lid);
    }
    prereqs.set(leaf.id, set);
  }
  const stageOf = new Map();
  const resolveStage = (id, stack) => {
    if (stageOf.has(id)) return stageOf.get(id);
    if (stack.includes(id)) throw new Error('plan graph has a cycle through ' + [...stack, id].join(' -> '));
    let stage = 0;
    for (const dep of prereqs.get(id)) stage = Math.max(stage, resolveStage(dep, [...stack, id]) + 1);
    stageOf.set(id, stage);
    return stage;
  };
  for (const id of leafIds) resolveStage(id, []);
  const stages = [];
  for (const [id, s] of stageOf) {
    stages[s] = stages[s] || [];
    stages[s].push(id);
  }
  return stages.map((s) => s.sort());
}

function findParent(root, id) {
  let found = null;
  walk(root, (n, parent) => { if (n.id === id) found = parent; });
  return found;
}

function isSettled(trial) {
  return trial.status === 'passed';
}

function rollupOk(root) {
  const settled = (n) => {
    if (n.decomposes_into.length === 0) return !n.required || isSettled(n.trial);
    const childrenOk = n.decomposes_into.every(settled);
    if (!childrenOk) return false;
    return !n.required || isSettled(n.trial);
  };
  return settled(root);
}

function summarize(root) {
  const leaves = collectLeaves(root);
  const count = (status) => leaves.filter((l) => l.trial.status === status).length;
  return {
    leaves: leaves.length,
    passed: count('passed'),
    untried: count('untried'),
    gaps: count('gap'),
    conflicts: count('conflict'),
    high_risk: leaves.filter((l) => l.risk === 'high').map((l) => l.id),
  };
}

function entryFile(files, entry) {
  let e = String(entry == null ? '' : entry).trim().replace(/^["']|["']$/g, '');
  if (/^node(\.exe)?\s+/i.test(e)) e = e.replace(/^node(\.exe)?\s+/i, '').trim().replace(/^["']|["']$/g, '');
  const names = Object.keys(files || {});
  if (names.includes(e)) return e;
  const bare = e.split(/\s+/)[0];
  if (names.includes(bare)) return bare;
  if (!e && names.length === 1) return names[0];
  return e;
}

function runScript(dir, files, entry, timeoutMs) {
  assertScoped('system', 'fs_write', dir, scratchRoot);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files || {})) {
    const target = path.join(dir, name);
    assertScoped('system', 'fs_write', target, scratchRoot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  assertScoped('system', 'exec', dir, scratchRoot);
  const file = entryFile(files, entry);
  if (!fs.existsSync(path.join(dir, file))) {
    return { code: -1, output: `entry "${entry}" names no file in the kit (files: ${Object.keys(files || {}).join(', ') || 'none'})` };
  }
  const res = spawnSync(process.execPath, [...confinedNodeArgs(dir), file], {
    cwd: dir,
    timeout: timeoutMs || 30000,
    encoding: 'utf8',
  });
  const out = ((res.stdout || '') + (res.stderr || '')).slice(-2000);
  return { code: res.status == null ? -1 : res.status, output: out };
}

function evidenceEntry(basis, executor, ok, detail) {
  return { basis, executor, ok, detail: String(detail || '').slice(0, 1200) };
}

const EXECUTION_REQUIRED = new Set(['action', 'expected_result', 'loop']);

function tryLeaf(leaf, entry, scratchDir) {
  const evidence = [];
  const notApplicable = {};
  const bases = entry.bases || {};
  let derivations = 0;
  let executableOk = null;
  for (const basis of BASES) {
    const b = bases[basis];
    if (!b || b.applicable === false) {
      notApplicable[basis] = String((b && b.reason) || 'no reason recorded');
      continue;
    }
    if (basis === 'executable_test') {
      const r = runScript(path.join(scratchDir, 'leaf-' + leaf.id.replace(/\./g, '_')), b.exec.files, b.exec.entry);
      executableOk = r.code === 0;
      evidence.push(evidenceEntry(basis, 'engine', executableOk, `exit=${r.code}; ${r.output}`));
    } else {
      derivations += 1;
      const text = String(b.derivation || b.observation || '');
      evidence.push(evidenceEntry(basis, 'model', true, 'recorded, not proven: ' + text));
    }
  }
  const methods = new Set(evidence.map((e) => e.basis));
  if (executableOk === false) methods.delete('executable_test');
  let status;
  let reason = '';
  if (EXECUTION_REQUIRED.has(leaf.kind) && executableOk === null) {
    status = 'gap';
    reason = `${leaf.kind} leaf requires an engine-executed test; the kit marked executable_test not applicable`;
  } else if (executableOk === false) {
    status = 'gap';
    reason = 'engine-executed test failed';
  } else if (executableOk === null && derivations === 0) {
    status = 'gap';
    reason = 'no applicable basis recorded';
  } else if (leaf.risk === 'high' && methods.size < 2) {
    status = 'gap';
    reason = 'high-risk leaf needs two independent evidence methods';
  } else {
    status = 'passed';
  }
  return { status, evidence, not_applicable: notApplicable, reason };
}

function tryDecision(leaf, entry, scratchDir) {
  const alternatives = (entry.alternatives || []).map((alt) => {
    let feasible = false;
    let detail = 'no build supplied: no engine evidence';
    if (alt.build) {
      const r = runScript(path.join(scratchDir, 'alt-' + alt.id), alt.build.files, alt.build.entry);
      feasible = r.code === 0;
      detail = `exit=${r.code}; ${r.output.slice(-600)}`.trim();
    }
    return {
      id: alt.id, name: alt.name, summary: alt.summary, feasible,
      evidence: [evidenceEntry('executable_test', 'engine', feasible, detail)],
    };
  });
  const feasible = alternatives.filter((a) => a.feasible);
  const engineEvidence = alternatives.filter((a) => a.evidence.some((e) => e.executor === 'engine' && e.detail && !e.detail.startsWith('no build')));
  const chosen = alternatives.find((a) => a.id === entry.chosen) || null;
  let status = 'passed';
  let reason = '';
  let basis = feasible.length >= 2 ? 'compared_two' : 'only_one_feasible';
  if (alternatives.length === 0) {
    status = 'gap'; reason = 'a decision leaf must compare alternatives';
  } else if (alternatives.length < 2 && engineEvidence.length === 0) {
    status = 'gap'; reason = 'one alternative and no engine evidence: nothing was compared or proven';
  } else if (feasible.length === 0) {
    status = 'gap'; reason = 'no alternative is feasible';
  } else if (feasible.length === 1 && alternatives.length < 2) {
    status = 'gap'; reason = 'a single alternative is not a comparison; a second must be tried or proven infeasible by the engine';
  } else if (!chosen) {
    status = 'gap'; reason = 'no alternative was chosen';
  } else if (!chosen.feasible) {
    status = 'conflict'; reason = `chosen alternative ${chosen.id} is infeasible by engine evidence`;
  }
  const evidence = alternatives.flatMap((a) => a.evidence.map((e) => ({ ...e, detail: `${a.id}: ${e.detail}` })));
  return {
    status, evidence, not_applicable: {}, reason,
    alternatives, chosen: status === 'passed' && chosen ? chosen.id : null, rationale: String(entry.rationale || ''),
    basis_of_decision: status === 'passed' ? basis : null,
  };
}

function applyTrialKit(structureRoot, kit, opts) {
  const scratch = (opts && opts.scratchDir) || path.join(scratchRoot, 'trial-' + Date.now());
  const root = structuredClone(structureRoot);
  const byId = nodesById(root);
  const stages = topologicalStages(root);

  for (const stage of stages) {
    for (const id of stage) {
      const leaf = byId.get(id);
      const entry = (kit.leaves || {})[id];
      if (!entry) continue;
      const tried = leaf.kind === 'decision' ? tryDecision(leaf, entry, scratch) : tryLeaf(leaf, entry, scratch);
      leaf.trial = {
        status: tried.status,
        evidence: tried.evidence,
        not_applicable: tried.not_applicable,
        ...(tried.reason ? { reason: tried.reason } : {}),
        ...(leaf.kind === 'decision' ? {
          alternatives: tried.alternatives, chosen: tried.chosen, rationale: tried.rationale,
          basis_of_decision: tried.basis_of_decision,
        } : {}),
      };
    }
  }

  // Roll upward, post-order: a composite settles only after all required children do.
  const rollup = (n) => {
    if (n.decomposes_into.length === 0) return !n.required || isSettled(n.trial);
    const childrenOk = n.decomposes_into.map(rollup).every(Boolean);
    n.trial = childrenOk
      ? { status: 'passed', evidence: [evidenceEntry('first_principles', 'engine', true, 'every required descendant settled; evidence rolled up')], not_applicable: {} }
      : { status: 'untried', evidence: [], not_applicable: {}, reason: 'a required descendant is untried, gap, conflict, or missing evidence' };
    return childrenOk;
  };
  rollup(root);

  const decisionLeaf = collectLeaves(root).find((l) => l.kind === 'decision') || null;
  const decision = decisionLeaf ? {
    leaf: decisionLeaf.id,
    chosen: decisionLeaf.trial.chosen || null,
    rationale: decisionLeaf.trial.rationale || '',
    basis: decisionLeaf.trial.basis_of_decision || null,
  } : null;

  return { root, trial_stages: stages, decision, summary: summarize(root) };
}

function leafState(leaf, overlay) {
  const o = overlay ? overlay[leaf.id] : null;
  if (o && o.executing) return 'executing';
  if (o && o.state) return o.state;
  return leaf.trial.status;
}

function engineOwned(leaf) {
  return leaf.decomposes_into.length === 0 && (leaf.claim_refs || []).length === 1 && leaf.claim_refs[0] === 'release';
}

function executable(leaf, overlay) {
  if (leaf.trial.status !== 'passed' || !leaf.required || engineOwned(leaf)) return false;
  const s = leafState(leaf, overlay);
  return s === 'passed' || s === 'gap';
}

function nextExecutionGroup(content, overlay) {
  if (!content || !content.root) return [];
  const byId = nodesById(content.root);
  for (const stage of content.trial_stages || []) {
    const leaves = stage.map((id) => byId.get(id)).filter(Boolean);
    const group = leaves.filter((l) => executable(l, overlay)).map((l) => l.id);
    if (group.length) return group;
    if (leaves.some((l) => l.required && !engineOwned(l) && leafState(l, overlay) !== 'done')) return [];
  }
  return [];
}

function allRequiredDone(content, overlay) {
  if (!content || !content.root) return false;
  return collectLeaves(content.root).every((l) => !l.required || engineOwned(l) || leafState(l, overlay) === 'done');
}

function executionSummary(content, overlay) {
  const leaves = content && content.root ? collectLeaves(content.root) : [];
  const states = leaves.map((l) => leafState(l, overlay));
  const count = (s) => states.filter((x) => x === s).length;
  return {
    leaves: leaves.length,
    done: count('done'),
    executing: count('executing'),
    gaps: count('gap'),
    remaining: leaves.filter((l) => l.required && !engineOwned(l) && leafState(l, overlay) !== 'done').length,
    next_group: nextExecutionGroup(content, overlay),
  };
}

function planClosed(planContent) {
  if (!planContent || !planContent.root) return { ok: false, reason: 'no accepted plan' };
  const s = summarize(planContent.root);
  if (s.untried) return { ok: false, reason: `${s.untried} required leaf/leaves untried` };
  if (s.gaps) return { ok: false, reason: `${s.gaps} gap(s)` };
  if (s.conflicts) return { ok: false, reason: `${s.conflicts} conflict(s)` };
  if (!rollupOk(planContent.root)) return { ok: false, reason: 'a parent has not closed' };
  if (!planContent.decision || !planContent.decision.chosen) return { ok: false, reason: 'no decision chosen' };
  return { ok: true, reason: 'plan closed' };
}

module.exports = {
  entryFile,
  EXECUTION_REQUIRED, engineOwned,
  KINDS,
  BASES,
  generateStructure,
  applyTrialKit,
  collectLeaves,
  nodesById,
  topologicalStages,
  assertDag,
  rollupOk,
  isSettled,
  summarize,
  planClosed,
  leafState,
  executable,
  nextExecutionGroup,
  allRequiredDone,
  executionSummary,
  walk,
};
