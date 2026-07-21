'use strict';

/**
 * radar-slice16ao-g06-backpressure-activation-evidence — RADAR Slice 16AO locks.
 *
 * Evidence-only reconciliation of corrected dual-staging Staff API admission
 * activation of 16AN @ master 9da22843. Claims bound only to committed
 * secret-free raw fixtures (+ labeled operator-attested probe/env facts) via
 * SHA-256. Proves healthy activation + invalid-signature auth-rejection 403
 * path only; does NOT claim queue-overflow/503 overload shedding, fairness,
 * soak, autoscale, SLO, alerts, production, or full G06. Score unchanged.
 */

const path = require('path');

const MASTER_BASIS = '9da228436c21bf7777cee553c91877a7e62a4092';
const SLICE = 'RADAR-16AO';
const OUTCOME_ID = '16AO_g06_backpressure_activation_evidence';
const GATE_ID = 'G06_scaling_capacity';
const GATE_IDS = Object.freeze([GATE_ID]);
const PROGRESS_CLASS = 'partial_live_proven_evidence_only';
const BRANCH = 'radar/slice-16ao-g06-backpressure-activation-evidence';

const EVIDENCE_REL = 'fixtures/radar-operations/slice16ao-g06-backpressure-activation-evidence.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16ao-expected-contract.json';

const RAW_SUNSET_CORRECTED_REL = 'fixtures/radar-operations/slice16ao-raw-sunset-corrected.json';
const RAW_WH_DEPLOY_OFF_REL = 'fixtures/radar-operations/slice16ao-raw-wh-deploy-off.json';
const RAW_WH_ENABLE_CORRECTED_REL = 'fixtures/radar-operations/slice16ao-raw-wh-enable-corrected.json';
const RAW_WH_FAILED_CANARY_REL = 'fixtures/radar-operations/slice16ao-raw-wh-failed-canary.json';
const RAW_WH_ROLLBACK_REL = 'fixtures/radar-operations/slice16ao-raw-wh-rollback.json';
const RAW_COST_BEFORE_REL = 'fixtures/radar-operations/slice16ao-raw-cost-before.json';
const RAW_COST_AFTER_REL = 'fixtures/radar-operations/slice16ao-raw-cost-after.json';
const RAW_ACR_DIGEST_REL = 'fixtures/radar-operations/slice16ao-raw-acr-digest.json';
const RAW_OPERATOR_ATTESTED_REL = 'fixtures/radar-operations/slice16ao-raw-operator-attested.json';

const RAW_SUNSET_CORRECTED_SHA256 = '4fd9006692b19fad4845ee4103c941601437dbd37deab99ac6fd5ef9fbb54752';
const RAW_WH_DEPLOY_OFF_SHA256 = '698b5146216f64966d76bd835666f29e4572de3686a58c6675322e639f6ec2fe';
const RAW_WH_ENABLE_CORRECTED_SHA256 = 'dffed5e3de1869bc42268222b5e9791a3375aa0204d8446eca48cea5b39cfbf6';
const RAW_WH_FAILED_CANARY_SHA256 = '48e85d247b2f0059f5771b0b210b5ff60efbc1b02ed1bdf473f093156c5ad3bc';
const RAW_WH_ROLLBACK_SHA256 = 'c765da76128068d1e5fcb6337fa564a22db10693365ff046c1c4d73a9b03c01d';
const RAW_COST_BEFORE_SHA256 = 'a68d223c6637f9fc432a0ed211e56beb3f23324ff58b18bcc554f44c5926d74e';
const RAW_COST_AFTER_SHA256 = '16107d84b351f0f8839f1b2bc7e23f296036a3206af129c95c42ca23d4535d03';
const RAW_ACR_DIGEST_SHA256 = '720859f8f36de940efc9141fdf8768d65b4014c19023b2ef08e185c0522df834';
const RAW_OPERATOR_ATTESTED_SHA256 = '00490beaf94b95d6b3f854cbe2ee507c2660cfda68e269935cd81cff7aa3f9ff';

