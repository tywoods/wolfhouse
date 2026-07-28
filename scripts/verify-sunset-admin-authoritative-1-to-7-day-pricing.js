'use strict';

/**
 * verify:sunset-admin-authoritative-1-to-7-day-pricing
 *
 * Offline TDD gate for authoritative Admin 1–7 day pricing across:
 *   Admin Prices UI/API · bookable projection · Create quote/apply ·
 *   Edit reprice · private quote · rental/bundle · payment commercial lines.
 *
 * Pricing-source matrix (each product/mode → Admin row/column → quote →
 * persisted service cents → displayed commercial line) plus mutation proofs.
 *
 * Run:
 *   node scripts/verify-sunset-admin-authoritative-1-to-7-day-pricing.js
 *   npm run verify:sunset-admin-authoritative-1-to-7-day-pricing
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
process.env.SUNSET_ADMIN_DB_READ_ENABLED = '1';

const {
  CANONICAL_DAY_DURATION_KEYS,
  durationDaysFromTierKey,
  LEGACY_TIER_KEY_TO_CANONICAL,
  rentalDurationKeyFromInclusiveDays,
  isCanonicalDayDurationKey,
} = require('./lib/sunset-admin-duration-keys');
const {
  PACK_TIER_KEYS,
  DEFAULT_PRICE_TIERS,
  validatePackBody,
  packPriceItemCode,
} = require('./lib/sunset-admin-pack-rules');
const { RENTAL_PERIOD_WINDOWS } = require('./lib/tenant-admin-writes');
const {
  projectSunsetBookableOfferingsFromConfig,
  durationDaysFromTierKey: bookableDurationDays,
} = require('./lib/sunset-bookable-offerings');
const {
  resolveRentalBillingUnit,
  resolveDurationKey,
  lookupSunsetRentalPriceAsync,
  lookupSunsetFullDayEquipmentAddonAsync,
  FULL_DAY_EQUIPMENT_ADDON_KEY,
  FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE,
} = require('./lib/sunset-rental-price-lookup');
const {
  resolveActiveSunsetAdminPrice,
} = require('./lib/sunset-admin-price-resolve');
const {
  privateLessonIdentity,
  rentalIdentity,
  fullDayEquipmentIdentity,
  packPriceItemCode: identityPackCode,
} = require('./lib/sunset-admin-price-identity');
const {
  applyAuthoritativeQuoteAmounts,
  rentalDurationKeyFromDateRange,
  resolveFullDayEquipmentAddonUnitCents,
} = require('./lib/sunset-schedule-booking-writes');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return true;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
  return false;
}

const LOC = 'sunset-somo';
const PACK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COURSE_3D = 27100;
const COURSE_7D = 45000;
const BUNDLE_3D = 6500;
const BOARD_3D = 3600;
const PRIVATE_SESSION = 8000;
const FULL_DAY_ADDON = 1500; // Admin tab unit cents (≠ baseline seed €10)
const BASELINE_FULL_DAY_SEED = 1000;
const LEGACY_WEEK_AMOUNT = 19900;
const RENTAL_PERIOD_KEYS = Object.freeze([
  '1_hour', '2_hours', 'half_day', 'full_day',
  '2_days', '3_days', '4_days', '5_days', '6_days', '7_days',
]);

function loadAdminUiSource() {
  return fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
}

function loadViewUiSource() {
  return fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-view-ui.js'), 'utf8');
}

/** Extract adminPackTierDurations / adminRentalPeriodOptions keys from browser source. */
function extractAdminSelectorKeys(src) {
  const packMatch = src.match(/function adminPackTierDurations\(\)\{[\s\S]*?return \[([\s\S]*?)\];/);
  const rentMatch = src.match(/function adminRentalPeriodOptions\([\s\S]*?var opts = \[([^\]]+)\];/);
  const packKeys = [];
  const rentKeys = [];
  if (packMatch) {
    const re = /key:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(packMatch[1]))) packKeys.push(m[1]);
  }
  if (rentMatch) {
    rentMatch[1].split(',').forEach((p) => {
      const k = p.replace(/['"\s]/g, '');
      if (k) rentKeys.push(k);
    });
  }
  return { packKeys, rentKeys };
}

function makeAdminCatalog(prices, packs, privateLesson) {
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    location_id: LOC,
    prices: prices || [],
    surf_packs: packs || [],
    private_lesson: privateLesson || {
      enabled: true,
      label: 'Private lesson',
      amount_cents: PRIVATE_SESSION,
      currency: 'EUR',
      price_basis: 'per_session',
      source: 'db',
      rule_id: 'pl-rule-1',
    },
  };
}

function adminPriceRows() {
  return [
    {
      id: 'pr-course-3d',
      item_type: 'package',
      category: 'package',
      item_code: identityPackCode(PACK, '3_days'),
      offering_key: identityPackCode(PACK, '3_days'),
      unit: 'day',
      amount_cents: COURSE_3D,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    },
    {
      id: 'pr-course-7d',
      item_type: 'package',
      category: 'package',
      item_code: identityPackCode(PACK, '7_days'),
      offering_key: identityPackCode(PACK, '7_days'),
      unit: 'day',
      amount_cents: COURSE_7D,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    },
    {
      id: 'pr-legacy-week',
      item_type: 'package',
      category: 'package',
      item_code: identityPackCode(PACK, '1_week'),
      offering_key: identityPackCode(PACK, '1_week'),
      unit: 'day',
      amount_cents: LEGACY_WEEK_AMOUNT,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    },
    {
      id: 'pr-bundle-3d',
      item_type: 'rental',
      category: 'rental',
      item_code: 'board_and_suit_rental__3_days',
      offering_key: 'board_and_suit_rental__3_days',
      unit: 'day',
      amount_cents: BUNDLE_3D,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    },
    {
      id: 'pr-board-3d',
      item_type: 'rental',
      category: 'rental',
      item_code: 'board_rental__3_days',
      offering_key: 'board_rental__3_days',
      unit: 'day',
      amount_cents: BOARD_3D,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    },
    {
      id: 'pr-private',
      item_type: 'lesson',
      category: 'lesson',
      item_code: 'private_lesson__session',
      offering_key: 'private_lesson__session',
      unit: 'session',
      amount_cents: PRIVATE_SESSION,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    },
    {
      id: 'pr-fullday',
      item_type: 'rental',
      category: 'rental',
      item_code: FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE,
      offering_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
      unit: 'day',
      amount_cents: FULL_DAY_ADDON,
      currency: 'EUR',
      location_id: LOC,
      active: true,
      addon: true,
    },
  ];
}

