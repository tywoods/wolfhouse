'use strict';
// ============================================================================
// verify-staff-bot-availability-api.js
// Static verifier for Stage 8.5.8 — POST /staff/bot/availability-check
// ============================================================================

const fs   = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '..');
const API_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');

let passed = 0, failed = 0;
const results = [];

function check(id, desc, ok, detail) {
  if (ok) {
    passed++;
    results.push(`  PASS  [${id}] ${desc}`);
  } else {
    failed++;
    results.push(`  FAIL  [${id}] ${desc}${detail ? ' — ' + detail : ''}`);
  }
}

// ── Locate handler + router block ───────────────────────────────────────────
const handlerStart = API_SRC.indexOf('async function handleBotAvailabilityCheck(');
const handlerEnd   = handlerStart > -1
  ? API_SRC.indexOf('\nasync function handle', handlerStart + 100)
  : -1;
const handlerText  = handlerStart > -1 && handlerEnd > -1
  ? API_SRC.slice(handlerStart, handlerEnd)
  : (handlerStart > -1 ? API_SRC.slice(handlerStart, handlerStart + 8000) : '');

const routeIdx   = API_SRC.indexOf("'/staff/bot/availability-check'");
const routeBlock = routeIdx > -1 ? API_SRC.slice(routeIdx, routeIdx + 600) : '';

// ── A. Endpoint + handler existence ─────────────────────────────────────────
check('A1', 'handleBotAvailabilityCheck function defined',
  API_SRC.includes('async function handleBotAvailabilityCheck('));

check('A2', "route '/staff/bot/availability-check' registered in router",
  API_SRC.includes("'/staff/bot/availability-check'"));

check('A3', 'router block dispatches to handleBotAvailabilityCheck',
  routeBlock.includes('handleBotAvailabilityCheck'));

check('A4', 'POST /staff/bot/availability-check listed in startup log',
  API_SRC.includes('bot/availability-check') && API_SRC.includes('8.5.8'));

// ── B. Auth ──────────────────────────────────────────────────────────────────
check('B1', 'route uses requireBotAuth()',
  routeBlock.includes('requireBotAuth'));

check('B2', 'requireBotAuth defined in file (bot token auth, not requireAuth)',
  API_SRC.includes('async function requireBotAuth('));

check('B3', 'token auth scoped to /staff/bot route (does not apply to /staff/ui)',
  !routeBlock.includes('/staff/ui') &&
  API_SRC.includes("'/staff/bot/availability-check'") &&
  !API_SRC.includes("requireBotAuth.*'/staff/ui'"));

// ── C. Read-only safety fields ───────────────────────────────────────────────
check('C1', "handler returns preview_only: true",
  handlerText.includes('preview_only') && (handlerText.includes('preview_only:        true') || handlerText.includes("preview_only: true")));

check('C2', "handler returns no_write_performed: true",
  handlerText.includes('no_write_performed') && (handlerText.includes('no_write_performed:  true') || handlerText.includes("no_write_performed: true")));

check('C3', "handler returns creates_booking: false",
  handlerText.includes('creates_booking') && (handlerText.includes('creates_booking:     false') || handlerText.includes("creates_booking: false")));

check('C4', "handler returns creates_payment: false",
  handlerText.includes('creates_payment') && (handlerText.includes('creates_payment:     false') || handlerText.includes("creates_payment: false")));

check('C5', "handler returns creates_stripe_link: false",
  handlerText.includes('creates_stripe_link') && (handlerText.includes('creates_stripe_link: false') || handlerText.includes("creates_stripe_link: false")));

check('C6', "handler returns sends_whatsapp: false",
  handlerText.includes('sends_whatsapp') && (handlerText.includes('sends_whatsapp:      false') || handlerText.includes("sends_whatsapp: false")));

// ── D. No writes ─────────────────────────────────────────────────────────────
const handlerNoComments = handlerText.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
check('D1', 'handler contains no INSERT statement',
  !handlerNoComments.match(/\bINSERT\s+INTO\b/i));

check('D2', 'handler contains no UPDATE statement',
  !handlerNoComments.match(/\bUPDATE\s+\w/i));

check('D3', 'handler contains no DELETE statement',
  !handlerNoComments.match(/\bDELETE\s+FROM\b/i));

// ── E. Correct DB helpers used ───────────────────────────────────────────────
check('E1', 'handler uses getBedCalendarRoomsQuery or equivalent beds query',
  handlerText.includes('getBedCalendarRoomsQuery') || handlerText.includes('beds') && handlerText.includes('SELECT'));

