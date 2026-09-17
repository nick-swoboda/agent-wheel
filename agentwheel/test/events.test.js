'use strict';
const { resetStore } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../lib/paths');
const { uuidv7, isUuidv7, uuidv7Time } = require('../lib/ids');
const { frame, parseEvents } = require('../lib/events');
const { replay } = require('../lib/reducers');
const storelib = require('../lib/store');
const commitlib = require('../lib/commit');
const { Wheel } = require('../lib/wheel');
const { extract } = require('../scripts/extract-catalog');
const gates = require('../lib/gates');
const cargo = require('./tiny-cargo');

function ok(r) {
  assert.equal(r.ok, true, r.error || 'turn failed');
  return r;
}

test('uuidv7 ids are RFC 9562 version 7, time-ordered, and unique', () => {
  const ids = [];
  for (let i = 0; i < 5000; i++) ids.push(uuidv7());
  assert.equal(new Set(ids).size, ids.length, 'unique');
  for (const id of ids) assert.ok(isUuidv7(id), 'not a v7 uuid: ' + id);
  const sorted = [...ids].sort();
  assert.deepEqual(sorted, ids, 'lexicographic order follows generation order (time-ordered)');
  const t = uuidv7Time(uuidv7(1700000000123));
  assert.equal(t, 1700000000123);
});

test('event framing detects a torn tail and refuses corruption beyond it', () => {
  const a = frame({ seq: 1, id: uuidv7(), ts: '2026-09-01T00:00:00.000Z', turn: 't_1', turn_number: 1, type: 'x', input: {}, facts: {} });
  const b = frame({ seq: 2, id: uuidv7(), ts: '2026-09-01T00:00:01.000Z', turn: 't_2', turn_number: 2, type: 'x', input: {}, facts: {} });
  const clean = parseEvents(a.line + '\n' + b.line + '\n');
  assert.equal(clean.events.length, 2);
  assert.equal(clean.torn, null);

  const torn = parseEvents(a.line + '\n' + b.line.slice(0, 40));
  assert.equal(torn.events.length, 1, 'the cut line is dropped');
  assert.equal(torn.torn.reason, 'unparseable');
  assert.equal(torn.torn.trailing, 0);
  assert.equal(torn.torn.offset, Buffer.byteLength(a.line) + 1, 'offset points at the cut line');

  const tampered = b.line.replace('"type":"x"', '"type":"y"');
  const bad = parseEvents(a.line + '\n' + tampered + '\n');
  assert.equal(bad.events.length, 1);
  assert.equal(bad.torn.reason, 'hash mismatch');

  const gap = parseEvents(b.line + '\n');
  assert.equal(gap.events.length, 0);
  assert.match(gap.torn.reason, /seq 2 where 1 was expected/);

  const middle = parseEvents(a.line + '\n' + 'garbage' + '\n' + b.line + '\n');
  assert.equal(middle.torn.trailing, 1, 'complete lines after a torn one are corruption, not a crash tail');
});

test('replay from zero reproduces byte-identical state; the snapshot is derived from the journal', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const wheel = new Wheel();
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(cargo.submitSpec(wheel, outDir, '25'));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  const { events, torn } = storelib.readEvents(wheel.paths);
  assert.equal(torn, null);
  assert.equal(events.length, 12);
  assert.ok(events.every((e) => isUuidv7(e.id)), 'every event carries a UUIDv7');
  assert.ok(isUuidv7(wheel.state.project.id), 'the project id is a UUIDv7');
  assert.ok(wheel.state.nodes.idea.versions.every((v) => isUuidv7(v.id)), 'versions carry UUIDv7 ids');
  const replayed = replay(events);
  assert.equal(JSON.stringify(replayed), JSON.stringify(wheel.state), 'replay equals the live state');
  assert.equal(fs.readFileSync(wheel.paths.snapshotPath, 'utf8'), commitlib.snapshotBytes(events.length, replayed), 'snapshot bytes are the replay');
  assert.equal(path.dirname(wheel.paths.eventsPath), path.join(paths.projectsDir, wheel.state.project.id), 'the journal lives in store/projects/<uuidv7>/');
  assert.equal(JSON.stringify(replay(events)), JSON.stringify(replayed));
  wheel.close();
});