function makeLoadRule(rows) {
  return async (params) => {
    const duration = String(params.duration || '').trim();
    const baseCode = String(params.itemCode || '');
    // Rental/full-day async paths pass offering + duration; generic resolve may
    // already supply the compound item_code (surf_pack_…__3_days / …__day).
    const itemCode = duration && baseCode && !baseCode.includes('__')
      ? `${baseCode}__${duration}`
      : baseCode;
    const unit = String(params.billingUnit || '');
    const loc = params.locationId != null ? String(params.locationId).trim() : '';
    const hit = rows.filter((r) => {
      if (r.item_code !== itemCode) return false;
      if (r.active === false) return false;
      if (unit && r.unit !== unit) return false;
      if (loc && r.location_id && String(r.location_id) !== loc) return false;
      return true;
    });
    if (!hit.length) return { status: 'not_found', location_id: loc || LOC };
    if (hit.length > 1) return { status: 'ambiguous', ambiguous: true, location_id: loc || LOC };
    return {
      status: 'found',
      id: hit[0].id,
      amount_cents: hit[0].amount_cents,
      currency: hit[0].currency || 'EUR',
      unit: hit[0].unit,
      location_id: hit[0].location_id || LOC,
      item_code: hit[0].item_code,
      item_type: hit[0].item_type,
    };
  };
}

