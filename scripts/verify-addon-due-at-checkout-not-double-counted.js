'use strict';

/**
 * Add-ons already inside guest pay links must not also show as extra
 * "due at checkout" on the staff booking.
 *
 * Ty: WH-20270802-07634071 showed "Soft_board — €90.00 due at checkout"
 * next to total_due_at_checkout €390, but the €90 was already in the
 * €390 guest pay links.
 *
 * Run: node scripts/verify-addon-due-at-checkout-not-double-counted.js
 */

const assert = require('node:assert/strict');
const {
  buildServiceChargesDueFromContext,
} = require('./lib/luna-guest-addon-service-payment-ledger');

const booking = {
  total_amount_cents: 39000,
  balance_due_cents: 39000,
  metadata: {
    quote_snapshot: {
      total_cents: 39000,
      line_items: [
        { code: 'package_proration', total_cents: 30000 },
        { code: 'soft_top_rental', total_cents: 9000, label: 'Soft board' },
      ],
    },
  },
};

const serviceRecords = [{
  id: 'sr-board',
  service_type: 'surfboard',
  amount_due_cents: 9000,
  payment_status: 'pending',
  metadata: { service_type: 'surfboard', board_type: 'soft', label: 'Soft_board' },
}];

const guestPayLinks = [{
  payment_kind: 'deposit',
  payment_status: 'checkout_created',
  amount_due_cents: 39000,
  amount_paid_cents: 0,
  checkout_url: 'https://pay.example/stay-390',
  metadata: { payment_link_url: 'https://pay.example/stay-390' },
}];

const addonLedgerRow = {
  payment_kind: 'addon_service',
  payment_status: 'draft',
  amount_due_cents: 9000,
  amount_paid_cents: 0,
  metadata: {
    payment_origin: 'luna_guest_service_addon',
    service_type: 'surfboard',
    board_type: 'soft',
    label: 'Soft_board',
  },
};

const covered = buildServiceChargesDueFromContext({
  booking,
  serviceRecords,
  paymentRows: [...guestPayLinks, addonLedgerRow],
});

const extraLines = (covered.service_charges_due_lines || []).filter((line) => /due at checkout/i.test(String(line)));
assert.equal(extraLines.length, 0, `must not list add-on as extra due: ${JSON.stringify(covered.service_charges_due_lines)}`);
assert.equal(covered.service_charges_due_cents, 0, 'covered add-on cents are not extra due');
assert.equal(covered.total_due_at_checkout_cents, 39000, 'stay balance including the add-on stays €390');

const uncovered = buildServiceChargesDueFromContext({
  booking: { total_amount_cents: 30000, balance_due_cents: 30000, metadata: { quote_snapshot: { line_items: [{ code: 'package_proration', total_cents: 30000 }] } } },
  serviceRecords,
  paymentRows: [],
});
assert.ok(
  (uncovered.service_charges_due_lines || []).some((line) => /90\.00/.test(String(line)) && /due at checkout/i.test(String(line))),
  `standalone add-on still due at checkout: ${JSON.stringify(uncovered.service_charges_due_lines)}`,
);
assert.equal(uncovered.service_charges_due_cents, 9000);

const includedInTotal = buildServiceChargesDueFromContext({
  booking: {
    total_amount_cents: 44500,
    balance_due_cents: 44500,
    metadata: {
      quote_snapshot: {
        total_cents: 44500,
        line_items: [
          { code: 'package_proration', total_cents: 41500 },
          { code: 'yoga_class', total_cents: 3000, label: 'Yoga' },
        ],
      },
    },
  },
  serviceRecords: [{
    id: 'sr-yoga',
    service_type: 'yoga',
    amount_due_cents: 3000,
    payment_status: 'pending',
    metadata: { service_type: 'yoga', label: 'Yoga' },
  }],
  paymentRows: [],
});
const includedLines = includedInTotal.service_charges_due_lines || [];
assert.ok(includedLines.length === 0
  || includedLines.every((line) => !/due at checkout/i.test(String(line))),
  `extra already in booking total must not say due at checkout: ${JSON.stringify(includedLines)}`);

console.log('PASS addon already in guest pay links is not extra due at checkout');
