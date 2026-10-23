'use strict';

// Offline package-driven deposit regressions. The real Staff Pricing loader reads
// explicit synthetic SELECT rows through the existing transport-test adapter.
// No API server, real booking, payment, credentials or external network.
const assert = require('node:assert/strict');
const test = require('node:test');
const transport = require('./verify-package-minimum-transport');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const { computePackagePricePreview } = require('./lib/booking-guests');
const { wolfhouseBookingDepositCents } = require('./lib/wolfhouse-stay-deposit');
const { bookingDepositLinkAmount } = require('./lib/booking-deposit-payment-link');

test('legacy deposit exports stay compatible; the night constant is not a selector', () => {
  const api = require('./lib/wolfhouse-stay-deposit');
  assert.deepEqual(Object.keys(api).sort(), [
    'LONG_STAY_NIGHTS', 'LONG_STAY_RATE_CENTS', 'SHORT_STAY_RATE_CENTS', 'LONG_STAY_TIER', 'SHORT_STAY_TIER',
    'wolfhouseDepositRatesFromConfig', 'normalizeStayDepositRates', 'loadWolfhouseDepositRates',
    'wolfhouseStayNights', 'wolfhouseStayDepositRateCents', 'wolfhouseStayDepositCents', 'wolfhouseBookingDepositCents',
  ].sort());
  assert.equal(api.LONG_STAY_NIGHTS, 6);
  assert.equal(api.wolfhouseStayDepositRateCents(7, null, 'package_none'), 10000);
  assert.equal(api.wolfhouseStayDepositRateCents(3, null, 'waimea'), 20000);
});

async function pricing(minimum = 7) {
  return transport.loader(transport.syntheticPricingPg({ items: transport.policyItems(minimum) }))();
}
const stay = {
  client_slug: 'wolfhouse-somo', check_in: '2026-11-05', check_out: '2026-11-15',
  guest_count: 2, package_code: 'package_none', payment_choice: 'deposit',
};

test('Sim31 shape: two accommodation-only guests owe 200 EUR deposit, not 400 EUR', async () => {
  const quote = calculateWolfhouseQuote(stay, await pricing());
  assert.equal(quote.success, true, JSON.stringify(quote.blockers));
  assert(quote.total_cents > 40000, 'fixture has enough debt to expose the deposit tier');
  assert.equal(quote.deposit_required_cents, 20000);
  assert.equal(quote.payment_link_amount_cents, 20000);
  assert.deepEqual(quote.per_guest_deposits.map(g => g.deposit_cents), [10000, 10000]);
});

test('a Pricing-eligible named package uses package deposit even below six nights', async () => {
  const config = await pricing(3);
  const quote = calculateWolfhouseQuote({ ...stay, check_out: '2026-11-08', package_code: 'waimea' }, config);
  assert.equal(quote.success, true, JSON.stringify(quote.blockers));
  assert(quote.total_cents >= 40000);
  assert.equal(quote.deposit_required_cents, 40000);
});

test('package preview also uses package deposit when Pricing permits a three-night package', async () => {
  const result = computePackagePricePreview({ ...stay, check_out: '2026-11-08' }, await pricing(3));
  assert.equal(result.success, true);
  assert.equal(result.packages.waimea.success, true);
  assert.equal(result.packages.waimea.deposit_per_guest_cents, 20000);
  assert.equal(result.packages.waimea.deposit_total_cents, 40000);
});

test('stored booking package identity survives both Staff and bot metadata shapes', async () => {
  const { package_code, ...booking } = stay;
  const rates = { long_stay_cents: 25750, short_stay_cents: 13225 };
  for (const identity of [
    { package_code: 'waimea' },
    { metadata: { package_code: 'waimea' } },
    { metadata: { quote_snapshot: { package_code: 'waimea' } } },
  ]) {
    assert.equal(wolfhouseBookingDepositCents({ ...booking, ...identity }, rates), 51500);
  }
  assert.equal(wolfhouseBookingDepositCents(stay, rates), 26450);
});

