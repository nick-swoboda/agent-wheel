'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO } = require('./helpers');
const { vendorArgv } = require('../lib/methods/stdio');
const { jxaSource } = require('../lib/methods/ax');
const applescript = fs.readFileSync(path.join(REPO, 'lib', 'methods', 'applescript.js'), 'utf8');

test('chatgpt attach does not mint a new thread; app send is stdio resume + file-wins', () => {
  const grokArgv = vendorArgv('grok-cli', 'hello', '/bin/grok');
  assert.deepEqual(grokArgv, ['/bin/grok', '-p', 'hello', '--max-turns', '1', '--continue']);
  assert.ok(!grokArgv.includes('--fork-session'));
  const grokResume = vendorArgv('grok-cli', 'hello', '/bin/grok', {
    sessionId: '01a04a52-c7fc-7062-815c-eada29bd7d63',
  });
  assert.deepEqual(grokResume, [
    '/bin/grok',
    '-p',
    'hello',
    '--max-turns',
    '1',
    '--resume',
    '01a04a52-c7fc-7062-815c-eada29bd7d63',
  ]);
  assert.ok(!grokResume.includes('--continue'));
  assert.ok(!grokResume.includes('--fork-session'));
  const src = fs.readFileSync(path.join(REPO, 'lib', 'methods', 'stdio.js'), 'utf8');
  assert.match(src, /queueExistingCodex/);
  assert.match(src, /resumeExistingCodex/);
  assert.match(src, /ensureChatGPTAppUnfocused/);
  assert.match(src, /CHATGPT_BUNDLE = 'com\.openai\.codex'/);
  assert.match(src, /spawnSync\('open', \['-g', '-b', CHATGPT_BUNDLE\]/);
  assert.match(src, /chatgptAppRunning/);
  const launch = src.slice(src.indexOf('function ensureChatGPTAppUnfocused'), src.indexOf('const UUID_RE'));
  assert.doesNotMatch(launch, /kill|SIGKILL|pkill/);
  assert.match(src, /function ensureClaudeAppUnfocused/);
  assert.match(src, /function claudeAppRunning/);
  assert.match(src, /function ensureCursorAppUnfocused/);
  assert.match(src, /function cursorAppRunning/);
  assert.equal((src.match(/spawnSync\('open', \['-g', '-a'/g) || []).length, 2);
  assert.match(src, /exec',\s*'resume'/);
  assert.match(src, /argv\.splice\(2, 0, '-C'/);
  assert.match(src, /queue/);
  assert.match(src, /--thread/);
  assert.match(src, /--message/);
  const turn = fs.readFileSync(path.join(REPO, 'lib', 'turn.js'), 'utf8');
  assert.match(turn, /existingCodexSession/);
  assert.match(turn, /queueExistingCodex/);
  assert.match(turn, /resumeExistingCodex/);
  assert.match(turn, /ensureChatGPTAppUnfocused/);
  assert.match(turn, /ensureClaudeAppUnfocused/);
  assert.match(turn, /ensureCursorAppUnfocused/);
  assert.match(turn, /chatgpt-cli/);
  assert.match(turn, /chatgpt-app/);
  assert.match(turn, /chatgpt-chat-app/);
  assert.match(turn, /chatgpt-modern-chat-app/);
  assert.match(turn, /grok-cli/);
  assert.match(turn, /resolveVendorSession/);
  assert.match(turn, /sendAx/);
  assert.match(turn, /queueExistingCodex/);
  assert.match(turn, /resumeExistingCodex/);
  assert.doesNotMatch(turn, /AX\/AppleScript may submit into consumer ChatGPT/);
  assert.doesNotMatch(turn, /card\.seat === 'chatgpt-app'[\s\S]{0,400}return sendAx/);
  assert.doesNotMatch(turn, /chatgpt-app && !o\.methodExplicit\) card\.method = 'ax'/);
  assert.doesNotMatch(turn, /ax && \(ax\.submitted \|\| \(ax\.ok && ax\.reply\)\) return ax/);
  assert.doesNotMatch(turn, /chatgpt-app[\s\S]{0,80}!o\.sessionFile/);
  const ax = fs.readFileSync(path.join(REPO, 'lib', 'ax-helper.swift'), 'utf8');
  assert.doesNotMatch(ax, /pressTitled\(t0, "New chat"\)/);
  assert.match(ax, /Claude responded/);
  assert.match(ax, /--ax-feed/);
  assert.match(ax, /work with chatgpt/);
  assert.match(ax, /hitChatGPTComposer/);
  assert.match(ax, /if claude \|\| cursor \|\| chatgpt \{ activateNamed\(name\) \}/);
  const passiveProbe = ax.slice(ax.indexOf('func probe('), ax.indexOf('func failNoComposer'));
  assert.doesNotMatch(passiveProbe, /activateNamed|\.activate\(/);
  assert.match(ax, /restorePreviousApplication/);
  assert.match(ax, /restorePreviousApplication\(\)[\s\S]*let waitStart/);
  assert.match(ax, /lastComposer\(hits, forClaude: name == "Claude", forCursor: name == "Cursor"\)/);
  const axMethod = fs.readFileSync(path.join(REPO, 'lib', 'methods', 'ax.js'), 'utf8');
  assert.match(axMethod, /'chatgpt-chat-app': 'com\.openai\.chat'/);
  assert.match(axMethod, /'chatgpt-modern-chat-app': 'com\.openai\.codex'/);
  assert.match(axMethod, /o\.attachNeedle === false/);
  assert.match(axMethod, /expectedMode/);
  assert.match(axMethod, /pid: parsed\.pid/);
  assert.match(ax, /func chatGPTMode/);
  assert.match(ax, /"pid": pidNamed\(name\)/);
  assert.match(ax, /message chatgpt/);
  assert.match(ax, /work with chatgpt/);
  assert.match(ax, /expected ChatGPT \\\(expectedMode\) surface/);
  assert.match(ax, /Stop generating/);
  assert.match(ax, /停止生成/);
  assert.match(ax, /if claude && saidN > said0 \{\s+seenGen = true\s+strongNewReply = true/);
  assert.match(ax, /func exactSendHit/);
  assert.match(ax, /send feedback/);
  assert.match(ax, /send control did not clear composer/);
  assert.match(ax, /var sendB = exactSendHit\(t1\)/);
  assert.match(ax, /if claude && sendB == nil[\s\S]*ancestorHits\(composerEl, levels: 6\)[\s\S]*exactSendHit\(refreshedHits\)/);
  assert.match(ax, /t1 \+= ancestorHits\(composerEl, levels: 4\)/);
  assert.match(ax, /"send": sendControl != nil/);
  assert.match(ax, /func nearbyComposerHits/);
  assert.match(ax, /t1 \+= nearbyComposerHits\(app, composer\)/);
  assert.match(ax, /selector == "com\.openai\.chat"[\s\S]*hit\.valueSettable/);
  assert.match(ax, /func addedStaticTexts/);
  assert.match(ax, /func classicReplyAfterBody/);
  assert.match(ax, /func stringForTextMarkers/);
  assert.match(ax, /AXTextMarkerRangeForUnorderedTextMarkers/);
  assert.match(ax, /AXStringForTextMarkerRange/);
  assert.match(ax, /func chatGPTDocumentReply/);
  assert.match(ax, /gptDocumentSaid0/);
  assert.match(ax, /documentBlock/);
  assert.match(ax, /Date\(\)\.timeIntervalSince\(g\) > 8\.0/);
  assert.match(ax, /chatgpt && name == "com\.openai\.chat"/);
  assert.match(ax, /replacingOccurrences\(of: "\\u\{FFFC\}"/);
  assert.match(ax, /var strongNewReply = false/);
  assert.match(ax, /reply == snap && !strongNewReply/);
  assert.match(ax, /func composerElementStillContains/);
  assert.match(ax, /exactSendHit\(verifyHits\) \?\? sendB/);
});

test('claude-app argv has no bare -r without a session uuid', () => {
  const claudeCliBare = vendorArgv('claude-cli', 'hello', '/bin/claude');
  assert.deepEqual(claudeCliBare, ['/bin/claude', '-p', 'hello']);
  assert.ok(!claudeCliBare.includes('-r'));
  const claudeCliUuid = vendorArgv('claude-cli', 'hello', '/bin/claude', {
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });
  assert.deepEqual(claudeCliUuid, [
    '/bin/claude',
    '-p',
    'hello',
    '-r',
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  ]);
  const claudeBare = vendorArgv('claude-app', 'hello', '/bin/claude');
  assert.deepEqual(claudeBare, ['/bin/claude', '-p', 'hello']);
  assert.ok(!claudeBare.includes('-r'));
  const claudeBad = vendorArgv('claude-app', 'hello', '/bin/claude', { sessionId: 'desktop' });
  assert.ok(!claudeBad.includes('-r'));
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const claudeUuid = vendorArgv('claude-app', 'hello', '/bin/claude', { sessionId: uuid });
  assert.deepEqual(claudeUuid, ['/bin/claude', '-p', 'hello', '-r', uuid]);
  const cloud = 'session_01GJrmfqVoJveULXszaBHCoF';
  const claudeCloud = vendorArgv('claude-app', 'hello', '/bin/claude', { sessionId: cloud });
  assert.deepEqual(claudeCloud, ['/bin/claude', '-p', 'hello', '--cloud', cloud]);
  assert.ok(!claudeCloud.includes('-r'));
  const chatId = 'fb4a4a32-0501-4cff-a9b6-b50df6380ccf';
  const claudeChat = vendorArgv('claude-app', 'hello', '/bin/claude', { sessionId: chatId, kind: 'chat' });
  assert.deepEqual(claudeChat, [
    '/bin/claude',
    '-p',
    'hello',
    '--cloud',
    'https://claude.ai/chat/' + chatId,
  ]);
  assert.ok(!claudeChat.includes('-r'));
  assert.ok(!claudeChat.includes('--fork-session'));
  const turnClaude = fs.readFileSync(path.join(REPO, 'lib', 'turn.js'), 'utf8');
  assert.match(turnClaude, /queueExistingClaude/);
  assert.doesNotMatch(
    turnClaude,
    /card\.seat === 'claude-app'[\s\S]{0,400}return sendAx/,
  );
  assert.doesNotMatch(turnClaude, /lastClaudeRespondedFromDump/);
  assert.equal(vendorArgv('antigravity-cli', 'hello', '/bin/agy'), null);
  assert.equal(vendorArgv('cursor-cli', 'hello', '/bin/cursor-agent'), null);
  const stdioSrc = fs.readFileSync(path.join(REPO, 'lib', 'methods', 'stdio.js'), 'utf8');
  assert.match(stdioSrc, /queueExistingCursor/);
  assert.match(stdioSrc, /--resume/);
  assert.doesNotMatch(stdioSrc, /create-chat/);
  const turnSrc = fs.readFileSync(path.join(REPO, 'lib', 'turn.js'), 'utf8');
  assert.match(turnSrc, /existingCursorSession/);
  assert.match(turnSrc, /queueExistingCursor/);
  assert.doesNotMatch(turnSrc, /card\.seat === 'cursor-app'[\s\S]{0,500}return sendAx/);
  assert.match(turnSrc, /card\.seat === 'claude-cli'/);
  assert.match(turnSrc, /card\.seat === 'cursor-cli'/);
  assert.doesNotMatch(turnSrc, /cursor-cli[\s\S]{0,400}ensureCursorAppUnfocused/);
  assert.match(turnSrc, /queueExistingClaude/);
});

test('AX waits until Stop generating / 停止生成 is gone; no 0.4s last-static short-circuit', () => {
  const src = jxaSource();
  assert.match(src, /Stop generating/);
  assert.match(src, /停止生成/);
  assert.match(src, /seenGenerating/);
  assert.match(src, /lastStaticText/);
  assert.match(src, /no new reply after snapshot/);
  assert.match(src, /generating control never appeared/);
  assert.doesNotMatch(src, /if \(!generating\) break/);
  assert.doesNotMatch(src, /delay\(0\.4\)/);
});

test('AppleScript submit with reply null is not a round trip', () => {
  assert.match(applescript, /applescript submit has no reply/);
  assert.match(applescript, /reply: null/);
  const sendFn = applescript.slice(applescript.indexOf('function sendApplescript'));
  const ret = sendFn.slice(sendFn.lastIndexOf('return {'));
  assert.match(ret, /ok: false/);
  assert.match(ret, /reply: null/);
});
