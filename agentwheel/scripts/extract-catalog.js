#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { lawPath } = require('../lib/paths');

const PREFIX_WHEN = {
  ALWAYS_ON_V1: 'every outbound seat message, first in the system prompt',
  PLAN_TRIAL_READ_ONLY_V1: 'Plan Trial dispatches',
  EXECUTE_LEAF_V1: 'Builder dispatches executing named leaves on a branch',
  EARLIEST_REPAIR_ONLY_V1: 'repair dispatches after gap, conflict, or a failed proof',
  REJECTED_OPTIMIZE_V1: 'the next prompt after REJECT at DESIGN_READY or REJECT_APPROACH',
  REVIEW_ONLY_V1: 'the independent review seat',
  FINAL_CLOSURE_READ_ONLY_V1: 'final closure before Done',
  SCHEMA_REPAIR_ONLY_V1: 'once per dispatch, only for outcome = malformed',
};

const GATE_KIND = {
  VALIDATE: 'node',
  PLAN_READY: 'plan',
  DESIGN_READY: 'design',
  TEST_READY: 'plan',
  BUDGET_GATE: 'wheel',
  ROUTE_ATTENTION: 'wheel',
  HUMAN_ESCALATION: 'wheel',
  RECOVERY_REQUIRED: 'wheel',
  REPAIR_REQUIRED: 'node',
};

const GATE_TEXT = {
  PLAN_READY: 'PLAN_READY_V1',
  DESIGN_READY: 'DESIGN_READY_V1',
  TEST_READY: 'TEST_READY_V1',
  BUDGET_GATE: 'BUDGET_GATE_V1',
  ROUTE_ATTENTION: 'ROUTE_ATTENTION_V1',
  HUMAN_ESCALATION: 'HUMAN_ESCALATION_V1',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED_V1',
  REPAIR_REQUIRED: 'REPAIR_REQUIRED_V1',
};

function innerLines(law) {
  const out = [];
  for (const raw of law.split('\n')) {
    const m = /^\|(.*?)\s*\|\s{6,}\|\s*$/.exec(raw);
    if (m) out.push(m[1].replace(/^\s/, ''));
  }
  return out;
}

function parseActions(text) {
  return text.split('|').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^([A-Z_]+)(?:\(([a-z_]+)\))?$/.exec(s);
    if (!m) throw new Error('unreadable gate action: ' + s);
    return { name: m[1], param: m[2] || null };
  });
}

function parameterEnums(flat) {
  const out = {};
  const re = /\b([a-z_]+),? (?:is )?an enum \{([^}]*)\}[^.]*?default ([a-z_]+)/g;
  let m;
  while ((m = re.exec(flat))) out[m[1]] = { enum: m[2].split(',').map((s) => s.trim()), default: m[3] };
  return out;
}

function extract(law) {
  const lines = innerLines(law);
  const text = lines.join('\n');
  const flat = text.replace(/\s*\n\s*/g, ' ');

  const catalogText = {};
  const re = /([A-Z_]+_V1) = "([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    catalogText[m[1]] = m[2].replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const prefixes = {};
  const human = {};
  for (const [name, body] of Object.entries(catalogText)) {
    if (PREFIX_WHEN[name]) prefixes[name] = { text: body, when: PREFIX_WHEN[name] };
    else human[name] = body;
  }

  const ph = /((?:\{[a-z]+\},? ?)+)are the only placeholders/.exec(flat);
  if (!ph) throw new Error('the placeholder sentence was not found in the law');
  const placeholders = [...ph[1].matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]);

  const enums = parameterEnums(flat);

  const start = lines.findIndex((l) => l.startsWith('GATE CATALOG'));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('EGRESS GUARD'));
  const entries = [];
  let current = null;
  for (const line of lines.slice(start, end)) {
    if (!line.trim()) continue;
    const head = /^\s*([A-Z_]+)(?: \(([^)]*)\))?: (.+)$/.exec(line);
    if (head && GATE_KIND[head[1]]) {
      current = { name: head[1], scope: head[2] || null, actionsText: head[3], arrowText: '' };
      entries.push(current);
      continue;
    }
    const arrow = /^\s*-> (.+)$/.exec(line);
    if (arrow && current) { current.arrowText = arrow[1].trim(); continue; }
    if (current && current.arrowText) current.arrowText += ' ' + line.trim();
  }
  const gates = {};
  for (const e of entries) {
    const actions = parseActions(e.actionsText);
    const cut = e.arrowText.indexOf('.  ');
    const transitionsText = cut >= 0 ? e.arrowText.slice(0, cut) : e.arrowText;
    const note = cut >= 0 ? e.arrowText.slice(cut + 3).trim() : null;
    const g = {
      text_id: GATE_TEXT[e.name] || null,
      kind: GATE_KIND[e.name],
      actions: actions.map((a) => a.name),
      transitions: transitionsText.split('|').map((s) => s.trim()),
    };
    if (e.scope) {
      g.applies_to = e.scope.split(',').map((s) => s.trim().toLowerCase());
      g.text_ids = {};
      for (const kind of g.applies_to) {
        const id = kind.toUpperCase() + '_PENDING_V1';
        if (human[id]) g.text_ids[kind] = id;
      }
    }
    const params = {};
    for (const a of actions) {
      if (!a.param) continue;
      if (!enums[a.param]) throw new Error(`gate ${e.name}: the law names no enum for parameter ${a.param}`);
      params[a.name] = { [a.param]: enums[a.param] };
    }
    if (Object.keys(params).length) g.params = params;
    if (note) g.note = note;
    gates[e.name] = g;
  }
  for (const [name, g] of Object.entries(gates)) {
    if (g.actions.length !== g.transitions.length) {
      throw new Error(`gate ${name}: ${g.actions.length} actions but ${g.transitions.length} transitions`);
    }
    const ids = g.text_id ? [g.text_id] : Object.values(g.text_ids || {});
    if (!ids.length) throw new Error(`gate ${name}: no human-facing text`);
    for (const id of ids) if (!human[id]) throw new Error(`gate ${name}: human text ${id} not found in the law`);
  }
  if (Object.keys(gates).length !== 9) throw new Error('expected 9 gates in the GATE CATALOG');
  if (Object.keys(prefixes).length !== 8) throw new Error('expected 8 prefixes');

  return {
    prefixes: { version: 2, source: 'Agent-Wheel-ascii-diagram.txt, EXACT ALWAYS-ON AND RARE PREFIX CATALOG', prefixes },
    human: {
      version: 4,
      source: 'Agent-Wheel-ascii-diagram.txt, EXACT HUMAN-FACING CATALOG',
      placeholders,
      texts: human,
    },
    gates: { version: 4, source: 'Agent-Wheel-ascii-diagram.txt, GATE CATALOG', gates },
  };
}

function write(outDir) {
  const law = fs.readFileSync(lawPath, 'utf8');
  const derived = extract(law);
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, body] of Object.entries(derived)) {
    fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify(body, null, 2) + '\n');
  }
  return derived;
}

module.exports = { extract, write, innerLines };

if (require.main === module) {
  const derived = write(path.join(__dirname, '..', 'catalog'));
  for (const [name, body] of Object.entries(derived.prefixes.prefixes)) console.log(`${name}: ${body.text.length} chars`);
  for (const [name] of Object.entries(derived.human.texts)) console.log(`human ${name}`);
  for (const [name, g] of Object.entries(derived.gates.gates)) console.log(`gate ${name}: ${g.actions.join(' | ')}`);
}
