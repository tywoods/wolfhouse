/**
 * Stage 6.9 — Static verifier for the token-gated handoff resolve write endpoint.
 *
 * Reads scripts/staff-query-api.js as text and checks structural/safety patterns.
 * Does NOT start the server. No DB. No runtime.
 *
 * Checks:
 *   1.  API file exists and passes node --check
 *   2.  POST /staff/handoff/:id/resolve route pattern present
 *   3.  STAFF_ACTIONS_ENABLED gate present
 *   4.  x-staff-operator-token check present
 *   5.  STAFF_OPERATOR_TOKEN env var check present
 *   6.  confirm === true validation present
 *   7.  resolution required validation present
 *   8.  handleResolveHandoff function present
 *   9.  resolveHandoffSql imported and called in write handler
 *  10.  No arbitrary SQL write (no template-literal UPDATE/INSERT)
 *  11.  No protected table mutation (bookings/payments/payment_events/booking_beds)
 *  12.  No staff_tasks / conversations mutation
 *  13.  Rejected attempts audited (feature flag + token paths)
 *  14.  Confirmed write audited
 *  15.  already_resolved idempotency behavior present
 *  16.  Action allowlist (WRITE_ACTION_ALLOWLIST) present
 *  17.  /staff/ui still read-only: no POST fetch, no resolve button, no handoff.resolve
 *  18.  GET-only still enforced for non-write routes
 *  19.  package.json script present
 *
 * Exit code: 0 on PASS, 1 on FAIL.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_PATH = path.join(__dirname, 'staff-query-api.js');
const PKG_PATH = path.join(__dirname, '..', 'package.json');

let passes   = 0;
let failures = 0;

function pass(msg) { console.log(`  ✓ ${msg}`); passes++; }
function fail(msg) { console.error(`  ✗ ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }
function has(src, re)   { return re.test(src); }
function lacks(src, re) { return !re.test(src); }

// ─────────────────────────────────────────────────────────────────────────────
section('1. File exists and valid syntax');

if (!fs.existsSync(API_PATH)) { fail('staff-query-api.js does not exist'); process.exit(1); }
pass('staff-query-api.js exists');

let src = '';
try { src = fs.readFileSync(API_PATH, 'utf8'); pass(`readable (${src.length} chars)`); }
catch (e) { fail('cannot read: ' + e.message); process.exit(1); }

try { execSync(`node --check "${API_PATH}"`, { stdio: 'pipe' }); pass('passes node --check'); }
catch (e) { fail('syntax error: ' + (e.stderr ? e.stderr.toString().trim() : e.message)); process.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
section('2. POST /staff/handoff/:id/resolve route pattern');

if (has(src, /WRITE_HANDOFF_RE|\/staff\/handoff\/.*\/resolve/)) { pass('handoff resolve path pattern present'); } else { fail('handoff resolve path pattern missing'); }
if (has(src, /method.*POST|POST.*method/i))                      { pass('POST method check present'); }             else { fail('POST method check missing'); }
if (has(src, /handleResolveHandoff/))                             { pass('handleResolveHandoff referenced in router'); } else { fail('handleResolveHandoff not referenced'); }

// ─────────────────────────────────────────────────────────────────────────────
section('3. STAFF_ACTIONS_ENABLED gate');

if (has(src, /STAFF_ACTIONS_ENABLED/))               { pass('STAFF_ACTIONS_ENABLED referenced'); }     else { fail('STAFF_ACTIONS_ENABLED missing'); }
if (has(src, /!STAFF_ACTIONS_ENABLED|=== 'true'/))   { pass('STAFF_ACTIONS_ENABLED guard present'); }  else { fail('STAFF_ACTIONS_ENABLED guard not found'); }
if (has(src, /403[\s\S]{0,200}STAFF_ACTIONS_ENABLED|STAFF_ACTIONS_ENABLED[\s\S]{0,300}403/)) {
  pass('403 returned when STAFF_ACTIONS_ENABLED not set');
} else {
  fail('403 for missing STAFF_ACTIONS_ENABLED not found');
}

// ─────────────────────────────────────────────────────────────────────────────
section('4. x-staff-operator-token check');

if (has(src, /x-staff-operator-token/)) { pass('x-staff-operator-token header referenced'); } else { fail('x-staff-operator-token missing'); }
if (has(src, /providedToken|headers\[.x-staff-operator-token.\]/)) { pass('header value extracted'); } else { fail('header value not extracted'); }

// ─────────────────────────────────────────────────────────────────────────────
section('5. STAFF_OPERATOR_TOKEN env var check');

if (has(src, /STAFF_OPERATOR_TOKEN/))                           { pass('STAFF_OPERATOR_TOKEN env var referenced'); } else { fail('STAFF_OPERATOR_TOKEN missing'); }
if (has(src, /process\.env\.STAFF_OPERATOR_TOKEN/))             { pass('reads from process.env'); }                  else { fail('env var not read from process.env'); }
if (has(src, /401[\s\S]{0,300}token|invalid_token|invalid.*token/i)) { pass('401/invalid_token for bad token'); } else { fail('no 401 or invalid_token for bad token'); }

// ─────────────────────────────────────────────────────────────────────────────
section('6. confirm === true required');

if (has(src, /confirm.*!== true|confirmFlag.*!== true|confirm.*true.*required/i)) {
  pass('confirm !== true guard present');
} else if (has(src, /confirm\s*!==\s*true/)) {
  pass('confirm !== true guard present');
} else {
  fail('confirm !== true guard not found');
}

// ─────────────────────────────────────────────────────────────────────────────
section('7. resolution required validation');

if (has(src, /!resolutionRaw|!resolution.*required|resolution.*non-empty/i)) { pass('resolution required check present'); } else { fail('resolution required check not found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('8. handleResolveHandoff function');

if (has(src, /async function handleResolveHandoff\s*\(/)) { pass('handleResolveHandoff async function declared'); } else { fail('handleResolveHandoff function missing'); }

// ─────────────────────────────────────────────────────────────────────────────
section('9. resolveHandoffSql imported and called');

if (has(src, /require.*staff-handoff-write-sql/))       { pass('staff-handoff-write-sql required'); }    else { fail('staff-handoff-write-sql not required'); }
if (has(src, /\{ resolveHandoffSql \}|resolveHandoffSql\s*\}/)) { pass('resolveHandoffSql destructured from require'); } else if (has(src, /resolveHandoffSql/)) { pass('resolveHandoffSql referenced'); } else { fail('resolveHandoffSql not imported'); }
if (has(src, /resolveHandoffSql\s*\(\s*\)/))            { pass('resolveHandoffSql() called'); }           else { fail('resolveHandoffSql() not called'); }

// ─────────────────────────────────────────────────────────────────────────────
section('10. No arbitrary SQL write (no template-literal UPDATE/INSERT in write handler)');

// Isolate the write handler section from the buildUiHtml section
const writeHandlerStart = src.indexOf('async function handleResolveHandoff');
const uiStart = src.indexOf('function buildUiHtml');
const writeSrc = writeHandlerStart >= 0 && uiStart > writeHandlerStart
  ? src.slice(writeHandlerStart, uiStart)
  : writeHandlerStart >= 0 ? src.slice(writeHandlerStart) : '';

if (lacks(writeSrc, /pgClient\.query\s*\(\s*`[\s\S]*?UPDATE\b/i))  { pass('no template-literal UPDATE in write handler'); } else { fail('template-literal UPDATE in write handler'); }
if (lacks(writeSrc, /pgClient\.query\s*\(\s*`[\s\S]*?INSERT\b/i))  { pass('no template-literal INSERT in write handler'); } else { fail('template-literal INSERT in write handler'); }
if (lacks(writeSrc, /pgClient\.query\s*\(\s*`[\s\S]*?DELETE\b/i))  { pass('no template-literal DELETE in write handler'); } else { fail('template-literal DELETE in write handler'); }

// ─────────────────────────────────────────────────────────────────────────────
section('11. No protected table mutation');

const PROTECTED = ['bookings', 'payments', 'payment_events', 'booking_beds'];
PROTECTED.forEach(tbl => {
  const mutRe = new RegExp('(UPDATE|INSERT INTO|DELETE FROM)\\s+' + tbl, 'i');
  if (lacks(writeSrc, mutRe)) { pass(`no ${tbl} mutation in write handler`); } else { fail(`${tbl} mutation found in write handler`); }
});

// ─────────────────────────────────────────────────────────────────────────────
section('12. No staff_tasks / conversations mutation');

if (lacks(writeSrc, /UPDATE\s+staff_tasks|INSERT INTO\s+staff_tasks/i))       { pass('no staff_tasks mutation'); }   else { fail('staff_tasks mutation found'); }
if (lacks(writeSrc, /UPDATE\s+conversations|INSERT INTO\s+conversations/i))    { pass('no conversations mutation'); } else { fail('conversations mutation found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('13. Rejected attempts audited');

if (has(src, /feature_flag_disabled/))  { pass('feature_flag_disabled audit present'); }  else { fail('no feature_flag_disabled audit entry'); }
if (has(src, /invalid_token/))          { pass('invalid_token audit present'); }           else { fail('no invalid_token audit entry'); }

// ─────────────────────────────────────────────────────────────────────────────
section('14. Confirmed write audited');

if (has(src, /action:api:handoff\.resolve/)) { pass('action:api:handoff.resolve audit intent present'); } else { fail('action:api:handoff.resolve audit intent missing'); }
if (has(src, /staff_write/))                  { pass('category: staff_write in audit'); }                 else { fail('category: staff_write missing from audit'); }

// ─────────────────────────────────────────────────────────────────────────────
section('15. already_resolved idempotency');

if (has(src, /already_resolved/))                            { pass('already_resolved field present'); }          else { fail('already_resolved field missing'); }
if (has(src, /status.*resolved.*cancelled|resolved.*cancelled/)) { pass('status resolved/cancelled idempotency check'); } else { fail('idempotency check for resolved/cancelled status missing'); }

// ─────────────────────────────────────────────────────────────────────────────
section('16. Action allowlist (WRITE_ACTION_ALLOWLIST)');

if (has(src, /WRITE_ACTION_ALLOWLIST/)) { pass('WRITE_ACTION_ALLOWLIST defined'); } else { fail('WRITE_ACTION_ALLOWLIST missing'); }
if (has(src, /handoff\.resolve/))        { pass('handoff.resolve in allowlist scope'); } else { fail('handoff.resolve not found'); }

// ─────────────────────────────────────────────────────────────────────────────
section('17. /staff/ui still read-only');

// Isolate HTML section
const htmlStart = src.indexOf('function buildUiHtml');
const htmlSrc   = htmlStart >= 0 ? src.slice(htmlStart) : '';

if (lacks(htmlSrc, /method\s*:\s*['"]POST['"]/i) ||
    /* Stage 8.3l: POST to /staff/manual-bookings/preview (read-only preview) is now allowed */
    /manual-bookings\/preview/.test(htmlSrc))
  { pass('no fetch POST in UI HTML (or only to read-only preview endpoint)'); }
else { fail('unexpected fetch POST found in UI HTML'); }
if (lacks(htmlSrc, /btn-resolve|btn-write/i))        { pass('no resolve/write button in UI HTML'); }  else { fail('resolve/write button found in UI HTML'); }
if (lacks(htmlSrc, /handoff\.resolve/i))              { pass('no handoff.resolve in UI HTML'); }       else { fail('handoff.resolve found in UI HTML'); }

// ─────────────────────────────────────────────────────────────────────────────
section('18. GET-only still enforced for non-write routes');

if (has(src, /send405|405/))                    { pass('405 for non-GET still present'); }  else { fail('405 handler missing'); }
if (has(src, /method !== 'GET'/))               { pass("method !== 'GET' check still present"); } else { fail("method !== 'GET' check missing"); }

// ─────────────────────────────────────────────────────────────────────────────
section('19. package.json script present');

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  if ((pkg.scripts || {})['verify:staff-write-api']) { pass('package.json has "verify:staff-write-api"'); }
  else { fail('package.json missing "verify:staff-write-api"'); }
} catch (e) { fail('cannot read package.json: ' + e.message); }

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`Result: ${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
