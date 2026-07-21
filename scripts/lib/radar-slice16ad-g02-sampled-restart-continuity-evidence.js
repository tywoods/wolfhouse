'use strict';

/**
 * radar-slice16ad-g02-sampled-restart-continuity-evidence — RADAR Slice 16AD locks.
 *
 * Evidence-only reconciliation of completed dual-staging concurrent sampled
 * revision-restart continuity drill @ master 137b14a0. No live mutation.
 * Provenance split:
 *   (A) operator-observed poll sample arrays + restart command windows
 *   (B) independently recoverable Azure/LAW/public read-only facts
 *
 * Claim (bounded): no observed public interruption at this sampling resolution
 * during declared restart command windows after WH warmup exclusion.
 * Does not claim absolute/continuous zero downtime, between-sample proof,
 * cold-start availability, sub-second interruption absence, production, or full G02.
 */

const path = require('path');

const MASTER_BASIS = '137b14a0b3efc689ba749340a97ab4e9bc220edc';
const SLICE = 'RADAR-16AD';
const OUTCOME_ID = '16AD_g02_sampled_restart_continuity_evidence';
const GATE_ID = 'G02_readiness_dependencies';
const PROGRESS_CLASS = 'partial_live_proven_evidence_only';
const BRANCH = 'radar/slice-16ad-g02-sampled-restart-continuity-evidence';

const EVIDENCE_REL = 'fixtures/radar-operations/slice16ad-g02-sampled-restart-continuity-evidence.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16ad-expected-contract.json';

const IMAGE_SHA_FULL = '95dc3634ac6aaa6de495d22f5f5d8cd0a955df97';
const IMAGE_SHA_SHORT = '95dc363';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

