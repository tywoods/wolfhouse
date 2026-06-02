#!/usr/bin/env node
// verify-staff-bot-stripe-link-api.js
// Stage 8.5.5 — Static verifier for POST /staff/bot/payments/:payment_id/create-stripe-link
//
// Non-negotiables verified:
//   - Endpoint exists and routes to handleBotPaymentCreateStripeLink
//   - Uses requireBotAuth (bot-scoped, not bare requireAuth)
//   - BOT_BOOKING_ENABLED gate (not STAFF_ACTIONS_ENABLED)
//   - STRIPE_LINKS_ENABLED gate
//   - BOT_PAYMENT_STRIPE_LINK_RE regex defined
//   - Config guards: STRIPE_SECRET_KEY, SUCCESS/CANCEL URLs
//   - Payment validation: draft status, amount>0, EUR
//   - Stripe Checkout Session creation (same SDK path as Stage 8.4.9)
//   - DB UPDATE payments to checkout_created (same SQL pattern)
//   - Amount from payments.amount_due_cents — never from request body
//   - Returns checkout_url, sends_whatsapp:false, no_payment_truth_recorded:true
//   - Does not mark paid
//   - No WhatsApp / email / n8n calls
//   - No webhook changes
//   - Token auth scoped to bot route only
//   - node --check passes

'use strict';
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const TARGET = path.join(__dirname, 'staff-query-api.js');
const PKG    = path.join(__dirname, '..', 'package.json');

if (!fs.existsSync(TARGET)) {
  console.error('FATAL: staff-query-api.js not found at', TARGET);
  process.exit(1);
}
const src = fs.readFileSync(TARGET, 'utf8');

