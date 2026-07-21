'use strict';

/**
 * radar-slice16z-g02-live-sigterm-evidence — RADAR Slice 16Z locks.
 *
 * Evidence-only reconciliation of completed dual-staging live SIGTERM lifecycle
 * drill @ master 95dc3634. No live mutation. Provenance split:
 *   (A) operator-observed drill transcript contemporaneous facts
 *   (B) independently recoverable Azure/ACR/LAW read-only facts
 *
 * LAW cardinality is locked to exactly one allowlisted SIGTERM completion in each
 * declared bounded non-overlapping drill query window — not revision-lifetime
 * exactly-one (WH target revision has later lifecycle completions).
 *
 * Proves: live SIGTERM cleanup telemetry in drill windows + post-restart recovery.
 * Does not prove: SIGINT live, serving /readyz=503, zero-downtime during restart,
 * concurrent restart continuity, organic alerts, production, full G02,
 * unqualified revision-lifetime exactly-one LAW cardinality.
 */

const path = require('path');

const MASTER_BASIS = '95dc3634ac6aaa6de495d22f5f5d8cd0a955df97';
const SLICE = 'RADAR-16Z';
const OUTCOME_ID = '16Z_g02_live_sigterm_lifecycle_evidence';
const GATE_ID = 'G02_readiness_dependencies';
const PROGRESS_CLASS = 'partial_live_proven_evidence_only';
const BRANCH = 'radar/slice-16z-g02-live-sigterm-evidence';

const EVIDENCE_REL = 'fixtures/radar-operations/slice16z-g02-live-sigterm-evidence.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16z-expected-contract.json';

const IMAGE_SHA_FULL = MASTER_BASIS;
const IMAGE_SHA_SHORT = '95dc363';

