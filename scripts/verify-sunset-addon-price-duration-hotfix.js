'use strict';

/**
 * verify:sunset-addon-price-duration-hotfix
 *
 * Focused offline gate for two confirmed Sunset staging hotfixes:
 *   A) Custom add-on price parse (10 / 10.0 / 10.00) + Create quote line + Edit Save
 *      persistence / readback / no-duplicate retry
 *   B) No-lesson multi-day board+wetsuit duration identity (1/4/6/7 Admin tiers,
 *      conflicting duration fail-closed, surfer spoof blocked, Luna trusted path)
 *
 * Exercises real production builders/parsers/handlers — not source-regex alone.
 * No DB / Azure / network.
 *
 * Run: node scripts/verify-sunset-addon-price-duration-hotfix.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
process.env.SUNSET_ADMIN_DB_READ_ENABLED = '1';

const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const editSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-edit-ui.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const writesSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-writes.js'), 'utf8');
const drawerSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js'), 'utf8');
const rentalMod = require('./browser/sunset-schedule-rental-availability');
const writes = require('./lib/sunset-schedule-booking-writes');
const drawer = require('./lib/sunset-schedule-booking-drawer');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

function extractFn(src, name) {
  const needle = 'function ' + name + '(';
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const brace = src.indexOf('{', start);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function enumDates(from, to) {
  const out = [];
  let cur = String(from).slice(0, 10);
  const end = String(to || from).slice(0, 10);
  while (cur <= end && out.length < 31) {
    out.push(cur);
    const d = new Date(cur + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    cur = d.toISOString().slice(0, 10);
  }
  return out;
}

// Admin schedule: 1d €20, 2d €40, 3d €60, 4d €80, 5d €100, 6d €115, 7d €130
const BUNDLE_CENTS = {
  '1_day': 2000,
  '2_days': 4000,
  '3_days': 6000,
  '4_days': 8000,
  '5_days': 10000,
  '6_days': 11500,
  '7_days': 13000,
};
const LOC = 'sunset-somo';

function rentalAdminCfg(extraRows) {
  const prices = [];
  Object.keys(BUNDLE_CENTS).forEach((dur) => {
    prices.push({
      id: 'price-bundle-' + dur,
      item_type: 'rental',
      item_code: 'board_and_suit_rental__' + dur,
      offering_key: 'board_and_suit_rental',
      unit: dur,
      amount_cents: BUNDLE_CENTS[dur],
      currency: 'EUR',
      location_id: LOC,
      active: true,
    });
    prices.push({
      id: 'price-board-' + dur,
      item_type: 'rental',
      item_code: 'board_rental__' + dur,
      offering_key: 'board_rental',
      unit: dur,
      amount_cents: Math.round(BUNDLE_CENTS[dur] * 0.6),
      currency: 'EUR',
      location_id: LOC,
      active: true,
    });
    prices.push({
      id: 'price-suit-' + dur,
      item_type: 'rental',
      item_code: 'wetsuit_rental__' + dur,
      offering_key: 'wetsuit_rental',
      unit: dur,
      amount_cents: Math.round(BUNDLE_CENTS[dur] * 0.4),
      currency: 'EUR',
      location_id: LOC,
      active: true,
    });
  });
  // Short pebbles (same-day no-lesson)
  prices.push(
    {
      id: 'price-board-1h', item_type: 'rental', item_code: 'board_rental__1_hour',
      offering_key: 'board_rental', unit: '1_hour', amount_cents: 800,
      currency: 'EUR', location_id: LOC, active: true,
    },
    {
      id: 'price-suit-1h', item_type: 'rental', item_code: 'wetsuit_rental__1_hour',
      offering_key: 'wetsuit_rental', unit: '1_hour', amount_cents: 500,
      currency: 'EUR', location_id: LOC, active: true,
    },
  );
  (extraRows || []).forEach((r) => prices.push(r));
  return {
    ok: true,
    source: 'db',
    prices,
    surf_packs: [],
    private_lesson: {
      label: 'Private', amount_cents: 8000, price_basis: 'per_session',
      default_duration_minutes: 120,
    },
  };
}

function quoteRentals(dateFrom, dateTo, rentals, opts) {
  opts = opts || {};
  const body = {
    guest_name: opts.guest_name || 'Test Guest',
    date_from: dateFrom,
    date_to: dateTo,
    payment_status: 'unpaid',
    components: opts.components || { surfboard: { quantity: 1 }, wetsuit: { quantity: 1 } },
    rentals,
    surfer_count: opts.surfer_count != null ? opts.surfer_count : 1,
    custom_line_items: opts.custom_line_items || undefined,
  };
  if (opts.omitRentals) delete body.rentals;
  const built = buildSunsetQuoteCommand({
    clientSlug: 'sunset',
    locationId: LOC,
    channel: opts.channel || QUOTE_CHANNELS.MANUAL_STAFF,
    transportBody: body,
    now: new Date('2026-07-01T12:00:00Z'),
  });
  if (!built.ok) return built;
  return executeSunsetQuoteSync(built.command, { adminCfg: rentalAdminCfg() });
}

console.log('\nverify:sunset-addon-price-duration-hotfix\n');

// ═══════════════════════════════════════════════════════════════════════════
// A) Custom add-on price parse + create quote line + Edit persistence
// ═══════════════════════════════════════════════════════════════════════════
console.log('[A1] Browser + server parse: 10 / 10.0 / 10.00 → 1000 cents');
const parseServer = writes.parseLocaleMoneyToCents;
ok('server 10 → 1000', parseServer('10').ok && parseServer('10').amount_cents === 1000);
ok('server 10.0 → 1000', parseServer('10.0').ok && parseServer('10.0').amount_cents === 1000);
ok('server 10.00 → 1000', parseServer('10.00').ok && parseServer('10.00').amount_cents === 1000);
ok('server reject >2 decimals', !parseServer('10.001').ok);
ok('server reject exponent', !parseServer('1e2').ok && !parseServer('10e0').ok);
ok('server reject NaN text', !parseServer('abc').ok);
ok('server reject Infinity text', !parseServer('Infinity').ok);
ok('server zero allowed (product contract)', parseServer('0').ok && parseServer('0').amount_cents === 0);
ok('server signed discount -5 → -500', parseServer('-5').ok && parseServer('-5').amount_cents === -500);

// Injected browser module (not template-embedded — avoids \\d escape consumption).
const moneyModSrc = fs.readFileSync(
  path.join(ROOT, 'scripts/browser/sunset-schedule-money-parse.js'), 'utf8',
);
const browserParseFn = extractFn(moneyModSrc, 'scheduleParseCreateMoneyToCents');
ok('browser parse fn extract', !!browserParseFn);
ok('money-parse inject marker present (no inline redeclare)',
  apiSrc.includes('/* INJECT:sunset-schedule-money-parse */')
  && !/\bfunction\s+scheduleParseCreateMoneyToCents\s*\(/.test(apiSrc));
