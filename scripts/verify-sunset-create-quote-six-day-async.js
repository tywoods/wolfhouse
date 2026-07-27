'use strict';

/**
 * verify:sunset-create-quote-six-day-async
 *
 * Focused regression: Staff Create authenticated async quote path must resolve
 * board_and_suit_rental__6_days (+ duration/tier 6_days) to Admin 11500 cents,
 * never silent 1_day / 2000 while preserving a 6_days label.
 *
 * Boundary under test:
 *   browser rentals[] → executeSunsetQuote → quoteOfferingLine
 *   → resolveActiveSunsetAdminPrice → resolveSunsetPriceIdentity
 *   → tenant_price_rules loadRule (mocked)
 *
 * No live DB / Stripe.
 *
 * Run:
 *   node scripts/verify-sunset-create-quote-six-day-async.js
 */

process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

const assert = require('assert');
const { resolveSunsetPriceIdentity } = require('./lib/sunset-admin-price-identity');
const { resolveActiveSunsetAdminPrice } = require('./lib/sunset-admin-price-resolve');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuote,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');
const {
  configuredRentalBundleTotalCents,
  createSunsetScheduleStripeLink,
} = require('./lib/sunset-stripe-payment-links');

const ONE_DAY_CENTS = 2000;
const SIX_DAY_CENTS = 11500;
const LOC = 'sunset-somo';
const PRICES = Object.freeze({
  board_and_suit_rental__1_day: ONE_DAY_CENTS,
  board_and_suit_rental__6_days: SIX_DAY_CENTS,
});

