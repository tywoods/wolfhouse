'use strict';

/**
 * Guest payment_status follows a booking-level link and the later receipt.
 * not_requested stays only when nothing was requested and nothing was paid.
 *
 * Run: node scripts/verify-luna-guest-payment-status.js
 */

const assert = require('node:assert/strict');
const {
  markGuestsPaymentLinkRequested,
  markGuestsPaidForBookingPayment,
} = require('./lib/booking-guest-payment-status');
const {
  PAYMENT_LINK_CHANNELS,
  PAYMENT_LINK_OPERATIONS,
  WOLFHOUSE_CLIENT_SLUG,
  buildPaymentLinkCommand,
  createPaymentLink,
} = require('./lib/luna-front-desk-payment-link-service');
const { applyStripeBookingPaymentTruthWrites } = require('./lib/stripe-hold-promote-policy');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const BOOKING = '22222222-2222-4222-8222-222222222222';
const PAYMENT = '33333333-3333-4333-8333-333333333333';
const GUEST = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const OTHER_PAY = '66666666-6666-4666-8666-666666666666';

function guestBook() {
  return [
    { id: GUEST, client_id: CLIENT, booking_id: BOOKING, payment_status: 'not_requested', payment_id: null },
    { id: OTHER, client_id: CLIENT, booking_id: BOOKING, payment_status: 'not_requested', payment_id: OTHER_PAY },
  ];
}

function applyGuestUpdate(guests, sql, params) {
  const text = String(sql);
  if (!/UPDATE booking_guests/i.test(text)) return 0;
  let count = 0;
  if (/payment_link_sent/i.test(text)) {
    const guestId = params[2];
    const paymentId = params[3];
    for (const guest of guests) {
      if (guest.client_id !== params[0] || guest.booking_id !== params[1]) continue;
      if (guest.payment_status !== 'not_requested' && guest.payment_status !== 'draft') continue;
      if (guestId && guest.id !== guestId) continue;
      if (!guestId && guest.payment_id && guest.payment_id !== paymentId) continue;
      guest.payment_status = 'payment_link_sent';
      guest.payment_id = guest.payment_id || paymentId;
      count += 1;
    }
    return count;
  }
  const status = params[2];
  const paymentId = params[3];
  for (const guest of guests) {
    if (guest.client_id !== params[0] || guest.booking_id !== params[1]) continue;
    if (guest.payment_id && guest.payment_id !== paymentId) continue;
    if (guest.payment_status === 'paid') continue;
    if (guest.payment_status === 'deposit_paid' && status !== 'paid') continue;
    guest.payment_status = status;
    guest.payment_id = guest.payment_id || paymentId;
    count += 1;
  }
  return count;
}

