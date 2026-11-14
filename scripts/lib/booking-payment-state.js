'use strict';

// K3 Staff primitive, not a booking-admission hook or another payment ledger.
// Caller supplies an already-authorized tenant/booking and owns BEGIN/COMMIT.
// No provider calls, payment INSERTs, link retirement or payment-status writes.
const SLUG = 'wolfhouse-somo';
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
let sequence = 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const cents = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const sum = values => values.some(value => value == null) ? null
  : cents(values.reduce((total, value) => total + value, 0));

function deriveLegacyPaymentFlags(intent) {
  const tier = ['deposit', 'full'].includes(intent?.tier) ? intent.tier : null;
  const distribution = ['together', 'separate'].includes(intent?.distribution) ? intent.distribution : null;
  return { payment_choice: tier, payment_choice_pending: tier == null, ask_payment_amount: tier == null,
    payment_link_distribution: distribution, per_guest_payment_links: distribution === 'separate',
    payment_distribution_pending: distribution == null, ask_payment_distribution: distribution == null };
}

async function facts(pg, { bookingId, clientSlug }, lock = false) {
  if (clientSlug !== SLUG || !UUID.test(bookingId || '')) return null;
  const booking = (await pg.query(`SELECT b.*, c.slug AS client_slug FROM bookings b
    JOIN clients c ON c.id=b.client_id WHERE b.id=$1::uuid AND c.slug=$2${lock ? ' FOR UPDATE OF b' : ''}`,
  [bookingId, clientSlug])).rows[0];
  if (!booking) return null;
  const params = [booking.id, booking.client_id];
  const payments = (await pg.query(`SELECT * FROM payments WHERE booking_id=$1::uuid AND client_id=$2::uuid
    ORDER BY id${lock ? ' FOR UPDATE' : ''}`, params)).rows;
  const guests = (await pg.query(`SELECT * FROM booking_guests WHERE booking_id=$1::uuid AND client_id=$2::uuid
    ORDER BY guest_number`, params)).rows;
  return { booking, payments, guests };
}

function received(payments) {
  return sum(payments.filter(p => p.status === 'paid').map(p => p.currency === 'EUR' ? cents(p.amount_paid_cents) : null));
}

function due(f, tier, guestId = null) {
  if (!['deposit', 'full'].includes(tier)) return null;
  const guest = guestId && f.guests.find(g => g.id === guestId);
  if (guestId && !guest) return null;
  const total = cents(guest ? object(guest.metadata).subtotal_cents : f.booking.total_amount_cents);
  const deposit = cents(guest ? guest.deposit_amount_cents : f.booking.deposit_required_cents);
  const paid = received(guest ? f.payments.filter(p => p.booking_guest_id === guestId) : f.payments);
  // A booking receipt is not an allocation to a particular guest.
  const unallocated = guest && received(f.payments.filter(p => !p.booking_guest_id));
  if (total == null || paid == null || guest && (unallocated == null || unallocated > 0)
      || tier === 'deposit' && deposit == null) return null;
  return Math.max(0, (tier === 'deposit' ? Math.min(deposit, total) : total) - paid);
}

function rowInScope(f, row, distribution) {
  if (distribution === 'together') return !row.booking_guest_id
    && [undefined, 'booking'].includes(object(row.metadata).payment_scope);
  return distribution === 'separate' && f.guests.some(g => g.id === row.booking_guest_id);
}

