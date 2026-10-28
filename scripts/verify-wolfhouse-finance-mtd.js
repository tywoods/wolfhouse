'use strict';
// Offline canonical read-model proof. Synthetic clocks and records; no services or writes.
const assert = require('assert/strict');
const {
  computeWolfhouseCreatorFinance: compute,
  pageWolfhouseCreatorFinance: page,
  resolvePrimaryRange,
} = require('./lib/sunset-finance-summary');
const tests = [];
const test = (name, run) => tests.push([name, run]);
const booking = (id, created_at, amount, source = 'luna_guest') => ({
  booking_id: id, created_at, total_amount_cents: amount, currency: 'EUR',
  status: 'confirmed', metadata: { source },
});
const project = (extra = {}) => compute({
  now: new Date('2026-10-27T12:00:00Z'), clientSlug: 'wolfhouse-somo', currency: 'EUR',
  view: { granularity: 'month', anchor: '2026-10-01' },
  bookings: [], payments: [], refund_records: [], bsr: [], booked_services: [], booked_transfers: [],
  ...extra,
});
const detail = (p, creator, cursor, limit = 200) => page(p, {
  kind: 'bookings', creator, cursor, limit, currency: 'EUR', cohort_id: p.cohort_id,
}).detail;

test('current month is first through today in Madrid, not the calendar month', () => {
  const p = project({ bookings: [
    booking('before', '2026-09-30T21:59:59Z', 900000),
    booking('first', '2026-09-30T22:00:00Z', 10001),
    booking('today', '2026-10-27T00:00:00Z', 20002, 'staff'),
    booking('today-last', '2026-10-27T22:59:59Z', 30003),
    booking('tomorrow', '2026-10-27T23:00:00Z', 900000),
    booking('month-last', '2026-10-31T22:59:59Z', 900000),
  ] });
  assert.deepEqual(p.scope.range, { start: '2026-10-01', end: '2026-10-27', granularity: 'month', anchor: '2026-10-01' });
  assert.equal(p.scope.timezone, 'Europe/Madrid');
  assert.equal(p.metrics.new_booking_value.amount_cents, 60006);
  assert.equal(p.metrics.new_booking_count.count, 3);
  for (const [creator, amount, ids] of [
    [undefined, 60006, ['first', 'today', 'today-last']],
    ['luna', 40004, ['first', 'today-last']],
    ['staff', 20002, ['today']],
  ]) {
    const d = detail(p, creator);
    assert.deepEqual(d.rows.map(r => r.booking_id), ids);
    assert.equal(d.full_cohort_totals.new_booking_value_cents, amount);
    assert.equal(p.creators.find(r => r.creator === (creator || 'total')).new_booking_value.amount_cents, amount);
  }
});

test('default, picker and same-month navigation anchors resolve the same MTD cohort', () => {
  const baseline = project();
  for (const view of [undefined, {}, { granularity: 'month' }, { granularity: 'month', anchor: '2026-10-27' }, { granularity: 'month', anchor: '2026-10-31', start: '2026-10-01', end: '2026-10-31' }]) {
    const p = project({ view });
    assert.equal(p.scope.range.start, '2026-10-01'); assert.equal(p.scope.range.end, '2026-10-27');
    assert.equal(p.scope.range.granularity, 'month'); assert.equal(p.cohort_id, baseline.cohort_id);
  }
});

test('Madrid midnight, DST changes, month/year rollover and leap day use local today', () => {
  const cases = [
    ['2026-10-27T22:59:59Z', '2026-10-01', '2026-10-27'],
    ['2026-10-27T23:00:00Z', '2026-10-01', '2026-10-28'],
    ['2026-09-30T22:00:00Z', '2026-10-01', '2026-10-01'],
    ['2026-10-31T23:00:00Z', '2026-11-01', '2026-11-01'],
    ['2026-12-31T23:00:00Z', '2027-01-01', '2027-01-01'],
    ['2026-03-28T23:00:00Z', '2026-03-01', '2026-03-29'],
    ['2026-03-29T01:00:00Z', '2026-03-01', '2026-03-29'],
    ['2026-10-25T00:30:00Z', '2026-10-01', '2026-10-25'],
    ['2026-10-25T01:30:00Z', '2026-10-01', '2026-10-25'],
    ['2024-02-28T23:00:00Z', '2024-02-01', '2024-02-29'],
    ['2025-02-28T12:00:00Z', '2025-02-01', '2025-02-28'],
  ];
  for (const [now, start, end] of cases) {
    const p = project({ now: new Date(now), view: {}, timeZone: 'UTC' });
    assert.equal(p.scope.range.start, start, now); assert.equal(p.scope.range.end, end, now);
    assert.equal(p.scope.timezone, 'Europe/Madrid');
  }
});

test('completed and future months remain full calendar months', () => {
  for (const [anchor, end] of [['2026-09-14', '2026-09-30'], ['2026-11-01', '2026-11-30'], ['2024-02-01', '2024-02-29'], ['2025-02-01', '2025-02-28'], ['2027-01-01', '2027-01-31']]) {
    const p = project({ view: { granularity: 'month', anchor } });
    assert.equal(p.scope.range.start, anchor.slice(0, 7) + '-01'); assert.equal(p.scope.range.end, end);
  }
});

