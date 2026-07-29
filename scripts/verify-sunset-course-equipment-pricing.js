'use strict';
const assert = require('assert');
const gear = require('./lib/sunset-course-equipment-pricing');
let n = 0; const ok = (v, m) => { n++; assert(v, m); };
const enabled = { all_day: { enabled: true, surfboard_cents: 1200, wetsuit_cents: 500 } };
const disabled = { all_day: { enabled: false, surfboard_cents: 1200, wetsuit_cents: 500 } };
assert.deepStrictEqual(gear.validateConfig(enabled), enabled); n++;
for (const bad of [null, [], {}, { ...enabled, evil: 1 }, { all_day: { surfboard_cents: 1, wetsuit_cents: 2 } }, { all_day: { enabled: true, surfboard_cents: 1.2, wetsuit_cents: 2 } }]) {
  assert.throws(() => gear.validateConfig(bad), TypeError); n++;
}
assert.deepStrictEqual(gear.normalizeConfig({ legacy: true }), gear.normalizeConfig(null)); n++;
ok(gear.normalizeConfig(null).all_day.enabled === false, 'safe missing default disables All Day');
assert.deepStrictEqual(gear.normalizeConfig({ all_day: { surfboard_cents: 1200, wetsuit_cents: 500 } }), enabled); n++;
assert.deepStrictEqual(gear.clampSelection({ mode: 'all_day', quantity: 4 }, 2), { mode: 'all_day', quantity: 2 }); n++;
assert.strictEqual(gear.clampSelection(null, 2), null); n++;

const allDay = gear.quoteCourseEquipment({ config: enabled, course: {}, selection: { mode: 'all_day', quantity: 2 }, surfers: 3, booking_dates: ['2026-08-01', '2026-08-02'] });
ok(allDay.lines.length === 4, 'All Day: board+suit every date');
ok(allDay.inventory.length === 4 && allDay.inventory.every((x) => x.quantity === 2), 'All Day inventory quantity');
ok(allDay.total_cents === 6800, 'All Day individual prices summed pp/day');
ok(allDay.lines.every((x) => Number.isSafeInteger(x.amount_cents)), 'All Day integer server cents');
assert.throws(() => gear.quoteCourseEquipment({ config: disabled, course: {}, selection: { mode: 'all_day', quantity: 1 }, surfers: 1, booking_dates: ['2026-08-01'] }), /disabled/); n++;

const included = gear.quoteCourseEquipment({ config: enabled, course: { equipment_included: true, equipment_price_cents: 700 }, selection: { mode: 'during_course', quantity: 3 }, surfers: 3, booking_dates: ['2026-08-01', '2026-08-02'] });
ok(included.total_cents === 4200, 'course-owned included equipment price applies per participant/course day');
ok(included.lines.reduce((sum, line) => sum + line.total_cents, 0) === 4200, 'included line totals match authoritative total');
const freeIncluded = gear.quoteCourseEquipment({ config: enabled, course: { equipment_included: true, equipment_price_cents: 0 }, selection: { mode: 'during_course', quantity: 3 }, surfers: 3, booking_dates: ['2026-08-01', '2026-08-02'] });
ok(freeIncluded.total_cents === 0 && freeIncluded.lines.every((x) => x.total_cents === 0), 'zero course-owned price means included free gear');
assert.throws(() => gear.quoteCourseEquipment({ config: enabled, course: { equipment_included: false, equipment_price_cents: 700 }, selection: { mode: 'during_course', quantity: 1 }, surfers: 1, booking_dates: ['2026-08-01'] }), /not included/); n++;

const none = gear.quoteCourseEquipment({ config: enabled, selection: null, surfers: 3, booking_dates: ['2026-08-01'] });
ok(none.total_cents === 0 && none.lines.length === 0, 'initially/deselected none');
for (const badSelection of [{ mode: 'all_day', quantity: 0 }, { mode: 'all_day', quantity: 4 }, { mode: 'both', quantity: 1 }, { mode: 'all_day', quantity: 1, amount_cents: 1 }]) {
  assert.throws(() => gear.quoteCourseEquipment({ config: enabled, selection: badSelection, surfers: 3, booking_dates: ['2026-08-01'] })); n++;
}
const inv = gear.dedupeInventory([
  ...allDay.inventory,
  { component: 'surfboard', service_date: '2026-08-01', quantity: 2 },
]);
ok(inv.length === 4 && inv.find((x) => x.component === 'surfboard' && x.service_date === '2026-08-01').quantity === 2, 'inventory dedupe uses max');
ok(gear.dedupeInventory([]).length === 0, 'cancel removes demand');
const invoice = gear.invoiceLines(freeIncluded);
ok(invoice.length === 4 && invoice.every((x) => x.total_cents === 0), 'invoice has free included coverage');

let state = gear.clampSelection({ mode: 'during_course', quantity: 3 }, 3);
let quote = gear.quoteCourseEquipment({ config: enabled, course: { equipment_included: true, equipment_price_cents: 500 }, selection: state, surfers: 3, booking_dates: ['2026-08-01', '2026-08-02'] });
ok(quote.total_cents === 3000, 'course-owned create quote');
state = { mode: 'all_day', quantity: state.quantity };
quote = gear.quoteCourseEquipment({ config: enabled, course: {}, selection: state, surfers: 3, booking_dates: ['2026-08-01', '2026-08-02'] });
ok(quote.total_cents === 10200 && quote.lines.every((x) => x.metadata.course_equipment_mode === 'all_day'), 'All Day selection replaces included-course mode');
state = null; quote = gear.quoteCourseEquipment({ config: enabled, selection: state, surfers: 3, booking_dates: ['2026-08-01'] });
ok(quote.lines.length === 0, 'deselect clears stale payload');
const somo = gear.quoteCourseEquipment({ config: enabled, selection: { mode: 'all_day', quantity: 1 }, surfers: 1, booking_dates: ['2026-08-01'] });
assert.throws(() => gear.quoteCourseEquipment({ config: null, selection: { mode: 'all_day', quantity: 1 }, surfers: 1, booking_dates: ['2026-08-01'] }), /disabled/); n++;
ok(somo.total_cents === 1700, 'resolved location pricing remains isolated');
console.log(`PASS course equipment pricing consolidated contract (${n} assertions)`);
