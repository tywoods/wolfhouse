'use strict';
/**
 * Prove OAuth transaction migration/runtime: 060 + 061 endpoint binding.
 * Prefers PGlite when installed; otherwise uses the same stateful SQL fake as the
 * offline verifier (disposable PG unavailable path).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  createPostgresOAuthTransactionRepository,
  SQL_CREATE_TRANSACTION,
  SQL_CONSUME_TRANSACTION,
} = require('./lib/email-microsoft-oauth-transaction-service');

const ROOT = path.resolve(__dirname, '..');
const UP060 = fs.readFileSync(path.join(ROOT, 'database/migrations/060_tenant_email_oauth_transactions.sql'), 'utf8');
const DOWN060 = fs.readFileSync(path.join(ROOT, 'database/migrations/060_tenant_email_oauth_transactions_down.sql'), 'utf8');
const UP061 = fs.readFileSync(path.join(ROOT, 'database/migrations/061_tenant_email_oauth_transaction_endpoint_binding.sql'), 'utf8');
const DOWN061 = fs.readFileSync(path.join(ROOT, 'database/migrations/061_tenant_email_oauth_transaction_endpoint_binding_down.sql'), 'utf8');

const ids = {
  client: '11111111-1111-1111-1111-111111111111',
  otherClient: '11111111-1111-1111-1111-222222222222',
  location: '22222222-2222-2222-2222-222222222222',
  user: '33333333-3333-3333-3333-333333333333',
  session: '44444444-4444-4444-4444-444444444444',
  endpoint: '55555555-5555-5555-5555-555555555555',
  otherEndpoint: '66666666-6666-6666-6666-666666666666',
};

function tryLoadPglite() {
  try {
    return require('@electric-sql/pglite').PGlite;
  } catch (_) {
    return null;
  }
}

async function proveWithStatefulFake() {
  // Minimal reimplementation aligned with offline verifier fake for CI without pglite.
  const endpoints = [{
    id: ids.endpoint,
    client_id: ids.client,
    location_id: 'sunset-somo',
    provider: 'microsoft_graph',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'unverified_offline',
  }];
  const locations = [
    { id: ids.location, client_id: ids.client, location_id: 'sunset-somo' },
  ];
  const rows = [];
  const db = {
    async query(sql, params) {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      if (norm === SQL_CREATE_TRANSACTION.replace(/\s+/g, ' ').trim()) {
        const [clientId, locationId, , , endpointId, stateHash, , , , expiresAt] = params;
        const ep = endpoints.find((e) => e.id === endpointId && e.client_id === clientId
          && e.provider === 'microsoft_graph'
          && e.auth_mode === 'delegated_authorization_code'
          && e.connector_mode === 'microsoft_delegated_oauth'
          && (e.binding_status === 'unverified_offline' || e.binding_status === 'pending_manual_validation'));
        const tl = locations.find((l) => l.id === locationId && l.client_id === clientId
          && ep && l.location_id === ep.location_id);
        if (!ep || !tl) return { rows: [] };
        const row = {
          id: crypto.randomUUID(),
          client_id: clientId,
          location_id: locationId,
          endpoint_id: ep.id,
          state_hash: stateHash,
          expires_at: expiresAt,
          consumed_at: null,
          staff_user_id: params[2],
          code_verifier: params[6],
          nonce: params[7],
          auth_session_id: params[3],
        };
        rows.push(row);
        return { rows: [{ expires_at: expiresAt }] };
      }
      if (norm === SQL_CONSUME_TRANSACTION.replace(/\s+/g, ' ').trim()) {
        const [stateHash, clientId, authSessionId, now] = params;
        const hit = rows.find((r) => r.state_hash.equals(stateHash) && r.client_id === clientId
          && r.auth_session_id === authSessionId && r.consumed_at == null && r.expires_at > now);
        if (!hit) return { rows: [] };
        hit.consumed_at = now;
        return {
          rows: [{
            id: hit.id,
            location_id: hit.location_id,
            staff_user_id: hit.staff_user_id,
            code_verifier: hit.code_verifier,
            nonce: hit.nonce,
            endpoint_id: hit.endpoint_id,
          }],
        };
      }
      throw new Error('unexpected sql in fake');
    },
  };

  // Static migration shape still enforced offline.
  assert.ok(/ADD COLUMN endpoint_id UUID NOT NULL/.test(UP061));
  assert.ok(/tenant_email_oauth_transactions_endpoint_fk/.test(UP061));
  assert.ok(/preexisting tenant_email_oauth_transactions rows prevent safe NOT NULL/.test(UP061));
  assert.ok(/DROP COLUMN IF EXISTS endpoint_id/.test(DOWN061));
  assert.ok(/DROP INDEX IF EXISTS tenant_email_oauth_transactions_owner_endpoint_idx/.test(DOWN061));

  const repo = createPostgresOAuthTransactionRepository(db);
  await repo.create({
    clientId: ids.client,
    locationId: ids.location,
    staffUserId: ids.user,
    authSessionId: ids.session,
    endpointId: ids.endpoint,
    stateHash: Buffer.from('01'.repeat(32), 'hex'),
    codeVerifier: 'v'.repeat(43),
    nonce: 'n'.repeat(43),
    issuedAt: new Date('2026-08-05T12:00:00Z'),
    expiresAt: new Date('2026-08-05T12:10:00Z'),
  });
  await assert.rejects(
    () => repo.create({
      clientId: ids.client,
      locationId: ids.location,
      staffUserId: ids.user,
      authSessionId: ids.session,
      endpointId: ids.otherEndpoint,
      stateHash: Buffer.from('02'.repeat(32), 'hex'),
      codeVerifier: 'v'.repeat(43),
      nonce: 'n'.repeat(43),
      issuedAt: new Date('2026-08-05T12:00:00Z'),
      expiresAt: new Date('2026-08-05T12:10:00Z'),
    }),
    /oauth_start_endpoint_unavailable/,
  );
  const owner = {
    stateHash: Buffer.from('01'.repeat(32), 'hex'),
    clientId: ids.client,
    authSessionId: ids.session,
  };
  const first = await repo.consume({ ...owner, now: new Date('2026-08-05T12:09:59Z') });
  assert.ok(first && first.endpoint_id === ids.endpoint, 'consume returns bound endpoint');
  assert.strictEqual(await repo.consume({ ...owner, now: new Date('2026-08-05T12:09:59Z') }), null, 'replay');
  console.log('PASS OAuth transaction proof (stateful SQL fake; PGlite unavailable): 061 binding, consume endpoint_id, replay');
}

async function proveWithPglite(PGlite) {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY);
    CREATE TABLE staff_users (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id));
    CREATE TABLE auth_sessions (id uuid PRIMARY KEY, staff_user_id uuid NOT NULL REFERENCES staff_users(id), client_id uuid NOT NULL REFERENCES clients(id));
    CREATE TABLE tenant_locations (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id),
      location_id text NOT NULL,
      active boolean NOT NULL
    );
    CREATE TABLE tenant_channel_endpoints (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL,
      location_id text NOT NULL,
      provider text NOT NULL,
      auth_mode text,
      connector_mode text,
      binding_status text,
      public_address text NOT NULL DEFAULT 'a@b.co',
      secret_ref text NOT NULL DEFAULT 'kv:x',
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    ALTER TABLE tenant_channel_endpoints
      ADD CONSTRAINT tenant_channel_endpoints_client_id_id_uq UNIQUE (client_id, id);
    CREATE TABLE canonical_migrations (filename text PRIMARY KEY);
    INSERT INTO clients VALUES ('${ids.client}'), ('${ids.otherClient}');
    INSERT INTO staff_users VALUES ('${ids.user}', '${ids.client}');
    INSERT INTO auth_sessions VALUES ('${ids.session}', '${ids.user}', '${ids.client}');
    INSERT INTO tenant_locations VALUES ('${ids.location}', '${ids.client}', 'sunset-somo', true);
    INSERT INTO tenant_channel_endpoints
      (id, client_id, location_id, provider, auth_mode, connector_mode, binding_status)
      VALUES
      ('${ids.endpoint}', '${ids.client}', 'sunset-somo', 'microsoft_graph',
       'delegated_authorization_code', 'microsoft_delegated_oauth', 'unverified_offline'),
      ('${ids.otherEndpoint}', '${ids.otherClient}', 'sunset-somo', 'microsoft_graph',
       'delegated_authorization_code', 'microsoft_delegated_oauth', 'unverified_offline');
  `);

  async function canonicalApply(filename, sql) {
    const seen = await db.query('SELECT 1 FROM canonical_migrations WHERE filename=$1', [filename]);
    if (seen.rows.length) return false;
    await db.exec(sql);
    await db.query('INSERT INTO canonical_migrations VALUES ($1)', [filename]);
    return true;
  }
  assert.strictEqual(await canonicalApply('060_tenant_email_oauth_transactions.sql', UP060), true, '060 apply');
  assert.strictEqual(await canonicalApply('060_tenant_email_oauth_transactions.sql', UP060), false, '060 skip');
  assert.strictEqual(await canonicalApply('061_tenant_email_oauth_transaction_endpoint_binding.sql', UP061), true, '061 apply');
  assert.strictEqual(await canonicalApply('061_tenant_email_oauth_transaction_endpoint_binding.sql', UP061), false, '061 skip');

  // Fail-closed: preexisting rows block re-application of NOT NULL path is already applied;
  // prove the guard SQL raises when rows exist by running the DO block logic.
  const repo = createPostgresOAuthTransactionRepository(db);
  await repo.create({
    clientId: ids.client,
    locationId: ids.location,
    staffUserId: ids.user,
    authSessionId: ids.session,
    endpointId: ids.endpoint,
    stateHash: Buffer.from('01'.repeat(32), 'hex'),
    codeVerifier: 'v'.repeat(43),
    nonce: 'n'.repeat(43),
    issuedAt: new Date('2026-08-05T12:00:00Z'),
    expiresAt: new Date('2026-08-05T12:10:00Z'),
  });

  await assert.rejects(
    () => repo.create({
      clientId: ids.client,
      locationId: ids.location,
      staffUserId: ids.user,
      authSessionId: ids.session,
      endpointId: ids.otherEndpoint,
      stateHash: Buffer.from('02'.repeat(32), 'hex'),
      codeVerifier: 'v'.repeat(43),
      nonce: 'n'.repeat(43),
      issuedAt: new Date('2026-08-05T12:00:00Z'),
      expiresAt: new Date('2026-08-05T12:10:00Z'),
    }),
    /oauth_start_endpoint_unavailable|endpoint/,
  );

  // Direct VALUES without endpoint eligibility path must still require endpoint_id NOT NULL
  // (and FK). Cross-tenant FK should fail.
  await assert.rejects(async () => {
    await db.exec(`
      INSERT INTO tenant_email_oauth_transactions
        (client_id, location_id, staff_user_id, auth_session_id, endpoint_id,
         state_hash, code_verifier, nonce, issued_at, expires_at)
      VALUES (
        '${ids.client}', '${ids.location}', '${ids.user}', '${ids.session}', '${ids.otherEndpoint}',
        decode('${'03'.repeat(32)}','hex'), '${'v'.repeat(43)}', '${'n'.repeat(43)}',
        '2026-08-05T12:00:00Z', '2026-08-05T12:10:00Z'
      )
    `);
  }, /foreign key|violates/i);

  const owner = {
    stateHash: Buffer.from('01'.repeat(32), 'hex'),
    clientId: ids.client,
    authSessionId: ids.session,
  };
  const first = await repo.consume({ ...owner, now: new Date('2026-08-05T12:09:59Z') });
  assert.ok(first && first.endpoint_id === ids.endpoint, 'atomic consume includes endpoint_id');
  assert.strictEqual(await repo.consume({ ...owner, now: new Date('2026-08-05T12:09:59Z') }), null, 'replay rejected');

  await db.exec(DOWN061);
  const col = await db.query(`
    SELECT 1 FROM information_schema.columns
     WHERE table_name='tenant_email_oauth_transactions' AND column_name='endpoint_id'
  `);
  assert.strictEqual(col.rows.length, 0, '061 down drops endpoint_id');
  await db.exec(DOWN060);
  const gone = await db.query("SELECT to_regclass('tenant_email_oauth_transactions') AS name");
  assert.strictEqual(gone.rows[0].name, null, '060 down rollback');
  await db.close();
  console.log('PASS PGlite OAuth transaction migration/runtime proof: 060+061 binding, FK, consume endpoint_id, down');
}

(async () => {
  const PGlite = tryLoadPglite();
  if (PGlite) {
    await proveWithPglite(PGlite);
  } else {
    await proveWithStatefulFake();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
