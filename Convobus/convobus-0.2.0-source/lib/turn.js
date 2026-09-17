'use strict';

const { makeCard, cloneCard, parseAddress } = require('./card');
const {
  ensureDir,
  withStateLock,
  upsertInflight,
  removeInflight,
  findInflight,
  readNext,
  writeNext,
  appendLog,
  appendLogWithTurn,
  liveCards,
  readLog,
} = require('./store');

function usedSessionIds(root, seat) {
  const ids = [];
  for (const rec of readLog(root) || []) {
    if (rec.event !== 'attach') continue;
    const recSeat = rec.card && rec.card.seat;
    if (seat && recSeat && recSeat !== seat) continue;
    const id = rec.sessionId ? String(rec.sessionId) : '';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ids.push(id);
  }
  return ids;
}

function routedEventForCard(root, id, event) {
  const log = readLog(root) || [];
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const rec = log[i];
    const recId = rec.id || (rec.card && rec.card.id);
    if (recId === id && rec.route) return { ...event, route: { ...rec.route } };
  }
  return event;
}
const { loadSeats, defaultMethod, markSeatReply, HANDLE_MAP, which, boundCwd } = require('./seats');
const { checkCard } = require('./check');
const { sendStdio, queueExistingCodex, resumeExistingCodex, queueExistingClaude, queueExistingCursor, ensureChatGPTAppUnfocused, ensureClaudeAppUnfocused, ensureCursorAppUnfocused, UUID_RE } = require('./methods/stdio');
const { sendApplescript } = require('./methods/applescript');
const { sendAx } = require('./methods/ax');
const {
  snapshotFile,
  readAfterSnapshot,
  snapshotCodexSessions,
  readAfterCodexSnapshot,
  existingCodexSession,
  existingClaudeSession,
  existingCursorSession,
  existingGrokSession,
  resolveVendorSession,
  snapshotClaudeProjects,
  readAfterClaudeSnapshot,
  snapshotClaudeIdb,
  readAfterClaudeIdb,
  formatMissing,
} = require('./methods/filewins');

function resolveIncomingCard(root, opts) {
  const o = opts || {};
  if (o.card && o.card.id) return cloneCard(o.card);
  if (o.id) {
    const found = findInflight(root, o.id);
    if (found) return cloneCard(found);
  }
  if (!o.fresh) {
    const next = readNext(root);
    if (next && (next.state === 'out' || next.state === 'waiting') && !o.seat && o.body == null) {
      return cloneCard(next);
    }
    if (next && (next.state === 'out' || next.state === 'waiting') && o.useNext) {
      return cloneCard(next);
    }
  }
  const body = o.body == null ? '' : String(o.body);
  const parsed = parseAddress(body);
  const seat = o.seat || parsed.seat || 'stdio';
  const method = o.method || parsed.method || defaultMethod(seat) || 'stdio';
  return makeCard({
    id: o.newId,
    seat,
    method,
    from: o.from || 'human',
    body,
    state: 'out',
    reply: null,
    cwd: o.cwd || null,
  });
}