const EXCLUDED_EPHEMERAL_PATHS = Object.freeze([
  '/tmp/16an-sunset-deploy.json',
  '/tmp/16an-wh-deploy-off.json',
  '/tmp/16an-wh-enable-corrected.json',
  '/tmp/16an-wh-enable.json',
  '/tmp/16an-wh-rollback.json',
  '/tmp/16an-sunset-enable.json',
  'tmp/foundation-slice9/',
]);

const INDEPENDENT_VERIFY_UTC = '2026-07-21T20:46:01Z';
const ACR_BUILD_RUN_ID = 'cb11g';
const DIGEST =
  'sha256:46ebd0a8ab4dd7c9a6ac92d4003c1f0fbaf9d664f8c35c1ae1810becc3a7b655';
const IMAGE_TAG = MASTER_BASIS;
const WH_IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const SUNSET_IMAGE = `whstagingacr.azurecr.io/luna-sunset-staff-api:${IMAGE_TAG}`;
const SUNSET_REVISION = 'luna-sunset-staging-staff-api--0000282';
const WH_DEPLOY_OFF_REVISION = 'wh-staging-staff-api--0000524';
const WH_ACTIVATION_REVISION = 'wh-staging-staff-api--0000525';
const WH_FAILED_CANARY_REVISION = 'wh-staging-staff-api--0000522';
const WH_ROLLBACK_REVISION = 'wh-staging-staff-api--0000523';
const FLAG_ENV = 'STAFF_API_ADMISSION_CONTROL';
const INGRESS_ENV = 'STAFF_API_INGRESS_TENANT_SLUG';

const COST_AMOUNT = 18.5705435806452;
const COST_DELTA = 0;
const COST_CURRENCY = 'USD';
const COST_SCOPE =
  '/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/luna-sunset-staging-rg';
const COST_BEFORE_AT = '2026-07-21T20:42:29.998Z';
const COST_AFTER_AT = '2026-07-21T20:46:01.423Z';
const COST_PERIOD = Object.freeze({
  from: '2026-07-01',
  to: '2026-07-21',
  label: 'month-to-date',
});
const COST_DISCLOSURE = 'covers_build_deploy_elapsed_mtd_not_causal_feature_cost';

const FINAL_CONTROLLED_DRILL_STATUS = 'live_proven';
const FINAL_CONTROLLED_DRILL_ID = '16AO_EVIDENCE_corrected_dual_staging_admission_activation';

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'queue_overflow_503_overload_shedding',
  'live_503_overload_shed',
  'fairness',
  'backpressure_proven',
  'backpressure_live_proven',
  'load_soak_proof',
  'capacity_alert_firing',
  'notification_delivery',
  'autoscaling',
  'capacity_slo_error_budget_live',
  'production',
  'full_G06_proven',
  'any_gate_verdict_proven',
  'min_max_replica_mutation',
  'causal_feature_cost',
]);

const CLAIMS_ALLOWED = Object.freeze([
  'corrected_dual_staging_admission_activation_live_proven',
  'acr_build_cb11g_digest_and_full_sha_tag_both_repos',
  'sunset_revision_0000282_wh_0000524_off_then_0000525_on_exact_image',
  'ingress_slug_and_admission_flag_operator_attested_both_true',
  'invalid_signature_probes_80_80_expected_403_auth_rejection_not_overload_shed',
  'historical_failed_canary_identity_fail_closed_recorded',
  'sunset_mtd_actualcost_identical_delta_disclosed',
  'durable_raw_artifact_sha256_provenance',
  'g06_remains_partial_score_unchanged_0_9_0',
  'overload_shed_fairness_soak_autoscale_slo_alerts_production_open',
]);

const OWNED_RELS = Object.freeze([
  EVIDENCE_REL,
  CONTRACT_REL,
  RAW_SUNSET_CORRECTED_REL,
  RAW_WH_DEPLOY_OFF_REL,
  RAW_WH_ENABLE_CORRECTED_REL,
  RAW_WH_FAILED_CANARY_REL,
  RAW_WH_ROLLBACK_REL,
  RAW_COST_BEFORE_REL,
  RAW_COST_AFTER_REL,
  RAW_ACR_DIGEST_REL,
  RAW_OPERATOR_ATTESTED_REL,
  'scripts/lib/radar-slice16ao-g06-backpressure-activation-evidence.js',
  'scripts/verify-radar-slice16ao-g06-backpressure-activation-evidence.js',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
]);

