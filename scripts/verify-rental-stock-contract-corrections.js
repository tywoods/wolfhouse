'use strict';

/**
 * Focused contract corrections for rental stock Slice B release blockers.
 *
 * Executes actual callers (normalize/collect/assert/quote/create paths), not
 * source-regex only. Covers:
 *   1) No future exclusion/conflict semantics; combo+board+wetsuit independent
 *   2) Luna catalog-driven arbitrary Admin offerings via production
 *      executeSunsetQuote + createSunsetScheduleBooking (not helpers alone)
 *   3) Course-equipment included in Create/Edit stock claims merge
 *   4) Restore sums independent rows; historical component pairs dedupe once;
 *      multi-day demand is per-day (not inflated across dates)
 *
 * Run: node scripts/verify-rental-stock-contract-corrections.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const stock = require('./lib/tenant-rental-stock');
const stockService = require('./lib/tenant-rental-stock-service');
const {
  validateRentalOfferingBody,
  applyRentalMutualExclusion,
} = require('./lib/tenant-rental-offerings');
const {
  normalizeCanonicalRentalsForQuote,
  executeSunsetQuote,
  QUOTE_CHANNELS,
  buildSunsetQuoteCommand,
} = require('./lib/luna-front-desk-quote-service');
const {
  prepareGenericRentalsForCreate,
  createSunsetScheduleBooking,
} = require('./lib/sunset-schedule-booking-writes');

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

function createMockStockPg({ offerings = [], reservations = [], prices = [] } = {}) {
  return {
    async query(sql, params = []) {
      const s = String(sql || '');
      if (/FOR UPDATE/i.test(s) && /tenant_rental_offerings/i.test(s)) {
        const keys = Array.isArray(params[2]) ? params[2] : [];
        const slug = params[0];
        const loc = params[1];
        const rows = offerings.filter((o) => o.client_slug === slug
          && keys.includes(o.offering_key)
          && (o.location_id === loc || o.location_id == null)
          && o.active !== false);
        return { rows, rowCount: rows.length };
      }
      if (/FROM booking_service_records/i.test(s) || /active rental/i.test(s)
        || /rental_service_dates/i.test(s) || /service_date/i.test(s)) {
        return { rows: reservations, rowCount: reservations.length };
      }
      if (/tenant_price_rules/i.test(s) || /item_code/i.test(s)) {
        const itemCode = params.find((p) => typeof p === 'string' && p.includes('__'));
        const hit = prices.find((p) => p.item_code === itemCode || p.offering_key === params[2]);
        if (hit) {
          return {
            rows: [{
              amount_cents: hit.amount_cents,
              currency: hit.currency || 'EUR',
              item_code: hit.item_code || itemCode,
              unit: hit.unit || 'day',
              location_id: hit.location_id || 'sunset-somo',
              pricing_status: 'confirmed',
              status: 'found',
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      if (/tenant_rental_offerings/i.test(s) && /SELECT/i.test(s)) {
        return { rows: offerings.filter((o) => o.active !== false), rowCount: offerings.length };
      }
      if (/BEGIN|COMMIT|ROLLBACK|advisory/i.test(s)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
}

async function main() {
  section('1) No future exclusion / simultaneous combo+board+wetsuit');

  const nonempty = validateRentalOfferingBody({
    offering_key: 'custom_combo',
    label: 'Custom Combo',
    group_key: 'custom',
    excludes: ['board_rental'],
  });
  ok(
    'Admin nonempty excludes → rental_excludes_not_supported',
    !nonempty.ok && nonempty.error === 'rental_excludes_not_supported',
    JSON.stringify(nonempty),
  );
  const emptyOk = validateRentalOfferingBody({
    offering_key: 'custom_combo',
    label: 'Custom Combo',
    group_key: 'custom',
    excludes: [],
  });
  ok('empty excludes accepted', emptyOk.ok && emptyOk.value.excludes.length === 0);

  const legacyCat = [
    { offering_key: 'board_and_suit_rental', excludes: ['board_rental', 'wetsuit_rental'] },
    { offering_key: 'board_rental', excludes: ['board_and_suit_rental'] },
    { offering_key: 'wetsuit_rental', excludes: ['board_and_suit_rental'] },
  ];
  const sel = applyRentalMutualExclusion(
    ['board_and_suit_rental', 'board_rental', 'wetsuit_rental'],
    legacyCat,
  );
  ok('selection ignores legacy excludes', sel.blocked.length === 0 && sel.allowed.length === 3);

  // Quote normalize: simultaneous combo+board+wetsuit succeeds
  const rentalsNorm = normalizeCanonicalRentalsForQuote({
    rentals: [
      { offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 },
      { offering_key: 'board_rental', duration_key: '1_day', quantity: 2 },
      { offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 3 },
    ],
  }, '1_day');
  ok(
    'normalize allows combo+board+wetsuit',
    rentalsNorm.ok && rentalsNorm.value.length === 3,
    JSON.stringify(rentalsNorm),
  );

  // Stock claims: three independent keys
  const threeClaims = stockService.collectRentalStockClaims(
    [
      { offering_key: 'board_and_suit_rental', quantity: 1 },
      { offering_key: 'board_rental', quantity: 2 },
      { offering_key: 'wetsuit_rental', quantity: 3 },
    ],
    '2026-09-01',
    '2026-09-01',
  );
  ok(
    'three independent stock claims',
    threeClaims.ok
      && threeClaims.claims.length === 3
      && threeClaims.claims.find((c) => c.offering_key === 'board_rental').quantity === 2
      && threeClaims.claims.find((c) => c.offering_key === 'wetsuit_rental').quantity === 3
      && threeClaims.claims.find((c) => c.offering_key === 'board_and_suit_rental').quantity === 1,
    JSON.stringify(threeClaims),
  );

  // prepareGenericRentals no longer applies catalog excludes; no env flag needed
  delete process.env.GENERIC_RENTAL_CREATE_ENABLED;
  const mockCatalog = [
    { offering_key: 'kayak_rental', active: true, excludes: ['board_rental'], label: 'Kayak' },
    { offering_key: 'board_rental', active: true, excludes: ['kayak_rental'] },
  ];
  const genPrep = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    pgClient: createMockStockPg({ offerings: mockCatalog }),
    rentals: [
      { offering_key: 'kayak_rental', duration_key: '1_day', quantity: 1 },
      { offering_key: 'board_rental', duration_key: '1_day', quantity: 1 },
    ],
    serviceDate: '2026-09-01',
    calendarDayCount: 1,
    bookingDurationKey: '1_day',
    listOfferings: async () => mockCatalog,
    loadRule: async () => ({
      status: 'found',
      amount_cents: 2500,
      currency: 'EUR',
      item_code: 'kayak_rental__1_day',
      unit: 'day',
      pricing_status: 'confirmed',
    }),
  });
  // board_rental is canonical → only kayak is generic; no catalog conflict
  ok(
    'generic prep does not apply excludes (no rental_catalog_conflict)',
    genPrep.ok === true && genPrep.records.length === 1
      && genPrep.records[0].metadata.offering_key === 'kayak_rental',
    JSON.stringify(genPrep),
  );

  section('2) Luna production quote/create for arbitrary Admin catalog items');

  // Shape-level accept still matters for transport validation
  const kayakNorm = normalizeCanonicalRentalsForQuote({
    rentals: [{ offering_key: 'kayak_rental', duration_key: '1_day', quantity: 1 }],
  }, '1_day');
  ok('kayak_rental shape accepted for quote', kayakNorm.ok && kayakNorm.value[0].offering_key === 'kayak_rental');

  const customNorm = normalizeCanonicalRentalsForQuote({
    rentals: [{ offering_key: 'surfboard_plus_wetsuit_custom', duration_key: '1_day', quantity: 1 }],
  }, '1_day');
  ok(
    'surfboard_plus_wetsuit_custom shape accepted',
    customNorm.ok && customNorm.value[0].offering_key === 'surfboard_plus_wetsuit_custom',
  );

  const badShape = normalizeCanonicalRentalsForQuote({
    rentals: [{ offering_key: 'Bad Key!!', duration_key: '1_day', quantity: 1 }],
  }, '1_day');
  ok('malformed offering_key rejected', !badShape.ok);

  const KAYAK_CENTS = 3500;
  const CUSTOM_CENTS = 4500;
  const LOC = 'sunset-somo';
  const DATE = '2026-09-10';
  const FIXED_NOW = new Date('2026-09-01T12:00:00Z');
  const CATALOG_OFFERINGS = [
    {
      id: '1', client_slug: 'sunset', location_id: LOC,
      offering_key: 'kayak_rental', label: 'Sea Kayak', group_key: 'sup',
      excludes: [], sort_order: 5, stock_quantity: 4, active: true,
    },
    {
      id: '2', client_slug: 'sunset', location_id: LOC,
      offering_key: 'surfboard_plus_wetsuit_custom', label: 'Surf+Suit Custom',
      group_key: 'custom', excludes: [], sort_order: 6, stock_quantity: 3, active: true,
    },
  ];
  const PRICE_MAP = {
    kayak_rental__1_day: { amount_cents: KAYAK_CENTS, unit: 'day' },
    surfboard_plus_wetsuit_custom__1_day: { amount_cents: CUSTOM_CENTS, unit: 'day' },
  };

  function parseMeta(m) {
    try { return typeof m === 'string' ? JSON.parse(m) : (m || {}); } catch (_) { return {}; }
  }

  /**
   * Transaction-aware mock that exercises REAL production create + quote SQL paths:
   * catalog list, price rules, stock FOR UPDATE, booking/service inserts.
   */
  function createCatalogTxnPg(opts = {}) {
    const offerings = (opts.offerings || CATALOG_OFFERINGS).map((o) => ({ ...o }));
    // opts.prices replaces defaults when provided (use {} for fully unpriced).
    const prices = opts.prices != null ? { ...opts.prices } : { ...PRICE_MAP };
    const reservations = Array.isArray(opts.reservations) ? opts.reservations.slice() : [];
    const state = {
      clientId: '11111111-1111-1111-1111-111111111111',
      bookings: [],
      serviceRecords: [],
      bookingInserts: 0,
      serviceInserts: 0,
    };
    return {
      state,
      offerings,
      async query(sql, params = []) {
        const s = String(sql || '');
        if (/SELECT id FROM clients WHERE slug/i.test(s)) {
          return { rows: [{ id: state.clientId }], rowCount: 1 };
        }
        if (/BEGIN|COMMIT|ROLLBACK/i.test(s)) return { rows: [], rowCount: 0 };
        if (/pg_advisory/i.test(s)) return { rows: [{}], rowCount: 1 };
        if (/to_regclass/i.test(s)) return { rows: [{ reg: 'public.tenant_price_rules' }], rowCount: 1 };
        if (/information_schema/i.test(s)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
        if (/CREATE|ALTER/i.test(s)) return { rows: [], rowCount: 0 };
        if (/tenant_surf_pack|tenant_private_lesson/i.test(s)) return { rows: [], rowCount: 0 };

        if (/FOR UPDATE/i.test(s) && /tenant_rental_offerings/i.test(s)) {
          const keys = Array.isArray(params[2]) ? params[2] : [];
          const slug = params[0];
          const loc = params[1];
          const rows = offerings.filter((o) => o.client_slug === slug
            && keys.includes(o.offering_key)
            && (o.location_id === loc || o.location_id == null)
            && o.active !== false);
          return { rows, rowCount: rows.length };
        }
        if (/FROM tenant_rental_offerings/i.test(s)) {
          const rows = offerings.filter((o) => o.active !== false);
          return { rows, rowCount: rows.length };
        }
        if (/FROM tenant_price_rules/i.test(s)) {
          const itemCode = params[2];
          const hit = prices[itemCode];
          if (!hit) return { rows: [], rowCount: 0 };
          return {
            rows: [{
              amount_cents: hit.amount_cents,
              currency: 'EUR',
              item_type: 'rental',
              item_code: itemCode,
              unit: hit.unit || 'day',
              location_id: hit.location_id || LOC,
            }],
            rowCount: 1,
          };
        }
        if (/booking_service_records/i.test(s) && /NOT IN \('cancelled'/i.test(s)) {
          return { rows: reservations, rowCount: reservations.length };
        }
        if (/metadata->>'idempotency_key'/i.test(s)) return { rows: [], rowCount: 0 };
        if (/INSERT INTO bookings/i.test(s)) {
          state.bookingInserts += 1;
          const row = {
            id: `bk-${state.bookingInserts}`,
            booking_code: params[1],
            metadata: parseMeta(params[8]),
          };
          state.bookings.push(row);
          return { rows: [{ id: row.id, booking_code: row.booking_code }], rowCount: 1 };
        }
        if (/INSERT INTO booking_service_records/i.test(s)) {
          state.serviceInserts += 1;
          const metaParam = [params[10], params[9]].find(
            (p) => typeof p === 'string' && String(p).trim().startsWith('{'),
          );
          const meta = parseMeta(metaParam);
          const row = {
            service_record_id: `sr-${state.serviceInserts}`,
            booking_id: params[1],
            booking_code: params[2],
            guest_name: params[3],
            service_type: params[4],
            service_date: params[5],
            quantity: params[6],
            amount_due_cents: params[7],
            client_slug: params[0],
            metadata: meta,
          };
          state.serviceRecords.push(row);
          return { rows: [row], rowCount: 1 };
        }
        if (/COALESCE\(SUM/i.test(s)) return { rows: [{ seats: 0 }], rowCount: 1 };
        if (/UPDATE\s+(booking_service_records|bookings)/i.test(s)) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
  }

  const adminCfg = {
    ok: true,
    source: 'db',
    currency: 'EUR',
    surf_packs: [],
    prices: [],
    rental_offerings: CATALOG_OFFERINGS,
  };

  function lunaRentalBody(offeringKey, quantity = 1) {
    return {
      guest_name: 'Luna Guest',
      date_from: DATE,
      date_to: DATE,
      service_dates: [DATE],
      surfer_count: quantity,
      rentals: [{ offering_key: offeringKey, duration_key: '1_day', quantity }],
      components: {},
      payment_status: 'unpaid',
    };
  }

  async function lunaQuote(pg, offeringKey, quantity = 1) {
    const built = buildSunsetQuoteCommand({
      channel: QUOTE_CHANNELS.LUNA_WHATSAPP,
      clientSlug: 'sunset',
      trustedLocationId: LOC,
      transportBody: lunaRentalBody(offeringKey, quantity),
      now: FIXED_NOW,
    });
    assert.strictEqual(built.ok, true, JSON.stringify(built));
    return executeSunsetQuote(pg, built.command, { adminCfg });
  }

  async function staffCreate(pg, offeringKey, quantity = 1, extraBody = {}) {
    return createSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      locationId: LOC,
      actor: { email: 'staff@sunset.test' },
      body: {
        guest_name: 'Staff Guest',
        guest_phone: '+34600111222',
        surfer_count: quantity,
        date_from: DATE,
        date_to: DATE,
        payment_status: 'unpaid',
        rentals: [{ offering_key: offeringKey, duration_key: '1_day', quantity }],
        ...extraBody,
      },
      now: FIXED_NOW,
    });
  }

  // ── Production executeSunsetQuote for kayak + custom ───────────────────
  {
    const qPg = createCatalogTxnPg();
    const kayakQ = await lunaQuote(qPg, 'kayak_rental', 1);
    const kLine = (kayakQ.body && kayakQ.body.line_items || [])[0] || {};
    ok(
      'executeSunsetQuote kayak_rental succeeds with label/duration/qty/unit/total',
      kayakQ.ok === true
        && kayakQ.status === 200
        && kayakQ.body.total_cents === KAYAK_CENTS
        && (kayakQ.body.line_items || []).length === 1
        && kLine.offering_key === 'kayak_rental'
        && kLine.label === 'Sea Kayak'
        && kLine.duration_key === '1_day'
        && Number(kLine.quantity) === 1
        && Number(kLine.unit_amount_cents) === KAYAK_CENTS
        && Number(kLine.total_cents) === KAYAK_CENTS,
      JSON.stringify(kayakQ.body),
    );

    const customQ = await lunaQuote(qPg, 'surfboard_plus_wetsuit_custom', 1);
    const cLine = (customQ.body && customQ.body.line_items || [])[0] || {};
    ok(
      'executeSunsetQuote surfboard_plus_wetsuit_custom succeeds as ordinary item',
      customQ.ok === true
        && customQ.body.total_cents === CUSTOM_CENTS
        && (customQ.body.line_items || []).length === 1
        && cLine.offering_key === 'surfboard_plus_wetsuit_custom'
        && cLine.label === 'Surf+Suit Custom'
        && cLine.duration_key === '1_day'
        && Number(cLine.unit_amount_cents) === CUSTOM_CENTS
        && Number(cLine.total_cents) === CUSTOM_CENTS,
      JSON.stringify(customQ.body),
    );
  }

  // ── Production createSunsetScheduleBooking: one exact row each ─────────
  {
    const createKayak = createCatalogTxnPg();
    const kayakCreate = await staffCreate(createKayak, 'kayak_rental', 1);
    const kRows = createKayak.state.serviceRecords;
    const kMeta = (kRows[0] && kRows[0].metadata) || {};
    ok(
      'create kayak_rental succeeds with one exact service row',
      kayakCreate.ok === true
        && kayakCreate.status === 201
        && kayakCreate.body.total_cents === KAYAK_CENTS
        && kRows.length === 1
        && kRows[0].service_type === 'addon_service'
        && kMeta.offering_key === 'kayak_rental'
        && kMeta.offering_label === 'Sea Kayak'
        && kMeta.duration_key === '1_day'
        && Number(kRows[0].quantity) === 1
        && Number(kMeta.unit_cents) === KAYAK_CENTS
        && Number(kRows[0].amount_due_cents) === KAYAK_CENTS
        && Number(createKayak.state.bookings.length) === 1,
      JSON.stringify({ body: kayakCreate.body, rows: kRows }),
    );
    ok(
      'create kayak booking header total matches service row',
      kayakCreate.body.total_cents === KAYAK_CENTS
        && Number(kRows[0].amount_due_cents) === KAYAK_CENTS,
      JSON.stringify(kayakCreate.body),
    );

    const createCustom = createCatalogTxnPg();
    const customCreate = await staffCreate(createCustom, 'surfboard_plus_wetsuit_custom', 1);
    const cRows = createCustom.state.serviceRecords;
    const cMeta = (cRows[0] && cRows[0].metadata) || {};
    ok(
      'create surfboard_plus_wetsuit_custom one exact row (no hidden components)',
      customCreate.ok === true
        && customCreate.status === 201
        && customCreate.body.total_cents === CUSTOM_CENTS
        && cRows.length === 1
        && cRows[0].service_type === 'addon_service'
        && cMeta.offering_key === 'surfboard_plus_wetsuit_custom'
        && cMeta.offering_label === 'Surf+Suit Custom'
        && !cMeta.bundle_part
        && !cMeta.rental_pricing_role
        && Number(cRows[0].amount_due_cents) === CUSTOM_CENTS,
      JSON.stringify({ body: customCreate.body, rows: cRows }),
    );
  }

  // ── Fail closed: unknown / inactive / unpriced / out-of-stock ──────────
  {
    const unknownPg = createCatalogTxnPg();
    const unknownQ = await lunaQuote(unknownPg, 'ghost_rental', 1);
    ok(
      'unknown offering quote fails closed',
      unknownQ.ok === false,
      JSON.stringify(unknownQ.body),
    );
    const unknownCreate = await staffCreate(unknownPg, 'ghost_rental', 1);
    ok(
      'unknown offering create fails closed with zero writes',
      unknownCreate.ok === false
        && unknownPg.state.bookingInserts === 0
        && unknownPg.state.serviceInserts === 0,
      JSON.stringify({ body: unknownCreate.body, state: unknownPg.state }),
    );

    const inactivePg = createCatalogTxnPg({
      offerings: CATALOG_OFFERINGS.map((o) => (
        o.offering_key === 'kayak_rental' ? { ...o, active: false } : o
      )),
    });
    const inactiveQ = await lunaQuote(inactivePg, 'kayak_rental', 1);
    ok(
      'inactive offering quote fails closed',
      inactiveQ.ok === false,
      JSON.stringify(inactiveQ.body),
    );
    const inactiveCreate = await staffCreate(inactivePg, 'kayak_rental', 1);
    ok(
      'inactive offering create fails closed with zero writes',
      inactiveCreate.ok === false
        && inactivePg.state.bookingInserts === 0
        && inactivePg.state.serviceInserts === 0,
      JSON.stringify(inactiveCreate.body),
    );

    // Unpriced: kayak present in catalog but no price rule
    const unpricedPg = createCatalogTxnPg({
      prices: {
        surfboard_plus_wetsuit_custom__1_day: { amount_cents: CUSTOM_CENTS, unit: 'day' },
      },
    });
    const unpricedQ = await lunaQuote(unpricedPg, 'kayak_rental', 1);
    ok(
      'unpriced offering quote fails closed',
      unpricedQ.ok === false,
      JSON.stringify(unpricedQ.body),
    );
    const unpricedCreate = await staffCreate(unpricedPg, 'kayak_rental', 1);
    ok(
      'unpriced offering create fails closed with zero writes',
      unpricedCreate.ok === false
        && unpricedPg.state.bookingInserts === 0
        && unpricedPg.state.serviceInserts === 0,
      JSON.stringify(unpricedCreate.body),
    );

    const oosPg = createCatalogTxnPg({
      offerings: CATALOG_OFFERINGS.map((o) => (
        o.offering_key === 'kayak_rental' ? { ...o, stock_quantity: 0 } : o
      )),
    });
    // Quote may still succeed (read path); create must fail closed on stock
    const oosCreate = await staffCreate(oosPg, 'kayak_rental', 1);
    ok(
      'out-of-stock create fails closed with zero partial writes',
      oosCreate.ok === false
        && (oosCreate.body.error === stock.ERROR_STOCK_UNAVAILABLE
          || oosCreate.body.reason_code === stock.ERROR_STOCK_UNAVAILABLE
          || /stock/i.test(String(oosCreate.body.error || oosCreate.body.reason_code || '')))
        && oosPg.state.bookingInserts === 0
        && oosPg.state.serviceInserts === 0,
      JSON.stringify(oosCreate.body),
    );
  }

  // No env flag residual in write path
  {
    const writesSrc = fs.readFileSync(
      path.join(__dirname, 'lib/sunset-schedule-booking-writes.js'), 'utf8',
    );
    ok(
      'prepareGenericRentalsForCreate has no GENERIC_RENTAL_CREATE_ENABLED gate',
      !/isGenericRentalCreateEnabled\s*\(/.test(writesSrc)
        && !/GENERIC_RENTAL_CREATE_ENABLED/.test(writesSrc),
    );
    const browserSrc = fs.readFileSync(
      path.join(__dirname, 'browser/sunset-schedule-rental-availability.js'), 'utf8',
    );
    ok(
      'Schedule UI does not cite env flag as submit authority',
      !/GENERIC_RENTAL_CREATE_ENABLED/.test(browserSrc),
    );
    const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
    ok(
      'Luna offering-quote route uses withPgClient + vertical quoteOffering',
      /handleBotSunsetOfferingQuote[\s\S]{0,800}handleSunsetOfferingQuoteRoute/.test(apiSrc)
        && /handleSunsetOfferingQuoteRoute[\s\S]{0,600}withPgClient[\s\S]{0,200}quoteOffering/.test(apiSrc),
    );
    ok(
      'Luna booking-create route uses withPgClient + createBooking',
      /async function handleBotSunsetBookingCreate[\s\S]{0,2000}withPgClient[\s\S]{0,300}createBooking/.test(apiSrc),
    );
  }

  section('3) Course-equipment in same transactional stock gate');

  const rentalOnly = stockService.collectRentalStockClaims(
    [{ offering_key: 'board_rental', quantity: 1 }],
    '2026-09-15',
    '2026-09-15',
  );
  const ceOnly = stockService.collectCourseEquipmentStockClaims(
    [{ offering_key: 'board_rental', quantity: 2, mode: 'during_course' }],
    '2026-09-15',
    '2026-09-15',
  );
  const merged = stockService.mergeExactOfferingStockClaims(rentalOnly.claims, ceOnly.claims);
  ok(
    'rental + course_equipment same key SUM (no silent dedupe without identity)',
    merged.ok && merged.claims.length === 1 && merged.claims[0].quantity === 3,
    JSON.stringify(merged),
  );

  const mergedDiff = stockService.mergeExactOfferingStockClaims(
    stockService.collectRentalStockClaims(
      [{ offering_key: 'board_rental', quantity: 1 }], '2026-09-15', '2026-09-15',
    ).claims,
    stockService.collectCourseEquipmentStockClaims(
      [{ offering_key: 'wetsuit_rental', quantity: 1, mode: 'during_course' }],
      '2026-09-15', '2026-09-15',
    ).claims,
  );
  ok(
    'distinct CE + rental keys remain two claims',
    mergedDiff.claims.length === 2,
    JSON.stringify(mergedDiff),
  );

  // Concurrent last-unit: two claims for stock=1 → only one can pass
  const lastUnitPg = createMockStockPg({
    offerings: [{
      id: '1', client_slug: 'sunset', location_id: 'sunset-somo',
      offering_key: 'board_rental', stock_quantity: 1, active: true,
    }],
    reservations: [],
  });
  const winner = await stockService.assertRentalStockClaimsInTxn(lastUnitPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    claims: stockService.mergeExactOfferingStockClaims(
      stockService.collectCourseEquipmentStockClaims(
        [{ offering_key: 'board_rental', quantity: 1 }], '2026-09-20', '2026-09-20',
      ).claims,
    ).claims,
    defaultLocationId: 'sunset-somo',
  });
  ok('course CE last unit winner ok', winner.ok === true, JSON.stringify(winner));

  const loserPg = createMockStockPg({
    offerings: [{
      id: '1', client_slug: 'sunset', location_id: 'sunset-somo',
      offering_key: 'board_rental', stock_quantity: 1, active: true,
    }],
    reservations: [{
      booking_id: 'winner-booking',
      offering_key: 'board_rental',
      service_date: '2026-09-20',
      quantity: 1,
      status: 'confirmed',
      booking_status: 'confirmed',
      rental_service_dates: ['2026-09-20'],
    }],
  });
  const loser = await stockService.assertRentalStockClaimsInTxn(loserPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    claims: stockService.mergeExactOfferingStockClaims(
      stockService.collectCourseEquipmentStockClaims(
        [{ offering_key: 'board_rental', quantity: 1 }], '2026-09-20', '2026-09-20',
      ).claims,
    ).claims,
    defaultLocationId: 'sunset-somo',
  });
  ok(
    'course CE last unit loser fails closed (no partial)',
    loser.ok === false && loser.error === stock.ERROR_STOCK_UNAVAILABLE,
    JSON.stringify(loser),
  );

  // Edit-style: exclude current booking so quantity/date change can reclaim
  const editOk = await stockService.assertRentalStockClaimsInTxn(loserPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    claims: [{
      offering_key: 'board_rental', quantity: 1,
      date_from: '2026-09-20', date_to: '2026-09-20', dates: ['2026-09-20'],
    }],
    excludeBookingId: 'winner-booking',
    defaultLocationId: 'sunset-somo',
  });
  ok('edit excludeBookingId allows reclaim', editOk.ok === true, JSON.stringify(editOk));

  // Create path wires CE into stock assert (source + behavioral merge above)
  const createSrc = fs.readFileSync(
    path.join(__dirname, 'lib/sunset-schedule-booking-writes.js'), 'utf8',
  );
  ok(
    'Create merges course_equipment claims before assertRentalStockClaimsInTxn',
    createSrc.includes('collectCourseEquipmentStockClaims')
      && createSrc.includes('mergeExactOfferingStockClaims')
      && /mergeExactOfferingStockClaims[\s\S]{0,200}assertRentalStockClaimsInTxn\s*\(/.test(createSrc),
  );
  const drawerSrc = fs.readFileSync(
    path.join(__dirname, 'lib/sunset-schedule-booking-drawer.js'), 'utf8',
  );
  ok(
    'Edit merges course_equipment claims with excludeBookingId',
    drawerSrc.includes('collectCourseEquipmentStockClaims')
      && drawerSrc.includes('excludeBookingId: bookingId'),
  );

  section('4) Restore SUM independent rows; historical dedupe; per-day claims');

  // same key/date qty2+qty3 => restore requires 5
  const sumServices = [
    {
      service_type: 'addon_service', service_date: '2026-09-01', quantity: 2,
      metadata: {
        offering_key: 'board_rental', rental_offering: true,
        rental_service_dates: ['2026-09-01'],
      },
    },
    {
      service_type: 'addon_service', service_date: '2026-09-01', quantity: 3,
      metadata: {
        offering_key: 'board_rental', rental_offering: true,
        rental_service_dates: ['2026-09-01'],
      },
    },
  ];
  const sumClaims = stockService.collectRentalStockClaimsFromServices(sumServices);
  ok(
    'restore qty2+qty3 same day requires 5',
    sumClaims.ok && sumClaims.claims.length === 1
      && sumClaims.claims[0].quantity === 5
      && sumClaims.claims[0].date_from === '2026-09-01',
    JSON.stringify(sumClaims),
  );

  // same key on two dates qty2 each requires 2 per day not 4
  const multiDay = stockService.collectRentalStockClaimsFromServices([
    {
      service_type: 'addon_service', service_date: '2026-09-01', quantity: 2,
      metadata: {
        offering_key: 'board_rental', rental_offering: true,
        rental_service_dates: ['2026-09-01'],
      },
    },
    {
      service_type: 'addon_service', service_date: '2026-09-02', quantity: 2,
      metadata: {
        offering_key: 'board_rental', rental_offering: true,
        rental_service_dates: ['2026-09-02'],
      },
    },
  ]);
  ok(
    'restore multi-day emits per-day claims qty 2 each (not 4)',
    multiDay.ok
      && multiDay.claims.length === 2
      && multiDay.claims.every((c) => c.quantity === 2)
      && multiDay.claims[0].date_from === '2026-09-01'
      && multiDay.claims[1].date_from === '2026-09-02',
    JSON.stringify(multiDay),
  );

  // historical grouped surfboard+wetsuit pair qty2 requires 2 once
  const histPair = stockService.collectRentalStockClaimsFromServices([
    {
      service_type: 'surfboard', service_date: '2026-09-03', quantity: 2,
      metadata: {
        offering_key: 'board_and_suit_rental',
        pricing_group_id: 'grp-hist',
        bundle_part: 'surfboard',
        rental_pricing_role: 'surfboard',
        rental_service_dates: ['2026-09-03'],
      },
    },
    {
      service_type: 'wetsuit', service_date: '2026-09-03', quantity: 2,
      metadata: {
        offering_key: 'board_and_suit_rental',
        pricing_group_id: 'grp-hist',
        bundle_part: 'wetsuit',
        rental_pricing_role: 'wetsuit',
        rental_service_dates: ['2026-09-03'],
      },
    },
  ]);
  ok(
    'historical component pair dedupes to qty 2 once',
    histPair.ok && histPair.claims.length === 1 && histPair.claims[0].quantity === 2,
    JSON.stringify(histPair),
  );

  // mixed independent + historical
  const mixed = stockService.collectRentalStockClaimsFromServices([
    {
      service_type: 'addon_service', service_date: '2026-09-04', quantity: 1,
      metadata: {
        offering_key: 'board_rental', rental_offering: true,
        rental_service_dates: ['2026-09-04'],
      },
    },
    {
      service_type: 'surfboard', service_date: '2026-09-04', quantity: 2,
      metadata: {
        offering_key: 'board_and_suit_rental',
        pricing_group_id: 'grp-m',
        bundle_part: 'surfboard',
        rental_service_dates: ['2026-09-04'],
      },
    },
    {
      service_type: 'wetsuit', service_date: '2026-09-04', quantity: 2,
      metadata: {
        offering_key: 'board_and_suit_rental',
        pricing_group_id: 'grp-m',
        bundle_part: 'wetsuit',
        rental_service_dates: ['2026-09-04'],
      },
    },
  ]);
  ok(
    'mixed independent + historical: board qty1 + combo qty2',
    mixed.ok
      && mixed.claims.length === 2
      && mixed.claims.find((c) => c.offering_key === 'board_rental').quantity === 1
      && mixed.claims.find((c) => c.offering_key === 'board_and_suit_rental').quantity === 2,
    JSON.stringify(mixed),
  );

  // Restore assert locks keys once and fails closed when unavailable
  const restoreFail = await stockService.assertRentalStockClaimsInTxn(
    createMockStockPg({
      offerings: [{
        id: '1', client_slug: 'sunset', location_id: 'sunset-somo',
        offering_key: 'board_rental', stock_quantity: 4, active: true,
      }],
      reservations: [{
        booking_id: 'other',
        offering_key: 'board_rental',
        service_date: '2026-09-01',
        quantity: 1,
        status: 'confirmed',
        booking_status: 'confirmed',
        rental_service_dates: ['2026-09-01'],
      }],
    }),
    {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      claims: sumClaims.claims, // needs 5, stock 4 with 1 reserved → unavailable
      excludeBookingId: 'restore-me',
      defaultLocationId: 'sunset-somo',
    },
  );
  ok(
    'restore needs 5 fails when remaining < 5',
    restoreFail.ok === false && restoreFail.error === stock.ERROR_STOCK_UNAVAILABLE,
    JSON.stringify(restoreFail),
  );

  const restoreOk = await stockService.assertRentalStockClaimsInTxn(
    createMockStockPg({
      offerings: [{
        id: '1', client_slug: 'sunset', location_id: 'sunset-somo',
        offering_key: 'board_rental', stock_quantity: 10, active: true,
      }],
      reservations: [],
    }),
    {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      claims: sumClaims.claims,
      excludeBookingId: 'restore-me',
      defaultLocationId: 'sunset-somo',
    },
  );
  ok('restore needs 5 succeeds with stock 10', restoreOk.ok === true, JSON.stringify(restoreOk));

  // Align with normalizeReservationDemand
  const demand = stock.normalizeReservationDemand([
    {
      booking_id: 'b', offering_key: 'board_rental', service_date: '2026-09-01',
      quantity: 2, status: 'confirmed',
    },
    {
      booking_id: 'b', offering_key: 'board_rental', service_date: '2026-09-01',
      quantity: 3, status: 'confirmed',
    },
  ]);
  ok('normalizeReservationDemand SUM 2+3=5', demand.length === 1 && demand[0].quantity === 5);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`verify-rental-stock-contract-corrections: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
