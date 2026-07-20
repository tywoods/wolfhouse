'use strict';

/**
 * prove-sunset-schema-slice14ad-ledger-baseline-apply — FOUNDATION Slice 14AD
 *
 * Offline RED/GREEN → optional --live path: target authority → observer BEFORE
 * (zero drift under 14AB normalizations, ledger absent) → exactly one gated
 * ledger-baseline-apply → post-check (ledger 39 rows, product fingerprint unchanged).
 * Default offline; preserves historical live evidence when present.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const {
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  MANIFEST_PATH,
  reconcileLedger,
  buildExecutedByCanonicalRunnerProvenance,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  LEDGER_LEGACY_UPGRADE_DDL,
} = require('./lib/migration-integrity');
const {
  hashCanonicalManifest,
  introspectProductSchema,
  fingerprintProductSchema,
  compareSnapshots,
  verifyLiveSession,
  clientConfigFromDsn,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  LEDGER_TABLE,
  buildIdentifierTruncationNotNullProvenance,
  classifyServerVersionClass,
} = require('./lib/sunset-schema-observer');
const {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  MI_LOADER_LOCKS,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  loadProtectedAdminCredentialsViaManagedIdentity,
  zeroPrivateCredentialRefs,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
} = require('./lib/phase-d-managed-identity-credential-loader');
const {
  buildVerifiedTlsSslConfig,
} = require('./lib/phase-d-live-readonly-pg-adapter');
const {
  ENV_TARGET_AUTHORITY,
  exactTargetAuthorityArgv,
  targetAuthorityEnv,
  executeActiveDbTargetAuthority,
  resetTargetAuthorityCounters,
} = require('./lib/phase-d-active-db-target-authority');
const {
  buildObserverCompareOptions,
  summarizeCompare,
  remainingMismatchKeys,
  captureAzurePg15PgcryptoLiveProfile,
} = require('./lib/phase-d-pgcrypto-compatibility-normalization');
const {
  PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED,
  ENV_LEDGER_BASELINE_APPLY,
  CLI_APPLY_LEDGER_BASELINE,
  APPLICATION_NAME,
  AUTHORIZED_SEQUENCE,
  SUCCESS_PATH_QUERY_COUNT,
  APPLY_LOCKS,
  BASELINE_ROW_COUNT,
  STRUCTURAL_BASELINE_COUNT,
  CURRENT_STATE_BASELINE_COUNT,
  MASTER_SHA_BASIS,
  CANON_FP,
  MANIFEST_HASH,
  EXPECTED_BYTE_SHA,
  PROPOSED_LEDGER_ROWS_SHA256,
  SLICE14AC_EVIDENCE_FILE_SHA256,
  LEDGER_DDL,
  LEDGER_TIMESTAMP_SEMANTICS,
  FORBIDDEN_ARGV_FLAGS,
  evaluateLedgerBaselineApplyGates,
  executePhaseDLedgerBaselineApply,
  runAuthorizedLedgerBaselineApplySequence,
  createScriptedLedgerBaselineApplyFakeClientFactory,
  resetLedgerBaselineApplyCounters,
  getLedgerBaselineApplyCounters,
  exactLedgerBaselineApplyArgv,
  ledgerBaselineApplyEnv,
  assertSlice14acEvidenceByteLocked,
  authorizeApplySql,
  hashProposedLedgerRows,
  loadSlice14acEvidence,
  simulateLegacyUpgradeReconcileFailure,
  validateProposedLedgerRows,
} = require('./lib/phase-d-ledger-baseline-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const SLICE14AC_EVIDENCE_PATH = path.join(FIX, 'slice14ac-ledger-eligibility-matrix-evidence.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14ad-ledger-baseline-apply-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14ad-ledger-baseline-apply-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14ad-findings.md');
const APPLY_CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-ledger-baseline-apply.js');

const OBSERVER_APPLICATION_NAME = 'wh-sunset-schema-observer';

/**
 * Locked live product fingerprint from Slice 14AC capture (raw introspect).
 * Differs from expected-product-schema fingerprint (CANON_FP) due to Azure
 * compatibility surface that 14AB normalizations account for in drift count.
 * Proves no schema/data change since 14AC capture when this matches live.
 */
const SLICE14AC_LIVE_PRODUCT_FINGERPRINT = '039b67d034d4bd1eec68cf8a348a1f6fad2b13bcc526f24584127d028d3f0c12';

const FAKE_ADMIN_USER = 'slice14ad-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14ad-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14ad-proof-imds-token-never-commit';

const REQUIRED_RED = Object.freeze([
  'eligibility_hash_drift',
  'ledger_present_refuse',
  'incompatible_ledger_relation_refuse',
  'extra_unauthorized_sql_refuse',
  'partial_insert_rollback_no_retry',
  'wrong_kind_mode_checksum_order_refuse',
  'fabricated_historical_timestamp_refuse',
  'future_runner_mislabel_refuse',
  'legacy_upgrade_null_kind_reconcile_fails',
  'default_path_zero_http_and_clients',
  'missing_apply_flag_or_env',
  'wrong_or_forbidden_argv',
  'managed_identity_requires_env_and_argv',
  'global_live_apply_remains_false',
]);

const REQUIRED_GREEN = Object.freeze([
  'forward_count_39_hash_locks',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'injected_http_success_exact_sequence',
  'runner_reconcile_baseline_kinds_ok',
  'runner_reconcile_null_kind_fails',
  'executed_runner_provenance_shape',
  'timestamp_semantics_documented',
]);

