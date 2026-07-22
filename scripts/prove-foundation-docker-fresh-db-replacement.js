'use strict';

/**
 * prove-foundation-docker-fresh-db-replacement — FOUNDATION G_DOCKER_FRESH_DB_REPLACEMENT
 *
 * Force Docker disposable Postgres (no PGlite). Run two independent cycles on
 * distinct named volumes: empty DB → full canonical forward migrations →
 * snapshot sorted schema_migrations + public-schema fingerprint → destroy
 * container+volume. Compare cycle A ≡ B. Print deterministic JSON to stdout.
 *
 * Never connects to Sunset staging, Wolfhouse, production, or Azure PostgreSQL.
 * Does not write committed evidence or edit MESSI/FOUNDATION ledgers.
 *
 * Offline self-tests (`--offline`): exercise fail-closed, distinct-volume,
 * cleanup, and mismatch seams without Docker.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { Client } = require('pg');
const {
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  SCHEMA_FINGERPRINT_SQL,
  schemaFingerprintRows,
} = require('./lib/migration-integrity');
const { runCanonicalMigrations } = require('./run-canonical-migrations');
const {
  startDisposablePostgresHarness,
  dockerAvailable: harnessDockerAvailable,
} = require('./lib/disposable-postgres-harness');

const KIND = 'foundation-docker-fresh-db-replacement';
const GATE = 'G_DOCKER_FRESH_DB_REPLACEMENT';

const SCHEMA_MIGRATIONS_SQL = `
SELECT id, filename, checksum_sha256, apply_order, apply_kind, checksum_mode
FROM schema_migration_ledger
ORDER BY apply_order ASC, id ASC
`;

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function dockerCli(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function defaultResolveVolumeName(admin) {
  if (!admin || admin.port == null) return null;
  const port = String(admin.port);
  const names = String(
    dockerCli(['ps', '--format', '{{.Names}}\t{{.Ports}}']),
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes(`:${port}->5432`))
    .map((line) => line.split('\t')[0]);
  if (names.length !== 1) return null;
  const mounts = String(
    dockerCli([
      'inspect',
      '-f',
      '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}',
      names[0],
    ]),
  ).trim();
  return mounts || null;
}

async function defaultWaitForReady(connection, attempts) {
  const max = attempts == null ? 60 : attempts;
  let last;
  for (let i = 0; i < max; i += 1) {
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

async function defaultCreateDatabase(admin, dbName) {
  const client = new Client(admin);
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await client.end();
  }
}

async function defaultSnapshotState(connection) {
  const client = new Client(connection);
  await client.connect();
  try {
    const mig = await client.query(SCHEMA_MIGRATIONS_SQL);
    const fp = await client.query(SCHEMA_FINGERPRINT_SQL);
    return {
      schema_migrations: mig.rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        checksum_sha256: row.checksum_sha256,
        apply_order: Number(row.apply_order),
        apply_kind: row.apply_kind,
        checksum_mode: row.checksum_mode,
      })),
      schema_fingerprint: schemaFingerprintRows(fp.rows),
    };
  } finally {
    await client.end();
  }
}

function defaultLoadForwardPlan() {
  const manifest = loadManifest();
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) {
    return { ok: false, forward: [], errors: integrity.errors };
  }
  return { ok: true, forward: forwardEntries(manifest), errors: [] };
}

function buildEvidence(partial) {
  return {
    ok: false,
    kind: KIND,
    gate: GATE,
    backend: 'docker',
    ...partial,
  };
}

/**
 * @param {object} [deps] Injectable seams for offline proof without Docker.
 * @returns {Promise<object>}
 */
