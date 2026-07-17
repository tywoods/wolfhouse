'use strict';

/**
 * verify:sunset-rental-bundle-integrity
 *
 * TDD gate for board_and_suit_rental bundle quote → booking → payment integrity.
 * Uses owner config prices (no hard-coded €15/€30). Mocks PG + Stripe for checkout path.
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
  createSunsetScheduleStripeLink,
  serviceRecordUnitPriceCents,
  isBundleRentalServiceRow,
  BOARD_AND_SUIT_OFFERING_KEY,
} = require('./lib/sunset-stripe-payment-links');
const { buildPaymentSummary } = require('./lib/sunset-schedule-booking-drawer');

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
const BOOKING_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CLIENT_ID = 'cccccccc-dddd-eeee-ffff-000000000001';
const GROUP_ID = 'pg1234567890abcdef';

function bundleDescriptor(overrides) {
  return {
    pricing_group_id: GROUP_ID,
    offering_key: 'board_and_suit_rental',
    duration: 'half_day',
    quantity: 2,
    service_date: '2026-07-20',
    components: ['surfboard', 'wetsuit'],
    quoted_total_cents: 3000,
    ...(overrides || {}),
  };
}

function rowMeta(pricingGroupId, component) {
  return JSON.stringify({
    pricing_group_id: pricingGroupId,
    rental_pricing_role: component,
    location_id: 'sunset-somo',
  });
}

function bundleRows(opts) {
  const gid = opts && opts.pricing_group_id != null ? opts.pricing_group_id : GROUP_ID;
  const qty = opts && opts.quantity != null ? opts.quantity : 2;
  const date = opts && opts.service_date != null ? opts.service_date : '2026-07-20';
  const rows = [
    {
      id: 'sr-board',
      service_type: 'surfboard',
      service_date: date,
      quantity: qty,
      amount_due_cents: 0,
      metadata: rowMeta(gid, 'surfboard'),
    },
    {
      id: 'sr-suit',
      service_type: 'wetsuit',
      service_date: date,
      quantity: qty,
      amount_due_cents: 0,
      metadata: rowMeta(gid, 'wetsuit'),
    },
  ];
  if (opts && opts.extraBoard) {
    rows.push({
      id: 'sr-board-extra',
      service_type: 'surfboard',
      service_date: date,
      quantity: 1,
      amount_due_cents: 0,
      metadata: JSON.stringify({ location_id: 'sunset-somo' }),
    });
  }
  if (opts && opts.extraGroupedBoard) {
    rows.push({
      id: 'sr-board-extra-grouped',
      service_type: 'surfboard',
      service_date: date,
      quantity: qty,
      amount_due_cents: 0,
      metadata: rowMeta(gid, 'surfboard'),
    });
  }
  if (opts && opts.missingWetsuit) {
    return rows.filter((r) => r.service_type !== 'wetsuit');
  }
  if (opts && opts.boardDate) {
    rows[0].service_date = opts.boardDate;
  }
  if (opts && opts.suitDate) {
    rows[1].service_date = opts.suitDate;
  }
  if (opts && opts.boardQty != null) rows[0].quantity = opts.boardQty;
  if (opts && opts.suitQty != null) rows[1].quantity = opts.suitQty;
  if (opts && opts.boardGroupId != null) rows[0].metadata = rowMeta(opts.boardGroupId, 'surfboard');
  if (opts && opts.suitGroupId != null) rows[1].metadata = rowMeta(opts.suitGroupId, 'wetsuit');
  return rows;
}

function mockPgForBundle(opts) {
  const updates = [];
  const bookingUpdates = [];
  const paymentInserts = [];
  const bookingMeta = opts.bookingMeta || {};
  const rows = opts.rows || [];
  const bookingTotals = { total_amount_cents: 0, balance_due_cents: 0, amount_paid_cents: 0 };
  let inTxn = false;
  let rolledBack = false;
  return {
    updates,
    bookingUpdates,
    paymentInserts,
    bookingTotals,
    rolledBack: () => rolledBack,
    query: async (sql, params) => {
      const s = String(sql);
      if (/^BEGIN/i.test(s)) {
        inTxn = true;
        return { rows: [] };
      }
      if (/^COMMIT/i.test(s)) {
        inTxn = false;
        return { rows: [] };
      }
      if (/^ROLLBACK/i.test(s)) {
        inTxn = false;
        rolledBack = true;
        return { rows: [] };
      }
      if (/SELECT metadata FROM bookings/i.test(s)) {
        return { rows: [{ metadata: bookingMeta }] };
      }
      if (/SELECT b\.id::text AS booking_id/i.test(s)) {
        return {
          rows: [{
            booking_id: BOOKING_ID,
            booking_code: 'SUNSET-TEST-001',
            guest_name: 'Alex',
            status: 'payment_pending',
            payment_status: 'waiting_payment',
            check_in: '2026-07-20',
            check_out: '2026-07-21',
            metadata: bookingMeta,
          }],
        };
      }
      if (/FROM booking_service_records/i.test(s) && /SELECT id::text AS service_record_id/i.test(s)) {
        return { rows: rows.map((r) => ({ ...r, service_record_id: r.id })) };
      }
      if (/SELECT id, service_type/i.test(s) && /booking_service_records/i.test(s)) {
        return { rows };
      }
      if (/UPDATE booking_service_records SET amount_due_cents/i.test(s)) {
        updates.push({ id: params[1], amount_due_cents: params[0] });
        const row = rows.find((r) => String(r.id) === String(params[1]));
        if (row) row.amount_due_cents = params[0];
        return { rows: [] };
      }
      if (/UPDATE bookings[\s\S]*total_amount_cents/i.test(s)) {
        bookingUpdates.push({ total_amount_cents: params[0] });
        bookingTotals.total_amount_cents = params[0];
        bookingTotals.balance_due_cents = Math.max(params[0] - bookingTotals.amount_paid_cents, 0);
        return { rows: [] };
      }
      if (/SELECT id FROM clients WHERE slug/i.test(s)) {
        return { rows: [{ id: CLIENT_ID }] };
      }
      if (/FROM payments/i.test(s) && /checkout_url IS NOT NULL/i.test(s)) {
        return { rows: [] };
      }
      if (/INSERT INTO payments/i.test(s)) {
        paymentInserts.push({
          amount_due_cents: params[2],
          metadata: params[3],
        });
        return { rows: [{ payment_id: 'pay-test-001' }] };
      }
      if (/UPDATE payments[\s\S]*stripe_checkout_session_id/i.test(s)) {
        return { rows: [] };
      }
      if (/UPDATE bookings[\s\S]*payment_status/i.test(s)) {
        return { rows: [] };
      }
      if (/metadata->>'idempotency_key'/i.test(s)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

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

const multiDateBody = {
  ...bundleBody,
  service_dates: ['2026-07-20', '2026-07-21'],
  service_date: undefined,
};
const multiDateValidated = validateScheduleBookingBody(multiDateBody);
assert('multi-date rental_pricing request rejected',
  multiDateValidated.ok === false, multiDateValidated.error);

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
const mismatchMeta = bundleDescriptor({ quoted_total_cents: 2900 });
assert('mismatch meta parsed', mismatchMeta && mismatchMeta.quoted_total_cents === 2900);

(async () => {
  const validRows = bundleRows();
  const pgMismatch = mockPgForBundle({
    bookingMeta: { rental_pricing: mismatchMeta, location_id: 'sunset-somo', staff_manual_schedule: true, source: 'staff_manual_schedule' },
    rows: validRows,
  });
  const mismatchResult = await priceSunsetBookingServices(pgMismatch, 'sunset', BOOKING_ID);
  assert('quote mismatch returns rental_pricing_quote_mismatch',
    mismatchResult.ok === false && mismatchResult.error === 'rental_pricing_quote_mismatch');
  assert('mismatch leaves service rows unpriced', pgMismatch.updates.length === 0);
  assert('mismatch leaves booking totals unpriced', pgMismatch.bookingUpdates.length === 0);

  console.log('\n[5] Exact pricing-group bundle pricing (no service_type-only matching)');
  const pgOk = mockPgForBundle({
    bookingMeta: {
      rental_pricing: bundleDescriptor(),
      location_id: 'sunset-somo',
      staff_manual_schedule: true,
      source: 'staff_manual_schedule',
    },
    rows: validRows,
  });
  const priced = await priceSunsetBookingServices(pgOk, 'sunset', BOOKING_ID);
  assert('bundle pricing succeeds', priced.ok === true, priced.error);
  assert('booking total is 3000', priced.total_cents === 3000, String(priced.total_cents));
  const rowSum = pgOk.updates.reduce((acc, row) => acc + row.amount_due_cents, 0);
  assert('service-row due amounts sum to 3000', rowSum === 3000, String(rowSum));
  assert('bundle total applied once (companion row zero)',
    pgOk.updates.some((u) => u.amount_due_cents === 3000)
    && pgOk.updates.some((u) => u.amount_due_cents === 0));

  const rentalPricing = bundleDescriptor();
  assert('isBundleRentalServiceRow surfboard with group id',
    isBundleRentalServiceRow(validRows[0], rentalPricing));
  assert('isBundleRentalServiceRow wetsuit with group id',
    isBundleRentalServiceRow(validRows[1], rentalPricing));
  assert('isBundleRentalServiceRow false without pricing_group_id row metadata',
    !isBundleRentalServiceRow({ service_type: 'surfboard', metadata: '{}' }, rentalPricing));
  assert('isBundleRentalServiceRow false for lesson',
    !isBundleRentalServiceRow({ service_type: 'surf_lesson', metadata: rowMeta(GROUP_ID, 'surfboard') }, rentalPricing));

  console.log('\n[6] Malformed / tampered pricing groups fail closed');
  const cases = [
    { label: 'missing wetsuit row', rows: bundleRows({ missingWetsuit: true }) },
    { label: 'extra grouped surfboard row', rows: bundleRows({ extraGroupedBoard: true }) },
    { label: 'quantity mismatch', rows: bundleRows({ boardQty: 1 }) },
    { label: 'different service dates', rows: bundleRows({ boardDate: '2026-07-20', suitDate: '2026-07-21' }) },
    { label: 'different pricing_group_id on rows', rows: bundleRows({ boardGroupId: 'other-group-a', suitGroupId: 'other-group-b' }) },
    { label: 'tampered booking metadata missing pricing_group_id', meta: { offering_key: 'board_and_suit_rental', duration: 'half_day', quantity: 2, quoted_total_cents: 3000 }, rows: validRows },
  ];
  for (const c of cases) {
    const meta = c.meta || bundleDescriptor();
    const pgBad = mockPgForBundle({
      bookingMeta: { rental_pricing: meta, location_id: 'sunset-somo' },
      rows: c.rows,
    });
    const bad = await priceSunsetBookingServices(pgBad, 'sunset', BOOKING_ID);
    assert(`${c.label} → rental_pricing_group_invalid`,
      bad.ok === false && bad.error === 'rental_pricing_group_invalid', bad.error);
  }

  console.log('\n[7] Bundle plus standalone board — standalone not zeroed');
  const pgMixed = mockPgForBundle({
    bookingMeta: {
      rental_pricing: bundleDescriptor(),
      location_id: 'sunset-somo',
      staff_manual_schedule: true,
      source: 'staff_manual_schedule',
    },
    rows: bundleRows({ extraBoard: true }),
  });
  const mixed = await priceSunsetBookingServices(pgMixed, 'sunset', BOOKING_ID);
  assert('bundle + standalone board pricing succeeds', mixed.ok === true, mixed.error);
  const standaloneUpdate = pgMixed.updates.find((u) => u.id === 'sr-board-extra');
  assert('standalone board keeps independent non-zero amount',
    standaloneUpdate && standaloneUpdate.amount_due_cents > 0,
    standaloneUpdate ? String(standaloneUpdate.amount_due_cents) : 'missing');
  const mixedSum = pgMixed.updates.reduce((acc, row) => acc + row.amount_due_cents, 0);
  assert('bundle + standalone total exceeds bundle-only 3000', mixedSum > 3000, String(mixedSum));

  console.log('\n[8] Extra/mismatched rows must not be zeroed by service_type-only matching');
  const pgExtra = mockPgForBundle({
    bookingMeta: { rental_pricing: bundleDescriptor(), location_id: 'sunset-somo' },
    rows: [
      ...validRows,
      {
        id: 'sr-board-day2',
        service_type: 'surfboard',
        service_date: '2026-07-21',
        quantity: 2,
        amount_due_cents: 0,
        metadata: JSON.stringify({ location_id: 'sunset-somo' }),
      },
      {
        id: 'sr-suit-day2',
        service_type: 'wetsuit',
        service_date: '2026-07-21',
        quantity: 2,
        amount_due_cents: 0,
        metadata: JSON.stringify({ location_id: 'sunset-somo' }),
      },
    ],
  });
  const extraPriced = await priceSunsetBookingServices(pgExtra, 'sunset', BOOKING_ID);
  assert('multi-date extra board/wetsuit rows priced independently (not zeroed)',
    extraPriced.ok === true, extraPriced.error);
  const day2Board = pgExtra.updates.find((u) => u.id === 'sr-board-day2');
  const day2Suit = pgExtra.updates.find((u) => u.id === 'sr-suit-day2');
  assert('day-2 surfboard not zeroed', day2Board && day2Board.amount_due_cents > 0);
  assert('day-2 wetsuit not zeroed', day2Suit && day2Suit.amount_due_cents > 0);

  console.log('\n[9] Stripe checkout path proves outgoing amount (3000 cents)');
  let stripeFetchCount = 0;
  let stripeBody = '';
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('api.stripe.com/v1/checkout/sessions')) {
      stripeFetchCount += 1;
      stripeBody = init && init.body ? String(init.body) : '';
      return {
        ok: true,
        json: async () => ({
          id: 'cs_test_bundle_3000',
          url: 'https://checkout.stripe.com/c/pay/cs_test_bundle_3000',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          livemode: false,
        }),
      };
    }
    return origFetch(url, init);
  };

  const pgStripe = mockPgForBundle({
    bookingMeta: {
      rental_pricing: bundleDescriptor(),
      location_id: 'sunset-somo',
      staff_manual_schedule: true,
      source: 'staff_manual_schedule',
    },
    rows: validRows.map((r) => ({ ...r })),
  });

  const stripeResult = await createSunsetScheduleStripeLink(pgStripe, {
    clientSlug: 'sunset',
    bookingId: BOOKING_ID,
    locationId: 'sunset-somo',
    staffActionsEnabled: true,
    stripeLinksEnabled: true,
    stripeSecretKey: 'sk_test_bundle_integrity',
    stripeSuccessUrl: 'https://example.com/success',
    stripeCancelUrl: 'https://example.com/cancel',
    actor: { email: 'staff@test.local' },
  });

  global.fetch = origFetch;

  assert('Stripe checkout creation succeeds', stripeResult.ok === true, stripeResult.body && stripeResult.body.error);
  assert('API response amount_due_cents is 3000',
    stripeResult.body && stripeResult.body.amount_due_cents === 3000);
  assert('payment INSERT amount_due_cents is 3000',
    pgStripe.paymentInserts.length === 1 && pgStripe.paymentInserts[0].amount_due_cents === 3000);
  assert('booking total_amount_cents is 3000', pgStripe.bookingTotals.total_amount_cents === 3000);
  assert('booking balance_due_cents is 3000', pgStripe.bookingTotals.balance_due_cents === 3000);
  const svcSum = pgStripe.updates.reduce((acc, row) => acc + row.amount_due_cents, 0);
  assert('service-row due sum is 3000', svcSum === 3000, String(svcSum));
  assert('Stripe fetch called exactly once', stripeFetchCount === 1, String(stripeFetchCount));
  const stripeParams = decodeURIComponent(stripeBody);
  assert('Stripe currency is EUR', /\[currency\]=eur/i.test(stripeParams));
  assert('Stripe aggregate unit_amount is 3000', /\[unit_amount\]=3000/.test(stripeParams));
  assert('Stripe line item quantity is 1',
    /line_items%5B0%5D%5Bquantity%5D=1/.test(stripeBody) || /quantity%5D=1/.test(stripeBody));
  assert('Stripe response payment_id persisted',
    stripeResult.body && stripeResult.body.payment_id === 'pay-test-001');

  console.log('\n[10] Mismatch path — no payment INSERT, no Stripe fetch, txn rolls back');
  stripeFetchCount = 0;
  stripeBody = '';
  global.fetch = async (url) => {
    if (String(url).includes('api.stripe.com')) {
      stripeFetchCount += 1;
      return { ok: true, json: async () => ({ id: 'cs_should_not_run' }) };
    }
    return origFetch(url);
  };
  const pgStripeMismatch = mockPgForBundle({
    bookingMeta: {
      rental_pricing: bundleDescriptor({ quoted_total_cents: 2900 }),
      location_id: 'sunset-somo',
      staff_manual_schedule: true,
      source: 'staff_manual_schedule',
    },
    rows: validRows.map((r) => ({ ...r })),
  });
  const stripeMismatch = await createSunsetScheduleStripeLink(pgStripeMismatch, {
    clientSlug: 'sunset',
    bookingId: BOOKING_ID,
    locationId: 'sunset-somo',
    staffActionsEnabled: true,
    stripeLinksEnabled: true,
    stripeSecretKey: 'sk_test_bundle_integrity',
    stripeSuccessUrl: 'https://example.com/success',
    stripeCancelUrl: 'https://example.com/cancel',
  });
  global.fetch = origFetch;
  assert('checkout mismatch returns rental_pricing_quote_mismatch',
    stripeMismatch.ok === false && stripeMismatch.body && stripeMismatch.body.error === 'rental_pricing_quote_mismatch');
  assert('mismatch has no payment INSERT', pgStripeMismatch.paymentInserts.length === 0);
  assert('mismatch has no Stripe fetch', stripeFetchCount === 0);
  assert('mismatch rolls back transaction', pgStripeMismatch.rolledBack());

  console.log('\n[11] Drawer payment summary — bundled rentals charge once (no live reprice of zero peer)');
  const bundleLivePrices = [
    { category: 'rental', offering_key: 'board_rental', unit: '1_day', amount: 65.12, active: true },
    { category: 'rental', offering_key: 'wetsuit_rental', unit: '1_day', amount: 65.12, active: true },
    { category: 'rental', offering_key: 'board_and_suit_rental', unit: '1_day', amount: 65.12, active: true },
  ];
  const rentalPricingMeta = bundleDescriptor({ quoted_total_cents: 6512 });
  // Canonical create accounting: lexicographic primary carries bundle total; peer is explicit 0.
  const primarySr = {
    service_record_id: 'sr-board-a',
    service_type: 'surfboard',
    service_date: '2026-07-18',
    quantity: 1,
    amount_due_cents: 6512,
    metadata: JSON.stringify({
      component: 'surfboard',
      pricing_group_id: GROUP_ID,
      location_id: 'sunset-somo',
    }),
  };
  const peerSr = {
    service_record_id: 'sr-suit-b',
    service_type: 'wetsuit',
    service_date: '2026-07-18',
    quantity: 1,
    amount_due_cents: 0,
    metadata: JSON.stringify({
      component: 'wetsuit',
      pricing_group_id: GROUP_ID,
      location_id: 'sunset-somo',
    }),
  };
  const bundleBooking = {
    payment_status: 'unpaid',
    total_amount_cents: 6512,
    amount_paid_cents: 0,
    balance_due_cents: 6512,
    metadata: {
      rental_pricing: rentalPricingMeta,
      location_id: 'sunset-somo',
      sunset_price_source: 'admin_db',
    },
  };
  const doubledIfLive = buildPaymentSummary(
    bundleLivePrices,
    bundleBooking,
    [primarySr, peerSr],
    'admin_db',
    0,
    { ok: true, source: 'admin_db', prices: bundleLivePrices },
  );
  const lineSum = (doubledIfLive.line_items || []).reduce((a, li) => a + Number(li.line_cents || 0), 0);
  assert('bundle drawer line sum equals authoritative 6512', lineSum === 6512, String(lineSum));
  assert('bundle drawer subtotal equals 6512', doubledIfLive.subtotal_cents === 6512, String(doubledIfLive.subtotal_cents));
  assert('bundle drawer total equals 6512', doubledIfLive.total_cents === 6512, String(doubledIfLive.total_cents));
  assert('bundle drawer balance equals 6512', doubledIfLive.balance_due_cents === 6512, String(doubledIfLive.balance_due_cents));
  assert('bundle drawer does not double to 13024', doubledIfLive.total_cents !== 13024);
  assert(
    'primary line carries 6512',
    doubledIfLive.line_items.some((li) => li.service_record_id === 'sr-board-a' && li.line_cents === 6512),
  );
  assert(
    'zero peer stays visible at 0 (not live-repriced)',
    doubledIfLive.line_items.some((li) => li.service_record_id === 'sr-suit-b' && li.line_cents === 0 && li.priced_live !== true),
  );
  assert('bundle drawer stays unpaid', doubledIfLive.payment_status === 'unpaid');

  // Independent board + wetsuit offerings remain separately chargeable.
  const independentBoardSuit = buildPaymentSummary(
    bundleLivePrices,
    {
      payment_status: 'unpaid',
      total_amount_cents: 13024,
      amount_paid_cents: 0,
      balance_due_cents: 13024,
      metadata: { location_id: 'sunset-somo' },
    },
    [
      { ...primarySr, amount_due_cents: 6512, metadata: JSON.stringify({ component: 'surfboard', location_id: 'sunset-somo' }) },
      { ...peerSr, amount_due_cents: 6512, metadata: JSON.stringify({ component: 'wetsuit', location_id: 'sunset-somo' }) },
    ],
    'admin_db',
    0,
    { ok: true, source: 'admin_db', prices: bundleLivePrices },
  );
  assert('independent board+wetsuit sum to 13024', independentBoardSuit.total_cents === 13024, String(independentBoardSuit.total_cents));

  // Mixed course + rental retains complete line provenance.
  const coursePlusBundle = buildPaymentSummary(
    [
      ...bundleLivePrices,
      { category: 'lesson', offering_key: 'group_lesson_adult', unit: 'single_lesson', amount: 45, active: true },
    ],
    {
      payment_status: 'unpaid',
      total_amount_cents: 11012,
      amount_paid_cents: 0,
      balance_due_cents: 11012,
      metadata: { location_id: 'sunset-somo' },
    },
    [
      {
        service_record_id: 'sr-course',
        service_type: 'surf_lesson',
        service_date: '2026-07-18',
        quantity: 1,
        amount_due_cents: 4500,
        metadata: JSON.stringify({ component: 'course', course_label: 'Curso', course_id: 'c1' }),
        course_label: 'Curso',
      },
      primarySr,
      peerSr,
    ],
    'admin_db',
    0,
    { ok: true, source: 'admin_db', prices: bundleLivePrices },
  );
  assert('mixed course+bundle line count is 3', coursePlusBundle.line_items.length === 3, String(coursePlusBundle.line_items.length));
  assert('mixed course+bundle total is 11012', coursePlusBundle.total_cents === 11012, String(coursePlusBundle.total_cents));
  assert('mixed keeps course line at 4500', coursePlusBundle.line_items.some((li) => li.service_record_id === 'sr-course' && li.line_cents === 4500));
  assert('mixed keeps zero peer at 0', coursePlusBundle.line_items.some((li) => li.service_record_id === 'sr-suit-b' && li.line_cents === 0));

  // Ambiguous legacy: null amounts on bundle constituents — do not invent live allocation.
  const ambiguousBundle = buildPaymentSummary(
    bundleLivePrices,
    {
      payment_status: 'unpaid',
      total_amount_cents: 6512,
      amount_paid_cents: 0,
      balance_due_cents: 6512,
      metadata: { rental_pricing: rentalPricingMeta, location_id: 'sunset-somo' },
    },
    [
      { ...primarySr, amount_due_cents: null },
      { ...peerSr, amount_due_cents: null },
    ],
    'admin_db',
    0,
    { ok: true, source: 'admin_db', prices: bundleLivePrices },
  );
  assert(
    'ambiguous bundle peers are not live-doubled',
    ambiguousBundle.total_cents === 6512 && !(ambiguousBundle.line_items || []).some((li) => li.priced_live),
    `total=${ambiguousBundle.total_cents} live=${JSON.stringify(ambiguousBundle.line_items)}`,
  );
  assert(
    'ambiguous uses server booking total for money',
    ambiguousBundle.subtotal_cents === 6512 && ambiguousBundle.balance_due_cents === 6512,
  );

  console.log(`\n── verify:sunset-rental-bundle-integrity ${fail ? 'FAILED' : 'PASSED'} (${pass}/${pass + fail}) ──\n`);
  if (fail > 0) process.exit(1);
})().catch((err) => {
  console.error('verify:sunset-rental-bundle-integrity — fatal:', err.stack || err.message);
  process.exit(1);
});
