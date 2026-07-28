'use strict';

/**
 * verify:sunset-admin-price-selectors-deterministic
 *
 * Focused offline browser VM/DOM proof that Admin "Price for" dropdowns
 * expose deterministic, context-specific options even with realistic legacy
 * config: packs use 1_day…7_days; rentals use ten supported short/day windows
 * and fail closed for unknown selected keys.
 *
 * Audits:
 *   1) scripts/browser/sunset-admin-ui.js runtime functions (HTML/DOM options)
 *   2) staff-query-api.js server-injected bundle wiring (no stale embedded list)
 *
 * Run:
 *   node scripts/verify-sunset-admin-price-selectors-deterministic.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const {
  CANONICAL_DAY_DURATION_KEYS,
} = require('./lib/sunset-admin-duration-keys');
const { getSunsetAdminUiBrowserSource } = require('./lib/sunset-admin-browser-source');
const { getSunsetAdminBrowserHelperSource } = require('./lib/sunset-admin-ui-helpers');
const { validatePackBody } = require('./lib/sunset-admin-pack-rules');
const {
  validatePriceCreateBody,
  validatePricePatchBody,
} = require('./lib/tenant-admin-writes');

const EXPECTED_VALUES = CANONICAL_DAY_DURATION_KEYS.slice();
const EXPECTED_LABELS = [
  '1 day', '2 days', '3 days', '4 days', '5 days', '6 days', '7 days',
];
const EXPECTED_RENTAL_VALUES = [
  '1_hour', '2_hours', 'half_day', 'full_day', '2_days',
  '3_days', '4_days', '5_days', '6_days', '7_days',
];
const EXPECTED_RENTAL_LABELS = [
  '1h', '2h', 'Half day', 'Full day', '2 days',
  '3 days', '4 days', '5 days', '6 days', '7 days',
];
const LEGACY_KEYS = [
  'single_class', '1_week', '2_weeks', '3_weeks', '4_weeks',
  '1_hour', '2_hours', 'half_day',
];

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

/** Realistic live-like legacy pack + rental config (missing 4/6 day sellable keys). */
function legacyAdminConfig() {
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    location_id: 'sunset-somo',
    surf_packs: [{
      pack_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      label: 'Adults weekday course',
      age_band: '12_and_up',
      group_size: 16,
      beaches: ['somo'],
      weekly: 'mon_fri',
      schedules: ['1100_1300'],
      // Historical live shape: 1/2/3/5/7 + weeks + single_class (no 4/6).
      price_tiers: [
        { key: '1_day', label: '1 day', hours: 2, amount_cents: 4000 },
        { key: '2_days', label: '2 days', hours: 4, amount_cents: 7500 },
        { key: '3_days', label: '3 days', hours: 6, amount_cents: 10500 },
        { key: '5_days', label: '5 days', hours: 10, amount_cents: 16000 },
        { key: '7_days', label: '7 days', hours: 14, amount_cents: 21000 },
        { key: '1_week', label: '1 week', hours: 10, amount_cents: 18000 },
        { key: '2_weeks', label: '2 weeks', hours: 20, amount_cents: 33500 },
        { key: '3_weeks', label: '3 weeks', hours: 30, amount_cents: 48000 },
        { key: '4_weeks', label: '4 weeks', hours: 40, amount_cents: 60000 },
        { key: 'single_class', label: 'Single class', hours: 2, amount_cents: 4000 },
      ],
    }],
    prices: [
      {
        id: 'r-legacy-half',
        category: 'rental',
        item_code: 'board_and_suit_rental__half_day',
        offering_key: 'board_and_suit_rental__half_day',
        unit: 'half_day',
        amount_cents: 2500,
        currency: 'EUR',
        active: true,
      },
      {
        id: 'r-legacy-week',
        category: 'rental',
        item_code: 'board_and_suit_rental__1_week',
        offering_key: 'board_and_suit_rental__1_week',
        unit: '1_week',
        amount_cents: 9900,
        currency: 'EUR',
        active: true,
      },
      {
        id: 'r-3d',
        category: 'rental',
        item_code: 'board_and_suit_rental__3_days',
        offering_key: 'board_and_suit_rental__3_days',
        unit: '3_days',
        amount_cents: 6500,
        currency: 'EUR',
        active: true,
      },
    ],
  };
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
    'admin.period.2_weeks': '2 weeks',
    'admin.period.3_weeks': '3 weeks',
    'admin.period.4_weeks': '4 weeks',
    'admin.period.single_class': 'Single class',
    'admin.period.1_hour': '1h',
    'admin.period.2_hours': '2h',
    'admin.period.half_day': 'Half day',
    'admin.packs.perStudent': 'per student',
    'admin.action.remove': 'Remove',
  };
  return function portalT(key) {
    return Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : key;
  };
}

