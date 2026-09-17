'use strict';

const fs = require('fs');
const { Wheel } = require('../../lib/wheel');
const commitlib = require('../../lib/commit');
const lease = require('../../lib/lease');
const storelib = require('../../lib/store');
const cargo = require('../tiny-cargo');

const crashAt = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : null;
const crashSeq = Number(process.argv[3] || 0) || null;

function say(obj) {
  fs.writeSync(1, JSON.stringify(obj) + '\n');
}

const known = storelib.listProjects()[0];
const wheel = new Wheel({ heartbeatMs: 100, ...(known ? { project: known.id } : {}) });
say({
  event: 'booted',
  project: wheel.projectId,
  recovery: wheel.recovery
    ? { cause: wheel.recovery.cause, lock: wheel.recovery.lock.present, lease_interrupted: wheel.recovery.lease.interrupted }
    : null,
  seq: wheel.state ? wheel.state.seq : 0,
  lock_present: fs.existsSync(wheel.paths.lockPath),
  status: wheel.status(),
  gate: wheel.gateView() ? wheel.gateView().id : null,
  next_legal: wheel.frontier().next_legal,
});

const PROBLEM = 'Splitting a bill by hand stalls the whole table at the end of dinner.';
const SOLUTION = 'One screen shows tip, total, and an even per-person share instantly.';

function drive() {
  if (crashAt) {
    commitlib.testHooks.crashAt = crashAt;
    commitlib.testHooks.seq = crashSeq;
  }
  commitlib.testHooks.onApplying = (seq) => say({ event: 'applying', seq });
  const step = () => {
    const legal = wheel.frontier().next_legal;
    const draft = wheel.state && wheel.state.nodes.idea.draft;
    let input;
    if (legal.includes('spool')) {
      input = { type: 'spool', ...cargo.ideaText() };
    } else if (legal.includes('validate')) {
      input = { type: 'validate', action: 'REJECT_RESTAGE', note: 'loop' };
    } else if (legal.includes('gate') && wheel.state.gate && wheel.state.gate.id === 'BUDGET_GATE') {
      input = { type: 'gate', action: 'EXTEND' };
    } else if (legal.includes('prompt')) {
      const solutionNext = Boolean(draft && draft.problem.length >= 20);
      input = {
        type: 'prompt',
        text: solutionNext ? SOLUTION : PROBLEM,
        target: { kind: 'idea', field: solutionNext ? 'solution' : 'problem' },
      };
    } else {
      say({ event: 'stuck', legal });
      process.exit(3);
    }
    const r = wheel.runTurn(input);
    say({ event: 'committed', ok: r.ok, seq: wheel.state ? wheel.state.seq : 0, error: r.error || null });
    if (!r.ok && !(r.gate && r.gate.id === 'BUDGET_GATE')) process.exit(4);
    setImmediate(step);
  };
  setImmediate(step);
}

if (wheel.recovery) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const action = buf.slice(0, nl).trim();
    buf = '';
    const r = wheel.runTurn({ type: 'gate', action });
    say({
      event: 'recovered', ok: r.ok, error: r.error || null, action,
      seq: wheel.state ? wheel.state.seq : 0,
      lock_present: fs.existsSync(wheel.paths.lockPath),
      lease: lease.read(wheel.paths),
    });
    process.stdin.pause();
    if (r.ok) drive(); else process.exit(5);
  });
} else {
  drive();
}
