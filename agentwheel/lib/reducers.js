'use strict';

const path = require('path');
const { KINDS, NODE_SCHEMAS, SEATS, ROUTE_IDS } = require('./schema');
const { resolve } = require('./frontier');
const gates = require('./gates');
const { SPINE, failUp, dropDown, staleWaivers, suspendExecution, reopenEffects } = require('./traversal');
const planlib = require('./plan');
const { planClosureProof } = require('./proof');
const { claimKind, claimIds } = require('./claims');
const { emptyNode, currentAccepted, baseVersions } = require('./nodes');
const { isTransportFailure, BACKOFF_MS } = require('./transport/outcomes');
const { wikiTempSnapshot } = require('./compile');
const { branchId } = require('./ids');

class ReduceError extends Error {}

const SCHEMA_VERSION = 5;
const AUTHORS = ['human', 'seat', 'system'];

const DEFAULT_SEATS = { leader: 'grok:cli', builder: 'grok:cli', reviewer: 'chatgpt:codex' };

const BUDGET_LIMITS = { 25: 25, 50: 50, unlimited: Infinity };
const SCALE = ['25', '50', 'unlimited'];
const WINDOW_MS = { '5 hours': 5 * 3600000, '1 day': 24 * 3600000, '1 week': 7 * 24 * 3600000, '1 month': 30 * 24 * 3600000 };

function turnNumberOf(event) {
  return event.turn_number;
}

function derivedStatus(state) {
  if (state.stopped || state.interrupted) return 'red';
  const reopened = Object.values(state.nodes).some((n) => n.reopened);
  if (state.project_done && state.closure && state.closure.state === 'accepted' && !reopened) return 'purple';
  if (state.gate || state.pending_validation) return 'yellow';
  return 'green';
}

function derivedPhase(state) {
  if (state.stopped) return 'PAUSED';
  if (state.interrupted) return 'INTERRUPTED';
  if (state.status === 'purple') return 'DONE';
  if (state.gate) return 'WAITING_GATED';
  if (state.pending_dispatch) return 'STAGING';
  if (state.pending_seat) return 'CLOSED_RUNNING';
  if (state.pending_validation) return 'REVIEWING';
  return 'OPEN';
}

function windowMsOf(state) {
  return WINDOW_MS[state.budget.window] || WINDOW_MS['1 day'];
}

function dispatchesInWindow(state, ts) {
  const floor = Date.parse(ts) - windowMsOf(state);
  return (state.budget.dispatches || []).filter((d) => Date.parse(d.ts) > floor);
}

function budgetUsed(state, ts) {
  return dispatchesInWindow(state, ts).length;
}

function budgetExhausted(state, ts) {
  if (!state || state.budget.authority === 'unlimited') return false;
  return budgetUsed(state, ts) >= BUDGET_LIMITS[state.budget.authority];
}

function settleBudget(state, ts) {
  state.budget.dispatches = dispatchesInWindow(state, ts);
  state.budget.used = state.budget.dispatches.length;
  state.budget.limit = state.budget.authority === 'unlimited' ? null : BUDGET_LIMITS[state.budget.authority];
}

function version(v, id, content, turn, ts, authoredBy) {
  if (!AUTHORS.includes(authoredBy)) throw new ReduceError('a version needs authored_by: human | seat | system');
  return { v, id, content, state: 'staged', staged_by_turn: turn, ts, authored_by: authoredBy };
}

function authorLabel(author) {
  return author && author.seat && author.seat !== 'human' ? 'seat' : 'human';
}

function authoredByOf(work, kind) {
  const node = work.nodes[kind];
  if (!node) return null;
  const ver = currentAccepted(node) || node.versions[node.versions.length - 1];
  return ver ? ver.authored_by : null;
}

function pendingValidation(kind, v, turn, author, extra) {
  const scope = kind === 'execution' ? 'executions' : kind;
  const def = gates.GATES.VALIDATE.applies_to.includes(scope) ? gates.gateDef('VALIDATE', { kind }) : null;
  return { kind, v, staged_by_turn: turn, ...(author ? { author } : {}), ...(extra || {}), def };
}

function applySpool(event) {
  const { input, facts, ts, turn } = event;
  const content = {
    problem: String(input.problem || ''),
    solution: String(input.solution || ''),
  };
  const next = {
    schema_version: SCHEMA_VERSION,
    ...(event.controls_version ? { controls_version: 1 } : {}),
    seq: 0,
    law: 'Agent-Wheel-ascii-diagram.txt',
    project: { id: facts.project_id, name: String(input.name || 'unnamed'), created: ts },
    wheel: { phase: 'OPEN' },
    status: 'green',
    turns: { last_id: 0, last_event: null },
    budget: { authority: '25', window: '1 day', dispatches: [], used: 0, limit: 25 },
    nodes: Object.fromEntries(KINDS.map((k) => [k, emptyNode(k)])),
    pending_validation: null,
    pending_dispatch: null,
    pending_seat: null,
    gate: null,
    routes: event.controls_version ? { solo: false } : { allowlist: [], solo: true },
    seats: Object.fromEntries(SEATS.map((s) => [s, { route: DEFAULT_SEATS[s], cfg: {} }])),
    cardbindings: {},
    dispatches: {},
    pending_redispatch: null,
    route_health: {},
    interrupted: null,
    waivers: [],
    closure_proof: null,
    plan_review: null,
    reviews: [],
    branches: {},
    leaves: {},
    executions: {},
    main: null,
    artifact: null,
    closure: null,
    project_done: null,
    plan_dirty: null,
    last_claim_change: null,
    quarantine: [],
    last_touched: ['idea'],
    last_failure: null,
    shelved: [],
    node_stands: {},
    pending_pull: null,
    last_schema_reject: null,
    last_recovery: null,
    stopped: false,
    frontier: null,
    identical_gaps: {},
  };
  next.nodes.idea.versions.push(version(1, facts.version_id, content, turn, ts, 'human'));
  next.pending_validation = pendingValidation('idea', 1, turn);
  return {
    state: next,
    result: { project_id: next.project.id, staged: { kind: 'idea', v: 1 } },
    touched: ['idea'],
    agree_event: 'presented_for_validation',
    card_reply: 'idea v1 staged from spool_project',
    reason: 'spool_project',
  };
}

function applyPrompt(work, event) {
  const { input, facts, ts, turn } = event;
  const target = input.target || {};
  if (target.kind !== 'idea' || !['problem', 'solution'].includes(target.field)) {
    throw new ReduceError('prompt target must be idea.problem or idea.solution');
  }
  const node = work.nodes.idea;
  node.draft = node.draft || { problem: '', solution: '' };
  node.draft[target.field] = String(input.text || '');
  let staged = null;
  if (node.draft.problem.length >= 20 && node.draft.solution.length >= 20) {
    const v = node.versions.length + 1;
    node.versions.push(version(
      v, facts.version_id, { problem: node.draft.problem, solution: node.draft.solution }, turn, ts, 'human'
    ));
    node.draft = null;
    node.reopened = false;
    work.pending_validation = pendingValidation('idea', v, turn);
    staged = { kind: 'idea', v };
  }
  return {
    state: work,
    result: { draft: node.draft, staged },
    touched: ['idea'],
    agree_event: staged ? 'presented_for_validation' : 'draft_updated',
    card_reply: staged ? `idea v${staged.v} staged` : `idea draft ${target.field} updated`,
  };
}

function openDesignReady(work, turn, v, author) {
  work.gate = {
    id: 'DESIGN_READY', opened_by_turn: turn,
    def: gates.gateDef('DESIGN_READY'), staged: { kind: 'design', v },
    ...(author ? { author } : {}),
  };
  work.pending_validation = null;
}

function shelveRequest(work, under, reason) {
  const pv = work.pending_validation;
  if (!pv || !pv.author || pv.author.seat === 'human') return null;
  if (pv.kind === under) return null;
  const subject = pv.kind === 'execution' ? { kind: 'execution', branch: pv.branch }
    : pv.kind === 'closure' ? { kind: 'closure' } : { kind: pv.kind, v: pv.v };
  return { under, subject, author: { seat: pv.author.seat, route: pv.author.route || null }, reason: String(reason || '').slice(0, 200) };
}

function describeSubject(s) {
  return s.kind === 'execution' ? 'execution ' + s.branch : s.kind === 'closure' ? 'the final closure' : `${s.kind} v${s.v}`;
}

function applyShelved(work, event) {
  const { input, turn, ts } = event;
  const s = input.subject || {};
  const record = { under: input.under, subject: s, author: input.author || null, reason: input.reason || '', turn, ts };
  if (s.kind === 'execution') {
    const ex = work.executions[s.branch];
    if (!ex || ex.state !== 'staged') throw new ReduceError(`no staged execution ${s.branch} to shelve`);
    ex.state = 'shelved';
    ex.shelved = { under: input.under, turn };
    const b = work.branches[s.branch];
    if (b && b.state !== 'merged') b.state = 'shelved';
    for (const id of ex.leaves) {
      const prev = work.leaves[id] || {};
      work.leaves[id] = { state: 'gap', execution: { branch: s.branch, turn, failed: false, shelved: true }, attempts: prev.attempts || 0 };
    }
    record.leaves = ex.leaves.slice();
  } else if (s.kind === 'closure') {
    if (!work.closure || work.closure.state !== 'staged') throw new ReduceError('no staged closure to shelve');
    record.closure = { steps: work.closure.steps, all_ok: work.closure.all_ok };
    work.closure = null;
  } else {
    const node = work.nodes[s.kind];
    const ver = node && node.versions.find((x) => x.v === s.v);
    if (!ver || ver.state !== 'staged') throw new ReduceError(`no staged ${s.kind} v${s.v} to shelve`);
    ver.state = 'shelved';
    ver.shelved = { under: input.under, turn };
    if (s.kind === 'design' && work.gate && work.gate.id === 'DESIGN_READY') work.gate = null;
  }
  const pv = work.pending_validation;
  if (pv && pv.kind === s.kind && (s.kind === 'execution' ? pv.branch === s.branch : s.kind === 'closure' || pv.v === s.v)) work.pending_validation = null;
  work.shelved.push(record);
  return {
    state: work,
    result: { shelved: record },
    touched: [input.under],
    agree_event: 'shelved',
    card_reply: null,
    reason: `shelved ${describeSubject(s)} under ${input.under}`,
  };
}

function setRouteHealth(work, route, patch) {
  const before = work.route_health[route] || {};
  work.route_health[route] = {
    degraded: false, failures: 0, last_outcome: null, last_failure: null, last_ok: null,
    ...before, ...patch,
  };
}

function healthFromOutcome(work, route, outcome, ts) {
  if (isTransportFailure(outcome)) {
    const before = work.route_health[route] || {};
    setRouteHealth(work, route, {
      degraded: true, failures: (before.failures || 0) + 1, last_outcome: outcome, last_failure: ts,
    });
    return;
  }
  // A reply that fails its schema still proves the transport. Only a route with a record is touched: answering is not news for one that never failed.
  if (work.route_health[route]) {
    setRouteHealth(work, route, { degraded: false, failures: 0, last_outcome: outcome, last_ok: ts });
  }
}

