'use strict';

/**
 * Fail-closed canonical migration runner (FOUNDATION Slice 4 + 14AD).
 * Uses provenance-aware schema_migration_ledger + PostgreSQL advisory lock.
 * Refuses staging/prod/Azure and non-ephemeral DB names.
 *
 * Slice 14AD: ensureLedger creates/upgrades additive provenance columns;
 * new applies insert executed_by_canonical_runner with canonical checksum/mode;
 * reconcile treats baseline kinds as applied only in exact contiguous
 * checksum-valid prefix and fails closed on null/unknown kind, mode, gap,
 * or mismatch.
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
 * @param {object} opts
 * @param {{host:string,port:number,user:string,password:string,database:string}} opts.connection
 * @param {string} [opts.manifestPath]
 * @param {string} [opts.migrationsDir]
 * @param {boolean} [opts.dryRun]
 * @param {(client:object, entry:object)=>Promise<void>} [opts.beforeLedgerInsert]
 */
async function runCanonicalMigrations(opts) {
  const options = opts || {};
  const connection = options.connection;
  const safety = assertSafeDatabaseTarget(connection);
  if (!safety.ok) {
    return { ok: false, applied: [], skipped: [], errors: safety.errors };
  }

  const manifest = loadManifest(options.manifestPath || MANIFEST_PATH);
  const modeGate = resolveChecksumMode(manifest);
  if (!modeGate.ok) {
    return {
      ok: false,
      applied: [],
      skipped: [],
      errors: [{ code: modeGate.code, message: modeGate.message }],
    };
  }
  const integrity = validateManifestIntegrity(manifest, {
    migrationsDir: options.migrationsDir || MIGRATIONS_DIR,
  });
  if (!integrity.ok) {
    return { ok: false, applied: [], skipped: [], errors: integrity.errors };
  }

  const forward = forwardEntries(manifest);
  const client = new Client({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
    connectionTimeoutMillis: 10000,
    statement_timeout: 120000,
  });

  const applied = [];
  const skipped = [];
  const errors = [];

  try {
    await client.connect();
    await withAdvisoryLock(client, async () => {
      await ensureLedger(client);
      const ledgerRows = await loadLedger(client);
      const recon = reconcileLedger(forward, ledgerRows);
      if (!recon.ok) {
        errors.push(...recon.errors);
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
    });
  } catch (e) {
    errors.push({
      code: e.code || 'apply_failed',
      message: String(e.message || e).slice(0, 800),
    });
  } finally {
    try {
      await client.end();
    } catch (_) {
      /* ignore */
    }
  }

  return {
    ok: errors.length === 0,
    applied,
    skipped,
    errors,
    forwardCount: forward.length,
  };
}

module.exports = {
  runCanonicalMigrations,
  reconcileLedger,
  ensureLedger,
  withAdvisoryLock,
  applyOne,
  loadLedger,
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
  runCanonicalMigrations({ connection })
    .then((r) => {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
