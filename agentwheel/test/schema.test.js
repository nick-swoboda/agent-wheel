'use strict';
require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validate, NODE_SCHEMAS, EXECUTION_SUBMISSION, TRIAL_KIT, REVIEW_RESULT, SUPPORTED_KEYWORDS, DIALECT, SHIPPED_SCHEMAS,
  SchemaError, checkSchema, KINDS, BUDGET_SET, LEGACY_SPEC, templateFor,
} = require('../lib/schema');

test('idea schema: exactly two fields, both required', () => {
  const good = {
    problem: 'People cannot split a bill fast enough at the table.',
    solution: 'One local screen that divides the total with tip per person.',
  };
  assert.equal(validate(NODE_SCHEMAS.idea, good).ok, true);

  const missing = validate(NODE_SCHEMAS.idea, { problem: good.problem });
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /solution/);

  const extra = validate(NODE_SCHEMAS.idea, { ...good, extra_field: 'nope' });
  assert.equal(extra.ok, false);
  assert.match(extra.errors[0], /unexpected property/);

  const short = validate(NODE_SCHEMAS.idea, { problem: 'too short', solution: good.solution });
  assert.equal(short.ok, false);
});

test('plan schema: recursive $ref graph with kinds, dependencies, and executor-tagged evidence validates', () => {
  const trial = (status) => ({ status, evidence: [{ basis: 'executable_test', executor: 'engine', ok: status === 'passed', detail: 'exit=0' }], not_applicable: { math: 'no arithmetic applies' } });
  const leaf = (id, kind) => ({
    id, title: 'try something real', kind: kind || 'action', needs: [], after: [], serves: ['L1'], claim_refs: ['R1'],
    decomposes_into: [], required: true, risk: 'normal', trial: trial('passed'),
  });
  const decision = {
    ...leaf('L1.3', 'decision'),
    trial: {
      status: 'passed', evidence: [], not_applicable: {},
      alternatives: [
        { id: 'ALT1', name: 'way one', summary: 'the first way to do it', feasible: true, evidence: [{ basis: 'executable_test', executor: 'engine', ok: true, detail: 'built' }] },
        { id: 'ALT2', name: 'way two', summary: 'the second way to do it', feasible: false, evidence: [{ basis: 'executable_test', executor: 'engine', ok: false, detail: 'exit=1' }] },
      ],
      chosen: 'ALT1', rationale: 'only one built', basis_of_decision: 'only_one_feasible',
    },
  };
  const plan = {
    root: {
      id: 'L1', title: 'deliver it all', kind: 'expected_result', needs: [], after: [], serves: [], claim_refs: ['solution'],
      decomposes_into: [leaf('L1.1'), leaf('L1.2', 'assumption'), decision], required: true, risk: 'normal',
      trial: { status: 'passed', evidence: [{ basis: 'first_principles', executor: 'engine', ok: true, detail: 'children settled' }], not_applicable: {} },
    },
    trial_stages: [['L1.1', 'L1.2'], ['L1.3']],
    decision: { leaf: 'L1.3', chosen: 'ALT1', rationale: 'only one built', basis: 'only_one_feasible' },
    summary: { leaves: 3, passed: 3, untried: 0, gaps: 0, conflicts: 0, high_risk: [] },
  };
  assert.equal(validate(NODE_SCHEMAS.plan, plan).ok, true);

  plan.root.decomposes_into[0].trial.status = 'exploded';
  let bad = validate(NODE_SCHEMAS.plan, plan);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /enum/);
  plan.root.decomposes_into[0].trial.status = 'passed';
  plan.root.decomposes_into[0].trial.evidence[0].executor = 'oracle';
  bad = validate(NODE_SCHEMAS.plan, plan);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /executor/);
  plan.root.decomposes_into[0].trial.evidence[0].executor = 'model';
  plan.root.decomposes_into[0].kind = 'wish';
  assert.equal(validate(NODE_SCHEMAS.plan, plan).ok, false, 'node kinds are closed');
});