function validSecretValue() {
  return buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
}

function applyArgv(extraFlags) {
  return [...exactLedgerBaselineApplyArgv(), ...(extraFlags || [])];
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
  if (/Bearer\s+slice14ad-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
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

function sanitizeErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => ({
    code: String((e && e.code) || 'phase_d_failed').slice(0, 80),
    message: String((e && e.message) || 'phase d failed')
      .replace(/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/gi, 'postgresql://[REDACTED]:')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .slice(0, 240),
  }));
}

async function runLedgerBaselineObserverCompare(dsn, expectedContract) {
  const cfg = clientConfigFromDsn(dsn);
  const client = new Client(cfg);
  try { cfg.password = undefined; cfg.user = undefined; } catch (_) { /* ignore */ }
  try {
    await client.connect();
    const session = await verifyLiveSession(client);
    if (!session.ok) {
      return {
        ok: false,
        code: 'session_not_read_only',
        remainingMismatchCount: null,
        productFingerprintLive: null,
        ledgerPresent: null,
        blocker: 'session_not_read_only',
        errors: sanitizeErrors(session.errors),
      };
    }

    let versionClass = 'postgresql_15';
    try {
      const verRes = await client.query('SHOW server_version_num');
      const verText = await client.query('SHOW server_version');
      const classified = classifyServerVersionClass(
        Number(verRes.rows[0] && (verRes.rows[0].server_version_num != null
          ? verRes.rows[0].server_version_num
          : Object.values(verRes.rows[0])[0])),
        String(verText.rows[0] && (verText.rows[0].server_version != null
          ? verText.rows[0].server_version
          : Object.values(verText.rows[0])[0] || '')),
      );
      if (classified && classified.versionClass) versionClass = classified.versionClass;
      if (classified && classified.ok !== true) {
        return {
          ok: false,
          code: 'server_version_not_pg15',
          remainingMismatchCount: null,
          productFingerprintLive: null,
          ledgerPresent: null,
          blocker: 'server_version_not_pg15',
        };
      }
    } catch (e) {
      return {
        ok: false,
        code: 'server_version_probe_failed',
        remainingMismatchCount: null,
        productFingerprintLive: null,
        ledgerPresent: null,
        blocker: 'server_version_probe_failed',
      };
    }

    const ledgerRes = await client.query(
      "SELECT COUNT(*)::int AS cnt FROM information_schema.tables "
      + "WHERE table_schema='public' AND table_name=$1",
      [LEDGER_TABLE],
    );
    const ledgerPresent = Number(ledgerRes.rows[0].cnt) > 0;

    const product = await introspectProductSchema(client);
    const productFingerprintLive = fingerprintProductSchema(product.snapshot);
    const truncProv = buildIdentifierTruncationNotNullProvenance();
    const azureContext = {
      verified: true,
      host: EXPECTED_HOST,
      database: EXPECTED_DATABASE,
      versionClass,
    };
    const liveProfile = await captureAzurePg15PgcryptoLiveProfile(client, product.snapshot);
    const cmp = compareSnapshots(
      expectedContract.snapshot,
      product.snapshot,
      buildObserverCompareOptions(
        azureContext,
        versionClass,
        truncProv && truncProv.ok ? truncProv : null,
        {
          enablePgcryptoCompatibilityNormalization: true,
          liveProfile,
        },
      ),
    );
    const summary = summarizeCompare(cmp);
    const remainingMismatchCount = summary.mismatchCount != null ? summary.mismatchCount : null;
    const fingerprintMatchesCapture = productFingerprintLive === SLICE14AC_LIVE_PRODUCT_FINGERPRINT;
    const zeroDrift = remainingMismatchCount === 0;
    return {
      ok: zeroDrift && fingerprintMatchesCapture,
      code: !zeroDrift
        ? 'observer_drift'
        : (fingerprintMatchesCapture ? 'observer_match' : 'product_fingerprint_drift_since_14ac'),
      remainingMismatchCount,
      remainingKeys: summary.remainingKeys || remainingMismatchKeys(cmp.drifts),
      productFingerprintLive,
      productFingerprintExpectedFixture: CANON_FP,
      productFingerprint14acCapture: SLICE14AC_LIVE_PRODUCT_FINGERPRINT,
      fingerprintMatches14acCapture: fingerprintMatchesCapture,
      ledgerPresent,
      versionClass,
      blocker: !zeroDrift
        ? 'observer_drift'
        : (fingerprintMatchesCapture ? null : 'product_fingerprint_drift_since_14ac'),
      errors: zeroDrift && fingerprintMatchesCapture
        ? []
        : [{
          code: !zeroDrift ? 'observer_drift_nonzero' : 'product_fingerprint_drift_since_14ac',
          message: `remainingMismatchCount=${remainingMismatchCount} fingerprintMatch=${fingerprintMatchesCapture}`,
        }],
    };
  } finally {
    try { await client.end(); } catch (_) { /* ignore */ }
  }
}

async function countLedgerRows(dsn) {
  const cfg = clientConfigFromDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const res = await client.query('SELECT count(*)::int AS cnt FROM schema_migration_ledger');
    return Number(res.rows[0].cnt);
  } finally {
    try { await client.end(); } catch (_) { /* ignore */ }
  }
}

