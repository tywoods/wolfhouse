'use strict';
/**
 * Luna package quote copy from Staff Includes (Ty 16:36–16:43).
 * Under / at / over default_nights with one full-stay-only line.
 * No price math — Lookout already owns rounding.
 */
const assert = require('node:assert/strict');
const { computePackagePricePreview } = require('./lib/booking-guests');
const { packageQuoteCopy } = require('./lib/luna-package-includes-copy');

const pkg = {
  code: 'uluwatu',
  name: 'Uluwatu',
  default_nights: 6,
  includes: [
    { text: 'a bed in a mixed shared room', full_stay_only: false },
    { text: 'Wolf-House T-shirt', full_stay_only: true },
    { text: 'Free Santander airport shuttle', full_stay_only: true },
    { text: 'surfboard and wetsuit rental for six days', full_stay_only: false },
  ],
};

function texts(nights) {
  return packageQuoteCopy(pkg, nights, 'shared').package_includes.map((row) => row.text);
}

function line(nights) {
  return packageQuoteCopy(pkg, nights, 'shared').includes_line;
}

const under = texts(3);
assert.deepEqual(under, [
  'a bed in a mixed shared room',
  'surfboard and wetsuit rental for 3 days',
]);
assert.equal(under.some((t) => /t-shirt|shuttle/i.test(t)), false, '3n must omit full-stay-only lines');
assert.match(line(3), /surfboard and wetsuit rental for 3 days/i);
assert.doesNotMatch(line(3), /full package|missing|would include|if you stayed/i);
assert.doesNotMatch(line(3), /dorm/i);
console.log('PASS under default nights: only non-full-stay includes, gear = 3 days, no dorm');

const at = texts(6);
assert.deepEqual(at, [
  'a bed in a mixed shared room',
  'Wolf-House T-shirt',
  'Free Santander airport shuttle',
  'surfboard and wetsuit rental for 6 days',
]);
assert.match(line(6), /Free Santander airport shuttle/);
assert.match(line(6), /Wolf-House T-shirt/);
assert.doesNotMatch(line(6), /dorm/i);
console.log('PASS at default nights: all includes including shuttle and T-shirt');

const over = texts(9);
assert.equal(over.includes('Wolf-House T-shirt'), true);
assert.equal(over.includes('Free Santander airport shuttle'), true);
assert.equal(over.some((t) => /surfboard and wetsuit rental for 9 days/i.test(t)), true);
assert.equal(over.some((t) => /for six days|for 6 days/i.test(t)), false);
assert.doesNotMatch(line(9), /dorm/i);
console.log('PASS over default nights: all includes, gear = 9 days not six');

const coded = packageQuoteCopy({
  code: 'malibu',
  inclusions: ['shared_room', 'shirt'],
}, 7, 'shared');
assert.equal(coded.includes_line, 'Includes: 7 nights in a shared room, T-shirt');
assert.doesNotMatch(coded.includes_line, /dorm/i);
console.log('PASS coded fallback says shared room, never dorm');

const previewCfg = {
  client_slug: 'wolfhouse-somo',
  currency: 'EUR',
  payment_options: { deposit: true, full: true },
  seasons: [{
    code: 'june', label: 'June', bookable: true, active: true, priority: 10,
    ranges: [{ start_month: 6, start_day: 1, end_month: 6, end_day: 30 }],
  }],
  packages: [{
    code: 'uluwatu',
    name: 'Uluwatu',
    default_nights: 6,
    min_days: 1,
    includes: pkg.includes,
    inclusions: ['shared_room', 'shirt', 'surfboard_6_days', 'wetsuit_6_days'],
    seasonal_prices: {
      june: { weekly_per_person_cents: 60000, per_night_cents: 11000 },
    },
  }],
  deposits: { tiers: { standard_package: { amount_cents: 20000 }, custom_or_short_stay: { amount_cents: 10000 } } },
};

function preview(nights) {
  const check_out = `2027-06-${String(7 + nights).padStart(2, '0')}`;
  return computePackagePricePreview({
    client_slug: 'wolfhouse-somo',
    check_in: '2027-06-07',
    check_out,
    guest_count: 1,
    package_code: 'uluwatu',
    room_type: 'shared',
  }, previewCfg);
}

const three = preview(3);
assert.equal(three.success, true, JSON.stringify(three.blockers || three.packages));
assert.match(three.packages.uluwatu.includes_line, /surfboard and wetsuit rental for 3 days/i);
assert.doesNotMatch(three.packages.uluwatu.includes_line, /T-shirt|shuttle|dorm/i);
assert.deepEqual(
  (three.packages.uluwatu.package_includes || []).map((row) => row.text),
  under,
);
console.log('PASS preview 3n reads full_stay_only and does not list T-shirt/shuttle');

const nine = preview(9);
assert.match(nine.packages.uluwatu.includes_line, /Free Santander airport shuttle/);
assert.match(nine.packages.uluwatu.includes_line, /for 9 days/i);
assert.doesNotMatch(nine.packages.uluwatu.includes_line, /for six days|dorm/i);
console.log('PASS preview 9n lists shuttle and 9-day gear');

const cleared = packageQuoteCopy({
  code: 'malibu',
  includes: [],
  inclusions: ['shared_room', 'shirt'],
}, 3, 'shared');
assert.equal(cleared.includes_line, null);
assert.deepEqual(cleared.package_includes, []);
assert.equal(String(cleared.includes_line || '').includes('T-shirt'), false);
assert.doesNotMatch(String(cleared.includes_line || ''), /shared room/i);
console.log('PASS empty Staff Includes does not revive coded T-shirt/shared-room');

const dormStaff = packageQuoteCopy({
  code: 'malibu',
  default_nights: 6,
  includes: [
    { text: 'a dorm bed', full_stay_only: false },
    { text: 'Nine nights in a shared dorm bed', full_stay_only: false },
  ],
}, 6, 'shared');
assert.deepEqual(dormStaff.package_includes.map((row) => row.text), [
  'a shared room',
  'Nine nights in a shared room',
]);
assert.doesNotMatch(dormStaff.includes_line, /dorm/i);
assert.match(dormStaff.includes_line, /shared room/);
console.log('PASS Staff dorm bed copy becomes shared room');

