/**
 * Phase 10.3b — Static verifier for booking move write endpoint.
 *
 * Usage:
 *   npm run verify:staff-booking-move-write
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

console.log('\nverify-staff-booking-move-write.js  (Phase 10.3b)\n');

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

const handlerMatch = src.match(/async function handleBookingMoveWrite[\s\S]*?(?=\r?\nasync function handleBookingMovePreview)/);
const handlerBlock = handlerMatch ? handlerMatch[0] : '';
const previewHandlerMatch = src.match(/async function handleBookingMovePreview[\s\S]*?(?=\r?\n\/\/ ─+\r?\n\/\/ Route: POST \/staff\/quote-preview)/);
const previewHandlerBlock = previewHandlerMatch ? previewHandlerMatch[0] : '';

console.log('\nA. Route + gate');

check(/\/staff\/bookings\/move/.test(src),
  'POST /staff/bookings/move route present');
check(/handleBookingMoveWrite\s*\(/.test(src),
  'handleBookingMoveWrite handler defined');
check(/pathname === '\/staff\/bookings\/move'/.test(src),
  'move write pathname wired in router');
check(/BOOKING_MOVE_WRITE_ENABLED/.test(src),
  'BOOKING_MOVE_WRITE_ENABLED gate exists');
check(/process\.env\.BOOKING_MOVE_WRITE_ENABLED === 'true'/.test(src),
  'BOOKING_MOVE_WRITE_ENABLED defaults OFF unless env true');
check(/booking_move_write_disabled/.test(handlerBlock),
  'disabled gate returns booking_move_write_disabled');
check(/enabled:\s*false/.test(handlerBlock),
  'disabled gate returns enabled:false');
check(/requireAuth\(req, res, 'operator'\)/.test(
  src.slice(src.indexOf("if (pathname === '/staff/bookings/move')"), src.indexOf("if (pathname === '/staff/bookings/move')") + 800)
),
  'move write route requires operator auth');

console.log('\nB. Request validation');

check(/idempotency_key is required/.test(handlerBlock),
  'idempotency_key required');
check(/client_slug is required/.test(handlerBlock),
  'client_slug required');
check(/booking_id or booking_code is required/.test(handlerBlock),
  'booking_id or booking_code required');
check(/target_bed_id is required/.test(handlerBlock),
  'target_bed_id required');
check(/check_in and check_out are required/.test(handlerBlock),
  'check_in and check_out required');
check(/check_out must be after check_in/.test(handlerBlock),
  'check_out after check_in enforced');

console.log('\nC. MVP scope — same dates + single bed');

check(/date_change_not_supported_in_phase_10_3/.test(handlerBlock),
  'date changes blocked/deferred in Phase 10.3');
check(/single_bed_booking_required/.test(handlerBlock),
  'single-bed requirement reason present');
check(/requires_manual_review:\s*true/.test(handlerBlock),
  'multi/no-bed returns requires_manual_review');
check(/sourceBeds\.length !== 1/.test(handlerBlock),
  'single-bed count check present');

console.log('\nD. Conflict recheck in write path');

check(/moveWriteBuildConflicts/.test(src),
  'shared conflict builder used by write handler');
check(/MOVE_PREVIEW_TARGET_ASSIGNMENTS_SQL/.test(handlerBlock),
  'write handler reuses move-preview assignment overlap SQL');
check(/movePreviewHalfOpenOverlaps/.test(src),
  'half-open overlap helper present');
check(/existingStart < targetCheckOut && existingEnd > targetCheckIn/.test(src),
  'half-open overlap uses strict < and > (same-day turnover allowed)');
check(/row\.booking_id !== sourceBookingId/.test(handlerBlock) ||
  /moveWriteBuildConflicts/.test(handlerBlock),
  'self-booking conflict exclusion in write flow');
check(/MOVE_PREVIEW_NON_BLOCKING_STATUSES/.test(src),
  'cancelled/expired assignments excluded from conflicts');
check(/await pg\.query\('BEGIN'\)/.test(handlerBlock),
  'write uses transaction BEGIN');
check(/conflicts\.length > 0/.test(handlerBlock),
  'conflict recheck blocks mutation');

console.log('\nE. Mutation — single booking_beds UPDATE only');

check(/MOVE_WRITE_UPDATE_BED_SQL/.test(handlerBlock),
  'exactly one booking_beds UPDATE SQL block in write handler');
check(!/INSERT INTO booking_beds/i.test(handlerBlock),
  'no INSERT booking_beds in move write handler');
check(!/DELETE FROM booking_beds/i.test(handlerBlock),
  'no DELETE booking_beds in move write handler');
check(!/UPDATE bookings/i.test(handlerBlock),
  'no bookings table UPDATE in move write handler');
check(/Booking moved\. No payment, service, or message changes were made\./.test(handlerBlock),
  'success message says no payment/service/message changes');

console.log('\nF. Success response contract');

check(/moved:\s*true/.test(handlerBlock),
  'success response includes moved:true');
check(/preview_only:\s*false/.test(handlerBlock),
  'success response includes preview_only:false');
check(/would_mutate:\s*true/.test(handlerBlock),
  'success response includes would_mutate:true on move');
check(/previous_assignment:/.test(handlerBlock),
  'response includes previous_assignment');
check(/new_assignment:/.test(handlerBlock),
  'response includes new_assignment');
check(/idempotent:\s*true/.test(handlerBlock),
  'idempotent already-at-target path present');
check(/appendAuditLog/.test(handlerBlock),
  'write handler uses appendAuditLog');

console.log('\nG. Preview route unchanged');

check(/handleBookingMovePreview/.test(src),
  'move-preview handler still present');
check(!/UPDATE booking_beds/i.test(previewHandlerBlock),
  'move-preview handler still has no booking_beds UPDATE');
check(/preview_only:\s*true/.test(previewHandlerBlock),
  'move-preview still returns preview_only:true');

console.log('\nH. Safety — no forbidden integrations');

check(!/graph\.facebook\.com/.test(handlerBlock),
  'move write handler has no graph.facebook.com');
check(!/api\.stripe\.com/.test(handlerBlock),
  'move write handler has no api.stripe.com');
check(!/n8n\.cloud|activate.*workflow/i.test(handlerBlock),
  'move write handler has no n8n activation URL');
check(!/resolveNaturalLanguageIntent|function alAsk/.test(handlerBlock),
  'no Ask Luna logic in move write handler');
check(!/UPDATE payments|INSERT INTO payments|booking_service_records/i.test(handlerBlock),
  'no payment or service-record mutation in move write handler');

console.log('\nI. No UI changes');

check(/id="bc-move-booking-btn"|Move booking/.test(src),
  'Phase 10.3e drawer Move booking control present');
check(!/Confirm Move|bcDragMove|drag.?drop.*move/i.test(src),
  'no Confirm Move modal or drag/drop move UI');

console.log('\nJ. Migrations unchanged');

if (fs.existsSync(MIG_DIR)) {
  const migFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
  const migHasMoveWrite = migFiles.some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /booking_move_write|POST \/staff\/bookings\/move/i.test(body);
  });
  check(!migHasMoveWrite, 'no new migration references booking move write');
} else {
  ok('migrations directory not present (skip)');
}

console.log('\nK. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-move-write'] ===
      'node scripts/verify-staff-booking-move-write.js',
    'package.json has verify:staff-booking-move-write script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
