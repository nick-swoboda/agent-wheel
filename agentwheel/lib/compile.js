'use strict';

const { SPINE } = require('./traversal');
const { currentAccepted, stagedVersion } = require('./nodes');
const { NODE_SCHEMAS, productSpec, EXECUTION_SUBMISSION, TRIAL_KIT, REVIEW_RESULT, DESIGN_PROPOSAL } = require('./schema');
const planlib = require('./plan');
const { claimsOf } = require('./claims');
const { prefixText, GATES } = require('./gates');
const { POLICY } = require('./broker');
const { nowIso, sha256 } = require('./ids');
const { resolve, nodeOf } = require('./frontier');

const SEAT_FOR_INPUT = {
  spool: 'human',
  prompt: 'human',
  form: 'human',
  validate: 'review',
  gate: 'human',
  reopen: 'human',
  plan_generate: 'system',
  plan_trial: 'system',
  execute: 'builder',
  seat_dispatch: 'system',
  seat_result: 'leader',
  finalize: 'system',
  project_done: 'system',
  recover: 'system',
};

function resultSchemaFor(input) {
  switch (input.type) {
    case 'spool': return NODE_SCHEMAS.idea;
    case 'prompt': return { type: 'object' };
    case 'form': return NODE_SCHEMAS[input.kind] || { type: 'object' };
    case 'design': return DESIGN_PROPOSAL;
    case 'plan_generate': return { type: 'object' };
    case 'plan_trial': return NODE_SCHEMAS.plan;
    case 'execute': return EXECUTION_SUBMISSION;
    case 'review': return REVIEW_RESULT;
    case 'validate':
      return {
        type: 'object',
        required: ['action'],
        properties: { action: { enum: [...GATES.VALIDATE.actions] } },
      };
    default: return { type: 'object' };
  }
}

function frontierSnapshot(state, frontier) {
  return { ts: nowIso(), frontier };
}

function wikiTempSnapshot(state) {
  const wiki = {};
  if (!state) return wiki;
  for (const kind of SPINE) {
    const node = state.nodes[kind];
    if (!node) continue;
    const cur = currentAccepted(node);
    const staged = stagedVersion(node);
    wiki[kind] = {
      name: kind,
      line: cur
        ? `accepted v${cur.v}`
        : staged
          ? `staged v${staged.v} awaiting ${kind === 'design' ? 'approval' : 'validation'}`
          : node.draft
            ? 'draft (auto-generated, untried)'
            : node.stale
              ? 'stale - retry against new parent'
              : 'empty',
      reopened: node.reopened,
      stale: node.stale,
    };
  }
  const plan = currentAccepted(state.nodes.plan);
  if (plan && !state.nodes.plan.stale && !state.nodes.plan.reopened) {
    const s = planlib.executionSummary(plan.content, state.leaves || {});
    wiki.plan.leaves = `${s.done}/${s.leaves} done, ${s.executing} executing, ${s.gaps} gap(s)`;
    wiki.plan.parents = plan.content.root.decomposes_into.map((p) => ({
      id: p.id, title: p.title,
      done: planlib.collectLeaves(p).every((l) => !l.required || planlib.leafState(l, state.leaves || {}) === 'done'),
    }));
    if (state.closure) wiki.plan.closure = state.closure.state;
  }
  const source = plan && !state.nodes.plan.stale && !state.nodes.plan.reopened ? plan.content.root : state.nodes.plan.draft;
  if (source && wiki.plan) {
    wiki.plan.leaf_stubs = planlib.collectLeaves(source).map((l) => leafStub(l, state.leaves || {}));
    if (!wiki.plan.parents) wiki.plan.parents = (source.decomposes_into || []).map((p) => ({ id: p.id, title: p.title, done: false }));
  }
  return wiki;
}

function leafStub(l, overlay) {
  return { id: l.id, title: l.title, kind: l.kind, claim_refs: l.claim_refs, state: planlib.leafState(l, overlay) };
}

function sliceLeafIds(state, frontier, extra) {
  const ids = new Set(frontier.leaves || []);
  for (const id of (state.last_claim_change && state.last_claim_change.leaves) || []) ids.add(id);
  for (const id of (extra && extra.pull) || []) if (/^L[0-9]/.test(id)) ids.add(id);
  const pv = state.pending_validation;
  if (pv && pv.kind === 'execution' && state.executions && state.executions[pv.branch]) for (const id of state.executions[pv.branch].leaves) ids.add(id);
  return ids;
}

