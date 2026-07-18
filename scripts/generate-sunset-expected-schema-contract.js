'use strict';

/**
 * generate-sunset-expected-schema-contract — FOUNDATION Slice 6
 * Builds fixtures/sunset-schema-observer/expected-product-schema.json from the
 * canonical 36-migration chain on disposable local PostgreSQL.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  MANIFEST_PATH,
} = require('./lib/migration-integrity');
const { runCanonicalMigrations } = require('./run-canonical-migrations');
const {
  introspectProductSchema,
  fingerprintProductSchema,
  hashCanonicalManifest,
  LEDGER_TABLE,
} = require('./lib/sunset-schema-observer');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'expected-product-schema.json');

const suffix = crypto.randomBytes(4).toString('hex');
const CONTAINER = `wh-obs-contract-${suffix}`;
const VOLUME = `wh-obs-contract-vol-${suffix}`;
const DB = `wh_mig_obs_${suffix}`;
const USER = `wh_mig_u_${suffix}`;
const PASSWORD = crypto.randomBytes(18).toString('base64url');

function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function cleanup() {
  try { docker(['rm', '-f', CONTAINER]); } catch (_) { /* ignore */ }
  try { docker(['volume', 'rm', '-f', VOLUME]); } catch (_) { /* ignore */ }
}

async function waitForPg(connection, attempts) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    const client = new Client({ ...connection, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (e) {
      last = e;
      try { await client.end(); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last || new Error('postgres never ready');
}

async function main() {
  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) {
    console.error(JSON.stringify(integrity.errors.slice(0, 5), null, 2));
    process.exit(1);
  }
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);

  cleanup();
  docker([
    'run', '-d', '--name', CONTAINER,
    '-e', `POSTGRES_USER=${USER}`,
    '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
    '-e', 'POSTGRES_DB=postgres',
    '-p', '127.0.0.1::5432',
    '-v', `${VOLUME}:/var/lib/postgresql/data`,
    'postgres:15-alpine',
  ]);
  const portMap = String(docker(['port', CONTAINER, '5432/tcp'])).trim();
  const port = Number(portMap.match(/:(\d+)\s*$/)[1]);
  const admin = { host: '127.0.0.1', port, user: USER, password: PASSWORD, database: 'postgres' };
  await waitForPg(admin, 60);
  const adminClient = new Client(admin);
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE ${DB}`);
  await adminClient.end();

  const conn = { ...admin, database: DB };
  const applied = await runCanonicalMigrations({ connection: conn });
  if (!applied.ok) {
    console.error(JSON.stringify(applied.errors, null, 2));
    cleanup();
    process.exit(1);
  }

  const client = new Client(conn);
  await client.connect();
  const { snapshot } = await introspectProductSchema(client);
  // Prove ledger exclusion: ledger may exist after migrations but must not appear in product tables.
  if ((snapshot.tables || []).includes(LEDGER_TABLE)) {
    throw new Error('ledger leaked into product snapshot');
  }
  const productFingerprint = fingerprintProductSchema(snapshot);
  await client.end();

  const contract = {
    kind: 'sunset-expected-product-schema',
    generatedAt: new Date().toISOString(),
    forwardCount: forward.length,
    manifestHash,
    productFingerprint,
    excludes: [LEDGER_TABLE],
    note: 'schema_migration_ledger excluded from product equivalence',
    snapshot,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(contract, null, 2)}\n`);
  cleanup();
  console.log(JSON.stringify({
    ok: true,
    out: OUT,
    forwardCount: forward.length,
    manifestHash,
    productFingerprint,
  }, null, 2));
}

main().catch((e) => {
  cleanup();
  console.error(e);
  process.exit(1);
});
