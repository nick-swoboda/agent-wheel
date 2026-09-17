'use strict';

const { validate, NODE_SCHEMAS } = require('./schema');

function invariants(state, kind, content) {
  const errors = [];
  if (kind === 'design' && content) {
    const ids = ['screens', 'visual', 'states', 'interactions', 'content', 'acceptance'].flatMap((k) => (content[k] || []).map((e) => e.id));
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) errors.push('$: duplicate claim ids: ' + [...new Set(dup)].join(', '));
  }
  return errors;
}

function admit(state, kind, content) {
  const schema = NODE_SCHEMAS[kind];
  if (!schema) return { ok: false, stage: 'schema', errors: ['unknown node kind: ' + kind] };
  const res = validate(schema, content);
  if (!res.ok) return { ok: false, stage: 'schema', errors: res.errors };
  const errs = invariants(state, kind, content);
  if (errs.length) return { ok: false, stage: 'invariant', errors: errs };
  return { ok: true, stage: null, errors: [] };
}

module.exports = { admit, invariants };