// Read-only: current coverage comes only from explicit intent references verified
// against actual scoped rows, never the initial payment pointer/latest row/old URLs.
async function readBookingPaymentState(pg, scope) {
  const f = await facts(pg, scope);
  if (!f) return { ok: false, reason_code: 'booking_not_found' };
  const md = object(f.booking.metadata), candidate = object(md.payment_intent);
  const intent = Number.isSafeInteger(candidate.revision) && candidate.revision > 0 ? candidate : null;
  const flags = deriveLegacyPaymentFlags(intent);
  const ids = Array.isArray(intent?.active_payment_ids) ? intent.active_payment_ids : [];
  const current = ids.map(id => f.payments.find(p => p.id === id)).filter(p => p
    && rowInScope(f, p, intent?.distribution) && p.currency === 'EUR' && ['draft', 'checkout_created'].includes(p.status)
    && object(p.metadata).payment_intent_revision === intent?.revision
    && p.payment_kind === (intent?.tier === 'full' ? 'full_amount' : 'deposit_only')
    && (!p.expires_at || new Date(p.expires_at).getTime() > Date.now()));
  const verified = !!intent && Array.isArray(intent.active_payment_ids) && ids.every(id => UUID.test(id))
    && ['deposit', 'full'].includes(intent.tier)
    && ['together', 'separate'].includes(intent.distribution) && current.length === ids.length
    && new Set(ids).size === ids.length && (intent.distribution !== 'together' || current.length <= 1)
    && new Set(current.map(p => p.booking_guest_id)).size === current.length;
  const paid = received(f.payments), total = cents(f.booking.total_amount_cents);
  const deposit = cents(f.booking.deposit_required_cents);
  const status = paid == null || total == null ? 'unknown' : paid >= total ? 'paid'
    : deposit != null && paid >= Math.min(deposit, total) && paid > 0 ? 'deposit_paid'
      : paid > 0 ? 'partially_paid' : 'not_paid';
  const effective = verified ? current : [];
  const covered = effective.flatMap(p => p.booking_guest_id ? [p.booking_guest_id] : f.guests.map(g => g.id));
  return { ok: true,
    booking: { booking_id: f.booking.id, booking_code: f.booking.booking_code,
      client_id: f.booking.client_id, client_slug: f.booking.client_slug },
    payment_intent: intent, intent_revision: intent?.revision ?? null,
    collection_scope: flags.payment_link_distribution === 'together' ? 'booking'
      : flags.payment_link_distribution === 'separate' ? 'guest' : 'unknown',
    scope_state: verified ? 'verified' : 'unresolved',
    active_payment_ids: effective.map(p => p.id), covered_guest_ids: [...new Set(covered)],
    amount_due_cents: !verified ? null : current.length ? sum(current.map(p => cents(p.amount_due_cents)))
      : intent.distribution === 'together' ? due(f, intent.tier) : null,
    current_links: effective.filter(p => p.status === 'checkout_created' && p.checkout_url).map(p => ({
      payment_id: p.id, booking_guest_id: p.booking_guest_id || null,
      amount_due_cents: cents(p.amount_due_cents), currency: p.currency, url: p.checkout_url })),
    // C13 reconciliation belongs to its consumer/root; absence is unknown, not "no failures".
    unresolved_operations: Array.isArray(intent?.unresolved_operations) ? intent.unresolved_operations : null,
    receipt_derived_status: status, received_cents: paid, currency: 'EUR',
    receipts: f.payments.filter(p => p.status === 'paid').map(p => ({ payment_id: p.id,
      booking_guest_id: p.booking_guest_id || null, amount_paid_cents: cents(p.amount_paid_cents), currency: p.currency })),
    legacy: flags };
}

function invalid(reason) { const error = new Error(reason); error.reasonCode = reason; throw error; }

/**
 * Explicit transition over existing rows. SAVEPOINT makes its multiple UPDATEs
 * atomic inside the caller transaction, without committing/aborting primary save.
 * Unresolved facts return ok:false, not a booking-save veto. Unknown intent with
 * no selected payments is persistable and never requires a fresh draft to exist.
 */
