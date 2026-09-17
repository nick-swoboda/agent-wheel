'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const invocations = require('../lib/transport/invocations');
const { validate, TRIAL_KIT, EXECUTION_SUBMISSION, REVIEW_RESULT, NODE_SCHEMAS, DESIGN_PROPOSAL } = require('../lib/schema');
const outcomes = require('../lib/transport/outcomes');

function schemaFor(name) {
  return name === 'TRIAL_KIT' ? TRIAL_KIT : name === 'EXECUTION_SUBMISSION' ? EXECUTION_SUBMISSION
    : name === 'REVIEW_RESULT' ? REVIEW_RESULT : name === 'DESIGN_PROPOSAL' ? DESIGN_PROPOSAL : name === 'DESIGN' ? NODE_SCHEMAS.design : { type: 'object' };
}

function walkLeaves(node, out = []) {
  if (!node) return out;
  if (!node.decomposes_into || node.decomposes_into.length === 0) out.push(node);
  else node.decomposes_into.forEach((c) => walkLeaves(c, out));
  return out;
}

function seatEnv(base) {
  const out = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (/^(CLAUDECODE$|CLAUDE_|CLAUDE$|MCP_)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function sealedPrompt(envelope) {
  return { system: String(envelope.system_prompt || ''), prompt: String(envelope.prompt || '') };
}

function buildPrompt(envelope) {
  const { system, prompt } = sealedPrompt(envelope);
  return prompt + '\n\n---- SYSTEM PROMPT ----\n' + system;
}

function legacyBuildPrompt(envelope) {
  const doc = envelope.superdoc;
  const b = doc.binding;
  const lines = [];
  if (envelope.system_prompt) lines.push(envelope.system_prompt, '');
  if (envelope.prompt) lines.push(envelope.prompt, '');
  lines.push(`You are the "${envelope.seat}" seat on the Agent Wheel ConvoBus.`);
  if (doc.project) lines.push(`Project: ${doc.project.name}`);
  lines.push(`Role: ${b.role}`);
  if (b.agree_or_escalate) lines.push(`Agree-or-escalate: ${b.agree_or_escalate}`);
  lines.push(`Permissions: ${JSON.stringify(b.permissions)}`);
  if (b.budget) lines.push(`Budget: ${JSON.stringify(b.budget)}`);
  if (b.schema_errors) {
    lines.push('', 'YOUR PREVIOUS RESULT FAILED THE BOUND SCHEMA:');
    for (const e of b.schema_errors) lines.push('  - ' + e);
  }
  lines.push('', 'RESULT SCHEMA - return ONLY one JSON object matching it exactly.',
    'No prose before or after. No markdown fences.',
    'You have no tools in this seat: do not run, read, or write anything -',
    'any file content or script belongs INSIDE the JSON as string values.', '');
  lines.push(JSON.stringify(b.result_schema));
  lines.push('', 'WIKI SNAPSHOT:', JSON.stringify(doc.wiki_temp_snapshot));
  lines.push('', 'EXPANDED CONTEXT (the governing node versions):',
    JSON.stringify(doc.expanded_context));

  if (envelope.kind === 'plan_trial') {
    const draft = doc.expanded_context.plan && doc.expanded_context.plan.draft;
    const leaves = walkLeaves(draft);
    lines.push('', 'PLAN LEAVES TO TRY (every one needs an entry under "leaves"; kind and risk in brackets):');
    for (const leaf of leaves) lines.push(`- ${leaf.id} [${leaf.kind}${leaf.risk === 'high' ? ', high-risk' : ''}]: ${leaf.title}`);
    lines.push('',
      'Task: produce the trial kit.',
      '- Every leaf id above gets an entry with all six "bases": first_principles, trusted_method,',
      '  executable_test, inspection, math, physics. Each basis is either {"applicable": false,',
      '  "reason": "..."} with a real reason, or applicable with its payload: executable_test ->',
      '  {"applicable": true, "exec": {"files": {...}, "entry": "..."}} (a self-contained Node',
      '  script run by the engine in an empty scratch directory, offline, no packages; exit 0 on',
      '  pass, non-zero on fail; it may only write inside its own working directory); inspection ->',
      '  {"applicable": true, "observation": "..."}; the others -> {"applicable": true,',
      '  "derivation": "..."}. Prefer an executable test wherever execution applies. A high-risk',
      '  leaf needs two applicable bases.',
      '- For the [decision] leaf give at least two "alternatives" (ALT1, ALT2, ...) with RUNNABLE',
      '  Node "build" kits that exit 0 when the alternative assembles, then "chosen" and a',
      '  "rationale" grounded in the accepted Spec and Experience.');
  } else if (envelope.kind === 'review') {
    lines.push('', 'REVIEW SUBJECT (the presented result, its evidence, and the acceptance contract):',
      JSON.stringify(doc.review_subject));
    lines.push('',
      'Task: independent review. You are not the author and see no author reasoning.',
      '- Check the presented result against the current nodes, the required evidence, the tests,',
      '  and the permissions; decide accept | gap | conflict | needs_human.',
      '- "references": exact references (node kind + version, leaf ids, test names, acceptance ids).',
      '- For gap or conflict name "earliest_repair": the earliest responsible node kind.',
      '- "notes": what decided it, in a few sentences.');
  } else if (envelope.kind === 'execute') {
    lines.push('',
      'Task: execute exactly the named Plan leaves on the assigned branch (the EVIDENCE section',
      'of the system prompt lists them with the claims they serve and main as it stands).',
      '- "leaves": exactly the dispatched leaf ids.',
      '- "files": COMPLETE file contents, no placeholders: the artifact file and a Node test suite.',
      '- "main_file": the artifact (keep the name main already uses).',
      '- "test_command" starts with "node ", prints exactly "TESTS passed=N failed=M" as its',
      '  final line, and exits non-zero on any failure. Claim only what the tests show.',
      '- Honor every Spec constraint and security entry. Do not touch canonical state or main.');
  } else if (envelope.kind === 'design') {
    lines.push('',
      'Task: propose the Design as intent, not architecture: screens (S1...), visual rules (V1...),',
      'states (T1..., each on a screen id), interactions (I1..., each on a screen id), content rules',
      '(N1...), and acceptance criteria (D1...). Name no technology; the Plan decides how to build.');
  }
  return lines.join('\n');
}

function runProvider(argv, prompt, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const bin = argv[0] === 'node' ? process.execPath : argv[0];
    let child;
    let cwd = null;
    const dropCwd = () => { if (cwd) { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {   } cwd = null; } };
    try {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-seat-cwd-'));
      child = spawn(bin, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: seatEnv(process.env), cwd });
    } catch (err) {
      dropCwd();
      return resolve({ outcome: 'transport_error', detail: 'spawn failed: ' + err.message });
    }
    let out = '';
    let errOut = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { errOut += c; if (errOut.length > 64000) errOut = errOut.slice(-64000); });
    child.on('error', (err) => {
      clearTimeout(timer);
      dropCwd();
      resolve({ outcome: 'transport_error', detail: 'provider process error: ' + err.message, elapsed_ms: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      dropCwd();
      const elapsed = Date.now() - started;
      if (killed) return resolve({ outcome: 'timeout', detail: `provider killed at ${timeoutMs}ms`, elapsed_ms: elapsed });
      if (code !== 0) {
        return resolve({ outcome: 'transport_error', detail: `provider exit ${code}${signal ? ' signal ' + signal : ''}`, stderr: errOut.slice(-2000), elapsed_ms: elapsed });
      }
      resolve({ outcome: 'answered', text: out, stderr: errOut.slice(-2000), elapsed_ms: elapsed });
    });
    child.stdin.on('error', () => {});
    // A binary with no stdin channel gets a closed stdin at once (an empty chunk is never written).
    if (prompt) child.stdin.end(prompt); else child.stdin.end();
  });
}

