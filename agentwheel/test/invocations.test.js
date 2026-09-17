"use strict";
require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const invocations = require('../lib/transport/invocations');
const transportLib = require('../lib/transport');
const { ROUTE_IDS } = require('../lib/schema');
const { runCard } = require('../seats/runner');
const models = require('../lib/transport/models');

test('A20: the law\'s route ids name Core\'s eleven routes plus the three api routes, and every CLI route seals its exact non-interactive invocation', () => {
  const ids = transportLib.listRoutes().map((r) => r.id);
  assert.deepEqual(ids, [
    'claude:app:chat', 'claude:app:cowork', 'claude:app:code', 'claude:cli',
    'chatgpt:app:classic', 'chatgpt:app:chat', 'chatgpt:app:work', 'chatgpt:codex',
    'cursor:app', 'cursor:cli', 'grok:cli', 'api:anthropic', 'api:openai', 'api:xai',
  ]);
  assert.deepEqual(ROUTE_IDS, ids, 'the Spec schema admits exactly these ids');
  assert.deepEqual(invocations.commandForRoute('grok:cli', {}),
    ['grok', '--output-format', 'plain', '--max-turns', '12', '--verbatim', '--tools', 'todo_write', '--disallowed-tools', 'todo_write,Agent', '--no-subagents', '--disable-web-search']);
  assert.deepEqual(invocations.commandForRoute('chatgpt:codex', {}),
    ['codex', 'exec', '--skip-git-repo-check', '-s', 'read-only', '--color', 'never', '--ephemeral', '-']);
  assert.deepEqual(invocations.commandForRoute('cursor:cli', {}), ['cursor-agent', '-p', '--output-format', 'text', '--trust']);
  assert.deepEqual(invocations.commandForRoute('claude:cli', {}).slice(0, 4), ['claude', '-p', '--output-format', 'stream-json']);
  assert.equal(invocations.commandForRoute('claude:app:cowork', {}), null, 'app routes have no CLI invocation');
  for (const id of ['grok:cli', 'chatgpt:codex', 'cursor:cli', 'claude:cli']) {
    assert.deepEqual(transportLib.providerCommand(transportLib.routeById(id), {}), invocations.commandForRoute(id, {}));
  }
  assert.deepEqual(transportLib.providerCommand(transportLib.routeById('grok:cli'), { model: 'grok-4' }).slice(-2), ['--model', 'grok-4']);
  assert.deepEqual(invocations.channelsFor('/usr/local/bin/grok').prompt, { channel: 'file', flag: '--prompt-file' });
  assert.equal(invocations.channelsFor('/opt/homebrew/bin/codex').system, null);
  assert.equal(invocations.channelsFor('claude').unwrap, 'claude-stream-json');
  assert.deepEqual(invocations.channelsFor('fake-provider.js'), { prompt: { channel: 'stdin' }, system: null, unwrap: 'text' });
});

function fakeBin(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-fake-bin-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n' + body, { mode: 0o755 });
  return file;
}
function card(command, extra) {
  const envelope = {
    type: 'dispatch', kind: 'review', seat: 'reviewer', result_schema: 'REVIEW_RESULT', timeout_ms: 20000,
    system_prompt: 'SYSTEM-BYTES independent review.', prompt: 'rejected, optimize - first line\nsecond line',
    provider: { command, model: null }, ...(extra || {}),
  };
  return JSON.stringify({ id: 'card_fake000001', body: JSON.stringify(envelope) });
}

