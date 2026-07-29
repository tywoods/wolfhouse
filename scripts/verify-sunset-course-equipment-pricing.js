'use strict';
const assert = require('assert');
const gear = require('./lib/sunset-course-equipment-pricing');
let n = 0; const ok = (v, m) => { n++; assert(v, m); };

const course = {
  course_id: 'p',
  equipment_options: [
    { offering_key: 'softboard', label: 'Softboard', during_course_price_cents: 500, all_day_price_cents: 1000 },
    { offering_key: 'carbon_fins', label: 'Carbon Fins', during_course_price_cents: 200, all_day_price_cents: 0 },
  ],
};
const offerings = [
  { offering_key: 'softboard', label: 'Softboard', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'carbon_fins', label: 'Carbon Fins', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
];
const ONE_DAY = ['2026-09-01'];
const TWO_DAYS = ['2026-09-01', '2026-09-02'];

// During: qty × unit × unique dates
const during = gear.quoteCourseEquipment({
  course,
  selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: 2 }],
  surfers: 3,
  offerings,
  clientSlug: 'sunset',
  locationId: 'sunset-somo',
  serviceDates: ONE_DAY,
});
ok(during.total_cents === 1000, 'during course charges unit × qty × dates');
ok(during.lines.length === 1 && during.lines[0].unit_amount_cents === 500, 'unit from course option');
ok(during.course_equipment[0].mode === 'during_course', 'wire echo uses mode');

// All Day: independent total (not base + surcharge); × dates
const allDay = gear.quoteCourseEquipment({
  course,
  selection: [
    { offering_key: 'softboard', mode: 'all_day', quantity: 2 },
    { offering_key: 'carbon_fins', mode: 'all_day', quantity: 1 },
  ],
  surfers: 3,
  offerings,
  clientSlug: 'sunset',
  locationId: 'sunset-somo',
  serviceDates: ONE_DAY,
});
// 2×1000 + 1×0 = 2000
ok(allDay.total_cents === 2000, 'all day independent totals');
ok(allDay.lines.find((l) => l.offering_key === 'carbon_fins').all_day_price_cents === 0, '0 all-day price valid');
ok(allDay.lines.every((l) => l.billing_unit === 'person_per_course_date'), 'per person per course date');

// Multi-date multiplication
const multi = gear.quoteCourseEquipment({
  course,
  selection: [{ offering_key: 'softboard', mode: 'all_day', quantity: 2 }],
  surfers: 3,
  offerings,
  clientSlug: 'sunset',
  locationId: 'sunset-somo',
  serviceDates: TWO_DAYS,
});
ok(multi.total_cents === 4000, '2 dates × qty2 × €10');
ok(multi.lines[0].date_count === 2, 'date_count on line');

// Legacy pair reads as independent totals
const legacy = gear.quoteCourseEquipment({
  course: {
    equipment_options: [
      { offering_key: 'softboard', equipment_price_cents: 500, all_day_surcharge_cents: 1000 },
    ],
  },
  selection: [{ offering_key: 'softboard', mode: 'all_day', quantity: 2 }],
  surfers: 3,
  serviceDates: ['2026-09-01', '2026-09-02', '2026-09-03'],
});
ok(legacy.total_cents === 6000, 'legacy all_day_surcharge is independent All Day total');

// Zero selections
const none = gear.quoteCourseEquipment({
  course, selection: [], surfers: 3, offerings, clientSlug: 'sunset', locationId: 'sunset-somo', serviceDates: ONE_DAY,
});
ok(none.total_cents === 0 && none.lines.length === 0, 'empty selection');
const nullSel = gear.quoteCourseEquipment({ course, selection: null, surfers: 3, serviceDates: ONE_DAY });
ok(nullSel.total_cents === 0 && nullSel.lines.length === 0, 'null selection');

// Fail closed
for (const bad of [
  [{ offering_key: 'softboard', mode: 'all_day', quantity: 0 }],
  [{ offering_key: 'softboard', mode: 'all_day', quantity: 4 }],
  [{ offering_key: 'softboard', mode: 'both', quantity: 1 }],
  [{ offering_key: 'softboard', mode: 'all_day', quantity: 1, amount_cents: 1 }],
  [{ offering_key: 'missing', mode: 'during_course', quantity: 1 }],
  { mode: 'during_course', quantity: 1 },
]) {
  assert.throws(() => gear.quoteCourseEquipment({
    course, selection: bad, surfers: 3, offerings, clientSlug: 'sunset', locationId: 'sunset-somo', serviceDates: ONE_DAY,
  })); n++;
}

// Overflow: unit × qty × dates exceeds safe integer
assert.throws(() => gear.quoteCourseEquipment({
  course: { equipment_options: [{ offering_key: 'softboard', during_course_price_cents: 1, all_day_price_cents: Number.MAX_SAFE_INTEGER }] },
  selection: [{ offering_key: 'softboard', mode: 'all_day', quantity: 2 }],
  surfers: 2,
  serviceDates: ONE_DAY,
}), /overflow/); n++;

// Missing dates fail closed when selection present
assert.throws(() => gear.quoteCourseEquipment({
  course,
  selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: 1 }],
  surfers: 1,
  serviceDates: [],
})); n++;

// Inactive scoped offering fails closed when offerings provided
assert.throws(() => gear.quoteCourseEquipment({
  course,
  selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: 1 }],
  surfers: 1,
  offerings: [{ offering_key: 'softboard', label: 'Softboard', active: false, client_slug: 'sunset', location_id: 'sunset-somo' }],
  clientSlug: 'sunset',
  locationId: 'sunset-somo',
  serviceDates: ONE_DAY,
}), /active scoped/); n++;

// Wire normalizeSelection
assert.deepStrictEqual(
  gear.normalizeSelection([{ offering_key: 'softboard', mode: 'all_day', quantity: 2 }], 3),
  [{ offering_key: 'softboard', mode: 'all_day', quantity: 2 }],
); n++;

const invoice = gear.invoiceLines(allDay);
ok(invoice.length === 2 && invoice[0].offering_key === 'softboard', 'invoice lines carry offering identity');

// Location isolation stays caller-owned (different course options)
const sard = gear.quoteCourseEquipment({
  course: { equipment_options: [{ offering_key: 'softboard', during_course_price_cents: 700, all_day_price_cents: 1000, label: 'Softboard' }] },
  selection: [{ offering_key: 'softboard', mode: 'all_day', quantity: 1 }],
  surfers: 1,
  serviceDates: ONE_DAY,
});
ok(sard.total_cents === 1000, 'caller supplies location-scoped course options');

console.log(`PASS course equipment pricing course-owned contract (${n} assertions)`);
