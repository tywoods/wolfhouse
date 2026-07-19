'use strict';

/**
 * FOUNDATION Slice 14F — Phase D managed-identity credential-preflight
 * (live HTTP activated in Slice 14G behind these exact gates)
 *
 * Activates the merged 14E managed-identity HTTP loader behind an explicit
 * metadata-only credential-preflight command. Never instantiates a pg Client.
 * Slice 14G sets PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true so gated
 * operator runs may perform real IMDS + Key Vault GETs; default / missing
 * gates still make zero HTTP. Offline proof injects httpRequest.
 *
 * Output is secret-free: booleans + identity/vault/secret/PG host/database/TLS
 * names only. Never token, DSN, user/password values, API version values,
 * secret metadata IDs, or secret hashes.
 */

const {
  TARGETS,
  ENV_SUBSCRIPTION,
  redactDeep,
  redactSecrets,
  REDACTED,
} = require('./phase-d-live-readonly-boundary');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  MI_LOADER_LOCKS,
  evaluateCredentialSource,
  loadProtectedAdminCredentialsViaManagedIdentity,
  zeroPrivateCredentialRefs,
  sanitizeLoaderError,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
  assertNoCallerOverrides,
} = require('./phase-d-managed-identity-credential-loader');
const {
  getPgClientInstantiateCount,
  resetPgClientInstantiateCount,
} = require('./phase-d-live-readonly-pg-adapter');

/** Dedicated env approval for credential-preflight (Slice 14F). */
const ENV_CREDENTIAL_PREFLIGHT = 'SUNSET_PHASE_D_CREDENTIAL_PREFLIGHT';
const CLI_CREDENTIAL_PREFLIGHT_ONLY = '--credential-preflight-only';

/** Locked confirmation targets for credential-preflight CLI. */
const CREDENTIAL_PREFLIGHT_LOCKS = Object.freeze({
  subscriptionId: TARGETS.subscriptionId,
  resourceGroup: TARGETS.resourceGroup,
  vmResourceGroup: 'wh-staging-rg',
  vmName: 'lunabox',
  managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
  keyVaultName: MI_LOADER_LOCKS.keyVaultName,
  secretName: MI_LOADER_LOCKS.secretName,
  postgresServer: TARGETS.postgresServer,
  postgresHost: TARGETS.postgresHost,
  database: TARGETS.database,
  sslmode: TARGETS.sslmode,
});

const FORBIDDEN_ARGV_FLAGS = Object.freeze([
  '--dsn',
  '--connection-string',
  '--database-url',
  '--host',
  '--port',
  '--user',
  '--password',
  '--username',
  '--query',
  '--sql',
  '--sslmode',
  '--token',
  '--access-token',
  '--imds-url',
  '--vault-url',
  '--key-vault-url',
]);

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_CREDENTIAL_PREFLIGHT_ONLY,
  CLI_CREDENTIAL_SOURCE,
  '--subscription',
  '--resource-group',
  '--vm-resource-group',
  '--vm-name',
  '--managed-identity',
  '--key-vault',
  '--secret-name',
  '--postgres-server',
  '--database',
  '--help',
  '-h',
]);

