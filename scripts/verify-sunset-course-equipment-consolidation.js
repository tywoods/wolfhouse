'use strict';
const assert = require('assert');
const fs = require('fs');
const packs = require('./lib/sunset-admin-pack-rules');
const privateRules = require('./lib/sunset-admin-private-lesson-rules');
const pricing = require('./lib/sunset-course-equipment-pricing');

const options = [
  { offering_key: 'softboard', during_course_price_cents: 725, all_day_price_cents: 0 },
  { offering_key: 'carbon_fins', during_course_price_cents: 200, all_day_price_cents: 100 },
];
const legacyOptions = [
  { offering_key: 'softboard', equipment_price_cents: 725, all_day_surcharge_cents: 0 },
  { offering_key: 'carbon_fins', equipment_price_cents: 200, all_day_surcharge_cents: 100 },
];

// Course entities own multi-item equipment_options (obsolete scalar fields rejected).
assert.equal(packs.validatePackBody({ equipment_included: true, equipment_price_cents: 0 }).ok, false);
// Admin writes only canonical independent totals.
assert.deepStrictEqual(
  packs.validatePackBody({ equipment_options: options }).patch,
  { equipment_options: options },
);
assert.equal(packs.validatePackBody({ equipment_options: legacyOptions }).ok, false);
// Historical map/load normalizes legacy pair → canonical independent totals.
assert.deepStrictEqual(
  packs.mapPackRow({ id: 'g', label: 'Group', config_json: { equipment_options: options } }).equipment_options,
  options,
);
assert.deepStrictEqual(
  packs.mapPackRow({ id: 'legacy', label: 'Legacy', config_json: { equipment_options: legacyOptions } }).equipment_options,
  options,
);
assert.deepStrictEqual(
  packs.mapPackRow({ id: 'legacy-empty', label: 'Legacy', config_json: {} }).equipment_options,
  [],
);
assert.equal(privateRules.validatePrivateLessonBody({ equipment_included: true, equipment_price_cents: 0 }).ok, false);
assert.deepStrictEqual(
  privateRules.validatePrivateLessonBody({ equipment_options: options }).patch.equipment_options,
  options,
);
assert.deepStrictEqual(
  privateRules.mapPrivateLessonRow({
    id: 'p', active: true, label: 'Private', config_json: { equipment_options: options },
  }).equipment_options,
  options,
);

// Quote uses course-owned independent totals × unique course dates.
const quote = pricing.quoteCourseEquipment({
  course: { course_id: 'g', equipment_options: options },
  selection: [
    { offering_key: 'softboard', mode: 'during_course', quantity: 2 },
    { offering_key: 'carbon_fins', mode: 'all_day', quantity: 1 },
  ],
  surfers: 2,
  serviceDates: ['2026-09-01'],
});
// softboard 725×2 + carbon all_day independent 100×1 = 1550
assert.equal(quote.total_cents, 1450 + 100);
assert.equal(quote.lines.reduce((n, line) => n + line.total_cents, 0), 1550);
assert.throws(() => pricing.quoteCourseEquipment({
  course: { equipment_options: options },
  selection: [{ offering_key: 'missing', mode: 'during_course', quantity: 1 }],
  surfers: 1,
  serviceDates: ['2026-09-01'],
}));
assert.throws(() => pricing.quoteCourseEquipment({
  course: { equipment_options: [] },
  selection: [{ offering_key: 'softboard', mode: 'all_day', quantity: 1 }],
  surfers: 1,
  serviceDates: ['2026-09-01'],
}));

// Transitional validateConfig remains parse-only for the old Admin location route.
const legacyShape = { all_day: { enabled: true, surfboard_cents: 0, wetsuit_cents: 0 } };
assert.deepStrictEqual(pricing.validateConfig(legacyShape), legacyShape);

const ui = fs.readFileSync(require.resolve('./browser/sunset-admin-ui'), 'utf8');
assert(ui.includes('equipment_options'));
assert(ui.includes('adminRenderEquipmentEditor'));
assert(ui.includes('during_course_price_cents'));
assert(ui.includes('all_day_price_cents'));
// Location-wide All Day Surfboard/Wetsuit Admin block is retired (Slice 1).
assert(!ui.includes('admin-course-all-day-enabled'));
assert(!ui.includes('admin-course-all-day-board'));
assert(!ui.includes('admin-course-all-day-suit'));
assert(!ui.includes('save-course-equipment'));
assert(!ui.includes('admin-course-during-board'));
assert(!ui.includes('admin-course-equipment-policy'));
assert(ui.includes('adminParseEurosToCents'));
console.log('PASS Sunset course equipment Admin consolidation and course-owned pricing');
