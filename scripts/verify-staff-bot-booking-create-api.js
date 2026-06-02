#!/usr/bin/env node
// verify-staff-bot-booking-create-api.js
// Stage 8.5.4 — Static verifier for POST /staff/bot/bookings/create
//
// Non-negotiables verified:
//   - Endpoint exists and routes to handleBotBookingCreate
//   - Uses requireBotAuth (bot-scoped, not bare requireAuth)
//   - BOT_BOOKING_ENABLED flag exists, defaults false, gates the route
//   - requires confirm=true
//   - requires selected_bed_codes (this slice)
//   - calls calculateWolfhouseQuote()
//   - creates draft payment row (UPDATE payments ... RETURNING payment_id)
//   - stores quote_snapshot in booking metadata
//   - returns payment_id, creates_stripe_link:false, sends_whatsapp:false
//   - no Stripe API calls, no WhatsApp calls, no n8n calls
//   - no Azure infra changes
//   - token auth scoped to bot route only
//   - node --check passes

'use strict';
const fs        = require('fs');
const path      = require('path');
const { execSync } = require('child_process');

const TARGET = path.join(__dirname, 'staff-query-api.js');
const PKG    = path.join(__dirname, '..', 'package.json');

if (!fs.existsSync(TARGET)) {
  console.error('FATAL: staff-query-api.js not found at', TARGET);
  process.exit(1);
}
const src = fs.readFileSync(TARGET, 'utf8');

// Extract handleBotBookingCreate function body
const handlerStart = src.indexOf('async function handleBotBookingCreate(');
const handlerEnd   = (() => {
  // Walk forward from handlerStart to find the matching closing brace
  if (handlerStart < 0) return -1;
  let depth = 0, i = handlerStart;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return -1;
})();
const handler = handlerStart >= 0 && handlerEnd > handlerStart
  ? src.slice(handlerStart, handlerEnd)
  : '';

// Extract the bot/bookings/create router block
const routeIdx   = src.indexOf("pathname === '/staff/bot/bookings/create'");
const routeBlock = routeIdx >= 0 ? src.slice(routeIdx, routeIdx + 600) : '';

// ─────────────────────────────────────────────────────────────────────────────
const results = [];
function check(id, label, fn) {
  try {
    const err = fn();
    if (err) { results.push({ id, label, ok: false, err }); }
    else      { results.push({ id, label, ok: true }); }
  } catch (e) {
    results.push({ id, label, ok: false, err: e.message });
  }
}

// ─── A. Endpoint exists ───────────────────────────────────────────────────────

check('A1', 'staff-query-api.js exists', () => {
  if (!fs.existsSync(TARGET)) return 'staff-query-api.js not found';
});

check('A2', "router block for '/staff/bot/bookings/create' exists", () => {
  if (routeBlock === '') return "pathname === '/staff/bot/bookings/create' not found in router";
});

check('A3', 'handleBotBookingCreate function defined', () => {
  if (handlerStart < 0) return 'handleBotBookingCreate not found in source';
});

check('A4', 'router block dispatches to handleBotBookingCreate', () => {
  if (!routeBlock.includes('handleBotBookingCreate')) {
    return 'router block does not call handleBotBookingCreate';
  }
});

check('A5', 'route only accepts POST method', () => {
  if (!routeBlock.includes("method !== 'POST'")) return 'no method guard found in route block';
});

// ─── B. Auth ──────────────────────────────────────────────────────────────────

check('B1', 'route uses requireBotAuth (not bare requireAuth)', () => {
  if (!routeBlock.includes('requireBotAuth')) return 'requireBotAuth not called in route block';
});

check('B2', 'requireBotAuth function exists in source', () => {
  if (!src.includes('async function requireBotAuth')) return 'requireBotAuth not found';
});

check('B3', 'requireAuth (normal staff auth) is NOT modified', () => {
  const fnIdx = src.indexOf('async function requireAuth');
  const fnSlice = fnIdx >= 0 ? src.slice(fnIdx, fnIdx + 500) : '';
  if (fnSlice.includes('LUNA_BOT_INTERNAL_TOKEN') || fnSlice.includes('x-luna-bot-token')) {
    return 'requireAuth references bot token — normal auth must not be weakened';
  }
});

