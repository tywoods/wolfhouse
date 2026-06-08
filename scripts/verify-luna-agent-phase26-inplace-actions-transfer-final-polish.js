/**
 * Phase 26h.8 — In-place tab actions + transfer final polish verifier.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-inplace-actions-transfer-final-polish
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(__dirname, 'lib', 'booking-transfers.js');
const ROUTES = path.join(__dirname, 'lib', 'staff-booking-transfers-routes.js');
const CONFIG = path.join(__dirname, 'lib', 'client-transfer-config.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26h-8-INPLACE-ACTIONS-TRANSFER-FINAL-POLISH.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-inplace-actions-transfer-final-polish';

const UPSTREAM = [
  'verify:luna-agent-phase26-service-pebbles-transfer-payment-polish',
  'verify:luna-agent-phase26-services-unschedule-drawer-cleanup',
  'verify:luna-agent-phase26-transfer-calendar-pebble',
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

console.log('\nverify-luna-agent-phase26-inplace-actions-transfer-final-polish.js  (Phase 26h.8)\n');

try {
  execSync(`node --check "${HELPER}"`, { stdio: 'pipe' });
  execSync(`node --check "${ROUTES}"`, { stdio: 'pipe' });
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'helper + routes + staff-query-api pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

const helperSrc = readOrEmpty(HELPER);
const routesSrc = readOrEmpty(ROUTES);
const configSrc = readOrEmpty(CONFIG);
const apiSrc = readOrEmpty(API);
const doc = readOrEmpty(DOC);
const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');

const addSvcSlice = (apiSrc.match(/function bcRunAddServiceSave[\s\S]{0,2200}/) || [''])[0];
const removeSvcSlice = (apiSrc.match(/function bcRunRemoveServiceSave[\s\S]{0,1800}/) || [''])[0];
const payLinkSuccessSlice = (apiSrc.match(/Payment link ready in Payment history[\s\S]{0,400}/) || [''])[0];
const cashSlice = (apiSrc.match(/function bcInitCashPaymentShell[\s\S]{0,3200}/) || [''])[0];
const loadSlice = (apiSrc.match(/function loadBlockDetail[\s\S]{0,1200}/) || [''])[0];
const transferCardSlice = (apiSrc.match(/function bcRenderTransferCard[\s\S]{0,4200}/) || [''])[0];
const saveTransferSlice = (apiSrc.match(/function bcSaveTransfer[\s\S]{0,2200}/) || [''])[0];
const removeTransferSlice = (apiSrc.match(/function bcRemoveTransfer[\s\S]{0,1600}/) || [''])[0];
const clearFormSlice = (apiSrc.match(/function bcClearTransferForm[\s\S]{0,2800}/) || [''])[0];
const drawerSlice = (apiSrc.match(/function renderBookingContextDrawer[\s\S]{0,2200}/) || [''])[0];
const pkgOptsSlice = (apiSrc.match(/function bcFieldEditPackageOptions[\s\S]{0,600}/) || [''])[0];

section('A. Active drawer tab state');

if (/var bcActiveDrawerTab/.test(apiSrc) && /function bcRestoreActiveDrawerTab/.test(apiSrc)) {
  pass('A1', 'bcActiveDrawerTab tracked + restore helper');
} else fail('A1', 'tab state missing');
if (/bcActiveDrawerTab\s*=\s*tab/.test(apiSrc.match(/function bcInitDrawerTabs[\s\S]{0,1200}/)?.[0] || '')) {
  pass('A2', 'tab click updates bcActiveDrawerTab');
} else fail('A2', 'tab click tracking');
if (/bcRestoreActiveDrawerTab\(tabToRestore\)/.test(loadSlice)) {
  pass('A3', 'loadBlockDetail restores active tab after render');
} else fail('A3', 'loadBlockDetail tab restore');
if (/activeTab === 'overview'/.test(drawerSlice) && /activeTab === 'services'/.test(drawerSlice)) {
  pass('A4', 'renderBookingContextDrawer uses bcActiveDrawerTab for initial panel');
} else fail('A4', 'drawer initial tab');

section('B. Services in-place / tab-only updates');

if (/bcRefreshServicesTabAfterMutation/.test(addSvcSlice) && !/loadBlockDetail/.test(addSvcSlice)) {
  pass('B1', 'add service prefers tab-only refresh; stays off full reload');
} else fail('B1', 'add service reload');
if (/bcRefreshServicesTabAfterMutation/.test(removeSvcSlice) && !/loadBlockDetail/.test(removeSvcSlice)) {
  pass('B2', 'remove service prefers tab-only refresh');
} else fail('B2', 'remove service reload');
if (/bcApplyServicesScheduleData/.test(apiSrc) && !/bcRestoreActiveDrawerTab\('services'\)/.test(
  apiSrc.match(/function bcApplyServicesScheduleData[\s\S]{0,800}/)?.[0] || ''
)) {
  pass('B3', 'schedule apply does not force Services tab on async load');
} else fail('B3', 'schedule apply forces Services tab');
if (/bcRestoreActiveDrawerTab\('services'\)/.test(
  apiSrc.match(/function bcRefreshServicesTabAfterMutation[\s\S]{0,400}/)?.[0] || ''
)) {
  pass('B4', 'services tab mutation restores Services tab');
} else fail('B4', 'services mutation tab');

section('C. Payments in-place / tab-only updates');

if (/bcRefreshPaymentsTab/.test(payLinkSuccessSlice) && !/loadBlockDetail/.test(payLinkSuccessSlice)) {
  pass('C1', 'payment link generation refreshes Payments tab only');
} else fail('C1', 'payment link full reload');
if (/bcRefreshPaymentsTab/.test(cashSlice) && !/loadBlockDetail/.test(cashSlice)) {
  pass('C2', 'record cash refreshes Payments tab only');
} else fail('C2', 'cash payment full reload');

section('D. Transfers in-place');

if (/bcTransferEnsureRemoveButton/.test(saveTransferSlice) && /bcRefreshTransferPebbleSummary/.test(saveTransferSlice) &&
    !/loadBlockDetail/.test(saveTransferSlice)) {
  pass('D1', 'save transfer updates remove button + pebble in place');
} else fail('D1', 'save transfer in-place');
if (/bcRefreshTransferPebbleSummary/.test(removeTransferSlice) && !/loadBlockDetail/.test(removeTransferSlice)) {
  pass('D2', 'remove transfer updates pebble in place');
} else fail('D2', 'remove transfer reload');
if (/bcRestoreActiveDrawerTab\('transfers'\)/.test(apiSrc)) {
  pass('D3', 'transfer actions restore Transfers tab');
} else fail('D3', 'transfers tab restore');

section('E. No package option');

if (/no_package/.test(pkgOptsSlice) && /malibu/.test(pkgOptsSlice) && /uluwatu/.test(pkgOptsSlice) &&
    /waimea/.test(pkgOptsSlice)) {
  pass('E1', 'package options include no_package + Malibu/Uluwatu/Waimea');
} else fail('E1', 'package options');
if (/No package/.test(apiSrc.match(/function bcFieldEditPackageDisplayLabel[\s\S]{0,400}/)?.[0] || '')) {
  pass('E2', 'No package display label');
} else fail('E2', 'No package label');
if (/editPreviewPackageStorageCode/.test(apiSrc) && /no_package/.test(apiSrc)) {
  pass('E3', 'no_package maps to null storage on write');
} else fail('E3', 'no_package storage');

section('F. Transfer default datetime');

if (/arrival_scheduled_at_local/.test(routesSrc) && /T09:00/.test(routesSrc)) {
  pass('F1', 'arrival default check-in 09:00 in API defaults');
} else fail('F1', 'arrival default API');
if (/departure_scheduled_at_local/.test(routesSrc) && /T12:00/.test(routesSrc)) {
  pass('F2', 'departure default check-out 12:00 in API defaults');
} else fail('F2', 'departure default API');
if (/arrival_scheduled_at_local/.test(transferCardSlice) && /departure_scheduled_at_local/.test(transferCardSlice)) {
  pass('F3', 'transfer card applies defaults when no saved scheduled_at');
} else fail('F3', 'card defaults');
if (/defaults\[defKey\]/.test(clearFormSlice)) {
  pass('F4', 'clear form re-applies default datetime');
} else fail('F4', 'clear defaults');
if (!/toISOString\(\)\.slice\(0,\s*10\)/.test(
  routesSrc.match(/function buildDefaults[\s\S]{0,600}/)?.[0] || ''
)) {
  pass('F5', 'defaults avoid UTC date-only shift in buildDefaults');
} else fail('F5', 'UTC shift in defaults');

section('G. Remove button labels + live behavior');

if (/Remove Arrival Transfer/.test(transferCardSlice) && /Remove Departure Transfer/.test(transferCardSlice)) {
  pass('G1', 'exact remove button labels');
} else fail('G1', 'remove labels');
if (/bcTransferEnsureRemoveButton/.test(apiSrc)) {
  pass('G2', 'ensure remove button helper after save');
} else fail('G2', 'ensure remove button');
if (/removeBtn\.remove\(\)/.test(clearFormSlice)) {
  pass('G3', 'remove button disappears on delete/clear');
} else fail('G3', 'remove button hide');

section('H. Header pebble wording');

const pebbleSlice = (apiSrc.match(/function bcFormatTransferSummaryLabel[\s\S]{0,500}/) || [''])[0];
if (/Transfer: Arrival \+ Departure/.test(pebbleSlice) && /Transfer: Arrival/.test(pebbleSlice) &&
    /Transfer: Departure/.test(pebbleSlice)) {
  pass('H1', 'header pebble single + both direction wording');
} else fail('H1', 'pebble wording');
if (!/Transfer Required/.test(pebbleSlice) && !/Transfer saved/.test(saveTransferSlice)) {
  pass('H2', 'no Transfer Required / Transfer saved in header path');
} else fail('H2', 'old pebble wording');
if (/bcRefreshTransferPebbleSummary/.test(saveTransferSlice) && /bcRefreshTransferPebbleSummary/.test(removeTransferSlice)) {
  pass('H3', 'save/remove call live pebble update');
} else fail('H3', 'pebble live update');

section('I. Transfer Charge UI');

if (/Transfer Charge/.test(transferCardSlice) && !/Transfer charge/.test(transferCardSlice)) {
  pass('I1', 'Transfer Charge title case label in card');
} else fail('I1', 'Transfer Charge label');
if (/bc-transfer-override-amount/.test(transferCardSlice)) {
  pass('I2', 'compact override amount input class');
} else fail('I2', 'compact input');
const rightCol = transferCardSlice.match(/bc-transfer-col-right[\s\S]{0,900}/)?.[0] || '';
if (/Notes/.test(rightCol)) pass('I3', 'Notes on right column');
else fail('I3', 'notes position');
if (/bc-transfer-override-block/.test(transferCardSlice) && /Transfer date\/time/.test(transferCardSlice)) {
  pass('I4', 'override block under date/time');
} else fail('I4', 'override position');

section('J. Bilbao under-4 override rule');

if (/assertTransferGroupOverrideAllowed/.test(helperSrc)) {
  pass('J1', 'group override guard in booking-transfers');
} else fail('J1', 'group override guard');
if (/bilbao_min_group_override_required/.test(routesSrc)) {
  pass('J2', 'route returns 400 for bilbao under-min-group without override');
} else fail('J2', 'route 400');
if (/Exception Override to save a manual exception/.test(configSrc) ||
    /Exception Override to save a manual exception/.test(helperSrc)) {
  pass('J3', 'safe Bilbao under-4 error message');
} else fail('J3', 'error message');

const {
  assertTransferGroupOverrideAllowed,
  buildBookingTransferUpsertPayload,
} = require('./lib/booking-transfers');

try {
  assertTransferGroupOverrideAllowed({
    client_slug: 'wolfhouse-somo',
    booking: { guest_count: 2, package_code: 'malibu' },
    transferInput: { airport_code: 'BIO', direction: 'arrival', status: 'requested' },
    pricing: {},
    manualOverride: null,
  });
  fail('J4', 'Bilbao under-4 without override should throw');
} catch (err) {
  if (err.code === 'bilbao_min_group_override_required') pass('J4', 'Bilbao under-4 without override blocked');
  else fail('J4', `unexpected error: ${err.code || err.message}`);
}

try {
  assertTransferGroupOverrideAllowed({
    client_slug: 'wolfhouse-somo',
    booking: { guest_count: 2, package_code: 'malibu' },
    transferInput: {
      airport_code: 'BIO',
      direction: 'arrival',
      status: 'requested',
      manual_override_enabled: true,
    },
    pricing: {},
    manualOverride: { price_cents: 2500 },
  });
  pass('J5', 'Bilbao under-4 with override amount allowed');
} catch (err) {
  fail('J5', `override should pass: ${err.message}`);
}

try {
  assertTransferGroupOverrideAllowed({
    client_slug: 'wolfhouse-somo',
    booking: { guest_count: 4, package_code: 'malibu' },
    transferInput: { airport_code: 'BIO', direction: 'arrival', status: 'requested' },
    pricing: {},
    manualOverride: null,
  });
  pass('J6', 'Bilbao guest_count >= 4 uses normal rule');
} catch (err) {
  fail('J6', `guest_count 4 should pass: ${err.message}`);
}

try {
  assertTransferGroupOverrideAllowed({
    client_slug: 'wolfhouse-somo',
    booking: { guest_count: 2, package_code: 'malibu' },
    transferInput: { airport_code: 'SDR', direction: 'arrival', status: 'requested' },
    pricing: {},
    manualOverride: null,
  });
  pass('J7', 'Santander under-4 unchanged');
} catch (err) {
  fail('J7', `Santander should pass: ${err.message}`);
}

const upsertPayload = buildBookingTransferUpsertPayload({
  client_slug: 'wolfhouse-somo',
  booking: { guest_count: 2, package_code: 'malibu', check_in: '2026-06-08', check_out: '2026-06-11' },
  transferInput: {
    direction: 'arrival',
    status: 'requested',
    airport_code: 'BIO',
    manual_override_enabled: true,
    manual_override_euros: 25,
  },
  source: 'staff',
});
if (upsertPayload.included_in_package === false && /Manual transfer override/i.test(upsertPayload.pricing_note || '')) {
  pass('J8', 'override payload sets manual pricing metadata');
} else fail('J8', 'override payload metadata');

section('K. Safety');

if (!/INSERT INTO payments/.test(helperSrc) && !/INSERT INTO payments/.test(routesSrc)) {
  pass('K1', 'no payment rows from transfer save/override');
} else fail('K1', 'payment insert in transfer code');
const routesNoGuest = routesSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const helperNoComments = helperSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
if (!/whatsapp|n8n|luna-meta/i.test(routesNoGuest + helperNoComments)) {
  pass('K2', 'no WhatsApp/Meta/n8n in transfer slice');
} else fail('K2', 'messaging touched');

section('L. Docs + npm');

if (/bcActiveDrawerTab/.test(doc) && /No package/.test(doc) && /Transfer Charge/.test(doc)) {
  pass('L1', 'doc covers tab preservation + package + transfer polish');
} else fail('L1', 'doc content');
if (/Bilbao/.test(doc) && /no payment/i.test(doc)) {
  pass('L2', 'doc covers Bilbao rule + safety');
} else fail('L2', 'doc Bilbao/safety');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('L3', 'npm script registered');
else fail('L3', 'npm script');

section('M. Upstream verifiers');

for (const up of UPSTREAM) {
  try {
    execSync(`npm run ${up}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass(`M-${up}`, `${up} PASS`);
  } catch (e) {
    const out = String(e.stdout || e.stderr || e.message).slice(0, 240);
    fail(`M-${up}`, `${up} FAIL: ${out}`);
  }
}

console.log(`\n── Summary ──`);
console.log(`  PASS: ${passes}`);
console.log(`  FAIL: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