function planView(state, frontier, extra) {
  const plan = currentAccepted(state.nodes.plan);
  if (!plan || state.nodes.plan.stale || state.nodes.plan.reopened) return null;
  const overlay = state.leaves || {};
  const expandedIds = sliceLeafIds(state, frontier, extra);
  const leaves = planlib.collectLeaves(plan.content.root);
  return {
    v: plan.v,
    decision: plan.content.decision,
    expanded: leaves.filter((l) => expandedIds.has(l.id)).map((l) => ({ ...l, state: planlib.leafState(l, overlay), execution: (overlay[l.id] && overlay[l.id].execution) || null })),
    stubs: leaves.filter((l) => !expandedIds.has(l.id)).map((l) => leafStub(l, overlay)),
  };
}

function planBody(ver) {
  if (!ver) return null;
  const { root: _root, ...rest } = ver.content;
  return { v: ver.v, ...rest };
}

const CLAIM_ID_RE = /\b(?:[ASVTINDRC][0-9]+|release|problem|solution)\b/g;

function expandedContext(state, frontier, extra) {
  const ctx = {};
  if (!state) return ctx;
  const pulled = (extra && extra.pull) || [];
  const inSlice = new Set([...frontier.current_nodes, ...pulled.filter((k) => SPINE.includes(k))]);
  const view = planView(state, frontier, extra);
  const draft = state.nodes.plan.draft;
  const cited = new Set();
  for (const l of (view && view.expanded) || []) for (const c of l.claim_refs || []) cited.add(c);
  if (draft && inSlice.has('plan')) {
    planlib.walk(draft, (n) => { if (!n.decomposes_into.length && !(n.trial && n.trial.status === 'passed')) for (const c of n.claim_refs || []) cited.add(c); });
  }
  const stagedPlan = inSlice.has('plan') ? stagedVersion(state.nodes.plan) : null;
  if (stagedPlan) planlib.walk(stagedPlan.content.root, (n) => { if (!n.decomposes_into.length) for (const c of n.claim_refs || []) cited.add(c); });
  if (state.gate && state.gate.finding_key) for (const c of String(state.gate.finding_key).split(':')[1].split(',')) if (c && c !== 'node') cited.add(c);
  if (state.last_failure && state.last_failure.reason) for (const m of String(state.last_failure.reason).match(CLAIM_ID_RE) || []) cited.add(m);
  const change = state.last_claim_change;
  if (change) for (const c of [...change.changed, ...change.added, ...change.removed]) cited.add(c);
  for (const kind of SPINE) {
    const node = state.nodes[kind];
    if (!node) continue;
    const cur = currentAccepted(node);
    if (inSlice.has(kind)) {
      const staged = stagedVersion(node);
      ctx[kind] = {
        accepted: kind === 'plan' ? planBody(cur) : cur ? (kind === 'spec' ? productSpec(cur.content) : cur.content) : null,
        staged: staged ? (kind === 'spec' ? productSpec(staged.content) : staged.content) : null,
        draft: kind === 'spec' ? productSpec(node.draft) : node.draft,
      };
      continue;
    }
    if (!cur) continue;
    ctx[kind] = {
      stub: `accepted v${cur.v}`,
      cited_claims: claimsOf(kind, cur.content).filter((c) => cited.has(c.id)).map((c) => ({ id: c.id, text: c.text })),
    };
  }
  if (view) ctx.plan_leaves = view;
  if (pulled.length) ctx.pull = pulled.slice();
  if (change) {
    const cur = currentAccepted(state.nodes[change.kind]);
    const texts = cur ? Object.fromEntries(claimsOf(change.kind, cur.content).map((c) => [c.id, c.text])) : {};
    ctx.changed_claims = {
      kind: change.kind,
      changed: change.changed.map((id) => ({ id, text: texts[id] || null })),
      added: change.added.map((id) => ({ id, text: texts[id] || null })),
      removed: change.removed,
      leaves_back_to_untried: change.leaves,
    };
  }
  return ctx;
}

function schemaRejectMatches(state, input) {
  const rej = state && state.last_schema_reject;
  if (!rej) return false;
  return rej.input_type === input.type || (input.type === 'form' && rej.input_type === input.kind);
}

