'use strict';

const { parseMaybeCard, isTrustedMethod, isCardState } = require('./card');
const { loadSeats, HANDLE_MAP, needsCwd } = require('./seats');
const { liveCards, readSeatsFile } = require('./store');
const {
  loadGraph,
  hasPlan,
  isLeaf,
  nothingBuilt,
  constraintReason,
  namedNodes,
  unresolvedKebabs,
  claimHeld,
} = require('./graph');

const MAX_LINES = 6;
const TRUSTED = new Set(['stdio', 'applescript', 'ax']);

function capLines(lines) {
  const sliced = lines.slice(0, MAX_LINES);
  return sliced.join('\n') + (sliced.length ? '\n' : '');
}

function emptyish(v) {
  return v == null || String(v).trim() === '';
}

function planFindings(graph, message) {
  const lines = [];
  const named = namedNodes(graph, message);

  const constraints = named.filter((n) => n.kind === 'constraint');
  if (constraints.length) {
    const n = constraints[0];
    lines.push(`stop — ${n.id} is a constraint`);
    const reason = constraintReason(n);
    if (reason) lines.push(`       already ruled out — ${reason}`);
    else lines.push('       already ruled out');
    return lines;
  }

  if (claimHeld(message)) {
    for (const n of named) {
      if (n.try && n.try.verb !== 'done') {
        lines.push(`stop — you claim ${n.id} held`);
        lines.push('       redo');
        return lines;
      }
    }
  }

  const held = named.filter(
    (n) => n.kind !== 'constraint' && n.state !== 'open' && (!n.try || n.try.verb === 'done'),
  );
  if (held.length) {
    const n = held[0];
    lines.push(`stop — ${n.id} is held`);
    lines.push('       redo');
    return lines;
  }

  const unresolved = unresolvedKebabs(graph, message);
  if (unresolved.length) {
    lines.push(`stop — ${unresolved[0]} is not a node`);
    lines.push('       unresolved');
    return lines;
  }

  const novel = named.filter(
    (n) => isLeaf(n) && nothingBuilt(n) && n.kind !== 'constraint',
  );
  if (novel.length) {
    lines.push(`stop — ${novel[0].id} is a leaf with no try`);
    lines.push('       the novel part');
    return lines;
  }

  return null;
}

function appDumpHeld(card, message, seats) {
  if (!card || !card.seat) return null;
  if (!claimHeld(message)) return null;
  const row = (seats || []).find((s) => s.handle === card.seat);
  const isApp = card.seat.endsWith('-app') || (row && row.kind === 'app');
  if (!isApp) return null;
  const roles = row && row.roles;
  const composer = roles && roles.composer;
  if (!composer) {
    return [
      'stop — you claim the app seat held',
      '       dump has not returned a composer role',
    ];
  }
  return null;
}

/**
 * Bus layer always, plan layer if plan/ exists.
 * direction: 'body' | 'reply'
 */
