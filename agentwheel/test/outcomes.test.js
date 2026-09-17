'use strict';
const { resetStore } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wheel } = require('../lib/wheel');
const { collectLeaves } = require('../lib/plan');
const { createStubTransport } = require('../lib/transport');
const { BACKOFF_MS, OUTCOMES } = require('../lib/transport/outcomes');
const { auditTail } = require('../lib/store');
const gates = require('../lib/gates');
const cargo = require('./tiny-cargo');

function ok(r) {
  assert.equal(r.ok, true, r.error || 'turn failed');
  return r;
}

const SOLO = ['claude:cli'];
const ROUTE = 'claude:cli';

function clock(startIso) {
  let t = Date.parse(startIso);
  const fn = () => new Date(t).toISOString();
  fn.advance = (ms) => { t += ms; };
  return fn;
}

function newWheel(now) {
  const transport = createStubTransport();
  return { wheel: new Wheel({ transport, now }), transport };
}

function driveToPlanDraft(wheel, outDir) {
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(cargo.submitSpec(wheel, outDir, 'unlimited', SOLO));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
}

test('A8: a timeout never enters schema validation, is not a schema attempt, is redispatched with backoff (the same sealed document, same route), and after three the gate names "timeout" and the route', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const now = clock('2026-09-01T10:00:00.000Z');
  const { wheel, transport } = newWheel(now);
  driveToPlanDraft(wheel, outDir);
  assert.deepEqual(OUTCOMES, ['result', 'malformed', 'transport_error', 'timeout', 'refused']);

  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const original = wheel.state.pending_dispatch;
  ok(wheel.runTurn({ type: 'egress' }));
  const firstCard = wheel.state.pending_seat.card_id;
  const dispatchId = wheel.state.pending_seat.dispatch_id;

  let r = ok(wheel.runTurn({ type: 'seat_result', card_id: firstCard, outcome: 'timeout', detail: 'runner killed at 1200000ms' }));
  assert.equal(r.result.outcome, 'timeout');
  assert.equal(r.result.redispatch.backoff_ms, BACKOFF_MS[0]);
  assert.equal(wheel.state.last_schema_reject, null, 'not a schema attempt');
  const classified = auditTail(30, wheel.paths).find((a) => a.event === 'outcome_classified' && a.card === firstCard);
  assert.equal(classified.schema_validation, false, 'never entered schema validation');
  assert.equal(wheel.state.pending_seat, null);
  assert.equal(wheel.state.pending_redispatch.dispatch_id, dispatchId);
  assert.equal(wheel.state.pending_redispatch.route, ROUTE);
  assert.equal(wheel.state.pending_redispatch.due_at, new Date(Date.parse(now()) + 60000).toISOString());
  assert.deepEqual(wheel.state.route_health[ROUTE], { degraded: true, failures: 1, last_outcome: 'timeout', last_failure: now(), last_ok: null },
    'one record shape whichever path wrote it');
  assert.deepEqual(wheel.state.frontier.next_legal.filter((t) => t !== 'reopen'), ['redispatch']);
  assert.equal(wheel.state.status, 'green', 'a transport failure is not a gate yet');

  r = wheel.runTurn({ type: 'redispatch' });
  assert.equal(r.ok, false);
  assert.match(r.error, /backoff not elapsed/);
  now.advance(60000);
  r = ok(wheel.runTurn({ type: 'redispatch' }));
  assert.equal(r.result.redispatched.delivery_attempt, 2);
  const again = wheel.state.pending_dispatch;
  assert.equal(again.dispatch_id, dispatchId);
  assert.equal(again.context_hash, original.context_hash, 'the same sealed Super Document');
  assert.equal(again.superdoc.hash, original.superdoc.hash);
  assert.deepEqual(again.superdoc, original.superdoc);
  assert.equal(again.route, ROUTE, 'the same route');
  ok(wheel.runTurn({ type: 'egress' }));
  const secondCard = wheel.state.pending_seat.card_id;
  assert.notEqual(secondCard, firstCard);
  const env1 = JSON.parse(transport.listCards().find((c) => c.id === firstCard).body);
  const env2 = JSON.parse(transport.listCards().find((c) => c.id === secondCard).body);
  assert.equal(env2.superdoc.hash, env1.superdoc.hash);
  assert.equal(env2.system_prompt, env1.system_prompt);
  assert.equal(env2.prompt, env1.prompt);
  assert.deepEqual(wheel.state.dispatches[dispatchId].cards, [firstCard, secondCard]);

  ok(wheel.runTurn({ type: 'seat_result', card_id: secondCard, outcome: 'timeout', detail: 't' }));
  assert.equal(wheel.state.pending_redispatch.backoff_ms, BACKOFF_MS[1]);
  now.advance(BACKOFF_MS[1]);
  ok(wheel.runTurn({ type: 'redispatch' }));
  ok(wheel.runTurn({ type: 'egress' }));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'timeout', detail: 't' }));
  assert.equal(wheel.state.pending_redispatch.backoff_ms, BACKOFF_MS[2]);
  now.advance(BACKOFF_MS[2]);
  ok(wheel.runTurn({ type: 'redispatch' }));
  ok(wheel.runTurn({ type: 'egress' }));

  r = ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'timeout', detail: 't' }));
  assert.equal(r.result.gate, 'ROUTE_ATTENTION');
  assert.equal(wheel.state.gate.id, 'ROUTE_ATTENTION');
  assert.equal(wheel.state.gate.def.question,
    'This exact route is not ready (timeout: claude:cli). Complete the shown route action, choose another allowed route, or pause the project.');
  assert.equal(wheel.state.status, 'yellow');
  assert.equal(wheel.state.pending_redispatch, null);
  assert.equal(wheel.state.last_schema_reject, null, 'four timeouts, zero schema attempts');
  assert.deepEqual(wheel.state.dispatches[dispatchId].outcomes.map((o) => o.outcome), ['timeout', 'timeout', 'timeout', 'timeout']);
  assert.equal(wheel.state.route_health[ROUTE].failures, 4);
  assert.equal(transport.listCards().length, 4);
  assert.ok(transport.listCards().every((c) => c.state === 'back' && /"outcome":"timeout"/.test(c.reply)));

  ok(wheel.runTurn({ type: 'gate', action: 'COMPLETE_ACTION' }));
  assert.equal(wheel.state.pending_redispatch.dispatch_id, dispatchId);
  ok(wheel.runTurn({ type: 'redispatch' }));
  assert.equal(wheel.state.pending_dispatch.context_hash, original.context_hash);
  ok(wheel.runTurn({ type: 'egress' }));
  const kit = cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result', result: kit }));
  assert.equal(wheel.state.pending_validation.kind, 'plan', 'the fifth delivery answered and was staged');
  assert.equal(wheel.state.route_health[ROUTE].degraded, false, 'a route that answers is not degraded');
  assert.equal(wheel.state.route_health[ROUTE].failures, 0);
  assert.equal(wheel.state.route_health[ROUTE].last_outcome, 'result');
  assert.equal(wheel.state.route_health[ROUTE].last_ok, now());
  assert.ok(wheel.state.route_health[ROUTE].last_failure, 'the last failure is still on the record');
  const answeredAt = wheel.state.route_health[ROUTE].last_ok;
  now.advance(60000);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  ok(wheel.runTurn({ type: 'egress' }));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'timeout', detail: 't' }));
  assert.equal(wheel.state.route_health[ROUTE].degraded, true);
  assert.equal(wheel.state.route_health[ROUTE].last_ok, answeredAt, 'when it last answered survives the next failure');
  assert.equal(wheel.state.route_health[ROUTE].last_failure, now());
  wheel.close();
});

