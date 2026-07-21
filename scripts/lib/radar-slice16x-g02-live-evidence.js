'use strict';

/**
 * radar-slice16x-g02-live-evidence — RADAR Slice 16X locks.
 *
 * Evidence-only reconciliation of dual-staging G02 lifecycle deploy +
 * controlled dependency-failure traffic-shed drill @ master 2dcda08.
 * This slice does not deploy or mutate live Azure beyond read-only verify.
 *
 * Proves: exact-SHA deploy + Activating traffic shed + restore/secretRef.
 * Does not prove: SIGTERM lifecycle behavior, organic alerts, production, full G02.
 */

const path = require('path');

const MASTER_BASIS = '2dcda08008fe951565560cefafe37f1a78b0791a';
const SLICE = 'RADAR-16X';
const OUTCOME_ID = '16X_g02_lifecycle_deploy_traffic_shed_live_evidence';
const GATE_ID = 'G02_readiness_dependencies';
const PROGRESS_CLASS = 'partial_live_proven_evidence_only';
const BRANCH = 'radar/slice-16x-g02-live-evidence';

const EVIDENCE_REL = 'fixtures/radar-operations/slice16x-g02-live-evidence.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16x-expected-contract.json';

const IMAGE_SHA_FULL = MASTER_BASIS;
const IMAGE_SHA_SHORT = '2dcda08';

