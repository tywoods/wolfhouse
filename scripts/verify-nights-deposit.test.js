'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { wolfhouseStayDepositRateCents, wolfhouseBookingDepositCents, wolfhouseDepositRatesFromConfig } = require('./lib/wolfhouse-stay-deposit');
const { calculateWolfhouseQuote, loadConfig } = require('./lib/wolfhouse-quote-calculator');
const { bookingDepositLinkAmount } = require('./lib/booking-deposit-payment-link');

test('nights threshold selects the same per-person rate for room-only and package stays', () => {
  const rates = { nights_threshold: 6, short_stay_cents: 10000, long_stay_cents: 20000 };
  for (const code of ['package_none', 'malibu', 'manual_override']) {
    assert.equal(wolfhouseStayDepositRateCents(5, rates, code), 10000);
    assert.equal(wolfhouseStayDepositRateCents(6, rates, code), 20000);
  }
  assert.equal(wolfhouseStayDepositRateCents(6, { ...rates, nights_threshold: 8 }, 'malibu'), 10000);
});

test('Staff totals and deposit links share the nights rule and keep the total cap', async () => {
  const rates = { nights_threshold: 6, short_stay_cents: 10000, long_stay_cents: 20000 };
  for (const nights of [5, 6]) for (const code of ['package_none', 'malibu']) {
    const booking = { client_slug: 'wolfhouse-somo', check_in: '2027-07-01', check_out: `2027-07-0${nights + 1}`,
      guest_count: 2, package_code: code, total_amount_cents: 90000, deposit_required_cents: 1 };
    const expected = nights < 6 ? 20000 : 40000;
    assert.equal(wolfhouseBookingDepositCents(booking, rates), expected);
    booking.stay_deposit_rates = rates;
    const ledger = async () => ({ invoice_total_cents: 90000 });
    const result = await bookingDepositLinkAmount(null, booking, [], { loadBookingPaymentLedger: ledger });
    assert.equal(result.ok, true);
    assert.equal(result.amountDueCents, expected);
    const capped = await bookingDepositLinkAmount(null, booking, [], {
      loadBookingPaymentLedger: async () => ({ invoice_total_cents: 8000 }),
    });
    assert.equal(capped.amountDueCents, 8000);
  }
});

test('Luna quote amount and per-person deposit use configured nights threshold, capped by priced stay', async () => {
  const t = require('./verify-package-minimum-transport');
  const config = await t.loader(t.syntheticPricingPg({ items: t.policyItems(1) }))();
  config.deposits.nights_threshold = 8;
  config.package_min_nights = 1;
  for (const p of config.packages) p.min_days = 1;
  assert.equal(wolfhouseDepositRatesFromConfig(config).nights_threshold, 8);
  for (const nights of [7, 8]) for (const code of ['package_none', 'malibu']) {
    const quote = calculateWolfhouseQuote({ client_slug: 'wolfhouse-somo', check_in: '2027-07-01', check_out: `2027-07-0${nights + 1}`,
      guest_count: 2, package_code: code, room_type: 'shared', payment_choice: 'deposit', season_code: 'summer' }, config);
    assert.equal(quote.success, true, JSON.stringify(quote));
    const expected = Math.min(quote.total_cents, (nights < 8 ? 10000 : 20000) * 2);
    assert.equal(quote.deposit_required_cents, expected);
    assert.equal(quote.payment_link_amount_cents, expected);
    assert.equal(quote.per_guest_deposits.reduce((n, r) => n + r.deposit_cents, 0), expected);
  }
});
