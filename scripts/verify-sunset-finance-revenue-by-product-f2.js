'use strict';

/**
 * verify:sunset-finance-revenue-by-product-f2
 * F2 — 5-row Revenue by product (lessons, course-included, top2, Other); Capacity mirrors first 4.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const {
  buildRevenueByProductRows,
  buildRevenueByProductFiveRows,
  computeSunsetFinanceSummary,
} = require(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'));

const build = buildRevenueByProductRows || buildRevenueByProductFiveRows;

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra != null ? ` (${extra})` : ''}`); }
}
function eq(label, a, b) {
  ok(label, a === b, `got ${a} want ${b}`);
}

const RANGE = { start: '2026-08-01', end: '2026-08-31' };
const packs = [{ config: { equipment_options: [
  { offering_key: 'board_rental' },
  { offering_key: 'wetsuit_rental' },
] } }];

const dated = [
  { service_date: '2026-08-05', service_type: 'surf_lesson', due: 10000, metadata: { component: 'course' } },
  { service_date: '2026-08-05', service_type: 'addon_service', due: 0, metadata: { offering_key: 'board_rental', course_equipment: true, course_equipment_mode: 'during_course', offering_label: 'Surfboard' } },
  { service_date: '2026-08-06', service_type: 'addon_service', due: 1500, metadata: { offering_key: 'board_rental', course_equipment: true, course_equipment_mode: 'all_day', offering_label: 'Surfboard' } },
  { service_date: '2026-08-07', service_type: 'surfboard', due: 2500, metadata: { offering_key: 'board_rental', offering_label: 'Surfboard' } },
  { service_date: '2026-08-05', service_type: 'addon_service', due: 500, metadata: { offering_key: 'wetsuit_rental', course_equipment: true, course_equipment_mode: 'during_course', offering_label: 'Wetsuit' } },
  { service_date: '2026-08-08', service_type: 'addon_service', due: 8000, metadata: { offering_key: 'bike_rental', offering_label: 'Bike' } },
  { service_date: '2026-08-09', service_type: 'addon_service', due: 6000, metadata: { offering_key: 'towel_rental', offering_label: 'Towel' } },
  { service_date: '2026-08-10', service_type: 'addon_service', due: 1200, metadata: { offering_key: 'kayak_rental', offering_label: 'Kayak' } },
  { service_date: '2026-08-11', service_type: 'addon_service', due: 300, metadata: { offering_key: 'locker_rental', offering_label: 'Locker' } },
];

const rows = build(dated, RANGE, packs);
eq('exactly 5 rows', rows.length, 5);
eq('row0 lessons slot', rows[0].slot, 'lessons');
eq('row0 lessons cents', rows[0].cents, 10000);
eq('row1 course_included slot', rows[1].slot, 'course_included');
// board 0+1500+2500 + wetsuit 500 = 4500
eq('row1 course-included multi-mode sum', rows[1].cents, 4500);
eq('row2 top item bike 8000', rows[2].cents, 8000);
ok('row2 label Bike', /bike/i.test(rows[2].label));
eq('row3 second towel 6000', rows[3].cents, 6000);
eq('row4 Other slot', rows[4].slot, 'other');
eq('row4 Other = remainder kayak+locker 1500', rows[4].cents, 1500);
// Other row captures the remainder, so displayed rows now sum to the full product pool.
const totalShown = rows.reduce((a, r) => a + r.cents, 0);
eq('shown = full product pool', totalShown, 10000 + 4500 + 8000 + 6000 + 1200 + 300);

// Empty period → 4 zero rows
const empty = build([], RANGE, packs);
eq('empty still 5 rows', empty.length, 5);
ok('empty all zero', empty.every((r) => r.cents === 0));

// Fewer items → rank slots €0
const few = build([
  { service_date: '2026-08-05', service_type: 'surf_lesson', due: 5000, metadata: { component: 'course' } },
  { service_date: '2026-08-05', service_type: 'addon_service', due: 2000, metadata: { offering_key: 'bike_rental', offering_label: 'Bike' } },
], RANGE, packs);
eq('few still 5 rows', few.length, 5);
eq('few lessons', few[0].cents, 5000);
eq('few course included 0', few[1].cents, 0);
eq('few top1 bike', few[2].cents, 2000);
eq('few top2 zero', few[3].cents, 0);

// Tie-break deterministic by label
const tie = build([
  { service_date: '2026-08-05', service_type: 'addon_service', due: 1000, metadata: { offering_key: 'zebra', offering_label: 'Zebra' } },
  { service_date: '2026-08-05', service_type: 'addon_service', due: 1000, metadata: { offering_key: 'apple', offering_label: 'Apple' } },
], RANGE, packs);
ok('tie prefers Apple then Zebra by label', /apple/i.test(tie[2].label) && /zebra/i.test(tie[3].label));

// Capacity mirrors 4 rows
const s = computeSunsetFinanceSummary({
  now: new Date('2026-08-15T12:00:00Z'),
  timeZone: 'Europe/Madrid',
  view: { granularity: 'month', anchor: '2026-08-15' },
  bsr: dated.map((r, i) => ({
    booking_id: 'B' + i,
    service_date: r.service_date,
    service_type: r.service_type,
    amount_due_cents: r.due,
    quantity: 1,
    metadata: r.metadata,
  })),
  payments: [],
  bookings: [],
  surf_packs: packs,
  rental_stock: [
    { offering_key: 'board_rental', stock_quantity: 10 },
    { offering_key: 'bike_rental', stock_quantity: 5 },
  ],
});
ok('summary revenue 5', (s.redesign.revenue_by_product || []).length === 5);
ok('summary capacity 4', (s.redesign.capacity.by_product || []).length === 4);
ok('exported build alias', typeof buildRevenueByProductFiveRows === 'function' || typeof buildRevenueByProductRows === 'function');

console.log(`\n── verify:sunset-finance-revenue-by-product-f2: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
