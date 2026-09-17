'use strict';
const { resetStore } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const paths = require('../lib/paths');
const transportLib = require('../lib/transport');
const { sendApi } = require('../lib/transport/api');
const outcomes = require('../lib/transport/outcomes');
const runner = require('../seats/runner');
const { validate, TRIAL_KIT } = require('../lib/schema');
const { applyUnifiedDiff } = require('./unified-diff');

test('the adapter loads Core with the injected root and shims the two never-packaged modules', () => {
  resetStore();
  const t = transportLib.createTransport();
  assert.equal(t.root, paths.transportRoot);
  assert.equal(path.basename(t.dir()), '.convobus', 'Convobus requires that basename');
  assert.ok(t.dir().startsWith(paths.homeDir), 'the root is ours, not Convobus\'s default');
  assert.ok(!t.dir().includes('/Library/Application Support/Convobus'), 'never Convobus\'s own store');
  const loops = require.cache[path.join(paths.convobusLib, 'loops.js')];
  assert.ok(loops && typeof loops.exports.loopsSnapshot === 'function', 'loops.js answered by the shim');
  assert.deepEqual(Object.keys(loops.exports), ['loopsSnapshot']);
  const bundle = require.cache[path.join(paths.convobusLib, 'bundle-helper.js')];
  assert.ok(bundle && bundle.exports.PROTOCOL_VERSION === 3, 'bundle-helper.js answered by the shim');
  assert.deepEqual(Object.keys(t.core).sort(), [
    'bindSeat', 'cloneCard', 'detectSurfaces', 'discover', 'dispatchSend', 'gateReason', 'getSeat', 'makeCard',
    'normalizedRoute', 'parseMaybeCard', 'paths', 'publicRoute', 'resolveIncomingCard', 'routeFor', 'sendMessage',
    'withStateLock',
  ]);
  assert.deepEqual(t.versions, { convobus_upstream_version: '0.2.0', convobus_adapter_version: '2.1.5' });
});

test('routes: the eleven Convobus routes plus api:anthropic, api:openai, api:xai; the api method admitted by the recorded patch', () => {
  const routes = transportLib.listRoutes();
  assert.deepEqual(routes.map((r) => r.id), [
    'claude:app:chat', 'claude:app:cowork', 'claude:app:code', 'claude:cli',
    'chatgpt:app:classic', 'chatgpt:app:chat', 'chatgpt:app:work', 'chatgpt:codex',
    'cursor:app', 'cursor:cli', 'grok:cli',
    'api:anthropic', 'api:openai', 'api:xai',
  ]);
  assert.equal(routes.filter((r) => r.method === 'api').length, 3);
  const patchDir = path.join(paths.appRoot, 'lib', 'transport', 'patches');
  const patch = fs.readFileSync(path.join(patchDir, 'card-api-method.patch'), 'utf8');
  assert.match(patch, /\+const METHODS = new Set\(\['stdio', 'applescript', 'ax', 'api'\]\);/);
  const vendored = fs.readFileSync(path.join(paths.convobusLib, 'card.js'), 'utf8');
  assert.ok(vendored.includes("new Set(['stdio', 'applescript', 'ax', 'api'])"));
  const upstream = fs.readFileSync(path.join(patchDir, 'card.js.upstream'), 'utf8');
  assert.notEqual(upstream, vendored);
  assert.equal(applyUnifiedDiff(upstream, patch), vendored);
  const t = transportLib.createTransport();
  const c = t.core.makeCard({ seat: 'claude-cli', method: 'api', body: 'x', stripAddress: false });
  assert.equal(c.method, 'api');
});

