'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { createPostgresOAuthTransactionRepository } = require('./lib/email-microsoft-oauth-transaction-service');

const ROOT = path.resolve(__dirname, '..');
const UP = fs.readFileSync(path.join(ROOT, 'database/migrations/060_tenant_email_oauth_transactions.sql'), 'utf8');
const DOWN = fs.readFileSync(path.join(ROOT, 'database/migrations/060_tenant_email_oauth_transactions_down.sql'), 'utf8');
const ids = {
  client: '11111111-1111-1111-1111-111111111111', otherClient: '11111111-1111-1111-1111-222222222222',
  location: '22222222-2222-2222-2222-222222222222', user: '33333333-3333-3333-3333-333333333333',
  session: '44444444-4444-4444-4444-444444444444',
};

async function rejects(db, sql, pattern) {
  await assert.rejects(() => db.exec(sql), pattern);
}

(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY);
    CREATE TABLE staff_users (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id));
    CREATE TABLE auth_sessions (id uuid PRIMARY KEY, staff_user_id uuid NOT NULL REFERENCES staff_users(id), client_id uuid NOT NULL REFERENCES clients(id));
    CREATE TABLE tenant_locations (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), location_id text NOT NULL, active boolean NOT NULL);
    CREATE TABLE canonical_migrations (filename text PRIMARY KEY);
    INSERT INTO clients VALUES ('${ids.client}'), ('${ids.otherClient}');
    INSERT INTO staff_users VALUES ('${ids.user}', '${ids.client}');
    INSERT INTO auth_sessions VALUES ('${ids.session}', '${ids.user}', '${ids.client}');
    INSERT INTO tenant_locations VALUES ('${ids.location}', '${ids.client}', 'sunset-somo', true);
  `);
  async function canonicalApply() {
    const seen = await db.query("SELECT 1 FROM canonical_migrations WHERE filename='060_tenant_email_oauth_transactions.sql'");
    if (seen.rows.length) return false;
    await db.exec(UP);
    await db.exec("INSERT INTO canonical_migrations VALUES ('060_tenant_email_oauth_transactions.sql')");
    return true;
  }
  assert.strictEqual(await canonicalApply(), true, 'forward apply');
  assert.strictEqual(await canonicalApply(), false, 'canonical runner skips second run');

  const insert = (overrides = {}) => {
    const v = { client: ids.client, location: ids.location, user: ids.user, session: ids.session,
      hash: '01'.repeat(32), issued: '2026-08-05T12:00:00Z', expires: '2026-08-05T12:10:00Z', ...overrides };
    return `INSERT INTO tenant_email_oauth_transactions
      (client_id,location_id,staff_user_id,auth_session_id,state_hash,code_verifier,nonce,issued_at,expires_at)
      VALUES ('${v.client}','${v.location}','${v.user}','${v.session}',decode('${v.hash}','hex'),'${'v'.repeat(43)}','${'n'.repeat(43)}','${v.issued}','${v.expires}')`;
  };
  await db.exec(insert());
  await rejects(db, insert({ hash: '01'.repeat(32) }), /unique/i);
  await rejects(db, insert({ hash: '02'.repeat(32), expires: '2026-08-05T12:10:01Z' }), /ttl/i);
  await rejects(db, insert({ hash: '03'.repeat(32), expires: '2026-08-05T12:00:00Z' }), /ttl/i);
  await rejects(db, insert({ hash: '04'.repeat(32), client: ids.otherClient }), /foreign key/i);

  const repo = createPostgresOAuthTransactionRepository(db);
  const owner = { stateHash: Buffer.from('01'.repeat(32), 'hex'), clientId: ids.client, authSessionId: ids.session };
  assert.strictEqual(await repo.consume({ ...owner, now: new Date('2026-08-05T12:09:59Z') }) !== null, true, 'atomic consume');
  assert.strictEqual(await repo.consume({ ...owner, now: new Date('2026-08-05T12:09:59Z') }), null, 'replay rejected');
  await db.exec(insert({ hash: '05'.repeat(32), issued: '2026-08-05T11:50:00Z', expires: '2026-08-05T12:00:00Z' }));
  assert.strictEqual(await repo.consume({ ...owner, stateHash: Buffer.from('05'.repeat(32), 'hex'), now: new Date('2026-08-05T12:00:00Z') }), null, 'expiry boundary rejected');
  assert.strictEqual(await repo.consume({ ...owner, stateHash: Buffer.from('05'.repeat(32), 'hex'), authSessionId: '44444444-4444-4444-4444-555555555555', now: new Date('2026-08-05T11:59:59Z') }), null, 'foreign owner rejected');

  await db.exec(DOWN);
  const gone = await db.query("SELECT to_regclass('tenant_email_oauth_transactions') AS name");
  assert.strictEqual(gone.rows[0].name, null, 'down rollback');
  for (const name of ['staff_users_client_id_id_uq', 'auth_sessions_client_id_id_staff_user_id_uq', 'tenant_locations_client_id_id_uq']) {
    const result = await db.query('SELECT 1 FROM pg_constraint WHERE conname=$1', [name]);
    assert.strictEqual(result.rows.length, 0, `${name} rolled back`);
  }
  await db.close();
  console.log('PASS PGlite OAuth transaction migration/runtime proof: forward, canonical skip, constraints, atomic rejection, down');
})().catch((error) => { console.error(error); process.exit(1); });