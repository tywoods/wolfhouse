'use strict';
/**
 * verify-staff-addon-service-payment-api.js — Stage 8.8.23
 *
 * Static verifier for:
 *   POST /staff/bookings/:booking_id/service-records/create-payment-link
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'staff-query-api.js');
const PKG = path.join(__dirname, '..', 'package.json');
const src = fs.readFileSync(SRC, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));

let passed = 0;
let failed = 0;

function check(id, desc, ok) {
  if (ok) {
    passed++;
    console.log(`  PASS  [${id}] ${desc}`);
  } else {
    failed++;
    console.error(`  FAIL  [${id}] ${desc}`);
  }
}

const hStart = src.indexOf('async function handleBookingServiceRecordsCreatePaymentLink');
const hEnd = src.indexOf('// Route: POST /staff/bot/payments', hStart > 0 ? hStart : 0);
const handler = hStart > 0 ? src.slice(hStart, hEnd > 0 ? hEnd : hStart + 12000) : '';

const pkgHandlerStart = src.indexOf('async function handlePaymentCreateStripeLink');
const pkgHandlerEnd = src.indexOf('async function handleBookingServiceRecordsCreatePaymentLink', pkgHandlerStart);
const pkgHandler = pkgHandlerStart > 0
  ? src.slice(pkgHandlerStart, pkgHandlerEnd > 0 ? pkgHandlerEnd : pkgHandlerStart + 12000)
  : '';

console.log('\nA. Route registration');
check('A1', 'BOOKING_SERVICE_RECORDS_PAYMENT_LINK_RE defined', /BOOKING_SERVICE_RECORDS_PAYMENT_LINK_RE/.test(src));
check('A2', 'route path service-records/create-payment-link', /service-records\/create-payment-link/.test(src));
check('A3', 'router calls handler', /handleBookingServiceRecordsCreatePaymentLink\(svcPayMatch\[1\]/.test(src));
check('A4', 'POST-only enforced', /Method not allowed — use POST for service-records\/create-payment-link/.test(src));
check('A5', 'requireAuth operator gate on route', /svcPayMatch[\s\S]{0,400}requireAuth\(req, res, 'operator'\)/.test(src));

console.log('\nB. Feature flags');
check('B1', 'STAFF_ACTIONS_ENABLED gate', /!STAFF_ACTIONS_ENABLED/.test(handler));
check('B2', 'STRIPE_LINKS_ENABLED gate', /!STRIPE_LINKS_ENABLED/.test(handler));

console.log('\nC. Request validation');
check('C1', 'service_record_ids array required', /service_record_ids/.test(handler));
check('C2', 'validates UUIDs', /UUID_VALIDATE_RE/.test(handler));
check('C3', 'records belong to booking_id', /row\.booking_id !== bookingId|does not belong to booking/.test(handler));
check('C4', 'rejects cancelled rows', /cancelled/.test(handler));
check('C5', 'rejects already paid rows', /payment_status === 'paid'|already paid/.test(handler));
check('C6', 'requires amount_due_cents > 0', /amount_due_cents[\s\S]{0,80}<=\s*0|amount_due_cents must be > 0/.test(handler));

console.log('\nD. Payment + service linkage');
check('D1', 'payment_kind addon_service on insert', /'addon_service'::payment_kind/.test(handler));
check('D2', 'amount from DB service rows not body', /rows\.reduce[\s\S]{0,120}amount_due_cents/.test(handler));
check('D3', 'metadata source staff_portal_addon_service', /staff_portal_addon_service/.test(handler));
check('D4', 'metadata service_record_ids', /service_record_ids/.test(handler));
check('D5', 'links booking_service_records.payment_id', /UPDATE booking_service_records[\s\S]{0,200}payment_id/.test(handler));
check('D6', 'sets service payment_status pending', /payment_status = 'pending'/.test(handler));
check('D7', 'no UPDATE bookings in handler', !/UPDATE bookings/.test(handler));

console.log('\nE. Stripe session');
check('E1', 'stripe.checkout.sessions.create', /stripe\.checkout\.sessions\.create/.test(handler));
check('E2', 'metadata payment_id', /metadata:[\s\S]{0,400}payment_id/.test(handler));
check('E3', 'metadata booking_id', /metadata:[\s\S]{0,400}booking_id/.test(handler));
check('E4', 'metadata booking_code', /metadata:[\s\S]{0,400}booking_code/.test(handler));
check('E5', 'metadata service_record_ids for Stripe', /service_record_ids: JSON\.stringify\(serviceRecordIds\)/.test(handler));
check('E6', 'metadata payment_kind addon_service', /payment_kind:\s*'addon_service'/.test(handler));
check('E7', 'amount uses amountDueCents from rows', /unit_amount:\s*amountDueCents/.test(handler));

console.log('\nF. Response + idempotency');
check('F1', 'returns checkout_url', /checkout_url/.test(handler));
check('F2', 'returns payment_kind addon_service', /payment_kind:\s*'addon_service'/.test(handler));
check('F3', 'returns service_record_ids', /service_record_ids:/.test(handler));
check('F4', 'no_payment_truth_recorded true', /no_payment_truth_recorded:\s*true/.test(handler));
check('F5', 'idempotent checkout_created path', /checkout_created[\s\S]{0,400}idempotent:\s*true/.test(handler));
check('F6', 'no paid status on service rows in handler', !/payment_status\s*=\s*'paid'/.test(handler));

console.log('\nG. Safety');
check('G1', 'no WhatsApp in handler', !/whatsapp\s*\(|sendWhatsApp|graph\.facebook\.com/i.test(handler));
check('G2', 'no n8n HTTP in handler', !/fetch\s*\([\s\S]{0,80}n8n/i.test(handler));
check('G3', 'no confirmation_sent_at write', !/confirmation_sent_at/.test(handler));
check('G4', 'no_whatsapp in response', /no_whatsapp:\s*true/.test(handler));
check('G5', 'no_n8n in response', /no_n8n:\s*true/.test(handler));

console.log('\nH. Package payment link unchanged');
check('H1', 'handlePaymentCreateStripeLink still exists', pkgHandler.length > 500);
check('H2', 'package link still uses staff_portal_manual_booking metadata', /staff_portal_manual_booking/.test(pkgHandler));
check('H3', 'package link route unchanged', /PAYMENT_STRIPE_LINK_RE/.test(src));

console.log('\nI. package.json script');
check('I1', 'verify:staff-addon-service-payment-api script',
  pkg.scripts['verify:staff-addon-service-payment-api']
  === 'node scripts/verify-staff-addon-service-payment-api.js');

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('verify-staff-addon-service-payment-api PASS');
  process.exit(0);
}
console.log('verify-staff-addon-service-payment-api FAIL');
process.exit(1);
