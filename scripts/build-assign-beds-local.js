/**
 * Build n8n/phase3b/Wolfhouse - Bed Assignment (local PG).json
 *
 * Phase 3b.2c — Postgres assign (3b.2b logic) then hosted Airtable create/update nodes.
 * Does NOT modify n8n/Wolfhouse - Bed Assignment.json (hosted export).
 *
 * Run: npm run build:assign-beds:local
 *
 * Keep SQL in sync with scripts/lib/assign-booking-beds-pg-sql.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  PG_ASSIGN_SQL,
  PG_CONFLICT_MIRROR_SQL,
  PG_BACKFILL_AIRTABLE_IDS_SQL,
  PG_MIRROR_ASSIGNED_SQL,
} = require('./lib/assign-booking-beds-pg-sql');
const {
  PROD_AIRTABLE_BASE_ID,
  TEST_AIRTABLE_BASE_ID,
  verifyNoProdAirtableBase,
  importWorkflowInactive,
  finalizeLocalBedOpsWorkflow,
} = require('./lib/bed-ops-local-build');

const args = process.argv.slice(2);

const HOSTED = path.join(__dirname, '..', 'n8n', 'Wolfhouse - Bed Assignment.json');
const OUT_DIR = path.join(__dirname, '..', 'n8n', 'phase3b');
const OUT = path.join(OUT_DIR, 'Wolfhouse - Bed Assignment (local PG).json');
const OUT_IMPORT = path.join(OUT_DIR, 'Wolfhouse - Bed Assignment (local PG).n8n-import.json');

const LOCAL_N8N = {
  workflowId: 'B3c2AssignLocalPg01',
  postgresCred: { id: 'MnnrrLecI7oVoIGq', name: 'Postgres account' },
  airtableCred: { id: 'tEUby6EPDxFQ5st8', name: 'Airtable Personal Access Token account' },
};

const NULL_SENTINEL = '__NULL__';

const HOSTED_NODE_NAMES = [
  'Get Booking',
  'IF - Needs Bed Assignment',
  'Update Booking - Mark Assigning',
  'Search Active Beds',
  'Search Existing Bed Assignments',
  'Search Rooms',
  'Code - Choose Beds',
  'IF - Bed Assignment Conflict',
  'Create Booking Bed Assignment',
  'Update Booking Assignment Status',
  'Update Booking Assignment Status - Conflict',
];

const PARSE_WEBHOOK_JS = `const body = $json.body ?? $json;
const errors = [];
let recordId = String(
  body.record_id ?? body.RecordId ?? body.booking_record_id ?? body.airtable_record_id ?? ''
).trim();
let bookingCode = String(
  body.booking_code ?? body.BookingCode ?? body['Booking ID'] ?? ''
).trim();

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

const BUILD_BEDS_JSON_JS = `const items = $('Code - Choose Beds').all();
const beds = [];
for (const item of items) {
  const j = item.json || {};
  if (!j.bed_id && !j.bed_record_id) continue;
  const bedCode = String(j.bed_id || '').trim().toUpperCase();
  if (!bedCode) continue;
  beds.push({
    bed_code: bedCode,
    assignment_start_date: j.check_in,
    assignment_end_date: j.check_out,
    assignment_type: j.assignment_type || 'Auto Assigned'
  });
}
const parsed = $('Code - Parse Assign Webhook').first().json;
const booking = $('Get Booking').first().json;
const fields = booking.fields || booking;
const bookingCode = fields['Booking ID'] || parsed.booking_code || '';
return [{
  json: {
    beds_json: JSON.stringify(beds),
    beds_count: beds.length,
    airtable_record_id: parsed.airtable_record_id,
    booking_code: bookingCode,
    record_id: parsed.record_id || parsed.airtable_record_id
  }
}];`;

const VALIDATE_PG_ASSIGN_JS = `const parsed = $('Code - Parse Assign Webhook').first().json;
const pgItems = $('Postgres - Assign Beds In Postgres').all();
const pgItem = pgItems[0];
const pgErr = pgItem?.error;
const pg = pgItem?.json || {};

if (pgErr) {
  const msg = String(pgErr.message || pgErr);
  return [{
    json: {
      pg_ok: false,
      errors: [msg.includes('no parameter') ? 'postgres_query_param_missing' : 'postgres_assign_failed'],
      record_id: parsed.record_id,
      booking_code: parsed.booking_code,
      pg_inserted_count: 0,
      pg_skipped_count: 0,
      pg_conflict_count: 0,
      partial_failure: 'pg_query_failed',
      message: msg
    }
  }];
}

const resolved = Number(pg.booking_rows_resolved ?? 0);
const errors = [];

if (resolved !== 1) {
  errors.push(resolved === 0 ? 'booking_not_found_in_postgres' : 'booking_ambiguous_in_postgres');
}
if (Number(pg.pg_unknown_count ?? 0) > 0) {
  errors.push('unknown_bed_codes_in_postgres');
}
if (Number(pg.pg_conflict_count ?? 0) > 0) {
  errors.push('postgres_overlap_conflicts');
}
const before = String(pg.payment_status_before || '');
const after = String(pg.payment_status_after || '');
if (before && after && before !== after) {
  errors.push('payment_status_changed_during_pg_assign');
}
if (Number(pg.payments_count_before ?? 0) !== Number(pg.payments_count_after ?? 0)) {
  errors.push('payments_count_changed_during_pg_assign');
}

const pgOk = pg.pg_ok === true && errors.length === 0;

return [{
  json: {
    pg_ok: pgOk,
    errors,
    ...pg,
    record_id: parsed.record_id || parsed.airtable_record_id,
    booking_code: pg.booking_code || parsed.booking_code,
    pg_inserted_count: Number(pg.pg_inserted_count ?? 0),
    pg_skipped_count: Number(pg.pg_skipped_count ?? 0),
    pg_conflict_count: Number(pg.pg_conflict_count ?? 0),
    partial_failure: pgOk ? null : (Number(pg.pg_conflict_count) > 0 ? 'postgres_overlap_conflicts' : 'pg_assign_failed'),
    message: pgOk ? 'postgres_assign_ok' : errors.join('; ')
  }
}];`;

const BACKFILL_JS = `const parsed = $('Code - Parse Assign Webhook').first().json;
const chosen = $('Code - Choose Beds').all();
const creates = $('Create Booking Bed Assignment').all();
const pairs = [];

for (const createItem of creates) {
  if (createItem.error) continue;
  const atId = createItem.json?.id;
  if (!atId) continue;
  const bedRec = createItem.json?.fields?.Bed;
  const bedRecordId = Array.isArray(bedRec) ? bedRec[0] : bedRec;
  const match = chosen.find((c) => c.json?.bed_record_id === bedRecordId);
  const bedCode = String(match?.json?.bed_id || '').trim().toUpperCase();
  if (!bedCode) continue;
  pairs.push({ bed_code: bedCode, airtable_record_id: atId });
}

return [{
  json: {
    pairs_json: JSON.stringify(pairs),
    pair_count: pairs.length,
    airtable_record_id: parsed.airtable_record_id,
    booking_code: $('Code - Build PG Beds JSON').first().json.booking_code || parsed.booking_code,
    record_id: parsed.record_id || parsed.airtable_record_id
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

const parsed = $('Code - Parse Assign Webhook').first()?.json || {};
const record_id = parsed.record_id || parsed.airtable_record_id || '';

if (!parsed.parse_ok) {
  return [{
    json: {
      ok: false,
      booking_code: parsed.booking_code || '',
      record_id,
      pg_inserted_count: 0,
      pg_skipped_count: 0,
      pg_conflict_count: 0,
      airtable_create_ok: false,
      airtable_update_ok: false,
      partial_failure: 'parse_failed',
      idempotent: false,
      errors: mergeErrors(parsed.errors, ['parse_failed']),
      skipped_reason: null,
      message: 'Invalid webhook payload'
    }
  }];
}

let needsAssign = true;
try {
  const ifNeeds = $('IF - Needs Bed Assignment').first();
  needsAssign = !!ifNeeds;
} catch (e) {}

let chooseBedsRan = false;
try {
  chooseBedsRan = $('Code - Choose Beds').all().length > 0;
} catch (e) {}

let skippedReason = null;
if (!chooseBedsRan) {
  try {
    const booking = $('Get Booking').first()?.json;
    const fields = booking?.fields || booking || {};
    const status = fields['Assignment Status'];
    if (['Assigned', 'Assigning', 'Needs Review'].includes(status)) {
      skippedReason = 'already_assigned_or_ineligible';
    }
    if (['Cancelled', 'Expired'].includes(fields['Status'])) {
      skippedReason = 'booking_cancelled_or_expired';
    }
  } catch (e) {}
}

let conflictBranch = false;
try {
  const conflictIf = $('IF - Bed Assignment Conflict').first();
  const chooseFirst = $('Code - Choose Beds').first()?.json || {};
  conflictBranch =
    chooseFirst.assignment_status === 'Needs Review' ||
    chooseFirst.availability_check_status === 'Conflict';
} catch (e) {}

if (skippedReason) {
  return [{
    json: {
      ok: false,
      booking_code: parsed.booking_code || '',
      record_id,
      pg_inserted_count: 0,
      pg_skipped_count: 0,
      pg_conflict_count: 0,
      airtable_create_ok: false,
      airtable_update_ok: false,
      partial_failure: null,
      idempotent: true,
      errors: [],
      skipped_reason: skippedReason,
      message: 'assign_skipped_' + skippedReason
    }
  }];
}

if (conflictBranch) {
  let pgConflict = {};
  try { pgConflict = $('Postgres - Mirror Assignment Conflict').first()?.json || {}; } catch (e) {}
  let atUpd = null;
  try { atUpd = $('Update Booking Assignment Status - Conflict').first(); } catch (e) {}
  const atUpdateOk = !!(atUpd?.json?.id || atUpd?.json?.fields) && !atUpd?.error;
  return [{
    json: {
      ok: atUpdateOk,
      booking_code: pgConflict.booking_code || parsed.booking_code || '',
      record_id,
      pg_inserted_count: 0,
      pg_skipped_count: 0,
      pg_conflict_count: 1,
      airtable_create_ok: false,
      airtable_update_ok: atUpdateOk,
      partial_failure: atUpdateOk ? null : 'pg_ok_airtable_failed',
      idempotent: false,
      errors: mergeErrors(atUpd?.error ? [String(atUpd.error.message || atUpd.error)] : []),
      skipped_reason: null,
      assignment_conflict: true,
      message: 'assignment_conflict'
    }
  }];
}

let validate = { pg_ok: false, errors: ['validate_pg_assign_not_run'] };
try {
  validate = $('Code - Validate PG Assign').first().json;
} catch (e) {}

const pgInserted = Number(validate.pg_inserted_count ?? 0);
const pgSkipped = Number(validate.pg_skipped_count ?? 0);
const pgConflict = Number(validate.pg_conflict_count ?? 0);

if (!validate.pg_ok) {
  return [{
    json: {
      ok: false,
      booking_code: validate.booking_code || parsed.booking_code || '',
      record_id: validate.record_id || record_id,
      pg_inserted_count: pgInserted,
      pg_skipped_count: pgSkipped,
      pg_conflict_count: pgConflict,
      airtable_create_ok: false,
      airtable_update_ok: false,
      partial_failure: validate.partial_failure || 'pg_failed',
      idempotent: pgInserted === 0 && pgSkipped > 0,
      errors: mergeErrors(validate.errors, [validate.message]),
      skipped_reason: null,
      message: validate.message || 'Postgres assign did not complete — Airtable steps skipped'
    }
  }];
}

let createItems = [];
let upd = null;
try { createItems = $('Create Booking Bed Assignment').all(); } catch (e) {}
try { upd = $('Update Booking Assignment Status').first(); } catch (e) {}

const atCreateErrors = [];
let atCreateAttempts = 0;
for (const item of createItems) {
  if (item.error) {
    atCreateErrors.push(String(item.error.message || item.error));
    continue;
  }
  if (item.json?.id) atCreateAttempts += 1;
}

const atCreateOk = atCreateErrors.length === 0 && atCreateAttempts > 0;
const atUpdateOk = !!(upd?.json?.id || upd?.json?.fields) && !upd?.error;

let partial_failure = null;
if (validate.pg_ok && !atCreateOk) partial_failure = 'pg_ok_airtable_failed';
if (!validate.pg_ok && atCreateOk) partial_failure = 'pg_failed_airtable_ok';

const idempotent = pgInserted === 0 && (pgSkipped > 0 || atCreateAttempts === 0);

return [{
  json: {
    ok: validate.pg_ok && atCreateOk && atUpdateOk && !partial_failure,
    booking_code: validate.booking_code || parsed.booking_code,
    record_id: validate.record_id || record_id,
    pg_inserted_count: pgInserted,
    pg_skipped_count: pgSkipped,
    pg_conflict_count: pgConflict,
    airtable_create_ok: atCreateOk,
    airtable_update_ok: atUpdateOk,
    partial_failure,
    idempotent,
    errors: mergeErrors(validate.errors, atCreateErrors),
    skipped_reason: null,
    message:
      partial_failure === 'pg_ok_airtable_failed'
        ? 'Postgres assign succeeded; Airtable step failed'
        : idempotent
          ? 'assign_beds_idempotent'
          : 'assign_beds_complete'
  }
}];`;

// Stage 3.5d: workflow_events warn log for PG-overlap blocked assign.
// $1 = JSON.stringify(Code - Build PG Overlap Event output json)
const WE_OVERLAP_CONFLICT_SQL = `INSERT INTO workflow_events (
  client_id, workflow_name, node_name, execution_id,
  event_level, message, booking_id, payload
)
SELECT
  c.id,
  ($1::jsonb)->>'workflow_name',
  ($1::jsonb)->>'node_name',
  ($1::jsonb)->>'execution_id',
  'warn'::workflow_event_level,
  'bed_assignment_blocked_overlap',
  NULLIF(($1::jsonb)->>'booking_id', '')::uuid,
  ($1::jsonb)->'payload'
FROM clients c
WHERE c.slug = 'wolfhouse-somo';`;

// Stage 3.5d: JS for Code - Build PG Overlap Event node
const BUILD_PG_OVERLAP_EVENT_JS = [
  "const validate = $('Code - Validate PG Assign').first().json;",
  "const parsed = $('Code - Parse Assign Webhook').first().json;",
  "const bookingId = String(validate.booking_id || '').trim() || null;",
  "const bookingCode = String(validate.booking_code || parsed.booking_code || '').trim();",
  'return [{',
  '  json: {',
  "    workflow_name: 'Wolfhouse - Bed Assignment (local PG)',",
  "    node_name: 'IF - PG Assign OK',",
  "    execution_id: String($execution.id ?? ''),",
  '    booking_id: bookingId,',
  '    payload: {',
  '      booking_code: bookingCode,',
  '      pg_conflict_count: Number(validate.pg_conflict_count || 0),',
  '      pg_unknown_count: Number(validate.pg_unknown_count || 0),',
  '      pg_ok: validate.pg_ok,',
  '      can_mutate: validate.can_mutate,',
  '      beds_requested_count: Number(validate.beds_requested_count || 0),',
  '      errors: validate.errors || [],',
  "      action: 'assign_beds',",
  "      outcome: 'blocked_overlap',",
  "      assignment_status_would_be: 'needs_review',",
  "      availability_check_status_would_be: 'conflict',",
  '    },',
  '  },',
  '}];',
].join('\n');

function pgQueryReplacement(parsedNode, bedsJsonExpr) {
  const rec = `={{ (($('${parsedNode}').first().json.airtable_record_id) != null && String($('${parsedNode}').first().json.airtable_record_id).trim() !== '') ? String($('${parsedNode}').first().json.airtable_record_id).trim() : '${NULL_SENTINEL}' }}`;
  const code = `={{ (($('${parsedNode}').first().json.booking_code) != null && String($('${parsedNode}').first().json.booking_code).trim() !== '') ? String($('${parsedNode}').first().json.booking_code).trim() : '${NULL_SENTINEL}' }}`;
  if (bedsJsonExpr) {
    return `${rec},${code},={{ ${bedsJsonExpr} }}`;
  }
  return `${rec},${code}`;
}

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

function shiftHosted(nodes, xShift = 480) {
  for (const n of nodes) {
    if (n.position) n.position = [n.position[0] + xShift, n.position[1]];
  }
}

function main() {
  const hosted = JSON.parse(fs.readFileSync(HOSTED, 'utf8'));
  for (const name of HOSTED_NODE_NAMES) {
    if (!hosted.nodes.some((n) => n.name === name)) {
      throw new Error(`Hosted export missing required node: ${name}`);
    }
  }

  const hostedNodes = HOSTED_NODE_NAMES.map((name) => pickHosted(hosted, name));
  shiftHosted(hostedNodes);

  const getBooking = hostedNodes.find((n) => n.name === 'Get Booking');
  getBooking.parameters.id =
    "={{ $('Code - Parse Assign Webhook').first().json.airtable_record_id }}";

  const createBeds = hostedNodes.find((n) => n.name === 'Create Booking Bed Assignment');
  createBeds.continueOnFail = true;
  createBeds.alwaysOutputData = true;

  const updateAssigned = hostedNodes.find((n) => n.name === 'Update Booking Assignment Status');
  updateAssigned.continueOnFail = true;
  updateAssigned.alwaysOutputData = true;

  const updateConflict = hostedNodes.find(
    (n) => n.name === 'Update Booking Assignment Status - Conflict'
  );
  updateConflict.continueOnFail = true;
  updateConflict.alwaysOutputData = true;

  const assignQueryReplacement = pgQueryReplacement(
    'Code - Build PG Beds JSON',
    "$('Code - Build PG Beds JSON').first().json.beds_json"
  );
  const parseOnlyReplacement = pgQueryReplacement('Code - Parse Assign Webhook');
  const backfillReplacement = pgQueryReplacement(
    'Code - Backfill PG Airtable IDs',
    "$('Code - Backfill PG Airtable IDs').first().json.pairs_json"
  );

  const workflow = {
    name: 'Wolfhouse - Bed Assignment (local PG)',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'assign-beds-to-booking',
          responseMode: 'responseNode',
          options: {},
        },
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2.1,
        position: [-1900, 0],
        id: uid('webhook-assign-beds-local'),
        name: 'Assign Beds to Booking - Webhook',
        webhookId: '3b2c0001-0002-4000-8000-000000000002',
      },
      {
        parameters: { jsCode: PARSE_WEBHOOK_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [-1720, 0],
        id: uid('parse-assign-webhook'),
        name: 'Code - Parse Assign Webhook',
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
        position: [-1560, 0],
        id: uid('if-parse-ok-assign'),
        name: 'IF - Parse OK',
      },
      getBooking,
      ...hostedNodes.filter((n) => n.name !== 'Get Booking'),
      {
        parameters: { jsCode: BUILD_BEDS_JSON_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [120, 160],
        id: uid('build-pg-beds-json'),
        name: 'Code - Build PG Beds JSON',
      },
      {
        parameters: {
          operation: 'executeQuery',
          query: PG_ASSIGN_SQL,
          options: { queryReplacement: assignQueryReplacement },
        },
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [300, 160],
        id: uid('postgres-assign-beds'),
        name: 'Postgres - Assign Beds In Postgres',
        alwaysOutputData: true,
        continueOnFail: true,
        onError: 'continueRegularOutput',
        credentials: { postgres: LOCAL_N8N.postgresCred },
      },
      {
        parameters: { jsCode: VALIDATE_PG_ASSIGN_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [480, 160],
        id: uid('validate-pg-assign'),
        name: 'Code - Validate PG Assign',
      },
      {
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [
              {
                id: 'pg-ok',
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
        position: [660, 160],
        id: uid('if-pg-assign-ok'),
        name: 'IF - PG Assign OK',
      },
      {
        parameters: {
          operation: 'executeQuery',
          query: PG_CONFLICT_MIRROR_SQL,
          options: { queryReplacement: parseOnlyReplacement },
        },
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [120, -160],
        id: uid('postgres-mirror-conflict'),
        name: 'Postgres - Mirror Assignment Conflict',
        alwaysOutputData: true,
        continueOnFail: true,
        onError: 'continueRegularOutput',
        credentials: { postgres: LOCAL_N8N.postgresCred },
      },
      {
        parameters: { jsCode: BACKFILL_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1020, 160],
        id: uid('backfill-pg-at-ids'),
        name: 'Code - Backfill PG Airtable IDs',
      },
      {
        parameters: {
          operation: 'executeQuery',
          query: PG_BACKFILL_AIRTABLE_IDS_SQL,
          options: { queryReplacement: backfillReplacement },
        },
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [1200, 160],
        id: uid('postgres-backfill-at'),
        name: 'Postgres - Backfill Airtable Record IDs',
        alwaysOutputData: true,
        continueOnFail: true,
        onError: 'continueRegularOutput',
        credentials: { postgres: LOCAL_N8N.postgresCred },
      },
      {
        parameters: {
          operation: 'executeQuery',
          query: PG_MIRROR_ASSIGNED_SQL,
          options: { queryReplacement: parseOnlyReplacement },
        },
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [1380, 160],
        id: uid('postgres-mirror-assigned'),
        name: 'Postgres - Mirror Assignment Assigned',
        alwaysOutputData: true,
        continueOnFail: true,
        onError: 'continueRegularOutput',
        credentials: { postgres: LOCAL_N8N.postgresCred },
      },
      {
        parameters: { jsCode: BUILD_RESPONSE_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1560, 0],
        id: uid('build-assign-response'),
        name: 'Code - Build Assign Response',
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ $json }}',
          options: {},
        },
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [1740, 0],
        id: uid('respond-assign-webhook'),
        name: 'Respond to Webhook',
      },
      // Stage 3.5d: PG-overlap conflict path — log warn + mirror PG status
      {
        parameters: { jsCode: BUILD_PG_OVERLAP_EVENT_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [840, 320],
        id: uid('build-pg-overlap-event'),
        name: 'Code - Build PG Overlap Event',
      },
      {
        parameters: {
          operation: 'executeQuery',
          query: WE_OVERLAP_CONFLICT_SQL,
          options: { queryReplacement: '={{ JSON.stringify($json) }}' },
        },
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [1020, 320],
        id: uid('postgres-write-we-overlap'),
        name: 'Postgres - Write workflow_events (overlap conflict)',
        alwaysOutputData: true,
        continueOnFail: true,
        onError: 'continueRegularOutput',
        credentials: { postgres: LOCAL_N8N.postgresCred },
      },
      {
        parameters: {
          operation: 'executeQuery',
          query: PG_CONFLICT_MIRROR_SQL,
          options: { queryReplacement: parseOnlyReplacement },
        },
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [1200, 320],
        id: uid('postgres-mirror-pg-conflict'),
        name: 'Postgres - Mirror PG Assignment Conflict',
        alwaysOutputData: true,
        continueOnFail: true,
        onError: 'continueRegularOutput',
        credentials: { postgres: LOCAL_N8N.postgresCred },
      },
    ],
    connections: {
      'Assign Beds to Booking - Webhook': {
        main: [[{ node: 'Code - Parse Assign Webhook', type: 'main', index: 0 }]],
      },
      'Code - Parse Assign Webhook': {
        main: [[{ node: 'IF - Parse OK', type: 'main', index: 0 }]],
      },
      'IF - Parse OK': {
        main: [
          [{ node: 'Get Booking', type: 'main', index: 0 }],
          [{ node: 'Code - Build Assign Response', type: 'main', index: 0 }],
        ],
      },
      'Get Booking': {
        main: [[{ node: 'IF - Needs Bed Assignment', type: 'main', index: 0 }]],
      },
      'IF - Needs Bed Assignment': {
        main: [
          [{ node: 'Update Booking - Mark Assigning', type: 'main', index: 0 }],
          [{ node: 'Code - Build Assign Response', type: 'main', index: 0 }],
        ],
      },
      'Update Booking - Mark Assigning': {
        main: [[{ node: 'Search Active Beds', type: 'main', index: 0 }]],
      },
      'Search Active Beds': {
        main: [[{ node: 'Search Existing Bed Assignments', type: 'main', index: 0 }]],
      },
      'Search Existing Bed Assignments': {
        main: [[{ node: 'Search Rooms', type: 'main', index: 0 }]],
      },
      'Search Rooms': {
        main: [[{ node: 'Code - Choose Beds', type: 'main', index: 0 }]],
      },
      'Code - Choose Beds': {
        main: [[{ node: 'IF - Bed Assignment Conflict', type: 'main', index: 0 }]],
      },
      'IF - Bed Assignment Conflict': {
        main: [
          [
            { node: 'Postgres - Mirror Assignment Conflict', type: 'main', index: 0 },
          ],
          [{ node: 'Code - Build PG Beds JSON', type: 'main', index: 0 }],
        ],
      },
      'Postgres - Mirror Assignment Conflict': {
        main: [
          [{ node: 'Update Booking Assignment Status - Conflict', type: 'main', index: 0 }],
        ],
      },
      'Update Booking Assignment Status - Conflict': {
        main: [[{ node: 'Code - Build Assign Response', type: 'main', index: 0 }]],
      },
      'Code - Build PG Beds JSON': {
        main: [[{ node: 'Postgres - Assign Beds In Postgres', type: 'main', index: 0 }]],
      },
      'Postgres - Assign Beds In Postgres': {
        main: [[{ node: 'Code - Validate PG Assign', type: 'main', index: 0 }]],
      },
      'Code - Validate PG Assign': {
        main: [[{ node: 'IF - PG Assign OK', type: 'main', index: 0 }]],
      },
      'IF - PG Assign OK': {
        main: [
          [{ node: 'Create Booking Bed Assignment', type: 'main', index: 0 }],
          // Stage 3.5d: false path now routes through overlap event log + PG mirror
          [{ node: 'Code - Build PG Overlap Event', type: 'main', index: 0 }],
        ],
      },
      // Stage 3.5d: overlap conflict chain
      'Code - Build PG Overlap Event': {
        main: [[{ node: 'Postgres - Write workflow_events (overlap conflict)', type: 'main', index: 0 }]],
      },
      'Postgres - Write workflow_events (overlap conflict)': {
        main: [[{ node: 'Postgres - Mirror PG Assignment Conflict', type: 'main', index: 0 }]],
      },
      'Postgres - Mirror PG Assignment Conflict': {
        main: [[{ node: 'Code - Build Assign Response', type: 'main', index: 0 }]],
      },
      'Create Booking Bed Assignment': {
        main: [[{ node: 'Code - Backfill PG Airtable IDs', type: 'main', index: 0 }]],
      },
      'Code - Backfill PG Airtable IDs': {
        main: [[{ node: 'Postgres - Backfill Airtable Record IDs', type: 'main', index: 0 }]],
      },
      'Postgres - Backfill Airtable Record IDs': {
        main: [[{ node: 'Update Booking Assignment Status', type: 'main', index: 0 }]],
      },
      'Update Booking Assignment Status': {
        main: [[{ node: 'Postgres - Mirror Assignment Assigned', type: 'main', index: 0 }]],
      },
      'Postgres - Mirror Assignment Assigned': {
        main: [[{ node: 'Code - Build Assign Response', type: 'main', index: 0 }]],
      },
      'Code - Build Assign Response': {
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
  console.log(`Wrote ${OUT_IMPORT} (CLI re-import with stable id ${LOCAL_N8N.workflowId})`);
  console.log(
    `Airtable base neutralized: ${baseReplacements} replacement(s) (${PROD_AIRTABLE_BASE_ID} → ${TEST_AIRTABLE_BASE_ID})`,
  );
  console.log(`workflow.active: ${finalized.active}`);
  console.log(`Nodes: ${finalized.nodes.length}`);

  const verify = verifyNoProdAirtableBase(finalized);
  if (!verify.ok) {
    console.error(`FAIL: prod Airtable base still in nodes: ${verify.prodBaseNodes.join(', ')}`);
    process.exit(1);
  }
  console.log('OK: no prod Airtable base in generated workflow');

  if (args.includes('--import-inactive')) {
    importWorkflowInactive(OUT_IMPORT, 'b3-assign-local-import.json');
  }

  console.log('Import into local n8n only. Deactivate hosted Bed Assignment if both use assign-beds-to-booking.');
}

if (args.includes('--verify-targets')) {
  if (!fs.existsSync(OUT)) {
    console.error(`Generated workflow not found: ${OUT}`);
    console.error('Run: npm run build:assign-beds:local first.');
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
