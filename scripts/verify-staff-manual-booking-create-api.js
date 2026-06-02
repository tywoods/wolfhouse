/**
 * verify-staff-manual-booking-create-api.js  (Stage 8.4)
 *
 * Static verifier for the manual booking creation endpoint, which is a
 * PROVISIONAL, DISABLED-BY-DEFAULT, UI-UNWIRED stub:
 *   POST /staff/manual-bookings/create
 *
 * Per the Stage 8.4 correction, this route must NOT be enabled until a
 * pricing/payment engine exists (see docs/STAGE-8.4-MANUAL-BOOKING-CREATION.md).
 * It stays behind MANUAL_BOOKING_ENABLED (default false → 403) and is not wired
 * to any UI control.
 *
 * Confirms the route is:
 *   - POST-only
 *   - Gated by the dedicated MANUAL_BOOKING_ENABLED flag (NOT STAFF_ACTIONS_ENABLED)
 *   - Documented as a provisional/disabled stub (header banner)
 *   - NOT wired to the UI (no fetch() to the create route in buildUiHtml)
 *   - Authenticated (operator+ via requireAuth in the router)
 *   - Validates confirm=true, dates, selected beds, guest name, guest count
 *   - Calls buildManualBookingCreateSql() inside a BEGIN/COMMIT transaction
 *   - Re-checks conflicts server-side (helper overlap CTE + ROLLBACK on block)
 *   - Returns 409 on overlap conflict; rolls back on any blocker
 *   - Has idempotency / double-click protection
 *   - Records a workflow_events audit row (via the SQL helper) + file audit
 *   - Performs NO Stripe / WhatsApp / n8n side effects (no session/invoice/link)
 *
 * Usage: node scripts/verify-staff-manual-booking-create-api.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, 'staff-query-api.js');
const PKG    = path.join(__dirname, '..', 'package.json');
let passed = 0, failed = 0;

function ok(id, msg)   { console.log(`  PASS  ${id}: ${msg}`); passed++; }
function fail(id, msg) { console.error(`  FAIL  ${id}: ${msg}`); failed++; }
function check(id, cond, msg) { if (cond) ok(id, msg); else fail(id, msg); }

console.log('\nverify-staff-manual-booking-create-api.js  (Stage 8.4)\n');

// ── A. File / syntax ──────────────────────────────────────────────────────────
check('A1', fs.existsSync(TARGET), 'staff-query-api.js exists');
const src = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
check('A2', src.length > 10000, 'file is readable and non-trivial');
check('A3', (() => { try { require('child_process').execSync(`node --check "${TARGET}"`, { stdio: 'pipe' }); return true; } catch { return false; } })(),
  'passes node --check (no syntax errors)');

// Scope most checks to the handler body for precision.
const hStart = src.indexOf('async function handleManualBookingCreate');
const hEnd   = hStart > 0 ? src.indexOf('\n// ───', hStart + 50) : -1;
const handler = hStart > 0 ? src.slice(hStart, hEnd > 0 ? hEnd : hStart + 12000) : '';
check('A4', handler.length > 500, 'handleManualBookingCreate handler body found');

// ── B. Route ──────────────────────────────────────────────────────────────────
check('B5', /pathname === '\/staff\/manual-bookings\/create'/.test(src),
  "router dispatches '/staff/manual-bookings/create'");
check('B6', /handleManualBookingCreate\(req, res, auth\.user\)/.test(src),
  'router calls handleManualBookingCreate with auth.user');
check('B7', /Method not allowed — use POST for manual-bookings\/create/.test(src),
  'POST-only enforced (405 for other methods)');

// ── C. Feature flag gate (dedicated MANUAL_BOOKING_ENABLED) ─────────────────────
check('C8', /if \(!MANUAL_BOOKING_ENABLED\)/.test(handler),
  'gated by MANUAL_BOOKING_ENABLED (dedicated flag)');
check('C9', /Set MANUAL_BOOKING_ENABLED to true/.test(handler),
  'error message guides enabling MANUAL_BOOKING_ENABLED');
check('C10', !/STAFF_ACTIONS_ENABLED/.test(handler),
  'handler does NOT require STAFF_ACTIONS_ENABLED (uses dedicated flag)');

// ── D. Auth ─────────────────────────────────────────────────────────────────────
check('D11', /pathname === '\/staff\/manual-bookings\/create'[\s\S]{0,400}requireAuth\(req, res, 'operator'\)/.test(src),
  "route guarded by requireAuth(req, res, 'operator')");
check('D12', /MANUAL_BOOKING_ALLOWED_ROLES\.includes\(actorRole\)/.test(handler),
  'role checked against MANUAL_BOOKING_ALLOWED_ROLES');

// ── E. Input validation ─────────────────────────────────────────────────────────
check('E13', /confirm: true is required/.test(handler),
  'requires confirm:true in body');
check('E14', /selected_bed_codes is required/.test(handler),
  'requires selected_bed_codes (selected cells)');
check('E15', /check_in and check_out must be YYYY-MM-DD/.test(handler),
  'validates date format');
check('E16', /check_out must be after check_in/.test(handler),
  'validates check_out > check_in');
check('E17', /guest_name is required/.test(handler),
  'requires guest_name');
check('E18', /guest_count must be at least 1/.test(handler),
  'validates guest_count >= 1');
check('E19', /SQL_INJECT_RE\.test/.test(handler),
  'SQL-injection guard applied to inputs');

// ── F. Transaction + conflict re-check ──────────────────────────────────────────
check('F20', /buildManualBookingCreateSql\(\)/.test(handler),
  'calls buildManualBookingCreateSql() helper');
check('F21', /pg\.query\('BEGIN'\)/.test(handler) && /pg\.query\('COMMIT'\)/.test(handler),
  'wraps write in BEGIN/COMMIT transaction');
check('F22', /pg\.query\('ROLLBACK'\)/.test(handler),
  'rolls back on failure/blocked paths');
check('F23', /is_blocked === true/.test(handler),
  'honours server-side is_blocked (conflict re-check) and rolls back');
check('F24', /overlap_conflict/.test(handler) && /409/.test(handler),
  'overlap_conflict returns 409 (conflict prevents double-booking)');
check('F25', /bedsInserted !== selectedBedCodes\.length/.test(handler),
  'safety assertion: inserted bed count must match selection');

// ── G. Idempotency / double-click ───────────────────────────────────────────────
check('G26', /idempotencyKey/.test(handler) && /idempotency_key/.test(handler),
  'idempotency key derived/accepted and passed to helper');
check('G27', /is_duplicate === true/.test(handler),
  'idempotency duplicate handled (idempotent response)');

// ── H. Audit ────────────────────────────────────────────────────────────────────
check('H28', /intent:\s*'api:manual_booking_create'/.test(handler),
  "file audit uses intent 'api:manual_booking_create'");
check('H29', /appendAuditLog/.test(handler),
  'appendAuditLog called for audit trail');
// workflow_events audit is written inside the SQL helper
check('H30', /workflow_events/.test(fs.readFileSync(path.join(__dirname, 'lib', 'staff-manual-booking-create-sql.js'), 'utf8')),
  'SQL helper records a workflow_events audit row');

// ── I. No external side effects ─────────────────────────────────────────────────
// Negative checks target actual call/usage patterns, not the safety-assertion
// keys (no_stripe / stripe_called:false) or the "NO Stripe…" comments.
check('I31', !/stripe[.(]|checkout\.session|payment_link|createCheckout/i.test(handler),
  'handler invokes no Stripe / checkout / payment link');
check('I32', !/whatsapp[.(]|twilio|sendWhatsApp|sendMessage\(/i.test(handler),
  'handler invokes no WhatsApp / messaging');
check('I33', !/n8n[.(]|webhook[.(]|fetch\(|axios|http\.request/i.test(handler),
  'handler makes no n8n / outbound webhook / fetch / http request');
check('I34', /no_stripe:\s*true/.test(handler) && /no_whatsapp:\s*true/.test(handler) && /no_n8n:\s*true/.test(handler),
  'response asserts no_stripe / no_whatsapp / no_n8n');

// ── J. Success response ─────────────────────────────────────────────────────────
check('J35', /sendJSON\(res, 201/.test(handler),
  'returns 201 with created booking details');
check('J36', /booking_code:\s*row\.booking_code/.test(handler),
  'returns created booking_code');

// ── K. package.json wiring ──────────────────────────────────────────────────────
const pkg = fs.existsSync(PKG) ? fs.readFileSync(PKG, 'utf8') : '';
check('K37', /verify:staff-manual-booking-create-api/.test(pkg),
  'package.json has verify:staff-manual-booking-create-api script');

// ── L. Provisional / disabled / unwired guarantees (Stage 8.4 correction) ───────
// The provisional banner lives in the comment block immediately before the handler.
const docStart = src.indexOf('// Route: POST /staff/manual-bookings/create');
const routeDoc = docStart >= 0 ? src.slice(docStart, hStart > docStart ? hStart : docStart + 4000) : '';
check('L38', /PROVISIONAL|DISABLED-BY-DEFAULT|NOT ENABLED|do not enable/i.test(routeDoc),
  'route header documents it as a provisional / disabled stub');
check('L39', /pricing\/payment engine|pricing engine/i.test(routeDoc),
  'route header states pricing/payment engine is a prerequisite');
// Not wired to the UI: the buildUiHtml template must not fetch the create route.
(function checkNotUiWired(){
  const uiIdx = src.indexOf('function buildUiHtml');
  const uiSrc = uiIdx >= 0 ? src.slice(uiIdx, src.indexOf('function handleUI', uiIdx) > 0 ? src.indexOf('function handleUI', uiIdx) : uiIdx + 200000) : src;
  check('L40', !/fetch[^)]*manual-bookings\/create/i.test(uiSrc),
    'create route is NOT wired to the UI (no fetch in buildUiHtml)');
})();
// No Stripe session / invoice / payment-link creation anywhere in the handler.
check('L41', !/checkout\.sessions?\.create|invoices?\.create|paymentLinks?\.create/i.test(handler),
  'handler creates no Stripe session / invoice / payment link');

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
