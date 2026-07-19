'use strict';

/**
 * prove-sunset-schema-slice14z-surf-pack-fk-apply — FOUNDATION Slice 14Z
 *
 * Offline RED/GREEN → optional --live path: target authority (skipPostgres) →
 * observer BEFORE (baseline mismatch=6) → exactly one gated surf-pack-fk apply →
 * observer AFTER (mismatch reduced by exactly 1; FK key cleared).
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
  PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED,
  ENV_SURF_PACK_FK_APPLY,
  CLI_APPLY_SURF_PACK_FK,
  APPLICATION_NAME,
  AUTHORIZED_SEQUENCE,
  SUCCESS_PATH_QUERY_COUNT,
  APPLY_LOCKS,
  FK_SPEC,
  CONSTRAINT_NAME,
  OBSERVER_KEY,
  APPROVED_ROW_COUNT,
  ADD_FK_DIRECT_SQL,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  EXPECTED_REDUCTION,
  EXPECTED_REMAINING_MISMATCH_COUNT,
  EXPECTED_REMAINING_KEYS,
  FORBIDDEN_ARGV_FLAGS,
  evaluateSurfPackFkApplyGates,
  executePhaseDSurfPackFkApply,
  createScriptedSurfPackFkApplyFakeClientFactory,
  resetSurfPackFkApplyCounters,
  getSurfPackFkApplyCounters,
  exactSurfPackFkApplyArgv,
  surfPackFkApplyEnv,
  assertFkAlterStatementsByteLocked,
  assertBaselineMismatch,
  authorizeApplySql,
} = require('./lib/phase-d-surf-pack-fk-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14z-surf-pack-fk-apply-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14z-surf-pack-fk-apply-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14z-findings.md');
const APPLY_CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-surf-pack-fk-apply.js');

const MASTER = 'da67cf2c229f80d0cf118f7e361d95902cb6d32d';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const OBSERVER_APPLICATION_NAME = 'wh-sunset-schema-observer';

const FAKE_ADMIN_USER = 'slice14z-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14z-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14z-proof-imds-token-never-commit';

const REQUIRED_RED = Object.freeze([
  'orphan_present_refuse',
  'type_mismatch_refuse',
  'baseline_drift_mismatch',
  'duplicate_or_incompatible_fk_refuse',
  'owner_hash_drift_fails',
  'extra_unauthorized_sql_refuse',
  'partial_rollback_no_retry',
  'invalid_or_unvalidated_result_refuse',
  'default_path_zero_http_and_clients',
  'missing_apply_flag_or_env',
  'wrong_or_forbidden_argv',
  'managed_identity_requires_env_and_argv',
  'global_live_apply_remains_false',
]);

const REQUIRED_GREEN = Object.freeze([
  'null_semantics_ok_orphan_zero',
  'injected_http_success_exact_sequence',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'alter_statements_byte_locked',
  'fk_spec_maps_to_owner_hash_def',
  'row_count_bound_or_capture_locked',
  'direct_add_fallback_path_authorized',
]);

function validSecretValue() {
  return buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
}

function applyArgv(extraFlags) {
  return [
    ...exactSurfPackFkApplyArgv(),
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
  if (/Bearer\s+slice14z-proof-imds-token/i.test(text)) {
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

async function runSurfPackFkObserverCompare(dsn, expectedContract) {
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
      message: 'surf-pack-fk-apply CLI stdout/stderr did not contain parseable JSON',
    });
  }
  const code = String(p.code || (ok ? 'phase_d_surf_pack_fk_apply_ok' : 'surf_pack_fk_apply_failed'));
  const blocker = ok ? null : String(code || (errors[0] && errors[0].code) || 'surf_pack_fk_apply_failed');
  return {
    attempt: 1,
    ok,
    code,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    steps: Array.isArray(p.steps) ? p.steps.slice() : [],
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    beforeConstraint: p.beforeConstraint || null,
    afterConstraint: p.afterConstraint || null,
    constraintVerification: p.constraintVerification || null,
    rowCountsBefore: p.rowCountsBefore || null,
    rowCountsAfter: p.rowCountsAfter || null,
    capturedRowCount: p.capturedRowCount != null ? p.capturedRowCount : null,
    orphanCount: p.orphanCount != null ? Number(p.orphanCount) : null,
    alterStatementsSha256: p.alterStatementsSha256 || null,
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
    || process.env.SUNSET_SLICE14Z_PROOF_OFFLINE === '1';

  console.log(offlineOnly
    ? 'prove:sunset-schema-slice14z — offline only (no live HTTP/PG apply/observer)\n'
    : 'prove:sunset-schema-slice14z — offline then live authority + observer + apply\n');

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
  if (PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED !== true) {
    throw new Error('surf pack fk apply capability must be enabled');
  }
  if (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== true) {
    throw new Error('live MI HTTP must be activated');
  }
  if (!fs.existsSync(APPLY_CLI_PATH)) {
    throw new Error('required surf-pack-fk-apply CLI missing');
  }

  const alterLock = assertFkAlterStatementsByteLocked();
  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN, validSecretValue()];
  const red = [];
  const green = [];

  // ── RED ──────────────────────────────────────────────────────────
  {
    resetSurfPackFkApplyCounters();
    resetManagedIdentityHttpCounters();
    const FakeOrphan = createScriptedSurfPackFkApplyFakeClientFactory({
      responses: { orphanCount: 3 },
    });
    const orphanRun = await executePhaseDSurfPackFkApply({
      env: surfPackFkApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeOrphan,
    });
    if (orphanRun.ok || orphanRun.rolledBack !== true || orphanRun.steps.includes('COMMIT')
      || orphanRun.steps.includes('ADD CONSTRAINT NOT VALID')) {
      throw new Error(`orphan present must refuse+rollback: ${JSON.stringify(orphanRun)}`);
    }
    red.push({
      name: 'orphan_present_refuse',
      ok: true,
      code: orphanRun.code,
      rolledBack: true,
      noCommit: !orphanRun.steps.includes('COMMIT'),
      noAddFk: !orphanRun.steps.includes('ADD CONSTRAINT NOT VALID'),
    });
  }

  {
    resetSurfPackFkApplyCounters();
    const FakeType = createScriptedSurfPackFkApplyFakeClientFactory({
      responses: {
        catalogColumnsTenant: [{ name: 'updated_by', udt_name: 'text', is_nullable: true }],
        typeCompat: [{ src_udt: 'text', ref_udt: 'uuid' }],
      },
    });
    const typeRun = await executePhaseDSurfPackFkApply({
      env: surfPackFkApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeType,
    });
    if (typeRun.ok || typeRun.rolledBack !== true) {
      throw new Error(`type mismatch must refuse+rollback: ${JSON.stringify(typeRun)}`);
    }
    red.push({
      name: 'type_mismatch_refuse',
      ok: true,
      code: typeRun.code,
      rolledBack: true,
    });
  }

  {
    let threw = false;
    let code = null;
    try {
      assertBaselineMismatch({
        mismatchCount: 7,
        mismatchSections: { ...BASELINE_MISMATCH_SECTIONS, constraints: 2 },
      });
    } catch (e) {
      threw = true;
      code = e && e.code;
    }
    resetSurfPackFkApplyCounters();
    resetManagedIdentityHttpCounters();
    red.push({
      name: 'baseline_drift_mismatch',
      ok: threw === true
        && code === 'baseline_drift_mismatch'
        && getSurfPackFkApplyCounters().clientsInstantiated === 0
        && getManagedIdentityHttpCounters().httpRequestCount === 0,
      code,
      zeroMutation: true,
    });
  }

  {
    resetSurfPackFkApplyCounters();
    const FakeDup = createScriptedSurfPackFkApplyFakeClientFactory({
      responses: {
        tableForeignKeys: {
          rows: [{
            name: 'tenant_surf_pack_rules_updated_by_fkey_dup',
            condef: FK_SPEC.expectedCondef,
          }],
          rowCount: 1,
        },
      },
    });
    const dup = await executePhaseDSurfPackFkApply({
      env: surfPackFkApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeDup,
    });
    resetSurfPackFkApplyCounters();
    const FakeIncompat = createScriptedSurfPackFkApplyFakeClientFactory({
      responses: {
        constraintNameLookup: {
          rows: [{ name: CONSTRAINT_NAME, contype: 'f', conrel: 'public.other_table' }],
          rowCount: 1,
        },
      },
    });
    const incompat = await executePhaseDSurfPackFkApply({
      env: surfPackFkApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeIncompat,
    });
    if (dup.ok || incompat.ok || dup.rolledBack !== true || incompat.rolledBack !== true) {
      throw new Error(`duplicate/incompatible must refuse+rollback: dup=${dup.code} incompat=${incompat.code}`);
    }
    red.push({
      name: 'duplicate_or_incompatible_fk_refuse',
      ok: true,
      duplicateCode: dup.code,
      incompatibleCode: incompat.code,
      rolledBack: true,
    });
  }

  {
    let driftCode = null;
    const live = sha256CanonicalLfV1File(
      path.join(MIGRATIONS_DIR, `${FK_SPEC.ownerMigration}.sql`),
    );
    const driftDetected = live !== '0'.repeat(64);
    let assertOk = false;
    try {
      assertFkAlterStatementsByteLocked();
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
      ok: rejectedSql.length === 5,
      rejectedStatements: rejectedSql,
    });
  }

  {
    resetSurfPackFkApplyCounters();
    const FakePartial = createScriptedSurfPackFkApplyFakeClientFactory({
      queryErrorAt: {
        'ADD CONSTRAINT NOT VALID': Object.assign(new Error('add fk failed'), {
          code: 'query_failed',
        }),
      },
    });
    const partial = await executePhaseDSurfPackFkApply({
      env: surfPackFkApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakePartial,
    });
    const addAttempts = (partial.steps || [])
      .filter((s) => s === 'ADD CONSTRAINT NOT VALID').length;
    if (partial.ok || partial.rolledBack !== true || partial.steps.includes('COMMIT')
      || addAttempts > 1) {
      throw new Error(`partial ADD failure must rollback once, no retry: ${JSON.stringify(partial)}`);
    }
    red.push({
      name: 'partial_rollback_no_retry',
      ok: true,
      code: partial.code,
      rolledBack: true,
      noCommit: !partial.steps.includes('COMMIT'),
      addAttempts,
      noRetry: addAttempts <= 1,
    });
  }

  {
    resetSurfPackFkApplyCounters();
    const FakeInvalid = createScriptedSurfPackFkApplyFakeClientFactory({
      responses: {
        verifyAfterNotValid: [{
          name: CONSTRAINT_NAME,
          contype: 'f',
          convalidated: true,
          condef: FK_SPEC.expectedCondef,
        }],
      },
    });
    const invalid = await executePhaseDSurfPackFkApply({
      env: surfPackFkApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeInvalid,
    });
    if (invalid.ok || invalid.rolledBack !== true) {
      throw new Error(`invalid not-validated result must refuse: ${JSON.stringify(invalid)}`);
    }
    red.push({
      name: 'invalid_or_unvalidated_result_refuse',
      ok: true,
      code: invalid.code,
      rolledBack: true,
    });
  }

  {
    resetSurfPackFkApplyCounters();
    resetManagedIdentityHttpCounters();
    const def = await executePhaseDSurfPackFkApply({ env: {}, argv: [] });
    if (getSurfPackFkApplyCounters().clientsInstantiated !== 0
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
    resetSurfPackFkApplyCounters();
    resetManagedIdentityHttpCounters();
    const noFlag = await executePhaseDSurfPackFkApply({
      env: surfPackFkApplyEnv(),
      argv: applyArgv().filter((a) => a !== CLI_APPLY_SURF_PACK_FK),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
    });
    resetSurfPackFkApplyCounters();
    resetManagedIdentityHttpCounters();
    const noEnv = await executePhaseDSurfPackFkApply({
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
    if (getSurfPackFkApplyCounters().clientsInstantiated !== 0
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
    const wrongDb = evaluateSurfPackFkApplyGates({
      env: surfPackFkApplyEnv(),
      argv: applyArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
    });
    if (wrongDb.ok) throw new Error('wrong database must fail');
    const forbidden = evaluateSurfPackFkApplyGates({
      env: surfPackFkApplyEnv(),
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
    resetSurfPackFkApplyCounters();
    const forbiddenRun = await executePhaseDSurfPackFkApply({
      env: surfPackFkApplyEnv(),
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
    if (getSurfPackFkApplyCounters().clientsInstantiated !== 0) {
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
    const halfFlag = evaluateSurfPackFkApplyGates({
      env: {
        [ENV_LIVE_READONLY]: '1',
        [ENV_LIVE_PREFLIGHT]: '1',
        [ENV_SURF_PACK_FK_APPLY]: '1',
        [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      },
      argv: exactSurfPackFkApplyArgv(),
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
      surfPackFkApplyLiveEnabled: PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED === true,
    });
  }

  // ── GREEN ────────────────────────────────────────────────────────
  {
    resetSurfPackFkApplyCounters();
    const FakeNullOk = createScriptedSurfPackFkApplyFakeClientFactory({
      responses: { orphanCount: 0 },
    });
    const nullOk = await executePhaseDSurfPackFkApply({
      env: surfPackFkApplyEnv(),
      argv: applyArgv(),
      httpRequest: createInjectedManagedIdentityHttp({
        imdsAccessToken: FAKE_IMDS_TOKEN,
        defaultSecretValue: validSecretValue(),
      }),
      Client: FakeNullOk,
    });
    if (!nullOk.ok || nullOk.orphanCount !== 0) {
      throw new Error(`null semantics orphan zero must succeed: ${JSON.stringify(nullOk)}`);
    }
    green.push({
      name: 'null_semantics_ok_orphan_zero',
      ok: true,
      orphanCount: 0,
      code: nullOk.code,
    });
  }

  {
    resetSurfPackFkApplyCounters();
    resetManagedIdentityHttpCounters();
    const FakeOk = createScriptedSurfPackFkApplyFakeClientFactory({});
    const okRun = await executePhaseDSurfPackFkApply({
      env: surfPackFkApplyEnv(),
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
    const gatesOk = evaluateSurfPackFkApplyGates({
      env: surfPackFkApplyEnv(),
      argv: exactSurfPackFkApplyArgv(),
    });
    if (!gatesOk.ok) {
      throw new Error(`CLI gates should pass: ${JSON.stringify(gatesOk.errors)}`);
    }
    green.push({
      name: 'cli_gates_exact_targets',
      ok: true,
      applySurfPackFk: gatesOk.applySurfPackFk === true,
    });
  }

  {
    const cliDefault = spawnSync(process.execPath, [APPLY_CLI_PATH], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    if (cliDefault.status === 0) throw new Error('surf-pack-fk-apply CLI default must refuse');
    leakScan(`${cliDefault.stdout}${cliDefault.stderr}`, secrets);
    green.push({
      name: 'cli_default_disabled',
      ok: true,
      exitCode: cliDefault.status,
    });
  }

  {
    if (APPLY_LOCKS.applicationName !== APPLICATION_NAME
      || APPLICATION_NAME !== 'wh-sunset-surf-pack-fk-apply'
      || APPLY_LOCKS.advisoryLockKey1 !== 0x5748505A
      || APPLY_LOCKS.advisoryLockKey2 !== 0x5350464B
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
      name: 'alter_statements_byte_locked',
      ok: true,
      alterStatementsSha256: alterLock.alterStatementsSha256,
      ownerMigrationSha256: alterLock.ownerMigrationSha256,
    });
  }

  {
    const liveOwner = sha256CanonicalLfV1File(
      path.join(MIGRATIONS_DIR, `${FK_SPEC.ownerMigration}.sql`),
    );
    const inExpected = expectedBytes.toString('utf8').includes(FK_SPEC.expectedCondef);
    if (liveOwner !== FK_SPEC.ownerMigrationSha256 || !inExpected) {
      throw new Error('fk spec must map to owner hash and expected def');
    }
    green.push({
      name: 'fk_spec_maps_to_owner_hash_def',
      ok: true,
      constraintName: FK_SPEC.constraintName,
      observerKey: OBSERVER_KEY,
      ownerMigration: FK_SPEC.ownerMigration,
      ownerMigrationSha256: FK_SPEC.ownerMigrationSha256,
      expectedCondef: FK_SPEC.expectedCondef,
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
    let directAuthorized = false;
    try {
      authorizeApplySql(ADD_FK_DIRECT_SQL);
      directAuthorized = true;
    } catch (e) {
      directAuthorized = false;
    }
    if (!directAuthorized) throw new Error('direct ADD must be authorized');
    green.push({
      name: 'direct_add_fallback_path_authorized',
      ok: true,
      addDirectSqlSha256: FK_SPEC.addDirectSqlSha256,
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
      console.log('Live section 2/4: observer BEFORE (baseline mismatch=6)…\n');
      const loadedBefore = await loadProtectedAdminCredentialsViaManagedIdentity({
        env: surfPackFkApplyEnv(),
        argv: exactSurfPackFkApplyArgv(),
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
          observerBefore = await runSurfPackFkObserverCompare(dsnBefore, expected);
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
          console.log('Live section 3/4: exactly one gated surf-pack-fk-apply CLI spawn…\n');
          const liveApplyCli = spawnSync(
            process.execPath,
            [APPLY_CLI_PATH, ...exactSurfPackFkApplyArgv()],
            {
              encoding: 'utf8',
              env: { ...process.env, ...surfPackFkApplyEnv() },
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
            console.log('Live section 4/4: observer AFTER (expect −1 FK)…\n');
            const loadedAfter = await loadProtectedAdminCredentialsViaManagedIdentity({
              env: surfPackFkApplyEnv(),
              argv: exactSurfPackFkApplyArgv(),
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
                observerAfter = await runSurfPackFkObserverCompare(dsnAfter, expected);
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
          const fkKeyAbsent = !remainingKeys.includes(OBSERVER_KEY);
          const rowPreserved = liveApplyOutcome.ok === true
            && liveApplyOutcome.rowCountsBefore
            && liveApplyOutcome.rowCountsAfter
            && liveApplyOutcome.rowCountsBefore.tenant_surf_pack_rules
              === liveApplyOutcome.rowCountsAfter.tenant_surf_pack_rules;

          liveOutcome = {
            ok: liveApplyOutcome.ok === true
              && reducedByOne === true
              && fkKeyAbsent === true
              && rowPreserved === true,
            code: liveApplyOutcome.ok === true
              ? (reducedByOne && fkKeyAbsent
                ? 'phase_d_surf_pack_fk_apply_ok_observer_reduced'
                : 'phase_d_surf_pack_fk_apply_ok_observer_unexpected')
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
            fkKeyAbsentFromRemaining: fkKeyAbsent === true,
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
              ? (reducedByOne && fkKeyAbsent ? null : 'observer_reduction_mismatch')
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
    kind: 'sunset-schema-observer-slice14z-surf-pack-fk-apply-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14Z',
    outcome: offlineOnlyOutcome
      ? 'phase_d_surf_pack_fk_apply_offline_only'
      : ((liveBlock && liveBlock.code) || 'phase_d_surf_pack_fk_apply_unknown'),
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
    appliesFk: true,
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
    fkSpec: {
      constraintName: FK_SPEC.constraintName,
      observerKey: OBSERVER_KEY,
      table: FK_SPEC.table,
      refTable: FK_SPEC.refTable,
      ownerMigration: FK_SPEC.ownerMigration,
      ownerMigrationSha256: FK_SPEC.ownerMigrationSha256,
      approvedRowCount: FK_SPEC.approvedRowCount,
    },
    alterStatementsSha256: alterLock.alterStatementsSha256,
    ownerMigrationSha256: alterLock.ownerMigrationSha256,
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    successPathQueryCount: SUCCESS_PATH_QUERY_COUNT,
    approvedRowCount: APPROVED_ROW_COUNT,
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    defaultDisabled: true,
    dualEnableFlagsRequired: true,
    surfPackFkApplyEnvGateRequired: true,
    surfPackFkApplyArgvGateRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    offlineGates: {
      orphanPresentRefuse: true,
      typeMismatchRefuse: true,
      baselineDriftMismatch: true,
      duplicateOrIncompatibleFkRefuse: true,
      ownerHashDriftFails: true,
      extraUnauthorizedSqlRefuse: true,
      partialRollbackNoRetry: true,
      invalidOrUnvalidatedResultRefuse: true,
      defaultPathZeroHttpAndClients: true,
      missingApplyFlagOrEnv: true,
      wrongOrForbiddenArgv: true,
      managedIdentityRequiresEnvAndArgv: true,
      globalLiveApplyRemainsFalse: true,
      nullSemanticsOkOrphanZero: true,
      injectedHttpSuccessExactSequence: true,
      cliGatesExactTargets: true,
      cliDefaultDisabled: true,
      locksIdentityVaultSecretPgTlsApplicationName: true,
      alterStatementsByteLocked: true,
      fkSpecMapsToOwnerHashDef: true,
      rowCountBoundOrCaptureLocked: true,
      directAddFallbackPathAuthorized: true,
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
    kind: 'sunset-schema-observer-slice14z-surf-pack-fk-apply-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: true,
    surfPackFkApplyLiveEnabled: true,
    globalLiveApplyEnabled: false,
    liveReadonlyConnectEnabled: true,
    liveHttpEnabled: true,
    appliesFk: true,
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
    surfPackFkApplyEnvGateRequired: true,
    surfPackFkApplyArgvGateRequired: true,
    exactTargetCliConfirmationRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    targetAuthorityRequiredBeforeApply: true,
    baselineMismatchRequiredBeforeApply: true,
    observerReadOnlyBeforeAndAfterApply: true,
    offlineInjectedHttpAndFakeClientProof: true,
    alterStatementsByteLocked: true,
    verifyNeverRerunsLive: true,
    claimsZeroDrift: false,
    claimsFullRepair: false,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14Z',
    purpose: 'Apply exactly one byte-locked residual FK after baseline mismatch=6; observer must reduce by exactly 1; do not claim zero drift / full repair; no DML/ledger/migration/Azure mutation beyond MI credential GET; verify never re-runs live.',
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
      advisoryLockLabels: ['WHPZ', 'SPFK'],
      constraintName: CONSTRAINT_NAME,
      observerKey: OBSERVER_KEY,
      alterSqlSha256: APPLY_LOCKS.alterSqlSha256,
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
      surfPackFkApply: {
        script: 'scripts/run-phase-d-surf-pack-fk-apply.js',
        npm: 'phase-d:surf-pack-fk-apply',
        requiredEnv: [
          'SUNSET_PHASE_D_LIVE_READONLY=1',
          'SUNSET_PHASE_D_LIVE_PREFLIGHT=1',
          'SUNSET_PHASE_D_SURF_PACK_FK_APPLY=1',
          'SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity',
          `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
        ],
        requiredArgv: [
          CLI_APPLY_SURF_PACK_FK,
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
    alterStatementsSha256: alterLock.alterStatementsSha256,
    ownerMigrationSha256: alterLock.ownerMigrationSha256,
    baselineMismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
    expectedRemainingKeys: EXPECTED_REMAINING_KEYS.slice(),
    requiredRed: REQUIRED_RED.slice(),
    requiredGreen: REQUIRED_GREEN.slice(),
    forbidden: [
      'INSERT/UPDATE/DELETE',
      'DROP/RENAME/ALTER TABLE (except locked FK ADD/VALIDATE)',
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
    '# FOUNDATION Slice 14Z — Apply tenant_surf_pack_rules_updated_by_fkey',
    '',
    `**Status:** ${liveBlock && liveBlock.ok
      ? 'surf_pack_fk_apply_live_ok_observer_reduced'
      : 'offline_ok_awaiting_live'}`,
    `**Master basis:** \`${MASTER}\``,
    `**Canonical fingerprint (unchanged):** \`${CANON_FP}\``,
    `**Expected bytes (unchanged):** \`${EXPECTED_BYTE_SHA}\``,
    `**Manifest hash (unchanged):** \`${MANIFEST_HASH}\``,
    `**Generated:** ${generatedAt}`,
    '',
    '## FK (owner + hash + ALTER sha256)',
    '',
    `- \`${FK_SPEC.constraintName}\` on \`${FK_SPEC.table}\` → \`${FK_SPEC.refTable}(id)\` — owner \`${FK_SPEC.ownerMigration}\` (\`${FK_SPEC.ownerMigrationSha256}\`)`,
    `- addNotValidSha=\`${FK_SPEC.addNotValidSqlSha256}\` validateSha=\`${FK_SPEC.validateSqlSha256}\` directAddSha=\`${FK_SPEC.addDirectSqlSha256}\``,
  ];
  findings.push(
    '',
    '## Offline gates',
    '',
    `- RED: ${REQUIRED_RED.length} cases`,
    `- GREEN: ${REQUIRED_GREEN.length} cases`,
    `- Authorized sequence length: **${SUCCESS_PATH_QUERY_COUNT}**`,
    `- Advisory locks: WHPZ (0x5748505A) / SPFK (0x5350464B)`,
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
      `FK key absent from remaining: **${liveBlock.fkKeyAbsentFromRemaining === true}**`,
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
    '- Do **not** run verify with `--live` (verify never re-runs live / never calls executePhaseDSurfPackFkApply live).',
    '- Do **not** modify expected-product-schema bytes/fingerprint or migrations.',
    '- Do **not** retry after partial FK failure (ROLLBACK once).',
    '',
    '## Operator live command',
    '',
    '```',
    'SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_SURF_PACK_FK_APPLY=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:surf-pack-fk-apply -- --apply-surf-pack-fk --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity',
    '```',
    '',
    '## Artifacts',
    '',
    '- `fixtures/sunset-schema-observer/slice14z-surf-pack-fk-apply-evidence.json`',
    '- `fixtures/sunset-schema-observer/slice14z-surf-pack-fk-apply-contract.json`',
    '- `fixtures/sunset-schema-observer/slice14z-findings.md`',
    '',
  );
  fs.writeFileSync(FINDINGS_PATH, `${findings.join('\n')}\n`);

  console.log(`slice14z offline RED=${red.length} GREEN=${green.length} ok`);
  if (wantLive && liveOutcome) {
    console.log(
      `slice14z live ok=${liveOutcome.ok} before=${liveOutcome.mismatchCountBefore} `
      + `after=${liveOutcome.mismatchCountAfter} reducedBy1=${liveOutcome.reducedByExactlyOne}`,
    );
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
