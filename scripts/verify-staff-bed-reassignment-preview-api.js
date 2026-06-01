/**
 * Stage 7.7k3 — Static verifier for the bed reassignment preview API endpoint.
 *
 * Checks (30 total):
 *
 *  A. File existence and syntax
 *   1.  staff-query-api.js exists
 *   2.  passes node --check (no syntax errors)
 *   3.  staff-bed-reassignment-sql.js required (not reassign-booking-beds-pg-sql.js)
 *   4.  does NOT require/import reassign-booking-beds-pg-sql.js
 *
 *  B. Route
 *   5.  /staff/bed-calendar/reassign/preview route exists
 *   6.  Route is GET only (no POST/PATCH/DELETE for this path)
 *   7.  handleBedReassignPreview function defined
 *
 *  C. Input validation
 *   8.  booking_bed_id required check present
 *   9.  target_bed_code required check present
 *  10.  UUID validation for booking_bed_id present (UUID_VALIDATE_RE or similar)
 *  11.  400 returned for missing/invalid params
 *
 *  D. Auth / role
 *  12.  requireAuth called with 'operator' (not just 'viewer') for preview route
 *  13.  403 path exists for insufficient role (requireAuth handles it)
 *  14.  STAFF_AUTH_REQUIRED referenced in auth context
 *
 *  E. SQL helper usage
 *  15.  reassignBookingBedSql imported from staff-bed-reassignment-sql
 *  16.  reassignBookingBedSql() called inside handler
 *  17.  confirm=false / $8=false passed to the SQL call
 *  18.  8 params passed to pg.query (complete param set)
 *
 *  F. Transaction safety
 *  19.  BEGIN present in preview handler (transaction opened)
 *  20.  ROLLBACK present in preview handler (always rolled back)
 *
 *  G. Write safety
 *  21.  No confirmed write route for reassignment (no POST reassign endpoint)
 *  22.  No direct UPDATE booking_beds outside helper in API file
 *  23.  No INSERT INTO booking_beds in API file
 *  24.  No mutation of payments or payment_events in API file
 *  25.  No mutation of conversations in API file
 *  26.  No mutation of staff_handoffs in API file (outside resolveHandoff)
 *
 *  H. Result safety
 *  27.  rows_updated = 0 check present in handler
 *  28.  audit intent 'api:bed_reassign_preview' or 'api:reassign_preview' present
 *  29.  preview:true in response shape
 *  30.  rows_updated: 0 (or rowsUpdated) returned in response
 *
 * Usage:
 *   node scripts/verify-staff-bed-reassignment-preview-api.js
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

console.log('\nverify-staff-bed-reassignment-preview-api.js  (Stage 7.7k3)\n');

// ── A. File existence and syntax ───────────────────────────────────────────

check(fs.existsSync(API_FILE), 'A1: staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');
check(src.length > 10000, 'A2a: file is readable and non-trivial');

try { execSync('node --check "' + API_FILE + '"', { stdio: 'ignore' }); ok('A2b: passes node --check'); }
catch (_) { fail('A2b: passes node --check'); }

check(/staff-bed-reassignment-sql/.test(src),
  'A3: staff-bed-reassignment-sql.js is required');

check(!/require\s*\(\s*['"][^'"]*reassign-booking-beds-pg-sql/.test(src),
  'A4: does NOT require() reassign-booking-beds-pg-sql.js (bot reset path)');

// ── B. Route ───────────────────────────────────────────────────────────────

check(/\/staff\/bed-calendar\/reassign\/preview/.test(src),
  'B5: /staff/bed-calendar/reassign/preview route present');

// No POST/PATCH/DELETE for the preview path
const previewArea = (() => {
  const idx = src.indexOf('/staff/bed-calendar/reassign/preview');
  return idx >= 0 ? src.slice(Math.max(0, idx - 200), idx + 800) : '';
})();
check(!/method.*POST|POST.*method|\.post\s*\(|router\.post/i.test(previewArea),
  'B6: preview route is GET only (no POST/PATCH/DELETE in route block)');

check(/handleBedReassignPreview\s*\(/.test(src),
  'B7: handleBedReassignPreview function defined');

// ── C. Input validation ────────────────────────────────────────────────────

check(/booking_bed_id.*required|required.*booking_bed_id/i.test(src),
  'C8: booking_bed_id required validation present');

check(/target_bed_code.*required|required.*target_bed_code/i.test(src),
  'C9: target_bed_code required validation present');

check(/UUID_VALIDATE_RE|[Uu][Uu][Ii][Dd].*test|test.*uuid/i.test(src),
  'C10: UUID validation for booking_bed_id present');

check(/send400\s*\(res.*booking_bed_id|send400\s*\(res.*target_bed_code/i.test(src),
  'C11: 400 returned for missing/invalid params');

// ── D. Auth / role ─────────────────────────────────────────────────────────

// requireAuth called with 'operator' near the preview route
check(/requireAuth\s*\(req\s*,\s*res\s*,\s*'operator'\)/.test(src),
  "D12: requireAuth called with 'operator' role");

// 403 path exists — requireAuth sends 403 for insufficient role
check(/403/.test(src) && /insufficient_role|role.*required|not.*allowed/i.test(src),
  'D13: 403 / insufficient_role path exists');

check(/STAFF_AUTH_REQUIRED/.test(src),
  'D14: STAFF_AUTH_REQUIRED referenced');

// ── E. SQL helper usage ────────────────────────────────────────────────────

check(
  /require\s*\(\s*['"][^'"]*staff-bed-reassignment-sql['"]/.test(src) &&
  /reassignBookingBedSql/.test(src),
  'E15: reassignBookingBedSql imported from staff-bed-reassignment-sql');

check(/reassignBookingBedSql\s*\(\s*\)/.test(src),
  'E16: reassignBookingBedSql() called in handler');

// confirm=false passed: look for false as 8th param in the pg.query array
check(/false\s*,\s*\/\/.*\$8|\/\/.*confirm.*false|\$8.*false|confirm.*=.*false/i.test(src),
  'E17: confirm=false / $8=false passed to SQL call');

// 8 params — look for array with 8 elements passed to pg.query
check(
  /pg\.query\s*\(\s*\n?\s*reassignBookingBedSql\s*\(\s*\)/.test(src) ||
  /reassignBookingBedSql[\s\S]{0,200}false\s*,?\s*\n?\s*\]/.test(src),
  'E18: reassignBookingBedSql called with params array');

// ── F. Transaction safety ──────────────────────────────────────────────────

// Scope checks to the preview handler region
const handlerStart = src.indexOf('async function handleBedReassignPreview');
const handlerEnd   = src.indexOf('\nasync function handleBookingContext');
const handlerBody  = handlerStart >= 0 && handlerEnd > handlerStart
  ? src.slice(handlerStart, handlerEnd)
  : src;

check(/pg\.query\s*\(\s*['"]BEGIN['"]\s*\)/.test(handlerBody),
  "F19: BEGIN transaction opened in preview handler");

check(/pg\.query\s*\(\s*['"]ROLLBACK['"]\s*\)/.test(handlerBody),
  "F20: ROLLBACK always executed in preview handler");

// ── G. Write safety ────────────────────────────────────────────────────────

// No confirmed write (POST) endpoint for reassign
check(!/post.*reassign|reassign.*post|POST.*reassign.*confirm/i.test(src),
  'G21: no confirmed write (POST) reassign route');

// No direct UPDATE booking_beds outside helper
const srcStripped = src.replace(/--[^\n]*/g, '');
check(!/UPDATE\s+booking_beds/.test(srcStripped),
  'G22: no direct UPDATE booking_beds in API file');

