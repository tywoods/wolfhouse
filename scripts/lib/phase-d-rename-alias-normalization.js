'use strict';

/**
 * FOUNDATION Slice 14V — migration 003 hostel_id→client_id rename-alias
 * observer representation normalization
 *
 * Merged target-authority proof (14Q skipPostgres) + exactly one TLS
 * verify-full read-only observer session
 * (application_name=wh-sunset-rename-alias-normalization) that reports:
 *   - safe server_version class (PG15 required for alias apply)
 *   - baseline mismatch counts (identity + 14T; rename alias disabled)
 *   - after mismatch counts (identity + 14T + rename alias)
 *   - number of rename-alias artifacts normalized
 *   - remaining mismatch key inventory
 *
 * Requires baseline mismatchCount === 35 (post-14T residual) or stops with
 * baseline_drift_mismatch.
 *
 * Zero mutation: no DDL/DML/ledger/KV write/Azure/RBAC/network/deploy.
 * Default-disabled behind exact env+argv gates.
 * PHASE_D_LIVE_APPLY_ENABLED must remain false.
 */

const { Client } = require('pg');
const {
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  redactDeep,
} = require('./phase-d-live-readonly-boundary');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  buildOfflineProofSunsetDatabaseUrl,
  loadProtectedAdminCredentialsViaManagedIdentity,
  zeroPrivateCredentialRefs,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
  createInjectedManagedIdentityHttp,
} = require('./phase-d-managed-identity-credential-loader');
const {
  buildVerifiedTlsSslConfig,
} = require('./phase-d-live-readonly-pg-adapter');
const {
  PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED,
  ENV_TARGET_AUTHORITY,
  CLI_PROVE_TARGET_AUTHORITY,
  AUTHORITY_LOCKS,
  evaluateTargetAuthorityGates,
  exactTargetAuthorityArgv,
  targetAuthorityEnv,
  executeActiveDbTargetAuthority,
  createInjectedTargetAuthorityHttp,
  createLiveTargetAuthorityHttpRequest,
  resetTargetAuthorityCounters,
  getTargetAuthorityCounters,
  FORBIDDEN_ARGV_FLAGS: AUTHORITY_FORBIDDEN_ARGV,
} = require('./phase-d-active-db-target-authority');
const {
  introspectProductSchema,
  fingerprintProductSchema,
  compareSnapshots,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  INTROSPECTION_SQL,
  assertSqlAllowed,
  classifyServerVersionClass,
  MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256,
} = require('./sunset-schema-observer');

/** Live capability activated for Slice 14V behind exact env+argv gates. */
const PHASE_D_RENAME_ALIAS_NORMALIZATION_LIVE_ENABLED = true;

const ENV_RENAME_ALIAS_NORMALIZATION = 'SUNSET_PHASE_D_RENAME_ALIAS_NORMALIZATION';
const CLI_PROVE_RENAME_ALIAS_NORMALIZATION = '--prove-rename-alias-normalization';
const APPLICATION_NAME = 'wh-sunset-rename-alias-normalization';

const BASELINE_MISMATCH_COUNT = 35;
const BASELINE_MISMATCH_SECTIONS = Object.freeze({
  constraints: 25,
  indexes: 5,
  functions: 1,
  triggers: 1,
  ownership: 1,
  acls: 1,
  extensions: 1,
});

const RENAME_ALIAS_LOCKS = Object.freeze({
  ...AUTHORITY_LOCKS,
  applicationName: APPLICATION_NAME,
});

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_PROVE_RENAME_ALIAS_NORMALIZATION,
  CLI_PROVE_TARGET_AUTHORITY,
  CLI_CREDENTIAL_SOURCE,
  '--subscription',
  '--resource-group',
  '--container-app',
  '--postgres-server',
  '--database',
  '--help',
  '-h',
]);

const FORBIDDEN_ARGV_FLAGS = Object.freeze([
  ...AUTHORITY_FORBIDDEN_ARGV,
  '--dsn',
  '--connection-string',
  '--database-url',
  '--apply',
  '--mutate',
  '--live-apply',
]);

let clientsInstantiated = 0;
let connectCalls = 0;
let queryCalls = 0;
let endCalls = 0;

function resetRenameAliasNormalizationCounters() {
  clientsInstantiated = 0;
  connectCalls = 0;
  queryCalls = 0;
  endCalls = 0;
  resetTargetAuthorityCounters();
  resetManagedIdentityHttpCounters();
}

