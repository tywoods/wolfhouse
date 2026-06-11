/**
 * Stage 33e.1 — pending service attach must use allowed booking_service_records constraints.
 *
 * Usage:
 *   npm run verify:stage33e1-pending-service-db-constraint-mapping
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage33e1-pending-service-db-constraint-mapping';

const attachMod = require('./lib/luna-guest-pending-service-attach');
const {
  PENDING_ATTACH_ORIGIN,
  SERVICE_RECORD_DB_SOURCE,
  SERVICE_RECORD_DB_STATUS,
  buildAttachMetadata,
  resolveIntentStatus,
  attachPendingManualGuestServices,
  collectPendingManualServices,
  mergePendingServiceAttachContext,
} = attachMod;

const attachSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-pending-service-attach.js'), 'utf8');
const holdWriteSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-write.js'), 'utf8');
const executeSrc = fs.readFileSync(path.join(__dirname, 'lib', 'open-demo-whatsapp-inbound-execute.js'), 'utf8');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage33e1-pending-service-db-constraint-mapping.js  (Stage 33e.1)\n`);

section('A. Package script + safety static');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A1', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);
check('A2', !attachSrc.includes("'luna_guest_pending'") || attachSrc.includes('PENDING_ATTACH_ORIGIN'),
  'luna_guest_pending only as metadata origin constant');
check('A3', attachSrc.includes("SERVICE_RECORD_DB_SOURCE = 'luna_guest'"), 'DB source constant is luna_guest');
check('A4', /SERVICE_RECORD_DB_STATUS,\s*\n\s*SERVICE_RECORD_DB_SOURCE,\s*\n\s*JSON\.stringify\(metadata\)/.test(attachSrc),
  'INSERT source column uses SERVICE_RECORD_DB_SOURCE not pending origin');
check('A5', attachSrc.includes("metadata->>'pending_origin'"), 'idempotency keys on pending_origin metadata');
check('A6', !holdWriteSrc.includes('sends_whatsapp: true'), 'no WhatsApp send path added');
check('A7', holdWriteSrc.includes('calls_n8n: false'), 'hold write keeps n8n disabled');
check('A8', !executeSrc.includes('sendConfirmation'), 'no confirmation send path added');
check('A9', !fs.existsSync(path.join(ROOT, 'infra', 'migrations'))
  || !fs.readdirSync(path.join(ROOT, 'infra', 'migrations')).some((f) => f.includes('33e1')),
  'no new migration file added in this stage');

section('B. Source/status mapping helpers');

const yogaMeta = buildAttachMetadata(
  { type: 'yoga', attach_source: 'yoga_request' },
  { yoga_request: { status: 'requested' } },
);
check('B1', SERVICE_RECORD_DB_SOURCE === 'luna_guest', 'DB source is luna_guest');
check('B2', SERVICE_RECORD_DB_STATUS === 'requested', 'DB status constant is requested');
check('B3', yogaMeta.pending_origin === PENDING_ATTACH_ORIGIN, 'pending_origin preserved');
check('B4', yogaMeta.intent_status === 'requested', 'yoga intent_status requested');
check('B5', yogaMeta.needs_scheduling === true, 'needs_scheduling true in metadata');
check('B6', yogaMeta.service_pending_manual === true, 'service_pending_manual true in metadata');

const mealsInterested = buildAttachMetadata(
  { type: 'meal', attach_source: 'meals_request' },
  { meals_request: { status: 'interested' } },
);
check('B7', mealsInterested.intent_status === 'interested', 'meals interested intent_status preserved');
check('B8', mealsInterested.original_status === 'interested', 'meals original_status preserved');

const mealsDeferred = buildAttachMetadata(
  { type: 'meal', attach_source: 'meals_request' },
  { meals_request: { status: 'interested', deferred: true } },
);
check('B9', mealsDeferred.intent_status === 'deferred', 'meals deferred maps intent_status deferred');
check('B10', resolveIntentStatus({ type: 'meal' }, { meals_request: { status: 'interested' } }) === 'interested',
  'resolveIntentStatus reads interested');

section('C. Insert SQL mapping static');

check('C1', attachSrc.includes('SERVICE_RECORD_DB_STATUS'), 'insert uses DB status constant');
check('C2', attachSrc.includes('SERVICE_RECORD_DB_SOURCE'), 'insert uses DB source constant');
check('C3', attachSrc.includes('$5, NULL, 1, $6'), 'service_date remains null in insert');
check('C4', !attachSrc.includes("status: recordStatus") && !attachSrc.includes('resolveServiceRecordStatus'),
  'constrained status column no longer uses intent values');

section('D. Idempotency mock pg');

async function runIdempotency() {
  const inserts = [];
  const mockPg = {
    query: async (sql, params) => {
      if (/SELECT id/i.test(sql)) {
        const type = params[1];
        const source = params[2];
        const origin = params[3];
        const hit = inserts.find((row) => row.type === type
          && row.source === source
          && row.metadata.pending_origin === origin);
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (/INSERT INTO booking_service_records/i.test(sql)) {
        const meta = JSON.parse(params[7]);
        inserts.push({
          id: `svc-${inserts.length + 1}`,
          type: params[4],
          status: params[5],
          source: params[6],
          service_date: null,
          metadata: meta,
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const fields = mergePendingServiceAttachContext(
    {},
    { yoga_status: 'requested', services_pending_manual: ['yoga'] },
  );

  const first = await attachPendingManualGuestServices(mockPg, {
    clientSlug: 'wolfhouse-somo',
    bookingId: '4568e749-d907-45b7-ada7-1cb98ed73c09',
    bookingCode: 'WH-G27-TEST',
    guestName: 'Guest',
    extractedFields: fields,
  });
  const second = await attachPendingManualGuestServices(mockPg, {
    clientSlug: 'wolfhouse-somo',
    bookingId: '4568e749-d907-45b7-ada7-1cb98ed73c09',
    bookingCode: 'WH-G27-TEST',
    guestName: 'Guest',
    extractedFields: fields,
  });

  check('D1', first.attached_manual_services.includes('yoga'), 'first attach inserts yoga');
  check('D2', second.attached_manual_services.length === 0, 'second attach idempotent');
  check('D3', inserts.length === 1, 'only one row inserted');
  check('D4', inserts[0].source === 'luna_guest', 'insert source luna_guest');
  check('D5', inserts[0].status === 'requested', 'insert status requested');
  check('D6', inserts[0].metadata.pending_origin === 'luna_guest_pending', 'metadata pending_origin set');
}

runIdempotency().then(() => {
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