const SAFE_OUTPUT_KEYS = Object.freeze([
  'ok',
  'code',
  'credentialSource',
  'managedIdentityName',
  'keyVaultName',
  'secretName',
  'postgresHost',
  'database',
  'sslmode',
  'secretTargetValid',
  'hasUser',
  'hasPassword',
  'httpRequestCount',
  'imdsRequestCount',
  'keyVaultRequestCount',
  'httpCallsDelta',
  'clientsInstantiated',
  'liveHttpEnabled',
  'liveMutation',
  'appliesConstraints',
  'writesLedger',
  'realImdsCall',
  'realKeyVaultCall',
  'realPostgresCall',
  'errors',
  'message',
  'note',
]);

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
    if (flag === CLI_CREDENTIAL_PREFLIGHT_ONLY || flag === '--help' || flag === '-h') {
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

function evaluateCredentialPreflightEnvApproval(env) {
  const e = env || {};
  const raw = String(e[ENV_CREDENTIAL_PREFLIGHT] || '').trim();
  if (raw !== '1') {
    return {
      ok: false,
      errors: [{
        code: 'credential_preflight_env_required',
        message: `env ${ENV_CREDENTIAL_PREFLIGHT}=1 is required`,
      }],
    };
  }
  const sub = String(e[ENV_SUBSCRIPTION] || '').trim();
  if (sub !== CREDENTIAL_PREFLIGHT_LOCKS.subscriptionId) {
    return {
      ok: false,
      errors: [{
        code: 'wrong_subscription_env',
        message: `env ${ENV_SUBSCRIPTION} must be exactly ${CREDENTIAL_PREFLIGHT_LOCKS.subscriptionId}`,
        got: sub || null,
      }],
    };
  }
  return { ok: true, errors: [] };
}

function evaluateCredentialPreflightExactTargets(argv) {
  const parsed = parseArgvPairs(argv);
  const errors = [];

  if (parsed.forbidden.length > 0) {
    errors.push({
      code: 'caller_supplied_connect_forbidden',
      message: `forbidden argv flags: ${parsed.forbidden.join(',')}`,
      flags: parsed.forbidden.slice(),
    });
  }
  if (parsed.unknown.length > 0) {
    errors.push({
      code: 'unknown_cli_args',
      message: `unknown argv: ${parsed.unknown.join(',')}`,
      args: parsed.unknown.slice(),
    });
  }

  if (!parsed.flags.has(CLI_CREDENTIAL_PREFLIGHT_ONLY)) {
    errors.push({
      code: 'credential_preflight_flag_required',
      message: `${CLI_CREDENTIAL_PREFLIGHT_ONLY} is required`,
    });
  }

  const checks = [
    ['--subscription', CREDENTIAL_PREFLIGHT_LOCKS.subscriptionId, 'wrong_subscription'],
    ['--resource-group', CREDENTIAL_PREFLIGHT_LOCKS.resourceGroup, 'wrong_resource_group'],
    ['--vm-resource-group', CREDENTIAL_PREFLIGHT_LOCKS.vmResourceGroup, 'wrong_vm_resource_group'],
    ['--vm-name', CREDENTIAL_PREFLIGHT_LOCKS.vmName, 'wrong_vm_name'],
    ['--managed-identity', CREDENTIAL_PREFLIGHT_LOCKS.managedIdentityName, 'wrong_managed_identity'],
    ['--key-vault', CREDENTIAL_PREFLIGHT_LOCKS.keyVaultName, 'wrong_key_vault'],
    ['--secret-name', CREDENTIAL_PREFLIGHT_LOCKS.secretName, 'wrong_secret_name'],
    ['--postgres-server', CREDENTIAL_PREFLIGHT_LOCKS.postgresServer, 'wrong_postgres_server'],
    ['--database', CREDENTIAL_PREFLIGHT_LOCKS.database, 'wrong_database'],
  ];

  for (const [flag, expected, code] of checks) {
    const got = parsed.values[flag];
    if (got !== expected) {
      errors.push({
        code,
        message: `${flag} must be exactly ${expected}`,
        got: got == null ? null : String(got),
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    parsed,
    confirmed: errors.length === 0
      ? { ...CREDENTIAL_PREFLIGHT_LOCKS }
      : null,
  };
}

/**
 * Full credential-preflight gate stack before any HTTP:
 * dedicated env + exact target argv + managed-identity credential source.
 */
function evaluateCredentialPreflightGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const argv = options.argv || [];

  const envGate = evaluateCredentialPreflightEnvApproval(env);
  const exact = evaluateCredentialPreflightExactTargets(argv);
  const sourceGate = evaluateCredentialSource({ env, argv });

  const errors = [];
  if (!envGate.ok) errors.push(...envGate.errors);
  if (!exact.ok) errors.push(...exact.errors);

  if (!sourceGate.ok) {
    errors.push(...sourceGate.errors);
  } else if (sourceGate.source !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `credential-preflight requires both env ${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY} and ${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    });
  }

  return redactDeep({
    ok: errors.length === 0,
    errors,
    envOk: envGate.ok,
    exactTargetOk: exact.ok,
    credentialSource: sourceGate.source,
    credentialSourceOk: sourceGate.ok
      && sourceGate.source === CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    confirmed: exact.confirmed,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    liveMutation: false,
    defaultEnabled: false,
    clientsInstantiated: 0,
  }, []);
}

function assertHttpRequestMethodsGetOnly(httpRequest) {
  if (typeof httpRequest !== 'function') return { ok: true };
  const calls = httpRequest.calls;
  if (!Array.isArray(calls)) return { ok: true };
  for (const c of calls) {
    const method = String((c && c.method) || 'GET').toUpperCase();
    if (method !== 'GET') {
      return {
        ok: false,
        errors: [{
          code: 'http_method_forbidden',
          message: `credential-preflight allows GET only; got ${method}`,
        }],
      };
    }
  }
  return { ok: true };
}

/**
 * Build the only allowed public output shape (secret-free).
 */
function buildCredentialPreflightSafeOutput(parts) {
  const p = parts || {};
  const usedLiveHttp = p.usedLiveHttp === true;
  const out = {
    ok: p.ok === true,
    code: p.code || (p.ok ? 'credential_preflight_ok' : 'credential_preflight_failed'),
    credentialSource: p.credentialSource || null,
    managedIdentityName: p.managedIdentityName || null,
    keyVaultName: p.keyVaultName || null,
    secretName: p.secretName || null,
    postgresHost: p.postgresHost || null,
    database: p.database || null,
    sslmode: p.sslmode || null,
    secretTargetValid: p.secretTargetValid === true,
    hasUser: p.hasUser === true,
    hasPassword: p.hasPassword === true,
    httpRequestCount: Number(p.httpRequestCount) || 0,
    imdsRequestCount: Number(p.imdsRequestCount) || 0,
    keyVaultRequestCount: Number(p.keyVaultRequestCount) || 0,
    httpCallsDelta: Number(p.httpCallsDelta) || 0,
    clientsInstantiated: Number(p.clientsInstantiated) || 0,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    liveMutation: false,
    appliesConstraints: false,
    writesLedger: false,
    realImdsCall: p.realImdsCall === true || (usedLiveHttp && (Number(p.imdsRequestCount) || 0) > 0),
    realKeyVaultCall: p.realKeyVaultCall === true
      || (usedLiveHttp && (Number(p.keyVaultRequestCount) || 0) > 0),
    realPostgresCall: false,
  };
  if (p.errors) out.errors = p.errors;
  if (p.message) out.message = p.message;
  if (p.note) out.note = p.note;

  // Strip any accidental private / forbidden keys.
  const forbidden = [
    '_user', '_password', '_token', '_dsn', '_secretValue', '_accessToken',
    '_connectConfig', 'token', 'access_token', 'password', 'user', 'dsn',
    'connectionString', 'databaseUrl', 'value', 'id', 'kid', 'version',
    'secretId', 'attributes', 'hash', 'sha256', 'usedLiveHttp',
  ];
  for (const k of forbidden) {
    if (Object.prototype.hasOwnProperty.call(out, k)) delete out[k];
  }
  return redactDeep(out, p.secrets || []);
}

/**
 * Execute metadata-only credential preflight.
 * Requires gates + (for offline) injected httpRequest, or (when 14G live HTTP
 * is enabled) gated real IMDS/KV GETs. Never creates pg Client.
 * On success: exact IMDS GET + KV GET via loader, validate DSN in memory,
 * immediately zero private refs, return safe booleans/names only.
 */
async function executeCredentialPreflight(opts) {
  const options = opts || {};
  const secrets = [];
  const usedLiveHttp = typeof options.httpRequest !== 'function'
    && PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true;

  const overrideGate = assertNoCallerOverrides(options);
  if (!overrideGate.ok) {
    return buildCredentialPreflightSafeOutput({
      ok: false,
      code: 'caller_supplied_loader_override_forbidden',
      errors: overrideGate.errors,
      clientsInstantiated: getPgClientInstantiateCount(),
      usedLiveHttp: false,
      realImdsCall: false,
      realKeyVaultCall: false,
      note: 'caller overrides rejected — zero HTTP / zero Clients',
    });
  }

  const gates = evaluateCredentialPreflightGates({
    env: options.env,
    argv: options.argv,
  });
  if (!gates.ok) {
    return buildCredentialPreflightSafeOutput({
      ok: false,
      code: 'cli_gates_rejected',
      errors: gates.errors,
      credentialSource: gates.credentialSource,
      clientsInstantiated: getPgClientInstantiateCount(),
      httpRequestCount: getManagedIdentityHttpCounters().httpRequestCount,
      imdsRequestCount: getManagedIdentityHttpCounters().imdsRequestCount,
      keyVaultRequestCount: getManagedIdentityHttpCounters().keyVaultRequestCount,
      usedLiveHttp: false,
      realImdsCall: false,
      realKeyVaultCall: false,
      note: 'CLI gates failed — zero HTTP / zero Clients',
    });
  }

  const countersBefore = getManagedIdentityHttpCounters();
  let loaded = null;
  try {
    loaded = await loadProtectedAdminCredentialsViaManagedIdentity({
      env: options.env,
      argv: options.argv,
      httpRequest: options.httpRequest,
    });

    const methodGate = assertHttpRequestMethodsGetOnly(options.httpRequest);
    if (!methodGate.ok) {
      zeroPrivateCredentialRefs(loaded);
      return buildCredentialPreflightSafeOutput({
        ok: false,
        code: 'http_method_forbidden',
        errors: methodGate.errors,
        credentialSource: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
        clientsInstantiated: getPgClientInstantiateCount(),
        httpRequestCount: getManagedIdentityHttpCounters().httpRequestCount,
        imdsRequestCount: getManagedIdentityHttpCounters().imdsRequestCount,
        keyVaultRequestCount: getManagedIdentityHttpCounters().keyVaultRequestCount,
        httpCallsDelta: getManagedIdentityHttpCounters().httpRequestCount
          - countersBefore.httpRequestCount,
        usedLiveHttp: false,
        realImdsCall: false,
        realKeyVaultCall: false,
      });
    }

    const liveFlags = {
      usedLiveHttp: (loaded && loaded.usedLiveHttp === true) || usedLiveHttp,
      realImdsCall: Boolean(loaded && loaded.realImdsCall),
      realKeyVaultCall: Boolean(loaded && loaded.realKeyVaultCall),
    };

    if (!loaded || !loaded.ok) {
      zeroPrivateCredentialRefs(loaded);
      const counters = getManagedIdentityHttpCounters();
      return buildCredentialPreflightSafeOutput({
        ok: false,
        code: (loaded && loaded.code) || 'credential_preflight_failed',
        errors: (loaded && loaded.errors) || [{
          code: 'credential_preflight_failed',
          message: 'managed-identity credential load failed',
        }],
        credentialSource: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
        managedIdentityName: CREDENTIAL_PREFLIGHT_LOCKS.managedIdentityName,
        keyVaultName: CREDENTIAL_PREFLIGHT_LOCKS.keyVaultName,
        secretName: CREDENTIAL_PREFLIGHT_LOCKS.secretName,
        postgresHost: CREDENTIAL_PREFLIGHT_LOCKS.postgresHost,
        database: CREDENTIAL_PREFLIGHT_LOCKS.database,
        sslmode: CREDENTIAL_PREFLIGHT_LOCKS.sslmode,
        secretTargetValid: false,
        hasUser: false,
        hasPassword: false,
        clientsInstantiated: getPgClientInstantiateCount(),
        httpRequestCount: counters.httpRequestCount,
        imdsRequestCount: counters.imdsRequestCount,
        keyVaultRequestCount: counters.keyVaultRequestCount,
        httpCallsDelta: counters.httpRequestCount - countersBefore.httpRequestCount,
        usedLiveHttp: liveFlags.usedLiveHttp,
        realImdsCall: liveFlags.realImdsCall,
        realKeyVaultCall: liveFlags.realKeyVaultCall,
        secrets,
      });
    }

    // Capture safe booleans BEFORE zeroing private refs.
    const hasUser = Boolean(loaded._user);
    const hasPassword = Boolean(loaded._password);
    const connectInfo = loaded.connectInfo || null;
    const secretTargetValid = Boolean(
      connectInfo
      && connectInfo.host === CREDENTIAL_PREFLIGHT_LOCKS.postgresHost
      && connectInfo.database === CREDENTIAL_PREFLIGHT_LOCKS.database
      && connectInfo.sslmode === CREDENTIAL_PREFLIGHT_LOCKS.sslmode
      && hasUser
      && hasPassword,
    );

    // Immediately zero private credential / token / DSN refs — never hand off.
    zeroPrivateCredentialRefs(loaded);
    if (loaded) {
      loaded._user = null;
      loaded._password = null;
      loaded._connectConfig = null;
      loaded.connectInfo = null;
    }

    if (getPgClientInstantiateCount() !== 0) {
      return buildCredentialPreflightSafeOutput({
        ok: false,
        code: 'pg_client_forbidden',
        errors: [{
          code: 'pg_client_forbidden',
          message: 'credential-preflight must never instantiate a pg Client',
        }],
        credentialSource: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
        clientsInstantiated: getPgClientInstantiateCount(),
        usedLiveHttp: liveFlags.usedLiveHttp,
        realImdsCall: liveFlags.realImdsCall,
        realKeyVaultCall: liveFlags.realKeyVaultCall,
      });
    }

    const counters = getManagedIdentityHttpCounters();
    const httpDelta = counters.httpRequestCount - countersBefore.httpRequestCount;
    const imdsDelta = counters.imdsRequestCount - countersBefore.imdsRequestCount;
    const kvDelta = counters.keyVaultRequestCount - countersBefore.keyVaultRequestCount;
    if (httpDelta !== 2 || imdsDelta !== 1 || kvDelta !== 1) {
      // Success path must be exactly IMDS GET + KV GET. Still return safe metadata.
      return buildCredentialPreflightSafeOutput({
        ok: false,
        code: 'http_call_count_rejected',
        errors: [{
          code: 'http_call_count_rejected',
          message: 'credential-preflight requires exactly 1 IMDS GET + 1 Key Vault GET',
        }],
        credentialSource: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
        managedIdentityName: CREDENTIAL_PREFLIGHT_LOCKS.managedIdentityName,
        keyVaultName: CREDENTIAL_PREFLIGHT_LOCKS.keyVaultName,
        secretName: CREDENTIAL_PREFLIGHT_LOCKS.secretName,
        postgresHost: CREDENTIAL_PREFLIGHT_LOCKS.postgresHost,
        database: CREDENTIAL_PREFLIGHT_LOCKS.database,
        sslmode: CREDENTIAL_PREFLIGHT_LOCKS.sslmode,
        secretTargetValid,
        hasUser,
        hasPassword,
        clientsInstantiated: 0,
        httpRequestCount: counters.httpRequestCount,
        imdsRequestCount: counters.imdsRequestCount,
        keyVaultRequestCount: counters.keyVaultRequestCount,
        httpCallsDelta: httpDelta,
        usedLiveHttp: liveFlags.usedLiveHttp,
        realImdsCall: liveFlags.realImdsCall,
        realKeyVaultCall: liveFlags.realKeyVaultCall,
      });
    }

    return buildCredentialPreflightSafeOutput({
      ok: secretTargetValid,
      code: secretTargetValid
        ? 'credential_preflight_ok'
        : 'secret_target_rejected',
      credentialSource: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
      managedIdentityName: CREDENTIAL_PREFLIGHT_LOCKS.managedIdentityName,
      keyVaultName: CREDENTIAL_PREFLIGHT_LOCKS.keyVaultName,
      secretName: CREDENTIAL_PREFLIGHT_LOCKS.secretName,
      postgresHost: CREDENTIAL_PREFLIGHT_LOCKS.postgresHost,
      database: CREDENTIAL_PREFLIGHT_LOCKS.database,
      sslmode: CREDENTIAL_PREFLIGHT_LOCKS.sslmode,
      secretTargetValid,
      hasUser,
      hasPassword,
      clientsInstantiated: 0,
      httpRequestCount: counters.httpRequestCount,
      imdsRequestCount: counters.imdsRequestCount,
      keyVaultRequestCount: counters.keyVaultRequestCount,
      httpCallsDelta: httpDelta,
      usedLiveHttp: liveFlags.usedLiveHttp,
      realImdsCall: liveFlags.realImdsCall,
      realKeyVaultCall: liveFlags.realKeyVaultCall,
      note: secretTargetValid
        ? (liveFlags.usedLiveHttp
          ? 'metadata-only live credential preflight — private refs zeroed; no pg Client'
          : 'metadata-only credential preflight — private refs zeroed; no pg Client')
        : 'secret target validation failed after load',
    });
  } catch (err) {
    zeroPrivateCredentialRefs(loaded);
    const safe = sanitizeLoaderError(err, secrets);
    const counters = getManagedIdentityHttpCounters();
    return buildCredentialPreflightSafeOutput({
      ok: false,
      code: safe.code || 'credential_preflight_failed',
      errors: [{ code: safe.code, message: safe.message }],
      message: safe.message,
      credentialSource: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
      clientsInstantiated: getPgClientInstantiateCount(),
      httpRequestCount: counters.httpRequestCount,
      imdsRequestCount: counters.imdsRequestCount,
      keyVaultRequestCount: counters.keyVaultRequestCount,
      httpCallsDelta: counters.httpRequestCount - countersBefore.httpRequestCount,
      usedLiveHttp,
      realImdsCall: usedLiveHttp && (counters.imdsRequestCount > countersBefore.imdsRequestCount),
      realKeyVaultCall: usedLiveHttp
        && (counters.keyVaultRequestCount > countersBefore.keyVaultRequestCount),
      secrets,
    });
  }
}

function renderCredentialPreflightUsage() {
  return [
    'Phase D managed-identity credential-preflight (FOUNDATION Slice 14F/14G)',
    '',
    'DEFAULT: refused (zero HTTP / zero pg Clients). Metadata-only — never',
    'instantiates a pg Client. Live IMDS/KV HTTP is activated behind these',
    'exact env+argv+target gates (Slice 14G). Offline proof may inject',
    'httpRequest. Count-only DB command unchanged.',
    '',
    'Required env:',
    `  ${ENV_CREDENTIAL_PREFLIGHT}=1`,
    `  ${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `  ${ENV_SUBSCRIPTION}=${CREDENTIAL_PREFLIGHT_LOCKS.subscriptionId}`,
    '',
    'Required argv:',
    `  ${CLI_CREDENTIAL_PREFLIGHT_ONLY}`,
    `  ${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `  --subscription ${CREDENTIAL_PREFLIGHT_LOCKS.subscriptionId}`,
    `  --resource-group ${CREDENTIAL_PREFLIGHT_LOCKS.resourceGroup}`,
    `  --vm-resource-group ${CREDENTIAL_PREFLIGHT_LOCKS.vmResourceGroup}`,
    `  --vm-name ${CREDENTIAL_PREFLIGHT_LOCKS.vmName}`,
    `  --managed-identity ${CREDENTIAL_PREFLIGHT_LOCKS.managedIdentityName}`,
    `  --key-vault ${CREDENTIAL_PREFLIGHT_LOCKS.keyVaultName}`,
    `  --secret-name ${CREDENTIAL_PREFLIGHT_LOCKS.secretName}`,
    `  --postgres-server ${CREDENTIAL_PREFLIGHT_LOCKS.postgresServer}`,
    `  --database ${CREDENTIAL_PREFLIGHT_LOCKS.database}`,
    '',
    'Forbidden argv: --dsn --host --query --token --user --password --sslmode',
    '--imds-url --vault-url --connection-string --sql --port',
    '',
    'Safe output only: ok/booleans + identity/vault/secret/PG host/database/TLS.',
    'Never token, DSN, user/password, version values, secret metadata IDs, or hashes.',
    'Does not mutate Azure/network/database. No PostgreSQL Client/connection.',
  ].join('\n');
}

function renderFailClosedCredentialPreflightCatch(err, opts) {
  const options = opts || {};
  const rawMessage = String(
    (err && typeof err === 'object' && err.message != null)
      ? err.message
      : (err || 'credential-preflight failed'),
  ).slice(0, 240);

  const payload = {
    ok: false,
    code: 'cli_failed',
    message: redactSecrets(rawMessage, options.secrets || [])
      .replace(/postgres(?:ql)?:\/\/[^:\s/@]+:[^@\s/]+@/gi, `postgresql://${REDACTED}:`)
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`),
    clientsInstantiated: Number.isFinite(options.clientsInstantiated)
      ? options.clientsInstantiated
      : getPgClientInstantiateCount(),
    liveMutation: false,
    realImdsCall: false,
    realKeyVaultCall: false,
    realPostgresCall: false,
  };
  return redactDeep(payload, options.secrets || []);
}

function exactCredentialPreflightArgv(extraFlags) {
  return [
    CLI_CREDENTIAL_PREFLIGHT_ONLY,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    '--subscription', CREDENTIAL_PREFLIGHT_LOCKS.subscriptionId,
    '--resource-group', CREDENTIAL_PREFLIGHT_LOCKS.resourceGroup,
    '--vm-resource-group', CREDENTIAL_PREFLIGHT_LOCKS.vmResourceGroup,
    '--vm-name', CREDENTIAL_PREFLIGHT_LOCKS.vmName,
    '--managed-identity', CREDENTIAL_PREFLIGHT_LOCKS.managedIdentityName,
    '--key-vault', CREDENTIAL_PREFLIGHT_LOCKS.keyVaultName,
    '--secret-name', CREDENTIAL_PREFLIGHT_LOCKS.secretName,
    '--postgres-server', CREDENTIAL_PREFLIGHT_LOCKS.postgresServer,
    '--database', CREDENTIAL_PREFLIGHT_LOCKS.database,
    ...(extraFlags || []),
  ];
}

function credentialPreflightEnv(extra) {
  return {
    [ENV_CREDENTIAL_PREFLIGHT]: '1',
    [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    [ENV_SUBSCRIPTION]: CREDENTIAL_PREFLIGHT_LOCKS.subscriptionId,
    ...(extra || {}),
  };
}

module.exports = {
  ENV_CREDENTIAL_PREFLIGHT,
  CLI_CREDENTIAL_PREFLIGHT_ONLY,
  CREDENTIAL_PREFLIGHT_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  parseArgvPairs,
  evaluateCredentialPreflightEnvApproval,
  evaluateCredentialPreflightExactTargets,
  evaluateCredentialPreflightGates,
  executeCredentialPreflight,
  buildCredentialPreflightSafeOutput,
  renderCredentialPreflightUsage,
  renderFailClosedCredentialPreflightCatch,
  exactCredentialPreflightArgv,
  credentialPreflightEnv,
  getPgClientInstantiateCount,
  resetPgClientInstantiateCount,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
};