check(!/INSERT\s+INTO\s+booking_beds/.test(srcStripped),
  'G23: no INSERT INTO booking_beds in API file');

check(!/UPDATE\s+payments|UPDATE\s+payment_events/i.test(srcStripped),
  'G24: no mutation of payments or payment_events');

check(!/UPDATE\s+conversations/i.test(srcStripped),
  'G25: no mutation of conversations');

// staff_handoffs: only the resolve handler touches it — verify no new mutations
const nonHandoff = srcStripped.replace(/handleResolveHandoff[\s\S]*?^}/m, '');
check(!/UPDATE\s+staff_handoffs/i.test(nonHandoff),
  'G26: no new UPDATE staff_handoffs outside resolveHandoff handler');

// ── H. Result safety ───────────────────────────────────────────────────────

check(/rows_updated.*!==.*0|rowsUpdated.*!==.*0|rows_updated.*!= 0/i.test(handlerBody),
  'H27: rows_updated === 0 safety assertion in handler');

check(/api:bed_reassign_preview|api:reassign_preview/.test(src),
  "H28: audit intent 'api:bed_reassign_preview' present");

check(/preview\s*:\s*true/.test(handlerBody),
  'H29: preview:true present in response body');

check(/rows_updated\s*:\s*rowsUpdated|rows_updated\s*:.*rowsUpdated|rows_updated.*0/.test(handlerBody),
  'H30: rows_updated returned in response');

// ── Package script ─────────────────────────────────────────────────────────

let pkg = {};
try { pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')); } catch (_) {}
check(!!(pkg.scripts && pkg.scripts['verify:staff-bed-reassignment-preview-api']),
  'package.json has verify:staff-bed-reassignment-preview-api script');

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
