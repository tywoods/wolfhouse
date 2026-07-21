'use strict';

/**
 * radar-slice16w-readiness-shutdown-lifecycle — RADAR Slice 16W locks.
 *
 * Source-partial G02 progress: wire closeReadinessPool into Staff API graceful
 * shutdown for Wolfhouse + Sunset staging images (shared runtime). No live deploy.
 * Controlled dependency-failure traffic-shed drill remains open.
 */

const path = require('path');

const MASTER_BASIS = 'd904481de6ef8e7ad65d84241577796cbb5ad1c4';
const SLICE = 'RADAR-16W';
const OUTCOME_ID = '16W_readiness_shutdown_lifecycle';
const GATE_ID = 'G02_readiness_dependencies';
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16w-readiness-shutdown-lifecycle';

const STAFF_API_REL = 'scripts/staff-query-api.js';
const READINESS_LIB_REL = 'scripts/lib/staff-api-readiness.js';
const LIFECYCLE_LIB_REL = 'scripts/lib/staff-api-readiness-lifecycle.js';
const WOLFHOUSE_BICEP_REL = 'infra/azure/staging/main.bicep';
const SUNSET_BICEP_REL = 'infra/azure/sunset-staging/main.bicep';

const OWNED_RELS = Object.freeze([
  LIFECYCLE_LIB_REL,
  STAFF_API_REL,
  READINESS_LIB_REL,
  'scripts/lib/radar-slice16w-readiness-shutdown-lifecycle.js',
  'scripts/verify-radar-slice16w-readiness-shutdown-lifecycle.js',
  'fixtures/radar-operations/slice16w-expected-contract.json',
]);

/** Shutdown steps — order is contract-locked. */
const SHUTDOWN_ORDER = Object.freeze([
  'close_readiness_pool',
  'server_close',
  'process_exit',
]);

const REQUIRED_RED = Object.freeze([
  'sigterm_closes_pool_once',
  'sigint_closes_pool_once',
  'pool_close_awaited_before_server_close',
  'pool_close_awaited_before_exit',
  'concurrent_signals_idempotent',
  'factory_reuse_no_duplicate_listeners',
  'no_close_pg_pool_composition',
  'readyz_contract_unchanged',
  'wolfhouse_sunset_shared_runtime',
]);

const REQUIRED_GREEN = Object.freeze([
  'lifecycle_wired_cli_main_only',
  'shutdown_order_preserved',
  'duplicate_attach_rejected',
  'adversarial_missing_pool_await_fails',
  'adversarial_server_before_pool_fails',
]);

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  STAFF_API_REL,
  READINESS_LIB_REL,
  LIFECYCLE_LIB_REL,
  WOLFHOUSE_BICEP_REL,
  SUNSET_BICEP_REL,
  OWNED_RELS,
  SHUTDOWN_ORDER,
  REQUIRED_RED,
  REQUIRED_GREEN,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
