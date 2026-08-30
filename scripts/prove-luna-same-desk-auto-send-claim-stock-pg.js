'use strict';

/**
 * SAME-DESK-004 stock PostgreSQL two-connection claim contention proof.
 *
 * Disposable embedded PostgreSQL cluster (not PGlite). Two independent
 * node-postgres Clients/transactions, lock timeouts, exactly one claim
 * winner, one approval/journal/provider owner, loser provider-inert.
 * Skip/unavailable is a hard failure — never counted as PASS.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  SQL_INSERT_CLAIM,
  SQL_LINK_APPROVAL,
} = require('./lib/email-luna-same-desk-auto-send-claim');

const ROOT = path.join(__dirname, '..');
const PG_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/pg';
const EMBEDDED_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/embedded-postgres/dist/index.js';
const MIG_070 = path.join(ROOT, 'database/migrations/070_tenant_email_reply_approvals.sql');
const MIG_100_UP = path.join(ROOT, 'database/migrations/100_tenant_email_same_desk_auto_send_claims.sql');
const MIG_100_DOWN = path.join(ROOT, 'database/migrations/100_tenant_email_same_desk_auto_send_claims_down.sql');

const C = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const L = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const E = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const V = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const A = '55555555-5555-4555-8555-555555555555';
const M = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const M2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const SRC = 'graph-src-same-desk-004';
const BODY = 'Thanks for your message. Would you like to make a booking?';

function resolvePg() {
  try {
    return require(PG_MODULE);
  } catch (error) {
    const failed = new Error(`stock-PG blocker: cannot require pg from ${PG_MODULE}: ${error && error.message ? error.message : error}`);
    failed.code = 'STOCK_PG_PG_MODULE_MISSING';
    throw failed;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJsTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const failed = new Error(`${label} exceeded ${ms}ms`);
      failed.code = 'PROOF_TIMEOUT';
      reject(failed);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const STUB_SCHEMA = `
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at=NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TABLE clients (id UUID PRIMARY KEY, slug TEXT);
CREATE TABLE staff_users (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id),
  email TEXT, role TEXT, status TEXT,
  UNIQUE (client_id, id)
);
CREATE TABLE conversations (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  phone TEXT,
  UNIQUE (client_id, id)
);
CREATE TABLE tenant_locations (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  location_id TEXT NOT NULL,
  UNIQUE (client_id, id, location_id)
);
CREATE TABLE tenant_channel_endpoints (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  location_id TEXT NOT NULL,
  UNIQUE (client_id, id, location_id)
);
CREATE TABLE tenant_email_inbound_events (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  UNIQUE (client_id, id)
);
CREATE TABLE same_desk_004_proof_journal (
  approval_id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  provider_invoked BOOLEAN NOT NULL
);
`.replace(/\s+/g, ' ').replace(/; /g, ';\n');

const INSERT_APPROVAL = `
INSERT INTO tenant_email_reply_approvals (
  approval_id, operation_id, client_id, location_id, location_key, endpoint_id, conversation_id,
  source_inbound_event_id, provider, provider_mailbox_id, provider_source_message_id,
  draft_actor_staff_user_id, message_text, body_digest, state
) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7::uuid,$8::uuid,'microsoft_graph',$9,$10,$11::uuid,$12,$13,'draft')
RETURNING approval_id::text AS approval_id
`.replace(/\s+/g, ' ').trim();

async function seed(client) {
  await client.query('INSERT INTO clients (id, slug) VALUES ($1,$2)', [C, 'sunset']);
  await client.query(
    'INSERT INTO staff_users (id, client_id, email, role, status) VALUES ($1,$2,$3,$4,$5)',
    [A, C, 'op@t', 'operator', 'active'],
  );
  await client.query('INSERT INTO conversations (id, client_id, phone) VALUES ($1,$2,$3)', [V, C, 'emailv1:x']);
  await client.query('INSERT INTO tenant_locations (id, client_id, location_id) VALUES ($1,$2,$3)', [L, C, 'sunset-somo']);
  await client.query(
    'INSERT INTO tenant_channel_endpoints (id, client_id, location_id) VALUES ($1,$2,$3)',
    [E, C, 'sunset-somo'],
  );
  await client.query('INSERT INTO tenant_email_inbound_events (id, client_id) VALUES ($1,$2)', [M, C]);
  await client.query('INSERT INTO tenant_email_inbound_events (id, client_id) VALUES ($1,$2)', [M2, C]);
}

async function proveHeldTransactionContention(a, b, aPid, bPid) {
  await a.query("SET lock_timeout = '3s'");
  await a.query("SET statement_timeout = '8s'");
  await b.query("SET lock_timeout = '3s'");
  await b.query("SET statement_timeout = '8s'");
  await a.query('BEGIN');
  await b.query('BEGIN');
  const winnerInsert = await withJsTimeout(
    a.query(SQL_INSERT_CLAIM, [crypto.randomUUID(), C, V, M, A]),
    5000,
    'winner claim insert',
  );
  assert.equal(winnerInsert.rows.length, 1, 'winner must RETURNING the claim');

  let bSettled = false;
  const loserInsert = withJsTimeout(
    b.query(SQL_INSERT_CLAIM, [crypto.randomUUID(), C, V, M, A]).then((res) => {
      bSettled = true;
      return res;
    }),
    8000,
    'loser claim insert',
  );

  let sawLockWait = false;
  for (let i = 0; i < 40; i += 1) {
    if (bSettled) break;
    const waits = await a.query(
      'SELECT wait_event_type, wait_event, state FROM pg_stat_activity WHERE pid = $1',
      [bPid],
    );
    const row = waits.rows[0];
    if (row && String(row.wait_event_type || '') === 'Lock') {
      sawLockWait = true;
      break;
    }
    await sleep(25);
  }
  assert.equal(bSettled, false, 'loser insert must still be pending while winner holds the transaction');
  assert.notEqual(aPid, bPid, 'connections must be distinct backends');
  if (!sawLockWait) {
    console.log('note - lock wait_event not sampled; loser was still pending before winner commit');
  }

  await a.query('COMMIT');
  const loser = await loserInsert;
  assert.equal(loser.rows.length, 0, 'loser ON CONFLICT DO NOTHING returns no row');
  await b.query('COMMIT');

  const n = await a.query(
    'SELECT count(*)::int AS n FROM tenant_email_same_desk_auto_send_claims WHERE client_id=$1 AND conversation_id=$2 AND source_inbound_event_id=$3',
    [C, V, M],
  );
  assert.equal(n.rows[0].n, 1);
  console.log('ok - two independent stock-PG transactions: exactly one claim winner; loser waited then lost');
}

async function autoWorker(client, inboundId, providerCalls) {
  await client.query("SET lock_timeout = '3s'");
  await client.query("SET statement_timeout = '8s'");
  await client.query('BEGIN');
  try {
    const claimId = crypto.randomUUID();
    const claimed = await client.query(SQL_INSERT_CLAIM, [claimId, C, V, inboundId, A]);
    if (!claimed.rows.length) {
      await client.query('ROLLBACK');
      return { role: 'loser', provider: 0, approvals: 0, journals: 0 };
    }
    const digest = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');
    const approvalId = crypto.randomUUID();
    const approval = await client.query(INSERT_APPROVAL, [
      approvalId, crypto.randomUUID(), C, L, 'sunset-somo', E, V, inboundId, MAILBOX, SRC, A, BODY, digest,
    ]);
    assert.equal(approval.rows.length, 1);
    await client.query(SQL_LINK_APPROVAL, [claimId, C, V, approvalId, null]);
    await client.query(
      'INSERT INTO same_desk_004_proof_journal (approval_id, client_id, conversation_id, provider_invoked) VALUES ($1,$2,$3,TRUE)',
      [approvalId, C, V],
    );
    providerCalls.push(approvalId);
    await client.query('COMMIT');
    return { role: 'winner', provider: 1, approvals: 1, journals: 1, approval_id: approvalId };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve */ }
    throw error;
  }
}

