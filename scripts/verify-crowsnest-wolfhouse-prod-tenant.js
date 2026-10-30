#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildTenantRequest, normalizeTenant, resolveTenantRuntime } = require('./lib/crowsnest/crowsnest-live-simulator');

const phone = '+346' + '997770001';
const config = {
  CROWSNEST_LIVE_SIM_WOLFHOUSE_PROD_ORIGIN: 'https://prod-simulator.invalid',
  CROWSNEST_LIVE_SIM_WOLFHOUSE_PROD_TOKEN: 'unit-test-token',
};
assert.strictEqual(normalizeTenant('wolfhouse_prod'), 'wolfhouse-prod');
assert.strictEqual(normalizeTenant('wolfhouse-production'), 'wolfhouse-prod');
const runtime = resolveTenantRuntime('wolfhouse-prod', {});
assert.strictEqual(runtime.requireExplicitConfig, true);
assert.strictEqual(runtime.origin_allowed, false);
assert.strictEqual(buildTenantRequest({ tenantId: 'wolfhouse-prod', fromPhone: phone, text: 'test' }, {}).code, 'runtime_not_safely_scoped');
const built = buildTenantRequest({ tenantId: 'wolfhouse-prod', fromPhone: phone, text: 'test' }, config);
assert.strictEqual(built.ok, true);
assert.strictEqual(built.runtime.label, 'Wolfhouse Prod');
assert.deepStrictEqual(built.payload, {
  thread: phone,
  guest_phone: phone,
  text: 'test',
  message_text: 'test',
  allow_writes: false,
  dry_run: true,
  whatsapp_suppressed: true,
  test: true,
  tags: ['test'],
  metadata: { test: true, source: 'crowsnest_live_simulator' },
});

// Regression: non-production TEST requests must remain byte-for-byte identical
// to the payload contract on master (including key order and no prod flags).
const masterPayload = (guestPhone, text) => JSON.stringify({
  thread: guestPhone,
  guest_phone: guestPhone,
  text,
  message_text: text,
  allow_writes: false,
});
const nonProdCases = [
  {
    tenantId: 'wolfhouse',
    fromPhone: '+491701234567',
    env: {},
  },
  {
    tenantId: 'luna-v3',
    fromPhone: '+34699901101',
    env: {
      CROWSNEST_LIVE_SIM_LUNA_V3_ORIGIN: 'http://hermes-luna-clone:8090',
      CROWSNEST_LIVE_SIM_LUNA_V3_TOKEN: 'v3-only-token',
    },
  },
  {
    tenantId: 'sunset',
    fromPhone: '+34600111222',
    env: {},
  },
];
for (const testCase of nonProdCases) {
  const request = buildTenantRequest({ ...testCase, text: 'TEST' }, testCase.env);
  assert.strictEqual(request.ok, true, `${testCase.tenantId} request should build`);
  assert.strictEqual(
    JSON.stringify(request.payload),
    masterPayload(testCase.fromPhone, 'TEST'),
    `${testCase.tenantId} TEST payload must be byte-equal to master`,
  );
}
assert.strictEqual(buildTenantRequest({ tenantId: 'wolfhouse-prod', fromPhone: '+346' + '000000000', text: 'test' }, config).code, 'prod_phone_out_of_range');
assert.match(buildTenantRequest({ tenantId: 'bad', fromPhone: phone, text: 'test' }, {}).error, /wolfhouse-prod/);
const page = fs.readFileSync(path.join(__dirname, 'lib/crowsnest/crowsnest-page.js'), 'utf8');
assert.match(page, /option value="wolfhouse-prod">Wolfhouse Prod/);
console.log('verify:crowsnest-wolfhouse-prod-tenant passed');
