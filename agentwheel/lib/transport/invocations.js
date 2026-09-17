"use strict";

const path = require('path');

const NO_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite,BashOutput,KillShell';
const SYSTEM_ARG_MAX = 96000;

const INVOCATIONS = {
  claude: {
    route: 'claude:cli',
    command: (cfg) => ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--max-turns', '4',
      '--model', (cfg && cfg.model) || 'sonnet',
      ...(cfg && cfg.effort ? ['--effort', cfg.effort] : []),
      '--disallowedTools', NO_TOOLS],
    prompt: { channel: 'stdin' },
    system: { channel: 'arg', flag: '--system-prompt', max_bytes: SYSTEM_ARG_MAX },
    unwrap: 'claude-stream-json',
  },
  codex: {
    route: 'chatgpt:codex',
    command: (cfg) => ['codex', 'exec', '--skip-git-repo-check', '-s', 'read-only', '--color', 'never', '--ephemeral',
      ...(cfg && cfg.model ? ['-m', cfg.model] : []),
      ...(cfg && cfg.effort ? ['-c', 'model_reasoning_effort=' + cfg.effort] : []), '-'],
    prompt: { channel: 'stdin' },
    system: null,
    unwrap: 'text',
  },
  grok: {
    route: 'grok:cli',
    command: (cfg) => ['grok', '--output-format', 'plain', '--max-turns', '12', '--verbatim',
      '--tools', 'todo_write', '--disallowed-tools', 'todo_write,Agent',
      '--no-subagents', '--disable-web-search', ...(cfg && cfg.model ? ['--model', cfg.model] : []),
      ...(cfg && cfg.effort ? ['--reasoning-effort', cfg.effort] : [])],
    prompt: { channel: 'file', flag: '--prompt-file' },
    system: { channel: 'arg', flag: '--system-prompt-override', max_bytes: SYSTEM_ARG_MAX },
    unwrap: 'text',
  },
  'cursor-agent': {
    route: 'cursor:cli',
    command: (cfg) => ['cursor-agent', '-p', '--output-format', 'text', '--trust',
      ...(cfg && cfg.model ? ['--model', cfg.model] : [])],
    prompt: { channel: 'stdin' },
    system: null,
    unwrap: 'text',
  },
};

const ROUTE_BINARY = Object.fromEntries(Object.entries(INVOCATIONS).map(([bin, inv]) => [inv.route, bin]));
const DEFAULT_CHANNELS = { prompt: { channel: 'stdin' }, system: null, unwrap: 'text' };

function commandForRoute(routeId, cfg) {
  const bin = ROUTE_BINARY[routeId];
  return bin ? INVOCATIONS[bin].command(cfg || {}) : null;
}

function channelsFor(argv0) {
  const inv = INVOCATIONS[path.basename(String(argv0 || ''))];
  return inv ? { prompt: inv.prompt, system: inv.system, unwrap: inv.unwrap } : DEFAULT_CHANNELS;
}

module.exports = {
  INVOCATIONS, NO_TOOLS, SYSTEM_ARG_MAX, commandForRoute, channelsFor,
  binaries: Object.keys(INVOCATIONS),
};
