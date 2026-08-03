'use strict';

/**
 * prove:email-tenant-location-registry-pg — Luna email Slice 1B
 *
 * Ephemeral PostgreSQL behavioral proof for migration 057
 * (tenant_locations + tenant_channel_endpoints). Uses repository disposable
 * harness (Docker preferred; PGlite socket fallback). Reuses
 * assertSafeDatabaseTarget — refuses Azure/staging/prod/private hosts.
 *
 * PGlite is acceptable for this proof harness. Stock PostgreSQL must still
 * be proven before deploy — do not treat PGlite-only green as production
 * migration sign-off.
 *
 * Does not ship or exercise an async PG locationAuthority bridge into the
 * Slice 1A synchronous validator. Persistence integrity is the composite FK.
 *
 * Does not touch live/staging DBs, provider adapters, UI, SOUL, or deploy.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const {
  MIGRATIONS_DIR,
  prepareMigrationBody,
  sha256CanonicalLfV1File,
  assertSafeDatabaseTarget,
  loadManifest,
  forwardEntries,
  MANIFEST_PATH,
} = require('./lib/migration-integrity');
const { startDisposablePostgresHarness, dockerAvailable } = require('./lib/disposable-postgres-harness');

const ROOT = path.join(__dirname, '..');
const MIG_UP = '057_tenant_locations_and_channel_endpoints.sql';
const MIG_DOWN = '057_tenant_locations_and_channel_endpoints_down.sql';
const UP_PATH = path.join(MIGRATIONS_DIR, MIG_UP);
const DOWN_PATH = path.join(MIGRATIONS_DIR, MIG_DOWN);

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
const results = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    results.push({ name, ok: true });
    console.log('  PASS ', name);
  } else {
    fail += 1;
    results.push({ name, ok: false, detail: detail || '' });
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

/** Minimal parent objects so 057 FKs resolve (types match production). */
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

function errCode(e) {
  return e && e.code ? String(e.code) : '';
}

async function expectFail(client, name, sql, params, acceptableCodes) {
  try {
    await client.query(sql, params);
    ok(name, false, 'expected failure, query succeeded');
  } catch (e) {
    const code = errCode(e);
    const okCode = !acceptableCodes || acceptableCodes.includes(code);
    ok(name, okCode, okCode ? `code=${code}` : `unexpected code=${code} msg=${String(e.message).slice(0, 160)}`);
  }
}

