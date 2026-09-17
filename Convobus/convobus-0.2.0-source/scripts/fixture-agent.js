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
  /* raw body */
}

process.stdout.write('fixture-reply:' + String(body).replace(/\s+/g, ' ').trim() + '\n');
