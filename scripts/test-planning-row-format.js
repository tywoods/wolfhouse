/**
 * Phase 3a — unit tests for planning row formatting (no Postgres / n8n).
 * Run: npm run test:planning-row-format
 */
const assert = require('assert');
const {
  normalizeBedId,
  nightsBetween,
  colorTypeFromFields,
  formatPlanningRowFromPostgres,
  PLANNING_CSV_COLUMNS,
  toIsoDateString,
} = require('./lib/planning-row-format');

let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`OK   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${err.message}`);
  }
}

test('normalizeBedId R7 + Bed 1', () => {
  assert.strictEqual(normalizeBedId('R7', 'Bed 1'), 'R7-B1');
});

test('normalizeBedId already canonical', () => {
  assert.strictEqual(normalizeBedId('R3', 'R3-B2'), 'R3-B2');
});

test('nightsBetween ISO dates', () => {
  assert.strictEqual(nightsBetween('2026-08-01', '2026-08-03'), '2');
  assert.strictEqual(nightsBetween('2026-06-01', '2026-06-05'), '4');
  assert.strictEqual(nightsBetween('2026-06-05', '2026-06-10'), '5');
  assert.strictEqual(nightsBetween('2026-08-04', '2026-08-08'), '4');
  assert.strictEqual(nightsBetween('2026-08-07', '2026-08-12'), '5');
  assert.strictEqual(nightsBetween('2026-08-01', '2026-08-01'), '');
});

test('toIsoDateString from Date', () => {
  assert.strictEqual(
    toIsoDateString(new Date('2026-06-01T00:00:00.000Z')),
    '2026-06-01'
  );
});

test('colorType deposit_paid → confirmed', () => {
  const color = colorTypeFromFields({
    'Booking Source': 'WhatsApp',
    Status: 'Payment_Pending',
    'Payment Status': 'deposit_paid',
    'Assignment Status': 'Assigned',
  });
  assert.strictEqual(color, 'confirmed');
});

test('colorType manual_staff → operator', () => {
  const color = colorTypeFromFields({
    'Booking Source': 'Manual Staff',
    Status: 'Hold',
    'Payment Status': 'not_requested',
    'Assignment Status': 'Unassigned',
  });
  assert.strictEqual(color, 'operator');
});

test('nightsBetween rejects display strings (Mon Jun 01)', () => {
  assert.strictEqual(nightsBetween('Mon Jun 01', 'Fri Jun 05'), '');
});

test('formatPlanningRowFromPostgres nights from pg Date objects', () => {
  const row = formatPlanningRowFromPostgres({
    booking_code: 'WH-recTEST123',
    airtable_record_id: 'recTEST123',
    booking_source: 'whatsapp',
    guest_name: 'Sam',
    guest_count: 2,
    status: 'confirmed',
    payment_status: 'paid',
    assignment_status: 'assigned',
    package_code: 'malibu',
    deposit_paid_cents: 20000,
    requested_room_type: 'shared',
    room_preference: 'shared',
    guest_gender_group_type: 'unknown',
    assignment_start_date: new Date('2026-06-01T00:00:00.000Z'),
    assignment_end_date: new Date('2026-06-05T00:00:00.000Z'),
    room_code: 'R5',
    bed_code: 'R5-B1',
    assignment_notes: '',
  });

  assert.strictEqual(row['Check In'], '2026-06-01');
  assert.strictEqual(row['Check Out'], '2026-06-05');
  assert.strictEqual(row.Nights, '4');
});

test('formatPlanningRowFromPostgres shape', () => {
  const row = formatPlanningRowFromPostgres(
    {
      booking_code: 'WH-recTEST123',
      airtable_record_id: 'recTEST123',
      booking_source: 'whatsapp',
      guest_name: 'Sam',
      guest_count: 2,
      status: 'payment_pending',
      payment_status: 'deposit_paid',
      assignment_status: 'assigned',
      package_code: 'malibu',
      deposit_paid_cents: 20000,
      requested_room_type: 'shared',
      room_preference: 'shared',
      guest_gender_group_type: 'unknown',
      assignment_start_date: '2026-08-01',
      assignment_end_date: '2026-08-03',
      room_code: 'R5',
      bed_code: 'R5-B1',
      assignment_notes: 'test note',
    },
    '2026-05-25T12:00:00.000Z'
  );

  for (const col of PLANNING_CSV_COLUMNS) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, col), `missing column ${col}`);
  }
  assert.strictEqual(row['Booking ID'], 'WH-recTEST123');
  assert.strictEqual(row['Booking Record ID'], 'recTEST123');
  assert.strictEqual(row['Bed ID'], 'R5-B1');
  assert.strictEqual(row.Nights, '2');
  assert.strictEqual(row['Color Type'], 'confirmed');
  assert.ok(row['Display Text'].includes('Sam'));
  assert.strictEqual(row.Notes, 'test note');
});

if (failed > 0) {
  console.log(`\n${failed} test(s) failed\n`);
  process.exit(1);
}

console.log(`\nAll planning-row-format tests passed.\n`);
