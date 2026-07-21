'use strict';

/**
 * radar-slice16an-g06-wolfhouse-ingress-binding — RADAR Slice 16AN locks.
 *
 * Diagnose failed Wolfhouse admission activation (identity fail-closed 503,
 * not overload shed) and ship the smallest safe correction: dedicated
 * STAFF_API_INGRESS_TENANT_SLUG with DEFAULT_CLIENT_SLUG compat fallback and
 * conflict fail-closed. Wire Wolfhouse/Sunset staging IaC explicitly.
 * No live deploy/mutation in this tip; G06 remains partial.
 */

const MASTER_BASIS = '63ba28fe4149609db8277e7ebb8a80e5f1d18945';
const SLICE = 'RADAR-16AN';
const OUTCOME_ID = '16AN_g06_wolfhouse_ingress_binding';
const GATE_ID = 'G06_scaling_capacity';
const GATE_IDS = Object.freeze([GATE_ID]);
const PROGRESS_CLASS = 'source_deploy_config_partial_progress_only';
const BRANCH = 'radar/slice-16an-g06-wolfhouse-ingress-binding';

const CONTRACT_REL = 'fixtures/radar-operations/slice16an-expected-contract.json';
const DESIGN_REL = 'fixtures/radar-operations/slice16an-g06-wolfhouse-ingress-binding-contract.json';
const LOCKS_REL = 'scripts/lib/radar-slice16an-g06-wolfhouse-ingress-binding.js';
const VERIFY_REL = 'scripts/verify-radar-slice16an-g06-wolfhouse-ingress-binding.js';
const CORRELATION_REL = 'scripts/lib/staff-api-request-correlation.js';
const BOUNDARY_REL = 'scripts/lib/staff-api-admission-boundary.js';
const WH_BICEP_REL = 'infra/azure/staging/main.bicep';
const SUNSET_BICEP_REL = 'infra/azure/sunset-staging/main.bicep';
const ENV_EXAMPLE_REL = 'infra/.env.example';

const INGRESS_ENV = 'STAFF_API_INGRESS_TENANT_SLUG';
const DEFAULT_ENV = 'DEFAULT_CLIENT_SLUG';
const FLAG_ENV = 'STAFF_API_ADMISSION_CONTROL';

const WH_INGRESS_SLUG = 'wolfhouse-somo';
const SUNSET_INGRESS_SLUG = 'sunset';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const RESOURCE_GROUPS = Object.freeze([
  'wh-staging-rg',
  'luna-sunset-staging-rg',
]);

const BUILDS_ON = Object.freeze([
  '16AM_g06_backpressure_deploy_evidence',
  '16AL_g06_backpressure_wire',
  '16AK_g06_backpressure_source',
  '16J_staff_request_correlation',
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'live_deploy_by_this_slice',
  'live_mutation_by_this_slice',
  'flag_enabled_by_this_slice',
  'live_503_overload_shed',
  'backpressure_proven',
  'backpressure_live',
  'load_soak_proof',
  'autoscaling',
  'capacity_slo_proven',
  'production',
  'full_G06_proven',
  'any_gate_verdict_proven',
  'setting_DEFAULT_CLIENT_SLUG_alone_on_wolfhouse',
]);

const FORBIDDEN_CLAIM_TOKENS = Object.freeze([
  'backpressure proven',
  'backpressure live',
  'admission control proven',
  'G06 proven',
  'full G06',
  'full_G06_proven',
  'live shed proven',
  'overload shed',
  'production',
]);

/**
 * Operator-observed failed Wolfhouse admission canary + rollback (honest record).
 * This tip does not perform live changes; facts are locked as diagnosis only.
 */
const FAILED_CANARY_ROLLBACK = Object.freeze({
  id: '16AN_OBSERVED_wolfhouse_admission_activation_fail_closed',
  status: 'operator_observed_failed_canary_rolled_back',
  classification: 'identity_fail_closed_not_overload_shed',
  sunset: Object.freeze({
    DEFAULT_CLIENT_SLUG: 'sunset',
    STAFF_API_ADMISSION_CONTROL: true,
    revision: 'luna-sunset-staging-staff-api--0000281',
    invalid_signature_webhook_probes: '80/80 expected 403',
    readyz: 200,
    flag_after: true,
  }),
  wolfhouse: Object.freeze({
    DEFAULT_CLIENT_SLUG: null,
    STAFF_API_ADMISSION_CONTROL: true,
    revision_on_fail: 'wh-staging-staff-api--0000522',
    invalid_signature_webhook_probes: '80/80 returned 503',
    readyz: 200,
    operator_rollback: Object.freeze({
      flag: false,
      revision: 'wh-staging-staff-api--0000523',
      probe_after_rollback: 403,
    }),
  }),
  root_cause:
    'resolveTrustedIngressBinding used only DEFAULT_CLIENT_SLUG; Wolfhouse '
    + 'missing ingress identity → admission REJECTED_MISSING_TENANT → public 503 '
    + '(identity fail-closed). Not overload shed (no Retry-After overload path).',
  does_not_prove: Object.freeze([
    'live_overload_shedding',
    'capacity_exhaustion',
    'successful_flag_on_activation_for_wolfhouse',
    'this_slice_performed_live_deploy_or_rollback',
  ]),
});