test('a stale or missing snapshot is rebuilt from the journal on load; the journal wins', () => {
  resetStore();
  const wheel = new Wheel();
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  wheel.close();
  const pp = wheel.paths;
  const good = fs.readFileSync(pp.snapshotPath, 'utf8');
  fs.unlinkSync(pp.snapshotPath);
  const again = new Wheel({ project: wheel.projectId });
  assert.equal(fs.readFileSync(pp.snapshotPath, 'utf8'), good, 'rebuilt byte-identical');
  again.close();
  fs.writeFileSync(pp.snapshotPath, JSON.stringify({ seq: 99, state: { forged: true } }));
  const third = new Wheel({ project: wheel.projectId });
  assert.equal(third.state.seq, 2);
  assert.equal(fs.readFileSync(pp.snapshotPath, 'utf8'), good);
  assert.ok(storelib.auditTail(20, pp).some((a) => a.event === 'snapshot_repaired'));
  third.close();
});

test('a 1.x store is never read: it is archived beside itself on first launch', () => {
  resetStore();
  const legacy = { schema_version: 1, project: { id: 'p_old', name: 'Old' }, status: 'green' };
  fs.writeFileSync(paths.legacyStatePath, JSON.stringify(legacy));
  fs.writeFileSync(paths.auditPath, '{"legacy":true}\n');
  const wheel = new Wheel();
  assert.equal(wheel.state, null, 'the 1.x state was not read');
  assert.ok(wheel.legacyArchive && wheel.legacyArchive.includes('store-archive-1x-'), 'archived beside itself');
  assert.ok(fs.existsSync(path.join(wheel.legacyArchive, 'state.json')), 'nothing deleted');
  assert.equal(fs.readFileSync(path.join(wheel.legacyArchive, 'audit.jsonl'), 'utf8'), '{"legacy":true}\n');
  assert.ok(!fs.existsSync(paths.legacyStatePath));
  assert.ok(storelib.auditTail(5).some((a) => a.event === 'legacy_store_archived'));
  wheel.close();
});

test('a 2.0.0 store is never replayed by revision-4 reducers: it is archived beside itself on first launch', () => {
  resetStore();
  const spool = {
    id: uuidv7(), seq: 1, type: 'turn', turn: 't_1', ts: '2026-08-30T00:00:00.000Z',
    input: { type: 'spool', name: 'Old', problem: 'p'.repeat(30), solution: 's'.repeat(30) },
    facts: { project_id: 'p_old', version_id: 'v_old' },
  };
  const journal = frame(spool).line + '\n';
  fs.writeFileSync(paths.eventsPath, journal);
  fs.writeFileSync(paths.snapshotPath, JSON.stringify({ seq: 1, state: { schema_version: 2, project: { id: 'p_old' } } }));
  const wheel = new Wheel();
  assert.equal(wheel.state, null, 'the 2.0.0 journal was not replayed');
  assert.ok(wheel.legacyArchive && wheel.legacyArchive.includes('store-archive-2.0.0-'), 'archived beside itself: ' + wheel.legacyArchive);
  assert.equal(fs.readFileSync(path.join(wheel.legacyArchive, 'events.jsonl'), 'utf8'), journal, 'the journal moved intact');
  assert.ok(fs.existsSync(path.join(wheel.legacyArchive, 'snapshot.json')), 'nothing deleted');
  assert.ok(!fs.existsSync(paths.eventsPath) && !fs.existsSync(paths.snapshotPath));
  const row = storelib.auditTail(5).find((a) => a.event === 'legacy_store_archived');
  assert.equal(row.schema_version, 2);
  assert.equal(row.store, '2.0.0');
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  assert.equal(wheel.state.schema_version, 5);
  const first = JSON.parse(fs.readFileSync(wheel.paths.eventsPath, 'utf8').split('\n')[0]);
  assert.equal(first.facts.schema_version, 5);
  assert.equal(wheel.state.nodes.idea.versions[0].authored_by, 'human');
  assert.ok(!fs.existsSync(paths.eventsPath), 'revision 4 writes nothing canonical at the top level');
  wheel.close();
  const again = new Wheel({ project: wheel.projectId });
  assert.equal(again.legacyArchive, null);
  assert.equal(again.state.schema_version, 5);
  again.close();
});

