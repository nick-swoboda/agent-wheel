'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const paths = require('./paths');
const { uuidv7, turnId, branchId, nowIso, sha256 } = require('./ids');
const storelib = require('./store');
const { validate, NODE_SCHEMAS, EXECUTION_SUBMISSION, TRIAL_KIT, REVIEW_RESULT, SEAT_ASSIGNMENT, BUDGET_SET, KINDS, DESIGN_PROPOSAL } = require('./schema');
const { resolve } = require('./frontier');
const { superDoc, look, SEAT_FOR_INPUT } = require('./compile');
const gates = require('./gates');
const planlib = require('./plan');
const { finalClosure } = require('./proof');
const forms = require('./forms');
const { assertScoped, confinedNodeArgs } = require('./broker');
const commitlib = require('./commit');
const lease = require('./lease');
const { reduce, ReduceError, SCHEMA_VERSION, seatKeyOf } = require('./reducers');
const { currentAccepted, baseVersions } = require('./nodes');
const { runGuards } = require('./egress');
const { OUTCOMES, SEAT_TIMEOUT_MS, isTransportFailure, normalizeResult, keepRaw } = require('./transport/outcomes');
const { reachedBy } = require('./traversal');
const { claimIds } = require('./claims');

class WheelError extends Error {}
class LeaseBusyError extends WheelError {}

const MAIN_FILES_MAX_BYTES = 400000;
function branchNumber(id) { return Number(String(id || '').replace(/^b_/, '')) || 0; }

function legalToken(input) {
  return input.type === 'form' ? 'form:' + input.kind : input.type;
}

function serializableResidue(recovery) {
  return {
    cause: recovery.cause,
    detected: recovery.detected,
    lock: recovery.lock.present
      ? { present: true, holder: recovery.lock.holder || null, holder_alive: recovery.lock.alive }
      : { present: false },
    lease: recovery.lease.present
      ? {
          present: true, instance: recovery.lease.instance || null, pid: recovery.lease.pid || null,
          heartbeat: recovery.lease.heartbeat || null, age_ms: recovery.lease.age_ms,
          alive: recovery.lease.alive, interrupted: recovery.lease.interrupted,
        }
      : { present: false },
    torn: recovery.torn || null,
  };
}

const SEAT_OF_KIND = { plan_trial: 'leader', design: 'leader', execute: 'builder', review: 'reviewer' };
const SCHEMA_OF_KIND = { plan_trial: 'TRIAL_KIT', review: 'REVIEW_RESULT', design: 'DESIGN_PROPOSAL', execute: 'EXECUTION_SUBMISSION' };

class Wheel {
  constructor(opts) {
    const o = opts || {};
    storelib.ensureDirs();
    this.legacyArchive = storelib.archiveLegacyStoreIfPresent();
    this.projectId = o.project || uuidv7();
    this.paths = paths.projectPaths(this.projectId);
    this.projectArchive = storelib.archiveLegacyProjectIfPresent(this.paths);
    this.audit = (event) => storelib.audit(event, this.paths);
    const loaded = storelib.loadDetailed(this.paths);
    this.state = loaded.state;
    this.instance = o.instance || uuidv7();
    this.heartbeatMs = o.heartbeatMs || lease.HEARTBEAT_MS;
    this.leaseTimer = null;
    this.recovery = null;
    this.transport = o.transport || require('./transport').createTransport();
    this.now = o.now || nowIso; /* Record external time in events so replay stays deterministic. */
    this.deliveries = new Map();
    this.onBack = null;
    this.lateBacks = [];

    const ts = nowIso();
    const lock = commitlib.inspectLock(this.paths);
    const leaseInfo = lease.inspect(ts, this.paths);
    const foreignLease = leaseInfo.present && leaseInfo.pid !== process.pid;
    const corrupt = Boolean(loaded.torn && loaded.torn.trailing > 0);
    if (lock.present || (foreignLease && leaseInfo.interrupted) || loaded.torn) {
      let cause = 'commit lock left by an interrupted APPLYING';
      if (!lock.present && loaded.torn) cause = corrupt ? 'events journal corrupt beyond its tail' : 'torn events journal tail';
      if (!lock.present && !loaded.torn) cause = 'project lease without heartbeat';
      this.recovery = {
        detected: ts,
        cause,
        lock,
        lease: leaseInfo,
        torn: loaded.torn,
        corrupt,
        gate: gates.gateDef('RECOVERY_REQUIRED'),
      };
      this.audit({
        phase: 'INTERRUPTED', event: 'recovery_required', cause,
        lock_present: lock.present, lease_present: leaseInfo.present,
        lease_interrupted: leaseInfo.interrupted, seq: loaded.seq, torn: loaded.torn,
      });
      return; /* read-only until the human acts; nothing is cleared here */
    }
    if (foreignLease && !leaseInfo.interrupted) {
      throw new LeaseBusyError(`project lease held by live helper pid ${leaseInfo.pid}`);
    }
    this.takeLease(ts);
    if (!loaded.snapshot_fresh) commitlib.repairSnapshot(loaded.seq, this.state, this.paths);
  }

  takeLease(ts) {
    lease.acquire(this.instance, ts, this.paths);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = setInterval(() => lease.heartbeat(this.instance, nowIso(), this.paths), this.heartbeatMs);
    this.leaseTimer.unref();
  }

  close() {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    lease.release(this.instance, this.paths);
  }

  cardsJournal(row) {
    try {
      fs.mkdirSync(this.paths.dir, { recursive: true });
      fs.appendFileSync(this.paths.cardsPath, JSON.stringify({ ts: nowIso(), ...row }) + '\n');
    } catch {   }
  }

  status() {
    if (this.recovery) return 'red';
    return this.state ? this.state.status : 'unspooled';
  }