function applyPullRequested(work, event) {
  const { input, facts, turn, ts } = event;
  const ps = work.pending_seat;
  if (!ps) throw new ReduceError('no seat is pending');
  if (input.card_id !== ps.card_id) throw new ReduceError(`result card ${input.card_id} does not match pending ${ps.card_id}`);
  const dispatch = work.dispatches[ps.dispatch_id];
  const ids = facts.pull.ids.slice();
  if (dispatch) {
    dispatch.outcomes.push({ outcome: 'result', card_id: input.card_id, turn, ts, detail: 'pull: ' + ids.join(', '), pull: ids });
    dispatch.pulls = (dispatch.pulls || 0) + 1;
  }
  work.pending_seat = null;
  healthFromOutcome(work, ps.route, 'result', ts);
  work.pending_pull = {
    dispatch_id: ps.dispatch_id, kind: ps.kind, seat: ps.seat, route: ps.route, ids,
    result: facts.pull.result, leaves: ps.leaves || null, review: ps.review || null, decided_by_turn: turn,
  };
  return {
    state: work,
    result: { pull_requested: ids, dispatch_id: ps.dispatch_id, seat: ps.seat, route: ps.route },
    touched: [nodeKindOf(work, ps.kind)],
    agree_event: 'pull_requested',
    card_reply: null,
    reason: `pull requested by the ${ps.seat} seat: ${ids.join(', ')}`,
  };
}

function applyPullRefused(work, event) {
  const { input, turn, ts } = event;
  const ps = work.pending_seat;
  const dispatch = ps ? work.dispatches[ps.dispatch_id] : null;
  const record = { card_id: input.card_id, entries: input.entries || [], reason: input.reason || '', turn, ts };
  if (dispatch) dispatch.pull_refused = [...(dispatch.pull_refused || []), record];
  work.last_pull_refused = record;
  return {
    state: work,
    result: { pull_refused: record.entries, reason: record.reason },
    touched: [],
    agree_event: 'pull_refused',
    card_reply: null,
    reason: `pull refused: ${record.reason}`,
  };
}

const CLAIM_ID_RE = /\b(?:[ASVTINDRC][0-9]+|release|problem|solution)\b/g;
function findingKey(target, references, notes) {
  const ids = new Set();
  for (const text of [...(references || []), notes || '']) for (const m of String(text).match(CLAIM_ID_RE) || []) ids.add(m);
  return `${target}:${[...ids].sort().join(',') || 'node'}`;
}

function applyForm(work, event) {
  const { input, facts, ts, turn } = event;
  const kind = input.kind;
  if (!NODE_SCHEMAS[kind]) throw new ReduceError('unknown node kind: ' + kind);
  if (kind === 'plan') throw new ReduceError('plan is not a form node; it is system-built');
  const node = work.nodes[kind];
  const v = node.versions.length + 1;
  node.versions.push(version(v, facts.version_id, input.content, turn, ts, 'human'));
  node.stale = false;
  node.reopened = false;
  if (kind === 'design') openDesignReady(work, turn, v, { seat: 'human', route: null });
  else work.pending_validation = pendingValidation(kind, v, turn);
  if (work.last_failure && work.last_failure.kind === kind) work.last_failure = null;
  return {
    state: work,
    result: { staged: { kind, v } },
    touched: [kind],
    agree_event: kind === 'design' ? 'gated_for_approval' : 'presented_for_validation',
    card_reply: `${kind} v${v} staged`,
  };
}

function applyMerge(work, merge, turn, reviewId) {
  if (!merge) throw new ReduceError('accepting an execution needs the merge facts');
  const ex = work.executions[merge.branch];
  if (!ex || ex.state !== 'staged') throw new ReduceError(`execution ${merge.branch} is not staged`);
  ex.state = 'accepted';
  ex.accepted_by_turn = turn;
  ex.review_id = reviewId || null;
  for (const id of ex.leaves) {
    work.leaves[id] = { state: 'done', execution: { branch: merge.branch, turn, tests: ex.tests.command } };
  }
  const branch = work.branches[merge.branch];
  if (branch) branch.state = 'merged';
  work.main = {
    dir: merge.main_dir,
    main_file: merge.main_file,
    sha256: merge.sha256,
    bytes: merge.bytes,
    merged: [...(work.main ? work.main.merged : []), merge.branch],
  };
  const from = path.join(merge.workspace, merge.main_file);
  work.artifact = {
    path: merge.output_target,
    sha256: merge.sha256,
    bytes: merge.bytes,
    product_link: merge.product_link,
    promoted_from: from,
  };
  if (work.closure) { work.closure = null; work.project_done = null; }
  return {
    merge: { branch: merge.branch, from: merge.workspace, to: merge.main_dir, files: merge.files },
    promote: { from, to: merge.output_target, sha256: merge.sha256 },
  };
}

function reopenExecution(work, branch, reason, turn) {
  const ex = work.executions[branch];
  if (ex && ex.state === 'staged') ex.state = 'rejected';
  const b = work.branches[branch];
  if (b && b.state !== 'merged') b.state = 'stale';
  const leaves = ex ? ex.leaves : (b && b.leaves) || [];
  for (const id of leaves) {
    const prev = work.leaves[id] || {};
    work.leaves[id] = { state: 'gap', execution: { branch, turn, failed: true }, attempts: (prev.attempts || 0) + 1 };
  }
  work.last_failure = { kind: 'plan', reason: String(reason || '').slice(0, 400), spine_index: SPINE.indexOf('plan'), leaves };
  if (ex && ex.tests) {
    work.last_failure.failed_branch = branch;
    work.last_failure.tests = { exit_code: ex.tests.exit_code, output_tail: String(ex.tests.output_tail || '').slice(-2000) };
  }
  return leaves;
}

function applyValidate(work, event) {
  const { input, turn, facts } = event;
  const pending = work.pending_validation;
  if (!pending) throw new ReduceError('nothing is pending validation');
  gates.assertLegal('VALIDATE', input.action);
  const accept = input.action === 'ACCEPT';
  if (pending.staged_by_turn === turn) {
    throw new ReduceError('a turn cannot accept its own staging');
  }
  if (pending.author && pending.author.seat !== 'human' && !pending.engine_closed) {
    throw new ReduceError('a seat-authored result is accepted only by the independent review seat');
  }
  if (pending.kind === 'closure') throw new ReduceError('the final closure is accepted only by the independent review seat');

  if (pending.kind === 'execution') {
    const ex = work.executions[pending.branch];
    if (!ex || ex.state !== 'staged') throw new ReduceError(`staged execution gone: ${pending.branch}`);
    work.reviews.push({
      id: facts.review_id, turn,
      subject: { kind: 'execution', branch: pending.branch, leaves: ex.leaves },
      author: { turn: pending.staged_by_turn, seat: 'human', route: null },
      reviewer: { seat: 'validate', deterministic: true, rung: null, context: 'fresh turn', author_reasoning_supplied: false },
      decision: accept ? 'accept' : 'gap',
      references: [`execution ${pending.branch}`, ...ex.leaves],
      notes: String(input.note || ''),
      ts: event.ts,
    });
    work.pending_validation = null;
    if (accept) {
      const out = applyMerge(work, facts.merge, turn, facts.review_id);
      return {
        state: work,
        result: { accepted: { kind: 'execution', branch: pending.branch }, done: ex.leaves },
        accepts_execution: pending.branch,
        merge: out.merge,
        promote: out.promote,
        touched: ['plan'],
        agree_event: 'accepted',
        card_reply: `execution ${pending.branch} accepted; merged to main; done: ${ex.leaves.join(', ')}`,
        reason: `accept execution ${pending.branch}`,
      };
    }
    const leaves = reopenExecution(work, pending.branch, input.note || 'validation rejected the execution', turn);
    return {
      state: work,
      result: { rejected: { kind: 'execution', branch: pending.branch }, reopened: leaves },
      touched: ['plan'],
      agree_event: 'rejected_restage',
      card_reply: `execution ${pending.branch} rejected; leaves reopened: ${leaves.join(', ')}`,
      reason: `reject execution ${pending.branch}`,
    };
  }

  const node = work.nodes[pending.kind];
  const ver = node.versions.find((x) => x.v === pending.v);
  if (!ver || ver.state !== 'staged') {
    throw new ReduceError(`staged version gone: ${pending.kind} v${pending.v}`);
  }
  work.reviews.push({
    id: facts.review_id,
    turn,
    subject: { kind: pending.kind, v: pending.v },
    author: { turn: pending.staged_by_turn, seat: 'human', route: null },
    reviewer: { seat: 'validate', deterministic: true, rung: null, context: 'fresh turn', author_reasoning_supplied: false },
    decision: accept ? 'accept' : 'gap',
    references: [`${pending.kind} v${pending.v}`],
    notes: String(input.note || ''),
    ts: event.ts,
  });
  if (accept && pending.kind === 'plan') {
    const closed = planlib.planClosed(ver.content);
    if (!closed.ok) {
      ver.state = 'rejected';
      work.pending_validation = null;
      work.reviews.at(-1).decision = 'gap';
      work.reviews.at(-1).references = planlib.collectLeaves(ver.content.root).filter((l) => l.trial.status !== 'passed').map((l) => l.id);
      work.reviews.at(-1).notes = 'plan trial incomplete: ' + closed.reason;
      failUp(work, 'plan', 'plan trial incomplete: ' + closed.reason);
      return {
        state: work,
        result: { rejected: { kind: 'plan', v: pending.v }, gap: closed.reason, reopened: 'plan' },
        touched: ['plan'],
        agree_event: 'review_gap',
        card_reply: null,
        reason: 'plan trial incomplete: ' + closed.reason,
      };
    }
  }
  if (accept) {
    const previous = node.versions.filter((x) => x.state === 'accepted' && x.v < ver.v).at(-1) || null;
    ver.state = 'accepted';
    ver.accepted_by_turn = turn;
    ver.accepted_by = 'validate';
    work.pending_validation = null;
    node.stale = false;
    node.reopened = false;
    const walk = pending.kind === 'plan' ? { leaves: [], changed: [], removed: [], added: [] } : dropDown(work, pending.kind, previous ? previous.content : null, ver.content);
    const dropped = walk.leaves;
    let conformed = null;
    if (pending.kind === 'spec' && !work.controls_version) {
      if (ver.content.budget) {
        work.budget.authority = ver.content.budget.authority;
        work.budget.window = ver.content.budget.window;
      }
      conformed = bindAllowlist(work, ver.content.route_allowlist);
    }
    let closure = null;
    if (pending.kind === 'plan') closure = afterPlanAccepted(work, event, pending.v);
    return {
      state: work,
      result: { accepted: { kind: pending.kind, v: pending.v }, dropped, ...(closure ? { closure_proof: closure } : {}), ...(conformed && conformed.length ? { seats_conformed: conformed } : {}) },
      accepts: { kind: pending.kind, v: pending.v },
      touched: [pending.kind, ...(closure && !closure.all_ok ? [closure.responsible] : [])],
      agree_event: closure && !closure.all_ok ? 'closure_proof_failed' : 'accepted',
      card_reply: `${pending.kind} v${pending.v} accepted` +
        (dropped.length ? `; leaves back to untried by claim: ${dropped.join(', ')}` : '') +
        (closure ? `; closure proof ${closure.all_ok ? 'passed' : 'failed at ' + closure.first_failure.claim}` : ''),
      reason: `accept ${pending.kind} v${pending.v}` + (conformed && conformed.length ? `; seats moved inside the allowlist: ${conformed.map((c) => `${c.seat} ${c.from} -> ${c.to}`).join(', ')}` : ''),
    };
  }
  {
    ver.state = 'rejected';
    work.pending_validation = null;
    const res = failUp(work, pending.kind, input.note || 'review rejected staging');
    return {
      state: work,
      result: { rejected: { kind: pending.kind, v: pending.v }, reopened: res.reopened },
      touched: [pending.kind],
      agree_event: 'rejected_restage',
      card_reply: `${pending.kind} v${pending.v} rejected; ${res.reopened} reopened`,
      reason: `reject ${pending.kind} v${pending.v}`,
    };
  }
}

function bindAllowlist(work, allowlist) {
  const allow = [...new Set(allowlist || [])];
  work.routes = { allowlist: allow, solo: allow.length <= 1 };
  const conformed = [];
  if (!allow.length) return conformed;
  for (const seat of SEATS) {
    const current = work.seats[seat].route;
    if (allow.includes(current)) continue;
    let to = allow[0];
    if (seat === 'reviewer') {
      const leaderRoute = work.seats.leader.route;
      to = allow.find((r) => r !== leaderRoute) || allow[0];
    }
    work.seats[seat] = { route: to, cfg: {} };
    conformed.push({ seat, from: current, to });
  }
  return conformed;
}