let browserParse = null;
if (browserParseFn) {
  try {
    browserParse = vm.runInNewContext(
      browserParseFn + '; scheduleParseCreateMoneyToCents;',
      { Object, Number, String, Math, parseInt, Number: Number },
    );
  } catch (e) {
    browserParse = null;
  }
}
ok('browser parse loads', typeof browserParse === 'function');
if (typeof browserParse === 'function') {
  ok('browser 10 → 1000', browserParse('10').ok && browserParse('10').amount_cents === 1000);
  ok('browser 10.0 → 1000', browserParse('10.0').ok && browserParse('10.0').amount_cents === 1000);
  ok('browser 10.00 → 1000', browserParse('10.00').ok && browserParse('10.00').amount_cents === 1000);
  ok('browser reject >2 decimals', !browserParse('10.001').ok);
  ok('browser reject exponent', !browserParse('1e2').ok);
  ok('browser reject zero-only product path still parses 0', browserParse('0').ok);
  ok('browser signed -3.50 → -350', browserParse('-3.50').ok && browserParse('-3.50').amount_cents === -350);
}

console.log('\n[A2] scheduleConfirmCreateCustomLine behavioral (Coffee + 10 / 10.00)');
const confirmFn = extractFn(apiSrc, 'scheduleConfirmCreateCustomLine');
const parseFn = browserParseFn;
const renderFn = extractFn(apiSrc, 'scheduleRenderCreateCustomLines');
const setEditorFn = extractFn(apiSrc, 'scheduleSetCustomLineEditorOpen');
const formatFn = extractFn(apiSrc, 'scheduleFormatCentsMoney');
const escapeFn = extractFn(apiSrc, 'scheduleEscapeHtmlLite');
ok('confirm/render/parse extracts', !!(confirmFn && parseFn && renderFn && setEditorFn));

