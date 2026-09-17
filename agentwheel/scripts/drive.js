#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const seedDir = process.argv[2];
const fdIndex = process.argv.indexOf('--token-fd');
if (!seedDir || !fs.existsSync(seedDir) || fdIndex < 0) {
  console.error('usage: node scripts/drive.js <seed-dir> --token-fd N');
  process.exit(2);
}
let launch;
try {
  launch = JSON.parse(fs.readFileSync(Number(process.argv[fdIndex + 1]), 'utf8').split('\n')[0]);
} catch {
  console.error('drive: expected {port, token} on the --token-fd descriptor');
  process.exit(2);
}
const base = `http://127.0.0.1:${launch.port}`;

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(seedDir, name), 'utf8'));
}

async function api(pathname, body) {
  const headers = { authorization: 'Bearer ' + launch.token, connection: 'close' };
  const res = await fetch(base + pathname, body === undefined
    ? { headers }
    : {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
  return res.json();
}

async function turn(input) {
  const r = await api('/api/turn', { input });
  const label = input.type + (input.kind ? ':' + input.kind : '') +
    (input.action ? ' ' + input.action : '') +
    (input.decision ? ' ' + input.decision : '');
  if (r.ok) {
    console.log(`  ${r.turn} ${label} -> ok   [${r.status}] stage=${r.frontier.stage}`);
  } else {
    console.log(`  ${r.turn || '-'} ${label} -> ${r.error}`);
  }
  return r;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const who = await api('/api/status');
  if (who.surface !== 'helper') throw new Error('helper not answering');
  let state = await api('/api/state');
  console.log('helper up: ' + who.status + '\n');

  let consultedSummary = false;
  const deadline = Date.now() + 45 * 60000;
  let lastHeartbeat = 0;
  while (Date.now() < deadline) {
    state = await api('/api/state').catch(() => null);
    if (!state || state.error || !state.frontier) {
      if (Date.now() - lastHeartbeat > 15000) {
        lastHeartbeat = Date.now();
        console.log('  ... helper unreachable; waiting');
      }
      await wait(1000);
      continue;
    }
    if (state.status === 'purple') break;
    const legal = state.frontier.next_legal;

    if (legal.includes('seat_dispatch') || legal.includes('seat_result') ||
        legal.includes('plan_generate') || legal.includes('finalize') || legal.includes('project_done')) {
      if (Date.now() - lastHeartbeat > 15000) {
        lastHeartbeat = Date.now();
        const ps = state.pending_seat;
        console.log(ps
          ? `  ... ${ps.seat} seat working (${ps.kind}, attempt ${ps.attempts + 1})`
          : `  ... waiting on the wheel (legal: ${legal.join(', ')})`);
      }
      await wait(1000);
      continue;
    }

    if (legal.includes('spool')) {
      const idea = readJson('idea.json');
      console.log(`== spool "${idea.name}" through the composer's spool lane ==`);
      const spool = await api('/api/spool', idea);
      if (!spool.mcp) throw new Error('spool failed: ' + JSON.stringify(spool));
      const r = JSON.parse(spool.result.content[0].text);
      console.log(`  spool_project -> ${r.ok ? 'ok' : r.error} [${r.status}]`);
      if (!r.ok) process.exit(1);
    } else if (legal.includes('validate')) {
      const r = await turn({ type: 'validate', action: 'ACCEPT' });
      if (!r.ok) process.exit(1);
    } else if (legal.includes('gate')) {
      const gate = state.gate;
      console.log(`  [gate ${gate.id}] ${gate.def.question} (${gate.def.actions.join(' | ')})`);
      let action;
      if (gate.id === 'DESIGN_READY') {
        if (!consultedSummary) { await turn({ type: 'gate', action: 'SUMMARY' }); consultedSummary = true; continue; }
        action = 'APPROVE';
      } else if (gate.id === 'PLAN_READY') {
        action = 'APPROVE';
      } else if (gate.id === 'BUDGET_GATE') {
        action = 'EXTEND';
      } else if (gate.id === 'RECOVERY_REQUIRED') {
        action = 'RESUME';
      } else {
        action = 'RETRY';
      }
      const r = await turn({ type: 'gate', action });
      if (!r.ok) process.exit(1);
    } else if (legal.includes('form:experience')) {
      console.log('== Experience ==');
      await turn({ type: 'form', kind: 'experience', content: readJson('experience.json') });
    } else if (legal.includes('form:design')) {
      console.log('== Design: read-only until approved at DESIGN_READY ==');
      await turn({ type: 'form', kind: 'design', content: readJson('design.json') });
    } else if (legal.includes('form:spec')) {
      console.log('== Spec (product requirements and release) ==');
      await turn({ type: 'form', kind: 'spec', content: readJson('spec.json') });
    } else {
      throw new Error('no move for frontier: ' + JSON.stringify(legal));
    }
  }

  state = await api('/api/state');
  console.log('\n================ CIRCLE REPORT ================');
  console.log(`status:        ${state.status.toUpperCase()}`);
  console.log(`project:       ${state.project.name}`);
  console.log(`turns:         ${state.turns.last_id}  (budget ${state.budget.used}/${state.budget.authority} in window)`);
  console.log(`artifact:      ${state.artifact ? state.artifact.path : '-'}`);
  console.log(`product link:  ${state.artifact ? state.artifact.product_link : '-'}`);
  if (state.closure) {
    console.log(`final closure (${state.closure.state}): Artifact -> Plan -> Spec -> Design -> Experience -> Idea.solution`);
    for (const s of state.closure.steps) {
      console.log(`  [${s.ok ? 'ok' : 'FAIL'}] ${s.from} -> ${s.to}: ${s.detail.slice(0, 110)}`);
    }
  }
  if (state.status !== 'purple') {
    console.error('\ncircle did not reach PURPLE');
    process.exit(1);
  }
  console.log('\nAGENT WHEEL IS PURPLE.');
})().catch((err) => {
  console.error('driver failed:', err.message);
  process.exit(1);
});
