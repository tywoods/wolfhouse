'use strict';

/**
 * verify:radar-slice16ap-finite-closeout — RADAR Slice 16AP
 *
 * Deterministic offline closeout gate. Prevents score inflation, gap deletion,
 * unsupported live/production claims, and endless additional RADAR slices
 * absent an explicit reopen trigger. Docs/fixtures/verifier only.
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

function computeLockHash(ev) {
  const clone = JSON.parse(JSON.stringify(ev));
  delete clone.lock_hash;
  return crypto.createHash('sha256').update(stableStringify(clone)).digest('hex');
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function overclaimHits(text) {
  const hits = [];
  const lines = String(text).split(/\n/);
  const neg = /not claimed|does\s*\*+\s*not|does not|never|open|forbidden|explicitly|remain|retained|without|absent|blocked|reject/i;
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

function evidenceClassesMatch(freeze, evidence) {
  if (!Array.isArray(freeze) || freeze.length !== 9) return false;
  if (!Array.isArray(evidence) || evidence.length !== 9) return false;
  for (let i = 0; i < 9; i += 1) {
    const a = freeze[i];
    const b = evidence[i];
    if (a.id !== b.id) return false;
    if (a.formal_verdict !== 'partial' || b.formal_verdict !== 'partial') return false;
    if (a.evidence_class !== b.evidence_class) return false;
    if (!Array.isArray(b.retained_gaps) || b.retained_gaps.length === 0) return false;
    if (!b.deferred_owner) return false;
  }
  return true;
}

console.log('RADAR 16AP finite milestone closeout — offline verifier\n');

ok('C0 locks identity',
  locks.SLICE === 'RADAR-16AP'
  && locks.OUTCOME_ID === '16AP_finite_milestone_closeout'
  && locks.BRANCH === 'radar/slice-16ap-finite-closeout'
  && locks.MASTER_BASIS === '66e34a5833ff3bcc7f297108f594b4fc58a0eccc');

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

ok('C3 lock_hash matches',
  typeof evidence.lock_hash === 'string'
  && /^[0-9a-f]{64}$/.test(evidence.lock_hash)
  && evidence.lock_hash === computeLockHash(evidence),
  `got=${evidence.lock_hash} expected=${computeLockHash(evidence)}`);

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
  && topContract.formal_gates_status === 'all_nine_remain_partial');

// ── GREENS ──────────────────────────────────────────────────────────────────
green('score_frozen_0_9_0',
  evidence.frozen_score.proven === 0
  && evidence.frozen_score.partial === 9
  && evidence.frozen_score.absent === 0
  && evidence.frozen_score.total === 9
  && matrix.verdict_counts.proven === 0
  && matrix.verdict_counts.partial === 9
  && matrix.verdict_counts.absent === 0
  && topContract.expected_verdict_counts.proven === 0
  && topContract.expected_verdict_counts.partial === 9
  && topContract.expected_verdict_counts.absent === 0
  && sliceContract.frozen_score.proven === 0
  && sliceContract.frozen_score.partial === 9
  && sliceContract.frozen_score.absent === 0);

green('all_gates_formal_partial',
  Array.isArray(matrix.gates)
  && matrix.gates.length === 9
  && matrix.gates.every((g) => g.verdict === 'partial')
  && matrix.gates.every((g) => g.verdict !== 'proven')
  && evidence.gate_evidence_freeze.every((g) => g.formal_verdict === 'partial'));

green('evidence_classes_match_freeze',
  evidenceClassesMatch(locks.GATE_EVIDENCE_FREEZE, evidence.gate_evidence_freeze)
  && evidence.gate_evidence_freeze.every((g) => Array.isArray(g.retained_gaps) && g.retained_gaps.length > 0)
  && evidence.gate_evidence_freeze.every((g) => typeof g.deferred_owner === 'string' && g.deferred_owner.length > 0));

green('staging_readiness_exit_complete_not_proven',
  evidence.staging_readiness_exit.current_stage_status
    === 'complete_under_bounded_staging_readiness_exit'
  && evidence.staging_readiness_exit.formal_gates_status === 'all_nine_remain_partial'
  && Array.isArray(evidence.staging_readiness_exit.does_not_mean)
  && evidence.staging_readiness_exit.does_not_mean.includes('any_gate_verdict_proven')
  && evidence.staging_readiness_exit.does_not_mean.includes('production_ready')
  && /staging-readiness|staging readiness/i.test(doc)
  && /current-stage complete|current_stage.*complete/i.test(doc + findings));

{
  const g06 = evidence.gate_evidence_freeze.find((g) => g.id === 'G06_scaling_capacity');
  const sub = g06 && g06.g06_subcontrol_freeze;
  green('g06_subcontrols_honest',
    !!sub
    && sub.exact_sha_capacity_deploy === 'live_proven_via_16AM_and_16AO'
    && sub.bounded_readiness_load === 'live_proven_via_16AI'
    && sub.availability_slo_source === 'source_defined_via_16AJ'
    && sub.backpressure_source === 'source_defined_via_16AK'
    && sub.backpressure_wire === 'integration_source_proven_via_16AL'
    && sub.backpressure_deploy_flag_off === 'live_proven_via_16AM'
    && sub.backpressure_activation_auth_rejection === 'live_proven_via_16AO'
    && sub.failed_identity_canary_rollback_correction === 'recorded_via_16AN_16AO'
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

green('reopen_triggers_present',
  Array.isArray(evidence.reopen_triggers)
  && evidence.reopen_triggers.length === 5
  && ['production_launch', 'third_tenant_factory', 'traffic_or_cost_threshold', 'incident', 'security_boundary_change']
    .every((id) => evidence.reopen_triggers.some((t) => t.id === id))
  && Array.isArray(topContract.reopen_triggers)
  && topContract.reopen_triggers.length === 5
  && /reopen/i.test(doc)
  && /third tenant|FACTORY/i.test(doc));

green('factory_handoff_present',
  evidence.factory_handoff_gate.id === '16AP_FACTORY_handoff_gate'
  && Array.isArray(evidence.factory_handoff_gate.required)
  && evidence.factory_handoff_gate.required.includes('successor_RADAR_slice_requires_reopen_trigger')
  && Array.isArray(evidence.factory_handoff_gate.blocked_without_reopen)
  && evidence.factory_handoff_gate.blocked_without_reopen.includes(
    'additional_RADAR_implementation_expansion_slices',
  )
  && topContract.factory_handoff_gate === '16AP_FACTORY_handoff_gate'
  && /FACTORY handoff|factory_handoff/i.test(doc));

green('residual_risks_and_owners_present',
  Array.isArray(evidence.residual_risks)
  && evidence.residual_risks.length >= 9
  && evidence.residual_risks.every((r) => r.id && r.risk && r.owner)
  && /deferred owner|residual risk/i.test(doc));

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

// ── REDS ────────────────────────────────────────────────────────────────────
{
  const bad = deepClone(evidence);
  bad.frozen_score.proven = 1;
  bad.frozen_score.partial = 8;
  bad.lock_hash = computeLockHash(bad);
  red('score_inflation_proven_rejected',
    !(bad.frozen_score.proven === 0 && bad.frozen_score.partial === 9));
}
{
  const bad = deepClone(evidence);
  bad.frozen_score.partial = 8;
  bad.lock_hash = computeLockHash(bad);
  red('score_inflation_partial_drift_rejected',
    bad.frozen_score.partial !== 9);
}
{
  const bad = deepClone(evidence);
  bad.gate_evidence_freeze[0].retained_gaps = [];
  bad.lock_hash = computeLockHash(bad);
  red('gap_deletion_rejected',
    !evidenceClassesMatch(locks.GATE_EVIDENCE_FREEZE, bad.gate_evidence_freeze));
}
{
  const bad = deepClone(evidence);
  bad.gate_evidence_freeze[5].formal_verdict = 'proven';
  bad.lock_hash = computeLockHash(bad);
  red('formal_gate_proven_rejected',
    bad.gate_evidence_freeze.some((g) => g.formal_verdict === 'proven'));
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
  const bad = deepClone(evidence);
  bad.factory_handoff_gate.blocked_without_reopen = [];
  bad.lock_hash = computeLockHash(bad);
  red('endless_slice_without_reopen_rejected',
    !Array.isArray(bad.factory_handoff_gate.blocked_without_reopen)
      || !bad.factory_handoff_gate.blocked_without_reopen.includes(
        'additional_RADAR_implementation_expansion_slices',
      ));
}
{
  const bad = deepClone(evidence);
  bad.lock_hash = '0'.repeat(64);
  red('lock_hash_mismatch_rejected', bad.lock_hash !== computeLockHash(bad));
}
{
  const bad = deepClone(evidence);
  bad.reopen_triggers = bad.reopen_triggers.filter((t) => t.id !== 'production_launch');
  bad.lock_hash = computeLockHash(bad);
  red('reopen_trigger_deletion_rejected',
    bad.reopen_triggers.length !== 5
      || !bad.reopen_triggers.some((t) => t.id === 'production_launch'));
}
{
  const bad = deepClone(evidence);
  bad.factory_handoff_gate.required = bad.factory_handoff_gate.required
    .filter((x) => x !== 'successor_RADAR_slice_requires_reopen_trigger');
  bad.lock_hash = computeLockHash(bad);
  red('factory_handoff_weakening_rejected',
    !bad.factory_handoff_gate.required.includes('successor_RADAR_slice_requires_reopen_trigger'));
}
{
  const bad = deepClone(evidence);
  const g06 = bad.gate_evidence_freeze.find((g) => g.id === 'G06_scaling_capacity');
  g06.g06_subcontrol_freeze.overload_shed = 'live_proven';
  g06.g06_subcontrol_freeze.production = 'live_proven';
  bad.lock_hash = computeLockHash(bad);
  red('g06_open_subcontrol_flip_rejected',
    g06.g06_subcontrol_freeze.overload_shed !== 'open'
      || g06.g06_subcontrol_freeze.production !== 'open');
}

for (const id of locks.REQUIRED_RED) {
  ok(`REQUIRED_RED has ${id}`, redResults.some((r) => r.id === id && r.ok));
}
for (const id of locks.REQUIRED_GREEN) {
  ok(`REQUIRED_GREEN has ${id}`, greenResults.some((r) => r.id === id && r.ok));
}

ok('C6 matrix gates retain gaps (no erasure)',
  matrix.gates.every((g) => Array.isArray(g.gaps) && g.gaps.length > 0));

ok('C7 retained 16AO/16AN/16AM selections present',
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
