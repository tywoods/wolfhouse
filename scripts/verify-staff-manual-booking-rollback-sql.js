/**
 * Stage 8.3k — Static verifier for scripts/lib/staff-manual-booking-rollback-sql.js
 *
 * Checks (40 total):
 *   Structure:  file exists, exports correct, block codes present.
 *   Safety:     NOT WIRED / NOT RUNTIME comments, no DROP/TRUNCATE/ALTER,
 *               no WhatsApp/Stripe/n8n, no API wiring, no STAFF_ACTIONS_ENABLED=true.
 *   Blockers:   confirm_not_set, staff_role_insufficient, booking_not_found,
 *               not_manual_staff_booking, confirmation_already_sent,
 *               unsafe_payment_exists, rollback_payload mismatch blockers.
 *   SQL shape:  workflow_name = 'staff_manual_booking_rollback', message present,
 *               booking_id=NULL in audit, mutation uses $4::uuid, booking_source
 *               guard, CASCADE-safe pre-capture approach.
 *   Syntax:     node --check passes for helper and verifier.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HELPER_PATH   = path.join(__dirname, 'lib', 'staff-manual-booking-rollback-sql.js');
const VERIFIER_PATH = __filename;

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ [${String(pass + fail + 1).padStart(2, '0')}] ${label}`);
    pass++;
  } else {
    console.error(`  ✗ [${String(pass + fail + 1).padStart(2, '0')}] FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

function mustContain(src, pattern) {
  if (pattern instanceof RegExp) return pattern.test(src);
  return src.includes(pattern);
}

// ---------------------------------------------------------------------------
// Load helper
// ---------------------------------------------------------------------------

const helperSrc = fs.readFileSync(HELPER_PATH, 'utf8');
// Strip SQL line comments (-- ...), JS line comments (// ...),
// and JS block comments (/* ... */) before pattern checks
// to prevent false positives on safety-warning comment text.
// Note: use 'm' flag on the line-comment regexes so $ anchors at \r\n line
// endings (Windows CRLF files).
const helperSrcNoComments = helperSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')   // strip /* ... */ blocks
  .replace(/--.*$/mg, '')             // strip SQL line comments (-- ...)
  .replace(/\/\/.*$/mg, '');          // strip JS line comments (// ...)

