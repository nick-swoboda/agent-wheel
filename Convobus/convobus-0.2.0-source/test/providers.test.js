'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { tmpDir, readLog, REPO, NODE, FIXTURE } = require('./helpers');
const { listenGui } = require('../lib/gui');
const { appendLog, writeInflight, writeSeatsFile } = require('../lib/store');
const { loadSeats } = require('../lib/seats');
const { resolveVendorSession, claudeProjectEncodings } = require('../lib/methods/filewins');
const { runTurn, cmdReply, cmdStage } = require('../lib/turn');
const {
  PROVIDERS,
  canonicalProject,
  cardRecords,
  providerCatalog,
  projectsForProvider,
  routeStatus,
} = require('../lib/providers');
const {
  readPrefs,
  setContext,
  providerModel,
  contextStatus,
  menuModel,
  writePrefs,
} = require('../lib/control');

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

function post(url, value, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = JSON.stringify(value);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Convobus-Token': token,
        },
      },
      (res) => {
        let response = '';
        res.on('data', (chunk) => {
          response += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: response }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function plantClaudeRoutes(home, project) {
  const codeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const codeDir = path.join(home, '.claude', 'projects', claudeProjectEncodings(project)[0]);
  fs.mkdirSync(codeDir, { recursive: true });
  const codeFile = path.join(codeDir, codeId + '.jsonl');
  fs.writeFileSync(codeFile, JSON.stringify({ type: 'user', content: 'convobus ready' }) + '\n');

  const coworkId = 'session_01GJrmfqVoJveULXszaBHCoF';
  const mapDir = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'local-agent-mode-sessions',
    'account',
    'organization',
  );
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(
    path.join(mapDir, 'remote-session-spaces.json'),
    JSON.stringify({ entries: [{ sessionId: coworkId, folders: [project] }] }),
  );
  const idbDir = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'IndexedDB',
    'https_claude.ai_0.indexeddb.leveldb',
  );
  fs.mkdirSync(idbDir, { recursive: true });
  const coworkFile = path.join(idbDir, '000152.log');
  fs.writeFileSync(coworkFile, 'Claude responded: convobus ready\n');

  const chatId = 'fb4a4a32-0501-4cff-a9b6-b50df6380ccf';
  const chatDir = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'IndexedDB',
    'https_claude.ai_0.indexeddb.blob',
    '1',
    'd5',
  );
  fs.mkdirSync(chatDir, { recursive: true });
  const chatFile = path.join(chatDir, 'd5d7');
  fs.writeFileSync(
    chatFile,
    `"uuid"$${chatId}"name"Convobus readiness check"summary"reply only convobus ready"`,
  );
  return { codeId, codeFile, coworkId, coworkFile, chatId, chatFile };
}

function markRoutesInstalled(root) {
  const seats = loadSeats(root);
  for (const seat of seats.seats) {
    if (seat.handle === 'stdio' || seat.handle === 'human') continue;
    seat.path = seat.path || '/fake/' + seat.handle;
    seat.state = 'open';
  }
  writeSeatsFile(root, seats);
}

