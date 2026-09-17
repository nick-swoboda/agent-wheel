'use strict';

const { resolve } = require('./frontier');
const { normalizedFrontier } = require('./compile');
const { POLICY } = require('./broker');
const { budgetExhausted } = require('./reducers');
const { ROUTE_IDS } = require('./schema');
const { KINDS } = require('./schema');
const { baseVersions } = require('./nodes');

const GUARDS = [
  'project_seat_identity',
  'legal_stage_phase',
  'frozen_base_versions',
  'drop_down_complete',
  'frontier_rebuilt',
  'look2_fresh',
  'route_allowlist',
  'route_ready',
  'route_capacity',
  'prompt_budget',
  'gate_authority',
  'write_tool_scope',
  'sealed_super_document',
  'card_binding',
];

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function runGuards(state, pending, look2, ctx) {
  const checked = [];
  // `code` is diagnostic only, and rides to the audit; the refusal event and gate text keep the sentence.
  const fail = (guard, reason, code) => ({ ok: false, guard, reason, code: code || null, checked });
  const pass = (guard) => checked.push(guard);

  if (!pending || pending.project_id !== state.project.id) return fail('project_seat_identity', 'dispatch does not belong to this project');
  if (!['leader', 'builder', 'reviewer', 'plan_trial'].includes(pending.seat)) {
    return fail('project_seat_identity', 'unknown seat ' + pending.seat);
  }
  pass('project_seat_identity');

  if (state.stopped) return fail('legal_stage_phase', 'project is paused');
  if (state.status === 'purple') return fail('legal_stage_phase', 'project is Done');
  if (state.pending_validation && pending.kind !== 'review') return fail('legal_stage_phase', 'a review is pending');
  if (state.pending_seat) return fail('legal_stage_phase', 'a seat is already working');
  const seatStages = ['design', 'plan', 'execution', 'closure'];
  if (pending.kind === 'review') {
    if (!(state.pending_validation && state.pending_validation.kind === pending.stage)) {
      return fail('legal_stage_phase', 'nothing is under review for ' + pending.stage);
    }
  } else if (!seatStages.includes(pending.stage)) {
    return fail('legal_stage_phase', 'no seat stage for ' + pending.stage);
  }
  if (pending.kind === 'execute' && !(state.execution && state.execution.unlocked)) {
    return fail('legal_stage_phase', 'EXECUTION_UNLOCKED is false: ' + (state.execution ? state.execution.reason : 'no plan'));
  }
  pass('legal_stage_phase');

  const nowBase = baseVersions(state);
  for (const kind of KINDS) {
    if (pending.base_versions[kind] !== nowBase[kind]) {
      return fail('frozen_base_versions', `${kind} was ${pending.base_versions[kind]} at staging, is ${nowBase[kind]} now`);
    }
  }
  pass('frozen_base_versions');

  const stageNode = KINDS.includes(pending.stage) ? pending.stage : null;
  const ancestors = stageNode ? KINDS.slice(0, KINDS.indexOf(stageNode)) : KINDS;
  for (const kind of ancestors) {
    const node = state.nodes[kind];
    if (node.stale || node.reopened) {
      return fail('drop_down_complete', `${kind} is ${node.stale ? 'stale' : 'reopened'}; drop-down has not settled`);
    }
  }
  pass('drop_down_complete');

  const rebuilt = normalizedFrontier(resolve(state));
  if (!sameJson(rebuilt, normalizedFrontier(pending.frontier))) {
    return fail('frontier_rebuilt', `frontier moved since staging: stage ${pending.frontier.stage} -> ${rebuilt.stage}`);
  }
  if (!sameJson(rebuilt, look2.frontier)) return fail('frontier_rebuilt', 'Look 2 frontier disagrees with the rebuilt frontier');
  pass('frontier_rebuilt');

  if (look2.hash !== pending.context_hash) {
    return fail('look2_fresh', `Super Document hash ${look2.hash.slice(0, 12)} differs from staged ${pending.context_hash.slice(0, 12)}`);
  }
  pass('look2_fresh');

  if (!pending.route) return fail('route_allowlist', 'no route is assigned to the seat');
  if (!ROUTE_IDS.includes(pending.route)) {
    return fail('route_allowlist', `${pending.route} is not a registered route`);
  }
  pass('route_allowlist');

  // 8. exact route readiness: no silent fallback
  if (!ctx.route) return fail('route_ready', `route ${pending.route} is not configured`);
  if (!ctx.readiness || !ctx.readiness.ready) {
    return fail('route_ready', `${pending.route}: ${(ctx.readiness && ctx.readiness.reason) || 'not ready'}`,
      ctx.readiness && ctx.readiness.code);
  }
  pass('route_ready');

  if (!ctx.capacity || !ctx.capacity.ok) return fail('route_capacity', (ctx.capacity && ctx.capacity.reason) || 'no capacity');
  pass('route_capacity');

  if (budgetExhausted(state, look2.ts)) return fail('prompt_budget', 'the prompt budget for this window is spent');
  pass('prompt_budget');

  if (state.gate) return fail('gate_authority', `gate ${state.gate.id} is open`);
  pass('gate_authority');

  const grants = pending.permissions || {};
  const policy = POLICY[pending.seat] || {};
  for (const [tool, scope] of Object.entries(grants)) {
    if (policy[tool] !== scope) return fail('write_tool_scope', `${pending.seat} claims ${tool}:${scope} beyond the broker policy`);
  }
  pass('write_tool_scope');

  if (!pending.context_hash || look2.sealed.hash !== pending.context_hash) {
    return fail('sealed_super_document', 'the sealed document does not carry the staged hash');
  }
  pass('sealed_super_document');

  const binding = ctx.binding;
  const required = ['project_id', 'turn', 'attempt', 'seat', 'route', 'context_hash', 'base_versions', 'result_schema'];
  for (const key of required) {
    if (binding == null || binding[key] == null) return fail('card_binding', 'CardBinding lacks ' + key);
  }
  pass('card_binding');

  return { ok: true, checked };
}

module.exports = { GUARDS, runGuards };