async function proveFoundationDockerFreshDbReplacement(deps) {
  const d = deps || {};
  const dockerAvailable = d.dockerAvailable || harnessDockerAvailable;
  const startHarness = d.startHarness || startDisposablePostgresHarness;
  const runMigrations = d.runMigrations || runCanonicalMigrations;
  const waitForReady = d.waitForReady || defaultWaitForReady;
  const createDatabase = d.createDatabase || defaultCreateDatabase;
  const snapshotState = d.snapshotState || defaultSnapshotState;
  const resolveVolumeName = d.resolveVolumeName || defaultResolveVolumeName;
  const loadForwardPlan = d.loadForwardPlan || defaultLoadForwardPlan;
  const randomSuffix = d.randomSuffix
    || (() => crypto.randomBytes(4).toString('hex'));

  // Fail closed before any harness/PGlite path.
  if (!dockerAvailable()) {
    return buildEvidence({
      ok: false,
      phase: 'docker_preflight',
      code: 'docker_unavailable',
      message: 'Docker daemon unavailable — refusing PGlite fallback for G_DOCKER_FRESH_DB_REPLACEMENT',
    });
  }

  const plan = loadForwardPlan();
  if (!plan.ok) {
    return buildEvidence({
      ok: false,
      phase: 'manifest_integrity',
      errors: plan.errors,
    });
  }
  const forward = plan.forward || [];
  const forwardCount = forward.length;

  const cycles = [];
  const errors = [];

  for (let index = 1; index <= 2; index += 1) {
    let cleanup = null;
    let cleanupCalled = false;
    const callCleanup = () => {
      if (cleanupCalled) return;
      cleanupCalled = true;
      if (typeof cleanup === 'function') cleanup();
    };
    const cycle = {
      index,
      volume: null,
      database: null,
      appliedCount: 0,
      schema_migrations: null,
      schema_fingerprint: null,
      cleanup: false,
    };
    try {
      const harness = await startHarness();
      cleanup = harness && harness.cleanup;
      if (!harness || harness.backend !== 'docker') {
        callCleanup();
        cycle.cleanup = cleanupCalled;
        cycles.push(cycle);
        return buildEvidence({
          ok: false,
          phase: 'docker_backend_required',
          code: 'non_docker_backend',
          message: 'Harness must return backend=docker (PGlite fallback forbidden)',
          backendObserved: harness && harness.backend,
          forwardCount,
          cycles,
        });
      }

      const volume = harness.volume
        || resolveVolumeName(harness.admin)
        || null;
      cycle.volume = volume;

      await waitForReady(harness.admin, d.waitAttempts);
      const suffix = randomSuffix();
      const dbName = `wh_mig_fd_${index}_${suffix}`;
      cycle.database = dbName;
      await createDatabase(harness.admin, dbName);

      const connection = { ...harness.admin, database: dbName };
      const applied = await runMigrations({ connection });
      if (!applied || !applied.ok) {
        errors.push({
          cycle: index,
          code: 'migration_apply_failed',
          detail: (applied && applied.errors) || null,
        });
        cycle.appliedCount = (applied && applied.applied && applied.applied.length) || 0;
        callCleanup();
        cycle.cleanup = cleanupCalled;
        cycles.push(cycle);
        return buildEvidence({
          ok: false,
          phase: 'migration_apply',
          forwardCount,
          cycles,
          errors,
        });
      }
      cycle.appliedCount = (applied.applied || []).length;
      if (cycle.appliedCount !== forwardCount) {
        errors.push({
          cycle: index,
          code: 'forward_apply_count_mismatch',
          expected: forwardCount,
          actual: cycle.appliedCount,
        });
        callCleanup();
        cycle.cleanup = cleanupCalled;
        cycles.push(cycle);
        return buildEvidence({
          ok: false,
          phase: 'migration_apply',
          forwardCount,
          cycles,
          errors,
        });
      }

      const snap = await snapshotState(connection);
      cycle.schema_migrations = snap.schema_migrations;
      cycle.schema_fingerprint = snap.schema_fingerprint;
    } catch (e) {
      errors.push({
        cycle: index,
        code: 'cycle_exception',
        message: String(e && e.message ? e.message : e).slice(0, 800),
      });
      callCleanup();
      cycle.cleanup = cleanupCalled;
      cycles.push(cycle);
      return buildEvidence({
        ok: false,
        phase: 'cycle_exception',
        forwardCount,
        cycles,
        errors,
      });
    } finally {
      callCleanup();
      cycle.cleanup = cleanupCalled;
    }
    cycles.push(cycle);
  }

  const volumeA = cycles[0] && cycles[0].volume;
  const volumeB = cycles[1] && cycles[1].volume;
  const volumesDistinct = Boolean(
    volumeA
    && volumeB
    && volumeA !== volumeB,
  );
  const migA = JSON.stringify((cycles[0] && cycles[0].schema_migrations) || null);
  const migB = JSON.stringify((cycles[1] && cycles[1].schema_migrations) || null);
  const schemaMigrationsEqual = migA === migB && migA !== 'null';
  const fpA = cycles[0] && cycles[0].schema_fingerprint;
  const fpB = cycles[1] && cycles[1].schema_fingerprint;
  const schemaFingerprintEqual = Boolean(fpA && fpB && fpA === fpB);
  const bothCleaned = cycles.every((c) => c.cleanup === true);

  const ok = volumesDistinct
    && schemaMigrationsEqual
    && schemaFingerprintEqual
    && bothCleaned
    && errors.length === 0;

  return buildEvidence({
    ok,
    phase: ok ? 'compared' : 'compare_failed',
    forwardCount,
    cycles: cycles.map((c) => ({
      index: c.index,
      volume: c.volume,
      database: c.database,
      appliedCount: c.appliedCount,
      schema_migrations: c.schema_migrations,
      schema_fingerprint: c.schema_fingerprint,
      cleanup: c.cleanup,
    })),
    volumes_distinct: volumesDistinct,
    schema_migrations_equal: schemaMigrationsEqual,
    schema_fingerprint_equal: schemaFingerprintEqual,
    cleanup_ok: bothCleaned,
    errors: errors.length ? errors : undefined,
  });
}

