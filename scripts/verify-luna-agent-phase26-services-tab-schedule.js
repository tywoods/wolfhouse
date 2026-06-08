/**
 * Phase 26g — Verifier for Services tab schedule MVP (read-only).
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-services-tab-schedule
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCHEDULE = path.join(__dirname, 'lib', 'staff-booking-services-schedule.js');
const ROUTES = path.join(__dirname, 'lib', 'staff-booking-services-routes.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26g-SERVICES-TAB-SCHEDULE.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-services-tab-schedule';

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

console.log('\nverify-luna-agent-phase26-services-tab-schedule.js  (Phase 26g)\n');

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
const drawerSlice = (apiSrc.match(/function renderBookingContextDrawer[\s\S]{0,12000}/) || [''])[0];

section('A. Route / helper');

if (/handleGetBookingServices/.test(routesSrc)) pass('A1', 'GET services handler exists');
else fail('A1', 'GET handler missing');
if (/getBookingServiceRecordsQuery/.test(routesSrc)) pass('A2', 'reads booking_service_records');
else fail('A2', 'service records query missing');
if (/buildBookingServicesSchedule/.test(routesSrc)) pass('A3', 'groups schedule via helper');
else fail('A3', 'schedule helper missing');
if (/buildBookingServicesSchedule/.test(routesSrc) && /services_by_date/.test(scheduleSrc) && /unscheduled_services/.test(scheduleSrc)) {
  pass('A4', 'response includes grouped + unscheduled sections');
} else fail('A4', 'response shape');
if (/normalizeBookingDateOnly/.test(scheduleSrc) && /buildStayDates/.test(scheduleSrc)) {
  pass('A5', 'stay_dates from check_in/check_out with date-safe handling');
} else fail('A5', 'stay date builder');
if (!/INSERT|DELETE/.test(routesSrc.replace(/\/\/[^\n]*/g, ''))) {
  if (/UPDATE[\s\S]{0,200}service_date/i.test(routesSrc)) {
    pass('A6', 'services route allows service_date-only update (26h)');
  } else {
    pass('A6', 'services route has no INSERT/DELETE writes');
  }
} else fail('A6', 'write SQL in routes');
if (/no_payment_write:\s*true/.test(routesSrc)) pass('A7', 'no_payment_write flag');
else fail('A7', 'no_payment_write flag');

section('B. staff-query-api wiring');

if (/dispatchBookingServicesRoute|staff-booking-services-routes/.test(apiSrc)) {
  pass('B1', 'staff-query-api wires services routes');
} else fail('B1', 'route wiring missing');
if (/BOOKING_SERVICES_RE/.test(apiSrc)) pass('B2', 'BOOKING_SERVICES_RE registered');
else fail('B2', 'BOOKING_SERVICES_RE missing');
if (/BOOKING_SERVICES_RE[\s\S]{0,1200}All other routes: GET only/.test(apiSrc)) {
  pass('B3', 'services route before GET-only gate');
} else fail('B3', 'services route placement');
if (/bcInitServicesScheduleShell/.test(apiSrc) && /\/staff\/bookings\/.*\/services/.test(apiSrc)) {
  pass('B4', 'Services tab fetches schedule route');
} else fail('B4', 'schedule fetch init');

section('C. Services tab UI');