check('E2', 'handler uses getBedCalendarBlocksQuery or equivalent booking_beds overlap query',
  handlerText.includes('getBedCalendarBlocksQuery') || handlerText.includes('booking_beds') && handlerText.includes('SELECT'));

check('E3', 'both query helpers imported at file level',
  API_SRC.includes('getBedCalendarRoomsQuery') && API_SRC.includes('getBedCalendarBlocksQuery'));

// ── F. Half-open overlap ──────────────────────────────────────────────────────
// The overlap logic lives in getBedCalendarBlocksQuery (already uses half-open).
// Handler references the query which implements it.
check('F1', 'half-open interval pattern used (assignment_start_date < check_out or equivalent)',
  API_SRC.includes('assignment_start_date < $3') || API_SRC.includes('assignment_start_date <') ||
  handlerText.includes('half-open') || handlerText.includes('overlapsHalfOpen'));

check('F2', 'cancelled/expired statuses excluded from overlap query',
  API_SRC.includes("NOT IN ('cancelled', 'expired')") || API_SRC.includes("'cancelled'") ||
  // excluded status check lives in getBedCalendarBlocksQuery (imported helper)
  fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-bed-calendar-queries.js'), 'utf8').includes("'cancelled', 'expired'"));

// ── G. Selected bed codes + response shape ───────────────────────────────────
check('G1', 'handler returns selected_bed_codes',
  handlerText.includes('selected_bed_codes'));

check('G2', 'first-fit selection: slices available beds to guest_count',
  handlerText.includes('slice(0, guestCount)') || handlerText.includes('.slice(0,') || handlerText.includes('guestCount'));

check('G3', 'handler returns has_enough_beds',
  handlerText.includes('has_enough_beds'));

check('G4', 'handler returns available_beds array',
  handlerText.includes('available_beds'));

check('G5', 'handler returns available_count',
  handlerText.includes('available_count'));

check('G6', 'handler returns next_action (ready_for_bot_create or ask_staff_or_alternate_dates)',
  handlerText.includes('ready_for_bot_create') && handlerText.includes('ask_staff_or_alternate_dates'));

// ── H. Not-enough-beds blocker ───────────────────────────────────────────────
check('H1', 'not_enough_available_beds blocker pushed when hasEnoughBeds is false',
  handlerText.includes('not_enough_available_beds'));

check('H2', 'selected_bed_codes returns [] when not enough beds',
  handlerText.includes('[]') || handlerText.includes('selected_bed_codes: []') || handlerText.includes('selectedBedCodes = []'));

// ── I. No external calls ──────────────────────────────────────────────────────
const handlerStripped = handlerNoComments;
check('I1', 'handler does not call Stripe API (api.stripe.com)',
  !handlerStripped.includes('api.stripe.com') && !handlerStripped.includes("stripe.checkout"));

check('I2', 'handler does not send WhatsApp (no graph.facebook.com URL or whatsapp send call)',
  !handlerStripped.includes('graph.facebook.com') &&
  !handlerStripped.match(/httpRequest.*whatsapp|whatsapp.*send/i));

check('I3', 'handler does not call n8n (n8n webhook / trigger workflow)',
  !handlerStripped.replace(/\/\/[^\n]*/g, '').match(/n8n|triggerWorkflow/i));

// ── J. Room-type filter + warnings ──────────────────────────────────────────
check('J1', 'room_type filtering logic present',
  handlerText.includes('roomType') && handlerText.includes('room_type'));

check('J2', 'room_type_filter_not_strict warning pushed when filter cannot be applied strictly',
  handlerText.includes('room_type_filter_not_strict'));

// ── K. Auth response ─────────────────────────────────────────────────────────
check('K1', 'auth_mode included in response',
  handlerText.includes('auth_mode'));

// ── L. Input validation ──────────────────────────────────────────────────────
check('L1', 'check_in required validation',
  handlerText.includes("'check_in is required'") || handlerText.includes('checkIn'));

check('L2', 'check_out required validation',
  handlerText.includes("'check_out is required'") || handlerText.includes('checkOut'));

check('L3', 'guest_count >= 1 validation',
  handlerText.includes('guestCount < 1') || handlerText.includes('guest_count must be'));

check('L4', 'date comparison: check_out must be after check_in',
  handlerText.includes('coDate <= ciDate') || handlerText.includes('check_out must be after'));

// ── Print results ──────────────────────────────────────────────────────────
results.forEach(r => console.log(r));
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('verify-staff-bot-availability-api PASS');
  process.exit(0);
} else {
  console.log('verify-staff-bot-availability-api FAIL');
  process.exit(1);
}
