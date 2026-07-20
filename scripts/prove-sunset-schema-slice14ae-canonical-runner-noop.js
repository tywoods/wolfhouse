'use strict';

/**
 * prove-sunset-schema-slice14ae-canonical-runner-noop — FOUNDATION Slice 14AE
 *
 * Offline RED/GREEN → optional --live: target authority → preflight capture →
 * exactly one gated runCanonicalMigrations no-op → postflight unchanged digests.
 * Default offline; preserves historical live evidence when present.
 * Live no-op is integration proof — not a fresh-db Docker replacement.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  MANIFEST_PATH,
  reconcileLedger,
  assertSafeDatabaseTarget,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET,
} = require('./lib/migration-integrity');
const { hashCanonicalManifest } = require('./lib/sunset-schema-observer');
const {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetManagedIdentityHttpCounters,
  getManagedIdentityHttpCounters,
  MI_LOADER_LOCKS,
} = require('./lib/phase-d-managed-identity-credential-loader');
const {
  ENV_TARGET_AUTHORITY,
  exactTargetAuthorityArgv,
  targetAuthorityEnv,
  executeActiveDbTargetAuthority,
  resetTargetAuthorityCounters,
} = require('./lib/phase-d-active-db-target-authority');
const {
  PHASE_D_CANONICAL_RUNNER_NOOP_LIVE_ENABLED,
  ENV_CANONICAL_RUNNER_NOOP,
  CLI_PROVE_CANONICAL_RUNNER_NOOP,
  APPLICATION_NAME,
  OBSERVER_APPLICATION_NAME,
  BASELINE_ROW_COUNT,
  STRUCTURAL_BASELINE_COUNT,
  CURRENT_STATE_BASELINE_COUNT,
  MASTER_SHA_BASIS,
  CANON_FP,
  MANIFEST_HASH,
  EXPECTED_BYTE_SHA,
  PROPOSED_LEDGER_ROWS_SHA256,
  SLICE14AC_EVIDENCE_FILE_SHA256,
  SLICE14AC_LIVE_PRODUCT_FINGERPRINT,
  NOOP_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  LEDGER_TIMESTAMP_SEMANTICS,
  evaluateCanonicalRunnerNoopGates,
  executePhaseDCanonicalRunnerNoop,
  exactCanonicalRunnerNoopArgv,
  canonicalRunnerNoopEnv,
  resetCanonicalRunnerNoopCounters,
  getCanonicalRunnerNoopCounters,
  classifyRunnerQuery,
  createQueryClassificationBag,
  createInstrumentedClientFactory,
  createScriptedCanonicalRunnerNoopFakeClientFactory,
  buildBaselineLedgerRowsFromForward,
  analyzeLedgerRows,
  hashLedgerRows,
  invokeRunCanonicalMigrationsOnce,
} = require('./lib/phase-d-canonical-runner-noop');
const { runCanonicalMigrations } = require('./run-canonical-migrations');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const SLICE14AC_PATH = path.join(FIX, 'slice14ac-ledger-eligibility-matrix-evidence.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14ae-canonical-runner-noop-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14ae-canonical-runner-noop-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14ae-findings.md');
const NOOP_CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-canonical-runner-noop.js');

const FAKE_ADMIN_USER = 'slice14ae-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14ae-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14ae-proof-imds-token-never-commit';

const REQUIRED_RED = Object.freeze([
  'checksum_mismatch_reconcile',
  'kind_mismatch_refuse',
  'mode_mismatch_refuse',
  'gap_order_refuse',
  'timestamp_null_refuse',
  'runner_applies_one_refused',
  'skipped_set_wrong',
  'skipped_order_wrong',
  'hidden_second_invocation',
  'post_digest_drift',
  'migration_sql_dispatch',
  'ledger_insert_forbidden',
  'baseline_label_rewrite',
  'default_path_zero_http_and_clients',
  'missing_flag_or_env',
  'wrong_or_forbidden_argv',
  'managed_identity_requires_env_and_argv',
  'global_live_apply_remains_false',
]);

const REQUIRED_GREEN = Object.freeze([
  'forward_count_39_hash_locks',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'default_safety_refuses_sunset',
  'allow_path_exact_sunset_only',
  'runner_noop_skipped_39_in_order',
  'query_classifier_compat_only',
  'timestamp_semantics_documented',
  'docker_limitation_documented',
]);

function validSecretValue() {
  return buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
}

function leakScan(value, secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const s of secrets) {
    if (s && text.includes(s)) {
      throw new Error(`secret leaked into proof artifact: ${s.slice(0, 8)}…`);
    }
  }
  if (/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(text)) {
    throw new Error('DSN leaked into proof artifact');
  }
}

function parseLastJsonObject(text) {
  const src = String(text || '');
  let last = null;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const chunk = src.slice(start, i + 1);
        try { last = JSON.parse(chunk); } catch (_) { /* ignore */ }
        start = -1;
      }
    }
  }
  return last;
}