function applySeatAssignment(work, event) {
  const { input, turn } = event;
  if (!SEATS.includes(input.seat)) throw new ReduceError('unknown seat: ' + input.seat);
  if (!ROUTE_IDS.includes(input.route)) throw new ReduceError('unknown route: ' + input.route);
  const before = work.seats[input.seat];
  const allow = work.controls_version ? [] : work.routes.allowlist || [];
  const outside = allow.length > 0 && !allow.includes(input.route);
  work.seats[input.seat] = { route: input.route, cfg: input.config ? structuredClone(input.config) : {} };
  if (work.controls_version) work.routes.solo = new Set(Object.values(work.seats).map(s => s.route)).size === 1;
  work.last_seat_assignment = { seat: input.seat, from: before.route, to: input.route, turn, outside_allowlist: outside };
  return {
    state: work,
    result: { seat: input.seat, route: input.route, from: before.route, outside_allowlist: outside, dropped: [] },
    touched: [],
    agree_event: 'seat_assigned',
    card_reply: null,
    reason: `seat assignment ${input.seat}: ${before.route} -> ${input.route}` + (outside ? ` (outside the allowlist ${allow.join(', ')}; egress will refuse it)` : ''),
  };
}

function applyBudgetSet(work, event) {
  const { input, turn } = event;
  if (!SCALE.includes(input.authority)) throw new ReduceError('unknown budget authority: ' + input.authority);
  if (!Object.prototype.hasOwnProperty.call(WINDOW_MS, input.window)) {
    throw new ReduceError('unknown budget window: ' + input.window);
  }
  const from = { authority: work.budget.authority, window: work.budget.window };
  work.budget.authority = input.authority;
  work.budget.window = input.window;
  settleBudget(work, event.ts);
  work.last_budget_set = { from, to: { authority: input.authority, window: input.window }, turn };
  return {
    state: work,
    result: { authority: input.authority, window: input.window, from },
    touched: [],
    agree_event: 'budget_set',
    card_reply: null,
    reason: `budget ${from.authority} per ${from.window} -> ${input.authority} per ${input.window}`,
  };
}

function seatKeyOf(seatName) {
  return seatName === 'reviewer' ? 'reviewer' : seatName === 'builder' ? 'builder' : 'leader';
}

function afterPlanAccepted(work, event, v) {
  const { turn, ts } = event;
  for (const [id, o] of Object.entries(work.leaves || {})) {
    if (o.state === 'untried') delete work.leaves[id];
  }
  work.plan_dirty = null;
  work.last_claim_change = null;
  const proof = planClosureProof(work, { plan_v: v });
  work.closure_proof = { ...proof, turn, ts };
  if (proof.all_ok) openPlanReady(work, turn, v);
  else openRepairRequired(work, event, { kind: 'plan', v }, proof);
  return { all_ok: proof.all_ok, claims: proof.claims.length, steps: proof.steps.length, responsible: proof.responsible, first_failure: proof.first_failure };
}

