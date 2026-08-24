'use strict';

/**
 * Disposable stock PostgreSQL ACL + concurrency proof for 095 scoped claim.
 * Isolated embedded cluster, then stop and remove only this process's data dir.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  FUNCTION_SIGNATURES,
} = require('./lib/email-luna-automation-principal-contract');
const {
  provisionEmailLunaAutomationPrincipal,
} = require('./lib/email-luna-automation-principal-provision');
const {
  ids,
  PASSWORD,
  exclusiveSession,
  applyThrough088,
  revokePublicExecuteOutsideCatalogs,
} = require('./prove-email-luna-automation-issuance-material-pglite');
const {
  UP_093,
  UP_094,
  UP_095,
  DOWN_095,
  loadOwners,
  persistPending,
  workerDeps,
} = require('./prove-email-luna-automation-shadow-comparison-pglite');


const PG_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/pg';
const EMBEDDED_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/embedded-postgres/dist/index.js';
const CLAIM_SCOPED_REG = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_claim_scoped}`;
const CLAIM_REG = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_claim}`;
const UP_092 = fs.readFileSync(
  path.join(__dirname, '..', 'database/migrations/092_tenant_email_luna_automation_issuance_material.sql'),
  'utf8',
);
const WORKER_ROLE = 'luna_ch4b6_stock_worker';
const PRODUCER_ROLE = 'luna_ch4b6_stock_producer';

function resolvePg() {
  try {
    return require(PG_MODULE);
  } catch (error) {
    const failed = new Error(`stock-PG blocker: cannot require pg from ${PG_MODULE}: ${error && error.message ? error.message : error}`);
    failed.code = 'STOCK_PG_PG_MODULE_MISSING';
    throw failed;
  }
}

function wrapClient(client) {
  return {
    async exec(sql) {
      await client.query(sql);
    },
    async query(text, params) {
      return client.query(text, params);
    },
  };
}

async function hasExecute(client, role, signature) {
  const result = await client.query(
    `SELECT pg_catalog.has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`,
    [role, signature],
  );
  return result.rows[0].ok === true;
}

async function persistOlderForeignPending(client) {
  // Authentic Sunset envelope/orchestrator cannot mint a non-sunset-somo row.
  // Replica-role insert is the hostile fixture: an older other-tenant pending
  // row already in the shared 086 table. FK/triggers skipped; CHECKs still apply.
  await client.query('SET session_replication_role = replica');
  try {
    await client.query(
      `INSERT INTO public.tenant_email_luna_automation_queue (
         operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key,
         endpoint_id, conversation_id, inbound_event_id, recipient_address, recipient_digest,
         policy_version, eligibility_policy_version, validator_version, draft_digest,
         state, attempt_count, created_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'sunset-sardinero',
         $6::uuid, $7::uuid, $8::uuid, 'other.guest@example.test',
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('other.guest@example.test', 'UTF8')), 'hex'),
         'email-luna-draft-policy.v1',
         'email-luna-autonomous-eligibility-policy.v1',
         'email-luna-draft-validator.v1',
         $9,
         'pending', 0, pg_catalog.now() - INTERVAL '1 hour'
       )`,
      [
        ids.operation2,
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        ids.auditB,
        ids.client2,
        ids.location2,
        ids.endpoint2,
        ids.conversation2,
        ids.inbound2,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ],
    );
  } finally {
    await client.query('SET session_replication_role = DEFAULT');
  }
}

function snapshotRow(row) {
  return {
    operation_id: String(row.operation_id),
    client_id: String(row.client_id),
    location_id: String(row.location_id),
    endpoint_id: String(row.endpoint_id),
    state: row.state,
    attempt_count: Number(row.attempt_count),
    lease_owner: row.lease_owner == null ? null : String(row.lease_owner),
  };
}

async function queueRow(client, operationId) {
  const result = await client.query(
    `SELECT operation_id, client_id, location_id, endpoint_id, state, attempt_count, lease_owner
       FROM public.tenant_email_luna_automation_queue
      WHERE operation_id = $1::uuid`,
    [operationId],
  );
  assert.equal(result.rows.length, 1);
  return snapshotRow(result.rows[0]);
}

function portListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      try { socket.destroy(); } catch (_) { /* ignore */ }
      resolve(value);
    };
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function processMentionsDataDir(dir) {
  try {
    const out = execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' });
    return out.split('\n').some((line) => line.includes(dir));
  } catch (_) {
    return false;
  }
}

