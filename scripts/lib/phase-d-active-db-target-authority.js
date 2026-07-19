'use strict';

/**
 * FOUNDATION Slice 14Q — Active Staff API ↔ Key Vault DB target authority
 *
 * Read-only proof that the active Sunset-staging Staff API Container App and
 * the Key Vault admin path used in Slice 14P target the same exact PostgreSQL
 * server/database/credential authority, then classify live observer drift
 * (expected_only mass) enough to choose a safe reconciliation path.
 *
 * Sequence (gated; default-disabled):
 *   1) IMDS ARM token (management.azure.com)
 *   2) ARM GET container app (active revision + env secretRef)
 *   3) ARM POST listSecrets only when needed (values zeroed immediately)
 *   4) IMDS vault token + GET luna-sunset-staging-kv/sunset-database-url
 *   5) In-memory semantic DSN compare (never persist/hash/print secrets)
 *   6) One TLS verify-full pg session application_name=wh-sunset-target-authority
 *      BEGIN READ ONLY → inventory counts → ledger summary → observer compare → COMMIT
 *
 * Zero mutation: no DDL/DML/ledger/KV write/Azure/RBAC/network/deploy.
 */

const http = require('http');
const https = require('https');
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
  redactSecrets,
  redactDeep,
  REDACTED,
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
  parseDatabaseUrl,
  introspectProductSchema,
  fingerprintProductSchema,
  compareSnapshots,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  LEDGER_TABLE,
  INTROSPECTION_SQL,
  assertSqlAllowed,
} = require('./sunset-schema-observer');

/** Live HTTP activated for Slice 14Q behind exact env+argv gates. */
const PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED = true;

const ENV_TARGET_AUTHORITY = 'SUNSET_PHASE_D_TARGET_AUTHORITY';
const CLI_PROVE_TARGET_AUTHORITY = '--prove-active-db-target-authority';

const APPLICATION_NAME = 'wh-sunset-target-authority';

const AUTHORITY_LOCKS = Object.freeze({
  subscriptionId: TARGETS.subscriptionId,
  resourceGroup: TARGETS.resourceGroup,
  containerAppName: 'luna-sunset-staging-staff-api',
  managementHostname: 'management.azure.com',
  armResourceAudience: 'https://management.azure.com/',
  armApiVersion: '2024-03-01',
  imdsHost: MI_LOADER_LOCKS.imdsHost,
  imdsApiVersion: MI_LOADER_LOCKS.imdsApiVersion,
  imdsPath: MI_LOADER_LOCKS.imdsPath,
  managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
  managedIdentityClientId: MI_LOADER_LOCKS.managedIdentityClientId,
  managedIdentityPrincipalId: MI_LOADER_LOCKS.managedIdentityPrincipalId,
  keyVaultName: MI_LOADER_LOCKS.keyVaultName,
  keyVaultHttpsUrl: MI_LOADER_LOCKS.keyVaultHttpsUrl,
  secretName: MI_LOADER_LOCKS.secretName,
  keyVaultApiVersion: MI_LOADER_LOCKS.keyVaultApiVersion,
  postgresHost: TARGETS.postgresHost,
  postgresServer: TARGETS.postgresServer,
  database: TARGETS.database,
  port: TARGETS.port,
  sslmode: TARGETS.sslmode,
  applicationName: APPLICATION_NAME,
  /** Preferred runtime DB env (Bicep); DATABASE_URL accepted only if alone and unambiguous. */
  preferredDbEnvNames: Object.freeze(['WOLFHOUSE_DATABASE_URL', 'DATABASE_URL']),
  lockedKeyVaultSecretUrl: (
    `${MI_LOADER_LOCKS.keyVaultHttpsUrl}/secrets/${MI_LOADER_LOCKS.secretName}`
  ),
});

const FORBIDDEN_ARGV_FLAGS = Object.freeze([
  '--delete',
  '--purge',
  '--retry',
  '--retries',
  '--force',
  '--deploy',
  '--mutate',
  '--url',
  '--body',
  '--token',
  '--access-token',
  '--imds-url',
  '--arm-url',
  '--dsn',
  '--database-url',
  '--connection-string',
  '--host',
  '--user',
  '--username',
  '--password',
  '--file',
  '--sql',
  '--execute-count-only',
  '--apply-phase-d-constraints',
  '--apply-firewall-rule',
]);

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_PROVE_TARGET_AUTHORITY,
  '--subscription',
  '--resource-group',
  '--container-app',
  '--postgres-server',
  '--database',
  CLI_CREDENTIAL_SOURCE,
  '--help',
  '-h',
]);

const SAFE_OUTPUT_KEYS = Object.freeze([
  'ok',
  'code',
  'sameTarget',
  'sameTargetReason',
  'blocker',
  'liveMutation',
  'schemaMutation',
  'dataMutation',
  'ledgerWritten',
  'kvMutation',
  'rbacMutation',
  'networkMutation',
  'firewallAction',
  'usedLiveHttp',
  'realImdsCall',
  'realArmCall',
  'realKeyVaultCall',
  'realPostgresCall',
  'httpRequestCount',
  'imdsRequestCount',
  'armGetCount',
  'armPostCount',
  'listSecretsCount',
  'keyVaultRequestCount',
  'clientsInstantiated',
  'connectCalls',
  'queryCalls',
  'endCalls',
  'subscriptionId',
  'resourceGroup',
  'containerAppName',
  'activeRevisionName',
  'activeRevisionCount',
  'dbEnvName',
  'secretRefName',
  'secretRefAmbiguous',
  'appSecretKeyVaultUrlMatchesLocked',
  'listSecretsUsed',
  'kvSecretName',
  'keyVaultName',
  'postgresHost',
  'database',
  'port',
  'sslmode',
  'applicationName',
  'managedIdentityName',
  'credentialSource',
  'hostMatch',
  'portMatch',
  'databaseMatch',
  'usernameEqual',
  'passwordEqual',
  'tlsSemanticsMatch',
  'kvTargetValid',
  'appTargetValid',
  'comparisonMode',
  'sessionReadOnly',
  'transactionReadOnly',
  'schemaInventory',
  'ledgerSummary',
  'observerOutcome',
  'driftClassification',
  'reconciliationPathHint',
  'errors',
  'closed',
  'committed',
  'rolledBack',
]);

/** Process-local counters. */
let httpRequestCount = 0;
let imdsRequestCount = 0;
let armGetCount = 0;
let armPostCount = 0;
let listSecretsCount = 0;
let keyVaultRequestCount = 0;
let clientsInstantiated = 0;
let connectCalls = 0;
let queryCalls = 0;
let endCalls = 0;

function getTargetAuthorityCounters() {
  return {
    httpRequestCount,
    imdsRequestCount,
    armGetCount,
    armPostCount,
    listSecretsCount,
    keyVaultRequestCount,
    clientsInstantiated,
    connectCalls,
    queryCalls,
    endCalls,
  };
}

function resetTargetAuthorityCounters() {
  httpRequestCount = 0;
  imdsRequestCount = 0;
  armGetCount = 0;
  armPostCount = 0;
  listSecretsCount = 0;
  keyVaultRequestCount = 0;
  clientsInstantiated = 0;
  connectCalls = 0;
  queryCalls = 0;
  endCalls = 0;
}

function buildLockedImdsArmTokenUrl() {
  const q = new URLSearchParams({
    'api-version': AUTHORITY_LOCKS.imdsApiVersion,
    resource: AUTHORITY_LOCKS.armResourceAudience,
    client_id: AUTHORITY_LOCKS.managedIdentityClientId,
  });
  return (
    `http://${AUTHORITY_LOCKS.imdsHost}${AUTHORITY_LOCKS.imdsPath}?${q.toString()}`
  );
}

function buildLockedImdsVaultTokenUrl() {
  const q = new URLSearchParams({
    'api-version': AUTHORITY_LOCKS.imdsApiVersion,
    resource: MI_LOADER_LOCKS.vaultResourceAudience,
    client_id: AUTHORITY_LOCKS.managedIdentityClientId,
  });
  return (
    `http://${AUTHORITY_LOCKS.imdsHost}${AUTHORITY_LOCKS.imdsPath}?${q.toString()}`
  );
}

function buildLockedArmContainerAppPath() {
  return (
    `/subscriptions/${AUTHORITY_LOCKS.subscriptionId}`
    + `/resourceGroups/${AUTHORITY_LOCKS.resourceGroup}`
    + `/providers/Microsoft.App/containerApps/${AUTHORITY_LOCKS.containerAppName}`
    + `?api-version=${AUTHORITY_LOCKS.armApiVersion}`
  );
}

function buildLockedArmListSecretsPath() {
  return (
    `/subscriptions/${AUTHORITY_LOCKS.subscriptionId}`
    + `/resourceGroups/${AUTHORITY_LOCKS.resourceGroup}`
    + `/providers/Microsoft.App/containerApps/${AUTHORITY_LOCKS.containerAppName}`
    + `/listSecrets?api-version=${AUTHORITY_LOCKS.armApiVersion}`
  );
}

function buildLockedKeyVaultSecretUrl() {
  return (
    `${AUTHORITY_LOCKS.keyVaultHttpsUrl}/secrets/`
    + `${encodeURIComponent(AUTHORITY_LOCKS.secretName)}`
    + `?api-version=${AUTHORITY_LOCKS.keyVaultApiVersion}`
  );
}