function runConfirm(priceText, labelText) {
  const nodes = {
    'ps-create-custom-line-label': { value: labelText || 'Coffee' },
    'ps-create-custom-line-price': { value: priceText },
    'ps-create-custom-line-error': { textContent: '', style: { display: 'none' } },
    'ps-create-custom-lines-list': { innerHTML: '' },
    'ps-create-custom-lines-collapsed': { style: { display: 'flex' } },
    'ps-create-custom-lines-editor': {
      style: { display: 'flex' },
      setAttribute() {},
      removeAttribute() {},
    },
  };
  const sandbox = {
    scheduleCreateCustomLines: [],
    scheduleCreateCustomLineSeq: 0,
    scheduleCreateCustomLineEditorOpen: true,
    el(id) { return nodes[id] || null; },
    portalT(k) {
      if (k === 'schedule.create.customLine.priceInvalid') return 'Enter a valid price (max 2 decimals)';
      if (k === 'schedule.create.customLine.labelRequired') return 'Label is required';
      if (k === 'schedule.create.customLine.remove') return 'Remove';
      return k;
    },
    Date,
    String,
    Number,
    Object,
    Math,
    parseInt,
    console,
  };
  const code = [
    parseFn, formatFn, escapeFn, setEditorFn, renderFn, confirmFn,
    '; scheduleConfirmCreateCustomLine();',
    '({ lines: scheduleCreateCustomLines, err: el("ps-create-custom-line-error").textContent });',
  ].join('\n');
  return vm.runInNewContext(code, sandbox);
}

const add10 = runConfirm('10', 'Coffee');
ok('Add Coffee @ 10 succeeds', add10.lines.length === 1 && add10.lines[0].amount_cents === 1000
  && add10.lines[0].label === 'Coffee' && !add10.err,
  add10.err || JSON.stringify(add10.lines));
const add1000 = runConfirm('10.00', 'Coffee');
ok('Add Coffee @ 10.00 succeeds', add1000.lines.length === 1 && add1000.lines[0].amount_cents === 1000
  && !add1000.err, add1000.err || JSON.stringify(add1000.lines));
const addBad = runConfirm('10.001', 'Coffee');
ok('Add Coffee @ 10.001 rejects with valid-price message',
  addBad.lines.length === 0 && /valid price/i.test(addBad.err || ''),
  addBad.err || 'no error');
const addExp = runConfirm('1e2', 'Coffee');
ok('Add Coffee @ 1e2 rejects', addExp.lines.length === 0 && /valid price/i.test(addExp.err || ''));

console.log('\n[A3] Create quote line Coffee +€10 exact');
const coffeeQuote = quoteRentals('2026-07-27', '2026-07-27', [
  { offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 },
], {
  custom_line_items: [
    { client_line_id: 'cl_coffee', label: 'Coffee', amount_cents: 1000 },
  ],
});
ok('quote includes Coffee line +€10', coffeeQuote.ok && coffeeQuote.body
  && (coffeeQuote.body.line_items || []).some((l) => l.client_line_id === 'cl_coffee'
    && l.total_cents === 1000 && l.label === 'Coffee'));
