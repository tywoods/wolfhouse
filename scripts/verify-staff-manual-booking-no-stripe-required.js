/**
 * Staff manual booking create — Stripe links disabled must not block create.
 *
 * Usage:
 *   npm run verify:staff-manual-booking-no-stripe-required
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-manual-booking-no-stripe-required.js\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const applyFn = src.match(/async function manualBookingApplyStaffPaymentChoice[\s\S]*?\n\}/)?.[0] || '';
const hStart = src.indexOf('async function handleManualBookingCreate');
const hEnd   = src.indexOf('\n// ───', hStart + 50);
const handler = hStart > 0 ? src.slice(hStart, hEnd > 0 ? hEnd : hStart + 15000) : '';

const genStart = src.indexOf('async function handleBookingGeneratePaymentLink');
const genEnd = src.indexOf('// Phase 10.6a — Staff add service record', genStart);
const genHandler = genStart >= 0 && genEnd > genStart ? src.slice(genStart, genEnd) : '';

console.log('\nA. Package script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check(
  pkg.scripts && pkg.scripts['verify:staff-manual-booking-no-stripe-required'],
  'package.json has verify:staff-manual-booking-no-stripe-required script',
);

console.log('\nB. Manual create — skip Stripe when disabled');

check(/async function manualBookingApplyStaffPaymentChoice/.test(src),
  'manualBookingApplyStaffPaymentChoice exists');
check(/const stripeConfigured = STRIPE_LINKS_ENABLED/.test(applyFn),
  'apply computes stripeConfigured gate');
check(/if \(!stripeConfigured\)/.test(applyFn),
  'apply branches on stripeConfigured (no throw on disabled)');
check(!/throw err;\s*\n\s*\}\s*\n\s*const amountDueCents = manualBookingAmountDueForStaffChoice/.test(applyFn),
  'apply does not throw STRIPE_NOT_CONFIGURED before payment draft setup');
check(!/STRIPE_NOT_CONFIGURED/.test(applyFn),
  'apply does not throw STRIPE_NOT_CONFIGURED (manual create succeeds without Stripe)');
check(/payment_link_skipped = true/.test(applyFn),
  'apply sets payment_link_skipped when Stripe disabled');
check(/skip_reason = 'stripe_links_disabled'/.test(applyFn),
  'apply sets skip_reason stripe_links_disabled');
check(/return outcome;/.test(applyFn.slice(applyFn.indexOf('payment_link_skipped'))),
  'apply returns outcome after skip (no throw)');

console.log('\nC. No Stripe API on skip path');

const skipBlock = applyFn.slice(
  applyFn.indexOf('if (!stripeConfigured)'),
  applyFn.indexOf('const existRes = await pg.query'),
);
check(!/require\('stripe'\)/.test(skipBlock),
  'skip path does not load Stripe SDK');
check(!/stripe\.checkout\.sessions\.create/.test(skipBlock),
  'skip path does not call Stripe checkout');
check(/amount_due_cents = amountDueCents/.test(skipBlock),
  'skip path preserves amount_due_cents on draft payment');
check(!/checkout_url/.test(skipBlock),
  'skip path does not require checkout_url');

console.log('\nD. Success response surfaces skip warning');

check(/payment_link_skipped:/.test(handler),
  'handler success response includes payment_link_skipped');
check(/skip_reason:/.test(handler),
  'handler success response includes skip_reason');
check(/sendJSON\(res, 201/.test(handler),
  'handler still returns 201 on success');

console.log('\nE. Explicit generate-payment-link route still gated');

check(/async function handleBookingGeneratePaymentLink/.test(genHandler),
  'generate-payment-link handler exists');
check(/!STRIPE_LINKS_ENABLED/.test(genHandler),
  'generate-payment-link still gates on STRIPE_LINKS_ENABLED');
check(/stripe\.checkout\.sessions\.create/.test(genHandler),
  'generate-payment-link still creates Stripe session when enabled');

console.log('\nF. Safety — no WhatsApp / n8n / Meta');

check(!/graph\.facebook\.com/.test(applyFn + handler),
  'no WhatsApp Graph API in manual create path');
check(!/n8n\.cloud|activate.*workflow/i.test(applyFn + handler),
  'no n8n in manual create path');
check(/stripe_called:\s*false/.test(applyFn.slice(0, applyFn.indexOf('stripeConfigured'))),
  'outcome defaults stripe_called false');
check(!/stripe_called = true/.test(skipBlock),
  'skip path does not set stripe_called true');

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
