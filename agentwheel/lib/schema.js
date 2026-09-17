'use strict';

const ROUTE_IDS = [
  'claude:app:chat', 'claude:app:cowork', 'claude:app:code', 'claude:cli',
  'chatgpt:app:classic', 'chatgpt:app:chat', 'chatgpt:app:work', 'chatgpt:codex',
  'cursor:app', 'cursor:cli', 'grok:cli', 'api:anthropic', 'api:openai', 'api:xai',
];

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const SUPPORTED_KEYWORDS = Object.freeze([
  '$schema', '$defs', '$ref',
  'type', 'enum', 'const',
  'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum',
  'anyOf',
]);
const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

class SchemaError extends Error {}

function checkSchema(schema, path, root) {
  path = path || '$';
  root = root || schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new SchemaError(`${path}: schema must be an object`);
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.includes(key)) {
      throw new SchemaError(`${path}: unsupported keyword "${key}" (supported: ${SUPPORTED_KEYWORDS.join(', ')})`);
    }
  }
  if ('$schema' in schema) {
    if (path !== '$') throw new SchemaError(`${path}: $schema is allowed only at the root`);
    if (schema.$schema !== DIALECT) throw new SchemaError(`${path}: dialect must be ${DIALECT}`);
  }
  if ('$defs' in schema) {
    if (path !== '$') throw new SchemaError(`${path}: $defs are allowed only at the root`);
    if (!schema.$defs || typeof schema.$defs !== 'object') throw new SchemaError(`${path}: $defs must be an object`);
    for (const [name, sub] of Object.entries(schema.$defs)) checkSchema(sub, `${path}/$defs/${name}`, root);
  }
  if ('$ref' in schema) {
    if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) {
      throw new SchemaError(`${path}: only local $ref is supported`);
    }
    try { resolveRef(root, schema.$ref); } catch (err) { throw new SchemaError(`${path}: ${err.message}`); }
  }
  if ('type' in schema) {
    const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of ts) if (!TYPES.includes(t)) throw new SchemaError(`${path}: unknown type "${t}"`);
  }
  if ('enum' in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new SchemaError(`${path}: enum must be a non-empty array`);
  }
  if ('required' in schema) {
    if (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === 'string')) {
      throw new SchemaError(`${path}: required must be an array of strings`);
    }
  }
  if ('properties' in schema) {
    if (!schema.properties || typeof schema.properties !== 'object') throw new SchemaError(`${path}: properties must be an object`);
    for (const [name, sub] of Object.entries(schema.properties)) checkSchema(sub, `${path}.${name}`, root);
  }
  if ('additionalProperties' in schema) {
    if (schema.additionalProperties === true) throw new SchemaError(`${path}: additionalProperties must be false or a schema`);
    if (schema.additionalProperties !== false) checkSchema(schema.additionalProperties, `${path}.*`, root);
  }
  if ('items' in schema) checkSchema(schema.items, `${path}[]`, root);
  if ('anyOf' in schema) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) throw new SchemaError(`${path}: anyOf must be a non-empty array`);
    schema.anyOf.forEach((sub, i) => checkSchema(sub, `${path}|${i}`, root));
  }
  for (const k of ['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum']) {
    if (k in schema && typeof schema[k] !== 'number') throw new SchemaError(`${path}: ${k} must be a number`);
  }
  if ('pattern' in schema) {
    if (typeof schema.pattern !== 'string') throw new SchemaError(`${path}: pattern must be a string`);
    try { new RegExp(schema.pattern); } catch { throw new SchemaError(`${path}: pattern does not compile`); }
  }
  const ts = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (ts.includes('object') && schema.properties && schema.additionalProperties !== false) {
    throw new SchemaError(`${path}: object schemas with properties must set additionalProperties = false`);
  }
  return true;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want, got) {
  if (want === 'number') return got === 'number' || got === 'integer';
  return want === got;
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error('only local $ref supported: ' + ref);
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node && node[part];
  }
  if (!node) throw new Error('unresolved $ref: ' + ref);
  return node;
}

const CHECKED = new WeakSet();

function validate(schema, value, opts) {
  const root = (opts && opts.root) || schema;
  for (const s of root === schema ? [root] : [root, schema]) {
    if (!CHECKED.has(s)) { checkSchema(s, '$', root); CHECKED.add(s); }
  }
  const errors = [];
  walk(schema, value, '$', errors, root, 0);
  return { ok: errors.length === 0, errors };
}

