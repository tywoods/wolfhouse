'use strict';

/**
 * verify:radar-slice16ap-finite-closeout — RADAR Slice 16AP
 *
 * Deterministic offline closeout gate. Canonical freeze expectations are
 * encoded in scripts/lib/radar-slice16ap-finite-closeout.js (immutable source
 * contract) — never treated as oracle-from-mutable-evidence. Deep-compares
 * every frozen per-gate field, residual risks, reopen triggers, FACTORY
 * handoff, and unconditional break-glass. REDs recompute lock_hash and invoke
 * the same production validation path.
 *
 * Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const locks = require('./lib/radar-slice16ap-finite-closeout');

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

function currentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (_) {
    return 'HEAD';
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function computeLockHash(ev) {
  const clone = deepClone(ev);
  delete clone.lock_hash;
  return crypto.createHash('sha256').update(stableStringify(clone)).digest('hex');
}

function thaw(frozen) {
  return deepClone(frozen);
}

/**
 * Production validation path — REDs and GREENS both use this.
 * Canonical expected freeze comes from locks module (source contract), NOT from
 * reading the evidence fixture as its own oracle.
 */
function validateCloseout(evidence) {
  const errors = [];

  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, errors: ['evidence missing'] };
  }

  const gotHash = evidence.lock_hash;
  if (!/^[0-9a-f]{64}$/.test(String(gotHash || ''))) {
    errors.push('lock_hash: must be 64-char lowercase hex');
  } else {
    const recomputed = computeLockHash(evidence);
    if (gotHash !== recomputed) {
      errors.push(`lock_hash: mismatch got=${gotHash} expected=${recomputed}`);
    }
  }

  if (evidence.slice !== locks.SLICE) errors.push('slice');
  if (evidence.outcome_id !== locks.OUTCOME_ID) errors.push('outcome_id');
  if (evidence.branch !== locks.BRANCH) errors.push('branch');
  if (evidence.master_basis !== locks.MASTER_BASIS) errors.push('master_basis');
  if (evidence.progress_class !== locks.PROGRESS_CLASS) errors.push('progress_class');
  if (evidence.audit_only !== true) errors.push('audit_only');
  if (evidence.live_mutation !== false) errors.push('live_mutation');
  if (evidence.this_slice_deploys !== false) errors.push('this_slice_deploys');

  if (!deepEqual(evidence.frozen_score, thaw(locks.FROZEN_SCORE))) {
    errors.push('frozen_score');
  }

  // Exact ordered deep-compare every per-gate frozen field vs canonical locks.
  const expectedGates = thaw(locks.GATE_EVIDENCE_FREEZE);
  const gotGates = evidence.gate_evidence_freeze;
  if (!Array.isArray(gotGates) || gotGates.length !== expectedGates.length) {
    errors.push('gate_evidence_freeze.length');
  } else {
    for (let i = 0; i < expectedGates.length; i += 1) {
      const exp = expectedGates[i];
      const got = gotGates[i];
      if (got.id !== exp.id) errors.push(`gate[${i}].id`);
      if (got.formal_verdict !== exp.formal_verdict) errors.push(`gate[${i}].formal_verdict`);
      if (got.evidence_class !== exp.evidence_class) errors.push(`gate[${i}].evidence_class`);
      if (got.deferred_owner !== exp.deferred_owner) errors.push(`gate[${i}].deferred_owner`);
      for (const field of locks.GATE_ARRAY_FIELDS) {
        if (!deepEqual(got[field], exp[field])) {
          errors.push(`gate[${i}].${field}`);
        }
      }
      if (exp.g06_subcontrol_freeze) {
        if (!deepEqual(got.g06_subcontrol_freeze, exp.g06_subcontrol_freeze)) {
          errors.push(`gate[${i}].g06_subcontrol_freeze`);
        }
      } else if (got.g06_subcontrol_freeze !== undefined) {
        errors.push(`gate[${i}].unexpected_g06_subcontrol_freeze`);
      }
      // Whole-row deep compare (covers any future locked field).
      if (!deepEqual(got, exp)) {
        errors.push(`gate[${i}].row`);
      }
    }
  }

  if (!deepEqual(evidence.staging_readiness_exit, thaw(locks.STAGING_READINESS_EXIT))) {
    errors.push('staging_readiness_exit');
  }

  // Exact deep-compare all residual risks (10): id/severity/owner/description/status.
  const expectedRisks = thaw(locks.RESIDUAL_RISKS);
  if (!deepEqual(evidence.residual_risks, expectedRisks)) {
    errors.push('residual_risks');
  } else if (!Array.isArray(evidence.residual_risks) || evidence.residual_risks.length !== 10) {
    errors.push('residual_risks.length');
  } else {
    for (let i = 0; i < expectedRisks.length; i += 1) {
      const r = evidence.residual_risks[i];
      const e = expectedRisks[i];
      if (r.id !== e.id) errors.push(`residual_risks[${i}].id`);
      if (r.severity !== e.severity) errors.push(`residual_risks[${i}].severity`);
      if (r.owner !== e.owner) errors.push(`residual_risks[${i}].owner`);
      if (r.description !== e.description) errors.push(`residual_risks[${i}].description`);
      if (r.status !== e.status) errors.push(`residual_risks[${i}].status`);
    }
  }

  // Exact deep-compare reopen triggers (IDs + descriptions + thresholds + applicability).
  const expectedTriggers = thaw(locks.REOPEN_TRIGGERS);
  if (!deepEqual(evidence.reopen_triggers, expectedTriggers)) {
    errors.push('reopen_triggers');
  } else {
    for (let i = 0; i < expectedTriggers.length; i += 1) {
      const t = evidence.reopen_triggers[i];
      const e = expectedTriggers[i];
      if (!t.id || !t.description || !t.threshold || !t.applicability) {
        errors.push(`reopen_triggers[${i}].incomplete`);
      }
      if (t.id !== e.id) errors.push(`reopen_triggers[${i}].id`);
      if (t.description !== e.description) errors.push(`reopen_triggers[${i}].description`);
      if (t.threshold !== e.threshold) errors.push(`reopen_triggers[${i}].threshold`);
      if (t.applicability !== e.applicability) errors.push(`reopen_triggers[${i}].applicability`);
    }
  }

  if (!deepEqual(evidence.factory_handoff_gate, thaw(locks.FACTORY_HANDOFF_GATE))) {
    errors.push('factory_handoff_gate');
  }

  if (!deepEqual(evidence.break_glass, thaw(locks.BREAK_GLASS))) {
    errors.push('break_glass');
  }

  if (!deepEqual(evidence.explicitly_not_claimed, thaw(locks.EXPLICITLY_NOT_CLAIMED))) {
    errors.push('explicitly_not_claimed');
  }

  if (!deepEqual(evidence.gate_ids_touched, thaw(locks.GATE_IDS))) {
    errors.push('gate_ids_touched');
  }

  // Reject circular / impossible reopen-trigger weakenings even if hash recomputed.
  if (Array.isArray(evidence.reopen_triggers)) {
    for (const t of evidence.reopen_triggers) {
      if (t && t.threshold === 'never' ) {
        errors.push('reopen_trigger_impossible_threshold');
      }
      if (t && t.applicability === 'never_applies') {
        errors.push('reopen_trigger_impossible_applicability');
      }
      if (t && Array.isArray(t.requires_trigger_ids)) {
        if (t.requires_trigger_ids.includes(t.id)) {
          errors.push('reopen_trigger_circular');
        }
        // Circular chain: A requires B requires A
        for (const otherId of t.requires_trigger_ids) {
          const other = evidence.reopen_triggers.find((x) => x && x.id === otherId);
          if (
            other
            && Array.isArray(other.requires_trigger_ids)
            && other.requires_trigger_ids.includes(t.id)
          ) {
            errors.push('reopen_trigger_circular');
          }
        }
      }
      if (t && t.requires_break_glass_gating === true) {
        errors.push('reopen_trigger_gates_break_glass');
      }
    }
  }

  if (evidence.break_glass) {
    if (evidence.break_glass.never_delays_or_prohibits !== true) {
      errors.push('break_glass.never_delays_or_prohibits');
    }
    if (evidence.break_glass.work_may_start !== 'immediately') {
      errors.push('break_glass.work_may_start');
    }
    if (evidence.break_glass.discretionary_successor_work !== 'remains_reopen_trigger_gated') {
      errors.push('break_glass.discretionary_successor_work');
    }
    if (!Array.isArray(evidence.break_glass.categories) || evidence.break_glass.categories.length !== 5) {
      errors.push('break_glass.categories');
    }
  } else {
    errors.push('break_glass.missing');
  }

  return { ok: errors.length === 0, errors };
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
    const out = execSync(
      `git diff --name-only ${locks.MASTER_BASIS} -- ${locks.MUST_NOT_MUTATE.join(' ')}`,
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

console.log('RADAR 16AP finite milestone closeout — offline verifier\n');

ok('C0 locks identity',
  locks.SLICE === 'RADAR-16AP'
  && locks.OUTCOME_ID === '16AP_finite_milestone_closeout'
  && locks.BRANCH === 'radar/slice-16ap-finite-closeout'
  && locks.MASTER_BASIS === '66e34a5833ff3bcc7f297108f594b4fc58a0eccc'
  && locks.BREAK_GLASS
  && locks.BREAK_GLASS.id === '16AP_unconditional_break_glass'
  && locks.RESIDUAL_RISKS.length === 10
  && locks.REOPEN_TRIGGERS.length === 5
  && locks.REOPEN_TRIGGERS.every((t) => t.id && t.description && t.threshold && t.applicability));

const evidence = readJson(locks.EVIDENCE_REL);
const sliceContract = readJson(locks.CONTRACT_REL);
const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
const topContract = readJson('fixtures/radar-operations/contract.json');
const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
const findings = readText('fixtures/radar-operations/findings.md');
const pkg = readJson('package.json');

ok('C1 HEAD on 16AP branch',
  currentBranch() === locks.BRANCH,
  currentBranch());

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
    === 'scripts/lib/radar-slice16ap-finite-closeout.js');