async function proveParallelWorkers(a, b) {
  const providerA = [];
  const providerB = [];
  const [ra, rb] = await withJsTimeout(
    Promise.all([
      autoWorker(a, M2, providerA),
      autoWorker(b, M2, providerB),
    ]),
    12000,
    'parallel auto workers',
  );
  const roles = [ra, rb];
  const winners = roles.filter((r) => r.role === 'winner');
  const losers = roles.filter((r) => r.role === 'loser');
  assert.equal(winners.length, 1, 'exactly one claim winner');
  assert.equal(losers.length, 1, 'exactly one claim loser');
  assert.equal(winners[0].provider, 1);
  assert.equal(winners[0].approvals, 1);
  assert.equal(winners[0].journals, 1);
  assert.equal(losers[0].provider, 0);
  assert.equal(providerA.length + providerB.length, 1, 'exactly one provider ownership');
  assert.equal(losers[0].provider, 0, 'loser provider-inert');

  const claims = await a.query(
    'SELECT count(*)::int AS n FROM tenant_email_same_desk_auto_send_claims WHERE source_inbound_event_id=$1',
    [M2],
  );
  const approvals = await a.query(
    'SELECT count(*)::int AS n FROM tenant_email_reply_approvals WHERE source_inbound_event_id=$1',
    [M2],
  );
  const journals = await a.query(
    'SELECT count(*)::int AS n FROM same_desk_004_proof_journal',
  );
  assert.equal(claims.rows[0].n, 1);
  assert.equal(approvals.rows[0].n, 1);
  assert.equal(journals.rows[0].n, 1);
  console.log('ok - exactly one claim winner; one approval/journal/provider ownership; loser provider-inert');
}