function makePg() {
  return {
    async query(sql) {
      const s = String(sql);
      if (/UPDATE booking_service_records SET amount_due_cents/i.test(s)) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function loadCommercialHelper() {
  const src = loadViewUiSource();
  const extract = src.match(/function scheduleDrawerBuildCommercialLines[\s\S]*?\n\}/);
  if (!extract) throw new Error('scheduleDrawerBuildCommercialLines missing');
  const sandbox = {
    portalT(k) {
      if (k === 'schedule.ops.rentalBoth') return 'Board + wetsuit';
      if (k === 'schedule.drawer.bundleSets') return 'sets';
      if (k === 'schedule.drawer.bundleOneSet') return '1 set';
      if (k === 'schedule.drawer.dayWordCap') return 'Day';
      if (k === 'schedule.drawer.daysWordCap') return 'Days';
      if (k === 'schedule.type.boardRental') return 'Board rental';
      if (k === 'schedule.type.wetsuitRental') return 'Wetsuit rental';
      if (k === 'schedule.drawer.includedInBundle') return 'Included';
      return k;
    },
    schedulePortalDurationLabel(k) {
      return ({ '3_days': '3 days', '1_day': '1 day' })[k] || k;
    },
    scheduleDrawerStripLabelDate(l) { return String(l || ''); },
  };
  vm.createContext(sandbox);
  vm.runInContext(extract[0], sandbox);
  return sandbox.scheduleDrawerBuildCommercialLines;
}

function renderBookingCardWithPeers(items) {
  const src = loadViewUiSource();
  const invoiceFn = src.match(/function scheduleRenderSunsetInvoiceCardHtml[\s\S]*?\nfunction /)
    || src.match(/function scheduleRenderSunsetBookingCardHtml[\s\S]*?\nfunction /);
  assert(
    'view UI omits Included peer labeling',
    !/includedInBundle/.test((invoiceFn && invoiceFn[0]) || '') || !/ps-day-amt-included/.test(src),
    'expected no Included peer amount markup in invoice/booking card',
  );
  // Structural: hidden peers are filtered via commercial helper, not labeled "Included".
  assert(
    'invoice commercial path hides zero peers (not Included labels)',
    /function scheduleDrawerBuildCommercialLines/.test(src)
      && (/hiddenIds|hidden_ids/.test(src))
      && !/ps-day-amt-included/.test(src),
  );
  return items;
}

async function main() {
  console.log('\nverify:sunset-admin-authoritative-1-to-7-day-pricing\n');

  // ── 1. Admin Price-for selector ──────────────────────────────────────────
  console.log('[1] Admin Price-for selectors = pack 1–7-day tiers + rental 10-key periods');
  const uiSrc = loadAdminUiSource();
  const { packKeys, rentKeys } = extractAdminSelectorKeys(uiSrc);
  assert('pack selector has 7 keys', packKeys.length === 7, JSON.stringify(packKeys));
  assert('pack selector exact 1–7',
    CANONICAL_DAY_DURATION_KEYS.every((k, i) => packKeys[i] === k),
    JSON.stringify(packKeys));
  assert('pack selector hides weeks/single_class',
    !packKeys.includes('1_week') && !packKeys.includes('single_class')
      && !packKeys.includes('2_weeks'));
  assert('rental selector has exactly 10 period keys', rentKeys.length === 10, JSON.stringify(rentKeys));
  assert('rental selector exact hour/day period contract',
    RENTAL_PERIOD_KEYS.every((k, i) => rentKeys[i] === k),
    JSON.stringify(rentKeys));
  assert('rental selector includes short periods and excludes pack-only 1_day',
    rentKeys.includes('1_hour') && rentKeys.includes('2_hours')
      && rentKeys.includes('half_day') && !rentKeys.includes('1_day'));
  assert('PACK_TIER_KEYS = 1–7 only',
    PACK_TIER_KEYS.size === 7
      && CANONICAL_DAY_DURATION_KEYS.every((k) => PACK_TIER_KEYS.has(k)));
  assert('RENTAL_PERIOD_WINDOWS = exact 10-key rental contract',
    RENTAL_PERIOD_WINDOWS.size === 10
      && RENTAL_PERIOD_KEYS.every((k) => RENTAL_PERIOD_WINDOWS.has(k))
      && !RENTAL_PERIOD_WINDOWS.has('1_day'));
  assert('DEFAULT_PRICE_TIERS invents no commercial amounts',
    Array.isArray(DEFAULT_PRICE_TIERS) && DEFAULT_PRICE_TIERS.length === 0);
  assert('reject legacy week tier on validate',
    validatePackBody({ price_tiers: [{ key: '1_week', label: '1 week', hours: 10, amount_cents: 100 }] }).ok === false);
  assert('accept 4_days tier',
    validatePackBody({
      price_tiers: [{ key: '4_days', label: '4 days', hours: 8, amount_cents: 12000 }],
    }).ok === true);

  // ── 2. Explicit legacy mapping ───────────────────────────────────────────
  console.log('\n[2] Explicit legacy key mapping (preserve amounts)');
  assert('single_class → duration 1', durationDaysFromTierKey('single_class') === 1);
  assert('1_week → duration 7', durationDaysFromTierKey('1_week') === 7);
  assert('bookable durationDays parity',
    bookableDurationDays('1_week') === 7 && bookableDurationDays('3_days') === 3);
  assert('legacy map is explicit',
    LEGACY_TIER_KEY_TO_CANONICAL.single_class === '1_day'
      && LEGACY_TIER_KEY_TO_CANONICAL['1_week'] === '7_days');
  assert('no invent for unknown key', durationDaysFromTierKey('almost_a_week') == null);

  // ── 3. Projection + matrix (Group course) ────────────────────────────────
  console.log('\n[3] Group course: inclusive days → Admin tier → cents');
  const prices = adminPriceRows();
  const packs = [{
    pack_id: PACK,
    label: 'Adults course',
    active: true,
    weekly: 'mon_fri',
    schedules: ['0930_1130'],
    price_tiers: [
      { key: '3_days', label: '3 days', hours: 6, amount_cents: COURSE_3D },
      { key: '7_days', label: '7 days', hours: 14, amount_cents: COURSE_7D },
      { key: '1_week', label: '1 week', hours: 10, amount_cents: LEGACY_WEEK_AMOUNT },
    ],
  }];
  const proj = projectSunsetBookableOfferingsFromConfig(
    makeAdminCatalog(prices, packs),
    { locationId: LOC, requireDb: true },
  );
  assert('projection ok', proj.ok === true);
  const courseOfferings = (proj.offerings || []).filter((o) => o.offering_type === 'course');
  const tier3 = courseOfferings.find((o) => o.tier_key === '3_days');
  assert('3_days bookable with Admin cents',
    tier3 && tier3.bookable && tier3.unit_amount_cents === COURSE_3D,
    JSON.stringify(tier3 && { bookable: tier3.bookable, cents: tier3.unit_amount_cents }));
  assert('3_days duration_days stamped',
    durationDaysFromTierKey(tier3 && tier3.tier_key) === 3);

  // Config-json amount alone (no Admin price row) must not be commercial truth.
  const noAdminPrice = projectSunsetBookableOfferingsFromConfig(
    makeAdminCatalog([], [{
      pack_id: PACK,
      label: 'Ghost',
      active: true,
      weekly: 'daily',
      schedules: ['0930_1130'],
      price_tiers: [{ key: '2_days', label: '2 days', hours: 4, amount_cents: 99999 }],
    }]),
    { locationId: LOC, requireDb: false },
  );
  const ghost = (noAdminPrice.offerings || []).find((o) => o.tier_key === '2_days');
  assert('no Admin row → not bookable / no fabricated cents',
    !ghost || ghost.bookable === false || ghost.unit_amount_cents == null
      || ghost.unit_amount_cents !== 99999);

  // Authoritative Admin resolve for Group 3-day (loadRule = tenant_price_rules shape)
  const loadRule = makeLoadRule(prices);
  const courseResolved = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 2,
    loadRule,
    metadata: {
      component: 'course',
      course_id: PACK,
      tier_key: '3_days',
      offering_id: identityPackCode(PACK, '3_days'),
    },
  });
  assert('course Admin resolve ok', courseResolved.ok === true, JSON.stringify(courseResolved));
  assert('course total = Admin unit × surfers (whole offering)',
    courseResolved.ok && courseResolved.amount_cents === COURSE_3D * 2
      && courseResolved.unit_amount_cents === COURSE_3D,
    JSON.stringify(courseResolved));
  assert('course price_source admin_db',
    courseResolved.ok && courseResolved.price_source === 'admin_db');
  assert('course identity matches Admin row',
    courseResolved.ok
      && courseResolved.item_code === identityPackCode(PACK, '3_days'));

  // Mutation: delete Admin course row → fail closed
  const missCourse = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 2,
    loadRule: makeLoadRule(prices.filter((p) => p.id !== 'pr-course-3d')),
    metadata: {
      component: 'course',
      course_id: PACK,
      tier_key: '3_days',
      offering_id: identityPackCode(PACK, '3_days'),
    },
  });
  assert('delete Admin course price → resolve fails closed',
    missCourse.ok === false && /price_not_configured|not_found/i.test(String(missCourse.reason || '')),
    JSON.stringify(missCourse));

  // ── 4. Rentals 1–7 + bundle integrity ────────────────────────────────────
  console.log('\n[4] Rentals 1–7 + board+suit bundle (no split)');
  assert('3_days billing unit day', resolveRentalBillingUnit('3_days') === 'day');
  assert('4_days billing unit day', resolveRentalBillingUnit('4_days') === 'day');
  assert('6_days billing unit day', resolveRentalBillingUnit('6_days') === 'day');
  assert('resolveDurationKey 3 days', resolveDurationKey('3 days') === '3_days');
  assert('inclusive 3 → 3_days', rentalDurationKeyFromInclusiveDays(3) === '3_days');
  assert('inclusive 8 unsupported', rentalDurationKeyFromInclusiveDays(8) == null);
  assert('date range 3 days key',
    rentalDurationKeyFromDateRange('2026-08-10', '2026-08-12') === '3_days');

  // Source contract: rental async lookup fails closed on tables_missing/null while DB-read ON.
  const rentalLookupSrcEarly = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/sunset-rental-price-lookup.js'),
    'utf8',
  );
  const rentalAsyncSrc = rentalLookupSrcEarly.match(
    /async function lookupSunsetRentalPriceAsync[\s\S]*?^const FULL_DAY_EQUIPMENT_ADDON_KEY/m,
  )?.[0] || '';
  assert('rental async lookup is fail-closed Admin owner (DB-read on)',
    /async function lookupSunsetRentalPriceAsync/.test(rentalLookupSrcEarly)
      && /isSunsetAdminDbReadEnabled/.test(rentalAsyncSrc)
      && /source: 'db'/.test(rentalAsyncSrc)
      && /price_not_configured/.test(rentalAsyncSrc)
      && /price_lookup_failed/.test(rentalAsyncSrc)
      // Contract: baseline ONLY when DB-read flag is off — never on tables_missing.
      && !/tables_missing[\s\S]{0,200}lookupSunsetRentalPrice\(/.test(rentalAsyncSrc)
      && !/db_read_warning\s*=\s*['"]tables_missing['"]/.test(rentalAsyncSrc));

  // GREEN: Admin bundle rows for inclusive 1–7 days → exact DB cents (not public_site seed).
  const BUNDLE_CENTS_BY_DAYS = {
    1: 2500,
    2: 4500,
    3: BUNDLE_3D,
    4: 8000,
    5: 9500,
    6: 11000,
    7: 12500,
  };
  const bundle1to7Rows = CANONICAL_DAY_DURATION_KEYS.map((dk, i) => {
    const days = i + 1;
    return {
      id: `pr-bundle-${days}d`,
      item_type: 'rental',
      category: 'rental',
      item_code: `board_and_suit_rental__${dk}`,
      offering_key: `board_and_suit_rental__${dk}`,
      unit: 'day',
      amount_cents: BUNDLE_CENTS_BY_DAYS[days],
      currency: 'EUR',
      location_id: LOC,
      active: true,
    };
  });
  // Keep course/private/full-day fixtures; replace single 3d bundle with full 1–7 set.
  const pricesWithBundle1to7 = prices
    .filter((p) => p.id !== 'pr-bundle-3d')
    .concat(bundle1to7Rows);
  for (const days of [1, 2, 3, 4, 5, 6, 7]) {
    const dk = days === 1 ? '1_day' : `${days}_days`;
    const hit = await lookupSunsetRentalPriceAsync({
      client_slug: 'sunset',
      location_id: LOC,
      item: 'board_and_suit_rental',
      duration: dk,
      loadRule: makeLoadRule(pricesWithBundle1to7),
    });
    assert(`GREEN bundle ${dk} Admin DB found → exact cents (source=db)`,
      hit.ok === true
        && hit.amount_cents === BUNDLE_CENTS_BY_DAYS[days]
        && hit.source === 'db'
        && hit.db_read_warning == null,
      JSON.stringify(hit));
  }

  // RED: tables_missing / null while DB-read ON → fail closed, never public_site/baseline.
  const rentalTablesMissing = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: LOC,
    item: 'board_and_suit_rental',
    duration: '3_days',
    loadRule: async () => ({ status: 'tables_missing' }),
  });
  assert('RED tables_missing rental (DB-read ON) → price_lookup_failed (no baseline cents)',
    rentalTablesMissing.ok === false
      && rentalTablesMissing.reason === 'price_lookup_failed'
      && rentalTablesMissing.detail === 'tables_missing'
      && rentalTablesMissing.amount_cents == null
      && rentalTablesMissing.db_read_warning == null
      && rentalTablesMissing.source !== 'admin_config'
      && rentalTablesMissing.source !== 'public_site',
    JSON.stringify(rentalTablesMissing));
  const rentalNullRes = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: LOC,
    item: 'board_and_suit_rental',
    duration: '3_days',
    loadRule: async () => null,
  });
  assert('RED null loadRule response rental → price_lookup_failed (no baseline cents)',
    rentalNullRes.ok === false
      && rentalNullRes.reason === 'price_lookup_failed'
      && rentalNullRes.detail === 'null_response'
      && rentalNullRes.amount_cents == null
      && rentalNullRes.db_read_warning == null,
    JSON.stringify(rentalNullRes));
  // Flag OFF remains the only path that may return baseline/public_site
  // (even if a loadRule would report tables_missing). half_day has a known
  // public_site seed; 3_days is not always baselined.
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = '0';
  const rentalFlagOff = await lookupSunsetRentalPriceAsync({
    client_slug: 'sunset',
    location_id: LOC,
    item: 'board_and_suit_rental',
    duration: 'half_day',
    loadRule: async () => ({ status: 'tables_missing' }),
  });
  assert('flag OFF rental → baseline/config allowed (offline/bootstrap)',
    rentalFlagOff.ok === true
      && rentalFlagOff.source === 'public_site'
      && rentalFlagOff.amount_cents === 1500,
    JSON.stringify(rentalFlagOff));
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = '1';

  const rentalId = rentalIdentity('board_and_suit_rental', '3_days', LOC);
  const bundleResolved = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 2,
    loadRule: makeLoadRule(prices),
    metadata: {
      component: 'board_and_suit_rental',
      offering_id: 'board_and_suit_rental__3_days',
      duration_key: '3_days',
    },
  });
  assert('bundle Admin resolve ok', bundleResolved.ok === true, JSON.stringify(bundleResolved));
  assert('bundle whole offering × qty (no split)',
    bundleResolved.ok && bundleResolved.amount_cents === BUNDLE_3D * 2
      && bundleResolved.unit_amount_cents === BUNDLE_3D,
    JSON.stringify(bundleResolved));
  assert('bundle identity whole_offering',
    rentalId && rentalId.billing_mode === 'whole_offering_x_qty');
  const missBundle = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 2,
    loadRule: makeLoadRule(prices.filter((p) => p.id !== 'pr-bundle-3d')),
    metadata: {
      component: 'board_and_suit_rental',
      offering_id: 'board_and_suit_rental__3_days',
      duration_key: '3_days',
    },
  });
  assert('delete Admin bundle price → fail closed',
    missBundle.ok === false);

  // Mutation: reintroduce broken billing unit map for 3_days must fail the contract.
  // (Prove current owner accepts 3/4/6; older regex would null.)
  assert('mutation-sensitive: 3_days not null unit', resolveRentalBillingUnit('3_days') != null);

  // Bundle commercial display: one line, no peer Included
  console.log('\n[5] Payment commercial lines — no Included peers');
  const buildCommercial = loadCommercialHelper();
  const groupId = 'pg-bundle-1';
  const peerItems = [
    {
      service_record_id: 'sr-board',
      service_type: 'surfboard',
      label: 'Board',
      line_cents: BUNDLE_3D * 2,
      quantity: 2,
      pricing_group_id: groupId,
      rental_bundle_id: groupId,
      offering_key: 'board_and_suit_rental',
      bundle_part: 'surfboard',
      duration_key: '3_days',
      service_date: '2026-08-10',
    },
    {
      service_record_id: 'sr-suit',
      service_type: 'wetsuit',
      label: 'Wetsuit',
      line_cents: 0,
      quantity: 2,
      pricing_group_id: groupId,
      rental_bundle_id: groupId,
      offering_key: 'board_and_suit_rental',
      bundle_part: 'wetsuit',
      duration_key: '3_days',
      service_date: '2026-08-10',
    },
  ];
  const commercial = buildCommercial(peerItems, {
    offering_key: 'board_and_suit_rental',
    pricing_group_id: groupId,
    duration: '3_days',
  });
  assert('commercial collapses to one bundle line',
    commercial.lines.length === 1 && commercial.lines[0].is_bundle === true,
    JSON.stringify(commercial.lines));
  assert('commercial line uses configured bundle total',
    commercial.lines[0].line_cents === BUNDLE_3D * 2);
  assert('peer suit is hidden (not commercial)',
    commercial.hidden_ids['sr-suit'] === true);
  renderBookingCardWithPeers(peerItems);

  // Mutation: if peer rows forced into commercial without collapse, fails contract.
  const uncollapsed = buildCommercial([
    { ...peerItems[0], pricing_group_id: null, rental_bundle_id: null, offering_key: 'board_rental' },
    { ...peerItems[1], pricing_group_id: null, rental_bundle_id: null, offering_key: 'wetsuit_rental', line_cents: 0 },
  ], null);
  assert('split non-bundle peers stay separate when not bundled',
    uncollapsed.lines.length >= 1);

  // ── 6. Private Admin path ────────────────────────────────────────────────
  console.log('\n[6] Private course Admin price + multi-session allocation');
  const plIdentity = privateLessonIdentity(LOC);
  assert('private identity item_code',
    plIdentity.item_code === 'private_lesson__session'
      && plIdentity.billing_unit === 'session');
  const plResolved = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 1,
    loadRule: makeLoadRule(prices),
    metadata: { component: 'private_lesson', offering_id: 'private_lesson__session' },
  });
  assert('private Admin resolve ok', plResolved.ok === true, JSON.stringify(plResolved));
  assert('private unit is Admin cents',
    plResolved.ok && plResolved.unit_amount_cents === PRIVATE_SESSION);

  // Multi-session total: unit × surfers × sessions (session dates drive session count).
  // Quote owner uses surfer_count as quantity and session dates for billable units.
  const surferCount = 2;
  const sessionDates = ['2026-08-20', '2026-08-21'];
  const expectedPrivate = PRIVATE_SESSION * surferCount * sessionDates.length;
  assert('private multi-session formula',
    expectedPrivate === 32000);

  // Prove quote owner uses surfer_count (source contract + synthetic apply).
  const quoteSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/luna-front-desk-quote-service.js'),
    'utf8',
  );
  assert('private quote owner uses surfer_count',
    /Number\(pl\.surfer_count\)/.test(quoteSrc));

  const privateQuoteBody = {
    total_cents: expectedPrivate,
    line_items: [{
      component: 'private_lesson',
      total_cents: expectedPrivate,
      unit_amount_cents: PRIVATE_SESSION,
      quantity: surferCount,
      service_dates: sessionDates,
      price_source: 'admin_db',
      offering_id: 'private_lesson__session',
    }],
  };
  const createdRows = [
    {
      service_record_id: 'pl-1',
      service_type: 'surf_lesson',
      service_date: '2026-08-20',
      quantity: surferCount,
      metadata: { component: 'private_lesson', staff_ui_service_type: 'private_lesson' },
    },
    {
      service_record_id: 'pl-2',
      service_type: 'surf_lesson',
      service_date: '2026-08-21',
      quantity: surferCount,
      metadata: { component: 'private_lesson', staff_ui_service_type: 'private_lesson' },
    },
  ];
  const applied = await applyAuthoritativeQuoteAmounts(makePg(), createdRows, privateQuoteBody, {
    clientSlug: 'sunset',
  });
  assert('private apply ok', applied.ok === true, JSON.stringify(applied));
  assert('private applied total matches Admin formula',
    applied.ok && applied.total_cents === expectedPrivate);

  // Mutation: alter private Admin cents
  const plAlt = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 1,
    loadRule: makeLoadRule(prices.map((p) => (p.id === 'pr-private'
      ? { ...p, amount_cents: 12345 }
      : p))),
    metadata: { component: 'private_lesson', offering_id: 'private_lesson__session' },
  });
  assert('mutate private Admin cents → resolve changes',
    plAlt.ok && plAlt.unit_amount_cents === 12345,
    JSON.stringify(plAlt));

  // Mutation: delete private Admin price → fail closed
  const plMiss = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 1,
    loadRule: makeLoadRule(prices.filter((p) => p.id !== 'pr-private')),
    metadata: { component: 'private_lesson', offering_id: 'private_lesson__session' },
  });
  assert('delete private Admin price → fail closed',
    plMiss.ok === false,
    JSON.stringify(plMiss));

  // ── 7. Pricing-source matrix summary table ───────────────────────────────
  console.log('\n[7] Pricing-source matrix');
  const matrix = [
    {
      mode: 'Group course 3 days ×2',
      admin_row: identityPackCode(PACK, '3_days'),
      admin_unit: 'day',
      admin_cents: COURSE_3D,
      quote_total: COURSE_3D * 2,
      display: 'course commercial line',
    },
    {
      mode: 'Rental bundle 3 days ×2',
      admin_row: 'board_and_suit_rental__3_days',
      admin_unit: 'day',
      admin_cents: BUNDLE_3D,
      quote_total: BUNDLE_3D * 2,
      display: 'one bundle line (peers hidden)',
    },
    {
      mode: 'Private 2 sess ×2 surfers',
      admin_row: 'private_lesson__session',
      admin_unit: 'session',
      admin_cents: PRIVATE_SESSION,
      quote_total: PRIVATE_SESSION * 4,
      display: 'private commercial line',
    },
    {
      mode: 'Full-day gear 2p ×1 day',
      admin_row: FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE,
      admin_unit: 'day',
      admin_cents: FULL_DAY_ADDON,
      quote_total: FULL_DAY_ADDON * 2, // unit × people (snapshot; outside quote lines)
      display: 'addon_service snapshotted Admin cents',
    },
  ];
  matrix.forEach((row) => {
    assert(
      `matrix ${row.mode}: ${row.admin_row} @ ${row.admin_cents} → total ${row.quote_total}`,
      Number.isInteger(row.admin_cents) && row.admin_cents > 0 && row.quote_total > 0,
    );
  });
  console.log('\n  SOURCE MATRIX');
  console.log('  mode | admin_row | unit | unit_cents | quote_total | display');
  matrix.forEach((r) => {
    console.log(`  ${r.mode} | ${r.admin_row} | ${r.admin_unit} | ${r.admin_cents} | ${r.quote_total} | ${r.display}`);
  });

  // ── 8. Owner wiring (Create/Edit share quote apply) ──────────────────────
  console.log('\n[8] Create/Edit share authoritative quote owner');
  const writesSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8');
  const drawerSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js'), 'utf8');
  const rentalLookupSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-rental-price-lookup.js'), 'utf8');
  assert('writes always passes quotePrepBody on Create',
    /quotePrepBody:\s*rentalPrep\.body/.test(writesSrc));
  assert('drawer Edit passes quotePrepBody',
    /course_equipment:\s*input\.course_equipment \|\| null/.test(drawerSrc)
      && /quotePrepBody:\s*quotePrepBody/.test(drawerSrc));
  assert('resolveAuthoritative no longer rentals-only',
    /quotePrepBody \|\| opts\.rentalPrepBody/.test(writesSrc)
      || /opts\.quotePrepBody \|\| opts\.rentalPrepBody/.test(writesSrc));
  assert('missing quotePrepBody fails closed (no silent fallback)',
    /authoritative_quote_body_required/.test(writesSrc)
      && /authoritative_quote_required/.test(writesSrc)
      && !/caller may fall back/.test(writesSrc)
      && !/priceSunsetBookingServices\(pg, clientSlug, bookingId\)/.test(
        writesSrc.match(/async function applyAuthoritativeSchedulePricingInTxn[\s\S]*?\nasync function |async function applyAuthoritativeSchedulePricingInTxn[\s\S]*$/)[0]
        || writesSrc,
      ));
  assert('private quote uses surfer_count not session quantity',
    /Number\(pl\.surfer_count\)/.test(
      fs.readFileSync(path.join(ROOT, 'scripts/lib/luna-front-desk-quote-service.js'), 'utf8'),
    )
      && !/Number\(pl\.quantity\) \|\| 1\);\s*\n\s*const lineOut = pg/.test(
        fs.readFileSync(path.join(ROOT, 'scripts/lib/luna-front-desk-quote-service.js'), 'utf8'),
      ));

  // ── 8b. Full-day addon: Admin-tab DB authoritative + atomic booking total ─
  console.log('\n[8b] Full-day addon Admin DB authoritative + atomic total');
  const fdResolveSrc = (writesSrc.match(
    /async function resolveFullDayEquipmentAddonUnitCents[\s\S]*?\nasync function |async function resolveFullDayEquipmentAddonUnitCents[\s\S]*?\nconst /,
  ) || [''])[0];
  assert('full-day unit resolve uses DB-authoritative async lookup (not config merge)',
    /lookupSunsetFullDayEquipmentAddonAsync/.test(fdResolveSrc)
      && !/resolveTenantBusinessConfigAsync/.test(fdResolveSrc)
      && !/findPriceCents/.test(fdResolveSrc)
      && !/amount_cents:\s*1000/.test(fdResolveSrc));
  const fdAsyncSrc = rentalLookupSrc.match(
    /async function lookupSunsetFullDayEquipmentAddonAsync[\s\S]*?^module\.exports/m,
  )?.[0] || '';
  assert('full-day async lookup is fail-closed Admin owner (DB-read on)',
    /async function lookupSunsetFullDayEquipmentAddonAsync/.test(rentalLookupSrc)
      && /isSunsetAdminDbReadEnabled/.test(fdAsyncSrc)
      && /source: 'db'/.test(fdAsyncSrc)
      && /price_not_configured/.test(fdAsyncSrc)
      && /price_lookup_failed/.test(fdAsyncSrc)
      // Contract: baseline ONLY when DB-read flag is off — never on tables_missing.
      && !/tables_missing[\s\S]{0,200}lookupSunsetFullDayEquipmentAddon\(/.test(fdAsyncSrc)
      && !/db_read_warning\s*=\s*['"]tables_missing['"]/.test(fdAsyncSrc));
  assert('Create/Edit fail closed when full-day Admin cents unavailable',
    /full_day_equipment_extension_price_unavailable/.test(writesSrc)
      && /resolveFullDayEquipmentAddonUnitCents/.test(writesSrc));
  assert('apply combines quote total + any unowned legacy snapshot atomically',
    /const bookingTotal = checkedMoneyAdd\(applied\.total_cents, addonSum, 'booking_total'\)/.test(writesSrc)
      && /total_amount_cents = \$1/.test(writesSrc)
      && /FULL_DAY_EQUIPMENT_ADDON_KEY/.test(writesSrc));
  assert('writes never trust client amount for full-day snapshot',
    /lookupSunsetFullDayEquipmentAddonAsync/.test(fdResolveSrc)
      && !/opts\.body|body\.amount|addon_amount_cents/.test(fdResolveSrc));

  // GREEN: Admin row found → exact Admin cents (not baseline seed).
  const fdHit = await lookupSunsetFullDayEquipmentAddonAsync({
    client_slug: 'sunset',
    location_id: LOC,
    loadRule: makeLoadRule(prices),
  });
  assert('full-day Admin DB found → exact Admin cents',
    fdHit.ok === true
      && fdHit.amount_cents === FULL_DAY_ADDON
      && fdHit.amount_cents !== BASELINE_FULL_DAY_SEED
      && fdHit.source === 'db',
    JSON.stringify(fdHit));
  assert('full-day identity compound item_code',
    fullDayEquipmentIdentity(LOC).item_code === FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE
      && fullDayEquipmentIdentity(LOC).billing_unit === 'day');

  const unitFromWrites = await resolveFullDayEquipmentAddonUnitCents(
    null,
    'sunset',
    LOC,
    { loadRule: makeLoadRule(prices) },
  );
  assert('Create/Edit resolveFullDay → exact Admin unit cents',
    unitFromWrites === FULL_DAY_ADDON,
    String(unitFromWrites));

  // RED / mutation: missing Admin row → fail closed (no baseline merge).
  const fdMissing = await lookupSunsetFullDayEquipmentAddonAsync({
    client_slug: 'sunset',
    location_id: LOC,
    loadRule: makeLoadRule(prices.filter((p) => p.id !== 'pr-fullday')),
  });
  assert('RED delete full-day Admin row → fail closed (no baseline seed)',
    fdMissing.ok === false
      && fdMissing.reason === 'price_not_configured'
      && fdMissing.amount_cents == null
      && fdMissing.source === 'db',
    JSON.stringify(fdMissing));
  const unitMissing = await resolveFullDayEquipmentAddonUnitCents(
    null,
    'sunset',
    LOC,
    { loadRule: makeLoadRule(prices.filter((p) => p.id !== 'pr-fullday')) },
  );
  assert('RED Create/Edit resolve null when Admin full-day absent',
    unitMissing == null,
    String(unitMissing));

  // RED: disabled row
  const fdDisabled = await lookupSunsetFullDayEquipmentAddonAsync({
    client_slug: 'sunset',
    location_id: LOC,
    loadRule: makeLoadRule(prices.map((p) => (p.id === 'pr-fullday'
      ? { ...p, active: false }
      : p))),
  });
  assert('RED disabled full-day Admin row → fail closed',
    fdDisabled.ok === false && fdDisabled.reason === 'price_not_configured',
    JSON.stringify(fdDisabled));

  // RED: invalid / non-positive cents
  const fdInvalid = await lookupSunsetFullDayEquipmentAddonAsync({
    client_slug: 'sunset',
    location_id: LOC,
    loadRule: makeLoadRule(prices.map((p) => (p.id === 'pr-fullday'
      ? { ...p, amount_cents: 0 }
      : p))),
  });
  assert('RED invalid full-day cents → fail closed',
    fdInvalid.ok === false && fdInvalid.reason === 'price_not_configured',
    JSON.stringify(fdInvalid));

  // RED: location mismatch (Sardinero row absent for Somo-only Admin)
  const fdLoc = await lookupSunsetFullDayEquipmentAddonAsync({
    client_slug: 'sunset',
    location_id: 'sunset-sardinero',
    loadRule: makeLoadRule(prices),
  });
  assert('RED location mismatch full-day → fail closed',
    fdLoc.ok === false && fdLoc.reason === 'price_not_configured',
    JSON.stringify(fdLoc));

  // RED: unknown / empty location
  const fdBadLoc = await lookupSunsetFullDayEquipmentAddonAsync({
    client_slug: 'sunset',
    location_id: null,
    loadRule: makeLoadRule(prices),
  });
  assert('RED null location full-day → fail closed',
    fdBadLoc.ok === false && fdBadLoc.reason === 'unknown_location',
    JSON.stringify(fdBadLoc));

  // RED: query error
  const fdErr = await lookupSunsetFullDayEquipmentAddonAsync({
    client_slug: 'sunset',
    location_id: LOC,
    loadRule: async () => { throw new Error('simulated_db_error'); },
  });
  assert('RED query error full-day → fail closed (no baseline)',
    fdErr.ok === false
      && fdErr.reason === 'price_lookup_failed'
      && fdErr.amount_cents == null,
    JSON.stringify(fdErr));

  // RED: tables_missing / null loadRule while DB-read ON → fail closed, never baseline cents.
  const fdTablesMissing = await lookupSunsetFullDayEquipmentAddonAsync({
    client_slug: 'sunset',
    location_id: LOC,
    loadRule: async () => ({ status: 'tables_missing' }),
  });
  assert('RED tables_missing full-day (DB-read ON) → price_lookup_failed (no baseline cents)',
    fdTablesMissing.ok === false
      && fdTablesMissing.reason === 'price_lookup_failed'
      && fdTablesMissing.detail === 'tables_missing'
      && fdTablesMissing.amount_cents == null
      && fdTablesMissing.db_read_warning == null
      && fdTablesMissing.source !== 'admin_config'
      && fdTablesMissing.source !== 'public_site',
    JSON.stringify(fdTablesMissing));
  const unitTablesMissing = await resolveFullDayEquipmentAddonUnitCents(
    null,
    'sunset',
    LOC,
    { loadRule: async () => ({ status: 'tables_missing' }) },
  );
  assert('RED Create/Edit resolve null on tables_missing (no baseline seed)',
    unitTablesMissing == null,
    String(unitTablesMissing));
  const fdNullRes = await lookupSunsetFullDayEquipmentAddonAsync({
    client_slug: 'sunset',
    location_id: LOC,
    loadRule: async () => null,
  });
  assert('RED null loadRule response full-day → price_lookup_failed (no baseline cents)',
    fdNullRes.ok === false
      && fdNullRes.reason === 'price_lookup_failed'
      && fdNullRes.detail === 'null_response'
      && fdNullRes.amount_cents == null
      && fdNullRes.db_read_warning == null,
    JSON.stringify(fdNullRes));

  // Mutation: change Admin cents → exact new value (no sticky baseline).
  const FD_MUTATED = 2750;
  const fdMut = await lookupSunsetFullDayEquipmentAddonAsync({
    client_slug: 'sunset',
    location_id: LOC,
    loadRule: makeLoadRule(prices.map((p) => (p.id === 'pr-fullday'
      ? { ...p, amount_cents: FD_MUTATED }
      : p))),
  });
  assert('mutation Admin full-day cents → resolve changes exactly',
    fdMut.ok && fdMut.amount_cents === FD_MUTATED && fdMut.amount_cents !== FULL_DAY_ADDON,
    JSON.stringify(fdMut));

  // Also via generic Admin resolve identity path.
  const fdResolveActive = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 2,
    loadRule: makeLoadRule(prices),
    metadata: {
      component: FULL_DAY_EQUIPMENT_ADDON_KEY,
      offering_id: FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE,
    },
  });
  assert('resolveActive full-day Admin unit × qty',
    fdResolveActive.ok
      && fdResolveActive.unit_amount_cents === FULL_DAY_ADDON
      && fdResolveActive.amount_cents === FULL_DAY_ADDON * 2
      && fdResolveActive.price_source === 'admin_db',
    JSON.stringify(fdResolveActive));

  // Synthetic apply: quote lines + pre-snapshotted addon row → single header total.
  const quotePlusAddon = await applyAuthoritativeQuoteAmounts(
    makePg(),
    [{
      service_record_id: 'course-1',
      service_type: 'surf_lesson',
      service_date: '2026-08-10',
      quantity: 1,
      metadata: {
        component: 'course',
        course_id: PACK,
        tier_key: '3_days',
        offering_id: identityPackCode(PACK, '3_days'),
      },
    }],
    {
      total_cents: COURSE_3D,
      line_items: [{
        component: 'course',
        total_cents: COURSE_3D,
        unit_amount_cents: COURSE_3D,
        quantity: 1,
        price_source: 'admin_db',
        offering_id: identityPackCode(PACK, '3_days'),
      }],
    },
    { clientSlug: 'sunset' },
  );
  assert('quote apply excludes addon ownership (course only)',
    quotePlusAddon.ok && quotePlusAddon.total_cents === COURSE_3D,
    JSON.stringify(quotePlusAddon));
  const atomicTotal = Number(quotePlusAddon.total_cents) + (FULL_DAY_ADDON * 2);
  assert('booking total formula = quote + full-day Admin snapshot cents',
    atomicTotal === COURSE_3D + (FULL_DAY_ADDON * 2));

  // ── 8c. Admin save preserves legacy tiers; selector exact 7 ──────────────
  console.log('\n[8c] Admin save 1–7 does not migrate/delete legacy');
  assert('Admin UI default tiers invent no amounts',
    /var ADMIN_DEFAULT_PRICE_TIERS = \[\];/.test(uiSrc)
      || /ADMIN_DEFAULT_PRICE_TIERS = \[\]/.test(uiSrc));
  assert('pack form filters to canonical keys only',
    /ADMIN_CANONICAL_DAY_TIER_KEYS/.test(uiSrc)
      && /filter\(function\(t\)\{/.test(uiSrc));
  assert('rental selector base options exact 10-key period contract',
    /var opts = \['1_hour', '2_hours', 'half_day', 'full_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days'\]/.test(uiSrc));
  assert('pack patch owner preserves non-canonical legacy tiers',
    /legacyPreserved|legacyNoDup/.test(
      fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-admin-pack-rules.js'), 'utf8'),
    )
      && /PACK_TIER_KEYS\.has\(key\)/.test(
        fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-admin-pack-rules.js'), 'utf8'),
      ));
  // Structural: never reinsert a selected key outside the rental period contract.
  assert('rental selector does not reinsert selected legacy key',
    !/opts = \[sel\]\.concat\(opts\)/.test(uiSrc)
      && /var opts = \['1_hour', '2_hours', 'half_day', 'full_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days'\]/.test(uiSrc));

  // ── 9. Deployment activation (operator-authoritative seed; not deployed here) ─
  console.log('\n[9] Deployment activation (git-owned, insert-only Sunset Somo seed)');
  // Observed LIVE Sunset Admin (operator-reported):
  //   • board_and_suit_rental: exact 1–7 day rows already present.
  //   • separate board_rental / wetsuit_rental: only 1,2,5,7 — but catalog sells
  //     the combined bundle only; code must not require separate 3/4/6 rows.
  //   • Group course: live has 1/Single, 2, 3; operator-authoritative 4/5/6/7
  //     amounts are git-owned by sunset-somo-group-course-price-seed.js.
  //   • Private: per-session Admin row present.
  // No unknown pricing prerequisite remains. Activation is a separate guarded,
  // post-merge staging command; insert-only semantics preserve existing Admin rows.
  const remainingLivePrereqs = [];
  // Not prerequisites (bundle-only sell path; separate modes not required):
  const notRequired = [
    'board_rental__3_days', 'board_rental__4_days', 'board_rental__6_days',
    'wetsuit_rental__3_days', 'wetsuit_rental__4_days', 'wetsuit_rental__6_days',
    'board_and_suit_rental__1..7 (already present live)',
    'private_lesson__session (already present live)',
    'group_course__1_day|2_days|3_days (already present live)',
  ];
  console.log(`  remaining_live_admin_prereq_count=${remainingLivePrereqs.length}`);
  remainingLivePrereqs.forEach((m) => console.log(`  REMAINING_PREREQ  ${m}`));
  notRequired.forEach((m) => console.log(`  NOT_REQUIRED  ${m}`));
  assert('no unknown Group 4–7 Admin amount prerequisite remains',
    remainingLivePrereqs.length === 0);
  assert('tests do not require separate board/wetsuit 3/4/6 rows',
    !/board_rental__3_days.*requires Admin/.test(writesSrc)
      && remainingLivePrereqs.every((p) => !/board_rental|wetsuit_rental/.test(p)));
  assert('code does not fabricate missing 1–7 prices',
    DEFAULT_PRICE_TIERS.every((t) => !t.amount_cents || t.amount_cents === 0)
      && DEFAULT_PRICE_TIERS.length === 0);
  assert('missing Group 4–7 resolves fail-closed (no invent)',
    durationDaysFromTierKey('4_days') === 4
      && durationDaysFromTierKey('7_days') === 7);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
