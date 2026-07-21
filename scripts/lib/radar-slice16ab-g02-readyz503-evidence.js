'use strict';

/**
 * radar-slice16ab-g02-readyz503-evidence — RADAR Slice 16AB locks.
 *
 * Evidence-only reconciliation of completed dual-staging serving-revision
 * /readyz=503 body-path drill @ master c43b4a14. No live mutation.
 * Provenance split:
 *   (A) operator-observed drill transcript contemporaneous facts
 *       (Multiple mode + 100% pin to healthy; isolated min=1/max=1 fail
 *        revision on exact image with dummy unreachable literal
 *        WOLFHOUSE_DATABASE_URL (value never recorded); az containerapp exec
 *        local Node HTTP GET http://127.0.0.1:3036/readyz → exact 503 +
 *        {status:not-ready}; public healthy /readyz stayed 200; cleanup)
 *       observed_at = unavailable_in_command_transcript (do not invent)
 *   (B) independently recoverable Azure/ACR/public read-only final facts
 *
 * Proves: deployed serving failed revision emits bounded generic 503 body on
 * both staging tenants while public healthy revision remained selected
 * (isolated; fail not public traffic).
 * Does not prove: concurrent sampled continuity, zero-downtime-during-restart,
 * organic alerts, production, full G02. G02 remains partial.
 *
 * Azure cannot recreate historical localhost 503/body or traffic sequence.
 */

const path = require('path');

const MASTER_BASIS = 'c43b4a14d14d5618d99e0e969b4f39784a526722';
const SLICE = 'RADAR-16AB';
const OUTCOME_ID = '16AB_g02_serving_readyz_503_body_path_evidence';
const GATE_ID = 'G02_readiness_dependencies';
const PROGRESS_CLASS = 'partial_live_proven_evidence_only';
const BRANCH = 'radar/slice-16ab-g02-readyz503-evidence';

const EVIDENCE_REL = 'fixtures/radar-operations/slice16ab-g02-readyz503-evidence.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16ab-expected-contract.json';

const IMAGE_SHA_FULL = '95dc3634ac6aaa6de495d22f5f5d8cd0a955df97';
const IMAGE_SHA_SHORT = '95dc363';

