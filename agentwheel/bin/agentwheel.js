#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

const mode = process.argv[2] || 'help';

function readHelperInfo() {
  const { helperInfoPath } = require('../lib/paths');
  try { return JSON.parse(fs.readFileSync(helperInfoPath, 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
}

function commandLineOf(pid) {
  try {
    return fs.readFileSync('/proc/' + pid + '/cmdline', 'latin1').split('\0').join(' ');
  } catch {
    const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return String(ps.stdout || '');
  }
}

// A pid is the helper only if it is alive and its command line is the helper's.
function liveHelper(info) {
  if (!info || !Number.isInteger(info.pid) || info.pid <= 1 || !pidAlive(info.pid)) return false;
  const command = commandLineOf(info.pid);
  return /agentwheel\.js\s+helper\b/.test(command) || /\bhelper\.js\b/.test(command);
}

if (mode === 'helper') {
  require('../surfaces/helper').main().catch((err) => {
    process.stderr.write('helper crashed: ' + err.message + '\n');
    process.exit(1);
  });
} else if (mode === 'mcp') {
  require('../mcp/spool-server');
} else if (mode === 'seat-run') {
  require('../seats/runner').main().catch((err) => {
    console.error('seat runner crashed:', err.message);
    process.exit(1);
  });
} else if (mode === 'status') {
  const storelib = require('../lib/store');
  const { projectPaths } = require('../lib/paths');
  const projects = storelib.listProjects();
  const lines = [];
  for (const p of projects) {
    const state = storelib.load(projectPaths(p.id));
    if (state) lines.push(`${state.project.name}: ${state.status} (turns=${state.turns.last_id}, stage=${state.frontier ? state.frontier.stage : '-'})`);
  }
  console.log(lines.length ? lines.join('\n') : 'unspooled');
} else if (mode === 'stop') {
  const info = readHelperInfo();
  if (!info) {
    console.log('helper: not running');
    process.exit(1);
  }
  if (!liveHelper(info)) {
    console.log(`helper: not running (pid ${info.pid} is not a live helper)`);
    process.exit(1);
  }
  try {
    process.kill(info.pid, 'SIGTERM');
    console.log(`stopped helper (pid ${info.pid})`);
  } catch (err) {
    console.log(`could not stop helper pid ${info.pid}: ${err.message}`);
    process.exit(1);
  }
} else if (mode === 'reset') {
  const { storeDir } = require('../lib/paths');
  const info = readHelperInfo();
  if (info && liveHelper(info)) {
    console.error(`refusing: the helper is running (pid ${info.pid}); run "agentwheel stop" first`);
    process.exit(1);
  }
  if (!fs.existsSync(storeDir)) {
    console.log('store already empty; nothing to archive');
    process.exit(0);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = `${storeDir}-archive-${stamp}`;
  fs.renameSync(storeDir, archive);
  console.log(`store archived to ${archive}`);
  console.log('next launch starts unspooled; spool a project from the window');
} else {
  console.log('usage: agentwheel <helper|mcp|seat-run|status|stop|reset>');
  process.exit(mode === 'help' ? 0 : 1);
}
