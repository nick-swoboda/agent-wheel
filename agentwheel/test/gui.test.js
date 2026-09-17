'use strict';
require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { uiPage } = require('../lib/paths');
const { CHIPS } = require('../lib/chips');
const { templateFor, NODE_SCHEMAS } = require('../lib/schema');
const FORM_TEMPLATES = Object.fromEntries(['experience', 'design', 'spec'].map((k) => [k, templateFor(NODE_SCHEMAS[k])]));

class FakeEl {
  constructor(id) {
    this.id = id;
    this.listeners = {};
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.placeholder = '';
    this.className = '';
    this.hidden = false;
    this.dataset = {};
  }
  addEventListener(event, fn) {
    (this.listeners[event] = this.listeners[event] || []).push(fn);
  }
  setAttribute(name, value) { (this.attributes ||= {})[name] = value; }
  set innerHTML(html) {
    this._html = html;
    if (this._peers) {
      for (const [id, elem] of this._peers) {
        if (/^(skey-|key-value$|key-provider$)/.test(id) && html.includes('id="' + id + '"')) elem.value = '';
      }
    }
  }
  get innerHTML() { return this._html === undefined ? '' : this._html; }
  focus() { this.focused = (this.focused || 0) + 1; }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
}

const TOKEN = 'test-launch-token-0123456789';

function makeSandbox() {
  const els = new Map();
  const fetchCalls = [];
  const bridgeCalls = [];
  let intervalFn = null;
  const responses = { '/api/state': () => sampleState('unspooled') };
  const sandbox = {
    document: {
      activeElement: null,
      getElementById(id) {
        if (!els.has(id)) {
          const made = new FakeEl(id);
          made._peers = els;
          els.set(id, made);
        }
        return els.get(id);
      },
    },
    fetch(url, opts) {
      fetchCalls.push({ url, opts: opts || null });
      const maker = responses[url] || responses[String(url).split('?')[0]] || (() => ({ ok: true, turn: 't_x', result: {} }));
      return Promise.resolve({ json: () => Promise.resolve(maker()) });
    },
    setInterval(fn) { intervalFn = fn; return 1; },
    console,
    JSON,
    Promise,
    Object,
  };
  sandbox.window = {
    __AW: { token: TOKEN, port: 1, shell: true },
    webkit: { messageHandlers: { aw: { postMessage(msg) {
      bridgeCalls.push(msg);
      Promise.resolve().then(() => sandbox.window.__awReply(msg.id,
        { ok: true, providers: [], trusted: sandbox.axTrusted }));
    } } } },
  };
  sandbox.axTrusted = true;
  sandbox.getEl = (id) => sandbox.document.getElementById(id);
  sandbox.fetchCalls = fetchCalls;
  sandbox.bridgeCalls = bridgeCalls;
  sandbox.responses = responses;
  sandbox.getInterval = () => intervalFn;
  return sandbox;
}

function clickEvent(action, arg) {
  return {
    preventDefault() {},
    target: {
      closest: () => (action == null ? null : { dataset: { action, arg } }),
    },
  };
}

function submitEvent() {
  return { preventDefault() {} };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

const KINDS = ['idea', 'experience', 'design', 'spec', 'plan'];
function emptyNodes() {
  return Object.fromEntries(KINDS.map((k) => [k, {
    kind: k, line: 'empty', stale: false, reopened: false,
    versions: [], accepted: null, staged: null, draft: null, rejected_note: null,
  }]));
}

const DESIGN_DEF = {
  id: 'DESIGN_READY', kind: 'design',
  question: 'The Design is ready. Approve, reply/ask, summary, or reject?',
  actions: ['APPROVE', 'REPLY_ASK', 'SUMMARY', 'REJECT'],
  params: { REJECT: { target: { enum: ['idea', 'experience', 'design'], default: 'design' } } },
};

function sampleState(shape) {
  const base = {
    project: { id: 'p_1', name: 'Tiny Note' },
    projects: [{ id: 'p_1', name: 'Tiny Note', status: 'green', stage: 'idea' }, { id: 'p_2', name: 'Second Note', status: 'yellow', stage: 'idea' }],
    status: 'green',
    frontier: { stage: 'idea', stale: [], next_legal: ['prompt', 'form:idea'] },
    chips: CHIPS,
    form_templates: FORM_TEMPLATES,
    nodes: emptyNodes(),
    budget: { used: 1, authority: '25', window: '1 day' },
    gate: null,
    pending_validation: null,
    artifact: null,
    branches: {},
    leaves: {},
    executions: {},
    main: null,
    closure: null,
    closure_proof: null,
    execution: null,
    seats: { leader: { route: 'grok:cli', cfg: {} }, builder: { route: 'grok:cli', cfg: {} }, reviewer: { route: 'chatgpt:codex', cfg: {} } },
    routes: { allowlist: ['grok:cli', 'chatgpt:codex', 'claude:cli'], solo: false },
    route_health: {},
    activity: null,
    seq: 7,
    turns: { last_id: 1 },
  };
  if (shape === 'unspooled') {
    return { ...base, project: null, projects: [], status: 'unspooled', seq: 0, frontier: { stage: 'unspooled', stale: [], next_legal: ['spool'] } };
  }
  if (shape === 'staged-idea') {
    base.seq = 8;
    base.status = 'yellow';
    base.nodes.idea.staged = {
      v: 1,
      content: { problem: 'Bills split slowly at the table.', solution: 'One screen splits them fast.' },
      staged_by_turn: 't_1',
    };
    base.nodes.idea.versions = [{ v: 1, state: 'staged', ts: '' }];
    base.nodes.idea.line = 'staged v1 awaiting validation';
    base.pending_validation = { kind: 'idea', v: 1, staged_by_turn: 't_1', def: { id: 'VALIDATE', kind: 'idea', text_id: null, question: null, actions: ['ACCEPT', 'REJECT_RESTAGE'], transitions: ['next stage', 'Reopen of this node'] } };
  }
  if (shape === 'experience-stage' || shape === 'design-stage') {
    base.nodes.idea.accepted = { v: 1, content: { problem: 'Bills split slowly at the table.', solution: 'One screen splits them fast.' } };
    base.nodes.idea.versions = [{ v: 1, state: 'accepted', ts: '' }];
    base.nodes.idea.line = 'accepted v1';
    base.frontier = { stage: 'experience', stale: [], next_legal: ['form:experience'] };
  }
  if (shape === 'design-stage') {
    base.nodes.experience.accepted = { v: 1, content: { actors: ['a diner'], acceptance: [{ id: 'A1', criterion: 'the split shows' }] } };
    base.nodes.experience.versions = [{ v: 1, state: 'accepted', ts: '' }];
    base.nodes.experience.line = 'accepted v1';
    base.frontier = { stage: 'design', stale: [], next_legal: ['form:design', 'seat_dispatch', 'reopen'] };
  }
  if (shape === 'gated-design') {
    base.seq = 9;
    base.status = 'yellow';
    base.frontier = { stage: 'design', stale: [], next_legal: ['gate'] };
    base.nodes.design.staged = { v: 1, content: { screens: [{ id: 'S1', name: 'The split', contents: ['total', 'tip', 'per person'] }], acceptance: [{ id: 'D1', criterion: 'the share is visible at once' }] }, staged_by_turn: 't_5' };
    base.nodes.design.versions = [{ v: 1, state: 'staged', ts: '' }];
    base.gate = { id: 'DESIGN_READY', def: DESIGN_DEF, staged: { kind: 'design', v: 1 } };
  }
  if (shape === 'budget-gate') {
    base.seq = 10;
    base.status = 'yellow';
    base.frontier = { stage: 'plan', stale: [], next_legal: ['gate'] };
    for (const k of ['idea', 'experience', 'design', 'spec']) base.nodes[k].accepted = { v: 1, content: {} };
    base.nodes.spec.accepted.content = { requirements: [{ id: 'R1', requirement: 'a page prints hello' }], budget: { authority: '25', window: '1 day' } };
    base.nodes.plan.staged = { v: 1, content: { root: { id: 'L1', title: 'root', decomposes_into: [] }, summary: {} }, authored_by: 'system' };
    base.pending_validation = { kind: 'plan', v: 1, author: { seat: 'leader' }, def: { question: 'A fresh review turn must accept this staged Plan; the turn that staged it cannot.', actions: [] } };
    base.budget = { used: 25, authority: '25', window: '1 day' };
    base.gate = { id: 'BUDGET_GATE', def: { id: 'BUDGET_GATE', kind: 'wheel', question: 'The window is full at 25 dispatches. Extend the scale, replan, wait, or stop?', actions: ['EXTEND', 'REPLAN', 'WAIT', 'STOP'], params: {} } };
  }
  if (shape === 'working') {
    base.seq = 12;
    base.status = 'yellow';
    base.frontier = { stage: 'execution', stale: [], next_legal: ['seat_result'] };
    for (const k of KINDS) {
      base.nodes[k].accepted = { v: 1, content: {} };
      base.nodes[k].versions = [{ v: 1, state: 'accepted', ts: '' }];
    }
    base.activity = {
      working: { seat: 'builder', kind: 'execute', route: 'grok:cli', since: new Date(Date.now() - 65000).toISOString(), attempt: 2, review: false, leaves: ['L1.1'] },
      staged: null, waiting: null, pull: null, stopped: false, interrupted: null, last_failure: null,
    };
  }
  if (shape === 'paused') {
    base.seq = 13;
    base.status = 'red';
    base.frontier = { stage: 'execution', stale: [], next_legal: ['recover'] };
    base.activity = {
      working: null, staged: null, waiting: null, pull: null, stopped: true, interrupted: null,
      last_failure: { kind: 'plan', reason: 'the tests did not pass' },
    };
  }
  if (shape === 'purple') {
    base.seq = 11;
    base.status = 'purple';
    base.frontier = { stage: 'done_complete', stale: [], next_legal: [] };
    base.artifact = { path: '/tmp/out/index.html', product_link: 'file:///tmp/out/index.html' };
    for (const k of KINDS) {
      base.nodes[k].accepted = { v: 1, content: {} };
      base.nodes[k].versions = [{ v: 1, state: 'accepted', ts: '' }];
      base.nodes[k].line = 'accepted v1';
    }
    base.nodes.plan.accepted.content = {
      root: { id: 'L1', title: 'Deliver the accepted solution', kind: 'expected_result', claim_refs: ['solution'], decomposes_into: [
        { id: 'L1.1.A1', title: 'A1: the split shows', kind: 'expected_result', claim_refs: ['A1'], decomposes_into: [], trial: { status: 'passed' } },
      ], trial: { status: 'passed' } },
      decision: { leaf: 'L1.4', chosen: 'ALT1', rationale: 'one file', basis: 'compared_two' },
      trial_stages: [['L1.1.A1']],
      summary: { leaves: 1, passed: 1, untried: 0, gaps: 0, conflicts: 0, high_risk: [] },
    };
    base.leaves = { 'L1.1.A1': { state: 'done', execution: { branch: 'b_1' } } };
    base.executions = { b_1: { branch: 'b_1', leaves: ['L1.1.A1'], state: 'accepted', tests: { passed: 2, failed: 0 } } };
    base.main = { main_file: 'index.html', bytes: 48, merged: ['b_1'] };
    base.closure = { state: 'accepted', steps: [{ from: 'artifact', to: 'plan', ok: true, detail: 'fine' }] };
  }
  return base;
}

function loadPage(sandbox) {
  const html = fs.readFileSync(uiPage, 'utf8');
  const m = html.match(/<script>\n('use strict';[\s\S]*?)<\/script>/);
  assert.ok(m, 'main.html must contain exactly the expected script block');
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox);
  return sandbox.window.__test;
}

