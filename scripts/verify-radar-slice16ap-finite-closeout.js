'use strict';

/**
 * verify:radar-slice16ap-finite-closeout — RADAR Slice 16AP
 *
 * Deterministic offline closeout gate. Canonical freeze + production
 * validateCloseout live solely in scripts/lib/radar-slice16ap-finite-closeout.js.
 * This executable imports and invokes that exported validator for committed
 * GREEN evidence and every RED — no duplicate/local validator.
 *
 * Threat boundary (honest): asserts module.exports immutability only. Does not
 * claim defense against require.cache replacement or process-level injection.
 *
 * Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const locksPath = path.join(__dirname, 'lib', 'radar-slice16ap-finite-closeout.js');
const locks = require(locksPath);
const tipHelperPath = path.join(__dirname, 'lib', 'radar-16ap-locked-candidate-tip.js');
const tipHelper = require(tipHelperPath);
const {
  tipAccepts16ap,
  tipContainsCandidate,
  currentBranch,
  currentHeadSha,
  makeSyntheticDescendantOfCandidate,
  makeUnrelatedOrphanCommit,
  MERGE_SHA,
} = tipHelper;
const {
  validateCloseout,
  computeLockHash,
  deepEqual,
  deepClone,
  thaw,
} = locks;

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const greenResults = [];
const redResults = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function green(name, cond, detail) {
  greenResults.push({ id: name, ok: !!cond });
  return ok(`GREEN ${name}`, cond, detail);
}

function red(name, cond, detail) {
  redResults.push({ id: name, ok: !!cond });
  return ok(`RED   ${name}`, cond, detail);
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function overclaimHits(text) {
  const hits = [];
  const lines = String(text).split(/\n/);
  const neg = /not claimed|does\s*\*+\s*not|does not|never|open|forbidden|explicitly|remain|retained|without|absent|blocked|reject|break-glass|break_glass/i;
  const bad = [
    /\bG0[1-9]\s+proven\b/i,
    /\bfull\s+G06\b/i,
    /\bG06\s+proven\b/i,
    /\bbackpressure\s+proven\b/i,
    /\bproduction\s+ready\b/i,
    /\ball\s+gates\s+proven\b/i,
    /\bgaps\s+erased\b/i,
  ];
  for (const line of lines) {
    if (neg.test(line)) continue;
    for (const re of bad) {
      if (re.test(line)) hits.push(line.trim().slice(0, 120));
    }
  }
  return hits;
}

function runtimePathsUnchanged() {
  try {
    // Compare 16AP master basis vs merge tip only. Later unrelated master
    // commits must not fail this green when re-run nested on detached master.
    const out = execSync(
      `git diff --name-only ${locks.MASTER_BASIS} ${MERGE_SHA} -- ${locks.MUST_NOT_MUTATE.join(' ')}`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    return { ok: out === '', detail: out || '(clean)' };
  } catch (err) {
    return { ok: false, detail: String(err && err.message) };
  }
}

function findGate(evidence, gateId) {
  return evidence.gate_evidence_freeze.find((g) => g.id === gateId);
}

function mutateAndValidate(mutator) {
  const bad = deepClone(readJson(locks.EVIDENCE_REL));
  mutator(bad);
  bad.lock_hash = computeLockHash(bad);
  return validateCloseout(bad);
}

function everyDescriptorImmutable(obj) {
  const names = Object.getOwnPropertyNames(obj);
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(obj, name);
    if (!d || d.writable !== false || d.configurable !== false) return false;
  }
  return names.length > 0;
}

function allNestedFrozen(value, seen) {
  const visited = seen || new WeakSet();
  if (value === null || typeof value !== 'object') return true;
  if (visited.has(value)) return true;
  visited.add(value);
  if (!Object.isFrozen(value)) return false;
  if (Array.isArray(value)) {
    return value.every((item) => allNestedFrozen(item, visited));
  }
  return Object.keys(value).every((k) => allNestedFrozen(value[k], visited));
}

function tryAssign(obj, key, value) {
  try {
    obj[key] = value;
    return { threw: false, current: obj[key] };
  } catch (err) {
    return { threw: true, current: obj[key], error: err };
  }
}

function tryDefine(obj, key, value) {
  try {
    Object.defineProperty(obj, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    return { threw: false, current: obj[key] };
  } catch (err) {
    return { threw: true, current: obj[key], error: err };
  }
}

console.log('RADAR 16AP finite milestone closeout — offline verifier\n');

ok('C0 locks identity',
  locks.SLICE === 'RADAR-16AP'
  && locks.OUTCOME_ID === '16AP_finite_milestone_closeout'
  && locks.BRANCH === 'radar/slice-16ap-finite-closeout'
  && locks.MASTER_BASIS === '66e34a5833ff3bcc7f297108f594b4fc58a0eccc'
  && locks.CANDIDATE_SHA === '7870a9fb818bbd94d33b291c8782851276e2715e'
  && locks.BREAK_GLASS
  && locks.BREAK_GLASS.id === '16AP_unconditional_break_glass'
  && locks.RESIDUAL_RISKS.length === 10
  && locks.REOPEN_TRIGGERS.length === 5
  && locks.REOPEN_TRIGGERS.every((t) => t.id && t.description && t.threshold && t.applicability)
  && typeof locks.validateCloseout === 'function'
  && locks.VALIDATOR_EXPORT === 'validateCloseout'
  && locks.MODULE_REL === 'scripts/lib/radar-slice16ap-finite-closeout.js'
  && locks.THREAT_BOUNDARY
  && /require\.cache|code injection/i.test(locks.THREAT_BOUNDARY.summary)
  && locks.THREAT_BOUNDARY.not_claimed.includes('require_cache_replacement'));

const evidence = readJson(locks.EVIDENCE_REL);
const sliceContract = readJson(locks.CONTRACT_REL);
const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
const topContract = readJson('fixtures/radar-operations/contract.json');
const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
const findings = readText('fixtures/radar-operations/findings.md');
const pkg = readJson('package.json');

{
  const branch = currentBranch(ROOT);
  const head = currentHeadSha(ROOT);
  ok('C1 HEAD tip contains locked 16AP candidate (ancestry-only; branch informational)',
    tipAccepts16ap(head, branch, ROOT)
    && tipHelper.CANDIDATE_SHA === locks.CANDIDATE_SHA
    && tipHelper.BRANCH === locks.BRANCH
    && tipHelper.MASTER_BASIS === locks.MASTER_BASIS
    && fs.existsSync(tipHelperPath)
    && !/===\s*locks\.BRANCH\)\s*return\s*true/.test(fs.readFileSync(__filename, 'utf8'))
    && !/===\s*BRANCH\)\s*return\s*true/.test(fs.readFileSync(tipHelperPath, 'utf8')),
    `branch=${branch} head=${head}`);
}

ok('C2 evidence/contract identity locked',
  evidence.slice === locks.SLICE
  && evidence.outcome_id === locks.OUTCOME_ID
  && evidence.branch === locks.BRANCH
  && evidence.master_basis === locks.MASTER_BASIS
  && sliceContract.slice === locks.SLICE
  && sliceContract.outcome_id === locks.OUTCOME_ID
  && sliceContract.branch === locks.BRANCH
  && sliceContract.master_basis === locks.MASTER_BASIS);

{
  const v = validateCloseout(evidence);
  ok('C3 production validation path accepts committed evidence',
    v.ok,
    v.errors.join('; '));
}

ok('C4 audit-only + no live mutation/deploy',
  evidence.audit_only === true
  && evidence.live_mutation === false
  && evidence.this_slice_deploys === false
  && sliceContract.live_mutation === false
  && sliceContract.this_slice_deploys === false
  && matrix.live_mutation === false
  && topContract.live_mutation === false);

ok('C5 tip matrix/contract 16AP + selected_16ap',
  matrix.slice === locks.SLICE
  && topContract.slice === locks.SLICE
  && matrix.branch === locks.BRANCH
  && topContract.branch === locks.BRANCH
  && matrix.master_basis === locks.MASTER_BASIS
  && topContract.master_basis === locks.MASTER_BASIS
  && matrix.slice_16ap_selection
  && matrix.slice_16ap_selection.outcome_id === locks.OUTCOME_ID
  && topContract.selected_16ap
  && topContract.selected_16ap.outcome_id === locks.OUTCOME_ID
  && topContract.radar_current_stage === 'complete_under_bounded_staging_readiness_exit'
  && topContract.formal_gates_status === 'all_nine_remain_partial'
  && topContract.break_glass === locks.BREAK_GLASS.id
  && Array.isArray(topContract.reopen_triggers)
  && deepEqual(
    topContract.reopen_triggers,
    locks.REOPEN_TRIGGERS.map((t) => t.id),
  ));

ok('C6 expected-contract encodes canonical freeze (not evidence-as-oracle)',
  deepEqual(sliceContract.frozen_score, thaw(locks.FROZEN_SCORE))
  && deepEqual(sliceContract.reopen_triggers, thaw(locks.REOPEN_TRIGGERS))
  && deepEqual(sliceContract.break_glass, thaw(locks.BREAK_GLASS))
  && deepEqual(sliceContract.residual_risks, thaw(locks.RESIDUAL_RISKS))
  && deepEqual(sliceContract.factory_handoff_gate, thaw(locks.FACTORY_HANDOFF_GATE))
  && deepEqual(sliceContract.gate_evidence_freeze, thaw(locks.GATE_EVIDENCE_FREEZE))
  && sliceContract.canonical_freeze_source
    === 'scripts/lib/radar-slice16ap-finite-closeout.js'
  && sliceContract.production_validator === 'validateCloseout'
  && sliceContract.threat_boundary
  && /require\.cache|code injection/i.test(String(sliceContract.threat_boundary.summary || '')));

ok('C7 canonical locks independent of mutable evidence file bytes',
  !deepEqual(thaw(locks.RESIDUAL_RISKS), [])
  && locks.BREAK_GLASS.categories.length === 5
  && locks.GATE_EVIDENCE_FREEZE.every((g) => g.formal_verdict === 'partial')
  && Object.isFrozen(locks.BREAK_GLASS)
  && Object.isFrozen(locks.REOPEN_TRIGGERS)
  && Object.isFrozen(locks.RESIDUAL_RISKS)
  && Object.isFrozen(locks.GATE_EVIDENCE_FREEZE));

ok('C8 no local duplicate validateCloseout in verifier source',
  (() => {
    const src = fs.readFileSync(__filename, 'utf8');
    // Must import/destructure exported validator; must not declare a local function.
    const hasImport = /validateCloseout/.test(src)
      && /require\(locksPath\)|require\(['"].*radar-slice16ap-finite-closeout/.test(src);
    const hasLocalFn = /function\s+validateCloseout\s*\(/.test(src);
    return hasImport && !hasLocalFn;
  })());

// ── Export immutability assertions ──────────────────────────────────────────
green('export_object_frozen', Object.isFrozen(locks));

green('export_descriptors_immutable', everyDescriptorImmutable(locks));

green('nested_locks_frozen',
  allNestedFrozen(locks.FROZEN_SCORE)
  && allNestedFrozen(locks.GATE_EVIDENCE_FREEZE)
  && allNestedFrozen(locks.STAGING_READINESS_EXIT)
  && allNestedFrozen(locks.REOPEN_TRIGGERS)
  && allNestedFrozen(locks.BREAK_GLASS)
  && allNestedFrozen(locks.FACTORY_HANDOFF_GATE)
  && allNestedFrozen(locks.RESIDUAL_RISKS)
  && allNestedFrozen(locks.EXPLICITLY_NOT_CLAIMED)
  && allNestedFrozen(locks.REQUIRED_RED)
  && allNestedFrozen(locks.REQUIRED_GREEN)
  && allNestedFrozen(locks.THREAT_BOUNDARY));

{
  const beforeScore = locks.FROZEN_SCORE;
  const beforeValidator = locks.validateCloseout;
  const assignTop = tryAssign(locks, 'FROZEN_SCORE', { proven: 9, partial: 0, absent: 0, total: 9 });
  const defineTop = tryDefine(locks, 'validateCloseout', () => ({ ok: true, errors: [] }));
  const assignNested = tryAssign(locks.FROZEN_SCORE, 'proven', 9);
  const assignRisk = tryAssign(locks.RESIDUAL_RISKS[0], 'severity', 'mutated');
  const assignTrigger = tryAssign(locks.REOPEN_TRIGGERS[0], 'threshold', 'never');
  const assignBg = tryAssign(locks.BREAK_GLASS, 'never_delays_or_prohibits', false);
  green('export_mutation_attempts_fail',
    locks.FROZEN_SCORE === beforeScore
    && locks.validateCloseout === beforeValidator
    && locks.FROZEN_SCORE.proven === 0
    && locks.RESIDUAL_RISKS[0].severity === 'high'
    && locks.REOPEN_TRIGGERS[0].threshold !== 'never'
    && locks.BREAK_GLASS.never_delays_or_prohibits === true
    && (assignTop.threw || assignTop.current === beforeScore)
    && (defineTop.threw || defineTop.current === beforeValidator)
    && (assignNested.threw || assignNested.current === 0)
    && (assignRisk.threw || assignRisk.current === 'high')
    && (assignTrigger.threw || assignTrigger.current !== 'never')
    && (assignBg.threw || assignBg.current === true));
}

green('validator_imported_identity',
  typeof validateCloseout === 'function'
  && validateCloseout === locks.validateCloseout
  && path.normalize(locksPath).endsWith(path.normalize(locks.MODULE_REL.replace(/^scripts\//, '')))
  && fs.existsSync(locksPath)
  && /function validateCloseout|validateCloseout\(evidence\)/.test(fs.readFileSync(locksPath, 'utf8'))
  && !/function\s+validateCloseout\s*\(/.test(fs.readFileSync(__filename, 'utf8')));

{
  // GREEN: candidate, merge tip, current descendant, synthetic descendant — all via ancestry.
  const head = currentHeadSha(ROOT);
  const branch = currentBranch(ROOT);
  let synthOk = false;
  let synthSha = '';
  try {
    synthSha = makeSyntheticDescendantOfCandidate(ROOT);
    synthOk = tipAccepts16ap(synthSha, 'HEAD', ROOT) === true
      && tipContainsCandidate(synthSha, ROOT) === true;
  } catch (err) {
    synthOk = false;
    synthSha = String(err && err.message);
  }
  green('candidate_descendant_or_master_accepted',
    tipAccepts16ap(locks.CANDIDATE_SHA, 'HEAD', ROOT) === true
    && tipAccepts16ap(MERGE_SHA, 'HEAD', ROOT) === true
    && tipAccepts16ap(head, branch, ROOT) === true
    && tipContainsCandidate(locks.CANDIDATE_SHA, ROOT) === true
    && tipContainsCandidate(MERGE_SHA, ROOT) === true
    && tipContainsCandidate(head, ROOT) === true
    && synthOk,
    `branch=${branch} head=${head} synth=${synthSha}`);
}

// ── GREENS ──────────────────────────────────────────────────────────────────
green('score_frozen_0_9_0',
  deepEqual(evidence.frozen_score, thaw(locks.FROZEN_SCORE))
  && matrix.verdict_counts.proven === 0
  && matrix.verdict_counts.partial === 9
  && matrix.verdict_counts.absent === 0
  && topContract.expected_verdict_counts.proven === 0
  && topContract.expected_verdict_counts.partial === 9
  && topContract.expected_verdict_counts.absent === 0
  && deepEqual(sliceContract.frozen_score, thaw(locks.FROZEN_SCORE)));

green('all_gates_formal_partial',
  Array.isArray(matrix.gates)
  && matrix.gates.length === 9
  && matrix.gates.every((g) => g.verdict === 'partial')
  && evidence.gate_evidence_freeze.every((g) => g.formal_verdict === 'partial')
  && locks.GATE_EVIDENCE_FREEZE.every((g) => g.formal_verdict === 'partial'));

green('gate_freeze_deep_compare_canonical',
  deepEqual(evidence.gate_evidence_freeze, thaw(locks.GATE_EVIDENCE_FREEZE))
  && validateCloseout(evidence).ok);

green('residual_risks_deep_compare_canonical',
  deepEqual(evidence.residual_risks, thaw(locks.RESIDUAL_RISKS))
  && evidence.residual_risks.length === 10
  && evidence.residual_risks.every((r) => (
    r.id && r.severity && r.owner && r.description && r.status === 'open_retained'
  )));

green('reopen_triggers_deep_compare_canonical',
  deepEqual(evidence.reopen_triggers, thaw(locks.REOPEN_TRIGGERS))
  && evidence.reopen_triggers.every((t) => (
    t.id && t.description && t.threshold && t.applicability
  ))
  && /reopen/i.test(doc)
  && /threshold/i.test(doc)
  && /third tenant|FACTORY/i.test(doc));

green('factory_handoff_deep_compare_canonical',
  deepEqual(evidence.factory_handoff_gate, thaw(locks.FACTORY_HANDOFF_GATE))
  && topContract.factory_handoff_gate === locks.FACTORY_HANDOFF_GATE.id
  && /FACTORY handoff|factory_handoff/i.test(doc));

green('break_glass_deep_compare_canonical',
  deepEqual(evidence.break_glass, thaw(locks.BREAK_GLASS))
  && /break-glass|break_glass|unconditional/i.test(doc)
  && /never delay|never delays|must never delay/i.test(doc)
  && /credential compromise/i.test(doc)
  && /immediately/i.test(doc)
  && /after stabilization|follows after stabilization/i.test(doc));

green('staging_readiness_exit_complete_not_proven',
  deepEqual(evidence.staging_readiness_exit, thaw(locks.STAGING_READINESS_EXIT))
  && /staging-readiness|staging readiness/i.test(doc)
  && /current-stage complete|current_stage.*complete/i.test(doc + findings));

{
  const g06 = findGate(evidence, 'G06_scaling_capacity');
  const sub = g06 && g06.g06_subcontrol_freeze;
  const expectedSub = thaw(locks.GATE_EVIDENCE_FREEZE.find((g) => g.id === 'G06_scaling_capacity').g06_subcontrol_freeze);
  green('g06_subcontrols_honest',
    deepEqual(sub, expectedSub)
    && sub.overload_shed === 'open'
    && sub.fairness === 'open'
    && sub.soak === 'open'
    && sub.autoscale === 'open'
    && sub.live_slo === 'open'
    && sub.alert_fire === 'open'
    && sub.production === 'open'
    && /overload shed|overload_shed/i.test(doc)
    && /fairness/i.test(doc)
    && /soak/i.test(doc)
    && /autoscale/i.test(doc));
}

{
  const rt = runtimePathsUnchanged();
  green('runtime_paths_unchanged', rt.ok, rt.detail);
}

green('package_script_registered',
  pkg.scripts['verify:radar-slice16ap-finite-closeout']
    === 'node scripts/verify-radar-slice16ap-finite-closeout.js');

green('16ao_activation_retained',
  topContract.g06_admission_activation === 'live_proven_via_16AO'
  && topContract.selected_16ao
  && topContract.selected_16ao.outcome_id === '16AO_g06_backpressure_activation_evidence'
  && topContract.g06_backpressure === 'open'
  && matrix.slice_16ao_selection
  && matrix.slice_16ao_selection.outcome_id === '16AO_g06_backpressure_activation_evidence'
  && /16AO/i.test(doc)
  && /0000525/.test(doc));

green('no_doc_overclaim',
  overclaimHits(doc).length === 0
  && overclaimHits(findings).length === 0
  && /16AP/i.test(doc)
  && /16AP/i.test(findings)
  && /0\/9\/0|proven=0.*partial=9.*absent=0/i.test(doc)
  && /require\.cache|export immutability|module\.exports/i.test(doc),
  overclaimHits(doc + findings).join(' | '));

// ── REDS (same imported production validation path after recomputed lock_hash)
{
  const v = mutateAndValidate((bad) => {
    bad.frozen_score.proven = 1;
    bad.frozen_score.partial = 8;
  });
  red('score_inflation_proven_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    bad.frozen_score.partial = 8;
  });
  red('score_inflation_partial_drift_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    const g01 = findGate(bad, 'G01_correlation_structured_logs');
    g01.source_proven.pop();
  });
  red('source_proven_item_deletion_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    const g02 = findGate(bad, 'G02_readiness_dependencies');
    g02.staging_live_partial.pop();
  });
  red('staging_live_partial_item_deletion_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    const g06 = findGate(bad, 'G06_scaling_capacity');
    g06.production_only_unknowns.pop();
  });
  red('production_only_unknowns_item_deletion_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    const g06 = findGate(bad, 'G06_scaling_capacity');
    g06.retained_gaps.pop();
  });
  red('retained_gaps_item_deletion_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    const g06 = findGate(bad, 'G06_scaling_capacity');
    g06.retained_gaps[0] = 'MUTATED_GAP_ERASURE';
  });
  red('retained_gaps_item_mutation_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    findGate(bad, 'G06_scaling_capacity').formal_verdict = 'proven';
  });
  red('formal_gate_proven_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    findGate(bad, 'G01_correlation_structured_logs').deferred_owner = 'drifted-owner';
  });
  red('owner_drift_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    bad.residual_risks = bad.residual_risks.filter((r) => r.id !== 'production_scope');
  });
  red('residual_risk_deletion_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    bad.residual_risks[0].severity = 'low';
  });
  red('residual_risk_severity_drift_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    bad.residual_risks[5].owner = 'drifted-owner';
  });
  red('residual_risk_owner_drift_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    bad.reopen_triggers = bad.reopen_triggers.filter((t) => t.id !== 'production_launch');
  });
  red('reopen_trigger_deletion_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    const a = bad.reopen_triggers.find((t) => t.id === 'production_launch');
    const b = bad.reopen_triggers.find((t) => t.id === 'incident');
    a.requires_trigger_ids = ['incident'];
    b.requires_trigger_ids = ['production_launch'];
  });
  red('reopen_trigger_circular_weakening_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    const t = bad.reopen_triggers.find((x) => x.id === 'traffic_or_cost_threshold');
    t.threshold = 'never';
    t.applicability = 'never_applies';
  });
  red('reopen_trigger_impossible_weakening_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    bad.factory_handoff_gate.required = bad.factory_handoff_gate.required
      .filter((x) => x !== 'successor_RADAR_slice_requires_reopen_trigger');
    bad.factory_handoff_gate.blocked_without_reopen = [];
  });
  red('factory_handoff_weakening_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    delete bad.break_glass;
  });
  red('break_glass_deletion_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    bad.break_glass.categories = bad.break_glass.categories
      .filter((c) => c.id !== 'credential_compromise_response');
  });
  red('break_glass_category_deletion_rejected', !v.ok);
}
{
  const fakeDoc = 'RADAR current-stage is production ready and all gates proven.\n';
  red('production_ready_claim_rejected', overclaimHits(fakeDoc).length > 0);
}
{
  const fakeDoc = 'G06 proven with full G06 closed.\n';
  red('full_g06_claim_rejected', overclaimHits(fakeDoc).length > 0);
}
{
  const fakeDoc = 'backpressure proven in staging.\n';
  red('backpressure_proven_claim_rejected', overclaimHits(fakeDoc).length > 0);
}
{
  const v = mutateAndValidate((bad) => {
    bad.factory_handoff_gate.blocked_without_reopen = bad.factory_handoff_gate.blocked_without_reopen
      .filter((x) => x !== 'additional_RADAR_implementation_expansion_slices');
  });
  red('endless_slice_without_reopen_rejected', !v.ok);
}
{
  const bad = deepClone(evidence);
  bad.lock_hash = '0'.repeat(64);
  red('lock_hash_mismatch_rejected', !validateCloseout(bad).ok);
}
{
  const v = mutateAndValidate((bad) => {
    const g06 = findGate(bad, 'G06_scaling_capacity');
    g06.g06_subcontrol_freeze.overload_shed = 'live_proven';
    g06.g06_subcontrol_freeze.production = 'live_proven';
  });
  red('g06_open_subcontrol_flip_rejected', !v.ok);
}

// ── Systematic looped REDs (same imported validator + recomputed lock_hash) ─
{
  let allOk = true;
  let count = 0;
  for (let gi = 0; gi < locks.GATE_EVIDENCE_FREEZE.length; gi += 1) {
    for (const field of locks.GATE_SCALAR_FIELDS) {
      const v = mutateAndValidate((bad) => {
        const row = bad.gate_evidence_freeze[gi];
        if (field === 'formal_verdict') row[field] = 'proven';
        else if (field === 'evidence_class') row[field] = 'MUTATED_CLASS';
        else if (field === 'deferred_owner') row[field] = 'MUTATED_OWNER';
        else row[field] = `MUTATED_${field}`;
      });
      count += 1;
      if (v.ok) allOk = false;
    }
    // Whole-row replacement
    {
      const v = mutateAndValidate((bad) => {
        bad.gate_evidence_freeze[gi] = {
          id: bad.gate_evidence_freeze[gi].id,
          formal_verdict: 'proven',
          evidence_class: 'erased',
          source_proven: [],
          staging_live_partial: [],
          production_only_unknowns: [],
          retained_gaps: [],
          deferred_owner: 'erased',
        };
      });
      count += 1;
      if (v.ok) allOk = false;
    }
  }
  red('systematic_gate_row_field_mutations_rejected', allOk && count >= 9 * (locks.GATE_SCALAR_FIELDS.length + 1),
    `count=${count}`);
}

{
  let allOk = true;
  let count = 0;
  for (let gi = 0; gi < locks.GATE_EVIDENCE_FREEZE.length; gi += 1) {
    const exp = locks.GATE_EVIDENCE_FREEZE[gi];
    for (const field of locks.GATE_ARRAY_FIELDS) {
      const arr = exp[field] || [];
      for (let ai = 0; ai < arr.length; ai += 1) {
        const v = mutateAndValidate((bad) => {
          bad.gate_evidence_freeze[gi][field][ai] = `MUTATED_${field}_${ai}`;
        });
        count += 1;
        if (v.ok) allOk = false;
      }
      // Deletion of last item when present
      if (arr.length > 0) {
        const v = mutateAndValidate((bad) => {
          bad.gate_evidence_freeze[gi][field].pop();
        });
        count += 1;
        if (v.ok) allOk = false;
      }
    }
  }
  red('systematic_gate_array_item_mutations_rejected', allOk && count > 0, `count=${count}`);
}

{
  let allOk = true;
  let count = 0;
  for (let ri = 0; ri < locks.RESIDUAL_RISKS.length; ri += 1) {
    for (const field of locks.RISK_FIELDS) {
      const v = mutateAndValidate((bad) => {
        if (field === 'severity') bad.residual_risks[ri][field] = 'mutated_sev';
        else if (field === 'status') bad.residual_risks[ri][field] = 'closed_erased';
        else bad.residual_risks[ri][field] = `MUTATED_${field}`;
      });
      count += 1;
      if (v.ok) allOk = false;
    }
  }
  red('systematic_residual_risk_field_mutations_rejected',
    allOk && count === locks.RESIDUAL_RISKS.length * locks.RISK_FIELDS.length,
    `count=${count}`);
}

{
  let allOk = true;
  let count = 0;
  for (let ti = 0; ti < locks.REOPEN_TRIGGERS.length; ti += 1) {
    for (const field of locks.TRIGGER_FIELDS) {
      const v = mutateAndValidate((bad) => {
        bad.reopen_triggers[ti][field] = field === 'threshold' ? 'never' : `MUTATED_${field}`;
      });
      count += 1;
      if (v.ok) allOk = false;
    }
  }
  red('systematic_reopen_trigger_field_mutations_rejected',
    allOk && count === locks.REOPEN_TRIGGERS.length * locks.TRIGGER_FIELDS.length,
    `count=${count}`);
}

{
  let allOk = true;
  let count = 0;
  for (const field of locks.HANDOFF_FIELDS) {
    const v = mutateAndValidate((bad) => {
      if (field === 'required' || field === 'blocked_without_reopen') {
        bad.factory_handoff_gate[field] = [];
      } else if (field === 'break_glass_override') {
        bad.factory_handoff_gate[field] = 'weakened';
      } else {
        bad.factory_handoff_gate[field] = `MUTATED_${field}`;
      }
    });
    count += 1;
    if (v.ok) allOk = false;
  }
  red('systematic_factory_handoff_field_mutations_rejected',
    allOk && count === locks.HANDOFF_FIELDS.length,
    `count=${count}`);
}

{
  let allOk = true;
  let count = 0;
  for (const field of locks.BREAK_GLASS_SCALAR_FIELDS) {
    const v = mutateAndValidate((bad) => {
      if (field === 'never_delays_or_prohibits') bad.break_glass[field] = false;
      else if (field === 'work_may_start') bad.break_glass[field] = 'after_approval';
      else bad.break_glass[field] = `MUTATED_${field}`;
    });
    count += 1;
    if (v.ok) allOk = false;
  }
  for (let ci = 0; ci < locks.BREAK_GLASS.categories.length; ci += 1) {
    for (const field of locks.BREAK_GLASS_CATEGORY_FIELDS) {
      const v = mutateAndValidate((bad) => {
        bad.break_glass.categories[ci][field] = `MUTATED_${field}`;
      });
      count += 1;
      if (v.ok) allOk = false;
    }
  }
  // Category deletion per category
  for (let ci = 0; ci < locks.BREAK_GLASS.categories.length; ci += 1) {
    const catId = locks.BREAK_GLASS.categories[ci].id;
    const v = mutateAndValidate((bad) => {
      bad.break_glass.categories = bad.break_glass.categories.filter((c) => c.id !== catId);
    });
    count += 1;
    if (v.ok) allOk = false;
  }
  red('systematic_break_glass_field_mutations_rejected', allOk && count > 0, `count=${count}`);
}

{
  // Fixture monkeypatch: mutate evidence object in memory (as if fixture rewritten)
  // then recompute hash — imported validator must still reject vs private locks.
  const patched = deepClone(evidence);
  patched.frozen_score.proven = 9;
  patched.frozen_score.partial = 0;
  patched.lock_hash = computeLockHash(patched);
  const v = validateCloseout(patched);
  red('fixture_monkeypatch_rejected', !v.ok && v.errors.includes('frozen_score'));
}

{
  // Export monkeypatch attempts must not alter validation outcome for GREEN evidence.
  const before = validateCloseout(evidence);
  tryAssign(locks, 'FROZEN_SCORE', { proven: 9, partial: 0, absent: 0, total: 9 });
  tryAssign(locks, 'GATE_EVIDENCE_FREEZE', []);
  tryAssign(locks, 'RESIDUAL_RISKS', []);
  tryAssign(locks, 'BREAK_GLASS', { id: 'weakened' });
  tryDefine(locks, 'validateCloseout', () => ({ ok: false, errors: ['hijacked'] }));
  tryAssign(locks.FROZEN_SCORE, 'proven', 9);
  const after = validateCloseout(evidence);
  const stillRejectsInflation = !mutateAndValidate((bad) => {
    bad.frozen_score.proven = 1;
    bad.frozen_score.partial = 8;
  }).ok;
  red('export_monkeypatch_validation_unaffected',
    before.ok
    && after.ok
    && stillRejectsInflation
    && locks.validateCloseout === validateCloseout
    && locks.FROZEN_SCORE.proven === 0);
}

{
  // RED: pre-candidate / unrelated / orphan / invalid-ref tips reject (ancestry-only).
  let orphanSha = '';
  let orphanOk = false;
  try {
    orphanSha = makeUnrelatedOrphanCommit(ROOT);
    orphanOk = tipContainsCandidate(orphanSha, ROOT) === false
      && tipAccepts16ap(orphanSha, 'HEAD', ROOT) === false;
  } catch (err) {
    orphanOk = false;
    orphanSha = String(err && err.message);
  }
  red('unrelated_detached_commit_rejected',
    tipContainsCandidate(locks.MASTER_BASIS, ROOT) === false
    && tipAccepts16ap(locks.MASTER_BASIS, 'HEAD', ROOT) === false
    && tipAccepts16ap(locks.MASTER_BASIS, 'radar/unrelated-branch', ROOT) === false
    && tipAccepts16ap('not-a-git-ref', 'HEAD', ROOT) === false
    && tipAccepts16ap('ffffffffffffffffffffffffffffffffffffffff', 'HEAD', ROOT) === false
    && tipAccepts16ap(locks.CANDIDATE_SHA, 'HEAD', ROOT) === true
    && orphanOk,
    `orphan=${orphanSha}`);
}

{
  // RED: spoofed locked branch name never bypasses ancestry (pre-candidate + orphan).
  let orphanSha = '';
  let orphanOk = false;
  try {
    orphanSha = makeUnrelatedOrphanCommit(ROOT);
    orphanOk = tipAccepts16ap(orphanSha, locks.BRANCH, ROOT) === false;
  } catch (err) {
    orphanOk = false;
    orphanSha = String(err && err.message);
  }
  red('spoofed_locked_branch_name_rejected',
    tipAccepts16ap(locks.MASTER_BASIS, locks.BRANCH, ROOT) === false
    && tipAccepts16ap(locks.MASTER_BASIS, tipHelper.BRANCH, ROOT) === false
    && tipAccepts16ap('not-a-git-ref', locks.BRANCH, ROOT) === false
    && tipAccepts16ap(locks.CANDIDATE_SHA, locks.BRANCH, ROOT) === true
    && orphanOk,
    `orphan=${orphanSha}`);
}

for (const id of locks.REQUIRED_RED) {
  ok(`REQUIRED_RED has ${id}`, redResults.some((r) => r.id === id && r.ok));
}
for (const id of locks.REQUIRED_GREEN) {
  ok(`REQUIRED_GREEN has ${id}`, greenResults.some((r) => r.id === id && r.ok));
}

ok('C9 matrix gates retain gaps (no erasure)',
  matrix.gates.every((g) => Array.isArray(g.gaps) && g.gaps.length > 0));

ok('C10 retained 16AO/16AN/16AM selections present',
  matrix.slice_16ao_selection
  && matrix.slice_16an_selection
  && matrix.slice_16am_selection
  && topContract.selected_16ao
  && topContract.selected_16an
  && topContract.selected_16am
  && topContract.g06_admission_activation === 'live_proven_via_16AO'
  && topContract.g06_ingress_binding_source === 'source_deploy_config_proven_via_16AN'
  && topContract.g06_backpressure_deploy_flag_off === 'live_proven_via_16AM'
  && topContract.g06_backpressure === 'open');

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16AP finite milestone closeout: PASS');
