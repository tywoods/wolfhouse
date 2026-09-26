#!/usr/bin/env node
'use strict';

// Offline service integration, not HTTP authorization or multi-session lock proof.
// Minimal clients/bookings + payments base; real migrations 004, 024 and 010 run verbatim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const servicePath = path.join(__dirname, 'lib/staff-manual-payment.js');
const service = fs.existsSync(servicePath) ? require(servicePath) : {};
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
const queries = [];
const pg = { async query(sql, params) {
  queries.push(sql);
  const result = await db.query(sql, params);
  return { ...result, rowCount: result.affectedRows ?? result.rows.length };
} };
let networkAttempts = 0;
function forbidNetwork() { networkAttempts++; throw new Error('Network forbidden in offline payment gate'); }
global.fetch = forbidNetwork;
require('node:http').request = forbidNetwork;
require('node:https').request = forbidNetwork;
require('node:net').connect = forbidNetwork;
require('node:net').Socket.prototype.connect = forbidNetwork;

async function schema() {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE payment_status AS ENUM ('not_requested','waiting_payment','deposit_paid','paid','refunded','failed');
    CREATE TYPE payment_record_status AS ENUM ('draft','checkout_created','pending','paid','expired','cancelled','failed');
    CREATE TYPE payment_kind AS ENUM ('deposit','balance','full','custom');
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE bookings (
      id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), booking_code text,
      status text NOT NULL DEFAULT 'confirmed', payment_status payment_status NOT NULL DEFAULT 'not_requested',
      metadata jsonb NOT NULL DEFAULT '{"quote_snapshot":{"line_items":[{"code":"package","total_cents":10000}]}}',
      total_amount_cents integer, deposit_required_cents integer DEFAULT 0, deposit_paid_cents integer DEFAULT 0,
      amount_paid_cents integer DEFAULT 0, balance_due_cents integer DEFAULT 0
    );
    CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;
    CREATE TABLE payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES clients(id),
      booking_id uuid NOT NULL REFERENCES bookings(id), status payment_record_status NOT NULL DEFAULT 'draft',
      kind payment_kind NOT NULL DEFAULT 'deposit', currency char(3) NOT NULL DEFAULT 'EUR',
      amount_cents integer NOT NULL CHECK(amount_cents >= 0), paid_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );
  `);
  for (const migration of ['004_payment_schema_phase2.sql', '024_booking_guests.sql', '010_booking_service_records.sql']) {
    await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations', migration), 'utf8'));
  }
  console.log('SCHEMA: declared minimal base + real 004_payment_schema_phase2.sql + 024_booking_guests.sql + 010_booking_service_records.sql');
}
async function reset() {
  await db.exec('TRUNCATE payments, booking_guests, bookings, clients CASCADE');
  await db.query('INSERT INTO clients VALUES ($1,$2),($3,$4)', [C1, 'wolfhouse-somo', C2, 'sunset']);
  for (const [id, client] of [[B1,C1], [B2,C1], [B3,C2]]) {
    await db.query(`INSERT INTO bookings(id,client_id,booking_code,total_amount_cents,balance_due_cents)
      VALUES($1,$2,'OFFLINE',10000,10000)`, [id, client]);
  }
  for (const [id, booking, client, num, name] of [[G1,B1,C1,1,'Ada'],[G2,B1,C1,2,'Ben'],[G3,B2,C1,1,'Other booking'],[G4,B3,C2,1,'Other tenant']]) {
    await db.query(`INSERT INTO booking_guests(id,client_id,booking_id,guest_number,guest_name,deposit_amount_cents,metadata)
      VALUES($1,$2,$3,$4,$5,2000,'{"subtotal_cents":5000}')`, [id,client,booking,num,name]);
  }
  queries.length = 0;
}
function intent(overrides = {}) {
  return { clientSlug: 'wolfhouse-somo', bookingId: B1, paymentScope: 'guest', bookingGuestId: G1,
    amountCents: 1500, method: 'cash', idempotencyKey: 'offline-1', paymentDate: '2026-09-26',
    note: 'Desk receipt', actorLabel: 'offline-staff@example.invalid', ...overrides };
}
async function snapshot() {
  const result = {};
  for (const table of ['payments','bookings','booking_guests']) result[table] = (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  return result;
}
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('new explicit booking add-on remains outstanding after base-only receipt; legacy rows are not allocated', async () => {
  for (const [client, booking, metadata, status] of [
    ['wolfhouse-somo', B1, {invoice_total_inclusion:'additional'}, 'requested'],
    ['sunset', B1, {invoice_total_inclusion:'additional'}, 'requested'],
    ['wolfhouse-somo', B2, {invoice_total_inclusion:'additional'}, 'requested'],
    ['wolfhouse-somo', B1, {}, 'requested'],
    ['wolfhouse-somo', B1, {invoice_total_inclusion:'additional'}, 'cancelled'],
  ]) await db.query(`INSERT INTO booking_service_records(client_slug,booking_id,service_type,service_date,amount_due_cents,status,metadata)
    VALUES($1,$2,'yoga','2026-10-01',1500,$3,$4)`, [client,booking,status,JSON.stringify(metadata)]);
  const result = await service.recordStaffManualPayment(pg,intent({paymentScope:'booking',bookingGuestId:null,amountCents:10000}));
  assert.equal(result.balance_due_cents,1500,'additional yoga is not lost on receipt projection');
  const saved = (await db.query('SELECT * FROM bookings WHERE id=$1',[B1])).rows[0];
  assert.equal(saved.total_amount_cents,10000,'saved base and guest allocation remain untouched');
  assert.equal(saved.balance_due_cents,1500);
  assert.notEqual(saved.payment_status,'paid');
});

test('receipt projection agrees after an accepted quote embeds the formerly additional service', async () => {
  await db.query(`INSERT INTO booking_service_records(client_slug,booking_id,service_type,service_date,amount_due_cents,status,metadata)
    VALUES('wolfhouse-somo',$1,'yoga','2026-10-01',1500,'requested','{"invoice_total_inclusion":"additional"}')`,[B1]);
  // Persisted accepted-reprice shape: accommodation 100 + service 15 = total 115.
  // This is a projection invariant, not an HTTP reprice-workflow claim.
  await db.query(`UPDATE bookings SET total_amount_cents=11500 WHERE id=$1`,[B1]);
  const result = await service.recordStaffManualPayment(pg,intent({amountCents:10000}));
  assert.equal(result.balance_due_cents,1500,'one yoga charge, not two after quote absorption');
});

test('named cash receipt independently reads back guest attribution and cumulative projections', async () => {
  assert.equal(typeof service.recordStaffManualPayment, 'function', 'bounded manual receipt service must exist');
  const result = await service.recordStaffManualPayment(pg, intent());
  assert.equal(result.idempotent, false);
  assert.equal(result.booking_paid_cents, 1500);
  assert.equal(result.balance_due_cents, 8500);
  const rows = await snapshot();
  assert.equal(rows.payments.length, 1);
  const payment = rows.payments[0];
  assert.equal(payment.id, result.payment.payment_id);
  assert.equal(payment.client_id, C1);
  assert.equal(payment.booking_id, B1);
  assert.equal(payment.booking_guest_id, G1);
  assert.equal(payment.status, 'paid');
  assert.equal(payment.payment_kind, 'full_amount');
  assert.equal(payment.currency, 'EUR');
  assert.equal(payment.amount_due_cents, 1500);
  assert.equal(payment.amount_paid_cents, 1500);
  assert.equal(new Date(payment.paid_at).toISOString(), '2026-09-26T12:00:00.000Z');
  assert.deepEqual(payment.metadata, {
    source: 'staff_cash', method: 'cash', idempotency_key: 'offline-1', note: 'Desk receipt',
    payment_date: '2026-09-26', recorded_by: 'offline-staff@example.invalid', staff_portal: true,
    payment_scope: 'guest', booking_guest_id: G1,
  });
  assert.equal(rows.booking_guests[0].amount_paid_cents, 1500);
  assert.equal(rows.booking_guests[0].payment_status, 'paid'); // Existing projection: receipt paid, not share settled.
  assert.equal(rows.booking_guests[1].amount_paid_cents, 0);
  assert.equal(rows.booking_guests[1].payment_status, 'not_requested');
  assert.equal(rows.bookings[0].amount_paid_cents, 1500);
  assert.equal(rows.bookings[0].balance_due_cents, 8500);
  assert.equal(rows.bookings[0].payment_status, 'deposit_paid');
  assert.equal(rows.bookings[0].status, 'confirmed');
  assert.equal(rows.bookings[0].deposit_paid_cents, 0);
  const locks = queries.filter(sql => /FOR UPDATE/i.test(sql));
  assert.match(locks[0], /FROM bookings/);
  assert.match(locks[1], /FROM booking_guests/);
  assert.equal(queries[0], 'BEGIN');
  assert.equal(queries.at(-1), 'COMMIT');
  console.log('READBACK:', JSON.stringify({ payment, guest: rows.booking_guests[0], booking: rows.bookings[0] }));
});

test('manual method is durably identified for bank transfer and legacy in-store', async () => {
  for (const method of ['bank_transfer', 'in_store']) {
    await reset();
    await service.recordStaffManualPayment(pg, intent({ method }));
    const { payments } = await snapshot();
    assert.equal(payments[0].metadata.method, method);
    assert.equal(payments[0].metadata.source, 'staff_' + method);
  }
});

test('All persists exactly one unallocated booking receipt without changing any guest', async () => {
  const before = await snapshot();
  const result = await service.recordStaffManualPayment(pg, intent({ paymentScope: 'booking', bookingGuestId: null }));
  const after = await snapshot();
  assert.equal(after.payments.length, 1);
  assert.equal(after.payments[0].booking_guest_id, null);
  assert.equal(after.payments[0].metadata.payment_scope, 'booking');
  assert.equal(after.payments[0].metadata.booking_guest_id, null);
  assert.deepEqual(after.booking_guests, before.booking_guests);
  assert.equal(result.booking_paid_cents, 1500);
  assert.equal(result.balance_due_cents, 8500);
});

test('tenant and booking membership failures roll back without writes', async () => {
  for (const overrides of [
    { bookingGuestId: G3 }, { bookingGuestId: G4 },
    { bookingGuestId: '30000000-0000-4000-8000-000000000099' },
    { clientSlug: 'sunset' }, { clientSlug: 'missing' },
    { bookingId: '20000000-0000-4000-8000-000000000099' },
  ]) {
    const before = await snapshot();
    const code = overrides.bookingGuestId ? 'booking_guest_not_found' : 'booking_not_found';
    await assert.rejects(service.recordStaffManualPayment(pg, intent(overrides)), err => err.code === code && err.httpStatus === 404);
    assert.deepEqual(await snapshot(), before);
    assert.equal(queries.at(-1), 'ROLLBACK');
  }
  // Both foreign keys can be individually valid while the tenant relationship is corrupt.
  await db.query('UPDATE booking_guests SET client_id=$1 WHERE id=$2', [C2,G1]);
  const before = await snapshot();
  await assert.rejects(service.recordStaffManualPayment(pg, intent()), err => err.code === 'booking_guest_not_found');
  assert.deepEqual(await snapshot(), before);
});

test('inactive booking is rejected from locked database truth with no writes', async () => {
  for (const status of ['cancelled', 'canceled', 'expired']) {
    await db.query('UPDATE bookings SET status=$1 WHERE id=$2', [status,B1]);
    const before = await snapshot();
    await assert.rejects(service.recordStaffManualPayment(pg, intent({ bookingStatus: 'confirmed' })),
      err => err.code === 'booking_not_active' && err.httpStatus === 400);
    assert.deepEqual(await snapshot(), before);
    assert.match(queries.at(-2), /FOR UPDATE OF b/);
    assert.equal(queries.at(-1), 'ROLLBACK');
  }
});

test('invalid manual payment input is rejected before SQL, never floored or silently changed', async () => {
  const invalid = [
    ...[0,-1,1.1,NaN,Infinity,-Infinity,'1500',true,null,undefined,2147483648,Number.MAX_SAFE_INTEGER].map(amountCents => ({ amountCents })),
    ...['stripe','',null,'constructor','toString'].map(method => ({ method })),
    ...['all','',null].map(paymentScope => ({ paymentScope })),
    { paymentScope: 'booking' }, { bookingGuestId: null }, { bookingGuestId: 'not-a-uuid' },
    { bookingId: 'not-a-uuid' }, { clientSlug: '' }, { clientSlug: null },
    { idempotencyKey: '' }, { idempotencyKey: null }, { idempotencyKey: 3 },
    { paymentDate: '2026-02-30' }, { paymentDate: '2026-13-01' }, { paymentDate: 'yesterday' },
    { note: {} },
  ];
  for (const overrides of invalid) {
    const before = await snapshot();
    const count = queries.length;
    await assert.rejects(service.recordStaffManualPayment(pg, intent(overrides)),
      err => err.code === 'invalid_manual_payment' && err.httpStatus === 400, JSON.stringify(overrides));
    assert.equal(queries.length, count, 'invalid intent must fail before BEGIN');
    assert.deepEqual(await snapshot(), before);
  }
  assert.equal(typeof service.validateStaffManualPayment, 'function');
  assert.throws(() => service.validateStaffManualPayment(null), err => err.httpStatus === 400);
});

test('legacy omitted scope and method default to booking cash with normalized optional audit fields', async () => {
  const raw = intent({ paymentScope: undefined, bookingGuestId: undefined, method: undefined,
    paymentDate: undefined, note: undefined, clientSlug: ' wolfhouse-somo ', idempotencyKey: ' legacy-1 ' });
  const clean = service.validateStaffManualPayment(raw);
  assert.equal(clean.paymentScope, 'booking');
  assert.equal(clean.bookingGuestId, null);
  assert.equal(clean.method, 'cash');
  assert.equal(clean.note, null);
  assert.equal(clean.paymentDate, null);
  assert.equal(clean.idempotencyKey, 'legacy-1');
  const before = await snapshot();
  await service.recordStaffManualPayment(pg, raw);
  const after = await snapshot();
  assert.equal(after.payments[0].metadata.source, 'staff_cash');
  assert.equal(after.payments[0].metadata.payment_date, new Date().toISOString().slice(0,10));
  assert.equal(after.payments[0].booking_guest_id, null);
  assert.deepEqual(after.booking_guests, before.booking_guests);
  const normalized = service.validateStaffManualPayment(intent({ method: ' BANK_TRANSFER ', note: ' x '.repeat(300) }));
  assert.equal(normalized.method, 'bank_transfer');
  assert.equal(normalized.note.length, 500);
  await assert.rejects(service.recordStaffManualPayment(pg, intent({ paymentScope: undefined })), err => err.httpStatus === 400);
  await assert.rejects(service.recordStaffManualPayment(pg, intent({ method: undefined })), err => err.httpStatus === 400);
});

test('same-intent retry reads its receipt inside locked transaction without duplicate writes', async () => {
  for (const scope of ['guest','booking']) {
    await reset();
    const input = intent({ paymentScope: scope, bookingGuestId: scope === 'guest' ? G1 : null });
    const first = await service.recordStaffManualPayment(pg, input);
    await service.recordStaffManualPayment(pg, { ...input, idempotencyKey: 'another-payment', amountCents: 2000 });
    if (scope === 'booking') { // Pre-existing handler metadata had no scope or guest keys.
      await db.query(`UPDATE payments SET metadata=metadata-'payment_scope'-'booking_guest_id' WHERE id=$1`, [first.payment.payment_id]);
    }
    const before = await snapshot();
    queries.length = 0;
    const retry = await service.recordStaffManualPayment(pg, { ...input, actorLabel: 'another-authorized-staff' });
    assert.equal(retry.idempotent, true);
    assert.equal(retry.payment.payment_id, first.payment.payment_id);
    assert.equal(retry.booking_paid_cents, 3500);
    assert.equal(retry.balance_due_cents, 6500);
    assert.deepEqual(await snapshot(), before);
    assert.equal(queries[0], 'BEGIN');
    const idemIndex = queries.findIndex(sql => sql.includes("metadata->>'idempotency_key'"));
    assert.ok(idemIndex > (scope === 'guest' ? 2 : 1), 'idem check follows booking/guest locks');
    assert.equal(queries.at(-1), 'COMMIT');
  }
});

test('changed intent or non-receipt idempotency key reuse conflicts without writes', async () => {
  await service.recordStaffManualPayment(pg, intent());
  for (const overrides of [
    { amountCents: 1501 }, { method: 'bank_transfer' }, { bookingGuestId: G2 },
    { paymentScope: 'booking', bookingGuestId: null }, { note: 'Changed note' }, { paymentDate: '2026-09-25' },
  ]) {
    const before = await snapshot();
    await assert.rejects(service.recordStaffManualPayment(pg, intent(overrides)),
      err => err.code === 'idempotency_conflict' && err.httpStatus === 409);
    assert.deepEqual(await snapshot(), before);
  }
  for (const change of [
    "status='cancelled'", "currency='USD'", "payment_kind='deposit_only'",
    "metadata=jsonb_set(metadata,'{source}','\"other_writer\"')",
    "metadata=jsonb_set(metadata,'{method}','\"bank_transfer\"')",
  ]) {
    await reset();
    await service.recordStaffManualPayment(pg, intent());
    await db.exec('UPDATE payments SET ' + change);
    const before = await snapshot();
    await assert.rejects(service.recordStaffManualPayment(pg, intent()), err => err.code === 'idempotency_conflict');
    assert.deepEqual(await snapshot(), before);
  }
  await reset();
  await service.recordStaffManualPayment(pg, intent());
  await db.exec(`INSERT INTO payments(client_id,booking_id,booking_guest_id,status,payment_kind,amount_due_cents,amount_paid_cents,metadata)
    SELECT client_id,booking_id,booking_guest_id,status,payment_kind,amount_due_cents,amount_paid_cents,metadata FROM payments`);
  const before = await snapshot();
  await assert.rejects(service.recordStaffManualPayment(pg, intent()), err => err.code === 'idempotency_conflict');
  assert.deepEqual(await snapshot(), before);
});

// Additional regression coverage of behavior already implemented above; not claimed as new RED cycles.
test('cumulative named receipts feed the existing checkout read model and preserve sibling truth', async () => {
  const checkout = require('./lib/per-guest-checkout');
  const first = await service.recordStaffManualPayment(pg, intent());
  await db.query('UPDATE booking_guests SET payment_id=$1,amount_paid_cents=999 WHERE id=$2', [first.payment.payment_id,G1]);
  await service.recordStaffManualPayment(pg, intent({ idempotencyKey: 'second', amountCents: 2000, method: 'bank_transfer' }));
  const after = await snapshot();
  assert.equal(after.payments.length, 2);
  assert.equal(after.booking_guests[0].amount_paid_cents, 3500, 'projection sums paid receipts, not stale cached value');
  assert.equal(after.booking_guests[0].payment_id, first.payment.payment_id, 'existing checkout pointer untouched');
  assert.equal(after.booking_guests[1].amount_paid_cents, 0);
  await pg.query('BEGIN');
  const row = await checkout.lockAndLoad(pg, G1, 'wolfhouse-somo');
  await pg.query('ROLLBACK');
  assert.equal(Number(row.amount_paid_cents), 3500);
  assert.equal(checkout.amountFor(row, 'deposit'), 0);
  assert.equal(checkout.amountFor(row, 'remaining_share'), 1500);
  console.log('CHECKOUT READBACK:', JSON.stringify({ guest_id: row.booking_guest_id, paid: row.amount_paid_cents,
    remaining: checkout.amountFor(row, 'remaining_share') }));
});

test('uncapped overpayment preserves booking credit and does not promote a hold', async () => {
  await db.query("UPDATE bookings SET status='hold' WHERE id=$1", [B1]);
  const result = await service.recordStaffManualPayment(pg, intent({ amountCents: 12500 }));
  const after = await snapshot();
  assert.equal(after.payments[0].amount_paid_cents, 12500);
  assert.equal(after.booking_guests[0].amount_paid_cents, 12500);
  assert.equal(after.bookings[0].amount_paid_cents, 12500);
  assert.equal(after.bookings[0].payment_status, 'paid');
  assert.equal(after.bookings[0].status, 'hold');
  assert.equal(after.bookings[0].deposit_paid_cents, 0);
  assert.equal(result.balance_due_cents, 0);
  assert.equal(after.bookings[0].amount_paid_cents - after.bookings[0].total_amount_cents, 2500);
});

test('legacy booking math keeps waiting-payment status on partial receipts and handles unknown totals', async () => {
  await db.query("UPDATE bookings SET payment_status='waiting_payment' WHERE id=$1", [B1]);
  await service.recordStaffManualPayment(pg, intent());
  assert.equal((await snapshot()).bookings[0].payment_status, 'waiting_payment');
  await reset();
  await db.query("UPDATE bookings SET total_amount_cents=NULL, metadata='{}' WHERE id=$1", [B1]);
  const result = await service.recordStaffManualPayment(pg, intent());
  assert.equal(result.balance_due_cents, 0);
  assert.equal((await snapshot()).bookings[0].payment_status, 'deposit_paid');
});

test('a real SQL failure after receipt and guest writes rolls the whole transaction back', async () => {
  await db.exec(`CREATE FUNCTION reject_manual_booking_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'offline forced booking projection failure'; END $$;
    CREATE TRIGGER offline_fail_booking_update BEFORE UPDATE ON bookings
      FOR EACH ROW EXECUTE FUNCTION reject_manual_booking_update();`);
  try {
    const before = await snapshot();
    await assert.rejects(service.recordStaffManualPayment(pg, intent()), /offline forced booking projection failure/);
    assert.deepEqual(await snapshot(), before);
    assert.equal(queries.at(-1), 'ROLLBACK');
  } finally {
    await db.exec('DROP TRIGGER offline_fail_booking_update ON bookings; DROP FUNCTION reject_manual_booking_update()');
  }
  assert.equal((await service.recordStaffManualPayment(pg, intent())).idempotent, false, 'same key can retry after rollback');
});

test('idempotency is booking and tenant scoped, and cancelled retries cannot write', async () => {
  await service.recordStaffManualPayment(pg, intent());
  await service.recordStaffManualPayment(pg, intent({ bookingId: B2, bookingGuestId: G3 }));
  await service.recordStaffManualPayment(pg, intent({ clientSlug: 'sunset', bookingId: B3, bookingGuestId: G4 }));
  assert.equal((await snapshot()).payments.length, 3);
  await db.query("UPDATE bookings SET status='expired' WHERE id=$1", [B1]);
  const before = await snapshot();
  await assert.rejects(service.recordStaffManualPayment(pg, intent()), err => err.code === 'booking_not_active');
  assert.deepEqual(await snapshot(), before);
});

test('omitted payment date retries keep the original receipt date rather than recalculating intent', async () => {
  const input = intent({ paymentDate: undefined });
  const first = await service.recordStaffManualPayment(pg, input);
  await db.query(`UPDATE payments SET metadata=jsonb_set(metadata,'{payment_date}','"2026-01-01"'),
    paid_at='2026-01-01T12:00:00Z' WHERE id=$1`, [first.payment.payment_id]);
  const before = await snapshot();
  const retry = await service.recordStaffManualPayment(pg, input);
  assert.equal(retry.idempotent, true);
  assert.deepEqual(await snapshot(), before);
});

test('year zero is rejected as invalid input before PostgreSQL can turn it into a server error', async () => {
  const before = await snapshot();
  const count = queries.length;
  await assert.rejects(service.recordStaffManualPayment(pg, intent({ paymentDate: '0000-01-01' })),
    err => err.code === 'invalid_manual_payment' && err.httpStatus === 400);
  assert.equal(queries.length, count);
  assert.deepEqual(await snapshot(), before);
});

(async () => {
  try {
    await schema();
    for (const item of tests) { await reset(); await item.run(); console.log('PASS:', item.name); }
    assert.equal(networkAttempts, 0);
    console.log(`PASS ${tests.length} real-SQL service cases; zero network/provider/messages. Single PGlite connection: no multi-session concurrency claim.`);
  } finally { if (db) await db.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
