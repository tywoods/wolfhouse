/**
 * Phase 10.3h — Static verifier for multi-bed source selection in Move bed panel.
 *
 * Usage:
 *   npm run verify:staff-booking-move-assignment-ui
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

console.log('\nverify-staff-booking-move-assignment-ui.js  (Phase 10.3h)\n');

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
const pillsFn = src.match(/function bcRenderMoveSourcePillsHtml[\s\S]*?\n\}/)?.[0] || '';

console.log('\nA. Source assignment selection UI');

check(/bc-move-source-pills|bc-move-source-pill/.test(drawerFn + moveFnBlock + pillsFn),
  'Move bed panel has source assignment selection UI');
check(/Choose which current bed to move/.test(drawerFn + pillsFn),
  'UI text includes "Choose which current bed to move"');
check(/data-booking-bed-id/.test(pillsFn),
  'selectable pills include booking_bed_id data attribute');
check(/data-bed-id/.test(pillsFn),
  'selectable pills include bed_id data attribute');
check(/data-bed-code/.test(pillsFn),
  'selectable pills include bed_code data attribute');
check(/data-check-in/.test(pillsFn) && /data-check-out/.test(pillsFn),
  'selectable pills include check_in/check_out when available');

console.log('\nB. Preview + move requests include booking_bed_id');

check(/booking_bed_id:\s*bookingBedId/.test(moveFnBlock),
  'move-preview and move send booking_bed_id from selection');
check(/bcGetSelectedBookingBedId/.test(moveFnBlock),
  'helper resolves selected source booking_bed_id');
check(/\/staff\/bookings\/move-preview/.test(moveFnBlock),
  'POST /staff/bookings/move-preview called from UI');
check(/\/staff\/bookings\/move['"]/.test(moveFnBlock),
  'POST /staff/bookings/move called from UI');

console.log('\nC. Preview move enablement');

check(/function bcMoveInputsReadyForPreview/.test(moveFnBlock),
  'preview readiness helper present');
check(/prevBtn\.disabled = busy \|\| !bcMoveInputsReadyForPreview\(\)/.test(moveFnBlock),
  'Preview move enabled when source + target + dates present (not gated on prior preview)');
check(!/prevBtn\.disabled = busy \|\| !bcMoveCtx\.singleBed/.test(moveFnBlock),
  'Preview move no longer blocked solely by multi-bed singleBed flag');

console.log('\nD. Move booking gating + preview reset');

check(/moveBtn\.disabled = busy \|\| !bcMoveCtx\.previewCanMove/.test(moveFnBlock),
  'Move booking disabled until previewCanMove is true');
check(/function bcResetMovePreviewState/.test(moveFnBlock),
  'preview reset helper present');
check(/bcMoveCtx\.previewCanMove = false/.test(moveFnBlock),
  'previewCanMove cleared on input changes');
check(/bcOnMoveSourcePillClick/.test(moveFnBlock) && /bcResetMovePreviewState/.test(moveFnBlock),
  'changing source pill clears preview state');
check(/targetEl\.onchange = bcResetMovePreviewState/.test(moveFnBlock) ||
      /bcWireMoveTargetField/.test(moveFnBlock),
  'changing target bed clears preview state');

console.log('\nE. Gate-off + requires_selection handling');

check(/!BC_BOOKING_MOVE_WRITE/.test(moveFnBlock),
  'Move booking remains disabled when BC_BOOKING_MOVE_WRITE is false');
check(/Move controls are disabled/.test(moveFnBlock + drawerFn),
  'gate-off shows Move controls are disabled message');
check(/requires_selection/.test(moveFnBlock),
  'requires_selection response handled in preview');
check(/Select which bed assignment to move/.test(moveFnBlock),
  'requires_selection shows Select which bed assignment to move message');

console.log('\nF. Target bed excludes selected source');

check(/function bcMoveBedTargetFieldHtml\(excludeBedId\)/.test(moveFnBlock) ||
      /bcMoveBedTargetFieldHtml\(excludeBedId\)/.test(moveFnBlock),
  'target field builder accepts excludeBedId');
check(/excludeBedId && bed\.bed_id === excludeBedId/.test(moveFnBlock),
  'target bed dropdown excludes selected source bed by bed_id');
check(/bcRefreshMoveTargetField/.test(moveFnBlock),
  'target dropdown refreshes when source selection changes');

console.log('\nG. Single-bed + zero-bed paths');

check(/assigns\.length === 1/.test(moveFnBlock),
  'single-bed path detects one assignment');
check(/selectedBookingBedId = assigns\[0\]\.booking_bed_id/.test(moveFnBlock),
  'single-bed auto-selects booking_bed_id');
check(/is-selected/.test(pillsFn),
  'single-bed pill can show selected state');
check(/no bed assignments and requires manual review/.test(drawerFn + moveFnBlock),
  'zero assignments keeps manual-review message');
check(!/multiple or no bed assignments and requires manual review/.test(drawerFn),
  'multi-bed no longer shows blanket manual-review error');

console.log('\nH. Preserve existing move behavior');

check(/Preview does not change anything/.test(drawerFn),
  'safety copy preserved');
check(/bcReloadAfterMoveSuccess/.test(moveFnBlock),
  'reload/reopen drawer after success preserved');
check(/booking_move_write_disabled/.test(moveFnBlock),
  'booking_move_write_disabled handling preserved');

console.log('\nI. Safety — forbidden scope');

check(!/bc-move.*check_in|id="bc-move-check/.test(drawerFn + moveFnBlock),
  'no date-change UI inputs');
check(!/drag.?drop|Confirm Move|bcDragMove/i.test(drawerFn + moveFnBlock),
  'no drag/drop or Confirm Move modal');
check(!/graph\.facebook\.com/.test(drawerFn + moveFnBlock),
  'no WhatsApp / graph.facebook.com');
check(!/api\.stripe\.com/.test(drawerFn + moveFnBlock),
  'no Stripe / api.stripe.com');
check(!/n8n\.cloud|activate.*workflow/i.test(drawerFn + moveFnBlock),
  'no n8n activation URL');
check(!/UPDATE payments|INSERT INTO payments|UPDATE booking_service_records|INSERT INTO booking_service_records/i.test(moveFnBlock),
  'no payment or booking_service_records mutation in move UI');
check(!/resolveNaturalLanguageIntent|function alAsk/.test(moveFnBlock),
  'no Ask Luna changes in move UI');

console.log('\nJ. Migrations unchanged');

if (fs.existsSync(MIG_DIR)) {
  const migFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
  const migHit = migFiles.some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /10\.3h|bc-move-source-pill|Choose which current bed to move/i.test(body);
  });
  check(!migHit, 'no new migration references assignment move UI');
} else {
  ok('migrations directory not present (skip)');
}

console.log('\nK. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-move-assignment-ui'] ===
      'node scripts/verify-staff-booking-move-assignment-ui.js',
    'package.json has verify:staff-booking-move-assignment-ui script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
