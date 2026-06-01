/**
 * Stage 7.7i — Static verifier for the booking context API endpoint in
 * scripts/staff-query-api.js.
 *
 * Checks (26 total):
 *   1–3:   File exists, readable, passes node --check
 *   4:     staff-booking-detail-queries required
 *   5–10:  All 6 query helpers imported/referenced
 *  11:     BOOKING_CONTEXT_RE route pattern present
 *  12:     handleBookingContext handler defined
 *  13:     Route wired in router
 *  14:     bookingCode path param extracted from regex
 *  15:     client param scoping present
 *  16:     404 returned when booking not found
 *  17:     Audit intent api:booking_context
 *  18:     Audit category booking_context_api
 *  19:     Response includes booking / payments / rooming / conversation / handoff / addons
 *  20:     requireAuth called for booking context route
 *  21:     No POST/PATCH/DELETE route for bookings context
 *  22:     No edit/reassign/cancel endpoint
 *  23:     No UPDATE bookings in handler
 *  24:     No UPDATE booking_beds in handler
 *  25:     No eval() in handler
 *  26:     package.json has verify:staff-booking-detail-api script
 *
 * Usage:
 *   node scripts/verify-staff-booking-detail-api.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0, failures = 0;
function ok(msg)   { console.log('  PASS  ' + msg); passes++; }
function fail(msg) { console.error('  FAIL  ' + msg); failures++; }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

console.log('\nverify-staff-booking-detail-api.js  (Stage 7.7i)\n');

// 1. File exists
check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

// 2. Readable
const src = fs.readFileSync(API_FILE, 'utf8');
check(src.length > 10000, 'File is readable and non-trivial length');

// 3. Syntax clean
try { execSync('node --check "' + API_FILE + '"', { stdio: 'ignore' }); ok('Passes node --check'); }
catch (_) { fail('Passes node --check'); }

// 4. staff-booking-detail-queries required
check(/require.*staff-booking-detail-queries/.test(src),
  'staff-booking-detail-queries required in API file');

// 5–10. All 6 query helpers referenced
[
  'getBookingDetailQuery',
  'getBookingPaymentsQuery',
  'getBookingRoomingAssignmentsQuery',
  'getBookingConversationQuery',
  'getBookingHandoffQuery',
  'getBookingAddOnSummaryQuery',
].forEach(function(name) {
  check(src.indexOf(name) >= 0, name + ' referenced in API file');
});

// 11. BOOKING_CONTEXT_RE route regex present
check(/BOOKING_CONTEXT_RE/.test(src),
  'BOOKING_CONTEXT_RE route regex defined');

// 12. handleBookingContext handler
check(/async function handleBookingContext/.test(src),
  'handleBookingContext async function defined');

// 13. Route wired in router
check(/BOOKING_CONTEXT_RE\.exec\(pathname\)|bookingCtxMatch/.test(src),
  'Booking context route wired in router');

// 14. bookingCode extracted from regex match
check(/bookingCtxMatch\[1\]|match\[1\]/.test(src),
  'bookingCode extracted from regex match');

// 15. client param used for scoping
check(/clientSlug.*DEFAULT_CLIENT|DEFAULT_CLIENT.*clientSlug/.test(src),
  'client param used for scoping (DEFAULT_CLIENT fallback present)');

// 16. 404 returned for missing booking
check(/sendJSON\(res,\s*404/.test(src) || /404.*not found/i.test(src),
  '404 returned when booking not found');

// 17. Audit intent api:booking_context
check(/api:booking_context/.test(src),
  "Audit intent 'api:booking_context' present");

// 18. Audit category booking_context_api
check(/booking_context_api/.test(src),
  "Audit category 'booking_context_api' present");

// 19. Response includes expected sections
check(/booking:/.test(src) && /payments:/.test(src) && /rooming:/.test(src) &&
      /conversation:/.test(src) && /handoff:/.test(src) && /addons:/.test(src),
  'Response shape includes booking/payments/rooming/conversation/handoff/addons');

// 20. requireAuth called for booking context route
check(/requireAuth/.test(src.slice(src.indexOf('handleBookingContext') - 200)),
  'requireAuth called for booking context route');

// 21. No POST/PATCH/DELETE booking route
const handlerRegion = src.slice(src.indexOf('handleBookingContext') || 0);
check(!/method.*POST.*bookings|method.*PATCH.*bookings|method.*DELETE.*bookings/i.test(handlerRegion),
  'No POST/PATCH/DELETE bookings route in handler region');

// 22. No edit/reassign/cancel endpoint
check(!/\/staff\/bookings\/.*\/edit|\/staff\/bookings\/.*\/reassign|\/staff\/bookings\/.*\/cancel/.test(src),
  'No edit/reassign/cancel endpoint for bookings');

// 23. No UPDATE bookings in handler
check(!/UPDATE\s+bookings/i.test(handlerRegion),
  'No UPDATE bookings in handleBookingContext region');

// 24. No UPDATE booking_beds in handler
check(!/UPDATE\s+booking_beds/i.test(handlerRegion),
  'No UPDATE booking_beds in handleBookingContext region');

// 25. No eval()
check(!/\beval\s*\(/.test(handlerRegion),
  'No eval() in handleBookingContext region');

// 26. package.json script present
let pkg;
try { pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')); } catch (_) { pkg = {}; }
check(!!(pkg.scripts && pkg.scripts['verify:staff-booking-detail-api']),
  'package.json has verify:staff-booking-detail-api script');

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
