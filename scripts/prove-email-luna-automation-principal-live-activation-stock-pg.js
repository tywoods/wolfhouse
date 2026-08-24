'use strict';

/**
 * Disposable stock PostgreSQL proof for C1 Sunset staging trusted-precreated
 * activation on a real sunset_staging database. Isolated cluster; data dir removed.
 * If embedded-postgres is unavailable, this is not counted as PASS.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  exclusiveSession,
} = require('./prove-email-luna-automation-issuance-material-pglite');
const {
  applyThrough095,
  proveOnDatabase,
} = require('./prove-email-luna-automation-principal-live-activation-pglite');

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

  const dataDir = fs.mkdtempSync(path.join('/opt/data/local-postgres', 'ch4c1-live-principal-stock-'));
  const port = 57331 + (process.pid % 97);
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
  let sunset = null;
  try {
    await cluster.initialise();
    await cluster.start();
    started = true;
    await admin.connect();
    await admin.query('CREATE DATABASE sunset_staging');
    sunset = new Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: 'sunset_staging',
    });
    await sunset.connect();
    const db = wrapClient(sunset);
    const adminDb = wrapClient(admin);
    await applyThrough095(db);
    await proveOnDatabase(db, {
      wrapSunsetIdentity: false,
      proveDefaultTrustedPrecreated: false,
      nonSunsetSession: exclusiveSession(adminDb),
    });
    const identity = await sunset.query('SELECT current_database() AS database, session_user AS session_user');
    assert.equal(identity.rows[0].database, 'sunset_staging');
    assert.equal(identity.rows[0].session_user, 'postgres');
    console.log(`ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1 live-principal activation stock-PG (${dataDir} port ${port})`);
  } finally {
    try { if (sunset) await sunset.end(); } catch (_) { /* ignore */ }
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