const WH_APP = 'wh-staging-staff-api';
const WH_RG = 'wh-staging-rg';
const WH_IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_SHA_FULL}`;
const WH_DIGEST = 'sha256:a9677f75a7d17be9b6ae75b60bc026d462df971cc164496344c29b8c57aee6de';
const WH_FAIL_REVISION = 'wh-staging-staff-api--g02503';
const WH_FAIL_REPLICA = 'wh-staging-staff-api--g02503-66667d8476-r2jzv';
const WH_RESTORE_REVISION = 'wh-staging-staff-api--g02503r';
const WH_RESTORE_REPLICA = 'wh-staging-staff-api--g02503r-9764596b8-gwl7r';
const WH_PUBLIC_HOST = 'staff-staging.lunafrontdesk.com';
const WH_RESTORE_MIN = 0;
const WH_RESTORE_MAX = 1;
const WH_FAIL_MIN = 1;
const WH_FAIL_MAX = 1;

const SUNSET_APP = 'luna-sunset-staging-staff-api';
const SUNSET_RG = 'luna-sunset-staging-rg';
const SUNSET_IMAGE = `whstagingacr.azurecr.io/luna-sunset-staff-api:${IMAGE_SHA_FULL}`;
const SUNSET_DIGEST = 'sha256:8a0b1647ba246bb548d437fcc37e3e4f600181ca1d04dc1eb73e3f4a69d51c10';
const SUNSET_FAIL_REVISION = 'luna-sunset-staging-staff-api--g02503';
const SUNSET_FAIL_REPLICA = 'luna-sunset-staging-staff-api--g02503-58d5745f7c-fhnqt';
const SUNSET_RESTORE_REVISION = 'luna-sunset-staging-staff-api--g02503r';
const SUNSET_RESTORE_REPLICA = 'luna-sunset-staging-staff-api--g02503r-f4d4b7875-dw7cx';
const SUNSET_PUBLIC_HOST = 'sunset-staging.lunafrontdesk.com';
const SUNSET_RESTORE_MIN = 1;
const SUNSET_RESTORE_MAX = 1;
const SUNSET_FAIL_MIN = 1;
const SUNSET_FAIL_MAX = 1;

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

const LOCAL_READYZ_URL = 'http://127.0.0.1:3036/readyz';
const LOCAL_READYZ_METHOD = 'GET';
const LOCAL_READYZ_STATUS = 503;
const LOCAL_READYZ_BODY = Object.freeze({ status: 'not-ready' });
const EXEC_METHOD = 'az_containerapp_exec';
const EXEC_PROBE_SEMANTICS = 'local_node_http_get_readyz_on_fail_replica_loopback';

const DUMMY_DSN_CLASS = 'dummy_unreachable_literal_WOLFHOUSE_DATABASE_URL';
const DUMMY_DSN_VALUE_RECORDED = false;
const DUMMY_DSN_NOTE =
  'Fail revision used a dummy unreachable literal WOLFHOUSE_DATABASE_URL; '
  + 'the literal value is intentionally not recorded (secret/DSN rejection).';

const OBSERVED_AT_UNAVAILABLE = 'unavailable_in_command_transcript';

/** (A) transcript-derived contemporaneous observation. */
const SOURCE_TYPE_A = 'operator_drill_transcript_contemporaneous_observation';
const SOURCE_REF_A = 'operator_g02_serving_readyz_503_command_transcript';
const OBSERVED_AT_SEMANTICS_A =
  'contemporaneous_operator_exec_local_readyz_503_and_traffic_isolation_not_azure_reconstructible_observed_at_unavailable_in_command_transcript';

/** (B) independently recoverable Azure/ACR/public current. */
const SOURCE_TYPE_B = 'azure_acr_public_readonly_independently_reverified';
const SOURCE_REF_B =
  'az_containerapp_acr_public_curl_readonly_2026-07-21T12:43:09Z';
const OBSERVED_AT_SEMANTICS_B = 'independently_reverified_at_recorded_utc';

const INDEPENDENT_VERIFY_UTC = '2026-07-21T12:43:09Z';

const WH_FAIL_CREATED_UTC = '2026-07-21T12:33:11+00:00';
const WH_FAIL_LAST_ACTIVE_UTC = '2026-07-21T12:35:49+00:00';
const WH_RESTORE_CREATED_UTC = '2026-07-21T12:35:48+00:00';
const SUNSET_FAIL_CREATED_UTC = '2026-07-21T12:37:35+00:00';
const SUNSET_FAIL_LAST_ACTIVE_UTC = '2026-07-21T12:38:40+00:00';
const SUNSET_RESTORE_CREATED_UTC = '2026-07-21T12:38:53+00:00';

const ACTIVE_REVISIONS_MODE_FINAL = 'Single';
const TRAFFIC_ISOLATION_SEMANTICS =
  'fail_revision_isolated_zero_public_traffic_healthy_revision_selected_100_percent';

const PROVENANCE_LIMITATIONS =
  'Class A operator Multiple-mode temporary switch, 100% public traffic pin to known '
  + 'healthy revision, isolated min=1/max=1 fail revision copy on exact image with '
  + 'dummy unreachable literal WOLFHOUSE_DATABASE_URL (value not recorded), exact fail '
  + 'replicas, az containerapp exec local Node HTTP GET http://127.0.0.1:3036/readyz '
  + 'exact status 503 and body {status:not-ready}, public healthy /readyz stayed 200, '
  + 'and cleanup sequence are operator-observed contemporaneous transcript facts. '
  + 'No exact transcript timestamp was captured: observed_at is locked to '
  + 'unavailable_in_command_transcript and must not be invented. Class B digests/'
  + 'restore revisions/fail inactive-stopped-0 replicas/scale/mode/traffic/public-'
  + 'current are independently reverified Azure/ACR/public read-only facts at '
  + 'independent_azure_verify_utc. Do not treat A as Azure-reconstructible, and do '
  + 'not treat current public probes as authority to rewrite A historical localhost '
  + '503/body or traffic sequence. Isolation means fail revision was not selected for '
  + 'public traffic; do not claim non-isolated traffic.';

const NON_RECOVERABILITY =
  'Azure/ACR/public read-only APIs cannot recreate or replay the historical operator '
  + 'localhost 503/body samples, exact fail-replica loopback HTTP observations, '
  + 'Multiple-mode traffic pin sequence, or contemporaneous public healthy /readyz=200 '
  + 'during the drill window; those values exist only in the operator drill command '
  + 'transcript. Fail replica names are not recoverable from Azure once revisions are '
  + 'stopped (replica list empty). Current public probes and revision metadata verify '
  + 'present final state only. Azure cannot invent a missing transcript timestamp.';

const CLAIM_OWNERSHIP = Object.freeze({
  local_readyz_503_body: Object.freeze({
    owner_class: 'A_operator_observed_drill_transcript',
    observation: 'az_exec_local_node_http_get_readyz_503_not_ready_body',
    proves: [
      'serving_failed_revision_emits_bounded_generic_503_body',
      'exact_status_503',
      'exact_body_status_not_ready',
      'both_staging_tenants',
    ],
    does_not_prove: [
      'concurrent_sampled_continuity',
      'zero_downtime_during_restart',
      'public_fail_revision_traffic',
      'organic_metric_alert_firing',
      'production',
      'full_G02_proven',
    ],
    observed_at: OBSERVED_AT_UNAVAILABLE,
    limitation:
      'Localhost 503/body is transcript-only; observed_at unavailable_in_command_transcript; '
      + 'Azure cannot recreate historical localhost samples',
  }),
  traffic_isolation_during_drill: Object.freeze({
    owner_class: 'A_operator_observed_drill_transcript',
    observation: 'multiple_mode_100_percent_pin_healthy_fail_isolated_zero_public_traffic',
    proves: [
      'public_healthy_revision_remained_selected',
      'fail_revision_not_public_traffic',
    ],
    does_not_prove: [
      'concurrent_sampled_continuity',
      'zero_downtime_during_restart',
    ],
    observed_at: OBSERVED_AT_UNAVAILABLE,
    limitation:
      'Traffic-isolation sequence is transcript-only; Azure final Single/100% restore does '
      + 'not reconstruct the historical Multiple-mode pin sequence',
  }),
  final_azure_restore_state: Object.freeze({
    owner_class: 'B_independently_recoverable_azure_readonly',
    observation: 'single_mode_restore_healthy_latestReady_100_fail_inactive_stopped_0',
    proves: [
      'exact_sha_95dc363_images_digests_both_tenants',
      'restore_revisions_healthy_latestReady_100',
      'fail_revisions_inactive_stopped_replicas_0',
      'public_current_readyz_healthz_200',
      'wh_restore_min0_max1_sunset_restore_min1_max1',
    ],
    does_not_derive_from: 'historical_localhost_503',
    limitation:
      'Class B final state does not prove or recreate class-A historical localhost 503/body '
      + 'or traffic sequence',
  }),
});

const PROBE_SUMMARY = Object.freeze([
  { type: 'Liveness', path: '/healthz', port: 3036 },
  { type: 'Readiness', path: '/readyz', port: 3036 },
  { type: 'Startup', path: '/healthz', port: 3036 },
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'concurrent_sampled_continuity',
  'zero_downtime_during_restart',
  'organic_metric_alert_firing',
  'human_inbox_receipt',
  'production',
  'full_G02_proven',
  'any_gate_verdict_proven',
  'fail_revision_received_public_traffic',
  'azure_derived_historical_localhost_503',
  'invented_transcript_timestamp',
  'dsn_or_secret_value_disclosure',
]);

const CLAIMS_ALLOWED = Object.freeze([
  'exact_sha_95dc363_images_digests_both_tenants',
  'fail_revisions_wh_g02503_sunset_g02503_exact_image',
  'exact_fail_replicas_wh_r2jzv_sunset_fhnqt_transcript_only',
  'az_exec_local_readyz_503_not_ready_body_both_tenants',
  'public_healthy_revision_remained_selected_fail_isolated',
  'public_healthy_readyz_stayed_200_during_drill_transcript',
  'cleanup_fail_deactivated_restore_single_100',
  'final_restore_wh_g02503r_min0_max1_sunset_g02503r_min1_max1',
  'fail_inactive_stopped_replicas_0_both_tenants',
  'public_current_healthz_readyz_200_both_tenants',
  'observed_at_unavailable_in_command_transcript_disclosed',
  'no_production_scope',
  'no_dsn_or_secret_values_recorded',
]);

const OWNED_RELS = Object.freeze([
  EVIDENCE_REL,
  CONTRACT_REL,
  'scripts/lib/radar-slice16ab-g02-readyz503-evidence.js',
  'scripts/verify-radar-slice16ab-g02-readyz503-evidence.js',
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
  'scripts/lib/staff-api-readiness-shutdown-completion-log.js',
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
  'infra/azure/staging-staff-api-metric-alerts/',
  'infra/azure/staging-cost-budgets/',
]);

function mergeLiveProbeWithoutRewritingHistorical(evidence, liveProbeResult) {
  const out = JSON.parse(JSON.stringify(evidence));
  const b = out.observed_facts
    && out.observed_facts.B_independently_recoverable_azure_readonly;
  if (b && liveProbeResult && typeof liveProbeResult === 'object') {
    b.live_probe_attempt = {
      attempted_at_utc: liveProbeResult.attempted_at_utc || null,
      result: liveProbeResult.result || 'unknown',
      note: 'Live probe result must not rewrite class-A historical transcript facts',
    };
  }
  return out;
}

function historicalSamplesRewrittenByLiveProbe(before, after) {
  const aBefore = before.observed_facts
    && before.observed_facts.A_operator_observed_drill_transcript;
  const aAfter = after.observed_facts
    && after.observed_facts.A_operator_observed_drill_transcript;
  if (!aBefore || !aAfter) return true;
  return JSON.stringify(aBefore) !== JSON.stringify(aAfter);
}

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
  WH_FAIL_REVISION,
  WH_FAIL_REPLICA,
  WH_RESTORE_REVISION,
  WH_RESTORE_REPLICA,
  WH_PUBLIC_HOST,
  WH_RESTORE_MIN,
  WH_RESTORE_MAX,
  WH_FAIL_MIN,
  WH_FAIL_MAX,
  SUNSET_APP,
  SUNSET_RG,
  SUNSET_IMAGE,
  SUNSET_DIGEST,
  SUNSET_FAIL_REVISION,
  SUNSET_FAIL_REPLICA,
  SUNSET_RESTORE_REVISION,
  SUNSET_RESTORE_REPLICA,
  SUNSET_PUBLIC_HOST,
  SUNSET_RESTORE_MIN,
  SUNSET_RESTORE_MAX,
  SUNSET_FAIL_MIN,
  SUNSET_FAIL_MAX,
  SUBSCRIPTION_ID,
  LOCAL_READYZ_URL,
  LOCAL_READYZ_METHOD,
  LOCAL_READYZ_STATUS,
  LOCAL_READYZ_BODY,
  EXEC_METHOD,
  EXEC_PROBE_SEMANTICS,
  DUMMY_DSN_CLASS,
  DUMMY_DSN_VALUE_RECORDED,
  DUMMY_DSN_NOTE,
  OBSERVED_AT_UNAVAILABLE,
  SOURCE_TYPE_A,
  SOURCE_REF_A,
  OBSERVED_AT_SEMANTICS_A,
  SOURCE_TYPE_B,
  SOURCE_REF_B,
  OBSERVED_AT_SEMANTICS_B,
  INDEPENDENT_VERIFY_UTC,
  WH_FAIL_CREATED_UTC,
  WH_FAIL_LAST_ACTIVE_UTC,
  WH_RESTORE_CREATED_UTC,
  SUNSET_FAIL_CREATED_UTC,
  SUNSET_FAIL_LAST_ACTIVE_UTC,
  SUNSET_RESTORE_CREATED_UTC,
  ACTIVE_REVISIONS_MODE_FINAL,
  TRAFFIC_ISOLATION_SEMANTICS,
  PROVENANCE_LIMITATIONS,
  NON_RECOVERABILITY,
  CLAIM_OWNERSHIP,
  PROBE_SUMMARY,
  EXPLICITLY_NOT_CLAIMED,
  CLAIMS_ALLOWED,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  mergeLiveProbeWithoutRewritingHistorical,
  historicalSamplesRewrittenByLiveProbe,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