function mockForwardPlan(ids) {
  return {
    ok: true,
    forward: ids.map((id, i) => ({
      id,
      filename: `${id}.sql`,
      sha256: String(i + 1).repeat(64).slice(0, 64),
      order: i + 1,
      classification: 'canonical_forward',
      inForwardChain: true,
    })),
    errors: [],
  };
}

function mockSnapshot(fingerprint, migrationIds) {
  return {
    schema_migrations: migrationIds.map((id, i) => ({
      id,
      filename: `${id}.sql`,
      checksum_sha256: `checksum_${id}`,
      apply_order: i + 1,
      apply_kind: 'executed_by_canonical_runner',
      checksum_mode: 'canonical_lf_v1',
    })),
    schema_fingerprint: fingerprint,
  };
}

function mockHarnessFactory(opts) {
  const options = opts || {};
  let n = 0;
  return async () => {
    n += 1;
    const volume = typeof options.volumeFor === 'function'
      ? options.volumeFor(n)
      : (options.volume || `vol-${n}`);
    return {
      backend: options.backend || 'docker',
      admin: {
        host: '127.0.0.1',
        port: (options.basePort || 15000) + n,
        user: 'u',
        password: 'p',
        database: 'postgres',
      },
      volume,
      cleanup: () => {
        if (typeof options.onCleanup === 'function') options.onCleanup(volume, n);
      },
    };
  };
}

