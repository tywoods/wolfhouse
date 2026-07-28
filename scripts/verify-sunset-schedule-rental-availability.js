'use strict';

/**
 * verify:sunset-schedule-rental-availability
 *
 * Slice 2 — Schedule create rental selector + canonical rentals payload.
 * Executes the real browser module under Node/vm.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-rental-availability.js
 *   npm run verify:sunset-schedule-rental-availability
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-rental-availability.js');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');
const EN = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const ES = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

function enumerateDates(from, to) {
  const out = [];
  const a = new Date(String(from).slice(0, 10) + 'T12:00:00Z');
  const b = new Date(String(to || from).slice(0, 10) + 'T12:00:00Z');
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return out;
  for (let d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function extractFunctionSource(src, name) {
  const needle = `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

console.log('\nverify:sunset-schedule-rental-availability — Schedule create rentals\n');

assert('browser module exists', fs.existsSync(MODULE));
const mod = require(MODULE);
const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const portalSrc = fs.readFileSync(PORTAL_MODULE, 'utf8');
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');
const en = fs.readFileSync(EN, 'utf8');
const es = fs.readFileSync(ES, 'utf8');

console.log('[A] Duration key + sellable filter (VM module)');
assert(
  '1 calendar day → 1_day',
  mod.scheduleRentalDurationKeyFromDates('2026-07-20', '2026-07-20', enumerateDates) === '1_day',
);
assert(
  '3 calendar days → 3_days',
  mod.scheduleRentalDurationKeyFromDates('2026-07-20', '2026-07-22', enumerateDates) === '3_days',
);

const somoPrices = [
  { category: 'rental', offering_key: 'board_rental__1_day', amount: 15, active: true, location_id: 'sunset-somo' },
  { category: 'rental', offering_key: 'board_and_suit_rental__1_day', amount: 25, active: true, location_id: 'sunset-somo' },
  { category: 'rental', offering_key: 'board_rental__3_days', amount: 40, active: true, location_id: 'sunset-somo' },
  { category: 'rental', offering_key: 'board_rental__1_day', amount: 15, active: false, location_id: 'sunset-somo' },
  { category: 'rental', offering_key: 'wetsuit_rental__1_day', amount: 0, active: true, location_id: 'sunset-somo' },
  { category: 'rental', offering_key: 'board_rental__1_day', amount: 12, active: true, location_id: 'sunset-sardinero' },
  { category: 'rental', offering_key: 'full_day_equipment_extension__day', amount: 10, active: true, location_id: 'sunset-somo' },
];

const oneDay = mod.scheduleActiveRentalsForDuration(somoPrices, '1_day', 'sunset-somo');
assert(
  '1_day returns only active positive canonical rows for Somo',
  oneDay.length === 2
    && oneDay.some((o) => o.offering_key === 'board_rental')
    && oneDay.some((o) => o.offering_key === 'board_and_suit_rental')
    && !oneDay.some((o) => o.offering_key === 'wetsuit_rental'),
  JSON.stringify(oneDay),
);
assert(
  'inactive and zero excluded',
  !oneDay.some((o) => o.offering_key === 'wetsuit_rental')
    && !mod.scheduleActiveRentalsForDuration(
      [{ category: 'rental', offering_key: 'board_rental__1_day', amount: 15, active: false, location_id: 'sunset-somo' }],
      '1_day',
      'sunset-somo',
    ).length,
);
assert(
  'full-day extension excluded from create rentals',
  !oneDay.some((o) => String(o.offering_key).indexOf('full_day') >= 0),
);
assert(
  'exact-duration: 3_days does not include 1_day rows',
  mod.scheduleActiveRentalsForDuration(somoPrices, '3_days', 'sunset-somo').every((o) => o.duration_key === '3_days')
    && mod.scheduleActiveRentalsForDuration(somoPrices, '3_days', 'sunset-somo').length === 1,
);
assert(
  'Somo isolation: elSardi price not selected for Somo',
  !oneDay.some((o) => o.amount_cents === 1200),
);
const sardi = mod.scheduleActiveRentalsForDuration(somoPrices, '1_day', 'sunset-sardinero');
assert(
  'elSardi isolation: only sardinero board',
  sardi.length === 1 && sardi[0].offering_key === 'board_rental' && sardi[0].amount_cents === 1200,
  JSON.stringify(sardi),
);

console.log('\n[B] Modes from active offerings');
assert(
  'bundle_only mode',
  mod.scheduleRentalOfferingsMode([{ offering_key: 'board_and_suit_rental' }]) === 'bundle_only',
);
assert(
  'separate_only mode',
  mod.scheduleRentalOfferingsMode([
    { offering_key: 'board_rental' },
    { offering_key: 'wetsuit_rental' },
  ]) === 'separate_only',
);
assert(
  'all_three mode',
  mod.scheduleRentalOfferingsMode([
    { offering_key: 'board_rental' },
    { offering_key: 'wetsuit_rental' },
    { offering_key: 'board_and_suit_rental' },
  ]) === 'all_three',
);
assert('none mode', mod.scheduleRentalOfferingsMode([]) === 'none');

console.log('\n[C] Mutual exclusion + serialize');
assert(
  'selecting bundle clears board/wetsuit',
  JSON.stringify(mod.scheduleApplyRentalMutualExclusion(
    ['board_rental', 'wetsuit_rental'],
    'board_and_suit_rental',
    true,
  ).sort()) === JSON.stringify(['board_and_suit_rental']),
);
assert(
  'selecting board clears bundle',
  JSON.stringify(mod.scheduleApplyRentalMutualExclusion(
    ['board_and_suit_rental'],
    'board_rental',
    true,
  ).sort()) === JSON.stringify(['board_rental']),
);
assert(
  'separate board+wetsuit both allowed',
  JSON.stringify(mod.scheduleApplyRentalMutualExclusion(
    ['board_rental'],
    'wetsuit_rental',
    true,
  ).sort()) === JSON.stringify(['board_rental', 'wetsuit_rental']),
);

const rentals = mod.scheduleSerializeRentalsSelection([
  { offering_key: 'board_rental', duration_key: '1_day', quantity: 2 },
  { offering_key: 'wetsuit_rental', duration_key: '1_day', quantity: 1 },
  { offering_key: 'hack', duration_key: '1_day', quantity: 1 },
  { offering_key: 'board_rental', duration_key: '1_day', quantity: 0 },
], '1_day');
assert(
  'serialize canonical rentals only with positive qty',
  rentals.length === 2
    && rentals[0].offering_key === 'board_rental'
    && rentals[0].quantity === 2
    && rentals[0].duration_key === '1_day'
    && !Object.prototype.hasOwnProperty.call(rentals[0], 'amount_cents'),
  JSON.stringify(rentals),
);

console.log('\n[D] Create UI wiring (staff-query-api + injection)');
assert(
  'create form has dynamic rentals container',
  apiSrc.includes('id="ps-create-rentals"') || apiSrc.includes("id='ps-create-rentals'"),
);
assert(
  'no hardcoded default-checked surfboard/wetsuit create checkboxes',
  !/id="ps-create-comp-surfboard"[^>]*checked/.test(apiSrc)
    && !/id="ps-create-comp-wetsuit"[^>]*checked/.test(apiSrc),
);
assert(
  'scheduleReadCreatePayload emits rentals array',
  /function scheduleReadCreatePayload\(/.test(apiSrc)
    && /rentals\s*:/.test(extractFunctionSource(apiSrc, 'scheduleReadCreatePayload') || ''),
);
const readSrc = extractFunctionSource(apiSrc, 'scheduleReadCreatePayload') || '';
assert(
  'payload builder has no amount_due_cents / total_cents / amount fields',
  readSrc.length > 0
    && !readSrc.includes('amount_due_cents')
    && !readSrc.includes('total_cents')
    && !/amount_cents\s*:/.test(readSrc),
);
assert(
  'none-state i18n key present EN',
  en.includes("'schedule.create.noRentalsAvailable'"),
);
assert(
  'none-state i18n key present ES',
  es.includes("'schedule.create.noRentalsAvailable'"),
);
assert(
  'rental availability module inject marker',
  apiSrc.includes('/* INJECT:sunset-schedule-rental-availability */'),
);
assert(
  'browser source loads rental availability module',
  browserLoader.includes('getSunsetScheduleRentalAvailabilityBrowserSource')
    || browserLoader.includes('sunset-schedule-rental-availability'),
);

