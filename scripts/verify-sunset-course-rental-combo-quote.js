'use strict';

/**
 * verify:sunset-course-rental-combo-quote
 *
 * P1 Bug Finder (2026-09-07): course + rental Create/quote showed generic
 * "Quote unavailable" instead of a usable total or a specific reason.
 *
 * Root causes covered:
 *  1) Create prepareCanonicalRentalsForCreate rejected short durations
 *     (2_hours / half_day) on a single-day span that quote already accepts —
 *     so course+rental could quote then fail on Create.
 *  2) Multi-day projection offered canonical 1_day when exact N_days was
 *     absent → quote/create rental_duration_mismatch → "Quote unavailable".
 *  3) Portal failure copy swallowed staff-safe server errors (schedule /
 *     duration mismatch) into the generic quoteFailed string.
 *
 * Offline — no live Staff API / no BF Deep bookings.
 *
 * Run: node scripts/verify-sunset-course-rental-combo-quote.js
 *   npm run verify:sunset-course-rental-combo-quote
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  prepareCanonicalRentalsForCreate,
  isCanonicalShortRentalDurationKey,
} = require('./lib/sunset-schedule-booking-writes');
const {
  buildSunsetQuoteCommand,
  QUOTE_CHANNELS,
  normalizeCanonicalRentalsForQuote,
} = require('./lib/luna-front-desk-quote-service');
const {
  executeSunsetStaffScheduleBookingQuote,
} = require('./lib/sunset-staff-schedule-booking-quote');
const {
  resolveBusinessVertical,
  VERTICAL_CHANNELS,
} = require('./lib/luna-front-desk-business-vertical');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');

const ROOT = path.join(__dirname, '..');
const rentalMod = require('./browser/sunset-schedule-rental-availability');
const portalSrc = fs.readFileSync(
  path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'),
  'utf8',
);
const enSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const esSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

function sameWeekdayAtLeastDaysOut(sampleIso, days) {
  const target = new Date(`${sampleIso}T12:00:00Z`).getUTCDay();
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCDate(d.getUTCDate() + ((target - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

console.log('\nverify:sunset-course-rental-combo-quote\n');

console.log('[A] Create prepare parity with quote short windows');
ok('2_hours is a canonical short key', isCanonicalShortRentalDurationKey('2_hours'));
ok('1_day is not a short key', !isCanonicalShortRentalDurationKey('1_day'));

const prep2h = prepareCanonicalRentalsForCreate({
  guest_name: 'Combo',
  date_from: '2026-10-10',
  date_to: '2026-10-10',
  payment_status: 'unpaid',
  components: {
    course: { course_id: 'c1', tier_key: '1_day', quantity: 1 },
    surfboard: { quantity: 1 },
  },
  rentals: [{ offering_key: 'board_rental', duration_key: '2_hours', quantity: 1 }],
  surfer_count: 1,
});
ok('create accepts course + board 2_hours on single-day span', prep2h.ok === true,
  prep2h.reason || prep2h.error);

const prepHalf = prepareCanonicalRentalsForCreate({
  guest_name: 'Combo',
  date_from: '2026-10-10',
  date_to: '2026-10-10',
  payment_status: 'unpaid',
  components: {
    course: { course_id: 'c1', tier_key: '1_day', quantity: 1 },
    surfboard: { quantity: 1 },
  },
  rentals: [{ offering_key: 'board_rental', duration_key: 'half_day', quantity: 1 }],
  surfer_count: 1,
});
ok('create accepts course + board half_day on single-day span', prepHalf.ok === true,
  prepHalf.reason || prepHalf.error);

const prepMismatch = prepareCanonicalRentalsForCreate({
  guest_name: 'Combo',
  date_from: '2026-10-10',
  date_to: '2026-10-12',
  payment_status: 'unpaid',
  components: {
    course: { course_id: 'c1', tier_key: '3_days', quantity: 1 },
    surfboard: { quantity: 1 },
  },
  rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
  surfer_count: 1,
});
ok('create still rejects multi-day + 1_day canonical (no silent undercharge)',
  prepMismatch.ok === false && prepMismatch.reason === 'rental_duration_mismatch',
  JSON.stringify(prepMismatch));

const quoteNorm = normalizeCanonicalRentalsForQuote({
  rentals: [{ offering_key: 'board_rental', duration_key: '2_hours', quantity: 1 }],
}, '1_day');
ok('quote normalize still accepts 2_hours on 1_day span',
  quoteNorm.ok && quoteNorm.present && quoteNorm.value[0].duration_key === '2_hours');

console.log('\n[B] Multi-day projection — canonical omit vs generic 1_day fallback');
const prices = [
  { category: 'rental', offering_key: 'board_rental__1_day', amount: 20, active: true, location_id: 'sunset-somo' },
  { category: 'rental', offering_key: 'board_rental__2_hours', amount: 15, active: true, location_id: 'sunset-somo' },
  { category: 'rental', offering_key: 'towel_rental__1_day', amount: 5, active: true, location_id: 'sunset-somo' },
  { category: 'rental', offering_key: 'board_rental__3_days', amount: 50, active: true, location_id: 'sunset-somo' },
];
const threeWithExact = rentalMod.scheduleProjectStandaloneRentals({
  prices,
  locationId: 'sunset-somo',
  dateDurationKey: '3_days',
});
ok('exact 3_days canonical still selectable',
  threeWithExact.some((o) => o.offering_key === 'board_rental'
    && o.durations.some((d) => d.duration_key === '3_days')),
  JSON.stringify(threeWithExact));

const pricesNoExact = prices.filter((p) => !String(p.offering_key).includes('__3_days'));
const threeNoExact = rentalMod.scheduleProjectStandaloneRentals({
  prices: pricesNoExact,
  locationId: 'sunset-somo',
  dateDurationKey: '3_days',
});
ok('canonical board omitted when exact 3_days absent (no 1_day trap)',
  !threeNoExact.some((o) => o.offering_key === 'board_rental'),
  JSON.stringify(threeNoExact));
ok('generic towel still offers 1_day fallback on multi-day',
  threeNoExact.some((o) => o.offering_key === 'towel_rental'
    && o.durations.some((d) => d.duration_key === '1_day')),
  JSON.stringify(threeNoExact));

console.log('\n[C] Portal surfaces specific quote failures (not generic unavailable)');
ok('i18n EN rentalDurationMismatch', /schedule\.create\.rentalDurationMismatch/.test(enSrc));
ok('i18n EN courseNotOnSelectedDates', /schedule\.create\.courseNotOnSelectedDates/.test(enSrc));
ok('i18n ES rentalDurationMismatch', /schedule\.create\.rentalDurationMismatch/.test(esSrc));
ok('i18n ES courseNotOnSelectedDates', /schedule\.create\.courseNotOnSelectedDates/.test(esSrc));
ok('portal maps rental_duration_mismatch',
  /rental_duration_mismatch/.test(portalSrc)
  && /schedule\.create\.rentalDurationMismatch/.test(portalSrc));
ok('portal maps service_dates_not_on_course_schedule',
  /service_dates_not_on_course_schedule/.test(portalSrc)
  && /schedule\.create\.courseNotOnSelectedDates/.test(portalSrc));
ok('portal prefers staff prose body.error',
  /humanIsProse/.test(portalSrc) && /humanError/.test(portalSrc));

const strings = {
  'schedule.create.rentalDurationMismatch': 'Rental duration must match the selected dates.',
  'schedule.create.courseNotOnSelectedDates': 'This course is not available on the selected dates.',
  'schedule.create.quoteFailed': 'Quote unavailable',
  'schedule.create.priceNotConfigured': 'Price not configured',
};
const sandbox = {
  console,
  portalT: (k) => (strings[k] != null ? strings[k] : k),
  portalLang: 'en',
  scheduleAccommodationUncoveredWarningMessage: null,
};
vm.createContext(sandbox);
vm.runInContext(
  `${portalSrc}\nthis.msg = schedulePortalQuoteFailureMessage;\n`,
  sandbox,
);
ok('duration mismatch → specific copy (not Quote unavailable)',
  sandbox.msg({
    ok: false,
    body: {
      reason_code: 'rental_duration_mismatch',
      error: 'rentals[0].duration_key must be 3_days for the selected dates',
    },
  }) === 'rentals[0].duration_key must be 3_days for the selected dates');
ok('course schedule miss → staff prose',
  sandbox.msg({
    ok: false,
    body: {
      reason_code: 'service_dates_not_on_course_schedule',
      error: 'This course runs on weekdays (Monday–Friday).',
    },
  }) === 'This course runs on weekdays (Monday–Friday).');
ok('unknown snake reason without prose still falls back to quoteFailed',
  sandbox.msg({ ok: false, body: { reason_code: 'totally_unknown_reason_zz' } })
    === 'Quote unavailable');

console.log('\n[D] Staff helper: course + board 2_hours quotes a total');
(async () => {
  const FIXTURE = path.join(ROOT, 'fixtures/sunset-admin-offline/curso-tarde-sw-collision-p0b.json');
  const fxRaw = fs.readFileSync(FIXTURE, 'utf8');
  const FIXTURE_SERVICE_DATE = JSON.parse(fxRaw).staff_drawer_selection.service_date;
  const fx = JSON.parse(
    fxRaw.split(FIXTURE_SERVICE_DATE).join(sameWeekdayAtLeastDaysOut(FIXTURE_SERVICE_DATE, 30)),
  );
  const LOC = fx._meta.location_id;
  const PACK_ID = fx.surf_pack.pack_id;
  const SERVICE_DATE = fx.staff_drawer_selection.service_date;
  const PACK_ITEM = packPriceItemCode(PACK_ID, '1_day');
  const E = fx.expected;
  const OFFERINGS = fx.rental_offerings.map((o) => ({ ...o, client_slug: 'sunset' }));
  OFFERINGS.push({
    offering_key: 'board_rental', label: 'Board', active: true,
    stock_quantity: 20, location_id: LOC, client_slug: 'sunset',
  });
  const PRICE_ROWS = [
    {
      id: 'pr-course', amount_cents: E.course_cents, currency: 'EUR', item_type: 'package',
      item_code: PACK_ITEM, unit: 'day', location_id: LOC, active: true, pricing_status: 'confirmed',
    },
    ...fx.rental_prices.map((p, i) => ({
      id: `pr-r-${i}`, amount_cents: p.amount_cents, currency: 'EUR', item_type: 'rental',
      item_code: p.item_code, unit: p.unit, location_id: LOC, active: true,
      pricing_status: p.pricing_status || 'confirmed', offering_key: p.offering_key,
    })),
    {
      id: 'pr-board-1', amount_cents: 2000, currency: 'EUR', item_type: 'rental',
      item_code: 'board_rental__1_day', unit: '1_day', location_id: LOC, active: true,
      pricing_status: 'confirmed', offering_key: 'board_rental',
    },
    {
      id: 'pr-board-2h', amount_cents: 1500, currency: 'EUR', item_type: 'rental',
      item_code: 'board_rental__2_hours', unit: '2_hours', location_id: LOC, active: true,
      pricing_status: 'confirmed', offering_key: 'board_rental',
    },
  ];
  const EQ_SW = fx.surf_pack.equipment_options[0];

  function adminCfg() {
    return {
      ok: true,
      source: 'db',
      currency: 'EUR',
      rental_offerings: OFFERINGS,
      surf_packs: [{
        pack_id: PACK_ID,
        label: fx.surf_pack.label,
        active: true,
        group_size: fx.surf_pack.group_size,
        weekly: fx.surf_pack.weekly,
        schedules: fx.surf_pack.schedules,
        equipment_options: [EQ_SW],
        price_tiers: fx.surf_pack.price_tiers,
      }],
      prices: PRICE_ROWS.map((p) => ({
        id: p.id,
        category: p.item_type,
        offering_key: p.offering_key || p.item_code,
        item_code: p.item_code,
        amount_cents: p.amount_cents,
        unit: p.unit,
        active: true,
        currency: 'EUR',
        location_id: LOC,
        pricing_status: 'confirmed',
      })),
      private_lesson: {
        id: 'private', enabled: true, label: 'Private', amount_cents: 6000,
        currency: 'EUR', price_basis: 'per_session', default_duration_minutes: 120,
        equipment_options: [EQ_SW],
      },
    };
  }

  const p0c = fs.readFileSync(path.join(ROOT, 'scripts/verify-sunset-combo-pricing-p0c.js'), 'utf8');
  const makePgSrc = p0c.slice(p0c.indexOf('function makePg('), p0c.indexOf('function makeLoadRule('));
  const makeLoadRuleSrc = p0c.slice(
    p0c.indexOf('function makeLoadRule('),
    p0c.indexOf('function equipmentOnlyPayload('),
  );
  const pgSandbox = {
    PRICE_ROWS,
    LOC,
    PACK_ID,
    fx,
    EQ_SW,
    OFFERINGS,
    console,
    require,
    module: { exports: {} },
    exports: {},
    process,
    Buffer,
  };
  vm.createContext(pgSandbox);
  vm.runInContext(
    `${makePgSrc}\n${makeLoadRuleSrc}\nthis.makePg=makePg; this.makeLoadRule=makeLoadRule;`,
    pgSandbox,
  );

  const tbc = require('./lib/tenant-business-config');
  const tro = require('./lib/tenant-rental-offerings');
  const cfg = adminCfg();
  const origCfg = tbc.resolveTenantBusinessConfigAsync;
  const origList = tro.listRentalOfferings;
  const origLoad = tbc.loadTenantPriceRuleFromDb;
  tbc.resolveTenantBusinessConfigAsync = async () => cfg;
  tro.listRentalOfferings = async () => OFFERINGS;
  tbc.loadTenantPriceRuleFromDb = async (_pg, params) => {
    const code = String(params.itemCode || '').includes('__')
      ? params.itemCode
      : `${params.itemCode}__${params.duration}`;
    const hit = (cfg.prices || []).find((p) => p.item_code === code && p.active !== false);
    if (!hit || !(Number(hit.amount_cents) > 0)) return { status: 'not_found', location_id: LOC };
    return {
      status: 'found',
      amount_cents: hit.amount_cents,
      currency: 'EUR',
      item_code: hit.item_code || code,
      unit: hit.unit,
      location_id: LOC,
      pricing_status: 'confirmed',
    };
  };
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  try {
    const resolved = resolveBusinessVertical({ clientSlug: 'sunset', locationId: LOC });
    const body = {
      guest_name: '',
      guest_phone: '',
      date_from: SERVICE_DATE,
      date_to: SERVICE_DATE,
      service_dates: [SERVICE_DATE],
      components: {
        course: {
          course_id: PACK_ID,
          tier_key: '1_day',
          quantity: 1,
          offering_id: PACK_ITEM,
        },
        surfboard: { quantity: 1 },
      },
      rentals: [{ offering_key: 'board_rental', duration_key: '2_hours', quantity: 1 }],
      course_equipment: [],
      surfer_count: 1,
      payment_status: 'unpaid',
      lessons: [],
    };
    const quoted = await executeSunsetStaffScheduleBookingQuote({
      clientSlug: 'sunset',
      locationId: LOC,
      body,
      pgClient: pgSandbox.makePg(),
      verticalResolved: resolved,
      channel: VERTICAL_CHANNELS.MANUAL_STAFF,
      listOfferings: async () => OFFERINGS,
      loadRule: pgSandbox.makeLoadRule(PRICE_ROWS),
    });
    ok('staff quote course+board 2_hours succeeds', quoted.ok === true,
      JSON.stringify(quoted.body && {
        reason: quoted.body.reason_code || quoted.body.reason,
        error: quoted.body.error,
      }));
    ok('staff quote total includes course + rental',
      quoted.ok
      && Number(quoted.body.total_cents) === E.course_cents + 1500,
      `total=${quoted.body && quoted.body.total_cents}`);
    ok('staff quote has board_rental line',
      quoted.ok
      && (quoted.body.line_items || []).some((l) => l.offering_key === 'board_rental'
        && l.duration_key === '2_hours'
        && l.total_cents === 1500));

    // Create-shape prepare must accept the same rental duration the quote used.
    const createPrep = prepareCanonicalRentalsForCreate({
      ...body,
      guest_name: 'Combo Guest',
      guest_phone: '+34600000001',
    });
    ok('create prepare accepts the quoted course+2_hours rental shape', createPrep.ok === true,
      createPrep.reason || createPrep.error);

    // Direct quote command path sanity (channel owner).
    const cmd = buildSunsetQuoteCommand({
      channel: QUOTE_CHANNELS.MANUAL_STAFF,
      transportBody: body,
      trustedLocationId: LOC,
      now: new Date(`${SERVICE_DATE}T12:00:00Z`),
    });
    ok('buildSunsetQuoteCommand ok for course+rental', cmd.ok === true);
  } finally {
    tbc.resolveTenantBusinessConfigAsync = origCfg;
    tro.listRentalOfferings = origList;
    if (origLoad) tbc.loadTenantPriceRuleFromDb = origLoad;
  }

  console.log(`\n── verify:sunset-course-rental-combo-quote ${fail ? 'FAILED' : 'PASSED'} (${pass}/${pass + fail}) ──\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
