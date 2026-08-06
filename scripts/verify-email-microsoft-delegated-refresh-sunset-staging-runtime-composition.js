'use strict';

/**
 * Offline gate: Sunset delegated refresh-health runtime composition.
 * Default-off; Module._load intercept for @azure/* (no live Azure).
 */

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const COMPOSITION_REL = 'scripts/lib/email-microsoft-delegated-refresh-sunset-staging-runtime-composition.js';
const COMPOSITION_ABS = path.join(__dirname, 'lib/email-microsoft-delegated-refresh-sunset-staging-runtime-composition.js');

const MI = '0e05fbe3-e8c5-48aa-a914-30aed284e6f7';
const HOST = 'luna-sunset-staging-kv.vault.azure.net';
const KEY_ID = `https://${HOST}/keys/luna-email-grant-kek/fde9704bd37b45fabe1f12a6a615b032`;
const APP_ID = '12345678-1234-4234-8234-123456789abc';
const SECRET = 'secret-NEVER_LEAK';

function enabledEnv(patch = {}) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_OAUTH_REFRESH_HEALTH_ENABLED: 'true',
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
        ManagedIdentityCredential: class ManagedIdentityCredential {
          constructor(clientId) {
            assert.equal(clientId, MI);
            this.clientId = clientId;
          }
          getToken() { return Promise.resolve({ token: 'x', expiresOnTimestamp: Date.now() + 60000 }); }
        },
      };
    }
    if (request === '@azure/keyvault-keys') {
      return {
        CryptographyClient: class CryptographyClient {
          constructor(keyId) {
            assert.equal(keyId, KEY_ID);
          }
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
    const mod = require('./lib/email-microsoft-delegated-refresh-sunset-staging-runtime-composition');
    assert.equal(mod.isRefreshHealthEnabled({}), false);
    assert.equal(mod.isRefreshHealthEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_REFRESH_HEALTH_ENABLED: 'true',
    }), true);
    assert.equal(mod.isRefreshHealthEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_START_ENABLED: 'true',
    }), false, 'start flag must not enable refresh-health');
    assert.equal(mod.isRefreshHealthEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true',
    }), false, 'callback flag must not enable refresh-health');

    assert.throws(
      () => mod.createSunsetStagingMicrosoftDelegatedRefreshRuntime(Object.freeze({
        env: enabledEnv({ LUNA_EMAIL_OAUTH_REFRESH_HEALTH_ENABLED: 'false' }),
        pgClient: { query: async () => ({ rows: [] }) },
        https: { request() {} },
        timers: { setTimeout, clearTimeout },
      })),
      (e) => e.code === mod.ERROR_CODE && !String(e).includes('NEVER_LEAK'),
    );

    const runtime = mod.createSunsetStagingMicrosoftDelegatedRefreshRuntime(Object.freeze({
      env: enabledEnv(),
      pgClient: { query: async () => ({ rows: [] }) },
      https: Object.freeze({ request() { throw new Error('no_network'); } }),
      timers: Object.freeze({ setTimeout, clearTimeout }),
    }));
    assert.equal(typeof runtime.runRefreshHealth, 'function');
    assert.deepEqual(Reflect.ownKeys(runtime), ['runRefreshHealth']);
    assert.equal(Object.isFrozen(runtime), true);

    const pkg = require('../package.json');
    assert.ok(pkg.scripts['verify:email-microsoft-delegated-refresh-sunset-staging-runtime-composition']);
    assert.ok(require('fs').existsSync(path.join(__dirname, '..', COMPOSITION_REL)));
  } finally {
    restore();
  }
  console.log('verify:email-microsoft-delegated-refresh-sunset-staging-runtime-composition: ok');
}

main();
