'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { audit, filesIn } = require('../scripts/audit-release');
const { copyFiles } = require('../scripts/release-source');
const policy = require('../scripts/release-files.json');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('release copies only the allowlist and preserves bytes and executable modes', t => {
  const root = fixture(t), out = fixture(t);
  fs.writeFileSync(path.join(root, 'public.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'private.txt'), 'local notes');
  fs.writeFileSync(path.join(root, '.env'), 'PRIVATE=yes');
  copyFiles(root, out, ['public.js']);
  assert.deepEqual(filesIn(out), ['public.js']);
  assert.equal(fs.readFileSync(path.join(out, 'public.js'), 'utf8'), '#!/usr/bin/env node\n');
  assert.equal(fs.statSync(path.join(out, 'public.js')).mode & 0o777, 0o755);
  assert.throws(() => copyFiles(root, out, ['../escape']), /Unsafe/);
  fs.symlinkSync(path.join(root, 'private.txt'), path.join(root, 'link.js'));
  assert.throws(() => copyFiles(root, out, ['link.js']), /regular files/);
});

test('privacy audit catches private paths, credentials, and binary personal metadata without printing values', t => {
  const root = fixture(t);
  const marker = 'Private Test Identity';
  fs.writeFileSync(path.join(root, 'binary'), Buffer.from(marker, 'utf16le'));
  fs.writeFileSync(path.join(root, 'credential.js'), 'sk-' + 'x'.repeat(32));
  fs.writeFileSync(path.join(root, '.env'), 'LOCAL=yes');
  fs.writeFileSync(path.join(root, 'clean.js'), 'console.log("hello");');
  fs.writeFileSync(path.join(root, 'parser-constant'), ['-----BEGIN', 'PRIVATE KEY-----\0'].join(' '));
  fs.writeFileSync(path.join(root, 'private-key'), ['-----BEGIN', 'PRIVATE KEY-----\n'].join(' ') + 'A'.repeat(80));
  const findings = audit(root, ['binary', 'credential.js', '.env', 'clean.js'], [marker]);
  assert.equal(findings.length, 3);
  assert.match(findings.join('\n'), /personal or device identifier/);
  assert.match(findings.join('\n'), /possible credential/);
  assert.match(findings.join('\n'), /private or development path/);
  assert.ok(!findings.join('\n').includes(marker));
  assert.deepEqual(audit(root, ['clean.js'], [marker]), []);
  assert.deepEqual(audit(root, ['parser-constant'], [marker]), []);
  assert.match(audit(root, ['private-key'], [marker]).join('\n'), /possible credential/);
});

test('public source is complete, private-data free, and includes every runtime file', t => {
  const root = path.resolve(__dirname, '../..'), out = fixture(t);
  assert.equal(new Set(policy.source).size, policy.source.length);
  assert.equal(new Set(policy.app).size, policy.app.length);
  assert.ok(policy.app.every(file => policy.source.includes(file)));
  assert.ok(policy.app.every(file => !/\/(?:test|scripts|evidence|native|patches)\//.test(file)));
  copyFiles(root, out, policy.source);
  assert.deepEqual(filesIn(out), [...policy.source].sort());
  assert.deepEqual(audit(out, policy.source), []);
});
