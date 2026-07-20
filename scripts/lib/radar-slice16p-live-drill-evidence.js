'use strict';

/**
 * radar-slice16p-live-drill-evidence — RADAR Slice 16P locks.
 *
 * Source-only evidence reconciliation of operator-observed 16O live drill.
 * Does not deploy. Does not claim human inbox, organic alert fire, production,
 * abrupt paths, retention/search, dependency failure, real-PG contention, or
 * completion logging.
 */

const path = require('path');

const MASTER_BASIS = '594247f12a823e9b90140c56eb8645b057e1fd37';
const SLICE = 'RADAR-16P';
const OUTCOME_ID = '16P_live_drill_evidence_reconciliation';
const GATE_ID = 'G08_retention_privacy';
const PROGRESS_CLASS = 'partial_live_proven_evidence_only';
const BRANCH = 'radar/slice-16p-live-drill-evidence';

const EVIDENCE_REL = 'fixtures/radar-operations/slice16p-live-drill-evidence.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16p-expected-contract.json';

const IMAGE_SHA_SHORT = '594247f';
const IMAGE_SHA_FULL = MASTER_BASIS;

const WH_DEPLOY_REV = '0000514';
const WH_ROLLBACK_REV = '0000515';
const WH_ROLLFORWARD_REV = '0000516';
const SUNSET_DEPLOY_REV = '0000274';
const SUNSET_ROLLBACK_REV = '0000275';
const SUNSET_ROLLFORWARD_REV = '0000276';

const AG_WH = Object.freeze({
  email_status: 'Succeeded',
  state: 'Complete',
  sent_utc: '2026-07-20T21:35:00.5549824Z',
  completed_utc: '2026-07-20T21:38:26.1342044Z',
});

const AG_SUNSET = Object.freeze({
  email_status: 'Succeeded',
  state: 'Complete',
  sent_utc: '2026-07-20T21:39:53.8402179Z',
  completed_utc: '2026-07-20T21:43:16.2619454Z',
});

const WEBHOOK_GENERIC = Object.freeze([
  'malformed_signature',
  'missing_signature',
  'oversize_body',
]);

const EXPLICITLY_NOT_CLAIMED = Object.freeze([
  'human_inbox_receipt',
  'organic_metric_alert_firing',
  'production',
  'abrupt_paths',
  'retention_search',
  'dependency_failure',
  'real_pg_contention',
  'completion_logging',
]);

const LIVE_PROVEN_GATES = Object.freeze([
  'G02_readiness_dependencies',
  'G03_actionable_tenant_aware_alerts',
  'G07_rollback_incident_runbooks',
  'G08_retention_privacy',
  'G09_cost_controls',
]);

const SOURCE_PARTIAL_GATES = Object.freeze([
  'G01_correlation_structured_logs',
  'G04_webhook_payment_worker_backlog',
  'G05_retry_replay_safety',
  'G06_scaling_capacity',
]);

const OWNED_RELS = Object.freeze([
  EVIDENCE_REL,
  CONTRACT_REL,
  'scripts/lib/radar-slice16p-live-drill-evidence.js',
  'scripts/verify-radar-slice16p-live-drill-evidence.js',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
]);

const MUST_NOT_MUTATE = Object.freeze([
  'database/',
  'docker/hermes-staging/',
  'scripts/staff-query-api.js',
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
  IMAGE_SHA_SHORT,
  IMAGE_SHA_FULL,
  WH_DEPLOY_REV,
  WH_ROLLBACK_REV,
  WH_ROLLFORWARD_REV,
  SUNSET_DEPLOY_REV,
  SUNSET_ROLLBACK_REV,
  SUNSET_ROLLFORWARD_REV,
  AG_WH,
  AG_SUNSET,
  WEBHOOK_GENERIC,
  EXPLICITLY_NOT_CLAIMED,
  LIVE_PROVEN_GATES,
  SOURCE_PARTIAL_GATES,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