async function dispatchSend(root, card, opts) {
  const o = Object.assign({}, opts, { root, cwd: opts.cwd || root });
  const selectedSession = o.sessionId || o.sessionFile
    ? {
        id: o.sessionId || null,
        file: o.sessionFile || null,
        kind: o.kind || null,
        looked: [],
        why: 'selected exact route',
      }
    : null;
  if (card.seat === 'human') {
    return { ok: true, reply: null, waitingHuman: true, method: card.method || 'stdio' };
  }

  let method = card.method;
  if ((card.seat === 'chatgpt-app' || card.seat === 'chatgpt-cli') && !(o.argv && o.argv.length)) {
    const sess = selectedSession || existingCodexSession(o.home, o.cwd);
    if (!sess || !sess.id) {
      return {
        ok: false,
        miss: true,
        reason: 'missing',
        method: 'stdio',
        looked: resolveVendorSession(card.seat, o.cwd, o.home, { variant: o.variant }).looked,
      };
    }
    card.method = 'stdio';
    if (card.seat === 'chatgpt-cli') {
      return queueExistingCodex(sess.id, card.body, o);
    }
    if (!o.suppressAppLaunch) await ensureChatGPTAppUnfocused();
    const resumed = await resumeExistingCodex(sess.id, card.body, o);
    if (resumed && !resumed.miss && (resumed.submitted || resumed.ok || (resumed.reply && String(resumed.reply).trim()))) {
      return resumed;
    }
    return queueExistingCodex(sess.id, card.body, o);
  }

  if (card.seat === 'cursor-app' && !(o.argv && o.argv.length)) {
    const sess = selectedSession || existingCursorSession(o.home, o.cwd);
    if (!sess || !sess.id) {
      return { ok: false, miss: true, reason: 'missing', method: 'stdio', looked: sess && sess.looked };
    }
    o.sessionId = sess.id;
    card.method = 'stdio';
    if (!o.suppressAppLaunch) await ensureCursorAppUnfocused();
    const queued = await queueExistingCursor(sess, card.body, o);
    queued.looked = sess.looked;
    return queued;
  }

  if (card.seat === 'cursor-cli' && !(o.argv && o.argv.length)) {
    const sess = selectedSession || existingCursorSession(o.home, o.cwd);
    if (!sess || !sess.id) {
      return { ok: false, miss: true, reason: 'missing', method: 'stdio', looked: sess && sess.looked };
    }
    o.sessionId = sess.id;
    card.method = 'stdio';
    const queued = await queueExistingCursor(sess, card.body, o);
    queued.looked = sess.looked;
    return queued;
  }

  if (card.seat === 'grok-cli' && !(o.argv && o.argv.length)) {
    const sess = selectedSession || existingGrokSession(o.home, o.cwd);
    if (!sess || !sess.id) {
      return { ok: false, miss: true, reason: 'missing', method: 'stdio', looked: sess && sess.looked };
    }
    o.sessionId = sess.id;
    card.method = 'stdio';
    return sendStdio(card, o);
  }

  if (card.seat === 'claude-cli' && !(o.argv && o.argv.length)) {
    const sess = selectedSession || existingClaudeSession(o.home, o.cwd, { variant: o.variant });
    if (!sess || !sess.id || !UUID_RE.test(String(sess.id))) {
      return { ok: false, miss: true, reason: 'missing', method: 'stdio', looked: sess && sess.looked };
    }
    o.sessionId = sess.id;
    card.method = 'stdio';
    return queueExistingClaude(sess, card.body, o);
  }

  if (card.seat === 'claude-app' && !(o.argv && o.argv.length) && !(o.methodExplicit && method === 'ax')) {
    const sess = selectedSession || existingClaudeSession(o.home, o.cwd, {
      preferCowork: !o.variant,
      variant: o.variant,
      skipIds: o.skipIds || [],
    });
    if (!sess || !sess.id) {
      return { ok: false, miss: true, reason: 'missing', method: 'stdio', looked: sess && sess.looked };
    }
    o.sessionId = sess.id;
    o.kind = sess.kind;
    card.method = 'stdio';
    if (sess.kind !== 'chat' && !o.suppressAppLaunch) await ensureClaudeAppUnfocused();
    return queueExistingClaude(sess, card.body, o);
  }

  if (method === 'stdio') return sendStdio(card, o);
  if (method === 'applescript') return sendApplescript(card, o);
  if (method === 'ax') {
    const def = HANDLE_MAP.get(card.seat);
    if (def && def.process) o.processName = o.processName || def.process;
    return sendAx(card, o);
  }
  return { ok: false, miss: true, reason: 'method not trusted' };
}

