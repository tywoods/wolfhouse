'use strict';

/**
 * verify:radar-slice16am-g06-backpressure-deploy-evidence — RADAR Slice 16AM
 *
 * Offline RED/GREEN for dual-staging 16AL Staff API deploy evidence with
 * STAFF_API_ADMISSION_CONTROL OFF/unset. Strict REDs for digest/tag/revision/
 * flag/readiness/cost/overclaim drift. G06 remains partial 0/9/0.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16am-g06-backpressure-deploy-evidence');

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

function deployRoot(ev) {
  return ev && ev.observed_facts && ev.observed_facts.dual_staging_16al_deploy_flag_off;
}

function costRoot(ev) {
  return ev && ev.observed_facts && ev.observed_facts.sunset_mtd_actual_cost_guard;
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
    /\bflag\s+enabled\b/i,
    /\bload\s+soak\s+proven\b/i,
    /\bautoscaling\s+proven\b/i,
    /\bcapacity\s+SLO\s+proven\b/i,
    /\berror\s+budget\s+proven\b/i,
    /\bfull\s+G06\b/i,
    /\bG06\s+proven\b/i,
    /\bfull_G06_proven\b/i,
  ];
  const neg = /not claimed|does\s*\*+\s*not|does not|never|open|forbidden|explicitly|default OFF|not enabled|OFF\/unset|disabled|no live|without|Does not prove|does_not_prove|Flag enable;|Flag enabled in staging/i;
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
    ['raw_wh_update', locks.RAW_WH_UPDATE_REL, locks.RAW_WH_UPDATE_SHA256],
    ['raw_sunset_update', locks.RAW_SUNSET_UPDATE_REL, locks.RAW_SUNSET_UPDATE_SHA256],
    ['raw_cost_before', locks.RAW_COST_BEFORE_REL, locks.RAW_COST_BEFORE_SHA256],
    ['raw_cost_after', locks.RAW_COST_AFTER_REL, locks.RAW_COST_AFTER_SHA256],
    ['raw_readyz_wh', locks.RAW_READYZ_WH_REL, locks.RAW_READYZ_WH_SHA256],
    ['raw_readyz_sunset', locks.RAW_READYZ_SUNSET_REL, locks.RAW_READYZ_SUNSET_SHA256],
    ['raw_acr_digest', locks.RAW_ACR_DIGEST_REL, locks.RAW_ACR_DIGEST_SHA256],
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

function validateDeployFacts(evidence) {
  const errors = [];
  const d = deployRoot(evidence);
  if (!d) return { ok: false, errors: ['missing deploy facts'] };
  if (d.master_sha !== locks.MASTER_BASIS) errors.push('master_sha');
  if (d.acr_build_run_id !== locks.ACR_BUILD_RUN_ID) errors.push('acr_build_run_id');
  if (d.digest !== locks.DIGEST) errors.push('digest');
  if (d.image_tag !== locks.IMAGE_TAG) errors.push('image_tag');
  if (!d.preflight
    || d.preflight.clean_exact_sha_preflight_passed !== true
    || d.preflight.synchronized_lunabox_master !== true
    || d.preflight.initial_remote_continuation_stopped_before_build_az_absent !== true
    || d.preflight.resumed_authenticated_local_azure_cli !== true) {
    errors.push('preflight');
  }
  const wh = d.wolfhouse;
  if (!wh
    || wh.image !== locks.WH_IMAGE
    || wh.image_tag !== locks.IMAGE_TAG
    || wh.revision !== locks.WH_REVISION
    || wh.latestRevisionName !== locks.WH_REVISION
    || wh.STAFF_API_ADMISSION_CONTROL_present !== false
    || wh.STAFF_API_ADMISSION_CONTROL !== null
    || !wh.readyz || wh.readyz.status !== locks.READY_STATUS) {
    errors.push('wolfhouse');
  }
  const su = d.sunset;
  if (!su
    || su.image !== locks.SUNSET_IMAGE
    || su.image_tag !== locks.IMAGE_TAG
    || su.latestReadyRevisionName !== locks.SUNSET_LATEST_READY
    || su.revision_name_unchanged_while_image_changed !== true
    || su.do_not_infer_new_revision_identity_beyond_latestReady_readback !== true
    || su.STAFF_API_ADMISSION_CONTROL_present !== false
    || su.STAFF_API_ADMISSION_CONTROL !== null
    || !su.readyz || su.readyz.status !== locks.READY_STATUS) {
    errors.push('sunset');
  }
  const flag = d.admission_flag;
  if (!flag
    || flag.env !== locks.FLAG_ENV
    || flag.both_empty_or_unset !== true
    || flag.controller_enabled !== false
    || flag.live_backpressure_shed_claimed !== false
    || flag.wolfhouse_query !== null
    || flag.sunset_query !== null) {
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
  if (c.identical !== true) errors.push('identical');
  if (c.currency !== locks.COST_CURRENCY) errors.push('currency');
  if (c.captured_before_at !== locks.COST_BEFORE_AT) errors.push('before_at');
  if (c.captured_after_at !== locks.COST_AFTER_AT) errors.push('after_at');
  if (c.raw_before_sha256 !== locks.RAW_COST_BEFORE_SHA256) errors.push('before_sha');
  if (c.raw_after_sha256 !== locks.RAW_COST_AFTER_SHA256) errors.push('after_sha');
  return { ok: errors.length === 0, errors };
}

function evidenceMatchesRaw() {
  const errors = [];
  const whRaw = readJson(locks.RAW_WH_UPDATE_REL);
  const suRaw = readJson(locks.RAW_SUNSET_UPDATE_REL);
  const acr = readJson(locks.RAW_ACR_DIGEST_REL);
  const costBefore = readJson(locks.RAW_COST_BEFORE_REL);
  const costAfter = readJson(locks.RAW_COST_AFTER_REL);
  const rzWh = readJson(locks.RAW_READYZ_WH_REL);
  const rzSu = readJson(locks.RAW_READYZ_SUNSET_REL);

  const whImg = whRaw.properties.template.containers[0].image;
  const suImg = suRaw.properties.template.containers[0].image;
  if (whImg !== locks.WH_IMAGE) errors.push('wh raw image');
  if (suImg !== locks.SUNSET_IMAGE) errors.push('sunset raw image');
  if (whRaw.properties.latestRevisionName !== locks.WH_REVISION) errors.push('wh raw revision');
  if (suRaw.properties.latestReadyRevisionName !== locks.SUNSET_LATEST_READY) {
    errors.push('sunset raw latestReady');
  }
  if (whRaw.properties.template.containers[0].STAFF_API_ADMISSION_CONTROL_present !== false) {
    errors.push('wh admission present');
  }
  if (suRaw.properties.template.containers[0].STAFF_API_ADMISSION_CONTROL_present !== false) {
    errors.push('sunset admission present');
  }
  if (acr.digest !== locks.DIGEST || acr.run_id !== locks.ACR_BUILD_RUN_ID) {
    errors.push('acr digest/run');
  }
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
  if (rzWh.status !== locks.READY_STATUS || rzSu.status !== locks.READY_STATUS) {
    errors.push('readyz raw');
  }
  return { ok: errors.length === 0, errors };
}

console.log('RADAR 16AM G06 backpressure deploy evidence — offline verifier\n');

ok('C0 locks identity',
  locks.SLICE === 'RADAR-16AM'
  && locks.OUTCOME_ID === '16AM_g06_backpressure_deploy_evidence'
  && locks.BRANCH === 'radar/slice-16am-g06-backpressure-deploy-evidence'
  && locks.MASTER_BASIS === '905ff9ff57a75d0b3defc15a16078b47e94e930f');

const evidence = readJson(locks.EVIDENCE_REL);
const sliceContract = readJson(locks.CONTRACT_REL);
const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
const topContract = readJson('fixtures/radar-operations/contract.json');
const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
const findings = readText('fixtures/radar-operations/findings.md');
const pkg = readJson('package.json');

ok('C1 HEAD on 16AM branch (or later 16AN/16AO tip retaining 16AM)',
  currentBranch() === locks.BRANCH
  || currentBranch() === 'radar/slice-16an-g06-wolfhouse-ingress-binding'
  || currentBranch() === 'radar/slice-16ao-g06-backpressure-activation-evidence',
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
  && sliceContract.flag_enabled === false);

ok('C6 disposition keeps G06 partial; deploy flag-off caveats',
  evidence.disposition.g06_verdict === 'partial'
  && evidence.disposition.final_controlled_drill_status === 'live_proven'
  && evidence.gate_progress_updates.G06_scaling_capacity.verdict === 'partial'
  && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('admission_flag_enable')
  && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('live_503_shed')
  && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('load_soak_proof')
  && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('backpressure')
  && evidence.gate_progress_updates.G06_scaling_capacity.live_proven.includes(
    '16al_dual_staging_deploy_flag_off_via_16AM',
  ));

{
  const h = validateRawArtifactHashes(evidence);
  green('raw_artifacts_sha256_match', h.ok, h.errors.join(' | '));
}
{
  const d = validateDeployFacts(evidence);
  green('acr_digest_tag_both_repos',
    d.ok && deployRoot(evidence).digest === locks.DIGEST
    && deployRoot(evidence).image_tag === locks.IMAGE_TAG
    && deployRoot(evidence).acr_build_run_id === locks.ACR_BUILD_RUN_ID,
    d.errors.join(' | '));
  green('wh_image_revision_exact',
    d.ok && deployRoot(evidence).wolfhouse.revision === locks.WH_REVISION
    && deployRoot(evidence).wolfhouse.image === locks.WH_IMAGE,
    d.errors.join(' | '));
  green('sunset_image_latestReady_unchanged_name',
    d.ok
    && deployRoot(evidence).sunset.latestReadyRevisionName === locks.SUNSET_LATEST_READY
    && deployRoot(evidence).sunset.revision_name_unchanged_while_image_changed === true
    && deployRoot(evidence).sunset.do_not_infer_new_revision_identity_beyond_latestReady_readback === true,
    d.errors.join(' | '));
  green('both_readyz_ready',
    d.ok
    && deployRoot(evidence).wolfhouse.readyz.status === 'ready'
    && deployRoot(evidence).sunset.readyz.status === 'ready',
    d.errors.join(' | '));
  green('admission_flag_absent_both',
    d.ok
    && deployRoot(evidence).admission_flag.both_empty_or_unset === true
    && deployRoot(evidence).admission_flag.controller_enabled === false
    && deployRoot(evidence).admission_flag.live_backpressure_shed_claimed === false,
    d.errors.join(' | '));
}
{
  const c = validateCostFacts(evidence);
  green('sunset_cost_identical_before_after', c.ok, c.errors.join(' | '));
}
{
  const m = evidenceMatchesRaw();
  green('evidence_values_match_raw_artifacts', m.ok, m.errors.join(' | '));
}

green('final_controlled_drill_live_proven_deploy_flag_off_only',
  evidence.disposition.final_controlled_drill_status === locks.FINAL_CONTROLLED_DRILL_STATUS
  && sliceContract.final_controlled_drill.id === locks.FINAL_CONTROLLED_DRILL_ID
  && sliceContract.final_controlled_drill.status === 'live_proven'
  && sliceContract.g06_backpressure === 'open'
  && sliceContract.flag_enabled === false);

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
  pkg.scripts['verify:radar-slice16am-g06-backpressure-deploy-evidence']
    === 'node scripts/verify-radar-slice16am-g06-backpressure-deploy-evidence.js');

{
  const rt = runtimePathsUnchanged();
  green('runtime_paths_unchanged', rt.ok, rt.detail);
}

green('16al_wire_source_retained',
  topContract.g06_backpressure_wire_source === 'integration_source_proven_via_16AL'
  && topContract.selected_16al
  && topContract.selected_16al.outcome_id === '16AL_g06_backpressure_wire'
  && topContract.g06_backpressure === 'open');

ok('C7 tip matrix/contract 16AM (or later 16AN/16AO tip) + selected_16am',
  (matrix.slice === 'RADAR-16AM' || matrix.slice === 'RADAR-16AN' || matrix.slice === 'RADAR-16AO')
  && (topContract.slice === 'RADAR-16AM' || topContract.slice === 'RADAR-16AN' || topContract.slice === 'RADAR-16AO')
  && matrix.slice_16am_selection
  && matrix.slice_16am_selection.outcome_id === locks.OUTCOME_ID
  && topContract.selected_16am
  && topContract.selected_16am.outcome_id === locks.OUTCOME_ID
  && topContract.g06_backpressure_deploy_flag_off === 'live_proven_via_16AM'
  && topContract.selected_16am.flag_enabled === false
  && (
    (matrix.slice === 'RADAR-16AM'
      && matrix.branch === locks.BRANCH
      && matrix.master_basis === locks.MASTER_BASIS
      && topContract.branch === locks.BRANCH
      && topContract.master_basis === locks.MASTER_BASIS)
    || (matrix.slice === 'RADAR-16AN'
      && matrix.branch === 'radar/slice-16an-g06-wolfhouse-ingress-binding'
      && topContract.branch === 'radar/slice-16an-g06-wolfhouse-ingress-binding'
      && topContract.g06_ingress_binding_source === 'source_deploy_config_proven_via_16AN')
    || (matrix.slice === 'RADAR-16AO'
      && matrix.branch === 'radar/slice-16ao-g06-backpressure-activation-evidence'
      && topContract.branch === 'radar/slice-16ao-g06-backpressure-activation-evidence'
      && topContract.g06_admission_activation === 'live_proven_via_16AO'
      && topContract.g06_ingress_binding_source === 'source_deploy_config_proven_via_16AN')
  ));

ok('C8 doc/findings mention 16AM without overclaim',
  /16AM/i.test(doc)
  && /16AM/i.test(findings)
  && /g02503r/i.test(doc)
  && /0000521/i.test(doc)
  && /STAFF_API_ADMISSION_CONTROL/i.test(doc)
  && overclaimHits(doc).length === 0
  && overclaimHits(findings).length === 0,
  overclaimHits(doc + findings).join(','));

{
  const sec = secretFree([
    readText(locks.EVIDENCE_REL),
    readText(locks.CONTRACT_REL),
    readText(locks.RAW_WH_UPDATE_REL),
    readText(locks.RAW_SUNSET_UPDATE_REL),
    readText(locks.RAW_ACR_DIGEST_REL),
  ].join('\n'));
  ok('C9 secret-free owned artifacts', sec.ok, sec.detail);
}

// ── REDs ────────────────────────────────────────────────────────────────────
{
  const bad = deepClone(evidence);
  bad.observed_facts.dual_staging_16al_deploy_flag_off.digest = 'sha256:' + '0'.repeat(64);
  red('digest_drift_rejected',
    !validateEvidenceExact(bad).ok || !validateDeployFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.dual_staging_16al_deploy_flag_off.image_tag = 'deadbeef';
  bad.observed_facts.dual_staging_16al_deploy_flag_off.wolfhouse.image_tag = 'deadbeef';
  bad.observed_facts.dual_staging_16al_deploy_flag_off.sunset.image_tag = 'deadbeef';
  red('tag_drift_rejected',
    !validateEvidenceExact(bad).ok || !validateDeployFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.dual_staging_16al_deploy_flag_off.wolfhouse.revision =
    'wh-staging-staff-api--9999999';
  red('wh_revision_drift_rejected',
    !validateEvidenceExact(bad).ok || !validateDeployFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.dual_staging_16al_deploy_flag_off.sunset.latestReadyRevisionName =
    'luna-sunset-staging-staff-api--0000280';
  red('sunset_latestReady_drift_rejected',
    !validateEvidenceExact(bad).ok || !validateDeployFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.dual_staging_16al_deploy_flag_off.sunset
    .do_not_infer_new_revision_identity_beyond_latestReady_readback = false;
  bad.observed_facts.dual_staging_16al_deploy_flag_off.sunset
    .revision_name_unchanged_while_image_changed = false;
  bad.claims_allowed.push('sunset_new_revision_identity_0000280');
  bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter(
    (x) => x !== 'sunset_new_revision_identity_beyond_latestReady_readback',
  );
  bad.disposition.proves.push('sunset_new_revision_identity_beyond_latestReady_readback');
  red('sunset_new_revision_overclaim_rejected',
    !validateEvidenceExact(bad).ok || !validateDeployFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.dual_staging_16al_deploy_flag_off.admission_flag.controller_enabled = true;
  bad.observed_facts.dual_staging_16al_deploy_flag_off.admission_flag.both_empty_or_unset = false;
  bad.claims_allowed.push('flag_enabled');
  bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'flag_enabled');
  bad.disposition.proves.push('flag_enabled');
  red('flag_enabled_overclaim_rejected',
    !validateEvidenceExact(bad).ok || !validateDeployFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.dual_staging_16al_deploy_flag_off.wolfhouse.readyz.status = 'not_ready';
  red('readyz_drift_rejected',
    !validateEvidenceExact(bad).ok || !validateDeployFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.sunset_mtd_actual_cost_guard.amount_after = 99.99;
  bad.observed_facts.sunset_mtd_actual_cost_guard.identical = false;
  red('cost_amount_drift_rejected',
    !validateEvidenceExact(bad).ok || !validateCostFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.durable_raw_artifact_provenance.artifacts[0].sha256 = '0'.repeat(64);
  bad.observed_facts.dual_staging_16al_deploy_flag_off.wolfhouse.raw_update_sha256 = '0'.repeat(64);
  red('raw_artifact_hash_drift_rejected',
    !validateEvidenceExact(bad).ok || !validateRawArtifactHashes(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.claims_allowed.push('live_503_shed');
  bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'live_503_shed');
  bad.disposition.proves.push('live_503_shed');
  bad.observed_facts.dual_staging_16al_deploy_flag_off.admission_flag
    .live_backpressure_shed_claimed = true;
  bad.gate_progress_updates.G06_scaling_capacity.still_open =
    bad.gate_progress_updates.G06_scaling_capacity.still_open.filter((x) => x !== 'live_503_shed');
  red('live_shed_overclaim_rejected',
    !validateEvidenceExact(bad).ok || !validateDeployFacts(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.claims_allowed.push('backpressure_proven');
  bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter(
    (x) => x !== 'backpressure_proven' && x !== 'backpressure_live_proven',
  );
  bad.disposition.proves.push('backpressure_proven');
  bad.gate_progress_updates.G06_scaling_capacity.still_open =
    bad.gate_progress_updates.G06_scaling_capacity.still_open.filter((x) => x !== 'backpressure');
  red('backpressure_proven_overclaim_rejected', !validateEvidenceExact(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.disposition.g06_verdict = 'proven';
  bad.gate_progress_updates.G06_scaling_capacity.verdict = 'proven';
  bad.gate_progress_updates.G06_scaling_capacity.still_open = [];
  bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'full_G06_proven');
  red('full_g06_overclaim_rejected', !validateEvidenceExact(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.lock_hash = '0'.repeat(64);
  red('lock_hash_mismatch_rejected', !validateEvidenceExact(bad).ok);
}
{
  const badDoc = `${doc}\n\nG06 proven with backpressure proven and live shed proven in production.\n`;
  const hits = overclaimHits(badDoc);
  red('doc_overclaim_tokens_detectable', hits.length > 0, hits.join(','));
}
{
  const bad = deepClone(evidence);
  bad.claims_allowed.push('production');
  bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'production');
  bad.disposition.proves.push('production');
  red('scope_overclaim_production_rejected', !validateEvidenceExact(bad).ok);
}

const redIds = new Set(redResults.map((r) => r.id));
const greenIds = new Set(greenResults.map((r) => r.id));
ok('C10 all REQUIRED_RED present',
  locks.REQUIRED_RED.every((id) => redIds.has(id)),
  locks.REQUIRED_RED.filter((id) => !redIds.has(id)).join(','));
ok('C11 all REQUIRED_GREEN present',
  locks.REQUIRED_GREEN.every((id) => greenIds.has(id)),
  locks.REQUIRED_GREEN.filter((id) => !greenIds.has(id)).join(','));
ok('C12 all RED/GREEN assertions passed',
  redResults.every((r) => r.ok) && greenResults.every((r) => r.ok));

for (const id of locks.REQUIRED_RED) {
  const row = redResults.find((r) => r.id === id);
  ok(`RED-required ${id}`, row && row.ok);
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16AM G06 backpressure deploy evidence: PASS');
