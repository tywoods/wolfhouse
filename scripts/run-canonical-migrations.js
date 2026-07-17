'use strict';

/**
 * Fail-closed canonical migration runner (FOUNDATION Slice 4).
 * Uses schema_migration_ledger + PostgreSQL advisory lock.
 * Refuses staging/prod/Azure and non-ephemeral DB names.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  LEDGER_DDL,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  assertSafeDatabaseTarget,
  prepareMigrationBody,
  sha256File,
} = require('./lib/migration-integrity');

async function withAdvisoryLock(client, fn) {
  await client.query('SELECT pg_advisory_lock($1, $2)', [ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2]);
  try {
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1, $2)', [ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2]);
  }
}

async function ensureLedger(client) {
  await client.query(LEDGER_DDL);
}

async function loadLedger(client) {
  const res = await client.query(
    'SELECT id, filename, checksum_sha256, apply_order, applied_at FROM schema_migration_ledger ORDER BY apply_order ASC',
  );
  return res.rows;
}

function reconcileLedger(forward, ledgerRows) {
  const errors = [];
  const byId = new Map(ledgerRows.map((r) => [r.id, r]));

  for (const row of ledgerRows) {
    const expected = forward.find((f) => f.id === row.id);
    if (!expected) {
      errors.push({
        code: 'ledger_unknown_id',
        message: `ledger contains unknown id ${row.id}`,
      });
      continue;
    }
    if (row.checksum_sha256 !== expected.sha256) {
      errors.push({
        code: 'ledger_checksum_mismatch',
        message: `ledger checksum mismatch for ${row.id}`,
      });
    }
    if (row.filename !== expected.filename) {
      errors.push({
        code: 'ledger_filename_mismatch',
        message: `ledger filename mismatch for ${row.id}`,
      });
    }
    if (Number(row.apply_order) !== expected.order) {
      errors.push({
        code: 'ledger_order_mismatch',
        message: `ledger order mismatch for ${row.id}`,
      });
    }
  }

  // Partial history: applied set must be a prefix of the forward chain
  const appliedOrders = ledgerRows.map((r) => Number(r.apply_order)).sort((a, b) => a - b);
  for (let i = 0; i < appliedOrders.length; i += 1) {
    if (appliedOrders[i] !== i + 1) {
      errors.push({
        code: 'ledger_partial_history',
        message: `ledger is not a contiguous prefix (gap at order ${i + 1})`,
      });
      break;
    }
  }

  return { ok: errors.length === 0, errors, byId };
}

/**
 * Apply one migration + ledger insert in a single atomic transaction.
 * Outer BEGIN/COMMIT wrappers are stripped conservatively before execution.
 */
async function applyOne(client, entry, migrationsDir, hooks) {
  const abs = path.join(migrationsDir, entry.filename);
  const sql = fs.readFileSync(abs, 'utf8');
  const liveSha = sha256File(abs);
  if (liveSha !== entry.sha256) {
    throw Object.assign(new Error(`checksum mismatch before apply: ${entry.filename}`), {
      code: 'checksum_mismatch',
    });
  }

  const prepared = prepareMigrationBody(sql);
  if (!prepared.ok) {
    throw Object.assign(new Error(prepared.message || 'invalid migration transaction shape'), {
      code: prepared.code || 'txn_prepare_failed',
    });
  }

  await client.query('BEGIN');
  try {
    await client.query(prepared.body);
    if (hooks && typeof hooks.beforeLedgerInsert === 'function') {
      await hooks.beforeLedgerInsert(client, entry);
    }
    await client.query(
      `INSERT INTO schema_migration_ledger (id, filename, checksum_sha256, apply_order)
       VALUES ($1, $2, $3, $4)`,
      [entry.id, entry.filename, entry.sha256, entry.order],
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
        await applyOne(client, entry, options.migrationsDir || MIGRATIONS_DIR, {
          beforeLedgerInsert: options.beforeLedgerInsert,
        });
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
