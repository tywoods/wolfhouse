'use strict';

/**
 * FOUNDATION Slice 14T — NOT NULL observer representation normalization
 *
 * Merged target-authority proof (14Q skipPostgres) + exactly one TLS
 * verify-full read-only observer session
 * (application_name=wh-sunset-not-null-normalization) that reports:
 *   - safe server_version class
 *   - raw mismatch counts (identity norm only; NOT NULL constraints retained)
 *   - normalized mismatch counts (identity + NOT NULL↔attnotnull)
 *   - number of NOT NULL constraint artifacts normalized
 *
 * Zero mutation: no DDL/DML/ledger/KV write/Azure/RBAC/network/deploy.
 * Default-disabled behind exact env+argv gates.
 */

const { Client } = require('pg');
const {
  TARGETS,
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
  MI_LOADER_LOCKS,
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  buildOfflineProofSunsetDatabaseUrl,
  loadProtectedAdminCredentialsViaManagedIdentity,
  zeroPrivateCredentialRefs,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
  createInjectedManagedIdentityHttp,
  parseSunsetDatabaseUrlSecretInMemory,
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
} = require('./sunset-schema-observer');

/** Live capability activated for Slice 14T behind exact env+argv gates. */
const PHASE_D_NOT_NULL_NORMALIZATION_LIVE_ENABLED = true;

const ENV_NOT_NULL_NORMALIZATION = 'SUNSET_PHASE_D_NOT_NULL_NORMALIZATION';
const CLI_PROVE_NOT_NULL_NORMALIZATION = '--prove-not-null-normalization';
const APPLICATION_NAME = 'wh-sunset-not-null-normalization';

const NOT_NULL_LOCKS = Object.freeze({
  ...AUTHORITY_LOCKS,
  applicationName: APPLICATION_NAME,
});

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_PROVE_NOT_NULL_NORMALIZATION,
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

function resetNotNullNormalizationCounters() {
  clientsInstantiated = 0;
  connectCalls = 0;
  queryCalls = 0;
  endCalls = 0;
  resetTargetAuthorityCounters();
  resetManagedIdentityHttpCounters();
}

