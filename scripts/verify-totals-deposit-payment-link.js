'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const service = require('./lib/luna-front-desk-payment-link-service');
const { PGlite } = require('@electric-sql/pglite');
const { before, after, beforeEach } = require('node:test');
const { bookingLedgerInvoicePaidBalance } = require('./lib/booking-invoice-totals');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
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
    assert.equal(result.body.reason_code,
      mutation === `booking_guest_id='${BOOKING}'`
        ? 'booking_payment_guest_checkout_active'
        : 'idempotency_conflict', mutation);
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
    if (mutation === `booking_guest_id='${BOOKING}'`) {
      assert.equal(result.ok, false, mutation + JSON.stringify(result));
      assert.equal(result.body.reason_code, 'booking_payment_guest_checkout_active', mutation);
      assert.equal(result.body.checkout_url, undefined, mutation);
      assert.equal(calls.length, 0, mutation);
    } else {
      assert.equal(result.ok, true, mutation + JSON.stringify(result));
      assert.notEqual(result.body.checkout_url, 'https://checkout.invalid/existing', mutation);
      assert.equal(calls.length, 1, mutation);
    }
  }
});

test('in-flight exact recovery serializes a different key onto the one finalized checkout', async () => {
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
    const recovered = await create({ payment_target: 'deposit', idempotency_key: 'totals-1' });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.body.payment_id, (await db.query('SELECT id::text FROM payments')).rows[0].id);
    const overlap = await create({ payment_target: 'deposit', idempotency_key: 'different-key' });
    assert.equal(overlap.ok, true);
    assert.equal(overlap.body.checkout_url, recovered.body.checkout_url,
      'different operation may only reuse the checkout finalized by exact-intent recovery');
    assert.equal(calls.length, 2, 'same Stripe idempotency key is reissued; different intent never reaches provider');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM payments')).rows[0].n, 1);
  } finally { release(); await first; }
});

