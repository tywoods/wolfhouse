'use strict';

const assert = require('assert');
const {
  validateEquipmentOptions,
  normalizeEquipmentOptions,
  validateEquipmentSelection,
  projectEquipmentOptions,
} = require('./lib/sunset-course-equipment-options');
const { quoteCourseEquipment, invoiceLines } = require('./lib/sunset-course-equipment-pricing');
const { validatePackBody, mapPackRow } = require('./lib/sunset-admin-pack-rules');
const { validatePrivateLessonBody, mapPrivateLessonRow } = require('./lib/sunset-admin-private-lesson-rules');
const { projectSunsetBookableOfferingsFromConfig } = require('./lib/sunset-bookable-offerings');

const catalog = [
  { offering_key: 'kayak_rental', label: 'Kayak', active: true, client_slug: 'sunset', location_id: 'somo' },
  { offering_key: 'helmet_rental', label: 'Helmet', active: true, client_slug: 'sunset', location_id: 'somo' },
  { offering_key: 'wetsuit_rental', label: 'Wetsuit', active: false, client_slug: 'sunset', location_id: 'somo' },
  { offering_key: 'foreign_rental', label: 'Foreign', active: true, client_slug: 'sunset', location_id: 'sardinero' },
];
const options = [
  { offering_key: 'kayak_rental', equipment_price_cents: 500, all_day_surcharge_cents: 1000 },
  { offering_key: 'helmet_rental', equipment_price_cents: 200, all_day_surcharge_cents: 0 },
];
assert.deepStrictEqual(validateEquipmentOptions(options, { offerings: catalog, clientSlug: 'sunset', locationId: 'somo' }), options);
assert.deepStrictEqual(normalizeEquipmentOptions({ equipment_included: true, equipment_price_cents: 999 }), []);
for (const bad of [
  [options[0], options[0]],
  [{ offering_key: 'missing', equipment_price_cents: 1, all_day_surcharge_cents: 0 }],
  [{ offering_key: 'wetsuit_rental', equipment_price_cents: 1, all_day_surcharge_cents: 0 }],
  [{ offering_key: 'foreign_rental', equipment_price_cents: 1, all_day_surcharge_cents: 0 }],
  [{ offering_key: 'kayak_rental', equipment_price_cents: -1, all_day_surcharge_cents: 0 }],
]) assert.throws(() => validateEquipmentOptions(bad, { offerings: catalog, clientSlug: 'sunset', locationId: 'somo' }));
assert.throws(() => validateEquipmentSelection([{ offering_key: 'kayak_rental', quantity: 1, all_day: false, amount_cents: 1 }], 2));

for (const validator of [validatePackBody, validatePrivateLessonBody]) {
  const valid = validator({ equipment_options: options });
  assert.strictEqual(valid.ok, true);
  assert.deepStrictEqual(valid.patch.equipment_options, options);
  assert.strictEqual(validator({ equipment_included: true }).ok, false);
}
assert.deepStrictEqual(mapPackRow({ id: 'p', label: 'G', config_json: { equipment_options: options } }).equipment_options, options);
assert.deepStrictEqual(mapPrivateLessonRow({ id: 'x', label: 'P', active: true, config_json: { equipment_options: options } }).equipment_options, options);

const projected = projectEquipmentOptions(options, catalog, { clientSlug: 'sunset', locationId: 'somo' });
assert.deepStrictEqual(projected.map((x) => x.label), ['Kayak', 'Helmet']);
const quote = quoteCourseEquipment({ course: { course_id: 'p', equipment_options: projected }, selection: [
  { offering_key: 'kayak_rental', quantity: 2, all_day: true },
  { offering_key: 'helmet_rental', quantity: 1, all_day: true },
], surfers: 2 });
assert.strictEqual(quote.total_cents, 3200);
assert.strictEqual(quote.lines.length, 2);
assert.strictEqual(quote.lines[0].metadata.price_basis, 'per_person_per_course');
assert.strictEqual(invoiceLines(quote).length, 2);

const cfg = { ok: true, source: 'db', prices: [{ category: 'package', offering_key: 'surf_pack_p__1_day', unit: 'day', amount_cents: 1000, active: true }], surf_packs: [{ pack_id: 'p', label: 'G', equipment_options: options, price_tiers: [{ key: '1_day', label: '1 day', amount_cents: 1000 }], schedules: [], weekly: 'daily' }], private_lesson: { enabled: false } };
const catalogProjection = projectSunsetBookableOfferingsFromConfig(cfg, { locationId: 'somo' });
assert.deepStrictEqual(catalogProjection.offerings[0].equipment_options, options);
assert.deepStrictEqual(catalogProjection.courses[0].equipment_options, options);
assert.ok(!Object.prototype.hasOwnProperty.call(catalogProjection.offerings[0], 'equipment_included'));

console.log('PASS sunset course-owned equipment catalog');
