'use strict';

/**
 * radar-slice16ai-g06-live-load-evidence — RADAR Slice 16AI locks.
 *
 * Evidence-only reconciliation of the successful controlled dual-staging
 * /readyz bounded-load drill @ master d04b6333 (profile
 * 16AG_DRILL_dual_staging_readyz_bounded_load). Records final_controlled_drill
 * live_proven for this conservative readiness profile only. Does not claim
 * soak, alert firing/notification, autoscaling, SLO/error budget,
 * backpressure, production, or full G06. G06 remains partial; score unchanged.
 * No deploy / scale mutation by this tip.
 */

const path = require('path');
const harness = require('./radar-g06-bounded-load-harness');

const MASTER_BASIS = 'd04b633390bdcacfe3a04eed4796bba4184e29f8';
const SLICE = 'RADAR-16AI';
const OUTCOME_ID = '16AI_g06_live_load_evidence';
const GATE_ID = 'G06_scaling_capacity';
const GATE_IDS = Object.freeze([GATE_ID]);
const PROGRESS_CLASS = 'partial_live_proven_evidence_only';
const BRANCH = 'radar/slice-16ai-g06-live-load-evidence';

const EVIDENCE_REL = 'fixtures/radar-operations/slice16ai-g06-live-load-evidence.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16ai-expected-contract.json';

const WH_READYZ_URL = harness.WH_READYZ_URL;
const SUNSET_READYZ_URL = harness.SUNSET_READYZ_URL;
const ALLOWED_TARGETS = harness.ALLOWED_TARGETS;
const PROFILE_ID = '16AG_DRILL_dual_staging_readyz_bounded_load';

const DRILL_EXECUTED_AT = '2026-07-21T16:50:16.377Z';
const INDEPENDENT_VERIFY_UTC = '2026-07-21T16:50:16Z';

const WH_LATENCY = Object.freeze({
  count: 60,
  p50_ms: 30,
  p95_ms: 32,
  p99_ms: 44,
  max_ms: 44,
});
const WH_WALL_MS = 954;
const SUNSET_LATENCY = Object.freeze({
  count: 60,
  p50_ms: 28,
  p95_ms: 29,
  p99_ms: 40,
  max_ms: 40,
});
const SUNSET_WALL_MS = 879;

const STATUS_COUNTS_ZERO_NON2XX = Object.freeze({
  '2xx': 60,
  '3xx': 0,
  '4xx': 0,
  '5xx': 0,
  timeout: 0,
  error: 0,
  other: 0,
});

const PROFILE_LOCK = Object.freeze({
  concurrency: 2,
  max_duration_ms: 30000,
  max_requests: 60,
  request_timeout_ms: 4000,
  method: 'GET',
  headers: null,
  body: null,
  auth: null,
  follow_redirects: false,
  max_redirects: 0,
  tls_required: true,
  collect_response_bodies: false,
});

const COST_AMOUNT = 18.2443795483871;
const COST_CURRENCY = 'USD';
const COST_SCOPE =
  '/subscriptions/6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9/resourceGroups/luna-sunset-staging-rg';
const COST_BEFORE_AT = '2026-07-21T16:50:14.044Z';
const COST_AFTER_AT = '2026-07-21T16:51:05.849Z';
const COST_PERIOD = Object.freeze({
  from: '2026-07-01',
  to: '2026-07-21',
  label: 'month-to-date',
});

const SOURCE_TYPE = 'operator_controlled_16AG_profile_live_drill_plus_sunset_mtd_actualcost_guard';
const SOURCE_REF = `16AG_DRILL_dual_staging_readyz_bounded_load_${INDEPENDENT_VERIFY_UTC}`;
const OBSERVED_AT_SEMANTICS = 'drill_executed_at_truncated_to_second_utc';

const FINAL_CONTROLLED_DRILL_STATUS = 'live_proven';

const PROVENANCE_LIMITATIONS =
  'Records the operator-controlled successful dual-staging /readyz bounded-load '
  + `drill output @ ${INDEPENDENT_VERIFY_UTC} for profile ${PROFILE_ID} against the `
  + 'exact two staging allowlist targets (each 60/60 2xx; concurrency peak 2; zero '
  + 'timeout/error/non-2xx; WH p50/p95/p99/max 30/32/44/44ms wall 954; Sunset '
  + '28/29/40/40ms wall 879; response bodies/redirects/headers/auth/body false; DNS '
  + 'pinned; active remaining 0; pre/post /readyz ready). Records Sunset RG MTD '
  + `ActualCost before/after identical ${COST_AMOUNT} ${COST_CURRENCY}, disclosing `
  + 'initial after-query HTTP 429 then successful retry. Proves only this '
  + 'conservative readiness profile. Does not prove soak, alert firing/notification, '
  + 'autoscaling, SLO/error budget, backpressure, production, or full G06.';

const NON_RECOVERABILITY =
  'A single conservative bounded /readyz drill cannot prove soak/sustained capacity, '
  + 'alert firing, notification delivery, autoscaling actuation, SLO/error-budget '
  + 'consumption, or backpressure. Do not invent soak success, fire instances, scale '
  + 'mutations, or raising G06 to proven.';

