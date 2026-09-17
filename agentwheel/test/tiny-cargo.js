'use strict';

function experience() {
  return {
    actors: ['a person with a browser'],
    journeys: [{ name: 'read the note', steps: ['open the page', 'see the word hello'] }],
    edge_cases: ['page opened from file:// with no server'],
    usability: ['loads instantly with no interaction needed'],
    acceptance: [{ id: 'A1', criterion: 'the page body contains the word hello' }],
  };
}

function design() {
  return {
    screens: [{ id: 'S1', name: 'The note', contents: ['the word hello, and nothing else'] }],
    visual: [{ id: 'V1', rule: 'dark text on a plain light page, one line, no decoration' }],
    states: [{ id: 'T1', screen: 'S1', state: 'opened', transition: 'the note is visible the moment the page opens' }],
    interactions: [{ id: 'I1', screen: 'S1', rule: 'no interaction is required or offered' }],
    content: [{ id: 'N1', rule: 'the body text is exactly the word hello' }],
    acceptance: [{ id: 'D1', criterion: 'opening the page shows the word hello without any interaction' }],
  };
}

function spec(outputDir, extra) {
  return {
    requirements: [{ id: 'R1', requirement: 'a single html page prints hello' }],
    constraints: [{ id: 'C1', constraint: 'the page makes no external requests' }],
    platform: 'local html file',
    security: ['no-network: the artifact must not reference the network'],
    release: {
      artifact_type: 'single_file_html',
      output_dir: outputDir,
      link_kind: 'file_url',
    },
    providers_tools: ['node'],
    ...(extra || {}),
  };
}

function controlInputs(authority, routes = ['claude:cli'], window = '1 day') {
  return [
    ...(authority ? [{ type: 'budget_set', authority, window }] : []),
    ...['leader', 'builder', 'reviewer'].map(seat => ({
      type: 'seat_assignment', seat, route: seat === 'reviewer' ? routes[1] || routes[0] : routes[0],
    })),
  ];
}

function configure(wheel, authority, routes, window) {
  for (const input of controlInputs(authority, routes, window)) {
    const result = wheel.runTurn(input);
    if (!result.ok) throw new Error(result.error);
  }
}

function submitSpec(wheel, outputDir, authority, routes, extra) {
  configure(wheel, authority, routes);
  return wheel.runTurn({ type: 'form', kind: 'spec', content: spec(outputDir, extra) });
}

const NA = (reason) => ({ applicable: false, reason });
function basesNone(why) {
  return {
    first_principles: NA(why + ': no derivation applies'),
    trusted_method: NA(why + ': no trusted method applies'),
    executable_test: NA(why + ': nothing executable applies'),
    inspection: NA(why + ': nothing to inspect'),
    math: NA(why + ': no arithmetic applies'),
    physics: NA(why + ': no physical law applies'),
  };
}
function basesExec(files, entry, why) {
  return { ...basesNone(why), executable_test: { applicable: true, exec: { files, entry } } };
}

const PROTO = `
'use strict';
const html = '<!doctype html><html><body>hello</body></html>';
if (!html.includes('hello')) { console.log('missing hello'); process.exit(1); }
console.log('prototype contains hello');
`;

function trialKit(draftLeaves, opts) {
  const o = opts || {};
  const leaves = {};
  for (const leafNode of draftLeaves) {
    if (o.skip && o.skip.includes(leafNode.id)) continue;
    if (leafNode.kind === 'decision') {
      leaves[leafNode.id] = {
        bases: basesNone('the decision is settled by comparing alternative builds'),
        alternatives: [
          {
            id: 'ALT1',
            name: 'inline single file',
            summary: 'one html file with the note inline',
            build: { files: { 'a.js': "console.log('single file assembled'); process.exit(0);" }, entry: 'a.js' },
          },
          {
            id: 'ALT2',
            name: 'page plus stylesheet',
            summary: 'html file plus a separate css file',
            build: { files: { 'b.js': "console.log('two files assembled'); process.exit(0);" }, entry: 'b.js' },
          },
        ],
        chosen: 'ALT1',
        rationale: 'both build, but a single file honors the single_file_html release type directly',
      };
    } else if (leafNode.kind === 'assumption') {
      leaves[leafNode.id] = {
        bases: {
          ...basesNone('a static string cannot make requests'),
          first_principles: {
            applicable: true,
            derivation:
              'A static html string with no script, src, or href cannot initiate a request; ' +
              'the artifact will be exactly such a string, checked by the execution test suite.',
          },
        },
      };
    } else if (leafNode.id === 'L1.5.1') {
      leaves[leafNode.id] = {
        bases: basesExec({
          'build.js': `
'use strict';
const fs = require('fs');
fs.writeFileSync('out.html', '<!doctype html><html><body>hello</body></html>');
if (!fs.existsSync('out.html')) process.exit(1);
console.log('buildable');
`,
        }, 'build.js', 'a build run decides it'),
      };
    } else if (leafNode.id === 'L1.5.2') {
      leaves[leafNode.id] = {
        bases: basesExec({
          'link.js': `
'use strict';
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');
fs.writeFileSync('x.html', 'hello');
const link = pathToFileURL(require('path').resolve('x.html')).href;
if (!fs.existsSync(fileURLToPath(link))) process.exit(1);
console.log('file url resolves');
`,
        }, 'link.js', 'a link resolution run decides it'),
      };
    } else {
      leaves[leafNode.id] = { bases: basesExec({ 'proto.js': PROTO }, 'proto.js', 'a prototype run decides it') };
    }
  }
  return { leaves };
}

const TEST_JS = `
'use strict';
const fs = require('fs');
let passed = 0, failed = 0;
const html = fs.readFileSync('index.html', 'utf8');
if (html.includes('hello')) passed++; else failed++;
if (!/fetch\\s*\\(|src=|href=/.test(html)) passed++; else failed++;
console.log('TESTS passed=' + passed + ' failed=' + failed);
process.exit(failed === 0 ? 0 : 1);
`;

function executionSubmission(leaves, extra) {
  return {
    leaves,
    files: {
      'index.html': '<!doctype html>\n<html><body>hello</body></html>\n',
      'test.js': TEST_JS,
    },
    main_file: 'index.html',
    test_command: 'node test.js',
    notes: 'tiny note artifact for engine tests',
    ...(extra || {}),
  };
}

function ideaText() {
  return {
    name: 'Tiny Note',
    problem: 'There is no way to hand someone a note that opens instantly without any app.',
    solution: 'A single local html file that shows the word hello the moment it opens.',
  };
}

module.exports = { configure, controlInputs, submitSpec, experience, design, spec, trialKit, executionSubmission, ideaText, basesNone, basesExec, TEST_JS };
