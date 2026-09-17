'use strict';

const fs = require('fs');
const path = require('path');

const HEARTBEAT_MS = 5000;
const STALE_MS = 30000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return Boolean(err && err.code === 'EPERM'); }
}

function read(pp) {
  try { return JSON.parse(fs.readFileSync(pp.leasePath, 'utf8')); } catch { return null; }
}

function writeAtomic(record, pp) {
  fs.mkdirSync(pp.dir, { recursive: true });
  const tmp = path.join(pp.dir, `.lease.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, pp.leasePath);
}

function inspect(nowTs, pp) {
  const lease = read(pp);
  if (!lease) return { present: false, interrupted: false };
  const alive = pidAlive(lease.pid) && lease.pid !== process.pid ? true : pidAlive(lease.pid);
  const ageMs = Date.parse(nowTs) - Date.parse(lease.heartbeat || lease.started || 0);
  const stale = !(ageMs >= 0 && ageMs <= STALE_MS);
  return {
    present: true,
    instance: lease.instance,
    pid: lease.pid,
    started: lease.started,
    heartbeat: lease.heartbeat,
    age_ms: ageMs,
    alive,
    stale,
    interrupted: !alive || stale,
  };
}

function acquire(instance, ts, pp) {
  writeAtomic({ instance, pid: process.pid, started: ts, heartbeat: ts }, pp);
}

function heartbeat(instance, ts, pp) {
  const lease = read(pp);
  if (!lease || lease.instance !== instance) return false;
  writeAtomic({ ...lease, heartbeat: ts }, pp);
  return true;
}

// Releases only this helper's own lease (normal shutdown).
function release(instance, pp) {
  const lease = read(pp);
  if (lease && lease.instance === instance) {
    try { fs.unlinkSync(pp.leasePath); } catch {}
    return true;
  }
  return false;
}

function releaseByHumanGate(meta, pp) {
  if (!meta || meta.gate !== 'RECOVERY_REQUIRED') {
    throw new Error('a stale lease is released only by the human RECOVERY_REQUIRED gate action');
  }
  const lease = read(pp);
  if (!lease) return false;
  try { fs.unlinkSync(pp.leasePath); } catch {}
  return true;
}

module.exports = {
  HEARTBEAT_MS, STALE_MS, read, inspect, acquire, heartbeat, release, releaseByHumanGate, pidAlive,
};
