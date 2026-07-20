'use strict';

/**
 * radar-slice16j-staff-request-correlation — RADAR Slice 16J locks.
 *
 * Source-partial progress only: Staff API HTTP request correlation
 * (header + AsyncLocalStorage). Supersedes deferred 16D. No completion
 * logging / lifecycle listeners / async queue / signal-shutdown ownership.
 * No live deploy. Request completion logs / delivery / search / retention /
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

const MUST_NOT_OWN = Object.freeze([
  'async_log_queue',
  'signal_shutdown_handlers',
  'exit_code_mutation',
  'flush_delivery_guarantee',
  'req_res_lifecycle_listeners',
  'completion_console_emission',
  'duration_route_status_logging',
  'one_record_completion_claim',
]);

/** Base (master) router catch semantic body — preserve except correlation wrapper indent. */
const BASE_ROUTER_CATCH_SEMANTIC = [
  '} catch (err) {',
  '// Do not expose stack trace to client',
  "sendJSON(res, 500, { success: false, error: 'internal server error' });",
  '}',
].join('\n');

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
  UUID_V4_PATTERN,
  STAFF_API_REL,
  CORRELATION_LIB_REL,
  OWNED_RELS,
  MUST_NOT_OWN,
  BASE_ROUTER_CATCH_SEMANTIC,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
