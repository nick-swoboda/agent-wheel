'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const READY_LINE = 'convobus ready';
const MAX_READY_SCAN_BYTES = 8 * 1024 * 1024;
const UUID_NEAR_READY_BYTES = 4000;
const CURSOR_SELECTION_CACHE = new Map();

function boundedTail(file, limit = MAX_READY_SCAN_BYTES) {
  const st = fs.statSync(file);
  const len = Math.min(st.size, limit);
  const start = Math.max(0, st.size - len);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return { buf, start, size: st.size };
  } finally {
    fs.closeSync(fd);
  }
}

function fileContainsReady(file) {
  if (!file || !fs.existsSync(file)) return false;
  let fd;
  try {
    const st = fs.statSync(file);
    if (!st.size) return false;
    const { buf } = boundedTail(file);
    const utf8 = buf.toString('utf8').toLowerCase();
    if (utf8.includes(READY_LINE) || utf8.includes('convobus readiness')) return true;
    const latin = buf.toString('latin1').toLowerCase();
    return latin.includes(READY_LINE) || latin.includes('convobus readiness');
  } catch {
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function pickNewestPreferReady(files) {
  const list = [];
  for (const f of files || []) {
    if (f) list.push(f);
  }
  const withReady = [];
  for (const f of list) {
    if (fileContainsReady(f)) withReady.push(f);
  }
  const pool = withReady.length ? withReady : list;
  const file = newestJsonlAmong(pool);
  let why = null;
  if (file && withReady.length) {
    why =
      'newest file containing "' +
      READY_LINE +
      '" (' +
      withReady.length +
      ' of ' +
      list.length +
      ' matching)';
  } else if (file) {
    why =
      'newest matching file (' +
      list.length +
      ' matching, none contain "' +
      READY_LINE +
      '")';
  }
  return {
    file,
    why,
    ready: withReady.length > 0,
    matched: list.length,
    readyCount: withReady.length,
  };
}

function contentToText(content) {
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (!Array.isArray(content)) return null;
  const texts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === 'string' && block.trim()) texts.push(block);
    else if (block.text) texts.push(String(block.text));
  }
  return texts.length ? texts.join('\n').trim() : null;
}

function extractAssistantText(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : null;
  if (payload) {
    if (typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim()) {
      return payload.last_agent_message.trim();
    }
    if (payload.role === 'assistant') {
      const t = contentToText(payload.content);
      if (t) return t;
    }
    if (payload.item && payload.item.type === 'AgentMessage') {
      const t = contentToText(payload.item.content);
      if (t) return t;
    }
  }

  const type = obj.type;
  const msg = obj.message && typeof obj.message === 'object' ? obj.message : obj;
  const role = msg.role || obj.role;
  if (type && type !== 'assistant' && role !== 'assistant') return null;
  if (role && role !== 'assistant' && type !== 'assistant') return null;
  if (type !== 'assistant' && role !== 'assistant') return null;
  const fromContent = contentToText(msg.content);
  if (fromContent) return fromContent;
  if (typeof obj.text === 'string' && obj.text.trim() && role === 'assistant') {
    return obj.text.trim();
  }
  return null;
}

function snapshotFile(file) {
  if (!file || !fs.existsSync(file)) {
    return { file: file || null, size: 0, mtimeMs: 0, lines: 0, exists: false };
  }
  const st = fs.statSync(file);
  return {
    file,
    size: st.size,
    mtimeMs: st.mtimeMs,
    lines: 0,
    exists: true,
  };
}

function assistantsInText(text) {
  let last = null;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const t = extractAssistantText(JSON.parse(line));
      if (t) last = t;
    } catch {
      /* skip */
    }
  }
  return last;
}

function lastAssistantFromJsonl(file) {
  if (!file || !fs.existsSync(file)) return null;
  return assistantsInText(fs.readFileSync(file, 'utf8'));
}

function claudeRespondedIn(text) {
  let last = null;
  const re = /Claude responded:\s*([^\n\r]+)/gi;
  let m;
  while ((m = re.exec(String(text)))) {
    const t = String(m[1] || '').trim();
    if (t) last = t;
  }
  return last;
}

