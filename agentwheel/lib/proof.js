'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fileURLToPath } = require('url');
const paths = require('./paths');
const { sha256 } = require('./ids');
const { currentAccepted } = require('./nodes');
const { collectLeaves, planClosed, rollupOk, leafState, walk, engineOwned } = require('./plan');
const { claimsOf, claimKind } = require('./claims');
const { assertScoped, confinedNodeArgs } = require('./broker');
const { SPINE } = require('./traversal');

function step(from, to, check, ok, detail) {
  return { from, to, check, ok, detail: String(detail).slice(0, 2000) };
}

function waiverFor(state, claimId, target) {
  return (state.waivers || []).find((w) =>
    w.claim === claimId && !w.stale && w.target && w.target.kind === target.kind && w.target.v === target.v
  ) || null;
}

function passedNodesFor(root, claimId) {
  const out = [];
  if (!root) return out;
  walk(root, (n) => { if ((n.claim_refs || []).includes(claimId) && n.trial && n.trial.status === 'passed') out.push(n.id); });
  return out;
}

function planClosureProof(state, opts) {
  const planNode = state.nodes.plan;
  const pv = opts && opts.plan_v
    ? planNode.versions.find((x) => x.v === opts.plan_v) || null
    : currentAccepted(planNode);
  const plan = pv ? pv.content : null;
  const cur = (kind) => currentAccepted(state.nodes[kind]);
  const versions = { idea: cur('idea'), experience: cur('experience'), design: cur('design'), spec: cur('spec') };
  const target = { kind: 'plan', v: pv ? pv.v : null };
  const targets = { plan: target.v };
  for (const k of ['idea', 'experience', 'design', 'spec']) targets[k] = versions[k] ? versions[k].v : null;
  const claims = [];
  const record = (id, text, source, planRefs, ok, detail, earliestRepair) => {
    const c = {
      id, claim: text, source,
      plan_refs: planRefs,
      evidence: [{ executor: 'engine', ok: Boolean(ok), detail: String(detail).slice(0, 1000) }],
      status: ok ? 'pass' : 'gap', earliest_repair: ok ? null : earliestRepair, owner: 'engine', waiver: null,
    };
    if (!ok) {
      const w = waiverFor(state, id, target);
      if (w) { c.status = 'waiver'; c.waiver = { id: w.id, reason: w.reason, authorizer: w.authorizer, target: w.target }; }
    }
    claims.push(c);
    return c;
  };
  for (const kind of ['experience', 'design', 'spec', 'idea']) {
    const v = versions[kind];
    if (!v) {
      record(kind + ':missing', `an accepted ${kind} exists`, { kind, v: null }, [], false, `no accepted ${kind}`, kind);
      continue;
    }
    for (const claim of claimsOf(kind, v.content)) {
      const refs = plan ? passedNodesFor(plan.root, claim.id) : [];
      record(claim.id, claim.text, { kind, v: v.v }, refs, refs.length > 0,
        refs.length ? `passed: ${refs.join(', ')}` : !plan ? 'no accepted Plan' : `no passed leaf names ${claim.id} in claim_refs`,
        kind);
    }
  }
  {
    const closed = plan ? planClosed(plan) : { ok: false, reason: 'no accepted Plan' };
    const ok = Boolean(plan) && closed.ok && rollupOk(plan.root);
    const leaves = plan ? collectLeaves(plan.root) : [];
    record('plan:closed', 'Every required leaf passed, every parent closed, every decision leaf chose an alternative',
      target, plan ? ['L1'] : [], ok,
      ok ? `${leaves.length} leaves passed; decision ${plan.decision ? plan.decision.chosen : 'none'}` : closed.reason || 'roll-up fails',
      'plan');
  }
  {
    const dirty = SPINE.filter((k) => k !== 'plan' && (!cur(k) || state.nodes[k].stale || state.nodes[k].reopened));
    record('plan:ancestors_current', 'No ancestor of the Plan is missing, stale, or reopened', target, [],
      dirty.length === 0, dirty.length === 0 ? 'idea, experience, design, spec accepted and current' : 'not current: ' + dirty.join(', '),
      dirty[0] || 'plan');
  }
  const passing = (c) => c.status === 'pass' || c.status === 'waiver';
  const stepOf = (from, to, check, pick) => {
    const ids = claims.filter(pick);
    const bad = ids.filter((c) => !passing(c));
    const detail = bad.length
      ? bad.map((c) => `${c.id}: ${c.evidence[0].detail}`).join('; ')
      : `${ids.length} claim(s) pass${ids.some((c) => c.status === 'waiver') ? ' (some waived)' : ''}`;
    return step(from, to, check, bad.length === 0, detail);
  };
  const steps = [
    stepOf('plan', 'spec', 'every Spec requirement, constraint, and release rule has a passed leaf', (c) => c.source.kind === 'spec'),
    stepOf('plan', 'design', 'every Design claim has a passed leaf', (c) => c.source.kind === 'design'),
    stepOf('plan', 'experience', 'every Experience acceptance criterion has a passed leaf', (c) => c.source.kind === 'experience'),
    stepOf('plan', 'idea', 'Idea PROBLEM and SOLUTION are served by passed plan nodes', (c) => c.source.kind === 'idea'),
    stepOf('plan', 'closure', 'the trial closed and every ancestor is current', (c) => c.source.kind === 'plan'),
  ];
  const failing = claims.filter((c) => !passing(c));
  const first = failing.slice().sort((a, b) => SPINE.indexOf(a.earliest_repair) - SPINE.indexOf(b.earliest_repair))[0] || null;
  return {
    kind: 'plan_closure',
    targets,
    claims,
    steps,
    all_ok: failing.length === 0,
    responsible: first ? first.earliest_repair : null,
    first_failure: first ? { claim: first.id, status: first.status, earliest_repair: first.earliest_repair, detail: first.evidence[0].detail } : null,
    waivers: claims.filter((c) => c.status === 'waiver').map((c) => c.waiver.id),
    owner: 'engine',
  };
}