// Extract handleBotPaymentCreateStripeLink body
const handlerStart = src.indexOf('async function handleBotPaymentCreateStripeLink(');
const handlerEnd   = (() => {
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

// Router block for bot Stripe link route
const botStripeRouteIdx = src.indexOf("BOT_PAYMENT_STRIPE_LINK_RE.exec(pathname)");
const routeBlock = botStripeRouteIdx >= 0 ? src.slice(botStripeRouteIdx, botStripeRouteIdx + 600) : '';

// ─────────────────────────────────────────────────────────────────────────────
const results = [];
function check(id, label, fn) {
  try {
    const err = fn();
    if (err) results.push({ id, label, ok: false, err });
    else     results.push({ id, label, ok: true });
  } catch (e) {
    results.push({ id, label, ok: false, err: e.message });
  }
}

// ─── A. Endpoint exists ───────────────────────────────────────────────────────

check('A1', 'staff-query-api.js exists', () => {
  if (!fs.existsSync(TARGET)) return 'staff-query-api.js not found';
});

check('A2', 'BOT_PAYMENT_STRIPE_LINK_RE regex defined', () => {
  if (!src.includes('BOT_PAYMENT_STRIPE_LINK_RE')) return 'BOT_PAYMENT_STRIPE_LINK_RE not defined';
});

check('A3', 'BOT_PAYMENT_STRIPE_LINK_RE matches expected path pattern', () => {
  const match = src.match(/BOT_PAYMENT_STRIPE_LINK_RE\s*=\s*([^\n;]+)/);
  if (!match) return 'BOT_PAYMENT_STRIPE_LINK_RE definition not found';
  if (!match[1].includes('bot') || !match[1].includes('create-stripe-link')) {
    return 'BOT_PAYMENT_STRIPE_LINK_RE does not include bot/payments/create-stripe-link path';
  }
});

check('A4', 'handleBotPaymentCreateStripeLink function defined', () => {
  if (handlerStart < 0) return 'handleBotPaymentCreateStripeLink not found in source';
});

check('A5', 'router block dispatches to handleBotPaymentCreateStripeLink', () => {
  if (!routeBlock.includes('handleBotPaymentCreateStripeLink')) {
    return 'router block does not call handleBotPaymentCreateStripeLink';
  }
});

check('A6', 'route only accepts POST method', () => {
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
  if (fnSlice.includes('BOT_PAYMENT_STRIPE_LINK_RE') || fnSlice.includes('LUNA_BOT_INTERNAL_TOKEN')) {
    return 'requireAuth references bot token — normal auth must not be weakened';
  }
});

check('B4', 'handler accepts authMode parameter', () => {
  if (!handler.includes('authMode')) return 'authMode parameter not found in handler';
});

// ─── C. Feature flags ─────────────────────────────────────────────────────────

check('C1', 'handler gates on BOT_BOOKING_ENABLED (not STAFF_ACTIONS_ENABLED)', () => {
  if (!handler.includes('BOT_BOOKING_ENABLED')) return 'BOT_BOOKING_ENABLED check not in handler';
  if (handler.includes('STAFF_ACTIONS_ENABLED')) return 'STAFF_ACTIONS_ENABLED in handler — bot path must not require it';
});

check('C2', 'handler gates on STRIPE_LINKS_ENABLED', () => {
  if (!handler.includes('STRIPE_LINKS_ENABLED')) return 'STRIPE_LINKS_ENABLED not checked in handler';
});

check('C3', 'BOT_BOOKING_ENABLED false → 403', () => {
  if (!handler.includes('bot_booking_enabled: false')) {
    return 'no bot_booking_enabled: false 403 response found';
  }
});

check('C4', 'STRIPE_LINKS_ENABLED false → 403', () => {
  if (!handler.includes('stripe_links_enabled: false')) {
    return 'no stripe_links_enabled: false 403 response found';
  }
});

// ─── D. Config guards ─────────────────────────────────────────────────────────

check('D1', 'handler checks STRIPE_SECRET_KEY', () => {
  if (!handler.includes('STRIPE_SECRET_KEY')) return 'STRIPE_SECRET_KEY not checked in handler';
});

check('D2', 'handler checks STRIPE_SUCCESS_URL and STRIPE_CANCEL_URL', () => {
  if (!handler.includes('STRIPE_SUCCESS_URL') || !handler.includes('STRIPE_CANCEL_URL')) {
    return 'STRIPE_SUCCESS_URL/STRIPE_CANCEL_URL not checked in handler';
  }
});

check('D3', 'handler loads Stripe SDK lazily', () => {
  if (!handler.includes("require('stripe')")) return "require('stripe') not found in handler";
});

// ─── E. Payment validation ────────────────────────────────────────────────────

check('E1', 'handler fetches payment from DB (SELECT from payments)', () => {
  if (!handler.includes('SELECT') || !handler.includes('FROM payments')) {
    return 'DB SELECT from payments not found in handler';
  }
});

check('E2', 'handler validates payment status is draft', () => {
  if (!handler.includes("'draft'")) return "draft status check not found in handler";
});

check('E3', 'handler checks amount_due_cents > 0', () => {
  if (!handler.includes('amount_due_cents')) return 'amount_due_cents check not found';
  if (!handler.includes('amount_due_cents <= 0') && !handler.includes('amount_due_cents > 0')) {
    return 'amount_due_cents bounds check not found';
  }
});

check('E4', 'handler validates EUR currency', () => {
  if (!handler.includes("'EUR'") && !handler.includes('"EUR"')) return 'EUR currency check not found';
});

check('E5', 'amount from DB (amount_due_cents from payment row, not request body)', () => {
  // amount comes from pm.amount_due_cents, not from body
  if (!handler.includes('pm.amount_due_cents')) return 'pm.amount_due_cents not used as amount source';
  if (/body\.amount|req\.body\.amount/i.test(handler)) return 'amount read from request body — must use DB amount';
});

// ─── F. Stripe Checkout Session creation ─────────────────────────────────────

check('F1', 'handler calls stripe.checkout.sessions.create', () => {
  if (!handler.includes('stripe.checkout.sessions.create')) {
    return 'stripe.checkout.sessions.create not called in handler';
  }
});

check('F2', 'handler sets Stripe session mode to payment', () => {
  if (!handler.includes("mode:") || !handler.includes("'payment'")) {
    return "Stripe session mode: 'payment' not found";
  }
});

check('F3', 'handler uses pm.amount_due_cents as unit_amount (not body amount)', () => {
  if (!handler.includes('unit_amount:  pm.amount_due_cents') &&
      !handler.includes('unit_amount: pm.amount_due_cents')) {
    return 'unit_amount not set from pm.amount_due_cents';
  }
});

check('F4', 'Stripe metadata includes payment_id', () => {
  const stripeIdx = handler.indexOf('stripe.checkout.sessions.create');
  const stripeSlice = stripeIdx >= 0 ? handler.slice(stripeIdx, stripeIdx + 1500) : '';
  if (!stripeSlice.includes('payment_id')) return 'payment_id not in Stripe session metadata';
});

check('F5', 'Stripe metadata includes bot source (bot_stage855)', () => {
  if (!handler.includes('bot_stage855')) return "bot source 'bot_stage855' not in Stripe metadata";
});

// ─── G. DB update ─────────────────────────────────────────────────────────────

check('G1', 'handler UPDATE payments to checkout_created', () => {
  if (!handler.includes('UPDATE payments')) return 'UPDATE payments not found in handler';
  if (!handler.includes("'checkout_created'")) return "checkout_created status not set in UPDATE payments";
});

check('G2', 'handler stores stripe_checkout_session_id', () => {
  if (!handler.includes('stripe_checkout_session_id')) {
    return 'stripe_checkout_session_id not stored in DB update';
  }
});

check('G3', 'handler stores checkout_url', () => {
  if (!handler.includes('checkout_url')) return 'checkout_url not stored in DB update';
});

check('G4', 'handler stores expires_at from session', () => {
  if (!handler.includes('expires_at')) return 'expires_at not stored in DB update';
});

// ─── H. Response shape ────────────────────────────────────────────────────────

check('H1', 'response includes success: true', () => {
  if (!handler.includes('success:')) return 'success field missing from response';
});

check('H2', "response includes source: 'luna_whatsapp'", () => {
  if (!handler.includes("source:                     'luna_whatsapp'") &&
      !handler.includes("source: 'luna_whatsapp'") &&
      !handler.includes("source:                    'luna_whatsapp'")) {
    return "source: 'luna_whatsapp' not found in response";
  }
});

check('H3', 'response includes payment_id', () => {
  if (!handler.includes('payment_id:')) return 'payment_id missing from response';
});

check('H4', 'response includes booking_id and booking_code', () => {
  if (!handler.includes('booking_id:') || !handler.includes('booking_code:')) {
    return 'booking_id or booking_code missing from response';
  }
});

check('H5', 'response includes checkout_url', () => {
  if (!handler.includes('checkout_url:')) return 'checkout_url missing from response';
});

check('H6', 'response includes stripe_checkout_session_id', () => {
  if (!handler.includes('stripe_checkout_session_id:')) return 'stripe_checkout_session_id missing from response';
});

check('H7', "response includes payment_status: 'checkout_created'", () => {
  if (!handler.includes("payment_status:")) return "payment_status missing from response";
  if (!handler.includes("'checkout_created'")) return "payment_status 'checkout_created' not in response";
});

check('H8', "response includes next_action: 'draft_payment_link_reply'", () => {
  if (!handler.includes("next_action:")) return "next_action missing from response";
  if (!handler.includes("'draft_payment_link_reply'")) return "next_action 'draft_payment_link_reply' not found";
});

check('H9', 'response includes sends_whatsapp: false', () => {
  if (!handler.includes('sends_whatsapp:             false') &&
      !handler.includes('sends_whatsapp: false')) {
    return 'sends_whatsapp: false not found in response';
  }
});

check('H10', 'response includes whatsapp_dry_run: true', () => {
  if (!handler.includes('whatsapp_dry_run:           true') &&
      !handler.includes('whatsapp_dry_run: true')) {
    return 'whatsapp_dry_run: true not found in response';
  }
});

check('H11', 'response includes no_payment_truth_recorded: true', () => {
  if (!handler.includes('no_payment_truth_recorded:  true') &&
      !handler.includes('no_payment_truth_recorded: true')) {
    return 'no_payment_truth_recorded: true not found in response';
  }
});

check('H12', 'response includes auth_mode', () => {
  if (!handler.includes('auth_mode:')) return 'auth_mode missing from response';
});

// ─── I. No payment truth / no paid mark ──────────────────────────────────────

check('I1', 'handler does not set payment status to paid', () => {
  if (handler.includes("= 'paid'") || handler.includes("status='paid'")) {
    return "handler sets payment status to 'paid' — must not mark paid";
  }
});

check('I2', 'handler does not update booking paid amount', () => {
  if (/UPDATE bookings.*paid|amount_paid_cents/i.test(handler)) {
    return 'handler updates booking paid amount — must not mark paid';
  }
});

check('I3', 'handler does not trigger webhook', () => {
  if (/webhook.*trigger|trigger.*webhook/i.test(handler)) {
    return 'webhook trigger found in handler';
  }
});

// ─── J. No external side effects (except Stripe) ──────────────────────────────

check('J1', 'handler has no WhatsApp send calls', () => {
  if (/whatsapp.*send|sendWhatsApp|twilio.*messages/i.test(handler)) {
    return 'WhatsApp send call found in handler';
  }
});

check('J2', 'handler has no n8n webhook calls', () => {
  const stripped = handler.replace(/\/\/.*$/gm, '');
  if (/n8n\s*\.|triggerN8n|callN8n/i.test(stripped)) {
    return 'n8n call found in handler (non-comment)';
  }
});

check('J3', 'handler has no email send calls', () => {
  if (/sendEmail|nodemailer|smtp/i.test(handler)) return 'email send found in handler';
});

check('J4', 'handler has no Azure/infra calls', () => {
  if (/azure|bicep|terraform/i.test(handler)) return 'Azure/infra reference found in handler';
});

// ─── K. Scope ─────────────────────────────────────────────────────────────────

check('K1', 'token auth not applied to original /staff/payments/:id/create-stripe-link', () => {
  const idx = src.indexOf('PAYMENT_STRIPE_LINK_RE.exec(pathname)');
  const slice = idx >= 0 ? src.slice(idx, idx + 400) : '';
  if (slice.includes('requireBotAuth')) {
    return '/staff/payments/*/create-stripe-link uses requireBotAuth — must use requireAuth';
  }
});

check('K2', 'original Stripe link route still uses requireAuth (operator)', () => {
  const idx = src.indexOf('PAYMENT_STRIPE_LINK_RE.exec(pathname)');
  const slice = idx >= 0 ? src.slice(idx, idx + 400) : '';
  if (!slice.includes('requireAuth')) return 'requireAuth not found in original Stripe link route';
});

// ─── L. node --check ─────────────────────────────────────────────────────────

check('L1', 'staff-query-api.js passes node --check', () => {
  try {
    execSync(`node --check "${TARGET}"`, { stdio: 'pipe' });
  } catch (e) {
    return `node --check failed: ${e.stderr ? e.stderr.toString().trim() : e.message}`;
  }
});

check('L2', 'verify-staff-bot-stripe-link-api.js passes node --check', () => {
  const self = path.join(__dirname, 'verify-staff-bot-stripe-link-api.js');
  try {
    execSync(`node --check "${self}"`, { stdio: 'pipe' });
  } catch (e) {
    return `node --check failed: ${e.stderr ? e.stderr.toString().trim() : e.message}`;
  }
});

// ─── M. package.json ──────────────────────────────────────────────────────────

check('M1', 'package.json has verify:staff-bot-stripe-link-api script', () => {
  if (!fs.existsSync(PKG)) return 'package.json not found';
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (!pkg.scripts || !pkg.scripts['verify:staff-bot-stripe-link-api']) {
    return 'verify:staff-bot-stripe-link-api not found in package.json scripts';
  }
});

// ─── N. Startup log ───────────────────────────────────────────────────────────

check('N1', 'startup log mentions /staff/bot/payments/:id/create-stripe-link', () => {
  if (!src.includes('/staff/bot/payments/:id/create-stripe-link') &&
      !src.includes("bot/payments/")) {
    return 'bot Stripe link endpoint not mentioned in startup log';
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
  console.log('verify-staff-bot-stripe-link-api FAILED (' + failed + ' check(s) failed)\n');
  process.exit(1);
} else {
  console.log('verify-staff-bot-stripe-link-api PASS\n');
}