function walk(schema, value, path, errors, root, depth) {
  if (depth > 64) {
    errors.push(path + ': schema recursion too deep');
    return;
  }
  if (schema.$ref) {
    walk(resolveRef(root, schema.$ref), value, path, errors, root, depth + 1);
    return;
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => {
      const sub = [];
      walk(s, value, path, sub, root, depth + 1);
      return sub.length === 0;
    });
    if (!ok) errors.push(path + ': matched no anyOf branch');
    return;
  }
  if ('const' in schema && value !== schema.const) {
    errors.push(path + ': must equal ' + JSON.stringify(schema.const));
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(path + ': not in enum ' + JSON.stringify(schema.enum));
    return;
  }
  const got = typeOf(value);
  if (schema.type) {
    const wants = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wants.some((w) => typeMatches(w, got))) {
      errors.push(path + ': expected ' + wants.join('|') + ', got ' + got);
      return;
    }
  }
  if (got === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(path + ': shorter than minLength ' + schema.minLength);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push(path + ': longer than maxLength ' + schema.maxLength);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(path + ': does not match ' + schema.pattern);
    }
  }
  if (got === 'number' || got === 'integer') {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(path + ': below minimum ' + schema.minimum);
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push(path + ': above maximum ' + schema.maximum);
    }
  }
  if (got === 'array') {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(path + ': fewer than minItems ' + schema.minItems);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(path + ': more than maxItems ' + schema.maxItems);
    }
    if (schema.items) {
      value.forEach((v, i) =>
        walk(schema.items, v, path + '[' + i + ']', errors, root, depth + 1)
      );
    }
  }
  if (got === 'object') {
    const props = schema.properties || {};
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(path + ': missing required "' + req + '"');
    }
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) {
        walk(props[k], v, path + '.' + k, errors, root, depth + 1);
      } else if (schema.additionalProperties === false) {
        errors.push(path + ': unexpected property "' + k + '"');
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
      ) {
        walk(schema.additionalProperties, v, path + '.' + k, errors, root, depth + 1);
      }
    }
  }
}

const IDEA = {
  $schema: DIALECT,
  type: 'object',
  required: ['problem', 'solution'],
  additionalProperties: false,
  properties: {
    problem: { type: 'string', minLength: 20, maxLength: 2000 },
    solution: { type: 'string', minLength: 20, maxLength: 2000 },
  },
};

const EXPERIENCE = {
  $schema: DIALECT,
  type: 'object',
  required: ['actors', 'journeys', 'edge_cases', 'usability', 'acceptance'],
  additionalProperties: false,
  properties: {
    actors: { type: 'array', minItems: 1, items: { type: 'string', minLength: 2 } },
    journeys: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['name', 'steps'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 2 },
          steps: { type: 'array', minItems: 1, items: { type: 'string', minLength: 2 } },
        },
      },
    },
    edge_cases: { type: 'array', minItems: 1, items: { type: 'string', minLength: 2 } },
    usability: { type: 'array', minItems: 1, items: { type: 'string', minLength: 2 } },
    acceptance: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'criterion'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^A[0-9]+$' },
          criterion: { type: 'string', minLength: 5 },
        },
      },
    },
  },
};

const LEGACY_SPEC = {
  $schema: DIALECT,
  type: 'object',
  required: [
    'requirements', 'constraints', 'platform', 'security', 'release',
    'providers_tools', 'route_allowlist',
  ],
  additionalProperties: false,
  properties: {
    requirements: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'requirement'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^R[0-9]+$' },
          requirement: { type: 'string', minLength: 5 },
        },
      },
    },
    constraints: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'constraint'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^C[0-9]+$' },
          constraint: { type: 'string', minLength: 5 },
        },
      },
    },
    platform: { type: 'string', minLength: 2 },
    security: { type: 'array', minItems: 1, items: { type: 'string', minLength: 2 } },
    release: {
      type: 'object',
      required: ['artifact_type', 'output_dir', 'link_kind'],
      additionalProperties: false,
      properties: {
        artifact_type: { enum: ['single_file_html', 'directory', 'archive', 'binary'] },
        output_dir: { type: 'string', minLength: 2 },
        link_kind: { enum: ['file_url', 'https_url'] },
      },
    },
    providers_tools: { type: 'array', items: { type: 'string', minLength: 2 } },
    preauthorized_high_risk: { type: 'array', maxItems: 40, items: { type: 'string', minLength: 1, maxLength: 40 } },
    route_allowlist: { type: 'array', minItems: 1, maxItems: 14, items: { type: 'string', enum: ROUTE_IDS } },
    budget: {
      type: 'object',
      required: ['authority', 'window'],
      additionalProperties: false,
      properties: {
        authority: { enum: ['25', '50', 'unlimited'] },
        window: { enum: ['5 hours', '1 day', '1 week', '1 month'] },
      },
    },
  },
};

