'use strict';

const gatesCatalog = require('../catalog/gates.json');
const humanCatalog = require('../catalog/human.json');
const prefixCatalog = require('../catalog/prefixes.json');

class GateError extends Error {}

const GATES = gatesCatalog.gates;
const PLACEHOLDER_RE = /\{(outcome|route|cause|target)\}/g;

function fill(text, params) {
  return String(text).replace(PLACEHOLDER_RE, (m, key) => {
    if (key === 'target') return params && params.target ? '; target: ' + String(params.target) : '';
    return params && params[key] != null ? String(params[key]) : m;
  });
}

function humanText(textId, params) {
  const text = humanCatalog.texts[textId];
  if (!text) throw new GateError('unknown human-facing text: ' + textId);
  return fill(text, params);
}

function prefixText(name) {
  const entry = prefixCatalog.prefixes[name];
  if (!entry) throw new GateError('unknown prefix: ' + name);
  return entry.text;
}

function gateDef(id, params) {
  const def = GATES[id];
  if (!def) throw new GateError('unknown gate: ' + id);
  const kind = def.kind === 'node' ? (params && params.kind) || 'node' : def.kind;
  const textId = def.text_id || (def.text_ids && def.text_ids[kind]) || null;
  return {
    id,
    kind,
    text_id: textId,
    question: textId ? humanText(textId, params) : null,
    actions: [...def.actions],
    transitions: [...def.transitions],
    ...(def.note ? { note: def.note } : {}),
    ...(def.params ? { params: structuredClone(def.params) } : {}),
  };
}

function assertLegal(id, action) {
  const def = GATES[id];
  if (!def) throw new GateError('unknown gate: ' + id);
  if (!def.actions.includes(action)) {
    throw new GateError(`illegal action "${action}" for gate "${id}"`);
  }
  return true;
}

function rejectBody(reply) {
  const extra = reply ? ' - ' + String(reply) : '';
  return prefixText('REJECTED_OPTIMIZE_V1') + extra;
}

module.exports = {
  GATES,
  gateDef,
  assertLegal,
  rejectBody,
  humanText,
  prefixText,
  fill,
  GateError,
  catalogs: { gates: gatesCatalog, human: humanCatalog, prefixes: prefixCatalog },
};
