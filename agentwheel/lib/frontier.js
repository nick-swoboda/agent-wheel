'use strict';

const { SPINE } = require('./traversal');
const { currentAccepted } = require('./nodes');
const planlib = require('./plan');

function isCurrent(node) {
  if (!node) return false;
  if (node.reopened || node.stale) return false;
  return currentAccepted(node) != null;
}

function planStage(state) {
  const plan = currentAccepted(state.nodes.plan);
  if (!plan) return 'plan';
  if (state.plan_dirty || Object.values(state.leaves || {}).some((o) => o.state === 'untried')) return 'plan';
  if (!planlib.allRequiredDone(plan.content, state.leaves || {})) return 'execution';
  if (!(state.closure && state.closure.state === 'accepted' && state.project_done)) return 'closure';
  return 'done_complete';
}

function nodeOf(stage) {
  if (SPINE.includes(stage)) return stage;
  if (stage === 'execution' || stage === 'closure') return 'plan';
  return null;
}

function nextLeaves(state) {
  const plan = currentAccepted(state.nodes.plan);
  if (!plan || state.nodes.plan.stale || state.nodes.plan.reopened) return [];
  return planlib.nextExecutionGroup(plan.content, state.leaves || {});
}

// opts.recovery: crash residue is pending the human's RECOVERY_REQUIRED action; only that gate is legal.
function resolve(state, opts) {
  const recovery = Boolean(opts && opts.recovery);
  if (!state) {
    return {
      blockers: recovery ? ['recovery'] : [],
      stage: 'unspooled',
      prompt_touched: [],
      stale: [],
      leaves: [],
      dependencies: [],
      branch_results: [],
      next_legal: recovery ? ['gate'] : ['spool'],
      current_nodes: [],
    };
  }

  let stage = null;
  for (const kind of SPINE) {
    if (!isCurrent(state.nodes[kind])) { stage = kind; break; }
  }
  if (!stage) stage = planStage(state);

  const blockers = [];
  if (recovery) blockers.push('recovery');
  if (stage === 'execution' && state.execution && !state.execution.unlocked && state.execution.reason) {
    blockers.push('execution_locked: ' + state.execution.reason);
  }
  if (state.status === 'red') blockers.push(state.interrupted ? 'interrupted:' + state.interrupted.cause : 'paused');
  if (state.gate) blockers.push('gate:' + state.gate.id);

  const prompt_touched = state.last_touched || [];

  const stale = SPINE.filter(
    (k) => state.nodes[k] && (state.nodes[k].stale || state.nodes[k].reopened)
  );

  const leaves = stage === 'execution' ? nextLeaves(state) : [];

  const dependencies = [];
  const stageNode = nodeOf(stage);
  if (stageNode) {
    for (const kind of SPINE.slice(0, SPINE.indexOf(stageNode))) {
      if (!isCurrent(state.nodes[kind])) dependencies.push(kind);
    }
  }

  const branch_results = Object.entries(state.branches || {})
    .filter(([, b]) => b.state === 'returned')
    .map(([id]) => id);

  let next_legal;
  if (recovery) {
    next_legal = ['gate'];
  } else if (state.status === 'red' && !(state.interrupted && state.gate)) {
    next_legal = ['recover'];
  } else if (state.gate) {
    next_legal = state.gate.id === 'BUDGET_GATE' && state.gate.waiting ? ['gate', 'budget_admit'] : ['gate'];
  } else if (state.pending_dispatch) {
    next_legal = ['egress'];
  } else if (state.pending_seat) {
    // A dispatched seat is working; the only legal continuation is its result card coming back.
    next_legal = ['seat_result'];
  } else if (state.pending_pull) {
    next_legal = ['seat_dispatch'];
  } else if (state.pending_redispatch) {
    next_legal = ['redispatch'];
  } else if (state.pending_validation) {
    const pv = state.pending_validation;
    const author = pv.author;
    const subjectKind = SPINE.includes(pv.kind) ? pv.kind : 'plan';
    const above = stale.filter((k) => SPINE.indexOf(k) < SPINE.indexOf(subjectKind));
    if (above.length) next_legal = legalForKind(state, above[0]);
    else next_legal = author && author.seat !== 'human' && !pv.engine_closed ? ['seat_dispatch'] : ['validate'];
  } else if (state.status === 'purple') {
    next_legal = [];
  } else {
    const target = stale.length > 0 ? stale[0] : stage;
    next_legal = legalForKind(state, target);
  }
  const reopenable = SPINE.some((k) => currentAccepted(state.nodes[k]));
  if (reopenable && !recovery && state.status !== 'red' && !state.gate && !state.pending_validation) {
    next_legal.push('reopen');
  }

  const current_nodes = [...new Set([stageNode, ...stale, ...prompt_touched])].filter(
    (k) => SPINE.includes(k)
  );

  return {
    blockers, stage, prompt_touched, stale, leaves, dependencies,
    branch_results, next_legal, current_nodes,
  };
}

function legalForKind(state, kind) {
  switch (kind) {
    case 'idea': return ['prompt', 'form:idea'];
    case 'experience': return ['form:experience'];
    case 'design': return ['form:design', 'seat_dispatch'];
    case 'spec': return ['form:spec'];
    case 'plan': {
      const draft = state.nodes.plan && state.nodes.plan.draft;
      if (!draft) return ['plan_generate'];
      const toTry = planlib.collectLeaves(draft).some((l) => l.trial.status !== 'passed');
      return toTry ? ['seat_dispatch', 'plan_trial'] : ['plan_trial'];
    }
    case 'execution':
      return state.execution && state.execution.unlocked && nextLeaves(state).length ? ['seat_dispatch', 'execute'] : [];
    case 'closure':
      if (state.closure && state.closure.state === 'accepted') return state.project_done ? [] : ['project_done'];
      return state.closure ? [] : ['finalize'];
    default: return [];
  }
}

module.exports = { resolve, isCurrent, planStage, nodeOf, nextLeaves };
