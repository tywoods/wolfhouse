'use strict';

/**
 * verify:sunset-rental-bundle-integrity
 *
 * TDD gate for board_and_suit_rental bundle quote → booking → payment integrity.
 * Uses owner config prices (no hard-coded €15/€30). No DB, network, or Stripe.
 *
 * Run:
 *   node scripts/verify-sunset-rental-bundle-integrity.js
 */

const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const {
  validateScheduleBookingBody,
  normalizeRentalDuration,
  normalizeRentalPricing,
} = require('./lib/sunset-schedule-booking-writes');
const {
  findPriceCents,
  configuredRentalBundleTotalCents,
  parseRentalPricingMeta,
  priceSunsetBookingServices,
  serviceRecordUnitPriceCents,
  isBundleRentalServiceRow,
  BOARD_AND_SUIT_OFFERING_KEY,
} = require('./lib/sunset-stripe-payment-links');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const PRICES = resolveTenantBusinessConfig('sunset', 'sunset-somo').prices;

const bundleBody = {
  guest_name: 'Alex',
  payment_status: 'unpaid',
  service_date: '2026-07-20',
  components: { surfboard: { quantity: 2 }, wetsuit: { quantity: 2 } },
  rental_pricing: {
    offering_key: 'board_and_suit_rental',
    duration: 'half_day',
    quantity: 2,
    quoted_total_cents: 3000,
  },
};

console.log('\nverify:sunset-rental-bundle-integrity — bundle quote/payment integrity\n');

console.log('[1] Duration normalization');
assert('half day → half_day', normalizeRentalDuration('half day') === 'half_day');
assert('half-day → half_day', normalizeRentalDuration('half-day') === 'half_day');
assert('half_day preserved', normalizeRentalDuration('half_day') === 'half_day');

console.log('\n[2] Validation + descriptor survival');
const validated = validateScheduleBookingBody(bundleBody);
assert('bundle body validates', validated.ok === true, validated.error);
assert('rental_pricing preserved in validated value',
  validated.ok && validated.value.rental_pricing
  && validated.value.rental_pricing.offering_key === 'board_and_suit_rental'
  && validated.value.rental_pricing.duration === 'half_day'
  && validated.value.rental_pricing.quantity === 2
  && validated.value.rental_pricing.quoted_total_cents === 3000);

const badQty = normalizeRentalPricing(
  { offering_key: 'board_and_suit_rental', duration: 'half_day', quantity: 2, quoted_total_cents: 3000 },
  { surfboard: { quantity: 2 }, wetsuit: { quantity: 1 } },
);
assert('mismatched component qty rejected', badQty.ok === false);

const noComponents = normalizeRentalPricing(
  { offering_key: 'board_and_suit_rental', duration: 'half_day', quantity: 2, quoted_total_cents: 3000 },
  { surfboard: { quantity: 2 } },
);
assert('missing wetsuit component rejected', noComponents.ok === false);

const legacyBody = {
  guest_name: 'Legacy',
  payment_status: 'unpaid',
  service_date: '2026-07-20',
  components: { surfboard: { quantity: 1 } },
};
const legacyValidated = validateScheduleBookingBody(legacyBody);
assert('requests without rental_pricing remain valid', legacyValidated.ok === true);
assert('legacy has no rental_pricing', legacyValidated.ok && !legacyValidated.value.rental_pricing);

console.log('\n[3] Owner-config bundle totals (not independent board+wetsuit sum)');
const halfDayBundle = configuredRentalBundleTotalCents(PRICES, {
  offering_key: 'board_and_suit_rental',
  duration: 'half_day',
  quantity: 2,
});
assert('board_and_suit half_day qty2 = 3000 cents from config', halfDayBundle === 3000, String(halfDayBundle));

const oneDayBundle = configuredRentalBundleTotalCents(PRICES, {
  offering_key: 'board_and_suit_rental',
  duration: '1_day',
  quantity: 2,
});
assert('board_and_suit 1_day qty2 = 4000 cents (duration honored)', oneDayBundle === 4000, String(oneDayBundle));
assert('half_day ≠ 1_day bundle totals', halfDayBundle !== oneDayBundle);

const boardAlone = findPriceCents(PRICES, 'rental', 'board_rental', '1_day') * 2;
const suitAlone = findPriceCents(PRICES, 'rental', 'wetsuit_rental', '1_day') * 2;
const independentSum = boardAlone + suitAlone;
assert('independent 1_day board+wetsuit would overcharge vs bundle',
  independentSum !== halfDayBundle && independentSum > halfDayBundle,
  `independent=${independentSum} bundle=${halfDayBundle}`);

