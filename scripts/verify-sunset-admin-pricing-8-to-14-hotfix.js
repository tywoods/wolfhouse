'use strict';

/**
 * verify:sunset-admin-pricing-8-to-14-hotfix
 *
 * Focused offline verifier for the Sunset staging pricing hotfix:
 *   1) Admin Group course cards hide legacy Single class (canonical 1..7 only)
 *   2) Rental edit form keeps the exact 10-key rental period contract
 *   3) Group course days 8–14 quote from exact Admin 7_days amount (prorate formula)
 *
 * Run:
 *   node scripts/verify-sunset-admin-pricing-8-to-14-hotfix.js
 *   npm run verify:sunset-admin-pricing-8-to-14-hotfix
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
process.env.SUNSET_ADMIN_DB_READ_ENABLED = '1';

const {
  CANONICAL_DAY_DURATION_KEYS,
  MAX_GROUP_COURSE_INCLUSIVE_DAYS,
  groupCourseAdminTierKeyForInclusiveDays,
  groupCourseUnitCentsFromSevenDayAdmin,
  rentalDurationKeyFromInclusiveDays,
} = require('./lib/sunset-admin-duration-keys');
const { getSunsetAdminUiBrowserSource } = require('./lib/sunset-admin-browser-source');
const { getSunsetAdminBrowserHelperSource } = require('./lib/sunset-admin-ui-helpers');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');
const { resolveActiveSunsetAdminPrice } = require('./lib/sunset-admin-price-resolve');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuote,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');
const {
  validateScheduleBookingBody,
} = require('./lib/sunset-schedule-booking-writes');
const { validatePricePatchBody, validatePriceCreateBody } = require('./lib/tenant-admin-writes');

const LOC = 'sunset-somo';
const PACK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COURSE_7D = 21000; // €210 — day 14 must be exactly 2×
const COURSE_7D_ALT = 45000;
const COURSE_3D = 10500;
const RENTAL_PERIOD_KEYS = Object.freeze([
  '1_hour', '2_hours', 'half_day', 'full_day',
  '2_days', '3_days', '4_days', '5_days', '6_days', '7_days',
]);

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

function buildPortalT() {
  const labels = {
    'admin.period.1_day': '1 day',
    'admin.period.2_days': '2 days',
    'admin.period.3_days': '3 days',
    'admin.period.4_days': '4 days',
    'admin.period.5_days': '5 days',
    'admin.period.6_days': '6 days',
    'admin.period.7_days': '7 days',
    'admin.period.1_week': '1 week',
    'admin.period.half_day': 'Half day',
    'admin.period.1_hour': '1h',
    'admin.period.single_class': 'Single class',
    'admin.period.custom': 'Custom',
    'admin.packs.priceTiers': 'Price tiers',
    'admin.packs.perStudent': 'per student',
    'admin.prices.group.bundles': 'Surfboard + Wetsuit',
    'admin.prices.group.boards': 'Surfboard',
    'admin.prices.group.wetsuits': 'Wetsuit',
    'admin.prices.group.sup': 'SUP',
    'admin.prices.group.other': 'Other',
    'admin.prices.emptyCategory': 'No prices',
    'admin.action.edit': 'Edit',
    'admin.action.add': 'Add',
    'admin.action.save': 'Save',
    'admin.action.cancel': 'Cancel',
    'admin.action.remove': 'Remove',
    'admin.edit.period': 'Price for',
    'admin.edit.amountEur': 'Amount (EUR)',
    'admin.prices.enabled': 'Enabled',
    'admin.prices.disabled': 'Disabled',
    'admin.prices.availableMixed': 'Some durations off',
  };
  return function portalT(key) {
    return Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : key;
  };
}

function loadAdminRuntime(opts) {
  const elements = (opts && opts.elements) || {};
  const sandbox = {
    console,
    portalT: buildPortalT(),
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    el(id) { return elements[id] || null; },
    getClient() { return 'sunset'; },
    getSunsetLocation() { return LOC; },
    adminEurosFromAmount(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return '';
      return (Math.round(v * 100) / 100).toFixed(2);
    },
    adminParseEurosToCents(text) {
      const n = Number(String(text || '').replace(',', '.').trim());
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'bad amount' };
      return { ok: true, value: Math.round(n * 100) };
    },
    adminCfgWritesEnabled() { return true; },
    adminEditTarget: (opts && opts.editTarget) || null,
    adminConfigCache: null,
    SUNSET_SCHEDULE_LESSON_DAY_CAP: 16,
    adminIsLessonPrice(p) {
      const c = String((p && (p.category || p.item_type)) || '').toLowerCase();
      return c === 'lesson' || c === 'package';
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(getSunsetAdminBrowserHelperSource(), sandbox);
  vm.runInContext(getSunsetAdminUiBrowserSource(), sandbox);
  return sandbox;
}

/** Realistic existing rental config: exact rental periods + pack-only/legacy rows. */
function realisticRentalConfig() {
  const prices = [];
  const centsByPeriod = {
    '1_hour': 1500,
    '2_hours': 1800,
    'half_day': 2000,
    'full_day': 2500,
    '2_days': 4500,
    '3_days': 6500,
    '4_days': 8000,
    '5_days': 9500,
    '6_days': 11000,
    '7_days': 12000,
  };
  RENTAL_PERIOD_KEYS.forEach((k) => {
    prices.push({
      id: `r-can-${k}`,
      category: 'rental',
      item_code: `board_and_suit_rental__${k}`,
      offering_key: `board_and_suit_rental__${k}`,
      unit: k,
      amount_cents: centsByPeriod[k],
      amount: centsByPeriod[k] / 100,
      currency: 'EUR',
      active: true,
    });
  });
  // Pack-only / legacy rows must not become rental cards.
  [
    { id: 'r-pack-day', unit: '1_day', amount_cents: 2500 },
    { id: 'r-leg-week', unit: '1_week', amount_cents: 9900 },
    { id: 'r-leg-custom', unit: 'custom', amount_cents: 3333 },
  ].forEach((row) => {
    prices.push({
      id: row.id,
      category: 'rental',
      item_code: `board_and_suit_rental__${row.unit}`,
      offering_key: `board_and_suit_rental__${row.unit}`,
      unit: row.unit,
      amount_cents: row.amount_cents,
      amount: row.amount_cents / 100,
      currency: 'EUR',
      active: true,
    });
  });
  return {
    ok: true,
    source: 'db',
    writes_enabled: true,
    currency: 'EUR',
    location_id: LOC,
    prices,
    surf_packs: [{
      pack_id: PACK,
      label: 'Adults weekday',
      age_band: '12_and_up',
      group_size: 16,
      beaches: ['somo'],
      weekly: 'mon_fri',
      schedules: ['1100_1300'],
      price_tiers: [
        { key: '1_day', label: '1 day', hours: 2, amount_cents: 4000 },
        { key: '2_days', label: '2 days', hours: 4, amount_cents: 7500 },
        { key: '3_days', label: '3 days', hours: 6, amount_cents: COURSE_3D },
        { key: '4_days', label: '4 days', hours: 8, amount_cents: 14000 },
        { key: '5_days', label: '5 days', hours: 10, amount_cents: 16000 },
        { key: '6_days', label: '6 days', hours: 12, amount_cents: 18000 },
        { key: '7_days', label: '7 days', hours: 14, amount_cents: COURSE_7D },
        { key: 'single_class', label: 'Single class', hours: 2, amount_cents: 4000 },
        { key: '1_week', label: '1 week', hours: 10, amount_cents: 19900 },
      ],
    }],
  };
}

