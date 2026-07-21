'use strict';

/**
 * radar-slice16ak-g06-backpressure — RADAR Slice 16AK locks.
 *
 * Text/source-only G06 backpressure / admission-control contract + pure
 * dependency-free state machine. Inspected Staff API topology classification
 * (side-effect / idempotency) informs the reviewed eligible-route allowlist;
 * library is NOT wired into runtime by this slice.
 *
 * Does NOT deploy, execute live/load/soak, mutate scale, claim backpressure
 * proven / G06 proven / production, or change the score. Final Staff API
 * integration drill is defined_not_executed only. Sync-throw integration
 * ownership is explicitly not claimed.
 */

const ac = require('./radar-g06-admission-control');

const MASTER_BASIS = '9fa3626326c0e2bc21f2d37905967d6ff47b7520';
const SLICE = 'RADAR-16AK';
const OUTCOME_ID = '16AK_g06_backpressure_source';
const GATE_ID = 'G06_scaling_capacity';
const GATE_IDS = Object.freeze([GATE_ID]);
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16ak-g06-backpressure-source';

const CONTRACT_REL = 'fixtures/radar-operations/slice16ak-expected-contract.json';
const DESIGN_REL = 'fixtures/radar-operations/slice16ak-g06-backpressure-contract.json';
const TOPOLOGY_REL = 'fixtures/radar-operations/slice16ak-staff-api-topology.json';
const LIB_REL = 'scripts/lib/radar-g06-admission-control.js';
const LOCKS_REL = 'scripts/lib/radar-slice16ak-g06-backpressure.js';
const VERIFY_REL = 'scripts/verify-radar-slice16ak-g06-backpressure.js';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const RESOURCE_GROUPS = Object.freeze([
  'wh-staging-rg',
  'luna-sunset-staging-rg',
]);

/** Exact locked limits — smallest tenant-safe ceilings (source only). */
const LIMITS_LOCK = ac.LIMITS;

/**
 * Trusted admission tenant source for future integration — ONLY
 * resolveTrustedIngressBinding(...).tenant_slug. Never request headers/query/body.
 */
const TRUSTED_TENANT_SOURCES = Object.freeze([
  Object.freeze({
    id: 'resolveTrustedIngressBinding_tenant_slug',
    evidence: 'scripts/lib/staff-api-request-correlation.js#resolveTrustedIngressBinding',
    field: 'tenant_slug',
    note:
      'Construction-time ingress binding / DEFAULT_CLIENT_SLUG via '
      + 'resolveTrustedIngressBinding(...).tenant_slug only — never request headers/query/body',
  }),
]);

const EXCLUSIONS = Object.freeze({
  health_readiness: Object.freeze([...ac.EXCLUDED_PATHS]),
  in_progress_transactional: Object.freeze([
    'after markSideEffectStarted (BEGIN / stripe_event_id claim / durable write begun)',
    'POST /staff/stripe/webhook once claimStripeWebhookEvent path entered',
    'POST /staff/meta/whatsapp/webhook once durable mutate begun',
  ]),
  readiness_independence:
    'Admission saturation must not cause /healthz or /readyz to return 503; '
    + 'those paths are classifyRoute admission=exclude and never count toward limits',
  unknown_routes:
    'Unknown method+path pairs are default-exclude fail-closed — not on the reviewed '
    + 'eligible-route allowlist; no suffix heuristic; no all-router-literal coverage claim',
});

const BUILDS_ON = Object.freeze([
  '16AJ_g06_slo_error_budget_source',
  '16AI_g06_live_load_evidence',
  '16AH_g06_live_load_correction',
  '16AG_g06_bounded_load_harness',
  '16AF_g06_capacity_alert_live_evidence',
  '16L_staff_api_capacity_pressure_alerts',
  '16M_stripe_event_claim',
  '16J_staff_request_correlation',
  '16K_staff_api_healthz',
  '16I_staff_api_readiness',
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'backpressure_proven',
  'admission_control_runtime_wired',
  'live_503_shed_observed',
  'load_soak_proof',
  'autoscaling',
  'capacity_slo_proven',
  'error_budget_proven',
  'production',
  'full_G06_proven',
  'any_gate_verdict_proven',
  'scale_mutation_by_this_slice',
  'deploy_by_this_slice',
  'staff_api_runtime_mutation',
  'sync_throw_integration_ownership',
  'all_router_literal_route_coverage',
  'suffix_heuristic_classification',
]);

