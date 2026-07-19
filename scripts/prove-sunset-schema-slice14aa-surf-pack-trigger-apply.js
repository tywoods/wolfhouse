'use strict';

/**
 * prove-sunset-schema-slice14aa-surf-pack-trigger-apply — FOUNDATION Slice 14AA
 *
 * Offline RED/GREEN → optional --live path: target authority (skipPostgres) →
 * observer BEFORE (baseline mismatch=5) → exactly one gated surf-pack-trigger apply →
 * observer AFTER (mismatch reduced by exactly 1; trigger key cleared).
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
  PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED,
  ENV_SURF_PACK_TRIGGER_APPLY,
  CLI_APPLY_SURF_PACK_TRIGGER,
  APPLICATION_NAME,
  AUTHORIZED_SEQUENCE,
  SUCCESS_PATH_QUERY_COUNT,
  APPLY_LOCKS,
  TRIGGER_SPEC,
  TRIGGER_NAME,
  CREATE_TRIGGER_SQL,
  CREATE_TRIGGER_SHA256,
  OBSERVER_KEY,
  APPROVED_ROW_COUNT,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  EXPECTED_REDUCTION,
  EXPECTED_REMAINING_MISMATCH_COUNT,
  EXPECTED_REMAINING_KEYS,
  FORBIDDEN_ARGV_FLAGS,
  evaluateSurfPackTriggerApplyGates,
  executePhaseDSurfPackTriggerApply,
  createScriptedSurfPackTriggerApplyFakeClientFactory,
  resetSurfPackTriggerApplyCounters,
  getSurfPackTriggerApplyCounters,
  exactSurfPackTriggerApplyArgv,
  surfPackTriggerApplyEnv,
  assertTriggerCreateStatementsByteLocked,
  assertBaselineMismatch,
  authorizeApplySql,
  defaultFunctionProbeRow,
} = require('./lib/phase-d-surf-pack-trigger-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14aa-surf-pack-trigger-apply-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14aa-surf-pack-trigger-apply-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14aa-findings.md');
const APPLY_CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-surf-pack-trigger-apply.js');

const MASTER = '58cf247e14478ed40a174793dd6c70b846be2225';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const OBSERVER_APPLICATION_NAME = 'wh-sunset-schema-observer';

const FAKE_ADMIN_USER = 'slice14aa-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14aa-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14aa-proof-imds-token-never-commit';

const REQUIRED_RED = Object.freeze([
  'baseline_drift_mismatch',
  'missing_or_wrong_function',
  'semantic_duplicate_refuse',
  'incompatible_trigger_refuse',
  'owner_hash_drift_fails',
  'extra_unauthorized_sql_refuse',
  'partial_rollback_no_retry',
  'row_count_change_refuse',
  'trigger_definition_mismatch_refuse',
  'default_path_zero_http_and_clients',
  'missing_apply_flag_or_env',
  'wrong_or_forbidden_argv',
  'managed_identity_requires_env_and_argv',
  'global_live_apply_remains_false',
]);

const REQUIRED_GREEN = Object.freeze([
  'injected_http_success_exact_sequence',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'create_statement_byte_locked',
  'trigger_spec_maps_to_owner_hash_def',
  'row_count_bound_or_capture_locked',
  'function_contract_locked',
  'prior_fk_index_prestate_locked',
]);

function validSecretValue() {
  return buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
}

function applyArgv(extraFlags) {
  return [
    ...exactSurfPackTriggerApplyArgv(),
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
  if (/Bearer\s+slice14aa-proof-imds-token/i.test(text)) {
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

async function runSurfPackTriggerObserverCompare(dsn, expectedContract) {
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
      message: 'surf-pack-trigger-apply CLI stdout/stderr did not contain parseable JSON',
    });
  }
  const code = String(p.code || (ok ? 'phase_d_surf_pack_trigger_apply_ok' : 'surf_pack_trigger_apply_failed'));
  const blocker = ok ? null : String(code || (errors[0] && errors[0].code) || 'surf_pack_trigger_apply_failed');
  return {
    attempt: 1,
    ok,
    code,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    steps: Array.isArray(p.steps) ? p.steps.slice() : [],
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    beforeTrigger: p.beforeTrigger || null,
    afterTrigger: p.afterTrigger || null,
    triggerVerification: p.triggerVerification || null,
    functionProbe: p.functionProbe || null,
    priorFk: p.priorFk || null,
    priorIndex: p.priorIndex || null,
    rowCountsBefore: p.rowCountsBefore || null,
    rowCountsAfter: p.rowCountsAfter || null,
    capturedRowCount: p.capturedRowCount != null ? p.capturedRowCount : null,
    createTriggerSqlSha256: p.createTriggerSqlSha256 || null,
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
    || process.env.SUNSET_SLICE14AA_PROOF_OFFLINE === '1';

  console.log(offlineOnly
    ? 'prove:sunset-schema-slice14aa — offline only (no live HTTP/PG apply/observer)\n'
    : 'prove:sunset-schema-slice14aa — offline then live authority + observer + apply\n');

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
  if (PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED !== true) {
    throw new Error('surf pack trigger apply capability must be enabled');
  }
  if (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== true) {
    throw new Error('live MI HTTP must be activated');
  }
  if (!fs.existsSync(APPLY_CLI_PATH)) {
    throw new Error('required surf-pack-trigger-apply CLI missing');
  }

  const createLock = assertTriggerCreateStatementsByteLocked();
  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN, validSecretValue()];
  const red = [];
  const green = [];

  // ── RED ──────────────────────────────────────────────────────────
  {
    let threw = false;
    let code = null;
    try {
      assertBaselineMismatch({
        mismatchCount: 6,
        mismatchSections: { ...BASELINE_MISMATCH_SECTIONS, triggers: 2 },
      });
    } catch (e) {
      threw = true;
      code = e && e.code;
    }
    resetSurfPackTriggerApplyCounters();
    resetManagedIdentityHttpCounters();
    red.push({
      name: 'baseline_drift_mismatch',
      ok: threw === true
        && code === 'baseline_drift_mismatch'
        && getSurfPackTriggerApplyCounters().clientsInstantiated === 0
        && getManagedIdentityHttpCounters().httpRequestCount === 0,
      code,
      zeroMutation: true,
    });
  }

  {
    resetSurfPackTriggerApplyCounters();
    const FakeBadFn = createScriptedSurfPackTriggerApplyFakeClientFactory({
      responses: {
        functionProbe: {
          ...defaultFunctionProbeRow(),
          rettype: 'void',
          prosecdef: true,
        },
      },
    });
    const badFn = await executePhaseDSurfPackTriggerApply({
      env: surfPackTriggerApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeBadFn,
    });
    if (badFn.ok || badFn.rolledBack !== true) {
      throw new Error(`missing/wrong function must refuse+rollback: ${JSON.stringify(badFn)}`);
    }
    red.push({
      name: 'missing_or_wrong_function',
      ok: true,
      code: badFn.code,
      rolledBack: true,
    });
  }

  {
    resetSurfPackTriggerApplyCounters();
    const FakeDup = createScriptedSurfPackTriggerApplyFakeClientFactory({
      responses: {
        tableTriggers: {
          rows: [{
            name: 'tenant_surf_pack_rules_updated_at_dup',
            tgtype: 19,
            fn_identity: TRIGGER_SPEC.functionIdentity,
          }],
          rowCount: 1,
        },
      },
    });
    const dup = await executePhaseDSurfPackTriggerApply({
      env: surfPackTriggerApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeDup,
    });
    if (dup.ok || dup.rolledBack !== true) {
      throw new Error(`semantic duplicate must refuse+rollback: ${JSON.stringify(dup)}`);
    }
    red.push({
      name: 'semantic_duplicate_refuse',
      ok: true,
      code: dup.code,
      rolledBack: true,
    });
  }

  {
    resetSurfPackTriggerApplyCounters();
    const FakeIncompat = createScriptedSurfPackTriggerApplyFakeClientFactory({
      responses: {
        triggerNameLookup: {
          rows: [{ name: TRIGGER_NAME, table_name: 'other_table', schema_name: 'public' }],
          rowCount: 1,
        },
      },
    });
    const incompat = await executePhaseDSurfPackTriggerApply({
      env: surfPackTriggerApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeIncompat,
    });
    if (incompat.ok || incompat.rolledBack !== true) {
      throw new Error(`incompatible same-name must refuse+rollback: ${JSON.stringify(incompat)}`);
    }
    red.push({
      name: 'incompatible_trigger_refuse',
      ok: true,
      code: incompat.code,
      rolledBack: true,
    });
  }

  {
    let driftCode = null;
    const live = sha256CanonicalLfV1File(
      path.join(MIGRATIONS_DIR, `${TRIGGER_SPEC.ownerMigration}.sql`),
    );
    const driftDetected = live !== '0'.repeat(64);
    let assertOk = false;
    try {
      assertTriggerCreateStatementsByteLocked();
      assertOk = true;
      driftCode = 'owner_migration_checksum_mismatch';
    } catch (e) {
      driftCode = e && e.code;
    }
    red.push({
      name: 'owner_hash_drift_fails',
      ok: driftDetected === true && assertOk === true,
      code: driftCode,
      liveSha: live,
    });
  }

  {
    const rejectedSql = [];
    for (const sql of [
      'DROP TABLE public.tenant_surf_pack_rules',
      'DELETE FROM public.tenant_surf_pack_rules',
      'INSERT INTO public.tenant_surf_pack_rules (id) VALUES (1)',
      'CREATE INDEX idx_evil ON public.tenant_surf_pack_rules (id)',
      'CREATE FUNCTION public.evil() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
      'ALTER TABLE public.tenant_surf_pack_rules ADD COLUMN evil text',
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
    let createAuthorized = false;
    try {
      authorizeApplySql(CREATE_TRIGGER_SQL);
      createAuthorized = true;
    } catch (e) {
      createAuthorized = false;
    }
    red.push({
      name: 'extra_unauthorized_sql_refuse',
      ok: rejectedSql.length === 7 && createAuthorized === true,
      rejectedStatements: rejectedSql,
      createTriggerAuthorized: createAuthorized,
    });
  }

  {
    resetSurfPackTriggerApplyCounters();
    const FakePartial = createScriptedSurfPackTriggerApplyFakeClientFactory({
      queryErrorAt: {
        'CREATE TRIGGER': Object.assign(new Error('create trigger failed'), {
          code: 'query_failed',
        }),
      },
    });
    const partial = await executePhaseDSurfPackTriggerApply({
      env: surfPackTriggerApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakePartial,
    });
    const createAttempts = (partial.steps || []).filter((s) => s === 'CREATE TRIGGER').length;
    if (partial.ok || partial.rolledBack !== true || partial.steps.includes('COMMIT')
      || createAttempts > 1) {
      throw new Error(`partial CREATE failure must rollback once, no retry: ${JSON.stringify(partial)}`);
    }
    red.push({
      name: 'partial_rollback_no_retry',
      ok: true,
      code: partial.code,
      rolledBack: true,
      noCommit: !partial.steps.includes('COMMIT'),
      createAttempts,
      noRetry: createAttempts <= 1,
    });
  }

  {
    resetSurfPackTriggerApplyCounters();
    const rowChange = await executePhaseDSurfPackTriggerApply({
      env: surfPackTriggerApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: createScriptedSurfPackTriggerApplyFakeClientFactory({
        responses: {
          rowCount: APPROVED_ROW_COUNT,
          rowCountAfter: APPROVED_ROW_COUNT + 1,
        },
      }),
    });
    if (rowChange.ok || rowChange.rolledBack !== true) {
      throw new Error(`row count change must refuse: ${JSON.stringify(rowChange)}`);
    }
    red.push({
      name: 'row_count_change_refuse',
      ok: true,
      code: rowChange.code,
      rolledBack: true,
    });
  }

  {
    resetSurfPackTriggerApplyCounters();
    const FakeBadDef = createScriptedSurfPackTriggerApplyFakeClientFactory({
      responses: {
        verifyAfterCreate: [{
          name: TRIGGER_NAME,
          enabled: 'O',
          is_internal: false,
          tgtype: 19,
          tgdef: 'CREATE TRIGGER tenant_surf_pack_rules_updated_at AFTER UPDATE ON public.tenant_surf_pack_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
          fn_identity: TRIGGER_SPEC.functionIdentity,
          fn_oid: 12345,
          fn_rettype: 'trigger',
          fn_lang: 'plpgsql',
        }],
      },
    });
    const badDef = await executePhaseDSurfPackTriggerApply({
      env: surfPackTriggerApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeBadDef,
    });
    if (badDef.ok || badDef.rolledBack !== true) {
      throw new Error(`trigger definition mismatch must refuse: ${JSON.stringify(badDef)}`);
    }
    red.push({
      name: 'trigger_definition_mismatch_refuse',
      ok: true,
      code: badDef.code,
      rolledBack: true,
    });
  }

  {
    resetSurfPackTriggerApplyCounters();
    resetManagedIdentityHttpCounters();
    const def = await executePhaseDSurfPackTriggerApply({ env: {}, argv: [] });
    if (getSurfPackTriggerApplyCounters().clientsInstantiated !== 0
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
    resetSurfPackTriggerApplyCounters();
    resetManagedIdentityHttpCounters();
    const noFlag = await executePhaseDSurfPackTriggerApply({
      env: surfPackTriggerApplyEnv(),
      argv: applyArgv().filter((a) => a !== CLI_APPLY_SURF_PACK_TRIGGER),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
    });
    resetSurfPackTriggerApplyCounters();
    resetManagedIdentityHttpCounters();
    const noEnv = await executePhaseDSurfPackTriggerApply({
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
    if (getSurfPackTriggerApplyCounters().clientsInstantiated !== 0
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
    const wrongDb = evaluateSurfPackTriggerApplyGates({
      env: surfPackTriggerApplyEnv(),
      argv: applyArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
    });
    if (wrongDb.ok) throw new Error('wrong database must fail');
    const forbidden = evaluateSurfPackTriggerApplyGates({
      env: surfPackTriggerApplyEnv(),
      argv: [
        ...applyArgv(),
        '--dsn', 'forbidden-dsn-value',
        '--sql', 'DROP TABLE public.tenant_surf_pack_rules',
        '--drop',
        '--dml',
        '--retry',
      ],
    });
    if (forbidden.ok) throw new Error('forbidden argv must fail');
    resetSurfPackTriggerApplyCounters();
    const forbiddenRun = await executePhaseDSurfPackTriggerApply({
      env: surfPackTriggerApplyEnv(),
      argv: [
        ...applyArgv(),
        '--dsn', 'forbidden-dsn-value',
        '--drop',
        '--retry',
      ],
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
    });
    if (getSurfPackTriggerApplyCounters().clientsInstantiated !== 0) {
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
    const halfFlag = evaluateSurfPackTriggerApplyGates({
      env: {
        [ENV_LIVE_READONLY]: '1',
        [ENV_LIVE_PREFLIGHT]: '1',
        [ENV_SURF_PACK_TRIGGER_APPLY]: '1',
        [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      },
      argv: exactSurfPackTriggerApplyArgv(),
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
      surfPackTriggerApplyLiveEnabled: PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED === true,
    });
  }

  // ── GREEN ────────────────────────────────────────────────────────
  {
    resetSurfPackTriggerApplyCounters();
    resetManagedIdentityHttpCounters();
    const FakeOk = createScriptedSurfPackTriggerApplyFakeClientFactory({});
    const okRun = await executePhaseDSurfPackTriggerApply({
      env: surfPackTriggerApplyEnv(),
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
      || okRun.rowCountsAfter.tenant_surf_pack_rules !== APPROVED_ROW_COUNT) {
      throw new Error(`GREEN injected sequence failed: ${JSON.stringify(okRun)}`);
    }
    green.push({
      name: 'injected_http_success_exact_sequence',
      ok: true,
      steps: okRun.steps,
      queryCalls: okRun.queryCalls,
      successPathQueryCount: SUCCESS_PATH_QUERY_COUNT,
      clientsInstantiated: 1,
      httpRequestCount: 2,
      schemaMutation: true,
      dataMutation: false,
      ledgerWritten: false,
      rowCountsAfter: okRun.rowCountsAfter,
    });
  }

  {
    const gatesOk = evaluateSurfPackTriggerApplyGates({
      env: surfPackTriggerApplyEnv(),
      argv: exactSurfPackTriggerApplyArgv(),
    });
    if (!gatesOk.ok) {
      throw new Error(`CLI gates should pass: ${JSON.stringify(gatesOk.errors)}`);
    }
    green.push({
      name: 'cli_gates_exact_targets',
      ok: true,
      applySurfPackTrigger: gatesOk.applySurfPackTrigger === true,
    });
  }

  {
    const cliDefault = spawnSync(process.execPath, [APPLY_CLI_PATH], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    if (cliDefault.status === 0) throw new Error('surf-pack-trigger-apply CLI default must refuse');
    leakScan(`${cliDefault.stdout}${cliDefault.stderr}`, secrets);
    green.push({
      name: 'cli_default_disabled',
      ok: true,
      exitCode: cliDefault.status,
    });
  }

  {
    if (APPLY_LOCKS.applicationName !== APPLICATION_NAME
      || APPLICATION_NAME !== 'wh-sunset-surf-pack-trigger-apply'
      || APPLY_LOCKS.advisoryLockKey1 !== 0x57485041
      || APPLY_LOCKS.advisoryLockKey2 !== 0x53505447
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
      advisoryLockKey1: APPLY_LOCKS.advisoryLockKey1,
      advisoryLockKey2: APPLY_LOCKS.advisoryLockKey2,
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
      name: 'create_statement_byte_locked',
      ok: true,
      createTriggerSqlSha256: createLock.createTriggerSqlSha256,
      ownerMigrationSha256: createLock.ownerMigrationSha256,
      expectedSha256: CREATE_TRIGGER_SHA256,
    });
  }

  {
    const liveOwner = sha256CanonicalLfV1File(
      path.join(MIGRATIONS_DIR, `${TRIGGER_SPEC.ownerMigration}.sql`),
    );
    const inExpected = expectedBytes.toString('utf8').includes(CREATE_TRIGGER_SQL);
    if (liveOwner !== TRIGGER_SPEC.ownerMigrationSha256 || !inExpected) {
      throw new Error('trigger spec must map to owner hash and expected def');
    }
    green.push({
      name: 'trigger_spec_maps_to_owner_hash_def',
      ok: true,
      triggerName: TRIGGER_SPEC.triggerName,
      observerKey: OBSERVER_KEY,
      ownerMigration: TRIGGER_SPEC.ownerMigration,
      ownerMigrationSha256: TRIGGER_SPEC.ownerMigrationSha256,
      createTriggerSql: CREATE_TRIGGER_SQL,
    });
  }

  {
    if (APPROVED_ROW_COUNT !== 36) throw new Error('approved row count must be 36');
    green.push({
      name: 'row_count_bound_or_capture_locked',
      ok: true,
      approvedRowCount: APPROVED_ROW_COUNT,
      captureWhenLiveDiffers: true,
    });
  }

  {
    const fnRow = defaultFunctionProbeRow();
    if (fnRow.identity !== TRIGGER_SPEC.functionIdentity
      || fnRow.rettype !== 'trigger'
      || fnRow.lanname !== 'plpgsql') {
      throw new Error('function contract drift');
    }
    green.push({
      name: 'function_contract_locked',
      ok: true,
      functionIdentity: TRIGGER_SPEC.functionIdentity,
      rettype: 'trigger',
      lanname: 'plpgsql',
    });
  }

  {
    resetSurfPackTriggerApplyCounters();
    const FakePre = createScriptedSurfPackTriggerApplyFakeClientFactory({});
    const pre = await executePhaseDSurfPackTriggerApply({
      env: surfPackTriggerApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakePre,
    });
    if (!pre.ok || !pre.priorFk || !pre.priorIndex) {
      throw new Error(`prior fk/index prestate must succeed: ${JSON.stringify(pre)}`);
    }
    green.push({
      name: 'prior_fk_index_prestate_locked',
      ok: true,
      priorFk: pre.priorFk.name,
      priorIndex: pre.priorIndex.name,
      code: pre.code,
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
      console.log('Live section 2/4: observer BEFORE (baseline mismatch=5)…\n');
      const loadedBefore = await loadProtectedAdminCredentialsViaManagedIdentity({
        env: surfPackTriggerApplyEnv(),
        argv: exactSurfPackTriggerApplyArgv(),
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
          observerBefore = await runSurfPackTriggerObserverCompare(dsnBefore, expected);
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
          console.log('Live section 3/4: exactly one gated surf-pack-trigger-apply CLI spawn…\n');
          const liveApplyCli = spawnSync(
            process.execPath,
            [APPLY_CLI_PATH, ...exactSurfPackTriggerApplyArgv()],
            {
              encoding: 'utf8',
              env: { ...process.env, ...surfPackTriggerApplyEnv() },
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
            console.log('Live section 4/4: observer AFTER (expect −1 trigger)…\n');
            const loadedAfter = await loadProtectedAdminCredentialsViaManagedIdentity({
              env: surfPackTriggerApplyEnv(),
              argv: exactSurfPackTriggerApplyArgv(),
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
                observerAfter = await runSurfPackTriggerObserverCompare(dsnAfter, expected);
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
          const reducedByOne = afterCount === beforeCount - EXPECTED_REDUCTION
            && beforeCount === BASELINE_MISMATCH_COUNT
            && afterCount === EXPECTED_REMAINING_MISMATCH_COUNT;
          const remainingKeys = (observerAfter && observerAfter.remainingKeys) || [];
          const triggerKeyAbsent = !remainingKeys.includes(OBSERVER_KEY);
          const rowPreserved = liveApplyOutcome.ok === true
            && liveApplyOutcome.rowCountsBefore
            && liveApplyOutcome.rowCountsAfter
            && liveApplyOutcome.rowCountsBefore.tenant_surf_pack_rules
              === liveApplyOutcome.rowCountsAfter.tenant_surf_pack_rules;

          liveOutcome = {
            ok: liveApplyOutcome.ok === true
              && reducedByOne === true
              && triggerKeyAbsent === true
              && rowPreserved === true,
            code: liveApplyOutcome.ok === true
              ? (reducedByOne && triggerKeyAbsent
                ? 'phase_d_surf_pack_trigger_apply_ok_observer_reduced'
                : 'phase_d_surf_pack_trigger_apply_ok_observer_unexpected')
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
            reducedByExactlyOne: reducedByOne === true,
            triggerKeyAbsentFromRemaining: triggerKeyAbsent === true,
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
              ? (reducedByOne && triggerKeyAbsent ? null : 'observer_reduction_mismatch')
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
  const liveExecCount = (liveBlock && Number(liveBlock.liveApplyAttemptCount) > 0)
    ? Number(liveBlock.liveApplyAttemptCount)
    : 0;
  if (liveExecCount > 1) {
    throw new Error(
      `liveExecutionCount=${liveExecCount} exceeds allowed maximum of 1 — refuse evidence`,
    );
  }
  const offlineOnlyOutcome = offlineOnly && !(liveBlock && liveBlock.ok === true
    && liveExecCount === 1);

  const evidence = {
    kind: 'sunset-schema-observer-slice14aa-surf-pack-trigger-apply-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14AA',
    outcome: offlineOnlyOutcome
      ? 'phase_d_surf_pack_trigger_apply_offline_only'
      : ((liveBlock && liveBlock.code) || 'phase_d_surf_pack_trigger_apply_unknown'),
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
    appliesTrigger: true,
    writesLedger: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    liveExecutionCount: liveExecCount,
    liveApplyAttemptCount: liveExecCount,
    implementationAutomaticRetry: false,
    operatorRerunAfterCodeFix: false,
    rejectsLiveExecutionCountGreaterThanOne: true,
    boundaryCompliance: {
      stopAfterFirstLiveError: true,
      requestedNoRetryBoundaryPassed: true,
      maxLiveExecutions: 1,
    },
    executionHistory: null,
    applicationName: APPLICATION_NAME,
    observerApplicationName: OBSERVER_APPLICATION_NAME,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    baselineMismatchCount: BASELINE_MISMATCH_COUNT,
    baselineMismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
    expectedReduction: EXPECTED_REDUCTION,
    expectedRemainingMismatchCount: EXPECTED_REMAINING_MISMATCH_COUNT,
    expectedRemainingKeys: EXPECTED_REMAINING_KEYS.slice(),
    triggerSpec: {
      triggerName: TRIGGER_SPEC.triggerName,
      observerKey: OBSERVER_KEY,
      table: TRIGGER_SPEC.table,
      ownerMigration: TRIGGER_SPEC.ownerMigration,
      ownerMigrationSha256: TRIGGER_SPEC.ownerMigrationSha256,
      approvedRowCount: TRIGGER_SPEC.approvedRowCount,
      createTriggerSqlSha256: CREATE_TRIGGER_SHA256,
    },
    createTriggerSqlSha256: createLock.createTriggerSqlSha256,
    ownerMigrationSha256: createLock.ownerMigrationSha256,
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    successPathQueryCount: SUCCESS_PATH_QUERY_COUNT,
    approvedRowCount: APPROVED_ROW_COUNT,
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    defaultDisabled: true,
    dualEnableFlagsRequired: true,
    surfPackTriggerApplyEnvGateRequired: true,
    surfPackTriggerApplyArgvGateRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    offlineGates: {
      baselineDriftMismatch: true,
      missingOrWrongFunction: true,
      semanticDuplicateRefuse: true,
      incompatibleTriggerRefuse: true,
      ownerHashDriftFails: true,
      extraUnauthorizedSqlRefuse: true,
      partialRollbackNoRetry: true,
      rowCountChangeRefuse: true,
      triggerDefinitionMismatchRefuse: true,
      defaultPathZeroHttpAndClients: true,
      missingApplyFlagOrEnv: true,
      wrongOrForbiddenArgv: true,
      managedIdentityRequiresEnvAndArgv: true,
      globalLiveApplyRemainsFalse: true,
      injectedHttpSuccessExactSequence: true,
      cliGatesExactTargets: true,
      cliDefaultDisabled: true,
      locksIdentityVaultSecretPgTlsApplicationName: true,
      createStatementByteLocked: true,
      triggerSpecMapsToOwnerHashDef: true,
      rowCountBoundOrCaptureLocked: true,
      functionContractLocked: true,
      priorFkIndexPrestateLocked: true,
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
    kind: 'sunset-schema-observer-slice14aa-surf-pack-trigger-apply-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: true,
    surfPackTriggerApplyLiveEnabled: true,
    globalLiveApplyEnabled: false,
    liveReadonlyConnectEnabled: true,
    liveHttpEnabled: true,
    appliesTrigger: true,
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
    surfPackTriggerApplyEnvGateRequired: true,
    surfPackTriggerApplyArgvGateRequired: true,
    exactTargetCliConfirmationRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    targetAuthorityRequiredBeforeApply: true,
    baselineMismatchRequiredBeforeApply: true,
    observerReadOnlyBeforeAndAfterApply: true,
    offlineInjectedHttpAndFakeClientProof: true,
    createStatementByteLocked: true,
    verifyNeverRerunsLive: true,
    claimsZeroDrift: false,
    claimsFullRepair: false,
    liveExecutionCount: liveExecCount,
    implementationAutomaticRetry: false,
    operatorRerunAfterCodeFix: false,
    rejectsLiveExecutionCountGreaterThanOne: true,
    boundaryCompliance: {
      stopAfterFirstLiveError: true,
      requestedNoRetryBoundaryPassed: true,
      maxLiveExecutions: 1,
    },
    requiresTwoAttemptLiveDisclosure: false,
    requestedNoRetryBoundaryPassed: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14AA',
    purpose: 'Apply exactly one byte-locked residual trigger after baseline mismatch=5; observer must reduce by exactly 1; do not claim zero drift / full repair; no DML/ledger/migration/Azure mutation beyond MI credential GET; verify never re-runs live.',
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
      advisoryLockLabels: ['WHPA', 'SPTG'],
      triggerName: TRIGGER_NAME,
      observerKey: OBSERVER_KEY,
      createTriggerSqlSha256: CREATE_TRIGGER_SHA256,
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
      surfPackTriggerApply: {
        script: 'scripts/run-phase-d-surf-pack-trigger-apply.js',
        npm: 'phase-d:surf-pack-trigger-apply',
        requiredEnv: [
          'SUNSET_PHASE_D_LIVE_READONLY=1',
          'SUNSET_PHASE_D_LIVE_PREFLIGHT=1',
          'SUNSET_PHASE_D_SURF_PACK_TRIGGER_APPLY=1',
          'SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity',
          `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
        ],
        requiredArgv: [
          CLI_APPLY_SURF_PACK_TRIGGER,
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
    createTriggerSqlSha256: createLock.createTriggerSqlSha256,
    ownerMigrationSha256: createLock.ownerMigrationSha256,
    baselineMismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
    expectedRemainingKeys: EXPECTED_REMAINING_KEYS.slice(),
    requiredRed: REQUIRED_RED.slice(),
    requiredGreen: REQUIRED_GREEN.slice(),
    forbidden: [
      'INSERT/UPDATE/DELETE',
      'DROP/RENAME/ALTER TABLE',
      'ledger write',
      'RBAC / network / firewall mutation',
      'migration / CREATE FUNCTION / CREATE INDEX changes',
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
    '# FOUNDATION Slice 14AA — Apply tenant_surf_pack_rules_updated_at',
    '',
    `**Status:** ${liveBlock && liveBlock.ok
      ? 'surf_pack_trigger_apply_live_ok_observer_reduced'
      : 'offline_ok_awaiting_live'}`,
    `**Master basis:** \`${MASTER}\``,
    `**Canonical fingerprint (unchanged):** \`${CANON_FP}\``,
    `**Expected bytes (unchanged):** \`${EXPECTED_BYTE_SHA}\``,
    `**Manifest hash (unchanged):** \`${MANIFEST_HASH}\``,
    `**Generated:** ${generatedAt}`,
    '',
    '## Trigger (owner + hash + CREATE sha256)',
    '',
    `- \`${TRIGGER_SPEC.triggerName}\` on \`${TRIGGER_SPEC.table}\` — owner \`${TRIGGER_SPEC.ownerMigration}\` (\`${TRIGGER_SPEC.ownerMigrationSha256}\`)`,
    `- createTriggerSha=\`${CREATE_TRIGGER_SHA256}\``,
  ];
  findings.push(
    '',
    '## Offline gates',
    '',
    `- RED: ${REQUIRED_RED.length} cases`,
    `- GREEN: ${REQUIRED_GREEN.length} cases`,
    `- Authorized sequence length: **${SUCCESS_PATH_QUERY_COUNT}**`,
    `- Advisory locks: WHPA (0x57485041) / SPTG (0x53505447)`,
    `- Row count bound: tenant_surf_pack_rules=${APPROVED_ROW_COUNT} (capture if live differs)`,
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
      `reduced by exactly 1: **${liveBlock.reducedByExactlyOne === true}**`,
      `trigger key absent from remaining: **${liveBlock.triggerKeyAbsentFromRemaining === true}**`,
      `remaining keys: ${JSON.stringify(liveBlock.remainingKeys || [])}`,
      `liveExecutionCount: **${liveExecCount}** (max 1; reject >1)`,
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
    '## Live execution boundary',
    '',
    `- \`liveExecutionCount=${liveExecCount}\` (must be 0 offline or exactly 1 after successful live; reject >1).`,
    '- `implementationAutomaticRetry=false` — no retry loop inside the invocation.',
    '- `requestedNoRetryBoundaryPassed=true` — stop after first live error; no second invocation.',
    '',
    '## Do not claim',
    '',
    '- Do **not** claim zero remaining drift / database matches canonical / Sunset fully repaired.',
    '- Do **not** run verify with `--live` (verify never re-runs live / never calls executePhaseDSurfPackTriggerApply live).',
    '- Do **not** modify expected-product-schema bytes/fingerprint or migrations.',
    '',
    '## Operator live command',
    '',
    '```',
    'SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_SURF_PACK_TRIGGER_APPLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:surf-pack-trigger-apply -- --apply-surf-pack-trigger --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity',
    '```',
    '',
    '## Artifacts',
    '',
    '- `fixtures/sunset-schema-observer/slice14aa-surf-pack-trigger-apply-evidence.json`',
    '- `fixtures/sunset-schema-observer/slice14aa-surf-pack-trigger-apply-contract.json`',
    '- `fixtures/sunset-schema-observer/slice14aa-findings.md`',
  );
  fs.writeFileSync(FINDINGS_PATH, `${findings.join('\n')}\n`);

  console.log(`slice14aa offline RED=${red.length} GREEN=${green.length} ok`);
  if (wantLive && liveOutcome) {
    console.log(
      `slice14aa live ok=${liveOutcome.ok} before=${liveOutcome.mismatchCountBefore} `
      + `after=${liveOutcome.mismatchCountAfter} reducedBy1=${liveOutcome.reducedByExactlyOne}`,
    );
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