function repairMatches(state, input) {
  const lf = state && state.last_failure;
  if (!lf) return false;
  return (input.type === 'form' && input.kind === lf.kind) ||
    (input.type === 'design' && lf.kind === 'design') ||
    (input.type === 'plan_trial' && lf.kind === 'plan') ||
    (input.type === 'execute' && lf.kind === 'plan');
}

function designNote(state, input) {
  const wantsDesign = (input.type === 'form' && input.kind === 'design') || input.type === 'design';
  return wantsDesign && state.nodes.design.rejected_note ? state.nodes.design.rejected_note : null;
}

function closureReview(state, input) {
  return input.type === 'review' && state.pending_validation && state.pending_validation.kind === 'closure';
}

function prefixFor(state, input) {
  if (!state) return null;
  if (schemaRejectMatches(state, input)) return prefixText('SCHEMA_REPAIR_ONLY_V1');
  if (closureReview(state, input)) return prefixText('FINAL_CLOSURE_READ_ONLY_V1');
  if (input.type === 'review') return prefixText('REVIEW_ONLY_V1');
  if (input.type === 'plan_trial' && state.nodes.plan.draft && !stagedVersion(state.nodes.plan)) {
    return prefixText('PLAN_TRIAL_READ_ONLY_V1');
  }
  if (repairMatches(state, input)) return prefixText('EARLIEST_REPAIR_ONLY_V1');
  const note = designNote(state, input);
  if (note) return note;
  if (input.type === 'execute') return prefixText('EXECUTE_LEAF_V1');
  if (input.type === 'finalize') return prefixText('FINAL_CLOSURE_READ_ONLY_V1');
  return null;
}

function prefixesFor(state, input) {
  const out = [];
  if (!state) return out;
  if (input.type === 'plan_trial' && state.nodes.plan.draft && !stagedVersion(state.nodes.plan)) {
    out.push(prefixText('PLAN_TRIAL_READ_ONLY_V1'));
  }
  if (input.type === 'execute') out.push(prefixText('EXECUTE_LEAF_V1'));
  if (repairMatches(state, input)) out.push(prefixText('EARLIEST_REPAIR_ONLY_V1'));
  const note = designNote(state, input);
  if (note) out.push(note);
  if (input.type === 'review') out.push(prefixText('REVIEW_ONLY_V1'));
  if (input.type === 'finalize' || closureReview(state, input)) out.push(prefixText('FINAL_CLOSURE_READ_ONLY_V1'));
  if (schemaRejectMatches(state, input)) out.push(prefixText('SCHEMA_REPAIR_ONLY_V1'));
  return out;
}

function superDoc(state, frontier, input, extra) {
  const seat = SEAT_FOR_INPUT[input.type] || 'human';
  return {
    frontier_snapshot: frontierSnapshot(state, frontier),
    wiki_temp_snapshot: wikiTempSnapshot(state),
    expanded_context: expandedContext(state, frontier, extra),
    binding: {
      seat,
      role: seat === 'review' ? 'validate staged content' : 'produce staged content',
      gate: state && state.gate ? state.gate.def : null,
      permissions: POLICY[seat] || {},
      budget: state
        ? {
            authority: state.budget.authority,
            window: state.budget.window,
            used: state.budget.used,
          }
        : null,
      result_schema: resultSchemaFor(input),
    },
    prefix: prefixFor(state, input),
    prefixes: prefixesFor(state, input),
  };
}

const INTENT = {
  plan_trial: 'Produce the trial kit for every leaf of the drafted Plan; the engine executes it read-only in scratch.',
  execute: 'Execute exactly the named Plan leaves on the assigned branch: return complete files, tests, and an optional build command; the engine builds and tests them there.',
  review: 'Review the presented result independently and return accept, gap, conflict, or needs_human with exact references.',
  design: 'Propose the Design - how it looks and how it behaves for the user - from the accepted Idea and Experience; the human decides at DESIGN_READY.',
};

function walkLeavesOf(node, out = []) {
  if (!node) return out;
  if (!node.decomposes_into || node.decomposes_into.length === 0) out.push(node);
  else node.decomposes_into.forEach((c) => walkLeavesOf(c, out));
  return out;
}

