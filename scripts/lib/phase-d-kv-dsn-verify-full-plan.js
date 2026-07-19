'use strict';

/**
 * phase-d-kv-dsn-verify-full-plan — FOUNDATION Slice 14J
 *
 * Locked, recoverable operator plan to normalize only the existing Key Vault
 * secret luna-sunset-staging-kv/sunset-database-url from a TLS-deficient
 * PostgreSQL DSN to the same host/port/database/user/password with
 * sslmode=verify-full — without reading or mutating the live secret in this
 * slice.
 *
 * Future live adapter (offline-proven with injected HTTP only):
 *   IMDS GET → KV GET → (sslmode-only mutate in memory) → KV PUT (one) →
 *   verification KV GET → zero private refs.
 * Rollback: restore only the immediately previous version after separate
 * explicit approval. Live mutate / rollback hard-disabled here.
 *
 * Never exposes/persists/hashes/evidences DSN or credentials.
 * Never instantiates a pg Client. No retries. No delete/purge/disable.
 */

const {
  TARGETS,
  redactSecrets,
  redactDeep,
  REDACTED,
} = require('./phase-d-live-readonly-boundary');
const { parseDatabaseUrl } = require('./sunset-schema-observer');
const {
  MI_LOADER_LOCKS,
  buildLockedImdsTokenUrl,
  assertImdsRequestClientIdLocked,
} = require('./phase-d-managed-identity-credential-loader');

/**
 * Live KV mutate / rollback hard-disabled for Slice 14J.
 * Offline plan + injected-HTTP proof only — no live KV read/write.
 */
const PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED = false;
const PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED = false;

const ENV_DSN_PLAN = 'SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_PLAN';
const ENV_DSN_ROLLBACK = 'SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_ROLLBACK';
const CLI_PLAN_ONLY = '--plan-only';
const CLI_ROLLBACK_PLAN_ONLY = '--rollback-plan-only';

const DSN_PLAN_LOCKS = Object.freeze({
  subscriptionId: '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9',
  resourceGroup: 'luna-sunset-staging-rg',
  keyVaultName: 'luna-sunset-staging-kv',
  keyVaultHttpsUrl: 'https://luna-sunset-staging-kv.vault.azure.net',
  secretName: 'sunset-database-url',
  keyVaultApiVersion: '7.4',
  managedIdentityName: 'wh-staging-identity',
  managedIdentityClientId: MI_LOADER_LOCKS.managedIdentityClientId,
  managedIdentityPrincipalId: MI_LOADER_LOCKS.managedIdentityPrincipalId,
  imdsHost: MI_LOADER_LOCKS.imdsHost,
  imdsApiVersion: MI_LOADER_LOCKS.imdsApiVersion,
  vaultResourceAudience: MI_LOADER_LOCKS.vaultResourceAudience,
  postgresServer: TARGETS.postgresServer,
  postgresHost: TARGETS.postgresHost,
  database: TARGETS.database,
  port: TARGETS.port,
  targetSslmode: 'verify-full',
  mutationField: 'sslmode',
  putCountMax: 1,
  retries: 0,
});

const KEY_VAULT_RESOURCE_ID = (
  `/subscriptions/${DSN_PLAN_LOCKS.subscriptionId}`
  + `/resourceGroups/${DSN_PLAN_LOCKS.resourceGroup}`
  + `/providers/Microsoft.KeyVault/vaults/${DSN_PLAN_LOCKS.keyVaultName}`
);

const LOCKED_MUTATION_PLAN = Object.freeze({
  kind: 'sunset-phase-d-kv-dsn-verify-full-mutation-plan',
  slice: '14J',
  secretFree: true,
  liveMutateEnabled: false,
  liveMutation: false,
  operation: 'setSecretNewVersion',
  httpSequence: Object.freeze([
    'IMDS GET',
    'Key Vault secret GET',
    'Key Vault secret PUT',
    'Key Vault secret verification GET',
  ]),
  putCount: 1,
  retries: 0,
  subscriptionId: DSN_PLAN_LOCKS.subscriptionId,
  resourceGroup: DSN_PLAN_LOCKS.resourceGroup,
  keyVaultName: DSN_PLAN_LOCKS.keyVaultName,
  keyVaultResourceId: KEY_VAULT_RESOURCE_ID,
  secretName: DSN_PLAN_LOCKS.secretName,
  managedIdentityName: DSN_PLAN_LOCKS.managedIdentityName,
  managedIdentityClientId: DSN_PLAN_LOCKS.managedIdentityClientId,
  postgresHost: DSN_PLAN_LOCKS.postgresHost,
  postgresServer: DSN_PLAN_LOCKS.postgresServer,
  database: DSN_PLAN_LOCKS.database,
  port: DSN_PLAN_LOCKS.port,
  mutation: Object.freeze({
    field: 'sslmode',
    from: 'tls_deficient_any_non_verify_full',
    to: DSN_PLAN_LOCKS.targetSslmode,
    retainExact: Object.freeze(['host', 'port', 'database', 'username', 'password']),
    forbidden: Object.freeze([
      'host_change',
      'port_change',
      'database_change',
      'username_change',
      'password_change',
      'extra_query_param_change',
      'tags_mutation',
      'contentType_mutation',
      'delete',
      'purge',
      'disable',
      'retry',
      'pg_client',
    ]),
  }),
  notes: Object.freeze([
    'Normalize only sslmode → verify-full on existing sunset-database-url',
    'Same exact host/port/database/username/password retained in memory only',
    'One PUT new secret version; prior version ID retained for rollback',
    'Slice 14J is plan + offline proof only — zero live KV read/write',
  ]),
});

const LOCKED_ROLLBACK_PLAN = Object.freeze({
  kind: 'sunset-phase-d-kv-dsn-verify-full-rollback-plan',
  slice: '14J',
  secretFree: true,
  liveRollbackEnabled: false,
  liveMutation: false,
  operation: 'restoreImmediatelyPreviousSecretVersion',
  restoreScope: 'immediately_previous_version_only',
  requiresSeparateExplicitApproval: true,
  putCount: 1,
  retries: 0,
  subscriptionId: DSN_PLAN_LOCKS.subscriptionId,
  resourceGroup: DSN_PLAN_LOCKS.resourceGroup,
  keyVaultName: DSN_PLAN_LOCKS.keyVaultName,
  keyVaultResourceId: KEY_VAULT_RESOURCE_ID,
  secretName: DSN_PLAN_LOCKS.secretName,
  notes: Object.freeze([
    'Rollback restores only the immediately previous version after separate approval',
    'Default / wrong prior-version / wrong gates → zero writes',
    'Never delete/purge/disable; never arbitrary version restore',
    'Slice 14J does not execute live rollback',
  ]),
});

const SAFE_OUTPUT_KEYS = Object.freeze([
  'ok',
  'code',
  'planOnly',
  'rollbackPlanOnly',
  'liveMutateEnabled',
  'liveRollbackEnabled',
  'liveMutation',
  'kvWriteCount',
  'kvPutCount',
  'httpRequestCount',
  'imdsRequestCount',
  'keyVaultGetCount',
  'keyVaultPutCount',
  'subscriptionId',
  'resourceGroup',
  'keyVaultName',
  'keyVaultResourceId',
  'secretName',
  'managedIdentityName',
  'managedIdentityClientId',
  'postgresHost',
  'postgresServer',
  'database',
  'port',
  'targetSslmode',
  'sourceTlsDeficient',
  'sslmodeNormalized',
  'mutationField',
  'priorSecretVersionId',
  'newSecretVersionId',
  'rollbackPriorVersionId',
  'putCount',
  'retries',
  'httpSequence',
  'errors',
  'message',
  'note',
  'privateRefsZeroed',
  'pgClientInstantiated',
]);