async function runTurn(root, opts) {
  const o = opts || {};
  if (!o.home) o.home = process.env.HOME || require('os').homedir();
  ensureDir(root);
  loadSeats(root);
  const eventMeta = o.eventMeta && typeof o.eventMeta === 'object' ? { ...o.eventMeta } : {};
  const decorate = (event) => ({
    ...event,
    ...eventMeta,
    ...(o.route ? { route: { ...o.route } } : {}),
  });
  const append = (event) => appendLog(root, decorate(event));

  const card = resolveIncomingCard(root, o);
  const persistNext = () => {
    if (o.writeNext !== false) writeNext(root, card);
  };
  if (!card.method) card.method = defaultMethod(card.seat) || 'stdio';
  if (card.seat === 'chatgpt-cli' && !o.methodExplicit) card.method = 'stdio';
  if (card.seat === 'chatgpt-app' && !o.methodExplicit) card.method = 'stdio';
  if (card.seat === 'chatgpt-chat-app' && !o.methodExplicit) card.method = 'ax';
  if (card.seat === 'chatgpt-modern-chat-app' && !o.methodExplicit) card.method = 'ax';
  if (card.seat === 'cursor-app' && !o.methodExplicit) card.method = 'stdio';
  if (card.seat === 'cursor-cli' && !o.methodExplicit) card.method = 'stdio';
  if (!card.from) card.from = 'human';
  if (!card.state) card.state = 'out';
  const bound = boundCwd(root, card.seat, o.cwd);
  if (bound) card.cwd = bound;

  const stateTransaction = withStateLock(root, () => {
    const checkBody = checkCard(card, { root, direction: 'body' });
    append({
      event: 'check',
      direction: 'body',
      id: card.id,
      check: { code: checkBody.code, stop: checkBody.stop, text: checkBody.text },
    });
    if (checkBody.stop) return { checkBody };

    card.state = 'waiting';
    upsertInflight(root, card);
    const deliver = { event: 'deliver', card: cloneCard(card) };
    const allocated = appendLogWithTurn(root, decorate(deliver));
    return { checkBody, allocated };
  });
  const { checkBody } = stateTransaction;
  if (checkBody.stop) {
    return {
      card,
      checkBody,
      gated: true,
      text: checkBody.text,
      code: checkBody.code,
    };
  }
  const turn = stateTransaction.allocated.turn;

  const sendCwd = card.cwd || o.cwd || root;
  o.cwd = sendCwd;
  const hasExplicitArgv = Array.isArray(o.argv) && o.argv.length > 0;

  let sessionFile = o.sessionFile || null;
  let resolved =
    o.route && (o.sessionFile || o.sessionId)
      ? {
          file: o.sessionFile || null,
          id: o.sessionId || null,
          kind: o.kind || null,
          why: 'selected route',
          looked: [],
        }
      : null;
  if (
    !resolved &&
    !sessionFile &&
    (card.seat === 'claude-app' ||
      card.seat === 'claude-cli' ||
      card.seat === 'cursor-app' ||
      card.seat === 'cursor-cli' ||
      card.seat === 'chatgpt-app' ||
      card.seat === 'chatgpt-cli' ||
      card.seat === 'grok-cli')
  ) {
    const skipIds = card.seat === 'claude-app' ? usedSessionIds(root, 'claude-app') : [];
    if (skipIds.length) o.skipIds = skipIds;
    resolved = resolveVendorSession(card.seat, sendCwd, o.home, {
      skipIds,
      variant: o.variant,
    });
    if (resolved && resolved.file) sessionFile = resolved.file;
    if (resolved && resolved.id) o.sessionId = o.sessionId || resolved.id;
  }
  if (
    !hasExplicitArgv &&
    (card.seat === 'claude-app' ||
      card.seat === 'cursor-app' ||
      card.seat === 'cursor-cli' ||
      card.seat === 'grok-cli' ||
      card.seat === 'claude-cli') &&
    !(sessionFile || (resolved && resolved.id) || o.sessionFile)
  ) {
    const looked = (resolved && resolved.looked) || [];
    append({
      event: 'miss',
      turn,
      id: card.id,
      method: card.method,
      reason: 'missing',
      looked,
      card: cloneCard(card),
    });
    persistNext();
    return { card, turn, text: formatMissing(looked), code: 2 };
  }
  if (o.fileWins && !sessionFile && card.seat !== 'claude-app') {
    append({ event: 'miss', turn, id: card.id, method: card.method, reason: 'missing', card: cloneCard(card) });
    persistNext();
    return { card, turn, text: 'missing\n', code: 2 };
  }
  if (sessionFile) o.sessionFile = sessionFile;
  const snap = sessionFile ? snapshotFile(sessionFile) : null;
  const claudeSnap =
    card.seat === 'claude-app' && (!o.variant || o.variant === 'claude-code')
      ? snapshotClaudeProjects(o.home, sendCwd, {
          sessionFile,
          sessionId: o.sessionId || (resolved && resolved.id) || null,
        })
      : null;
  const claudeIdbSnap =
    card.seat === 'claude-app' && (!o.variant || o.variant === 'cowork')
      ? snapshotClaudeIdb(o.home, o.sessionId || (resolved && resolved.id) || null)
      : null;
  const codexSnap =
    card.seat === 'chatgpt-app' || card.seat === 'chatgpt-cli'
      ? snapshotCodexSessions(o.home, { cwd: sendCwd, attachOnly: true, sessionFile })
      : null;
  if (
    (card.seat === 'chatgpt-app' || card.seat === 'chatgpt-cli') &&
    (!codexSnap || !codexSnap.matched) &&
    !(o.argv && o.argv.length)
  ) {
    const looked = resolveVendorSession(card.seat, sendCwd, o.home, { variant: o.variant }).looked;
    append({
      event: 'miss',
      turn,
      id: card.id,
      method: card.method,
      reason: 'missing',
      looked,
      card: cloneCard(card),
    });
    persistNext();
    return { card, turn, text: formatMissing(looked), code: 2 };
  }
  if ((resolved && (resolved.file || resolved.id)) || (o.route && o.kind)) {
    append({
      event: 'attach',
      turn,
      id: card.id,
      sessionFile: (resolved && resolved.file) || sessionFile || null,
      sessionId: (resolved && resolved.id) || o.sessionId || null,
      kind: (resolved && resolved.kind) || o.kind || null,
      why: (resolved && resolved.why) || (o.kind ? 'selected exact route' : null),
      looked: (resolved && resolved.looked) || [],
      card: cloneCard(card),
    });
  }

  const sent = await dispatchSend(root, card, o);
  append({
    event: sent.miss ? 'miss' : 'send',
    turn,
    id: card.id,
    method: sent.method || card.method,
    reason: sent.reason || null,
    card: cloneCard(card),
  });

  let reply = sent.reply || null;
  if (card.seat === 'claude-app' && (sent.method || card.method) !== 'ax') reply = null;
  if (reply && /^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(String(reply).trim())) reply = null;
  if (
    sessionFile && snap &&
    card.seat !== 'claude-app' &&
    card.seat !== 'chatgpt-app' &&
    card.seat !== 'chatgpt-cli'
  ) {
    let fw = readAfterSnapshot(sessionFile, snap);
    if (
      !fw &&
      (card.seat === 'cursor-app' ||
        card.seat === 'cursor-cli' ||
        card.seat === 'grok-cli' ||
        card.seat === 'claude-cli') &&
      !(reply && String(reply).trim())
    ) {
      for (let i = 0; !fw && i < 90; i++) {
        await new Promise((r) => setTimeout(r, 500));
        fw = readAfterSnapshot(sessionFile, snap);
      }
    }
    if (fw) reply = fw;
  }
  if (claudeSnap || claudeIdbSnap) {
    let fw = claudeSnap ? readAfterClaudeSnapshot(claudeSnap, o.home, o.sessionId) : null;
    if (!fw && claudeIdbSnap) fw = readAfterClaudeIdb(claudeIdbSnap);
    if (!fw && sessionFile && snap) fw = readAfterSnapshot(sessionFile, snap);
    const waitFile =
      !sent.miss && (card.seat === 'claude-app' || !(reply && String(reply).trim()));
    for (let i = 0; !fw && waitFile && i < 90; i++) {
      await new Promise((r) => setTimeout(r, 500));
      fw = claudeSnap ? readAfterClaudeSnapshot(claudeSnap, o.home, o.sessionId) : null;
      if (!fw && claudeIdbSnap) fw = readAfterClaudeIdb(claudeIdbSnap);
      if (!fw && sessionFile && snap) fw = readAfterSnapshot(sessionFile, snap);
    }
    if (fw) reply = fw;
  }
  if (codexSnap && codexSnap.matched) {
    let fw = readAfterCodexSnapshot(codexSnap, o.home);
    const waitFile = !(reply && String(reply).trim()) && !(o.argv && o.argv.length);
    for (let i = 0; !fw && waitFile && i < 90; i++) {
      await new Promise((r) => setTimeout(r, 500));
      fw = readAfterCodexSnapshot(codexSnap, o.home);
    }
    if (fw) reply = fw;
  }

  if (sent.submitted && (reply == null || String(reply).trim() === '')) {
    persistNext();
    return {
      card,
      checkBody,
      sent,
      turn,
      text: JSON.stringify(card, null, 2) + '\n',
      code: 2,
    };
  }

  if (reply != null && String(reply).trim() !== '') {
    card.reply = String(reply);
    append({ event: 'reply', turn, card: cloneCard(card) });
    const checkReply = checkCard(card, { root, direction: 'reply' });
    append({
      event: 'check',
      direction: 'reply',
      id: card.id,
      check: { code: checkReply.code, stop: checkReply.stop, text: checkReply.text },
    });
    if (checkReply.stop) {
      persistNext();
      return {
        card,
        checkBody,
        checkReply,
        sent,
        turn,
        text: checkReply.text,
        code: checkReply.code,
      };
    }
    card.state = 'back';
    removeInflight(root, card.id);
    append({ event: 'stage', turn, card: cloneCard(card) });
    markSeatReply(root, card.seat);
    persistNext();
    return {
      card,
      checkBody,
      checkReply,
      sent,
      turn,
      text: JSON.stringify(card, null, 2) + '\n',
      code: 0,
    };
  }

  persistNext();
  return {
    card,
    checkBody,
    sent,
    turn,
    text: JSON.stringify(card, null, 2) + '\n',
    code: sent.waitingHuman ? 0 : 2,
  };
}