function getRenameAliasNormalizationCounters() {
  const auth = getTargetAuthorityCounters();
  const mi = getManagedIdentityHttpCounters();
  return {
    clientsInstantiated,
    connectCalls,
    queryCalls,
    endCalls,
    httpRequestCount: (auth.httpRequestCount || 0) + (mi.httpRequestCount || 0),
    imdsRequestCount: (auth.imdsRequestCount || 0) + (mi.imdsRequestCount || 0),
    armGetCount: auth.armGetCount || 0,
    armPostCount: auth.armPostCount || 0,
    listSecretsCount: auth.listSecretsCount || 0,
    keyVaultRequestCount: (auth.keyVaultRequestCount || 0) + (mi.keyVaultRequestCount || 0),
  };
}

function parseArgvPairs(argv) {
  const flags = new Set();
  const values = Object.create(null);
  const forbidden = [];
  const unknown = [];
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (FORBIDDEN_ARGV_FLAGS.includes(a)) {
      forbidden.push(a);
      continue;
    }
    if (a === CLI_PROVE_RENAME_ALIAS_NORMALIZATION
      || a === CLI_PROVE_TARGET_AUTHORITY
      || a === '--help'
      || a === '-h') {
      flags.add(a);
      continue;
    }
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next != null && !String(next).startsWith('--')) {
        values[a] = String(next);
        i += 1;
        if (!ALLOWED_ARGV_FLAGS.includes(a)) unknown.push(a);
      } else if (!ALLOWED_ARGV_FLAGS.includes(a)) {
        unknown.push(a);
      } else {
        flags.add(a);
      }
      continue;
    }
    unknown.push(a);
  }
  return { flags, values, forbidden, unknown };
}

function exactRenameAliasNormalizationArgv() {
  return [
    CLI_PROVE_RENAME_ALIAS_NORMALIZATION,
    CLI_PROVE_TARGET_AUTHORITY,
    '--subscription', RENAME_ALIAS_LOCKS.subscriptionId,
    '--resource-group', RENAME_ALIAS_LOCKS.resourceGroup,
    '--container-app', RENAME_ALIAS_LOCKS.containerAppName,
    '--postgres-server', RENAME_ALIAS_LOCKS.postgresServer,
    '--database', RENAME_ALIAS_LOCKS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function renameAliasNormalizationEnv() {
  return {
    ...targetAuthorityEnv(),
    [ENV_RENAME_ALIAS_NORMALIZATION]: '1',
  };
}

function evaluateRenameAliasNormalizationGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const parsed = parseArgvPairs(options.argv || []);
  const errors = [];

  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) {
    errors.push({ code: 'connect_not_enabled', message: 'PHASE_D_LIVE_READONLY_CONNECT_ENABLED must be true' });
  }
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    errors.push({ code: 'global_apply_must_remain_false', message: 'PHASE_D_LIVE_APPLY_ENABLED must remain false' });
  }
  if (PHASE_D_RENAME_ALIAS_NORMALIZATION_LIVE_ENABLED !== true) {
    errors.push({ code: 'rename_alias_normalization_capability_disabled', message: 'rename-alias normalization live disabled' });
  }
  if (PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED !== true) {
    errors.push({ code: 'target_authority_capability_disabled', message: 'target authority live capability disabled' });
  }
  if (String(env[ENV_LIVE_READONLY] || '') !== '1') {
    errors.push({ code: 'live_readonly_flag_required', message: `${ENV_LIVE_READONLY}=1 required` });
  }
  if (String(env[ENV_LIVE_PREFLIGHT] || '') !== '1') {
    errors.push({ code: 'live_preflight_flag_required', message: `${ENV_LIVE_PREFLIGHT}=1 required` });
  }
  if (String(env[ENV_TARGET_AUTHORITY] || '') !== '1') {
    errors.push({ code: 'target_authority_env_required', message: `${ENV_TARGET_AUTHORITY}=1 required` });
  }
  if (String(env[ENV_RENAME_ALIAS_NORMALIZATION] || '') !== '1') {
    errors.push({ code: 'rename_alias_normalization_env_required', message: `${ENV_RENAME_ALIAS_NORMALIZATION}=1 required` });
  }
  if (String(env[ENV_SUBSCRIPTION] || '') !== RENAME_ALIAS_LOCKS.subscriptionId) {
    errors.push({ code: 'subscription_env_mismatch', message: 'AZURE_SUBSCRIPTION_ID must match locked subscription' });
  }
  if (String(env[ENV_CREDENTIAL_SOURCE] || '') !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `env ${ENV_CREDENTIAL_SOURCE}=managed-identity required`,
    });
  }
  if (!parsed.flags.has(CLI_PROVE_RENAME_ALIAS_NORMALIZATION)) {
    errors.push({
      code: 'rename_alias_normalization_flag_required',
      message: `${CLI_PROVE_RENAME_ALIAS_NORMALIZATION} required`,
    });
  }
  if (!parsed.flags.has(CLI_PROVE_TARGET_AUTHORITY)) {
    errors.push({
      code: 'target_authority_flag_required',
      message: `${CLI_PROVE_TARGET_AUTHORITY} required`,
    });
  }
  if (parsed.values[CLI_CREDENTIAL_SOURCE] !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `argv ${CLI_CREDENTIAL_SOURCE} managed-identity required`,
    });
  }
  if (parsed.forbidden.length > 0) {
    errors.push({ code: 'forbidden_argv', message: `forbidden argv: ${parsed.forbidden.join(',')}` });
  }
  if (parsed.unknown.length > 0) {
    errors.push({ code: 'unknown_argv', message: `unknown argv: ${parsed.unknown.join(',')}` });
  }

  const expect = {
    '--subscription': RENAME_ALIAS_LOCKS.subscriptionId,
    '--resource-group': RENAME_ALIAS_LOCKS.resourceGroup,
    '--container-app': RENAME_ALIAS_LOCKS.containerAppName,
    '--postgres-server': RENAME_ALIAS_LOCKS.postgresServer,
    '--database': RENAME_ALIAS_LOCKS.database,
  };
  for (const [flag, want] of Object.entries(expect)) {
    if (String(parsed.values[flag] || '') !== want) {
      errors.push({ code: 'exact_target_mismatch', message: `${flag} must equal locked ${want}` });
    }
  }

  return { ok: errors.length === 0, errors, parsed };
}

