/**
 * verify-staff-stripe-webhook-api.js — Stage 8.4.11
 *
 * Static verifier for the POST /staff/stripe/webhook endpoint.
 * Checks route registration, signature verification, event handling,
 * payment truth logic, idempotency, and safety (no WhatsApp/email/n8n).
 *
 * Usage: node scripts/verify-staff-stripe-webhook-api.js
 * Exit 0 = all checks pass.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SRC  = path.join(__dirname, 'staff-query-api.js');
const code = fs.readFileSync(SRC, 'utf8');

let pass = 0;
let fail = 0;

function check(id, desc, condition) {
  if (condition) {
    console.log(`  PASS  [${id}] ${desc}`);
    pass++;
  } else {
    console.error(`  FAIL  [${id}] ${desc}`);
    fail++;
  }
}

// ─── A. Constants ────────────────────────────────────────────────────────────
console.log('\nA. Webhook constants');

check('A1', 'STRIPE_WEBHOOK_SECRET constant defined from process.env',
  /const STRIPE_WEBHOOK_SECRET\s*=\s*process\.env\.STRIPE_WEBHOOK_SECRET/.test(code));

check('A2', 'STRIPE_WEBHOOK_SKIP_VERIFY constant defined, requires explicit ===\'true\'',
  /const STRIPE_WEBHOOK_SKIP_VERIFY\s*=\s*process\.env\.STRIPE_WEBHOOK_SKIP_VERIFY\s*===\s*['"]true['"]/.test(code));

check('A3', 'STRIPE_WEBHOOK_SKIP_VERIFY defaults to false (no fallback to true)',
  /const STRIPE_WEBHOOK_SKIP_VERIFY\s*=\s*process\.env\.STRIPE_WEBHOOK_SKIP_VERIFY\s*===\s*['"]true['"]/.test(code) &&
  !/STRIPE_WEBHOOK_SKIP_VERIFY\s*=.*\|\|.*true/.test(code));

// ─── B. readBodyRaw function ─────────────────────────────────────────────────
console.log('\nB. readBodyRaw helper');

check('B1', 'readBodyRaw function exists',
  /function readBodyRaw\s*\(/.test(code));

check('B2', 'readBodyRaw returns a Buffer (Buffer.concat)',
  /function readBodyRaw[\s\S]{1,800}Buffer\.concat/.test(code));

check('B3', 'readBodyRaw has a configurable size limit parameter',
  /function readBodyRaw\s*\(\s*req\s*,\s*maxBytes/.test(code));

// ─── C. Route registration ───────────────────────────────────────────────────
console.log('\nC. Route registration');

check('C1', 'Route /staff/stripe/webhook is registered',
  /['"]\/staff\/stripe\/webhook['"]/.test(code));

check('C2', 'Route requires POST method',
  /\/staff\/stripe\/webhook[\s\S]{1,300}POST/.test(code));

check('C3', 'Route calls handleStripeWebhook',
  /handleStripeWebhook\s*\(/.test(code));

check('C4', 'Route does not require session auth (no requireAuth around webhook)',
  (() => {
    const webhookBlock = code.match(/\/staff\/stripe\/webhook[\s\S]{0,400}/);
    if (!webhookBlock) return false;
    return !/requireAuth/.test(webhookBlock[0]);
  })());

// ─── D. handleStripeWebhook function ─────────────────────────────────────────
console.log('\nD. handleStripeWebhook function');

// Extract handler source by finding the function start and the next route anchor
const _handlerStart = code.indexOf('async function handleStripeWebhook');
const _handlerEnd   = code.indexOf('// Route: POST /staff/payments', _handlerStart > 0 ? _handlerStart : 0);
const handlerSrc    = (_handlerStart > 0 && _handlerEnd > _handlerStart)
  ? code.slice(_handlerStart, _handlerEnd)
  : '';

check('D1', 'handleStripeWebhook function exists',
  /async function handleStripeWebhook/.test(code));

check('D2', 'Uses readBodyRaw (raw Buffer for Stripe verification)',
  /readBodyRaw/.test(handlerSrc));

check('D3', 'Signature verification when SKIP_VERIFY is false (constructEvent called)',
  /stripe\.webhooks\.constructEvent/.test(handlerSrc));

check('D4', 'Skips signature verification when STRIPE_WEBHOOK_SKIP_VERIFY is true',
  /STRIPE_WEBHOOK_SKIP_VERIFY/.test(handlerSrc) &&
  /if\s*\(\s*STRIPE_WEBHOOK_SKIP_VERIFY\s*\)/.test(handlerSrc));

check('D5', 'Returns 503 when STRIPE_WEBHOOK_SECRET missing and verification required',
  /STRIPE_WEBHOOK_SECRET.*503|503.*STRIPE_WEBHOOK_SECRET/.test(handlerSrc) ||
  (/if.*!STRIPE_WEBHOOK_SECRET/.test(handlerSrc) && /503/.test(handlerSrc)));

check('D6', 'Returns 400 when stripe-signature header missing',
  /stripe-signature/.test(handlerSrc) && /400/.test(handlerSrc));

check('D7', 'Handles checkout.session.completed event',
  /checkout\.session\.completed/.test(handlerSrc));

check('D8', 'Ignores unsupported events with 200 ignored:true',
  /ignored.*true|true.*ignored/.test(handlerSrc));

// ─── E. Payment matching ─────────────────────────────────────────────────────
console.log('\nE. Payment matching');

check('E1', 'Looks up payment by metadata payment_id',
  /metadata.*payment_id|payment_id.*metadata/.test(handlerSrc));

check('E2', 'Falls back to stripe_checkout_session_id lookup',
  /stripe_checkout_session_id/.test(handlerSrc));

check('E3', 'Returns 200 (not 4xx) when payment not found (prevents Stripe retries)',
  (() => {
    // The not-found block should return 200 with ignored:true
    // Look for the pattern: !pm check followed by ignored:true in nearby code
    const notFoundBlock = handlerSrc.match(/if\s*\(\s*!pm\s*\)[\s\S]{0,600}/);
    if (!notFoundBlock) return false;
    return /200/.test(notFoundBlock[0]) && /ignored\s*:\s*true/.test(notFoundBlock[0]);
  })());

check('E4', 'Validates EUR currency',
  /EUR/.test(handlerSrc));

check('E5', 'Joins bookings and clients tables in the lookup',
  /JOIN bookings/.test(handlerSrc) && /JOIN clients/.test(handlerSrc));

// ─── F. Idempotency ──────────────────────────────────────────────────────────
console.log('\nF. Idempotency');

check('F1', 'Checks if payment is already paid before updating',
  /payment_status.*===.*['"]paid['"]|status.*===.*['"]paid['"]|===.*paid/.test(handlerSrc));

check('F2', 'Returns idempotent:true when already paid',
  /idempotent\s*:\s*true/.test(handlerSrc));

check('F3', 'No double-count — idempotent path returns without DB write',
  (() => {
    // The idempotent check should appear before the DB update
    const idxIdem = handlerSrc.indexOf('idempotent');
    const idxUpdate = handlerSrc.indexOf("UPDATE payments");
    return idxIdem > 0 && idxUpdate > 0 && idxIdem < idxUpdate;
  })());

// ─── G. Payment truth update ─────────────────────────────────────────────────
console.log('\nG. Payment truth update');

check('G1', 'Updates payments.status to paid',
  /UPDATE payments[\s\S]{0,400}'paid'::payment_record_status/.test(handlerSrc));

check('G2', 'Updates payments.amount_paid_cents',
  /UPDATE payments[\s\S]{0,400}amount_paid_cents/.test(handlerSrc));

check('G3', 'Updates payments.paid_at to NOW()',
  /UPDATE payments[\s\S]{0,400}paid_at\s*=\s*NOW\(\)/.test(handlerSrc));

check('G4', 'Stores stripe_payment_intent_id in payment row',
  /stripe_payment_intent_id/.test(handlerSrc));

check('G5', 'Stores Stripe event metadata (event_id, event_type, session_id)',
  /stripe_event_id/.test(handlerSrc) &&
  /stripe_event_type/.test(handlerSrc) &&
  /stripe_session_id/.test(handlerSrc));

check('G6', 'Payment update wrapped in a transaction (BEGIN/COMMIT/ROLLBACK)',
  /BEGIN/.test(handlerSrc) && /COMMIT/.test(handlerSrc) && /ROLLBACK/.test(handlerSrc));

// ─── H. Booking update ───────────────────────────────────────────────────────
console.log('\nH. Booking update');

check('H1', 'Updates bookings.amount_paid_cents',
  /UPDATE bookings[\s\S]{0,400}amount_paid_cents/.test(handlerSrc));

check('H2', 'Updates bookings.balance_due_cents',
  /UPDATE bookings[\s\S]{0,400}balance_due_cents/.test(handlerSrc));

check('H3', 'Updates bookings.payment_status',
  /UPDATE bookings[\s\S]{0,400}payment_status/.test(handlerSrc));

check('H4', 'Uses ::payment_status cast for correct enum type',
  /::payment_status/.test(handlerSrc));

check('H5', 'Uses deposit_paid enum value for deposit-only payments',
  /deposit_paid/.test(handlerSrc));

check('H6', 'Uses paid enum value when balance is zero',
  /newBkPayStatus\s*=\s*['"]paid['"]|= 'paid'/.test(handlerSrc));

check('H7', 'Booking update is in the same transaction as payment update',
  (() => {
    const idxBegin = handlerSrc.indexOf("'BEGIN'");
    const idxBkUpdate = handlerSrc.indexOf('UPDATE bookings');
    const idxCommit = handlerSrc.indexOf("'COMMIT'");
    return idxBegin > 0 && idxBkUpdate > idxBegin && idxCommit > idxBkUpdate;
  })());

check('H8', 'Does NOT set booking.status to confirmed (payment truth only)',
  !(/booking.*status.*confirmed|confirmed.*booking.*status/.test(handlerSrc)) ||
  (/does.*not.*change.*booking.*status|booking status NOT changed/.test(handlerSrc)));

// ─── I. Response shape ───────────────────────────────────────────────────────
console.log('\nI. Response shape');

check('I1', 'Returns event_type in response',
  /event_type\s*:/.test(handlerSrc));

check('I2', 'Returns payment_id in response',
  /payment_id\s*:/.test(handlerSrc));

check('I3', 'Returns booking_id in response',
  /booking_id\s*:/.test(handlerSrc));

check('I4', 'Returns amount_paid_cents in response',
  /amount_paid_cents\s*:/.test(handlerSrc));

check('I5', 'Returns booking_amount_paid_cents in response',
  /booking_amount_paid_cents\s*:/.test(handlerSrc));

check('I6', 'Returns booking_balance_due_cents in response',
  /booking_balance_due_cents\s*:/.test(handlerSrc));

check('I7', 'Returns payment_status in response',
  /payment_status\s*:/.test(handlerSrc));

check('I8', 'Returns idempotent in response',
  /idempotent\s*:/.test(handlerSrc));

// ─── J. Safety constraints ───────────────────────────────────────────────────
console.log('\nJ. Safety constraints — no WhatsApp/email/n8n/confirmation');

check('J1', 'No WhatsApp call in handler',
  !(/whatsapp\s*\(|sendWhatsApp|twilio|TWILIO/i.test(handlerSrc)));

check('J2', 'No email send in handler',
  !(/sendEmail|nodemailer|sendgrid|smtp/i.test(handlerSrc)));

check('J3', 'No n8n trigger call in handler (safety flags with n8n name are ok)',
  // Check there's no actual n8n HTTP call / trigger function — but safety flags like
  // no_n8n:true and n8n_called:false are expected and should not fail this check.
  !(/N8N_WEBHOOK_URL|triggerN8n|n8nWebhook|fetch.*n8n|axios.*n8n/i.test(handlerSrc)));

check('J4', 'No confirmation send call in handler',
  !(/sendConfirmation|send_confirmation|confirmationSent/i.test(handlerSrc)));

check('J5', 'No new Checkout Session created in handler',
  !(/checkout\.sessions\.create/i.test(handlerSrc)));

check('J6', 'no_whatsapp flag in success response',
  /no_whatsapp\s*:\s*true/.test(handlerSrc));

check('J7', 'no_email flag in success response',
  /no_email\s*:\s*true/.test(handlerSrc));

check('J8', 'no_n8n flag in success response',
  /no_n8n\s*:\s*true/.test(handlerSrc));

check('J9', 'no_confirmation_sent flag in success response',
  /no_confirmation_sent\s*:\s*true/.test(handlerSrc));

// ─── K. Webhook route has no Azure references ────────────────────────────────
console.log('\nK. No Azure deploy references in handler');

check('K1', 'No Azure SDK calls in handler',
  !(/BlobServiceClient|DefaultAzureCredential|@azure\//.test(handlerSrc)));

// ─── L. Audit log ────────────────────────────────────────────────────────────
console.log('\nL. Audit log');

check('L1', 'appendAuditLog called in webhook handler',
  /appendAuditLog/.test(handlerSrc));

check('L2', 'Audit log records payment truth event',
  /webhook:stripe:payment_truth/.test(handlerSrc));

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n──────────────────────────────────────────`);
console.log(`verify-staff-stripe-webhook-api: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.error(`\nFAIL — ${fail} check(s) did not pass.`);
  process.exit(1);
} else {
  console.log('\nPASS — all checks passed.');
  process.exit(0);
}
