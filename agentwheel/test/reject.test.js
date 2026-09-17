'use strict';
const { resetStore } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Wheel } = require('../lib/wheel');
const { createStubTransport } = require('../lib/transport');
const gates = require('../lib/gates');
const { appRoot } = require('../lib/paths');
const { INTENT } = require('../lib/compile');
const cargo = require('./tiny-cargo');

function ok(r) {
  assert.equal(r.ok, true, r.error || 'turn failed');
  return r;
}

const REJECT_BYTES = Buffer.from('rejected, optimize');

function newWheel() {
  const transport = createStubTransport();
  return { wheel: new Wheel({ transport }), transport };
}

function driveToDesignStage(wheel) {
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(wheel.state.frontier.stage, 'design');
}

function proposeDesign(wheel) {
  ok(wheel.runTurn({ type: 'seat_dispatch', kind: 'design' }));
  assert.equal(wheel.state.pending_dispatch.kind, 'design');
  ok(wheel.runTurn({ type: 'egress' }));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result', result: cargo.design() }));
}

test('A7: REJECT at DESIGN_READY makes the next prompt begin with the exact bytes of REJECTED_OPTIMIZE_V1, and the restaged node is the chosen target, default design', () => {
  resetStore();
  const { wheel, transport } = newWheel();
  driveToDesignStage(wheel);

  proposeDesign(wheel);
  assert.equal(wheel.state.gate.id, 'DESIGN_READY');
  assert.equal(wheel.state.gate.def.question, 'The Design is ready. Approve, reply/ask, summary, or reject?');
  assert.equal(wheel.state.gate.author.seat, 'leader');
  assert.equal(wheel.state.nodes.design.versions[0].state, 'staged');
  assert.equal(wheel.state.nodes.design.versions[0].authored_by, 'seat');
  const firstPrompt = wheel.state.dispatches[Object.keys(wheel.state.dispatches).at(-1)].superdoc.prompt;
  assert.equal(firstPrompt, INTENT.design, 'before any rejection the prompt is the normalized intent');

  const r = ok(wheel.runTurn({ type: 'gate', action: 'REJECT', reply: 'fewer moving parts' }));
  assert.equal(r.result.target, 'design');
  assert.equal(r.result.reopened, 'design');
  assert.equal(wheel.state.nodes.design.versions[0].state, 'rejected');
  assert.equal(wheel.state.nodes.design.reopened, true);
  assert.equal(wheel.state.nodes.design.rejected_note, 'rejected, optimize - fewer moving parts');
  assert.equal(wheel.state.last_failure.kind, 'design');
  assert.equal(wheel.state.frontier.stale[0], 'design', 'the restaged node');
  assert.ok(wheel.state.frontier.next_legal.includes('seat_dispatch'));
  assert.ok(wheel.state.frontier.next_legal.includes('form:design'));
  assert.equal(wheel.state.nodes.experience.versions.at(-1).state, 'accepted', 'the sound Experience is untouched');

  ok(wheel.runTurn({ type: 'seat_dispatch', kind: 'design' }));
  const pd = wheel.state.pending_dispatch;
  assert.equal(pd.kind, 'design');
  assert.equal(pd.seat, 'leader');
  const prompt = pd.superdoc.prompt;
  assert.equal(Buffer.compare(Buffer.from(prompt).subarray(0, REJECT_BYTES.length), REJECT_BYTES), 0, 'exact bytes');
  assert.ok(prompt.startsWith(gates.prefixText('REJECTED_OPTIMIZE_V1') + ' - fewer moving parts'));
  assert.ok(pd.superdoc.prefixes.includes('rejected, optimize - fewer moving parts'), 'the rare prefix is among the matching prefixes');
  const sys = pd.superdoc.system_prompt;
  assert.ok(sys.startsWith(gates.prefixText('ALWAYS_ON_V1')), 'the system prompt begins with ALWAYS_ON_V1');
  const order = [
    gates.prefixText('ALWAYS_ON_V1'), 'rejected, optimize - fewer moving parts', 'STAGE/SEAT:', 'GATE/AUTHORITY:',
    'WRITE/TOOL SCOPE:', 'WIKI TEMP:', 'EXPANDED CONTEXT', 'NORMALIZED INTENT:', 'EVIDENCE:', 'REQUIRED TURN RESULT SCHEMA',
  ];
  let last = -1;
  for (const marker of order) {
    const i = sys.indexOf(marker);
    assert.ok(i > last, `system prompt section out of order or missing: ${marker}`);
    last = i;
  }
  ok(wheel.runTurn({ type: 'egress' }));
  const card = transport.listCards().find((c) => c.id === wheel.state.pending_seat.card_id);
  const envelope = JSON.parse(card.body);
  assert.equal(Buffer.compare(Buffer.from(envelope.prompt).subarray(0, REJECT_BYTES.length), REJECT_BYTES), 0, 'the card carries the same first bytes');
  assert.equal(envelope.superdoc.hash, pd.context_hash, 'the prompt bytes are inside the sealed, hashed document');

  ok(wheel.runTurn({ type: 'seat_result', card_id: card.id, outcome: 'result', result: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  assert.equal(wheel.state.nodes.design.versions.at(-1).state, 'accepted');
  assert.equal(wheel.state.nodes.design.rejected_note, null);
  assert.equal(wheel.state.frontier.stage, 'spec');
  wheel.close();
});

test('A15: REJECT routes on the enum target, default design; the reply is the repair text and is never parsed for routing; the prose router exists nowhere in the tree', () => {
  resetStore();
  const { wheel } = newWheel();
  driveToDesignStage(wheel);
  proposeDesign(wheel);
  const words = 'the problem and solution read fine but the experience and the spec disagree; fix the experience first';
  const r = ok(wheel.runTurn({ type: 'gate', action: 'REJECT', reply: words }));
  assert.equal(r.result.target, 'design');
  assert.equal(r.result.reopened, 'design');
  assert.equal(wheel.state.nodes.design.reopened, true);
  for (const kind of ['idea', 'experience']) assert.equal(wheel.state.nodes[kind].reopened, false, kind + ' untouched by prose');
  assert.equal(wheel.state.nodes.experience.stale, false);
  assert.equal(wheel.state.nodes.design.versions[0].state, 'rejected');
  assert.equal(wheel.state.nodes.design.rejected_note, 'rejected, optimize - ' + words, 'the reply is the repair instruction under the exact prefix, untouched');
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  const s = ok(wheel.runTurn({ type: 'gate', action: 'REJECT', reply: 'fewer moving parts', target: 'experience' }));
  assert.equal(s.result.target, 'experience');
  assert.equal(s.result.reopened, 'experience');
  assert.equal(wheel.state.nodes.experience.reopened, true);
  assert.equal(wheel.state.nodes.design.versions.at(-1).state, 'rejected');
  assert.equal(wheel.state.nodes.design.rejected_note, 'rejected, optimize - fewer moving parts');
  assert.equal(wheel.state.frontier.stale[0], 'experience');
  assert.ok(wheel.state.frontier.next_legal.includes('form:experience'));
  wheel.close();
  assert.deepEqual(gates.gateDef('DESIGN_READY').params.REJECT.target, { enum: ['idea', 'experience', 'design'], default: 'design' });
  resetStore();
  const second = newWheel().wheel;
  driveToDesignStage(second);
  proposeDesign(second);
  const bad = second.runTurn({ type: 'gate', action: 'REJECT', reply: 'the solution statement is wrong', target: 'spec' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /REJECT target must be one of idea, experience, design \(default design\)/);
  assert.equal(second.state.nodes.design.versions.at(-1).state, 'staged', 'a refused turn changes nothing');
  assert.equal(second.state.gate.id, 'DESIGN_READY');
  assert.equal(ok(second.runTurn({ type: 'gate', action: 'REJECT', reply: 'the solution statement is wrong' })).result.reopened, 'design', 'the word solution routes nothing');
  ok(second.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  assert.equal(ok(second.runTurn({ type: 'gate', action: 'REJECT', reply: 'start over', target: 'idea' })).result.reopened, 'idea');
  assert.equal(second.state.nodes.idea.reopened, true);
  second.close();
  const name = 'earliestResponsible' + 'For';
  const hits = [];
  const skip = new Set(['node_modules', '.git', 'release', '.convobus']);
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html|json|md|sh|swift|txt|plist)$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes(name)) hits.push(path.relative(appRoot, full));
    }
  })(appRoot);
  assert.deepEqual(hits, [], 'the prose router must exist nowhere in the tree');
});

test('the human form path still works: a human-authored Design rejected and restaged carries the same prefix', () => {
  resetStore();
  const { wheel } = newWheel();
  driveToDesignStage(wheel);
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  assert.equal(wheel.state.gate.author.seat, 'human');
  assert.equal(wheel.state.nodes.design.versions[0].authored_by, 'human');
  ok(wheel.runTurn({ type: 'gate', action: 'REJECT', reply: 'tighter' }));
  assert.equal(wheel.state.nodes.design.rejected_note, 'rejected, optimize - tighter');
  ok(wheel.runTurn({ type: 'seat_dispatch', kind: 'design' }));
  assert.ok(wheel.state.pending_dispatch.superdoc.prompt.startsWith('rejected, optimize - tighter'));
  wheel.close();
});
