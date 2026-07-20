'use strict';

/**
 * radar-slice16r-staff-request-completion-log — RADAR Slice 16R locks.
 *
 * Source-partial progress only: one bounded Staff API request-completion record
 * per real HTTP request on finish/close/error settlement (extends 16J ALS).
 * No signal/shutdown/queue ownership. No live deploy. Delivery / search /
 * retention / drill remain open.
 */

const path = require('path');

const MASTER_BASIS = '06b7a3f2173863afa81bfc557cd31cbd3e80d6c1';
const SLICE = 'RADAR-16R';
const OUTCOME_ID = '16R_staff_api_request_completion_log';
const GATE_ID = 'G01_correlation_structured_logs';
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16r-request-completion-log';

const EVENT_NAME = 'staff_api_request_completion';
const DURATION_MS_BUCKET = 5;
const DURATION_MS_CAP = 300000;

const STAFF_API_REL = 'scripts/staff-query-api.js';
const COMPLETION_LIB_REL = 'scripts/lib/staff-api-request-completion-log.js';
const CORRELATION_LIB_REL = 'scripts/lib/staff-api-request-correlation.js';

const OWNED_RELS = Object.freeze([
  COMPLETION_LIB_REL,
  STAFF_API_REL,
  'scripts/lib/radar-slice16r-staff-request-completion-log.js',
  'scripts/verify-radar-slice16r-staff-request-completion-log.js',
  'fixtures/radar-operations/slice16r-expected-contract.json',
]);

const MUST_NOT_OWN = Object.freeze([
  'async_log_queue',
  'signal_shutdown_handlers',
  'exit_code_mutation',
  'flush_delivery_guarantee',
  'live_deploy',
]);

/** Base (master) router catch semantic body — preserve byte-identical. */
const BASE_ROUTER_CATCH_SEMANTIC = [
  '} catch (err) {',
  '// Do not expose stack trace to client',
  "sendJSON(res, 500, { success: false, error: 'internal server error' });",
  '}',
].join('\n');

const BOUNDED_SCHEMA_FIELDS = Object.freeze([
  'event',
  'request_id',
  'tenant_slug',
  'method',
  'route',
  'status_code',
  'status_class',
  'duration_ms',
  'outcome',
]);

const ALLOWED_OUTCOMES = Object.freeze([
  'completed',
  'client_aborted',
  'server_error',
]);

const EXCLUSIONS = Object.freeze([
  'url_query',
  'raw_url',
  'headers',
  'body',
  'guest',
  'customer',
  'name',
  'phone',
  'email',
  'auth',
  'cookie',
  'token',
  'key',
  'stack',
  'error_text',
  'response_body',
  'ip',
  'user_agent',
  'stripe_signature',
  'stripe_payload',
  'secrets',
  'db_error',
  'exception',
]);

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  EVENT_NAME,
  DURATION_MS_BUCKET,
  DURATION_MS_CAP,
  STAFF_API_REL,
  COMPLETION_LIB_REL,
  CORRELATION_LIB_REL,
  OWNED_RELS,
  MUST_NOT_OWN,
  BASE_ROUTER_CATCH_SEMANTIC,
  BOUNDED_SCHEMA_FIELDS,
  ALLOWED_OUTCOMES,
  EXCLUSIONS,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
