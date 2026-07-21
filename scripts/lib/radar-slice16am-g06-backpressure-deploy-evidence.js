'use strict';

/**
 * radar-slice16am-g06-backpressure-deploy-evidence — RADAR Slice 16AM locks.
 *
 * Evidence-only reconciliation of dual-staging Staff API deploy of 16AL @
 * master 905ff9ff with STAFF_API_ADMISSION_CONTROL OFF/unset. Claims bound
 * only to committed secret-free raw fixtures via SHA-256. Does not enable the
 * flag, claim live shed/backpressure proven, or raise G06. Score unchanged.
 */

const path = require('path');

const MASTER_BASIS = '905ff9ff57a75d0b3defc15a16078b47e94e930f';
const SLICE = 'RADAR-16AM';
const OUTCOME_ID = '16AM_g06_backpressure_deploy_evidence';
const GATE_ID = 'G06_scaling_capacity';
const GATE_IDS = Object.freeze([GATE_ID]);
const PROGRESS_CLASS = 'partial_live_proven_evidence_only';
const BRANCH = 'radar/slice-16am-g06-backpressure-deploy-evidence';

const EVIDENCE_REL = 'fixtures/radar-operations/slice16am-g06-backpressure-deploy-evidence.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16am-expected-contract.json';

const RAW_WH_UPDATE_REL = 'fixtures/radar-operations/slice16am-raw-wh-update.json';
const RAW_SUNSET_UPDATE_REL = 'fixtures/radar-operations/slice16am-raw-sunset-update.json';
const RAW_COST_BEFORE_REL = 'fixtures/radar-operations/slice16am-raw-cost-before.json';
const RAW_COST_AFTER_REL = 'fixtures/radar-operations/slice16am-raw-cost-after.json';
const RAW_READYZ_WH_REL = 'fixtures/radar-operations/slice16am-raw-readyz-wh.json';
const RAW_READYZ_SUNSET_REL = 'fixtures/radar-operations/slice16am-raw-readyz-sunset.json';
const RAW_ACR_DIGEST_REL = 'fixtures/radar-operations/slice16am-raw-acr-digest.json';

const RAW_WH_UPDATE_SHA256 =
  'b197dfb3af5815976ddee023f795735ec676379b6e1252ea22aa912ec809ecd9';
const RAW_SUNSET_UPDATE_SHA256 =
  '4c965a3108544613358b36f9e92db359d9378fa0c3e424afaf10940a9ed1a150';
const RAW_COST_BEFORE_SHA256 =
  'e5f6edc31075ef9028cc2409ee44879dc74ec8a4a769ab5bf20045ddd738fad4';
const RAW_COST_AFTER_SHA256 =
  'bf5339f49f7540ba6a3836cd4aef96aa67ea98211503f081c31a6c2afbdb3445';
const RAW_READYZ_WH_SHA256 =
  '9994e13386b29bde4071dd062d8c4ab8dbb6b4b877f968b4a34fb2c7b0ead65e';
const RAW_READYZ_SUNSET_SHA256 =
  '9994e13386b29bde4071dd062d8c4ab8dbb6b4b877f968b4a34fb2c7b0ead65e';
const RAW_ACR_DIGEST_SHA256 =
  '8730b220a94c16ab0fe9a4685ad424a03261daa56e4be407695b11d956c0868c';

const EXCLUDED_EPHEMERAL_PATHS = Object.freeze([
  '/tmp/16al-wh-update.json',
  '/tmp/16al-sunset-update.json',
  '/tmp/wh-readyz.txt',
  '/tmp/sunset-readyz.txt',
  'tmp/foundation-slice9/',
]);

const INDEPENDENT_VERIFY_UTC = '2026-07-21T19:53:21Z';
const ACR_BUILD_RUN_ID = 'cb11f';
const DIGEST =
  'sha256:55ddc5ebaba3c6021b3d3a1d746935bb5dfc20b228d1de71daa97e33c6e235e1';
const IMAGE_TAG = MASTER_BASIS;
const WH_IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const SUNSET_IMAGE = `whstagingacr.azurecr.io/luna-sunset-staff-api:${IMAGE_TAG}`;
const WH_REVISION = 'wh-staging-staff-api--0000521';
const WH_LATEST_READY_AT_UPDATE = 'wh-staging-staff-api--0000520';
const SUNSET_LATEST_READY = 'luna-sunset-staging-staff-api--g02503r';
const SUNSET_LATEST_AT_UPDATE = 'luna-sunset-staging-staff-api--0000280';
const READY_STATUS = 'ready';
const FLAG_ENV = 'STAFF_API_ADMISSION_CONTROL';

const COST_AMOUNT = 18.4680092365591;
const COST_CURRENCY = 'USD';
const COST_SCOPE =
  '/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/luna-sunset-staging-rg';
const COST_BEFORE_AT = '2026-07-21T19:48:52.671Z';
const COST_AFTER_AT = '2026-07-21T19:53:21.970Z';
const COST_PERIOD = Object.freeze({
  from: '2026-07-01',
  to: '2026-07-21',
  label: 'month-to-date',
});

