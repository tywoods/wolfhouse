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
 * verified cleanup (missing/throwing/failed/still-present), startup-after-run
 * failure, and mismatch seams without Docker.
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
  cleanupDockerResources,
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
    }
    try {
      await client.end();
    } catch (_) {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 500));
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
 * Invoke cleanup and classify outcome. cleanup=true only on verified success.
 * @returns {{ ok: boolean, code?: string, message?: string, detail?: object }}
 */
function invokeVerifiedCleanup(cleanup) {
  if (typeof cleanup !== 'function') {
    return { ok: false, code: 'cleanup_missing' };
  }
  try {
    const result = cleanup();
    if (result == null) {
      // Void return is not verified success for this gate.
      return { ok: false, code: 'cleanup_unverified' };
    }
    if (result && result.ok === false) {
      return { ok: false, code: 'cleanup_failed', detail: result };
    }
    if (
      result
      && (result.containerRemoved === false || result.volumeRemoved === false)
    ) {
      return {
        ok: false,
        code: 'cleanup_resources_still_present',
        detail: result,
      };
    }
    if (
      result
      && result.ok === true
      && result.containerRemoved === true
      && result.volumeRemoved === true
    ) {
      return { ok: true, code: 'cleanup_verified' };
    }
    return { ok: false, code: 'cleanup_unverified', detail: result };
  } catch (e) {
    const message = String(e && e.message ? e.message : e).slice(0, 800);
    const code = e && e.code === 'docker_cleanup_resources_still_present'
      ? 'cleanup_resources_still_present'
      : (e && e.code === 'docker_cleanup_rm_failed'
        ? 'cleanup_failed'
        : 'cleanup_threw');
    return {
      ok: false,
      code,
      message,
      containerRemoved: e && e.containerRemoved,
      volumeRemoved: e && e.volumeRemoved,
    };
  }
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
    let cleanupOutcome = null;
    const callCleanup = () => {
      if (cleanupOutcome) return cleanupOutcome;
      cleanupOutcome = invokeVerifiedCleanup(cleanup);
      return cleanupOutcome;
    };
    const cycle = {
      index,
      volume: null,
      container: null,
      database: null,
      appliedCount: 0,
      schema_migrations: null,
      schema_fingerprint: null,
      cleanup: false,
      cleanup_code: null,
    };
    try {
      const harness = await startHarness();
      cleanup = harness && harness.cleanup;
      if (!harness || harness.backend !== 'docker') {
        callCleanup();
        cycle.cleanup = Boolean(cleanupOutcome && cleanupOutcome.ok);
        cycle.cleanup_code = cleanupOutcome && cleanupOutcome.code;
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
      cycle.container = harness.container || null;

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
        callCleanup();
        cycle.cleanup = Boolean(cleanupOutcome && cleanupOutcome.ok);
        cycle.cleanup_code = cleanupOutcome && cleanupOutcome.code;
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
        cycle.cleanup = Boolean(cleanupOutcome && cleanupOutcome.ok);
        cycle.cleanup_code = cleanupOutcome && cleanupOutcome.code;
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
      cycle.cleanup = Boolean(cleanupOutcome && cleanupOutcome.ok);
      cycle.cleanup_code = cleanupOutcome && cleanupOutcome.code;
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
      cycle.cleanup = Boolean(cleanupOutcome && cleanupOutcome.ok);
      cycle.cleanup_code = cleanupOutcome && cleanupOutcome.code;
      if (cleanupOutcome && cleanupOutcome.ok !== true) {
        errors.push({
          cycle: index,
          code: cleanupOutcome.code || 'cleanup_failed',
          message: cleanupOutcome.message || null,
          detail: cleanupOutcome.detail || null,
        });
      }
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
  const cleanupErrors = errors.filter((e) => String(e.code || '').startsWith('cleanup_'));

  const ok = volumesDistinct
    && schemaMigrationsEqual
    && schemaFingerprintEqual
    && bothCleaned
    && cleanupErrors.length === 0
    && errors.length === 0;

  return buildEvidence({
    ok,
    phase: ok ? 'compared' : 'compare_failed',
    forwardCount,
    cycles: cycles.map((c) => ({
      index: c.index,
      volume: c.volume,
      container: c.container,
      database: c.database,
      appliedCount: c.appliedCount,
      schema_migrations: c.schema_migrations,
      schema_fingerprint: c.schema_fingerprint,
      cleanup: c.cleanup,
      cleanup_code: c.cleanup_code,
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

function verifiedCleanupResult() {
  return { ok: true, containerRemoved: true, volumeRemoved: true };
}

function mockHarnessFactory(opts) {
  const options = opts || {};
  let n = 0;
  return async () => {
    n += 1;
    const volume = typeof options.volumeFor === 'function'
      ? options.volumeFor(n)
      : (options.volume || `vol-${n}`);
    const container = typeof options.containerFor === 'function'
      ? options.containerFor(n)
      : (options.container || `ctr-${n}`);
    const harness = {
      backend: options.backend || 'docker',
      admin: {
        host: '127.0.0.1',
        port: (options.basePort || 15000) + n,
        user: 'u',
        password: 'p',
        database: 'postgres',
      },
      volume,
      container,
    };
    if (options.omitCleanup) {
      // intentionally no cleanup
    } else if (typeof options.cleanup === 'function') {
      harness.cleanup = options.cleanup;
    } else {
      harness.cleanup = () => {
        if (typeof options.onCleanup === 'function') options.onCleanup(volume, n);
        if (options.cleanupResult !== undefined) return options.cleanupResult;
        return verifiedCleanupResult();
      };
    }
    return harness;
  };
}

function baseCycleDeps(extra) {
  return Object.assign({
    dockerAvailable: () => true,
    loadForwardPlan: () => mockForwardPlan(['001']),
    randomSuffix: () => 'zzzz',
    waitForReady: async () => {},
    createDatabase: async () => {},
    runMigrations: async () => ({
      ok: true, applied: ['001'], skipped: [], pending: [], errors: [],
    }),
    snapshotState: async () => mockSnapshot('fp-ok', ['001']),
  }, extra || {});
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
      ...baseCycleDeps({ randomSuffix: () => 'aaaa' }),
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

  // 4) Cleanup always runs (success + mid-failure) with verified success
  {
    const cleanups = [];
    const evOk = await proveFoundationDockerFreshDbReplacement({
      ...baseCycleDeps({ randomSuffix: () => 'bbbb' }),
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
      ...baseCycleDeps({ randomSuffix: () => 'dddd' }),
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
      ...baseCycleDeps({
        randomSuffix: () => 'eeee',
        loadForwardPlan: () => mockForwardPlan(['001', '002']),
        runMigrations: async () => ({
          ok: true, applied: ['001', '002'], skipped: [], pending: [], errors: [],
        }),
        snapshotState: async () => mockSnapshot('fp-match', ['001', '002']),
      }),
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
        && starts === 2
        && ev.cycles.every((c) => c.cleanup === true
          && c.cleanup_code === 'cleanup_verified'),
    });
  }

  // 7) RED: missing cleanup fails the proof
  {
    const ev = await proveFoundationDockerFreshDbReplacement({
      ...baseCycleDeps(),
      startHarness: mockHarnessFactory({ omitCleanup: true, volumeFor: (n) => `vol-miss-${n}` }),
    });
    results.push({
      name: 'red_cleanup_missing',
      ok: ev.ok === false
        && ev.cleanup_ok === false
        && ev.cycles[0].cleanup === false
        && ev.cycles[0].cleanup_code === 'cleanup_missing'
        && Array.isArray(ev.errors)
        && ev.errors.some((e) => e.code === 'cleanup_missing'),
    });
  }

  // 8) RED: throwing cleanup fails the proof
  {
    const ev = await proveFoundationDockerFreshDbReplacement({
      ...baseCycleDeps(),
      startHarness: mockHarnessFactory({
        volumeFor: (n) => `vol-throw-${n}`,
        cleanup: () => {
          throw new Error('injected cleanup throw');
        },
      }),
    });
    results.push({
      name: 'red_cleanup_throwing',
      ok: ev.ok === false
        && ev.cleanup_ok === false
        && ev.cycles[0].cleanup === false
        && ev.cycles[0].cleanup_code === 'cleanup_threw'
        && Array.isArray(ev.errors)
        && ev.errors.some((e) => e.code === 'cleanup_threw'),
    });
  }

  // 9) RED: failed cleanup (ok:false) fails the proof
  {
    const ev = await proveFoundationDockerFreshDbReplacement({
      ...baseCycleDeps(),
      startHarness: mockHarnessFactory({
        volumeFor: (n) => `vol-failclean-${n}`,
        cleanupResult: { ok: false, reason: 'rm_failed' },
      }),
    });
    results.push({
      name: 'red_cleanup_failed',
      ok: ev.ok === false
        && ev.cleanup_ok === false
        && ev.cycles[0].cleanup === false
        && ev.cycles[0].cleanup_code === 'cleanup_failed'
        && Array.isArray(ev.errors)
        && ev.errors.some((e) => e.code === 'cleanup_failed'),
    });
  }

  // 10) RED: resource-still-present cleanup fails the proof
  {
    const ev = await proveFoundationDockerFreshDbReplacement({
      ...baseCycleDeps(),
      startHarness: mockHarnessFactory({
        volumeFor: (n) => `vol-present-${n}`,
        cleanupResult: {
          ok: true,
          containerRemoved: false,
          volumeRemoved: false,
        },
      }),
    });
    results.push({
      name: 'red_cleanup_resources_still_present',
      ok: ev.ok === false
        && ev.cleanup_ok === false
        && ev.cycles[0].cleanup === false
        && ev.cycles[0].cleanup_code === 'cleanup_resources_still_present'
        && Array.isArray(ev.errors)
        && ev.errors.some((e) => e.code === 'cleanup_resources_still_present'),
    });
  }

  // 11) RED: startup-after-run failure cleans container+volume then fails closed
  {
    const calls = [];
    const present = new Set();
    const dockerFn = (args) => {
      calls.push(args.slice());
      const cmd = args[0];
      if (cmd === 'run') {
        // Name is args after --name
        const nameIdx = args.indexOf('--name');
        const volFlag = args.find((a) => a.includes(':/var/lib/postgresql/data'));
        const container = nameIdx >= 0 ? args[nameIdx + 1] : null;
        const volume = volFlag ? volFlag.split(':')[0] : null;
        if (container) present.add(`c:${container}`);
        if (volume) present.add(`v:${volume}`);
        return 'cid-fake\n';
      }
      if (cmd === 'port') {
        throw new Error('injected post-run port failure');
      }
      if (cmd === 'rm') {
        const name = args[args.length - 1];
        present.delete(`c:${name}`);
        return '';
      }
      if (cmd === 'volume' && args[1] === 'rm') {
        const name = args[args.length - 1];
        present.delete(`v:${name}`);
        return '';
      }
      if (cmd === 'ps') {
        const filter = args.includes('--filter')
          ? args[args.indexOf('--filter') + 1]
          : '';
        const m = /name=\^\/(.+)\$$/.exec(filter);
        const name = m ? m[1] : null;
        if (name && present.has(`c:${name}`)) return `${name}\n`;
        return '';
      }
      if (cmd === 'volume' && args[1] === 'ls') {
        return [...present]
          .filter((x) => x.startsWith('v:'))
          .map((x) => x.slice(2))
          .join('\n') + '\n';
      }
      return '';
    };

    let threw = null;
    try {
      await startDisposablePostgresHarness({
        dockerAvailable: () => true,
        docker: dockerFn,
      });
    } catch (e) {
      threw = e;
    }

    const ranRm = calls.some((a) => a[0] === 'rm');
    const ranVolRm = calls.some((a) => a[0] === 'volume' && a[1] === 'rm');
    const leftover = [...present];
    results.push({
      name: 'red_startup_after_run_failure_cleans',
      ok: threw != null
        && /injected post-run port failure/.test(String(threw.message || threw))
        && ranRm
        && ranVolRm
        && leftover.length === 0,
    });
  }

  // 12) Harness cleanupDockerResources: rm failure with resource still present throws
  {
    let rmAttempts = 0;
    const dockerFn = (args) => {
      if (args[0] === 'rm') {
        rmAttempts += 1;
        throw new Error('rm refused');
      }
      if (args[0] === 'volume' && args[1] === 'rm') {
        throw new Error('volume rm refused');
      }
      if (args[0] === 'ps') return 'still-here\n';
      if (args[0] === 'volume' && args[1] === 'ls') return 'still-vol\n';
      return '';
    };
    let err = null;
    try {
      cleanupDockerResources(dockerFn, 'still-here', 'still-vol');
    } catch (e) {
      err = e;
    }
    results.push({
      name: 'red_harness_cleanup_still_present',
      ok: err != null
        && err.code === 'docker_cleanup_resources_still_present'
        && rmAttempts === 1
        && err.containerRemoved === false
        && err.volumeRemoved === false,
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
  invokeVerifiedCleanup,
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