function productSpec(content) {
  if (!content) return content;
  const { route_allowlist, budget, ...product } = content;
  return product;
}

const SPEC = {
  ...LEGACY_SPEC,
  required: LEGACY_SPEC.required.filter(key => key !== 'route_allowlist'),
  properties: productSpec(LEGACY_SPEC.properties),
};

function claimList(prefix, field, extra) {
  return {
    type: 'array',
    minItems: 1,
    maxItems: 60,
    items: {
      type: 'object',
      required: ['id', ...Object.keys(extra || {}), field],
      additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^' + prefix + '[0-9]+$' },
        ...(extra || {}),
        [field]: { type: 'string', minLength: 5, maxLength: 600 },
      },
    },
  };
}

const DESIGN = {
  $schema: DIALECT,
  type: 'object',
  required: ['screens', 'visual', 'states', 'interactions', 'content', 'acceptance'],
  additionalProperties: false,
  properties: {
    screens: {
      type: 'array',
      minItems: 1,
      maxItems: 40,
      items: {
        type: 'object',
        required: ['id', 'name', 'contents'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^S[0-9]+$' },
          name: { type: 'string', minLength: 2, maxLength: 120 },
          contents: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'string', minLength: 2, maxLength: 400 } },
        },
      },
    },
    visual: claimList('V', 'rule'),
    states: claimList('T', 'transition', { screen: { type: 'string', pattern: '^S[0-9]+$' }, state: { type: 'string', minLength: 2, maxLength: 200 } }),
    interactions: claimList('I', 'rule', { screen: { type: 'string', pattern: '^S[0-9]+$' } }),
    content: claimList('N', 'rule'),
    acceptance: claimList('D', 'criterion'),
  },
};

const EVIDENCE = {
  type: 'object',
  required: ['basis', 'executor', 'ok', 'detail'],
  additionalProperties: false,
  properties: {
    basis: { enum: ['first_principles', 'trusted_method', 'executable_test', 'inspection', 'math', 'physics'] },
    executor: { enum: ['engine', 'model'] },
    ok: { type: 'boolean' },
    detail: { type: 'string', maxLength: 1200 },
  },
};

const ALTERNATIVE = {
  type: 'object',
  required: ['id', 'name', 'summary', 'feasible', 'evidence'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^ALT[0-9]+$' },
    name: { type: 'string', minLength: 3 },
    summary: { type: 'string', minLength: 10 },
    feasible: { type: 'boolean' },
    evidence: { type: 'array', minItems: 1, items: EVIDENCE },
  },
};

const TRIAL = {
  type: 'object',
  required: ['status', 'evidence', 'not_applicable'],
  additionalProperties: false,
  properties: {
    status: { enum: ['untried', 'passed', 'gap', 'conflict'] },
    evidence: { type: 'array', items: EVIDENCE },
    not_applicable: { type: 'object', additionalProperties: { type: 'string', maxLength: 1000 } },
    reason: { type: 'string', maxLength: 1000 },
    alternatives: { type: 'array', maxItems: 6, items: ALTERNATIVE },
    chosen: { type: ['string', 'null'], pattern: '^ALT[0-9]+$' },
    rationale: { type: 'string', maxLength: 2000 },
    basis_of_decision: { enum: ['compared_two', 'only_one_feasible', null] },
  },
};

const PLAN_ID = { type: 'string', pattern: '^L[0-9]+(\\.[A-Za-z0-9]+)*$' };

