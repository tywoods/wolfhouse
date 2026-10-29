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
assert.strictEqual(built.payload.allow_writes, false);
assert.strictEqual(built.payload.dry_run, true);
assert.strictEqual(built.payload.whatsapp_suppressed, true);
assert.deepStrictEqual(built.payload.tags, ['test']);
assert.deepStrictEqual(built.payload.metadata, { test: true, source: 'crowsnest_live_simulator' });
assert.strictEqual(buildTenantRequest({ tenantId: 'wolfhouse-prod', fromPhone: '+346' + '000000000', text: 'test' }, config).code, 'prod_phone_out_of_range');
assert.match(buildTenantRequest({ tenantId: 'bad', fromPhone: phone, text: 'test' }, {}).error, /wolfhouse-prod/);
const page = fs.readFileSync(path.join(__dirname, 'lib/crowsnest/crowsnest-page.js'), 'utf8');
assert.match(page, /option value="wolfhouse-prod">Wolfhouse Prod/);
console.log('verify:crowsnest-wolfhouse-prod-tenant passed');
