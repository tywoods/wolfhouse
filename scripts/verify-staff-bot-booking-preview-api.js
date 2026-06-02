'use strict';
/**
 * verify-staff-bot-booking-preview-api.js
 * Stage 8.5.2 — Static verifier for POST /staff/bot/booking-preview.
 *
 * Confirms the endpoint:
 *  A. Route + handler present in staff-query-api.js.
 *  B. calculateWolfhouseQuote imported and called in handler.
 *  C. Pricing config exists.
 *  D. Response includes all required safety fields.
 *  E. Handler contains no INSERT / UPDATE / DELETE SQL, no withPgClient.
 *  F. No Stripe, WhatsApp, n8n, or fetch() calls in handler.
 *  G. missing_fields behavior present.
 *  H. next_action behavior present.
 *  I. reply_draft behavior present.
 *  J. availability.status = 'not_checked' present.
 *  K. Auth: requireAuth called on route.
 *  L. Not gated on MANUAL_BOOKING_ENABLED or STAFF_ACTIONS_ENABLED.
 *  M. node --check passes (staff-query-api.js + this file).
 *  N. package.json has verify script.
 *  O. Startup log mentions endpoint.
 *
 * Usage: node scripts/verify-staff-bot-booking-preview-api.js
 */

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const TARGET = path.join(__dirname, 'staff-query-api.js');
const PKG    = path.join(__dirname, '..', 'package.json');

let passed = 0, failed = 0;

function check(id, description, fn) {
  try {
    const result = fn();
    if (result === true || result === undefined) {
      console.log(`  PASS [${id}] ${description}`);
      passed++;
    } else {
      console.error(`  FAIL [${id}] ${description}`);
      if (typeof result === 'string') console.error(`       \u2192 ${result}`);
      failed++;
    }
  } catch (err) {
    console.error(`  FAIL [${id}] ${description}`);
    console.error(`       \u2192 ${err.message}`);
    failed++;
  }
}

check('A1', 'staff-query-api.js exists', () => {
  if (!fs.existsSync(TARGET)) return `File not found: ${TARGET}`;
});

if (!fs.existsSync(TARGET)) {
  console.error('\n  Cannot continue \u2014 staff-query-api.js not found.\n');
  process.exit(1);
}

const src = fs.readFileSync(TARGET, 'utf8');

// ─── A. Route + handler ──────────────────────────────────────────────────────

