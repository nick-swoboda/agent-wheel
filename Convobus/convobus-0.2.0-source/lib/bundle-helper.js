'use strict';

const fs = require('fs');
const path = require('path');

const PROTOCOL_VERSION = 3;

function readBundleManifest(bundlePath) {
  if (!bundlePath) return null;
  const manifest = path.join(bundlePath, 'Contents', 'Resources', 'ConvobusProtocol.json');
  try {
    const stat = fs.lstatSync(manifest);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (value.protocolVersion !== PROTOCOL_VERSION) return null;
    if (!value.version || !value.build || !value.backendHash) return null;
    return value;
  } catch {
    return null;
  }
}

function bundleExecutable(bundlePath, executableName) {
  if (!readBundleManifest(bundlePath)) return null;
  const executable = path.join(bundlePath, 'Contents', 'MacOS', executableName || 'Convobus');
  try {
    const stat = fs.lstatSync(executable);
    return stat.isFile() && !stat.isSymbolicLink() ? executable : null;
  } catch {
    return null;
  }
}

function compatibleBundleExecutable(sourceBundle, executableName) {
  const candidates = [
    process.env.CONVO_APP_BUNDLE_PATH || null,
    sourceBundle,
    '/Applications/Convobus.app',
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const bundle = path.resolve(candidate);
    if (seen.has(bundle)) continue;
    seen.add(bundle);
    const executable = bundleExecutable(bundle, executableName);
    if (executable) return executable;
  }
  return null;
}

module.exports = {
  PROTOCOL_VERSION,
  readBundleManifest,
  bundleExecutable,
  compatibleBundleExecutable,
};
