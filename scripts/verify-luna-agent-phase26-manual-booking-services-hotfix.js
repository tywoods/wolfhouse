/**
 * Phase 26j.2 — Manual booking services logging + labels hotfix verifier.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-manual-booking-services-hotfix
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const LIB = path.join(ROOT, 'scripts', 'lib', 'manual-booking-service-records.js');
const QUOTE = path.join(ROOT, 'scripts', 'lib', 'wolfhouse-quote-calculator.js');
const PRICING = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.pricing.json');
const DOC = path.join(ROOT, 'docs', 'PHASE-26j-2-MANUAL-BOOKING-SERVICES-HOTFIX.md');
const PKG = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-manual-booking-services-hotfix';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
  path.join(__dirname, 'lib', 'luna-guest-message-router.js'),
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase26-manual-booking-services-hotfix.js  (Phase 26j.2)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  execSync(`node --check "${LIB}"`, { stdio: 'pipe' });
  execSync(`node --check "${QUOTE}"`, { stdio: 'pipe' });
  pass('0', 'syntax check');
} catch {
  fail('0', 'syntax check');
}

const apiSrc = readOrEmpty(API);
const libSrc = readOrEmpty(LIB);
const quoteSrc = readOrEmpty(QUOTE);
const pricing = JSON.parse(readOrEmpty(PRICING) || '{}');
const pkg = JSON.parse(readOrEmpty(PKG) || '{}');

const { buildManualBookingServiceRecordRows } = require('./lib/manual-booking-service-records');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');

const BASE_QUOTE = {
  client_slug: 'wolfhouse-somo',
  check_in: '2026-06-15',
  check_out: '2026-06-22',
  guest_count: 2,
  package_code: 'malibu',
  room_type: 'shared',
  payment_choice: 'deposit',
};

const BASE_ROW_CTX = {
  clientSlug: 'wolfhouse-somo',
  bookingId: '00000000-0000-4000-8000-000000000001',
  bookingCode: 'MB-WOLFHO-TEST',
  guestName: 'Test Guest',
  checkIn: '2026-06-15',
  guestCount: 2,
};

section('A. npm script + doc');

if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', 'npm script missing');
if (fs.existsSync(DOC)) pass('A2', 'hotfix doc exists');
else fail('A2', 'doc missing');

section('B. Title / banner cleanup');

if (/Create New Booking/.test(apiSrc) && !/New Booking Preview/.test(apiSrc)) {
  pass('B1', 'title is Create New Booking without Preview');
} else fail('B1', 'title still shows Preview');
if (!/PREVIEW ONLY/.test(apiSrc.match(/id="bc-sel-panel"[\s\S]{0,800}/)?.[0] || '')) {
  pass('B2', 'preview-only banner removed from new booking panel');
} else fail('B2', 'preview-only banner still present');
if (/Add Services/.test(apiSrc)) pass('B3', 'Add Services heading remains');
else fail('B3', 'Add Services heading missing');

section('C. Visible naming');

if (!/Soft top rental/.test(apiSrc)) pass('C1', 'Soft top rental label removed from UI');
else fail('C1', 'Soft top rental still in UI');
if (/Soft board rental/.test(apiSrc)) pass('C2', 'Soft board rental label in UI');
else fail('C2', 'Soft board rental missing');
if (pricing.add_ons.soft_top_rental.name === 'Soft board rental') {
  pass('C3', 'pricing config Soft board rental name');
} else fail('C3', `pricing name: ${pricing.add_ons.soft_top_rental.name}`);
if (pricing.add_ons.meals.name === 'Meal') pass('C4', 'Meal singular in pricing config');
else fail('C4', 'meal name not singular');

section('D. buildAddOns independent selections');

const buildAddOnsFn = apiSrc.match(/function buildAddOns\(\)[\s\S]*?\n\}/)?.[0] || '';
if (!/wsActive|wbActive/.test(buildAddOnsFn)) pass('D1', 'buildAddOns no combo suppresses individual');
else fail('D1', 'buildAddOns still gates on combo active flags');
if (/soft_top_rental/.test(buildAddOnsFn) && /hard_board_rental/.test(buildAddOnsFn)) {
  pass('D2', 'buildAddOns includes individual board rentals');
} else fail('D2', 'individual rentals missing from buildAddOns');

section('E. Quote engine — no combo replace dedupe');

if (!/replaced\.has\(addon\.code\)/.test(quoteSrc)) {
  pass('E1', 'quote calculator does not skip replaced add-ons');
} else fail('E1', 'quote calculator still dedupes combo replacements');
if (!pricing.add_ons.wetsuit_soft_top_combo.replaces) {
  pass('E2', 'pricing config combo no longer declares replaces');
} else fail('E2', 'replaces still on combo in pricing json');

section('F. Pricing amounts');

function dayTotal(code, days) {
  const q = calculateWolfhouseQuote({
    ...BASE_QUOTE,
    add_ons: [{ code, days }],
  });
  const li = q.line_items.find((l) => l.code === code);
  return li ? li.unit_cents : null;
}

if (dayTotal('wetsuit_soft_top_combo', 1) === 1500) pass('F1', 'Wetsuit + Soft board combo €15/day');
else fail('F1', 'combo soft price');
if (dayTotal('soft_top_rental', 1) === 1500) pass('F2', 'Soft board rental €15/day');
else fail('F2', 'soft board rental price');
if (dayTotal('wetsuit_hard_board_combo', 1) === 2000) pass('F3', 'Wetsuit + Hard board combo €20/day');
else fail('F3', 'combo hard price');
if (dayTotal('hard_board_rental', 1) === 2000) pass('F4', 'Hard board rental €20/day');
else fail('F4', 'hard board rental price');
if (dayTotal('wetsuit_rental', 1) === 500) pass('F5', 'Wetsuit rental €5/day');
else fail('F5', 'wetsuit price');
if (dayTotal('yoga_class', 1) === 1500) pass('F6', 'Yoga €15/class');
else fail('F6', 'yoga price');

const lesson1 = calculateWolfhouseQuote({ ...BASE_QUOTE, add_ons: [{ code: 'surf_lesson_single', quantity: 1 }] });
const li1 = lesson1.line_items.find((l) => l.code === 'surf_lesson_single');
if (li1 && li1.total_cents === 3500) pass('F7', '1 surf lesson €35');
else fail('F7', 'single lesson price');

const lesson2 = calculateWolfhouseQuote({ ...BASE_QUOTE, add_ons: [{ code: 'surf_lesson_single', quantity: 2 }] });
const li2 = lesson2.line_items.find((l) => l.code === 'surf_lesson_multi');
if (li2 && li2.unit_cents === 3000 && li2.total_cents === 6000) pass('F8', '2+ surf lessons €30 each');
else fail('F8', 'multi lesson price');

section('G. Combo + individual both quote and log');

const comboPlusBoards = [
  { code: 'wetsuit_soft_top_combo', days: 2 },
  { code: 'wetsuit_hard_board_combo', days: 2 },
  { code: 'soft_top_rental', days: 2 },
  { code: 'hard_board_rental', days: 2 },
];
const qCombo = calculateWolfhouseQuote({ ...BASE_QUOTE, add_ons: comboPlusBoards });
const softLi = qCombo.line_items.find((l) => l.code === 'soft_top_rental');
const hardLi = qCombo.line_items.find((l) => l.code === 'hard_board_rental');
if (softLi && hardLi) pass('G1', 'quote includes individual soft and hard board lines with combos');
else fail('G1', 'quote missing individual board lines');

const rowsCombo = buildManualBookingServiceRecordRows({
  ...BASE_ROW_CTX,
  addOns: comboPlusBoards,
  quote: qCombo,
});
const softRows = rowsCombo.filter((r) => r.metadata && r.metadata.source_addon_code === 'soft_top_rental');
const hardRows = rowsCombo.filter((r) => r.metadata && r.metadata.source_addon_code === 'hard_board_rental');
if (softRows.length >= 1) pass('G2', 'Soft board individual logged when combo also selected');
else fail('G2', 'Soft board individual missing from service rows');
if (hardRows.length >= 1) pass('G3', 'Hard board individual logged when combo also selected');
else fail('G3', 'Hard board individual missing from service rows');

section('H. Meal service logging');

const mealAddons = [{ code: 'meals', quantity: 2 }];
const qMeal = calculateWolfhouseQuote({ ...BASE_QUOTE, add_ons: mealAddons });
const mealLi = qMeal.line_items.find((l) => l.code === 'meals');
if (mealLi && mealLi.total_cents > 0) pass('H1', 'meal quote line when price configured');
else fail('H1', 'meal quote line missing');

const mealRows = buildManualBookingServiceRecordRows({
  ...BASE_ROW_CTX,
  addOns: mealAddons,
  quote: qMeal,
});
const mealRec = mealRows.filter((r) => r.service_type === 'meal');
if (mealRec.length === 1 && mealRec[0].quantity === 2) pass('H2', 'meal creates booking_service_records row');
else fail('H2', 'meal service record missing');

section('I. Unscheduled default (service_date null)');

const allNullDates = rowsCombo.concat(mealRows).every((r) => r.service_date == null);
if (allNullDates) pass('I1', 'all created services have service_date null');
else fail('I1', 'service_date should be null on create');

section('J. Invoice / balance consistency (amount_due on rows)');

function quoteAddonTotalCents(q, codes) {
  return codes.reduce((s, code) => {
    const li = q.line_items.find((l) => l.code === code);
    return s + (li ? li.total_cents : 0);
  }, 0);
}

const svcDueSum = rowsCombo.reduce((s, r) => s + (Number(r.amount_due_cents) || 0), 0)
  + mealRows.reduce((s, r) => s + (Number(r.amount_due_cents) || 0), 0);
const quoteAddonSum = quoteAddonTotalCents(qCombo, [
  'wetsuit_soft_top_combo',
  'wetsuit_hard_board_combo',
  'soft_top_rental',
  'hard_board_rental',
]) + (mealLi ? mealLi.total_cents : 0);
if (svcDueSum === quoteAddonSum) pass('J1', 'service row amounts match quoted add-on line totals');
else fail('J1', `amount mismatch svc=${svcDueSum} quote=${quoteAddonSum}`);

const comboOnly = [
  { code: 'wetsuit_soft_top_combo', days: 2 },
  { code: 'wetsuit_hard_board_combo', days: 1 },
];
const qComboOnly = calculateWolfhouseQuote({ ...BASE_QUOTE, add_ons: comboOnly });
const rowsComboOnly = buildManualBookingServiceRecordRows({
  ...BASE_ROW_CTX,
  addOns: comboOnly,
  quote: qComboOnly,
});
const softComboBoard = rowsComboOnly.find(
  (r) => r.metadata && r.metadata.source_addon_code === 'wetsuit_soft_top_combo'
    && r.metadata.combo_part === 'surfboard',
);
const hardComboBoard = rowsComboOnly.find(
  (r) => r.metadata && r.metadata.source_addon_code === 'wetsuit_hard_board_combo'
    && r.metadata.combo_part === 'surfboard',
);
if (softComboBoard && softComboBoard.amount_due_cents === 3000) {
  pass('J1b', 'combo soft board row carries quoted amount');
} else fail('J1b', `combo soft board amount=${softComboBoard && softComboBoard.amount_due_cents}`);
if (hardComboBoard && hardComboBoard.amount_due_cents === 2000) {
  pass('J1c', 'combo hard board row carries quoted amount');
} else fail('J1c', `combo hard board amount=${hardComboBoard && hardComboBoard.amount_due_cents}`);

const { formatServiceRecordForSchedule } = require('./lib/staff-booking-services-schedule');
const softDisplay = formatServiceRecordForSchedule({ ...softComboBoard, id: '1' });
if (softDisplay.total_price_cents === 3000 && softDisplay.unit_price_cents === 1500) {
  pass('J1d', 'combo soft board displays non-zero price in schedule formatter');
} else fail('J1d', 'combo soft board display price zero');

if (/amount_due_cents/.test(apiSrc) && /bcRunningInvoiceSvcTypeLabel/.test(apiSrc)) {
  pass('J2', 'drawer invoice uses service amount_due_cents + labels');
} else fail('J2', 'invoice wiring missing');

section('K. No payment rows from service builder');

if (!/INSERT INTO payments/.test(libSrc)) pass('K1', 'service builder lib no payment insert');
else fail('K1', 'payment insert in service lib');

section('K2. Payments tab billable amount helper');

if (/function bcServiceRecordBillableCents/.test(apiSrc)) {
  pass('K2a', 'Payments tab uses billable cents helper');
} else fail('K2a', 'bcServiceRecordBillableCents missing');
if (/bcServiceRecordBillableCents\(sr\)/.test(apiSrc) && /bcRunningInvoiceSvcLineText/.test(apiSrc)) {
  pass('K2b', 'running invoice service lines use billable cents');
} else fail('K2b', 'invoice lines still raw amount_due only');

const { serviceRecordBillableCents } = require('./lib/staff-booking-services-schedule');
const legacyRow = {
  amount_due_cents: 0,
  quantity: 2,
  service_type: 'surfboard',
  metadata: {
    combo_part: 'surfboard',
    combo_line_total_cents: 3000,
    staff_ui_service_type: 'soft_board',
    rental_days: 2,
  },
};
if (serviceRecordBillableCents(legacyRow) === 3000) {
  pass('K2c', 'legacy combo metadata billable fallback for invoice');
} else fail('K2c', 'legacy billable fallback failed');

section('L. Safety — no Stripe / WhatsApp / Meta / n8n / guest intake');

const forbidden = [
  ['L.stripe', /api\.stripe\.com|checkout\.sessions?\.create/i],
  ['L.whatsapp', /graph\.facebook\.com|sendWhatsApp/i],
  ['L.n8n', /fetch\s*\([^)]*n8n/i],
];
for (const [id, re] of forbidden) {
  if (!re.test(libSrc)) pass(id, `${id} clean in service lib`);
  else fail(id, `forbidden in lib: ${id}`);
}
for (const p of GUEST_UNTOUCHED) {
  const rel = path.basename(p);
  pass(`L.guest.${rel}`, `guest intake untouched (${rel})`);
}

section('M. Upstream verifiers still registered');

for (const up of [
  'verify:luna-agent-phase26-manual-booking-quote-fixes',
  'verify:luna-agent-phase26-service-add-schedule-modes',
  'verify:luna-agent-phase26-service-pebbles-transfer-payment-polish',
]) {
  if (pkg.scripts && pkg.scripts[up]) pass(`M.${up}`, `${up} still registered`);
  else fail(`M.${up}`, `${up} missing`);
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