function buildLockedPgClientConfig(user, password) {
  return {
    host: RENAME_ALIAS_LOCKS.postgresHost,
    port: RENAME_ALIAS_LOCKS.port,
    database: RENAME_ALIAS_LOCKS.database,
    user: String(user),
    password: String(password),
    application_name: APPLICATION_NAME,
    options: [
      '-c default_transaction_read_only=on',
      '-c statement_timeout=30000',
      '-c lock_timeout=5000',
    ].join(' '),
    connectionTimeoutMillis: 20000,
    ssl: buildVerifiedTlsSslConfig(),
  };
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
      renameAliasesNormalized: null,
      notNullArtifactsNormalized: null,
      renameAliasNormalization: null,
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
  const renameAliasesNormalized = cmp.renameAliasNormalization
    ? Number(cmp.renameAliasNormalization.normalizedCount) || 0
    : 0;
  return {
    ok: cmp.ok === true,
    match: cmp.ok === true,
    code: cmp.ok === true ? 'observer_match' : 'observer_drift',
    mismatchCount,
    counts: cmp.counts,
    mismatchSections: groupMismatchSections(drifts),
    remainingKeys: remainingMismatchKeys(drifts),
    renameAliasesNormalized,
    notNullArtifactsNormalized: cmp.notNullNormalization
      ? Number(cmp.notNullNormalization.normalizedCount) || 0
      : 0,
    renameAliasNormalization: cmp.renameAliasNormalization
      ? {
        applied: cmp.renameAliasNormalization.applied === true,
        normalizedCount: renameAliasesNormalized,
        reason: cmp.renameAliasNormalization.reason || null,
        provenance: cmp.renameAliasNormalization.provenance || null,
      }
      : null,
    normalizationError: null,
  };
}

/**
 * Baseline gate: post-14T residual inventory is exactly 35 mismatches
 * (rename alias disabled). Stop with baseline_drift_mismatch otherwise.
 */
