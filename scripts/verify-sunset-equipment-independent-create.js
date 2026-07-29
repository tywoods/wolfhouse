'use strict';
const fs = require('fs');
const assert = require('assert');
const src = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');

assert(!/data-create-activity="ps-create-comp-no-lesson"/.test(src),
  'Equipment only must not be a visible Main activity button');
assert(/id="ps-create-equipment-catalog-label"[^>]*class="portal-schedule-create-label"[^>]*>Equipment</.test(src),
  'Equipment must have its own title using the Main activity title class');
assert(/id="ps-create-comp-no-lesson"[^>]*checked/.test(src),
  'hidden no-lesson compatibility state remains the equipment-only payload fallback');
assert(!/Group\/Private course gear is owned by #ps-create-course-equipment — hide catalog rental rows/.test(src),
  'catalog equipment must remain visible alongside Group and Private lessons');
assert(!/var checked = noLesson \? true : !!was\.checked/.test(src),
  'catalog equipment must not be selected by default');
assert(/var checked = !!was\.checked/.test(src),
  'equipment selection must derive only from explicit prior user state');
assert(!/\? '<h3 class="portal-schedule-create-label">'[^\n]+checked>/.test(src),
  'equipment-only state must not replace checkboxes with forced hidden selections');
assert(/escHtml\(offeringLabel\)/.test(src),
  'catalog-owned labels such as Towel and Test must render');
assert(/data-rental-duration-key=/.test(src),
  'each equipment row must retain its own Admin duration identity');
assert(/row\.getAttribute\('data-rental-duration-key'\)/.test(src),
  'payload serialization must read duration from the selected equipment row');

const availabilityPath = require.resolve('./browser/sunset-schedule-rental-availability');
const availability = fs.readFileSync(availabilityPath, 'utf8');
assert(!/for \(var i = 0; i < SCHEDULE_CANONICAL_RENTAL_OFFERINGS\.length; i\+\+\)/.test(availability),
  'short equipment discovery must not iterate a hardcoded canonical item list');
const { scheduleActiveShortRentalOfferings } = require(availabilityPath);
const testItems = scheduleActiveShortRentalOfferings([
  { category: 'rental', offering_key: 'towel_rental__4_hours', item_code: 'towel_rental__4_hours', unit: 'session', amount_cents: 1000, active: true, location_id: 'sunset-somo', label: 'Towel' },
  { category: 'rental', offering_key: 'test_rental__1_day', item_code: 'test_rental__1_day', unit: 'day', amount_cents: 5000, active: true, location_id: 'sunset-somo', label: 'Test' },
], 'sunset-somo');
assert.deepStrictEqual(testItems.map((x) => ({ key: x.offering_key, durations: x.duration_keys })), [
  { key: 'test_rental', durations: ['1_day'] },
  { key: 'towel_rental', durations: ['4_hours'] },
], 'live-shaped Test and Towel rows must both project on a one-day drawer');

console.log('verify:sunset-equipment-independent-create PASSED (12/12)');
