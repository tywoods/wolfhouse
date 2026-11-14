#!/usr/bin/env node
'use strict';

/** BC-L07/C20 PREP ONLY — intentionally RED, not a release/merge gate.
 * Base: S12 #1718 25b0c18e60bac77f048169c011338163d31fcb91.
 * node scripts/verify-l07-receipt-status-prep.js [--case=<name>]
 * Requires repository-pinned @electric-sql/pglite (NODE_PATH is supported).
 *
 * Actual create INSERT/COMMIT, receipt policy, event-claim SQL and webhook
 * transaction phase run unchanged. Reduced support schema uses the existing
 * network-fenced seed, committed migrations and explicit missing transport
 * columns below. HTTP/signature/lookup/confirmation/audit edges are fixtures.
 * No live DB/provider, extra receipt ledger, production patch, or retry.
 * The VM spy calls the real S12 producer and rethrows the identical exception.
 * Diagnostic medium/field names are deliberately not prescribed: returned or
 * logged diagnostics must expose the reviewed code/operation/SQLSTATE contract.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
// Import installs a network fence before loading application modules.
const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
const { PGlite } = require('@electric-sql/pglite');
const create = require('./lib/luna-front-desk-accommodation-booking-create-service');
const status = require('./lib/booking-guest-payment-status');
const claims = require('./lib/stripe-webhook-event-claim');

const ROOT = path.resolve(__dirname, '..');
const SLUG = 'wolfhouse-somo';
const EVENT = 'offline_l07_receipt_event';
const SESSION = 'offline_l07_checkout';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cases = ['healthy-receipt', 'catch-alone-is-aborted', 'required-receipt-fault',
  'optional-projection-keeps-receipt', 'optional-projection-is-observable'];
const flat = sql => String(sql).replace(/\s+/g, ' ').trim();

async function fixture() {
  const db = new PGlite();
  const f = { db, calls: [], sqlErrors: [], nativeErrors: [], producerErrors: [], logs: [], receiptSeenBeforeFault: null };
  f.pg = { async query(sql, params) {
    const text = flat(sql);
    f.calls.push(text);
    if (/^UPDATE booking_guests bg/.test(text) && text.includes('payment_status')) {
      f.receiptSeenBeforeFault = (await db.query('SELECT status,amount_paid_cents FROM payments WHERE id=$1',
        [id(72)])).rows[0];
    }
    try {
      const result = await db.query(sql, params);
      return { ...result, rowCount: result.affectedRows, rows: structuredClone(result.rows) };
    } catch (error) { f.sqlErrors.push(error.code); f.nativeErrors.push(error); throw error; }
  } };
  try {
    const payload = { confirm: true, check_in: '2026-07-06', check_out: '2026-07-09',
      guest_count: 2, guest_name: 'Offline L07 lead',
      guests: [{ name: 'Offline L07 lead' }, { name: 'Offline L07 companion' }],
      phone: '+999' + '88000701', package_code: 'package_none', room_type: 'shared',
      group_gender: 'mixed', selected_bed_codes: ['R3-B1', 'R3-B2'], payment_choice: 'deposit' };
    await seedOfflineBookingDb(db, payload);
    await db.exec(fs.readFileSync(path.join(ROOT, 'database/migrations/136_wolfhouse_package_default_nights.sql'), 'utf8'));
    // Production-shaped columns/types omitted by the existing reduced seed.
    await db.exec(`ALTER TYPE booking_status ADD VALUE 'payment_pending';
      ALTER TYPE payment_record_status ADD VALUE 'checkout_created';
      ALTER TYPE payment_record_status ADD VALUE 'paid';
      ALTER TYPE payment_status ADD VALUE 'paid';
      ALTER TYPE payment_status ADD VALUE 'waiting_payment';
      ALTER TYPE payment_status ADD VALUE 'payment_link_sent';
      ALTER TABLE payments ADD COLUMN amount_paid_cents integer DEFAULT 0;
      ALTER TABLE payments ADD COLUMN paid_at timestamptz;
      ALTER TABLE payments ADD COLUMN stripe_checkout_session_id text;
      ALTER TABLE payments ADD COLUMN stripe_payment_intent_id text;
      ALTER TABLE bookings ADD COLUMN amount_paid_cents integer DEFAULT 0;
      ALTER TABLE bookings ADD COLUMN hold_expires_at timestamptz;`);
    // Existing event ledger, not a new receipt table. Apply its committed 001
    // CREATE shape with the documented 003 hostel->client rename in this seed.
    const migration = fs.readFileSync(path.join(ROOT, 'database/migrations/001_init.sql'), 'utf8');
    const eventTable = migration.match(/CREATE TABLE payment_events \([\s\S]*?\n\);/);
    assert.ok(eventTable, 'anchor existing payment_events migration');
    await db.exec(eventTable[0].replace(/hostel_id/g, 'client_id').replace(/REFERENCES hostels\(/g, 'REFERENCES clients('));
    const built = await create.buildWolfhouseBookingCreateCommand({
      channel: create.BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP, trustedClientSlug: SLUG,
      transportBody: payload, pgClient: f.pg });
    assert.equal(built.ok, true, 'unchanged real booking builder');
    const saved = await create.executeWolfhouseBookingCreate(f.pg, built.command, {
      stripeConfig: { stripeLinksEnabled: false } });
    assert.equal(saved.ok, true, 'unchanged real booking INSERT');
    f.booking = (await db.query('SELECT * FROM bookings')).rows[0];
    f.guests = (await db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows;
    assert.equal(f.booking.id, saved.body.booking_id);
    assert.equal(f.guests.length, 2);
    assert.ok(f.calls.includes('COMMIT'), 'real create committed before receipt');
    // Remove only fixture-created drafts; seed explicit historical receipt and
    // an existing unpaid checkout. Receipt processing must not add another row.
    await db.exec('DELETE FROM payments');
    for (const [paymentId, state, due, paid, guest] of [
      [id(71), 'paid', 1000, 1000, f.guests[0].id],
      [id(72), 'checkout_created', 2000, 0, null],
    ]) await db.query(`INSERT INTO payments(id,client_id,booking_id,booking_guest_id,status,
      payment_kind,currency,amount_due_cents,amount_paid_cents,paid_at,stripe_checkout_session_id,metadata)
      VALUES($1,$2,$3,$4,$5::payment_record_status,'deposit_only','EUR',$6,$7,
        CASE WHEN $5::text='paid' THEN '2025-01-01'::timestamptz ELSE NULL END,$8,$9::jsonb)`,
    [paymentId, f.booking.client_id, f.booking.id, guest, state, due, paid,
      paymentId === id(72) ? SESSION : 'offline_l07_historical_checkout',
      JSON.stringify({ source: 'offline_l07_fixture', historical: state === 'paid' })]);
    await db.query(`UPDATE booking_guests SET payment_status='paid',amount_paid_cents=1000,payment_id=$1
      WHERE id=$2`, [id(71), f.guests[0].id]);
    await db.query(`UPDATE bookings SET amount_paid_cents=1000,balance_due_cents=total_amount_cents-1000,
      payment_status='deposit_paid' WHERE id=$1`, [f.booking.id]);
    f.history = (await db.query('SELECT * FROM payments WHERE id=$1', [id(71)])).rows;
    f.paidGuest = (await db.query('SELECT * FROM booking_guests WHERE id=$1', [f.guests[0].id])).rows;
    f.beds = (await db.query('SELECT * FROM booking_beds ORDER BY bed_code')).rows;
    f.pm = { payment_id: id(72), booking_id: f.booking.id, client_id: f.booking.client_id,
      client_slug: SLUG, payment_status: 'checkout_created', payment_kind: 'deposit_only',
      currency: 'EUR', amount_due_cents: 2000, booking_guest_id: null };
    f.session = { id: SESSION, payment_intent: 'offline_l07_intent', amount_total: 2000,
      currency: 'eur', metadata: { payment_id: id(72) } };
    f.calls.length = 0;
    return f;
  } catch (error) { await db.close(); throw error; }
}

async function injectFault(f, required = false) {
  // Real PostgreSQL exception, only after the primary payment/booking writes.
  const table = required ? 'payments' : 'booking_guests';
  const condition = required ? `NEW.id='${id(72)}' AND NEW.status='paid'`
    : `NEW.id='${f.guests[1].id}' AND NEW.payment_status IN ('deposit_paid','paid')`;
  await f.db.exec(`CREATE FUNCTION l07_projection_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'offline L07 injected SQL failure' USING ERRCODE='23514',
      CONSTRAINT='l07_injected_status_fault'; END; $$;
    CREATE TRIGGER l07_fault BEFORE UPDATE ON ${table} FOR EACH ROW
      WHEN (${condition}) EXECUTE FUNCTION l07_projection_fault();`);
}

function observedPolicy(f) {
  const filename = path.join(__dirname, 'lib/stripe-hold-promote-policy.js');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const spy = async (...args) => {
    try { return await status.markGuestsPaidForBookingPayment(...args); }
    catch (error) { f.producerErrors.push(error); throw error; }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process,
    console: { warn: (...args) => f.logs.push(args), error: (...args) => f.logs.push(args),
      log: (...args) => f.logs.push(args) },
    require: name => name === './booking-guest-payment-status'
      ? { ...status, markGuestsPaidForBookingPayment: spy } : nativeRequire(name),
  }, { filename });
  return module.exports;
}

async function webhookTransaction(f) {
  const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  const startMarker = '// ── 7–9. Shared payment-truth apply';
  const endMarker = '  const reconcileSimulatorConfirmation = async () => {';
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  assert.ok(start > source.indexOf('async function handleStripeWebhook(') && end > start,
    'extract unchanged actual webhook receipt transaction, not a rewritten catch');
  assert.equal(source.indexOf(startMarker, start + 1), -1, 'unique extraction start');
  const policy = observedPolicy(f);
  const run = vm.runInNewContext('(async () => {\n' + source.slice(start, end)
    + '\nreturn { completedTransactionPhase: true, paymentTruthResult };\n})', {
    ...claims, pm: f.pm, session: f.session, sessionId: SESSION,
    event: { id: EVENT, type: 'checkout.session.completed', livemode: false },
    eventType: 'checkout.session.completed', lookup: { lookup_path: 'offline_exact_payment_id' },
    process, STRIPE_WEBHOOK_SKIP_VERIFY: false,
    applyStripeBookingPaymentTruthWrites: policy.applyStripeBookingPaymentTruthWrites,
    isLockedPaymentValidationError: policy.isLockedPaymentValidationError,
    withPgClient: async work => work(f.pg),
    buildPaymentConfirmationDraft: () => null, bookingMetadataPatchForStripePayment: () => null,
    appendAuditLog: record => f.logs.push(record),
    sendJSON: (_res, httpStatus, body) => ({ httpStatus, body }), res: {},
    console: { warn: (...args) => f.logs.push(args), error: (...args) => f.logs.push(args) },
  }, { filename: 'unchanged-handleStripeWebhook-transaction-phase.js' });
  return run();
}

async function readback(f) {
  // Direct new SELECTs, bypassing all application/spying adapters after txn end.
  return {
    booking: (await f.db.query('SELECT id,status,payment_status,amount_paid_cents,balance_due_cents,total_amount_cents FROM bookings')).rows,
    payments: (await f.db.query('SELECT * FROM payments ORDER BY id')).rows,
    events: (await f.db.query('SELECT stripe_event_id,processed FROM payment_events')).rows,
    guests: (await f.db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows,
    beds: (await f.db.query('SELECT * FROM booking_beds ORDER BY bed_code')).rows,
  };
}

function assertHistory(f, rows) {
  assert.deepEqual(rows.payments.filter(row => row.id === id(71)), f.history, 'paid receipt history unchanged');
  assert.deepEqual(rows.guests.filter(row => row.id === f.guests[0].id), f.paidGuest, 'paid guest never downgraded');
  assert.deepEqual(rows.beds, f.beds, 'booking bed rows unchanged');
  assert.equal(rows.payments.length, 2, 'no new payment/provider attempt row');
  assert.equal(rows.booking.length, 1, 'real saved booking retained');
}

function assertCommittedReceipt(f, rows, outcome) {
  const receipt = rows.payments.find(row => row.id === id(72));
  // This is the intended RED, independent of COMMIT resolving after an abort.
  assert.equal(receipt.status, 'paid', 'optional status failure must not erase the real primary receipt');
  assert.equal(receipt.amount_paid_cents, 2000);
  assert.ok(receipt.paid_at);
  assert.equal(receipt.stripe_payment_intent_id, f.session.payment_intent);
  assert.equal(receipt.metadata.stripe_event_id, EVENT);
  assert.equal(rows.booking[0].id, f.booking.id);
  assert.equal(rows.booking[0].status, f.booking.status);
  assert.equal(rows.booking[0].total_amount_cents, f.booking.total_amount_cents, 'no repricing during projection recovery');
  assert.equal(rows.booking[0].amount_paid_cents, 3000);
  assert.equal(rows.booking[0].balance_due_cents, rows.booking[0].total_amount_cents - 3000);
  assert.equal(rows.booking[0].payment_status, 'deposit_paid');
  assert.deepEqual(rows.events, [{ stripe_event_id: EVENT, processed: true }]);
  assert.equal(outcome.completedTransactionPhase, true);
  assert.equal(f.calls.filter(sql => sql === 'COMMIT').length, 1);
  assert.equal(f.calls.filter(sql => sql === 'BEGIN').length, 1, 'one webhook transaction, no retry');
  assert.equal(f.calls.filter(sql => sql.startsWith('UPDATE payments ')).length, 1, 'one primary receipt mutation');
  assert.equal(f.calls.filter(sql => sql.startsWith('INSERT INTO payment_events ')).length, 1, 'one existing event claim');
  assert.equal(f.calls.includes('ROLLBACK'), false, 'no outer rollback after optional fault');
  assertHistory(f, rows);
}

function hasProjectionDiagnostic(value, seen = new Set()) {
  if (typeof value === 'string') return value.includes('GUEST_PAYMENT_STATUS_PROJECTION_FAILED')
    && value.includes('booking_payment_paid') && /\b23514\b/.test(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (value.code === 'GUEST_PAYMENT_STATUS_PROJECTION_FAILED'
      && value.operation === 'booking_payment_paid'
      && (value.sqlstate === '23514' || value.cause?.code === '23514')) return true;
  return Object.values(value).some(item => hasProjectionDiagnostic(item, seen));
}

async function runCase(name) {
  assert.equal(typeof status.GuestPaymentStatusProjectionError, 'function', 'real reviewed S12 producer required');
  const f = await fixture();
  try {
    if (name === 'catch-alone-is-aborted') {
      await injectFault(f);
      await f.pg.query('BEGIN');
      await f.pg.query("UPDATE payments SET status='paid',amount_paid_cents=2000 WHERE id=$1", [id(72)]);
      let caught;
      try {
        await status.markGuestsPaidForBookingPayment(f.pg, { clientId: f.pm.client_id,
          bookingId: f.pm.booking_id, paymentId: f.pm.payment_id, paymentStatus: 'deposit_paid' });
      } catch (error) { caught = error; }
      assert.ok(caught instanceof status.GuestPaymentStatusProjectionError);
      assert.equal(caught.code, 'GUEST_PAYMENT_STATUS_PROJECTION_FAILED');
      assert.equal(caught.operation, 'booking_payment_paid');
      assert.equal(caught.cause.code, '23514');
      assert.equal(caught.cause.constraint, 'l07_injected_status_fault');
      assert.equal(caught.cause, f.nativeErrors[0], 'S12 preserves original PostgreSQL cause identity');
      assert.equal(f.calls.some(sql => /^(SAVEPOINT|ROLLBACK TO|RELEASE SAVEPOINT)/.test(sql)), false,
        'producer does not secretly take transaction ownership');
      await assert.rejects(f.pg.query('SELECT 1'), error => error.code === '25P02');
      await f.pg.query('COMMIT'); // PostgreSQL can resolve this by rolling back!
      const rows = await readback(f);
      assert.equal(rows.payments.find(row => row.id === id(72)).status, 'checkout_created');
      assertHistory(f, rows);
      console.log('PASS catch-alone-is-aborted: real S12 error + 25P02; COMMIT did not preserve receipt');
      return;
    }
    if (name !== 'healthy-receipt') await injectFault(f, name === 'required-receipt-fault');
    const outcome = await webhookTransaction(f);
    const rows = await readback(f);
    assertHistory(f, rows);
    if (name === 'required-receipt-fault') {
      assert.equal(outcome.httpStatus, 500, 'required receipt write fault is never success');
      assert.equal(rows.payments.find(row => row.id === id(72)).status, 'checkout_created');
      assert.deepEqual(rows.events, [], 'failed required write never marks event processed');
      assert.equal(f.calls.includes('COMMIT'), false);
      assert.equal(f.calls.filter(sql => sql === 'ROLLBACK').length, 1);
      assert.equal(f.producerErrors.length, 0, 'required failure precedes optional S12 writer');
      assert.deepEqual(f.sqlErrors, ['23514']);
      console.log('PASS required-receipt-fault: real SQL failure rolls back, no false receipt');
      return;
    }
    if (name !== 'healthy-receipt') {
      assert.equal(f.producerErrors.length, 1, 'one native S12 producer attempt, no retry');
      const error = f.producerErrors[0];
      assert.ok(error instanceof status.GuestPaymentStatusProjectionError);
      assert.equal(error.code, 'GUEST_PAYMENT_STATUS_PROJECTION_FAILED');
      assert.equal(error.operation, 'booking_payment_paid');
      assert.equal(error.cause.code, '23514');
      assert.equal(error.cause.constraint, 'l07_injected_status_fault');
      assert.equal(error.cause, f.nativeErrors[0], 'actual SQL fault, not a fabricated producer response');
      assert.equal(f.receiptSeenBeforeFault.status, 'paid', 'primary receipt really persisted inside txn before fault');
      assert.equal(f.receiptSeenBeforeFault.amount_paid_cents, 2000);
      console.log(JSON.stringify({ case: name, producer: error.code, operation: error.operation,
        sqlstate: error.cause.code, primary_receipt_before_fault: f.receiptSeenBeforeFault.status,
        receipt_after_transaction: rows.payments.find(row => row.id === id(72)).status,
        commits: f.calls.filter(sql => sql === 'COMMIT').length,
        outer_rollbacks: f.calls.filter(sql => sql === 'ROLLBACK').length,
        event_rows: rows.events.length }));
    }
    if (name === 'optional-projection-is-observable') {
      // Spy observations are NOT counted: only actual consumer result/logs.
      assert.ok(hasProjectionDiagnostic([outcome, f.logs]),
        'consumer must expose reviewed projection code + operation + SQLSTATE, not silently catch');
    }
    assertCommittedReceipt(f, rows, outcome);
    if (name === 'healthy-receipt') {
      assert.equal(rows.guests[1].payment_status, 'deposit_paid');
      assert.deepEqual(f.sqlErrors, []);
    } else {
      assert.equal(rows.guests[1].payment_status, 'not_requested', 'failed optional copy stays unchanged');
      assert.deepEqual(f.sqlErrors, ['23514'], 'recovery must clear abort before further required SQL');
    }
    console.log(`PASS ${name}: real webhook receipt COMMIT + independent SELECT; paid history retained`);
  } finally { await f.db.close(); }
}

async function main() {
  const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
  if (selected) { assert.ok(cases.includes(selected), 'known named case'); return runCase(selected); }
  let failures = 0;
  for (const name of cases) {
    // One bounded child per case, never retries; isolate PGlite WASM lifetimes.
    const child = spawnSync(process.execPath, [...process.execArgv, __filename, `--case=${name}`], { stdio: 'inherit' });
    assert.equal(child.signal, null, `${name}: infrastructure signal is not an intended contract RED`);
    if (child.error) throw child.error;
    if (child.status !== 0) failures++;
  }
  console.log(`L07 PREP: ${cases.length - failures} passed, ${failures} failed; intentional RED is not merge-ready`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(error => {
  // No query/parameters/raw PostgreSQL object or connection/environment dump.
  console.error(`${error.name || 'Error'}: ${error.code || ''} ${error.message}`);
  process.exitCode = 1;
});
