'use strict';

/**
 * radar-slice16y-shutdown-completion-log — RADAR Slice 16Y locks.
 *
 * Source-partial G02 observability: one bounded non-sensitive shutdown completion
 * record per Staff API readiness shutdown. Enables truthful live SIGTERM lifecycle
 * proof after deploy/drill. Live signal evidence remains open. No live deploy.
 */

const path = require('path');

const MASTER_BASIS = '798a5f26e9aa0376e2993b7d590fc818dfa171f7';
const SLICE = 'RADAR-16Y';
const OUTCOME_ID = '16Y_readiness_shutdown_completion_log';
const GATE_ID = 'G02_readiness_dependencies';
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16y-shutdown-completion-log';

const EVENT_NAME = 'staff_api_readiness_shutdown_completion';

const COMPLETION_LOG_REL = 'scripts/lib/staff-api-readiness-shutdown-completion-log.js';
const LIFECYCLE_LIB_REL = 'scripts/lib/staff-api-readiness-lifecycle.js';
const READINESS_LIB_REL = 'scripts/lib/staff-api-readiness.js';
const STAFF_API_REL = 'scripts/staff-query-api.js';

const OWNED_RELS = Object.freeze([
  COMPLETION_LOG_REL,
  LIFECYCLE_LIB_REL,
  'scripts/lib/radar-slice16y-shutdown-completion-log.js',
  'scripts/verify-radar-slice16y-shutdown-completion-log.js',
  'fixtures/radar-operations/slice16y-expected-contract.json',
]);

const ALLOWED_RECORD_KEYS = Object.freeze([
  'event',
  'original_signal',
  'pool_close_result',
  'server_close_result',
  'failure_classes',
  'completion',
]);

const FORBIDDEN_RECORD_KEYS = Object.freeze([
  'pid',
  'process_id',
  'url',
  'raw_url',
  'path',
  'pathname',
  'secret',
  'token',
  'password',
  'authorization',
  'cookie',
  'stack',
  'message',
  'error',
  'error_message',
  'errorMessage',
  'duration_ms',
  'elapsed_ms',
  'timing',
  'dsn',
  'connection_string',
]);

const ALLOWED_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT']);
const ALLOWED_POOL_RESULTS = Object.freeze(['ok', 'rejected', 'timeout', 'throw']);
const ALLOWED_SERVER_RESULTS = Object.freeze([
  'ok',
  'rejected',
  'timeout',
  'throw',
  'already_closed',
]);

const REQUIRED_RED = Object.freeze([
  'schema_fields_bounded',
  'forbidden_keys_rejected',
  'secret_token_patterns_rejected',
  'pid_timing_url_error_rejected',
  'success_emits_exactly_one',
  'failure_emits_exactly_one_with_classes',
  'same_signal_exactly_one',
  'repeated_signals_exactly_one',
  'mixed_signals_exactly_one',
  'logger_throw_does_not_block_detach',
  'logger_throw_does_not_block_terminate',
  'terminate_throw_no_duplicate_record',
  'default_logger_one_stdout_json_line',
  'injected_logger_supported',
  'emit_before_detach_and_terminate',
  'child_sigterm_success_one_record',
  'child_sigint_success_one_record',
  'child_pool_failure_classification',
  'child_server_failure_classification',
  'child_secret_token_absent_from_stdout',
  'readyz_contract_unchanged',
  'no_close_pg_pool_composition',
  'sixteen_w_semantics_preserved',
]);

const REQUIRED_GREEN = Object.freeze([
  'completion_wired_in_lifecycle',
  'always_emits_on_shutdown',
  'failure_classes_enum_bounded',
  'ledger_source_only_live_open',
  'g02_remains_partial',
  'wolfhouse_sunset_shared_runtime',
]);

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  EVENT_NAME,
  COMPLETION_LOG_REL,
  LIFECYCLE_LIB_REL,
  READINESS_LIB_REL,
  STAFF_API_REL,
  OWNED_RELS,
  ALLOWED_RECORD_KEYS,
  FORBIDDEN_RECORD_KEYS,
  ALLOWED_SIGNALS,
  ALLOWED_POOL_RESULTS,
  ALLOWED_SERVER_RESULTS,
  REQUIRED_RED,
  REQUIRED_GREEN,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
