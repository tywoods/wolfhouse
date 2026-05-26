const assert = require('assert');
const {
  toIsoDateString,
  normalizeBedCode,
  assignmentNaturalKey,
  loadCsvBedAssignments,
} = require('./lib/bed-drift-keys');

// ISO (Check In / Check Out columns)
assert.strictEqual(toIsoDateString('2026-08-07'), '2026-08-07');

// D/M/Y from Assignment Start/End Date (Booking Beds CSV — cross-check vs Check In/Out)
assert.strictEqual(toIsoDateString('7/8/2026'), '2026-08-07');
assert.strictEqual(toIsoDateString('12/8/2026'), '2026-08-12');
assert.strictEqual(toIsoDateString('4/8/2026'), '2026-08-04');
assert.strictEqual(toIsoDateString('1/6/2026'), '2026-06-01');
assert.strictEqual(toIsoDateString('5/6/2026'), '2026-06-05');
assert.strictEqual(toIsoDateString('10/6/2026'), '2026-06-10');

assert.strictEqual(normalizeBedCode('R7', 'R7-B1'), 'R7-B1');
assert.strictEqual(normalizeBedCode('R7', 'Bed 1'), 'R7-B1');
assert.strictEqual(
  assignmentNaturalKey('WH-recX', 'R7-B1', '2026-08-07', '2026-08-12'),
  'WH-recX|R7-B1|2026-08-07|2026-08-12'
);

const csvBeds = loadCsvBedAssignments();
const tyRow = csvBeds.find(
  (r) => r.booking_code === 'WH-rechKjCcySkfLzxUD' && r.bed_code === 'R7-B1'
);
assert.ok(tyRow, 'expected WH-rechKjCcySkfLzxUD R7-B1 from CSV');
assert.strictEqual(tyRow.assignment_start_date, '2026-08-07');
assert.strictEqual(tyRow.assignment_end_date, '2026-08-12');

console.log('test-bed-drift-keys: ok');
