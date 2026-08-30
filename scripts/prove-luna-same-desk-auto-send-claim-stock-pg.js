'use strict';

/**
 * SAME-DESK-004 stock PostgreSQL two-connection claim lifecycle proof.
 *
 * Disposable embedded PostgreSQL cluster (not PGlite). Two independent
 * node-postgres Clients/transactions, lock timeouts, exactly one claim
 * winner, one approval/journal/provider owner, loser provider-inert.
 *
 * Also proves: crash/lease expiry/reclaim, stale-owner CAS rejection,
 * outcome-unknown non-retryable dispatching, and 100 down complete-up /
 * absent-table / nonempty-refusal / concurrent-insert ACCESS EXCLUSIVE.
 * Skip/unavailable is a hard failure.
 *
 * Deterministic clock: ISO timestamps passed as SQL parameters. No
 * Date.now() lease comparisons.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  createSameDeskAutoSendClaimOwner,
  SQL_INSERT_CLAIM,
  SQL_LINK_APPROVAL,
  SQL_RELEASE_CLAIM,
  SQL_BEGIN_DISPATCH,
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
const M3 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const M4 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const SRC = 'graph-src-same-desk-004';
const BODY = 'Thanks for your message. Would you like to make a booking?';
const T0 = new Date('2026-08-30T12:00:00.000Z');
const T_EXPIRE = new Date('2026-08-30T12:00:31.000Z');
const LEASE_MS = 30_000;

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

function isBlockOrTimeout(error) {
  const code = error && error.code;
  return code === '55P03' || code === '57014'
    || /lock timeout|statement timeout|canceling statement/i.test(String(error && error.message || ''));
}

function assert100DownLockContract(sql) {
  const beginIdx = sql.search(/(?:^|\n)BEGIN;/);
  assert.ok(beginIdx >= 0, '100 DOWN must open a transaction');
  const lockNeedle = 'LOCK TABLE public.tenant_email_same_desk_auto_send_claims IN ACCESS EXCLUSIVE MODE';
  const lockIdx = sql.indexOf(lockNeedle);
  assert.ok(lockIdx > beginIdx, '100 DOWN must ACCESS EXCLUSIVE lock the claim table inside the transaction');
  const existsIdx = sql.search(/IF EXISTS \(SELECT 1 FROM public\.tenant_email_same_desk_auto_send_claims\)/);
  assert.ok(existsIdx > lockIdx, 'emptiness check must run after ACCESS EXCLUSIVE');
  const dropTriggerIdx = sql.indexOf('DROP TRIGGER IF EXISTS tenant_email_same_desk_auto_send_claims_protect');
  const dropTableIdx = sql.indexOf('DROP TABLE IF EXISTS public.tenant_email_same_desk_auto_send_claims');
  assert.ok(dropTriggerIdx > lockIdx, 'trigger drop must follow ACCESS EXCLUSIVE');
  assert.ok(dropTableIdx > existsIdx, 'table drop must follow emptiness check');
  assert.ok(
    sql.includes("to_regclass('public.tenant_email_same_desk_auto_send_claims')"),
    'absent-table safety must guard the lock/check/trigger-drop block',
  );
  assert.match(sql, /100_down_refused/);
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

function claimParams(inboundId, now) {
  const expires = new Date(now.getTime() + LEASE_MS);
  return [
    crypto.randomUUID(), C, V, inboundId, A,
    crypto.randomUUID(), expires.toISOString(), now.toISOString(),
  ];
}

function ownerFor(client, clock) {
  return createSameDeskAutoSendClaimOwner({
    withPgClient: async (fn) => fn(client),
    now: () => clock.now,
    leaseMs: LEASE_MS,
  });
}

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
  await client.query('INSERT INTO tenant_email_inbound_events (id, client_id) VALUES ($1,$2)', [M3, C]);
  await client.query('INSERT INTO tenant_email_inbound_events (id, client_id) VALUES ($1,$2)', [M4, C]);
}

async function insertDraft(client, inboundId) {
  const digest = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');
  const approvalId = crypto.randomUUID();
  const approval = await client.query(INSERT_APPROVAL, [
    approvalId, crypto.randomUUID(), C, L, 'sunset-somo', E, V, inboundId, MAILBOX, SRC, A, BODY, digest,
  ]);
  assert.equal(approval.rows.length, 1);
  return approvalId;
}

async function proveHeldTransactionContention(a, b, aPid, bPid) {
  await a.query("SET lock_timeout = '3s'");
  await a.query("SET statement_timeout = '8s'");
  await b.query("SET lock_timeout = '3s'");
  await b.query("SET statement_timeout = '8s'");
  await a.query('BEGIN');
  await b.query('BEGIN');
  const winnerInsert = await withJsTimeout(
    a.query(SQL_INSERT_CLAIM, claimParams(M, T0)),
    5000,
    'winner claim insert',
  );
  assert.equal(winnerInsert.rows.length, 1, 'winner must RETURNING the claim');
  assert.equal(winnerInsert.rows[0].state, 'leased');
  assert.ok(winnerInsert.rows[0].lease_token);

  let bSettled = false;
  const loserInsert = withJsTimeout(
    b.query(SQL_INSERT_CLAIM, claimParams(M, T0)).then((res) => {
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
  assert.equal(loser.rows.length, 0, 'loser ON CONFLICT WHERE not reclaimable returns no row');
  await b.query('COMMIT');

  const n = await a.query(
    'SELECT count(*)::int AS n FROM tenant_email_same_desk_auto_send_claims WHERE client_id=$1 AND conversation_id=$2 AND source_inbound_event_id=$3',
    [C, V, M],
  );
  assert.equal(n.rows[0].n, 1);
  console.log('ok - two independent stock-PG transactions: exactly one claim winner; loser waited then lost');
}

async function autoWorker(client, inboundId, providerCalls, clock) {
  await client.query("SET lock_timeout = '3s'");
  await client.query("SET statement_timeout = '8s'");
  const owner = ownerFor(client, clock);
  await client.query('BEGIN');
  try {
    const claimed = await owner.claim({
      client_id: C,
      conversation_id: V,
      source_inbound_event_id: inboundId,
      claimant_staff_user_id: A,
    });
    if (!claimed || claimed.status !== 'won') {
      await client.query('ROLLBACK');
      return { role: 'loser', provider: 0, approvals: 0, journals: 0 };
    }
    const approvalId = await insertDraft(client, inboundId);
    const linked = await owner.linkApproval({
      claim_id: claimed.claim_id,
      client_id: C,
      conversation_id: V,
      approval_id: approvalId,
      lease_token: claimed.lease_token,
      lease_epoch: claimed.lease_epoch,
    });
    assert.equal(linked.status, 'linked');
    const begun = await owner.beginDispatch({
      claim_id: claimed.claim_id,
      client_id: C,
      conversation_id: V,
      lease_token: claimed.lease_token,
      lease_epoch: claimed.lease_epoch,
    });
    assert.equal(begun.status, 'dispatching');
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
  const clock = { now: T0 };
  const providerA = [];
  const providerB = [];
  const [ra, rb] = await withJsTimeout(
    Promise.all([
      autoWorker(a, M2, providerA, clock),
      autoWorker(b, M2, providerB, clock),
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
    'SELECT count(*)::int AS n, min(state) AS state FROM tenant_email_same_desk_auto_send_claims WHERE source_inbound_event_id=$1',
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
  assert.equal(claims.rows[0].state, 'dispatching');
  assert.equal(approvals.rows[0].n, 1);
  assert.equal(journals.rows[0].n, 1);
  console.log('ok - exactly one claim winner; one approval/journal/provider ownership; loser provider-inert');
}

async function proveLeaseExpiryReclaimAndStaleOwner(a, b) {
  const clockA = { now: T0 };
  const clockB = { now: T0 };
  const ownerA = ownerFor(a, clockA);
  const ownerB = ownerFor(b, clockB);

  const won = await ownerA.claim({
    client_id: C,
    conversation_id: V,
    source_inbound_event_id: M3,
    claimant_staff_user_id: A,
  });
  assert.equal(won.status, 'won');
  const staleToken = won.lease_token;
  const staleEpoch = won.lease_epoch;

  const lostAtT0 = await ownerB.claim({
    client_id: C,
    conversation_id: V,
    source_inbound_event_id: M3,
    claimant_staff_user_id: A,
  });
  assert.equal(lostAtT0.status, 'lost');

  clockB.now = T_EXPIRE;
  const reclaimed = await ownerB.claim({
    client_id: C,
    conversation_id: V,
    source_inbound_event_id: M3,
    claimant_staff_user_id: A,
  });
  assert.equal(reclaimed.status, 'won', 'expired leased claim must be reclaimable');
  assert.notEqual(reclaimed.lease_token, staleToken);
  assert.equal(reclaimed.lease_epoch, staleEpoch + 1);

  const approvalId = await insertDraft(a, M3);
  const staleLink = await ownerA.linkApproval({
    claim_id: won.claim_id,
    client_id: C,
    conversation_id: V,
    approval_id: approvalId,
    lease_token: staleToken,
    lease_epoch: staleEpoch,
  });
  assert.equal(staleLink.status, 'not_linked', 'stale owner cannot link after lease loss');

  const staleRelease = await ownerA.release({
    claim_id: won.claim_id,
    client_id: C,
    conversation_id: V,
    lease_token: staleToken,
    lease_epoch: staleEpoch,
  });
  assert.equal(staleRelease.status, 'not_released', 'stale owner cannot release after lease loss');

  const staleDispatch = await ownerA.beginDispatch({
    claim_id: won.claim_id,
    client_id: C,
    conversation_id: V,
    lease_token: staleToken,
    lease_epoch: staleEpoch,
  });
  assert.equal(staleDispatch.status, 'not_begun', 'stale owner cannot send after lease loss');

  const liveLink = await ownerB.linkApproval({
    claim_id: reclaimed.claim_id,
    client_id: C,
    conversation_id: V,
    approval_id: approvalId,
    lease_token: reclaimed.lease_token,
    lease_epoch: reclaimed.lease_epoch,
  });
  assert.equal(liveLink.status, 'linked');
  console.log('ok - crash/lease expiry/reclaim; stale owner cannot link/release/send');
}

async function proveOutcomeUnknownNonRetryable(a, b) {
  const clockA = { now: T0 };
  const clockB = { now: T0 };
  const ownerA = ownerFor(a, clockA);
  const ownerB = ownerFor(b, clockB);

  const won = await ownerA.claim({
    client_id: C,
    conversation_id: V,
    source_inbound_event_id: M4,
    claimant_staff_user_id: A,
  });
  assert.equal(won.status, 'won');
  const approvalId = await insertDraft(a, M4);
  const linked = await ownerA.linkApproval({
    claim_id: won.claim_id,
    client_id: C,
    conversation_id: V,
    approval_id: approvalId,
    lease_token: won.lease_token,
    lease_epoch: won.lease_epoch,
  });
  assert.equal(linked.status, 'linked');
  const begun = await ownerA.beginDispatch({
    claim_id: won.claim_id,
    client_id: C,
    conversation_id: V,
    lease_token: won.lease_token,
    lease_epoch: won.lease_epoch,
  });
  assert.equal(begun.status, 'dispatching');

  clockB.now = T_EXPIRE;
  const reclaim = await ownerB.claim({
    client_id: C,
    conversation_id: V,
    source_inbound_event_id: M4,
    claimant_staff_user_id: A,
  });
  assert.equal(reclaim.status, 'lost');
  assert.equal(reclaim.reason, 'outcome_unknown');
  assert.equal(reclaim.state, 'dispatching');

  const released = await ownerA.release({
    claim_id: won.claim_id,
    client_id: C,
    conversation_id: V,
    lease_token: won.lease_token,
    lease_epoch: won.lease_epoch,
  });
  assert.equal(released.status, 'not_released', 'dispatching must never release');

  const row = await a.query(
    'SELECT state FROM tenant_email_same_desk_auto_send_claims WHERE source_inbound_event_id=$1',
    [M4],
  );
  assert.equal(row.rows[0].state, 'dispatching');
  console.log('ok - outcome-unknown remains non-retryable (no reclaim, no release, no retry)');
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

async function proveDownVsConcurrentInsert(Client, port, password) {
  const downSql = fs.readFileSync(MIG_100_DOWN, 'utf8');
  const insertConn = new Client({
    host: '127.0.0.1', port, user: 'postgres', password, database: 'same_desk_004_race',
  });
  const downConn = new Client({
    host: '127.0.0.1', port, user: 'postgres', password, database: 'same_desk_004_race',
  });
  try {
    await insertConn.connect();
    await downConn.connect();
    const insertPid = (await insertConn.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const downPid = (await downConn.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    assert.notEqual(insertPid, downPid, 'insert and down must be distinct backends');

    await insertConn.query(STUB_SCHEMA);
    await insertConn.query(fs.readFileSync(MIG_070, 'utf8'));
    await insertConn.query(fs.readFileSync(MIG_100_UP, 'utf8'));
    await seed(insertConn);

    await insertConn.query("SET lock_timeout = '8s'");
    await insertConn.query("SET statement_timeout = '15s'");
    await downConn.query("SET lock_timeout = '8s'");
    await downConn.query("SET statement_timeout = '15s'");

    // Ordering 1: uncommitted insert holds RowExclusiveLock. Down must wait,
    // then after insert commits, refuse rather than DROP the new evidence.
    await insertConn.query('BEGIN');
    const inserted = await insertConn.query(SQL_INSERT_CLAIM, claimParams(M, T0));
    assert.equal(inserted.rows.length, 1, 'race insert must RETURNING the leased claim');

    let downSettled = false;
    const downPromise = withJsTimeout(
      downConn.query(downSql).then((res) => {
        downSettled = true;
        return { ok: true, res };
      }).catch((err) => {
        downSettled = true;
        return { ok: false, err };
      }),
      12000,
      '100 down vs held insert',
    );

    let sawLockWait = false;
    for (let i = 0; i < 80; i += 1) {
      if (downSettled) break;
      const waits = await insertConn.query(
        'SELECT wait_event_type, wait_event, state FROM pg_stat_activity WHERE pid = $1',
        [downPid],
      );
      const row = waits.rows[0];
      if (row && String(row.wait_event_type || '') === 'Lock') {
        sawLockWait = true;
        break;
      }
      await sleep(25);
    }
    assert.equal(downSettled, false, '100 down must still be pending while insert holds RowExclusiveLock');
    assert.ok(sawLockWait, '100 down must wait on ACCESS EXCLUSIVE while the insert is uncommitted');

    await insertConn.query('COMMIT');
    const downOutcome = await downPromise;
    try { await downConn.query('ROLLBACK'); } catch { /* aborted txn */ }

    assert.equal(
      downOutcome.ok,
      false,
      '100 down must not silently drop after a concurrent insert commits',
    );
    assert.match(
      String(downOutcome.err && downOutcome.err.message || ''),
      /100_down_refused/,
      'after lock acquisition, down must see the committed row and refuse',
    );

    const still = await insertConn.query(
      'SELECT count(*)::int AS n FROM tenant_email_same_desk_auto_send_claims',
    );
    assert.equal(still.rows[0].n, 1, 'committed claim evidence must not be silently deleted');
    const table = await insertConn.query(
      "SELECT 1 AS ok FROM information_schema.tables WHERE table_name = 'tenant_email_same_desk_auto_send_claims'",
    );
    assert.equal(table.rows.length, 1, 'claim table must remain after refused down');
    console.log('ok - concurrent insert vs 100 down: ACCESS EXCLUSIVE wait, then refuse; evidence preserved');

    // Ordering 2: down holds ACCESS EXCLUSIVE first; insert is blocked until
    // a safe drop (or rollback) — no commit between emptiness check and DROP.
    await insertConn.query('DELETE FROM tenant_email_same_desk_auto_send_claims');
    await downConn.query('BEGIN');
    await downConn.query('LOCK TABLE public.tenant_email_same_desk_auto_send_claims IN ACCESS EXCLUSIVE MODE');
    const empty = await downConn.query(
      'SELECT count(*)::int AS n FROM tenant_email_same_desk_auto_send_claims',
    );
    assert.equal(empty.rows[0].n, 0, 'emptiness check must run after ACCESS EXCLUSIVE');

    await insertConn.query("SET lock_timeout = '800ms'");
    await insertConn.query("SET statement_timeout = '2500ms'");
    let insertErr = null;
    try {
      await withJsTimeout(
        insertConn.query(SQL_INSERT_CLAIM, claimParams(M, T0)),
        6000,
        'insert vs ACCESS EXCLUSIVE',
      );
    } catch (err) {
      insertErr = err;
    }
    assert.ok(insertErr, 'insert must not commit while ACCESS EXCLUSIVE is held');
    assert.ok(
      isBlockOrTimeout(insertErr),
      `insert must block/timeout under ACCESS EXCLUSIVE, got ${insertErr && insertErr.code} ${insertErr && insertErr.message}`,
    );
    const stillEmpty = await downConn.query(
      'SELECT count(*)::int AS n FROM tenant_email_same_desk_auto_send_claims',
    );
    assert.equal(stillEmpty.rows[0].n, 0, 'insert cannot commit between emptiness check and DROP');
    await downConn.query('ROLLBACK');

    await insertConn.query("SET lock_timeout = '8s'");
    await insertConn.query("SET statement_timeout = '15s'");
    const afterRelease = await insertConn.query(SQL_INSERT_CLAIM, claimParams(M, T0));
    assert.equal(afterRelease.rows.length, 1, 'insert succeeds after ACCESS EXCLUSIVE is released');
    console.log('ok - insert blocked until ACCESS EXCLUSIVE released; no evidence-loss window');

    assert100DownLockContract(downSql);
  } finally {
    try { await insertConn.query('ROLLBACK'); } catch { /* */ }
    try { await downConn.query('ROLLBACK'); } catch { /* */ }
    try { await insertConn.end(); } catch { /* */ }
    try { await downConn.end(); } catch { /* */ }
  }
}