function checkCard(input, ctx) {
  const lines = [];
  try {
    const context = ctx || {};
    const direction = context.direction === 'reply' ? 'reply' : 'body';
    const root = context.root;
    let seats = context.seats;
    if (!seats && root) {
      const file = readSeatsFile(root);
      if (file && file.seats) seats = file.seats;
      else seats = loadSeats(root).seats;
    }
    seats = seats || [];
    const inflight = context.inflight || (root ? liveCards(root) : []);

    let card = context.card || null;
    let message = '';
    if (input && typeof input === 'object' && !Array.isArray(input) && (input.seat || input.body != null || input.reply != null || input.id || input.method)) {
      card = input;
    } else if (typeof input === 'string') {
      const parsed = parseMaybeCard(input);
      if (parsed) card = parsed;
      else message = input;
    } else if (input == null) {
      message = '';
    } else {
      message = String(input);
    }

    if (card) {
      message = direction === 'reply'
        ? (card.reply == null ? '' : String(card.reply))
        : (card.body == null ? '' : String(card.body));
    }

    if (direction === 'body') {
      if (emptyish(card ? card.body : message)) {
        return { text: capLines(['stop — empty body']), stop: true, code: 2, lines: ['stop — empty body'] };
      }
    } else if (emptyish(card ? card.reply : message)) {
      return { text: capLines(['stop — empty reply']), stop: true, code: 2, lines: ['stop — empty reply'] };
    }

    if (card) {
      if (card.seat != null && card.seat !== '') {
        if (!HANDLE_MAP.has(card.seat)) {
          return {
            text: capLines(['stop — seat not in seats']),
            stop: true,
            code: 2,
            lines: ['stop — seat not in seats'],
          };
        }
        if (card.state == null || card.state === '') {
          return {
            text: capLines(['stop — state missing']),
            stop: true,
            code: 2,
            lines: ['stop — state missing'],
          };
        }
        if (!isCardState(card.state)) {
          return {
            text: capLines(['stop — state invalid']),
            stop: true,
            code: 2,
            lines: ['stop — state invalid'],
          };
        }
      } else if (Object.prototype.hasOwnProperty.call(card, 'seat') && (card.seat == null || card.seat === '')) {
        return {
          text: capLines(['stop — seat not in seats']),
          stop: true,
          code: 2,
          lines: ['stop — seat not in seats'],
        };
      }

      if (card.method != null && card.method !== '') {
        if (!isTrustedMethod(card.method) && !TRUSTED.has(card.method)) {
          return {
            text: capLines(['stop — method not trusted']),
            stop: true,
            code: 2,
            lines: ['stop — method not trusted'],
          };
        }
      }

      if (card.seat) {
        const row = (seats || []).find((s) => s.handle === card.seat);
        if (row && row.state === 'missing') {
          return {
            text: capLines(['stop — seat missing']),
            stop: true,
            code: 2,
            lines: ['stop — seat missing'],
          };
        }
        if (needsCwd(card.seat)) {
          const dir = (card.cwd && String(card.cwd).trim()) || (row && row.cwd) || '';
          if (emptyish(dir)) {
            return {
              text: capLines(['stop — empty directory']),
              stop: true,
              code: 2,
              lines: ['stop — empty directory'],
            };
          }
        }
      }

      if (direction === 'body' && card.seat) {
        const others = inflight.filter(
          (c) =>
            c.seat === card.seat &&
            c.id !== card.id &&
            (c.state === 'out' || c.state === 'waiting'),
        );
        if (others.length) {
          return {
            text: capLines(['stop — seat already has a live card']),
            stop: true,
            code: 2,
            lines: ['stop — seat already has a live card'],
          };
        }
      }

      if (direction === 'reply') {
        const liveSeats = new Set(
          inflight.filter((c) => c.state === 'out' || c.state === 'waiting').map((c) => c.seat),
        );
        const missingId = card.id == null || card.id === '';
        if (liveSeats.size >= 2 && missingId) {
          return {
            text: capLines(['stop — inbound reply missing id']),
            stop: true,
            code: 2,
            lines: ['stop — inbound reply missing id'],
          };
        }
      }

      const dumpStop = appDumpHeld(card, message, seats);
      if (dumpStop) {
        return { text: capLines(dumpStop), stop: true, code: 2, lines: dumpStop.slice(0, MAX_LINES) };
      }
    }

    if (root && hasPlan(root)) {
      const graph = loadGraph(root);
      if (graph) {
        const plan = planFindings(graph, message);
        if (plan && plan.length) {
          return { text: capLines(plan), stop: true, code: 2, lines: plan.slice(0, MAX_LINES) };
        }
      }
    }

    const seat = (card && card.seat) || 'stdio';
    const state = (card && card.state) || (direction === 'reply' ? 'waiting' : 'out');
    lines.push(`ok — ${seat} · ${state} · nothing crosses`);
    return { text: capLines(lines), stop: false, code: 0, lines: lines.slice(0, MAX_LINES) };
  } catch (err) {
    return {
      text: capLines(['stop — checker died']),
      stop: true,
      code: 1,
      lines: ['stop — checker died'],
      error: err,
    };
  }
}

function checkMessage(root, message, opts) {
  const o = opts || {};
  return checkCard(message, {
    root,
    direction: o.direction || 'body',
    card: o.card,
  });
}

module.exports = {
  MAX_LINES,
  capLines,
  checkCard,
  checkMessage,
};
