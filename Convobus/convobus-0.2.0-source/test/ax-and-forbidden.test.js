'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO, tmpDir, convobus } = require('./helpers');
const { jxaSource, parseRolesFromDump } = require('../lib/methods/ax');
const { normalizeComposerText } = require('../lib/methods/cursor-cdp');
const {
  chatGPTSendTemplate,
  jsonEscapeForScript,
  sendApplescript,
  PROBE_MS,
} = require('../lib/methods/applescript');

test('ChatGPT dictionary probe is bounded so a closed gate cannot stall the bus', () => {
  assert.ok(PROBE_MS <= 5000);
  const src = fs.readFileSync(path.join(REPO, 'lib', 'methods', 'applescript.js'), 'utf8');
  assert.match(src, /PROBE_MS/);
  const ax = fs.readFileSync(path.join(REPO, 'lib', 'methods', 'ax.js'), 'utf8');
  assert.match(ax, /timeout: \(opts && opts\.timeout\) \|\| 8000/);
});

test('JXA uses only set-value / AXPress by title / read static text', () => {
  const src = jxaSource();
  assert.match(src, /AXPress/);
  assert.match(src, /el\.value/);
  assert.match(src, /AXStaticText/);
  assert.doesNotMatch(src, /\bkeystroke\b/);
  assert.doesNotMatch(src, /\bclipboard\b/i);
  assert.doesNotMatch(src, /AXRaise/);
  assert.doesNotMatch(src, /TIOCSTI/);
  assert.doesNotMatch(src, /xdotool/);
  assert.doesNotMatch(src, /playwright/i);
  assert.doesNotMatch(src, /System Events.*keystroke/);
});

test('incomplete dump is fragile and does not invent a send title', () => {
  const roles = parseRolesFromDump('Claude\nnot much here');
  assert.equal(roles.composer, null);
  assert.equal(roles.fragile, true);
  const dir = tmpDir('frag-');
  const r = convobus(['seats'], { cwd: dir });
  assert.match(r.stdout, /fragile/);
});

test('applescript template JSON-escapes the payload', () => {
  const payload = 'window.x("quote\\"here")';
  const script = chatGPTSendTemplate(payload);
  assert.match(script, /tell application "ChatGPT"/);
  assert.match(script, /execute \(active tab of window 1\) javascript/);
  assert.ok(script.includes(jsonEscapeForScript(payload)));
});

test('AppleScript delivery accepts only its owning ChatGPT app seat', () => {
  const probe = { dictionary: true, jsOpen: true, tcc: false };
  const wrongSeat = sendApplescript(
    { id: 'wrong-seat', seat: 'claude-app', body: 'do not send' },
    { app: 'ChatGPT', probe },
  );
  assert.equal(wrongSeat.miss, true);
  assert.match(wrongSeat.reason, /no dictionary template/);
  const wrongApp = sendApplescript(
    { id: 'wrong-app', seat: 'chatgpt-app', body: 'do not send' },
    { app: 'Claude', probe },
  );
  assert.equal(wrongApp.miss, true);
  assert.match(wrongApp.reason, /no dictionary template/);
});

test('zero runtime deps and no Windows path', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {});
  const walk = (dir, acc) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.tmp' || ent.name === '.git') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, acc);
      else if (/\.(js|plist|json)$/.test(ent.name)) acc.push(p);
    }
    return acc;
  };
  const files = walk(path.join(REPO, 'lib'), []).concat(
    path.join(REPO, 'convobus'),
    path.join(REPO, 'package.json'),
  );
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /C:\\\\Users/);
    assert.doesNotMatch(t, /process\.env\.APPDATA/);
  }
});

