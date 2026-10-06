'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const service = require('./lib/luna-front-desk-payment-link-service');
const { PGlite } = require('@electric-sql/pglite');
const { before, after, beforeEach } = require('node:test');
const { bookingLedgerInvoicePaidBalance } = require('./lib/booking-invoice-totals');
const BOOKING = '10000000-0000-4000-8000-000000000001';
let db;
let calls;
let execOpts;
before(async () => {
  // Simplified supporting schema; production service SQL executes without SQL doubles.
  db = new PGlite();
  await db.exec(`
    CREATE TYPE payment_record_status AS ENUM ('draft', 'checkout_created', 'paid', 'failed', 'expired', 'cancelled', 'pending');
    CREATE TYPE payment_kind AS ENUM ('deposit_only', 'full_amount');
    CREATE TABLE clients (id text PRIMARY KEY, slug text UNIQUE);
    -- Current production checkout reads Admin deposit rates inside its transaction.
    -- An omitted table poisons the transaction; empty rows exercise default rates.
    CREATE TABLE wh_pricing_rules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),client_slug text,
      item_type text,item_code text,season_code text,unit text,amount_cents int,currency text,active boolean);
    CREATE TABLE bookings (id uuid PRIMARY KEY, client_id text REFERENCES clients, booking_code text,
      guest_name text, status text, payment_status text, check_in date, check_out date, guest_count int,
      total_amount_cents int, amount_paid_cents int, balance_due_cents int, deposit_required_cents int,
      metadata jsonb DEFAULT '{}');
    CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id text REFERENCES clients,
      booking_id uuid REFERENCES bookings, booking_guest_id uuid, status payment_record_status,
      payment_kind payment_kind, currency text, amount_due_cents int, amount_paid_cents int DEFAULT 0,
      checkout_url text, stripe_checkout_session_id text, expires_at timestamptz, metadata jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now());
  `);
});
after(async () => { await db.close(); });
beforeEach(async () => {
  calls = [];
  await db.exec(`TRUNCATE payments, bookings, clients CASCADE;
    INSERT INTO clients VALUES ('wh', 'wolfhouse-somo');
    INSERT INTO bookings (id,client_id,booking_code,guest_name,status,payment_status,total_amount_cents,
      amount_paid_cents,balance_due_cents,deposit_required_cents)
    VALUES ('${BOOKING}','wh','WH-TOTALS','Fixture','confirmed','unpaid',100000,99000,1000,30000);`);
  execOpts = {
    staffActionsEnabled: true, stripeLinksEnabled: true, secretKey: 'sk_test_offline',
    successUrl: 'https://offline.invalid/success', cancelUrl: 'https://offline.invalid/cancel',
    loadBookingPaymentLedger: async (pg, booking) => {
      const paid = await pg.query(`SELECT COALESCE(sum(amount_paid_cents),0)::int AS paid FROM payments
        WHERE booking_id=$1 AND client_id=$2 AND status='paid'`, [booking.booking_id, booking.client_id]);
      return bookingLedgerInvoicePaidBalance(booking, 0, paid.rows[0].paid, 0, 0);
    },
    createStripeCheckoutSession: async (opts) => {
      calls.push(opts);
      return { id: 'cs_offline_' + calls.length, url: 'https://checkout.invalid/' + calls.length, livemode: false };
    },
  };
});
async function receipt(cents) {
  await db.query(`INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents)
    VALUES ('wh',$1,'paid','full_amount','EUR',$2,$2)`, [BOOKING, cents]);
}
async function create(body = {}, opts = {}, pg = db) {
  const built = build(body);
  assert.equal(built.ok, true);
  return service.createPaymentLink(pg, { ...built.command, ...opts }, execOpts);
}

async function seedCheckout(mutation = '') {
  await db.query(`INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,
    checkout_url,metadata) VALUES ('wh',$1,'checkout_created','deposit_only','EUR',30000,
    'https://checkout.invalid/existing','{"idempotency_key":"totals-1","payment_target":"deposit"}')`, [BOOKING]);
  if (mutation) await db.exec('UPDATE payments SET ' + mutation);
}
const UNSAFE_LINK_MUTATIONS = [
  "payment_kind='full_amount'", "metadata=jsonb_set(metadata,'{payment_target}','\"balance\"')",
  'amount_due_cents=12345', "status='cancelled'", "status='failed'", "status='paid'", 'amount_paid_cents=1',
  "currency='USD'", 'currency=NULL', `booking_guest_id='${BOOKING}'`,
  `metadata=metadata || '{"booking_guest_id":"${BOOKING}"}'::jsonb`,
  "expires_at=now()-interval '1 second'",
];

