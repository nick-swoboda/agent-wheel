'use strict';

const fs = require('fs');
const path = require('path');
const { parseMaybeCard } = require('./card');
const {
  ensureDir,
  liveCards,
  readLog,
} = require('./store');
const { discover, loadSeats, formatSeats, bindSeat } = require('./seats');
const { checkCard } = require('./check');
const { runTurn, runLoop, cmdNext, cmdReply, cmdStage } = require('./turn');
const { startGui } = require('./gui');

const USAGE = `convobus — one chat in the middle
  convobus seats [--json]
  convobus bind --seat HANDLE --cwd DIR
  convobus loop [--seat HANDLE] [--to HANDLE] [--from HANDLE] [--turns N] [--body TEXT] [--body2 TEXT] -- argv...
  convobus inflight
  convobus reply [--id ID] [--stdin]
  convobus next [--seat HANDLE] [--method stdio|applescript|ax] [--from HANDLE] [--body TEXT] [--stdin]
  convobus check [message] | convobus check --stdin [--reply]
  convobus stage [--id ID] [--reply TEXT] [--file-wins] [--session-file PATH]
  convobus turn [--seat HANDLE] [--method METHOD] [--from HANDLE] [--body TEXT] [--cwd DIR] [--id ID] [--file-wins] -- argv...
  convobus gui [--port N]
A send is [[seat::<handle>]] by [[method::stdio|applescript|ax]].
`;

function requireNode22() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 22) {
    process.stderr.write(`convobus requires Node 22 or newer, got ${process.version}\n`);
    process.exit(2);
  }
}

function refuseWindows() {
  if (process.platform === 'win32') {
    process.stderr.write('convobus is macOS only\n');
    process.exit(2);
  }
}

function camel(k) {
  return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function stripGlobalRoot(argv) {
  const out = argv.slice(0, 2);
  let root = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (a === '--root' && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      root = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--root=')) {
      root = a.slice('--root='.length);
    } else {
      out.push(a);
    }
  }
  return { argv: out, root };
}