test('A8: malformed gets SCHEMA_REPAIR_ONLY_V1 exactly once; a second malformed on the same dispatch is INTERRUPTED + HUMAN_ESCALATION naming malformed', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const { wheel } = newWheel();
  driveToPlanDraft(wheel, outDir);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const dispatchId = wheel.state.pending_dispatch.dispatch_id;
  assert.ok(!wheel.state.pending_dispatch.superdoc.prefixes.includes(gates.prefixText('SCHEMA_REPAIR_ONLY_V1')));
  ok(wheel.runTurn({ type: 'egress' }));

  let r = ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'malformed', errors: ['$: missing required "leaves"'], detail: 'fails the bound schema' }));
  assert.equal(r.result.schema_repair, true);
  assert.equal(wheel.state.last_schema_reject.attempts, 1);
  assert.equal(wheel.state.last_schema_reject.dispatch_id, dispatchId);
  assert.equal(wheel.state.status, 'green');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  const repair = wheel.state.pending_dispatch;
  assert.equal(repair.dispatch_id, dispatchId, 'the repair belongs to the same dispatch');
  assert.equal(repair.attempt, 1);
  const injected = repair.superdoc.prefixes.filter((p) => p === gates.prefixText('SCHEMA_REPAIR_ONLY_V1'));
  assert.equal(injected.length, 1, 'SCHEMA_REPAIR_ONLY_V1 exactly once');
  assert.equal(repair.superdoc.prefix, gates.prefixText('SCHEMA_REPAIR_ONLY_V1'));
  assert.equal((repair.superdoc.system_prompt.match(/Return the stored result in the exact required schema/g) || []).length, 1);
  assert.deepEqual(repair.superdoc.binding.schema_errors, ['$: missing required "leaves"']);
  ok(wheel.runTurn({ type: 'egress' }));

  r = ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result', result: { still: 'wrong' } }));
  assert.equal(r.result.interrupted, true);
  assert.equal(wheel.state.wheel.phase, 'INTERRUPTED');
  assert.equal(wheel.state.status, 'red');
  assert.equal(wheel.state.interrupted.cause, 'malformed');
  assert.equal(wheel.state.gate.id, 'HUMAN_ESCALATION');
  assert.equal(wheel.state.gate.def.question,
    'Traversal did not produce a decisive resolution (malformed). Choose the accepted direction, request another trial, edit the responsible node, let the node stand and return the finding to the seat, or stop.');
  assert.deepEqual(wheel.state.frontier.next_legal, ['gate']);
  assert.equal(wheel.state.pending_seat, null);

  ok(wheel.runTurn({ type: 'gate', action: 'RETRY' }));
  assert.equal(wheel.state.interrupted, null);
  assert.equal(wheel.state.status, 'green');
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  assert.notEqual(wheel.state.pending_dispatch.dispatch_id, dispatchId);
  assert.equal(wheel.state.pending_dispatch.attempt, 0);
  assert.ok(!wheel.state.pending_dispatch.superdoc.prefixes.includes(gates.prefixText('SCHEMA_REPAIR_ONLY_V1')));
  wheel.close();
});

