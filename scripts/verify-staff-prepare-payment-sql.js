'use strict';
const assert = require('node:assert/strict');
const { PGlite, seed, runScenario } = require('./verify-missing-payment-choice-always-saves');
const routes = require('./lib/staff-bot-v2-routes');
const PHONE = '+99900001682';
async function main() {
  const db = new PGlite();
  try {
    await seed(db);
    await db.exec(`ALTER TYPE payment_record_status ADD VALUE 'paid'; ALTER TYPE payment_record_status ADD VALUE 'checkout_created'; ALTER TYPE payment_record_status ADD VALUE 'expired'; ALTER TABLE payments ADD COLUMN amount_paid_cents integer DEFAULT 0;`);
    const logs = [];
    const originalLog = console.log;
    let saved;
    try {
      console.log = (...args) => { logs.push(args.join(' ')); originalLog(...args); };
      saved = await runScenario(db, 'prepare-pending', {}, true);
    } finally { console.log = originalLog; }
    assert.match(logs.find(line => line.startsWith('SQL ')), /payments=0,/, 'SQL evidence must log the actual saved payment count');
    const id = saved.created.body.booking_id;
    await db.query('UPDATE bookings SET phone=$1 WHERE id=$2', [PHONE, id]);
    assert.equal(typeof routes.handleBotBookingPreparePayment, 'function', 'Staff must expose booking-scoped prepare-payment after a pending save');
    const apiSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'staff-query-api.js'), 'utf8');
    assert.ok(apiSource.includes("pathname === '/staff/bot/payments/prepare'"), 'authenticated HTTP prepare route must be registered');
    const { actualApiFunction } = require('./verify-package-minimum-transport');
    async function request(body, headers = {}, extra = {}) {
      let response;
      const ctx = {
        boundClientSlug: 'wolfhouse-somo', STAFF_ACTIONS_ENABLED: true,
        readBody: async () => JSON.stringify({ booking_id: id, ...body }),
        sendJSON: (_res, status, payload) => { response = { status, body: payload }; return response; },
        withPgClient: fn => fn(db), resolveAutomaticBookingAdmission: async () => ({ allowed: true }), ...extra,
      };
      const handle = actualApiFunction('handleBotBookingPreparePayment', {
        ...ctx, _handleBotBookingPreparePayment: routes.handleBotBookingPreparePayment,
        resolveWolfhouseAutomaticBookingAdmission: ctx.resolveAutomaticBookingAdmission,
      });
      await handle({ _botBoundClientSlug: ctx.boundClientSlug, headers: { 'x-luna-guest-phone': PHONE, ...headers } }, {}, null, 'bot_token');
      return response;
    }
    const first = await request({ payment_choice: 'deposit' });
    assert.equal(first.status, 200, JSON.stringify(first));
    assert.equal(first.body.amount_due_cents, saved.saved.deposit_required_cents);
    assert.equal(first.body.creates_stripe_link, false);
    const retry = await request({ payment_choice: 'deposit' });
    assert.equal(retry.body.payment_id, first.body.payment_id);
    assert.equal(retry.body.idempotent, true);
    assert.equal((await db.query('SELECT count(*)::int n FROM payments WHERE booking_id=$1', [id])).rows[0].n, 1);
    console.log('PASS pending save -> explicit deposit preparation -> same payment id on retry (real SQL)');
    const full = await request({ payment_choice: 'full', amount_due_cents: 1, client_slug: 'forged' });
    assert.equal(full.status, 200, JSON.stringify(full));
    assert.equal(full.body.amount_due_cents, saved.saved.total_amount_cents, 'explicit full retargets only an inert draft using saved money');
    assert.equal(full.body.payment_id, first.body.payment_id);
    const metadata = (await db.query('SELECT metadata FROM bookings WHERE id=$1', [id])).rows[0].metadata;
    assert.equal(metadata.payment_choice, 'full');
    assert.equal(metadata.payment_choice_pending, false);
    console.log('PASS explicit full uses saved amount, reuses inert draft and clears pending metadata');
    for (const marker of [
      { status: 'checkout_created', stripe_checkout_session_id: 'cs_test_offline' },
      { status: 'draft', metadata: { provider_idempotency_key: 'offline-unresolved' } },
      { status: 'draft', checkout_url: 'https://checkout.stripe.com/offline' },
    ]) {
      await db.query(`UPDATE payments SET status=$2::payment_record_status, stripe_checkout_session_id=$3,
        checkout_url=$4,metadata=$5::jsonb WHERE id=$1`, [first.body.payment_id, marker.status,
        marker.stripe_checkout_session_id || null, marker.checkout_url || null,
        JSON.stringify({ source: 'bot_booking_payment_prepare', ...(marker.metadata || {}) })]);
      const before = (await db.query('SELECT * FROM payments ORDER BY id')).rows;
      const blocked = await request({ payment_choice: 'deposit' });
      assert.equal(blocked.status, 409, 'active/unresolved checkout must not be retargeted or duplicated');
      assert.deepEqual((await db.query('SELECT * FROM payments ORDER BY id')).rows, before);
    }
    console.log('PASS active/provider-unresolved rows retained byte-for-byte, conflicting choice blocked');
    await db.query(`UPDATE payments SET status='paid',amount_paid_cents=20000 WHERE id=$1`, [first.body.payment_id]);
    const paidBefore = (await db.query('SELECT * FROM payments WHERE id=$1', [first.body.payment_id])).rows[0];
    const remaining = await request({ payment_choice: 'full' });
    assert.equal(remaining.status, 200, JSON.stringify(remaining));
    assert.equal(remaining.body.amount_due_cents, saved.saved.total_amount_cents - 20000, 'already paid money must not be collected twice');
    assert.notEqual(remaining.body.payment_id, first.body.payment_id);
    assert.deepEqual((await db.query('SELECT * FROM payments WHERE id=$1', [first.body.payment_id])).rows[0], paidBefore);
    console.log('PASS paid receipt preserved; full prepares only unpaid balance');
    for (const md of [{ source: 'addon_service', payment_scope: 'addon_service' }, { source: 'unknown_import' }]) {
      await db.query('UPDATE payments SET metadata=$2::jsonb WHERE id=$1', [remaining.body.payment_id, JSON.stringify(md)]);
      const before = (await db.query('SELECT * FROM payments ORDER BY id')).rows;
      const result = await request({ payment_choice: 'deposit' });
      assert.equal(result.status, 409, 'unrecognized or non-booking payment must not be stolen');
      assert.deepEqual((await db.query('SELECT * FROM payments ORDER BY id')).rows, before);
    }
    console.log('PASS non-booking/unknown drafts cannot be repurposed');
    const snapshot = async () => ({ payments: (await db.query('SELECT * FROM payments ORDER BY id')).rows,
      bookings: (await db.query('SELECT * FROM bookings ORDER BY id')).rows });
    const secured = await snapshot();
    for (const choice of [undefined, '', 'unspecified', 'together', 'separate', 'balance']) {
      assert.equal((await request({ payment_choice: choice })).status, 400);
    }
    assert.equal((await request({ payment_choice: 'full' }, { 'x-luna-guest-phone': '+99900009999' })).status, 404);
    assert.equal((await request({ payment_choice: 'full' }, {}, { boundClientSlug: 'other-tenant' })).status, 404);
    assert.equal((await request({ payment_choice: 'full' }, {}, { boundClientSlug: '' })).status, 403);
    assert.equal((await request({ payment_choice: 'full' }, {}, { resolveAutomaticBookingAdmission: async () => ({ allowed: false, reason: 'paused' }) })).status, 403);
    assert.equal((await request({ payment_choice: 'full' }, {}, { STAFF_ACTIONS_ENABLED: false })).status, 403);
    assert.deepEqual(await snapshot(), secured);
    console.log('PASS missing choice, cross-guest/tenant, unbound, policy denied and disabled: no writes');
    await db.query(`UPDATE payments SET metadata='{"source":"bot_booking_payment_prepare"}' WHERE id=$1`, [remaining.body.payment_id]);
    const separated = await request({ payment_choice: 'deposit', payment_link_distribution: 'separate' });
    assert.equal(separated.status, 200, JSON.stringify(separated));
    assert.equal(separated.body.payment_id, null, 'separate selection must not return/create a group payment');
    assert.deepEqual(separated.body.retired_payment_ids, [remaining.body.payment_id]);
    assert.equal((await db.query('SELECT status FROM payments WHERE id=$1', [remaining.body.payment_id])).rows[0].status, 'expired');
    console.log('PASS explicit separate selection retires inert group draft, never returns group checkout id');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
