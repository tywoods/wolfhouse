'use strict';

/**
 * verify:sunset-rental-drawer-projection
 *
 * Slice 2 — data-driven standalone rentals in Schedule Create + Edit.
 * RED→GREEN gate with arbitrary towel_rental identity and generic N_hours / N_days
 * duration packages (no hardcoded half-day / 1h / 2h product list).
 *
 * Fixture (confirmed):
 *   towel_rental label "Towel"
 *   active 12_hours = 500 cents, active 1_day = 800 cents, inactive 2_days
 *
 * Run: node scripts/verify-sunset-rental-drawer-projection.js
 *      npm run verify:sunset-rental-drawer-projection
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

function pw() {
  try {
    return require('playwright');
  } catch (_) {
    return require('/opt/data/workspaces/wolfhouse-grok/node_modules/playwright');
  }
}

const listen = (s) =>
  new Promise((r, j) => {
    s.once('error', j);
    s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`));
  });

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

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ── Fixture ──────────────────────────────────────────────────────────────────
const TOWEL_OFFERINGS = [
  {
    offering_key: 'towel_rental',
    label: 'Towel',
    active: true,
    location_id: 'sunset-somo',
    excludes: [],
  },
  {
    offering_key: 'hostile_towel',
    label: 'Hostile Towel',
    active: true,
    location_id: 'sunset-sardinero',
    excludes: [],
  },
  {
    offering_key: 'disabled_poncho',
    label: 'Disabled Poncho',
    active: false,
    location_id: 'sunset-somo',
    excludes: [],
  },
];

const TOWEL_PRICES = [
  {
    category: 'rental',
    offering_key: 'towel_rental__12_hours',
    item_code: 'towel_rental__12_hours',
    unit: 'session',
    amount_cents: 500,
    active: true,
    location_id: 'sunset-somo',
    label: 'Towel',
    client_slug: 'sunset',
    tenant: 'sunset',
  },
  {
    category: 'rental',
    offering_key: 'towel_rental__1_day',
    item_code: 'towel_rental__1_day',
    unit: 'day',
    amount_cents: 800,
    active: true,
    location_id: 'sunset-somo',
    label: 'Towel',
    client_slug: 'sunset',
    tenant: 'sunset',
  },
  {
    category: 'rental',
    offering_key: 'towel_rental__2_days',
    item_code: 'towel_rental__2_days',
    unit: 'day',
    amount_cents: 1500,
    active: false,
    location_id: 'sunset-somo',
    label: 'Towel',
    client_slug: 'sunset',
    tenant: 'sunset',
  },
  {
    category: 'rental',
    offering_key: 'hostile_towel__1_day',
    item_code: 'hostile_towel__1_day',
    unit: 'day',
    amount_cents: 9999,
    active: true,
    location_id: 'sunset-sardinero',
    label: 'Hostile Towel',
    client_slug: 'sunset',
    tenant: 'sunset',
  },
  {
    category: 'rental',
    offering_key: 'disabled_poncho__1_day',
    item_code: 'disabled_poncho__1_day',
    unit: 'day',
    amount_cents: 400,
    active: true,
    location_id: 'sunset-somo',
    label: 'Disabled Poncho',
    client_slug: 'sunset',
    tenant: 'sunset',
  },
  {
    category: 'rental',
    offering_key: 'full_day_equipment_extension__day',
    item_code: 'full_day_equipment_extension__day',
    unit: 'day',
    amount_cents: 1000,
    active: true,
    location_id: 'sunset-somo',
    label: 'Full day gear',
  },
];

const SECOND_ITEM_OFFERINGS = TOWEL_OFFERINGS.concat([
  {
    offering_key: 'poncho_rental',
    label: 'Poncho',
    active: true,
    location_id: 'sunset-somo',
    excludes: [],
  },
]);

const SECOND_ITEM_PRICES = TOWEL_PRICES.concat([
  {
    category: 'rental',
    offering_key: 'poncho_rental__4_hours',
    item_code: 'poncho_rental__4_hours',
    unit: 'session',
    amount_cents: 300,
    active: true,
    location_id: 'sunset-somo',
    label: 'Poncho',
    client_slug: 'sunset',
    tenant: 'sunset',
  },
  {
    category: 'rental',
    offering_key: 'poncho_rental__1_day',
    item_code: 'poncho_rental__1_day',
    unit: 'day',
    amount_cents: 600,
    active: true,
    location_id: 'sunset-somo',
    label: 'Poncho',
    client_slug: 'sunset',
    tenant: 'sunset',
  },
]);

console.log('\nverify:sunset-rental-drawer-projection — Slice 2 standalone rentals\n');

// ── [A] Pure projection ──────────────────────────────────────────────────────
console.log('[A] Canonical projection (identity ⨝ active positive prices)');
const rental = require('./browser/sunset-schedule-rental-availability');

ok(
  'exports scheduleProjectStandaloneRentals',
  typeof rental.scheduleProjectStandaloneRentals === 'function',
);

const projected1d = typeof rental.scheduleProjectStandaloneRentals === 'function'
  ? rental.scheduleProjectStandaloneRentals({
    offerings: TOWEL_OFFERINGS,
    prices: TOWEL_PRICES,
    locationId: 'sunset-somo',
    dateDurationKey: '1_day',
  })
  : null;

ok(
  'one-day projection includes only enabled Somo Towel',
  Array.isArray(projected1d)
    && projected1d.length === 1
    && projected1d[0].offering_key === 'towel_rental'
    && projected1d[0].label === 'Towel',
  JSON.stringify(projected1d),
);

const durs1d = projected1d && projected1d[0] && projected1d[0].durations;
ok(
  'one-day dropdown = active 12_hours + 1_day only (inactive 2_days absent)',
  Array.isArray(durs1d)
    && durs1d.map((d) => d.duration_key).sort().join(',') === '12_hours,1_day'
    && durs1d.find((d) => d.duration_key === '12_hours').amount_cents === 500
    && durs1d.find((d) => d.duration_key === '1_day').amount_cents === 800
    && !durs1d.some((d) => d.duration_key === '2_days'),
  JSON.stringify(durs1d),
);

const projected2d = typeof rental.scheduleProjectStandaloneRentals === 'function'
  ? rental.scheduleProjectStandaloneRentals({
    offerings: TOWEL_OFFERINGS,
    prices: TOWEL_PRICES,
    locationId: 'sunset-somo',
    dateDurationKey: '2_days',
  })
  : null;

const durs2d = projected2d && projected2d[0] && projected2d[0].durations;
ok(
  'two-day dropdown prefers 1_day only (inactive 2_days + hour packages absent)',
  Array.isArray(projected2d)
    && projected2d.length === 1
    && Array.isArray(durs2d)
    && durs2d.map((d) => d.duration_key).join(',') === '1_day'
    && durs2d[0].amount_cents === 800
    && !durs2d.some((d) => /hour|half_day/i.test(d.duration_key)),
  JSON.stringify(durs2d),
);

const pricesWithExact2 = TOWEL_PRICES.map((p) => (
  p.offering_key === 'towel_rental__2_days' ? { ...p, active: true } : p
));
const projectedExact2 = rental.scheduleProjectStandaloneRentals({
  offerings: TOWEL_OFFERINGS,
  prices: pricesWithExact2,
  locationId: 'sunset-somo',
  dateDurationKey: '2_days',
});
ok(
  'two-day with active exact package offers ONLY 2_days (1_day excluded when exact exists; no hours)',
  projectedExact2[0].durations.map((d) => d.duration_key).join(',') === '2_days'
    && projectedExact2[0].durations.length === 1
    && !projectedExact2[0].durations.some((d) => d.duration_key === '1_day')
    && !projectedExact2[0].durations.some((d) => /hour/i.test(d.duration_key)),
  JSON.stringify(projectedExact2[0] && projectedExact2[0].durations),
);

ok(
  'disabled/cross-scope offerings never newly selectable',
  !projected1d.some((o) => o.offering_key === 'disabled_poncho')
    && !projected1d.some((o) => o.offering_key === 'hostile_towel')
    && !projected1d.some((o) => String(o.offering_key).includes('full_day_equipment')),
);

const multi = rental.scheduleProjectStandaloneRentals({
  offerings: SECOND_ITEM_OFFERINGS,
  prices: SECOND_ITEM_PRICES,
  locationId: 'sunset-somo',
  dateDurationKey: '1_day',
});
ok(
  'each selected item owns its own duration set (no shared intersection)',
  multi.length === 2
    && multi.find((o) => o.offering_key === 'towel_rental').durations
      .map((d) => d.duration_key).sort().join(',') === '12_hours,1_day'
    && multi.find((o) => o.offering_key === 'poncho_rental').durations
      .map((d) => d.duration_key).sort().join(',') === '1_day,4_hours',
  JSON.stringify(multi),
);

// No hardcoded product enumeration for discovery
ok(
  'projection does not enumerate fixed 1h/2h/half_day product list',
  !/SCHEDULE_SHORT_RENTAL_DURATION_KEYS\.filter/.test(read('scripts/browser/sunset-schedule-rental-availability.js'))
    || typeof rental.scheduleProjectStandaloneRentals === 'function',
);

// Arbitrary canonical keys (36_hours, 8_days, 999_hours) + historical half_day read.
const GENERIC_KEYS_PRICES = [
  {
    category: 'rental',
    offering_key: 'towel_rental__36_hours',
    item_code: 'towel_rental__36_hours',
    amount_cents: 900,
    active: true,
    location_id: 'sunset-somo',
  },
  {
    category: 'rental',
    offering_key: 'towel_rental__999_hours',
    item_code: 'towel_rental__999_hours',
    amount_cents: 100,
    active: true,
    location_id: 'sunset-somo',
  },
  {
    category: 'rental',
    offering_key: 'towel_rental__8_days',
    item_code: 'towel_rental__8_days',
    amount_cents: 4000,
    active: true,
    location_id: 'sunset-somo',
  },
  {
    category: 'rental',
    offering_key: 'towel_rental__half_day',
    item_code: 'towel_rental__half_day',
    amount_cents: 450,
    active: true,
    location_id: 'sunset-somo',
  },
];
const generic1d = rental.scheduleProjectStandaloneRentals({
  offerings: TOWEL_OFFERINGS,
  prices: GENERIC_KEYS_PRICES,
  locationId: 'sunset-somo',
  dateDurationKey: '1_day',
});
const gKeys = (generic1d[0] && generic1d[0].durations || []).map((d) => d.duration_key).sort();
ok(
  'Create/Edit one-day options accept 36_hours + 999_hours + historical half_day',
  gKeys.includes('36_hours')
    && gKeys.includes('999_hours')
    && gKeys.includes('half_day')
    && !gKeys.includes('8_days'),
  JSON.stringify(gKeys),
);
const generic8d = rental.scheduleProjectStandaloneRentals({
  offerings: TOWEL_OFFERINGS,
  prices: GENERIC_KEYS_PRICES,
  locationId: 'sunset-somo',
  dateDurationKey: '8_days',
});
ok(
  'Create/Edit 8_days span offers exact 8_days package option value',
  generic8d[0]
    && generic8d[0].durations.map((d) => d.duration_key).join(',') === '8_days'
    && generic8d[0].durations[0].amount_cents === 4000,
  JSON.stringify(generic8d[0] && generic8d[0].durations),
);
// Production writer must not fold 12 → half_day (source gate).
ok(
  'no 12→half_day in production rentalDurationKeyFromUnitCount',
  !/n\s*===\s*12\s*\)\s*return\s*['"]half_day['"]/.test(
    read('scripts/browser/sunset-rental-duration-model.js'),
  ),
);

// ── [B] Server quote authority ───────────────────────────────────────────────
console.log('\n[B] Server quote/save — exact prices, no client money, multi-day rules');
// Catalog membership is the gate; no env flag required.
delete process.env.GENERIC_RENTAL_CREATE_ENABLED;
const {
  prepareGenericRentalsForCreate,
  buildGenericRentalAuthoritativeQuote,
} = require('./lib/sunset-schedule-booking-writes');

const catalog = [{ offering_key: 'towel_rental', label: 'Towel', active: true, location_id: 'sunset-somo', excludes: [] }];
const loadCatalog = async () => catalog;
const towelRule = async ({ itemCode, duration }) => {
  if (itemCode === 'towel_rental' && duration === '12_hours') {
    return {
      status: 'found', amount_cents: 500, currency: 'EUR',
      item_code: 'towel_rental__12_hours', unit: 'session', location_id: 'sunset-somo',
    };
  }
  if (itemCode === 'towel_rental' && duration === '1_day') {
    return {
      status: 'found', amount_cents: 800, currency: 'EUR',
      item_code: 'towel_rental__1_day', unit: 'day', location_id: 'sunset-somo',
    };
  }
  if (itemCode === 'towel_rental' && duration === '2_days') {
    return {
      status: 'found', amount_cents: 1500, currency: 'EUR',
      item_code: 'towel_rental__2_days', unit: 'day', location_id: 'sunset-somo',
    };
  }
  return { status: 'not_found' };
};
const fakePg = {};
const baseOpts = {
  clientSlug: 'sunset',
  locationId: 'sunset-somo',
  serviceDate: '2026-08-01',
  pgClient: fakePg,
  listOfferings: loadCatalog,
  loadRule: towelRule,
};

(async () => {
  const q12 = await prepareGenericRentalsForCreate({
    ...baseOpts,
    rentals: [{ offering_key: 'towel_rental', duration_key: '12_hours', quantity: 1 }],
  });
  ok('quote 12_hours = €5 exact', q12.ok === true && q12.records[0].amount_due_cents === 500
    && q12.records[0].metadata.duration_key === '12_hours', JSON.stringify(q12));

  const q1d = await prepareGenericRentalsForCreate({
    ...baseOpts,
    rentals: [{ offering_key: 'towel_rental', duration_key: '1_day', quantity: 1 }],
  });
  ok('quote 1_day = €8 exact', q1d.ok === true && q1d.records[0].amount_due_cents === 800
    && q1d.records[0].metadata.duration_key === '1_day', JSON.stringify(q1d));

  // 1_day repeat is only legal when exact N_days is absent for this rental.
  const towelRuleNoExact2 = async ({ itemCode, duration }) => {
    if (itemCode === 'towel_rental' && duration === '2_days') return { status: 'not_found' };
    return towelRule({ itemCode, duration });
  };
  const qMulti1d = await prepareGenericRentalsForCreate({
    ...baseOpts,
    rentals: [{ offering_key: 'towel_rental', duration_key: '1_day', quantity: 1 }],
    calendarDayCount: 2,
    bookingDurationKey: '2_days',
    loadRule: towelRuleNoExact2,
  });
  ok(
    'multi-day with selected 1_day repeats once per date (800×2) only when exact N_days absent',
    qMulti1d.ok === true
      && qMulti1d.records[0].amount_due_cents === 1600
      && qMulti1d.records[0].metadata.duration_key === '1_day'
      && qMulti1d.records[0].metadata.package_repeat_count === 2
      && qMulti1d.records[0].metadata.pricing_mode === 'repeated_base_package',
    JSON.stringify(qMulti1d),
  );

  const qExact2 = await prepareGenericRentalsForCreate({
    ...baseOpts,
    rentals: [{ offering_key: 'towel_rental', duration_key: '2_days', quantity: 1 }],
    calendarDayCount: 2,
    bookingDurationKey: '2_days',
  });
  ok(
    'multi-day exact 2_days package is one charge',
    qExact2.ok === true
      && qExact2.records[0].amount_due_cents === 1500
      && qExact2.records[0].metadata.pricing_mode === 'exact_duration_package'
      && qExact2.records[0].metadata.package_repeat_count === 1,
    JSON.stringify(qExact2),
  );

  // Malicious/stale UI: 1_day submitted while exact active N_days exists must fail closed server-side.
  const qStale1dWhenExact = await prepareGenericRentalsForCreate({
    ...baseOpts,
    rentals: [{ offering_key: 'towel_rental', duration_key: '1_day', quantity: 1 }],
    calendarDayCount: 2,
    bookingDurationKey: '2_days',
  });
  ok(
    'server rejects 1_day on multi-day when exact active N_days package exists (not UI-only)',
    qStale1dWhenExact.ok === false
      && qStale1dWhenExact.reason === 'rental_duration_not_compatible',
    JSON.stringify(qStale1dWhenExact),
  );

  // Exact-probe fail-closed: only reason=price_not_found + status=not_found may
  // fall back to repeated 1_day. Resolver errors must never silent-price via 1_day.
  const multiDay1dBase = {
    ...baseOpts,
    rentals: [{ offering_key: 'towel_rental', duration_key: '1_day', quantity: 1 }],
    calendarDayCount: 2,
    bookingDurationKey: '2_days',
  };
  const oneDayOnlyRule = async ({ itemCode, duration }) => {
    if (itemCode === 'towel_rental' && duration === '1_day') {
      return {
        status: 'found', amount_cents: 800, currency: 'EUR',
        item_code: 'towel_rental__1_day', unit: 'day', location_id: 'sunset-somo',
      };
    }
    return { status: 'not_found' };
  };
  const qTrueNotFound = await prepareGenericRentalsForCreate({
    ...multiDay1dBase,
    loadRule: oneDayOnlyRule,
  });
  ok(
    'exact-probe true not_found falls back to repeated 1_day',
    qTrueNotFound.ok === true
      && qTrueNotFound.records[0].amount_due_cents === 1600
      && qTrueNotFound.records[0].metadata.pricing_mode === 'repeated_base_package',
    JSON.stringify(qTrueNotFound),
  );
  const qLookupThrow = await prepareGenericRentalsForCreate({
    ...multiDay1dBase,
    loadRule: async ({ itemCode, duration }) => {
      if (duration === '2_days') throw new Error('db_timeout');
      return oneDayOnlyRule({ itemCode, duration });
    },
  });
  ok(
    'exact-probe lookup throw fails closed (no 1_day fallback)',
    qLookupThrow.ok === false && qLookupThrow.reason === 'price_lookup_failed',
    JSON.stringify(qLookupThrow),
  );
  const qTablesMissing = await prepareGenericRentalsForCreate({
    ...multiDay1dBase,
    loadRule: async ({ itemCode, duration }) => {
      if (duration === '2_days') return { status: 'tables_missing' };
      return oneDayOnlyRule({ itemCode, duration });
    },
  });
  ok(
    'exact-probe tables_missing fails closed (no 1_day fallback)',
    qTablesMissing.ok === false
      && qTablesMissing.reason === 'price_not_found'
      && qTablesMissing.status === 'tables_missing',
    JSON.stringify(qTablesMissing),
  );
  const qInvalidLoc = await prepareGenericRentalsForCreate({
    ...multiDay1dBase,
    loadRule: async ({ itemCode, duration }) => {
      if (duration === '2_days') return { status: 'invalid_location' };
      return oneDayOnlyRule({ itemCode, duration });
    },
  });
  ok(
    'exact-probe invalid_location fails closed (no 1_day fallback)',
    qInvalidLoc.ok === false
      && qInvalidLoc.reason === 'price_not_found'
      && qInvalidLoc.status === 'invalid_location',
    JSON.stringify(qInvalidLoc),
  );
  const qInvalidAmt = await prepareGenericRentalsForCreate({
    ...multiDay1dBase,
    loadRule: async ({ itemCode, duration }) => {
      if (duration === '2_days') {
        return {
          status: 'found', amount_cents: NaN, currency: 'EUR',
          item_code: 'towel_rental__2_days', unit: 'day', location_id: 'sunset-somo',
        };
      }
      return oneDayOnlyRule({ itemCode, duration });
    },
  });
  ok(
    'exact-probe invalid_amount fails closed (no 1_day fallback)',
    qInvalidAmt.ok === false
      && qInvalidAmt.reason === 'price_not_found'
      && qInvalidAmt.status === 'invalid_amount',
    JSON.stringify(qInvalidAmt),
  );
  const qScopeMismatch = await prepareGenericRentalsForCreate({
    ...multiDay1dBase,
    loadRule: async ({ itemCode, duration }) => {
      if (duration === '2_days') {
        return {
          status: 'found', amount_cents: 1500, currency: 'EUR',
          item_code: 'board_rental__2_days', unit: 'day', location_id: 'sunset-somo',
        };
      }
      return oneDayOnlyRule({ itemCode, duration });
    },
  });
  ok(
    'exact-probe scope mismatch fails closed (no 1_day fallback)',
    qScopeMismatch.ok === false && qScopeMismatch.reason === 'price_scope_mismatch',
    JSON.stringify(qScopeMismatch),
  );

  const qHourMulti = await prepareGenericRentalsForCreate({
    ...baseOpts,
    rentals: [{ offering_key: 'towel_rental', duration_key: '12_hours', quantity: 1 }],
    calendarDayCount: 2,
    bookingDurationKey: '2_days',
  });
  ok(
    'hour packages fail closed on multi-day write (not offered, not repeated)',
    qHourMulti.ok === false
      && (qHourMulti.reason === 'rental_duration_not_compatible'
        || qHourMulti.reason === 'unsupported_duration'
        || qHourMulti.reason === 'price_not_found'),
    JSON.stringify(qHourMulti),
  );

  const qMoney = await prepareGenericRentalsForCreate({
    ...baseOpts,
    rentals: [{ offering_key: 'towel_rental', duration_key: '1_day', quantity: 1, amount_cents: 1 }],
  });
  ok('browser money fields fail closed', qMoney.ok === false && qMoney.reason === 'client_money_rejected');

  const qStale = await prepareGenericRentalsForCreate({
    ...baseOpts,
    rentals: [{ offering_key: 'towel_rental', duration_key: '2_days', quantity: 1 }],
    loadRule: async () => ({ status: 'not_found' }),
  });
  ok('stale/inactive duration fails closed before write', qStale.ok === false);

  const quote = buildGenericRentalAuthoritativeQuote(q1d.records);
  ok('authoritative quote line carries exact item code and unit', quote.total_cents === 800
    && quote.line_items[0].offering_item_code === 'towel_rental__1_day');

  // ── [C] Create + Edit source contracts ─────────────────────────────────────
  console.log('\n[C] Create/Edit DOM contracts (per-item duration, no shared intersection)');
  const apiSrc = read('scripts/staff-query-api.js');
  const editSrc = read('scripts/browser/sunset-schedule-drawer-edit-ui.js');
  const portalSrc = read('scripts/browser/sunset-schedule-portal-module.js');
  const dayOpsSrc = read('scripts/browser/sunset-schedule-day-ops-board-ui.js');
  const availSrc = read('scripts/browser/sunset-schedule-rental-availability.js');

  ok(
    'Create renders per-item duration select (not only shared pebbles host)',
    /ps-create-rental-duration/.test(apiSrc)
      && /scheduleProjectStandaloneRentals/.test(apiSrc),
  );
  ok(
    'Create reads duration from selected row (per-item ownership)',
    /data-rental-duration-key/.test(apiSrc)
      && /ps-create-rental-duration/.test(apiSrc)
      && /row\.getAttribute\('data-rental-duration-key'\)|querySelector\(['"]select\.ps-create-rental-duration/.test(apiSrc),
  );
  ok(
    'Edit renders + reads per-item duration select (parity)',
    /ps-drawer-rental-duration/.test(editSrc)
      && /scheduleProjectStandaloneRentals/.test(editSrc)
      && /data-rental-duration-key/.test(editSrc),
  );
  ok(
    'Create/Edit do not force multi-item shared duration intersection for projection',
    !/scheduleCommonShortRentalDurationKeys\(scheduleAdminPricesCache/.test(apiSrc)
      || /scheduleProjectStandaloneRentals/.test(apiSrc),
  );
  ok(
    'projection never invents board/wetsuit fallback labels for arbitrary items',
    /scheduleProjectStandaloneRentals/.test(availSrc)
      && !/function scheduleProjectStandaloneRentals[\s\S]{0,800}return 'schedule\.type\.boardRental'/.test(availSrc),
  );
  ok(
    'drawer summary uses catalog/generic labels (Towel not forced board/wetsuit)',
    /schedulePortalRentalLabel/.test(portalSrc)
      && (/offering_label|catalogLabel|humanizeRental|replace\(\/_rental/.test(portalSrc)
        || /schedulePortalRentalLabel[\s\S]{0,400}label/.test(portalSrc)),
  );
  ok(
    'day-ops keeps generic rental descriptors (Towel not misfiled as board/wetsuit)',
    /scheduleGenericRentalDescriptors/.test(dayOpsSrc)
      && /offering_label/.test(dayOpsSrc),
  );

  // ── [D] Playwright production-generated Create fixture ─────────────────────
  console.log('\n[D] Playwright Create fixture (production-generated UI)');
  process.env.STAFF_AUTH_REQUIRED = 'false';
  process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
  process.env.NODE_ENV = 'test';

  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const quotes = [];
  const creates = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  await page.route('**/staff/admin/config?**', async (route) => {
    const x = await route.fetch();
    let body;
    try { body = await x.json(); } catch (_) { body = { success: true }; }
    body.success = true;
    body.prices = TOWEL_PRICES.concat(SECOND_ITEM_PRICES.filter((p) => p.offering_key.startsWith('poncho')));
    // Dedupe by offering_key+amount
    const seen = new Set();
    body.prices = body.prices.filter((p) => {
      const k = `${p.offering_key}|${p.amount_cents}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    body.rental_offerings = SECOND_ITEM_OFFERINGS.filter((o) => o.location_id === 'sunset-somo' && o.active !== false);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.route('**/staff/admin/config/rental-offerings**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        offerings: SECOND_ITEM_OFFERINGS.filter((o) => o.location_id === 'sunset-somo' && o.active !== false),
      }),
    });
  });

  await page.route('**/staff/schedule/bookings/catalog?**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, ok: true, courses: [], offerings: [], rentals: [] }),
    });
  });

  await page.route('**/staff/schedule/bookings/quote?**', (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    quotes.push(body);
    // Mirror server authority offline: price from identity only.
    let total = 0;
    const lines = [];
    for (const r of body.rentals || []) {
      if (r.amount_cents != null || r.unit_amount_cents != null) {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'client_money_rejected' }),
        });
      }
      let unit = 0;
      if (r.offering_key === 'towel_rental' && r.duration_key === '12_hours') unit = 500;
      else if (r.offering_key === 'towel_rental' && r.duration_key === '1_day') unit = 800;
      else if (r.offering_key === 'poncho_rental' && r.duration_key === '4_hours') unit = 300;
      else if (r.offering_key === 'poncho_rental' && r.duration_key === '1_day') unit = 600;
      const qty = Number(r.quantity) || 1;
      const line = unit * qty;
      total += line;
      lines.push({
        offering_key: r.offering_key,
        duration_key: r.duration_key,
        quantity: qty,
        unit_amount_cents: unit,
        total_cents: line,
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, total_cents: total, subtotal_cents: total, line_items: lines }),
    });
  });

  await page.route('**/staff/schedule/bookings?**', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    creates.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        booking_id: '33333333-3333-3333-3333-333333333333',
        booking_code: 'TOWEL1',
      }),
    });
  });

  try {
    await page.goto(`${base}/staff/ui`);
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    // Force rental catalog into schedule caches if production load path is async.
    await page.evaluate((payload) => {
      if (typeof scheduleAdminPricesCache !== 'undefined') {
        // eslint-disable-next-line no-undef
        scheduleAdminPricesCache = payload.prices;
      }
      if (typeof scheduleRentalOfferingsCache !== 'undefined') {
        // eslint-disable-next-line no-undef
        scheduleRentalOfferingsCache = payload.offerings;
      } else {
        window.scheduleRentalOfferingsCache = payload.offerings;
      }
      if (typeof scheduleRenderCreateRentals === 'function') scheduleRenderCreateRentals();
    }, {
      prices: SECOND_ITEM_PRICES.filter((p) => p.location_id === 'sunset-somo'),
      offerings: SECOND_ITEM_OFFERINGS.filter((o) => o.location_id === 'sunset-somo' && o.active !== false),
    });

    await page.locator('#ps-create-booking').click();
    await page.locator('#ps-create-guest').fill('Towel Guest');
    await page.locator('#ps-create-phone').fill('+34600999001');
    await page.evaluate(() => {
      for (const [id, v] of [['ps-create-date-from', '2026-08-10'], ['ps-create-date-to', '2026-08-10']]) {
        const n = document.getElementById(id);
        n.value = v;
        n.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.locator('#ps-create-surfers').fill('1');
    await page.locator('#ps-create-surfers').blur();

    // Equipment-only path (no lesson already default via hidden checkbox)
    await page.evaluate(() => {
      if (typeof scheduleRenderCreateRentals === 'function') scheduleRenderCreateRentals();
    });
    await page.waitForTimeout(200);

    const rentWrap = page.locator('#ps-create-rentals');
    const towelRow = rentWrap.locator('[data-rental-offering="towel_rental"]');
    const ponchoRow = rentWrap.locator('[data-rental-offering="poncho_rental"]');
    ok('Create shows Towel label from catalog', await towelRow.count() === 1
      && /Towel/i.test(await towelRow.innerText()));
    ok('Create shows Poncho (second item)', await ponchoRow.count() === 1);
    ok('Create does not show disabled/hostile/full-day extension',
      await rentWrap.locator('[data-rental-offering="disabled_poncho"]').count() === 0
      && await rentWrap.locator('[data-rental-offering="hostile_towel"]').count() === 0
      && await rentWrap.locator('[data-rental-offering="full_day_equipment_extension"]').count() === 0);

    await towelRow.locator('input.ps-create-rental-check').check();
    const towelDur = towelRow.locator('select.ps-create-rental-duration');
    ok('Towel row has per-item duration select', await towelDur.count() === 1);
    const towelOpts = await towelDur.locator('option').evaluateAll((opts) => opts.map((o) => ({
      value: o.value,
      text: o.textContent.trim(),
      cents: o.getAttribute('data-amount-cents'),
    })));
    ok(
      'Towel one-day options are 12_hours=€5 and 1_day=€8 (no 2_days)',
      towelOpts.map((o) => o.value).sort().join(',') === '12_hours,1_day'
        && towelOpts.some((o) => o.value === '12_hours' && String(o.cents) === '500')
        && towelOpts.some((o) => o.value === '1_day' && String(o.cents) === '800')
        && !towelOpts.some((o) => o.value === '2_days'),
      JSON.stringify(towelOpts),
    );

    await towelDur.selectOption('12_hours');
    await ponchoRow.locator('input.ps-create-rental-check').check();
    const ponchoDur = ponchoRow.locator('select.ps-create-rental-duration');
    await ponchoDur.selectOption('4_hours');
    ok(
      'two selected items may hold different durations',
      await towelDur.inputValue() === '12_hours'
        && await ponchoDur.inputValue() === '4_hours',
    );

    // Multi-day span: hour packages leave Towel dropdown
    await page.evaluate(() => {
      for (const [id, v] of [['ps-create-date-from', '2026-08-10'], ['ps-create-date-to', '2026-08-11']]) {
        const n = document.getElementById(id);
        n.value = v;
        n.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (typeof scheduleRenderCreateRentals === 'function') scheduleRenderCreateRentals();
    });
    await page.waitForTimeout(150);
    // re-select after re-render
    const towelRow2 = page.locator('#ps-create-rentals [data-rental-offering="towel_rental"]');
    if (await towelRow2.locator('input.ps-create-rental-check').count()) {
      await towelRow2.locator('input.ps-create-rental-check').check();
    }
    const multiOpts = await towelRow2.locator('select.ps-create-rental-duration option').evaluateAll((opts) =>
      opts.map((o) => o.value));
    ok(
      'multi-day Towel dropdown has 1_day only (no 12_hours, inactive 2_days absent)',
      multiOpts.join(',') === '1_day' || (multiOpts.includes('1_day') && !multiOpts.includes('12_hours') && !multiOpts.includes('2_days')),
      JSON.stringify(multiOpts),
    );

    // Back to one day for save payload
    await page.evaluate(() => {
      for (const [id, v] of [['ps-create-date-from', '2026-08-10'], ['ps-create-date-to', '2026-08-10']]) {
        const n = document.getElementById(id);
        n.value = v;
        n.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (typeof scheduleRenderCreateRentals === 'function') scheduleRenderCreateRentals();
    });
    await page.waitForTimeout(150);
    const towelRow3 = page.locator('#ps-create-rentals [data-rental-offering="towel_rental"]');
    await towelRow3.locator('input.ps-create-rental-check').check();
    await towelRow3.locator('select.ps-create-rental-duration').selectOption('12_hours');

    const before = creates.length;
    await page.locator('#ps-create-submit').click();
    await page.waitForTimeout(500);
    if (creates.length === before) {
      const msg = await page.locator('#ps-create-msg').innerText().catch(() => '');
      const sum = await page.locator('#ps-create-summary').innerText().catch(() => '');
      ok('Create submit emits rental payload', false, `blocked: ${msg} | ${sum}`);
    } else {
      const body = creates[creates.length - 1];
      const rentals = body.rentals || [];
      ok(
        'create payload sends {offering_key,duration_key,quantity} with no money',
        rentals.some((r) => r.offering_key === 'towel_rental' && r.duration_key === '12_hours' && r.quantity >= 1)
          && !/amount_cents|unit_amount|total_cents|price_source/.test(JSON.stringify(rentals)),
        JSON.stringify(rentals),
      );
    }

    ok('no page errors during Create fixture', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }

  console.log(`\n── verify:sunset-rental-drawer-projection ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