const FORBIDDEN_ARGV_FLAGS = Object.freeze([
  '--apply',
  '--deploy',
  '--mutate',
  '--execute',
  '--live',
  '--value',
  '--secret-value',
  '--dsn',
  '--connection-string',
  '--database-url',
  '--url',
  '--token',
  '--access-token',
  '--version',
  '--secret-version',
  '--file',
  '--host',
  '--user',
  '--username',
  '--password',
  '--delete',
  '--purge',
  '--disable',
  '--content-type',
  '--tags',
  '--retry',
  '--retries',
  '--force',
  '--what-if',
  '--whatif',
]);

/** Process-local counters — prove default/wrong paths never write. */
let httpRequestCount = 0;
let imdsRequestCount = 0;
let keyVaultGetCount = 0;
let keyVaultPutCount = 0;
let kvWriteCount = 0;
let pgClientInstantiated = 0;

function getDsnPlanCounters() {
  return {
    httpRequestCount,
    imdsRequestCount,
    keyVaultGetCount,
    keyVaultPutCount,
    kvWriteCount,
    pgClientInstantiated,
  };
}

function resetDsnPlanCounters() {
  httpRequestCount = 0;
  imdsRequestCount = 0;
  keyVaultGetCount = 0;
  keyVaultPutCount = 0;
  kvWriteCount = 0;
  pgClientInstantiated = 0;
}

function buildLockedKeyVaultSecretUrl() {
  return (
    `${DSN_PLAN_LOCKS.keyVaultHttpsUrl}/secrets/`
    + `${encodeURIComponent(DSN_PLAN_LOCKS.secretName)}`
    + `?api-version=${DSN_PLAN_LOCKS.keyVaultApiVersion}`
  );
}

function extractVersionIdFromSecretId(secretId) {
  const raw = String(secretId || '');
  // https://{vault}/secrets/{name}/{version}
  const m = raw.match(/\/secrets\/[^/]+\/([0-9a-fA-F-]{8,})$/);
  return m ? m[1] : null;
}

function argvFlagValue(argv, flag) {
  const arr = Array.isArray(argv) ? argv : [];
  const i = arr.indexOf(flag);
  if (i < 0 || i + 1 >= arr.length) return null;
  return String(arr[i + 1]);
}

function hasForbiddenArgv(argv) {
  const arr = Array.isArray(argv) ? argv : [];
  return FORBIDDEN_ARGV_FLAGS.filter((f) => arr.includes(f));
}

