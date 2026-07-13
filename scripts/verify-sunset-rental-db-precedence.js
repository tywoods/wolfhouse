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
 * Mock rows mirror the real Sunset portal schema:
 *   item_code = board_and_suit_rental__half_day
 *   unit      = session  (billing granularity — NOT guest duration)
 *
 * No real DB / network: PG is mocked; the rule loader runs through
 * loadTenantPriceRuleFromDb against captured SQL parameters.
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

const PERSISTED_ITEM_CODE = 'board_and_suit_rental__half_day';
const BILLING_UNIT = 'session';
const GUEST_DURATION = 'half_day';

// Test-only owner prices. NOT the baseline seed (half_day bundle = 1500 in
// config); the point is to show the DB value wins, whatever it is.
const DB_BUNDLE_HALFDAY_SOMO = 2000;
const DB_BUNDLE_HALFDAY_SARDI = 1000;
const BASELINE_BUNDLE_HALFDAY = 1500;

const FIXED_NOW = new Date('2026-07-15T12:00:00Z');

function schemaRowsForLocation(loc, amountCents) {
  const rows = [
    {
      id: 'hist-inactive-old',
      client_slug: 'sunset',
      location_id: loc,
      item_type: 'rental',
      item_code: PERSISTED_ITEM_CODE,
      display_name: 'Bundle half day (retired)',
      currency: 'EUR',
      amount_cents: amountCents + 5000,
      unit: BILLING_UNIT,
      active: false,
      effective_from: '2020-01-01',
      effective_to: null,
      updated_at: '2020-06-01',
    },
    {
      id: 'hist-inactive-recent',
      client_slug: 'sunset',
      location_id: loc,
      item_type: 'rental',
      item_code: PERSISTED_ITEM_CODE,
      display_name: 'Bundle half day (superseded)',
      currency: 'EUR',
      amount_cents: amountCents + 3000,
      unit: BILLING_UNIT,
      active: false,
      effective_from: '2024-01-01',
      effective_to: null,
      updated_at: '2024-06-01',
    },
    {
      id: 'active-authoritative',
      client_slug: 'sunset',
      location_id: loc,
      item_type: 'rental',
      item_code: PERSISTED_ITEM_CODE,
      display_name: 'Board + wetsuit rental (bundle)',
      currency: 'EUR',
      amount_cents: amountCents,
      unit: BILLING_UNIT,
      active: true,
      effective_from: '2026-01-01',
      effective_to: null,
      updated_at: '2026-06-01',
    },
  ];
  return rows;
}

/**
 * Faithful PG mock: column presence from parameterized information_schema queries,
 * effective-window filtering, and deterministic ordering matching production SQL.
 */
