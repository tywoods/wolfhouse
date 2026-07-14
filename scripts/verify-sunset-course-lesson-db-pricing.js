'use strict';

/**
 * verify:sunset-course-lesson-db-pricing
 *
 * TDD gate — course + private-lesson booking unit prices come from
 * tenant_price_rules via loadTenantPriceRuleFromDb (same fail-closed path as
 * rentals), NOT the aggregated catalog/config blob.
 *
 * Mock rows mirror the real Sunset portal schema:
 *   surf_pack_<packId>__<tier>   item_type=package  unit=day|session
 *   private_lesson__session      item_type=lesson   unit=session
 *
 * Run:
 *   node scripts/verify-sunset-course-lesson-db-pricing.js
 */

const {
  loadTenantPriceRuleFromDb,
  isSunsetAdminDbReadEnabled,
} = require('./lib/tenant-business-config');
const {
  lookupSunsetCourseLessonPriceAsync,
  resolveCourseLessonPriceIdentity,
} = require('./lib/sunset-course-lesson-price-lookup');
const {
  priceSunsetBookingServices,
  serviceRecordUnitPriceCents,
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

const PACK_ID = '22222222-2222-4222-8222-222222222222';
const TIER = '1_week';
const COURSE_ITEM_CODE = `surf_pack_${PACK_ID}__${TIER}`;
const PRIVATE_ITEM_CODE = 'private_lesson__session';
const COURSE_BILLING_UNIT = 'day';
const PRIVATE_BILLING_UNIT = 'session';

// Catalog/baseline must differ so a catalog win is detectable.
const DB_COURSE_CENTS = 27100;
const CATALOG_COURSE_CENTS = 18000;
const DB_PRIVATE_CENTS = 9500;
const CATALOG_PRIVATE_CENTS = 6000;
const DB_COURSE_SARDI = 19900;

const FIXED_NOW = new Date('2026-07-15T12:00:00Z');

function calendarDateKey(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function schemaRowsFor(loc, itemType, itemCode, unit, amountCents) {
  return [
    {
      id: 'hist-inactive',
      client_slug: 'sunset',
      location_id: loc,
      item_type: itemType,
      item_code: itemCode,
      display_name: 'retired',
      currency: 'EUR',
      amount_cents: amountCents + 5000,
      unit,
      active: false,
      effective_from: '2020-01-01',
      effective_to: null,
      updated_at: '2020-06-01',
    },
    {
      id: 'active-authoritative',
      client_slug: 'sunset',
      location_id: loc,
      item_type: itemType,
      item_code: itemCode,
      display_name: 'owner rule',
      currency: 'EUR',
      amount_cents: amountCents,
      unit,
      active: true,
      effective_from: '2026-01-01',
      effective_to: null,
      updated_at: '2026-06-01',
    },
  ];
}

function makeSchemaPg(opts = {}) {
  const columnPresence = {
    location_id: true,
    effective_from: true,
    effective_to: true,
    updated_at: true,
    ...(opts.columnPresence || {}),
  };
  const fixedNow = opts.fixedNow || FIXED_NOW;
  const capturedQueries = [];
  const allRows = [...(opts.rows || [])];

  function columnPresent(tableName, columnName) {
    if (tableName !== 'tenant_price_rules') return false;
    return columnPresence[columnName] === true;
  }

  function withinEffectiveWindow(row) {
    const today = calendarDateKey(fixedNow);
    const from = calendarDateKey(row.effective_from);
    const to = calendarDateKey(row.effective_to);
    if (from && from > today) return false;
    if (to && to < today) return false;
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
      return String(b.id).localeCompare(String(a.id));
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
    query: async (sql, params) => {
      const s = String(sql);
      capturedQueries.push({ sql: s, params: params ? [...params] : [] });
      if (/to_regclass/i.test(s)) {
        if (opts.tablesMissing) return { rows: [{ reg: null }] };
        return { rows: [{ reg: 'tenant_price_rules' }] };
      }
      if (/information_schema\.columns/i.test(s)) {
        if (/column_name = \$2/i.test(s)) {
          const tableName = params[0];
          const columnName = params[1];
          return { rows: columnPresent(tableName, columnName) ? [{ '?column?': 1 }] : [] };
        }
        if (/column_name = 'location_id'/i.test(s)) {
          return { rows: columnPresent(params[0], 'location_id') ? [{ '?column?': 1 }] : [] };
        }
      }
      if (/FROM tenant_price_rules/i.test(s)) {
        if (opts.queryError) throw new Error(opts.queryError);
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

function catalogAdminCfg(courseCents, privateCents) {
  return {
    ok: true,
    source: 'config',
    location_id: 'sunset-somo',
    prices: [
      {
        id: 'catalog-course',
        category: 'package',
        offering_key: COURSE_ITEM_CODE,
        label: 'Catalog course (stale)',
        currency: 'EUR',
        unit: COURSE_BILLING_UNIT,
        amount: courseCents / 100,
        active: true,
        source: 'config',
      },
      {
        id: 'catalog-private',
        category: 'lesson',
        offering_key: PRIVATE_ITEM_CODE,
        label: 'Catalog private (stale)',
        currency: 'EUR',
        unit: PRIVATE_BILLING_UNIT,
        amount: privateCents / 100,
        active: true,
        source: 'config',
      },
    ],
    surf_packs: [{
      pack_id: PACK_ID,
      label: 'Adults week course',
      active: true,
      group_size: 16,
      weekly: 'mon_fri',
      schedules: ['0930_1130'],
      price_tiers: [{ key: TIER, label: '1 week', hours: 10, amount_cents: courseCents }],
    }],
    private_lesson: {
      rule_id: 'private_lesson',
      amount_cents: privateCents,
      unit: 'session',
      billing_unit: 'session',
      label: 'Private lesson',
      active: true,
    },
    lesson_times: [],
    lesson_capacity: { default_daily_cap: 24, overrides: [] },
  };
}

function bookingPg(opts) {
  const updates = [];
  const bookingUpdates = [];
  const paymentInserts = [];
  const schema = makeSchemaPg({ rows: opts.priceRows || [] });
  const services = opts.services;
  const bookingMeta = opts.bookingMeta || { location_id: 'sunset-somo', source: 'luna_guest_whatsapp' };
  let rolledBack = false;
  let totalCents = 0;

  return {
    updates,
    bookingUpdates,
    paymentInserts,
    totalCents: () => totalCents,
    rolledBack: () => rolledBack,
    schema,
    query: async (sql, params) => {
      const s = String(sql);
      // Delegate price-rule / schema probes to schema mock.
      if (/to_regclass/i.test(s) || /information_schema\.columns/i.test(s) || /FROM tenant_price_rules/i.test(s)) {
        return schema.query(sql, params);
      }
      if (/^BEGIN/i.test(s) || /^COMMIT/i.test(s)) return { rows: [] };
      if (/^ROLLBACK/i.test(s)) { rolledBack = true; return { rows: [] }; }
      if (/SELECT metadata FROM bookings/i.test(s)) {
        return { rows: [{ metadata: bookingMeta }] };
      }
      if (/FROM booking_service_records/i.test(s) && /SELECT id/i.test(s)) {
        return { rows: services };
      }
      if (/UPDATE booking_service_records SET amount_due_cents/i.test(s)) {
        updates.push({ id: params[1], due: params[0] });
        const row = services.find((r) => String(r.id) === String(params[1]));
        if (row) row.amount_due_cents = params[0];
        return { rows: [] };
      }
      if (/UPDATE bookings/i.test(s) && /total_amount_cents/i.test(s)) {
        totalCents = params[0];
        bookingUpdates.push({ total: params[0], meta: params[1] });
        return { rows: [] };
      }
      if (/INSERT INTO payments/i.test(s)) {
        paymentInserts.push({ amount: params.find((p) => typeof p === 'number') });
        return { rows: [{ id: 'pay-1' }] };
      }
      if (/FROM bookings b/i.test(s) && /booking_code/i.test(s)) {
        return {
          rows: [{
            booking_id: opts.bookingId || 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            booking_code: 'SUN-TEST1',
            guest_name: 'Test Guest',
            status: 'confirmed',
            payment_status: 'unpaid',
            check_in: '2026-07-21',
            check_out: '2026-07-21',
            metadata: bookingMeta,
          }],
        };
      }
      if (/SELECT id::text AS payment_id/i.test(s)) return { rows: [] };
      if (/information_schema\.tables/i.test(s)) {
        return { rows: [{ table_name: 'tenant_price_rules' }] };
      }
      return { rows: [] };
    },
  };
}

async function main() {
  console.log('\nverify:sunset-course-lesson-db-pricing — course/lesson DB prices are authoritative\n');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  console.log('[0] Identity resolver — real portal item_code shapes');
  const courseId = resolveCourseLessonPriceIdentity({
    component: 'course',
    course_id: PACK_ID,
    offering_id: COURSE_ITEM_CODE,
    location_id: 'sunset-somo',
  });
  assert('course identity → surf_pack_<id>__1_week',
    courseId && courseId.itemCode === COURSE_ITEM_CODE, JSON.stringify(courseId));
  assert('course identity → item_type=package', courseId && courseId.itemType === 'package');
  assert('course identity → billing unit=day (not 1_week)',
    courseId && courseId.billingUnit === COURSE_BILLING_UNIT);
  const privateId = resolveCourseLessonPriceIdentity({
    component: 'private_lesson',
    location_id: 'sunset-somo',
  });
  assert('private identity → private_lesson__session',
    privateId && privateId.itemCode === PRIVATE_ITEM_CODE, JSON.stringify(privateId));
  assert('private identity → item_type=lesson billing=session',
    privateId && privateId.itemType === 'lesson' && privateId.billingUnit === 'session');

  console.log('\n[A] RED→GREEN: sync catalog pricing currently wins (pre-fix) / DB must win (post-fix)');
  const staleCfg = catalogAdminCfg(CATALOG_COURSE_CENTS, CATALOG_PRIVATE_CENTS);
  const courseSr = {
    service_type: 'surf_lesson',
    quantity: 1,
    metadata: {
      component: 'course',
      staff_ui_service_type: 'course',
      course_id: PACK_ID,
      offering_id: COURSE_ITEM_CODE,
      location_id: 'sunset-somo',
    },
  };
  const syncCourse = serviceRecordUnitPriceCents(staleCfg.prices, courseSr, staleCfg);
  assert('sync catalog helper still returns catalog amount for identity (non-authoritative helper)',
    syncCourse === CATALOG_COURSE_CENTS, String(syncCourse));

  const pgCourse = makeSchemaPg({
    rows: schemaRowsFor('sunset-somo', 'package', COURSE_ITEM_CODE, COURSE_BILLING_UNIT, DB_COURSE_CENTS),
  });
  const liveCourse = await lookupSunsetCourseLessonPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    metadata: courseSr.metadata,
    quantity: 1,
    pgClient: pgCourse,
  });
  const cq = priceQueries(pgCourse);
  assert('course live lookup queries exact item_code',
    cq.some((q) => q.params[2] === COURSE_ITEM_CODE), JSON.stringify(cq.map((q) => q.params)));
  assert('course live lookup filters unit=day (not week tier key)',
    cq.some((q) => /unit\s*=\s*\$4/i.test(q.sql) && q.params[3] === COURSE_BILLING_UNIT));
  assert('course live lookup returns DB amount (not catalog)',
    liveCourse.ok === true && liveCourse.amount_cents === DB_COURSE_CENTS, JSON.stringify(liveCourse));
  assert('course DB amount differs from catalog', DB_COURSE_CENTS !== CATALOG_COURSE_CENTS);
  assert('course source is db', liveCourse.source === 'db');

  console.log('\n[B] Private lesson DB wins over catalog');
  const privateSrMeta = {
    component: 'private_lesson',
    staff_ui_service_type: 'private_lesson',
    location_id: 'sunset-somo',
  };
  const pgPrivate = makeSchemaPg({
    rows: schemaRowsFor('sunset-somo', 'lesson', PRIVATE_ITEM_CODE, PRIVATE_BILLING_UNIT, DB_PRIVATE_CENTS),
  });
  const livePrivate = await lookupSunsetCourseLessonPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    metadata: privateSrMeta,
    quantity: 1,
    pgClient: pgPrivate,
  });
  const pq = priceQueries(pgPrivate);
  assert('private lookup queries private_lesson__session',
    pq.some((q) => q.params[2] === PRIVATE_ITEM_CODE), JSON.stringify(pq.map((q) => q.params)));
  assert('private lookup returns DB amount',
    livePrivate.ok === true && livePrivate.amount_cents === DB_PRIVATE_CENTS, JSON.stringify(livePrivate));
  assert('private DB ≠ catalog', DB_PRIVATE_CENTS !== CATALOG_PRIVATE_CENTS);

  console.log('\n[C] Location isolation');
  const pgBoth = makeSchemaPg({
    rows: [
      ...schemaRowsFor('sunset-somo', 'package', COURSE_ITEM_CODE, COURSE_BILLING_UNIT, DB_COURSE_CENTS),
      ...schemaRowsFor('sunset-sardinero', 'package', COURSE_ITEM_CODE, COURSE_BILLING_UNIT, DB_COURSE_SARDI),
    ],
  });
  const somo = await lookupSunsetCourseLessonPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    metadata: courseSr.metadata,
    pgClient: pgBoth,
  });
  const sardi = await lookupSunsetCourseLessonPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-sardinero',
    metadata: { ...courseSr.metadata, location_id: 'sunset-sardinero' },
    pgClient: pgBoth,
  });
  assert('Somo course = Somo DB', somo.ok && somo.amount_cents === DB_COURSE_CENTS);
  assert('Sardi course = Sardi DB', sardi.ok && sardi.amount_cents === DB_COURSE_SARDI);
  assert('locations do not cross', somo.amount_cents !== sardi.amount_cents);

  const pgSomoOnly = makeSchemaPg({
    rows: schemaRowsFor('sunset-somo', 'package', COURSE_ITEM_CODE, COURSE_BILLING_UNIT, DB_COURSE_CENTS),
  });
  const sardiMissing = await lookupSunsetCourseLessonPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-sardinero',
    metadata: { ...courseSr.metadata, location_id: 'sunset-sardinero' },
    pgClient: pgSomoOnly,
  });
  assert('missing location rule → price_not_configured',
    sardiMissing.ok === false && sardiMissing.reason === 'price_not_configured', JSON.stringify(sardiMissing));
  assert('missing location does NOT return catalog/Somo',
    sardiMissing.amount_cents == null || (sardiMissing.amount_cents !== CATALOG_COURSE_CENTS
      && sardiMissing.amount_cents !== DB_COURSE_CENTS));

  console.log('\n[D] Missing rule (tables exist) → price_not_configured, never catalog');
  const pgEmpty = makeSchemaPg({ rows: [] });
  const missing = await lookupSunsetCourseLessonPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    metadata: courseSr.metadata,
    pgClient: pgEmpty,
  });
  assert('missing → price_not_configured', missing.ok === false && missing.reason === 'price_not_configured');
  assert('missing never returns catalog amount',
    missing.amount_cents == null || missing.amount_cents !== CATALOG_COURSE_CENTS);

  console.log('\n[E] Query error → typed failure');
  const boom = await lookupSunsetCourseLessonPriceAsync({
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    metadata: courseSr.metadata,
    pgClient: makeSchemaPg({
      rows: schemaRowsFor('sunset-somo', 'package', COURSE_ITEM_CODE, COURSE_BILLING_UNIT, DB_COURSE_CENTS),
      queryError: 'connection reset',
    }),
  });
  assert('query error → price_lookup_failed', boom.ok === false && boom.reason === 'price_lookup_failed');
  assert('query error no catalog fallback', boom.amount_cents == null || boom.amount_cents !== CATALOG_COURSE_CENTS);

  console.log('\n[F] Tenant isolation — non-sunset rejected');
  let threw = false;
  try {
    await loadTenantPriceRuleFromDb(pgCourse, {
      clientSlug: 'wolfhouse',
      locationId: 'sunset-somo',
      itemType: 'package',
      itemCode: COURSE_ITEM_CODE,
      duration: '',
      billingUnit: COURSE_BILLING_UNIT,
    });
  } catch (err) {
    threw = /tenant_scope_violation/.test(String(err && err.message));
  }
  assert('wolfhouse client_slug throws tenant_scope_violation', threw);

  const whLookup = await lookupSunsetCourseLessonPriceAsync({
    client_slug: 'wolfhouse',
    location_id: 'sunset-somo',
    metadata: courseSr.metadata,
    pgClient: pgCourse,
  });
  assert('wolfhouse lookup → tenant_mismatch', whLookup.ok === false && whLookup.reason === 'tenant_mismatch');

  console.log('\n[G] End-to-end booking total uses DB unit × qty (not catalog)');
  const QTY = 2;
  const expectedTotal = DB_COURSE_CENTS * QTY;
  const e2e = bookingPg({
    priceRows: schemaRowsFor('sunset-somo', 'package', COURSE_ITEM_CODE, COURSE_BILLING_UNIT, DB_COURSE_CENTS),
    services: [{
      id: 'sr-course-1',
      service_type: 'surf_lesson',
      service_date: '2026-07-21',
      quantity: QTY,
      amount_due_cents: 0,
      metadata: JSON.stringify({
        component: 'course',
        staff_ui_service_type: 'course',
        course_id: PACK_ID,
        offering_id: COURSE_ITEM_CODE,
        location_id: 'sunset-somo',
      }),
    }],
    bookingMeta: { location_id: 'sunset-somo', source: 'luna_guest_whatsapp' },
  });

  // Intercept config resolve so catalog stays stale while DB has the real rule.
  const tbc = require('./lib/tenant-business-config');
  const origResolve = tbc.resolveTenantBusinessConfigAsync;
  tbc.resolveTenantBusinessConfigAsync = async () => catalogAdminCfg(CATALOG_COURSE_CENTS, CATALOG_PRIVATE_CENTS);
  let priced;
  try {
    priced = await priceSunsetBookingServices(e2e, 'sunset', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  } finally {
    tbc.resolveTenantBusinessConfigAsync = origResolve;
  }
  assert('booking priced ok', priced && priced.ok === true, JSON.stringify(priced));
  assert(`booking total = DB × qty (${expectedTotal})`,
    priced.total_cents === expectedTotal, JSON.stringify(priced));
  assert('booking total ≠ catalog × qty',
    priced.total_cents !== CATALOG_COURSE_CENTS * QTY);
  assert('service row updated to DB amount',
    e2e.updates.some((u) => u.due === expectedTotal), JSON.stringify(e2e.updates));
  assert('DB read flag is on during e2e', isSunsetAdminDbReadEnabled() === true);

  console.log('\n[H] Private-lesson booking total from DB');
  const privateExpected = DB_PRIVATE_CENTS * 1;
  const e2ePriv = bookingPg({
    priceRows: schemaRowsFor('sunset-somo', 'lesson', PRIVATE_ITEM_CODE, PRIVATE_BILLING_UNIT, DB_PRIVATE_CENTS),
    services: [{
      id: 'sr-pl-1',
      service_type: 'surf_lesson',
      service_date: '2026-07-21',
      quantity: 1,
      amount_due_cents: 0,
      metadata: JSON.stringify({
        component: 'private_lesson',
        staff_ui_service_type: 'private_lesson',
        location_id: 'sunset-somo',
      }),
    }],
  });
  tbc.resolveTenantBusinessConfigAsync = async () => catalogAdminCfg(CATALOG_COURSE_CENTS, CATALOG_PRIVATE_CENTS);
  let pricedPriv;
  try {
    pricedPriv = await priceSunsetBookingServices(e2ePriv, 'sunset', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  } finally {
    tbc.resolveTenantBusinessConfigAsync = origResolve;
  }
  assert('private booking priced ok', pricedPriv && pricedPriv.ok === true, JSON.stringify(pricedPriv));
  assert('private booking total = DB',
    pricedPriv.total_cents === privateExpected, JSON.stringify(pricedPriv));
  assert('private booking ≠ catalog',
    pricedPriv.total_cents !== CATALOG_PRIVATE_CENTS);

  console.log('\n[I] Missing DB rule on booking path fails closed (no catalog write)');
  const e2eMissing = bookingPg({
    priceRows: [],
    services: [{
      id: 'sr-course-missing',
      service_type: 'surf_lesson',
      service_date: '2026-07-21',
      quantity: 1,
      amount_due_cents: 0,
      metadata: JSON.stringify({
        component: 'course',
        course_id: PACK_ID,
        offering_id: COURSE_ITEM_CODE,
        location_id: 'sunset-somo',
      }),
    }],
  });
  tbc.resolveTenantBusinessConfigAsync = async () => catalogAdminCfg(CATALOG_COURSE_CENTS, CATALOG_PRIVATE_CENTS);
  let pricedMissing;
  try {
    pricedMissing = await priceSunsetBookingServices(e2eMissing, 'sunset', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  } finally {
    tbc.resolveTenantBusinessConfigAsync = origResolve;
  }
  assert('missing rule booking fails', pricedMissing && pricedMissing.ok === false, JSON.stringify(pricedMissing));
  assert('missing rule does not write catalog amount onto row',
    !e2eMissing.updates.some((u) => u.due === CATALOG_COURSE_CENTS), JSON.stringify(e2eMissing.updates));

  console.log(`\nTotals: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