/** Minimal DOM host: parse generated <select>/<option> HTML without jsdom. */
function parseSelects(html, selectClass) {
  const re = selectClass
    ? new RegExp(`<select[^>]*class="${selectClass}"[^>]*>([\\s\\S]*?)<\\/select>`, 'gi')
    : /<select\b[^>]*>([\s\S]*?)<\/select>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    out.push(parseOptions(m[1]));
  }
  return out;
}

function parseOptions(inner) {
  const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  const values = [];
  const labels = [];
  const selected = [];
  let m;
  while ((m = optRe.exec(inner))) {
    const attrs = m[1] || '';
    const label = String(m[2] || '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
    const vmMatch = /value="([^"]*)"/.exec(attrs);
    const value = vmMatch ? vmMatch[1] : '';
    values.push(value);
    labels.push(label);
    if (/\bselected\b/i.test(attrs)) selected.push(value);
  }
  return { values, labels, selected };
}

function loadAdminRuntime() {
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
    el() { return null; },
    getClient() { return 'sunset'; },
    getSunsetLocation() { return 'sunset-somo'; },
    adminEurosFromAmount(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return '';
      return (Math.round(v * 100) / 100).toFixed(2);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(getSunsetAdminBrowserHelperSource(), sandbox);
  vm.runInContext(getSunsetAdminUiBrowserSource(), sandbox);
  return sandbox;
}

function assertExactSeven(label, snap) {
  assert(`${label}: exactly 7 options`, snap.values.length === 7, JSON.stringify(snap.values));
  assert(`${label}: values 1_day…7_days`,
    EXPECTED_VALUES.every((k, i) => snap.values[i] === k),
    JSON.stringify(snap.values));
  assert(`${label}: labels 1 day…7 days`,
    EXPECTED_LABELS.every((t, i) => snap.labels[i] === t),
    JSON.stringify(snap.labels));
  assert(`${label}: includes missing-before 4_days + 6_days`,
    snap.values.includes('4_days') && snap.values.includes('6_days'));
  for (const bad of LEGACY_KEYS) {
    assert(`${label}: omits legacy ${bad}`, !snap.values.includes(bad));
  }
}

function assertExactRentalWindows(label, snap) {
  assert(`${label}: exactly 10 supported options`, snap.values.length === 10, JSON.stringify(snap.values));
  assert(`${label}: values exact and ordered`,
    EXPECTED_RENTAL_VALUES.every((k, i) => snap.values[i] === k), JSON.stringify(snap.values));
  assert(`${label}: labels exact and ordered`,
    EXPECTED_RENTAL_LABELS.every((t, i) => snap.labels[i] === t), JSON.stringify(snap.labels));
  assert(`${label}: no unsupported day/week/class key`,
    !snap.values.includes('1_day') && !snap.values.includes('1_week') && !snap.values.includes('single_class'));
}

function runDomProofs() {
  console.log('\n[1] Browser VM/DOM: pack + rental selectors with legacy Admin config\n');
  const cfg = legacyAdminConfig();
  const pack = cfg.surf_packs[0];
  const sandbox = loadAdminRuntime();

  // Pack "Price for" rows — render with mixed canonical + legacy stored tiers.
  // Selector options must stay fixed 1–7 (not derived from tier rows).
  const packHtml = sandbox.adminRenderPackTierRowsHtml(
    pack.price_tiers.map((t) => ({
      key: t.key,
      amount: sandbox.adminEurosFromAmount((t.amount_cents || 0) / 100),
    })),
  );
  const packSelects = parseSelects(packHtml, 'pack-tier-key');
  assert('pack edit renders a select per stored tier row',
    packSelects.length === pack.price_tiers.length,
    `got ${packSelects.length}`);
  packSelects.forEach((snap, idx) => {
    assertExactSeven(`pack row[${idx}] key=${pack.price_tiers[idx].key}`, snap);
    const stored = pack.price_tiers[idx].key;
    if (EXPECTED_VALUES.includes(stored)) {
      assert(`pack row[${idx}] selects stored canonical ${stored}`,
        snap.selected.length === 1 && snap.selected[0] === stored);
    } else {
      // Legacy selected value must not reappear; no matching option selected.
      assert(`pack row[${idx}] legacy ${stored} not among options`,
        !snap.values.includes(stored));
      assert(`pack row[${idx}] does not invent selected legacy option`,
        !snap.selected.includes(stored));
    }
  });

  // Fixed duration list function itself (source of pack options).
  const durs = sandbox.adminPackTierDurations();
  assert('adminPackTierDurations length 7', durs.length === 7);
  assert('adminPackTierDurations keys exact',
    durs.every((d, i) => d.key === EXPECTED_VALUES[i]),
    JSON.stringify(durs.map((d) => d.key)));

  // Rental "Price for" — supported windows select exactly; unknowns get a
  // disabled empty-value sentinel so the browser cannot choose option one.
  const rentalCases = [
    ...EXPECTED_RENTAL_VALUES.map((selected) => ({ label: `supported ${selected}`, selected, supported: true })),
    { label: 'unknown 1_day', selected: '1_day', supported: false },
    { label: 'unknown 1_week', selected: '1_week', supported: false },
    { label: 'unknown single_class', selected: 'single_class', supported: false },
  ];
  for (const c of rentalCases) {
    const html = `<select id="rental-sel">${sandbox.adminRentalPeriodOptions(c.selected)}</select>`;
    const snaps = parseSelects(html);
    assert(`rental ${c.label} rendered one select`, snaps.length === 1);
    if (c.supported) {
      assertExactRentalWindows(`rental ${c.label}`, snaps[0]);
      assert(`rental ${c.label} selects ${c.selected}`,
        snaps[0].selected.length === 1 && snaps[0].selected[0] === c.selected);
    } else {
      assert(`rental ${c.label} has sentinel then exact options`,
        snaps[0].values[0] === ''
          && snaps[0].values.length === 11
          && EXPECTED_RENTAL_VALUES.every((k, i) => snaps[0].values[i + 1] === k),
        JSON.stringify(snaps[0].values));
      assert(`rental ${c.label} does not reinsert unknown key`, !snaps[0].values.includes(c.selected));
      assert(`rental ${c.label} selects only sentinel (no first-option fallback)`,
        snaps[0].selected.length === 1 && snaps[0].selected[0] === '');
    }
  }

  // Edit form path used by Courses "Price for" when opening a legacy pack.
  const fieldsHtml = sandbox.adminRenderPackTierFields(pack.price_tiers, 'admin-pack-legacy');
  const fieldSelects = parseSelects(fieldsHtml, 'pack-tier-key');
  assert('pack edit form still uses only canonical rows or one blank seed',
    fieldSelects.length >= 1);
  fieldSelects.forEach((snap, idx) => {
    assertExactSeven(`pack form select[${idx}]`, snap);
  });

  // Rental edit card path for a supported half_day price row (Prices tab).
  const editHtml = sandbox.renderAdminPriceCardEditForm
    ? sandbox.renderAdminPriceCardEditForm('r-legacy-half', cfg.prices[0], 'bundles')
    : null;
  if (editHtml) {
    const rentSels = parseSelects(editHtml);
    assert('rental edit form has period select', rentSels.length >= 1);
    assertExactRentalWindows('rental edit form period', rentSels[0]);
    assert('rental edit form selects half_day', rentSels[0].selected[0] === 'half_day');
  } else {
    const snap = parseOptions(sandbox.adminRentalPeriodOptions('half_day'));
    assertExactRentalWindows('rental edit via helper (supported half_day)', snap);
  }
}

function runServerBundleAudit() {
  console.log('\n[2] Server-injected bundle audit (staff-query-api.js)\n');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const browserSrc = getSunsetAdminUiBrowserSource();

  assert('staff-query-api injects getSunsetAdminUiBrowserSource()',
    apiSrc.includes('getSunsetAdminUiBrowserSource()'));
  assert('staff-query-api injects helper source',
    apiSrc.includes('getSunsetAdminBrowserHelperSource()'));
  assert('injection markers present',
    apiSrc.includes('sunset-admin-ui: injected')
      && apiSrc.includes('sunset-admin-ui-helpers: injected'));
  assert('no stale embedded adminPackTierDurations with 1_week in staff-query-api',
    !/function adminPackTierDurations\(\)\{[\s\S]{0,400}1_week/.test(apiSrc));
  assert('no stale embedded rental options function in staff-query-api',
    !/function adminRentalPeriodOptions\(/.test(apiSrc));
  assert('no selected-key reinsertion in browser source',
    !/opts = \[sel\]\.concat\(opts\)/.test(browserSrc));
  const packFn = browserSrc.match(/function adminPackTierDurations\(\)\{[\s\S]*?return \[([\s\S]*?)\];/);
  const packFnKeys = [];
  if (packFn) {
    const re = /key:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(packFn[1]))) packFnKeys.push(m[1]);
  }
  assert('browser pack durations include 4_days and 6_days',
    packFnKeys.includes('4_days') && packFnKeys.includes('6_days'),
    JSON.stringify(packFnKeys));
  assert('browser pack durations omit single_class / 1_week',
    packFnKeys.length === 7
      && !packFnKeys.includes('single_class')
      && !packFnKeys.includes('1_week'),
    JSON.stringify(packFnKeys));

  // Runtime injection content equals browser file (the actual served functions).
  const injectedUi = getSunsetAdminUiBrowserSource();
  assert('injected UI source is browser file bytes',
    injectedUi === browserSrc && injectedUi.includes('function adminPackTierDurations'));

  // Prove the functions that buildUiHtml will inject contain exact-seven contract.
  const sandbox = loadAdminRuntime();
  const packKeys = sandbox.adminPackTierDurations().map((d) => d.key);
  const rentSnap = parseOptions(sandbox.adminRentalPeriodOptions('1_week'));
  assert('injected pack keys exact 7',
    packKeys.length === 7 && packKeys.every((k, i) => k === EXPECTED_VALUES[i]),
    JSON.stringify(packKeys));
  assert('injected unknown rental key gets empty selected sentinel',
    rentSnap.values[0] === '' && rentSnap.selected.length === 1 && rentSnap.selected[0] === '');
  assertExactRentalWindows('injected rental options after sentinel', {
    values: rentSnap.values.slice(1), labels: rentSnap.labels.slice(1), selected: [],
  });
}

function runValidationProofs() {
  console.log('\n[3] Validation rejects noncanonical saves\n');
  assert('pack rejects 1_week',
    validatePackBody({
      price_tiers: [{ key: '1_week', label: '1 week', hours: 10, amount_cents: 100 }],
    }).ok === false);
  assert('pack rejects single_class',
    validatePackBody({
      price_tiers: [{ key: 'single_class', label: 'Single class', hours: 2, amount_cents: 4000 }],
    }).ok === false);
  assert('pack accepts 4_days',
    validatePackBody({
      price_tiers: [{ key: '4_days', label: '4 days', hours: 8, amount_cents: 12000 }],
    }).ok === true);
  assert('pack accepts 6_days',
    validatePackBody({
      price_tiers: [{ key: '6_days', label: '6 days', hours: 12, amount_cents: 18000 }],
    }).ok === true);

  for (const period_window of EXPECTED_RENTAL_VALUES) {
    assert(`rental create accepts ${period_window}`,
      validatePriceCreateBody({ rental_group: 'bundles', period_window, amount_cents: 2500 }).ok === true);
    assert(`rental patch accepts ${period_window}`,
      validatePricePatchBody({ period_window }).ok === true);
  }
  assert('rental create rejects unknown 1_day',
    validatePriceCreateBody({
      rental_group: 'bundles',
      period_window: '1_day',
      amount_cents: 2500,
    }).ok === false);
  assert('rental create accepts 4_days',
    validatePriceCreateBody({
      rental_group: 'bundles',
      period_window: '4_days',
      amount_cents: 7000,
    }).ok === true);
  assert('rental patch rejects arbitrary key',
    validatePricePatchBody({ period_window: 'anything_client_sent' }).ok === false);
  assert('rental patch rejects 1_week',
    validatePricePatchBody({ period_window: '1_week' }).ok === false);
  assert('rental patch accepts 6_days',
    validatePricePatchBody({ period_window: '6_days' }).ok === true);
}

function main() {
  console.log('\nverify:sunset-admin-price-selectors-deterministic\n');
  runDomProofs();
  runServerBundleAudit();
  runValidationProofs();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