test('step 0: every registered handler fires and produces its expected calls', async () => {
  const sandbox = makeSandbox();
  sandbox.responses['/api/routes'] = () => ({
    routes: [
      { id: 'grok:cli', provider: 'Grok', surface: 'cli', label: 'Grok CLI', method: 'stdio' },
      { id: 'chatgpt:codex', provider: 'ChatGPT', surface: 'cli', label: 'Codex', method: 'stdio' },
      { id: 'claude:cli', provider: 'Claude', surface: 'cli', label: 'Claude CLI', method: 'stdio' },
      { id: 'cursor:app', provider: 'Cursor', surface: 'app', label: 'Cursor', method: 'ax' },
      { id: 'api:anthropic', provider: 'anthropic', surface: 'api', label: 'API', method: 'api' },
    ],
    allowlist: ['grok:cli', 'chatgpt:codex', 'claude:cli'],
    seats: null,
  });
  const page = loadPage(sandbox);
  await settle();

  const expectedSignatures = [
    'div|#rail-list|click', 'div|#activity|click', 'div|#stack|click', 'div|#stack|input',
    'div|#chat-log|click', 'button|#inspector-toggle|click',
    'div|#inspector-body|click', 'div|#inspector-body|change', 'form|#chat-form|submit', 'form|#chat-form|click',
  ];
  assert.deepEqual([...page.registered], expectedSignatures); /* spread: vm realm -> host realm */
  assert.ok(sandbox.getInterval(), 'poll interval registered');

  const fired = new Set();
  const calls = sandbox.fetchCalls;
  const turnCalls = () => calls.filter((c) => c.url === '/api/turn');

  assert.ok(calls.some((c) => c.url === '/api/state'), 'initial poll fired');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer ' + TOKEN);

  page.setState(sampleState('experience-stage'));
  assert.equal(page.getViewOpen(), '', 'a project arrives with every node closed');
  assert.equal((sandbox.getEl('stack').innerHTML.match(/node-body/g) || []).length, 0);
  page.handlers.stackClick(clickEvent('toggle', 'experience'));
  const editor = sandbox.getEl('stack').innerHTML;
  assert.match(editor, /<textarea id="form-experience"/, 'the strict Experience form renders when form:experience is legal');
  assert.ok(editor.includes('&quot;acceptance&quot;'), 'the editor is seeded with the schema-derived template');
  assert.match(editor, /data-action="form-submit" data-arg="experience"/);
  assert.ok(!/id="form-spec"/.test(editor), 'no form for a stage that is not legal yet');
  assert.ok(!/id="form-design"/.test(editor));
  page.handlers.stackInput({ target: { id: 'form-experience', value: '{ not json' } });
  fired.add('div|#stack|input');
  assert.equal(page.getFormDrafts().experience, '{ not json', 'typed text survives re-renders');
  let turnsBefore = turnCalls().length;
  await page.handlers.stackClick(clickEvent('form-submit', 'experience'));
  assert.equal(turnCalls().length, turnsBefore, 'invalid JSON posts nothing');
  assert.match(sandbox.getEl('chat-log').innerHTML, /not valid JSON/);
  const experienceBody = { actors: ['a person'], journeys: [{ name: 'read', steps: ['open'] }], edge_cases: ['none'], usability: ['fast'], acceptance: [{ id: 'A1', criterion: 'the page says hello' }] };
  page.handlers.stackInput({ target: { id: 'form-experience', value: JSON.stringify(experienceBody) } });
  await page.handlers.stackClick(clickEvent('form-submit', 'experience'));
  await settle();
  const formTurn = turnCalls().at(-1);
  assert.deepEqual(JSON.parse(formTurn.opts.body).input, { type: 'form', kind: 'experience', content: experienceBody }, 'the form posts a typed form turn');
  assert.equal(page.getFormDrafts().experience, undefined, 'a submitted draft is cleared');
  page.handlers.stackInput({ target: { id: 'chat-input', value: 'x' } });
  assert.deepEqual(Object.keys(page.getFormDrafts()), [], 'non-form inputs are ignored');
  const ta = sandbox.getEl('form-experience');
  ta.selectionStart = 3; ta.selectionEnd = 7;
  sandbox.document.activeElement = ta;
  page.render();
  assert.equal(sandbox.getEl('form-experience').focused, 1, 'focus restored after render');
  assert.deepEqual([sandbox.getEl('form-experience').selectionStart, sandbox.getEl('form-experience').selectionEnd], [3, 7], 'caret restored');
  sandbox.document.activeElement = null;
  const stackBefore = sandbox.getEl('stack').innerHTML;
  sandbox.getEl('stack').innerHTML = 'UNTOUCHED';
  await page.handlers.poll();
  await page.handlers.poll();
  assert.equal(sandbox.getEl('stack').innerHTML, 'UNTOUCHED', 'an unchanged state does not re-render the stack');
  sandbox.getEl('stack').innerHTML = stackBefore;

  page.setState(sampleState('design-stage'));
  page.handlers.stackClick(clickEvent('toggle', 'design'));
  const designHtml = sandbox.getEl('stack').innerHTML;
  assert.match(designHtml, /<textarea id="form-design"/, 'the strict Design form renders when form:design is legal');
  assert.ok(designHtml.includes('&quot;screens&quot;'), 'seeded with the Design template');
  assert.match(designHtml, /data-action="propose-design"/, 'the Leader proposal is the human\'s explicit request');
  assert.ok(!/Approach|Final Product|\//.test(sandbox.getEl('stage-line').textContent), 'names carry no slashes');
  await page.handlers.stackClick(clickEvent('propose-design'));
  let body = JSON.parse(turnCalls().at(-1).opts.body);
  assert.deepEqual(body.input, { type: 'seat_dispatch', kind: 'design' });

  page.setState(sampleState('experience-stage'));
  assert.equal(page.getViewOpen(), '', 'still closed on arrival');
  let before = calls.length;
  page.handlers.stackClick(clickEvent('toggle', 'idea'));
  fired.add('div|#stack|click');
  assert.equal(calls.length, before, 'toggle makes no network call');
  assert.equal(page.getViewOpen(), 'idea');
  assert.match(sandbox.getEl('stack').innerHTML, /Bills split slowly/);
  assert.equal((sandbox.getEl('stack').innerHTML.match(/node-body/g) || []).length, 1, 'exactly one node expanded');

  before = calls.length;
  page.handlers.stackClick(clickEvent(null));
  assert.equal(calls.length, before, 'clicking dead space calls nothing');

  page.setState(sampleState('staged-idea'));
  before = calls.length;
  page.handlers.stackClick(clickEvent('chip', 'chip4'));
  assert.equal(calls.length, before);
  assert.equal(page.getChatTarget().field, 'solution');
  assert.equal(sandbox.getEl('chat-input').placeholder, CHIPS[3].prompt);

  sandbox.getEl('chat-input').value = 'One screen shows the split instantly for everyone.';
  await page.handlers.chatSubmit(submitEvent());
  fired.add('form|#chat-form|submit');
  let turn = turnCalls().at(-1);
  assert.ok(turn, 'prompt turn posted');
  assert.equal(turn.opts.headers.authorization, 'Bearer ' + TOKEN, 'turns carry the token');
  body = JSON.parse(turn.opts.body);
  assert.equal(body.input.type, 'prompt');
  assert.deepEqual(body.input.target, { kind: 'idea', field: 'solution' });
  assert.equal(page.getChatTarget(), null, 'target cleared after send');

  sandbox.getEl('chat-input').value = '/spool Tiny | ' + 'p'.repeat(25) + ' | ' + 's'.repeat(25);
  await page.handlers.chatSubmit(submitEvent());
  const spoolCall = calls.find((c) => c.url === '/api/spool');
  assert.ok(spoolCall, '/spool posts to the spool lane');
  assert.equal(spoolCall.opts.headers.authorization, 'Bearer ' + TOKEN);

  before = turnCalls().length;
  sandbox.getEl('chat-input').value = 'free text with nowhere to go';
  await page.handlers.chatSubmit(submitEvent());
  assert.equal(turnCalls().length, before, 'untargeted chat stages nothing');

  page.setState(sampleState('staged-idea'));
  await page.handlers.stackClick(clickEvent('validate', 'ACCEPT'));
  body = JSON.parse(turnCalls().at(-1).opts.body);
  assert.deepEqual(body.input, { type: 'validate', action: 'ACCEPT' });

  page.setState(sampleState('staged-idea'));
  sandbox.getEl('chat-input').value = 'not sharp enough';
  await page.handlers.stackClick(clickEvent('validate', 'REJECT_RESTAGE'));
  body = JSON.parse(turnCalls().at(-1).opts.body);
  assert.equal(body.input.type, 'validate');
  assert.equal(body.input.action, 'REJECT_RESTAGE');
  assert.equal(body.input.note, 'not sharp enough');

  page.setState(sampleState('gated-design'));
  sandbox.getEl('chat-input').value = '';
  await page.handlers.stackClick(clickEvent('gate', 'APPROVE'));
  body = JSON.parse(turnCalls().at(-1).opts.body);
  assert.deepEqual(body.input, { type: 'gate', action: 'APPROVE', reply: '' });

  page.setState(sampleState('gated-design'));
  assert.match(sandbox.getEl('stack').innerHTML, /<select id="gate-param-REJECT-target">(?:<option value="[a-z]+"(?: selected)?>[a-z]+<\/option>){3}<\/select>/, 'the target picker renders the enum');
  assert.match(sandbox.getEl('stack').innerHTML, /<option value="design" selected>design<\/option>/, 'default design preselected');
  sandbox.getEl('chat-input').value = 'the experience and the design disagree';
  await page.handlers.stackClick(clickEvent('gate', 'REJECT'));
  body = JSON.parse(turnCalls().at(-1).opts.body);
  assert.deepEqual(body.input, { type: 'gate', action: 'REJECT', reply: 'the experience and the design disagree', target: 'design' });
  page.setState(sampleState('gated-design'));
  sandbox.getEl('gate-param-REJECT-target').value = 'experience';
  await page.handlers.stackClick(clickEvent('gate', 'REJECT'));
  body = JSON.parse(turnCalls().at(-1).opts.body);
  assert.equal(body.input.target, 'experience');
  sandbox.getEl('gate-param-REJECT-target').value = '';

  page.setState(sampleState('purple'));
  await page.handlers.chatLogClick(clickEvent('reveal', '/tmp/out/index.html'));
  fired.add('div|#chat-log|click');
  await settle();
  assert.ok(sandbox.bridgeCalls.some((m) => m.op === 'reveal' && m.path === '/tmp/out/index.html'));

  sandbox.window.__awRecovery('Agent Wheel recovered an interrupted turn. Review the last durable state, then Retry, Resume, Discard the late result, or Stop.');
  assert.match(sandbox.getEl('stack').innerHTML, /recovered an interrupted turn/);
  page.handlers.stackClick(clickEvent('dismiss-recovery'));
  assert.ok(!/recovered an interrupted turn/.test(sandbox.getEl('stack').innerHTML));

  const railHtml = sandbox.getEl('rail-list').innerHTML;
  assert.match(railHtml, /data-action="new-project"/, 'New Project is in the rail');
  assert.match(railHtml, /data-action="select-project" data-arg="p_1"[^>]*>.*Tiny Note/);
  assert.match(railHtml, /data-action="select-project" data-arg="p_2"[^>]*>.*Second Note/, 'two projects show in the rail');
  assert.equal((railHtml.match(/rail-item selected/g) || []).length, 1, 'the current project is the selected row');
  await page.handlers.railClick(clickEvent('select-project', 'p_2'));
  fired.add('div|#rail-list|click');
  assert.equal(page.getSelectedProject(), 'p_2');
  assert.ok(calls.some((c) => c.url === '/api/state?project=p_2'), 'the selected project is polled by id');
  before = calls.length;
  page.handlers.railClick(clickEvent(null));
  assert.equal(calls.length, before);
  page.handlers.railClick(clickEvent('new-project'));
  assert.match(sandbox.getEl('stack').innerHTML, /<input id="new-name"/, 'the Idea form for a new project');
  assert.match(sandbox.getEl('stack').innerHTML, /data-action="submit-idea">Create project<\/button>/,
    'the form offers its primary action beside its fields');
  assert.equal(sandbox.getEl('btn-idea').hidden, false, 'Submit Idea is the one button that submits an idea');
  assert.equal(sandbox.getEl('btn-send').hidden, true, 'Send has nowhere to go on a new project');
  sandbox.getEl('new-name').value = 'Third Note';
  sandbox.getEl('new-problem').value = 'p'.repeat(25);
  sandbox.getEl('new-solution').value = 's'.repeat(25);
  const spoolsBefore = calls.filter((c) => c.url === '/api/spool').length;
  await page.handlers.stackClick(clickEvent('submit-idea'));
  const newSpool = calls.filter((c) => c.url === '/api/spool').at(-1);
  assert.equal(calls.filter((c) => c.url === '/api/spool').length, spoolsBefore + 1);
  assert.deepEqual(JSON.parse(newSpool.opts.body), { name: 'Third Note', problem: 'p'.repeat(25), solution: 's'.repeat(25) });
  page.handlers.railClick(clickEvent('new-project'));
  page.handlers.stackClick(clickEvent('new-project-cancel'));
  assert.ok(!/id="new-name"/.test(sandbox.getEl('stack').innerHTML), 'cancel closes the form');

  page.setState(sampleState('working'));
  const band = sandbox.getEl('activity').innerHTML;
  assert.match(band, /Grok · Grok CLI is building/, 'the band names the route by provider and surface');
  assert.match(band, /as the builder, attempt 2/, 'the seat and the attempt read plainly');
  assert.match(band, /data-action="activity-feed"/);
  sandbox.responses['/api/audit'] = () => ([
    { ts: '2026-09-04T10:00:00.000Z', phase: 'CLOSED_RUNNING', event: 'card_out', card: 'card_abc123', route: 'grok:cli' },
    { ts: '2026-09-04T10:01:00.000Z', phase: 'APPLYING', event: 'commit', turn: 't_9', reason: 'review rung 1 accepted execution b_2' },
    { ts: '2026-09-04T10:02:00.000Z', phase: 'SHELL', event: 'client_connected', agent: 'x' },
  ]);
  await page.handlers.activityClick(clickEvent('activity-feed'));
  fired.add('div|#activity|click');
  await settle();
  const feedHtml = sandbox.getEl('activity').innerHTML;
  assert.match(feedHtml, /review rung 1 accepted execution b_2/, 'the feed says what happened, in the commit\'s own words');
  assert.match(feedHtml, /sent to Grok · Grok CLI/, 'a card leaving is one sentence');
  assert.ok(!/card_abc123/.test(feedHtml), 'no card ids in normal UI');
  assert.ok(!/client_connected/.test(feedHtml), 'shell noise never reaches the feed');
  page.handlers.activityClick(clickEvent('activity-open', 'spec'));
  assert.equal(page.getViewOpen(), 'spec', 'the band opens the node it is talking about');
  page.setState(sampleState('paused'));
  const paused = sandbox.getEl('activity').innerHTML;
  assert.match(paused, /data-action="activity-resume"/);
  assert.match(paused, /the tests did not pass/, 'the last finding is what the seat actually said');
  await page.handlers.activityClick(clickEvent('activity-resume'));
  body = JSON.parse(turnCalls().at(-1).opts.body);
  assert.deepEqual(body.input, { type: 'recover' });
  page.handlers.activityClick(clickEvent('activity-feed'));

  page.setState(sampleState('experience-stage'));
  assert.equal(sandbox.getEl('inspector').hidden, true);
  page.handlers.inspectorToggle({ preventDefault() {} });
  fired.add('button|#inspector-toggle|click');
  assert.equal(sandbox.getEl('inspector').hidden, false);
  const inspectorHtml = sandbox.getEl('inspector-body').innerHTML;
  const seatPicker = inspectorHtml.match(/<select id="seat-reviewer" data-seat="reviewer"[^>]*>[\s\S]*?<\/select>/)[0];
  assert.equal((seatPicker.match(/<option /g) || []).length, 5, 'all five routes are offered');
  assert.ok(!/optgroup|Spec|allowlist/.test(seatPicker), 'the project chooses any registered route');
  assert.match(seatPicker, /<option value="chatgpt:codex" selected>ChatGPT · Codex<\/option>/,
    'a seat reads as the model it sits on, not as an id');
  assert.match(seatPicker, /<option value="cursor:app">/);
  assert.match(inspectorHtml, /every route has answered/, 'route health reads as a sentence');
  assert.match(inspectorHtml, /class="proj">Tiny Note</);
  assert.match(inspectorHtml, /<span class="k">Budget<\/span><span class="v"><div class="budget-set">/);
  assert.match(inspectorHtml, /<select id="budget-authority" data-budget="authority">[\s\S]*?<option value="50">50<\/option>/);
  assert.match(inspectorHtml, /<select id="budget-window" data-budget="window">[\s\S]*?<option value="1 day" selected>/);
  assert.match(inspectorHtml, /1 prompt used in this window/);
  assert.ok(!/rail-title">Now|rail-title">Inspector/.test(inspectorHtml), 'the panel does not announce itself');
  assert.ok(!/—|&mdash;/.test(inspectorHtml + sandbox.getEl('stack').innerHTML), 'no em dashes in the window');
  assert.ok(!/Run details|Turns|Branches/.test(inspectorHtml), 'the run\'s bookkeeping is not what this is for');
  assert.ok(!/Provider keys|key-provider|Set in/.test(inspectorHtml),
    'keys belong to the machine, and where a budget is set is not a row');
  assert.match(inspectorHtml, /<span class="k">Status<\/span><span class="v">Running<\/span>/);
  assert.match(inspectorHtml, /<span class="k">Now<\/span><span class="v">Idle<\/span>/);
  const rows = inspectorHtml.match(/<div class="inspector-row">/g) || [];
  assert.equal(rows.length, (inspectorHtml.match(/<span class="k">/g) || []).length, 'one label per row');
  assert.equal(rows.length, (inspectorHtml.match(/<span class="v">/g) || []).length, 'and one value per row');
  await page.handlers.inspectorChange({ target: { dataset: { seat: 'reviewer' }, value: 'claude:cli' } });
  fired.add('div|#inspector-body|change');
  body = JSON.parse(turnCalls().at(-1).opts.body);
  assert.deepEqual(body.input, { type: 'seat_assignment', seat: 'reviewer', route: 'claude:cli' });
  before = calls.length;
  page.handlers.inspectorChange({ target: { dataset: {}, value: 'x' } });
  assert.equal(calls.length, before, 'a change elsewhere in the inspector posts nothing');
  await page.handlers.inspectorChange({ target: { dataset: { budget: 'authority' }, value: '50' } });
  body = JSON.parse(turnCalls().at(-1).opts.body);
  assert.deepEqual(body.input, { type: 'budget_set', authority: '50', window: '1 day' });
  await page.handlers.inspectorChange({ target: { dataset: { budget: 'window' }, value: '1 week' } });
  body = JSON.parse(turnCalls().at(-1).opts.body);
  assert.deepEqual(body.input, { type: 'budget_set', authority: '25', window: '1 week' },
    'the other half of the setting rides along, from the state the window was painted from');
  page.handlers.inspectorClick(clickEvent('settings'));
  fired.add('div|#inspector-body|click');
  page.handlers.railClick(clickEvent('settings'));
  before = calls.length;
  page.handlers.inspectorClick(clickEvent(null));
  assert.equal(calls.length, before);

  page.setState(sampleState('staged-idea'));
  page.handlers.stackClick(clickEvent('chip', 'chip1'));
  assert.ok(page.getChatTarget());
  page.handlers.chatFormClick(clickEvent('clear-target'));
  fired.add('form|#chat-form|click');
  assert.equal(page.getChatTarget(), null);

  sandbox.responses['/api/state'] = () => sampleState('purple');
  await page.handlers.poll();
  assert.ok(!/done-banner/.test(sandbox.getEl('stack').innerHTML), 'the banner is gone from the stack');
  assert.match(sandbox.getEl('chat-log').innerHTML, /Final product: <a href="#" data-action="reveal" data-arg="\/tmp\/out\/index.html">file:\/\/\/tmp\/out\/index.html<\/a>/);
  assert.equal(sandbox.getEl('stage-line').textContent, 'Stage: Done');
  page.handlers.stackClick(clickEvent('toggle', 'plan'));
  assert.match(sandbox.getEl('stack').innerHTML, /Leaves \(1 of 1 done\)/, 'the living plan shows every leaf with its state');
  assert.match(sandbox.getEl('stack').innerHTML, /Final closure \(accepted\)/);

  for (const sig of page.registered) {
    assert.ok(fired.has(sig), 'registered handler never fired: ' + sig);
  }
});

test('every data-action the page renders is one the delegated handlers route', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  const handled = new Set([
    'toggle', 'chip', 'validate', 'gate', 'reveal', 'dismiss-recovery',
    'clear-target', 'select-project', 'new-project', 'new-project-cancel', 'submit-idea',
    'key-save', 'key-delete', 'form-submit', 'propose-design', 'reopen', 'reopen-confirm', 'reopen-cancel',
    'settings', 'settings-close', 'settings-check', 'goto-gate', 'settings-key-save',
    'settings-key-delete', 'settings-drop-key', 'settings-drop-route', 'settings-signout', 'details-toggle',
    'settings-ax', 'settings-add-key', 'setup-ax', 'setup-hide', 'seat-attach', 'seat-key', 'budget-change',
    'activity-feed', 'activity-open', 'activity-resume', 'refresh-models',
  ]);
  const seen = new Set();
  const grab = () => {
    const html = sandbox.getEl('stack').innerHTML + sandbox.getEl('chat-target').innerHTML +
      sandbox.getEl('rail-list').innerHTML + sandbox.getEl('inspector-body').innerHTML +
      sandbox.getEl('activity').innerHTML + sandbox.getEl('chat-form').innerHTML;
    for (const m of html.matchAll(/data-action="([a-z-]+)"/g)) seen.add(m[1]);
  };
  page.handlers.inspectorToggle({ preventDefault() {} });
  page.handlers.railClick(clickEvent('new-project'));
  for (const shape of ['unspooled', 'plain', 'staged-idea', 'experience-stage', 'design-stage', 'gated-design', 'budget-gate', 'working', 'paused', 'purple']) {
    page.setState(sampleState(shape));
    grab();
    for (const kind of KINDS) {
      page.handlers.stackClick(clickEvent('toggle', kind));
      grab();
    }
  }
  assert.ok(seen.size >= 5, 'render produced actions to audit');
  for (const action of seen) {
    assert.ok(handled.has(action), `rendered action "${action}" has no handler`);
  }
  const withReopen = sampleState('experience-stage');
  withReopen.frontier.next_legal = ['form:experience', 'reopen'];
  page.setState(withReopen);
  page.handlers.stackClick(clickEvent('toggle', 'idea'));
  const ideaHtml = sandbox.getEl('stack').innerHTML;
  assert.match(ideaHtml, /data-action="reopen" data-arg="idea"/, 'an accepted Idea offers Reopen');
  sandbox.responses['/api/reopen/preview'] = () => ({ ok: true, kind: 'idea', claims: ['problem', 'solution'], leaves_back_to_untried: [{ id: 'L1.1.A1', state: 'done' }, { id: 'L1.4', state: 'done' }], legal: true });
  const before = sandbox.fetchCalls.filter((c) => c.url === '/api/turn').length;
  await page.handlers.stackClick(clickEvent('reopen', 'idea'));
  await settle();
  assert.ok(sandbox.fetchCalls.some((c) => String(c.url).indexOf('/api/reopen/preview?kind=idea') === 0), 'the click asks the helper for the reopen preview');
  assert.equal(sandbox.fetchCalls.filter((c) => c.url === '/api/turn').length, before, 'nothing is posted before the human confirms');
  const previewHtml0 = sandbox.getEl('stack').innerHTML;
  assert.match(previewHtml0, /serve 2 leaves that can go back to untried - L1\.1\.A1 \(done\), L1\.4 \(done\)/, 'the preview lists every leaf that can go back');
  assert.match(previewHtml0, /data-action="reopen-confirm" data-arg="idea"/);
  page.handlers.stackClick(clickEvent('reopen-cancel', 'idea'));
  assert.ok(!/data-action="reopen-confirm"/.test(sandbox.getEl('stack').innerHTML), 'Keep withdraws the preview');
  assert.match(sandbox.getEl('stack').innerHTML, /data-action="reopen" data-arg="idea"/, 'and the Reopen button is back');
  await page.handlers.stackClick(clickEvent('reopen', 'idea'));
  await settle();
  await page.handlers.stackClick(clickEvent('reopen-confirm', 'idea'));
  await settle();
  const turns = sandbox.fetchCalls.filter((c) => c.url === '/api/turn');
  assert.equal(turns.length, before + 1);
  assert.deepEqual(JSON.parse(turns.at(-1).opts.body).input, { type: 'reopen', kind: 'idea' }, 'the confirm posts the typed reopen turn');
  delete sandbox.responses['/api/reopen/preview'];
  withReopen.frontier.next_legal = ['form:experience'];
  page.setState(withReopen);
  page.handlers.stackClick(clickEvent('toggle', 'idea'));
  page.handlers.stackClick(clickEvent('toggle', 'idea'));
  assert.ok(!/data-action="reopen"/.test(sandbox.getEl('stack').innerHTML), 'no Reopen when the frontier does not list it');

  const reopenedIdea = sampleState('experience-stage');
  reopenedIdea.frontier = { stage: 'idea', stale: [], next_legal: ['prompt', 'form:idea'] };
  reopenedIdea.nodes.idea.reopened = true;
  reopenedIdea.nodes.idea.draft = { problem: 'Bills split slowly at the table.', solution: 'One screen splits them fast.' };
  page.setState(reopenedIdea);
  if (!/id="form-idea"/.test(sandbox.getEl('stack').innerHTML)) page.handlers.stackClick(clickEvent('toggle', 'idea'));
  const reopenedHtml = sandbox.getEl('stack').innerHTML;
  assert.match(reopenedHtml, /<textarea id="form-idea"/, 'a reopened Idea renders the typed Idea form');
  assert.ok(reopenedHtml.includes('&quot;problem&quot;') && reopenedHtml.includes('Bills split slowly'), 'seeded with the successor draft');
  assert.match(reopenedHtml, /data-action="chip"/, 'the chips stay beside it');
  const ideaBody = { problem: 'Bills split slowly at the table, and nobody trusts the total.', solution: 'One screen splits them fast and shows the arithmetic.' };
  page.handlers.stackInput({ target: { id: 'form-idea', value: JSON.stringify(ideaBody) } });
  const turnsBeforeIdea = sandbox.fetchCalls.filter((c) => c.url === '/api/turn').length;
  await page.handlers.stackClick(clickEvent('form-submit', 'idea'));
  await settle();
  const ideaTurns = sandbox.fetchCalls.filter((c) => c.url === '/api/turn');
  assert.equal(ideaTurns.length, turnsBeforeIdea + 1);
  assert.deepEqual(JSON.parse(ideaTurns.at(-1).opts.body).input, { type: 'form', kind: 'idea', content: ideaBody }, 'both fields in one typed form turn');
  const notReopened = sampleState('experience-stage');
  page.setState(notReopened);
  if (!/Problem/.test(sandbox.getEl('stack').innerHTML)) page.handlers.stackClick(clickEvent('toggle', 'idea'));
  assert.ok(!/id="form-idea"/.test(sandbox.getEl('stack').innerHTML), 'an accepted Idea that is not reopened offers no form');

  const previewed = sampleState('staged-idea');
  previewed.pending_validation.preview = { kind: 'idea', changed: ['problem', 'solution'], removed: [], added: [], unchanged: [], leaves: ['L1.1.A1', 'L1.2.R1'], regenerates: true };
  page.setState(previewed);
  if (!/data-action="validate"/.test(sandbox.getEl('stack').innerHTML)) page.handlers.stackClick(clickEvent('toggle', 'idea'));
  const previewHtml = sandbox.getEl('stack').innerHTML;
  assert.match(previewHtml, /changed problem, solution/, 'the claim diff is printed');
  assert.match(previewHtml, /2 leaves go back to untried - L1\.1\.A1, L1\.2\.R1/, 'every leaf that will go back is listed');
  previewed.pending_validation.preview = { kind: 'idea', changed: [], removed: [], added: [], unchanged: ['problem', 'solution'], leaves: [], regenerates: false };
  page.setState(previewed);
  if (!/data-action="validate"/.test(sandbox.getEl('stack').innerHTML)) page.handlers.stackClick(clickEvent('toggle', 'idea'));
  assert.match(sandbox.getEl('stack').innerHTML, /No claim changed: nothing goes back to untried/);
});