check('B4', 'handler accepts and uses authMode parameter', () => {
  if (!handler.includes('authMode')) return 'authMode parameter not found in handleBotBookingCreate';
});

// ─── C. Feature flag ──────────────────────────────────────────────────────────

check('C1', 'BOT_BOOKING_ENABLED constant defined', () => {
  if (!src.includes('BOT_BOOKING_ENABLED')) return 'BOT_BOOKING_ENABLED not found in source';
});

check('C2', 'BOT_BOOKING_ENABLED read from process.env (default false)', () => {
  if (!src.includes("process.env.BOT_BOOKING_ENABLED === 'true'")) {
    return "BOT_BOOKING_ENABLED not compared to 'true' — default must be false";
  }
});

check('C3', 'handler gates on BOT_BOOKING_ENABLED → 403 when false', () => {
  if (!handler.includes('BOT_BOOKING_ENABLED')) return 'BOT_BOOKING_ENABLED not checked in handler';
  if (!handler.includes('403')) return 'handler does not return 403 when flag is false';
});

check('C4', 'BOT_BOOKING_ENABLED is separate from MANUAL_BOOKING_ENABLED', () => {
  // Both must exist and be independent
  if (!src.includes('MANUAL_BOOKING_ENABLED')) return 'MANUAL_BOOKING_ENABLED not found';
  if (!src.includes('BOT_BOOKING_ENABLED'))    return 'BOT_BOOKING_ENABLED not found';
  const botIdx    = src.indexOf('BOT_BOOKING_ENABLED');
  const manualIdx = src.indexOf('MANUAL_BOOKING_ENABLED');
  // Make sure bot handler doesn't gate on MANUAL_BOOKING_ENABLED
  if (handler.includes('MANUAL_BOOKING_ENABLED')) {
    return 'handler gates on MANUAL_BOOKING_ENABLED — should use BOT_BOOKING_ENABLED only';
  }
});

// ─── D. Validation ────────────────────────────────────────────────────────────

check('D1', 'handler requires confirm: true', () => {
  if (!handler.includes('confirmFlag') || !handler.includes('confirm: true')) {
    return 'confirm:true guard not found in handler';
  }
});

check('D2', 'handler requires selected_bed_codes (this slice)', () => {
  if (!handler.includes('selected_bed_codes')) return 'selected_bed_codes not found in handler';
  if (!handler.includes('selected_bed_codes is required')) {
    return 'missing error message for empty selected_bed_codes';
  }
});

check('D3', 'handler requires phone', () => {
  if (!handler.includes("'phone is required'")) return 'phone is required check missing';
});

check('D4', 'handler requires guest_name', () => {
  if (!handler.includes("'guest_name is required'")) return 'guest_name is required check missing';
});

check('D5', 'handler requires package_code', () => {
  if (!handler.includes('package_code is required')) return 'package_code required check missing';
});

check('D6', 'handler validates YYYY-MM-DD date format', () => {
  if (!handler.includes('YYYY-MM-DD')) return 'date format validation not found';
});

// ─── E. Quote calculation ─────────────────────────────────────────────────────

check('E1', 'calculateWolfhouseQuote imported', () => {
  if (!src.includes("calculateWolfhouseQuote")) return 'calculateWolfhouseQuote not found in source';
  if (!src.includes("require('./lib/wolfhouse-quote-calculator')") &&
      !src.includes('wolfhouse-quote-calculator')) {
    return 'wolfhouse-quote-calculator import not found';
  }
});

check('E2', 'calculateWolfhouseQuote called inside handleBotBookingCreate', () => {
  if (!handler.includes('calculateWolfhouseQuote(')) {
    return 'calculateWolfhouseQuote not called in handler';
  }
});

check('E3', 'amounts derived from quote (never from client body)', () => {
  if (!handler.includes('quote.total_cents') && !handler.includes('totalCents')) {
    return 'quote-derived amounts not found in handler';
  }
  if (!handler.includes('quote.deposit_required_cents') && !handler.includes('depositCents')) {
    return 'quote.deposit_required_cents not found in handler';
  }
});

// ─── F. DB writes (booking + payment) ────────────────────────────────────────