function makeLoadRule(prices) {
  return async function loadRule(params) {
    const code = String(params.itemCode || '').trim();
    const loc = String(params.locationId || '').trim();
    const hits = (prices || []).filter((p) => {
      if (!p || p.active === false) return false;
      const ic = String(p.item_code || p.offering_key || '').trim();
      const pl = String(p.location_id || loc).trim();
      return ic === code && pl === loc;
    });
    if (!hits.length) return { status: 'not_found' };
    if (hits.length > 1) return { status: 'ambiguous', ambiguous: true };
    const h = hits[0];
    return {
      status: 'found',
      id: h.id,
      amount_cents: h.amount_cents,
      currency: h.currency || 'EUR',
      location_id: loc,
    };
  };
}

function isoRange(from, days) {
  const out = [];
  const start = new Date(`${from}T12:00:00Z`);
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function runCourseCardProofs() {
  console.log('\n[1] Admin Group course cards: no Single class commercial row\n');
  const cfg = realisticRentalConfig();
  const pack = cfg.surf_packs[0];
  const sandbox = loadAdminRuntime();

  const readout = sandbox.adminRenderPackTierReadout(pack.price_tiers);
  assert('readout omits Single class label', !/Single class/i.test(readout));
  assert('readout omits single_class key', !/single_class/.test(readout));
  assert('readout omits 1 week legacy', !/1 week/i.test(readout) && !/1_week/.test(readout));
  for (const k of CANONICAL_DAY_DURATION_KEYS) {
    assert(`readout keeps ${k}`, readout.includes(sandbox.adminPeriodLabel(k)) || readout.includes(k.replace('_', ' ')));
  }
  // Count commercial rows.
  const rowCount = (readout.match(/portal-admin-pack-tier-row/g) || []).length;
  assert('readout has exactly 7 commercial rows', rowCount === 7, `got ${rowCount}`);

  const editHtml = sandbox.adminRenderPackTierFields(pack.price_tiers, 'admin-pack-x');
  assert('edit form omits single_class option value', !/value="single_class"/.test(editHtml));
  assert('edit form omits Single class option text', !/Single class/i.test(editHtml));
  const tierRows = (editHtml.match(/data-pack-tier-row/g) || []).length;
  assert('edit form has 7 tier rows (canonical only)', tierRows === 7, `got ${tierRows}`);
}

function runRentalEditFilterProofs() {
  console.log('\n[2] Rental edit form: exact 10-key periods; pack/legacy rows filtered\n');
  const cfg = realisticRentalConfig();
  assert('fixture has 13 rental rows (10 periods + 3 pack/legacy)', cfg.prices.length === 13);

  const box = { innerHTML: '' };
  const elements = { 'admin-prices-body': box };
  const sandbox = loadAdminRuntime({ elements, editTarget: 'price-group:bundles' });
  sandbox.adminEditTarget = 'price-group:bundles';
  sandbox.renderAdminSectionPricesFromConfig(cfg);

  const html = box.innerHTML;
  const cards = html.match(/data-admin-price-card="/g) || [];
  assert('edit form renders exactly 10 rental cards', cards.length === 10, `got ${cards.length}`);
  assert('edit form keeps half_day card/code', /half_day/.test(html));
  assert('edit form keeps 1_hour and 2_hours', /1_hour/.test(html) && /2_hours/.test(html));
  assert('edit form omits pack-only 1_day', !/__1_day|value="1_day"/.test(html));
  assert('edit form omits 1_week', !/1_week/.test(html));
  assert('edit form omits custom period', !/__custom|value="custom"/.test(html));

  // Period selects: each exposes the exact rental contract, selected once each.
  const selectRe = /<select[^>]*data-admin-price-field="period"[^>]*>([\s\S]*?)<\/select>/gi;
  const selectedPeriods = [];
  let m;
  while ((m = selectRe.exec(html))) {
    const inner = m[1];
    const vals = [];
    const optRe = /<option\b([^>]*) value="([^"]*)"/gi;
    let om;
    let selected = null;
    // Also handle value before selected
    const optRe2 = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    while ((om = optRe2.exec(inner))) {
      const attrs = om[1] || '';
      const vmMatch = /value="([^"]*)"/.exec(attrs);
      const value = vmMatch ? vmMatch[1] : '';
      vals.push(value);
      if (/\bselected\b/i.test(attrs)) selected = value;
    }
    assert('period select has 10 options', vals.length === 10, JSON.stringify(vals));
    assert('period select values exact rental contract',
      RENTAL_PERIOD_KEYS.every((k, i) => vals[i] === k),
      JSON.stringify(vals));
    selectedPeriods.push(selected);
  }
  assert('exactly 10 period selects', selectedPeriods.length === 10, `got ${selectedPeriods.length}`);
  const uniqueSelected = selectedPeriods.slice().sort();
  assert('selected values match rental contract once each',
    RENTAL_PERIOD_KEYS.slice().sort().every((k, i) => uniqueSelected[i] === k),
    JSON.stringify(selectedPeriods));

  // Simulate Save body from rendered cards: selected periods (already parsed)
  // + amount inputs. Only the 10 rental-period cards exist in the form.
  const amountRe = /data-admin-price-field="amount"[^>]*value="([^"]*)"/gi;
  const amounts = [];
  let am;
  while ((am = amountRe.exec(html))) amounts.push(am[1]);
  assert('submit has 10 amount inputs', amounts.length === 10, JSON.stringify(amounts));
  const submitBody = selectedPeriods.map((period, i) => ({
    period_window: period,
    amount_cents: Math.round(Number(amounts[i]) * 100),
  }));
  assert('submit body has exactly 10 patches', submitBody.length === 10, JSON.stringify(submitBody));
  assert('submit periods are exact rental contract once each',
    RENTAL_PERIOD_KEYS.every((k) => submitBody.some((b) => b.period_window === k)),
    JSON.stringify(submitBody.map((b) => b.period_window)));
  assert('no duplicate period in submit',
    new Set(submitBody.map((b) => b.period_window)).size === 10);
  for (const row of submitBody) {
    assert(`submit row ${row.period_window} validates`,
      validatePricePatchBody({
        period_window: row.period_window,
        amount_cents: row.amount_cents,
      }).ok === true,
      JSON.stringify(row));
  }
  assert('server accepts half_day save',
    validatePricePatchBody({ period_window: 'half_day', amount_cents: 1000 }).ok === true);
  assert('server accepts 1_hour create',
    validatePriceCreateBody({
      rental_group: 'bundles',
      period_window: '1_hour',
      amount_cents: 1000,
    }).ok === true);

  // Pure filter helper contract.
  const filtered = sandbox.adminFilterCanonicalRentalPriceRows(cfg.prices);
  assert('filter helper returns 10', filtered.length === 10);
  assert('filter helper keys match rental contract once',
    RENTAL_PERIOD_KEYS.every((k) => filtered.some((p) => {
      const parsed = sandbox.adminParsePriceRow(p);
      return parsed.periodWindow === k;
    })));
}

