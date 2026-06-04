/**
 * Phase 10.3e / 10.6a.3 — Static verifier for Staff Portal booking drawer move controls.
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

console.log('\nverify-staff-booking-move-ui.js  (Phase 10.3e / 10.6a.3)\n');

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
const headerFn = src.match(/function bcDetailHeaderMetaHtml[\s\S]*?function updateBcDetailHeader/)?.[0] || '';
const sourcePillsFn = src.match(/function bcRenderMoveSourcePillsHtml[\s\S]*?\n\}/)?.[0] || '';

console.log('\nA. Drawer chrome — header + move copy');

check(!/ctx-nights-badge/.test(headerFn),
  'drawer header no longer renders nights badge');
check(/bcDetailHeaderMetaHtml/.test(src) && /bk\.status|pill/.test(headerFn),
  'drawer header still shows status pill');
check(!/Choose which current bed to move/.test(drawerFn + sourcePillsFn + moveFnBlock),
  'removed "Choose which current bed to move." helper');
check(!/>Target bed</.test(drawerFn),
  'removed "Target bed" label from move panel');
check(!/Only available target beds are shown/.test(moveFnBlock + drawerFn),
  'removed "Only available target beds are shown." note');
check(!/Move controls are disabled/.test(moveFnBlock + drawerFn),
  'removed "Move controls are disabled." UI copy');
check(/Move bed/.test(drawerFn), 'drawer contains "Move bed" section');
check(/id="bc-move-bed"/.test(drawerFn), 'Move bed section id present');
check(/bc-move-source-pills/.test(drawerFn + sourcePillsFn),
  'source bed pills remain');

console.log('\nB. Buttons + enablement');

check(/id="bc-move-booking-btn"/.test(drawerFn), 'Move Bed button exists');
check(/>Move Bed</.test(drawerFn), '10.6g.5: Move Bed button label');
check(!/>Move booking</.test(drawerFn), '10.6g.5: no Move booking visible label');
check(/bc-move-booking-btn" disabled/.test(drawerFn),
  'Move Bed button initially disabled in HTML');
check(/function bcMoveInputsReadyForWrite/.test(moveFnBlock),
  'bcMoveInputsReadyForWrite gates Move Bed enablement');
check(/moveBtn\.disabled = busy \|\| !bcMoveInputsReadyForWrite\(\)/.test(moveFnBlock),
  'Move Bed enabled from source+target readiness (not env gate)');
check(!/moveBtn\.disabled[\s\S]*BC_BOOKING_MOVE_WRITE/.test(moveFnBlock),
  'Move Bed button not blocked by BC_BOOKING_MOVE_WRITE');
check(/var BC_BOOKING_MOVE_WRITE = true/.test(src),
  'BC_BOOKING_MOVE_WRITE hardcoded true in Staff Portal bundle');

console.log('\nC. API calls');

check(/\/staff\/bookings\/move['"]/.test(moveFnBlock),
  'UI calls POST /staff/bookings/move');
check(/\/staff\/bookings\/move-targets/.test(moveFnBlock),
  'UI calls POST /staff/bookings/move-targets');
check(/client_slug:\s*getClient\(\)/.test(moveFnBlock),
  'move requests use getClient() for client_slug');
check(/check_in:\s*bcMoveCtx\.checkIn/.test(moveFnBlock),
  'uses existing booking check_in from context');
check(/check_out:\s*bcMoveCtx\.checkOut/.test(moveFnBlock),
  'uses existing booking check_out from context');

console.log('\nD. Idempotency + success reload');

check(/bcNewMoveIdempotencyKey/.test(moveFnBlock),
  'client-side idempotency key generator present');
check(/idempotency_key:\s*idemKey/.test(moveFnBlock),
  'move request sends idempotency_key');
check(/Moved from Staff Portal booking drawer/.test(moveFnBlock),
  'move request sends Staff Portal reason');
check(/bcReloadAfterMoveSuccess/.test(moveFnBlock),
  'success path reloads calendar/drawer');
check(/No payment, service, or message changes/.test(moveFnBlock),
  'success message references no payment/service/message changes');

console.log('\nE. Safety — no forbidden integrations');

check(!/graph\.facebook\.com/.test(moveFnBlock + drawerFn),
  'no graph.facebook.com in move UI');
check(!/api\.stripe\.com/.test(moveFnBlock + drawerFn),
  'no api.stripe.com in move UI');
check(!/n8n\.cloud|activate.*workflow/i.test(moveFnBlock + drawerFn),
  'no n8n activation URL in move UI');
check(!/UPDATE payments|INSERT INTO payments|booking_service_records/i.test(moveFnBlock),
  'no payment or service-record mutation in move UI handlers');

console.log('\nF. Migrations unchanged');

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

console.log('\nG. package.json script');

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
