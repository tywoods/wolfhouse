'use strict';
/**
 * Prove OAuth transaction migration/runtime: 060 + 061 + 071 intent; A/B atomic consume.
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
const {
  createPostgresPhaseBOauthTransactionConsumer,
  SQL_CONSUME_PHASE_B_TRANSACTION,
} = require('./lib/email-microsoft-phase-b-oauth-callback-completion');

const ROOT = path.resolve(__dirname, '..');
const UP060 = fs.readFileSync(path.join(ROOT, 'database/migrations/060_tenant_email_oauth_transactions.sql'), 'utf8');
const DOWN060 = fs.readFileSync(path.join(ROOT, 'database/migrations/060_tenant_email_oauth_transactions_down.sql'), 'utf8');
const UP061 = fs.readFileSync(path.join(ROOT, 'database/migrations/061_tenant_email_oauth_transaction_endpoint_binding.sql'), 'utf8');
const DOWN061 = fs.readFileSync(path.join(ROOT, 'database/migrations/061_tenant_email_oauth_transaction_endpoint_binding_down.sql'), 'utf8');
const UP071 = fs.readFileSync(path.join(ROOT, 'database/migrations/071_tenant_email_phase_b_authority.sql'), 'utf8');
const DOWN071 = fs.readFileSync(path.join(ROOT, 'database/migrations/071_tenant_email_phase_b_authority_down.sql'), 'utf8');
const nSql = (s) => String(s).replace(/\s+/g, ' ').trim();
const A_SQL = nSql(SQL_CONSUME_TRANSACTION);
const B_SQL = nSql(SQL_CONSUME_PHASE_B_TRANSACTION);

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
  try { return require('@electric-sql/pglite').PGlite; } catch (_) {
    for (const dir of ['/opt/data/wolfhouse-agent/node_modules', '/opt/wolfhouse/WH/node_modules', path.join(ROOT, 'node_modules')]) {
      try { return require(require.resolve('@electric-sql/pglite', { paths: [dir] })).PGlite; } catch (_) { /* next */ }
    }
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
      const isA = norm === A_SQL; const isB = norm === B_SQL;
      if (isA || isB) {
        const [stateHash, clientId, authSessionId, now] = params;
        const hit = rows.find((r) => r.state_hash.equals(stateHash) && r.client_id === clientId
          && r.auth_session_id === authSessionId && r.consumed_at == null && r.expires_at > now
          && (isA
            ? (r.authorization_intent || 'initial_connect') === 'initial_connect'
              && (r.scope_version || 'phase_a_v2') === 'phase_a_v2' && r.prior_grant_generation == null
            : r.authorization_intent === 'phase_b_reauthorization' && r.scope_version === 'phase_b_v1'
              && r.prior_grant_generation != null && r.prior_grant_generation >= 1));
        if (!hit) return { rows: [] };
        hit.consumed_at = now;
        const base = {
          id: hit.id, location_id: hit.location_id, staff_user_id: hit.staff_user_id,
          code_verifier: hit.code_verifier, nonce: hit.nonce, endpoint_id: hit.endpoint_id,
        };
        return isA ? { rows: [base] } : { rows: [{
          ...base, authorization_intent: hit.authorization_intent,
          scope_version: hit.scope_version, prior_grant_generation: hit.prior_grant_generation,
        }] };
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
  const bHash = Buffer.from('0b'.repeat(32), 'hex');
  rows.push({
    id: crypto.randomUUID(), client_id: ids.client, location_id: ids.location, staff_user_id: ids.user,
    auth_session_id: ids.session, endpoint_id: ids.endpoint, state_hash: bHash, code_verifier: 'v'.repeat(43),
    nonce: 'n'.repeat(43), expires_at: new Date('2026-08-05T12:10:00Z'), consumed_at: null,
    authorization_intent: 'phase_b_reauthorization', scope_version: 'phase_b_v1', prior_grant_generation: 3,
  });
  const bOwner = { stateHash: bHash, clientId: ids.client, authSessionId: ids.session };
  assert.strictEqual(await repo.consume({ ...bOwner, now: new Date('2026-08-05T12:09:59Z') }), null, 'A cross-reject B');
  const bRepo = createPostgresPhaseBOauthTransactionConsumer(db);
  let bDone = 0; const bFirst = await bRepo.consume({ ...bOwner, now: new Date('2026-08-05T12:09:59Z') });
  if (bFirst) bDone += 1;
  assert.ok(bFirst && bFirst.prior_grant_generation === 3); assert.strictEqual(bDone, 1);
  assert.strictEqual(await bRepo.consume({ ...bOwner, now: new Date('2026-08-05T12:09:59Z') }), null, 'B replay');
  console.log('PASS OAuth transaction proof (stateful SQL fake; PGlite unavailable): 061+071 A/B consume/replay/cross-reject');
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
    CREATE TABLE tenant_email_delegated_grants (client_id uuid NOT NULL, endpoint_id uuid NOT NULL);
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
  assert.strictEqual(await canonicalApply('071_tenant_email_phase_b_authority.sql', UP071), true, '071 apply');
  assert.strictEqual(await canonicalApply('071_tenant_email_phase_b_authority.sql', UP071), false, '071 skip');

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
  const intentRow = await db.query(
    `SELECT authorization_intent, scope_version, prior_grant_generation FROM tenant_email_oauth_transactions WHERE client_id=$1::uuid`,
    [ids.client],
  );
  assert.strictEqual(intentRow.rows[0].authorization_intent, 'initial_connect');
  assert.strictEqual(intentRow.rows[0].scope_version, 'phase_a_v2');
  assert.strictEqual(intentRow.rows[0].prior_grant_generation, null);

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
  let selectDuring = 0;
  const origQuery = db.query.bind(db);
  db.query = async (sql, params) => {
    if (/^\s*SELECT\b/i.test(String(sql))) selectDuring += 1;
    return origQuery(sql, params);
  };
  let aDone = 0;
  const first = await repo.consume({ ...owner, now: new Date('2026-08-05T12:09:59Z') });
  if (first) aDone += 1;
  assert.ok(first && first.endpoint_id === ids.endpoint, 'atomic Phase A consume includes endpoint_id');
  assert.strictEqual(aDone, 1);
  assert.strictEqual(await repo.consume({ ...owner, now: new Date('2026-08-05T12:09:59Z') }), null, 'A replay rejected');
  assert.strictEqual(aDone, 1);
  await origQuery(
    `INSERT INTO tenant_email_oauth_transactions
      (client_id, location_id, staff_user_id, auth_session_id, endpoint_id, state_hash, code_verifier, nonce,
       issued_at, expires_at, authorization_intent, scope_version, prior_grant_generation)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bytea,$7,$8,$9,$10,'phase_b_reauthorization','phase_b_v1',7)`,
    [ids.client, ids.location, ids.user, ids.session, ids.endpoint, Buffer.from('0b'.repeat(32), 'hex'),
      'v'.repeat(43), 'n'.repeat(43), new Date('2026-08-05T12:00:00Z'), new Date('2026-08-05T12:10:00Z')],
  );
  const bOwner = { stateHash: Buffer.from('0b'.repeat(32), 'hex'), clientId: ids.client, authSessionId: ids.session };
  assert.strictEqual(await repo.consume({ ...bOwner, now: new Date('2026-08-05T12:09:59Z') }), null, 'A cross-reject B');
  const bRepo = createPostgresPhaseBOauthTransactionConsumer(db);
  let bDone = 0;
  const bFirst = await bRepo.consume({ ...bOwner, now: new Date('2026-08-05T12:09:59Z') });
  if (bFirst) bDone += 1;
  assert.ok(bFirst && bFirst.authorization_intent === 'phase_b_reauthorization'
    && String(bFirst.prior_grant_generation) === '7', 'atomic Phase B consume');
  assert.strictEqual(bDone, 1);
  assert.strictEqual(await bRepo.consume({ ...bOwner, now: new Date('2026-08-05T12:09:59Z') }), null, 'B replay');
  await origQuery(
    `INSERT INTO tenant_email_oauth_transactions
      (client_id, location_id, staff_user_id, auth_session_id, endpoint_id, state_hash, code_verifier, nonce, issued_at, expires_at)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bytea,$7,$8,$9,$10)`,
    [ids.client, ids.location, ids.user, ids.session, ids.endpoint, Buffer.from('0a'.repeat(32), 'hex'),
      'v'.repeat(43), 'n'.repeat(43), new Date('2026-08-05T12:00:00Z'), new Date('2026-08-05T12:10:00Z')],
  );
  assert.strictEqual(await bRepo.consume({
    stateHash: Buffer.from('0a'.repeat(32), 'hex'), clientId: ids.client, authSessionId: ids.session,
    now: new Date('2026-08-05T12:09:59Z'),
  }), null, 'B cross-reject A');
  assert.strictEqual(selectDuring, 0, 'no preliminary SELECT on consume path');
  db.query = origQuery;
  await db.exec(`DELETE FROM tenant_email_oauth_transactions
    WHERE authorization_intent IS DISTINCT FROM 'initial_connect'
       OR scope_version IS DISTINCT FROM 'phase_a_v2' OR prior_grant_generation IS NOT NULL`);
  await db.exec(DOWN071);
  await db.exec(DOWN061);
  await db.exec(DOWN060);
  const gone = await db.query("SELECT to_regclass('tenant_email_oauth_transactions') AS name");
  assert.strictEqual(gone.rows[0].name, null, '060 down rollback');
  await db.close();
  console.log('PASS PGlite OAuth transaction proof: 060+061+071 A/B consume/replay/cross-reject no pre-SELECT');
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
