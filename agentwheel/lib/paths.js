'use strict';

const path = require('path');
const os = require('os');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const lawPath = path.join(repoRoot, 'Agent-Wheel-ascii-diagram.txt');
const convobusLib = path.join(repoRoot, 'Convobus', 'convobus-0.2.0-source', 'lib');

function defaultHome() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Agent Wheel');
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'agent-wheel');
}

const storeOverride = process.env.AGENT_WHEEL_STORE ? path.resolve(process.env.AGENT_WHEEL_STORE) : null;
const homeDir = process.env.AGENT_WHEEL_HOME
  ? path.resolve(process.env.AGENT_WHEEL_HOME)
  : storeOverride ? path.dirname(storeOverride) : defaultHome();
const storeDir = storeOverride || path.join(homeDir, 'store');
const transportRoot = homeDir;
const transportDir = path.join(transportRoot, '.convobus');

const eventsPath = path.join(storeDir, 'events.jsonl');
const snapshotPath = path.join(storeDir, 'snapshot.json');
const legacyStatePath = path.join(storeDir, 'state.json');     /* a 1.x store, never read, archived on first launch */
const auditPath = path.join(storeDir, 'audit.jsonl');
const helperInfoPath = path.join(storeDir, 'helper.json');       /* pid + port of the live helper; never the token */
const projectsDir = path.join(storeDir, 'projects');
const projectsIndexPath = path.join(storeDir, 'projects.json');

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

function projectPaths(id) {
  if (!PROJECT_ID_RE.test(String(id))) throw new Error('bad project id: ' + id);
  const dir = path.join(projectsDir, id);
  return {
    id,
    dir,
    eventsPath: path.join(dir, 'events.jsonl'),
    snapshotPath: path.join(dir, 'snapshot.json'),
    leasePath: path.join(dir, 'lease.json'),
    auditPath: path.join(dir, 'audit.jsonl'),
    cardsPath: path.join(dir, 'cards.jsonl'),
    lockPath: path.join(dir, '.lock'),
    branchesDir: path.join(dir, 'branches'),
    mainDir: path.join(dir, 'main'),
  };
}

const scratchRoot = path.join(os.tmpdir(), 'agent-wheel-scratch');
if (scratchRoot === repoRoot || scratchRoot.startsWith(repoRoot + path.sep)) {
  throw new Error('scratchRoot must live outside the repo: ' + scratchRoot);
}

const uiDir = path.join(appRoot, 'surfaces', 'ui');
const uiPage = path.join(uiDir, 'main.html');

module.exports = {
  appRoot,
  repoRoot,
  lawPath,
  convobusLib,
  homeDir,
  storeDir,
  transportRoot,
  transportDir,
  eventsPath,
  snapshotPath,
  legacyStatePath,
  auditPath,
  helperInfoPath,
  projectsDir,
  projectsIndexPath,
  projectPaths,
  scratchRoot,
  uiDir,
  uiPage,
};
