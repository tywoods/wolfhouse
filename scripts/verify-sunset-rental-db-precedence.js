'use strict';

/**
 * verify:sunset-rental-db-precedence
 *
 * TDD gate for Commit 1 — the owner-managed portal price in tenant_price_rules
 * is authoritative for the LIVE rental-price tool AND the booking/payment/Stripe
 * truth path. Proves DB precedence, location isolation, and fail-closed behavior
 * WITHOUT hard-coding any business price (test values demonstrate precedence, not
 * a coded constant).
 *
 * No real DB / network: PG is mocked, the rule loader is injected.
 *
 * Run:
 *   node scripts/verify-sunset-rental-db-precedence.js
 */

const {
  lookupSunsetRentalPriceAsync,
} = require('./lib/sunset-rental-price-lookup');
const {
  resolveTenantBusinessConfigAsync,
} = require('./lib/tenant-business-config');
const {
  configuredRentalBundleTotalCents,
  priceSunsetBookingServices,
  createSunsetScheduleStripeLink,
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

// Test-only owner prices. NOT the baseline seed (half_day bundle = 1500 in
// config); the point is to show the DB value wins, whatever it is.
const DB_BUNDLE_HALFDAY_SOMO = 2000; // €20 owner-managed
const DB_BUNDLE_HALFDAY_SARDI = 3400; // €34 — deliberately different per location
const BASELINE_BUNDLE_HALFDAY = 1500; // config/clients/sunset.baseline.json (public_site seed)

// Injected rule loader — stands in for tenant_price_rules. Fails closed on an
// unconfigured location; never returns the baseline seed.
function makeRuleLoader(rules) {
  return async (params) => {
    if (params.locationId === 'sunset-somo' && rules.somo != null) {
      return {
        status: 'found', amount_cents: rules.somo, currency: 'EUR',
        item_code: params.itemCode, unit: params.unit, location_id: 'sunset-somo',
      };
    }
    if (params.locationId === 'sunset-sardinero' && rules.sardi != null) {
      return {
        status: 'found', amount_cents: rules.sardi, currency: 'EUR',
        item_code: params.itemCode, unit: params.unit, location_id: 'sunset-sardinero',
      };
    }
    return { status: 'not_found', location_id: params.locationId };
  };
}

async function main() {
  console.log('\nverify:sunset-rental-db-precedence — portal DB prices are authoritative\n');

  // ─────────────────────────────────────────────────────────────────────────
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';
  const bothLocations = makeRuleLoader({ somo: DB_BUNDLE_HALFDAY_SOMO, sardi: DB_BUNDLE_HALFDAY_SARDI });

  console.log('[A] DB rule wins over baseline seed');
  const somo = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset', location_id: 'sunset-somo',
    item: 'board+suit bundle', duration: 'half day', loadRule: bothLocations,
  });
  assert('effective lookup returns the DB amount, not the baseline',
    somo.ok === true && somo.amount_cents === DB_BUNDLE_HALFDAY_SOMO, JSON.stringify(somo));
  assert('DB amount differs from public_site baseline seed',
    DB_BUNDLE_HALFDAY_SOMO !== BASELINE_BUNDLE_HALFDAY);
  assert('source is db (not public_site)', somo.source === 'db', somo.source);
  assert('source_url is null (owner rule carries none)', somo.source_url === null);
  assert('live quote allowed for owner rule', somo.live_quote_allowed === true);

  console.log('\n[B] Location isolation — Somo and elSardi never cross');
  const sardi = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset', location_id: 'sunset-sardinero',
    item: 'board+suit bundle', duration: 'half day', loadRule: bothLocations,
  });
  assert('Sardinero returns only Sardinero price', sardi.ok === true && sardi.amount_cents === DB_BUNDLE_HALFDAY_SARDI, JSON.stringify(sardi));
  assert('Somo ≠ Sardinero (no silent substitution)', somo.amount_cents !== sardi.amount_cents);
  const somoOnly = makeRuleLoader({ somo: DB_BUNDLE_HALFDAY_SOMO });
  const sardiMissing = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset', location_id: 'sunset-sardinero',
    item: 'board+suit bundle', duration: 'half day', loadRule: somoOnly,
  });
  assert('Sardinero with only a Somo rule fails closed (no cross-location)',
    sardiMissing.ok === false && sardiMissing.reason === 'price_not_configured');
  const unknownLoc = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset', location_id: 'sunset-nope',
    item: 'board+suit bundle', duration: 'half day', loadRule: bothLocations,
  });
  assert('unknown location fails closed', unknownLoc.ok === false && unknownLoc.reason === 'unknown_location');

  console.log('\n[C] Missing rule (tables exist) → price_not_configured, never baseline');
  const noRule = makeRuleLoader({});
  const missing = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset', location_id: 'sunset-somo',
    item: 'board+suit bundle', duration: 'half day', loadRule: noRule,
  });
  assert('missing rule → price_not_configured', missing.ok === false && missing.reason === 'price_not_configured');
  assert('missing rule does NOT return baseline amount',
    missing.amount_cents == null || missing.amount_cents !== BASELINE_BUNDLE_HALFDAY);

  console.log('\n[D] Query failure → typed failure, never baseline');
  const boom = async () => { throw new Error('connection reset'); };
  const failed = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset', location_id: 'sunset-somo',
    item: 'board+suit bundle', duration: 'half day', loadRule: boom,
  });
  assert('query error → price_lookup_failed', failed.ok === false && failed.reason === 'price_lookup_failed');
  assert('query error does NOT fall back to baseline', failed.amount_cents == null || failed.amount_cents !== BASELINE_BUNDLE_HALFDAY);

  console.log('\n[E] DB read disabled → baseline preview path remains available');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'false';
  const preview = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset', location_id: 'sunset-somo',
    item: 'board+suit bundle', duration: 'half day', loadRule: bothLocations,
  });
  assert('DB disabled → baseline seed returned', preview.ok === true && preview.amount_cents === BASELINE_BUNDLE_HALFDAY, JSON.stringify(preview));
  assert('DB disabled source is public_site seed', preview.source === 'public_site');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[F-resolver] Owner DB price flows into the shared bundle-total function');
  process.env.SUNSET_ADMIN_JSON_OVERLAY = 'false';
  const dbLoad = (unitCents) => async (slug, pgClient, loc) => ({
    ok: true,
    hasData: true,
    prices: [{
      id: 'db-bundle', category: 'rental', offering_key: 'board_and_suit_rental',
      label: 'Board + wetsuit rental (bundle)', currency: 'EUR', unit: 'half_day',
      amount: unitCents / 100, active: true, source: 'db', effective_state: 'db',
    }],
    lesson_capacity: { default_daily_cap: 24, overrides: [], fromDb: false },
    lesson_times: [], surf_packs: [], private_lesson: null, change_history: [],
  });
  const cfgSomo = await resolveTenantBusinessConfigAsync('sunset', { loadFromDb: dbLoad(DB_BUNDLE_HALFDAY_SOMO), locationId: 'sunset-somo' });
  const totalSomo = configuredRentalBundleTotalCents(cfgSomo.prices, { offering_key: 'board_and_suit_rental', duration: 'half_day', quantity: 2 });
  assert('booking/stripe bundle total uses DB unit × qty (2000 × 2 = 4000)', totalSomo === DB_BUNDLE_HALFDAY_SOMO * 2, String(totalSomo));
  assert('DB total differs from baseline total (1500 × 2)', totalSomo !== BASELINE_BUNDLE_HALFDAY * 2);
  const bundlePrice = cfgSomo.prices.find((p) => (p.offering_key || p.item_code) === 'board_and_suit_rental');
  assert('resolved bundle price is DB-sourced', bundlePrice && bundlePrice.source === 'db');

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[F/G] End-to-end booking + payment + Stripe aggregate from the DB price');
  const BOOKING_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const CLIENT_ID = 'cccccccc-dddd-eeee-ffff-000000000001';
  const GROUP_ID = 'pgdbprec0001abcd';

  function descriptor(quotedTotal) {
    return {
      pricing_group_id: GROUP_ID, offering_key: 'board_and_suit_rental',
      duration: 'half_day', quantity: 2, service_date: '2026-07-21',
      components: ['surfboard', 'wetsuit'], quoted_total_cents: quotedTotal,
    };
  }
  function rowMeta(role) {
    return JSON.stringify({ pricing_group_id: GROUP_ID, rental_pricing_role: role, location_id: 'sunset-somo' });
  }
  function bundleRows() {
    return [
      { id: 'sr-board', service_type: 'surfboard', service_date: '2026-07-21', quantity: 2, amount_due_cents: 0, metadata: rowMeta('surfboard') },
      { id: 'sr-suit', service_type: 'wetsuit', service_date: '2026-07-21', quantity: 2, amount_due_cents: 0, metadata: rowMeta('wetsuit') },
    ];
  }

  // Mock PG that ALSO serves the admin-config DB reads (tables present + a single
  // owner bundle rule @ DB_BUNDLE_HALFDAY_SOMO), so resolveTenantBusinessConfigAsync
  // (used by the booking + stripe integrity code) reads the DB price.
  function mockPg(opts) {
    const updates = [];
    const bookingUpdates = [];
    const paymentInserts = [];
    const rows = opts.rows;
    const bookingMeta = opts.bookingMeta;
    const bookingTotals = { total_amount_cents: 0, balance_due_cents: 0, amount_paid_cents: 0 };
    let rolledBack = false;
    return {
      updates, bookingUpdates, paymentInserts, bookingTotals,
      rolledBack: () => rolledBack,
      query: async (sql, params) => {
        const s = String(sql);
        if (/^BEGIN/i.test(s) || /^COMMIT/i.test(s)) return { rows: [] };
        if (/^ROLLBACK/i.test(s)) { rolledBack = true; return { rows: [] }; }
        // admin-config table presence (all 4 tables)
        if (/information_schema\.tables/i.test(s) && /ANY\(/i.test(s)) {
          return { rows: [{ table_name: 'tenant_price_rules' }, { table_name: 'tenant_lesson_capacity_rules' }, { table_name: 'tenant_lesson_time_rules' }, { table_name: 'tenant_config_audit_log' }] };
        }
        // single-table existence checks (surf packs etc.) → treat as absent
        if (/information_schema\.tables/i.test(s)) return { rows: [] };
        // column existence checks → no optional columns (client-scoped price query)
        if (/information_schema\.columns/i.test(s)) return { rows: [] };
        // admin-config price rows (mapPriceRows query)
        if (/SELECT id, item_type, item_code, display_name/i.test(s)) {
          return { rows: [{ id: 'db-bundle', item_type: 'rental', item_code: 'board_and_suit_rental', display_name: 'Bundle', currency: 'EUR', amount_cents: DB_BUNDLE_HALFDAY_SOMO, unit: 'half_day', active: true, effective_from: null, effective_to: null }] };
        }
        // booking + service-record reads for the pricing/stripe path
        if (/SELECT b\.id::text AS booking_id/i.test(s)) {
          return { rows: [{ booking_id: BOOKING_ID, booking_code: 'SUNSET-DBP-001', guest_name: 'Robin', status: 'payment_pending', payment_status: 'waiting_payment', check_in: '2026-07-21', check_out: '2026-07-22', metadata: bookingMeta }] };
        }
        if (/SELECT metadata FROM bookings/i.test(s)) return { rows: [{ metadata: bookingMeta }] };
        if (/FROM booking_service_records/i.test(s) && /SELECT id::text AS service_record_id/i.test(s)) {
          return { rows: rows.map((r) => ({ ...r, service_record_id: r.id })) };
        }
        if (/SELECT id, service_type/i.test(s) && /booking_service_records/i.test(s)) return { rows };
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
        if (/SELECT id FROM clients WHERE slug/i.test(s)) return { rows: [{ id: CLIENT_ID }] };
        if (/FROM payments/i.test(s) && /checkout_url IS NOT NULL/i.test(s)) return { rows: [] };
        if (/INSERT INTO payments/i.test(s)) {
          paymentInserts.push({ amount_due_cents: params[2], metadata: params[3] });
          return { rows: [{ payment_id: 'pay-dbp-001' }] };
        }
        return { rows: [] };
      },
    };
  }

  // F — matching quote (4000) prices through booking + payment + Stripe.
  const pgOk = mockPg({
    bookingMeta: { rental_pricing: descriptor(4000), location_id: 'sunset-somo', staff_manual_schedule: true, source: 'staff_manual_schedule' },
    rows: bundleRows(),
  });
  const priced = await priceSunsetBookingServices(pgOk, 'sunset', BOOKING_ID);
  assert('booking priced ok from DB price', priced.ok === true, priced.error);
  assert('booking total = 4000 (DB unit 2000 × 2)', priced.total_cents === 4000, String(priced.total_cents));
  const rowSum = pgOk.updates.reduce((a, u) => a + u.amount_due_cents, 0);
  assert('service-row due amounts sum to 4000', rowSum === 4000, String(rowSum));

  let stripeFetchCount = 0;
  let stripeBody = '';
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('api.stripe.com/v1/checkout/sessions')) {
      stripeFetchCount += 1;
      stripeBody = init && init.body ? String(init.body) : '';
      return { ok: true, json: async () => ({ id: 'cs_dbp_4000', url: 'https://checkout.stripe.com/c/pay/cs_dbp_4000', expires_at: Math.floor(Date.now() / 1000) + 3600, livemode: false }) };
    }
    return origFetch(url, init);
  };
  const pgStripe = mockPg({
    bookingMeta: { rental_pricing: descriptor(4000), location_id: 'sunset-somo', staff_manual_schedule: true, source: 'staff_manual_schedule' },
    rows: bundleRows(),
  });
  const stripeResult = await createSunsetScheduleStripeLink(pgStripe, {
    clientSlug: 'sunset', bookingId: BOOKING_ID, locationId: 'sunset-somo',
    staffActionsEnabled: true, stripeLinksEnabled: true, stripeSecretKey: 'sk_test_dbprec',
    stripeSuccessUrl: 'https://example.com/success', stripeCancelUrl: 'https://example.com/cancel',
    actor: { email: 'staff@test.local' },
  });
  global.fetch = origFetch;
  assert('Stripe checkout succeeds', stripeResult.ok === true, stripeResult.body && stripeResult.body.error);
  assert('API amount_due_cents = 4000', stripeResult.body && stripeResult.body.amount_due_cents === 4000);
  assert('payment INSERT amount_due_cents = 4000', pgStripe.paymentInserts.length === 1 && pgStripe.paymentInserts[0].amount_due_cents === 4000);
  assert('booking total_amount_cents = 4000', pgStripe.bookingTotals.total_amount_cents === 4000);
  assert('Stripe fetch called exactly once', stripeFetchCount === 1, String(stripeFetchCount));
  const decoded = decodeURIComponent(stripeBody);
  assert('Stripe currency EUR', /\[currency\]=eur/i.test(decoded));
  assert('Stripe aggregate unit_amount = 4000', /\[unit_amount\]=4000/.test(decoded));

  // G — stale quote (3000) vs DB-configured total (4000): fail closed, rollback.
  stripeFetchCount = 0;
  global.fetch = async (url) => {
    if (String(url).includes('api.stripe.com')) { stripeFetchCount += 1; return { ok: true, json: async () => ({ id: 'cs_should_not_run' }) }; }
    return origFetch(url);
  };
  const pgStale = mockPg({
    bookingMeta: { rental_pricing: descriptor(3000), location_id: 'sunset-somo', staff_manual_schedule: true, source: 'staff_manual_schedule' },
    rows: bundleRows(),
  });
  const stale = await createSunsetScheduleStripeLink(pgStale, {
    clientSlug: 'sunset', bookingId: BOOKING_ID, locationId: 'sunset-somo',
    staffActionsEnabled: true, stripeLinksEnabled: true, stripeSecretKey: 'sk_test_dbprec',
    stripeSuccessUrl: 'https://example.com/success', stripeCancelUrl: 'https://example.com/cancel',
  });
  global.fetch = origFetch;
  assert('stale quote → rental_pricing_quote_mismatch', stale.ok === false && stale.body && stale.body.error === 'rental_pricing_quote_mismatch', stale.body && stale.body.error);
  assert('stale quote reports configured 4000 vs quoted 3000',
    stale.body && stale.body.configured_total_cents === 4000 && stale.body.quoted_total_cents === 3000);
  assert('stale quote → no payment INSERT', pgStale.paymentInserts.length === 0);
  assert('stale quote → no Stripe fetch', stripeFetchCount === 0);
  assert('stale quote → transaction rolled back', pgStale.rolledBack());

  console.log(`\n── verify:sunset-rental-db-precedence ${fail ? 'FAILED' : 'PASSED'} (${pass}/${pass + fail}) ──\n`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('verify:sunset-rental-db-precedence — fatal:', err.stack || err.message);
  process.exit(1);
});
