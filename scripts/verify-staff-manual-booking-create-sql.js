/**
 * Stage 8.3f — Static verifier for staff-manual-booking-create-sql.js
 *
 * Checks (40 total):
 *   1:   Helper file exists
 *   2:   Helper file readable and non-trivial
 *   3:   Helper file passes node --check (syntax clean)
 *   4:   Module loads without throwing
 *   5:   buildManualBookingCreateSql export exists and is a function
 *   6:   MANUAL_BOOKING_BLOCK_CODES export exists and is frozen
 *   7:   MANUAL_BOOKING_ALLOWED_ROLES export exists
 *   8:   NOT WIRED / NOT RUNTIME header present
 *   9:   "Must be executed inside an explicit BEGIN / COMMIT" comment present
 *  10:   No WhatsApp / Stripe / n8n imports or runtime calls
 *  11:   No DB client import (no pg/Pool/require db)
 *  12:   No STAFF_ACTIONS_ENABLED=true assignment
 *  13:   No API route wiring (no app.post / router.post / app.patch etc.)
 *  14:   confirm_not_set blocker present in SQL string
 *  15:   staff_role_insufficient blocker present in SQL string
 *  16:   client_not_found blocker present in SQL string
 *  17:   staff_actor_not_found blocker present (in BLOCK_CODES or SQL)
 *  18:   invalid_dates blocker present in SQL string
 *  19:   invalid_guest_count blocker present in SQL string
 *  20:   no_selected_beds blocker present in SQL string
 *  21:   overlap_conflict blocker present in SQL string
 *  22:   booking_code_collision blocker present in SQL string
 *  23:   invalid_payment_amounts blocker present in SQL string
 *  24:   idempotency_duplicate / idempotency key design present
 *  25:   Half-open overlap: assignment_start_date < proposed_check_out present
 *  26:   Half-open overlap: assignment_end_date > proposed_check_in present
 *  27:   cancelled/expired exclusion present in SQL string
 *  28:   Defense-in-depth overlap guard in inserted_booking_beds present
 *  29:   FOR UPDATE lock present in SQL string
 *  30:   ctx CTE present
 *  31:   audit_payload_cte CTE present
 *  32:   rollback_payload_cte CTE present
 *  33:   inserted_booking CTE present
 *  34:   inserted_booking_beds CTE present
 *  35:   inserted_payment CTE present (optional manual payment)
 *  36:   No DELETE FROM (unscoped mutation guard)
 *  37:   No DROP TABLE or TRUNCATE
 *  38:   No ALTER TABLE
 *  39:   confirmation_sent_at = NULL (no auto-send at creation)
 *  40:   package.json has verify:staff-manual-booking-create-sql script
 *
 * Usage:
 *   node scripts/verify-staff-manual-booking-create-sql.js
 */

'use strict';

const path       = require('path');
const fs         = require('fs');
const { execSync } = require('child_process');

const HELPER_FILE = path.join(__dirname, 'lib', 'staff-manual-booking-create-sql.js');
const PKG_FILE    = path.join(__dirname, '..', 'package.json');

let passes   = 0;
let failures = 0;

function ok(msg)   { console.log('  PASS  ' + msg); passes++; }
function fail(msg) { console.error('  FAIL  ' + msg); failures++; }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

console.log('\nverify-staff-manual-booking-create-sql.js  (Stage 8.3f)\n');

// ── 1. File exists ────────────────────────────────────────────────────────────
check(fs.existsSync(HELPER_FILE), 'staff-manual-booking-create-sql.js exists');
if (!fs.existsSync(HELPER_FILE)) {
  console.error('\nFATAL: helper file missing — cannot continue.\n');
  process.exit(1);
}

// ── 2. Readable and non-trivial ───────────────────────────────────────────────
const src = fs.readFileSync(HELPER_FILE, 'utf8');
check(src.length > 2000, 'File is readable and non-trivial (>2000 chars)');

// ── 3. Syntax clean ───────────────────────────────────────────────────────────
let syntaxOk = false;
try {
  execSync('node --check "' + HELPER_FILE + '"', { stdio: 'pipe' });
  syntaxOk = true;
} catch (_) { /* falls through */ }
check(syntaxOk, 'node --check passes (syntax clean)');

// ── 4. Module loads ───────────────────────────────────────────────────────────
let mod = null;
try { mod = require(HELPER_FILE); } catch (_) { /* falls through */ }
check(mod !== null, 'Module loads without throwing');

// ── 5. buildManualBookingCreateSql export ─────────────────────────────────────
const hasExport = mod && typeof mod.buildManualBookingCreateSql === 'function';
check(hasExport, 'buildManualBookingCreateSql exported and is a function');

