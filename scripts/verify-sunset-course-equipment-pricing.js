'use strict';
const assert = require('assert');
const gear = require('./lib/sunset-course-equipment-pricing');
let n = 0; const ok = (v, m) => { n++; assert(v, m); };

const course = {
  course_id: 'p',
  equipment_options: [
    { offering_key: 'softboard', label: 'Softboard', equipment_price_cents: 500, all_day_surcharge_cents: 1000 },
    { offering_key: 'carbon_fins', label: 'Carbon Fins', equipment_price_cents: 200, all_day_surcharge_cents: 0 },
  ],
};
const offerings = [
  { offering_key: 'softboard', label: 'Softboard', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'carbon_fins', label: 'Carbon Fins', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
];

// During: qty × base once per course (not per day)
const during = gear.quoteCourseEquipment({
  course,
  selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: 2 }],
  surfers: 3,
  offerings,
  clientSlug: 'sunset',
  locationId: 'sunset-somo',
});
ok(during.total_cents === 1000, 'during course charges once per booked course');
ok(during.lines.length === 1 && during.lines[0].base_unit_cents === 500, 'base unit from course option');
ok(during.course_equipment[0].mode === 'during_course', 'wire echo uses mode');

// All Day: qty × (base + surcharge); surcharge 0 remains valid
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
});
ok(allDay.total_cents === 3200, 'all day mixed lines');
ok(allDay.lines.find((l) => l.offering_key === 'carbon_fins').all_day_surcharge_unit_cents === 0, '0 surcharge valid');
ok(allDay.lines.every((l) => l.billing_unit === 'person_per_course'), 'never per booking day');

// Zero selections
const none = gear.quoteCourseEquipment({ course, selection: [], surfers: 3, offerings, clientSlug: 'sunset', locationId: 'sunset-somo' });
ok(none.total_cents === 0 && none.lines.length === 0, 'empty selection');
const nullSel = gear.quoteCourseEquipment({ course, selection: null, surfers: 3 });
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
    course, selection: bad, surfers: 3, offerings, clientSlug: 'sunset', locationId: 'sunset-somo',
  })); n++;
}

// Overflow
assert.throws(() => gear.quoteCourseEquipment({
  course: { equipment_options: [{ offering_key: 'softboard', equipment_price_cents: Number.MAX_SAFE_INTEGER, all_day_surcharge_cents: 1 }] },
  selection: [{ offering_key: 'softboard', mode: 'all_day', quantity: 1 }],
  surfers: 1,
}), /overflow/); n++;

// Inactive scoped offering fails closed when offerings provided
assert.throws(() => gear.quoteCourseEquipment({
  course,
  selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: 1 }],
  surfers: 1,
  offerings: [{ offering_key: 'softboard', label: 'Softboard', active: false, client_slug: 'sunset', location_id: 'sunset-somo' }],
  clientSlug: 'sunset',
  locationId: 'sunset-somo',
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
  course: { equipment_options: [{ offering_key: 'softboard', equipment_price_cents: 700, all_day_surcharge_cents: 300, label: 'Softboard' }] },
  selection: [{ offering_key: 'softboard', mode: 'all_day', quantity: 1 }],
  surfers: 1,
});
ok(sard.total_cents === 1000, 'caller supplies location-scoped course options');

console.log(`PASS course equipment pricing course-owned contract (${n} assertions)`);
