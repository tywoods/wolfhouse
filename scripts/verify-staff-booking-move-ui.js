/**
 * Phase 10.3e — Static verifier for Staff Portal booking drawer move controls.
 *
 * Usage:
 *   npm run verify:staff-booking-move-ui
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

console.log('\nverify-staff-booking-move-ui.js  (Phase 10.3e)\n');

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

const moveFnBlock = src.match(/\/\* ── Phase 10\.3e — booking drawer move bed[\s\S]*?function bcInitMovePanel[\s\S]*?\n\}/)?.[0] || '';
const drawerFn = src.match(/function renderBookingContextDrawer[\s\S]*?\n\}/)?.[0] || '';

console.log('\nA. Drawer move section');

check(/Move bed/.test(drawerFn), 'drawer contains "Move bed" section');
check(/id="bc-move-bed"/.test(drawerFn), 'Move bed section id present');
check(/Preview does not change anything/.test(drawerFn),
  'safety copy: preview does not change anything');
check(/same-date bed move only/.test(drawerFn),
  'safety copy: same-date bed move only');
check(/Date changes are not supported here/.test(drawerFn),
  'safety copy: date changes not supported');

console.log('\nB. Buttons');

check(/id="bc-move-preview-btn"/.test(drawerFn), 'Preview move button exists');
check(/Preview move/.test(drawerFn), 'Preview move button label');
check(/id="bc-move-booking-btn"/.test(drawerFn), 'Move booking button exists');
check(/Move booking/.test(drawerFn), 'Move booking button label');
check(/bc-move-booking-btn" disabled/.test(drawerFn),
  'Move booking button initially disabled in HTML');

console.log('\nC. API calls');

check(/\/staff\/bookings\/move-preview/.test(moveFnBlock),
  'UI calls POST /staff/bookings/move-preview');
check(/\/staff\/bookings\/move['"]/.test(moveFnBlock),
  'UI calls POST /staff/bookings/move');
check(/client_slug:\s*getClient\(\)/.test(moveFnBlock),
  'move requests use getClient() for client_slug');
check(/check_in:\s*bcMoveCtx\.checkIn/.test(moveFnBlock),
  'uses existing booking check_in from context');
check(/check_out:\s*bcMoveCtx\.checkOut/.test(moveFnBlock),
  'uses existing booking check_out from context');
check(!/bc-move.*check_in|id="bc-move-check/.test(drawerFn + moveFnBlock),
  'no date inputs in move UI');

console.log('\nD. Move button gating + idempotency');

check(/previewCanMove/.test(moveFnBlock), 'previewCanMove state tracked');
check(/!bcMoveCtx\.previewCanMove/.test(moveFnBlock),
  'move blocked until preview can_move');
check(/moveBtn\.disabled = busy \|\| !bcMoveCtx\.previewCanMove/.test(moveFnBlock),
  'Move booking button disabled until preview can_move:true');
check(/bcNewMoveIdempotencyKey/.test(moveFnBlock),
  'client-side idempotency key generator present');
check(/idempotency_key:\s*idemKey/.test(moveFnBlock),
  'move request sends idempotency_key');
check(/Moved from Staff Portal booking drawer/.test(moveFnBlock),
  'move request sends Staff Portal reason');

console.log('\nE. Gate-off handling');

check(/BC_BOOKING_MOVE_WRITE/.test(src), 'BC_BOOKING_MOVE_WRITE flag embedded');
check(/booking_move_write_disabled/.test(moveFnBlock),
  'UI handles booking_move_write_disabled');
check(/Move controls are disabled/.test(moveFnBlock + drawerFn),
  'UI shows move controls disabled message');

console.log('\nF. Success / reload');

check(/bcReloadAfterMoveSuccess/.test(moveFnBlock),
  'success path reloads calendar/drawer');
check(/No payment, service, or message changes/.test(moveFnBlock),
  'success message references no payment/service/message changes');
check(/b\.idempotent/.test(moveFnBlock),
  'idempotent response handled');

console.log('\nG. Safety — no forbidden integrations');

check(!/graph\.facebook\.com/.test(moveFnBlock + drawerFn),
  'no graph.facebook.com in move UI');
check(!/api\.stripe\.com/.test(moveFnBlock + drawerFn),
  'no api.stripe.com in move UI');
check(!/n8n\.cloud|activate.*workflow/i.test(moveFnBlock + drawerFn),
  'no n8n activation URL in move UI');
check(!/UPDATE payments|INSERT INTO payments|booking_service_records/i.test(moveFnBlock),
  'no payment or service-record mutation in move UI handlers');
check(!/resolveNaturalLanguageIntent|function alAsk/.test(moveFnBlock),
  'no Ask Luna logic in move UI handlers');
check(!/drag.?drop|Confirm Move|bcDragMove/i.test(drawerFn + moveFnBlock),
  'no drag/drop or Confirm Move modal');

console.log('\nH. Migrations unchanged');

if (fs.existsSync(MIG_DIR)) {
  const migFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
  const migHasMoveUi = migFiles.some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /bc-move-bed|Move bed|10\.3e/i.test(body);
  });
  check(!migHasMoveUi, 'no new migration references move UI');
} else {
  ok('migrations directory not present (skip)');
}

console.log('\nI. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-move-ui'] ===
      'node scripts/verify-staff-booking-move-ui.js',
    'package.json has verify:staff-booking-move-ui script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
