#!/usr/bin/env node
'use strict';
// Actual Staff handler + SQL in memory. Stripe is an explicit offline fixture;
// no HTTP, production DB, guest send or real checkout is used by this proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');
const pricing = require('./lib/guest-addon-pricing');
const binding = require('./lib/luna-guest-addon-guest-bind');
const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const bookingId = '44444444-4444-4444-8444-444444444444';
const jonasId = '22222222-2222-4222-8222-222222222222';
const code = 'WH-20270618-15443747';

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TYPE payment_record_status AS ENUM ('draft','checkout_created','pending','paid','cancelled');
      CREATE TYPE payment_kind AS ENUM ('deposit_only','full_amount','addon_service');
      CREATE TABLE clients (id uuid PRIMARY KEY, slug text);
      CREATE TABLE bookings (id uuid PRIMARY KEY, client_id uuid, booking_code text,
        guest_name text, check_in date, check_out date, status text);
      CREATE TABLE booking_guests (id uuid PRIMARY KEY, booking_id uuid, guest_name text, guest_number int);
      CREATE TABLE booking_service_records (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_slug text, booking_id uuid,
        booking_code text, guest_name text, service_type text, service_date date,
        quantity int CHECK(quantity > 0), status text, amount_due_cents int, amount_paid_cents int,
        payment_status text, source text, notes text, metadata jsonb DEFAULT '{}', payment_id uuid,
        updated_at timestamptz DEFAULT now());
      CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid,
        booking_id uuid, booking_guest_id uuid REFERENCES booking_guests(id),
        status payment_record_status, payment_kind payment_kind, currency text,
        amount_due_cents int, amount_paid_cents int, metadata jsonb DEFAULT '{}',
        checkout_url text, stripe_checkout_session_id text, expires_at timestamptz);
      INSERT INTO clients VALUES ('11111111-1111-4111-8111-111111111111','wolfhouse-somo');
      INSERT INTO bookings VALUES ('${bookingId}','11111111-1111-4111-8111-111111111111',
        '${code}','Marta Keller','2027-06-18','2027-06-25','confirmed');
      INSERT INTO booking_guests VALUES
        ('33333333-3333-4333-8333-333333333333','${bookingId}','Marta Keller',1),
        ('${jonasId}','${bookingId}','Jonas Keller',2);
    `);
    const checkoutRequests = [];
    const context = {
      ...pricing, ...binding, console, Date, JSON,
      process: { env: { DEFAULT_CLIENT_SLUG: 'wolfhouse-somo' } },
      DEFAULT_CLIENT: 'wolfhouse-somo', BOT_ADDON_REQUESTS_ENABLED: true,
      STAFF_AUTH_REQUIRED: true, STRIPE_LINKS_ENABLED: true, STRIPE_SECRET_KEY: 'offline-fixture',
      withPgClient: async fn => fn(db),
      resolveBotHandlerTrustedClientSlug: () => 'wolfhouse-somo',
      whatsappDryRunGate: () => true,
      readBody: async req => JSON.stringify(req.body),
      sendJSON: (res, status, body) => Object.assign(res, { status, body }),
      send400: (res, error) => Object.assign(res, { status: 400, body: { error } }),
      isMissingBookingServiceRecordsTable: err => err.code === '42P01',
      appendAuditLog: () => {},
      stripeCheckoutRedirectUrlsConfigured: () => true,
      stripeCheckoutSessionSuccessUrl: () => 'https://example.invalid/success',
      stripeCheckoutSessionCancelUrl: () => 'https://example.invalid/cancel',
      botAddonPaymentLinkObservability: (_ctx, url) => ({ guest_payment_url: url }),
      applyBotAddonPaymentLinkFields: (target, _ctx, url, id) => Object.assign(target, {
        checkout_url: url, guest_payment_url: url, stripe_checkout_session_id: id,
      }),
      require: name => {
        assert.equal(name, 'stripe', 'No unplanned module/network boundary');
        return () => ({ checkout: { sessions: { create: async request => {
          checkoutRequests.push(request);
          const id = 'cs_test_offline_' + checkoutRequests.length;
          return { id, url: 'https://checkout.stripe.com/c/pay/' + id, livemode: false };
        } } } });
      },
    };
    const start = source.indexOf('async function lookupBotAddonBooking(');
    const end = source.indexOf('// Phase 9.4b — Luna guest bot pause/resume', start);
    assert(start > 0 && end > start, 'Production handler source boundaries found');
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context, { filename: 'actual-addon-handlers.js' });
    const errors = [];
    for (const [kind, fields] of [
      ['meal', { service_date: '2027-06-20', quantity: 1 }],
      ['yoga', {}], // One schedule-later class: exercise the real default quantity.
    ]) {
      try {
        const res = {};
        await context.handleBotAddonRequestCreate({ body: {
          confirm: true, booking_code: code, service_type: kind,
          booking_guest_id: jonasId, ...fields,
        } }, res, null, 'bot_token');
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.booking_guest_id, jonasId);
        assert.equal(res.body.guest_name, 'Jonas Keller');
        assert.equal(res.body.write_performed, true);
        assert.equal(res.body.payment_required, true);
        assert.match(res.body.checkout_url, /cs_test_offline_/);
        const { rows: [row] } = await db.query(`SELECT s.*, p.booking_guest_id AS payer,
          p.checkout_url FROM booking_service_records s JOIN payments p ON p.id=s.payment_id
          WHERE s.id=$1`, [res.body.service_record_id]);
        assert.equal(row.guest_name, 'Jonas Keller');
        assert.equal(row.metadata.booking_guest_id, jonasId);
        assert.equal(row.payer, jonasId);
        assert.equal(row.quantity, 1);
        assert.equal(row.amount_due_cents, pricing.previewGuestAddonPricing(kind, 1, 'wolfhouse-somo').amount_due_cents);
        assert.equal(row.amount_paid_cents, 0);
        assert.equal(row.metadata.schedule_mode, kind === 'meal' ? 'specific_date' : 'schedule_later');
        assert.equal(row.service_date ? new Date(row.service_date).toISOString().slice(0, 10) : null,
          kind === 'meal' ? '2027-06-20' : null);
        assert.equal(row.checkout_url, res.body.checkout_url);
        assert.equal(checkoutRequests.at(-1).metadata.payment_id, row.payment_id);
        assert.equal(checkoutRequests.at(-1).line_items[0].price_data.unit_amount, row.amount_due_cents);
        console.log('PASS actual handler + SQL:', kind, 'guest-bound, dated/open, unpaid, checkout receipt');
      } catch (err) { errors.push(kind + ': ' + err.message); }
    }
    assert.deepEqual(errors, []);
    assert.equal(checkoutRequests.length, 2);
    console.log('PASS 2 requested services, 2 guest-bound payment rows, 0 live provider calls');
  } finally { await db.close(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
