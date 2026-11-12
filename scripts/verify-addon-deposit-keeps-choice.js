'use strict';

// Offline regression: Keller's two Malibu guests, three nights, board + wetsuit.
const assert = require('node:assert/strict');
const { calculateWolfhouseQuote, loadConfig } = require('./lib/wolfhouse-quote-calculator');
const { applyAuthoritativeSeasonsToConfig } = require('./lib/wolfhouse-pricing-resolve');
const { quoteNeedsPaymentChoice } = require('./lib/luna-quote-payment-choice');

const config = applyAuthoritativeSeasonsToConfig(loadConfig(), [
  { code: 'august', label: 'August', priority: 0, sort_order: 1, bookable: true, active: true,
    ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }] },
]);
const input = {
  client_slug: 'wolfhouse-somo', check_in: '2026-08-01', check_out: '2026-08-04',
  guest_count: 2, package_code: 'malibu', payment_choice: 'deposit',
  uses_per_guest_deposits: true,
  add_ons: [{ code: 'wetsuit_soft_top_combo', days: 3, quantity: 2 }],
};
const quote = calculateWolfhouseQuote(input, config);
assert.equal(quote.success, true, JSON.stringify(quote.blockers));
assert.equal(quote.total_cents, 39000);
assert.equal(quote.deposit_required_cents, 30000, 'Keller deposit caps at stay EUR300, not invoice EUR390');
assert.equal(quote.payment_link_amount_cents, 30000);
assert.equal(quoteNeedsPaymentChoice(quote), true, 'add-ons leave deposit versus full payment available');
assert.deepEqual(quote.per_guest_deposits.map(row => row.deposit_cents), [15000, 15000]);
assert.deepEqual(quote.per_person.map(row => [row.accommodation_cents, row.addons_cents, row.balance_cents]),
  [[15000, 4500, 4500], [15000, 4500, 4500]]);
console.log('PASS Keller: EUR390 total, EUR300 deposit, EUR90 remainder; payment choice retained');

function checkVariant(label, overrides, expectedTotal, expectedDeposits, expectedLink) {
  const result = calculateWolfhouseQuote({ ...input, ...overrides }, config);
  assert.equal(result.success, true, `${label}: ${JSON.stringify(result.blockers)}`);
  assert.equal(result.total_cents, expectedTotal, label);
  assert.deepEqual(result.per_guest_deposits.map(row => row.deposit_cents), expectedDeposits, label);
  assert.equal(result.deposit_required_cents, expectedDeposits.reduce((sum, value) => sum + value, 0), label);
  assert.equal(result.payment_link_amount_cents, expectedLink, label);
  assert.equal(result.per_person.reduce((sum, row) => sum + row.subtotal_cents, 0), expectedTotal, label);
  for (const row of result.per_person) {
    assert.equal(row.deposit_cents, Math.min(20000, row.accommodation_cents + row.supplement_cents), label);
    if ((overrides.payment_choice || 'deposit') === 'deposit') {
      assert.equal(row.balance_cents, row.subtotal_cents - row.deposit_cents, label);
      assert.ok(row.balance_cents >= row.addons_cents, label);
    }
  }
  console.log(`PASS ${label}`);
  return result;
}
const noAddons = checkVariant('no add-ons: unchanged stay-only full amount', { add_ons: [] }, 30000, [15000, 15000], 30000);
assert.equal(quoteNeedsPaymentChoice(noAddons), false);
checkVariant('private supplement is included in stay cap', { room_type: 'private' }, 42000, [16500, 16500], 33000);
checkVariant('full payment still includes rentals', { payment_choice: 'full' }, 39000, [15000, 15000], 39000);
checkVariant('arrival payment remains zero', { payment_choice: 'pay_on_arrival' }, 39000, [15000, 15000], 0);
checkVariant('longer stay retains EUR200 per guest ceiling', { check_out: '2026-08-08' }, 78800, [20000, 20000], 40000);
checkVariant('mixed guests cap independently', {
  guest_packages: [{ guest_number: 1, package_code: 'malibu' }, { guest_number: 2, package_code: 'waimea' }],
}, 51000, [15000, 20000], 35000);
checkVariant('solo guest cap excludes rentals', { guest_count: 1 }, 24000, [15000], 15000);
checkVariant('legacy flag does not change deposit cap', { uses_per_guest_deposits: false }, 39000, [15000, 15000], 30000);
