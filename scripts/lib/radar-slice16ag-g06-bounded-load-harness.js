'use strict';

/**
 * radar-slice16ag-g06-bounded-load-harness — RADAR Slice 16AG locks.
 *
 * Source-partial G06 progress: dependency-free bounded Node load harness hard-
 * locked to the two exact staging Staff API /readyz URLs. Offline RED/GREEN
 * fake-server verifier proves bounds/concurrency/redirects/target-escape/
 * latency/non-2xx accounting. Future drill profile defined but NOT executed.
 * No live network, deploy, scale mutation, SLO, or backpressure claims.
 */

const path = require('path');
const harness = require('./radar-g06-bounded-load-harness');

const MASTER_BASIS = '7a283b70d38a4906e6279d82a49c0f6dd2a4994e';
const SLICE = 'RADAR-16AG';
const OUTCOME_ID = '16AG_g06_bounded_load_harness';
const GATE_ID = 'G06_scaling_capacity';
const GATE_IDS = Object.freeze([GATE_ID]);
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16ag-g06-bounded-load-harness';

const HARNESS_REL = 'scripts/lib/radar-g06-bounded-load-harness.js';
const LOCKS_REL = 'scripts/lib/radar-slice16ag-g06-bounded-load-harness.js';
const VERIFY_REL = 'scripts/verify-radar-slice16ag-g06-bounded-load-harness.js';
const CONTRACT_REL = 'fixtures/radar-operations/slice16ag-expected-contract.json';

const WH_READYZ_URL = harness.WH_READYZ_URL;
const SUNSET_READYZ_URL = harness.SUNSET_READYZ_URL;
const ALLOWED_TARGETS = harness.ALLOWED_TARGETS;
const HARNESS_BOUNDS = harness.HARNESS_BOUNDS;
const FUTURE_DRILL_PROFILE = harness.FUTURE_DRILL_PROFILE;

const OWNED_RELS = Object.freeze([
  HARNESS_REL,
  LOCKS_REL,
  VERIFY_REL,
  CONTRACT_REL,
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
]);

const REQUIRED_RED = Object.freeze([
  'target_escape_rejected',
  'http_target_rejected',
  'non_readyz_path_rejected',
  'query_string_rejected',
  'concurrency_over_max_rejected',
  'duration_over_max_rejected',
  'requests_over_max_rejected',
  'timeout_over_max_rejected',
  'post_method_rejected',
  'custom_headers_rejected',
  'body_rejected',
  'auth_rejected',
  'follow_redirects_rejected',
  'collect_bodies_rejected',
  'redirect_not_followed',
  'response_bodies_absent_from_report',
]);

const REQUIRED_GREEN = Object.freeze([
  'allowlist_exact_two_readyz',
  'bounds_respected',
  'concurrency_peak_bounded',
  'max_requests_stop',
  'max_duration_stop',
  'latency_percentiles_present',
  'timeout_class_accounted',
  'error_class_accounted',
  'non_2xx_status_classes_accounted',
  'future_drill_defined_not_executed',
  'g06_remains_partial',
  'score_not_inflated',
  'no_live_network_in_verifier',
  'package_script_registered',
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'load_soak_proof',
  'live_staging_load_execution',
  'capacity_alert_firing',
  'notification_delivery',
  'autoscaling',
  'capacity_slo_error_budget',
  'backpressure',
  'production',
  'full_G06_proven',
  'scale_mutation_by_this_slice',
  'deploy_by_this_slice',
]);

const CLAIMS_ALLOWED = Object.freeze([
  'bounded_load_harness_source_landed',
  'hard_locked_two_staging_readyz_targets',
  'get_only_no_headers_body_auth_redirects',
  'tls_required_fail_closed_other_targets',
  'aggregate_counts_p50_p95_p99_max_status_classes_no_bodies',
  'offline_fake_server_red_green_verifier',
  'future_drill_profile_defined_not_executed',
  'g06_remains_partial_score_unchanged',
]);

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  GATE_IDS,
  PROGRESS_CLASS,
  BRANCH,
  HARNESS_REL,
  LOCKS_REL,
  VERIFY_REL,
  CONTRACT_REL,
  WH_READYZ_URL,
  SUNSET_READYZ_URL,
  ALLOWED_TARGETS,
  HARNESS_BOUNDS,
  FUTURE_DRILL_PROFILE,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  REQUIRED_RED,
  REQUIRED_GREEN,
  EXPLICITLY_NOT_CLAIMED,
  CLAIMS_ALLOWED,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