function claimText(state, id) {
  for (const kind of ['idea', 'experience', 'design', 'spec']) {
    const v = currentAccepted(state.nodes[kind]);
    const c = v ? claimsOf(kind, v.content).find((x) => x.id === id) : null;
    if (c) return `${id} (${kind}): ${c.text}`;
  }
  return id;
}

function lastReviewLines(state, subjectKind) {
  const lf = state && state.last_failure;
  if (!lf || lf.kind !== 'plan') return [];
  const review = [...((state && state.reviews) || [])].reverse().find((r) =>
    (r.decision === 'gap' || r.decision === 'conflict') && r.subject &&
    (r.subject.kind === subjectKind || r.subject.kind === 'execution' || r.subject.kind === 'closure'));
  if (!review) return [];
  return ['', `LAST REVIEW (${review.decision}; repair exactly this before anything else):`,
    JSON.stringify({ subject: review.subject, references: review.references || [], notes: review.notes || '', earliest_repair: review.earliest_repair || null })];
}

function pullAttemptLines(doc) {
  const p = doc.pull_attempt;
  if (!p) return [];
  let body = JSON.stringify(p.result == null ? null : p.result);
  if (body.length > 64000) body = body.slice(0, 64000) + ' ... (cut)';
  return ['', `YOUR PREVIOUS RESULT ASKED TO SEE: ${p.ids.join(', ')}. They are expanded in the context above. Return the complete result now; a second pull on this turn is refused and the result is read on its content alone. The result that asked:`, body];
}

