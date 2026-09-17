'use strict';

const crypto = require('crypto');

let lastMs = 0;
let counter = 0;

function uuidv7(nowMs) {
  let ms;
  if (nowMs != null) {
    ms = Number(nowMs);
    counter = crypto.randomBytes(2).readUInt16BE(0) & 0xfff;
  } else {
    ms = Date.now();
    if (ms <= lastMs) {
      ms = lastMs;
      counter = (counter + 1) & 0xfff;
      if (counter === 0) ms = lastMs + 1;
    } else {
      counter = crypto.randomBytes(2).readUInt16BE(0) & 0x7ff;
    }
    lastMs = ms;
  }
  const buf = Buffer.alloc(16);
  buf.writeUIntBE(ms, 0, 6);
  buf.writeUInt16BE(0x7000 | counter, 6);
  crypto.randomFillSync(buf, 8, 8);
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isUuidv7(value) {
  return typeof value === 'string' && UUID_V7_RE.test(value);
}

function uuidv7Time(id) {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

function turnId(n) {
  return 't_' + n;
}

function branchId(n) {
  return 'b_' + n;
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = { uuidv7, isUuidv7, uuidv7Time, UUID_V7_RE, turnId, branchId, nowIso, sha256 };