function pickSafe(obj) {
  const out = {};
  for (const k of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function sanitizeAuthorityError(err, secrets) {
  const list = (secrets || []).filter(Boolean).map(String);
  let message = String((err && err.message) || err || 'target_authority_failed').slice(0, 240);
  message = redactSecrets(message, list)
    .replace(/postgres(?:ql)?:\/\/[^:\s/@]+:[^@\s/]+@/gi, `postgresql://${REDACTED}:`)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g, REDACTED)
    .replace(/(password|passwd|pwd)\s*[=:]\s*([^\s&;,"']+)/gi, `$1=${REDACTED}`)
    .replace(/(user(name)?)\s*[=:]\s*([^\s&;,"']+)/gi, `$1=${REDACTED}`);
  return {
    code: (err && err.code) || 'target_authority_failed',
    message,
  };
}

function parseArgvPairs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const flags = new Set();
  const values = {};
  const unknown = [];
  const forbidden = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('-')) {
      unknown.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    let flag = a;
    let val = null;
    if (eq > 0) {
      flag = a.slice(0, eq);
      val = a.slice(eq + 1);
    }
    if (FORBIDDEN_ARGV_FLAGS.includes(flag)) {
      forbidden.push(flag);
      if (val == null && i + 1 < args.length && !args[i + 1].startsWith('-')) i += 1;
      continue;
    }
    if (flag === CLI_PROVE_TARGET_AUTHORITY || flag === '--help' || flag === '-h') {
      flags.add(flag);
      continue;
    }
    if (ALLOWED_ARGV_FLAGS.includes(flag)) {
      if (val == null) {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          unknown.push(flag);
          continue;
        }
        val = args[i + 1];
        i += 1;
      }
      values[flag] = val;
      flags.add(flag);
      continue;
    }
    unknown.push(flag);
    if (val == null && i + 1 < args.length && !args[i + 1].startsWith('-')) i += 1;
  }
  return { flags, values, unknown, forbidden, argv: args };
}

function exactTargetAuthorityArgv() {
  return [
    CLI_PROVE_TARGET_AUTHORITY,
    '--subscription', AUTHORITY_LOCKS.subscriptionId,
    '--resource-group', AUTHORITY_LOCKS.resourceGroup,
    '--container-app', AUTHORITY_LOCKS.containerAppName,
    '--postgres-server', AUTHORITY_LOCKS.postgresServer,
    '--database', AUTHORITY_LOCKS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function targetAuthorityEnv() {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_TARGET_AUTHORITY]: '1',
    [ENV_SUBSCRIPTION]: AUTHORITY_LOCKS.subscriptionId,
    [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  };
}

function evaluateTargetAuthorityGates(opts) {
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
  if (String(env[ENV_SUBSCRIPTION] || '') !== AUTHORITY_LOCKS.subscriptionId) {
    errors.push({ code: 'subscription_env_mismatch', message: 'AZURE_SUBSCRIPTION_ID must match locked subscription' });
  }
  if (String(env[ENV_CREDENTIAL_SOURCE] || '') !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `env ${ENV_CREDENTIAL_SOURCE}=managed-identity required`,
    });
  }
  if (!parsed.flags.has(CLI_PROVE_TARGET_AUTHORITY)) {
    errors.push({ code: 'target_authority_flag_required', message: `${CLI_PROVE_TARGET_AUTHORITY} required` });
  }
  if (parsed.values[CLI_CREDENTIAL_SOURCE] !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `argv ${CLI_CREDENTIAL_SOURCE} managed-identity required`,
    });
  }
  if (parsed.forbidden.length > 0) {
    errors.push({
      code: 'forbidden_argv',
      message: `forbidden argv: ${parsed.forbidden.join(',')}`,
    });
  }
  if (parsed.unknown.length > 0) {
    errors.push({
      code: 'unknown_argv',
      message: `unknown argv: ${parsed.unknown.join(',')}`,
    });
  }

  const expect = {
    '--subscription': AUTHORITY_LOCKS.subscriptionId,
    '--resource-group': AUTHORITY_LOCKS.resourceGroup,
    '--container-app': AUTHORITY_LOCKS.containerAppName,
    '--postgres-server': AUTHORITY_LOCKS.postgresServer,
    '--database': AUTHORITY_LOCKS.database,
  };
  for (const [flag, want] of Object.entries(expect)) {
    if (String(parsed.values[flag] || '') !== want) {
      errors.push({
        code: 'exact_target_mismatch',
        message: `${flag} must equal locked ${want}`,
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    parsed,
  };
}

/**
 * Normalize Key Vault URL for equality (strip version / query / trailing slash).
 * Never returns secret values.
 */
function normalizeKeyVaultSecretUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return null;
    const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    // secrets/<name>[/<version>]
    const secretsIdx = parts.indexOf('secrets');
    if (secretsIdx < 0 || secretsIdx + 1 >= parts.length) return null;
    const name = parts[secretsIdx + 1];
    return `${u.protocol}//${u.host}/secrets/${name}`.toLowerCase();
  } catch (_) {
    return null;
  }
}

function lockedKeyVaultSecretUrlNormalized() {
  return normalizeKeyVaultSecretUrl(AUTHORITY_LOCKS.lockedKeyVaultSecretUrl);
}

/**
 * Extract active revisions from Container App ARM payload.
 * Requires exactly one revision with trafficWeight > 0 (or latestRevisionName alone).
 */
function extractActiveRevision(appBody) {
  const props = (appBody && appBody.properties) || {};
  const traffic = Array.isArray(props.configuration && props.configuration.ingress
    && props.configuration.ingress.traffic)
    ? props.configuration.ingress.traffic
    : [];
  const active = traffic.filter((t) => Number(t && t.weight) > 0);
  if (active.length > 1) {
    return {
      ok: false,
      code: 'multiple_active_revisions',
      activeRevisionCount: active.length,
      activeRevisionName: null,
      errors: [{ code: 'multiple_active_revisions', message: 'more than one traffic-weighted revision' }],
    };
  }
  let name = null;
  if (active.length === 1) {
    name = String(active[0].revisionName || active[0].revision || '').trim() || null;
  }
  if (!name && props.latestRevisionName) {
    name = String(props.latestRevisionName).trim();
  }
  if (!name) {
    return {
      ok: false,
      code: 'active_revision_missing',
      activeRevisionCount: 0,
      activeRevisionName: null,
      errors: [{ code: 'active_revision_missing', message: 'no active revision identified' }],
    };
  }
  return {
    ok: true,
    code: 'active_revision_ok',
    activeRevisionCount: 1,
    activeRevisionName: name,
    errors: [],
  };
}

/**
 * Find the runtime DB env var and its secretRef. Stop on ambiguity.
 */
function extractDbEnvSecretRef(appBody) {
  const props = (appBody && appBody.properties) || {};
  const template = props.template || {};
  const containers = Array.isArray(template.containers) ? template.containers : [];
  const envHits = [];
  for (const c of containers) {
    const envs = Array.isArray(c && c.env) ? c.env : [];
    for (const e of envs) {
      const name = String((e && e.name) || '');
      if (!AUTHORITY_LOCKS.preferredDbEnvNames.includes(name)) continue;
      envHits.push({
        envName: name,
        secretRef: e.secretRef != null ? String(e.secretRef) : null,
        hasValue: e.value != null && String(e.value) !== '',
      });
    }
  }
  if (envHits.length === 0) {
    return {
      ok: false,
      code: 'db_env_missing',
      dbEnvName: null,
      secretRefName: null,
      secretRefAmbiguous: false,
      errors: [{ code: 'db_env_missing', message: 'no WOLFHOUSE_DATABASE_URL/DATABASE_URL env on active app' }],
    };
  }
  const withSecretRef = envHits.filter((h) => h.secretRef);
  const withPlain = envHits.filter((h) => h.hasValue && !h.secretRef);
  if (withPlain.length > 0) {
    return {
      ok: false,
      code: 'db_env_plaintext_forbidden',
      dbEnvName: withPlain[0].envName,
      secretRefName: null,
      secretRefAmbiguous: true,
      errors: [{ code: 'db_env_plaintext_forbidden', message: 'plaintext DB env refused' }],
    };
  }
  if (withSecretRef.length === 0) {
    return {
      ok: false,
      code: 'secret_ref_missing',
      dbEnvName: envHits[0].envName,
      secretRefName: null,
      secretRefAmbiguous: false,
      errors: [{ code: 'secret_ref_missing', message: 'DB env present without secretRef' }],
    };
  }
  const names = [...new Set(withSecretRef.map((h) => h.secretRef))];
  if (names.length > 1) {
    return {
      ok: false,
      code: 'secret_ref_ambiguous',
      dbEnvName: null,
      secretRefName: null,
      secretRefAmbiguous: true,
      errors: [{ code: 'secret_ref_ambiguous', message: 'multiple distinct secretRef names for DB envs' }],
    };
  }
  // Prefer WOLFHOUSE_DATABASE_URL when both present with same secretRef.
  const preferred = withSecretRef.find((h) => h.envName === 'WOLFHOUSE_DATABASE_URL')
    || withSecretRef[0];
  const distinctEnvNames = [...new Set(withSecretRef.map((h) => h.envName))];
  if (distinctEnvNames.length > 1
    && !distinctEnvNames.every((n) => withSecretRef.find((h) => h.envName === n).secretRef === names[0])) {
    return {
      ok: false,
      code: 'secret_ref_ambiguous',
      dbEnvName: null,
      secretRefName: null,
      secretRefAmbiguous: true,
      errors: [{ code: 'secret_ref_ambiguous', message: 'DB env secretRef mismatch across names' }],
    };
  }
  return {
    ok: true,
    code: 'secret_ref_ok',
    dbEnvName: preferred.envName,
    secretRefName: names[0],
    secretRefAmbiguous: false,
    errors: [],
  };
}

/**
 * From GET configuration.secrets (names / keyVaultUrl only) locate the secretRef.
 */
function extractSecretMetaFromAppConfig(appBody, secretRefName) {
  const props = (appBody && appBody.properties) || {};
  const secrets = Array.isArray(props.configuration && props.configuration.secrets)
    ? props.configuration.secrets
    : [];
  const matches = secrets.filter((s) => String((s && s.name) || '') === secretRefName);
  if (matches.length === 0) {
    return {
      found: false,
      keyVaultUrl: null,
      hasValueField: false,
      needListSecrets: true,
    };
  }
  if (matches.length > 1) {
    return {
      found: false,
      keyVaultUrl: null,
      hasValueField: false,
      needListSecrets: false,
      ambiguous: true,
    };
  }
  const s = matches[0];
  const keyVaultUrl = s.keyVaultUrl != null ? String(s.keyVaultUrl) : null;
  const hasValueField = Object.prototype.hasOwnProperty.call(s, 'value')
    && s.value != null
    && String(s.value) !== '';
  return {
    found: true,
    keyVaultUrl,
    hasValueField,
    // listSecrets needed when no keyVaultUrl and we must compare resolved values,
    // or when keyVaultUrl absent from GET (common redaction).
    needListSecrets: !keyVaultUrl,
    ambiguous: false,
  };
}

/**
 * Parse listSecrets response; return private bag with value (caller must zero).
 * Never put values into evidence.
 */
function parseListSecretsForRef(listBody, secretRefName) {
  const bag = {
    _appSecretValue: null,
    keyVaultUrl: null,
    found: false,
    ambiguous: false,
  };
  const items = Array.isArray(listBody && listBody.value)
    ? listBody.value
    : (Array.isArray(listBody) ? listBody : []);
  const matches = items.filter((s) => String((s && s.name) || '') === secretRefName);
  if (matches.length === 0) {
    return bag;
  }
  if (matches.length > 1) {
    bag.ambiguous = true;
    return bag;
  }
  const s = matches[0];
  bag.found = true;
  if (s.keyVaultUrl != null) bag.keyVaultUrl = String(s.keyVaultUrl);
  if (s.value != null && String(s.value) !== '') {
    bag._appSecretValue = String(s.value);
  }
  // Zero any other secret entries' value refs on the response object in-place.
  for (const item of items) {
    if (item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, 'value')) {
      try { item.value = null; } catch (_) { /* ignore */ }
    }
  }
  return bag;
}

/**
 * Semantic in-memory compare of two DSN strings against locked target.
 * Never returns DSN/user/password values.
 */
function compareDsnAuthorityInMemory(appDsn, kvDsn) {
  const appParsed = parseDatabaseUrl(appDsn);
  const kvParsed = parseDatabaseUrl(kvDsn);
  if (!appParsed.ok || !kvParsed.ok) {
    return {
      ok: false,
      sameTarget: false,
      sameTargetReason: 'malformed_dsn',
      hostMatch: false,
      portMatch: false,
      databaseMatch: false,
      usernameEqual: false,
      passwordEqual: false,
      tlsSemanticsMatch: false,
      kvTargetValid: false,
      appTargetValid: false,
      comparisonMode: 'value',
      errors: [{ code: 'malformed_dsn', message: 'one or both DSNs failed to parse' }],
    };
  }
  const a = appParsed.parsed;
  const k = kvParsed.parsed;
  // Password equality via URL decode of both (kept local).
  let appUser = '';
  let appPass = '';
  let kvUser = '';
  let kvPass = '';
  try {
    const au = new URL(String(appDsn));
    const ku = new URL(String(kvDsn));
    appUser = decodeURIComponent(au.username || '');
    appPass = decodeURIComponent(au.password || '');
    kvUser = decodeURIComponent(ku.username || '');
    kvPass = decodeURIComponent(ku.password || '');
  } catch (_) {
    return {
      ok: false,
      sameTarget: false,
      sameTargetReason: 'malformed_dsn',
      hostMatch: false,
      portMatch: false,
      databaseMatch: false,
      usernameEqual: false,
      passwordEqual: false,
      tlsSemanticsMatch: false,
      kvTargetValid: false,
      appTargetValid: false,
      comparisonMode: 'value',
      errors: [{ code: 'malformed_dsn', message: 'DSN URL decode failed' }],
    };
  }

  const hostMatch = a.host === AUTHORITY_LOCKS.postgresHost
    && k.host === AUTHORITY_LOCKS.postgresHost
    && a.host === k.host;
  const portMatch = Number(a.port || 5432) === AUTHORITY_LOCKS.port
    && Number(k.port || 5432) === AUTHORITY_LOCKS.port;
  const databaseMatch = a.database === AUTHORITY_LOCKS.database
    && k.database === AUTHORITY_LOCKS.database
    && a.database === k.database;
  const usernameEqual = appUser !== '' && appUser === kvUser;
  const passwordEqual = appPass !== '' && appPass === kvPass;
  const tlsSemanticsMatch = String(a.sslmode || '').toLowerCase()
    === String(k.sslmode || '').toLowerCase();
  const kvTargetValid = k.host === AUTHORITY_LOCKS.postgresHost
    && Number(k.port || 5432) === AUTHORITY_LOCKS.port
    && k.database === AUTHORITY_LOCKS.database
    && String(k.sslmode || '').toLowerCase() === AUTHORITY_LOCKS.sslmode;
  const appTargetValid = a.host === AUTHORITY_LOCKS.postgresHost
    && Number(a.port || 5432) === AUTHORITY_LOCKS.port
    && a.database === AUTHORITY_LOCKS.database
    && String(a.sslmode || '').toLowerCase() === AUTHORITY_LOCKS.sslmode;

  const sameTarget = hostMatch && portMatch && databaseMatch
    && usernameEqual && passwordEqual
    && tlsSemanticsMatch
    && kvTargetValid && appTargetValid
    && String(a.sslmode || '').toLowerCase() === AUTHORITY_LOCKS.sslmode;

  let sameTargetReason = 'same_exact_authority';
  if (!sameTarget) {
    if (!kvTargetValid || !appTargetValid) sameTargetReason = 'target_not_locked';
    else if (!usernameEqual || !passwordEqual) sameTargetReason = 'credential_mismatch';
    else if (!tlsSemanticsMatch) sameTargetReason = 'tls_mismatch';
    else sameTargetReason = 'authority_mismatch';
  }

  // Zero locals
  appUser = null;
  appPass = null;
  kvUser = null;
  kvPass = null;

  return {
    ok: true,
    sameTarget,
    sameTargetReason,
    hostMatch,
    portMatch,
    databaseMatch,
    usernameEqual,
    passwordEqual,
    tlsSemanticsMatch,
    kvTargetValid,
    appTargetValid,
    comparisonMode: 'value',
    errors: [],
  };
}

/**
 * Same-authority via exact Key Vault URL reference (no second DSN value).
 * Requires KV DSN to validate locked target.
 */
function compareKeyVaultRefAuthority(keyVaultUrl, kvDsn) {
  const norm = normalizeKeyVaultSecretUrl(keyVaultUrl);
  const locked = lockedKeyVaultSecretUrlNormalized();
  const urlMatch = Boolean(norm && locked && norm === locked);
  const kvMem = parseSunsetDatabaseUrlSecretInMemory(kvDsn);
  const kvTargetValid = kvMem.ok === true;
  const sameTarget = urlMatch && kvTargetValid;
  return {
    ok: urlMatch,
    sameTarget,
    sameTargetReason: sameTarget
      ? 'same_keyvault_secret_authority'
      : (urlMatch ? 'kv_target_invalid' : 'keyvault_url_mismatch'),
    hostMatch: kvTargetValid,
    portMatch: kvTargetValid,
    databaseMatch: kvTargetValid,
    usernameEqual: urlMatch, // same secret authority ⇒ same user/password
    passwordEqual: urlMatch,
    tlsSemanticsMatch: kvTargetValid,
    kvTargetValid,
    appTargetValid: urlMatch && kvTargetValid,
    comparisonMode: 'keyvault_url_ref',
    errors: urlMatch
      ? (kvTargetValid ? [] : (kvMem.errors || [{ code: 'kv_target_invalid', message: 'KV DSN failed locked target' }]))
      : [{ code: 'keyvault_url_mismatch', message: 'app secret keyVaultUrl is not locked sunset-database-url' }],
  };
}

function createLiveTargetAuthorityHttpRequest() {
  async function httpRequest(req) {
    const request = req || {};
    const method = String(request.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      throw Object.assign(new Error(`http method ${method} forbidden`), {
        code: 'http_method_forbidden',
      });
    }
    if (method === 'POST' && request.purpose !== 'arm_list_secrets') {
      throw Object.assign(new Error('POST only allowed for listSecrets'), {
        code: 'http_method_forbidden',
      });
    }
    const protocol = String(request.protocol || '');
    const lib = protocol === 'https:' ? https : http;
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw Object.assign(new Error('http protocol rejected'), { code: 'http_protocol_rejected' });
    }
    const headers = { ...(request.headers || {}) };
    const body = request.body != null ? String(request.body) : null;
    if (body != null) headers['Content-Length'] = Buffer.byteLength(body);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(value);
      };
      const nodeReq = lib.request({
        hostname: request.hostname,
        port: request.port,
        path: request.path,
        method,
        headers,
        timeout: 30000,
      }, (res) => {
        const statusCode = Number(res.statusCode);
        if (statusCode >= 300 && statusCode < 400) {
          res.resume();
          finish(Object.assign(new Error('http redirect rejected'), {
            code: 'http_redirect_rejected',
          }));
          return;
        }
        const chunks = [];
        res.on('data', (c) => { chunks.push(c); });
        res.on('end', () => {
          finish(null, { statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (err) => {
          finish(Object.assign(
            new Error(String((err && err.message) || err || 'http response failed').slice(0, 240)),
            { code: 'http_request_failed' },
          ));
        });
      });
      nodeReq.on('timeout', () => {
        nodeReq.destroy();
        finish(Object.assign(new Error('http request timeout'), { code: 'http_request_failed' }));
      });
      nodeReq.on('error', (err) => {
        finish(Object.assign(
          new Error(String((err && err.message) || err || 'http request failed').slice(0, 240)),
          { code: 'http_request_failed' },
        ));
      });
      if (body != null) nodeReq.write(body);
      nodeReq.end();
    });
  }
  return httpRequest;
}