const WH_APP = 'wh-staging-staff-api';
const WH_RG = 'wh-staging-rg';
const WH_IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_SHA_FULL}`;
const WH_DIGEST = 'sha256:a9677f75a7d17be9b6ae75b60bc026d462df971cc164496344c29b8c57aee6de';
const WH_REVISION = 'wh-staging-staff-api--0000519';
const WH_REVISION_SUFFIX = '0000519';
const WH_PUBLIC_HOST = 'staff-staging.lunafrontdesk.com';

const SUNSET_APP = 'luna-sunset-staging-staff-api';
const SUNSET_RG = 'luna-sunset-staging-rg';
const SUNSET_IMAGE = `whstagingacr.azurecr.io/luna-sunset-staff-api:${IMAGE_SHA_FULL}`;
const SUNSET_DIGEST = 'sha256:8a0b1647ba246bb548d437fcc37e3e4f600181ca1d04dc1eb73e3f4a69d51c10';
const SUNSET_REVISION = 'luna-sunset-staging-staff-api--0000279';
const SUNSET_REVISION_SUFFIX = '0000279';
const SUNSET_PUBLIC_HOST = 'sunset-staging.lunafrontdesk.com';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

const LOG_TABLE = 'ContainerAppConsoleLogs_CL';
const EVENT_NAME = 'staff_api_readiness_shutdown_completion';

const WH_LAW = Object.freeze({
  customer_id: '43ae26dd-4a82-4a91-b744-5e1f94a2ae8f',
  workspace_name: 'wh-staging-logs',
  retention_days: 30,
});

const SUNSET_LAW = Object.freeze({
  customer_id: '552489bf-8e57-48df-8413-6e775caaa7d0',
  workspace_name: 'luna-sunset-staging-logs',
  retention_days: 30,
});

const COMPLETION_RECORD = Object.freeze({
  event: EVENT_NAME,
  original_signal: 'SIGTERM',
  pool_close_result: 'ok',
  server_close_result: 'ok',
  failure_classes: Object.freeze([]),
  completion: true,
});

const ALLOWED_RECORD_KEYS = Object.freeze([
  'event',
  'original_signal',
  'pool_close_result',
  'server_close_result',
  'failure_classes',
  'completion',
]);

const WH_LAW_TIME = '2026-07-21T11:16:20.3631884Z';
const SUNSET_LAW_TIME = '2026-07-21T11:18:04.1610218Z';

/** (A) transcript-derived contemporaneous observation. */
const SOURCE_TYPE_A = 'operator_drill_transcript_contemporaneous_observation';
const SOURCE_REF_A = 'operator_g02_live_sigterm_lifecycle_command_transcript_2026-07-21';
const OBSERVED_AT_SEMANTICS_A =
  'contemporaneous_operator_restart_and_post_restart_samples_not_azure_reconstructible';

/** (B) independently recoverable Azure/ACR/LAW read-only / public current. */
const SOURCE_TYPE_B = 'azure_acr_law_readonly_independently_reverified';
const SOURCE_REF_B =
  'az_containerapp_acr_law_query_public_curl_readonly_2026-07-21T11:42:38Z';
const OBSERVED_AT_SEMANTICS_B = 'independently_reverified_at_recorded_utc';

const INDEPENDENT_VERIFY_UTC = '2026-07-21T11:42:38Z';

/** LAW cardinality reverify (bounded drill windows + later-record disclosure). */
const LAW_CARDINALITY_REVERIFY_UTC = '2026-07-21T11:59:43Z';
const SOURCE_REF_LAW_CARDINALITY =
  'az_monitor_log_analytics_query_readonly_bounded_drill_windows_2026-07-21T11:59:43Z';

const CARDINALITY_SEMANTICS =
  'exactly_one_in_declared_bounded_drill_query_window_not_revision_lifetime';

const WH_LAW_QUERY_WINDOW = Object.freeze({
  start_utc: '2026-07-21T11:15:18Z',
  end_utc: '2026-07-21T11:17:18Z',
  start_inclusive: true,
  end_inclusive: true,
  semantics: 'bounded_non_overlapping_drill_query_window',
  derivation:
    'WH drill LAW query window = operator restart start 2026-07-21T11:15:18Z through '
    + '2026-07-21T11:17:18Z (inclusive); locked non-overlapping with Sunset window; '
    + 'cardinality claim is exactly one target-revision allowlisted completion in this window only',
});

const SUNSET_LAW_QUERY_WINDOW = Object.freeze({
  start_utc: '2026-07-21T11:17:30Z',
  end_utc: '2026-07-21T11:19:30Z',
  start_inclusive: true,
  end_inclusive: true,
  semantics: 'bounded_non_overlapping_drill_query_window',
  derivation:
    'Sunset drill LAW query window = operator restart start 2026-07-21T11:17:30Z through '
    + '2026-07-21T11:19:30Z (inclusive); locked non-overlapping with WH window; '
    + 'cardinality claim is exactly one target-revision allowlisted completion in this window only',
});

const WH_LATER_LAW_RECORDS_AT_REVIEW = Object.freeze([
  Object.freeze({
    TimeGenerated: '2026-07-21T11:24:48.5525367Z',
    class: 'later_lifecycle_event_not_16z_drill_completion',
    revision: WH_REVISION,
    record: Object.freeze({ ...COMPLETION_RECORD, failure_classes: Object.freeze([]) }),
  }),
  Object.freeze({
    TimeGenerated: '2026-07-21T11:47:54.2072273Z',
    class: 'later_lifecycle_event_not_16z_drill_completion',
    revision: WH_REVISION,
    record: Object.freeze({ ...COMPLETION_RECORD, failure_classes: Object.freeze([]) }),
  }),
]);

const PROVENANCE_LIMITATIONS =
  'Class A operator restart windows and post-restart healthz/readyz sample arrays are operator-observed contemporaneous transcript facts. '
  + 'Class B digests/revisions/probes/public-current are independently reverified Azure/ACR/public read-only facts at independent_azure_verify_utc; '
  + 'LAW drill-window cardinality + later-record disclosure are independently reverified at law_cardinality_reverify_utc via bounded non-overlapping query windows. '
  + 'Unqualified revision-lifetime exactly-one is false (WH has later SIGTERM completions; count may grow via scaling/restarts). '
  + 'Do not treat A as Azure-reconstructible, and do not treat current public probes as authority to rewrite A historical samples or claim concurrent restart continuity.';

const NON_RECOVERABILITY =
  'Azure/ACR/LAW read-only APIs cannot recreate or replay the historical post-restart healthz/readyz sample arrays or operator restart command windows; '
  + 'those values exist only in the operator drill command transcript. Current public probes and LAW queries verify present state / stored completion rows only. '
  + 'LAW cardinality claims require declared bounded query windows; revision-lifetime counts are not frozen at one.';

const OBS_CADENCE_S = 2;
const OBS_SAMPLE_COUNT = 31;
/** Uniform 2s tick span for 31 samples (offsets 0..60). */
const OBS_SAMPLE_SPAN_S = (OBS_SAMPLE_COUNT - 1) * OBS_CADENCE_S; // 60
/** Operator-stated sampling period length (start→end inclusive wall clock). */
const OBS_WINDOW_DURATION_S = 63;

const WH_RESTART = Object.freeze({
  started_utc: '2026-07-21T11:15:18Z',
  ended_utc: '2026-07-21T11:15:21Z',
});

const SUNSET_RESTART = Object.freeze({
  started_utc: '2026-07-21T11:17:30Z',
  ended_utc: '2026-07-21T11:17:33Z',
});

const WH_SAMPLE_WINDOW = Object.freeze({
  start_utc: '2026-07-21T11:15:22Z',
  end_utc: '2026-07-21T11:16:25Z',
  duration_seconds: OBS_WINDOW_DURATION_S,
  cadence_seconds: OBS_CADENCE_S,
  sample_count: OBS_SAMPLE_COUNT,
  sample_span_seconds: OBS_SAMPLE_SPAN_S,
  last_sample_utc: '2026-07-21T11:16:22Z',
  semantics: 'post_restart_recovery_samples_not_concurrent_restart_continuity',
  derivation:
    'start_utc/end_utc = operator-stated post-restart sampling period after WH restart ended 11:15:21Z; '
    + '31 samples at ~2s cadence (offsets 0..60 → last_sample 11:16:22Z); window end 11:16:25Z is period close — transcript-derived only, not Azure-reconstructible',
});

const SUNSET_SAMPLE_WINDOW = Object.freeze({
  start_utc: '2026-07-21T11:17:35Z',
  end_utc: '2026-07-21T11:18:38Z',
  duration_seconds: OBS_WINDOW_DURATION_S,
  cadence_seconds: OBS_CADENCE_S,
  sample_count: OBS_SAMPLE_COUNT,
  sample_span_seconds: OBS_SAMPLE_SPAN_S,
  last_sample_utc: '2026-07-21T11:18:35Z',
  semantics: 'post_restart_recovery_samples_not_concurrent_restart_continuity',
  derivation:
    'start_utc/end_utc = operator-stated post-restart sampling period after Sunset restart ended 11:17:33Z; '
    + '31 samples at ~2s cadence (offsets 0..60 → last_sample 11:18:35Z); window end 11:18:38Z is period close — transcript-derived only, not Azure-reconstructible',
});

const WH_TIMELINE_B = Object.freeze({
  acr_tag_created_utc: '2026-07-21T11:11:54.3612271Z',
  revision_created_utc: '2026-07-21T11:12:46+00:00',
});

const SUNSET_TIMELINE_B = Object.freeze({
  acr_tag_created_utc: '2026-07-21T11:12:04.3397072Z',
  revision_created_utc: '2026-07-21T11:13:51+00:00',
});

const PROBE_SUMMARY = Object.freeze([
  { type: 'Liveness', path: '/healthz', port: 3036 },
  { type: 'Readiness', path: '/readyz', port: 3036 },
  { type: 'Startup', path: '/healthz', port: 3036 },
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'sigint_live_lifecycle',
  'serving_revision_readyz_503_body_path',
  'zero_downtime_during_restart',
  'concurrent_restart_continuity',
  'organic_metric_alert_firing',
  'human_inbox_receipt',
  'production',
  'full_G02_proven',
  'any_gate_verdict_proven',
  'revision_lifetime_exactly_one_sigterm_completion',
  'unbounded_law_cardinality_exactly_one',
]);

const CLAIMS_ALLOWED = Object.freeze([
  'exact_sha_95dc363_images_digests_both_tenants',
  'revisions_wh_0000519_sunset_0000279_healthy_serving',
  'operator_restart_wh_111518_111521_sunset_111730_111733',
  'law_exactly_one_sigterm_completion_each_tenant_in_declared_drill_query_window',
  'allowlisted_completion_json_sigterm_pool_ok_server_ok_failures_empty_completion_true',
  'post_restart_31_healthz_readyz_200_pairs_approx_2s_both_tenants',
  'public_current_healthz_readyz_200_both_tenants',
  'no_production_scope',
  'wh_later_sigterm_records_disclosed_not_drill_completions',
]);

const OWNED_RELS = Object.freeze([
  EVIDENCE_REL,
  CONTRACT_REL,
  'scripts/lib/radar-slice16z-g02-live-sigterm-evidence.js',
  'scripts/verify-radar-slice16z-g02-live-sigterm-evidence.js',
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

function addSecondsToUtc(utc, seconds) {
  const ms = Date.parse(utc);
  if (!Number.isFinite(ms)) throw new Error(`bad utc: ${utc}`);
  return new Date(ms + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildPostRestartSamples(windowStartUtc) {
  const samples = [];
  for (let i = 0; i < OBS_SAMPLE_COUNT; i += 1) {
    const tOffset = i * OBS_CADENCE_S;
    samples.push({
      t_offset_s: tOffset,
      absolute_observed_at_utc: addSecondsToUtc(windowStartUtc, tOffset),
      public_healthz: 200,
      public_readyz: 200,
      source_type: SOURCE_TYPE_A,
      source_ref: SOURCE_REF_A,
      observed_at_semantics: OBSERVED_AT_SEMANTICS_A,
      sample_class: 'post_restart_recovery_not_concurrent_restart_continuity',
    });
  }
  return samples;
}

const WH_OBSERVATION_SAMPLES = Object.freeze(
  buildPostRestartSamples(WH_SAMPLE_WINDOW.start_utc),
);
const SUNSET_OBSERVATION_SAMPLES = Object.freeze(
  buildPostRestartSamples(SUNSET_SAMPLE_WINDOW.start_utc),
);

function mergeLiveProbeWithoutRewritingHistorical(evidence, liveProbeResult) {
  const out = JSON.parse(JSON.stringify(evidence));
  const b = out.observed_facts
    && out.observed_facts.B_independently_recoverable_azure_readonly;
  if (b && liveProbeResult && typeof liveProbeResult === 'object') {
    b.live_probe_attempt = {
      attempted_at_utc: liveProbeResult.attempted_at_utc || null,
      result: liveProbeResult.result || 'unknown',
      note: 'Live probe result must not rewrite class-A historical samples',
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
  WH_REVISION,
  WH_REVISION_SUFFIX,
  WH_PUBLIC_HOST,
  SUNSET_APP,
  SUNSET_RG,
  SUNSET_IMAGE,
  SUNSET_DIGEST,
  SUNSET_REVISION,
  SUNSET_REVISION_SUFFIX,
  SUNSET_PUBLIC_HOST,
  SUBSCRIPTION_ID,
  LOG_TABLE,
  EVENT_NAME,
  WH_LAW,
  SUNSET_LAW,
  COMPLETION_RECORD,
  ALLOWED_RECORD_KEYS,
  WH_LAW_TIME,
  SUNSET_LAW_TIME,
  SOURCE_TYPE_A,
  SOURCE_REF_A,
  OBSERVED_AT_SEMANTICS_A,
  SOURCE_TYPE_B,
  SOURCE_REF_B,
  OBSERVED_AT_SEMANTICS_B,
  INDEPENDENT_VERIFY_UTC,
  LAW_CARDINALITY_REVERIFY_UTC,
  SOURCE_REF_LAW_CARDINALITY,
  CARDINALITY_SEMANTICS,
  WH_LAW_QUERY_WINDOW,
  SUNSET_LAW_QUERY_WINDOW,
  WH_LATER_LAW_RECORDS_AT_REVIEW,
  PROVENANCE_LIMITATIONS,
  NON_RECOVERABILITY,
  OBS_CADENCE_S,
  OBS_SAMPLE_COUNT,
  OBS_SAMPLE_SPAN_S,
  OBS_WINDOW_DURATION_S,
  /** @deprecated alias — prefer OBS_SAMPLE_SPAN_S / OBS_WINDOW_DURATION_S */
  OBS_DURATION_S: OBS_SAMPLE_SPAN_S,
  WH_RESTART,
  SUNSET_RESTART,
  WH_SAMPLE_WINDOW,
  SUNSET_SAMPLE_WINDOW,
  WH_TIMELINE_B,
  SUNSET_TIMELINE_B,
  PROBE_SUMMARY,
  EXPLICITLY_NOT_CLAIMED,
  CLAIMS_ALLOWED,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  WH_OBSERVATION_SAMPLES,
  SUNSET_OBSERVATION_SAMPLES,
  buildPostRestartSamples,
  addSecondsToUtc,
  mergeLiveProbeWithoutRewritingHistorical,
  historicalSamplesRewrittenByLiveProbe,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
