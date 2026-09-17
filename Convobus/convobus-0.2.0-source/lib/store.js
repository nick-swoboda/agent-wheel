'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_DIR_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
const LOCK_WAIT_MS = 5000;
const STALE_LOCK_MS = 30000;
const LOCK_RETRY_MS = 20;
const KNOWN_PRIVATE_FILES = new Set([
  'seats.json',
  'inflight.json',
  'log.ndjson',
  'next.json',
  'prefs.json',
  'gate.json',
  'gui.port',
  'gui.json',
  'ax-last.json',
  'ax-payload.json',
  'loops.json',
  'loop-runs.json',
]);
const heldLocks = new Map();
const logCache = new Map();
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function convobusDir(root) {
  return path.join(path.resolve(root), '.convobus');
}

function paths(root) {
  const dir = convobusDir(root);
  return {
    dir,
    seats: path.join(dir, 'seats.json'),
    inflight: path.join(dir, 'inflight.json'),
    log: path.join(dir, 'log.ndjson'),
    next: path.join(dir, 'next.json'),
    loops: path.join(dir, 'loops.json'),
    loopRuns: path.join(dir, 'loop-runs.json'),
  };
}

function assertSafeNode(file, kind) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (st.isSymbolicLink()) {
    const err = new Error(`unsafe symlink at ${file}`);
    err.code = 'CONVO_UNSAFE_STATE';
    throw err;
  }
  if (kind === 'directory' && !st.isDirectory()) {
    const err = new Error(`state path is not a directory: ${file}`);
    err.code = 'CONVO_UNSAFE_STATE';
    throw err;
  }
  if (kind === 'file' && !st.isFile()) {
    const err = new Error(`state path is not a regular file: ${file}`);
    err.code = 'CONVO_UNSAFE_STATE';
    throw err;
  }
  return st;
}

function chmodIfNeeded(file, mode, st) {
  const current = st || assertSafeNode(file);
  if (!current) return;
  if ((current.mode & 0o777) !== mode) fs.chmodSync(file, mode);
}

function ensureDir(root) {
  const dir = convobusDir(root);
  const existing = assertSafeNode(dir, 'directory');
  if (!existing) fs.mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  chmodIfNeeded(dir, STATE_DIR_MODE, existing || assertSafeNode(dir, 'directory'));
  for (const name of KNOWN_PRIVATE_FILES) {
    const file = path.join(dir, name);
    const st = assertSafeNode(file, 'file');
    if (st) chmodIfNeeded(file, STATE_FILE_MODE, st);
  }
  return dir;
}

function stateRootForFile(file) {
  const dir = path.dirname(path.resolve(file));
  if (path.basename(dir) !== '.convobus') {
    throw new Error(`state file is outside .convobus: ${file}`);
  }
  return path.dirname(dir);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

function readLockOwner(lockFile) {
  try {
    const value = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function maybeReclaimStaleLock(lockFile) {
  const guardFile = `${lockFile}.reclaim`;
  let guardFd;
  try {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0);
    guardFd = fs.openSync(guardFile, flags, STATE_FILE_MODE);
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    const st = assertSafeNode(lockFile, 'file');
    if (!st || Date.now() - st.mtimeMs < STALE_LOCK_MS) return false;
    const owner = readLockOwner(lockFile);
    if (owner && processAlive(Number(owner.pid))) return false;
    const again = assertSafeNode(lockFile, 'file');
    if (!again || again.ino !== st.ino || again.dev !== st.dev || again.mtimeMs !== st.mtimeMs) return false;
    fs.unlinkSync(lockFile);
    return true;
  } finally {
    fs.closeSync(guardFd);
    try { fs.unlinkSync(guardFile); } catch { /* the next contender can retry */ }
  }
}

function acquireStateLock(root) {
  const canonicalRoot = path.resolve(root);
  const existing = heldLocks.get(canonicalRoot);
  if (existing) {
    existing.depth += 1;
    return existing;
  }
  const dir = ensureDir(canonicalRoot);
  const lockFile = path.join(dir, '.state.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = crypto.randomBytes(16).toString('hex');
  for (;;) {
    try {
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0);
      const fd = fs.openSync(lockFile, flags, STATE_FILE_MODE);
      const owner = JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }) + '\n';
      fs.writeFileSync(fd, owner, { encoding: 'utf8' });
      fs.fsyncSync(fd);
      const lock = { root: canonicalRoot, file: lockFile, fd, token, depth: 1 };
      heldLocks.set(canonicalRoot, lock);
      return lock;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      maybeReclaimStaleLock(lockFile);
      if (Date.now() >= deadline) {
        const busy = new Error('state busy');
        busy.code = 'CONVO_STATE_BUSY';
        throw busy;
      }
      Atomics.wait(sleepCell, 0, 0, LOCK_RETRY_MS);
    }
  }
}

