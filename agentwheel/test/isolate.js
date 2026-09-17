'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.AGENT_WHEEL_HOME) {
  process.env.AGENT_WHEEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-home-'));
  delete process.env.AGENT_WHEEL_STORE;
}

if (!process.env.AGENT_WHEEL_ALLOW_NETWORK) process.env.AGENT_WHEEL_NO_NETWORK = '1';

const homeDir = process.env.AGENT_WHEEL_HOME;
const storeDir = process.env.AGENT_WHEEL_STORE || path.join(homeDir, 'store');

function resetStore() {
  fs.rmSync(storeDir, { recursive: true, force: true });
  fs.rmSync(path.join(homeDir, '.convobus'), { recursive: true, force: true });
  fs.mkdirSync(storeDir, { recursive: true });
}

module.exports = { homeDir, storeDir, resetStore };
