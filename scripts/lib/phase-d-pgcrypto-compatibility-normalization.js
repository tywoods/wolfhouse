'use strict';

/**
 * FOUNDATION Slice 14AB — Azure PG15 pgcrypto 1.3 presentation normalization
 *
 * Merged target-authority proof + exactly one TLS verify-full read-only observer
 * session (application_name=wh-sunset-pgcrypto-compatibility) that reports:
 *   - safe server_version class (PG15 required)
 *   - baseline mismatch counts (identity + 14T + 14V + 14W + 14X; pgcrypto off)
 *   - after mismatch counts (same + pgcrypto compatibility normalization)
 *   - number of pgcrypto/fips_mode artifacts normalized
 *   - remaining mismatch key inventory
 *
 * Requires baseline mismatchCount === 4 (post-14AA residual) or stops with
 * baseline_drift_mismatch.
 *
 * Zero mutation: no DDL/DML/ledger/KV write/Azure/RBAC/network/deploy.
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
  normalizeSql,
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
  buildIdentifierTruncationNotNullProvenance,
  PGCRYPTO_LIVE_VERSION,
  PGCRYPTO_REQUIRED_CAPABILITIES,
} = require('./sunset-schema-observer');

const FORBIDDEN_SQL_VERBS = Object.freeze([
  /\bBEGIN\b/i,
  /\bCOMMIT\b/i,
  /\bROLLBACK\b/i,
  /\bSAVEPOINT\b/i,
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bALTER\b/i,
  /\bCREATE\b/i,
  /\bTRUNCATE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bCOPY\b/i,
  /\bVACUUM\b/i,
  /\bREINDEX\b/i,
  /\bCLUSTER\b/i,
  /\bREFRESH\b/i,
  /\bCALL\b/i,
  /\bDO\b/i,
  /\bSET\b/i,
  /\bRESET\b/i,
  /\bLOCK\b/i,
  /\bDISCARD\b/i,
  /\bLISTEN\b/i,
  /\bNOTIFY\b/i,
  /\bUNLISTEN\b/i,
  /\bPREPARE\b/i,
  /\bEXECUTE\b/i,
  /\bDEALLOCATE\b/i,
]);

const PHASE_D_PGCRYPTO_COMPATIBILITY_NORMALIZATION_LIVE_ENABLED = true;

const ENV_PGCRYPTO_COMPATIBILITY_NORMALIZATION = 'SUNSET_PHASE_D_PGCRYPTO_COMPATIBILITY_NORMALIZATION';
const CLI_PROVE_PGCRYPTO_COMPATIBILITY_NORMALIZATION = '--prove-pgcrypto-compatibility-normalization';
const APPLICATION_NAME = 'wh-sunset-pgcrypto-compatibility';

const BASELINE_MISMATCH_COUNT = 4;
const BASELINE_MISMATCH_SECTIONS = Object.freeze({
  functions: 1,
  ownership: 1,
  acls: 1,
  extensions: 1,
});

const PGCRYPTO_LOCKS = Object.freeze({
  ...AUTHORITY_LOCKS,
  applicationName: APPLICATION_NAME,
});

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_PROVE_PGCRYPTO_COMPATIBILITY_NORMALIZATION,
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

const PGCRYPTO_AVAILABLE_EXTENSIONS_SQL = [
  'SELECT name, default_version, installed_version',
  'FROM pg_catalog.pg_available_extensions',
  "WHERE name = 'pgcrypto'",
].join(' ');

const PGCRYPTO_AVAILABLE_VERSIONS_SQL = [
  'SELECT name, version, installed, relocatable, schema',
  'FROM pg_catalog.pg_available_extension_versions',
  "WHERE name = 'pgcrypto'",
  'ORDER BY version',
].join(' ');

const PGCRYPTO_UPDATE_PATHS_SQL = "SELECT * FROM pg_extension_update_paths('pgcrypto')";

const PGCRYPTO_CAPABILITY_MEMBERSHIP_SQL = [
  "SELECT n.nspname || '.' || p.proname || '('",
  '|| pg_catalog.pg_get_function_identity_arguments(p.oid) || \')\' AS identity,',
  '       e.extname,',
  '       pg_catalog.pg_get_function_result(p.oid) AS return_type,',
  '       l.lanname AS language',
  'FROM pg_catalog.pg_proc p',
  'JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace',
  'JOIN pg_catalog.pg_language l ON l.oid = p.prolang',
  "LEFT JOIN pg_catalog.pg_depend d ON d.objid = p.oid AND d.deptype = 'e'",
  'LEFT JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid',
  "WHERE n.nspname = 'public' AND p.proname IN ('gen_random_uuid', 'fips_mode')",
].join(' ');

const PGCRYPTO_MEMBER_FUNCTIONS_SQL = [
  "SELECT n.nspname || '.' || p.proname || '('",
  '|| pg_catalog.pg_get_function_identity_arguments(p.oid) || \')\' AS identity',
  'FROM pg_catalog.pg_proc p',
  'JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace',
  "JOIN pg_catalog.pg_depend d ON d.objid = p.oid AND d.deptype = 'e'",
  'JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid',
  "WHERE e.extname = 'pgcrypto' AND n.nspname = 'public'",
  'ORDER BY 1',
].join(' ');

let clientsInstantiated = 0;
let connectCalls = 0;
let queryCalls = 0;
let endCalls = 0;

function resetPgcryptoCompatibilityNormalizationCounters() {
  clientsInstantiated = 0;
  connectCalls = 0;
  queryCalls = 0;
  endCalls = 0;
  resetTargetAuthorityCounters();
  resetManagedIdentityHttpCounters();
}

function getPgcryptoCompatibilityNormalizationCounters() {
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

function assertSelectOnlySql(sql) {
  const raw = String(sql || '');
  if (/--|\/\*|\*\//.test(raw)) {
    return { ok: false, code: 'sql_comments_rejected', message: 'SQL comments are not allowed' };
  }
  const body = raw.trim().replace(/;+\s*$/, '');
  if (body.includes(';')) {
    return { ok: false, code: 'stacked_sql_rejected', message: 'stacked SQL statements are not allowed' };
  }
  for (const bad of FORBIDDEN_SQL_VERBS) {
    if (bad.test(body)) {
      return { ok: false, code: 'forbidden_sql', message: 'SQL contains forbidden verb or transaction control' };
    }
  }
  const norm = normalizeSql(body);
  if (!norm) return { ok: false, code: 'sql_empty', message: 'empty SQL' };
  if (!/^\s*SELECT\b/i.test(body)) {
    return { ok: false, code: 'not_select', message: 'only SELECT allowed' };
  }
  return { ok: true };
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
    if (a === CLI_PROVE_PGCRYPTO_COMPATIBILITY_NORMALIZATION
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

function exactPgcryptoCompatibilityNormalizationArgv() {
  return [
    CLI_PROVE_PGCRYPTO_COMPATIBILITY_NORMALIZATION,
    CLI_PROVE_TARGET_AUTHORITY,
    '--subscription', PGCRYPTO_LOCKS.subscriptionId,
    '--resource-group', PGCRYPTO_LOCKS.resourceGroup,
    '--container-app', PGCRYPTO_LOCKS.containerAppName,
    '--postgres-server', PGCRYPTO_LOCKS.postgresServer,
    '--database', PGCRYPTO_LOCKS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function pgcryptoCompatibilityNormalizationEnv() {
  return {
    ...targetAuthorityEnv(),
    [ENV_PGCRYPTO_COMPATIBILITY_NORMALIZATION]: '1',
  };
}

function evaluatePgcryptoCompatibilityNormalizationGates(opts) {
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
  if (PHASE_D_PGCRYPTO_COMPATIBILITY_NORMALIZATION_LIVE_ENABLED !== true) {
    errors.push({ code: 'pgcrypto_compatibility_normalization_capability_disabled', message: 'pgcrypto normalization live disabled' });
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
  if (String(env[ENV_PGCRYPTO_COMPATIBILITY_NORMALIZATION] || '') !== '1') {
    errors.push({
      code: 'pgcrypto_compatibility_normalization_env_required',
      message: `${ENV_PGCRYPTO_COMPATIBILITY_NORMALIZATION}=1 required`,
    });
  }
  if (String(env[ENV_SUBSCRIPTION] || '') !== PGCRYPTO_LOCKS.subscriptionId) {
    errors.push({ code: 'subscription_env_mismatch', message: 'AZURE_SUBSCRIPTION_ID must match locked subscription' });
  }
  if (String(env[ENV_CREDENTIAL_SOURCE] || '') !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `env ${ENV_CREDENTIAL_SOURCE}=managed-identity required`,
    });
  }
  if (!parsed.flags.has(CLI_PROVE_PGCRYPTO_COMPATIBILITY_NORMALIZATION)) {
    errors.push({
      code: 'pgcrypto_compatibility_normalization_flag_required',
      message: `${CLI_PROVE_PGCRYPTO_COMPATIBILITY_NORMALIZATION} required`,
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
    '--subscription': PGCRYPTO_LOCKS.subscriptionId,
    '--resource-group': PGCRYPTO_LOCKS.resourceGroup,
    '--container-app': PGCRYPTO_LOCKS.containerAppName,
    '--postgres-server': PGCRYPTO_LOCKS.postgresServer,
    '--database': PGCRYPTO_LOCKS.database,
  };
  for (const [flag, want] of Object.entries(expect)) {
    if (String(parsed.values[flag] || '') !== want) {
      errors.push({ code: 'exact_target_mismatch', message: `${flag} must equal locked ${want}` });
    }
  }

  return { ok: errors.length === 0, errors, parsed };
}

function buildLockedPgcryptoPgClientConfig(user, password) {
  return {
    host: PGCRYPTO_LOCKS.postgresHost,
    port: PGCRYPTO_LOCKS.port,
    database: PGCRYPTO_LOCKS.database,
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
      pgcryptoCompatibilitiesNormalized: null,
      pgcryptoCompatibilityNormalization: null,
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
  const pgcryptoCompatibilitiesNormalized = cmp.pgcryptoCompatibilityNormalization
    ? Number(cmp.pgcryptoCompatibilityNormalization.normalizedCount) || 0
    : 0;
  return {
    ok: cmp.ok === true,
    match: cmp.ok === true,
    code: cmp.ok === true ? 'observer_match' : 'observer_drift',
    mismatchCount,
    counts: cmp.counts,
    mismatchSections: groupMismatchSections(drifts),
    remainingKeys: remainingMismatchKeys(drifts),
    pgcryptoCompatibilitiesNormalized,
    pgcryptoCompatibilityNormalization: cmp.pgcryptoCompatibilityNormalization
      ? {
        applied: cmp.pgcryptoCompatibilityNormalization.applied === true,
        normalizedCount: pgcryptoCompatibilitiesNormalized,
        reason: cmp.pgcryptoCompatibilityNormalization.reason || null,
        versionPair: cmp.pgcryptoCompatibilityNormalization.versionPair || null,
        capabilityProof: cmp.pgcryptoCompatibilityNormalization.capabilityProof || null,
      }
      : null,
    normalizationError: null,
  };
}

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

async function safeSelect(client, sql) {
  const gate = assertSelectOnlySql(sql);
  if (!gate.ok) {
    throw Object.assign(new Error(gate.message), { code: gate.code });
  }
  queryCalls += 1;
  const res = await client.query(sql);
  return Array.isArray(res.rows) ? res.rows : [];
}

async function verifyPgcryptoCompatibilitySession(client) {
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

function buildOfflinePgcryptoLiveProfile(liveSnap, opts) {
  const options = opts || {};
  const snap = liveSnap || {};
  const liveExt = (snap.extensions || []).find((e) => e.name === 'pgcrypto') || {};
  const memberFunctions = (snap.functions || [])
    .filter((f) => String(f.definition || '').includes('$libdir/pgcrypto'))
    .map((f) => String(f.identity || ''))
    .filter(Boolean)
    .sort();
  const capabilityMembership = {};
  for (const cap of PGCRYPTO_REQUIRED_CAPABILITIES) {
    const fn = (snap.functions || []).find((f) => f.identity === cap.identity);
    if (fn) {
      capabilityMembership[cap.identity] = {
        extname: 'pgcrypto',
        returnType: fn.returnType,
        language: fn.language,
      };
    }
  }
  const fipsFn = (snap.functions || []).find((f) => f.identity === 'public.fips_mode()');
  const fipsOwn = (snap.ownership || []).find(
    (o) => o.kind === 'function' && o.identity === 'public.fips_mode()',
  );
  const fipsAcl = (snap.acls || []).find(
    (a) => a.kind === 'function' && a.identity === 'public.fips_mode()',
  );
  return {
    installed: {
      extversion: liveExt.version || PGCRYPTO_LIVE_VERSION,
      schema: liveExt.schema || 'public',
      owner: liveExt.owner || '$db_owner',
      relocatable: liveExt.relocatable !== false,
    },
    availableExtensions: {
      name: 'pgcrypto',
      default_version: options.defaultVersion || PGCRYPTO_LIVE_VERSION,
      installed_version: liveExt.version || PGCRYPTO_LIVE_VERSION,
    },
    availableVersions: Array.isArray(options.availableVersions)
      ? options.availableVersions
      : [{
        name: 'pgcrypto',
        version: PGCRYPTO_LIVE_VERSION,
        installed: true,
        relocatable: true,
        schema: 'public',
      }],
    updatePaths: options.updatePaths != null ? options.updatePaths : null,
    updatePathsNote: options.updatePathsNote || 'offline_fixture',
    fipsMode: {
      present: Boolean(fipsFn || fipsOwn || fipsAcl),
      functions: fipsFn || null,
      ownership: fipsOwn || null,
      acls: fipsAcl || null,
    },
    capabilityMembership,
    memberFunctions,
  };
}

async function captureAzurePg15PgcryptoLiveProfile(client, liveSnapshot) {
  const snap = liveSnapshot || {};
  const liveExt = (snap.extensions || []).find((e) => e.name === 'pgcrypto') || {};
  const availableExtRows = await safeSelect(client, PGCRYPTO_AVAILABLE_EXTENSIONS_SQL);
  const availableVersions = await safeSelect(client, PGCRYPTO_AVAILABLE_VERSIONS_SQL);
  let updatePaths = null;
  let updatePathsNote = null;
  try {
    updatePaths = await safeSelect(client, PGCRYPTO_UPDATE_PATHS_SQL);
  } catch (e) {
    updatePaths = null;
    updatePathsNote = String(e.code || e.message || 'update_paths_unavailable').slice(0, 120);
  }
  const capabilityRows = await safeSelect(client, PGCRYPTO_CAPABILITY_MEMBERSHIP_SQL);
  const memberRows = await safeSelect(client, PGCRYPTO_MEMBER_FUNCTIONS_SQL);
  const capabilityMembership = {};
  for (const row of capabilityRows) {
    capabilityMembership[String(row.identity || '')] = {
      extname: row.extname || null,
      returnType: row.return_type || null,
      language: row.language || null,
    };
  }
  const memberFunctions = memberRows
    .map((r) => String(r.identity || ''))
    .filter(Boolean)
    .sort();
  const fipsFn = (snap.functions || []).find((f) => f.identity === 'public.fips_mode()');
  const fipsOwn = (snap.ownership || []).find(
    (o) => o.kind === 'function' && o.identity === 'public.fips_mode()',
  );
  const fipsAcl = (snap.acls || []).find(
    (a) => a.kind === 'function' && a.identity === 'public.fips_mode()',
  );
  return {
    installed: {
      extversion: liveExt.version || null,
      schema: liveExt.schema || null,
      owner: liveExt.owner || null,
      relocatable: liveExt.relocatable != null ? liveExt.relocatable : null,
    },
    availableExtensions: availableExtRows[0] || null,
    availableVersions,
    updatePaths,
    updatePathsNote,
    fipsMode: {
      present: Boolean(fipsFn || fipsOwn || fipsAcl),
      functions: fipsFn || null,
      ownership: fipsOwn || null,
      acls: fipsAcl || null,
    },
    capabilityMembership,
    memberFunctions,
  };
}

function buildObserverCompareOptions(azureContext, versionClass, identifierTruncationProvenance, extra) {
  return {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext,
    serverVersionClass: versionClass,
    enableFinalRenameNormalization: true,
    enableIdentifierTruncationNormalization: true,
    identifierTruncationProvenance,
    ...(extra || {}),
  };
}

async function runPgcryptoCompatibilityObserverCompare(client, expectedContract) {
  const session = await verifyPgcryptoCompatibilitySession(client);
  if (!session.ok) {
    return {
      sessionReadOnly: false,
      transactionReadOnly: false,
      serverVersionClass: null,
      observerBefore: null,
      observerAfter: null,
      baseline: null,
      baselineMismatchCount: null,
      pgcryptoCompatibilitiesNormalized: null,
      remainingMismatchCount: null,
      remainingKeys: [],
      liveProfile: null,
      productFingerprintLive: null,
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

  const builtProvenance = buildIdentifierTruncationNotNullProvenance();
  const identifierTruncationProvenance = builtProvenance && builtProvenance.ok === true
    ? builtProvenance
    : null;

  const rawCmp = compareSnapshots(
    expectedContract.snapshot,
    product.snapshot,
    buildObserverCompareOptions(azureContext, versionClass, identifierTruncationProvenance),
  );
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
      pgcryptoCompatibilitiesNormalized: null,
      remainingMismatchCount: null,
      remainingKeys: [],
      liveProfile: null,
      productFingerprintLive,
      errors: [{ code: 'baseline_drift_mismatch', message: baseline.message }],
      stopReason: 'baseline_drift_mismatch',
    };
  }

  const liveProfile = await captureAzurePg15PgcryptoLiveProfile(client, product.snapshot);
  const normCmp = compareSnapshots(
    expectedContract.snapshot,
    product.snapshot,
    buildObserverCompareOptions(azureContext, versionClass, identifierTruncationProvenance, {
      enablePgcryptoCompatibilityNormalization: true,
      liveProfile,
    }),
  );
  const observerAfter = summarizeCompare(normCmp);
  const pgcryptoCompatibilitiesNormalized = observerAfter.pgcryptoCompatibilitiesNormalized != null
    ? observerAfter.pgcryptoCompatibilitiesNormalized
    : 0;
  const remainingMismatchCount = observerAfter.mismatchCount != null
    ? observerAfter.mismatchCount
    : null;
  const remainingKeys = observerAfter.remainingKeys || [];

  return {
    sessionReadOnly: true,
    transactionReadOnly: String(session.show.transaction_read_only).toLowerCase() === 'on',
    serverVersionClass,
    observerBefore,
    observerAfter,
    baseline,
    baselineMismatchCount: BASELINE_MISMATCH_COUNT,
    pgcryptoCompatibilitiesNormalized,
    remainingMismatchCount,
    remainingKeys,
    accountingOk: BASELINE_MISMATCH_COUNT === pgcryptoCompatibilitiesNormalized + remainingMismatchCount,
    liveProfile,
    productFingerprintLive,
    errors: [],
  };
}

function pickSafe(result) {
  return redactDeep(result, []);
}

async function executePgcryptoCompatibilityNormalization(opts) {
  const options = opts || {};
  const gate = evaluatePgcryptoCompatibilityNormalizationGates(options);
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
      ...getPgcryptoCompatibilityNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      errors: gate.errors,
      closed: true,
      committed: false,
      rolledBack: false,
    });
  }

  const usedLiveHttp = typeof options.httpRequest !== 'function'
    && PHASE_D_PGCRYPTO_COMPATIBILITY_NORMALIZATION_LIVE_ENABLED === true
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

  const authority = await executeActiveDbTargetAuthority({
    env: {
      ...targetAuthorityEnv(),
      ...(options.env || {}),
      [ENV_TARGET_AUTHORITY]: '1',
    },
    argv: exactTargetAuthorityArgv(),
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
      ...getPgcryptoCompatibilityNormalizationCounters(),
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
      ...getPgcryptoCompatibilityNormalizationCounters(),
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
        : 'pgcrypto_compatibility_normalization_injected'),
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
      pgcryptoCompatibilitiesNormalized: inj.pgcryptoCompatibilitiesNormalized != null
        ? inj.pgcryptoCompatibilitiesNormalized
        : null,
      remainingMismatchCount: inj.remainingMismatchCount != null
        ? inj.remainingMismatchCount
        : null,
      remainingKeys: Array.isArray(inj.remainingKeys) ? inj.remainingKeys : [],
      accountingOk: inj.accountingOk === true,
      liveProfile: inj.liveProfile || null,
      productFingerprintLive: inj.productFingerprintLive || null,
      ...getPgcryptoCompatibilityNormalizationCounters(),
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

  const loaded = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: options.env || pgcryptoCompatibilityNormalizationEnv(),
    argv: options.argv || exactPgcryptoCompatibilityNormalizationArgv(),
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
      ...getPgcryptoCompatibilityNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      errors: loaded.errors || [{ code: 'credential_load_failed', message: 'credential load failed' }],
      closed: true,
    });
  }

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
        ...getPgcryptoCompatibilityNormalizationCounters(),
        applicationName: APPLICATION_NAME,
        errors: [{ code: 'kv_target_invalid', message: 'credential handoff missing user/password' }],
        closed: true,
      });
    }
    const user = loaded._user;
    const password = loaded._password;
    zeroPrivateCredentialRefs(loaded);

    const ClientFactory = options.ClientFactory || Client;
    const cfg = buildLockedPgcryptoPgClientConfig(user, password);
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

    const obs = await runPgcryptoCompatibilityObserverCompare(client, options.expectedContract);
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
        ...getPgcryptoCompatibilityNormalizationCounters(),
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
        pgcryptoCompatibilitiesNormalized: null,
        remainingMismatchCount: null,
        remainingKeys: [],
        productFingerprintLive: obs.productFingerprintLive,
        ...getPgcryptoCompatibilityNormalizationCounters(),
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
        ? 'pgcrypto_compatibility_normalization_observer_match'
        : 'pgcrypto_compatibility_normalization_observer_drift',
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
      pgcryptoCompatibilitiesNormalized: obs.pgcryptoCompatibilitiesNormalized,
      remainingMismatchCount: obs.remainingMismatchCount,
      remainingKeys: obs.remainingKeys || [],
      accountingOk: obs.accountingOk === true,
      liveProfile: obs.liveProfile,
      productFingerprintLive: obs.productFingerprintLive,
      ...getPgcryptoCompatibilityNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      postgresHost: PGCRYPTO_LOCKS.postgresHost,
      database: PGCRYPTO_LOCKS.database,
      sslmode: PGCRYPTO_LOCKS.sslmode,
      subscriptionId: PGCRYPTO_LOCKS.subscriptionId,
      resourceGroup: PGCRYPTO_LOCKS.resourceGroup,
      containerAppName: PGCRYPTO_LOCKS.containerAppName,
      managedIdentityName: PGCRYPTO_LOCKS.managedIdentityName,
      keyVaultName: PGCRYPTO_LOCKS.keyVaultName,
      kvSecretName: PGCRYPTO_LOCKS.secretName,
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
      code: e.code || 'pgcrypto_compatibility_normalization_failed',
      sameTarget: true,
      blocker: e.code || 'pgcrypto_compatibility_normalization_failed',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      usedLiveHttp,
      ...getPgcryptoCompatibilityNormalizationCounters(),
      applicationName: APPLICATION_NAME,
      errors: [{
        code: e.code || 'pgcrypto_compatibility_normalization_failed',
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

function printCliHelp() {
  return [
    'phase-d:pgcrypto-compatibility-normalization — FOUNDATION Slice 14AB',
    'DEFAULT: refused (zero ARM / zero KV / zero PostgreSQL).',
    '',
    'Merged target-authority + one read-only observer session proving',
    'Azure PG15 pgcrypto 1.3 presentation normalization',
    '(fips_mode + extension version) under azure_flexible_server_v1 + postgresql_15.',
    'Requires dual Phase D flags + TARGET_AUTHORITY + PGCRYPTO_COMPATIBILITY_NORMALIZATION',
    '+ managed-identity + exact locked targets.',
    '',
    'Baseline must be exactly 4 post-14AA residuals (pgcrypto normalization off).',
    'Never prints/persists DSN, passwords, tokens, or secret versions.',
    'Zero mutation.',
  ].join('\n');
}

module.exports = {
  PHASE_D_PGCRYPTO_COMPATIBILITY_NORMALIZATION_LIVE_ENABLED,
  ENV_PGCRYPTO_COMPATIBILITY_NORMALIZATION,
  CLI_PROVE_PGCRYPTO_COMPATIBILITY_NORMALIZATION,
  APPLICATION_NAME,
  PGCRYPTO_LOCKS,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  evaluatePgcryptoCompatibilityNormalizationGates,
  exactPgcryptoCompatibilityNormalizationArgv,
  pgcryptoCompatibilityNormalizationEnv,
  executePgcryptoCompatibilityNormalization,
  buildOfflinePgcryptoLiveProfile,
  captureAzurePg15PgcryptoLiveProfile,
  createInjectedTargetAuthorityHttp,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetPgcryptoCompatibilityNormalizationCounters,
  getPgcryptoCompatibilityNormalizationCounters,
  evaluateTargetAuthorityGates,
  printCliHelp,
  groupMismatchSections,
  summarizeCompare,
  assertBaselineMismatch,
  remainingMismatchKeys,
  buildObserverCompareOptions,
};
