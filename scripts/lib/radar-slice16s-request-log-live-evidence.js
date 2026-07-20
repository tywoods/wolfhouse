'use strict';

/**
 * radar-slice16s-request-log-live-evidence — RADAR Slice 16S locks.
 *
 * Evidence-only reconciliation of operator-observed 16R dual-staging
 * delivery / search / retention. Does not deploy. Does not claim E2E
 * Meta→Hermes→Staff→Stripe correlation drill, concurrent isolation,
 * abort/error LAW outcomes, production, or any gate verdict=proven.
 */

const path = require('path');

const MASTER_BASIS = '1bf9695264250680c41c3e7f82baba97300001a0';
const SLICE = 'RADAR-16S';
const OUTCOME_ID = '16S_request_completion_log_live_evidence';
const GATE_ID = 'G01_correlation_structured_logs';
const PROGRESS_CLASS = 'partial_live_proven_evidence_only';
const BRANCH = 'radar/slice-16s-request-log-live-evidence';

const EVIDENCE_REL = 'fixtures/radar-operations/slice16s-request-log-live-evidence.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16s-expected-contract.json';

const IMAGE_SHA_FULL = MASTER_BASIS;
const IMAGE_SHA_SHORT = '1bf9695';

const WH_APP = 'wh-staging-staff-api';
const WH_REVISION = 'wh-staging-staff-api--0000517';
const WH_REVISION_SUFFIX = '0000517';
const WH_REQUEST_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-16a000000001';
const WH_TIME_GENERATED = '2026-07-20T23:32:38.0049767Z';

const SUNSET_APP = 'luna-sunset-staging-staff-api';
const SUNSET_REVISION = 'luna-sunset-staging-staff-api--0000277';
const SUNSET_REVISION_SUFFIX = '0000277';
const SUNSET_REQUEST_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-16a000000002';
const SUNSET_TIME_GENERATED = '2026-07-20T23:32:54.8551295Z';
const SUNSET_TENANT = 'sunset';

const LOG_TABLE = 'ContainerAppConsoleLogs_CL';
const LOGS_DESTINATION = 'log-analytics';
const MATCH_COUNT = 1;

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

const COMPLETION_FIELDS = Object.freeze({
  event: 'staff_api_request_completion',
  method: 'GET',
  route: '/healthz',
  status_code: 200,
  status_class: '2xx',
  duration_ms: 5,
  outcome: 'completed',
});

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'end_to_end_meta_hermes_staff_stripe_correlation_drill',
  'concurrent_isolation',
  'abort_error_outcomes_in_law',
  'production',
  'any_gate_verdict_proven',
  'g02_g09_score_changes',
  'human_inbox_receipt',
  'organic_metric_alert_firing',
]);

const GATES_UNCHANGED = Object.freeze([
  'G02_readiness_dependencies',
  'G03_actionable_tenant_aware_alerts',
  'G04_webhook_payment_worker_backlog',
  'G05_retry_replay_safety',
  'G06_scaling_capacity',
  'G07_rollback_incident_runbooks',
  'G08_retention_privacy',
  'G09_cost_controls',
]);

const SENSITIVE_FORBIDDEN_KEYS = Object.freeze([
  'headers',
  'header',
  'authorization',
  'cookie',
  'cookies',
  'body',
  'query',
  'raw_url',
  'url',
  'ip',
  'user_agent',
  'email',
  'phone',
  'guest',
  'customer',
  'name',
  'token',
  'key',
  'secret',
  'stripe_signature',
  'stripe_payload',
  'stack',
  'error_text',
  'exception',
  'db_error',
  'response_body',
]);

const OWNED_RELS = Object.freeze([
  EVIDENCE_REL,
  CONTRACT_REL,
  'scripts/lib/radar-slice16s-request-log-live-evidence.js',
  'scripts/verify-radar-slice16s-request-log-live-evidence.js',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
]);

const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'docker/hermes-staging/',
  'scripts/staff-query-api.js',
  'scripts/lib/staff-api-request-completion-log.js',
  'scripts/lib/stripe-webhook-public-errors.js',
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
  PROGRESS_CLASS,
  BRANCH,
  EVIDENCE_REL,
  CONTRACT_REL,
  IMAGE_SHA_FULL,
  IMAGE_SHA_SHORT,
  WH_APP,
  WH_REVISION,
  WH_REVISION_SUFFIX,
  WH_REQUEST_ID,
  WH_TIME_GENERATED,
  SUNSET_APP,
  SUNSET_REVISION,
  SUNSET_REVISION_SUFFIX,
  SUNSET_REQUEST_ID,
  SUNSET_TIME_GENERATED,
  SUNSET_TENANT,
  LOG_TABLE,
  LOGS_DESTINATION,
  MATCH_COUNT,
  WH_LAW,
  SUNSET_LAW,
  COMPLETION_FIELDS,
  EXPLICITLY_NOT_CLAIMED,
  GATES_UNCHANGED,
  SENSITIVE_FORBIDDEN_KEYS,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
