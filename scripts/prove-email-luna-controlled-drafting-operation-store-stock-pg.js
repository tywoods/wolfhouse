'use strict';

/**
 * Disposable stock PostgreSQL ACL + concurrency proof for 097 controlled drafts.
 * Isolated embedded cluster; SKIP honestly when pg / embedded-postgres is missing.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  loadOwners,
} = require('./prove-email-luna-automation-issuance-material-pglite');
const {
  UP,
  DOWN,
  assertStaticContract,
  applyCommittedInbound063Identity,
  loadDraftStore,
  ackFor,
  persistIssuance,
} = require('./prove-email-luna-controlled-drafting-operation-store-pglite');

const PG_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/pg';
const EMBEDDED_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/embedded-postgres/dist/index.js';
const UP_092 = fs.readFileSync(
  path.join(__dirname, '..', 'database/migrations/092_tenant_email_luna_automation_issuance_material.sql'),
  'utf8',
);
const RESERVE_REG = `public.${FUNCTION_SIGNATURES.tenant_email_luna_controlled_draft_reserve}`;
const CLAIM_REG = `public.${FUNCTION_SIGNATURES.tenant_email_luna_controlled_draft_claim_create}`;
const RECORD_REG = `public.${FUNCTION_SIGNATURES.tenant_email_luna_controlled_draft_record_create}`;
const LOAD_REG = `public.${FUNCTION_SIGNATURES.tenant_email_luna_controlled_draft_load}`;

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

async function proveStockPg(client, connectClone) {
  const db = wrapClient(client);
  assertStaticContract();
  await applyThrough088(db);
  await db.exec(UP_092);
  await applyCommittedInbound063Identity(db);
  await revokePublicExecuteOutsideCatalogs(db);
  await db.exec(DOWN);
  await db.exec(UP);
  await db.exec(DOWN);
  console.log('ok - stock-PG empty 097 down is repeatable');
  await db.exec(UP);
  await revokePublicExecuteOutsideCatalogs(db);

  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch2_stock_worker',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch2_stock_producer',
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  assert.equal(await hasExecute(client, 'luna_ch2_stock_worker', CLAIM_REG), true);
  assert.equal(await hasExecute(client, 'luna_ch2_stock_worker', RECORD_REG), true);
  assert.equal(await hasExecute(client, 'luna_ch2_stock_worker', LOAD_REG), true);
  assert.equal(await hasExecute(client, 'luna_ch2_stock_worker', RESERVE_REG), false);
  assert.equal(await hasExecute(client, 'luna_ch2_stock_producer', RESERVE_REG), true);
  assert.equal(await hasExecute(client, 'luna_ch2_stock_producer', LOAD_REG), true);
  assert.equal(await hasExecute(client, 'luna_ch2_stock_producer', CLAIM_REG), false);
  const tableAcl = await client.query(`
    SELECT
      pg_catalog.has_table_privilege('luna_ch2_stock_producer', 'public.tenant_email_luna_controlled_draft_operations', 'SELECT') AS producer_select,
      pg_catalog.has_table_privilege('luna_ch2_stock_worker', 'public.tenant_email_luna_controlled_draft_operations', 'INSERT') AS worker_insert,
      pg_catalog.has_table_privilege('luna_ch2_stock_producer', 'public.tenant_email_luna_controlled_draft_transitions', 'DELETE') AS producer_tr_delete,
      pg_catalog.has_table_privilege('luna_ch2_stock_worker', 'public.tenant_email_luna_controlled_draft_transitions', 'SELECT') AS worker_tr_select
  `);
  assert.equal(tableAcl.rows[0].producer_select, false);
  assert.equal(tableAcl.rows[0].worker_insert, false);
  assert.equal(tableAcl.rows[0].producer_tr_delete, false);
  assert.equal(tableAcl.rows[0].worker_tr_select, false);
  console.log('ok - stock-PG ACL: producer reserve/load; worker claim/record/load; no PUBLIC; 097 table DML revoked');

  const publicExec = await client.query(
    `SELECT pg_catalog.has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS ok`,
    [CLAIM_REG],
  );
  assert.equal(publicExec.rows[0].ok, false);

  const owners = loadOwners();
  const loaner = {
    async withTransactionClient(work) {
      return work({
        async query(text, params) {
          return client.query(text, params);
        },
      });
    },
  };
  const seeded = await persistIssuance(db, owners, loaner, ids.operation, ids.audit);
  const storeMod = loadDraftStore();
  const producerA = await connectClone();
  const producerB = await connectClone();
  const workerA = await connectClone();
  const workerB = await connectClone();
  try {
    await producerA.query('SET SESSION AUTHORIZATION luna_ch2_stock_producer');
    await producerB.query('SET SESSION AUTHORIZATION luna_ch2_stock_producer');
    await workerA.query('SET SESSION AUTHORIZATION luna_ch2_stock_worker');
    await workerB.query('SET SESSION AUTHORIZATION luna_ch2_stock_worker');
    function storeFor(roleClient) {
      return storeMod.createEmailLunaControlledDraftingOperationStore({
        async withTransactionClient(work) {
          return work({
            async query(text, params) {
              return roleClient.query(text, params);
            },
          });
        },
      });
    }
    const reserveInput = {
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
      canonical_subject: seeded.bundle.draft.subject,
      canonical_body: seeded.bundle.draft.body,
      language: seeded.bundle.draft.language,
    };

    const locker = await connectClone();
    const racer = await connectClone();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE public.tenant_email_luna_controlled_draft_transitions IN ACCESS EXCLUSIVE MODE');
      await locker.query('LOCK TABLE public.tenant_email_luna_controlled_draft_operations IN ACCESS EXCLUSIVE MODE');
      const emptyOps = await locker.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_controlled_draft_operations');
      const emptyTr = await locker.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_controlled_draft_transitions');
      assert.equal(emptyOps.rows[0].n, 0);
      assert.equal(emptyTr.rows[0].n, 0);
      await racer.query("SET lock_timeout = '800ms'");
      let raceErr = null;
      try {
        await racer.query(
          'INSERT INTO public.tenant_email_luna_controlled_draft_operations SELECT * FROM public.tenant_email_luna_controlled_draft_operations',
        );
      } catch (error) {
        raceErr = error;
      }
      assert.ok(raceErr, 'concurrent insert must not commit while ACCESS EXCLUSIVE is held');
      assert.match(String(raceErr.code || raceErr.message), /55P03|lock timeout|canceling statement/i);
      const stillEmpty = await locker.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_controlled_draft_operations');
      assert.equal(stillEmpty.rows[0].n, 0);
      await locker.query('ROLLBACK');
    } finally {
      try { await locker.query('ROLLBACK'); } catch (_) { /* ignore */ }
      try { await locker.end(); } catch (_) { /* ignore */ }
      try { await racer.end(); } catch (_) { /* ignore */ }
    }
    console.log('ok - stock-PG two-session DOWN race: insert cannot commit between emptiness check and DROP');

    const reserved = await Promise.all([
      storeFor(producerA).reserveControlledDraft(reserveInput),
      storeFor(producerB).reserveControlledDraft(reserveInput),
    ]);
    const reservedWins = reserved.filter((row) => row.status === 'reserved');
    const reservedReplays = reserved.filter((row) => row.status === 'replayed');
    assert.equal(reservedWins.length, 1, 'exactly one first reserve winner');
    assert.equal(reservedReplays.length, reserved.length - 1);
    assert.ok(reserved.every((row) => row.status === 'reserved' || row.status === 'replayed'));
    const opCount = await client.query(
      'SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_controlled_draft_operations WHERE operation_id = $1',
      [ids.operation],
    );
    assert.equal(opCount.rows[0].n, 1);

    const claims = await Promise.all([
      storeFor(workerA).claimCreateDispatch({
        operation_id: ids.operation,
        issuance_id: seeded.issuanceId,
        expected_generation: null,
      }),
      storeFor(workerB).claimCreateDispatch({
        operation_id: ids.operation,
        issuance_id: seeded.issuanceId,
        expected_generation: null,
      }),
    ]);
    const claimWins = claims.filter((row) => row.status === 'create_dispatched_outcome_unknown');
    const claimReplays = claims.filter((row) => row.status === 'replayed');
    assert.equal(claimWins.length, 1, 'exactly one first claim transition');
    assert.equal(claimReplays.length, claims.length - 1);
    assert.ok(claims.every((row) => row.record.create_dispatch_claimed === true));
    assert.equal(new Set(claims.map((row) => row.record.state_generation)).size, 1);
    const winner = claims.find((row) => row.status === 'create_dispatched_outcome_unknown') || claims[0];
    const recorded = await storeFor(workerA).recordProviderCreate({
      operation_id: ids.operation,
      issuance_id: seeded.issuanceId,
      expected_generation: winner.record.state_generation,
      acknowledgement: ackFor(winner.record),
    });
    assert.equal(recorded.status, 'provider_draft_reconciled_exact');
  } finally {
    for (const clone of [producerA, producerB, workerA, workerB]) {
      try { await clone.end(); } catch (_) { /* ignore */ }
    }
  }
  console.log('ok - stock-PG concurrent reserve/claim keeps one operation and one create dispatch');

  try {
    await db.exec(DOWN);
    assert.fail('nonempty 097 down should refuse');
  } catch (error) {
    assert.match(String(error.message), /097_down_refused/);
    try { await client.query('ROLLBACK'); } catch (_) { /* already idle */ }
  }
  console.log('ok - stock-PG nonempty 097 down refuses evidence loss');
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

  const dataDir = fs.mkdtempSync(path.join('/opt/data/local-postgres', 'ch2-097-stock-'));
  const port = 56941 + (process.pid % 17);
  const password = 'local-disposable-ch2';
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
    console.log(`ALL OK — FULL SAIL Stage 2 Chapter 2 stock-PG ACL/concurrency (${dataDir} port ${port})`);
  } finally {
    try { await client.end(); } catch (_) { /* ignore */ }
    if (started) {
      try { await cluster.stop(); } catch (_) { /* ignore */ }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    if (error && (error.code === 'STOCK_PG_PG_MODULE_MISSING' || error.code === 'STOCK_PG_EMBEDDED_MISSING')) {
      console.log(`ok - stock-PG UNAVAILABLE (${error.code}) — not counted as PASS`);
      return;
    }
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main };
