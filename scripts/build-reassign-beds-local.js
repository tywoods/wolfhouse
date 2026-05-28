/**
 * Build n8n/phase3b/Wolfhouse - Reassign Bed Assignments (local PG).json
 *
 * Phase 3b.3b — PG delete all booking_beds → hosted AT reset → PG mirror unassigned → HTTP local Assign.
 * Does NOT modify n8n/Wolfhouse - Reassign Bed Assignments.json (hosted export).
 *
 * Run: npm run build:reassign-beds:local
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  PG_REASSIGN_DELETE_SQL,
  PG_MIRROR_REASSIGN_READY_SQL,
  pgQueryReplacement,
} = require('./lib/reassign-booking-beds-pg-sql');
const {
  PROD_AIRTABLE_BASE_ID,
  TEST_AIRTABLE_BASE_ID,
  verifyNoProdAirtableBase,
  importWorkflowInactive,
  finalizeLocalBedOpsWorkflow,
} = require('./lib/bed-ops-local-build');

const args = process.argv.slice(2);

const HOSTED = path.join(__dirname, '..', 'n8n', 'Wolfhouse - Reassign Bed Assignments.json');
const OUT_DIR = path.join(__dirname, '..', 'n8n', 'phase3b');
const OUT = path.join(OUT_DIR, 'Wolfhouse - Reassign Bed Assignments (local PG).json');
const OUT_IMPORT = path.join(OUT_DIR, 'Wolfhouse - Reassign Bed Assignments (local PG).n8n-import.json');

const LOCAL_N8N = {
  workflowId: 'B3c3ReassignLocal01',
  postgresCred: { id: 'MnnrrLecI7oVoIGq', name: 'Postgres account' },
  airtableCred: { id: 'tEUby6EPDxFQ5st8', name: 'Airtable Personal Access Token account' },
};

const PARSE_NODE = 'Code - Parse Reassign Webhook';
const PG_QUERY_REPLACEMENT = pgQueryReplacement(PARSE_NODE);

/** Default assign webhook from n8n-main container; override via env in E2E. */
/** n8n workers call the main instance by service name (not localhost). Override for host-only tests. */
const ASSIGN_WEBHOOK_URL =
  process.env.N8N_ASSIGN_WEBHOOK_URL ||
  'http://n8n-main:5678/webhook/assign-beds-to-booking';

const HOSTED_NODE_NAMES = [
  'Get Booking To Reassign',
  'Code - Normalize Reassignment Booking',
  'IF - Can Reassign Booking',
  'Code - Prepare Existing Booking Beds To Cancel',
  'Cancel Old Booking Bed',
  'Mark Booking Ready For Reassignment',
  'Update record1',
];

const PARSE_WEBHOOK_JS = `const body = $json.body ?? $json;
const errors = [];

function stripHttpExprPrefix(value) {
  const s = String(value || '').trim();
  if (s.startsWith('=') && !s.startsWith('==')) return s.slice(1).trim();
  return s;
}

let recordId = stripHttpExprPrefix(
  body.record_id ?? body.RecordId ?? body.booking_record_id ?? body.airtable_record_id ?? ''
);
let bookingCode = stripHttpExprPrefix(
  body.booking_code ?? body.BookingCode ?? body['Booking ID'] ?? ''
);

function bookingCodeToRec(code) {
  const s = String(code || '').trim();
  if (!s.startsWith('WH-')) return '';
  const rec = s.slice(3);
  return rec.startsWith('rec') ? rec : '';
}
function recToBookingCode(rec) {
  const s = String(rec || '').trim();
  return s.startsWith('rec') ? 'WH-' + s : '';
}

if (recordId.startsWith('WH-')) {
  const derived = bookingCodeToRec(recordId);
  if (derived) recordId = derived;
  else errors.push('invalid_WH_prefix_record_id');
}
if (!recordId && bookingCode) recordId = bookingCodeToRec(bookingCode);
if (!bookingCode && recordId.startsWith('rec')) bookingCode = recToBookingCode(recordId);

if (!recordId && !bookingCode) {
  return [{
    json: {
      parse_ok: false,
      errors: ['missing_record_id_or_booking_code'],
      airtable_record_id: '',
      record_id: '',
      booking_code: ''
    }
  }];
}
if (recordId && !recordId.startsWith('rec')) {
  return [{
    json: {
      parse_ok: false,
      errors: ['airtable_record_id_must_start_with_rec'],
      airtable_record_id: recordId,
      record_id: recordId,
      booking_code: bookingCode
    }
  }];
}

return [{
  json: {
    parse_ok: true,
    errors: errors.length ? errors : [],
    airtable_record_id: recordId,
    record_id: recordId,
    booking_code: bookingCode
  }
}];`;

