'use strict';

/**
 * Disposable stock PostgreSQL ACL + concurrency proof for 092 issuance material.
 * Starts an isolated embedded cluster on a high port, proves worker enqueue
 * EXECUTE is revoked by 092 (not trigger inertness), concurrent persist identity,
 * then stops and removes only this process's data directory.
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
  UP,
  DOWN,
  loadOwners,
  prepareBundle,
  persistAudit,
  exclusiveSession,
  applyThrough088,
  revokePublicExecuteOutsideCatalogs,
  assertStaticContract,
} = require('./prove-email-luna-automation-issuance-material-pglite');

const PG_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/pg';
const EMBEDDED_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/embedded-postgres/dist/index.js';
const ENQUEUE_REG = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_enqueue}`;
const PERSIST_REG = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_persist_and_enqueue}`;
const LOAD_REG = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_issuance_material_load}`;

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
  await revokePublicExecuteOutsideCatalogs(db);
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch4b1_stock_worker',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  assert.equal(await hasExecute(client, 'luna_ch4b1_stock_worker', ENQUEUE_REG), true, '088 worker enqueue EXECUTE');
  await db.exec(UP);
  assert.equal(
    await hasExecute(client, 'luna_ch4b1_stock_worker', ENQUEUE_REG),
    false,
    '092 REVOKE worker enqueue EXECUTE without re-provision',
  );
  await db.exec(DOWN);
  assert.equal(await hasExecute(client, 'luna_ch4b1_stock_worker', ENQUEUE_REG), true, 'down restores worker enqueue EXECUTE');
  await db.exec(DOWN);
  console.log('ok - stock-PG empty 092 down restores worker enqueue EXECUTE and is repeatable');
  await db.exec(UP);
  assert.equal(await hasExecute(client, 'luna_ch4b1_stock_worker', ENQUEUE_REG), false, 'second 092 up revokes enqueue again');

  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch4b1_stock_producer',
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch4b1_stock_worker',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  assert.equal(await hasExecute(client, 'luna_ch4b1_stock_worker', ENQUEUE_REG), false);
  assert.equal(await hasExecute(client, 'luna_ch4b1_stock_worker', LOAD_REG), true);
  assert.equal(await hasExecute(client, 'luna_ch4b1_stock_worker', PERSIST_REG), false);
  assert.equal(await hasExecute(client, 'luna_ch4b1_stock_producer', PERSIST_REG), true);
  assert.equal(await hasExecute(client, 'luna_ch4b1_stock_producer', ENQUEUE_REG), false);
  assert.equal(await hasExecute(client, 'luna_ch4b1_stock_producer', LOAD_REG), false);
  console.log('ok - stock-PG ACL: producer persist-only; worker load-only; enqueue revoked');

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
  const bundle = await prepareBundle(
    owners,
    { client: ids.client, location: ids.location, conversation: ids.conversation, endpoint: ids.endpoint },
    'sunset-somo',
    ids.inbound,
  );
  const audit = await persistAudit(owners, loaner, ids.audit, bundle);
  const persistInput = {
    operation_id: ids.operation,
    audit_operation_id: audit.operation_id,
    envelope: bundle.triplet.envelope,
    evidence: bundle.triplet.evidence,
    decision: bundle.triplet.decision,
    eligibility: bundle.eligibility,
    draft: bundle.draft,
    validation: bundle.validation,
  };
  const producerA = await connectClone();
  const producerB = await connectClone();
  try {
    await producerA.query('SET SESSION AUTHORIZATION luna_ch4b1_stock_producer');
    await producerB.query('SET SESSION AUTHORIZATION luna_ch4b1_stock_producer');
    function storeFor(roleClient) {
      return owners.createEmailLunaAutomationIssuanceMaterialStore({
        async withTransactionClient(work) {
          return work({
            async query(text, params) {
              return roleClient.query(text, params);
            },
          });
        },
      });
    }
    const concurrent = await Promise.all([
      storeFor(producerA).persistAndEnqueueAutomationIssuance(persistInput),
      storeFor(producerB).persistAndEnqueueAutomationIssuance(persistInput),
    ]);
    assert.equal(concurrent.every((row) => row.status === 'committed' || row.status === 'replayed' || row.status === 'conflict'), true);
    assert.ok(concurrent.some((row) => row.status === 'committed' || row.status === 'replayed'));
  } finally {
    try { await producerA.end(); } catch (_) { /* ignore */ }
    try { await producerB.end(); } catch (_) { /* ignore */ }
  }
  const materialCount = await client.query(
    'SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_issuance_material WHERE operation_id = $1',
    [ids.operation],
  );
  const queueCount = await client.query(
    'SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_queue WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(materialCount.rows[0].n, 1);
  assert.equal(queueCount.rows[0].n, 1);
  console.log('ok - stock-PG concurrent persist_and_enqueue keeps one material+queue identity');
  try {
    await db.exec(DOWN);
    assert.fail('nonempty material down should refuse');
  } catch (error) {
    assert.match(String(error.message), /092_down_refused/);
    try { await client.query('ROLLBACK'); } catch (_) { /* already idle */ }
  }
  console.log('ok - stock-PG nonempty 092 down refuses reconstitution-truth loss');
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

  const dataDir = fs.mkdtempSync(path.join('/opt/data/local-postgres', 'ch4b1-092-stock-'));
  const port = 56921 + (process.pid % 17);
  const password = 'local-disposable-ch4b';
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
    console.log(`ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B1 stock-PG ACL/concurrency (${dataDir} port ${port})`);
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
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main };