  gateView() {
    if (this.recovery) {
      return { id: 'RECOVERY_REQUIRED', def: this.recovery.gate, staged: null, cause: this.recovery.cause };
    }
    return this.state ? this.state.gate : null;
  }

  frontier() {
    return resolve(this.state, { recovery: Boolean(this.recovery) });
  }

  commit(event, outcome) {
    this.state = commitlib.commitEvent(this.state, event, outcome, { seat: 'system-commit' }, this.paths);
    return this.state;
  }

  nextEvent(type, input, facts, turnNumber, ts) {
    return {
      ...(!this.state || !this.state.controls_version ? { controls_version: 1 } : {}),
      seq: (this.state ? this.state.seq : 0) + 1,
      id: uuidv7(),
      ts,
      turn: turnId(turnNumber),
      turn_number: turnNumber,
      type,
      input,
      facts,
    };
  }

  runTurn(input) {
    const prev = this.state;
    const turnNumber = (prev ? prev.turns.last_id : 0) + 1;
    const turn = turnId(turnNumber);
    const ts = this.now();
    if (this.recovery) return this.recoveryTurn(input, turnNumber, turn, ts);

    const openFrontier = resolve(prev);
    const token = legalToken(input);
    this.audit({ phase: 'OPEN', turn, input_type: token });
    const operational = (token === 'seat_assignment' || token === 'budget_set')
      && Boolean(prev) && prev.status !== 'red';
    if (!openFrontier.next_legal.includes(token) && !operational) {
      this.audit({
        phase: 'OPEN', turn, event: 'reject',
        detail: `illegal input "${token}"; legal now: ${openFrontier.next_legal.join(', ')}`,
      });
      return {
        ok: false, turn,
        error: `illegal input "${token}"; legal now: [${openFrontier.next_legal.join(', ')}]`,
        status: prev ? prev.status : 'unspooled',
        frontier: openFrontier,
      };
    }
    if (input.type === 'egress') return this.egressTurn(prev, turnNumber, turn, ts, openFrontier);
    if (input.type === 'budget_admit') {
      const event = this.nextEvent('budget_admit', { type: 'budget_admit' }, {}, turnNumber, ts);
      let outcome;
      try { outcome = reduce(prev, event); } catch (err) { return this.executionFailed(err, prev, input, turnNumber, turn, ts, openFrontier); }
      this.commit(event, outcome);
      return { ok: true, turn, seq: this.state.seq, status: this.state.status, frontier: this.state.frontier, result: outcome.result, gate: null };
    }

    const base = prev ? baseVersions(prev) : {};
    this.audit({ phase: 'STAGING', turn, snapshot: base, lock: 'prepared' });

    const seat = SEAT_FOR_INPUT[input.type] || 'human';
    this.audit({ phase: 'WATCH_FRONTIER', turn, seat, frontier: openFrontier });

    const doc = superDoc(prev, openFrontier, input);
    this.audit({
      phase: 'COMPILE', turn, seat: doc.binding.seat, prefix: doc.prefix, budget: doc.binding.budget,
    });

    const pre = this.preCheck(prev, input);
    if (pre && !pre.ok) return this.schemaReject(prev, input, pre.errors, turnNumber, turn, ts, openFrontier);

    let facts;
    try {
      facts = this.gatherFacts(prev, input, turn, ts);
    } catch (err) {
      return this.executionFailed(err, prev, input, turnNumber, turn, ts, openFrontier);
    }

    if (facts.pull) {
      const event = this.nextEvent('pull_requested', { type: 'pull_requested', card_id: input.card_id, ids: facts.pull.ids }, facts, turnNumber, ts);
      let outcome;
      try { outcome = reduce(prev, event); } catch (err) { return this.executionFailed(err, prev, input, turnNumber, turn, ts, openFrontier); }
      this.audit({ phase: 'AGREE_OR_ESCALATE', turn, event: 'pull_requested', ids: facts.pull.ids });
      this.commit(event, outcome);
      this.audit({ phase: 'REBUILD', turn, seq: this.state.seq, status: this.state.status, stage: this.state.frontier.stage, next_legal: this.state.frontier.next_legal });
      return { ok: true, turn, seq: this.state.seq, status: this.state.status, frontier: this.state.frontier, result: outcome.result, gate: null };
    }
    let reduceFrom = prev;
    if (facts.pull_refused) {
      const { pull_refused: refusal, ...rest } = facts;
      facts = rest;
      const ev = this.nextEvent('pull_refused', { type: 'pull_refused', card_id: input.card_id, entries: refusal.entries, reason: refusal.reason }, {}, turnNumber, ts);
      const out = reduce(prev, ev);
      this.commit(ev, out);
      reduceFrom = this.state;
    }

    const event = this.nextEvent('turn', input, facts, turnNumber, ts);
    let outcome;
    try {
      outcome = reduce(reduceFrom, event);
    } catch (err) {
      return this.executionFailed(err, prev, input, turnNumber, turn, ts, openFrontier);
    }

    const post = this.postCheck(outcome.state, turn);
    if (!post.ok) return this.schemaReject(prev, input, post.errors, turnNumber, turn, ts, openFrontier);

    this.audit({ phase: 'AGREE_OR_ESCALATE', turn, event: outcome.agree_event || 'presented' });

    this.commit(event, outcome);
    this.followUps(outcome, turnNumber, ts);
    if (outcome.agree_event === 'project_done') {
      this.audit({ phase: 'DONE', event: 'PROJECT_DONE', turn, artifact: this.state.artifact ? this.state.artifact.product_link : null });
    }

    this.audit({
      phase: 'REBUILD', turn, seq: this.state.seq, status: this.state.status,
      stage: this.state.frontier.stage, next_legal: this.state.frontier.next_legal,
    });
    return {
      ok: true, turn, seq: this.state.seq, status: this.state.status,
      frontier: this.state.frontier, result: outcome.result || null,
      gate: this.state.gate ? this.state.gate.def : null,
    };
  }