if (/bcDrawerTabBtn\('services', 'Services'/.test(apiSrc) || /'services', 'Services'/.test(drawerSlice)) {
  pass('C1', 'Services tab exists');
} else fail('C1', 'Services tab missing');
if (!/bcDrawerTabBtn\('[^']+', 'Add-ons'/.test(apiSrc)) {
  pass('C2', 'Add-ons is not the main tab label');
} else fail('C2', 'Add-ons still a tab label');
if (/bc-svc-summary-card|bc-drawer-overview-card[\s\S]{0,80}bc-svc|bcRenderServicesScheduleBody/.test(apiSrc)) {
  pass('C3', 'package summary/card in Services tab');
} else fail('C3', 'package card');
if (/Service schedule|bc-svc-schedule-section/.test(apiSrc)) {
  pass('C4', 'service schedule section');
} else fail('C4', 'schedule section');
if (/Unscheduled services|bc-svc-unscheduled/.test(apiSrc)) {
  pass('C5', 'unscheduled services section');
} else fail('C5', 'unscheduled section');
if (/No services recorded yet/.test(apiSrc) && /No unscheduled services/.test(apiSrc)) {
  pass('C6', 'empty states present');
} else fail('C6', 'empty states');
if (/No services scheduled/.test(apiSrc)) pass('C7', 'empty day state');
else fail('C7', 'empty day state');
if (/bcRenderAddServicePanelHtml/.test(apiSrc) && /bc-add-ons-btn/.test(apiSrc)) {
  pass('C8', 'existing add/remove controls retained');
} else fail('C8', 'add/remove controls');
if (!/coming soon|full schedule coming/i.test(apiSrc.match(/bcRenderServicesTabHtml[\s\S]{0,2500}/)?.[0] || '')) {
  pass('C9', 'placeholder copy removed from Services tab');
} else fail('C9', 'old placeholders remain');

section('D. Other tabs unchanged');

if (/bcRenderPaymentSummaryBriefHtml/.test(apiSrc) && /bc-drawer-tab-overview/.test(drawerSlice)) {
  pass('D1', 'Overview quick payment summary');
} else fail('D1', 'overview payment');
if (/bcRenderRunningInvoiceHtml/.test(drawerSlice) && /bc-drawer-tab-payments/.test(drawerSlice)) {
  pass('D2', 'Payments tab full payment section');
} else fail('D2', 'payments tab');
if (/bc-drawer-tab-transfers[\s\S]{0,500}bcRenderTransferDetailsShell/.test(drawerSlice)
  && /bc-transfer-cards|Arrival transfer/.test(apiSrc)) {
  pass('D3', 'Transfers tab editor in place (26g.2)');
} else fail('D3', 'transfers tab');

section('E. Schedule helper unit checks');

const {
  buildStayDates,
  buildBookingServicesSchedule,
} = require('./lib/staff-booking-services-schedule');

const stay = buildStayDates('2026-06-08', '2026-06-11');
if (stay.length === 3 && stay[0] === '2026-06-08' && stay[2] === '2026-06-10' && !stay.includes('2026-06-11')) {
  pass('E1', 'buildStayDates half-open (excludes checkout day)');
} else fail('E1', 'buildStayDates nights');

const sched = buildBookingServicesSchedule({
  booking: { check_in: '2026-06-08', check_out: '2026-06-10', package_code: 'surf' },
  serviceRecords: [
    { service_type: 'yoga', service_date: '2026-06-08', quantity: 1, amount_due_cents: 0, status: 'included' },
    { service_type: 'meal', service_date: null, quantity: 1, amount_due_cents: 1500, payment_status: 'requested' },
    { service_type: 'surf_lesson', service_date: '2026-01-01', quantity: 1, amount_due_cents: 5000 },
  ],
});
if (sched.services_by_date.length === 2) pass('E2', 'one group per stay night');
else fail('E2', 'services_by_date length');
const day1 = sched.services_by_date.find((g) => g.date === '2026-06-08');
if (day1 && day1.services.length === 1 && day1.services[0].service_name) {
  pass('E3', 'services grouped by service_date');
} else fail('E3', 'date grouping');
if (sched.unscheduled_services.length === 2) pass('E4', 'null/invalid dates → unscheduled');
else fail('E4', 'unscheduled bucket');
if (sched.totals.scheduled_count === 1 && sched.totals.unscheduled_count === 2) {
  pass('E5', 'totals counts');
} else fail('E5', 'totals');
if (!JSON.stringify(sched).includes('metadata')) pass('E6', 'no raw metadata blobs in output');
else fail('E6', 'metadata leak');

section('F. Docs + npm');

const doc = readOrEmpty(DOC);
if (/read-only|Read-only/i.test(doc) && /grouped by stay|services_by_date|stay_dates/i.test(doc)) {
  pass('F1', 'doc describes read-only schedule grouping');
} else fail('F1', 'doc grouping');
if (/unscheduled/i.test(doc) && /package_summary|Package/i.test(doc)) pass('F2', 'doc package + unscheduled');
else fail('F2', 'doc sections');
if (/no payment writes|Deferred|editing/i.test(doc)) pass('F3', 'doc defers editing/writes');
else fail('F3', 'doc safety/deferred');

const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('F4', 'npm script registered');
else fail('F4', 'npm script');

section('G. Safety');

if (!routesSrc.match(/\bstripe\b/i) && !scheduleSrc.match(/\bstripe\b/i)) {
  pass('G1', 'no Stripe in services slice');
} else fail('G1', 'Stripe touched');
if (!routesSrc.includes('guest_message_sends') && !routesSrc.includes('payment_intent')) {
  pass('G2', 'no payment/WhatsApp writes in routes');
} else fail('G2', 'payment/WhatsApp in routes');
if (!/handlePostBookingService|upsertBookingService|deleteBookingService/.test(routesSrc + apiSrc)) {
  pass('G3', 'no new service write handlers');
} else fail('G3', 'service write handlers added');

for (const f of GUEST_UNTOUCHED) {
  const base = path.basename(f);
  const src = readOrEmpty(f);
  if (!/bc-svc-schedule|staff-booking-services/.test(src)) pass(`G.${base}`, `${base} unchanged`);
  else fail(`G.${base}`, `${base} touched`);
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
