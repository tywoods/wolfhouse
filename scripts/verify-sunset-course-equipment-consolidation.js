'use strict';
const assert = require('assert');
const fs = require('fs');
const packs = require('./lib/sunset-admin-pack-rules');
const privateRules = require('./lib/sunset-admin-private-lesson-rules');
const pricing = require('./lib/sunset-course-equipment-pricing');

// Course entities own included-equipment entitlement and its combined per-person/day price.
assert.deepStrictEqual(
  packs.validatePackBody({ equipment_included: true, equipment_price_cents: 0 }).patch,
  { equipment_included: true, equipment_price_cents: 0 });
assert.equal(packs.mapPackRow({ id: 'g', label: 'Group', config_json: { equipment_included: true, equipment_price_cents: 725 } }).equipment_price_cents, 725);
assert.equal(packs.mapPackRow({ id: 'legacy', label: 'Legacy', config_json: { equipment_included: true } }).equipment_price_cents, 0);
assert.equal(privateRules.validatePrivateLessonBody({ equipment_included: true, equipment_price_cents: 0 }).ok, true);
assert.equal(privateRules.mapPrivateLessonRow({ id: 'p', active: true, label: 'Private', config_json: { equipment_included: true, equipment_price_cents: 950 } }).equipment_price_cents, 950);
assert.equal(privateRules.mapPrivateLessonRow({ id: 'legacy', active: true, label: 'Legacy', config_json: {} }).equipment_price_cents, 0);

// Included quote ignores obsolete shared during-course prices and uses the selected course.
const included = pricing.quoteCourseEquipment({
  config: { during_course: { policy: 'extra', surfboard_cents: 9999, wetsuit_cents: 9999 }, all_day: { enabled: true, surfboard_cents: 2000, wetsuit_cents: 800 } },
  course: { equipment_included: true, equipment_price_cents: 725 },
  selection: { mode: 'during_course', quantity: 2 }, surfers: 2, booking_dates: ['2026-08-01'],
});
assert.equal(included.total_cents, 1450);
assert.equal(included.lines.reduce((n, line) => n + line.total_cents, 0), 1450);
assert.throws(() => pricing.quoteCourseEquipment({ config: {}, course: { equipment_included: false, equipment_price_cents: 725 }, selection: { mode: 'during_course', quantity: 1 }, surfers: 1, booking_dates: ['2026-08-01'] }));
assert.throws(() => pricing.quoteCourseEquipment({ config: { all_day: { enabled: false, surfboard_cents: 1, wetsuit_cents: 1 } }, course: {}, selection: { mode: 'all_day', quantity: 1 }, surfers: 1, booking_dates: ['2026-08-01'] }));

const canonical = pricing.validateConfig({ all_day: { enabled: true, surfboard_cents: 0, wetsuit_cents: 0 } });
assert.deepStrictEqual(canonical, { all_day: { enabled: true, surfboard_cents: 0, wetsuit_cents: 0 } });
assert.deepStrictEqual(pricing.normalizeConfig({ during_course: { policy: 'extra', surfboard_cents: 1, wetsuit_cents: 2 }, all_day: { surfboard_cents: 3, wetsuit_cents: 4 } }), { all_day: { enabled: true, surfboard_cents: 3, wetsuit_cents: 4 } });

const ui = fs.readFileSync(require.resolve('./browser/sunset-admin-ui'), 'utf8');
assert(ui.includes('admin-pack-equipment-price'));
assert(ui.includes('admin-private-equipment-included'));
assert(ui.includes('admin-private-equipment-price'));
assert(ui.includes('admin-course-all-day-enabled'));
assert(!ui.includes('admin-course-during-board'));
assert(!ui.includes('admin-course-equipment-policy'));
assert(ui.includes("adminParseEurosToCents"));
console.log('PASS Sunset course equipment Admin consolidation and per-course pricing');