  followUps(outcome, turnNumber, ts) {
    if (outcome.shelve) {
      const ev = this.nextEvent('shelved', { type: 'shelved', ...outcome.shelve }, {}, turnNumber, ts);
      const out = reduce(this.state, ev);
      this.commit(ev, out);
      this.audit({ phase: 'APPLYING', turn: ev.turn, event: 'shelved', under: outcome.shelve.under, subject: outcome.shelve.subject, reason: outcome.shelve.reason });
    }
  }

  // Raw input that fails its bound schema never executes and never enters storage.
  preCheck(prev, input) {
    switch (input.type) {
      case 'spool':
        return validate(NODE_SCHEMAS.idea, { problem: String(input.problem || ''), solution: String(input.solution || '') });
      case 'form':
        return NODE_SCHEMAS[input.kind] ? forms.admit(prev, input.kind, input.content) : null;
      case 'seat_assignment': {
        const { type: _t, ...body } = input;
        return validate(SEAT_ASSIGNMENT, body);
      }
      case 'budget_set': {
        const { type: _bt, ...body } = input;
        return validate(BUDGET_SET, body);
      }
      case 'execute': {
        const res = validate(EXECUTION_SUBMISSION, input.submission);
        if (res.ok && !(input.submission.main_file in input.submission.files) && !input.submission.build_command) {
          return { ok: false, errors: ['$: main_file must be one of the submitted files, or produced by build_command'] };
        }
        return res;
      }
      default:
        return null;
    }
  }

  postCheck(next, turn) {
    const errors = [];
    for (const kind of KINDS) {
      for (const v of next.nodes[kind].versions) {
        if (v.staged_by_turn !== turn) continue;
        const res = validate(NODE_SCHEMAS[kind], v.content);
        if (!res.ok) errors.push(...res.errors.map((e) => `${kind}${e}`));
      }
    }
    return { ok: errors.length === 0, errors };
  }

  schemaReject(prev, input, errors, turnNumber, turn, ts, openFrontier) {
    const error = 'result failed bound schema: ' + errors.slice(0, 3).join('; ');
    this.audit({ phase: 'CLOSED_RUNNING', turn, event: 'schema_reject', errors: errors.slice(0, 5) });
    if (!prev) {
      return { ok: false, turn, error, status: 'unspooled', frontier: openFrontier, schema_repair: true };
    }
    const event = this.nextEvent('schema_reject', { type: input.type, kind: input.kind || null }, { errors: errors.slice(0, 5) }, turnNumber, ts);
    const outcome = reduce(prev, event);
    this.commit(event, outcome);
    return { ok: false, turn, error, status: this.state.status, frontier: this.state.frontier, schema_repair: true };
  }

  executionFailed(err, prev, input, turnNumber, turn, ts, openFrontier) {
    if (err instanceof gates.GateError || err instanceof WheelError || err instanceof ReduceError) {
      this.audit({ phase: 'CLOSED_RUNNING', turn, event: 'reject', detail: err.message });
      return {
        ok: false, turn, error: err.message,
        status: prev ? prev.status : 'unspooled', frontier: openFrontier,
      };
    }
    if (!prev) {
      this.audit({ phase: 'CLOSED_RUNNING', turn, event: 'error', detail: String(err.message) });
      return { ok: false, turn, error: String(err.message), status: 'unspooled', frontier: openFrontier };
    }
    const event = this.nextEvent(
      'error_gated', { type: input.type },
      { error: String(err.message || err), responsible: this.responsibleKind(input) },
      turnNumber, ts
    );
    const outcome = reduce(prev, event);
    this.commit(event, outcome);
    this.audit({ phase: 'AGREE_OR_ESCALATE', turn, event: 'human_gate', detail: String(err.message) });
    return {
      ok: false, turn, error: 'HUMAN_ESCALATION opened: ' + err.message,
      status: this.state.status, frontier: this.state.frontier, gate: this.state.gate.def,
    };
  }

  responsibleKind(input) {
    if (['execute', 'plan_trial', 'plan_generate', 'finalize', 'project_done'].includes(input.type)) return 'plan';
    if (input.type === 'form') return input.kind;
    return 'idea';
  }

  gatherFacts(prev, input, turn, ts) {
    switch (input.type) {
      case 'spool': return { project_id: this.projectId, version_id: uuidv7(), schema_version: SCHEMA_VERSION };
      case 'prompt':
      case 'form': return { version_id: uuidv7() };
      case 'validate':
      case 'gate': {
        const facts = { review_id: uuidv7(), waiver_id: uuidv7() };
        const pv = prev && prev.pending_validation;
        if (pv && pv.kind === 'execution') facts.merge = this.mergeFacts(prev, pv.branch);
        return facts;
      }
      case 'plan_generate':
      case 'reopen':
      case 'seat_assignment':
      case 'budget_set':
      case 'project_done':
      case 'recover': return {};
      case 'plan_trial': return { content: this.executeTrial(prev, input.kit || {}, turn), version_id: uuidv7() };
      case 'execute': return this.executeFacts(prev, input.submission, turn);
      case 'seat_dispatch': return this.stageFacts(prev, input, turn, ts);
      case 'redispatch': return {};
      case 'seat_result': return this.seatResultFacts(prev, input, turn);
      case 'finalize': return this.finalizeFacts(prev);
      default: throw new WheelError('unknown input type: ' + input.type);
    }
  }