test('the budget authority ladder is closed, and the Spec no longer carries it', () => {
  const spec = require('./tiny-cargo').spec('/tmp/x');
  assert.equal(validate(NODE_SCHEMAS.spec, spec).ok, true);
  assert.ok(!('budget' in spec), 'a Spec written now carries no budget');
  assert.ok(!NODE_SCHEMAS.spec.required.includes('budget'));
  assert.ok(!('budget' in templateFor(NODE_SCHEMAS.spec)), 'and the form does not ask for one');
  const old = { ...spec, route_allowlist: ['claude:cli'], budget: { authority: '50', window: '1 week' } };
  assert.equal(validate(LEGACY_SPEC, old).ok, true, 'historical storage retains its schema');
  assert.equal(validate(NODE_SCHEMAS.spec, old).ok, false, 'new Specs cannot configure agents or budget');
  const set = { authority: '25', window: '1 day' };
  assert.deepEqual(BUDGET_SET.properties.authority.enum, ['25', '50', 'unlimited'], 'the scale is exactly {25, 50, unlimited}');
  assert.equal(validate(BUDGET_SET, set).ok, true);
  assert.equal(validate(BUDGET_SET, { ...set, authority: '500' }).ok, false);
  assert.equal(validate(BUDGET_SET, { ...set, authority: '5' }).ok, false, 'nothing below 25');
  assert.equal(validate(BUDGET_SET, { ...set, authority: '50' }).ok, true);
  assert.equal(validate(BUDGET_SET, { ...set, window: '2 days' }).ok, false, 'windows are the enum {5 hours, 1 day, 1 week, 1 month}');
  spec.route_allowlist = [];
  assert.equal(validate(NODE_SCHEMAS.spec, spec).ok, false, 'an empty allowlist is refused');
  spec.route_allowlist = ['claude:cli:claude-cli'];
  assert.equal(validate(NODE_SCHEMAS.spec, spec).ok, false, 'route ids are the law\'s exact names');
  spec.route_allowlist = ['grok:cli', 'chatgpt:codex'];
  assert.equal(validate(NODE_SCHEMAS.spec, spec).ok, false, 'registered routes are still not a Spec field');
  assert.equal(validate(NODE_SCHEMAS.spec, { ...spec, routes: [{ id: 'claude:cli' }] }).ok, false, 'no seat routes in the Spec');
});

