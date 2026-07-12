'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'docker/hermes-sunset');
const { resolveSunsetPhoneNumberId } = require('./lib/sunset-hermes-tenant-router');

const env = {
  SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID: 'meta-somo-test-id',
  SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID: 'meta-sardinero-test-id',
};

assert.deepStrictEqual(resolveSunsetPhoneNumberId('meta-somo-test-id', env), {
  tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-somo',
});
assert.deepStrictEqual(resolveSunsetPhoneNumberId('meta-sardinero-test-id', env), {
  tenant_id: 'sunset', client_slug: 'sunset', location_id: 'sunset-sardinero',
});
for (const value of ['unknown', '', null, undefined]) {
  assert.throws(() => resolveSunsetPhoneNumberId(value, env), /unknown Sunset phone_number_id/);
}
assert.throws(() => resolveSunsetPhoneNumberId('meta-somo-test-id', {
  ...env, SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID: 'meta-somo-test-id',
}), /unique/);

const compose = fs.readFileSync(path.join(runtime, 'docker-compose.vm.yml'), 'utf8');
for (const expected of [
  'hermes-sunset-luna:', '"8092:8092"', '/var/lib/hermes-sunset-luna:/opt/data',
  '/etc/hermes-sunset-luna.env', 'HERMES_ROLE: sunset-luna', 'LUNA_TENANT_ID: sunset',
  'WHATSAPP_CLOUD_WEBHOOK_PORT: "8092"', 'SUNSET_INGRESS_LOCATION_ID: sunset-somo',
]) assert.ok(compose.includes(expected), `compose missing ${expected}`);
assert.ok(!compose.includes('/var/lib/hermes-luna:/opt/data'), 'must not share Wolfhouse data');

const bootstrap = fs.readFileSync(path.join(runtime, 'bootstrap.sh'), 'utf8');
for (const expected of [
  'HERMES_ROLE', 'sunset-luna', 'LUNA_TENANT_ID', 'sunset',
  'SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID', 'SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_CLOUD_WEBHOOK_PORT=8092', 'SOUL.md',
]) assert.ok(bootstrap.includes(expected), `bootstrap missing ${expected}`);

const soul = fs.readFileSync(path.join(runtime, 'SOUL.md'), 'utf8');
for (const expected of ['Sunset Surf School', 'Your tenant is `sunset`', 'sunset-somo', 'sunset-sardinero']) {
  assert.ok(soul.includes(expected), `SOUL missing ${expected}`);
}
for (const forbidden of ['Wolf-House front-desk host', '24-year-old Italian surfer girl']) {
  assert.ok(!soul.includes(forbidden), `Sunset SOUL leaked ${forbidden}`);
}

console.log('PASS sunset Hermes runtime: tenant routing fails closed; isolated :8092 runtime and Sunset role/SOUL verified');
