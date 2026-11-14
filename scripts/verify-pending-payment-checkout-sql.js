'use strict';
// Offline production save -> registered prepare branch -> registered checkout
// branch -> production payment owner -> synthetic Stripe SDK. No SQL doubles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { PGlite, seed, runScenario } = require('./verify-missing-payment-choice-always-saves');
const { actualApiFunction } = require('./verify-package-minimum-transport');
const routes = require('./lib/staff-bot-v2-routes');
const SLUG = 'wolfhouse-somo';
const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const start = source.indexOf('  const botStripeMatch = BOT_PAYMENT_STRIPE_LINK_RE.exec(pathname);');
const end = source.indexOf('  // POST /staff/bot/payments/create-balance-link', start);
assert(start > 0 && end > start, 'use actual registered route branches');

async function main() {
  const db = new PGlite();
  const sdkCalls = [];
  const originalLoad = Module._load;
  Module._load = function(name, ...args) {
    if (name !== 'stripe') return originalLoad.call(this, name, ...args);
    return key => {
      assert.equal(key, 'sk_test_offline_fixture');
      return { checkout: { sessions: { create: async options => {
        sdkCalls.push(options);
        return { id: `cs_test_offline_${sdkCalls.length}`, url: `https://checkout.stripe.com/offline/${sdkCalls.length}`,
          livemode: false, payment_status: 'unpaid' };
      } } } };
    };
  };
  try {
    await seed(db);
    await db.exec(`ALTER TYPE payment_record_status ADD VALUE 'paid';
      ALTER TYPE payment_record_status ADD VALUE 'checkout_created';
      ALTER TABLE payments ADD COLUMN amount_paid_cents integer DEFAULT 0;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS expires_at timestamptz;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS amount_paid_cents integer DEFAULT 0;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_due_cents integer DEFAULT 0;`);
    for (const paid of [0, 20000]) {
      for (const choice of ['deposit', 'full']) {
        const saved = await runScenario(db, `checkout-${choice}-${paid}`, { payment_link_distribution: 'together' }, true);
        const booking = saved.saved;
        assert.equal(saved.related.payments.length, 0);
        let receipt;
        if (paid) {
          receipt = (await db.query(`INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents,metadata)
            VALUES($1,$2,'paid','deposit_only','EUR',$3,$3,'{"payment_scope":"booking"}') RETURNING *`,
          [booking.client_id, booking.id, paid])).rows[0];
          assert.equal(booking.amount_paid_cents, 0, 'receipt proof intentionally precedes booking aggregate refresh');
        }
        const expected = (choice === 'deposit' ? booking.deposit_required_cents : booking.total_amount_cents) - paid;
        let response;
        const ctx = {
          STAFF_ACTIONS_ENABLED: true, STAFF_AUTH_REQUIRED: false, STRIPE_LINKS_ENABLED: true,
          STRIPE_SECRET_KEY: 'sk_test_offline_fixture',
          readBody: async req => JSON.stringify(req.body), withPgClient: fn => fn(db),
          sendJSON: (_res, status, body) => { response = { status, body }; return response; },
          resolveWolfhouseAutomaticBookingAdmission: async () => ({ allowed: true }),
          appendAuditLog() {},
          stripeCheckoutRedirectUrlsConfigured: () => true,
          stripeCheckoutSessionSuccessUrl: () => 'https://offline.invalid/success',
          stripeCheckoutSessionCancelUrl: () => 'https://offline.invalid/cancel',
          guestPaymentLinkObservability: (_pm, url) => ({ guest_payment_url: url, payment_short_url: null, uses_short_payment_link: false }),
          _handleBotBookingPreparePayment: routes.handleBotBookingPreparePayment,
          _handleBotPaymentCreateStripeLink: routes.handleBotPaymentCreateStripeLink,
          process: { env: {} },
        };
        const route = vm.runInNewContext(`(async function(req,res) {
          const pathname=req.url, method='POST', parsed={query:{}};
          ${source.slice(start, end)}
        })`, {
          BOT_PAYMENT_STRIPE_LINK_RE: /^\/staff\/bot\/payments\/([0-9a-f-]+)\/create-stripe-link$/i,
          // Authentication/tenant binding are in-process transport fixtures, not network requests.
          requireBotAuth: async () => ({ ok: true }),
          dispatchBotRouteBoundToPrincipalTenant: (_auth, req, _res, _query, fn) => {
            req._botBoundClientSlug = SLUG;
            return fn(null, 'bot_token');
          },
          handleBotBookingPreparePayment: actualApiFunction('handleBotBookingPreparePayment', ctx),
          handleBotPaymentCreateStripeLink: actualApiFunction('handleBotPaymentCreateStripeLink', ctx),
        });
        async function request(url, body) {
          response = null;
          await route({ url, body, headers: { 'x-luna-guest-phone': booking.phone } }, {});
          assert.equal(response && response.status, 200, JSON.stringify(response));
          return response.body;
        }
        const prepare = () => request('/staff/bot/payments/prepare', {
          booking_id: booking.id, payment_choice: choice, payment_link_distribution: 'together',
        });
        const prepared = await prepare();
        assert.equal(prepared.amount_due_cents, expected);
        const preparedRetry = await prepare();
        assert.equal(preparedRetry.payment_id, prepared.payment_id);
        assert.equal(preparedRetry.idempotent, true);
        const callsBefore = sdkCalls.length;
        const checkout = () => request(`/staff/bot/payments/${prepared.payment_id}/create-stripe-link`, { payment_choice: choice });
        const linked = await checkout();
        assert.equal(sdkCalls.length, callsBefore + 1);
        const sdk = sdkCalls[callsBefore];
        assert.equal(sdk.line_items[0].price_data.unit_amount, expected,
          `${choice}: checkout must preserve saved booking money minus paid receipts`);
        assert.equal(sdk.line_items[0].quantity, 1);
        assert.equal(sdk.metadata.payment_id, prepared.payment_id);
        assert.equal(sdk.metadata.booking_id, booking.id);
        assert.equal(linked.amount_due_cents, expected);
        const snapshot = (await db.query('SELECT * FROM payments ORDER BY id')).rows;
        const retried = await checkout();
        assert.equal(retried.idempotent, true);
        assert.equal(retried.payment_id, prepared.payment_id);
        assert.equal(retried.checkout_url, linked.checkout_url);
        assert.equal(retried.amount_due_cents, expected);
        assert.equal(sdkCalls.length, callsBefore + 1, 'retry reuses checkout without SDK call');
        assert.deepEqual((await db.query('SELECT * FROM payments ORDER BY id')).rows, snapshot);
        assert.equal(snapshot.length, paid ? 2 : 1);
        const persisted = snapshot.find(row => row.id === prepared.payment_id);
        assert.equal(persisted.status, 'checkout_created');
        assert.equal(persisted.amount_due_cents, expected);
        assert.equal(persisted.stripe_checkout_session_id, linked.stripe_checkout_session_id);
        if (receipt) assert.deepEqual(snapshot.find(row => row.id === receipt.id), receipt);
        console.log(`PASS ${choice}: pending SQL save -> /payments/prepare -> create-stripe-link SDK=${expected}, paid=${paid}, prepare/checkout retries reused`);
      }
    }
  } finally { Module._load = originalLoad; await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