function applyGate(work, event) {
  const { input, turn, ts, facts } = event;
  if (!work.gate) throw new ReduceError('no gate is open');
  const gateId = work.gate.id;
  gates.assertLegal(gateId, input.action);

  if (gateId === 'DESIGN_READY') {
    const staged = work.gate.staged;
    const node = work.nodes.design;
    const ver = node.versions.find((x) => x.v === staged.v);
    if (input.action === 'APPROVE') {
      if (ver.staged_by_turn === turn) {
        throw new ReduceError('a turn cannot approve its own staging');
      }
      return acceptDesign(work, event, staged, { id: gateId, action: 'APPROVE' });
    }
    if (input.action === 'REJECT') {
      const param = gates.GATES.DESIGN_READY.params.REJECT.target;
      const target = input.target == null || input.target === '' ? param.default : input.target;
      if (!param.enum.includes(target)) {
        throw new ReduceError(`REJECT target must be one of ${param.enum.join(', ')} (default ${param.default}); got ${JSON.stringify(input.target)}`);
      }
      ver.state = 'rejected';
      node.rejected_note = gates.rejectBody(input.reply);
      node.draft = null;
      work.gate = null;
      const shelve = shelveRequest(work, target, 'design rejected; fail-up to ' + target);
      failUp(work, target, node.rejected_note);
      return {
        state: work,
        result: { rejected: { kind: 'design', v: staged.v }, note: node.rejected_note, target, reopened: target },
        shelve,
        touched: ['design', target],
        agree_event: 'rejected_restage',
        card_reply: node.rejected_note,
        reason: 'gate reject design; target ' + target + ' reopened',
      };
    }
    const reply = input.action === 'SUMMARY'
      ? JSON.stringify(wikiTempSnapshot(work))
      : 'question recorded: ' + String(input.reply || '');
    return {
      state: work,
      result: { gate: gateId, action: input.action, reply },
      touched: ['design'],
      agree_event: 'gate_dialogue',
      card_reply: reply.slice(0, 400),
      reason: 'gate ' + input.action.toLowerCase(),
    };
  }

  if (gateId === 'REPAIR_REQUIRED') {
    const staged = work.gate.staged;
    const claim = work.gate.claim;
    const responsible = work.gate.responsible || 'plan';
    const detail = work.gate.detail || '';
    if (input.action === 'REPAIR') {
      work.gate = null;
      failUp(work, responsible, detail);
      return {
        state: work,
        result: { repair: responsible, claim },
        gate_meta: { id: gateId, action: 'REPAIR' },
        touched: ['plan', responsible],
        agree_event: 'repair_restage',
        card_reply: `closure proof repair: ${responsible} reopened (${claim})`,
        reason: 'gate repair ' + responsible,
      };
    }
    if (input.action === 'WAIVE') {
      const reason = String(input.reply || '').trim();
      if (!reason) throw new ReduceError('WAIVE requires a reason');
      const waiver = {
        id: facts.waiver_id, claim, reason, authorizer: 'human',
        target: { kind: staged.kind, v: staged.v }, turn, ts, stale: false,
      };
      work.waivers.push(waiver);
      const proof = planClosureProof(work, { plan_v: staged.v });
      work.closure_proof = { ...proof, turn, ts };
      work.gate = null;
      if (proof.all_ok) openPlanReady(work, turn, staged.v);
      else openRepairRequired(work, event, staged, proof);
      return {
        state: work,
        result: { waiver: waiver.id, claim, closure_proof: { all_ok: proof.all_ok, waivers: proof.waivers } },
        gate_meta: { id: gateId, action: 'WAIVE' },
        touched: ['plan'],
        agree_event: proof.all_ok ? 'waived' : 'closure_proof_failed',
        card_reply: `claim ${claim} waived; closure proof ${proof.all_ok ? 'passed' : 'still fails at ' + proof.first_failure.claim}`,
        reason: 'gate waive ' + claim,
      };
    }
    if (input.action === 'STOP') {
      work.stopped = true;
      work.gate = null;
      return {
        state: work,
        result: { stopped: true, claim },
        gate_meta: { id: gateId, action: 'STOP' },
        touched: ['plan'],
        agree_event: 'paused',
        card_reply: 'paused at closure proof ' + claim,
        reason: 'gate stop',
      };
    }
    const reply = 'reply recorded: ' + String(input.reply || '');
    return {
      state: work,
      result: { gate: gateId, action: 'REPLY', reply, claim, detail },
      touched: ['plan'],
      agree_event: 'gate_dialogue',
      card_reply: reply.slice(0, 400),
      reason: 'gate reply',
    };
  }

  if (gateId === 'BUDGET_GATE') {
    if (input.action === 'EXTEND') {
      const i = SCALE.indexOf(work.budget.authority);
      work.budget.authority = SCALE[Math.min(i + 1, SCALE.length - 1)];
      work.gate = null;
    } else if (input.action === 'REPLAN') {
      work.gate = null;
      if (work.controls_version) failUp(work, 'plan', 'replan within the project budget');
      else {
        const spec = work.nodes.spec;
        const cur = currentAccepted(spec);
        if (cur) { spec.reopened = true; spec.draft = structuredClone(cur.content); }
        reopenEffects(work, 'spec');
      }
    } else if (input.action === 'WAIT') {
      work.gate.waiting = true;
    } else if (input.action === 'STOP') {
      work.stopped = true;
      work.gate = null;
    }
    return {
      state: work,
      result: { budget: work.budget.authority, stopped: Boolean(work.stopped), action: input.action },
      touched: work.controls_version ? (input.action === 'REPLAN' ? ['plan'] : []) : ['spec'],
      agree_event: 'gate_resolved',
      card_reply: `budget gate: ${input.action}`,
      reason: 'gate budget ' + input.action,
    };
  }

  if (gateId === 'HUMAN_ESCALATION') {
    work.interrupted = null;
    let shelve = null;
    if (input.action === 'RETRY') {
      work.gate = null;
      work.pending_seat = null;
      work.last_schema_reject = null;
    } else if (input.action === 'EDIT_NODE') {
      const kind = work.gate.target || (work.last_failure && work.last_failure.kind) || 'plan';
      work.gate = null;
      work.pending_seat = null;
      shelve = shelveRequest(work, kind, 'human escalation: edit the responsible node');
      failUp(work, kind, 'human escalation: edit the responsible node');
    } else if (input.action === 'NODE_STANDS') {
      const target = work.gate.target;
      if (!target) throw new ReduceError('NODE_STANDS needs a named node; this escalation carries none');
      const pv = work.pending_validation;
      if (!pv || !pv.author || pv.author.seat === 'human') throw new ReduceError('NODE_STANDS needs a staged seat result to return the finding to');
      const finding = [...work.reviews].reverse().find((r) => (r.decision === 'gap' || r.decision === 'conflict') && r.subject &&
        (pv.kind === 'execution' ? r.subject.branch === pv.branch : pv.kind === 'closure' ? r.subject.kind === 'closure' : r.subject.kind === pv.kind && r.subject.v === pv.v)) || null;
      const key = work.gate.finding_key || findingKey(target, finding ? finding.references : [], finding ? finding.notes : '');
      const count = ((work.node_stands || {})[key] || 0) + 1;
      work.node_stands = { ...(work.node_stands || {}), [key]: count };
      work.gate = null;
      work.pending_seat = null;
      const why = `node stands (${target}): ${finding ? finding.notes : 'the reviewer\'s finding'}`.slice(0, 400);
      work.pending_validation = null;
      let reopened;
      if (pv.kind === 'execution') {
        reopened = reopenExecution(work, pv.branch, why, turn);
      } else if (pv.kind === 'closure') {
        work.closure = null;
        reopened = reopenNamedLeaves(work, finding ? finding.references : [], why, turn);
        if (!reopened.length) { failUp(work, 'plan', why); reopened = 'plan'; }
      } else {
        const node = work.nodes[pv.kind];
        const ver = node.versions.find((x) => x.v === pv.v);
        if (ver && ver.state === 'staged') ver.state = 'rejected';
        failUp(work, pv.kind, why);
        if (pv.kind === 'plan') {
          const named = reopenNamedLeavesOfRefs(work, ver, finding ? finding.references : []);
          work.last_failure.leaves = named;
          work.last_failure.from_version = named.length ? pv.v : null;
        }
        reopened = pv.kind;
      }
      work.last_node_stands = { target, key, count, turn, subject: describeSubject(pv.kind === 'execution' ? { kind: 'execution', branch: pv.branch } : pv.kind === 'closure' ? { kind: 'closure' } : { kind: pv.kind, v: pv.v }) };
      return {
        state: work,
        result: { gate: gateId, action: input.action, target, node_stands: { key, count }, rejected: work.last_node_stands.subject, reopened, seat: pv.author.seat, route: pv.author.route || null },
        touched: ['plan'],
        agree_event: 'node_stands',
        card_reply: null,
        reason: `gate human NODE_STANDS: ${target} stands; ${work.last_node_stands.subject} returned to the ${pv.author.seat} seat with the finding (${count})`,
      };
    } else if (input.action === 'CHOOSE_DIRECTION') {
      work.gate = null;
      work.pending_seat = null;
      work.chosen_direction = String(input.reply || '');
      const pv = work.pending_validation;
      if (pv && pv.kind === 'execution') {
        const ex = work.executions[pv.branch];
        if (ex && ex.state === 'staged' && pv.staged_by_turn !== turn) {
          work.pending_validation = null;
          work.reviews.push({
            id: facts.review_id, turn, subject: { kind: 'execution', branch: pv.branch, leaves: ex.leaves },
            author: { turn: pv.staged_by_turn, seat: pv.author ? pv.author.seat : 'human', route: pv.author ? pv.author.route : null },
            reviewer: { seat: 'human', deterministic: false, rung: null, context: 'HUMAN_ESCALATION CHOOSE_DIRECTION', author_reasoning_supplied: false },
            decision: 'accept', references: [`execution ${pv.branch}`], notes: work.chosen_direction, ts,
          });
          const out = applyMerge(work, facts.merge, turn, facts.review_id);
          return {
            state: work,
            result: { gate: gateId, action: input.action, accepted: { kind: 'execution', branch: pv.branch } },
            accepts_execution: pv.branch,
            merge: out.merge,
            promote: out.promote,
            touched: ['plan'],
            agree_event: 'human_chose_direction',
            card_reply: null,
            reason: 'gate human CHOOSE_DIRECTION accepted execution ' + pv.branch,
          };
        }
      } else if (pv && pv.kind === 'closure') {
        if (work.closure && work.closure.state === 'staged' && pv.staged_by_turn !== turn) {
          const out = acceptClosure(work, event, { seat: 'human', context: 'HUMAN_ESCALATION CHOOSE_DIRECTION', notes: work.chosen_direction });
          out.result = { gate: gateId, action: input.action, ...out.result };
          out.agree_event = 'human_chose_direction';
          return out;
        }
      } else if (pv) {
        const node = work.nodes[pv.kind];
        const ver = node.versions.find((x) => x.v === pv.v);
        if (ver && ver.state === 'staged' && ver.staged_by_turn !== turn) {
          const previous = node.versions.filter((x) => x.state === 'accepted' && x.v < ver.v).at(-1) || null;
          ver.state = 'accepted';
          ver.accepted_by_turn = turn;
          ver.accepted_by = 'human';
          work.pending_validation = null;
          node.stale = false;
          node.reopened = false;
          if (pv.kind !== 'plan') dropDown(work, pv.kind, previous ? previous.content : null, ver.content);
          if (pv.kind === 'spec' && !work.controls_version) {
            if (ver.content.budget) {
              work.budget.authority = ver.content.budget.authority;
              work.budget.window = ver.content.budget.window;
            }
            bindAllowlist(work, ver.content.route_allowlist);
          }
          work.reviews.push({
            id: facts.review_id, turn, subject: { kind: pv.kind, v: pv.v },
            author: { turn: pv.staged_by_turn, seat: pv.author ? pv.author.seat : 'human', route: pv.author ? pv.author.route : null },
            reviewer: { seat: 'human', deterministic: false, rung: null, context: 'HUMAN_ESCALATION CHOOSE_DIRECTION', author_reasoning_supplied: false },
            decision: 'accept', references: [`${pv.kind} v${pv.v}`], notes: work.chosen_direction, ts,
          });
          if (pv.kind === 'plan') afterPlanAccepted(work, event, pv.v);
          return {
            state: work,
            result: { gate: gateId, action: input.action, accepted: { kind: pv.kind, v: pv.v } },
            accepts: { kind: pv.kind, v: pv.v },
            touched: [pv.kind],
            agree_event: 'human_chose_direction',
            card_reply: null,
            reason: 'gate human CHOOSE_DIRECTION accepted ' + pv.kind,
          };
        }
      }
    } else if (input.action === 'STOP') {
      work.stopped = true;
      work.gate = null;
    }
    return {
      state: work,
      result: { gate: gateId, action: input.action },
      touched: [],
      shelve,
      agree_event: 'gate_resolved',
      card_reply: 'human escalation: ' + input.action,
      reason: 'gate human ' + input.action,
    };
  }

  if (gateId === 'PLAN_READY') {
    const plan = currentAccepted(work.nodes.plan);
    const summary = plan ? plan.content.summary : null;
    if (input.action === 'SUMMARIZE') {
      const reply = plan
        ? `${summary.leaves} leaves, ${summary.passed} passed, ${summary.untried} untried, ${summary.gaps} gaps, ${summary.conflicts} conflicts; decision ${plan.content.decision.chosen} (${plan.content.decision.basis}); high-risk leaves: ${summary.high_risk.join(', ') || 'none'}`
        : 'no accepted plan';
      return {
        state: work,
        result: { gate: gateId, action: 'SUMMARIZE', reply },
        touched: ['plan'],
        agree_event: 'gate_dialogue',
        card_reply: null,
        reason: 'gate summarize plan',
      };
    }
    if (input.action === 'SKIP_REVIEW') {
      const closed = plan ? planlib.planClosed(plan.content) : { ok: false, reason: 'no accepted plan' };
      if (!closed.ok) throw new ReduceError('Plan Skip is not available: ' + closed.reason);
      const spec = currentAccepted(work.nodes.spec);
      const preauthorized = new Set((spec && spec.content.preauthorized_high_risk) || []);
      const leaves = planlib.collectLeaves(plan.content.root);
      const needsHuman = summary.high_risk.filter((id) => {
        const leaf = leaves.find((l) => l.id === id);
        return !leaf.claim_refs.some((ref) => preauthorized.has(ref));
      });
      if (needsHuman.length) {
        throw new ReduceError('high-risk leaves need the human gate (APPROVE after review): ' + needsHuman.join(', '));
      }
      work.gate = null;
      work.plan_review = {
        turn, ts, action: 'SKIP_REVIEW', v: plan.v,
        skipped: ['optional human review'],
        not_skipped: ['leaf', 'evidence', 'gap', 'conflict', 'write lock'],
      };
      return {
        state: work,
        result: { gate: gateId, action: 'SKIP_REVIEW', skipped: ['optional human review'] },
        touched: ['plan'],
        agree_event: 'plan_skip',
        card_reply: null,
        reason: 'gate plan skip review',
      };
    }
    work.gate = null;
    work.plan_review = { turn, ts, action: 'APPROVE', v: plan ? plan.v : work.nodes.plan.versions.at(-1).v, skipped: [], not_skipped: [] };
    return {
      state: work,
      result: { gate: gateId, action: 'APPROVE' },
      touched: ['plan'],
      agree_event: 'plan_approved',
      card_reply: null,
      reason: 'gate approve plan',
    };
  }

  if (gateId === 'ROUTE_ATTENTION') {
    const failedDispatch = work.gate.dispatch_id && work.dispatches[work.gate.dispatch_id] ? work.gate.dispatch_id : null;
    const seat = seatKeyOf(work.gate.seat || (failedDispatch ? work.dispatches[failedDispatch].seat : null));
    let chosen = null;
    if (input.action === 'COMPLETE_ACTION') {
      work.gate = null;
      if (failedDispatch) {
        work.pending_redispatch = { dispatch_id: failedDispatch, route: work.dispatches[failedDispatch].route, outcome: 'route_action_completed', failures: 0, backoff_ms: 0, due_at: ts, decided_by_turn: turn };
      }
    } else if (input.action === 'CHOOSE_ROUTE') {
      if (!input.route) throw new ReduceError('CHOOSE_ROUTE needs a route');
      chosen = String(input.route);
      if (!ROUTE_IDS.includes(chosen)) throw new ReduceError('unknown route: ' + chosen);
      const allow = work.controls_version ? [] : work.routes.allowlist || [];
      if (allow.length && !allow.includes(chosen)) throw new ReduceError(`route ${chosen} is not in the Spec allowlist (${allow.join(', ')})`);
      if (seat) {
        const from = work.seats[seat].route;
        work.seats[seat] = { route: chosen, cfg: from === chosen ? work.seats[seat].cfg : {} };
        if (work.controls_version) work.routes.solo = new Set(Object.values(work.seats).map(s => s.route)).size === 1;
        work.last_seat_assignment = { seat, from, to: chosen, turn, outside_allowlist: false, via: 'ROUTE_ATTENTION' };
      }
      work.gate = null;
      if (failedDispatch) {
        work.pending_redispatch = { dispatch_id: failedDispatch, route: chosen, outcome: 'route_chosen', failures: 0, backoff_ms: 0, due_at: ts, decided_by_turn: turn };
      }
    } else if (input.action === 'PAUSE') {
      work.stopped = true;
      work.gate = null;
    }
    return {
      state: work,
      result: { gate: gateId, action: input.action, route: chosen, seat: seat || null },
      touched: [],
      agree_event: 'gate_resolved',
      card_reply: 'route attention: ' + input.action,
      reason: 'gate route ' + input.action + (chosen ? ` (${seat} -> ${chosen})` : ''),
    };
  }

  throw new ReduceError('no reducer for gate ' + gateId);
}

function acceptDesign(work, event, staged, gateMeta) {
  const { turn } = event;
  const node = work.nodes.design;
  const ver = node.versions.find((x) => x.v === staged.v);
  const previous = node.versions.filter((x) => x.state === 'accepted' && x.v < ver.v).at(-1) || null;
  ver.state = 'accepted';
  ver.accepted_by_turn = turn;
  ver.accepted_by = 'human';
  node.rejected_note = null;
  node.stale = false;
  node.reopened = false;
  work.gate = null;
  const walk = dropDown(work, 'design', previous ? previous.content : null, ver.content);
  const dropped = walk.leaves;
  if (work.last_failure && work.last_failure.kind === 'design') work.last_failure = null;
  return {
    state: work,
    result: { accepted: { kind: 'design', v: staged.v }, dropped, claims: { changed: walk.changed, removed: walk.removed, added: walk.added } },
    accepts: { kind: 'design', v: staged.v },
    gate_meta: gateMeta,
    touched: ['design'],
    agree_event: 'approved',
    card_reply: `design v${staged.v} approved` + (dropped.length ? `; leaves back to untried by claim: ${dropped.join(', ')}` : ''),
    reason: 'gate ' + gateMeta.action.toLowerCase() + ' design',
  };
}

function openRepairRequired(work, event, staged, proof) {
  const first = proof.first_failure;
  const detail = `plan closure proof ${first.status} at ${first.claim}: ${first.detail}`;
  work.gate = {
    id: 'REPAIR_REQUIRED', opened_by_turn: event.turn,
    def: gates.gateDef('REPAIR_REQUIRED', { kind: first.earliest_repair }),
    staged, claim: first.claim, status: first.status, responsible: first.earliest_repair, detail,
  };
}

function openPlanReady(work, turn, v) {
  work.gate = { id: 'PLAN_READY', opened_by_turn: turn, def: gates.gateDef('PLAN_READY'), staged: { kind: 'plan', v } };
}