async function runBehavioral(client) {
  const clientA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const clientB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  await client.query(
    `INSERT INTO clients (id, slug, name) VALUES ($1, 'tenant-a', 'Tenant A'), ($2, 'tenant-b', 'Tenant B')`,
    [clientA, clientB],
  );

  // Tables empty after migration (proof caller checks counts too).
  const emptyLoc = await client.query('SELECT COUNT(*)::int AS n FROM tenant_locations');
  const emptyEp = await client.query('SELECT COUNT(*)::int AS n FROM tenant_channel_endpoints');
  ok('tables-empty-after-migration', emptyLoc.rows[0].n === 0 && emptyEp.rows[0].n === 0,
    `locations=${emptyLoc.rows[0].n} endpoints=${emptyEp.rows[0].n}`);

  // Valid location insert
  await client.query(
    `INSERT INTO tenant_locations (client_id, location_id, display_name)
     VALUES ($1, 'beach-house', 'Beach House')`,
    [clientA],
  );
  ok('valid-location-insert', true);

  // Malformed / uppercase / space location fails
  await expectFail(
    client,
    'location-uppercase-fails',
    `INSERT INTO tenant_locations (client_id, location_id, display_name) VALUES ($1, 'Beach-House', 'X')`,
    [clientA],
    ['23514', '23505'],
  );
  await expectFail(
    client,
    'location-space-fails',
    `INSERT INTO tenant_locations (client_id, location_id, display_name) VALUES ($1, 'beach house', 'X')`,
    [clientA],
    ['23514'],
  );
  await expectFail(
    client,
    'location-empty-display-fails',
    `INSERT INTO tenant_locations (client_id, location_id, display_name) VALUES ($1, 'other-loc', '   ')`,
    [clientA],
    ['23514'],
  );
  await expectFail(
    client,
    'nonexistent-client-location-fails',
    `INSERT INTO tenant_locations (client_id, location_id, display_name)
     VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'ghost-loc', 'Ghost')`,
    [],
    ['23503'],
  );

  // Location for tenant B with different location_id
  await client.query(
    `INSERT INTO tenant_locations (client_id, location_id, display_name)
     VALUES ($1, 'mountain-camp', 'Mountain Camp')`,
    [clientB],
  );

  const capsJson = JSON.stringify(CAPABILITIES_ALL_FALSE);

  // Valid endpoint insert
  const epIns = await client.query(
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'beach-house', 'microsoft_graph', 'support@example.com',
               'kv:luna-support-email-credentials', $2::jsonb)
     RETURNING inbound_enabled, outbound_enabled, default_automation_mode, active, channel`,
    [clientA, capsJson],
  );
  const row = epIns.rows[0];
  ok('valid-endpoint-insert', true);
  ok('defaults-inbound-false', row.inbound_enabled === false);
  ok('defaults-outbound-false', row.outbound_enabled === false);
  ok('defaults-automation-off', row.default_automation_mode === 'off');
  ok('defaults-active-false', row.active === false);
  ok('defaults-channel-email', row.channel === 'email');

  // Valid secret-ref scheme
  await client.query(
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'beach-house', 'gmail_api', 'alt@example.com',
               'secret-ref:tenant/email-mailbox', $2::jsonb)`,
    [clientA, capsJson],
  );
  ok('valid-secret-ref-scheme-insert', true);

  // Unknown location FK
  await expectFail(
    client,
    'unknown-location-fk-fails',
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'no-such-loc', 'imap_smtp', 'x@example.com', 'kv:safe-ref-label', $2::jsonb)`,
    [clientA, capsJson],
    ['23503'],
  );

  // Cross-tenant: location owned by A cannot be used by B
  await expectFail(
    client,
    'cross-tenant-location-fails',
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'beach-house', 'imap_smtp', 'x2@example.com', 'kv:safe-ref-label', $2::jsonb)`,
    [clientB, capsJson],
    ['23503'],
  );

  // Unknown provider
  await expectFail(
    client,
    'unknown-provider-fails',
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'beach-house', 'sendgrid', 'x3@example.com', 'kv:safe-ref-label', $2::jsonb)`,
    [clientA, capsJson],
    ['23514'],
  );

  // Capabilities missing key
  const missingCaps = { ...CAPABILITIES_ALL_FALSE };
  delete missingCaps.reply;
  await expectFail(
    client,
    'capabilities-missing-key-fails',
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'beach-house', 'imap_smtp', 'x4@example.com', 'kv:safe-ref-label', $2::jsonb)`,
    [clientA, JSON.stringify(missingCaps)],
    ['23514'],
  );

  // Capabilities extra key
  const extraCaps = { ...CAPABILITIES_ALL_FALSE, extra_flag: true };
  await expectFail(
    client,
    'capabilities-extra-key-fails',
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'beach-house', 'imap_smtp', 'x5@example.com', 'kv:safe-ref-label', $2::jsonb)`,
    [clientA, JSON.stringify(extraCaps)],
    ['23514'],
  );

  // Capabilities non-boolean
  const nonBool = { ...CAPABILITIES_ALL_FALSE, reply: 'yes' };
  await expectFail(
    client,
    'capabilities-non-boolean-fails',
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'beach-house', 'imap_smtp', 'x6@example.com', 'kv:safe-ref-label', $2::jsonb)`,
    [clientA, JSON.stringify(nonBool)],
    ['23514'],
  );

  // Raw / bad scheme / whitespace secret refs
  await expectFail(
    client,
    'secret-ref-raw-fails',
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'beach-house', 'imap_smtp', 'x7@example.com', 'sk-abcdefghijklmnop', $2::jsonb)`,
    [clientA, capsJson],
    ['23514'],
  );
  await expectFail(
    client,
    'secret-ref-bad-scheme-fails',
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'beach-house', 'imap_smtp', 'x8@example.com', 'vault:some-path', $2::jsonb)`,
    [clientA, capsJson],
    ['23514'],
  );
  await expectFail(
    client,
    'secret-ref-whitespace-fails',
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'beach-house', 'imap_smtp', 'x9@example.com', 'kv:has space', $2::jsonb)`,
    [clientA, capsJson],
    ['23514'],
  );
  await expectFail(
    client,
    'secret-ref-sk-body-fails',
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'beach-house', 'imap_smtp', 'x10@example.com', 'kv:sk-abcdefghijklmnop', $2::jsonb)`,
    [clientA, capsJson],
    ['23514'],
  );

  // Uppercase / untrimmed public addresses fail (no silent normalize)
  await expectFail(
    client,
    'public-address-uppercase-fails',
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'beach-house', 'imap_smtp', 'Support@Example.COM', 'kv:safe-ref-label', $2::jsonb)`,
    [clientA, capsJson],
    ['23514'],
  );
  await expectFail(
    client,
    'public-address-untrimmed-fails',
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities
     ) VALUES ($1, 'beach-house', 'imap_smtp', '  support2@example.com  ', 'kv:safe-ref-label', $2::jsonb)`,
    [clientA, capsJson],
    ['23514'],
  );

  // Active address uniqueness: inactive duplicates may coexist
  await client.query(
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities, active
     ) VALUES
       ($1, 'beach-house', 'imap_smtp', 'shared@example.com', 'kv:safe-ref-one', $2::jsonb, false),
       ($1, 'beach-house', 'gmail_api', 'shared@example.com', 'kv:safe-ref-two', $2::jsonb, false)`,
    [clientA, capsJson],
  );
  ok('inactive-duplicate-address-allowed', true);

  // Activate first shared address
  const act1 = await client.query(
    `UPDATE tenant_channel_endpoints SET active = true
     WHERE public_address = 'shared@example.com' AND secret_ref = 'kv:safe-ref-one'
     RETURNING id`,
  );
  ok('activate-first-shared-address', act1.rowCount === 1);

  // Second active with same address fails globally
  await expectFail(
    client,
    'duplicate-active-address-fails',
    `UPDATE tenant_channel_endpoints SET active = true
     WHERE public_address = 'shared@example.com' AND secret_ref = 'kv:safe-ref-two'`,
    [],
    ['23505'],
  );

  // Deactivate first, activate second — uniqueness follows activation
  await client.query(
    `UPDATE tenant_channel_endpoints SET active = false
     WHERE public_address = 'shared@example.com' AND secret_ref = 'kv:safe-ref-one'`,
  );
  await client.query(
    `UPDATE tenant_channel_endpoints SET active = true
     WHERE public_address = 'shared@example.com' AND secret_ref = 'kv:safe-ref-two'`,
  );
  ok('activation-after-deactivation-ok', true);

  // Cross-tenant global uniqueness of active address
  await client.query(
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities, active
     ) VALUES ($1, 'mountain-camp', 'imap_smtp', 'global-unique@example.com', 'kv:tenant-b-ref', $2::jsonb, true)`,
    [clientB, capsJson],
  );
  await expectFail(
    client,
    'active-address-globally-unique-across-tenants',
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities, active
     ) VALUES ($1, 'beach-house', 'imap_smtp', 'global-unique@example.com', 'kv:tenant-a-ref', $2::jsonb, true)`,
    [clientA, capsJson],
    ['23505'],
  );

  // DELETE RESTRICT on referenced location (23503 FK or 23001 restrict_violation)
  await expectFail(
    client,
    'delete-referenced-location-restricted',
    `DELETE FROM tenant_locations WHERE client_id = $1 AND location_id = 'beach-house'`,
    [clientA],
    ['23503', '23001'],
  );

  // DELETE RESTRICT on referenced client
  await expectFail(
    client,
    'delete-referenced-client-restricted',
    `DELETE FROM clients WHERE id = $1`,
    [clientA],
    ['23503', '23001'],
  );

  // Secret-ref parity: values Slice 1A rejects must also fail the DB CHECK.
  // DB may be stricter than 1A; it must never accept the shared adversarial corpus.
  const {
    validateEmailMailboxSecretRef,
  } = require(path.join(ROOT, 'scripts/lib/email-mailbox-adapter-contract.js'));
  const adversarialSecretRefs = [
    ['raw-sk', 'sk-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['unknown-scheme-vault', 'vault:email/mailbox/support'],
    ['whitespace-body', 'kv:has space'],
    ['kv-sk-body', 'kv:sk-abcdefghijklmnopqrstuvwxyz123456'],
    ['kv-password-prefix', 'kv:password-hunter2'],
    ['secret-ref-ya29', 'secret-ref:ya29.a0AfH6SMCrawOAuthToken'],
    ['kv-jwt-shaped', 'kv:eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.signature'],
    ['kv-bearer', 'kv:Bearer.eyJhbGciOiJIUzI1NiIs.payload.sig'],
    ['kv-api-key', 'kv:api_key=super-secret-api-key-value'],
    ['secret-ref-client-secret', 'secret-ref:client_secret=super-secret-value'],
    ['kv-password-eq', 'kv:password=hunter2'],
  ];
  let parityOk = true;
  for (const [label, secretRef] of adversarialSecretRefs) {
    const app = validateEmailMailboxSecretRef(secretRef);
    if (!app || app.ok !== false) {
      ok(`secret-ref-parity-app-rejects-${label}`, false, '1A unexpectedly accepted');
      parityOk = false;
      continue;
    }
    try {
      await client.query(
        `INSERT INTO tenant_channel_endpoints (
           client_id, location_id, provider, public_address, secret_ref, capabilities
         ) VALUES ($1, 'beach-house', 'imap_smtp', $2, $3, $4::jsonb)`,
        [clientA, `parity-${label}@example.com`, secretRef, capsJson],
      );
      ok(`secret-ref-parity-db-rejects-${label}`, false, 'DB accepted value 1A rejects');
      parityOk = false;
    } catch (e) {
      const code = errCode(e);
      const rejected = code === '23514' || code === '23505';
      if (!rejected) {
        ok(`secret-ref-parity-db-rejects-${label}`, false, `unexpected code=${code}`);
        parityOk = false;
      }
    }
  }
  ok('secret-ref-parity-db-never-accepts-1a-rejects', parityOk);
}

async function assertObjectsAbsent(client) {
  const tables = await client.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('tenant_locations', 'tenant_channel_endpoints')
  `);
  ok('down-removes-both-tables', tables.rowCount === 0, `still=${tables.rows.map((r) => r.tablename).join(',')}`);
}