function scanNoNetwork(text) {
  const re = /(fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|src=["']https?:|href=["']https?:|import\s*\(\s*["']https?:)/;
  const m = text.match(re);
  return m ? 'network primitive found: ' + m[1] : null;
}

// Re-executes an accepted execution's test suite against a scratch copy of main (read-only toward main).
function rerunOnMain(mainDir, execution, stamp) {
  const rerunDir = path.join(paths.scratchRoot, `closure-${process.pid}-${stamp}-${execution.branch}`);
  assertScoped('system', 'fs_write', rerunDir, paths.scratchRoot);
  fs.mkdirSync(rerunDir, { recursive: true });
  fs.cpSync(mainDir, rerunDir, { recursive: true });
  assertScoped('system', 'exec', rerunDir, paths.scratchRoot);
  const args = String(execution.tests.command).split(' ').slice(1);
  const res = spawnSync(process.execPath, [...confinedNodeArgs(rerunDir), ...args], { cwd: rerunDir, timeout: 60000, encoding: 'utf8' });
  const full = (res.stdout || '') + (res.stderr || '');
  const out = full.slice(-400);
  const totals = /TESTS passed=(\d+) failed=(\d+)/.exec(full);
  return {
    ok: res.status === 0,
    detail: `${execution.branch} (${execution.leaves.join(', ')}): exit=${res.status}; ${out}`.trim(),
    record: {
      branch: execution.branch, leaves: execution.leaves, command: execution.tests.command, exit_code: res.status,
      passed: totals ? Number(totals[1]) : null, failed: totals ? Number(totals[2]) : null, output_tail: full.slice(-1500),
    },
  };
}

