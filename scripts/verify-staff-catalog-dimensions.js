'use strict';

// Offline, module-level readback/format proof. No database, server or live catalog.
const assert = require('node:assert/strict');
const { formatServiceRecordForSchedule, buildBookingServicesSchedule } = require('./lib/staff-booking-services-schedule');
const { formatServiceRecordInvoiceLineText } = require('./lib/service-record-invoice-line');

let passed = 0;
let failed = 0;
function test(name, run) {
  try { run(); passed++; console.log(`PASS ${name}`); }
  catch (err) { failed++; console.error(`FAIL ${name}\n${err.stack}`); }
}
function catalogRow(metadata = {}, overrides = {}) {
  return {
    id: 'catalog-1', service_type: 'addon_service', service_date: '2026-09-01',
    quantity: 1, amount_due_cents: 9000, amount_paid_cents: 500,
    metadata: {
      catalog_service: true, service_id: 'svc-1', service_name: 'Workshop',
      guests_charged: 3, quantity: 3, per_guest: true, price_unit: 'per_day',
      catalog_price_cents: 1500, nights_charged: 2,
      apply_from: '2026-09-01', apply_to: '2026-09-03', ...metadata,
    },
    ...overrides,
  };
}

test('schedule exposes persisted catalog dimensions without changing record quantity or money', () => {
  for (const perGuest of [true, false]) {
    const row = catalogRow({ per_guest: perGuest, guests_charged: perGuest ? 3 : 1 });
    const before = JSON.stringify(row);
    const mapped = formatServiceRecordForSchedule(row);
    for (const key of ['catalog_service', 'service_id', 'guests_charged', 'per_guest', 'price_unit',
      'catalog_price_cents', 'nights_charged', 'apply_from', 'apply_to']) {
      assert.deepEqual(mapped[key], row.metadata[key], key);
    }
    assert.equal(mapped.quantity, 1);
    assert.equal(mapped.people_count, null, 'catalog guests must not change existing chip aggregation');
    assert.equal(mapped.total_price_cents, 9000);
    assert.equal(mapped.unit_price_cents, 9000, 'record unit total is not the catalog unit price');
    assert.equal(JSON.stringify(row), before, 'readback is non-mutating');
  }
});

for (const [priceUnit, unitText, days] of [
  ['per_day', '2 days', 2], ['per_stay', '1 stay', 1], ['per_lesson', '1 lesson', 1],
]) {
  for (const perGuest of [true, false]) {
    test(`invoice ${priceUnit} per_guest=${perGuest} uses persisted dimensions`, () => {
      const row = catalogRow({ price_unit: priceUnit, per_guest: perGuest,
        guests_charged: perGuest ? 3 : 1, nights_charged: days },
      { amount_due_cents: 1500 * days * (perGuest ? 3 : 1) });
      const before = JSON.stringify(row);
      const expected = `Workshop — ${perGuest ? '3 guests × ' : ''}${unitText} × €15.00 = €${(row.amount_due_cents / 100).toFixed(2)}`;
      assert.equal(formatServiceRecordInvoiceLineText(row), expected);
      assert.equal(formatServiceRecordInvoiceLineText({ ...row, metadata: JSON.stringify(row.metadata) }), expected);
      assert.equal(JSON.stringify(row), before);
      const mapped = formatServiceRecordForSchedule({ ...row, metadata: JSON.stringify(row.metadata) });
      assert.equal(mapped.price_unit, priceUnit);
      assert.equal(mapped.per_guest, perGuest);
      assert.equal(mapped.guests_charged, perGuest ? 3 : 1);
      assert.equal(mapped.quantity, 1);
      assert.equal(mapped.total_price_cents, row.amount_due_cents);
    });
  }
}

test('invoice singular guest and day', () => {
  assert.equal(formatServiceRecordInvoiceLineText(catalogRow({ guests_charged: 1, nights_charged: 1 },
    { amount_due_cents: 1500 })), 'Workshop — 1 guest × 1 day × €15.00 = €15.00');
});

test('legacy catalog metadata keeps missing-unit and missing-price fallback', () => {
  const cases = [
    [{ catalog_service: true, service_name: 'Workshop' }, 'Workshop — €90.00'],
    [{ catalog_service: true, service_name: 'Workshop', quantity: 3 }, 'Workshop — 3 guests = €90.00'],
    [{ catalog_service: true, service_name: 'Workshop', price_unit: 'per_day', quantity: 3, nights_charged: 2 },
      'Workshop — 3 guests × 2 days = €90.00'],
  ];
  for (const [metadata, expected] of cases) {
    assert.equal(formatServiceRecordInvoiceLineText(catalogRow({}, { metadata })), expected);
    assert.equal(formatServiceRecordForSchedule(catalogRow({}, { metadata })).quantity, 1);
  }
});

