'use strict';
/**
 * prove:email-channel-endpoint-identity-pg — Slice 2D disposable PG proof.
 * Docker preferred; PGlite fallback. No live Microsoft. Sequential ownership
 * 23505 only (not concurrent race). Stock-PG concurrent loser/blocking is a
 * remaining pre-deploy proof when Docker unavailable / PGlite-only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const {
  MIGRATIONS_DIR, prepareMigrationBody, assertSafeDatabaseTarget,
  sha256CanonicalLfV1File, loadManifest, MANIFEST_PATH,
} = require('./lib/migration-integrity');
const { startDisposablePostgresHarness, dockerAvailable } = require('./lib/disposable-postgres-harness');

const UP057 = '057_tenant_locations_and_channel_endpoints.sql';
const UP058 = '058_tenant_channel_endpoint_identity.sql';
const DOWN058 = '058_tenant_channel_endpoint_identity_down.sql';
const CAPS = {
  push_notifications: false, provider_threads: false, remote_drafts: false,
  reply: false, reply_all: false, forward: false,
  attachments_metadata: false, delivery_events: false,
};
const TID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TID2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CAPS_J = JSON.stringify(CAPS);

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name, detail ? `— ${detail}` : ''); }
}

const PARENT_DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS staff_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE, email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;

async function waitForPg(connection, attempts) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    const client = new Client({ ...connection, connectionTimeoutMillis: 2000 });
    try {
      await client.connect(); await client.query('SELECT 1'); await client.end(); return;
    } catch (e) {
      last = e; try { await client.end(); } catch (_) { /* */ }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw last || new Error('postgres never ready');
}

async function applySqlFile(client, filePath) {
  const prepared = prepareMigrationBody(fs.readFileSync(filePath, 'utf8'));
  if (!prepared.ok || !prepared.body) throw new Error(`prepare failed: ${prepared.message || prepared.code}`);
  await client.query(prepared.body);
}

async function expectCheckFail(client, sql, params, label) {
  try {
    await client.query(sql, params);
    ok(label, false, 'expected CHECK/unique failure');
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    ok(label, code === '23514' || code === '23505' || code === '23502', `code=${code}`);
  }
}

const DEL_INS = `INSERT INTO tenant_channel_endpoints (
  client_id, location_id, provider, public_address, secret_ref, capabilities,
  auth_mode, connector_mode, provider_tenant_id, provider_principal_oid,
  provider_resource_id, mailbox_kind, mailbox_access_kind, binding_status,
  created_by, updated_by
) VALUES ($1,$2,'microsoft_graph',$3,$4,$5::jsonb,
  'delegated_authorization_code','microsoft_delegated_oauth',$6,$7,
  $8,'user','own_user',$9,$10,$10)`;

async function expectUniqueFail(client, params, label) {
  try {
    await client.query(DEL_INS, params);
    ok(label, false, 'expected unique violation');
  } catch (e) {
    ok(label, e && e.code === '23505', `code=${e && e.code}`);
  }
}

