'use strict';

// Seat writes and processes are confined to branch or scratch workspaces.

const path = require('path');
const fs = require('fs');

const POLICY = {
  builder: { fs_write: 'branch', exec: 'branch' },
  leader: {},
  reviewer: {},
  system: { fs_write: 'scratch', exec: 'scratch' },
  'system-commit': { fs_write: 'canonical', exec: 'none' },
};

class BrokerError extends Error {}

function assertScoped(seat, tool, targetPath, scopeDir) {
  const seatPolicy = POLICY[seat];
  if (!seatPolicy || !seatPolicy[tool]) {
    throw new BrokerError(`broker: seat "${seat}" has no grant for "${tool}"`);
  }
  const resolved = path.resolve(targetPath);
  const scope = path.resolve(scopeDir);
  if (resolved !== scope && !resolved.startsWith(scope + path.sep)) {
    throw new BrokerError(
      `broker: ${seat}/${tool} outside scope: ${resolved} not under ${scope}`
    );
  }
  return { seat, tool, path: resolved, scope };
}

// Node permissions restrict seat scripts to their workspace and deny child processes.
function confinedNodeArgs(workspace) {
  // Resolve symlinks before comparing permission scopes.
  let ws = path.resolve(workspace);
  try { ws = fs.realpathSync(ws); } catch {   }
  return ['--permission', `--allow-fs-read=${ws}`, `--allow-fs-write=${ws}`];
}

module.exports = { confinedNodeArgs, assertScoped, BrokerError, POLICY };