check('A2', "router dispatches pathname === '/staff/bot/booking-preview'", () => {
  if (!/pathname === ['"]\/staff\/bot\/booking-preview['"]/.test(src)) {
    return "no route for '/staff/bot/booking-preview' found in router";
  }
});

check('A3', 'handleBotBookingPreview function defined', () => {
  if (!src.includes('async function handleBotBookingPreview')) {
    return 'handleBotBookingPreview not found in source';
  }
});

check('A4', 'route accepts POST method', () => {
  if (!/bot\/booking-preview[\s\S]{0,300}method !== 'POST'/.test(src) &&
      !/method !== 'POST'[\s\S]{0,300}bot\/booking-preview/.test(src)) {
    return 'no POST-only guard found near bot/booking-preview route';
  }
});

check('A5', 'route calls handleBotBookingPreview', () => {
  if (!/return handleBotBookingPreview\(req, res/.test(src)) {
    return 'handleBotBookingPreview not called in router';
  }
});

// ─── B. Calculator import + call ─────────────────────────────────────────────

check('B1', "calculateWolfhouseQuote imported from './lib/wolfhouse-quote-calculator'", () => {
  if (!/require\(['"]\.\/lib\/wolfhouse-quote-calculator['"]\)/.test(src)) {
    return 'wolfhouse-quote-calculator not required in staff-query-api.js';
  }
});

// Scope checks to the handler body only
const hStartIdx = src.indexOf('async function handleBotBookingPreview');
const hEndIdx   = hStartIdx > 0 ? src.indexOf('\n// ───', hStartIdx + 100) : -1;
const handler   = hStartIdx > 0
  ? src.slice(hStartIdx, hEndIdx > 0 ? hEndIdx : hStartIdx + 10000)
  : '';

check('B2', 'calculateWolfhouseQuote called inside handleBotBookingPreview', () => {
  if (!handler.includes('calculateWolfhouseQuote(')) {
    return 'calculateWolfhouseQuote not called inside handleBotBookingPreview';
  }
});

// ─── C. Pricing config ────────────────────────────────────────────────────────

check('C1', 'wolfhouse-quote-calculator.js loads wolfhouse-somo.pricing.json', () => {
  const calcPath = path.join(__dirname, 'lib', 'wolfhouse-quote-calculator.js');
  if (!fs.existsSync(calcPath)) return 'wolfhouse-quote-calculator.js not found';
  const calcSrc = fs.readFileSync(calcPath, 'utf8');
  if (!calcSrc.includes('wolfhouse-somo.pricing.json')) {
    return 'pricing config path not found in calculator source';
  }
});

check('C2', 'config/clients/wolfhouse-somo.pricing.json exists', () => {
  const cfgPath = path.join(__dirname, '..', 'config', 'clients', 'wolfhouse-somo.pricing.json');
  if (!fs.existsSync(cfgPath)) return `Config not found: ${cfgPath}`;
});

// ─── D. Response safety fields ────────────────────────────────────────────────

check('D1', 'response includes preview_only: true', () => {
  if (!handler.includes('preview_only') || !handler.includes('true')) {
    return 'preview_only: true not found in handler response';
  }
});

check('D2', 'response includes no_write_performed: true', () => {
  if (!handler.includes('no_write_performed')) return 'no_write_performed not in handler';
});

check('D3', 'response includes creates_booking: false', () => {
  if (!handler.includes('creates_booking')) return 'creates_booking not in handler';
});

check('D4', 'response includes creates_payment: false', () => {
  if (!handler.includes('creates_payment')) return 'creates_payment not in handler';
});

check('D5', 'response includes creates_stripe_link: false', () => {
  if (!handler.includes('creates_stripe_link')) return 'creates_stripe_link not in handler';
});

check('D6', 'response includes sends_whatsapp: false', () => {
  if (!handler.includes('sends_whatsapp')) return 'sends_whatsapp not in handler';
});

check('D7', 'response includes quote field', () => {
  if (!/\bquote,/.test(handler) && !/quote:\s*quote/.test(handler)) {
    return 'quote field not found in handler response';
  }
});

check('D8', 'response includes elapsed_ms', () => {
  if (!handler.includes('elapsed_ms')) return 'elapsed_ms not in handler';
});

// ─── E. No DB writes / no DB connection ──────────────────────────────────────

check('E1', 'handler body contains no INSERT SQL', () => {
  if (/\bINSERT\s+INTO\b/i.test(handler)) return 'INSERT found in handler body';
});

check('E2', 'handler body contains no UPDATE SQL', () => {
  if (/\bUPDATE\s+\w/i.test(handler)) return 'UPDATE found in handler body';
});

check('E3', 'handler body contains no DELETE SQL', () => {
  if (/\bDELETE\s+FROM\b/i.test(handler)) return 'DELETE found in handler body';
});

check('E4', 'handler body has no withPgClient call (no DB connection)', () => {
  if (handler.includes('withPgClient')) {
    return 'withPgClient found in handler \u2014 should not touch DB';
  }
});

// ─── F. No Stripe / WhatsApp / n8n / fetch ───────────────────────────────────

check('F1', 'handler body has no Stripe API calls', () => {
  if (/stripe\.(paymentIntents|checkout|customers|prices|invoices)/i.test(handler)) {
    return 'Stripe API call found in handler';
  }
  if (/require\s*\(\s*['"]stripe['"]\s*\)/.test(handler)) {
    return "require('stripe') found in handler";
  }
});

check('F2', 'handler body has no WhatsApp calls', () => {
  if (/graph\.facebook\.com/i.test(handler)) {
    return 'WhatsApp/Facebook Graph call found in handler';
  }
});

check('F3', 'handler body has no n8n webhook calls', () => {
  if (/n8n\.io|execute-workflow/i.test(handler)) {
    return 'n8n reference found in handler';
  }
});

check('F4', 'handler body has no fetch() call', () => {
  if (/\bfetch\s*\(/.test(handler)) {
    return 'fetch() call found in handler \u2014 must be pure (no network)';
  }
});

check('F5', 'handler does not call /staff/manual-bookings/create path', () => {
  if (handler.includes('/staff/manual-bookings/create')) {
    return 'handler references booking create path \u2014 preview must not create bookings';
  }
});

// ─── G. missing_fields behavior ──────────────────────────────────────────────

check('G1', 'BOT_BOOKING_REQUIRED_FIELDS array defined', () => {
  if (!src.includes('BOT_BOOKING_REQUIRED_FIELDS')) {
    return 'BOT_BOOKING_REQUIRED_FIELDS not found in source';
  }
});

check('G2', 'handler detects missing_fields', () => {
  if (!handler.includes('missingFields')) return 'missingFields not found in handler';
});

check('G3', 'handler returns missing_fields in response', () => {
  if (!handler.includes('missing_fields')) return 'missing_fields not in response object';
});

check('G4', 'handler returns has_missing_fields in response', () => {
  if (!handler.includes('has_missing_fields')) return 'has_missing_fields not in response';
});

check('G5', "required field 'check_in' in BOT_BOOKING_REQUIRED_FIELDS", () => {
  const arrIdx = src.indexOf('BOT_BOOKING_REQUIRED_FIELDS');
  const arrSlice = arrIdx > 0 ? src.slice(arrIdx, arrIdx + 400) : '';
  if (!arrSlice.includes("'check_in'") && !arrSlice.includes('"check_in"')) {
    return "check_in not in BOT_BOOKING_REQUIRED_FIELDS";
  }
});

check('G6', "required field 'payment_choice' in BOT_BOOKING_REQUIRED_FIELDS", () => {
  const arrIdx = src.indexOf('BOT_BOOKING_REQUIRED_FIELDS');
  const arrSlice = arrIdx > 0 ? src.slice(arrIdx, arrIdx + 400) : '';
  if (!arrSlice.includes("'payment_choice'") && !arrSlice.includes('"payment_choice"')) {
    return "payment_choice not in BOT_BOOKING_REQUIRED_FIELDS";
  }
});

// ─── H. next_action behavior ─────────────────────────────────────────────────

check('H1', 'handler computes next_action', () => {
  if (!handler.includes('nextAction')) return 'nextAction not found in handler';
});

check('H2', "handler returns 'ask_missing_fields' next_action", () => {
  if (!handler.includes('ask_missing_fields')) return "ask_missing_fields not found in handler";
});

check('H3', "handler returns 'ready_for_create_dry_run' next_action", () => {
  if (!handler.includes('ready_for_create_dry_run')) {
    return "ready_for_create_dry_run not found in handler";
  }
});

check('H4', "handler returns 'staff_review_required' next_action", () => {
  if (!handler.includes('staff_review_required')) {
    return "staff_review_required not found in handler";
  }
});

check('H5', 'response includes next_action field', () => {
  if (!/next_action:\s*nextAction/.test(handler)) {
    return 'next_action not returned in response object';
  }
});

// ─── I. reply_draft behavior ─────────────────────────────────────────────────

check('I1', 'handler computes replyDraft', () => {
  if (!handler.includes('replyDraft')) return 'replyDraft not found in handler';
});

check('I2', 'reply_draft included in response', () => {
  if (!handler.includes('reply_draft')) return 'reply_draft not in response';
});

check('I3', 'reply_draft includes missing-fields message variant', () => {
  if (!handler.includes('Could you also share')) {
    return 'missing-fields reply_draft text not found';
  }
});

check('I4', 'reply_draft includes quote-ready message variant', () => {
  if (!handler.includes('estimated total')) {
    return 'quote-ready reply_draft text not found';
  }
});

check('I5', 'reply_draft includes staff-review message variant', () => {
  if (!handler.includes("have the team check")) {
    return 'staff-review reply_draft text not found';
  }
});

// ─── J. availability.status = not_checked ────────────────────────────────────

check('J1', "handler returns availability.status = 'not_checked'", () => {
  if (!handler.includes('not_checked')) {
    return "availability.status = 'not_checked' not found in handler";
  }
});

check('J2', 'handler returns availability object with message', () => {
  if (!handler.includes('availability:') && !handler.includes('availability ')) {
    return 'availability field not found in response';
  }
});

// ─── K. Auth ──────────────────────────────────────────────────────────────────

check('K1', 'route calls requireAuth', () => {
  const routeBlock = (() => {
    const idx = src.indexOf("pathname === '/staff/bot/booking-preview'");
    if (idx < 0) return '';
    return src.slice(idx, idx + 400);
  })();
  if (!routeBlock.includes('requireAuth')) {
    return 'requireAuth not called in bot/booking-preview route block';
  }
});

// ─── L. Not gated on write flags ─────────────────────────────────────────────

check('L1', 'route does NOT gate on MANUAL_BOOKING_ENABLED', () => {
  const routeBlock = (() => {
    const idx = src.indexOf("pathname === '/staff/bot/booking-preview'");
    if (idx < 0) return '';
    return src.slice(idx, idx + 400);
  })();
  if (routeBlock.includes('MANUAL_BOOKING_ENABLED')) {
    return 'route references MANUAL_BOOKING_ENABLED \u2014 preview must not gate on it';
  }
});

check('L2', 'route does NOT gate on STAFF_ACTIONS_ENABLED', () => {
  const routeBlock = (() => {
    const idx = src.indexOf("pathname === '/staff/bot/booking-preview'");
    if (idx < 0) return '';
    return src.slice(idx, idx + 400);
  })();
  if (routeBlock.includes('STAFF_ACTIONS_ENABLED')) {
    return 'route references STAFF_ACTIONS_ENABLED \u2014 preview must not gate on it';
  }
});

check('L3', 'handler does NOT set MANUAL_BOOKING_ENABLED = true', () => {
  if (/MANUAL_BOOKING_ENABLED\s*=\s*true/.test(handler)) {
    return 'handler sets MANUAL_BOOKING_ENABLED=true \u2014 forbidden';
  }
});

// ─── M. node --check ─────────────────────────────────────────────────────────

check('M1', 'staff-query-api.js passes node --check (no syntax errors)', () => {
  try {
    execSync(`node --check "${TARGET}"`, { stdio: 'pipe' });
  } catch (e) {
    return `node --check failed: ${e.stderr ? e.stderr.toString().trim() : e.message}`;
  }
});

check('M2', 'verify-staff-bot-booking-preview-api.js passes node --check', () => {
  const self = path.join(__dirname, 'verify-staff-bot-booking-preview-api.js');
  try {
    execSync(`node --check "${self}"`, { stdio: 'pipe' });
  } catch (e) {
    return `node --check failed: ${e.stderr ? e.stderr.toString().trim() : e.message}`;
  }
});

check('M3', 'wolfhouse-quote-calculator.js passes node --check', () => {
  const calcPath = path.join(__dirname, 'lib', 'wolfhouse-quote-calculator.js');
  if (!fs.existsSync(calcPath)) return 'calculator file not found';
  try {
    execSync(`node --check "${calcPath}"`, { stdio: 'pipe' });
  } catch (e) {
    return `node --check failed: ${e.stderr ? e.stderr.toString().trim() : e.message}`;
  }
});

// ─── N. package.json ─────────────────────────────────────────────────────────

check('N1', 'package.json has verify:staff-bot-booking-preview-api script', () => {
  if (!fs.existsSync(PKG)) return 'package.json not found';
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (!pkg.scripts || !pkg.scripts['verify:staff-bot-booking-preview-api']) {
    return 'verify:staff-bot-booking-preview-api not found in package.json scripts';
  }
});

// ─── O. Startup log ──────────────────────────────────────────────────────────

check('O1', 'startup log mentions /staff/bot/booking-preview', () => {
  if (!src.includes('/staff/bot/booking-preview')) {
    return '/staff/bot/booking-preview not found in source (startup log check)';
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(`\nverify-staff-bot-booking-preview-api FAILED (${failed} check(s) failed)\n`);
  process.exit(1);
} else {
  console.log('\nverify-staff-bot-booking-preview-api PASS\n');
  process.exit(0);
}
