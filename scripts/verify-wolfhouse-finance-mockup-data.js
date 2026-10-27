'use strict';
// Part 1: real Finance producer + real embedded PostgreSQL; no network or live writes.
const assert = require('assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { computeWolfhouseCreatorFinance: compute, pageWolfhouseCreatorFinance: page } = require('./lib/sunset-finance-summary');
const { fetchLodgingFinanceData: fetchData } = require('./lib/sunset-finance-data');
const { bookingLedgerInvoicePaidBalance } = require('./lib/booking-invoice-totals');
const { serviceRecordBillableCents, isAdditionalInvoiceService } = require('./lib/staff-booking-services-schedule');
const { sumActiveTransferChargesCents } = require('./lib/booking-invoice-totals');
const now = new Date('2026-10-27T12:00:00Z');
const context = { now, view: { granularity: 'month', anchor: '2026-10-27' }, clientSlug: 'wolfhouse-somo', currency: 'EUR' };
const booking = (id, amount = 10001, source = 'luna_guest', extra = {}) => ({
  booking_id: id, total_amount_cents: amount, created_at: '2026-10-03T12:00:00Z',
  status: 'confirmed', currency: 'EUR', metadata: { source }, ...extra,
});
const service = (id, amount, inclusion = 'additional', extra = {}) => ({
  service_record_id: id, booking_id: 'luna', client_slug: 'wolfhouse-somo',
  amount_due_cents: amount, source: 'staff_manual', status: 'requested', payment_status: 'not_requested',
  metadata: inclusion == null ? {} : { invoice_total_inclusion: inclusion }, ...extra,
});
const project = patch => compute({ bookings: [booking('luna')], payments: [], refund_records: [], bsr: [], booked_services: [], booked_transfers: [], ...context, ...patch });
const value = (p, creator = 'total') => p.creators.find(r => r.creator === creator).new_booking_value.amount_cents;
const details = (p, creator, cursor, limit = 200) => page(p, { kind: 'bookings', creator, cursor, limit, currency: 'EUR', cohort_id: p.cohort_id }).detail;
function reconciles(p) {
  assert.equal(value(p), value(p, 'luna') + value(p, 'staff'));
  for (const creator of [undefined, 'luna', 'staff']) {
    const d = details(p, creator);
    assert.equal(d.full_cohort_totals.new_booking_value_cents, value(p, creator || 'total'));
    assert.equal(d.rows.reduce((s, r) => s + r.current_saved_total_cents, 0), value(p, creator || 'total'));
    assert.equal(d.full_cohort_totals.new_booking_count, p.creators.find(r => r.creator === (creator || 'total')).new_booking_count.count);
  }
}
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
test('canonical creator, unknown Staff, group once, exact cents', () => {
  const p = project({ bookings: [booking('luna', 10001, 'luna_guest', { guest_count: 8 }), booking('staff', 20002, 'staff'), booking('unknown', 30003, null), booking('legacy', 4, 'luna_whatsapp')] });
  assert.equal(value(p, 'luna'), 10001); assert.equal(value(p, 'staff'), 50009);
  assert.equal(p.metrics.new_booking_count.count, 4); reconciles(p);
});
test('embedded rows stay in base; explicit extras and active transfers added once', () => {
  const b = booking('luna', 11000, 'luna_guest', { metadata: { source: 'luna_guest', quote_snapshot: { total_cents: 11000, line_items: [{ code: 'accommodation_only', total_cents: 10000 }, { code: 'yoga_class', total_cents: 1000 }] } } });
  const services = [service('embedded', 1000, null), service('later', 501), service('removed', 900, 'additional', { status: 'removed' })];
  const transfers = [{ transfer_id: 'ride', booking_id: 'luna', client_slug: 'wolfhouse-somo', status: 'confirmed', price_cents: 2000, currency: 'EUR' }];
  const p = project({ bookings: [b], booked_services: services, booked_transfers: transfers });
  const invoice = bookingLedgerInvoicePaidBalance(b, services.reduce((n, r) => n + serviceRecordBillableCents(r), 0), 0, sumActiveTransferChargesCents(transfers), services.filter(isAdditionalInvoiceService).reduce((n, r) => n + serviceRecordBillableCents(r), 0));
  assert.equal(value(p), 13501); assert.equal(value(p), invoice.invoice_total_cents); reconciles(p);
});
test('duplicate booking joins, services and transfers cannot multiply value', () => {
  const b = booking('luna'); const s = service('extra', 503);
  const t = { transfer_id: 'ride', booking_id: 'luna', status: 'confirmed', price_cents: 201, currency: 'EUR' };
  const p = project({ bookings: [b, { ...b }], booked_services: [s, { ...s }], booked_transfers: [t, { ...t }] });
  assert.equal(value(p), 10705); assert.equal(p.metrics.new_booking_count.count, 1); reconciles(p);
});
test('conflicting booking identities are excluded, not first-row-wins', () => {
  const input = [booking('luna'), booking('luna', 10002)];
  for (const bookings of [input, [...input].reverse()]) {
    const p = project({ bookings }); assert.equal(value(p), 0);
    assert.equal(p.metrics.new_booking_value.state, 'partial'); reconciles(p);
  }
});
test('conflicting service identities are partial and order independent', () => {
  const input = [service('extra', 1), service('extra', 2)];
  const a = project({ booked_services: input }); const b = project({ booked_services: [...input].reverse() });
  assert.equal(value(a), 10001); assert.equal(a.metrics.new_booking_value.state, 'partial');
  assert.equal(a.cohort_id, b.cohort_id); reconciles(a);
});
test('saved signed adjustment and legacy combo charge use persisted amounts', () => {
  const p = project({ booked_services: [service('discount', 0, 'additional', { metadata: { invoice_total_inclusion: 'additional', staff_custom_line: true, amount_cents: -101 } }), service('combo', 0, 'additional', { metadata: { invoice_total_inclusion: 'additional', combo_part: 'surfboard', combo_line_total_cents: 302 } })] });
  assert.equal(value(p), 10202); reconciles(p);
});
test('malformed/ambiguous charge is partial, not a complete zero; foreign tenant ignored', () => {
  for (const raw of [true, null, '01', '1.2', '9007199254740992']) {
    const p = project({ booked_services: [service('bad', raw)] });
    assert.equal(value(p), 10001); assert.equal(p.metrics.new_booking_value.state, 'partial'); reconciles(p);
  }
  assert.equal(project({ booked_services: [service('ambiguous', 2, 'unknown')] }).metrics.new_booking_value.state, 'partial');
  const foreign = project({ booked_services: [service('foreign', 99999, 'additional', { client_slug: 'sunset' })] });
  assert.equal(value(foreign), 10001); assert.equal(foreign.metrics.new_booking_value.state, 'complete');
});
test('missing optional charge relations stay visible as partial', () => {
  for (const field of ['booked_services_unavailable', 'booked_transfers_unavailable']) {
    const p = project({ [field]: true }); assert.equal(value(p), 10001);
    assert.equal(p.metrics.new_booking_value.state, 'partial'); reconciles(p);
  }
});
test('currency authority stays EUR; foreign transfer and receipt do not contaminate value', () => {
  assert.throws(() => project({ currency: 'USD' }), e => e.code === 'FINANCE_INVALID_CURRENCY');
  const p = project({ bookings: [booking('luna', 10001, 'luna_guest', { currency: null })], booked_transfers: [{ transfer_id: 'usd', booking_id: 'luna', status: 'confirmed', price_cents: 400, currency: 'USD' }] });
  assert.equal(value(p), 10001); assert.equal(p.metrics.new_booking_value.state, 'partial');
  const cash = project({ payments: [{ payment_id: 'foreign', booking_id: 'luna', amount_paid_cents: 10000, paid_at: now, currency: 'USD' }] });
  assert.equal(value(cash), 10001); assert.equal(cash.metrics.gross_receipts.amount_cents, 0);
  assert.equal(cash.metrics.gross_receipts.state, 'partial');
});
test('Madrid creation boundary/DST, not arrival, service or payment date', () => {
  const p = project({ bookings: [booking('before', 7, 'staff', { created_at: '2026-09-30T21:59:59Z', check_in: '2026-10-03' }), booking('start', 101, 'luna_guest', { created_at: '2026-09-30T22:00:00Z', check_in: '2027-03-01' }), booking('end', 202, 'staff', { created_at: '2026-10-31T22:59:59Z' }), booking('after', 8, 'staff', { created_at: '2026-10-31T23:00:00Z' })] });
  assert.equal(value(p), 303); assert.equal(p.metrics.new_booking_count.count, 2); reconciles(p);
});
test('refunds and receipt timing never reduce saved booking value or reassign creator', () => {
  const p = project({ payments: [{ payment_id: 'paid', booking_id: 'luna', amount_paid_cents: 8000, paid_at: '2026-11-02', currency: 'EUR', booking_metadata: { source: 'luna_guest' } }], refund_records: [{ refund_id: 'refund', booking_id: 'luna', amount_cents: 500, effective_date: '2026-10-09', currency: 'EUR', booking_metadata: { source: 'luna_guest' } }], booked_services: [service('staff-added', 501)] });
  assert.equal(value(p, 'luna'), 10502); assert.equal(value(p, 'staff'), 0); assert.equal(p.metrics.gross_receipts.amount_cents, 0); assert.equal(p.metrics.recorded_refunds.amount_cents, 500); reconciles(p);
});
test('empty complete zero, unreadable money/date partial, excluded statuses', () => {
  const empty = project({ bookings: [] }); assert.equal(value(empty), 0); assert.equal(empty.metrics.new_booking_value.state, 'complete');
  for (const patch of [{ total_amount_cents: true }, { total_amount_cents: null }, { created_at: null }]) {
    const p = project({ bookings: [booking('bad', 1, 'staff', patch)] }); assert.equal(value(p), 0); assert.equal(p.metrics.new_booking_value.state, 'partial');
  }
  const p = project({ bookings: ['cancelled', 'canceled', 'expired', 'hold'].map(status => booking(status, 99, 'luna_guest', { status })) });
  assert.equal(value(p), 0); assert.equal(p.metrics.new_booking_count.count, 0);
});
test('full details/pagination and stale charge changes follow the same contributor set', () => {
  const p = project({ bookings: [booking('luna'), booking('staff', 7, 'staff')] });
  const first = details(p, undefined, undefined, 1); const second = details(p, undefined, first.page.next_cursor, 1);
  assert.equal(first.full_cohort_totals.new_booking_value_cents, 10008);
  assert.equal([...first.rows, ...second.rows].reduce((s, r) => s + r.current_saved_total_cents, 0), 10008);
  const changed = project({ bookings: [booking('luna'), booking('staff', 7, 'staff')], booked_services: [service('new', 1)] });
  assert.throws(() => page(changed, { kind: 'bookings', currency: 'EUR', cohort_id: p.cohort_id }), e => e.code === 'FINANCE_COHORT_STALE');
});
test('checked arithmetic rejects integer overflow', () => {
  assert.throws(() => project({ bookings: [booking('luna', Number.MAX_SAFE_INTEGER)], booked_services: [service('over', 1)] }), e => e.code === 'FINANCE_DATA_QUALITY');
});

test('1000 seeded duplicate/order/creator/exact-cent reconciliation cases', () => {
  let seed = 17027;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let i = 0; i < 1000; i++) {
    const bookings = []; const booked_services = []; const expected = { luna:0, staff:0 };
    const count = 1 + next() % 8;
    for (let j = 0; j < count; j++) {
      const id = `seed-${j}`; const base = next() % 1000000; const extra = 1 + next() % 9999;
      const luna = next() % 3 === 0; const b = booking(id, base, luna ? 'luna_guest' : null);
      const s = service(`extra-${j}`, extra, 'additional', { booking_id:id });
      bookings.push(b, { ...b }); booked_services.push(s, { ...s });
      expected[luna ? 'luna' : 'staff'] += base + extra;
    }
    const p = project({ bookings, booked_services });
    assert.equal(value(p, 'luna'), expected.luna); assert.equal(value(p, 'staff'), expected.staff);
    assert.equal(p.metrics.new_booking_count.count, count); reconciles(p);
    assert.equal(p.cohort_id, project({ bookings:[...bookings].reverse(), booked_services:[...booked_services].reverse() }).cohort_id);
  }
});