function taskBlock(state, doc, kind) {
  const lines = [];
  lines.push(...pullAttemptLines(doc));
  if (kind === 'plan_trial') {
    const draft = doc.expanded_context.plan && doc.expanded_context.plan.draft;
    lines.push('PLAN LEAVES TO TRY (every one needs an entry under "leaves"; kind and risk in brackets; the [decision] leaf is listed last: put its entry last, inside "leaves", and close "leaves" after it):');
    const all = walkLeavesOf(draft);
    const carried = all.filter((l) => l.trial && l.trial.status === 'passed');
    const listed = all.filter((l) => !(l.trial && l.trial.status === 'passed'));
    for (const leaf of [...listed.filter((l) => l.kind !== 'decision'), ...listed.filter((l) => l.kind === 'decision')]) {
      lines.push(`- ${leaf.id} [${leaf.kind}${leaf.risk === 'high' ? ', high-risk' : ''}]: ${leaf.title}`);
    }
    if (carried.length) {
      lines.push('', 'LEAVES THAT STILL STAND (their trials carried from the accepted Plan; no entry needed, none may be re-decided):');
      for (const leaf of carried) lines.push(`- ${leaf.id} [${leaf.kind}, passed]: ${leaf.title}`);
    }
    if (doc.expanded_context.changed_claims) {
      lines.push('', 'WHAT CHANGED (the claims whose new versions sent leaves back to untried):', JSON.stringify(doc.expanded_context.changed_claims));
    }
    lines.push(...lastReviewLines(state, 'plan'));
    lines.push('',
      'Every leaf id above gets an entry with all six "bases": first_principles, trusted_method,',
      'executable_test, inspection, math, physics. Each basis is either {"applicable": false,',
      '"reason": "..."} with a real reason, or applicable with its payload: executable_test ->',
      '{"applicable": true, "exec": {"files": {...}, "entry": "<the file name in files that node runs, e.g. test.js, not a command>"}} (a self-contained Node',
      'script run by the engine in an empty scratch directory, offline, no packages; exit 0 on',
      'pass, non-zero on fail; the engine confines it to its own working directory - no read, write, or',
      'child process outside it); inspection ->',
      '{"applicable": true, "observation": "..."}; the others -> {"applicable": true,',
      '"derivation": "..."}. Applicability is owned by the leaf kind: [action], [expected_result],',
      'and [loop] leaves REQUIRE an applicable executable_test (the engine runs it; derivations are',
      'recorded but never decide them); [assumption] leaves may be derivation-only. A high-risk',
      'leaf needs two applicable bases. This is a trial of the plan, not the build: a test proves',
      'the leaf CAN be satisfied (a prototype, a probe, a check of the method), never that an',
      'artifact already exists - the artifact is built later, leaf by leaf, on branches.',
      'For the [decision] leaf, INSIDE that leaf\'s own entry next to its "bases" (never at the',
      '"leaves" level), give at least two "alternatives" (ALT1, ALT2, ...) with RUNNABLE Node',
      '"build" kits, then "chosen" and a "rationale" grounded in the accepted Spec, Design, and',
      'Experience. The engine records each alternative\'s "feasible" from its build kit\'s exit code',
      'and nothing else: exit 0 = feasible, non-zero = infeasible. So an alternative that an accepted',
      'constraint rules out must have a build kit that exits non-zero and prints the constraint it',
      'breaks - that is how "only one is feasible" is proven; a kit that exits 0 for an alternative',
      'your rationale calls infeasible is a contradiction the Reviewer will return. Shape: {"leaves": {"<id>": {"bases": {...}},',
      '"<decision id>": {"bases": {...}, "alternatives": [...], "chosen": "ALT1", "rationale": "..."}}}.',
      'Every leaf id listed above must appear; none may be omitted or merged.');
  } else if (kind === 'review') {
    lines.push('REVIEW SUBJECT (the presented result, its evidence, and the acceptance contract):', JSON.stringify(doc.review_subject));
    lines.push('',
      'You are not the author and see no author reasoning. Check the presented result against the',
      'current nodes and the current Plan, the required evidence, the tests, and the permissions;',
      'decide accept | gap | conflict | needs_human. "references": exact references (node kind +',
      'version, leaf ids, test names, acceptance ids). For gap or conflict name "earliest_repair":',
      'the earliest responsible node kind (idea, experience, design, spec, plan). "notes": what',
      'decided it, in a few sentences.');
    if (doc.review_subject && doc.review_subject.kind === 'plan') {
      lines.push('',
        'A plan trial is judged as a kit: does every leaf\'s recorded evidence show the leaf can be',
        'satisfied by the method tried, is the decision a real comparison, is nothing skipped? It',
        'is not judged on an artifact - none exists yet; execution follows on branches.');
    }
  } else if (kind === 'design') {
    lines.push('DESIGN INPUTS: the accepted Idea and Experience are in the context above.');
    lines.push('',
      'Propose the Design as intent, not architecture: "screens" (id S1, S2 ... with a name and the',
      'contents of each), "visual" (id V1 ... layout and visual system rules: type, color, spacing,',
      'borders), "states" (id T1 ... each on one screen id: the state and the transition), "interactions"',
      '(id I1 ... each on one screen id), "content" (id N1 ... content rules), and "acceptance" (id D1 ...',
      'the observable criteria that make the design checkable). Every id is a stable claim id. Name no',
      'technology, library, data model, or algorithm - those are decided inside the Plan. Every state and',
      'interaction must name a screen id that exists in "screens".');
  } else if (kind === 'execute') {
    const view = doc.expanded_context.plan_leaves;
    lines.push('LEAVES TO EXECUTE (exactly these, on the assigned branch; list them in "leaves"):');
    for (const leaf of (view && view.expanded) || []) {
      lines.push(`- ${leaf.id} [${leaf.kind}]: ${leaf.title}`);
      for (const ref of leaf.claim_refs || []) lines.push(`    serves ${claimText(state, ref)}`);
    }
    lines.push(...lastReviewLines(state, 'plan'));
    const main = doc.main_files || {};
    const names = Object.keys(main);
    lines.push('', names.length
      ? `MAIN (the artifact as it stands; your files replace or add to these, and every earlier test must still pass): ${names.join(', ')}`
      : 'MAIN is empty: this execution starts the artifact.');
    for (const name of names) lines.push('', `--- ${name} ---`, main[name]);
    const prev = doc.previous_attempt;
    if (prev && prev.tests) {
      const pnames = Object.keys(prev.files || {});
      lines.push('', prev.tests.exit_code === 0
        ? `PREVIOUS ATTEMPT (branch ${prev.branch}; ${prev.why || 'returned by review'}) PASSED ITS TESTS ${prev.merged ? 'AND WAS MERGED' : 'BUT WAS NOT MERGED'}${prev.why === 'returned by review' ? ' - THE REVIEWER RETURNED IT (see LAST REVIEW)' : ''}; repair it, do not start over. Test output tail:`
        : `PREVIOUS ATTEMPT (branch ${prev.branch}; ${prev.why || 'failed its tests'}) FAILED ITS TESTS (exit ${prev.tests.exit_code}); repair it, do not start over. Test output tail:`, prev.tests.output_tail || '');
      if (pnames.length) {
        lines.push('', `Its files (${pnames.join(', ')}); resubmit each one complete, fixed:`);
        for (const name of pnames) lines.push('', `--- ${name} (previous attempt) ---`, prev.files[name]);
      }
    }
    lines.push('',
      'EXECUTION RULES:',
      '- "files": COMPLETE file contents, no placeholders; the artifact file and a Node test suite.',
      '- "main_file": the artifact; derive its name from the project name, lowercase-hyphenated, with the',
      '  extension the Spec release.artifact_type implies; keep the same name main already uses.',
      '- "build_command" (optional, starts with "node "): when the artifact must be generated from inputs',
      '  outside the submission, the engine runs it in the branch before the tests and "main_file" must',
      '  exist afterwards; otherwise "files" must contain it.',
      '- "test_command" starts with "node ". The suite runs against the files on disk, genuinely verifies',
      '  every claim the named leaves serve (exact numbers included) and keeps verifying what main already',
      '  satisfied, prints exactly "TESTS passed=N failed=M" as its final line, and exits non-zero on any',
      '  failure. Claim only what the tests show.',
      '- Honor every Spec constraint and security entry (no network references, single self-contained',
      '  file, size limits...). The final closure re-scans the artifact mechanically.',
      '- The engine runs "build_command" and "test_command" confined to the branch workspace (Node permission',
      '  model: reads and writes inside it only, no child processes); a script that touches anything else fails.',
      '- Release leaves: the engine promotes the artifact to spec.release.output_dir at the final closure and',
      '  verifies the product link there; prove buildability and the link kind on the artifact as built.',
      '- Do not touch canonical state or main; the Reviewer\'s accept merges your branch.');
  }
  return lines.join('\n');
}

