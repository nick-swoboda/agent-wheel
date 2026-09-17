#!/usr/bin/env node
'use strict';

const fs = require('fs');

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch {
  raw = '';
}

let body = String(raw).trim();
try {
  const o = JSON.parse(raw);
  if (o && typeof o === 'object' && o.body != null) body = String(o.body);
} catch {
  /* raw */
}

const text = 'after-mark:' + String(body).replace(/\s+/g, ' ').trim();
const file = process.argv[2];
if (file) {
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }) + '\n',
  );
}
process.stdout.write('stdout-only:' + String(body).replace(/\s+/g, ' ').trim() + '\n');