async function transitionBookingPaymentIntent(pg, request) {
  const savepoint = `booking_payment_intent_${++sequence}`;
  const failed = error => ({ ok: false, reason_code: error.reasonCode || 'payment_intent_transition_failed',
    ...(error.code && /^[0-9A-Z]{5}$/.test(error.code) ? { sqlstate: error.code } : {}) });
  try { await pg.query(`SAVEPOINT ${savepoint}`); }
  catch (error) { return failed(error); }
  try {
    const { tier, distribution, source, paymentIds = [] } = request;
    if (!['deposit', 'full', 'unknown'].includes(tier)
      || !['together', 'separate', 'unknown'].includes(distribution)) invalid('invalid_payment_intent');
    if (typeof source !== 'string' || !source.trim() || source.length > 128) invalid('intent_provenance_required');
    if (!Array.isArray(paymentIds) || paymentIds.some(id => !UUID.test(id))
      || new Set(paymentIds).size !== paymentIds.length) invalid('invalid_payment_ids');
    const f = await facts(pg, request, true);
    if (!f) invalid('booking_not_found');
    const old = object(object(f.booking.metadata).payment_intent);
    if (Object.keys(old).length && (!Number.isSafeInteger(old.revision) || old.revision < 1)) invalid('intent_revision_unknown');
    const revision = (old.revision || 0) + 1;
    if (!Number.isSafeInteger(revision)) invalid('intent_revision_unknown');
    const selected = paymentIds.map(id => f.payments.find(p => p.id === id));
    if (selected.some(p => !p || !rowInScope(f, p, distribution)
      || !['draft', 'checkout_created'].includes(p.status) || p.currency !== 'EUR'
      || cents(p.amount_paid_cents) !== 0)) invalid('payment_scope_unverified');
    if (selected.length && (tier === 'unknown' || distribution === 'unknown'
      || distribution === 'together' && selected.length > 1
      || new Set(selected.map(p => p.booking_guest_id)).size !== selected.length)) invalid('payment_scope_conflict');
    const kind = tier === 'full' ? 'full_amount' : 'deposit_only';
    const amounts = selected.map(p => due(f, tier, p.booking_guest_id));
    if (amounts.some(amount => amount == null)) invalid('authoritative_payment_money_unknown');
    // Never retarget an issued/prepared provider operation to another amount.
    for (let i = 0; i < selected.length; i++) {
      const p = selected[i], md = object(p.metadata);
      const prepared = p.status !== 'draft' || p.checkout_url || p.stripe_checkout_session_id
        || p.stripe_payment_intent_id || ['provider_idempotency_key', 'idempotency_key', 'checkout_preparation',
          'stripe_checkout_session_id', 'stripe_session_id', 'checkout_url', 'payment_link_url'].some(key => md[key]);
      if (prepared && (p.payment_kind !== kind || cents(p.amount_due_cents) !== amounts[i])) invalid('prepared_payment_terms_mismatch');
    }
    for (let i = 0; i < selected.length; i++) {
      const updated = await pg.query(`UPDATE payments SET payment_kind=$4::payment_kind, amount_due_cents=$5,
        metadata=COALESCE(metadata, '{}'::jsonb) || $6::jsonb WHERE id=$1::uuid AND booking_id=$2::uuid AND client_id=$3::uuid RETURNING id`,
      [selected[i].id, f.booking.id, f.booking.client_id, kind, amounts[i], JSON.stringify({
        payment_choice: tier, payment_target: tier === 'full' ? 'balance' : 'deposit', payment_intent_revision: revision })]);
      if (updated.rows.length !== 1) invalid('payment_scope_changed');
    }
    const intent = { ...old, revision, tier, distribution,
      provenance: { source: source.trim() }, active_payment_ids: paymentIds };
    const updated = await pg.query(`UPDATE bookings SET metadata=COALESCE(metadata, '{}'::jsonb) || $3::jsonb
      WHERE id=$1::uuid AND client_id=$2::uuid RETURNING id`, [f.booking.id, f.booking.client_id,
      JSON.stringify({ payment_intent: intent, ...deriveLegacyPaymentFlags(intent) })]);
    if (updated.rows.length !== 1) invalid('booking_scope_changed');
    await pg.query(`RELEASE SAVEPOINT ${savepoint}`);
    return { ok: true, payment_intent: intent, legacy: deriveLegacyPaymentFlags(intent) };
  } catch (error) {
    await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await pg.query(`RELEASE SAVEPOINT ${savepoint}`);
    return failed(error);
  }
}

module.exports = { transitionBookingPaymentIntent, readBookingPaymentState, deriveLegacyPaymentFlags };