function previousReplyBlock(binding) {
  if (!binding || binding.previous_reply == null) return '';
  const cut = binding.previous_reply_cut;
  const head = cut ? `YOUR PREVIOUS REPLY, AS RECEIVED (${cut.bytes} bytes; the first ${cut.kept} kept, cut at ${cut.cap}):` : 'YOUR PREVIOUS REPLY, AS RECEIVED (return exactly its content in the required schema):';
  return '\n' + head + '\n' + binding.previous_reply;
}

function systemPromptFor(state, doc, kind) {
  const b = doc.binding;
  const sections = [];
  sections.push(prefixText('ALWAYS_ON_V1'));
  for (const p of doc.prefixes || []) sections.push(p);
  sections.push(`STAGE/SEAT: stage ${doc.frontier_snapshot && doc.frontier_snapshot.frontier ? doc.frontier_snapshot.frontier.stage : state.frontier ? state.frontier.stage : 'unknown'}; seat ${b.seat}; role: ${b.role}` +
    (doc.project ? `; project: ${doc.project.name}` : ''));
  sections.push(`GATE/AUTHORITY: ${b.gate ? `gate ${b.gate.id} is open` : 'no gate is open'}; budget authority ${b.budget ? b.budget.authority : 'n/a'} per ${b.budget ? b.budget.window : 'n/a'}` +
    (b.agree_or_escalate ? `; ${b.agree_or_escalate}` : ''));
  sections.push(`WRITE/TOOL SCOPE: ${Object.keys(b.permissions || {}).length ? JSON.stringify(b.permissions) : 'none: canonical state is read-only; you have no tools in this seat; any file content belongs INSIDE the JSON as string values'}`);
  sections.push('WIKI TEMP: ' + JSON.stringify(doc.wiki_temp_snapshot));
  sections.push('EXPANDED CONTEXT (the governing node versions and the current Plan): ' + JSON.stringify(doc.expanded_context));
  sections.push('NORMALIZED INTENT: ' + (INTENT[kind] || 'return the required typed result'));
  sections.push('EVIDENCE:\n' + taskBlock(state, doc, kind) + (b.schema_errors ? '\nYOUR PREVIOUS RESULT FAILED THE BOUND SCHEMA:\n' + b.schema_errors.map((e) => '  - ' + e).join('\n') : '') + previousReplyBlock(b));
  // Omit $schema: models echo it into instances that reject unknown fields.
  const { $schema: _dialect, ...shownSchema } = b.result_schema || {};
  sections.push('REQUIRED TURN RESULT SCHEMA - return ONLY one JSON object matching it exactly, no prose, no fences, no "$schema" key:\n' + JSON.stringify(shownSchema));
  return sections.join('\n\n');
}

