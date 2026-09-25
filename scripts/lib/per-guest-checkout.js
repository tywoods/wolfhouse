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

function reusableProviderSession(session, nowSeconds) {
  const paymentStatus = String(session && session.payment_status || '').toLowerCase();
  return !!(session && session.id && session.status === 'open'
    && paymentStatus === 'unpaid'
    && validUrl(session.url) && Number(session.expires_at) > nowSeconds);
}

function obsoleteProviderSession(session) {
  const err = new Error('stripe_checkout_session_not_payable');
  err.providerObsolete = true;
  err.session = session || null;
  return err;
}

function blockedProviderSession(session) {
  const err = new Error('guest_payment_provider_state_blocked');
  err.providerBlocked = true;
  err.httpStatus = 409;
  err.publicMessage = 'Payment may already be processing. Refresh payment status before creating another link.';
  err.session = session || null;
  return err;
}

function definitelyUnpaidObsoleteSession(session, nowSeconds) {
  const status = String(session && session.status || '').toLowerCase();
  const paymentStatus = String(session && session.payment_status || '').toLowerCase();
  if (paymentStatus !== 'unpaid') return false;
  if (status === 'expired' || status === 'canceled' || status === 'cancelled') return true;
  return status === 'open' && Number(session.expires_at) <= nowSeconds;
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

function operationFromRow(row) {
  const md = metadata(row.metadata);
  const target = md.intent_target || md.payment_target;
  const amount = Number(md.intent_amount_cents != null ? md.intent_amount_cents : row.amount_due_cents);
  const currency = String(md.intent_currency || row.currency || '').toUpperCase();
  const generation = String(md.intent_generation || row.payment_id);
  return { paymentId: row.payment_id, target, amount, currency, generation,
    key: md.provider_idempotency_key || ['guest-checkout-v3', generation, target, amount, currency].join(':'),
    sessionId: row.stripe_checkout_session_id || null, url: row.checkout_url || null };
}

function sameIntent(op, target, amount) {
  return op.target === target && op.amount === amount && op.currency === 'EUR';
}

function createSqlStore(withPgClient, guestId, clientSlug, actorId) {
  return {
    async prepare(target) {
      return withPgClient((pg) => tx(pg, async () => {
        const guest = await lockAndLoad(pg, guestId, clientSlug);
        if (!guest) return { missing: true };
        if (String(guest.booking_status).toLowerCase() === 'cancelled') throw new Error('booking_not_active');
        const amount = amountFor(guest, target);
        if (amount <= 0) return { zero: true, guest, amount: 0 };
        const active = await pg.query(`SELECT id::text AS payment_id,stripe_checkout_session_id,checkout_url,
          amount_due_cents,currency,metadata FROM payments WHERE client_id=$1::uuid AND booking_id=$2::uuid
          AND booking_guest_id=$3::uuid AND metadata->>'source'='bot_guest_payment_link_slice_a'
          AND status IN ('draft','checkout_created') ORDER BY created_at,id LIMIT 1 FOR UPDATE`,
        [guest.client_id, guest.booking_id, guestId]);
        let row = active.rows[0];
        if (!row) {
          const inserted = await pg.query(`INSERT INTO payments(client_id,booking_id,booking_guest_id,status,payment_kind,currency,amount_due_cents,metadata)
            VALUES($1::uuid,$2::uuid,$3::uuid,'draft'::payment_record_status,$4::payment_kind,'EUR',$5,$6::jsonb)
            ON CONFLICT (client_id,booking_id,booking_guest_id) WHERE metadata->>'source'='bot_guest_payment_link_slice_a'
            AND booking_guest_id IS NOT NULL AND status IN ('draft'::payment_record_status,'checkout_created'::payment_record_status)
            DO NOTHING RETURNING id::text AS payment_id,amount_due_cents,currency,metadata,stripe_checkout_session_id,checkout_url`,
          [guest.client_id, guest.booking_id, guestId, target === 'deposit' ? 'deposit_only' : 'full_amount', amount,
            JSON.stringify({ source: 'bot_guest_payment_link_slice_a', payment_target: target, created_by: actorId })]);
          row = inserted.rows[0];
          if (!row) {
            const winner = await pg.query(`SELECT id::text AS payment_id,stripe_checkout_session_id,checkout_url,
              amount_due_cents,currency,metadata FROM payments WHERE client_id=$1::uuid AND booking_id=$2::uuid
              AND booking_guest_id=$3::uuid AND metadata->>'source'='bot_guest_payment_link_slice_a'
              AND status IN ('draft','checkout_created') ORDER BY created_at,id LIMIT 1 FOR UPDATE`,
            [guest.client_id, guest.booking_id, guestId]);
            row = winner.rows[0];
          }
        }
        if (!row) throw new Error('checkout_intent_conflict_without_winner');
        let op = operationFromRow(row);
        /* Persist exact provider identity before the first provider call. */
        if (!metadata(row.metadata).provider_idempotency_key) {
          const durable = { intent_generation: op.generation, intent_target: op.target,
            intent_amount_cents: op.amount, intent_currency: op.currency, provider_idempotency_key: op.key };
          await pg.query('UPDATE payments SET metadata=metadata || $2::jsonb WHERE id=$1::uuid',
            [op.paymentId, JSON.stringify(durable)]);
          op = Object.assign(op, { key: durable.provider_idempotency_key });
        }
        return { guest, amount, operation: op, authoritative: sameIntent(op, target, amount) };
      }));
    },
    async finalize(op, session, target, amount) {
      return withPgClient((pg) => tx(pg, async () => {
        const guest = await lockAndLoad(pg, guestId, clientSlug);
        if (!guest || amountFor(guest, target) !== amount) { const e = new Error('guest_payment_snapshot_changed_retry'); e.snapshotChanged = true; throw e; }
        const finalized = await pg.query(`UPDATE payments SET status='checkout_created'::payment_record_status,
          stripe_checkout_session_id=$1,checkout_url=$2,expires_at=to_timestamp($3),metadata=metadata || $4::jsonb
          WHERE id=$5::uuid AND status IN ('draft','checkout_created') AND metadata->>'provider_idempotency_key'=$6`,
        [session.id, session.url, session.expires_at || Math.floor(Date.now()/1000)+86400,
          JSON.stringify({ stripe_session_id: session.id }), op.paymentId, op.key]);
        if (finalized.rowCount !== 1) throw new Error('checkout_finalize_precondition_failed');
        const pointer = await pg.query(`UPDATE booking_guests SET payment_id=$1::uuid,payment_status='checkout_created',updated_at=NOW()
          WHERE id=$2::uuid AND client_id=$3::uuid AND booking_id=$4::uuid`,
        [op.paymentId, guestId, guest.client_id, guest.booking_id]);
        if (pointer.rowCount !== 1) throw new Error('guest_pointer_finalize_precondition_failed');
        return guest;
      }));
    },
    async retire(op, reason) {
      return withPgClient((pg) => tx(pg, () => pg.query(`UPDATE payments SET status='expired'::payment_record_status,
        metadata=metadata || $2::jsonb WHERE id=$1::uuid AND status IN ('draft','checkout_created')
        AND metadata->>'provider_idempotency_key'=$3`, [op.paymentId,
        JSON.stringify({ superseded_at: new Date().toISOString(), superseded_reason: reason }), op.key])));
    },
  };
}

function providerParams(item, guest, clientSlug, guestId, successUrl, cancelUrl) {
  return { mode: 'payment', currency: item.currency.toLowerCase(),
    line_items: [{ price_data: { currency: item.currency.toLowerCase(), product_data: {
      name: `Booking ${guest.booking_code} — ${guest.guest_name}`,
      description: `${item.target === 'deposit' ? 'Deposit' : 'Payment'} | Guest ${guest.guest_number}`,
    }, unit_amount: item.amount }, quantity: 1 }],
    metadata: { client_slug: clientSlug, booking_id: guest.booking_id, payment_id: item.paymentId,
      booking_guest_id: guestId, payment_kind: item.target === 'deposit' ? 'deposit_only' : 'full_amount',
      intent_generation: item.generation }, success_url: successUrl, cancel_url: cancelUrl };
}

async function recoverProvider(stripe, op, guest, opts) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (op.sessionId) {
    // Never mint a replacement while the state of an existing provider
    // identity is unknown; retrieval failures propagate and fail closed.
    const known = await stripe.checkout.sessions.retrieve(op.sessionId);
    if (reusableProviderSession(known, nowSeconds)) return known;
    if (definitelyUnpaidObsoleteSession(known, nowSeconds)) throw obsoleteProviderSession(known);
    throw blockedProviderSession(known);
  }
  /* Create is deliberately replayed when DB lacks the session id: Stripe's
     durable idempotency record is the recovery log for provider-success/DB-failure. */
  const session = await stripe.checkout.sessions.create(
    providerParams(op, guest, opts.clientSlug, opts.guestId, opts.successUrl, opts.cancelUrl),
    { idempotencyKey: op.key });
  if (!reusableProviderSession(session, nowSeconds)) throw blockedProviderSession(session);
  return session;
}

