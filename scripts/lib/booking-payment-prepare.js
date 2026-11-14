'use strict';

function reject(reason, status = 409) {
  const error = new Error(reason);
  error.httpStatus = status;
  throw error;
}

// Caller holds the tenant binding; money always comes from the locked booking.
async function prepareBookingPayment(pg, { bookingId, clientSlug, phone, choice, distribution, authorize }) {
  if (!['deposit', 'full'].includes(choice)) reject('explicit_payment_choice_required', 400);
  if (!clientSlug || !phone) reject('booking_context_unbound', 403);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(bookingId || '')) reject('booking_id_required', 400);
  await pg.query('BEGIN');
  try {
    if (authorize) {
      const admission = await authorize(pg);
      if (!admission || !admission.allowed) reject(admission && admission.reason || 'booking_policy_unavailable', admission && admission.unavailable ? 503 : 403);
    }
    const result = await pg.query(`SELECT b.* FROM bookings b JOIN clients c ON c.id=b.client_id
      WHERE b.id=$1::uuid AND c.slug=$2 FOR UPDATE OF b`, [bookingId, clientSlug]);
    const booking = result.rows[0];
    const digits = value => String(value || '').replace(/\D/g, '');
    if (!booking || !digits(phone) || digits(booking.phone) !== digits(phone)) reject('booking_not_found', 404);
    if (['cancelled', 'expired'].includes(booking.status)) reject('booking_not_active');
    if (distribution === 'separate') {
      const retired = await require('./booking-payment-draft-retirement').retireInertInitialBookingDraft(pg, booking.client_id, bookingId);
      await pg.query('COMMIT');
      return { success: true, booking_id: bookingId, payment_id: null, payment_choice: choice,
        payment_link_distribution: 'separate', next_action: 'create_guest_payment_links',
        retired_payment_ids: retired, idempotent: retired.length === 0, write_performed: retired.length > 0,
        creates_stripe_link: false, sends_whatsapp: false };
    }
    const receipt = (await pg.query(`SELECT COALESCE(SUM(amount_paid_cents),0)::bigint AS paid
      FROM payments WHERE client_id=$1 AND booking_id=$2 AND status='paid'
      AND COALESCE(metadata->>'payment_scope','booking')='booking'`, [booking.client_id, bookingId])).rows[0];
    const paid = Math.max(Number(booking.amount_paid_cents || 0), Number(receipt.paid));
    const target = Number(choice === 'deposit' ? booking.deposit_required_cents : booking.total_amount_cents);
    if (!Number.isSafeInteger(target) || target <= 0 || !Number.isSafeInteger(paid) || paid < 0) reject('authoritative_booking_money_unavailable');
    const amount = Math.max(0, target - paid);
    if (!amount) reject('nothing_due', 422);
    const existing = await pg.query(`SELECT * FROM payments WHERE client_id=$1 AND booking_id=$2
      AND status IN ('draft','checkout_created') ORDER BY created_at,id FOR UPDATE`, [booking.client_id, bookingId]);
    const hasProviderIdentity = payment => {
      const md = payment.metadata || {};
      return payment.status !== 'draft' || ['stripe_checkout_session_id', 'checkout_url', 'stripe_payment_intent_id']
        .some(key => payment[key]) || ['stripe_checkout_session_id', 'stripe_session_id', 'checkout_url',
          'payment_link_url', 'provider_idempotency_key', 'idempotency_key', 'checkout_preparation'].some(key => md[key]);
    };
    const active = existing.rows.filter(hasProviderIdentity);
    if (active.length) reject('booking_checkout_active');
    if (existing.rows.some(payment => payment.booking_guest_id || Number(payment.amount_paid_cents || 0) > 0
      || !['bot_booking_stage854', 'bot_booking_payment_prepare', 'staff_manual'].includes((payment.metadata || {}).source)
      || ((payment.metadata || {}).payment_scope || 'booking') !== 'booking')) reject('booking_payment_scope_conflict');
    if (existing.rows.length > 1) reject('booking_payment_scope_conflict');
    let row = existing.rows.find(payment => !payment.booking_guest_id);
    const kind = choice === 'deposit' ? 'deposit_only' : 'full_amount';
    const idempotent = !!row && Number(row.amount_due_cents) === amount && row.payment_kind === kind;
    if (row && !idempotent) {
      row = (await pg.query(`UPDATE payments SET amount_due_cents=$2,payment_kind=$3::payment_kind,
        metadata=metadata || $4::jsonb WHERE id=$1 RETURNING *`,
      [row.id, amount, kind, JSON.stringify({ payment_choice: choice })])).rows[0];
    }
    if (!row) {
      const inserted = await pg.query(`INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,metadata)
        VALUES($1,$2,'draft',$3::payment_kind,'EUR',$4,$5::jsonb) RETURNING *`,
      [booking.client_id, bookingId, choice === 'deposit' ? 'deposit_only' : 'full_amount', amount,
        JSON.stringify({ source: 'bot_booking_payment_prepare', payment_scope: 'booking', payment_choice: choice })]);
      row = inserted.rows[0];
    }
    await pg.query(`UPDATE bookings SET metadata=metadata || $2::jsonb WHERE id=$1`,
      [bookingId, JSON.stringify({ payment_choice: choice, payment_choice_pending: false, ask_payment_amount: false })]);
    await pg.query('COMMIT');
    return { success: true, booking_id: bookingId, booking_code: booking.booking_code,
      payment_id: row.id, payment_choice: choice, amount_due_cents: row.amount_due_cents,
      currency: row.currency, payment_status: row.status, idempotent, write_performed: !idempotent,
      creates_stripe_link: false, sends_whatsapp: false };
  } catch (error) {
    await pg.query('ROLLBACK');
    throw error;
  }
}
module.exports = { prepareBookingPayment };
