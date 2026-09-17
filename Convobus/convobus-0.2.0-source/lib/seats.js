'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { withStateLock, writeSeatsFile, readSeatsFile } = require('./store');
const { SEATS: HANDLES } = require('./catalog');

const HANDLE_MAP = new Map(HANDLES.map((h) => [h.handle, h]));

function which(bin) {
  if (!bin) return null;
  if (bin.includes('/')) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(':').filter(Boolean);
  const extra = path.join(os.homedir(), '.local', 'bin');
  if (!dirs.includes(extra)) dirs.push(extra);
  for (const dir of dirs) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

function appExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function rolesIncomplete(roles) {
  return !(roles && roles.composer && roles.send);
}

function applyFragile(row, def, old) {
  if (row.state === 'missing' || def.kind !== 'app') return;
  const incomplete = rolesIncomplete(old.roles) && rolesIncomplete(row.roles);
  if (def.method === 'ax' || old.fragile || old.roles) {
    if (incomplete) {
      row.fragile = true;
      row.note = 'fragile';
    }
  }
}

function discover(root) {
  return withStateLock(root, () => {
    const prev = readSeatsFile(root);
    const prevByHandle = new Map();
    if (prev && Array.isArray(prev.seats)) {
      for (const s of prev.seats) prevByHandle.set(s.handle, s);
    }
    const seats = HANDLES.map((def) => {
      const old = prevByHandle.get(def.handle) || {};
      const row = {
        ...old,
        handle: def.handle,
        kind: def.kind,
        binary: def.binary,
        surface: def.surface,
        method: def.method,
        state: 'open',
        path: null,
        process: def.process || null,
        fragile: false,
        lastReplyAt: old.lastReplyAt || null,
        roles: old.roles || null,
        note: null,
        cwd: old.cwd || null,
      };

      if (def.handle === 'stdio' || def.handle === 'human') {
        row.state = old.lastReplyAt ? 'ready' : 'open';
        row.path = 'stdin/stdout';
        return row;
      }

      if (def.kind === 'cli') {
        const p = which(def.binary);
        row.path = p;
        if (!p) {
          row.state = 'missing';
          row.note = 'missing';
        } else {
          row.state = old.lastReplyAt ? 'ready' : 'open';
        }
        return row;
      }

      const appPath = (def.apps || []).find(appExists) || null;
      row.path = appPath;
      if (def.binary) row.binPath = which(def.binary);
      if (!appPath) {
        row.state = 'missing';
        row.note = 'missing';
        return row;
      }
      row.state = old.lastReplyAt ? 'ready' : 'open';
      applyFragile(row, def, old);
      if (def.handle === 'claude-app' && !row.binPath && !row.note) row.note = 'open';
      return row;
    });

    const data = { ...(prev && typeof prev === 'object' ? prev : {}), updated: new Date().toISOString(), seats };
    writeSeatsFile(root, data);
    return data;
  });
}

function loadSeats(root) {
  const cached = readSeatsFile(root);
  if (cached && Array.isArray(cached.seats) && cached.seats.length === HANDLES.length) {
    const names = cached.seats.map((s) => s.handle);
    const known = names.every((h) => HANDLE_MAP.has(h));
    const complete = HANDLES.every((h) => names.includes(h.handle));
    if (known && complete) return cached;
  }
  return discover(root);
}

function getSeat(root, handle) {
  const data = loadSeats(root);
  return (data.seats || []).find((s) => s.handle === handle) || null;
}

function markSeatReply(root, handle) {
  return withStateLock(root, () => {
    const data = loadSeats(root);
    const seat = (data.seats || []).find((s) => s.handle === handle);
    if (!seat) return data;
    seat.lastReplyAt = new Date().toISOString();
    if (seat.state !== 'missing') seat.state = 'ready';
    writeSeatsFile(root, data);
    return data;
  });
}

function markSeatRoles(root, handle, roles, fragile) {
  return withStateLock(root, () => {
    const data = loadSeats(root);
    const seat = (data.seats || []).find((s) => s.handle === handle);
    if (!seat) return data;
    seat.roles = roles || null;
    seat.fragile = !!fragile;
    seat.note = fragile ? 'fragile' : seat.note === 'fragile' ? null : seat.note;
    writeSeatsFile(root, data);
    return data;
  });
}

function defaultMethod(handle) {
  const def = HANDLE_MAP.get(handle);
  return def ? def.method : null;
}

function needsCwd(handle) {
  return handle && handle !== 'stdio' && handle !== 'human' && HANDLE_MAP.has(handle);
}

function bindSeat(root, handle, cwd) {
  const raw = cwd == null || cwd === true ? '' : String(cwd).trim();
  const resolved = raw ? path.resolve(raw) : null;
  if (resolved) {
    let st = null;
    try { st = fs.statSync(resolved); } catch { st = null; }
    if (!st || !st.isDirectory()) {
      return { ok: false, code: 2, text: 'stop — empty directory\n', seat: null };
    }
  }
  return withStateLock(root, () => {
    const data = loadSeats(root);
    const seat = (data.seats || []).find((s) => s.handle === handle);
    if (!seat) {
      return { ok: false, code: 2, text: 'stop — seat not in seats\n', seat: null };
    }
    seat.cwd = resolved;
    writeSeatsFile(root, data);
    return { ok: true, code: 0, seat, text: JSON.stringify(seat, null, 2) + '\n' };
  });
}

function boundCwd(root, handle, explicit) {
  if (explicit != null && String(explicit).trim() !== '') return path.resolve(String(explicit).trim());
  const seat = getSeat(root, handle);
  if (seat && seat.cwd) return seat.cwd;
  return null;
}

function formatSeats(data) {
  const rows = data.seats || [];
  const lines = rows.map((s) => {
    const bits = [s.handle, s.kind, s.method, s.state === 'missing' ? 'missing' : s.state];
    if (s.note === 'fragile' || s.fragile) bits.push('fragile');
    if (s.state === 'missing') bits.push('missing');
    else if (s.path) bits.push(s.path);
    return bits.join('  ');
  });
  return lines.join('\n') + (lines.length ? '\n' : '');
}

module.exports = {
  HANDLES,
  HANDLE_MAP,
  which,
  discover,
  loadSeats,
  getSeat,
  markSeatReply,
  markSeatRoles,
  defaultMethod,
  formatSeats,
  needsCwd,
  bindSeat,
  boundCwd,
};
