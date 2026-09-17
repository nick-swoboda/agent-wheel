'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Readable } = require('stream');
const { tmpDir } = require('./helpers');
const { listenGui, readBody, MAX_REQUEST_BYTES } = require('../lib/gui');

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = options.body == null ? null : Buffer.from(String(options.body));
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: options.method || 'GET',
        headers: {
          ...(body ? { 'Content-Length': body.length } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      },
    );
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

test('health compatibility stays public while authenticated identity proves root and instance', async () => {
  const root = tmpDir('gui-health-auth-');
  const g = await listenGui(root, 0);
  try {
    const publicHealth = await request(g.url + '/api/health');
    assert.equal(publicHealth.status, 200);
    assert.deepEqual(JSON.parse(publicHealth.body), { ok: true });
    const privateHealth = await request(g.url + '/api/health', {
      headers: { 'X-Convobus-Token': g.token },
    });
    assert.deepEqual(JSON.parse(privateHealth.body), {
      ok: true,
      protocolVersion: 3,
      root: fs.realpathSync(root),
      instanceId: g.instanceId,
      pid: process.pid,
    });
    const registry = path.join(root, '.convobus', 'gui.json');
    assert.equal(fs.statSync(registry).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(registry, 'utf8')).token, g.token);
  } finally {
    await new Promise((resolve) => g.server.close(resolve));
  }
  assert.equal(fs.existsSync(path.join(root, '.convobus', 'gui.json')), false);
});

test('mutations require a token and application/json', async () => {
  const root = tmpDir('gui-mutation-auth-');
  const g = await listenGui(root, 0);
  try {
    const noToken = await request(g.url + '/api/accessibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"granted":false}',
    });
    assert.equal(noToken.status, 403);
    const textPlain = await request(g.url + '/api/accessibility', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Convobus-Token': g.token },
      body: '{"granted":false}',
    });
    assert.equal(textPlain.status, 415);
    const authorized = await request(g.url + '/api/accessibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Convobus-Token': g.token },
      body: '{"granted":false}',
    });
    assert.equal(authorized.status, 200, authorized.body);
    assert.deepEqual(JSON.parse(authorized.body), { granted: false });
  } finally {
    await new Promise((resolve) => g.server.close(resolve));
  }
});

test('browser cookie mutations require the exact same origin and host', async () => {
  const root = tmpDir('gui-cookie-auth-');
  const g = await listenGui(root, 0);
  try {
    const page = await request(g.url + '/');
    const cookie = String(page.headers['set-cookie'][0]).split(';')[0];
    const hostile = await request(g.url + '/api/accessibility', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'https://attacker.example',
      },
      body: '{"granted":false}',
    });
    assert.equal(hostile.status, 403);
    const sameOrigin = await request(g.url + '/api/accessibility', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: g.url,
      },
      body: '{"granted":false}',
    });
    assert.equal(sameOrigin.status, 200, sameOrigin.body);
    const forgedHost = await request(g.url + '/api/health', {
      headers: { Host: 'attacker.example' },
    });
    assert.equal(forgedHost.status, 403);
  } finally {
    await new Promise((resolve) => g.server.close(resolve));
  }
});

test('oversized JSON is rejected before buffering', async () => {
  const root = tmpDir('gui-body-limit-');
  const g = await listenGui(root, 0);
  try {
    const result = await request(g.url + '/api/accessibility', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Convobus-Token': g.token,
        'Content-Length': String(MAX_REQUEST_BYTES + 1),
      },
    });
    assert.equal(result.status, 413, result.body);
    assert.deepEqual(JSON.parse(result.body), { error: 'request body too large' });
  } finally {
    await new Promise((resolve) => g.server.close(resolve));
  }
});

test('request buffering accepts exactly 16 MiB and rejects the next byte', async () => {
  const exact = Readable.from([Buffer.alloc(MAX_REQUEST_BYTES, 0x20)]);
  exact.headers = { 'content-length': String(MAX_REQUEST_BYTES) };
  assert.equal((await readBody(exact)).length, MAX_REQUEST_BYTES);

  const over = Readable.from([Buffer.alloc(MAX_REQUEST_BYTES + 1, 0x20)]);
  over.headers = {};
  await assert.rejects(readBody(over), (error) => error && error.code === 'CONVO_BODY_TOO_LARGE');
});
