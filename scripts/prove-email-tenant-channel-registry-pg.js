'use strict';

/**
 * prove:email-tenant-channel-registry-pg — Luna email Slice 1C-alpha
 *
 * Disposable PostgreSQL behavioral proof for the domain/repository layer over
 * migration 057 (tenant_locations + tenant_channel_endpoints).
 *
 * Uses repository disposable harness (Docker preferred; PGlite socket fallback).
 * Reuses assertSafeDatabaseTarget — refuses Azure/staging/prod/private hosts.
 *
 * PGlite is acceptable for this proof harness. Stock PostgreSQL must still
 * be proven before deploy — do not treat PGlite-only green as production sign-off.
 *
 * Does not touch live/staging DBs, provider adapters, HTTP routes, UI, SOUL, or deploy.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const {
  MIGRATIONS_DIR,
  prepareMigrationBody,
  assertSafeDatabaseTarget,
} = require('./lib/migration-integrity');
const { startDisposablePostgresHarness, dockerAvailable } = require('./lib/disposable-postgres-harness');

const ROOT = path.join(__dirname, '..');
const MIG_UP = '057_tenant_locations_and_channel_endpoints.sql';
const UP_PATH = path.join(MIGRATIONS_DIR, MIG_UP);
const REGISTRY_PATH = path.join(ROOT, 'scripts/lib/email-tenant-channel-registry.js');

const CAPABILITIES_ALL_FALSE = Object.freeze({
  push_notifications: false,
  provider_threads: false,
  remote_drafts: false,
  reply: false,
  reply_all: false,
  forward: false,
  attachments_metadata: false,
  delivery_events: false,
});

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

async function waitForPg(connection, attempts) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    const client = new Client({ ...connection, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (e) {
      last = e;
      try { await client.end(); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw last || new Error('postgres never ready');
}

async function createDb(admin, dbName) {
  const c = new Client(admin);
  await c.connect();
  await c.query(`CREATE DATABASE ${dbName}`);
  await c.end();
}

function assertDisposable(connection) {
  const safety = assertSafeDatabaseTarget(connection);
  if (!safety.ok) {
    throw Object.assign(
      new Error(`non-disposable DSN rejected: ${(safety.errors || []).map((e) => e.code).join(',')}`),
      { code: 'non_disposable_dsn', errors: safety.errors },
    );
  }
}

async function applySqlFile(client, filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const prepared = prepareMigrationBody(raw);
  if (!prepared.ok || !prepared.body) {
    throw new Error(`prepare failed for ${path.basename(filePath)}: ${prepared.message || prepared.code}`);
  }
  await client.query(prepared.body);
}

const PARENT_DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS clients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  email       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

function noRawPgLeak(result) {
  const blob = JSON.stringify(result);
  if (/duplicate key value|violates unique constraint|violates foreign key|relation \"|syntax error at/i.test(blob)) {
    return false;
  }
  if (/password=|sk-[A-Za-z0-9]{10,}/i.test(blob)) return false;
  return true;
}

async function runBehavioral(client, reg) {
  const clientA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const clientB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const actorA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const actorB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  await client.query(
    `INSERT INTO clients (id, slug, name) VALUES ($1, 'tenant-a', 'Tenant A'), ($2, 'tenant-b', 'Tenant B')`,
    [clientA, clientB],
  );
  await client.query(
    `INSERT INTO staff_users (id, client_id, email) VALUES ($1, $2, 'a@staff.test'), ($3, $4, 'b@staff.test')`,
    [actorA, clientA, actorB, clientB],
  );

  // List isolation on empty
  const emptyA = await reg.listTenantLocations({ clientId: clientA }, { db: client });
  const emptyB = await reg.listTenantLocations({ clientId: clientB }, { db: client });
  ok('list-locations-empty-a', emptyA.ok && emptyA.value.length === 0);
  ok('list-locations-empty-b', emptyB.ok && emptyB.value.length === 0);

  // Valid location creation
  const locA = await reg.createTenantLocation({
    clientId: clientA,
    actorStaffUserId: actorA,
    locationId: 'beach-house',
    displayName: 'Beach House',
  }, { client });
  ok('create-location-a', locA.ok === true, locA.error);
  ok('create-location-a-active-default', locA.ok && locA.value.active === true);

  const locB = await reg.createTenantLocation({
    clientId: clientB,
    actorStaffUserId: actorB,
    locationId: 'mountain-camp',
    displayName: 'Mountain Camp',
  }, { client });
  ok('create-location-b', locB.ok === true, locB.error);

  // Service list isolation
  const listA = await reg.listTenantLocations({ clientId: clientA }, { db: client });
  const listB = await reg.listTenantLocations({ clientId: clientB }, { db: client });
  ok(
    'list-isolation-a',
    listA.ok && listA.value.length === 1 && listA.value[0].location_id === 'beach-house',
  );
  ok(
    'list-isolation-b',
    listB.ok && listB.value.length === 1 && listB.value[0].location_id === 'mountain-camp',
  );
  ok(
    'list-isolation-no-cross',
    listA.value.every((r) => r.client_id === clientA)
      && listB.value.every((r) => r.client_id === clientB),
  );

  // Duplicate location conflict
  const dupLoc = await reg.createTenantLocation({
    clientId: clientA,
    actorStaffUserId: actorA,
    locationId: 'beach-house',
    displayName: 'Beach House Again',
  }, { client });
  ok(
    'duplicate-location-conflict',
    dupLoc.ok === false && dupLoc.error === 'location_already_exists',
    dupLoc.error,
  );
  ok('duplicate-location-no-raw-pg', noRawPgLeak(dupLoc));

  // Global location_id uniqueness across tenants
  const globalDup = await reg.createTenantLocation({
    clientId: clientB,
    actorStaffUserId: actorB,
    locationId: 'beach-house',
    displayName: 'Stolen Name',
  }, { client });
  ok(
    'global-location-id-conflict',
    globalDup.ok === false && globalDup.error === 'location_already_exists',
  );

  // Valid disabled endpoint
  const ep = await reg.createDisabledTenantChannelEndpoint({
    clientId: clientA,
    actorStaffUserId: actorA,
    location_id: 'beach-house',
    provider: 'microsoft_graph',
    public_address: 'support@example.com',
    secret_ref: 'kv:luna-support-email-credentials',
    capabilities: { ...CAPABILITIES_ALL_FALSE },
  }, { client });
  ok('create-disabled-endpoint', ep.ok === true, ep.error);
  ok(
    'endpoint-defaults-disabled',
    ep.ok
      && ep.value.inbound_enabled === false
      && ep.value.outbound_enabled === false
      && ep.value.active === false
      && ep.value.default_automation_mode === 'off'
      && ep.value.channel === 'email',
  );
  ok(
    'endpoint-opaque-secret-ref',
    ep.ok && ep.value.secret_ref === 'kv:luna-support-email-credentials',
  );

  // List endpoints isolation
  const epsA = await reg.listTenantChannelEndpoints({ clientId: clientA }, { db: client });
  const epsB = await reg.listTenantChannelEndpoints({ clientId: clientB }, { db: client });
  ok('list-endpoints-a', epsA.ok && epsA.value.length === 1);
  ok('list-endpoints-b-empty', epsB.ok && epsB.value.length === 0);

  // Cross-tenant location rejected
  const cross = await reg.createDisabledTenantChannelEndpoint({
    clientId: clientB,
    actorStaffUserId: actorB,
    location_id: 'beach-house',
    provider: 'gmail_api',
    public_address: 'cross@example.com',
    secret_ref: 'kv:safe-ref-label',
    capabilities: { ...CAPABILITIES_ALL_FALSE },
  }, { client });
  ok(
    'cross-tenant-location-rejected',
    cross.ok === false && cross.error === 'location_not_authorized',
  );

  // Missing location
  const missing = await reg.createDisabledTenantChannelEndpoint({
    clientId: clientA,
    actorStaffUserId: actorA,
    location_id: 'no-such-loc',
    provider: 'imap_smtp',
    public_address: 'missing@example.com',
    secret_ref: 'kv:safe-ref-label',
    capabilities: { ...CAPABILITIES_ALL_FALSE },
  }, { client });
  ok(
    'missing-location-rejected',
    missing.ok === false && missing.error === 'location_not_authorized',
  );

  // Inactive location rejected
  await client.query(
    `UPDATE tenant_locations SET active = false WHERE client_id = $1 AND location_id = 'beach-house'`,
    [clientA],
  );
  const inactive = await reg.createDisabledTenantChannelEndpoint({
    clientId: clientA,
    actorStaffUserId: actorA,
    location_id: 'beach-house',
    provider: 'imap_smtp',
    public_address: 'inactive@example.com',
    secret_ref: 'kv:safe-ref-label',
    capabilities: { ...CAPABILITIES_ALL_FALSE },
  }, { client });
  ok(
    'inactive-location-rejected',
    inactive.ok === false && inactive.error === 'location_not_authorized',
  );
  // Restore for further tests
  await client.query(
    `UPDATE tenant_locations SET active = true WHERE client_id = $1 AND location_id = 'beach-house'`,
    [clientA],
  );

  // Malformed contract values rejected
  const badProvider = await reg.createDisabledTenantChannelEndpoint({
    clientId: clientA,
    actorStaffUserId: actorA,
    location_id: 'beach-house',
    provider: 'sendgrid',
    public_address: 'bad@example.com',
    secret_ref: 'kv:safe-ref-label',
    capabilities: { ...CAPABILITIES_ALL_FALSE },
  }, { client });
  ok('malformed-provider-rejected', badProvider.ok === false);

  const badSecret = await reg.createDisabledTenantChannelEndpoint({
    clientId: clientA,
    actorStaffUserId: actorA,
    location_id: 'beach-house',
    provider: 'imap_smtp',
    public_address: 'badsec@example.com',
    secret_ref: 'sk-abcdefghijklmnopqrstuvwxyz012345',
    capabilities: { ...CAPABILITIES_ALL_FALSE },
  }, { client });
  ok('malformed-secret-rejected', badSecret.ok === false);

  // Activation attempts rejected
  const activeTry = await reg.createDisabledTenantChannelEndpoint({
    clientId: clientA,
    actorStaffUserId: actorA,
    location_id: 'beach-house',
    provider: 'imap_smtp',
    public_address: 'active-try@example.com',
    secret_ref: 'kv:safe-ref-label',
    capabilities: { ...CAPABILITIES_ALL_FALSE },
    active: true,
  }, { client });
  ok('active-true-rejected', activeTry.ok === false);

  // Duplicate public_address within tenant (inactive) rejected by service
  const dupEp = await reg.createDisabledTenantChannelEndpoint({
    clientId: clientA,
    actorStaffUserId: actorA,
    location_id: 'beach-house',
    provider: 'gmail_api',
    public_address: 'support@example.com',
    secret_ref: 'kv:other-safe-ref',
    capabilities: { ...CAPABILITIES_ALL_FALSE },
  }, { client });
  ok(
    'duplicate-inactive-address-conflict',
    dupEp.ok === false && dupEp.error === 'endpoint_already_exists',
    dupEp.error,
  );

  // Transaction rollback: force DB error mid-flight via invalid FK actor after
  // location exists — use a non-existent staff user UUID to trigger FK fail on insert.
  // Service should map to db_error or structured failure without raw PG leak.
  const ghostActor = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const rolled = await reg.createDisabledTenantChannelEndpoint({
    clientId: clientA,
    actorStaffUserId: ghostActor,
    location_id: 'beach-house',
    provider: 'imap_smtp',
    public_address: 'rollback@example.com',
    secret_ref: 'kv:safe-ref-label',
    capabilities: { ...CAPABILITIES_ALL_FALSE },
  }, { client });
  ok(
    'tx-rollback-on-db-error',
    rolled.ok === false && (rolled.error === 'db_error' || rolled.error === 'actor_invalid'),
    rolled.error,
  );
  ok('tx-rollback-no-raw-pg', noRawPgLeak(rolled));
  const ghostRow = await client.query(
    `SELECT COUNT(*)::int AS n FROM tenant_channel_endpoints WHERE public_address = 'rollback@example.com'`,
  );
  ok('tx-rollback-no-partial-row', ghostRow.rows[0].n === 0);

  // Zero provider IO: this script never imports Graph/Gmail/IMAP SDKs
  ok('zero-provider-sdk-in-registry-source', (() => {
    const src = fs.readFileSync(REGISTRY_PATH, 'utf8');
    return !/@microsoft\/microsoft-graph|googleapis|nodemailer|imapflow/i.test(src);
  })());
}

async function main() {
  console.log('prove:email-tenant-channel-registry-pg — Slice 1C-alpha ephemeral PG\n');

  if (!fs.existsSync(UP_PATH)) {
    console.error('BLOCKER: migration 057 missing');
    ok('migration-057-present', false);
    process.exit(1);
  }
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error('BLOCKER: registry module missing — implement domain layer first (TDD RED).');
    ok('registry-module-present', false, REGISTRY_PATH);
    console.log(`\n── prove:email-tenant-channel-registry-pg FAILED (${pass} pass, ${fail} fail) ──`);
    process.exit(1);
  }

  let reg;
  try {
    reg = require(REGISTRY_PATH);
  } catch (e) {
    ok('registry-module-loads', false, String(e.message || e).slice(0, 160));
    process.exit(1);
  }
  ok('registry-module-loads', true);

  const dockerOk = dockerAvailable();
  console.log(`  info  docker_available=${dockerOk}`);

  let cleanup = () => {};
  try {
    const harness = await startDisposablePostgresHarness();
    cleanup = harness.cleanup;
    console.log(`  info  backend=${harness.backend}`);

    await waitForPg(harness.admin, 80);

    const suffix = crypto.randomBytes(4).toString('hex');
    const dbName = `wh_mig_email1c_${suffix}`;
    await createDb(harness.admin, dbName);

    const conn = {
      host: harness.admin.host,
      port: harness.admin.port,
      user: harness.admin.user,
      password: harness.admin.password,
      database: dbName,
    };
    assertDisposable(conn);
    ok('safety-gate-ephemeral-loopback', true);

    const client = new Client(conn);
    await client.connect();

    await client.query(PARENT_DDL);
    await applySqlFile(client, UP_PATH);
    ok('migration-057-applies', true);

    await runBehavioral(client, reg);

    await client.end();
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/Docker unavailable and @electric-sql\/pglite/i.test(msg) || /Cannot connect to the Docker daemon/i.test(msg)) {
      console.error(`BLOCKER: no ephemeral PostgreSQL backend available — ${msg}`);
      ok('ephemeral-postgres-available', false, msg.slice(0, 200));
    } else {
      console.error('prove error:', msg);
      ok('prove-completed-without-throw', false, msg.slice(0, 200));
    }
  } finally {
    try { cleanup(); } catch (_) { /* ignore */ }
  }

  console.log(`\n── prove:email-tenant-channel-registry-pg ${fail ? 'FAILED' : 'PASSED'} (${pass} pass, ${fail} fail) ──`);
  if (!dockerAvailable()) {
    console.log('  note  Docker daemon unavailable; used/attempted PGlite disposable fallback when packages present.');
    console.log('  note  PGlite is acceptable here; prove on stock PostgreSQL before deploy.');
  } else {
    console.log('  note  Disposable harness used; stock PostgreSQL still required before deploy.');
  }
  process.exit(fail > 0 ? 1 : 0);
}

main();
