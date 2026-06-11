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
const SVC_LIB  = path.join(__dirname, 'lib', 'manual-booking-service-records.js');
const PKG    = path.join(__dirname, '..', 'package.json');
let passed = 0, failed = 0;

function ok(id, msg)   { console.log(`  PASS  ${id}: ${msg}`); passed++; }
function fail(id, msg) { console.error(`  FAIL  ${id}: ${msg}`); failed++; }
function check(id, cond, msg) { if (cond) ok(id, msg); else fail(id, msg); }

console.log('\nverify-staff-manual-booking-create-api.js  (Stage 8.4)\n');

// ── A. File / syntax ──────────────────────────────────────────────────────────
check('A1', fs.existsSync(TARGET), 'staff-query-api.js exists');
const src = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
const svcLib = fs.existsSync(SVC_LIB) ? fs.readFileSync(SVC_LIB, 'utf8') : '';
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
// I31: no actual Stripe API calls — payment_link_amount_cents is a field name, not a Stripe call
check('I31', !/stripe\s*[\.(]|checkout\.sessions?\.create|payment_links?\.create|createCheckout\s*\(/i.test(handler),
  'handler invokes no Stripe / checkout / payment link API calls');
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

// ── L. Stage 8.4.8 implementation guarantees ────────────────────────────────
const docStart = src.indexOf('// Route: POST /staff/manual-bookings/create');
const routeDoc = docStart >= 0 ? src.slice(docStart, hStart > docStart ? hStart : docStart + 4000) : '';

// L38: Route header documents Stage 8.4.8 implementation
check('L38', /Stage 8\.4\.8|booking-first|quote-driven/i.test(routeDoc),
  'route header documents Stage 8.4.8 booking-first / quote-driven implementation');

// L39: Handler calls calculateWolfhouseQuote() server-side
check('L39', /calculateWolfhouseQuote\s*\(/.test(handler),
  'handler calls calculateWolfhouseQuote() server-side (not from client body)');

// L40: UI now wires to /staff/manual-bookings/create (gated by flags)
(function checkUiWired(){
  const uiIdx = src.indexOf('function buildUiHtml');
  const uiSrc = uiIdx >= 0 ? src.slice(uiIdx, src.indexOf('function handleUI', uiIdx) > 0 ? src.indexOf('function handleUI', uiIdx) : uiIdx + 200000) : src;
  check('L40', /fetch\s*\(\s*['"]\/staff\/manual-bookings\/create['"]/.test(uiSrc),
    'create route IS wired to the UI (fetch in buildUiHtml)');
})();

// L41: No Stripe session / invoice / payment-link creation
check('L41', !/checkout\.sessions?\.create|invoices?\.create|paymentLinks?\.create/i.test(handler),
  'handler creates no Stripe session / invoice / payment link');

// ── M. Stage 8.4.8: Quote-driven amount checks ──────────────────────────────
// M42: Handler does NOT read deposit/total from body (amounts come from quote)
check('M42', !/parseInt\(body\.deposit_amount_cents|parseInt\(body\.total_amount_cents/.test(handler),
  'handler does NOT read deposit/total from request body (amounts from quote only)');

// M43: Quote snapshot stored in booking metadata UPDATE
check('M43', /quote_snapshot/.test(handler) && /UPDATE bookings/.test(handler),
  'handler stores quote_snapshot in booking metadata (UPDATE bookings)');

// M44: payment_kind determined from payment_choice
const applyPayFn = src.match(/async function manualBookingApplyStaffPaymentChoice[\s\S]*?\n\}/)?.[0] || '';
check('M44', /manualBookingPaymentKindForStaffChoice/.test(handler)
  && /paymentKind/.test(applyPayFn),
  'payment_kind derived from payment_choice in applyStaffPaymentChoice');

// M45: payment row gets quote-derived amount_due_cents (apply path, not legacy SQL draft)
check('M45', /UPDATE payments/.test(applyPayFn) && /amount_due_cents/.test(applyPayFn)
  && /checkout_created/.test(applyPayFn),
  'applyStaffPaymentChoice sets quote-derived amount_due_cents + checkout_created');

// M46: Handler returns quote_summary in success response
check('M46', /quote_summary/.test(handler),
  'handler returns quote_summary in 201 success response');

// M47: Server-side flag embedding in UI (BC_STAFF_ACTIONS, BC_MANUAL_BOOKING)
check('M47',
  /BC_STAFF_ACTIONS\s*=\s*\$\{STAFF_ACTIONS_ENABLED\}/.test(src) &&
  /BC_MANUAL_BOOKING\s*=\s*\$\{MANUAL_BOOKING_ENABLED\}/.test(src),
  'UI template embeds server flags as JS vars (BC_STAFF_ACTIONS, BC_MANUAL_BOOKING)');

// M48: UI has bcUpdateCreateButton checking manual booking flag
check('M48', /function bcUpdateCreateButton/.test(src) &&
  /BC_MANUAL_BOOKING/.test(src.match(/function bcUpdateCreateButton[\s\S]*?\n\}/)?.[0] || ''),
  'UI has bcUpdateCreateButton() checking MANUAL_BOOKING_ENABLED flag');

// M49: UI has runManualBookingCreate posting to create route
check('M49', /function runManualBookingCreate/.test(src),
  'UI has runManualBookingCreate() function');

// M50: UI payload does NOT send trusted deposit/total from form
(function checkUiPayload(){
  const fnStart = src.indexOf('function runManualBookingCreate');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction render', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check('M50', !/deposit_amount_cents|total_amount_cents/.test(fnSrc),
    'UI runManualBookingCreate does NOT send deposit_amount_cents/total_amount_cents (trust quote only)');
})();

// ── O. Stage 8.8.16 / 26j.2 — booking_service_records on manual create ───────
(function check8816ManualCreateServiceRecords(){
  check('O51', /INSERT INTO booking_service_records/.test(src) &&
        /tryInsertManualBookingServiceRecords/.test(handler),
    'manual create inserts into booking_service_records (Stage 8.8.16)');
  check('O52', /tryInsertManualBookingServiceRecords/.test(handler) &&
        /await pg\.query\('COMMIT'\)/.test(handler) &&
        handler.indexOf('tryInsertManualBookingServiceRecords') < handler.indexOf("await pg.query('COMMIT')"),
    'service record insert happens inside transaction before COMMIT (Stage 8.8.16)');
  check('O53', /buildManualBookingServiceRecordRows\(\{/.test(handler) &&
        /bookingId:\s*result\.booking_id/.test(handler) &&
        /bookingCode:\s*result\.booking_code/.test(handler) &&
        /clientSlug,/.test(handler) && /guestName,/.test(handler),
    'service records use booking_id, booking_code, client_slug, guest_name (Stage 8.8.16)');
  check('O54', /MANUAL_BOOKING_ADDON_SERVICE_MAP/.test(svcLib) &&
        /wetsuit_rental.*wetsuit|wetsuit_rental:\s*'wetsuit'/.test(svcLib) &&
        /soft_top_rental.*surfboard|soft_top_rental:\s*'surfboard'/.test(svcLib) &&
        /surf_lesson/.test(svcLib) && /yoga_class.*yoga|'yoga'/.test(svcLib),
    'supported add-on → service_type mapping exists (Stage 8.8.16 / lib)');
  check('O55', /wetsuit_soft_top_combo/.test(svcLib) && /wetsuit_hard_board_combo/.test(svcLib) &&
        /combo_part:\s*'wetsuit'/.test(svcLib) && /combo_part:\s*'surfboard'/.test(svcLib),
    'combo add-ons expand to wetsuit + surfboard records (Stage 8.8.16 / lib)');
  check('O56', /addon\.code !== 'meals' && addon\.code !== 'meal'/.test(svcLib) &&
        /serviceType:\s*'meal'/.test(svcLib) &&
        /quoteLineItemAmount\(quote, 'meals'\)/.test(svcLib),
    'meals mapped to meal service records via quote line (Stage 26j.2 / lib)');
  check('O57', /function servicePaymentStatus/.test(svcLib) &&
        /return Number\(amountDueCents\) > 0 \? 'pending' : 'not_requested'/.test(svcLib),
    'service record payment_status is pending or not_requested only — never paid (Stage 8.8.16 / lib)');
  check('O58', /isMissingBookingServiceRecordsTable/.test(src) &&
        /service_records_warning/.test(handler),
    'table-missing safe skip with service_records_warning (Stage 8.8.16)');
  check('O59', /service_records_created/.test(handler),
    'response includes service_records_created (Stage 8.8.16)');
  check('O60', /needs_scheduling:\s*true|needs_scheduling\s*=\s*true/.test(svcLib) &&
        /rental_days/.test(svcLib),
    'metadata includes needs_scheduling and rental_days when applicable (Stage 8.8.16 / lib)');
  check('O61', /source:\s*'staff_manual'/.test(svcLib.slice(svcLib.indexOf('function buildManualBookingServiceRecordRows'),
        svcLib.indexOf('module.exports'))),
    'service records use source staff_manual (Stage 8.8.16 / lib)');
  check('O62', !/graph\.facebook\.com/.test(handler),
    'handler has no graph.facebook.com (Stage 8.8.16)');
  check('O63', !(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(handler)),
    'handler has no n8n URL fetch (Stage 8.8.16)');
  check('O64', !/checkout\.sessions?\.create|api\.stripe\.com/.test(handler),
    'handler has no Stripe API changes (Stage 8.8.16)');
  check('O65', !/confirmation_sent_at/.test(handler),
    'handler does not write confirmation_sent_at (Stage 8.8.16)');

  // Runtime smoke — lock mapping shape against quote engine (Stage 43b)
  try {
    const { buildManualBookingServiceRecordRows } = require('./lib/manual-booking-service-records');
    const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
    const baseQuote = calculateWolfhouseQuote({
      client_slug: 'wolfhouse-somo',
      check_in: '2026-06-15',
      check_out: '2026-06-22',
      guest_count: 2,
      package_code: 'malibu',
      room_type: 'shared',
      payment_choice: 'deposit',
      add_ons: [
        { code: 'wetsuit_soft_top_combo', days: 2 },
        { code: 'soft_top_rental', days: 2 },
        { code: 'surf_lesson_single', quantity: 1 },
        { code: 'yoga_class', quantity: 1 },
        { code: 'meals', quantity: 2 },
      ],
    });
    const rows = buildManualBookingServiceRecordRows({
      addOns: [
        { code: 'wetsuit_soft_top_combo', days: 2 },
        { code: 'soft_top_rental', days: 2 },
        { code: 'surf_lesson_single', quantity: 1 },
        { code: 'yoga_class', quantity: 1 },
        { code: 'meals', quantity: 2 },
      ],
      quote: baseQuote,
      clientSlug: 'wolfhouse-somo',
      bookingId: '00000000-0000-4000-8000-000000000099',
      bookingCode: 'MB-43B-SMOKE',
      guestName: 'Smoke Test',
      checkIn: '2026-06-15',
      guestCount: 2,
    });
    const types = rows.map((r) => r.service_type);
    check('O66', types.includes('wetsuit') && types.includes('surfboard') && types.includes('surf_lesson')
      && types.includes('yoga') && types.includes('meal'),
      'runtime mapping produces wetsuit/surfboard/lesson/yoga/meal rows');
    check('O67', rows.every((r) => r.booking_id === '00000000-0000-4000-8000-000000000099'
      && r.booking_code === 'MB-43B-SMOKE' && r.source === 'staff_manual'),
      'runtime rows bind booking_id/booking_code/source staff_manual');
    check('O68', rows.every((r) => r.payment_status === 'pending' || r.payment_status === 'not_requested'),
      'runtime payment_status never paid');
  } catch (e) {
    fail('O66', `runtime service-record mapping smoke failed: ${e.message}`);
    fail('O67', 'runtime booking binding smoke skipped');
    fail('O68', 'runtime payment_status smoke skipped');
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