  executeTrial(prev, kit, turn) {
    const draft = prev && prev.nodes.plan.draft;
    if (!draft) throw new WheelError('no plan draft to try');
    return planlib.applyTrialKit(draft, kit, {
      scratchDir: path.join(paths.scratchRoot, `trial-${process.pid}-${turn}`),
    });
  }

  executeFacts(prev, submission, turn) {
    if (!prev.execution || !prev.execution.unlocked) throw new WheelError('EXECUTION_UNLOCKED is false: ' + (prev.execution ? prev.execution.reason : 'no plan'));
    if (!(submission.main_file in submission.files) && !submission.build_command) {
      throw new WheelError('main_file must be one of the submitted files, or produced by build_command');
    }
    const branch = branchId(Object.keys(prev.branches).length + 1);
    const branchesDir = this.paths.branchesDir;
    const workspace = path.join(branchesDir, branch, 'workspace');
    assertScoped('builder', 'fs_write', workspace, branchesDir);
    fs.mkdirSync(workspace, { recursive: true });
    if (prev.main && fs.existsSync(prev.main.dir)) fs.cpSync(prev.main.dir, workspace, { recursive: true });
    for (const [name, body] of Object.entries(submission.files)) {
      const target = path.join(workspace, name);
      assertScoped('builder', 'fs_write', target, branchesDir);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
    assertScoped('builder', 'exec', workspace, branchesDir);
    let build = null;
    if (submission.build_command) {
      const bargs = submission.build_command.split(' ').slice(1);
      const bres = spawnSync(process.execPath, [...confinedNodeArgs(workspace), ...bargs], { cwd: workspace, timeout: 60000, encoding: 'utf8' });
      const bout = ((bres.stdout || '') + (bres.stderr || '')).trim();
      build = { command: submission.build_command, exit_code: bres.status == null ? -1 : bres.status, output_tail: bout.slice(-2000) };
    }
    const mainPath = path.join(workspace, submission.main_file);
    let tests;
    if (build && build.exit_code !== 0) {
      tests = { command: submission.test_command, exit_code: build.exit_code, passed: 0, failed: 1, output_tail: ('build failed: ' + build.output_tail).slice(-2000) };
    } else if (!fs.existsSync(mainPath)) {
      tests = { command: submission.test_command, exit_code: 1, passed: 0, failed: 1, output_tail: 'main_file missing after build: ' + submission.main_file };
    } else {
      const args = submission.test_command.split(' ').slice(1);
      const res = spawnSync(process.execPath, [...confinedNodeArgs(workspace), ...args], {
        cwd: workspace, timeout: 60000, encoding: 'utf8',
      });
      const output = ((res.stdout || '') + (res.stderr || '')).trim();
      const m = output.match(/passed=(\d+)\s+failed=(\d+)/);
      const exit = res.status == null ? -1 : res.status;
      tests = {
        command: submission.test_command,
        exit_code: exit,
        passed: m ? Number(m[1]) : (exit === 0 ? 1 : 0),
        failed: m ? Number(m[2]) : (exit === 0 ? 0 : 1),
        output_tail: output.slice(-2000),
      };
    }
    const failed = tests.exit_code !== 0 || tests.failed > 0;
    let artifact = null;
    if (!failed) {
      const buf = fs.readFileSync(mainPath);
      artifact = { workspace_path: mainPath, sha256: sha256(buf), bytes: buf.length };
    }
    return {
      execution: { branch, workspace, tests, build, failed, artifact, base_versions: baseVersions(prev) },
      branch_id: uuidv7(),
    };
  }

  mergeFacts(prev, branch) {
    const ex = prev.executions[branch];
    if (!ex) throw new WheelError('no staged execution on ' + branch);
    const spec = currentAccepted(prev.nodes.spec);
    const outputDir = spec.content.release.output_dir;
    const target = path.join(outputDir, path.basename(ex.main_file));
    const link = spec.content.release.link_kind === 'file_url' ? pathToFileURL(target).href : null;
    return {
      branch,
      workspace: ex.workspace,
      main_dir: this.paths.mainDir,
      files: ex.files,
      main_file: ex.main_file,
      sha256: ex.artifact.sha256,
      bytes: ex.artifact.bytes,
      output_target: target,
      product_link: link,
    };
  }

  readMainFiles(state) {
    if (!state || !state.main || !fs.existsSync(state.main.dir)) return {};
    const names = [...new Set(Object.values(state.executions || {}).filter((e) => e.state === 'accepted').flatMap((e) => e.files))].sort();
    const out = {};
    let total = 0;
    for (const name of names) {
      const file = path.join(state.main.dir, name);
      if (!fs.existsSync(file)) continue;
      let text = fs.readFileSync(file, 'utf8');
      if (total + text.length > MAIN_FILES_MAX_BYTES) {
        text = text.slice(0, Math.max(0, MAIN_FILES_MAX_BYTES - total)) + '\n/* ... truncated: main exceeds the document cap ... */';
      }
      out[name] = text;
      total += text.length;
      if (total >= MAIN_FILES_MAX_BYTES) break;
    }
    return out;
  }

  seatKindFor(work, input) {
    if (work.pending_pull) return work.pending_pull.kind;
    const pv = work.pending_validation;
    if (pv && pv.author && pv.author.seat !== 'human') return 'review';
    const frontier = resolve(work);
    const target = frontier.stale.length > 0 ? frontier.stale[0] : frontier.stage;
    if (target === 'plan' && work.nodes.plan.draft) return 'plan_trial';
    if (target === 'execution' && work.execution && work.execution.unlocked && frontier.leaves.length) return 'execute';
    if (target === 'design' && input && input.kind === 'design') return 'design';
    return null;
  }

  routeFor(state, seatName) {
    const a = state.seats && state.seats[seatKeyOf(seatName)];
    if (a && a.route) return { id: a.route, cfg: a.cfg || {} };
    return null;
  }

  routeConfig(state, pd) {
    const a = state.seats && state.seats[seatKeyOf(pd.seat)];
    return a && a.route === pd.route ? a.cfg || {} : {};
  }

  lookExtra(state, kind, leaves) {
    const base = this.lookBase(state, kind, leaves);
    const pp = state && state.pending_pull;
    return pp ? { ...base, pull: pp.ids.slice(), pull_previous: pp.result } : base;
  }

  lookBase(state, kind, leaves) {
    if (kind === 'execute') return { main_files: this.readMainFiles(state), leaves, previous_attempt: this.readPreviousAttempt(state, leaves) };
    if (kind === 'review') {
      const pv = state && state.pending_validation;
      const b = pv && pv.kind === 'execution' && state.branches && state.branches[pv.branch];
      if (b && b.workspace) return { review_files: this.readWorkspaceFiles(b.workspace) };
      if (pv && pv.kind === 'closure' && state.artifact && state.artifact.path && fs.existsSync(state.artifact.path)) {
        let text = fs.readFileSync(state.artifact.path, 'utf8');
        if (text.length > MAIN_FILES_MAX_BYTES) text = text.slice(0, MAIN_FILES_MAX_BYTES) + '\n/* ... truncated: the artifact exceeds the document cap ... */';
        return { closure_artifact: text, closure_main_files: this.readMainFiles(state) };
      }
    }
    return {};
  }

  // Every regular file of a branch workspace, capped like main.
  readWorkspaceFiles(dir) {
    const out = {};
    if (!dir || !fs.existsSync(dir)) return out;
    let total = 0;
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (!fs.statSync(file).isFile()) continue;
      let text = fs.readFileSync(file, 'utf8');
      if (total + text.length > MAIN_FILES_MAX_BYTES) {
        text = text.slice(0, Math.max(0, MAIN_FILES_MAX_BYTES - total)) + '\n/* ... truncated: the workspace exceeds the document cap ... */';
      }
      out[name] = text;
      total += text.length;
      if (total >= MAIN_FILES_MAX_BYTES) break;
    }
    return out;
  }

