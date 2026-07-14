'use strict';

// Phase 10.6d — staff payment choices at manual booking create
const MANUAL_BOOKING_STAFF_PAYMENT_CHOICES = new Set([
  'stripe_deposit',            // group deposit link (one link for the full deposit)
  'stripe_deposit_per_guest',  // one deposit link per guest
  'stripe_full',
  'paid_cash',
  'paid_bank_transfer',
  'no_payment_yet',
]);

// Both deposit choices behave identically for amount/kind/status — they differ
// only in link scope (one group link vs one link per guest).
function isManualBookingDepositChoice(c) {
  return c === 'stripe_deposit' || c === 'stripe_deposit_per_guest';
}

const MANUAL_BOOKING_LEGACY_PAYMENT_MAP = Object.freeze({
  deposit: 'stripe_deposit',
  'pay deposit': 'stripe_deposit',
  'the deposit': 'stripe_deposit',
  'deposit only': 'stripe_deposit',
  full: 'stripe_full',
  'full amount': 'stripe_full',
  'pay full': 'stripe_full',
  'pay full amount': 'stripe_full',
  'all now': 'stripe_full',
  'pay all': 'stripe_full',
  everything: 'stripe_full',
  'whole amount': 'stripe_full',
  pay_on_arrival: 'no_payment_yet',
  'pay on arrival': 'no_payment_yet',
  'on arrival': 'no_payment_yet',
  arrival: 'no_payment_yet',
});

function normalizeManualBookingStaffPaymentChoice(raw) {
  const c = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (MANUAL_BOOKING_STAFF_PAYMENT_CHOICES.has(c)) return c;
  if (MANUAL_BOOKING_LEGACY_PAYMENT_MAP[c]) return MANUAL_BOOKING_LEGACY_PAYMENT_MAP[c];
  return null;
}

function manualBookingQuotePaymentChoice(staffChoice) {
  if (isManualBookingDepositChoice(staffChoice)) return 'deposit';
  if (staffChoice === 'stripe_full') return 'full';
  return 'pay_on_arrival';
}

function manualBookingPaymentKindForStaffChoice(staffChoice) {
  return staffChoice === 'stripe_full' ? 'full_amount' : 'deposit_only';
}

function manualBookingAmountDueForStaffChoice(staffChoice, depositCents, totalCents) {
  if (staffChoice === 'stripe_full') return totalCents;
  if (isManualBookingDepositChoice(staffChoice)) return depositCents;
  return 0;
}

function resolveManualBookingPaidAmountCents(depositCents, totalCents, paidAmountType, customCents) {
  const t = String(paidAmountType || 'deposit').toLowerCase();
  if (t === 'full') return Number(totalCents || 0);
  if (t === 'custom') {
    const n = Math.floor(Number(customCents));
    if (!n || n <= 0) return null;
    return n;
  }
  return Number(depositCents || 0);
}

function manualBookingBookingPaymentStatusForCreate(staffChoice, paidCents, totalCents) {
  if (staffChoice === 'paid_cash' || staffChoice === 'paid_bank_transfer') {
    const total = Number(totalCents || 0);
    const paid = Number(paidCents || 0);
    if (total > 0 && paid >= total) return 'paid';
    if (paid > 0) return 'deposit_paid';
    return 'not_requested';
  }
  if (isManualBookingDepositChoice(staffChoice) || staffChoice === 'stripe_full') return 'waiting_payment';
  return 'not_requested';
}

function isStripeConfigured(stripeConfig) {
  if (!stripeConfig) return false;
  const redirectUrlsConfigured = typeof stripeConfig.redirectUrlsConfigured === 'function'
    ? stripeConfig.redirectUrlsConfigured()
    : !!stripeConfig.redirectUrlsConfigured;
  return !!(stripeConfig.stripeLinksEnabled && stripeConfig.stripeSecretKey && redirectUrlsConfigured);
}

function stripeSuccessUrl(stripeConfig) {
  if (!stripeConfig) return null;
  return typeof stripeConfig.successUrl === 'function' ? stripeConfig.successUrl() : stripeConfig.successUrl;
}

function stripeCancelUrl(stripeConfig) {
  if (!stripeConfig) return null;
  return typeof stripeConfig.cancelUrl === 'function' ? stripeConfig.cancelUrl() : stripeConfig.cancelUrl;
}