const VALIDATE_PG_DELETE_JS = `const parsed = $('${PARSE_NODE}').first().json;
const pgItems = $('Postgres - Delete All Booking Beds').all();
const pgItem = pgItems[0];
const pgErr = pgItem?.error;
const pg = pgItem?.json || {};

if (pgErr) {
  const msg = String(pgErr.message || pgErr);
  return [{
    json: {
      pg_ok: false,
      errors: [msg.includes('no parameter') ? 'postgres_query_param_missing' : 'postgres_reassign_delete_failed'],
      airtable_record_id: parsed.airtable_record_id,
      record_id: parsed.record_id || parsed.airtable_record_id,
      booking_code: parsed.booking_code,
      pg_deleted_count: 0,
      partial_failure: 'pg_query_failed',
      message: msg
    }
  }];
}

const resolved = Number(pg.booking_rows_resolved ?? 0);
if (resolved !== 1) {
  return [{
    json: {
      pg_ok: false,
      errors: [resolved === 0 ? 'booking_not_found_in_postgres' : 'booking_ambiguous_in_postgres'],
      airtable_record_id: parsed.airtable_record_id,
      record_id: parsed.record_id || parsed.airtable_record_id,
      booking_code: parsed.booking_code,
      pg_deleted_count: 0,
      partial_failure: 'pg_resolve_failed',
      message: 'Postgres could not resolve exactly one booking — Airtable reset skipped'
    }
  }];
}

const errors = [];
const before = String(pg.payment_status_before || '');
const after = String(pg.payment_status_after || '');
if (before && after && before !== after) {
  errors.push('payment_status_changed_during_pg_reassign_delete');
}

return [{
  json: {
    pg_ok: true,
    errors,
    ...pg,
    airtable_record_id: parsed.airtable_record_id,
    record_id: parsed.record_id || parsed.airtable_record_id,
    booking_code: pg.booking_code || parsed.booking_code,
    pg_deleted_count: Number(pg.pg_deleted_count ?? 0)
  }
}];`;

const PARSE_ASSIGN_HTTP_JS = `const http = $('HTTP Request - Trigger Local Assign').first();
if (http?.error) {
  return [{
    json: {
      assign_parse_ok: false,
      assign_http_error: String(http.error.message || http.error),
      assign_response: {}
    }
  }];
}

let body = http?.json;
if (body == null) {
  return [{
    json: {
      assign_parse_ok: false,
      assign_http_error: 'assign_http_empty_response',
      assign_response: {}
    }
  }];
}

if (typeof body === 'string') {
  try {
    body = JSON.parse(body);
  } catch (e) {
    return [{
      json: {
        assign_parse_ok: false,
        assign_http_error: 'assign_http_non_json',
        assign_response: { raw: body }
      }
    }];
  }
}

if (body.body !== undefined) {
  body = typeof body.body === 'string' ? JSON.parse(body.body) : body.body;
}
if (Array.isArray(body)) body = body[0] || {};

return [{
  json: {
    assign_parse_ok: true,
    assign_http_error: null,
    assign_response: body && typeof body === 'object' ? body : {}
  }
}];`;