/**
 * Injected HTTP for offline RED/GREEN. Script controls responses; never records secrets.
 */
function createInjectedTargetAuthorityHttp(script) {
  const s = script || {};
  const calls = [];
  const armAppPath = buildLockedArmContainerAppPath();
  const listPath = buildLockedArmListSecretsPath();
  const imdsArmUrl = new URL(buildLockedImdsArmTokenUrl());
  const imdsVaultUrl = new URL(buildLockedImdsVaultTokenUrl());
  const kvUrl = new URL(buildLockedKeyVaultSecretUrl());

  async function httpRequest(req) {
    const request = req || {};
    const method = String(request.method || 'GET').toUpperCase();
    calls.push({
      purpose: request.purpose || null,
      hostname: request.hostname || null,
      path: request.path ? String(request.path).split('?')[0] : null,
      method,
      hasAuthorization: Boolean(request.headers && request.headers.Authorization),
    });

    if (s.throwOn && s.throwOn === request.purpose) {
      throw Object.assign(new Error((s.throwError && s.throwError.message) || 'injected failure'), {
        code: (s.throwError && s.throwError.code) || 'injected_http_failed',
      });
    }

    if (request.purpose === 'imds_arm_token' || request.purpose === 'imds_vault_token') {
      const expect = request.purpose === 'imds_arm_token' ? imdsArmUrl : imdsVaultUrl;
      if (request.hostname !== expect.hostname) {
        return { statusCode: 400, body: '{"error":"wrong_imds_host"}' };
      }
      if (request.headers && request.headers.Metadata !== 'true') {
        return { statusCode: 400, body: '{"error":"metadata_header_required"}' };
      }
      const token = request.purpose === 'imds_arm_token'
        ? (s.imdsArmAccessToken || s.imdsAccessToken || 'slice14q-proof-arm-token')
        : (s.imdsVaultAccessToken || s.imdsAccessToken || 'slice14q-proof-vault-token');
      return {
        statusCode: 200,
        body: JSON.stringify({
          access_token: token,
          expires_in: 3600,
          token_type: 'Bearer',
          client_id: AUTHORITY_LOCKS.managedIdentityClientId,
        }),
      };
    }

    if (request.purpose === 'arm_container_app_get') {
      if (method !== 'GET' || request.hostname !== AUTHORITY_LOCKS.managementHostname
        || request.path !== armAppPath) {
        return { statusCode: 400, body: '{"error":"arm_path_rejected"}' };
      }
      if (s.appStatusCode && s.appStatusCode !== 200) {
        return { statusCode: s.appStatusCode, body: s.appBody || '{"error":"app_failed"}' };
      }
      return {
        statusCode: 200,
        body: typeof s.appBody === 'string' ? s.appBody : JSON.stringify(s.appBody || defaultFakeAppBody(s)),
      };
    }

    if (request.purpose === 'arm_list_secrets') {
      if (method !== 'POST' || request.hostname !== AUTHORITY_LOCKS.managementHostname
        || request.path !== listPath) {
        return { statusCode: 400, body: '{"error":"list_secrets_path_rejected"}' };
      }
      if (s.listSecretsStatusCode && s.listSecretsStatusCode !== 200) {
        return {
          statusCode: s.listSecretsStatusCode,
          body: s.listSecretsBody || '{"error":"list_secrets_failed"}',
        };
      }
      return {
        statusCode: 200,
        body: typeof s.listSecretsBody === 'string'
          ? s.listSecretsBody
          : JSON.stringify(s.listSecretsBody || defaultFakeListSecrets(s)),
      };
    }

    if (request.purpose === 'keyvault_secret') {
      if (method !== 'GET' || request.hostname !== kvUrl.hostname) {
        return { statusCode: 400, body: '{"error":"wrong_kv_host"}' };
      }
      const value = Object.prototype.hasOwnProperty.call(s, 'secretValue')
        ? s.secretValue
        : s.defaultSecretValue;
      return {
        statusCode: 200,
        body: JSON.stringify({ value, contentType: 'text/plain' }),
      };
    }

    return { statusCode: 400, body: '{"error":"unknown_purpose"}' };
  }

  httpRequest.calls = calls;
  httpRequest.reset = () => { calls.length = 0; };
  return httpRequest;
}

