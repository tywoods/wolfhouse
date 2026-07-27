'use strict';

/** Focused regression: async Sunset Admin DB rental identity keeps duration. */

const assert = require('assert');
const { resolveSunsetPriceIdentity } = require('./lib/sunset-admin-price-identity');
const { resolveActiveSunsetAdminPrice } = require('./lib/sunset-admin-price-resolve');

process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

let pass = 0;
function check(label, condition, detail) {
  assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`);
  pass += 1;
  console.log(`  PASS  ${label}`);
}

const prices = {
  board_and_suit_rental__1_day: 2000,
  board_and_suit_rental__2_days: 3900,
  board_and_suit_rental__3_days: 5800,
  board_and_suit_rental__4_days: 7700,
  board_and_suit_rental__5_days: 9600,
  board_and_suit_rental__6_days: 11500,
  board_and_suit_rental__7_days: 13400,
  board_and_suit_rental__half_day: 1500,
  board_and_suit_rental__1_hour: 800,
};

async function quote(tierKey, quantity = 1, offeringId = `board_and_suit_rental__${tierKey}`) {
  return resolveActiveSunsetAdminPrice(null, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    quantity,
    metadata: {
      component: 'rental',
      staff_ui_service_type: 'rental',
      tier_key: tierKey,
      offering_id: offeringId,
      location_id: 'sunset-somo',
    },
    async loadRule(params) {
      const amount = prices[params.itemCode];
      return amount == null ? { status: 'not_found' } : {
        status: 'found', id: `price-${params.itemCode}`, amount_cents: amount,
        currency: 'EUR', location_id: params.locationId,
      };
    },
  });
}

async function main() {
  console.log('\nverify:sunset-admin-rental-duration-identity-hotfix\n');

  const provenInput = {
    component: 'rental',
    staff_ui_service_type: 'rental',
    tier_key: '6_days',
    offering_id: 'board_and_suit_rental__6_days',
    location_id: 'sunset-somo',
  };
  const snapshot = JSON.stringify(provenInput);
  const identity = resolveSunsetPriceIdentity(provenInput);
  check('proven six-day payload resolves six-day identity',
    identity && identity.item_code === 'board_and_suit_rental__6_days', JSON.stringify(identity));
  check('identity resolver does not mutate caller payload', JSON.stringify(provenInput) === snapshot);

  const sixDay = await quote('6_days');
  check('async Admin DB boundary returns six-day 11500',
    sixDay.ok && sixDay.unit_amount_cents === 11500 && sixDay.amount_cents === 11500,
    JSON.stringify(sixDay));
  const quantityTwo = await quote('6_days', 2);
  check('async Admin DB boundary quantity 2 returns 23000',
    quantityTwo.ok && quantityTwo.amount_cents === 23000, JSON.stringify(quantityTwo));
  const oneDay = await quote('1_day');
  check('one-day remains 2000', oneDay.ok && oneDay.amount_cents === 2000, JSON.stringify(oneDay));

  for (const duration of ['2_days', '3_days', '4_days', '5_days', '6_days', '7_days', 'half_day', '1_hour']) {
    const result = await quote(duration);
    check(`${duration} identity and amount preserved`,
      result.ok && result.item_code === `board_and_suit_rental__${duration}`
        && result.amount_cents === prices[`board_and_suit_rental__${duration}`],
      JSON.stringify(result));
  }

  const conflict = await quote('6_days', 1, 'board_and_suit_rental__1_day');
  check('compound offering versus explicit tier conflict fails closed',
    conflict.ok === false && conflict.reason === 'unresolved_offering_identity', JSON.stringify(conflict));

  console.log(`\nPASS: ${pass} assertions`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
