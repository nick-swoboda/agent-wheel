'use strict';

function emptyNode(kind) {
  return {
    kind,
    open: false,
    reopened: false,
    stale: false,
    draft: null,
    versions: [],
  };
}

function currentAccepted(node) {
  if (!node) return null;
  for (let i = node.versions.length - 1; i >= 0; i--) {
    if (node.versions[i].state === 'accepted') return node.versions[i];
  }
  return null;
}

function stagedVersion(node) {
  if (!node) return null;
  for (let i = node.versions.length - 1; i >= 0; i--) {
    if (node.versions[i].state === 'staged') return node.versions[i];
  }
  return null;
}

const KINDS = ['idea', 'experience', 'design', 'spec', 'plan'];
function baseVersions(state) {
  const out = {};
  for (const kind of KINDS) {
    const node = state.nodes[kind];
    const last = node.versions[node.versions.length - 1];
    out[kind] = last ? `v${last.v}:${last.state}${node.reopened ? ':reopened' : ''}` : 'empty';
  }
  return out;
}

module.exports = { emptyNode, currentAccepted, stagedVersion, baseVersions };