test('the project budget gate stays visible independently of product nodes', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  page.setState(sampleState('budget-gate'));
  const html = sandbox.getEl('stack').innerHTML;
  assert.match(html, /data-action="gate" data-arg="EXTEND"/, 'EXTEND offered');
  for (const a of ['REPLAN', 'WAIT', 'STOP']) assert.match(html, new RegExp('data-action="gate" data-arg="' + a + '"'));
  assert.ok(html.includes('The window is full at 25 dispatches'), 'the gate question is shown');
  assert.ok(!/id="form-spec"|Reopen Spec/.test(html), 'the budget gate does not open the Spec');
  page.handlers.stackClick(clickEvent('toggle', 'experience'));
  page.render();
  assert.match(sandbox.getEl('stack').innerHTML, /data-action="gate" data-arg="EXTEND"/, 'budget controls remain visible when a node opens');
  page.handlers.stackClick(clickEvent('toggle', 'spec'));
  assert.match(sandbox.getEl('stack').innerHTML, /data-action="gate" data-arg="EXTEND"/);
  const before = sandbox.fetchCalls.filter((c) => c.url === '/api/turn').length;
  await page.handlers.stackClick(clickEvent('gate', 'EXTEND'));
  await settle();
  const turns = sandbox.fetchCalls.filter((c) => c.url === '/api/turn');
  assert.equal(turns.length, before + 1);
  assert.equal(JSON.parse(turns.at(-1).opts.body).input.action, 'EXTEND');
});