function makeSchemaPg(opts = {}) {
  const locationsConfig = opts.locationsConfig || {};
  const extraRows = opts.extraRows || [];
  const columnPresence = {
    location_id: true,
    effective_from: true,
    effective_to: true,
    updated_at: true,
    ...(opts.columnPresence || {}),
  };
  const fixedNow = opts.fixedNow || FIXED_NOW;

  const capturedQueries = [];
  const columnQueries = [];
  const allRows = [];
  for (const [loc, amount] of Object.entries(locationsConfig)) {
    if (amount != null) allRows.push(...schemaRowsForLocation(loc, amount));
  }
  allRows.push(...extraRows);

  function columnPresent(tableName, columnName) {
    if (tableName !== 'tenant_price_rules') return false;
    return columnPresence[columnName] === true;
  }

  function withinEffectiveWindow(row) {
    const from = row.effective_from ? new Date(row.effective_from) : null;
    const to = row.effective_to ? new Date(row.effective_to) : null;
    if (from && from > fixedNow) return false;
    if (to && to < fixedNow) return false;
    return true;
  }

  function orderCandidates(rows) {
    return rows.slice().sort((a, b) => {
      const aFrom = a.effective_from ? new Date(a.effective_from).getTime() : Number.NEGATIVE_INFINITY;
      const bFrom = b.effective_from ? new Date(b.effective_from).getTime() : Number.NEGATIVE_INFINITY;
      if (bFrom !== aFrom) return bFrom - aFrom;
      const aUp = a.updated_at ? new Date(a.updated_at).getTime() : Number.NEGATIVE_INFINITY;
      const bUp = b.updated_at ? new Date(b.updated_at).getTime() : Number.NEGATIVE_INFINITY;
      if (bUp !== aUp) return bUp - aUp;
      return String(b.id).localeCompare(String(a.id)) * -1;
    });
  }

  function matchPriceQuery(sql, params) {
    const clientSlug = params[0];
    const itemType = params[1];
    const itemCode = params[2];
    let billingUnit = null;
    let locationId = null;
    if (/unit = \$4/i.test(sql) && /location_id = \$5/i.test(sql)) {
      billingUnit = params[3];
      locationId = params[4];
    } else if (/location_id = \$4/i.test(sql)) {
      locationId = params[3];
    }
    let matched = allRows.filter((r) => r.client_slug === clientSlug
      && r.item_type === itemType
      && r.item_code === itemCode
      && (billingUnit == null || r.unit === billingUnit)
      && r.active === true
      && (locationId == null || r.location_id === locationId)
      && withinEffectiveWindow(r));
    matched = orderCandidates(matched);
    return matched[0] || null;
  }

  return {
    capturedQueries,
    columnQueries,
    query: async (sql, params) => {
      const s = String(sql);
      capturedQueries.push({ sql: s, params: params ? [...params] : [] });
      if (/to_regclass/i.test(s)) return { rows: [{ reg: 'tenant_price_rules' }] };
      if (/information_schema\.columns/i.test(s)) {
        if (/column_name = \$2/i.test(s)) {
          const tableName = params[0];
          const columnName = params[1];
          columnQueries.push({ tableName, columnName });
          return { rows: columnPresent(tableName, columnName) ? [{ '?column?': 1 }] : [] };
        }
        if (/column_name = 'location_id'/i.test(s)) {
          const tableName = params[0];
          columnQueries.push({ tableName, columnName: 'location_id' });
          return { rows: columnPresent(tableName, 'location_id') ? [{ '?column?': 1 }] : [] };
        }
      }
      if (/FROM tenant_price_rules/i.test(s)) {
        const row = matchPriceQuery(s, params);
        if (!row) return { rows: [] };
        return {
          rows: [{
            amount_cents: row.amount_cents,
            currency: row.currency,
            item_type: row.item_type,
            item_code: row.item_code,
            unit: row.unit,
            location_id: row.location_id,
          }],
        };
      }
      return { rows: [] };
    },
  };
}

function priceQueries(pg) {
  return pg.capturedQueries.filter((q) => /FROM tenant_price_rules/i.test(q.sql));
}

