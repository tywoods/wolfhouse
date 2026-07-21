'use strict';

/**
 * verify:radar-slice16ao-g06-backpressure-activation-evidence — RADAR Slice 16AO
 *
 * Offline RED/GREEN for corrected dual-staging admission activation evidence.
 * Strict REDs for digest/tag/revision/overload-shed/cost/overclaim drift.
 * G06 remains partial 0/9/0.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16ao-g06-backpressure-activation-evidence');

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];

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

function red(id, cond, detail) {
  redResults.push({ id, ok: !!cond });
  return ok(`RED ${id}`, cond, detail);
}

function green(id, cond, detail) {
  greenResults.push({ id, ok: !!cond });
  return ok(`GREEN ${id}`, cond, detail);
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readBytes(rel) {
  return fs.readFileSync(path.join(ROOT, rel));
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function currentBranch() {
  return execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
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

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function evidenceHashPayload(ev) {
  const clone = deepClone(ev);
  delete clone.lock_hash;
  return clone;
}

function computeEvidenceLockHash(ev) {
  return crypto.createHash('sha256').update(stableStringify(evidenceHashPayload(ev))).digest('hex');
}

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function validateEvidenceExact(evidence) {
  const errors = [];
  const expected = readJson(locks.EVIDENCE_REL);
  const withoutHash = deepClone(evidence);
  const gotHash = withoutHash.lock_hash;
  delete withoutHash.lock_hash;
  const expectedNoHash = deepClone(expected);
  delete expectedNoHash.lock_hash;

  if (!/^[0-9a-f]{64}$/.test(String(gotHash || ''))) {
    errors.push('$.lock_hash: must be 64-char lowercase hex');
  } else {
    const recomputed = computeEvidenceLockHash(evidence);
    if (gotHash !== recomputed) {
      errors.push(`$.lock_hash: mismatch (got=${gotHash} expected=${recomputed})`);
    }
  }

  const allowedTop = [...Object.keys(expectedNoHash), 'lock_hash'].sort();
  const gotTop = Object.keys(evidence).sort();
  if (stableStringify(gotTop) !== stableStringify(allowedTop)) {
    errors.push(`top keys mismatch got=${gotTop.join(',')} allowed=${allowedTop.join(',')}`);
  }

  if (!deepEqual(withoutHash, expectedNoHash)) {
    errors.push('evidence payload mismatch vs locked fixture (excluding lock_hash check above)');
  }

  return { ok: errors.length === 0, errors };
}

function activationRoot(ev) {
  return ev && ev.observed_facts && ev.observed_facts.corrected_dual_staging_admission_activation;
}

function costRoot(ev) {
  return ev && ev.observed_facts && ev.observed_facts.sunset_mtd_actual_cost_guard;
}

function canaryRoot(ev) {
  return ev && ev.observed_facts && ev.observed_facts.historical_failed_canary_identity_fail_closed;
}

function secretFree(text) {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /"password"\s*:\s*"[^"]+"/i,
    /"clientSecret"\s*:\s*"[^"]+"/i,
    /sk_live_[a-zA-Z0-9]+/,
    /whsec_[a-zA-Z0-9]+/,
  ];
  const hits = patterns.filter((p) => p.test(text));
  return { ok: hits.length === 0, detail: hits.map(String).join(',') || '(clean)' };
}

function overclaimHits(text) {
  const patterns = [
    /\bbackpressure\s+proven\b/i,
    /\bbackpressure\s+live\b/i,
    /\badmission\s+control\s+proven\b/i,
    /\blive\s+shed\s+proven\b/i,
    /\boverload\s+shed\s+proven\b/i,
    /\bload\s+soak\s+proven\b/i,
    /\bautoscaling\s+proven\b/i,
    /\bcapacity\s+SLO\s+proven\b/i,
    /\berror\s+budget\s+proven\b/i,
    /\bfull\s+G06\b/i,
    /\bG06\s+proven\b/i,
    /\bfull_G06_proven\b/i,
  ];
  const neg = /not claimed|does\s*\*+\s*not|does not|never|open|forbidden|explicitly|not enabled|no live|without|Does not prove|does_not_prove|NOT overload|not overload|auth-rejection|healthy activation only/i;
  const hits = [];
  for (const line of String(text).split(/\n/)) {
    if (neg.test(line)) continue;
    for (const p of patterns) {
      if (p.test(line)) hits.push(`${String(p)} :: ${line.slice(0, 120)}`);
    }
  }
  return hits;
}

function validateRawArtifactHashes(evidence) {
  const errors = [];
  const rows = [
    ['raw_sunset_corrected', locks.RAW_SUNSET_CORRECTED_REL, locks.RAW_SUNSET_CORRECTED_SHA256],
    ['raw_wh_deploy_off', locks.RAW_WH_DEPLOY_OFF_REL, locks.RAW_WH_DEPLOY_OFF_SHA256],
    ['raw_wh_enable_corrected', locks.RAW_WH_ENABLE_CORRECTED_REL, locks.RAW_WH_ENABLE_CORRECTED_SHA256],
    ['raw_wh_failed_canary', locks.RAW_WH_FAILED_CANARY_REL, locks.RAW_WH_FAILED_CANARY_SHA256],
    ['raw_wh_rollback', locks.RAW_WH_ROLLBACK_REL, locks.RAW_WH_ROLLBACK_SHA256],
    ['raw_cost_before', locks.RAW_COST_BEFORE_REL, locks.RAW_COST_BEFORE_SHA256],
    ['raw_cost_after', locks.RAW_COST_AFTER_REL, locks.RAW_COST_AFTER_SHA256],
    ['raw_acr_digest', locks.RAW_ACR_DIGEST_REL, locks.RAW_ACR_DIGEST_SHA256],
    ['raw_operator_attested', locks.RAW_OPERATOR_ATTESTED_REL, locks.RAW_OPERATOR_ATTESTED_SHA256],
  ];
  const prov = evidence.durable_raw_artifact_provenance;
  if (!prov || !Array.isArray(prov.artifacts) || prov.artifacts.length !== rows.length) {
    errors.push('provenance artifacts length');
  }
  for (const [id, rel, expectSha] of rows) {
    const got = sha256Bytes(readBytes(rel));
    if (got !== expectSha) errors.push(`${id} file sha got=${got}`);
    const row = (prov.artifacts || []).find((a) => a.id === id);
    if (!row || row.path !== rel || row.sha256 !== expectSha) {
      errors.push(`${id} provenance row`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateActivationFacts(evidence) {
  const errors = [];
  const d = activationRoot(evidence);
  if (!d) return { ok: false, errors: ['missing activation facts'] };
  if (d.master_sha !== locks.MASTER_BASIS) errors.push('master_sha');
  if (d.acr_build_run_id !== locks.ACR_BUILD_RUN_ID) errors.push('acr_build_run_id');
  if (d.digest !== locks.DIGEST) errors.push('digest');
  if (d.image_tag !== locks.IMAGE_TAG) errors.push('image_tag');

  const su = d.sunset;
  if (!su
    || su.image !== locks.SUNSET_IMAGE
    || su.revision !== locks.SUNSET_REVISION
    || su.latestRevisionName !== locks.SUNSET_REVISION
    || su.STAFF_API_ADMISSION_CONTROL_present !== true
    || su.STAFF_API_INGRESS_TENANT_SLUG_present !== true
    || su.operator_attested_STAFF_API_ADMISSION_CONTROL !== true
    || su.operator_attested_STAFF_API_INGRESS_TENANT_SLUG !== 'sunset'
    || su.operator_attested_traffic_percent !== 100
    || su.operator_attested_ready !== true
    || su.operator_attested_pre_probe_invalid_signature !== '80/80 expected 403') {
    errors.push('sunset');
  }

  const off = d.wolfhouse_deploy_off;
  if (!off
    || off.image !== locks.WH_IMAGE
    || off.revision !== locks.WH_DEPLOY_OFF_REVISION
    || off.latestRevisionName !== locks.WH_DEPLOY_OFF_REVISION
    || off.STAFF_API_ADMISSION_CONTROL_present !== true
    || off.STAFF_API_INGRESS_TENANT_SLUG_present !== true
    || off.operator_attested_STAFF_API_ADMISSION_CONTROL !== false
    || off.operator_attested_STAFF_API_INGRESS_TENANT_SLUG !== 'wolfhouse-somo'
    || off.operator_attested_pre_probe_invalid_signature !== '80/80 expected 403') {
    errors.push('wh_deploy_off');
  }

  const on = d.wolfhouse_activation;
  if (!on
    || on.image !== locks.WH_IMAGE
    || on.revision !== locks.WH_ACTIVATION_REVISION
    || on.latestRevisionName !== locks.WH_ACTIVATION_REVISION
    || on.STAFF_API_ADMISSION_CONTROL_present !== true
    || on.STAFF_API_INGRESS_TENANT_SLUG_present !== true
    || on.operator_attested_STAFF_API_ADMISSION_CONTROL !== true
    || on.operator_attested_STAFF_API_INGRESS_TENANT_SLUG !== 'wolfhouse-somo'
    || on.operator_attested_traffic_percent !== 100
    || on.operator_attested_ready_before !== true
    || on.operator_attested_ready_after !== true
    || on.operator_attested_invalid_signature_webhook_probes !== '80/80 expected 403') {
    errors.push('wh_activation');
  }

  const flag = d.admission_flag;
  if (!flag
    || flag.env !== locks.FLAG_ENV
    || flag.both_currently_true !== true
    || flag.controller_enabled_both !== true
    || flag.live_overload_shed_claimed !== false
    || !Array.isArray(flag.probes_prove_only)
    || !flag.probes_prove_only.includes('auth_rejection_path_403')
    || !flag.probes_prove_only.includes('healthy_activation')) {
    errors.push('admission_flag');
  }
  return { ok: errors.length === 0, errors };
}

function validateCostFacts(evidence) {
  const errors = [];
  const c = costRoot(evidence);
  if (!c) return { ok: false, errors: ['missing cost'] };
  if (c.scope !== locks.COST_SCOPE) errors.push('scope');
  if (c.amount_before !== locks.COST_AMOUNT || c.amount_after !== locks.COST_AMOUNT) {
    errors.push('amount');
  }
  if (c.delta !== locks.COST_DELTA) errors.push('delta');
  if (c.identical !== true) errors.push('identical');
  if (c.disclosure !== locks.COST_DISCLOSURE) errors.push('disclosure');
  if (c.currency !== locks.COST_CURRENCY) errors.push('currency');
  if (c.captured_before_at !== locks.COST_BEFORE_AT) errors.push('before_at');
  if (c.captured_after_at !== locks.COST_AFTER_AT) errors.push('after_at');
  if (c.raw_before_sha256 !== locks.RAW_COST_BEFORE_SHA256) errors.push('before_sha');
  if (c.raw_after_sha256 !== locks.RAW_COST_AFTER_SHA256) errors.push('after_sha');
  return { ok: errors.length === 0, errors };
}

function validateCanaryFacts(evidence) {
  const errors = [];
  const c = canaryRoot(evidence);
  if (!c) return { ok: false, errors: ['missing canary'] };
  if (c.classification !== 'identity_fail_closed_not_overload_shed') errors.push('classification');
  if (c.wolfhouse_revision_on_fail !== locks.WH_FAILED_CANARY_REVISION) errors.push('fail_rev');
  if (c.rollback_revision !== locks.WH_ROLLBACK_REVISION) errors.push('rollback_rev');
  if (c.invalid_signature_webhook_probes_on_fail !== '80/80 returned 503') errors.push('fail_probes');
  if (c.probe_after_rollback !== 403) errors.push('rollback_probe');
  if (c.readyz_on_fail !== 200) errors.push('readyz');
  return { ok: errors.length === 0, errors };
}

function evidenceMatchesRaw() {
  const errors = [];
  const suRaw = readJson(locks.RAW_SUNSET_CORRECTED_REL);
  const offRaw = readJson(locks.RAW_WH_DEPLOY_OFF_REL);
  const onRaw = readJson(locks.RAW_WH_ENABLE_CORRECTED_REL);
  const failRaw = readJson(locks.RAW_WH_FAILED_CANARY_REL);
  const rbRaw = readJson(locks.RAW_WH_ROLLBACK_REL);
  const acr = readJson(locks.RAW_ACR_DIGEST_REL);
  const costBefore = readJson(locks.RAW_COST_BEFORE_REL);
  const costAfter = readJson(locks.RAW_COST_AFTER_REL);
  const op = readJson(locks.RAW_OPERATOR_ATTESTED_REL);

  if (suRaw.properties.template.containers[0].image !== locks.SUNSET_IMAGE) errors.push('sunset raw image');
  if (suRaw.properties.latestRevisionName !== locks.SUNSET_REVISION) errors.push('sunset raw revision');
  if (suRaw.properties.template.containers[0].STAFF_API_ADMISSION_CONTROL_present !== true) {
    errors.push('sunset admission present');
  }
  if (suRaw.properties.template.containers[0].STAFF_API_INGRESS_TENANT_SLUG_present !== true) {
    errors.push('sunset ingress present');
  }

  if (offRaw.properties.template.containers[0].image !== locks.WH_IMAGE) errors.push('wh-off raw image');
  if (offRaw.properties.latestRevisionName !== locks.WH_DEPLOY_OFF_REVISION) errors.push('wh-off raw revision');
  if (onRaw.properties.template.containers[0].image !== locks.WH_IMAGE) errors.push('wh-on raw image');
  if (onRaw.properties.latestRevisionName !== locks.WH_ACTIVATION_REVISION) errors.push('wh-on raw revision');
  if (onRaw.properties.template.containers[0].STAFF_API_INGRESS_TENANT_SLUG_present !== true) {
    errors.push('wh-on ingress present');
  }

  if (failRaw.properties.latestRevisionName !== locks.WH_FAILED_CANARY_REVISION) errors.push('fail raw rev');
  if (rbRaw.properties.latestRevisionName !== locks.WH_ROLLBACK_REVISION) errors.push('rollback raw rev');

  if (acr.digest !== locks.DIGEST || acr.run_id !== locks.ACR_BUILD_RUN_ID) errors.push('acr digest/run');
  if (!Array.isArray(acr.repositories) || acr.repositories.length !== 2) errors.push('acr repos');
  for (const r of acr.repositories || []) {
    if (r.tag !== locks.IMAGE_TAG || r.digest !== locks.DIGEST) errors.push(`acr repo ${r.repository}`);
  }

  if (costBefore.amount !== locks.COST_AMOUNT || costAfter.amount !== locks.COST_AMOUNT) {
    errors.push('cost amount raw');
  }
  if (costBefore.capturedAt !== locks.COST_BEFORE_AT || costAfter.capturedAt !== locks.COST_AFTER_AT) {
    errors.push('cost timestamps');
  }

  if (op.artifact_kind !== 'operator_attested_activation_probe_and_env_facts') {
    errors.push('operator kind');
  }
  if (op.corrected_activation.both_flags_currently_true !== true) errors.push('both flags');
  if (op.corrected_activation.wolfhouse_activation.invalid_signature_webhook_probes
    !== '80/80 expected 403') {
    errors.push('wh probes');
  }
  if (!Array.isArray(op.does_not_prove)
    || !op.does_not_prove.includes('queue_overflow_503_overload_shedding')) {
    errors.push('operator does_not_prove');
  }
  return { ok: errors.length === 0, errors };
}

console.log('RADAR 16AO G06 backpressure activation evidence — offline verifier\n');

ok('C0 locks identity',
  locks.SLICE === 'RADAR-16AO'
  && locks.OUTCOME_ID === '16AO_g06_backpressure_activation_evidence'
  && locks.BRANCH === 'radar/slice-16ao-g06-backpressure-activation-evidence'
  && locks.MASTER_BASIS === '9da228436c21bf7777cee553c91877a7e62a4092');

const evidence = readJson(locks.EVIDENCE_REL);
const sliceContract = readJson(locks.CONTRACT_REL);
const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
const topContract = readJson('fixtures/radar-operations/contract.json');
const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
const findings = readText('fixtures/radar-operations/findings.md');
const pkg = readJson('package.json');

ok('C1 HEAD on 16AO branch',
  currentBranch() === locks.BRANCH,
  currentBranch());
ok('C2 evidence master_basis locked', evidence.master_basis === locks.MASTER_BASIS);
ok('C3 slice/outcome/branch locked',
  evidence.slice === locks.SLICE
  && evidence.outcome_id === locks.OUTCOME_ID
  && evidence.branch === locks.BRANCH
  && sliceContract.branch === locks.BRANCH
  && sliceContract.outcome_id === locks.OUTCOME_ID);

{
  const v = validateEvidenceExact(evidence);
  ok('C4 evidence exact recursive schema + lock_hash', v.ok, v.errors.slice(0, 12).join(' | '));
}

ok('C5 live_mutation false + audit_only + this_slice_deploys false',
  evidence.live_mutation === false
  && evidence.audit_only === true
  && evidence.this_slice_deploys === false
  && sliceContract.this_slice_deploys === false
  && sliceContract.flag_enabled === true);

ok('C6 disposition keeps G06 partial; activation caveats',
  evidence.disposition.g06_verdict === 'partial'
  && evidence.disposition.final_controlled_drill_status === 'live_proven'
  && evidence.gate_progress_updates.G06_scaling_capacity.verdict === 'partial'
  && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes(
    'queue_overflow_503_overload_shedding',
  )
  && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('backpressure')
  && evidence.gate_progress_updates.G06_scaling_capacity.live_proven.includes(
    'corrected_dual_staging_admission_activation_via_16AO',
  ));

{
  const h = validateRawArtifactHashes(evidence);
  green('raw_artifacts_sha256_match', h.ok, h.errors.join(' | '));
}
{
  const d = validateActivationFacts(evidence);
  green('acr_digest_tag_both_repos',
    d.ok && activationRoot(evidence).digest === locks.DIGEST
    && activationRoot(evidence).image_tag === locks.IMAGE_TAG
    && activationRoot(evidence).acr_build_run_id === locks.ACR_BUILD_RUN_ID,
    d.errors.join(' | '));
  green('sunset_wh_revisions_exact_image',
    d.ok
    && activationRoot(evidence).sunset.revision === locks.SUNSET_REVISION
    && activationRoot(evidence).wolfhouse_deploy_off.revision === locks.WH_DEPLOY_OFF_REVISION
    && activationRoot(evidence).wolfhouse_activation.revision === locks.WH_ACTIVATION_REVISION
    && activationRoot(evidence).wolfhouse_activation.image === locks.WH_IMAGE,
    d.errors.join(' | '));
  green('env_names_present_ingress_admission',
    d.ok
    && activationRoot(evidence).sunset.STAFF_API_INGRESS_TENANT_SLUG_present === true
    && activationRoot(evidence).wolfhouse_activation.STAFF_API_INGRESS_TENANT_SLUG_present === true
    && activationRoot(evidence).wolfhouse_activation.STAFF_API_ADMISSION_CONTROL_present === true,
    d.errors.join(' | '));
  green('operator_attested_flags_true_probes_403',
    d.ok
    && activationRoot(evidence).admission_flag.both_currently_true === true
    && activationRoot(evidence).admission_flag.live_overload_shed_claimed === false
    && activationRoot(evidence).wolfhouse_activation
      .operator_attested_invalid_signature_webhook_probes === '80/80 expected 403',
    d.errors.join(' | '));
}
{
  const c = validateCanaryFacts(evidence);
  green('historical_canary_identity_fail_closed', c.ok, c.errors.join(' | '));
}
{
  const c = validateCostFacts(evidence);
  green('sunset_cost_identical_delta_disclosed', c.ok, c.errors.join(' | '));
}
{
  const m = evidenceMatchesRaw();
  green('evidence_values_match_raw_artifacts', m.ok, m.errors.join(' | '));
}

green('final_controlled_drill_live_proven_activation_only',
  evidence.disposition.final_controlled_drill_status === locks.FINAL_CONTROLLED_DRILL_STATUS
  && sliceContract.final_controlled_drill.id === locks.FINAL_CONTROLLED_DRILL_ID
  && sliceContract.final_controlled_drill.status === 'live_proven'
  && sliceContract.g06_backpressure === 'open'
  && sliceContract.flag_enabled === true
  && sliceContract.g06_admission_activation === 'live_proven_via_16AO');

green('g06_remains_partial',
  matrix.verdict_counts.proven === 0
  && matrix.verdict_counts.partial === 9
  && matrix.verdict_counts.absent === 0
  && topContract.expected_verdict_counts.proven === 0
  && topContract.expected_verdict_counts.partial === 9
  && topContract.expected_verdict_counts.absent === 0
  && (matrix.gates || []).every((g) => g.verdict !== 'proven'));

green('score_not_inflated',
  evidence.disposition.g06_verdict === 'partial'
  && !evidence.disposition.proves.includes('full_G06_proven')
  && evidence.explicitly_not_claimed.includes('full_G06_proven'));

green('package_script_registered',
  pkg.scripts['verify:radar-slice16ao-g06-backpressure-activation-evidence']
    === 'node scripts/verify-radar-slice16ao-g06-backpressure-activation-evidence.js');

{
  const rt = runtimePathsUnchanged();
  green('runtime_paths_unchanged', rt.ok, rt.detail);
}

green('16an_ingress_source_retained',
  topContract.g06_ingress_binding_source === 'source_deploy_config_proven_via_16AN'
  && topContract.selected_16an
  && topContract.selected_16an.outcome_id === '16AN_g06_wolfhouse_ingress_binding'
  && topContract.g06_backpressure === 'open');

ok('C7 tip matrix/contract 16AO + selected_16ao',
  matrix.slice === 'RADAR-16AO'
  && topContract.slice === 'RADAR-16AO'
  && matrix.branch === locks.BRANCH
  && matrix.master_basis === locks.MASTER_BASIS
  && topContract.branch === locks.BRANCH
  && topContract.master_basis === locks.MASTER_BASIS
  && matrix.slice_16ao_selection
  && matrix.slice_16ao_selection.outcome_id === locks.OUTCOME_ID
  && topContract.selected_16ao
  && topContract.selected_16ao.outcome_id === locks.OUTCOME_ID
  && topContract.g06_admission_activation === 'live_proven_via_16AO'
  && topContract.selected_16ao.flag_enabled === true
  && topContract.g06_backpressure === 'open');

ok('C8 doc/findings mention 16AO without overclaim',
  /16AO/i.test(doc)
  && /16AO/i.test(findings)
  && /0000525/.test(doc)
  && /0000282/.test(doc)
  && /identity fail-closed|identity_fail_closed/i.test(doc)
  && /auth-rejection|auth_rejection|expected 403/i.test(doc)
  && /not causal feature cost|not_causal_feature_cost|covers build\/deploy\/elapsed MTD/i.test(doc)
  && overclaimHits(doc).length === 0
  && overclaimHits(findings).length === 0,
  overclaimHits(doc + findings).join(','));

{
  const sec = secretFree([
    readText(locks.EVIDENCE_REL),
    readText(locks.CONTRACT_REL),
    readText(locks.RAW_SUNSET_CORRECTED_REL),
    readText(locks.RAW_WH_ENABLE_CORRECTED_REL),
    readText(locks.RAW_ACR_DIGEST_REL),
    readText(locks.RAW_OPERATOR_ATTESTED_REL),
  ].join('\n'));
  ok('C9 secret-free owned artifacts', sec.ok, sec.detail);
}

// ── REDs ────────────────────────────────────────────────────────────────────
{
  const bad = deepClone(evidence);
  bad.observed_facts.corrected_dual_staging_admission_activation.digest = `sha256:${'0'.repeat(64)}`;
  red('digest_drift_rejected',
    !validateEvidenceExact(bad).ok || !validateActivationFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.corrected_dual_staging_admission_activation.image_tag = 'deadbeef';
  red('tag_drift_rejected',
    !validateEvidenceExact(bad).ok || !validateActivationFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.corrected_dual_staging_admission_activation.sunset.revision =
    'luna-sunset-staging-staff-api--0000999';
  red('sunset_revision_drift_rejected',
    !validateEvidenceExact(bad).ok || !validateActivationFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.corrected_dual_staging_admission_activation.wolfhouse_activation.revision =
    'wh-staging-staff-api--0000999';
  red('wh_activation_revision_drift_rejected',
    !validateEvidenceExact(bad).ok || !validateActivationFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.corrected_dual_staging_admission_activation.admission_flag
    .live_overload_shed_claimed = true;
  bad.disposition.proves.push('queue_overflow_503_overload_shedding');
  red('overload_shed_overclaim_rejected',
    !validateEvidenceExact(bad).ok
    || !validateActivationFacts(bad).ok
    || bad.disposition.proves.includes('queue_overflow_503_overload_shedding'));
}
{
  const bad = deepClone(evidence);
  bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'backpressure_proven');
  bad.disposition.proves.push('backpressure_proven');
  red('backpressure_proven_overclaim_rejected',
    bad.disposition.proves.includes('backpressure_proven')
    && !evidence.disposition.proves.includes('backpressure_proven'));
}
{
  const badDoc = `${doc}\nG06 proven and full G06 closed.\n`;
  red('full_g06_overclaim_rejected',
    overclaimHits(badDoc).length > 0
    && overclaimHits(doc).length === 0);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.sunset_mtd_actual_cost_guard.amount_after = 99.99;
  red('cost_amount_drift_rejected',
    !validateEvidenceExact(bad).ok || !validateCostFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.durable_raw_artifact_provenance.artifacts[0].sha256 = '0'.repeat(64);
  red('raw_artifact_hash_drift_rejected',
    !validateRawArtifactHashes(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.lock_hash = '0'.repeat(64);
  red('lock_hash_mismatch_rejected', !validateEvidenceExact(bad).ok);
}
{
  red('doc_overclaim_tokens_detectable',
    overclaimHits('backpressure proven\nG06 proven\n').length >= 2);
}
{
  const bad = deepClone(evidence);
  bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'production');
  bad.disposition.proves.push('production');
  red('scope_overclaim_production_rejected',
    bad.disposition.proves.includes('production')
    && evidence.explicitly_not_claimed.includes('production'));
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.corrected_dual_staging_admission_activation.admission_flag
    .probes_prove_only = ['queue_overflow_503_overload_shedding'];
  red('probe_as_overload_shed_rejected',
    !validateActivationFacts(bad).ok
    || !bad.observed_facts.corrected_dual_staging_admission_activation.admission_flag
      .probes_prove_only.includes('auth_rejection_path_403'));
}

const redIds = redResults.map((r) => r.id);
const greenIds = greenResults.map((r) => r.id);
for (const id of locks.REQUIRED_RED) {
  ok(`REQUIRED_RED has ${id}`, redIds.includes(id));
}
for (const id of locks.REQUIRED_GREEN) {
  ok(`REQUIRED_GREEN has ${id}`, greenIds.includes(id));
}

ok('all RED assertions passed', redResults.every((r) => r.ok));
ok('all GREEN assertions passed', greenResults.every((r) => r.ok));

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16AO G06 backpressure activation evidence: PASS');