async function runProof(client) {
  const clientId = crypto.randomUUID();
  const actor = crypto.randomUUID();
  await client.query(`INSERT INTO clients (id, slug, name) VALUES ($1,'t2d','T2D')`, [clientId]);
  await client.query(
    `INSERT INTO staff_users (id, client_id, email) VALUES ($1,$2,'a@t.test')`,
    [actor, clientId],
  );
  await client.query(
    `INSERT INTO tenant_locations (client_id, location_id, display_name, created_by, updated_by)
     VALUES ($1,'main','Main',$2,$2)`,
    [clientId, actor],
  );

  const ins = await client.query(
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref,
       provider_resource_id, capabilities, created_by, updated_by
     ) VALUES ($1,'main','microsoft_graph','legacy@example.com','kv:legacy-ref',
       NULL,$2::jsonb,$3,$3)
     RETURNING auth_mode, connector_mode, provider_tenant_id,
       provider_principal_oid, mailbox_kind, mailbox_access_kind, binding_status`,
    [clientId, CAPS_J, actor],
  );
  const leg = ins.rows[0];
  ok('legacy-row-seven-identity-null',
    leg.auth_mode == null && leg.connector_mode == null
    && leg.provider_tenant_id == null && leg.provider_principal_oid == null
    && leg.mailbox_kind == null && leg.mailbox_access_kind == null
    && leg.binding_status == null);

  await client.query(
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref,
       capabilities, created_by, updated_by
     ) VALUES ($1,'main','gmail_api','g@example.com','kv:g-ref',$2::jsonb,$3,$3)`,
    [clientId, CAPS_J, actor],
  );
  ok('gmail-insert-ok', true);

  await expectCheckFail(client,
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities,
       auth_mode, connector_mode, created_by, updated_by
     ) VALUES ($1,'main','gmail_api','g2@example.com','kv:g2',$2::jsonb,
       'delegated_authorization_code','microsoft_delegated_oauth',$3,$3)`,
    [clientId, CAPS_J, actor], 'hostile-gmail-modes-check');

  await expectCheckFail(client,
    `UPDATE tenant_channel_endpoints SET auth_mode='delegated_authorization_code'
     WHERE public_address='legacy@example.com'`,
    [], 'hostile-half-pair-check');

  await expectCheckFail(client,
    `UPDATE tenant_channel_endpoints SET
       auth_mode='delegated_authorization_code',
       connector_mode='microsoft_delegated_oauth',
       provider_tenant_id='AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
       binding_status='unverified_offline'
     WHERE public_address='legacy@example.com'`,
    [], 'hostile-uuid-upper-check');

  // Malformed provider_resource_id CHECK probes (every-status partials)
  for (const [rid, st, lab] of [
    ['', 'unverified_offline', 'hostile-resource-empty-check'],
    ['   ', 'pending_manual_validation', 'hostile-resource-whitespace-check'],
    [' untrimmed ', 'revoked', 'hostile-resource-untrimmed-check'],
  ]) {
    await expectCheckFail(client,
      `UPDATE tenant_channel_endpoints SET
         auth_mode='delegated_authorization_code',
         connector_mode='microsoft_delegated_oauth',
         provider_resource_id=$1, binding_status=$2
       WHERE public_address='legacy@example.com'`,
      [rid, st], lab);
  }

  await client.query(
    `UPDATE tenant_channel_endpoints SET
       auth_mode='delegated_authorization_code',
       connector_mode='microsoft_delegated_oauth',
       provider_tenant_id=$1, provider_principal_oid=$2,
       provider_resource_id='mailbox-res-1', mailbox_kind='user',
       mailbox_access_kind='own_user', binding_status='verified'
     WHERE public_address='legacy@example.com'`,
    [TID, OID],
  );
  ok('verified-delegated-update', true);

  // Sequential ownership 23505 (not concurrent race)
  const clientB = crypto.randomUUID();
  await client.query(`INSERT INTO clients (id, slug, name) VALUES ($1,'t2db','T2DB')`, [clientB]);
  await client.query(
    `INSERT INTO tenant_locations (client_id, location_id, display_name) VALUES ($1,'main-b','Main B')`,
    [clientB],
  );
  await expectUniqueFail(client,
    [clientB, 'main-b', 'other@example.com', 'kv:other', CAPS_J, TID, OID, 'mailbox-res-1', 'verified', actor],
    'sequential-ownership-23505');

  await client.query(
    `UPDATE tenant_channel_endpoints SET binding_status='reauthorization_required'
     WHERE public_address='legacy@example.com'`,
  );
  await expectUniqueFail(client,
    [clientB, 'main-b', 'steal@example.com', 'kv:steal', CAPS_J, TID, OID, 'mailbox-res-1', 'verified', actor],
    'reauth-reserves-ownership');

  await client.query(
    `UPDATE tenant_channel_endpoints SET provider_resource_id='mailbox-res-2',
       binding_status='verified', provider_tenant_id=$1
     WHERE public_address='legacy@example.com'`,
    [TID2],
  );
  const row = await client.query(
    `SELECT provider_resource_id, binding_status FROM tenant_channel_endpoints
     WHERE public_address='legacy@example.com'`,
  );
  ok('same-row-reconnect-update',
    row.rows[0].provider_resource_id === 'mailbox-res-2'
    && row.rows[0].binding_status === 'verified');

  await client.query(
    `INSERT INTO tenant_channel_endpoints (
       client_id, location_id, provider, public_address, secret_ref, capabilities,
       auth_mode, connector_mode, provider_tenant_id, provider_principal_oid,
       provider_resource_id, mailbox_kind, mailbox_access_kind, binding_status,
       created_by, updated_by
     ) VALUES (
       $1,'main','microsoft_graph','app@example.com','kv:app',$2::jsonb,
       'application_client_credentials','microsoft_app_only_enterprise',$3,NULL,
       'app-res-1','user','application','verified',$4,$4
     )`,
    [clientId, CAPS_J, TID, actor],
  );
  ok('app-only-verified-insert', true);
  await expectCheckFail(client,
    `UPDATE tenant_channel_endpoints SET provider_principal_oid=$1
     WHERE public_address='app@example.com'`,
    [OID], 'hostile-app-only-principal-check');

  // COLLATE "C" case-sensitive: differing case is distinct; exact case → 23505
  await client.query(DEL_INS,
    [clientId, 'main', 'case-a@example.com', 'kv:case-a', CAPS_J, TID, OID, 'Mailbox-Res-Case', 'verified', actor]);
  await client.query(DEL_INS,
    [clientId, 'main', 'case-b@example.com', 'kv:case-b', CAPS_J, TID, OID, 'mailbox-res-case', 'verified', actor]);
  ok('collate-c-case-sensitive-distinct', true);
  await expectUniqueFail(client,
    [clientB, 'main-b', 'case-dup@example.com', 'kv:case-dup', CAPS_J, TID, OID, 'Mailbox-Res-Case', 'verified', actor],
    'collate-c-exact-case-23505');

  await applySqlFile(client, path.join(MIGRATIONS_DIR, DOWN058));
  const colsAfterDown = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='tenant_channel_endpoints' AND column_name='auth_mode'`,
  );
  ok('down-drops-auth-mode', colsAfterDown.rows.length === 0);
  await applySqlFile(client, path.join(MIGRATIONS_DIR, UP058));
  const colsAfterUp = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='tenant_channel_endpoints' AND column_name='binding_status'`,
  );
  ok('reapply-restores-binding-status', colsAfterUp.rows.length === 1);

  const man = loadManifest(MANIFEST_PATH);
  const ent = man.entries.find((e) => e.filename === UP058);
  const live = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, UP058));
  ok('manifest-sha-matches-file', ent && ent.sha256 === live && ent.order === 56);
}

async function main() {
  console.log('prove:email-channel-endpoint-identity-pg — Slice 2D\n');
  let harness;
  try {
    harness = await startDisposablePostgresHarness();
  } catch (e) {
    console.error('PG_PROOF_BLOCKER:', e && e.message ? e.message : e);
    console.error('dockerAvailable=', dockerAvailable());
    console.error('Strongest structural proof: verify:email-channel-endpoint-identity (no live PG).');
    process.exit(2);
  }
  const dbName = `wh_mig_2d_${crypto.randomBytes(4).toString('hex')}`;
  const admin = harness.admin;
  const safety = assertSafeDatabaseTarget({ ...admin, database: dbName });
  if (!safety.ok) {
    console.error('PG_PROOF_BLOCKER: non-disposable target', safety.errors);
    if (harness.cleanup) await harness.cleanup();
    process.exit(2);
  }
  let client;
  try {
    await waitForPg(admin, 40);
    const adminClient = new Client(admin);
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE ${dbName}`);
    await adminClient.end();
    client = new Client({ ...admin, database: dbName });
    await client.connect();
    await client.query(PARENT_DDL);
    await applySqlFile(client, path.join(MIGRATIONS_DIR, UP057));
    await applySqlFile(client, path.join(MIGRATIONS_DIR, UP058));
    ok('apply-057-058', true);
    await runProof(client);
  } catch (e) {
    console.error('PG_PROOF_ERROR:', e && e.stack ? e.stack : e);
    fail += 1;
  } finally {
    if (client) try { await client.end(); } catch (_) { /* */ }
    if (harness && harness.cleanup) {
      try { await harness.cleanup(); } catch (e) {
        console.error('cleanup error', e && e.message);
      }
    }
  }
  const backend = harness && harness.backend;
  console.log(`\nbackend=${backend} ${pass} passed, ${fail} failed`);
  if (backend === 'pglite' || !dockerAvailable()) {
    console.log('  note  stock-PG concurrent transaction loser/blocking: UNEXECUTED');
    console.log('  note  (Docker daemon unavailable; PGlite single-process/in-memory).');
    console.log('  note  Unique index structurally correct; concurrency-safe by PostgreSQL semantics.');
    console.log('  note  Remaining pre-deploy proof: real concurrent TX on stock PostgreSQL.');
  }
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
