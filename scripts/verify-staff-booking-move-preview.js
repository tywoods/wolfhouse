/**
 * Phase 10.2 — Static verifier for booking move preview endpoint.
 *
 * Usage:
 *   npm run verify:staff-booking-move-preview
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

console.log('\nverify-staff-booking-move-preview.js  (Phase 10.2)\n');

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

const handlerMatch = src.match(/async function handleBookingMovePreview[\s\S]*?(?=\r?\nasync function handleQuotePreview)/);
const handlerBlock = handlerMatch ? handlerMatch[0] : '';

console.log('\nA. Route + handler');

check(/\/staff\/bookings\/move-preview/.test(src),
  '/staff/bookings/move-preview route present');
check(/handleBookingMovePreview\s*\(/.test(src),
  'handleBookingMovePreview handler defined');
check(/pathname === '\/staff\/bookings\/move-preview'/.test(src),
  'move-preview pathname wired in router');
check(/method !== 'POST'/.test(src.slice(src.indexOf("'/staff/bookings/move-preview'"), src.indexOf("'/staff/bookings/move-preview'") + 600)),
  'move-preview route accepts POST only');

console.log('\nB. Preview response contract');

check(/preview_only:\s*true/.test(handlerBlock),
  'handler returns preview_only:true');
check(/would_mutate:\s*false/.test(handlerBlock),
  'handler returns would_mutate:false');
check(/can_move:/.test(handlerBlock),
  'handler returns can_move flag');
check(/Move preview passed\. No changes were made\./.test(handlerBlock),
  'allowed preview message present');
check(/Target bed is not available for this date range\. No changes were made\./.test(handlerBlock),
  'blocked preview message present');
check(/conflicts:/.test(handlerBlock),
  'handler returns conflicts array');

console.log('\nC. Input validation');

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

console.log('\nD. Conflict logic');

check(/function movePreviewHalfOpenOverlaps/.test(src),
  'half-open overlap helper present');
check(/existingStart < targetCheckOut && existingEnd > targetCheckIn/.test(src),
  'half-open overlap uses strict < and > (same-day turnover allowed)');
check(/assignment_start_date < \$4::date/.test(src),
  'SQL overlap uses assignment_start_date < check_out');
check(/assignment_end_date\s+>\s+\$3::date/.test(src),
  'SQL overlap uses assignment_end_date > check_in');
check(/row\.booking_id !== sourceBookingId/.test(handlerBlock),
  'self-booking conflict exclusion present');
check(/MOVE_PREVIEW_NON_BLOCKING_STATUSES/.test(src),
  'cancelled/expired assignments excluded from conflicts');

console.log('\nE. Write safety');

check(!/INSERT INTO|UPDATE\s+|DELETE FROM/i.test(handlerBlock),
  'no UPDATE/INSERT/DELETE in move-preview handler');
check(!/BEGIN|COMMIT|ROLLBACK/i.test(handlerBlock),
  'no transaction mutations in move-preview handler');
check(!/\/staff\/bookings\/move['"]|bookings\/move\/confirm|Confirm Move/i.test(src),
  'no booking move write/confirm route added in this slice');
check(!/INSERT INTO bookings|UPDATE bookings|DELETE FROM booking_beds|UPDATE booking_beds/i.test(handlerBlock),
  'handler does not mutate bookings or booking_beds');

console.log('\nF. Safety — no forbidden integrations');

check(!/graph\.facebook\.com/.test(handlerBlock),
  'move-preview handler has no graph.facebook.com');
check(!/api\.stripe\.com/.test(handlerBlock),
  'move-preview handler has no api.stripe.com');
check(!/n8n\.cloud|activate.*workflow/i.test(handlerBlock),
  'move-preview handler has no n8n activation URL');
check(!/resolveNaturalLanguageIntent|function alAsk/.test(handlerBlock),
  'no Ask Luna logic in move-preview handler');
check(!/UPDATE payments|INSERT INTO payments|booking_service_records/i.test(handlerBlock),
  'no payment or service-record mutation in move-preview handler');

console.log('\nG. Migrations unchanged');

if (fs.existsSync(MIG_DIR)) {
  const migFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
  const migHasMove = migFiles.some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /move-preview|booking_move/i.test(body);
  });
  check(!migHasMove, 'no new migration references booking move preview');
} else {
  ok('migrations directory not present (skip)');
}

console.log('\nH. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-move-preview'] ===
      'node scripts/verify-staff-booking-move-preview.js',
    'package.json has verify:staff-booking-move-preview script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
