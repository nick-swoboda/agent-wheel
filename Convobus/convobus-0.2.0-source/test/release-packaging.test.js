'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO } = require('./helpers');

function command(name, args) {
  const result = spawnSync(name, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `${name}: ${result.stderr || result.stdout}`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

test('macOS release is universal, self-contained, and supports all macOS 13 releases', () => {
  const app = path.join(REPO, 'app', 'Convobus.app');
  const executable = path.join(app, 'Contents', 'MacOS', 'Convobus');
  const helper = path.join(app, 'Contents', 'MacOS', 'ax-helper');
  const runtime = path.join(app, 'Contents', 'Resources', 'Runtime', 'node');
  const runtimeLicense = path.join(path.dirname(runtime), 'Node-LICENSE.txt');
  const notices = path.join(app, 'Contents', 'Resources', 'THIRD_PARTY_NOTICES.md');
  const nativeCatalog = path.join(app, 'Contents', 'Resources', 'provider-catalog.json');
  const backendPackage = path.join(app, 'Contents', 'Resources', 'Backend', 'package.json');
  const backendLoops = path.join(app, 'Contents', 'Resources', 'Backend', 'lib', 'loops.js');
  const swift = fs.readFileSync(path.join(REPO, 'lib', 'app-main.swift'), 'utf8');
  const fetchScript = fs.readFileSync(
    path.join(REPO, 'scripts', 'fetch-node-runtime.sh'),
    'utf8',
  );
  const buildScript = fs.readFileSync(
    path.join(REPO, 'scripts', 'build-native-app.sh'),
    'utf8',
  );
  const packageScript = fs.readFileSync(
    path.join(REPO, 'scripts', 'package-release.sh'),
    'utf8',
  );
  const dmgScript = fs.readFileSync(path.join(REPO, 'scripts', 'create-dmg.sh'), 'utf8');
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');

  for (const binary of [executable, helper, runtime]) {
    assert.ok(fs.existsSync(binary), binary);
    const architectures = command('lipo', ['-archs', binary]);
    assert.match(architectures, /arm64/);
    assert.match(architectures, /x86_64/);
  }

  assert.equal(command(runtime, ['--version']).trim(), 'v22.23.2');
  assert.match(command('xcrun', ['vtool', '-arch', 'arm64', '-show-build', runtime]), /minos 11\.0/);
  assert.match(command('xcrun', ['vtool', '-arch', 'x86_64', '-show-build', runtime]), /minos 11\.0/);
  assert.match(command('xcrun', ['vtool', '-arch', 'arm64', '-show-build', executable]), /minos 13\.0/);
  assert.match(command('xcrun', ['vtool', '-arch', 'x86_64', '-show-build', executable]), /minos 13\.0/);

  assert.ok(fs.existsSync(runtimeLicense), runtimeLicense);
  assert.ok(fs.existsSync(notices), notices);
  assert.ok(fs.existsSync(nativeCatalog), nativeCatalog);
  assert.ok(fs.existsSync(backendLoops), backendLoops);
  assert.deepEqual(JSON.parse(fs.readFileSync(backendPackage, 'utf8')), packageMetadata);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(nativeCatalog, 'utf8')),
    JSON.parse(fs.readFileSync(path.join(REPO, 'lib', 'provider-catalog.json'), 'utf8')),
  );
  assert.match(fs.readFileSync(runtimeLicense, 'utf8'), /Node\.js is licensed/);

  const bundledIndex = swift.indexOf('/Runtime/node');
  const externalIndex = swift.indexOf('/opt/homebrew/bin/node');
  assert.ok(bundledIndex >= 0 && externalIndex > bundledIndex);
  assert.match(swift, /bundlePath\.hasSuffix\("\.app"\) \{ return nil \}/);
  assert.match(fetchScript, /node_version="22\.23\.2"/);
  assert.match(fetchScript, /5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1/);
  assert.match(fetchScript, /96dff79f4e19a78715da559ec7cac2028f4985a175ea0c3454625a269c21deb7/);
  assert.match(buildScript, /lipo -create/);
  assert.match(packageScript, /macOS-universal\.dmg/);
  assert.match(packageScript, /Convobus-\*-release-/);
  assert.match(packageScript, /CONVO_TESTED_APP_SHA256/);
  assert.match(dmgScript, /ln -s \/Applications/);
  assert.match(dmgScript, /hdiutil create/);
  assert.equal(packageMetadata.version, '0.2.0');
  assert.equal(packageMetadata.license, 'Apache-2.0');
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>0\.2\.0<\/string>/);
  assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>8<\/string>/);
  assert.ok(fs.existsSync(path.join(REPO, 'docs', 'releases', 'v0.2.0.md')));
  assert.match(fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8'), /Apache License[\s\S]*Version 2\.0/);
});