function unwrapClaude(text) {
  const raw = String(text == null ? '' : text);
  let events = null;
  try {
    const single = JSON.parse(raw);
    if (single && typeof single === 'object' && !Array.isArray(single)) events = [{ type: 'result', ...single }];
  } catch { events = null; }
  if (!events) {
    events = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { const e = JSON.parse(t); if (e && typeof e === 'object') events.push(e); } catch {   }
    }
  }
  const result = [...events].reverse().find((e) => e.type === 'result') || null;
  if (!result) return { outcome: 'transport_error', detail: 'unreadable provider wrapper: ' + raw.slice(-300) };
  if (result.is_error) {
    const refusal = outcomes.refusalFromWrapper(result);
    const detail = [result.subtype, result.terminal_reason, result.api_error_status, result.errors && result.errors.join('; ')]
      .filter(Boolean).join(' | ').slice(0, 400);
    if (refusal) return { outcome: 'refused', detail: refusal + ': ' + detail };
    return { outcome: 'transport_error', detail: 'is_error: ' + detail };
  }
  let assembled = '';
  for (const e of events) {
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) if (b && b.type === 'text' && typeof b.text === 'string') assembled += b.text;
  }
  return { outcome: 'answered', text: assembled || String(result.result != null ? result.result : '') };
}