const PLAN = {
  $schema: DIALECT,
  $defs: {
    planNode: {
      type: 'object',
      required: ['id', 'title', 'kind', 'needs', 'after', 'serves', 'claim_refs', 'decomposes_into', 'required', 'risk', 'trial'],
      additionalProperties: false,
      properties: {
        id: PLAN_ID,
        title: { type: 'string', minLength: 3 },
        kind: { enum: ['decision', 'action', 'assumption', 'expected_result', 'loop'] },
        needs: { type: 'array', items: PLAN_ID },
        after: { type: 'array', items: PLAN_ID },
        serves: { type: 'array', items: PLAN_ID },
        claim_refs: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 } },
        decomposes_into: { type: 'array', items: { $ref: '#/$defs/planNode' } },
        required: { type: 'boolean' },
        risk: { enum: ['normal', 'high'] },
        loop: {
          type: 'object',
          required: ['over', 'until', 'max_iterations'],
          additionalProperties: false,
          properties: {
            over: { type: 'string', minLength: 1 },
            until: { type: 'string', minLength: 1 },
            max_iterations: { type: 'integer', minimum: 1, maximum: 1000 },
          },
        },
        trial: TRIAL,
      },
    },
  },
  type: 'object',
  required: ['root', 'trial_stages', 'decision', 'summary'],
  additionalProperties: false,
  properties: {
    root: { $ref: '#/$defs/planNode' },
    trial_stages: { type: 'array', items: { type: 'array', items: PLAN_ID } },
    decision: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['leaf', 'chosen', 'rationale', 'basis'],
          additionalProperties: false,
          properties: {
            leaf: PLAN_ID,
            chosen: { type: ['string', 'null'], pattern: '^ALT[0-9]+$' },
            rationale: { type: 'string', maxLength: 2000 },
            basis: { enum: ['compared_two', 'only_one_feasible', null] },
          },
        },
      ],
    },
    summary: {
      type: 'object',
      required: ['leaves', 'passed', 'untried', 'gaps', 'conflicts', 'high_risk'],
      additionalProperties: false,
      properties: {
        leaves: { type: 'integer', minimum: 0 },
        passed: { type: 'integer', minimum: 0 },
        untried: { type: 'integer', minimum: 0 },
        gaps: { type: 'integer', minimum: 0 },
        conflicts: { type: 'integer', minimum: 0 },
        high_risk: { type: 'array', items: PLAN_ID },
      },
    },
  },
};

const NOT_APPLICABLE = {
  type: 'object', required: ['applicable', 'reason'], additionalProperties: false,
  properties: { applicable: { const: false }, reason: { type: 'string', minLength: 5, maxLength: 1000 } },
};
const EXEC_KIT = {
  type: 'object', required: ['files', 'entry'], additionalProperties: false,
  properties: { files: { type: 'object', additionalProperties: { type: 'string' } }, entry: { type: 'string', minLength: 2 } },
};
const BASIS_DERIVED = {
  anyOf: [
    NOT_APPLICABLE,
    { type: 'object', required: ['applicable', 'derivation'], additionalProperties: false,
      properties: { applicable: { const: true }, derivation: { type: 'string', minLength: 10, maxLength: 4000 } } },
  ],
};
const BASIS_INSPECTION = {
  anyOf: [
    NOT_APPLICABLE,
    { type: 'object', required: ['applicable', 'observation'], additionalProperties: false,
      properties: { applicable: { const: true }, observation: { type: 'string', minLength: 10, maxLength: 4000 } } },
  ],
};
const BASIS_EXECUTABLE = {
  anyOf: [
    NOT_APPLICABLE,
    { type: 'object', required: ['applicable', 'exec'], additionalProperties: false,
      properties: { applicable: { const: true }, exec: EXEC_KIT } },
  ],
};

const REQUESTED_EXPANSIONS = { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 64 } };

const TRIAL_KIT = {
  $schema: DIALECT,
  type: 'object',
  required: ['leaves'],
  additionalProperties: false,
  properties: {
    requested_expansions: REQUESTED_EXPANSIONS,
    leaves: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['bases'],
        additionalProperties: false,
        properties: {
          bases: {
            type: 'object',
            required: ['first_principles', 'trusted_method', 'executable_test', 'inspection', 'math', 'physics'],
            additionalProperties: false,
            properties: {
              first_principles: BASIS_DERIVED,
              trusted_method: BASIS_DERIVED,
              executable_test: BASIS_EXECUTABLE,
              inspection: BASIS_INSPECTION,
              math: BASIS_DERIVED,
              physics: BASIS_DERIVED,
            },
          },
          alternatives: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              required: ['id', 'name', 'summary'],
              additionalProperties: false,
              properties: {
                id: { type: 'string', pattern: '^ALT[0-9]+$' },
                name: { type: 'string', minLength: 3 },
                summary: { type: 'string', minLength: 10 },
                build: EXEC_KIT,
              },
            },
          },
          chosen: { type: 'string', pattern: '^ALT[0-9]+$' },
          rationale: { type: 'string', maxLength: 2000 },
        },
      },
    },
  },
};

