'use strict';

/**
 * After deposit/pay links are sent, payment_status must not stay not_requested.
 * Staff /payments/status still echoes bookings.payment_status=not_requested even
 * when payments.status is checkout_created. Project the sent-link state for Luna.
 *
 * Run: node scripts/verify-luna-payment-status-after-links.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  projectPaymentStatusAfterLinksSent,
} = require('./lib/luna-payment-status-after-links');

const afterLinks = projectPaymentStatusAfterLinksSent({
  success: true,
  booking_payment_status: 'not_requested',
  latest_payment: {
    payment_status: 'checkout_created',
    booking_payment_status: 'not_requested',
    checkout_url: 'https://pay.example/deposit',
    amount_due_cents: 60000,
  },
  payment_records: [{
    payment_status: 'checkout_created',
    booking_payment_status: 'not_requested',
    checkout_url: 'https://pay.example/deposit',
  }],
});

assert.notEqual(afterLinks.booking_payment_status, 'not_requested',
  'booking_payment_status must reflect that links were sent');
assert.notEqual(String(afterLinks.payment_status || ''), 'not_requested');
assert.ok(
  ['checkout_created', 'waiting_payment', 'payment_link_sent'].includes(afterLinks.booking_payment_status),
  afterLinks.booking_payment_status,
);
assert.equal(afterLinks.latest_payment.payment_status, 'checkout_created');

const stillPaid = projectPaymentStatusAfterLinksSent({
  success: true,
  booking_payment_status: 'deposit_paid',
  latest_payment: {
    payment_status: 'paid',
    booking_payment_status: 'deposit_paid',
  },
  payment_records: [{ payment_status: 'paid' }],
});
assert.equal(stillPaid.booking_payment_status, 'deposit_paid', 'paid bookings stay paid');

const untouched = projectPaymentStatusAfterLinksSent({
  success: true,
  booking_payment_status: 'not_requested',
  latest_payment: null,
  payment_records: [],
});
assert.equal(untouched.booking_payment_status, 'not_requested', 'no links → still not_requested');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const wrap = api.slice(
  api.indexOf('async function handleBotPaymentStatus'),
  api.indexOf('async function handleBotBookingCreateFromPlan'),
);
assert.match(wrap, /projectPaymentStatusAfterLinksSent/,
  'Staff payment-status handler must project sent-link status');

const stayOff = [
  'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py',
  'docker/hermes-staging/wolfhouse/accepted_quote.py',
  'scripts/lib/staff-bot-v2-routes.js',
  'scripts/lib/luna-front-desk-payment-link-service.js',
  'scripts/lib/booking-invoice-totals.js',
];
assert.ok(stayOff.every((f) => fs.existsSync(path.join(__dirname, '..', f))));

console.log('PASS payment_status after links sent');