test('design schema: every claim carries a stable id of its own scheme; states and interactions name a screen; nothing else is allowed', () => {
  const design = require('./tiny-cargo').design();
  assert.equal(validate(NODE_SCHEMAS.design, design).ok, true);
  const badId = structuredClone(design);
  badId.visual[0].id = 'X1';
  assert.ok(validate(NODE_SCHEMAS.design, badId).errors.some((e) => /visual\[0\]\.id/.test(e)), 'ids follow their scheme');
  const noScreen = structuredClone(design);
  delete noScreen.states[0].screen;
  assert.ok(validate(NODE_SCHEMAS.design, noScreen).errors.some((e) => /missing required "screen"/.test(e)));
  const tech = structuredClone(design);
  tech.architecture = 'a data model the Plan decides';
  assert.match(validate(NODE_SCHEMAS.design, tech).errors[0], /unexpected property "architecture"/);
  for (const field of ['screens', 'visual', 'states', 'interactions', 'content', 'acceptance']) {
    const empty = structuredClone(design);
    empty[field] = [];
    assert.equal(validate(NODE_SCHEMAS.design, empty).ok, false, field + ' needs at least one claim');
  }
  const submission = require('./tiny-cargo').executionSubmission(['L1.1.A1']);
  assert.equal(validate(EXECUTION_SUBMISSION, submission).ok, true);
  assert.equal(validate(EXECUTION_SUBMISSION, { ...submission, leaves: [] }).ok, false);
  assert.equal(validate(EXECUTION_SUBMISSION, { ...submission, leaves: ['nope'] }).ok, false);
  assert.equal(validate(EXECUTION_SUBMISSION, { ...submission, build_command: 'make' }).ok, false);
  assert.equal(validate(EXECUTION_SUBMISSION, { ...submission, build_command: 'node build.js' }).ok, true);
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resetStore } = require('./isolate');
const { Wheel } = require('../lib/wheel');
const { collectLeaves } = require('../lib/plan');
const { createStubTransport } = require('../lib/transport');
const { currentAccepted } = require('../lib/nodes');
const { validateShape } = require('../lib/commit');
const forms = require('../lib/forms');
const storelib = require('../lib/store');
const cargo = require('./tiny-cargo');

function walkSchema(schema, p, visit) {
  visit(schema, p);
  if (schema.$defs) for (const [n, s] of Object.entries(schema.$defs)) walkSchema(s, `${p}/$defs/${n}`, visit);
  if (schema.properties) for (const [n, s] of Object.entries(schema.properties)) walkSchema(s, `${p}.${n}`, visit);
  if (schema.additionalProperties && schema.additionalProperties !== false) walkSchema(schema.additionalProperties, `${p}.*`, visit);
  if (schema.items) walkSchema(schema.items, `${p}[]`, visit);
  if (schema.anyOf) schema.anyOf.forEach((s, i) => walkSchema(s, `${p}|${i}`, visit));
}

function ok(r) {
  assert.equal(r.ok, true, r.error || 'turn failed');
  return r;
}

test('A10: every node body schema declares the 2020-12 dialect and is strict: additionalProperties = false at every object level', () => {
  let objects = 0;
  let maps = 0;
  for (const [kind, schema] of Object.entries({ ...NODE_SCHEMAS, legacy_spec: LEGACY_SPEC })) {
    assert.equal(schema.$schema, DIALECT, kind + ' declares its dialect');
    assert.equal(schema.type, 'object', kind);
    assert.equal(schema.additionalProperties, false, kind);
    walkSchema(schema, kind, (s, p) => {
      const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
      if (!types.includes('object')) return;
      if (s.properties) {
        assert.equal(s.additionalProperties, false, p + ' must refuse unknown fields');
        objects++;
      } else {
        assert.ok(s.additionalProperties && typeof s.additionalProperties === 'object', p + ': a map must type its values');
        maps++;
      }
    });
  }
  assert.ok(objects >= 25, 'object levels checked: ' + objects);
  assert.ok(maps >= 1, 'typed maps checked: ' + maps);
  for (const [name, s] of [['EXECUTION_SUBMISSION', EXECUTION_SUBMISSION], ['TRIAL_KIT', TRIAL_KIT], ['REVIEW_RESULT', REVIEW_RESULT]]) {
    assert.equal(s.$schema, DIALECT, name);
    assert.equal(s.additionalProperties, false, name);
  }
  for (const [name, s] of Object.entries(SHIPPED_SCHEMAS)) assert.equal(checkSchema(s), true, name);
});

test('A10: an unknown field is refused at the Form Service before commit, for every form node kind and the seat submission; the single writer refuses it in any stored body', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const wheel = new Wheel({ transport: createStubTransport() });

  const idea = cargo.ideaText();
  const ideaRefused = forms.admit(null, 'idea', { problem: idea.problem, solution: idea.solution, extra_field: 'MARKER-a10' });
  assert.equal(ideaRefused.ok, false);
  assert.equal(ideaRefused.stage, 'schema');
  assert.match(ideaRefused.errors[0], /unexpected property "extra_field"/);

  const refuse = (kind, content) => {
    const before = storelib.readEvents(wheel.paths).events.length;
    const versions = wheel.state.nodes[kind].versions.length;
    const r = wheel.runTurn({ type: 'form', kind, content: { ...content, extra_field: 'MARKER-a10' } });
    assert.equal(r.ok, false, kind);
    assert.equal(r.schema_repair, true, kind);
    assert.match(r.error, /unexpected property "extra_field"/);
    assert.equal(wheel.state.nodes[kind].versions.length, versions, kind + ': nothing staged');
    const { events } = storelib.readEvents(wheel.paths);
    assert.equal(events.length, before + 1, kind + ': one refusal event, no body commit');
    assert.equal(events.at(-1).type, 'schema_reject');
    assert.ok(!events.some((e) => JSON.stringify(e).includes('MARKER-a10')), kind + ': the refused body never entered storage');
  };

  ok(wheel.runTurn({ type: 'spool', ...idea }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  refuse('experience', cargo.experience());
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  refuse('design', cargo.design());
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  refuse('spec', cargo.spec(outDir));
  const nestedSpec = cargo.spec(outDir);
  nestedSpec.release.note = 'MARKER-a10';
  const nested = wheel.runTurn({ type: 'form', kind: 'spec', content: nestedSpec });
  assert.equal(nested.ok, false);
  assert.match(nested.error, /\$\.release: unexpected property "note"/);
  ok(cargo.submitSpec(wheel, outDir, '25'));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
  ok(wheel.runTurn({ type: 'plan_trial', kit: cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft)) }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));

  const group = wheel.state.frontier.leaves;
  const pre = wheel.preCheck(wheel.state, { type: 'execute', submission: { ...cargo.executionSubmission(group), extra_field: 'MARKER-a10' } });
  assert.equal(pre.ok, false);
  assert.match(pre.errors[0], /unexpected property "extra_field"/);
  const before = storelib.readEvents(wheel.paths).events.length;
  const refused = wheel.runTurn({ type: 'execute', submission: { ...cargo.executionSubmission(group), extra_field: 'MARKER-a10' } });
  assert.equal(refused.ok, false);
  assert.equal(storelib.readEvents(wheel.paths).events.length, before + 1, 'one refusal event, no branch, no execution');
  assert.deepEqual(Object.keys(wheel.state.executions), []);

  const tampered = structuredClone(wheel.state);
  tampered.nodes.plan.versions[0].content.extra_field = 'MARKER-a10';
  assert.throws(() => validateShape(tampered), /schema: plan v1: .*unexpected property "extra_field"/);
  validateShape(wheel.state);
  wheel.close();
});

