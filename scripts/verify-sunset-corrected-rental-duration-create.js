'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const rental = require('./browser/sunset-schedule-rental-availability');
const ROOT = path.join(__dirname, '..');
const durations = ['1_hour', '2_hours', 'half_day', 'full_day'];
const prices = durations.map((d, i) => ({
  category: 'rental', offering_key: `board_and_suit_rental__${d}`,
  unit: d.includes('hour') ? 'hour' : 'day', amount_cents: 1000 + i, active: true,
  location_id: 'sunset-somo',
}));
assert.deepStrictEqual(rental.scheduleActiveShortDurationKeysForOffering(prices, 'board_and_suit_rental', 'sunset-somo'), durations);
assert.deepStrictEqual(rental.scheduleActiveShortDurationKeysForOffering(prices.slice(0, 2), 'board_and_suit_rental', 'sunset-somo'), durations.slice(0, 2));
assert.deepStrictEqual(rental.scheduleActiveShortDurationKeysForOffering(prices, 'board_and_suit_rental', 'other-location'), []);
assert.strictEqual(rental.scheduleIsShortRentalDurationKey('1_day'), false);
assert.strictEqual(rental.scheduleShortRentalDurationLabelKey('full_day'), 'schedule.create.rentalDuration.fullDay');
const admin = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
assert(admin.includes("['1_hour', '2_hours', 'half_day', 'full_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days']"));
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
assert(!api.includes('id="ps-create-activity-empty-hint"'));
assert(api.includes("offerings.filter(function(o){ return o.offering_key === 'board_and_suit_rental'; })"));
assert(api.includes('portal-schedule-create-rental-title'));
assert(api.includes('type="hidden" class="ps-create-rental-check"'));
assert(!/SHORT_RENTAL_DURATION_KEYS[^\n]*1_day/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/luna-front-desk-quote-service.js'), 'utf8')));
const i18n = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const es = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');
for (const src of [i18n, es]) assert(src.includes('schedule.create.rentalDuration.2Hours'));
console.log('PASS corrected rental durations/Create bundle contract (18 assertions)');
