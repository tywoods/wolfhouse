'use strict';

/**
 * prove:email-delegated-grant-custody-pg — Slice 2F-A disposable PG structural proof.
 * Docker preferred; PGlite sequential fallback. Concurrent fencing needs stock PG
 * (UNEXECUTED when unavailable). No live Microsoft/Azure/secrets.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  MIGRATIONS_DIR, prepareMigrationBody, assertSafeDatabaseTarget,
  sha256CanonicalLfV1File, loadManifest,
} = require('./lib/migration-integrity');

const UP057 = '057_tenant_locations_and_channel_endpoints.sql';
const UP058 = '058_tenant_channel_endpoint_identity.sql';
const UP059 = '059_tenant_email_delegated_grants.sql';
const DOWN059 = '059_tenant_email_delegated_grants_down.sql';
const UP073 = '073_tenant_channel_endpoint_google_identity.sql';
const UP074 = '074_tenant_email_delegated_grants_google_mode_guard.sql';
const DOWN074 = '074_tenant_email_delegated_grants_google_mode_guard_down.sql';

const CAPS = {
  push_notifications: false, provider_threads: false, remote_drafts: false,
  reply: false, reply_all: false, forward: false,
  attachments_metadata: false, delivery_events: false,
};
const CAPS_J = JSON.stringify(CAPS);
const TID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const SQL_INSERT_GRANT = `INSERT INTO tenant_email_delegated_grants (
  client_id, endpoint_id, grant_generation, grant_status, last_operation_id,
  envelope_version, aead_alg, kek_wrap_alg, kek_key_name, kek_key_version,
  nonce, ciphertext, auth_tag, wrapped_dek
) VALUES ($1,$2,1,'active',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;

let pass = 0;
let fail = 0;
let unexec = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name, detail ? `— ${detail}` : ''); }
}
function unexecuted(name, reason) {
  unexec += 1;
  console.log('  UNEXECUTED ', name, '—', reason);
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

async function waitForPg(Client, connection, attempts) {
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

async function expectFail(client, sql, params, label) {
  try {
    await client.query(sql, params);
    ok(label, false, 'expected failure');
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    ok(label, code === '23514' || code === '23505' || code === '23503' || code === '23502',
      `code=${code}`);
  }
}

function envelopeParams() {
  return {
    envelope_version: 'v1', aead_alg: 'AES-256-GCM', kek_wrap_alg: 'A256KW',
    kek_key_name: 'test-kek', kek_key_version: 'ver-001',
    nonce: crypto.randomBytes(12), ciphertext: crypto.randomBytes(24),
    auth_tag: crypto.randomBytes(16), wrapped_dek: crypto.randomBytes(48),
    last_operation_id: crypto.randomUUID(),
  };
}

function grantArgs(clientId, endpointId, env) {
  return [
    clientId, endpointId, env.last_operation_id,
    env.envelope_version, env.aead_alg, env.kek_wrap_alg, env.kek_key_name, env.kek_key_version,
    env.nonce, env.ciphertext, env.auth_tag, env.wrapped_dek,
  ];
}

function miniEnv(clientId, endpointId) {
  return grantArgs(clientId, endpointId, {
    last_operation_id: crypto.randomUUID(),
    envelope_version: 'v1', aead_alg: 'AES-256-GCM', kek_wrap_alg: 'A256KW',
    kek_key_name: 'k', kek_key_version: 'v2',
    nonce: crypto.randomBytes(12), ciphertext: crypto.randomBytes(8),
    auth_tag: crypto.randomBytes(16), wrapped_dek: crypto.randomBytes(32),
  });
}

async function insertEndpointFixed(client, opts) {
  const {
    clientId, endpointId, locationId, address, provider,
    authMode, connectorMode, bindingStatus, resourceId,
  } = opts;
  await client.query(
    `INSERT INTO tenant_channel_endpoints (
       id, client_id, location_id, channel, provider, public_address, secret_ref,
       capabilities, inbound_enabled, outbound_enabled, default_automation_mode, active,
       auth_mode, connector_mode, provider_tenant_id, provider_principal_oid,
       mailbox_kind, mailbox_access_kind, binding_status, provider_resource_id
     ) VALUES (
       $1,$2,$3,'email',$4,$5,'secret-ref:luna/email/test/custody-label',
       $6::jsonb,false,false,'off',false,
       $7,$8,$9,$10,$11,$12,$13,$14
     )`,
    [
      endpointId, clientId, locationId, provider, address, CAPS_J,
      authMode, connectorMode,
      provider === 'gmail_api' && authMode ? 'https://accounts.google.com' : (authMode ? TID : null),
      provider === 'gmail_api' && authMode ? (resourceId || null)
        : (authMode === 'delegated_authorization_code' ? OID : null),
      authMode ? 'user' : null,
      authMode === 'delegated_authorization_code' ? 'own_user'
        : (authMode === 'application_client_credentials' ? 'application' : null),
      bindingStatus, resourceId || null,
    ],
  );
}

async function insertGrant(client, clientId, endpointId, env) {
  await client.query(SQL_INSERT_GRANT, grantArgs(clientId, endpointId, env));
}

async function applySchema(client) {
  await client.query(PARENT_DDL);
  await applySqlFile(client, path.join(MIGRATIONS_DIR, UP057));
  await applySqlFile(client, path.join(MIGRATIONS_DIR, UP058));
  await applySqlFile(client, path.join(MIGRATIONS_DIR, UP059));
  await applySqlFile(client, path.join(MIGRATIONS_DIR, UP073));
  await applySqlFile(client, path.join(MIGRATIONS_DIR, UP074));
}

async function runSequentialProofs(Client, connection, backend) {
  console.log(`\nSequential proofs (${backend})`);
  const client = new Client(connection);
  await client.connect();
  try {
    await applySchema(client);
    ok('P1a apply 057+058+059+073+074', true);

    const man = loadManifest();
    const entry = man.entries.find((e) => e.filename === UP074);
    const hash = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, UP074));
    ok('P1b manifest sha256 matches 074', entry && entry.sha256 === hash, hash);

    const clientA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const clientB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await client.query(
      `INSERT INTO clients (id, slug, name) VALUES ($1,'client-a','A'), ($2,'client-b','B')`,
      [clientA, clientB],
    );
    await client.query(
      `INSERT INTO tenant_locations (client_id, location_id, display_name)
       VALUES ($1,'client-a-loc','A Loc'), ($2,'client-b-loc','B Loc')`,
      [clientA, clientB],
    );

    const epDelegated = crypto.randomUUID();
    const epAppOnly = crypto.randomUUID();
    const epGmail = crypto.randomUUID();
    const epB = crypto.randomUUID();

    const endpoints = [
      {
        clientId: clientA, endpointId: epDelegated, locationId: 'client-a-loc',
        address: 'delegated@example.com', provider: 'microsoft_graph',
        authMode: 'delegated_authorization_code', connectorMode: 'microsoft_delegated_oauth',
        bindingStatus: 'verified', resourceId: OID,
      },
      {
        clientId: clientA, endpointId: epAppOnly, locationId: 'client-a-loc',
        address: 'apponly@example.com', provider: 'microsoft_graph',
        authMode: 'application_client_credentials', connectorMode: 'microsoft_app_only_enterprise',
        bindingStatus: 'verified', resourceId: 'app-res-1',
      },
      {
        clientId: clientA, endpointId: epGmail, locationId: 'client-a-loc',
        address: 'gmail@example.com', provider: 'gmail_api',
        authMode: 'delegated_authorization_code', connectorMode: 'google_delegated_oauth',
        bindingStatus: 'verified', resourceId: 'Google-Sub_123:CaseSensitive',
      },
      {
        clientId: clientB, endpointId: epB, locationId: 'client-b-loc',
        address: 'b-delegated@example.com', provider: 'microsoft_graph',
        authMode: 'delegated_authorization_code', connectorMode: 'microsoft_delegated_oauth',
        bindingStatus: 'verified', resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
    ];
    for (const ep of endpoints) await insertEndpointFixed(client, ep);

    const env = envelopeParams();
    await expectFail(client, SQL_INSERT_GRANT, grantArgs(clientA, epAppOnly, env),
      'P2 app-only grant rejected by trigger');
    await insertGrant(client, clientA, epGmail, envelopeParams());
    ok('P2b exact Gmail delegated grant accepted', true);
    await client.query(
      `UPDATE tenant_channel_endpoints
          SET binding_status=binding_status, provider_resource_id=provider_resource_id
        WHERE id=$1`,
      [epGmail],
    );
    ok('P2c Gmail no-op identity update under grant accepted', true);
    await expectFail(client,
      `UPDATE tenant_channel_endpoints SET provider_resource_id='hostile-different-sub' WHERE id=$1`,
      [epGmail], 'P2d Gmail identity mutation under grant rejected');
    await expectFail(client,
      `UPDATE tenant_channel_endpoints
          SET client_id=$2, location_id='client-b-loc'
        WHERE id=$1`,
      [epGmail, clientB], 'P2e Gmail client ownership transfer under grant rejected');
    const ownerRows = await client.query(
      `SELECT e.client_id AS endpoint_client_id, g.client_id AS grant_client_id
         FROM tenant_channel_endpoints e
         JOIN tenant_email_delegated_grants g ON g.endpoint_id=e.id
        WHERE e.id=$1`,
      [epGmail],
    );
    ok('P2f failed transfer preserves endpoint and grant owner',
      ownerRows.rows.length === 1
        && ownerRows.rows[0].endpoint_client_id === clientA
        && ownerRows.rows[0].grant_client_id === clientA);
    await expectFail(client, prepareMigrationBody(fs.readFileSync(path.join(MIGRATIONS_DIR, DOWN074), 'utf8')).body,
      [], 'P2g 074 rollback refuses while Gmail grant exists');
    await client.query('ROLLBACK');
    await client.query('DELETE FROM tenant_email_delegated_grants WHERE endpoint_id=$1', [epGmail]);
    await applySqlFile(client, path.join(MIGRATIONS_DIR, DOWN074));
    await expectFail(client, SQL_INSERT_GRANT, miniEnv(clientA, epGmail),
      'P2h clean rollback restores Microsoft-only guard');
    await applySqlFile(client, path.join(MIGRATIONS_DIR, UP074));
    await insertGrant(client, clientA, epGmail, envelopeParams());
    ok('P2i 074 reapplies and accepts exact Gmail grant', true);

    await insertGrant(client, clientA, epDelegated, env);
    ok('P3a delegated grant insert ok', true);

    await expectFail(client, SQL_INSERT_GRANT, miniEnv(clientA, epDelegated),
      'P3b second grant same endpoint unique fail');
    await expectFail(client, SQL_INSERT_GRANT, miniEnv(clientB, epDelegated),
      'P4 cross-client endpoint grant rejected');

    const envFails = [
      ['P5 bad nonce length',
        `UPDATE tenant_email_delegated_grants SET nonce = $1 WHERE endpoint_id = $2`,
        [crypto.randomBytes(11), epDelegated]],
      ['P5b kek_key_version latest rejected',
        `UPDATE tenant_email_delegated_grants SET kek_key_version = 'latest' WHERE endpoint_id = $1`,
        [epDelegated]],
      ['P5c wrong aead rejected',
        `UPDATE tenant_email_delegated_grants SET aead_alg = 'AES-128-GCM' WHERE endpoint_id = $1`,
        [epDelegated]],
      ['P6 partial lease rejected',
        `UPDATE tenant_email_delegated_grants
            SET grant_lease_owner = 'w', grant_lease_token = NULL, grant_status = 'lease_held'
          WHERE endpoint_id = $1`,
        [epDelegated]],
      ['P6b terminal+lease rejected',
        `UPDATE tenant_email_delegated_grants
            SET grant_status = 'reauthorization_required',
                grant_lease_owner = 'w', grant_lease_token = $2::uuid,
                grant_lease_until = clock_timestamp() + interval '1 minute'
          WHERE endpoint_id = $1`,
        [epDelegated, crypto.randomUUID()]],
    ];
    for (const [label, sql, params] of envFails) {
      await expectFail(client, sql, params, label);
    }

    const leaseTok = crypto.randomUUID();
    await client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_status = 'lease_held', grant_lease_owner = 'worker-a',
              grant_lease_token = $2::uuid,
              grant_lease_until = clock_timestamp() + interval '2 minutes'
        WHERE endpoint_id = $1`,
      [epDelegated, leaseTok],
    );
    ok('P9a set unexpired lease', true);

    const cas = await client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_generation = 2, grant_status = 'active',
              grant_lease_owner = NULL, grant_lease_token = NULL, grant_lease_until = NULL
        WHERE endpoint_id = $1 AND grant_generation = 1
          AND grant_lease_token = $2::uuid AND grant_lease_until > clock_timestamp()
        RETURNING grant_generation`,
      [epDelegated, crypto.randomUUID()],
    );
    ok('P8 wrong lease_token updates 0', cas.rowCount === 0);

    const casOk = await client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_generation = 2, grant_status = 'active',
              grant_lease_owner = NULL, grant_lease_token = NULL, grant_lease_until = NULL,
              last_operation_id = $2::uuid
        WHERE endpoint_id = $1 AND grant_generation = 1
          AND grant_lease_token = $3::uuid AND grant_lease_until > clock_timestamp()
        RETURNING grant_generation`,
      [epDelegated, crypto.randomUUID(), leaseTok],
    );
    ok('P8b correct CAS advances generation', casOk.rowCount === 1
      && Number(casOk.rows[0].grant_generation) === 2);

    await client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_status = 'lease_held', grant_lease_owner = 'worker-old',
              grant_lease_token = $2::uuid,
              grant_lease_until = clock_timestamp() - interval '1 second'
        WHERE endpoint_id = $1`,
      [epDelegated, crypto.randomUUID()],
    );
    const steal = await client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_lease_owner = 'worker-new', grant_lease_token = $2::uuid,
              grant_lease_until = clock_timestamp() + interval '1 minute'
        WHERE endpoint_id = $1 AND grant_status = 'lease_held'
          AND grant_lease_until < clock_timestamp()
        RETURNING grant_lease_owner`,
      [epDelegated, crypto.randomUUID()],
    );
    ok('P9 expired lease stealable via clock_timestamp', steal.rowCount === 1
      && steal.rows[0].grant_lease_owner === 'worker-new');

    await client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_status = 'reauthorization_required',
              grant_lease_owner = NULL, grant_lease_token = NULL, grant_lease_until = NULL
        WHERE endpoint_id = $1`,
      [epDelegated],
    );
    await client.query(
      `UPDATE tenant_channel_endpoints SET binding_status = 'reauthorization_required' WHERE id = $1`,
      [epDelegated],
    );
    const bind = await client.query(
      `SELECT binding_status FROM tenant_channel_endpoints WHERE id = $1`, [epDelegated],
    );
    ok('P10 terminal reauth binding', bind.rows[0].binding_status === 'reauthorization_required');

    await expectFail(client,
      `UPDATE tenant_channel_endpoints
          SET auth_mode = 'application_client_credentials',
              connector_mode = 'microsoft_app_only_enterprise',
              provider_principal_oid = NULL, mailbox_access_kind = 'application'
        WHERE id = $1`,
      [epDelegated], 'P10b mode change under grant rejected');

    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tenant_email_delegated_grants'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    ok('P11 no refresh_token column', !names.includes('refresh_token')
      && names.includes('ciphertext') && names.includes('wrapped_dek'));

    await client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_status='active',
              grant_lease_owner=NULL, grant_lease_token=NULL, grant_lease_until=NULL,
              reconcile_state='clean', reconcile_detail_code=NULL
        WHERE endpoint_id = $1`,
      [epDelegated],
    );
    await expectFail(client,
      `UPDATE tenant_email_delegated_grants
          SET reconcile_state='clean', reconcile_detail_code='should_be_null'
        WHERE endpoint_id = $1`,
      [epDelegated], 'P12 clean+detail rejected by coupling');
    await expectFail(client,
      `UPDATE tenant_email_delegated_grants
          SET reconcile_state='needs_operator', reconcile_detail_code=NULL
        WHERE endpoint_id = $1`,
      [epDelegated], 'P12b non-clean without detail rejected');
    await client.query(
      `UPDATE tenant_email_delegated_grants
          SET reconcile_state='needs_operator', reconcile_detail_code='invalid_grant'
        WHERE endpoint_id = $1`,
      [epDelegated],
    );
    ok('P12c non-clean with detail accepted', true);
    await client.query(
      `UPDATE tenant_email_delegated_grants
          SET reconcile_state='clean', reconcile_detail_code=NULL WHERE endpoint_id = $1`,
      [epDelegated],
    );
    ok('P12d clean with null detail accepted', true);

    await applySqlFile(client, path.join(MIGRATIONS_DIR, DOWN059));
    const gone = await client.query(
      `SELECT to_regclass('public.tenant_email_delegated_grants') AS t`,
    );
    ok('P1c down drops grant table', gone.rows[0].t == null);
    const still = await client.query(
      `SELECT to_regclass('public.tenant_channel_endpoints') AS t`,
    );
    ok('P1d 057/058 intact after down', still.rows[0].t != null);
    const idCol = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tenant_channel_endpoints' AND column_name = 'binding_status'`,
    );
    ok('P1e identity columns remain', idCol.rows.length === 1);
  } finally {
    await client.end();
  }
}

async function runConcurrentProofs(Client, connection) {
  console.log('\nConcurrent stock-PG proofs');
  const setup = new Client(connection);
  await setup.connect();
  try {
    await setup.query(PARENT_DDL);
    await setup.query('DROP TABLE IF EXISTS tenant_email_delegated_grants CASCADE');
    await setup.query('DROP TABLE IF EXISTS tenant_channel_endpoints CASCADE');
    await setup.query('DROP TABLE IF EXISTS tenant_locations CASCADE');
    await applySqlFile(setup, path.join(MIGRATIONS_DIR, UP057));
    await applySqlFile(setup, path.join(MIGRATIONS_DIR, UP058));
    await applySqlFile(setup, path.join(MIGRATIONS_DIR, UP059));
    const clientA = crypto.randomUUID();
    const fixtureTag = crypto.randomBytes(6).toString('hex');
    const clientSlug = `concurrent-${fixtureTag}`;
    const locationId = `concurrent-${fixtureTag}-loc`;
    await setup.query(
      `INSERT INTO clients (id, slug, name) VALUES ($1,$2,'Concurrent proof')`,
      [clientA, clientSlug],
    );
    await setup.query(
      `INSERT INTO tenant_locations (client_id, location_id, display_name) VALUES ($1,$2,'Concurrent proof')`,
      [clientA, locationId],
    );
    const ep = crypto.randomUUID();
    await insertEndpointFixed(setup, {
      clientId: clientA, endpointId: ep, locationId,
      address: `concurrent-${fixtureTag}@example.com`, provider: 'microsoft_graph',
      authMode: 'delegated_authorization_code', connectorMode: 'microsoft_delegated_oauth',
      bindingStatus: 'verified', resourceId: OID,
    });
    await insertGrant(setup, clientA, ep, envelopeParams());

    const c1 = new Client(connection);
    const c2 = new Client(connection);
    await c1.connect();
    await c2.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await c1.query(
        `SELECT * FROM tenant_email_delegated_grants WHERE endpoint_id = $1 FOR UPDATE`, [ep],
      );
      await c2.query(`SET LOCAL lock_timeout = '500ms'`);
      let blocked = false;
      try {
        await c2.query(
          `SELECT * FROM tenant_email_delegated_grants WHERE endpoint_id = $1 FOR UPDATE`, [ep],
        );
      } catch (e) {
        blocked = e && (e.code === '55P03' || /lock/i.test(String(e.message || '')));
      }
      ok('P7 concurrent FOR UPDATE blocks loser', blocked);

      const tok = crypto.randomUUID();
      await c1.query(
        `UPDATE tenant_email_delegated_grants
            SET grant_status = 'lease_held', grant_lease_owner = 'w1',
                grant_lease_token = $2::uuid,
                grant_lease_until = clock_timestamp() + interval '1 minute'
          WHERE endpoint_id = $1`,
        [ep, tok],
      );
      await c1.query('COMMIT');
      await c2.query('ROLLBACK');

      const lose = await c2.query(
        `UPDATE tenant_email_delegated_grants
            SET grant_generation = grant_generation + 1, grant_status = 'active',
                grant_lease_token = NULL, grant_lease_owner = NULL, grant_lease_until = NULL
          WHERE endpoint_id = $1 AND grant_lease_token = $2::uuid
          RETURNING grant_generation`,
        [ep, crypto.randomUUID()],
      );
      ok('P7b concurrent CAS loser 0 rows', lose.rowCount === 0);
      const win = await c1.query(
        `UPDATE tenant_email_delegated_grants
            SET grant_generation = grant_generation + 1, grant_status = 'active',
                grant_lease_token = NULL, grant_lease_owner = NULL, grant_lease_until = NULL
          WHERE endpoint_id = $1 AND grant_lease_token = $2::uuid
          RETURNING grant_generation`,
        [ep, tok],
      );
      ok('P7c winner CAS advances generation', win.rowCount === 1
        && Number(win.rows[0].grant_generation) === 2);
    } finally {
      try { await c1.end(); } catch (_) { /* */ }
      try { await c2.end(); } catch (_) { /* */ }
    }
  } finally {
    await setup.end();
  }
}

