/**
 * verify-staff-bed-reassignment-confirm-api.js (Stage 7.7k5)
 *
 * Static verifier for the confirmed bed reassignment write endpoint.
 * Checks that POST /staff/bed-calendar/reassign/confirm is:
 *   - POST-only
 *   - Gated by STAFF_ACTIONS_ENABLED and STAFF_AUTH_REQUIRED
 *   - Authenticated operator/admin/owner via session (not token-only)
 *   - Validates confirm=true, reason, booking_bed_id (UUID), target_bed_code
 *   - Calls reassignBookingBedSql() with confirm=true
 *   - Uses BEGIN/COMMIT/ROLLBACK transaction
 *   - rows_updated===1 success assertion
 *   - Blocked path returns 409
 *   - Audits with intent api:bed_reassign_confirm
 *   - Does NOT mutate protected tables directly
 *   - Does NOT call reassign-booking-beds-pg-sql.js
 *   - No UI references, no drag/drop
 *
 * Usage: node scripts/verify-staff-bed-reassignment-confirm-api.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, 'staff-query-api.js');
let passed = 0, failed = 0;

function ok(id, msg)   { console.log(`  PASS  ${id}: ${msg}`); passed++; }
function fail(id, msg) { console.error(`  FAIL  ${id}: ${msg}`); failed++; }
function check(id, cond, msg) { if (cond) ok(id, msg); else fail(id, msg); }

// Strip JS line comments before checking for forbidden keywords
function stripLineComments(src) { return src.replace(/\/\/.*$/gm, ''); }

console.log('\nverify-staff-bed-reassignment-confirm-api.js  (Stage 7.7k5)\n');

// ── A. File / syntax ──────────────────────────────────────────────────────────
check('A1', fs.existsSync(TARGET),                          'staff-query-api.js exists');
const src = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
check('A2', src.length > 10000,                             'file is readable and non-trivial');
check('A3', (() => { try { require('child_process').execSync(`node --check "${TARGET}"`, { stdio: 'pipe' }); return true; } catch { return false; } })(),
  'passes node --check (no syntax errors)');

// ── B. Route ──────────────────────────────────────────────────────────────────
check('B4', /\/staff\/bed-calendar\/reassign\/confirm/.test(src),
  'POST /staff/bed-calendar/reassign/confirm route present');
check('B5', /handleBedReassignConfirm/.test(src),
  'handleBedReassignConfirm function defined');
check('B6', /method !== 'POST'/.test(src),
  'method !== POST check present (405 for non-POST)');
check('B7', /405/.test(src),
  '405 response for wrong method');

// ── C. STAFF_ACTIONS_ENABLED gate ─────────────────────────────────────────────
check('C8', /STAFF_ACTIONS_ENABLED/.test(src),
  'STAFF_ACTIONS_ENABLED env flag referenced');
check('C9', /feature_flag_disabled/.test(src),
  'feature_flag_disabled audit error label present');
check('C10', /Set STAFF_ACTIONS_ENABLED=true/.test(src),
  'STAFF_ACTIONS_ENABLED=true guidance in error message');

// ── D. STAFF_AUTH_REQUIRED gate ───────────────────────────────────────────────
check('D11', /STAFF_AUTH_REQUIRED/.test(src),
  'STAFF_AUTH_REQUIRED referenced');
check('D12', /auth_not_enabled/.test(src),
  'auth_not_enabled error label present (token-only path blocked)');

// ── E. Session auth + role ────────────────────────────────────────────────────
check('E13', /loadAuthSession\(req\)/.test(src),
  'loadAuthSession(req) called for session lookup');
check('E14', /hasRole\(sessionUser\.role,\s*'operator'\)/.test(src),
  "hasRole(sessionUser.role, 'operator') for role check");
check('E15', /insufficient_role/.test(src),
  'insufficient_role audit error label');
check('E16', /current_role/.test(src),
  'current_role returned in 403 response');

// ── F. Body validation ────────────────────────────────────────────────────────
check('F17', /booking_bed_id.*required/.test(src),
  'booking_bed_id required validation');
check('F18', /UUID_VALIDATE_RE\.test\(bookingBedId\)/.test(src),
  'UUID_VALIDATE_RE validation on booking_bed_id');
check('F19', /target_bed_code.*required/.test(src),
  'target_bed_code required validation');
check('F20', /reason.*required/.test(src),
  'reason required validation');
check('F21', /confirmFlag !== true/.test(src),
  'confirm !== true validation (rejects missing/false)');
check('F22', /confirm: true is required/.test(src),
  'confirm: true error message present');

// ── G. Helper call ────────────────────────────────────────────────────────────
const { reassignBookingBedSql } = require('./lib/staff-bed-reassignment-sql');
check('G23', (() => {
  const req = src.match(/require\([^)]*staff-bed-reassignment-sql[^)]*\)/);
  return req !== null;
})(), 'staff-bed-reassignment-sql required');
check('G24', /reassignBookingBedSql\(\)/.test(src),
  'reassignBookingBedSql() called in file');
check('G25', (() => {
  // Verify confirm=true is passed near handleBedReassignConfirm context
  const fnStart = src.indexOf('async function handleBedReassignConfirm');
  const fnBody  = src.slice(fnStart, fnStart + 6000);
  return /true,\s*\/\/ \$8 confirm = TRUE/.test(fnBody);
})(), 'confirm=true ($8=true) passed to helper in confirm handler');
check('G26', (() => {
  const fnStart = src.indexOf('async function handleBedReassignConfirm');
  const fnBody  = src.slice(fnStart, fnStart + 6000);
  return /false,\s*\/\/ \$8 confirm = FALSE/.test(fnBody) === false;
})(), 'confirm=false is NOT present inside handleBedReassignConfirm (preview only)');

// ── H. Transaction ────────────────────────────────────────────────────────────
check('H27', (() => {
  const fnStart = src.indexOf('async function handleBedReassignConfirm');
  const fnBody  = src.slice(fnStart, fnStart + 6000);
  return /pg\.query\('BEGIN'\)/.test(fnBody);
})(), "BEGIN transaction present in confirm handler");
check('H28', (() => {
  const fnStart = src.indexOf('async function handleBedReassignConfirm');
  const fnBody  = src.slice(fnStart, fnStart + 12000);
  return /pg\.query\('COMMIT'\)/.test(fnBody);
})(), "COMMIT present in confirm handler");
check('H29', (() => {
  const fnStart = src.indexOf('async function handleBedReassignConfirm');
  const fnBody  = src.slice(fnStart, fnStart + 12000);
  return /pg\.query\('ROLLBACK'\)/.test(fnBody);
})(), "ROLLBACK present in confirm handler");

// ── I. rows_updated assertion ─────────────────────────────────────────────────
check('I30', /rowsUpdated !== 1/.test(src),
  'rowsUpdated !== 1 safety check present');
check('I31', /SAFETY_VIOLATION_rows_updated_not_1/.test(src),
  'safety violation label present');

// ── J. Blocked path ───────────────────────────────────────────────────────────
check('J32', /409/.test(src),
  '409 response code used for blocked path');
check('J33', /blocked.*true|block_reason/.test(src),
  'blocked=true / block_reason returned in response');
check('J34', /manual_operator_lock/.test(src),
  'manual_operator_lock mentioned (documented, no override in this slice)');

// ── K. Audit log ──────────────────────────────────────────────────────────────
check('K35', /api:bed_reassign_confirm/.test(src),
  'audit intent api:bed_reassign_confirm present');
check('K36', /bed_reassignment_api/.test(src),
  'audit category bed_reassignment_api present');
check('K37', /audit_event_id/.test(src),
  'audit_event_id returned in response');

// ── L. No unsafe writes ───────────────────────────────────────────────────────
const stripped = stripLineComments(src);
check('L38', !/UPDATE\s+payments/i.test(stripped),        'no UPDATE payments');
check('L39', !/UPDATE\s+payment_events/i.test(stripped),  'no UPDATE payment_events');
check('L40', !/UPDATE\s+conversations/i.test(stripped),   'no UPDATE conversations');
check('L41', !/UPDATE\s+staff_handoffs/i.test(stripped),  'no UPDATE staff_handoffs (outside resolveHandoff)');
check('L42', !/INSERT\s+INTO\s+booking_beds/i.test(stripped), 'no INSERT INTO booking_beds');
check('L43', !/DELETE\s+FROM\s+booking_beds/i.test(stripped), 'no DELETE FROM booking_beds');
// Check for SQL DDL statements (not regex literals — exclude lines that define SQL_INJECT_RE)
check('L44', (() => {
  const noRegexLines = stripped.split('\n')
    .filter(l => !/SQL_INJECT_RE\s*=/.test(l) && !/DROP.*ALTER.*TRUNCATE/.test(l))
    .join('\n');
  return !/DROP\s+TABLE|TRUNCATE\s+TABLE|ALTER\s+TABLE/i.test(noRegexLines);
})(), 'no DROP TABLE / TRUNCATE TABLE / ALTER TABLE in non-regex code');
check('L45', (() => {
  const reqMatches = (src.match(/require\([^)]+\)/g) || []);
  return !reqMatches.some(r => r.includes('reassign-booking-beds-pg-sql'));
})(), 'does NOT require() reassign-booking-beds-pg-sql.js (bot reset path)');

// ── M. No UI wiring ───────────────────────────────────────────────────────────
check('M46', !/draggable|dragstart|drop\s*=\s*"true"/.test(src),
  'no drag/drop attributes in API file');
check('M47', /NOT wired to any calendar edit button/.test(src),
  'comment confirms no UI calendar edit wiring');

// ── N. package.json verifier script ──────────────────────────────────────────
const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg     = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : {};
check('N48', !!(pkg.scripts && pkg.scripts['verify:staff-bed-reassignment-confirm-api']),
  'package.json has verify:staff-bed-reassignment-confirm-api script');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