test('provider catalog contains only the declared App and CLI route mappings', () => {
  assert.deepEqual(
    PROVIDERS.map((provider) => ({
      id: provider.id,
      routes: provider.routes.map((route) => [route.surface, route.type, route.seat]),
    })),
    [
      {
        id: 'claude',
        routes: [
          ['app', 'chat', 'claude-app'],
          ['app', 'cowork', 'claude-app'],
          ['app', 'claude-code', 'claude-app'],
          ['cli', 'claude-cli', 'claude-cli'],
        ],
      },
      {
        id: 'chatgpt',
        routes: [
          ['app', 'classic', 'chatgpt-chat-app'],
          ['app', 'chat', 'chatgpt-modern-chat-app'],
          ['app', 'work', 'chatgpt-app'],
          ['cli', 'codex', 'chatgpt-cli'],
        ],
      },
      {
        id: 'cursor',
        routes: [
          ['app', 'cursor', 'cursor-app'],
          ['cli', 'cursor-cli', 'cursor-cli'],
        ],
      },
      { id: 'grok', routes: [['cli', 'grok-cli', 'grok-cli']] },
    ],
  );
  assert.equal(PROVIDERS.flatMap((provider) => provider.routes).length, 11);
  const chatgpt = PROVIDERS.find((provider) => provider.id === 'chatgpt');
  assert.equal(chatgpt.routes.find((route) => route.type === 'classic').bundleIdentifier, 'com.openai.chat');
  assert.equal(chatgpt.routes.find((route) => route.type === 'chat').bundleIdentifier, 'com.openai.codex');
  assert.equal(chatgpt.routes.find((route) => route.type === 'work').bundleIdentifier, 'com.openai.codex');
  assert.ok(!PROVIDERS.find((provider) => provider.id === 'grok').routes.some((route) => route.surface === 'app'));
});