  readPreviousAttempt(state, leaves) {
    if (!state) return null;
    const group = new Set(leaves && leaves.length ? leaves : resolve(state).leaves);
    const overlapping = Object.values(state.executions || {})
      .filter((e) => ['rejected', 'shelved', 'stale'].includes(e.state) && (e.leaves || []).some((id) => group.has(id)));
    const lf = state.last_failure;
    if (lf && lf.kind === 'plan' && lf.failed_branch && lf.tests && !overlapping.some((e) => e.branch === lf.failed_branch)) {
      const b = state.branches && state.branches[lf.failed_branch];
      if (b && (b.leaves || []).some((id) => group.has(id))) overlapping.push({ branch: lf.failed_branch, state: 'rejected', leaves: b.leaves, tests: lf.tests });
    }
    const prev = overlapping.sort((a, b) => branchNumber(a.branch) - branchNumber(b.branch)).at(-1);
    if (!prev) return null;
    const tests = prev.tests ? { exit_code: prev.tests.exit_code, passed: prev.tests.passed, failed: prev.tests.failed, output_tail: String(prev.tests.output_tail || '').slice(-2000) } : null;
    let why;
    const s = prev.staled_by;
    const merged = Boolean(state.main && (state.main.merged || []).includes(prev.branch));
    if (s && (prev.state === 'stale' || (s.claims || []).length)) {
      why = `staled by ${s.kind || 'plan'} v${s.v != null ? s.v : '?'}: ${(s.claims || []).length ? s.claims.join(', ') : 'no claim moved'}`;
    } else if (prev.state === 'shelved') {
      why = `shelved under ${prev.shelved ? prev.shelved.under : 'a reopened node'}`;
    } else {
      why = tests && (tests.exit_code !== 0 || tests.failed > 0) ? 'failed its tests' : merged ? 'returned by the final closure' : 'returned by review';
    }
    const b = state.branches && state.branches[prev.branch];
    return {
      branch: prev.branch, why, merged, state: prev.state, leaves: prev.leaves, tests,
      files: b && b.workspace ? this.readWorkspaceFiles(b.workspace) : {},
    };
  }

  stageFacts(prev, input, turn, ts) {
    if (prev.pending_seat) throw new WheelError('a seat is already working');
    if (prev.pending_dispatch) throw new WheelError('a dispatch is already staged');
    const kind = this.seatKindFor(prev, input);
    if (!kind) throw new WheelError('no seat stage to dispatch');
    const seatName = SEAT_OF_KIND[kind];
    const pp = prev.pending_pull;
    const leaves = pp ? pp.leaves : kind === 'execute' ? resolve(prev).leaves : null;
    const l = look(prev, kind, ts, this.lookExtra(prev, kind, leaves));
    const repairing = prev.last_schema_reject && prev.last_schema_reject.input_type === kind ? prev.last_schema_reject : null;
    const pulled = pp ? prev.dispatches[pp.dispatch_id] : null;
    const repair = pp ? Number((pulled && pulled.attempt) || 0) + 1 : repairing ? repairing.attempts || 0 : 0;
    let stage = kind === 'plan_trial' ? 'plan' : kind === 'design' ? 'design' : 'execution';
    const route = this.routeFor(prev, seatName);
    let review = null;
    if (kind === 'review') {
      const pv = prev.pending_validation;
      stage = pv.kind;
      const authorRoute = pv.author ? pv.author.route : null;
      const subject = pv.kind === 'execution' ? { kind: 'execution', branch: pv.branch } : pv.kind === 'closure' ? { kind: 'closure' } : { kind: pv.kind, v: pv.v };
      const rung = route && authorRoute && route.id !== authorRoute ? 1 : 2;
      review = { subject, rung, author_route: authorRoute, route: route ? route.id : null, context: 'fresh' };
    }
    return {
      dispatch_id: pp ? pp.dispatch_id : repairing && repairing.dispatch_id ? repairing.dispatch_id : uuidv7(),
      pull_ids: pp ? pp.ids.slice() : null,
      kind,
      seat_name: seatName,
      stage,
      route: route ? route.id : null,
      attempts: Number(input.attempts != null ? input.attempts : repair),
      base_versions: baseVersions(prev),
      context_hash: l.hash,
      frontier: l.frontier,
      superdoc: l.sealed,
      result_schema: SCHEMA_OF_KIND[kind],
      permissions: l.sealed.binding.permissions,
      timeout_ms: SEAT_TIMEOUT_MS[seatName === 'reviewer' ? 'review' : seatName] || SEAT_TIMEOUT_MS.builder,
      review,
      ...(leaves ? { leaves } : {}),
    };
  }

