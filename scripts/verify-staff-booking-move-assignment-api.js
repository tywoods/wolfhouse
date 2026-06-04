/**
 * Phase 10.3g / 10.3h.1 — Static verifier for assignment-scoped booking move API.
 *
 * Source-bed pill UI is covered by verify-staff-booking-move-assignment-ui.js (10.3h).
 *
 * Usage:
 *   npm run verify:staff-booking-move-assignment-api
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

console.log('\nverify-staff-booking-move-assignment-api.js  (Phase 10.3g / 10.3h.1)\n');

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

const previewHandler = src.match(/async function handleBookingMovePreview[\s\S]*?(?=\r?\n\/\/ ─+\r?\n\/\/ Phase 10\.4b)/)?.[0] || '';
const writeHandler   = src.match(/async function handleBookingMoveWrite[\s\S]*?(?=\r?\nasync function handleBookingMoveTargets)/)?.[0] || '';
const sharedBlock    = src.slice(src.indexOf('function moveResolveSourceBed'), src.indexOf('async function handleBookingMoveWrite'));

console.log('\nA. Request field booking_bed_id');

check(/body\.booking_bed_id/.test(previewHandler), 'move-preview reads booking_bed_id from body');
check(/body\.booking_bed_id/.test(writeHandler), 'move-write reads booking_bed_id from body');
check(/booking_bed_id must be a valid UUID/.test(previewHandler + writeHandler),
  'booking_bed_id UUID validation present');

console.log('\nB. Multi-bed requires_selection response');

check(/function moveResolveSourceBed/.test(src), 'moveResolveSourceBed helper present');
check(/requires_selection:\s*true/.test(previewHandler + writeHandler),
  'requires_selection:true in preview and write handlers');
check(/booking_bed_selection_required/.test(sharedBlock + previewHandler + writeHandler),
  'reason booking_bed_selection_required present');
check(/assignments:/.test(previewHandler + writeHandler),
  'assignments array returned when selection required');
check(/function moveFormatAssignmentOptions/.test(src),
  'assignment option formatter present');
check(/booking_bed_id:/.test(src.match(/function moveFormatAssignmentOptions[\s\S]*?\n\}/)?.[0] || ''),
  'assignment objects include booking_bed_id');
check(/bed_id:/.test(src.match(/function moveFormatAssignmentOptions[\s\S]*?\n\}/)?.[0] || ''),
  'assignment objects include bed_id');
check(/bed_code:/.test(src.match(/function moveFormatAssignmentOptions[\s\S]*?\n\}/)?.[0] || ''),
  'assignment objects include bed_code');
check(/room_code:/.test(src.match(/function moveFormatAssignmentOptions[\s\S]*?\n\}/)?.[0] || ''),
  'assignment objects include room_code');
check(/check_in:/.test(src.match(/function moveFormatAssignmentOptions[\s\S]*?\n\}/)?.[0] || ''),
  'assignment objects include check_in');
check(/check_out:/.test(src.match(/function moveFormatAssignmentOptions[\s\S]*?\n\}/)?.[0] || ''),
  'assignment objects include check_out');

console.log('\nC. booking_bed_id ownership validation');

check(/booking_bed_id not found for this booking/.test(sharedBlock),
  'invalid booking_bed_id rejected with clear error');
check(/sourceBeds\.find/.test(sharedBlock),
  'booking_bed_id matched against booking source rows');

console.log('\nD. Assignment-scoped write (single row UPDATE)');

check(/MOVE_WRITE_UPDATE_BED_SQL/.test(writeHandler),
  'write uses single booking_beds UPDATE by id');
check(/sourceBed\.booking_bed_id/.test(writeHandler),
  'write passes selected booking_bed_id to UPDATE');
check(/const sourceBookingId = bookingRow\.booking_id/.test(writeHandler),
  'sourceBookingId defined from bookingRow.booking_id (10.3i.1)');
check(/sourceBookingId,/.test(writeHandler),
  'UPDATE path uses sourceBookingId for booking ownership check');
check(!/INSERT INTO booking_beds/i.test(writeHandler),
  'no INSERT booking_beds in move write');
check(!/DELETE FROM booking_beds/i.test(writeHandler),
  'no DELETE booking_beds in move write');
check(!/UPDATE booking_beds[\s\S]*WHERE[\s\S]*booking_id = \$6::uuid[\s\S]*;[\s\S]*UPDATE booking_beds/.test(writeHandler),
  'no broad multi-row booking_beds UPDATE pattern');

console.log('\nE. Conflict + idempotency');

check(/function moveWriteBuildConflicts/.test(src),
  'shared conflict builder present');
check(/row\.booking_bed_id !== excludeId/.test(src),
  'conflicts exclude selected booking_bed_id only');
check(/existingStart < targetCheckOut && existingEnd > targetCheckIn/.test(src),
  'half-open overlap unchanged (same-day turnover allowed)');
check(/idempotent:\s*true/.test(writeHandler + previewHandler),
  'idempotent path retained');

console.log('\nF. Context payload for assignment UI');

check(/BOOKING_CONTEXT_ROOMING_SQL/.test(src),
  'booking context rooming SQL includes bed_id for assignment UI');
check(/bb\.bed_id::text\s+AS bed_id/.test(src),
  'context rooming query selects bed_id');
check(/AS check_in/.test(src.match(/BOOKING_CONTEXT_ROOMING_SQL = `[\s\S]*?`;/m)?.[0] || ''),
  'context assignments expose check_in alias');

console.log('\nG. Gate (API scope only)');

check(/BOOKING_MOVE_WRITE_ENABLED/.test(src),
  'BOOKING_MOVE_WRITE_ENABLED gate remains');
check(!/bc-move-source-pill|bcRenderMoveSourcePillsHtml/.test(previewHandler + writeHandler),
  'move API handlers do not embed source-bed UI (UI covered by assignment-ui verifier)');
check(
  fs.existsSync(path.join(__dirname, 'verify-staff-booking-move-assignment-ui.js')),
  'source-bed pill UI delegated to verify-staff-booking-move-assignment-ui.js'
);

console.log('\nH. Safety — scope boundaries');

check(!/graph\.facebook\.com/.test(previewHandler + writeHandler),
  'no graph.facebook.com');
check(!/api\.stripe\.com/.test(previewHandler + writeHandler),
  'no api.stripe.com');
check(!/n8n\.cloud|activate.*workflow/i.test(previewHandler + writeHandler),
  'no n8n activation URL');
check(!/UPDATE payments|INSERT INTO payments|UPDATE booking_service_records|INSERT INTO booking_service_records/i.test(previewHandler + writeHandler),
  'no payment or service-record mutation in move handlers');
check(!/resolveNaturalLanguageIntent|function alAsk/.test(previewHandler + writeHandler),
  'no Ask Luna changes in move handlers');
check(!/date-change-preview|handleBookingDateChangePreview|new_check_in/.test(previewHandler + writeHandler),
  'no date-change logic in move handlers');
check(!/bcDragMove|drag.?drop.*move/i.test(previewHandler + writeHandler),
  'no drag/drop move UI');

console.log('\nI. Migrations unchanged');

if (fs.existsSync(MIG_DIR)) {
  const migFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
  const migHit = migFiles.some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /10\.3g|booking_bed_selection_required|requires_selection/i.test(body);
  });
  check(!migHit, 'no new migration references assignment move API');
} else {
  ok('migrations directory not present (skip)');
}

console.log('\nJ. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-move-assignment-api'] ===
      'node scripts/verify-staff-booking-move-assignment-api.js',
    'package.json has verify:staff-booking-move-assignment-api script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