test('provider polling uses bounded project-path checks instead of blocking filesystem calls', () => {
  const source = fs.readFileSync(path.join(REPO, 'lib', 'providers.js'), 'utf8');
  assert.match(source, /spawnSync\('\/bin\/realpath',[\s\S]*timeout: 150/);
  assert.match(source, /spawnSync\('\/bin\/test',[\s\S]*timeout: 150/);
  assert.doesNotMatch(source, /realpathSync/);
  const discovery = source.slice(source.indexOf('function discoverProjects'), source.indexOf('function projectMatchesProvider'));
  assert.doesNotMatch(discovery, /fs\.existsSync/);
});

test('native static boundaries retain only the provider/project view and trusted transport', () => {
  const swift = fs.readFileSync(path.join(REPO, 'lib', 'app-main.swift'), 'utf8');
  const models = fs.readFileSync(path.join(REPO, 'lib', 'native-models.swift'), 'utf8');
  assert.match(swift, /NSSplitViewController/);
  assert.match(swift, /StableSelectionTableView/);
  const stableTable = swift.slice(swift.indexOf('class StableSelectionTableView'), swift.indexOf('final class ProjectTableView'));
  assert.match(stableTable, /isHandlingDirectInput = true[\s\S]*super\.mouseDown[\s\S]*onUserSelection/);
  assert.match(swift, /stableTable\.isHandlingDirectInput[\s\S]*return/);
  assert.match(swift, /NSCollectionViewDataSource/);
  assert.match(swift, /\/api\/native-snapshot/);
  assert.match(models, /ContextSelectionCoordinator/);
  assert.doesNotMatch(swift, /ProviderRowButton|ProjectRowButton|SeatRowButton|MetricTileView|ConversationCardView/);
  assert.doesNotMatch(swift, /7421\.\.\.7430|ConvobusMenuBarProbe/);
  const bootstrap = swift.slice(swift.indexOf('private func bootstrapProviderState'), swift.indexOf('func applicationDidFinishLaunching'));
  assert.doesNotMatch(bootstrap, /FileManager\.default\.fileExists/);
  assert.doesNotMatch(swift, /claude:\/\/cowork\/new|--cloud/);
  assert.ok(fs.existsSync(path.join(REPO, 'app', 'Convobus.app', 'Contents', 'Resources', 'Backend', 'lib', 'provider-catalog.json')));
  assert.ok(fs.existsSync(path.join(REPO, 'app', 'Convobus.app', 'Contents', 'Resources', 'provider-catalog.json')));
});

test('menu status follows the selected conversation and preserves actionable blockers', () => {
  const root = tmpDir('providers-menu-state-');
  const project = path.join(root, 'Convo Grok CLI');
  fs.mkdirSync(project, { recursive: true });
  markRoutesInstalled(root);
  const route = { provider: 'grok', project, surface: 'cli', type: 'grok-cli' };
  assert.equal(setContext(root, route).ok, true);
  appendLog(root, {
    t: '2026-08-31T01:00:00.000Z',
    event: 'stage',
    route,
    card: {
      id: 'menu-sent',
      seat: 'grok-cli',
      method: 'stdio',
      from: 'human',
      body: 'ready?',
      reply: 'convobus ready',
      state: 'back',
      cwd: project,
    },
  });
  assert.equal(menuModel(root, { fast: true }).icon, 'attached');

  appendLog(root, {
    t: '2026-08-31T01:01:00.000Z',
    event: 'deliver',
    route,
    card: {
      id: 'menu-waiting',
      seat: 'grok-cli',
      method: 'stdio',
      from: 'human',
      body: 'waiting',
      reply: '',
      state: 'waiting',
      cwd: project,
    },
  });
  writeInflight(root, [{
    id: 'menu-waiting',
    seat: 'grok-cli',
    method: 'stdio',
    from: 'human',
    body: 'waiting',
    reply: '',
    state: 'waiting',
    cwd: project,
  }]);
  assert.equal(menuModel(root, { fast: true }).icon, 'waiting');

  const chatProject = path.join(root, 'Convo ChatGPT App');
  fs.mkdirSync(chatProject, { recursive: true });
  const chat = { provider: 'chatgpt', project: chatProject, surface: 'app', type: 'chat' };
  assert.equal(setContext(root, chat).ok, true);
  const blocked = menuModel(root, { fast: true });
  assert.equal(blocked.icon, 'blocked');
  assert.equal(blocked.routeStatus.action, 'allow-accessibility');
});

test('ChatGPT Classic, Chat, Work, and CLI status resolution never cross route boundaries', () => {
  const root = tmpDir('providers-chatgpt-strict-');
  const home = path.join(root, 'home');
  const project = path.join(root, 'Convo ChatGPT App');
  fs.mkdirSync(project, { recursive: true });
  markRoutesInstalled(root);
  const classic = { provider: 'chatgpt', project, surface: 'app', type: 'classic' };
  const chat = { provider: 'chatgpt', project, surface: 'app', type: 'chat' };
  const work = { provider: 'chatgpt', project, surface: 'app', type: 'work' };
  const cli = { provider: 'chatgpt', project, surface: 'cli', type: 'codex' };

  const blocked = routeStatus(root, classic, {
    home,
    accessibility: false,
    chatgptClassicProbe: { running: true, composer: true, tcc: false },
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.method, 'none');
  assert.equal(blocked.action, 'allow-accessibility');

  const closed = routeStatus(root, classic, {
    home,
    accessibility: true,
    chatgptClassicProbe: { running: false, composer: false, tcc: false },
  });
  assert.equal(closed.status, 'needs-session');
  assert.equal(closed.attach.appPath, '/Applications/ChatGPT Classic.app');

  const classicAttached = routeStatus(root, classic, {
    home,
    accessibility: true,
    chatgptClassicProbe: { running: true, composer: true, tcc: false },
  });
  assert.equal(classicAttached.status, 'attached');
  assert.equal(classicAttached.method, 'ax');
  assert.equal(classicAttached.kind, 'chatgpt-classic');
  assert.equal(classicAttached.sessionId, null);

  const wrongSide = routeStatus(root, chat, {
    home,
    accessibility: true,
    chatgptChatProbe: { running: true, composer: true, mode: 'work', tcc: false },
  });
  assert.equal(wrongSide.status, 'needs-session');
  assert.match(wrongSide.reason, /Work, not Chat/);

  const chatAttached = routeStatus(root, chat, {
    home,
    accessibility: true,
    chatgptChatProbe: { running: true, composer: true, mode: 'chat', tcc: false },
  });
  assert.equal(chatAttached.status, 'attached');
  assert.equal(chatAttached.method, 'ax');
  assert.equal(chatAttached.kind, 'chatgpt-chat');
  assert.equal(chatAttached.sessionId, null);

  assert.equal(routeStatus(root, work, {
    home,
    accessibility: true,
    chatgptChatProbe: { running: true, composer: true, mode: 'chat', tcc: false },
  }).status, 'needs-session');
  assert.equal(routeStatus(root, cli, {
    home,
    accessibility: true,
    chatgptChatProbe: { running: true, composer: true, mode: 'chat', tcc: false },
  }).status, 'needs-session');

  const selected = setContext(root, chat);
  assert.equal(selected.ok, true, JSON.stringify(selected));
  assert.equal(selected.context.seat, 'chatgpt-modern-chat-app');
  assert.equal(
    loadSeats(root).seats.find((seat) => seat.handle === 'chatgpt-modern-chat-app').cwd,
    canonicalProject(project),
  );
  assert.deepEqual(providerModel(root).selection, {
    provider: 'chatgpt',
    project: canonicalProject(project),
    surface: 'app',
    type: 'chat',
  });
});

test('strict Claude variants resolve only Chat, Cowork, or Code without cross-type fallback', () => {
  const root = tmpDir('providers-strict-');
  const home = path.join(root, 'home');
  const project = path.join(root, 'Project');
  fs.mkdirSync(project, { recursive: true });
  const planted = plantClaudeRoutes(home, project);

  const chat = resolveVendorSession('claude-app', project, home, { variant: 'chat' });
  const cowork = resolveVendorSession('claude-app', project, home, { variant: 'cowork' });
  const code = resolveVendorSession('claude-app', project, home, { variant: 'claude-code' });
  const cli = resolveVendorSession('claude-cli', project, home, { variant: 'claude-cli' });
  assert.deepEqual([chat.id, chat.kind, chat.file], [planted.chatId, 'chat', planted.chatFile]);
  assert.deepEqual([cowork.id, cowork.kind, cowork.file], [planted.coworkId, 'cloud', planted.coworkFile]);
  assert.deepEqual([code.id, code.kind, code.file], [planted.codeId, 'jsonl', planted.codeFile]);
  assert.deepEqual([cli.id, cli.kind, cli.file], [planted.codeId, 'jsonl', planted.codeFile]);

  const emptyHome = path.join(root, 'code-only-home');
  const codeDir = path.join(emptyHome, '.claude', 'projects', claudeProjectEncodings(project)[0]);
  fs.mkdirSync(codeDir, { recursive: true });
  fs.copyFileSync(planted.codeFile, path.join(codeDir, planted.codeId + '.jsonl'));
  assert.equal(resolveVendorSession('claude-app', project, emptyHome, { variant: 'chat' }).id, null);
  assert.equal(resolveVendorSession('claude-app', project, emptyHome, { variant: 'cowork' }).id, null);
});

test('Claude App routes require both the exact stored session and a live AX composer', () => {
  const root = tmpDir('providers-claude-composer-');
  const home = path.join(root, 'home');
  const project = path.join(root, 'Convo Claude App');
  fs.mkdirSync(project, { recursive: true });
  plantClaudeRoutes(home, project);
  markRoutesInstalled(root);
  const input = { provider: 'claude', project, surface: 'app', type: 'chat' };
  const unavailable = routeStatus(root, input, {
    home,
    accessibility: true,
    appProbe: { running: true, composer: false, tcc: false, error: null },
  });
  assert.equal(unavailable.status, 'needs-session');
  assert.equal(unavailable.reason, 'Claude composer is not available');
  const attached = routeStatus(root, input, {
    home,
    accessibility: true,
    appProbe: { running: true, composer: true, tcc: false, error: null },
  });
  assert.equal(attached.status, 'attached');
  assert.equal(attached.kind, 'chat');
  assert.equal(attached.method, 'ax');
});

test('project context is canonical, persisted per provider, restored, and bound to its seat', () => {
  const root = tmpDir('providers-context-');
  const project = path.join(root, 'Project');
  const alias = path.join(root, 'Project Alias');
  fs.mkdirSync(project, { recursive: true });
  fs.symlinkSync(project, alias, 'dir');

  let result = setContext(root, {
    provider: 'chatgpt',
    project: alias,
    surface: 'cli',
    type: 'codex',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  result = setContext(root, {
    provider: 'claude',
    project,
    surface: 'app',
    type: 'cowork',
  });
  assert.equal(result.ok, true, JSON.stringify(result));

  const canonical = canonicalProject(project);
  const prefs = readPrefs(root);
  assert.equal(prefs.ui.selectedProvider, 'claude');
  assert.equal(prefs.ui.selectedProject, canonical);
  assert.equal(prefs.ui.projects.length, 1);
  assert.deepEqual(prefs.ui.projects[0].routes.chatgpt, { surface: 'cli', type: 'codex' });
  assert.deepEqual(prefs.ui.projects[0].routes.claude, { surface: 'app', type: 'cowork' });
  assert.equal(prefs.ui.lastProjectByProvider.chatgpt, canonical);
  assert.equal(prefs.ui.lastProjectByProvider.claude, canonical);
  assert.equal(loadSeats(root).seats.find((seat) => seat.handle === 'claude-app').cwd, canonical);
  assert.deepEqual(providerModel(root).selection, {
    provider: 'claude',
    project: canonical,
    surface: 'app',
    type: 'cowork',
  });

  const invalid = setContext(root, {
    provider: 'claude',
    project,
    surface: 'app',
    type: 'not-cowork',
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'unknown route');
  const beforeFailure = providerModel(root);
  const missing = setContext(root, {
    provider: 'cursor',
    project: path.join(root, 'Missing Project'),
    surface: 'cli',
    type: 'cursor-cli',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'project folder is missing');
  const missingStatus = routeStatus(root, {
    provider: 'cursor',
    project: path.join(root, 'Missing Project'),
    surface: 'cli',
    type: 'cursor-cli',
  });
  assert.equal(missingStatus.status, 'blocked');
  assert.equal(missingStatus.action, 'choose-folder');
  assert.deepEqual(providerModel(root).selection, beforeFailure.selection);
  assert.deepEqual(providerModel(root).lastProjectByProvider, beforeFailure.lastProjectByProvider);
});

test('pre-split ChatGPT Chat preferences migrate to Classic while new Chat remains stable', () => {
  const root = tmpDir('providers-chatgpt-migrate-');
  const project = path.join(root, 'Convo ChatGPT App');
  fs.mkdirSync(project, { recursive: true });
  writePrefs(root, {
    currentSeat: 'chatgpt-chat-app',
    ui: {
      selectedProvider: 'chatgpt',
      selectedProject: project,
      projects: [{
        path: project,
        routes: { chatgpt: { surface: 'app', type: 'chat' } },
      }],
    },
  });
  const migrated = readPrefs(root);
  assert.equal(migrated.ui.routeCatalogVersion, 2);
  assert.deepEqual(migrated.ui.projects[0].routes.chatgpt, { surface: 'app', type: 'classic' });
  assert.equal(providerModel(root).selection.type, 'classic');

  const selected = setContext(root, {
    provider: 'chatgpt', project, surface: 'app', type: 'chat',
  });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  const current = readPrefs(root);
  assert.equal(current.ui.routeCatalogVersion, 2);
  assert.deepEqual(current.ui.projects[0].routes.chatgpt, { surface: 'app', type: 'chat' });
  assert.equal(providerModel(root).selection.type, 'chat');
});

test('last project is remembered independently per provider and provider project lists stay scoped', () => {
  const root = tmpDir('providers-last-project-');
  const claudeOne = path.join(root, 'Claude One');
  const claudeTwo = path.join(root, 'Claude Two');
  const cursorOne = path.join(root, 'Cursor One');
  for (const project of [claudeOne, claudeTwo, cursorOne]) fs.mkdirSync(project, { recursive: true });

  assert.equal(setContext(root, {
    provider: 'claude', project: claudeOne, surface: 'app', type: 'cowork',
  }).ok, true);
  assert.equal(setContext(root, {
    provider: 'cursor', project: cursorOne, surface: 'cli', type: 'cursor-cli',
  }).ok, true);
  assert.equal(setContext(root, {
    provider: 'claude', project: claudeTwo, surface: 'cli', type: 'claude-cli',
  }).ok, true);

  const prefs = readPrefs(root);
  assert.equal(prefs.ui.lastProjectByProvider.claude, canonicalProject(claudeTwo));
  assert.equal(prefs.ui.lastProjectByProvider.cursor, canonicalProject(cursorOne));
  assert.deepEqual(
    projectsForProvider(root, prefs, 'claude').map((project) => project.path),
    [canonicalProject(claudeTwo), canonicalProject(claudeOne)],
  );
  assert.deepEqual(
    projectsForProvider(root, prefs, 'cursor').map((project) => project.path),
    [canonicalProject(cursorOne)],
  );
  assert.deepEqual(providerModel(root).lastProjectByProvider, {
    claude: canonicalProject(claudeTwo),
    cursor: canonicalProject(cursorOne),
  });

  const legacyUi = {
    selectedProvider: 'cursor',
    selectedProject: canonicalProject(cursorOne),
    projects: prefs.ui.projects.map(({ path: projectPath, lastUsedAt, routes }) => ({
      path: projectPath,
      lastUsedAt,
      routes,
    })),
  };
  writePrefs(root, { ui: legacyUi, currentSeat: 'cursor-cli' });
  assert.equal(providerModel(root).lastProjectByProvider.cursor, canonicalProject(cursorOne));
});

test('historical cards infer exact legacy routes, Other, and Unassigned', () => {
  const root = tmpDir('providers-history-');
  const project = path.join(root, 'Project');
  fs.mkdirSync(project, { recursive: true });
  const cards = [
    { id: 'cloud', seat: 'claude-app', method: 'stdio', from: 'human', body: 'a', state: 'waiting', reply: null, cwd: project },
    { id: 'ambiguous', seat: 'claude-app', method: 'stdio', from: 'human', body: 'b', state: 'waiting', reply: null, cwd: project },
    { id: 'unassigned', seat: 'cursor-cli', method: 'stdio', from: 'human', body: 'c', state: 'waiting', reply: null, cwd: null },
  ];
  for (const card of cards) appendLog(root, { event: 'deliver', card });
  appendLog(root, { event: 'attach', id: 'cloud', kind: 'cloud', sessionId: 'session_cloud' });
  appendLog(root, { event: 'attach', id: 'ambiguous', kind: 'mystery', sessionId: 'mystery' });

  const records = new Map(cardRecords(root).map((record) => [record.id, record]));
  assert.equal(records.get('cloud').route.type, 'cowork');
  assert.equal(records.get('ambiguous').route.type, 'other');
  assert.equal(records.get('ambiguous').route.label, 'Other');
  assert.equal(records.get('unassigned').route.project, null);
  assert.equal(providerCatalog(root, readPrefs(root)).unassigned, true);
});

test('historical ChatGPT Classic records keep Classic after the new Chat route is added', () => {
  const root = tmpDir('providers-classic-history-');
  const project = path.join(root, 'Convo ChatGPT App');
  fs.mkdirSync(project, { recursive: true });
  const card = {
    id: 'classic-old', seat: 'chatgpt-chat-app', method: 'ax', from: 'human',
    body: 'old classic', state: 'back', reply: 'done', cwd: project,
  };
  appendLog(root, {
    event: 'stage',
    card,
    route: { provider: 'chatgpt', project, surface: 'app', type: 'chat' },
  });
  const record = cardRecords(root).find((entry) => entry.id === card.id);
  assert.equal(record.route.type, 'classic');
  assert.equal(record.route.seat, 'chatgpt-chat-app');
  assert.equal(record.inferred, false);
});

test('route-aware turns add top-level lifecycle metadata without changing the card schema', async () => {
  const root = tmpDir('providers-route-log-');
  const project = path.join(root, 'Project');
  fs.mkdirSync(project, { recursive: true });
  const route = { provider: 'chatgpt', project, surface: 'app', type: 'work' };
  const result = await runTurn(root, {
    seat: 'human',
    method: 'stdio',
    methodExplicit: true,
    body: 'hello',
    cwd: project,
    fresh: true,
    route,
  });
  assert.equal(result.code, 0);
  assert.equal(result.card.route, undefined);
  const lifecycle = readLog(root).filter((event) => ['deliver', 'send'].includes(event.event));
  assert.equal(lifecycle.length, 2);
  assert.ok(lifecycle.every((event) => event.route && event.route.provider === 'chatgpt'));
  assert.ok(lifecycle.every((event) => event.card.route === undefined));
});

test('reply and stage preserve a pending card’s exact route metadata', async () => {
  const root = tmpDir('providers-routed-reply-');
  const project = path.join(root, 'Project');
  fs.mkdirSync(project, { recursive: true });
  const route = { provider: 'claude', project, surface: 'app', type: 'chat' };
  const result = await runTurn(root, {
    seat: 'human',
    method: 'stdio',
    methodExplicit: true,
    body: 'hello',
    cwd: project,
    fresh: true,
    route,
  });
  assert.equal(cmdReply(root, { id: result.card.id, reply: 'convobus ready' }).code, 0);
  assert.equal(cmdStage(root, { id: result.card.id }).code, 0);
  const lifecycle = readLog(root).filter((event) =>
    ['reply', 'check', 'stage'].includes(event.event) &&
      (event.id === result.card.id || (event.card && event.card.id === result.card.id)),
  );
  assert.ok(lifecycle.length >= 3);
  assert.ok(lifecycle.every((event) => event.route && event.route.type === 'chat'));
});

test('ChatGPT Chat lifecycle records keep exact route and attachment kind without a fake session id', async () => {
  const root = tmpDir('providers-chat-route-log-');
  const project = path.join(root, 'Convo ChatGPT App');
  fs.mkdirSync(project, { recursive: true });
  const route = { provider: 'chatgpt', project, surface: 'app', type: 'chat' };
  const result = await runTurn(root, {
    seat: 'chatgpt-modern-chat-app',
    method: 'stdio',
    methodExplicit: true,
    body: 'hello',
    cwd: project,
    argv: [NODE, FIXTURE],
    fresh: true,
    route,
    kind: 'chatgpt-chat',
  });
  assert.equal(result.code, 0, result.text);
  assert.equal(result.card.route, undefined);
  const log = readLog(root);
  const attach = log.find((event) => event.event === 'attach' && event.id === result.card.id);
  assert.ok(attach, JSON.stringify(log));
  assert.equal(attach.kind, 'chatgpt-chat');
  assert.equal(attach.sessionId, null);
  assert.equal(attach.sessionFile, null);
  assert.deepEqual(attach.route, route);
  assert.ok(
    log.filter((event) => ['deliver', 'attach', 'send', 'reply', 'stage'].includes(event.event))
      .every((event) => event.route && event.route.type === 'chat'),
  );
  const controlSource = fs.readFileSync(path.join(REPO, 'lib', 'control.js'), 'utf8');
  assert.match(controlSource, /fileWins: route\.projectBound === false \? false/);
});

test('provider APIs persist selection, filter records, and assist attachment without minting or executing', async () => {
  const root = tmpDir('providers-api-');
  const home = path.join(root, 'home');
  const project = path.join(root, "Project O'Neil");
  fs.mkdirSync(project, { recursive: true });
  markRoutesInstalled(root);
  const g = await listenGui(root, 0);
  try {
    const health = await get(g.url + '/api/health');
    assert.equal(health.status, 200, health.body);
    assert.deepEqual(JSON.parse(health.body), { ok: true });
    const providersResponse = await get(g.url + '/api/providers?home=' + encodeURIComponent(home));
    assert.equal(providersResponse.status, 200, providersResponse.body);
    const providers = JSON.parse(providersResponse.body);
    assert.deepEqual(providers.providers.map((provider) => provider.id), ['claude', 'chatgpt', 'cursor', 'grok']);
    assert.equal(providers.providers.flatMap((provider) => provider.routes).length, 11);
    assert.deepEqual(
      providers.providers.find((provider) => provider.id === 'chatgpt').routes.map((route) => [route.surface, route.type, route.seat]),
      [
        ['app', 'classic', 'chatgpt-chat-app'],
        ['app', 'chat', 'chatgpt-modern-chat-app'],
        ['app', 'work', 'chatgpt-app'],
        ['cli', 'codex', 'chatgpt-cli'],
      ],
    );

    const contextResponse = await post(g.url + '/api/context', {
      provider: 'cursor',
      project,
      surface: 'cli',
      type: 'cursor-cli',
      home,
    }, g.token);
    assert.equal(contextResponse.status, 200, contextResponse.body);
    const context = JSON.parse(contextResponse.body);
    assert.equal(context.context.type, 'cursor-cli');
    assert.equal(context.status.status, 'needs-session');
    assert.equal(context.status.attach.mode, 'cli');
    assert.match(context.status.attach.command, /cursor-agent$/);
    assert.match(context.status.attach.command, /'\\''/);
    assert.doesNotMatch(JSON.stringify(context), /--cloud|claude:\/\/cowork\/new/);

    const refreshedProviders = JSON.parse((await get(g.url + '/api/providers?home=' + encodeURIComponent(home))).body);
    assert.equal(refreshedProviders.lastProjectByProvider.cursor, canonicalProject(project));

    const query = new URLSearchParams({
      provider: 'cursor',
      project,
      surface: 'cli',
      type: 'cursor-cli',
      home,
    });
    const statusResponse = await get(g.url + '/api/route-status?' + query);
    assert.equal(statusResponse.status, 200, statusResponse.body);
    assert.equal(JSON.parse(statusResponse.body).status, 'needs-session');

    const sendResponse = await post(g.url + '/api/test-send', {
      route: { provider: 'cursor', project, surface: 'cli', type: 'cursor-cli' },
      home,
      body: 'do not execute',
    }, g.token);
    assert.equal(sendResponse.status, 400, sendResponse.body);
    assert.equal(JSON.parse(sendResponse.body).status.status, 'needs-session');
    assert.ok(!readLog(root).some((event) => event.event === 'deliver'));

    const forbidden = await post(g.url + '/api/test-send', {
      route: { provider: 'claude', project, surface: 'app', type: 'cowork' },
      mint: true,
    }, g.token);
    assert.equal(forbidden.status, 400, forbidden.body);
    assert.equal(JSON.parse(forbidden.body).error, 'never mint');

    const explicitRoute = { provider: 'cursor', project, surface: 'cli', type: 'cursor-cli' };
    const card = { id: 'filtered', seat: 'cursor-cli', method: 'stdio', from: 'human', body: 'visible', state: 'back', reply: 'done', cwd: project };
    appendLog(root, { event: 'stage', route: explicitRoute, card });
    appendLog(root, {
      event: 'stage',
      route: { provider: 'chatgpt', project, surface: 'cli', type: 'codex' },
      card: { ...card, id: 'hidden', seat: 'chatgpt-cli' },
    });
    const cardsResponse = await get(g.url + '/api/cards?' + query);
    assert.equal(cardsResponse.status, 200, cardsResponse.body);
    const filtered = JSON.parse(cardsResponse.body);
    assert.deepEqual(filtered.records.map((record) => record.id), ['filtered']);
    assert.equal(filtered.records[0].card.route, undefined);
    assert.deepEqual(filtered.records[0].route, {
      provider: 'cursor',
      providerName: 'Cursor',
      surface: 'cli',
      type: 'cursor-cli',
      label: 'Cursor CLI',
      seat: 'cursor-cli',
      variant: 'cursor-cli',
      appPath: null,
      command: 'cursor-agent',
      bundleIdentifier: null,
      projectBound: true,
      project: canonicalProject(project),
    });
  } finally {
    g.server.close();
  }
});
