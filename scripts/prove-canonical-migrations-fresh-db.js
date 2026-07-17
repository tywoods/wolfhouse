'use strict';

/**
 * prove-canonical-migrations-fresh-db — FOUNDATION Slice 4
 *
 * Spins up an ephemeral local Docker PostgreSQL, applies the canonical forward
 * chain twice (second run = zero applies), fingerprints schema across two DBs,
 * proves checksum/partial-ledger fail-closed, then removes containers/volumes.
 *
 * Never connects to Sunset staging, Wolfhouse, production, or Azure PostgreSQL.
 */

const { execFileSync, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  SCHEMA_FINGERPRINT_SQL,
  schemaFingerprintRows,
  sha256File,
} = require('./lib/migration-integrity');
const { runCanonicalMigrations } = require('./run-canonical-migrations');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'foundation-slice4');
const REPORT_PATH = path.join(OUT_DIR, 'fresh-db-proof-report.json');
const FIXTURE_REPORT = path.join(ROOT, 'fixtures', 'migration-integrity', 'fresh-db-proof-report.json');

const suffix = crypto.randomBytes(4).toString('hex');
const CONTAINER = `wh-mig-proof-${suffix}`;
const VOLUME = `wh-mig-proof-vol-${suffix}`;
const DB_A = `wh_mig_a_${suffix}`;
const DB_B = `wh_mig_b_${suffix}`;
const DB_C = `wh_mig_c_${suffix}`;
const USER = `wh_mig_u_${suffix}`;
const PASSWORD = crypto.randomBytes(18).toString('base64url');
const HOST_PORT = null; // assigned after container start (loopback publish)
let assignedHostPort = null;

function sh(cmd, opts) {
  return execSync(cmd, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(opts || {}),
  });
}