const WH_APP = 'wh-staging-staff-api';
const WH_RG = 'wh-staging-rg';
const WH_IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_SHA_FULL}`;
const WH_DIGEST = 'sha256:a9677f75a7d17be9b6ae75b60bc026d462df971cc164496344c29b8c57aee6de';
const WH_REVISION = 'wh-staging-staff-api--g02503r';
const WH_PUBLIC_HOST = 'staff-staging.lunafrontdesk.com';
const WH_LAW_REPLICA = 'wh-staging-staff-api--g02503r-9764596b8-mgfw2';
const WH_CURRENT_REPLICA = 'wh-staging-staff-api--g02503r-5d7c8bff59-llr4s';

const SUNSET_APP = 'luna-sunset-staging-staff-api';
const SUNSET_RG = 'luna-sunset-staging-rg';
const SUNSET_IMAGE = `whstagingacr.azurecr.io/luna-sunset-staff-api:${IMAGE_SHA_FULL}`;
const SUNSET_DIGEST = 'sha256:8a0b1647ba246bb548d437fcc37e3e4f600181ca1d04dc1eb73e3f4a69d51c10';
const SUNSET_REVISION = 'luna-sunset-staging-staff-api--g02503r';
const SUNSET_PUBLIC_HOST = 'sunset-staging.lunafrontdesk.com';
const SUNSET_LAW_REPLICA = 'luna-sunset-staging-staff-api--g02503r-f4d4b7875-dw7cx';
const SUNSET_CURRENT_REPLICA = 'luna-sunset-staging-staff-api--g02503r-d5769cd4b-b7b59';

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

const WH_LAW_TIME = '2026-07-21T13:22:29.3669823Z';
const SUNSET_LAW_TIME = '2026-07-21T13:24:29.7970752Z';

const SOURCE_TYPE_A = 'operator_drill_transcript_contemporaneous_observation';
const SOURCE_REF_A = 'operator_g02_sampled_revision_restart_continuity_command_transcript_2026-07-21';
const OBSERVED_AT_SEMANTICS_A =
  'contemporaneous_operator_poll_samples_and_restart_windows_not_azure_reconstructible';

const SOURCE_TYPE_B = 'azure_law_public_readonly_independently_reverified';
const INDEPENDENT_VERIFY_UTC = '2026-07-21T13:29:32Z';
const SOURCE_REF_B = `az_containerapp_law_public_curl_readonly_${INDEPENDENT_VERIFY_UTC}`;
const OBSERVED_AT_SEMANTICS_B = 'independently_reverified_at_recorded_utc';

const POLLER = Object.freeze({
  method: 'bounded_sequential_public_healthz_readyz_poller',
  max_time_seconds: 4,
  approximate_cadence_seconds: 1,
  note: 'Sequential public /healthz then /readyz with curl max-time 4s about every 1s while az containerapp revision restart executed',
});

const SAMPLE_COUNT = 91; // indices 0..90
const WH_WARMUP_EXCLUDED_INDICES = Object.freeze([0, 1, 2]);
const WH_CLAIM_INDICES_START = 3;
const WH_CLAIM_INDICES_END = 90;
const WH_CLAIM_SAMPLE_COUNT = WH_CLAIM_INDICES_END - WH_CLAIM_INDICES_START + 1; // 88

const WH_POLL_WINDOW = Object.freeze({
  start_utc: '2026-07-21T13:21:11Z',
  end_utc: '2026-07-21T13:23:17Z',
  sample_index_first: 0,
  sample_index_last: 90,
  sample_count: SAMPLE_COUNT,
});

const WH_RESTART = Object.freeze({
  started_utc: '2026-07-21T13:21:47Z',
  ended_utc: '2026-07-21T13:21:50Z',
  command: 'az containerapp revision restart',
  revision: WH_REVISION,
});

const WH_RESTART_WINDOW_SAMPLES = Object.freeze([
  Object.freeze({ sample_index: 8, absolute_observed_at_utc: '2026-07-21T13:21:47Z' }),
  Object.freeze({ sample_index: 9, absolute_observed_at_utc: '2026-07-21T13:21:48Z' }),
  Object.freeze({ sample_index: 10, absolute_observed_at_utc: '2026-07-21T13:21:49Z' }),
  Object.freeze({ sample_index: 11, absolute_observed_at_utc: '2026-07-21T13:21:50Z' }),
]);

const SUNSET_POLL_WINDOW = Object.freeze({
  start_utc: '2026-07-21T13:23:39Z',
  end_utc: '2026-07-21T13:25:18Z',
  sample_index_first: 0,
  sample_index_last: 90,
  sample_count: SAMPLE_COUNT,
});

const SUNSET_RESTART = Object.freeze({
  started_utc: '2026-07-21T13:23:54Z',
  ended_utc: '2026-07-21T13:23:58Z',
  command: 'az containerapp revision restart',
  revision: SUNSET_REVISION,
});

const SUNSET_RESTART_WINDOW_SAMPLES = Object.freeze([
  Object.freeze({ sample_index: 14, absolute_observed_at_utc: '2026-07-21T13:23:54Z' }),
  Object.freeze({ sample_index: 15, absolute_observed_at_utc: '2026-07-21T13:23:56Z' }),
  Object.freeze({ sample_index: 16, absolute_observed_at_utc: '2026-07-21T13:23:57Z' }),
  Object.freeze({ sample_index: 17, absolute_observed_at_utc: '2026-07-21T13:23:58Z' }),
]);

const SAMPLE_CLASS_WARMUP =
  'wh_scale_from_zero_warmup_timeout_disclosed_excluded_from_restart_window_claim';
const SAMPLE_CLASS_CLAIM =
  'concurrent_sampled_restart_continuity_claim_eligible_after_warmup';
const SAMPLE_CLASS_RESTART_WINDOW =
  'concurrent_sampled_during_declared_restart_command_window';

const CLAIM_SEMANTICS =
  'no_observed_public_interruption_at_this_sampling_resolution_during_declared_restart_command_windows_after_wh_warmup_exclusion';

const PROVENANCE_LIMITATIONS =
  'Class A sample arrays and restart command windows are operator-observed contemporaneous transcript facts '
  + '(bounded sequential public /healthz+/readyz poller max-time 4s ~1s cadence during az containerapp revision restart). '
  + 'WH samples 0..2 timed out during initial scale-from-zero warmup before restart and are disclosed/excluded from the '
  + 'restart-window continuity claim; samples 3..90 all health=200 ready=200. Sunset samples 0..90 all both 200. '
  + 'Class B LAW SIGTERM completion rows, revision Single/latest/latestReady/100%, digests, and public-current probes '
  + 'are independently reverified Azure/LAW/public read-only facts at independent_azure_verify_utc. '
  + 'Do not treat A as Azure-reconstructible, fabricate Azure-derived historical poll samples, hide WH warmup timeouts, '
  + 'claim all 91 WH samples passed, treat warmup timeouts as restart-window failures, or upgrade the bounded sampling '
  + 'claim into absolute/continuous zero downtime or between-sample proof.';

const NON_RECOVERABILITY =
  'Azure/LAW/public read-only APIs cannot recreate or replay the historical public poll sample arrays or operator '
  + 'restart command windows; those values exist only in the operator drill command transcript. Current public probes '
  + 'and LAW queries verify present state / stored completion rows only. LAW rows prove SIGTERM cleanup telemetry for '
  + 'the restarted replicas; they do not reconstruct the concurrent public poll stream.';

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'absolute_zero_downtime',
  'continuous_zero_downtime',
  'between_sample_proof',
  'no_sub_second_interruption',
  'cold_start_availability',
  'all_91_wh_samples_passed',
  'warmup_timeouts_as_restart_window_failures',
  'hidden_wh_warmup_failures',
  'fabricated_azure_derived_historical_poll_samples',
  'production',
  'full_G02_proven',
  'any_gate_verdict_proven',
]);

const CLAIMS_ALLOWED = Object.freeze([
  'wh_warmup_samples_0_2_timeout_disclosed_excluded',
  'wh_samples_3_90_health_200_ready_200',
  'wh_restart_window_13_21_47_13_21_50_samples_8_11_both_200',
  'sunset_samples_0_90_health_200_ready_200',
  'sunset_restart_window_13_23_54_13_23_58_samples_14_17_both_200',
  'law_sigterm_completion_wh_13_22_29_3669823_sunset_13_24_29_7970752',
  'allowlisted_completion_json_sigterm_pool_ok_server_ok_failures_empty_completion_true',
  'current_single_latest_latestReady_100_both_tenants',
  'public_current_healthz_readyz_200_both_tenants',
  'no_observed_public_interruption_at_sampling_resolution_during_declared_restart_windows_after_warmup',
  'concurrent_sampled_restart_continuity_gap_closed_g02_remains_partial',
  'no_production_scope',
  'no_absolute_or_continuous_zero_downtime_claim',
]);

const OWNED_RELS = Object.freeze([
  EVIDENCE_REL,
  CONTRACT_REL,
  'scripts/lib/radar-slice16ad-g02-sampled-restart-continuity-evidence.js',
  'scripts/verify-radar-slice16ad-g02-sampled-restart-continuity-evidence.js',
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

function lerpUtc(startUtc, endUtc, startIdx, endIdx, idx) {
  if (idx === startIdx) return startUtc;
  if (idx === endIdx) return endUtc;
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  const t = (idx - startIdx) / (endIdx - startIdx);
  const ms = startMs + t * (endMs - startMs);
  return new Date(Math.round(ms)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build WH samples 0..90.
 * Exact operator ticks locked for 0,8,9,10,11,90.
 * Warmup 1..2: disclosed timeouts with derived ticks between sample 0 and first claim sample 3
 *   (exact intermediate ticks were not separately stated; derivation is explicit and excluded from claim).
 * Claim samples outside exact anchors: linear interpolation between nearest exact anchors.
 */
function buildWhSamples() {
  const exact = {
    0: WH_POLL_WINDOW.start_utc,
    8: '2026-07-21T13:21:47Z',
    9: '2026-07-21T13:21:48Z',
    10: '2026-07-21T13:21:49Z',
    11: '2026-07-21T13:21:50Z',
    90: WH_POLL_WINDOW.end_utc,
  };
  // First claim sample (3) derived ~1s cadence backward from restart sample 8.
  const sample3 = addSecondsToUtc(exact[8], -5);
  exact[3] = sample3;

  const samples = [];
  for (let i = 0; i <= 90; i += 1) {
    let absolute;
    let tickSemantics;
    if (exact[i]) {
      absolute = exact[i];
      tickSemantics = (i === 1 || i === 2)
        ? 'derived_warmup_spacing'
        : 'operator_exact_or_window_endpoint_or_1s_back_from_restart_anchor';
      if (i === 0 || i === 8 || i === 9 || i === 10 || i === 11 || i === 90) {
        tickSemantics = 'operator_exact_locked';
      } else if (i === 3) {
        tickSemantics = 'derived_1s_back_from_restart_sample_8';
      }
    } else if (i === 1 || i === 2) {
      // Space warmup 1..2 evenly between sample 0 and derived sample 3.
      absolute = lerpUtc(exact[0], sample3, 0, 3, i);
      tickSemantics = 'derived_warmup_spacing_between_sample0_and_sample3_exact_tick_not_separately_stated';
    } else if (i > 3 && i < 8) {
      absolute = lerpUtc(sample3, exact[8], 3, 8, i);
      tickSemantics = 'derived_lerp_between_sample3_and_restart_sample8';
    } else if (i > 11 && i < 90) {
      absolute = lerpUtc(exact[11], exact[90], 11, 90, i);
      tickSemantics = 'derived_lerp_between_restart_sample11_and_window_end';
    } else {
      throw new Error(`unhandled WH sample index ${i}`);
    }

    const isWarmup = WH_WARMUP_EXCLUDED_INDICES.includes(i);
    const inRestart = WH_RESTART_WINDOW_SAMPLES.some((s) => s.sample_index === i);
    const sample = {
      sample_index: i,
      absolute_observed_at_utc: absolute,
      tick_semantics: tickSemantics,
      source_type: SOURCE_TYPE_A,
      source_ref: SOURCE_REF_A,
      observed_at_semantics: OBSERVED_AT_SEMANTICS_A,
      excluded_from_restart_window_claim: isWarmup,
    };
    if (isWarmup) {
      sample.public_healthz = 'timeout';
      sample.public_readyz = 'timeout';
      sample.outcome = 'timeout';
      sample.sample_class = SAMPLE_CLASS_WARMUP;
      sample.note = 'Scale-from-zero warmup timeout before restart; disclosed and excluded from restart-window continuity claim; WH cold-start remains real';
    } else {
      sample.public_healthz = 200;
      sample.public_readyz = 200;
      sample.outcome = 'both_200';
      sample.sample_class = inRestart ? SAMPLE_CLASS_RESTART_WINDOW : SAMPLE_CLASS_CLAIM;
    }
    samples.push(sample);
  }
  return samples;
}

function buildSunsetSamples() {
  const exact = {
    0: SUNSET_POLL_WINDOW.start_utc,
    14: '2026-07-21T13:23:54Z',
    15: '2026-07-21T13:23:56Z',
    16: '2026-07-21T13:23:57Z',
    17: '2026-07-21T13:23:58Z',
    90: SUNSET_POLL_WINDOW.end_utc,
  };
  const samples = [];
  for (let i = 0; i <= 90; i += 1) {
    let absolute;
    let tickSemantics;
    if (exact[i]) {
      absolute = exact[i];
      tickSemantics = 'operator_exact_locked';
    } else if (i < 14) {
      absolute = lerpUtc(exact[0], exact[14], 0, 14, i);
      tickSemantics = 'derived_lerp_between_window_start_and_restart_sample14';
    } else if (i > 17 && i < 90) {
      absolute = lerpUtc(exact[17], exact[90], 17, 90, i);
      tickSemantics = 'derived_lerp_between_restart_sample17_and_window_end';
    } else {
      throw new Error(`unhandled Sunset sample index ${i}`);
    }
    const inRestart = SUNSET_RESTART_WINDOW_SAMPLES.some((s) => s.sample_index === i);
    samples.push({
      sample_index: i,
      absolute_observed_at_utc: absolute,
      tick_semantics: tickSemantics,
      public_healthz: 200,
      public_readyz: 200,
      outcome: 'both_200',
      excluded_from_restart_window_claim: false,
      source_type: SOURCE_TYPE_A,
      source_ref: SOURCE_REF_A,
      observed_at_semantics: OBSERVED_AT_SEMANTICS_A,
      sample_class: inRestart ? SAMPLE_CLASS_RESTART_WINDOW : SAMPLE_CLASS_CLAIM,
    });
  }
  return samples;
}

const WH_SAMPLES = Object.freeze(buildWhSamples().map((s) => Object.freeze(s)));
const SUNSET_SAMPLES = Object.freeze(buildSunsetSamples().map((s) => Object.freeze(s)));

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
  SUBSCRIPTION_ID,
  WH_APP,
  WH_RG,
  WH_IMAGE,
  WH_DIGEST,
  WH_REVISION,
  WH_PUBLIC_HOST,
  WH_LAW_REPLICA,
  WH_CURRENT_REPLICA,
  SUNSET_APP,
  SUNSET_RG,
  SUNSET_IMAGE,
  SUNSET_DIGEST,
  SUNSET_REVISION,
  SUNSET_PUBLIC_HOST,
  SUNSET_LAW_REPLICA,
  SUNSET_CURRENT_REPLICA,
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
  POLLER,
  SAMPLE_COUNT,
  WH_WARMUP_EXCLUDED_INDICES,
  WH_CLAIM_INDICES_START,
  WH_CLAIM_INDICES_END,
  WH_CLAIM_SAMPLE_COUNT,
  WH_POLL_WINDOW,
  WH_RESTART,
  WH_RESTART_WINDOW_SAMPLES,
  SUNSET_POLL_WINDOW,
  SUNSET_RESTART,
  SUNSET_RESTART_WINDOW_SAMPLES,
  SAMPLE_CLASS_WARMUP,
  SAMPLE_CLASS_CLAIM,
  SAMPLE_CLASS_RESTART_WINDOW,
  CLAIM_SEMANTICS,
  PROVENANCE_LIMITATIONS,
  NON_RECOVERABILITY,
  EXPLICITLY_NOT_CLAIMED,
  CLAIMS_ALLOWED,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  WH_SAMPLES,
  SUNSET_SAMPLES,
  buildWhSamples,
  buildSunsetSamples,
  addSecondsToUtc,
  lerpUtc,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
