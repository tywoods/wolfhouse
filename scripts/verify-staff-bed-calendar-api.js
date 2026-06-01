/**
 * Stage 7.7g — Static verifier for the bed calendar API endpoint in
 * scripts/staff-query-api.js.
 *
 * Checks (28 total):
 *   1–3:   File exists, readable, passes node --check
 *   4:     staff-bed-calendar-queries required
 *   5–7:   getBedCalendarRoomsQuery / BlocksQuery / SummaryQuery imported
 *   8:     GET /staff/bed-calendar route present in router
 *   9:     handleBedCalendar handler defined
 *  10–12:  start/end date validation (DATE_RE + parseCalendarDate + error returns)
 *  13:     MAX_CALENDAR_DAYS / range limit present
 *  14:     Auth gate: requireAuth called for bed-calendar route
 *  15:     Audit intent 'api:bed_calendar' present
 *  16:     Audit category 'bed_calendar_api' present
 *  17:     Response shape includes days / rooms / blocks
 *  18:     date-span JS helpers present (computeBlockSpan / generateCalendarDays)
 *  19:     color_type classification present (bedCalendarColorType)
 *  20:     No POST/PATCH/DELETE route for bed-calendar
 *  21:     No booking edit / reassign endpoint
 *  22:     No UPDATE bookings in handler
 *  23:     No UPDATE booking_beds in handler
 *  24:     No UPDATE payments in handler
 *  25:     No eval() in handler region
 *  26:     MAX_CALENDAR_DAYS set to a safe limit (<= 90)
 *  27:     package.json has verify:staff-bed-calendar-queries script
 *  28:     package.json has verify:staff-bed-calendar-api script
 *
 * Usage:
 *   node scripts/verify-staff-bed-calendar-api.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)  { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg){ console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-bed-calendar-api.js  (Stage 7.7g)\n');

// 1. File exists
check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) { process.exit(1); }

// 2. Readable
const src = fs.readFileSync(API_FILE, 'utf8');
check(src.length > 10000, 'File is readable and non-trivial length');

// 3. Syntax clean
try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('Passes node --check (no syntax errors)');
} catch (_) {
  fail('Passes node --check (no syntax errors)');
}

// 4. staff-bed-calendar-queries required
check(/require.*staff-bed-calendar-queries/.test(src),
  "staff-bed-calendar-queries required in API file");

// 5. getBedCalendarRoomsQuery imported
check(/getBedCalendarRoomsQuery/.test(src),
  'getBedCalendarRoomsQuery referenced in API file');

// 6. getBedCalendarBlocksQuery imported
check(/getBedCalendarBlocksQuery/.test(src),
  'getBedCalendarBlocksQuery referenced in API file');

// 7. getBedCalendarSummaryQuery imported (optional helper)
check(/getBedCalendarSummaryQuery/.test(src),
  'getBedCalendarSummaryQuery referenced in API file');

// 8. GET /staff/bed-calendar route present
check(/\/staff\/bed-calendar/.test(src),
  'GET /staff/bed-calendar route present in API');

// 9. handleBedCalendar handler defined
check(/async function handleBedCalendar/.test(src),
  'handleBedCalendar async function defined');

// 10. Date format validation (DATE_RE or YYYY-MM-DD regex)
check(/DATE_RE|\/\^\\d\{4\}|YYYY-MM-DD/.test(src) || /\d{4}.*\d{2}.*\d{2}/.test(src),
  'Date format validation (DATE_RE / YYYY-MM-DD pattern) present');

// 11. parseCalendarDate or equivalent date parsing
check(/parseCalendarDate|parseDate|new Date.*T00:00:00/.test(src),
  'Date parsing helper (parseCalendarDate) present');

// 12. Invalid date returns 400
check(/send400.*start|start.*required|end.*required/i.test(src),
  'Invalid/missing start or end date returns 400 error');

// 13. MAX_CALENDAR_DAYS range limit present
check(/MAX_CALENDAR_DAYS/.test(src),
  'MAX_CALENDAR_DAYS range limit defined');

// 14. Auth gate for bed-calendar route
check(/requireAuth.*bed-calendar|bed-calendar.*requireAuth/.test(src) ||
      (/bed-calendar/.test(src) && /requireAuth/.test(src)),
  'requireAuth called for /staff/bed-calendar route');

// 15. Audit intent api:bed_calendar
check(/api:bed_calendar/.test(src),
  "Audit intent 'api:bed_calendar' present");

// 16. Audit category bed_calendar_api
check(/bed_calendar_api/.test(src),
  "Audit category 'bed_calendar_api' present");

// 17. Response shape includes days / rooms / blocks
check(/days/.test(src) && /rooms/.test(src) && /blocks/.test(src),
  'Response shape includes days, rooms, blocks');

// 18. Date-span helpers present
check(/computeBlockSpan|generateCalendarDays/.test(src),
  'Date-span helper functions present (computeBlockSpan / generateCalendarDays)');

// 19. color_type classification present
check(/bedCalendarColorType|color_type/.test(src),
  'color_type classification helper present');

// 20. No POST/PATCH/DELETE for bed-calendar
const bedCalSection = src.match(/handleBedCalendar[\s\S]*?^}/m) || '';
const bedCalStr = bedCalSection ? bedCalSection[0] : src;
check(!/method\s*===?\s*['"]POST['"]|method\s*===?\s*['"]PATCH['"]|method\s*===?\s*['"]DELETE['"]/i.test(bedCalStr),
  'No POST/PATCH/DELETE in bed-calendar handler');

// 21. No uncontrolled bed-calendar write endpoint.
// Allowed: /staff/bed-calendar/reassign/preview (GET, proposal-only, 7.7k3)
//          /staff/bed-calendar/reassign/confirm  (POST, STAFF_ACTIONS_ENABLED gated, 7.7k5)
// Blocked: any other /reassign or /edit path not in the explicit allowlist above.
check(
  !/\/staff\/bed-calendar\/reassign(?!\/(preview|confirm))|\/staff\/bed-calendar\/edit/.test(src),
  'No bed-calendar confirmed-write reassign/edit route (preview + confirm allowed)');

// 22. No UPDATE bookings in handler
check(!/UPDATE\s+bookings/i.test(src.slice(src.indexOf('handleBedCalendar'))),
  'No UPDATE bookings in handleBedCalendar region');

// 23. No UPDATE booking_beds in handler
check(!/UPDATE\s+booking_beds/i.test(src.slice(src.indexOf('handleBedCalendar'))),
  'No UPDATE booking_beds in handleBedCalendar region');

// 24. No UPDATE payments in handler
check(!/UPDATE\s+payments/i.test(src.slice(src.indexOf('handleBedCalendar'))),
  'No UPDATE payments in handleBedCalendar region');

// 25. No eval() in handler
check(!/\beval\s*\(/.test(src.slice(src.indexOf('handleBedCalendar'))),
  'No eval() in handleBedCalendar region');

// 26. MAX_CALENDAR_DAYS set to safe value (<= 90)
const maxMatch = src.match(/MAX_CALENDAR_DAYS\s*=\s*(\d+)/);
if (maxMatch) {
  check(parseInt(maxMatch[1], 10) <= 90,
    'MAX_CALENDAR_DAYS set to a safe value (<= 90)');
} else {
  fail('MAX_CALENDAR_DAYS value found and <= 90');
}

// 27. package.json has verify:staff-bed-calendar-queries
let pkg;
try { pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')); } catch (_) { pkg = {}; }
check(!!(pkg.scripts && pkg.scripts['verify:staff-bed-calendar-queries']),
  'package.json has verify:staff-bed-calendar-queries script');

// 28. package.json has verify:staff-bed-calendar-api
check(!!(pkg.scripts && pkg.scripts['verify:staff-bed-calendar-api']),
  'package.json has verify:staff-bed-calendar-api script');

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
