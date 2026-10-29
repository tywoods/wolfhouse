'use strict';
/**
 * Fail-closed canonical migration runner (FOUNDATION Slice 4 + 14AD + 14AE).
 * Uses provenance-aware schema_migration_ledger + PostgreSQL advisory lock.
 * Default: refuses staging/prod/Azure and non-ephemeral DB names.
 *
 * Slice 14AD: ensureLedger creates/upgrades additive provenance columns;
 * legacy upgrade adds nullable provenance with NO defaults/backfill;
 * new applies insert executed_by_canonical_runner with canonical checksum/mode;
 * reconcile requires canonical sha256 under canonical_lf_v1, treats baseline
 * kinds as applied only in exact contiguous checksum-valid prefix, and fails
 * closed on null/unknown kind, mode, recorded_at, gap, mismatch, or
 * checksum_mode/hash inconsistency (legacy hash under canonical mode).
 *
 * Slice 14AE: optional allowSunsetStagingCanonicalRunnerNoop (exact locked
 * Sunset host/db/port only) + ssl/application_name/Client injection so the
 * managed-identity TLS wrapper can invoke this same implementation once and
 * prove a zero-apply no-op over the 39-row provenance baseline ledger.
 * Stage 2C2: allowDedicatedSyntheticAzureInitialApply (fresh synthetic only; no default widen).
 * Wolfhouse prod: allowWolfhouseProdFreshEmptyApply (database wolfhouse_prod only, must be empty).
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  LEDGER_DDL,
  LEDGER_LEGACY_UPGRADE_DDL,
  LEDGER_SELECT_COLUMNS,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  assertSafeDatabaseTarget,
  prepareMigrationBody,
  checksumMigrationFile,
  reconcileLedger,
  buildExecutedByCanonicalRunnerProvenance,
  resolveChecksumMode,
  CHECKSUM_MODE_CANONICAL_LF_V1,
} = require('./lib/migration-integrity');
async function withAdvisoryLock(client, fn) {
  await client.query('SELECT pg_advisory_lock($1, $2)', [ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2]);
  try {
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1, $2)', [ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2]);
  }
}
/**
 * Create fresh provenance-aware ledger, then additively upgrade any legacy
 * five-column ledger before runner use.
 */
async function ensureLedger(client) {
  await client.query(LEDGER_DDL);
  await client.query(LEDGER_LEGACY_UPGRADE_DDL);
}
async function loadLedger(client) {
  const cols = LEDGER_SELECT_COLUMNS.join(', ');
  const res = await client.query(
    `SELECT ${cols} FROM schema_migration_ledger ORDER BY apply_order ASC`,
  );
  return res.rows;
}
/**
 * Apply one migration + ledger insert in a single atomic transaction.
 * Outer BEGIN/COMMIT wrappers are stripped conservatively before execution.
 * Ledger insert always labels executed_by_canonical_runner with canonical
 * checksum/mode and useful evidence/provenance. applied_at and
 * ledger_recorded_at are the transaction recording timestamp (NOW()), never
 * historical execution time claims.
 */
