'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { compatibleBundleExecutable } = require('./bundle-helper');

const APP = path.join(__dirname, '..', 'app', 'Convobus.app');

function convobusExe() {
  return compatibleBundleExecutable(APP, 'Convobus');
}

function viaApp(root, args, opts) {
  const o = opts || {};
  const abs = path.resolve(root);
  const executable = convobusExe();
  if (!executable) {
    return { status: 2, stdout: '', stderr: 'compatible Convobus app is missing\n' };
  }
  return spawnSync(executable, ['--root', abs, ...args], {
    encoding: 'utf8',
    timeout: o.timeout || 130000,
    env: process.env,
    killSignal: 'SIGKILL',
  });
}

module.exports = { viaApp, APP, convobusExe };