ok('quote total Admin+custom exact', coffeeQuote.ok
  && coffeeQuote.body.total_cents === BUNDLE_CENTS['1_day'] + 1000);

console.log('\n[A4] Edit Save payload + server persistence + readback + no duplicate');
const readEditFn = extractFn(editSrc, 'scheduleReadDrawerEditPayload');
ok('scheduleReadDrawerEditPayload extract', !!readEditFn);
ok('Edit payload carries custom_line_items (bounded fn)',
  !!readEditFn && readEditFn.includes('custom_line_items'),
  'Edit read payload must serialize custom_line_items');
ok('Edit HTML has custom add-on section',
  /data-edit-section="custom-addon"|ps-drawer-custom-lines|data-testid="ps-drawer-custom/.test(editSrc),
  'Edit drawer must expose custom add-on UI');

// pricingIntentFromBundle must include custom lines so Edit detects reprice.
const intentFn = extractFn(drawerSrc, 'pricingIntentFromBundle');
ok('pricingIntentFromBundle extract', !!intentFn);
ok('pricingIntentFromBundle includes custom lines',
  !!intentFn && /custom_line|staff_custom_line/.test(intentFn),
  'bundle pricing intent must carry custom lines');

// updateSunsetScheduleBooking must insert custom rows (not create-only).
const updateFn = extractFn(drawerSrc, 'updateSunsetScheduleBooking')
  || (() => {
    // may be large; fall back to whole-file markers
    return drawerSrc.includes('async function updateSunsetScheduleBooking')
      ? drawerSrc.slice(
        drawerSrc.indexOf('async function updateSunsetScheduleBooking'),
        drawerSrc.indexOf('async function updateSunsetScheduleBooking') + 12000,
      )
      : null;
  })();
ok('updateSunsetScheduleBooking references insertStaffCustomLineServiceRows',
  /insertStaffCustomLineServiceRows/.test(drawerSrc)
  || (writesSrc.includes('insertStaffCustomLineServiceRows')
    && /custom_line_items/.test(drawerSrc)
    && /insertStaffCustomLineServiceRows/.test(
      drawerSrc.slice(drawerSrc.indexOf('updateSunsetScheduleBooking')),
    )),
  'Edit update path must persist custom lines via insertStaffCustomLineServiceRows');

