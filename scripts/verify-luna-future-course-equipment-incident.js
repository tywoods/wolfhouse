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

// Quote path uses the canonical one-day identity; the catalog assertions above
// retain the incident's legacy single_class identity.
const quoteCfg = JSON.parse(JSON.stringify(cfg));
quoteCfg.surf_packs[0].price_tiers[0].key = '1_day';
quoteCfg.prices[0].offering_key = `surf_pack_${COURSE}__1_day`;
quoteCfg.prices[0].item_code = quoteCfg.prices[0].offering_key;
quoteCfg.prices[0].unit = 'day';
const quoteItem = quoteCfg.prices[0].item_code;
const quoteInput = {
  service_dates: ['2026-09-01'],
  components: { course: { course_id: COURSE, tier_key: '1_day', offering_id: quoteItem, quantity: 1 } },
  course_equipment: { mode: 'during_course', quantity: 1 },
};
const built = buildSunsetQuoteCommand({ channel: QUOTE_CHANNELS.LUNA_WHATSAPP,
  transportBody: quoteInput, trustedLocationId: 'sunset-somo', now: new Date('2026-07-28T12:00:00Z') });
assert.equal(built.ok, true);
const denied = executeSunsetQuoteSync(built.command, { adminCfg: quoteCfg });
assert.equal(denied.ok, false);
assert.equal(denied.body.reason, 'course_equipment_not_included',
  'Luna quote must not turn the location free policy into free gear for this exact course');
const includedQuoteCfg = JSON.parse(JSON.stringify(quoteCfg));
includedQuoteCfg.surf_packs[0].equipment_included = true;
const allowed = executeSunsetQuoteSync(built.command, { adminCfg: includedQuoteCfg });
assert.equal(allowed.ok, true, JSON.stringify(allowed.body));
assert.equal(allowed.body.total_cents, 4000);
assert.equal(allowed.body.line_items.filter((line) => line.course_equipment).length, 2);

console.log('verify:luna-future-course-equipment-incident — ALL CHECKS PASSED');