async function main() {
  console.log('prove:email-tenant-location-registry-pg — Slice 1B ephemeral PG\n');

  if (!fs.existsSync(UP_PATH) || !fs.existsSync(DOWN_PATH)) {
    console.error('BLOCKER: migration 057 up/down SQL missing — implement migration first (TDD RED).');
    ok('migration-files-present', false, '057 up/down missing');
    console.log(`\n── prove:email-tenant-location-registry-pg FAILED (${pass} pass, ${fail} fail) ──`);
    process.exit(1);
  }

  const dockerOk = dockerAvailable();
  console.log(`  info  docker_available=${dockerOk}`);

  let cleanup = () => {};
  try {
    const harness = await startDisposablePostgresHarness();
    cleanup = harness.cleanup;
    console.log(`  info  backend=${harness.backend}`);

    await waitForPg(harness.admin, 80);

    const suffix = crypto.randomBytes(4).toString('hex');
    const dbName = `wh_mig_email1b_${suffix}`;
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

    // Empty after apply (no invented DML in migration)
    const c1 = await client.query('SELECT COUNT(*)::int AS n FROM tenant_locations');
    const c2 = await client.query('SELECT COUNT(*)::int AS n FROM tenant_channel_endpoints');
    ok('zero-rows-after-apply', c1.rows[0].n === 0 && c2.rows[0].n === 0);

    await runBehavioral(client);

    // Explicit: no async PG locationAuthority bridge in this slice.
    const authorityPath = path.join(ROOT, 'scripts/lib/email-tenant-location-authority-pg.js');
    ok(
      'authority-adapter-not-shipped',
      !fs.existsSync(authorityPath),
      'Slice 1B defers async PG→1A authority; composite FK owns integrity',
    );

    // Down migration removes only these objects; must be idempotent for recovery.
    await applySqlFile(client, DOWN_PATH);
    ok('down-migration-applies', true);
    await assertObjectsAbsent(client);

    // Second down on already-rolled-back state must also succeed (partial recovery).
    await applySqlFile(client, DOWN_PATH);
    ok('down-migration-second-applies', true);
    await assertObjectsAbsent(client);

    // Parents and shared helpers remain (do not drop set_updated_at / clients / staff_users)
    const clientsLeft = await client.query(`SELECT COUNT(*)::int AS n FROM clients`);
    ok('down-preserves-clients', clientsLeft.rows[0].n >= 2);
    const staffTable = await client.query(`
      SELECT 1 FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'staff_users'
    `);
    ok('down-preserves-staff-users-table', staffTable.rowCount === 1);
    const setUpdatedAt = await client.query(`
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'set_updated_at'
    `);
    ok('down-preserves-set-updated-at', setUpdatedAt.rowCount >= 1);

    // Re-apply 057 on same DB after double-down — still empty
    await applySqlFile(client, UP_PATH);
    const r1 = await client.query('SELECT COUNT(*)::int AS n FROM tenant_locations');
    const r2 = await client.query('SELECT COUNT(*)::int AS n FROM tenant_channel_endpoints');
    ok('reapply-still-empty', r1.rows[0].n === 0 && r2.rows[0].n === 0);

    // Manifest registration spot-check (offline too, but prove file presence in chain)
    const manifest = loadManifest(MANIFEST_PATH);
    const forward = forwardEntries(manifest);
    const entry = forward.find((e) => e.filename === MIG_UP);
    ok('manifest-forward-includes-057', Boolean(entry && entry.order === 55));
    if (entry) {
      ok('manifest-sha-matches-up-file', entry.sha256 === sha256CanonicalLfV1File(UP_PATH));
    }

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

  console.log(`\n── prove:email-tenant-location-registry-pg ${fail ? 'FAILED' : 'PASSED'} (${pass} pass, ${fail} fail) ──`);
  if (!dockerAvailable()) {
    console.log('  note  Docker daemon unavailable; used/attempted PGlite disposable fallback when packages present.');
    console.log('  note  PGlite is acceptable here; prove on stock PostgreSQL before deploy.');
  } else {
    console.log('  note  Disposable harness used; stock PostgreSQL still required before deploy.');
  }
  process.exit(fail > 0 ? 1 : 0);
}

main();
