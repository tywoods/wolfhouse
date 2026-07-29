'use strict';
const assert = require('assert');
const fs = require('fs');
const { projectSunsetBookableOfferingsFromConfig } = require('./lib/sunset-bookable-offerings');
const { buildSunsetQuoteCommand, executeSunsetQuoteSync, QUOTE_CHANNELS } = require('./lib/luna-front-desk-quote-service');

function privateConfig(options) {
  return {
    ok: true, source: 'db', surf_packs: [], prices: [],
    rental_offerings: [
      { offering_key: 'softboard', label: 'Softboard', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
      { offering_key: 'carbon_fins', label: 'Carbon Fins', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
    ],
    private_lesson: {
      id: 'private-somo', enabled: true, label: 'Private lesson', amount_cents: 6000,
      currency: 'EUR', price_basis: 'per_session', default_duration_minutes: 120,
      equipment_options: options,
    },
  };
}

function quote(cfg, quantity, equipment) {
  const projection = projectSunsetBookableOfferingsFromConfig(cfg, {
    locationId: 'sunset-somo', requestedDates: ['2026-09-01'], asOf: '2026-07-29',
  });
  assert.equal(projection.ok, true);
  const offering = projection.offerings.find((row) => row.offering_type === 'private_lesson');
  assert(offering, 'private offering projected');
  const built = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.LUNA_WHATSAPP,
    transportBody: {
      offering_id: offering.offering_id,
      quantity,
      service_dates: ['2026-09-01'],
      course_equipment: equipment,
    },
    trustedLocationId: 'sunset-somo',
    now: new Date('2026-07-29T12:00:00Z'),
  });
  assert.equal(built.ok, true);
  return executeSunsetQuoteSync(built.command, { adminCfg: cfg });
}

const paidOptions = [
  { offering_key: 'softboard', equipment_price_cents: 500, all_day_surcharge_cents: 0 },
  { offering_key: 'carbon_fins', equipment_price_cents: 400, all_day_surcharge_cents: 0 },
];
const selection = [
  { offering_key: 'softboard', mode: 'during_course', quantity: 2 },
  { offering_key: 'carbon_fins', mode: 'during_course', quantity: 2 },
];
const paid = quote(privateConfig(paidOptions), 2, selection);
assert.equal(paid.ok, true, JSON.stringify(paid.body));
// private 6000×2 + equipment 2×500 + 2×400 = 12000 + 1000 + 800 = 13800
assert.equal(paid.body.total_cents, 13800, JSON.stringify(paid.body));
assert.equal(paid.body.line_items.filter((line) => line.course_equipment).length, 2);

const freeOptions = [
  { offering_key: 'softboard', equipment_price_cents: 0, all_day_surcharge_cents: 0 },
];
const free = quote(privateConfig(freeOptions), 2, [
  { offering_key: 'softboard', mode: 'during_course', quantity: 2 },
]);
assert.equal(free.ok, true, JSON.stringify(free.body));
assert.equal(free.body.total_cents, 12000, 'zero equipment price is valid');

const denied = quote(privateConfig([]), 1, [
  { offering_key: 'softboard', mode: 'during_course', quantity: 1 },
]);
assert.equal(denied.ok, false);
assert.equal(denied.body.reason, 'invalid_course_equipment');

const writes = fs.readFileSync(require.resolve('./lib/sunset-schedule-booking-writes'), 'utf8');
assert(writes.includes('loadPrivateLessonFromDb(pg, clientSlug, locationId)'),
  'create must load the exact location-scoped private course entity with the real function signature');
console.log('verify:sunset-private-course-equipment-authority — PASS');
