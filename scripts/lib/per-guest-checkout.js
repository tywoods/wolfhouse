'use strict';

function metadata(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}'); } catch (_) { throw new Error('invalid_guest_metadata'); }
}

function amountFor(row, target) {
  const md = metadata(row.guest_metadata);
  const share = Number(md.subtotal_cents);
  const deposit = Number(row.deposit_amount_cents);
  const paid = Number(row.amount_paid_cents);
  if (!Number.isInteger(share) || share < 0 || !Number.isInteger(deposit) || deposit < 0 || !Number.isInteger(paid) || paid < 0) {
    throw new Error('authoritative_guest_money_unavailable');
  }
  return target === 'deposit' ? Math.max(0, Math.min(deposit, share) - paid) : Math.max(0, share - paid);
}

async function tx(pg, fn) {
  await pg.query('BEGIN');
  try {
    const answer = await fn(pg);
    await pg.query('COMMIT');
    return answer;
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (rollbackError) { err.rollback_error = rollbackError.message; }
    throw err;
  }
}

function validUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'https:' && (u.hostname === 'checkout.stripe.com' || u.hostname === 'billing.stripe.com');
  } catch (_) { return false; }
}

const LOCKED_GUEST_SQL = `SELECT bg.id::text AS booking_guest_id, bg.client_id::text AS client_id,
 bg.booking_id::text AS booking_id, bg.guest_number, bg.guest_name,
 bg.deposit_amount_cents, bg.metadata AS guest_metadata, b.booking_code,
 b.status::text AS booking_status, c.slug AS client_slug,
 COALESCE((SELECT SUM(p.amount_paid_cents) FROM payments p WHERE p.client_id=bg.client_id
 AND p.booking_id=bg.booking_id AND p.booking_guest_id=bg.id AND p.status='paid'),0)::bigint AS amount_paid_cents
 FROM booking_guests bg JOIN bookings b ON b.id=bg.booking_id JOIN clients c ON c.id=bg.client_id
 WHERE bg.id=$1::uuid AND c.slug=$2`;

async function lockAndLoad(pg, guestId, clientSlug) {
  const identity = await pg.query(`SELECT bg.booking_id::text AS booking_id FROM booking_guests bg
    JOIN clients c ON c.id=bg.client_id WHERE bg.id=$1::uuid AND c.slug=$2`, [guestId, clientSlug]);
  if (!identity.rows[0]) return null;
  await pg.query('SELECT id FROM bookings WHERE id=$1::uuid FOR UPDATE', [identity.rows[0].booking_id]);
  await pg.query('SELECT id FROM booking_guests WHERE id=$1::uuid AND booking_id=$2::uuid FOR UPDATE', [guestId, identity.rows[0].booking_id]);
  const loaded = await pg.query(LOCKED_GUEST_SQL, [guestId, clientSlug]);
  return loaded.rows[0] || null;
}