function sanitizePlanError(err, secrets) {
  const list = (secrets || []).filter(Boolean).map(String);
  const raw = String((err && err.message) || err || 'kv_dsn_plan_failed').slice(0, 240);
  const message = redactSecrets(raw, list)
    .replace(/postgres(?:ql)?:\/\/[^:\s/@]+:[^@\s/]+@/gi, `postgresql://${REDACTED}:`)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g, REDACTED)
    .replace(/(password|passwd|pwd)\s*[=:]\s*([^\s&;,"']+)/gi, `$1=${REDACTED}`)
    .replace(/(user(name)?)\s*[=:]\s*([^\s&;,"']+)/gi, `$1=${REDACTED}`)
    .replace(/(access_token|client_secret|token)\s*[=:]\s*([^\s&;,"']+)/gi, `$1=${REDACTED}`);
  return Object.assign(new Error(message), {
    code: (err && err.code) || 'kv_dsn_plan_failed',
  });
}

function zeroPrivateRefs(bag) {
  if (!bag || typeof bag !== 'object') return { zeroed: false };
  const keys = [
    '_user',
    '_password',
    '_token',
    '_accessToken',
    '_dsn',
    '_secretValue',
    '_normalizedDsn',
    '_priorValue',
    'password',
    'user',
    'token',
    'access_token',
    'value',
  ];
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(bag, k)) {
      try { bag[k] = null; } catch (_) { /* ignore */ }
    }
  }
  return { zeroed: true };
}

/**
 * Parse current secret DSN in memory. Require exact host/port/database and
 * credentials. Require TLS-deficient (sslmode !== verify-full). Never returns
 * the raw DSN in public fields.
 */
function parseTlsDeficientSunsetDsnInMemory(secretValue) {
  const raw = String(secretValue == null ? '' : secretValue);
  const secretsForRedact = [raw];
  try {
    const parsed = parseDatabaseUrl(raw);
    if (!parsed.ok) {
      return {
        ok: false,
        errors: [{ code: 'secret_dsn_parse_failed', message: 'secret is not a usable PostgreSQL DSN' }],
      };
    }
    const p = parsed.parsed;
    if (!p.user || !p.hasPassword) {
      return {
        ok: false,
        errors: [{ code: 'secret_dsn_credentials_missing', message: 'secret must include user and password' }],
      };
    }
    if (p.host !== DSN_PLAN_LOCKS.postgresHost) {
      return {
        ok: false,
        errors: [{ code: 'secret_wrong_postgres_host', message: 'host must match locked Sunset staging host' }],
      };
    }
    if (Number(p.port) !== DSN_PLAN_LOCKS.port) {
      return {
        ok: false,
        errors: [{ code: 'secret_wrong_port', message: `port must be exactly ${DSN_PLAN_LOCKS.port}` }],
      };
    }
    if (p.database !== DSN_PLAN_LOCKS.database) {
      return {
        ok: false,
        errors: [{ code: 'secret_wrong_database', message: 'database must be sunset_staging' }],
      };
    }
    if (p.sslmode === DSN_PLAN_LOCKS.targetSslmode) {
      return {
        ok: false,
        errors: [{
          code: 'secret_already_verify_full',
          message: 'secret already has sslmode=verify-full — no mutation',
        }],
      };
    }
    // TLS-deficient: missing, require, prefer, allow, disable, verify-ca, etc.
    const url = new URL(raw);
    const user = decodeURIComponent(url.username || '');
    const password = decodeURIComponent(url.password || '');
    secretsForRedact.push(user, password);
    if (!user || !password) {
      return {
        ok: false,
        errors: [{ code: 'secret_dsn_credentials_missing', message: 'secret must include user and password' }],
      };
    }
    // Snapshot other query params (excluding sslmode) for exact retention check.
    const otherParams = [];
    url.searchParams.forEach((v, k) => {
      if (String(k).toLowerCase() !== 'sslmode') otherParams.push([String(k), String(v)]);
    });
    return {
      ok: true,
      errors: [],
      sourceTlsDeficient: true,
      sslmodeBefore: p.sslmode || null,
      _user: user,
      _password: password,
      _dsn: raw,
      _otherQueryParams: otherParams,
    };
  } catch (err) {
    const safe = sanitizePlanError(err, secretsForRedact);
    return { ok: false, errors: [{ code: safe.code, message: safe.message }] };
  }
}

/**
 * Build normalized DSN: same host/port/db/user/password; only sslmode → verify-full.
 * Rejects any attempt to change host/db/user/password or other query params.
 */
function normalizeSslmodeOnlyInMemory(parsedBag, overrides = {}) {
  if (!parsedBag || !parsedBag.ok) {
    return {
      ok: false,
      errors: (parsedBag && parsedBag.errors) || [{ code: 'normalize_input_invalid', message: 'parsed bag required' }],
    };
  }
  if (overrides.host != null || overrides.port != null || overrides.database != null
    || overrides.user != null || overrides.password != null
    || overrides.username != null || overrides.extraQuery != null) {
    return {
      ok: false,
      errors: [{ code: 'host_db_user_password_change_rejected', message: 'may not change host/port/db/user/password/extra query' }],
    };
  }
  const user = parsedBag._user;
  const password = parsedBag._password;
  const other = Array.isArray(parsedBag._otherQueryParams) ? parsedBag._otherQueryParams : [];
  const q = new URLSearchParams();
  // Preserve non-sslmode params in original order, then set sslmode last (or replace).
  for (const [k, v] of other) {
    q.append(k, v);
  }
  q.set('sslmode', DSN_PLAN_LOCKS.targetSslmode);
  // Assemble without a contiguous user:pass@ literal (secret-scan safe).
  const normalized = [
    'postgresql://',
    encodeURIComponent(user),
    ':',
    encodeURIComponent(password),
    '@',
    DSN_PLAN_LOCKS.postgresHost,
    ':',
    String(DSN_PLAN_LOCKS.port),
    '/',
    DSN_PLAN_LOCKS.database,
    '?',
    q.toString(),
  ].join('');
  // Verify only sslmode changed relative to locks.
  const check = parseDatabaseUrl(normalized);
  if (!check.ok
    || check.parsed.host !== DSN_PLAN_LOCKS.postgresHost
    || Number(check.parsed.port) !== DSN_PLAN_LOCKS.port
    || check.parsed.database !== DSN_PLAN_LOCKS.database
    || check.parsed.sslmode !== DSN_PLAN_LOCKS.targetSslmode) {
    return {
      ok: false,
      errors: [{ code: 'normalize_integrity_failed', message: 'normalized DSN failed lock checks' }],
    };
  }
  const nu = new URL(normalized);
  for (const [k, v] of other) {
    if (nu.searchParams.get(k) !== v) {
      return {
        ok: false,
        errors: [{ code: 'extra_query_change_rejected', message: 'non-sslmode query params must be retained unchanged' }],
      };
    }
  }
  return {
    ok: true,
    errors: [],
    sslmodeNormalized: true,
    targetSslmode: DSN_PLAN_LOCKS.targetSslmode,
    _normalizedDsn: normalized,
    _user: user,
    _password: password,
  };
}

/**
 * Validate a verification GET secret value in memory: exact target + verify-full
 * + same user/password as prior. Then caller zeros refs.
 */
function validateNormalizedSecretInMemory(secretValue, expectedUser, expectedPassword) {
  const raw = String(secretValue == null ? '' : secretValue);
  const secrets = [raw, expectedUser, expectedPassword].filter(Boolean);
  try {
    const parsed = parseDatabaseUrl(raw);
    if (!parsed.ok) {
      return { ok: false, errors: [{ code: 'verify_dsn_parse_failed', message: 'verification secret not a DSN' }] };
    }
    const p = parsed.parsed;
    if (p.host !== DSN_PLAN_LOCKS.postgresHost) {
      return { ok: false, errors: [{ code: 'verify_wrong_host', message: 'verification host mismatch' }] };
    }
    if (Number(p.port) !== DSN_PLAN_LOCKS.port) {
      return { ok: false, errors: [{ code: 'verify_wrong_port', message: 'verification port mismatch' }] };
    }
    if (p.database !== DSN_PLAN_LOCKS.database) {
      return { ok: false, errors: [{ code: 'verify_wrong_database', message: 'verification database mismatch' }] };
    }
    if (p.sslmode !== DSN_PLAN_LOCKS.targetSslmode) {
      return { ok: false, errors: [{ code: 'verify_tls_not_verify_full', message: 'verification sslmode must be verify-full' }] };
    }
    const url = new URL(raw);
    const user = decodeURIComponent(url.username || '');
    const password = decodeURIComponent(url.password || '');
    if (user !== expectedUser || password !== expectedPassword) {
      return {
        ok: false,
        errors: [{ code: 'verify_credentials_changed', message: 'user/password must be unchanged' }],
      };
    }
    return {
      ok: true,
      errors: [],
      targetSslmode: DSN_PLAN_LOCKS.targetSslmode,
      postgresHost: DSN_PLAN_LOCKS.postgresHost,
      database: DSN_PLAN_LOCKS.database,
      port: DSN_PLAN_LOCKS.port,
    };
  } catch (err) {
    const safe = sanitizePlanError(err, secrets);
    return { ok: false, errors: [{ code: safe.code, message: safe.message }] };
  }
}

function buildLockedMutationPlan() {
  return { ...LOCKED_MUTATION_PLAN, mutation: { ...LOCKED_MUTATION_PLAN.mutation } };
}

function buildLockedRollbackPlan(priorSecretVersionId = null) {
  return {
    ...LOCKED_ROLLBACK_PLAN,
    priorSecretVersionId: priorSecretVersionId || null,
    rollbackPriorVersionId: priorSecretVersionId || null,
  };
}

function mutationPlanMatchesLocked(plan) {
  const locked = buildLockedMutationPlan();
  if (!plan || typeof plan !== 'object') return false;
  return (
    plan.subscriptionId === locked.subscriptionId
    && plan.resourceGroup === locked.resourceGroup
    && plan.keyVaultName === locked.keyVaultName
    && plan.secretName === locked.secretName
    && plan.postgresHost === locked.postgresHost
    && plan.database === locked.database
    && plan.port === locked.port
    && plan.putCount === 1
    && plan.retries === 0
    && plan.liveMutateEnabled === false
    && plan.liveMutation === false
    && plan.operation === 'setSecretNewVersion'
    && plan.mutation
    && plan.mutation.field === 'sslmode'
    && plan.mutation.to === 'verify-full'
  );
}

function evaluateDsnPlanGates({ env = process.env, argv = [] } = {}) {
  const errors = [];
  const forbidden = hasForbiddenArgv(argv);
  if (forbidden.length) {
    errors.push({
      code: 'forbidden_argv',
      message: `forbidden flags: ${forbidden.join(', ')}`,
      flags: forbidden,
    });
  }

  const planOnly = argv.includes(CLI_PLAN_ONLY);
  const rollbackPlanOnly = argv.includes(CLI_ROLLBACK_PLAN_ONLY);

  if (planOnly && rollbackPlanOnly) {
    errors.push({
      code: 'mode_conflict',
      message: 'cannot combine --plan-only and --rollback-plan-only',
    });
  }

  if (planOnly) {
    if (String(env[ENV_DSN_PLAN] || '') !== '1') {
      errors.push({ code: 'env_required', message: `${ENV_DSN_PLAN}=1 required` });
    }
  } else if (rollbackPlanOnly) {
    if (String(env[ENV_DSN_ROLLBACK] || '') !== '1') {
      errors.push({ code: 'rollback_env_required', message: `${ENV_DSN_ROLLBACK}=1 required` });
    }
  } else {
    errors.push({
      code: 'plan_only_required',
      message: `${CLI_PLAN_ONLY} or ${CLI_ROLLBACK_PLAN_ONLY} required`,
    });
  }

  const subscription = argvFlagValue(argv, '--subscription');
  const resourceGroup = argvFlagValue(argv, '--resource-group');
  const keyVault = argvFlagValue(argv, '--key-vault');
  const secretName = argvFlagValue(argv, '--secret-name');
  const managedIdentity = argvFlagValue(argv, '--managed-identity');
  const postgresServer = argvFlagValue(argv, '--postgres-server');
  const database = argvFlagValue(argv, '--database');

  if (subscription !== DSN_PLAN_LOCKS.subscriptionId) {
    errors.push({ code: 'subscription_rejected', message: 'exact --subscription required' });
  }
  if (resourceGroup !== DSN_PLAN_LOCKS.resourceGroup) {
    errors.push({ code: 'resource_group_rejected', message: 'exact --resource-group required' });
  }
  if (keyVault !== DSN_PLAN_LOCKS.keyVaultName) {
    errors.push({ code: 'vault_rejected', message: 'exact --key-vault required' });
  }
  if (secretName !== DSN_PLAN_LOCKS.secretName) {
    errors.push({ code: 'secret_name_rejected', message: 'exact --secret-name sunset-database-url required' });
  }
  if (managedIdentity !== DSN_PLAN_LOCKS.managedIdentityName) {
    errors.push({ code: 'identity_rejected', message: 'exact --managed-identity required' });
  }
  if (postgresServer !== DSN_PLAN_LOCKS.postgresServer) {
    errors.push({ code: 'postgres_server_rejected', message: 'exact --postgres-server required' });
  }
  if (database !== DSN_PLAN_LOCKS.database) {
    errors.push({ code: 'database_rejected', message: 'exact --database required' });
  }

  // Reject arbitrary value/DSN/url/token/version/file via argv presence already in forbidden list.
  // Also reject unexpected --prior-version-id on mutation plan path.
  const priorVersion = argvFlagValue(argv, '--prior-version-id');
  if (planOnly && priorVersion != null) {
    errors.push({
      code: 'prior_version_on_mutation_plan_rejected',
      message: '--prior-version-id only valid on rollback-plan-only',
    });
  }
  if (rollbackPlanOnly) {
    if (priorVersion == null || priorVersion === '') {
      errors.push({
        code: 'prior_version_id_required',
        message: 'rollback-plan-only requires --prior-version-id <safe-id>',
      });
    } else if (!/^[0-9a-fA-F-]{8,}$/.test(priorVersion)) {
      errors.push({
        code: 'prior_version_id_rejected',
        message: 'prior-version-id must be a safe version id shape',
      });
    }
  }

  if (PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED === true) {
    errors.push({
      code: 'live_mutate_must_stay_disabled',
      message: 'Slice 14J live mutate must remain false',
    });
  }

  const ok = errors.length === 0;
  return {
    ok,
    code: ok
      ? (rollbackPlanOnly ? 'dsn_rollback_plan_gates_ok' : 'dsn_plan_gates_ok')
      : 'dsn_plan_gates_rejected',
    errors,
    planOnly,
    rollbackPlanOnly,
    priorSecretVersionId: rollbackPlanOnly ? priorVersion : null,
    liveMutateEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED,
    liveRollbackEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED,
    liveMutation: false,
    kvWriteCount: getDsnPlanCounters().kvWriteCount,
  };
}

/**
 * Reject mutation candidates that broaden scope or change forbidden fields.
 */
function evaluateMutationCandidate(candidate = {}) {
  const errors = [];
  const c = candidate && typeof candidate === 'object' ? candidate : {};

  if (c.operation === 'delete' || c.delete === true || c.purge === true || c.disable === true) {
    errors.push({ code: 'delete_purge_disable_rejected', message: 'delete/purge/disable forbidden' });
  }
  if (c.retries != null && Number(c.retries) !== 0) {
    errors.push({ code: 'retries_rejected', message: 'retries must be 0' });
  }
  if (c.putCount != null && Number(c.putCount) !== 1) {
    errors.push({ code: 'put_count_rejected', message: 'putCount must be exactly 1' });
  }
  if (c.tagsMutation === true || c.contentTypeMutation === true
    || c.tags != null || c.contentType != null) {
    errors.push({ code: 'tags_content_type_mutation_rejected', message: 'tags/contentType mutations forbidden' });
  }
  if (c.hostChange === true || c.databaseChange === true || c.userChange === true
    || c.passwordChange === true || c.portChange === true) {
    errors.push({ code: 'host_db_user_password_change_rejected', message: 'host/db/user/password/port changes forbidden' });
  }
  if (c.extraQueryChange === true) {
    errors.push({ code: 'extra_query_change_rejected', message: 'extra query changes forbidden' });
  }
  if (c.secretName != null && c.secretName !== DSN_PLAN_LOCKS.secretName) {
    errors.push({ code: 'secret_name_rejected', message: 'secret name must be sunset-database-url' });
  }
  if (c.keyVaultName != null && c.keyVaultName !== DSN_PLAN_LOCKS.keyVaultName) {
    errors.push({ code: 'vault_rejected', message: 'key vault must match lock' });
  }
  if (c.subscriptionId != null && c.subscriptionId !== DSN_PLAN_LOCKS.subscriptionId) {
    errors.push({ code: 'subscription_rejected', message: 'subscription must match lock' });
  }
  if (c.pgClient === true || c.postgresMutation === true) {
    errors.push({ code: 'pg_client_rejected', message: 'pg Client forbidden' });
  }
  if (c.arbitraryDsn === true || c.callerValue === true || c.callerToken === true
    || c.callerFile === true || c.callerUrl === true) {
    errors.push({ code: 'arbitrary_value_rejected', message: 'arbitrary value/DSN/url/token/file forbidden' });
  }
  if (c.rollbackVersion != null && c.rollbackMode === true) {
    // Rollback may only target immediately previous version — not arbitrary.
    if (c.immediatelyPrevious !== true) {
      errors.push({
        code: 'arbitrary_version_rollback_rejected',
        message: 'rollback may restore only immediately previous version',
      });
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    code: ok ? 'mutation_candidate_ok' : 'mutation_candidate_rejected',
    errors,
    liveMutation: false,
    kvWriteCount: getDsnPlanCounters().kvWriteCount,
  };
}

function safePlanOutput(plan, extra = {}) {
  const counters = getDsnPlanCounters();
  return {
    ok: true,
    code: 'dsn_verify_full_plan_only_ok',
    planOnly: true,
    rollbackPlanOnly: false,
    liveMutateEnabled: false,
    liveRollbackEnabled: false,
    liveMutation: false,
    kvWriteCount: counters.kvWriteCount,
    kvPutCount: counters.keyVaultPutCount,
    httpRequestCount: counters.httpRequestCount,
    putCount: 1,
    retries: 0,
    subscriptionId: plan.subscriptionId,
    resourceGroup: plan.resourceGroup,
    keyVaultName: plan.keyVaultName,
    keyVaultResourceId: plan.keyVaultResourceId,
    secretName: plan.secretName,
    managedIdentityName: plan.managedIdentityName,
    managedIdentityClientId: plan.managedIdentityClientId,
    postgresHost: plan.postgresHost,
    postgresServer: plan.postgresServer,
    database: plan.database,
    port: plan.port,
    targetSslmode: DSN_PLAN_LOCKS.targetSslmode,
    mutationField: 'sslmode',
    httpSequence: [...LOCKED_MUTATION_PLAN.httpSequence],
    pgClientInstantiated: counters.pgClientInstantiated,
    note: 'Plan-only — zero live KV read/write (no mutate/rollback)',
    ...extra,
  };
}

function safeRollbackPlanOutput(plan, extra = {}) {
  const counters = getDsnPlanCounters();
  return {
    ok: true,
    code: 'dsn_verify_full_rollback_plan_only_ok',
    planOnly: false,
    rollbackPlanOnly: true,
    liveMutateEnabled: false,
    liveRollbackEnabled: false,
    liveMutation: false,
    kvWriteCount: counters.kvWriteCount,
    kvPutCount: counters.keyVaultPutCount,
    httpRequestCount: counters.httpRequestCount,
    putCount: 1,
    retries: 0,
    subscriptionId: plan.subscriptionId,
    resourceGroup: plan.resourceGroup,
    keyVaultName: plan.keyVaultName,
    keyVaultResourceId: plan.keyVaultResourceId,
    secretName: plan.secretName,
    priorSecretVersionId: plan.priorSecretVersionId || null,
    rollbackPriorVersionId: plan.rollbackPriorVersionId || null,
    note: 'Rollback plan-only — requires separate approval; zero live writes',
    ...extra,
  };
}

/**
 * Execute plan-only path. Never calls Azure / KV. Never mutates secrets.
 */
function executeDsnVerifyFullPlanOnly({ env = process.env, argv = [] } = {}) {
  const gates = evaluateDsnPlanGates({ env, argv });
  if (!gates.ok) {
    return {
      ok: false,
      code: gates.code,
      planOnly: gates.planOnly === true,
      rollbackPlanOnly: gates.rollbackPlanOnly === true,
      liveMutateEnabled: false,
      liveRollbackEnabled: false,
      liveMutation: false,
      kvWriteCount: getDsnPlanCounters().kvWriteCount,
      errors: gates.errors,
      message: 'DSN verify-full plan gates rejected — zero KV writes',
      pgClientInstantiated: 0,
    };
  }

  if (gates.rollbackPlanOnly) {
    const plan = buildLockedRollbackPlan(gates.priorSecretVersionId);
    if (PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED || argv.includes('--apply')) {
      return {
        ok: false,
        code: 'live_rollback_disabled',
        rollbackPlanOnly: true,
        liveMutation: false,
        kvWriteCount: getDsnPlanCounters().kvWriteCount,
        errors: [{ code: 'live_rollback_disabled', message: 'Slice 14J cannot execute live rollback' }],
      };
    }
    return safeRollbackPlanOutput(plan);
  }

  const plan = buildLockedMutationPlan();
  if (!mutationPlanMatchesLocked(plan)) {
    return {
      ok: false,
      code: 'locked_plan_integrity_failed',
      planOnly: true,
      liveMutation: false,
      kvWriteCount: getDsnPlanCounters().kvWriteCount,
      errors: [{ code: 'locked_plan_integrity_failed', message: 'internal locked plan mismatch' }],
    };
  }

  if (PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED || argv.includes('--apply') || argv.includes('--mutate')) {
    return {
      ok: false,
      code: 'live_mutate_disabled',
      planOnly: true,
      liveMutation: false,
      kvWriteCount: getDsnPlanCounters().kvWriteCount,
      errors: [{ code: 'live_mutate_disabled', message: 'Slice 14J cannot mutate live KV' }],
    };
  }

  return safePlanOutput(plan);
}

/**
 * Future live adapter — offline-proven with injected httpRequest only.
 * Live mutate remains hard-disabled: without inject, refuses (zero writes).
 *
 * Exact success sequence: IMDS GET + KV GET + KV PUT + verification GET.
 * One PUT only. Secret-free output. Prior-version safe ID only.
 */
async function executeDsnNormalizeAdapter({ httpRequest = null } = {}) {
  const countersBefore = getDsnPlanCounters();
  const secrets = [];
  let token = null;
  let secretValue = null;
  let normalizedDsn = null;
  let user = null;
  let password = null;
  const privateBag = {};

  const fail = (code, message, extra = {}) => {
    zeroPrivateRefs(privateBag);
    token = null;
    secretValue = null;
    normalizedDsn = null;
    user = null;
    password = null;
    const counters = getDsnPlanCounters();
    return redactDeep({
      ok: false,
      code,
      message,
      liveMutateEnabled: PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED,
      liveMutation: false,
      kvWriteCount: counters.kvWriteCount - countersBefore.kvWriteCount,
      kvPutCount: counters.keyVaultPutCount - countersBefore.keyVaultPutCount,
      httpRequestCount: counters.httpRequestCount - countersBefore.httpRequestCount,
      imdsRequestCount: counters.imdsRequestCount - countersBefore.imdsRequestCount,
      keyVaultGetCount: counters.keyVaultGetCount - countersBefore.keyVaultGetCount,
      keyVaultPutCount: counters.keyVaultPutCount - countersBefore.keyVaultPutCount,
      pgClientInstantiated: counters.pgClientInstantiated,
      privateRefsZeroed: true,
      errors: [{ code, message }],
      ...extra,
    }, secrets);
  };

  if (PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED === true && typeof httpRequest !== 'function') {
    return fail('live_mutate_requires_future_slice', 'live mutate not enabled in Slice 14J');
  }

  if (typeof httpRequest !== 'function') {
    return fail('offline_inject_required', 'injected httpRequest required (live mutate disabled)');
  }

  try {
    // 1) IMDS GET
    const imdsUrl = new URL(buildLockedImdsTokenUrl());
    httpRequestCount += 1;
    imdsRequestCount += 1;
    const imdsRes = await httpRequest({
      purpose: 'imds_token',
      method: 'GET',
      hostname: imdsUrl.hostname,
      path: `${imdsUrl.pathname}${imdsUrl.search}`,
      headers: { Metadata: 'true' },
    });
    if (!imdsRes || Number(imdsRes.statusCode) !== 200) {
      return fail('imds_http_rejected', 'IMDS token GET rejected', {
        httpStatus: imdsRes && imdsRes.statusCode,
      });
    }
    let imdsBody;
    try {
      imdsBody = JSON.parse(String(imdsRes.body || ''));
    } catch (_) {
      return fail('imds_json_rejected', 'IMDS response not JSON');
    }
    token = imdsBody && imdsBody.access_token ? String(imdsBody.access_token) : null;
    if (!token) return fail('imds_token_missing', 'IMDS access_token missing');
    secrets.push(token);
    privateBag._token = token;

    // 2) KV GET current secret
    const kvUrl = new URL(buildLockedKeyVaultSecretUrl());
    httpRequestCount += 1;
    keyVaultGetCount += 1;
    const getRes = await httpRequest({
      purpose: 'keyvault_secret_get',
      method: 'GET',
      hostname: kvUrl.hostname,
      path: `${kvUrl.pathname}${kvUrl.search}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!getRes || Number(getRes.statusCode) !== 200) {
      return fail('kv_get_rejected', 'Key Vault secret GET rejected', {
        httpStatus: getRes && getRes.statusCode,
      });
    }
    let getBody;
    try {
      getBody = JSON.parse(String(getRes.body || ''));
    } catch (_) {
      return fail('kv_get_json_rejected', 'Key Vault GET response not JSON');
    }
    secretValue = getBody && getBody.value != null ? String(getBody.value) : null;
    if (!secretValue) return fail('kv_secret_value_missing', 'Key Vault secret value missing');
    secrets.push(secretValue);
    privateBag._secretValue = secretValue;
    const priorSecretVersionId = extractVersionIdFromSecretId(getBody.id)
      || (getBody.attributes && getBody.attributes.version)
      || null;
    if (!priorSecretVersionId) {
      return fail('prior_version_id_missing', 'current secret version id required for recoverable rollback');
    }

    const parsed = parseTlsDeficientSunsetDsnInMemory(secretValue);
    if (!parsed.ok) {
      zeroPrivateRefs(parsed);
      return fail(parsed.errors[0].code, parsed.errors[0].message);
    }
    secrets.push(parsed._user, parsed._password, parsed._dsn);
    user = parsed._user;
    password = parsed._password;
    privateBag._user = user;
    privateBag._password = password;
    privateBag._dsn = parsed._dsn;

    const normalized = normalizeSslmodeOnlyInMemory(parsed);
    if (!normalized.ok) {
      zeroPrivateRefs(parsed);
      zeroPrivateRefs(normalized);
      return fail(normalized.errors[0].code, normalized.errors[0].message);
    }
    normalizedDsn = normalized._normalizedDsn;
    secrets.push(normalizedDsn);
    privateBag._normalizedDsn = normalizedDsn;

    // Clear original DSN string ref before PUT.
    secretValue = null;
    privateBag._secretValue = null;
    privateBag._dsn = null;
    parsed._dsn = null;

    // 3) KV PUT — exactly one; body value only (no tags/contentType)
    httpRequestCount += 1;
    keyVaultPutCount += 1;
    kvWriteCount += 1;
    const putRes = await httpRequest({
      purpose: 'keyvault_secret_put',
      method: 'PUT',
      hostname: kvUrl.hostname,
      path: `${kvUrl.pathname}${kvUrl.search}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: normalizedDsn }),
    });
    if (!putRes || Number(putRes.statusCode) !== 200) {
      return fail('kv_put_rejected', 'Key Vault secret PUT rejected', {
        httpStatus: putRes && putRes.statusCode,
        priorSecretVersionId,
      });
    }
    let putBody;
    try {
      putBody = JSON.parse(String(putRes.body || ''));
    } catch (_) {
      return fail('kv_put_json_rejected', 'Key Vault PUT response not JSON', { priorSecretVersionId });
    }
    const newSecretVersionId = extractVersionIdFromSecretId(putBody.id) || null;
    if (!newSecretVersionId) {
      return fail('new_version_id_missing', 'PUT response missing new version id', { priorSecretVersionId });
    }

    // Drop normalized DSN from memory before verification GET re-fetches.
    normalizedDsn = null;
    privateBag._normalizedDsn = null;
    normalized._normalizedDsn = null;

    // 4) Verification GET
    httpRequestCount += 1;
    keyVaultGetCount += 1;
    const verifyRes = await httpRequest({
      purpose: 'keyvault_secret_verify_get',
      method: 'GET',
      hostname: kvUrl.hostname,
      path: `${kvUrl.pathname}${kvUrl.search}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!verifyRes || Number(verifyRes.statusCode) !== 200) {
      return fail('kv_verify_get_rejected', 'verification GET rejected', {
        httpStatus: verifyRes && verifyRes.statusCode,
        priorSecretVersionId,
        newSecretVersionId,
      });
    }
    let verifyBody;
    try {
      verifyBody = JSON.parse(String(verifyRes.body || ''));
    } catch (_) {
      return fail('kv_verify_json_rejected', 'verification GET not JSON', {
        priorSecretVersionId,
        newSecretVersionId,
      });
    }
    const verifyValue = verifyBody && verifyBody.value != null ? String(verifyBody.value) : null;
    if (!verifyValue) {
      return fail('kv_verify_value_missing', 'verification secret value missing', {
        priorSecretVersionId,
        newSecretVersionId,
      });
    }
    secrets.push(verifyValue);
    const verified = validateNormalizedSecretInMemory(verifyValue, user, password);
    // Zero credential refs immediately after in-memory validation.
    user = null;
    password = null;
    zeroPrivateRefs(privateBag);
    zeroPrivateRefs(parsed);
    zeroPrivateRefs(normalized);
    token = null;

    if (!verified.ok) {
      return fail(verified.errors[0].code, verified.errors[0].message, {
        priorSecretVersionId,
        newSecretVersionId,
      });
    }

    const counters = getDsnPlanCounters();
    const deltaHttp = counters.httpRequestCount - countersBefore.httpRequestCount;
    const deltaPut = counters.keyVaultPutCount - countersBefore.keyVaultPutCount;
    if (deltaPut !== 1) {
      return fail('put_count_integrity_failed', `expected exactly 1 PUT, got ${deltaPut}`, {
        priorSecretVersionId,
        newSecretVersionId,
      });
    }
    if (deltaHttp !== 4) {
      return fail('http_sequence_integrity_failed', `expected exactly 4 HTTP calls, got ${deltaHttp}`, {
        priorSecretVersionId,
        newSecretVersionId,
      });
    }

    return {
      ok: true,
      code: 'dsn_normalize_adapter_ok',
      liveMutateEnabled: false,
      liveMutation: false,
      sourceTlsDeficient: true,
      sslmodeNormalized: true,
      targetSslmode: DSN_PLAN_LOCKS.targetSslmode,
      mutationField: 'sslmode',
      postgresHost: DSN_PLAN_LOCKS.postgresHost,
      database: DSN_PLAN_LOCKS.database,
      port: DSN_PLAN_LOCKS.port,
      secretName: DSN_PLAN_LOCKS.secretName,
      keyVaultName: DSN_PLAN_LOCKS.keyVaultName,
      managedIdentityName: DSN_PLAN_LOCKS.managedIdentityName,
      priorSecretVersionId,
      newSecretVersionId,
      putCount: 1,
      retries: 0,
      httpSequence: [...LOCKED_MUTATION_PLAN.httpSequence],
      httpRequestCount: deltaHttp,
      imdsRequestCount: counters.imdsRequestCount - countersBefore.imdsRequestCount,
      keyVaultGetCount: counters.keyVaultGetCount - countersBefore.keyVaultGetCount,
      keyVaultPutCount: deltaPut,
      kvWriteCount: counters.kvWriteCount - countersBefore.kvWriteCount,
      pgClientInstantiated: 0,
      privateRefsZeroed: true,
      note: 'Offline injected-HTTP proof only — no live KV mutation',
    };
  } catch (err) {
    const safe = sanitizePlanError(err, secrets);
    return fail(safe.code, safe.message);
  } finally {
    token = null;
    secretValue = null;
    normalizedDsn = null;
    user = null;
    password = null;
    zeroPrivateRefs(privateBag);
  }
}

/**
 * Offline rollback adapter proof — restores only immediately previous version
 * after separate approval flag. Live rollback hard-disabled; inject required.
 * Default / wrong prior version → zero writes.
 */
async function executeDsnRollbackAdapter({
  httpRequest = null,
  priorSecretVersionId = null,
  approved = false,
} = {}) {
  const countersBefore = getDsnPlanCounters();
  const secrets = [];

  const fail = (code, message, extra = {}) => {
    const counters = getDsnPlanCounters();
    return {
      ok: false,
      code,
      message,
      liveRollbackEnabled: false,
      liveMutation: false,
      kvWriteCount: counters.kvWriteCount - countersBefore.kvWriteCount,
      kvPutCount: counters.keyVaultPutCount - countersBefore.keyVaultPutCount,
      httpRequestCount: counters.httpRequestCount - countersBefore.httpRequestCount,
      privateRefsZeroed: true,
      pgClientInstantiated: 0,
      errors: [{ code, message }],
      ...extra,
    };
  };

  if (!approved) {
    return fail('rollback_approval_required', 'explicit separate rollback approval required — zero writes');
  }
  if (PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED === true) {
    return fail('live_rollback_must_stay_disabled', 'Slice 14J live rollback must remain false');
  }
  if (typeof httpRequest !== 'function') {
    return fail('offline_inject_required', 'injected httpRequest required (live rollback disabled)');
  }
  if (!priorSecretVersionId || !/^[0-9a-fA-F-]{8,}$/.test(String(priorSecretVersionId))) {
    return fail('prior_version_id_rejected', 'rollback requires exact immediately-previous safe version id');
  }

  try {
    const imdsUrl = new URL(buildLockedImdsTokenUrl());
    httpRequestCount += 1;
    imdsRequestCount += 1;
    const imdsRes = await httpRequest({
      purpose: 'imds_token',
      method: 'GET',
      hostname: imdsUrl.hostname,
      path: `${imdsUrl.pathname}${imdsUrl.search}`,
      headers: { Metadata: 'true' },
    });
    if (!imdsRes || Number(imdsRes.statusCode) !== 200) {
      return fail('imds_http_rejected', 'IMDS token GET rejected');
    }
    const imdsBody = JSON.parse(String(imdsRes.body || ''));
    const token = imdsBody && imdsBody.access_token ? String(imdsBody.access_token) : null;
    if (!token) return fail('imds_token_missing', 'IMDS access_token missing');
    secrets.push(token);

    const kvBase = buildLockedKeyVaultSecretUrl();
    const versionUrl = new URL(
      `${DSN_PLAN_LOCKS.keyVaultHttpsUrl}/secrets/`
      + `${encodeURIComponent(DSN_PLAN_LOCKS.secretName)}/`
      + `${encodeURIComponent(priorSecretVersionId)}`
      + `?api-version=${DSN_PLAN_LOCKS.keyVaultApiVersion}`,
    );

    httpRequestCount += 1;
    keyVaultGetCount += 1;
    const getRes = await httpRequest({
      purpose: 'keyvault_secret_version_get',
      method: 'GET',
      hostname: versionUrl.hostname,
      path: `${versionUrl.pathname}${versionUrl.search}`,
      headers: { Authorization: `Bearer ${token}` },
      expectedVersionId: priorSecretVersionId,
    });
    if (!getRes || Number(getRes.statusCode) !== 200) {
      return fail('kv_prior_version_get_rejected', 'prior version GET rejected', {
        rollbackPriorVersionId: priorSecretVersionId,
      });
    }
    const getBody = JSON.parse(String(getRes.body || ''));
    const gotVersion = extractVersionIdFromSecretId(getBody.id);
    if (gotVersion && gotVersion !== priorSecretVersionId) {
      return fail('arbitrary_version_rollback_rejected', 'GET version is not the immediately previous id', {
        rollbackPriorVersionId: priorSecretVersionId,
      });
    }
    const priorValue = getBody && getBody.value != null ? String(getBody.value) : null;
    if (!priorValue) {
      return fail('kv_prior_value_missing', 'prior version value missing', {
        rollbackPriorVersionId: priorSecretVersionId,
      });
    }
    secrets.push(priorValue);

    const putUrl = new URL(kvBase);
    httpRequestCount += 1;
    keyVaultPutCount += 1;
    kvWriteCount += 1;
    const putRes = await httpRequest({
      purpose: 'keyvault_secret_put',
      method: 'PUT',
      hostname: putUrl.hostname,
      path: `${putUrl.pathname}${putUrl.search}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: priorValue }),
    });
    if (!putRes || Number(putRes.statusCode) !== 200) {
      return fail('kv_rollback_put_rejected', 'rollback PUT rejected', {
        rollbackPriorVersionId: priorSecretVersionId,
      });
    }

    const counters = getDsnPlanCounters();
    return {
      ok: true,
      code: 'dsn_rollback_adapter_ok',
      liveRollbackEnabled: false,
      liveMutation: false,
      rollbackPriorVersionId: priorSecretVersionId,
      priorSecretVersionId,
      putCount: 1,
      retries: 0,
      httpRequestCount: counters.httpRequestCount - countersBefore.httpRequestCount,
      keyVaultPutCount: counters.keyVaultPutCount - countersBefore.keyVaultPutCount,
      kvWriteCount: counters.kvWriteCount - countersBefore.kvWriteCount,
      privateRefsZeroed: true,
      pgClientInstantiated: 0,
      note: 'Offline injected-HTTP rollback proof only — no live KV write',
    };
  } catch (err) {
    const safe = sanitizePlanError(err, secrets);
    return fail(safe.code, safe.message);
  }
}

/**
 * Build injected HTTP router for offline RED/GREEN proof.
 * Supports IMDS GET, KV GET, KV PUT, verification GET, version GET.
 */
function createInjectedDsnNormalizeHttp(script) {
  const s = script || {};
  const imdsUrl = new URL(buildLockedImdsTokenUrl());
  const kvUrl = new URL(buildLockedKeyVaultSecretUrl());
  const calls = [];
  let putCountLocal = 0;

  async function httpRequest(req) {
    const request = req || {};
    const method = String(request.method || 'GET').toUpperCase();
    calls.push({
      purpose: request.purpose || null,
      hostname: request.hostname || null,
      path: request.path ? String(request.path).split('?')[0] : null,
      method,
      hasAuthorization: Boolean(request.headers && request.headers.Authorization),
      // Never record body/Authorization values.
    });

    if (s.throwOn && s.throwOn === request.purpose) {
      throw Object.assign(new Error(s.throwErrorMessage || 'injected http failure'), {
        code: s.throwErrorCode || 'injected_http_failed',
      });
    }

    if (request.purpose === 'imds_token') {
      if (method !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'http_method_forbidden' }) };
      }
      if (request.hostname !== DSN_PLAN_LOCKS.imdsHost) {
        return { statusCode: 400, body: '{"error":"wrong_imds_host"}' };
      }
      if (request.headers && request.headers.Metadata !== 'true') {
        return { statusCode: 400, body: '{"error":"metadata_header_required"}' };
      }
      const pathFull = String(request.path || '');
      try {
        assertImdsRequestClientIdLocked(pathFull);
      } catch (e) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: (e && e.code) || 'imds_client_id_rejected' }),
        };
      }
      if (s.imdsStatusCode && s.imdsStatusCode !== 200) {
        return { statusCode: s.imdsStatusCode, body: s.imdsBody || '{"error":"imds_failed"}' };
      }
      const token = s.imdsAccessToken || 'slice14j-proof-imds-token-never-commit';
      return {
        statusCode: 200,
        body: JSON.stringify({
          access_token: token,
          expires_in: 3600,
          token_type: 'Bearer',
          resource: DSN_PLAN_LOCKS.vaultResourceAudience,
          client_id: DSN_PLAN_LOCKS.managedIdentityClientId,
        }),
      };
    }

    if (request.purpose === 'keyvault_secret_get'
      || request.purpose === 'keyvault_secret_verify_get') {
      if (method !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'http_method_forbidden' }) };
      }
      if (request.hostname !== kvUrl.hostname) {
        return { statusCode: 400, body: '{"error":"wrong_kv_host"}' };
      }
      const pathFull = String(request.path || '');
      if (!pathFull.startsWith(kvUrl.pathname)) {
        return { statusCode: 404, body: '{"error":"wrong_secret"}' };
      }
      if (request.purpose === 'keyvault_secret_get' && s.kvGetStatusCode && s.kvGetStatusCode !== 200) {
        return { statusCode: s.kvGetStatusCode, body: s.kvGetBody || '{"error":"kv_get_failed"}' };
      }
      if (request.purpose === 'keyvault_secret_verify_get'
        && s.kvVerifyStatusCode && s.kvVerifyStatusCode !== 200) {
        return { statusCode: s.kvVerifyStatusCode, body: s.kvVerifyBody || '{"error":"kv_verify_failed"}' };
      }
      const isVerify = request.purpose === 'keyvault_secret_verify_get';
      const value = isVerify
        ? (Object.prototype.hasOwnProperty.call(s, 'verifySecretValue')
          ? s.verifySecretValue
          : s.normalizedSecretValue)
        : (Object.prototype.hasOwnProperty.call(s, 'secretValue')
          ? s.secretValue
          : s.defaultSecretValue);
      const versionId = isVerify
        ? (s.newSecretVersionId || 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
        : (s.priorSecretVersionId || 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      return {
        statusCode: 200,
        body: JSON.stringify({
          value,
          id: `${DSN_PLAN_LOCKS.keyVaultHttpsUrl}/secrets/${DSN_PLAN_LOCKS.secretName}/${versionId}`,
          attributes: { enabled: true },
        }),
      };
    }

    if (request.purpose === 'keyvault_secret_version_get') {
      if (method !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'http_method_forbidden' }) };
      }
      const expected = String(request.expectedVersionId || s.priorSecretVersionId || '');
      const pathFull = String(request.path || '');
      if (!pathFull.includes(`/secrets/${DSN_PLAN_LOCKS.secretName}/${expected}`)) {
        return { statusCode: 404, body: '{"error":"wrong_version"}' };
      }
      if (s.kvVersionGetStatusCode && s.kvVersionGetStatusCode !== 200) {
        return { statusCode: s.kvVersionGetStatusCode, body: '{"error":"version_get_failed"}' };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({
          value: s.priorSecretValue || s.secretValue || s.defaultSecretValue,
          id: `${DSN_PLAN_LOCKS.keyVaultHttpsUrl}/secrets/${DSN_PLAN_LOCKS.secretName}/${expected}`,
        }),
      };
    }

    if (request.purpose === 'keyvault_secret_put') {
      if (method !== 'PUT') {
        return { statusCode: 405, body: JSON.stringify({ error: 'http_method_forbidden', method }) };
      }
      putCountLocal += 1;
      if (s.rejectSecondPut && putCountLocal > 1) {
        return { statusCode: 429, body: '{"error":"retry_forbidden"}' };
      }
      if (s.kvPutStatusCode && s.kvPutStatusCode !== 200) {
        return { statusCode: s.kvPutStatusCode, body: s.kvPutBody || '{"error":"kv_put_failed"}' };
      }
      // Reject body that mutates tags/contentType.
      let parsedBody = null;
      try {
        parsedBody = JSON.parse(String(request.body || '{}'));
      } catch (_) {
        return { statusCode: 400, body: '{"error":"put_body_not_json"}' };
      }
      if (parsedBody.tags != null || parsedBody.contentType != null
        || parsedBody.attributes != null) {
        return { statusCode: 400, body: '{"error":"tags_content_type_forbidden"}' };
      }
      if (parsedBody.value == null) {
        return { statusCode: 400, body: '{"error":"value_required"}' };
      }
      // Store for verify GET if not overridden.
      if (!Object.prototype.hasOwnProperty.call(s, 'verifySecretValue')
        && !Object.prototype.hasOwnProperty.call(s, 'normalizedSecretValue')) {
        s.normalizedSecretValue = parsedBody.value;
      }
      const newId = s.newSecretVersionId || 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      return {
        statusCode: 200,
        body: JSON.stringify({
          id: `${DSN_PLAN_LOCKS.keyVaultHttpsUrl}/secrets/${DSN_PLAN_LOCKS.secretName}/${newId}`,
          attributes: { enabled: true },
        }),
      };
    }

    return { statusCode: 400, body: '{"error":"unknown_purpose"}' };
  }

  httpRequest.calls = calls;
  httpRequest.reset = () => { calls.length = 0; putCountLocal = 0; };
  httpRequest.getPutCount = () => putCountLocal;
  return httpRequest;
}

