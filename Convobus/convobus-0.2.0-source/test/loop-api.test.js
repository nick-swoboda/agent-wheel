'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { tmpDir } = require('./helpers');
const { listenGui } = require('../lib/gui');
const { appendLog } = require('../lib/store');
const { makeCard } = require('../lib/card');

function request(base, pathname, options) {
  const settings = options || {};
  const url = new URL(pathname, base);
  const body = settings.body == null ? null : JSON.stringify(settings.body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: settings.method || 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(settings.token ? { 'X-Convobus-Token': settings.token } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('authenticated Loop APIs expose summaries, paged history, actions, and native snapshot state', async () => {
  const root = tmpDir('loop-api-');
  const gui = await listenGui(root, 0);
  try {
    const unauthenticated = await request(gui.url, '/api/loops');
    assert.equal(unauthenticated.status, 403);

    const created = await request(gui.url, '/api/loops', {
      method: 'POST',
      token: gui.token,
      body: {
        requestId: 'create-loop',
        name: 'Release review',
        project: root,
        leader: { kind: 'human' },
        builder: { provider: 'claude', surface: 'app', type: 'claude-code' },
        defaultCycles: 1,
      },
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const loopId = created.json.loop.id;

    const listed = await request(gui.url, '/api/loops', { token: gui.token });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.loops.map((loop) => loop.id), [loopId]);

    const started = await request(gui.url, '/api/loop-runs', {
      method: 'POST',
      token: gui.token,
      body: { requestId: 'start-run', loopId, goal: 'Prepare the release.', cycles: 1 },
    });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runId = started.json.run.id;

    let detail;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      detail = await request(gui.url, `/api/loop-runs/${encodeURIComponent(runId)}?limit=1`, { token: gui.token });
      if (detail.json.run.revision > started.json.run.revision) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(detail.status, 200);
    assert.equal(detail.json.messages.length, 1);
    assert.equal(detail.json.messages[0].kind, 'goal');
    assert.equal(detail.json.nextCursor, null);

    const snapshot = await request(gui.url, '/api/native-snapshot', { token: gui.token });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.json.loops.loops[0].id, loopId);
    assert.equal(snapshot.json.loops.activeRun.id, runId);
    assert.equal(snapshot.json.menu.loop.id, runId);

    const stopped = await request(gui.url, `/api/loop-runs/${encodeURIComponent(runId)}/action`, {
      method: 'POST',
      token: gui.token,
      body: {
        requestId: 'stop-run',
        revision: detail.json.run.revision,
        action: 'stop',
      },
    });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.json));
    assert.equal(stopped.json.run.state, 'stopped');
  } finally {
    await new Promise((resolve) => gui.server.close(resolve));
  }
});

test('direct card API omits Loop turns while the lifecycle log retains them', async () => {
  const root = tmpDir('loop-api-direct-');
  const gui = await listenGui(root, 0);
  try {
    const direct = makeCard({ id: 'direct-card', seat: 'stdio', method: 'stdio', body: 'direct', state: 'back', reply: 'done' });
    const loop = makeCard({ id: 'loop-card', seat: 'stdio', method: 'stdio', body: 'loop', state: 'back', reply: 'done' });
    appendLog(root, { event: 'stage', card: direct });
    appendLog(root, { event: 'stage', card: loop, loopId: 'loop-1', runId: 'run-1', stepId: 'step-1' });
    const response = await request(gui.url, '/api/cards');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.cards.map((card) => card.id), ['direct-card']);
    assert.deepEqual(response.json.records.map((record) => record.id), ['direct-card']);
  } finally {
    await new Promise((resolve) => gui.server.close(resolve));
  }
});

test('project workspace API remembers one team and pages named run history', async () => {
  const root = tmpDir('loop-api-workspace-');
  const gui = await listenGui(root, 0);
  try {
    const saved = await request(gui.url, '/api/loops', {
      method: 'POST',
      token: gui.token,
      body: {
        requestId: 'save-workspace',
        action: 'save-project-profile',
        project: root,
        leader: { kind: 'human' },
        builder: { provider: 'claude', surface: 'app', type: 'claude-code' },
        defaultCycles: 1,
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.workspace.project, root);

    const started = await request(gui.url, '/api/loop-runs', {
      method: 'POST',
      token: gui.token,
      body: {
        requestId: 'start-workspace-run',
        loopId: saved.json.workspace.id,
        goal: 'Prepare the release.',
        runName: 'Release review',
        cycles: 1,
      },
    });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    assert.equal(started.json.run.runName, 'Release review');

    const history = await request(
      gui.url,
      `/api/loop-history?project=${encodeURIComponent(root)}&limit=2`,
      { token: gui.token },
    );
    assert.equal(history.status, 200, JSON.stringify(history.json));
    assert.equal(history.json.items[0].kind, 'run');
    assert.equal(history.json.items[0].runName, 'Release review');
    assert.equal(history.json.items[1].kind, 'goal');

    const snapshot = await request(
      gui.url,
      `/api/native-snapshot?provider=claude&project=${encodeURIComponent(root)}&surface=app&type=claude-code`,
      { token: gui.token },
    );
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.json));
    assert.equal(snapshot.json.loops.workspace.project, root);
    assert.equal(snapshot.json.loops.workspaces.length, 1);
  } finally {
    await new Promise((resolve) => gui.server.close(resolve));
  }
});