async function main() {
  console.log('prove:email-delegated-grant-custody-pg (Slice 2F-A)');

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (_) {
    unexecuted('all', 'node pg module unavailable');
    console.log(`\n${pass} passed, ${fail} failed, ${unexec} unexecuted`);
    process.exit(0);
  }

  let harness;
  let backend = null;
  const { startDisposablePostgresHarness, dockerAvailable } = require('./lib/disposable-postgres-harness');
  try {
    const hasDocker = dockerAvailable();
    harness = await startDisposablePostgresHarness();
    backend = harness.backend;
    console.log(`  harness backend: ${backend} (dockerAvailable=${hasDocker})`);
  } catch (e) {
    unexecuted('harness', e && e.message ? e.message : 'unavailable');
    console.log(`\n${pass} passed, ${fail} failed, ${unexec} unexecuted`);
    process.exit(fail > 0 ? 1 : 0);
  }

  const dbName = `wh_mig_2fa_${crypto.randomBytes(4).toString('hex')}`;
  const admin = harness.admin;
  const safety = assertSafeDatabaseTarget({ ...admin, database: dbName });
  if (!safety.ok) {
    unexecuted('safe_target', 'non-disposable target');
    if (harness.cleanup) harness.cleanup();
    console.log(`\n${pass} passed, ${fail} failed, ${unexec} unexecuted`);
    process.exit(fail > 0 ? 1 : 0);
  }

  try {
    await waitForPg(Client, admin, 40);
    const adminClient = new Client(admin);
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE ${dbName}`);
    await adminClient.end();

    const connection = { ...admin, database: dbName };
    await runSequentialProofs(Client, connection, backend);

    if (backend === 'docker') {
      await runConcurrentProofs(Client, connection);
    } else {
      unexecuted('P7 concurrent lease loser (stock PG)', 'requires Docker/stock PostgreSQL; PGlite sequential only');
      unexecuted('P7b/c concurrent CAS fencing', 'requires Docker/stock PostgreSQL');
    }
  } catch (e) {
    console.error('PG_PROOF_ERROR:', e && e.message ? e.message : e);
    fail += 1;
  } finally {
    if (harness && typeof harness.cleanup === 'function') harness.cleanup();
  }

  console.log(`\nbackend=${backend} ${pass} passed, ${fail} failed, ${unexec} unexecuted`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('prove crashed', e && e.message ? e.message : e);
  process.exit(2);
});