const EXECUTION_SUBMISSION = {
  $schema: DIALECT,
  type: 'object',
  required: ['leaves', 'files', 'main_file', 'test_command', 'notes'],
  additionalProperties: false,
  properties: {
    requested_expansions: REQUESTED_EXPANSIONS,
    leaves: { type: 'array', minItems: 1, maxItems: 40, items: PLAN_ID },
    files: { type: 'object', additionalProperties: { type: 'string' } },
    main_file: { type: 'string', minLength: 3 },
    build_command: { type: 'string', pattern: '^node ' },
    test_command: { type: 'string', pattern: '^node ' },
    notes: { type: 'string', maxLength: 2000 },
  },
};

const SEATS = ['leader', 'builder', 'reviewer'];
const BUDGET_SET = {
  $schema: DIALECT,
  type: 'object',
  required: ['authority', 'window'],
  additionalProperties: false,
  properties: {
    authority: { enum: ['25', '50', 'unlimited'] },
    window: { enum: ['5 hours', '1 day', '1 week', '1 month'] },
  },
};

const SEAT_ASSIGNMENT = {
  $schema: DIALECT,
  type: 'object',
  required: ['seat', 'route'],
  additionalProperties: false,
  properties: {
    seat: { enum: SEATS },
    route: { type: 'string', enum: ROUTE_IDS },
    config: {
      type: 'object',
      additionalProperties: false,
      properties: {
        model: { type: 'string', minLength: 2, maxLength: 80 },
        effort: { type: 'string', minLength: 2, maxLength: 16 },
        command: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1 } },
        project: { type: 'string', minLength: 1 },
        endpoint: { type: 'string', pattern: '^https?://' },
      },
    },
  },
};

const REVIEW_RESULT = {
  $schema: DIALECT,
  type: 'object',
  required: ['decision', 'references', 'notes'],
  additionalProperties: false,
  properties: {
    decision: { enum: ['accept', 'gap', 'conflict', 'needs_human'] },
    references: { type: 'array', maxItems: 40, items: { type: 'string', minLength: 1, maxLength: 200 } },
    notes: { type: 'string', maxLength: 4000 },
    earliest_repair: { enum: ['idea', 'experience', 'design', 'spec', 'plan'] },
    requested_expansions: REQUESTED_EXPANSIONS,
  },
};

const DESIGN_PROPOSAL = { ...DESIGN, properties: { ...DESIGN.properties, requested_expansions: REQUESTED_EXPANSIONS } };

const NODE_SCHEMAS = {
  idea: IDEA,
  experience: EXPERIENCE,
  design: DESIGN,
  spec: SPEC,
  plan: PLAN,
};

const KINDS = ['idea', 'experience', 'design', 'spec', 'plan'];

function templateFor(schema, root) {
  root = root || schema;
  if (schema.$ref) return templateFor(resolveRef(root, schema.$ref), root);
  if (schema.anyOf) return templateFor(schema.anyOf[0], root);
  if ('const' in schema) return schema.const;
  if (schema.enum) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'object') {
    const out = {};
    for (const key of schema.required || []) {
      const sub = schema.properties && schema.properties[key];
      out[key] = sub ? templateFor(sub, root) : null;
    }
    return out;
  }
  if (type === 'array') return schema.items && schema.minItems ? [templateFor(schema.items, root)] : [];
  if (type === 'integer' || type === 'number') return schema.minimum != null ? schema.minimum : 0;
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  return '';
}

const SHIPPED_SCHEMAS = { ...NODE_SCHEMAS, EXECUTION_SUBMISSION, TRIAL_KIT, REVIEW_RESULT, SEAT_ASSIGNMENT };
for (const [name, schema] of Object.entries(SHIPPED_SCHEMAS)) {
  try { checkSchema(schema); } catch (err) { throw new SchemaError(`schema ${name}: ${err.message}`); }
}

module.exports = {
  DESIGN_PROPOSAL, REQUESTED_EXPANSIONS,
  ROUTE_IDS,
  SEATS,
  SEAT_ASSIGNMENT,
  BUDGET_SET, LEGACY_SPEC, productSpec,
  validate,
  templateFor,
  checkSchema,
  SchemaError,
  SUPPORTED_KEYWORDS,
  DIALECT,
  SHIPPED_SCHEMAS,
  NODE_SCHEMAS,
  EXECUTION_SUBMISSION,
  TRIAL_KIT,
  REVIEW_RESULT,
  TRIAL,
  EVIDENCE,
  KINDS,
};