const SAFETY_ASSESSMENT = Object.freeze({
  setting_DEFAULT_CLIENT_SLUG_wolfhouse_somo_alone: Object.freeze({
    would_fix_admission: true,
    unrelated_semantic_risk: true,
    risk_note:
      'DEFAULT_CLIENT_SLUG also drives portal deploy-default client, payment '
      + 'short-link fallback, bot-principal compat, and Stripe webhook compat. '
      + 'Setting it on Wolfhouse to fix admission would silently couple ingress '
      + 'identity to those unrelated route defaults.',
    chosen: false,
  }),
  dedicated_STAFF_API_INGRESS_TENANT_SLUG: Object.freeze({
    preferred: true,
    wolfhouse_value: WH_INGRESS_SLUG,
    sunset_value: SUNSET_INGRESS_SLUG,
    fallback: DEFAULT_ENV,
    conflict: 'fail_closed',
    wolfhouse_leaves_DEFAULT_CLIENT_SLUG_unset: true,
  }),
});

const INTEGRATION_SOURCE_PROOF = Object.freeze({
  id: '16AN_SOURCE_dedicated_ingress_tenant_slug',
  status: 'source_deploy_config_proven',
  pass_rule:
    'resolveTrustedIngressBinding prefers own STAFF_API_INGRESS_TENANT_SLUG '
    + '(primitive string + slug-valid; present-but-malformed fail-closed, never '
    + 'String()-coerced fallthrough to DEFAULT); only when dedicated is truly '
    + 'absent may strict DEFAULT_CLIENT_SLUG compat fallback apply; conflict '
    + 'fail-closed on normalized mismatch; Wolfhouse staging Bicep sets '
    + 'STAFF_API_INGRESS_TENANT_SLUG=wolfhouse-somo without DEFAULT_CLIENT_SLUG; '
    + 'Sunset sets STAFF_API_INGRESS_TENANT_SLUG=sunset matching DEFAULT; REDs '
    + 'cover missing/conflict/spoof/OFF parity plus blank/non-string/NUL/'
    + 'inherited/nullish/getter/hostile-coercion; failed canary/rollback '
    + 'recorded as identity fail-closed (not overload shed); no live '
    + 'deploy/mutation by this tip; G06 remains partial',
});

const FINAL_CONTROLLED_DRILL = INTEGRATION_SOURCE_PROOF;

const OWNED_RELS = Object.freeze([
  DESIGN_REL,
  CONTRACT_REL,
  LOCKS_REL,
  VERIFY_REL,
  CORRELATION_REL,
  'scripts/staff-query-api.js',
  WH_BICEP_REL,
  SUNSET_BICEP_REL,
  ENV_EXAMPLE_REL,
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
  'package.json',
  'scripts/verify-radar-slice16a-operations-gate-ledger.js',
]);

const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'docker/hermes-staging/',
  'docker/hermes-sunset/',
  'scripts/lib/radar-g06-admission-control.js',
  'scripts/lib/staff-api-admission-boundary.js',
  'scripts/lib/staff-api-readiness.js',
  'infra/azure/staging-staff-api-metric-alerts/',
  'infra/azure/staging-cost-budgets/',
]);

const REQUIRED_RED = Object.freeze([
  'missing_ingress_slug_fail_closed_on',
  'conflict_ingress_slugs_fail_closed',
  'request_spoof_ignored',
  'off_parity_missing_slug_handler_runs',
  'default_alone_compat_fallback',
  'dedicated_preferred_over_default',
  'wolfhouse_bicep_no_default_client_slug',
  'live_deploy_overclaim_rejected',
  'overload_shed_overclaim_rejected',
  'full_g06_overclaim_rejected',
  'default_alone_as_wolfhouse_fix_rejected',
  // Strict dedicated-env fail-closed (no String() fallthrough) — reviewer REDs
  'blank_dedicated_no_default_fallthrough',
  'whitespace_dedicated_no_default_fallthrough',
  'non_string_number_dedicated_fail_closed',
  'non_string_object_array_boxed_dedicated_fail_closed',
  'nul_control_dedicated_fail_closed',
  'oversize_dedicated_fail_closed',
  'unicode_invalid_dedicated_fail_closed',
  'inherited_prototype_dedicated_absent_fallback',
  'undefined_null_present_dedicated_fail_closed',
  'getter_throwing_dedicated_fail_closed',
  'hostile_coercion_dedicated_fail_closed',
  'malformed_present_default_fail_closed',
  'valid_exact_match_both_envs',
  'absent_dedicated_valid_default_fallback',
  'no_secret_raw_value_leakage_in_reason',
]);

const REQUIRED_GREEN = Object.freeze([
  'dedicated_env_constant_exported',
  'resolve_prefers_dedicated',
  'wolfhouse_bicep_wires_ingress_slug',
  'sunset_bicep_wires_ingress_slug_matching_default',
  'env_example_documents_dedicated',
  'failed_canary_recorded_identity_fail_closed',
  'package_script_registered',
  'g06_remains_partial',
  'score_not_inflated',
  '16am_deploy_flag_off_retained',
  'explicit_construction_binding_precedence',
]);

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
  LOCKS_REL,
  VERIFY_REL,
  CORRELATION_REL,
  BOUNDARY_REL,
  WH_BICEP_REL,
  SUNSET_BICEP_REL,
  ENV_EXAMPLE_REL,
  INGRESS_ENV,
  DEFAULT_ENV,
  FLAG_ENV,
  WH_INGRESS_SLUG,
  SUNSET_INGRESS_SLUG,
  SUBSCRIPTION_ID,
  RESOURCE_GROUPS,
  BUILDS_ON,
  EXPLICITLY_NOT_CLAIMED,
  FORBIDDEN_CLAIM_TOKENS,
  FAILED_CANARY_ROLLBACK,
  SAFETY_ASSESSMENT,
  INTEGRATION_SOURCE_PROOF,
  FINAL_CONTROLLED_DRILL,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  REQUIRED_RED,
  REQUIRED_GREEN,
};