let pass = 0;
function check(label, condition, detail) {
  assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`);
  pass += 1;
  console.log(`  PASS  ${label}`);
}

function adminCfgFixture() {
  return {
    ok: true,
    source: 'db',
    prices: [
      {
        category: 'rental',
        offering_key: 'board_and_suit_rental__1_day',
        item_code: 'board_and_suit_rental__1_day',
        amount: ONE_DAY_CENTS / 100,
        amount_cents: ONE_DAY_CENTS,
        unit: 'day',
        active: true,
        location_id: LOC,
        currency: 'EUR',
        id: 'price-1d',
        source: 'db',
      },
      {
        category: 'rental',
        offering_key: 'board_and_suit_rental__6_days',
        item_code: 'board_and_suit_rental__6_days',
        amount: SIX_DAY_CENTS / 100,
        amount_cents: SIX_DAY_CENTS,
        unit: 'day',
        active: true,
        location_id: LOC,
        currency: 'EUR',
        id: 'price-6d',
        source: 'db',
      },
    ],
    surf_packs: [],
    private_lesson: null,
  };
}

async function loadRuleMock(params) {
  const amount = PRICES[params.itemCode];
  if (amount == null) return { status: 'not_found', location_id: params.locationId };
  return {
    status: 'found',
    id: `price-${params.itemCode}`,
    amount_cents: amount,
    currency: 'EUR',
    location_id: params.locationId,
    item_type: params.itemType,
    item_code: params.itemCode,
    unit: params.billingUnit,
  };
}

/** Exact metadata shape quoteOfferingLine builds for rental offering_type. */
function staffCreateRentalMetadata(overrides) {
  return {
    component: 'rental',
    staff_ui_service_type: 'rental',
    course_id: null,
    tier_key: '6_days',
    duration_key: '6_days',
    offering_id: 'board_and_suit_rental__6_days',
    location_id: LOC,
    ...overrides,
  };
}

/**
 * PG mock for Staff Create async quote → loadTenantPriceRuleFromDb.
 * Captures item_code so the test can prove 6_days (not 1_day) was requested.
 */
function mockQuotePg() {
  const lookups = [];
  return {
    lookups,
    query: async (sql, params) => {
      const s = String(sql);
      if (/to_regclass/i.test(s)) {
        return { rows: [{ reg: 'tenant_price_rules' }], rowCount: 1 };
      }
      if (/information_schema\.(tables|columns)/i.test(s)) {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      if (/FROM tenant_price_rules/i.test(s)) {
        // loadTenantPriceRuleFromDb: $1 client, $2 item_type, $3 item_code, $4 unit, $5 location
        const itemCode = params && params[2];
        const billingUnit = params && params[3];
        const locationId = (params && params[4]) || LOC;
        lookups.push({ itemCode, billingUnit, locationId, params: params || [] });
        const amount = PRICES[itemCode];
        if (amount == null) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            amount_cents: amount,
            currency: 'EUR',
            item_type: 'rental',
            item_code: itemCode,
            unit: billingUnit || 'day',
            location_id: locationId,
            id: `price-${itemCode}`,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

async function quoteStaffCreateSixDay() {
  const body = {
    guest_name: 'Six Day Guest',
    guest_phone: '+34000000001',
    surfer_count: 1,
    date_from: '2026-08-01',
    date_to: '2026-08-06',
    service_dates: [
      '2026-08-01', '2026-08-02', '2026-08-03',
      '2026-08-04', '2026-08-05', '2026-08-06',
    ],
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '6_days', quantity: 1 }],
    components: {},
    require_db: true,
  };
  const built = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: LOC,
    transportBody: body,
    now: new Date('2026-07-15T12:00:00Z'),
  });
  if (!built.ok) return { quote: built, lookups: [] };

  const pg = mockQuotePg();
  const quote = await executeSunsetQuote(pg, built.command, { adminCfg: adminCfgFixture() });
  return { quote, lookups: pg.lookups };
}

function mockPaymentLinkPg(opts) {
  const bookingMeta = opts.bookingMeta;
  const rows = opts.rows;
  const paymentInserts = [];
  const bookingTotals = { total_amount_cents: 0, balance_due_cents: 0, amount_paid_cents: 0 };
  let rolledBack = false;
  const BOOKING_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const CLIENT_ID = 'cccccccc-dddd-eeee-ffff-000000000001';
  const priceRows = [
    {
      id: 'price-1d',
      item_type: 'rental',
      item_code: 'board_and_suit_rental__1_day',
      display_name: 'Bundle 1 day',
      currency: 'EUR',
      amount_cents: ONE_DAY_CENTS,
      unit: 'day',
      active: true,
      effective_from: null,
      effective_to: null,
    },
    {
      id: 'price-6d',
      item_type: 'rental',
      item_code: 'board_and_suit_rental__6_days',
      display_name: 'Bundle 6 days',
      currency: 'EUR',
      amount_cents: SIX_DAY_CENTS,
      unit: 'day',
      active: true,
      effective_from: null,
      effective_to: null,
    },
  ];
  return {
    paymentInserts,
    bookingTotals,
    rolledBack: () => rolledBack,
    query: async (sql, params) => {
      const s = String(sql);
      if (/^BEGIN/i.test(s) || /^COMMIT/i.test(s)) return { rows: [] };
      if (/^ROLLBACK/i.test(s)) { rolledBack = true; return { rows: [] }; }
      if (/information_schema\.tables/i.test(s) && /ANY\(/i.test(s)) {
        return {
          rows: [
            { table_name: 'tenant_price_rules' },
            { table_name: 'tenant_lesson_capacity_rules' },
            { table_name: 'tenant_lesson_time_rules' },
            { table_name: 'tenant_config_audit_log' },
          ],
        };
      }
      if (/information_schema\.(tables|columns)/i.test(s)) {
        return { rows: [{ '?column?': 1 }] };
      }
      if (/to_regclass/i.test(s)) return { rows: [{ reg: 'tenant_price_rules' }] };
      if (/SELECT id, item_type, item_code, display_name/i.test(s)) {
        return { rows: priceRows };
      }
      if (/FROM tenant_price_rules/i.test(s) && /amount_cents/i.test(s)) {
        // Single-rule lookup: item_code is $3
        const itemCode = params && params[2];
        const hit = priceRows.find((r) => r.item_code === itemCode);
        return hit ? { rows: [hit] } : { rows: [] };
      }
      if (/FROM tenant_lesson_capacity_rules/i.test(s)) return { rows: [] };
      if (/FROM tenant_lesson_time_rules/i.test(s)) return { rows: [] };
      if (/FROM tenant_config_audit_log/i.test(s)) return { rows: [] };
      if (/tenant_surf_pack/i.test(s)) return { rows: [] };
      if (/private_lesson/i.test(s)) return { rows: [] };
      if (/SELECT b\.id::text AS booking_id/i.test(s) && /FOR UPDATE/i.test(s)) {
        return { rows: [{ booking_id: BOOKING_ID }] };
      }
      if (/SELECT b\.id::text AS booking_id/i.test(s)) {
        return {
          rows: [{
            booking_id: BOOKING_ID,
            booking_code: 'SUNSET-6D-001',
            guest_name: 'Six Day Guest',
            status: 'payment_pending',
            payment_status: 'waiting_payment',
            check_in: '2026-08-01',
            check_out: '2026-08-07',
            metadata: bookingMeta,
          }],
        };
      }
      if (/SELECT metadata FROM bookings/i.test(s)) return { rows: [{ metadata: bookingMeta }] };
      if (/FROM booking_service_records/i.test(s) && /SELECT id::text AS service_record_id/i.test(s)) {
        return { rows: rows.map((r) => ({ ...r, service_record_id: r.id })) };
      }
      if (/SELECT id, service_type/i.test(s) && /booking_service_records/i.test(s)) return { rows };
      if (/UPDATE booking_service_records SET amount_due_cents/i.test(s)) {
        const row = rows.find((r) => String(r.id) === String(params[1]));
        if (row) row.amount_due_cents = params[0];
        return { rows: [] };
      }
      if (/UPDATE bookings[\s\S]*total_amount_cents/i.test(s)) {
        bookingTotals.total_amount_cents = params[0];
        bookingTotals.balance_due_cents = Math.max(params[0] - bookingTotals.amount_paid_cents, 0);
        return { rows: [] };
      }
      if (/UPDATE bookings[\s\S]*payment_status/i.test(s)) return { rows: [] };
      if (/SELECT id FROM clients WHERE slug/i.test(s)) return { rows: [{ id: CLIENT_ID }] };
      if (/FROM payments/i.test(s) && /checkout_url IS NOT NULL/i.test(s)) return { rows: [] };
      if (/FROM payments/i.test(s)) return { rows: [] };
      if (/INSERT INTO payments/i.test(s)) {
        paymentInserts.push({ amount_due_cents: params[2], metadata: params[3] });
        return { rows: [{ payment_id: 'pay-6d-001' }] };
      }
      return { rows: [] };
    },
  };
}

async function main() {
  console.log('\nverify:sunset-create-quote-six-day-async\n');

  // --- Identity boundary: exact production quoteOfferingLine metadata shape ---
  // (component=rental, tier_key from catalog, compound offering_id; historically
  // duration_key was not forwarded and silent 1_day priced 2000 under a 6_days label.)
  const staffMeta = {
    component: 'rental',
    staff_ui_service_type: 'rental',
    course_id: null,
    tier_key: '6_days',
    offering_id: 'board_and_suit_rental__6_days',
    location_id: LOC,
  };
  const identity = resolveSunsetPriceIdentity(staffMeta);
  check(
    'Staff Create metadata resolves item_code board_and_suit_rental__6_days',
    identity && identity.item_code === 'board_and_suit_rental__6_days',
    JSON.stringify(identity),
  );
  check(
    'identity duration_key is 6_days (not 1_day)',
    identity && identity.duration_key === '6_days',
    JSON.stringify(identity),
  );

  // tier_key alone (duration_key omitted) — production quoteOfferingLine shape.
  const tierOnly = resolveSunsetPriceIdentity(staffCreateRentalMetadata({ duration_key: undefined }));
  check(
    'tier_key alone keeps 6_days compound identity',
    tierOnly && tierOnly.item_code === 'board_and_suit_rental__6_days' && tierOnly.duration_key === '6_days',
    JSON.stringify(tierOnly),
  );

  // Compound suffix alone when duration fields dropped (async re-resolution gap).
  const compoundOnly = resolveSunsetPriceIdentity({
    component: 'rental',
    staff_ui_service_type: 'rental',
    offering_id: 'board_and_suit_rental__6_days',
    location_id: LOC,
  });
  check(
    'compound offering_id alone does not default to 1_day',
    compoundOnly && compoundOnly.item_code === 'board_and_suit_rental__6_days'
      && compoundOnly.duration_key === '6_days',
    JSON.stringify(compoundOnly),
  );

  // Billing unit must not steal duration from compound 6_days.
  const billingUnitNoise = resolveSunsetPriceIdentity({
    component: 'rental',
    offering_id: 'board_and_suit_rental__6_days',
    unit: 'day',
    location_id: LOC,
  });
  check(
    'billing unit day does not override compound 6_days',
    billingUnitNoise && billingUnitNoise.item_code === 'board_and_suit_rental__6_days'
      && billingUnitNoise.duration_key === '6_days',
    JSON.stringify(billingUnitNoise),
  );

  // Conflict fail-closed.
  const conflict = resolveSunsetPriceIdentity({
    component: 'rental',
    tier_key: '6_days',
    offering_id: 'board_and_suit_rental__1_day',
    location_id: LOC,
  });
  check(
    'compound 1_day vs explicit 6_days fails closed',
    conflict == null,
    JSON.stringify(conflict),
  );

  // --- Async Admin DB resolve (same boundary as Create re-quote) ---
  const resolved = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 1,
    metadata: staffCreateRentalMetadata(),
    loadRule: loadRuleMock,
  });
  check(
    'async resolve returns unit 11500 (not 2000)',
    resolved.ok && resolved.unit_amount_cents === SIX_DAY_CENTS
      && resolved.amount_cents === SIX_DAY_CENTS
      && resolved.item_code === 'board_and_suit_rental__6_days',
    JSON.stringify(resolved),
  );
  check(
    'async resolve is not the 1_day amount',
    resolved.unit_amount_cents !== ONE_DAY_CENTS,
    String(resolved.unit_amount_cents),
  );

  // --- Full Staff Create executeSunsetQuote path ---
  const { quote, lookups } = await quoteStaffCreateSixDay();
  check('Staff Create async quote ok', quote.ok === true, JSON.stringify(quote.body || quote));
  check(
    'async DB lookup requested board_and_suit_rental__6_days (not __1_day)',
    lookups.some((l) => l.itemCode === 'board_and_suit_rental__6_days')
      && !lookups.some((l) => l.itemCode === 'board_and_suit_rental__1_day'),
    JSON.stringify(lookups),
  );
  const line = quote.body && Array.isArray(quote.body.line_items) && quote.body.line_items[0];
  check(
    'quote line offering identity is board_and_suit_rental__6_days',
    line
      && line.offering_id === 'board_and_suit_rental__6_days'
      && (line.offering_item_code === 'board_and_suit_rental__6_days'
        || line.item_code === 'board_and_suit_rental__6_days'),
    JSON.stringify(line),
  );
  check(
    'quote line duration_key/tier is 6_days',
    line && (line.duration_key === '6_days' || line.tier_key === '6_days'),
    JSON.stringify(line),
  );
  check(
    'quote line unit_amount_cents is 11500 not 2000',
    line && line.unit_amount_cents === SIX_DAY_CENTS && line.total_cents === SIX_DAY_CENTS,
    JSON.stringify(line && {
      unit_amount_cents: line.unit_amount_cents,
      total_cents: line.total_cents,
    }),
  );
  check(
    'quote body total_cents is 11500',
    quote.body && quote.body.total_cents === SIX_DAY_CENTS,
    String(quote.body && quote.body.total_cents),
  );

  // --- Payment-link: newly quoted 6-day booking matches reprice then checkout ---
  const cfgPrices = adminCfgFixture().prices;
  const configured = configuredRentalBundleTotalCents(cfgPrices, {
    offering_key: 'board_and_suit_rental',
    duration: '6_days',
    quantity: 1,
  });
  check('configured reprice for 6_days is 11500', configured === SIX_DAY_CENTS, String(configured));

  const GROUP_ID = 'pg6days000000001';
  function sixDayDescriptor(quoted) {
    return {
      pricing_group_id: GROUP_ID,
      offering_key: 'board_and_suit_rental',
      duration: '6_days',
      quantity: 1,
      service_date: '2026-08-01',
      components: ['surfboard', 'wetsuit'],
      quoted_total_cents: quoted,
    };
  }
  function rowMeta(role) {
    return JSON.stringify({
      pricing_group_id: GROUP_ID,
      rental_pricing_role: role,
      location_id: LOC,
    });
  }
  const bundleRows = [
    {
      id: 'sr-board-6d',
      service_type: 'surfboard',
      service_date: '2026-08-01',
      quantity: 1,
      amount_due_cents: 0,
      metadata: rowMeta('surfboard'),
    },
    {
      id: 'sr-suit-6d',
      service_type: 'wetsuit',
      service_date: '2026-08-01',
      quantity: 1,
      amount_due_cents: 0,
      metadata: rowMeta('wetsuit'),
    },
  ];

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
          id: 'cs_6d_11500',
          url: 'https://checkout.stripe.com/c/pay/cs_6d_11500',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          livemode: false,
        }),
      };
    }
    return origFetch ? origFetch(url, init) : { ok: false, json: async () => ({}) };
  };

  try {
    // Ensure Admin DB-read path is used for payment-link reprice (same as staging).
    process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

    const pgOk = mockPaymentLinkPg({
      bookingMeta: {
        rental_pricing: sixDayDescriptor(SIX_DAY_CENTS),
        location_id: LOC,
        staff_manual_schedule: true,
        source: 'staff_manual_schedule',
      },
      rows: bundleRows.map((r) => ({ ...r })),
    });
    const stripeOk = await createSunsetScheduleStripeLink(pgOk, {
      clientSlug: 'sunset',
      bookingId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      locationId: LOC,
      staffActionsEnabled: true,
      stripeLinksEnabled: true,
      stripeSecretKey: 'sk_test_6d',
      stripeSuccessUrl: 'https://example.com/success',
      stripeCancelUrl: 'https://example.com/cancel',
      actor: { email: 'staff@test.local' },
    });
    check(
      'payment-link proceeds when quoted_total_cents matches 11500',
      stripeOk.ok === true,
      JSON.stringify(stripeOk.body),
    );
    check(
      'payment-link amount_due_cents is 11500',
      stripeOk.body && stripeOk.body.amount_due_cents === SIX_DAY_CENTS,
      JSON.stringify(stripeOk.body),
    );
    check('payment-link calls Stripe checkout once (mocked)', stripeFetchCount === 1, String(stripeFetchCount));
    const decoded = decodeURIComponent(stripeBody);
    check(
      'Stripe unit_amount is 11500 (no live network)',
      new RegExp(`\\[unit_amount\\]=${SIX_DAY_CENTS}`).test(decoded),
      decoded.slice(0, 200),
    );

    // Fail-closed guard preserved for stale Create quote (2000 vs 11500).
    stripeFetchCount = 0;
    global.fetch = async (url) => {
      if (String(url).includes('api.stripe.com')) {
        stripeFetchCount += 1;
        return { ok: true, json: async () => ({ id: 'cs_should_not' }) };
      }
      return origFetch ? origFetch(url) : { ok: false, json: async () => ({}) };
    };
    const pgStale = mockPaymentLinkPg({
      bookingMeta: {
        rental_pricing: sixDayDescriptor(ONE_DAY_CENTS),
        location_id: LOC,
        staff_manual_schedule: true,
        source: 'staff_manual_schedule',
      },
      rows: bundleRows.map((r) => ({ ...r })),
    });
    const stale = await createSunsetScheduleStripeLink(pgStale, {
      clientSlug: 'sunset',
      bookingId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      locationId: LOC,
      staffActionsEnabled: true,
      stripeLinksEnabled: true,
      stripeSecretKey: 'sk_test_6d',
      stripeSuccessUrl: 'https://example.com/success',
      stripeCancelUrl: 'https://example.com/cancel',
    });
    check(
      'stale quoted 2000 vs configured 11500 → rental_pricing_quote_mismatch',
      stale.ok === false
        && stale.body
        && stale.body.error === 'rental_pricing_quote_mismatch'
        && stale.body.configured_total_cents === SIX_DAY_CENTS
        && stale.body.quoted_total_cents === ONE_DAY_CENTS,
      JSON.stringify(stale.body),
    );
    check('stale mismatch → no Stripe fetch', stripeFetchCount === 0, String(stripeFetchCount));
    check('stale mismatch → no payment INSERT', pgStale.paymentInserts.length === 0);
    check('stale mismatch → transaction rolled back', pgStale.rolledBack());
  } finally {
    global.fetch = origFetch;
  }

  console.log(`\nPASS: ${pass} assertions\n`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