test('api method: one HTTPS JSON request per card, streaming off, classified by status; the key stays in memory', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      const mode = req.url.slice(1);
      if (mode === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ content: [{ type: 'text', text: 'here: {"approaches": []}' }] }));
      }
      if (mode === 'refuse') { res.writeHead(401); return res.end('{"error":{"message":"invalid x-api-key"}}'); }
      if (mode === 'quota') { res.writeHead(429); return res.end('rate limited'); }
      if (mode === 'boom') { res.writeHead(500); return res.end('server exploded'); }
      if (mode === 'slow') { return setTimeout(() => { res.writeHead(200); res.end('{}'); }, 2000); }
      res.writeHead(404); res.end('');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const good = await sendApi({ route: 'api:anthropic', key: 'sk-memory-only', endpoint: base + '/ok', prompt: 'p', system: 's' });
    assert.equal(good.outcome, 'answered');
    assert.equal(good.text, 'here: {"approaches": []}');
    assert.equal(seen[0].headers['x-api-key'], 'sk-memory-only');
    assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(seen[0].body.stream, false, 'streaming off');
    assert.equal(seen[0].body.messages[0].content, 'p');
    assert.equal(seen[0].body.system, 's');
    const classified = outcomes.classifyParsed(outcomes.extractJson(good.text), { type: 'object', required: ['approaches'] }, validate);
    assert.equal(classified.outcome, 'result');
    assert.equal((await sendApi({ route: 'api:anthropic', key: 'k', endpoint: base + '/refuse', prompt: 'p' })).outcome, 'refused');
    assert.equal((await sendApi({ route: 'api:openai', key: 'k', endpoint: base + '/quota', prompt: 'p' })).outcome, 'refused');
    assert.equal((await sendApi({ route: 'api:xai', key: 'k', endpoint: base + '/boom', prompt: 'p' })).outcome, 'transport_error');
    assert.equal((await sendApi({ route: 'api:anthropic', key: 'k', endpoint: base + '/slow', prompt: 'p', timeoutMs: 150 })).outcome, 'timeout');
    assert.equal((await sendApi({ route: 'api:anthropic', key: '', endpoint: base + '/ok', prompt: 'p' })).outcome, 'refused', 'no key is a refusal before the provider is reached');
    assert.equal(seen.length, 5, 'exactly one request per card');
    const openai = seen.find((s) => s.url === '/quota');
    assert.equal(openai.headers.authorization, 'Bearer k');
  } finally {
    server.close();
  }
});

test('capacity: one GUI route machine-wide; three stdio; one process per binary per project', () => {
  resetStore();
  const t = transportLib.createStubTransport();
  const binding = { project_id: 'p1' };
  const envelope = { type: 'dispatch', seat: 'plan_trial', kind: 'plan_trial', superdoc: { binding: {} }, result_schema: 'TRIAL_KIT', timeout_ms: 1000 };
  const realCapacity = transportLib.createTransport().capacity;
  assert.equal(realCapacity('chatgpt:app:classic', {}, {}).ok, true);
  t.send({ route: 'chatgpt:app:classic', cfg: {}, binding, envelope });
  assert.match(realCapacity('chatgpt:app:work', {}, {}).reason, /GUI route busy/);
  assert.match(realCapacity('cursor:app', {}, {}).reason, /GUI route busy/);
  assert.equal(realCapacity('claude:cli', {}, { project_id: 'p1' }).ok, true);
  t.send({ route: 'claude:cli', cfg: {}, binding, envelope });
  assert.match(realCapacity('claude:cli', {}, { project_id: 'p1' }).reason, /already in flight for this project/);
  assert.equal(realCapacity('claude:cli', {}, { project_id: 'p2' }).ok, true, 'another project may use the same binary');
  t.send({ route: 'chatgpt:codex', cfg: {}, binding: { project_id: 'p2' }, envelope });
  t.send({ route: 'grok:cli', cfg: {}, binding: { project_id: 'p3' }, envelope });
  assert.match(realCapacity('cursor:cli', {}, { project_id: 'p4' }).reason, /three stdio processes/);
  assert.equal(t.inflight().length, 4);
});

