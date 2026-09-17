'use strict';
const { resetStore } = require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cargo = require('./tiny-cargo');
const { auditTail } = require('../lib/store');
const { GUARDS } = require('../lib/egress');

const FAKE_PROVIDER = `
'use strict';
let prompt = '';
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  if (prompt.includes('REVIEW SUBJECT')) {
    process.stdout.write(JSON.stringify({ decision: 'accept', references: ['reviewed'], notes: 'fake reviewer accepts in a fresh context' }));
    return;
  }
  if (prompt.includes('LEAVES TO EXECUTE')) {
    // The Builder: exactly the dispatched leaves, the artifact, and a test suite.
    const after = prompt.slice(prompt.indexOf('LEAVES TO EXECUTE'));
    const leaves = [...after.matchAll(/^- (L[0-9A-Za-z.]+) \\[/gm)].map((m) => m[1]);
    process.stdout.write(JSON.stringify({
      leaves,
      files: {
        'index.html': '<!doctype html>\\n<html><body>hello</body></html>\\n',
        'test.js': [
          "'use strict';",
          "const fs = require('fs');",
          "const html = fs.readFileSync('index.html', 'utf8');",
          "const pass = html.includes('hello') ? 1 : 0;",
          "console.log('TESTS passed=' + pass + ' failed=' + (1 - pass));",
          'process.exit(pass ? 0 : 1);',
        ].join('\\n'),
      },
      main_file: 'index.html',
      test_command: 'node test.js',
      notes: 'fake provider execution for the runner integration test',
    }));
    return;
  }
  if (prompt.includes('PLAN LEAVES TO TRY')) {
    const na = { applicable: false, reason: 'fake provider engine test: not applicable here' };
    const leaves = {};
    for (const m of prompt.matchAll(/^- (L[0-9A-Za-z.]+) \\[(\\w+)[^\\]]*\\]: /gm)) {
      // Kind-owned applicability (law, PLAN TRIAL LAW 3): action, expected_result, and loop leaves run an
      // executable test; the assumption leaf is derivation-only.
      const runs = m[2] !== 'assumption' && m[2] !== 'decision';
      const bases = { first_principles: na, trusted_method: na, math: na, physics: na,
        executable_test: runs ? { applicable: true, exec: { files: { 't.js': "console.log('fake leaf test'); process.exit(0);" }, entry: 't.js' } } : na,
        inspection: { applicable: true, observation: 'fake provider inspected the leaf for the engine test run' } };
      leaves[m[1]] = m[2] === 'decision'
        ? { bases: { ...bases, inspection: na }, alternatives: [
            { id: 'ALT1', name: 'fake way one', summary: 'assembles trivially for the test',
              build: { files: { 'b.js': 'process.exit(0);' }, entry: 'b.js' } },
            { id: 'ALT2', name: 'fake way two', summary: 'also assembles for comparison',
              build: { files: { 'b.js': 'process.exit(0);' }, entry: 'b.js' } },
          ], chosen: 'ALT1', rationale: 'both assemble; ALT1 is the single-file shape the spec asks for' }
        : { bases };
    }
    process.stdout.write(JSON.stringify({ leaves }));
    return;
  }
  process.stdout.write(JSON.stringify({ error: 'fake provider: unknown seat prompt' }));
});
`;