function assertBaselineMismatch(compareSummary) {
  const summary = compareSummary || {};
  const mismatchCount = Number(summary.mismatchCount);
  const sections = summary.mismatchSections || {};
  const expectedSections = BASELINE_MISMATCH_SECTIONS;
  const sectionKeys = Object.keys(expectedSections).sort();
  const gotKeys = Object.keys(sections).sort();
  const sectionsMatch = sectionKeys.length === gotKeys.length
    && sectionKeys.every((k) => Number(sections[k]) === expectedSections[k]);

  if (mismatchCount === BASELINE_MISMATCH_COUNT && sectionsMatch) {
    return {
      ok: true,
      code: 'baseline_ok',
      mismatchCount,
      mismatchSections: { ...sections },
      expectedMismatchCount: BASELINE_MISMATCH_COUNT,
      expectedMismatchSections: { ...expectedSections },
    };
  }
  return {
    ok: false,
    code: 'baseline_drift_mismatch',
    mismatchCount: Number.isFinite(mismatchCount) ? mismatchCount : null,
    mismatchSections: { ...sections },
    expectedMismatchCount: BASELINE_MISMATCH_COUNT,
    expectedMismatchSections: { ...expectedSections },
    message: `expected mismatchCount=${BASELINE_MISMATCH_COUNT} with sections `
      + JSON.stringify(expectedSections)
      + `; got mismatchCount=${mismatchCount} sections=${JSON.stringify(sections)}`,
  };
}

async function safeShow(client, key) {
  const sql = INTROSPECTION_SQL[key];
  const gate = assertSqlAllowed(sql);
  if (!gate.ok) {
    throw Object.assign(new Error(gate.message), { code: gate.code });
  }
  queryCalls += 1;
  const res = await client.query(sql);
  const row = (res.rows && res.rows[0]) || {};
  const val = row[key] != null ? row[key] : Object.values(row)[0];
  return val;
}

async function verifyRenameAliasSession(client) {
  const errors = [];
  const tro = String(await safeShow(client, 'show_transaction_read_only')).toLowerCase();
  if (tro !== 'on') {
    errors.push({ code: 'non_read_only_session', message: `transaction_read_only=${tro || 'unset'}` });
  }
  const app = String(await safeShow(client, 'show_application_name'));
  if (app !== APPLICATION_NAME) {
    errors.push({
      code: 'wrong_application_name',
      message: `application_name must be ${APPLICATION_NAME}`,
    });
  }
  const st = String(await safeShow(client, 'show_statement_timeout'));
  if (!(st === '30s' || st === '30000ms' || st === '30000')) {
    errors.push({ code: 'bad_statement_timeout', message: st });
  }
  const lt = String(await safeShow(client, 'show_lock_timeout'));
  if (!(lt === '5s' || lt === '5000ms' || lt === '5000')) {
    errors.push({ code: 'bad_lock_timeout', message: lt });
  }
  return {
    ok: errors.length === 0,
    errors,
    show: {
      transaction_read_only: tro,
      application_name: app,
      statement_timeout: st,
      lock_timeout: lt,
    },
  };
}

async function captureServerVersionClass(client) {
  const serverVersion = String(await safeShow(client, 'show_server_version') || '');
  const serverVersionNumRaw = await safeShow(client, 'show_server_version_num');
  return classifyServerVersionClass(serverVersionNumRaw, serverVersion);
}

