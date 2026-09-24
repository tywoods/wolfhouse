'use strict';

// Offline integration boundary: real production SQL + extracted ordinary handler /
// Sunset loader. Only unrelated rooming, CRM and catalog dependencies are empty.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const detailQueries = require('./lib/staff-booking-detail-queries');
const truth = require('./lib/staff-booking-display-truth');
const { PAYMENT_COLLECTED_SCOPE_SQL } = require('./lib/sunset-staff-money-scope');
const drawer = require('./lib/sunset-schedule-booking-drawer');
const { PAYMENTS_FOR_BOOKINGS_SQL } = require('./lib/sunset-bookings-admin-data');
const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const drawerSource = fs.readFileSync(path.join(__dirname, 'lib/sunset-schedule-booking-drawer.js'), 'utf8');
function fn(source, name, async = false) {
  const start = source.indexOf((async ? 'async ' : '') + 'function ' + name + '(');
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function sqlConstant(name) {
  const start = api.indexOf('const ' + name + ' = `');
  assert.ok(start >= 0, name);
  return api.slice(start, api.indexOf('`;', start) + 2);
}
const ids = {
  wh: '00000000-0000-0000-0000-000000000001', sun: '00000000-0000-0000-0000-000000000002',
  booking: '10000000-0000-0000-0000-000000000001',
};
async function fixtureDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text);
    CREATE TABLE bookings (id uuid PRIMARY KEY, client_id uuid, booking_code text,
      guest_name text, phone text, email text, guest_count int, package_code text,
      check_in date, check_out date, status text, payment_status text, assignment_status text,
      requested_room_type text, room_preference text, primary_room_code text,
      needs_rooming_review boolean, rooming_notes text, total_amount_cents int,
      deposit_required_cents int, amount_paid_cents int, balance_due_cents int,
      hold_expires_at timestamptz, airtable_record_id text, updated_at timestamptz,
      metadata jsonb DEFAULT '{}');
    CREATE TYPE payment_record_status AS ENUM ('paid','checkout_created','expired','cancelled');
    CREATE TABLE booking_guests (id uuid, deposit_amount_cents int, metadata jsonb);
    CREATE TABLE payments (id uuid DEFAULT gen_random_uuid(), client_id uuid, booking_id uuid,
      status payment_record_status, payment_kind text, currency text, amount_due_cents int,
      amount_paid_cents int, paid_at timestamptz, checkout_url text, stripe_checkout_session_id text,
      stripe_payment_intent_id text, expires_at timestamptz, metadata jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now(), booking_guest_id uuid, finance_exclusion text);
    CREATE TABLE booking_service_records (id uuid DEFAULT gen_random_uuid(), booking_id uuid,
      booking_code text, client_slug text, service_type text, service_date date, quantity int,
      status text, payment_status text, amount_due_cents int, amount_paid_cents int,
      source text, notes text, metadata jsonb DEFAULT '{}', created_at timestamptz DEFAULT now(),
      service_time_local text, service_time_local_end text);
    INSERT INTO clients VALUES ('${ids.wh}','wolfhouse-somo'), ('${ids.sun}','sunset');
    INSERT INTO bookings (id,client_id,booking_code,total_amount_cents,amount_paid_cents,
      balance_due_cents,payment_status,status,metadata)
      VALUES ('${ids.booking}','${ids.wh}','INV-TEST',42000,42000,0,'paid','confirmed','{}');
  `);
  return db;
}
function loaders(db) {
  let response;
  const context = vm.createContext({
    ...detailQueries, ...truth, PAYMENT_COLLECTED_SCOPE_SQL,
    require: createRequire(path.join(__dirname, 'staff-query-api.js')),
    DEFAULT_CLIENT: 'wolfhouse-somo', SQL_INJECT_RE: /;/,
    withPgClient: (cb) => cb({ query: async (sql, args) => {
      if (sql === detailQueries.getBookingConversationQuery()
        || sql === detailQueries.getBookingHandoffQuery()
        || sql === detailQueries.getBookingAddOnSummaryQuery()
        || sql === 'fixture-rooming' || sql === 'fixture-guests') return { rows: [] };
      assert.match(sql.trim(), /^SELECT/i, 'ordinary context must be read-only');
      return db.query(sql, args);
    } }),
    BOOKING_CONTEXT_ROOMING_SQL: 'fixture-rooming', BOOKING_GUESTS_SELECT_SQL: 'fixture-guests',
    listBookingTransfersForBooking: async () => [],
    isMissingBookingServiceRecordsTable: () => false,
    appendAuditLog() {}, send400() { throw new Error('unexpected 400'); },
    sendJSON: (_res, status, body) => { response = { status, body }; },
    ...require('./lib/staff-pending-manual-services'),
    ...require('./lib/luna-guest-booking-notes'),
    buildServiceChargesDueFromContext: () => ({}), buildTransfersDrawerPayload: () => null,
    // These fixtures have no package/guest pricing; no replacement money supplied.
    buildGuestAccommodationLines: () => [],
  });
  vm.runInContext(sqlConstant('BOOKING_PAYMENTS_LEDGER_SQL') + '\n'
    + ['paymentLedgerIsPaidStatus','paymentLedgerPaidTotalCents','bookingContextServiceRecordsSql'].map((n) => fn(api,n)).join('\n')
    + '\n' + fn(api,'loadBookingServiceRecords',true) + '\n' + fn(api,'handleBookingContext',true), context);
  const sunset = vm.createContext({ PAYMENT_COLLECTED_SCOPE_SQL });
  vm.runInContext(fn(drawerSource,'loadSunsetBookingBundle',true), sunset);
  return {
    async ordinary(client = 'wolfhouse-somo') {
      await context.handleBookingContext('INV-TEST', { client }, {}, {});
      return response;
    },
    async bundle(client = 'sunset', forUpdate = false) {
      return sunset.loadSunsetBookingBundle({ query: (sql,args) => {
        assert.match(sql.trim(), /^SELECT/i, 'bundle must be read-only');
        return db.query(sql,args);
      } }, client, ids.booking, null, forUpdate);
    },
    async ledger(client) {
      return db.query(vm.runInContext('BOOKING_PAYMENTS_LEDGER_SQL',context), [client,'INV-TEST']);
    },
  };
}
async function payment(db, client, extra = {}) {
  await db.query(`INSERT INTO payments (client_id,booking_id,status,amount_paid_cents,
    amount_due_cents,paid_at,finance_exclusion,metadata,checkout_url,created_at)
    VALUES ($1,$2,$3,$4,30000,$5,$6,$7,$8,$9)`, [client,ids.booking,
    extra.status || 'paid', extra.amount ?? 30000,
    Object.hasOwn(extra,'paidAt') ? extra.paidAt : '2026-09-19',
    extra.finance || null, JSON.stringify(extra.metadata || {}), extra.url || null,
    extra.created || '2026-09-19']);
}
function summary(bundle) {
  return drawer.buildPaymentSummary([], bundle.booking, bundle.services, 'persisted-fixture',
    bundle.payments_paid_cents, null, { paid_rows: bundle.paid_payment_rows });
}
async function runPaymentScope() {
  const db = await fixtureDb();
  const load = loaders(db);
  const failures = [];
  const fixtures = [];
  try {
    for (const client of ['wolfhouse-somo','sunset']) {
      const clientId = client === 'sunset' ? ids.sun : ids.wh;
      await db.query('UPDATE bookings SET client_id=$1', [clientId]);
      for (const excluded of [
        { label: 'finance-excluded', finance: 'excluded' },
        { label: 'missing-paid-at', paidAt: null },
        { label: 'test-cancelled', metadata: { test_booking_cancelled: true } },
        { label: 'schedule-deleted', metadata: { schedule_booking_deleted: true } },
        { label: 'foreign-payment', foreign: true },
      ]) {
        await db.exec('DELETE FROM payments');
        await payment(db,clientId,{ amount: 12000 });
        await payment(db,excluded.foreign ? (client === 'sunset' ? ids.wh : ids.sun) : clientId,excluded);
        await payment(db,clientId,{ status: 'checkout_created', paidAt: null, url: 'https://example.invalid/pending', created: '2026-09-21' });
        await payment(db,clientId,{ status: 'expired', paidAt: null });
        await payment(db,clientId,{ status: 'cancelled', paidAt: null });
        try {
          const collected = Number((await db.query(PAYMENTS_FOR_BOOKINGS_SQL,[client,[ids.booking]])).rows[0].collected_cents);
          assert.equal(collected,12000,'reference Bookings collected scope');
          if (client === 'wolfhouse-somo') {
            const result = await load.ordinary(client);
            assert.equal(result.status,200,JSON.stringify(result.body));
            assert.equal(result.body.payments.amount_paid_cents,12000);
            assert.equal(result.body.payments.rows.filter((p) => p.payment_status === 'paid').length,1);
            assert.equal(result.body.payments.rows[0].checkout_url,'https://example.invalid/pending');
            assert.equal(result.body.payments.rows.filter((p) => p.payment_status !== 'paid').length,3,'pending/expired/cancelled history retained');
            fixtures.push({ client, label: excluded.label, payload: result.body,
              total: 42000, paid: 12000, due: 30000, status: 'partial' });
            const operational = await load.ledger(client);
            assert.equal(operational.rows.filter((p) => p.payment_status === 'paid').reduce((sum,p) => sum+p.amount_paid_cents,0),42000,
              'payment-link write ledger must retain its pre-existing history and amounts');
          } else {
            const bundle = await load.bundle();
            assert.equal(bundle.payments_paid_cents,12000);
            assert.equal(bundle.paid_payment_rows.length,1);
            assert.equal(bundle.payment_link.checkout_url,'https://example.invalid/pending');
            assert.equal(summary(bundle).balance_due_cents,30000);
            assert.equal(bundle.operational_payments_paid_cents,42000,'write policies retain the pre-existing aggregate');
            const locked = await load.bundle(client,true);
            assert.equal(locked.operational_payments_paid_cents,42000,'locking callers retain operational aggregate');
            fixtures.push({ client, label: excluded.label, payload: { ...bundle, payment: summary(bundle) },
              total: 42000, paid: 12000, due: 30000, status: 'partial' });
          }
          console.log('PASS invoice collected scope: ' + client + ' / ' + excluded.label);
        } catch (e) { failures.push(client + ' / ' + excluded.label + ': ' + e.message); }
      }
    }
    assert.equal(failures.length,0,failures.join('\n'));
    await require('./verify-staff-payment-status-truth-ui').verifyRawInvoiceTruth(fixtures);
    assert.equal((await load.ordinary('wolfhouse-somo')).status,404,'ordinary booking tenant fence');
    assert.equal(await load.bundle('wolfhouse-somo'),null,'Sunset booking tenant fence');
  } finally { await db.close(); }
}
async function service(db, client, amount, status = 'confirmed', metadata = {}) {
  await db.query(`INSERT INTO booking_service_records
    (booking_id,client_slug,service_type,service_date,quantity,status,amount_due_cents,metadata)
    VALUES ($1,$2,'accommodation','2026-09-19',1,$3,$4,$5)`,
  [ids.booking,client,status,amount,JSON.stringify(metadata)]);
}
async function runOrdinaryFallback() {
  const db = await fixtureDb();
  const load = loaders(db);
  const fixtures = [];
  try {
    await payment(db,ids.wh,{ amount: 12000 });
    for (const test of [
      { label: 'missing total / active services', stored: null, cancelled: false, discount: 0, total: 42000 },
      { label: 'missing total / cancelled + signed discount', stored: null, cancelled: true, discount: -1000, total: 41000 },
      { label: 'explicit stored zero', stored: 0, cancelled: true, discount: -1000, total: 0 },
    ]) {
      await db.query('UPDATE bookings SET total_amount_cents=$1', [test.stored]);
      await db.exec('DELETE FROM booking_service_records');
      await service(db,'wolfhouse-somo',42000);
      await service(db,'wolfhouse-somo',0,'confirmed',{ unit_amount_cents: 99999 });
      if (test.cancelled) await service(db,'wolfhouse-somo',99999,'cancelled');
      await service(db,'wolfhouse-somo',0,'confirmed',{ staff_custom_line: true, amount_cents: test.discount });
      await service(db,'sunset',99999);
      const result = await load.ordinary();
      assert.equal(result.status,200,JSON.stringify(result.body));
      assert.equal(result.body.service_records.some((s) => s.amount_due_cents === 99999 && s.status !== 'cancelled'),false,'foreign service excluded');
      fixtures.push({ client: 'wolfhouse-somo', label: test.label, payload: result.body,
        total: test.total, paid: 12000, due: Math.max(test.total-12000,0), status: test.total ? 'partial' : 'paid' });
      assert.equal((await db.query('SELECT total_amount_cents FROM bookings')).rows[0].total_amount_cents,test.stored,'read must not persist totals');
    }
    await require('./verify-staff-payment-status-truth-ui').verifyRawInvoiceTruth(fixtures);
  } finally { await db.close(); }
}
async function runSunsetFallback() {
  const db = await fixtureDb();
  const load = loaders(db);
  const fixtures = [];
  try {
    await db.query('UPDATE bookings SET client_id=$1,total_amount_cents=NULL',[ids.sun]);
    await payment(db,ids.sun,{ amount: 12000 });
    for (const discount of [0,-1000]) {
      await db.exec('DELETE FROM booking_service_records');
      await service(db,'sunset',42000);
      await service(db,'sunset',99999,'cancelled');
      await service(db,'sunset',0,'confirmed',{ unit_amount_cents: 99999 });
      await service(db,'sunset',0,'confirmed',{ staff_custom_line: true, amount_cents: discount });
      await service(db,'wolfhouse-somo',99999);
      const bundle = await load.bundle();
      assert.equal(bundle.services.length,4,'retain cancelled records for editing/cancellation; exclude foreign tenant');
      const paymentSummary = summary(bundle);
      fixtures.push({ client: 'sunset', label: 'missing total / cancelled / signed custom ' + discount,
        payload: { ...bundle, payment: paymentSummary }, total: 42000+discount, paid: 12000,
        due: 30000+discount, status: 'partial' });
      assert.equal((await db.query('SELECT total_amount_cents FROM bookings')).rows[0].total_amount_cents,null);
    }
    await require('./verify-staff-payment-status-truth-ui').verifyRawInvoiceTruth(fixtures);
    const bundle = await load.bundle();
    assert.equal(bundle.services.filter((s) => s.status === 'cancelled').length,1,'loader exposes service status without filtering records');
    assert.equal(summary(bundle).line_items.length,3,'cancelled charges not invoiced');
    assert.equal(summary(bundle).live_pricing,false,'stored zero and signed custom lines never repriced');
    await db.exec('UPDATE bookings SET total_amount_cents=0');
    const zero = await load.bundle();
    assert.equal(summary(zero).total_cents,0,'stored booking zero wins over service fallback');
  } finally { await db.close(); }
}
async function main() {
  if (!process.argv[2] || process.argv[2] === 'scope') await runPaymentScope();
  if (!process.argv[2] || process.argv[2] === 'ordinary') await runOrdinaryFallback();
  if (!process.argv[2] || process.argv[2] === 'sunset') await runSunsetFallback();
}
if (require.main === module) main().catch((err) => { console.error(err); process.exitCode = 1; });
module.exports = { verifyInvoiceTruth: main };
