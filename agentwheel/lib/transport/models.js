'use strict';

const { execFile } = require('child_process');

const TTL_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 8000;

function levels(ids) {
  return ids.map((id) => ({ id, label: id }));
}

const CLAUDE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const GROK_LEVELS = {
  'grok-4.6': { levels: ['low', 'medium', 'high', 'xhigh'], default: 'high' },
  'grok-4.5': { levels: ['low', 'medium', 'high'], default: 'high' },
};

const STATIC = {
  'claude:cli': {
    models: [
      { id: '', label: 'Sonnet 5 (default)', efforts: levels(CLAUDE_LEVELS) },
      { id: 'fable', label: 'Fable 5.1', efforts: levels(CLAUDE_LEVELS) },
      { id: 'opus', label: 'Opus 5', efforts: levels(CLAUDE_LEVELS) },
      { id: 'sonnet', label: 'Sonnet 5', efforts: levels(CLAUDE_LEVELS) },
      { id: 'haiku', label: 'Haiku 4.5', efforts: levels(CLAUDE_LEVELS) },
    ],
  },
  'api:anthropic': {
    models: [
      { id: '', label: 'Sonnet 5 (default)', efforts: null },
      { id: 'claude-fable-5-1', label: 'Fable 5.1', efforts: null },
      { id: 'claude-opus-5', label: 'Opus 5', efforts: null },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', efforts: null },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: null },
    ],
  },
};

function parseCodexCatalog(text) {
  let d;
  try { d = JSON.parse(String(text || '')); } catch { return null; }
  const list = Array.isArray(d) ? d : d && d.models;
  if (!Array.isArray(list)) return null;
  const models = [{ id: '', label: 'Codex default', efforts: null }];
  for (const m of list) {
    if (!m || typeof m.slug !== 'string' || m.visibility !== 'list') continue;
    const lv = (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
      .map((l) => (l && typeof l === 'object'
        ? { id: l.effort, label: l.effort, note: l.description || null }
        : { id: l, label: l }))
      .filter((l) => typeof l.id === 'string' && l.id);
    models.push({
      id: m.slug,
      label: m.display_name || m.slug,
      efforts: lv.length ? lv : null,
      default_effort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : null,
    });
  }
  return models.length > 1 ? { models } : null;
}

function parseGrokModels(text, grokLevels) {
  const table = grokLevels || {};
  const own = (id) => (Object.prototype.hasOwnProperty.call(table, id) ? table[id] : null);
  const models = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*[*-]\s+([A-Za-z0-9._:-]+)(\s+\(default\))?\s*$/);
    if (!m) continue;
    const lv = own(m[1]);
    const entry = {
      id: m[2] ? '' : m[1],
      label: m[1] + (m[2] ? ' (default)' : ''),
      efforts: lv ? levels(lv.levels) : null,
      default_effort: lv ? lv.default : null,
    };
    if (m[2]) models.unshift(entry);
    else models.push(entry);
  }
  if (!models.length) return null;
  if (models[0].id !== '') models.unshift({ id: '', label: 'Grok default', efforts: null });
  return { models };
}

const CURSOR_TAIL = ['Extra High', 'Thinking', 'Minimal', 'Medium', 'Fast', 'None', 'High', 'Low', 'Max', '1M'];
function splitCursor(display) {
  let s = String(display || '').trim();
  const nozdr = /\s*\(NO ZDR\)$/.test(s);
  s = s.replace(/\s*\(NO ZDR\)$/, '');
  const tail = [];
  for (let moved = true; moved;) {
    moved = false;
    for (const t of CURSOR_TAIL) {
      if (s.length > t.length && s.endsWith(' ' + t)) {
        tail.unshift(t);
        s = s.slice(0, -(t.length + 1));
        moved = true;
        break;
      }
    }
  }
  return { family: s, variant: tail.filter((t) => t !== '1M'), nozdr };
}