const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'docker/hermes-staging/',
  'scripts/lib/staff-api-admission-boundary.js',
  'scripts/lib/radar-g06-admission-control.js',
  'scripts/lib/staff-api-request-correlation.js',
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
  'infra/azure/staging-staff-api-metric-alerts/',
  'infra/azure/staging-cost-budgets/',
]);

const REQUIRED_RED = Object.freeze([
  'digest_drift_rejected',
  'tag_drift_rejected',
  'sunset_revision_drift_rejected',
  'wh_activation_revision_drift_rejected',
  'overload_shed_overclaim_rejected',
  'backpressure_proven_overclaim_rejected',
  'full_g06_overclaim_rejected',
  'cost_amount_drift_rejected',
  'raw_artifact_hash_drift_rejected',
  'lock_hash_mismatch_rejected',
  'doc_overclaim_tokens_detectable',
  'scope_overclaim_production_rejected',
  'probe_as_overload_shed_rejected',
]);

const REQUIRED_GREEN = Object.freeze([
  'acr_digest_tag_both_repos',
  'sunset_wh_revisions_exact_image',
  'env_names_present_ingress_admission',
  'operator_attested_flags_true_probes_403',
  'historical_canary_identity_fail_closed',
  'sunset_cost_identical_delta_disclosed',
  'raw_artifacts_sha256_match',
  'evidence_values_match_raw_artifacts',
  'final_controlled_drill_live_proven_activation_only',
  'g06_remains_partial',
  'score_not_inflated',
  'package_script_registered',
  'runtime_paths_unchanged',
  '16an_ingress_source_retained',
]);

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  GATE_IDS,
  PROGRESS_CLASS,
  BRANCH,
  EVIDENCE_REL,
  CONTRACT_REL,
  RAW_SUNSET_CORRECTED_REL,
  RAW_WH_DEPLOY_OFF_REL,
  RAW_WH_ENABLE_CORRECTED_REL,
  RAW_WH_FAILED_CANARY_REL,
  RAW_WH_ROLLBACK_REL,
  RAW_COST_BEFORE_REL,
  RAW_COST_AFTER_REL,
  RAW_ACR_DIGEST_REL,
  RAW_OPERATOR_ATTESTED_REL,
  RAW_SUNSET_CORRECTED_SHA256,
  RAW_WH_DEPLOY_OFF_SHA256,
  RAW_WH_ENABLE_CORRECTED_SHA256,
  RAW_WH_FAILED_CANARY_SHA256,
  RAW_WH_ROLLBACK_SHA256,
  RAW_COST_BEFORE_SHA256,
  RAW_COST_AFTER_SHA256,
  RAW_ACR_DIGEST_SHA256,
  RAW_OPERATOR_ATTESTED_SHA256,
  EXCLUDED_EPHEMERAL_PATHS,
  INDEPENDENT_VERIFY_UTC,
  ACR_BUILD_RUN_ID,
  DIGEST,
  IMAGE_TAG,
  WH_IMAGE,
  SUNSET_IMAGE,
  SUNSET_REVISION,
  WH_DEPLOY_OFF_REVISION,
  WH_ACTIVATION_REVISION,
  WH_FAILED_CANARY_REVISION,
  WH_ROLLBACK_REVISION,
  FLAG_ENV,
  INGRESS_ENV,
  COST_AMOUNT,
  COST_DELTA,
  COST_CURRENCY,
  COST_SCOPE,
  COST_BEFORE_AT,
  COST_AFTER_AT,
  COST_PERIOD,
  COST_DISCLOSURE,
  FINAL_CONTROLLED_DRILL_STATUS,
  FINAL_CONTROLLED_DRILL_ID,
  EXPLICITLY_NOT_CLAIMED,
  CLAIMS_ALLOWED,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  REQUIRED_RED,
  REQUIRED_GREEN,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