async function proveStockPg(client, connectClone) {
  const db = wrapClient(client);
  await applyThrough088(db);
  await revokePublicExecuteOutsideCatalogs(db);
  await db.exec(UP_092);
  await db.exec(UP_093);
  await db.exec(UP_094);
  await db.exec(UP_095);
  await db.exec(DOWN_095);
  await db.exec(DOWN_095);
  console.log('ok - stock-PG empty 095 down is repeatable');
  await db.exec(UP_095);

  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: PRODUCER_ROLE,
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: WORKER_ROLE,
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  assert.equal(await hasExecute(client, WORKER_ROLE, CLAIM_SCOPED_REG), true);
  assert.equal(await hasExecute(client, WORKER_ROLE, CLAIM_REG), true);
  assert.equal(await hasExecute(client, PRODUCER_ROLE, CLAIM_SCOPED_REG), false);
  assert.equal(await hasExecute(client, 'public', CLAIM_SCOPED_REG), false);
  console.log('ok - stock-PG ACL: worker scoped claim; producer/PUBLIC denied; 088 claim retained');

  const owners = loadOwners();
  const ownerLoaner = {
    async withTransactionClient(work) {
      return work({
        async query(text, params) {
          return client.query(text, params);
        },
      });
    },
  };
  await persistOlderForeignPending(client);
  await persistPending(owners, ownerLoaner, ids, ids.operation);
  const foreignBefore = await queueRow(client, ids.operation2);
  assert.equal(foreignBefore.state, 'pending');
  assert.equal(foreignBefore.client_id, ids.client2);

  const ownerScoped = await client.query(
    `SELECT operation_id FROM public.tenant_email_luna_automation_claim_scoped($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid)`,
    [ids.ownerA, ids.client, ids.location, 'sunset-somo', ids.endpoint],
  );
  assert.equal(ownerScoped.rows.length, 0, 'table owner cannot scoped-claim');
  assert.deepEqual(await queueRow(client, ids.operation2), foreignBefore);
  assert.equal((await queueRow(client, ids.operation)).state, 'pending');
  console.log('ok - stock-PG table-owner session rejected by scoped claim; older foreign row untouched');

  const workerA = await connectClone();
  const workerB = await connectClone();
  const producer = await connectClone();
  try {
    await workerA.query(`SET SESSION AUTHORIZATION ${WORKER_ROLE}`);
    await workerB.query(`SET SESSION AUTHORIZATION ${WORKER_ROLE}`);
    const wrong = await workerA.query(
      `SELECT operation_id FROM public.tenant_email_luna_automation_claim_scoped($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid)`,
      [ids.ownerA, ids.client, ids.location, 'sunset-somo', ids.endpoint2],
    );
    assert.equal(wrong.rows.length, 0);
    assert.equal((await queueRow(client, ids.operation)).state, 'pending');
    console.log('ok - stock-PG wrong endpoint UUID leaves Sunset pending row untouched');

    const firstClaim = await workerA.query(
      `SELECT operation_id, attempt_count, state FROM public.tenant_email_luna_automation_claim_scoped($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid)`,
      [ids.ownerA, ids.client, ids.location, 'sunset-somo', ids.endpoint],
    );
    assert.equal(firstClaim.rows.length, 1);
    assert.equal(firstClaim.rows[0].state, 'claimed');
    assert.equal(Number(firstClaim.rows[0].attempt_count), 1);
    await client.query('SET session_replication_role = replica');
    await client.query(
      `UPDATE public.tenant_email_luna_automation_queue
          SET lease_expires_at = pg_catalog.now() - INTERVAL '1 minute',
              attempt_count = 3
        WHERE operation_id = $1::uuid`,
      [ids.operation],
    );
    await client.query('SET session_replication_role = DEFAULT');
    const capped = await workerA.query(
      `SELECT operation_id FROM public.tenant_email_luna_automation_claim_scoped($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid)`,
      [ids.ownerA, ids.client, ids.location, 'sunset-somo', ids.endpoint],
    );
    assert.equal(capped.rows.length, 0);
    const afterCap = await queueRow(client, ids.operation);
    assert.equal(afterCap.state, 'claimed');
    assert.equal(afterCap.attempt_count, 3);
    await client.query('SET session_replication_role = replica');
    await client.query(
      `UPDATE public.tenant_email_luna_automation_queue
          SET lease_expires_at = pg_catalog.now() - INTERVAL '1 minute',
              attempt_count = 1
        WHERE operation_id = $1::uuid`,
      [ids.operation],
    );
    await client.query('SET session_replication_role = DEFAULT');
    console.log('ok - stock-PG attempt_count=3 expired lease is not scoped-claimed');

    function kernelFor(roleClient) {
      return owners.createEmailLunaAutomationShadowWorkerKernel(workerDeps({
        async withTransactionClient(work) {
          return work({
            async query(text, params) {
              return roleClient.query(text, params);
            },
          });
        },
      }, ids.client, ids.location, ids.ownerA));
    }
    const first = await kernelFor(workerA).processNextShadowClaim();
    assert.equal(first.status, 'would_send', first.reason);
    assert.equal(first.attempt_count, 2, 'stale expired lease is reclaimed and increments attempt');
    const second = await kernelFor(workerB).processNextShadowClaim();
    assert.ok(second.status === 'empty' || second.status === 'conflict');
    const concurrent = [first, second];
    assert.ok(concurrent.some((row) => row.status === 'would_send'));
    assert.ok(concurrent.some((row) => row.status === 'empty' || row.status === 'would_send' || row.status === 'conflict'));

    const foreignAfter = await queueRow(client, ids.operation2);
    assert.deepEqual(foreignAfter, foreignBefore, 'older cross-tenant row must remain untouched');

    await producer.query(`SET SESSION AUTHORIZATION ${PRODUCER_ROLE}`);
    let producerDenied = false;
    try {
      await producer.query(
        `SELECT operation_id FROM public.tenant_email_luna_automation_claim_scoped($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid)`,
        [ids.ownerA, ids.client, ids.location, 'sunset-somo', ids.endpoint],
      );
    } catch (error) {
      producerDenied = error && error.code === '42501';
    }
    assert.equal(producerDenied, true, 'producer EXECUTE on scoped claim is denied');
    console.log('ok - stock-PG exact worker principal scoped-claims Sunset only; producer denied; older row untouched');
  } finally {
    try { await workerA.end(); } catch (_) { /* ignore */ }
    try { await workerB.end(); } catch (_) { /* ignore */ }
    try { await producer.end(); } catch (_) { /* ignore */ }
  }

  await client.query('BEGIN');
  const unscoped = await client.query(
    `SELECT operation_id, client_id FROM public.tenant_email_luna_automation_claim($1::uuid, NULL)`,
    [ids.ownerA],
  );
  assert.equal(unscoped.rows.length, 1);
  assert.equal(String(unscoped.rows[0].client_id), ids.client2);
  await client.query('ROLLBACK');
  assert.deepEqual(await queueRow(client, ids.operation2), foreignBefore);
  console.log('ok - stock-PG 088 unscoped claim still exists for table owner and is rolled back');

  const outcomeCount = await client.query(
    'SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_shadow_outcomes WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(outcomeCount.rows[0].n, 1);
  const journalCount = await client.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(journalCount.rows[0].n, 0);
  console.log('ok - stock-PG concurrent scoped claim keeps one outcome and zero journal rows');

  await db.exec(DOWN_095);
  await db.exec(DOWN_095);
  const gone = await client.query(
    `SELECT pg_catalog.to_regprocedure('public.tenant_email_luna_automation_claim_scoped(uuid, uuid, uuid, text, uuid)') IS NOT NULL AS ok`,
  );
  assert.equal(gone.rows[0].ok, false);
  const unscopedStill = await client.query(
    `SELECT pg_catalog.to_regprocedure('public.tenant_email_luna_automation_claim(uuid, uuid)') IS NOT NULL AS ok`,
  );
  assert.equal(unscopedStill.rows[0].ok, true);
  console.log('ok - stock-PG 095 down is repeatable after rows exist; 088 unscoped claim remains');
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

  const dataDir = fs.mkdtempSync(path.join('/opt/data/local-postgres', 'ch4b6-095-stock-'));
  const port = 57111 + (process.pid % 97);
  const password = 'local-disposable-ch4b6';
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
  const client = new Client({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password,
    database: 'postgres',
  });
  try {
    await cluster.initialise();
    await cluster.start();
    started = true;
    await client.connect();
    await proveStockPg(client, async () => {
      const clone = new Client({
        host: '127.0.0.1',
        port,
        user: 'postgres',
        password,
        database: 'postgres',
      });
      await clone.connect();
      return clone;
    });
    console.log(`ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B6 stock-PG ACL/concurrency (${dataDir} port ${port})`);
  } finally {
    try { await client.end(); } catch (_) { /* ignore */ }
    if (started) {
      try { await cluster.stop(); } catch (_) { /* ignore */ }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(dataDir), false, 'stock-PG data dir must be removed');
    assert.equal(await portListening(port), false, 'stock-PG port must be closed');
    assert.equal(processMentionsDataDir(dataDir), false, 'stock-PG postgres process must not remain');
    console.log(`ok - stock-PG cluster cleanup (port ${port}, data dir gone)`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main };
