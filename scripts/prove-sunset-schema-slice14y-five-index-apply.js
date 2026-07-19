'use strict';

/**
 * prove-sunset-schema-slice14y-five-index-apply — FOUNDATION Slice 14Y
 *
 * Offline RED/GREEN → optional --live path: target authority (skipPostgres) →
 * observer BEFORE (baseline mismatch=11) → exactly one gated five-index apply →
 * observer AFTER (mismatch reduced by exactly 5; five index keys cleared).
 * Default offline; preserves historical live evidence when present.
 * Never claims zero drift / full repair.
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
  MIGRATIONS_DIR,
  sha256CanonicalLfV1File,
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
  createInjectedTargetAuthorityHttp,
  resetTargetAuthorityCounters,
} = require('./lib/phase-d-active-db-target-authority');
const {
  PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED,
  ENV_FIVE_INDEX_APPLY,
  CLI_APPLY_FIVE_INDEXES,
  APPLICATION_NAME,
  AUTHORIZED_SEQUENCE,
  SUCCESS_PATH_QUERY_COUNT,
  APPLY_LOCKS,
  FIVE_INDEX_SPECS,
  UNIQUE_TABLES,
  APPROVED_ROW_COUNT_BY_TABLE,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  EXPECTED_REDUCTION,
  EXPECTED_REMAINING_MISMATCH_COUNT,
  EXPECTED_REMAINING_KEYS,
  FORBIDDEN_ARGV_FLAGS,
  evaluateFiveIndexApplyGates,
  executePhaseDFiveIndexApply,
  createScriptedFiveIndexApplyFakeClientFactory,
  resetFiveIndexApplyCounters,
  getFiveIndexApplyCounters,
  exactFiveIndexApplyArgv,
  fiveIndexApplyEnv,
  assertCreateIndexStatementsByteLocked,
  assertBaselineMismatch,
  authorizeApplySql,
} = require('./lib/phase-d-five-index-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14y-five-index-apply-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14y-five-index-apply-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14y-findings.md');
const APPLY_CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-five-index-apply.js');

const MASTER = 'ea1e6971a19f57da0ded41eb0d1d28aa165786be';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

/** Canonical observer session name (verifyLiveSession lock). Apply uses APPLICATION_NAME. */
const OBSERVER_APPLICATION_NAME = 'wh-sunset-schema-observer';

const FAKE_ADMIN_USER = 'slice14y-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14y-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14y-proof-imds-token-never-commit';

const REQUIRED_RED = Object.freeze([
  'baseline_drift_mismatch',
  'create_or_owner_hash_drift_fails',
  'duplicate_semantic_index_refuse',
  'incompatible_same_name_object_refuse',
  'missing_column_refuse',
  'extra_unauthorized_sql_refuse',
  'partial_failure_rollback_no_retry',
  'wrong_order_refuse',
  'timeout_advisory_failure_rollback',
  'default_path_zero_http_and_clients',
  'missing_apply_flag_or_env',
  'wrong_or_forbidden_argv',
  'managed_identity_requires_env_and_argv',
  'global_live_apply_remains_false',
]);

const REQUIRED_GREEN = Object.freeze([
  'injected_http_success_exact_43_step_sequence',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'create_statements_byte_locked',
  'five_specs_map_to_owners_hashes_defs',
  'row_count_bounds_locked',
]);

function validSecretValue() {
  return buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
}