test('the seat runner classifies in code: result, malformed, transport_error, timeout, refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-runner-'));
  const write = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
  const good = write('good.js', `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ leaves: {} })));`);
  const bad = write('bad.js', `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('sure! {"leaves": "nope"}'));`);
  const crash = write('crash.js', `process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('kaboom'); process.exit(2); });`);
  const slow = write('slow.js', `process.stdin.resume(); setTimeout(() => process.stdout.write('{}'), 5000);`);
  const card = (command) => JSON.stringify({ id: 'card_x', seat: 'claude-cli', method: 'stdio', body: JSON.stringify({
    type: 'dispatch', seat: 'plan_trial', kind: 'plan_trial', result_schema: 'TRIAL_KIT', timeout_ms: 300,
    superdoc: { binding: { role: 'r', permissions: {}, result_schema: TRIAL_KIT }, wiki_temp_snapshot: {}, expanded_context: { plan: { draft: null } } },
    provider: { command: ['node', command] },
  }) });
  assert.equal((await runner.runCard(card(good))).outcome, 'result');
  const malformed = await runner.runCard(card(bad));
  assert.equal(malformed.outcome, 'malformed');
  assert.ok(malformed.errors.length > 0);
  const crashed = await runner.runCard(card(crash));
  assert.equal(crashed.outcome, 'transport_error');
  assert.match(crashed.stderr, /kaboom/, 'verbatim stderr kept');
  assert.equal((await runner.runCard(card(slow))).outcome, 'timeout');
  assert.equal(runner.unwrapClaude(JSON.stringify({ is_error: true, subtype: 'error', api_error_status: 401 })).outcome, 'refused');
  assert.equal(runner.unwrapClaude(JSON.stringify({ is_error: true, subtype: 'error_max_turns' })).outcome, 'transport_error');
  assert.equal(runner.unwrapClaude(JSON.stringify({ is_error: false, result: '{"a":1}' })).text, '{"a":1}');
  assert.equal(runner.unwrapClaude('not json').outcome, 'transport_error');
  assert.deepEqual(runner.seatEnv({ PATH: '/x', HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/x.sock', CLAUDE_PID: '1', MCP_CONNECTION_NONBLOCKING: 'true', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', AGENT_WHEEL_HOME: '/a' }),
    { PATH: '/x', HOME: '/h', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', AGENT_WHEEL_HOME: '/a' });
  const slipped = { leaves: { 'L1.1.1': { bases: {} } }, 'L1.5.1': { bases: {} }, 'L1.5.2': { bases: {} }, note: 'x' };
  const norm = outcomes.normalizeResult('TRIAL_KIT', slipped);
  assert.deepEqual(norm.folded, ['L1.5.1', 'L1.5.2']);
  assert.deepEqual(Object.keys(norm.value.leaves).sort(), ['L1.1.1', 'L1.5.1', 'L1.5.2']);
  assert.deepEqual(Object.keys(norm.value).sort(), ['leaves', 'note'], 'a non-leaf stray key stays for the schema to refuse');
  assert.deepEqual(outcomes.normalizeResult('WORK_SUBMISSION', slipped).folded, []);
  const echoed = outcomes.normalizeResult('WORK_SUBMISSION', { $schema: 'https://json-schema.org/draft/2020-12/schema', branch_label: 'x' });
  assert.deepEqual(echoed, { value: { $schema: 'https://json-schema.org/draft/2020-12/schema', branch_label: 'x' }, folded: [] }, 'an echoed dialect line is not dropped: that would be a fourth normalization, and the bound schema refuses it');
  assert.deepEqual(outcomes.normalizeResult('TRIAL_KIT', { leaves: { 'L1.1.1': {} }, 'L1.1.1': { dup: true } }).folded, [], 'an id already under leaves is not overwritten');
  const ex = (s) => outcomes.extractJson(s);
  assert.deepEqual(ex('{"a":1}').value, { a: 1 });
  assert.deepEqual(ex('Here is the kit:\n{"a":{"b":"}"}}\nDone, let me know.').value, { a: { b: '}' } });
  assert.deepEqual(ex('{"a":1}\n{"a":2}').value, { a: 1 }, 'the first object wins over a second one');
  assert.deepEqual(ex('```json\n{"a":"x\\"y{"}\n```').value, { a: 'x"y{' });
  assert.equal(ex('{"a":').ok, false);
  assert.match(ex('{"a":').detail, /no JSON object/);
  assert.match(ex('{"a": [1,}').detail, /unparseable JSON/);
  assert.equal(ex('no object here').ok, false);
  const stream = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: '{"leaves":' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '{"L1":1}' }, { type: 'text', text: '}' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '1}}' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  assert.equal(runner.unwrapClaude(stream).text, '{"leaves":{"L1":1}}');
  const refusedStream = [{ type: 'assistant', message: { content: [] } }, { type: 'result', is_error: true, subtype: 'error', api_error_status: 429 }]
    .map((e) => JSON.stringify(e)).join('\n');
  assert.equal(runner.unwrapClaude(refusedStream).outcome, 'refused');
  assert.equal(runner.unwrapClaude('{"type":"system"}\n{"type":"assistant","message":{"content":[]}}').outcome, 'transport_error', 'no result event');
  assert.deepEqual(transportLib.providerCommand({ id: 'claude:cli', surface: 'cli' }, {}).slice(0, 5), ['claude', '-p', '--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(transportLib.providerCommand({ id: 'grok:cli', surface: 'cli' }, {}).slice(0, 3), ['grok', '--output-format', 'plain']);
  assert.deepEqual(transportLib.providerCommand({ id: 'chatgpt:codex', surface: 'cli' }, {}).slice(0, 2), ['codex', 'exec']);
});

test('readiness carries a code and the accessibility fact as fields; the sentence is unchanged; a sweep takes one look where fourteen questions take seven', async () => {
  const { READINESS_CODES, createTransport } = transportLib;
  const t = createTransport({ secrets: new Map() });
  const ids = t.listRoutes().map((r) => r.id);
  const ts = new Date().toISOString();

  for (const id of ids) {
    const c = t.readiness(id, {}, { ts });
    assert.ok(c.code, 'no answer without a code: ' + id);
    assert.ok(READINESS_CODES.has(c.code), 'unknown code ' + c.code + ' for ' + id);
    assert.equal(typeof c.ax_gated, 'boolean');
  }
  assert.equal(t.readiness('nope:nope', {}, { ts }).code, 'unknown_route');

  assert.equal(t.readiness('claude:app:chat', {}, { ts }).ax_gated, true);
  assert.equal(t.readiness('cursor:app', {}, { ts }).ax_gated, false);
  assert.equal(t.readiness('chatgpt:app:work', {}, { ts }).ax_gated, false);
  assert.equal(t.readiness('grok:cli', {}, { ts }).ax_gated, false);
  for (const id of ids) {
    assert.ok(!/accessibility/.test(t.readiness(id, {}, { ts }).reason), 'the fact is a field, not a suffix');
  }

  const keyed = createTransport({ secrets: new Map([['anthropic', 'sk-test']]) });
  assert.equal(t.readiness('api:anthropic', {}, { ts }).code, 'no_key');
  assert.equal(keyed.readiness('api:anthropic', {}, { ts }).code, 'ok');
  assert.equal(keyed.readiness('api:anthropic', {}, { ts }).ready, true);

  const control = require(path.join(paths.convobusLib, 'control.js'));
  const real = control.detectSurfaces;
  let looks = 0;
  control.detectSurfaces = function (...a) { looks += 1; return real.apply(this, a); };
  try {
    looks = 0;
    const rows = await t.readinessSweep(ids, { ts: new Date().toISOString() });
    const swept = looks;
    assert.equal(rows.length, ids.length);
    assert.ok(rows.every((r) => r.id && r.code), 'every row is coded');
    assert.equal(swept, 1, 'one look for the whole sweep');

    looks = 0;
    for (const id of ids) t.readiness(id, {}, { ts: new Date().toISOString() });
    assert.ok(looks > swept, 'a dispatch looks for itself: ' + looks + ' looks against the sweep\'s ' + swept);
  } finally {
    control.detectSurfaces = real;
  }
});
