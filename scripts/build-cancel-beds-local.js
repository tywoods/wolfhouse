/**
 * Build n8n/phase3b/Wolfhouse - Cancel Bed Assignments (local PG).json
 *
 * Phase 3b.1c — Postgres cancel (3b.1b logic) then hosted Airtable delete/update nodes.
 * Does NOT modify n8n/Wolfhouse - Cancel Bed Assignments.json (hosted export).
 *
 * Run: npm run build:cancel-beds:local
 *
 * Keep PG_CANCEL_SQL in sync with scripts/cancel-booking-beds-postgres.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  PROD_AIRTABLE_BASE_ID,
  TEST_AIRTABLE_BASE_ID,
  verifyNoProdAirtableBase,
  importWorkflowInactive,
  finalizeLocalBedOpsWorkflow,
} = require('./lib/bed-ops-local-build');

const args = process.argv.slice(2);

const HOSTED = path.join(__dirname, '..', 'n8n', 'Wolfhouse - Cancel Bed Assignments.json');
const OUT_DIR = path.join(__dirname, '..', 'n8n', 'phase3b');
const OUT = path.join(OUT_DIR, 'Wolfhouse - Cancel Bed Assignments (local PG).json');
const OUT_IMPORT = path.join(OUT_DIR, 'Wolfhouse - Cancel Bed Assignments (local PG).n8n-import.json');

/** Stable ids from local n8n after first UI import — enables CLI re-import without duplicate workflows. */
const LOCAL_N8N = {
  workflowId: 'KchhRC9b3MIdkzPT',
  postgresCred: { id: 'MnnrrLecI7oVoIGq', name: 'Postgres account' },
  airtableCred: { id: 'tEUby6EPDxFQ5st8', name: 'Airtable Personal Access Token account' },
};

const CLIENT_SLUG = 'wolfhouse-somo';

/** Single-statement PG cancel — mirrors cancel-booking-beds-postgres.js --execute */
const PG_CANCEL_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '__NULL__') AS airtable_record_id,
    NULLIF(trim($2), '__NULL__') AS booking_code
),
resolved AS (
  SELECT
    b.id,
    b.booking_code,
    b.payment_status::text AS payment_status,
    c.id AS client_id
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  CROSS JOIN params p
  WHERE c.slug = '${CLIENT_SLUG}'
    AND (
      (p.airtable_record_id IS NOT NULL AND b.airtable_record_id = p.airtable_record_id)
      OR (p.booking_code IS NOT NULL AND b.booking_code = p.booking_code)
    )
  LIMIT 2
),
resolved_count AS (
  SELECT COUNT(*)::int AS c FROM resolved
),
guard AS (
  SELECT r.*
  FROM resolved r
  WHERE (SELECT c FROM resolved_count) = 1
),
beds_before AS (
  SELECT COUNT(*)::int AS c
  FROM booking_beds bb
  INNER JOIN guard r ON bb.booking_id = r.id AND bb.client_id = r.client_id
),
deleted AS (
  DELETE FROM booking_beds bb
  USING guard r
  WHERE bb.booking_id = r.id AND bb.client_id = r.client_id
  RETURNING bb.id
),
updated AS (
  UPDATE bookings b
  SET
    assignment_status = 'needs_review',
    availability_check_status = 'needs_review'
  FROM guard r
  WHERE b.id = r.id AND b.client_id = r.client_id
  RETURNING b.id
)
SELECT
  rc.c AS booking_rows_resolved,
  r.booking_code,
  r.id::text AS booking_id,
  r.payment_status AS payment_status_before,
  (SELECT payment_status::text FROM bookings WHERE id = r.id) AS payment_status_after,
  (SELECT c FROM beds_before) AS beds_before_count,
  (SELECT COUNT(*)::int FROM deleted) AS pg_deleted_count,
  (SELECT COUNT(*)::int FROM updated) AS pg_updated_count,
  (SELECT COUNT(*)::int FROM payments p INNER JOIN guard g ON p.booking_id = g.id) AS payments_count
