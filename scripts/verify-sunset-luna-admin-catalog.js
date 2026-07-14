'use strict';

const assert = require('assert');
const {
  buildSunsetLunaCatalogFromConfig,
  quoteSunsetOfferingFromCatalog,
} = require('./lib/sunset-luna-admin-catalog');
const { quoteSunsetGroupLessonsFromPrices } = require('./lib/sunset-group-lesson-quote');

const midDayPack = '22222222-2222-4222-8222-222222222222';
const morningPack = '33333333-3333-4333-8333-333333333333';
const fixture = {
  ok: true, source: 'db', currency: 'EUR',
  lesson_times: [{
    slot_id: '11111111-1111-4111-8111-111111111111', slot_time: '09:30-11:30',
    offering_label: 'Group lesson', age_band: 'all_ages', active: true,
  }],
  surf_packs: [
    { pack_id: midDayPack, label: 'Mid-day course', active: true, age_band: '12_and_up', schedules: ['1215_1415'], price_tiers: [{ key: '1_week', label: 'One week', hours: 10 }] },
    { pack_id: morningPack, label: 'Morning course', active: true, schedules: ['0930_1130'], price_tiers: [{ key: '1_day', label: 'One day', hours: 2 }] },
    { pack_id: 'unpriced-pack', label: 'Unpriced course', active: true, schedules: ['0930_1130'], price_tiers: [{ key: '1_week', label: 'One week' }] },
    { pack_id: 'inactive-pack', label: 'Inactive course', active: false, schedules: ['1215_1415'], price_tiers: [{ key: '1_week', label: 'One week' }] },
  ],
  prices: [
    { id: 'generic-lesson', category: 'lesson', offering_key: 'group_lesson_adult__single_lesson', amount: 30, unit: 'session', active: true, currency: 'EUR' },
    { id: 'slot-price', category: 'lesson', offering_key: 'lesson_slot_11111111-1111-4111-8111-111111111111__session', amount: 32, unit: 'session', active: true, currency: 'EUR' },
    { id: 'midday-price', category: 'package', offering_key: `surf_pack_${midDayPack}__1_week`, amount_cents: 18500, unit: 'week', active: true, currency: 'EUR' },
    { id: 'morning-price', category: 'package', offering_key: `surf_pack_${morningPack}__1_day`, amount: 6500, unit: 'course', active: true, currency: 'EUR' },
    { id: 'inactive-price', category: 'package', offering_key: 'surf_pack_inactive-pack__1_week', amount: 9999, unit: 'week', active: false, currency: 'EUR' },
    { id: 'future-price', category: 'rental', offering_key: 'future-rental', amount: 10, unit: 'day', active: true, effective_from: '2099-01-01' },
    { id: 'expired-price', category: 'rental', offering_key: 'expired-rental', amount: 10, unit: 'day', active: true, effective_to: '2000-01-01' },
    { id: 'ambiguous-a', category: 'rental', offering_key: 'ambiguous-rental', amount: 10, unit: 'day', active: true },
    { id: 'ambiguous-b', category: 'rental', offering_key: 'ambiguous-rental', amount: 11, unit: 'day', active: true },
  ],
};

console.log('\n── RED: generic group quote cannot identify a course ──');
const generic = quoteSunsetGroupLessonsFromPrices({
  locationId: 'sunset-somo', body: { service_dates: ['2027-06-10'], quantity: 1 },
  prices: fixture.prices, refDate: new Date('2026-01-01'),
});
assert.strictEqual(generic.ok, true);
assert.notStrictEqual(generic.unit_amount_cents, fixture.prices.find((p) => p.id === 'midday-price').amount_cents);
console.log('  PASS generic lesson amount differs from mid-day course amount');

console.log('\n── GREEN: Admin catalog preserves exact course identity ──');
const catalog = buildSunsetLunaCatalogFromConfig(fixture, { locationId: 'sunset-somo', asOfDate: '2027-01-01', requireDb: true });
assert.strictEqual(catalog.ok, true);
const middayItem = `surf_pack_${midDayPack}__1_week`;
const midday = catalog.offerings.filter((o) => o.offering_id === middayItem || o.price_id === 'midday-price');
assert.strictEqual(midday.length, 1);
assert.strictEqual(midday[0].offering_id, middayItem);
assert.strictEqual(midday[0].schedule.start_time, '12:15');
assert.strictEqual(midday[0].schedule.end_time, '14:15');
assert.strictEqual(midday[0].price.amount_cents, fixture.prices.find((p) => p.id === 'midday-price').amount_cents);
assert.strictEqual(midday[0].unit_amount_cents, fixture.prices.find((p) => p.id === 'midday-price').amount_cents);
assert.strictEqual(midday[0].course_id, midDayPack);
assert.strictEqual(midday[0].price.price_id, 'midday-price');
assert(!catalog.offerings.some((o) => o.course_id === 'inactive-pack'));
console.log('  PASS mid-day course appears once at fixture amount');

const quote = quoteSunsetOfferingFromCatalog(fixture, {
  location_id: 'sunset-somo',
  offering_id: middayItem,
  course_id: midDayPack,
  quantity: 2,
  require_db: true,
  as_of_date: '2027-01-01',
});
assert.strictEqual(quote.ok, true);
assert.strictEqual(quote.total_cents, fixture.prices.find((p) => p.id === 'midday-price').amount_cents * 2);
console.log('  PASS course quote uses exact pack price, not generic lesson');

console.log('\n── Fail closed ──');
for (const [body, reason] of [
  [{ location_id: 'wolfhouse-somo', offering_id: middayItem }, 'wrong_location'],
  [{ location_id: 'sunset-somo', offering_id: 'missing' }, 'unknown_offering'],
  [{ location_id: 'sunset-somo', offering_id: 'surf_pack_unpriced-pack__1_week' }, 'price_missing'],
  [{ location_id: 'sunset-somo', offering_id: 'ambiguous-rental' }, 'ambiguous_price'],
  [{ location_id: 'sunset-somo', offering_id: 'inactive-price' }, 'inactive_offering'],
  [{ location_id: 'sunset-somo', offering_id: middayItem, as_of_date: '2027-01-01' }, 'course_identity_missing'],
  [{ location_id: 'sunset-somo', offering_id: middayItem, course_id: 'wrong', as_of_date: '2027-01-01' }, 'mismatched_course_offering'],
  [{ location_id: 'sunset-somo', offering_id: 'slot-price', quantity: 1, require_db: true, as_of_date: '2027-01-01' }, 'unknown_offering'],
  [{ location_id: 'sunset-somo', offering_id: 'future-price', as_of_date: '2027-01-01' }, 'future_price'],
  [{ location_id: 'sunset-somo', offering_id: 'expired-price', as_of_date: '2027-01-01' }, 'expired_price'],
]) {
  const result = quoteSunsetOfferingFromCatalog(fixture, body);
  assert.strictEqual(result.reason, reason, JSON.stringify({ body, result }));
  console.log(`  PASS ${reason}`);
}
assert.strictEqual(buildSunsetLunaCatalogFromConfig({ ...fixture, source: 'config' }, { locationId: 'sunset-somo', requireDb: true }).reason, 'admin_db_expected_unavailable');
console.log('  PASS admin_db_expected_unavailable');
console.log('verify:sunset-luna-admin-catalog — ALL CHECKS PASSED');