test('A10: the validator supported subset is enumerated; an unsupported keyword is refused, never ignored; every supported keyword is exercised both ways', () => {
  assert.deepEqual([...SUPPORTED_KEYWORDS], [
    '$schema', '$defs', '$ref',
    'type', 'enum', 'const',
    'properties', 'required', 'additionalProperties',
    'items', 'minItems', 'maxItems',
    'minLength', 'maxLength', 'pattern',
    'minimum', 'maximum',
    'anyOf',
  ]);

  const used = new Set();
  for (const schema of Object.values(SHIPPED_SCHEMAS)) walkSchema(schema, '$', (s) => Object.keys(s).forEach((k) => used.add(k)));
  for (const k of used) assert.ok(SUPPORTED_KEYWORDS.includes(k), 'shipped schemas stay inside the subset: ' + k);
  for (const k of SUPPORTED_KEYWORDS) assert.ok(used.has(k), 'subset keyword unused by any shipped schema: ' + k);

  const refused = [
    [{ type: 'string', format: 'email' }, /unsupported keyword "format"/],
    [{ oneOf: [{ type: 'string' }] }, /unsupported keyword "oneOf"/],
    [{ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, if: { type: 'object' } }, /unsupported keyword "if"/],
    [{ type: 'object', additionalProperties: false, properties: { a: { type: 'string', description: 'x' } } }, /\$\.a: unsupported keyword "description"/],
    [{ $ref: 'https://example.com/x.json' }, /only local \$ref/],
    [{ $ref: '#/$defs/missing' }, /unresolved \$ref/],
    [{ type: 'object', additionalProperties: true }, /must be false or a schema/],
    [{ type: 'object', properties: { a: { type: 'string' } } }, /must set additionalProperties = false/],
    [{ type: 'object', additionalProperties: false, properties: { a: { $schema: DIALECT, type: 'string' } } }, /\$schema is allowed only at the root/],
    [{ $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' }, /dialect must be/],
    [{ type: 'thing' }, /unknown type "thing"/],
    [{ type: 'string', pattern: '(' }, /pattern does not compile/],
    [{ enum: [] }, /enum must be a non-empty array/],
  ];
  for (const [schema, re] of refused) {
    assert.throws(() => validate(schema, 'x'), re);
    assert.throws(() => validate(schema, 'x'), SchemaError);
  }

  const probes = [
    ['$schema', { $schema: DIALECT, type: 'string' }, 'a', 1],
    ['$defs + $ref', { $defs: { s: { type: 'string', minLength: 1 } }, type: 'object', additionalProperties: false, properties: { a: { $ref: '#/$defs/s' } } }, { a: 'x' }, { a: '' }],
    ['type', { type: 'integer' }, 3, 3.5],
    ['type (list)', { type: ['string', 'null'] }, null, 1],
    ['enum', { enum: ['a', null] }, null, 'b'],
    ['const', { const: true }, true, false],
    ['properties', { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, { a: 'x' }, { a: 1 }],
    ['required', { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } }, { a: 'x' }, {}],
    ['additionalProperties = false', { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, { a: 'x' }, { a: 'x', b: 1 }],
    ['additionalProperties (typed map)', { type: 'object', additionalProperties: { type: 'string' } }, { k: 'v' }, { k: 1 }],
    ['items', { type: 'array', items: { type: 'string' } }, ['a'], [1]],
    ['minItems', { type: 'array', minItems: 1, items: { type: 'string' } }, ['a'], []],
    ['maxItems', { type: 'array', maxItems: 1, items: { type: 'string' } }, ['a'], ['a', 'b']],
    ['minLength', { type: 'string', minLength: 2 }, 'ab', 'a'],
    ['maxLength', { type: 'string', maxLength: 2 }, 'ab', 'abc'],
    ['pattern', { type: 'string', pattern: '^A[0-9]+$' }, 'A1', 'B1'],
    ['minimum', { type: 'number', minimum: 1 }, 1, 0],
    ['maximum', { type: 'number', maximum: 1 }, 1, 2],
    ['anyOf', { anyOf: [{ type: 'string' }, { type: 'null' }] }, null, 1],
  ];
  const probed = new Set();
  for (const [name, schema, good, bad] of probes) {
    assert.deepEqual(validate(schema, good), { ok: true, errors: [] }, name + ' accepts ' + JSON.stringify(good));
    assert.equal(validate(schema, bad).ok, false, name + ' refuses ' + JSON.stringify(bad));
    walkSchema(schema, '$', (s) => Object.keys(s).forEach((k) => probed.add(k)));
  }
  for (const k of SUPPORTED_KEYWORDS) assert.ok(probed.has(k), 'supported keyword not probed both ways: ' + k);
});

test('A10: every accepted node body of a full circle validates against its strict schema, and the single writer re-validates every stored version', () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const wheel = new Wheel({ transport: createStubTransport() });
  ok(wheel.runTurn({ type: 'spool', ...cargo.ideaText() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'experience', content: cargo.experience() }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'form', kind: 'design', content: cargo.design() }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  ok(cargo.submitSpec(wheel, outDir, '25'));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'plan_generate' }));
  ok(wheel.runTurn({ type: 'plan_trial', kit: cargo.trialKit(collectLeaves(wheel.state.nodes.plan.draft)) }));
  ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  ok(wheel.runTurn({ type: 'gate', action: 'APPROVE' }));
  while (wheel.state.frontier.stage === 'execution') {
    ok(wheel.runTurn({ type: 'execute', submission: cargo.executionSubmission(wheel.state.frontier.leaves) }));
    ok(wheel.runTurn({ type: 'validate', action: 'ACCEPT' }));
  }
  ok(wheel.runTurn({ type: 'finalize' }));
  ok(wheel.runTurn({ type: 'seat_dispatch' }));
  ok(wheel.runTurn({ type: 'egress' }));
  ok(wheel.runTurn({ type: 'seat_result', card_id: wheel.state.pending_seat.card_id, outcome: 'result', result: { decision: 'accept', references: ['closure'], notes: 'all ok' } }));
  ok(wheel.runTurn({ type: 'project_done' }));
  assert.equal(wheel.state.status, 'purple');
  for (const kind of KINDS) {
    const cur = currentAccepted(wheel.state.nodes[kind]);
    assert.ok(cur, kind + ' accepted');
    assert.deepEqual(validate(NODE_SCHEMAS[kind], cur.content), { ok: true, errors: [] }, kind + ' body validates');
  }
  validateShape(wheel.state);
  wheel.close();
});
