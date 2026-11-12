'use strict';
// Offline regression of the reported meal + yoga + two-guest deposit scenario.
// Real resolver and HTTP handler; only PG rows/HTTP transport are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const short = require('./lib/luna-payment-short-link');
const api = fs.readFileSync(`${__dirname}/staff-query-api.js`, 'utf8');
const booking = { booking_id: 'booking', client_id: 'client', booking_code: 'WH-OFFLINE-ADDONS',
  booking_status: 'confirmed', payment_status: 'unpaid', balance_due_cents: 80000 };
const env = { PUBLIC_PAYMENT_BASE_URL: 'https://offline.invalid' };
const row = (n, kind, guest, amount) => ({
  payment_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  payment_kind: kind, payment_status: 'checkout_created', amount_due_cents: amount,
  amount_paid_cents: 0, booking_id: booking.booking_id, client_id: booking.client_id,
  booking_guest_id: `guest-${guest}`, authoritative_guest_number: guest,
  checkout_url: `https://checkout.stripe.com/c/pay/cs_test_${n}`, metadata: {},
});
const clara = row(1, 'deposit_only', 1, 20000);
const tom = row(2, 'deposit_only', 2, 20000);
const meal = row(3, 'addon_service', 2, 2500);
const yoga = row(4, 'addon_service', 2, 1500);
let payments = [yoga, meal, tom, clara]; // newest first, as returned by SQL
const pg = { query: async (sql, params) => {
  assert.deepEqual(Array.from(params), ['wolfhouse-somo', booking.booking_code]);
  if (sql === short.PAYMENT_SHORT_LINK_LOOKUP_SQL) return { rows: [booking] };
  assert.equal(sql, short.PAYMENT_SHORT_LINK_PAYMENTS_SQL);
  return { rows: payments };
} };
const sandbox = { process: { env }, buildPaymentLinkObservability: short.buildPaymentLinkObservability,
  parsePaymentShortLinkToken: short.parsePaymentShortLinkToken,
  resolvePaymentShortLinkRedirectFromDb: short.resolvePaymentShortLinkRedirectFromDb,
  withPgClient: fn => fn(pg), sendGuestPaymentLinkStatus: (res, status, data) => { res.status = status; res.data = data; } };
vm.createContext(sandbox);
vm.runInContext(api.slice(api.indexOf('function guestPaymentLinkObservability('),
  api.indexOf('// Stage 8.4.11 — Stripe webhook payment truth.')), sandbox);
vm.runInContext(api.slice(api.indexOf('async function handleGuestPaymentShortLinkRedirect('),
  api.indexOf('// Route: GET /staff/intents')), sandbox);
async function visit(url) {
  const u = new URL(url);
  const match = /^\/pay\/([^/]+)(?:\/g(\d+))?$/.exec(u.pathname);
  assert.ok(match);
  const res = { writeHead(status, headers) { this.status = status; this.location = headers.Location; }, end() {} };
  await sandbox.handleGuestPaymentShortLinkRedirect(match[1], match[2], Object.fromEntries(u.searchParams), {}, res);
  return res;
}
async function main() {
  for (const guest of [clara, tom]) {
    const res = await visit(`${env.PUBLIC_PAYMENT_BASE_URL}/pay/${booking.booking_code}/g${guest.authoritative_guest_number}`);
    assert.equal(res.status, 302);
    assert.equal(res.location, guest.checkout_url, 'add-on must not replace guest deposit');
  }
  const balance = row(5, 'full_amount', 2, 30000);
  tom.payment_status = 'paid'; tom.amount_paid_cents = 20000;
  payments = [yoga, meal, balance, tom, clara];
  assert.equal((await visit(`${env.PUBLIC_PAYMENT_BASE_URL}/pay/${booking.booking_code}/g2`)).location,
    balance.checkout_url, 'paid deposit proceeds to guest balance, never an add-on');
  assert.equal((await visit(`${env.PUBLIC_PAYMENT_BASE_URL}/pay/${booking.booking_code}`)).location,
    balance.checkout_url, 'booking-level stay link excludes add-ons too');
  assert.match(short.PAYMENT_SHORT_LINK_PAYMENTS_SQL, /p\.payment_kind/, 'DB projects payment kind for routing');
  const ctx = { booking, clientSlug: 'wolfhouse-somo' };
  const links = [];
  for (const addon of [meal, yoga]) {
    const receipt = { payment_id: addon.payment_id };
    sandbox.applyBotAddonPaymentLinkFields(receipt, ctx, addon.checkout_url, `cs_test_${addon.payment_id}`);
    const expected = `${env.PUBLIC_PAYMENT_BASE_URL}/pay/${booking.booking_code}?payment_id=${addon.payment_id}`;
    assert.equal(receipt.guest_payment_url, expected, 'saved add-on receipt must carry its own payment ID');
    assert.equal(receipt.payment_short_url, expected);
    assert.equal((await visit(receipt.guest_payment_url)).location, addon.checkout_url,
      'each add-on URL must reach its own checkout, not the newest one');
    // The same link owner formats both new and idempotently recovered receipts/reply drafts.
    const replay = sandbox.botAddonPaymentLinkObservability(ctx, addon.checkout_url, null, addon.payment_id);
    assert.equal(replay.guest_payment_url, expected);
    links.push(receipt.guest_payment_url);
  }
  assert.notEqual(links[0], links[1]);
  meal.payment_status = 'paid'; meal.amount_paid_cents = meal.amount_due_cents;
  assert.equal((await visit(links[0])).data.status, 'paid', 'paid meal must not fall through to yoga');
  yoga.payment_status = 'expired';
  assert.equal((await visit(links[1])).status, 404, 'expired yoga must not fall through to another payment');
  assert.equal((await visit(`${env.PUBLIC_PAYMENT_BASE_URL}/pay/${booking.booking_code}?payment_id=00000000-0000-4000-8000-000000000099`)).status,
    404, 'unmatched payment ID must not select another checkout');
  console.log('PASS: Clara/Tom deposit and balance isolation; distinct meal/yoga links; replay; paid/expired links never retarget');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