const surfboardRow = { service_type: 'surfboard', quantity: 2, metadata: '{}' };
const wetsuitRow = { service_type: 'wetsuit', quantity: 2, metadata: '{}' };
const wrongIndependentTotal = serviceRecordUnitPriceCents(PRICES, surfboardRow)
  + serviceRecordUnitPriceCents(PRICES, wetsuitRow);
assert('legacy per-row pricing sums board+wetsuit at 1_day (reproduces €46-class bug)',
  wrongIndependentTotal === 5000, String(wrongIndependentTotal));

console.log('\n[4] Quote mismatch rejected before payment pricing');
const mismatchMeta = parseRentalPricingMeta({
  rental_pricing: {
    offering_key: 'board_and_suit_rental',
    duration: 'half_day',
    quantity: 2,
    quoted_total_cents: 4600,
  },
});
assert('mismatch meta parsed', mismatchMeta && mismatchMeta.quoted_total_cents === 4600);

function mockPgForBundle(opts) {
  const updates = [];
  const bookingMeta = opts.bookingMeta || {};
  const rows = opts.rows || [];
  return {
    updates,
    query: async (sql, params) => {
      const s = String(sql);
      if (/SELECT metadata FROM bookings/i.test(s)) {
        return { rows: [{ metadata: bookingMeta }] };
      }
      if (/SELECT id, service_type/i.test(s) && /booking_service_records/i.test(s)) {
        return { rows };
      }
      if (/UPDATE booking_service_records SET amount_due_cents/i.test(s)) {
        updates.push({ id: params[1], amount_due_cents: params[0] });
        return { rows: [] };
      }
      if (/UPDATE bookings/i.test(s)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

(async () => {
  const bundleRows = [
    { id: 'sr-board', service_type: 'surfboard', quantity: 2, amount_due_cents: 0, metadata: '{}' },
    { id: 'sr-suit', service_type: 'wetsuit', quantity: 2, amount_due_cents: 0, metadata: '{}' },
  ];
  const pgMismatch = mockPgForBundle({
    bookingMeta: { rental_pricing: mismatchMeta, location_id: 'sunset-somo' },
    rows: bundleRows,
  });
  const mismatchResult = await priceSunsetBookingServices(pgMismatch, 'sunset', 'booking-1');
  assert('quote mismatch returns rental_pricing_quote_mismatch',
    mismatchResult.ok === false && mismatchResult.error === 'rental_pricing_quote_mismatch');
  assert('mismatch blocks before payment insert (no booking total update)',
    pgMismatch.updates.length === 0);

  const pgOk = mockPgForBundle({
    bookingMeta: {
      rental_pricing: {
        offering_key: 'board_and_suit_rental',
        duration: 'half_day',
        quantity: 2,
        quoted_total_cents: 3000,
      },
      location_id: 'sunset-somo',
    },
    rows: bundleRows,
  });
  const priced = await priceSunsetBookingServices(pgOk, 'sunset', 'booking-2');
  assert('bundle pricing succeeds', priced.ok === true, priced.error);
  assert('booking total is 3000', priced.total_cents === 3000, String(priced.total_cents));
  const rowSum = pgOk.updates.reduce((acc, row) => acc + row.amount_due_cents, 0);
  assert('service-row due amounts sum to 3000', rowSum === 3000, String(rowSum));
  assert('bundle total applied once (companion row zero)',
    pgOk.updates.some((u) => u.amount_due_cents === 3000)
    && pgOk.updates.some((u) => u.amount_due_cents === 0));

  const rentalPricing = {
    offering_key: 'board_and_suit_rental',
    duration: 'half_day',
    quantity: 2,
  };
  assert('isBundleRentalServiceRow surfboard', isBundleRentalServiceRow({ service_type: 'surfboard' }, rentalPricing));
  assert('isBundleRentalServiceRow wetsuit', isBundleRentalServiceRow({ service_type: 'wetsuit' }, rentalPricing));
  assert('isBundleRentalServiceRow false for lesson',
    !isBundleRentalServiceRow({ service_type: 'surf_lesson' }, rentalPricing));

  console.log(`\n── verify:sunset-rental-bundle-integrity ${fail ? 'FAILED' : 'PASSED'} (${pass}/${pass + fail}) ──\n`);
  if (fail > 0) process.exit(1);
})().catch((err) => {
  console.error('verify:sunset-rental-bundle-integrity — fatal:', err.stack || err.message);
  process.exit(1);
});