test('gate and validation panels render only fixed, server-supplied actions; closed nodes show names only; no node name carries a slash', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  page.setState(sampleState('gated-design'));
  const html = sandbox.getEl('stack').innerHTML;
  for (const action of ['APPROVE', 'REPLY ASK', 'SUMMARY', 'REJECT']) {
    assert.ok(html.includes(action), 'missing fixed gate action ' + action);
  }
  assert.ok(!html.includes('SHIP_IT'), 'no invented actions');
  assert.equal((html.match(/node-body/g) || []).length, 1);
  assert.ok(!/p_1|card_|t_5/.test(html), 'no raw ids in normal UI');
  assert.ok(!/MCP/.test(html + sandbox.getEl('chat-input').placeholder), 'no MCP terms in normal UI');
  const titles = [...html.matchAll(/<span class="node-title">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['Tiny Note', 'Experience', 'Design', 'Spec', 'Plan']);
  assert.ok(titles.every((t) => !t.includes('/')), 'no slash in any node name');
  assert.ok(!/Approach|Work\b|Final Product/.test(html), 'no node named approach, work, or done');
  page.setState(sampleState('staged-idea'));
  const ideaHtml = sandbox.getEl('stack').innerHTML;
  for (const chip of CHIPS) {
    assert.ok(ideaHtml.includes(chip.prompt), 'missing chip: ' + chip.prompt);
  }
});

test('a node body renders as templated sections: settings blocks read as prose, technical ones sort last and stay closed', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  const s = sampleState('purple');
  s.nodes.spec.accepted.content = {
    requirements: [{ id: 'R1', requirement: 'the whole product is one html file' }],
    constraints: [{ id: 'C1', constraint: 'no network of any kind' }],
    platform: 'a single local html file opened from file://',
    security: ['the file makes no network request of any kind'],
    release: { artifact_type: 'single_file_html', output_dir: '/Users/example/Bookmaker', link_kind: 'file_url' },
    providers_tools: ['node'],
    route_allowlist: ['grok:cli'],
    budget: { authority: '25', window: '1 day' },
  };
  page.setState(s);
  page.handlers.stackClick(clickEvent('toggle', 'spec'));
  const html = sandbox.getEl('stack').innerHTML;
  assert.match(html, /The finished product is one self-contained HTML file, written to ~\/Bookmaker, opened straight from disk\./);
  assert.ok(!/25 prompts per 1 day|Budget scale:/.test(html), 'budget belongs to project controls');
  const above = html.split('Exact values')[0];
  assert.ok(!/&quot;artifact_type&quot;/.test(above), 'no json blob above the disclosure');
  assert.ok(!/&quot;link_kind&quot;/.test(above));
  const techAt = html.indexOf('Technical details');
  assert.ok(techAt > 0, 'the technical sections are gathered into one disclosure');
  assert.ok(html.indexOf('Requirements') < techAt, 'the requirements read first');
  assert.ok(html.indexOf('Security') < techAt, 'Security reads inline, like every other Spec section');
  assert.ok(html.indexOf('Tools the build may use') > techAt, 'the machine-facing lists are the technical ones');
  assert.ok(!/<details class="tech" open>/.test(html), 'and it is closed');
  assert.match(html, /<span class="tag">R1<\/span>/);
  assert.match(html, /<details class="raw"><summary data-action="details-toggle" data-arg="raw:spec">Exact values<\/summary>/);
  const s2 = sampleState('purple');
  s2.nodes.spec.accepted.content = {
    requirements: [{ id: 'R1', requirement: 'a page prints hello' }],
    telemetry: { sinks: [{ nested: ['deep'] }] },
  };
  page.setState(s2);
  page.handlers.stackClick(clickEvent('toggle', 'spec'));
  const html2 = sandbox.getEl('stack').innerHTML;
  assert.ok(html2.indexOf('telemetry') > html2.indexOf('Technical details'), 'an unknown shape sorts as technical');
  const s3 = sampleState('purple');
  s3.nodes.experience.accepted.content = {
    actors: ['a writer'],
    journeys: [{ name: 'from words to chapters', steps: ['paste the manuscript', 'see the chapters'] }],
    acceptance: [{ id: 'A1', criterion: 'the chapters appear' }],
  };
  page.setState(s3);
  page.handlers.stackClick(clickEvent('toggle', 'experience'));
  const html3 = sandbox.getEl('stack').innerHTML;
  assert.match(html3, /<div class="sub-title">from words to chapters<\/div><ol><li>paste the manuscript<\/li>/);
  assert.match(html3, /Who it is for/, 'field names read as words, not as keys');
});

test('a node the human closes stays closed, and only ever one is open', async () => {
  const sandbox = makeSandbox();
  sandbox.responses['/api/state'] = () => sampleState('experience-stage');
  const page = loadPage(sandbox);
  await settle();
  page.setState(sampleState('experience-stage'));
  assert.equal(page.getViewOpen(), '', 'a project arrives with every node closed');
  page.handlers.stackClick(clickEvent('toggle', 'experience'));
  assert.equal(page.getViewOpen(), 'experience', 'the human opens the one they want');
  page.handlers.stackClick(clickEvent('toggle', 'experience'));
  assert.equal(page.getViewOpen(), '', 'clicking the open node closes it');
  assert.equal((sandbox.getEl('stack').innerHTML.match(/node-body/g) || []).length, 0, 'nothing is expanded');
  page.render();
  assert.equal((sandbox.getEl('stack').innerHTML.match(/node-body/g) || []).length, 0, 'and a re-render does not reopen it');
  await page.handlers.poll();
  assert.equal((sandbox.getEl('stack').innerHTML.match(/node-body/g) || []).length, 0, 'nor does a poll');
  page.handlers.stackClick(clickEvent('toggle', 'idea'));
  assert.equal((sandbox.getEl('stack').innerHTML.match(/node-body/g) || []).length, 1, 'opening another opens exactly one');
  assert.match(sandbox.getEl('stack').innerHTML, /<span class="caret">▾<\/span>/, 'the open node shows an open caret');
});