/**
 * Offline-proof TLS-deficient sunset-database-url (never committed to evidence).
 */
function buildOfflineProofTlsDeficientSunsetDatabaseUrl(user, password, sslmode = 'require') {
  const u = encodeURIComponent(String(user));
  const p = encodeURIComponent(String(password));
  const mode = String(sslmode || 'require');
  // Assemble without a contiguous user:pass@ literal (secret-scan safe).
  return [
    'postgresql://',
    u,
    ':',
    p,
    '@',
    DSN_PLAN_LOCKS.postgresHost,
    ':',
    String(DSN_PLAN_LOCKS.port),
    '/',
    DSN_PLAN_LOCKS.database,
    '?sslmode=',
    mode,
  ].join('');
}

function buildOfflineProofVerifyFullSunsetDatabaseUrl(user, password) {
  return buildOfflineProofTlsDeficientSunsetDatabaseUrl(user, password, 'verify-full');
}

function exactDsnPlanArgv() {
  return [
    CLI_PLAN_ONLY,
    '--subscription', DSN_PLAN_LOCKS.subscriptionId,
    '--resource-group', DSN_PLAN_LOCKS.resourceGroup,
    '--key-vault', DSN_PLAN_LOCKS.keyVaultName,
    '--secret-name', DSN_PLAN_LOCKS.secretName,
    '--managed-identity', DSN_PLAN_LOCKS.managedIdentityName,
    '--postgres-server', DSN_PLAN_LOCKS.postgresServer,
    '--database', DSN_PLAN_LOCKS.database,
  ];
}

