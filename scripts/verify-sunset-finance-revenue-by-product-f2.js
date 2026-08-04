'use strict';

/**
 * verify:sunset-finance-revenue-by-product-f2
 * F2 — dynamic 5-row Revenue by product (lessons, course-included, top2, other).
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const {
  computeSunsetFinanceSummary,
  buildRevenueByProductFiveRows,
  courseIncludableOfferingKeys,
} = require(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'));

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra !== undefined ? `  (${extra})` : ''}`); }
}
function eq(label, got, want) {
  ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const TZ = 'Europe/Madrid';
const NOW = new Date('2026-08-15T10:00:00Z');
const RANGE = { start: '2026-08-01', end: '2026-08-31' };

const packs = [{
  pack_id: 'p1',
  label: 'Group',
  group_size: 8,
  config: {
    group_size: 8,
    equipment_options: [
      { offering_key: 'board_rental', label: 'Surfboard' },
      { offering_key: 'wetsuit_rental', label: 'Wetsuit' },
    ],
  },
}];

ok('includable keys from packs', courseIncludableOfferingKeys(packs).has('board_rental')
  && courseIncludableOfferingKeys(packs).has('wetsuit_rental'));

const dated = [
  // Lessons
  { service_date: '2026-08-05', service_type: 'surf_lesson', due: 10000, metadata: { component: 'course', course_id: 'c1' } },
  // Course-included: during_course board
  { service_date: '2026-08-05', service_type: 'addon_service', due: 0, metadata: { offering_key: 'board_rental', course_equipment: true, course_equipment_mode: 'during_course', offering_label: 'Surfboard' } },
  // Course-included: all_day board
  { service_date: '2026-08-06', service_type: 'addon_service', due: 1500, metadata: { offering_key: 'board_rental', course_equipment: true, course_equipment_mode: 'all_day', offering_label: 'Surfboard' } },
  // Course-included: standalone board (same offering)
  { service_date: '2026-08-07', service_type: 'surfboard', due: 2500, metadata: { offering_key: 'board_rental', offering_label: 'Surfboard' } },
  // Course-included wetsuit during
  { service_date: '2026-08-05', service_type: 'addon_service', due: 500, metadata: { offering_key: 'wetsuit_rental', course_equipment: true, course_equipment_mode: 'during_course', offering_label: 'Wetsuit' } },
  // Ranked items
  { service_date: '2026-08-08', service_type: 'addon_service', due: 8000, metadata: { offering_key: 'bike_rental', offering_label: 'Bike' } },
  { service_date: '2026-08-09', service_type: 'addon_service', due: 6000, metadata: { offering_key: 'towel_rental', offering_label: 'Towel' } },
  { service_date: '2026-08-10', service_type: 'addon_service', due: 1200, metadata: { offering_key: 'kayak_rental', offering_label: 'Kayak' } },
  { service_date: '2026-08-11', service_type: 'addon_service', due: 300, metadata: { offering_key: 'locker_rental', offering_label: 'Locker' } },
];

const rows = buildRevenueByProductFiveRows(dated, RANGE, packs);
eq('exactly 5 rows', rows.length, 5);
eq('row0 lessons slot', rows[0].slot, 'lessons');
eq('row0 lessons cents', rows[0].cents, 10000);
eq('row1 course_included slot', rows[1].slot, 'course_included');
// board 0+1500+2500 + wetsuit 500 = 4500
eq('row1 course-included multi-mode sum', rows[1].cents, 4500);
eq('row2 top item bike 8000', rows[2].cents, 8000);
ok('row2 label Bike', /bike/i.test(rows[2].label));
eq('row3 second towel 6000', rows[3].cents, 6000);
eq('row4 other kayak+locker', rows[4].cents, 1500);
eq('row4 other slot', rows[4].slot, 'other');
ok('pcts sum ~100', Math.abs(rows.reduce((a, r) => a + r.pct, 0) - 100) < 0.2);

// Empty period → 5 zero rows
const empty = buildRevenueByProductFiveRows([], RANGE, packs);
eq('empty still 5 rows', empty.length, 5);
ok('empty all zero', empty.every((r) => r.cents === 0));

// Fewer items → rank slots €0
const few = buildRevenueByProductFiveRows([
  { service_date: '2026-08-05', service_type: 'surf_lesson', due: 5000, metadata: { component: 'course' } },
  { service_date: '2026-08-05', service_type: 'addon_service', due: 2000, metadata: { offering_key: 'bike_rental', offering_label: 'Bike' } },
], RANGE, packs);
eq('few still 5 rows', few.length, 5);
eq('few lessons', few[0].cents, 5000);
eq('few course included 0', few[1].cents, 0);
eq('few rank1 bike', few[2].cents, 2000);
eq('few rank2 0', few[3].cents, 0);
eq('few other 0', few[4].cents, 0);

// Tie-break stable by label
const tied = buildRevenueByProductFiveRows([
  { service_date: '2026-08-01', service_type: 'addon_service', due: 1000, metadata: { offering_key: 'zeta', offering_label: 'Zeta' } },
  { service_date: '2026-08-01', service_type: 'addon_service', due: 1000, metadata: { offering_key: 'alpha', offering_label: 'Alpha' } },
], RANGE, []);
eq('tie: alpha before zeta by label', tied[2].label, 'Alpha');
eq('tie: second zeta', tied[3].label, 'Zeta');

// End-to-end via computeSunsetFinanceSummary
const summary = computeSunsetFinanceSummary({
  now: NOW,
  timeZone: TZ,
  view: { granularity: 'month', anchor: '2026-08-15' },
  bsr: dated.map((r) => ({
    booking_id: 'B1',
    service_date: r.service_date,
    service_type: r.service_type,
    amount_due_cents: r.due,
    quantity: 1,
    metadata: r.metadata,
  })),
  payments: [],
  bookings: [{ booking_id: 'B1', total_amount_cents: 50000 }],
  surf_packs: packs,
});
ok('summary has 5 product rows', summary.redesign.revenue_by_product.length === 5);
eq('summary lessons', summary.redesign.revenue_by_product[0].cents, 10000);
eq('summary course included', summary.redesign.revenue_by_product[1].cents, 4500);

// Outside period excluded
const out = buildRevenueByProductFiveRows([
  { service_date: '2026-07-01', service_type: 'surf_lesson', due: 9999, metadata: { component: 'course' } },
  { service_date: '2026-08-05', service_type: 'surf_lesson', due: 100, metadata: { component: 'course' } },
], RANGE, packs);
eq('out-of-period excluded', out[0].cents, 100);

console.log(`\n── verify:sunset-finance-revenue-by-product-f2: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