FROM resolved_count rc
LEFT JOIN guard r ON true`;

const NULL_SENTINEL = '__NULL__';
const PG_QUERY_REPLACEMENT = `={{ (($('Code - Parse Cancel Webhook').first().json.airtable_record_id) != null && String($('Code - Parse Cancel Webhook').first().json.airtable_record_id).trim() !== '') ? String($('Code - Parse Cancel Webhook').first().json.airtable_record_id).trim() : '${NULL_SENTINEL}' }},={{ (($('Code - Parse Cancel Webhook').first().json.booking_code) != null && String($('Code - Parse Cancel Webhook').first().json.booking_code).trim() !== '') ? String($('Code - Parse Cancel Webhook').first().json.booking_code).trim() : '${NULL_SENTINEL}' }}`;

const HOSTED_NODE_NAMES = [
  'Get Cancelled Booking',
  'Code - Prepare Booking Beds To Cancel',
  'Delete Booking Beds Assignments',
  'Update Cancelled Booking Assignment Status',
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

const VALIDATE_PG_JS = `const parsed = $('Code - Parse Cancel Webhook').first().json;
const pgItems = $('Postgres - Cancel Beds In Postgres').all();
const pgItem = pgItems[0];
const pgErr = pgItem?.error;
const pg = pgItem?.json || {};

if (pgErr) {
  const msg = String(pgErr.message || pgErr);
  return [{
    json: {
      pg_ok: false,
      errors: [msg.includes('no parameter') ? 'postgres_query_param_missing' : 'postgres_cancel_failed'],
      airtable_record_id: parsed.airtable_record_id,
      record_id: parsed.record_id || parsed.airtable_record_id,
      booking_code: parsed.booking_code,
      pg_deleted_count: 0,
      pg_updated_count: 0,
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
      pg_updated_count: 0,
      partial_failure: 'pg_resolve_failed',
      message: 'Postgres could not resolve exactly one booking — Airtable steps skipped'
    }
  }];
}

const errors = [];
const before = String(pg.payment_status_before || '');
const after = String(pg.payment_status_after || '');
if (before && after && before !== after) {
  errors.push('payment_status_changed_during_pg_cancel');
}