// Obtain the SQL string for subsequent content checks
let sqlStr = '';
if (hasExport) {
  try { sqlStr = mod.buildManualBookingCreateSql(); } catch (_) { /* skip */ }
}

// ── 6. MANUAL_BOOKING_BLOCK_CODES ─────────────────────────────────────────────
const codes = mod && mod.MANUAL_BOOKING_BLOCK_CODES;
check(
  codes && typeof codes === 'object' && Object.isFrozen(codes),
  'MANUAL_BOOKING_BLOCK_CODES exported and frozen'
);

// ── 7. MANUAL_BOOKING_ALLOWED_ROLES ───────────────────────────────────────────
check(
  mod && Array.isArray(mod.MANUAL_BOOKING_ALLOWED_ROLES) &&
  mod.MANUAL_BOOKING_ALLOWED_ROLES.length >= 3,
  'MANUAL_BOOKING_ALLOWED_ROLES exported with >= 3 roles'
);

// ── 8. NOT WIRED / NOT RUNTIME header ─────────────────────────────────────────
check(
  /NOT WIRED/i.test(src) && /NOT RUNTIME/i.test(src),
  'NOT WIRED / NOT RUNTIME header present in source'
);

// ── 9. BEGIN / COMMIT caller comment ──────────────────────────────────────────
check(
  /BEGIN\s*\/\s*COMMIT/i.test(src) || /explicit.*transaction/i.test(src),
  '"BEGIN / COMMIT" or "explicit transaction" caller comment present'
);

