'use strict';

/**
 * radar-slice16n-staff-request-completion-log — RADAR Slice 16N locks.
 *
 * Source-partial progress only: safe synchronous normal-completion structured
 * request logs for Staff API at createStaffQueryApiHttpServer (builds on 16J ALS).
 * No lifecycle listeners, no signal/shutdown ownership, no live deploy.
 * Deployment / Azure stdout delivery / searchable query / retention /
 * abrupt-path coverage / drill remain open.
 */

const path = require('path');

const MASTER_BASIS = '3e94498321cd26e64394984a5926d7a583226692';
const SLICE = 'RADAR-16N';
const OUTCOME_ID = '16N_staff_api_request_completion_log';
const GATE_ID = 'G01_correlation_structured_logs';
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16n-request-completion-log';

const EVENT_NAME = 'staff_api_request_completed';
const DURATION_MS_BUCKET = 5;
const DURATION_MS_CAP = 300000;

const STAFF_API_REL = 'scripts/staff-query-api.js';
const COMPLETION_LIB_REL = 'scripts/lib/staff-api-request-completion-log.js';
const CORRELATION_LIB_REL = 'scripts/lib/staff-api-request-correlation.js';

const OWNED_RELS = Object.freeze([
  COMPLETION_LIB_REL,
  STAFF_API_REL,
  'scripts/lib/radar-slice16n-staff-request-completion-log.js',
  'scripts/verify-radar-slice16n-staff-request-completion-log.js',
  'fixtures/radar-operations/slice16n-expected-contract.json',
]);

const MUST_NOT_OWN = Object.freeze([
  'req_res_lifecycle_listeners',
  'async_log_queue',
  'signal_shutdown_handlers',
  'exit_code_mutation',
  'flush_delivery_guarantee',
  'abrupt_process_socket_termination_capture',
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
  'duration_ms',
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
  EXCLUSIONS,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