assert(
  'rental qty input uses unique selector class',
  apiSrc.includes('ps-create-rental-qty-input'),
);
assert(
  'rental qty wrapper keeps layout class separate from input',
  /class="portal-schedule-create-rental-qty"/.test(apiSrc)
    && /class="ps-create-rental-qty-input"/.test(apiSrc)
    && !/class="ps-create-rental-qty"/.test(apiSrc),
);
assert(
  'DOM reader selects qty input explicitly',
  /function scheduleReadCreateRentalSelectionFromDom\(/.test(apiSrc)
    && /input\.ps-create-rental-qty-input/.test(extractFunctionSource(apiSrc, 'scheduleReadCreateRentalSelectionFromDom') || ''),
);

console.log('\n[E] VM: real DOM reader + exact quantity serialization');
const readRentalSrc = extractFunctionSource(apiSrc, 'scheduleReadCreateRentalSelectionFromDom') || '';
// Payload + rental DOM reader both call the surfer authority (fallback when qty invalid / course qty).
const readSurferSrc = extractFunctionSource(apiSrc, 'scheduleReadCreateSurferCount') || '';
const readCustomLinesSrc = extractFunctionSource(apiSrc, 'scheduleReadCreateCustomLineItems') || '';
const guestPayloadContractOk = (function runPayloadVm() {
  if (!readSrc || readSrc.indexOf('rentals') < 0 || !readRentalSrc || !readSurferSrc) return false;

  function makeRentalRow(offeringKey, checked, qtyValue) {
    const check = {
      checked: !!checked,
      classList: { contains: (c) => c === 'ps-create-rental-check' },
      getAttribute: (n) => (n === 'data-offering-key' ? offeringKey : null),
    };
    const qtyInput = {
      value: qtyValue,
      classList: { contains: (c) => c === 'ps-create-rental-qty-input' },
    };
    const qtyWrap = {
      className: 'portal-schedule-create-rental-qty',
      style: { display: checked ? '' : 'none' },
      querySelector: function(sel) {
        if (sel === 'input.ps-create-rental-qty-input' || sel === '.ps-create-rental-qty-input') return qtyInput;
        if (sel === '.ps-create-rental-qty') return qtyWrap; // trap: wrapper must NOT be used as qty
        return null;
      },
    };
    return {
      getAttribute: (n) => (n === 'data-rental-offering' ? offeringKey : null),
      querySelector: function(sel) {
        if (sel === '.ps-create-rental-check') return check;
        if (sel === 'input.ps-create-rental-qty-input' || sel === '.ps-create-rental-qty-input') return qtyInput;
        if (sel === '.portal-schedule-create-rental-qty') return qtyWrap;
        // Old buggy selector hits wrapper-shaped node with no numeric value → would coerce to 1.
        if (sel === '.ps-create-rental-qty') return qtyWrap;
        return null;
      },
    };
  }

  const boardRow = makeRentalRow('board_rental', true, '3');
  const wetsuitRow = makeRentalRow('wetsuit_rental', true, '2');
  const bundleRow = makeRentalRow('board_and_suit_rental', false, '4');
  const rentalRows = [boardRow, wetsuitRow, bundleRow];

  const rentalsWrap = {
    getAttribute: (n) => (n === 'data-duration-key' ? '1_day' : null),
    querySelectorAll: function(sel) {
      if (sel === '[data-rental-offering]') return rentalRows;
      return [];
    },
  };

  const dom = {
    'ps-create-guest': { value: 'Ada Lovelace' },
    'ps-create-phone': { value: '' },
    'ps-create-date-from': { value: '2026-07-20' },
    'ps-create-date-to': { value: '2026-07-20' },
    'ps-create-payment': { value: 'unpaid' },
    'ps-create-notes': { value: '' },
    // Surfer authority used by scheduleReadCreatePayload / rental qty fallback.
    'ps-create-surfers': { value: '1' },
    'ps-create-comp-course': { checked: true },
    'ps-create-course-select': {
      selectedIndex: 0,
      value: 'course-1',
      options: [{ getAttribute: () => 'Beginner', textContent: 'Beginner' }],
    },
    'ps-create-course-tier': { value: '1_week' },
    'ps-create-course-qty': { value: '1' },
    'ps-create-comp-private-lesson': { checked: false },
    'ps-create-comp-fullday': { checked: false },
    'ps-create-rentals': rentalsWrap,
  };

  const ctx = {
    document: {
      querySelector: function(sel) {
        if (sel === '[data-course-equipment-mode][aria-pressed="true"]') {
          return { getAttribute: function(n) { return n === 'data-course-equipment-mode' ? 'during_course' : null; } };
        }
        return null;
      },
    },
    el: function(id) {
      if (dom[id]) return dom[id];
      return null;
    },
    scheduleTodayIso: function() { return '2026-07-20'; },
    scheduleReadPrivateLessonSessionsFromDom: function() { return []; },
    scheduleReadFullDayAddonRows: function() { return {}; },
    scheduleEnumerateDates: enumerateDates,
    scheduleRentalDurationKeyFromDates: mod.scheduleRentalDurationKeyFromDates,
    scheduleSerializeRentalsSelection: mod.scheduleSerializeRentalsSelection,
    scheduleRentalsToLegacyComponents: mod.scheduleRentalsToLegacyComponents,
    scheduleCreateCustomLines: [],
  };
  vm.createContext(ctx);
  try {
    vm.runInContext(
      `${readSurferSrc}\n${readRentalSrc}\n${readCustomLinesSrc}\n${readSrc}\n`
      + 'this.__rentals = scheduleReadCreateRentalSelectionFromDom();\n'
      + 'this.__payload = scheduleReadCreatePayload();\n',
      ctx,
    );
  } catch (err) {
    console.error('  (payload VM error)', err.message);
    return false;
  }

  const rentalsFromDom = ctx.__rentals;
  assert(
    'real DOM reader: board qty 3 + wetsuit qty 2',
    Array.isArray(rentalsFromDom)
      && rentalsFromDom.length === 2
      && rentalsFromDom.some((r) => r.offering_key === 'board_rental' && r.quantity === 3)
      && rentalsFromDom.some((r) => r.offering_key === 'wetsuit_rental' && r.quantity === 2),
    JSON.stringify(rentalsFromDom),
  );

  // Bundle-only selection with qty 4
  boardRow.querySelector('.ps-create-rental-check').checked = false;
  wetsuitRow.querySelector('.ps-create-rental-check').checked = false;
  bundleRow.querySelector('.ps-create-rental-check').checked = true;
  bundleRow.querySelector('.ps-create-rental-qty-input').value = '4';
  try {
    vm.runInContext('this.__bundleRentals = scheduleReadCreateRentalSelectionFromDom();', ctx);
  } catch (err) {
    console.error('  (bundle VM error)', err.message);
    return false;
  }
  assert(
    'real DOM reader: bundle qty 4',
    Array.isArray(ctx.__bundleRentals)
      && ctx.__bundleRentals.length === 1
      && ctx.__bundleRentals[0].offering_key === 'board_and_suit_rental'
      && ctx.__bundleRentals[0].quantity === 4,
    JSON.stringify(ctx.__bundleRentals),
  );

  // Invalid equipment qty: never silent parseInt||1.
  // New contract: blank surfers → omit row; valid surfers → use surfer authority.
  const invalidCases = [
    { label: 'zero', value: '0' },
    { label: 'blank', value: '' },
    { label: 'negative', value: '-2' },
    { label: 'non-numeric', value: 'abc' },
  ];
  let invalidOk = true;
  // Blank surfers: invalid qty must be omitted (not silently 1).
  dom['ps-create-surfers'].value = '';
  invalidCases.forEach(function(tc) {
    boardRow.querySelector('.ps-create-rental-check').checked = true;
    wetsuitRow.querySelector('.ps-create-rental-check').checked = false;
    bundleRow.querySelector('.ps-create-rental-check').checked = false;
    boardRow.querySelector('.ps-create-rental-qty-input').value = tc.value;
    try {
      vm.runInContext('this.__invalidRentals = scheduleReadCreateRentalSelectionFromDom();', ctx);
    } catch (err) {
      console.error('  (invalid VM error)', err.message);
      invalidOk = false;
      return;
    }
    const got = ctx.__invalidRentals || [];
    const silentlyOne = got.some((r) => r.offering_key === 'board_rental' && r.quantity === 1);
    const included = got.some((r) => r.offering_key === 'board_rental');
    assert(
      `invalid qty (${tc.label}) omitted when surfers blank (not silent 1)`,
      !silentlyOne && !included,
      JSON.stringify(got),
    );
  });
  // Surfer authority: invalid equipment qty falls back to Number of surfers (2), not silent 1.
  dom['ps-create-surfers'].value = '2';
  boardRow.querySelector('.ps-create-rental-check').checked = true;
  boardRow.querySelector('.ps-create-rental-qty-input').value = '';
  try {
    vm.runInContext('this.__fallbackRentals = scheduleReadCreateRentalSelectionFromDom();', ctx);
  } catch (err) {
    console.error('  (fallback VM error)', err.message);
    invalidOk = false;
  }
  assert(
    'blank equipment qty uses surfer authority (2), not silent 1',
    Array.isArray(ctx.__fallbackRentals)
      && ctx.__fallbackRentals.length === 1
      && ctx.__fallbackRentals[0].offering_key === 'board_rental'
      && ctx.__fallbackRentals[0].quantity === 2,
    JSON.stringify(ctx.__fallbackRentals),
  );

  // Restore board=3 / wetsuit=2 + surfers for create payload + quote
  dom['ps-create-surfers'].value = '1';
  boardRow.querySelector('.ps-create-rental-check').checked = true;
  wetsuitRow.querySelector('.ps-create-rental-check').checked = true;
  bundleRow.querySelector('.ps-create-rental-check').checked = false;
  boardRow.querySelector('.ps-create-rental-qty-input').value = '3';
  wetsuitRow.querySelector('.ps-create-rental-qty-input').value = '2';
  try {
    vm.runInContext('this.__payload = scheduleReadCreatePayload();', ctx);
  } catch (err) {
    console.error('  (create payload VM error)', err.message);
    return false;
  }
  const p = ctx.__payload;
  if (!p) return false;
  assert('guest_name preserved', p.guest_name === 'Ada Lovelace');
  assert('course component preserved', p.components && p.components.course && p.components.course.course_id === 'course-1');
  assert(
    'create payload rentals keep exact quantities',
    Array.isArray(p.rentals)
      && p.rentals.length === 2
      && p.rentals.some((r) => r.offering_key === 'board_rental' && r.quantity === 3 && r.duration_key === '1_day')
      && p.rentals.some((r) => r.offering_key === 'wetsuit_rental' && r.quantity === 2 && r.duration_key === '1_day')
      && p.components.surfboard && p.components.surfboard.quantity === 3
      && p.components.wetsuit && p.components.wetsuit.quantity === 2,
    JSON.stringify({ rentals: p.rentals, components: p.components }),
  );
  assert(
    'no amount fields on rentals or root',
    !Object.prototype.hasOwnProperty.call(p, 'amount_due_cents')
      && !Object.prototype.hasOwnProperty.call(p, 'total_cents')
      && !(p.rentals[0] && Object.prototype.hasOwnProperty.call(p.rentals[0], 'amount_cents')),
  );

  // Quote request receives those exact quantities (portal module VM)
  const quoteFn = extractFunctionSource(portalSrc, 'schedulePortalFetchQuote');
  const quoteSvcFn = extractFunctionSource(portalSrc, 'schedulePortalServiceDatesFromPayload');
  const clientQFn = extractFunctionSource(portalSrc, 'schedulePortalClientQuery');
  const fetchJsonFn = extractFunctionSource(portalSrc, 'schedulePortalFetchJson');
  const strictTotalFn = extractFunctionSource(portalSrc, 'schedulePortalStrictQuoteTotalCents');
  if (!quoteFn) return false;
  let quoteBody = null;
  const quoteCtx = {
    getSunsetLocation: function() { return 'sunset-somo'; },
    getClient: function() { return 'sunset'; },
    sunsetLocationQuerySuffix: function() { return '&location=sunset-somo'; },
    scheduleEnumerateDates: enumerateDates,
    schedulePortalQuoteState: null,
    schedulePortalQuoteGen: 0,
    fetch: function() { return Promise.resolve({ ok: true, status: 200, json: function() { return Promise.resolve({ success: true, total_cents: 100 }); } }); },
  };
  vm.createContext(quoteCtx);
  try {
    vm.runInContext(
      `${clientQFn || 'function schedulePortalClientQuery(){return "client=sunset";}'}\n`
      + `${fetchJsonFn || ''}\n`
      + `${quoteSvcFn || 'function schedulePortalServiceDatesFromPayload(p){return [];}'}\n`
      + `${strictTotalFn || 'function schedulePortalStrictQuoteTotalCents(b){return b&&typeof b.total_cents==="number"?b.total_cents:null;}'}\n`
      + `${quoteFn}\n`
      + 'this.__quoteP = schedulePortalFetchQuote(' + JSON.stringify(p) + ');\n',
      quoteCtx,
    );
    // Intercept: re-run with instrumented fetchJson
    quoteCtx.schedulePortalFetchJson = function(url, opts) {
      quoteBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, status: 200, data: { success: true, total_cents: 100 } });
    };
    vm.runInContext('this.__quoteP2 = schedulePortalFetchQuote(' + JSON.stringify(p) + ');', quoteCtx);
  } catch (err) {
    console.error('  (quote VM error)', err.message);
    return false;
  }
  assert(
    'quote request receives exact rental quantities',
    quoteBody
      && Array.isArray(quoteBody.rentals)
      && quoteBody.rentals.some((r) => r.offering_key === 'board_rental' && r.quantity === 3)
      && quoteBody.rentals.some((r) => r.offering_key === 'wetsuit_rental' && r.quantity === 2)
      && quoteBody.guest_name === 'Ada Lovelace'
      && quoteBody.components
      && quoteBody.components.surfboard
      && quoteBody.components.surfboard.quantity === 3
      && quoteBody.components.wetsuit
      && quoteBody.components.wetsuit.quantity === 2,
    JSON.stringify(quoteBody),
  );
  return invalidOk !== false;
})();
assert('payload VM contract executed', guestPayloadContractOk);

console.log('\n[F] Quote path still omits client amounts; guest_name regression');
assert(
  'schedulePortalFetchQuote still forwards guest_name',
  /function schedulePortalFetchQuote\([\s\S]*?guest_name:\s*createPayload\.guest_name/.test(portalSrc),
);

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-schedule-rental-availability — FAILED');
  process.exit(1);
}
console.log('verify:sunset-schedule-rental-availability — ALL CHECKS PASSED');