test('actual read-only SQL: tenant isolation, status/guest scope, extras, refunds, missing relations', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE clients(id text PRIMARY KEY, slug text);
      CREATE TABLE bookings(id text PRIMARY KEY, client_id text, total_amount_cents integer, balance_due_cents integer, check_in date, check_out date, guest_count integer, created_at timestamptz, status text, booking_source text, metadata jsonb, package_code text, block_type text, phone text);
      CREATE TABLE packages(client_id text, code text, name text);
      CREATE TABLE booking_service_records(id text, booking_id text, client_slug text, amount_due_cents integer, status text, payment_status text, source text, metadata jsonb);
      CREATE TABLE booking_transfers(id text, booking_id text, client_slug text, status text, price_cents integer, currency text);
      CREATE TABLE payments(id text, booking_id text, client_id text, amount_paid_cents integer, paid_at timestamptz, payment_kind text, metadata jsonb, currency text, status text, finance_exclusion text);
      CREATE TABLE booking_refund_records(id text, booking_id text, client_id text, amount_cents integer, effective_date date, location_id text, source text, currency text);
      INSERT INTO clients VALUES ('wh','wolfhouse-somo'),('ss','sunset');
    `);
    const insertBooking = async (id, client, status, metadata, amount = 10001) => db.query(`INSERT INTO bookings VALUES ($1,$2,$3,$3,'2027-01-01','2027-01-02',8,'2026-10-03T12:00:00Z',$4,'manual',$5,NULL,'none',NULL)`, [id, client, amount, status, JSON.stringify(metadata)]);
    await insertBooking('luna', 'wh', 'confirmed', { source: 'luna_guest' });
    await insertBooking('staff', 'wh', 'confirmed', {} , 20002);
    await insertBooking('foreign', 'ss', 'confirmed', { source: 'luna_guest' }, 999999);
    for (const status of ['cancelled', 'canceled', 'expired', 'hold', 'blocked']) await insertBooking(status, 'wh', status, {}, 999999);
    for (const [id, md] of [['block', { staff_calendar_block: true }], ['companion', { block_type: 'private_room_companion' }], ['external', { external_calendar: { connection_id: 'other' } }]]) await insertBooking(id, 'wh', 'confirmed', md, 999999);
    await db.exec(`INSERT INTO booking_service_records VALUES
      ('embedded','luna','wolfhouse-somo',700,'confirmed','pending','luna_guest','{}'),
      ('extra','luna','wolfhouse-somo',503,'requested','not_requested','staff_manual','{"invoice_total_inclusion":"additional"}'),
      ('wrong-tenant','luna','sunset',999999,'confirmed','pending','staff_manual','{"invoice_total_inclusion":"additional"}'),
      ('other-booking','foreign','wolfhouse-somo',999999,'confirmed','pending','staff_manual','{"invoice_total_inclusion":"additional"}'),
      ('cancelled-service','luna','wolfhouse-somo',999999,'cancelled','pending','staff_manual','{"invoice_total_inclusion":"additional"}');
      INSERT INTO booking_transfers VALUES ('ride','luna','wolfhouse-somo','confirmed',201,'EUR'),('foreign-ride','luna','sunset','confirmed',999999,'EUR');
      INSERT INTO payments VALUES ('retained','cancelled','wh',800,'2026-10-10','deposit','{}','EUR','paid',NULL),('cross','foreign','wh',999999,'2026-10-10','deposit','{}','EUR','paid',NULL);
      INSERT INTO booking_refund_records VALUES ('r','luna','wh',10,'2026-10-10',NULL,'staff_manual_record','EUR');`);
    const calls = [];
    const readonly = { query(sql, params) { assert.match(sql.trim(), /^(SELECT|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK|COMMIT)\b/i); calls.push(sql); return db.query(sql, params); } };
    const data = await fetchData(readonly, { clientSlug: 'wolfhouse-somo' });
    const p = compute({ ...data, ...context });
    assert.deepEqual(data.bookings.map(b => b.booking_id).sort(), ['luna', 'staff']);
    assert.equal(value(p, 'luna'), 10705); assert.equal(value(p, 'staff'), 20002); reconciles(p);
    assert.equal(p.metrics.gross_receipts.amount_cents, 800, 'cancelled retained cash stays separate; cross-client payment rejected');
    assert.equal(p.metrics.recorded_refunds.amount_cents, 10); assert.equal(p.metrics.new_booking_value.state, 'complete');
    assert.equal(calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); assert.equal(calls.at(-1), 'COMMIT');
    // Exercise the unchanged real HTTP router, real Finance handler, real data
    // adapter and embedded database together. Only PG acquisition is redirected.
    const http = require('http');
    const env = { NODE_ENV:'test', STAFF_API_FORTRESS_OFFLINE_LISTENER:'1', STAFF_AUTH_REQUIRED:'false', STAFF_AUTH_ALLOW_OPEN:'true', DEFAULT_CLIENT_SLUG:'wolfhouse-somo' };
    const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    const api = require('./staff-query-api');
    let acquired = 0;
    api.setFortress15j3OfflineSeams({ withPgClient: async fn => { acquired++; return fn(readonly); } });
    const server = api.server;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const get = query => new Promise((resolve, reject) => {
        http.get({ host:'127.0.0.1', port:server.address().port, path:'/staff/admin/finance/summary?' + new URLSearchParams(query) }, res => {
          let text = ''; res.on('data', chunk => { text += chunk; });
          res.on('end', () => { try { resolve({ status:res.statusCode, body:JSON.parse(text) }); } catch (err) { reject(err); } });
        }).on('error', reject);
      });
      const query = { client:'wolfhouse-somo', granularity:'month', anchor:'2026-10-27' };
      const response = await get(query);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const wire = response.body.wolfhouse_creator_finance;
      assert.equal(value(wire), 30707); assert.equal(value(wire, 'luna'), 10705);
      const detail = await get({ ...query, creator_detail:'bookings', creator:'luna', currency:'EUR', cohort_id:wire.cohort_id });
      assert.equal(detail.status, 200); assert.equal(detail.body.wolfhouse_creator_finance.detail.full_cohort_totals.new_booking_value_cents, 10705);
      for (const [patch, expected] of [[{client:'foreign'},403], [{location:'sunset-somo'},403], [{currency:'USD'},400], [{anchor:'2026-02-30'},400]]) {
        const before = acquired; assert.equal((await get({ ...query, ...patch })).status, expected);
        assert.equal(acquired, before, 'invalid scope rejected before DB acquisition');
      }
      assert.equal((await get({ ...query, creator_detail:'bookings', currency:'EUR', cohort_id:'stale' })).status, 409);
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      api.setFortress15j3OfflineSeams(null);
      for (const [key, val] of Object.entries(previousEnv)) { if (val == null) delete process.env[key]; else process.env[key] = val; }
    }
    // Creation-date value must not depend on either a stay or service date.
    await insertBooking('undated', 'wh', 'confirmed', {}, 101);
    await db.exec(`UPDATE bookings SET check_in=NULL, check_out=NULL WHERE id='undated';
      INSERT INTO booking_service_records VALUES ('undated-extra','undated','wolfhouse-somo',202,'confirmed','pending','staff','{"invoice_total_inclusion":"additional"}');`);
    const undated = compute({ ...await fetchData(readonly, { clientSlug:'wolfhouse-somo' }), ...context });
    assert.equal(value(undated), 30707 + 101 + 202, 'saved extras need no arrival or service date');
    await db.exec("DELETE FROM booking_service_records WHERE id='undated-extra'; DELETE FROM bookings WHERE id='undated'");
    await db.exec('DROP TABLE booking_transfers');
    const noTransfers = compute({ ...await fetchData(readonly, { clientSlug: 'wolfhouse-somo' }), ...context });
    assert.equal(noTransfers.metrics.new_booking_value.state, 'partial'); assert.equal(value(noTransfers), 30506);
    await db.exec('DROP TABLE booking_service_records');
    const noServices = compute({ ...await fetchData(readonly, { clientSlug: 'wolfhouse-somo' }), ...context });
    assert.equal(noServices.metrics.new_booking_value.state, 'partial'); assert.equal(value(noServices), 30003);
    const broken = { async query(sql, params) { if (/FROM booking_transfers/.test(sql)) { const e = new Error('offline denied'); e.code = '42501'; throw e; } return readonly.query(sql, params); } };
    await assert.rejects(fetchData(broken, { clientSlug: 'wolfhouse-somo' }), e => e.code === '42501');
    assert.equal(calls.at(-1), 'ROLLBACK', 'unexpected read errors do not masquerade as complete zero');
  } finally { await db.close(); }
});
(async () => {
  let failed = 0;
  for (const [name, run] of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${name}\n${e.stack}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} cases PASS; ${failed} failed. Offline only.`);
  if (failed) process.exitCode = 1;
})();