function statusPg(guests, booking) {
  const calls = [];
  return {
    calls,
    guests,
    booking,
    query: async (sql, params) => {
      const text = String(sql);
      calls.push({ text, params: params || [] });
      if (/^SAVEPOINT|^RELEASE SAVEPOINT|^ROLLBACK TO SAVEPOINT/i.test(text)) return { rows: [] };
      if (/UPDATE booking_guests/i.test(text)) {
        return { rows: [], rowCount: applyGuestUpdate(guests, text, params || []) };
      }
      if (/UPDATE bookings/i.test(text) && /payment_link_sent/i.test(text)) {
        if (booking.payment_status === 'not_requested') booking.payment_status = 'payment_link_sent';
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
  };
}

(async () => {
  const guests = guestBook();
  const booking = { payment_status: 'not_requested' };
  const pg = statusPg(guests, booking);
  const linked = await markGuestsPaymentLinkRequested(pg, {
    clientId: CLIENT, bookingId: BOOKING, paymentId: PAYMENT, bookingGuestId: null,
  });
  assert.equal(linked, 1);
  assert.equal(guests[0].payment_status, 'payment_link_sent');
  assert.equal(guests[0].payment_id, PAYMENT);
  assert.equal(guests[1].payment_status, 'not_requested', 'a guest on another payment is not marked');
  assert.equal(guests[1].payment_id, OTHER_PAY);
  assert.equal(booking.payment_status, 'payment_link_sent');

  guests[0].payment_status = 'paid';
  await markGuestsPaymentLinkRequested(pg, {
    clientId: CLIENT, bookingId: BOOKING, paymentId: PAYMENT, bookingGuestId: null,
  });
  assert.equal(guests[0].payment_status, 'paid', 'a paid guest is not moved back to link-sent');
  console.log('PASS link requested: solo guest leaves not_requested, paid guest stays paid');

  const unpaid = guestBook();
  await markGuestsPaidForBookingPayment(statusPg(unpaid, { payment_status: 'not_requested' }), {
    clientId: CLIENT, bookingId: BOOKING, paymentId: PAYMENT, paymentStatus: 'waiting_payment',
  });
  assert.equal(unpaid[0].payment_status, 'not_requested', 'an unpaid state must not mark the guest paid');

  const depositGuests = guestBook();
  depositGuests[0].payment_status = 'payment_link_sent';
  depositGuests[0].payment_id = PAYMENT;
  const depositPg = statusPg(depositGuests, { payment_status: 'payment_link_sent' });
  const deposited = await markGuestsPaidForBookingPayment(depositPg, {
    clientId: CLIENT, bookingId: BOOKING, paymentId: PAYMENT, paymentStatus: 'deposit_paid',
  });
  assert.equal(deposited, 1);
  assert.equal(depositGuests[0].payment_status, 'deposit_paid');
  assert.equal(depositGuests[1].payment_status, 'not_requested');
  const paid = await markGuestsPaidForBookingPayment(depositPg, {
    clientId: CLIENT, bookingId: BOOKING, paymentId: PAYMENT, paymentStatus: 'paid',
  });
  assert.equal(paid, 1);
  assert.equal(depositGuests[0].payment_status, 'paid');
  console.log('PASS paid: booking-level deposit then full receipt updates that guest only');

  const linkCalls = [];
  const linkPg = {
    query: async (sql, params) => {
      const text = String(sql);
      linkCalls.push(text);
      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ROLLBACK TO)/i.test(text)) return { rows: [] };
      if (/FROM payments p/i.test(text) && /WHERE p\.id = \$1::uuid/i.test(text)) {
        return { rows: [{
          payment_id: PAYMENT,
          client_id: CLIENT,
          client_slug: WOLFHOUSE_CLIENT_SLUG,
          booking_id: BOOKING,
          booking_code: 'WH-20270920-04426616',
          booking_guest_id: null,
          guest_name: 'Ale Test Nia',
          check_in: '2027-09-20',
          check_out: '2027-09-26',
          booking_status: 'confirmed',
          payment_status: 'draft',
          payment_kind: 'deposit_only',
          currency: 'EUR',
          amount_due_cents: 20000,
          checkout_url: null,
          booking_phone: '+349****74710',
        }] };
      }
      if (/UPDATE payments/i.test(text) && /checkout_created/i.test(text)) {
        return { rows: [{ payment_id: PAYMENT, payment_status: 'checkout_created' }], rowCount: 1 };
      }
      if (/UPDATE payments/i.test(text)) return { rows: [{ id: PAYMENT }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const built = buildPaymentLinkCommand({
    operation: PAYMENT_LINK_OPERATIONS.CREATE,
    channel: PAYMENT_LINK_CHANNELS.LUNA_WHATSAPP,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    trustedGuestPhone: '+349****74710',
    paymentId: PAYMENT,
    target: 'draft_payment',
  });
  const created = await createPaymentLink(linkPg, built.command, {
    staffActionsEnabled: true,
    stripeLinksEnabled: true,
    secretKey: 'sk_test_guest_status',
    successUrl: 'https://example.com/success',
    cancelUrl: 'https://example.com/cancel',
    blockLiveKeys: true,
    createStripeCheckoutSession: async () => ({
      id: 'cs_test_guest_status',
      url: 'https://checkout.stripe.com/c/pay/cs_test_guest_status',
      livemode: false,
      payment_status: 'unpaid',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
  });
  assert.equal(created.ok, true, JSON.stringify(created && created.body || created));
  const guestSqlAt = linkCalls.findIndex((sql) => /UPDATE booking_guests/i.test(sql) && /payment_link_sent/i.test(sql));
  const commitAt = linkCalls.findIndex((sql, index) => index > guestSqlAt && sql.trim() === 'COMMIT');
  assert.ok(guestSqlAt > -1, 'link create must update booking_guests');
  assert.ok(commitAt > guestSqlAt, 'guest status is written before the link commits');
  console.log('PASS link service: bot checkout updates the guest before commit');

  const receiptGuests = guestBook();
  receiptGuests[0].payment_status = 'payment_link_sent';
  receiptGuests[0].payment_id = PAYMENT;
  const receiptPg = {
    query: async (sql, params) => {
      const text = String(sql);
      if (/FROM bookings[\s\S]*FOR UPDATE/i.test(text)) {
        return { rows: [{
          booking_id: BOOKING, booking_status: 'confirmed', hold_expires_at: null,
          hold_expired_by_db: false, bk_total: 35900, bk_amount_paid: 0,
          bk_balance: 35900, bk_deposit: 20000,
        }] };
      }
      if (/FROM payments[\s\S]*FOR UPDATE/i.test(text)) {
        return { rows: [{
          payment_id: PAYMENT, booking_id: BOOKING, client_id: CLIENT,
          booking_guest_id: null, payment_status: 'checkout_created',
          payment_kind: 'deposit_only', currency: 'EUR', amount_due_cents: 20000,
          pm_amount_paid: 0, stripe_checkout_session_id: 'cs_test_guest_status',
        }] };
      }
      if (/COALESCE\(SUM\(amount_paid_cents\)/i.test(text)) return { rows: [{ total: 0 }] };
      if (/UPDATE payments/i.test(text)) return { rowCount: 1, rows: [] };
      if (/UPDATE bookings/i.test(text)) return { rowCount: 1, rows: [] };
      if (/UPDATE booking_guests/i.test(text)) {
        return { rowCount: applyGuestUpdate(receiptGuests, text, params || []), rows: [] };
      }
      if (/^SAVEPOINT|^RELEASE SAVEPOINT|^ROLLBACK TO SAVEPOINT/i.test(text)) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
  const receipt = await applyStripeBookingPaymentTruthWrites(receiptPg, {
    pm: {
      payment_id: PAYMENT, booking_id: BOOKING, client_id: CLIENT, client_slug: WOLFHOUSE_CLIENT_SLUG,
    },
    session: {
      id: 'cs_test_guest_status', amount_total: 20000, currency: 'eur',
      metadata: { payment_id: PAYMENT },
    },
    stripePaidCents: 20000,
    paymentMetadataPatch: { source: 'guest_status_test' },
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.money.newBkPayStatus, 'deposit_paid');
  assert.equal(receiptGuests[0].payment_status, 'deposit_paid');
  assert.equal(receiptGuests[1].payment_status, 'not_requested');
  console.log('PASS receipt: booking-level deposit marks the covered guest deposit_paid');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
