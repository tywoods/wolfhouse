/**
 * Stage 8.3h — Static verifier for the manual booking preview endpoint.
 *
 * Checks (48 total):
 *   API file checks (1–15):
 *    1:  staff-query-api.js exists
 *    2:  staff-query-api.js passes node --check (syntax clean)
 *    3:  staff-manual-booking-preview-queries.js exists
 *    4:  staff-manual-booking-preview-queries.js passes node --check
 *    5:  preview-queries module loads without throwing
 *    6:  getManualBookingPreviewBedsQuery exported and is a function
 *    7:  getManualBookingPreviewAssignmentsQuery exported and is a function
 *    8:  getClientIdBySlugQuery exported and is a function
 *    9:  No INSERT / UPDATE / DELETE in preview-queries SQL strings
 *   10:  Half-open overlap operand present in assignments query
 *        (assignment_start_date < proposed_check_out)
 *   11:  Half-open overlap operand present in assignments query
 *        (assignment_end_date > proposed_check_in)
 *   12:  No pg-connect direct import in preview-queries helper
 *   13:  No Stripe / WhatsApp / n8n require() in preview-queries
 *   14:  previewManualBookingAvailability imported in staff-query-api.js
 *   15:  handleManualBookingPreview function present in staff-query-api.js
 *
 *   Route/auth checks (16–26):
 *   16:  /staff/manual-bookings/preview route present in staff-query-api.js
 *   17:  requireAuth called for preview route
 *   18:  operator role gate present for preview route
 *   19:  POST method accepted for preview route
 *   20:  Method-not-allowed guard for non-POST on preview route
 *   21:  preview_only: true in response
 *   22:  creates_booking: false in response
 *   23:  no_write_performed: true in response
 *   24:  staff_actions_enabled in response
 *   25:  manual_booking_enabled in response
 *   26:  next_step field in response
 *
 *   Safety checks (27–36):
 *   27:  No STAFF_ACTIONS_ENABLED=true in staff-query-api.js (assignment)
 *   28:  No MANUAL_BOOKING_ENABLED=true in staff-query-api.js (assignment)
 *   29:  No Stripe / WhatsApp / n8n calls in handleManualBookingPreview
 *   30:  No INSERT / UPDATE / DELETE in handleManualBookingPreview
 *   31:  No confirm route for manual booking added
 *   32:  No "manual-bookings/confirm" route present
 *   33:  Audit uses file-only appendAuditLog (no workflow_events INSERT in handler)
 *   34:  No STAFF_ACTIONS_ENABLED guard required for preview route
 *   35:  Input SQL injection guard (SQL_INJECT_RE) applied
 *   36:  node --check verifier itself passes
 *
 *   preview-queries content checks (37–43):
 *   37:  SELECT present in beds query
 *   38:  SELECT present in assignments query
 *   39:  $1 (client slug) parameterised in beds query
 *   40:  $2 (bed_codes array) parameterised in beds query
 *   41:  $1 (client slug) parameterised in assignments query
 *   42:  $2 / $3 (date range) parameterised in assignments query
 *   43:  $4 (bed_codes array) parameterised in assignments query
 *
 *   Package.json check (44):
 *   44:  package.json has verify:staff-manual-booking-preview-api script
 *
 *   Prior stage regression (45–48):
 *   45:  verify-staff-manual-booking-availability.js still passes 52 checks
 *   46:  verify-staff-manual-booking-create-sql.js still passes 40 checks
 *   47:  verify-staff-bed-calendar-ui.js node --check passes
 *   48:  verify-staff-write-api.js node --check passes
 *
 * Usage:
 *   node scripts/verify-staff-manual-booking-preview-api.js
 */

'use strict';

const path         = require('path');
const fs           = require('fs');
const { execSync } = require('child_process');

const SCRIPTS_DIR   = __dirname;
const API_FILE      = path.join(SCRIPTS_DIR, 'staff-query-api.js');
const QUERIES_FILE  = path.join(SCRIPTS_DIR, 'lib', 'staff-manual-booking-preview-queries.js');
const PKG_FILE      = path.join(SCRIPTS_DIR, '..', 'package.json');

let passes   = 0;
let failures = 0;

function ok(msg)   { console.log('  PASS  ' + msg); passes++; }
function fail(msg) { console.error('  FAIL  ' + msg); failures++; }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

console.log('\nverify-staff-manual-booking-preview-api.js  (Stage 8.3h)\n');

// ── 1. staff-query-api.js exists ──────────────────────────────────────────
check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) {
  console.error('\nFATAL: API file missing.\n'); process.exit(1);
}
const apiSrc = fs.readFileSync(API_FILE, 'utf8');

