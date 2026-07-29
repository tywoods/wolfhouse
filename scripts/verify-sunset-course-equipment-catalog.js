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
const { projectSunsetBookableOfferingsFromConfig, loadSunsetBookableOfferings, scheduleCoursesFromBookableProjection } = require('./lib/sunset-bookable-offerings');

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

const rentalRows = [
  { offering_key: 'kayak_rental', label: 'Same label', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'helmet_rental', label: 'Same label', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'inactive_rental', label: 'Inactive', active: false, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'foreign_location', label: 'Foreign location', active: true, client_slug: 'sunset', location_id: 'sunset-sardinero' },
  { offering_key: 'foreign_tenant', label: 'Foreign tenant', active: true, client_slug: 'other', location_id: 'sunset-somo' },
];
const configured = options.concat([
  { offering_key: 'inactive_rental', equipment_price_cents: 1, all_day_surcharge_cents: 0 },
  { offering_key: 'foreign_location', equipment_price_cents: 1, all_day_surcharge_cents: 0 },
  { offering_key: 'foreign_tenant', equipment_price_cents: 1, all_day_surcharge_cents: 0 },
]);
const cfg = { ok: true, source: 'db', prices: [{ category: 'package', offering_key: 'surf_pack_p__1_day', unit: 'day', amount_cents: 1000, active: true }], rental_offerings: rentalRows, surf_packs: [{ pack_id: 'p', label: 'G', equipment_options: configured, price_tiers: [{ key: '1_day', label: '1 day', amount_cents: 1000 }], schedules: [], weekly: 'daily' }], private_lesson: { enabled: true, label: 'Private', amount_cents: 2000, equipment_options: configured } };
const catalogProjection = projectSunsetBookableOfferingsFromConfig(cfg, { locationId: 'somo' });
const exact = configured.slice(0, 2).map((row) => ({ ...row, label: 'Same label', location_id: 'sunset-somo' }));
assert.deepStrictEqual(catalogProjection.offerings.find((x) => x.offering_type === 'course').equipment_options, exact);
assert.deepStrictEqual(catalogProjection.offerings.find((x) => x.offering_type === 'private_lesson').equipment_options, exact);
assert.deepStrictEqual(catalogProjection.courses[0].equipment_options, exact);
const scheduled = scheduleCoursesFromBookableProjection(catalogProjection)[0];
assert.deepStrictEqual(scheduled.equipment_options, exact);
assert.ok(!Object.prototype.hasOwnProperty.call(scheduled, 'equipment_included'));
assert.ok(!Object.prototype.hasOwnProperty.call(scheduled, 'equipment_price_cents'));

function fakePg(locationId) {
  return { query: async (sql, params = []) => {
    const text = String(sql);
    if (/information_schema\.columns/.test(text)) return { rows: [{ exists: 1 }] };
    if (/FROM tenant_surf_pack_rules/.test(text)) return { rows: [{ id: 'p', label: 'Async Group', active: true, config_json: { equipment_options: configured, group_size: 8, price_tiers: [{ key: '1_day', label: '1 day' }], schedules: [], weekly: 'daily' } }] };
    if (/FROM tenant_rental_offerings/.test(text)) return { rows: rentalRows.concat([{ offering_key: 'price_free_identity', label: 'No standalone price', active: true, client_slug: 'sunset', location_id: locationId }]) };
    if (/FROM tenant_private_lesson_rules/.test(text)) return { rows: [{ id: 'private', label: 'Async Private', active: true, config_json: { amount_cents: 2500, equipment_options: configured } }] };
    if (/FROM tenant_price_rules/.test(text)) return { rows: [{ id: 'price', amount_cents: 1000, currency: 'EUR', item_type: 'package', item_code: params[2], unit: 'day', location_id: locationId }] };
    return { rows: [] };
  } };
}

(async () => {
  for (const locationId of ['sunset-somo', 'sunset-sardinero']) {
    const rows = locationId === 'sunset-somo' ? rentalRows : rentalRows.map((r, index) => ({
      ...r,
      location_id: index < 2 ? 'sunset-sardinero' : 'sunset-somo',
    }));
    const pg = fakePg(locationId);
    if (locationId === 'sunset-sardinero') pg.query = async (sql, params = []) => {
      const text = String(sql);
      if (/FROM tenant_rental_offerings/.test(text)) return { rows };
      if (/information_schema\.columns/.test(text)) return { rows: [{ exists: 1 }] };
      if (/FROM tenant_surf_pack_rules/.test(text)) return { rows: [{ id: 'p', label: 'Async Group', active: true, config_json: { equipment_options: configured, group_size: 8, price_tiers: [{ key: '1_day', label: '1 day' }], schedules: [], weekly: 'daily' } }] };
      if (/FROM tenant_private_lesson_rules/.test(text)) return { rows: [{ id: 'private', label: 'Async Private', active: true, config_json: { amount_cents: 2500, equipment_options: configured } }] };
      if (/FROM tenant_price_rules/.test(text)) return { rows: [{ id: 'price', amount_cents: 1000, currency: 'EUR', item_type: 'package', item_code: params[2], unit: 'day', location_id: locationId }] };
      return { rows: [] };
    };
    const asyncCatalog = await loadSunsetBookableOfferings(pg, { locationId });
    assert.strictEqual(asyncCatalog.ok, true);
    assert.deepStrictEqual(asyncCatalog.offerings.find((x) => x.offering_type === 'course').equipment_options.map((x) => x.offering_key), ['kayak_rental', 'helmet_rental']);
    assert.deepStrictEqual(asyncCatalog.offerings.find((x) => x.offering_type === 'private_lesson').equipment_options.map((x) => x.offering_key), ['kayak_rental', 'helmet_rental']);
    assert.deepStrictEqual(asyncCatalog.courses[0].equipment_options.map((x) => x.label), ['Same label', 'Same label']);
  }
  console.log('PASS sunset course-owned equipment catalog');
})().catch((err) => { console.error(err); process.exitCode = 1; });