function auth(token) {
  return { authorization: 'Bearer ' + token, connection: 'close' };
}
async function getJson(url, token) {
  const res = await fetch(url, { headers: auth(token) });
  return res.json();
}
async function postTurn(base, input, token) {
  const res = await fetch(base + '/api/turn', {
    method: 'POST',
    headers: { ...auth(token), 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  return res.json();
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 60000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) {
      const st = waitFor.helper ? waitFor.helper.wheel.state : null;
      const summary = st ? {
        status: st.status, phase: st.wheel.phase, gate: st.gate && st.gate.id, stage: st.frontier && st.frontier.stage,
        pending_seat: st.pending_seat && st.pending_seat.kind, pending_dispatch: st.pending_dispatch && st.pending_dispatch.kind,
        pending_validation: st.pending_validation && st.pending_validation.kind,
        plan: st.nodes.plan.versions.map((v) => v.state), last_schema_reject: st.last_schema_reject,
        last_transport_failure: st.last_transport_failure, last_egress_refusal: st.last_egress_refusal,
        execution: st.execution, leaves: st.leaves,
      } : null;
      const tail = (waitFor.helper && waitFor.helper.wheel ? auditTail(8, waitFor.helper.wheel.paths) : auditTail(8)).map((a) => JSON.stringify(a).slice(0, 200));
      const cards = waitFor.helper ? waitFor.helper.transport.listCards().map((c) => c.id + ' ' + c.state + ' ' + String(c.reply || '').slice(0, 160)) : [];
      assert.fail('timed out waiting for ' + what + '\nstate: ' + JSON.stringify(summary) + '\naudit:\n  ' + tail.join('\n  ') + '\ncards:\n  ' + cards.join('\n  '));
    }
    await wait(150);
  }
}

test('occupied seats close the circle over the bus: Core spawns the seat runner, the runner drives a fake model', async () => {
  resetStore();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-out-'));
  const providerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-fake-')), 'fake-provider.js');
  fs.writeFileSync(providerPath, FAKE_PROVIDER);
  const token = crypto.randomBytes(24).toString('hex');
  const routes = ['claude:cli'];
  const fake = { route: 'claude:cli', config: { command: ['node', providerPath] } };

  const h = await require('../surfaces/helper').start({ port: 0, token, watchMs: 100 });
  waitFor.helper = h;
  const base = `http://127.0.0.1:${h.port}`;
  try {
    assert.equal((await postTurn(base, { type: 'spool', ...cargo.ideaText() }, token)).ok, true);
    assert.equal((await postTurn(base, { type: 'validate', action: 'ACCEPT' }, token)).ok, true);
    for (const seat of ['leader', 'builder', 'reviewer']) {
      assert.equal((await postTurn(base, { type: 'seat_assignment', seat, ...fake }, token)).ok, true);
    }
    assert.equal((await postTurn(base, { type: 'form', kind: 'experience', content: cargo.experience() }, token)).ok, true);
    assert.equal((await postTurn(base, { type: 'validate', action: 'ACCEPT' }, token)).ok, true);
    assert.equal((await postTurn(base, { type: 'form', kind: 'design', content: cargo.design() }, token)).ok, true);
    assert.equal((await postTurn(base, { type: 'gate', action: 'APPROVE' }, token)).ok, true);
    assert.equal((await postTurn(base, { type: 'form', kind: 'spec', content: cargo.spec(outDir) }, token)).ok, true);
    assert.equal((await postTurn(base, { type: 'validate', action: 'ACCEPT' }, token)).ok, true);

    let s = await waitFor(async () => {
      const x = await getJson(base + '/api/state', token);
      return x.nodes.plan && x.nodes.plan.accepted ? x : null;
    }, 'plan accepted after the independent review');
    assert.equal(s.gate && s.gate.id, 'PLAN_READY');
    assert.equal(s.closure_proof.all_ok, true);
    assert.equal((await postTurn(base, { type: 'gate', action: 'APPROVE' }, token)).ok, true);

    s = await waitFor(async () => {
      const x = await getJson(base + '/api/state', token);
      return x.status === 'purple' ? x : null;
    }, 'every leaf executed, reviewed, merged; the closure reviewed; PROJECT_DONE', 120000);
    assert.ok(fs.existsSync(path.join(outDir, 'index.html')), 'artifact promoted');
    const executions = Object.values(s.executions);
    assert.equal(executions.length, 2, 'one execution per after[]-ordered Builder group; the release leaves are the closure\'s');
    assert.ok(executions.every((e) => e.state === 'accepted' && e.authored_by === 'seat'));
    assert.equal(Object.values(s.leaves).filter((l) => l.state === 'done').length, 10, 'every leaf done');
    assert.equal(s.closure.state, 'accepted');
    assert.equal(s.closure.steps.length, 6);
    assert.ok(s.closure.steps.every((step) => step.ok));
    assert.ok(s.project_done);
    assert.equal(s.main.merged.length, 2);

    const cards = await getJson(base + '/api/cards?n=200', token);
    assert.equal(cards.length, 7, 'one card per dispatch: the trial and its review, two Builder executions and their reviews (the release leaves belong to the closure), the closure review');
    for (const c of cards) {
      assert.match(c.id, /^card_[0-9a-f]{12}$/);
      assert.equal(c.seat, 'claude-cli');
      assert.equal(c.method, 'stdio');
      assert.equal(c.state, 'back');
      assert.match(c.reply, /"outcome":"result"/);
    }
    const guards = auditTail(2000, h.wheel.paths).filter((a) => a.phase === 'EGRESS_GUARD');
    assert.equal(guards.length, 7, 'one guarded egress per card');
    for (const g of guards) assert.deepEqual(g.checked, GUARDS);
    assert.equal(h.transport.inflight().length, 0, 'nothing left in flight');
    assert.ok(auditTail(2000, h.wheel.paths).some((a) => a.event === 'PROJECT_DONE'));
  } finally {
    clearInterval(h.watcher);
    h.closeAll();
    h.server.close();
  }
});

test('the runner spawns every provider in an empty scratch working directory of its own, never the store, and removes it afterwards', async () => {
  const { runCard } = require('../seats/runner');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cwd-probe-'));
  const providerPath = path.join(dir, 'provider.js');
  const sidePath = path.join(dir, 'seen.json');
  fs.writeFileSync(providerPath, [
    "const fs = require('fs');",
    "fs.writeFileSync(process.env.AW_TEST_SIDE, JSON.stringify({ cwd: process.cwd(), entries: fs.readdirSync(process.cwd()) }));",
    "process.stdout.write(JSON.stringify({ leaves: {} }));",
  ].join('\n'));
  process.env.AW_TEST_SIDE = sidePath;
  try {
    const card = JSON.stringify({ id: 'card_cwd', body: JSON.stringify({
      type: 'dispatch', seat: 'leader', kind: 'plan_trial', route: 'claude:cli', result_schema: 'TRIAL_KIT', timeout_ms: 20000,
      system_prompt: 'system', prompt: 'prompt', superdoc: { binding: {} },
      provider: { command: ['node', providerPath] },
    }) });
    const out = await runCard(card);
    assert.equal(out.outcome, 'result', JSON.stringify(out).slice(0, 300));
    const seen = JSON.parse(fs.readFileSync(sidePath, 'utf8'));
    assert.match(path.basename(seen.cwd), /^aw-seat-cwd-/, 'a scratch directory of its own: ' + seen.cwd);
    assert.equal(fs.realpathSync(path.dirname(seen.cwd)), fs.realpathSync(os.tmpdir()));
    assert.notEqual(fs.realpathSync(seen.cwd.replace(/[^/]+$/, '')), fs.realpathSync(require('../lib/paths').storeDir + '/..'), 'never the store');
    assert.deepEqual(seen.entries, [], 'empty: the seat sees only what the card carries');
    assert.ok(!fs.existsSync(seen.cwd), 'gone after the run');
  } finally {
    delete process.env.AW_TEST_SIDE;
  }
});
