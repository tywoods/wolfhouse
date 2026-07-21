'use strict';

/**
 * radar-slice16ah-g06-live-load-correction — RADAR Slice 16AH locks.
 *
 * Source correction for G06 load harness: pinnedLookup must honor Node's
 * dns.lookup callback contract when options.all===true (Happy Eyeballs).
 * Offline production-shaped RED proves scalar replies fail before HTTP with
 * safe error-code classes only. Preserves G06 partial; records the failed
 * post-16AG live attempt as attempted_not_proof (not load success). No live
 * execution / deploy / scale mutation by this tip.
 */

const path = require('path');
const harness = require('./radar-g06-bounded-load-harness');

const MASTER_BASIS = '6c24e9456bd42c7fa1b051bb1308aae8f632b293';
const SLICE = 'RADAR-16AH';
const OUTCOME_ID = '16AH_g06_live_load_correction';
const GATE_ID = 'G06_scaling_capacity';
const GATE_IDS = Object.freeze([GATE_ID]);
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16ah-g06-live-load-correction';

const HARNESS_REL = 'scripts/lib/radar-g06-bounded-load-harness.js';
const LOCKS_REL = 'scripts/lib/radar-slice16ah-g06-live-load-correction.js';
const VERIFY_REL = 'scripts/verify-radar-slice16ah-g06-live-load-correction.js';
const CONTRACT_REL = 'fixtures/radar-operations/slice16ah-expected-contract.json';

const WH_READYZ_URL = harness.WH_READYZ_URL;
const SUNSET_READYZ_URL = harness.SUNSET_READYZ_URL;
const ALLOWED_TARGETS = harness.ALLOWED_TARGETS;
const HARNESS_BOUNDS = harness.HARNESS_BOUNDS;
const FUTURE_DRILL_PROFILE = harness.FUTURE_DRILL_PROFILE;
const POST_16AG_LIVE_LOAD_ATTEMPT = harness.POST_16AG_LIVE_LOAD_ATTEMPT;

const OWNED_RELS = Object.freeze([
  HARNESS_REL,
  LOCKS_REL,
  VERIFY_REL,
  CONTRACT_REL,
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
  'scripts/lib/radar-slice16ag-g06-bounded-load-harness.js',
  'scripts/verify-radar-slice16ag-g06-bounded-load-harness.js',
  'scripts/verify-radar-slice16af-g06-capacity-alert-live-evidence.js',
  'scripts/verify-radar-slice16a-operations-gate-ledger.js',
  'scripts/verify-radar-slice16ac-organic-restart-alert-evidence.js',
  'scripts/verify-radar-slice16ad-g02-sampled-restart-continuity-evidence.js',
  'scripts/verify-radar-slice16aa-g02-live-sigint-evidence.js',
  'scripts/verify-radar-slice16ab-g02-readyz503-evidence.js',
  'package.json',
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
  'production_shaped_all_true_scalar_fails_before_http',
  'safe_error_code_classes_no_message_host_body',
  'pinned_lookup_family_miss_errors',
]);

const REQUIRED_GREEN = Object.freeze([
  'pinned_lookup_all_true_returns_validated_array',
  'pinned_lookup_all_false_scalar_contract',
  'pinned_lookup_family_filter_exact_pins',
  'production_shaped_pinned_lookup_reaches_http',
  'error_code_classes_aggregated_safely',
  'live_attempt_recorded_attempted_not_proof',
  'g06_remains_partial',
  'score_not_inflated',
  'no_live_network_in_verifier',
  'package_script_registered',
  '16ag_source_partial_retained',
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'load_soak_proof',
  'live_staging_load_success',
  'live_load_proof',
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
  'pinned_lookup_all_true_callback_contract_corrected',
  'offline_production_shaped_red_green',
  'safe_diagnostic_error_code_classes',
  'post_16ag_live_attempt_attempted_not_proof',
  'g06_remains_partial_score_unchanged',
  '16ag_harness_source_retained',
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
  POST_16AG_LIVE_LOAD_ATTEMPT,
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
