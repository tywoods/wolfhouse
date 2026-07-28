'use strict';
const assert = require('assert');
const gear = require('./lib/sunset-course-equipment-pricing');
let n = 0; const ok = (v, m) => { n++; assert(v, m); };
const extra = { during_course: { policy: 'extra', surfboard_cents: 700, wetsuit_cents: 300 }, all_day: { surfboard_cents: 1200, wetsuit_cents: 500 } };
const free = { ...extra, during_course: { policy: 'free_with_course', surfboard_cents: 999, wetsuit_cents: 999 } };
assert.deepStrictEqual(gear.validateConfig(free).during_course, { policy: 'free_with_course', surfboard_cents: 0, wetsuit_cents: 0 }); n++;
for (const bad of [null, [], {}, { ...extra, evil: 1 }, { during_course: { ...extra.during_course, policy: 'free' }, all_day: extra.all_day }, { during_course: extra.during_course, all_day: { surfboard_cents: 1.2, wetsuit_cents: 2 } }]) {
  assert.throws(() => gear.validateConfig(bad), TypeError); n++;
}
assert.deepStrictEqual(gear.normalizeConfig({ legacy: true }), gear.normalizeConfig(null)); n++;
ok(gear.normalizeConfig(null).all_day.surfboard_cents === 0, 'safe missing default');
assert.deepStrictEqual(gear.clampSelection({ mode: 'all_day', quantity: 4 }, 2), { mode: 'all_day', quantity: 2 }); n++;
assert.strictEqual(gear.clampSelection(null, 2), null); n++;
for (const mode of ['during_course', 'all_day']) {
  const q = gear.quoteCourseEquipment({ config: extra, selection: { mode, quantity: 2 }, surfers: 3, booking_dates: ['2026-08-01', '2026-08-02'] });
  ok(q.lines.length === 4, `${mode}: board+suit every date`);
  ok(q.inventory.length === 4 && q.inventory.every((x) => x.quantity === 2), `${mode}: inventory quantity`);
  ok(q.total_cents === (mode === 'during_course' ? 4000 : 6800), `${mode}: individual prices summed pp/day`);
  ok(q.lines.every((x) => Number.isSafeInteger(x.amount_cents)), `${mode}: integer server cents`);
}
const fq = gear.quoteCourseEquipment({ config: free, selection: { mode: 'during_course', quantity: 3 }, surfers: 3, booking_dates: ['2026-08-01', '2026-08-02'] });
ok(fq.total_cents === 0 && fq.lines.every((x) => x.amount_cents === 0), 'free means trusted zeros');
const none = gear.quoteCourseEquipment({ config: extra, selection: null, surfers: 3, booking_dates: ['2026-08-01'] });
ok(none.total_cents === 0 && none.lines.length === 0, 'initially/deselected none');
for (const badSelection of [{ mode: 'all_day', quantity: 0 }, { mode: 'all_day', quantity: 4 }, { mode: 'both', quantity: 1 }, { mode: 'all_day', quantity: 1, amount_cents: 1 }]) {
  assert.throws(() => gear.quoteCourseEquipment({ config: extra, selection: badSelection, surfers: 3, booking_dates: ['2026-08-01'] })); n++;
}
const inv = gear.dedupeInventory([
  ...gear.quoteCourseEquipment({ config: extra, selection: { mode: 'all_day', quantity: 2 }, surfers: 2, booking_dates: ['2026-08-01'] }).inventory,
  { component: 'surfboard', service_date: '2026-08-01', quantity: 2 },
]);
ok(inv.length === 2 && inv.find((x) => x.component === 'surfboard').quantity === 2, 'inventory dedupe uses max');
ok(gear.dedupeInventory([]).length === 0, 'cancel removes demand');
const invoice = gear.invoiceLines(fq);
ok(invoice.length === 4 && invoice.every((x) => x.total_cents === 0), 'invoice has free coverage');
// Stateful create/edit transition harness: payload replacement clears stale mode/quote.
let state = null;
state = gear.clampSelection({ mode: 'during_course', quantity: 3 }, 3);
let quote = gear.quoteCourseEquipment({ config: extra, selection: state, surfers: 3, booking_dates: ['2026-08-01', '2026-08-02'] });
ok(quote.total_cents === 6000, 'create during quote');
state = { mode: 'all_day', quantity: state.quantity };
quote = gear.quoteCourseEquipment({ config: extra, selection: state, surfers: 3, booking_dates: ['2026-08-01', '2026-08-02'] });
ok(quote.total_cents === 10200 && quote.lines.every((x) => x.metadata.course_equipment_mode === 'all_day'), 'switch replaces stale mode');
state = null; quote = gear.quoteCourseEquipment({ config: extra, selection: state, surfers: 3, booking_dates: ['2026-08-01'] });
ok(quote.lines.length === 0, 'deselect clears stale payload');
// Location isolation is enforced by supplying only the server-resolved location config.
const somo = gear.quoteCourseEquipment({ config: extra, selection: { mode: 'all_day', quantity: 1 }, surfers: 1, booking_dates: ['2026-08-01'] });
const legacyOther = gear.quoteCourseEquipment({ config: null, selection: { mode: 'all_day', quantity: 1 }, surfers: 1, booking_dates: ['2026-08-01'] });
ok(somo.total_cents === 1700 && legacyOther.total_cents === 0, 'resolved location isolation/missing config');
console.log(`PASS course equipment pricing stateful contract (${n} assertions)`);
