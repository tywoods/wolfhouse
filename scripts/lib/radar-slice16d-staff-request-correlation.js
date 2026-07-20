'use strict';

/**
 * radar-slice16d-staff-request-correlation — RADAR Slice 16D locks.
 *
 * Source-partial progress only: Staff API HTTP request correlation + structured
 * completion event. No live deploy. Log-query / e2e Meta→Hermes→Staff→Stripe
 * correlation proof remains open.
 */

const MASTER_BASIS = 'acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b';
const SLICE = 'RADAR-16D';
const OUTCOME_ID = '16D_staff_api_request_correlation';
const GATE_ID = 'G01_correlation_structured_logs';
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16d-staff-request-correlation';

const CORRELATION_HEADER = 'x-request-id';
const CORRELATION_HEADER_CANON = 'X-Request-Id';
const EVENT_NAME = 'staff_api_http_request_complete';

const STAFF_API_REL = 'scripts/staff-query-api.js';
const CORRELATION_LIB_REL = 'scripts/lib/staff-api-request-correlation.js';

const OWNED_RELS = Object.freeze([
  CORRELATION_LIB_REL,
  STAFF_API_REL,
  'scripts/lib/radar-slice16d-staff-request-correlation.js',
  'scripts/verify-radar-slice16d-staff-request-correlation.js',
  'fixtures/radar-operations/slice16d-expected-contract.json',
]);

const EVENT_ALLOWED_KEYS = Object.freeze([
  'event',
  'correlation_id',
  'method',
  'route_class',
  'status',
  'duration_ms',
  'client_slug',
  'location_id',
  'error_class',
]);

const MUST_NOT_EMIT = Object.freeze([
  'raw_url',
  'query',
  'body',
  'headers',
  'guest_data',
  'credentials',
  'tokens',
  'stack',
  'error_message',
]);

const ROUTE_CLASSIFIER = 'finite_route_template';
const UNKNOWN_ROUTE_CLASS = 'unknown';
const COMPLETION_SINK = 'fifo_one_at_a_time_async_queue';
const OVERFLOW_ACCOUNTING = 'mandatory_structured_drop_count';
const SHUTDOWN_FLUSH = 'server_close_and_process_signals_idempotent';
const TENANT_LOCATION_RULE = 'optional_immutable_process_runtime_scope_at_construction_else_omit';
const SYNTHETIC_NO_RESPONSE_STATUS = 0;

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  CORRELATION_HEADER,
  CORRELATION_HEADER_CANON,
  EVENT_NAME,
  STAFF_API_REL,
  CORRELATION_LIB_REL,
  OWNED_RELS,
  EVENT_ALLOWED_KEYS,
  MUST_NOT_EMIT,
  ROUTE_CLASSIFIER,
  UNKNOWN_ROUTE_CLASS,
  COMPLETION_SINK,
  OVERFLOW_ACCOUNTING,
  SHUTDOWN_FLUSH,
  TENANT_LOCATION_RULE,
  SYNTHETIC_NO_RESPONSE_STATUS,
  rootJoin(...parts) {
    const path = require('path');
    return path.join(__dirname, '..', '..', ...parts);
  },
};