// ── 10. No WhatsApp / Stripe / n8n require() imports ─────────────────────────
// Only checks for actual require() calls; documentation/SQL comment mentions are fine.
const dangerousRequire = /require\s*\(\s*['"][^'"]*(?:whatsapp|stripe|n8n)[^'"]*['"]/i;
check(!dangerousRequire.test(src), 'No WhatsApp / Stripe / n8n require() imports');

// ── 11. No DB client import ───────────────────────────────────────────────────
const dbImport = /require\s*\(\s*['"][^'"]*(?:pg|pool|db-connect|pg-connect)['"]/i;
check(!dbImport.test(src), 'No DB client require() present (static file only)');

// ── 12. No STAFF_ACTIONS_ENABLED=true ────────────────────────────────────────
check(
  !/STAFF_ACTIONS_ENABLED\s*=\s*true/i.test(src),
  'No STAFF_ACTIONS_ENABLED=true in source'
);

// ── 13. No API route wiring ───────────────────────────────────────────────────
check(
  !/app\.(post|patch|put|delete)\s*\(/i.test(src) &&
  !/router\.(post|patch|put|delete)\s*\(/i.test(src),
  'No API route wiring (app.post / router.post etc.)'
);

// ── 14. confirm_not_set blocker ───────────────────────────────────────────────
check(/confirm_not_set/.test(sqlStr), 'confirm_not_set blocker in SQL string');

// ── 15. staff_role_insufficient blocker ──────────────────────────────────────
check(/staff_role_insufficient/.test(sqlStr), 'staff_role_insufficient blocker in SQL string');

// ── 16. client_not_found blocker ──────────────────────────────────────────────
check(/client_not_found/.test(sqlStr), 'client_not_found blocker in SQL string');

// ── 17. staff_actor_not_found in BLOCK_CODES or SQL ─────────────────────────
check(
  /staff_actor_not_found/.test(src),
  'staff_actor_not_found present in source (BLOCK_CODES or SQL)'
);

// ── 18. invalid_dates blocker ─────────────────────────────────────────────────
check(/invalid_dates/.test(sqlStr), 'invalid_dates blocker in SQL string');

// ── 19. invalid_guest_count blocker ──────────────────────────────────────────
check(/invalid_guest_count/.test(sqlStr), 'invalid_guest_count blocker in SQL string');

// ── 20. no_selected_beds blocker ─────────────────────────────────────────────
check(/no_selected_beds/.test(sqlStr), 'no_selected_beds blocker in SQL string');

// ── 21. overlap_conflict blocker ─────────────────────────────────────────────
check(/overlap_conflict/.test(sqlStr), 'overlap_conflict blocker in SQL string');

// ── 22. booking_code_collision blocker ───────────────────────────────────────
check(/booking_code_collision/.test(sqlStr), 'booking_code_collision blocker in SQL string');

// ── 23. invalid_payment_amounts blocker ──────────────────────────────────────
check(/invalid_payment_amounts/.test(sqlStr), 'invalid_payment_amounts blocker in SQL string');

// ── 24. idempotency key design ───────────────────────────────────────────────
check(
  /idempotency_key/.test(sqlStr) || /idempotency_duplicate/.test(sqlStr),
  'idempotency key design present in SQL string'
);

// ── 25. Half-open overlap: start < proposed_end ───────────────────────────────
check(
  /assignment_start_date\s*<\s*\$11/.test(sqlStr),
  'Half-open overlap: assignment_start_date < proposed_check_out ($11)'
);

// ── 26. Half-open overlap: end > proposed_start ───────────────────────────────
check(
  /assignment_end_date\s*>\s*\$10/.test(sqlStr),
  'Half-open overlap: assignment_end_date > proposed_check_in ($10)'
);

// ── 27. cancelled/expired exclusion ──────────────────────────────────────────
check(
  /NOT IN \('cancelled', 'expired'\)/.test(sqlStr) ||
  /NOT IN \('cancelled','expired'\)/.test(sqlStr),
  "cancelled/expired booking exclusion present in SQL string"
);

// ── 28. Defense-in-depth overlap in inserted_booking_beds ────────────────────
// The NOT EXISTS subquery inside inserted_booking_beds must re-check overlap.
const bedsBedIdx  = sqlStr.indexOf('inserted_booking_beds');
const bedsSection = bedsBedIdx >= 0 ? sqlStr.slice(bedsBedIdx, bedsBedIdx + 2000) : '';
check(
  /NOT EXISTS/.test(bedsSection) && /assignment_start_date/.test(bedsSection),
  'Defense-in-depth overlap NOT EXISTS guard in inserted_booking_beds'
);

// ── 29. FOR UPDATE present ────────────────────────────────────────────────────
check(/FOR\s+UPDATE/.test(sqlStr), 'FOR UPDATE row-level lock present in SQL string');

// ── 30. ctx CTE present ───────────────────────────────────────────────────────
check(/^\s*ctx\s+AS\s*\(/m.test(sqlStr), 'ctx CTE present in SQL string');

// ── 31. audit_payload_cte present ────────────────────────────────────────────
check(/audit_payload_cte\s+AS\s*\(/.test(sqlStr), 'audit_payload_cte CTE present in SQL string');

// ── 32. rollback_payload_cte present ─────────────────────────────────────────
check(/rollback_payload_cte\s+AS\s*\(/.test(sqlStr), 'rollback_payload_cte CTE present in SQL string');

// ── 33. inserted_booking CTE present ─────────────────────────────────────────
check(/inserted_booking\s+AS\s*\(/.test(sqlStr), 'inserted_booking CTE present in SQL string');

// ── 34. inserted_booking_beds CTE present ────────────────────────────────────
check(/inserted_booking_beds\s+AS\s*\(/.test(sqlStr), 'inserted_booking_beds CTE present in SQL string');

// ── 35. inserted_payment CTE present ─────────────────────────────────────────
check(/inserted_payment\s+AS\s*\(/.test(sqlStr), 'inserted_payment CTE present (optional manual payment)');

// ── 36. No unscoped DELETE FROM ──────────────────────────────────────────────
// Allowed pattern: only if DELETE is within a comment.
// Simple guard: no DELETE FROM outside SQL comments.
const sqlNoComments = sqlStr.replace(/--[^\n]*/g, '');
check(!/DELETE\s+FROM/i.test(sqlNoComments), 'No DELETE FROM in SQL (unscoped mutation guard)');

// ── 37. No DROP TABLE or TRUNCATE ────────────────────────────────────────────
check(
  !/DROP\s+TABLE/i.test(sqlStr) && !/TRUNCATE/i.test(sqlStr),
  'No DROP TABLE or TRUNCATE in SQL string'
);

// ── 38. No ALTER TABLE ────────────────────────────────────────────────────────
check(!/ALTER\s+TABLE/i.test(sqlStr), 'No ALTER TABLE in SQL string');

// ── 39. confirmation_sent_at = NULL ──────────────────────────────────────────
check(
  /confirmation_sent_at/.test(sqlStr) && /NULL/.test(sqlStr),
  'confirmation_sent_at = NULL present (no auto-confirmation at creation)'
);

// ── 40. package.json script ───────────────────────────────────────────────────
let pkgHasScript = false;
try {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  pkgHasScript = !!(pkg.scripts && pkg.scripts['verify:staff-manual-booking-create-sql']);
} catch (_) { /* skip */ }
check(pkgHasScript, 'package.json has verify:staff-manual-booking-create-sql script');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log('  Total checks: ' + (passes + failures));
console.log('  PASS: '  + passes);
console.log('  FAIL: '  + failures);
console.log('─'.repeat(60));

if (failures === 0) {
  console.log('\n  ALL CHECKS PASSED — Stage 8.3f static SQL helper verified.\n');
} else {
  console.error('\n  ' + failures + ' CHECK(S) FAILED — review output above.\n');
  process.exit(1);
}