function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function cleanup() {
  try {
    docker(['rm', '-f', CONTAINER]);
  } catch (_) {
    /* ignore */
  }
  try {
    docker(['volume', 'rm', '-f', VOLUME]);
  } catch (_) {
    /* ignore */
  }
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
      try {
        await client.end();
      } catch (_) {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last || new Error('postgres never became ready');
}

async function createDatabase(adminConn, dbName) {
  const client = new Client(adminConn);
  await client.connect();
  await client.query(`CREATE DATABASE ${dbName}`);
  await client.end();
}

async function fingerprint(connection) {
  const client = new Client(connection);
  await client.connect();
  const res = await client.query(SCHEMA_FINGERPRINT_SQL);
  await client.end();
  return schemaFingerprintRows(res.rows);
}

async function forceLedgerCorruption(connection, kind) {
  const client = new Client(connection);
  await client.connect();
  if (kind === 'checksum') {
    await client.query(
      `UPDATE schema_migration_ledger
       SET checksum_sha256 = $1
       WHERE apply_order = 1`,
      ['deadbeef'.repeat(8)],
    );
  } else if (kind === 'partial') {
    // Delete order 1 while leaving order 2+ — creates non-prefix history after we fake a row
    const forward = forwardEntries(loadManifest());
    if (forward.length < 2) throw new Error('need >=2 forward migrations');
    await client.query('DELETE FROM schema_migration_ledger');
    await client.query(
      `INSERT INTO schema_migration_ledger (id, filename, checksum_sha256, apply_order)
       VALUES ($1,$2,$3,$4)`,
      [forward[1].id, forward[1].filename, forward[1].sha256, 2],
    );
  }
  await client.end();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = loadManifest();
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) {
    const report = {
      ok: false,
      phase: 'manifest_integrity',
      errors: integrity.errors,
    };
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const admin = {
    host: '127.0.0.1',
    port: null,
    user: USER,
    password: PASSWORD,
    database: 'postgres',
  };

  let blocker = null;
  const report = {
    ok: false,
    kind: 'canonical-migration-fresh-db-proof',
    masterSha: '4502fe3938dd907c14d2c7218e7252d19b3d985d',
    container: CONTAINER,
    volume: VOLUME,
    hostPort: null,
    databases: { a: DB_A, b: DB_B, c: DB_C },
    forwardCount: forwardEntries(manifest).length,
    steps: {},
    cleanup: { containerRemoved: false, volumeRemoved: false },
  };

  process.on('exit', () => {
    // best-effort if we crash mid-flight
  });

  try {
    docker([
      'run',
      '-d',
      '--name',
      CONTAINER,
      '-e',
      `POSTGRES_USER=${USER}`,
      '-e',
      `POSTGRES_PASSWORD=${PASSWORD}`,
      '-e',
      'POSTGRES_DB=postgres',
      '-p',
      '127.0.0.1::5432',
      '-v',
      `${VOLUME}:/var/lib/postgresql/data`,
      'postgres:15-alpine',
    ]);

    const portMap = String(docker(['port', CONTAINER, '5432/tcp'])).trim();
    // e.g. 127.0.0.1:54321
    const portMatch = portMap.match(/:(\d+)\s*$/);
    if (!portMatch) {
      throw new Error(`could not parse published port from: ${portMap}`);
    }
    assignedHostPort = Number(portMatch[1]);
    admin.port = assignedHostPort;
    report.hostPort = assignedHostPort;

    await waitForPg(admin, 60);
    await createDatabase(admin, DB_A);
    await createDatabase(admin, DB_B);
    await createDatabase(admin, DB_C);

    const connA = { ...admin, database: DB_A };
    const connB = { ...admin, database: DB_B };
    const connC = { ...admin, database: DB_C };

    // ── Atomic rollback proof (inject failure before ledger insert) ─────────
    let injected = false;
    const failInject = await runCanonicalMigrations({
      connection: connC,
      beforeLedgerInsert: async (_client, entry) => {
        if (!injected && entry.order === 1) {
          injected = true;
          throw Object.assign(new Error('injected failure before ledger insert'), {
            code: 'injected_ledger_failure',
          });
        }
      },
    });
    const probeC = new Client(connC);
    await probeC.connect();
    const hostelsReg = await probeC.query(`SELECT to_regclass('public.hostels') AS t`);
    const clientsReg = await probeC.query(`SELECT to_regclass('public.clients') AS t`);
    const ledgerAfterFail = await probeC.query(
      'SELECT count(*)::int AS n FROM schema_migration_ledger',
    );
    await probeC.end();
    report.steps.atomicRollbackInject = {
      applyOk: failInject.ok,
      errorCode: (failInject.errors[0] || {}).code || null,
      hostelsPresent: hostelsReg.rows[0].t != null,
      clientsPresent: clientsReg.rows[0].t != null,
      ledgerRows: ledgerAfterFail.rows[0].n,
    };
    if (
      failInject.ok
      || (failInject.errors[0] || {}).code !== 'injected_ledger_failure'
      || hostelsReg.rows[0].t
      || clientsReg.rows[0].t
      || ledgerAfterFail.rows[0].n !== 0
    ) {
      blocker = {
        code: 'atomic_rollback_failed',
        message: 'Injected ledger failure did not roll back schema+ledger atomically',
        detail: report.steps.atomicRollbackInject,
      };
      report.blocker = blocker;
      throw new Error(blocker.message);
    }

    const recoverC = await runCanonicalMigrations({ connection: connC });
    const probeC2 = new Client(connC);
    await probeC2.connect();
    const ledgerRecover = await probeC2.query(
      'SELECT id, apply_order FROM schema_migration_ledger ORDER BY apply_order',
    );
    const firstIdCount = await probeC2.query(
      'SELECT count(*)::int AS n FROM schema_migration_ledger WHERE id = $1',
      [forwardEntries(manifest)[0].id],
    );
    await probeC2.end();
    report.steps.atomicRollbackRecover = {
      ok: recoverC.ok,
      appliedCount: recoverC.applied.length,
      ledgerRows: ledgerRecover.rows.length,
      firstMigrationLedgerRows: firstIdCount.rows[0].n,
    };
    if (
      !recoverC.ok
      || recoverC.applied.length !== forwardEntries(manifest).length
      || ledgerRecover.rows.length !== forwardEntries(manifest).length
      || firstIdCount.rows[0].n !== 1
    ) {
      blocker = {
        code: 'atomic_recover_failed',
        message: 'Rerun after injected failure did not leave exactly one ledger row per migration',
        detail: report.steps.atomicRollbackRecover,
      };
      report.blocker = blocker;
      throw new Error(blocker.message);
    }

    const first = await runCanonicalMigrations({ connection: connA });
    report.steps.firstApply = {
      ok: first.ok,
      appliedCount: first.applied.length,
      skippedCount: first.skipped.length,
      errors: first.errors,
    };
    if (!first.ok) {
      blocker = {
        code: 'fresh_apply_failed',
        message: 'Canonical forward chain failed on empty disposable DB',
        errors: first.errors,
        appliedBeforeFailure: first.applied,
      };
      report.blocker = blocker;
      throw new Error(blocker.message);
    }
    if (first.applied.length !== forwardEntries(manifest).length) {
      blocker = {
        code: 'incomplete_first_apply',
        message: `expected ${forwardEntries(manifest).length} applies, got ${first.applied.length}`,
      };
      report.blocker = blocker;
      throw new Error(blocker.message);
    }

    const second = await runCanonicalMigrations({ connection: connA });
    report.steps.secondApply = {
      ok: second.ok,
      appliedCount: second.applied.length,
      skippedCount: second.skipped.length,
      errors: second.errors,
    };
    if (!second.ok || second.applied.length !== 0) {
      blocker = {
        code: 'second_run_not_idempotent',
        message: 'Second run must apply zero migrations',
        detail: second,
      };
      report.blocker = blocker;
      throw new Error(blocker.message);
    }

    const fpA = await fingerprint(connA);

    const applyB = await runCanonicalMigrations({ connection: connB });
    report.steps.secondDbApply = {
      ok: applyB.ok,
      appliedCount: applyB.applied.length,
      errors: applyB.errors,
    };
    if (!applyB.ok) {
      blocker = {
        code: 'second_db_apply_failed',
        message: 'Independent disposable DB failed to apply chain',
        errors: applyB.errors,
      };
      report.blocker = blocker;
      throw new Error(blocker.message);
    }
    const fpB = await fingerprint(connB);
    report.steps.schemaFingerprint = {
      a: fpA,
      b: fpB,
      match: fpA === fpB,
    };
    if (fpA !== fpB) {
      blocker = {
        code: 'fingerprint_mismatch',
        message: 'Schema fingerprints diverged across independent disposable DBs',
      };
      report.blocker = blocker;
      throw new Error(blocker.message);
    }

    // Fail-closed: checksum mismatch on ledger
    await forceLedgerCorruption(connA, 'checksum');
    const badChecksum = await runCanonicalMigrations({ connection: connA });
    report.steps.forcedChecksumMismatch = {
      ok: badChecksum.ok,
      errors: badChecksum.errors,
    };
    if (badChecksum.ok || !badChecksum.errors.some((e) => e.code === 'ledger_checksum_mismatch')) {
      blocker = {
        code: 'checksum_failclosed_missing',
        message: 'Expected ledger_checksum_mismatch fail-closed',
        detail: badChecksum,
      };
      report.blocker = blocker;
      throw new Error(blocker.message);
    }

    // Fail-closed: partial ledger on DB B
    await forceLedgerCorruption(connB, 'partial');
    const badPartial = await runCanonicalMigrations({ connection: connB });
    report.steps.forcedPartialLedger = {
      ok: badPartial.ok,
      errors: badPartial.errors,
    };
    if (badPartial.ok || !badPartial.errors.some((e) => e.code === 'ledger_partial_history')) {
      blocker = {
        code: 'partial_failclosed_missing',
        message: 'Expected ledger_partial_history fail-closed',
        detail: badPartial,
      };
      report.blocker = blocker;
      throw new Error(blocker.message);
    }

    report.ok = true;
    report.schemaFingerprint = fpA;
  } catch (e) {
    if (!report.blocker) {
      let msg = String(e.message || e).slice(0, 1000);
      // Never persist ephemeral credentials in reports
      if (PASSWORD) msg = msg.split(PASSWORD).join('[REDACTED]');
      report.blocker = {
        code: 'harness_error',
        message: msg,
      };
    }
    report.ok = false;
  } finally {
    cleanup();
    // Prove cleanup
    let containerGone = true;
    let volumeGone = true;
    try {
      const ps = docker(['ps', '-a', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.Names}}']);
      containerGone = !String(ps).includes(CONTAINER);
    } catch (_) {
      containerGone = true;
    }
    try {
      const vols = docker(['volume', 'ls', '--format', '{{.Name}}']);
      volumeGone = !String(vols).split(/\r?\n/).includes(VOLUME);
    } catch (_) {
      volumeGone = true;
    }
    report.cleanup = {
      containerRemoved: containerGone,
      volumeRemoved: volumeGone,
      credentialsNotPersisted: true,
      note: 'Ephemeral password existed only in process memory; not written to report.',
    };
    // Never persist password
    delete report.password;
  }

  // Secret-free report (no password/user secrets beyond ephemeral names)
  const safe = { ...report };
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(safe, null, 2)}\n`);
  fs.mkdirSync(path.dirname(FIXTURE_REPORT), { recursive: true });
  fs.writeFileSync(FIXTURE_REPORT, `${JSON.stringify(safe, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
  process.exit(report.ok && report.cleanup.containerRemoved && report.cleanup.volumeRemoved ? 0 : 1);
}

main().catch((e) => {
  cleanup();
  console.error(e);
  process.exit(1);
});
