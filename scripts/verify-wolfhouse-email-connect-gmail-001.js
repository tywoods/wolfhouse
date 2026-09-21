'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const tenant = require('./lib/email-wolfhouse-tenant');
assert.equal(tenant.ENV_GOOGLE_OAUTH_START, 'WOLFHOUSE_EMAIL_GOOGLE_OAUTH_START_ENABLED');
assert.equal(tenant.ENV_GOOGLE_OAUTH_CALLBACK, 'WOLFHOUSE_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED');
assert.equal(tenant.ENV_GOOGLE_OAUTH_CUSTODY, 'WOLFHOUSE_EMAIL_GOOGLE_OAUTH_GRANT_CUSTODY_ENABLED');
assert.equal(tenant.ENV_GOOGLE_OAUTH_CLIENT_ID, 'WOLFHOUSE_EMAIL_GOOGLE_OAUTH_CLIENT_ID');
assert.equal(tenant.ENV_GOOGLE_OAUTH_CLIENT_SECRET, 'WOLFHOUSE_EMAIL_GOOGLE_OAUTH_CLIENT_SECRET');
const enabled = Object.freeze({
  LUNA_DEPLOYMENT: 'staff-staging',
  WOLFHOUSE_EMAIL_SETTINGS_UI_ENABLED: 'true',
  WOLFHOUSE_EMAIL_GOOGLE_OAUTH_START_ENABLED: 'true',
  WOLFHOUSE_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED: 'true',
  WOLFHOUSE_EMAIL_GOOGLE_OAUTH_GRANT_CUSTODY_ENABLED: 'true',
});
assert.equal(tenant.isWolfhouseEmailGoogleOAuthStartEnabled(enabled), true);
assert.equal(tenant.isWolfhouseEmailGoogleOAuthCallbackEnabled(enabled), true);
assert.equal(tenant.isWolfhouseEmailGoogleOAuthCallbackEnabled(Object.freeze({...enabled,LUNA_DEPLOYMENT:'production'})), false);
assert.equal(tenant.isWolfhouseEmailGoogleOAuthCallbackEnabled(Object.freeze({...enabled,LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED:'true',WOLFHOUSE_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED:'false'})), false);

const kv = require('./lib/email-grant-envelope-azure-kv-wolfhouse-staff-staging-runtime-composition');
const kvEnv = Object.freeze({
  LUNA_DEPLOYMENT:'staff-staging',
  WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED:'true',
  WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_RUNTIME_ACTIVATION_ENABLED:'true',
  WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST:'wh-staging-kv.vault.azure.net',
  WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID:'https://wh-staging-kv.vault.azure.net/keys/luna-email-grant-kek/0123456789abcdef0123456789abcdef',
  WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_MANAGED_IDENTITY_CLIENT_ID:'e3136eed-948b-4947-a26e-50a33b45a41a',
});
const parsed=kv.parseWolfhouseStaffStagingEnvelopeConfig(kvEnv);
assert.equal(parsed.ok,true);assert.equal(parsed.versioned_key_id,kvEnv.WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID);
assert.equal(kv.parseWolfhouseStaffStagingEnvelopeConfig(Object.freeze({...kvEnv,LUNA_DEPLOYMENT:'production'})).ok,false);
assert.equal(kv.parseWolfhouseStaffStagingEnvelopeConfig(Object.freeze({...kvEnv,WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST:'luna-sunset-staging-kv.vault.azure.net'})).ok,false);
assert.equal(kv.parseWolfhouseStaffStagingEnvelopeConfig(Object.freeze({...kvEnv,WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID:'local:test'})).ok,false);
assert.equal(kv.parseWolfhouseStaffStagingEnvelopeConfig(Object.freeze({...kvEnv,WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_MANAGED_IDENTITY_CLIENT_ID:'11111111-1111-4111-8111-111111111111'})).ok,false);

