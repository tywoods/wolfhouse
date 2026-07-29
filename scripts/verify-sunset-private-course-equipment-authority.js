'use strict';
const assert = require('assert');
const fs = require('fs');
const { projectSunsetBookableOfferingsFromConfig } = require('./lib/sunset-bookable-offerings');
const { buildSunsetQuoteCommand, executeSunsetQuoteSync, QUOTE_CHANNELS } = require('./lib/luna-front-desk-quote-service');

function privateConfig(equipmentIncluded, equipmentPriceCents) {
  return {
    ok: true, source: 'db', surf_packs: [], prices: [],
    private_lesson: {
      id: 'private-somo', enabled: true, label: 'Private lesson', amount_cents: 6000,
      currency: 'EUR', price_basis: 'per_session', default_duration_minutes: 120,
      equipment_included: equipmentIncluded, equipment_price_cents: equipmentPriceCents,
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
    transportBody: { offering_id: offering.offering_id, quantity, service_dates: ['2026-09-01'], course_equipment: equipment },
    trustedLocationId: 'sunset-somo', now: new Date('2026-07-29T12:00:00Z'),
  });
  assert.equal(built.ok, true);
  return executeSunsetQuoteSync(built.command, { adminCfg: cfg });
}
const paid = quote(privateConfig(true, 900), 2, { mode: 'during_course', quantity: 2 });
assert.equal(paid.ok, true, JSON.stringify(paid.body));
assert.equal(paid.body.total_cents, 13800, JSON.stringify(paid.body));
assert.equal(paid.body.line_items.filter((line) => line.course_equipment).length, 2);
const free = quote(privateConfig(true, 0), 2, { mode: 'during_course', quantity: 2 });
assert.equal(free.ok, true, JSON.stringify(free.body));
assert.equal(free.body.total_cents, 12000, 'zero equipment price is valid');
const denied = quote(privateConfig(false, 900), 1, { mode: 'during_course', quantity: 1 });
assert.equal(denied.ok, false);
assert.equal(denied.body.reason, 'course_equipment_not_included');
const writes = fs.readFileSync(require.resolve('./lib/sunset-schedule-booking-writes'), 'utf8');
assert(writes.includes('loadPrivateLessonFromDb(pg, clientSlug, locationId)'),
  'create must load the exact location-scoped private course entity with the real function signature');
console.log('verify:sunset-private-course-equipment-authority — PASS');