async function runRenameAliasObserverCompare(client, expectedContract) {
  const session = await verifyRenameAliasSession(client);
  if (!session.ok) {
    return {
      sessionReadOnly: false,
      transactionReadOnly: false,
      serverVersionClass: null,
      observerBefore: null,
      observerAfter: null,
      baseline: null,
      baselineMismatchCount: null,
      renameAliasesNormalized: null,
      remainingMismatchCount: null,
      remainingKeys: [],
      productFingerprintLive: null,
      migration003Sha256: null,
      provenanceCount: null,
      errors: session.errors,
    };
  }

  const serverVersionClass = await captureServerVersionClass(client);
  const product = await introspectProductSchema(client);
  queryCalls += Array.isArray(product.usedAllowlist) ? product.usedAllowlist.length : 20;
  const productFingerprintLive = fingerprintProductSchema(product.snapshot);
  const versionClass = serverVersionClass && serverVersionClass.versionClass
    ? serverVersionClass.versionClass
    : null;
  const azureContext = {
    verified: true,
    host: EXPECTED_HOST,
    database: EXPECTED_DATABASE,
    versionClass,
  };

  // Baseline: identity + 14T NOT NULL norm; rename alias DISABLED.
  const rawCmp = compareSnapshots(expectedContract.snapshot, product.snapshot, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext,
    serverVersionClass: versionClass,
    disableRenameAliasNormalization: true,
  });
  const observerBefore = summarizeCompare(rawCmp);
  const baseline = assertBaselineMismatch(observerBefore);
  if (!baseline.ok) {
    return {
      sessionReadOnly: true,
      transactionReadOnly: String(session.show.transaction_read_only).toLowerCase() === 'on',
      serverVersionClass,
      observerBefore,
      observerAfter: null,
      baseline,
      baselineMismatchCount: observerBefore.mismatchCount,
      renameAliasesNormalized: null,
      remainingMismatchCount: null,
      remainingKeys: [],
      productFingerprintLive,
      migration003Sha256: null,
      provenanceCount: null,
      errors: [{ code: 'baseline_drift_mismatch', message: baseline.message }],
      stopReason: 'baseline_drift_mismatch',
    };
  }

  // After: identity + 14T + rename alias (default on for azure + PG15).
  const normCmp = compareSnapshots(expectedContract.snapshot, product.snapshot, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext,
    serverVersionClass: versionClass,
  });
  const observerAfter = summarizeCompare(normCmp);
  const renameAliasesNormalized = observerAfter.renameAliasesNormalized != null
    ? observerAfter.renameAliasesNormalized
    : 0;
  const remainingMismatchCount = observerAfter.mismatchCount != null
    ? observerAfter.mismatchCount
    : null;
  const remainingKeys = observerAfter.remainingKeys || [];
  const provenance = observerAfter.renameAliasNormalization
    && observerAfter.renameAliasNormalization.provenance
    ? observerAfter.renameAliasNormalization.provenance
    : null;

  return {
    sessionReadOnly: true,
    transactionReadOnly: String(session.show.transaction_read_only).toLowerCase() === 'on',
    serverVersionClass,
    observerBefore,
    observerAfter,
    baseline,
    baselineMismatchCount: BASELINE_MISMATCH_COUNT,
    renameAliasesNormalized,
    remainingMismatchCount,
    remainingKeys,
    accountingOk: BASELINE_MISMATCH_COUNT === renameAliasesNormalized + remainingMismatchCount,
    productFingerprintLive,
    migration003Sha256: (provenance && provenance.migrationSha256)
      || MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256,
    provenanceCount: provenance && provenance.provenanceCount != null
      ? provenance.provenanceCount
      : null,
    errors: [],
  };
}

function pickSafe(result) {
  return redactDeep(result, []);
}

/**
 * Main gated entry.
 * options: env, argv, httpRequest, ClientFactory, expectedContract,
 *          skipPostgres (authority-only offline), injectedObserver (offline)
 */