test('manage readback retains every record and slot without de-aggregating display chips', () => {
  const rows = [
    catalogRow({ price_unit: 'per_lesson', slot_id: 'old-slot', slot_label: 'Morning',
      slot_time_local: '08:00', slot_time_local_end: '09:00' },
    { id: 'one', service_slot_id: 'slot-am', service_time_local: '09:00', service_time_local_end: '10:00' }),
    catalogRow({ price_unit: 'per_lesson', slot_id: 'slot-pm', slot_label: 'Afternoon',
      slot_time_local: '15:00', slot_time_local_end: '16:00' }, { id: 'two' }),
    catalogRow({}, { id: 'later', service_date: null }),
    catalogRow({}, { id: 'outside', service_date: '2026-08-31' }),
    { id: 'legacy', service_type: 'yoga', quantity: 1, amount_due_cents: 1500,
      service_date: '2026-09-02', metadata: {} },
  ];
  const before = JSON.stringify(rows);
  const schedule = buildBookingServicesSchedule({ booking: { check_in: '2026-09-01', check_out: '2026-09-03' }, serviceRecords: rows });
  assert.ok(Array.isArray(schedule.individual_records), 'individual_records array is available to the normal picker');
  assert.deepEqual(schedule.individual_records.map(r => r.service_record_id), ['one', 'two', 'later', 'outside', 'legacy']);
  assert.deepEqual(schedule.individual_records.map(r => r.quantity), [1, 1, 1, 1, 1]);
  assert.deepEqual(schedule.individual_records.map(r => r.service_date), ['2026-09-01', '2026-09-01', null, '2026-08-31', '2026-09-02']);
  const slots = schedule.individual_records.slice(0, 2).map(r => [r.service_slot_id, r.service_time_local, r.service_time_local_end, r.slot_label]);
  assert.deepEqual(slots, [['slot-am', '09:00', '10:00', 'Morning'], ['slot-pm', '15:00', '16:00', 'Afternoon']]);
  const chips = schedule.services_by_date.map(g => g.services.map(r => [r.service_name, r.quantity, r.total_price_cents]));
  assert.deepEqual(chips, [[['Workshop', 2, 18000]], [['Yoga', 1, 1500]]]);
  assert.deepEqual(schedule.unscheduled_services.map(r => r.service_record_id), ['later', 'outside']);
  assert.equal(schedule.total_services_cents, 37500);
  assert.deepEqual(schedule.totals, { scheduled_count: 2, unscheduled_count: 2, record_count: 5 });
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(buildBookingServicesSchedule().individual_records, []);
});

test('missing catalog price never derives a unit rate from the total', () => {
  for (const priceUnit of ['per_day', 'per_stay', 'per_lesson']) {
    const unit = priceUnit === 'per_day' ? '2 days' : priceUnit === 'per_stay' ? '1 stay' : '1 lesson';
    for (const perGuest of [true, false]) {
      const row = catalogRow({ price_unit: priceUnit, per_guest: perGuest, catalog_price_cents: null });
      assert.equal(formatServiceRecordInvoiceLineText(row), `Workshop — ${perGuest ? '3 guests × ' : ''}${unit} = €90.00`);
    }
  }
});

test('persisted zero price is displayed and persisted totals are never recomputed', () => {
  const row = catalogRow({ price_unit: 'per_lesson', catalog_price_cents: 0 });
  assert.equal(formatServiceRecordInvoiceLineText(row), 'Workshop — 3 guests × 1 lesson × €0.00 = €90.00');
  assert.equal(formatServiceRecordInvoiceLineText(row, { billableCents: () => 700 }),
    'Workshop — 3 guests × 1 lesson × €0.00 = €7.00');
  assert.equal(formatServiceRecordInvoiceLineText({ ...row, amount_due_cents: null }), 'Workshop — Not available');
});

test('incomplete legacy snapshots do not invent dates, units or per-guest false headcounts', () => {
  const row = catalogRow({ price_unit: null, per_guest: false, catalog_price_cents: null,
    apply_from: null, apply_to: null, nights_charged: null });
  assert.equal(formatServiceRecordInvoiceLineText(row), 'Workshop — €90.00');
  const mapped = formatServiceRecordForSchedule(row);
  for (const key of ['price_unit', 'catalog_price_cents', 'apply_from', 'apply_to', 'nights_charged']) {
    assert.equal(mapped[key], null, key);
  }
  assert.equal(formatServiceRecordInvoiceLineText(catalogRow({ nights_charged: null })), 'Workshop — 3 guests = €90.00');
  const legacy = formatServiceRecordForSchedule(catalogRow({}, { metadata: { catalog_service: true, quantity: 2 } }));
  assert.equal(legacy.guests_charged, 2);
  assert.equal(legacy.per_guest, true);
  assert.equal(legacy.quantity, 1);
});

test('numeric metadata strings are read consistently and non-catalog rows stay ordinary', () => {
  const row = catalogRow({ guests_charged: '3', nights_charged: '2', catalog_price_cents: '1500' });
  const mapped = formatServiceRecordForSchedule(row);
  assert.equal(mapped.guests_charged, 3);
  assert.equal(mapped.nights_charged, 2);
  assert.equal(mapped.catalog_price_cents, 1500);
  assert.equal(formatServiceRecordInvoiceLineText(row), 'Workshop — 3 guests × 2 days × €15.00 = €90.00');
  for (const metadata of [undefined, {}, 'not-json']) {
    const ordinary = formatServiceRecordForSchedule({ id: 'yoga', service_type: 'yoga', quantity: 2, amount_due_cents: 3000, metadata });
    assert.equal(ordinary.catalog_service, undefined);
    assert.equal(ordinary.quantity, 2);
    assert.equal(ordinary.total_price_cents, 3000);
  }
});

console.log(`\nverify-staff-catalog-dimensions: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
