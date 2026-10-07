'use strict';
const assert = require('assert');
const { computeSunsetFinanceSummary } = require('./lib/sunset-finance-summary');
const result = computeSunsetFinanceSummary({
  now: new Date('2026-10-14T12:00:00Z'), productMode: 'lodging_packages',
  view: { granularity: 'week', anchor: '2026-10-14' },
  bsr: [], payments: [], refund_records: [],
  bookings: ['assigned', 'unassigned'].map(booking_id => ({ booking_id, total_amount_cents: 0,
    guest_count: 1, check_in: '2026-10-13', check_out: '2026-10-15' })),
  bed_inventory: [{ bed_id: 'one' }, { bed_id: 'two' }],
  bed_assignments: ['one', 'two'].map(bed_id => ({ booking_id: 'assigned', bed_id,
    assignment_start_date: '2026-10-13', assignment_end_date: '2026-10-15', assignment_type: 'guest' })),
});
assert.strictEqual(result.redesign.capacity.status, 'partial');
assert.strictEqual(result.redesign.capacity.occupied_bed_nights, 4);
assert.strictEqual(result.redesign.capacity.exception_count, 2,
  'excess assignments on another booking must not erase two unassigned booking bed-nights');
console.log('PASS verify-finance-booking-assignment-completeness');