async function run(opts) {
  const { withPgClient, stripe, guestId, clientSlug, paymentTarget, actorId, successUrl, cancelUrl } = opts;
  const prepared = await withPgClient((pg) => tx(pg, async () => {
    const guest = await lockAndLoad(pg, guestId, clientSlug);
    if (!guest) return { missing: true };
    if (String(guest.booking_status).toLowerCase() === 'cancelled') throw new Error('booking_not_active');
    const amount = amountFor(guest, paymentTarget);
    const active = await pg.query(`SELECT id::text AS payment_id, status::text AS payment_status,
      stripe_checkout_session_id, checkout_url, expires_at, amount_due_cents, currency, metadata
      FROM payments WHERE client_id=$1::uuid AND booking_id=$2::uuid AND booking_guest_id=$3::uuid
      AND metadata->>'source'='bot_guest_payment_link_slice_a'
      AND status IN ('draft'::payment_record_status,'checkout_created'::payment_record_status)
      ORDER BY created_at, id FOR UPDATE`, [guest.client_id, guest.booking_id, guestId]);
    return { guest, amount, active: active.rows };
  }));
  if (prepared.missing) return prepared;
  if (prepared.amount <= 0) return { zero: true, guest: prepared.guest, amount: 0 };

  let reusable = null;
  const expired = [];
  for (const row of prepared.active) {
    if (!row.stripe_checkout_session_id) continue;
    const session = await stripe.checkout.sessions.retrieve(row.stripe_checkout_session_id);
    const md = metadata(row.metadata);
    const exact = md.payment_target === paymentTarget && Number(row.amount_due_cents) === prepared.amount
      && String(row.currency).toUpperCase() === 'EUR';
    const open = session.status === 'open' && (!session.expires_at || session.expires_at * 1000 > Date.now()) && validUrl(session.url);
    if (exact && open && !reusable) reusable = { row, session };
    else if (open) {
      await stripe.checkout.sessions.expire(session.id);
      expired.push(row.payment_id);
    } else expired.push(row.payment_id);
  }

  const draft = await withPgClient((pg) => tx(pg, async () => {
    const guest = await lockAndLoad(pg, guestId, clientSlug);
    if (!guest || guest.booking_id !== prepared.guest.booking_id || guest.client_id !== prepared.guest.client_id) throw new Error('guest_identity_changed');
    if (amountFor(guest, paymentTarget) !== prepared.amount) throw new Error('guest_payment_snapshot_changed_retry');
    if (expired.length) await pg.query(`UPDATE payments SET status='expired'::payment_record_status,
      metadata=metadata || $2::jsonb WHERE id=ANY($1::uuid[]) AND status IN ('draft','checkout_created')`,
    [expired, JSON.stringify({ superseded_at: new Date().toISOString(), superseded_target: paymentTarget })]);
    if (reusable) return { paymentId: reusable.row.payment_id, reusable: true, guest };
    const inserted = await pg.query(`INSERT INTO payments(client_id,booking_id,booking_guest_id,status,payment_kind,currency,amount_due_cents,metadata)
      VALUES($1::uuid,$2::uuid,$3::uuid,'draft'::payment_record_status,$4::payment_kind,'EUR',$5,$6::jsonb)
      ON CONFLICT (client_id,booking_id,booking_guest_id) WHERE metadata->>'source'='bot_guest_payment_link_slice_a'
      AND booking_guest_id IS NOT NULL AND status IN ('draft'::payment_record_status,'checkout_created'::payment_record_status)
      DO NOTHING RETURNING id::text AS payment_id`, [guest.client_id, guest.booking_id, guestId,
      paymentTarget === 'deposit' ? 'deposit_only' : 'full_amount', prepared.amount,
      JSON.stringify({ source: 'bot_guest_payment_link_slice_a', payment_target: paymentTarget, created_by: actorId })]);
    if (inserted.rows[0]) return { paymentId: inserted.rows[0].payment_id, guest };
    const winner = await pg.query(`SELECT id::text AS payment_id FROM payments WHERE client_id=$1::uuid AND booking_id=$2::uuid
      AND booking_guest_id=$3::uuid AND metadata->>'source'='bot_guest_payment_link_slice_a'
      AND status IN ('draft','checkout_created') ORDER BY created_at LIMIT 1`, [guest.client_id, guest.booking_id, guestId]);
    if (!winner.rows[0]) throw new Error('checkout_intent_conflict_without_winner');
    return { paymentId: winner.rows[0].payment_id, guest, conflict: true };
  }));

  if (draft.reusable) return { guest: draft.guest, amount: prepared.amount, paymentId: draft.paymentId,
    session: reusable.session, idempotent: true };

  const key = ['guest-checkout-v2', draft.guest.client_id, draft.guest.booking_id, guestId, draft.paymentId].join(':');
  let session;
  try {
    session = await stripe.checkout.sessions.create({ mode: 'payment', currency: 'eur',
      line_items: [{ price_data: { currency: 'eur', product_data: {
        name: `Booking ${draft.guest.booking_code} — ${draft.guest.guest_name}`,
        description: `${paymentTarget === 'deposit' ? 'Deposit' : 'Payment'} | Guest ${draft.guest.guest_number}`,
      }, unit_amount: prepared.amount }, quantity: 1 }],
      metadata: { client_slug: clientSlug, booking_id: draft.guest.booking_id, payment_id: draft.paymentId,
        booking_guest_id: guestId, payment_kind: paymentTarget === 'deposit' ? 'deposit_only' : 'full_amount' },
      success_url: successUrl, cancel_url: cancelUrl,
    }, { idempotencyKey: key });
    if (!session || !session.id || !validUrl(session.url)) throw new Error('stripe_checkout_url_invalid');
  } catch (err) {
    await withPgClient((pg) => tx(pg, () => pg.query(`UPDATE payments SET status='failed'::payment_record_status,
      metadata=metadata || $2::jsonb WHERE id=$1::uuid AND status='draft'::payment_record_status`,
    [draft.paymentId, JSON.stringify({ provider_failure: err.message, provider_failed_at: new Date().toISOString() })])));
    throw err;
  }

  await withPgClient((pg) => tx(pg, async () => {
    const guest = await lockAndLoad(pg, guestId, clientSlug);
    if (!guest || guest.booking_id !== draft.guest.booking_id || amountFor(guest, paymentTarget) !== prepared.amount) throw new Error('guest_payment_snapshot_changed_retry');
    const finalized = await pg.query(`UPDATE payments SET status='checkout_created'::payment_record_status,
      stripe_checkout_session_id=$1, checkout_url=$2, expires_at=to_timestamp($3),
      metadata=metadata || $4::jsonb WHERE id=$5::uuid AND client_id=$6::uuid AND booking_id=$7::uuid
      AND booking_guest_id=$8::uuid AND status='draft'::payment_record_status`, [session.id, session.url,
      session.expires_at || Math.floor(Date.now()/1000)+86400, JSON.stringify({ stripe_session_id: session.id }),
      draft.paymentId, guest.client_id, guest.booking_id, guestId]);
    if (finalized.rowCount !== 1) throw new Error('checkout_finalize_precondition_failed');
    const pointer = await pg.query(`UPDATE booking_guests SET payment_id=$1::uuid,payment_status='checkout_created',updated_at=NOW()
      WHERE id=$2::uuid AND client_id=$3::uuid AND booking_id=$4::uuid`, [draft.paymentId, guestId, guest.client_id, guest.booking_id]);
    if (pointer.rowCount !== 1) throw new Error('guest_pointer_finalize_precondition_failed');
  }));
  return { guest: draft.guest, amount: prepared.amount, paymentId: draft.paymentId, session, idempotent: false };
}

module.exports = { run, tx, amountFor, validUrl, lockAndLoad };