async function applyOne(client, entry, migrationsDir, hooks, checksumMode) {
  const mode = checksumMode || CHECKSUM_MODE_CANONICAL_LF_V1;
  const abs = path.join(migrationsDir, entry.filename);
  const sqlBuf = fs.readFileSync(abs);
  const sql = sqlBuf.toString('utf8');
  const live = checksumMigrationFile(abs, mode);
  if (!live.ok || live.sha256 !== entry.sha256) {
    throw Object.assign(new Error(`checksum mismatch before apply: ${entry.filename}`), {
      code: live.ok ? 'checksum_mismatch' : live.code || 'checksum_mismatch',
    });
  }
  const prepared = prepareMigrationBody(sql);
  if (!prepared.ok) {
    throw Object.assign(new Error(prepared.message || 'invalid migration transaction shape'), {
      code: prepared.code || 'txn_prepare_failed',
    });
  }
  const provenance = buildExecutedByCanonicalRunnerProvenance(entry);
  await client.query('BEGIN');
  try {
    await client.query(prepared.body);
    if (hooks && typeof hooks.beforeLedgerInsert === 'function') {
      await hooks.beforeLedgerInsert(client, entry);
    }
    // New ledger rows always store canonical_lf_v1 (entry.sha256 under declared mode).
    // NOW() is transaction-stable: applied_at === ledger_recorded_at === txn recording time.
    await client.query(
      `INSERT INTO schema_migration_ledger (
         id, filename, checksum_sha256, apply_order,
         apply_kind, checksum_mode, evidence_ref, provenance_notes,
         applied_at, ledger_recorded_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         NOW(), NOW()
       )`,
      [
        entry.id,
        entry.filename,
        entry.sha256,
        entry.order,
        provenance.apply_kind,
        provenance.checksum_mode,
        provenance.evidence_ref,
        provenance.provenance_notes,
      ],
    );
    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    throw e;
  }
}
/**
 * @param {object} opts connection + optional allowSunsetStagingCanonicalRunnerNoop /
 *   allowDedicatedSyntheticAzureInitialApply (+ syntheticTenantSlug) + Client/dryRun hooks
 */
const WOLFHOUSE_PROD_FRESH_EMPTY_DB = 'wolfhouse_prod';
const WOLFHOUSE_PROD_FRESH_EMPTY_HOSTS = Object.freeze([
  '178.33.91.59',
  '127.0.0.1',
  'localhost',
  '::1',
  'wolfhouse-prod-postgres',
]);

function assertWolfhouseProdFreshEmptyTarget(connectionInfo) {
  const errors = [];
  const host = String((connectionInfo && connectionInfo.host) || '');
  const database = String((connectionInfo && connectionInfo.database) || '');
  const port = Number(connectionInfo && connectionInfo.port);
  if (database !== WOLFHOUSE_PROD_FRESH_EMPTY_DB) {
    errors.push({ code: 'wolfhouse_prod_database_mismatch', message: 'fresh-empty apply requires database wolfhouse_prod' });
  }
  if (!WOLFHOUSE_PROD_FRESH_EMPTY_HOSTS.includes(host)) {
    errors.push({ code: 'wolfhouse_prod_host_mismatch', message: 'fresh-empty apply requires an allowlisted wolfhouse_prod host' });
  }
  if (!Number.isFinite(port) || port !== 5432) {
    errors.push({ code: 'wolfhouse_prod_port_mismatch', message: 'fresh-empty apply requires port 5432' });
  }
  return {
    ok: errors.length === 0,
    errors,
    mode: 'wolfhouse_prod_fresh_empty',
  };
}

async function probeFreshWolfhouseProd(client) {
  const fresh = await probeFreshSyntheticDatabase(client);
  if (fresh.ok) return fresh;
  return {
    ok: false,
    errors: [{ code: 'wolfhouse_prod_not_empty', message: 'wolfhouse_prod is not a fresh empty database' }],
  };
}