function promptFor(state, doc, kind) {
  const note = kind === 'design' && state.nodes.design.rejected_note ? state.nodes.design.rejected_note : null;
  if (note) return note + '\n' + (INTENT[kind] || '');
  return INTENT[kind] || 'Return the required typed result.';
}

function superDocForSeat(state, frontier, kind, extra) {
  const doc = superDoc(state, frontier, { type: kind }, extra);
  if (extra && extra.pull) doc.pull_attempt = { ids: extra.pull.slice(), result: extra.pull_previous == null ? null : extra.pull_previous };
  doc.prefixes = prefixesFor(state, { type: kind });
  doc.project = state.project ? { name: state.project.name } : null;
  if (kind === 'review') {
    // Review context excludes the author’s private reasoning.
    const pv = state.pending_validation;
    doc.binding.seat = 'reviewer';
    doc.binding.role = 'independent non-author review of the presented result against the current nodes, the current Plan, required evidence, tests, and permissions';
    doc.binding.result_schema = REVIEW_RESULT;
    doc.binding.permissions = {};
    doc.review_subject = reviewSubject(state, pv, extra);
    doc.binding.agree_or_escalate = 'return accept, gap, conflict, or needs_human with exact references; name earliest_repair for gap or conflict';
    doc.binding.gate = null;
    doc.system_prompt = systemPromptFor(state, doc, kind);
    doc.prompt = promptFor(state, doc, kind);
    return doc;
  }
  if (kind === 'design') {
    doc.binding.seat = 'leader';
    doc.binding.role = 'Leader: propose the Design from the accepted Idea and Experience';
    doc.binding.result_schema = DESIGN_PROPOSAL;
    doc.binding.permissions = {};
    doc.binding.gate = null;
    doc.binding.agree_or_escalate = 'the human decides at DESIGN_READY: approve, reply/ask, summary, or reject';
    if (state.last_schema_reject && state.last_schema_reject.input_type === 'design') {
      doc.binding.schema_errors = state.last_schema_reject.errors;
      doc.binding.previous_reply = state.last_schema_reject.raw != null ? state.last_schema_reject.raw : null;
      doc.binding.previous_reply_cut = state.last_schema_reject.raw_cut || null;
    }
    doc.prefixes = prefixesFor(state, { type: 'design' });
    doc.prefix = prefixFor(state, { type: 'design' }) || doc.prefixes[0] || null;
    doc.system_prompt = systemPromptFor(state, doc, kind);
    doc.prompt = promptFor(state, doc, kind);
    return doc;
  }
  if (kind === 'plan_trial') {
    doc.binding.seat = 'leader';
    doc.binding.role =
      'Leader: produce a complete trial kit for the drafted plan; the engine executes it read-only in scratch';
    doc.binding.result_schema = TRIAL_KIT;
    doc.binding.permissions = {};
  } else {
    doc.binding.seat = 'builder';
    doc.binding.role =
      'Builder on an isolated branch: execute exactly the named leaves; the engine writes, builds, and tests the submission on the branch';
    doc.binding.result_schema = EXECUTION_SUBMISSION;
    doc.binding.permissions = POLICY.builder;
    doc.main_files = (extra && extra.main_files) || {};
    doc.previous_attempt = (extra && extra.previous_attempt) || null;
  }
  doc.binding.gate = null;
  doc.binding.agree_or_escalate =
    'your result goes to the independent Reviewer; a separate review turn accepts or returns it';
  if (
    state.last_schema_reject &&
    state.last_schema_reject.input_type === kind
  ) {
    doc.binding.schema_errors = state.last_schema_reject.errors;
    doc.binding.previous_reply = state.last_schema_reject.raw != null ? state.last_schema_reject.raw : null;
    doc.binding.previous_reply_cut = state.last_schema_reject.raw_cut || null;
  }
  doc.system_prompt = systemPromptFor(state, doc, kind);
  doc.prompt = promptFor(state, doc, kind);
  return doc;
}