test('transactional retry validates every intent and actionability field on a just-arrived link', async () => {
  for (const mutation of UNSAFE_LINK_MUTATIONS) {
    await db.exec('DELETE FROM payments');
    let inserted = false;
    const pg = { query: async (sql, params) => {
      if (sql === 'BEGIN' && !inserted) {
        inserted = true;
        await seedCheckout(mutation);
      }
      return db.query(sql, params);
    } };
    const result = await create({ payment_target: 'deposit' }, {}, pg);
    assert.equal(result.ok, false, mutation);
    assert.equal(result.body.reason_code, 'idempotency_conflict', mutation);
    assert.equal(result.body.checkout_url, undefined);
    assert.equal(calls.length, 0);
  }
});

test('general active reuse applies the same complete booking intent predicate', async () => {
  for (const mutation of UNSAFE_LINK_MUTATIONS) {
    await db.exec('DELETE FROM payments');
    calls.length = 0;
    await seedCheckout(mutation);
    const result = await create({ payment_target: 'deposit', idempotency_key: 'new-key' });
    assert.equal(result.ok, true, mutation + JSON.stringify(result));
    assert.notEqual(result.body.checkout_url, 'https://checkout.invalid/existing', mutation);
    assert.equal(calls.length, 1, mutation);
  }
});

