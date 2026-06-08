/**
 * Phase 26h — Verifier for Services tab polish + service_date scheduling writes.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-services-schedule-writes
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCHEDULE = path.join(__dirname, 'lib', 'staff-booking-services-schedule.js');
const ROUTES = path.join(__dirname, 'lib', 'staff-booking-services-routes.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26h-SERVICES-SCHEDULE-WRITES.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-services-schedule-writes';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
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

console.log('\nverify-luna-agent-phase26-services-schedule-writes.js  (Phase 26h)\n');

try {
  execSync(`node --check "${SCHEDULE}"`, { stdio: 'pipe' });
  execSync(`node --check "${ROUTES}"`, { stdio: 'pipe' });
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'schedule + routes + staff-query-api pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

const scheduleSrc = readOrEmpty(SCHEDULE);
const routesSrc = readOrEmpty(ROUTES);
const apiSrc = readOrEmpty(API);
const servicesUiSlice = (apiSrc.match(/function bcRenderServicesScheduleBody[\s\S]{0,4500}/) || [''])[0];

section('A. Schedule helper polish');

if (/packageSummaryHeadline|headline/.test(scheduleSrc) && /paid_requested_services/.test(scheduleSrc)) {
  pass('A1', 'package headline + paid/requested services summary');
} else fail('A1', 'summary fields missing');
if (/Uluwatu|Malibu|Waimea|No Package/.test(scheduleSrc)) {
  pass('A2', 'package display names without repeated Package label');
} else fail('A2', 'package labels');
if (/isServiceDateInStay/.test(scheduleSrc)) pass('A3', 'stay date validation helper');
else fail('A3', 'isServiceDateInStay');
if (/formatPaidServiceSummaryLine/.test(scheduleSrc)) pass('A4', 'paid service summary lines');
else fail('A4', 'summary line formatter');

section('B. PATCH route');

if (/BOOKING_SERVICE_DATE_RE/.test(routesSrc) && /handlePatchBookingServiceDate/.test(routesSrc)) {
  pass('B1', 'PATCH service_date route handler');
} else fail('B1', 'PATCH handler');
if (/dispatchBookingServiceDateRoute/.test(routesSrc)) pass('B2', 'PATCH dispatch');
else fail('B2', 'PATCH dispatch');
if (/UPDATE booking_service_records[\s\S]{0,120}service_date/i.test(routesSrc)) {
  pass('B3', 'UPDATE only service_date');
} else fail('B3', 'service_date UPDATE');
if (!/INSERT INTO|DELETE FROM|\bstripe\b/i.test(routesSrc)) {
  pass('B4', 'PATCH slice avoids payment/insert/delete');
} else fail('B4', 'unexpected writes in PATCH slice');
if (/client_slug is required/.test(routesSrc) && /isServiceDateInStay/.test(routesSrc)) {
  pass('B5', 'validates client_slug + stay date');
} else fail('B5', 'validation');
if (/SERVICE_RECORD_BY_ID_SQL/.test(routesSrc) && /booking_id/.test(routesSrc)) {
  pass('B6', 'validates booking + record ownership');
} else fail('B6', 'ownership check');
if (/no_payment_write:\s*true/.test(routesSrc)) pass('B7', 'no_payment_write flag on PATCH');
else fail('B7', 'no_payment_write');

section('C. staff-query-api wiring');

if (/BOOKING_SERVICE_DATE_RE/.test(apiSrc) && /dispatchBookingServiceDateRoute/.test(apiSrc)) {
  pass('C1', 'PATCH route wired in staff-query-api');
} else fail('C1', 'PATCH wiring');
if (/BOOKING_SERVICE_DATE_RE[\s\S]{0,800}BOOKING_SERVICES_RE/.test(apiSrc)) {
  pass('C2', 'PATCH route registered before GET services');
} else fail('C2', 'route order');
if (/requireAuth\(req, res, 'operator'\)[\s\S]{0,400}dispatchBookingServiceDateRoute/.test(apiSrc)) {
  pass('C3', 'operator auth on PATCH');
} else fail('C3', 'operator auth');

section('D. Services tab UI');

if (/bc-drawer-overview-card[\s\S]{0,80}bc-svc-summary|bc-svc-summary-card/.test(servicesUiSlice)) {
  pass('D1', 'Overview-like soft cards on Services tab');
} else fail('D1', 'overview cards');
if (/bc-svc-summary-headline|headline/.test(servicesUiSlice) && !/bc-svc-package-title/.test(servicesUiSlice)) {
  pass('D2', 'headline without repeated Package title');
} else fail('D2', 'headline');
if (/Paid \/ requested services|bc-svc-paid/.test(servicesUiSlice)) {
  pass('D3', 'paid/requested services near top');
} else fail('D3', 'paid list');
if (/Service schedule/.test(servicesUiSlice) && /bc-svc-schedule-section/.test(servicesUiSlice)) {
  pass('D4', 'schedule below paid summary');
} else fail('D4', 'schedule order');
if (/bc-svc-schedule-add-btn/.test(apiSrc)) pass('D5', 'date row + schedule buttons');
else fail('D5', '+ buttons');
if (/No unscheduled services to schedule/.test(apiSrc)) pass('D6', 'empty picker copy');
else fail('D6', 'empty picker');
if (/Unscheduled services/.test(servicesUiSlice)) pass('D7', 'unscheduled section');
else fail('D7', 'unscheduled');
if (/bcRenderAddServicePanelHtml/.test(apiSrc) && /Add or remove/.test(apiSrc)) {
  pass('D8', 'existing add/remove controls');
} else fail('D8', 'add/remove');

section('E. UI PATCH interaction');

if (/method:\s*'PATCH'/.test(apiSrc) && /\/services\/[\s\S]{0,80}\/date/.test(apiSrc)) {
  pass('E1', 'UI calls PATCH date route');
} else fail('E1', 'PATCH fetch');
if (/bcInitServicesSchedulePickers|bcRefreshServicesSchedule/.test(apiSrc)) {
  pass('E2', 'schedule refresh without full drawer reload');
} else fail('E2', 'tab-only refresh');
if (/bcRenderServicesScheduleBody\(res\.data\)/.test(apiSrc)) {
  pass('E3', 're-render Services tab body after schedule');
} else fail('E3', 'post-PATCH render');

section('F. Helper unit checks');

const {
  buildStayDates,
  buildBookingServicesSchedule,
  packageSummaryHeadline,
  isServiceDateInStay,
} = require('./lib/staff-booking-services-schedule');

if (packageSummaryHeadline('malibu', 7) === 'Malibu · 7 nights') {
  pass('F1', 'packageSummaryHeadline');
} else fail('F1', 'packageSummaryHeadline');
if (packageSummaryHeadline(null, 3) === 'No Package · 3 nights') {
  pass('F2', 'No Package headline');
} else fail('F2', 'No Package');

const sched = buildBookingServicesSchedule({
  booking: { check_in: '2026-06-08', check_out: '2026-06-11', package_code: 'uluwatu' },
  serviceRecords: [
    { id: 'a', service_type: 'yoga', service_date: null, quantity: 3, amount_due_cents: 4500, payment_status: 'requested' },
    { id: 'b', service_type: 'wetsuit', service_date: '2026-06-08', quantity: 1, amount_due_cents: 500, payment_status: 'paid' },
  ],
});
if (sched.package_summary.headline === 'Uluwatu · 3 nights') pass('F3', 'schedule headline in payload');
else fail('F3', 'schedule headline');
if (sched.paid_requested_services.length === 2) pass('F4', 'paid_requested_services count');
else fail('F4', 'paid list count');

if (isServiceDateInStay('2026-06-08', '2026-06-08', '2026-06-11') &&
    isServiceDateInStay('2026-06-10', '2026-06-08', '2026-06-11') &&
    !isServiceDateInStay('2026-06-11', '2026-06-08', '2026-06-11')) {
  pass('F5', 'isServiceDateInStay half-open stay');
} else fail('F5', 'isServiceDateInStay');

section('G. Docs + npm');

const doc = readOrEmpty(DOC);
if (/service_date|PATCH/i.test(doc) && /Paid \/ requested/i.test(doc)) pass('G1', 'doc covers summary + PATCH');
else fail('G1', 'doc content');
if (/no payment writes|No payment writes/i.test(doc) && /Deferred|deferred/i.test(doc)) {
  pass('G2', 'doc safety + deferred editor');
} else fail('G2', 'doc safety');

const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('G3', 'npm script registered');
else fail('G3', 'npm script');

section('H. Safety');

if (!routesSrc.match(/\bstripe\b/i) && !scheduleSrc.match(/\bstripe\b/i)) {
  pass('H1', 'no Stripe in services slice');
} else fail('H1', 'Stripe touched');
if (!/whatsapp|n8n|guest_message|luna-meta/i.test(routesSrc + scheduleSrc)) {
  pass('H2', 'no WhatsApp/Meta/n8n in slice');
} else fail('H2', 'messaging touched');
if (!/payment_intent|INSERT INTO payments/.test(routesSrc)) {
  pass('H3', 'PATCH does not write payments');
} else fail('H3', 'payment writes');

for (const f of GUEST_UNTOUCHED) {
  const base = path.basename(f);
  const src = readOrEmpty(f);
  if (!/bc-svc-schedule|staff-booking-services|service_date/.test(src)) pass(`H.${base}`, `${base} unchanged`);
  else fail(`H.${base}`, `${base} touched`);
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