test('Connections is its own page from the rail, and Submit Idea turns what was typed into a draft Idea', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  page.setState(sampleState('experience-stage'));
  sandbox.responses['/api/routes'] = () => ({
    routes: [
      { id: 'grok:cli', provider: 'Grok', surface: 'cli', label: 'Grok CLI', method: 'stdio' },
      { id: 'api:anthropic', provider: 'anthropic', surface: 'api', label: 'API', method: 'api' },
    ],
    allowlist: ['grok:cli'],
    seats: { leader: { route: 'grok:cli' } },
  });
  await page.handlers.railClick(clickEvent('settings'));
  await settle();
  const settingsHtml = sandbox.getEl('stack').innerHTML;
  assert.equal(page.getView(), 'settings');
  assert.ok(!/node-title/.test(settingsHtml), 'the Connections page replaces the node stack outright');
  assert.match(settingsHtml,
    /<th>Provider<\/th><th class="grow">Route<\/th><th>Type<\/th><th class="right">Status<\/th>/);
  assert.match(settingsHtml, /<td class="prov">Grok<\/td><td>Grok CLI<\/td><td class="type">cli<\/td>/,
    'one row per route, one fact per column');
  assert.match(settingsHtml, /<td class="prov">anthropic<\/td><td>API<\/td><td class="type">api<\/td>/);
  assert.ok(!/class="use"|allowed here|pill seat/.test(settingsHtml),
    'no seat and no allowlist on the machine\'s page');
  assert.match(settingsHtml, /Advanced: API keys/, 'keys stay under Advanced');
  assert.match(settingsHtml, /data-action="settings-key-save" data-arg="anthropic"/);
  sandbox.getEl('skey-anthropic').value = 'sk-live';
  await page.handlers.stackClick(clickEvent('settings-key-save', 'anthropic'));
  await settle();
  assert.ok(sandbox.bridgeCalls.some((m) => m.op === 'keychain.set' && m.provider === 'anthropic' && m.key === 'sk-live'));
  assert.equal(sandbox.getEl('skey-anthropic').value, '', 'the key never lingers in the field');
  assert.ok(!sandbox.fetchCalls.some((c) => c.opts && c.opts.body && String(c.opts.body).includes('sk-live')),
    'keys never travel from the page to the helper');
  page.handlers.stackClick(clickEvent('settings-close'));
  assert.equal(page.getView(), 'project');
  assert.match(sandbox.getEl('stack').innerHTML, /node-title/, 'closing returns to the project');

  sandbox.getEl('chat-input').value = 'Splitting a bill at the table takes five minutes and someone always overpays.';
  page.handlers.chatFormClick(clickEvent('submit-idea'));
  assert.equal(page.getView(), 'new');
  assert.equal(page.getNewDraft().problem, 'Splitting a bill at the table takes five minutes and someone always overpays.');
  assert.equal(page.getNewDraft().name, 'Splitting a bill at the table', 'the first words name the project for the human to confirm');
  assert.match(sandbox.getEl('stack').innerHTML, /<input id="new-name"[^>]*value="Splitting a bill at the table">/);
  assert.equal(sandbox.getEl('chat-input').value, '', 'the composer is emptied into the draft');
  page.handlers.stackInput({ target: { id: 'new-solution', value: 'One screen shows every share at once.' } });
  page.render();
  assert.match(sandbox.getEl('stack').innerHTML, /One screen shows every share at once\./);
  const chrome = sandbox.getEl('chat-input').placeholder + sandbox.getEl('stack').innerHTML +
    sandbox.getEl('rail-list').innerHTML + sandbox.getEl('activity').innerHTML;
  assert.ok(!/spool/i.test(chrome), 'no spool anywhere a person looks');
  sandbox.getEl('chat-input').value = '/spool Tiny | ' + 'p'.repeat(25) + ' | ' + 's'.repeat(25);
  await page.handlers.chatSubmit(submitEvent());
  assert.ok(sandbox.fetchCalls.some((c) => c.url === '/api/spool'), '/spool in the composer still spools');
});

test('a live selection is never taken away by a poll, and a header click is never swallowed by one', async () => {
  const sandbox = makeSandbox();
  let selectedText = '';
  sandbox.window = sandbox.window || {};
  const page = loadPage(sandbox);
  sandbox.window.getSelection = () => ({ isCollapsed: selectedText.length === 0, toString: () => selectedText });
  await settle();
  page.setState(sampleState('experience-stage'));
  page.handlers.stackClick(clickEvent('toggle', 'idea'));
  assert.equal(page.getViewOpen(), 'idea');
  const painted = sandbox.getEl('stack').innerHTML;

  selectedText = 'Bills split slowly at the table.';
  sandbox.responses['/api/state'] = () => sampleState('staged-idea');
  await page.handlers.poll();
  assert.equal(sandbox.getEl('stack').innerHTML, painted, 'the poll does not blow the selection away');
  selectedText = '';
  await page.handlers.poll();
  assert.notEqual(sandbox.getEl('stack').innerHTML, painted, 'the next poll paints what it had held back');
  assert.match(sandbox.getEl('stack').innerHTML, /Bills split slowly/);

  page.setState(sampleState('experience-stage'));
  page.handlers.stackClick(clickEvent('toggle', 'design'));
  assert.equal(page.getViewOpen(), 'design');
  selectedText = 'some text the human left selected somewhere else';
  page.handlers.stackClick(clickEvent('toggle', 'design'));
  assert.equal(page.getViewOpen(), '', 'the click lands the first time');
  page.handlers.stackClick(clickEvent('details-toggle', 'tech:spec'));
  assert.equal(page.getFormDrafts() && true, true);
});