async function runOfflineSelfTests() {
  const results = [];

  // 1) Fail-closed when Docker unavailable
  {
    let started = false;
    const ev = await proveFoundationDockerFreshDbReplacement({
      dockerAvailable: () => false,
      startHarness: async () => {
        started = true;
        throw new Error('startHarness must not run when docker unavailable');
      },
      loadForwardPlan: () => mockForwardPlan(['001']),
    });
    results.push({
      name: 'fail_closed_docker_unavailable',
      ok: ev.ok === false
        && ev.code === 'docker_unavailable'
        && ev.phase === 'docker_preflight'
        && started === false,
    });
  }

  // 2) Fail-closed when harness returns non-docker backend
  {
    let cleaned = 0;
    const ev = await proveFoundationDockerFreshDbReplacement({
      dockerAvailable: () => true,
      loadForwardPlan: () => mockForwardPlan(['001']),
      startHarness: mockHarnessFactory({
        backend: 'pglite',
        volume: 'pglite-vol',
        onCleanup: () => { cleaned += 1; },
      }),
    });
    results.push({
      name: 'fail_closed_non_docker_backend',
      ok: ev.ok === false
        && ev.code === 'non_docker_backend'
        && cleaned === 1
        && Array.isArray(ev.cycles)
        && ev.cycles[0]
        && ev.cycles[0].cleanup === true,
    });
  }

  // 3) Distinct named volumes required for pass
  {
    let starts = 0;
    const ev = await proveFoundationDockerFreshDbReplacement({
      dockerAvailable: () => true,
      loadForwardPlan: () => mockForwardPlan(['001']),
      randomSuffix: () => 'aaaa',
      waitForReady: async () => {},
      createDatabase: async () => {},
      runMigrations: async () => ({
        ok: true, applied: ['001'], skipped: [], pending: [], errors: [],
      }),
      snapshotState: async () => mockSnapshot('fp-identical', ['001']),
      startHarness: mockHarnessFactory({
        volume: 'wh-mig-vol-same',
        onCleanup: () => { starts += 1; },
      }),
    });
    results.push({
      name: 'distinct_volume_required',
      ok: ev.ok === false
        && ev.volumes_distinct === false
        && starts === 2
        && ev.cycles[0].volume === 'wh-mig-vol-same'
        && ev.cycles[1].volume === 'wh-mig-vol-same',
    });
  }

  // 4) Cleanup always runs (success + mid-failure)
  {
    const cleanups = [];
    const evOk = await proveFoundationDockerFreshDbReplacement({
      dockerAvailable: () => true,
      loadForwardPlan: () => mockForwardPlan(['001']),
      randomSuffix: () => 'bbbb',
      waitForReady: async () => {},
      createDatabase: async () => {},
      runMigrations: async () => ({
        ok: true, applied: ['001'], skipped: [], pending: [], errors: [],
      }),
      snapshotState: async () => mockSnapshot('fp-ok', ['001']),
      startHarness: mockHarnessFactory({
        volumeFor: (n) => `vol-${n}`,
        onCleanup: (volume) => { cleanups.push(volume); },
      }),
    });

    const cleanupsFail = [];
    const evFail = await proveFoundationDockerFreshDbReplacement({
      dockerAvailable: () => true,
      loadForwardPlan: () => mockForwardPlan(['001']),
      randomSuffix: () => 'cccc',
      waitForReady: async () => {},
      createDatabase: async () => {
        throw new Error('injected create failure');
      },
      startHarness: mockHarnessFactory({
        volume: 'vol-fail',
        onCleanup: (volume) => { cleanupsFail.push(volume); },
      }),
    });

    results.push({
      name: 'cleanup_always',
      ok: evOk.ok === true
        && cleanups.length === 2
        && evOk.cleanup_ok === true
        && evFail.ok === false
        && cleanupsFail.length === 1
        && evFail.cycles[0]
        && evFail.cycles[0].cleanup === true,
    });
  }

  // 5) Mismatch fails closed
  {
    let snapN = 0;
    const ev = await proveFoundationDockerFreshDbReplacement({
      dockerAvailable: () => true,
      loadForwardPlan: () => mockForwardPlan(['001']),
      randomSuffix: () => 'dddd',
      waitForReady: async () => {},
      createDatabase: async () => {},
      runMigrations: async () => ({
        ok: true, applied: ['001'], skipped: [], pending: [], errors: [],
      }),
      snapshotState: async () => {
        snapN += 1;
        return mockSnapshot(snapN === 1 ? 'fp-a' : 'fp-b', ['001']);
      },
      startHarness: mockHarnessFactory({
        volumeFor: (n) => `vol-mismatch-${n}`,
      }),
    });
    results.push({
      name: 'mismatch_fails',
      ok: ev.ok === false
        && ev.volumes_distinct === true
        && ev.schema_fingerprint_equal === false
        && ev.schema_migrations_equal === true,
    });
  }

  // 6) Happy-path equality with distinct volumes
  {
    let starts = 0;
    const ev = await proveFoundationDockerFreshDbReplacement({
      dockerAvailable: () => true,
      loadForwardPlan: () => mockForwardPlan(['001', '002']),
      randomSuffix: () => 'eeee',
      waitForReady: async () => {},
      createDatabase: async () => {},
      runMigrations: async () => ({
        ok: true, applied: ['001', '002'], skipped: [], pending: [], errors: [],
      }),
      snapshotState: async () => mockSnapshot('fp-match', ['001', '002']),
      startHarness: mockHarnessFactory({
        volumeFor: (n) => {
          starts += 1;
          return `vol-ok-${n}`;
        },
      }),
    });
    results.push({
      name: 'happy_path_equal',
      ok: ev.ok === true
        && ev.volumes_distinct === true
        && ev.schema_migrations_equal === true
        && ev.schema_fingerprint_equal === true
        && ev.forwardCount === 2
        && starts === 2,
    });
  }

  const ok = results.every((r) => r.ok === true);
  return {
    ok,
    kind: `${KIND}-offline-self-tests`,
    gate: GATE,
    tests: results,
  };
}

module.exports = {
  KIND,
  GATE,
  proveFoundationDockerFreshDbReplacement,
  runOfflineSelfTests,
  defaultSnapshotState,
  defaultResolveVolumeName,
  defaultLoadForwardPlan,
};

if (require.main === module) {
  const offline = process.argv.includes('--offline')
    || process.env.FOUNDATION_DOCKER_PROOF_OFFLINE === '1';
  const run = offline ? runOfflineSelfTests : () => proveFoundationDockerFreshDbReplacement();
  run()
    .then((evidence) => {
      process.stdout.write(stableStringify(evidence));
      process.exit(evidence && evidence.ok ? 0 : 1);
    })
    .catch((err) => {
      const evidence = buildEvidence({
        ok: false,
        phase: 'unhandled',
        message: String(err && err.message ? err.message : err).slice(0, 800),
      });
      process.stdout.write(stableStringify(evidence));
      process.exit(1);
    });
}
