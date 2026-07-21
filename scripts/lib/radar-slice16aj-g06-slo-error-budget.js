'use strict';

/**
 * radar-slice16aj-g06-slo-error-budget — RADAR Slice 16AJ locks.
 *
 * Text/source-only G06 capacity SLO / error-budget contract + pure calculator.
 * Availability-only staging readiness SLI from ACA Requests Sum (Azure Monitor
 * Total aggregation) split by statusCodeCategory. Exact rolling PT7D span,
 * PT5M grain, error-budget + multi-window burn math, fail-closed states.
 *
 * Latency percentile SLI is explicitly blocked pending joint request
 * telemetry/instrumentation — not part of this SLO. No ACA duration histogram,
 * p99<=500ms, combined min/intersection, or combined error budget.
 *
 * Does NOT deploy alerts, execute live, mutate scale, claim production / SLO
 * proven / backpressure / autoscale / full G06, or change the score.
 * Builds on 16AI conservative /readyz live evidence + existing Requests /
 * statusCodeCategory metrics and PT5M/PT15M alert cadence — does not invent
 * live proof.
 */

const calc = require('./radar-g06-slo-error-budget');

const MASTER_BASIS = '0994989a3d5d14daa98797fac55083b0c2ea809c';
const SLICE = 'RADAR-16AJ';
const OUTCOME_ID = '16AJ_g06_slo_error_budget_source';
const GATE_ID = 'G06_scaling_capacity';
const GATE_IDS = Object.freeze([GATE_ID]);
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16aj-g06-slo-error-budget-source';

const CONTRACT_REL = 'fixtures/radar-operations/slice16aj-expected-contract.json';
const DESIGN_REL = 'fixtures/radar-operations/slice16aj-g06-slo-error-budget-contract.json';
const CALC_REL = 'scripts/lib/radar-g06-slo-error-budget.js';
const LOCKS_REL = 'scripts/lib/radar-slice16aj-g06-slo-error-budget.js';
const VERIFY_REL = 'scripts/verify-radar-slice16aj-g06-slo-error-budget.js';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const RESOURCE_GROUPS = Object.freeze([
  'wh-staging-rg',
  'luna-sunset-staging-rg',
]);

/** Implementable Azure Container Apps metric surface (already used by 16H). */
const METRIC_NAMESPACE = 'Microsoft.App/containerApps';
const AVAILABILITY_METRIC = 'Requests';
/** Azure Monitor aggregation name for Sum of request counts. */
const AVAILABILITY_AGGREGATION = 'Total';
const AVAILABILITY_AGGREGATION_SEMANTICS = 'sum_of_request_counts';
const STATUS_DIMENSION = 'statusCodeCategory';
const STATUS_GOOD = '2xx';
const STATUS_KNOWN = Object.freeze(['2xx', '3xx', '4xx', '5xx']);

/** Alert cadence already evidenced (not re-proven here). */
const EXISTING_ALERT_CADENCE = Object.freeze({
  capacity_pressure_16l_16af: Object.freeze({
    evaluation_frequency: 'PT5M',
    window_size: 'PT15M',
  }),
  requests_5xx_16h: Object.freeze({
    evaluation_frequency: 'PT1M',
    window_size: 'PT5M',
  }),
  slo_eval_grain_aligned_to: 'PT5M',
});