function executionState(state) {
  const plan = currentAccepted(state.nodes.plan);
  if (!plan || state.nodes.plan.stale || state.nodes.plan.reopened) return { unlocked: false, reason: 'no accepted current plan' };
  const closed = planlib.planClosed(plan.content);
  if (!closed.ok) return { unlocked: false, reason: closed.reason };
  const cp = state.closure_proof;
  if (!cp || !cp.all_ok || cp.targets.plan !== plan.v) return { unlocked: false, reason: `plan closure proof has not passed for plan v${plan.v}` };
  for (const k of ['idea', 'experience', 'design', 'spec']) {
    const cur = currentAccepted(state.nodes[k]);
    if (!cur || cp.targets[k] !== cur.v) return { unlocked: false, reason: `plan closure proof is stale: ${k} v${cp.targets[k]} proven, v${cur ? cur.v : 'none'} current` };
  }
  for (const c of cp.claims) {
    if (c.status !== 'waiver') continue;
    const w = (state.waivers || []).find((x) => x.id === c.waiver.id);
    if (!w || w.stale) return { unlocked: false, reason: `plan closure proof is stale: the waiver for ${c.id} is stale` };
  }
  if (!state.plan_review || state.plan_review.v !== plan.v) return { unlocked: false, reason: `PLAN_READY has not been approved for plan v${plan.v}` };
  for (const k of ['idea', 'experience', 'design', 'spec']) {
    if (state.nodes[k].reopened) return { unlocked: false, reason: `${k} is reopened: its successor version decides what moves` };
  }
  if (state.plan_dirty) return { unlocked: false, reason: `the Plan must be looked at again: ${state.plan_dirty.kind} claims moved` };
  if (state.gate) return { unlocked: false, reason: 'gate ' + state.gate.id + ' is open' };
  if (state.stopped) return { unlocked: false, reason: 'project is paused' };
  return { unlocked: true, reason: 'plan closure proof passed, PLAN_READY approved, gates clear' };
}

function applyPlanGenerate(work) {
  const idea = currentAccepted(work.nodes.idea);
  const experience = currentAccepted(work.nodes.experience);
  const design = currentAccepted(work.nodes.design);
  const spec = currentAccepted(work.nodes.spec);
  if (!idea || !experience || !design || !spec) {
    throw new ReduceError('plan needs accepted idea, experience, design, and spec');
  }
  const draft = planlib.generateStructure(idea.content, experience.content, design.content, spec.content);
  const accepted = currentAccepted(work.nodes.plan);
  let carried = 0;
  const carryFrom = (source, spare) => {
    const prevById = planlib.nodesById(source.content.root);
    planlib.walk(draft, (n) => {
      if (n.decomposes_into.length) return;
      const p = prevById.get(n.id);
      const o = work.leaves[n.id];
      if (!p || !p.trial || p.trial.status !== 'passed') return;
      if (o && o.state === 'untried') return;
      if (spare.has(n.id)) return;
      if (p.title !== n.title || JSON.stringify(p.claim_refs) !== JSON.stringify(n.claim_refs)) return;
      n.trial = structuredClone(p.trial);
      carried += 1;
    });
  };
  if (accepted) carryFrom(accepted, new Set());
  const lf = work.last_failure;
  if (!accepted && lf && lf.kind === 'plan' && lf.from_version && Array.isArray(lf.leaves) && lf.leaves.length) {
    const rejected = work.nodes.plan.versions.find((v) => v.v === lf.from_version && v.state === 'rejected');
    if (rejected) carryFrom(rejected, new Set(lf.leaves));
  }
  if (!accepted) {
    const shelved = [...work.nodes.plan.versions].reverse().find((v) => v.state === 'shelved');
    if (shelved) carryFrom(shelved, new Set(work.plan_dirty && work.plan_dirty.leaves ? work.plan_dirty.leaves : []));
  }
  work.nodes.plan.draft = draft;
  work.nodes.plan.stale = false;
  return {
    state: work,
    result: {
      draft: true,
      leaves: planlib.collectLeaves(work.nodes.plan.draft).map((l) => ({ id: l.id, title: l.title, trial: l.trial.status })),
      carried,
      to_try: planlib.collectLeaves(work.nodes.plan.draft).filter((l) => l.trial.status !== 'passed').map((l) => l.id),
    },
    touched: ['plan'],
    agree_event: 'draft_generated',
    card_reply: `plan structure auto-generated; read-only trial required next (${carried} leaf trial(s) carried)`,
    reason: 'plan auto-generated',
  };
}

function claimAuthor(work, claimId) {
  const kind = claimKind(claimId);
  if (!kind || kind === 'idea') return null;
  const cur = currentAccepted(work.nodes[kind]);
  if (!cur || !claimIds(kind, cur.content).includes(claimId)) return null;
  return { kind, v: cur.v };
}

function recordIdenticalGaps(work, leaves, trialV) {
  const gapped = new Map();
  for (const leaf of leaves) {
    if (leaf.trial.status !== 'gap') continue;
    for (const claim of leaf.claim_refs || []) {
      const author = claimAuthor(work, claim);
      if (author) gapped.set(`${author.kind}:v${author.v}:${claim}`, { author, claim });
    }
  }
  const prev = work.identical_gaps || {};
  const next = {};
  let walk = null;
  for (const [key, g] of gapped) {
    const before = prev[key];
    const count = before && before.trial_v === trialV - 1 ? before.count + 1 : 1;
    next[key] = { author: g.author, claim: g.claim, count, trial_v: trialV };
    if (count >= 2 && (!walk || SPINE.indexOf(g.author.kind) < SPINE.indexOf(walk.author.kind))) walk = next[key];
  }
  work.identical_gaps = next;
  return walk;
}

function finishPlanTrial(work, content, event) {
  const { facts, ts, turn } = event;
  const node = work.nodes.plan;
  if (!node.draft) throw new ReduceError('no plan draft to try');
  const v = node.versions.length + 1;
  node.versions.push(version(v, facts.version_id, content, turn, ts, 'system'));
  node.draft = null;
  node.stale = false;
  node.reopened = false;
  if (work.last_failure && work.last_failure.kind === 'plan') work.last_failure = null;
  work.pending_validation = pendingValidation('plan', v, turn, facts.author || { seat: 'human', route: null });
  const leaves = planlib.collectLeaves(content.root);
  const kit = event.input && event.input.kit;
  const nothingTried = !kit || !kit.leaves || Object.keys(kit.leaves).length === 0;
  if (nothingTried && !facts.author && leaves.every((l) => !l.required || l.trial.status === 'passed')) {
    work.pending_validation.engine_closed = true;
  }
  const walk = recordIdenticalGaps(work, leaves, v);
  if (walk) {
    const why = `identical gap: claim ${walk.claim} of ${walk.author.kind} v${walk.author.v} gapped on trials ${v - 1} and ${v}`;
    node.versions.find((x) => x.v === v).state = 'rejected';
    work.pending_validation = null;
    failUp(work, walk.author.kind, why);
    return {
      state: work,
      result: { staged: { kind: 'plan', v }, identical_gap: walk, reopened: walk.author.kind, closed: planlib.planClosed(content) },
      touched: ['plan', walk.author.kind],
      agree_event: 'failed_up',
      card_reply: `plan v${v}: ${why}; ${walk.author.kind} reopened`,
      reason: why,
    };
  }
  const settled = leaves.filter((l) => planlib.isSettled(l.trial)).length;
  return {
    state: work,
    result: {
      staged: { kind: 'plan', v },
      leaves_settled: `${settled}/${leaves.length}`,
      decision: content.decision,
      summary: content.summary,
      closed: planlib.planClosed(content),
    },
    touched: ['plan'],
    agree_event: 'presented_for_validation',
    card_reply: `plan v${v} staged: ${settled}/${leaves.length} leaves settled; chose ${content.decision ? content.decision.chosen : 'nothing'} (${content.decision ? content.decision.basis : '-'})`,
    reason: 'plan trial executed',
  };
}

function finishExecute(work, submission, x, event) {
  const { facts, ts, turn } = event;
  const lock = work.execution || executionState(work);
  if (!lock.unlocked) throw new ReduceError('EXECUTION_UNLOCKED is false: ' + lock.reason);
  const plan = currentAccepted(work.nodes.plan);
  const byId = planlib.nodesById(plan.content.root);
  const leaves = [...new Set(submission.leaves)];
  for (const id of leaves) {
    const leaf = byId.get(id);
    if (!leaf || leaf.decomposes_into.length) throw new ReduceError('not a plan leaf: ' + id);
    const held = work.leaves[id] && work.leaves[id].executing;
    if (!held && !planlib.executable(leaf, work.leaves)) {
      throw new ReduceError(`leaf ${id} is not executable now (${planlib.leafState(leaf, work.leaves)})`);
    }
  }
  const branch = branchId(Object.keys(work.branches).length + 1);
  if (x.branch !== branch) throw new ReduceError(`branch ${x.branch} is not next (${branch})`);
  const author = facts.author || { seat: 'human', route: null };
  work.branches[branch] = { id: facts.branch_id, seat: 'builder', workspace: x.workspace, state: x.failed ? 'stale' : 'returned', opened_by_turn: turn, leaves };
  for (const id of leaves) if (work.leaves[id]) delete work.leaves[id].executing;
  if (x.failed) {
    const why = `execution tests failed on ${branch}: exit=${x.tests.exit_code} ${x.tests.output_tail.slice(-300)}`;
    reopenExecution(work, branch, why, turn);
    if (work.last_failure) {
      work.last_failure.failed_branch = branch;
      work.last_failure.tests = { exit_code: x.tests.exit_code, output_tail: String(x.tests.output_tail || '').slice(-2000) };
    }
    return {
      state: work,
      result: { tests: x.tests, branch, failed: true, reopened: leaves },
      touched: ['plan'],
      agree_event: 'failed_up',
      card_reply: `execution tests failed on ${branch}; leaves reopened: ${leaves.join(', ')}`,
      reason: 'execution tests failed',
    };
  }
  work.executions[branch] = {
    branch,
    leaves,
    main_file: submission.main_file,
    files: [...new Set([...Object.keys(submission.files), ...(x.build ? [submission.main_file] : [])])].sort(),
    artifact: x.artifact,
    tests: x.tests,
    ...(x.build ? { build: x.build } : {}),
    notes: submission.notes,
    workspace: x.workspace,
    base_versions: x.base_versions || baseVersions(work),
    author,
    authored_by: authorLabel(author),
    staged_by_turn: turn,
    ts,
    state: 'staged',
  };
  for (const id of leaves) work.leaves[id] = { ...(work.leaves[id] || {}), state: 'executing', execution: { branch, turn } };
  work.pending_validation = pendingValidation('execution', null, turn, author, { branch, leaves });
  if (work.last_failure && work.last_failure.kind === 'plan') work.last_failure = null;
  return {
    state: work,
    result: { staged: { kind: 'execution', branch }, leaves, tests: x.tests },
    touched: ['plan'],
    agree_event: 'presented_for_validation',
    card_reply: `execution ${branch} returned (${leaves.join(', ')}): ${x.tests.passed} passed, ${x.tests.failed} failed`,
    reason: 'leaves executed on branch',
  };
}

function nodeKindOf(work, kind) {
  if (kind === 'design') return 'design';
  if (kind === 'review') {
    const pv = work.pending_validation;
    return pv && KINDS.includes(pv.kind) ? pv.kind : 'plan';
  }
  return 'plan';
}

function applySeatDispatch(work, event) {
  const { facts, turn, ts } = event;
  if (work.pending_seat) throw new ReduceError('a seat is already working');
  if (work.pending_dispatch) throw new ReduceError('a dispatch is already staged');
  const kind = facts.kind;
  work.pending_dispatch = {
    dispatch_id: facts.dispatch_id,
    pull: facts.pull_ids || null,
    project_id: work.project.id,
    seat: facts.seat_name,
    kind,
    stage: facts.stage,
    route: facts.route,
    attempt: Number(facts.attempts || 0),
    base_versions: facts.base_versions,
    context_hash: facts.context_hash,
    frontier: facts.frontier,
    superdoc: facts.superdoc,
    result_schema: facts.result_schema,
    permissions: facts.permissions,
    timeout_ms: facts.timeout_ms,
    review: facts.review || null,
    leaves: facts.leaves || null,
    staged_by_turn: turn,
    ts,
  };
  return {
    state: work,
    result: {
      staged_dispatch: { dispatch_id: facts.dispatch_id, seat: facts.seat_name, kind, route: facts.route, context_hash: facts.context_hash, ...(facts.leaves ? { leaves: facts.leaves } : {}) },
      prefix: facts.superdoc.prefix,
    },
    touched: [nodeKindOf(work, kind)],
    agree_event: 'dispatch_staged',
    card_reply: null,
    reason: 'seat dispatch staged ' + kind,
  };
}

