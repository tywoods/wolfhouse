'use strict';

/**
 * Stock PostgreSQL LOGIN proof for Stage 2 Chapter 4E.
 * Distinct producer/worker TCP LOGINs. Owner / SET ROLE / unmapped fail.
 * Microsoft/JWKS remain fake. SKIP honestly when embedded PostgreSQL is unavailable.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  inspectEmailLunaControlledDraftingSession,
  MIGRATION_097_ID,
  MIGRATION_097_SHA256,
  MIGRATION_098_ID,
  MIGRATION_098_SHA256,
  EXPECTED_CHECKSUM_MODE,
} = require('./lib/email-luna-controlled-drafting-session-proof');
const { LEDGER_DDL } = require('./lib/migration-integrity');
const {
  ids,
  PASSWORD,
  applyCommittedInbound063Identity,
} = require('./prove-email-luna-controlled-drafting-operation-store-pglite');
const {
  exclusiveSession,
  applyThrough088,
  revokePublicExecuteOutsideCatalogs,
} = require('./prove-email-luna-automation-issuance-material-pglite');
const {
  provisionEmailLunaAutomationPrincipal,
} = require('./lib/email-luna-automation-principal-provision');
const { createRoleSql } = require('./lib/email-luna-automation-principal-contract');
const { checksumMigrationFile, CHECKSUM_MODE_CANONICAL_LF_V1 } = require('./lib/migration-integrity');

const PG_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/pg';
const EMBEDDED_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/embedded-postgres/dist/index.js';
const ROOT = path.join(__dirname, '..');
const UP_092 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/092_tenant_email_luna_automation_issuance_material.sql'),
  'utf8',
);
const UP_097 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/097_tenant_email_luna_controlled_draft_operations.sql'),
  'utf8',
);
const UP_098 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/098_tenant_email_luna_controlled_drafting_staging_test_authorization.sql'),
  'utf8',
);
const PRODUCER_ROLE = 'luna_ch4e_producer';
const WORKER_ROLE = 'luna_ch4e_worker';
const LIVE_097 = checksumMigrationFile(
  path.join(ROOT, 'database/migrations/097_tenant_email_luna_controlled_draft_operations.sql'),
  CHECKSUM_MODE_CANONICAL_LF_V1,
);

function resolvePg() {
  try {
    return require(PG_MODULE);
  } catch (error) {
    const failed = new Error(`stock-PG blocker: cannot require pg: ${error && error.message}`);
    failed.code = 'STOCK_PG_PG_MODULE_MISSING';
    throw failed;
  }
}

function wrapClient(client) {
  return {
    async exec(sql) { await client.query(sql); },
    async query(text, params) { return client.query(text, params); },
  };
}

async function insertLedger(db, id, sha) {
  await db.query(
    `INSERT INTO public.schema_migration_ledger
       (id, filename, checksum_sha256, apply_order, apply_kind, checksum_mode)
     VALUES ($1, $2, $3, (SELECT COALESCE(MAX(apply_order), 0) + 1 FROM public.schema_migration_ledger),
             'executed_by_canonical_runner', $4)
     ON CONFLICT (id) DO UPDATE
       SET checksum_sha256 = EXCLUDED.checksum_sha256,
           checksum_mode = EXCLUDED.checksum_mode`,
    [id, `${id}.sql`, sha, EXPECTED_CHECKSUM_MODE],
  );
}

async function proveStockPg(client, connectLogin, connectOwner) {
  assert.equal(LIVE_097.ok, true);
  assert.equal(LIVE_097.sha256, MIGRATION_097_SHA256);
  const db = wrapClient(client);
  await applyThrough088(db);
  await db.exec('ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS slug text');
  await db.query('UPDATE public.clients SET slug = $1 WHERE id = $2::uuid', ['sunset', ids.client]);
  await db.exec(UP_092);
  await applyCommittedInbound063Identity(db);
  await db.exec(UP_097);
  await db.exec(LEDGER_DDL);
  await insertLedger(db, MIGRATION_097_ID, MIGRATION_097_SHA256);
  await db.exec(UP_098);
  await insertLedger(db, MIGRATION_098_ID, MIGRATION_098_SHA256);
  await revokePublicExecuteOutsideCatalogs(db);

  await db.exec(createRoleSql(WORKER_ROLE, PASSWORD));
  await db.exec(createRoleSql(PRODUCER_ROLE, PASSWORD));
  await db.exec(createRoleSql('luna_ch4e_unmapped', PASSWORD));
  await db.exec('GRANT CONNECT ON DATABASE sunset_staging TO luna_ch4e_unmapped');
  await db.exec('GRANT USAGE ON SCHEMA public TO luna_ch4e_unmapped');

  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: WORKER_ROLE,
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    trustedPrecreated: true,
    apply: true,
    allowSunsetStagingTrustedPrecreated: true,
  });
  await provisionEmailLunaAutomationPrincipal(exclusiveSession(db), {
    roleName: PRODUCER_ROLE,
    kind: 'producer',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    trustedPrecreated: true,
    apply: true,
    allowSunsetStagingTrustedPrecreatedProducer: true,
  });

  const producer = await connectLogin(PRODUCER_ROLE);
  const worker = await connectLogin(WORKER_ROLE);
  const owner = await connectOwner();
  const setRole = await connectOwner();
  const unmapped = await connectLogin('luna_ch4e_unmapped');
  const clones = [producer, worker, owner, setRole, unmapped];
  try {
    await setRole.query(`SET ROLE ${PRODUCER_ROLE}`);
    const binding = {
      client_id: ids.client,
      location_id: ids.location,
      location_key: 'sunset-somo',
    };
    const producerProof = await inspectEmailLunaControlledDraftingSession(producer, binding, 'producer');
    const workerProof = await inspectEmailLunaControlledDraftingSession(worker, binding, 'worker');
    assert.equal(producerProof.ok, true);
    assert.equal(workerProof.ok, true);
    const identitySql = [
      'SELECT',
      '  session_user::text IS NOT DISTINCT FROM current_user::text AS session_matches_current,',
      "  current_database()::text AS current_database,",
      "  encode(sha256(convert_to(session_user::text, 'UTF8')), 'hex') AS session_fingerprint,",
      "  encode(sha256(convert_to(current_user::text, 'UTF8')), 'hex') AS current_fingerprint",
    ].join('\n');
    const producerId = await producer.query(identitySql);
    const workerId = await worker.query(identitySql);
    const ownerId = await owner.query(identitySql);
    const setRoleId = await setRole.query(identitySql);
    assert.equal(producerId.rows[0].session_matches_current, true);
    assert.equal(workerId.rows[0].session_matches_current, true);
    assert.equal(producerId.rows[0].current_database, 'sunset_staging');
    assert.notEqual(producerId.rows[0].session_fingerprint, workerId.rows[0].session_fingerprint);
    assert.equal(ownerId.rows[0].session_matches_current, true);
    assert.equal(setRoleId.rows[0].session_matches_current, false);
    assert.equal((await inspectEmailLunaControlledDraftingSession(owner, binding, 'producer')).ok, false);
    assert.equal((await inspectEmailLunaControlledDraftingSession(setRole, binding, 'producer')).ok, false);
    assert.equal((await inspectEmailLunaControlledDraftingSession(unmapped, binding, 'producer')).ok, false);
    console.log('ok - stock-PG distinct producer/worker LOGIN; owner/SET ROLE/unmapped fail');
  } finally {
    for (const clone of clones) {
      try { await clone.end(); } catch (_) { /* ignore */ }
    }
  }
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4E stock-PG LOGIN proof');
  console.log('Microsoft/JWKS are not live. This is not a token/JWKS proof.');
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import(EMBEDDED_MODULE));
  } catch (error) {
    console.log(`SKIP - embedded PostgreSQL unavailable (${error && error.message})`);
    return;
  }
  const { Client } = resolvePg();
  const dataDir = fs.mkdtempSync(path.join('/opt/data/local-postgres', 'ch4e-downscope-stock-'));
  const port = 56971 + (process.pid % 17);
  const password = 'local-disposable-ch4e';
  const cluster = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password,
    port,
    persistent: false,
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    onLog() {},
    onError(message) { console.error(String(message)); },
  });
  let started = false;
  const admin = new Client({
    host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres',
    connectionTimeoutMillis: 5000,
  });
  let client;
  try {
    await cluster.initialise();
    await cluster.start();
    started = true;
    await admin.connect();
    await admin.query('CREATE DATABASE sunset_staging');
    client = new Client({
      host: '127.0.0.1', port, user: 'postgres', password, database: 'sunset_staging',
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    await proveStockPg(
      client,
      async (role) => {
        const clone = new Client({
          host: '127.0.0.1', port, user: role, password: PASSWORD, database: 'sunset_staging',
          connectionTimeoutMillis: 5000,
        });
        await clone.connect();
        return clone;
      },
      async () => {
        const clone = new Client({
          host: '127.0.0.1', port, user: 'postgres', password, database: 'sunset_staging',
          connectionTimeoutMillis: 5000,
        });
        await clone.connect();
        return clone;
      },
    );
    console.log(`ALL OK — Stage 2 Chapter 4E stock-PG LOGIN (${dataDir} port ${port})`);
  } finally {
    try { if (client) await client.end(); } catch (_) { /* ignore */ }
    try { await admin.end(); } catch (_) { /* ignore */ }
    if (started) {
      try { await cluster.stop(); } catch (_) { /* ignore */ }
    }
  }
}

main().catch((error) => {
  if (error && /STOCK_PG|embedded/i.test(String(error.code || error.message))) {
    console.log(`SKIP - ${error.message}`);
    return;
  }
  console.error(error);
  process.exit(1);
});