function assistantsInBlob(buf) {
  if (!buf || !buf.length) return null;
  const texts = [buf.toString('utf8'), buf.toString('utf16le')];
  let last = null;
  for (const text of texts) {
    const said = claudeRespondedIn(text);
    if (said) last = said;
    const lined = assistantsInText(text);
    if (lined) last = lined;
    const re = /\{[^{}]{0,12000}\}/g;
    let m;
    while ((m = re.exec(text))) {
      try {
        const t = extractAssistantText(JSON.parse(m[0]));
        if (t) last = t;
      } catch {
        /* skip */
      }
    }
  }
  return last;
}

function bytesAfterSnapshot(file, snap) {
  if (!file || !fs.existsSync(file) || !snap) return null;
  const st = fs.statSync(file);
  const start = Math.min(Number(snap.size) || 0, st.size);
  if (st.size <= start) return null;
  const len = st.size - start;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function readAfterSnapshot(file, snap) {
  const buf = bytesAfterSnapshot(file, snap);
  if (!buf) return null;
  return claudeRespondedIn(buf.toString('utf8')) || assistantsInText(buf.toString('utf8')) || assistantsInBlob(buf);
}

function assistantForSessionBytes(buf, sessionId) {
  if (!buf || !buf.length || !sessionId) return null;
  const id = String(sessionId);
  let last = null;
  for (const text of [buf.toString('utf8'), buf.toString('utf16le'), buf.toString('latin1')]) {
    let index = text.indexOf(id);
    while (index >= 0) {
      const window = text.slice(Math.max(0, index - 65536), Math.min(text.length, index + id.length + 65536));
      const reply = claudeRespondedIn(window) || assistantsInText(window) || assistantsInBlob(Buffer.from(window));
      if (reply) last = reply;
      index = text.indexOf(id, index + id.length);
    }
  }
  return last;
}

function walkJsonl(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkJsonl(p, acc);
    else if (ent.name.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

function encodeClaudeProject(cwd) {
  const abs = path.resolve(cwd);
  return abs.replace(/\//g, '-');
}

function claudeProjectEncodings(cwd) {
  const slash = encodeClaudeProject(cwd);
  const spaces = slash.replace(/ /g, '-');
  return [...new Set([slash, spaces])];
}

function newestJsonlAmong(files) {
  let best = null;
  let bestM = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs >= bestM) {
        bestM = st.mtimeMs;
        best = f;
      }
    } catch {
      /* skip */
    }
  }
  return best;
}

function claudeJsonlFiles(home, cwd) {
  const projects = path.join(home || os.homedir(), '.claude', 'projects');
  const files = [];
  if (!cwd) return walkJsonl(projects, files);
  for (const enc of claudeProjectEncodings(cwd)) {
    walkJsonl(path.join(projects, enc), files);
  }
  return files;
}

function newestClaudeJsonl(home, cwd) {
  return pickNewestPreferReady(claudeJsonlFiles(home, cwd)).file;
}

function claudeLookPlaces(home, cwd) {
  const h = home || os.homedir();
  const projects = path.join(h, '.claude', 'projects');
  const as = path.join(h, 'Library', 'Application Support', 'Claude');
  const places = [];
  if (cwd) {
    for (const enc of claudeProjectEncodings(cwd)) {
      places.push(path.join(projects, enc));
    }
  } else {
    places.push(projects);
  }
  places.push(path.join(as, 'claude-code-sessions'));
  places.push(path.join(as, 'local-agent-mode-sessions'));
  places.push(path.join(as, 'claude_desktop_config.json'));
  places.push(path.join(as, 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb'));
  places.push(path.join(as, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob'));
  places.push(path.join(as, 'Local Storage', 'leveldb'));
  places.push(path.join(as, 'Session Storage'));
  places.push(path.join(h, 'Library', 'Caches', 'com.anthropic.claudefordesktop'));
  places.push(path.join(h, '.claude.json'));
  places.push(path.join(h, '.claude', 'sessions'));
  places.push(path.join(h, '.claude', 'history.jsonl'));
  return places;
}

function extractChatUuidNearReady(file) {
  if (!file || !fs.existsSync(file)) return null;
  let buf;
  try {
    const st = fs.statSync(file);
    if (!st.size) return null;
    buf = boundedTail(file).buf;
  } catch {
    return null;
  }
  const latin = buf.toString('latin1');
  const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const needles = ['convobus readiness', READY_LINE];
  let best = null;
  let bestDist = Infinity;
  const lower = latin.toLowerCase();
  for (const needle of needles) {
    let needleIndex = lower.indexOf(needle);
    while (needleIndex >= 0) {
      let m;
      const local = new RegExp(re.source, 'gi');
      while ((m = local.exec(latin))) {
        const dist = Math.abs(m.index - needleIndex);
        if (dist < bestDist) {
          bestDist = dist;
          best = m[0];
        }
      }
      const near = latin.slice(
        Math.max(0, needleIndex - UUID_NEAR_READY_BYTES),
        Math.min(latin.length, needleIndex + needle.length + UUID_NEAR_READY_BYTES),
      );
      const named = near.match(/["']uuid["']\s*[:=]?\s*["']([0-9a-f-]{36})["']/i);
      if (named && re.test(named[1])) return named[1];
      needleIndex = lower.indexOf(needle, needleIndex + needle.length);
    }
  }
  if (best && bestDist < UUID_NEAR_READY_BYTES) return best;
  return null;
}

function findClaudePlainChat(home, opts) {
  const o = opts || {};
  const skip = new Set((o.skipIds || []).map(String));
  const h = home || os.homedir();
  const as = path.join(h, 'Library', 'Application Support', 'Claude');
  const files = [];
  walkNamed(path.join(as, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob'), files, (n) => n !== '.DS_Store' && n !== 'LOCK', 0);
  walkNamed(path.join(as, 'Local Storage', 'leveldb'), files, (n) => n.endsWith('.log') || n.endsWith('.ldb'), 0);
  walkNamed(path.join(as, 'Session Storage'), files, (n) => n.endsWith('.log') || n.endsWith('.ldb'), 0);
  const picked = pickNewestPreferReady(files);
  if (!picked.file) return null;
  const id = extractChatUuidNearReady(picked.file);
  if (!id || skip.has(id)) return null;
  return {
    file: picked.file,
    id,
    kind: 'chat',
    why:
      'newest claude.ai chat-store file containing "' +
      READY_LINE +
      '" / Convobus readiness (' +
      picked.readyCount +
      ' of ' +
      picked.matched +
      ' matching)',
  };
}

function claudeLiveSessions(home, cwd) {
  const dir = path.join(home || os.homedir(), '.claude', 'sessions');
  const want = cwd ? path.resolve(cwd) : null;
  const hits = [];
  if (!fs.existsSync(dir)) return hits;
  let ents;
  try {
    ents = fs.readdirSync(dir);
  } catch {
    return hits;
  }
  for (const name of ents) {
    if (!name.endsWith('.json')) continue;
    const f = path.join(dir, name);
    let o;
    try {
      o = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    const c = o.cwd ? path.resolve(String(o.cwd)) : null;
    if (want && c !== want) continue;
    hits.push({
      file: f,
      id: o.sessionId || o.id || null,
      cwd: c,
      pid: o.pid || null,
      entrypoint: o.entrypoint || null,
    });
  }
  return hits;
}

function walkNamed(dir, acc, pred, depth) {
  if (!dir || depth > 8 || !fs.existsSync(dir)) return acc;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkNamed(p, acc, pred, depth + 1);
    else if (pred(ent.name)) acc.push(p);
  }
  return acc;
}

function folderPaths(folders) {
  const list = Array.isArray(folders) ? folders : [];
  const out = [];
  for (const f of list) {
    const p = typeof f === 'string' ? f : f && f.path;
    if (p) out.push(path.resolve(String(p)));
  }
  return out;
}

function findClaudeCodeLocal(home, cwd) {
  const want = path.resolve(cwd);
  const as = path.join(home, 'Library', 'Application Support', 'Claude');
  const files = [];
  walkNamed(path.join(as, 'claude-code-sessions'), files, (n) => n.startsWith('local_') && n.endsWith('.json'), 0);
  walkNamed(path.join(as, 'local-agent-mode-sessions'), files, (n) => n.startsWith('local_') && n.endsWith('.json'), 0);
  let best = null;
  let bestM = 0;
  for (const f of files) {
    let o;
    try {
      o = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    const c = o.cwd || o.originCwd;
    if (!c || path.resolve(String(c)) !== want) continue;
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs >= bestM) {
        bestM = st.mtimeMs;
        best = o;
      }
    } catch {
      best = o;
    }
  }
  return best;
}

function findClaudeMaps(home, cwd) {
  const want = path.resolve(cwd);
  const as = path.join(home, 'Library', 'Application Support', 'Claude');
  const files = [];
  walkNamed(
    path.join(as, 'local-agent-mode-sessions'),
    files,
    (n) => n === 'spaces.json' || n === 'remote-session-spaces.json',
    0,
  );
  let spaceId = null;
  let sessionId = null;
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (Array.isArray(data.spaces)) {
      for (const s of data.spaces) {
        if (folderPaths(s.folders).includes(want)) spaceId = s.id || spaceId;
      }
    }
    if (Array.isArray(data.entries)) {
      for (const e of data.entries) {
        if (folderPaths(e.folders).includes(want)) {
          sessionId = e.sessionId || sessionId;
          spaceId = e.spaceId || spaceId;
        }
      }
    }
  }
  const cfgPath = path.join(as, 'claude_desktop_config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const grants = cfg && cfg.preferences && cfg.preferences.remoteSessionFolderGrants;
    if (grants && typeof grants === 'object') {
      for (const [sid, folders] of Object.entries(grants)) {
        if (folderPaths(folders).includes(want)) sessionId = sessionId || sid;
      }
    }
  } catch {
    /* skip */
  }
  if (!sessionId && !spaceId) return null;
  return { sessionId, spaceId };
}

function newestLeveldbLog(dir) {
  if (!fs.existsSync(dir)) return null;
  let ents;
  try {
    ents = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  let bestM = 0;
  for (const name of ents) {
    if ((!name.endsWith('.log') && !name.endsWith('.ldb')) || name === 'LOG' || name === 'LOG.old') continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs >= bestM) {
        bestM = st.mtimeMs;
        best = p;
      }
    } catch {
      /* skip */
    }
  }
  return best;
}

function existingClaudeSession(home, cwd, opts) {
  const o = opts || {};
  const variant = o.variant || null;
  const preferCowork = !!o.preferCowork;
  const skip = new Set((o.skipIds || []).map(String));
  const h = home || os.homedir();
  const looked = claudeLookPlaces(h, cwd);
  if (!cwd) {
    const picked = pickNewestPreferReady(claudeJsonlFiles(h));
    return { file: picked.file, id: null, looked, why: picked.why };
  }
  const want = path.resolve(cwd);
  if (variant === 'chat') {
    const chat = findClaudePlainChat(h, { skipIds: [...skip] });
    if (!chat || !chat.id || skip.has(String(chat.id))) {
      return { file: null, id: null, looked, cwd: want };
    }
    return {
      file: chat.file,
      id: chat.id,
      looked,
      kind: 'chat',
      cwd: want,
      why: chat.why,
    };
  }
  const jsonlAll = claudeJsonlFiles(h, want).filter((f) => !skip.has(path.basename(f, '.jsonl')));
  const picked = pickNewestPreferReady(jsonlAll);
  const file = picked.file;
  const local = findClaudeCodeLocal(h, want);
  let mapped = findClaudeMaps(h, want);
  if (mapped && mapped.sessionId && skip.has(String(mapped.sessionId))) mapped = null;
  if (variant === 'cowork') {
    if (!mapped || !mapped.sessionId) return { file: null, id: null, looked, cwd: want };
    const idb = newestLeveldbLog(claudeIdbDir(h));
    let why = 'cowork/Application Support map for cwd';
    if (idb && fileContainsReady(idb)) {
      why = 'cowork/Application Support map for cwd; newest file containing "' + READY_LINE + '"';
    }
    return {
      file: idb || null,
      id: mapped.sessionId,
      looked,
      kind: 'cloud',
      cwd: want,
      why,
    };
  }
  let id = null;
  if (file) {
    const meta = peekSessionMeta(file);
    if (meta && meta.id) id = meta.id;
    else id = path.basename(file, '.jsonl');
  }
  const live = claudeLiveSessions(h, want);
  if (!id && local) id = local.cliSessionId || local.sessionId || null;
  if (!id && mapped && !variant) id = mapped.sessionId || null;
  if (preferCowork && mapped && mapped.sessionId && !file) {
    const idb = newestLeveldbLog(claudeIdbDir(h));
    let why = 'cowork/Application Support map for cwd';
    if (idb && fileContainsReady(idb)) {
      why =
        'cowork/Application Support map for cwd; newest file containing "' + READY_LINE + '"';
    }
    return {
      file: idb || null,
      id: mapped.sessionId,
      looked,
      kind: 'cloud',
      cwd: want,
      why,
    };
  }
  if (!file && live.length) {
    const readyLive = [];
    for (const row of live) {
      if (!row.id || skip.has(String(row.id))) continue;
      const sidFile = claudeJsonlFiles(h, want).find((p) => path.basename(p, '.jsonl') === String(row.id));
      if (sidFile) {
        if (fileContainsReady(sidFile)) readyLive.push({ row, sidFile });
        else if (!readyLive.length) readyLive.push({ row, sidFile });
      }
    }
    const chosen = readyLive.find((x) => fileContainsReady(x.sidFile)) || readyLive[0];
    if (chosen && chosen.sidFile) {
      return {
        file: chosen.sidFile,
        id: chosen.row.id,
        looked,
        kind: 'jsonl',
        cwd: want,
        why: fileContainsReady(chosen.sidFile)
          ? 'live ~/.claude/sessions row for cwd; file contains "' + READY_LINE + '"'
          : 'live ~/.claude/sessions row for cwd',
      };
    }
  }
  if (file && !(id && skip.has(String(id)))) {
    return { file, id, looked, kind: 'jsonl', cwd: want, why: picked.why };
  }
  if (variant === 'claude-code' || variant === 'claude-cli') {
    if (local && (local.cliSessionId || local.sessionId) && !skip.has(String(local.cliSessionId || local.sessionId))) {
      return {
        file: null,
        id: local.cliSessionId || local.sessionId,
        looked,
        kind: 'code',
        cwd: want,
        why: 'claude-code-sessions map for cwd',
      };
    }
    return { file: null, id: null, looked, cwd: want };
  }
  const chat = findClaudePlainChat(h, { skipIds: [...skip] });
  if (chat && chat.id && !skip.has(String(chat.id))) {
    return {
      file: chat.file,
      id: chat.id,
      looked,
      kind: 'chat',
      cwd: want,
      why: chat.why,
    };
  }
  if (local && (local.cliSessionId || local.sessionId) && !skip.has(String(local.cliSessionId || local.sessionId))) {
    return {
      file: null,
      id: local.cliSessionId || local.sessionId,
      looked,
      kind: 'code',
      cwd: want,
      why: 'claude-code-sessions map for cwd',
    };
  }
  if (mapped && mapped.sessionId) {
    const idb = newestLeveldbLog(
      path.join(h, 'Library', 'Application Support', 'Claude', 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb'),
    );
    return {
      file: idb || null,
      id: mapped.sessionId,
      looked,
      kind: 'cloud',
      cwd: want,
      why: 'cowork/Application Support map for cwd',
    };
  }
  return { file: null, id: null, looked, cwd: want };
}

function claudeIdbDir(home) {
  return path.join(
    home || os.homedir(),
    'Library',
    'Application Support',
    'Claude',
    'IndexedDB',
    'https_claude.ai_0.indexeddb.leveldb',
  );
}

function snapshotClaudeIdb(home, sessionId) {
  const dir = claudeIdbDir(home);
  const files = {};
  if (!fs.existsSync(dir)) return { dir, files, matched: false, sessionId: sessionId || null };
  let ents;
  try {
    ents = fs.readdirSync(dir);
  } catch {
    return { dir, files, matched: false, sessionId: sessionId || null };
  }
  for (const name of ents) {
    if ((!name.endsWith('.log') && !name.endsWith('.ldb')) || name === 'LOG' || name === 'LOG.old') continue;
    const f = path.join(dir, name);
    files[f] = snapshotFile(f);
  }
  return { dir, files, matched: Object.keys(files).length > 0, sessionId: sessionId || null };
}

function readAfterClaudeIdb(snap) {
  if (!snap || !snap.dir || !fs.existsSync(snap.dir)) return null;
  let ents;
  try {
    ents = fs.readdirSync(snap.dir);
  } catch {
    return null;
  }
  let last = null;
  for (const name of ents) {
    if ((!name.endsWith('.log') && !name.endsWith('.ldb')) || name === 'LOG' || name === 'LOG.old') continue;
    const f = path.join(snap.dir, name);
    const before = snap.files && snap.files[f];
    if (before) {
      const bytes = bytesAfterSnapshot(f, before);
      const t = snap.sessionId
        ? assistantForSessionBytes(bytes, snap.sessionId)
        : readAfterSnapshot(f, before);
      if (t) last = t;
      continue;
    }
    try {
      const buf = fs.readFileSync(f);
      const t = snap.sessionId
        ? assistantForSessionBytes(buf, snap.sessionId)
        : claudeRespondedIn(buf.toString('utf8')) || assistantsInBlob(buf);
      if (t) last = t;
    } catch {
      /* skip */
    }
  }
  return last;
}

function snapshotClaudeProjects(home, cwd, opts) {
  const o = opts || {};
  const h = home || os.homedir();
  const want = cwd ? path.resolve(cwd) : null;
  const files = {};
  let matched = false;
  const exactFile = o.sessionFile ? path.resolve(o.sessionFile) : null;
  if (exactFile && fs.existsSync(exactFile)) {
    files[exactFile] = snapshotFile(exactFile);
    matched = true;
  } else if (want) {
    for (const enc of claudeProjectEncodings(want)) {
      const dir = path.join(h, '.claude', 'projects', enc);
      for (const f of walkJsonl(dir, [])) {
        files[f] = snapshotFile(f);
        matched = true;
      }
    }
  }
  return {
    dir: path.join(h, '.claude', 'projects'),
    files,
    matched,
    cwd: want,
    sessionFile: exactFile,
    sessionId: o.sessionId || null,
  };
}

function readAfterClaudeSnapshot(snap, home, sessionId) {
  if (!snap || !snap.cwd) return null;
  if (snap.sessionFile) {
    const before = snap.files && snap.files[snap.sessionFile];
    return before ? readAfterSnapshot(snap.sessionFile, before) : null;
  }
  const h = home || os.homedir();
  let last = null;
  for (const enc of claudeProjectEncodings(snap.cwd)) {
    const dir = path.join(h, '.claude', 'projects', enc);
    for (const f of walkJsonl(dir, [])) {
      const before = snap.files && snap.files[f];
      if (before) {
        const t = readAfterSnapshot(f, before);
        if (t) last = t;
        continue;
      }
      const meta = peekSessionMeta(f);
      const sid = meta && meta.id;
      if (sessionId && sid && String(sid) !== String(sessionId) && !/^(session_|cse_)/i.test(String(sessionId))) {
        continue;
      }
      const t = lastAssistantFromJsonl(f);
      if (t) last = t;
    }
  }
  return last;
}

function cursorProjectEncodings(cwd) {
  const abs = path.resolve(cwd);
  const noLead = abs.replace(/^\//, '').replace(/\//g, '-');
  const slash = abs.replace(/\//g, '-');
  return [...new Set([noLead, noLead.replace(/ /g, '-'), slash, slash.replace(/ /g, '-')])];
}

function cursorLookPlaces(home, cwd) {
  const h = home || os.homedir();
  const root = path.join(h, '.cursor', 'projects');
  const places = [];
  if (cwd) {
    for (const enc of cursorProjectEncodings(cwd)) {
      places.push(path.join(root, enc, 'agent-transcripts'));
      places.push(path.join(root, enc));
    }
  } else {
    places.push(root);
  }
  return places;
}

function newestCursorJsonl(home, cwd) {
  const h = home || os.homedir();
  const files = [];
  if (!cwd) return newestJsonlAmong(walkJsonl(path.join(h, '.cursor', 'projects'), files));
  for (const enc of cursorProjectEncodings(cwd)) {
    const root = path.join(h, '.cursor', 'projects', enc);
    walkJsonl(path.join(root, 'agent-transcripts'), files);
    walkJsonl(root, files);
  }
  return newestJsonlAmong(files);
}

function cursorSelectedAgentId(home) {
  const h = home || os.homedir();
  const db = path.join(h, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(db)) return null;
  try {
    const stat = fs.statSync(db);
    const cacheKey = path.resolve(db);
    const cached = CURSOR_SELECTION_CACHE.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
    const originalEmitWarning = process.emitWarning;
    let DatabaseSync;
    try {
      process.emitWarning = () => {};
      ({ DatabaseSync } = require('node:sqlite'));
    } finally {
      process.emitWarning = originalEmitWarning;
    }
    const connection = new DatabaseSync(db, { readOnly: true, allowExtension: false });
    let raw = '';
    try {
      const row = connection
        .prepare('select value from ItemTable where key = ?')
        .get('cursor/glass.selectedAgent');
      raw = row && row.value != null ? String(row.value).trim() : '';
    } finally {
      connection.close();
    }
    if (raw.startsWith('"')) {
      try {
        const decoded = JSON.parse(raw);
        if (typeof decoded === 'string') raw = decoded.trim();
      } catch {
        /* retain the raw stored value */
      }
    }
    const value = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
      ? raw
      : null;
    CURSOR_SELECTION_CACHE.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    return null;
  }
}

function existingCursorSession(home, cwd) {
  const h = home || os.homedir();
  const looked = cursorLookPlaces(h, cwd);
  if (!cwd) return { file: newestCursorJsonl(h), id: null, looked };
  const want = path.resolve(cwd);
  const files = [];
  for (const enc of cursorProjectEncodings(want)) {
    const root = path.join(h, '.cursor', 'projects', enc);
    walkJsonl(path.join(root, 'agent-transcripts'), files);
    walkJsonl(root, files);
  }
  const selected = cursorSelectedAgentId(h);
  const picked = pickNewestPreferReady(files);
  let file = null;
  let why = picked.why;
  if (picked.ready) {
    file = picked.file;
  } else if (selected) {
    file = files.find((f) => path.basename(f, '.jsonl') === selected) || picked.file;
    if (file && path.basename(file, '.jsonl') === selected) why = 'cursor selected agent';
  } else {
    file = picked.file;
  }
  if (!file) return { file: null, id: null, looked, cwd: want };
  const id = path.basename(file, '.jsonl');
  return { file, id, looked, kind: 'cursor', cwd: want, why };
}

function grokProjectEncodings(cwd) {
  const abs = path.resolve(cwd);
  const pct = encodeURIComponent(abs);
  const plus = pct.replace(/%20/g, '+');
  return [...new Set([pct, plus])];
}

function grokLookPlaces(home, cwd) {
  const h = home || os.homedir();
  const root = path.join(h, '.grok', 'sessions');
  const places = [];
  if (cwd) {
    for (const enc of grokProjectEncodings(cwd)) places.push(path.join(root, enc));
  } else {
    places.push(root);
  }
  return places;
}

function existingGrokSession(home, cwd) {
  const h = home || os.homedir();
  const looked = grokLookPlaces(h, cwd);
  if (!cwd) return { file: null, id: null, looked };
  const want = path.resolve(cwd);
  const files = [];
  for (const enc of grokProjectEncodings(want)) {
    const dir = path.join(h, '.grok', 'sessions', enc);
    if (!fs.existsSync(dir)) continue;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const hist = path.join(dir, ent.name, 'chat_history.jsonl');
      if (fs.existsSync(hist)) files.push(hist);
    }
  }
  const picked = pickNewestPreferReady(files);
  if (!picked.file) return { file: null, id: null, looked, cwd: want };
  const id = path.basename(path.dirname(picked.file));
  return { file: picked.file, id, looked, kind: 'grok', cwd: want, why: picked.why };
}

function chatgptLookPlaces(home) {
  const h = home || os.homedir();
  return [
    path.join(h, '.codex', 'sessions'),
    path.join(h, 'Library', 'Application Support', 'com.openai.chat'),
    path.join(h, 'Library', 'Group Containers', 'group.com.openai.chat'),
  ];
}

function resolveVendorSession(seat, cwd, home, opts) {
  const h = home || os.homedir();
  if (seat === 'chatgpt-app' || seat === 'chatgpt-cli') {
    const looked = chatgptLookPlaces(h);
    const sess = existingCodexSession(h, cwd);
    if (!sess) return { file: null, id: null, looked, cwd: cwd ? path.resolve(cwd) : null };
    return {
      file: sess.file,
      id: sess.id,
      looked,
      cwd: sess.cwd,
      kind: 'codex',
      why: sess.why || null,
    };
  }
  if (seat === 'claude-app') {
    return existingClaudeSession(h, cwd, {
      preferCowork: !(opts && opts.variant),
      variant: opts && opts.variant,
      skipIds: opts && opts.skipIds,
    });
  }
  if (seat === 'claude-cli') {
    return existingClaudeSession(h, cwd, {
      variant: opts && opts.variant,
      skipIds: opts && opts.skipIds,
    });
  }
  if (seat === 'cursor-app' || seat === 'cursor-cli') {
    return existingCursorSession(h, cwd);
  }
  if (seat === 'grok-cli') {
    return existingGrokSession(h, cwd);
  }
  return { file: null, id: null, looked: [], cwd: cwd ? path.resolve(cwd) : null };
}

function formatMissing(looked) {
  const lines = ['missing'];
  for (const p of looked || []) lines.push(p);
  return lines.join('\n') + '\n';
}

function peekSessionMeta(file) {
  let fd;
  try {
    const st = fs.statSync(file);
    if (!st.size) return null;
    fd = fs.openSync(file, 'r');
    let acc = '';
    let pos = 0;
    const buf = Buffer.alloc(64 * 1024);
    while (pos < st.size && acc.length < 1024 * 1024) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      acc += buf.toString('utf8', 0, n);
      const nl = acc.indexOf('\n');
      if (nl < 0) continue;
      const o = JSON.parse(acc.slice(0, nl));
      const payload = o.payload && typeof o.payload === 'object' ? o.payload : o;
      const cwd = payload.cwd ? path.resolve(String(payload.cwd)) : o.cwd ? path.resolve(String(o.cwd)) : null;
      const id = payload.session_id || payload.sessionId || payload.id || o.sessionId || o.session_id || null;
      return { cwd, id: id ? String(id) : null };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function peekSessionCwd(file) {
  const meta = peekSessionMeta(file);
  return meta && meta.cwd ? meta.cwd : null;
}

function existingCodexSession(home, cwd) {
  const snap = snapshotCodexSessions(home, { cwd, attachOnly: true });
  if (!snap.matched) return null;
  const picked = pickNewestPreferReady(Object.keys(snap.files));
  const best = picked.file;
  if (!best) return null;
  const meta = peekSessionMeta(best);
  if (!meta || !meta.id) return null;
  return { file: best, id: meta.id, cwd: meta.cwd, why: picked.why };
}

function snapshotCodexSessions(home, opts) {
  const o = opts || {};
  const dir = path.join(home || os.homedir(), '.codex', 'sessions');
  const want = o.cwd ? path.resolve(o.cwd) : null;
  const exactFile = o.sessionFile ? path.resolve(o.sessionFile) : null;
  const files = exactFile && fs.existsSync(exactFile) ? [exactFile] : walkJsonl(dir, []);
  const snaps = {};
  let matched = false;
  for (const f of files) {
    if (want) {
      const sc = peekSessionCwd(f);
      if (sc !== want) continue;
    }
    snaps[f] = snapshotFile(f);
    matched = true;
  }
  return { dir, files: snaps, matched, cwd: want, sessionFile: exactFile };
}

function readAfterCodexSnapshot(snap, home) {
  if (!snap) return null;
  if (snap.sessionFile) {
    const before = snap.files && snap.files[snap.sessionFile];
    return before ? readAfterSnapshot(snap.sessionFile, before) : null;
  }
  const dir = (snap && snap.dir) || path.join(home || os.homedir(), '.codex', 'sessions');
  const want = snap.cwd || null;
  const files = walkJsonl(dir, []);
  let last = null;
  for (const f of files) {
    if (want) {
      const sc = peekSessionCwd(f);
      if (sc !== want) continue;
    }
    const before = snap.files && snap.files[f];
    if (!before) continue;
    const t = readAfterSnapshot(f, before);
    if (t) last = t;
  }
  return last;
}

function readFileWins(card, opts) {
  const o = opts || {};
  const file = o.sessionFile || o.file;
  if (o.snapshot) {
    const target = file || o.snapshot.file;
    return readAfterSnapshot(target, o.snapshot);
  }
  if (file) return lastAssistantFromJsonl(file);
  if (card && (card.seat === 'claude-app' || o.kind === 'claude-jsonl')) {
    const newest = newestClaudeJsonl(o.home);
    if (newest) return lastAssistantFromJsonl(newest);
  }
  return null;
}

module.exports = {
  READY_LINE,
  MAX_READY_SCAN_BYTES,
  UUID_NEAR_READY_BYTES,
  extractAssistantText,
  extractChatUuidNearReady,
  lastAssistantFromJsonl,
  newestClaudeJsonl,
  encodeClaudeProject,
  claudeProjectEncodings,
  snapshotFile,
  readAfterSnapshot,
  readFileWins,
  snapshotCodexSessions,
  readAfterCodexSnapshot,
  existingCodexSession,
  existingClaudeSession,
  existingCursorSession,
  cursorSelectedAgentId,
  existingGrokSession,
  cursorProjectEncodings,
  grokProjectEncodings,
  resolveVendorSession,
  snapshotClaudeProjects,
  readAfterClaudeSnapshot,
  snapshotClaudeIdb,
  readAfterClaudeIdb,
  claudeRespondedIn,
  peekSessionMeta,
  formatMissing,
  claudeLookPlaces,
  chatgptLookPlaces,
  fileContainsReady,
  pickNewestPreferReady,
};