function releaseStateLock(lock) {
  if (!lock) return;
  lock.depth -= 1;
  if (lock.depth > 0) return;
  heldLocks.delete(lock.root);
  try {
    fs.closeSync(lock.fd);
  } finally {
    try {
      const owner = readLockOwner(lock.file);
      if (owner && owner.token === lock.token && Number(owner.pid) === process.pid) fs.unlinkSync(lock.file);
    } catch {
      /* a future call will safely reclaim a stale owner */
    }
  }
}

function withStateLock(root, fn) {
  const lock = acquireStateLock(root);
  try {
    return fn();
  } finally {
    releaseStateLock(lock);
  }
}

function fsyncDirectory(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    /* durability is best effort on filesystems that reject directory fsync */
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function writePrivateTextUnlocked(file, text) {
  const root = stateRootForFile(file);
  const dir = ensureDir(root);
  assertSafeNode(file, 'file');
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let fd;
  try {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(temp, flags, STATE_FILE_MODE);
    const data = Buffer.from(String(text));
    let offset = 0;
    while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
    fs.chmodSync(file, STATE_FILE_MODE);
    fsyncDirectory(dir);
  } finally {
    if (fd != null) fs.closeSync(fd);
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {
      /* ignore only this operation's private temporary path */
    }
  }
}

function writeJsonUnlocked(file, obj) {
  writePrivateTextUnlocked(file, JSON.stringify(obj, null, 2) + '\n');
}

function writeJson(file, obj) {
  const root = stateRootForFile(file);
  return withStateLock(root, () => writeJsonUnlocked(file, obj));
}

function writePrivateText(file, text) {
  const root = stateRootForFile(file);
  return withStateLock(root, () => writePrivateTextUnlocked(file, text));
}

function createPrivateTemp(root, prefix, text) {
  return withStateLock(root, () => {
    const dir = ensureDir(root);
    const stem = String(prefix || 'state').replace(/[^a-z0-9_-]/gi, '-');
    const file = path.join(dir, `.${stem}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(file, flags, STATE_FILE_MODE);
    try {
      const data = Buffer.from(String(text));
      let offset = 0;
      while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return file;
  });
}

function removePrivateFileUnlocked(file) {
  const root = stateRootForFile(file);
  const st = assertSafeNode(file, 'file');
  if (!st) return false;
  fs.unlinkSync(file);
  fsyncDirectory(convobusDir(root));
  return true;
}

function removePrivateFile(file) {
  const root = stateRootForFile(file);
  return withStateLock(root, () => removePrivateFileUnlocked(file));
}

function readJson(file, fallback) {
  const st = assertSafeNode(file, 'file');
  if (!st) return fallback;
  chmodIfNeeded(file, STATE_FILE_MODE, st);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function readSeatsFile(root) {
  return readJson(paths(root).seats, null);
}

function writeSeatsFile(root, data) {
  ensureDir(root);
  writeJson(paths(root).seats, data);
}

function readInflight(root) {
  const data = readJson(paths(root).inflight, { cards: [] });
  if (Array.isArray(data)) return data;
  return Array.isArray(data.cards) ? data.cards : [];
}

function readInflightDocument(root) {
  const data = readJson(paths(root).inflight, { cards: [] });
  if (Array.isArray(data)) return { cards: data };
  return data && typeof data === 'object' ? data : { cards: [] };
}

function writeInflight(root, cards) {
  return withStateLock(root, () => {
    ensureDir(root);
    const document = readInflightDocument(root);
    writeJsonUnlocked(paths(root).inflight, { ...document, cards });
  });
}

function upsertInflight(root, card) {
  return withStateLock(root, () => {
    const document = readInflightDocument(root);
    const cards = (Array.isArray(document.cards) ? document.cards : []).filter((c) => c.id !== card.id);
    cards.push(card);
    writeJsonUnlocked(paths(root).inflight, { ...document, cards });
    return cards;
  });
}

function reserveInflight(root, card) {
  return withStateLock(root, () => {
    const document = readInflightDocument(root);
    const cards = Array.isArray(document.cards) ? document.cards : [];
    const conflict = cards.find(
      (candidate) =>
        candidate.id !== card.id &&
        candidate.seat === card.seat &&
        (candidate.state === 'out' || candidate.state === 'waiting'),
    );
    if (conflict) return { ok: false, conflict, cards };
    const next = cards.filter((candidate) => candidate.id !== card.id);
    next.push(card);
    writeJsonUnlocked(paths(root).inflight, { ...document, cards: next });
    return { ok: true, cards: next };
  });
}

function removeInflight(root, id) {
  return withStateLock(root, () => {
    const document = readInflightDocument(root);
    const cards = (Array.isArray(document.cards) ? document.cards : []).filter((c) => c.id !== id);
    writeJsonUnlocked(paths(root).inflight, { ...document, cards });
    return cards;
  });
}

function findInflight(root, id) {
  if (!id) return null;
  return readInflight(root).find((c) => c.id === id) || null;
}

function liveCards(root) {
  return readInflight(root).filter((c) => c.state === 'out' || c.state === 'waiting');
}

function liveForSeat(root, seat, exceptId) {
  return liveCards(root).filter((c) => c.seat === seat && c.id !== exceptId);
}

function readNext(root) {
  try {
    return readJson(paths(root).next, null);
  } catch {
    return null;
  }
}

function writeNext(root, card) {
  ensureDir(root);
  writeJson(paths(root).next, card);
  return card;
}

function appendLogUnlocked(root, event) {
  const dir = ensureDir(root);
  const file = paths(root).log;
  assertSafeNode(file, 'file');
  const rec = Object.assign({ t: new Date().toISOString() }, event);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND |
    (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags, STATE_FILE_MODE);
  try {
    const data = Buffer.from(JSON.stringify(rec) + '\n');
    let offset = 0;
    while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, STATE_FILE_MODE);
  fsyncDirectory(dir);
  return rec;
}

function appendLog(root, event) {
  return withStateLock(root, () => appendLogUnlocked(root, event));
}

function readLog(root) {
  const file = paths(root).log;
  const st = assertSafeNode(file, 'file');
  if (!st) {
    logCache.delete(file);
    return [];
  }
  chmodIfNeeded(file, STATE_FILE_MODE, st);
  let cached = logCache.get(file);
  if (
    cached && cached.dev === st.dev && cached.ino === st.ino &&
    cached.size === st.size && cached.mtimeMs === st.mtimeMs
  ) return cached.records.slice();

  let raw;
  let records;
  let remainder;
  if (cached && cached.dev === st.dev && cached.ino === st.ino && st.size > cached.size) {
    const length = st.size - cached.size;
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, cached.size);
      raw = cached.remainder + buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    records = cached.records.slice();
    if (cached.remainderWasRecord) records.pop();
  } else {
    raw = fs.readFileSync(file, 'utf8');
    records = [];
  }
  const lines = raw.split('\n');
  remainder = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      records.push({ event: 'broken', raw: line });
    }
  }
  let remainderWasRecord = false;
  if (remainder.trim()) {
    try {
      records.push(JSON.parse(remainder));
      remainderWasRecord = true;
    } catch {
      remainderWasRecord = false;
    }
  }
  cached = {
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    remainder,
    remainderWasRecord,
    records,
  };
  logCache.set(file, cached);
  return records.slice();
}

function logRevision(root) {
  const file = paths(root).log;
  const st = assertSafeNode(file, 'file');
  return st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}` : 'missing';
}

function stateRevision(root) {
  const state = paths(root);
  const files = [
    state.log,
    state.seats,
    state.inflight,
    state.next,
    path.join(state.dir, 'prefs.json'),
    path.join(state.dir, 'gate.json'),
    state.loops,
    state.loopRuns,
  ];
  return files.map((file) => {
    const st = assertSafeNode(file, 'file');
    return st ? `${path.basename(file)}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}` : `${path.basename(file)}:missing`;
  }).join('|');
}

function nextTurnNumber(root) {
  return withStateLock(root, () => readLog(root).filter((e) => e.event === 'deliver').length + 1);
}

function appendLogWithTurn(root, event) {
  return withStateLock(root, () => {
    const turn = readLog(root).filter((e) => e.event === 'deliver').length + 1;
    const record = appendLogUnlocked(root, { ...event, turn });
    return { turn, record };
  });
}

module.exports = {
  STATE_DIR_MODE,
  STATE_FILE_MODE,
  LOCK_WAIT_MS,
  STALE_LOCK_MS,
  convobusDir,
  paths,
  ensureDir,
  withStateLock,
  writePrivateText,
  createPrivateTemp,
  removePrivateFile,
  writeJson,
  readJson,
  readSeatsFile,
  writeSeatsFile,
  readInflight,
  writeInflight,
  upsertInflight,
  reserveInflight,
  removeInflight,
  findInflight,
  liveCards,
  liveForSeat,
  readNext,
  writeNext,
  appendLog,
  appendLogWithTurn,
  readLog,
  logRevision,
  stateRevision,
  nextTurnNumber,
};