// Create one deposit Stripe link per guest (€200/€100 each) from the inserted
// booking_guests rows. Each link is its own payment row tagged with the guest's
// booking_guest_id, so it renders in the drawer's per-guest section and is never
// mistaken for the group balance link. All-or-nothing inside the create txn.
async function manualBookingCreatePerGuestDepositLinks(pg, opts) {
  const { bookingGuests, bookingId, bookingCode, clientSlug, checkIn, checkOut, idempotencyKey, outcome, stripeConfig } = opts;
  const guests = (bookingGuests || []).filter((g) => g && g.booking_guest_id);

  if (guests.length === 0) {
    // No per-guest rows (e.g. booking_guests table not migrated). Nothing to do —
    // staff can still generate links from the drawer.
    outcome.payment_status = 'waiting_payment';
    outcome.per_guest_links = [];
    outcome.message = 'Booking created. No per-guest rows available — generate deposit links from the booking drawer.';
    return outcome;
  }

  const totalDepositCents = guests.reduce((s, g) => s + Number(g.deposit_amount_cents || 0), 0);
  const stripeConfigured = isStripeConfigured(stripeConfig);

  const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
  const clientId = clientRes.rows[0] && clientRes.rows[0].id;
  if (!clientId) throw new Error('client not found');

  let stripe = null;
  if (stripeConfigured) {
    try {
      stripe = require('stripe')(stripeConfig.stripeSecretKey);
    } catch (e) {
      throw new Error('STRIPE_SDK_LOAD_FAILED: ' + e.message);
    }
  }

  const perGuestLinks = [];
  for (const g of guests) {
    const amountDueCents = Number(g.deposit_amount_cents || 0);
    const idemKey = `mb-guest-deposit-${idempotencyKey}-${g.guest_number}`;
    const ins = await pg.query(
      `INSERT INTO payments (
         client_id, booking_id, booking_guest_id, status, payment_kind, currency,
         amount_due_cents, amount_paid_cents, metadata
       ) VALUES (
         $1, $2::uuid, $3::uuid, 'draft'::payment_record_status, 'deposit_only'::payment_kind, 'EUR',
         $4, 0, $5::jsonb
       ) RETURNING id::text AS payment_id`,
      [clientId, bookingId, g.booking_guest_id, amountDueCents, JSON.stringify({
        source: 'staff_manual_per_guest_deposit',
        method: 'payment_link',
        idempotency_key: idemKey,
        booking_guest_id: g.booking_guest_id,
        guest_number: g.guest_number,
      })],
    );
    const paymentId = ins.rows[0].payment_id;

    if (!stripe) {
      perGuestLinks.push({ guest_number: g.guest_number, payment_id: paymentId, amount_due_cents: amountDueCents, payment_link_skipped: true });
      continue;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'eur',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Deposit — ${g.guest_name || 'Guest ' + g.guest_number} (${bookingCode || bookingId})`,
            description: `Deposit | ${checkIn} – ${checkOut} | ${clientSlug}`,
          },
          unit_amount: amountDueCents,
        },
        quantity: 1,
      }],
      metadata: {
        client_slug: clientSlug,
        booking_id: bookingId,
        booking_code: bookingCode || '',
        payment_id: paymentId,
        booking_guest_id: g.booking_guest_id,
        payment_kind: 'deposit_only',
        source: 'staff_manual_per_guest_deposit',
        idempotency_key: idemKey,
        staff_payment_choice: 'stripe_deposit_per_guest',
      },
      success_url: stripeSuccessUrl(stripeConfig),
      cancel_url: stripeCancelUrl(stripeConfig),
    });
    const expiresAt = session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null;
    await pg.query(
      `UPDATE payments
          SET status = 'checkout_created'::payment_record_status,
              stripe_checkout_session_id = $1, checkout_url = $2, expires_at = $3,
              metadata = (metadata || $4::jsonb)
        WHERE id = $5::uuid`,
      [session.id, session.url, expiresAt, JSON.stringify({
        stripe_session_id: session.id,
        payment_link_url: session.url,
      }), paymentId],
    );
    perGuestLinks.push({ guest_number: g.guest_number, payment_id: paymentId, amount_due_cents: amountDueCents, checkout_url: session.url });
  }

  await pg.query(
    `UPDATE bookings
        SET payment_status = 'waiting_payment'::payment_status
      WHERE id = $1::uuid
        AND client_id = (SELECT id FROM clients WHERE slug = $2 LIMIT 1)`,
    [bookingId, clientSlug],
  );

  outcome.payment_status = stripe ? 'payment_link_created' : 'waiting_payment';
  outcome.amount_due_cents = totalDepositCents;
  outcome.per_guest_links = perGuestLinks;
  outcome.payment_link_url = perGuestLinks[0] ? perGuestLinks[0].checkout_url || null : null;
  outcome.checkout_url = outcome.payment_link_url;
  outcome.payment_id = perGuestLinks[0] ? perGuestLinks[0].payment_id : null;
  outcome.payment_link_skipped = !stripe;
  outcome.message = stripe
    ? `Booking created. ${perGuestLinks.length} per-guest deposit link${perGuestLinks.length === 1 ? '' : 's'} created (€${(totalDepositCents / 100).toFixed(2)} total).`
    : 'Booking created. Per-guest deposit rows created — links skipped (online payment links disabled).';
  return outcome;
}

async function manualBookingApplyStaffPaymentChoice(pg, opts) {
  const staffPaymentChoice = opts.staffPaymentChoice;
  const paidAmountType = opts.paidAmountType;
  const paidAmountCustomCents = opts.paidAmountCustomCents;
  let paymentId = opts.paymentId || null;
  const bookingId = opts.bookingId;
  const bookingCode = opts.bookingCode;
  const clientSlug = opts.clientSlug;
  const depositCents = opts.depositCents;
  const totalCents = opts.totalCents;
  const actorId = opts.actorId;
  const actorLabel = opts.actorLabel || actorId;
  const idempotencyKey = opts.idempotencyKey;
  const guestName = opts.guestName || 'Guest';
  const checkIn = opts.checkIn || '';
  const checkOut = opts.checkOut || '';
  const stripeConfig = opts.stripeConfig;

  const outcome = {
    payment_choice: staffPaymentChoice,
    payment_id: paymentId,
    payment_status: 'not_requested',
    payment_link_url: null,
    checkout_url: null,
    amount_due_cents: 0,
    amount_paid_cents: 0,
    stripe_called: false,
    message: '',
  };

  if (staffPaymentChoice === 'no_payment_yet') {
    outcome.message = 'Booking created. No payment link or paid record yet — balance remains due.';
    return outcome;
  }

  if (staffPaymentChoice === 'paid_cash' || staffPaymentChoice === 'paid_bank_transfer') {
    const paidCents = resolveManualBookingPaidAmountCents(
      depositCents, totalCents, paidAmountType, paidAmountCustomCents,
    );
    if (paidCents == null || paidCents <= 0) {
      const err = new Error('INVALID_PAID_AMOUNT');
      err.code = 'INVALID_PAID_AMOUNT';
      throw err;
    }
    const isBank = staffPaymentChoice === 'paid_bank_transfer';
    const method = isBank ? 'bank_transfer' : 'cash';
    const source = isBank ? 'staff_bank_transfer' : 'staff_cash';
    const paidIdemKey = `mb-paid-${idempotencyKey}`;

    const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
    const clientId = clientRes.rows[0] && clientRes.rows[0].id;
    if (!clientId) throw new Error('client not found');

    const idem = await pg.query(
      `SELECT id::text AS payment_id FROM payments
        WHERE booking_id = $1::uuid AND metadata->>'idempotency_key' = $2 LIMIT 1`,
      [bookingId, paidIdemKey],
    );
    if (idem.rows[0]) {
      paymentId = idem.rows[0].payment_id;
    } else {
      const paidAt = new Date().toISOString();
      const pmMeta = {
        source,
        method,
        idempotency_key: paidIdemKey,
        staff_portal: true,
        phase: '10.6d',
        recorded_by: actorLabel,
        paid_amount_type: paidAmountType || 'deposit',
        manual_booking_create: true,
      };
      const ins = await pg.query(
        `INSERT INTO payments (
           client_id, booking_id, status, payment_kind, currency,
           amount_due_cents, amount_paid_cents, paid_at, metadata
         ) VALUES (
           $1, $2::uuid, 'paid'::payment_record_status, 'full_amount'::payment_kind, 'EUR',
           $3, $3, $4::timestamptz, $5::jsonb
         ) RETURNING id::text AS payment_id`,
        [clientId, bookingId, paidCents, paidAt, JSON.stringify(pmMeta)],
      );
      paymentId = ins.rows[0].payment_id;
    }

    const sumRes = await pg.query(
      `SELECT COALESCE(SUM(amount_paid_cents), 0)::int AS total
         FROM payments
        WHERE booking_id = $1::uuid AND status = 'paid'::payment_record_status`,
      [bookingId],
    );
    const newBkPaid = Number(sumRes.rows[0].total || 0);
    const newBalance = totalCents > 0 ? Math.max(totalCents - newBkPaid, 0) : 0;
    const newBkPayStatus = manualBookingBookingPaymentStatusForCreate(
      staffPaymentChoice, newBkPaid, totalCents,
    );

    await pg.query(
      `UPDATE bookings
          SET amount_paid_cents = $1, balance_due_cents = $2, payment_status = $3::payment_status
        WHERE id = $4::uuid
          AND client_id = (SELECT id FROM clients WHERE slug = $5 LIMIT 1)`,
      [newBkPaid, newBalance, newBkPayStatus, bookingId, clientSlug],
    );

    outcome.payment_id = paymentId;
    outcome.amount_paid_cents = paidCents;
    outcome.payment_status = newBkPayStatus;
    outcome.message = `Booking created. ${isBank ? 'Bank transfer' : 'Cash'} payment of \u20ac${(paidCents / 100).toFixed(2)} recorded. No payment link was created or sent.`;
    return outcome;
  }

  // ── Per-guest deposit links: one deposit link per guest (€200/€100 each) ────
  if (staffPaymentChoice === 'stripe_deposit_per_guest') {
    return manualBookingCreatePerGuestDepositLinks(pg, {
      bookingGuests: opts.bookingGuests || [],
      bookingId,
      bookingCode,
      clientSlug,
      checkIn,
      checkOut,
      idempotencyKey,
      stripeConfig,
      outcome,
    });
  }

  const amountDueCents = manualBookingAmountDueForStaffChoice(
    staffPaymentChoice, depositCents, totalCents,
  );
  const paymentKind = manualBookingPaymentKindForStaffChoice(staffPaymentChoice);
  const stripeIdemKey = `mb-stripe-${idempotencyKey}-${staffPaymentChoice}`;
  const stripeConfigured = isStripeConfigured(stripeConfig);

  if (!paymentId) {
    const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
    const clientId = clientRes.rows[0] && clientRes.rows[0].id;
    if (!clientId) throw new Error('client not found');
    const ins = await pg.query(
      `INSERT INTO payments (
         client_id, booking_id, status, payment_kind, currency,
         amount_due_cents, amount_paid_cents, metadata
       ) VALUES (
         $1, $2::uuid, 'draft'::payment_record_status, $3::payment_kind, 'EUR',
         $4, 0, $5::jsonb
       ) RETURNING id::text AS payment_id`,
      [clientId, bookingId, paymentKind, amountDueCents, JSON.stringify({
        source: 'staff_manual_stripe',
        method: 'payment_link',
        idempotency_key: stripeIdemKey,
        phase: '10.6d',
      })],
    );
    paymentId = ins.rows[0].payment_id;
  } else {
    await pg.query(
      `UPDATE payments
          SET payment_kind = $1::payment_kind,
              amount_due_cents = $2,
              amount_paid_cents = 0,
              metadata = (metadata || $3::jsonb) - 'note'
        WHERE id = $4::uuid`,
      [paymentKind, amountDueCents, JSON.stringify({
        source: 'staff_manual_stripe',
        method: 'payment_link',
        idempotency_key: stripeIdemKey,
        phase: '10.6d',
      }), paymentId],
    );
  }

  if (!stripeConfigured) {
    await pg.query(
      `UPDATE bookings
          SET payment_status = 'waiting_payment'::payment_status
        WHERE id = $1::uuid
          AND client_id = (SELECT id FROM clients WHERE slug = $2 LIMIT 1)`,
      [bookingId, clientSlug],
    );
    outcome.payment_id = paymentId;
    outcome.amount_due_cents = amountDueCents;
    outcome.payment_status = 'waiting_payment';
    outcome.payment_link_skipped = true;
    outcome.skip_reason = 'stripe_links_disabled';
    outcome.message = 'Booking created. Secure payment link skipped — online payment links are disabled. Generate a payment link from the booking drawer when enabled.';
    return outcome;
  }

  const existRes = await pg.query(
    `SELECT p.checkout_url, p.status::text AS payment_status
       FROM payments p
      INNER JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1::uuid
        AND c.slug = $2`,
    [paymentId, clientSlug],
  );
  const exist = existRes.rows[0];
  if (exist && exist.checkout_url && exist.payment_status === 'checkout_created') {
    outcome.payment_id = paymentId;
    outcome.payment_link_url = exist.checkout_url;
    outcome.checkout_url = exist.checkout_url;
    outcome.amount_due_cents = amountDueCents;
    outcome.payment_status = 'payment_link_created';
    outcome.message = 'Booking created. Secure payment link ready (idempotent). Link not marked paid — webhook confirms payment.';
    return outcome;
  }

  let stripe;
  try {
    stripe = require('stripe')(stripeConfig.stripeSecretKey);
  } catch (e) {
    throw new Error('STRIPE_SDK_LOAD_FAILED: ' + e.message);
  }

  const productName = `Booking ${bookingCode || paymentId} \u2014 ${guestName}`;
  const productDesc = `${staffPaymentChoice === 'stripe_full' ? 'Full payment' : 'Deposit'} | ${checkIn} \u2013 ${checkOut} | ${clientSlug}`;

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    currency: 'eur',
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: { name: productName, description: productDesc },
        unit_amount: amountDueCents,
      },
      quantity: 1,
    }],
    metadata: {
      client_slug: clientSlug,
      booking_id: bookingId,
      booking_code: bookingCode || '',
      payment_id: paymentId,
      payment_kind: paymentKind,
      source: 'staff_manual_stripe',
      idempotency_key: stripeIdemKey,
      staff_payment_choice: staffPaymentChoice,
    },
    success_url: stripeSuccessUrl(stripeConfig),
    cancel_url: stripeCancelUrl(stripeConfig),
  });

  const expiresAt = session.expires_at
    ? new Date(session.expires_at * 1000).toISOString()
    : null;

  await pg.query(
    `UPDATE payments
        SET status = 'checkout_created'::payment_record_status,
            stripe_checkout_session_id = $1,
            checkout_url = $2,
            expires_at = $3,
            amount_due_cents = $4,
            amount_paid_cents = 0,
            metadata = (metadata || $5::jsonb) - 'note'
      WHERE id = $6::uuid`,
    [session.id, session.url, expiresAt, amountDueCents, JSON.stringify({
      stripe_session_id: session.id,
      payment_link_url: session.url,
      staff_payment_choice: staffPaymentChoice,
    }), paymentId],
  );

  await pg.query(
    `UPDATE bookings
        SET payment_status = 'waiting_payment'::payment_status
      WHERE id = $1::uuid
        AND client_id = (SELECT id FROM clients WHERE slug = $2 LIMIT 1)`,
    [bookingId, clientSlug],
  );

  outcome.payment_id = paymentId;
  outcome.payment_link_url = session.url;
  outcome.checkout_url = session.url;
  outcome.amount_due_cents = amountDueCents;
  outcome.payment_status = 'payment_link_created';
  outcome.stripe_called = true;
  outcome.message = staffPaymentChoice === 'stripe_full'
    ? 'Booking created. Full secure payment link generated. Link not marked paid — webhook confirms payment.'
    : 'Booking created. Deposit secure payment link generated. Link not marked paid — webhook confirms payment.';
  return outcome;
}

module.exports = {
  MANUAL_BOOKING_STAFF_PAYMENT_CHOICES,
  isManualBookingDepositChoice,
  normalizeManualBookingStaffPaymentChoice,
  manualBookingQuotePaymentChoice,
  manualBookingPaymentKindForStaffChoice,
  manualBookingAmountDueForStaffChoice,
  resolveManualBookingPaidAmountCents,
  manualBookingBookingPaymentStatusForCreate,
  manualBookingCreatePerGuestDepositLinks,
  manualBookingApplyStaffPaymentChoice,
};
