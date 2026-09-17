'use strict';
require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { appRoot } = require('../lib/paths');

function startStubHelper() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, turn: 't_1', status: 'yellow' }));
    });
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => ok({ server, received, port: server.address().port }));
  });
}

test('spool-server speaks MCP, exposes exactly one tool, and carries the launch token from fd 3', async () => {
  const stub = await startStubHelper();
  const token = crypto.randomBytes(24).toString('hex');
  const child = spawn(process.execPath, [path.join(appRoot, 'mcp', 'spool-server.js')], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  child.stdio[3].end(JSON.stringify({ port: stub.port, token }) + '\n');
  const rl = readline.createInterface({ input: child.stdout });
  const waiters = new Map();
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  });
  let seq = 0;
  const rpc = (method, params) => new Promise((ok) => {
    const id = ++seq;
    waiters.set(id, ok);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  try {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(init.result.serverInfo.name, 'agent-wheel');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const tools = await rpc('tools/list', {});
    assert.equal(tools.result.tools.length, 1);
    assert.equal(tools.result.tools[0].name, 'spool_project');
    assert.deepEqual(
      Object.keys(tools.result.tools[0].inputSchema.properties).sort(),
      ['name', 'problem', 'solution']
    );

    const call = await rpc('tools/call', {
      name: 'spool_project',
      arguments: {
        name: 'X', problem: 'p'.repeat(30), solution: 's'.repeat(30),
      },
    });
    assert.equal(call.result.isError, false);
    assert.equal(stub.received.length, 1);
    assert.equal(stub.received[0].url, '/api/turn');
    assert.equal(stub.received[0].body.input.type, 'spool');
    assert.equal(stub.received[0].body.input.via, 'mcp');
    assert.equal(stub.received[0].headers.authorization, 'Bearer ' + token);

    const unknown = await rpc('tools/call', { name: 'delete_everything', arguments: {} });
    assert.match(unknown.error.message, /unknown tool/);
  } finally {
    child.kill();
    stub.server.close();
  }
});

test('spool-server refuses to start without the helper launch line on fd 3', async () => {
  const child = spawn(process.execPath, [path.join(appRoot, 'mcp', 'spool-server.js')], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  child.stdio[3].end('not json\n');
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const code = await new Promise((ok) => child.on('close', ok));
  assert.equal(code, 2);
  assert.match(err, /fd 3/);
});