test('refused and transport_error take the same lane as timeout: uncounted or counted per the law, never a schema attempt', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const now = clock('2026-09-01T10:00:00.000Z');
  const { wheel } = newWheel(now);
  driveToPlanDraft(wheel, outDir);
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  ok(wheel.runTurn({ type: 'egress' }));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'refused', detail: 'HTTP 401' }));
  assert.equal(wheel.state.budget.used, 0, 'refused before the provider ran: not a dispatch');
  assert.equal(wheel.state.pending_redispatch.outcome, 'refused');
  assert.equal(wheel.state.last_schema_reject, null);
  now.advance(60000);
  ok(wheel.runTurn({ type: 'redispatch' }));
  ok(wheel.runTurn({ type: 'egress' }));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'transport_error', detail: 'provider exit 2 | kaboom' }));
  assert.equal(wheel.state.budget.used, 1, 'a transport error after the provider ran counts');
  assert.equal(wheel.state.pending_redispatch.backoff_ms, BACKOFF_MS[1]);
  assert.equal(wheel.state.last_schema_reject, null);
  assert.equal(wheel.state.route_health[ROUTE].last_outcome, 'transport_error');
  wheel.close();
});

test('escape repair: a backslash the model wrote inside a JSON string as a regex or path escape is doubled before the reply is judged; valid JSON is untouched; other damage stays malformed', () => {
  const { extractJson } = require('../lib/transport/outcomes');
  const bad = '{"leaves":{"L1.2.R2":{"bases":{"executable_test":{"applicable":true,"exec":{"files":{"t.js":"if (!/^chapter \\d+/i.test(s)) process.exit(1)"},"entry":"t.js"}}}}}}';
  const r = extractJson(bad);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.repaired, 'escapes');
  assert.equal(r.value.leaves['L1.2.R2'].bases.executable_test.exec.files['t.js'], 'if (!/^chapter \\d+/i.test(s)) process.exit(1)');
  const good = '{"a":"\\\\d+","b":"line\\nbreak","c":"C:\\\\temp"}';
  const g = extractJson(good);
  assert.deepEqual(g, { ok: true, value: { a: '\\d+', b: 'line\nbreak', c: 'C:\\temp' }, normalizations: [] }, 'nothing repaired, nothing recorded');
  const worse = extractJson('{"a": tru}');
  assert.equal(worse.ok, false);
  assert.match(worse.detail, /unparseable JSON/);
});