test('mixed booking link amount uses each persisted guest package, not a party-wide tier', async () => {
  const { package_code, ...booking } = stay;
  const guest_packages = [{ guest_number: 1, package_code: 'package_none' }, { guest_number: 2, package_code: 'waimea' }];
  for (const identity of [
    { guest_packages }, { metadata: { guest_packages } },
    { metadata: { quote_snapshot: { guest_packages } } },
  ]) {
    const stored = { ...booking, ...identity, deposit_required_cents: 40000 };
    assert.equal(wolfhouseBookingDepositCents(stored), 30000);
    const amount = await bookingDepositLinkAmount(null, stored, [], {
      loadBookingPaymentLedger: async () => ({ invoice_total_cents: 100000 }),
    });
    assert.deepEqual(amount, { ok: true, amountDueCents: 30000 });
  }
});

test('package selection, headcount and configured cents drive quotes across the former night boundary', async () => {
  const config = await pricing(3);
  config.deposits.tiers.standard_package.amount_cents = 25750;
  config.deposits.tiers.custom_or_short_stay.amount_cents = 13225;
  for (const nights of [1, 3, 5, 6, 7, 10, 14]) for (const guests of [1, 2, 4]) {
    for (const code of ['package_none', 'no_package', 'accommodation_only', 'accommodation-only', 'manual_override', 'malibu', 'uluwatu', 'waimea']) {
      const named = ['malibu', 'uluwatu', 'waimea'].includes(code);
      const input = { ...stay, check_out: `2026-11-${String(5 + nights).padStart(2, '0')}`,
        guest_count: guests, package_code: code, manual_price_per_night_cents: 6000 };
      const quote = calculateWolfhouseQuote(input, config);
      if (named && nights < 3) {
        assert.equal(quote.success, false, 'Pricing eligibility still enforced');
        continue;
      }
      assert.equal(quote.success, true, JSON.stringify({ input, blockers: quote.blockers }));
      const expected = Math.min((named ? 25750 : 13225) * guests, quote.total_cents);
      assert.equal(quote.deposit_required_cents, expected, JSON.stringify(input));
      assert.equal(quote.payment_link_amount_cents, expected);
      assert.equal(quote.per_guest_deposits.reduce((sum, g) => sum + g.deposit_cents, 0), expected);
    }
  }
});

test('preview consumes capped quote deposits, including configured zero and full-payment alternatives', async () => {
  const config = await pricing(1);
  for (const cents of [0, 25750]) {
    config.deposits.tiers.standard_package.amount_cents = cents;
    const input = { ...stay, check_out: '2026-11-06' };
    const preview = computePackagePricePreview(input, config);
    assert.equal(preview.success, true);
    for (const code of ['malibu', 'uluwatu', 'waimea']) {
      const quote = calculateWolfhouseQuote({ ...input, package_code: code }, config);
      const expected = Math.min(cents * 2, quote.total_cents);
      assert.equal(preview.packages[code].deposit_total_cents, expected);
      assert.equal(preview.packages[code].deposit_per_guest_cents, expected / 2);
      const full = calculateWolfhouseQuote({ ...input, package_code: code, payment_choice: 'full' }, config);
      assert.equal(full.deposit_required_cents, expected);
      assert.equal(full.payment_link_amount_cents, full.total_cents);
    }
  }
});

test('mixed quotes and preview use newly configured catalog packages, not a hard-coded name list', async () => {
  const config = await pricing(3);
  config.packages.push({ ...config.packages.find(p => p.code === 'waimea'), code: 'new_wave', name: 'Synthetic package' });
  const guest_packages = [{ guest_number: 2, package_code: 'new_wave' }, { guest_number: 1, package_code: 'package_none' }];
  const quote = calculateWolfhouseQuote({ ...stay, package_code: null, guest_packages }, config);
  assert.equal(quote.success, true, JSON.stringify(quote.blockers));
  assert.deepEqual(quote.per_guest_deposits.map(g => [g.guest_number, g.deposit_cents]), [[2, 20000], [1, 10000]]);
  assert.equal(quote.deposit_required_cents, 30000);
  const preview = computePackagePricePreview(stay, config);
  assert.equal(preview.packages.new_wave.deposit_total_cents, 40000);
});