const SLI_LOCK = Object.freeze({
  name: 'staging_staff_api_readiness_capacity_availability',
  scope: 'staging_only',
  kind: 'availability_only',
  availability: Object.freeze({
    metric_namespace: METRIC_NAMESPACE,
    metric_name: AVAILABILITY_METRIC,
    aggregation: AVAILABILITY_AGGREGATION,
    aggregation_semantics: AVAILABILITY_AGGREGATION_SEMANTICS,
    good_dimension: Object.freeze({
      name: STATUS_DIMENSION,
      value: STATUS_GOOD,
    }),
    known_status_categories: STATUS_KNOWN,
    formula: 'requests_2xx_delta / requests_total_delta',
    target: calc.AVAILABILITY_TARGET,
  }),
  latency_percentile_sli: calc.LATENCY_PERCENTILE_SLI,
  combined: Object.freeze({
    status: 'forbidden',
    reason: 'disjoint_marginals_cannot_claim_intersection',
  }),
  window: Object.freeze({
    slo_window_ms: calc.SLO_WINDOW_MS,
    slo_window_label: 'PT7D_exact_rolling',
    sample_step_ms: calc.SAMPLE_STEP_MS,
    sample_step_label: 'PT5M',
    min_sample_coverage: calc.MIN_SAMPLE_COVERAGE,
    min_requests: calc.MIN_REQUESTS,
    coverage_reference: 'PT7D',
    burn_windows_distinct_from_slo_span: true,
    baseline_max_skew: 'one_PT5M_grain',
  }),
});

const ERROR_BUDGET_LOCK = Object.freeze({
  kind: 'availability_only',
  budget_fraction: 1 - calc.AVAILABILITY_TARGET,
  burn_rate_formula: 'bad_rate / budget_fraction',
  budget_consumed_formula: 'burn_rate * (eval_window_ms / slo_window_ms)',
  multi_window_burns: calc.MULTI_WINDOW_BURNS,
  combined_error_budget: 'forbidden',
});

const FAIL_CLOSED_STATES = Object.freeze([
  calc.FAIL_CODES.MISSING_SAMPLES,
  calc.FAIL_CODES.COUNTER_RESET,
  calc.FAIL_CODES.OUT_OF_ORDER,
  calc.FAIL_CODES.ZERO_TRAFFIC,
  calc.FAIL_CODES.INSUFFICIENT_COVERAGE,
  calc.FAIL_CODES.INSUFFICIENT_REQUESTS,
  calc.FAIL_CODES.INVALID_INPUT,
  calc.FAIL_CODES.IRREGULAR_GRAIN,
  calc.FAIL_CODES.STALE_BASELINE,
  calc.FAIL_CODES.WINDOW_SPAN_MISMATCH,
  calc.FAIL_CODES.UNSAFE_INTEGER,
  calc.FAIL_CODES.LATENCY_SLI_BLOCKED,
  calc.FAIL_CODES.COMBINED_CLAIM_FORBIDDEN,
  calc.FAIL_CODES.CONTRACT_DRIFT,
]);

const FUTURE_ALERT_ACCEPTANCE = Object.freeze({
  id: '16AJ_ALERT_multi_window_burn_acceptance',
  status: 'defined_not_executed',
  pass_rule:
    'After approved Incremental deploy (future slice): both staging tenants have '
    + 'multi-window burn alert pairs matching MULTI_WINDOW_BURNS (page_fast 5m+1h@14.4, '
    + 'page_slow 30m+6h@6, ticket_fast 2h+1d@3, ticket_slow 6h+3d@1) wired to owned ops '
    + 'AGs; fire/delivery proven without claiming live SLO compliance, soak, autoscale, '
    + 'backpressure, production, or raising G06 to proven',
});

const FUTURE_DRILL_ACCEPTANCE = Object.freeze({
  id: '16AJ_DRILL_error_budget_burn_acceptance',
  status: 'defined_not_executed',
  pass_rule:
    'After approved controlled staging drill (future slice): synthetic or organic '
    + 'Requests counter series drive calculator burn pairs to would_fire for at least '
    + 'one page pair and one ticket pair with fail-closed states exercised; does not '
    + 'claim production, SLO proven, autoscale, backpressure, or full G06',
});

