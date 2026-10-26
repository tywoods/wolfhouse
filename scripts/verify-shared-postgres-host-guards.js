'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SHARED_HOST = 'luna-pg-shared.postgres.database.azure.com';
const SUNSET_DB = 'sunset_staging';

function source(name) {
  return fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');
}

const activeOwners = [
  'backfill-sunset-admin-config.js',
  'backfill-sunset-admin-location-config.js',
  'reconcile-sunset-admin-price-identities.js',
  'lib/phase-d-live-readonly-boundary.js',
  'lib/sunset-schema-observer.js',
  'lib/sunset-schema-observer-role-container-pg.js',
  'lib/sunset-schema-observer-role-provision.js',
];

for (const owner of activeOwners) {
  const text = source(owner);
  assert.ok(text.includes(SHARED_HOST) || text.includes("postgresServer: 'luna-pg-shared'"), `${owner} must lock the shared host/server`);
  assert.ok(text.includes(SUNSET_DB) || text.includes('EXPECTED_DATABASE'), `${owner} must retain the Sunset database lock`);
  assert.doesNotMatch(text, /luna-sunset-staging-pg-app/, `${owner} must not lock the deleted Sunset server`);
}

const applyCommandOwners = [
  'prove-sunset-schema-slice14aa-surf-pack-trigger-apply.js',
  'prove-sunset-schema-slice14ad-ledger-baseline-apply.js',
  'prove-sunset-schema-slice14ae-canonical-runner-noop.js',
  'prove-sunset-schema-slice14y-five-index-apply.js',
  'prove-sunset-schema-slice14z-surf-pack-fk-apply.js',
];
for (const owner of applyCommandOwners) {
  const text = source(owner);
  assert.ok(text.includes('--postgres-server luna-pg-shared'), `${owner} must emit the shared server`);
  assert.ok(text.includes('--database sunset_staging'), `${owner} must retain the Sunset database argument`);
  assert.doesNotMatch(text, /--postgres-server luna-sunset-staging-pg-app/, `${owner} must not emit the deleted server`);
}

const reconcile = source('reconcile-sunset-admin-price-identities.js');
assert.match(reconcile, /new URL\(/, 'price reconciliation must parse the URL rather than substring-match it');
assert.match(reconcile, /\.hostname\s*!==\s*APPROVED_HOST/, 'price reconciliation must compare the exact hostname');
assert.match(reconcile, /database\s*!==\s*APPROVED_DB/, 'price reconciliation must reject the shared host with the wrong database');
const { assertStagingUrl } = require('./reconcile-sunset-admin-price-identities');
assert.deepEqual(
  assertStagingUrl(`postgres://user:password@${SHARED_HOST}:5432/${SUNSET_DB}?sslmode=verify-full`),
  { host: SHARED_HOST, database: SUNSET_DB },
);
assert.throws(
  () => assertStagingUrl(`postgres://user:password@${SHARED_HOST}:5432/wolfhouse_staging?sslmode=verify-full`),
  /Refusing non-staging URL/,
);

const wolfhouseRecovery = require('./lib/staging-ledger-recovery');
assert.equal(wolfhouseRecovery.RECOVERY_TARGET.postgresHost, SHARED_HOST);
assert.equal(wolfhouseRecovery.RECOVERY_TARGET.database, 'wolfhouse_staging');

const sunsetObserver = require('./lib/sunset-schema-observer');
assert.equal(sunsetObserver.EXPECTED_HOST, SHARED_HOST);
assert.equal(sunsetObserver.EXPECTED_DATABASE, SUNSET_DB);

console.log('PASS active shared-host owners retain exact tenant database guards');
