'use strict';

/**
 * Focused contract corrections for rental stock Slice B release blockers.
 *
 * Executes actual callers (normalize/collect/assert/quote/create/edit paths), not
 * source-regex only. Covers:
 *   1) No future exclusion/conflict semantics; combo+board+wetsuit independent
 *   2) Luna catalog-driven arbitrary Admin offerings via production
 *      executeSunsetQuote + createSunsetScheduleBooking (not helpers alone)
 *   3) Course-equipment included in Create/Edit stock claims merge —
 *      including actual updateSunsetScheduleBooking CE-omission date moves
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
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');

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

  // ── Actual updateSunsetScheduleBooking CE-omission stock ownership ────────
  // Create never persists course_equipment on booking metadata. Edit must derive
  // preserved CE from locked service rows (not lockedMeta / not unlocked pre-read).
  section('3b) Edit omitted course_equipment — locked service CE owns stock');

  process.env.SUNSET_ADMIN_DB_READ_ENABLED = '1';
  const CE_BOOKING_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const CE_CLIENT_ID = '11111111-1111-4111-8111-111111111111';
  const CE_PACK_ID = '22222222-2222-4222-8222-222222222222';
  const CE_LOC = 'sunset-somo';
  const CE_KEY = 'softboard';
  // Must stay ≤ course surfer quantity so re-insert validation accepts preserved CE.
  const CE_QTY = 1;
  const COURSE_SURFERS = 1;
  const DATE_OLD = '2026-09-10';
  const DATE_NEW = '2026-09-20';
  const COURSE_CENTS = 4500;
  const CE_DURING = 500;
  const CE_ALLDAY = 1000;
  const CE_TIER = '1_day';
  const CE_GROUP_ITEM = packPriceItemCode(CE_PACK_ID, CE_TIER);
  const DRAWER_REQ = path.join(__dirname, 'lib/sunset-schedule-booking-drawer.js');
  const WRITES_REQ = path.join(__dirname, 'lib/sunset-schedule-booking-writes.js');
  const TBC_REQ = path.join(__dirname, 'lib/tenant-business-config.js');

  function ceParseMeta(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (_) { return {}; }
  }
  function ceDeepClone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function ceEquipmentOptions() {
    return [{
      offering_key: CE_KEY,
      during_course_price_cents: CE_DURING,
      all_day_price_cents: CE_ALLDAY,
    }];
  }

  function ceAdminCfg() {
    return {
      ok: true,
      source: 'db',
      currency: 'EUR',
      rental_offerings: [{
        id: 'ro-soft', client_slug: 'sunset', location_id: CE_LOC,
        offering_key: CE_KEY, label: 'Softboard', group_key: 'boards',
        excludes: [], sort_order: 1, stock_quantity: 10, active: true,
      }],
      surf_packs: [{
        pack_id: CE_PACK_ID,
        label: 'Stock Course',
        active: true,
        group_size: 8,
        weekly: 'daily',
        schedules: ['0930_1130'],
        equipment_options: ceEquipmentOptions(),
        price_tiers: [{
          key: CE_TIER, label: '1 day', hours: 2, amount_cents: COURSE_CENTS, duration_days: 1,
        }],
      }],
      prices: [{
        id: 'price-course',
        item_type: 'package',
        item_code: CE_GROUP_ITEM,
        amount_cents: COURSE_CENTS,
        unit: 'day',
        active: true,
        currency: 'EUR',
        location_id: CE_LOC,
      }],
      private_lesson: {
        enabled: true, label: 'Private', amount_cents: 8000,
        price_basis: 'per_session', default_duration_minutes: 120,
        equipment_options: [],
      },
    };
  }

  function seedCeBooking(opts = {}) {
    const date = opts.date || DATE_OLD;
    return {
      bookings: [{
        booking_id: CE_BOOKING_ID,
        booking_code: 'SUNSET-CE-OMIT-1',
        guest_name: 'CE Omit Guest',
        phone: '+34600999888',
        status: 'payment_pending',
        payment_status: 'waiting_payment',
        check_in: date,
        check_out: date,
        guest_count: COURSE_SURFERS,
        total_amount_cents: COURSE_CENTS + (CE_DURING * CE_QTY),
        amount_paid_cents: 0,
        balance_due_cents: COURSE_CENTS + (CE_DURING * CE_QTY),
        // Create never persists course_equipment on booking metadata.
        metadata: {
          source: 'staff_manual_schedule',
          staff_manual_schedule: true,
          location_id: CE_LOC,
          bundle_id: 'bundle-ce-omit',
          components: ['course'],
        },
      }],
      services: [
        {
          id: 'sr-course-1',
          service_record_id: 'sr-course-1',
          booking_id: CE_BOOKING_ID,
          service_type: 'surf_lesson',
          service_date: date,
          quantity: COURSE_SURFERS,
          amount_due_cents: COURSE_CENTS * COURSE_SURFERS,
          amount_paid_cents: 0,
          payment_status: 'pending',
          record_source: 'staff_manual',
          metadata: {
            source: 'staff_manual_schedule',
            staff_manual_schedule: true,
            component: 'course',
            staff_ui_service_type: 'course',
            course_id: CE_PACK_ID,
            course_label: 'Stock Course',
            tier_key: CE_TIER,
            offering_id: CE_GROUP_ITEM,
            location_id: CE_LOC,
          },
        },
        {
          id: 'sr-ce-soft',
          service_record_id: 'sr-ce-soft',
          booking_id: CE_BOOKING_ID,
          service_type: 'addon_service',
          service_date: date,
          quantity: CE_QTY,
          amount_due_cents: CE_DURING * CE_QTY,
          amount_paid_cents: 0,
          payment_status: 'pending',
          record_source: 'staff_manual',
          metadata: {
            source: 'staff_manual_schedule',
            staff_manual_schedule: true,
            course_equipment: true,
            offering_key: CE_KEY,
            label: 'Softboard',
            course_equipment_mode: 'during_course',
            component: 'course_equipment',
            staff_ui_service_type: 'course_equipment',
            during_course_price_cents: CE_DURING,
            all_day_price_cents: CE_ALLDAY,
            unit_amount_cents: CE_DURING,
            amount_cents: CE_DURING * CE_QTY,
            pricing_provenance: 'course_owned_equipment',
            price_source: 'course_owned_equipment',
            location_id: CE_LOC,
            course_id: CE_PACK_ID,
          },
        },
      ],
      payments: [],
      offerings: [{
        id: 'ro-soft',
        client_slug: 'sunset',
        location_id: CE_LOC,
        offering_key: CE_KEY,
        label: 'Softboard',
        group_key: 'boards',
        excludes: [],
        sort_order: 1,
        stock_quantity: opts.stockQuantity != null ? opts.stockQuantity : 10,
        active: true,
      }],
      reservations: Array.isArray(opts.reservations) ? opts.reservations.slice() : [],
    };
  }

  function dateOnlyBody(targetDate, extra = {}) {
    return {
      guest_name: 'CE Omit Guest',
      guest_phone: '+34600999888',
      date_from: targetDate,
      date_to: targetDate,
      service_dates: [targetDate],
      payment_status: 'unpaid',
      components: {
        course: {
          quantity: COURSE_SURFERS,
          course_id: CE_PACK_ID,
          course_label: 'Stock Course',
          tier_key: CE_TIER,
          offering_id: CE_GROUP_ITEM,
        },
      },
      surfer_count: COURSE_SURFERS,
      // course_equipment intentionally omitted unless extra supplies it
      ...extra,
    };
  }

  /**
   * Transaction-aware pg for real updateSunsetScheduleBooking + stock gate.
   * Tracks query order so FOR UPDATE / stock / mutation ordering is assertable.
   */
  function makeEditCePg(seed) {
    const state = {
      bookings: ceDeepClone(seed.bookings || []),
      services: ceDeepClone(seed.services || []),
      payments: ceDeepClone(seed.payments || []),
      offerings: ceDeepClone(seed.offerings || []),
      reservations: ceDeepClone(seed.reservations || []),
      clientId: CE_CLIENT_ID,
      begins: 0,
      commits: 0,
      rollbacks: 0,
      txSnap: null,
      queryLog: [],
      mutationsBeforeStockFail: 0,
      stockLockSeen: false,
      stockReservationSeen: false,
      headerUpdates: 0,
      serviceDeletes: 0,
      serviceInserts: 0,
    };
    function snap() {
      return {
        bookings: ceDeepClone(state.bookings),
        services: ceDeepClone(state.services),
        payments: ceDeepClone(state.payments),
      };
    }
    function restore(s) {
      state.bookings = s.bookings;
      state.services = s.services;
      state.payments = s.payments;
    }
    function logQuery(kind, sql) {
      state.queryLog.push({ kind, sql: String(sql).replace(/\s+/g, ' ').trim().slice(0, 160) });
    }
    function noteMutation() {
      if (!state.stockLockSeen || !state.stockReservationSeen) {
        // Mutations before both stock lock + reservation check completed.
        state.mutationsBeforeStockFail += 1;
      }
    }

    return {
      state,
      async query(sql, params = []) {
        const q = String(sql);

        if (/^\s*BEGIN\b/i.test(q)) {
          state.begins += 1;
          state.txSnap = snap();
          logQuery('BEGIN', q);
          return { rows: [], rowCount: 0 };
        }
        if (/^\s*COMMIT\b/i.test(q)) {
          state.commits += 1;
          state.txSnap = null;
          logQuery('COMMIT', q);
          return { rows: [], rowCount: 0 };
        }
        if (/^\s*ROLLBACK\b/i.test(q)) {
          state.rollbacks += 1;
          if (state.txSnap) restore(state.txSnap);
          state.txSnap = null;
          logQuery('ROLLBACK', q);
          return { rows: [], rowCount: 0 };
        }

        if (/pg_advisory/i.test(q)) return { rows: [], rowCount: 0 };
        if (/to_regclass/i.test(q)) {
          return { rows: [{ reg: 'tenant_price_rules', t: 'booking_service_records' }] };
        }
        if (/information_schema/i.test(q)) {
          return { rows: [{ column_name: 'location_id', '?column?': 1, table_name: 'tenant_price_rules' }] };
        }
        if (/pg_constraint/i.test(q)) {
          return {
            rows: [{
              definition: "CHECK ((service_type)::text = ANY ((ARRAY['addon_service'::character varying])::text[]))",
            }],
          };
        }
        if (/SELECT id FROM clients/i.test(q)) {
          return { rows: [{ id: state.clientId }] };
        }

        // Stock row lock — FOR UPDATE on tenant_rental_offerings
        if (/FOR UPDATE/i.test(q) && /tenant_rental_offerings/i.test(q)) {
          state.stockLockSeen = true;
          logQuery('STOCK_FOR_UPDATE', q);
          const keys = Array.isArray(params[2]) ? params[2]
            : (Array.isArray(params[1]) ? params[1] : []);
          const slug = params[0];
          const loc = Array.isArray(params[2]) ? params[1] : null;
          const rows = state.offerings.filter((o) => o.client_slug === slug
            && keys.includes(o.offering_key)
            && (loc == null || o.location_id === loc || o.location_id == null)
            && o.active !== false);
          return { rows, rowCount: rows.length };
        }

        // Active reservation demand for stock recheck
        if (/FROM booking_service_records sr/i.test(q)
          && /metadata->>'offering_key'/i.test(q)
          && /INNER JOIN bookings b/i.test(q)) {
          state.stockReservationSeen = true;
          logQuery('STOCK_RESERVATIONS', q);
          const offeringKey = params[1];
          const from = String(params[2] || '').slice(0, 10);
          const to = String(params[3] || '').slice(0, 10);
          let excludeId = null;
          // excludeBookingId is last param when present
          if (params.length >= 5) {
            const last = params[params.length - 1];
            if (typeof last === 'string' && /[0-9a-f-]{36}/i.test(last)) excludeId = last;
          }
          const rows = state.reservations.filter((r) => {
            if (String(r.offering_key) !== String(offeringKey)) return false;
            const d = String(r.service_date || '').slice(0, 10);
            if (d < from || d > to) return false;
            if (excludeId && String(r.booking_id) === String(excludeId)) return false;
            return true;
          });
          return { rows, rowCount: rows.length };
        }

        if (/FROM tenant_rental_offerings/i.test(q)) {
          const slug = params[0];
          const loc = params[1];
          const rows = state.offerings.filter((o) => {
            if (String(o.client_slug) !== String(slug)) return false;
            if (o.active === false && /active\s*=\s*true/i.test(q)) return false;
            if (loc != null && o.location_id != null && String(o.location_id) !== String(loc)) {
              return false;
            }
            return true;
          });
          return { rows, rowCount: rows.length };
        }

        if (/FROM tenant_surf_pack_rules/i.test(q)) {
          return {
            rows: [{
              id: CE_PACK_ID,
              label: 'Stock Course',
              active: true,
              config_json: {
                age_band: '12_and_up',
                group_size: 8,
                beaches: ['somo'],
                weekly: 'daily',
                schedules: ['0930_1130'],
                equipment_options: ceEquipmentOptions(),
                price_tiers: [{
                  key: CE_TIER, label: '1 day', hours: 2,
                  amount_cents: COURSE_CENTS, duration_days: 1,
                }],
              },
            }],
          };
        }

        if (/FROM tenant_private_lesson_rules/i.test(q)
          || (/private_lesson/i.test(q) && /config_json/i.test(q) && /SELECT/i.test(q))) {
          return { rows: [{ config_json: ceAdminCfg().private_lesson, active: true }] };
        }

        if (/FROM tenant_price_rules/i.test(q)) {
          const itemCode = params.find((p) => typeof p === 'string' && String(p).includes('__'))
            || params[2];
          if (String(itemCode) === CE_GROUP_ITEM) {
            return {
              rows: [{
                id: 'price-course',
                amount_cents: COURSE_CENTS,
                currency: 'EUR',
                item_type: 'package',
                item_code: CE_GROUP_ITEM,
                unit: 'day',
                location_id: CE_LOC,
                active: true,
              }],
            };
          }
          return { rows: [], rowCount: 0 };
        }

        if (/COALESCE\(SUM/i.test(q) && /booking_service_records/i.test(q)) {
          return { rows: [{ seats: 0, count: 0 }] };
        }

        if (/FROM bookings b/i.test(q) && /INNER JOIN clients/i.test(q)) {
          const b = state.bookings[0];
          if (!b) return { rows: [] };
          if (/FOR UPDATE/i.test(q)) logQuery('BOOKING_FOR_UPDATE', q);
          return {
            rows: [{
              booking_id: b.booking_id,
              client_id: state.clientId,
              booking_code: b.booking_code,
              guest_name: b.guest_name,
              phone: b.phone,
              status: b.status,
              payment_status: b.payment_status,
              check_in: b.check_in,
              check_out: b.check_out,
              guest_count: b.guest_count,
              amount_paid_cents: b.amount_paid_cents || 0,
              total_amount_cents: b.total_amount_cents || 0,
              balance_due_cents: b.balance_due_cents || 0,
              metadata: b.metadata,
            }],
          };
        }

        if (/FROM payments/i.test(q)) {
          if (/FOR UPDATE/i.test(q)) logQuery('PAYMENT_FOR_UPDATE', q);
          if (/SUM\(amount_paid_cents\)/i.test(q)) {
            return { rows: [{ paid_total: 0 }] };
          }
          return {
            rows: state.payments.map((p) => ({
              payment_id: p.payment_id || p.id,
              payment_status: p.status || p.payment_status,
              amount_due_cents: p.amount_due_cents || 0,
              amount_paid_cents: p.amount_paid_cents || 0,
            })),
          };
        }

        if (/SELECT COALESCE\(total_amount_cents/i.test(q) && /FROM bookings/i.test(q)) {
          const b = state.bookings[0];
          return { rows: b ? [{ total: Number(b.total_amount_cents) || 0 }] : [] };
        }

        // SELECT service rows (incl. FOR UPDATE) — must not treat "FOR UPDATE" as DML UPDATE.
        if (/FROM booking_service_records/i.test(q)
          && !/INSERT\s+INTO/i.test(q)
          && !/DELETE\s+FROM/i.test(q)
          && !/^\s*UPDATE\b/im.test(q)
          && !/COALESCE\(SUM/i.test(q)
          && !/INNER JOIN bookings b/i.test(q)
          && !/metadata->>'offering_key'/i.test(q)) {
          if (/FOR UPDATE/i.test(q)) logQuery('SERVICE_FOR_UPDATE', q);
          return {
            rows: state.services.map((s) => ({
              ...s,
              id: s.id || s.service_record_id,
              service_record_id: s.service_record_id || s.id,
              record_source: s.record_source || s.source || 'staff_manual',
            })),
          };
        }

        if (/DELETE FROM booking_service_records/i.test(q)) {
          noteMutation();
          state.serviceDeletes += 1;
          logQuery('DELETE_SERVICES', q);
          const sources = Array.isArray(params[2]) ? params[2] : [params[2]];
          state.services = state.services.filter((s) => {
            const src = s.record_source || s.source;
            return !sources.includes(src);
          });
          return { rowCount: 1 };
        }

        if (/INSERT INTO booking_service_records/i.test(q)) {
          noteMutation();
          state.serviceInserts += 1;
          logQuery('INSERT_SERVICE', q);
          let serviceType = params[4];
          let serviceDate = params[5];
          let quantity = params[6];
          let paymentStatus = params[7];
          let source = params[8];
          let metaRaw = params[9];
          let amountDue = 0;
          if (/'confirmed',\s*\$8,\s*0,\s*\$9/i.test(q)) {
            amountDue = Number(params[7]) || 0;
            paymentStatus = params[8];
            source = params[9];
            metaRaw = params[10];
          }
          const meta = ceParseMeta(metaRaw);
          const id = `00000000-0000-4000-8000-${String(state.serviceInserts).padStart(12, '0')}`;
          const row = {
            id,
            service_record_id: id,
            booking_id: params[1],
            booking_code: params[2],
            guest_name: params[3],
            service_type: serviceType,
            service_date: String(serviceDate || '').slice(0, 10),
            quantity,
            amount_due_cents: amountDue,
            amount_paid_cents: 0,
            payment_status: paymentStatus || 'pending',
            record_source: source,
            source,
            metadata: meta,
          };
          state.services.push(row);
          return {
            rows: [{
              ...row,
              staff_ui_service_type: meta.staff_ui_service_type || null,
              location_id: meta.location_id || CE_LOC,
            }],
            rowCount: 1,
          };
        }

        if (/UPDATE booking_service_records/i.test(q) && /amount_due_cents/i.test(q)) {
          noteMutation();
          const due = Number(params[0]);
          const id = String(params[params.length >= 3 && typeof params[1] === 'string'
            && String(params[1]).startsWith('{') ? 2 : 1]);
          const row = state.services.find((s) => String(s.service_record_id || s.id) === id);
          if (!row) return { rowCount: 0, rows: [] };
          row.amount_due_cents = due;
          if (params.length >= 3 && typeof params[1] === 'string' && String(params[1]).startsWith('{')) {
            row.metadata = { ...ceParseMeta(row.metadata), ...ceParseMeta(params[1]) };
          }
          return { rowCount: 1, rows: [] };
        }

        if (/UPDATE bookings/i.test(q) && /total_amount_cents/i.test(q)) {
          noteMutation();
          state.headerUpdates += 1;
          logQuery('UPDATE_TOTAL', q);
          const b = state.bookings[0];
          if (!b) return { rowCount: 0 };
          b.total_amount_cents = Number(params[0]);
          if (params.length >= 4 && Number.isFinite(Number(params[1]))) {
            b.amount_paid_cents = Number(params[1]) || 0;
            b.balance_due_cents = Number(params[2]) || 0;
            if (params[3] && typeof params[3] === 'string' && String(params[3]).startsWith('{')) {
              b.metadata = { ...ceParseMeta(b.metadata), ...ceParseMeta(params[3]) };
            }
          } else {
            b.balance_due_cents = Math.max(
              Number(params[0]) - Number(b.amount_paid_cents || 0), 0,
            );
            if (params[1] && typeof params[1] === 'string' && String(params[1]).startsWith('{')) {
              b.metadata = { ...ceParseMeta(b.metadata), ...ceParseMeta(params[1]) };
            }
          }
          return { rowCount: 1, rows: [] };
        }

        // Edit locked-paid balance: SET amount_paid_cents=$1, balance_due_cents=$2
        if (/UPDATE bookings/i.test(q) && /amount_paid_cents/i.test(q)
          && !/total_amount_cents/i.test(q) && !/guest_name/i.test(q)) {
          noteMutation();
          state.headerUpdates += 1;
          logQuery('UPDATE_BALANCE', q);
          const b = state.bookings[0];
          if (!b) return { rowCount: 0, rows: [] };
          b.amount_paid_cents = Number(params[0]) || 0;
          if (params.length >= 2 && Number.isFinite(Number(params[1]))) {
            b.balance_due_cents = Number(params[1]) || 0;
          } else {
            b.balance_due_cents = Math.max(
              Number(b.total_amount_cents || 0) - Number(b.amount_paid_cents || 0), 0,
            );
          }
          return { rowCount: 1, rows: [] };
        }

        if (/UPDATE bookings/i.test(q) && /guest_name/i.test(q)) {
          noteMutation();
          state.headerUpdates += 1;
          logQuery('UPDATE_HEADER', q);
          const b = state.bookings[0];
          if (!b) return { rowCount: 0 };
          b.guest_name = params[0];
          b.phone = params[1] || b.phone;
          b.status = params[2];
          b.payment_status = params[3];
          if (params.length >= 9) {
            b.check_in = params[4];
            b.guest_count = params[6];
            b.metadata = { ...ceParseMeta(b.metadata), ...ceParseMeta(params[7]) };
          } else {
            b.guest_count = params[4];
            b.metadata = { ...ceParseMeta(b.metadata), ...ceParseMeta(params[5]) };
          }
          return { rowCount: 1, rows: [] };
        }

        if (/SELECT metadata FROM bookings/i.test(q)) {
          return { rows: [{ metadata: state.bookings[0] && state.bookings[0].metadata }] };
        }

        if (/^\s*SELECT\b/i.test(q)) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
    };
  }

  function loadEditDrawer() {
    for (const req of [WRITES_REQ, DRAWER_REQ, TBC_REQ]) {
      try { delete require.cache[require.resolve(req)]; } catch (_) { /* ignore */ }
    }
    for (const key of Object.keys(require.cache)) {
      if (/luna-front-desk-quote-service|tenant-rental-offerings|sunset-admin-pack-rules|sunset-admin-course-join|tenant-services-writes|service-record-invoice|tenant-rental-stock/.test(key)) {
        delete require.cache[key];
      }
    }
    const tbc = require(TBC_REQ);
    tbc.resolveTenantBusinessConfigAsync = async () => ceAdminCfg();
    tbc.resolveTenantBusinessConfig = () => ceAdminCfg();
    try {
      require('./lib/tenant-services-writes').ensureBookingServiceGenericType = async () => {};
    } catch (_) { /* ignore */ }
    return require(DRAWER_REQ);
  }

  function ceRows(services) {
    return (services || []).filter((s) => ceParseMeta(s.metadata).course_equipment === true);
  }

  // (1) Omitted-CE date move to unavailable date → stock error, zero mutation
  {
    const drawer = loadEditDrawer();
    const seed = seedCeBooking({
      stockQuantity: 1,
      reservations: [{
        booking_id: 'other-booking-holds-last-unit',
        offering_key: CE_KEY,
        service_date: DATE_NEW,
        quantity: 1,
        status: 'confirmed',
        booking_status: 'confirmed',
      }],
    });
    const pg = makeEditCePg(seed);
    const pre = ceDeepClone({
      bookings: pg.state.bookings,
      services: pg.state.services,
      payments: pg.state.payments,
    });
    // Prove seed has CE service row and no booking metadata.course_equipment
    ok(
      'seed: CE service row present without booking metadata.course_equipment',
      ceRows(pre.services).length === 1
        && Number(ceRows(pre.services)[0].quantity) === CE_QTY
        && !Object.prototype.hasOwnProperty.call(pre.bookings[0].metadata, 'course_equipment'),
      JSON.stringify(pre.bookings[0].metadata),
    );

    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: CE_BOOKING_ID,
      locationId: CE_LOC,
      actor: { email: 'staff@sunset.test' },
      body: dateOnlyBody(DATE_NEW), // omits course_equipment
    });
    const err = String((result.body && (result.body.error || result.body.reason_code)) || '');
    ok(
      'omitted-CE date move to unavailable date returns stock error',
      result.ok === false
        && (err === stock.ERROR_STOCK_UNAVAILABLE
          || err === stock.ERROR_STOCK_NOT_CONFIGURED
          || /stock/i.test(err)),
      JSON.stringify(result.body || result),
    );
    ok(
      'omitted-CE stock failure rolls back with zero header/service/payment mutation',
      pg.state.commits === 0
        && pg.state.rollbacks >= 1
        && JSON.stringify({
          bookings: pg.state.bookings,
          services: pg.state.services,
          payments: pg.state.payments,
        }) === JSON.stringify(pre)
        && pg.state.headerUpdates === 0
        && pg.state.serviceDeletes === 0
        && pg.state.serviceInserts === 0,
      JSON.stringify({
        commits: pg.state.commits,
        rollbacks: pg.state.rollbacks,
        headerUpdates: pg.state.headerUpdates,
        deletes: pg.state.serviceDeletes,
        inserts: pg.state.serviceInserts,
        log: pg.state.queryLog,
      }),
    );
  }

  // (2) Same move with stock succeeds and preserves/recreates exact CE quantity
  {
    const drawer = loadEditDrawer();
    const seed = seedCeBooking({ stockQuantity: 10, reservations: [] });
    const pg = makeEditCePg(seed);
    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: CE_BOOKING_ID,
      locationId: CE_LOC,
      actor: { email: 'staff@sunset.test' },
      body: dateOnlyBody(DATE_NEW), // omits course_equipment
    });
    ok(
      'omitted-CE date move with stock succeeds',
      result.ok === true && result.status === 200 && pg.state.commits >= 1,
      JSON.stringify(result.body || result),
    );
    const equip = ceRows(pg.state.services);
    ok(
      'omitted-CE success preserves/recreates exact CE quantity on new date',
      equip.length >= 1
        && equip.every((r) => ceParseMeta(r.metadata).offering_key === CE_KEY)
        && equip.reduce((s, r) => s + (Number(r.quantity) || 0), 0) === CE_QTY
        && equip.every((r) => String(r.service_date).slice(0, 10) === DATE_NEW)
        && equip.every((r) => ceParseMeta(r.metadata).course_equipment_mode === 'during_course'),
      JSON.stringify(equip.map((r) => ({
        qty: r.quantity, date: r.service_date, meta: ceParseMeta(r.metadata),
      }))),
    );
    ok(
      'omitted-CE success does not invent booking metadata.course_equipment snapshot requirement',
      // header may or may not gain the key; service rows are the durable source of truth
      equip.length >= 1 && Number(equip[0].quantity) === CE_QTY,
    );
  }

  // (3) Explicit course_equipment:[] removes CE and makes no CE claim
  {
    const drawer = loadEditDrawer();
    // Force last-unit conflict on new date — if [] incorrectly still claimed CE, would fail stock.
    const seed = seedCeBooking({
      stockQuantity: 1,
      reservations: [{
        booking_id: 'other-holds-unit',
        offering_key: CE_KEY,
        service_date: DATE_NEW,
        quantity: 1,
        status: 'confirmed',
        booking_status: 'confirmed',
      }],
    });
    const pg = makeEditCePg(seed);
    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: CE_BOOKING_ID,
      locationId: CE_LOC,
      actor: { email: 'staff@sunset.test' },
      body: dateOnlyBody(DATE_NEW, { course_equipment: [] }),
    });
    ok(
      'explicit course_equipment:[] succeeds despite foreign CE demand (no CE claim)',
      result.ok === true && pg.state.commits >= 1,
      JSON.stringify(result.body || result),
    );
    ok(
      'explicit course_equipment:[] removes CE rows (no CE claim after edit)',
      ceRows(pg.state.services).length === 0,
      JSON.stringify(ceRows(pg.state.services)),
    );
  }

  // (4) Transaction mock: FOR UPDATE/check ordering; no mutation before failed stock
  {
    const drawer = loadEditDrawer();
    const seed = seedCeBooking({
      stockQuantity: 0, // configured sold-out → fail closed after lock
      reservations: [],
    });
    const pg = makeEditCePg(seed);
    const pre = ceDeepClone({
      bookings: pg.state.bookings,
      services: pg.state.services,
      payments: pg.state.payments,
    });
    const result = await drawer.updateSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: CE_BOOKING_ID,
      locationId: CE_LOC,
      actor: { email: 'staff@sunset.test' },
      body: dateOnlyBody(DATE_NEW),
    });
    const kinds = pg.state.queryLog.map((e) => e.kind);
    const beginIdx = kinds.indexOf('BEGIN');
    const svcLockIdx = kinds.indexOf('SERVICE_FOR_UPDATE');
    const stockLockIdx = kinds.indexOf('STOCK_FOR_UPDATE');
    const stockResIdx = kinds.indexOf('STOCK_RESERVATIONS');
    const rollbackIdx = kinds.indexOf('ROLLBACK');
    const firstMutationIdx = kinds.findIndex((k) =>
      k === 'UPDATE_HEADER' || k === 'DELETE_SERVICES' || k === 'INSERT_SERVICE' || k === 'UPDATE_TOTAL');
    ok(
      'omitted-CE concurrent-path ordering: BEGIN → SERVICE FOR UPDATE → STOCK FOR UPDATE before ROLLBACK',
      beginIdx >= 0
        && svcLockIdx > beginIdx
        && stockLockIdx > svcLockIdx
        && rollbackIdx > stockLockIdx
        && pg.state.commits === 0,
      JSON.stringify(kinds),
    );
    ok(
      'omitted-CE stock fail: no header/service mutation before stock lock/check',
      (firstMutationIdx < 0 || firstMutationIdx > stockLockIdx)
        && pg.state.mutationsBeforeStockFail === 0
        && JSON.stringify({
          bookings: pg.state.bookings,
          services: pg.state.services,
          payments: pg.state.payments,
        }) === JSON.stringify(pre),
      JSON.stringify({
        kinds, firstMutationIdx, stockLockIdx, stockResIdx,
        mutationsBeforeStockFail: pg.state.mutationsBeforeStockFail,
        body: result.body,
      }),
    );
    ok(
      'omitted-CE stock=0 fails closed (not silent skip)',
      result.ok === false
        && /stock/i.test(String((result.body && (result.body.error || result.body.reason_code)) || '')),
      JSON.stringify(result.body || result),
    );
  }

  // Create still merges CE claims (source owner remains collectCourseEquipmentStockClaims)
  {
    const createSrc = fs.readFileSync(
      path.join(__dirname, 'lib/sunset-schedule-booking-writes.js'), 'utf8',
    );
    ok(
      'Create merges course_equipment claims before assertRentalStockClaimsInTxn',
      createSrc.includes('collectCourseEquipmentStockClaims')
        && createSrc.includes('mergeExactOfferingStockClaims')
        && /mergeExactOfferingStockClaims[\s\S]{0,200}assertRentalStockClaimsInTxn\s*\(/.test(createSrc),
    );
  }

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