check('F1', 'handler calls buildManualBookingCreateSql (shared SQL helper)', () => {
  if (!handler.includes('buildManualBookingCreateSql()')) {
    return 'buildManualBookingCreateSql not called — handler must reuse shared SQL';
  }
});

check('F2', 'handler stores quote_snapshot in booking metadata', () => {
  if (!handler.includes('quote_snapshot')) return 'quote_snapshot not stored in booking metadata';
});

check('F3', 'handler updates draft payment row (UPDATE payments)', () => {
  if (!handler.includes('UPDATE payments')) {
    return 'UPDATE payments not found in handler — draft payment update missing';
  }
});

check('F4', 'handler reads back payment_id (RETURNING id AS payment_id)', () => {
  if (!handler.includes('payment_id')) return 'payment_id not found in handler';
  if (!handler.includes('RETURNING id AS payment_id') && !handler.includes('_payment_id')) {
    return 'RETURNING payment_id or _payment_id not found in handler';
  }
});

check('F5', 'handler runs inside withPgClient transaction (BEGIN/COMMIT/ROLLBACK)', () => {
  if (!handler.includes('withPgClient')) return 'withPgClient not found in handler';
  if (!handler.includes("'BEGIN'"))  return 'BEGIN not found in handler transaction';
  if (!handler.includes("'COMMIT'")) return 'COMMIT not found in handler transaction';
  if (!handler.includes("'ROLLBACK'")) return 'ROLLBACK not found in handler';
});

check('F6', 'handler uses deterministic idempotency key (bot- prefix)', () => {
  if (!handler.includes("'bot-'")) return "idempotency key with 'bot-' prefix not found in handler";
});

// ─── G. Response fields ───────────────────────────────────────────────────────

check('G1', 'response includes success: true', () => {
  if (!handler.includes('success:')) return 'success field missing from response';
});

check('G2', "response includes created: true", () => {
  if (!handler.includes('created:')) return 'created field missing from response';
});

check('G3', 'response includes booking_id', () => {
  if (!handler.includes('booking_id:')) return 'booking_id missing from response';
});

check('G4', 'response includes booking_code', () => {
  if (!handler.includes('booking_code:')) return 'booking_code missing from response';
});

check('G5', 'response includes payment_id', () => {
  if (!handler.includes('payment_id:')) return 'payment_id missing from response';
});

check('G6', "response includes payment_status: 'draft'", () => {
  if (!handler.includes("payment_status:")) return "payment_status field missing from response";
  if (!handler.includes("'draft'")) return "payment_status 'draft' value missing";
});

check('G7', "response includes next_action: 'create_stripe_link'", () => {
  if (!handler.includes("next_action:")) return "next_action missing from response";
  if (!handler.includes("'create_stripe_link'")) return "next_action 'create_stripe_link' value missing";
});

check('G8', 'response includes creates_stripe_link: false', () => {
  if (!handler.includes('creates_stripe_link: false')) {
    return 'creates_stripe_link: false not found in response';
  }
});

check('G9', 'response includes sends_whatsapp: false', () => {
  if (!handler.includes('sends_whatsapp: false')) return 'sends_whatsapp: false not found in response';
});

check('G10', 'response includes whatsapp_dry_run: true', () => {
  if (!handler.includes('whatsapp_dry_run: true')) return 'whatsapp_dry_run: true not found in response';
});

check('G11', 'response includes quote object', () => {
  if (!handler.includes('quote:')) return 'quote field missing from response';
});

check('G12', 'response includes auth_mode', () => {
  if (!handler.includes('auth_mode:')) return 'auth_mode missing from response';
});

check('G13', 'response includes source field', () => {
  if (!handler.includes('source,') && !handler.includes('source:')) return 'source missing from response';
});

// ─── H. No external calls ─────────────────────────────────────────────────────

check('H1', 'handler has no Stripe API calls', () => {
  if (/stripe\.(checkout|paymentIntents|customers|prices)\s*\./i.test(handler)) {
    return 'Stripe API call found in handler';
  }
  if (handler.includes('stripe.checkout') || handler.includes('stripe.payment')) {
    return 'Stripe API call found in handler';
  }
});

