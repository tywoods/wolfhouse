'use strict';

/**
 * Focused contract corrections for rental stock Slice B release blockers.
 *
 * Executes actual callers (normalize/collect/assert/quote/create paths), not
 * source-regex only. Covers:
 *   1) No future exclusion/conflict semantics; combo+board+wetsuit independent
 *   2) Luna catalog-driven arbitrary Admin offerings (quote pricing path)
 *   3) Course-equipment included in Create/Edit stock claims merge
 *   4) Restore sums independent rows; historical component pairs dedupe once;
 *      multi-day demand is per-day (not inflated across dates)
 *
 * Run: node scripts/verify-rental-stock-contract-corrections.js
 */

const assert = require('assert');
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

  // prepareGenericRentals no longer applies catalog excludes
  process.env.GENERIC_RENTAL_CREATE_ENABLED = 'true';
  const mockCatalog = [
    { offering_key: 'kayak_rental', active: true, excludes: ['board_rental'] },
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
    genPrep.ok !== false || genPrep.reason !== 'rental_catalog_conflict',
    JSON.stringify(genPrep),
  );

  section('2) Luna catalog-driven arbitrary offerings');

  // Valid shape accepted; unknown fails at price/catalog stage (not whitelist)
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

  // Async quote path with pg: custom item prices via resolveGenericRentalPrice
  const KAYAK_CENTS = 3500;
  const CUSTOM_CENTS = 4500;
  const quotePg = {
    async query(sql, params = []) {
      const s = String(sql || '');
      if (/tenant_rental_offerings/i.test(s)) {
        return {
          rows: [
            {
              id: '1', client_slug: 'sunset', location_id: 'sunset-somo',
              offering_key: 'kayak_rental', label: 'Kayak', group_key: 'sup',
              excludes: [], sort_order: 5, stock_quantity: 4, active: true,
            },
            {
              id: '2', client_slug: 'sunset', location_id: 'sunset-somo',
              offering_key: 'surfboard_plus_wetsuit_custom', label: 'Custom Combo',
              group_key: 'custom', excludes: [], sort_order: 6, stock_quantity: 3, active: true,
            },
            {
              id: '3', client_slug: 'sunset', location_id: 'sunset-somo',
              offering_key: 'board_rental', label: 'Surfboard', group_key: 'boards',
              excludes: [], sort_order: 0, stock_quantity: 10, active: true,
            },
          ],
          rowCount: 3,
        };
      }
      if (/tenant_price_rules/i.test(s) || /item_code/i.test(s) || /amount_cents/i.test(s)) {
        // Generic price resolver / stock reservation queries
        const joined = JSON.stringify(params);
        if (joined.includes('kayak_rental') || s.includes('kayak')) {
          return {
            rows: [{
              amount_cents: KAYAK_CENTS,
              currency: 'EUR',
              item_code: 'kayak_rental__1_day',
              unit: 'day',
              location_id: 'sunset-somo',
              pricing_status: 'confirmed',
              status: 'found',
              active: true,
            }],
            rowCount: 1,
          };
        }
        if (joined.includes('surfboard_plus_wetsuit_custom') || s.includes('surfboard_plus')) {
          return {
            rows: [{
              amount_cents: CUSTOM_CENTS,
              currency: 'EUR',
              item_code: 'surfboard_plus_wetsuit_custom__1_day',
              unit: 'day',
              location_id: 'sunset-somo',
              pricing_status: 'confirmed',
              status: 'found',
              active: true,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      if (/FOR UPDATE/i.test(s)) {
        return {
          rows: [
            {
              id: '1', client_slug: 'sunset', location_id: 'sunset-somo',
              offering_key: 'kayak_rental', stock_quantity: 4, active: true,
            },
            {
              id: '2', client_slug: 'sunset', location_id: 'sunset-somo',
              offering_key: 'surfboard_plus_wetsuit_custom', stock_quantity: 3, active: true,
            },
          ],
          rowCount: 2,
        };
      }
      if (/booking_service_records|service_date|rental_service/i.test(s)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  // Direct unit of quoteExact path via executeSunsetQuote needs full catalog.
  // Test the pricing helper path by collecting claims + assert for kayak stock,
  // and normalize + generic price resolution for money.
  const { resolveGenericRentalPrice } = require('./lib/tenant-rental-price-resolver');
  // Wire a thin loadRule that the mock quote path would use
  const pricedKayak = await resolveGenericRentalPrice({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKey: 'kayak_rental',
    durationKey: '1_day',
    quantity: 1,
    pgClient: quotePg,
    loadRule: async () => ({
      status: 'found',
      amount_cents: KAYAK_CENTS,
      currency: 'EUR',
      item_code: 'kayak_rental__1_day',
      unit: 'day',
      pricing_status: 'confirmed',
    }),
  });
  ok(
    'kayak_rental prices via generic resolver',
    pricedKayak.ok && pricedKayak.amount_cents === KAYAK_CENTS
      && pricedKayak.item_code === 'kayak_rental__1_day',
    JSON.stringify(pricedKayak),
  );

  const pricedCustom = await resolveGenericRentalPrice({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    offeringKey: 'surfboard_plus_wetsuit_custom',
    durationKey: '1_day',
    quantity: 1,
    pgClient: quotePg,
    loadRule: async () => ({
      status: 'found',
      amount_cents: CUSTOM_CENTS,
      currency: 'EUR',
      item_code: 'surfboard_plus_wetsuit_custom__1_day',
      unit: 'day',
      pricing_status: 'confirmed',
    }),
  });
  ok(
    'surfboard_plus_wetsuit_custom prices as ordinary item',
    pricedCustom.ok && pricedCustom.amount_cents === CUSTOM_CENTS,
    JSON.stringify(pricedCustom),
  );

  // Stock assert for kayak (runtime-shaped claims)
  const kayakStock = await stockService.assertRentalStockClaimsInTxn(
    createMockStockPg({
      offerings: [{
        id: '1', client_slug: 'sunset', location_id: 'sunset-somo',
        offering_key: 'kayak_rental', stock_quantity: 4, active: true,
      }],
      reservations: [],
    }),
    {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      rentals: [{ offering_key: 'kayak_rental', quantity: 1 }],
      dateFrom: '2026-09-10',
      dateTo: '2026-09-10',
      defaultLocationId: 'sunset-somo',
    },
  );
  ok('kayak stock claim passes when units remain', kayakStock.ok === true, JSON.stringify(kayakStock));

  // Inactive/unknown fail closed
  const inactiveStock = await stockService.assertRentalStockClaimsInTxn(
    createMockStockPg({ offerings: [], reservations: [] }),
    {
      clientSlug: 'sunset',
      locationId: 'sunset-somo',
      rentals: [{ offering_key: 'ghost_rental', quantity: 1 }],
      dateFrom: '2026-09-10',
      dateTo: '2026-09-10',
    },
  );
  ok(
    'unknown offering stock fail-closed',
    inactiveStock.ok === false,
    JSON.stringify(inactiveStock),
  );

  // Bot quote route supplies pg (source check of runtime wiring)
  const fs = require('fs');
  const path = require('path');
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
