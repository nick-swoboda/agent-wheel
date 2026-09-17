'use strict';

function applyUnifiedDiff(text, patch) {
  const src = text.split('\n');
  const out = [];
  let cursor = 0;
  const lines = patch.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('@@')) i++;
  if (i === lines.length) throw new Error('no hunks in patch');
  while (i < lines.length) {
    const head = lines[i];
    if (!head.startsWith('@@')) { i++; continue; }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(head);
    if (!m) throw new Error('bad hunk header: ' + head);
    const oldStart = Number(m[1]) - 1;
    if (oldStart < cursor) throw new Error('hunks out of order at ' + head);
    while (cursor < oldStart) out.push(src[cursor++]);
    i++;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const line = lines[i];
      if (line === '' && i === lines.length - 1) { i++; break; }
      const tag = line[0];
      const body = line.slice(1);
      if (tag === ' ' || tag === '-') {
        if (src[cursor] !== body) throw new Error(`context mismatch at source line ${cursor + 1}: expected ${JSON.stringify(body)}, found ${JSON.stringify(src[cursor])}`);
        if (tag === ' ') out.push(body);
        cursor++;
      } else if (tag === '+') {
        out.push(body);
      } else if (line.startsWith('\\ No newline')) {
      } else {
        throw new Error('unexpected patch line: ' + JSON.stringify(line));
      }
      i++;
    }
  }
  while (cursor < src.length) out.push(src[cursor++]);
  return out.join('\n');
}

module.exports = { applyUnifiedDiff };