// ── 2. staff-query-api.js syntax clean ────────────────────────────────────
let apiSyntaxOk = false;
try { execSync('node --check "' + API_FILE + '"', { stdio: 'pipe' }); apiSyntaxOk = true; } catch (_) {}
check(apiSyntaxOk, 'staff-query-api.js passes node --check');

// ── 3. preview-queries file exists ────────────────────────────────────────
check(fs.existsSync(QUERIES_FILE), 'staff-manual-booking-preview-queries.js exists');
if (!fs.existsSync(QUERIES_FILE)) {
  console.error('\nFATAL: preview-queries file missing.\n'); process.exit(1);
}
const queriesSrc = fs.readFileSync(QUERIES_FILE, 'utf8');

// ── 4. preview-queries syntax clean ───────────────────────────────────────
let queriesSyntaxOk = false;
try { execSync('node --check "' + QUERIES_FILE + '"', { stdio: 'pipe' }); queriesSyntaxOk = true; } catch (_) {}
check(queriesSyntaxOk, 'staff-manual-booking-preview-queries.js passes node --check');

// ── 5. preview-queries module loads ───────────────────────────────────────
let qMod = null;
try { qMod = require(QUERIES_FILE); } catch (_) {}
check(qMod !== null, 'preview-queries module loads without throwing');

// ── 6. getManualBookingPreviewBedsQuery exported ──────────────────────────
check(qMod && typeof qMod.getManualBookingPreviewBedsQuery === 'function',
  'getManualBookingPreviewBedsQuery exported and is a function');

// ── 7. getManualBookingPreviewAssignmentsQuery exported ───────────────────
check(qMod && typeof qMod.getManualBookingPreviewAssignmentsQuery === 'function',
  'getManualBookingPreviewAssignmentsQuery exported and is a function');

// ── 8. getClientIdBySlugQuery exported ────────────────────────────────────
check(qMod && typeof qMod.getClientIdBySlugQuery === 'function',
  'getClientIdBySlugQuery exported and is a function');

// ── 9. No INSERT/UPDATE/DELETE in query SQL strings ───────────────────────
let bedsQSql = '', assignQSql = '', clientQSql = '';
if (qMod) {
  try { bedsQSql    = qMod.getManualBookingPreviewBedsQuery();         } catch (_) {}
  try { assignQSql  = qMod.getManualBookingPreviewAssignmentsQuery();  } catch (_) {}
  try { clientQSql  = qMod.getClientIdBySlugQuery();                   } catch (_) {}
}
const allSql = bedsQSql + assignQSql + clientQSql;
const mutationRe = /\b(INSERT INTO|UPDATE\s+\w|DELETE FROM)\b/i;
check(!mutationRe.test(allSql), 'No INSERT / UPDATE / DELETE in preview-queries SQL strings');

// ── 10. Half-open overlap: start < check_out ─────────────────────────────
check(
  /assignment_start_date\s*<\s*\$3/.test(assignQSql),
  'Half-open overlap: assignment_start_date < $3 (proposed_check_out) present'
);

// ── 11. Half-open overlap: end > check_in ────────────────────────────────
check(
  /assignment_end_date\s*>\s*\$2/.test(assignQSql),
  'Half-open overlap: assignment_end_date > $2 (proposed_check_in) present'
);