function defaultFakeAppBody(script) {
  const s = script || {};
  const revision = s.activeRevisionName || 'luna-sunset-staging-staff-api--0000266';
  const secretRef = s.secretRefName || AUTHORITY_LOCKS.secretName;
  const envName = s.dbEnvName || 'WOLFHOUSE_DATABASE_URL';
  const secrets = [{
    name: secretRef,
    keyVaultUrl: Object.prototype.hasOwnProperty.call(s, 'appKeyVaultUrl')
      ? s.appKeyVaultUrl
      : `${AUTHORITY_LOCKS.keyVaultHttpsUrl}/secrets/${AUTHORITY_LOCKS.secretName}`,
  }];
  const traffic = s.multipleActiveRevisions
    ? [
      { revisionName: revision, weight: 50 },
      { revisionName: `${revision}-b`, weight: 50 },
    ]
    : [{ revisionName: revision, weight: 100 }];
  const env = s.missingDbEnv
    ? [{ name: 'NODE_ENV', value: 'staging' }]
    : s.ambiguousSecretRefs
      ? [
        { name: 'WOLFHOUSE_DATABASE_URL', secretRef: 'sunset-database-url' },
        { name: 'DATABASE_URL', secretRef: 'other-database-url' },
      ]
      : [{ name: envName, secretRef }];
  return {
    name: AUTHORITY_LOCKS.containerAppName,
    properties: {
      latestRevisionName: revision,
      configuration: {
        secrets,
        ingress: { traffic },
      },
      template: {
        containers: [{ name: 'staff-api', env }],
      },
    },
  };
}

function defaultFakeListSecrets(script) {
  const s = script || {};
  const secretRef = s.secretRefName || AUTHORITY_LOCKS.secretName;
  const item = {
    name: secretRef,
    keyVaultUrl: Object.prototype.hasOwnProperty.call(s, 'appKeyVaultUrl')
      ? s.appKeyVaultUrl
      : `${AUTHORITY_LOCKS.keyVaultHttpsUrl}/secrets/${AUTHORITY_LOCKS.secretName}`,
  };
  if (s.appSecretValue != null) item.value = s.appSecretValue;
  return { value: [item] };
}

async function invokeAuthorityHttp(httpRequest, request) {
  httpRequestCount += 1;
  const res = await httpRequest(request);
  if (!res || typeof res !== 'object') {
    throw Object.assign(new Error('http returned no response'), { code: 'http_response_invalid' });
  }
  const statusCode = Number(res.statusCode);
  if (!Number.isFinite(statusCode)) {
    throw Object.assign(new Error('http missing statusCode'), { code: 'http_status_invalid' });
  }
  if (statusCode >= 300 && statusCode < 400) {
    throw Object.assign(new Error('http redirect rejected'), { code: 'http_redirect_rejected' });
  }
  if (statusCode !== 200) {
    throw Object.assign(new Error(`http status ${statusCode} rejected`), {
      code: 'http_status_rejected',
    });
  }
  return res;
}

async function fetchImdsToken(httpRequest, purpose) {
  const url = new URL(
    purpose === 'imds_arm_token' ? buildLockedImdsArmTokenUrl() : buildLockedImdsVaultTokenUrl(),
  );
  imdsRequestCount += 1;
  const res = await invokeAuthorityHttp(httpRequest, {
    purpose,
    protocol: 'http:',
    hostname: url.hostname,
    port: 80,
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    headers: Object.freeze({ Metadata: 'true' }),
  });
  let body;
  try {
    body = JSON.parse(res.body);
  } catch (_) {
    throw Object.assign(new Error('IMDS JSON invalid'), { code: 'imds_json_invalid' });
  }
  if (!body || typeof body.access_token !== 'string' || !body.access_token) {
    throw Object.assign(new Error('IMDS token missing'), { code: 'imds_token_missing' });
  }
  if (body.client_id != null && String(body.client_id) !== AUTHORITY_LOCKS.managedIdentityClientId) {
    throw Object.assign(new Error('IMDS token identity mismatch'), {
      code: 'imds_token_identity_mismatch',
    });
  }
  return body.access_token;
}