// Construct the authentic Wolfhouse callback owner. Stub only the external Azure
// client boundary so this remains offline; shared state-first validators and all
// tenant/redirect pairing logic execute for real.
const Module = require('node:module');
const ownerPath = require.resolve('./lib/email-google-oauth-wolfhouse-staff-staging-runtime-composition');
const envelopePath = require.resolve('./lib/email-grant-envelope-azure-kv-wolfhouse-staff-staging-runtime-composition');
const realLoad = Module._load;
const fakeEnvelopeProvider = Object.freeze({
  sealGrantPayload() { throw new Error('lazy'); },
  openGrantPayload() { throw new Error('lazy'); },
  rewrapGrantDek() { throw new Error('lazy'); },
});
Module._load = function scopedLoad(request, parent, isMain) {
  if (parent && parent.filename === ownerPath && request === './email-grant-envelope-azure-kv-wolfhouse-staff-staging-runtime-composition') {
    return Object.freeze({
      ...kv,
      createActiveWolfhouseStaffStagingEnvelopeComposition() {
        return Object.freeze({ok:true,composition_enabled:true,runtime_activation:true,provider:fakeEnvelopeProvider});
      },
    });
  }
  return realLoad(request, parent, isMain);
};
delete require.cache[ownerPath];
const wolfRuntime = require(ownerPath);
Module._load = realLoad;
const runtimeEnv = Object.freeze({...kvEnv,
  WOLFHOUSE_EMAIL_GOOGLE_OAUTH_START_ENABLED:'true',
  WOLFHOUSE_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED:'true',
  WOLFHOUSE_EMAIL_GOOGLE_OAUTH_GRANT_CUSTODY_ENABLED:'true',
  WOLFHOUSE_EMAIL_GOOGLE_OAUTH_CLIENT_ID:'wolfhouse.apps.googleusercontent.com',
  WOLFHOUSE_EMAIL_GOOGLE_OAUTH_CLIENT_SECRET:'offline-test-secret-value',
});
const deps = Object.freeze({
  env:runtimeEnv,
  https:Object.freeze({request(){throw new Error('lazy');}}),
  crypto:Object.freeze({createPublicKey(){},verify(){},randomUUID(){return '10000000-0000-4000-8000-000000000001';},randomBytes(){return Buffer.alloc(32,1);},createHash(){return require('node:crypto').createHash('sha256');}}),
  timers:Object.freeze({setTimeout(){throw new Error('lazy');},clearTimeout(){}}),
  clock:Object.freeze({now(){return '2026-09-21T00:00:00.000Z';},nowEpochSeconds(){return 1789948800;}}),
});
const pg=Object.freeze({query(){throw new Error('lazy');}});
const callback=wolfRuntime.createWolfhouseStaffStagingGoogleOAuthComposition(deps).createCallbackRuntime(pg);
assert.equal(callback.configuration.tenantSlug,'wolfhouse-somo');
assert.equal(callback.configuration.locationKey,'wolfhouse-somo');
assert.equal(callback.configuration.redirectUri,'https://staff-staging.lunafrontdesk.com/staff/email/google/callback');
assert.equal(typeof callback.completeCallback,'function');

const compositionSource=fs.readFileSync(path.join(ROOT,'scripts/lib/email-google-oauth-wolfhouse-staff-staging-runtime-composition.js'),'utf8');
assert.doesNotMatch(compositionSource,/email-google-oauth-sunset-staging-runtime-composition|email-grant-envelope-azure-kv-sunset/);
assert.match(compositionSource,/tenantSlug:\s*'wolfhouse-somo'/);
assert.match(compositionSource,/WOLFHOUSE_EMAIL_GOOGLE_OAUTH_CLIENT_ID/);
const apiSource=fs.readFileSync(path.join(ROOT,'scripts/staff-query-api.js'),'utf8');
assert.match(apiSource,/createWolfhouseStaffStagingGoogleOAuthComposition/);
const routeSource=fs.readFileSync(path.join(ROOT,'scripts/lib/staff-google-oauth-production-integration.js'),'utf8');
assert.match(routeSource,/isWolfhouseEmailGoogleOAuthCallbackEnabled/);
assert.match(routeSource,/wolfhouse.*start/is);
assert.doesNotMatch(routeSource,/WOLFHOUSE_EMAIL_OUTBOUND_SEND_ENABLED[^\n]*true/);
console.log('PASS BUILD-WOLFHOUSE-EMAIL-CONNECT-GMAIL-001');
