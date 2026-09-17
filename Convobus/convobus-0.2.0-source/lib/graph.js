'use strict';

const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z0-9-]+$/;
const HEADER_RE = /^# (\S+)$/;
const TRY_RE = /^(try|done)\s+(\(none yet\)|\S+)\s*(?:—|--|–)?\s*(.*)$/;
const BARE_KIND_RE = /^(idea|experience|constraint|plan|order)$/;

function listPlanFiles(planDir) {
  const out = [];
  if (!fs.existsSync(planDir)) return out;
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.md')) out.push(p);
    }
  };
  walk(planDir);
  out.sort();
  return out;
}

function collectEdges(line, edges, seen) {
  const re = /\[\[(needs|serves|ref)::([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(String(line))) !== null) {
    const key = m[1] + '::' + m[2].trim();
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ type: m[1], target: m[2].trim() });
  }
}

function parseNode(filePath, text) {
  const filename = path.basename(filePath, '.md');
  const lines = String(text).split('\n');
  let inFence = false;
  let id = null;
  let kind = 'plan';
  let state = 'held';
  let tryLine = null;
  const edges = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimStart = line.trimStart();
    if (trimStart.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (id === null) {
      const hm = line.match(HEADER_RE);
      if (hm) {
        id = hm[1];
        collectEdges(line, edges, seen);
        continue;
      }
    }
    const trimmed = line.trim();
    if (trimmed === 'open' && trimmed === line.trim()) {
      state = 'open';
      continue;
    }
    if (BARE_KIND_RE.test(trimmed) && trimmed === line.trim()) {
      kind = trimmed;
      continue;
    }
    const tm = line.match(TRY_RE);
    if (tm && !tryLine) {
      tryLine = { verb: tm[1], link: tm[2], description: (tm[3] || '').trim() };
      collectEdges(line, edges, seen);
      continue;
    }
    collectEdges(line, edges, seen);
  }

  return {
    filePath,
    filename,
    id,
    kind,
    state,
    try: tryLine,
    needs: edges.filter((e) => e.type === 'needs').map((e) => e.target),
    serves: edges.filter((e) => e.type === 'serves').map((e) => e.target),
    refs: edges.filter((e) => e.type === 'ref').map((e) => e.target),
    text: String(text),
  };
}

function constraintReason(node) {
  const text = node.text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (t === 'open') return false;
      if (BARE_KIND_RE.test(t)) return false;
      if (/^# /.test(line)) return false;
      if (/^\[\[(needs|serves|ref)::/.test(t)) return false;
      if (TRY_RE.test(line)) return false;
      return t.length > 0;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= 160) return text;
  return text.slice(0, 157) + '...';
}

function isLeaf(node) {
  return node.needs.length === 0;
}

function hasRef(node) {
  return node.refs.length > 0;
}

function nothingBuilt(node) {
  return !node.try;
}

function hasPlan(root) {
  const planDir = path.join(path.resolve(root), 'plan');
  return fs.existsSync(planDir) && listPlanFiles(planDir).length > 0;
}

function loadGraph(root) {
  const abs = path.resolve(root);
  const planDir = path.join(abs, 'plan');
  if (!fs.existsSync(planDir)) return null;
  const files = listPlanFiles(planDir);
  if (!files.length) return null;
  const nodes = new Map();
  for (const f of files) {
    const node = parseNode(f, fs.readFileSync(f, 'utf8'));
    if (node.id && ID_RE.test(node.id) && !nodes.has(node.id)) {
      nodes.set(node.id, node);
    }
  }
  return { root: abs, planDir, nodes };
}

function normalizeMsg(message) {
  return ' ' + String(message).toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
}

function mentions(message, id) {
  const msg = normalizeMsg(message);
  const parts = id.split('-');
  if (parts.length === 1) return msg.includes(' ' + parts[0] + ' ');
  for (let n = parts.length; n >= 2; n--) {
    const phrase = ' ' + parts.slice(0, n).join(' ') + ' ';
    if (msg.includes(phrase)) return true;
  }
  return false;
}

function namedNodes(graph, message) {
  const hit = [];
  for (const node of graph.nodes.values()) {
    if (mentions(message, node.id)) hit.push(node);
  }
  return hit;
}

function unresolvedKebabs(graph, message) {
  const ids = graph.nodes;
  const tokens = String(message).toLowerCase().match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) || [];
  const out = [];
  const seen = new Set();
  for (const t of tokens) {
    if (ids.has(t) || seen.has(t)) continue;
    if ([...ids.values()].some((n) => mentions(t, n.id))) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function claimHeld(message) {
  return /\b(done|complete|completed|fixed|held|finished|success|passed)\b/i.test(
    String(message),
  );
}

module.exports = {
  parseNode,
  loadGraph,
  hasPlan,
  isLeaf,
  hasRef,
  nothingBuilt,
  constraintReason,
  namedNodes,
  unresolvedKebabs,
  mentions,
  claimHeld,
};
