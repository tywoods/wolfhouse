'use strict';

// Offline regression: real booking/payment SQL in disposable Postgres (PGlite),
// through the ordinary Guests handler. Unrelated CRM tables are stubbed empty.
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { createCustomersRoutes } = require('./lib/staff-customers-routes');
const { buildBookingListRow } = require('./lib/sunset-bookings-admin');
const { PAYMENTS_FOR_BOOKINGS_SQL } = require('./lib/sunset-bookings-admin-data');
const { buildPaymentSummary } = require('./lib/sunset-schedule-booking-drawer');
const { createInboxThreadCompositeRoutes } = require('./lib/staff-inbox-thread-composite');
const convQueries = require('./lib/staff-conversation-queries');
const inboxHelpers = require('./lib/staff-inbox-helpers');
const vm = require('node:vm');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const { hydrateStaffBookingDisplayTruth, staffBookingStayDates } = require('./lib/staff-booking-display-truth');

function shippedFunction(name) {
  const src = readStaffPortalUiSource();
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  return src.slice(start, src.indexOf('\n}', start) + 2);
}

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE clients (id uuid PRIMARY KEY, slug text);
      CREATE TABLE bookings (id uuid PRIMARY KEY, client_id uuid, booking_code text,
        guest_name text, phone text, check_in date, check_out date, status text,
        payment_status text, guest_count int, created_at timestamptz,
        total_amount_cents int, amount_paid_cents int, balance_due_cents int,
        metadata jsonb DEFAULT '{}');
      CREATE TYPE payment_record_status AS ENUM ('paid', 'checkout_created');
      CREATE TABLE payments (id uuid PRIMARY KEY, client_id uuid, booking_id uuid,
        status payment_record_status, amount_paid_cents int, paid_at timestamptz DEFAULT now(),
        finance_exclusion text, metadata jsonb DEFAULT '{}');
      CREATE TABLE booking_service_records (id uuid PRIMARY KEY, booking_id uuid,
        client_slug text, service_type text, service_date date, status text,
        amount_due_cents int, metadata jsonb DEFAULT '{}');
      INSERT INTO clients VALUES ('00000000-0000-0000-0000-000000000001','wolfhouse-somo');
      INSERT INTO bookings VALUES ('10000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000001','WH-TEST','Fixture guest','+34000000001',
        '2026-09-19','2026-09-23','confirmed','paid',1,now(),97500,97500,0,'{}');
      INSERT INTO payments (id, client_id, booking_id, status, amount_paid_cents) VALUES ('20000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','paid',32500);
    `);
    const pg = { query: async (sql, args) => {
      if (/FROM bookings b\b/.test(sql) && !/FROM customers|FROM conversations/.test(sql)) return db.query(sql, args);
      return { rows: [] };
    } };
    let response;
    const routes = createCustomersRoutes({
      sendJSON: (_res, status, body) => { response = { status, body }; },
      send400: () => { throw new Error('unexpected bad request'); },
      assertStaffClientAccess: () => true,
      appendAuditLog() {}, withPgClient: (fn) => fn(pg),
      DEFAULT_CLIENT: 'wolfhouse-somo', SQL_INJECT_RE: /;/,
    });
    await routes.handleCustomerContext('+34000000001', { client: 'wolfhouse-somo' }, {}, {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = response.body.bookings[0];
    assert.equal(row.payment_status, 'partial', 'Guests: settled deposit must override stale Paid booking enum');
    assert.equal(row.payment_amount_paid_cents, 32500);
    assert.equal(row.payment_amount_due_cents, 65000, 'whole balance, not latest link amount');
    console.log('PASS WH Guests: settled deposit → Partial / 65000 due');
    const ramiro = { booking_id: '10000000-0000-0000-0000-000000000002',
      total_amount_cents: 42000, amount_paid_cents: 42000, payment_status: 'paid',
      status: 'confirmed', check_in: '2026-09-19', check_out: '2026-09-20' };
    const services = [{ service_type: 'accommodation', service_date: '2026-09-19',
      amount_due_cents: 42000, status: 'confirmed',
      metadata: { staff_accommodation: true, check_in: '2026-09-19', check_out: '2026-09-23', nights: 4 } }];
    const list = buildBookingListRow({ booking: ramiro, services, collected_cents: 12000 });
    const invoice = buildPaymentSummary([], ramiro, services, 'fixture', 12000);
    assert.equal(invoice.paid_cents, list.paid_cents, 'invoice must not max stale stored Paid over ledger deposit');
    assert.equal(invoice.payment_status, list.status);
    assert.equal(list.check_out, '2026-09-23', 'Bookings dates use the accommodation invoice stay, not one-day shell');
    await db.query(`INSERT INTO clients VALUES ('00000000-0000-0000-0000-000000000002','sunset')`);
    await db.query(`INSERT INTO bookings VALUES ($1,'00000000-0000-0000-0000-000000000002',
      'SUN-TEST','Fixture guest','+340****0002','2026-09-19','2026-09-20','confirmed','waiting_payment',1,now(),42000,0,42000,'{}')`, [ramiro.booking_id]);
    await db.query(`INSERT INTO booking_service_records VALUES ('30000000-0000-0000-0000-000000000002',
      $1,'sunset','accommodation','2026-09-19','confirmed',42000,$2)`, [ramiro.booking_id, JSON.stringify(services[0].metadata)]);
    await db.query(`INSERT INTO payments (id, client_id, booking_id, status, amount_paid_cents) VALUES ('20000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000002',$1,'paid',12000)`, [ramiro.booking_id]);
    await routes.handleCustomerContext('+340****0002', { client: 'sunset' }, {}, {});
    assert.equal(response.status, 200);
    const sun = response.body.bookings[0];
    assert.equal(sun.payment_status, invoice.payment_status);
    assert.equal(sun.payment_amount_paid_cents, 12000);
    assert.equal(sun.payment_amount_due_cents, 30000);
    assert.equal(sun.check_out, list.check_out);
    console.log('PASS Sunset Guests / Bookings / invoice: Partial, 12000 paid / 30000 due, Sep 19–23');
    const unpaidInvoice = buildPaymentSummary([], { ...ramiro, amount_paid_cents: 0 }, services, 'fixture', 0);
    assert.equal(unpaidInvoice.payment_status, 'unpaid', 'zero paid must not trust a stale paid enum');
    const ui = vm.createContext({
      BC_RUNNING_INVOICE_ACCOMM_CODES: { guest_package: true },
      bcServiceRecordBillableCents: (r) => r.amount_due_cents || 0,
      bcSumActiveTransferChargesCents: () => 0,
      bcPaymentLedgerPaidTotalCents: (rs) => rs.filter((r) => r.payment_status === 'paid').reduce((s, r) => s + r.amount_paid_cents, 0),
      bcPaymentLedgerIsPaidStatus: (s) => s === 'paid',
      staffPaymentDisplayStatus: require('./lib/staff-booking-display-truth').staffPaymentDisplayStatus,
    });
    vm.runInContext(shippedFunction('bcRunningInvoiceAccommodationCents') + '\n' + shippedFunction('bcComputeBookingInvoiceTotals'), ui);
    ui.bcInvoiceAccCentsWithSupplement = ui.bcRunningInvoiceAccommodationCents;
    for (const quoted of [0, 97500]) {
      const b = { ...row, metadata: { quote_snapshot: { line_items: [{ code: 'guest_package', total_cents: quoted }] } } };
      const invoiceTruth = ui.bcComputeBookingInvoiceTotals(b, [{ amount_due_cents: 30000 }], {
        rows: [{ payment_status: 'paid', amount_paid_cents: 32500 }], latest_status: 'paid',
      }, [], []);
      assert.equal(invoiceTruth.invoiceTotal, 97500, 'WH invoice retains canonical total and counts bundled services once');
      assert.equal(invoiceTruth.balanceDue, row.balance_due_cents);
      assert.equal(invoiceTruth.payStatus, 'partial', 'WH overview/invoice chip derives from amounts, not Paid deposit-link row');
    }
    const stalePaid = ui.bcComputeBookingInvoiceTotals({ total_amount_cents: 10000, payment_status: 'paid' }, [], { amount_paid_cents: 0 });
    assert.equal(stalePaid.payStatus, 'unpaid');
    const manualPaid = ui.bcComputeBookingInvoiceTotals({ total_amount_cents: 10000, amount_paid_cents: 5000 }, [], {
      rows: [{ payment_status: 'checkout_created', amount_paid_cents: 0 }], amount_paid_cents: 0,
    });
    assert.equal(manualPaid.payStatus, 'partial', 'WH legacy/manual stored amount fallback matches Bookings when no settled rows exist');
    console.log('PASS WH invoice / Overview: canonical total, settled paid, computed chip');
    for (const paid of [0, 12000, 42000, 45000]) {
      const b = { ...ramiro, amount_paid_cents: paid, payment_status: paid ? 'unpaid' : 'paid' };
      const listRow = buildBookingListRow({ booking: b, services, collected_cents: paid });
      const summary = buildPaymentSummary([], b, services, 'fixture', paid, null, { paid_rows: [{ amount_paid_cents: paid }] });
      assert.equal(summary.payment_status, listRow.status);
      assert.equal(summary.balance_due_cents, listRow.outstanding_cents);
    }
    assert.equal(buildPaymentSummary([], ramiro, services, 'fixture', 0, null, { paid_rows: [{ amount_paid_cents: 0 }] }).payment_status, 'unpaid');
    await db.query(`INSERT INTO payments (id, client_id, booking_id, status, amount_paid_cents) VALUES ('20000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000002',$1,'checkout_created',42000)`, [ramiro.booking_id]);
    await db.query(`INSERT INTO payments (id, client_id, booking_id, status, amount_paid_cents) VALUES ('20000000-0000-0000-0000-000000000004',
      '00000000-0000-0000-0000-000000000001',$1,'paid',42000)`, [ramiro.booking_id]);
    await db.query(`INSERT INTO booking_service_records VALUES ('30000000-0000-0000-0000-000000000004',
      $1,'wolfhouse-somo','accommodation','2026-09-19','confirmed',99999,$2)`,
    [ramiro.booking_id, JSON.stringify({ staff_accommodation: true, check_in: '2026-09-19', check_out: '2026-10-30' })]);
    const scoped = { booking_id: ramiro.booking_id };
    await hydrateStaffBookingDisplayTruth(pg, 'sunset', [scoped]);
    assert.equal(scoped.amount_paid_cents, 12000, 'pending and foreign-client payment rows excluded');
    assert.equal(scoped.check_out, '2026-09-23', 'foreign-client service excluded');
    const denied = { booking_id: ramiro.booking_id };
    await hydrateStaffBookingDisplayTruth(pg, 'wolfhouse-somo', [denied]);
    assert.deepEqual(denied, { booking_id: ramiro.booking_id }, 'foreign booking not projected');
    for (const metadata of ['null', '{bad', { accommodation: { stays: {} } }]) {
      assert.deepEqual(staffBookingStayDates({ ...ramiro, metadata }, []), { check_in: ramiro.check_in, check_out: ramiro.check_out });
    }
    const multi = [...services, { ...services[0], metadata: { staff_accommodation: true, check_in: '2026-10-01', check_out: '2026-10-03' } }];
    assert.deepEqual(staffBookingStayDates(ramiro, multi), { check_in: ramiro.check_in, check_out: ramiro.check_out }, 'multi-stays are not flattened into invented dates');
    console.log('PASS zero / partial / paid / overpaid, pending and tenant fences, malformed/multi-stay metadata');

    const browserFixtures = { 'wolfhouse-somo': [row], sunset: [sun] };
    for (const [client, original] of [['wolfhouse-somo', row], ['sunset', sun]]) {
      for (const excluded of [
        { label: 'finance-excluded', finance: 'fixture exclusion', paidAt: '2026-09-19', metadata: {} },
        { label: 'missing paid_at', finance: null, paidAt: null, metadata: {} },
        { label: 'test-cancelled', finance: null, paidAt: '2026-09-19', metadata: { test_booking_cancelled: true } },
        { label: 'schedule-deleted', finance: null, paidAt: '2026-09-19', metadata: { schedule_booking_deleted: true } },
      ]) {
        await db.exec('BEGIN');
        try {
          await db.query(`INSERT INTO payments
            SELECT '20000000-0000-0000-0000-000000000005', client_id, id, 'paid', $2, $3, $4, $5
            FROM bookings WHERE id = $1`, [original.booking_id, original.balance_due_cents,
            excluded.paidAt, excluded.finance, JSON.stringify(excluded.metadata)]);
          const collected = (await db.query(PAYMENTS_FOR_BOOKINGS_SQL, [client, [original.booking_id]])).rows[0].collected_cents;
          const phone = (await db.query('SELECT phone FROM bookings WHERE id = $1', [original.booking_id])).rows[0].phone;
          await routes.handleCustomerContext(phone, { client }, {}, {});
          assert.equal(response.status, 200);
          const guest = response.body.bookings[0];
          assert.equal(guest.payment_status, 'partial', client + ' Guests must ignore ' + excluded.label);
          assert.equal(guest.amount_paid_cents, Number(collected), client + ' Guests/Bookings eligible ledger parity');
          assert.equal(guest.balance_due_cents, original.balance_due_cents);
          browserFixtures[client].push({ ...guest, fixture_label: excluded.label });
          console.log('PASS ' + client + ' actual Guests/Bookings SQL: ' + excluded.label + ' ignored');
        } finally { await db.exec('ROLLBACK'); }
      }
      for (const customDiscount of [0, -1000]) {
        await db.exec('BEGIN');
        try {
          await db.query('UPDATE bookings SET total_amount_cents = NULL WHERE id = $1', [original.booking_id]);
          await db.query('DELETE FROM booking_service_records WHERE booking_id = $1 AND client_slug = $2', [original.booking_id, client]);
          const persisted = [
            { amount: original.total_amount_cents, status: 'confirmed', metadata: services[0].metadata },
            { amount: 0, status: 'confirmed', metadata: { unit_amount_cents: 99999 } },
            { amount: 99999, status: 'cancelled', metadata: {} },
            { amount: 0, status: 'confirmed', metadata: { staff_custom_line: true, amount_cents: customDiscount } },
          ];
          for (const [index, service] of persisted.entries()) {
            await db.query(`INSERT INTO booking_service_records
              VALUES ($1, $2, $3, 'accommodation', '2026-09-19', $4, $5, $6)`,
            ['30000000-0000-0000-0000-00000000001' + index, original.booking_id, client,
              service.status, service.amount, JSON.stringify(service.metadata)]);
          }
          const booking = (await db.query('SELECT * FROM bookings WHERE id = $1', [original.booking_id])).rows[0];
          const records = (await db.query('SELECT * FROM booking_service_records WHERE booking_id = $1 AND client_slug = $2', [original.booking_id, client])).rows;
          const collected = Number((await db.query(PAYMENTS_FOR_BOOKINGS_SQL, [client, [original.booking_id]])).rows[0].collected_cents);
          const bookingList = buildBookingListRow({ booking, services: records, collected_cents: collected });
          const summary = buildPaymentSummary([], booking, records, 'fixture', collected);
          await routes.handleCustomerContext(booking.phone, { client }, {}, {});
          assert.equal(response.status, 200);
          const guest = response.body.bookings[0];
          assert.equal(guest.payment_status, 'partial', client + ' missing total must use persisted service totals');
          assert.equal(guest.total_amount_cents, original.total_amount_cents + customDiscount);
          assert.equal(guest.total_amount_cents, bookingList.total_cents);
          assert.equal(guest.payment_status, bookingList.status);
          assert.equal(guest.balance_due_cents, bookingList.outstanding_cents);
          assert.equal(guest.balance_due_cents, summary.balance_due_cents);
          assert.equal(guest.payment_status, summary.payment_status);
          browserFixtures[client].push({ ...guest, fixture_label: 'missing booking total / discount ' + customDiscount });
          console.log('PASS ' + client + ' missing total: persisted services, zero/cancelled peers, signed custom ' + customDiscount);
        } finally { await db.exec('ROLLBACK'); }
      }
    }

    for (const client of ['wolfhouse-somo', 'sunset']) {
      const bookingId = client === 'sunset' ? ramiro.booking_id : row.booking_id;
      const raw = { booking_id: bookingId, booking_status: 'confirmed', booking_payment_status: 'paid',
        payment_amount_paid_cents: 0, payment_amount_due_cents: 12000, check_out: '2026-09-20' };
      const contextSql = convQueries.getConversationContextQuery();
      const bookingsSql = convQueries.getConversationBookingsQuery();
      const detailSql = convQueries.getConversationDetailQuery();
      const inboxPg = { query: async (sql, args) => {
        if (sql === detailSql) return { rows: [{ conversation_id: 'fixture', phone: 'fixture' }] };
        if (sql === contextSql || sql === bookingsSql) return { rows: [{ ...raw }] };
        return pg.query(sql, args);
      } };
      const deps = { ...inboxHelpers,
        sendJSON: (_res, status, body) => { response = { status, body }; },
        send400: () => { throw new Error('unexpected 400'); }, send404: () => { throw new Error('unexpected 404'); },
        assertStaffClientAccess: () => true, appendAuditLog() {},
        withPgClient: (fn) => fn(inboxPg), DEFAULT_CLIENT: client, SQL_INJECT_RE: /;/,
        resolveSunsetConversationScope: () => ({ queryOpts: {} }),
        conversationDetailQueryParams: (slug, id) => [slug, id],
      };
      const composite = createInboxThreadCompositeRoutes(deps);
      await composite.handleInboxThreadComposite('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', { client }, {}, {});
      assert.equal(response.status, 200);
      assert.equal(response.body.context.context.booking_payment_status, 'partial', client + ' composite context');
      assert.equal(response.body.context.bookings[0].booking_payment_status, 'partial', client + ' composite stack');
      const box = vm.createContext({ ...deps, ...convQueries,
        hydrateStaffBookingDisplayTruth: require('./lib/staff-booking-display-truth').hydrateStaffBookingDisplayTruth });
      vm.runInContext('async ' + shippedFunction('handleConversationContext'), box);
      await box.handleConversationContext('fixture', { client }, {}, {});
      assert.equal(response.body.context.booking_payment_status, 'partial', client + ' standalone context');
      assert.equal(response.body.bookings[0].booking_payment_status, 'partial', client + ' standalone stack');
      assert.equal(response.body.context.payment_amount_due_cents, client === 'sunset' ? 30000 : 65000);
      console.log('PASS ' + client + ' composite + standalone Inbox context');
    }
    await require('./verify-staff-payment-status-truth-ui').verifyRenderedPaymentTruth(browserFixtures);
    await require('./verify-staff-payment-status-truth-invoice').verifyInvoiceTruth();
  } finally { await db.close(); }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
