/**
 * Phase 10.3h.4 / 10.3h.5 — Static verifier for move target filtering + no-preview flow.
 *
 * Usage:
 *   npm run verify:staff-booking-move-targets-ui
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

console.log('\nverify-staff-booking-move-targets-ui.js  (Phase 10.3h.4 / 10.3h.5)\n');

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

const targetsHandler = src.match(/async function handleBookingMoveTargets[\s\S]*?(?=\r?\nasync function handleBookingMovePreview)/)?.[0] || '';
const writeHandler   = src.match(/async function handleBookingMoveWrite[\s\S]*?(?=\r?\nasync function handleBookingMoveTargets)/)?.[0] || '';
const targetsRoute = src.match(/pathname === '\/staff\/bookings\/move-targets'[\s\S]*?handleBookingMoveTargets/)?.[0] || '';
const loadTargetsFn = src.match(/function bcLoadMoveTargets[\s\S]*?\n\}/)?.[0] || '';
const moveFnBlock = src.match(/\/\* ── Phase 10\.3e — booking drawer move bed[\s\S]*?function bcInitMovePanel[\s\S]*?\n\}/)?.[0] || '';
const drawerFn = src.match(/function renderBookingContextDrawer[\s\S]*?\n\}/)?.[0] || '';

console.log('\nA. move-targets route');

check(/pathname === '\/staff\/bookings\/move-targets'/.test(src),
  'POST /staff/bookings/move-targets route registered');
check(/handleBookingMoveTargets/.test(src),
  'handleBookingMoveTargets handler present');
check(/requireAuth\(req, res, 'operator'\)/.test(targetsRoute),
  'move-targets requires operator auth');

console.log('\nB. SELECT-only / preview-only response');

check(/preview_only:\s*true/.test(targetsHandler),
  'move-targets sets preview_only:true');
check(/would_mutate:\s*false/.test(targetsHandler),
  'move-targets sets would_mutate:false');
check(!/UPDATE booking_beds|INSERT INTO booking_beds|DELETE FROM booking_beds/i.test(targetsHandler),
  'move-targets handler has no booking_beds mutation');
check(!/UPDATE bookings|INSERT INTO bookings|DELETE FROM bookings/i.test(targetsHandler),
  'move-targets handler has no bookings mutation');
check(/MOVE_TARGETS_ALL_BEDS_SQL/.test(targetsHandler),
  'move-targets uses SELECT for all beds');
check(/MOVE_TARGETS_RANGE_ASSIGNMENTS_SQL/.test(targetsHandler),
  'move-targets uses SELECT for range assignments');

console.log('\nC. Half-open overlap + source exclusion');

check(/function moveBuildTargetAvailability/.test(src),
  'moveBuildTargetAvailability helper present');
check(/movePreviewHalfOpenOverlaps|moveWriteBuildConflicts/.test(
  src.match(/function moveBuildTargetAvailability[\s\S]*?\n\}/)?.[0] || ''),
  'target availability uses shared half-open conflict logic');
check(/existingStart < targetCheckOut && existingEnd > targetCheckIn/.test(src),
  'half-open overlap formula present in codebase');
check(/excludeId|booking_bed_id !== excludeId/.test(
  src.match(/function moveBuildTargetAvailability[\s\S]*?\n\}/)?.[0] || src),
  'source booking_bed_id excluded from conflict checks');
check(/disabled_reason:\s*'current_source_bed'/.test(src),
  'current source bed marked with disabled_reason');
check(/disabled_reason:\s*'occupied'/.test(src),
  'occupied beds marked with disabled_reason');
check(/targets,/.test(targetsHandler) || /targets:/.test(targetsHandler),
  'response includes targets array');

console.log('\nD. Target object shape');

const buildFn = src.match(/function moveBuildTargetAvailability[\s\S]*?\n\}/)?.[0] || '';
check(/available:/.test(buildFn),
  'targets include available flag');
check(/conflicts:/.test(buildFn),
  'targets include conflicts array');
check(/bed_id:/.test(buildFn) && /bed_code:/.test(buildFn),
  'targets include bed_id and bed_code');
check(/room_code:/.test(buildFn),
  'targets include room_code');
check(/is_current_source:/.test(buildFn),
  'targets include is_current_source flag');
check(/a\.available !== b\.available/.test(buildFn),
  'available beds sorted first');

console.log('\nE. UI calls move-targets once (not N previews)');

check(/function bcLoadMoveTargets/.test(moveFnBlock),
  'bcLoadMoveTargets helper present');
check(/\/staff\/bookings\/move-targets/.test(moveFnBlock),
  'UI POSTs /staff/bookings/move-targets');
check(/booking_bed_id:\s*bookingBedId/.test(moveFnBlock),
  'move-targets request includes selected booking_bed_id');
check(/bcLoadMoveTargets\(\)/.test(moveFnBlock),
  'bcLoadMoveTargets invoked from move panel');
check(/bcOnMoveSourcePillClick/.test(moveFnBlock) &&
      /bcRefreshMoveTargetField|bcLoadMoveTargets/.test(moveFnBlock),
  'source pill change triggers target reload');
check(!/\/staff\/bookings\/move-preview/.test(loadTargetsFn),
  'bcLoadMoveTargets does not call move-preview (bulk filter only)');
check(!/(forEach|for\s*\()[\s\S]{0,200}\/staff\/bookings\/move-preview/.test(moveFnBlock),
  'UI does not loop move-preview per bed');
check(!/\/staff\/bookings\/move-preview/.test(moveFnBlock),
  'Move bed UI does not call move-preview endpoint');

console.log('\nF. Dropdown filtering + fallback');

check(/function bcRenderMoveTargetsFiltered/.test(moveFnBlock),
  'bcRenderMoveTargetsFiltered helper present');
check(/t\.available/.test(moveFnBlock),
  'dropdown filters to available targets');
check(/Only available target beds are shown/.test(moveFnBlock),
  'helper text when hiding unavailable beds');
check(/function bcRenderMoveTargetFailed/.test(moveFnBlock),
  'failed-target renderer present');
check(/Could not load available beds/.test(moveFnBlock),
  'fallback message when move-targets fails');
check(/targetsLoadFailed/.test(moveFnBlock),
  'targetsLoadFailed keeps Move booking disabled on failure');
check(!/bcMoveBedTargetFieldHtml/.test(moveFnBlock),
  'no unfiltered legacy target dropdown fallback in move UI');
check(/bc-move-target-note/.test(drawerFn + moveFnBlock),
  'target note element in drawer');

console.log('\nG. Preview button removed + Move enablement');

check(!/id="bc-move-preview-btn"/.test(drawerFn),
  'visible Preview move button removed from drawer');
check(!/Preview move/.test(drawerFn),
  'Preview move label not rendered in Move bed panel');
check(!/previewCanMove/.test(moveFnBlock),
  'Move UI no longer depends on previewCanMove');
check(/function bcMoveInputsReadyForWrite/.test(moveFnBlock),
  'write readiness helper present');
check(/moveBtn\.disabled = busy \|\| !bcMoveInputsReadyForWrite\(\) \|\| !BC_BOOKING_MOVE_WRITE/.test(moveFnBlock),
  'Move booking enables from source + target + gate ON');
check(/function bcOnMoveTargetChange/.test(moveFnBlock),
  'target change handler updates Move booking enablement');
check(/bcClearMoveResult\(\)/.test(moveFnBlock) &&
      /bcOnMoveSourcePillClick/.test(moveFnBlock),
  'source change clears result and reloads targets');

console.log('\nH. Write endpoint remains final validation');

check(/function bcRunMoveWrite/.test(moveFnBlock),
  'bcRunMoveWrite present');
check(/\/staff\/bookings\/move['"]/.test(moveFnBlock),
  'Move booking POSTs /staff/bookings/move');
check(/booking_bed_id:\s*bookingBedId/.test(
  src.match(/function bcRunMoveWrite[\s\S]*?\n\}/)?.[0] || ''),
  'write request sends booking_bed_id');
check(/function moveWriteBuildConflicts/.test(src) &&
      /moveWriteBuildConflicts/.test(writeHandler),
  'write handler still rechecks conflicts');

console.log('\nI. Gate-off behavior');

check(/!BC_BOOKING_MOVE_WRITE/.test(moveFnBlock),
  'Move booking remains disabled when gate OFF');
check(/Move controls are disabled/.test(moveFnBlock + drawerFn),
  'gate-off message preserved');

console.log('\nJ. Safety — forbidden scope');

check(!/bc-move.*check_in|id="bc-move-check/.test(drawerFn + moveFnBlock),
  'no date-change UI inputs');
check(!/drag.?drop|Confirm Move|bcDragMove/i.test(drawerFn + moveFnBlock),
  'no drag/drop or Confirm Move modal');
check(!/graph\.facebook\.com/.test(drawerFn + moveFnBlock + targetsHandler),
  'no WhatsApp / graph.facebook.com');
check(!/api\.stripe\.com/.test(drawerFn + moveFnBlock + targetsHandler),
  'no Stripe / api.stripe.com');
check(!/n8n\.cloud|activate.*workflow/i.test(drawerFn + moveFnBlock + targetsHandler),
  'no n8n activation URL');
check(!/UPDATE payments|INSERT INTO payments|UPDATE booking_service_records|INSERT INTO booking_service_records/i.test(targetsHandler + moveFnBlock),
  'no payment or booking_service_records mutation');
check(!/resolveNaturalLanguageIntent|function alAsk/.test(moveFnBlock + targetsHandler),
  'no Ask Luna changes');

console.log('\nK. Migrations unchanged');

if (fs.existsSync(MIG_DIR)) {
  const migFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
  const migHit = migFiles.some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /move-targets|moveBuildTargetAvailability|10\.3h\.[45]/i.test(body);
  });
  check(!migHit, 'no new migration references move-targets');
} else {
  ok('migrations directory not present (skip)');
}

console.log('\nL. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-move-targets-ui'] ===
      'node scripts/verify-staff-booking-move-targets-ui.js',
    'package.json has verify:staff-booking-move-targets-ui script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