const VALIDATE_PG_MIRROR_JS = `const parsed = $('${PARSE_NODE}').first().json;
const pgItems = $('Postgres - Mirror Reassign Ready Status').all();
const pgItem = pgItems[0];
const pgErr = pgItem?.error;
const pg = pgItem?.json || {};

if (pgErr) {
  return [{
    json: {
      pg_mirror_ok: false,
      errors: ['postgres_mirror_reassign_ready_failed'],
      pg_reassign_ready: false,
      message: String(pgErr.message || pgErr)
    }
  }];
}

const readyCount = Number(pg.pg_reassign_ready_count ?? 0);
return [{
  json: {
    pg_mirror_ok: readyCount > 0,
    pg_reassign_ready: readyCount > 0,
    assignment_status_after: pg.assignment_status_after,
    availability_check_status_after: pg.availability_check_status_after,
    errors: readyCount > 0 ? [] : ['pg_reassign_ready_update_zero_rows']
  }
}];`;

const BUILD_RESPONSE_JS = `function mergeErrors(...lists) {
  const out = [];
  for (const list of lists) {
    if (!list) continue;
    for (const e of list) {
      const s = String(e || '').trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

function emptyAssign() {
  return {
    pg_inserted_count: 0,
    pg_skipped_count: 0,
    pg_conflict_count: 0,
    airtable_create_ok: false,
    airtable_update_ok: false,
    assign_ok: false,
    skipped_reason: null
  };
}

const parsed = $('${PARSE_NODE}').first()?.json || {};
const record_id = parsed.record_id || parsed.airtable_record_id || '';

if (!parsed.parse_ok) {
  return [{
    json: {
      ok: false,
      booking_code: parsed.booking_code || '',
      record_id,
      pg_deleted_count: 0,
      pg_reassign_ready: false,
      airtable_delete_ok: false,
      airtable_reset_ok: false,
      assign_triggered: false,
      ...emptyAssign(),
      partial_failure: 'parse_failed',
      idempotent: false,
      errors: mergeErrors(parsed.errors, ['parse_failed']),
      message: 'Invalid webhook payload'
    }
  }];
}

let normalize = null;
try {
  normalize = $('Code - Normalize Reassignment Booking').first()?.json;
} catch (e) {}

if (normalize && normalize.can_reassign === false) {
  let gateUpd = null;
  try { gateUpd = $('Update record1').first(); } catch (e) {}
  const gateOk = !!(gateUpd?.json?.id || gateUpd?.json?.fields) && !gateUpd?.error;
  return [{
    json: {
      ok: false,
      booking_code: normalize.booking_id || parsed.booking_code || '',
      record_id,
      pg_deleted_count: 0,
      pg_reassign_ready: false,
      airtable_delete_ok: false,
      airtable_reset_ok: gateOk,
      assign_triggered: false,
      ...emptyAssign(),
      partial_failure: 'reassign_gate_failed',
      idempotent: false,
      errors: mergeErrors(normalize.errors, ['can_reassign_false']),
      message: 'Booking failed reassign gate (dates/guest count)'
    }
  }];
}

let validateDelete;
try {
  validateDelete = $('Code - Validate PG Reassign Delete').first().json;
} catch (e) {
  validateDelete = { pg_ok: false, errors: ['validate_pg_delete_not_run'] };
}

if (!validateDelete.pg_ok) {
  return [{
    json: {
      ok: false,
      booking_code: validateDelete.booking_code || parsed.booking_code || '',
      record_id: validateDelete.record_id || record_id,
      pg_deleted_count: Number(validateDelete.pg_deleted_count ?? 0),
      pg_reassign_ready: false,
      airtable_delete_ok: false,
      airtable_reset_ok: false,
      assign_triggered: false,
      ...emptyAssign(),
      partial_failure: validateDelete.partial_failure || 'pg_reset_failed',
      idempotent: false,
      errors: mergeErrors(validateDelete.errors, [validateDelete.message]),
      message: validateDelete.message || 'Postgres reassign delete did not complete'
    }
  }];
}

const pgDeleted = Number(validateDelete.pg_deleted_count ?? 0);

let deleteItems = [];
let markReady = null;
let prep = null;
try { deleteItems = $('Cancel Old Booking Bed').all(); } catch (e) {}
try { markReady = $('Mark Booking Ready For Reassignment').first(); } catch (e) {}
try { prep = $('Code - Prepare Existing Booking Beds To Cancel').first()?.json; } catch (e) {}

const atDeleteErrors = [];
let atDeleteAttempts = 0;
for (const item of deleteItems) {
  if (item.error) {
    atDeleteErrors.push(String(item.error.message || item.error));
    continue;
  }
  atDeleteAttempts += 1;
}
const noBedsInAt = !!prep?.no_booking_beds_found;
const atDeleteOk = atDeleteErrors.length === 0;
const atResetOk =
  !!(markReady?.json?.id || markReady?.json?.fields) && !markReady?.error && !markReady?.json?.error;

let mirror = { pg_reassign_ready: false, pg_mirror_ok: false, errors: [] };
try {
  mirror = $('Code - Validate PG Reassign Mirror').first().json;
} catch (e) {
  mirror.errors = ['validate_pg_mirror_not_run'];
}

const pgReassignReady = mirror.pg_reassign_ready === true;

let assign = emptyAssign();
let assignTriggered = false;
let assignHttpError = null;
try {
  const parsedAssign = $('Code - Parse Assign HTTP Response').first()?.json || {};
  assignTriggered = !parsedAssign.assign_http_error || !!parsedAssign.assign_response;
  if (parsedAssign.assign_http_error) {
    assignHttpError = parsedAssign.assign_http_error;
  }
  const body = parsedAssign.assign_response || {};
  assign = {
    pg_inserted_count: Number(body.pg_inserted_count ?? 0),
    pg_skipped_count: Number(body.pg_skipped_count ?? 0),
    pg_conflict_count: Number(body.pg_conflict_count ?? 0),
    airtable_create_ok: body.airtable_create_ok === true,
    airtable_update_ok: body.airtable_update_ok === true,
    assign_ok: body.ok === true,
    skipped_reason: body.skipped_reason || null,
    assign_partial_failure: body.partial_failure || null,
    assign_errors: body.errors || []
  };
} catch (e) {
  assignHttpError = 'assign_http_not_run';
}

const errors = mergeErrors(
  validateDelete.errors,
  mirror.errors,
  atDeleteErrors,
  assign.assign_errors,
  assignHttpError ? [assignHttpError] : []
);

let partial_failure = null;
if (!atResetOk || !atDeleteOk) {
  partial_failure = 'pg_ok_airtable_reset_failed';
} else if (!pgReassignReady) {
  partial_failure = 'pg_mirror_reassign_ready_failed';
} else if (!assignTriggered) {
  partial_failure = 'assign_not_triggered';
} else if (assignHttpError) {
  partial_failure = 'assign_failed_after_reset';
} else if (assign.skipped_reason) {
  partial_failure = 'assign_skipped_after_reset';
} else if (!assign.assign_ok) {
  partial_failure = assign.assign_partial_failure || 'assign_failed_after_reset';
}

const ok =
  atDeleteOk &&
  atResetOk &&
  pgReassignReady &&
  assignTriggered &&
  assign.assign_ok &&
  !partial_failure;

return [{
  json: {
    ok,
    booking_code: validateDelete.booking_code || parsed.booking_code || '',
    record_id: validateDelete.record_id || record_id,
    pg_deleted_count: pgDeleted,
    pg_reassign_ready: pgReassignReady,
    airtable_delete_ok: atDeleteOk,
    airtable_reset_ok: atResetOk,
    assign_triggered: assignTriggered,
    pg_inserted_count: assign.pg_inserted_count,
    pg_skipped_count: assign.pg_skipped_count,
    pg_conflict_count: assign.pg_conflict_count,
    airtable_create_ok: assign.airtable_create_ok,
    airtable_update_ok: assign.airtable_update_ok,
    partial_failure,
    idempotent: false,
    errors,
    payments_count: Number(validateDelete.payments_count ?? 0),
    no_booking_beds_found_in_at: noBedsInAt,
    at_delete_attempts: atDeleteAttempts,
    skipped_reason: assign.skipped_reason,
    message: ok
      ? 'reassign_complete'
      : partial_failure || 'reassign_incomplete'
  }
}];`;