function exactDsnRollbackPlanArgv(priorSecretVersionId) {
  return [
    CLI_ROLLBACK_PLAN_ONLY,
    '--subscription', DSN_PLAN_LOCKS.subscriptionId,
    '--resource-group', DSN_PLAN_LOCKS.resourceGroup,
    '--key-vault', DSN_PLAN_LOCKS.keyVaultName,
    '--secret-name', DSN_PLAN_LOCKS.secretName,
    '--managed-identity', DSN_PLAN_LOCKS.managedIdentityName,
    '--postgres-server', DSN_PLAN_LOCKS.postgresServer,
    '--database', DSN_PLAN_LOCKS.database,
    '--prior-version-id', String(priorSecretVersionId),
  ];
}

function dsnPlanEnv(base = {}) {
  return {
    ...base,
    [ENV_DSN_PLAN]: '1',
    AZURE_SUBSCRIPTION_ID: DSN_PLAN_LOCKS.subscriptionId,
  };
}

function dsnRollbackEnv(base = {}) {
  return {
    ...base,
    [ENV_DSN_ROLLBACK]: '1',
    AZURE_SUBSCRIPTION_ID: DSN_PLAN_LOCKS.subscriptionId,
  };
}

function renderDsnPlanUsage() {
  return [
    'Phase D Key Vault DSN sslmode=verify-full normalize plan (FOUNDATION Slice 14J)',
    '',
    'DEFAULT: refused (zero KV writes). Plan-only offline emission of the locked',
    'recoverable mutation + rollback contract for sunset-database-url.',
    '',
    'Mutation plan:',
    `  ${ENV_DSN_PLAN}=1`,
    `  ${CLI_PLAN_ONLY}`,
    `  --subscription ${DSN_PLAN_LOCKS.subscriptionId}`,
    `  --resource-group ${DSN_PLAN_LOCKS.resourceGroup}`,
    `  --key-vault ${DSN_PLAN_LOCKS.keyVaultName}`,
    `  --secret-name ${DSN_PLAN_LOCKS.secretName}`,
    `  --managed-identity ${DSN_PLAN_LOCKS.managedIdentityName}`,
    `  --postgres-server ${DSN_PLAN_LOCKS.postgresServer}`,
    `  --database ${DSN_PLAN_LOCKS.database}`,
    '',
    'Rollback plan (separate approval):',
    `  ${ENV_DSN_ROLLBACK}=1`,
    `  ${CLI_ROLLBACK_PLAN_ONLY}`,
    '  --prior-version-id <immediately-previous-safe-id>',
    '  + exact subscription/RG/vault/secret/identity/target flags',
    '',
    'Forbidden: --apply --value --dsn --url --token --version --file --host',
    '--user --password --delete --purge --disable --tags --content-type --retry',
    'Live mutate/rollback hard-disabled. Output: safe IDs only.',
  ].join('\n');
}