// Behavioral: create path already inserts; Edit must too when pricing changes with custom lines.
// Use a lightweight double that records insert calls via production insertStaffCustomLineServiceRows.
(async () => {
  // ── B) Multi-day duration ───────────────────────────────────────────────
  console.log('\n[B1] Inclusive date duration identity');
  ok('Jul 27–30 → 4_days',
    rentalMod.scheduleRentalDurationKeyFromDates('2026-07-27', '2026-07-30', enumDates) === '4_days');
  ok('server rentalDurationKeyFromDateRange 4 days',
    writes.rentalDurationKeyFromDateRange('2026-07-27', '2026-07-30') === '4_days');
  ok('1 day span → 1_day',
    writes.rentalDurationKeyFromDateRange('2026-07-27', '2026-07-27') === '1_day');

  console.log('\n[B2] DOM create rentals: multi-day no-lesson must not shortMode to 1_day');
  const renderRentalsFn = extractFn(apiSrc, 'scheduleRenderCreateRentals');
  ok('scheduleRenderCreateRentals extract', !!renderRentalsFn);
  // shortMode must gate on single-day span (dateDuration === '1_day'), not all no-lesson.
  ok('shortMode gated to single-day span',
    !!renderRentalsFn
    && /shortMode\s*=\s*noLesson\s*&&\s*commonShort\.length\s*>\s*0\s*&&\s*[\s\S]{0,80}1_day/.test(renderRentalsFn),
    'shortMode must require dateDuration === "1_day" (or equivalent single-day gate)');

  console.log('\n[B3] Quote exact Admin tiers 1/4/6/7 + conflict fail-closed');
  function spanForDays(n) {
    const from = '2026-07-27';
    const d = new Date(from + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + (n - 1));
    return { from, to: d.toISOString().slice(0, 10) };
  }
  for (const n of [1, 4, 6, 7]) {
    const span = spanForDays(n);
    const dur = n === 1 ? '1_day' : n + '_days';
    const q = quoteRentals(span.from, span.to, [
      { offering_key: 'board_and_suit_rental', duration_key: dur, quantity: 1 },
    ]);
    ok(n + '-day exact Admin total €' + (BUNDLE_CENTS[dur] / 100),
      q.ok && q.body && q.body.total_cents === BUNDLE_CENTS[dur]
      && (q.body.line_items || []).some((l) => (l.offering_id || l.offering_item_code || '')
        .includes('__' + dur) || l.duration_key === dur),
      q.ok ? ('total=' + (q.body && q.body.total_cents)) : JSON.stringify(q.body || q));
  }

  // Conflicting 1_day on 4-day span must fail closed (not silent €20).
  const conflict = quoteRentals('2026-07-27', '2026-07-30', [
    { offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 },
  ]);
  ok('multi-day + 1_day duration fails closed',
    !conflict.ok
    || (conflict.body && (conflict.body.reason_code === 'rental_duration_mismatch'
      || conflict.body.reason === 'rental_duration_mismatch')),
    conflict.ok
      ? ('accepted total=' + conflict.body.total_cents + ' — must not silently price 1-day tier')
      : JSON.stringify(conflict.body || conflict));
  ok('create prepare also rejects multi-day + 1_day',
    !writes.prepareCanonicalRentalsForCreate({
      guest_name: 'T', date_from: '2026-07-27', date_to: '2026-07-30',
      components: { surfboard: { quantity: 1 }, wetsuit: { quantity: 1 } },
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      surfer_count: 1,
    }).ok);

  // Legacy components (no rentals[]) multi-day must resolve 4_days not hardcoded __1_day
  const legacy4 = quoteRentals('2026-07-27', '2026-07-30', null, {
    omitRentals: true,
    components: { surfboard: { quantity: 1 }, wetsuit: { quantity: 1 } },
  });
  const legacyExpected = Math.round(BUNDLE_CENTS['4_days'] * 0.6) + Math.round(BUNDLE_CENTS['4_days'] * 0.4);
  ok('legacy multi-day resolves 4-day Admin row not 1-day',
    legacy4.ok && legacy4.body && legacy4.body.total_cents === legacyExpected
    // board + wetsuit separate legacy lines; each should use 4_days identity
    && (legacy4.body.line_items || []).every((l) => {
      const code = String(l.offering_id || l.offering_item_code || '');
      return code.includes('__4_days') && !code.includes('__1_day');
    }),
    legacy4.ok
      ? ('total=' + legacy4.body.total_cents + ' lines='
        + JSON.stringify((legacy4.body.line_items || []).map((l) => l.offering_id || l.offering_item_code)))
      : JSON.stringify(legacy4.body || legacy4));

  console.log('\n[B4] Surfer spoof blocked; trusted Luna still works');
  const spoof = quoteRentals('2026-07-27', '2026-07-30', [
    { offering_key: 'board_and_suit_rental', duration_key: '4_days', quantity: 99 },
  ], {
    surfer_count: 1,
    components: { surfboard: { quantity: 99 }, wetsuit: { quantity: 99 } },
  });
  // Staff path forces qty from surfer_count when no-lesson — quantity becomes 1, not 99.
  ok('staff no-lesson forces qty from surfer_count (not client 99)',
    spoof.ok && spoof.body
    && (spoof.body.line_items || []).some((l) => l.component === 'board_and_suit_rental'
      && Number(l.quantity) === 1
      && Number(l.total_cents) === BUNDLE_CENTS['4_days']),
    spoof.ok
      ? JSON.stringify((spoof.body.line_items || []).map((l) => ({ c: l.component, q: l.quantity, t: l.total_cents })))
      : JSON.stringify(spoof.body || spoof));

  // Staff without surfer_count + equipment fails closed.
  const noSurfer = quoteRentals('2026-07-27', '2026-07-30', [
    { offering_key: 'board_and_suit_rental', duration_key: '4_days', quantity: 1 },
  ], {
    surfer_count: null,
    components: { surfboard: { quantity: 1 }, wetsuit: { quantity: 1 } },
  });
  // Explicit null may still parse — send body without surfer_count via direct command.
  const noSurferBuilt = buildSunsetQuoteCommand({
    clientSlug: 'sunset', locationId: LOC, channel: QUOTE_CHANNELS.MANUAL_STAFF,
    transportBody: {
      guest_name: 'T', date_from: '2026-07-27', date_to: '2026-07-30', payment_status: 'unpaid',
      components: { surfboard: { quantity: 2 }, wetsuit: { quantity: 2 } },
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '4_days', quantity: 2 }],
    },
    now: new Date('2026-07-01T12:00:00Z'),
  });
  const noSurferQ = executeSunsetQuoteSync(noSurferBuilt.command, { adminCfg: rentalAdminCfg() });
  ok('staff no-lesson without surfer_count fails closed',
    !noSurferQ.ok
    && /surfer_count/i.test(String(
      (noSurferQ.body && (noSurferQ.body.reason_code || noSurferQ.body.reason || noSurferQ.body.error)) || '',
    )),
    JSON.stringify(noSurferQ.body || noSurferQ));

  // Trusted Luna may derive surfer_count from consistent component qty.
  const lunaBuilt = buildSunsetQuoteCommand({
    clientSlug: 'sunset', locationId: LOC, channel: QUOTE_CHANNELS.LUNA_WHATSAPP,
    transportBody: {
      guest_name: 'Luna Guest', date_from: '2026-07-27', date_to: '2026-07-30', payment_status: 'unpaid',
      components: { surfboard: { quantity: 2 }, wetsuit: { quantity: 2 } },
      rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '4_days', quantity: 2 }],
    },
    now: new Date('2026-07-01T12:00:00Z'),
  });
  const lunaQ = executeSunsetQuoteSync(lunaBuilt.command, { adminCfg: rentalAdminCfg() });
  ok('trusted Luna no-lesson derives surfer qty and prices 4-day × 2',
    lunaQ.ok && lunaQ.body && lunaQ.body.total_cents === BUNDLE_CENTS['4_days'] * 2,
    lunaQ.ok ? ('total=' + lunaQ.body.total_cents) : JSON.stringify(lunaQ.body || lunaQ));

  // Create path DOM duration_key for multi-day selection
  console.log('\n[B5] DOM draft builder duration_key for multi-day');
  const readRentalsFn = extractFn(apiSrc, 'scheduleReadCreateRentalSelectionFromDom');
  ok('read rentals from DOM extract', !!readRentalsFn);
  // Simulate wrap with data-duration-key 4_days and checked board_and_suit
  const ser = rentalMod.scheduleSerializeRentalsSelection(
    [{ offering_key: 'board_and_suit_rental', duration_key: '4_days', quantity: 1 }],
    '4_days',
  );
  ok('serialize preserves 4_days', ser.length === 1 && ser[0].duration_key === '4_days');
  const prep = writes.prepareCanonicalRentalsForCreate({
    guest_name: 'T', date_from: '2026-07-27', date_to: '2026-07-30', payment_status: 'unpaid',
    components: { surfboard: { quantity: 1 }, wetsuit: { quantity: 1 } },
    rentals: ser,
    surfer_count: 1,
  });
  ok('create prep accepts 4_days for Jul 27–30', prep.ok && prep.rentals
    && prep.rentals[0].duration_key === '4_days');

  // Intent fingerprint includes duration
  const fp4 = writes.buildScheduleBookingIntentFingerprint({
    guest_name: 'A', payment_status: 'unpaid', service_dates: enumDates('2026-07-27', '2026-07-30'),
    components: { surfboard: { quantity: 1 }, wetsuit: { quantity: 1 } },
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '4_days', quantity: 1 }],
  }, LOC, {});
  const fp1 = writes.buildScheduleBookingIntentFingerprint({
    guest_name: 'A', payment_status: 'unpaid', service_dates: enumDates('2026-07-27', '2026-07-30'),
    components: { surfboard: { quantity: 1 }, wetsuit: { quantity: 1 } },
    rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
  }, LOC, {});
  ok('idempotency fingerprint differs 4_days vs 1_day', fp4 && fp1 && fp4 !== fp1);

  // Edit custom persistence: production insert + pricing intent + no-duplicate identity
  console.log('\n[A5] Edit custom line persistence owners');
  ok('insertStaffCustomLineServiceRows exported',
    typeof writes.insertStaffCustomLineServiceRows === 'function');

  // pricingIntentFromBundle must see custom lines so Save reprice triggers.
  const bundleWithCustom = {
    booking: {
      metadata: {
        source: 'staff_manual_schedule',
        staff_manual_schedule: true,
        location_id: LOC,
        rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
        custom_line_items: [{ client_line_id: 'cl_coffee', label: 'Coffee', amount_cents: 1000 }],
      },
    },
    services: [
      {
        service_record_id: 'sr-board', service_type: 'surfboard', service_date: '2026-07-27',
        quantity: 1, amount_due_cents: 2000, record_source: 'staff_manual',
        metadata: {
          component: 'surfboard', source: 'staff_manual_schedule', location_id: LOC,
          offering_key: 'board_and_suit_rental', duration_key: '1_day',
        },
      },
      {
        service_record_id: 'sr-coffee', service_type: 'addon_service', service_date: '2026-07-27',
        quantity: 1, amount_due_cents: 1000, record_source: 'staff_manual',
        metadata: {
          component: 'staff_custom_line', source: 'staff_custom_line', staff_custom_line: true,
          client_line_id: 'cl_coffee', label: 'Coffee', amount_cents: 1000, location_id: LOC,
        },
      },
    ],
  };
  const intentWith = drawer.pricingIntentFromBundle(bundleWithCustom);
  ok('pricingIntentFromBundle carries Coffee custom line',
    intentWith && Array.isArray(intentWith.custom_line_items)
    && intentWith.custom_line_items.some((l) => l.client_line_id === 'cl_coffee'
      && l.amount_cents === 1000 && l.label === 'Coffee'),
    JSON.stringify(intentWith && intentWith.custom_line_items));

  const intentWithout = drawer.pricingIntentFromBundle({
    booking: {
      metadata: {
        source: 'staff_manual_schedule', staff_manual_schedule: true, location_id: LOC,
        rentals: [{ offering_key: 'board_and_suit_rental', duration_key: '1_day', quantity: 1 }],
      },
    },
    services: [bundleWithCustom.services[0]],
  });
  ok('adding custom line changes pricing intent (Edit reprice gate)',
    JSON.stringify(intentWith) !== JSON.stringify(intentWithout));

  // insertStaffCustomLineServiceRows + applyAuthoritativeQuoteAmounts (real production handlers)
  const mockInserts = [];
  const mockPg = {
    async query(sql, params) {
      const s = String(sql);
      if (/INSERT INTO booking_service_records/i.test(s)) {
        const id = 'sr-cl-' + (mockInserts.length + 1);
        let meta = {};
        try { meta = JSON.parse(params[9] || '{}'); } catch (_) { meta = {}; }
        mockInserts.push({ id, meta, params: params.slice() });
        return {
          rows: [{
            service_record_id: id, booking_id: params[1], booking_code: params[2],
            guest_name: params[3], service_type: params[4], service_date: params[5],
            quantity: params[6], payment_status: params[7], record_source: params[8],
          }],
          rowCount: 1,
        };
      }
      if (/UPDATE booking_service_records SET amount_due_cents/i.test(s)) {
        const row = mockInserts.find((r) => r.id === params[1]);
        if (row) {
          row.due = params[0];
          const metaP = params.find((p) => typeof p === 'string' && p.includes('amount_cents'));
          if (metaP) {
            try { row.meta = Object.assign({}, row.meta, JSON.parse(metaP)); } catch (_) { /* keep */ }
          }
        }
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const inserted = await writes.insertStaffCustomLineServiceRows(mockPg, {
    clientSlug: 'sunset',
    bookingId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    bookingCode: 'SUNSET-TEST',
    guestName: 'Edit Guest',
    serviceDate: '2026-07-27',
    srPayment: 'unpaid',
    attribution: {
      dbSource: 'staff_manual',
      metadataSource: 'staff_manual_schedule',
      staffManualSchedule: true,
    },
    locationId: LOC,
    componentKeys: ['surfboard', 'wetsuit'],
    bundleId: 'b1',
    customLineItems: [
      { client_line_id: 'cl_coffee', label: 'Coffee', amount_cents: 1000 },
    ],
  });
  ok('insert creates one Coffee row',
    inserted.length === 1 && mockInserts.length === 1
    && mockInserts[0].meta.label === 'Coffee'
    && mockInserts[0].meta.amount_cents === 1000
    && mockInserts[0].meta.client_line_id === 'cl_coffee');

  // Claim path: quote with Coffee → exact once; retry same claim does not invent second line
  const quoteBody = {
    total_cents: 3000,
    line_items: [
      {
        component: 'board_and_suit_rental', total_cents: 2000, unit_amount_cents: 2000,
        quantity: 1, duration_key: '1_day',
      },
      {
        component: 'staff_custom_line', client_line_id: 'cl_coffee', label: 'Coffee',
        total_cents: 1000, unit_amount_cents: 1000, price_source: 'staff_custom_line',
      },
    ],
  };
  const claimRows = [
    {
      service_record_id: 'sr-rental', service_type: 'surfboard',
      metadata: {
        component: 'surfboard', offering_key: 'board_and_suit_rental', duration_key: '1_day',
      },
    },
    {
      service_record_id: mockInserts[0].id, service_type: 'addon_service',
      metadata: mockInserts[0].meta,
    },
  ];
  const claimUpdates = [];
  const claimPg = {
    async query(sql, params) {
      claimUpdates.push({ sql: String(sql), params: params });
      return { rowCount: 1 };
    },
  };
  const claimed = await writes.applyAuthoritativeQuoteAmounts(
    claimPg, claimRows, quoteBody, { clientSlug: 'sunset' },
  );
  ok('quote claim exact total 3000 with Coffee',
    claimed.ok && claimed.total_cents === 3000);
  ok('Coffee claimed with amount identity 1000',
    claimUpdates.some((u) => u.params && u.params.indexOf(mockInserts[0].id) >= 0
      && (u.params[0] === 1000 || (typeof u.params.find === 'function'
        && u.params.some((p) => typeof p === 'string' && p.includes('"amount_cents":1000'))))));

  const claimUpdates2 = [];
  const claimPg2 = {
    async query(sql, params) {
      claimUpdates2.push({ sql: String(sql), params: params });
      return { rowCount: 1 };
    },
  };
  const claimed2 = await writes.applyAuthoritativeQuoteAmounts(
    claimPg2, claimRows, quoteBody, { clientSlug: 'sunset' },
  );
  ok('retry claim still exact once (idempotent totals)',
    claimed2.ok && claimed2.total_cents === 3000
    && claimUpdates2.filter((u) => u.params && u.params.indexOf(mockInserts[0].id) >= 0).length >= 1);

  // update path must wire insertStaffCustomLineServiceRows (bounded slice)
  const updStart = drawerSrc.indexOf('async function updateSunsetScheduleBooking');
  const updSlice = updStart >= 0 ? drawerSrc.slice(updStart, updStart + 18000) : '';
  ok('Edit update calls insertStaffCustomLineServiceRows',
    updSlice.includes('insertStaffCustomLineServiceRows')
    && updSlice.includes('custom_line_items'));
  ok('Edit update quotePrepBody includes custom_line_items',
    updSlice.includes('custom_line_items: input.custom_line_items'));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