async function probeFreshSyntheticDatabase(client) {
  const existsRes = await client.query(
    "SELECT to_regclass('public.schema_migration_ledger') IS NOT NULL AS ledger_exists",
  );
  const existsRow = (existsRes.rows && existsRes.rows[0]) || {};
  const ledgerExists = existsRow.ledger_exists === true || existsRow.ledger_exists === 't';
  let ledgerRows = 0;
  if (ledgerExists) {
    const countRes = await client.query(
      'SELECT COUNT(*)::int AS ledger_rows FROM public.schema_migration_ledger',
    );
    ledgerRows = Number((countRes.rows && countRes.rows[0] && countRes.rows[0].ledger_rows) || 0);
  }
  const ns = "n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'";
  const catalog = await client.query(
    `SELECT`
    + ` (SELECT COUNT(*)::int FROM pg_catalog.pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast','public') AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%') AS user_schemas,`
    + ` (SELECT COUNT(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${ns} AND c.relkind IN ('r','v','m','S','f','p') AND NOT (n.nspname='public' AND c.relname='schema_migration_ledger')) AS user_relations,`
    + ` (SELECT COUNT(*)::int FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE ${ns}) AS user_functions,`
    + ` (SELECT COUNT(*)::int FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE ${ns} AND t.typtype IN ('c','e','d','r') AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=t.typrelid AND c.relkind IN ('r','v','m','S','f','p'))) AS user_types,`
    + ` (SELECT COUNT(*)::int FROM pg_catalog.pg_trigger tr JOIN pg_catalog.pg_class c ON c.oid=tr.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE NOT tr.tgisinternal AND ${ns}) AS user_triggers`,
  );
  const row = (catalog.rows && catalog.rows[0]) || {};
  const userSchemas = Number(row.user_schemas || 0);
  const userRelations = Number(row.user_relations || 0);
  const userFunctions = Number(row.user_functions || 0);
  const userTypes = Number(row.user_types || 0);
  const userTriggers = Number(row.user_triggers || 0);
  if (ledgerExists && ledgerRows > 0) return { ok: false, errors: [{ code: 'synthetic_db_not_fresh_ledger', message: 'canonical ledger not empty' }] };
  if (userSchemas || userRelations || userFunctions || userTypes || userTriggers) {
    return { ok: false, errors: [{ code: 'synthetic_db_not_fresh_schema', message: 'user schema objects present' }], userSchemas, userRelations, userFunctions, userTypes, userTriggers };
  }
  return { ok: true, errors: [], ledgerExists, ledgerRows, userSchemas, userRelations, userFunctions, userTypes, userTriggers };
}
async function runCanonicalMigrations(opts) {
  const options = opts || {};
  const connection = options.connection;
  const wantSunset = options.allowSunsetStagingCanonicalRunnerNoop === true;
  const wantSynthetic = options.allowDedicatedSyntheticAzureInitialApply === true;
  const wantProdFresh = options.allowWolfhouseProdFreshEmptyApply === true;
  if (wantProdFresh && (wantSunset || wantSynthetic)) {
    return {
      ok: false,
      applied: [],
      skipped: [],
      pending: [],
      errors: [{ code: 'conflicting_safety_capabilities', message: 'wolfhouse_prod fresh-empty cannot combine with Sunset no-op or synthetic apply' }],
      safetyMode: null,
    };
  }
  const safety = wantProdFresh
    ? assertWolfhouseProdFreshEmptyTarget(connection)
    : assertSafeDatabaseTarget(connection, {
      allowSunsetStagingCanonicalRunnerNoop: wantSunset,
      allowDedicatedSyntheticAzureInitialApply: wantSynthetic,
      syntheticTenantSlug: options.syntheticTenantSlug,
    });
  if (!safety.ok) {
    return {
      ok: false,
      applied: [],
      skipped: [],
      pending: [],
      errors: safety.errors,
      safetyMode: safety.mode || null,
    };
  }
  const manifest = loadManifest(options.manifestPath || MANIFEST_PATH);
  const modeGate = resolveChecksumMode(manifest);
  if (!modeGate.ok) {
    return {
      ok: false,
      applied: [],
      skipped: [],
      pending: [],
      errors: [{ code: modeGate.code, message: modeGate.message }],
      safetyMode: safety.mode || null,
    };
  }
  const integrity = validateManifestIntegrity(manifest, {
    migrationsDir: options.migrationsDir || MIGRATIONS_DIR,
  });
  if (!integrity.ok) {
    return {
      ok: false,
      applied: [],
      skipped: [],
      pending: [],
      errors: integrity.errors,
      safetyMode: safety.mode || null,
    };
  }
  const forward = forwardEntries(manifest);
  const ClientCtor = options.Client || Client;
  const externalClient = options.client || null;
  const advisoryLockHeld = options.advisoryLockHeld === true;
  if (advisoryLockHeld && !externalClient) {
    return {
      ok: false, applied: [], skipped: [], pending: [],
      errors: [{ code: 'advisory_lock_client_required', message: 'advisoryLockHeld requires injected client' }],
      safetyMode: safety.mode || null,
    };
  }
  const clientConfig = {
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
    connectionTimeoutMillis: 10000,
    statement_timeout: 120000,
  };
  if (connection.ssl != null) clientConfig.ssl = connection.ssl;
  if (connection.application_name != null) {
    clientConfig.application_name = connection.application_name;
  }
  const client = externalClient || new ClientCtor(clientConfig);
  const applied = [];
  const skipped = [];
  const errors = [];
  let pending = forward.map((e) => e.id);
  const requireFresh = wantProdFresh
    || (wantSynthetic && options.skipFreshnessProbe !== true);
  const runBody = async () => {
    if (wantProdFresh) {
      const session = await client.query('SELECT current_database() AS database');
      const sessionDb = session.rows && session.rows[0] && session.rows[0].database;
      if (String(sessionDb) !== String(connection.database)) {
        errors.push({ code: 'session_database_mismatch', message: 'injected/executing session is not the declared wolfhouse_prod target' });
        return;
      }
    }
    if (requireFresh) {
      const fresh = options.allowWolfhouseProdFreshEmptyApply === true
        ? await probeFreshWolfhouseProd(client)
        : await probeFreshSyntheticDatabase(client);
      if (!fresh.ok) {
        errors.push(...fresh.errors);
        return;
      }
    }
    await ensureLedger(client);
    const ledgerRows = await loadLedger(client);
    const recon = reconcileLedger(forward, ledgerRows);
    if (!recon.ok) {
      errors.push(...recon.errors);
      pending = forward.filter((e) => !recon.byId.has(e.id)).map((e) => e.id);
      return;
    }
    for (const entry of forward) {
      if (recon.byId.has(entry.id)) {
        skipped.push(entry.id);
        continue;
      }
      if (options.dryRun) {
        applied.push(entry.id);
        continue;
      }
      await applyOne(
        client,
        entry,
        options.migrationsDir || MIGRATIONS_DIR,
        {
          beforeLedgerInsert: options.beforeLedgerInsert,
        },
        modeGate.mode,
      );
      applied.push(entry.id);
    }
    pending = forward
      .filter((e) => !skipped.includes(e.id) && !applied.includes(e.id))
      .map((e) => e.id);
  };
  try {
    if (!externalClient) await client.connect();
    if (advisoryLockHeld) await runBody();
    else await withAdvisoryLock(client, runBody);
  } catch (e) {
    errors.push({
      code: e.code || 'apply_failed',
      message: String(e.message || e).slice(0, 800),
    });
  } finally {
    if (!externalClient) {
      try {
        await client.end();
      } catch (_) {
        /* ignore */
      }
    }
  }
  return {
    ok: errors.length === 0,
    applied,
    skipped,
    pending,
    errors,
    forwardCount: forward.length,
    safetyMode: safety.mode || null,
  };
}
module.exports = {
  runCanonicalMigrations,
  reconcileLedger,
  ensureLedger,
  withAdvisoryLock,
  applyOne,
  loadLedger,
  probeFreshSyntheticDatabase,
  probeFreshWolfhouseProd,
  assertWolfhouseProdFreshEmptyTarget,
  WOLFHOUSE_PROD_FRESH_EMPTY_DB,
  WOLFHOUSE_PROD_FRESH_EMPTY_HOSTS,
};
if (require.main === module) {
  const args = process.argv.slice(2);
  function arg(name) {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  }
  const connection = {
    host: arg('--host') || process.env.WH_MIG_HOST,
    port: Number(arg('--port') || process.env.WH_MIG_PORT || 5432),
    user: arg('--user') || process.env.WH_MIG_USER,
    password: arg('--password') || process.env.WH_MIG_PASSWORD,
    database: arg('--database') || process.env.WH_MIG_DATABASE,
  };
  const allowWolfhouseProdFreshEmptyApply = args.includes('--allow-wolfhouse-prod-fresh-empty');
  runCanonicalMigrations({ connection, allowWolfhouseProdFreshEmptyApply })
    .then((r) => {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
