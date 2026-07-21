'use strict';

/**
 * radar-slice16al-g06-backpressure-wire — RADAR Slice 16AL locks.
 *
 * Integrate the reviewed 16AK admission controller into Staff API behind a
 * fail-closed deployment flag (STAFF_API_ADMISSION_CONTROL) default OFF.
 * Integration source proof only — flag stays OFF; no deploy/live load;
 * does not claim backpressure live/proven/full G06; score unchanged.
 */

const MASTER_BASIS = '502d762f897432c67bb8b17a8a49bfab01a0787d';
const SLICE = 'RADAR-16AL';
const OUTCOME_ID = '16AL_g06_backpressure_wire';
const GATE_ID = 'G06_scaling_capacity';
const GATE_IDS = Object.freeze([GATE_ID]);
const PROGRESS_CLASS = 'integration_source_partial_progress_only';
const BRANCH = 'radar/slice-16al-g06-backpressure-wire';

const FLAG_ENV = 'STAFF_API_ADMISSION_CONTROL';
const FLAG_DEFAULT = 'OFF';

const CONTRACT_REL = 'fixtures/radar-operations/slice16al-expected-contract.json';
const DESIGN_REL = 'fixtures/radar-operations/slice16al-g06-backpressure-wire-contract.json';
const BOUNDARY_REL = 'scripts/lib/staff-api-admission-boundary.js';
const LOCKS_REL = 'scripts/lib/radar-slice16al-g06-backpressure-wire.js';
const VERIFY_REL = 'scripts/verify-radar-slice16al-g06-backpressure-wire.js';
const CONTROLLER_REL = 'scripts/lib/radar-g06-admission-control.js';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
const RESOURCE_GROUPS = Object.freeze([
  'wh-staging-rg',
  'luna-sunset-staging-rg',
]);

const BUILDS_ON = Object.freeze([
  '16AK_g06_backpressure_source',
  '16AJ_g06_slo_error_budget_source',
  '16AI_g06_live_load_evidence',
  '16AH_g06_live_load_correction',
  '16AG_g06_bounded_load_harness',
  '16AF_g06_capacity_alert_live_evidence',
  '16J_staff_request_correlation',
  '16R_staff_request_completion_log',
  '16K_staff_api_healthz',
  '16I_staff_api_readiness',
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'backpressure_proven',
  'backpressure_live',
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
  'flag_enabled_in_staging',
  'flag_enabled_in_production',
]);

const FORBIDDEN_CLAIM_TOKENS = Object.freeze([
  'backpressure proven',
  'backpressure live',
  'admission control proven',
  'G06 proven',
  'full G06',
  'full_G06_proven',
  'production',
  'live shed proven',
  'wired and enabled',
]);

const INTEGRATION_SOURCE_PROOF = Object.freeze({
  id: '16AL_INTEGRATION_staff_api_admission_wire_source',
  status: 'integration_source_proven',
  pass_rule:
    'Staff API HTTP boundary wires createAdmissionBoundary behind '
    + 'STAFF_API_ADMISSION_CONTROL default OFF after resolveTrustedIngressBinding '
    + 'tenant_slug and before router body/DB/tool side effects; eligible-route '
    + 'allowlist only; health/ready/unknown excluded; release-once on '
    + 'finish/close/error/abort; queued disconnect cancels; queued promotion '
    + 'resumes handler exactly once; transport-dead cancel before queue and '
    + 'before promoted run; named once listeners detach to baseline; late '
    + 'events cannot cancel promoted tokens; sync/async throws clean up; '
    + 'admissionBoundary.close at readiness-lifecycle shutdown BEGIN before '
    + 'server.close (not server close event) via per-server Set-deduped '
    + 'registry/dispatcher (duplicate bind no-op; close exactly once; prior '
    + 'hook once; no wrapper chains; symbols cleared after fire); '
    + 'post-side-effect never 503-shed; '
    + 'public 503 body/Retry-After bounded/non-sensitive; malformed flag '
    + 'rejected; OFF exact behavior-preserving; deterministic fake req/res '
    + 'integration tests; flag not enabled; no deploy/live load; score '
    + 'unchanged; G06 remains partial',
});

const FINAL_CONTROLLED_DRILL = INTEGRATION_SOURCE_PROOF;

const OWNED_RELS = Object.freeze([
  DESIGN_REL,
  CONTRACT_REL,
  BOUNDARY_REL,
  LOCKS_REL,
  VERIFY_REL,
  'scripts/staff-query-api.js',
  'scripts/lib/staff-api-readiness-lifecycle.js',
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
  'scripts/lib/staff-api-readiness.js',
  'scripts/lib/staff-api-request-correlation.js',
  'scripts/lib/radar-g06-admission-control.js',
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
  FLAG_ENV,
  FLAG_DEFAULT,
  CONTRACT_REL,
  DESIGN_REL,
  BOUNDARY_REL,
  LOCKS_REL,
  VERIFY_REL,
  CONTROLLER_REL,
  SUBSCRIPTION_ID,
  RESOURCE_GROUPS,
  BUILDS_ON,
  EXPLICITLY_NOT_CLAIMED,
  FORBIDDEN_CLAIM_TOKENS,
  INTEGRATION_SOURCE_PROOF,
  FINAL_CONTROLLED_DRILL,
  OWNED_RELS,
  MUST_NOT_MUTATE,
};