async function runLoop(root, opts) {
  const o = opts || {};
  ensureDir(root);
  loadSeats(root);

  if (o.to) {
    const a = await runTurn(
      root,
      Object.assign({}, o, { seat: o.seat, from: o.from || o.seat, fresh: true }),
    );
    const b = await runTurn(
      root,
      Object.assign({}, o, {
        seat: o.to,
        from: a.card.seat,
        body: a.card.reply || '',
        fresh: true,
        id: undefined,
        card: undefined,
        argv: o.argvTo || o.argv,
        method: o.methodTo || o.method,
      }),
    );
    return {
      cards: [a.card, b.card],
      turns: [a, b],
      text: JSON.stringify({ a: a.card, b: b.card }, null, 2) + '\n',
      code: a.card.state === 'back' && b.card.state === 'back' ? 0 : 2,
    };
  }

  const n = o.turns == null ? 2 : Number(o.turns);
  const turns = [];
  let body = o.body;
  for (let i = 0; i < n; i++) {
    const bodyI =
      i === 0 ? body : o.body2 && i === 1 ? o.body2 : 'turn-' + (i + 1);
    const r = await runTurn(
      root,
      Object.assign({}, o, {
        body: bodyI,
        fresh: true,
        id: undefined,
        card: undefined,
      }),
    );
    turns.push(r);
    body = r.card.reply;
  }
  return {
    cards: turns.map((t) => t.card),
    turns,
    text: JSON.stringify(
      turns.map((t) => t.card),
      null,
      2,
    ) + '\n',
    code: turns.every((t) => t.card.state === 'back') ? 0 : 2,
  };
}