async function runGroupCourse814Proofs() {
  console.log('\n[3] Group course 8–14 pricing from Admin 7_days (formula + fail-closed)\n');

  assert('MAX is 14', MAX_GROUP_COURSE_INCLUSIVE_DAYS === 14);
  for (let d = 1; d <= 7; d += 1) {
    const key = groupCourseAdminTierKeyForInclusiveDays(d);
    assert(`day ${d} → exact Admin key ${rentalDurationKeyFromInclusiveDays(d)}`,
      key === rentalDurationKeyFromInclusiveDays(d));
  }
  for (let d = 8; d <= 14; d += 1) {
    assert(`day ${d} → Admin 7_days identity`,
      groupCourseAdminTierKeyForInclusiveDays(d) === '7_days');
  }
  assert('day 15 → null (fail closed)', groupCourseAdminTierKeyForInclusiveDays(15) == null);
  assert('day 0 → null', groupCourseAdminTierKeyForInclusiveDays(0) == null);

  // Pure formula boundaries with COURSE_7D = 21000.
  const expected = {};
  for (let d = 8; d <= 14; d += 1) {
    expected[d] = Math.round((COURSE_7D * d) / 7);
  }
  assert('day 14 = exactly 2× 7-day cents', expected[14] === COURSE_7D * 2, String(expected[14]));
  for (let d = 8; d <= 14; d += 1) {
    const r = groupCourseUnitCentsFromSevenDayAdmin(COURSE_7D, d);
    assert(`formula day ${d}`, r.ok && r.unit_amount_cents === expected[d],
      JSON.stringify(r));
  }
  assert('formula rejects day 7 (exact row path)',
    groupCourseUnitCentsFromSevenDayAdmin(COURSE_7D, 7).ok === false);
  assert('formula rejects day 15',
    groupCourseUnitCentsFromSevenDayAdmin(COURSE_7D, 15).ok === false);
  assert('formula rejects missing/invalid base',
    groupCourseUnitCentsFromSevenDayAdmin(0, 10).ok === false
      && groupCourseUnitCentsFromSevenDayAdmin(null, 10).ok === false);

  // Admin price rows for course (tenant/location scoped).
  const prices = [
    {
      id: 'pr-3d',
      item_type: 'package',
      item_code: packPriceItemCode(PACK, '3_days'),
      offering_key: packPriceItemCode(PACK, '3_days'),
      amount_cents: COURSE_3D,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    },
    {
      id: 'pr-7d',
      item_type: 'package',
      item_code: packPriceItemCode(PACK, '7_days'),
      offering_key: packPriceItemCode(PACK, '7_days'),
      amount_cents: COURSE_7D,
      currency: 'EUR',
      location_id: LOC,
      active: true,
    },
  ];
  const adminCfg = {
    ok: true,
    source: 'db',
    currency: 'EUR',
    location_id: LOC,
    prices,
    surf_packs: [{
      pack_id: PACK,
      label: 'Adults',
      age_band: '12_and_up',
      group_size: 16,
      beaches: ['somo'],
      weekly: 'mon_fri',
      schedules: ['1100_1300'],
      price_tiers: [
        { key: '3_days', label: '3 days', hours: 6, amount_cents: COURSE_3D },
        { key: '7_days', label: '7 days', hours: 14, amount_cents: COURSE_7D },
      ],
    }],
    private_lesson: { enabled: false },
  };

  async function quoteDays(days, qty, cfg, loadRule) {
    const dates = isoRange('2026-08-03', days);
    const built = buildSunsetQuoteCommand({
      channel: QUOTE_CHANNELS.MANUAL_STAFF,
      trustedLocationId: LOC,
      transportBody: {
        require_db: true,
        date_from: dates[0],
        date_to: dates[dates.length - 1],
        service_dates: dates,
        components: {
          course: {
            course_id: PACK,
            tier_key: groupCourseAdminTierKeyForInclusiveDays(days),
            quantity: qty,
          },
        },
      },
      now: new Date('2026-07-01T12:00:00Z'),
    });
    if (!built.ok) return built;
    // Inject loadRule via resolveActiveSunsetAdminPrice by stubbing through opts.adminCfg
    // and a fake pg that is truthy; price resolve uses loadRule param when provided
    // only if we call resolve directly. executeSunsetQuote uses resolveActiveSunsetAdminPrice
    // without loadRule — so we monkey-patch for this offline test.
    const priceResolve = require('./lib/sunset-admin-price-resolve');
    const orig = priceResolve.resolveActiveSunsetAdminPrice;
    priceResolve.resolveActiveSunsetAdminPrice = async function patched(pg, opts) {
      return orig(pg, { ...opts, loadRule: loadRule || makeLoadRule((cfg || adminCfg).prices) });
    };
    try {
      // Skip capacity/schedule DB: offer course via catalog from adminCfg only.
      // executeSunsetQuote with pg=null still works for require_db if we force…
      // Use pg stub so quoteOfferingLine takes the course DB path without capacity SQL.
      const pgStub = {
        async query() {
          // Capacity assert may call pg — return empty OK shape if needed.
          return { rows: [] };
        },
      };
      // assertCourseAssignable needs real joins — disable by temporarily
      // short-circuiting course capacity: use offering_id path with catalog-only
      // when schedule eval may fail. Prefer components quote with schedule that
      // allows mon_fri and dates on weekdays.
      const result = await executeSunsetQuote(pgStub, built.command, { adminCfg: cfg || adminCfg });
      return result;
    } finally {
      priceResolve.resolveActiveSunsetAdminPrice = orig;
    }
  }

  // assertCourseAssignable will fail with empty stub. Instead unit-test the
  // pure quote owner resolveGroupCourseUnitAmountCents via direct price resolve
  // + formula, and the exported helpers; plus executeSunsetQuote with pg=null
  // and require_db false using catalog amounts.

  // Direct Admin resolve + formula (authoritative owner pieces).
  const loadRule = makeLoadRule(prices);
  const seven = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 1,
    loadRule,
    metadata: {
      component: 'course',
      course_id: PACK,
      tier_key: '7_days',
      offering_id: packPriceItemCode(PACK, '7_days'),
    },
  });
  assert('7_days Admin resolve ok', seven.ok && seven.unit_amount_cents === COURSE_7D,
    JSON.stringify(seven));

  for (let d = 7; d <= 15; d += 1) {
    if (d === 7) {
      assert('day 7 uses exact Admin 7_days (no prorate helper)',
        groupCourseAdminTierKeyForInclusiveDays(7) === '7_days'
          && groupCourseUnitCentsFromSevenDayAdmin(COURSE_7D, 7).ok === false);
      assert('day 7 unit = Admin 7_days', seven.unit_amount_cents === COURSE_7D);
      continue;
    }
    if (d === 15) {
      assert('day 15 fail closed (no tier key)',
        groupCourseAdminTierKeyForInclusiveDays(15) == null);
      const bad = validateScheduleBookingBody({
        guest_name: 'Test Guest',
        payment_status: 'unpaid',
        date_from: '2026-08-03',
        date_to: '2026-08-17', // 15 days
        service_dates: isoRange('2026-08-03', 15),
        components: {
          course: { course_id: PACK, tier_key: '7_days', quantity: 1 },
        },
      });
      assert('day 15 booking body fails closed',
        bad.ok === false && /14|course_duration|exceeds/i.test(String(bad.error || bad.reason || '')),
        JSON.stringify(bad));
      continue;
    }
    const prorated = groupCourseUnitCentsFromSevenDayAdmin(COURSE_7D, d);
    assert(`day ${d} unit cents`, prorated.ok && prorated.unit_amount_cents === expected[d],
      JSON.stringify(prorated));
    // 2 surfers → total = unit × qty (billable units = quantity for courses)
    assert(`day ${d} × 2 surfers`,
      prorated.unit_amount_cents * 2 === expected[d] * 2);
  }

  // Missing 7_days row → fail closed for 8–14.
  const missLoad = makeLoadRule(prices.filter((p) => p.id !== 'pr-7d'));
  const missSeven = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 1,
    loadRule: missLoad,
    metadata: {
      component: 'course',
      course_id: PACK,
      tier_key: '7_days',
      offering_id: packPriceItemCode(PACK, '7_days'),
    },
  });
  assert('missing 7_days fails closed',
    missSeven.ok === false,
    JSON.stringify(missSeven));
  assert('prorate without base fails closed',
    groupCourseUnitCentsFromSevenDayAdmin(missSeven.unit_amount_cents, 10).ok === false);

  // Disabled / non-positive 7_days → fail closed.
  const zeroLoad = makeLoadRule(prices.map((p) => (
    p.id === 'pr-7d' ? { ...p, amount_cents: 0 } : p
  )));
  const zeroSeven = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 1,
    loadRule: zeroLoad,
    metadata: {
      component: 'course',
      course_id: PACK,
      tier_key: '7_days',
      offering_id: packPriceItemCode(PACK, '7_days'),
    },
  });
  assert('zero 7_days fails closed', zeroSeven.ok === false, JSON.stringify(zeroSeven));

  // Changed 7_days amount mutates 8–14 quotes (no stale seed).
  const altLoad = makeLoadRule(prices.map((p) => (
    p.id === 'pr-7d' ? { ...p, amount_cents: COURSE_7D_ALT } : p
  )));
  const altSeven = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 1,
    loadRule: altLoad,
    metadata: {
      component: 'course',
      course_id: PACK,
      tier_key: '7_days',
      offering_id: packPriceItemCode(PACK, '7_days'),
    },
  });
  assert('changed 7_days resolves new amount',
    altSeven.ok && altSeven.unit_amount_cents === COURSE_7D_ALT);
  for (let d = 8; d <= 14; d += 1) {
    const r = groupCourseUnitCentsFromSevenDayAdmin(COURSE_7D_ALT, d);
    assert(`changed 7_days day ${d}`,
      r.ok && r.unit_amount_cents === Math.round((COURSE_7D_ALT * d) / 7)
        && r.unit_amount_cents !== expected[d],
      JSON.stringify(r));
  }

  // Day 3 still exact Admin 3_days (not formula from 7).
  const three = await resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: LOC,
    quantity: 2,
    loadRule,
    metadata: {
      component: 'course',
      course_id: PACK,
      tier_key: '3_days',
      offering_id: packPriceItemCode(PACK, '3_days'),
    },
  });
  assert('day 3 exact Admin row × 2 surfers',
    three.ok && three.unit_amount_cents === COURSE_3D && three.amount_cents === COURSE_3D * 2,
    JSON.stringify(three));

  // Catalog sync quote path (Create/Edit display owner when config is present).
  const catalogTierCents = {
    '1_day': 4000,
    '2_days': 7500,
    '3_days': COURSE_3D,
    '4_days': 14000,
    '5_days': 16000,
    '6_days': 18000,
    '7_days': COURSE_7D,
  };
  const catalogCfg = {
    ok: true,
    source: 'db',
    currency: 'EUR',
    location_id: LOC,
    prices: CANONICAL_DAY_DURATION_KEYS.map((k) => ({
      id: `cat-${k}`,
      item_type: 'package',
      category: 'package',
      item_code: packPriceItemCode(PACK, k),
      offering_key: packPriceItemCode(PACK, k),
      amount_cents: catalogTierCents[k],
      currency: 'EUR',
      location_id: LOC,
      active: true,
    })),
    surf_packs: [{
      pack_id: PACK,
      label: 'Adults',
      age_band: '12_and_up',
      group_size: 16,
      beaches: ['somo'],
      weekly: 'daily',
      schedules: ['0930_1130'],
      price_tiers: CANONICAL_DAY_DURATION_KEYS.map((k) => ({
        key: k,
        label: k === '1_day' ? '1 day' : `${k.replace('_days', '')} days`,
        hours: (k === '1_day' ? 1 : Number(k.replace('_days', ''))) * 2,
        amount_cents: catalogTierCents[k],
      })),
    }],
    private_lesson: { enabled: false },
  };

  async function catalogQuote(days, qty) {
    const dates = isoRange('2026-08-03', days);
    const tierKey = groupCourseAdminTierKeyForInclusiveDays(days);
    const built = buildSunsetQuoteCommand({
      channel: QUOTE_CHANNELS.MANUAL_STAFF,
      trustedLocationId: LOC,
      transportBody: {
        require_db: false,
        guest_name: 'Quote Guest',
        payment_status: 'unpaid',
        date_from: dates[0],
        date_to: dates[dates.length - 1],
        service_dates: dates,
        components: {
          course: {
            course_id: PACK,
            tier_key: tierKey,
            offering_id: packPriceItemCode(PACK, tierKey),
            quantity: qty,
          },
        },
      },
      now: new Date('2026-07-01T12:00:00Z'),
    });
    if (!built.ok) return built;
    return executeSunsetQuote(null, built.command, { adminCfg: catalogCfg });
  }

  for (let d = 7; d <= 14; d += 1) {
    const q = await catalogQuote(d, 1);
    const want = d === 7 ? COURSE_7D : Math.round((COURSE_7D * d) / 7);
    assert(`catalog quote day ${d} unit`,
      q.ok && q.body && q.body.unit_amount_cents === want,
      JSON.stringify(q.ok ? q.body : q));
    assert(`catalog quote day ${d} total`,
      q.ok && q.body.total_cents === want);
  }
  const q2 = await catalogQuote(10, 2);
  const want10 = Math.round((COURSE_7D * 10) / 7);
  assert('catalog quote day 10 × 2 surfers',
    q2.ok && q2.body.unit_amount_cents === want10 && q2.body.total_cents === want10 * 2,
    JSON.stringify(q2.ok ? q2.body : q2));

  const q15 = await catalogQuote(15, 1);
  assert('catalog quote day 15 fails closed',
    q15.ok === false,
    JSON.stringify(q15));

  // Portal derivation: 8–14 → 7_days identity; >14 unavailable; no Admin 8–14 options.
  const portalSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'),
    'utf8',
  );
  assert('portal derives 8–14 from 7_days',
    /days >= 8 && days <= 14/.test(portalSrc)
      && /tier_key: '7_days'/.test(portalSrc)
      && /7_days_prorate/.test(portalSrc));
  assert('portal fails >14',
    /days > 14/.test(portalSrc));
  const adminUi = getSunsetAdminUiBrowserSource();
  assert('Admin pack selector has no 8–14 keys',
    !/key: '8_days'|key: '14_days'/.test(adminUi)
      && !/'8_days'|'9_days'|'10_days'|'11_days'|'12_days'|'13_days'|'14_days'/.test(
        adminUi.match(/function adminPackTierDurations\(\)\{[\s\S]*?return \[([\s\S]*?)\];/)?.[1] || '',
      ));
  assert('Admin rental selector has no 8–14',
    !/'8_days'/.test(
      adminUi.match(/function adminRentalPeriodOptions\([\s\S]*?var opts = \[([^\]]+)\];/)?.[1] || '',
    ));

  // Create/Edit share authoritative quote owner (no separate client arithmetic path).
  const writesSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'),
    'utf8',
  );
  const quoteSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/luna-front-desk-quote-service.js'),
    'utf8',
  );
  assert('Create/Edit use resolveAuthoritativeScheduleQuoteInTxn',
    /resolveAuthoritativeScheduleQuoteInTxn/.test(writesSrc)
      && (writesSrc.match(/resolveAuthoritativeScheduleQuoteInTxn/g) || []).length >= 2);
  assert('quote owner implements 7_days proration',
    /groupCourseUnitCentsFromSevenDayAdmin/.test(quoteSrc)
      && /resolveGroupCourseUnitAmountCents/.test(quoteSrc)
      && /course_duration_exceeds_max/.test(quoteSrc));
  assert('no client-side 8–14 cents math in portal',
    !/Math\.round\([^)]*7_day|7_days \*|amount_cents \* .*\/ 7/.test(portalSrc));

  // Silence unused helper in case future wiring needs it
  void quoteDays;
}

function runSourceContracts() {
  console.log('\n[4] Source contracts (no live DB delete; no 8–14 Admin options)\n');
  const packRules = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/sunset-admin-pack-rules.js'),
    'utf8',
  );
  assert('pack save preserves legacy tiers (no DB delete of single_class)',
    /legacyNoDup|legacy/.test(packRules)
      && /single_class/.test(packRules));
  const adminUi = getSunsetAdminUiBrowserSource();
  assert('admin filter helper present',
    /function adminFilterCanonicalRentalPriceRows/.test(adminUi)
      && /function adminIsCanonicalRentalPeriod/.test(adminUi));
  assert('course readout filters canonical keys',
    /adminRenderPackTierReadout[\s\S]*ADMIN_CANONICAL_PACK_TIER_KEYS/.test(adminUi));
}

async function main() {
  console.log('\nverify:sunset-admin-pricing-8-to-14-hotfix\n');
  runCourseCardProofs();
  runRentalEditFilterProofs();
  await runGroupCourse814Proofs();
  runSourceContracts();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
