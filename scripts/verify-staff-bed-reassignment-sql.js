/**
 * Stage 7.7k1 — Static verifier for staff-bed-reassignment-sql.js
 *
 * Checks (30 total):
 *   1–5:   File exists, readable, syntax-clean, module loads, exports present
 *   6:     NOT WIRED / NOT RUNTIME header present
 *   7:     Does NOT import or reference reassign-booking-beds-pg-sql.js
 *   8:     SQL requires caller to wrap in BEGIN/COMMIT (transaction comment)
 *   9:     booking_beds UPDATE present exactly once
 *  10:     No DELETE FROM booking_beds
 *  11:     No INSERT INTO booking_beds
 *  12:     No DROP / TRUNCATE / ALTER
 *  13:     No mutation of payments or payment_events
 *  14:     No mutation of conversations
 *  15:     client_slug / client scoping ($1 + clients join) present
 *  16:     Staff role operator/admin/owner guard present in SQL
 *  17:     confirm boolean guard ($8) present
 *  18:     Overlap check: assignment_start_date < ... present (start < proposed_end)
 *  19:     Overlap check: assignment_end_date > ... present (end > proposed_start)
 *  20:     Overlap check excludes current row (existing.id != current_booking_bed_id)
 *  21:     FOR UPDATE (row-level lock) present
 *  22:     Target bed lookup present (beds table referenced)
 *  23:     Booking status cancelled/expired blocker present
 *  24:     needs_review blocker present
 *  25:     audit_payload present in SQL and return
 *  26:     rollback_payload present in SQL and return
 *  27:     Parameters $1 through $7 all present
 *  28:     No raw string interpolation (template literals interpolating SQL ids)
 *  29:     REASSIGN_BLOCK_CODES exported
 *  30:     package.json has verify:staff-bed-reassignment-sql script
 *
 * Usage:
 *   node scripts/verify-staff-bed-reassignment-sql.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const SQL_FILE = path.join(__dirname, 'lib', 'staff-bed-reassignment-sql.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0, failures = 0;
function ok(msg)   { console.log('  PASS  ' + msg); passes++; }
function fail(msg) { console.error('  FAIL  ' + msg); failures++; }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

console.log('\nverify-staff-bed-reassignment-sql.js  (Stage 7.7k1)\n');

// 1. File exists
check(fs.existsSync(SQL_FILE), 'staff-bed-reassignment-sql.js exists');
if (!fs.existsSync(SQL_FILE)) process.exit(1);

// 2. Readable
const src = fs.readFileSync(SQL_FILE, 'utf8');
check(src.length > 1000, 'File is readable and non-trivial');

// 3. Syntax clean
try { execSync('node --check "' + SQL_FILE + '"', { stdio: 'ignore' }); ok('Passes node --check'); }
catch (_) { fail('Passes node --check'); }

// 4. Module loads
let mod;
try { mod = require(SQL_FILE); ok('Module loads without error'); }
catch (e) { fail('Module loads: ' + e.message); process.exit(1); }

// 5. Exports present
check(typeof mod.reassignBookingBedSql === 'function',
  'reassignBookingBedSql exported as function');

// Pull the SQL string for all subsequent checks
const sql = mod.reassignBookingBedSql();
check(typeof sql === 'string' && sql.length > 500,
  'reassignBookingBedSql() returns a non-trivial SQL string');

// Strip SQL line comments (-- ...) before checking for forbidden keywords
// so that doc-comments like "-- No DELETE FROM..." don't cause false positives.
const sqlStripped = sql.replace(/--[^\n]*/g, '');

// 6. NOT WIRED header
check(/NOT WIRED.*NOT RUNTIME|NOT RUNTIME.*NOT WIRED/i.test(src),
  'NOT WIRED / NOT RUNTIME header present');