return [{
  json: {
    pg_ok: true,
    errors,
    ...pg,
    airtable_record_id: parsed.airtable_record_id,
    record_id: parsed.record_id || parsed.airtable_record_id,
    booking_code: pg.booking_code || parsed.booking_code
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

const parsed = $('Code - Parse Cancel Webhook').first()?.json || {};
const record_id = parsed.record_id || parsed.airtable_record_id || '';

if (!parsed.parse_ok) {
  return [{
    json: {
      ok: false,
      booking_code: parsed.booking_code || '',
      record_id,
      pg_deleted_count: 0,
      pg_updated: false,
      airtable_delete_ok: false,
      airtable_update_ok: false,
      partial_failure: 'parse_failed',
      idempotent: false,
      errors: mergeErrors(parsed.errors, ['parse_failed']),
      message: 'Invalid webhook payload'
    }
  }];
}

let validate;
try {
  validate = $('Code - Validate PG Cancel').first().json;
} catch (e) {
  validate = { pg_ok: false, errors: ['validate_pg_cancel_not_run'] };
}

if (!validate.pg_ok) {
  return [{
    json: {
      ok: false,
      booking_code: validate.booking_code || parsed.booking_code || '',
      record_id: validate.record_id || record_id,
      pg_deleted_count: Number(validate.pg_deleted_count ?? 0),
      pg_updated: Number(validate.pg_updated_count ?? 0) > 0,
      airtable_delete_ok: false,
      airtable_update_ok: false,
      partial_failure: validate.partial_failure || 'pg_failed',
      idempotent: Number(validate.pg_deleted_count ?? 0) === 0,
      errors: mergeErrors(validate.errors, [validate.message]),
      message: validate.message || 'Postgres cancel did not complete'
    }
  }];
}

const pgDeleted = Number(validate.pg_deleted_count ?? 0);
const pgUpdatedCount = Number(validate.pg_updated_count ?? 0);

let deleteItems = [];
let upd = null;
let prep = null;
try { deleteItems = $('Delete Booking Beds Assignments').all(); } catch (e) {}
try { upd = $('Update Cancelled Booking Assignment Status').first(); } catch (e) {}
try { prep = $('Code - Prepare Booking Beds To Cancel').first()?.json; } catch (e) {}

const atDeleteErrors = [];
let atDeleteAttempts = 0;
for (const item of deleteItems) {
  if (item.error) {
    atDeleteErrors.push(String(item.error.message || item.error));
    continue;
  }
  atDeleteAttempts += 1;
}

const atUpdateOk =
  !!(upd?.json?.id || upd?.json?.fields) && !upd?.error && !upd?.json?.error;
const atDeleteOk = atDeleteErrors.length === 0;
const noBedsInAt = !!prep?.no_booking_beds_found;

const pgOk = true;
const atOk = atUpdateOk && atDeleteOk;

let partial_failure = validate.partial_failure || null;
if (pgOk && !atOk) partial_failure = 'pg_ok_airtable_failed';

const idempotent = pgDeleted === 0 && (noBedsInAt || atDeleteAttempts === 0);

return [{
  json: {
    ok: pgOk && atOk && !partial_failure,
    booking_code: validate.booking_code,
    record_id: validate.record_id || record_id,
    pg_deleted_count: pgDeleted,
    pg_updated: pgUpdatedCount > 0,
    pg_updated_count: pgUpdatedCount,
    airtable_delete_ok: atDeleteOk,
    airtable_update_ok: atUpdateOk,
    idempotent,
    partial_failure,
    errors: mergeErrors(validate.errors, atDeleteErrors),
    payments_count: Number(validate.payments_count ?? 0),
    message:
      partial_failure === 'pg_ok_airtable_failed'
        ? 'Postgres cancel succeeded; Airtable step failed — check credentials and bed-drift'
        : idempotent
          ? 'cancel_beds_idempotent_no_op'
          : 'cancel_beds_complete'
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

  const xShift = 520;
  const getBooking = pickHosted(hosted, 'Get Cancelled Booking');
  getBooking.position = [getBooking.position[0] + xShift, getBooking.position[1]];
  getBooking.parameters.id = "={{ $('Code - Parse Cancel Webhook').first().json.airtable_record_id }}";

  const prepareBeds = pickHosted(hosted, 'Code - Prepare Booking Beds To Cancel');
  prepareBeds.position = [prepareBeds.position[0] + xShift, prepareBeds.position[1]];

  const deleteBeds = pickHosted(hosted, 'Delete Booking Beds Assignments');
  deleteBeds.position = [deleteBeds.position[0] + xShift, deleteBeds.position[1]];
  deleteBeds.continueOnFail = true;
  deleteBeds.alwaysOutputData = true;

  const updateBooking = pickHosted(hosted, 'Update Cancelled Booking Assignment Status');
  updateBooking.position = [updateBooking.position[0] + xShift, updateBooking.position[1]];
  updateBooking.continueOnFail = true;
  updateBooking.alwaysOutputData = true;

  const workflow = {
    name: 'Wolfhouse - Cancel Bed Assignments (local PG)',
    nodes: [
      {
        parameters: {
          httpMethod: 'POST',
          path: 'cancel-booking-beds',
          responseMode: 'responseNode',
          options: {},
        },
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2.1,
        position: [-32, -96],
        id: uid('webhook-cancel-beds-local'),
        name: 'Cancel Booking Bed Assignments - Webhook',
        webhookId: '3b1c0001-0001-4000-8000-000000000001',
      },
      {
        parameters: { jsCode: PARSE_WEBHOOK_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [120, -96],
        id: uid('parse-cancel-webhook'),
        name: 'Code - Parse Cancel Webhook',
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
        position: [280, -96],
        id: uid('if-parse-ok'),
        name: 'IF - Parse OK',
      },
      {
        parameters: {
          operation: 'executeQuery',
          query: PG_CANCEL_SQL,
          options: {
            queryReplacement: PG_QUERY_REPLACEMENT,
          },
        },
        type: 'n8n-nodes-base.postgres',
        typeVersion: 2.5,
        position: [440, -96],
        id: uid('postgres-cancel-beds'),
        name: 'Postgres - Cancel Beds In Postgres',
        alwaysOutputData: true,
        continueOnFail: true,
        onError: 'continueRegularOutput',
        credentials: {
          postgres: LOCAL_N8N.postgresCred,
        },
      },
      {
        parameters: { jsCode: VALIDATE_PG_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [600, -96],
        id: uid('validate-pg-cancel'),
        name: 'Code - Validate PG Cancel',
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
        position: [760, -96],
        id: uid('if-pg-ok'),
        name: 'IF - PG Booking Resolved',
      },
      getBooking,
      prepareBeds,
      deleteBeds,
      updateBooking,
      {
        parameters: { jsCode: BUILD_RESPONSE_JS },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [1320, -96],
        id: uid('build-cancel-response'),
        name: 'Code - Build Cancel Response',
      },
      {
        parameters: {
          respondWith: 'json',
          responseBody: '={{ $json }}',
          options: {},
        },
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [1500, -96],
        id: uid('respond-cancel-webhook'),
        name: 'Respond to Webhook',
      },
    ],
    connections: {
      'Cancel Booking Bed Assignments - Webhook': {
        main: [[{ node: 'Code - Parse Cancel Webhook', type: 'main', index: 0 }]],
      },
      'Code - Parse Cancel Webhook': {
        main: [[{ node: 'IF - Parse OK', type: 'main', index: 0 }]],
      },
      'IF - Parse OK': {
        main: [
          [{ node: 'Postgres - Cancel Beds In Postgres', type: 'main', index: 0 }],
          [{ node: 'Code - Build Cancel Response', type: 'main', index: 0 }],
        ],
      },
      'Postgres - Cancel Beds In Postgres': {
        main: [[{ node: 'Code - Validate PG Cancel', type: 'main', index: 0 }]],
      },
      'Code - Validate PG Cancel': {
        main: [[{ node: 'IF - PG Booking Resolved', type: 'main', index: 0 }]],
      },
      'IF - PG Booking Resolved': {
        main: [
          [{ node: 'Get Cancelled Booking', type: 'main', index: 0 }],
          [{ node: 'Code - Build Cancel Response', type: 'main', index: 0 }],
        ],
      },
      'Get Cancelled Booking': {
        main: [[{ node: 'Code - Prepare Booking Beds To Cancel', type: 'main', index: 0 }]],
      },
      'Code - Prepare Booking Beds To Cancel': {
        main: [[{ node: 'Delete Booking Beds Assignments', type: 'main', index: 0 }]],
      },
      'Delete Booking Beds Assignments': {
        main: [[{ node: 'Update Cancelled Booking Assignment Status', type: 'main', index: 0 }]],
      },
      'Update Cancelled Booking Assignment Status': {
        main: [[{ node: 'Code - Build Cancel Response', type: 'main', index: 0 }]],
      },
      'Code - Build Cancel Response': {
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
    importWorkflowInactive(OUT_IMPORT, 'b3-cancel-local-import.json');
  }

  console.log('Import into local n8n only. Deactivate hosted Cancel workflow if both are present.');
}

if (args.includes('--verify-targets')) {
  if (!fs.existsSync(OUT)) {
    console.error(`Generated workflow not found: ${OUT}`);
    console.error('Run: npm run build:cancel-beds:local first.');
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