let helperModule;
try {
  helperModule = require(HELPER_PATH);
} catch (e) {
  console.error('FATAL: could not require helper:', e.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

console.log('\n=== verify-staff-manual-booking-rollback-sql ===\n');

// ── Structure ────────────────────────────────────────────────────────────────

check('helper file exists at scripts/lib/staff-manual-booking-rollback-sql.js',
  fs.existsSync(HELPER_PATH));

check('buildManualBookingRollbackSql exported',
  typeof helperModule.buildManualBookingRollbackSql === 'function');

check('MANUAL_BOOKING_ROLLBACK_BLOCK_CODES exported',
  typeof helperModule.MANUAL_BOOKING_ROLLBACK_BLOCK_CODES === 'object' &&
  helperModule.MANUAL_BOOKING_ROLLBACK_BLOCK_CODES !== null);

check('MANUAL_BOOKING_ROLLBACK_ALLOWED_ROLES exported',
  Array.isArray(helperModule.MANUAL_BOOKING_ROLLBACK_ALLOWED_ROLES));

check('block codes include confirm_not_set',
  Object.values(helperModule.MANUAL_BOOKING_ROLLBACK_BLOCK_CODES)
    .includes('confirm_not_set'));

check('block codes include staff_role_insufficient',
  Object.values(helperModule.MANUAL_BOOKING_ROLLBACK_BLOCK_CODES)
    .includes('staff_role_insufficient'));

check('block codes include booking_not_found',
  Object.values(helperModule.MANUAL_BOOKING_ROLLBACK_BLOCK_CODES)
    .includes('booking_not_found'));

check('block codes include unsafe_payment_exists',
  Object.values(helperModule.MANUAL_BOOKING_ROLLBACK_BLOCK_CODES)
    .includes('unsafe_payment_exists'));

check('block codes include confirmation_already_sent',
  Object.values(helperModule.MANUAL_BOOKING_ROLLBACK_BLOCK_CODES)
    .includes('confirmation_already_sent'));

check('block codes include rollback_payload_code_mismatch',
  Object.values(helperModule.MANUAL_BOOKING_ROLLBACK_BLOCK_CODES)
    .includes('rollback_payload_code_mismatch'));

check('block codes include rollback_payload_id_mismatch',
  Object.values(helperModule.MANUAL_BOOKING_ROLLBACK_BLOCK_CODES)
    .includes('rollback_payload_id_mismatch'));

// ── Safety header comments ────────────────────────────────────────────────────

check('helper has NOT WIRED comment',
  mustContain(helperSrc, 'NOT WIRED'));

check('helper has NOT RUNTIME API comment',
  mustContain(helperSrc, 'NOT RUNTIME'));

check('helper has local/test proof comment',
  mustContain(helperSrc, /LOCAL.*PROOF|local.*test.*proof/i, true));

check('helper documents parameter contract',
  mustContain(helperSrc, 'Parameter contract') &&
  mustContain(helperSrc, '$1') &&
  mustContain(helperSrc, '$8'));

// ── Blockers in SQL ───────────────────────────────────────────────────────────

check("SQL confirm blocker: $8::boolean IS TRUE",
  mustContain(helperSrcNoComments, /\$8::boolean\s+IS\s+TRUE/i, true));

check("SQL role blocker: $3::text NOT IN ('admin', 'owner')",
  mustContain(helperSrcNoComments, /\$3::text\s+NOT\s+IN\s*\(/i, true));

check("SQL booking_not_found blocker: COUNT(*) FROM booking_check = 0",
  mustContain(helperSrcNoComments, /FROM\s+booking_check\s*\)\s*=\s*0/i, true));

check("SQL not_manual_staff_booking blocker: booking_source <> 'manual_staff'",
  mustContain(helperSrcNoComments, /booking_source.*manual_staff/i, true));

check("SQL not_manual_created blocker: metadata->>'manual_created'",
  mustContain(helperSrcNoComments, /manual_created/));

check("SQL confirmation_already_sent blocker: confirmation_sent_at IS NOT NULL",
  mustContain(helperSrcNoComments, /confirmation_sent_at.*IS NOT NULL/i, true));

check('SQL unsafe_payment_exists blocker: payment_safety CTE',
  mustContain(helperSrcNoComments, 'payment_safety'));

check('SQL rollback_payload code mismatch blocker: b_code',
  mustContain(helperSrcNoComments, 'b_code'));

check('SQL rollback_payload id mismatch blocker: b_payload',
  mustContain(helperSrcNoComments, /rollback_payload_id_mismatch/));

// ── SQL mutation scope ────────────────────────────────────────────────────────

check('SQL DELETE FROM bookings scoped to $4::uuid',
  mustContain(helperSrcNoComments, /DELETE FROM bookings/i, true) &&
  mustContain(helperSrcNoComments, /\$4::uuid/));

check('SQL DELETE FROM bookings guarded with booking_source = manual_staff',
  mustContain(helperSrcNoComments,
    /DELETE FROM bookings[\s\S]{0,500}booking_source\s*=\s*'manual_staff'/i, true));

check('SQL DELETE guarded: NOT (SELECT is_blocked FROM blocked_summary)',
  mustContain(helperSrcNoComments,
    /NOT\s*\(SELECT is_blocked FROM blocked_summary\)/i, true));

check('SQL pre_beds CTE for reporting booking_bed IDs before cascade',
  mustContain(helperSrcNoComments, 'pre_beds'));

check('SQL pre_payments CTE for reporting payment IDs before cascade',
  mustContain(helperSrcNoComments, 'pre_payments'));

check('SQL mutation scoped to client_id from ctx',
  mustContain(helperSrcNoComments,
    /client_id\s*=\s*\(SELECT client_id FROM ctx\)/i, true));

// ── Audit ─────────────────────────────────────────────────────────────────────

check("SQL audit uses workflow_name = 'staff_manual_booking_rollback'",
  mustContain(helperSrcNoComments, 'staff_manual_booking_rollback'));

check('SQL audit has message column (not null enforced)',
  mustContain(helperSrcNoComments, /message/));

check('SQL audit booking_id is NULL (avoids FK confusion on delete)',
  mustContain(helperSrcNoComments, /NULL::uuid/));

check('SQL audit_written CTE present',
  mustContain(helperSrcNoComments, 'audit_written'));

// ── Final SELECT shape ────────────────────────────────────────────────────────

check('SQL final SELECT includes success',
  mustContain(helperSrcNoComments, /AS success/));

check('SQL final SELECT includes blocked',
  mustContain(helperSrcNoComments, /AS blocked/));

check('SQL final SELECT includes block_reason',
  mustContain(helperSrcNoComments, /AS block_reason/));

check('SQL final SELECT includes rows_deleted',
  mustContain(helperSrcNoComments, /AS rows_deleted/));

check('SQL final SELECT includes booking_beds_affected',
  mustContain(helperSrcNoComments, /AS booking_beds_affected/));

check('SQL final SELECT includes payments_affected',
  mustContain(helperSrcNoComments, /AS payments_affected/));

check('SQL final SELECT includes audit_event_id',
  mustContain(helperSrcNoComments, /AS audit_event_id/));

check('SQL final SELECT includes rollback_audit_payload',
  mustContain(helperSrcNoComments, /AS rollback_audit_payload/));

// ── Safety: no forbidden patterns ────────────────────────────────────────────

check('no DROP TABLE in helper',
  !mustContain(helperSrcNoComments, /DROP\s+TABLE/i, true));

check('no TRUNCATE in helper',
  !mustContain(helperSrcNoComments, /TRUNCATE/i, true));

check('no ALTER TABLE in helper',
  !mustContain(helperSrcNoComments, /ALTER\s+TABLE/i, true));

check('no WhatsApp/sendMessage reference in helper',
  !mustContain(helperSrcNoComments, /whatsapp|sendMessage|send_message/i, true));

check('no Stripe in helper',
  !mustContain(helperSrcNoComments, /stripe/i, true));

check('no n8n in helper',
  !mustContain(helperSrcNoComments, /n8n/i, true));

check('no STAFF_ACTIONS_ENABLED=true in helper',
  !mustContain(helperSrc, /STAFF_ACTIONS_ENABLED\s*=\s*true/i, true));

check('no API route in helper (no app.post/router.post)',
  !mustContain(helperSrc, /app\.(post|get|put|patch|delete)\s*\(/i, true) &&
  !mustContain(helperSrc, /router\.(post|get|put|patch|delete)\s*\(/i, true));

// ── Syntax checks ─────────────────────────────────────────────────────────────

let helperSyntaxOk = false;
try {
  execSync(`node --check "${HELPER_PATH}"`, { stdio: 'pipe' });
  helperSyntaxOk = true;
} catch (e) { /* will fail check */ }
check('node --check passes for rollback helper', helperSyntaxOk);

let verifierSyntaxOk = false;
try {
  execSync(`node --check "${VERIFIER_PATH}"`, { stdio: 'pipe' });
  verifierSyntaxOk = true;
} catch (e) { /* will fail check */ }
check('node --check passes for this verifier', verifierSyntaxOk);

// ── Summary ───────────────────────────────────────────────────────────────────

const total = pass + fail;
console.log(`\n${'─'.repeat(52)}`);
console.log(`verify-staff-manual-booking-rollback-sql: ${pass}/${total} checks passed`);
if (fail === 0) {
  console.log('Stage 8.3k static verifier: ALL PASS');
} else {
  console.error(`Stage 8.3k static verifier: ${fail} FAILED`);
  process.exit(1);
}
