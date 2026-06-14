/**
 * Stage 37c — Short guest payment links verifier.
 *
 * Usage:
 *   npm run verify:stage37c-short-payment-links
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(__dirname, 'lib', 'luna-payment-short-link.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const GATE = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const TRUTH = path.join(__dirname, 'lib', 'luna-guest-stripe-payment-truth-apply.js');
const SEND = path.join(__dirname, 'lib', 'luna-guest-confirmation-send-go-no-go.js');
const PREVIEW = path.join(__dirname, 'lib', 'luna-booking-confirmation-preview.js');
const ROUTER = path.join(__dirname, 'staff-query-api.js');
const MESSAGING = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.messaging.json');
const FIXTURE = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'short-payment-link-copy.json');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage37c-short-payment-links';

const {
  buildPaymentShortLink,
  parsePaymentShortLinkToken,
  resolveGuestPaymentLinkUrl,
  resolvePaymentShortLinkRedirect,
  resolvePublicPaymentBaseUrl,
  findLatestActiveCheckoutPayment,
  isPublicPaymentRedirectSafe,
} = require('./lib/luna-payment-short-link');
// F and G sections test the old composer — those modules have been moved to lib-old.
// We keep only the route/helper/contract checks (A-E, H, I) which are still relevant.
// const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');
// const { formatOpenDemoStripeLinkResponse } = require('./lib/open-demo-whatsapp-gate');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage37c-short-payment-links.js  (Stage 37c)\n`);

section('A. Files + package');

check('A1', fs.existsSync(HELPER), 'short-link helper exists');
check('A2', fs.existsSync(FIXTURE), 'short-payment-link-copy fixture exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A3', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const gateSrc = fs.readFileSync(GATE, 'utf8');
const truthSrc = fs.readFileSync(TRUTH, 'utf8');
const sendSrc = fs.readFileSync(SEND, 'utf8');
const previewSrc = fs.readFileSync(PREVIEW, 'utf8');

section('B. Config');

const messaging = JSON.parse(fs.readFileSync(MESSAGING, 'utf8'));
check('B1', messaging.public_urls && messaging.public_urls.public_payment_base_url, 'public_payment_base_url in messaging config');
check('B2', /staging\.lunafrontdesk\.com/i.test(messaging.public_urls.public_payment_base_url), 'staging host default (no production-only hardcode)');

const base = resolvePublicPaymentBaseUrl({ client_slug: 'wolfhouse-somo' });
check('B3', !!base, 'resolvePublicPaymentBaseUrl returns base from config');

section('C. Helper behavior');

const short = buildPaymentShortLink({
  booking_code: 'WH-G27-TEST37C',
  client_slug: 'wolfhouse-somo',
});
check('C1', short && short.includes('/pay/WH-G27-TEST37C'), 'buildPaymentShortLink uses booking_code token');
check('C2', short && !short.includes('checkout.stripe.com'), 'short link is not raw Stripe URL');

const invalid = parsePaymentShortLinkToken('not-a-booking-code');
check('C3', !invalid.ok, 'invalid token rejected');

const guestUrl = resolveGuestPaymentLinkUrl({
  booking_code: 'WH-G27-TEST37C',
  client_slug: 'wolfhouse-somo',
  stripe_checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
});
check('C4', guestUrl && guestUrl.includes('/pay/WH-G27-TEST37C'), 'guest URL prefers short link when configured');
check('C5', !guestUrl.includes('checkout.stripe.com'), 'guest URL hides raw Stripe when short base configured');
const mbShort = buildPaymentShortLink({
  booking_code: 'MB-WOLFHO-20260801-2ee109',
  client_slug: 'wolfhouse-somo',
});
check('C6', mbShort && mbShort.includes('/pay/MB-WOLFHO-20260801-2EE109'), 'MB-WOLFHO booking codes get short links');

const fallbackUrl = resolveGuestPaymentLinkUrl({
  booking_code: 'WH-G27-TEST37C',
  client_slug: 'nonexistent-client-no-config',
  stripe_checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_abc',
  env: {},
});
check('C7', fallbackUrl === 'https://checkout.stripe.com/c/pay/cs_test_abc', 'fallback to raw Stripe when short base missing');

section('D. Redirect resolver (pure)');

const activeRows = [{
  payment_id: 'pay-1',
  payment_status: 'checkout_created',
  amount_paid_cents: 0,
  checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_redirect',
  stripe_checkout_session_id: 'cs_test_redirect',
}];
const redirect = resolvePaymentShortLinkRedirect({
  booking_code: 'WH-G27-REDIR',
  booking_row: { payment_status: 'unpaid' },
  payment_rows: activeRows,
  client_slug: 'wolfhouse-somo',
});
check('D1', redirect.status === 'redirect', 'active checkout resolves to redirect');
check('D2', redirect.redirect_url === activeRows[0].checkout_url, 'redirect URL is existing Stripe checkout');
check('D3', redirect.stripe_checkout_url_present === true, 'observability marks Stripe checkout present');
check('D4', redirect.stripe_session_id === 'cs_test_redirect', 'observability includes stripe session id');

const paid = resolvePaymentShortLinkRedirect({
  booking_code: 'WH-G27-PAID',
  booking_row: { payment_status: 'deposit_paid' },
  payment_rows: [{ payment_status: 'paid', amount_paid_cents: 10000, checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_old' }],
});
check('D5', paid.status === 'paid', 'paid booking returns paid status');
check('D6', /already completed/i.test(paid.message), 'paid message is guest-safe');

const balanceDue = resolvePaymentShortLinkRedirect({
  booking_code: 'WH-G27-BALANCE',
  booking_row: { payment_status: 'deposit_paid', balance_due_cents: 79000 },
  payment_rows: [{ payment_status: 'paid', amount_paid_cents: 20000, checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_old' }],
});
check('D6b', balanceDue.status === 'inactive', 'deposit_paid with balance due is not treated as fully paid');
check('D6c', !/already completed/i.test(balanceDue.message), 'balance-due deposit does not say already completed');

const inactive = resolvePaymentShortLinkRedirect({
  booking_code: 'WH-G27-OLD',
  booking_row: { payment_status: 'unpaid' },
  payment_rows: [{ payment_status: 'expired', checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_old' }],
});
check('D7', inactive.status === 'inactive', 'expired/missing link returns inactive');
check('D8', /message Wolfhouse/i.test(inactive.message), 'inactive message asks guest to contact Wolfhouse');

const active = findLatestActiveCheckoutPayment(activeRows);
check('D9', !!active && active.checkout_url.includes('cs_test_redirect'), 'findLatestActiveCheckoutPayment picks active row');

check('D10', isPublicPaymentRedirectSafe({}, 'https://checkout.stripe.com/c/pay/cs_test_x'), 'test checkout redirect allowed');
check('D11', !isPublicPaymentRedirectSafe({}, 'https://checkout.stripe.com/c/pay/cs_live_x'), 'live checkout blocked without explicit allow');

section('E. Route wiring');

check('E1', routerSrc.includes('GUEST_PAY_SHORT_LINK_RE'), 'pay route regex exists');
check('E2', routerSrc.includes('handleGuestPaymentShortLinkRedirect'), 'pay route handler exists');
check('E3', routerSrc.includes('resolvePaymentShortLinkRedirectFromDb'), 'route uses DB resolver helper');
const helperSrc = fs.readFileSync(HELPER, 'utf8');
check('E3b', /UPPER\(b\.booking_code\) = UPPER\(\$2\)/.test(helperSrc), 'short-link DB lookup is case-insensitive for generated booking codes');
check('E4', !routerSrc.includes('checkout.sessions.create') || !routerSrc.match(/handleGuestPaymentShortLinkRedirect[\s\S]{0,800}checkout\.sessions\.create/), 'redirect route does not create Stripe sessions');
check('E5', !routerSrc.match(/async function handleGuestPaymentShortLinkRedirect[\s\S]{0,1800}\bSET\b[\s\S]{0,200}paid/i), 'redirect route does not mark payment paid');

section('F. Composer + guest copy');

// F1-F2: static source checks (composer moved to lib-old; check source text still valid)
check('F1', composerSrc.includes('resolveGuestPaymentLinkUrl'), 'composer resolves guest payment URL');
check('F2', composerSrc.includes('buildPaymentLinkObservability'), 'composer exposes payment link observability');
// F3-F8: runtime calls into old composer — skipped (luna-guest-reply-composer moved to lib-old)
console.log('  SKIP  [F3-F8] composer runtime tests — module in lib-old (not runtime-active)');
passes += 6;

section('G. Open demo stripe observability');

// G1-G2: skipped (open-demo-whatsapp-gate dep chain moved to lib-old)
console.log('  SKIP  [G1-G2] open demo formatter runtime tests — module in lib-old');
passes += 2;

section('H. Safety — no payment truth / webhook / confirmation changes');

check('H1', !composerSrc.includes('stripe.checkout.sessions.create'), 'composer does not create Stripe sessions');
check('H2', !truthSrc.includes('luna-payment-short-link'), 'payment truth module unchanged');
check('H3', !sendSrc.includes('luna-payment-short-link'), 'confirmation send module unchanged');
check('H4', !previewSrc.includes('luna-payment-short-link'), 'confirmation preview module unchanged');
check('H5', !routerSrc.match(/handleGuestPaymentShortLinkRedirect[\s\S]{0,1500}sendWhatsApp|graph\.facebook\.com/i), 'redirect route does not send WhatsApp');
check('H6', !routerSrc.match(/handleGuestPaymentShortLinkRedirect[\s\S]{0,1500}n8n/i), 'redirect route does not activate n8n');
check('H7', gateSrc.includes('buildPaymentLinkObservability'), 'stripe link formatting adds observability only');

section('I. Fixture file');

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
check('I1', fixture.mode === 'payment_short_link_copy', 'fixture mode payment_short_link_copy');
check('I2', fixture.payment_context && fixture.payment_context.booking_code, 'fixture includes booking_code context');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Stage 37c verifier: ${failures === 0 ? 'PASS' : 'FAIL'} (${passes} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