const BUILDS_ON = Object.freeze([
  '16AI_g06_live_load_evidence',
  '16AH_g06_live_load_correction',
  '16AG_g06_bounded_load_harness',
  '16AF_g06_capacity_alert_live_evidence',
  '16L_staff_api_capacity_pressure_alerts',
  '16H_staff_api_metric_alerts',
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'capacity_slo_proven',
  'error_budget_proven',
  'live_burn_alert_deployed',
  'live_burn_alert_fired',
  'notification_delivery',
  'load_soak_proof',
  'autoscaling',
  'backpressure',
  'production',
  'full_G06_proven',
  'any_gate_verdict_proven',
  'scale_mutation_by_this_slice',
  'deploy_by_this_slice',
  '16AI_latency_as_slo_proof',
  'aca_duration_histogram',
  'latency_percentile_sli',
  'p99_le_500ms',
  'combined_min_intersection_slo',
  'combined_error_budget',
]);

const FORBIDDEN_CLAIM_TOKENS = Object.freeze([
  'capacity SLO proven',
  'error budget proven',
  'SLO proven',
  'production',
  'full G06',
  'full_G06_proven',
  'G06 proven',
  'backpressure proven',
  'autoscaling proven',
  'load soak proven',
  'alert fired',
  'notification delivered',
  'p99 <= 500ms',
  'combined SLO proven',
]);

const OWNED_RELS = Object.freeze([
  DESIGN_REL,
  CONTRACT_REL,
  CALC_REL,
  LOCKS_REL,
  VERIFY_REL,
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
]);

const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'docker/hermes-staging/',
  'docker/hermes-sunset/',
  'scripts/staff-query-api.js',
  'scripts/lib/staff-api-readiness.js',
  'scripts/lib/staff-api-readiness-lifecycle.js',
  'scripts/lib/staff-api-readiness-shutdown-completion-log.js',
  'scripts/lib/radar-g06-bounded-load-harness.js',
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
  'infra/azure/staging-staff-api-metric-alerts/',
  'infra/azure/staging-cost-budgets/',
]);

const FINAL_CONTROLLED_DRILL = Object.freeze({
  id: '16AJ_OFFLINE_slo_error_budget_source_contract',
  status: 'offline_source_proven',
  pass_rule:
    'Pure dependency-free availability-only calculator + deterministic RED/GREEN '
    + 'verifier prove exact PT7D availability boundaries, locked normative constants '
    + '(reject contract drift), error-budget reporting numerics, exact BigInt '
    + 'cross-multiplication burn thresholds (below never / eq+above fire), '
    + 'baseline-within-grain burn slicing, and fail-closed '
    + 'missing/reset/out-of-order/zero-traffic/sparse/stale-baseline/span-mismatch/'
    + 'unsafe-integer/NaN/latency-blocked/combined-forbidden/contract-drift/overclaim '
    + 'paths; latency percentile SLI recorded blocked; future alert/drill acceptance '
    + 'defined_not_executed only; G06 remains partial; proven count remains 0; no '
    + 'live/deploy/scale mutation',
});

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  GATE_IDS,
  PROGRESS_CLASS,
  BRANCH,
  CONTRACT_REL,
  DESIGN_REL,
  CALC_REL,
  LOCKS_REL,
  VERIFY_REL,
  SUBSCRIPTION_ID,
  RESOURCE_GROUPS,
  METRIC_NAMESPACE,
  AVAILABILITY_METRIC,
  AVAILABILITY_AGGREGATION,
  AVAILABILITY_AGGREGATION_SEMANTICS,
  STATUS_DIMENSION,
  STATUS_GOOD,
  STATUS_KNOWN,
  EXISTING_ALERT_CADENCE,
  SLI_LOCK,
  ERROR_BUDGET_LOCK,
  FAIL_CLOSED_STATES,
  FUTURE_ALERT_ACCEPTANCE,
  FUTURE_DRILL_ACCEPTANCE,
  BUILDS_ON,
  EXPLICITLY_NOT_CLAIMED,
  FORBIDDEN_CLAIM_TOKENS,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  FINAL_CONTROLLED_DRILL,
  calc,
};