const CLAIM_OWNERSHIP = Object.freeze({
  conservative_dual_staging_readyz_bounded_load: Object.freeze({
    owner_class: 'operator_controlled_drill_output_locked',
    observation:
      'both_staging_readyz_60_of_60_2xx_peak_concurrency_2_zero_timeout_error_non2xx',
    proves: [
      'exact_two_staging_readyz_targets',
      'profile_16AG_DRILL_dual_staging_readyz_bounded_load_executed',
      'each_target_60_of_60_2xx',
      'peak_in_flight_2',
      'zero_timeout_error_non2xx',
      'wh_latency_p50_30_p95_32_p99_44_max_44_wall_954',
      'sunset_latency_p50_28_p95_29_p99_40_max_40_wall_879',
      'pre_post_readyz_ready',
      'response_bodies_redirects_headers_auth_body_false',
      'dns_pinned_active_remaining_zero',
      'final_controlled_drill_live_proven_conservative_readyz_only',
    ],
    does_not_prove: [
      'load_soak_proof',
      'capacity_alert_firing',
      'notification_delivery',
      'autoscaling',
      'capacity_slo_error_budget',
      'backpressure',
      'production',
      'full_G06_proven',
    ],
    limitation:
      'Conservative readiness-profile success only; soak/fire/autoscale/SLO/backpressure open',
  }),
  sunset_mtd_actual_cost_guard: Object.freeze({
    owner_class: 'azure_cost_management_actualcost_readonly',
    observation: 'sunset_mtd_actualcost_before_after_identical_with_initial_after_429_retry',
    proves: [
      'sunset_mtd_actualcost_before_equals_after',
      'amount_18_2443795483871_USD',
      'initial_after_query_429_then_successful_retry_disclosed',
    ],
    does_not_prove: [
      'budget_anomaly_detection',
      'production_cost_proof',
      'full_G06_proven',
    ],
    limitation: 'Sunset staging RG MTD ActualCost guard only; identical before/after',
  }),
});

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'load_soak_proof',
  'capacity_alert_firing',
  'notification_delivery',
  'autoscaling',
  'capacity_slo_error_budget',
  'backpressure',
  'production',
  'full_G06_proven',
  'any_gate_verdict_proven',
  'scale_mutation_by_this_slice',
  'deploy_by_this_slice',
  'min_max_replica_mutation',
]);

const CLAIMS_ALLOWED = Object.freeze([
  'conservative_dual_staging_readyz_bounded_load_live_proven',
  'exact_two_staging_readyz_60_of_60_2xx_peak2_zero_errors',
  'exact_wh_sunset_latency_wall_metrics',
  'pre_post_readyz_ready',
  'response_bodies_redirects_headers_auth_body_false_dns_pinned_active_zero',
  'sunset_mtd_actualcost_identical_before_after',
  'after_query_initial_429_then_successful_retry_disclosed',
  'g06_remains_partial_score_unchanged',
  'soak_fire_autoscale_slo_backpressure_production_not_claimed',
]);

const OWNED_RELS = Object.freeze([
  EVIDENCE_REL,
  CONTRACT_REL,
  'scripts/lib/radar-slice16ai-g06-live-load-evidence.js',
  'scripts/verify-radar-slice16ai-g06-live-load-evidence.js',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
]);

const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'docker/hermes-staging/',
  'scripts/staff-query-api.js',
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
  'infra/azure/staging-staff-api-metric-alerts/',
  'infra/azure/staging-cost-budgets/',
  'scripts/lib/radar-g06-bounded-load-harness.js',
]);

const REQUIRED_RED = Object.freeze([
  'wrong_target_rejected',
  'wrong_status_count_rejected',
  'wrong_latency_rejected',
  'wrong_concurrency_peak_rejected',
  'timeout_or_error_drift_rejected',
  'cost_amount_drift_rejected',
  'cost_429_disclosure_removed_rejected',
  'soak_overclaim_rejected',
  'firing_overclaim_rejected',
  'autoscaling_overclaim_rejected',
  'full_g06_overclaim_rejected',
  'lock_hash_mismatch_rejected',
  'doc_overclaim_tokens_detectable',
  'scope_overclaim_production_rejected',
]);

const REQUIRED_GREEN = Object.freeze([
  'exact_two_targets_60_of_60_2xx',
  'exact_latency_and_wall',
  'pre_post_readyz_ready',
  'transport_hygiene_dns_pinned_active_zero',
  'sunset_cost_identical_with_429_retry_disclosed',
  'final_controlled_drill_live_proven_conservative_only',
  'g06_remains_partial',
  'score_not_inflated',
  'package_script_registered',
  'runtime_paths_unchanged',
  '16ah_attempted_not_proof_retained',
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
  WH_READYZ_URL,
  SUNSET_READYZ_URL,
  ALLOWED_TARGETS,
  PROFILE_ID,
  DRILL_EXECUTED_AT,
  INDEPENDENT_VERIFY_UTC,
  WH_LATENCY,
  WH_WALL_MS,
  SUNSET_LATENCY,
  SUNSET_WALL_MS,
  STATUS_COUNTS_ZERO_NON2XX,
  PROFILE_LOCK,
  COST_AMOUNT,
  COST_CURRENCY,
  COST_SCOPE,
  COST_BEFORE_AT,
  COST_AFTER_AT,
  COST_PERIOD,
  SOURCE_TYPE,
  SOURCE_REF,
  OBSERVED_AT_SEMANTICS,
  FINAL_CONTROLLED_DRILL_STATUS,
  PROVENANCE_LIMITATIONS,
  NON_RECOVERABILITY,
  CLAIM_OWNERSHIP,
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