function applyRedispatch(work, event) {
  const { ts, turn } = event;
  const pr = work.pending_redispatch;
  if (!pr) throw new ReduceError('no redispatch is pending');
  if (work.pending_dispatch || work.pending_seat) throw new ReduceError('a dispatch is already staged or in flight');
  if (Date.parse(ts) < Date.parse(pr.due_at)) throw new ReduceError(`backoff not elapsed: due ${pr.due_at}`);
  const d = work.dispatches[pr.dispatch_id];
  if (!d) throw new ReduceError('unknown dispatch ' + pr.dispatch_id);
  work.pending_dispatch = {
    dispatch_id: d.dispatch_id,
    project_id: work.project.id,
    seat: d.seat,
    kind: d.kind,
    stage: d.stage,
    route: pr.route,
    attempt: d.attempt,
    delivery_attempt: d.cards.length + 1,
    base_versions: d.base_versions,
    context_hash: d.context_hash,
    frontier: d.frontier,
    superdoc: d.superdoc,
    result_schema: d.result_schema,
    permissions: d.permissions || {},
    timeout_ms: d.timeout_ms,
    review: d.review || null,
    leaves: d.leaves || null,
    staged_by_turn: turn,
    ts,
  };
  work.pending_redispatch = null;
  return {
    state: work,
    result: { redispatched: { dispatch_id: d.dispatch_id, route: pr.route, delivery_attempt: d.cards.length + 1, after: pr.outcome } },
    touched: [nodeKindOf(work, d.kind)],
    agree_event: 'redispatch_staged',
    card_reply: null,
    reason: `redispatch of ${d.dispatch_id} on ${pr.route} after ${pr.outcome}`,
  };
}

function applyEgress(work, event) {
  const { facts, turn, ts } = event;
  const pd = work.pending_dispatch;
  if (!pd) throw new ReduceError('no dispatch is staged');
  const binding = {
    card_id: facts.card_id,
    dispatch_id: pd.dispatch_id,
    project_id: work.project.id,
    turn: pd.staged_by_turn,
    egress_turn: turn,
    attempt: pd.attempt,
    seat: pd.seat,
    branch: pd.kind === 'execute' ? branchId(Object.keys(work.branches).length + 1) : null,
    route: pd.route,
    context_hash: pd.context_hash,
    base_versions: pd.base_versions,
    result_schema: pd.result_schema,
    created: ts,
  };
  work.cardbindings[facts.card_id] = binding;
  if (work.pending_pull && work.pending_pull.dispatch_id === pd.dispatch_id) work.pending_pull = null;
  const existing = work.dispatches[pd.dispatch_id] || { cards: [], outcomes: [] };
  work.dispatches[pd.dispatch_id] = {
    ...existing,
    dispatch_id: pd.dispatch_id,
    seat: pd.seat,
    kind: pd.kind,
    stage: pd.stage,
    route: pd.route,
    superdoc: pd.superdoc,
    context_hash: pd.context_hash,
    base_versions: pd.base_versions,
    result_schema: pd.result_schema,
    timeout_ms: pd.timeout_ms,
    permissions: pd.permissions,
    frontier: pd.frontier,
    review: pd.review || null,
    leaves: pd.leaves || null,
    attempt: pd.attempt,
    pull_ids: pd.pull || existing.pull_ids || null,
    cards: [...existing.cards, facts.card_id],
    first_sent: existing.first_sent || ts,
  };
  work.pending_seat = {
    seat: pd.seat,
    kind: pd.kind,
    card_id: facts.card_id,
    dispatch_id: pd.dispatch_id,
    route: pd.route,
    dispatched_by_turn: turn,
    attempts: pd.attempt,
    context_hash: pd.context_hash,
    base_versions: pd.base_versions,
    review: pd.review || null,
    leaves: pd.leaves || null,
    sent_ts: ts,
  };
  if (pd.kind === 'execute') {
    for (const id of pd.leaves || []) work.leaves[id] = { ...(work.leaves[id] || {}), executing: pd.dispatch_id };
  }
  work.pending_dispatch = null;
  return {
    state: work,
    result: { dispatched: { seat: pd.seat, kind: pd.kind, card: facts.card_id, route: pd.route }, guards: facts.guards },
    touched: [nodeKindOf(work, pd.kind)],
    agree_event: 'seat_dispatched',
    card_reply: null,
    reason: 'egress ' + pd.kind,
  };
}

function releaseHeldLeaves(work, ps) {
  if (!ps || ps.kind !== 'execute') return;
  for (const id of ps.leaves || []) {
    if (work.leaves[id]) {
      delete work.leaves[id].executing;
      if (!work.leaves[id].state) delete work.leaves[id];
    }
  }
}

function applyEgressRefused(work, event) {
  const { facts, turn, ts } = event;
  const pd = work.pending_dispatch;
  work.last_egress_refusal = { guard: facts.guard, reason: facts.reason, turn, ts, seq: event.seq, route: pd ? pd.route : null, dispatch_id: pd ? pd.dispatch_id : null };
  work.pending_dispatch = null;
  if (facts.guard === 'route_ready' || facts.guard === 'route_allowlist') {
    const route = (pd && pd.route) || 'unconfigured';
    const outcome = facts.guard === 'route_allowlist' ? 'not_allowed' : 'not_ready';
    work.gate = {
      id: 'ROUTE_ATTENTION', opened_by_turn: turn, route, outcome, seat: pd ? pd.seat : null,
      def: gates.gateDef('ROUTE_ATTENTION', { outcome, route }),
    };
  } else if (facts.guard === 'prompt_budget') {
    work.gate = { id: 'BUDGET_GATE', opened_by_turn: turn, def: budgetGateDef(work) };
  }
  return {
    state: work,
    result: null,
    touched: [],
    agree_event: 'egress_refused',
    card_reply: null,
    reason: `egress refused by ${facts.guard}: ${facts.reason}`,
  };
}

function applyReopen(work, event) {
  const { input, turn } = event;
  const kind = input.kind;
  if (!KINDS.includes(kind)) throw new ReduceError('unknown node kind: ' + kind);
  const node = work.nodes[kind];
  const cur = currentAccepted(node);
  if (!cur) throw new ReduceError(kind + ' has no accepted version to reopen');
  node.reopened = true;
  node.draft = kind === 'plan' ? null : structuredClone(cur.content);
  const shelve = shelveRequest(work, kind, 'reopen');
  reopenEffects(work, kind);
  if (kind === 'plan') suspendExecution(work);
  staleWaivers(work, [kind]);
  const dropped = [];
  work.last_reopen = { kind, turn, dropped };
  return {
    state: work,
    result: { reopened: kind, dropped },
    shelve,
    touched: [kind],
    agree_event: 'reopened',
    card_reply: null,
    reason: 'reopen ' + kind,
  };
}

function applySeatResult(work, event) {
  const { input, facts, turn, ts } = event;
  const ps = work.pending_seat;
  if (!ps) throw new ReduceError('no seat is pending');
  if (input.card_id !== ps.card_id) {
    throw new ReduceError(`result card ${input.card_id} does not match pending ${ps.card_id}`);
  }
  const outcome = facts.schema && facts.schema.ok === false ? 'malformed' : (input.outcome || 'result');
  const dispatch = work.dispatches[ps.dispatch_id];
  if (dispatch) dispatch.outcomes.push({ outcome, card_id: input.card_id, turn, ts, detail: input.detail || null });
  const nodeKind = nodeKindOf(work, ps.kind);

  if (JSON.stringify(ps.base_versions) !== JSON.stringify(baseVersions(work))) {
    work.quarantine.push({ card_id: input.card_id, dispatch_id: ps.dispatch_id, reason: 'stale base versions', turn });
    releaseHeldLeaves(work, ps);
    work.pending_seat = null;
    healthFromOutcome(work, ps.route, outcome, ts);
    return {
      state: work,
      result: { discarded: true, reason: 'stale base versions' },
      touched: [nodeKind],
      agree_event: 'late_card_quarantined',
      card_reply: null,
      reason: 'late card quarantined',
    };
  }

  if (isTransportFailure(outcome)) {
    releaseHeldLeaves(work, ps);
    work.pending_seat = null;
    work.last_transport_failure = { outcome, route: ps.route, dispatch_id: ps.dispatch_id, card_id: input.card_id, detail: String(input.detail || ''), turn };
    const failures = dispatch ? dispatch.outcomes.filter((o) => isTransportFailure(o.outcome)).length : 1;
    healthFromOutcome(work, ps.route, outcome, ts);
    if (failures <= BACKOFF_MS.length) {
      const backoff = BACKOFF_MS[failures - 1];
      work.pending_redispatch = {
        dispatch_id: ps.dispatch_id, route: ps.route, outcome, failures, backoff_ms: backoff,
        due_at: new Date(Date.parse(ts) + backoff).toISOString(), decided_by_turn: turn,
      };
      return {
        state: work,
        result: { outcome, route: ps.route, redispatch: { due_at: work.pending_redispatch.due_at, backoff_ms: backoff, failures } },
        touched: [nodeKind],
        agree_event: 'transport_failure',
        card_reply: null,
        reason: `${outcome} on ${ps.route}; redispatch after ${backoff / 60000} min`,
      };
    }
    work.pending_redispatch = null;
    work.gate = {
      id: 'ROUTE_ATTENTION', opened_by_turn: turn, route: ps.route, dispatch_id: ps.dispatch_id, outcome,
      def: gates.gateDef('ROUTE_ATTENTION', { outcome, route: ps.route }),
    };
    return {
      state: work,
      result: { outcome, route: ps.route, gate: 'ROUTE_ATTENTION', failures },
      touched: [nodeKind],
      agree_event: 'route_attention',
      card_reply: null,
      reason: `${outcome} on ${ps.route} ${failures} times; route attention`,
    };
  }

  healthFromOutcome(work, ps.route, outcome, ts);

  const check = facts.schema;
  if (!check.ok) {
    const attempts = ps.attempts + 1;
    if (dispatch && dispatch.outcomes.length) {
      const last = dispatch.outcomes[dispatch.outcomes.length - 1];
      if (facts.raw != null) { last.raw = facts.raw; last.raw_cut = facts.raw_cut || null; }
      if (facts.normalizations) last.normalizations = facts.normalizations;
    }
    work.last_schema_reject = { input_type: ps.kind, errors: check.errors.slice(0, 5), turn, attempts, dispatch_id: ps.dispatch_id, raw: facts.raw != null ? facts.raw : null, raw_cut: facts.raw_cut || null };
    releaseHeldLeaves(work, ps);
    work.pending_seat = null;
    if (attempts >= 2) {
      work.interrupted = { cause: 'malformed', dispatch_id: ps.dispatch_id, turn, ts };
      work.gate = {
        id: 'HUMAN_ESCALATION', opened_by_turn: turn,
        def: gates.gateDef('HUMAN_ESCALATION', { cause: 'malformed' }),
      };
      work.last_failure = { kind: nodeKind, reason: `seat result malformed ${attempts} times on the same dispatch`, spine_index: 0 };
      return {
        state: work,
        result: { escalated: 'HUMAN_ESCALATION', interrupted: true, attempts },
        touched: [nodeKind],
        agree_event: 'human_gate',
        card_reply: null,
        reason: 'second malformed on the same dispatch',
      };
    }
    return {
      state: work,
      result: { schema_repair: true, attempts },
      touched: [nodeKind],
      agree_event: 'schema_repair',
      card_reply: null,
      reason: 'seat schema repair',
    };
  }
  if (work.last_schema_reject && work.last_schema_reject.input_type === ps.kind) {
    work.last_schema_reject = null;
  }
  work.pending_seat = null;
  if (ps.kind === 'review') return applyReviewDecision(work, event, ps);
  if (ps.kind === 'design') {
    const node = work.nodes.design;
    const v = node.versions.length + 1;
    node.versions.push(version(v, facts.version_id, input.result, turn, ts, 'seat'));
    node.stale = false;
    node.reopened = false;
    node.draft = null;
    openDesignReady(work, turn, v, facts.author || { seat: ps.seat, route: ps.route });
    if (work.last_failure && work.last_failure.kind === 'design') work.last_failure = null;
    return {
      state: work,
      result: { staged: { kind: 'design', v } },
      touched: ['design'],
      agree_event: 'gated_for_approval',
      card_reply: null,
      reason: `design v${v} proposed by the Leader seat`,
    };
  }
  const finished = ps.kind === 'plan_trial'
    ? finishPlanTrial(work, facts.content, event)
    : finishExecute(work, input.result, facts.execution, event);
  finished.card_reply = `[${ps.seat} seat via ${input.card_id}] ` + (finished.card_reply || '');
  return finished;
}

