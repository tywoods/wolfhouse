'use strict';

// PRIVATE-OPT: real calculator + Staff Pricing resolver; offline, no guest APIs.
const assert = require('node:assert/strict');
const { calculateWolfhouseQuote, loadConfig } = require('./lib/wolfhouse-quote-calculator');
const { applyAuthoritativeSeasonsToConfig, applyOverlayPricesToConfig } = require('./lib/wolfhouse-pricing-resolve');
const { resolveQuoteRoomTypeFromPreference, computeWolfhouseRoomOptionFlags, roomHasCapacity } = require('./lib/wolfhouse-room-options');

const aliases = ['private', 'double', 'couple_private', 'private_room', 'matrimonial'];
function pricing(privateCents = 1733) {
  const config = applyAuthoritativeSeasonsToConfig(loadConfig(), [{
    code: 'summer', active: true, bookable: true, priority: 0, sort_order: 1,
    ranges: [{ start_month: 7, start_day: 1, end_month: 7, end_day: 31 }],
  }]);
  // Deliberately divergent: looking up double must never produce another price.
  return applyOverlayPricesToConfig(config, [
    { item_type: 'supplement', item_code: 'private', amount_cents: privateCents,
      unit: 'per_room_per_night', active: true },
    { item_type: 'supplement', item_code: 'double', amount_cents: 9876,
      unit: 'per_room_per_night', active: true },
  ]);
}
function quote(fields = {}, config = pricing()) {
  return calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2027-07-05', check_out: '2027-07-12',
    guest_count: 2, package_code: 'malibu', payment_choice: 'deposit',
    ...fields,
  }, config);
}
let passed = 0;
let failed = 0;
function check(name, run) {
  try { run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}

check('private aliases use one canonical helper and calculator path despite divergent tariffs', () => {
  const expected = quote({ room_type: 'private' });
  assert.equal(expected.success, true, JSON.stringify(expected.blockers));
  assert.equal(expected.line_items.find(item => item.code === 'room_supplement').unit_cents, 1733);
  for (const alias of aliases) {
    assert.equal(resolveQuoteRoomTypeFromPreference(alias), 'private', `room_type ${alias}`);
    assert.equal(resolveQuoteRoomTypeFromPreference('shared', alias), 'private', `preference ${alias}`);
    assert.deepEqual(quote({ room_type: alias }), expected, `calculator room_type ${alias}`);
    assert.deepEqual(quote({ room_preference: alias }), expected, `calculator preference ${alias}`);
    assert.deepEqual(quote({ room_type: 'shared', room_preference: alias }), expected, `shared default + ${alias}`);
  }
  assert.equal(resolveQuoteRoomTypeFromPreference(' DOUBLE '), 'private');
  assert.equal(resolveQuoteRoomTypeFromPreference('shared', 'double room'), 'private');
});

check('missing or unreadable private per-room tariff fails closed without a double fallback', () => {
  const missing = pricing();
  delete missing.room_supplements.private;
  const absent = pricing();
  delete absent.room_supplements;
  const invalidConfigs = [missing, absent];
  for (const value of [undefined, null, '', 'REQUIRED_FROM_STAFF', '1733', NaN, Infinity, -1, false, {}, 1.5]) {
    const config = pricing();
    config.room_supplements.private = { per_room_per_night_cents: value, per_person_per_night_cents: 999 };
    invalidConfigs.push(config);
  }
  for (const config of invalidConfigs) {
    for (const alias of aliases) {
      const result = quote({ room_type: alias }, config);
      assert.equal(result.success, false, `${alias}: ${JSON.stringify(config.room_supplements)}`);
      assert.equal(result.missing_config, true);
      assert.equal(result.staff_review_required, true);
      assert.equal(result.confidence, 'blocked');
      assert.equal(result.code, 'staff_room_supplement_price_missing');
      assert.equal(result.pricing_failure.choice.item_code, 'private');
      assert.equal(result.payment_link_amount_cents, 0);
      assert.deepEqual(result.line_items, []);
    }
    assert.equal(quote({ room_type: 'shared' }, config).success, true, 'shared does not need private pricing');
  }
});

check('explicit zero private tariff is accepted without a stale per-person or double charge', () => {
  const config = pricing(0);
  config.room_supplements.private.per_person_per_night_cents = 999;
  const shared = quote({ room_type: 'shared' }, config);
  for (const alias of aliases) {
    const result = quote({ room_type: alias }, config);
    assert.equal(result.success, true);
    assert.equal(result.total_cents, shared.total_cents);
    assert.equal(result.deposit_required_cents, shared.deposit_required_cents);
    assert.equal(result.room_type, 'private');
    const lines = result.line_items.filter(item => item.code === 'room_supplement');
    assert.equal(lines.length, 1, 'retain explicit free private sale in quote lines');
    assert.equal(lines[0].unit_cents, 0);
    assert.equal(lines[0].total_cents, 0);
  }
});

// Preservation checks: these existing behaviors need no production changes.
check('only real guests receive base prices, extras, deposits and one flat room charge', () => {
  for (const nights of [3, 7]) {
    for (const guests of [1, 2, 4]) {
      for (const tariff of [1733, 2841]) {
        const config = pricing(tariff);
        const fields = {
          check_out: nights === 3 ? '2027-07-08' : '2027-07-12',
          guest_count: guests, package_code: nights === 3 ? 'package_none' : 'malibu',
          uses_per_guest_deposits: true,
          add_ons: [{ code: 'wetsuit_rental', days: 2, quantity: guests }],
        };
        const shared = quote({ ...fields, room_type: 'shared' }, config);
        const privateQuote = quote({ ...fields, room_type: 'private', room_code: 'R1', room_capacity: 6 }, config);
        assert.equal(shared.success, true, JSON.stringify(shared.blockers));
        assert.equal(privateQuote.success, true, JSON.stringify(privateQuote.blockers));
        assert.equal(shared.line_items[0].total_cents, (nights === 7 ? 29900 : 4500 * nights) * guests);
        assert.equal(privateQuote.guest_count, guests);
        assert.equal(privateQuote.total_cents - shared.total_cents, tariff * nights);
        assert.deepEqual(privateQuote.line_items.filter(item => item.code !== 'room_supplement'), shared.line_items);
        const supplement = privateQuote.line_items.filter(item => item.code === 'room_supplement');
        assert.equal(supplement.length, 1);
        assert.equal(supplement[0].total_cents, tariff * nights);
        assert.equal(supplement[0].guest_count, guests);
        assert.deepEqual(privateQuote.per_guest_deposits, shared.per_guest_deposits);
        assert.equal(privateQuote.payment_link_amount_cents, shared.payment_link_amount_cents);
        assert.equal(privateQuote.per_person.length, guests, 'no invoice rows for empty beds');
        assert.equal(privateQuote.per_person.reduce((sum, row) => sum + row.subtotal_cents, 0), privateQuote.total_cents);
        assert.equal(privateQuote.per_person.reduce((sum, row) => sum + row.supplement_cents, 0), tariff * nights);
        assert.deepEqual(quote({ ...fields, room_type: 'double', room_code: 'R6' }, config), privateQuote);
      }
    }
  }
});

check('mixed real-guest packages preserve their existing deposit and extras distribution', () => {
  const fields = { guest_count: 3, uses_per_guest_deposits: true,
    guest_packages: [{ package_code: 'malibu' }, { package_code: 'uluwatu' }, { package_code: 'package_none' }],
    add_ons: [{ code: 'wetsuit_rental', days: 2, quantity: 1 }],
  };
  const shared = quote({ ...fields, room_type: 'shared' });
  const result = quote({ ...fields, room_preference: 'double' });
  assert.equal(result.success, true, JSON.stringify(result.blockers));
  assert.equal(result.total_cents - shared.total_cents, 1733 * 7);
  assert.deepEqual(result.per_guest_deposits, shared.per_guest_deposits);
  assert.equal(result.per_person.length, 3);
  for (let i = 0; i < 3; i++) {
    for (const key of ['accommodation_cents', 'addons_cents', 'deposit_cents']) {
      assert.equal(result.per_person[i][key], shared.per_person[i][key]);
    }
  }
});

check('shared preferences, ordinary private-optional inventory and dedicated capacity stay intact', () => {
  const shared = quote({ room_type: 'shared' });
  for (const preference of [undefined, 'shared', 'girls', 'mixed']) {
    assert.equal(resolveQuoteRoomTypeFromPreference(undefined, preference), 'shared');
    assert.deepEqual(quote({ room_preference: preference }), shared);
  }
  const ordinary = Array.from({ length: 6 }, (_, i) => ({
    bed_code: `R1-B${i + 1}`, room_code: 'R1', room_type: 'mixed', selling_mode: 'private_optional',
  }));
  for (const guests of [1, 2, 4, 6]) {
    assert.equal(computeWolfhouseRoomOptionFlags(ordinary, guests, ordinary).private_room_available, true);
  }
  assert.equal(computeWolfhouseRoomOptionFlags(ordinary, 7, ordinary).private_room_available, false);
  assert.equal(computeWolfhouseRoomOptionFlags(ordinary.slice(1), 2, ordinary).private_room_available, false);
  assert.equal(computeWolfhouseRoomOptionFlags(ordinary, 2, ordinary, [{ room_code: 'R1' }]).private_room_available, false);
  const dedicated = [{ bed_code: 'R6-B1', room_code: 'R6', room_type: 'matrimonial_private_couple' }];
  assert.equal(roomHasCapacity(dedicated, ['R6'], 2), true, 'one actual double bed fits two');
  assert.equal(roomHasCapacity(dedicated, ['R6'], 3), false, 'synonyms do not expand capacity');
  assert.equal(computeWolfhouseRoomOptionFlags(dedicated, 2, dedicated).private_room_available, true);
});

console.log(`PRIVATE-OPT pricing: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