async function expireIfOpen(stripe, session) {
  if (session && session.id && session.status === 'open') await stripe.checkout.sessions.expire(session.id);
}

async function run(opts) {
  const { stripe, guestId, clientSlug, paymentTarget } = opts;
  const store = opts.store || createSqlStore(opts.withPgClient, guestId, clientSlug, opts.actorId);
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const prepared = await store.prepare(paymentTarget);
    if (prepared.missing || prepared.zero) return prepared;
    const op = prepared.operation;
    let session;
    try { session = await recoverProvider(stripe, op, prepared.guest, opts); }
    catch (err) {
      lastError = err;
      if (err.providerObsolete) {
        await expireIfOpen(stripe, err.session);
        await store.retire(op, 'provider_session_not_payable');
      } else if (err.providerBlocked) {
        throw err;
      }
      continue;
    }

    if (!prepared.authoritative) {
      await expireIfOpen(stripe, session);
      await store.retire(op, 'intent_mismatch');
      continue;
    }
    try {
      const guest = await store.finalize(op, session, paymentTarget, prepared.amount);
      return { guest: guest || prepared.guest, amount: prepared.amount, paymentId: op.paymentId,
        session, idempotent: !!op.sessionId || attempt > 0 };
    } catch (err) {
      lastError = err;
      if (err.snapshotChanged) {
        await expireIfOpen(stripe, session);
        await store.retire(op, 'snapshot_changed');
      }
      /* Query/commit ambiguity is retried through prepare + the exact same key. */
    }
  }
  throw lastError || new Error('checkout_recovery_exhausted');
}

module.exports = { run, tx, amountFor, validUrl, lockAndLoad, operationFromRow,
  sameIntent, reusableProviderSession, definitelyUnpaidObsoleteSession, createSqlStore, providerParams, recoverProvider };
