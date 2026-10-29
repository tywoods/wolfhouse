'use strict';

/**
 * Reviewed prod apply target is the isolated Docker service, not the
 * public France IP. 5432 stays unpublished.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const contract = require('./contract');
const adapter = require('./adapter');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'fixtures', 'wolfhouse-prod-data', 'config-only.json');
const DOC = path.join(ROOT, 'docs', 'prod', 'wolfhouse-data-contract.md');

const INTERNAL_TARGET = {
  host: 'wolfhouse-prod-postgres',
  port: 5432,
  database: 'wolfhouse_prod',
  network: 'wolfhouse-prod-private',
  manifestId: 'wolfhouse-prod-data-v2026-10-28.3',
  mounts: { data: '/var/lib/wolfhouse-prod/data', backupSpool: '/var/lib/wolfhouse-prod/backup-spool' },
  backupDestination: 'azure://acct/container/object',
};

const INTERNAL_URL = 'postgres://wolfhouse:***@wolfhouse-prod-postgres:5432/wolfhouse_prod';

function targetPatch(patch) {
  return Object.assign({}, INTERNAL_TARGET, patch);
}

test('contract accepts the isolated internal prod target', () => {
  assert.equal(contract.target(INTERNAL_TARGET), true);
});

test('bindProdUrl accepts wolfhouse-prod-postgres:5432/wolfhouse_prod', () => {
  const bound = adapter.bindProdUrl(INTERNAL_URL, INTERNAL_TARGET);
  assert.equal(bound.host, 'wolfhouse-prod-postgres');
  assert.equal(bound.port, 5432);
  assert.equal(bound.database, 'wolfhouse_prod');
});

test('contract rejects the unpublished public IP as a prod target', () => {
  assert.throws(
    () => contract.target(targetPatch({ host: '178.33.91.59' })),
    (err) => err && err.code === 'invalid_target',
  );
});

test('bindProdUrl refuses the public France IP even with matching target host', () => {
  const publicTarget = targetPatch({ host: '178.33.91.59' });
  assert.throws(
    () => adapter.bindProdUrl('postgres://wolfhouse:***@178.33.91.59:5432/wolfhouse_prod', publicTarget),
    (err) => err && (err.code === 'invalid_target' || err.code === 'prod_url_host_not_allowlisted'),
  );
});

test('bindProdUrl refuses loopback, TEST, Sunset, and other hosts', () => {
  const rejected = [
    'postgres://wolfhouse:***@127.0.0.1:5432/wolfhouse_prod',
    'postgres://wolfhouse:***@localhost:5432/wolfhouse_prod',
    'postgres://wolfhouse:***@[::1]:5432/wolfhouse_prod',
    'postgres://wolfhouse:***@wolfhouse-staging-postgres:5432/wolfhouse_prod',
    'postgres://wolfhouse:***@wh-staging-pg-app:5432/wolfhouse_prod',
    'postgres://wolfhouse:***@sunset-postgres:5432/wolfhouse_prod',
    'postgres://wolfhouse:***@evil.example.com:5432/wolfhouse_prod',
  ];
  for (const url of rejected) {
    assert.throws(
      () => adapter.bindProdUrl(url, INTERNAL_TARGET),
      (err) => err && (err.code === 'prod_url_host_not_allowlisted' || err.code === 'prod_url_host_mismatch'),
      url,
    );
  }
});

test('bindProdUrl refuses TEST/Sunset database names on the internal host', () => {
  const rejected = [
    'postgres://wolfhouse:***@wolfhouse-prod-postgres:5432/wolfhouse_staging',
    'postgres://wolfhouse:***@wolfhouse-prod-postgres:5432/wolfhouse_test',
    'postgres://wolfhouse:***@wolfhouse-prod-postgres:5432/sunset',
  ];
  for (const url of rejected) {
    assert.throws(
      () => adapter.bindProdUrl(url, INTERNAL_TARGET),
      (err) => err && err.code === 'prod_db_mismatch',
      url,
    );
  }
});

test('contract rejects TEST/Sunset target identity', () => {
  const rejected = [
    { host: 'wolfhouse-staging-postgres' },
    { database: 'wolfhouse_staging' },
    { database: 'sunset' },
    { network: 'wolfhouse-staging' },
    { network: 'bridge' },
    { port: 6543 },
  ];
  for (const patch of rejected) {
    assert.throws(
      () => contract.target(targetPatch(patch)),
      (err) => err && err.code === 'invalid_target',
      JSON.stringify(patch),
    );
  }
});

test('bindProdUrl refuses a query host override off the internal service', () => {
  assert.throws(
    () => adapter.bindProdUrl(
      INTERNAL_URL + '?host=178.33.91.59',
      INTERNAL_TARGET,
    ),
    (err) => err && (err.code === 'prod_url_host_not_allowlisted' || err.code === 'prod_url_host_mismatch'),
  );
});

test('bindProdUrl refuses a query port override', () => {
  assert.throws(
    () => adapter.bindProdUrl(INTERNAL_URL + '?port=6543', INTERNAL_TARGET),
    (err) => err && err.code === 'prod_url_port_mismatch',
  );
});

test('CLI --apply refuses the public IP before connect', () => {
  const targetFile = path.join(os.tmpdir(), 'wh-prod-internal-target.json');
  fs.writeFileSync(targetFile, JSON.stringify(INTERNAL_TARGET));
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'adapter.js'),
    'import', '--apply', '--fixture', FIXTURE, '--target', targetFile,
    '--prod-url', 'postgres://wolfhouse:***@178.33.91.59:5432/wolfhouse_prod',
  ], { encoding: 'utf8', cwd: ROOT, timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prod_url_host_not_allowlisted|prod_url_host_mismatch|invalid_target/);
});

test('docs name the isolated docker run Skip should use', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  assert.match(doc, /wolfhouse-prod-private/);
  assert.match(doc, /wolfhouse-prod-postgres:5432/);
  assert.match(doc, /wolfhouse_prod/);
  assert.match(doc, /docker run/);
  assert.match(doc, /--network wolfhouse-prod-private/);
  assert.match(doc, /import --apply/);
});