async function runCard(cardJson) {
  const c = JSON.parse(cardJson);
  const envelope = JSON.parse(c.body);
  const argv = (envelope.provider && envelope.provider.command) || null;
  if (!argv || !argv.length) return { outcome: 'transport_error', detail: 'no provider command in the card' };
  const { system, prompt } = sealedPrompt(envelope);
  const timeoutMs = Number(envelope.timeout_ms) || 600000;
  const ch = invocations.channelsFor(argv[0]);
  let cmd = argv.slice();
  const systemOnArg = Boolean(ch.system && ch.system.channel === 'arg' && Buffer.byteLength(system) < ch.system.max_bytes);
  if (systemOnArg) cmd = [...cmd, ch.system.flag, system];
  const message = systemOnArg ? prompt : buildPrompt(envelope);
  let stdin = '';
  let cleanup = null;
  if (ch.prompt.channel === 'file') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-seat-'));
    const file = path.join(dir, 'prompt.txt');
    fs.writeFileSync(file, message, { mode: 0o600 });
    cmd = [...cmd, ch.prompt.flag, file];
    cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {   } };
  } else {
    stdin = message;
  }
  const ran = await runProvider(cmd, stdin, timeoutMs);
  if (cleanup) cleanup();
  if (ran.outcome !== 'answered') return ran;
  const unwrapped = ch.unwrap === 'claude-stream-json' ? unwrapClaude(ran.text) : { outcome: 'answered', text: ran.text };
  if (unwrapped.outcome !== 'answered') return { ...unwrapped, elapsed_ms: ran.elapsed_ms };
  const parsed = outcomes.extractJson(unwrapped.text);
  const normalized = parsed.ok ? outcomes.normalizeResult(envelope.result_schema, parsed.value) : { value: null, folded: [] };
  const classified = outcomes.classifyParsed(parsed.ok ? { ok: true, value: normalized.value } : parsed, schemaFor(envelope.result_schema), validate);
  if (normalized.folded.length) {
    classified.normalized = { folded: normalized.folded };
    classified.normalizations = [...(classified.normalizations || []), 'fold'];
  }
  return { ...classified, elapsed_ms: ran.elapsed_ms, prompt_chars: message.length + (systemOnArg ? system.length : 0) };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const raw = await readStdin();
  let outcome;
  try {
    outcome = await runCard(raw.trim());
  } catch (err) {
    outcome = { outcome: 'transport_error', detail: 'runner error: ' + err.message };
  }
  process.stdout.write(JSON.stringify(outcome) + '\n');
}

module.exports = { main, buildPrompt, runCard, unwrapClaude, seatEnv };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('seat runner crashed: ' + err.message + '\n');
    process.exit(1);
  });
}