function cmdNext(root, opts) {
  const o = opts || {};
  ensureDir(root);
  loadSeats(root);
  const body = o.body == null ? '' : String(o.body);
  const parsed = parseAddress(body);
  const seat = o.seat || parsed.seat || 'stdio';
  const method = o.method || parsed.method || defaultMethod(seat) || 'stdio';
  const card = makeCard({
    seat,
    method,
    from: o.from || 'human',
    body,
    state: 'out',
    reply: null,
    cwd: boundCwd(root, seat, o.cwd),
  });
  return withStateLock(root, () => {
    const gated = checkCard(card, { root, direction: 'body' });
    if (gated.stop) {
      return { code: gated.code, text: gated.text, card, check: gated };
    }
    writeNext(root, card);
    upsertInflight(root, card);
    return { code: 0, text: JSON.stringify(card, null, 2) + '\n', card };
  });
}

function cmdReply(root, opts) {
  const o = opts || {};
  let card = o.id ? findInflight(root, o.id) : null;
  let inbound = o.inbound || null;
  if (!inbound && o.raw) inbound = o.raw;
  if (inbound && typeof inbound === 'object') {
    if (!card && inbound.id) card = findInflight(root, inbound.id);
    if (inbound.reply != null) o.reply = inbound.reply;
    if (inbound.id) o.id = inbound.id;
  }
  const live = liveCards(root);
  const liveSeats = new Set(live.map((c) => c.seat));
  if (liveSeats.size >= 2 && !(o.id || (inbound && inbound.id))) {
    const r = checkCard(
      { reply: o.reply || '', id: null, seat: 'stdio', method: 'stdio', state: 'waiting', body: 'x' },
      { root, direction: 'reply', inflight: live },
    );
    return { code: 2, text: r.text, card: null };
  }
  if (!card) {
    return { code: 2, text: 'stop — no inflight card\n' };
  }
  const reply = o.reply == null ? '' : String(o.reply);
  card.reply = reply;
  upsertInflight(root, card);
  appendLog(root, routedEventForCard(root, card.id, { event: 'reply', card: cloneCard(card) }));
  return { code: 0, text: JSON.stringify(card, null, 2) + '\n', card };
}

