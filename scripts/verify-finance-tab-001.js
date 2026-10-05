'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  computeSunsetFinanceSummary,
  resolvePrimaryRange,
} = require('./lib/sunset-finance-summary');

const ROOT = path.join(__dirname, '..');
const now = new Date('2026-10-14T12:00:00Z');

const week = resolvePrimaryRange({
  now,
  timeZone: 'Europe/Madrid',
  view: { granularity: 'week', anchor: '2026-10-14' },
});
assert.deepStrictEqual(week, {
  granularity: 'week',
  range: { start: '2026-10-12', end: '2026-10-18' },
  today: '2026-10-14',
});

const missingRefunds = computeSunsetFinanceSummary({
  now,
  timeZone: 'Europe/Madrid',
  productMode: 'lodging_packages',
  view: { granularity: 'month', anchor: '2026-10-14' },
  bsr: [{ booking_id: 'L1', service_date: '2026-10-14', amount_due_cents: 10000, service_type: 'accommodation', source: 'luna_guest' }],
  bookings: [{ booking_id: 'L1', total_amount_cents: 10000 }],
  payments: [{ booking_id: 'L1', amount_paid_cents: 3000, paid_at: '2026-10-14T10:00:00Z' }],
  refund_records: [],
  refund_ledger_unavailable: true,
  bed_occupancy: { status: 'complete', occupied_bed_nights: 2, sellable_bed_nights: 4 },
});
assert.strictEqual(missingRefunds.redesign.net.status, 'unavailable');
assert.strictEqual(missingRefunds.redesign.net.net_collected_cents, null);
assert.strictEqual(missingRefunds.redesign.net.refunds_cents, null);
assert.strictEqual(missingRefunds.redesign.net.gross_collected_cents, 3000);
assert.strictEqual(missingRefunds.redesign.net.vs_prior_pct, null);
assert.strictEqual(missingRefunds.redesign.luna_bookings.total_bookings, 1);
assert.strictEqual(missingRefunds.redesign.luna_bookings.status, 'complete');
assert.strictEqual(missingRefunds.redesign.capacity.metric, 'bed_occupancy');
assert.strictEqual(missingRefunds.redesign.capacity.occupied_bed_nights, 2);
assert.strictEqual(missingRefunds.redesign.capacity.sellable_bed_nights, 4);
assert.strictEqual(missingRefunds.redesign.capacity.pct, 50);
assert.strictEqual(missingRefunds.redesign.outstanding.outstanding_cents, 7000);
assert.strictEqual(missingRefunds.redesign.outstanding.due_date_status, 'unknown');
assert.strictEqual(missingRefunds.redesign.outstanding.due_date_unknown_cents, 7000);

const derivedOccupancy = computeSunsetFinanceSummary({
  now,
  productMode: 'lodging_packages',
  refund_ledger_unavailable: false,
  bsr: [], payments: [], refund_records: [],
  bookings: [{ booking_id: 'stay-1', total_amount_cents: 0, check_in: '2026-10-13', check_out: '2026-10-15', guest_count: 1 }],
  bed_inventory: [{ bed_id: 'bed-1' }, { bed_id: 'bed-2' }],
  bed_assignments: [{ assignment_id: 'a-1', booking_id: 'stay-1', bed_id: 'bed-1', assignment_start_date: '2026-10-13', assignment_end_date: '2026-10-15', assignment_type: 'guest' }],
  view: { granularity: 'week', anchor: '2026-10-14' },
});
assert.strictEqual(derivedOccupancy.redesign.capacity.status, 'partial');
assert.strictEqual(derivedOccupancy.redesign.capacity.occupied_bed_nights, 2);
assert.strictEqual(derivedOccupancy.redesign.capacity.sellable_bed_nights, 14);

const overlapCohort = computeSunsetFinanceSummary({
  now,
  productMode: 'lodging_packages',
  refund_ledger_unavailable: false,
  bookings: [{ booking_id: 'cross-month', total_amount_cents: 10000, balance_due_cents: 7000, check_in: '2026-09-28', check_out: '2026-10-03', guest_count: 1 }],
  bsr: [{ booking_id: 'cross-month', service_date: '2026-09-28', amount_due_cents: 10000, service_type: 'accommodation', source: null, metadata: {} }],
  payments: [{ booking_id: 'cross-month', amount_paid_cents: 3000, paid_at: '2026-09-01T10:00:00Z' }],
  view: { granularity: 'month', anchor: '2026-10-15' },
});
assert.strictEqual(overlapCohort.redesign.outstanding.outstanding_cents, 7000, 'cross-month stay must join selected cohort by overlap');
assert.strictEqual(overlapCohort.redesign.luna_bookings.status, 'partial', 'unknown origin must never be reported complete');

const dataSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-finance-data.js'), 'utf8');
assert.match(dataSrc, /AS source/);
assert.doesNotMatch(dataSrc, /b\.record_source/);
assert.match(dataSrc, /sqlGuestBooking\('b'\)/, 'lodging commercial and assignment cohorts must use canonical guest scope');
assert.match(dataSrc, /SAVEPOINT finance_occupancy_sp/, 'optional occupancy reads must fail closed without failing Finance');

const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'), 'utf8');
for (const required of ['Booked sales', 'Balance still due', 'Booked sales by product', 'bed-nights', "['week', 'Week']"]) {
  assert.ok(uiSrc.includes(required), `Finance UI missing ${required}`);
}
assert.ok(uiSrc.includes('Unavailable'), 'Finance UI must render unavailable state');
assert.ok(uiSrc.includes('data-finance-gran="year"'), 'Year must remain available in secondary controls');

console.log('PASS verify-finance-tab-001');