ok('C7 canonical locks independent of mutable evidence file bytes',
  // Prove oracle is locks module: mutate a copy of locks-derived expectation
  // would fail validation even if someone later rewrote evidence to match.
  !deepEqual(thaw(locks.RESIDUAL_RISKS), [])
  && locks.BREAK_GLASS.categories.length === 5
  && locks.GATE_EVIDENCE_FREEZE.every((g) => g.formal_verdict === 'partial')
  && Object.isFrozen(locks.BREAK_GLASS)
  && Object.isFrozen(locks.REOPEN_TRIGGERS)
  && Object.isFrozen(locks.RESIDUAL_RISKS)
  && Object.isFrozen(locks.GATE_EVIDENCE_FREEZE));

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
  && /0\/9\/0|proven=0.*partial=9.*absent=0/i.test(doc),
  overclaimHits(doc + findings).join(' | '));

// ── REDS (same production validation path after recomputed lock_hash) ───────
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
  // Delete one item from each multi-item evidence/gap array type.
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
    // Circular weakening: production_launch requires incident requires production_launch.
    const a = bad.reopen_triggers.find((t) => t.id === 'production_launch');
    const b = bad.reopen_triggers.find((t) => t.id === 'incident');
    a.requires_trigger_ids = ['incident'];
    b.requires_trigger_ids = ['production_launch'];
  });
  red('reopen_trigger_circular_weakening_rejected', !v.ok);
}
{
  const v = mutateAndValidate((bad) => {
    // Impossible weakening: threshold never / applicability never_applies.
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

for (const id of locks.REQUIRED_RED) {
  ok(`REQUIRED_RED has ${id}`, redResults.some((r) => r.id === id && r.ok));
}
for (const id of locks.REQUIRED_GREEN) {
  ok(`REQUIRED_GREEN has ${id}`, greenResults.some((r) => r.id === id && r.ok));
}

ok('C8 matrix gates retain gaps (no erasure)',
  matrix.gates.every((g) => Array.isArray(g.gaps) && g.gaps.length > 0));

ok('C9 retained 16AO/16AN/16AM selections present',
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