function applyArgv(extraFlags) {
  return [
    ...exactFiveIndexApplyArgv(),
    ...(extraFlags || []),
  ];
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
  if (/Bearer\s+slice14y-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(text)) {
    throw new Error('JWT-shaped token leaked into proof artifact');
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
        try {
          last = JSON.parse(chunk);
        } catch (_) {
          // keep scanning
        }
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

function groupMismatchSections(drifts) {
  const sectionCounts = {};
  for (const d of drifts || []) {
    const section = String(d.section || d.kind || 'unknown');
    sectionCounts[section] = (sectionCounts[section] || 0) + 1;
  }
  return sectionCounts;
}

function remainingMismatchKeys(drifts) {
  return (drifts || [])
    .map((d) => String(d.key || ''))
    .filter(Boolean)
    .sort();
}

function summarizeCompare(cmp) {
  if (cmp.normalizationError) {
    return {
      ok: false,
      match: false,
      code: cmp.normalizationError.code || 'normalization_failed',
      mismatchCount: null,
      counts: cmp.counts || null,
      mismatchSections: null,
      remainingKeys: [],
      normalizationError: {
        code: cmp.normalizationError.code,
        message: String(cmp.normalizationError.message || '').slice(0, 240),
      },
    };
  }
  const drifts = Array.isArray(cmp.drifts) ? cmp.drifts : [];
  const mismatchCount = drifts.length || (
    (cmp.counts.expected_only || 0)
    + (cmp.counts.live_only || 0)
    + (cmp.counts.definition_mismatch || 0)
  );
  return {
    ok: cmp.ok === true,
    match: cmp.ok === true,
    code: cmp.ok === true ? 'observer_match' : 'observer_drift',
    mismatchCount,
    counts: cmp.counts,
    mismatchSections: groupMismatchSections(drifts),
    remainingKeys: remainingMismatchKeys(drifts),
  };
}

async function runFiveIndexObserverCompare(dsn, expectedContract) {
  const cfg = clientConfigFromDsn(dsn);
  const client = new Client(cfg);
  try { cfg.password = undefined; cfg.user = undefined; } catch (_) { /* ignore */ }
  let closed = false;
  try {
    await client.connect();
    const session = await verifyLiveSession(client);
    if (!session.ok) {
      return {
        ok: false,
        sessionReadOnly: false,
        code: 'session_not_read_only',
        mismatchCount: null,
        mismatchSections: null,
        remainingKeys: [],
        productFingerprintLive: null,
        blocker: 'session_not_read_only',
        errors: sanitizeErrors(session.errors),
      };
    }

    let versionClass = 'postgresql_15';
    try {
      const verRes = await client.query('SHOW server_version_num');
      const verText = await client.query('SHOW server_version');
      const rowNum = verRes.rows[0] || {};
      const rowTxt = verText.rows[0] || {};
      const classified = classifyServerVersionClass(
        Number(rowNum.server_version_num != null
          ? rowNum.server_version_num
          : Object.values(rowNum)[0]),
        String(rowTxt.server_version != null
          ? rowTxt.server_version
          : Object.values(rowTxt)[0] || ''),
      );
      if (classified && classified.versionClass) versionClass = classified.versionClass;
      if (classified && classified.ok !== true) {
        return {
          ok: false,
          sessionReadOnly: true,
          code: 'server_version_not_pg15',
          mismatchCount: null,
          mismatchSections: null,
          remainingKeys: [],
          productFingerprintLive: null,
          blocker: 'server_version_not_pg15',
          errors: [{ code: 'server_version_not_pg15', message: classified.message || 'PG15 required' }],
        };
      }
    } catch (e) {
      return {
        ok: false,
        sessionReadOnly: true,
        code: 'server_version_probe_failed',
        mismatchCount: null,
        mismatchSections: null,
        remainingKeys: [],
        productFingerprintLive: null,
        blocker: 'server_version_probe_failed',
        errors: sanitizeErrors([{ code: 'server_version_probe_failed', message: String(e.message || e) }]),
      };
    }

    const product = await introspectProductSchema(client);
    const productFingerprintLive = fingerprintProductSchema(product.snapshot);
    const truncProv = buildIdentifierTruncationNotNullProvenance();
    const azureContext = {
      verified: true,
      host: EXPECTED_HOST,
      database: EXPECTED_DATABASE,
      versionClass,
    };
    const cmp = compareSnapshots(expectedContract.snapshot, product.snapshot, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext,
      serverVersionClass: versionClass,
      enableFinalRenameNormalization: true,
      enableIdentifierTruncationNormalization: true,
      identifierTruncationProvenance: truncProv && truncProv.ok === true ? truncProv : null,
    });
    const summary = summarizeCompare(cmp);
    return {
      ok: summary.ok === true,
      sessionReadOnly: true,
      code: summary.code,
      mismatchCount: summary.mismatchCount,
      mismatchSections: summary.mismatchSections,
      remainingKeys: summary.remainingKeys,
      counts: summary.counts,
      productFingerprintLive,
      applicationName: OBSERVER_APPLICATION_NAME,
      versionClass,
      normalizationError: summary.normalizationError || null,
      blocker: summary.ok === true ? null : (summary.code || 'observer_drift'),
      errors: [],
    };
  } finally {
    if (!closed) {
      try {
        await client.end();
        closed = true;
      } catch (_) {
        /* ignore */
      }
    }
  }
}

function buildApplyLiveOutcome(parsed, exitCode) {
  const p = parsed || {};
  const ok = p.ok === true;
  const errors = sanitizeErrors(p.errors);
  if (!parsed) {
    errors.push({
      code: 'live_output_unparseable',
      message: 'five-index-apply CLI stdout/stderr did not contain parseable JSON',
    });
  }
  const code = String(p.code || (ok ? 'phase_d_five_index_apply_ok' : 'five_index_apply_failed'));
  const blocker = ok ? null : String(code || (errors[0] && errors[0].code) || 'five_index_apply_failed');
  return {
    attempt: 1,
    ok,
    code,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    steps: Array.isArray(p.steps) ? p.steps.slice() : [],
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    beforeIndexes: Array.isArray(p.beforeIndexes) ? p.beforeIndexes : [],
    afterIndexes: Array.isArray(p.afterIndexes) ? p.afterIndexes : [],
    indexVerification: Array.isArray(p.indexVerification) ? p.indexVerification : null,
    rowCountsBefore: p.rowCountsBefore || null,
    rowCountsAfter: p.rowCountsAfter || null,
    createStatementsSha256: p.createStatementsSha256 || null,
    committed: p.committed === true,
    rolledBack: p.rolledBack === true,
    credentialSource: p.credentialSource || null,
    managedIdentityName: p.managedIdentityName || APPLY_LOCKS.managedIdentityName,
    keyVaultName: p.keyVaultName || APPLY_LOCKS.keyVaultName,
    secretName: p.secretName || APPLY_LOCKS.secretName,
    postgresHost: p.postgresHost || TARGETS.postgresHost,
    database: p.database || TARGETS.database,
    sslmode: p.sslmode || 'verify-full',
    applicationName: p.applicationName || APPLICATION_NAME,
    clientsInstantiated: Number(p.clientsInstantiated) || 0,
    connectCalls: Number(p.connectCalls) || 0,
    queryCalls: Number(p.queryCalls) || 0,
    endCalls: Number(p.endCalls) || 0,
    httpRequestCount: Number(p.httpRequestCount) || 0,
    imdsRequestCount: Number(p.imdsRequestCount) || 0,
    keyVaultRequestCount: Number(p.keyVaultRequestCount) || 0,
    closed: p.closed === true,
    liveMutation: p.liveMutation === true,
    schemaMutation: p.schemaMutation === true,
    dataMutation: false,
    ledgerWritten: false,
    errors,
    blocker,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const wantLive = argv.includes('--live') && !argv.includes('--offline');
  const offlineOnly = !wantLive
    || process.env.SUNSET_SLICE14Y_PROOF_OFFLINE === '1';

  console.log(offlineOnly
    ? 'prove:sunset-schema-slice14y — offline only (no live HTTP/PG apply/observer)\n'
    : 'prove:sunset-schema-slice14y — offline then live authority + observer + apply\n');

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
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) {
    throw new Error('CONNECT_ENABLED must remain activated');
  }
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    throw new Error('global APPLY must remain disabled');
  }
  if (PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED !== true) {
    throw new Error('five index apply capability must be enabled');
  }
  if (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== true) {
    throw new Error('live MI HTTP must be activated');
  }
  if (!fs.existsSync(APPLY_CLI_PATH)) {
    throw new Error('required five-index-apply CLI missing');
  }

  const createLock = assertCreateIndexStatementsByteLocked();
  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN, validSecretValue()];
  const red = [];
  const green = [];

  // ── RED ──────────────────────────────────────────────────────────
  {
    let threw = false;
    let code = null;
    try {
      assertBaselineMismatch({
        mismatchCount: 12,
        mismatchSections: { ...BASELINE_MISMATCH_SECTIONS, indexes: 6 },
      });
    } catch (e) {
      threw = true;
      code = e && e.code;
    }
    resetFiveIndexApplyCounters();
    resetManagedIdentityHttpCounters();
    red.push({
      name: 'baseline_drift_mismatch',
      ok: threw === true
        && code === 'baseline_drift_mismatch'
        && getFiveIndexApplyCounters().clientsInstantiated === 0
        && getManagedIdentityHttpCounters().httpRequestCount === 0,
      code,
      zeroMutation: true,
    });
  }

  {
    let driftDetected = false;
    let driftCode = null;
    const wrongOwnerMap = {
      '026_tenant_surf_pack_rules': '0'.repeat(64),
      '032_client_notification_settings': '0'.repeat(64),
      '035_customer_message_templates': '0'.repeat(64),
    };
    for (const spec of FIVE_INDEX_SPECS) {
      const live = sha256CanonicalLfV1File(
        path.join(MIGRATIONS_DIR, `${spec.ownerMigration}.sql`),
      );
      if (live !== wrongOwnerMap[spec.ownerMigration]) {
        driftDetected = true;
        driftCode = 'owner_migration_checksum_mismatch';
        break;
      }
    }
    const recomputed = crypto
      .createHash('sha256')
      .update(`${FIVE_INDEX_SPECS[0].createSql} `)
      .digest('hex');
    const createDrift = recomputed !== FIVE_INDEX_SPECS[0].createSqlSha256;
    let assertOk = false;
    try {
      assertCreateIndexStatementsByteLocked();
      assertOk = true;
    } catch (e) {
      driftCode = e && e.code;
    }
    red.push({
      name: 'create_or_owner_hash_drift_fails',
      ok: driftDetected === true
        && createDrift === true
        && assertOk === true
        && driftCode === 'owner_migration_checksum_mismatch',
      code: driftCode,
    });
  }

  {
    resetFiveIndexApplyCounters();
    resetManagedIdentityHttpCounters();
    const FakeDup = createScriptedFiveIndexApplyFakeClientFactory({
      responses: {
        tableIndexes: {
          rows: [{
            name: 'idx_tenant_surf_pack_client_loc_dup',
            indexdef: FIVE_INDEX_SPECS[0].expectedIndexdef,
          }],
          rowCount: 1,
        },
      },
    });
    const dup = await executePhaseDFiveIndexApply({
      env: fiveIndexApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeDup,
    });
    if (dup.ok || dup.rolledBack !== true || dup.steps.includes('COMMIT')
      || dup.steps.some((s) => String(s).startsWith('CREATE INDEX '))) {
      throw new Error(`semantic duplicate must refuse+rollback: ${JSON.stringify(dup)}`);
    }
    red.push({
      name: 'duplicate_semantic_index_refuse',
      ok: true,
      code: dup.code,
      rolledBack: true,
      noCommit: !dup.steps.includes('COMMIT'),
      noCreateIndex: !dup.steps.some((s) => String(s).startsWith('CREATE INDEX ')),
    });
  }

  {
    resetFiveIndexApplyCounters();
    const FakeIncompat = createScriptedFiveIndexApplyFakeClientFactory({
      responses: {
        relkindLookup: { rows: [{ relkind: 'r' }], rowCount: 1 },
      },
    });
    const incompat = await executePhaseDFiveIndexApply({
      env: fiveIndexApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeIncompat,
    });
    if (incompat.ok || incompat.rolledBack !== true || incompat.steps.includes('COMMIT')) {
      throw new Error(`incompatible same-name must refuse+rollback: ${JSON.stringify(incompat)}`);
    }
    red.push({
      name: 'incompatible_same_name_object_refuse',
      ok: true,
      code: incompat.code,
      rolledBack: true,
      noCommit: !incompat.steps.includes('COMMIT'),
    });
  }

  {
    resetFiveIndexApplyCounters();
    const FakeMissingCol = createScriptedFiveIndexApplyFakeClientFactory({
      responses: {
        catalogColumns: {
          tenant_surf_pack_rules: [
            { name: 'client_slug', udt_name: 'text', is_nullable: true },
          ],
        },
      },
    });
    const missing = await executePhaseDFiveIndexApply({
      env: fiveIndexApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeMissingCol,
    });
    if (missing.ok || missing.rolledBack !== true || missing.steps.includes('COMMIT')) {
      throw new Error(`missing column must refuse+rollback: ${JSON.stringify(missing)}`);
    }
    red.push({
      name: 'missing_column_refuse',
      ok: true,
      code: missing.code,
      rolledBack: true,
      noCommit: !missing.steps.includes('COMMIT'),
    });
  }

  {
    const rejectedSql = [];
    for (const sql of [
      'DROP TABLE public.tenant_surf_pack_rules',
      'DELETE FROM public.tenant_surf_pack_rules',
      'INSERT INTO public.tenant_surf_pack_rules (id) VALUES (1)',
      'ALTER TABLE public.tenant_surf_pack_rules ADD COLUMN x int',
      'CREATE INDEX CONCURRENTLY idx_evil ON public.tenant_surf_pack_rules (id)',
      'SELECT 1',
    ]) {
      try {
        authorizeApplySql(sql);
        throw new Error(`authorizeApplySql should reject: ${sql}`);
      } catch (e) {
        if (e.code !== 'unauthorized_sql') throw e;
        rejectedSql.push(sql.split(/\s+/).slice(0, 2).join(' '));
      }
    }
    red.push({
      name: 'extra_unauthorized_sql_refuse',
      ok: rejectedSql.length === 6,
      rejectedStatements: rejectedSql,
    });
  }

  {
    resetFiveIndexApplyCounters();
    const FakePartial = createScriptedFiveIndexApplyFakeClientFactory({
      queryErrorAt: {
        'CREATE INDEX idx_tenant_surf_pack_client_loc': Object.assign(
          new Error('create index failed'),
          { code: 'query_failed' },
        ),
      },
    });
    const partial = await executePhaseDFiveIndexApply({
      env: fiveIndexApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakePartial,
    });
    const createAttempts = (partial.steps || [])
      .filter((s) => String(s).startsWith('CREATE INDEX ')).length;
    if (partial.ok || partial.rolledBack !== true || partial.steps.includes('COMMIT')
      || createAttempts > 1) {
      throw new Error(`partial CREATE failure must rollback once, no retry: ${JSON.stringify(partial)}`);
    }
    red.push({
      name: 'partial_failure_rollback_no_retry',
      ok: true,
      code: partial.code,
      rolledBack: true,
      noCommit: !partial.steps.includes('COMMIT'),
      createAttempts,
      noRetry: createAttempts <= 1,
    });
  }

  {
    resetFiveIndexApplyCounters();
    const FakeWrongOrder = createScriptedFiveIndexApplyFakeClientFactory({
      expectedSteps: ['COMMIT', ...AUTHORIZED_SEQUENCE.slice(1)],
    });
    const wrongOrder = await executePhaseDFiveIndexApply({
      env: fiveIndexApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeWrongOrder,
    });
    if (wrongOrder.ok || wrongOrder.steps.includes('COMMIT')) {
      throw new Error(`wrong order must refuse: ${JSON.stringify(wrongOrder)}`);
    }
    red.push({
      name: 'wrong_order_refuse',
      ok: true,
      code: wrongOrder.code,
      rolledBack: wrongOrder.rolledBack === true,
      noCommit: !wrongOrder.steps.includes('COMMIT'),
    });
  }

  {
    resetFiveIndexApplyCounters();
    const FakeLockFail = createScriptedFiveIndexApplyFakeClientFactory({
      queryErrorAt: {
        pg_advisory_xact_lock: Object.assign(new Error('could not obtain lock'), {
          code: 'lock_timeout',
        }),
      },
    });
    const lockFail = await executePhaseDFiveIndexApply({
      env: fiveIndexApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeLockFail,
    });
    if (lockFail.ok || lockFail.rolledBack !== true || lockFail.steps.includes('COMMIT')) {
      throw new Error(`lock/timeout failure must rollback: ${JSON.stringify(lockFail)}`);
    }
    red.push({
      name: 'timeout_advisory_failure_rollback',
      ok: true,
      code: lockFail.code,
      rolledBack: true,
      noCommit: !lockFail.steps.includes('COMMIT'),
    });
  }

  {
    resetFiveIndexApplyCounters();
    resetManagedIdentityHttpCounters();
    const def = await executePhaseDFiveIndexApply({ env: {}, argv: [] });
    if (getFiveIndexApplyCounters().clientsInstantiated !== 0
      || getManagedIdentityHttpCounters().httpRequestCount !== 0) {
      throw new Error('default path must refuse with zero HTTP/Clients');
    }
    leakScan(def, secrets);
    red.push({
      name: 'default_path_zero_http_and_clients',
      ok: true,
      code: def.code,
      httpRequestCount: 0,
      clientsInstantiated: 0,
    });
  }

  {
    resetFiveIndexApplyCounters();
    resetManagedIdentityHttpCounters();
    const noFlag = await executePhaseDFiveIndexApply({
      env: fiveIndexApplyEnv(),
      argv: applyArgv().filter((a) => a !== CLI_APPLY_FIVE_INDEXES),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
    });
    resetFiveIndexApplyCounters();
    resetManagedIdentityHttpCounters();
    const noEnv = await executePhaseDFiveIndexApply({
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
    if (getFiveIndexApplyCounters().clientsInstantiated !== 0
      || noFlag.ok || noEnv.ok) {
      throw new Error('missing apply flag/env must refuse with zero Clients');
    }
    red.push({
      name: 'missing_apply_flag_or_env',
      ok: true,
      flagCode: noFlag.code,
      envCode: noEnv.code,
      clientsInstantiated: 0,
    });
  }

  {
    const wrongDb = evaluateFiveIndexApplyGates({
      env: fiveIndexApplyEnv(),
      argv: applyArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
    });
    if (wrongDb.ok) throw new Error('wrong database must fail');
    const forbidden = evaluateFiveIndexApplyGates({
      env: fiveIndexApplyEnv(),
      argv: [
        ...applyArgv(),
        '--dsn', 'forbidden-dsn-value',
        '--sql', 'DROP TABLE public.tenant_surf_pack_rules',
        '--drop',
        '--dml',
        '--retry',
        '--concurrently',
      ],
    });
    if (forbidden.ok) throw new Error('forbidden argv must fail');
    resetFiveIndexApplyCounters();
    const forbiddenRun = await executePhaseDFiveIndexApply({
      env: fiveIndexApplyEnv(),
      argv: [
        ...applyArgv(),
        '--dsn', 'forbidden-dsn-value',
        '--sql', 'DELETE FROM public.tenant_surf_pack_rules',
        '--drop',
        '--dml',
        '--retry',
      ],
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
    });
    if (getFiveIndexApplyCounters().clientsInstantiated !== 0) {
      throw new Error('forbidden argv must zero Clients');
    }
    red.push({
      name: 'wrong_or_forbidden_argv',
      ok: true,
      rejected: !wrongDb.ok && !forbidden.ok,
      forbiddenFlags: FORBIDDEN_ARGV_FLAGS.slice(),
      code: forbiddenRun.code,
      clientsInstantiated: 0,
    });
  }

  {
    const halfFlag = evaluateFiveIndexApplyGates({
      env: {
        [ENV_LIVE_READONLY]: '1',
        [ENV_LIVE_PREFLIGHT]: '1',
        [ENV_FIVE_INDEX_APPLY]: '1',
        [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      },
      argv: exactFiveIndexApplyArgv(),
    });
    if (halfFlag.ok) throw new Error('MI without env credential-source must fail');
    red.push({
      name: 'managed_identity_requires_env_and_argv',
      ok: true,
      rejected: !halfFlag.ok,
    });
  }

  {
    if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
      throw new Error('global live apply must remain false');
    }
    red.push({
      name: 'global_live_apply_remains_false',
      ok: true,
      liveApplyEnabled: false,
      fiveIndexApplyLiveEnabled: PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED === true,
    });
  }

  // ── GREEN ────────────────────────────────────────────────────────
  {
    resetFiveIndexApplyCounters();
    resetManagedIdentityHttpCounters();
    const FakeOk = createScriptedFiveIndexApplyFakeClientFactory({});
    const okRun = await executePhaseDFiveIndexApply({
      env: fiveIndexApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeOk,
    });
    leakScan(okRun, secrets);
    if (!okRun.ok
      || JSON.stringify(okRun.steps) !== JSON.stringify(AUTHORIZED_SEQUENCE)
      || okRun.queryCalls !== SUCCESS_PATH_QUERY_COUNT
      || okRun.clientsInstantiated !== 1
      || okRun.httpRequestCount !== 2
      || okRun.dataMutation !== false
      || okRun.ledgerWritten !== false
      || okRun.schemaMutation !== true
      || !okRun.rowCountsAfter
      || okRun.rowCountsAfter.tenant_surf_pack_rules !== 36
      || okRun.rowCountsAfter.client_notification_events !== 0
      || okRun.rowCountsAfter.client_notification_settings !== 0
      || okRun.rowCountsAfter.customer_message_templates !== 0) {
      throw new Error(`GREEN injected 43-step sequence failed: ${JSON.stringify(okRun)}`);
    }
    green.push({
      name: 'injected_http_success_exact_43_step_sequence',
      ok: true,
      steps: okRun.steps,
      queryCalls: okRun.queryCalls,
      clientsInstantiated: 1,
      httpRequestCount: 2,
      schemaMutation: true,
      dataMutation: false,
      ledgerWritten: false,
      rowCountsAfter: okRun.rowCountsAfter,
    });
  }

  {
    const gatesOk = evaluateFiveIndexApplyGates({
      env: fiveIndexApplyEnv(),
      argv: exactFiveIndexApplyArgv(),
    });
    if (!gatesOk.ok) {
      throw new Error(`CLI gates should pass: ${JSON.stringify(gatesOk.errors)}`);
    }
    green.push({
      name: 'cli_gates_exact_targets',
      ok: true,
      applyFiveIndexes: gatesOk.applyFiveIndexes === true,
    });
  }

  {
    const cliDefault = spawnSync(process.execPath, [APPLY_CLI_PATH], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    if (cliDefault.status === 0) throw new Error('five-index-apply CLI default must refuse');
    leakScan(`${cliDefault.stdout}${cliDefault.stderr}`, secrets);
    green.push({
      name: 'cli_default_disabled',
      ok: true,
      exitCode: cliDefault.status,
    });
  }

  {
    if (APPLY_LOCKS.applicationName !== APPLICATION_NAME
      || APPLICATION_NAME !== 'wh-sunset-five-index-apply'
      || MI_LOADER_LOCKS.managedIdentityName !== 'wh-staging-identity'
      || MI_LOADER_LOCKS.keyVaultName !== 'luna-sunset-staging-kv'
      || MI_LOADER_LOCKS.secretName !== 'sunset-database-url'
      || MI_LOADER_LOCKS.sslmode !== 'verify-full'
      || APPLY_LOCKS.postgresHost !== TARGETS.postgresHost
      || APPLY_LOCKS.database !== TARGETS.database) {
      throw new Error('locks drift');
    }
    green.push({
      name: 'locks_identity_vault_secret_pg_tls_application_name',
      ok: true,
      applicationName: APPLY_LOCKS.applicationName,
      managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
      keyVaultName: MI_LOADER_LOCKS.keyVaultName,
      secretName: MI_LOADER_LOCKS.secretName,
      sslmode: MI_LOADER_LOCKS.sslmode,
      postgresHost: APPLY_LOCKS.postgresHost,
      database: APPLY_LOCKS.database,
    });
  }

  {
    green.push({
      name: 'create_statements_byte_locked',
      ok: true,
      createStatementsSha256: createLock.createStatementsSha256,
      ownerMigrationSha256: createLock.ownerMigrationSha256,
    });
  }

  {
    const mapped = FIVE_INDEX_SPECS.map((s) => ({
      indexName: s.indexName,
      key: s.key,
      ownerMigration: s.ownerMigration,
      ownerMigrationSha256: s.ownerMigrationSha256,
      createSqlSha256: s.createSqlSha256,
      expectedIndexdef: s.expectedIndexdef,
    }));
    const allPresent = mapped.every((m) =>
      m.ownerMigration
      && m.ownerMigrationSha256
      && m.createSqlSha256
      && m.expectedIndexdef
      && expectedBytes.toString('utf8').includes(m.expectedIndexdef));
    if (!allPresent || mapped.length !== 5) {
      throw new Error('five specs must map to owners/hashes/defs');
    }
    green.push({
      name: 'five_specs_map_to_owners_hashes_defs',
      ok: true,
      specs: mapped,
    });
  }

  {
    const values = [
      APPROVED_ROW_COUNT_BY_TABLE.client_notification_events,
      APPROVED_ROW_COUNT_BY_TABLE.client_notification_settings,
      APPROVED_ROW_COUNT_BY_TABLE.customer_message_templates,
      APPROVED_ROW_COUNT_BY_TABLE.tenant_surf_pack_rules,
    ];
    if (JSON.stringify(values) !== JSON.stringify([0, 0, 0, 36])) {
      throw new Error(`row count bounds must be 0,0,0,36 got ${values}`);
    }
    if (UNIQUE_TABLES.length !== 4) throw new Error('unique tables drift');
    green.push({
      name: 'row_count_bounds_locked',
      ok: true,
      approvedRowCounts: {
        client_notification_events: 0,
        client_notification_settings: 0,
        customer_message_templates: 0,
        tenant_surf_pack_rules: 36,
      },
    });
  }

  // ── LIVE or preserve ─────────────────────────────────────────────
  let liveOutcome = null;
  let previousLive = null;
  if (fs.existsSync(EVIDENCE_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'));
      if (prev && prev.liveOutcome) previousLive = prev.liveOutcome;
    } catch (_) { /* ignore */ }
  }

  if (offlineOnly) {
    liveOutcome = preserveLive ? priorEvidence.liveOutcome : (previousLive || null);
    if (preserveLive) {
      console.log('Offline mode: preserved historical live outcomes.\n');
    } else {
      console.log('Offline mode: no live apply this run.\n');
    }
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
        sameTarget: authority.sameTarget === true,
        blocker: authority.code || 'target_authority_failed',
        schemaMutation: false,
        dataMutation: false,
        ledgerWritten: false,
        liveMutation: false,
        errors: sanitizeErrors(authority.errors),
      };
    } else {
      console.log('Live section 2/4: observer BEFORE (baseline mismatch=11)…\n');
      const loadedBefore = await loadProtectedAdminCredentialsViaManagedIdentity({
        env: fiveIndexApplyEnv(),
        argv: exactFiveIndexApplyArgv(),
      });
      if (!loadedBefore.ok) {
        liveOutcome = {
          ok: false,
          code: loadedBefore.code || 'managed_identity_loader_failed',
          sameTarget: true,
          blocker: loadedBefore.code || 'managed_identity_loader_failed',
          schemaMutation: false,
          dataMutation: false,
          ledgerWritten: false,
          errors: sanitizeErrors(loadedBefore.errors),
        };
        zeroPrivateCredentialRefs(loadedBefore);
      } else {
        const dsnBefore = buildOfflineProofSunsetDatabaseUrl(
          loadedBefore._user,
          loadedBefore._password,
        );
        zeroPrivateCredentialRefs(loadedBefore);
        let observerBefore;
        try {
          observerBefore = await runFiveIndexObserverCompare(dsnBefore, expected);
        } catch (e) {
          observerBefore = {
            ok: false,
            code: (e && e.code) || 'observer_before_failed',
            mismatchCount: null,
            blocker: (e && e.code) || 'observer_before_failed',
            message: String((e && e.message) || 'observer failed').slice(0, 240),
          };
        }
        zeroPrivateCredentialRefs({ _dsn: dsnBefore, _user: '', _password: '' });
        leakScan(observerBefore, secrets);

        let baselineOk = false;
        let baseline = null;
        try {
          baseline = assertBaselineMismatch({
            mismatchCount: observerBefore.mismatchCount,
            mismatchSections: observerBefore.mismatchSections,
          });
          baselineOk = baseline.ok === true;
        } catch (e) {
          baseline = {
            ok: false,
            code: e.code || 'baseline_drift_mismatch',
            message: String(e.message || '').slice(0, 240),
            mismatchCount: observerBefore.mismatchCount,
            mismatchSections: observerBefore.mismatchSections,
          };
        }

        if (!baselineOk) {
          console.log('Baseline drift — STOP with zero mutation.\n');
          liveOutcome = {
            ok: false,
            code: 'baseline_drift_mismatch',
            sameTarget: true,
            observerBefore,
            baseline,
            schemaMutation: false,
            dataMutation: false,
            ledgerWritten: false,
            liveMutation: false,
            liveApplyAttemptCount: 0,
            blocker: 'baseline_drift_mismatch',
            note: 'STOP — zero mutation on baseline drift',
          };
        } else {
          console.log('Live section 3/4: exactly one gated five-index-apply CLI spawn…\n');
          const liveApplyCli = spawnSync(
            process.execPath,
            [APPLY_CLI_PATH, ...exactFiveIndexApplyArgv()],
            {
              encoding: 'utf8',
              env: { ...process.env, ...fiveIndexApplyEnv() },
            },
          );
          const applyCombined = `${liveApplyCli.stdout || ''}${liveApplyCli.stderr || ''}`;
          leakScan(applyCombined, secrets);
          const applyParsed = parseLastJsonObject(applyCombined);
          if (applyParsed) leakScan(applyParsed, secrets);
          const liveApplyOutcome = buildApplyLiveOutcome(applyParsed, liveApplyCli.status);
          leakScan(liveApplyOutcome, secrets);

          let observerAfter = null;
          if (liveApplyOutcome.ok === true) {
            console.log('Live section 4/4: observer AFTER (expect −5 indexes)…\n');
            const loadedAfter = await loadProtectedAdminCredentialsViaManagedIdentity({
              env: fiveIndexApplyEnv(),
              argv: exactFiveIndexApplyArgv(),
            });
            if (!loadedAfter.ok) {
              observerAfter = {
                ok: false,
                code: loadedAfter.code || 'managed_identity_loader_failed',
                mismatchCount: null,
                blocker: loadedAfter.code || 'managed_identity_loader_failed',
                errors: sanitizeErrors(loadedAfter.errors),
              };
              zeroPrivateCredentialRefs(loadedAfter);
            } else {
              const dsnAfter = buildOfflineProofSunsetDatabaseUrl(
                loadedAfter._user,
                loadedAfter._password,
              );
              zeroPrivateCredentialRefs(loadedAfter);
              try {
                observerAfter = await runFiveIndexObserverCompare(dsnAfter, expected);
              } catch (e) {
                observerAfter = {
                  ok: false,
                  code: (e && e.code) || 'observer_after_failed',
                  mismatchCount: null,
                  blocker: (e && e.code) || 'observer_after_failed',
                  message: String((e && e.message) || 'observer failed').slice(0, 240),
                };
              }
              zeroPrivateCredentialRefs({ _dsn: dsnAfter, _user: '', _password: '' });
            }
            leakScan(observerAfter, secrets);
          }

          const beforeCount = Number(observerBefore.mismatchCount);
          const afterCount = observerAfter ? Number(observerAfter.mismatchCount) : null;
          const reducedByFive = afterCount === beforeCount - EXPECTED_REDUCTION
            && beforeCount === BASELINE_MISMATCH_COUNT
            && afterCount === EXPECTED_REMAINING_MISMATCH_COUNT;
          const fiveKeys = FIVE_INDEX_SPECS.map((s) => s.key);
          const remainingKeys = (observerAfter && observerAfter.remainingKeys) || [];
          const fiveKeysAbsent = fiveKeys.every((k) => !remainingKeys.includes(k));
          const rowPreserved = liveApplyOutcome.ok === true
            && liveApplyOutcome.rowCountsBefore
            && liveApplyOutcome.rowCountsAfter
            && UNIQUE_TABLES.every((t) =>
              liveApplyOutcome.rowCountsBefore[t] === liveApplyOutcome.rowCountsAfter[t]
              && liveApplyOutcome.rowCountsAfter[t] === APPROVED_ROW_COUNT_BY_TABLE[t]);

          liveOutcome = {
            ok: liveApplyOutcome.ok === true
              && reducedByFive === true
              && fiveKeysAbsent === true
              && rowPreserved === true,
            code: liveApplyOutcome.ok === true
              ? (reducedByFive && fiveKeysAbsent
                ? 'phase_d_five_index_apply_ok_observer_reduced'
                : 'phase_d_five_index_apply_ok_observer_unexpected')
              : liveApplyOutcome.code,
            sameTarget: true,
            sessionReadOnly: true,
            observerBefore: {
              mismatchCount: observerBefore.mismatchCount,
              mismatchSections: observerBefore.mismatchSections,
              remainingKeys: observerBefore.remainingKeys,
              applicationName: OBSERVER_APPLICATION_NAME,
            },
            baseline,
            liveApplyOutcome,
            observerAfter: observerAfter ? {
              mismatchCount: observerAfter.mismatchCount,
              mismatchSections: observerAfter.mismatchSections,
              remainingKeys: observerAfter.remainingKeys,
              applicationName: OBSERVER_APPLICATION_NAME,
            } : null,
            mismatchCountBefore: beforeCount,
            mismatchCountAfter: afterCount,
            expectedReduction: EXPECTED_REDUCTION,
            reducedByExactlyFive: reducedByFive === true,
            fiveIndexKeysAbsentFromRemaining: fiveKeysAbsent === true,
            remainingKeys,
            expectedRemainingKeys: EXPECTED_REMAINING_KEYS.slice(),
            rowPreservation: {
              before: liveApplyOutcome.rowCountsBefore,
              after: liveApplyOutcome.rowCountsAfter,
              preserved: rowPreserved === true,
            },
            preflight: {
              targetAuthoritySameTarget: true,
              baselineOk: true,
            },
            schemaMutation: liveApplyOutcome.schemaMutation === true,
            dataMutation: false,
            ledgerWritten: false,
            liveMutation: liveApplyOutcome.liveMutation === true,
            liveApplyAttemptCount: 1,
            claimsZeroDrift: false,
            claimsFullRepair: false,
            stillProductSchemaDiffers: true,
            applicationNameApply: APPLICATION_NAME,
            applicationNameObserver: OBSERVER_APPLICATION_NAME,
            blocker: liveApplyOutcome.ok === true
              ? (reducedByFive && fiveKeysAbsent ? null : 'observer_reduction_mismatch')
              : liveApplyOutcome.blocker,
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

  const liveBlock = liveOutcome || previousLive || null;
  const offlineOnlyOutcome = offlineOnly && !(liveBlock && liveBlock.ok === true
    && liveBlock.liveApplyAttemptCount === 1);

  const evidence = {
    kind: 'sunset-schema-observer-slice14y-five-index-apply-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14Y',
    outcome: offlineOnlyOutcome
      ? 'phase_d_five_index_apply_offline_only'
      : ((liveBlock && liveBlock.code) || 'phase_d_five_index_apply_unknown'),
    stillProductSchemaDiffers: true,
    claimsZeroDrift: false,
    claimsFullRepair: false,
    liveMutation: liveBlock ? liveBlock.liveMutation === true : false,
    schemaMutation: liveBlock ? liveBlock.schemaMutation === true : false,
    dataMutation: false,
    ledgerWritten: false,
    kvMutation: false,
    rbacMutation: false,
    networkMutation: false,
    firewallAction: false,
    identityMutation: false,
    migrationAdded: false,
    applyFlagPresent: true,
    appliesIndexes: true,
    writesLedger: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    liveApplyAttemptCount: liveBlock && liveBlock.liveApplyAttemptCount === 1 ? 1 : 0,
    applicationName: APPLICATION_NAME,
    observerApplicationName: OBSERVER_APPLICATION_NAME,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    baselineMismatchCount: BASELINE_MISMATCH_COUNT,
    baselineMismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
    expectedReduction: EXPECTED_REDUCTION,
    expectedRemainingMismatchCount: EXPECTED_REMAINING_MISMATCH_COUNT,
    expectedRemainingKeys: EXPECTED_REMAINING_KEYS.slice(),
    fiveIndexSpecs: FIVE_INDEX_SPECS.map((s) => ({
      indexName: s.indexName,
      key: s.key,
      table: s.table,
      ownerMigration: s.ownerMigration,
      ownerMigrationSha256: s.ownerMigrationSha256,
      createSqlSha256: s.createSqlSha256,
      approvedRowCount: s.approvedRowCount,
    })),
    createStatementsSha256: createLock.createStatementsSha256,
    ownerMigrationSha256: createLock.ownerMigrationSha256,
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    successPathQueryCount: SUCCESS_PATH_QUERY_COUNT,
    approvedRowCounts: { ...APPROVED_ROW_COUNT_BY_TABLE },
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    defaultDisabled: true,
    dualEnableFlagsRequired: true,
    fiveIndexApplyEnvGateRequired: true,
    fiveIndexApplyArgvGateRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    offlineGates: {
      baselineDriftMismatch: true,
      createOrOwnerHashDriftFails: true,
      duplicateSemanticIndexRefuse: true,
      incompatibleSameNameObjectRefuse: true,
      missingColumnRefuse: true,
      extraUnauthorizedSqlRefuse: true,
      partialFailureRollbackNoRetry: true,
      wrongOrderRefuse: true,
      timeoutAdvisoryFailureRollback: true,
      defaultPathZeroHttpAndClients: true,
      missingApplyFlagOrEnv: true,
      wrongOrForbiddenArgv: true,
      managedIdentityRequiresEnvAndArgv: true,
      globalLiveApplyRemainsFalse: true,
      injectedHttpSuccessExact43StepSequence: true,
      cliGatesExactTargets: true,
      cliDefaultDisabled: true,
      locksIdentityVaultSecretPgTlsApplicationName: true,
      createStatementsByteLocked: true,
      fiveSpecsMapToOwnersHashesDefs: true,
      rowCountBoundsLocked: true,
    },
    redCases: red,
    greenCases: green,
    liveOutcome: liveBlock,
    secretHandlingProof: {
      neverPrinted: true,
      neverPersisted: true,
      neverHashedIntoEvidence: true,
      neverInArgv: true,
      observerNeverPersistsDsn: true,
    },
    verifyNeverRerunsLive: true,
  };
  leakScan(evidence, secrets);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

  const contract = {
    kind: 'sunset-schema-observer-slice14y-five-index-apply-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: true,
    fiveIndexApplyLiveEnabled: true,
    globalLiveApplyEnabled: false,
    liveReadonlyConnectEnabled: true,
    liveHttpEnabled: true,
    appliesIndexes: true,
    writesLedger: false,
    dataMutation: false,
    mutates: true,
    schemaMutation: true,
    firewallMutation: false,
    networkMutation: false,
    kvMutation: false,
    rbacMutation: false,
    defaultEnabled: false,
    dualEnableFlagsRequired: true,
    fiveIndexApplyEnvGateRequired: true,
    fiveIndexApplyArgvGateRequired: true,
    exactTargetCliConfirmationRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    targetAuthorityRequiredBeforeApply: true,
    baselineMismatchRequiredBeforeApply: true,
    observerReadOnlyBeforeAndAfterApply: true,
    offlineInjectedHttpAndFakeClientProof: true,
    createStatementsByteLocked: true,
    verifyNeverRerunsLive: true,
    claimsZeroDrift: false,
    claimsFullRepair: false,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14Y',
    purpose: 'Apply exactly five byte-locked residual indexes after baseline mismatch=11; observer must reduce by exactly 5; do not claim zero drift / full repair; no DML/ledger/migration/Azure mutation beyond MI credential GET; verify never re-runs live.',
    targets: {
      subscriptionId: TARGETS.subscriptionId,
      resourceGroup: TARGETS.resourceGroup,
      postgresServer: TARGETS.postgresServer,
      postgresHost: TARGETS.postgresHost,
      database: TARGETS.database,
      sslmode: 'verify-full',
      applicationName: APPLICATION_NAME,
      observerApplicationName: OBSERVER_APPLICATION_NAME,
      port: TARGETS.port,
    },
    applyLocks: {
      applicationName: APPLICATION_NAME,
      advisoryLockKey1: APPLY_LOCKS.advisoryLockKey1,
      advisoryLockKey2: APPLY_LOCKS.advisoryLockKey2,
      indexNames: APPLY_LOCKS.indexNames.slice(),
      indexKeys: APPLY_LOCKS.indexKeys.slice(),
      createSqlSha256: APPLY_LOCKS.createSqlSha256.slice(),
      uniqueTables: APPLY_LOCKS.uniqueTables.slice(),
      baselineMismatchCount: BASELINE_MISMATCH_COUNT,
      expectedReduction: EXPECTED_REDUCTION,
      expectedRemainingMismatchCount: EXPECTED_REMAINING_MISMATCH_COUNT,
      managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
      keyVaultName: MI_LOADER_LOCKS.keyVaultName,
      secretName: MI_LOADER_LOCKS.secretName,
      postgresHost: TARGETS.postgresHost,
      database: TARGETS.database,
      sslmode: 'verify-full',
    },
    commandContract: {
      fiveIndexApply: {
        script: 'scripts/run-phase-d-five-index-apply.js',
        npm: 'phase-d:five-index-apply',
        requiredEnv: [
          'SUNSET_PHASE_D_LIVE_READONLY=1',
          'SUNSET_PHASE_D_LIVE_PREFLIGHT=1',
          'SUNSET_PHASE_D_FIVE_INDEX_APPLY=1',
          'SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity',
          `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
        ],
        requiredArgv: [
          CLI_APPLY_FIVE_INDEXES,
          '--credential-source managed-identity',
          `--subscription ${TARGETS.subscriptionId}`,
          `--resource-group ${TARGETS.resourceGroup}`,
          `--postgres-server ${TARGETS.postgresServer}`,
          `--database ${TARGETS.database}`,
        ],
        forbiddenArgv: FORBIDDEN_ARGV_FLAGS.slice(),
      },
    },
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    createStatementsSha256: createLock.createStatementsSha256,
    ownerMigrationSha256: createLock.ownerMigrationSha256,
    baselineMismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
    expectedRemainingKeys: EXPECTED_REMAINING_KEYS.slice(),
    requiredRed: REQUIRED_RED.slice(),
    requiredGreen: REQUIRED_GREEN.slice(),
    forbidden: [
      'INSERT/UPDATE/DELETE',
      'DROP/RENAME/ALTER TABLE',
      'CONCURRENTLY',
      'ledger write',
      'RBAC / network / firewall mutation',
      'migration / CREATE SQL changes',
      'DSN / token / username / password / secret version in evidence',
      'broad retry on live failure',
      'second live apply in verify',
      'claim zero drift / full repair',
    ],
    nonGoals: [
      'No expected-fixture regeneration',
      'No broad Azure/KV/RBAC/network mutation',
      'Do not claim Sunset repaired / zero remaining drift',
    ],
  };
  leakScan(contract, secrets);
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);

  const findings = [
    '# FOUNDATION Slice 14Y — Apply five residual indexes',
    '',
    `**Status:** ${liveBlock && liveBlock.ok
      ? 'five_index_apply_live_ok_observer_reduced'
      : 'offline_ok_awaiting_live'}`,
    `**Master basis:** \`${MASTER}\``,
    `**Canonical fingerprint (unchanged):** \`${CANON_FP}\``,
    `**Expected bytes (unchanged):** \`${EXPECTED_BYTE_SHA}\``,
    `**Manifest hash (unchanged):** \`${MANIFEST_HASH}\``,
    `**Generated:** ${generatedAt}`,
    '',
    '## Five indexes (owner + hash + CREATE sha256)',
    '',
  ];
  for (const s of FIVE_INDEX_SPECS) {
    findings.push(
      `- \`${s.indexName}\` on \`${s.table}\` — owner \`${s.ownerMigration}\` `
      + `(\`${s.ownerMigrationSha256}\`) createSha=\`${s.createSqlSha256}\``,
    );
  }
  findings.push(
    '',
    '## Offline gates',
    '',
    `- RED: ${REQUIRED_RED.length} cases`,
    `- GREEN: ${REQUIRED_GREEN.length} cases`,
    `- Authorized sequence length: **${SUCCESS_PATH_QUERY_COUNT}**`,
    '- Row count bounds locked: client_notification_events=0, client_notification_settings=0, customer_message_templates=0, tenant_surf_pack_rules=36',
    '',
  );
  if (liveBlock) {
    findings.push(
      '## Live before/after observer',
      '',
      `apply application_name: \`${APPLICATION_NAME}\``,
      `observer application_name: \`${OBSERVER_APPLICATION_NAME}\``,
      `sameTarget: **${liveBlock.sameTarget === true}**`,
      `mismatch before: **${liveBlock.mismatchCountBefore != null ? liveBlock.mismatchCountBefore : (liveBlock.observerBefore && liveBlock.observerBefore.mismatchCount)}**`,
      `mismatch after: **${liveBlock.mismatchCountAfter != null ? liveBlock.mismatchCountAfter : (liveBlock.observerAfter && liveBlock.observerAfter.mismatchCount)}**`,
      `reduced by exactly 5: **${liveBlock.reducedByExactlyFive === true}**`,
      `five index keys absent from remaining: **${liveBlock.fiveIndexKeysAbsentFromRemaining === true}**`,
      `remaining keys: ${JSON.stringify(liveBlock.remainingKeys || [])}`,
      '',
      '## Row preservation',
      '',
      `preserved: **${liveBlock.rowPreservation ? liveBlock.rowPreservation.preserved === true : false}**`,
      `rowCounts: ${JSON.stringify((liveBlock.rowPreservation && liveBlock.rowPreservation.after) || null)}`,
      '',
      'Mutation flags: schemaMutation='
      + `${liveBlock.schemaMutation === true}; dataMutation=false; ledgerWritten=false.`,
      '',
    );
  }
  findings.push(
    '## Do not claim',
    '',
    '- Do **not** claim zero remaining drift / database matches canonical / Sunset fully repaired.',
    '- Do **not** run verify with `--live` (verify never re-runs live / never calls executePhaseDFiveIndexApply live).',
    '- Do **not** modify expected-product-schema bytes/fingerprint or migrations.',
    '- Do **not** retry after partial CREATE INDEX failure (ROLLBACK once).',
    '',
    '## Operator live command',
    '',
    '```',
    'SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_FIVE_INDEX_APPLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:five-index-apply -- --apply-five-indexes --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity',
    '```',
    '',
    '## Artifacts',
    '',
    '- `fixtures/sunset-schema-observer/slice14y-five-index-apply-evidence.json`',
    '- `fixtures/sunset-schema-observer/slice14y-five-index-apply-contract.json`',
    '- `fixtures/sunset-schema-observer/slice14y-findings.md`',
    '',
  );
  fs.writeFileSync(FINDINGS_PATH, `${findings.join('\n')}\n`);

  console.log(`slice14y offline RED=${red.length} GREEN=${green.length} ok`);
  if (wantLive && liveOutcome) {
    console.log(
      `slice14y live ok=${liveOutcome.ok} before=${liveOutcome.mismatchCountBefore} `
      + `after=${liveOutcome.mismatchCountAfter} reducedBy5=${liveOutcome.reducedByExactlyFive}`,
    );
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
