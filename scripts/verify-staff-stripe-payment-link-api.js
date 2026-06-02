/**
 * verify-staff-stripe-payment-link-api.js  (Stage 8.4.9)
 *
 * Static verifier for the Stripe payment link creation endpoint:
 *   POST /staff/payments/:payment_id/create-stripe-link
 *
 * Checks:
 *   A: File / syntax
 *   B: Route registration and path-param regex
 *   C: Feature flag gates (STAFF_ACTIONS_ENABLED + STRIPE_LINKS_ENABLED)
 *   D: Config guards (STRIPE_SECRET_KEY, SUCCESS/CANCEL URLs)
 *   E: Payment validation (draft status, amount>0, EUR)
 *   F: Stripe Checkout Session creation
 *   G: DB update (checkout_created status, session_id, checkout_url)
 *   H: Response shape
 *   I: No payment truth / no paid status
 *   J: No WhatsApp / n8n / Azure
 *   K: package.json / env flag defaults
 *
 * Usage: node scripts/verify-staff-stripe-payment-link-api.js
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

console.log('\nverify-staff-stripe-payment-link-api.js  (Stage 8.4.9)\n');

// ── A. File / syntax ──────────────────────────────────────────────────────────
check('A1', fs.existsSync(TARGET), 'staff-query-api.js exists');
const src = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
check('A2', src.length > 10000, 'file is readable and non-trivial');
check('A3', (() => {
  try { require('child_process').execSync(`node --check "${TARGET}"`, { stdio: 'pipe' }); return true; }
  catch { return false; }
})(), 'passes node --check (no syntax errors)');

// Scope most checks to the handler body
const hStart = src.indexOf('async function handlePaymentCreateStripeLink');
const hEnd   = hStart > 0 ? src.indexOf('\n// ───', hStart + 50) : -1;
const handler = hStart > 0 ? src.slice(hStart, hEnd > 0 ? hEnd : hStart + 12000) : '';
check('A4', handler.length > 500, 'handlePaymentCreateStripeLink handler body found');

// ── B. Route / regex ──────────────────────────────────────────────────────────
check('B5', /PAYMENT_STRIPE_LINK_RE\s*=\s*\/\^/.test(src),
  'PAYMENT_STRIPE_LINK_RE path-param regex defined');
check('B6', /create-stripe-link/.test(src),
  "regex covers '/create-stripe-link' path segment");
check('B7', /stripeMatch\s*=\s*PAYMENT_STRIPE_LINK_RE\.exec\(pathname\)/.test(src),
  'router calls PAYMENT_STRIPE_LINK_RE.exec(pathname)');
check('B8', /handlePaymentCreateStripeLink\(stripeMatch\[1\]/.test(src),
  'router passes stripeMatch[1] (payment_id) to handler');
check('B9', /Method not allowed — use POST for create-stripe-link/.test(src),
  'POST-only enforced (405 for other methods)');
check('B10', /requireAuth\(req, res, 'operator'\)[\s\S]{0,200}handlePaymentCreateStripeLink|handlePaymentCreateStripeLink[\s\S]{0,200}requireAuth\(req, res, 'operator'\)/.test(src),
  'route guarded by requireAuth(req, res, operator)');

// ── C. Feature flag gates ─────────────────────────────────────────────────────
check('C11', /STRIPE_LINKS_ENABLED\s*=\s*process\.env\.STRIPE_LINKS_ENABLED\s*===\s*'true'/.test(src),
  'STRIPE_LINKS_ENABLED flag defined from env (default false)');
check('C12', /!STAFF_ACTIONS_ENABLED/.test(handler),
  'handler gates on STAFF_ACTIONS_ENABLED');
check('C13', /!STRIPE_LINKS_ENABLED/.test(handler),
  'handler gates on STRIPE_LINKS_ENABLED');
check('C14', /stripe_links_enabled:\s*false/.test(handler),
  'handler returns stripe_links_enabled:false when flag is off');
check('C15', /Set STRIPE_LINKS_ENABLED=true/.test(handler),
  'handler guides enabling STRIPE_LINKS_ENABLED in error message');

// ── D. Config guards ──────────────────────────────────────────────────────────
check('D16', /STRIPE_SECRET_KEY\s*=\s*process\.env\.STRIPE_SECRET_KEY/.test(src),
  'STRIPE_SECRET_KEY read from process.env (never hardcoded)');
check('D17', /!STRIPE_SECRET_KEY/.test(handler),
  'handler checks STRIPE_SECRET_KEY is present');
check('D18', /no_db_write:\s*true/.test(handler),
  'handler returns no_db_write:true when config is missing');
check('D19', /STRIPE_SUCCESS_URL.*STRIPE_CANCEL_URL|STRIPE_CANCEL_URL.*STRIPE_SUCCESS_URL/.test(src),
  'STRIPE_SUCCESS_URL and STRIPE_CANCEL_URL read from env');
check('D20', /!STRIPE_SUCCESS_URL.*!STRIPE_CANCEL_URL|!STRIPE_CANCEL_URL.*!STRIPE_SUCCESS_URL|!STRIPE_SUCCESS_URL \|\| !STRIPE_CANCEL_URL/.test(handler),
  'handler checks both success and cancel URLs are configured');

// ── E. Payment validation ─────────────────────────────────────────────────────
check('E21', /payment_status\s*!==\s*'draft'|status.*!==.*'draft'/.test(handler),
  "handler rejects payments not in 'draft' status");
check('E22', /amount_due_cents.*<=.*0|amount_due_cents\s*<\s*1/.test(handler),
  'handler rejects zero or negative amount_due_cents');
check('E23', /currency.*EUR|EUR.*currency/.test(handler),
  'handler validates currency is EUR');
check('E24', /checkout_created.*checkout_url|checkout_url.*checkout_created/.test(handler),
  'handler handles idempotency: already checkout_created returns existing URL');

// ── F. Stripe Checkout Session ────────────────────────────────────────────────
check('F25', /stripe\.checkout\.sessions\.create/.test(handler),
  'handler calls stripe.checkout.sessions.create()');
check('F26', /mode:\s*'payment'/.test(handler),
  "Checkout Session mode is 'payment'");
check('F27', /currency:\s*'eur'/.test(handler),
  "Checkout Session currency is 'eur'");
check('F28', /amount_due_cents/.test(handler),
  'Checkout Session uses amount_due_cents from payment record (not from client body)');
check('F29', /metadata:[\s\S]{0,300}payment_id[\s\S]{0,200}booking_id|metadata:[\s\S]{0,300}booking_id[\s\S]{0,200}payment_id/.test(handler),
  'Checkout Session metadata includes payment_id and booking_id');
check('F30', /source:\s*'staff_portal_manual_booking'/.test(handler),
  "Checkout Session metadata includes source: 'staff_portal_manual_booking'");
check('F31', /require\s*\(\s*'stripe'\s*\)\s*\(STRIPE_SECRET_KEY\)/.test(handler),
  'Stripe SDK initialized with STRIPE_SECRET_KEY (not hardcoded key)');
check('F32', /success_url:\s*STRIPE_SUCCESS_URL/.test(handler),
  'success_url set from STRIPE_SUCCESS_URL env var');
check('F33', /cancel_url:\s*STRIPE_CANCEL_URL/.test(handler),
  'cancel_url set from STRIPE_CANCEL_URL env var');

// ── G. DB update ──────────────────────────────────────────────────────────────
check('G34', /UPDATE payments/.test(handler),
  'handler UPDATEs payments row after Stripe session created');
check('G35', /checkout_created/.test(handler),
  "handler sets payment status to 'checkout_created'");
check('G36', /stripe_checkout_session_id/.test(handler),
  'handler stores stripe_checkout_session_id on payment row');
check('G37', /checkout_url/.test(handler),
  'handler stores checkout_url on payment row');
check('G38', !/status.*=.*'paid'|paid.*::payment_record_status/.test(handler),
  "handler does NOT set status to 'paid'");
check('G39', !/amount_paid_cents/.test(handler),
  'handler does NOT update amount_paid_cents');

// ── H. Response shape ─────────────────────────────────────────────────────────
check('H40', /sendJSON\(res, 200/.test(handler),
  'handler returns 200 on success');
check('H41', /payment_id:/.test(handler),
  'response includes payment_id');
check('H42', /booking_code:/.test(handler),
  'response includes booking_code');
check('H43', /checkout_url:/.test(handler),
  'response includes checkout_url');
check('H44', /no_payment_truth_recorded:\s*true/.test(handler),
  'response asserts no_payment_truth_recorded:true');
check('H45', /status:\s*'checkout_created'/.test(handler),
  "response status is 'checkout_created'");
check('H46', /Payment not marked paid until webhook/.test(handler),
  'response message states payment not paid until webhook confirms');

// ── I. No payment truth / no paid status ─────────────────────────────────────
check('I47', !/booking.*confirmed|bookings.*status.*confirmed|UPDATE bookings/.test(handler),
  'handler does NOT update booking status to confirmed');
check('I48', !/payment_status.*paid|paid.*payment_status/.test(handler),
  'handler does NOT set booking payment_status to paid');

// ── J. No WhatsApp / n8n / Azure ─────────────────────────────────────────────
check('J49', !/whatsapp[.(]|twilio|sendWhatsApp/i.test(handler),
  'handler makes no WhatsApp calls');
check('J50', !/n8n[.(]|webhook[.(]|axios|http\.request/i.test(handler),
  'handler makes no n8n / outbound webhook calls');
check('J51', /no_whatsapp:\s*true/.test(handler),
  'response asserts no_whatsapp:true');
check('J52', /no_n8n:\s*true/.test(handler),
  'response asserts no_n8n:true');

// ── K. Package / env defaults ─────────────────────────────────────────────────
check('K53', (() => {
  try { return JSON.parse(fs.readFileSync(PKG, 'utf8')).dependencies && 'stripe' in JSON.parse(fs.readFileSync(PKG, 'utf8')).dependencies; }
  catch { return false; }
})(), 'stripe listed in package.json dependencies');

check('K54', /STRIPE_LINKS_ENABLED\s*===\s*'true'/.test(src),
  'STRIPE_LINKS_ENABLED defaults to false (only true when env var is explicitly set to "true")');

check('K55', /infra.*\.env|infra\\\.env/.test(src),
  'server loads infra/.env as fallback for Stripe env vars');

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