function finalClosure(state, opts) {
  const steps = [];
  const get = (kind) => { const v = currentAccepted(state.nodes[kind]); return v ? v.content : null; };
  const idea = get('idea');
  const experience = get('experience');
  const design = get('design');
  const spec = get('spec');
  const plan = get('plan');
  const main = state.main || null;
  const overlay = state.leaves || {};
  const leaves = plan ? collectLeaves(plan.root) : [];
  const accepted = Object.values(state.executions || {}).filter((e) => e.state === 'accepted');
  const stamp = (opts && opts.stamp) || Date.now();
  let rerunRecords = [];
  let responsible = null;
  const fail = (kind) => { if (!responsible) responsible = kind; };

  {
    let ok = Boolean(plan && main && state.artifact);
    let detail = ok ? '' : 'no plan, no main, or no promoted artifact';
    let failedExecutions = [];
    if (ok) {
      const mainFile = path.join(main.dir, main.main_file);
      if (!fs.existsSync(mainFile)) { ok = false; detail = 'main artifact missing at ' + mainFile; }
      else {
        const buf = fs.readFileSync(mainFile);
        const digest = sha256(buf);
        let linkOk = false;
        try {
          const resolved = fileURLToPath(state.artifact.product_link);
          linkOk = fs.existsSync(resolved) && sha256(fs.readFileSync(resolved)) === digest;
        } catch { linkOk = false; }
        if (digest !== main.sha256) { ok = false; detail = `main artifact sha ${digest.slice(0, 12)} != recorded ${String(main.sha256).slice(0, 12)}`; }
        else if (!linkOk) { ok = false; detail = 'product link does not resolve to the artifact on main'; }
        else {
          const reruns = accepted.map((e) => ({ e, r: rerunOnMain(main.dir, e, stamp) }));
          rerunRecords = reruns.map((x) => x.r.record);
          failedExecutions = reruns.filter((x) => !x.r.ok);
          ok = failedExecutions.length === 0 && accepted.length > 0;
          detail = ok
            ? `artifact ${buf.length}B sha=${digest.slice(0, 12)}; link resolves; ${reruns.length} execution suite(s) pass on main`
            : accepted.length === 0 ? 'no accepted execution' : failedExecutions.map((x) => x.r.detail).join(' | ');
        }
      }
    }
    if (!ok) fail('execution');
    steps.push({ ...step('artifact', 'plan', 'the artifact on main is built, hashed, linked, and every accepted execution suite passes on it', ok, detail),
      ...(failedExecutions.length ? { failed_branches: failedExecutions.map((x) => x.e.branch) } : {}) });
  }

  const releaseOk = steps[0].ok;
  const settled = (l) => !l.required || (engineOwned(l) ? releaseOk : leafState(l, overlay) === 'done');
  {
    const notDone = leaves.filter((l) => !settled(l)).map((l) => l.id);
    const orphan = leaves.filter((l) => !engineOwned(l) && leafState(l, overlay) === 'done').filter((l) => {
      const o = overlay[l.id];
      const ex = o && o.execution && state.executions[o.execution.branch];
      return !ex || ex.state !== 'accepted';
    }).map((l) => l.id);
    const ok = Boolean(plan) && notDone.length === 0 && orphan.length === 0;
    if (!ok) fail('plan');
    const engineLeaves = leaves.filter(engineOwned).length;
    steps.push(step('plan', 'spec', 'every required leaf is done through an execution the Reviewer accepted', ok,
      ok ? `${leaves.length - engineLeaves} leaves done through accepted executions; ${engineLeaves} release leaf(s) proven by this walk` : notDone.length ? 'not done: ' + notDone.join(', ') : 'done without an accepted execution: ' + orphan.join(', ')));
  }

  const doneNodes = [];
  if (plan) {
    walk(plan.root, (n) => {
      const under = collectLeaves(n);
      if (under.every(settled)) doneNodes.push(n);
    });
  }
  const doneRefs = new Set(doneNodes.flatMap((n) => n.claim_refs || []));
  const unserved = (kind, content) => claimsOf(kind, content).map((c) => c.id).filter((id) => !doneRefs.has(id));

  {
    let ok = Boolean(spec && main);
    let detail = ok ? '' : 'spec or main missing';
    if (ok) {
      const missing = unserved('spec', spec);
      const problems = [];
      const mainFile = path.join(main.dir, main.main_file);
      const text = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf8') : '';
      if (spec.release.artifact_type === 'single_file_html' && !/\.html?$/.test(main.main_file)) problems.push('artifact is not an .html file');
      if ((spec.security || []).some((s) => s.startsWith('no-network'))) {
        const hit = scanNoNetwork(text);
        if (hit) problems.push(hit);
      }
      ok = missing.length === 0 && problems.length === 0;
      detail = ok ? `every Spec claim served by a done leaf; security scans clean` : [...(missing.length ? ['no done leaf for: ' + missing.join(', ')] : []), ...problems].join('; ');
    }
    if (!ok) fail('spec');
    steps.push(step('spec', 'design', 'every Spec requirement and constraint is served by a done leaf and the artifact honors them', ok, detail));
  }

  {
    const missing = design ? unserved('design', design) : ['design'];
    const ok = Boolean(design) && missing.length === 0;
    if (!ok) fail('design');
    steps.push(step('design', 'experience', 'every Design claim is served by a done leaf', ok,
      ok ? `${claimsOf('design', design).length} design claims served` : !design ? 'no accepted Design' : 'no done leaf for: ' + missing.join(', ')));
  }

  {
    const missing = experience ? unserved('experience', experience) : ['experience'];
    const journeysOk = Boolean(experience) && experience.journeys.length >= 1 && experience.journeys.every((j) => j.steps.length >= 1);
    const ok = Boolean(experience) && missing.length === 0 && journeysOk;
    if (!ok) fail('experience');
    steps.push(step('experience', 'idea', 'every acceptance criterion is served by a done leaf and every journey has steps', ok,
      ok ? `${experience.acceptance.length} acceptance ids served; ${experience.journeys.length} journey(s)` : !experience ? 'no accepted Experience' : !journeysOk ? 'a journey has no steps' : 'no done leaf for: ' + missing.join(', ')));
  }

  {
    const known = new Set(['idea', 'experience', 'design', 'spec'].flatMap((k) => claimsOf(k, get(k)).map((c) => c.id)));
    const unmet = idea ? unserved('idea', idea) : ['problem', 'solution'];
    const unclaimed = [...doneRefs].filter((id) => !known.has(id) || claimKind(id) === null);
    const dirty = SPINE.filter((k) => !currentAccepted(state.nodes[k]) || state.nodes[k].stale || state.nodes[k].reopened);
    const ok = Boolean(idea) && unmet.length === 0 && unclaimed.length === 0 && dirty.length === 0 && !state.gate;
    if (!ok) fail('idea');
    steps.push(step('idea', 'closure', 'Idea PROBLEM + SOLUTION are met by claimed artifact work, every artifact claim traces to a criterion, and nothing is stale or gated', ok,
      ok ? 'solution criteria met; every artifact claim traces to a criterion; no stale, reopened, or gated node'
        : `unmet=[${unmet}] unclaimed=[${unclaimed}] dirty=[${dirty}] gate=${state.gate ? state.gate.id : 'none'}`));
  }

  const failedBranches = steps[0].failed_branches || [];
  return {
    steps: steps.map(({ failed_branches, ...s }) => s),
    all_ok: steps.every((s) => s.ok),
    responsible,
    failed_branches: failedBranches,
    artifact: main && state.artifact ? { path: state.artifact.path, sha256: main.sha256, bytes: main.bytes, product_link: state.artifact.product_link } : null,
    reruns: rerunRecords,
  };
}

module.exports = { planClosureProof, finalClosure, waiverFor, scanNoNetwork };
