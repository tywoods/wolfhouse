#!/usr/bin/env node
'use strict';

// Offline real SQL/coordinator proof. Minimal production-shaped base plus real
// guest/checkout-index migrations. PGlite is not a concurrent Postgres lock proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');
const checkout = require('./lib/per-guest-checkout');
const C1 = '10000000-0000-4000-8000-000000000001';
const C2 = '10000000-0000-4000-8000-000000000002';
const B1 = '20000000-0000-4000-8000-000000000001';
const B2 = '20000000-0000-4000-8000-000000000002';
const B3 = '20000000-0000-4000-8000-000000000003';
const G1 = '30000000-0000-4000-8000-000000000001';
const G2 = '30000000-0000-4000-8000-000000000002';
const G3 = '30000000-0000-4000-8000-000000000003';
const G4 = '30000000-0000-4000-8000-000000000004';
let db;
let networkAttempts = 0;
function forbidNetwork() { networkAttempts++; throw new Error('Network forbidden in offline collection gate'); }
global.fetch = forbidNetwork;
require('node:http').request = forbidNetwork;
require('node:https').request = forbidNetwork;
require('node:net').connect = forbidNetwork;
require('node:net').Socket.prototype.connect = forbidNetwork;
const queries = [];
const pg = { async query(sql, params) {
  queries.push(sql);
  const result = await db.query(sql, params);
  return { ...result, rowCount: result.affectedRows ?? result.rows.length };
} };
async function schema() {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE payment_record_status AS ENUM ('draft','checkout_created','pending','paid','expired','cancelled','failed');
    CREATE TYPE payment_kind AS ENUM ('deposit_only','full_amount');
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE bookings (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id),
      booking_code text, status text NOT NULL DEFAULT 'confirmed',
      guest_name text DEFAULT 'Offline booking', guest_count integer DEFAULT 2,
      check_in date DEFAULT '2026-10-01', check_out date DEFAULT '2026-10-04',
      deposit_required_cents integer DEFAULT 0, total_amount_cents integer DEFAULT 10000, balance_due_cents integer DEFAULT 10000,
      metadata jsonb NOT NULL DEFAULT '{"quote_snapshot":{"line_items":[{"code":"package","total_cents":10000}]}}');
    CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;
    CREATE TABLE payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES clients(id),
      booking_id uuid NOT NULL REFERENCES bookings(id), status payment_record_status NOT NULL DEFAULT 'draft',
      payment_kind payment_kind NOT NULL DEFAULT 'full_amount', currency char(3) NOT NULL DEFAULT 'EUR',
      amount_due_cents integer NOT NULL CHECK(amount_due_cents >= 0),
      amount_paid_cents integer NOT NULL DEFAULT 0 CHECK(amount_paid_cents >= 0),
      stripe_checkout_session_id text, checkout_url text, expires_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT NOW()
    );
  `);
  for (const migration of ['024_booking_guests.sql', '107_per_guest_checkout_authoritative_intent.sql',
    '010_booking_service_records.sql', '018_booking_service_records_nullable_service_date.sql',
    '030_booking_service_records_slot_reservations.sql']) {
    await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations', migration), 'utf8'));
  }
}
async function reset() {
  await db.exec('TRUNCATE payments, booking_guests, bookings, clients CASCADE');
  await db.query('INSERT INTO clients VALUES ($1,$2),($3,$4)', [C1,'wolfhouse-somo',C2,'sunset']);
  for (const [id, client] of [[B1,C1],[B2,C1],[B3,C2]]) {
    await db.query("INSERT INTO bookings(id,client_id,booking_code) VALUES($1,$2,'OFFLINE')", [id,client]);
  }
  for (const [id, booking, client, num] of [[G1,B1,C1,1],[G2,B1,C1,2],[G3,B2,C1,1],[G4,B3,C2,1]]) {
    await db.query(`INSERT INTO booking_guests(id,client_id,booking_id,guest_number,guest_name,deposit_amount_cents,metadata)
      VALUES($1,$2,$3,$4,'Offline guest',2000,'{"subtotal_cents":5000}')`, [id,client,booking,num]);
  }
  queries.length = 0;
}
async function receipt({ client=C1, booking=B1, guest=null, amount=1500, status='paid', source='staff_cash' } = {}) {
  return db.query(`INSERT INTO payments(client_id,booking_id,booking_guest_id,status,amount_due_cents,amount_paid_cents,metadata)
    VALUES($1,$2,$3,$4,1500,$5,$6::jsonb) RETURNING id`,
  [client,booking,guest,status,amount,JSON.stringify({ source })]);
}
async function snapshot() {
  return {
    payments: (await db.query('SELECT * FROM payments ORDER BY id')).rows,
    guests: (await db.query('SELECT * FROM booking_guests ORDER BY id')).rows,
  };
}
function provider(onCreate) {
  const calls = [];
  const sessions = new Map();
  return { calls, sessions, stripe: { checkout: { sessions: {
    async create(params, options) {
      calls.push({ method:'create', params, options });
      if (!sessions.has(options.idempotencyKey)) {
        const id = 'cs_offline_' + (sessions.size + 1);
        sessions.set(options.idempotencyKey, { id, status:'open', payment_status:'unpaid',
          url:'https://checkout.stripe.com/c/pay/' + id, expires_at:9999999999 });
      }
      if (onCreate) await onCreate();
      return sessions.get(options.idempotencyKey);
    },
    async retrieve(id) {
      calls.push({ method:'retrieve', id });
      const session = [...sessions.values()].find(s => s.id === id);
      assert(session, 'unknown offline provider identity');
      return session;
    },
    async expire(id) {
      calls.push({ method:'expire', id });
      const session = [...sessions.values()].find(s => s.id === id);
      assert(session, 'unknown offline provider identity');
      session.status = 'expired';
      return session;
    },
  } } } };
}
function run(h, { guest=G1, client='wolfhouse-somo', target='remaining_share' } = {}) {
  return checkout.run({ withPgClient: fn => fn(pg), stripe:h.stripe, guestId:guest, clientSlug:client,
    actorId:'offline-staff', paymentTarget:target, successUrl:'https://example.invalid/success',
    cancelUrl:'https://example.invalid/cancel' });
}
function ambiguity(err) {
  assert.equal(err.message, 'guest_payment_unallocated_booking_receipt');
  assert.equal(err.httpStatus, 409);
  assert.match(err.publicMessage, /booking.*payment|payment.*booking/i);
  return true;
}
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function productionServiceHarness() {
  // Evaluate only named production functions; never import/start the API server.
  // The booking lookup is an explicit minimal-schema adapter. Mutation SQL,
  // pricing config, slot-column DDL, and ledger math are production bytes.
  const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  function extract(name) {
    const match = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(source);
    assert(match, 'production function missing: ' + name);
    const end = source.indexOf('\n}', match.index);
    assert(end > match.index, 'production function terminator missing: ' + name);
    return source.slice(match.index, end + 2);
  }
  const sandbox = { fs, Date,
    ...require('./lib/staff-booking-services-schedule'),
    ...require('./lib/booking-invoice-totals'),
    sumActiveTransferChargesCents:()=>0, editPreviewBuildLineItems:()=>[], paymentLedgerHasActiveValidLink:()=>false,
    STAFF_ADDON_PRICING_CONFIG_PATH:path.join(__dirname, '../config/clients/wolfhouse-somo.pricing.json'),
    STAFF_ADDON_UI_SERVICE_TYPES:new Set(['wetsuit','soft_board','hard_board','surf_lesson','yoga','meals']),
    EDIT_PREVIEW_ACCOMM_LINE_CODES:{ package:true }, BC_RUNNING_INVOICE_ACCOMM_CODES:{package:true},
    DEFAULT_CLIENT:'wolfhouse-somo', SQL_INJECT_RE:/[;'"\\\\]/, UUID_VALIDATE_RE:/^[a-f0-9-]{36}$/i,
    readBody:async req => JSON.stringify(req.body), withPgClient:fn => fn(pg),
    appendAuditLog:() => {}, sendJSON:(res, status, body) => Object.assign(res, { status, body }),
    send400:(res, error) => Object.assign(res, { status:400, body:{ success:false, error } }),
    bookingStatusIsCancelled:status => ['cancelled','expired'].includes(status),
    isMissingBookingServiceRecordsTable:() => false,
    EDIT_PREVIEW_BOOKING_BY_ID_SQL:`SELECT b.*,b.id::text AS booking_id,
      b.check_in::text AS check_in,b.check_out::text AS check_out
      FROM bookings b JOIN clients c ON c.id=b.client_id WHERE c.slug=$1 AND b.id=$2::uuid`,
  };
  vm.createContext(sandbox);
  for (const name of ['staffAddonLoadPricingConfig','staffAddonResolvePricing','ensureBookingServiceSlotColumns',
    'handleBookingAddService','editPreviewSvcSum','paymentLedgerPaidTotalCents','paymentLedgerIsPaidStatus','bookingLedgerBalanceFromRows','bcRunningInvoiceAccommodationCents','bcServiceRecordBillableCents','mergeBedCalendarPaymentSnapshots']) {
    vm.runInContext(extract(name), sandbox, { filename:'staff-query-api.js#' + name });
  }
  vm.runInContext(source.match(/const BED_CALENDAR_BOOKING_LEDGER_SQL = `[\s\S]*?`;/)[0] + "\nglobalThis.calendarSql = BED_CALENDAR_BOOKING_LEDGER_SQL;", sandbox);
  return sandbox;
}
test('positive paid All receipt blocks deposit and remaining share before any provider operation or draft', async () => {
  await receipt();
  const before = await snapshot();
  for (const target of ['deposit','remaining_share']) {
    const h = provider();
    await assert.rejects(run(h, { target }), ambiguity);
    assert.deepEqual(h.calls, [], 'prepare block must make zero provider calls');
    assert.deepEqual(await snapshot(), before, 'prepare block must write nothing');
  }
  const lock = queries.findIndex(sql => /FROM bookings.*FOR UPDATE/.test(sql));
  const read = queries.findIndex(sql => /FROM booking_guests bg JOIN bookings/.test(sql));
  assert(lock >= 0 && read > lock, 'authoritative read follows booking lock');
});

test('All receipt between provider create and finalize blocks returned URL and expires only the new open session', async () => {
  const h = provider(() => receipt());
  await assert.rejects(run(h), ambiguity);
  assert.deepEqual(h.calls.map(c => c.method), ['create','expire']);
  const state = await snapshot();
  const intent = state.payments.find(p => p.metadata.source === 'bot_guest_payment_link_slice_a');
  assert.equal(intent.status, 'expired');
  assert.equal(intent.stripe_checkout_session_id, null);
  assert.equal(intent.checkout_url, null);
  assert.equal(state.payments.filter(p => p.status === 'paid').length, 1, 'receipt preserved');
  assert.equal(state.guests.find(g => g.id === G1).payment_id, null, 'no finalized guest pointer');
  const bookingLocks = queries.filter(sql => /FROM bookings.*FOR UPDATE/.test(sql));
  assert(bookingLocks.length >= 2, 'prepare and finalize both lock booking');
});

test('named receipts reduce only their guest; tenant and booking predicates isolate unrelated receipts', async () => {
  await receipt({ guest:G1 });
  await receipt({ guest:G1, amount:500, source:'staff_bank_transfer' });
  await receipt({ booking:B2 });
  await receipt({ client:C2, booking:B3 });
  // The schema permits mismatched FK pairs: even such a foreign tenant row must
  // not leak into this booking's ambiguity check or guest-attributed paid sum.
  await receipt({ client:C2, booking:B1 });
  await receipt({ client:C2, booking:B1, guest:G1 });
  await receipt({ booking:B2, guest:G1 });
  const h = provider();
  const first = await run(h);
  const second = await run(h, { guest:G2 });
  assert.equal(first.amount, 3000);
  assert.equal(second.amount, 5000);
  assert.deepEqual(h.calls.map(c => c.params.line_items[0].price_data.unit_amount), [3000,5000]);
  assert.equal(first.session.url, 'https://checkout.stripe.com/c/pay/cs_offline_1');
  assert.equal(second.session.url, 'https://checkout.stripe.com/c/pay/cs_offline_2');
  const before = h.calls.length;
  await assert.rejects(run(h, { guest:G3 }), ambiguity);
  await assert.rejects(run(h, { guest:G4, client:'sunset' }), ambiguity);
  assert.equal(h.calls.length, before, 'other booking/tenant blocks its own guest without provider calls');
  assert.deepEqual(await run(h, { guest:G4 }), { missing:true }, 'cross-tenant identity is unavailable');
});

test('unpaid/zero booking records do not fence either tenant; any positive paid source does', async () => {
  for (const status of ['draft','checkout_created','pending','expired','cancelled','failed']) {
    await receipt({ status });
  }
  await receipt({ amount:0 });
  const h = provider();
  assert.equal((await run(h)).amount, 5000);
  assert.equal((await run(h, { guest:G4, client:'sunset' })).amount, 5000);
  await receipt({ source:'stripe_webhook' });
  const before = await snapshot();
  const count = h.calls.length;
  await assert.rejects(run(h), ambiguity);
  assert.equal(h.calls.length, count, 'existing guest link must not be retrieved or returned after All');
  assert.deepEqual(await snapshot(), before, 'no historical edits or automatic old-link revocation');
});

test('named receipt leaves deposit calculation and paid-guest zero behavior intact', async () => {
  await receipt({ guest:G1, amount:500 });
  await receipt({ guest:G2, amount:5000 });
  const h = provider();
  assert.equal((await run(h, { target:'deposit' })).amount, 1500);
  assert.equal(h.calls[0].params.line_items[0].price_data.unit_amount, 1500);
  const settled = await run(h, { guest:G2 });
  assert.equal(settled.zero, true);
  assert.equal(settled.amount, 0);
  assert.equal(h.calls.length, 1);
});

test('ordinary yoga handler persists booking-wide units, not a guest share edit (characterization, not yoga acceptance)', async () => {
  const api = productionServiceHarness();
  const h = provider();
  const first = await run(h);
  const before = await snapshot();
  const bookingBefore = (await db.query('SELECT * FROM bookings WHERE id=$1', [B1])).rows[0];
  const res = {};
  await api.handleBookingAddService({ body:{ client_slug:'wolfhouse-somo', booking_id:B1,
    service_type:'yoga', quantity:1, schedule_mode:'schedule_later', idempotency_key:'offline-yoga' } },
  res, { staff_user_id:'offline-staff', role:'operator' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  const services = (await db.query('SELECT * FROM booking_service_records WHERE booking_id=$1', [B1])).rows;
  assert.equal(services.length, 1);
  const yoga = services[0];
  const configuredPrice = JSON.parse(fs.readFileSync(api.STAFF_ADDON_PRICING_CONFIG_PATH, 'utf8')).add_ons.yoga_class.price_cents;
  assert.equal(yoga.amount_due_cents, configuredPrice);
  assert.equal(yoga.service_type, 'yoga');
  assert.equal(yoga.client_slug, 'wolfhouse-somo');
  assert.equal(yoga.guest_name, bookingBefore.guest_name, 'label is booking lead name, not guest identity');
  assert.equal(yoga.metadata.booking_guest_id, undefined);
  assert.deepEqual(await snapshot(), before, 'service mutation does not reproject guests or write payment records');
  const bookingAfter = (await db.query('SELECT * FROM bookings WHERE id=$1', [B1])).rows[0];
  assert.deepEqual(bookingAfter, bookingBefore, 'ordinary handler leaves booking money/quote unchanged');
  const second = await run(h);
  assert.equal(second.amount, first.amount);
  assert.equal(second.session.url, first.session.url);
  assert.deepEqual(h.calls.map(c => c.method), ['create','retrieve']);
  const context = require('./lib/luna-guest-addon-service-payment-ledger').buildServiceChargesDueFromContext({
    booking:bookingAfter, serviceRecords:services, paymentRows:[] });
  assert.equal(context.service_charges_due_cents, configuredPrice);
  const ledger = api.bookingLedgerBalanceFromRows(bookingAfter, services, [], []);
  assert.equal(ledger.invoice_total_cents, bookingBefore.total_amount_cents + yoga.amount_due_cents,
    'ordinary new yoga reaches the same booking ledger used by balance collection');
  assert.equal(ledger.balance_due_cents, 11500);
  assert.equal(api.bcRunningInvoiceAccommodationCents(bookingAfter, services, bookingAfter.metadata.quote_snapshot) + yoga.amount_due_cents, 11500, 'browser invoice keeps saved accommodation and adds new charge');
  const calRows = (await db.query(api.calendarSql, [[B1], 'wolfhouse-somo'])).rows;
  const blocks = [{booking_id:B1}]; api.mergeBedCalendarPaymentSnapshots(blocks,calRows,[],[]);
  assert.equal(blocks[0].invoice_total_cents,11500,'ordinary calendar projection agrees with booking balance');
  const embedded = {amount_due_cents:1500, metadata:{},status:'requested'};
  const partialQuote = {...bookingAfter, metadata:{quote_snapshot:{line_items:[{code:'package',total_cents:8500}]}}};
  assert.equal(api.bookingLedgerBalanceFromRows(partialQuote,[embedded,yoga],[],[]).invoice_total_cents,11500,'embedded package service counted once');
  const cancelled = {...yoga,status:'cancelled'};
  assert.equal(api.bookingLedgerBalanceFromRows(partialQuote,[embedded,cancelled],[],[]).invoice_total_cents,10000,'cancelled additional service contributes zero');
  assert.equal(api.bcRunningInvoiceAccommodationCents(partialQuote,[embedded,cancelled],partialQuote.metadata.quote_snapshot) + api.bcServiceRecordBillableCents(embedded) + api.bcServiceRecordBillableCents(cancelled),10000,'browser excludes cancelled new charge');
  console.log('YOGA PROJECTION:', JSON.stringify({
    service_charge_cents:yoga.amount_due_cents, guest_link_before_cents:first.amount,
    guest_link_after_cents:second.amount, guest_url_reused:true,
    persisted_booking_total_cents:bookingAfter.total_amount_cents,
    existing_booking_balance_cents:ledger.balance_due_cents,
    unprojected_new_service_cents:yoga.amount_due_cents,
  }));
  // Opt-in acceptance RED for the separate booking projection owner. Default
  // coverage characterizes the seam; it must not imply yoga repricing passed.
  if (process.argv.includes('--require-yoga-projection')) {
    assert.equal(ledger.invoice_total_cents, bookingBefore.total_amount_cents + yoga.amount_due_cents,
      'ordinary newly added yoga must reach the booking invoice without guest allocation');
  }
});

(async () => {
  await schema();
  let failures = 0;
  try {
    for (const { name, fn } of tests) {
      await reset();
      try { await fn(); console.log('PASS:', name); }
      catch (err) { failures++; console.error('FAIL:', name, '\n' + err.stack); }
    }
    assert.equal(networkAttempts, 0, 'no live network/provider attempts');
    console.log(`RESULT: ${tests.length - failures}/${tests.length} passed; live network attempts=${networkAttempts}`);
  } finally { await db.close(); }
  if (failures) process.exitCode = 1;
})().catch(err => { console.error(err); process.exitCode = 1; });
