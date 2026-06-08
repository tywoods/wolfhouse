/**
 * Phase 26h.9 — Service add scheduling modes + totals verifier.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-service-add-schedule-modes
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCHEDULE = path.join(__dirname, 'lib', 'staff-booking-services-schedule.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26h-9-SERVICE-ADD-SCHEDULE-MODES.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-service-add-schedule-modes';

const UPSTREAM = [
  'verify:luna-agent-phase26-inplace-actions-transfer-final-polish',
  'verify:luna-agent-phase26-service-pebbles-transfer-payment-polish',
  'verify:luna-agent-phase26-services-unschedule-drawer-cleanup',
  'verify:luna-agent-phase26-services-schedule-writes',
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

console.log('\nverify-luna-agent-phase26-service-add-schedule-modes.js  (Phase 26h.9)\n');

try {
  execSync(`node --check "${SCHEDULE}"`, { stdio: 'pipe' });
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'schedule + staff-query-api pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

const scheduleSrc = readOrEmpty(SCHEDULE);
const apiSrc = readOrEmpty(API);
const doc = readOrEmpty(DOC);
const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
const summarySlice = (apiSrc.match(/function bcRenderServicesSummarySection[\s\S]{0,1400}/) || [''])[0];
const addPanelSlice = (apiSrc.match(/function bcRenderAddServicePanelHtml[\s\S]{0,2200}/) || [''])[0];
const addSaveSlice = (apiSrc.match(/function bcRunAddServiceSave[\s\S]{0,2200}/) || [''])[0];
const addSvcSlice = (apiSrc.match(/async function handleBookingAddService[\s\S]{0,12000}/) || [''])[0];
const schedModeSlice = (apiSrc.match(/function bcAddServiceApplyScheduleMode[\s\S]{0,900}/) || [''])[0];

section('A. Paid / Requested services total');

if (/bc-svc-paid-sep/.test(summarySlice) && /Total services/.test(summarySlice)) {
  pass('A1', 'separator + Total services line');
} else fail('A1', 'total line UI');
if (/total_services_cents/.test(scheduleSrc) && /computeServicesTotalCents/.test(scheduleSrc)) {
  pass('A2', 'total from service records only in schedule builder');
} else fail('A2', 'total_services_cents');
if (!/accommodation|package prorate|total_amount_cents/.test(summarySlice)) {
  pass('A3', 'summary total slice excludes package/accommodation fields');
} else fail('A3', 'package mixed into total UI');

section('B. Service Date label + scheduling links');

if (!/Add-on date/.test(addPanelSlice) && /Service Date/.test(addPanelSlice)) {
  pass('B1', 'Service Date label; Add-on date gone from panel');
} else fail('B1', 'Service Date label');
if (/Span Across Booking/.test(apiSrc) && /Schedule Later/.test(addPanelSlice + apiSrc)) {
  pass('B2', 'scheduling mode links present');
} else fail('B2', 'mode links');
if (/Start Date/.test(schedModeSlice) && /span_across_booking/.test(schedModeSlice)) {
  pass('B3', 'Span mode changes label to Start Date');
} else fail('B3', 'Start Date label on span');
if (/schedule_later/.test(schedModeSlice) && /display\s*=\s*'none'/.test(schedModeSlice)) {
  pass('B4', 'Schedule Later hides date field');
} else fail('B4', 'Schedule Later hides date');

section('C. Add service API scheduling modes');

if (/schedule_mode/.test(addSaveSlice) && /schedule_mode/.test(addSvcSlice)) {
  pass('C1', 'UI + API pass schedule_mode');
} else fail('C1', 'schedule_mode wiring');
if (/schedule_later/.test(addSvcSlice) && /fill\(null\)/.test(addSvcSlice)) {
  pass('C2', 'Schedule Later creates null service_date rows');
} else fail('C2', 'null dates for schedule later');
if (/span_across_booking/.test(addSvcSlice) && /distributeSpanScheduleDates/.test(addSvcSlice)) {
  pass('C3', 'Span mode uses distributeSpanScheduleDates');
} else fail('C3', 'span distribution helper');
if (/for \(let u = 0; u < unitQty/.test(addSvcSlice) && /unitDates\[u\]/.test(addSvcSlice)) {
  pass('C4', 'quantity >1 still creates unit rows with per-unit dates');
} else fail('C4', 'unit rows');

section('D. Span distribution rules');

const {
  distributeSpanScheduleDates,
  serviceColorClass,
  computeServicesTotalCents,
  buildPaidRequestedSummaryLines,
} = require('./lib/staff-booking-services-schedule');

const span10 = distributeSpanScheduleDates({
  quantity: 10,
  guestCount: 2,
  checkIn: '2026-06-01',
  checkOut: '2026-06-06',
  startDate: '2026-06-01',
});
if (span10.dates && span10.dates.length === 10) {
  const counts = {};
  span10.dates.forEach((d) => { counts[d] = (counts[d] || 0) + 1; });
  const perDay = Object.values(counts);
  if (perDay.length === 5 && perDay.every((n) => n === 2)) {
    pass('D1', '2 guests × 5 days × 10 wetsuits → 2 per day');
  } else fail('D1', `unexpected per-day counts: ${JSON.stringify(counts)}`);
} else fail('D1', 'span 10 failed');

const span3yoga = distributeSpanScheduleDates({
  quantity: 3,
  guestCount: 1,
  checkIn: '2026-06-01',
  checkOut: '2026-06-04',
  startDate: '2026-06-01',
});
if (span3yoga.dates && span3yoga.dates.length === 3 &&
    new Set(span3yoga.dates).size === 3) {
  pass('D2', '3 yoga / 1 guest / 3 days → one per day');
} else fail('D2', '3 yoga distribution');

const span2meals = distributeSpanScheduleDates({
  quantity: 2,
  guestCount: 1,
  checkIn: '2026-06-01',
  checkOut: '2026-06-06',
  startDate: '2026-06-01',
});
if (span2meals.dates && span2meals.dates.length === 2 &&
    span2meals.dates[0] === '2026-06-01' && span2meals.dates[1] === '2026-06-02') {
  pass('D3', '2 meals / 5 days → first two days');
} else fail('D3', '2 meals distribution');

const spanOverflow = distributeSpanScheduleDates({
  quantity: 11,
  guestCount: 2,
  checkIn: '2026-06-01',
  checkOut: '2026-06-06',
  startDate: '2026-06-01',
});
if (spanOverflow.error && /Not enough stay dates/.test(spanOverflow.error)) {
  pass('D4', 'overflow blocked with safe error');
} else fail('D4', 'overflow behavior');

section('E. Naming + colors');

const entryRowSlice = (apiSrc.match(/function bcAddServiceEntryRowHtml[\s\S]{0,1200}/) || [''])[0];
if (/meals: 'Meal'/.test(scheduleSrc) && (/>Meal</.test(addPanelSlice) || />Meal</.test(entryRowSlice))) {
  pass('E1', 'Meal singular visible label');
} else fail('E1', 'Meal label');
if (serviceColorClass('soft_board', 'Soft board') === 'bc-svc-color-softboard') {
  pass('E2', 'Soft board uses teal class');
} else fail('E2', 'softboard teal');
if (serviceColorClass('hard_board', 'Hard board') === 'bc-svc-color-board') {
  pass('E3', 'Hard board remains blue');
} else fail('E3', 'hard board blue');
if (serviceColorClass('yoga', 'Yoga') === 'bc-svc-color-yoga' &&
    serviceColorClass('wetsuit', 'Wetsuit') === 'bc-svc-color-wetsuit' &&
    serviceColorClass('meals', 'Meal') === 'bc-svc-color-meal' &&
    serviceColorClass('surf_lesson', 'Surf lesson') === 'bc-svc-color-lesson') {
  pass('E4', 'yoga/wetsuit/meal/lesson colors retained');
} else fail('E4', 'other colors');
if (/bc-svc-color-softboard/.test(apiSrc)) pass('E5', 'teal CSS class in UI');
else fail('E5', 'teal CSS');

section('F. Tab preservation + safety');

if (/bcRefreshServicesTabAfterMutation/.test(addSaveSlice) && !/loadBlockDetail/.test(addSaveSlice)) {
  pass('F1', 'add service stays on Services tab');
} else fail('F1', 'tab preservation');
if (!/INSERT INTO payments/.test(addSvcSlice)) pass('F2', 'no payment rows from add service');
else fail('F2', 'payment insert');
if (!/stripe\.|whatsapp|n8n|luna-meta/i.test(addSvcSlice.match(/schedule_mode[\s\S]{0,3000}/)?.[0] || '')) {
  pass('F3', 'no Stripe/WhatsApp in add-service slice');
} else fail('F3', 'messaging/stripe touched');

const total = computeServicesTotalCents([
  { total_price_cents: 500 },
  { total_price_cents: 4500 },
]);
if (total === 5000) pass('F4', 'total cents sums service rows');
else fail('F4', 'total cents math');

section('G. Docs + npm');

if (/Total services/.test(doc) && /Span Across Booking/.test(doc) && /Schedule Later/.test(doc)) {
  pass('G1', 'doc covers totals + modes');
} else fail('G1', 'doc content');
if (/Meal/.test(doc) && /teal|softboard/i.test(doc)) pass('G2', 'doc Meal + softboard');
else fail('G2', 'doc polish');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('G3', 'npm script registered');
else fail('G3', 'npm script');

section('H. Upstream verifiers');

for (const up of UPSTREAM) {
  try {
    execSync(`npm run ${up}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass(`H-${up}`, `${up} PASS`);
  } catch (e) {
    const out = String(e.stdout || e.stderr || e.message).slice(0, 240);
    fail(`H-${up}`, `${up} FAIL: ${out}`);
  }
}

console.log(`\n── Summary ──`);
console.log(`  PASS: ${passes}`);
console.log(`  FAIL: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