test('historical per-guest date edits KEEP stored deposit even when package identity changes', () => {
  const original = { ...stay, deposit_required_cents: 23456,
    metadata: { quote_snapshot: { per_guest_dates: true, package_code: 'waimea' } } };
  assert.equal(wolfhouseBookingDepositCents(original, { long_stay_cents: 99999, short_stay_cents: 88888 }), 23456);
  assert.equal(wolfhouseBookingDepositCents({ ...original, deposit_required_cents: 0 }), 0);
  assert.equal(wolfhouseBookingDepositCents({ ...original, deposit_required_cents: null }), null);
});

test('persisted mixed-package link preserves each quoted guest debt ceiling', async () => {
  const input = { ...stay, check_out: '2026-11-08', package_code: null,
    guest_packages: [{ guest_number: 1, package_code: 'malibu' }, { guest_number: 2, package_code: 'waimea' }] };
  const quote = calculateWolfhouseQuote(input, await pricing(3));
  assert.equal(quote.success, true);
  assert.deepEqual(quote.per_guest_deposits.map(g => g.deposit_cents), [13500, 20000]);
  const booking = { ...input, deposit_required_cents: quote.deposit_required_cents,
    metadata: { guest_packages: input.guest_packages, quote_snapshot: quote } };
  const result = await bookingDepositLinkAmount(null, booking, [], {
    loadBookingPaymentLedger: async () => ({ invoice_total_cents: quote.total_cents }),
  });
  assert.deepEqual(result, { ok: true, amountDueCents: 33500 });
  // Current Admin amounts still select the tier; quote subtotals supply only caps.
  assert.equal(wolfhouseBookingDepositCents(booking, { long_stay_cents: 10000, short_stay_cents: 5000 }), 20000);
  assert.equal(wolfhouseBookingDepositCents(booking, { long_stay_cents: 30000, short_stay_cents: 5000 }), 37500);
});

test('persisted guest ceilings bind by guest number and reject incomplete or ambiguous shares', async () => {
  const input = { ...stay, check_out: '2026-11-08', package_code: null,
    guest_packages: [{ guest_number: 2, package_code: 'waimea' }, { guest_number: 1, package_code: 'package_none' }] };
  const quote = calculateWolfhouseQuote(input, await pricing(3));
  const rates = { long_stay_cents: 30000, short_stay_cents: 10000 };
  const booking = { ...input, stay_deposit_rates: rates, metadata: { quote_snapshot: quote } };
  assert.equal(wolfhouseBookingDepositCents(booking), 34000);
  const reversed = structuredClone(booking);
  reversed.metadata.quote_snapshot.per_person.reverse();
  assert.equal(wolfhouseBookingDepositCents(reversed), 34000);
  for (const shares of [[], 'invalid', [quote.per_person[0]],
    [quote.per_person[0], quote.per_person[0]],
    quote.per_person.map(p => ({ ...p, subtotal_cents: -1 })),
    quote.per_person.map(p => ({ ...p, subtotal_cents: null })),
    quote.per_person.map(p => ({ ...p, guest_number: 99 })),
    quote.per_person.map(p => ({ ...p, package_code: 'unrelated_package' }))]) {
    const invalid = { ...booking, metadata: { quote_snapshot: { ...quote, per_person: shares } } };
    assert.equal(wolfhouseBookingDepositCents(invalid), null);
    const rejected = await bookingDepositLinkAmount(null, invalid, [], {
      loadBookingPaymentLedger: async () => { throw new Error('unknown deposit must not reach ledger'); },
    });
    assert.equal(rejected.body.reason_code, 'deposit_configuration_unknown');
  }
  const due = await bookingDepositLinkAmount(null, booking, [{ payment_status: 'paid', amount_paid_cents: 1000 }], {
    loadBookingPaymentLedger: async () => ({ invoice_total_cents: quote.total_cents }),
  });
  assert.deepEqual(due, { ok: true, amountDueCents: 33000 });
});

test('booking link amount caps at invoice debt and subtracts actual paid receipts', async () => {
  for (const [total, paid, expected] of [[90000, 0, 20000], [90000, 5000, 15000], [14000, 5000, 9000]]) {
    const result = await bookingDepositLinkAmount(null, stay, [{ payment_status: 'paid', amount_paid_cents: paid }], {
      loadBookingPaymentLedger: async () => ({ invoice_total_cents: total }),
    });
    assert.deepEqual(result, { ok: true, amountDueCents: expected });
  }
});
