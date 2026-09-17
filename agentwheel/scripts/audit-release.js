#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const policy = require('./release-files.json');

function personalMarkers(root) {
  const markers = [os.homedir(), os.userInfo().username, os.hostname()];
  if (process.platform === 'darwin') {
    try { markers.push(execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch {}
  }
  try {
    const authors = execFileSync('git', ['-C', root, 'log', '--format=%an%n%ae%n%cn%n%ce'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    markers.push(...authors.split('\n'));
  } catch {}
  return [...new Set(markers.filter(s => s && s.length > 3 && !/^(?:root|admin|runner|user|Agent Wheel contributors|contributors@agent-wheel\.invalid)$/.test(s)))];
}

function filesIn(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else files.push(path.relative(root, file).split(path.sep).join('/'));
    }
  }
  walk(root);
  return files.sort();
}

function audit(root, files, markers = personalMarkers(root)) {
  const findings = [];
  const forbidden = /(?:^|\/)(?:\.git|\.DS_Store|\._[^/]*|__MACOSX|\.env(?:\.[^/]*)?|node_modules|\.convobus|store(?:-archive-[^/]*)?|evidence|build|\.codex|\.agents)(?:\/|$)|\.(?:log|pem|key|p12|pfx|mobileprovision)$/i;
  const credential = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{64,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}/;
  for (const name of files) {
    if (forbidden.test(name)) { findings.push(name + ': private or development path'); continue; }
    if (path.isAbsolute(name) || name.split('/').includes('..')) { findings.push('Unsafe release path'); continue; }
    const file = path.join(root, name);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) { findings.push(name + ': missing file or symlink'); continue; }
    const bytes = fs.readFileSync(file);
    const text = bytes.toString('latin1');
    if (credential.test(text)) findings.push(name + ': possible credential');
    if (markers.some(marker => name.toLowerCase().includes(marker.toLowerCase()) ||
        bytes.includes(Buffer.from(marker)) || bytes.includes(Buffer.from(marker, 'utf16le')))) {
      findings.push(name + ': personal or device identifier');
    }
  }
  return findings;
}

module.exports = { audit, filesIn, personalMarkers };
if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
  const source = process.argv.includes('--source');
  const files = filesIn(root);
  const findings = audit(root, files, personalMarkers(path.resolve(__dirname, '../..')));
  if (source) {
    const expected = new Set(policy.source);
    for (const file of files) if (!expected.delete(file)) findings.push(file + ': not on public source allowlist');
    for (const file of expected) findings.push(file + ': required source missing');
  }
  if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
  else console.log('Privacy audit passed: ' + files.length + ' files; no local identifiers, credentials, or private paths found.');
}
