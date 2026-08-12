'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

const Module = require('node:module');
const OWNER = path.join(__dirname, 'lib/email-google-oauth-sunset-staging-runtime-composition.js');
const ENVELOPE_OWNER = require.resolve('./lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const realLoad = Module._load;
const realEnvelope = require(ENVELOPE_OWNER);
Module._load = function scopedLoad(request, parent, isMain) {
  if (parent && parent.filename === OWNER
      && request === './email-grant-envelope-azure-kv-sunset-staging-runtime-composition') {
    return Object.freeze({
      ...realEnvelope,
      createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(env) {
        if (env[ENVELOPE_ACTIVATION] !== 'true') throw new Error('inactive');
        const provider = frozen({
          async sealGrantPayload() { throw new Error('lazy'); },
          async openGrantPayload() { throw new Error('lazy'); },
          async rewrapGrantDek() { throw new Error('lazy'); },
        });
        return frozen({ ok: true, composition_enabled: true, runtime_activation: true,
          deployment_boundary: 'sunset-staging-canary-only', provider,
          public_metadata: frozen({ runtime_activation: true }) });
      },
    });
  }
  return realLoad(request, parent, isMain);
};
delete require.cache[OWNER];
const runtime = require(OWNER);
Module._load = realLoad;
const EXPECTED_CODE = 'GOOGLE_OAUTH_SUNSET_STAGING_RUNTIME_COMPOSITION_INVALID';
const CUSTODY = 'LUNA_EMAIL_GOOGLE_OAUTH_GRANT_CUSTODY_ENABLED';
const ENVELOPE_ACTIVATION = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_SUNSET_STAGING_RUNTIME_ACTIVATION_ENABLED';

function frozen(value) { return Object.freeze(value); }
function rejected(fn) {
  assert.throws(fn, error => error && error.code === EXPECTED_CODE
    && error.message === 'Google OAuth Sunset staging runtime composition failed.'
    && error.stack === undefined && Object.isFrozen(error));
}
function baseEnv(extra = {}) {
  return frozen({
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_GOOGLE_OAUTH_CLIENT_ID: 'sunset.apps.googleusercontent.com',
    LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED: 'true',
    LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED: 'true',
    [CUSTODY]: 'true',
    EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED: 'true',
    [ENVELOPE_ACTIVATION]: 'true',
    EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST: 'luna-sunset-staging-kv.vault.azure.net',
    EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID: 'https://luna-sunset-staging-kv.vault.azure.net/keys/luna-email-grant-kek/fde9704bd37b45fabe1f12a6a615b032',
    LUNA_EMAIL_GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret-not-production',
    ...extra,
  });
}
function deps(env, clock, pg) {
  return frozen({
    env,
    https: frozen({ request() { throw new Error('network must be lazy'); } }),
    crypto: frozen({
      createPublicKey() {}, verify() {}, randomUUID() { return '10000000-0000-4000-8000-000000000001'; },
      randomBytes() { return Buffer.alloc(32, 7); }, createHash() { return require('node:crypto').createHash('sha256'); },
    }),
    timers: frozen({ setTimeout() { throw new Error('timer must be lazy'); }, clearTimeout() {} }),
    clock,
  });
}
const pg = frozen({ query() { throw new Error('SQL must be lazy'); } });
const clockCalls = [];
const clock = frozen({
  now() { clockCalls.push('now'); return '2026-08-12T12:34:56.000Z'; },
  nowEpochSeconds() { clockCalls.push('epoch'); return 1786538096; },
});

assert.deepEqual(Reflect.ownKeys(runtime), [
  'SUNSET_DEPLOYMENT', 'START_ENABLED_ENV', 'CALLBACK_ENABLED_ENV',
  'GRANT_CUSTODY_ENABLED_ENV', 'createSunsetStagingGoogleOAuthComposition',
]);
assert.equal(runtime.GRANT_CUSTODY_ENABLED_ENV, CUSTODY);
assert(Object.isFrozen(runtime));

const composition = runtime.createSunsetStagingGoogleOAuthComposition(deps(baseEnv(), clock));
assert.deepEqual(Reflect.ownKeys(composition), ['createStart', 'createCallbackRuntime']);
assert(Object.isFrozen(composition));
assert.equal(clockCalls.length, 0, 'factory must not consult time');
const start = composition.createStart(pg);
assert.equal(typeof start.start, 'function');
assert.equal(clockCalls.length, 0, 'createStart must remain side-effect free');

// Callback construction is permitted by two independent explicit gates, but must
// remain lazy: no SQL, secret read, Azure wrap, HTTP, timer, or clock call here.
const callback = composition.createCallbackRuntime(pg, '20000000-0000-4000-8000-000000000002');
assert.equal(typeof callback.completeCallback, 'function');
assert.equal(callback.configuration.applicationClientId, 'sunset.apps.googleusercontent.com');
assert.equal(callback.configuration.redirectUri, 'https://staff-staging.lunafrontdesk.com/staff/email/google/callback');
assert.equal(callback.configuration.callbackEnabled, true);
assert.equal(clockCalls.length, 0);

// Every gate defaults off independently; disabled paths construct no callback owners.
for (const env of [
  baseEnv({ LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED: 'false' }),
  baseEnv({ [CUSTODY]: 'false' }),
  baseEnv({ EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED: 'false' }),
  baseEnv({ [ENVELOPE_ACTIVATION]: 'false' }),
]) {
  const off = runtime.createSunsetStagingGoogleOAuthComposition(deps(env, clock));
  rejected(() => off.createCallbackRuntime(pg, '20000000-0000-4000-8000-000000000002'));
}

// Exact frozen authority surfaces only.
rejected(() => runtime.createSunsetStagingGoogleOAuthComposition(frozen({ ...deps(baseEnv(), clock), extra: true })));
rejected(() => runtime.createSunsetStagingGoogleOAuthComposition(deps(Object.freeze(new Proxy({}, {})), clock)));
rejected(() => runtime.createSunsetStagingGoogleOAuthComposition(deps(baseEnv(), frozen({ now() { return 'x'; } }))));
rejected(() => runtime.createSunsetStagingGoogleOAuthComposition(frozen({
  ...deps(baseEnv(), clock), clock: frozen({ ...clock, extra: true }),
})));
const mutable = { ...deps(baseEnv(), clock) };
rejected(() => runtime.createSunsetStagingGoogleOAuthComposition(mutable));
const hostilePg = frozen({ query() {}, connect() {}, totalCount: 0, idleCount: 0, waitingCount: 0 });
rejected(() => composition.createStart(hostilePg));
rejected(() => composition.createStart(new Proxy(pg, {})));

// Ambient clocks replaced after module load cannot become authority.
const savedDate = global.Date;
global.Date = class PoisonDate { static now() { throw new Error('ambient Date.now used'); } };
try { assert.equal(typeof composition.createStart(pg).start, 'function'); }
finally { global.Date = savedDate; }

console.log('PASS Google Sunset staging OAuth production behavioral composition');
