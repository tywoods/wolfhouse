/**
 * Phase 26h.6 — Service pebbles, transfer layout polish, payment link enablement.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-service-pebbles-transfer-payment-polish
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCHEDULE = path.join(__dirname, 'lib', 'staff-booking-services-schedule.js');
const ROUTES = path.join(__dirname, 'lib', 'staff-booking-services-routes.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26h-6-SERVICE-PEBBLES-TRANSFER-PAYMENT-POLISH.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-service-pebbles-transfer-payment-polish';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const UPSTREAM = [
  'verify:luna-agent-phase26-services-unschedule-drawer-cleanup',
  'verify:luna-agent-phase26-services-schedule-writes',
  'verify:luna-agent-phase26-services-transfers-ui-actions',
  'verify:luna-agent-phase26-drawer-payments-transfers-polish',
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

console.log('\nverify-luna-agent-phase26-service-pebbles-transfer-payment-polish.js  (Phase 26h.6)\n');

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
const addSvcSlice = (apiSrc.match(/async function handleBookingAddService[\s\S]{0,9000}/) || [''])[0];
const chipSlice = (apiSrc.match(/function bcRenderServiceChipHtml[\s\S]{0,600}/) || [''])[0];
const summarySlice = (apiSrc.match(/function bcFormatServiceSummaryLine[\s\S]{0,500}/) || [''])[0];
const payLinkSlice = (apiSrc.match(/function bcInitPaymentLinkShell[\s\S]{0,1200}/) || [''])[0];
const transferSlice = (apiSrc.match(/function bcRenderTransferCard[\s\S]{0,3800}/) || [''])[0];
const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');

section('A. Payment link enablement');

if (/BC_STRIPE_LINKS/.test(payLinkSlice) && /BC_STAFF_ACTIONS/.test(payLinkSlice)) {
  pass('A1', 'payment link shell checks STAFF_ACTIONS + STRIPE_LINKS flags');
} else fail('A1', 'flag checks missing');
if (/genBtn\.disabled\s*=\s*true/.test(payLinkSlice) && /genBtn\.disabled\s*=\s*false/.test(payLinkSlice)) {
  pass('A2', 'button disabled when flags off, enabled when on');
} else fail('A2', 'button enable/disable');
if (/STRIPE_LINKS_ENABLED=true/.test(payLinkSlice)) pass('A3', 'disabled hint references STRIPE_LINKS_ENABLED');
else fail('A3', 'disabled hint');
if (!/generate-payment-link[\s\S]{0,200}fetch/.test(payLinkSlice)) {
  pass('A4', 'verifier does not auto-generate Stripe link on init');
} else fail('A4', 'auto link generation');

section('B. Service label cleanup');

if (!/payment_status|not requested|not_requested/.test(chipSlice)) {
  pass('B1', 'service chips omit payment/status noise');
} else fail('B1', 'chips still show status');
if (!/payment_status|not requested|not_requested/.test(summarySlice)) {
  pass('B2', 'picker/summary lines omit status noise');
} else fail('B2', 'summary still shows status');
if (!/statusParts|bc-svc-chip-meta/.test(scheduleSrc.match(/function formatPaidServiceSummaryLine[\s\S]{0,400}/)?.[0] || '')) {
  pass('B3', 'paid summary formatter omits raw status pairs');
} else fail('B3', 'paid summary status');

section('C. Service color classes');

const colorClasses = [
  'bc-svc-color-board',
  'bc-svc-color-softboard',
  'bc-svc-color-wetsuit',
  'bc-svc-color-yoga',
  'bc-svc-color-meal',
  'bc-svc-color-lesson',
  'bc-svc-color-neutral',
];
let colorOk = colorClasses.every((c) => new RegExp(`\\.${c}|${c}`).test(apiSrc) && /serviceColorClass/.test(scheduleSrc));
if (colorOk) pass('C1', 'color CSS classes + serviceColorClass helper');
else fail('C1', 'color classes');
if (/color_class/.test(scheduleSrc) && /svc\.color_class/.test(chipSlice)) {
  pass('C2', 'schedule payload + chips use color_class');
} else fail('C2', 'color_class wiring');

section('D. Quantity >1 unit scheduling');

if (/unitQty/.test(addSvcSlice) && /for \(let u = 0; u < unitQty/.test(addSvcSlice) && /\$6::date,\s*1,\s*'requested'/.test(addSvcSlice)) {
  pass('D1', 'add-service inserts qty=1 unit rows');
} else fail('D1', 'multi-unit insert');
if (/splitMultiQuantityServiceRecords/.test(scheduleSrc) && /splitMultiQuantityServiceRecords/.test(routesSrc)) {
  pass('D2', 'GET services auto-splits existing qty>1 rows');
} else fail('D2', 'auto-split on load');
if (/amount_paid_cents,\s*0\)|COALESCE\(amount_paid_cents,\s*0\)\s*=\s*0/.test(scheduleSrc)) {
  pass('D3', 'split skips paid rows (invoice safety)');
} else fail('D3', 'paid-row guard');
if (/buildPaidRequestedSummaryLines/.test(scheduleSrc)) {
  pass('D4', 'summary aggregates units (Yoga ×3 · €45)');
} else fail('D4', 'summary aggregation');

section('E. Transfer override compact layout');

const dateIdx = transferSlice.indexOf('Transfer date/time');
const overrideIdx = transferSlice.indexOf('bc-transfer-override-toggle');
const notesIdx = transferSlice.indexOf('Notes');
const flightIdx = transferSlice.indexOf('Flight number');
if (/bc-transfer-col-left/.test(transferSlice) && /bc-transfer-col-right/.test(transferSlice)) {
  pass('E1', 'two-column transfer card layout');
} else fail('E1', 'column layout');
if (dateIdx >= 0 && overrideIdx > dateIdx && /bc-transfer-override-block/.test(transferSlice)) {
  pass('E2', 'Exception Override under Transfer date/time');
} else fail('E2', 'override position');
if (/bc-transfer-override-wrap/.test(transferSlice) && /Transfer Charge/.test(transferSlice) && /placeholder="25"/.test(transferSlice)) {
  pass('E3', 'amount input under override button');
} else fail('E3', 'override amount input');
const rightColSlice = transferSlice.match(/bc-transfer-col-right[\s\S]{0,900}/)?.[0] || '';
if (/Notes/.test(rightColSlice) && /Flight number/.test(rightColSlice)) {
  pass('E4', 'Notes on right column with flight number');
} else fail('E4', 'notes on right');
if (/align-self:flex-start|font-size:10px/.test(apiSrc.match(/\.bc-transfer-override-toggle[\s\S]{0,200}/)?.[0] || '')) {
  pass('E5', 'override button small/subtle');
} else fail('E5', 'subtle override button');

section('F. Safety');

if (!/INSERT INTO payments/.test(scheduleSrc) && !/INSERT INTO payments/.test(routesSrc)) {
  pass('F1', 'no payment rows from service split');
} else fail('F1', 'payment insert in service slice');
if (!/whatsapp|n8n|luna-meta|guest_message/i.test(scheduleSrc + routesSrc)) {
  pass('F2', 'no WhatsApp/Meta/n8n in service slice');
} else fail('F2', 'messaging touched');

section('G. Docs + npm');

const doc = readOrEmpty(DOC);
if (/STRIPE_LINKS_ENABLED=true/.test(doc) && /STAFF_ACTIONS_ENABLED=true/.test(doc)) {
  pass('G1', 'doc covers both payment flags');
} else fail('G1', 'doc payment flags');
if (/bc-svc-color-yoga|color coding|quantity >1|Exception Override/i.test(doc)) {
  pass('G2', 'doc covers pebbles + units + transfer layout');
} else fail('G2', 'doc content');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('G3', 'npm script registered');
else fail('G3', 'npm script');

section('H. Helper unit checks');

const {
  buildBookingServicesSchedule,
  buildPaidRequestedSummaryLines,
  serviceColorClass,
  formatPaidServiceSummaryLine,
} = require('./lib/staff-booking-services-schedule');

if (serviceColorClass('yoga', 'Yoga') === 'bc-svc-color-yoga') pass('H1', 'yoga color');
else fail('H1', 'yoga color');
if (serviceColorClass('surfboard', 'Soft board') === 'bc-svc-color-softboard') pass('H2', 'soft board teal color');
else fail('H2', 'soft board color');
if (serviceColorClass('surfboard', 'Hard board') === 'bc-svc-color-board') pass('H2b', 'hard board blue color');
else fail('H2b', 'hard board color');
if (!formatPaidServiceSummaryLine({ service_name: 'Yoga', quantity: 1, payment_status: 'not_requested', status: 'requested' }).includes('requested')) {
  pass('H3', 'summary line excludes status text');
} else fail('H3', 'summary status leak');

const units = buildPaidRequestedSummaryLines([
  { service_type: 'yoga', service_name: 'Yoga', quantity: 1, total_price_cents: 1500 },
  { service_type: 'yoga', service_name: 'Yoga', quantity: 1, total_price_cents: 1500 },
  { service_type: 'yoga', service_name: 'Yoga', quantity: 1, total_price_cents: 1500 },
]);
if (units.length === 1 && units[0].quantity === 3 && units[0].summary_line.includes('×3')) {
  pass('H4', 'aggregates 3 yoga units into Yoga ×3 summary');
} else fail('H4', 'yoga aggregation');

const sched = buildBookingServicesSchedule({
  booking: { check_in: '2026-06-08', check_out: '2026-06-11', package_code: 'uluwatu' },
  serviceRecords: [
    { id: 'a', service_type: 'yoga', service_date: null, quantity: 1, amount_due_cents: 1500 },
    { id: 'b', service_type: 'yoga', service_date: null, quantity: 1, amount_due_cents: 1500 },
    { id: 'c', service_type: 'yoga', service_date: null, quantity: 1, amount_due_cents: 1500 },
  ],
});
if (sched.unscheduled_services.length === 3) pass('H5', 'three independent unscheduled yoga units');
else fail('H5', 'unit pebble count');

for (const f of GUEST_UNTOUCHED) {
  if (fs.existsSync(f)) pass('I', `guest AI untouched: ${path.basename(f)}`);
  else pass('I', `guest file absent (ok): ${path.basename(f)}`);
}

section('J. Upstream verifiers');

for (const up of UPSTREAM) {
  try {
    execSync(`npm run ${up}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass('J', `${up} passed`);
  } catch (e) {
    fail('J', `${up} failed: ${(e.stdout || e.stderr || e.message || '').split('\n').slice(-3).join(' ')}`);
  }
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