test('Settings says what each route needs, what a degraded route did, and toggles back to what was open', async () => {
  const sandbox = makeSandbox();
  let checked = false;
  let granted = false;
  let keyHeld = false;
  const ROUTES = [
    { id: 'grok:cli', provider: 'Grok', surface: 'cli', label: 'Grok CLI', method: 'stdio', app_path: null },
    { id: 'chatgpt:codex', provider: 'ChatGPT', surface: 'cli', label: 'Codex', method: 'stdio', app_path: null },
    { id: 'claude:app:chat', provider: 'Claude', surface: 'app', label: 'Chat', method: 'stdio', app_path: '/Applications/Claude.app' },
    { id: 'cursor:app', provider: 'Cursor', surface: 'app', label: 'Cursor', method: 'ax', app_path: '/Applications/Cursor.app' },
    { id: 'chatgpt:app:classic', provider: 'ChatGPT', surface: 'app', label: 'Classic', method: 'ax', app_path: '/Applications/ChatGPT Classic.app' },
    { id: 'api:anthropic', provider: 'anthropic', surface: 'api', label: 'API', method: 'api', app_path: null },
  ];
  sandbox.responses['/api/routes'] = () => ({
    routes: checked ? [
      { ...ROUTES[0], ready: true, code: 'ok', binary: '/example/bin/grok', reason: 'blah blah', ax_gated: false, accessibility: null, sign_out: true, signed_in: true },
      { ...ROUTES[1], ready: false, code: 'missing_binary', binary: 'codex', reason: 'reworded upstream', ax_gated: false, accessibility: null },
      granted
        ? { ...ROUTES[2], ready: true, code: 'ok', seat: 'claude-app', reason: 'reworded upstream', ax_gated: true, accessibility: true }
        : { ...ROUTES[2], ready: false, code: 'no_session', seat: 'claude-app', reason: 'reworded upstream', ax_gated: true, accessibility: false },
      { ...ROUTES[3], ready: false, code: 'no_session', seat: 'cursor-app', reason: 'reworded upstream', ax_gated: false, accessibility: false },
      { ...ROUTES[4], ready: false, code: 'surface_unknown', reason: 'reworded upstream', ax_gated: false, accessibility: false },
      keyHeld
        ? { ...ROUTES[5], ready: true, code: 'ok', reason: 'reworded upstream', ax_gated: false, accessibility: null }
        : { ...ROUTES[5], ready: false, code: 'no_key', reason: 'reworded upstream', ax_gated: false, accessibility: null },
    ] : ROUTES,
    allowlist: ['grok:cli', 'chatgpt:codex'],
    seats: null,
    checked,
  });
  const page = loadPage(sandbox);
  await settle();

  const degraded = sampleState('working');
  degraded.route_health = {
    'chatgpt:codex': {
      degraded: true, failures: 3, last_outcome: 'transport_error',
      last_failure: new Date(Date.now() - 7 * 60000).toISOString(),
    },
  };
  page.setState(degraded);
  page.handlers.inspectorToggle({ preventDefault() {} });
  const health = sandbox.getEl('inspector-body').innerHTML;
  assert.match(health, /ChatGPT · Codex did not answer/);
  assert.match(health, /transport error, 3 times since it last answered, last 7 min ago\./);
  assert.match(health, /resends the same sealed message after 1, 5, then 15 minutes/);
  assert.match(health, /clears itself the moment that route answers/, 'the human is told the mark is derived');
  page.handlers.inspectorToggle({ preventDefault() {} });
  await page.handlers.railClick(clickEvent('settings'));
  await settle();
  assert.ok(sandbox.fetchCalls.some((c) => String(c.url).includes('/api/routes') && String(c.url).includes('ready=1')),
    'opening the page checks; a check is a read, and a page that says nothing until it is pressed is a wasted click');
  let html = sandbox.getEl('stack').innerHTML;
  assert.ok(!/did not answer/.test(html), 'and not on Connections, which is the machine\'s');
  assert.ok(!/<div class="fieldname">Seats<\/div>/.test(html),
    'Connections is the machine\'s; seats belong to a project and live in the Inspector');
  assert.ok(!/Tiny Note/.test(html), 'the machine\'s page never names a project');
  assert.ok(!/lives in the Inspector|belong to the machine/.test(html),
    'the table shows what the paragraph was explaining');

  assert.ok(!/not set up/.test(html), 'nothing claims to be checked before it is');
  checked = true;
  await page.handlers.stackClick(clickEvent('settings-check'));
  await settle();
  assert.ok(sandbox.fetchCalls.some((c) => String(c.url).includes('/api/routes') && String(c.url).includes('ready=1')),
    'the check asks the helper for readiness');
  html = sandbox.getEl('stack').innerHTML;
  assert.match(html, /class="pill on">set up/);
  assert.match(html, /the codex command is not on the app's PATH/);
  assert.match(html, /class="pill bad">not set up/, 'a CLI route that cannot run is a problem');
  assert.match(html, /no session yet. Attach it from a project, in the Inspector/,
    'attaching needs a folder, and the machine\'s page has no project to offer one');
  assert.ok(!/data-action="settings-open-app"/.test(html),
    'and no button here that would only open an app and leave the human where they were');
  assert.ok(!/is not open and signed in/.test(html), 'no claim the transport cannot support');
  assert.ok(!/reworded upstream|blah blah/.test(html), 'the window says its own words, not the transport\'s');
  assert.equal((html.match(/Agent Wheel needs permission to control the Claude app\./g) || []).length, 1,
    'named for the app it is about, in words a human uses about their own Mac');
  assert.equal((html.match(/data-action="settings-ax"/g) || []).length, 1);
  assert.match(html, /macOS asks again after every update/);
  assert.ok(!/ad-hoc|rebuild|cli routes do not need/.test(html), 'nothing here is said in build terms');
  assert.match(html, /<td>Chat<div class="sub">waiting on Accessibility<\/div><\/td>/,
    'the reason sits in the route\'s own cell, never in a full-width row under another column');
  assert.ok(!/colspan=/.test(html), 'one row per route');
  assert.ok(!/System Settings under Privacy/.test(html), 'the button goes there, the paragraph does not');

  assert.match(html, /data-action="settings-add-key" data-arg="anthropic">Connect/);
  assert.match(html, /class="pill">needs a key<\/span>/, 'an api route without a key is optional, not broken');
  assert.ok(!/no API key is saved for anthropic/.test(html),
    'the pill and the provider column already say it; the row does not say it twice');
  assert.match(html, /<span class="pill">not in this build<\/span>/);
  assert.match(html,
    /<td>Classic<\/td><td class="type">app<\/td><td class="right"><span class="pill">not in this build<\/span><\/td><td class="right act"><\/td>/,
    'nothing to press on a route this build cannot drive, and nothing to add under its name');
  const order = (html.match(/class="pill[^"]*">[^<]+/g) || []).map((m) => m.replace(/^.*>/, ''));
  assert.deepEqual(order.slice(0, 6),
    ['set up', 'not set up', 'not set up', 'not set up', 'needs a key', 'not in this build'],
    'set up first, then what a click would fix, then the optional keys, then what this build cannot do');
  assert.ok(!/data-action="gate"|data-action="validate"/.test(html), 'the check writes nothing');

  await page.handlers.stackClick(clickEvent('settings-ax'));
  assert.ok(sandbox.bridgeCalls.some((m) => m.op === 'accessibility.open'), 'the shell opens the pane');
  assert.match(sandbox.getEl('stack').innerHTML, /Turn Agent Wheel on in that list. This page updates itself when you do/,
    'nobody is sent back to press a button the window can press for them');
  await page.handlers.stackClick(clickEvent('settings-open-app', '/Applications/Cursor.app'));
  assert.ok(sandbox.bridgeCalls.some((m) => m.op === 'app.open' && m.path === '/Applications/Cursor.app'));
  await page.handlers.stackClick(clickEvent('settings-add-key', 'anthropic'));
  assert.match(sandbox.getEl('stack').innerHTML, /<details class="tech" open><summary data-action="details-toggle" data-arg="advanced">Advanced/,
    'Add key opens the disclosure the field lives in');
  assert.equal(sandbox.getEl('skey-anthropic').focused, 1, 'and puts the caret in it');

  granted = true;
  await sandbox.window.__awAccessibility(true);
  await settle();
  html = sandbox.getEl('stack').innerHTML;
  assert.ok(!/data-action="settings-ax"/.test(html), 'no button for a permission that is granted');
  assert.ok(!/waiting on Accessibility/.test(html), 'and no row still waiting on it');
  assert.match(html, /<span class="count">2 of 6 set up<\/span>/, 'the count is the one the check just found');
  granted = false;
  await sandbox.window.__awAccessibility(false);
  await settle();
  assert.match(sandbox.getEl('stack').innerHTML, /data-action="settings-ax"/,
    'and it is back the moment a route needs it again');

  keyHeld = true;
  await page.handlers.stackClick(clickEvent('settings-check'));
  await settle();
  html = sandbox.getEl('stack').innerHTML;
  assert.match(html, /<td class="prov">anthropic<\/td>[\s\S]*?data-action="settings-drop-key" data-arg="anthropic">Disconnect/,
    'a connected provider offers the way back out, on its own row');
  page.handlers.stackClick(clickEvent('settings-drop-key', 'anthropic'));
  html = sandbox.getEl('stack').innerHTML;
  assert.match(html, /data-action="settings-key-delete" data-arg="anthropic">Remove the key/,
    'one click arms it, and says what the next one does');
  assert.ok(!/data-action="settings-key-delete" data-arg="openai">Remove the key/.test(html),
    'and arms only the provider that was pressed');
  await page.handlers.stackClick(clickEvent('settings-key-delete', 'anthropic'));
  assert.ok(sandbox.bridgeCalls.some((m) => m.op === 'keychain.delete' && m.provider === 'anthropic'));
  keyHeld = false;

  await page.handlers.stackClick(clickEvent('settings-check'));
  await settle();
  assert.match(sandbox.getEl('stack').innerHTML,
    /<td class="prov">Grok<\/td>[\s\S]*?data-action="settings-drop-route" data-arg="grok:cli">Disconnect/);
  page.handlers.stackClick(clickEvent('settings-drop-route', 'grok:cli'));
  assert.match(sandbox.getEl('stack').innerHTML, /data-action="settings-signout" data-arg="grok:cli">Sign out/);
  await page.handlers.stackClick(clickEvent('settings-signout', 'grok:cli'));
  assert.ok(sandbox.fetchCalls.some((c) => c.url === '/api/routes/signout'), 'the route signs itself out');

  checked = false;
  page.handlers.railClick(clickEvent('settings'));
  await page.handlers.railClick(clickEvent('settings'));
  await settle();
  assert.match(sandbox.getEl('stack').innerHTML, /the codex command is not on the app's PATH/,
    'an unchecked read keeps what the check found');

  page.handlers.railClick(clickEvent('settings'));
  page.handlers.inspectorToggle({ preventDefault() {} });
  assert.equal(sandbox.getEl('inspector').hidden, false, 'open on a project');
  await page.handlers.railClick(clickEvent('settings'));
  await settle();
  assert.equal(sandbox.getEl('inspector').hidden, true, 'and not beside Connections');
  assert.equal(sandbox.getEl('inspector-toggle').hidden, true, 'nor the button that opens it');
  page.handlers.railClick(clickEvent('new-project'));
  assert.equal(sandbox.getEl('inspector').hidden, true, 'nor beside New Project');
  page.handlers.stackClick(clickEvent('new-project-cancel'));
  assert.equal(sandbox.getEl('inspector').hidden, false, 'and open again, as it was left');
  page.handlers.inspectorToggle({ preventDefault() {} });

  await page.handlers.railClick(clickEvent('settings'));
  page.handlers.railClick(clickEvent('settings'));
  assert.equal(page.getView(), 'project', 'Settings toggles back to the project');
  page.handlers.railClick(clickEvent('new-project'));
  assert.equal(page.getView(), 'new');
  await page.handlers.railClick(clickEvent('settings'));
  assert.equal(page.getView(), 'settings');
  page.handlers.railClick(clickEvent('settings'));
  assert.equal(page.getView(), 'new', 'and back to the New Project page it covered');
  page.handlers.stackClick(clickEvent('new-project-cancel'));

  const early = sampleState('experience-stage');
  early.routes = { allowlist: [], solo: false };
  page.setState(early);
  page.handlers.inspectorToggle({ preventDefault() {} });
  const inspector = sandbox.getEl('inspector-body').innerHTML;
  const picker = inspector.match(/<select id="seat-leader" data-seat="leader"[^>]*>[\s\S]*?<\/select>/)[0];
  assert.equal((picker.match(/<option /g) || []).length, 6, 'every route the machine has, not just the current one');
  assert.ok(!/optgroup/.test(picker), 'no allowlist to group by yet');
});

test('when no assistant is connected, setup remains optional while the project is accessible', async () => {
  const sandbox = makeSandbox();
  sandbox.axTrusted = false;
  let anyReady = false;
  sandbox.responses['/api/routes'] = () => {
    const last = sandbox.fetchCalls.filter((c) => String(c.url).includes('/api/routes')).pop();
    return {
      routes: [
        { id: 'claude:app:chat', provider: 'Claude', surface: 'app', label: 'Chat', method: 'stdio',
          ready: false, code: 'no_session', ax_gated: true, accessibility: false },
        { id: 'grok:cli', provider: 'Grok', surface: 'cli', label: 'Grok CLI', method: 'stdio',
          ready: anyReady, code: anyReady ? 'ok' : 'missing_binary', binary: 'grok' },
      ],
      allowlist: [], seats: null, checked: Boolean(last && String(last.url).includes('ready=1')),
    };
  };
  const page = loadPage(sandbox);
  await settle();
  page.setState(sampleState('plain'));
  assert.ok(!/class="cover"/.test(sandbox.getEl('stack').innerHTML), 'nothing is claimed before a check');

  await page.handlers.railClick(clickEvent('settings'));
  await settle();
  assert.ok(!/class="cover"/.test(sandbox.getEl('stack').innerHTML),
    'and never over Connections, which is the page it sends them to');

  page.handlers.stackClick(clickEvent('settings-close'));
  let html = sandbox.getEl('stack').innerHTML;
  assert.match(html, /class="cover"/, 'a machine with no route at all has nothing to show behind this');
  assert.match(html, /Nothing is connected yet/);
  assert.match(html, /data-action="setup-ax">Setup Accessibility<\/button>/);
  await page.handlers.stackClick(clickEvent('setup-ax'));
  assert.ok(sandbox.bridgeCalls.some((m) => m.op === 'accessibility.open'),
    'pressing it is what registers Agent Wheel with macOS, which is what lists it at all');

  page.handlers.stackClick(clickEvent('setup-hide'));
  assert.ok(!/class="cover"/.test(sandbox.getEl('stack').innerHTML), 'Not now means not now');

  anyReady = true;
  await page.handlers.railClick(clickEvent('settings'));
  await settle();
  page.handlers.stackClick(clickEvent('settings-close'));
  assert.ok(!/class="cover"/.test(sandbox.getEl('stack').innerHTML));
});

test('a seat picks its model and how hard it thinks from lists the binaries gave, and never types either', async () => {
  const sandbox = makeSandbox();
  const lv = (ids) => ids.map((id) => ({ id, label: id }));
  sandbox.responses['/api/routes'] = () => ({
    routes: [
      { id: 'claude:cli', provider: 'Claude', surface: 'cli', label: 'Claude CLI', ready: true, code: 'ok',
        choices: { models: [
          { id: '', label: 'Sonnet 5 (default)', efforts: lv(['low', 'medium', 'high', 'xhigh', 'max']) },
          { id: 'opus', label: 'Opus 5', efforts: lv(['low', 'medium', 'high', 'xhigh', 'max']) },
          { id: 'fable', label: 'Fable 5.1', efforts: lv(['low', 'medium', 'high', 'xhigh', 'max']) },
        ] } },
      { id: 'chatgpt:codex', provider: 'ChatGPT', surface: 'cli', label: 'Codex', ready: true, code: 'ok',
        choices: { models: [
          { id: '', label: 'Codex default', efforts: null },
          { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: lv(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']), default_effort: 'low' },
          { id: 'gpt-5.5', label: 'GPT-5.5', efforts: lv(['low', 'medium', 'high', 'xhigh']), default_effort: 'medium' },
        ] } },
      { id: 'cursor:cli', provider: 'Cursor', surface: 'cli', label: 'Cursor CLI', ready: true, code: 'ok',
        choices: { effort_is_model: true, models: [
          { id: 'auto', label: 'Auto (default)', efforts: [{ id: '', label: 'Auto (default)' }], default_effort: '' },
          { id: 'family:Claude Opus 5', label: 'Claude Opus 5', default_effort: 'claude-opus-5-high',
            efforts: [{ id: 'claude-opus-5-low', label: 'Low' }, { id: 'claude-opus-5-high', label: 'Default' },
              { id: 'claude-opus-5-thinking-max', label: 'Max · Thinking' }] },
          { id: 'family:Composer 2.5', label: 'Composer 2.5', default_effort: 'composer-2.5',
            efforts: [{ id: 'composer-2.5', label: 'Default' }, { id: 'composer-2.5-fast', label: 'Fast' }] },
        ] } },
      { id: 'claude:app:chat', provider: 'Claude', surface: 'app', label: 'Chat', ready: true, code: 'ok', choices: null },
    ],
    allowlist: ['claude:cli', 'chatgpt:codex', 'cursor:cli', 'claude:app:chat'], seats: null, checked: true,
  });
  const page = loadPage(sandbox);
  await settle();
  await page.handlers.railClick(clickEvent('settings'));
  await settle();
  page.handlers.stackClick(clickEvent('settings-close'));
  const seated = sampleState('working');
  seated.seats.leader = { route: 'claude:cli', cfg: { model: 'opus', effort: 'high' } };
  seated.seats.builder = { route: 'cursor:cli', cfg: { model: 'claude-opus-5-thinking-max' } };
  seated.seats.reviewer = { route: 'chatgpt:codex', cfg: { model: 'gpt-5.6-sol', effort: 'ultra' } };
  page.setState(seated);
  page.handlers.inspectorToggle({ preventDefault() {} });
  let inspector = sandbox.getEl('inspector-body').innerHTML;
  assert.ok(!/<input[^>]*data-seat/.test(inspector), 'no seat control is a field: nothing is typed, so nothing is mistyped');
  assert.match(inspector, /<option value="opus" selected>Opus 5<\/option>/);
  assert.match(inspector, /<option value="high" selected>high<\/option>/);
  assert.match(inspector, /<option value="gpt-5.6-sol" selected>GPT-5.6-Sol<\/option>/);
  assert.match(inspector, /<option value="ultra" selected>ultra<\/option>/);
  assert.match(inspector, /<option value="">default \(low\)<\/option>/, 'and says what the default level is');
  assert.match(inspector, /data-seat-family="1" data-seat="builder"><option value="auto">Auto \(default\)<\/option><option value="family:Claude Opus 5" selected>/);
  assert.match(inspector, /<option value="claude-opus-5-thinking-max" selected>Max · Thinking<\/option>/);
  assert.equal((inspector.match(/data-seat-cfg="model"/g) || []).length, 3, 'three seats with lists; the app route offers nothing');

  const lastTurn = () => JSON.parse(sandbox.fetchCalls.filter((c) => c.url === '/api/turn').at(-1).opts.body).input;
  await page.handlers.inspectorChange({ target: { dataset: { seat: 'reviewer', seatCfg: 'model' }, value: 'gpt-5.5' } });
  assert.deepEqual(lastTurn(), { type: 'seat_assignment', seat: 'reviewer', route: 'chatgpt:codex', config: { model: 'gpt-5.5' } },
    'gpt-5.5 has no ultra, so ultra does not ride along');
  page.setState(seated);
  await page.handlers.inspectorChange({ target: { dataset: { seat: 'leader', seatCfg: 'model' }, value: 'fable' } });
  assert.deepEqual(lastTurn().config, { model: 'fable', effort: 'high' }, 'a level the new model does have is kept');
  page.setState(seated);
  await page.handlers.inspectorChange({ target: { dataset: { seat: 'leader', seatCfg: 'effort' }, value: '' } });
  assert.deepEqual(lastTurn().config, { model: 'opus' }, 'the default level drops the key rather than sending an empty one');
  page.setState(seated);
  await page.handlers.inspectorChange({ target: { dataset: { seat: 'builder', seatFamily: '1' }, value: 'family:Composer 2.5' } });
  assert.deepEqual(lastTurn().config, { model: 'composer-2.5' });
  page.setState(seated);
  await page.handlers.inspectorChange({ target: { dataset: { seat: 'builder', seatCfg: 'model' }, value: 'claude-opus-5-low' } });
  assert.deepEqual(lastTurn().config, { model: 'claude-opus-5-low' });
  page.setState(seated);
  await page.handlers.inspectorChange({ target: { dataset: { seat: 'builder', seatFamily: '1' }, value: 'auto' } });
  assert.deepEqual(lastTurn().config, {}, 'Auto is Cursor\'s own default, so no model is sent at all');

  const stale = sampleState('working');
  stale.seats.leader = { route: 'claude:cli', cfg: { model: 'claude-opus-4-1' } };
  page.setState(stale);
  inspector = sandbox.getEl('inspector-body').innerHTML;
  assert.match(inspector, /<option value="claude-opus-4-1" selected>claude-opus-4-1<\/option>/);
});

test('a seat on an app route is attached from the project it belongs to, not from the machine\'s page', async () => {
  const sandbox = makeSandbox();
  sandbox.responses['/api/routes'] = () => ({
    routes: [
      { id: 'claude:app:chat', provider: 'Claude', surface: 'app', label: 'Chat', method: 'stdio',
        app_path: '/Applications/Claude.app', ready: false, code: 'no_session',
        ax_gated: true, accessibility: true },
      { id: 'grok:cli', provider: 'Grok', surface: 'cli', label: 'Grok CLI', method: 'stdio', ready: true, code: 'ok' },
    ],
    allowlist: ['claude:app:chat', 'grok:cli'], seats: null, checked: true,
  });
  sandbox.responses['/api/routes/attach'] = () => ({ ok: true, cwd: '/tmp/p/main', app_path: '/Applications/Claude.app' });
  const page = loadPage(sandbox);
  await settle();
  await page.handlers.railClick(clickEvent('settings'));
  await settle();
  page.handlers.stackClick(clickEvent('settings-close'));
  const s = sampleState('working');
  s.seats.leader.route = 'claude:app:chat';
  page.setState(s);
  page.handlers.inspectorToggle({ preventDefault() {} });
  let inspector = sandbox.getEl('inspector-body').innerHTML;
  assert.match(inspector, /data-action="seat-attach" data-arg="claude:app:chat">Attach session<\/button>/,
    'a session belongs to a folder, and the Inspector is where the folder is known');

  await page.handlers.inspectorClick(clickEvent('seat-attach', 'claude:app:chat'));
  await settle();
  const call = sandbox.fetchCalls.find((c) => c.url === '/api/routes/attach');
  assert.ok(call, 'the wheel binds the folder');
  assert.equal(JSON.parse(call.opts.body).route, 'claude:app:chat');
  assert.ok(sandbox.bridgeCalls.some((m) => m.op === 'app.open' && m.project === '/tmp/p/main'),
    'and opens the app at that folder, which is where the app writes the session');
  page.handlers.inspectorToggle({ preventDefault() {} });
  page.handlers.inspectorToggle({ preventDefault() {} });
  assert.match(sandbox.getEl('inspector-body').innerHTML, /Start a conversation and this attaches/,
    'and says the one step left, in place, without a list');
});

test('a disclosure the human opened is never closed by a poll, anywhere in the window', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  const s = sampleState('purple');
  s.nodes.spec.accepted.content = {
    requirements: [{ id: 'R1', requirement: 'one html file' }],
    security: ['no network'],
    providers_tools: ['node'],
  };
  page.setState(s);
  page.handlers.stackClick(clickEvent('toggle', 'spec'));
  assert.ok(!/<details class="tech" open>/.test(sandbox.getEl('stack').innerHTML), 'closed to begin with');

  page.handlers.stackClick(clickEvent('details-toggle', 'tech:spec'));
  assert.match(sandbox.getEl('stack').innerHTML, /<details class="tech" open>/);
  sandbox.responses['/api/state'] = () => s;
  await page.handlers.poll();
  await page.handlers.poll();
  assert.match(sandbox.getEl('stack').innerHTML, /<details class="tech" open>/, 'the poll leaves it open');
  page.render();
  assert.match(sandbox.getEl('stack').innerHTML, /<details class="tech" open>/, 'and so does a re-render');

  page.handlers.stackClick(clickEvent('details-toggle', 'raw:spec'));
  assert.match(sandbox.getEl('stack').innerHTML, /<details class="raw" open>/);
  page.handlers.stackClick(clickEvent('details-toggle', 'tech:spec'));
  assert.ok(!/<details class="tech" open>/.test(sandbox.getEl('stack').innerHTML), 'closing one leaves the other');
  assert.match(sandbox.getEl('stack').innerHTML, /<details class="raw" open>/);

  page.handlers.stackClick(clickEvent('details-toggle', 'advanced'));
  await page.handlers.railClick(clickEvent('settings'));
  await settle();
  assert.match(sandbox.getEl('stack').innerHTML, /<details class="tech" open><summary data-action="details-toggle" data-arg="advanced">Advanced: API keys/);
  await page.handlers.poll();
  assert.match(sandbox.getEl('stack').innerHTML, /<details class="tech" open>/, 'and the poll leaves it open');
});

test('what is waiting for the human\'s words is named directly under the box they type in', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  page.setState(sampleState('experience-stage'));
  assert.equal(sandbox.getEl('chat-target').innerHTML, '', 'no strip when nothing waits');
  assert.equal(sandbox.getEl('chat-input').placeholder, 'Nothing is waiting for a reply',
    'the placeholder says the state, not a button that is not there');
  assert.ok(!/prompt above/.test(sandbox.getEl('chat-input').placeholder), 'nothing points at an unnamed prompt');
  page.setState(sampleState('unspooled'));
  assert.equal(sandbox.getEl('chat-input').placeholder, 'Type an idea, then press Submit Idea',
    'and names Submit Idea where Submit Idea is the button');

  page.setState(sampleState('gated-design'));
  let strip = sandbox.getEl('chat-target').innerHTML;
  assert.match(strip, /Waiting on you/);
  assert.match(strip, /The Design is ready\. Approve, reply\/ask, summary, or reject\?/, 'the actual question, not a pointer to it');
  assert.match(strip, /What you type here goes with the button you press\./);
  assert.equal(sandbox.getEl('chat-input').placeholder, 'Your reply, if you have one');

  page.setState(sampleState('staged-idea'));
  strip = sandbox.getEl('chat-target').innerHTML;
  assert.match(strip, /Waiting on your review/);
  assert.match(strip, /what you type here is the note that goes back/);

  page.handlers.stackClick(clickEvent('chip', 'chip4'));
  strip = sandbox.getEl('chat-target').innerHTML;
  assert.match(strip, /Answering the Idea's solution/);
  assert.match(strip, new RegExp(CHIPS[3].prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(strip, /data-action="clear-target"/);
  page.handlers.chatFormClick(clickEvent('clear-target'));
  assert.equal(page.getChatTarget(), null);
  assert.equal(sandbox.getEl('chat-input').placeholder, 'Your reply, if you have one');
});

test('the composer shows the last response a seat gave, and only the button the moment has', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();

  const quiet = sampleState('experience-stage');
  page.setState(quiet);
  assert.equal(sandbox.getEl('chat-log').innerHTML, '', 'no log to scroll through');
  assert.equal(sandbox.getEl('btn-idea').hidden, true, 'a project is already made');
  assert.equal(sandbox.getEl('btn-send').hidden, false, 'Send is the button a running project has');

  const said = sampleState('working');
  said.last_response = {
    seat: 'reviewer', route: 'chatgpt:codex', about: { kind: 'closure', steps: 6 }, decision: 'gap',
    text: 'The exported file still linked a font from the network.',
    repair: 'plan v1: L1.3.C1', ts: '2026-09-03T19:22:36.474Z',
  };
  page.setState(said);
  let chat = sandbox.getEl('chat-log').innerHTML;
  assert.match(chat, /class="said-by">Reviewer &middot; chatgpt:codex <span class="about">on the closure<\/span>/);
  assert.match(chat, /<span class="badge gap">gap<\/span>/);
  assert.match(chat, /The exported file still linked a font from the network\./);
  assert.match(chat, /earliest repair: plan v1: L1\.3\.C1/);
  said.last_response = { seat: 'builder', route: 'grok:cli', about: null, decision: null, text: 'Second pass keeps every image as a data URL.', repair: null, ts: '2026-09-03T20:00:00.000Z' };
  page.setState(said);
  chat = sandbox.getEl('chat-log').innerHTML;
  assert.match(chat, /Second pass keeps every image as a data URL\./);
  assert.ok(!/still linked a font/.test(chat), 'one response, replaced, not a transcript');

  page.setState(sampleState('gated-design'));
  assert.equal(sandbox.getEl('btn-send').hidden, false);
  assert.equal(sandbox.getEl('btn-idea').hidden, true);

  page.setState(quiet);
  sandbox.getEl('chat-input').value = 'what do you think of the design so far';
  const before = sandbox.fetchCalls.filter((c) => c.url === '/api/turn').length;
  await page.handlers.chatSubmit(submitEvent());
  assert.equal(sandbox.fetchCalls.filter((c) => c.url === '/api/turn').length, before, 'nothing is staged');
  assert.match(sandbox.getEl('chat-log').innerHTML, /nothing is waiting for a reply/);
  assert.ok(!/pick one of the Idea prompts/.test(sandbox.getEl('chat-log').innerHTML));
  assert.equal(sandbox.getEl('chat-input').value, 'what do you think of the design so far',
    'nothing empties the box but something that took what was in it');

  page.setState(sampleState('unspooled'));
  assert.equal(sandbox.getEl('btn-idea').hidden, false);
  assert.equal(sandbox.getEl('btn-send').hidden, true);
  assert.ok(!/said-by|said-link/.test(sandbox.getEl('chat-log').innerHTML), 'no seat has spoken here');
});

test('a response belongs to one project and to the project view, and never follows the human out of it', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  const spoken = sampleState('purple');
  spoken.last_response = {
    seat: 'reviewer', route: 'chatgpt:codex', about: { kind: 'closure' }, decision: 'accept',
    text: 'Every claimed artifact hash traces to the accepted Plan.', repair: null, ts: '2026-09-03T19:22:36.474Z',
  };
  page.setState(spoken);
  assert.match(sandbox.getEl('chat-log').innerHTML, /Every claimed artifact hash traces/);
  assert.match(sandbox.getEl('chat-log').innerHTML, /Final product:/);

  page.handlers.railClick(clickEvent('new-project'));
  assert.equal(sandbox.getEl('chat-log').innerHTML, '', 'no response section on New Project');
  page.handlers.stackClick(clickEvent('new-project-cancel'));
  assert.match(sandbox.getEl('chat-log').innerHTML, /Every claimed artifact hash traces/, 'and it comes back');

  await page.handlers.railClick(clickEvent('settings'));
  await settle();
  assert.equal(sandbox.getEl('chat-log').innerHTML, '', 'no response section on Connections');
  page.handlers.stackClick(clickEvent('settings-close'));

  sandbox.responses['/api/state'] = () => spoken;
  await page.handlers.railClick(clickEvent('select-project', 'p_2'));
  assert.equal(page.getSelectedProject(), 'p_2');
  assert.equal(sandbox.getEl('chat-log').innerHTML, '', 'p_1 does not speak inside p_2');
  const second = sampleState('purple');
  second.project = { id: 'p_2', name: 'Second Note' };
  second.last_response = { seat: 'builder', route: 'grok:cli', about: null, decision: null, text: 'Second Note built clean.', repair: null, ts: '2026-09-04T00:00:00.000Z' };
  sandbox.responses['/api/state'] = () => second;
  await page.handlers.poll();
  assert.match(sandbox.getEl('chat-log').innerHTML, /Second Note built clean\./, 'and the one that arrives does');
  assert.ok(!/Every claimed artifact hash/.test(sandbox.getEl('chat-log').innerHTML));
});

test('a poll carrying no new event repaints nothing but the run band', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  const quiet = sampleState('working');
  sandbox.responses['/api/state'] = () => quiet;
  await page.handlers.poll();

  const boxes = ['stack', 'rail-list', 'inspector-body', 'chat-target'];
  page.handlers.inspectorToggle({ preventDefault() {} });
  for (const id of boxes) sandbox.getEl(id).innerHTML = 'SENTINEL-' + id;
  await page.handlers.poll();
  await page.handlers.poll();
  await page.handlers.poll();
  for (const id of boxes) {
    assert.equal(sandbox.getEl(id).innerHTML, 'SENTINEL-' + id, id + ' was rewritten for nothing');
  }
  assert.match(sandbox.getEl('activity').innerHTML, /is building/, 'the band keeps its own clock');

  const moves = [
    ['a commit', 'stack', (s) => { s.seq = 99; s.frontier = { ...s.frontier, stage: 'design' }; }],
    ['another project in the rail', 'rail-list', (s) => { s.projects = [...s.projects, { id: 'p_9', name: 'Third Note', status: 'green', stage: 'idea' }]; }],
    ['a status the residue forces', 'activity', (s) => { s.status = 'red'; s.activity = { ...s.activity, working: null, stopped: true }; }],
    ['crash residue the helper found', null, (s) => { s.recovery = { cause: 'lock', detected: '2026-09-08T00:00:00.000Z' }; }],
  ];
  for (const [what, box, move] of moves) {
    const next = sampleState('working');
    move(next);
    sandbox.responses['/api/state'] = () => next;
    const keyBefore = page.getStateKey();
    if (box) sandbox.getEl(box).innerHTML = 'SENTINEL-' + box;
    await page.handlers.poll();
    assert.notEqual(page.getStateKey(), keyBefore, what + ' must be news to the compare key');
    if (box) assert.notEqual(sandbox.getEl(box).innerHTML, 'SENTINEL-' + box, what + ' must reach the window');
    sandbox.responses['/api/state'] = () => quiet;
    await page.handlers.poll();
  }
});

test('a provider key is never painted into markup, and survives a repaint that had nothing to do with it', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  sandbox.responses['/api/routes'] = () => ({
    routes: [{ id: 'grok:cli', provider: 'Grok', surface: 'cli', label: 'Grok CLI', method: 'stdio' }],
    allowlist: ['grok:cli'], seats: null, checked: false,
  });
  page.setState(sampleState('working'));
  await page.handlers.railClick(clickEvent('settings'));
  await settle();

  const html = sandbox.getEl('stack').innerHTML;
  assert.match(html, /<input id="skey-anthropic" type="password"/);
  assert.ok(!/value=/.test(html.split('skey-anthropic')[1].split('>')[0]), 'no value in the markup');

  sandbox.getEl('skey-anthropic').value = 'sk-ant-secret';
  const moved = { ...sampleState('working'), seq: 42 };
  sandbox.responses['/api/state'] = () => moved;
  await page.handlers.poll();
  assert.equal(sandbox.getEl('skey-anthropic').value, 'sk-ant-secret', 'the key survives the repaint');
  const after = sandbox.getEl('stack').innerHTML + sandbox.getEl('inspector-body').innerHTML;
  assert.ok(!/sk-ant-secret/.test(after), 'and still never appears in markup');

  await page.handlers.stackClick(clickEvent('settings-key-save', 'anthropic'));
  await settle();
  assert.ok(sandbox.bridgeCalls.some((m) => m.op === 'keychain.set' && m.key === 'sk-ant-secret'));
  assert.equal(sandbox.getEl('skey-anthropic').value, '');
  assert.ok(!sandbox.fetchCalls.some((c) => c.opts && c.opts.body && String(c.opts.body).includes('sk-ant-secret')));
});

test('the Exact values disclosure carries its json only while it is open', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  const s = sampleState('purple');
  s.nodes.spec.accepted.content = { requirements: [{ id: 'R1', requirement: 'one html file' }] };
  page.setState(s);
  page.handlers.stackClick(clickEvent('toggle', 'spec'));
  assert.match(sandbox.getEl('stack').innerHTML, /Exact values/);
  assert.ok(!/&quot;requirement&quot;/.test(sandbox.getEl('stack').innerHTML), 'closed, so not built');
  page.handlers.stackClick(clickEvent('details-toggle', 'raw:spec'));
  assert.match(sandbox.getEl('stack').innerHTML, /<details class="raw" open>/);
  assert.match(sandbox.getEl('stack').innerHTML, /&quot;requirement&quot;/, 'open, so built');
  page.handlers.stackClick(clickEvent('details-toggle', 'raw:spec'));
  assert.ok(!/&quot;requirement&quot;/.test(sandbox.getEl('stack').innerHTML), 'closed again');
});

