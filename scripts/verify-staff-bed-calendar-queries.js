/**
 * Stage 7.7g — Static verifier for staff-bed-calendar-queries.js
 *
 * Checks (25 total):
 *   1–4:   File exists, readable, syntax-clean, no mutation keywords
 *   5–7:   Module loads, exports expected functions
 *   8–10:  getBedCalendarRoomsQuery — SELECT-only, client-scoped, rooms/beds referenced
 *  11–14:  getBedCalendarBlocksQuery — SELECT-only, scoped, booking_beds + bookings, date params
 *  15–16:  getBedCalendarSummaryQuery — SELECT-only, date params
 *  17–18:  No eval / no execSync
 *  19–20:  Overlap filter uses half-open interval pattern
 *  21–22:  ORDER BY present in rooms and blocks queries
 *  23–25:  Status filter excludes cancelled/expired; $1 client scoping; no INSERT/UPDATE/DELETE
 *
 * Usage:
 *   node scripts/verify-staff-bed-calendar-queries.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const QFILE = path.join(__dirname, 'lib', 'staff-bed-calendar-queries.js');

let passes = 0;
let failures = 0;

function ok(msg)  { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg){ console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-bed-calendar-queries.js  (Stage 7.7g)\n');

// 1. File exists
check(fs.existsSync(QFILE), 'staff-bed-calendar-queries.js exists');
if (!fs.existsSync(QFILE)) { process.exit(1); }

// 2. Readable
const src = fs.readFileSync(QFILE, 'utf8');
check(src.length > 500, 'File is readable and non-trivial');

// 3. Syntax clean
try {
  execSync(`node --check "${QFILE}"`, { stdio: 'ignore' });
  ok('Passes node --check');
} catch (_) {
  fail('Passes node --check');
}

// 4. No mutation keywords in SQL strings (rough check)
const MUTATION_RE = /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i;
check(!MUTATION_RE.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')),
  'No mutation SQL keywords in source');

// 5. Module loads without error
let mod;
try {
  mod = require(QFILE);
  ok('Module loads without error');
} catch (e) {
  fail('Module loads without error: ' + e.message);
  process.exit(1);
}

// 6. Exports getBedCalendarRoomsQuery
check(typeof mod.getBedCalendarRoomsQuery === 'function',
  'getBedCalendarRoomsQuery exported as function');

// 7. Exports getBedCalendarBlocksQuery
check(typeof mod.getBedCalendarBlocksQuery === 'function',
  'getBedCalendarBlocksQuery exported as function');

// ── getBedCalendarRoomsQuery checks ──────────────────────────────────────────

const roomsSql = mod.getBedCalendarRoomsQuery();

// 8. Returns non-empty string
check(typeof roomsSql === 'string' && roomsSql.length > 50,
  'getBedCalendarRoomsQuery returns non-empty string');

// 9. Is a SELECT query
check(/^\s*SELECT/i.test(roomsSql), 'getBedCalendarRoomsQuery starts with SELECT');

// 10. References rooms AND beds tables
check(/\brooms\b/i.test(roomsSql) && /\bbeds\b/i.test(roomsSql),
  'getBedCalendarRoomsQuery references rooms and beds tables');

// 11. Client-scoped via $1
check(/\$1/.test(roomsSql) && /clients\b/i.test(roomsSql),
  'getBedCalendarRoomsQuery is client-scoped ($1 + clients join)');

// ── getBedCalendarBlocksQuery checks ─────────────────────────────────────────

const blocksSql = mod.getBedCalendarBlocksQuery();

// 12. Returns non-empty string
check(typeof blocksSql === 'string' && blocksSql.length > 50,
  'getBedCalendarBlocksQuery returns non-empty string');

// 13. Is a SELECT query
check(/^\s*SELECT/i.test(blocksSql), 'getBedCalendarBlocksQuery starts with SELECT');

// 14. References booking_beds AND bookings
check(/\bbooking_beds\b/i.test(blocksSql) && /\bbookings\b\s/i.test(blocksSql),
  'getBedCalendarBlocksQuery references booking_beds and bookings');

// 15. Half-open interval overlap filter ($2 and $3)
check(/\$2/.test(blocksSql) && /\$3/.test(blocksSql),
  'getBedCalendarBlocksQuery uses $2 (start_date) and $3 (end_date) params');

// 16. Overlap uses < and > (half-open pattern)
check(/assignment_start_date\s*<\s*\$3/i.test(blocksSql) &&
      /assignment_end_date\s*>\s*\$2/i.test(blocksSql),
  'getBedCalendarBlocksQuery uses half-open overlap (start < end_param AND end > start_param)');

// ── getBedCalendarSummaryQuery checks (optional helper) ──────────────────────

// 17. If exported, is SELECT-only
if (typeof mod.getBedCalendarSummaryQuery === 'function') {
  const sumSql = mod.getBedCalendarSummaryQuery();
  check(/^\s*SELECT/i.test(sumSql), 'getBedCalendarSummaryQuery starts with SELECT');
  check(/\$2/.test(sumSql) && /\$3/.test(sumSql),
    'getBedCalendarSummaryQuery has $2/$3 date params');
} else {
  ok('getBedCalendarSummaryQuery not exported (optional — skipped)');
  ok('getBedCalendarSummaryQuery not exported (optional — skipped)');
}

// ── Safety checks ────────────────────────────────────────────────────────────

// 19. No eval
check(!/\beval\s*\(/.test(src), 'No eval() in source');

// 20. No execSync / child_process
check(!/execSync|spawnSync|child_process/.test(src), 'No execSync/child_process in source');

// 21. Rooms query has ORDER BY
check(/ORDER BY/i.test(roomsSql), 'getBedCalendarRoomsQuery has ORDER BY');

// 22. Blocks query has ORDER BY
check(/ORDER BY/i.test(blocksSql), 'getBedCalendarBlocksQuery has ORDER BY');

// 23. Blocks query excludes cancelled/expired bookings
check(/cancelled|expired/i.test(blocksSql),
  "getBedCalendarBlocksQuery filters out cancelled/expired bookings");

// 24. Rooms query filters active rooms
check(/active\s*=\s*TRUE/i.test(roomsSql) || /r\.active/i.test(roomsSql),
  'getBedCalendarRoomsQuery filters active rooms');

// 25. $1 present in both queries
check(/\$1/.test(roomsSql) && /\$1/.test(blocksSql),
  '$1 client slug parameter present in both rooms and blocks queries');

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