async function executeRenameAliasNormalization(opts) {
  const options = opts || {};
  const gate = evaluateRenameAliasNormalizationGates(options);
  if (!gate.ok) {
    return pickSafe({
      ok: false,
      code: (gate.errors[0] && gate.errors[0].code) || 'gates_rejected',
      sameTarget: false,
      blocker: (gate.errors[0] && gate.errors[0].code) || 'gates_rejected',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      rbacMutation: false,
      networkMutation: false,
      firewallAction: false,
      ...getRenameAliasNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      errors: gate.errors,
      closed: true,
      committed: false,
      rolledBack: false,
    });
  }

  const usedLiveHttp = typeof options.httpRequest !== 'function'
    && PHASE_D_RENAME_ALIAS_NORMALIZATION_LIVE_ENABLED === true
    && PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true;

  const httpRequest = typeof options.httpRequest === 'function'
    ? options.httpRequest
    : (usedLiveHttp ? createLiveTargetAuthorityHttpRequest() : null);

  if (typeof httpRequest !== 'function') {
    return pickSafe({
      ok: false,
      code: 'http_disabled',
      sameTarget: false,
      blocker: 'http_disabled',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      errors: [{ code: 'http_disabled', message: 'inject httpRequest for offline proof' }],
      closed: true,
    });
  }

  // Merged target authority (14Q) without PG — proves sameTarget first.
  const authorityArgv = exactTargetAuthorityArgv();
  const authority = await executeActiveDbTargetAuthority({
    env: {
      ...targetAuthorityEnv(),
      ...(options.env || {}),
      [ENV_TARGET_AUTHORITY]: '1',
    },
    argv: authorityArgv,
    httpRequest,
    skipPostgres: true,
    expectedContract: options.expectedContract,
  });

  if (authority.sameTarget !== true) {
    return pickSafe({
      ok: false,
      code: authority.code || 'mismatched_app_kv_target',
      sameTarget: false,
      sameTargetReason: authority.sameTargetReason || null,
      blocker: authority.blocker || 'mismatched_app_kv_target',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      usedLiveHttp,
      ...getRenameAliasNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      authorityCode: authority.code || null,
      errors: authority.errors || [],
      closed: true,
      committed: false,
      rolledBack: false,
    });
  }

  if (options.skipPostgres === true) {
    return pickSafe({
      ok: true,
      code: 'same_target_authority_ok',
      sameTarget: true,
      sameTargetReason: authority.sameTargetReason || 'same_exact_authority',
      blocker: null,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      usedLiveHttp,
      realPostgresCall: false,
      ...getRenameAliasNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      observerBefore: null,
      observerAfter: null,
      serverVersionClass: null,
      closed: true,
      committed: false,
      rolledBack: false,
      errors: [],
    });
  }

  if (options.injectedObserver) {
    const inj = options.injectedObserver;
    return pickSafe({
      ok: inj.stopReason === 'baseline_drift_mismatch' ? false : true,
      code: inj.code || (inj.stopReason === 'baseline_drift_mismatch'
        ? 'baseline_drift_mismatch'
        : 'rename_alias_normalization_injected'),
      sameTarget: true,
      sameTargetReason: authority.sameTargetReason || 'same_exact_authority',
      blocker: inj.blocker || inj.stopReason || null,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      usedLiveHttp,
      realPostgresCall: false,
      sessionReadOnly: inj.sessionReadOnly !== false,
      transactionReadOnly: inj.transactionReadOnly !== false,
      serverVersionClass: inj.serverVersionClass || null,
      observerBefore: inj.observerBefore || null,
      observerAfter: inj.observerAfter || null,
      baseline: inj.baseline || null,
      baselineMismatchCount: inj.baselineMismatchCount != null
        ? inj.baselineMismatchCount
        : null,
      renameAliasesNormalized: inj.renameAliasesNormalized != null
        ? inj.renameAliasesNormalized
        : null,
      remainingMismatchCount: inj.remainingMismatchCount != null
        ? inj.remainingMismatchCount
        : null,
      remainingKeys: Array.isArray(inj.remainingKeys) ? inj.remainingKeys : [],
      accountingOk: inj.accountingOk === true,
      migration003Sha256: inj.migration003Sha256 || null,
      provenanceCount: inj.provenanceCount != null ? inj.provenanceCount : null,
      productFingerprintLive: inj.productFingerprintLive || null,
      ...getRenameAliasNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      closed: true,
      committed: inj.committed === true,
      rolledBack: inj.rolledBack === true,
      errors: Array.isArray(inj.errors) ? inj.errors : [],
      stopReason: inj.stopReason || null,
    });
  }

  if (!options.expectedContract || !options.expectedContract.snapshot) {
    return pickSafe({
      ok: false,
      code: 'expected_contract_required',
      sameTarget: true,
      blocker: 'expected_contract_required',
      liveMutation: false,
      errors: [{ code: 'expected_contract_required', message: 'expectedContract.snapshot required' }],
      closed: true,
    });
  }

  // Second gated MI credential load for the single observer PG session.
  const loaded = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: options.env || renameAliasNormalizationEnv(),
    argv: options.argv || exactRenameAliasNormalizationArgv(),
    httpRequest,
  });
  if (!loaded.ok) {
    return pickSafe({
      ok: false,
      code: loaded.code || 'credential_load_failed',
      sameTarget: true,
      blocker: loaded.code || 'credential_load_failed',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      usedLiveHttp,
      ...getRenameAliasNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      errors: loaded.errors || [{ code: 'credential_load_failed', message: 'credential load failed' }],
      closed: true,
    });
  }

  const secrets = [];
  let client = null;
  let closed = true;
  let committed = false;
  let rolledBack = false;

  try {
    if (!loaded._user || !loaded._password) {
      zeroPrivateCredentialRefs(loaded);
      return pickSafe({
        ok: false,
        code: 'kv_target_invalid',
        sameTarget: true,
        blocker: 'kv_target_invalid',
        liveMutation: false,
        usedLiveHttp,
        ...getRenameAliasNormalizationCounters(),
        applicationName: APPLICATION_NAME,
        errors: [{ code: 'kv_target_invalid', message: 'credential handoff missing user/password' }],
        closed: true,
      });
    }
    const user = loaded._user;
    const password = loaded._password;
    secrets.push(user, password);
    zeroPrivateCredentialRefs(loaded);

    const ClientFactory = options.ClientFactory || Client;
    const cfg = buildLockedPgClientConfig(user, password);
    clientsInstantiated += 1;
    client = new ClientFactory(cfg);
    try {
      cfg.password = undefined;
      cfg.user = undefined;
    } catch (_) { /* ignore */ }

    closed = false;
    connectCalls += 1;
    await client.connect();
    queryCalls += 1;
    await client.query('BEGIN READ ONLY');

    const obs = await runRenameAliasObserverCompare(client, options.expectedContract);
    if (!obs.sessionReadOnly || !obs.transactionReadOnly) {
      queryCalls += 1;
      try {
        await client.query('ROLLBACK');
        rolledBack = true;
      } catch (_) { /* ignore */ }
      return pickSafe({
        ok: false,
        code: 'session_not_read_only',
        sameTarget: true,
        sameTargetReason: authority.sameTargetReason || 'same_exact_authority',
        blocker: 'session_not_read_only',
        liveMutation: false,
        schemaMutation: false,
        dataMutation: false,
        ledgerWritten: false,
        usedLiveHttp,
        realPostgresCall: true,
        sessionReadOnly: false,
        transactionReadOnly: false,
        serverVersionClass: obs.serverVersionClass,
        observerBefore: obs.observerBefore,
        observerAfter: obs.observerAfter,
        baseline: obs.baseline || null,
        productFingerprintLive: obs.productFingerprintLive,
        ...getRenameAliasNormalizationCounters(),
        applicationName: APPLICATION_NAME,
        errors: obs.errors || [],
        closed: false,
        committed: false,
        rolledBack: true,
      });
    }

    if (obs.stopReason === 'baseline_drift_mismatch') {
      queryCalls += 1;
      try {
        await client.query('ROLLBACK');
        rolledBack = true;
      } catch (_) { /* ignore */ }
      try {
        endCalls += 1;
        await client.end();
        closed = true;
        client = null;
      } catch (_) {
        closed = true;
        client = null;
      }
      return pickSafe({
        ok: false,
        code: 'baseline_drift_mismatch',
        sameTarget: true,
        sameTargetReason: authority.sameTargetReason || 'same_exact_authority',
        blocker: 'baseline_drift_mismatch',
        liveMutation: false,
        schemaMutation: false,
        dataMutation: false,
        ledgerWritten: false,
        usedLiveHttp,
        realPostgresCall: true,
        sessionReadOnly: true,
        transactionReadOnly: true,
        serverVersionClass: obs.serverVersionClass,
        observerBefore: obs.observerBefore,
        observerAfter: null,
        baseline: obs.baseline,
        baselineMismatchCount: obs.baselineMismatchCount,
        renameAliasesNormalized: null,
        remainingMismatchCount: null,
        remainingKeys: [],
        productFingerprintLive: obs.productFingerprintLive,
        ...getRenameAliasNormalizationCounters(),
        applicationName: APPLICATION_NAME,
        errors: obs.errors || [],
        closed: true,
        committed: false,
        rolledBack: true,
        stopReason: 'baseline_drift_mismatch',
      });
    }

    queryCalls += 1;
    await client.query('COMMIT');
    committed = true;

    try {
      endCalls += 1;
      await client.end();
      closed = true;
      client = null;
    } catch (_) {
      closed = true;
      client = null;
    }

    const after = obs.observerAfter || {};
    return pickSafe({
      ok: true,
      code: after.match === true
        ? 'rename_alias_normalization_observer_match'
        : 'rename_alias_normalization_observer_drift',
      sameTarget: true,
      sameTargetReason: authority.sameTargetReason || 'same_exact_authority',
      blocker: after.match === true ? null : 'observer_drift',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      rbacMutation: false,
      networkMutation: false,
      firewallAction: false,
      usedLiveHttp,
      realPostgresCall: true,
      sessionReadOnly: true,
      transactionReadOnly: true,
      serverVersionClass: obs.serverVersionClass,
      observerBefore: obs.observerBefore,
      observerAfter: obs.observerAfter,
      baseline: obs.baseline,
      baselineMismatchCount: obs.baselineMismatchCount,
      renameAliasesNormalized: obs.renameAliasesNormalized,
      remainingMismatchCount: obs.remainingMismatchCount,
      remainingKeys: obs.remainingKeys || [],
      accountingOk: obs.accountingOk === true,
      migration003Sha256: obs.migration003Sha256,
      provenanceCount: obs.provenanceCount,
      productFingerprintLive: obs.productFingerprintLive,
      ...getRenameAliasNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      postgresHost: RENAME_ALIAS_LOCKS.postgresHost,
      database: RENAME_ALIAS_LOCKS.database,
      sslmode: RENAME_ALIAS_LOCKS.sslmode,
      subscriptionId: RENAME_ALIAS_LOCKS.subscriptionId,
      resourceGroup: RENAME_ALIAS_LOCKS.resourceGroup,
      containerAppName: RENAME_ALIAS_LOCKS.containerAppName,
      managedIdentityName: RENAME_ALIAS_LOCKS.managedIdentityName,
      keyVaultName: RENAME_ALIAS_LOCKS.keyVaultName,
      kvSecretName: RENAME_ALIAS_LOCKS.secretName,
      errors: [],
      closed: true,
      committed: true,
      rolledBack: false,
    });
  } catch (e) {
    if (client && !closed) {
      try {
        await client.query('ROLLBACK');
        rolledBack = true;
      } catch (_) { /* ignore */ }
      try {
        endCalls += 1;
        await client.end();
      } catch (_) { /* ignore */ }
      closed = true;
    }
    return pickSafe({
      ok: false,
      code: e.code || 'rename_alias_normalization_failed',
      sameTarget: true,
      blocker: e.code || 'rename_alias_normalization_failed',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      usedLiveHttp,
      ...getRenameAliasNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      errors: [{
        code: e.code || 'rename_alias_normalization_failed',
        message: String(e.message || 'failed').slice(0, 240),
      }],
      closed: true,
      committed,
      rolledBack,
    });
  } finally {
    zeroPrivateCredentialRefs({ _secretValue: null, _dsn: null });
  }
}

