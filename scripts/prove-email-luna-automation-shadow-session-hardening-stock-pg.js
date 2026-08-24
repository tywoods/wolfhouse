'use strict';

/**
 * Disposable stock PostgreSQL proof for B7 live session_user/current_user
 * mapping and 095 EXECUTE. Isolated embedded cluster; data dir removed.
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
  inspectEmailLunaAutomationShadowWorkerSession,
} = require('./lib/email-luna-automation-shadow-session-proof');
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
} = require('./prove-email-luna-automation-shadow-comparison-pglite');

const PG_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/pg';
const EMBEDDED_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/embedded-postgres/dist/index.js';
const WORKER_ROLE = 'luna_ch4b7_stock_worker';
const UNMAPPED_ROLE = 'luna_ch4b7_stock_unmapped';
const OVERLAY_ROLE = 'luna_ch4b7_stock_overlay';
const CLAIM_SCOPED = `public.${FUNCTION_SIGNATURES.tenant_email_luna_automation_claim_scoped}`;
const UP_092 = fs.readFileSync(
  path.join(__dirname, '..', 'database/migrations/092_tenant_email_luna_automation_issuance_material.sql'),
  'utf8',
);

function resolvePg() {
  try {
    return require(PG_MODULE);
  } catch (error) {
    const failed = new Error('stock-PG blocker: cannot require pg');
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

function binding(patch = {}) {
  return {
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    ...patch,
  };
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

async function proveStockPg(ownerClient, connectAs) {
  const db = wrapClient(ownerClient);
  await applyThrough088(db);
  await db.exec(UP_092);
  await db.exec(UP_093);
  await db.exec(UP_094);
  await db.exec(UP_095);
  await revokePublicExecuteOutsideCatalogs(db);

  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: WORKER_ROLE,
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: PASSWORD,
    apply: true,
  });

  const ownerProof = await inspectEmailLunaAutomationShadowWorkerSession(ownerClient, binding());
  assert.equal(ownerProof.ok, false);
  assert.equal(ownerProof.worker_principal_ok, false);
  console.log('ok - stock-PG table-owner session fails inspect');

  const workerClient = await connectAs(WORKER_ROLE, PASSWORD);
  try {
    const mapped = await inspectEmailLunaAutomationShadowWorkerSession(workerClient, binding());
    assert.equal(mapped.ok, true);
    assert.equal(mapped.worker_principal_ok, true);
    assert.equal(mapped.scoped_claim_applied, true);
    console.log('ok - stock-PG mapped worker session proves current=session, mapping, 095 EXECUTE');

    const wrongLocation = await inspectEmailLunaAutomationShadowWorkerSession(workerClient, binding({
      location_id: ids.location2,
    }));
    assert.equal(wrongLocation.ok, false);
    assert.equal(wrongLocation.worker_principal_ok, false);
    console.log('ok - stock-PG mapped worker for wrong location fails inspect');
  } finally {
    await workerClient.end();
  }

  await ownerClient.query(
    `CREATE ROLE ${UNMAPPED_ROLE} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
  const unmappedClient = await connectAs(UNMAPPED_ROLE, PASSWORD);
  try {
    const unmapped = await inspectEmailLunaAutomationShadowWorkerSession(unmappedClient, binding());
    assert.equal(unmapped.ok, false);
    assert.equal(unmapped.worker_principal_ok, false);
    console.log('ok - stock-PG unmapped login fails inspect');
  } finally {
    await unmappedClient.end();
  }

  await ownerClient.query(`REVOKE ALL ON FUNCTION ${CLAIM_SCOPED} FROM ${WORKER_ROLE}`);
  const revokedClient = await connectAs(WORKER_ROLE, PASSWORD);
  try {
    const revoked = await inspectEmailLunaAutomationShadowWorkerSession(revokedClient, binding());
    assert.equal(revoked.ok, false);
    assert.equal(revoked.worker_principal_ok, false);
    console.log('ok - stock-PG missing 095 EXECUTE fails inspect');
  } finally {
    await revokedClient.end();
  }
  await ownerClient.query(`GRANT EXECUTE ON FUNCTION ${CLAIM_SCOPED} TO ${WORKER_ROLE}`);

  await ownerClient.query(
    `CREATE ROLE ${OVERLAY_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
  await ownerClient.query(`GRANT ${OVERLAY_ROLE} TO ${WORKER_ROLE}`);
  const overlayClient = await connectAs(WORKER_ROLE, PASSWORD);
  try {
    await overlayClient.query(`SET ROLE ${OVERLAY_ROLE}`);
    const overlay = await inspectEmailLunaAutomationShadowWorkerSession(overlayClient, binding());
    assert.equal(overlay.ok, false);
    assert.equal(overlay.worker_principal_ok, false);
    const users = await overlayClient.query('SELECT session_user::text AS s, current_user::text AS c');
    assert.notEqual(users.rows[0].s, users.rows[0].c);
    console.log('ok - stock-PG SET ROLE overlay (current_user != session_user) fails inspect');
  } finally {
    await overlayClient.end();
  }
}

async function main() {
  const { Client } = resolvePg();
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import(EMBEDDED_MODULE));
  } catch (error) {
    const failed = new Error('stock-PG blocker: cannot import embedded-postgres');
    failed.code = 'STOCK_PG_EMBEDDED_MISSING';
    throw failed;
  }

  const dataDir = fs.mkdtempSync(path.join('/opt/data/local-postgres', 'ch4b7-session-stock-'));
  const port = 57211 + (process.pid % 97);
  const password = 'local-disposable-ch4b7';
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
    await proveStockPg(client, async (user, rolePassword) => {
      const clone = new Client({
        host: '127.0.0.1',
        port,
        user,
        password: rolePassword,
        database: 'postgres',
      });
      await clone.connect();
      return clone;
    });
    console.log(`ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B7 stock-PG session proof (${dataDir} port ${port})`);
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
