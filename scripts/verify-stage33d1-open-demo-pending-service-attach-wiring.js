/**
 * Stage 33d.1 — open-demo hold write must pass pending manual service context into attach.
 *
 * Usage:
 *   npm run verify:stage33d1-open-demo-pending-service-attach-wiring
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage33d1-open-demo-pending-service-attach-wiring';

const gate = require('./lib/open-demo-whatsapp-gate');
const {
  mergePendingServiceAttachContext,
  collectPendingManualServices,
  attachPendingManualGuestServices,
  PENDING_ATTACH_SOURCE,
} = require('./lib/luna-guest-pending-service-attach');
const { stripPendingManualFromServiceInterest } = require('./lib/luna-booking-reactive-services-policy');

const gateSrc = fs.readFileSync(path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js'), 'utf8');
const attachSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-pending-service-attach.js'), 'utf8');
const holdWriteSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-write.js'), 'utf8');
const executeSrc = fs.readFileSync(path.join(__dirname, 'lib', 'open-demo-whatsapp-inbound-execute.js'), 'utf8');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage33d1-open-demo-pending-service-attach-wiring.js  (Stage 33d.1)\n`);

section('A. Package script + safety static');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A1', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);
check('A2', gateSrc.includes('mergePendingServiceAttachContext'), 'gate merges pending service context');
check('A3', holdWriteSrc.includes('mergePendingServiceAttachContext'), 'hold write merges attach context');
check('A4', holdWriteSrc.includes('resultContext: chain.result'), 'hold write passes resultContext to attach');
check('A5', !holdWriteSrc.includes('sends_whatsapp: true'), 'no WhatsApp send path added');
check('A6', holdWriteSrc.includes('calls_n8n: false'), 'hold write keeps n8n disabled');
check('A7', !holdWriteSrc.includes('creates_stripe_link: true'), 'no live Stripe path added');
check('A8', !executeSrc.includes('sendConfirmation'), 'no confirmation send path added');
check('A9', attachSrc.includes('service_date, quantity, status'), 'attach keeps service_date null insert');

section('B. buildOpenDemoWriteChainFromReview merges observability into extracted_fields');

const depositReview = {
  result: {
    message_lane: 'booking',
    payment_choice_ready: true,
    yoga_status: 'requested',
    services_pending_manual: ['yoga'],
    service_interest: [],
    extracted_fields: {},
  },
  availability: { availability_status: 'available' },
  quote: { quote_status: 'ready', quote_total_cents: 29900 },
  payment_choice: { payment_choice_ready: true, next_safe_step: 'ready_for_hold_payment_draft' },
};

const chain = gate.buildOpenDemoWriteChainFromReview(depositReview);
const merged = chain.result.extracted_fields || {};
check('B1', Object.keys(depositReview.result.extracted_fields).length === 0, 'fixture has empty extracted_fields');
check('B2', merged.services_pending_manual && merged.services_pending_manual.includes('yoga'),
  'merged context includes services_pending_manual yoga');
check('B3', merged.yoga_status === 'requested', 'merged context includes yoga_status');
check('B4', merged.yoga_request && merged.yoga_request.status === 'requested',
  'merged context synthesizes yoga_request');
check('B5', !merged.service_interest || !merged.service_interest.includes('yoga'),
  'yoga not placed in service_interest');

const yogaCandidates = collectPendingManualServices(merged);
check('B6', yogaCandidates.some((s) => s.type === 'yoga'),
  'empty extracted_fields + observability yields yoga attach candidate');

section('C. Meals pending from observability');

const mealsReview = {
  result: {
    meals_status: 'interested',
    services_pending_manual: ['meals'],
    extracted_fields: { check_in: '2026-07-10', check_out: '2026-07-17' },
  },
};
const mealsMerged = mergePendingServiceAttachContext(mealsReview.result.extracted_fields, mealsReview.result);
const mealsCandidates = collectPendingManualServices(mealsMerged);
check('C1', mealsMerged.meals_request && mealsMerged.meals_request.status === 'interested',
  'meals_request synthesized from meals_status + pending list');
check('C2', mealsCandidates.some((s) => s.type === 'meal'), 'meals pending yields attach candidate');

section('D. service_interest remains surf-only');

const withSurf = {
  service_interest: ['surf'],
  yoga_status: 'requested',
  services_pending_manual: ['yoga'],
};
const surfMerged = mergePendingServiceAttachContext({}, withSurf);
check('D1', !surfMerged.service_interest || surfMerged.service_interest.length === 0,
  'merge does not copy service_interest from context');
const stripped = stripPendingManualFromServiceInterest({
  service_interest: ['surf', 'yoga', 'meals'],
});
check('D2', stripped.service_interest.length === 1 && stripped.service_interest[0] === 'surf',
  'stripPendingManual keeps surf-only');

section('E. Attach idempotence + no fake scheduling (mock pg)');

async function runAttachIdempotence() {
  const inserts = [];
  const mockPg = {
    query: async (sql, params) => {
      if (/SELECT id/i.test(sql)) {
        const type = params[1];
        const already = inserts.filter((row) => row.type === type);
        return { rows: already.length ? [{ id: already[0].id }] : [] };
      }
      if (/INSERT INTO booking_service_records/i.test(sql)) {
        inserts.push({
          id: `svc-${inserts.length + 1}`,
          type: params[4],
          status: params[5],
          service_date: params.includes(null) ? null : undefined,
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const ctx = {
    yoga_status: 'requested',
    services_pending_manual: ['yoga'],
  };
  const fields = mergePendingServiceAttachContext({}, ctx);

  const first = await attachPendingManualGuestServices(mockPg, {
    clientSlug: 'wolfhouse-somo',
    bookingId: '4568e749-d907-45b7-ada7-1cb98ed73c09',
    bookingCode: 'WH-G27-TEST',
    guestName: 'Guest',
    extractedFields: fields,
    resultContext: ctx,
  });
  const second = await attachPendingManualGuestServices(mockPg, {
    clientSlug: 'wolfhouse-somo',
    bookingId: '4568e749-d907-45b7-ada7-1cb98ed73c09',
    bookingCode: 'WH-G27-TEST',
    guestName: 'Guest',
    extractedFields: fields,
    resultContext: ctx,
  });

  check('E1', first.attached_manual_services.includes('yoga'), 'first attach inserts yoga');
  check('E2', second.attached_manual_services.length === 0, 'second attach is idempotent');
  check('E3', inserts.length === 1, 'only one yoga row inserted');
  check('E4', inserts[0] && inserts[0].status === 'requested', 'yoga row status requested');
  check('E5', PENDING_ATTACH_SOURCE === 'luna_guest_pending', 'source marker unchanged');
}

runAttachIdempotence().then(() => {
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