test('A20: grok takes the message from --prompt-file and the system prompt on --system-prompt-override; codex reads the message on stdin, prompt bytes first; a killed child is timeout on either', async () => {
  const grok = fakeBin('grok', [
    'PF=""; SP=""; TOOLS="unset"; MINUS="unset"',
    'while [ $# -gt 0 ]; do case "$1" in --prompt-file) PF="$2"; shift;; --system-prompt-override) SP="$2"; shift;; --tools) TOOLS="[$2]"; shift;; --disallowed-tools) MINUS="[$2]"; shift;; esac; shift; done',
    'FIRST=$(head -n 1 "$PF")',
    'printf \'{"decision":"accept","references":["%s"],"notes":"system=%s tools=%s minus=%s stdin=%s"}\\n\' "$FIRST" "$(printf %s "$SP" | head -c 12)" "$TOOLS" "$MINUS" "$(cat | wc -c | tr -d " ")"',
  ].join('\n'));
  const g = await runCard(card([grok, ...invocations.commandForRoute('grok:cli', {}).slice(1)]));
  assert.equal(g.outcome, 'result', JSON.stringify(g));
  assert.deepEqual(g.result.references, ['rejected, optimize - first line'], 'the message file begins with the prompt bytes');
  assert.equal(g.result.notes, 'system=SYSTEM-BYTES tools=[todo_write] minus=[todo_write,Agent] stdin=0', 'system on its flag, tools stripped, nothing on stdin');

  const codex = fakeBin('codex', [
    'IN=$(cat)',
    'FIRST=$(printf %s "$IN" | head -n 1)',
    'HAS_SYS=$(printf %s "$IN" | grep -c "SYSTEM-BYTES")',
    'printf \'{"decision":"gap","references":["%s"],"notes":"args=%s system_in_stdin=%s"}\\n\' "$FIRST" "$*" "$HAS_SYS"',
  ].join('\n'));
  const c = await runCard(card([codex, ...invocations.commandForRoute('chatgpt:codex', {}).slice(1)]));
  assert.equal(c.outcome, 'result', JSON.stringify(c));
  assert.deepEqual(c.result.references, ['rejected, optimize - first line'], 'stdin begins with the prompt bytes');
  assert.equal(c.result.notes, 'args=exec --skip-git-repo-check -s read-only --color never --ephemeral - system_in_stdin=1', 'the sealed invocation, no system flag: the system prompt follows the prompt on stdin');

  const slow = fakeBin('grok', 'sleep 5\necho \'{"decision":"accept","references":[],"notes":"late"}\'');
  const t = await runCard(card([slow, ...invocations.commandForRoute('grok:cli', {}).slice(1)], { timeout_ms: 400 }));
  assert.equal(t.outcome, 'timeout');
  assert.match(t.detail, /provider killed at 400ms/);
  const slowCodex = fakeBin('codex', 'cat > /dev/null\nsleep 5\necho \'{"decision":"accept","references":[],"notes":"late"}\'');
  const t2 = await runCard(card([slowCodex, ...invocations.commandForRoute('chatgpt:codex', {}).slice(1)], { timeout_ms: 400 }));
  assert.equal(t2.outcome, 'timeout');
  const broken = fakeBin('grok', 'cat > /dev/null; echo "boom" 1>&2; exit 3');
  const b = await runCard(card([broken, ...invocations.commandForRoute('grok:cli', {}).slice(1)]));
  assert.equal(b.outcome, 'transport_error');
  assert.match(b.detail, /exit 3/);
  assert.match(b.stderr, /boom/);
});

