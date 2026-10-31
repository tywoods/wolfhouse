#!/usr/bin/env node
'use strict';

/**
 * DH-STAFF-CLEAR-PAYER-20261031 — per-payer split on Staff payment view.
 * Offline. Group booking with several links must show each payer's own
 * amount and status, not one lumped total.
 *
 * Run: node scripts/verify-staff-perpayer-split.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { projectGuestInvoicePayments } = require('./lib/booking-guests');

const ROOT = path.resolve(__dirname, '..');

function person(n, share) {
  return {
    booking_guest_id: 'guest-' + n,
    guest_number: n,
    guest_name: 'Guest ' + n,
    metadata: { subtotal_cents: share },
    amount_paid_cents: 0,
    deposit_amount_cents: share,
    payment_status: 'not_requested',
  };
}

function main() {
  const g1 = person(1, 10000);
  const g2 = person(2, 10000);
  const g3 = person(3, 15000);
  const payments = [
    { payment_id: 'p1', booking_guest_id: 'guest-1', payment_status: 'paid', amount_paid_cents: 10000, amount_due_cents: 10000 },
    { payment_id: 'p2', booking_guest_id: 'guest-2', payment_status: 'checkout_created', amount_paid_cents: 0, amount_due_cents: 10000 },
    { payment_id: 'p3', booking_guest_id: 'guest-3', payment_status: 'checkout_created', amount_paid_cents: 0, amount_due_cents: 15000 },
  ];
  const rows = projectGuestInvoicePayments([g1, g2, g3], payments);
  assert.equal(rows[0].invoice_paid_cents, 10000, 'guest 1 keeps own paid amount');
  assert.equal(rows[1].invoice_paid_cents, 0, 'guest 2 is not credited guest 1\'s payment');
  assert.equal(rows[2].invoice_paid_cents, 0, 'guest 3 is not credited guest 1\'s payment');
  assert.equal(rows[1].invoice_open_amount_cents, 10000, 'guest 2 open link amount');
  assert.equal(rows[2].invoice_open_amount_cents, 15000, 'guest 3 open link amount');
  assert.equal(rows[1].invoice_open_status, 'checkout_created');
  assert.equal(rows[2].invoice_open_status, 'checkout_created');
  assert.equal(rows[0].invoice_open_status, null, 'paid guest has no open link');

  const byMeta = projectGuestInvoicePayments([person(1, 10000), person(2, 10000)], [
    { payment_id: 'm1', payment_status: 'paid', amount_paid_cents: 10000, metadata: { guest_number: 1 } },
    { payment_id: 'm2', payment_status: 'checkout_created', amount_due_cents: 10000, metadata: { guest_number: 2 } },
  ]);
  assert.equal(byMeta[0].invoice_paid_cents, 10000, 'metadata guest_number attributes paid receipt');
  assert.equal(byMeta[1].invoice_open_amount_cents, 10000, 'metadata guest_number attributes open link');
  assert.notEqual(byMeta[0].invoice_paid_cents, byMeta[1].invoice_paid_cents, 'not one lumped paid total');

  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const start = apiSrc.indexOf('function bcRenderPerGuestPaymentsHtml(');
  const end = apiSrc.indexOf('\nfunction bcRenderPerGuestCollapseCard(');
  assert.ok(start >= 0 && end > start, 'per-guest renderer present');
  const renderer = apiSrc.slice(start, end);
  assert.match(renderer, /data-payer-status/, 'each payer row carries own status');
  assert.doesNotMatch(renderer, /owedShown = \(bookingFullyPaid === true/, 'owe is not zeroed by lumped bookingFullyPaid');
  assert.match(apiSrc, /never paint Paid for every guest/);
  const pebbleStart = apiSrc.indexOf('function bcAccommodationPayPebbleKey(');
  const pebble = apiSrc.slice(pebbleStart, apiSrc.indexOf('\nfunction bcAccommodationPayPebbleHtml('));
  assert.doesNotMatch(pebble, /if \(bookingFullyPaid === true\) return 'paid';/, 'pebble does not lump all guests Paid');

  const ctx = {
    Number, String, Math,
    getClient: () => 'wolfhouse-somo',
    escHtml: (x) => String(x == null ? '' : x),
    t: (key) => key,
    pgPayGuestSubtotalFromMetadata: (md) => (md && md.subtotal_cents != null ? Number(md.subtotal_cents) : null),
    bcInvoiceGuestStaffLabel: (_n, name) => name,
    bcInvoicePaymentRequestDisplay: () => ({ createLink: true, label: '' }),
  };
  vm.createContext(ctx);
  vm.runInContext(renderer, ctx);
  const html = ctx.bcRenderPerGuestPaymentsHtml(rows, [], 'Lead', false, false, {});
  const statuses = [...html.matchAll(/data-payer-status="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(statuses, ['paid', 'checkout_created', 'checkout_created'], 'three distinct payer statuses');
  const paid = [...html.matchAll(/bc-guest-pay-paid">([^<]+)/g)].map((m) => m[1]);
  const owed = [...html.matchAll(/bc-guest-pay-owed">([^<]+)/g)].map((m) => m[1]);
  assert.deepEqual(paid, ['€100.00', '€0.00', '€0.00'], 'paid column is per payer, not lumped');
  assert.deepEqual(owed, ['€0.00', '€100.00', '€150.00'], 'owe column is per payer, not lumped');
  console.log('ok per-payer split amounts and statuses');
}

main();
