'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO } = require('./helpers');

test('native Loops remain a compact project-level extension of the direct workspace', () => {
  const app = fs.readFileSync(path.join(REPO, 'lib', 'app-main.swift'), 'utf8');
  const loops = fs.readFileSync(path.join(REPO, 'lib', 'loop-ui.swift'), 'utf8');
  const build = fs.readFileSync(path.join(REPO, 'scripts', 'build-native-app.sh'), 'utf8');
  assert.match(app, /labelWithString: "LOOPS"/);
  assert.match(app, /#selector\(newLoop\(_:\)\)/);
  assert.match(app, /sectionGap\.heightAnchor\.constraint\(equalToConstant: 9\)/);
  assert.match(app, /lowerScroll\.documentView = lowerDocument/);
  assert.match(app, /lowerStack\.addArrangedSubview\(projectsTable\)[\s\S]*lowerStack\.addArrangedSubview\(loopsTable\)/);
  assert.match(app, /refreshLoopSidebarForSelection/);
  assert.match(app, /\/api\/loop-history/);
  assert.match(app, /save-project-profile/);
  assert.match(app, /directComposerView\?\.isHidden = true/);
  assert.match(loops, /final class LoopSetupView/);
  assert.match(loops, /What should this Loop work on\?/);
  assert.match(loops, /Add name/);
  assert.match(loops, /Leader/);
  assert.match(loops, /Builder/);
  assert.match(loops, /Reviewer/);
  assert.match(loops, /Continue Loop…/);
  assert.match(loops, /Add Correction…/);
  assert.match(loops, /Reply as Me/);
  assert.match(loops, /Stop Loop…/);
  assert.match(loops, /NSCollectionViewDataSource/);
  assert.doesNotMatch(loops, /LoopEditorViewController|LoopEditorDraft/);
  assert.doesNotMatch(app, /presentLoopEditor|Edit Loop…|Delete Loop…/);
  assert.doesNotMatch(loops, /workflow canvas|template|advanced settings/i);
  assert.match(build, /loops\.js/);
  assert.match(build, /loop-ui\.swift/);
});

test('Loop menu and shutdown controls preserve background execution and manual restart', () => {
  const app = fs.readFileSync(path.join(REPO, 'lib', 'app-main.swift'), 'utf8');
  const gui = fs.readFileSync(path.join(REPO, 'lib', 'gui.js'), 'utf8');
  assert.match(app, /Open Loop/);
  assert.match(app, /Pause Loop/);
  assert.match(app, /Resume Loop/);
  assert.match(app, /Stop Loop…/);
  assert.match(app, /applicationShouldTerminateAfterLastWindowClosed[\s\S]*false/);
  assert.match(app, /applicationWillTerminate[\s\S]*"action": "pause"/);
  assert.match(app, /validatedAdoptedServerPID/);
  assert.match(app, /Darwin\.kill\(pid, SIGTERM\)/);
  assert.match(gui, /reconcileActiveRun\(root\)/);
  assert.match(gui, /pauseActiveRunForShutdown/);
});