test('in-flight checkout blocks same and different keys before a second provider call', async () => {
  const provider = execOpts.createStripeCheckoutSession;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  execOpts.createStripeCheckoutSession = async (opts) => {
    const session = await provider(opts);
    if (calls.length === 1) { entered(); await gate; }
    return session;
  };
  const first = create({ payment_target: 'deposit' });
  await started;
  try {
    for (const key of ['totals-1', 'different-key']) {
      const retry = await create({ payment_target: 'deposit', idempotency_key: key });
      assert.equal(retry.ok, false, key);
      assert.equal(retry.body.reason_code, 'checkout_pending', key);
      assert.equal(retry.body.checkout_url, undefined);
    }
    assert.equal(calls.length, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM payments')).rows[0].n, 1);
  } finally { release(); await first; }
});

test('ambiguous provider failure preserves a blocking reservation across keys', async () => {
  execOpts.createStripeCheckoutSession = async (opts) => { calls.push(opts); throw new Error('timeout after provider accepted'); };
  const first = await create({ payment_target: 'deposit' });
  assert.equal(first.ok, false);
  assert.notEqual(first.body.no_db_write, true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payments')).rows[0].n, 1);
  for (const key of ['totals-1', 'different-key']) {
    const retry = await create({ payment_target: 'deposit', idempotency_key: key });
    assert.equal(retry.body.reason_code, 'checkout_pending');
    assert.equal(retry.body.checkout_url, undefined);
  }
  assert.equal(calls.length, 1);
});

test('missing ledger adapter fails closed without a provider call or payment row', async () => {
  delete execOpts.loadBookingPaymentLedger;
  const result = await create({ payment_target: 'deposit' });
  assert.equal(result.ok, false);
  assert.equal(result.body.reason_code, 'payment_ledger_unavailable');
  assert.equal(calls.length, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payments')).rows[0].n, 0);
});

test('finalization withholds URLs when authoritative booking or payment truth changed at the provider boundary', async () => {
  const provider = execOpts.createStripeCheckoutSession;
  for (const mutation of [
    "UPDATE bookings SET status='cancelled'", "UPDATE bookings SET status='expired'",
    'UPDATE bookings SET deposit_required_cents=20000', 'UPDATE bookings SET total_amount_cents=20000',
    'receipt', "UPDATE payments SET status='cancelled'", 'UPDATE payments SET amount_due_cents=1',
  ]) {
    await db.exec("DELETE FROM payments; UPDATE bookings SET status='confirmed',deposit_required_cents=30000,total_amount_cents=100000");
    calls.length = 0;
    execOpts.createStripeCheckoutSession = async (opts) => {
      const session = await provider(opts);
      if (mutation === 'receipt') await receipt(10000); else await db.exec(mutation);
      return session;
    };
    const result = await create({ payment_target: 'deposit' });
    assert.equal(result.ok, false, mutation);
    assert.equal(result.body.checkout_url, undefined, mutation);
    assert.equal(result.body.payment_link_url, undefined, mutation);
    assert.equal(calls.length, 1);
    const rows = (await db.query("SELECT * FROM payments WHERE metadata->>'source'='staff_payment_link'")).rows;
    assert.equal(rows.length, 1, mutation);
    assert.equal(rows[0].checkout_url, null, mutation);
    assert.equal(rows[0].metadata.checkout_preparation, 'pending', mutation);
  }
});

test('prepare and reused URLs recheck authoritative state instead of returning an earlier snapshot', async () => {
  for (const reuse of ['none', 'same-key', 'different-key']) {
    for (const mutation of ["UPDATE bookings SET status='cancelled'", 'UPDATE bookings SET deposit_required_cents=20000',
      'UPDATE bookings SET total_amount_cents=20000', 'receipt']) {
      await db.exec("DELETE FROM payments; UPDATE bookings SET status='confirmed',deposit_required_cents=30000,total_amount_cents=100000");
      calls.length = 0;
      if (reuse !== 'none') await seedCheckout();
      let changed = false;
      const pg = { query: async (sql, params) => {
        const result = await db.query(sql, params);
        if (!changed && /ORDER BY p.created_at DESC/.test(sql)) {
          changed = true;
          if (mutation === 'receipt') await receipt(10000); else await db.exec(mutation);
        }
        return result;
      } };
      const result = await create({ payment_target: 'deposit', idempotency_key: reuse === 'different-key' ? 'other' : 'totals-1' }, {}, pg);
      assert.equal(result.ok, false, reuse + ': ' + mutation);
      assert.equal(result.body.checkout_url, undefined);
      assert.equal(result.body.payment_link_url, undefined);
      assert.equal(calls.length, 0);
    }
  }
});

test('finalization persistence failure keeps the durable reservation and never exposes the provider URL', async () => {
  const pg = { query: async (sql, params) => {
    if (/UPDATE payments/.test(sql) && /checkout_created/.test(sql)) throw new Error('offline injected persistence failure');
    return db.query(sql, params);
  } };
  const result = await create({ payment_target: 'deposit' }, {}, pg);
  assert.equal(result.ok, false);
  assert.equal(result.body.checkout_url, undefined);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payments')).rows[0].n, 1);
  const retry = await create({ payment_target: 'deposit', idempotency_key: 'new-key' });
  assert.equal(retry.body.reason_code, 'checkout_pending');
  assert.equal(calls.length, 1);
});

function build(body = {}) {
  return service.buildPaymentLinkCommand({
    operation: service.PAYMENT_LINK_OPERATIONS.CREATE,
    channel: service.PAYMENT_LINK_CHANNELS.STAFF_PORTAL,
    trustedClientSlug: 'wolfhouse-somo',
    transportBody: { booking_code: 'WH-TOTALS', idempotency_key: 'totals-1', ...body },
  });
}

test('command carries a validated explicit payment target, defaulting only omission to balance', () => {
  assert.equal(build().command.paymentTarget, 'balance');
  assert.equal(build({ payment_target: 'deposit' }).command.paymentTarget, 'deposit');
  assert.equal(build({ payment_target: 'balance' }).command.paymentTarget, 'balance');
  for (const payment_target of [null, '', 'Deposit', 'guest', 0, {}, ['deposit']]) {
    const result = build({ payment_target });
    assert.equal(result.ok, false);
    assert.equal(result.body.reason_code, 'invalid_payment_target');
  }
  assert.equal(build({ payment_target: 'deposit', amount_due_cents: 1 }).body.reason_code, 'client_amount_rejected');
});

test('deposit is restricted to Wolfhouse staff booking scope before dispatch', async () => {
  for (const overrides of [
    { channel: service.PAYMENT_LINK_CHANNELS.LUNA_WHATSAPP },
    { channel: service.PAYMENT_LINK_CHANNELS.STAFF_SCHEDULE },
    { clientSlug: 'sunset-school', trustedClientSlug: 'sunset-school' },
    { paymentId: BOOKING }, { target: 'draft_payment' }, { target: 'guest' },
    { bookingGuestId: BOOKING },
  ]) {
    const result = await create({ payment_target: 'deposit' }, overrides);
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(calls.length, 0);
  }
  const result = await create({ payment_target: 'deposit', booking_guest_id: BOOKING });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payments')).rows[0].n, 0);
});

test('deposit checkout collects remaining deposit from actual receipts, not booking paid/balance projections', async () => {
  await receipt(10000);
  const result = await create({ payment_target: 'deposit' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.body.amount_due_cents, 20000);
  assert.equal(result.body.payment_target, 'deposit');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].amountDueCents, 20000);
  assert.equal(calls[0].metadata.payment_kind, 'deposit_only');
  assert.equal(calls[0].metadata.payment_target, 'deposit');
  const rows = (await db.query(`SELECT * FROM payments WHERE status='checkout_created'`)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payment_kind, 'deposit_only');
  assert.equal(rows[0].metadata.payment_target, 'deposit');
  assert.equal(rows[0].amount_due_cents, 20000);
  assert.equal(rows[0].booking_guest_id, null);
  assert.equal((await db.query('SELECT sum(amount_paid_cents)::int AS paid FROM payments')).rows[0].paid, 10000);
});

test('short-stay invoice ceiling preserves existing collection cap and settled/refund fences', async () => {
  await db.exec("UPDATE bookings SET check_in='2026-09-24',check_out='2026-09-26',guest_count=1,total_amount_cents=8000,deposit_required_cents=10000");
  for (const [paid,remaining] of [[0,8000],[3000,5000],[8000,0],[9000,0]]) {
    await db.exec('DELETE FROM payments');calls.length=0;
    if(paid)await receipt(paid);
    const result=await create({payment_target:'deposit',idempotency_key:'short-stay-'+paid});
    if(remaining){
      assert.equal(result.ok,true,JSON.stringify(result));
      assert.equal(result.body.amount_due_cents,remaining);
      assert.equal(calls.length,1);assert.equal(calls[0].amountDueCents,remaining);
    }else{
      assert.equal(result.ok,false);assert.equal(calls.length,0);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM payments WHERE status='checkout_created'")).rows[0].n,0);
    }
    assert.equal((await db.query("SELECT coalesce(sum(amount_paid_cents),0)::int AS paid FROM payments WHERE status='paid'")).rows[0].paid,paid);
  }
});

test('deposit rejects an unknown configuration instead of silently treating null as zero', async () => {
  await db.exec('UPDATE bookings SET deposit_required_cents=NULL');
  const result = await create({ payment_target: 'deposit' });
  assert.equal(result.body.reason_code, 'deposit_configuration_unknown');
  assert.equal(result.status, 422);
  assert.equal(calls.length, 0);
});

test('deposit requires an authoritative known invoice total', async () => {
  await db.exec('UPDATE bookings SET total_amount_cents=NULL');
  const result = await create({ payment_target: 'deposit' });
  assert.equal(result.body.reason_code, 'invoice_total_unknown');
  assert.equal(result.status, 422);
  assert.equal(calls.length, 0);
});

test('deposit rejects already covered deposit with a specific no-remaining-deposit result', async () => {
  await receipt(30000);
  const result = await create({ payment_target: 'deposit' });
  assert.equal(result.body.reason_code, 'no_deposit_due');
  assert.equal(result.status, 422);
  assert.equal(calls.length, 0);
});

test('deposit rejects overpayment even without a caller refund hint', async () => {
  await receipt(100001);
  const result = await create({ payment_target: 'deposit' });
  assert.equal(result.body.reason_code, 'refund_review_needed');
  assert.equal(result.status, 409);
  assert.equal(calls.length, 0);
});

test('balance and deposit never reuse each other even at identical amounts', async () => {
  for (const targets of [['balance', 'deposit'], ['deposit', 'balance']]) {
    await db.exec('DELETE FROM payments');
    calls.length = 0;
    const first = await create({ payment_target: targets[0], idempotency_key: 'first' }, { authoritativeBalanceDueCents: 30000 });
    const second = await create({ payment_target: targets[1], idempotency_key: 'second' }, { authoritativeBalanceDueCents: 30000 });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(calls.length, 2, targets.join(' -> '));
    assert.notEqual(first.body.payment_id, second.body.payment_id);
  }
});

test('same idempotency key cannot replay a mismatched or non-actionable checkout', async () => {
  for (const mutation of [
    "payment_kind='full_amount'",
    "metadata=jsonb_set(metadata,'{payment_target}','\"balance\"')",
    'amount_due_cents=12345',
    "status='cancelled'", "status='paid'", 'amount_paid_cents=1',
    "currency='USD'", `booking_guest_id='${BOOKING}'`,
    "expires_at=now()-interval '1 second'",
  ]) {
    await db.exec('DELETE FROM payments');
    calls.length = 0;
    const first = await create({ payment_target: 'deposit' });
    assert.equal(first.ok, true);
    await db.exec('UPDATE payments SET ' + mutation);
    const retry = await create({ payment_target: 'deposit' });
    assert.equal(retry.ok, false, mutation);
    assert.equal(retry.body.reason_code, 'idempotency_conflict', mutation);
    assert.equal(calls.length, 1, mutation);
    assert.equal(retry.body.checkout_url, undefined);
  }
});
