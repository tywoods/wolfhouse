'use strict';

/**
 * Quote-path coverage for course-owned multi-item equipment (Luna offering_id route).
 * Replaces legacy equipment_included / Surfboard+Wetsuit singleton assertions.
 */

const assert = require('assert');
const { projectSunsetBookableOfferingsFromConfig, scheduleCoursesFromBookableProjection } = require('./lib/sunset-bookable-offerings');
const { buildSunsetQuoteCommand, executeSunsetQuoteSync, QUOTE_CHANNELS } = require('./lib/luna-front-desk-quote-service');

const COURSE = 'a5aef000-0000-4000-8000-000000000000';
const ITEM = `surf_pack_${COURSE}__1_day`;

const rentals = [
  { offering_key: 'softboard', label: 'Softboard', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'carbon_fins', label: 'Carbon Fins', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
];

function baseCfg(equipmentOptions) {
  return {
    ok: true, source: 'db',
    rental_offerings: rentals,
    surf_packs: [{
      pack_id: COURSE, label: 'Incident course', active: true,
      group_size: 8, weekly: 'daily', schedules: ['0930_1130'],
      equipment_options: equipmentOptions,
      price_tiers: [{ key: '1_day', label: '1 day', hours: 2 }],
    }],
    prices: [{
      id: 'price-incident', category: 'package', offering_key: ITEM, item_code: ITEM,
      amount_cents: 4000, unit: 'day', active: true, currency: 'EUR',
    }],
  };
}

const options = [
  { offering_key: 'softboard', equipment_price_cents: 0, all_day_surcharge_cents: 500 },
  { offering_key: 'carbon_fins', equipment_price_cents: 0, all_day_surcharge_cents: 0 },
];
const cfg = baseCfg(options);

const projection = projectSunsetBookableOfferingsFromConfig(cfg, {
  locationId: 'sunset-somo', requestedDates: ['2026-09-01'], asOf: '2026-07-28',
});
assert.equal(projection.ok, true);
const offering = projection.offerings.find((row) => row.offering_id === ITEM);
assert(offering, 'exact incident offering must project');
assert.deepStrictEqual(
  offering.equipment_options.map((row) => row.offering_key),
  ['softboard', 'carbon_fins'],
);
const course = scheduleCoursesFromBookableProjection(projection).find((row) => row.course_id === COURSE);
assert(course, 'incident course must project');
assert.deepStrictEqual(course.equipment_options.map((row) => row.offering_key), ['softboard', 'carbon_fins']);
assert.ok(!Object.prototype.hasOwnProperty.call(course, 'equipment_included'));

function quote(config, equipment, quantity = 2) {
  const built = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.LUNA_WHATSAPP,
    transportBody: {
      offering_id: ITEM,
      course_id: COURSE,
      quantity,
      service_dates: ['2026-09-01'],
      ...(equipment === undefined ? {} : { course_equipment: equipment }),
    },
    trustedLocationId: 'sunset-somo',
    now: new Date('2026-07-28T12:00:00Z'),
  });
  assert.equal(built.ok, true);
  return executeSunsetQuoteSync(built.command, { adminCfg: config });
}

const ordinary = quote(cfg, undefined);
assert.equal(ordinary.ok, true);
assert.equal(ordinary.body.line_items.filter((l) => l.course_equipment).length, 0,
  'ordinary offering quote must not invent equipment lines');

const selection = [
  { offering_key: 'softboard', mode: 'during_course', quantity: 2 },
  { offering_key: 'carbon_fins', mode: 'during_course', quantity: 2 },
];
const allowed = quote(cfg, selection);
assert.equal(allowed.ok, true, JSON.stringify(allowed.body));
// course 4000×2 + free during equipment
assert.equal(allowed.body.total_cents, 8000);
assert.deepStrictEqual(allowed.body.course_equipment, selection);
const gearLines = allowed.body.line_items.filter((line) => line.course_equipment);
assert.deepStrictEqual(gearLines.map((line) => line.offering_key).sort(), ['carbon_fins', 'softboard']);
assert.ok(gearLines.every((line) => line.total_cents === 0));
assert.deepStrictEqual(allowed.body.quote_provenance.course_equipment, selection);
assert.equal(allowed.body.quote_provenance.line_items.length, 3);
assert.match(allowed.body.quote_provenance.quote_fingerprint, /^[a-f0-9]{64}$/);
assert.notEqual(
  allowed.body.quote_provenance.quote_fingerprint,
  ordinary.body.quote_provenance.quote_fingerprint,
);

// All Day with surcharge 0 remains selectable; softboard all-day adds surcharge.
const allDay = quote(cfg, [
  { offering_key: 'softboard', mode: 'all_day', quantity: 2 },
]);
assert.equal(allDay.ok, true, JSON.stringify(allDay.body));
assert.equal(allDay.body.total_cents, 8000 + 1000);

// Quantity above surfers fails closed.
assert.equal(
  quote(cfg, [{ offering_key: 'softboard', mode: 'during_course', quantity: 3 }]).body.reason,
  'invalid_course_equipment',
);

// Not configured / foreign identity fails closed.
const emptyCfg = baseCfg([]);
assert.equal(
  quote(emptyCfg, [{ offering_key: 'softboard', mode: 'during_course', quantity: 1 }], 1).body.reason,
  'invalid_course_equipment',
);

const changedPriceCfg = JSON.parse(JSON.stringify(cfg));
changedPriceCfg.prices[0].amount_cents = 4500;
const changedPrice = quote(changedPriceCfg, selection);
assert.equal(changedPrice.body.total_cents, 9000);
assert.notEqual(
  changedPrice.body.quote_provenance.quote_fingerprint,
  allowed.body.quote_provenance.quote_fingerprint,
  'authoritative price changes must change provenance',
);

console.log('verify:luna-future-course-equipment-incident — ALL CHECKS PASSED');