test('an unsubmitted form, and a reopen walk, belong to the project they were made in', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  const a = sampleState('experience-stage');
  sandbox.responses['/api/state'] = () => a;
  await page.handlers.poll();
  page.handlers.stackClick(clickEvent('toggle', 'experience'));
  page.handlers.stackInput({ target: { id: 'form-experience', value: '{"actors":["PROJECT ONE ONLY"]}' } });
  assert.equal(page.getFormDrafts().experience, '{"actors":["PROJECT ONE ONLY"]}');

  const b = sampleState('experience-stage');
  b.project = { id: 'p_2', name: 'Second Note' };
  sandbox.responses['/api/state'] = () => b;
  await page.handlers.railClick(clickEvent('select-project', 'p_2'));
  assert.equal(page.getSelectedProject(), 'p_2');
  assert.equal(page.getFormDrafts().experience, undefined, 'p_1\'s draft is not p_2\'s');
  page.handlers.stackClick(clickEvent('toggle', 'experience'));
  const seeded = sandbox.getEl('stack').innerHTML;
  assert.ok(!/PROJECT ONE ONLY/.test(seeded), 'and it is not seeded into p_2\'s form either');

  page.handlers.stackInput({ target: { id: 'form-experience', value: '{"actors":["PROJECT TWO"]}' } });
  await page.handlers.stackClick(clickEvent('form-submit', 'experience'));
  const posted = JSON.parse(sandbox.fetchCalls.filter((c) => c.url === '/api/turn').at(-1).opts.body);
  assert.deepEqual(posted.input.content, { actors: ['PROJECT TWO'] });
  assert.equal(posted.project, 'p_2');

  sandbox.responses['/api/state'] = () => a;
  await page.handlers.railClick(clickEvent('select-project', 'p_1'));
  assert.equal(page.getFormDrafts().experience, '{"actors":["PROJECT ONE ONLY"]}', 'a draft waits for its own project');

  const withReopen = sampleState('experience-stage');
  withReopen.frontier.next_legal = ['form:experience', 'reopen'];
  sandbox.responses['/api/state'] = () => withReopen;
  await page.handlers.poll();
  sandbox.responses['/api/reopen/preview'] = () => ({
    ok: true, kind: 'idea', claims: ['problem'], leaves_back_to_untried: [{ id: 'L1.ONLY.P1', state: 'done' }], legal: true,
  });
  page.handlers.stackClick(clickEvent('toggle', 'idea'));
  await page.handlers.stackClick(clickEvent('reopen', 'idea'));
  await settle();
  assert.match(sandbox.getEl('stack').innerHTML, /L1\.ONLY\.P1/);
  sandbox.responses['/api/state'] = () => b;
  await page.handlers.railClick(clickEvent('select-project', 'p_2'));
  page.handlers.stackClick(clickEvent('toggle', 'idea'));
  assert.ok(!/L1\.ONLY\.P1/.test(sandbox.getEl('stack').innerHTML), 'p_1\'s walk is not shown over p_2');
  assert.ok(!/data-action="reopen-confirm"/.test(sandbox.getEl('stack').innerHTML), 'and cannot be confirmed there');
});