function cmdStage(root, opts) {
  const o = opts || {};
  let card = o.id ? findInflight(root, o.id) : readNext(root);
  if (!card) return { code: 2, text: 'stop — no card to stage\n' };
  if (card.body == null || String(card.body).trim() === '') {
    return { code: 2, text: 'stop — empty body\n', card };
  }
  if (o.snapshot && o.sessionFile) {
    const fw = readAfterSnapshot(o.sessionFile, o.snapshot);
    if (fw) card.reply = fw;
  }
  if (o.reply != null) card.reply = o.reply;
  const checkReply = checkCard(card, { root, direction: 'reply' });
  appendLog(root, routedEventForCard(root, card.id, {
    event: 'check',
    direction: 'reply',
    id: card.id,
    check: { code: checkReply.code, stop: checkReply.stop, text: checkReply.text },
  }));
  if (checkReply.stop) {
    return { code: checkReply.code, text: checkReply.text, card, checkReply };
  }
  if (card.reply == null || String(card.reply).trim() === '') {
    return { code: 2, text: checkReply.text, card, checkReply };
  }
  card.state = 'back';
  removeInflight(root, card.id);
  appendLog(root, routedEventForCard(root, card.id, { event: 'stage', card: cloneCard(card) }));
  markSeatReply(root, card.seat);
  writeNext(root, card);
  return { code: 0, text: JSON.stringify(card, null, 2) + '\n', card, checkReply };
}

module.exports = {
  resolveIncomingCard,
  dispatchSend,
  runTurn,
  runLoop,
  cmdNext,
  cmdReply,
  cmdStage,
  which,
};
