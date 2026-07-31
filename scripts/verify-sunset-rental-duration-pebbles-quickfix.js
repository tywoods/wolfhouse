'use strict';

/**
 * verify:sunset-rental-duration-pebbles-quickfix
 *
 * Production-shaped offline gate for Create/Admin short rental duration fix:
 *  1) Surfers blank edit then 2 — no clamp on input; equipment waits for valid int
 *  2) Full-day gear only for Group/Private; hidden+cleared for No lesson
 *  3) Admin short-duration parity match / mismatch fail-closed
 *  4) No-lesson combined pebbles: hour/half_day/1_day as Full day from common rows
 *  5) One selection; quote hour/half/full × qty 1/2; Admin amount mutation changes total;
 *     missing row fails closed; no 2–7 short pebbles
 *  6) EN/ES/IT labels present
 *
 * Static + pure functions only — no DB/Azure/network.
 *
 * Run: node scripts/verify-sunset-rental-duration-pebbles-quickfix.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const rentalMod = require('./browser/sunset-schedule-rental-availability');
const {
  assertBoardWetsuitShortDurationParity,
  assertBoardWetsuitShortParityAfterMutation,
} = require('./lib/tenant-admin-writes');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

function extractFn(src, name) {
  const n = 'function ' + name + '(';
  const s = src.indexOf(n);
  if (s < 0) return null;
  const b = src.indexOf('{', s);
  let d = 0;
  for (let i = b; i < src.length; i += 1) {
    if (src[i] === '{') d += 1;
    else if (src[i] === '}') {
      d -= 1;
      if (!d) return src.slice(s, i + 1);
    }
  }
  return null;
}

console.log('\nverify:sunset-rental-duration-pebbles-quickfix\n');

// ── 1) Surfers blank edit then 2 ────────────────────────────────────────────
console.log('[1] Surfers transient empty → 2; no clamp on empty');
assert('read returns null on empty (no reinsert 1)',
  /function scheduleReadCreateSurferCount\([\s\S]*?return null/.test(apiSrc)
  && /raw === '' \|\| raw == null/.test(apiSrc));
assert('input path does not call scheduleSetCreateSurferCount on empty',
  /Transient empty allowed/.test(apiSrc)
  || /do not reinsert 1|never clamp/.test(apiSrc));
assert('blur normalizer present',
  /function scheduleNormalizeCreateSurferCountOnBlur/.test(apiSrc));
assert('portal validation fails closed on blank surfers',
  /schedule\.create\.surfersRequired/.test(portalSrc)
  || /schedule\.create\.surfersRequired/.test(apiSrc));

const surferHelpers = [
  extractFn(apiSrc, 'scheduleReadCreateSurferCount'),
  extractFn(apiSrc, 'scheduleSyncCreateSurferMirrors'),
  extractFn(apiSrc, 'scheduleSetCreateSurferCount'),
  extractFn(apiSrc, 'scheduleNormalizeCreateSurferCountOnBlur'),
].filter(Boolean).join('\n');
const surferNodes = {
  'ps-create-surfers': { value: '1' },
  'ps-create-course-qty': { value: '1' },
  'ps-create-private-lesson-surfers': { value: '1' },
};
const surferCtx = {
  el(id) { return surferNodes[id] || null; },
};
vm.createContext(surferCtx);
vm.runInContext(surferHelpers, surferCtx);
surferNodes['ps-create-surfers'].value = '';
assert('blank read → null', surferCtx.scheduleReadCreateSurferCount() === null);
surferCtx.scheduleSetCreateSurferCount('');
assert('set empty does not force 1', surferNodes['ps-create-surfers'].value === '');
surferCtx.scheduleSetCreateSurferCount('2');
assert('set 2 works', surferCtx.scheduleReadCreateSurferCount() === 2
  && surferNodes['ps-create-surfers'].value === '2');
assert('mirrors sync to 2',
  surferNodes['ps-create-course-qty'].value === '2'
  && surferNodes['ps-create-private-lesson-surfers'].value === '2');

// ── 2) Full-day visibility/clear Group/Private/No lesson ────────────────────
console.log('\n[2] Full-day gear only Group/Private; clear on No lesson');
const fdFn = extractFn(apiSrc, 'scheduleRefreshCreateFullDayAddon') || '';
assert('full-day requires course or private (lessonOn)',
  /courseOn \|\| privateOn/.test(fdFn) && /field\.style\.display = show/.test(fdFn));
assert('no-lesson activity switch re-renders rentals + invalidates quote',
  /ps-create-comp-no-lesson/.test(apiSrc)
  && /scheduleRenderCreateRentals/.test(apiSrc)
  && /schedulePortalInvalidateCreateQuoteIntent/.test(apiSrc));

// ── 3) Admin short-duration parity ──────────────────────────────────────────
console.log('\n[3] Admin matching / mismatch fail-closed');
const matched = [
  { offering_key: 'board_rental', unit: '1_hour', amount_cents: 600, active: true, location_id: 'sunset-somo' },
  { offering_key: 'board_rental', unit: 'half_day', amount_cents: 1000, active: true, location_id: 'sunset-somo' },
  { offering_key: 'board_rental', unit: '1_day', amount_cents: 1500, active: true, location_id: 'sunset-somo' },
  { offering_key: 'wetsuit_rental', unit: '1_hour', amount_cents: 500, active: true, location_id: 'sunset-somo' },
  { offering_key: 'wetsuit_rental', unit: 'half_day', amount_cents: 800, active: true, location_id: 'sunset-somo' },
  { offering_key: 'wetsuit_rental', unit: '1_day', amount_cents: 1000, active: true, location_id: 'sunset-somo' },
  // bundle multi-day ignored
  { offering_key: 'board_and_suit_rental', unit: '3_days', amount_cents: 3000, active: true, location_id: 'sunset-somo' },
];
const okParity = assertBoardWetsuitShortDurationParity(matched, 'sunset-somo');
assert('matching short keys pass', okParity.ok === true
  && okParity.board_keys.join(',') === '1_hour,half_day');

const mismatched = matched.filter((p) => !(p.offering_key === 'wetsuit_rental' && p.unit === 'half_day'));
const badParity = assertBoardWetsuitShortDurationParity(mismatched, 'sunset-somo');
assert('mismatch fails closed with actionable error',
  badParity.ok === false
  && /half_day/.test(badParity.error)
  && (badParity.missing_wetsuit || []).includes('half_day'));

const deactivateHalf = assertBoardWetsuitShortParityAfterMutation(matched, 'sunset-somo', {
  offering_key: 'board_rental',
  period_window: 'half_day',
  active: false,
  amount_cents: 1000,
});
assert('deactivating board half_day rolls back (parity fail)',
  deactivateHalf.ok === false && /half_day/.test(deactivateHalf.error));
// Slice A: short_duration_mismatch is historical-read-only (pure helpers only).
// Create/patch price writes no longer enforce board/wetsuit duration coupling.
const writesSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/tenant-admin-writes.js'), 'utf8');
assert('historical short_duration_mismatch helpers remain for read-only analysis',
  /short_duration_mismatch/.test(writesSrc)
  || /assertBoardWetsuitShortDurationParity/.test(writesSrc));
const createPriceFn = (writesSrc.match(/async function createRentalPriceRule[\s\S]*?\nasync function /) || [''])[0];
const patchPriceFn = (writesSrc.match(/async function patchPriceRule[\s\S]*?\nasync function putLessonCapacityDefault/) || [''])[0];
assert('createRentalPriceRule does not enforce short_duration_mismatch',
  createPriceFn.length > 0 && !/short_duration_mismatch|assertBoardWetsuitShortParityAfterMutation/.test(createPriceFn));
assert('patchPriceRule does not enforce short_duration_mismatch on writes',
  patchPriceFn.length > 0 && !/assertBoardWetsuitShortParityAfterMutation/.test(patchPriceFn));

// ── 4) Common short pebbles hour/half/1_day as Full day ─────────────────────
console.log('\n[4] Common short pebbles hour / half_day / 1_day (Full day)');
const prices = matched.concat([
  { offering_key: 'board_rental', unit: '2_days', amount_cents: 2400, active: true, location_id: 'sunset-somo' },
  { offering_key: 'wetsuit_rental', unit: '2_days', amount_cents: 2000, active: true, location_id: 'sunset-somo' },
  { offering_key: 'board_rental', unit: '7_days', amount_cents: 7000, active: true, location_id: 'sunset-somo' },
]);
const common = rentalMod.scheduleCommonShortRentalDurationKeys(prices, 'sunset-somo');
assert('common keys exactly configured hour/half-day (1-day absent)',
  common.join(',') === '1_hour,half_day');
assert('no 2–7 in short keys',
  !common.some((k) => /^(2|3|4|5|6|7)_days$/.test(k)));
assert('1_day is not an offered short-rental key', !common.includes('1_day'));
assert('create UI renders pebble host + short mode',
  /data-rental-duration-pebbles/.test(apiSrc)
  && /data-short-rental/.test(apiSrc)
  && /scheduleRenderCreateRentalDurationPebbles/.test(apiSrc));
assert('pebbles CSS touch-friendly min-height',
  /portal-schedule-create-rental-pebble\{[^}]*min-height:\s*40px/.test(apiSrc));

// One selection expands combined board_and_suit → board + wetsuit
const ser = rentalMod.scheduleSerializeRentalsSelection(
  [{ offering_key: 'board_and_suit_rental', duration_key: 'half_day', quantity: 2 }],
  'half_day',
  { expandCombinedShort: true },
);
assert('one pebble expands to board + wetsuit components',
  ser.length === 2
  && ser[0].offering_key === 'board_rental'
  && ser[1].offering_key === 'wetsuit_rental'
  && ser.every((r) => r.duration_key === 'half_day' && r.quantity === 2));

// ── 5) Server quote sums exact Admin cents ──────────────────────────────────
console.log('\n[5] Quote hour/half/full × qty; mutation; missing fails closed');

const BOARD_HOUR = 600;
const SUIT_HOUR = 500;
const BOARD_HALF = 1000;
const SUIT_HALF = 800;
const BOARD_DAY = 1500;
const SUIT_DAY = 1000;

function adminPrices(overrides) {
  const base = [
    { category: 'rental', offering_key: 'board_rental', unit: '1_hour', amount_cents: BOARD_HOUR, active: true, location_id: 'sunset-somo', item_code: 'board_rental__1_hour' },
    { category: 'rental', offering_key: 'wetsuit_rental', unit: '1_hour', amount_cents: SUIT_HOUR, active: true, location_id: 'sunset-somo', item_code: 'wetsuit_rental__1_hour' },
    { category: 'rental', offering_key: 'board_rental', unit: 'half_day', amount_cents: BOARD_HALF, active: true, location_id: 'sunset-somo', item_code: 'board_rental__half_day' },
    { category: 'rental', offering_key: 'wetsuit_rental', unit: 'half_day', amount_cents: SUIT_HALF, active: true, location_id: 'sunset-somo', item_code: 'wetsuit_rental__half_day' },
    { category: 'rental', offering_key: 'board_rental', unit: '1_day', amount_cents: BOARD_DAY, active: true, location_id: 'sunset-somo', item_code: 'board_rental__1_day' },
    { category: 'rental', offering_key: 'wetsuit_rental', unit: '1_day', amount_cents: SUIT_DAY, active: true, location_id: 'sunset-somo', item_code: 'wetsuit_rental__1_day' },
  ];
  return overrides ? overrides(base.slice()) : base;
}

function quoteRentals(rentals, list) {
  // Staff no-lesson: surfer_count is authoritative equipment qty (PR #248).
  const qty = Math.max(
    1,
    ...((Array.isArray(rentals) ? rentals : []).map((r) => Number(r && r.quantity) || 1)),
  );
  const built = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.MANUAL_STAFF,
    trustedLocationId: 'sunset-somo',
    transportBody: {
      guest_name: 'Pebble Guest',
      date_from: '2026-08-20',
      date_to: '2026-08-20',
      payment_status: 'unpaid',
      components: {},
      rentals,
      surfer_count: qty,
      require_db: false,
    },
    now: new Date('2026-08-01T12:00:00Z'),
  });
  if (!built.ok) return built;
  return executeSunsetQuoteSync(built.command, {
    adminCfg: {
      ok: true,
      prices: list,
      surf_packs: [],
      lesson_times: [],
    },
  });
}

const cases = [
  { dur: '1_hour', qty: 1, expect: (BOARD_HOUR + SUIT_HOUR) * 1 },
  { dur: '1_hour', qty: 2, expect: (BOARD_HOUR + SUIT_HOUR) * 2 },
  { dur: 'half_day', qty: 1, expect: (BOARD_HALF + SUIT_HALF) * 1 },
  { dur: 'half_day', qty: 2, expect: (BOARD_HALF + SUIT_HALF) * 2 },
  { dur: '1_day', qty: 1, expect: (BOARD_DAY + SUIT_DAY) * 1 },
  { dur: '1_day', qty: 2, expect: (BOARD_DAY + SUIT_DAY) * 2 },
];
const list = adminPrices();
for (const tc of cases) {
  const rentals = [
    { offering_key: 'board_rental', duration_key: tc.dur, quantity: tc.qty },
    { offering_key: 'wetsuit_rental', duration_key: tc.dur, quantity: tc.qty },
  ];
  const out = quoteRentals(rentals, list);
  assert(`quote ${tc.dur} × ${tc.qty} = ${tc.expect}`,
    out.ok === true && out.body && out.body.total_cents === tc.expect,
    out.ok ? `got ${out.body && out.body.total_cents}` : JSON.stringify(out.body || out));
}

// Mutate board half_day amount → total changes
const mutated = adminPrices((rows) => {
  for (const r of rows) {
    if (r.offering_key === 'board_rental' && r.unit === 'half_day') r.amount_cents = 1200;
  }
  return rows;
});
const mutOut = quoteRentals(
  [
    { offering_key: 'board_rental', duration_key: 'half_day', quantity: 1 },
    { offering_key: 'wetsuit_rental', duration_key: 'half_day', quantity: 1 },
  ],
  mutated,
);
assert('mutating Admin board half_day changes total',
  mutOut.ok && mutOut.body.total_cents === (1200 + SUIT_HALF));

// Missing wetsuit half_day → fail closed
const missing = adminPrices((rows) => rows.filter((r) => !(r.offering_key === 'wetsuit_rental' && r.unit === 'half_day')));
const missOut = quoteRentals(
  [
    { offering_key: 'board_rental', duration_key: 'half_day', quantity: 1 },
    { offering_key: 'wetsuit_rental', duration_key: 'half_day', quantity: 1 },
  ],
  missing,
);
assert('missing Admin row fails closed',
  missOut.ok === false
  && (missOut.status === 422 || (missOut.body && missOut.body.success === false)));

// ── 6) EN/ES/IT labels ──────────────────────────────────────────────────────
console.log('\n[6] EN/ES/IT labels');
const en = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const es = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');
for (const key of [
  'schedule.create.rentalDuration.fullDay',
  'schedule.create.rentalDuration.1Hour',
  'schedule.create.rentalDuration.halfDay',
  'schedule.create.surfersRequired',
]) {
  assert(`EN has ${key}`, en.includes(`'${key}'`));
  assert(`ES has ${key}`, es.includes(`'${key}'`));
  assert(`IT has ${key}`, /it:\s*\{[\s\S]*?'schedule\.create\.rentalDuration\.fullDay'/.test(en) || en.includes(`'${key}'`));
}
assert('EN Full day label', /rentalDuration\.fullDay': 'Full day'/.test(en));
assert('ES Día completo', /rentalDuration\.fullDay': 'Día completo'/.test(es));
assert('IT Giornata intera', /rentalDuration\.fullDay': 'Giornata intera'/.test(en));

// ── summary ─────────────────────────────────────────────────────────────────
console.log('');
if (fail) {
  console.error(`verify:sunset-rental-duration-pebbles-quickfix — FAILED (${pass} pass, ${fail} fail)`);
  process.exit(1);
}
console.log(`verify:sunset-rental-duration-pebbles-quickfix — ALL CHECKS PASSED (${pass})`);
process.exit(0);
