'use strict';

/**
 * Offline gate: Sunset delegated read-health runtime composition (default-off).
 */

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const COMPOSITION_ABS = path.join(__dirname, 'lib/email-microsoft-delegated-read-sunset-staging-runtime-composition.js');
const HOST = 'luna-sunset-staging-kv.vault.azure.net';
const KEY_ID = `https://${HOST}/keys/luna-email-grant-kek/fde9704bd37b45fabe1f12a6a615b032`;
const MI = '0e05fbe3-e8c5-48aa-a914-30aed284e6f7';
const APP_ID = '12345678-1234-4234-8234-123456789abc';
const SECRET = 'secret-NEVER_LEAK';

function enabledEnv(patch = {}) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_OAUTH_READ_HEALTH_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP_ID,
    LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED: 'true',
    EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST: HOST,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID: KEY_ID,
    ...patch,
  };
}

function installAzureLoadIntercept() {
  const original = Module._load;
  Module._load = function intercepted(request, parent, isMain) {
    if (request === '@azure/identity') {
      return {
        ManagedIdentityCredential: class {
          constructor(clientId) { assert.equal(clientId, MI); }
          getToken() { return Promise.resolve({ token: 'x', expiresOnTimestamp: Date.now() + 1 }); }
        },
      };
    }
    if (request === '@azure/keyvault-keys') {
      return {
        CryptographyClient: class {
          constructor(keyId) { assert.equal(keyId, KEY_ID); }
          wrapKey() { return Promise.resolve({ result: Buffer.alloc(256) }); }
          unwrapKey() { return Promise.resolve({ result: Buffer.alloc(32) }); }
        },
      };
    }
    return original.call(this, request, parent, isMain);
  };
  return () => { Module._load = original; };
}

function main() {
  const restore = installAzureLoadIntercept();
  try {
    delete require.cache[COMPOSITION_ABS];
    const mod = require('./lib/email-microsoft-delegated-read-sunset-staging-runtime-composition');
    assert.equal(mod.isReadHealthEnabled({}), false);
    assert.equal(mod.isReadHealthEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_READ_HEALTH_ENABLED: 'true',
    }), true);
    assert.equal(mod.isReadHealthEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_REFRESH_HEALTH_ENABLED: 'true',
    }), false);

    assert.throws(
      () => mod.createSunsetStagingMicrosoftDelegatedReadRuntime(Object.freeze({
        env: enabledEnv({ LUNA_EMAIL_OAUTH_READ_HEALTH_ENABLED: 'false' }),
        pgClient: { query: async () => ({ rows: [] }) },
        https: { request() {} },
        timers: { setTimeout, clearTimeout },
      })),
      (e) => e.code === mod.ERROR_CODE && !String(e).includes('NEVER_LEAK'),
    );

    const runtime = mod.createSunsetStagingMicrosoftDelegatedReadRuntime(Object.freeze({
      env: enabledEnv(),
      pgClient: { query: async () => ({ rows: [] }) },
      https: Object.freeze({ request() { throw new Error('no_network'); } }),
      timers: Object.freeze({ setTimeout, clearTimeout }),
    }));
    assert.equal(typeof runtime.runReadHealth, 'function');
    assert.deepEqual(Reflect.ownKeys(runtime), ['runReadHealth']);

    const pkg = require('../package.json');
    assert.ok(pkg.scripts['verify:email-microsoft-delegated-read-sunset-staging-runtime-composition']);
  } finally {
    restore();
  }
  console.log('verify:email-microsoft-delegated-read-sunset-staging-runtime-composition: ok');
}

main();