  egressTurn(prev, turnNumber, turn, ts, openFrontier) {
    const pd = prev.pending_dispatch;
    if (!pd) {
      return { ok: false, turn, error: 'no dispatch is staged', status: prev.status, frontier: openFrontier };
    }
    const l2 = look(prev, pd.kind, ts, this.lookExtra(prev, pd.kind, pd.leaves));
    const cfg = this.routeConfig(prev, pd);
    const ctx = {
      route: pd.route ? this.transport.routeById(pd.route) : null,
      readiness: pd.route ? this.transport.readiness(pd.route, cfg, { ts, project_id: prev.project.id }) : null,
      capacity: pd.route ? this.transport.capacity(pd.route, cfg, { ts, project_id: prev.project.id }) : null,
      binding: {
        project_id: prev.project.id, turn: pd.staged_by_turn, attempt: pd.attempt, seat: pd.seat,
        route: pd.route, context_hash: pd.context_hash, base_versions: pd.base_versions,
        result_schema: pd.result_schema,
      },
    };
    const guard = runGuards(prev, pd, { frontier: l2.frontier, hash: l2.hash, sealed: l2.sealed, ts }, ctx);
    // Repeat egress refusals back off without appending duplicate events.
    const last = prev.last_egress_refusal;
    const gateOpening = ['route_ready', 'route_allowlist', 'prompt_budget'].includes(guard.guard);
    const nothingNew = last && (prev.seq === last.seq || (prev.seq === last.seq + 1 && prev.last_event_type === 'seat_dispatch'));
    const repeat = !guard.ok && !gateOpening && Boolean(nothingNew) && last.route === pd.route && last.guard === guard.guard && last.reason === guard.reason;
    if (repeat) {
      return {
        ok: false, turn, guard: guard.guard, repeat: true, error: `egress refused by guard ${guard.guard}: ${guard.reason}`,
        status: prev.status, frontier: openFrontier, gate: prev.gate ? prev.gate.def : null,
      };
    }
    this.audit({ phase: 'LOOK_2', turn, dispatch_id: pd.dispatch_id, route: pd.route });
    this.audit({
      phase: 'EGRESS_GUARD', turn, dispatch_id: pd.dispatch_id, route: pd.route,
      ok: guard.ok, guard: guard.ok ? null : guard.guard, reason: guard.ok ? null : guard.reason,
      code: guard.ok ? null : (guard.code || null), checked: guard.checked,
    });
    if (!guard.ok) {
      const event = this.nextEvent(
        'egress_refused', { type: 'egress' },
        { guard: guard.guard, reason: guard.reason, checked: guard.checked, route: pd.route, dispatch_id: pd.dispatch_id },
        turnNumber, ts
      );
      const outcome = reduce(prev, event);
      this.commit(event, outcome);
      return {
        ok: false, turn, guard: guard.guard, error: `egress refused by guard ${guard.guard}: ${guard.reason}`,
        status: this.state.status, frontier: this.state.frontier, gate: this.state.gate ? this.state.gate.def : null,
      };
    }
    const envelope = {
      type: 'dispatch',
      dispatch_id: pd.dispatch_id,
      seat: pd.seat,
      kind: pd.kind,
      route: pd.route,
      superdoc: pd.superdoc,
      system_prompt: pd.superdoc.system_prompt || '',
      prompt: pd.superdoc.prompt || '',
      result_schema: pd.result_schema,
      timeout_ms: pd.timeout_ms,
      context_hash: pd.context_hash,
      base_versions: pd.base_versions,
      ...(pd.leaves ? { leaves: pd.leaves } : {}),
    };
    const sent = this.transport.send({ route: pd.route, cfg, binding: ctx.binding, envelope });
    this.trackDelivery(sent.card.id, sent.delivery);
    this.cardsJournal({ event: 'card_out', card: sent.card.id, route: pd.route, dispatch_id: pd.dispatch_id, kind: pd.kind, seat: pd.seat });
    const event = this.nextEvent('turn', { type: 'egress' }, { card_id: sent.card.id, guards: guard.checked }, turnNumber, ts);
    const outcome = reduce(prev, event);
    this.commit(event, outcome);
    this.audit({
      phase: 'CLOSED_RUNNING', turn, event: 'card_out', card: sent.card.id, route: pd.route,
      dispatch_id: pd.dispatch_id, context_hash: pd.context_hash, ...(pd.leaves ? { leaves: pd.leaves } : {}),
      ...(pd.pull ? { pull: pd.pull } : {}),
    });
    return {
      ok: true, turn, seq: this.state.seq, status: this.state.status,
      frontier: this.state.frontier, result: outcome.result, gate: null,
    };
  }

