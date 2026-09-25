'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const routes = require('./lib/staff-bot-v2-routes');
const portal = require('./lib/staff-portal-ui-source').readStaffPortalUiSource();
const policy = fs.readFileSync(path.join(__dirname, 'lib/stripe-hold-promote-policy.js'), 'utf8');
const { paymentLinkIntendedAmountCents } = require('./lib/payment-ledger-stale-links');
const checkout = require('./lib/per-guest-checkout');

const cases = [
  [{ shareCents: 32500, depositCents: 10000, receivedCents: 0 }, { depositRemainingCents: 10000, remainingShareCents: 32500 }],
  [{ shareCents: 32500, depositCents: 10000, receivedCents: 10000 }, { depositRemainingCents: 0, remainingShareCents: 22500 }],
  [{ shareCents: 32500, depositCents: 10000, receivedCents: 32500 }, { depositRemainingCents: 0, remainingShareCents: 0 }],
  [{ shareCents: 32500, depositCents: 10000, receivedCents: 4000 }, { depositRemainingCents: 6000, remainingShareCents: 28500 }],
];
for (const [input, expected] of cases) assert.deepStrictEqual(routes.computeGuestPayableAmounts(input), expected);
assert.deepStrictEqual(routes.computeGuestPayableAmounts({ shareCents: 0, depositCents: 10000, receivedCents: 0 }),
  { depositRemainingCents: 0, remainingShareCents: 0 });
const guestId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const remaining = { payment_kind: 'full_amount', amount_due_cents: 22500, booking_guest_id: guestId,
  metadata: { payment_target: 'remaining_share', booking_guest_id: guestId } };
assert.strictEqual(paymentLinkIntendedAmountCents(remaining, { guest_amounts_by_id: {
  [guestId]: { subtotal_cents: 32500, deposit_cents: 10000, amount_paid_cents: 10000 },
} }), 22500);
assert.strictEqual(paymentLinkIntendedAmountCents(remaining, { guest_amounts_by_id: {
  [guestId]: { subtotal_cents: 32500, deposit_cents: 10000, amount_paid_cents: 32500 },
} }), 0, 'authoritative zero must not fall back to old checkout amount');
assert(portal.includes('data-payment-target="deposit"'), 'deposit row action missing');
assert(portal.includes('data-payment-target="remaining_share"'), 'remaining-share row action missing');
assert(portal.indexOf('data-payment-target="deposit"') < portal.indexOf('data-payment-target="remaining_share"'), 'deposit must precede payment');
assert(portal.includes("if (getClient() !== 'wolfhouse-somo') html += bcRenderGuestPaymentLinkControlsHtml"), 'Wolfhouse dropdown suppression missing');
assert(portal.includes("payment_target: paymentTarget"), 'browser must send explicit target');
assert(portal.includes('var link = (res.data && res.data.checkout_url) ||'), 'UI must prefer payment-specific checkout URL');
assert(policy.includes('SELECT COALESCE(SUM(amount_paid_cents), 0)'), 'guest projection must sum distinct paid ledger rows');
assert(!policy.includes('SET amount_paid_cents = GREATEST(COALESCE(amount_paid_cents, 0), $1)'), 'obsolete max projection remains');
const routeSource = fs.readFileSync(path.join(__dirname, 'lib/staff-bot-v2-routes.js'), 'utf8');
assert(routeSource.includes('stripe.checkout.sessions.expire'), 'replacement must retire the prior provider checkout');
assert(routeSource.includes("SELECT id FROM booking_guests WHERE id = $1::uuid AND booking_id = $2::uuid FOR UPDATE"), 'same guest domain must serialize with receipt writers');
assert(routeSource.includes("{ idempotencyKey: stripeIdempotencyKey }"), 'Stripe request must use deterministic idempotency identity');
assert(routeSource.indexOf("await pg.query('COMMIT')") < routeSource.indexOf('stripe.checkout.sessions.create({', routeSource.indexOf('async function handleBotGuestPaymentCreateLink')), 'durable draft must commit before provider creation');
assert(routeSource.includes("authMode === 'staff_portal' && paymentTarget === 'full_share'"), 'staff endpoint must reject legacy full_share');
assert(routeSource.includes("(checkout|billing)\\.stripe\\.com"), 'checkout URL must be restricted to approved Stripe HTTPS hosts');
assert(routeSource.includes('unit_amount: amountDueCents'), 'legacy source amount assertion missing');
assert(portal.includes('requestStillCurrent'), 'late browser response guard missing');
assert(portal.includes("t('drawer.invoice.depositLink')"), 'visible Deposit Link label missing');
assert(portal.includes("t('drawer.invoice.paymentLink')"), 'visible Payment Link label missing');

(async () => {
  for (const failure of ['work', 'commit']) {
    const calls = [];
    const pg = { query: async (sql) => {
      calls.push(sql);
      if (failure === 'commit' && sql === 'COMMIT') throw new Error('commit failed');
      return { rows: [] };
    } };
    await assert.rejects(checkout.tx(pg, async () => {
      if (failure === 'work') throw new Error('query failed');
    }));
    assert.deepStrictEqual(calls.slice(-1), ['ROLLBACK'], failure + ' must rollback');
    await pg.query('SELECT reusable');
    assert.strictEqual(calls.at(-1), 'SELECT reusable');
  }
  assert(checkout.validUrl('https://checkout.stripe.com/c/pay/cs_test'));
  assert(!checkout.validUrl('https://checkout.stripe.com.evil.test/x'));
  console.log('PASS verify-per-guest-deposit-payment-links');
})().catch((err) => { console.error(err); process.exitCode = 1; });