// ── 12. No pg-connect direct import in queries helper ────────────────────
const pgImportRe = /require\s*\(\s*['"][^'"]*(?:pg-connect|pg|pool)['"]/i;
check(!pgImportRe.test(queriesSrc), 'No pg-connect / pg / Pool require() in preview-queries helper');

// ── 13. No Stripe / WhatsApp / n8n require() in queries helper ───────────
const dangerRe = /require\s*\(\s*['"][^'"]*(?:whatsapp|stripe|n8n)[^'"]*['"]/i;
check(!dangerRe.test(queriesSrc), 'No Stripe / WhatsApp / n8n require() in preview-queries');

// ── 14. previewManualBookingAvailability imported in API ─────────────────
check(
  /previewManualBookingAvailability/.test(apiSrc) &&
  /staff-manual-booking-availability/.test(apiSrc),
  'previewManualBookingAvailability imported in staff-query-api.js'
);

// ── 15. handleManualBookingPreview function present ───────────────────────
check(
  /handleManualBookingPreview/.test(apiSrc),
  'handleManualBookingPreview function present in staff-query-api.js'
);

// ── 16. /staff/manual-bookings/preview route present ────────────────────
check(
  /\/staff\/manual-bookings\/preview/.test(apiSrc),
  '/staff/manual-bookings/preview route present in staff-query-api.js'
);

// ── 17. requireAuth called for preview route ─────────────────────────────
// Find the router dispatch block (pathname === '/staff/manual-bookings/preview')
const previewRouteBlock = (() => {
  const anchor = "pathname === '/staff/manual-bookings/preview'";
  const idx = apiSrc.indexOf(anchor);
  return idx >= 0 ? apiSrc.slice(idx, idx + 800) : '';
})();
check(
  /requireAuth/.test(previewRouteBlock),
  'requireAuth called in preview route block'
);

// ── 18. operator role gate present ───────────────────────────────────────
check(
  /['"]operator['"]/.test(previewRouteBlock),
  "operator role gate present in preview route block"
);

// ── 19. POST method accepted ──────────────────────────────────────────────
check(
  /method\s*!==\s*['"]POST['"]/.test(previewRouteBlock) ||
  /POST/.test(previewRouteBlock),
  'POST method handling present in preview route block'
);

// ── 20. 405 guard for non-POST ────────────────────────────────────────────
check(
  /405/.test(previewRouteBlock),
  '405 returned for non-POST on preview route'
);

// ── 21. preview_only: true in response ───────────────────────────────────
check(/preview_only\s*:\s*true/.test(apiSrc), 'preview_only: true in API response');

// ── 22. creates_booking: false in response ────────────────────────────────
check(/creates_booking\s*:\s*false/.test(apiSrc), 'creates_booking: false in API response');

// ── 23. no_write_performed: true in response ──────────────────────────────
check(/no_write_performed\s*:\s*true/.test(apiSrc), 'no_write_performed: true in API response');

// ── 24. staff_actions_enabled in response ────────────────────────────────
check(/staff_actions_enabled/.test(apiSrc), 'staff_actions_enabled field in API response');

// ── 25. manual_booking_enabled in response ────────────────────────────────
check(/manual_booking_enabled/.test(apiSrc), 'manual_booking_enabled field in API response');

// ── 26. next_step field in response ──────────────────────────────────────
check(/next_step/.test(apiSrc), 'next_step field in API response');

// ── 27. No STAFF_ACTIONS_ENABLED=true assignment ─────────────────────────
// Verify the const declaration reads from process.env (not hardcoded true).
// There are legitimate string mentions like "set STAFF_ACTIONS_ENABLED=true to enable"
// in error message literals — we want to check the actual variable assignment.
check(
  /const STAFF_ACTIONS_ENABLED\s*=\s*process\.env/.test(apiSrc),
  'STAFF_ACTIONS_ENABLED const reads from process.env (not hardcoded true)'
);

// ── 28. No MANUAL_BOOKING_ENABLED=true assignment ────────────────────────
check(
  !/MANUAL_BOOKING_ENABLED\s*=\s*true/i.test(apiSrc),
  'No MANUAL_BOOKING_ENABLED=true assignment in API file'
);

// ── 29. No Stripe / WhatsApp / n8n in handleManualBookingPreview ──────────
// Use the section comment immediately after the handler as the end boundary.
const previewHandlerIdx  = apiSrc.indexOf('async function handleManualBookingPreview');
// End at the next section comment header or async function (whichever comes first)
const previewHandlerEndA = apiSrc.indexOf('\n// ─────', previewHandlerIdx + 1);
const previewHandlerEndB = apiSrc.indexOf('\nasync function ', previewHandlerIdx + 1);
const previewHandlerEnd  =
  previewHandlerEndA > 0 && previewHandlerEndB > 0
    ? Math.min(previewHandlerEndA, previewHandlerEndB)
    : previewHandlerEndA > 0 ? previewHandlerEndA
    : previewHandlerEndB > 0 ? previewHandlerEndB
    : previewHandlerIdx + 5000;
const previewHandlerSrc  = previewHandlerIdx >= 0
  ? apiSrc.slice(previewHandlerIdx, previewHandlerEnd)
  : '';
check(
  !/stripe|whatsapp|n8n/i.test(previewHandlerSrc),
  'No Stripe / WhatsApp / n8n calls in handleManualBookingPreview'
);

// ── 30. No INSERT / UPDATE / DELETE in handler ────────────────────────────
const sqlMutationInHandler = /\b(INSERT INTO|UPDATE\s+\w|DELETE FROM)\b/i;
check(
  !sqlMutationInHandler.test(previewHandlerSrc),
  'No INSERT / UPDATE / DELETE in handleManualBookingPreview handler'
);

// ── 31. No manual-bookings/confirm route ─────────────────────────────────
check(
  !/manual-bookings\/confirm/.test(apiSrc),
  'No manual-bookings/confirm route added (confirm route not implemented)'
);

// ── 32. Same as 31 — no confirm path in a different form ─────────────────
check(
  !/handleManualBookingConfirm/.test(apiSrc),
  'No handleManualBookingConfirm function added'
);

// ── 33. Handler uses file-based audit (appendAuditLog, not workflow_events) ─
const hasAppendAudit   = /appendAuditLog/.test(previewHandlerSrc);
const noWorkflowEvents = !/workflow_events/.test(previewHandlerSrc);
check(
  hasAppendAudit && noWorkflowEvents,
  'Handler uses file-based appendAuditLog; no workflow_events INSERT'
);

// ── 34. Preview route does NOT check STAFF_ACTIONS_ENABLED ───────────────
check(
  !previewRouteBlock.includes('STAFF_ACTIONS_ENABLED'),
  'Preview route does NOT require STAFF_ACTIONS_ENABLED'
);

// ── 35. Input SQL injection guard applied ─────────────────────────────────
check(
  /SQL_INJECT_RE/.test(previewHandlerSrc),
  'SQL_INJECT_RE input guard applied in handleManualBookingPreview'
);

// ── 36. Verifier syntax clean ────────────────────────────────────────────
let verifierSyntaxOk = false;
try {
  execSync('node --check "' + __filename + '"', { stdio: 'pipe' });
  verifierSyntaxOk = true;
} catch (_) {}
check(verifierSyntaxOk, 'node --check passes on verifier itself');

// ── 37–43. preview-queries SQL content checks ────────────────────────────
check(/SELECT/.test(bedsQSql),   'SELECT present in beds query');
check(/SELECT/.test(assignQSql), 'SELECT present in assignments query');
check(/\$1/.test(bedsQSql),     '$1 (client slug) parameterised in beds query');
check(/\$2/.test(bedsQSql),     '$2 (bed_codes array) parameterised in beds query');
check(/\$1/.test(assignQSql),   '$1 (client slug) parameterised in assignments query');
check(/\$2/.test(assignQSql) && /\$3/.test(assignQSql),
  '$2/$3 (date range) parameterised in assignments query');
check(/\$4/.test(assignQSql),   '$4 (bed_codes array) parameterised in assignments query');

// ── 44. package.json script ───────────────────────────────────────────────
let pkgHasScript = false;
try {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  pkgHasScript = !!(pkg.scripts && pkg.scripts['verify:staff-manual-booking-preview-api']);
} catch (_) {}
check(pkgHasScript, 'package.json has verify:staff-manual-booking-preview-api script');

// ── 45–48. Prior stage regression checks ─────────────────────────────────
function runVerifier(label, script) {
  try {
    execSync('node "' + script + '"', { stdio: 'pipe' });
    ok(label + ' still passes');
  } catch (e) {
    fail(label + ' regression — output: ' + e.stdout.toString().slice(0, 300));
  }
}

runVerifier(
  'verify-staff-manual-booking-availability.js (52 checks)',
  path.join(SCRIPTS_DIR, 'verify-staff-manual-booking-availability.js')
);
runVerifier(
  'verify-staff-manual-booking-create-sql.js (40 checks)',
  path.join(SCRIPTS_DIR, 'verify-staff-manual-booking-create-sql.js')
);

let calendarUiSyntaxOk = false;
try {
  execSync('node --check "' + path.join(SCRIPTS_DIR, 'verify-staff-bed-calendar-ui.js') + '"', { stdio: 'pipe' });
  calendarUiSyntaxOk = true;
} catch (_) {}
check(calendarUiSyntaxOk, 'verify-staff-bed-calendar-ui.js node --check passes');

let writeApiSyntaxOk = false;
try {
  execSync('node --check "' + path.join(SCRIPTS_DIR, 'verify-staff-write-api.js') + '"', { stdio: 'pipe' });
  writeApiSyntaxOk = true;
} catch (_) {}
check(writeApiSyntaxOk, 'verify-staff-write-api.js node --check passes');

// ── Summary ───────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log('  Total checks: ' + (passes + failures));
console.log('  PASS: '  + passes);
console.log('  FAIL: '  + failures);
console.log('─'.repeat(60));

if (failures === 0) {
  console.log('\n  ALL CHECKS PASSED — Stage 8.3h preview endpoint verified.\n');
} else {
  console.error('\n  ' + failures + ' CHECK(S) FAILED — review output above.\n');
  process.exit(1);
}