test('every model list is the one its binary gives: Codex its catalog with each model\'s levels, Grok its models with the levels its binary carries, Cursor its account\'s ids grouped by family', () => {
  const codex = models.parseCodexCatalog(JSON.stringify({ models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort, description: effort === 'ultra' ? 'Max with delegation' : effort })) },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', supported_reasoning_levels: [] },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }] },
  ] }));
  assert.deepEqual(codex.models.map((m) => m.id), ['', 'gpt-6-astra', 'gpt-5.5'], 'hidden entries are Codex\'s own plumbing');
  assert.deepEqual(codex.models[1].efforts.map((l) => l.id), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(codex.models[1].efforts[5].note, 'Max with delegation');
  assert.equal(codex.models[1].default_effort, 'medium');
  assert.equal(codex.models[0].efforts, null, 'the default model names no levels until one is picked');
  assert.equal(models.parseCodexCatalog('not json'), null);

  const grok = models.parseGrokModels('You are logged in with grok.com.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n', models.GROK_LEVELS);
  assert.deepEqual(grok.models.map((m) => [m.id, m.label]), [['', 'grok-4.6 (default)'], ['grok-4.5', 'grok-4.5']]);
  assert.deepEqual(grok.models[0].efforts.map((l) => l.id), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(grok.models[1].efforts.map((l) => l.id), ['low', 'medium', 'high'], 'each model its own levels');
  assert.equal(grok.models[1].default_effort, 'high');
  const future = models.parseGrokModels('  * grok-5 (default)\n', models.GROK_LEVELS);
  assert.equal(future.models[0].efforts, null, 'a model the map does not know gets a model select alone, never a field');

  const cursor = models.parseCursorModels([
    'Available models', '',
    'auto - Auto (current, default)',
    'claude-opus-5-thinking-high - Claude Opus 5 1M Thinking',
    'claude-opus-5-low - Claude Opus 5 1M Low',
    'claude-opus-5-high - Claude Opus 5 1M',
    'claude-opus-5-high-fast - Claude Opus 5 1M Fast',
    'claude-opus-5-thinking-max - Claude Opus 5 1M Max Thinking',
    'claude-fable-5-1-max - Claude Fable 5.1 1M Max (NO ZDR)',
    'composer-2.5 - Composer 2.5',
    '\x1b[2mcomposer-2.5-fast - Composer 2.5 Fast\x1b[0m',
  ].join('\n'));
  assert.equal(cursor.effort_is_model, true, 'the power is part of the id');
  assert.deepEqual(cursor.models.map((f) => f.label), ['Auto (default)', 'Claude Opus 5', 'Claude Fable 5.1 (NO ZDR)', 'Composer 2.5']);
  const opus = cursor.models[1];
  assert.deepEqual(opus.efforts.map((v) => v.label), ['Low', 'Default', 'Fast', 'Thinking', 'Max · Thinking'],
    'plain before thinking, then by power, each fast id after its own');
  assert.equal(opus.default_effort, 'claude-opus-5-high');
  assert.deepEqual(cursor.models[0].efforts, [{ id: '', label: 'Auto (default)' }], 'Auto sends no model at all');
  assert.equal(cursor.models[3].default_effort, 'composer-2.5');
  assert.deepEqual(models.splitCursor('Claude Opus 5 1M Extra High Thinking Fast'),
    { family: 'Claude Opus 5', variant: ['Extra High', 'Thinking', 'Fast'], nozdr: false });
});

test('discovery asks all three binaries at once, keeps the answer, and a binary that cannot answer costs only its own route', async () => {
  models.reset();
  const asked = [];
  const run = (bin, argv) => {
    asked.push(bin + ' ' + argv.join(' '));
    if (bin === 'grok') return Promise.reject(new Error('signed out'));
    if (bin === 'codex') {
      return Promise.resolve(JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] }] }));
    }
    return Promise.resolve('auto - Auto (current, default)\ncomposer-2.5 - Composer 2.5\n');
  };
  let t = 1000;
  const now = () => t;
  const [a, b] = await Promise.all([models.discover({ run, now }), models.discover({ run, now })]);
  assert.equal(a, b, 'two callers share one discovery');
  assert.deepEqual(asked.slice().sort(), ['codex debug models', 'cursor-agent models', 'grok models']);
  assert.deepEqual(models.choicesFor('chatgpt:codex').models.map((m) => m.id), ['', 'gpt-5.5']);
  assert.equal(models.choicesFor('grok:cli'), null, 'grok could not answer, so grok offers nothing, and nothing is guessed');
  assert.ok(models.choicesFor('cursor:cli').effort_is_model);
  assert.ok(models.choicesFor('claude:cli').models.length > 1, 'the two written-down lists are always there');
  assert.equal(models.choicesFor('api:openai'), null, 'no key, no list, no picker');
  t += models.TTL_MS - 1;
  await models.discover({ run, now });
  assert.equal(asked.length, 3, 'kept, not asked again');
  t += 2;
  await models.discover({ run, now });
  assert.equal(asked.length, 6, 'and asked again once the answer is old');
  await models.discover({ run, now, fresh: true });
  assert.equal(asked.length, 9, 'an explicit refresh bypasses the cache');
  models.reset();
});

test('the selected Astra model and reasoning are forwarded to the Codex CLI', () => {
  const args = invocations.commandForRoute('chatgpt:codex', { model: 'gpt-6-astra', effort: 'ultra' });
  assert.deepEqual(args.slice(-5), ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=ultra', '-']);
});