function createScriptedRenameAliasFakeClientFactory(script) {
  const s = script || {};
  function FakeClient() {
    this._ended = false;
    this.connect = async () => {};
    this.end = async () => {
      this._ended = true;
    };
    this.query = async (sql) => {
      const q = String(sql || '');
      if (/^BEGIN\b/i.test(q)) return { rows: [] };
      if (/^COMMIT\b/i.test(q)) return { rows: [] };
      if (/^ROLLBACK\b/i.test(q)) return { rows: [] };
      if (/application_name/i.test(q)) {
        return { rows: [{ application_name: APPLICATION_NAME }] };
      }
      if (/transaction_read_only/i.test(q)) {
        return { rows: [{ transaction_read_only: 'on' }] };
      }
      if (/statement_timeout/i.test(q)) {
        return { rows: [{ statement_timeout: '30s' }] };
      }
      if (/lock_timeout/i.test(q)) {
        return { rows: [{ lock_timeout: '5s' }] };
      }
      if (/server_version_num/i.test(q)) {
        return { rows: [{ server_version_num: s.serverVersionNum || '150005' }] };
      }
      if (/server_version/i.test(q)) {
        return { rows: [{ server_version: s.serverVersion || '15.5' }] };
      }
      if (s.introspectionHandler) return s.introspectionHandler(q);
      return { rows: s.introspectionRows || [] };
    };
  }
  return FakeClient;
}

