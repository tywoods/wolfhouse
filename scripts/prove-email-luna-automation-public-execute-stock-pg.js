'use strict';

/**
 * Disposable stock PostgreSQL proof for C1 ambient PUBLIC EXECUTE hardening.
 * Isolated cluster; data dir removed. Covers pgcrypto/extension-owned
 * functions when CREATE EXTENSION is available.
 * If embedded-postgres is unavailable, this is not counted as PASS.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  applyThrough095,
  provePublicExecuteOnDatabase,
  proveNonSuperuserPgcryptoResidual,
  isDownRefused,
  isResidualRefuse,
  UP,
  DOWN,
} = require('./prove-email-luna-automation-public-execute-pglite');

const PG_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/pg';
const EMBEDDED_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/embedded-postgres/dist/index.js';

function resolvePg() {
  try {
    return require(PG_MODULE);
  } catch (error) {
    const failed = new Error('stock-PG unavailable: cannot require pg');
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

async function main() {
  const { Client } = resolvePg();
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import(EMBEDDED_MODULE));
  } catch (error) {
    const failed = new Error('stock-PG unavailable: cannot import embedded-postgres');
    failed.code = 'STOCK_PG_EMBEDDED_MISSING';
    throw failed;
  }

  const dataDir = fs.mkdtempSync(path.join('/opt/data/local-postgres', 'ch4c1-public-execute-stock-'));
  const port = 57431 + (process.pid % 97);
  const password = 'local-disposable-ch4c1';
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
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password,
    database: 'postgres',
  });
  const clients = [];
  try {
    await cluster.initialise();
    await cluster.start();
    started = true;
    await admin.connect();
    await admin.query('CREATE DATABASE ch4c1_public_execute');
    await admin.query('CREATE DATABASE ch4c1_pgcrypto_residual');
    await admin.query('CREATE DATABASE ch4c1_pgcrypto_wrongver');
    const proof = new Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: 'ch4c1_public_execute',
    });
    await proof.connect();
    clients.push(proof);
    const residual = new Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: 'ch4c1_pgcrypto_residual',
    });
    await residual.connect();
    clients.push(residual);
    const wrongver = new Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: 'ch4c1_pgcrypto_wrongver',
    });
    await wrongver.connect();
    clients.push(wrongver);
    const db = wrapClient(proof);
    const residualDb = wrapClient(residual);
    const wrongverDb = wrapClient(wrongver);
    const empty = wrapClient(admin);

    await assert.rejects(
      () => empty.exec(UP),
      (err) => /queue table owner missing/.test(String(err && err.message)),
    );
    try { await empty.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    await assert.rejects(
      () => empty.exec(DOWN),
      isDownRefused,
    );
    console.log('ok - stock-PG empty database fail-closes 096 and 096_down');

    await applyThrough095(db);
    await provePublicExecuteOnDatabase(db, { tryPgcrypto: true, expectDefaultPrivileges: true });
    const identity = await proof.query('SELECT current_database() AS database, session_user AS session_user');
    assert.equal(identity.rows[0].database, 'ch4c1_public_execute');
    assert.equal(identity.rows[0].session_user, 'postgres');
    assert.equal(/sunset_staging|wolfhouse_prod/.test(identity.rows[0].database), false);

    await proveNonSuperuserPgcryptoResidual(residualDb, {
      realPgcrypto: true,
      expectDefaultPrivileges: true,
    });

    await wrongverDb.exec('GRANT USAGE, CREATE ON SCHEMA public TO luna_ch4c1_appowner');
    await wrongverDb.exec('SET SESSION AUTHORIZATION luna_ch4c1_appowner');
    await applyThrough095(wrongverDb);
    await wrongverDb.exec('SET SESSION AUTHORIZATION postgres');
    await wrongverDb.exec('CREATE EXTENSION pgcrypto');
    const installed = await wrongver.query('SELECT extversion FROM pg_catalog.pg_extension WHERE extname = \'pgcrypto\'');
    const defaultVersion = installed.rows[0] && installed.rows[0].extversion;
    if (defaultVersion && defaultVersion !== '1.3') {
      await wrongverDb.exec('SET SESSION AUTHORIZATION luna_ch4c1_appowner');
      await assert.rejects(() => wrongverDb.exec(UP), isResidualRefuse);
      try { await wrongverDb.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      await wrongverDb.exec('SET SESSION AUTHORIZATION postgres');
      console.log(`ok - GREEN default pgcrypto ${defaultVersion} residual fail-closes (not pinned 1.3)`);
    } else {
      console.log(`ok - default pgcrypto is ${defaultVersion || 'absent'}; wrong-version gate uses 1.3 pin in residual db`);
    }

    console.log(`ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1 public EXECUTE stock-PG (${dataDir} port ${port})`);
  } finally {
    for (const client of clients) {
      try { await client.end(); } catch (_) { /* ignore */ }
    }
    try { await admin.end(); } catch (_) { /* ignore */ }
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
    if (error && (error.code === 'STOCK_PG_PG_MODULE_MISSING' || error.code === 'STOCK_PG_EMBEDDED_MISSING')) {
      console.log(`ok - stock-PG UNAVAILABLE (${error.code}) — not counted as PASS`);
      return;
    }
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main };
