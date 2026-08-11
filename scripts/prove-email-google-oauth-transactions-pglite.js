'use strict';

/**
 * RED/GREEN disposable proof for 075 Google OAuth transaction custody.
 *
 * RED is intentionally authentic: the exact candidate up/down files and their
 * canonical-manifest classifications must exist before any substitute SQL can
 * run. GREEN executes those bytes in PGlite; there is no fake/fallback schema.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'database', 'migrations');
const UP_NAME = '075_tenant_email_google_oauth_transactions.sql';
const DOWN_NAME = '075_tenant_email_google_oauth_transactions_down.sql';
const UP_PATH = path.join(MIGRATIONS, UP_NAME);
const DOWN_PATH = path.join(MIGRATIONS, DOWN_NAME);
const TABLE = 'tenant_email_google_oauth_transactions';
const GUARD_FUNCTION = 'tenant_email_google_oauth_transactions_require_endpoint';
const manifest = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'canonical-manifest.json'), 'utf8'));

function failRed() {
  const entries = new Map((manifest.entries || []).map((entry) => [entry.filename, entry]));
  const missing = [UP_NAME, DOWN_NAME].filter((name) => !fs.existsSync(path.join(MIGRATIONS, name)));
  const absent = [UP_NAME, DOWN_NAME].filter((name) => !entries.has(name));
  if (missing.length || absent.length) {
    throw new Error(
      `RED 075 Google OAuth transaction migration candidate unavailable: missing files=[${missing.join(', ')}]; `
      + `absent manifest classifications=[${absent.join(', ')}]`,
    );
  }
  const up = entries.get(UP_NAME);
  const down = entries.get(DOWN_NAME);
  assert.strictEqual(up.classification, 'canonical_forward', `${UP_NAME} must be canonical_forward`);
  assert.strictEqual(up.inForwardChain, true, `${UP_NAME} must be in forward chain`);
  assert.strictEqual(down.classification, 'rollback_down', `${DOWN_NAME} must be rollback_down`);
  assert.strictEqual(down.inForwardChain, false, `${DOWN_NAME} must not be in forward chain`);
}

function loadPglite() {
  const roots = [ROOT, '/opt/data/wolfhouse-agent', '/opt/wolfhouse/WH'];
  for (const base of roots) {
    try {
      return require(require.resolve('@electric-sql/pglite', { paths: [base] })).PGlite;
    } catch (_) { /* try repository dependency roots */ }
  }
  throw new Error('PGlite unavailable; install/resolve @electric-sql/pglite (proof refuses a SQL fake)');
}

const id = {
  client: '10000000-0000-4000-8000-000000000001', otherClient: '10000000-0000-4000-8000-000000000002',
  location: '20000000-0000-4000-8000-000000000001', otherLocation: '20000000-0000-4000-8000-000000000002',
  sameClientOtherLocation: '20000000-0000-4000-8000-000000000003',
  staff: '30000000-0000-4000-8000-000000000001', otherStaff: '30000000-0000-4000-8000-000000000002',
  session: '40000000-0000-4000-8000-000000000001', otherSession: '40000000-0000-4000-8000-000000000002',
  google: '50000000-0000-4000-8000-000000000001', googlePending: '50000000-0000-4000-8000-000000000002',
  microsoft: '50000000-0000-4000-8000-000000000003', wrongMode: '50000000-0000-4000-8000-000000000004',
  wrongLocation: '50000000-0000-4000-8000-000000000005', verifiedGoogle: '50000000-0000-4000-8000-000000000006',
  partialGoogle: '50000000-0000-4000-8000-000000000007',
};
const issued = new Date('2026-08-11T12:00:00.000Z');
const expires = new Date('2026-08-11T12:10:00.000Z');
let sequence = 1;
const digest = () => Buffer.alloc(32, sequence++);
const operation = () => `60000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;

async function reject(db, sql, params, label) {
  await assert.rejects(() => db.query(sql, params), /check|constraint|foreign key|eligible|endpoint|location|client|transaction|violates|refuse/i, label);
}

function insertSql(overrides = {}) {
  const row = {
    client_id: id.client, location_id: id.location, endpoint_id: id.google, staff_user_id: id.staff,
    auth_session_id: id.session, operation_id: operation(), state_hash: digest(),
    code_verifier: 'A'.repeat(43), nonce: 'b'.repeat(43), authorization_intent: 'initial_connect',
    scope_version: 'phase_a_v2', issued_at: issued, expires_at: expires, consumed_at: null,
    ...overrides,
  };
  return {
    sql: `INSERT INTO ${TABLE}
      (client_id,location_id,endpoint_id,staff_user_id,auth_session_id,operation_id,state_hash,
       code_verifier,nonce,authorization_intent,scope_version,issued_at,expires_at,consumed_at)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::bytea,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    params: [row.client_id, row.location_id, row.endpoint_id, row.staff_user_id, row.auth_session_id,
      row.operation_id, row.state_hash, row.code_verifier, row.nonce, row.authorization_intent,
      row.scope_version, row.issued_at, row.expires_at, row.consumed_at],
    row,
  };
}

