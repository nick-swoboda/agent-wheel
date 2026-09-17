#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const policy = require('./release-files.json');
const { audit } = require('./audit-release');

function copyFiles(root, destination, files) {
  for (const name of files) {
    if (path.isAbsolute(name) || name.split('/').includes('..')) throw new Error('Unsafe release path');
    const source = path.join(root, name);
    const stat = fs.lstatSync(source);
    if (!stat.isFile()) throw new Error('Release entries must be regular files: ' + name);
    const resolved = path.relative(fs.realpathSync(root), fs.realpathSync(source));
    if (resolved.startsWith('..' + path.sep) || path.isAbsolute(resolved)) throw new Error('Release path escapes source root: ' + name);
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, stat.mode & 0o111 ? 0o755 : 0o644);
  }
}

function snapshot(root, output) {
  const findings = audit(root, policy.source);
  if (findings.length) throw new Error(findings.join('\n'));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agentwheel-public-'));
  try {
    copyFiles(root, stage, policy.source);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Agent Wheel contributors', GIT_COMMITTER_NAME: 'Agent Wheel contributors',
      GIT_AUTHOR_EMAIL: 'contributors@agent-wheel.invalid', GIT_COMMITTER_EMAIL: 'contributors@agent-wheel.invalid' };
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', stage, ...args], { env, stdio: 'pipe' });
    git('init', '--quiet');
    git('add', '--all');
    const version = JSON.parse(fs.readFileSync(path.join(stage, 'agentwheel/package.json'))).version;
    git('commit', '--quiet', '-m', 'Agent Wheel ' + version + ' public source');
    git('tag', 'v' + version);
    const result = spawnSync('/bin/zsh', [path.join(stage, 'agentwheel/scripts/package-release.sh'), output], { env, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Release packaging failed');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { copyFiles, snapshot };
if (require.main === module) {
  const root = path.resolve(__dirname, '../..');
  try { snapshot(root, path.resolve(process.argv[2] || path.join(root, 'release'))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