const FORBIDDEN_CLAIM_TOKENS = Object.freeze([
  'backpressure proven',
  'admission control proven',
  'G06 proven',
  'full G06',
  'full_G06_proven',
  'production',
  'SLO proven',
  'capacity SLO proven',
  'autoscaling proven',
  'load soak proven',
  'wired into runtime',
  'live shed proven',
  'all 159',
  'all-159',
]);

const FUTURE_INTEGRATION_DRILL = Object.freeze({
  id: '16AK_INTEGRATION_staff_api_admission_wire',
  status: 'defined_not_executed',
  pass_rule:
    'After an approved future slice: wire createAdmissionController at '
    + 'createStaffQueryApiHttpServer boundary using ONLY '
    + 'resolveTrustedIngressBinding(...).tenant_slug; exclude /healthz+/readyz+/; '
    + 'admit only reviewed eligible-route allowlist (unknown default-exclude fail-closed); '
    + 'markSideEffectStarted before BEGIN/claim/durable writes; fail-fast 503+Retry-After '
    + 'only for pre-side-effect overload; post-side-effect rejection is internal '
    + 'continue/fail-closed with no HTTP/retry metadata; close() rejects queued '
    + 'pre-side-effect work and settles state; does not claim production, soak, '
    + 'autoscale, sync-throw integration ownership, or raising G06 to proven',
});

const FINAL_CONTROLLED_DRILL = FUTURE_INTEGRATION_DRILL;

const OFFLINE_SOURCE_CONTRACT = Object.freeze({
  id: '16AK_OFFLINE_admission_control_source_contract',
  status: 'offline_source_proven',
  pass_rule:
    'Pure dependency-free admission controller + deterministic RED/GREEN verifier '
    + 'prove exact locked limits, reviewed eligible-route allowlist classification, '
    + 'burst/queue overflow 503+Retry-After only pre-side-effect, post-side-effect '
    + 'internal continue/fail-closed (no http_status/Retry-After/retryable), '
    + 'starvation/fairness round-robin, spoofed/missing tenant fail-closed, '
    + 'timeout/abort/race cleanup, tombstone-bounded terminal memory, idle tenant '
    + 'bucket eviction (65th historical tenant), close/shutdown settle, real induced '
    + 'reentrancy, opaque diagnostics (no tenant slugs), readiness independence; '
    + 'integration drill defined_not_executed only; sync-throw integration ownership '
    + 'explicitly not claimed; G06 remains partial; proven count remains 0; no '
    + 'live/deploy/scale/runtime wire',
});

const OWNED_RELS = Object.freeze([
  DESIGN_REL,
  CONTRACT_REL,
  TOPOLOGY_REL,
  LIB_REL,
  LOCKS_REL,
  VERIFY_REL,
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
  'scripts/staff-query-api.js',
  'scripts/lib/staff-api-readiness.js',
  'scripts/lib/staff-api-readiness-lifecycle.js',
  'scripts/lib/staff-api-readiness-shutdown-completion-log.js',
  'scripts/lib/staff-api-request-correlation.js',
  'scripts/lib/staff-api-healthz.js',
  'scripts/lib/stripe-webhook-event-claim.js',
  'scripts/lib/radar-g06-bounded-load-harness.js',
  'scripts/lib/radar-g06-slo-error-budget.js',
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
  GATE_IDS,
  PROGRESS_CLASS,
  BRANCH,
  CONTRACT_REL,
  DESIGN_REL,
  TOPOLOGY_REL,
  LIB_REL,
  LOCKS_REL,
  VERIFY_REL,
  SUBSCRIPTION_ID,
  RESOURCE_GROUPS,
  LIMITS_LOCK,
  TRUSTED_TENANT_SOURCES,
  EXCLUSIONS,
  BUILDS_ON,
  EXPLICITLY_NOT_CLAIMED,
  FORBIDDEN_CLAIM_TOKENS,
  FUTURE_INTEGRATION_DRILL,
  FINAL_CONTROLLED_DRILL,
  OFFLINE_SOURCE_CONTRACT,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  ac,
};