async function main() {
  failRed();
  const upSql = fs.readFileSync(UP_PATH, 'utf8');
  const downSql = fs.readFileSync(DOWN_PATH, 'utf8');
  assert.ok(upSql.trim() && downSql.trim(), 'candidate SQL must be nonempty');
  const PGlite = loadPglite();
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY);
    CREATE TABLE staff_users (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), UNIQUE(client_id,id));
    CREATE TABLE auth_sessions (id uuid PRIMARY KEY, client_id uuid NOT NULL, staff_user_id uuid NOT NULL,
      UNIQUE(client_id,id,staff_user_id), FOREIGN KEY(client_id,staff_user_id) REFERENCES staff_users(client_id,id));
    CREATE TABLE tenant_locations (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id),
      location_id text NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE(client_id,id));
    CREATE TABLE tenant_channel_endpoints (
      id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), location_id text NOT NULL,
      provider text NOT NULL, auth_mode text, connector_mode text, binding_status text,
      provider_tenant_id text, provider_principal_oid text, provider_resource_id text,
      mailbox_kind text, mailbox_access_kind text, updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(client_id,id));
    -- Existing Microsoft table is deliberately independent and must survive 075/down.
    CREATE TABLE tenant_email_oauth_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), marker text);
    INSERT INTO clients VALUES ('${id.client}'),('${id.otherClient}');
    INSERT INTO staff_users VALUES ('${id.staff}','${id.client}'),('${id.otherStaff}','${id.otherClient}');
    INSERT INTO auth_sessions VALUES ('${id.session}','${id.client}','${id.staff}'),
      ('${id.otherSession}','${id.otherClient}','${id.otherStaff}');
    INSERT INTO tenant_locations(id,client_id,location_id) VALUES
      ('${id.location}','${id.client}','sunset'),('${id.otherLocation}','${id.otherClient}','other'),
      ('${id.sameClientOtherLocation}','${id.client}','other');
    INSERT INTO tenant_channel_endpoints
      (id,client_id,location_id,provider,auth_mode,connector_mode,binding_status,
       provider_tenant_id,provider_principal_oid,provider_resource_id,mailbox_kind,mailbox_access_kind)
    VALUES
      ('${id.google}','${id.client}','sunset','gmail_api','delegated_authorization_code','google_delegated_oauth','unverified_offline',NULL,NULL,NULL,NULL,NULL),
      ('${id.googlePending}','${id.client}','sunset','gmail_api','delegated_authorization_code','google_delegated_oauth','pending_manual_validation',NULL,NULL,NULL,NULL,NULL),
      ('${id.microsoft}','${id.client}','sunset','microsoft_graph','delegated_authorization_code','microsoft_delegated_oauth','unverified_offline',NULL,NULL,NULL,NULL,NULL),
      ('${id.wrongMode}','${id.client}','sunset','gmail_api','application_client_credentials','google_delegated_oauth','unverified_offline',NULL,NULL,NULL,NULL,NULL),
      ('${id.wrongLocation}','${id.client}','other','gmail_api','delegated_authorization_code','google_delegated_oauth','unverified_offline',NULL,NULL,NULL,NULL,NULL),
      ('${id.verifiedGoogle}','${id.client}','sunset','gmail_api','delegated_authorization_code','google_delegated_oauth','verified','https://accounts.google.com','subject','subject','user','own_user'),
      ('${id.partialGoogle}','${id.client}','sunset','gmail_api','delegated_authorization_code','google_delegated_oauth','unverified_offline','https://accounts.google.com',NULL,NULL,NULL,NULL);
  `);

  assert.strictEqual((await db.query(`SELECT to_regclass('${TABLE}') AS r`)).rows[0].r, null, 'candidate not pre-created');
  await db.exec(upSql);
  assert.strictEqual((await db.query(`SELECT to_regclass('${TABLE}') AS r`)).rows[0].r, TABLE,
    'explicitly proves candidate file applied');
  assert.strictEqual((await db.query("SELECT to_regclass('tenant_email_oauth_transactions') AS r")).rows[0].r,
    'tenant_email_oauth_transactions', '075 does not replace/modify Microsoft table');

  const canonical = insertSql();
  const inserted = (await db.query(canonical.sql, canonical.params)).rows[0];
  assert.strictEqual(inserted.authorization_intent, 'initial_connect');
  assert.strictEqual(inserted.scope_version, 'phase_a_v2');
  assert.strictEqual(inserted.consumed_at, null);
  await db.query(...Object.values(insertSql({ endpoint_id: id.googlePending })).slice(0, 2));

  for (const [label, change] of [
    ['Microsoft endpoint', { endpoint_id: id.microsoft }], ['wrong Google mode', { endpoint_id: id.wrongMode }],
    ['wrong endpoint/location mapping', { endpoint_id: id.wrongLocation }], ['verified identity endpoint', { endpoint_id: id.verifiedGoogle }],
    ['partial preverified identity endpoint', { endpoint_id: id.partialGoogle }],
    ['wrong client', { client_id: id.otherClient }], ['wrong location relation', { location_id: id.otherLocation }],
    ['wrong staff relation', { staff_user_id: id.otherStaff }], ['wrong session relation', { auth_session_id: id.otherSession }],
  ]) { const q = insertSql(change); await reject(db, q.sql, q.params, label); }

  const duplicateState = insertSql({ state_hash: canonical.row.state_hash });
  await reject(db, duplicateState.sql, duplicateState.params, 'duplicate state');
  const duplicateOperation = insertSql({ operation_id: canonical.row.operation_id });
  await reject(db, duplicateOperation.sql, duplicateOperation.params, 'duplicate operation');
  for (const [label, change] of [
    ['state 31', { state_hash: Buffer.alloc(31) }], ['verifier 42', { code_verifier: 'A'.repeat(42) }],
    ['verifier alphabet', { code_verifier: 'A'.repeat(42) + '!' }], ['nonce 42', { nonce: 'b'.repeat(42) }],
    ['nonce alphabet', { nonce: 'b'.repeat(42) + '.' }], ['zero TTL', { expires_at: issued }],
    ['TTL over 600', { expires_at: new Date(issued.getTime() + 601000) }],
    ['consumed before issued', { consumed_at: new Date(issued.getTime() - 1) }],
    ['insert already consumed', { consumed_at: new Date(issued.getTime() + 1) }],
    ['wrong intent', { authorization_intent: 'phase_b_reauthorization' }], ['null intent', { authorization_intent: null }],
    ['wrong scope', { scope_version: 'phase_b_v1' }], ['null scope', { scope_version: null }],
    ['null verifier', { code_verifier: null }], ['null nonce', { nonce: null }],
  ]) { const q = insertSql(change); await reject(db, q.sql, q.params, label); }

  const consumeSql = `UPDATE ${TABLE} SET consumed_at=$4
    WHERE state_hash=$1::bytea AND client_id=$2::uuid AND auth_session_id=$3::uuid
      AND consumed_at IS NULL AND expires_at>$4
      AND authorization_intent='initial_connect' AND scope_version='phase_a_v2'
    RETURNING id,location_id,endpoint_id,staff_user_id,auth_session_id,operation_id,code_verifier,nonce`;
  const consumeParams = [canonical.row.state_hash, id.client, id.session, new Date('2026-08-11T12:09:59Z')];
  const races = await Promise.all([db.query(consumeSql, consumeParams), db.query(consumeSql, consumeParams)]);
  assert.strictEqual(races.reduce((n, r) => n + r.rows.length, 0), 1, 'overlapping atomic dispatch has one winner');
  const won = races.find((r) => r.rows.length).rows[0];
  assert.deepStrictEqual([won.code_verifier, won.nonce, won.endpoint_id, won.operation_id],
    [canonical.row.code_verifier, canonical.row.nonce, id.google, canonical.row.operation_id], 'private fields exact');
  assert.strictEqual((await db.query(consumeSql, consumeParams)).rows.length, 0, 'replay has no winner');
  const fresh = insertSql(); await db.query(fresh.sql, fresh.params);
  assert.strictEqual((await db.query(consumeSql, [fresh.row.state_hash, id.otherClient, id.session, consumeParams[3]])).rows.length, 0);
  assert.strictEqual((await db.query(consumeSql, [fresh.row.state_hash, id.client, id.otherSession, consumeParams[3]])).rows.length, 0);
  assert.strictEqual((await db.query(consumeSql, [fresh.row.state_hash, id.client, id.session, expires])).rows.length, 0, 'expiry boundary');

  // Every authority/ownership mutation is rejected. Valid alternate values
  // below prevent generic shape constraints from masking missing immutability.
  for (const column of ['client_id','location_id','endpoint_id','staff_user_id','auth_session_id']) {
    const value = column === 'endpoint_id' ? id.microsoft
      : column === 'location_id' ? id.otherLocation
        : column === 'staff_user_id' ? id.otherStaff
          : column === 'auth_session_id' ? id.otherSession : id.otherClient;
    await reject(db, `UPDATE ${TABLE} SET ${column}=$1::uuid WHERE operation_id=$2::uuid`, [value, fresh.row.operation_id], `mutation ${column}`);
  }
  for (const [column, value, cast] of [
    ['id', '70000000-0000-4000-8000-000000000001', 'uuid'],
    ['endpoint_id', id.googlePending, 'uuid'],
    ['operation_id', operation(), 'uuid'],
    ['state_hash', digest(), 'bytea'],
    ['code_verifier', 'B'.repeat(43), 'text'],
    ['nonce', 'c'.repeat(43), 'text'],
    ['issued_at', new Date(issued.getTime() + 1000), 'timestamptz'],
    ['expires_at', new Date(expires.getTime() - 1000), 'timestamptz'],
  ]) {
    await reject(db, `UPDATE ${TABLE} SET ${column}=$1::${cast} WHERE operation_id=$2::uuid`,
      [value, fresh.row.operation_id], `immutable ${column}`);
  }
  await db.query(`UPDATE ${TABLE} SET consumed_at=$1 WHERE operation_id=$2::uuid`,
    [new Date('2026-08-11T12:00:01Z'), fresh.row.operation_id]);
  const lateConsume = insertSql(); await db.query(lateConsume.sql, lateConsume.params);
  await reject(db, `UPDATE ${TABLE} SET consumed_at=$1 WHERE operation_id=$2::uuid`,
    [new Date(expires.getTime() + 1), lateConsume.row.operation_id], 'cannot consume after expiry');
  await reject(db, `UPDATE ${TABLE} SET consumed_at=NULL WHERE operation_id=$1::uuid`,
    [fresh.row.operation_id], 'cannot unconsume');
  await reject(db, `UPDATE ${TABLE} SET consumed_at=$1 WHERE operation_id=$2::uuid`,
    [new Date('2026-08-11T12:00:02Z'), fresh.row.operation_id], 'cannot re-consume');

  const verifiedDrift = insertSql({ endpoint_id: id.googlePending });
  await db.query(verifiedDrift.sql, verifiedDrift.params);
  await db.query(`UPDATE tenant_channel_endpoints SET
    binding_status='verified', provider_tenant_id='https://accounts.google.com',
    provider_principal_oid='subject', provider_resource_id='subject',
    mailbox_kind='user', mailbox_access_kind='own_user' WHERE id=$1::uuid`, [id.googlePending]);
  await reject(db, consumeSql, [verifiedDrift.row.state_hash, id.client, id.session, consumeParams[3]],
    'consume rejects endpoint verified after issuance');
  await db.query(`UPDATE tenant_channel_endpoints SET
    binding_status='pending_manual_validation', provider_tenant_id=NULL,
    provider_principal_oid=NULL, provider_resource_id=NULL,
    mailbox_kind=NULL, mailbox_access_kind=NULL WHERE id=$1::uuid`, [id.googlePending]);

  const locationDrift = insertSql({ endpoint_id: id.googlePending });
  await db.query(locationDrift.sql, locationDrift.params);
  await db.query('UPDATE tenant_channel_endpoints SET location_id=$1 WHERE id=$2::uuid', ['other', id.googlePending]);
  await reject(db, consumeSql, [locationDrift.row.state_hash, id.client, id.session, consumeParams[3]],
    'consume rejects endpoint location changed after issuance');
  await db.query('UPDATE tenant_channel_endpoints SET location_id=$1 WHERE id=$2::uuid', ['sunset', id.googlePending]);

  await assert.rejects(() => db.exec(downSql), /row|nonempty|refus|transaction/i, 'nonempty down refuses');
  assert.strictEqual((await db.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n > 0, true, 'failed down preserves rows');
  await db.exec(`DELETE FROM ${TABLE}`);
  await db.exec(downSql);
  assert.strictEqual((await db.query(`SELECT to_regclass('${TABLE}') AS r`)).rows[0].r, null, 'down removes table');
  assert.strictEqual((await db.query('SELECT to_regprocedure($1) AS r', [`${GUARD_FUNCTION}()`])).rows[0].r, null, 'down removes guard function');
  assert.strictEqual((await db.query("SELECT to_regclass('tenant_email_oauth_transactions') AS r")).rows[0].r,
    'tenant_email_oauth_transactions', 'down leaves Microsoft table intact');
  await db.exec(upSql);
  const reapplied = insertSql(); await db.query(reapplied.sql, reapplied.params);
  assert.strictEqual((await db.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n, 1, 'reapply and insert');
  await db.close();
  console.log(`PASS PGlite: ${UP_NAME} applied; isolated Google transaction invariants, atomic consume, guarded down, reapply`);
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