function reviewSubject(state, pv, extra) {
  if (!pv) return null;
  if (pv.kind === 'execution') {
    const ex = state.executions[pv.branch];
    const plan = currentAccepted(state.nodes.plan);
    const leaves = plan ? planlib.collectLeaves(plan.content.root).filter((l) => ex.leaves.includes(l.id)) : [];
    return {
      kind: 'execution',
      branch: pv.branch,
      author_seat: pv.author ? pv.author.seat : 'human',
      leaves: leaves.map((l) => ({ id: l.id, title: l.title, kind: l.kind, claim_refs: l.claim_refs })),
      content: { main_file: ex.main_file, files: ex.files, file_contents: (extra && extra.review_files) || {}, notes: ex.notes, build: ex.build || null },
      evidence: ex.tests,
      acceptance_contract: 'tests green on the branch (exit 0, zero failures); every claim the named leaves serve is genuinely verified; the artifact honors the Spec constraints; nothing outside the named leaves was claimed Release leaves: the engine promotes the artifact to spec.release.output_dir and verifies the product link there at the final closure; an execution of a release leaf proves the artifact builds and its link kind resolves for the artifact as built, and its suite runs confined to the branch (no write outside it, no child process) - a test that reaches the release path is a scope violation, not evidence.',
    };
  }
  if (pv.kind === 'closure') {
    return {
      kind: 'closure',
      author_seat: 'system',
      content: state.closure ? {
        steps: state.closure.steps,
        artifact: state.closure.artifact,
        artifact_content: (extra && extra.closure_artifact) || null,
        main_files: (extra && extra.closure_main_files) || {},
        reruns: state.closure.reruns || [],
      } : null,
      evidence: state.closure ? { steps: state.closure.steps, reruns: state.closure.reruns || [] } : null,
      acceptance_contract: 'every step ok: the artifact on main is built, tested, hashed, and linked; every required leaf done through an accepted execution; every Spec, Design, Experience, and Idea claim served by a done leaf; every artifact claim traces to a criterion; nothing stale or gated',
    };
  }
  const node = state.nodes[pv.kind];
  const ver = node && node.versions.find((x) => x.v === pv.v);
  if (!ver) return null;
  return {
    kind: pv.kind,
    v: pv.v,
    author_seat: pv.author ? pv.author.seat : 'human',
    content: ver.content,
    evidence: pv.kind === 'plan'
      ? planlib.collectLeaves(ver.content.root).map((l) => ({ id: l.id, title: l.title, trial: l.trial }))
      : null,
    acceptance_contract: pv.kind === 'plan'
      ? 'every required leaf tried and settled by the method recorded; two alternatives compared or one proven feasible; the chosen alternative feasible; judged as a trial kit, not as an artifact'
      : 'the node body meets its schema and traces to its accepted ancestors',
  };
}

function normalizedFrontier(frontier) {
  const stage = frontier.stage;
  const stale = frontier.stale || [];
  return {
    stage,
    prompt_touched: [],
    stale,
    leaves: frontier.leaves || [],
    dependencies: frontier.dependencies,
    branch_results: frontier.branch_results,
    current_nodes: [...new Set([nodeOf(stage), ...stale])].filter((k) => SPINE.includes(k)),
  };
}

function look(state, kind, ts, extra) {
  const frontier = normalizedFrontier(resolve(state));
  const doc = superDocForSeat(state, frontier, kind, extra);
  doc.frontier_snapshot = { frontier };
  if (doc.binding.budget) doc.binding.budget = { authority: doc.binding.budget.authority, window: doc.binding.budget.window };
  doc.system_prompt = systemPromptFor(state, doc, kind);
  doc.prompt = promptFor(state, doc, kind);
  const sealed = seal(doc);
  return { frontier, sealed, hash: sealed.hash, ts };
}

function seal(doc) {
  const body = { ...doc };
  delete body.hash;
  const hash = sha256(JSON.stringify(body));
  return { ...body, hash };
}

module.exports = {
  superDoc, superDocForSeat, wikiTempSnapshot, expandedContext, planView, prefixFor, prefixesFor, look, seal, normalizedFrontier,
  systemPromptFor, promptFor, INTENT, reviewSubject,
  SEAT_FOR_INPUT, resultSchemaFor,
};