check('H2', 'handler has no WhatsApp send calls', () => {
  if (/whatsapp.*send|sendWhatsApp|twilio.*messages/i.test(handler)) {
    return 'WhatsApp send call found in handler';
  }
});

check('H3', 'handler has no n8n webhook calls', () => {
  // Strip single-line comments before checking to avoid false positives on "Does NOT call n8n"
  const stripped = handler.replace(/\/\/.*$/gm, '');
  if (/n8n\s*\.|triggerN8n|callN8n|webhook.*trigger/i.test(stripped)) {
    return 'n8n/webhook call found in handler code (not comment)';
  }
});

check('H4', 'handler has no fetch() call (no external HTTP)', () => {
  if (/\bfetch\s*\(/m.test(handler)) return 'fetch() call found in handler';
});

check('H5', 'handler does not call /staff/payments/*/create-stripe-link path', () => {
  if (handler.includes('create-stripe-link')) {
    return 'create-stripe-link path found in handler — must not create Stripe link';
  }
});

// ─── I. Scope (token auth only on bot routes) ─────────────────────────────────

check('I1', 'token auth not applied to /staff/manual-bookings/create', () => {
  const idx = src.indexOf("pathname === '/staff/manual-bookings/create'");
  const slice = idx >= 0 ? src.slice(idx, idx + 300) : '';
  if (slice.includes('requireBotAuth')) {
    return '/staff/manual-bookings/create uses requireBotAuth — must use requireAuth';
  }
});

check('I2', 'token auth not applied to /staff/stripe/webhook', () => {
  const idx = src.indexOf("pathname === '/staff/stripe/webhook'");
  const slice = idx >= 0 ? src.slice(idx, idx + 300) : '';
  if (slice.includes('requireBotAuth')) {
    return '/staff/stripe/webhook uses requireBotAuth — must not';
  }
});

// ─── J. No Azure / migration changes ─────────────────────────────────────────

check('J1', 'handler references no Azure deployment paths', () => {
  if (/azure|bicep|terraform|az deploy/i.test(handler)) {
    return 'Azure/infra reference found in handler';
  }
});

check('J2', 'handler contains no SQL migration (CREATE TABLE / ALTER TABLE)', () => {
  if (/CREATE\s+TABLE|ALTER\s+TABLE/i.test(handler)) {
    return 'DDL migration found in handler';
  }
});

// ─── K. node --check ─────────────────────────────────────────────────────────

check('K1', 'staff-query-api.js passes node --check', () => {
  try {
    execSync(`node --check "${TARGET}"`, { stdio: 'pipe' });
  } catch (e) {
    return `node --check failed: ${e.stderr ? e.stderr.toString().trim() : e.message}`;
  }
});

check('K2', 'verify-staff-bot-booking-create-api.js passes node --check', () => {
  const self = path.join(__dirname, 'verify-staff-bot-booking-create-api.js');
  try {
    execSync(`node --check "${self}"`, { stdio: 'pipe' });
  } catch (e) {
    return `node --check failed: ${e.stderr ? e.stderr.toString().trim() : e.message}`;
  }
});

// ─── L. package.json ──────────────────────────────────────────────────────────

check('L1', 'package.json has verify:staff-bot-booking-create-api script', () => {
  if (!fs.existsSync(PKG)) return 'package.json not found';
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (!pkg.scripts || !pkg.scripts['verify:staff-bot-booking-create-api']) {
    return 'verify:staff-bot-booking-create-api not found in package.json scripts';
  }
});

// ─── M. Startup log ───────────────────────────────────────────────────────────

check('M1', 'startup log mentions /staff/bot/bookings/create', () => {
  if (!src.includes('/staff/bot/bookings/create')) {
    return '/staff/bot/bookings/create not in source (startup log check)';
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
for (const r of results) {
  if (r.ok) {
    passed++;
    console.log(`  PASS [${r.id}] ${r.label}`);
  } else {
    failed++;
    console.log(`  FAIL [${r.id}] ${r.label}`);
    console.log(`       → ${r.err}`);
  }
}
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('verify-staff-bot-booking-create-api FAILED (' + failed + ' check(s) failed)\n');
  process.exit(1);
} else {
  console.log('verify-staff-bot-booking-create-api PASS\n');
}