module.exports = {
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED,
  ENV_DSN_PLAN,
  ENV_DSN_ROLLBACK,
  CLI_PLAN_ONLY,
  CLI_ROLLBACK_PLAN_ONLY,
  DSN_PLAN_LOCKS,
  KEY_VAULT_RESOURCE_ID,
  LOCKED_MUTATION_PLAN,
  LOCKED_ROLLBACK_PLAN,
  SAFE_OUTPUT_KEYS,
  FORBIDDEN_ARGV_FLAGS,
  buildLockedKeyVaultSecretUrl,
  buildLockedImdsTokenUrl,
  extractVersionIdFromSecretId,
  parseTlsDeficientSunsetDsnInMemory,
  normalizeSslmodeOnlyInMemory,
  validateNormalizedSecretInMemory,
  buildLockedMutationPlan,
  buildLockedRollbackPlan,
  mutationPlanMatchesLocked,
  evaluateDsnPlanGates,
  evaluateMutationCandidate,
  executeDsnVerifyFullPlanOnly,
  executeDsnNormalizeAdapter,
  executeDsnRollbackAdapter,
  createInjectedDsnNormalizeHttp,
  buildOfflineProofTlsDeficientSunsetDatabaseUrl,
  buildOfflineProofVerifyFullSunsetDatabaseUrl,
  exactDsnPlanArgv,
  exactDsnRollbackPlanArgv,
  dsnPlanEnv,
  dsnRollbackEnv,
  renderDsnPlanUsage,
  safePlanOutput,
  safeRollbackPlanOutput,
  getDsnPlanCounters,
  resetDsnPlanCounters,
  zeroPrivateRefs,
  sanitizePlanError,
};