test('explicit custom, day, week and year ranges are not silently clipped', () => {
  for (const [view, start, end, granularity] of [
    [{ granularity: 'custom', start: '2026-10-01', end: '2026-10-31' }, '2026-10-01', '2026-10-31', 'custom'],
    [{ granularity: 'custom', start: '2026-10-29', end: '2026-11-05' }, '2026-10-29', '2026-11-05', 'custom'],
    [{ granularity: 'day', anchor: '2026-10-30' }, '2026-10-30', '2026-10-30', 'day'],
    [{ granularity: 'week', anchor: '2026-10-27' }, '2026-10-26', '2026-11-01', 'week'],
    [{ granularity: 'year', anchor: '2026-10-27' }, '2026-01-01', '2026-12-31', 'year'],
    [{ start: '2026-01-01', end: '2026-12-31' }, '2026-01-01', '2026-12-31', 'year'],
  ]) {
    const p = project({ view });
    assert.deepEqual([p.scope.range.start, p.scope.range.end, p.scope.range.granularity], [start, end, granularity]);
  }
});

test('existing cash, refunds and trend use the same MTD range; all-active balance stays a snapshot', () => {
  const p = project({
    bookings: [booking('old', '2026-09-01', 10001, 'staff')],
    payments: [
      { payment_id: 'today', booking_id: 'old', amount_paid_cents: 101, currency: 'EUR', paid_at: '2026-10-27T22:59:59Z', payment_kind: 'deposit' },
      { payment_id: 'tomorrow', booking_id: 'old', amount_paid_cents: 202, currency: 'EUR', paid_at: '2026-10-27T23:00:00Z', payment_kind: 'balance' },
    ],
    refund_records: [
      { refund_id: 'today', booking_id: 'old', amount_cents: 11, currency: 'EUR', effective_date: '2026-10-27' },
      { refund_id: 'tomorrow', booking_id: 'old', amount_cents: 22, currency: 'EUR', effective_date: '2026-10-28' },
    ],
  });
  assert.equal(p.metrics.new_booking_value.amount_cents, 0);
  assert.equal(p.metrics.gross_receipts.amount_cents, 101); assert.equal(p.metrics.recorded_refunds.amount_cents, 11);
  assert.equal(p.metrics.net_receipts.amount_cents, 90); assert.equal(p.metrics.deposits_received.amount_cents, 101);
  assert.equal(p.trend.length, 27); assert.equal(p.trend.at(-1).date, '2026-10-27');
  for (const kind of ['payments', 'refunds']) {
    const d = page(p, { kind, currency: 'EUR', cohort_id: p.cohort_id }).detail;
    assert.equal(d.rows.length, 1); assert.equal(d.rows[0][kind === 'payments' ? 'payment_id' : 'refund_id'], 'today');
  }
  const custom = project({ bookings: [booking('old', '2026-09-01', 10001, 'staff')], view: { granularity: 'custom', start: '2026-09-01', end: '2026-11-30' } });
  assert.equal(custom.metrics.outstanding_today.amount_cents, 10001);
  assert.equal(p.metrics.outstanding_today.amount_cents, 9698, 'existing all-active/all-receipt snapshot is not converted into a creation cohort');
});

test('midnight invalidates paged MTD cohort without changing source or money contracts', () => {
  const bookings = [booking('first', '2026-10-01', 101), booking('today', '2026-10-27', 202, 'staff'), booking('tomorrow', '2026-10-28', 303)];
  const before = project({ bookings, now: new Date('2026-10-27T22:59:59Z') });
  const sameDay = project({ bookings, now: new Date('2026-10-27T12:00:00Z') });
  assert.equal(before.cohort_id, sameDay.cohort_id);
  const first = detail(before, undefined, undefined, 1);
  const second = detail(before, undefined, first.page.next_cursor, 1);
  assert.deepEqual([...first.rows, ...second.rows].map(r => r.booking_id), ['first', 'today']);
  assert.equal(first.full_cohort_totals.new_booking_value_cents, 303);
  assert.deepEqual(first.full_cohort_totals, second.full_cohort_totals);
  const after = project({ bookings, now: new Date('2026-10-27T23:00:00Z') });
  assert.equal(after.scope.range.end, '2026-10-28'); assert.equal(after.metrics.new_booking_value.amount_cents, 606);
  assert.notEqual(after.cohort_id, before.cohort_id);
  assert.throws(() => page(after, { kind: 'bookings', creator: 'luna', cursor: first.page.next_cursor, currency: 'EUR', cohort_id: before.cohort_id }), e => e.code === 'FINANCE_COHORT_STALE');
});

test('shared resolver defaults stay full-month; MTD is a read-model policy, not a caller toggle', () => {
  const args = { now: new Date('2026-10-27T12:00:00Z'), timeZone: 'Europe/Madrid', view: { granularity: 'month', anchor: '2026-10-01' } };
  assert.deepEqual(resolvePrimaryRange(args).range, { start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(resolvePrimaryRange({ ...args, currentMonthToDate: true }).range, { start: '2026-10-01', end: '2026-10-27' });
  assert.equal(project({ currentMonthToDate: false }).scope.range.end, '2026-10-27');
});

let failed = 0;
for (const [name, run] of tests) {
  try { run(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
console.log(`${tests.length - failed}/${tests.length} MTD cases PASS; ${failed} failed. Offline only.`);
if (failed) process.exitCode = 1;