  trackDelivery(cardId, promise) {
    const p = Promise.resolve(promise).then((back) => {
      this.deliveries.delete(cardId);
      if (!back) return;
      if (this.onBack) this.onBack(back);
      else this.lateBacks.push(back);
    }, () => { this.deliveries.delete(cardId); });
    this.deliveries.set(cardId, p);
  }

  seatResultFacts(prev, input, turn) {
    const ps = prev.pending_seat;
    if (!ps) throw new WheelError('no seat is pending');
    if (input.card_id !== ps.card_id) {
      throw new WheelError(`result card ${input.card_id} does not match pending ${ps.card_id}`);
    }
    const outcome = input.outcome || 'result';
    if (!OUTCOMES.includes(outcome)) throw new WheelError('unknown outcome ' + outcome);
    const settle = (classified) => {
      if (input.via !== 'delivery') this.transport.settleById(input.card_id, classified);
    };
    if (JSON.stringify(ps.base_versions) !== JSON.stringify(baseVersions(prev))) {
      settle({ outcome, late: true });
      return { late: true, schema: { ok: true } };
    }
    // transport_error | timeout | refused never enter schema validation.
    this.audit({ phase: 'CLOSED_RUNNING', turn, event: 'outcome_classified', card: input.card_id, outcome, schema_validation: !isTransportFailure(outcome) });
    this.cardsJournal({ event: 'card_back', card: input.card_id, outcome, via: input.via || null });
    if (isTransportFailure(outcome)) {
      settle({ outcome, detail: input.detail || '' });
      return { transport: { outcome, detail: String(input.detail || '') } };
    }
    let selfAcceptanceRefused = false;
    if (input.review && input.review.decision === 'accept' && ps.kind !== 'review') {
      selfAcceptanceRefused = true;
      this.audit({
        phase: 'REVIEWING', turn, event: 'self_acceptance_refused', card: input.card_id, seat: ps.seat,
        detail: 'the author turn cannot accept its own result; an independent review turn must',
      });
    }
    const schema = ps.kind === 'plan_trial' ? TRIAL_KIT : ps.kind === 'review' ? REVIEW_RESULT : ps.kind === 'design' ? DESIGN_PROPOSAL : EXECUTION_SUBMISSION;
    let check;
    if (outcome === 'malformed' && input.result === undefined) {
      check = { ok: false, errors: (input.errors && input.errors.length) ? input.errors : ['malformed: ' + (input.detail || 'unparseable reply')] };
    } else {
      const normalized = normalizeResult(ps.kind === 'plan_trial' ? 'TRIAL_KIT' : null, input.result);
      if (normalized.folded.length) {
        this.audit({ phase: 'CLOSED_RUNNING', turn, event: 'kit_normalized', card: input.card_id, folded: normalized.folded });
        input.result = normalized.value;
      }
      check = validate(schema, input.result);
    }
    let pullRefused = null;
    if (check.ok && input.result && typeof input.result === 'object') {
      const asked = Array.isArray(input.result.requested_expansions) ? input.result.requested_expansions.slice() : [];
      delete input.result.requested_expansions;
      if (asked.length) {
        const verdict = this.judgePull(prev, ps, asked);
        if (verdict.ok) {
          settle({ outcome: 'result', pull: verdict.ids });
          this.audit({ phase: 'CLOSED_RUNNING', turn, event: 'pull_requested', card: input.card_id, seat: ps.seat, ids: verdict.ids });
          return { schema: { ok: true }, pull: { ids: verdict.ids, result: input.result } };
        }
        pullRefused = verdict;
        this.audit({ phase: 'CLOSED_RUNNING', turn, event: 'pull_refused', card: input.card_id, seat: ps.seat, entries: verdict.entries, reason: verdict.reason });
      }
    }
    if (check.ok && ps.kind === 'execute') {
      const s = input.result;
      if (!(s.main_file in s.files) && !s.build_command) {
        check.ok = false;
        check.errors = ['$: main_file must be one of the submitted files, or produced by build_command'];
      } else if (ps.leaves && s.leaves.some((id) => !ps.leaves.includes(id))) {
        check.ok = false;
        check.errors = [`$.leaves: only the dispatched leaves may be claimed (${ps.leaves.join(', ')})`];
      }
    }
    if (check.ok && ps.kind === 'design') {
      const errs = forms.invariants(prev, 'design', input.result);
      if (errs.length) { check.ok = false; check.errors = errs; }
    }
    if (!check.ok) {
      const kept = input.raw != null ? { raw: input.raw, raw_cut: input.raw_cut || null } : keepRaw(input.result !== undefined ? JSON.stringify(input.result) : '');
      settle({ outcome: 'malformed', errors: check.errors.slice(0, 5), raw: kept.raw, raw_cut: kept.raw_cut });
      return { schema: { ok: false, errors: check.errors.slice(0, 5) }, raw: kept.raw, raw_cut: kept.raw_cut, normalizations: input.normalizations || [] };
    }
    settle({ outcome: 'result', result: input.result });
    const author = { seat: ps.seat, route: ps.route, dispatch_id: ps.dispatch_id, card_id: input.card_id };
    const refused = pullRefused ? { pull_refused: { entries: pullRefused.entries, reason: pullRefused.reason } } : {};
    if (ps.kind === 'review') {
      const facts = { schema: { ok: true }, review_id: uuidv7(), ...refused };
      const pv = prev.pending_validation;
      if (pv && pv.kind === 'execution') facts.merge = this.mergeFacts(prev, pv.branch);
      return facts;
    }
    if (ps.kind === 'design') {
      return { schema: { ok: true }, version_id: uuidv7(), author, ...refused };
    }
    if (ps.kind === 'plan_trial') {
      return { schema: { ok: true }, content: this.executeTrial(prev, input.result, turn), version_id: uuidv7(), author, self_acceptance_refused: selfAcceptanceRefused, ...refused };
    }
    return { schema: { ok: true }, ...this.executeFacts(prev, input.result, turn), author, self_acceptance_refused: selfAcceptanceRefused, ...refused };
  }

