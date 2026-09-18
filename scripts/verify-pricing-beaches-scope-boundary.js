'use strict';

/**
 * PRICING-BEACHES-P1-SCOPE-001
 *
 * Fail-closed tenant + property scope contract for Sunset pricing/catalog reads.
 * Pure/offline: no DB, network, Stripe, booking writes, or guest sends.
 */

const assert = require('node:assert/strict');
const {
  executeSunsetCatalogToolAsync,
  resolveSunsetBotBodyLocation,
} = require('./lib/sunset-catalog-tool-executor');

const TOOL = 'get_sunset_rental_price';
const BASE_ARGS = { item: 'board+suit bundle', duration: 'half day' };

function makeLoadRuleSpy() {
  const calls = [];
  const loadRule = async (input) => {
    calls.push(input);
    return {
      status: 'found',
      amount_cents: 2000,
      currency: 'EUR',
      location_id: input.locationId,
      item_type: 'rental',
      item_code: 'board_and_suit_rental__half_day',
      unit: 'session',
    };
  };
  loadRule.calls = calls;
  return loadRule;
}

async function execute(overrides = {}) {
  const loadRule = makeLoadRuleSpy();
  const result = await executeSunsetCatalogToolAsync(TOOL, {
    client_slug: 'sunset',
    args: BASE_ARGS,
    ...overrides,
    loadRule,
  });
  return { result, loadRule };
}

async function main() {
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  const missingTenant = await execute({ client_slug: '' });
  assert.equal(missingTenant.result.ok, false);
  assert.equal(missingTenant.result.reason, 'invalid_tenant');
  assert.equal(missingTenant.loadRule.calls.length, 0);

  const foreignTenant = await execute({ client_slug: 'wolfhouse-somo', location_id: 'sunset-somo' });
  assert.equal(foreignTenant.result.ok, false);
  assert.equal(foreignTenant.result.reason, 'invalid_tenant');
  assert.equal(foreignTenant.loadRule.calls.length, 0);

  const missingProperty = await execute();
  assert.equal(missingProperty.result.ok, false);
  assert.equal(missingProperty.result.reason, 'unknown_location');
  assert.equal(missingProperty.loadRule.calls.length, 0);
  assert.equal(missingProperty.result.location_id, undefined);

  const unknownProperty = await execute({ location_id: 'sunset-unknown' });
  assert.equal(unknownProperty.result.ok, false);
  assert.equal(unknownProperty.result.reason, 'unknown_location');
  assert.equal(unknownProperty.loadRule.calls.length, 0);

  const validProperty = await execute({ location_id: 'sunset-somo' });
  assert.equal(validProperty.result.ok, true);
  assert.equal(validProperty.result.location_id, 'sunset-somo');
  assert.equal(validProperty.loadRule.calls.length, 1);
  assert.equal(validProperty.loadRule.calls[0].locationId, 'sunset-somo');

  const missingHttpProperty = resolveSunsetBotBodyLocation({ item: 'board' });
  assert.deepEqual(missingHttpProperty, {
    ok: false,
    location_id: null,
    raw: null,
    reason: 'unknown_location',
  });

  const validHttpProperty = resolveSunsetBotBodyLocation({ location_id: 'sunset-sardinero' });
  assert.equal(validHttpProperty.ok, true);
  assert.equal(validHttpProperty.location_id, 'sunset-sardinero');

  console.log('verify-pricing-beaches-scope-boundary — PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
