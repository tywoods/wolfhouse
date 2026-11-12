'use strict';

/**
 * Double is Private. Private supplement: per booking (default, €10 × nights)
 * or per person (€10 × guests × nights). 3 guests × 5 nights: €50 vs €150.
 */
const assert = require('node:assert/strict');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const { applyOverlayPricesToConfig, buildAdminPricingView } = require('./lib/wolfhouse-pricing-resolve');
const { validatePriceRuleBody } = require('./lib/wolfhouse-pricing-writes');

function baseConfig() {
  return {
    client_slug: 'wolfhouse-somo',
    currency: 'EUR',
    payment_options: { deposit: true, full: true },
    seasons: [{
      code: 'august', label: 'August', bookable: true, active: true, priority: 10,
      ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }],
    }],
    packages: [{
      code: 'malibu',
      name: 'Malibu',
      default_nights: 6,
      min_days: 1,
      seasonal_prices: { august: { weekly_per_person_cents: 60000, per_night_cents: 11000 } },
    }],
    room_supplements: {
      shared: { per_person_per_night_cents: 0 },
      double: { per_room_per_night_cents: 1000, per_person_per_night_cents: 0 },
      private: { per_room_per_night_cents: 1000, per_person_per_night_cents: 0 },
    },
  };
}

function quote(config, extra) {
  return calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-08-02',
    check_out: '2026-08-07',
    guest_count: 3,
    package_code: 'malibu',
    room_type: 'private',
    payment_choice: 'deposit',
    ...(extra || {}),
  }, config);
}

function supplementCents(result) {
  const line = (result.line_items || []).find((li) => li.code === 'room_supplement');
  return line ? line.total_cents : 0;
}

const cfg = baseConfig();
const booking = quote(cfg);
assert.equal(booking.success, true, JSON.stringify(booking.blockers || booking));
assert.equal(booking.nights, 5);
assert.equal(booking.guest_count, 3);
assert.equal(supplementCents(booking), 5000, `default per booking 3g×5n want €50 got ${supplementCents(booking)}`);

const asDouble = quote(cfg, { room_type: 'double' });
assert.equal(asDouble.success, true, JSON.stringify(asDouble.blockers || asDouble));
assert.equal(supplementCents(asDouble), 5000, 'double must use Private supplement, not €0');

const onlyDouble = baseConfig();
delete onlyDouble.room_supplements.private;
const viaDoubleRow = quote(onlyDouble);
assert.equal(viaDoubleRow.success, true, JSON.stringify(viaDoubleRow.blockers || viaDoubleRow));
assert.equal(supplementCents(viaDoubleRow), 5000, 'missing Private falls back to Double row');

const perPersonCfg = baseConfig();
perPersonCfg.room_supplements.private = { per_person_per_night_cents: 1000, per_room_per_night_cents: 0 };
const perPerson = quote(perPersonCfg);
assert.equal(perPerson.success, true, JSON.stringify(perPerson.blockers || perPerson));
assert.equal(supplementCents(perPerson), 15000, `per person 3g×5n want €150 got ${supplementCents(perPerson)}`);

const overlaidPerson = applyOverlayPricesToConfig(baseConfig(), [{
  item_type: 'supplement', item_code: 'private', unit: 'per_person_per_night',
  amount_cents: 1000, active: true,
}]);
assert.equal(overlaidPerson.room_supplements.private.per_person_per_night_cents, 1000);
assert.equal(Number(overlaidPerson.room_supplements.private.per_room_per_night_cents) || 0, 0);
assert.equal(supplementCents(quote(overlaidPerson)), 15000, 'Staff per-person save quotes €150');

const overlaidBooking = applyOverlayPricesToConfig(baseConfig(), [{
  item_type: 'supplement', item_code: 'private', unit: 'per_room_per_night',
  amount_cents: 1000, active: true,
}]);
assert.equal(supplementCents(quote(overlaidBooking)), 5000, 'Staff per-booking save quotes €50');

const doubleRuleOntoPrivate = applyOverlayPricesToConfig(baseConfig(), [{
  item_type: 'supplement', item_code: 'double', unit: 'per_room_per_night',
  amount_cents: 1000, active: true,
}]);
assert.equal(supplementCents(quote(doubleRuleOntoPrivate)), 5000, 'DB Double rule prices Private');

const view = buildAdminPricingView({
  config: baseConfig(),
  dbItems: [
    { item_type: 'supplement', item_code: 'double', label: 'Double', active: true },
    { item_type: 'supplement', item_code: 'private', label: 'Private', active: true },
  ],
  dbRules: [
    { item_type: 'supplement', item_code: 'double', unit: 'per_room_per_night', amount_cents: 1000, active: true, source: 'db' },
    { item_type: 'supplement', item_code: 'private', unit: 'per_room_per_night', amount_cents: 1000, active: true, source: 'db' },
  ],
  dbSeasons: [],
  dbSeasonRanges: [],
});
const suppCodes = ((view.extras && view.extras.supplements) || []).map((r) => r.code);
assert.ok(!suppCodes.includes('double'), `Double card must not appear, got ${suppCodes.join(',')}`);
assert.ok(suppCodes.includes('private'), 'Private card remains');

const mapped = validatePriceRuleBody({
  item_type: 'supplement', item_code: 'double', unit: 'per_room_per_night', amount_eur: 10,
});
assert.equal(mapped.ok, true, mapped.error);
assert.equal(mapped.value.item_code, 'private');

console.log('PASS Double→Private; 3g×5n €50 per booking / €150 per person');