const CURSOR_RANK = { None: 0, Minimal: 1, Low: 2, Medium: 3, High: 4.5, 'Extra High': 5, Max: 6 };
function cursorOrder(variant) {
  const word = variant.find((t) => Object.prototype.hasOwnProperty.call(CURSOR_RANK, t));
  return [variant.includes('Thinking') ? 1 : 0, word ? CURSOR_RANK[word] : 4, variant.includes('Fast') ? 1 : 0];
}

function parseCursorModels(text) {
  const families = [];
  const byName = new Map();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
    const m = line.match(/^(\S+)\s+-\s+(.+)$/);
    if (!m) continue;
    const id = m[1];
    if (id === 'auto') {
      families.unshift({ id: 'auto', label: 'Auto (default)', efforts: [{ id: '', label: 'Auto (default)' }], default_effort: '' });
      continue;
    }
    const { family, variant, nozdr } = splitCursor(m[2]);
    let f = byName.get(family);
    if (!f) {
      f = { id: 'family:' + family, label: family, efforts: [], default_effort: null, nozdr: false };
      byName.set(family, f);
      families.push(f);
    }
    if (nozdr) f.nozdr = true;
    let label = variant.length ? variant.join(' · ') : 'Default';
    if (f.efforts.some((v) => v.label === label)) label += ' (' + id + ')';
    f.efforts.push({ id, label, order: cursorOrder(variant) });
    if (label === 'Default' && f.default_effort === null) f.default_effort = id;
  }
  for (const f of families) {
    f.efforts.sort((a, b) => ((a.order && b.order)
      ? (a.order[0] - b.order[0]) || (a.order[1] - b.order[1]) || (a.order[2] - b.order[2]) : 0));
    for (const v of f.efforts) delete v.order;
    if (f.default_effort === null && f.efforts.length) f.default_effort = f.efforts[0].id;
    if (f.nozdr) f.label += ' (NO ZDR)';
    delete f.nozdr;
  }
  return families.length ? { models: families, effort_is_model: true } : null;
}

let cache = null;
let inflight = null;

function runFile(bin, argv) {
  return new Promise((resolve) => {
    execFile(bin, argv, { timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

function ask(bin, argv, run) {
  if (!bin) return Promise.resolve(null);
  return Promise.resolve().then(() => run(bin, argv)).catch(() => null);
}

// Every route's lists at once. A binary that is missing, signed out, or slow costs only its own route its list.
function discover(opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  if (cache && !o.fresh && now() - cache.at < TTL_MS) return Promise.resolve(cache.map);
  if (inflight) return inflight;
  const run = o.run || runFile;
  const resolve = o.resolve || ((b) => b);
  // Two of the three lists come over the network, so the test harness is never made to ask for them.
  if (!o.run && process.env.AGENT_WHEEL_NO_NETWORK) {
    cache = { at: now(), map: new Map(Object.entries(STATIC)) };
    return Promise.resolve(cache.map);
  }
  inflight = Promise.all([
    ask(resolve('codex'), ['debug', 'models'], run).then(parseCodexCatalog),
    ask(resolve('grok'), ['models'], run).then((t) => parseGrokModels(t, GROK_LEVELS)),
    ask(resolve('cursor-agent'), ['models'], run).then(parseCursorModels),
  ]).then(([codex, grok, cursor]) => {
    const map = new Map(Object.entries(STATIC));
    if (codex) map.set('chatgpt:codex', codex);
    if (grok) map.set('grok:cli', grok);
    if (cursor) map.set('cursor:cli', cursor);
    cache = { at: now(), map };
    return map;
  }).finally(() => { inflight = null; });
  return inflight;
}

function choicesFor(routeId) {
  const map = cache ? cache.map : new Map(Object.entries(STATIC));
  return map.get(routeId) || null;
}

function reset() { cache = null; inflight = null; }

module.exports = {
  discover, choicesFor, parseCodexCatalog, parseGrokModels, parseCursorModels, splitCursor,
  STATIC, CLAUDE_LEVELS, GROK_LEVELS, TTL_MS, reset,
};