function getNotNullNormalizationCounters() {
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
    if (a === CLI_PROVE_NOT_NULL_NORMALIZATION
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

function exactNotNullNormalizationArgv() {
  return [
    CLI_PROVE_NOT_NULL_NORMALIZATION,
    CLI_PROVE_TARGET_AUTHORITY,
    '--subscription', NOT_NULL_LOCKS.subscriptionId,
    '--resource-group', NOT_NULL_LOCKS.resourceGroup,
    '--container-app', NOT_NULL_LOCKS.containerAppName,
    '--postgres-server', NOT_NULL_LOCKS.postgresServer,
    '--database', NOT_NULL_LOCKS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function notNullNormalizationEnv() {
  return {
    ...targetAuthorityEnv(),
    [ENV_NOT_NULL_NORMALIZATION]: '1',
  };
}

function evaluateNotNullNormalizationGates(opts) {
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
  if (PHASE_D_NOT_NULL_NORMALIZATION_LIVE_ENABLED !== true) {
    errors.push({ code: 'not_null_normalization_capability_disabled', message: 'not-null normalization live disabled' });
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
  if (String(env[ENV_NOT_NULL_NORMALIZATION] || '') !== '1') {
    errors.push({ code: 'not_null_normalization_env_required', message: `${ENV_NOT_NULL_NORMALIZATION}=1 required` });
  }
  if (String(env[ENV_SUBSCRIPTION] || '') !== NOT_NULL_LOCKS.subscriptionId) {
    errors.push({ code: 'subscription_env_mismatch', message: 'AZURE_SUBSCRIPTION_ID must match locked subscription' });
  }
  if (String(env[ENV_CREDENTIAL_SOURCE] || '') !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `env ${ENV_CREDENTIAL_SOURCE}=managed-identity required`,
    });
  }
  if (!parsed.flags.has(CLI_PROVE_NOT_NULL_NORMALIZATION)) {
    errors.push({
      code: 'not_null_normalization_flag_required',
      message: `${CLI_PROVE_NOT_NULL_NORMALIZATION} required`,
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
    '--subscription': NOT_NULL_LOCKS.subscriptionId,
    '--resource-group': NOT_NULL_LOCKS.resourceGroup,
    '--container-app': NOT_NULL_LOCKS.containerAppName,
    '--postgres-server': NOT_NULL_LOCKS.postgresServer,
    '--database': NOT_NULL_LOCKS.database,
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
    host: NOT_NULL_LOCKS.postgresHost,
    port: NOT_NULL_LOCKS.port,
    database: NOT_NULL_LOCKS.database,
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

function summarizeCompare(cmp) {
  if (cmp.normalizationError) {
    return {
      ok: false,
      match: false,
      code: cmp.normalizationError.code || 'normalization_failed',
      mismatchCount: null,
      counts: cmp.counts || null,
      mismatchSections: null,
      notNullArtifactsNormalized: null,
      normalizationError: {
        code: cmp.normalizationError.code,
        message: String(cmp.normalizationError.message || '').slice(0, 240),
      },
    };
  }
  const mismatchCount = Array.isArray(cmp.drifts) ? cmp.drifts.length : (
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
    mismatchSections: groupMismatchSections(cmp.drifts),
    notNullArtifactsNormalized: cmp.notNullNormalization
      ? Number(cmp.notNullNormalization.normalizedCount) || 0
      : 0,
    normalizationError: null,
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

async function verifyNotNullSession(client) {
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

async function runNotNullObserverCompare(client, expectedContract) {
  const session = await verifyNotNullSession(client);
  if (!session.ok) {
    return {
      sessionReadOnly: false,
      transactionReadOnly: false,
      serverVersionClass: null,
      observerBefore: null,
      observerAfter: null,
      productFingerprintLive: null,
      errors: session.errors,
    };
  }

  const serverVersionClass = await captureServerVersionClass(client);
  const product = await introspectProductSchema(client);
  queryCalls += Array.isArray(product.usedAllowlist) ? product.usedAllowlist.length : 20;
  const productFingerprintLive = fingerprintProductSchema(product.snapshot);
  const azureContext = {
    verified: true,
    host: EXPECTED_HOST,
    database: EXPECTED_DATABASE,
  };

  const rawCmp = compareSnapshots(expectedContract.snapshot, product.snapshot, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext,
    disableNotNullConstraintNormalization: true,
  });
  const normCmp = compareSnapshots(expectedContract.snapshot, product.snapshot, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext,
  });

  return {
    sessionReadOnly: true,
    transactionReadOnly: String(session.show.transaction_read_only).toLowerCase() === 'on',
    serverVersionClass,
    observerBefore: summarizeCompare(rawCmp),
    observerAfter: summarizeCompare(normCmp),
    productFingerprintLive,
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
async function executeNotNullObserverNormalization(opts) {
  const options = opts || {};
  const gate = evaluateNotNullNormalizationGates(options);
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
      ...getNotNullNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      errors: gate.errors,
      closed: true,
      committed: false,
      rolledBack: false,
    });
  }

  const usedLiveHttp = typeof options.httpRequest !== 'function'
    && PHASE_D_NOT_NULL_NORMALIZATION_LIVE_ENABLED === true
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
      ...getNotNullNormalizationCounters(),
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
      ...getNotNullNormalizationCounters(),
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
      ok: true,
      code: inj.code || 'not_null_normalization_injected',
      sameTarget: true,
      sameTargetReason: authority.sameTargetReason || 'same_exact_authority',
      blocker: inj.blocker || null,
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
      productFingerprintLive: inj.productFingerprintLive || null,
      ...getNotNullNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      closed: true,
      committed: inj.committed === true,
      rolledBack: inj.rolledBack === true,
      errors: [],
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
    env: options.env || notNullNormalizationEnv(),
    argv: options.argv || exactNotNullNormalizationArgv(),
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
      ...getNotNullNormalizationCounters(),
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
        ...getNotNullNormalizationCounters(),
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

    const obs = await runNotNullObserverCompare(client, options.expectedContract);
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
        productFingerprintLive: obs.productFingerprintLive,
        ...getNotNullNormalizationCounters(),
        applicationName: APPLICATION_NAME,
        errors: obs.errors || [],
        closed: false,
        committed: false,
        rolledBack: true,
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
        ? 'not_null_normalization_observer_match'
        : 'not_null_normalization_observer_drift',
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
      productFingerprintLive: obs.productFingerprintLive,
      ...getNotNullNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      postgresHost: NOT_NULL_LOCKS.postgresHost,
      database: NOT_NULL_LOCKS.database,
      sslmode: NOT_NULL_LOCKS.sslmode,
      subscriptionId: NOT_NULL_LOCKS.subscriptionId,
      resourceGroup: NOT_NULL_LOCKS.resourceGroup,
      containerAppName: NOT_NULL_LOCKS.containerAppName,
      managedIdentityName: NOT_NULL_LOCKS.managedIdentityName,
      keyVaultName: NOT_NULL_LOCKS.keyVaultName,
      kvSecretName: NOT_NULL_LOCKS.secretName,
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
      code: e.code || 'not_null_normalization_failed',
      sameTarget: true,
      blocker: e.code || 'not_null_normalization_failed',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      usedLiveHttp,
      ...getNotNullNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      errors: [{
        code: e.code || 'not_null_normalization_failed',
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

function createScriptedNotNullFakeClientFactory(script) {
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
        return { rows: [{ server_version_num: s.serverVersionNum || '160001' }] };
      }
      if (/server_version/i.test(q)) {
        return { rows: [{ server_version: s.serverVersion || '16.1' }] };
      }
      // Introspection fallbacks — empty product schema unless scripted rows provided.
      if (s.introspectionHandler) return s.introspectionHandler(q);
      return { rows: s.introspectionRows || [] };
    };
  }
  return FakeClient;
}

function printCliHelp() {
  return [
    'phase-d:not-null-observer-normalization — FOUNDATION Slice 14T',
    'DEFAULT: refused (zero ARM / zero KV / zero PostgreSQL).',
    '',
    'Merged target-authority + one read-only observer session proving NOT NULL',
    'constraint↔attnotnull normalization under azure_flexible_server_v1.',
    'Requires dual Phase D flags + TARGET_AUTHORITY + NOT_NULL_NORMALIZATION',
    '+ managed-identity + exact locked targets.',
    '',
    'Never prints/persists DSN, passwords, tokens, or secret versions.',
    'Zero mutation.',
  ].join('\n');
}

module.exports = {
  PHASE_D_NOT_NULL_NORMALIZATION_LIVE_ENABLED,
  ENV_NOT_NULL_NORMALIZATION,
  CLI_PROVE_NOT_NULL_NORMALIZATION,
  APPLICATION_NAME,
  NOT_NULL_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  evaluateNotNullNormalizationGates,
  exactNotNullNormalizationArgv,
  notNullNormalizationEnv,
  executeNotNullObserverNormalization,
  createScriptedNotNullFakeClientFactory,
  createInjectedTargetAuthorityHttp,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetNotNullNormalizationCounters,
  getNotNullNormalizationCounters,
  evaluateTargetAuthorityGates,
  printCliHelp,
  groupMismatchSections,
  summarizeCompare,
};
