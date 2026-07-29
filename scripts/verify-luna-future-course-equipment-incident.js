'use strict';

const assert = require('assert');
const { projectSunsetBookableOfferingsFromConfig, scheduleCoursesFromBookableProjection } = require('./lib/sunset-bookable-offerings');
const { buildSunsetQuoteCommand, executeSunsetQuoteSync, QUOTE_CHANNELS } = require('./lib/luna-front-desk-quote-service');

const COURSE = 'a5aef000-0000-4000-8000-000000000000';
const ITEM = `surf_pack_${COURSE}__single_class`;
const cfg = {
  ok: true, source: 'db',
  surf_packs: [{ pack_id: COURSE, label: 'Incident course', active: true,
    equipment_included: false, group_size: 8, weekly: 'daily', schedules: ['0930_1130'],
    price_tiers: [{ key: 'single_class', label: 'Single class', hours: 2 }] }],
  prices: [{ id: 'price-incident', category: 'package', offering_key: ITEM, item_code: ITEM,
    amount_cents: 4000, unit: 'session', active: true, currency: 'EUR' }],
};

const projection = projectSunsetBookableOfferingsFromConfig(cfg, {
  locationId: 'sunset-somo', requestedDates: ['2026-09-01'], asOf: '2026-07-28',
});
assert.equal(projection.ok, true);
const offering = projection.offerings.find((row) => row.offering_id === ITEM);
assert(offering, 'exact incident offering must project');
assert.strictEqual(offering.equipment_included, false,
  'catalog offering must explicitly say that free board+wetsuit are not included');
const course = scheduleCoursesFromBookableProjection(projection).find((row) => row.course_id === COURSE);
assert(course, 'incident course must project');
assert.strictEqual(course.equipment_included, false,
  'Luna course catalog must preserve the server-owned equipment flag');

const includedCfg = JSON.parse(JSON.stringify(cfg));
includedCfg.surf_packs[0].equipment_included = true;
const includedProjection = projectSunsetBookableOfferingsFromConfig(includedCfg, {
  locationId: 'sunset-somo', requestedDates: ['2026-09-01'], asOf: '2026-07-28',
});
assert.strictEqual(includedProjection.offerings.find((row) => row.offering_id === ITEM).equipment_included, true);
assert.strictEqual(scheduleCoursesFromBookableProjection(includedProjection)[0].equipment_included, true);

// Exercise the real offering_id route used by get_sunset_offering_quote.
const quoteCfg = JSON.parse(JSON.stringify(cfg));
quoteCfg.surf_packs[0].price_tiers[0].key = '1_day';
quoteCfg.prices[0].offering_key = `surf_pack_${COURSE}__1_day`;
quoteCfg.prices[0].item_code = quoteCfg.prices[0].offering_key;
quoteCfg.prices[0].unit = 'day';
const quoteItem = quoteCfg.prices[0].item_code;
function quote(config, equipment, quantity = 2) {
  const built = buildSunsetQuoteCommand({ channel: QUOTE_CHANNELS.LUNA_WHATSAPP,
    transportBody: { offering_id: quoteItem, course_id: COURSE, quantity,
      service_dates: ['2026-09-01'], ...(equipment === undefined ? {} : { course_equipment: equipment }) },
    trustedLocationId: 'sunset-somo', now: new Date('2026-07-28T12:00:00Z') });
  assert.equal(built.ok, true);
  return executeSunsetQuoteSync(built.command, { adminCfg: config });
}
const selection = { mode: 'during_course', quantity: 2 };
const denied = quote(quoteCfg, selection);
assert.equal(denied.ok, false);
assert.equal(denied.body.reason, 'course_equipment_not_included');
const missingFlagCfg = JSON.parse(JSON.stringify(quoteCfg));
delete missingFlagCfg.surf_packs[0].equipment_included;
assert.equal(quote(missingFlagCfg, selection).body.reason, 'course_equipment_not_included');

const includedQuoteCfg = JSON.parse(JSON.stringify(quoteCfg));
includedQuoteCfg.surf_packs[0].equipment_included = true;
includedQuoteCfg.surf_packs[0].equipment_price_cents = 0;
const ordinary = quote(includedQuoteCfg, undefined);
assert.equal(ordinary.ok, true);
assert.equal(ordinary.body.line_items.length, 1, 'ordinary offering quote must not regress');
const allowed = quote(includedQuoteCfg, selection);
assert.equal(allowed.ok, true, JSON.stringify(allowed.body));
assert.equal(allowed.body.total_cents, 8000);
assert.deepStrictEqual(allowed.body.course_equipment, selection);
assert.deepStrictEqual(allowed.body.line_items.filter((line) => line.course_equipment).map((line) => line.component), ['surfboard', 'wetsuit']);
assert.deepStrictEqual(allowed.body.quote_provenance.course_equipment, selection);
assert.equal(allowed.body.quote_provenance.line_items.length, 3);
assert.match(allowed.body.quote_provenance.quote_fingerprint, /^[a-f0-9]{64}$/);
assert.notEqual(allowed.body.quote_provenance.quote_fingerprint, ordinary.body.quote_provenance.quote_fingerprint);

const allDay = quote(quoteCfg, { mode: 'all_day', quantity: 2 });
assert.equal(allDay.ok, false);
assert.equal(allDay.body.reason, 'invalid_course_equipment',
  'All Day is unavailable until the Admin toggle is enabled for that location');
assert.equal(quote(includedQuoteCfg, { mode: 'during_course', quantity: 3 }).body.reason, 'invalid_course_equipment');
const changedPriceCfg = JSON.parse(JSON.stringify(includedQuoteCfg));
changedPriceCfg.prices[0].amount_cents = 4500;
const changedPrice = quote(changedPriceCfg, selection);
assert.equal(changedPrice.body.total_cents, 9000);
assert.notEqual(changedPrice.body.quote_provenance.quote_fingerprint, allowed.body.quote_provenance.quote_fingerprint,
  'authoritative price changes must change provenance');

console.log('verify:luna-future-course-equipment-incident — ALL CHECKS PASSED');
