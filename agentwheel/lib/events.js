'use strict';

const { sha256 } = require('./ids');

function canonical(obj) {
  return JSON.stringify(obj);
}

function frame(event) {
  const body = { ...event };
  delete body.hash;
  const hash = sha256(canonical(body));
  return { line: canonical({ ...body, hash }), hash };
}

function parseEvents(text) {
  const events = [];
  let torn = null;
  const lines = String(text || '').split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    offset += Buffer.byteLength(line, 'utf8') + 1;
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch {
      torn = { index: i, reason: 'unparseable' };
      break;
    }
    if (!obj || typeof obj !== 'object' || typeof obj.hash !== 'string') {
      torn = { index: i, reason: 'not an event' };
      break;
    }
    const { hash, ...body } = obj;
    if (sha256(canonical(body)) !== hash) {
      torn = { index: i, reason: 'hash mismatch' };
      break;
    }
    if (obj.seq !== events.length + 1) {
      torn = { index: i, reason: `seq ${obj.seq} where ${events.length + 1} was expected` };
      break;
    }
    events.push(obj);
  }
  if (torn) {
    torn.trailing = lines.slice(torn.index + 1).filter((l) => l.trim()).length;
    torn.offset = lines.slice(0, torn.index).reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0);
  }
  return { events, torn };
}

module.exports = { frame, parseEvents, canonical };