async function main() {
  console.log('\nverify:sunset-rental-db-precedence — portal DB prices are authoritative\n');

  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  console.log('[A] DB rule wins over baseline seed (real item_code + billing unit)');
  const pgSomo = makeSchemaPg({ locationsConfig: { 'sunset-somo': DB_BUNDLE_HALFDAY_SOMO, 'sunset-sardinero': DB_BUNDLE_HALFDAY_SARDI } });
  const somo = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: pgSomo,
  });
  const somoQueries = priceQueries(pgSomo);
  assert('resolver queries combined item_code board_and_suit_rental__half_day',
    somoQueries.some((q) => q.params[2] === PERSISTED_ITEM_CODE), JSON.stringify(somoQueries));
  assert('resolver filters billing unit=session separately from guest duration',
    somoQueries.some((q) => /unit\s*=\s*\$4/i.test(q.sql) && q.params[3] === BILLING_UNIT));
  assert('resolver does not use guest duration half_day as billing unit',
    !somoQueries.some((q) => /unit\s*=\s*\$4/i.test(q.sql) && q.params[3] === GUEST_DURATION));
  assert('effective lookup returns the DB amount, not the baseline',
    somo.ok === true && somo.amount_cents === DB_BUNDLE_HALFDAY_SOMO, JSON.stringify(somo));
  assert('guest-facing duration remains half_day',
    somo.ok === true && somo.duration === GUEST_DURATION, JSON.stringify(somo));
  assert('DB amount differs from public_site baseline seed',
    DB_BUNDLE_HALFDAY_SOMO !== BASELINE_BUNDLE_HALFDAY);
  assert('source is db (not public_site)', somo.source === 'db', somo.source);
  assert('source_url is null (owner rule carries none)', somo.source_url === null);
  assert('live quote allowed for owner rule', somo.live_quote_allowed === true);

  console.log('\n[B] Location isolation — Somo and elSardi never cross');
  const pgSardi = makeSchemaPg({ locationsConfig: { 'sunset-somo': DB_BUNDLE_HALFDAY_SOMO, 'sunset-sardinero': DB_BUNDLE_HALFDAY_SARDI } });
  const sardi = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-sardinero',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: pgSardi,
  });
  assert('Sardinero returns only Sardinero price', sardi.ok === true && sardi.amount_cents === DB_BUNDLE_HALFDAY_SARDI, JSON.stringify(sardi));
  assert('Somo ≠ Sardinero (no silent substitution)', somo.amount_cents !== sardi.amount_cents);
  const pgSomoOnly = makeSchemaPg({ locationsConfig: { 'sunset-somo': DB_BUNDLE_HALFDAY_SOMO } });
  const sardiMissing = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-sardinero',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: pgSomoOnly,
  });
  assert('Sardinero with only a Somo rule fails closed (no cross-location)',
    sardiMissing.ok === false && sardiMissing.reason === 'price_not_configured');
  const unknownLoc = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-nope',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: pgSomo,
  });
  assert('unknown location fails closed', unknownLoc.ok === false && unknownLoc.reason === 'unknown_location');

  console.log('\n[C] Missing rule (tables exist) → price_not_configured, never baseline');
  const pgEmpty = makeSchemaPg({ locationsConfig: {} });
  const missing = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: pgEmpty,
  });
  assert('missing rule → price_not_configured', missing.ok === false && missing.reason === 'price_not_configured');
  assert('missing rule does NOT return baseline amount',
    missing.amount_cents == null || missing.amount_cents !== BASELINE_BUNDLE_HALFDAY);

  console.log('\n[C2] Inactive historical rows cannot win over the single active row');
  const pgVersioned = makeSchemaPg({ locationsConfig: { 'sunset-somo': DB_BUNDLE_HALFDAY_SOMO } });
  const versioned = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: pgVersioned,
  });
  assert('active row amount wins over higher inactive amounts',
    versioned.ok === true && versioned.amount_cents === DB_BUNDLE_HALFDAY_SOMO, JSON.stringify(versioned));

  console.log('\n[H] Billing-unit isolation — session wins over newer higher day row');
  const SESSION_AMOUNT = 2100;
  const DAY_AMOUNT = 9900;
  const pgBilling = makeSchemaPg({
    locationsConfig: {},
    extraRows: [
      {
        id: 'sess-authoritative',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: PERSISTED_ITEM_CODE,
        display_name: 'Bundle session',
        currency: 'EUR',
        amount_cents: SESSION_AMOUNT,
        unit: BILLING_UNIT,
        active: true,
        effective_from: '2026-01-01',
        effective_to: null,
        updated_at: '2026-05-01',
      },
      {
        id: 'day-higher-newer',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: PERSISTED_ITEM_CODE,
        display_name: 'Bundle day (wrong unit)',
        currency: 'EUR',
        amount_cents: DAY_AMOUNT,
        unit: 'day',
        active: true,
        effective_from: '2026-06-01',
        effective_to: null,
        updated_at: '2026-06-15',
      },
    ],
  });
  const billingIso = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: pgBilling,
  });
  const billingQueries = priceQueries(pgBilling);
  assert('billing isolation selects session row amount',
    billingIso.ok === true && billingIso.amount_cents === SESSION_AMOUNT, JSON.stringify(billingIso));
  assert('billing isolation SQL filters unit=session',
    billingQueries.some((q) => /unit\s*=\s*\$4/i.test(q.sql) && q.params[3] === BILLING_UNIT));
  assert('billing isolation never returns day row through ORDER BY',
    billingIso.ok === true && billingIso.amount_cents !== DAY_AMOUNT);

  console.log('\n[I] Billing-unit absence — no session row fails closed');
  const pgNoSession = makeSchemaPg({
    locationsConfig: {},
    extraRows: [{
      id: 'day-only',
      client_slug: 'sunset',
      location_id: 'sunset-somo',
      item_type: 'rental',
      item_code: PERSISTED_ITEM_CODE,
      display_name: 'Bundle day only',
      currency: 'EUR',
      amount_cents: DAY_AMOUNT,
      unit: 'day',
      active: true,
      effective_from: '2026-01-01',
      effective_to: null,
      updated_at: '2026-06-01',
    }],
  });
  const noSession = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: pgNoSession,
  });
  assert('missing session row → price_not_configured',
    noSession.ok === false && noSession.reason === 'price_not_configured', JSON.stringify(noSession));
  assert('missing session row does NOT return day/person row',
    noSession.amount_cents == null || noSession.amount_cents !== DAY_AMOUNT);
  assert('missing session row does NOT fall back to baseline',
    noSession.amount_cents == null || noSession.amount_cents !== BASELINE_BUNDLE_HALFDAY);

  console.log('\n[J] Missing location_id column — fail closed before tenant-wide SELECT');
  const pgNoLocCol = makeSchemaPg({
    locationsConfig: { 'sunset-somo': DB_BUNDLE_HALFDAY_SOMO, 'sunset-sardinero': DB_BUNDLE_HALFDAY_SARDI },
    columnPresence: { location_id: false },
  });
  const noLocCol = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-sardinero',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: pgNoLocCol,
  });
  assert('missing location_id column → price_not_configured',
    noLocCol.ok === false && noLocCol.reason === 'price_not_configured', JSON.stringify(noLocCol));
  assert('missing location_id column → no price SELECT issued',
    priceQueries(pgNoLocCol).length === 0, String(priceQueries(pgNoLocCol).length));
  assert('missing location_id column → no Somo substitution for Sardinero request',
    noLocCol.ok === false && (noLocCol.amount_cents == null || noLocCol.amount_cents !== DB_BUNDLE_HALFDAY_SOMO));

  console.log('\n[K] Effective windows — only currently effective session row wins');
  const EFFECTIVE_AMOUNT = 2200;
  const pgWindows = makeSchemaPg({
    locationsConfig: {},
    extraRows: [
      {
        id: 'expired-session',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: PERSISTED_ITEM_CODE,
        currency: 'EUR',
        amount_cents: 8800,
        unit: BILLING_UNIT,
        active: true,
        effective_from: '2025-01-01',
        effective_to: '2026-01-01',
        updated_at: '2025-12-01',
      },
      {
        id: 'future-session',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: PERSISTED_ITEM_CODE,
        currency: 'EUR',
        amount_cents: 7700,
        unit: BILLING_UNIT,
        active: true,
        effective_from: '2027-01-01',
        effective_to: null,
        updated_at: '2027-01-02',
      },
      {
        id: 'current-session',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: PERSISTED_ITEM_CODE,
        currency: 'EUR',
        amount_cents: EFFECTIVE_AMOUNT,
        unit: BILLING_UNIT,
        active: true,
        effective_from: '2026-03-01',
        effective_to: null,
        updated_at: '2026-04-01',
      },
    ],
  });
  const windowed = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: pgWindows,
  });
  assert('effective window returns only currently effective session row',
    windowed.ok === true && windowed.amount_cents === EFFECTIVE_AMOUNT, JSON.stringify(windowed));

  console.log('\n[L] Deterministic ordering — newest effective session row wins, not highest amount');
  const ORDER_WIN = 2300;
  const ORDER_LOSE = 9500;
  const pgOrder = makeSchemaPg({
    locationsConfig: {},
    extraRows: [
      {
        id: 'aaa-older-effective',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: PERSISTED_ITEM_CODE,
        currency: 'EUR',
        amount_cents: ORDER_LOSE,
        unit: BILLING_UNIT,
        active: true,
        effective_from: '2026-01-01',
        effective_to: null,
        updated_at: '2026-02-01',
      },
      {
        id: 'zzz-newer-effective',
        client_slug: 'sunset',
        location_id: 'sunset-somo',
        item_type: 'rental',
        item_code: PERSISTED_ITEM_CODE,
        currency: 'EUR',
        amount_cents: ORDER_WIN,
        unit: BILLING_UNIT,
        active: true,
        effective_from: '2026-06-01',
        effective_to: null,
        updated_at: '2026-06-02',
      },
    ],
  });
  const ordered = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: pgOrder,
  });
  const orderSql = priceQueries(pgOrder).map((q) => q.sql).join('\n');
  assert('deterministic ordering returns newer effective_from row',
    ordered.ok === true && ordered.amount_cents === ORDER_WIN, JSON.stringify(ordered));
  assert('deterministic ordering does NOT pick higher amount merely because it is higher',
    ordered.ok === true && ordered.amount_cents !== ORDER_LOSE);
  assert('deterministic ordering SQL includes effective_from and updated_at ordering',
    /effective_from DESC NULLS LAST/i.test(orderSql) && /updated_at DESC NULLS LAST/i.test(orderSql));

  console.log('\n[M] Faithful column introspection — parameterized column_name checks');
  const pgCols = makeSchemaPg({ locationsConfig: { 'sunset-somo': DB_BUNDLE_HALFDAY_SOMO } });
  await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: pgCols,
  });
  const asked = new Set(pgCols.columnQueries.map((q) => q.columnName));
  assert('column introspection queries location_id by parameter',
    asked.has('location_id') && pgCols.columnQueries.some((q) => q.columnName === 'location_id' && q.tableName === 'tenant_price_rules'));
  assert('column introspection queries effective_from by parameter', asked.has('effective_from'));
  assert('column introspection queries effective_to by parameter', asked.has('effective_to'));
  assert('column introspection queries updated_at by parameter', asked.has('updated_at'));

  console.log('\n[D] Query failure → typed failure, never baseline');
  const boom = {
    query: async () => { throw new Error('connection reset'); },
  };
  const failed = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: boom,
  });
  assert('query error → price_lookup_failed', failed.ok === false && failed.reason === 'price_lookup_failed');
  assert('query error does NOT fall back to baseline', failed.amount_cents == null || failed.amount_cents !== BASELINE_BUNDLE_HALFDAY);

  console.log('\n[E] DB read disabled → baseline preview path remains available');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'false';
  const preview = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item: 'board+suit bundle',
    duration: 'half day',
    pgClient: pgSomo,
  });
  assert('DB disabled → baseline seed returned', preview.ok === true && preview.amount_cents === BASELINE_BUNDLE_HALFDAY, JSON.stringify(preview));
  assert('DB disabled source is public_site seed', preview.source === 'public_site');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  console.log('\n[F-resolver] Owner DB price flows into the shared bundle-total function');
  process.env.SUNSET_ADMIN_JSON_OVERLAY = 'false';
  const dbLoad = (unitCents) => async (slug, pgClient, loc) => ({
    ok: true,
    hasData: true,
    prices: [{
      id: 'db-bundle',
      category: 'rental',
      offering_key: PERSISTED_ITEM_CODE,
      label: 'Board + wetsuit rental (bundle)',
      currency: 'EUR',
      unit: BILLING_UNIT,
      amount: unitCents / 100,
      active: true,
      source: 'db',
      effective_state: 'db',
    }],
    lesson_capacity: { default_daily_cap: 24, overrides: [], fromDb: false },
    lesson_times: [],
    surf_packs: [],
    private_lesson: null,
    change_history: [],
  });
  const cfgSomo = await resolveTenantBusinessConfigAsync('sunset', { loadFromDb: dbLoad(DB_BUNDLE_HALFDAY_SOMO), locationId: 'sunset-somo' });
  const totalSomo = configuredRentalBundleTotalCents(cfgSomo.prices, { offering_key: 'board_and_suit_rental', duration: GUEST_DURATION, quantity: 2 });
  assert(`booking/stripe bundle total uses DB unit × qty (${DB_BUNDLE_HALFDAY_SOMO} × 2 = ${DB_BUNDLE_HALFDAY_SOMO * 2})`, totalSomo === DB_BUNDLE_HALFDAY_SOMO * 2, String(totalSomo));
  assert('DB total differs from baseline total (1500 × 2)', totalSomo !== BASELINE_BUNDLE_HALFDAY * 2);
  const bundlePrice = cfgSomo.prices.find((p) => (p.offering_key || p.item_code) === PERSISTED_ITEM_CODE);
  assert('resolved bundle price is DB-sourced', bundlePrice && bundlePrice.source === 'db');

  console.log('\n[F/G] End-to-end booking + payment + Stripe aggregate from the DB price');
  const BOOKING_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const CLIENT_ID = 'cccccccc-dddd-eeee-ffff-000000000001';
  const GROUP_ID = 'pgdbprec0001abcd';

  function descriptor(quotedTotal) {
    return {
      pricing_group_id: GROUP_ID,
      offering_key: 'board_and_suit_rental',
      duration: GUEST_DURATION,
      quantity: 2,
      service_date: '2026-07-21',
      components: ['surfboard', 'wetsuit'],
      quoted_total_cents: quotedTotal,
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

  function mockPg(opts) {
    const updates = [];
    const bookingUpdates = [];
    const paymentInserts = [];
    const rows = opts.rows;
    const bookingMeta = opts.bookingMeta;
    const bookingTotals = { total_amount_cents: 0, balance_due_cents: 0, amount_paid_cents: 0 };
    let rolledBack = false;
    return {
      updates,
      bookingUpdates,
      paymentInserts,
      bookingTotals,
      rolledBack: () => rolledBack,
      query: async (sql, params) => {
        const s = String(sql);
        if (/^BEGIN/i.test(s) || /^COMMIT/i.test(s)) return { rows: [] };
        if (/^ROLLBACK/i.test(s)) { rolledBack = true; return { rows: [] }; }
        if (/information_schema\.tables/i.test(s) && /ANY\(/i.test(s)) {
          return { rows: [{ table_name: 'tenant_price_rules' }, { table_name: 'tenant_lesson_capacity_rules' }, { table_name: 'tenant_lesson_time_rules' }, { table_name: 'tenant_config_audit_log' }] };
        }
        if (/information_schema\.tables/i.test(s)) return { rows: [] };
        if (/information_schema\.columns/i.test(s)) return { rows: [] };
        if (/SELECT id, item_type, item_code, display_name/i.test(s)) {
          return {
            rows: [{
              id: 'db-bundle',
              item_type: 'rental',
              item_code: PERSISTED_ITEM_CODE,
              display_name: 'Bundle',
              currency: 'EUR',
              amount_cents: DB_BUNDLE_HALFDAY_SOMO,
              unit: BILLING_UNIT,
              active: true,
              effective_from: null,
              effective_to: null,
            }],
          };
        }
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

  const pgOk = mockPg({
    bookingMeta: { rental_pricing: descriptor(DB_BUNDLE_HALFDAY_SOMO * 2), location_id: 'sunset-somo', staff_manual_schedule: true, source: 'staff_manual_schedule' },
    rows: bundleRows(),
  });
  const priced = await priceSunsetBookingServices(pgOk, 'sunset', BOOKING_ID);
  assert('booking priced ok from DB price', priced.ok === true, priced.error);
  assert(`booking total = ${DB_BUNDLE_HALFDAY_SOMO * 2} (DB unit ${DB_BUNDLE_HALFDAY_SOMO} × 2)`, priced.total_cents === DB_BUNDLE_HALFDAY_SOMO * 2, String(priced.total_cents));
  const rowSum = pgOk.updates.reduce((a, u) => a + u.amount_due_cents, 0);
  assert(`service-row due amounts sum to ${DB_BUNDLE_HALFDAY_SOMO * 2}`, rowSum === DB_BUNDLE_HALFDAY_SOMO * 2, String(rowSum));

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
    bookingMeta: { rental_pricing: descriptor(DB_BUNDLE_HALFDAY_SOMO * 2), location_id: 'sunset-somo', staff_manual_schedule: true, source: 'staff_manual_schedule' },
    rows: bundleRows(),
  });
  const stripeResult = await createSunsetScheduleStripeLink(pgStripe, {
    clientSlug: 'sunset',
    bookingId: BOOKING_ID,
    locationId: 'sunset-somo',
    staffActionsEnabled: true,
    stripeLinksEnabled: true,
    stripeSecretKey: 'sk_test_dbprec',
    stripeSuccessUrl: 'https://example.com/success',
    stripeCancelUrl: 'https://example.com/cancel',
    actor: { email: 'staff@test.local' },
  });
  global.fetch = origFetch;
  assert('Stripe checkout succeeds', stripeResult.ok === true, stripeResult.body && stripeResult.body.error);
  assert(`API amount_due_cents = ${DB_BUNDLE_HALFDAY_SOMO * 2}`, stripeResult.body && stripeResult.body.amount_due_cents === DB_BUNDLE_HALFDAY_SOMO * 2);
  assert(`payment INSERT amount_due_cents = ${DB_BUNDLE_HALFDAY_SOMO * 2}`, pgStripe.paymentInserts.length === 1 && pgStripe.paymentInserts[0].amount_due_cents === DB_BUNDLE_HALFDAY_SOMO * 2);
  assert(`booking total_amount_cents = ${DB_BUNDLE_HALFDAY_SOMO * 2}`, pgStripe.bookingTotals.total_amount_cents === DB_BUNDLE_HALFDAY_SOMO * 2);
  assert('Stripe fetch called exactly once', stripeFetchCount === 1, String(stripeFetchCount));
  const decoded = decodeURIComponent(stripeBody);
  assert('Stripe currency EUR', /\[currency\]=eur/i.test(decoded));
  assert(`Stripe aggregate unit_amount = ${DB_BUNDLE_HALFDAY_SOMO * 2}`, new RegExp(`\\[unit_amount\\]=${DB_BUNDLE_HALFDAY_SOMO * 2}`).test(decoded));

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
    clientSlug: 'sunset',
    bookingId: BOOKING_ID,
    locationId: 'sunset-somo',
    staffActionsEnabled: true,
    stripeLinksEnabled: true,
    stripeSecretKey: 'sk_test_dbprec',
    stripeSuccessUrl: 'https://example.com/success',
    stripeCancelUrl: 'https://example.com/cancel',
  });
  global.fetch = origFetch;
  assert('stale quote → rental_pricing_quote_mismatch', stale.ok === false && stale.body && stale.body.error === 'rental_pricing_quote_mismatch', stale.body && stale.body.error);
  assert(`stale quote reports configured ${DB_BUNDLE_HALFDAY_SOMO * 2} vs quoted 3000`,
    stale.body && stale.body.configured_total_cents === DB_BUNDLE_HALFDAY_SOMO * 2 && stale.body.quoted_total_cents === 3000);
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
