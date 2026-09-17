'use strict';

const http = require('http');
const fs = require('fs');
const readline = require('readline');
const pkg = require('../package.json');

function readLaunch() {
  try {
    const raw = fs.readFileSync(3, 'utf8');
    const launch = JSON.parse(raw.split('\n')[0]);
    if (Number.isInteger(launch.port) && typeof launch.token === 'string') return launch;
  } catch {}
  process.stderr.write('spool server: expected {port, token} on fd 3 from the helper\n');
  process.exit(2);
}

const launch = readLaunch();

const TOOL = {
  name: 'spool_project',
  description:
    'Spool a new project into the Agent Wheel. Creates the system-locked Idea ' +
    'root with exactly two schema fields (problem and solution) staged for a ' +
    'fresh review turn. The wheel takes over from there.',
  inputSchema: {
    type: 'object',
    required: ['name', 'problem', 'solution'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', description: 'Project name', minLength: 2, maxLength: 80 },
      problem: { type: 'string', description: 'problem: what is failing, for whom, and in what situation', minLength: 20, maxLength: 2000 },
      solution: { type: 'string', description: 'solution: the observable success state that would mean the problem is solved', minLength: 20, maxLength: 2000 },
    },
  },
};

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function postTurn(input) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ input });
    const req = http.request(
      {
        host: '127.0.0.1', port: launch.port, path: '/api/turn', method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: 'Bearer ' + launch.token,
          connection: 'close',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.method === 'initialize') {
    return reply(msg.id, {
      protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-wheel', version: pkg.version },
    });
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'ping') return reply(msg.id, {});
  if (msg.method === 'tools/list') return reply(msg.id, { tools: [TOOL] });
  if (msg.method === 'tools/call') {
    const params = msg.params || {};
    if (params.name !== 'spool_project') {
      return replyError(msg.id, -32602, 'unknown tool: ' + params.name);
    }
    try {
      const args = params.arguments || {};
      const result = await postTurn({
        type: 'spool', via: 'mcp',
        name: args.name, problem: args.problem, solution: args.solution,
      });
      return reply(msg.id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 1) }],
        isError: !result.ok,
      });
    } catch (err) {
      return reply(msg.id, {
        content: [{ type: 'text', text: 'spool failed: ' + err.message + ' (is the helper running?)' }],
        isError: true,
      });
    }
  }
  if (msg.id != null) replyError(msg.id, -32601, 'method not found: ' + msg.method);
});
rl.on('close', () => process.exit(0));
