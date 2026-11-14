#!/usr/bin/env node
'use strict';

// C15 producer-only proof: real create/prepare/link SQL; synthetic provider adapter.
// Reuse the existing reduced, network-fenced seed. No live DB or provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
const baseCreate = require('./lib/luna-front-desk-accommodation-booking-create-service');
const links = require('./lib/luna-front-desk-payment-link-service');
const baseline = process.argv.includes('--baseline');
const bRoot = process.argv.find(arg => arg.startsWith('--b-root='))?.slice(9);
const SLUG = 'wolfhouse-somo';

async function fixture(useB = false, beforeCommit = null) {
  const db = new PGlite();
  const calls = [];
  const pg = { async query(sql, params) {
    calls.push(String(sql).replace(/\s+/g, ' ').trim());
    return db.query(sql, params);
  } };
  try {
    const payload = { confirm: true, check_in: '2026-07-06', check_out: '2026-07-09',
      guest_count: 2, guest_name: 'Offline Lead', guests: [{ name: 'Offline Lead' }, { name: 'Offline Two' }],
      phone: '+999' + '88000601', package_code: 'package_none', room_type: 'shared',
      group_gender: 'mixed', selected_bed_codes: ['R3-B1', 'R3-B2'],
      ask_payment_amount: true, payment_link_distribution: 'together',
      ...(useB ? {} : { payment_choice: 'deposit' }) };
    await seedOfflineBookingDb(db, payload);
    await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations/136_wolfhouse_package_default_nights.sql'), 'utf8'));
    // Production payment transport/receipt columns omitted by the reduced seed.
    await db.exec(`ALTER TYPE payment_record_status ADD VALUE 'checkout_created';
      ALTER TYPE payment_record_status ADD VALUE 'paid';
      ALTER TYPE payment_record_status ADD VALUE 'cancelled';
      ALTER TABLE payments ADD COLUMN amount_paid_cents integer DEFAULT 0;
      ALTER TABLE payments ADD COLUMN stripe_checkout_session_id text;
      ALTER TABLE payments ADD COLUMN stripe_payment_intent_id text;
      ALTER TABLE payments ADD COLUMN checkout_url text;
      ALTER TABLE payments ADD COLUMN expires_at timestamptz;
      ALTER TABLE bookings ADD COLUMN amount_paid_cents integer DEFAULT 0;`);
    const create = useB ? require(path.resolve(bRoot, 'scripts/lib/luna-front-desk-accommodation-booking-create-service')) : baseCreate;
    const built = await create.buildWolfhouseBookingCreateCommand({ channel: create.BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
      trustedClientSlug: SLUG, transportBody: payload, pgClient: pg });
    assert.equal(built.ok, true, JSON.stringify(built.body));
    if (beforeCommit) await pg.query('BEGIN');
    const saved = await create.executeWolfhouseBookingCreate(pg, built.command, {
      callerManagedTransaction: !!beforeCommit, stripeConfig: { stripeLinksEnabled: false } });
    assert.equal(saved.ok, true, JSON.stringify(saved.body));
    if (beforeCommit) { await beforeCommit({ db, pg }); await pg.query('COMMIT'); }
    const booking = (await db.query('SELECT * FROM bookings')).rows[0];
    assert.ok(booking.id);
    assert.ok(calls.includes('COMMIT'), 'real Staff create must COMMIT before payment transition');
    const guests = (await db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows;
    assert.equal(guests.length, 2);
    return { db, pg, calls, booking, guests };
  } catch (error) { await db.close(); throw error; }
}

async function checkoutFull(mode) {
  const f = await fixture(mode === 'b-prepare');
  try {
    if (!baseline && mode !== 'legacy-draft') {
      const state = require('./lib/booking-payment-state');
      await f.pg.query('BEGIN');
      const pending = await state.transitionBookingPaymentIntent(f.pg, { bookingId: f.booking.id, clientSlug: SLUG,
        tier: 'unknown', distribution: 'together', paymentIds: [], source: 'offline_c15_pending' });
      assert.equal(pending.ok, true);
      assert.equal(pending.payment_intent.revision, 1);
      await f.pg.query('COMMIT');
    }
    let rows = (await f.db.query('SELECT * FROM payments')).rows;
    if (mode === 'b-prepare') {
      assert.equal(rows.length, 0, 'B pending save must not be assumed to contain an initial draft');
      const { prepareBookingPayment } = require(path.resolve(bRoot, 'scripts/lib/booking-payment-prepare'));
      const prepared = await prepareBookingPayment(f.pg, { bookingId: f.booking.id, clientSlug: SLUG,
        phone: f.booking.phone, choice: 'full', distribution: 'together' });
      assert.ok(prepared.payment_id);
      rows = (await f.db.query('SELECT * FROM payments')).rows;
    } else {
      assert.equal(rows.length, 1, 'A real create produces its fresh draft');
      assert.equal(rows[0].status, 'draft');
      // Explicit historical pending metadata, not an inferred default tier.
      await f.db.query(`UPDATE bookings SET metadata=metadata || $1::jsonb WHERE id=$2`,
        [JSON.stringify({ payment_choice_pending: true, ask_payment_amount: true }), f.booking.id]);
      if (mode === 'legacy-draft') {
        await f.db.query(`UPDATE payments SET created_at='2025-01-01', metadata=metadata || '{"legacy_fixture":true}'::jsonb
          WHERE id=$1`, [rows[0].id]);
      }
    }
    const paymentId = rows[0].id;
    if (!baseline) {
      const state = require('./lib/booking-payment-state');
      await f.pg.query('BEGIN');
      const result = await state.transitionBookingPaymentIntent(f.pg, { bookingId: f.booking.id, clientSlug: SLUG,
        tier: 'full', distribution: 'together', paymentIds: [paymentId], source: 'offline_c15_explicit_answer' });
      assert.equal(result.ok, true, JSON.stringify(result));
      await f.pg.query('COMMIT');
    }
    let providerCalls = 0;
    const linked = await links.createPaymentLink(f.pg, { target: 'draft_payment', paymentId,
      clientSlug: SLUG, trustedClientSlug: SLUG, channel: links.PAYMENT_LINK_CHANNELS.LUNA_WHATSAPP,
      trustedGuestPhone: f.booking.phone, actor: {}, paymentChoice: 'full' }, {
      staffActionsEnabled: true, stripeLinksEnabled: true, secretKey: 'offline-placeholder-not-a-credential',
      successUrl: 'https://offline.invalid/success', cancelUrl: 'https://offline.invalid/cancel',
      createStripeCheckoutSession: async request => {
        assert.equal(request.amountDueCents, f.booking.total_amount_cents, 'synthetic provider sees actual full cents');
        providerCalls++;
        return { id: 'offline-synthetic-session', url: 'https://checkout.stripe.com/offline-c15',
          livemode: false, payment_status: 'unpaid' };
      },
    });
    assert.equal(linked.ok, true, JSON.stringify(linked.body));
    assert.equal(providerCalls, 1);
    const booking = (await f.db.query('SELECT * FROM bookings')).rows[0];
    const payment = (await f.db.query('SELECT * FROM payments WHERE id=$1', [paymentId])).rows[0];
    assert.equal(booking.metadata.payment_intent?.tier, 'full', `${mode}: booking intent must transition with checkout`);
    assert.equal(booking.metadata.payment_intent.revision, mode === 'legacy-draft' ? 1 : 2);
    assert.equal(payment.metadata.payment_intent_revision, booking.metadata.payment_intent.revision);
    assert.equal(payment.payment_kind, 'full_amount');
    assert.equal(payment.amount_due_cents, booking.total_amount_cents);
    assert.equal(payment.status, 'checkout_created');
    assert.equal(booking.metadata.payment_choice_pending, false);
    assert.equal(booking.metadata.ask_payment_amount, false);
    assert.equal(booking.metadata.payment_distribution_pending, false);
    assert.equal(booking.metadata.ask_payment_distribution, false);
    assert.equal(booking.total_amount_cents, f.booking.total_amount_cents);
    assert.equal(booking.deposit_required_cents, f.booking.deposit_required_cents);
    assert.equal(booking.payment_status, f.booking.payment_status);
    const state = require('./lib/booking-payment-state');
    const since = f.calls.length;
    const dto = await state.readBookingPaymentState(f.pg, { bookingId: booking.id, clientSlug: SLUG });
    assert.equal(dto.booking.booking_id, booking.id);
    assert.equal(dto.intent_revision, booking.metadata.payment_intent.revision);
    assert.equal(dto.scope_state, 'verified');
    assert.deepEqual(dto.active_payment_ids, [paymentId]);
    assert.deepEqual(dto.covered_guest_ids.slice().sort(), f.guests.map(g => g.id).sort());
    assert.equal(dto.amount_due_cents, payment.amount_due_cents);
    assert.deepEqual(dto.current_links.map(link => link.payment_id), [paymentId]);
    assert.equal(dto.receipt_derived_status, 'not_paid', 'link creation is not payment receipt');
    assert.equal(dto.unresolved_operations, null, 'unknown outcomes are not invented as resolved');
    assert.equal(dto.legacy.ask_payment_amount, false);
    assert.ok(f.calls.slice(since).every(sql => sql.startsWith('SELECT ')), 'DTO performs read-only SQL');
    assert.deepEqual((await f.db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows, f.guests);
    assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM bookings')).rows[0].n, 1);
    assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM booking_beds')).rows[0].n, 2);
    console.log(`PASS ${mode}: real create COMMIT -> full checkout SQL -> independent intent/tier/amount/pending SELECT`);
  } finally { await f.db.close(); }
}

async function primarySaveControls() {
  const state = require('./lib/booking-payment-state');
  for (const fault of [false, true]) {
    let before;
    const f = await fixture(false, async ({ db, pg }) => {
      const booking = (await db.query('SELECT * FROM bookings')).rows[0];
      before = (await db.query('SELECT * FROM payments')).rows;
      if (fault) await db.exec(`CREATE FUNCTION c15_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic C15 intent fault' USING ERRCODE='P0001'; END; $$;
        CREATE TRIGGER c15_fault BEFORE UPDATE OF metadata ON bookings
        FOR EACH ROW EXECUTE FUNCTION c15_fail();`);
      const out = await state.transitionBookingPaymentIntent(pg, { bookingId: booking.id, clientSlug: SLUG,
        tier: fault ? 'full' : 'unknown', distribution: fault ? 'together' : 'unknown',
        paymentIds: fault ? [before[0].id] : [], source: 'offline_primary_save_control' });
      assert.equal(out.ok, !fault);
      if (fault) assert.equal(out.sqlstate, 'P0001');
    });
    try {
      assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM bookings')).rows[0].n, 1);
      assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM booking_beds')).rows[0].n, 2);
      assert.deepEqual((await f.db.query('SELECT * FROM payments')).rows, before,
        'unknown intent/fault cannot partially retarget or invent a payment');
      assert.equal(f.calls.filter(sql => sql === 'COMMIT').length, 1, 'caller commits actual new booking');
      assert.equal(f.calls.includes('ROLLBACK'), false);
      const dto = await state.readBookingPaymentState(f.pg, { bookingId: f.booking.id, clientSlug: SLUG });
      assert.equal(dto.amount_due_cents, null);
      assert.equal(dto.legacy.ask_payment_amount, true);
      assert.deepEqual(dto.active_payment_ids, []);
      console.log(`PASS primary INSERT/COMMIT: ${fault ? 'atomic intent SQL fault' : 'unknown tier/distribution'} never vetoes booking save`);
    } finally { await f.db.close(); }
  }
}

async function scopeAndReceiptControls() {
  const state = require('./lib/booking-payment-state');
  const f = await fixture();
  try {
    const scope = { bookingId: f.booking.id, clientSlug: SLUG };
    const draft = (await f.db.query('SELECT * FROM payments')).rows[0];
    // Synthetic receipt/security identities, persisted as actual SQL rows.
    const paid = (await f.db.query(`INSERT INTO payments(client_id,booking_id,booking_guest_id,status,payment_kind,
      currency,amount_due_cents,amount_paid_cents,metadata) VALUES($1,$2,$3,'paid','deposit_only','EUR',1000,1000,'{}') RETURNING *`,
    [f.booking.client_id, f.booking.id, f.guests[0].id])).rows[0];
    const other = (await f.db.query(`INSERT INTO bookings(client_id,booking_code,total_amount_cents,metadata)
      VALUES($1,'OFFLINE-FOREIGN-IDENTITY',12345,'{}') RETURNING id`, [f.booking.client_id])).rows[0];
    const foreign = (await f.db.query(`INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,
      amount_due_cents,metadata) VALUES($1,$2,'draft','full_amount','EUR',12345,'{}') RETURNING *`,
    [f.booking.client_id, other.id])).rows[0];
    await f.pg.query('BEGIN');
    const out = await state.transitionBookingPaymentIntent(f.pg, { ...scope, tier: 'full', distribution: 'together',
      paymentIds: [draft.id], source: 'offline_receipt_control' });
    assert.equal(out.ok, true);
    await f.pg.query('COMMIT');
    assert.equal((await f.db.query('SELECT amount_due_cents FROM payments WHERE id=$1', [draft.id])).rows[0].amount_due_cents,
      f.booking.total_amount_cents - paid.amount_paid_cents);
    const snapshot = (await f.db.query('SELECT * FROM payments ORDER BY id')).rows;
    const bookingBefore = (await f.db.query('SELECT * FROM bookings WHERE id=$1', [f.booking.id])).rows[0];
    for (const request of [
      { ...scope, paymentIds: [foreign.id] },
      { bookingId: other.id, clientSlug: SLUG, paymentIds: [draft.id] },
      { ...scope, clientSlug: 'unrelated-fixture', paymentIds: [draft.id] },
      { ...scope, distribution: 'separate', paymentIds: [draft.id] },
      { ...scope, paymentIds: [paid.id] },
    ]) {
      await f.pg.query('BEGIN');
      const rejected = await state.transitionBookingPaymentIntent(f.pg, { tier: 'full', distribution: 'together',
        source: 'offline_wrong_scope', ...request });
      assert.equal(rejected.ok, false);
      await f.pg.query('COMMIT');
    }
    assert.deepEqual((await f.db.query('SELECT * FROM payments ORDER BY id')).rows, snapshot);
    assert.deepEqual((await f.db.query('SELECT * FROM bookings WHERE id=$1', [f.booking.id])).rows[0], bookingBefore);
    assert.deepEqual(snapshot.find(p => p.id === paid.id), paid, 'real guest-specific receipt stays unchanged');
    assert.deepEqual(snapshot.find(p => p.id === foreign.id), foreign, 'foreign booking remains unchanged');
    // Stale aliases cannot become a competing authority on read.
    await f.db.query(`UPDATE bookings SET metadata=metadata || '{"ask_payment_amount":true,"payment_choice_pending":true}'::jsonb WHERE id=$1`, [f.booking.id]);
    const dto = await state.readBookingPaymentState(f.pg, scope);
    assert.equal(dto.legacy.ask_payment_amount, false);
    assert.deepEqual(dto.active_payment_ids, [draft.id]);
    assert.deepEqual(dto.receipts, [{ payment_id: paid.id, booking_guest_id: f.guests[0].id,
      amount_paid_cents: 1000, currency: 'EUR' }]);
    assert.equal(dto.receipt_derived_status, 'partially_paid');
    assert.equal(dto.current_links.length, 0, 'a draft is not a checkout URL');
    assert.equal((await state.readBookingPaymentState(f.pg, { ...scope, clientSlug: 'unrelated-fixture' })).ok, false);
    await f.db.query('UPDATE payments SET currency=$2 WHERE id=$1', [paid.id, 'USD']);
    assert.equal((await state.readBookingPaymentState(f.pg, scope)).received_cents, null,
      'foreign-currency receipts cannot be silently added to EUR terms');
    await f.db.query('UPDATE payments SET currency=$2 WHERE id=$1', [paid.id, 'EUR']);
    await f.db.query(`UPDATE bookings SET metadata=jsonb_set(metadata,'{payment_intent,revision}',
      to_jsonb(($2::int))) WHERE id=$1`, [f.booking.id, dto.intent_revision + 1]);
    assert.equal((await state.readBookingPaymentState(f.pg, scope)).scope_state, 'unresolved',
      'a mixed revision read cannot claim current checkout coverage');
    await f.db.query(`UPDATE bookings SET metadata=jsonb_set(metadata,'{payment_intent,revision}',
      to_jsonb(($2::int))) WHERE id=$1`, [f.booking.id, dto.intent_revision]);
    await f.db.query(`UPDATE bookings SET metadata=jsonb_set(metadata,'{payment_intent}',
      (metadata->'payment_intent') - 'active_payment_ids') WHERE id=$1`, [f.booking.id]);
    const malformed = await state.readBookingPaymentState(f.pg, scope);
    assert.equal(malformed.scope_state, 'unresolved', 'missing current references are unknown, not an empty verified scope');
    assert.equal(malformed.amount_due_cents, null);
    // Unknown money remains unknown, never Number(null)==0/nothing_due.
    await f.db.query('UPDATE bookings SET total_amount_cents=NULL WHERE id=$1', [f.booking.id]);
    await f.pg.query('BEGIN');
    const unknown = await state.transitionBookingPaymentIntent(f.pg, { ...scope, tier: 'full', distribution: 'together',
      paymentIds: [draft.id], source: 'offline_unknown_money' });
    assert.equal(unknown.reason_code, 'authoritative_payment_money_unknown');
    await f.pg.query('COMMIT');
    assert.deepEqual((await f.db.query('SELECT * FROM payments ORDER BY id')).rows, snapshot);
    console.log('PASS scope/receipts: exact Staff amount minus received; no cross-scope adoption/paid rewrite; stale aliases ignored; unknown money stays unknown');
  } finally { await f.db.close(); }
}

async function main() {
  const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
  if (selected === 'a-fresh-draft' || selected === 'legacy-draft' || selected === 'b-prepare') return checkoutFull(selected);
  if (selected === 'primary-save') return primarySaveControls();
  if (selected === 'scope-receipts') return scopeAndReceiptControls();
  // PGlite WASM allocations can outlive close(); isolate these small SQL groups.
  const cases = baseline ? ['a-fresh-draft'] : ['a-fresh-draft', 'legacy-draft',
    ...(bRoot ? ['b-prepare'] : []), 'primary-save', 'scope-receipts'];
  for (const testCase of cases) require('node:child_process').execFileSync(process.execPath,
    [__filename, `--case=${testCase}`, ...(baseline ? ['--baseline'] : []), ...(bRoot ? [`--b-root=${bRoot}`] : [])],
    { stdio: 'inherit' });
  if (!bRoot && !baseline) console.log('NOTE B reference proof requires --b-root=<read-only B checkout>; no suppressed draft is invented');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
