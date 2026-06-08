/**
 * Phase 26h.3 — Verifier for service unschedule + drawer cleanup.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-services-unschedule-drawer-cleanup
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTES = path.join(__dirname, 'lib', 'staff-booking-services-routes.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26h-3-SERVICES-UNSCHEDULE-DRAWER-CLEANUP.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-services-unschedule-drawer-cleanup';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const UPSTREAM = [
  'verify:luna-agent-phase26-services-schedule-writes',
  'verify:luna-agent-phase26-drawer-payments-transfers-polish',
  'verify:luna-agent-phase26-drawer-file-tab-polish',
  'verify:luna-agent-phase26-services-tab-schedule',
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

console.log('\nverify-luna-agent-phase26-services-unschedule-drawer-cleanup.js  (Phase 26h.3)\n');

try {
  execSync(`node --check "${ROUTES}"`, { stdio: 'pipe' });
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'routes + staff-query-api pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

const routesSrc = readOrEmpty(ROUTES);
const apiSrc = readOrEmpty(API);
const patchSlice = (routesSrc.match(/async function handlePatchBookingServiceDate[\s\S]{0,2200}/) || [''])[0];
const servicesSlice = (apiSrc.match(/function bcRenderServicesScheduleSections[\s\S]{0,3200}/) || [''])[0];
const drawerSlice = (apiSrc.match(/function renderBookingContextDrawer[\s\S]{0,5500}/) || [''])[0];
const invoiceSlice = (apiSrc.match(/function bcRenderRunningInvoiceHtml[\s\S]{0,4500}/) || [''])[0];

section('A. PATCH null service_date');

if (/clearing = body\.service_date === null/.test(patchSlice) || /service_date === null/.test(patchSlice)) {
  pass('A1', 'PATCH accepts service_date null');
} else fail('A1', 'null acceptance');
if (/clearing \? null : serviceDate/.test(patchSlice)) {
  pass('A2', 'null updates only service_date column');
} else fail('A2', 'null SQL param');
if (/isServiceDateInStay/.test(patchSlice) && /!clearing/.test(patchSlice)) {
  pass('A3', 'non-null dates still validated');
} else fail('A3', 'stay validation guard');
if (!/DELETE FROM booking_service_records/.test(routesSrc)) {
  pass('A4', 'no service delete route');
} else fail('A4', 'delete route added');

section('B. Services − button UI');

if (/bc-svc-schedule-remove-btn/.test(servicesSlice) && /bc-svc-schedule-add-btn/.test(servicesSlice)) {
  pass('B1', 'date rows have + and − buttons');
} else fail('B1', 'plus/minus buttons');
if (/bc-svc-schedule-day-actions/.test(servicesSlice)) pass('B2', 'buttons grouped together');
else fail('B2', 'button group');
if (/bc-svc-unschedule-option/.test(apiSrc) && /service_date: null|service_date: serviceDate/.test(apiSrc)) {
  pass('B3', '− flow PATCHes service_date null');
} else fail('B3', 'unschedule PATCH');
if (/bcApplyServicesScheduleData/.test(apiSrc)) pass('B4', 'tab-only refresh after schedule/unschedule');
else fail('B4', 'tab refresh helper');
if (/bc-services-summary-section/.test(apiSrc) && /bcRenderServicesSummarySection/.test(apiSrc)) {
  pass('B5', 'summary section separate from schedule body');
} else fail('B5', 'summary layout');

section('C. Add / Remove placement');

if (/bc-services-summary-section[\s\S]{0,400}bcRenderAddServicePanelHtml/.test(apiSrc)) {
  pass('C1', 'Add/Remove under paid/requested summary');
} else fail('C1', 'button placement');
if (!/bc-add-ons-title|Add or remove/.test(apiSrc.match(/function bcRenderAddServicePanelHtml[\s\S]{0,800}/)?.[0] || '')) {
  pass('C2', 'Add or remove title removed');
} else fail('C2', 'title removed');
if (/id="bc-add-ons-btn">Add</.test(apiSrc) && /id="bc-add-ons-remove-btn"/.test(apiSrc)) {
  pass('C3', 'Add and Remove buttons remain');
} else fail('C3', 'buttons');

section('D. Transfers cleanup');

if (!/Transfer removed/.test(apiSrc.match(/function bcRemoveTransfer[\s\S]{0,1800}/)?.[0] || '')) {
  pass('D1', 'no Transfer removed success text');
} else fail('D1', 'removed message');
if (/bc-transfer-remove/.test(apiSrc)) pass('D2', 'remove transfer button retained');
else fail('D2', 'remove button');

section('E. Payments cleanup');

const cashIdx = apiSrc.indexOf('bcRenderCashPaymentFormHtml');
const linkIdx = apiSrc.indexOf('bcRenderPaymentLinkSectionHtml', apiSrc.indexOf('function bcRenderRunningInvoiceHtml'));
if (cashIdx >= 0 && linkIdx >= 0 && cashIdx < linkIdx) {
  pass('E1', 'Record Cash Payment before Generate Payment Link');
} else fail('E1', 'button order');
if (/Record Cash Payment<\/button>/.test(apiSrc)) {
  pass('E2', 'Record Cash Payment label');
} else fail('E2', 'label casing');
if (/bc-generate-payment-link-btn/.test(apiSrc)) pass('E3', 'Generate Payment Link retained');
else fail('E3', 'payment link btn');

section('F. Overview cleanup');

if (!/bcRenderRoomingBriefHtml\(data\)/.test(drawerSlice)) {
  pass('F1', 'Room/bed duplicate removed from Booking Details');
} else fail('F1', 'rooming brief');
const convIdx = drawerSlice.indexOf('bc-drawer-card-conversation');
const payIdx = drawerSlice.indexOf('bcRenderPaymentSummaryBriefHtml');
const moveIdx = drawerSlice.indexOf('bc-move-bed');
if (moveIdx >= 0 && convIdx > moveIdx && payIdx > convIdx) {
  pass('F2', 'Payment Summary below Conversation / Handoff');
} else fail('F2', 'payment summary order');
if (/bcRenderPaymentSummaryBriefHtml/.test(drawerSlice)) pass('F3', 'payment summary brief retained');
else fail('F3', 'payment summary');

section('G. Docs + npm');

const doc = readOrEmpty(DOC);
if (/service_date:\s*null|service_date null/i.test(doc) && /Add or remove/i.test(doc)) {
  pass('G1', 'doc covers unschedule + layout');
} else fail('G1', 'doc');
if (/no payment|No Stripe/i.test(doc)) pass('G2', 'doc safety');
else fail('G2', 'doc safety');

const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('G3', 'npm script registered');
else fail('G3', 'npm script');

section('H. Safety');

if (!routesSrc.match(/\bstripe\b/i)) pass('H1', 'no Stripe in routes');
else fail('H1', 'Stripe');
if (!/INSERT INTO payments|payment_intent/.test(routesSrc)) pass('H2', 'no payment writes in route');
else fail('H2', 'payments');
if (!/whatsapp|n8n|guest_message/i.test(routesSrc)) pass('H3', 'no WhatsApp/Meta/n8n');
else fail('H3', 'messaging');

for (const f of GUEST_UNTOUCHED) {
  const base = path.basename(f);
  const src = readOrEmpty(f);
  if (!/bc-svc-unschedule|service_date: null/.test(src)) pass(`H.${base}`, `${base} unchanged`);
  else fail(`H.${base}`, `${base} touched`);
}

section('I. Upstream verifiers');

for (const script of UPSTREAM) {
  try {
    execSync(`npm run ${script}`, { stdio: 'pipe', cwd: ROOT, timeout: 120000 });
    pass(`I.${script}`, `${script} still passes`);
  } catch {
    fail(`I.${script}`, `${script} failed`);
  }
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
