'use strict';

const { extractJson } = require('./outcomes');

const PROVIDERS = {
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-5',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    body: (model, system, prompt, maxTokens) => ({
      model, max_tokens: maxTokens, stream: false, system,
      messages: [{ role: 'user', content: prompt }],
    }),
    text: (json) => (json.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o',
    headers: (key) => ({ authorization: 'Bearer ' + key }),
    body: (model, system, prompt, maxTokens) => ({
      model, max_tokens: maxTokens, stream: false,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    }),
    text: (json) => ((json.choices || [])[0] || {}).message?.content || '',
  },
  xai: {
    endpoint: 'https://api.x.ai/v1/chat/completions',
    model: 'grok-4',
    headers: (key) => ({ authorization: 'Bearer ' + key }),
    body: (model, system, prompt, maxTokens) => ({
      model, max_tokens: maxTokens, stream: false,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    }),
    text: (json) => ((json.choices || [])[0] || {}).message?.content || '',
  },
};

function providerFor(routeId) {
  const m = /^api:(anthropic|openai|xai)$/.exec(routeId);
  return m ? { id: m[1], ...PROVIDERS[m[1]] } : null;
}

// One request per card. Returns {outcome, text?, detail?, http_status?} - never throws.
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i;

async function sendApi(opts) {
  const provider = providerFor(opts.route);
  if (!provider) return { outcome: 'transport_error', detail: 'unknown api route ' + opts.route };
  const key = opts.key;
  if (!key) return { outcome: 'refused', detail: 'no provider key held for ' + provider.id };
  const endpoint = opts.endpoint || provider.endpoint;
  if (process.env.AGENT_WHEEL_NO_NETWORK && !LOOPBACK.test(String(endpoint))) {
    return { outcome: 'refused', detail: 'network is closed in this environment' };
  }
  const model = opts.model || provider.model;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 600000);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', connection: 'close', ...provider.headers(key) },
      body: JSON.stringify(provider.body(model, opts.system || '', opts.prompt || '', opts.maxTokens || 8192)),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') return { outcome: 'timeout', detail: `aborted at ${opts.timeoutMs}ms` };
    return { outcome: 'transport_error', detail: String(err && err.message) };
  }
  clearTimeout(timer);
  let text = '';
  try { text = await res.text(); } catch (err) { return { outcome: 'transport_error', detail: 'unreadable body: ' + err.message }; }
  if ([401, 402, 403, 429].includes(res.status)) {
    return { outcome: 'refused', detail: `HTTP ${res.status}: ${text.slice(0, 300)}`, http_status: res.status };
  }
  if (res.status < 200 || res.status >= 300) {
    return { outcome: 'transport_error', detail: `HTTP ${res.status}: ${text.slice(0, 300)}`, http_status: res.status };
  }
  let json;
  try { json = JSON.parse(text); } catch { return { outcome: 'transport_error', detail: 'unreadable provider wrapper', http_status: res.status }; }
  if (json.error) {
    const msg = String(json.error.message || json.error.type || 'error');
    if (/policy|refus|safety/i.test(msg)) return { outcome: 'refused', detail: msg.slice(0, 300), http_status: res.status };
    return { outcome: 'transport_error', detail: msg.slice(0, 300), http_status: res.status };
  }
  const content = provider.text(json);
  return { outcome: 'answered', text: content, http_status: res.status };
}

async function probeApi(opts) {
  const r = await sendApi({ ...opts, prompt: 'Reply with the single word ok.', system: 'Answer with one word.', maxTokens: 5, timeoutMs: 30000 });
  return { ok: r.outcome === 'answered', outcome: r.outcome, detail: r.detail || null, http_status: r.http_status || null };
}

module.exports = { sendApi, probeApi, providerFor, PROVIDERS, extractJson };
