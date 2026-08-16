'use strict';
const assert = require('node:assert/strict');
const { Client: PgClient } = require('pg');
const {
  createSunsetStagingGoogleOAuthComposition,
} = require('./lib/email-google-oauth-sunset-staging-runtime-composition');

const CODE = 'GOOGLE_OAUTH_SUNSET_STAGING_RUNTIME_COMPOSITION_INVALID';
const frozen = Object.freeze;
function rejects(fn) { assert.throws(fn, error => error && error.code === CODE); }
function dependencies() {
  return frozen({
    env: frozen({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_GOOGLE_OAUTH_CLIENT_ID: 'sunset.apps.googleusercontent.com',
      LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED: 'true',
      LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED: 'false',
      LUNA_EMAIL_GOOGLE_OAUTH_GRANT_CUSTODY_ENABLED: 'false',
    }),
    https: frozen({ request() { throw new Error('network must remain lazy'); } }),
    crypto: frozen({
      createPublicKey() {}, verify() {},
      randomUUID() { return '10000000-0000-4000-8000-000000000001'; },
      randomBytes() { return Buffer.alloc(32, 7); },
      createHash() { return require('node:crypto').createHash('sha256'); },
    }),
    timers: frozen({ setTimeout() { throw new Error('timer must remain lazy'); }, clearTimeout() {} }),
    clock: frozen({
      now() { return '2026-08-16T09:58:32.000Z'; },
      nowEpochSeconds() { return 1786874312; },
    }),
  });
}

const composition = createSunsetStagingGoogleOAuthComposition(dependencies());

// Offline evidence: pg.Pool#connect necessarily opens a PostgreSQL connection. A direct
// construction is therefore the strongest truthful network-free genuine dependency object:
// Pool uses this exact installed pg Client constructor for acquired PoolClients.
const genuineInstalledPgClient = new PgClient();
assert.equal(Object.getPrototypeOf(genuineInstalledPgClient), PgClient.prototype);
assert.equal(Object.hasOwn(genuineInstalledPgClient, 'query'), false);
assert.equal(typeof composition.createStart(genuineInstalledPgClient).start, 'function');

// Preserve deterministic frozen own-data test doubles.
assert.equal(typeof composition.createStart(frozen({ query() { throw new Error('SQL must remain lazy'); } })).start, 'function');

// Native acceptance is exact: no proxy, subclass, custom prototype, accessor, or own override.
rejects(() => composition.createStart(new Proxy(new PgClient(), {})));
class PgSubclass extends PgClient {}
rejects(() => composition.createStart(new PgSubclass()));
const customPrototype = Object.create(PgClient.prototype);
rejects(() => composition.createStart(Object.create(customPrototype)));
const ownOverride = new PgClient();
ownOverride.query = PgClient.prototype.query;
rejects(() => composition.createStart(ownOverride));
const ownAccessor = new PgClient();
Object.defineProperty(ownAccessor, 'query', { get() { return PgClient.prototype.query; } });
rejects(() => composition.createStart(ownAccessor));

// Constructor/prototype/query identities pinned at module initialization fail closed after mutation.
const queryDescriptor = Object.getOwnPropertyDescriptor(PgClient.prototype, 'query');
PgClient.prototype.query = function monkeypatchedQuery() {};
try { rejects(() => composition.createStart(new PgClient())); }
finally { Object.defineProperty(PgClient.prototype, 'query', queryDescriptor); }

console.log('PASS EMAIL-GMAIL-PREPARE-003 genuine installed pg Client compatibility and fail-closed pins');