test('cursor composer insert is CDP Input.insertText, not keystroke or clipboard', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib/methods/cursor-cdp.js'), 'utf8');
  assert.match(src, /Input\.insertText/);
  assert.doesNotMatch(src, /String\(got\.text \|\| ''\)\.includes\(body\)/);
  assert.match(src, /aislash-editor-input/);
  assert.doesNotMatch(src, /\bkeystroke\b/);
  assert.doesNotMatch(src, /\bclipboard\b/i);
  assert.doesNotMatch(src, /playwright/i);
  assert.doesNotMatch(src, /CGEventKeyboard/);
  const ax = fs.readFileSync(path.join(REPO, 'lib/methods/ax.js'), 'utf8');
  assert.match(ax, /sendCursorComposer/);
  assert.match(ax, /reason: completed[\s\S]*\? null/);
});

test('composer verification normalizes only platform line endings and requires equality', () => {
  assert.equal(normalizeComposerText('a\r\nb\u2028c'), 'a\nb\nc');
  assert.notEqual(normalizeComposerText('draft plus intended'), normalizeComposerText('intended'));
  const swift = fs.readFileSync(path.join(REPO, 'lib', 'ax-helper.swift'), 'utf8');
  const insertion = swift.slice(swift.indexOf('func normalizedComposerText'), swift.indexOf('func pressTitled'));
  assert.match(insertion, /composerTextEquals/);
  assert.doesNotMatch(insertion, /contains\(text\)/);
});

test('ChatGPT retries the verified composer with AX focus and exact readback', () => {
  const swift = fs.readFileSync(path.join(REPO, 'lib', 'ax-helper.swift'), 'utf8');
  const send = swift.slice(swift.indexOf('func send('), swift.indexOf('func axHelperMain'));
  assert.match(swift, /func composerValue[\s\S]*stringForRange/);
  assert.match(swift, /func composerTextMatchesSoon[\s\S]*0\.\.\<8[\s\S]*composerTextEquals/);
  assert.match(swift, /desc\.contains\("message chatgpt"\)/);
  assert.match(
    send,
    /if chatgpt && !inserted[\s\S]*focusEl\(composerEl\)[\s\S]*collect\(name\)[\s\S]*chatGPTMode[\s\S]*insertText\(composerEl, text, focus: true\)/,
  );
  assert.match(send, /composerTextEquals\(composerValue\(composerEl\), text\)/);
});

test('in-bundle AX helper exists beside the TCC owner executable', () => {
  const helper = path.join(REPO, 'app', 'Convobus.app', 'Contents', 'MacOS', 'ax-helper');
  assert.ok(fs.existsSync(helper), helper);
  const src = fs.readFileSync(path.join(REPO, 'lib', 'ax-helper.swift'), 'utf8');
  assert.match(src, /AXPressAction|kAXPressAction/);
  assert.match(src, /chatGPTBundleIdentifiers/);
  assert.match(src, /"com\.openai\.chat", "com\.openai\.codex"/);
  assert.match(src, /apps\.first \{ \$0\.bundleIdentifier == name \}/);
  assert.match(src, /isChatGPTSelector\(name\)/);
  assert.match(src, /Stop generating/);
  assert.match(src, /停止生成/);
  assert.doesNotMatch(src, /\bkeystroke\b/);
  assert.doesNotMatch(src, /AXRaise/);
});

test('Accessibility helpers require the running bundle protocol manifest', () => {
  const { readBundleManifest, bundleExecutable } = require('../lib/bundle-helper');
  const bundle = path.join(REPO, 'app', 'Convobus.app');
  const manifest = readBundleManifest(bundle);
  assert.equal(manifest.protocolVersion, 3);
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.build, '8');
  assert.equal(bundleExecutable(bundle, 'Convobus'), path.join(bundle, 'Contents', 'MacOS', 'Convobus'));
  assert.equal(bundleExecutable(path.join(REPO, 'missing.app'), 'Convobus'), null);
});