test('A18: one store, many projects - each project has its own events.jsonl and lease under store/projects/<uuidv7>/, the index lists them, and each replays byte-identical alone', () => {
  resetStore();
  const a = new Wheel();
  ok(a.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(a.runTurn({ type: 'validate', action: 'ACCEPT' }));
  const b = new Wheel();
  ok(b.runTurn({ type: 'spool', name: 'Second Note', problem: 'p'.repeat(30), solution: 's'.repeat(30) }));
  assert.notEqual(a.projectId, b.projectId);
  for (const w of [a, b]) {
    assert.ok(isUuidv7(w.projectId), 'the project directory is named by its UUIDv7');
    assert.equal(w.state.project.id, w.projectId);
    assert.equal(w.paths.dir, path.join(paths.projectsDir, w.projectId));
    assert.ok(fs.existsSync(w.paths.eventsPath), 'its own events.jsonl');
    assert.ok(fs.existsSync(w.paths.snapshotPath), 'its own snapshot.json');
    assert.ok(fs.existsSync(w.paths.leasePath), 'its own lease.json');
    assert.ok(fs.existsSync(w.paths.auditPath), 'its own audit.jsonl');
    const { events, torn } = storelib.readEvents(w.paths);
    assert.equal(torn, null);
    assert.equal(JSON.stringify(replay(events)), JSON.stringify(w.state), 'replays byte-identical alone');
    assert.equal(fs.readFileSync(w.paths.snapshotPath, 'utf8'), commitlib.snapshotBytes(w.state.seq, replay(events)));
  }
  assert.equal(storelib.readEvents(a.paths).events.length, 2);
  assert.equal(storelib.readEvents(b.paths).events.length, 1, 'the journals are separate');
  const index = JSON.parse(fs.readFileSync(paths.projectsIndexPath, 'utf8'));
  assert.deepEqual(index.projects.map((p) => [p.id, p.name]), [[a.projectId, 'Tiny Note'], [b.projectId, 'Second Note']]);
  assert.deepEqual(storelib.listProjects().map((p) => p.id), [a.projectId, b.projectId]);
  a.close();
  b.close();
  const a2 = new Wheel({ project: a.projectId });
  assert.equal(JSON.stringify(a2.state), JSON.stringify(a.state));
  a2.close();
  fs.unlinkSync(paths.projectsIndexPath);
  assert.deepEqual(storelib.listProjects().map((p) => [p.id, p.name]), [[a.projectId, 'Tiny Note'], [b.projectId, 'Second Note']].sort(), 'the directories are the list when the index is missing');
});

test('A18: a 2.0.x single-project store (schema_version 3) is archived beside itself on first launch, never read', () => {
  resetStore();
  const spool = {
    id: uuidv7(), seq: 1, type: 'turn', turn: 't_1', ts: '2026-09-01T00:00:00.000Z',
    input: { type: 'spool', name: 'Old', problem: 'p'.repeat(30), solution: 's'.repeat(30) },
    facts: { project_id: 'p_old', version_id: 'v_old', schema_version: 3 },
  };
  const journal = frame(spool).line + '\n';
  fs.writeFileSync(paths.eventsPath, journal);
  fs.writeFileSync(paths.snapshotPath, JSON.stringify({ seq: 1, state: { schema_version: 3, project: { id: 'p_old' } } }));
  const wheel = new Wheel();
  assert.equal(wheel.state, null, 'the 2.0.x journal was not replayed');
  assert.ok(wheel.legacyArchive && wheel.legacyArchive.includes('store-archive-2.0.x-'), 'archived beside itself: ' + wheel.legacyArchive);
  assert.equal(fs.readFileSync(path.join(wheel.legacyArchive, 'events.jsonl'), 'utf8'), journal, 'the journal moved intact');
  assert.ok(!fs.existsSync(paths.eventsPath));
  const row = storelib.auditTail(5).find((a) => a.event === 'legacy_store_archived');
  assert.equal(row.schema_version, 3);
  assert.equal(row.store, '2.0.x');
  wheel.close();
});

test('the three catalogs are derived from the law\'s own text', () => {
  const law = fs.readFileSync(paths.lawPath, 'utf8');
  const derived = extract(law);
  assert.deepEqual(gates.catalogs.gates, derived.gates);
  assert.deepEqual(gates.catalogs.human, derived.human);
  assert.deepEqual(gates.catalogs.prefixes, derived.prefixes);
  assert.equal(Object.keys(derived.gates.gates).length, 9);
  assert.deepEqual(Object.keys(derived.gates.gates), ['VALIDATE', 'DESIGN_READY', 'PLAN_READY', 'TEST_READY', 'BUDGET_GATE', 'ROUTE_ATTENTION', 'HUMAN_ESCALATION', 'RECOVERY_REQUIRED', 'REPAIR_REQUIRED']);
  assert.ok(!('APPROACH_READY' in derived.gates.gates) && !('SOLUTION_UNSATISFIED' in derived.gates.gates));
  assert.deepEqual(derived.gates.gates.VALIDATE.actions, ['ACCEPT', 'REJECT_RESTAGE']);
  assert.deepEqual(derived.gates.gates.VALIDATE.applies_to, ['idea', 'experience', 'spec', 'executions']);
  assert.deepEqual(derived.gates.gates.VALIDATE.text_ids, { experience: 'EXPERIENCE_PENDING_V1', spec: 'SPEC_PENDING_V1' });
  assert.equal(derived.gates.gates.VALIDATE.note, 'A fresh turn, deterministic, not a dispatch, never the staging turn.');
  assert.ok(!('IDEA_CONFIRM' in derived.gates.gates) && !('NODE_GATE' in derived.gates.gates));
  assert.ok(!('IDEA_CONFIRM_V1' in derived.human.texts) && !('NODE_CHANGED_V1' in derived.human.texts));
  assert.deepEqual(derived.human.placeholders, ['outcome', 'route', 'cause', 'target']);
  assert.deepEqual(derived.gates.gates.DESIGN_READY.params, { REJECT: { target: { enum: ['idea', 'experience', 'design'], default: 'design' } } });
  assert.equal(derived.gates.gates.DESIGN_READY.transitions[3], 'fail-up to target (default design) under REJECTED_OPTIMIZE_V1');
  assert.deepEqual(derived.gates.gates.PLAN_READY.transitions, ['same gate', 'execution unlocked', 'execution unlocked']);
  assert.deepEqual(derived.gates.gates.BUDGET_GATE.transitions[0], 'next scale step (25 -> 50 -> unlimited)');
  assert.equal(derived.gates.gates.RECOVERY_REQUIRED.note, "RETRY and RESUME first reconcile the adapter's in-flight records against CardBinding.");
  assert.equal(derived.gates.gates.REPAIR_REQUIRED.transitions[0], "EARLIEST_REPAIR_ONLY_V1 on the claim's author");
  assert.equal(Object.keys(derived.prefixes.prefixes).length, 8);
  assert.equal(gates.prefixText('EXECUTE_LEAF_V1'), 'Execute exactly the named leaves on the assigned branch. Return files, tests, and an optional build command; claim only what the tests show. Do not touch canonical state or main.');
  assert.equal(derived.human.texts.DESIGN_READY_V1, 'The Design is ready. Approve, reply/ask, summary, or reject?');
  assert.equal(derived.human.texts.PLAN_READY_V1, 'Plan Trial is complete and the closure proof passed. Summarize, skip optional review, or approve?');
  assert.match(derived.gates.gates.HUMAN_ESCALATION.note, /^Opens with \{cause\}; with \{target\} when a seat named a human-authored node\. NODE_STANDS: the named node is unchanged, byte for byte, and the artifact is wrong\./);
  assert.deepEqual(derived.gates.gates.HUMAN_ESCALATION.actions, ['CHOOSE_DIRECTION', 'RETRY', 'EDIT_NODE', 'NODE_STANDS', 'STOP']);
  assert.equal(derived.gates.gates.HUMAN_ESCALATION.transitions[3], 'the named node stands, the finding returns to the seat');
  assert.equal(derived.human.texts.EXPERIENCE_PENDING_V1, 'Describe the intended behavior and experience, or answer the guided questions. Accept, or reject and restage, when ready.');
  assert.equal(derived.human.texts.SPEC_PENDING_V1, 'Confirm the requirements, constraints, and release target. Accept, or reject and restage, when ready.');
  assert.equal(derived.human.texts.HUMAN_ESCALATION_V1, 'Traversal did not produce a decisive resolution ({cause}{target}). Choose the accepted direction, request another trial, edit the responsible node, let the node stand and return the finding to the seat, or stop.');
  assert.equal(gates.prefixText('REJECTED_OPTIMIZE_V1'), 'rejected, optimize');
  assert.equal(gates.prefixText('ALWAYS_ON_V1').slice(0, 41), 'Use only the supplied current node versio');
});

test('historical Specs replay unchanged; new project controls survive product edits and stay project-local', t => {
  resetStore();
  let wheel = new Wheel();
  t.after(() => wheel.close());
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(wheel.runTurn({ type: 'form', kind: 'spec', content: cargo.spec('/tmp/example-product') }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  const project = wheel.state.project.id;
  const events = storelib.readEvents(wheel.paths).events.map(event => {
    const copy = structuredClone(event);
    delete copy.controls_version;
    if (copy.input.kind === 'spec') Object.assign(copy.input.content, {
      route_allowlist: ['claude:cli'], budget: { authority: '50', window: '1 week' },
    });
    return copy;
  });
  const legacy = replay(events);
  assert.ok(!legacy.controls_version);
  assert.equal(legacy.budget.authority, '50');
  assert.equal(legacy.seats.reviewer.route, 'claude:cli');
  const history = events.map(event => frame(event).line + '\n').join('');
  wheel.close();
  fs.writeFileSync(wheel.paths.eventsPath, history);
  fs.writeFileSync(wheel.paths.snapshotPath, commitlib.snapshotBytes(events.length, legacy));
  wheel = new Wheel({ project });
  assert.deepEqual(wheel.state, legacy);
  const original = JSON.stringify(legacy.nodes.spec.versions[0]);
  const context = require('../lib/compile').expandedContext(legacy, { current_nodes: ['spec'], leaves: [] });
  assert.ok(!('budget' in context.spec.accepted) && !('route_allowlist' in context.spec.accepted));
  const displayed = require('../surfaces/helper').publicState(legacy, null, []);
  assert.ok(!('budget' in displayed.nodes.spec.accepted.content));
  ok(wheel.runTurn({ type: 'budget_set', authority: 'unlimited', window: '1 day' }));
  const cfg = { model: 'gpt-6-astra', effort: 'ultra' };
  ok(wheel.runTurn({ type: 'seat_assignment', seat: 'reviewer', route: 'chatgpt:codex', config: cfg }));
  assert.equal(wheel.state.controls_version, 1);
  assert.ok(fs.readFileSync(wheel.paths.eventsPath, 'utf8').startsWith(history));
  assert.equal(JSON.stringify(wheel.state.nodes.spec.versions[0]), original);
  ok(wheel.runTurn({ type: 'reopen', kind: 'spec' }));
  const product = require('../lib/schema').productSpec(legacy.nodes.spec.versions[0].content);
  assert.equal(wheel.runTurn({ type: 'form', kind: 'spec', content: { ...product, budget: { authority: '25', window: '1 day' } } }).ok, false);
  ok(wheel.runTurn({ type: 'form', kind: 'spec', content: product }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  assert.equal(wheel.state.budget.authority, 'unlimited');
  assert.deepEqual(wheel.state.seats.reviewer, { route: 'chatgpt:codex', cfg });
  assert.deepEqual(replay(storelib.readEvents(wheel.paths).events), wheel.state);
  const other = new Wheel();
  t.after(() => other.close());
  ok(other.runTurn({ type: 'spool', ...cargo.ideaText() }));
  assert.equal(other.state.budget.authority, '25');
  assert.deepEqual(other.state.seats.reviewer.cfg, {});
});