function reopenNamedLeavesOfRefs(work, ver, references) {
  if (!ver || !ver.content || !ver.content.root) return [];
  const ids = new Set(planlib.collectLeaves(ver.content.root).map((l) => l.id));
  return [...new Set((references || []).flatMap((r) => String(r).match(/L[0-9]+(?:\.[A-Za-z0-9]+)*/g) || []).filter((id) => ids.has(id)))];
}

function reopenNamedLeaves(work, references, reason, turn) {
  const plan = currentAccepted(work.nodes.plan);
  if (!plan) return [];
  const ids = new Set(planlib.collectLeaves(plan.content.root).map((l) => l.id));
  const named = [...new Set((references || []).flatMap((r) => String(r).match(/L[0-9]+(?:\.[A-Za-z0-9]+)*/g) || []).filter((id) => ids.has(id)))];
  if (!named.length) return [];
  const branches = new Set(named.map((id) => (work.leaves[id] && work.leaves[id].execution ? work.leaves[id].execution.branch : null)).filter(Boolean));
  for (const id of named) {
    const prev = work.leaves[id] || {};
    work.leaves[id] = { state: 'gap', execution: { branch: prev.execution ? prev.execution.branch : null, turn, failed: true }, attempts: (prev.attempts || 0) + 1 };
  }
  work.last_failure = { kind: 'plan', reason: String(reason || '').slice(0, 400), spine_index: SPINE.indexOf('plan'), leaves: named };
  if (branches.size === 1) {
    const [branch] = branches;
    const ex = work.executions[branch];
    if (ex && ex.tests) {
      work.last_failure.failed_branch = branch;
      work.last_failure.tests = { exit_code: ex.tests.exit_code, output_tail: String(ex.tests.output_tail || '').slice(-2000) };
    }
  }
  return named;
}

function applyReviewDecision(work, event, ps) {
  const { input, facts, turn, ts } = event;
  const pv = work.pending_validation;
  if (!pv) throw new ReduceError('no result is under review');
  const decision = input.result.decision;
  const references = input.result.references || [];
  const notes = String(input.result.notes || '');
  const review = ps.review || {};
  const isExecution = pv.kind === 'execution';
  const isClosure = pv.kind === 'closure';
  const node = KINDS.includes(pv.kind) ? work.nodes[pv.kind] : null;
  const ver = node ? node.versions.find((x) => x.v === pv.v) : null;
  if (node && (!ver || ver.state !== 'staged')) throw new ReduceError(`staged version gone: ${pv.kind} v${pv.v}`);
  if (isExecution && !(work.executions[pv.branch] && work.executions[pv.branch].state === 'staged')) throw new ReduceError(`staged execution gone: ${pv.branch}`);
  if (isClosure && !(work.closure && work.closure.state === 'staged')) throw new ReduceError('staged closure gone');
  const subject = isExecution ? { kind: 'execution', branch: pv.branch, leaves: work.executions[pv.branch].leaves }
    : isClosure ? { kind: 'closure', steps: work.closure.steps.length }
      : { kind: pv.kind, v: pv.v };
  const record = {
    id: facts.review_id,
    turn,
    subject,
    author: { turn: pv.staged_by_turn, seat: pv.author ? pv.author.seat : 'human', route: pv.author ? pv.author.route : null, dispatch_id: pv.author ? pv.author.dispatch_id || null : null },
    reviewer: {
      seat: 'reviewer', route: ps.route, rung: review.rung, context: 'fresh',
      author_reasoning_supplied: false, dispatch_id: ps.dispatch_id, card_id: input.card_id,
    },
    decision,
    references,
    notes,
    earliest_repair: input.result.earliest_repair || null,
    ts,
  };
  work.reviews.push(record);
  if (decision === 'accept' && pv.kind === 'plan') {
    const closed = planlib.planClosed(ver.content);
    if (!closed.ok) {
      record.decision = 'gap';
      record.notes = 'reviewer accepted an incomplete trial; the engine refused: ' + closed.reason;
      record.references = planlib.collectLeaves(ver.content.root).filter((l) => l.trial.status !== 'passed').map((l) => l.id);
      ver.state = 'rejected';
      work.pending_validation = null;
      failUp(work, 'plan', 'plan trial incomplete: ' + closed.reason);
      work.last_failure.leaves = record.references.slice();
      work.last_failure.from_version = record.references.length ? ver.v : null;
      return {
        state: work,
        result: { review: 'gap', reopened: 'plan', references: record.references },
        touched: ['plan'],
        agree_event: 'review_gap',
        card_reply: null,
        reason: 'plan trial incomplete: ' + closed.reason,
      };
    }
  }
  if (decision === 'accept') {
    if (pv.staged_by_turn === turn) throw new ReduceError('a turn cannot accept its own staging');
    work.pending_validation = null;
    if (isExecution) {
      const out = applyMerge(work, facts.merge, turn, record.id);
      return {
        state: work,
        result: { accepted: { kind: 'execution', branch: pv.branch }, review: record.id, rung: review.rung, done: subject.leaves },
        accepts_execution: pv.branch,
        merge: out.merge,
        promote: out.promote,
        touched: ['plan'],
        agree_event: 'review_accepted',
        card_reply: null,
        reason: `review rung ${review.rung} accepted execution ${pv.branch}`,
      };
    }
    if (isClosure) {
      const out = acceptClosure(work, event, { seat: 'reviewer', rung: review.rung, review_id: record.id });
      out.result.review = record.id;
      out.reason = `review rung ${review.rung} accepted the final closure`;
      return out;
    }
    const previous = node.versions.filter((x) => x.state === 'accepted' && x.v < ver.v).at(-1) || null;
    ver.state = 'accepted';
    ver.accepted_by_turn = turn;
    ver.accepted_by = 'reviewer';
    node.stale = false;
    node.reopened = false;
    const dropped = pv.kind === 'plan' ? [] : dropDown(work, pv.kind, previous ? previous.content : null, ver.content).leaves;
    let closure = null;
    if (pv.kind === 'plan') closure = afterPlanAccepted(work, event, pv.v);
    return {
      state: work,
      result: { accepted: { kind: pv.kind, v: pv.v }, review: record.id, rung: review.rung, dropped, ...(closure ? { closure_proof: closure } : {}) },
      accepts: { kind: pv.kind, v: pv.v },
      touched: [pv.kind, ...(closure && !closure.all_ok ? [closure.responsible] : [])],
      agree_event: closure && !closure.all_ok ? 'closure_proof_failed' : 'review_accepted',
      card_reply: null,
      reason: `review rung ${review.rung} accepted ${pv.kind} v${pv.v}` + (closure ? `; closure proof ${closure.all_ok ? 'passed' : 'failed'}` : ''),
    };
  }
  if (decision === 'gap' || decision === 'conflict') {
    const subjectKind = isExecution || isClosure ? 'plan' : pv.kind;
    let target = KINDS.includes(input.result.earliest_repair) ? input.result.earliest_repair : subjectKind;
    let author = authoredByOf(work, target);
    if (author === null) { target = subjectKind; author = authoredByOf(work, target) || 'system'; }
    if (author === 'human') {
      const key = findingKey(target, references, notes);
      const seen = (work.node_stands || {})[key] || 0;
      const cause = `review ${decision} named ${target}${seen ? ` (the same finding returned ${seen} time${seen === 1 ? '' : 's'} before)` : ''}: ${notes}`.slice(0, 160);
      work.gate = {
        id: 'HUMAN_ESCALATION', opened_by_turn: turn, target, finding_key: key, count: seen + 1,
        def: gates.gateDef('HUMAN_ESCALATION', { cause, target }),
      };
      return {
        state: work,
        result: { review: decision, escalated: 'HUMAN_ESCALATION', target, reopened: null, references },
        touched: [subjectKind],
        agree_event: 'human_gate',
        card_reply: null,
        reason: `review ${decision} names human-authored ${target}; escalated, nothing reopened`,
      };
    }
    work.pending_validation = null;
    const why = `review ${decision}: ${notes}`.slice(0, 400);
    if (isExecution && target === 'plan') {
      const leaves = reopenExecution(work, pv.branch, why, turn);
      return {
        state: work,
        result: { review: decision, reopened: leaves, references },
        touched: ['plan'],
        agree_event: 'review_' + decision,
        card_reply: null,
        reason: `review ${decision}; leaves reopened: ${leaves.join(', ')}`,
      };
    }
    if (isClosure && target === 'plan') {
      work.closure = null;
      const named = reopenNamedLeaves(work, references, why, turn);
      if (!named.length) failUp(work, 'plan', why);
      return {
        state: work,
        result: { review: decision, reopened: named.length ? named : 'plan', references },
        touched: ['plan'],
        agree_event: 'review_' + decision,
        card_reply: null,
        reason: `closure review ${decision}; ${named.length ? 'leaves reopened: ' + named.join(', ') : 'plan reopened'}`,
      };
    }
    if (isExecution) reopenExecution(work, pv.branch, why, turn);
    if (isClosure) work.closure = null;
    if (ver) ver.state = 'rejected';
    failUp(work, target, why);
    if (target === 'plan' && ver && pv.kind === 'plan') {
      const ids = new Set(planlib.collectLeaves(ver.content.root).map((l) => l.id));
      const named = [...new Set((references || []).flatMap((r) => String(r).match(/L[0-9]+(?:\.[A-Za-z0-9]+)*/g) || []).filter((id) => ids.has(id)))];
      const gapped = planlib.collectLeaves(ver.content.root).filter((l) => l.trial && l.trial.status !== 'passed').map((l) => l.id);
      work.last_failure.leaves = [...new Set([...named, ...gapped])];
      work.last_failure.from_version = named.length ? ver.v : null;
    }
    return {
      state: work,
      result: { review: decision, reopened: target, references },
      touched: [subjectKind, target],
      agree_event: 'review_' + decision,
      card_reply: null,
      reason: `review ${decision}; ${target} reopened for earliest repair`,
    };
  }
  work.gate = {
    id: 'HUMAN_ESCALATION', opened_by_turn: turn,
    def: gates.gateDef('HUMAN_ESCALATION', { cause: ('review needs_human: ' + notes).slice(0, 120) }),
  };
  return {
    state: work,
    result: { review: 'needs_human', references },
    touched: [isExecution || isClosure ? 'plan' : pv.kind],
    agree_event: 'human_gate',
    card_reply: null,
    reason: 'review needs_human',
  };
}