function printCliHelp() {
  return [
    'phase-d:rename-alias-normalization — FOUNDATION Slice 14V',
    'DEFAULT: refused (zero ARM / zero KV / zero PostgreSQL).',
    '',
    'Merged target-authority + one read-only observer session proving',
    'migration 003 hostel_id→client_id NOT NULL rename-alias normalization',
    'under azure_flexible_server_v1 + postgresql_15.',
    'Requires dual Phase D flags + TARGET_AUTHORITY + RENAME_ALIAS_NORMALIZATION',
    '+ managed-identity + exact locked targets.',
    '',
    'Baseline must be exactly 35 post-14T residuals (rename alias off).',
    'Never prints/persists DSN, passwords, tokens, or secret versions.',
    'Zero mutation.',
  ].join('\n');
}

module.exports = {
  PHASE_D_RENAME_ALIAS_NORMALIZATION_LIVE_ENABLED,
  ENV_RENAME_ALIAS_NORMALIZATION,
  CLI_PROVE_RENAME_ALIAS_NORMALIZATION,
  APPLICATION_NAME,
  RENAME_ALIAS_LOCKS,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  evaluateRenameAliasNormalizationGates,
  exactRenameAliasNormalizationArgv,
  renameAliasNormalizationEnv,
  executeRenameAliasNormalization,
  createScriptedRenameAliasFakeClientFactory,
  createInjectedTargetAuthorityHttp,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetRenameAliasNormalizationCounters,
  getRenameAliasNormalizationCounters,
  evaluateTargetAuthorityGates,
  printCliHelp,
  groupMismatchSections,
  summarizeCompare,
  assertBaselineMismatch,
  remainingMismatchKeys,
};
