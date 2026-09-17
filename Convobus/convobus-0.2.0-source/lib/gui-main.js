#!/usr/bin/env node
'use strict';

const { startGui } = require('./gui');

const args = process.argv.slice(2);
let root = process.cwd();
let port = 7421;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') root = args[++i];
  else if (args[i] === '--port') port = Number(args[++i]);
}
startGui(root, port).catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(2);
});