// 7. Does NOT require() the bot reset path (doc comments mentioning it are fine)
check(!/require\s*\(\s*['"][^'"]*reassign-booking-beds-pg-sql/.test(src),
  'Does NOT require() reassign-booking-beds-pg-sql.js (bot reset path)');

// 8. Transaction requirement documented
check(/BEGIN.*COMMIT|COMMIT.*BEGIN|transaction/i.test(sql),
  'SQL documents BEGIN/COMMIT transaction requirement for caller');

// 9. booking_beds UPDATE present exactly once
const updateMatches = (sql.match(/\bUPDATE\s+booking_beds\b/gi) || []).length;
check(updateMatches === 1,
  'UPDATE booking_beds appears exactly once (got ' + updateMatches + ')');

// 10. No DELETE FROM booking_beds (check stripped SQL, excluding line comments)
check(!/DELETE\s+FROM\s+booking_beds/i.test(sqlStripped),
  'No DELETE FROM booking_beds (excluding comments)');

// 11. No INSERT INTO booking_beds
check(!/INSERT\s+INTO\s+booking_beds/i.test(sqlStripped),
  'No INSERT INTO booking_beds (excluding comments)');

// 12. No DROP / TRUNCATE / ALTER in SQL (excluding comments)
check(!/\b(DROP|TRUNCATE|ALTER)\b/i.test(sqlStripped),
  'No DROP / TRUNCATE / ALTER in SQL (excluding comments)');

// 13. No payment table mutations
check(!/UPDATE\s+payments|UPDATE\s+payment_events|INSERT\s+INTO\s+payments|INSERT\s+INTO\s+payment_events/i.test(sql),
  'No mutation of payments or payment_events');

// 14. No conversations mutation
check(!/UPDATE\s+conversations|INSERT\s+INTO\s+conversations/i.test(sql),
  'No mutation of conversations table');

// 15. client_slug scoping ($1 + clients join)
check(/\$1/.test(sql) && /\bclients\b/i.test(sql),
  'client_slug scoping present ($1 and clients table)');

// 16. Staff role check in SQL
check(/operator.*admin.*owner|NOT IN.*operator|staff_role/i.test(sql),
  "Staff role operator/admin/owner check present in SQL");

// 17. Confirm boolean guard ($8)
check(/\$8.*boolean|\$8::boolean|confirm/i.test(sql),
  'Confirm boolean guard ($8) present in SQL');

// 18. Overlap check: start < proposed_end
check(/assignment_start_date\s*<\s*ca\.assignment_end_date|start_date\s*<\s*.*end_date/i.test(sql),
  'Overlap check: assignment_start_date < proposed_end present');

// 19. Overlap check: end > proposed_start
check(/assignment_end_date\s*>\s*ca\.assignment_start_date|end_date\s*>\s*.*start_date/i.test(sql),
  'Overlap check: assignment_end_date > proposed_start present');

// 20. Overlap excludes current row
check(/!=\s*ca\.booking_bed_id|<>\s*ca\.booking_bed_id/i.test(sql),
  'Overlap check excludes current booking_beds row (id != ca.booking_bed_id)');

// 21. FOR UPDATE row lock present
check(/FOR UPDATE/i.test(sql),
  'FOR UPDATE row-level lock present');

// 22. Target bed lookup (beds table)
check(/\bbeds\b/i.test(sql) && /target_bed/i.test(sql),
  'Target bed lookup present (beds table + target_bed CTE)');

// 23. Booking status cancelled/expired blocker
check(/cancelled.*expired|expired.*cancelled/i.test(sql),
  "Booking status 'cancelled'/'expired' blocker present");

// 24. needs_review blocker
check(/needs_review/.test(sql),
  "assignment_status 'needs_review' blocker present");

// 25. audit_payload present in SQL return
check(/audit_payload/i.test(sql),
  'audit_payload present in SQL');

// 26. rollback_payload present in SQL return
check(/rollback_payload/i.test(sql),
  'rollback_payload present in SQL');

// 27. Parameters $1–$7 all present
for (let i = 1; i <= 7; i++) {
  check(sql.indexOf('$' + i) >= 0, 'Parameter $' + i + ' present in SQL');
}

// 28. No raw string interpolation of identifiers (${...} inside SQL string)
// Only $1-$9 style param placeholders should appear; no ${variable} inside the SQL text.
const sqlContent = sql.replace(/\$[0-9]+/g, '');  // strip valid placeholders
check(!/\$\{[^}]+\}/.test(sqlContent),
  'No raw string interpolation (${...}) in SQL string');

// 29. REASSIGN_BLOCK_CODES exported
check(mod.REASSIGN_BLOCK_CODES && typeof mod.REASSIGN_BLOCK_CODES === 'object',
  'REASSIGN_BLOCK_CODES exported as object');
check(Object.isFrozen(mod.REASSIGN_BLOCK_CODES),
  'REASSIGN_BLOCK_CODES is frozen (immutable)');

// 30. package.json script
let pkg;
try { pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')); } catch (_) { pkg = {}; }
check(!!(pkg.scripts && pkg.scripts['verify:staff-bed-reassignment-sql']),
  'package.json has verify:staff-bed-reassignment-sql script');

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