function uid(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function pickHosted(hosted, name) {
  const n = hosted.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`Hosted node not found: ${name}`);
  const copy = JSON.parse(JSON.stringify(n));
  if (copy.credentials?.airtableTokenApi) {
    copy.credentials.airtableTokenApi = LOCAL_N8N.airtableCred;
  }
  return copy;
}

function main() {
  const hosted = JSON.parse(fs.readFileSync(HOSTED, 'utf8'));
  for (const name of HOSTED_NODE_NAMES) {
    if (!hosted.nodes.some((n) => n.name === name)) {
      throw new Error(`Hosted export missing required node: ${name}`);
    }
  }

  const xShift = 400;
  const getBooking = pickHosted(hosted, 'Get Booking To Reassign');
  getBooking.position = [getBooking.position[0] + xShift, getBooking.position[1]];
  getBooking.parameters.id = `={{ $('${PARSE_NODE}').first().json.airtable_record_id }}`;

  const normalize = pickHosted(hosted, 'Code - Normalize Reassignment Booking');
  normalize.position = [normalize.position[0] + xShift, normalize.position[1]];

  const ifCanReassign = pickHosted(hosted, 'IF - Can Reassign Booking');
  ifCanReassign.position = [ifCanReassign.position[0] + xShift, ifCanReassign.position[1]];

  const prepareBeds = pickHosted(hosted, 'Code - Prepare Existing Booking Beds To Cancel');
  prepareBeds.position = [prepareBeds.position[0] + xShift, prepareBeds.position[1]];

  const cancelBed = pickHosted(hosted, 'Cancel Old Booking Bed');
  cancelBed.position = [cancelBed.position[0] + xShift, cancelBed.position[1]];
  cancelBed.continueOnFail = true;
  cancelBed.alwaysOutputData = true;

  const markReady = pickHosted(hosted, 'Mark Booking Ready For Reassignment');
  markReady.position = [markReady.position[0] + xShift, markReady.position[1]];
  markReady.continueOnFail = true;
  markReady.alwaysOutputData = true;

  const updateGateFail = pickHosted(hosted, 'Update record1');
  updateGateFail.position = [updateGateFail.position[0] + xShift, updateGateFail.position[1] + 200];
  updateGateFail.continueOnFail = true;
  updateGateFail.alwaysOutputData = true;

  const workflow = {
    name: 'Wolfhouse - Reassign Bed Assignments (local PG)',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'reassign-booking-beds',
          responseMode: 'responseNode',
          options: {},
        },
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2.1,
        position: [-80, -96],
        id: uid('webhook-reassign-beds-local'),
        name: 'Reassign Booking Beds - Webhook',
        webhookId: '3b3c0001-0001-4000-8000-000000000003',
      },
      {
        parameters: { jsCode: PARSE_WEBHOOK_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [80, -96],
        id: uid('parse-reassign-webhook'),
        name: PARSE_NODE,
      },
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [
              {
                id: 'parse-ok',
                leftValue: '={{ $json.parse_ok }}',
                rightValue: '',
                operator: { type: 'boolean', operation: 'true', singleValue: true },
              },
            ],
            combinator: 'and',
          },
          options: {},
        },
        type: 'n8n-nodes-base.if',
        typeVersion: 2.2,
        position: [240, -96],
        id: uid('if-parse-ok-reassign'),
        name: 'IF - Parse OK',
      },
      getBooking,
      normalize,
      ifCanReassign,
      {
        parameters: {
          operation: 'executeQuery',
          query: PG_REASSIGN_DELETE_SQL,
          options: { queryReplacement: PG_QUERY_REPLACEMENT },
        },
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [880, -96],
        id: uid('postgres-reassign-delete'),
        name: 'Postgres - Delete All Booking Beds',
        alwaysOutputData: true,
        continueOnFail: true,
        onError: 'continueRegularOutput',
        credentials: { postgres: LOCAL_N8N.postgresCred },
      },
      {
        parameters: { jsCode: VALIDATE_PG_DELETE_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1040, -96],
        id: uid('validate-pg-reassign-delete'),
        name: 'Code - Validate PG Reassign Delete',
      },
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [
              {
                id: 'pg-delete-ok',
                leftValue: '={{ $json.pg_ok }}',
                rightValue: '',
                operator: { type: 'boolean', operation: 'true', singleValue: true },
              },
            ],
            combinator: 'and',
          },
          options: {},
        },
        type: 'n8n-nodes-base.if',
        typeVersion: 2.2,
        position: [1200, -96],
        id: uid('if-pg-delete-ok'),
        name: 'IF - PG Delete OK',
      },
      prepareBeds,
      cancelBed,
      markReady,
      {
        parameters: {
          operation: 'executeQuery',
          query: PG_MIRROR_REASSIGN_READY_SQL,
          options: { queryReplacement: PG_QUERY_REPLACEMENT },
        },
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [1680, -96],
        id: uid('postgres-mirror-reassign-ready'),
        name: 'Postgres - Mirror Reassign Ready Status',
        alwaysOutputData: true,
        continueOnFail: true,
        onError: 'continueRegularOutput',
        credentials: { postgres: LOCAL_N8N.postgresCred },
      },
      {
        parameters: { jsCode: VALIDATE_PG_MIRROR_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1840, -96],
        id: uid('validate-pg-reassign-mirror'),
        name: 'Code - Validate PG Reassign Mirror',
      },
      {
        parameters: {
          method: 'POST',
          url: ASSIGN_WEBHOOK_URL,
          sendBody: true,
          specifyBody: 'json',
          jsonBody: `={{ JSON.stringify({ record_id: $('${PARSE_NODE}').first().json.airtable_record_id, booking_code: $('${PARSE_NODE}').first().json.booking_code || undefined }) }}`,
          options: { timeout: 120000, response: { response: { fullResponse: false, neverError: true } } },
        },
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [2080, -96],
        id: uid('http-trigger-local-assign'),
        name: 'HTTP Request - Trigger Local Assign',
        alwaysOutputData: true,
        continueOnFail: true,
        onError: 'continueRegularOutput',
      },
      {
        parameters: { jsCode: PARSE_ASSIGN_HTTP_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [2240, -96],
        id: uid('parse-assign-http-response'),
        name: 'Code - Parse Assign HTTP Response',
      },
      updateGateFail,
      {
        parameters: { jsCode: BUILD_RESPONSE_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [2400, -96],
        id: uid('build-reassign-response'),
        name: 'Code - Build Reassign Response',
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ $json }}',
          options: {},
        },
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [2580, -96],
        id: uid('respond-reassign-webhook'),
        name: 'Respond to Webhook',
      },
    ],
    connections: {
      'Reassign Booking Beds - Webhook': {
        main: [[{ node: PARSE_NODE, type: 'main', index: 0 }]],
      },
      'Code - Parse Reassign Webhook': {
        main: [[{ node: 'IF - Parse OK', type: 'main', index: 0 }]],
      },
      'IF - Parse OK': {
        main: [
          [{ node: 'Get Booking To Reassign', type: 'main', index: 0 }],
          [{ node: 'Code - Build Reassign Response', type: 'main', index: 0 }],
        ],
      },
      'Get Booking To Reassign': {
        main: [[{ node: 'Code - Normalize Reassignment Booking', type: 'main', index: 0 }]],
      },
      'Code - Normalize Reassignment Booking': {
        main: [[{ node: 'IF - Can Reassign Booking', type: 'main', index: 0 }]],
      },
      'IF - Can Reassign Booking': {
        main: [
          [{ node: 'Postgres - Delete All Booking Beds', type: 'main', index: 0 }],
          [{ node: 'Update record1', type: 'main', index: 0 }],
        ],
      },
      'Update record1': {
        main: [[{ node: 'Code - Build Reassign Response', type: 'main', index: 0 }]],
      },
      'Postgres - Delete All Booking Beds': {
        main: [[{ node: 'Code - Validate PG Reassign Delete', type: 'main', index: 0 }]],
      },
      'Code - Validate PG Reassign Delete': {
        main: [[{ node: 'IF - PG Delete OK', type: 'main', index: 0 }]],
      },
      'IF - PG Delete OK': {
        main: [
          [{ node: 'Code - Prepare Existing Booking Beds To Cancel', type: 'main', index: 0 }],
          [{ node: 'Code - Build Reassign Response', type: 'main', index: 0 }],
        ],
      },
      'Code - Prepare Existing Booking Beds To Cancel': {
        main: [[{ node: 'Cancel Old Booking Bed', type: 'main', index: 0 }]],
      },
      'Cancel Old Booking Bed': {
        main: [[{ node: 'Mark Booking Ready For Reassignment', type: 'main', index: 0 }]],
      },
      'Mark Booking Ready For Reassignment': {
        main: [[{ node: 'Postgres - Mirror Reassign Ready Status', type: 'main', index: 0 }]],
      },
      'Postgres - Mirror Reassign Ready Status': {
        main: [[{ node: 'Code - Validate PG Reassign Mirror', type: 'main', index: 0 }]],
      },
      'Code - Validate PG Reassign Mirror': {
        main: [[{ node: 'HTTP Request - Trigger Local Assign', type: 'main', index: 0 }]],
      },
      'HTTP Request - Trigger Local Assign': {
        main: [[{ node: 'Code - Parse Assign HTTP Response', type: 'main', index: 0 }]],
      },
      'Code - Parse Assign HTTP Response': {
        main: [[{ node: 'Code - Build Reassign Response', type: 'main', index: 0 }]],
      },
      'Code - Build Reassign Response': {
        main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]],
      },
    },
    pinData: {},
    id: LOCAL_N8N.workflowId,
    settings: { executionOrder: 'v1', binaryMode: 'separate' },
    tags: [{ name: 'phase3b' }, { name: 'local-only' }],
  };

  const { workflow: finalized, baseReplacements } = finalizeLocalBedOpsWorkflow(workflow, {
    workflowId: LOCAL_N8N.workflowId,
    active: false,
  });
  if (baseReplacements === 0) {
    console.warn(
      `WARN: no prod Airtable base IDs (${PROD_AIRTABLE_BASE_ID}) found in hosted nodes — neutralization may be a no-op`,
    );
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(finalized, null, 2) + '\n');
  fs.writeFileSync(OUT_IMPORT, JSON.stringify([finalized], null, 2) + '\n');
  console.log(`Wrote ${OUT}`);
  console.log(`Wrote ${OUT_IMPORT} (stable id ${LOCAL_N8N.workflowId})`);
  console.log(
    `Airtable base neutralized: ${baseReplacements} replacement(s) (${PROD_AIRTABLE_BASE_ID} → ${TEST_AIRTABLE_BASE_ID})`,
  );
  console.log(`workflow.active: ${finalized.active}`);
  console.log(`Assign webhook URL (HTTP node): ${ASSIGN_WEBHOOK_URL}`);
  console.log(`Nodes: ${finalized.nodes.length}`);

  const verify = verifyNoProdAirtableBase(finalized);
  if (!verify.ok) {
    console.error(`FAIL: prod Airtable base still in nodes: ${verify.prodBaseNodes.join(', ')}`);
    process.exit(1);
  }
  console.log('OK: no prod Airtable base in generated workflow');

  if (args.includes('--import-inactive')) {
    importWorkflowInactive(OUT_IMPORT, 'b3-reassign-local-import.json');
  }

  console.log('Import into local n8n only. Deactivate hosted Reassign on same path.');
}

if (args.includes('--verify-targets')) {
  if (!fs.existsSync(OUT)) {
    console.error(`Generated workflow not found: ${OUT}`);
    console.error('Run: npm run build:reassign-beds:local first.');
    process.exit(1);
  }
  const wf = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const verify = verifyNoProdAirtableBase(wf);
  console.log(`File: ${OUT}`);
  console.log(`workflow.active: ${wf.active}`);
  console.log(`workflow.id: ${wf.id}`);
  if (verify.ok) {
    console.log('OK: no prod Airtable base hits');
    process.exit(0);
  }
  console.error(`FAIL: prod base in ${verify.prodBaseHitCount} node(s): ${verify.prodBaseNodes.join(', ')}`);
  process.exit(1);
} else {
  main();
}