test('tapping a project in the rail never paints a window without one', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  sandbox.responses['/api/state'] = () => sampleState('gated-design');
  await page.handlers.poll();
  const screen = () => ['stack', 'rail-list', 'chat-log', 'chat-target'].map((id) => sandbox.getEl(id).innerHTML)
    .concat(sandbox.getEl('project-name').textContent, sandbox.getEl('btn-send').hidden);
  const shown = screen();

  const fetched = sandbox.fetchCalls.length;
  const again = page.handlers.railClick(clickEvent('select-project', 'p_1'));
  assert.deepEqual(screen(), shown, 'not even for a frame');
  await again;
  await settle();
  assert.deepEqual(screen(), shown);
  assert.equal(sandbox.fetchCalls.length, fetched);

  const b = sampleState('experience-stage');
  b.project = { id: 'p_2', name: 'Second Note' };
  sandbox.responses['/api/state'] = () => b;
  const switching = page.handlers.railClick(clickEvent('select-project', 'p_2'));
  assert.match(sandbox.getEl('rail-list').innerHTML, /rail-item selected"[^>]*data-action="select-project" data-arg="p_2"/);
  assert.equal(sandbox.getEl('project-name').textContent, 'Tiny Note', 'no "no project" frame');
  assert.equal(sandbox.getEl('stack').innerHTML, shown[0], 'and no empty stack');
  await page.handlers.stackClick(clickEvent('gate', 'ACCEPT'));
  assert.ok(!sandbox.fetchCalls.some((c) => c.url === '/api/turn'), 'p_1\'s gate is not answered inside p_2');
  await switching;
  assert.equal(sandbox.getEl('project-name').textContent, 'Second Note');
});

test('a dispatch a guard refuses says so, and a seat whose route is not set up is warned about before the wheel needs it', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();

  const held = sampleState('working');
  held.seq = 55;
  held.activity = {
    working: null,
    staged: { seat: 'builder', kind: 'execute', route: 'grok:cli', attempt: 0 },
    waiting: null, pull: null, stopped: false, interrupted: null, last_failure: null,
    refused: {
      guard: 'write_tool_scope', route: 'grok:cli', dispatch_id: 'd_1',
      reason: 'grok:cli: the seat asked for a tool the Spec does not allow', ts: new Date().toISOString(),
    },
  };
  page.setState(held);
  const band = sandbox.getEl('activity').innerHTML;
  assert.match(band, /Held before it went out\./);
  assert.match(band, /the seat requested access outside its permitted scope/);
  assert.match(band, /The wheel tries again on its own; nothing is lost\./);
  assert.ok(!/Ready to go out/.test(band), 'a refused dispatch is not a dispatch about to leave');

  held.activity.refused.guard = 'something_new_upstream';
  page.setState(held);
  assert.match(sandbox.getEl('activity').innerHTML, /something new upstream/);

  sandbox.responses['/api/routes'] = () => ({
    routes: [
      { id: 'grok:cli', provider: 'Grok', surface: 'cli', label: 'Grok CLI', method: 'stdio', ready: true, code: 'ok', binary: '/bin/grok' },
      { id: 'chatgpt:codex', provider: 'ChatGPT', surface: 'cli', label: 'Codex', method: 'stdio', ready: false, code: 'missing_binary', binary: 'codex' },
    ],
    allowlist: ['grok:cli', 'chatgpt:codex'], seats: null, checked: true,
  });
  await page.handlers.railClick(clickEvent('settings'));
  await settle();
  page.handlers.stackClick(clickEvent('settings-close'));
  page.handlers.inspectorToggle({ preventDefault() {} });
  const inspector = sandbox.getEl('inspector-body').innerHTML;
  assert.match(inspector, /<div class="seat-warn">The codex command is not on the app's PATH\.<\/div>/,
    'the sentence already says the route is not set up; a prefix says it twice');
  assert.equal((inspector.match(/seat-warn/g) || []).length, 1, 'only the seat that cannot run is warned about');
  assert.match(inspector, /data-action="settings">Connections<\/button>/, 'and it says where to look');
});

test('the project inspector refreshes model choices without spending prompts or running readiness probes', async () => {
  const sandbox = makeSandbox();
  const page = loadPage(sandbox);
  await settle();
  page.setState(sampleState('experience-stage'));
  const row = { id: 'chatgpt:codex', provider: 'ChatGPT', label: 'Codex', surface: 'cli', ready: true };
  sandbox.responses['/api/routes'] = () => ({ routes: [{ ...row, choices: { models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }] } }], checked: true });
  await page.handlers.inspectorToggle({ preventDefault() {} });
  const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  sandbox.responses['/api/routes'] = () => ({ routes: [{ ...row, choices: { models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: levels.map(id => ({ id, label: id })) }] } }], checked: false });
  await page.handlers.inspectorClick(clickEvent('refresh-models'));
  const request = sandbox.fetchCalls.at(-1);
  assert.ok(request.url.includes('project=p_1') && request.url.includes('models=1'));
  assert.ok(!request.url.includes('ready=1'));
  assert.match(sandbox.getEl('inspector-body').innerHTML, /GPT-6 Astra/);
  assert.ok(!/GPT-5.5|Allowed by the Spec/.test(sandbox.getEl('inspector-body').innerHTML));
  assert.equal(sandbox.fetchCalls.filter(call => call.url === '/api/turn').length, 0);
});