test('Convobus.app is a Mach-O AppKit app with an accessory background mode, not a shell stub', () => {
  const exe = path.join(REPO, 'app', 'Convobus.app', 'Contents', 'MacOS', 'Convobus');
  const ft = spawnSync('file', [exe], { encoding: 'utf8' });
  assert.match(ft.stdout, /Mach-O/);
  assert.match(ft.stdout, /universal binary/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(REPO, 'app', 'Convobus.app', 'Contents', 'Info.plist'), 'utf8'),
    /<key>LSUIElement<\/key>\s*<true\/>/,
  );
  const swift = fs.readFileSync(path.join(REPO, 'lib', 'app-main.swift'), 'utf8');
  assert.match(swift, /NSWindow/);
  assert.match(swift, /makeKeyAndOrderFront/);
  assert.match(swift, /applicationShouldHandleReopen/);
  assert.match(swift, /statusItem/);
  assert.match(swift, /NSOpenPanel/);
  assert.match(swift, /canChooseDirectories/);
  assert.match(swift, /Directory/);
  assert.match(swift, /waitUntilExit/);
  assert.match(swift, /SIGKILL/);
  assert.doesNotMatch(swift, /WKWebView/);
  const via = fs.readFileSync(path.join(REPO, 'lib', 'via-app.js'), 'utf8');
  const bundleHelper = fs.readFileSync(path.join(REPO, 'lib', 'bundle-helper.js'), 'utf8');
  assert.match(via, /compatibleBundleExecutable/);
  assert.match(bundleHelper, /Contents.*MacOS/);
  assert.match(bundleHelper, /protocolVersion !== PROTOCOL_VERSION/);
  assert.doesNotMatch(via, /spawnSync\(\s*'open'/);
  const help = spawnSync(exe, ['--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /convobus seats/);
});

test('Convobus embeds a universal Node LTS runtime before any system fallback', () => {
  const runtime = path.join(
    REPO,
    'app',
    'Convobus.app',
    'Contents',
    'Resources',
    'Runtime',
    'node',
  );
  const runtimeLicense = path.join(path.dirname(runtime), 'Node-LICENSE.txt');
  assert.ok(fs.existsSync(runtime), runtime);
  assert.ok(fs.existsSync(runtimeLicense), runtimeLicense);
  assert.match(spawnSync('file', [runtime], { encoding: 'utf8' }).stdout, /universal binary/);
  assert.match(spawnSync(runtime, ['--version'], { encoding: 'utf8' }).stdout, /^v22\.23\.2/);

  const swift = fs.readFileSync(path.join(REPO, 'lib', 'app-main.swift'), 'utf8');
  const bundled = swift.indexOf('resources + "/Runtime/node"');
  const system = swift.indexOf('"/opt/homebrew/bin/node"');
  assert.ok(bundled >= 0 && system > bundled, 'the embedded runtime must be preferred');
});

test('Convobus.app ships and loads its branded application icon', () => {
  const resources = path.join(REPO, 'app', 'Convobus.app', 'Contents', 'Resources');
  const info = fs.readFileSync(
    path.join(REPO, 'app', 'Convobus.app', 'Contents', 'Info.plist'),
    'utf8',
  );
  const swift = fs.readFileSync(path.join(REPO, 'lib', 'app-main.swift'), 'utf8');
  const icon = path.join(resources, 'ConvobusIcon.icns');
  assert.match(info, /<key>CFBundleIconFile<\/key>\s*<string>ConvobusIcon\.icns<\/string>/);
  assert.match(info, /<key>CFBundleIconName<\/key>\s*<string>ConvobusIcon<\/string>/);
  assert.ok(fs.existsSync(icon), icon);
  assert.ok(fs.existsSync(path.join(resources, 'ConvobusIcon.png')));
  assert.match(spawnSync('file', [icon], { encoding: 'utf8' }).stdout, /Mac OS X icon/);
  assert.match(swift, /NSApp\.applicationIconImage = icon/);
  assert.match(swift, /NSImageView\(image: icon\)/);
});

test('Convobus native surfaces preserve the provider/project split-view and persistent menu bar', () => {
  const swift = fs.readFileSync(path.join(REPO, 'lib', 'app-main.swift'), 'utf8');
  const resources = path.join(REPO, 'app', 'Convobus.app', 'Contents', 'Resources');
  assert.match(swift, /NSSplitViewController/);
  assert.match(swift, /NSVisualEffectView/);
  assert.match(swift, /\.sidebar/);
  assert.match(swift, /ProviderTableCellView/);
  assert.match(swift, /ProjectTableCellView/);
  assert.match(swift, /ConversationCollectionItem/);
  assert.match(swift, /makeComposer/);
  assert.match(swift, /\.fullSizeContentView/);
  assert.match(swift, /width: 1040, height: 760/);
  assert.match(swift, /width: 720, height: 520/);
  assert.match(swift, /ContextSelectionCoordinator/);
  assert.match(swift, /\/api\/native-snapshot/);
  assert.match(swift, /ConvobusMenuTemplate/);
  const statusMenu = swift.slice(swift.indexOf('private func setupStatusItem'), swift.indexOf('private func ensureStatusItemPresentation'));
  assert.doesNotMatch(statusMenu, /Send Test Card|Last token|copyLastToken/i);
  assert.match(swift, /item\.isVisible = true/);
  assert.match(swift, /NSStatusItem\.squareLength/);
  assert.match(swift, /button\.imagePosition = \.imageOnly/);
  assert.match(swift, /func windowWillClose/);
  assert.match(swift, /setActivationPolicy\(\.accessory\)/);
  assert.match(swift, /showWindowMenu[\s\S]*setActivationPolicy\(\.regular\)/);
  assert.match(swift, /func applicationShouldTerminate[\s\S]*fullQuitRequested[\s\S]*terminateCancel/);
  assert.match(swift, /Close Window — Keep Convobus Running/);
  assert.match(swift, /closeWindowKeepingMenuBar/);
  assert.match(swift, /Quit Convobus[\s\S]*quitFromStatusMenu/);
  assert.match(swift, /NSStatusItem Preferred Position/);
  assert.match(swift, /item\.autosaveName = statusName/);
  assert.match(swift, /StatusItemKeeper\.item = item/);
  assert.match(swift, /item\.length = NSStatusItem\.squareLength/);
  assert.doesNotMatch(swift, /ConvobusMenuBarProbe/);
  assert.match(swift, /serverProcess = p/);
  assert.match(swift, /process\.terminate\(\)/);
  assert.ok(fs.existsSync(path.join(resources, 'ConvobusMenuTemplate.png')));
});

test('Convobus.app exists as TCC owner and reads log.ndjson from the Node window', () => {
  const plist = path.join(REPO, 'app', 'Convobus.app', 'Contents', 'Info.plist');
  const exe = path.join(REPO, 'app', 'Convobus.app', 'Contents', 'MacOS', 'Convobus');
  assert.ok(fs.existsSync(plist));
  assert.ok(fs.existsSync(exe));
  const info = fs.readFileSync(plist, 'utf8');
  assert.match(info, /com\.convobus\.app/);
  assert.match(info, /NSDocumentsFolderUsageDescription/);
  assert.match(info, /NSDesktopFolderUsageDescription/);
  const gui = fs.readFileSync(path.join(REPO, 'lib', 'gui.js'), 'utf8');
  assert.match(gui, /log\.ndjson/);
  assert.match(gui, /does not keep a second store/);
  assert.match(gui, /id="composer"/);
});

test('shipped send path does not call untrusted drivers', () => {
  const lib = path.join(REPO, 'lib');
  const rg = spawnSync(
    'rg',
    [
      '-n',
      'TIOCSTI|xdotool|playwright|MCP-as-the-loop',
      lib,
      path.join(REPO, 'convobus'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal((rg.stdout || '').trim(), '', rg.stdout);
});