async function proveGenericDraftsRemainAllowed(client) {
  const digest = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');
  const first = await client.query(INSERT_APPROVAL, [
    crypto.randomUUID(), crypto.randomUUID(), C, L, 'sunset-somo', E, V, M, MAILBOX, SRC, A, BODY, digest,
  ]);
  const second = await client.query(INSERT_APPROVAL, [
    crypto.randomUUID(), crypto.randomUUID(), C, L, 'sunset-somo', E, V, M, MAILBOX, SRC, A, BODY, digest,
  ]);
  assert.equal(first.rows.length, 1);
  assert.equal(second.rows.length, 1);
  await client.query(`
    ALTER TABLE tenant_email_reply_approvals DROP CONSTRAINT tenant_email_reply_approvals_provider_values;
    ALTER TABLE tenant_email_reply_approvals ADD CONSTRAINT tenant_email_reply_approvals_provider_values
      CHECK (provider IN ('microsoft_graph', 'imap_smtp'));
  `);
  const smtpSql = INSERT_APPROVAL.replace("'microsoft_graph'", "'imap_smtp'");
  const s1 = await client.query(smtpSql, [
    crypto.randomUUID(), crypto.randomUUID(), C, L, 'sunset-somo', E, V, M, MAILBOX, SRC, A, BODY, digest,
  ]);
  const s2 = await client.query(smtpSql, [
    crypto.randomUUID(), crypto.randomUUID(), C, L, 'sunset-somo', E, V, M, MAILBOX, SRC, A, BODY, digest,
  ]);
  assert.equal(s1.rows.length, 1);
  assert.equal(s2.rows.length, 1);
  console.log('ok - two generic Microsoft staff drafts and two SMTP drafts remain allowed for the same inbound');
}

async function main() {
  const { Client } = resolvePg();
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import(EMBEDDED_MODULE));
  } catch (error) {
    const failed = new Error(`stock-PG blocker: cannot import embedded-postgres from ${EMBEDDED_MODULE}: ${error && error.message ? error.message : error}`);
    failed.code = 'STOCK_PG_EMBEDDED_MISSING';
    throw failed;
  }

  assert.equal(fs.existsSync(MIG_100_UP), true);
  assert.equal(fs.existsSync(MIG_100_DOWN), true);

  const dataDir = fs.mkdtempSync(path.join('/opt/data/local-postgres', 'same-desk-004-claim-'));
  const port = 57621 + (process.pid % 73);
  const password = 'local-disposable-same-desk-004';
  const cluster = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password,
    port,
    persistent: false,
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    onLog() {},
    onError(message) {
      console.error(String(message));
    },
  });
  let started = false;
  const admin = new Client({
    host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres',
  });
  const a = new Client({
    host: '127.0.0.1', port, user: 'postgres', password, database: 'same_desk_004_claim',
  });
  const b = new Client({
    host: '127.0.0.1', port, user: 'postgres', password, database: 'same_desk_004_claim',
  });
  try {
    await cluster.initialise();
    await cluster.start();
    started = true;
    await admin.connect();
    await admin.query('CREATE DATABASE same_desk_004_claim');
    await a.connect();
    await b.connect();
    const aPid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    assert.notEqual(aPid, bPid);
    const version = (await a.query('SHOW server_version')).rows[0].server_version;
    console.log(`stock PG ${version} pids ${aPid} ${bPid} port ${port}`);

    await a.query(STUB_SCHEMA);
    await a.query(fs.readFileSync(MIG_070, 'utf8'));
    await a.query(fs.readFileSync(MIG_100_UP, 'utf8'));
    await seed(a);

    await proveGenericDraftsRemainAllowed(a);
    await proveHeldTransactionContention(a, b, aPid, bPid);
    await proveParallelWorkers(a, b);

    try {
      await a.query(fs.readFileSync(MIG_100_DOWN, 'utf8'));
      assert.fail('nonempty 100 down should refuse');
    } catch (error) {
      assert.match(String(error.message), /100_down_refused/);
      try { await a.query('ROLLBACK'); } catch { /* idle */ }
    }
    await a.query('DELETE FROM tenant_email_same_desk_auto_send_claims');
    await a.query(fs.readFileSync(MIG_100_DOWN, 'utf8'));
    const gone = await a.query(
      "SELECT 1 AS ok FROM information_schema.tables WHERE table_name = 'tenant_email_same_desk_auto_send_claims'",
    );
    assert.equal(gone.rows.length, 0);
    console.log('ok - empty 100 down drops dedicated claim table');
    console.log('ALL OK — SAME-DESK-004 stock-PG two-connection claim contention');
  } finally {
    try { await a.end(); } catch { /* */ }
    try { await b.end(); } catch { /* */ }
    try { await admin.end(); } catch { /* */ }
    if (started) {
      try { await cluster.stop(); } catch { /* */ }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main };