const WH_APP = 'wh-staging-staff-api';
const WH_RG = 'wh-staging-rg';
const WH_IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_SHA_FULL}`;
const WH_DIGEST = 'sha256:536828373f2deaf5da638bdd4650cdcc2d9d97d4352aa9a6cac718c7f9d4054b';
const WH_BASE_REV = 'wh-staging-staff-api--0000518';
const WH_BASE_SUFFIX = '0000518';
const WH_FAIL_REV = 'wh-staging-staff-api--g02fail';
const WH_RESTORE_REV = 'wh-staging-staff-api--g02restore';
const WH_SECRET_REF = 'wolfhouse-database-url';
const WH_PUBLIC_HOST = 'staff-staging.lunafrontdesk.com';

const SUNSET_APP = 'luna-sunset-staging-staff-api';
const SUNSET_RG = 'luna-sunset-staging-rg';
const SUNSET_IMAGE = `whstagingacr.azurecr.io/luna-sunset-staff-api:${IMAGE_SHA_FULL}`;
const SUNSET_DIGEST = 'sha256:3c7022173cc931b2701b0a9adcbf0b092fe933281e81538d886028e53ec40a05';
const SUNSET_BASE_REV = 'luna-sunset-staging-staff-api--0000278';
const SUNSET_BASE_SUFFIX = '0000278';
const SUNSET_FAIL_REV = 'luna-sunset-staging-staff-api--g02fail';
const SUNSET_RESTORE_REV = 'luna-sunset-staging-staff-api--g02restore';
const SUNSET_SECRET_REF = 'sunset-database-url';
const SUNSET_PUBLIC_HOST = 'sunset-staging.lunafrontdesk.com';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

const OBS_DURATION_S = 90;
const OBS_CADENCE_S = 5;
const OBS_SAMPLE_COUNT = Math.floor(OBS_DURATION_S / OBS_CADENCE_S) + 1; // 19

function buildUniformObservationSamples() {
  const samples = [];
  for (let i = 0; i < OBS_SAMPLE_COUNT; i += 1) {
    samples.push({
      t_offset_s: i * OBS_CADENCE_S,
      fail_running_state: 'Activating',
      fail_was_latest_ready: false,
      public_healthz: 200,
      public_readyz: 200,
    });
  }
  return samples;
}

const OBSERVATION_SAMPLES = Object.freeze(buildUniformObservationSamples());

/** Azure activity-log / revision create timestamps (UTC). */
const WH_TIMELINE = Object.freeze({
  acr_tag_created_utc: '2026-07-21T10:05:58.4740201Z',
  base_revision_created_utc: '2026-07-21T10:06:41+00:00',
  fail_write_started_utc: '2026-07-21T10:18:30.5777877Z',
  fail_revision_created_utc: '2026-07-21T10:18:42+00:00',
  restore_write_started_utc: '2026-07-21T10:21:57.3085439Z',
  restore_revision_created_utc: '2026-07-21T10:22:08+00:00',
  deactivate_attempt_utc: '2026-07-21T10:22:48.6671Z',
  deactivate_result: 'RevisionAlreadyInRequestedState',
});

const SUNSET_TIMELINE = Object.freeze({
  acr_tag_created_utc: '2026-07-21T10:05:57.6261589Z',
  base_revision_created_utc: '2026-07-21T10:16:05+00:00',
  fail_write_started_utc: '2026-07-21T10:23:17.2513218Z',
  fail_revision_created_utc: '2026-07-21T10:23:26+00:00',
  restore_write_started_utc: '2026-07-21T10:26:47.6169176Z',
  restore_revision_created_utc: '2026-07-21T10:26:56+00:00',
  deactivate_attempt_utc: '2026-07-21T10:27:34.3463529Z',
  deactivate_result: 'RevisionAlreadyInRequestedState',
});

const INDEPENDENT_VERIFY_UTC = '2026-07-21T10:33:28Z';

const PROBE_SUMMARY = Object.freeze([
  { type: 'Liveness', path: '/healthz', port: 3036 },
  { type: 'Readiness', path: '/readyz', port: 3036 },
  { type: 'Startup', path: '/healthz', port: 3036 },
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'sigterm_sigint_closeReadinessPool_live_lifecycle_behavior',
  'organic_metric_alert_firing',
  'human_inbox_receipt',
  'production',
  'full_G02_proven',
  'serving_revision_readyz_503_body_path',
  'any_gate_verdict_proven',
]);

const CLAIMS_ALLOWED = Object.freeze([
  'exact_sha_2dcda08_images_digests_both_tenants',
  'base_revisions_wh_0000518_sunset_0000278_healthy_deploy',
  'g02fail_min1_literal_unreachable_dsn_stayed_activating_90s_never_latest_ready',
  'prior_revision_public_healthz_readyz_200_every_5s_observation',
  'exact_sha_g02restore_secretRef_healthy_latestReady_100pct_traffic',
  'failed_revision_deactivated_inactive',
  'final_public_healthz_readyz_200_both_tenants',
  'no_production_scope',
]);

const OWNED_RELS = Object.freeze([
  EVIDENCE_REL,
  CONTRACT_REL,
  'scripts/lib/radar-slice16x-g02-live-evidence.js',
  'scripts/verify-radar-slice16x-g02-live-evidence.js',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
]);

const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'docker/hermes-staging/',
  'scripts/staff-query-api.js',
  'scripts/lib/staff-api-readiness.js',
  'scripts/lib/staff-api-readiness-lifecycle.js',
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
  'infra/azure/staging-staff-api-metric-alerts/',
  'infra/azure/staging-cost-budgets/',
]);

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  EVIDENCE_REL,
  CONTRACT_REL,
  IMAGE_SHA_FULL,
  IMAGE_SHA_SHORT,
  WH_APP,
  WH_RG,
  WH_IMAGE,
  WH_DIGEST,
  WH_BASE_REV,
  WH_BASE_SUFFIX,
  WH_FAIL_REV,
  WH_RESTORE_REV,
  WH_SECRET_REF,
  WH_PUBLIC_HOST,
  SUNSET_APP,
  SUNSET_RG,
  SUNSET_IMAGE,
  SUNSET_DIGEST,
  SUNSET_BASE_REV,
  SUNSET_BASE_SUFFIX,
  SUNSET_FAIL_REV,
  SUNSET_RESTORE_REV,
  SUNSET_SECRET_REF,
  SUNSET_PUBLIC_HOST,
  SUBSCRIPTION_ID,
  OBS_DURATION_S,
  OBS_CADENCE_S,
  OBS_SAMPLE_COUNT,
  OBSERVATION_SAMPLES,
  WH_TIMELINE,
  SUNSET_TIMELINE,
  INDEPENDENT_VERIFY_UTC,
  PROBE_SUMMARY,
  EXPLICITLY_NOT_CLAIMED,
  CLAIMS_ALLOWED,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  buildUniformObservationSamples,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