function buildApplyLiveOutcome(parsed, exitCode) {
  const p = parsed || {};
  const ok = p.ok === true;
  return {
    attempt: 1,
    ok,
    code: String(p.code || (ok ? 'phase_d_ledger_baseline_apply_ok' : 'ledger_baseline_apply_failed')),
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    steps: Array.isArray(p.steps) ? p.steps.slice() : [],
    baselineRowCount: p.baselineRowCount != null ? p.baselineRowCount : null,
    insertedRowCount: p.insertedRowCount != null ? p.insertedRowCount : null,
    structuralBaselineCount: p.structuralBaselineCount != null ? p.structuralBaselineCount : null,
    currentStateBaselineCount: p.currentStateBaselineCount != null ? p.currentStateBaselineCount : null,
    proposedLedgerRowsSha256: p.proposedLedgerRowsSha256 || null,
    ledgerTxnTs: p.ledgerTxnTs != null ? p.ledgerTxnTs : null,
    queryCalls: p.queryCalls != null ? p.queryCalls : null,
    committed: p.committed === true,
    rolledBack: p.rolledBack === true,
    applicationName: p.applicationName || APPLICATION_NAME,
    schemaMutation: ok ? 'ledger_only' : false,
    dataMutation: false,
    ledgerWritten: p.ledgerWritten === true,
    liveMutation: p.liveMutation === true,
    timestampSemantics: p.timestampSemantics || LEDGER_TIMESTAMP_SEMANTICS,
    errors: sanitizeErrors(p.errors),
    blocker: ok ? null : String(p.code || 'ledger_baseline_apply_failed'),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const wantLive = argv.includes('--live') && !argv.includes('--offline');
  const offlineOnly = !wantLive || process.env.SUNSET_SLICE14AD_PROOF_OFFLINE === '1';

  console.log(offlineOnly
    ? 'prove:sunset-schema-slice14ad — offline only (no live HTTP/PG apply/observer)\n'
    : 'prove:sunset-schema-slice14ad — offline then live authority + observer + apply\n');

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

  if (manifestHash !== MANIFEST_HASH) throw new Error(`manifest hash drift: ${manifestHash}`);
  if (expectedHash !== EXPECTED_BYTE_SHA) throw new Error(`expected hash drift: ${expectedHash}`);
  if (expected.productFingerprint !== CANON_FP) throw new Error('fingerprint drift');
  if (forward.length !== 39) throw new Error('forward count drift');
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) throw new Error('CONNECT_ENABLED must remain activated');
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) throw new Error('global APPLY must remain disabled');
  if (PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED !== true) {
    throw new Error('ledger baseline apply capability must be enabled');
  }
  if (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== true) {
    throw new Error('live MI HTTP must be activated');
  }
  if (!fs.existsSync(APPLY_CLI_PATH)) throw new Error('required ledger-baseline-apply CLI missing');

  const evidenceLock = assertSlice14acEvidenceByteLocked();
  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN, validSecretValue()];
  const red = [];
  const green = [];

  // ── RED ──────────────────────────────────────────────────────────
  {
    const tampered = evidenceLock.rows.slice();
    tampered[0] = { ...tampered[0], checksum_sha256: '0'.repeat(64) };
    let driftDetected = false;
    try {
      validateProposedLedgerRows(tampered);
    } catch (e) {
      driftDetected = e && e.code === 'proposed_ledger_rows_hash_drift';
    }
    resetLedgerBaselineApplyCounters();
    resetManagedIdentityHttpCounters();
    red.push({
      name: 'eligibility_hash_drift',
      ok: driftDetected === true
        && hashProposedLedgerRows(tampered) !== PROPOSED_LEDGER_ROWS_SHA256
        && getLedgerBaselineApplyCounters().clientsInstantiated === 0
        && getManagedIdentityHttpCounters().httpRequestCount === 0,
      code: 'proposed_ledger_rows_hash_drift',
      zeroMutation: true,
    });
  }

  {
    resetLedgerBaselineApplyCounters();
    const present = await executePhaseDLedgerBaselineApply({
      env: ledgerBaselineApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: createScriptedLedgerBaselineApplyFakeClientFactory({
        responses: { ledgerAbsent: { rows: [{ cnt: 1 }], rowCount: 1 } },
      }),
    });
    if (present.ok || present.rolledBack !== true) {
      throw new Error(`ledger present must refuse+rollback: ${JSON.stringify(present)}`);
    }
    red.push({ name: 'ledger_present_refuse', ok: true, code: present.code, rolledBack: true });
  }

  {
    resetLedgerBaselineApplyCounters();
    const incompat = await executePhaseDLedgerBaselineApply({
      env: ledgerBaselineApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: createScriptedLedgerBaselineApplyFakeClientFactory({
        responses: {
          ledgerAbsent: { rows: [{ cnt: 0 }], rowCount: 1 },
          ledgerRelkind: { rows: [{ relkind: 'v', relname: 'schema_migration_ledger', schema_name: 'public' }], rowCount: 1 },
        },
      }),
    });
    if (incompat.ok || incompat.rolledBack !== true) {
      throw new Error(`incompatible ledger must refuse: ${JSON.stringify(incompat)}`);
    }
    red.push({ name: 'incompatible_ledger_relation_refuse', ok: true, code: incompat.code, rolledBack: true });
  }

  {
    const rejectedSql = [];
    for (const sql of [
      'DROP TABLE schema_migration_ledger',
      'DELETE FROM public.bookings',
      'UPDATE public.bookings SET id = id',
      'INSERT INTO public.bookings (id) VALUES (1)',
      'CREATE TABLE public.evil (id int)',
      'CREATE INDEX idx_evil ON public.bookings (id)',
      'SELECT 1 FROM migrations',
      path.join('database', 'migrations', '001_init.sql'),
    ]) {
      try {
        authorizeApplySql(sql.includes('.sql') ? 'CREATE TABLE public.evil (id int)' : sql);
        if (!sql.includes('.sql')) throw new Error(`should reject: ${sql}`);
      } catch (e) {
        if (e.code !== 'unauthorized_sql') throw e;
        rejectedSql.push(String(sql).split(/\s+/).slice(0, 2).join(' '));
      }
    }
    let ddlOk = false;
    try {
      authorizeApplySql(LEDGER_DDL.trim());
      ddlOk = true;
    } catch (_) { ddlOk = false; }
    red.push({
      name: 'extra_unauthorized_sql_refuse',
      ok: rejectedSql.length >= 6 && ddlOk === true,
      rejectedStatements: rejectedSql,
      ledgerDdlAuthorized: ddlOk,
    });
  }

  {
    resetLedgerBaselineApplyCounters();
    const partial = await executePhaseDLedgerBaselineApply({
      env: ledgerBaselineApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: createScriptedLedgerBaselineApplyFakeClientFactory({
        queryErrorAt: {
          insert_ledger_row: Object.assign(new Error('insert failed'), { code: 'query_failed' }),
        },
      }),
    });
    const insertAttempts = (partial.steps || []).filter((s) => s === 'insert_ledger_row').length;
    if (partial.ok || partial.rolledBack !== true || partial.steps.includes('COMMIT') || insertAttempts > 1) {
      throw new Error(`partial insert must rollback once: ${JSON.stringify(partial)}`);
    }
    red.push({
      name: 'partial_insert_rollback_no_retry',
      ok: true,
      code: partial.code,
      rolledBack: true,
      insertAttempts,
      noCommit: !partial.steps.includes('COMMIT'),
    });
  }

  {
    resetLedgerBaselineApplyCounters();
    const badRows = evidenceLock.rows.slice();
    badRows[5] = { ...badRows[5], apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER };
    const FakeBadKind = createScriptedLedgerBaselineApplyFakeClientFactory({ proposedRows: badRows });
    const client = new FakeBadKind();
    let badCode = null;
    let badRolled = false;
    try {
      await client.connect();
      await runAuthorizedLedgerBaselineApplySequence(client, {
        proposedRows: badRows,
        forward: evidenceLock.forward,
        secrets: [],
      });
    } catch (e) {
      badCode = (e && e.code) || (e && e.result && e.result.code);
      badRolled = e && e.result && e.result.rolledBack === true;
    }
    try { await client.end(); } catch (_) { /* ignore */ }
    if (badRolled !== true) {
      throw new Error(`wrong kind must refuse+rollback: ${badCode}`);
    }
    red.push({ name: 'wrong_kind_mode_checksum_order_refuse', ok: true, code: badCode, rolledBack: true });
  }

  {
    resetLedgerBaselineApplyCounters();
    const hist = await executePhaseDLedgerBaselineApply({
      env: ledgerBaselineApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: createScriptedLedgerBaselineApplyFakeClientFactory({
        timestampDriftAtIndex: 3,
        timestampDriftValue: new Date('2019-06-01T00:00:00.000Z'),
      }),
    });
    if (hist.ok) throw new Error('fabricated timestamp must refuse');
    red.push({
      name: 'fabricated_historical_timestamp_refuse',
      ok: hist.rolledBack === true,
      code: hist.code,
    });
  }

  {
    const prov = buildExecutedByCanonicalRunnerProvenance(forward[0]);
    let proposedMislabelBlocked = false;
    try {
      const rows = evidenceLock.rows.slice();
      rows[0] = { ...rows[0], apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER };
      validateProposedLedgerRows(rows);
    } catch (e) {
      proposedMislabelBlocked = e && e.code === 'mislabel_executed_runner';
    }
    const baselineRows = evidenceLock.rows.map((r) => ({
      ...r,
      applied_at: new Date().toISOString(),
      ledger_recorded_at: new Date().toISOString(),
    }));
    const reconBaseline = reconcileLedger(forward, baselineRows);
    red.push({
      name: 'future_runner_mislabel_refuse',
      ok: prov.apply_kind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER
        && proposedMislabelBlocked === true
        && reconBaseline.ok === true,
      runnerProvenanceKind: prov.apply_kind,
      reconcileBaselineOk: reconBaseline.ok,
    });
  }

  {
    const legacyFail = simulateLegacyUpgradeReconcileFailure(forward);
    const hasUpgrade = String(LEDGER_LEGACY_UPGRADE_DDL).includes('ADD COLUMN IF NOT EXISTS apply_kind');
    red.push({
      name: 'legacy_upgrade_null_kind_reconcile_fails',
      ok: legacyFail.ok === false
        && legacyFail.errors.some((e) => e.code === 'ledger_apply_kind_null')
        && hasUpgrade === true,
      code: legacyFail.errors[0] && legacyFail.errors[0].code,
    });
  }

  {
    resetLedgerBaselineApplyCounters();
    resetManagedIdentityHttpCounters();
    const def = await executePhaseDLedgerBaselineApply({ env: {}, argv: [] });
    leakScan(def, secrets);
    red.push({
      name: 'default_path_zero_http_and_clients',
      ok: def.ok === false
        && getLedgerBaselineApplyCounters().clientsInstantiated === 0
        && getManagedIdentityHttpCounters().httpRequestCount === 0,
      code: def.code,
    });
  }

  {
    resetLedgerBaselineApplyCounters();
    const noFlag = await executePhaseDLedgerBaselineApply({
      env: ledgerBaselineApplyEnv(),
      argv: applyArgv().filter((a) => a !== CLI_APPLY_LEDGER_BASELINE),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
    });
    const noEnv = await executePhaseDLedgerBaselineApply({
      env: {
        [ENV_LIVE_READONLY]: '1',
        [ENV_LIVE_PREFLIGHT]: '1',
        [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
        [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
      },
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
    });
    red.push({
      name: 'missing_apply_flag_or_env',
      ok: !noFlag.ok && !noEnv.ok,
      flagCode: noFlag.code,
      envCode: noEnv.code,
    });
  }

  {
    const wrongDb = evaluateLedgerBaselineApplyGates({
      env: ledgerBaselineApplyEnv(),
      argv: applyArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
    });
    const forbidden = evaluateLedgerBaselineApplyGates({
      env: ledgerBaselineApplyEnv(),
      argv: [...applyArgv(), '--dsn', 'forbidden', '--drop', '--migrate'],
    });
    red.push({
      name: 'wrong_or_forbidden_argv',
      ok: !wrongDb.ok && !forbidden.ok,
      forbiddenFlags: FORBIDDEN_ARGV_FLAGS.slice(),
    });
  }

  {
    const half = evaluateLedgerBaselineApplyGates({
      env: {
        [ENV_LIVE_READONLY]: '1',
        [ENV_LIVE_PREFLIGHT]: '1',
        [ENV_LEDGER_BASELINE_APPLY]: '1',
        [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      },
      argv: exactLedgerBaselineApplyArgv(),
    });
    red.push({
      name: 'managed_identity_requires_env_and_argv',
      ok: !half.ok,
    });
  }

  {
    red.push({
      name: 'global_live_apply_remains_false',
      ok: PHASE_D_LIVE_APPLY_ENABLED === false
        && PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED === true,
    });
  }

  // ── GREEN ────────────────────────────────────────────────────────
  {
    green.push({
      name: 'forward_count_39_hash_locks',
      ok: forward.length === 39
        && evidenceLock.rows.length === 39
        && evidenceLock.rowsSha === PROPOSED_LEDGER_ROWS_SHA256
        && evidenceLock.fileSha === SLICE14AC_EVIDENCE_FILE_SHA256,
      forwardCount: forward.length,
      proposedRowsSha256: evidenceLock.rowsSha,
    });
  }

  {
    const gatesOk = evaluateLedgerBaselineApplyGates({
      env: ledgerBaselineApplyEnv(),
      argv: exactLedgerBaselineApplyArgv(),
    });
    if (!gatesOk.ok) throw new Error(`CLI gates failed: ${JSON.stringify(gatesOk.errors)}`);
    green.push({ name: 'cli_gates_exact_targets', ok: true, applyLedgerBaseline: true });
  }

  {
    const cliDefault = spawnSync(process.execPath, [APPLY_CLI_PATH], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    if (cliDefault.status === 0) throw new Error('CLI default must refuse');
    leakScan(`${cliDefault.stdout}${cliDefault.stderr}`, secrets);
    green.push({ name: 'cli_default_disabled', ok: true, exitCode: cliDefault.status });
  }

  {
    if (APPLY_LOCKS.applicationName !== APPLICATION_NAME
      || APPLICATION_NAME !== 'wh-sunset-ledger-baseline-apply'
      || APPLY_LOCKS.advisoryLockKey1 !== 0x57480001
      || APPLY_LOCKS.advisoryLockKey2 !== 0x4d494731
      || MI_LOADER_LOCKS.sslmode !== 'verify-full') {
      throw new Error('locks drift');
    }
    green.push({
      name: 'locks_identity_vault_secret_pg_tls_application_name',
      ok: true,
      applicationName: APPLICATION_NAME,
      advisoryLockKey1: APPLY_LOCKS.advisoryLockKey1,
      advisoryLockKey2: APPLY_LOCKS.advisoryLockKey2,
    });
  }

  {
    resetLedgerBaselineApplyCounters();
    resetManagedIdentityHttpCounters();
    const okRun = await executePhaseDLedgerBaselineApply({
      env: ledgerBaselineApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: createScriptedLedgerBaselineApplyFakeClientFactory({}),
    });
    leakScan(okRun, secrets);
    if (!okRun.ok
      || okRun.queryCalls !== SUCCESS_PATH_QUERY_COUNT
      || okRun.insertedRowCount !== BASELINE_ROW_COUNT
      || okRun.ledgerWritten !== true
      || okRun.dataMutation !== false
      || okRun.schemaMutation !== 'ledger_only'
      || JSON.stringify(okRun.steps) !== JSON.stringify(AUTHORIZED_SEQUENCE)) {
      throw new Error(`GREEN injected sequence failed: ${JSON.stringify(okRun)}`);
    }
    green.push({
      name: 'injected_http_success_exact_sequence',
      ok: true,
      queryCalls: okRun.queryCalls,
      successPathQueryCount: SUCCESS_PATH_QUERY_COUNT,
      insertedRowCount: okRun.insertedRowCount,
      ledgerWritten: true,
      schemaMutation: 'ledger_only',
    });
  }

  {
    const baselineRows = evidenceLock.rows.map((r) => ({
      ...r,
      applied_at: new Date().toISOString(),
      ledger_recorded_at: new Date().toISOString(),
    }));
    const recon = reconcileLedger(forward, baselineRows);
    green.push({
      name: 'runner_reconcile_baseline_kinds_ok',
      ok: recon.ok === true,
      structural: STRUCTURAL_BASELINE_COUNT,
      currentState: CURRENT_STATE_BASELINE_COUNT,
    });
  }

  {
    const nullKind = reconcileLedger(forward, [{
      id: forward[0].id,
      filename: forward[0].filename,
      checksum_sha256: forward[0].sha256,
      apply_order: forward[0].order,
      apply_kind: null,
      checksum_mode: CHECKSUM_MODE_CANONICAL_LF_V1,
    }]);
    green.push({
      name: 'runner_reconcile_null_kind_fails',
      ok: nullKind.ok === false
        && nullKind.errors.some((e) => e.code === 'ledger_apply_kind_null'),
    });
  }

  {
    const prov = buildExecutedByCanonicalRunnerProvenance(forward[39] ? forward[39] : forward[forward.length - 1]);
    green.push({
      name: 'executed_runner_provenance_shape',
      ok: prov.apply_kind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER
        && prov.checksum_mode === CHECKSUM_MODE_CANONICAL_LF_V1
        && String(prov.evidence_ref).startsWith('canonical_runner:'),
    });
  }

  {
    green.push({
      name: 'timestamp_semantics_documented',
      ok: LEDGER_TIMESTAMP_SEMANTICS.neverHistoricalExecutionTime === true
        && typeof LEDGER_TIMESTAMP_SEMANTICS.applied_at === 'string'
        && typeof LEDGER_TIMESTAMP_SEMANTICS.ledger_recorded_at === 'string',
      semantics: LEDGER_TIMESTAMP_SEMANTICS,
    });
  }

  // ── LIVE or preserve ─────────────────────────────────────────────
  let liveOutcome = null;
  if (offlineOnly) {
    liveOutcome = preserveLive ? priorEvidence.liveOutcome : null;
    if (preserveLive) console.log('Offline mode: preserved historical live outcomes.\n');
    else console.log('Offline mode: no live apply this run.\n');
  } else {
    console.log('Live section 1/4: target authority (skipPostgres)…\n');
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
      };
    } else {
      console.log('Live section 2/4: observer BEFORE (zero drift, ledger absent)…\n');
      const loadedBefore = await loadProtectedAdminCredentialsViaManagedIdentity({
        env: ledgerBaselineApplyEnv(),
        argv: exactLedgerBaselineApplyArgv(),
      });
      if (!loadedBefore.ok) {
        liveOutcome = {
          ok: false,
          code: loadedBefore.code || 'managed_identity_loader_failed',
          blocker: loadedBefore.code,
        };
        zeroPrivateCredentialRefs(loadedBefore);
      } else {
        const dsnBefore = buildOfflineProofSunsetDatabaseUrl(loadedBefore._user, loadedBefore._password);
        zeroPrivateCredentialRefs(loadedBefore);
        const observerBefore = await runLedgerBaselineObserverCompare(dsnBefore, expected);
        zeroPrivateCredentialRefs({ _dsn: dsnBefore });
        leakScan(observerBefore, secrets);

        if (observerBefore.remainingMismatchCount !== 0
          || observerBefore.ledgerPresent === true
          || observerBefore.fingerprintMatches14acCapture !== true) {
          liveOutcome = {
            ok: false,
            code: observerBefore.remainingMismatchCount !== 0
              ? 'observer_drift_nonzero'
              : (observerBefore.ledgerPresent ? 'ledger_present' : 'product_fingerprint_drift_since_14ac'),
            observerBefore,
            schemaMutation: false,
            dataMutation: false,
            ledgerWritten: false,
            liveApplyAttemptCount: 0,
            blocker: observerBefore.blocker || 'preflight_failed',
          };
        } else {
          console.log('Live section 3/4: exactly one gated ledger-baseline-apply CLI spawn…\n');
          const liveApplyCli = spawnSync(
            process.execPath,
            [APPLY_CLI_PATH, ...exactLedgerBaselineApplyArgv()],
            { encoding: 'utf8', env: { ...process.env, ...ledgerBaselineApplyEnv() } },
          );
          const applyCombined = `${liveApplyCli.stdout || ''}${liveApplyCli.stderr || ''}`;
          leakScan(applyCombined, secrets);
          const applyParsed = parseLastJsonObject(applyCombined);
          const liveApplyOutcome = buildApplyLiveOutcome(applyParsed, liveApplyCli.status);

          let ledgerRowCount = null;
          let observerAfter = null;
          if (liveApplyOutcome.ok === true) {
            console.log('Live section 4/4: post-check (ledger 39 rows, fingerprint unchanged)…\n');
            const loadedAfter = await loadProtectedAdminCredentialsViaManagedIdentity({
              env: ledgerBaselineApplyEnv(),
              argv: exactLedgerBaselineApplyArgv(),
            });
            if (loadedAfter.ok) {
              const dsnAfter = buildOfflineProofSunsetDatabaseUrl(loadedAfter._user, loadedAfter._password);
              zeroPrivateCredentialRefs(loadedAfter);
              try {
                ledgerRowCount = await countLedgerRows(dsnAfter);
              } catch (_) {
                ledgerRowCount = null;
              }
              observerAfter = await runLedgerBaselineObserverCompare(dsnAfter, expected);
              zeroPrivateCredentialRefs({ _dsn: dsnAfter });
            }
            leakScan(observerAfter, secrets);
          }

          liveOutcome = {
            ok: liveApplyOutcome.ok === true
              && ledgerRowCount === BASELINE_ROW_COUNT
              && observerAfter
              && observerAfter.fingerprintMatches14acCapture === true
              && observerAfter.remainingMismatchCount === 0,
            code: liveApplyOutcome.ok === true
              ? (ledgerRowCount === BASELINE_ROW_COUNT
                && observerAfter
                && observerAfter.remainingMismatchCount === 0
                && observerAfter.fingerprintMatches14acCapture === true
                ? 'phase_d_ledger_baseline_apply_ok_postcheck'
                : 'phase_d_ledger_baseline_apply_ok_postcheck_unexpected')
              : liveApplyOutcome.code,
            sameTarget: true,
            observerBefore,
            liveApplyOutcome,
            observerAfter,
            ledgerRowCount,
            productFingerprintUnchanged: observerAfter
              ? observerAfter.fingerprintMatches14acCapture === true
              : null,
            productFingerprint14acCapture: SLICE14AC_LIVE_PRODUCT_FINGERPRINT,
            productFingerprintExpectedFixture: CANON_FP,
            schemaMutation: 'ledger_only',
            dataMutation: false,
            ledgerWritten: liveApplyOutcome.ledgerWritten === true,
            liveMutation: liveApplyOutcome.liveMutation === true,
            liveApplyAttemptCount: 1,
            applicationNameApply: APPLICATION_NAME,
            applicationNameObserver: OBSERVER_APPLICATION_NAME,
            blocker: liveApplyOutcome.ok === true
              && ledgerRowCount === BASELINE_ROW_COUNT
              && observerAfter
              && observerAfter.remainingMismatchCount === 0
              && observerAfter.fingerprintMatches14acCapture === true
              ? null
              : (liveApplyOutcome.blocker || 'postcheck_failed'),
          };
        }
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
  const liveExecCount = (liveBlock && Number(liveBlock.liveApplyAttemptCount) > 0)
    ? Number(liveBlock.liveApplyAttemptCount)
    : 0;
  if (liveExecCount > 1) throw new Error('liveExecutionCount > 1 refused');

  const evidence = {
    kind: 'sunset-schema-observer-slice14ad-ledger-baseline-apply-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER_SHA_BASIS,
    slice: '14AD',
    outcome: offlineOnly && liveExecCount === 0
      ? 'phase_d_ledger_baseline_apply_offline_only'
      : ((liveBlock && liveBlock.code) || 'phase_d_ledger_baseline_apply_unknown'),
    liveMutation: liveBlock ? liveBlock.liveMutation === true : false,
    schemaMutation: liveBlock ? liveBlock.schemaMutation : false,
    dataMutation: false,
    ledgerWritten: liveBlock ? liveBlock.ledgerWritten === true : false,
    kvMutation: false,
    rbacMutation: false,
    networkMutation: false,
    forwardCountUnchanged: 39,
    liveExecutionCount: liveExecCount,
    liveApplyAttemptCount: liveExecCount,
    proposedLedgerRowsSha256: PROPOSED_LEDGER_ROWS_SHA256,
    slice14acEvidenceFileSha256: SLICE14AC_EVIDENCE_FILE_SHA256,
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    baselineRowCount: BASELINE_ROW_COUNT,
    structuralBaselineCount: STRUCTURAL_BASELINE_COUNT,
    currentStateBaselineCount: CURRENT_STATE_BASELINE_COUNT,
    defaultDisabled: true,
    applicationName: APPLICATION_NAME,
    observerApplicationName: OBSERVER_APPLICATION_NAME,
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    successPathQueryCount: SUCCESS_PATH_QUERY_COUNT,
    timestampSemantics: LEDGER_TIMESTAMP_SEMANTICS,
    redCases: red,
    greenCases: green,
    liveOutcome: liveBlock,
    verifyNeverRerunsLive: true,
  };
  leakScan(evidence, secrets);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

  const contract = {
    kind: 'sunset-schema-observer-slice14ad-ledger-baseline-apply-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: true,
    ledgerBaselineApplyLiveEnabled: true,
    globalLiveApplyEnabled: false,
    liveReadonlyConnectEnabled: true,
    liveHttpEnabled: true,
    writesLedger: true,
    executesMigrations: false,
    dataMutation: false,
    schemaMutation: 'ledger_only',
    defaultEnabled: false,
    verifyNeverRerunsLive: true,
    liveExecutionCount: liveExecCount,
    generatedAt,
    masterShaBasis: MASTER_SHA_BASIS,
    slice: '14AD',
    purpose: 'Create provenance-aware schema_migration_ledger and insert exactly 39 Slice-14AC baseline rows; no migration SQL execution.',
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
    applyLocks: {
      applicationName: APPLICATION_NAME,
      advisoryLockKey1: APPLY_LOCKS.advisoryLockKey1,
      advisoryLockKey2: APPLY_LOCKS.advisoryLockKey2,
      advisoryLockLabels: ['WH', 'MIG1'],
      proposedLedgerRowsSha256: PROPOSED_LEDGER_ROWS_SHA256,
      slice14acEvidenceFileSha256: SLICE14AC_EVIDENCE_FILE_SHA256,
      baselineRowCount: BASELINE_ROW_COUNT,
      managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
      keyVaultName: MI_LOADER_LOCKS.keyVaultName,
      secretName: MI_LOADER_LOCKS.secretName,
    },
    commandContract: {
      ledgerBaselineApply: {
        script: 'scripts/run-phase-d-ledger-baseline-apply.js',
        npm: 'phase-d:ledger-baseline-apply',
        requiredEnv: [
          'SUNSET_PHASE_D_LIVE_READONLY=1',
          'SUNSET_PHASE_D_LIVE_PREFLIGHT=1',
          'SUNSET_PHASE_D_LEDGER_BASELINE_APPLY=1',
          'SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity',
          `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
        ],
        requiredArgv: [
          CLI_APPLY_LEDGER_BASELINE,
          '--credential-source managed-identity',
          `--subscription ${TARGETS.subscriptionId}`,
          `--resource-group ${TARGETS.resourceGroup}`,
          `--postgres-server ${TARGETS.postgresServer}`,
          `--database ${TARGETS.database}`,
        ],
        forbiddenArgv: FORBIDDEN_ARGV_FLAGS.slice(),
      },
    },
    ledgerDdlContains: [
      'apply_kind',
      'checksum_mode',
      'evidence_ref',
      'provenance_notes',
      'ledger_recorded_at',
      'schema_migration_ledger_apply_kind_check',
      'schema_migration_ledger_checksum_mode_check',
    ],
    requiredRed: REQUIRED_RED.slice(),
    requiredGreen: REQUIRED_GREEN.slice(),
    forbidden: [
      'migration SQL execution',
      'product DDL/DML',
      'DROP/ALTER product tables',
      'DSN/secrets in evidence',
      'second live apply in verify',
    ],
  };
  leakScan(contract, secrets);
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);

  const findings = [
    '# FOUNDATION Slice 14AD — Ledger baseline apply',
    '',
    `**Status:** ${liveBlock && liveBlock.ok ? 'ledger_baseline_apply_live_ok' : 'offline_ok_awaiting_live'}`,
    `**Master basis:** \`${MASTER_SHA_BASIS}\``,
    `**Canonical fingerprint (unchanged):** \`${CANON_FP}\``,
    `**proposedLedgerRows sha256:** \`${PROPOSED_LEDGER_ROWS_SHA256}\``,
    `**14AC evidence file sha256:** \`${SLICE14AC_EVIDENCE_FILE_SHA256}\``,
    `**Generated:** ${generatedAt}`,
    '',
    '## Baseline rows',
    '',
    `- structural: **${STRUCTURAL_BASELINE_COUNT}**`,
    `- current_state: **${CURRENT_STATE_BASELINE_COUNT}**`,
    `- total: **${BASELINE_ROW_COUNT}**`,
    '',
    '## Offline gates',
    '',
    `- RED: ${REQUIRED_RED.length} cases`,
    `- GREEN: ${REQUIRED_GREEN.length} cases`,
    `- Authorized sequence length: **${SUCCESS_PATH_QUERY_COUNT}**`,
    `- Advisory locks: WH (0x57480001) / MIG1 (0x4d494731)`,
    '',
    '## Timestamp semantics',
    '',
    `- ${LEDGER_TIMESTAMP_SEMANTICS.applied_at}`,
    `- ${LEDGER_TIMESTAMP_SEMANTICS.ledger_recorded_at}`,
    `- neverHistoricalExecutionTime: **${LEDGER_TIMESTAMP_SEMANTICS.neverHistoricalExecutionTime}**`,
    '',
  ];

  if (liveBlock && liveBlock.ok) {
    findings.push(
      '## Live',
      '',
      `apply application_name: \`${APPLICATION_NAME}\``,
      `observer application_name: \`${OBSERVER_APPLICATION_NAME}\``,
      `sameTarget: **true**`,
      `remaining mismatch before/after: **${(liveBlock.observerBefore && liveBlock.observerBefore.remainingMismatchCount)}** / **${(liveBlock.observerAfter && liveBlock.observerAfter.remainingMismatchCount)}**`,
      `ledger absent before: **${liveBlock.observerBefore && liveBlock.observerBefore.ledgerPresent === false}**`,
      `ledger rows after: **${liveBlock.ledgerRowCount}**`,
      `14AC live fingerprint unchanged: **${liveBlock.productFingerprintUnchanged}** (\`${SLICE14AC_LIVE_PRODUCT_FINGERPRINT}\`)`,
      `liveExecutionCount: **${liveExecCount}**`,
      `ledgerTxnTs: \`${(liveBlock.liveApplyOutcome && liveBlock.liveApplyOutcome.ledgerTxnTs) || 'see DB applied_at'}\``,
      '',
      'Mutation flags: schemaMutation=ledger_only; dataMutation=false; ledgerWritten=true; kvMutation=false.',
      '',
    );
  }

  findings.push(
    '## Do not claim',
    '',
    '- Do **not** run verify with `--live`.',
    '- Do **not** execute migration SQL as part of this slice.',
    '- Do **not** claim applied_at/ledger_recorded_at are historical migration execution times.',
    '',
    '## Operator live command',
    '',
    '```',
    'SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_LEDGER_BASELINE_APPLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:ledger-baseline-apply -- --apply-ledger-baseline --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity',
    '```',
    '',
    '## Artifacts',
    '',
    '- `fixtures/sunset-schema-observer/slice14ad-ledger-baseline-apply-evidence.json`',
    '- `fixtures/sunset-schema-observer/slice14ad-ledger-baseline-apply-contract.json`',
    '- `fixtures/sunset-schema-observer/slice14ad-findings.md`',
  );
  fs.writeFileSync(FINDINGS_PATH, `${findings.join('\n')}\n`);

  console.log(`slice14ad offline RED=${red.length} GREEN=${green.length} ok`);
  if (wantLive && liveOutcome) {
    console.log(`slice14ad live ok=${liveOutcome.ok} ledgerRows=${liveOutcome.ledgerRowCount}`);
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