function applyFinalize(work, event) {
  const { facts, ts, turn } = event;
  const plan = currentAccepted(work.nodes.plan);
  if (!plan || !planlib.allRequiredDone(plan.content, work.leaves) || !work.main) {
    throw new ReduceError('finalize needs every required leaf done on main');
  }
  const proof = facts.proof;
  if (!proof.all_ok) {
    const firstBad = proof.steps.find((s) => !s.ok);
    const responsible = proof.responsible || 'plan';
    work.closure = null;
    let reopened;
    if (responsible === 'execution') {
      const branches = proof.failed_branches && proof.failed_branches.length ? proof.failed_branches : (work.main ? work.main.merged.slice(-1) : []);
      reopened = [];
      for (const branch of branches) {
        const ex = work.executions[branch];
        if (ex) ex.state = 'stale';
        const b = work.branches[branch];
        if (b) b.state = 'stale';
        for (const id of ex ? ex.leaves : []) {
          const prev = work.leaves[id] || {};
          work.leaves[id] = { state: 'gap', execution: { branch, turn, failed: true }, attempts: (prev.attempts || 0) + 1 };
          reopened.push(id);
        }
      }
      work.last_failure = { kind: 'plan', reason: 'final closure failed: ' + (firstBad ? firstBad.detail : ''), spine_index: SPINE.indexOf('plan'), leaves: reopened };
    } else {
      failUp(work, responsible, 'final closure failed: ' + (firstBad ? firstBad.detail : ''));
      reopened = responsible;
    }
    return {
      state: work,
      result: { proof: { steps: proof.steps, all_ok: false }, failed: true, reopened },
      touched: ['plan', ...(typeof reopened === 'string' ? [reopened] : [])],
      agree_event: 'failed_up',
      card_reply: `final closure failed at ${firstBad ? firstBad.from + '->' + firstBad.to : '?'}; ${typeof reopened === 'string' ? reopened + ' reopened' : 'leaves reopened: ' + reopened.join(', ')}`,
      reason: 'final closure failed',
    };
  }
  for (const leaf of planlib.collectLeaves(plan.content.root)) {
    if (planlib.engineOwned(leaf) && leaf.required) work.leaves[leaf.id] = { state: 'done', execution: { branch: 'closure', turn } };
  }
  work.closure = {
    state: 'staged',
    steps: proof.steps,
    all_ok: true,
    artifact: proof.artifact,
    reruns: proof.reruns || [],
    plan_v: plan.v,
    walked_by_turn: turn,
    ts,
  };
  work.pending_validation = pendingValidation('closure', null, turn, { seat: 'system', route: null });
  return {
    state: work,
    result: { staged: { kind: 'closure' }, proof_steps: proof.steps.length },
    touched: ['plan'],
    agree_event: 'presented_for_validation',
    card_reply: `final closure walked ${proof.steps.length} steps, all ok; awaiting the Reviewer`,
    reason: 'final closure walked',
  };
}

function acceptClosure(work, event, by) {
  const { turn, ts } = event;
  if (!work.closure || work.closure.state !== 'staged') throw new ReduceError('no staged closure');
  work.closure.state = 'accepted';
  work.closure.accepted_by_turn = turn;
  work.closure.accepted_by = by;
  work.closure.accepted_ts = ts;
  work.pending_validation = null;
  return {
    state: work,
    result: { accepted: { kind: 'closure' } },
    accepts_closure: true,
    touched: ['plan'],
    agree_event: 'closure_accepted',
    card_reply: 'final closure accepted',
    reason: 'closure accepted',
  };
}

function applyProjectDone(work, event) {
  if (!work.closure || work.closure.state !== 'accepted') throw new ReduceError('PROJECT_DONE needs an accepted final closure');
  if (work.project_done) throw new ReduceError('PROJECT_DONE already recorded');
  work.project_done = { turn: event.turn, ts: event.ts, closure_plan_v: work.closure.plan_v, artifact: work.artifact ? work.artifact.product_link : null };
  return {
    state: work,
    result: { project_done: true, artifact: work.artifact ? work.artifact.product_link : null },
    touched: [],
    agree_event: 'project_done',
    card_reply: 'PROJECT_DONE: ' + (work.artifact ? work.artifact.product_link : ''),
    reason: 'PROJECT_DONE',
  };
}

function applyRecover(work) {
  work.stopped = false;
  work.gate = null;
  return {
    state: work,
    result: { recovered: true },
    touched: [],
    agree_event: 'recovered',
    card_reply: 'recovered from stop',
    reason: 'recover',
  };
}

function applyTurn(work, event) {
  const type = event.input.type;
  switch (type) {
    case 'spool': return applySpool(event);
    case 'prompt': return applyPrompt(work, event);
    case 'form': return applyForm(work, event);
    case 'validate': return applyValidate(work, event);
    case 'gate': return applyGate(work, event);
    case 'plan_generate': return applyPlanGenerate(work);
    case 'plan_trial': return finishPlanTrial(work, event.facts.content, event);
    case 'execute': return finishExecute(work, event.input.submission, event.facts.execution, event);
    case 'seat_dispatch': return applySeatDispatch(work, event);
    case 'redispatch': return applyRedispatch(work, event);
    case 'egress': return applyEgress(work, event);
    case 'seat_result': return applySeatResult(work, event);
    case 'reopen': return applyReopen(work, event);
    case 'seat_assignment': return applySeatAssignment(work, event);
    case 'budget_set': return applyBudgetSet(work, event);
    case 'finalize': return applyFinalize(work, event);
    case 'project_done': return applyProjectDone(work, event);
    case 'recover': return applyRecover(work);
    default: throw new ReduceError('unknown input type: ' + type);
  }
}

function budgetGateDef(state) {
  const def = gates.gateDef('BUDGET_GATE');
  return state.controls_version ? def : {
    ...def, kind: 'spec', transitions: def.transitions.map((step, i) => i === 1 ? 'Reopen Spec' : step),
  };
}

function applyBudgetGated(work, event) {
  work.gate = { id: 'BUDGET_GATE', opened_by_turn: event.turn, def: budgetGateDef(work) };
  return {
    state: work,
    result: null,
    touched: [],
    agree_event: 'human_gate',
    card_reply: 'gated: BUDGET_GATE',
    reason: 'budget window exhausted; gated',
  };
}

function applyErrorGated(work, event) {
  const cause = String(event.facts.error || 'error').slice(0, 200);
  releaseHeldLeaves(work, work.pending_seat);
  work.pending_seat = null;
  work.gate = {
    id: 'HUMAN_ESCALATION', opened_by_turn: event.turn,
    def: gates.gateDef('HUMAN_ESCALATION', { cause }),
  };
  work.last_failure = work.last_failure || {
    kind: event.facts.responsible || 'idea', reason: cause, spine_index: 0,
  };
  return {
    state: work,
    result: null,
    touched: [],
    agree_event: 'human_gate',
    card_reply: 'escalated to HUMAN_ESCALATION: ' + cause,
    reason: 'no useful result: ' + cause,
  };
}

function applySchemaReject(work, event) {
  work.last_schema_reject = {
    input_type: event.input.type, errors: event.facts.errors.slice(0, 5), turn: event.turn,
  };
  return {
    state: work,
    result: null,
    touched: [],
    agree_event: 'schema_reject',
    card_reply: 'schema reject: ' + event.facts.errors[0],
    reason: 'schema reject',
  };
}

function applyRecovery(work, event) {
  const action = event.input.action;
  gates.assertLegal('RECOVERY_REQUIRED', action);
  let detail = '';
  if (action === 'RETRY') {
    releaseHeldLeaves(work, work.pending_seat);
    work.pending_seat = null;
    detail = 'redispatch';
  } else if (action === 'RESUME') {
    detail = 'continue';
  } else if (action === 'DISCARD_LATE') {
    if (work.pending_seat) {
      work.quarantine.push({ card_id: work.pending_seat.card_id, seat: work.pending_seat.seat, turn: event.turn });
      releaseHeldLeaves(work, work.pending_seat);
      work.pending_seat = null;
    }
    detail = 'late card quarantined';
  } else if (action === 'STOP') {
    work.stopped = true;
    detail = 'paused';
  }
  work.last_recovery = { action, turn: event.turn, ts: event.ts, residue: event.facts.residue, reconciled: event.facts.reconciled || [] };
  return {
    state: work,
    result: { recovered: true, action, detail },
    touched: [],
    agree_event: 'recovery_' + action.toLowerCase(),
    card_reply: 'recovery: ' + action,
    reason: 'recovery ' + action,
  };
}

function finishEvent(next, event, outcome) {
  next.seq = event.seq;
  next.turns.last_id = turnNumberOf(event);
  next.turns.last_event = event.id;
  next.last_event_type = event.type === 'turn' ? event.input.type : event.type;
  if (event.type === 'turn' && event.input.type === 'egress') {
    const ps = next.pending_seat;
    next.budget.dispatches.push({ ts: event.ts, dispatch_id: ps ? ps.dispatch_id : null, card_id: event.facts.card_id, seat: ps ? ps.seat : null });
  }
  if (event.type === 'turn' && event.input.type === 'seat_result' && event.input.outcome === 'refused') {
    next.budget.dispatches = next.budget.dispatches.filter((d) => d.card_id !== event.input.card_id);
  }
  settleBudget(next, event.ts);
  if (event.type === 'turn' && next.last_schema_reject && next.last_schema_reject.input_type === event.input.type) {
    next.last_schema_reject = null;
  }
  next.last_touched = outcome.touched || [];
  for (const kind of KINDS) next.nodes[kind].open = false;
  next.status = derivedStatus(next);
  next.wheel = { ...(next.wheel || {}), phase: derivedPhase(next) };
  next.execution = executionState(next);
  next.frontier = resolve(next);
}

function reduce(state, event) {
  const work = state ? structuredClone(state) : null;
  // Upgrade operational controls on the first new event; historical events retain their old semantics.
  if (work && event.controls_version && !work.controls_version) {
    work.controls_version = 1;
    work.routes = { solo: new Set(Object.values(work.seats).map(s => s.route)).size === 1 };
  }
  let outcome;
  switch (event.type) {
    case 'turn':
      outcome = applyTurn(work, event);
      break;
    case 'budget_gated':
      outcome = applyBudgetGated(work, event);
      break;
    case 'error_gated':
      outcome = applyErrorGated(work, event);
      break;
    case 'schema_reject':
      outcome = applySchemaReject(work, event);
      break;
    case 'egress_refused':
      outcome = applyEgressRefused(work, event);
      break;
    case 'shelved':
      outcome = applyShelved(work, event);
      break;
    case 'pull_requested':
      outcome = applyPullRequested(work, event);
      break;
    case 'pull_refused':
      outcome = applyPullRefused(work, event);
      break;
    case 'budget_admit':
      if (!work.gate || work.gate.id !== 'BUDGET_GATE' || !work.gate.waiting) throw new ReduceError('no waiting budget gate');
      if (budgetExhausted(work, event.ts)) throw new ReduceError('the window does not admit a dispatch yet');
      work.gate = null;
      outcome = { state: work, result: { admitted: true }, touched: [], agree_event: 'budget_admitted', card_reply: null, reason: 'window admits a dispatch' };
      break;
    case 'recovery':
      outcome = applyRecovery(work, event);
      break;
    default:
      throw new ReduceError('unknown event type: ' + event.type);
  }
  finishEvent(outcome.state, event, outcome);
  return outcome;
}

function replay(events) {
  let state = null;
  for (const event of events) state = reduce(state, event).state;
  return state;
}

module.exports = {
  reduce, replay, ReduceError, derivedStatus, derivedPhase, budgetUsed, budgetExhausted, dispatchesInWindow,
  executionState, nodeKindOf, seatKeyOf,
  BUDGET_LIMITS, SCALE, WINDOW_MS, SCHEMA_VERSION, AUTHORS, DEFAULT_SEATS,
};
