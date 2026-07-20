'use strict';

/**
 * radar-slice16j-staff-request-correlation — RADAR Slice 16J locks.
 *
 * Source-partial progress only: Staff API HTTP request correlation + minimal
 * synchronous completion record. Supersedes deferred 16D (no async log queue,
 * no signal/shutdown ownership). No live deploy. Delivery / search / retention /
 * drill remain open.
 */

const path = require('path');

const MASTER_BASIS = 'd9d297e8d28b499316fdcb89ff7954ebb4cdae06';
const SLICE = 'RADAR-16J';
const OUTCOME_ID = '16J_staff_api_request_correlation';
const GATE_ID = 'G01_correlation_structured_logs';
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16j-request-correlation';

const DEFERRED_16D = Object.freeze({
  branch: 'radar/slice-16d-staff-request-correlation',
  tip_sha: '4478ac2ad65d385e4bbf577ebe77c5c80ad028e4',
  policy: 'do_not_merge_do_not_modify',
});

const CORRELATION_HEADER = 'x-request-id';
const CORRELATION_HEADER_CANON = 'X-Request-Id';
const EVENT_NAME = 'staff_api_http_request_complete';
const DURATION_MS_BUCKET = 5;
const UUID_V4_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

const STAFF_API_REL = 'scripts/staff-query-api.js';
const CORRELATION_LIB_REL = 'scripts/lib/staff-api-request-correlation.js';

const OWNED_RELS = Object.freeze([
  CORRELATION_LIB_REL,
  STAFF_API_REL,
  'scripts/lib/radar-slice16j-staff-request-correlation.js',
  'scripts/verify-radar-slice16j-staff-request-correlation.js',
  'fixtures/radar-operations/slice16j-expected-contract.json',
]);

const EVENT_ALLOWED_KEYS = Object.freeze([
  'event',
  'request_id',
  'tenant_slug',
  'method',
  'route',
  'status',
  'duration_ms',
]);

const MUST_NOT_EMIT = Object.freeze([
  'raw_url',
  'query',
  'body',
  'headers',
  'phone',
  'email',
  'name',
  'tokens',
  'stack',
  'error_text',
]);

const MUST_NOT_OWN = Object.freeze([
  'async_log_queue',
  'signal_shutdown_handlers',
  'exit_code_mutation',
  'flush_delivery_guarantee',
]);

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  DEFERRED_16D,
  CORRELATION_HEADER,
  CORRELATION_HEADER_CANON,
  EVENT_NAME,
  DURATION_MS_BUCKET,
  UUID_V4_PATTERN,
  STAFF_API_REL,
  CORRELATION_LIB_REL,
  OWNED_RELS,
  EVENT_ALLOWED_KEYS,
  MUST_NOT_EMIT,
  MUST_NOT_OWN,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