const FINAL_CONTROLLED_DRILL_STATUS = 'live_proven';
const FINAL_CONTROLLED_DRILL_ID = '16AM_EVIDENCE_dual_staging_16al_deploy_flag_off';

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'flag_enabled',
  'live_503_shed',
  'admission_controller_activated',
  'backpressure_live_proven',
  'backpressure_proven',
  'load_soak_proof',
  'capacity_alert_firing',
  'notification_delivery',
  'autoscaling',
  'capacity_slo_error_budget_live',
  'production',
  'full_G06_proven',
  'any_gate_verdict_proven',
  'sunset_new_revision_identity_beyond_latestReady_readback',
  'min_max_replica_mutation',
]);

const CLAIMS_ALLOWED = Object.freeze([
  'dual_staging_16al_image_deploy_flag_off_live_proven',
  'acr_build_cb11f_digest_and_full_sha_tag_both_repos',
  'wolfhouse_image_exact_tag_revision_0000521',
  'sunset_image_exact_tag_latestReady_g02503r_unchanged_name',
  'both_readyz_status_ready',
  'STAFF_API_ADMISSION_CONTROL_absent_both_controller_disabled',
  'sunset_mtd_actualcost_identical_before_after',
  'durable_raw_artifact_sha256_provenance',
  'g06_remains_partial_score_unchanged_0_9_0',
  'activation_load_fire_autoscale_slo_production_open',
  'no_live_backpressure_shed_claim',
]);

const OWNED_RELS = Object.freeze([
  EVIDENCE_REL,
  CONTRACT_REL,
  RAW_WH_UPDATE_REL,
  RAW_SUNSET_UPDATE_REL,
  RAW_COST_BEFORE_REL,
  RAW_COST_AFTER_REL,
  RAW_READYZ_WH_REL,
  RAW_READYZ_SUNSET_REL,
  RAW_ACR_DIGEST_REL,
  'scripts/lib/radar-slice16am-g06-backpressure-deploy-evidence.js',
  'scripts/verify-radar-slice16am-g06-backpressure-deploy-evidence.js',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
]);

const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'docker/hermes-staging/',
  'scripts/staff-query-api.js',
  'scripts/lib/staff-api-admission-boundary.js',
  'scripts/lib/radar-g06-admission-control.js',
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
  'infra/azure/staging-staff-api-metric-alerts/',
  'infra/azure/staging-cost-budgets/',
]);

const REQUIRED_RED = Object.freeze([
  'digest_drift_rejected',
  'tag_drift_rejected',
  'wh_revision_drift_rejected',
  'sunset_latestReady_drift_rejected',
  'sunset_new_revision_overclaim_rejected',
  'flag_enabled_overclaim_rejected',
  'readyz_drift_rejected',
  'cost_amount_drift_rejected',
  'raw_artifact_hash_drift_rejected',
  'live_shed_overclaim_rejected',
  'backpressure_proven_overclaim_rejected',
  'full_g06_overclaim_rejected',
  'lock_hash_mismatch_rejected',
  'doc_overclaim_tokens_detectable',
  'scope_overclaim_production_rejected',
]);

const REQUIRED_GREEN = Object.freeze([
  'acr_digest_tag_both_repos',
  'wh_image_revision_exact',
  'sunset_image_latestReady_unchanged_name',
  'both_readyz_ready',
  'admission_flag_absent_both',
  'sunset_cost_identical_before_after',
  'raw_artifacts_sha256_match',
  'evidence_values_match_raw_artifacts',
  'final_controlled_drill_live_proven_deploy_flag_off_only',
  'g06_remains_partial',
  'score_not_inflated',
  'package_script_registered',
  'runtime_paths_unchanged',
  '16al_wire_source_retained',
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
  RAW_WH_UPDATE_REL,
  RAW_SUNSET_UPDATE_REL,
  RAW_COST_BEFORE_REL,
  RAW_COST_AFTER_REL,
  RAW_READYZ_WH_REL,
  RAW_READYZ_SUNSET_REL,
  RAW_ACR_DIGEST_REL,
  RAW_WH_UPDATE_SHA256,
  RAW_SUNSET_UPDATE_SHA256,
  RAW_COST_BEFORE_SHA256,
  RAW_COST_AFTER_SHA256,
  RAW_READYZ_WH_SHA256,
  RAW_READYZ_SUNSET_SHA256,
  RAW_ACR_DIGEST_SHA256,
  EXCLUDED_EPHEMERAL_PATHS,
  INDEPENDENT_VERIFY_UTC,
  ACR_BUILD_RUN_ID,
  DIGEST,
  IMAGE_TAG,
  WH_IMAGE,
  SUNSET_IMAGE,
  WH_REVISION,
  WH_LATEST_READY_AT_UPDATE,
  SUNSET_LATEST_READY,
  SUNSET_LATEST_AT_UPDATE,
  READY_STATUS,
  FLAG_ENV,
  COST_AMOUNT,
  COST_CURRENCY,
  COST_SCOPE,
  COST_BEFORE_AT,
  COST_AFTER_AT,
  COST_PERIOD,
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