async function proveDownMigrations(a, Client, port, password) {
  try {
    await a.query(fs.readFileSync(MIG_100_DOWN, 'utf8'));
    assert.fail('nonempty 100 down should refuse');
  } catch (error) {
    assert.match(String(error.message), /100_down_refused/);
    try { await a.query('ROLLBACK'); } catch { /* idle */ }
  }
  console.log('ok - nonempty 100 down refuses evidence loss');

  const empty = new Client({
    host: '127.0.0.1', port, user: 'postgres', password, database: 'same_desk_004_empty',
  });
  const absent = new Client({
    host: '127.0.0.1', port, user: 'postgres', password, database: 'same_desk_004_absent',
  });
  try {
    await empty.connect();
    await empty.query(STUB_SCHEMA);
    await empty.query(fs.readFileSync(MIG_070, 'utf8'));
    await empty.query(fs.readFileSync(MIG_100_UP, 'utf8'));
    await empty.query(fs.readFileSync(MIG_100_DOWN, 'utf8'));
    const gone = await empty.query(
      "SELECT 1 AS ok FROM information_schema.tables WHERE table_name = 'tenant_email_same_desk_auto_send_claims'",
    );
    assert.equal(gone.rows.length, 0);
    console.log('ok - complete-up empty 100 down drops dedicated claim table');

    await absent.connect();
    await absent.query(STUB_SCHEMA);
    await absent.query(fs.readFileSync(MIG_100_DOWN, 'utf8'));
    const stillGone = await absent.query(
      "SELECT 1 AS ok FROM information_schema.tables WHERE table_name = 'tenant_email_same_desk_auto_send_claims'",
    );
    assert.equal(stillGone.rows.length, 0);
    console.log('ok - absent-table 100 down is safe');
  } finally {
    try { await empty.end(); } catch { /* */ }
    try { await absent.end(); } catch { /* */ }
  }
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
  assert.equal(typeof createSameDeskAutoSendClaimOwner, 'function');
  assert.match(SQL_INSERT_CLAIM, /lease_token/);
  assert.match(SQL_LINK_APPROVAL, /lease_token/);
  assert.match(SQL_RELEASE_CLAIM, /lease_token/);
  assert.match(SQL_BEGIN_DISPATCH, /dispatching/);

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
    await admin.query('CREATE DATABASE same_desk_004_empty');
    await admin.query('CREATE DATABASE same_desk_004_absent');
    await admin.query('CREATE DATABASE same_desk_004_race');
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
    await proveLeaseExpiryReclaimAndStaleOwner(a, b);
    await proveOutcomeUnknownNonRetryable(a, b);
    await proveDownVsConcurrentInsert(Client, port, password);
    await proveDownMigrations(a, Client, port, password);

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