  judgePull(prev, ps, asked) {
    const dispatch = prev.dispatches[ps.dispatch_id];
    if (dispatch && (dispatch.pulls || 0) >= 1) return { ok: false, entries: asked.slice(), reason: 'one pull per turn; this turn already pulled' };
    if (asked.length > 8) return { ok: false, entries: asked.slice(8), reason: 'at most eight ids' };
    const plan = currentAccepted(prev.nodes.plan);
    const source = plan && !prev.nodes.plan.stale && !prev.nodes.plan.reopened ? plan.content.root : prev.nodes.plan.draft;
    const map = new Set([...KINDS, ...(source ? planlib.collectLeaves(source).map((l) => l.id) : [])]);
    const offending = [];
    for (const raw of asked) {
      const id = String(raw);
      const lower = id.trim().toLowerCase();
      if (lower === 'all' || lower === 'the repo' || /[\/*?]/.test(id) || !map.has(id)) offending.push(id);
    }
    if (offending.length) return { ok: false, entries: offending, reason: 'not in the map: ' + offending.join(', ') };
    return { ok: true, ids: [...new Set(asked.map(String))] };
  }

  finalizeFacts(prev) {
    const plan = currentAccepted(prev.nodes.plan);
    if (!plan || !planlib.allRequiredDone(plan.content, prev.leaves || {}) || !prev.main) {
      throw new WheelError('finalize needs every required leaf done on main');
    }
    return { proof: finalClosure(prev) };
  }

  previewReopen(kind) {
    if (!this.state || !KINDS.includes(kind)) return { ok: false, error: 'unknown node kind' };
    const cur = currentAccepted(this.state.nodes[kind]);
    if (!cur) return { ok: false, error: kind + ' has no accepted version to reopen' };
    const plan = currentAccepted(this.state.nodes.plan);
    let leaves = [];
    if (plan && kind !== 'plan') {
      const moving = new Set(claimIds(kind, cur.content));
      const affected = reachedBy(plan.content.root, moving);
      leaves = planlib.collectLeaves(plan.content.root).filter((l) => affected.has(l.id)).map((l) => ({ id: l.id, state: planlib.leafState(l, this.state.leaves || {}) }));
    } else if (plan) {
      leaves = planlib.collectLeaves(plan.content.root).map((l) => ({ id: l.id, state: planlib.leafState(l, this.state.leaves || {}) }));
    }
    return { ok: true, kind, claims: claimIds(kind, cur.content), leaves_back_to_untried: leaves, legal: this.frontier().next_legal.includes('reopen') };
  }

  recoveryTurn(input, turnNumber, turn, ts) {
    const gate = this.recovery.gate;
    const refuse = (error) => ({
      ok: false, turn, error, status: 'red', frontier: this.frontier(), gate,
    });
    if (input.type !== 'gate') {
      this.audit({ phase: 'INTERRUPTED', turn, event: 'reject', detail: `refused "${legalToken(input)}": RECOVERY_REQUIRED is open` });
      return refuse(`RECOVERY_REQUIRED: ${gate.question}`);
    }
    try {
      gates.assertLegal('RECOVERY_REQUIRED', input.action);
    } catch (err) {
      return refuse(err.message);
    }
    const residue = serializableResidue(this.recovery);
    let reconciled = [];
    if ((input.action === 'RETRY' || input.action === 'RESUME') && typeof this.transport.reconcile === 'function') {
      reconciled = this.transport.reconcile(this.projectId, [...this.deliveries.keys()]);
      for (const row of reconciled) {
        this.audit({ phase: 'RECOVERY', event: 'dead_card_closed', action: input.action, card: row.card_id, route: row.route, binary: row.binary, outcome: row.outcome, detail: row.detail });
        this.cardsJournal({ event: 'card_back', card: row.card_id, outcome: row.outcome, via: 'recovery' });
      }
    }
    const clearedLock = commitlib.clearLockByHumanGate({ gate: 'RECOVERY_REQUIRED', action: input.action, turn }, this.paths);
    const clearedLease = lease.releaseByHumanGate({ gate: 'RECOVERY_REQUIRED', action: input.action }, this.paths);
    if (this.recovery.torn) commitlib.repairTornTail(this.recovery.torn, { gate: 'RECOVERY_REQUIRED', action: input.action, turn }, this.paths);
    this.audit({
      phase: 'RECOVERY', turn, event: 'human_gate_action', action: input.action,
      cleared_lock: clearedLock, cleared_lease: clearedLease, cause: this.recovery.cause,
      dead_cards_closed: reconciled.map((r) => r.card_id),
    });
    this.takeLease(ts);
    if (!this.state) {
      this.recovery = null;
      return { ok: true, turn, status: 'unspooled', frontier: resolve(null), result: { recovered: true, action: input.action }, gate: null };
    }
    const event = this.nextEvent(
      'recovery',
      { type: 'gate', gate: 'RECOVERY_REQUIRED', action: input.action, reply: String(input.reply || '') },
      { residue, reconciled: reconciled.map((r) => ({ card_id: r.card_id, route: r.route, outcome: r.outcome })) },
      turnNumber, ts
    );
    const outcome = reduce(this.state, event);
    this.commit(event, outcome);
    this.recovery = null;
    return {
      ok: true, turn, seq: this.state.seq, status: this.state.status, frontier: this.state.frontier,
      result: outcome.result, gate: this.state.gate ? this.state.gate.def : null,
    };
  }
}

module.exports = { Wheel, WheelError, LeaseBusyError, SEAT_OF_KIND };
