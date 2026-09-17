'use strict';

const OUTCOMES = ['result', 'malformed', 'transport_error', 'timeout', 'refused'];
const TRANSPORT_FAILURES = ['transport_error', 'timeout', 'refused'];

const SEAT_TIMEOUT_MS = { leader: 20 * 60000, builder: 30 * 60000, review: 10 * 60000 };

const BACKOFF_MS = [60000, 300000, 900000];

function isTransportFailure(outcome) {
  return TRANSPORT_FAILURES.includes(outcome);
}

function balancedObjectEnd(t, from) {
  let depth = 0;
  let inString = false;
  for (let i = from; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

const NORMALIZATIONS = ['first_object', 'fold', 'escapes'];

const RAW_CAP_BYTES = 256 * 1024;
function keepRaw(text) {
  const t = String(text == null ? '' : text);
  const bytes = Buffer.byteLength(t, 'utf8');
  if (bytes <= RAW_CAP_BYTES) return { raw: t, raw_cut: null };
  const kept = Buffer.from(t, 'utf8').subarray(0, RAW_CAP_BYTES).toString('utf8').replace(/\uFFFD+$/, '');
  return { raw: kept, raw_cut: { bytes, kept: Buffer.byteLength(kept, 'utf8'), cap: RAW_CAP_BYTES } };
}

function firstJsonObject(text) {
  let t = String(text == null ? '' : text).trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first < 0 || last <= first) return { ok: false, detail: 'no JSON object in the reply', normalizations: [], ...keepRaw(t) };
  const end = balancedObjectEnd(t, first);
  const candidates = end > first ? [t.slice(first, end), t.slice(first, last + 1)] : [t.slice(first, last + 1)];
  const cropped = first > 0 || (end > first ? end : last + 1) < t.length;
  const normalizations = cropped ? ['first_object'] : [];
  let firstError = null;
  for (const c of candidates) {
    try { return { ok: true, value: JSON.parse(c), normalizations }; } catch (err) { if (!firstError) firstError = err; }
  }
  if (/Bad escaped character|Bad control character|Unexpected token/.test(firstError.message)) {
    for (const c of candidates) {
      const fixed = repairEscapes(c);
      if (fixed === c) continue;
      try { return { ok: true, value: JSON.parse(fixed), repaired: 'escapes', normalizations: [...normalizations, 'escapes'] }; } catch {   }
    }
  }
  return { ok: false, detail: 'unparseable JSON: ' + firstError.message, normalizations, ...keepRaw(t) };
}

function repairEscapes(text) {
  return String(text).replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
}

function extractJson(text) {
  return firstJsonObject(text);
}

function refusalFromWrapper(wrapper) {
  const status = Number(wrapper.api_error_status || 0);
  const text = [wrapper.subtype, wrapper.terminal_reason, wrapper.errors && wrapper.errors.join(' '), wrapper.result]
    .filter(Boolean).join(' ').toLowerCase();
  if ([401, 402, 403, 429].includes(status)) return `provider refused with HTTP ${status}`;
  if (/authentication|unauthorized|invalid api key|not logged in|login required/.test(text)) return 'provider authentication refusal';
  if (/quota|rate limit|credit balance|billing|insufficient/.test(text)) return 'provider quota refusal';
  if (/policy|refus|blocked by/.test(text)) return 'provider policy refusal';
  return null;
}

const LEAF_ID = /^L[0-9]+(\.[0-9]+)*$/;
function foldTrialKitLeaves(schemaName, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value, folded: [] };
  if (schemaName !== 'TRIAL_KIT') return { value, folded: [] };
  const leaves = value.leaves && typeof value.leaves === 'object' && !Array.isArray(value.leaves) ? value.leaves : null;
  if (!leaves) return { value, folded: [] };
  const folded = [];
  const out = { ...value, leaves: { ...leaves } };
  for (const key of Object.keys(value)) {
    if (key !== 'leaves' && LEAF_ID.test(key) && !(key in leaves) && value[key] && typeof value[key] === 'object') {
      out.leaves[key] = value[key];
      delete out[key];
      folded.push(key);
    }
  }
  return { value: folded.length ? out : value, folded };
}

function normalizeResult(schemaName, value) {
  return foldTrialKitLeaves(schemaName, value);
}

function classifyParsed(parsed, schema, validate) {
  const normalizations = parsed.normalizations || [];
  if (!parsed.ok) return { outcome: 'malformed', detail: parsed.detail, raw: parsed.raw, raw_cut: parsed.raw_cut || null, normalizations };
  const check = validate(schema, parsed.value);
  if (!check.ok) {
    const kept = keepRaw(JSON.stringify(parsed.value));
    return { outcome: 'malformed', detail: 'fails the bound schema', errors: check.errors.slice(0, 5), result: parsed.value, raw: kept.raw, raw_cut: kept.raw_cut, normalizations };
  }
  return { outcome: 'result', result: parsed.value, normalizations };
}

module.exports = {
  OUTCOMES, TRANSPORT_FAILURES, SEAT_TIMEOUT_MS, BACKOFF_MS, NORMALIZATIONS, RAW_CAP_BYTES,
  isTransportFailure, extractJson, firstJsonObject, foldTrialKitLeaves, repairEscapes, keepRaw,
  balancedObjectEnd, refusalFromWrapper, classifyParsed, normalizeResult,
};