function parseArgv(argv) {
  const stripped = stripGlobalRoot(argv);
  argv = stripped.argv;
  const args = argv.slice(2);
  const cmd = args[0];
  const flags = {};
  if (stripped.root) flags.root = stripped.root;
  const positional = [];
  const dash = args.indexOf('--');
  const head = dash >= 0 ? args.slice(0, dash) : args;
  const argvRest = dash >= 0 ? args.slice(dash + 1) : [];
  const main = head.slice(1);
  for (let i = 0; i < main.length; i++) {
    const a = main[i];
    if (a === '--stdin') flags.stdin = true;
    else if (a === '--reply') {
      if (cmd === 'check') {
        flags.reply = true;
      } else {
        const n = main[i + 1];
        if (n && !n.startsWith('-')) {
          flags.reply = n;
          i += 1;
        } else flags.reply = true;
      }
    }
    else if (a === '--file-wins' || a === '--filewins') flags.fileWins = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--gui') flags.gui = true;
    else if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      flags[camel(a.slice(2, eq))] = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      const key = camel(a.slice(2));
      const n = main[i + 1];
      if (n && !n.startsWith('-')) {
        flags[key] = n;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else positional.push(a);
  }
  return { cmd, flags, positional, argvRest };
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function resolveRoot(cwd, flags) {
  if (flags && flags.root) return path.resolve(flags.root);
  if (process.env.CONVO_ROOT) return path.resolve(process.env.CONVO_ROOT);
  return path.resolve(cwd || process.cwd());
}

function turnOpts(root, flags, positional, argvRest) {
  let body = flags.body;
  if (flags.stdin && (body == null || body === true)) body = readStdinSync();
  if (body == null && positional.length) body = positional.join(' ');
  const opts = {
    root,
    cwd: flags.cwd && flags.cwd !== true ? flags.cwd : undefined,
    seat: flags.seat,
    method: flags.method,
    methodExplicit: !!flags.method,
    from: flags.from,
    body,
    id: flags.id,
    fileWins: !!flags.fileWins,
    sessionFile: flags.sessionFile,
    sessionId: flags.sessionId || flags.resume,
    timeout: flags.timeout ? Number(flags.timeout) : undefined,
    argv: argvRest.length ? argvRest : undefined,
    encoding: flags.encoding,
    to: flags.to,
    turns: flags.turns != null ? Number(flags.turns) : undefined,
    body2: flags.body2,
    argvTo: flags.argvTo ? String(flags.argvTo).split(',') : undefined,
    useNext: !flags.seat && body == null,
  };
  return opts;
}

async function run(argv, { cwd } = {}) {
  refuseWindows();
  requireNode22();
  const { cmd, flags, positional, argvRest } = parseArgv(argv);
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(USAGE);
    return cmd ? 0 : 2;
  }

  const root = resolveRoot(cwd, flags);

  if (cmd === 'seats') {
    const data = discover(root);
    if (flags.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    else process.stdout.write(formatSeats(data));
    if (flags.gui) return startGui(root, flags.port ? Number(flags.port) : 7421);
    return 0;
  }

  if (cmd === 'inflight') {
    ensureDir(root);
    const cards = liveCards(root);
    if (flags.json) process.stdout.write(JSON.stringify({ cards }, null, 2) + '\n');
    else {
      if (!cards.length) process.stdout.write('(none)\n');
      else {
        for (const c of cards) {
          process.stdout.write(`${c.id}  ${c.seat}  ${c.state}  from ${c.from}\n`);
        }
      }
    }
    return 0;
  }

  if (cmd === 'check') {
    let raw;
    if (flags.stdin) raw = readStdinSync();
    else raw = positional.join(' ');
    const direction = flags.reply ? 'reply' : 'body';
    let input = raw;
    const parsed = parseMaybeCard(raw);
    if (parsed) input = parsed;
    else if (direction === 'reply') input = { reply: raw, body: 'x' };
    try {
      if (flags.die) throw new Error('forced');
      const r = checkCard(input, { root, direction, inflight: liveCards(root) });
      process.stdout.write(r.text);
      return r.code;
    } catch (err) {
      process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
      process.stdout.write('stop — checker died\n');
      return 1;
    }
  }

  if (cmd === 'next') {
    let body = flags.body;
    if (flags.stdin) body = readStdinSync();
    else if (body == null && positional.length) body = positional.join(' ');
    const r = cmdNext(root, {
      seat: flags.seat,
      method: flags.method,
      from: flags.from,
      body,
    });
    process.stdout.write(r.text);
    return r.code;
  }

  if (cmd === 'reply') {
    let raw = flags.stdin ? readStdinSync() : positional.join(' ');
    const parsed = parseMaybeCard(raw);
    const r = cmdReply(root, {
      id: flags.id || (parsed && parsed.id),
      reply: flags.replyText || (parsed && parsed.reply != null ? parsed.reply : parsed ? null : raw),
      inbound: parsed,
      raw: parsed || raw,
    });
    process.stdout.write(r.text);
    return r.code;
  }

  if (cmd === 'stage') {
    const r = cmdStage(root, {
      id: flags.id,
      reply: flags.reply === true ? undefined : flags.reply,
      fileWins: !!flags.fileWins,
      sessionFile: flags.sessionFile,
    });
    process.stdout.write(r.text);
    return r.code;
  }

  if (cmd === 'bind') {
    const r = bindSeat(root, flags.seat, flags.cwd);
    process.stdout.write(r.text);
    return r.code;
  }

  if (cmd === 'turn') {
    const opts = turnOpts(root, flags, positional, argvRest);
    const r = await runTurn(root, opts);
    process.stdout.write(r.text);
    return r.code;
  }

  if (cmd === 'loop') {
    const opts = turnOpts(root, flags, positional, argvRest);
    const r = await runLoop(root, opts);
    process.stdout.write(r.text);
    if (flags.gui) return startGui(root, flags.port ? Number(flags.port) : 7421);
    return r.code;
  }

  if (cmd === 'gui') {
    return startGui(root, flags.port ? Number(flags.port) : 7421);
  }

  if (cmd === 'log') {
    const recs = readLog(root);
    process.stdout.write(recs.map((e) => JSON.stringify(e)).join('\n') + (recs.length ? '\n' : ''));
    return 0;
  }

  process.stderr.write(`unknown command: ${cmd}\n${USAGE}`);
  return 2;
}

module.exports = {
  run,
  USAGE,
  parseArgv,
  resolveRoot,
  requireNode22,
  requireNode24: requireNode22,
  requireNode26: requireNode22,
  stripGlobalRoot,
};