function buildLockedPgClientConfig(user, password) {
  return {
    host: AUTHORITY_LOCKS.postgresHost,
    port: AUTHORITY_LOCKS.port,
    database: AUTHORITY_LOCKS.database,
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

/** Safe schema inventory: counts by object type + schema only. */
async function captureSchemaInventory(client) {
  queryCalls += 1;
  const res = await client.query(`
    SELECT n.nspname AS schema_name,
           CASE c.relkind
             WHEN 'r' THEN 'table'
             WHEN 'v' THEN 'view'
             WHEN 'm' THEN 'materialized_view'
             WHEN 'S' THEN 'sequence'
             WHEN 'i' THEN 'index'
             WHEN 'c' THEN 'composite_type'
             ELSE c.relkind::text
           END AS object_type,
           COUNT(*)::int AS object_count
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname NOT LIKE 'pg_temp_%'
      AND n.nspname NOT LIKE 'pg_toast_temp_%'
      AND c.relkind IN ('r', 'v', 'm', 'S', 'i')
    GROUP BY n.nspname, object_type
    ORDER BY n.nspname, object_type
  `);
  const bySchema = {};
  let totalObjects = 0;
  let publicTables = 0;
  for (const row of res.rows || []) {
    const schema = String(row.schema_name);
    const typ = String(row.object_type);
    const count = Number(row.object_count) || 0;
    if (!bySchema[schema]) bySchema[schema] = {};
    bySchema[schema][typ] = count;
    totalObjects += count;
    if (schema === 'public' && typ === 'table') publicTables = count;
  }
  return {
    bySchema,
    totalObjects,
    publicTables,
    schemas: Object.keys(bySchema).sort(),
  };
}

/**
 * Ledger presence + row count + safe status categories / checksum-match counts.
 * Never returns row IDs or checksum values.
 */
async function captureLedgerSummary(client, expectedChecksumById) {
  queryCalls += 1;
  const existsRes = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = $1
        AND c.relkind = 'r'
    ) AS present
  `, [LEDGER_TABLE]);
  const present = Boolean(existsRes.rows[0] && existsRes.rows[0].present);
  if (!present) {
    return {
      present: false,
      tableName: LEDGER_TABLE,
      rowCount: 0,
      statusCategories: {
        checksum_match: 0,
        checksum_mismatch: 0,
        unknown_id: 0,
      },
      note: 'ledger_table_absent',
    };
  }
  queryCalls += 1;
  const countRes = await client.query(
    `SELECT COUNT(*)::int AS n FROM public.${LEDGER_TABLE}`,
  );
  const rowCount = Number(countRes.rows[0] && countRes.rows[0].n) || 0;

  let statusCategories = {
    checksum_match: 0,
    checksum_mismatch: 0,
    unknown_id: 0,
  };
  if (expectedChecksumById && typeof expectedChecksumById === 'object') {
    queryCalls += 1;
    const rowsRes = await client.query(
      `SELECT id, checksum_sha256 FROM public.${LEDGER_TABLE}`,
    );
    for (const row of rowsRes.rows || []) {
      const id = String(row.id || '');
      const live = String(row.checksum_sha256 || '');
      // Zero checksum from row object immediately after reading into locals.
      try { row.checksum_sha256 = null; } catch (_) { /* ignore */ }
      if (!Object.prototype.hasOwnProperty.call(expectedChecksumById, id)) {
        statusCategories.unknown_id += 1;
      } else if (String(expectedChecksumById[id]) === live) {
        statusCategories.checksum_match += 1;
      } else {
        statusCategories.checksum_mismatch += 1;
      }
    }
  }

  return {
    present: true,
    tableName: LEDGER_TABLE,
    rowCount,
    statusCategories,
    note: null,
  };
}

/**
 * Classify 498-style expected_only mass given sameTarget + inventory + observer.
 */
function classifyDrift(sameTarget, schemaInventory, observerOutcome) {
  const counts = (observerOutcome && observerOutcome.counts) || {};
  const expectedOnly = Number(counts.expected_only) || 0;
  const liveOnly = Number(counts.live_only) || 0;
  const defMismatch = Number(counts.definition_mismatch) || 0;
  const mismatchCount = Number(observerOutcome && observerOutcome.mismatchCount) || 0;
  const publicTables = Number(schemaInventory && schemaInventory.publicTables) || 0;
  const expectedPublicTables = 51; // from expected-product-schema tables length
  const sections = (observerOutcome && observerOutcome.mismatchSections) || {};
  const tableExpectedOnly = Number(sections.tables) || 0;
  const constraintExpectedOnly = Number(sections.constraints) || 0;
  const hasLiveFingerprint = Boolean(
    observerOutcome
    && observerOutcome.productFingerprintLive
    && String(observerOutcome.productFingerprintLive).length === 64,
  );

  if (sameTarget !== true) {
    return {
      code: 'wrong_target',
      reason: 'Staff API and/or KV admin path do not share locked exact authority',
      expectedOnly,
      liveOnly,
      definitionMismatch: defMismatch,
      mismatchCount,
      publicTables,
      reconciliationPathHint: 'resolve_target_authority_before_schema_reconcile',
    };
  }

  if (observerOutcome && observerOutcome.match === true) {
    return {
      code: 'observer_match',
      reason: 'canonical observer match',
      expectedOnly,
      liveOnly,
      definitionMismatch: defMismatch,
      mismatchCount,
      publicTables,
      reconciliationPathHint: 'none',
    };
  }

  // Sparse: far fewer public tables than canonical product schema.
  const sparse = publicTables <= Math.max(3, Math.floor(expectedPublicTables * 0.15));
  if (sparse && expectedOnly >= 100) {
    return {
      code: 'genuinely_sparse_active_runtime_db',
      reason: 'sameTarget but public table inventory is sparse vs canonical product schema; expected_only mass reflects absent objects',
      expectedOnly,
      liveOnly,
      definitionMismatch: defMismatch,
      mismatchCount,
      publicTables,
      reconciliationPathHint: 'apply_canonical_migrations_to_active_runtime_db',
    };
  }

  // Observation defect: inventory says rich DB, but observer table-level view is blind
  // (nearly all expected tables missing from compare) OR fingerprint missing while inventory rich.
  const observerBlindToTables = !sparse
    && publicTables >= Math.floor(expectedPublicTables * 0.5)
    && tableExpectedOnly >= Math.floor(expectedPublicTables * 0.5)
    && liveOnly === 0;
  const fingerprintMissingDespiteInventory = !sparse
    && publicTables >= Math.floor(expectedPublicTables * 0.5)
    && !hasLiveFingerprint;
  if (observerBlindToTables || fingerprintMissingDespiteInventory) {
    return {
      code: 'observation_defect',
      reason: observerBlindToTables
        ? 'sameTarget and non-sparse inventory but observer still reports most tables as expected_only — compare/normalization suspect'
        : 'sameTarget and non-sparse inventory but observer fingerprint missing — observation defect',
      expectedOnly,
      liveOnly,
      definitionMismatch: defMismatch,
      mismatchCount,
      publicTables,
      reconciliationPathHint: 'debug_observer_normalization_before_schema_mutation',
    };
  }

  // Non-sparse sameTarget with constraint-heavy expected_only and few table misses:
  // live product objects exist; residual is real schema divergence (not wrong target / not blind).
  if (!sparse && expectedOnly >= 100 && tableExpectedOnly <= 5 && constraintExpectedOnly >= 100) {
    return {
      code: 'schema_divergence',
      reason: 'sameTarget with non-sparse tables; expected_only mass is mostly constraints — genuine product-schema divergence on the shared authority',
      expectedOnly,
      liveOnly,
      definitionMismatch: defMismatch,
      mismatchCount,
      publicTables,
      reconciliationPathHint: 'targeted_schema_reconcile_on_confirmed_same_target',
    };
  }

  return {
    code: 'schema_divergence',
    reason: 'sameTarget with non-sparse inventory and residual drift not explained as observation defect or sparse DB',
    expectedOnly,
    liveOnly,
    definitionMismatch: defMismatch,
    mismatchCount,
    publicTables,
    reconciliationPathHint: 'targeted_schema_reconcile_after_confirming_inventory',
  };
}

/**
 * Session gate for application_name=wh-sunset-target-authority.
 * Does not reuse observer verifyLiveSession (which locks observer app name).
 */
async function verifyTargetAuthoritySession(client) {
  const errors = [];
  const show = {};
  async function showOne(key, sql) {
    const gate = assertSqlAllowed(sql);
    if (!gate.ok) {
      throw Object.assign(new Error(gate.message), { code: gate.code });
    }
    queryCalls += 1;
    const res = await client.query(sql);
    const row = (res.rows && res.rows[0]) || {};
    const val = row[key] != null ? row[key] : Object.values(row)[0];
    show[key] = val;
    return val;
  }
  const tro = String(await showOne(
    'transaction_read_only',
    INTROSPECTION_SQL.show_transaction_read_only,
  )).toLowerCase();
  if (tro !== 'on') {
    errors.push({ code: 'non_read_only_session', message: `transaction_read_only=${tro || 'unset'}` });
  }
  const app = String(await showOne('application_name', INTROSPECTION_SQL.show_application_name));
  if (app !== APPLICATION_NAME) {
    errors.push({
      code: 'wrong_application_name',
      message: `application_name must be ${APPLICATION_NAME}`,
    });
  }
  const st = String(await showOne('statement_timeout', INTROSPECTION_SQL.show_statement_timeout));
  if (!(st === '30s' || st === '30000ms' || st === '30000')) {
    errors.push({ code: 'bad_statement_timeout', message: st });
  }
  const lt = String(await showOne('lock_timeout', INTROSPECTION_SQL.show_lock_timeout));
  if (!(lt === '5s' || lt === '5000ms' || lt === '5000')) {
    errors.push({ code: 'bad_lock_timeout', message: lt });
  }
  return { ok: errors.length === 0, errors, show };
}

async function runObserverAndInventory(client, expectedContract, expectedChecksumById) {
  const session = await verifyTargetAuthoritySession(client);
  if (!session.ok) {
    return {
      sessionReadOnly: false,
      transactionReadOnly: false,
      schemaInventory: null,
      ledgerSummary: null,
      observerOutcome: {
        ok: false,
        match: false,
        code: 'session_not_read_only',
        mismatchCount: null,
        counts: null,
        blocker: 'session_not_read_only',
        errors: (session.errors || []).map((e) => ({
          code: e.code || 'session_not_read_only',
          message: String(e.message || '').slice(0, 240),
        })),
      },
      driftClassification: {
        code: 'observation_defect',
        reason: 'session was not read-only',
        reconciliationPathHint: 'fix_readonly_session_gate',
      },
    };
  }

  const tro = String((session.show && session.show.transaction_read_only) || '').toLowerCase();
  const transactionReadOnly = tro === 'on';

  const schemaInventory = await captureSchemaInventory(client);
  const ledgerSummary = await captureLedgerSummary(client, expectedChecksumById);

  const product = await introspectProductSchema(client);
  // introspect issues many queries — approximate via usedAllowlist length
  queryCalls += Array.isArray(product.usedAllowlist) ? product.usedAllowlist.length : 20;

  const productFingerprintLive = fingerprintProductSchema(product.snapshot);
  const azureContext = {
    verified: true,
    host: EXPECTED_HOST,
    database: EXPECTED_DATABASE,
  };
  const cmp = compareSnapshots(expectedContract.snapshot, product.snapshot, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext,
  });

  let observerOutcome;
  if (cmp.normalizationError) {
    observerOutcome = {
      ok: false,
      match: false,
      code: cmp.normalizationError.code || 'normalization_failed',
      mismatchCount: null,
      counts: cmp.counts || null,
      productFingerprintLive,
      normalizationError: {
        code: cmp.normalizationError.code,
        message: String(cmp.normalizationError.message || '').slice(0, 240),
      },
      blocker: cmp.normalizationError.code || 'normalization_failed',
      sessionReadOnly: true,
    };
  } else {
    const mismatchCount = Array.isArray(cmp.drifts) ? cmp.drifts.length : (
      (cmp.counts.expected_only || 0)
      + (cmp.counts.live_only || 0)
      + (cmp.counts.definition_mismatch || 0)
    );
    // Grouped mismatch sections only (counts) — never keys/IDs beyond section names.
    const sectionCounts = {};
    for (const d of cmp.drifts || []) {
      const section = String(d.section || d.kind || 'unknown');
      sectionCounts[section] = (sectionCounts[section] || 0) + 1;
    }
    observerOutcome = {
      ok: cmp.ok === true,
      match: cmp.ok === true,
      code: cmp.ok === true ? 'observer_match' : 'observer_drift',
      mismatchCount,
      counts: cmp.counts,
      mismatchSections: sectionCounts,
      productFingerprintLive,
      normalizationError: null,
      blocker: cmp.ok === true ? null : 'observer_drift',
      sessionReadOnly: true,
    };
  }

  return {
    sessionReadOnly: true,
    transactionReadOnly,
    schemaInventory,
    ledgerSummary,
    observerOutcome,
  };
}

/**
 * Main gated entry: inspect app+KV authority and optionally one read-only PG session.
 *
 * options:
 *   env, argv
 *   httpRequest (inject for offline)
 *   ClientFactory (inject fake Client)
 *   expectedContract (required for live/offline observer)
 *   expectedChecksumById (optional map id→checksum for ledger category counts)
 *   skipPostgres (true for ARM/KV-only offline RED cases)
 */
async function executeActiveDbTargetAuthority(opts) {
  const options = opts || {};
  const secrets = [];
  const gate = evaluateTargetAuthorityGates(options);
  if (!gate.ok) {
    return pickSafe(redactDeep({
      ok: false,
      code: (gate.errors[0] && gate.errors[0].code) || 'gates_rejected',
      sameTarget: false,
      sameTargetReason: 'gates_rejected',
      blocker: (gate.errors[0] && gate.errors[0].code) || 'gates_rejected',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      rbacMutation: false,
      networkMutation: false,
      firewallAction: false,
      usedLiveHttp: false,
      realImdsCall: false,
      realArmCall: false,
      realKeyVaultCall: false,
      realPostgresCall: false,
      ...getTargetAuthorityCounters(),
      subscriptionId: AUTHORITY_LOCKS.subscriptionId,
      resourceGroup: AUTHORITY_LOCKS.resourceGroup,
      containerAppName: AUTHORITY_LOCKS.containerAppName,
      kvSecretName: AUTHORITY_LOCKS.secretName,
      keyVaultName: AUTHORITY_LOCKS.keyVaultName,
      postgresHost: AUTHORITY_LOCKS.postgresHost,
      database: AUTHORITY_LOCKS.database,
      port: AUTHORITY_LOCKS.port,
      sslmode: AUTHORITY_LOCKS.sslmode,
      applicationName: APPLICATION_NAME,
      managedIdentityName: AUTHORITY_LOCKS.managedIdentityName,
      credentialSource: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
      errors: gate.errors,
      closed: true,
      committed: false,
      rolledBack: false,
    }, secrets));
  }

  const usedLiveHttp = typeof options.httpRequest !== 'function'
    && PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED === true
    && PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true;
  const httpRequest = typeof options.httpRequest === 'function'
    ? options.httpRequest
    : (usedLiveHttp ? createLiveTargetAuthorityHttpRequest() : null);

  if (typeof httpRequest !== 'function') {
    return pickSafe({
      ok: false,
      code: 'http_disabled',
      sameTarget: false,
      sameTargetReason: 'http_disabled',
      blocker: 'http_disabled',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      rbacMutation: false,
      networkMutation: false,
      firewallAction: false,
      usedLiveHttp: false,
      ...getTargetAuthorityCounters(),
      errors: [{ code: 'http_disabled', message: 'inject httpRequest for offline proof' }],
      closed: true,
      committed: false,
      rolledBack: false,
    });
  }

  let armToken = null;
  let vaultToken = null;
  let kvSecretValue = null;
  let appSecretValue = null;
  let client = null;
  let closed = true;
  let committed = false;
  let rolledBack = false;

  const fail = (code, message, extra) => {
    zeroPrivateCredentialRefs({
      _token: armToken,
      _accessToken: vaultToken,
      _secretValue: kvSecretValue,
      _dsn: appSecretValue,
    });
    armToken = null;
    vaultToken = null;
    kvSecretValue = null;
    appSecretValue = null;
    return pickSafe(redactDeep({
      ok: false,
      code,
      sameTarget: false,
      sameTargetReason: code,
      blocker: code,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      rbacMutation: false,
      networkMutation: false,
      firewallAction: false,
      usedLiveHttp,
      realImdsCall: imdsRequestCount > 0,
      realArmCall: armGetCount + armPostCount > 0,
      realKeyVaultCall: keyVaultRequestCount > 0,
      realPostgresCall: clientsInstantiated > 0,
      ...getTargetAuthorityCounters(),
      subscriptionId: AUTHORITY_LOCKS.subscriptionId,
      resourceGroup: AUTHORITY_LOCKS.resourceGroup,
      containerAppName: AUTHORITY_LOCKS.containerAppName,
      kvSecretName: AUTHORITY_LOCKS.secretName,
      keyVaultName: AUTHORITY_LOCKS.keyVaultName,
      postgresHost: AUTHORITY_LOCKS.postgresHost,
      database: AUTHORITY_LOCKS.database,
      port: AUTHORITY_LOCKS.port,
      sslmode: AUTHORITY_LOCKS.sslmode,
      applicationName: APPLICATION_NAME,
      managedIdentityName: AUTHORITY_LOCKS.managedIdentityName,
      credentialSource: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
      errors: [{ code, message: String(message || code).slice(0, 240) }],
      closed: true,
      committed,
      rolledBack,
      ...(extra || {}),
    }, secrets));
  };

  try {
    armToken = await fetchImdsToken(httpRequest, 'imds_arm_token');
    secrets.push(armToken);

    armGetCount += 1;
    const appRes = await invokeAuthorityHttp(httpRequest, {
      purpose: 'arm_container_app_get',
      protocol: 'https:',
      hostname: AUTHORITY_LOCKS.managementHostname,
      port: 443,
      method: 'GET',
      path: buildLockedArmContainerAppPath(),
      headers: Object.freeze({ Authorization: `Bearer ${armToken}` }),
    });
    let appBody;
    try {
      appBody = JSON.parse(appRes.body);
    } catch (_) {
      return fail('arm_json_invalid', 'container app GET JSON invalid');
    }

    const rev = extractActiveRevision(appBody);
    if (!rev.ok) {
      return fail(rev.code, rev.errors[0] && rev.errors[0].message, {
        activeRevisionCount: rev.activeRevisionCount,
        activeRevisionName: rev.activeRevisionName,
      });
    }

    const envRef = extractDbEnvSecretRef(appBody);
    if (!envRef.ok) {
      return fail(envRef.code, envRef.errors[0] && envRef.errors[0].message, {
        activeRevisionName: rev.activeRevisionName,
        activeRevisionCount: rev.activeRevisionCount,
        dbEnvName: envRef.dbEnvName,
        secretRefName: envRef.secretRefName,
        secretRefAmbiguous: envRef.secretRefAmbiguous === true,
      });
    }

    let secretMeta = extractSecretMetaFromAppConfig(appBody, envRef.secretRefName);
    if (secretMeta.ambiguous) {
      return fail('secret_ref_ambiguous', 'multiple secret config entries for secretRef', {
        activeRevisionName: rev.activeRevisionName,
        activeRevisionCount: 1,
        dbEnvName: envRef.dbEnvName,
        secretRefName: envRef.secretRefName,
        secretRefAmbiguous: true,
      });
    }

    let listSecretsUsed = false;
    let appKeyVaultUrl = secretMeta.keyVaultUrl || null;

    if (secretMeta.needListSecrets || options.forceListSecrets === true) {
      listSecretsUsed = true;
      armPostCount += 1;
      listSecretsCount += 1;
      const listRes = await invokeAuthorityHttp(httpRequest, {
        purpose: 'arm_list_secrets',
        protocol: 'https:',
        hostname: AUTHORITY_LOCKS.managementHostname,
        port: 443,
        method: 'POST',
        path: buildLockedArmListSecretsPath(),
        headers: Object.freeze({
          Authorization: `Bearer ${armToken}`,
          'Content-Length': '0',
        }),
        body: '',
      });
      let listBody;
      try {
        listBody = JSON.parse(listRes.body);
      } catch (_) {
        return fail('list_secrets_json_invalid', 'listSecrets JSON invalid', {
          activeRevisionName: rev.activeRevisionName,
          dbEnvName: envRef.dbEnvName,
          secretRefName: envRef.secretRefName,
          listSecretsUsed: true,
        });
      }
      const parsed = parseListSecretsForRef(listBody, envRef.secretRefName);
      // Zero entire listBody recursively for value fields.
      zeroListSecretsValues(listBody);
      if (parsed.ambiguous) {
        parsed._appSecretValue = null;
        return fail('secret_ref_ambiguous', 'listSecrets returned ambiguous secretRef', {
          activeRevisionName: rev.activeRevisionName,
          dbEnvName: envRef.dbEnvName,
          secretRefName: envRef.secretRefName,
          secretRefAmbiguous: true,
          listSecretsUsed: true,
        });
      }
      if (!parsed.found) {
        parsed._appSecretValue = null;
        return fail('secret_ref_missing', 'listSecrets missing secretRef', {
          activeRevisionName: rev.activeRevisionName,
          dbEnvName: envRef.dbEnvName,
          secretRefName: envRef.secretRefName,
          listSecretsUsed: true,
        });
      }
      if (parsed.keyVaultUrl) appKeyVaultUrl = parsed.keyVaultUrl;
      if (parsed._appSecretValue) {
        appSecretValue = parsed._appSecretValue;
        secrets.push(appSecretValue);
      }
      parsed._appSecretValue = null;
    }

    // Fetch KV admin secret (14P path).
    vaultToken = await fetchImdsToken(httpRequest, 'imds_vault_token');
    secrets.push(vaultToken);
    const kvUrl = new URL(buildLockedKeyVaultSecretUrl());
    keyVaultRequestCount += 1;
    const kvRes = await invokeAuthorityHttp(httpRequest, {
      purpose: 'keyvault_secret',
      protocol: 'https:',
      hostname: kvUrl.hostname,
      port: 443,
      method: 'GET',
      path: `${kvUrl.pathname}${kvUrl.search}`,
      headers: Object.freeze({ Authorization: `Bearer ${vaultToken}` }),
    });
    let kvBody;
    try {
      kvBody = JSON.parse(kvRes.body);
    } catch (_) {
      return fail('kv_json_invalid', 'Key Vault JSON invalid', {
        activeRevisionName: rev.activeRevisionName,
        dbEnvName: envRef.dbEnvName,
        secretRefName: envRef.secretRefName,
        listSecretsUsed,
      });
    }
    if (!kvBody || typeof kvBody.value !== 'string' || !kvBody.value) {
      return fail('kv_secret_missing', 'Key Vault secret value missing', {
        activeRevisionName: rev.activeRevisionName,
        dbEnvName: envRef.dbEnvName,
        secretRefName: envRef.secretRefName,
        listSecretsUsed,
      });
    }
    kvSecretValue = kvBody.value;
    secrets.push(kvSecretValue);
    try { kvBody.value = null; } catch (_) { /* ignore */ }

    // Compare authority in memory.
    let comparison;
    const appKvUrlMatch = Boolean(
      appKeyVaultUrl
      && normalizeKeyVaultSecretUrl(appKeyVaultUrl) === lockedKeyVaultSecretUrlNormalized(),
    );

    if (appSecretValue) {
      comparison = compareDsnAuthorityInMemory(appSecretValue, kvSecretValue);
    } else if (appKeyVaultUrl) {
      comparison = compareKeyVaultRefAuthority(appKeyVaultUrl, kvSecretValue);
    } else if (envRef.secretRefName === AUTHORITY_LOCKS.secretName) {
      // secretRef name matches locked KV secret name but no keyVaultUrl/value —
      // ambiguous: cannot prove resolved value authority.
      return fail('secret_ref_ambiguity', 'secretRef name matches but resolved authority unproven', {
        activeRevisionName: rev.activeRevisionName,
        dbEnvName: envRef.dbEnvName,
        secretRefName: envRef.secretRefName,
        secretRefAmbiguous: true,
        listSecretsUsed,
        appSecretKeyVaultUrlMatchesLocked: false,
      });
    } else {
      return fail('secret_ref_mismatch', 'cannot resolve app secret authority', {
        activeRevisionName: rev.activeRevisionName,
        dbEnvName: envRef.dbEnvName,
        secretRefName: envRef.secretRefName,
        listSecretsUsed,
      });
    }

    // Zero app secret value after compare.
    appSecretValue = null;

    if (comparison.sameTarget !== true) {
      kvSecretValue = null;
      return pickSafe(redactDeep({
        ok: false,
        code: 'mismatched_app_kv_target',
        sameTarget: false,
        sameTargetReason: comparison.sameTargetReason,
        blocker: 'mismatched_app_kv_target',
        liveMutation: false,
        schemaMutation: false,
        dataMutation: false,
        ledgerWritten: false,
        kvMutation: false,
        rbacMutation: false,
        networkMutation: false,
        firewallAction: false,
        usedLiveHttp,
        realImdsCall: true,
        realArmCall: true,
        realKeyVaultCall: true,
        realPostgresCall: false,
        ...getTargetAuthorityCounters(),
        subscriptionId: AUTHORITY_LOCKS.subscriptionId,
        resourceGroup: AUTHORITY_LOCKS.resourceGroup,
        containerAppName: AUTHORITY_LOCKS.containerAppName,
        activeRevisionName: rev.activeRevisionName,
        activeRevisionCount: 1,
        dbEnvName: envRef.dbEnvName,
        secretRefName: envRef.secretRefName,
        secretRefAmbiguous: false,
        appSecretKeyVaultUrlMatchesLocked: appKvUrlMatch,
        listSecretsUsed,
        kvSecretName: AUTHORITY_LOCKS.secretName,
        keyVaultName: AUTHORITY_LOCKS.keyVaultName,
        postgresHost: AUTHORITY_LOCKS.postgresHost,
        database: AUTHORITY_LOCKS.database,
        port: AUTHORITY_LOCKS.port,
        sslmode: AUTHORITY_LOCKS.sslmode,
        applicationName: APPLICATION_NAME,
        managedIdentityName: AUTHORITY_LOCKS.managedIdentityName,
        credentialSource: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
        hostMatch: comparison.hostMatch,
        portMatch: comparison.portMatch,
        databaseMatch: comparison.databaseMatch,
        usernameEqual: comparison.usernameEqual,
        passwordEqual: comparison.passwordEqual,
        tlsSemanticsMatch: comparison.tlsSemanticsMatch,
        kvTargetValid: comparison.kvTargetValid,
        appTargetValid: comparison.appTargetValid,
        comparisonMode: comparison.comparisonMode,
        driftClassification: classifyDrift(false, null, null),
        reconciliationPathHint: 'resolve_target_authority_before_schema_reconcile',
        errors: comparison.errors || [],
        closed: true,
        committed: false,
        rolledBack: false,
      }, secrets));
    }

    if (options.skipPostgres === true) {
      // Offline GREEN path that only proves authority compare.
      const userPass = parseSunsetDatabaseUrlSecretInMemory(kvSecretValue);
      kvSecretValue = null;
      armToken = null;
      vaultToken = null;
      return pickSafe({
        ok: true,
        code: 'same_target_authority_ok',
        sameTarget: true,
        sameTargetReason: comparison.sameTargetReason,
        blocker: null,
        liveMutation: false,
        schemaMutation: false,
        dataMutation: false,
        ledgerWritten: false,
        kvMutation: false,
        rbacMutation: false,
        networkMutation: false,
        firewallAction: false,
        usedLiveHttp,
        realImdsCall: true,
        realArmCall: true,
        realKeyVaultCall: true,
        realPostgresCall: false,
        ...getTargetAuthorityCounters(),
        subscriptionId: AUTHORITY_LOCKS.subscriptionId,
        resourceGroup: AUTHORITY_LOCKS.resourceGroup,
        containerAppName: AUTHORITY_LOCKS.containerAppName,
        activeRevisionName: rev.activeRevisionName,
        activeRevisionCount: 1,
        dbEnvName: envRef.dbEnvName,
        secretRefName: envRef.secretRefName,
        secretRefAmbiguous: false,
        appSecretKeyVaultUrlMatchesLocked: appKvUrlMatch,
        listSecretsUsed,
        kvSecretName: AUTHORITY_LOCKS.secretName,
        keyVaultName: AUTHORITY_LOCKS.keyVaultName,
        postgresHost: AUTHORITY_LOCKS.postgresHost,
        database: AUTHORITY_LOCKS.database,
        port: AUTHORITY_LOCKS.port,
        sslmode: AUTHORITY_LOCKS.sslmode,
        applicationName: APPLICATION_NAME,
        managedIdentityName: AUTHORITY_LOCKS.managedIdentityName,
        credentialSource: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
        hostMatch: comparison.hostMatch,
        portMatch: comparison.portMatch,
        databaseMatch: comparison.databaseMatch,
        usernameEqual: comparison.usernameEqual,
        passwordEqual: comparison.passwordEqual,
        tlsSemanticsMatch: comparison.tlsSemanticsMatch,
        kvTargetValid: comparison.kvTargetValid,
        appTargetValid: comparison.appTargetValid,
        comparisonMode: comparison.comparisonMode,
        sessionReadOnly: null,
        transactionReadOnly: null,
        schemaInventory: null,
        ledgerSummary: null,
        observerOutcome: null,
        driftClassification: null,
        reconciliationPathHint: null,
        errors: [],
        closed: true,
        committed: false,
        rolledBack: false,
        _credentialParseOk: userPass.ok === true,
      });
    }

    if (!options.expectedContract || !options.expectedContract.snapshot) {
      kvSecretValue = null;
      return fail('expected_contract_required', 'expectedContract.snapshot required for PG session', {
        sameTarget: true,
        sameTargetReason: comparison.sameTargetReason,
        activeRevisionName: rev.activeRevisionName,
        dbEnvName: envRef.dbEnvName,
        secretRefName: envRef.secretRefName,
      });
    }

    // Open one read-only PG session with KV admin credentials.
    const creds = parseSunsetDatabaseUrlSecretInMemory(kvSecretValue);
    if (!creds.ok) {
      kvSecretValue = null;
      return fail('kv_target_invalid', 'KV DSN failed locked target parse', {
        sameTarget: true,
        activeRevisionName: rev.activeRevisionName,
      });
    }
    // Private handoff fields from parseSunsetDatabaseUrlSecretInMemory
    const user = creds._user;
    const password = creds._password;
    secrets.push(user, password);
    zeroPrivateCredentialRefs(creds);
    kvSecretValue = null;
    armToken = null;
    vaultToken = null;

    const ClientFactory = options.ClientFactory || Client;
    const cfg = buildLockedPgClientConfig(user, password);
    // Zero locals after config build
    let _u = user;
    let _p = password;
    _u = null;
    _p = null;

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
    const inv = await runObserverAndInventory(
      client,
      options.expectedContract,
      options.expectedChecksumById || null,
    );

    if (!inv.sessionReadOnly || !inv.transactionReadOnly) {
      queryCalls += 1;
      try {
        await client.query('ROLLBACK');
        rolledBack = true;
      } catch (_) { /* ignore */ }
      const drift = classifyDrift(true, inv.schemaInventory, inv.observerOutcome);
      drift.code = 'observation_defect';
      drift.reason = 'transaction_read_only was not on';
      drift.reconciliationPathHint = 'fix_readonly_session_gate';
      return pickSafe({
        ok: false,
        code: 'session_not_read_only',
        sameTarget: true,
        sameTargetReason: comparison.sameTargetReason,
        blocker: 'session_not_read_only',
        liveMutation: false,
        schemaMutation: false,
        dataMutation: false,
        ledgerWritten: false,
        kvMutation: false,
        rbacMutation: false,
        networkMutation: false,
        firewallAction: false,
        usedLiveHttp,
        realImdsCall: true,
        realArmCall: true,
        realKeyVaultCall: true,
        realPostgresCall: true,
        ...getTargetAuthorityCounters(),
        subscriptionId: AUTHORITY_LOCKS.subscriptionId,
        resourceGroup: AUTHORITY_LOCKS.resourceGroup,
        containerAppName: AUTHORITY_LOCKS.containerAppName,
        activeRevisionName: rev.activeRevisionName,
        activeRevisionCount: 1,
        dbEnvName: envRef.dbEnvName,
        secretRefName: envRef.secretRefName,
        secretRefAmbiguous: false,
        appSecretKeyVaultUrlMatchesLocked: appKvUrlMatch,
        listSecretsUsed,
        kvSecretName: AUTHORITY_LOCKS.secretName,
        keyVaultName: AUTHORITY_LOCKS.keyVaultName,
        postgresHost: AUTHORITY_LOCKS.postgresHost,
        database: AUTHORITY_LOCKS.database,
        port: AUTHORITY_LOCKS.port,
        sslmode: AUTHORITY_LOCKS.sslmode,
        applicationName: APPLICATION_NAME,
        managedIdentityName: AUTHORITY_LOCKS.managedIdentityName,
        credentialSource: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
        hostMatch: true,
        portMatch: true,
        databaseMatch: true,
        usernameEqual: true,
        passwordEqual: true,
        tlsSemanticsMatch: true,
        kvTargetValid: true,
        appTargetValid: true,
        comparisonMode: comparison.comparisonMode,
        sessionReadOnly: false,
        transactionReadOnly: false,
        schemaInventory: inv.schemaInventory,
        ledgerSummary: inv.ledgerSummary,
        observerOutcome: inv.observerOutcome,
        driftClassification: drift,
        reconciliationPathHint: drift.reconciliationPathHint,
        errors: [{ code: 'session_not_read_only', message: 'BEGIN READ ONLY session gate failed' }],
        closed: false,
        committed: false,
        rolledBack: true,
      });
    }

    queryCalls += 1;
    await client.query('COMMIT');
    committed = true;

    const driftClassification = classifyDrift(
      true,
      inv.schemaInventory,
      inv.observerOutcome,
    );

    // End before building the secret-free result so counters reflect closure.
    try {
      endCalls += 1;
      await client.end();
      closed = true;
      client = null;
    } catch (_) {
      closed = true;
      client = null;
    }

    const ok = true; // authority proof succeeded; drift is classified, not a gate failure
    return pickSafe({
      ok,
      code: inv.observerOutcome && inv.observerOutcome.match
        ? 'same_target_authority_observer_match'
        : 'same_target_authority_observer_drift',
      sameTarget: true,
      sameTargetReason: comparison.sameTargetReason,
      blocker: inv.observerOutcome && inv.observerOutcome.match ? null : 'observer_drift',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      rbacMutation: false,
      networkMutation: false,
      firewallAction: false,
      usedLiveHttp,
      realImdsCall: true,
      realArmCall: true,
      realKeyVaultCall: true,
      realPostgresCall: true,
      ...getTargetAuthorityCounters(),
      subscriptionId: AUTHORITY_LOCKS.subscriptionId,
      resourceGroup: AUTHORITY_LOCKS.resourceGroup,
      containerAppName: AUTHORITY_LOCKS.containerAppName,
      activeRevisionName: rev.activeRevisionName,
      activeRevisionCount: 1,
      dbEnvName: envRef.dbEnvName,
      secretRefName: envRef.secretRefName,
      secretRefAmbiguous: false,
      appSecretKeyVaultUrlMatchesLocked: appKvUrlMatch,
      listSecretsUsed,
      kvSecretName: AUTHORITY_LOCKS.secretName,
      keyVaultName: AUTHORITY_LOCKS.keyVaultName,
      postgresHost: AUTHORITY_LOCKS.postgresHost,
      database: AUTHORITY_LOCKS.database,
      port: AUTHORITY_LOCKS.port,
      sslmode: AUTHORITY_LOCKS.sslmode,
      applicationName: APPLICATION_NAME,
      managedIdentityName: AUTHORITY_LOCKS.managedIdentityName,
      credentialSource: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
      hostMatch: true,
      portMatch: true,
      databaseMatch: true,
      usernameEqual: true,
      passwordEqual: true,
      tlsSemanticsMatch: true,
      kvTargetValid: true,
      appTargetValid: true,
      comparisonMode: comparison.comparisonMode,
      sessionReadOnly: true,
      transactionReadOnly: true,
      schemaInventory: inv.schemaInventory,
      ledgerSummary: inv.ledgerSummary,
      observerOutcome: inv.observerOutcome,
      driftClassification,
      reconciliationPathHint: driftClassification.reconciliationPathHint,
      errors: [],
      closed: true,
      committed: true,
      rolledBack: false,
    });
  } catch (err) {
    const sanitized = sanitizeAuthorityError(err, secrets);
    if (client && !closed) {
      try {
        await client.query('ROLLBACK');
        rolledBack = true;
      } catch (_) { /* ignore */ }
    }
    return fail(sanitized.code, sanitized.message);
  } finally {
    zeroPrivateCredentialRefs({
      _token: armToken,
      _accessToken: vaultToken,
      _secretValue: kvSecretValue,
      _dsn: appSecretValue,
    });
    armToken = null;
    vaultToken = null;
    kvSecretValue = null;
    appSecretValue = null;
    if (client && !closed) {
      try {
        endCalls += 1;
        await client.end();
        closed = true;
      } catch (_) {
        closed = true;
      }
    }
  }
}

function zeroListSecretsValues(listBody) {
  const items = Array.isArray(listBody && listBody.value)
    ? listBody.value
    : (Array.isArray(listBody) ? listBody : []);
  for (const item of items) {
    if (item && typeof item === 'object') {
      if (Object.prototype.hasOwnProperty.call(item, 'value')) {
        try { item.value = null; } catch (_) { /* ignore */ }
      }
    }
  }
}

/**
 * Scripted fake Client for offline observer/inventory proofs.
 */
function createScriptedTargetAuthorityFakeClientFactory(script) {
  const s = script || {};
  function FakeClient() {
    // Counters are owned by executeActiveDbTargetAuthority — do not double-count here.
    this._ended = false;
    this.query = async (sql, params) => {
      const q = String(sql || '');
      if (/^BEGIN\s+READ\s+ONLY/i.test(q)) {
        return { rows: [] };
      }
      if (/^COMMIT/i.test(q) || /^ROLLBACK/i.test(q)) {
        return { rows: [] };
      }
      if (/transaction_read_only/i.test(q)) {
        return {
          rows: [{
            transaction_read_only: s.transactionReadOnly === false ? 'off' : 'on',
          }],
        };
      }
      if (/statement_timeout/i.test(q)) {
        return { rows: [{ statement_timeout: '30s' }] };
      }
      if (/lock_timeout/i.test(q)) {
        return { rows: [{ lock_timeout: '5s' }] };
      }
      if (/application_name/i.test(q)) {
        return { rows: [{ application_name: APPLICATION_NAME }] };
      }
      if (/object_type/i.test(q) && /pg_catalog\.pg_class/i.test(q)) {
        return {
          rows: s.inventoryRows || [
            { schema_name: 'public', object_type: 'table', object_count: s.publicTables != null ? s.publicTables : 2 },
            { schema_name: 'public', object_type: 'index', object_count: 1 },
          ],
        };
      }
      // Ledger EXISTS uses parameterized relname ($1) — table name is not in SQL text.
      if (/EXISTS/i.test(q) && /relname\s*=\s*\$1/i.test(q)) {
        const tableName = Array.isArray(params) ? String(params[0] || '') : '';
        if (!tableName || tableName === LEDGER_TABLE || /schema_migration_ledger/i.test(tableName)) {
          return { rows: [{ present: s.ledgerPresent !== false }] };
        }
      }
      if (/EXISTS/i.test(q) && /schema_migration_ledger/i.test(q)) {
        return { rows: [{ present: s.ledgerPresent !== false }] };
      }
      if (/COUNT\(\*\)/i.test(q) && /schema_migration_ledger/i.test(q)) {
        return { rows: [{ n: s.ledgerRowCount != null ? s.ledgerRowCount : 0 }] };
      }
      if (/checksum_sha256/i.test(q) && /schema_migration_ledger/i.test(q)) {
        return { rows: s.ledgerRows || [] };
      }
      // Introspection fallbacks — return empty product schema (sparse).
      return { rows: s.introspectionRows || [] };
    };
    this.connect = async () => {};
    this.end = async () => {
      this._ended = true;
    };
  }
  return FakeClient;
}

function printCliHelp() {
  return [
    'phase-d:active-db-target-authority — FOUNDATION Slice 14Q',
    'DEFAULT: refused (zero ARM / zero KV / zero PostgreSQL).',
    '',
    'Prove read-only whether active Staff API and KV admin path share exact PG authority.',
    'Requires dual Phase D flags + SUNSET_PHASE_D_TARGET_AUTHORITY=1 + managed-identity',
    'credential source + exact locked targets.',
    '',
    'One ARM GET + optional listSecrets POST + KV GET + one BEGIN READ ONLY pg session.',
    'Never prints/persists DSN, passwords, tokens, or secret versions.',
  ].join('\n');
}

module.exports = {
  PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED,
  ENV_TARGET_AUTHORITY,
  CLI_PROVE_TARGET_AUTHORITY,
  APPLICATION_NAME,
  AUTHORITY_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  evaluateTargetAuthorityGates,
  exactTargetAuthorityArgv,
  targetAuthorityEnv,
  parseArgvPairs,
  buildLockedImdsArmTokenUrl,
  buildLockedImdsVaultTokenUrl,
  buildLockedArmContainerAppPath,
  buildLockedArmListSecretsPath,
  buildLockedKeyVaultSecretUrl,
  normalizeKeyVaultSecretUrl,
  extractActiveRevision,
  extractDbEnvSecretRef,
  compareDsnAuthorityInMemory,
  compareKeyVaultRefAuthority,
  classifyDrift,
  createInjectedTargetAuthorityHttp,
  createLiveTargetAuthorityHttpRequest,
  createScriptedTargetAuthorityFakeClientFactory,
  executeActiveDbTargetAuthority,
  getTargetAuthorityCounters,
  resetTargetAuthorityCounters,
  printCliHelp,
  buildOfflineProofSunsetDatabaseUrl,
  // re-exports useful to prove script
  loadProtectedAdminCredentialsViaManagedIdentity,
  zeroPrivateCredentialRefs,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
  createInjectedManagedIdentityHttp,
};