test('ambiguous provider failure retries its exact reservation and blocks other keys', async () => {
  execOpts.createStripeCheckoutSession = async (opts) => { calls.push(opts); throw new Error('timeout after provider accepted'); };
  const first = await create({ payment_target: 'deposit' });
  assert.equal(first.ok, false);
  assert.notEqual(first.body.no_db_write, true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payments')).rows[0].n, 1);
  const retry = await create({ payment_target: 'deposit', idempotency_key: 'totals-1' });
  assert.equal(retry.body.reason_code, 'checkout_pending');
  assert.equal(retry.body.checkout_url, undefined);
  const overlap = await create({ payment_target: 'deposit', idempotency_key: 'different-key' });
  assert.equal(overlap.body.reason_code, 'checkout_pending');
  assert.equal(overlap.body.checkout_url, undefined);
  assert.equal(calls.length, 2);
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

// Phase2A: execute the actual booking-context function, with explicit read-only
// SQL adapters for the minimal disposable schema. Non-financial presentation
// dependencies are fixtures, not alternative financial implementations.
async function financialContext(client = 'wolfhouse-somo') {
  const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  const actualRequire = createRequire(path.join(__dirname, 'staff-query-api.js'));
  const extract = name => {
    const start = source.indexOf('function ' + name + '(');
    assert(start >= 0, name + ' exists');
    const begin = source.slice(start - 6, start) === 'async ' ? start - 6 : start;
    return source.slice(begin, source.indexOf('\n}', start) + 2);
  };
  const readQueries = [];
  const pg = { query: async (sql, params) => {
    assert.match(sql, /^\s*SELECT\b/i, 'booking-context must not write');
    readQueries.push(sql);
    if (/FROM wh_pricing_rules/.test(sql)) {
      assert.deepEqual(Array.from(params), ['wolfhouse-somo'], 'pricing tenant retained');
      return db.query(sql, params);
    }
    assert.deepEqual(Array.from(params), [client, 'WH-TOTALS'], 'tenant and booking parameters retained');
    return db.query(sql, params);
  } };
  const empty = 'SELECT 1 WHERE false AND $1::text IS NOT NULL AND $2::text IS NOT NULL';
  const sandbox = {
    ...require('./lib/booking-guests'),
    ...require('./lib/staff-guest-room-state'),
    ...require('./lib/booking-invoice-totals'),
    ...require('./lib/staff-booking-services-schedule'),
    Date, Number, String, Set,
    require: spec => spec === './lib/staff-transfer-pricing'
      ? { loadStaffTransferConfig: async () => ({}) } : actualRequire(spec),
    DEFAULT_CLIENT: 'wolfhouse-somo', SQL_INJECT_RE: /[;']/,
    withPgClient: fn => fn(pg), resolveStoredWolfhouseBookingCode: async (_pg, _client, code) => code,
    getBookingDetailQuery: () => `SELECT b.*,b.id::text AS booking_id,
      b.check_in::text AS check_in,b.check_out::text AS check_out
      FROM bookings b JOIN clients c ON c.id=b.client_id WHERE c.slug=$1 AND b.booking_code=$2`,
    BOOKING_PAYMENTS_LEDGER_SQL: `SELECT p.*,p.status::text AS payment_status,
      (p.client_id=b.client_id) AS display_eligible FROM payments p
      JOIN bookings b ON b.id=p.booking_id JOIN clients c ON c.id=b.client_id
      WHERE c.slug=$1 AND b.booking_code=$2`,
    BOOKING_CONTEXT_ROOMING_SQL: empty, BOOKING_GUESTS_SELECT_SQL: empty,
    getBookingConversationQuery: () => empty, getBookingHandoffQuery: () => empty,
    getBookingAddOnSummaryQuery: () => empty,
    loadBookingServiceRecords: async () => ({rows:[],available:true}),
    listBookingTransfersForBooking: async () => [],
    appendAuditLog: () => {}, getLunaGuestNotesFromMetadata: () => [],
    filterPendingManualServiceRecords: () => [], buildServiceChargesDueFromContext: () => ({}),
    buildTransfersDrawerPayload: () => ({}), projectBookingGuestStays: (_bk, rows) => rows,
    loadWolfhouseQuoteConfigWithOverlay: async () => null, buildGuestAccommodationLines: () => [],
    loadWolfhouseDepositRates: require('./lib/wolfhouse-stay-deposit').loadWolfhouseDepositRates,
    send400: (_res,error) => ({status:400,body:{error}}),
    sendJSON: (_res,status,body) => ({status,body}),
  };
  vm.createContext(sandbox);
  for (const name of ['paymentLedgerIsPaidStatus','paymentLedgerPaidTotalCents','editPreviewSvcSum','handleBookingContext']) {
    vm.runInContext(extract(name), sandbox, {filename:'staff-query-api.js#' + name});
  }
  // Pricing's own read uses a separate authoritative DB adapter; caller money
  // and currency are deliberately supplied below and must never become authority.
  sandbox.loadWolfhouseDepositRates = () => require('./lib/wolfhouse-stay-deposit').loadWolfhouseDepositRates(db);
  const beforeState = await db.query('SELECT row_to_json(b) AS row FROM bookings b ORDER BY id');
  const beforePayments = await db.query('SELECT row_to_json(p) AS row FROM payments p ORDER BY id');
  const response = await sandbox.handleBookingContext('WH-TOTALS',
    {client, invoice_total_cents:1, deposit_required_cents:1, currency:'ZZZ'}, {}, null);
  assert.deepEqual(await db.query('SELECT row_to_json(b) AS row FROM bookings b ORDER BY id'), beforeState);
  assert.deepEqual(await db.query('SELECT row_to_json(p) AS row FROM payments p ORDER BY id'), beforePayments);
  assert(readQueries.length > 0, 'actual handler reached disposable SQL');
  return response;
}

test('Phase2A actual booking-context exposes additive financials without writes', async () => {
  const wrongTenant = await financialContext('sunset');
  assert.equal(wrongTenant.status, 404, 'other tenant cannot read Wolfhouse booking');
  const response = await financialContext();
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.body.booking.total_amount_cents, 100000, 'legacy booking amount retained');
  assert.equal(response.body.payments.amount_paid_cents, 0, 'legacy receipt aggregate retained');
  assert.ok(response.body.financials, 'Phase2A booking-context financials field is absent');
  assert.equal(response.body.financials.schema_version, 1);
  assert.equal(response.body.financials.invoice_total_cents, 100000, 'request money is not authoritative');
  assert.notEqual(response.body.financials.currency, 'ZZZ', 'request currency is not authoritative');
});

test('Phase2A collection must not count a receipt owned by another tenant', async () => {
  await db.query("INSERT INTO clients VALUES ('foreign', 'sunset')");
  // Production-shaped independent foreign keys permit this inconsistent pair.
  // It is not an authorized excluded-display receipt: its client is different.
  await db.query(`INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents)
    VALUES ('foreign',$1,'paid','full_amount','EUR',10000,10000)`, [BOOKING]);
  const beforeReceipts = (await db.query("SELECT * FROM payments WHERE status='paid'")).rows;
  const result = await create({ payment_target:'deposit' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((await db.query("SELECT * FROM payments WHERE status='paid'")).rows, beforeReceipts,
    'historical receipts remain unchanged');
  assert.equal(calls.length, 1, 'only offline provider adapter is called');
  console.log('Phase2A tenant probe:', JSON.stringify({ expected_deposit_cents:30000,
    actual_deposit_cents:result.body.amount_due_cents, provider_amount_cents:calls[0].amountDueCents,
    receipt_client:'foreign', booking_client:'wh' }));
  assert.equal(result.body.amount_due_cents, 30000,
    'foreign-tenant receipt must not reduce authorized Wolfhouse collection');
});

test('Phase2A composition distinguishes policy, capped display and admitted collection scopes', () => {
  const project = require('./lib/wolfhouse-booking-financial-projection').wolfhouseBookingFinancialProjection;
  const input = { booking: {total_amount_cents:6000, deposit_required_cents:10000,
    metadata:{quote_snapshot:{per_guest_dates:true}}}, currency:'EUR', displayPaidCents:1000,
    collectionIdentityEstablished:true, collectionRows:[{payment_status:'paid',amount_paid_cents:1000}],
    serviceDueCents:0,additionalServiceCents:0,transferDueCents:0 };
  const f = project(input);
  assert.equal(f.deposit_required_cents,10000);
  assert.equal(f.deposit_display_cents,6000);
  assert.equal(f.deposit_outstanding_cents,5000);
  assert.equal(f.collection_paid_total_cents,1000);
  assert.equal(f.collection_balance_due_cents,5000);
  assert.equal(f.collection_needs_refund,false);
  const excluded = project({...input,booking:{...input.booking,total_amount_cents:10000},
    collectionRows:[...input.collectionRows,{payment_status:'paid',amount_paid_cents:5000,display_eligible:false}]});
  assert.equal(excluded.paid_total_cents,1000);
  assert.equal(excluded.balance_due_cents,9000);
  assert.equal(excluded.collection_paid_total_cents,6000);
  assert.equal(excluded.deposit_outstanding_cents,4000);
  const unknown = project({...input,collectionIdentityEstablished:false});
  for (const key of ['collection_paid_total_cents','collection_balance_due_cents','collection_needs_refund','deposit_outstanding_cents']) {
    assert.equal(unknown[key],null,key);
    assert.match(unknown.value_sources[key],/unknown.*identity/);
  }
  assert.equal(unknown.deposit_display_cents,6000,'independent invoice cap survives unknown collection');
});

test('Phase2A context attests complete empty/visible receipts but never ambiguous excluded identities', async () => {
  const empty = (await financialContext()).body.financials;
  assert.equal(empty.collection_paid_total_cents,0);
  assert.equal(empty.deposit_outstanding_cents,30000);
  await db.query(`INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents)
    VALUES ('wh',$1,'paid','full_amount','EUR',1000,1000)`,[BOOKING]);
  const visible = (await financialContext()).body.financials;
  assert.equal(visible.collection_paid_total_cents,1000);
  await db.query("INSERT INTO clients VALUES ('foreign','sunset')");
  await db.query(`INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents)
    VALUES ('foreign',$1,'paid','full_amount','EUR',10000,10000)`,[BOOKING]);
  const ambiguous = (await financialContext()).body.financials;
  assert.equal(ambiguous.paid_total_cents,1000);
  assert.equal(ambiguous.collection_paid_total_cents,null);
  assert.equal(ambiguous.deposit_outstanding_cents,null);
  assert.equal(ambiguous.invoice_total_cents,100000);
});

test('Phase2A rates fallback provenance is honest without changing legacy rate shape', async () => {
  const owner = require('./lib/wolfhouse-stay-deposit');
  assert.equal(typeof owner.loadWolfhouseDepositRatesWithProvenance,'function');
  const failed = {query:async () => {throw new Error('offline missing Pricing');}};
  const fact = await owner.loadWolfhouseDepositRatesWithProvenance(failed);
  assert.deepEqual(fact.rates,await owner.loadWolfhouseDepositRates(failed));
  assert.equal(fact.provenance,'seed_fallback:admin_pricing_unavailable');
});

test('Phase2A owner edge matrix preserves history, caps, unknown, refunds, services and currency', async () => {
  const project = require('./lib/wolfhouse-booking-financial-projection').wolfhouseBookingFinancialProjection;
  const base = {booking:{total_amount_cents:6000,deposit_required_cents:10000,
    metadata:{quote_snapshot:{per_guest_dates:true,total_cents:6000}}},currency:'GBP',
    serviceDueCents:9000,additionalServiceCents:1500,transferDueCents:2000,
    collectionIdentityEstablished:true,depositRatesProvenance:'seed_fallback:admin_pricing_unavailable'};
  for (const [paid,balance,refund,outstanding] of [[0,9500,false,9500],[1000,8500,false,8500],[9500,0,false,0],[11000,0,true,0]]) {
    const f = project({...base,displayPaidCents:paid,collectionRows:[{payment_status:'paid',amount_paid_cents:paid}]});
    assert.equal(f.invoice_total_cents,9500,'accepted total plus later charges, not current embedded service prices');
    assert.equal(f.currency,'GBP'); assert.equal(f.balance_due_cents,balance);
    assert.equal(f.needs_refund,refund); assert.equal(f.collection_needs_refund,refund);
    assert.equal(f.deposit_outstanding_cents,outstanding);
    assert.equal(f.deposit_required_cents,10000,'historical KEEP');
    assert.match(f.value_sources.deposit_rates,/seed_fallback/);
  }
  for (const required of [0,null]) {
    const f = project({...base,booking:{...base.booking,deposit_required_cents:required},displayPaidCents:0,collectionRows:[]});
    assert.equal(f.deposit_required_cents,required); assert.equal(f.deposit_display_cents,required);
    assert.equal(f.deposit_outstanding_cents,required);
  }
  const missing = project({booking:{},displayPaidCents:null});
  for (const key of ['invoice_total_cents','paid_total_cents','balance_due_cents','deposit_required_cents','needs_refund','currency']) assert.equal(missing[key],null,key);
  const unavailable = project({...base,invoiceInputsAvailable:false,displayPaidCents:1000,collectionRows:[]});
  assert.equal(unavailable.invoice_total_cents,null); assert.equal(unavailable.needs_refund,null);
  assert.equal(unavailable.paid_total_cents,1000);
  const mixed = {total_amount_cents:40000,guest_count:2,check_in:'2026-07-01',check_out:'2026-07-08',
    guest_packages:[{guest_number:1,package_code:'waimea'},{guest_number:2,package_code:'package_none'}],
    metadata:{quote_snapshot:{per_person:[{guest_number:1,package_code:'waimea',subtotal_cents:6000},{guest_number:2,package_code:'package_none',subtotal_cents:30000}]}}};
  const f = project({...base,booking:mixed,rates:{long_stay_cents:99000,short_stay_cents:10000}});
  assert.equal(f.deposit_required_cents,16000,'persisted cheap-person cap survives current tier edits');
  const {bookingDepositLinkAmount} = require('./lib/booking-deposit-payment-link');
  assert.deepEqual(await bookingDepositLinkAmount(null,base.booking,[],{}),{ok:false,status:503,body:{success:false,reason_code:'payment_ledger_unavailable',error:'Fresh booking payment ledger adapter required.'}});
  assert.deepEqual(await bookingDepositLinkAmount(null,base.booking,[{payment_status:'paid',amount_paid_cents:11000}],{loadBookingPaymentLedger:async()=>({invoice_total_cents:6000})}),{ok:false,status:409,body:{success:false,reason_code:'refund_review_needed',error:'Refund / credit review needed before creating a payment link.'}});
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
    assert.equal(retry.body.reason_code,
      mutation === `booking_guest_id='${BOOKING}'`
        ? 'booking_payment_guest_checkout_active'
        : 'idempotency_conflict', mutation);
    assert.equal(calls.length, 1, mutation);
    assert.equal(retry.body.checkout_url, undefined);
  }
});
