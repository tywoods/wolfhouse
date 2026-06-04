/**
 * Phase 10.3e.1 — Static verifier for Staff Portal booking drawer layout.
 *
 * Usage:
 *   npm run verify:staff-booking-drawer-layout
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');
const MIG_DIR  = path.join(__dirname, '..', 'database', 'migrations');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-booking-drawer-layout.js  (Phase 10.3e.1)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');
check(src.length > 10000, 'staff-query-api.js readable');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

function extractDrawerFn(source) {
  const start = source.indexOf('function renderBookingContextDrawer(data){');
  if (start < 0) return '';
  const endMarker = /}\r?\n\r?\n\/\* ── Tour Operator forms/;
  const slice = source.slice(start);
  const m = slice.match(endMarker);
  if (!m || m.index == null) return '';
  return slice.slice(0, m.index + 1);
}

const drawerFn = extractDrawerFn(src);
check(drawerFn.length > 500, 'renderBookingContextDrawer extracted');

function extractMoveSection(drawer) {
  const start = drawer.indexOf('ctx-move-bed" id="bc-move-bed"');
  if (start < 0) return '';
  const payIdx = drawer.indexOf('/* ── 4. Payment', start);
  if (payIdx < 0) return drawer.slice(start);
  return drawer.slice(start, payIdx);
}

const moveSection = extractMoveSection(drawerFn);

console.log('\nA. Move bed section placement');

check(/id="bc-move-bed"/.test(drawerFn), 'Move bed section exists');
check(/<h3>Move bed<\/h3>/.test(drawerFn), 'Move bed heading present');

const idxMove = drawerFn.indexOf('id="bc-move-bed"');
const idxPayment = drawerFn.indexOf('<h3>Payment</h3>');
check(idxMove >= 0 && idxPayment >= 0 && idxMove < idxPayment,
  'Move bed section appears before Payment section in source order');

console.log('\nB. Duplicate booking summary removed from Move bed panel');

check(!/kvBC\('Booking'/.test(moveSection),
  'Move bed panel does not repeat Booking label');
check(!/kvBC\('Guest'/.test(moveSection),
  'Move bed panel does not repeat Guest label');
check(!/kvBC\('Current bed'/.test(moveSection),
  'Move bed panel does not repeat Current bed label');
check(!/kvBC\('Current room'/.test(moveSection),
  'Move bed panel does not repeat Current room label');
check(!/kvBC\('Check-in'/.test(moveSection),
  'Move bed panel does not repeat Check-in label');
check(!/kvBC\('Check-out'/.test(moveSection),
  'Move bed panel does not repeat Check-out label');

check(/Preview does not change anything/.test(moveSection),
  'Move bed safety copy preserved');
check(/id="bc-move-preview-btn"/.test(moveSection), 'Preview move button exists');
check(/id="bc-move-booking-btn"/.test(moveSection), 'Move booking button exists');
check(/bcMoveBedTargetFieldHtml/.test(moveSection), 'target bed selector/input exists');

console.log('\nC. Services / add-ons — single structured section');

check(/<h3>Services &amp; Add-ons<\/h3>/.test(drawerFn),
  '"Services & Add-ons" section exists');
check(/data\.service_records/.test(drawerFn),
  'drawer uses booking_service_records via data.service_records');
check(/ctx-service-records/.test(drawerFn),
  'service records section id present');
check(!/<h3>Add-ons \/ Activities<\/h3>/.test(drawerFn),
  'duplicate "Add-ons / Activities" heading removed from drawer');
check(!/var ao = data\.addons/.test(drawerFn),
  'legacy data.addons display block removed from drawer');

console.log('\nD. Safety — no forbidden scope creep');

const layoutScope = drawerFn;
check(!/graph\.facebook\.com/.test(layoutScope),
  'no graph.facebook.com in drawer layout');
check(!/api\.stripe\.com/.test(layoutScope),
  'no api.stripe.com in drawer layout');
check(!/n8n\.cloud|activate.*workflow/i.test(layoutScope),
  'no n8n activation URL in drawer layout');
check(!/UPDATE payments|INSERT INTO payments/.test(layoutScope),
  'no payment mutation strings in drawer layout');
check(!/INSERT INTO booking_service_records|UPDATE booking_service_records/.test(layoutScope),
  'no booking_service_records mutation strings in drawer layout');
check(!/resolveNaturalLanguageIntent|function alAsk/.test(layoutScope),
  'no Ask Luna logic changes in drawer layout');
check(!/date-change-preview|bc-date-change|id="bc-move-check|Change dates<\/span>/.test(moveSection),
  'no date-change UI in move section');
check(!/drag.?drop|bcDragMove|Confirm Move/.test(layoutScope),
  'no drag/drop UI in drawer layout');

console.log('\nE. Migrations unchanged');

if (fs.existsSync(MIG_DIR)) {
  const migFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
  const migHasLayout = migFiles.some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /10\.3e\.1|bc-move-bed|Add-ons \/ Activities/i.test(body);
  });
  check(!migHasLayout, 'no new migration references drawer layout slice');
} else {
  ok('migrations directory not present (skip)');
}

console.log('\nF. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-drawer-layout'] ===
      'node scripts/verify-staff-booking-drawer-layout.js',
    'package.json has verify:staff-booking-drawer-layout script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
