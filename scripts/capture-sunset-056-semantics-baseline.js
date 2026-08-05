'use strict';

/**
 * Capture canonical migration-056 semantics baseline from disposable Postgres.
 * Writes fixtures/sunset-staging-ledger-reconcile/canonical-056-semantics-baseline.json
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  CHECKSUM_MODE_CANONICAL_LF_V1,
  MIGRATIONS_DIR,
  prepareMigrationBody,
} = require('./lib/migration-integrity');
const { ensureLedger, applyOne } = require('./run-canonical-migrations');
const lib = require('./lib/sunset-staging-ledger-reconcile');
const { captureSemanticCatalog, BASELINE_PATH } = require('./lib/sunset-staging-ledger-reconcile-semantics');

const ROOT = path.join(__dirname, '..');
const DB_NAME = 'sunset_staging';

async function applySqlFile(client, filename) {
  const prepared = prepareMigrationBody(fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8'));
  if (!prepared.ok) throw new Error(`prepare failed: ${filename}`);
  await client.query(prepared.body);
}

async function captureFromConnection(connection) {
  const client = new Client(connection);
  await client.connect();
  const ctx = lib.loadManifestContext();
  await ensureLedger(client);
  for (const entry of ctx.forward.slice(0, lib.PREFIX_END_ORDER)) {
    await applyOne(client, entry, MIGRATIONS_DIR, null, CHECKSUM_MODE_CANONICAL_LF_V1);
  }
  await applySqlFile(client, ctx.entries[0].filename);
  await applySqlFile(client, ctx.entries[4].filename);
  const captured = await captureSemanticCatalog(client);
  await client.end();
  return captured;
}

async function captureWithDocker() {
  const suffix = crypto.randomBytes(3).toString('hex');
  const container = `wh-sunset-056-baseline-${suffix}`;
  const port = 55430 + (parseInt(suffix, 16) % 200);
  const admin = { host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres' };
  execFileSync('docker', ['run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=postgres', '-p', `${port}:5432`, 'postgres:16'], { stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 8000));
  try {
    for (let i = 0; i < 40; i += 1) {
      const c = new Client({ ...admin, connectionTimeoutMillis: 1000 });
      try {
        await c.connect();
        await c.query('SELECT 1');
        await c.end();
        break;
      } catch (_) {
        try { await c.end(); } catch (e) { /* ignore */ }
        if (i === 39) throw new Error('postgres not ready');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const boot = new Client(admin);
    await boot.connect();
    await boot.query(`CREATE DATABASE ${DB_NAME}`);
    await boot.end();
    return captureFromConnection({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: DB_NAME });
  } finally {
    try { execFileSync('docker', ['rm', '-f', container], { stdio: 'inherit' }); } catch (_) { /* ignore */ }
  }
}

async function main() {
  const connection = process.env.SUNSET_056_BASELINE_CONNECTION
    ? JSON.parse(process.env.SUNSET_056_BASELINE_CONNECTION)
    : null;
  const captured = connection
    ? await captureFromConnection(connection)
    : await captureWithDocker();
  const payload = {
    capturedAt: new Date().toISOString(),
    source: 'disposable-postgres-canonical-056-060-prefix',
    catalog: captured.row,
    fingerprint: captured.fingerprint,
  };
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, path: BASELINE_PATH, fingerprint: captured.fingerprint }, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}

module.exports = { captureFromConnection, main };