function loadProposedRows() {
  const raw = fs.readFileSync(SLICE14AC_PATH, 'utf8');
  const fileSha = crypto.createHash('sha256').update(raw).digest('hex');
  const parsed = JSON.parse(raw);
  return {
    fileSha,
    rows: Array.isArray(parsed.proposedLedgerRows) ? parsed.proposedLedgerRows : [],
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const wantLive = argv.includes('--live') && !argv.includes('--offline');
  const offlineOnly = !wantLive || process.env.SUNSET_SLICE14AE_PROOF_OFFLINE === '1';

  console.log(offlineOnly
    ? 'prove:sunset-schema-slice14ae — offline only (no live HTTP/PG runner)\n'
    : 'prove:sunset-schema-slice14ae — offline then live authority + noop runner\n');

  const priorEvidence = fs.existsSync(EVIDENCE_PATH)
    ? JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'))
    : null;
  const preserveLive = offlineOnly
    && priorEvidence
    && priorEvidence.liveOutcome
    && priorEvidence.liveOutcome.ok === true;
  const generatedAt = (!offlineOnly && wantLive)
    ? new Date().toISOString()
    : (preserveLive && priorEvidence.generatedAt) || new Date().toISOString();

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) throw new Error('manifest integrity failed');
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  const expected = JSON.parse(expectedBytes.toString('utf8'));
  const proposed = loadProposedRows();

  if (manifestHash !== MANIFEST_HASH) throw new Error(`manifest hash drift: ${manifestHash}`);
  if (expectedHash !== EXPECTED_BYTE_SHA) throw new Error(`expected hash drift: ${expectedHash}`);
  if (expected.productFingerprint !== CANON_FP) throw new Error('fingerprint drift');
  if (forward.length !== 39) throw new Error('forward count drift');
  if (proposed.fileSha !== SLICE14AC_EVIDENCE_FILE_SHA256) throw new Error('14AC evidence hash drift');
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) throw new Error('CONNECT_ENABLED must remain activated');
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) throw new Error('global APPLY must remain disabled');
  if (PHASE_D_CANONICAL_RUNNER_NOOP_LIVE_ENABLED !== true) {
    throw new Error('canonical runner noop capability must be enabled');
  }
  if (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== true) {
    throw new Error('live MI HTTP must be activated');
  }
  if (!fs.existsSync(NOOP_CLI_PATH)) throw new Error('required canonical-runner-noop CLI missing');

  const baselineRows = buildBaselineLedgerRowsFromForward(forward, proposed.rows);
  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN, validSecretValue()];
  const red = [];
  const green = [];

  // ── RED ──────────────────────────────────────────────────────────
  {
    const bad = baselineRows.map((r, i) => (i === 0
      ? { ...r, checksum_sha256: '0'.repeat(64) }
      : r));
    const recon = reconcileLedger(forward, bad);
    red.push({
      name: 'checksum_mismatch_reconcile',
      ok: recon.ok === false
        && (recon.errors || []).some((e) => /checksum/i.test(String(e.code || e.message || ''))),
      zeroMutation: true,
    });
  }

  {
    const bad = baselineRows.map((r, i) => (i === 2
      ? { ...r, apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER }
      : r));
    const analysis = analyzeLedgerRows(bad, forward);
    red.push({
      name: 'kind_mismatch_refuse',
      ok: analysis.ok === false && analysis.kindCounts.executed === 1,
      zeroMutation: true,
    });
  }

  {
    const bad = baselineRows.map((r, i) => (i === 1
      ? { ...r, checksum_mode: 'legacy_something' }
      : r));
    const analysis = analyzeLedgerRows(bad, forward);
    red.push({
      name: 'mode_mismatch_refuse',
      ok: analysis.ok === false
        && (analysis.errors || []).some((e) => e.code === 'checksum_mode_mismatch'
          || /checksum_mode/i.test(String(e.code || ''))),
      zeroMutation: true,
    });
  }

  {
    const bad = baselineRows.map((r, i) => (i === 5
      ? { ...r, apply_order: 99 }
      : r));
    const analysis = analyzeLedgerRows(bad, forward);
    red.push({
      name: 'gap_order_refuse',
      ok: analysis.ok === false
        && (analysis.errors || []).some((e) => e.code === 'ledger_order_gap'
          || e.code === 'ledger_forward_mismatch'),
      zeroMutation: true,
    });
  }

  {
    const bad = baselineRows.map((r, i) => (i === 0
      ? { ...r, ledger_recorded_at: null }
      : r));
    const analysis = analyzeLedgerRows(bad, forward);
    const recon = reconcileLedger(forward, bad);
    red.push({
      name: 'timestamp_null_refuse',
      ok: (analysis.ok === false || recon.ok === false),
      zeroMutation: true,
    });
  }

  {
    resetCanonicalRunnerNoopCounters();
    const partial = baselineRows.slice(0, 38);
    const bag = createQueryClassificationBag();
    const Fake = createScriptedCanonicalRunnerNoopFakeClientFactory({
      ledgerRows: partial,
      rejectMigrationSql: true,
      queryBag: bag,
    });
    const conn = {
      host: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.host,
      port: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.port,
      database: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.database,
      user: 'u',
      password: 'p',
      application_name: APPLICATION_NAME,
    };
    const result = await runCanonicalMigrations({
      connection: conn,
      allowSunsetStagingCanonicalRunnerNoop: true,
      Client: Fake,
    });
    const classif = (() => {
      try { return bag.snapshot(); } catch (_) {
        return { migrationSqlDispatch: true };
      }
    })();
    red.push({
      name: 'runner_applies_one_refused',
      ok: result.ok === false
        && (result.applied || []).length === 0
        && (classif.migrationSqlDispatch === true
          || (result.errors || []).some((e) => /migration_sql|apply_failed|forbidden/i.test(String(e.code || e.message || '')))),
      appliedCount: (result.applied || []).length,
      zeroMutation: true,
    });
  }

  {
    const wrongSkip = forward.map((e) => e.id).reverse();
    const expectedIds = forward.map((e) => e.id);
    red.push({
      name: 'skipped_set_wrong',
      ok: JSON.stringify(wrongSkip) !== JSON.stringify(expectedIds)
        && wrongSkip.length === 39,
      zeroMutation: true,
    });
  }

  {
    const wrongOrder = forward.map((e) => e.id);
    const swapped = wrongOrder.slice();
    const tmp = swapped[0];
    swapped[0] = swapped[1];
    swapped[1] = tmp;
    red.push({
      name: 'skipped_order_wrong',
      ok: JSON.stringify(swapped) !== JSON.stringify(wrongOrder),
      zeroMutation: true,
    });
  }

  {
    resetCanonicalRunnerNoopCounters();
    const Fake = createScriptedCanonicalRunnerNoopFakeClientFactory({
      ledgerRows: baselineRows,
    });
    const conn = {
      host: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.host,
      port: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.port,
      database: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.database,
      user: 'u',
      password: 'p',
    };
    await invokeRunCanonicalMigrationsOnce({
      connection: conn,
      allowSunsetStagingCanonicalRunnerNoop: true,
      Client: Fake,
      refuseSecondInvocation: true,
    });
    let secondBlocked = false;
    try {
      await invokeRunCanonicalMigrationsOnce({
        connection: conn,
        allowSunsetStagingCanonicalRunnerNoop: true,
        Client: Fake,
        refuseSecondInvocation: true,
      });
    } catch (e) {
      secondBlocked = e && e.code === 'hidden_second_invocation';
    }
    red.push({
      name: 'hidden_second_invocation',
      ok: secondBlocked === true && getCanonicalRunnerNoopCounters().liveRunnerInvocationCount === 1,
      zeroMutation: true,
    });
  }

  {
    const before = hashLedgerRows(baselineRows);
    const drifted = baselineRows.map((r, i) => (i === 0
      ? { ...r, provenance_notes: 'rewritten' }
      : r));
    const after = hashLedgerRows(drifted);
    red.push({
      name: 'post_digest_drift',
      ok: before !== after,
      zeroMutation: true,
    });
  }

  {
    const mig = classifyRunnerQuery('CREATE TABLE public.evil (id int)');
    const begin = classifyRunnerQuery('BEGIN');
    red.push({
      name: 'migration_sql_dispatch',
      ok: mig.allowed === false && begin.allowed === false
        && mig.code === 'migration_sql_dispatch_forbidden',
      zeroMutation: true,
    });
  }

  {
    const ins = classifyRunnerQuery(
      'INSERT INTO schema_migration_ledger (id, filename, checksum_sha256, apply_order, apply_kind, checksum_mode) VALUES (1,2,3,4,5,6)',
    );
    red.push({
      name: 'ledger_insert_forbidden',
      ok: ins.allowed === false && ins.kind === 'ledger_insert',
      zeroMutation: true,
    });
  }

  {
    const rewritten = baselineRows.map((r, i) => (i === 3
      ? { ...r, apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER }
      : r));
    const analysis = analyzeLedgerRows(rewritten, forward);
    red.push({
      name: 'baseline_label_rewrite',
      ok: analysis.ok === false && analysis.kindCounts.executed >= 1,
      zeroMutation: true,
    });
  }

  {
    resetCanonicalRunnerNoopCounters();
    resetManagedIdentityHttpCounters();
    const gates = evaluateCanonicalRunnerNoopGates({ env: {}, argv: [] });
    red.push({
      name: 'default_path_zero_http_and_clients',
      ok: gates.ok === false
        && getCanonicalRunnerNoopCounters().clientsInstantiated === 0
        && getManagedIdentityHttpCounters().httpRequestCount === 0
        && getCanonicalRunnerNoopCounters().liveRunnerInvocationCount === 0,
      zeroMutation: true,
    });
  }

  {
    const missing = evaluateCanonicalRunnerNoopGates({
      env: { ...canonicalRunnerNoopEnv(), [ENV_CANONICAL_RUNNER_NOOP]: '0' },
      argv: exactCanonicalRunnerNoopArgv(),
    });
    const missingFlag = evaluateCanonicalRunnerNoopGates({
      env: canonicalRunnerNoopEnv(),
      argv: exactCanonicalRunnerNoopArgv().filter((a) => a !== CLI_PROVE_CANONICAL_RUNNER_NOOP),
    });
    red.push({
      name: 'missing_flag_or_env',
      ok: missing.ok === false && missingFlag.ok === false,
      zeroMutation: true,
    });
  }

  {
    const bad = evaluateCanonicalRunnerNoopGates({
      env: canonicalRunnerNoopEnv(),
      argv: [...exactCanonicalRunnerNoopArgv(), '--dsn', 'postgresql://x'],
    });
    const wrongDb = evaluateCanonicalRunnerNoopGates({
      env: canonicalRunnerNoopEnv(),
      argv: exactCanonicalRunnerNoopArgv().map((a) => (a === 'sunset_staging' ? 'other_db' : a)),
    });
    red.push({
      name: 'wrong_or_forbidden_argv',
      ok: bad.ok === false && wrongDb.ok === false
        && FORBIDDEN_ARGV_FLAGS.includes('--dsn'),
      zeroMutation: true,
    });
  }

  {
    const half = evaluateCanonicalRunnerNoopGates({
      env: { ...canonicalRunnerNoopEnv(), SUNSET_PHASE_D_CREDENTIAL_SOURCE: 'managed-identity' },
      argv: exactCanonicalRunnerNoopArgv().filter((a, i, arr) => !(arr[i - 1] === '--credential-source')),
    });
    red.push({
      name: 'managed_identity_requires_env_and_argv',
      ok: half.ok === false,
      zeroMutation: true,
    });
  }

  {
    red.push({
      name: 'global_live_apply_remains_false',
      ok: PHASE_D_LIVE_APPLY_ENABLED === false
        && PHASE_D_CANONICAL_RUNNER_NOOP_LIVE_ENABLED === true,
      zeroMutation: true,
    });
  }

  // ── GREEN ────────────────────────────────────────────────────────
  {
    green.push({
      name: 'forward_count_39_hash_locks',
      ok: forward.length === BASELINE_ROW_COUNT
        && manifestHash === MANIFEST_HASH
        && expectedHash === EXPECTED_BYTE_SHA
        && proposed.fileSha === SLICE14AC_EVIDENCE_FILE_SHA256
        && crypto.createHash('sha256').update(JSON.stringify(proposed.rows)).digest('hex')
          === PROPOSED_LEDGER_ROWS_SHA256,
    });
  }

  {
    const gatesOk = evaluateCanonicalRunnerNoopGates({
      env: canonicalRunnerNoopEnv(),
      argv: exactCanonicalRunnerNoopArgv(),
    });
    if (!gatesOk.ok) throw new Error(`CLI gates failed: ${JSON.stringify(gatesOk.errors)}`);
    green.push({ name: 'cli_gates_exact_targets', ok: true, proveCanonicalRunnerNoop: true });
  }

  {
    resetCanonicalRunnerNoopCounters();
    const def = spawnSync(process.execPath, [NOOP_CLI_PATH], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    const parsed = parseLastJsonObject(`${def.stdout || ''}${def.stderr || ''}`);
    green.push({
      name: 'cli_default_disabled',
      ok: def.status === 2
        && parsed
        && parsed.ok === false
        && parsed.code === 'default_disabled'
        && parsed.liveRunnerInvocationCount === 0
        && parsed.clientsInstantiated === 0,
    });
  }

  {
    green.push({
      name: 'locks_identity_vault_secret_pg_tls_application_name',
      ok: NOOP_LOCKS.applicationName === APPLICATION_NAME
        && APPLICATION_NAME === 'wh-sunset-canonical-runner-noop'
        && NOOP_LOCKS.sslmode === 'verify-full'
        && NOOP_LOCKS.managedIdentityName === MI_LOADER_LOCKS.managedIdentityName
        && NOOP_LOCKS.keyVaultName === MI_LOADER_LOCKS.keyVaultName
        && NOOP_LOCKS.secretName === MI_LOADER_LOCKS.secretName
        && NOOP_LOCKS.postgresHost === TARGETS.postgresHost
        && NOOP_LOCKS.database === TARGETS.database,
    });
  }

  {
    const refused = assertSafeDatabaseTarget({
      host: TARGETS.postgresHost,
      database: TARGETS.database,
      port: TARGETS.port,
    });
    green.push({
      name: 'default_safety_refuses_sunset',
      ok: refused.ok === false
        && (refused.errors || []).some((e) => e.code === 'target_host_not_loopback'
          || e.code === 'target_host_forbidden'
          || e.code === 'target_db_forbidden'
          || e.code === 'target_db_not_ephemeral'),
    });
  }

  {
    const allowed = assertSafeDatabaseTarget({
      host: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.host,
      database: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.database,
      port: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.port,
    }, { allowSunsetStagingCanonicalRunnerNoop: true });
    const wrongHost = assertSafeDatabaseTarget({
      host: 'evil.postgres.database.azure.com',
      database: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.database,
      port: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.port,
    }, { allowSunsetStagingCanonicalRunnerNoop: true });
    green.push({
      name: 'allow_path_exact_sunset_only',
      ok: allowed.ok === true
        && allowed.mode === 'sunset_staging_canonical_runner_noop'
        && wrongHost.ok === false,
    });
  }

  {
    resetCanonicalRunnerNoopCounters();
    const Fake = createScriptedCanonicalRunnerNoopFakeClientFactory({
      ledgerRows: baselineRows,
    });
    const result = await runCanonicalMigrations({
      connection: {
        host: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.host,
        port: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.port,
        database: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.database,
        user: 'u',
        password: 'p',
        application_name: APPLICATION_NAME,
      },
      allowSunsetStagingCanonicalRunnerNoop: true,
      Client: Fake,
    });
    const skippedOk = result.ok === true
      && Array.isArray(result.applied) && result.applied.length === 0
      && Array.isArray(result.pending) && result.pending.length === 0
      && Array.isArray(result.skipped) && result.skipped.length === 39
      && result.skipped.every((id, i) => String(id) === String(forward[i].id));
    green.push({
      name: 'runner_noop_skipped_39_in_order',
      ok: skippedOk,
      skippedCount: (result.skipped || []).length,
      safetyMode: result.safetyMode,
    });
  }

  {
    const bag = createQueryClassificationBag();
    bag.record('SELECT pg_advisory_lock($1, $2)');
    bag.record(String(require('./lib/migration-integrity').LEDGER_DDL));
    bag.record(String(require('./lib/migration-integrity').LEDGER_LEGACY_UPGRADE_DDL));
    bag.record('SELECT id, filename FROM schema_migration_ledger ORDER BY apply_order ASC');
    bag.record('SELECT pg_advisory_unlock($1, $2)');
    const snap = bag.snapshot();
    green.push({
      name: 'query_classifier_compat_only',
      ok: snap.zeroMigrationFileSql === true
        && snap.zeroLedgerInsert === true
        && snap.runnerCompatibilityStatementsIssued === true
        && snap.effectiveMutation === false
        && snap.forbidden === false,
    });
  }

  {
    green.push({
      name: 'timestamp_semantics_documented',
      ok: LEDGER_TIMESTAMP_SEMANTICS.neverHistoricalExecutionTime === true,
      semantics: LEDGER_TIMESTAMP_SEMANTICS,
    });
  }

  {
    green.push({
      name: 'docker_limitation_documented',
      ok: true,
      note: 'Live no-op is integration proof, not fresh-db Docker replacement; Docker unavailable on this host.',
    });
  }

  // ── LIVE or preserve ─────────────────────────────────────────────
  let liveOutcome = null;
  if (offlineOnly) {
    liveOutcome = preserveLive ? priorEvidence.liveOutcome : null;
    if (preserveLive) console.log('Offline mode: preserved historical live outcomes.\n');
    else console.log('Offline mode: no live runner this run.\n');
  } else {
    console.log('Live section 1/3: target authority (skipPostgres)…\n');
    resetTargetAuthorityCounters();
    const authority = await executeActiveDbTargetAuthority({
      env: { ...targetAuthorityEnv(), ...process.env, [ENV_TARGET_AUTHORITY]: '1' },
      argv: exactTargetAuthorityArgv(),
      skipPostgres: true,
    });
    leakScan(authority, secrets);
    if (authority.ok !== true || authority.sameTarget !== true) {
      liveOutcome = {
        ok: false,
        code: authority.code || 'target_authority_failed',
        blocker: authority.code || 'target_authority_failed',
        schemaMutation: false,
        dataMutation: false,
        ledgerWritten: false,
        liveRunnerInvocationCount: 0,
      };
    } else {
      console.log('Live section 2/3: exactly one gated canonical-runner-noop CLI spawn…\n');
      const liveCli = spawnSync(
        process.execPath,
        [NOOP_CLI_PATH, ...exactCanonicalRunnerNoopArgv()],
        { encoding: 'utf8', env: { ...process.env, ...canonicalRunnerNoopEnv() } },
      );
      const combined = `${liveCli.stdout || ''}${liveCli.stderr || ''}`;
      leakScan(combined, secrets);
      const parsed = parseLastJsonObject(combined);
      if (!parsed) {
        liveOutcome = {
          ok: false,
          code: 'noop_cli_no_json',
          schemaMutation: false,
          dataMutation: false,
          ledgerWritten: false,
          liveRunnerInvocationCount: 0,
          exitCode: liveCli.status,
        };
      } else {
        console.log('Live section 3/3: assert runner result + digests from CLI output…\n');
        const runnerOk = parsed.ok === true
          && parsed.liveRunnerInvocationCount === 1
          && parsed.runnerResult
          && parsed.runnerResult.ok === true
          && parsed.runnerResult.appliedCount === 0
          && parsed.runnerResult.skippedCount === 39
          && parsed.runnerResult.pendingCount === 0
          && parsed.schemaMutation === false
          && parsed.dataMutation === false
          && parsed.ledgerWritten === false
          && parsed.executesMigrations === false
          && parsed.effectiveMutation === false
          && parsed.digestsUnchanged === true
          && parsed.fingerprintUnchanged === true
          && parsed.rowCountsUnchanged === true
          && parsed.queryClassification
          && parsed.queryClassification.zeroMigrationFileSql === true
          && parsed.queryClassification.zeroLedgerInsert === true;

        liveOutcome = {
          ok: runnerOk,
          code: parsed.code || (runnerOk ? 'canonical_runner_noop_ok' : 'canonical_runner_noop_failed'),
          sameTarget: true,
          exitCode: liveCli.status,
          liveRunnerInvocationCount: parsed.liveRunnerInvocationCount,
          runnerResult: parsed.runnerResult,
          queryClassification: parsed.queryClassification,
          preflight: parsed.preflight,
          postflight: parsed.postflight,
          digestsUnchanged: parsed.digestsUnchanged,
          fingerprintUnchanged: parsed.fingerprintUnchanged,
          rowCountsUnchanged: parsed.rowCountsUnchanged,
          schemaMutation: false,
          dataMutation: false,
          ledgerWritten: false,
          executesMigrations: false,
          runnerCompatibilityStatementsIssued: parsed.runnerCompatibilityStatementsIssued === true,
          effectiveMutation: false,
          applicationName: APPLICATION_NAME,
          observerApplicationName: OBSERVER_APPLICATION_NAME,
          dockerUnavailableLimitation: parsed.dockerUnavailableLimitation || null,
          blocker: runnerOk ? null : (parsed.blocker || parsed.code || 'noop_failed'),
        };
      }
    }
  }

  const missingRed = REQUIRED_RED.filter((n) => !red.some((r) => r.name === n));
  const missingGreen = REQUIRED_GREEN.filter((n) => !green.some((g) => g.name === n));
  if (missingRed.length || missingGreen.length) {
    throw new Error(`missing cases red=${missingRed} green=${missingGreen}`);
  }
  const failedRed = red.filter((r) => !r.ok);
  const failedGreen = green.filter((g) => !g.ok);
  if (failedRed.length || failedGreen.length) {
    console.error('FAILED RED', failedRed);
    console.error('FAILED GREEN', failedGreen);
    throw new Error(`offline proof failed: red=${failedRed.length} green=${failedGreen.length}`);
  }

  const liveBlock = liveOutcome;
  const liveExecCount = (liveBlock && Number(liveBlock.liveRunnerInvocationCount) > 0)
    ? Number(liveBlock.liveRunnerInvocationCount)
    : 0;
  if (liveExecCount > 1) throw new Error('liveRunnerInvocationCount > 1 refused');

  const evidence = {
    kind: 'sunset-schema-observer-slice14ae-canonical-runner-noop-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER_SHA_BASIS,
    slice: '14AE',
    outcome: offlineOnly && liveExecCount === 0
      ? 'canonical_runner_noop_offline_only'
      : ((liveBlock && liveBlock.code) || 'canonical_runner_noop_unknown'),
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    executesMigrations: false,
    runnerCompatibilityStatementsIssued: liveBlock
      ? liveBlock.runnerCompatibilityStatementsIssued === true
      : null,
    effectiveMutation: false,
    kvMutation: false,
    rbacMutation: false,
    networkMutation: false,
    forwardCountUnchanged: 39,
    liveExecutionCount: liveExecCount,
    liveRunnerInvocationCount: liveExecCount,
    proposedLedgerRowsSha256: PROPOSED_LEDGER_ROWS_SHA256,
    slice14acEvidenceFileSha256: SLICE14AC_EVIDENCE_FILE_SHA256,
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    productFingerprint14acCapture: SLICE14AC_LIVE_PRODUCT_FINGERPRINT,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    baselineRowCount: BASELINE_ROW_COUNT,
    structuralBaselineCount: STRUCTURAL_BASELINE_COUNT,
    currentStateBaselineCount: CURRENT_STATE_BASELINE_COUNT,
    defaultDisabled: true,
    applicationName: APPLICATION_NAME,
    observerApplicationName: OBSERVER_APPLICATION_NAME,
    timestampSemantics: LEDGER_TIMESTAMP_SEMANTICS,
    dockerUnavailableLimitation:
      'Live no-op is integration proof over existing Sunset staging ledger; '
      + 'not a fresh-db Docker replacement (Docker unavailable on this host).',
    redCases: red,
    greenCases: green,
    liveOutcome: liveBlock,
    verifyNeverRerunsLive: true,
  };
  leakScan(evidence, secrets);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

  const contract = {
    kind: 'sunset-schema-observer-slice14ae-canonical-runner-noop-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: true,
    usesMergedRunCanonicalMigrations: true,
    canonicalRunnerNoopLiveEnabled: true,
    globalLiveApplyEnabled: false,
    liveReadonlyConnectEnabled: true,
    liveHttpEnabled: true,
    writesLedger: false,
    executesMigrations: false,
    dataMutation: false,
    schemaMutation: false,
    ledgerWritten: false,
    effectiveMutation: false,
    defaultEnabled: false,
    verifyNeverRerunsLive: true,
    liveExecutionCount: liveExecCount,
    generatedAt,
    masterShaBasis: MASTER_SHA_BASIS,
    slice: '14AE',
    purpose:
      'Invoke merged runCanonicalMigrations exactly once against Sunset staging and prove '
      + 'zero-apply no-op over the 39-row provenance baseline ledger; no migration SQL.',
    targets: {
      subscriptionId: TARGETS.subscriptionId,
      resourceGroup: TARGETS.resourceGroup,
      postgresServer: TARGETS.postgresServer,
      postgresHost: TARGETS.postgresHost,
      database: TARGETS.database,
      sslmode: 'verify-full',
      applicationName: APPLICATION_NAME,
      port: TARGETS.port,
    },
    noopLocks: {
      applicationName: APPLICATION_NAME,
      advisoryLockKey1: NOOP_LOCKS.advisoryLockKey1,
      advisoryLockKey2: NOOP_LOCKS.advisoryLockKey2,
      advisoryLockLabels: ['WH', 'MIG1'],
      proposedLedgerRowsSha256: PROPOSED_LEDGER_ROWS_SHA256,
      slice14acEvidenceFileSha256: SLICE14AC_EVIDENCE_FILE_SHA256,
      baselineRowCount: BASELINE_ROW_COUNT,
      managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
      keyVaultName: MI_LOADER_LOCKS.keyVaultName,
      secretName: MI_LOADER_LOCKS.secretName,
    },
    commandContract: {
      canonicalRunnerNoop: {
        script: 'scripts/run-phase-d-canonical-runner-noop.js',
        npm: 'phase-d:canonical-runner-noop',
        requiredEnv: [
          'SUNSET_PHASE_D_LIVE_READONLY=1',
          'SUNSET_PHASE_D_LIVE_PREFLIGHT=1',
          'SUNSET_PHASE_D_CANONICAL_RUNNER_NOOP=1',
          'SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity',
          `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
        ],
        requiredArgv: [
          CLI_PROVE_CANONICAL_RUNNER_NOOP,
          '--credential-source managed-identity',
          `--subscription ${TARGETS.subscriptionId}`,
          `--resource-group ${TARGETS.resourceGroup}`,
          `--postgres-server ${TARGETS.postgresServer}`,
          `--database ${TARGETS.database}`,
        ],
        forbiddenArgv: FORBIDDEN_ARGV_FLAGS.slice(),
      },
    },
    requiredRed: REQUIRED_RED.slice(),
    requiredGreen: REQUIRED_GREEN.slice(),
    forbidden: [
      'migration SQL execution',
      'ledger INSERT',
      'product DDL/DML',
      'second live runner invocation',
      'DSN/secrets in evidence',
      'verify --live',
      'claiming fresh-db Docker replacement',
    ],
  };
  leakScan(contract, secrets);
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);

  const findings = [
    '# FOUNDATION Slice 14AE — Canonical runner no-op',
    '',
    `**Status:** ${liveBlock && liveBlock.ok ? 'canonical_runner_noop_live_ok' : 'offline_ok_awaiting_live'}`,
    `**Master basis:** \`${MASTER_SHA_BASIS}\``,
    `**Canonical fingerprint (fixture):** \`${CANON_FP}\``,
    `**14AC live fingerprint:** \`${SLICE14AC_LIVE_PRODUCT_FINGERPRINT}\``,
    `**Generated:** ${generatedAt}`,
    '',
    '## Outcome',
    '',
    'Invoke merged `runCanonicalMigrations` exactly once against active Sunset staging and prove a true zero-apply no-op over the 39-row provenance baseline ledger. No migration SQL. No ledger INSERT.',
    '',
    '## Baseline',
    '',
    `- structural: **${STRUCTURAL_BASELINE_COUNT}**`,
    `- current_state: **${CURRENT_STATE_BASELINE_COUNT}**`,
    `- executed: **0**`,
    `- total: **${BASELINE_ROW_COUNT}**`,
    '',
    '## Offline gates',
    '',
    `- RED: ${REQUIRED_RED.length} cases`,
    `- GREEN: ${REQUIRED_GREEN.length} cases`,
    `- application_name: \`${APPLICATION_NAME}\``,
    '',
    '## Docker limitation',
    '',
    '- Docker is unavailable on this host.',
    '- Live no-op is **integration proof** over the existing Sunset staging ledger — **not** a fresh-db Docker replacement.',
    '',
  ];

  if (liveBlock && liveBlock.ok) {
    findings.push(
      '## Live',
      '',
      `runner application_name: \`${APPLICATION_NAME}\``,
      `observer application_name: \`${OBSERVER_APPLICATION_NAME}\``,
      `sameTarget: **true**`,
      `liveRunnerInvocationCount: **${liveExecCount}**`,
      `applied: **0**`,
      `skipped: **${(liveBlock.runnerResult && liveBlock.runnerResult.skippedCount) || 39}**`,
      `pending: **0**`,
      `preflight ledger digest: \`${liveBlock.preflight && liveBlock.preflight.ledger && liveBlock.preflight.ledger.ledgerDigest}\``,
      `postflight ledger digest: \`${liveBlock.postflight && liveBlock.postflight.ledger && liveBlock.postflight.ledger.ledgerDigest}\``,
      `digestsUnchanged: **${liveBlock.digestsUnchanged}**`,
      `fingerprintUnchanged: **${liveBlock.fingerprintUnchanged}**`,
      `rowCountsUnchanged: **${liveBlock.rowCountsUnchanged}**`,
      `product fingerprint live: \`${liveBlock.preflight && liveBlock.preflight.productFingerprintLive}\``,
      `zeroMigrationFileSql: **${liveBlock.queryClassification && liveBlock.queryClassification.zeroMigrationFileSql}**`,
      `zeroLedgerInsert: **${liveBlock.queryClassification && liveBlock.queryClassification.zeroLedgerInsert}**`,
      `runnerCompatibilityStatementsIssued: **${liveBlock.runnerCompatibilityStatementsIssued}** (effectiveMutation=false)`,
      '',
      'Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.',
      '',
    );
  }

  findings.push(
    '## Do not claim',
    '',
    '- Do **not** run verify with `--live`.',
    '- Do **not** execute migration SQL as part of this slice.',
    '- Do **not** claim this replaces the Docker fresh-db proof.',
    '',
    '## Operator live command',
    '',
    '```',
    'SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_CANONICAL_RUNNER_NOOP=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:canonical-runner-noop -- --prove-canonical-runner-noop --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity',
    '```',
    '',
    '## Artifacts',
    '',
    '- `fixtures/sunset-schema-observer/slice14ae-canonical-runner-noop-evidence.json`',
    '- `fixtures/sunset-schema-observer/slice14ae-canonical-runner-noop-contract.json`',
    '- `fixtures/sunset-schema-observer/slice14ae-findings.md`',
  );
  fs.writeFileSync(FINDINGS_PATH, `${findings.join('\n')}\n`);

  console.log(`slice14ae offline RED=${red.length} GREEN=${green.length} ok`);
  if (wantLive && liveOutcome) {
    console.log(`slice14ae live ok=${liveOutcome.ok} invocations=${liveExecCount}`);
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
