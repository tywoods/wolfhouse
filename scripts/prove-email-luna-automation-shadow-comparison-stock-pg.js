'use strict';

/**
 * Disposable stock PostgreSQL ACL + concurrency proof for 093 shadow outcomes.
 * Isolated embedded cluster, then stop and remove only this process's data dir.
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
} = require('./prove-email-luna-automation-issuance-material-pglite');
const {
  UP_093,
  DOWN_093,
  loadOwners,
  persistPending,
  workerDeps,
  assertStaticContract,
} = require('./prove-email-luna-automation-shadow-comparison-pglite');

const PG_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/pg';
const EMBEDDED_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/embedded-postgres/dist/index.js';
const CAPTURE_REG = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_capture_shadow}`;
const LOAD_REG = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_shadow_outcome_load}`;
const PROJECT_REG = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_shadow_outcome_project}`;
const PERSIST_REG = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_persist_and_enqueue}`;
const UP_092 = fs.readFileSync(
  path.join(__dirname, '..', 'database/migrations/092_tenant_email_luna_automation_issuance_material.sql'),
  'utf8',
);

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
  await db.exec(UP_092);
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch4b4_stock_worker',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await db.exec(UP_093);
  assert.equal(await hasExecute(client, 'luna_ch4b4_stock_worker', CAPTURE_REG), false, '093 does not GRANT capture');
  await db.exec(DOWN_093);
  await db.exec(DOWN_093);
  console.log('ok - stock-PG empty 093 down is repeatable');
  await db.exec(UP_093);

  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch4b4_stock_producer',
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: 'luna_ch4b4_stock_worker',
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });
  assert.equal(await hasExecute(client, 'luna_ch4b4_stock_worker', CAPTURE_REG), true);
  assert.equal(await hasExecute(client, 'luna_ch4b4_stock_worker', LOAD_REG), true);
  assert.equal(await hasExecute(client, 'luna_ch4b4_stock_worker', PROJECT_REG), true);
  assert.equal(await hasExecute(client, 'luna_ch4b4_stock_worker', PERSIST_REG), false);
  assert.equal(await hasExecute(client, 'luna_ch4b4_stock_producer', CAPTURE_REG), false);
  assert.equal(await hasExecute(client, 'luna_ch4b4_stock_producer', PERSIST_REG), true);
  console.log('ok - stock-PG ACL: worker capture/load/project; producer denied capture');

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
  await persistPending(owners, loaner, ids, ids.operation);
  const workerA = await connectClone();
  const workerB = await connectClone();
  try {
    await workerA.query('SET SESSION AUTHORIZATION luna_ch4b4_stock_worker');
    await workerB.query('SET SESSION AUTHORIZATION luna_ch4b4_stock_worker');
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
    const concurrent = await Promise.all([
      kernelFor(workerA).processNextShadowClaim(),
      kernelFor(workerB).processNextShadowClaim(),
    ]);
    assert.equal(concurrent.every((row) => row.status === 'would_send' || row.status === 'empty' || row.status === 'conflict'), true);
    assert.ok(concurrent.some((row) => row.status === 'would_send' || row.status === 'empty'));
  } finally {
    try { await workerA.end(); } catch (_) { /* ignore */ }
    try { await workerB.end(); } catch (_) { /* ignore */ }
  }
  const outcomeCount = await client.query(
    'SELECT COUNT(*)::int AS n FROM public.tenant_email_luna_automation_shadow_outcomes WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(outcomeCount.rows[0].n, 1);
  const journalCount = await client.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(journalCount.rows[0].n, 0);
  console.log('ok - stock-PG concurrent capture keeps one outcome and zero journal rows');
  try {
    await db.exec(DOWN_093);
    assert.fail('nonempty outcome down should refuse');
  } catch (error) {
    assert.match(String(error.message), /093_down_refused/);
    try { await client.query('ROLLBACK'); } catch (_) { /* already idle */ }
  }
  console.log('ok - stock-PG nonempty 093 down refuses comparison-evidence loss');
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

  const dataDir = fs.mkdtempSync(path.join('/opt/data/local-postgres', 'ch4b4-093-stock-'));
  const port = 56941 + (process.pid % 17);
  const password = 'local-disposable-ch4b4';
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
    console.log(`ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B4 stock-PG ACL/concurrency (${dataDir} port ${port})`);
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
