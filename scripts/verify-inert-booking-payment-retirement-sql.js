'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite, seed, runScenario } = require('./verify-missing-payment-choice-always-saves');
const { createSqlStore } = require('./lib/per-guest-checkout');
async function main() {
  const db = new PGlite();
  try {
    await seed(db);
    await db.exec(`ALTER TYPE payment_record_status ADD VALUE 'paid'; ALTER TYPE payment_record_status ADD VALUE 'checkout_created'; ALTER TYPE payment_record_status ADD VALUE 'expired'; ALTER TABLE payments ADD COLUMN amount_paid_cents integer DEFAULT 0;`);
    await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations/107_per_guest_checkout_authoritative_intent.sql'), 'utf8'));
    const saved = await runScenario(db, '1701-separate', { payment_choice: 'deposit' }, false);
    const id = saved.created.body.booking_id;
    const initial = saved.related.payments[0];
    assert.equal(initial.amount_due_cents, 40000);
    const guests = saved.related.booking_guests;
    for (const guest of guests) {
      const prepared = await createSqlStore(fn => fn(db), guest.id, 'wolfhouse-somo', 'offline-proof', saved.saved.phone).prepare('deposit');
      assert.equal(prepared.amount, 20000);
    }
    const payments = (await db.query('SELECT * FROM payments WHERE booking_id=$1 ORDER BY id', [id])).rows;
    assert.equal(payments.length, 3, 'historical row must be retained, never deleted');
    const retired = payments.find(row => row.id === initial.id);
    assert.equal(retired.status, 'expired', '#1701: inert 40000 group draft must not coexist as collectible with 2x20000 personal drafts');
    assert.equal(retired.amount_due_cents, 40000, 'retirement preserves amount/history');
    assert.equal(retired.metadata.superseded_reason, 'separate_guest_collection');
    assert.deepEqual(payments.filter(row => row.status === 'draft').map(row => row.amount_due_cents), [20000, 20000]);
    console.log('PASS #1701 real SQL: 40000 initial draft expired (retained); only 2x20000 personal drafts collectible');
    const { retireInertInitialBookingDraft } = require('./lib/booking-payment-draft-retirement');
    await db.exec('ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text');
    const markers = [
      { status: 'paid', amount_paid_cents: 20000 },
      { status: 'checkout_created' },
      { amount_paid_cents: 1 },
      ...['stripe_checkout_session_id', 'checkout_url', 'stripe_payment_intent_id']
        .map(key => ({ [key]: `offline-${key}` })),
      ...['stripe_checkout_session_id', 'stripe_session_id', 'checkout_url', 'payment_link_url',
        'provider_idempotency_key', 'idempotency_key', 'checkout_preparation']
        .map(key => ({ metadata: { [key]: `offline-${key}` } })),
    ];
    for (const marker of markers) {
      const protectedRow = (await db.query(`INSERT INTO payments
        (client_id,booking_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents,
         stripe_checkout_session_id,checkout_url,stripe_payment_intent_id,metadata)
        VALUES($1,$2,$3::payment_record_status,'deposit_only','EUR',40000,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
      [saved.saved.client_id, id, marker.status || 'draft', marker.amount_paid_cents || 0,
        marker.stripe_checkout_session_id || null, marker.checkout_url || null, marker.stripe_payment_intent_id || null,
        JSON.stringify({ source: 'bot_booking_payment_prepare', payment_scope: 'booking', ...(marker.metadata || {}) })])).rows[0];
      const before = (await db.query('SELECT * FROM payments ORDER BY id')).rows;
      await db.query('BEGIN');
      await db.query('SELECT id FROM bookings WHERE id=$1 AND client_id=$2 FOR UPDATE', [id, saved.saved.client_id]);
      const retiredIds = await retireInertInitialBookingDraft(db, saved.saved.client_id, id);
      await db.query('COMMIT');
      assert.deepEqual(retiredIds, [], `protected marker must not retire: ${JSON.stringify(marker)}`);
      assert.deepEqual((await db.query('SELECT * FROM payments ORDER BY id')).rows, before,
        `paid/active/provider marker remains byte-for-byte, including ${protectedRow.id}`);
    }
    console.log(`PASS negative retirement SQL: ${markers.length} paid/active/provider-marker rows retained byte-for-byte`);
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
