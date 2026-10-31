#!/usr/bin/env node
'use strict';

/**
 * PER GUEST must show each guest's own deposit, paid, and remaining
 * from saved booking pricing (not only Total / Paid / Owe).
 *
 * Example: WH-20261101-04706321 Anna/Lisa/Max Weber, €600 deposit / 3.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const start = apiSrc.indexOf('function bcRenderPerGuestPaymentsHtml(');
const end = apiSrc.indexOf('\nfunction bcRenderPerGuestCollapseCard(');
assert.ok(start >= 0 && end > start, 'per-guest renderer present');
const renderer = apiSrc.slice(start, end);

function weber(n, name) {
  return {
    booking_guest_id: 'guest-' + n,
    guest_number: n,
    guest_name: name,
    metadata: { subtotal_cents: 24900 },
    amount_paid_cents: 0,
    deposit_amount_cents: 20000,
    invoice_paid_cents: 0,
    payment_status: 'checkout_created',
  };
}

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
const html = ctx.bcRenderPerGuestPaymentsHtml(
  [weber(1, 'Anna Weber'), weber(2, 'Lisa Weber'), weber(3, 'Max Weber')],
  [],
  'Anna Weber',
  false,
  false,
  {},
);

assert.match(html, /bc-guest-pay-deposit/, 'PER GUEST has a deposit column');
const deposits = [...html.matchAll(/bc-guest-pay-deposit\">([^<]+)/g)].map((m) => m[1]);
assert.deepEqual(deposits, ['€200.00', '€200.00', '€200.00'], 'each Weber guest shows own €200 deposit');
const paid = [...html.matchAll(/bc-guest-pay-paid\">([^<]+)/g)].map((m) => m[1]);
assert.deepEqual(paid, ['€0.00', '€0.00', '€0.00'], 'each guest paid is own, not lumped');
const remaining = [...html.matchAll(/bc-guest-pay-remaining\">([^<]+)/g)].map((m) => m[1]);
assert.deepEqual(remaining, ['€200.00', '€200.00', '€200.00'], 'each guest remaining deposit is own');
assert.match(html, /Anna Weber/);
assert.match(html, /Lisa Weber/);
assert.match(html, /Max Weber/);

const cancelledHtml = ctx.bcRenderPerGuestPaymentsHtml(
  [weber(1, 'Anna Weber')],
  [],
  'Anna Weber',
  false,
  false,
  { bookingCancelled: true },
);
assert.match(cancelledHtml, /bc-guest-pay-deposit">€200\.00/, 'cancelled keeps historical deposit');
assert.match(cancelledHtml, /bc-guest-pay-paid">€0\.00/, 'cancelled keeps historical paid');
assert.match(cancelledHtml, /bc-guest-pay-remaining">€0\.00/, 'cancelled remaining is not collectible');
assert.doesNotMatch(cancelledHtml, /bc-guest-pay-remaining">€200\.00/, 'cancelled remaining is not the open deposit');
assert.match(cancelledHtml, /bc-guest-pay-owed">€0\.00/, 'cancelled owe stays zero');
console.log('ok per-guest deposit / paid / remaining');
