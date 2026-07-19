'use strict';

/**
 * FOUNDATION Slice 14B — Phase D live read-only connection boundary
 *
 * Hard-disabled boundary that can later run the merged Slice 14A count-only
 * preflight against the exact Sunset staging PostgreSQL/database.
 *
 * Locks: subscription, resource group, server FQDN, database, TLS verify-full,
 * application_name, BEGIN READ ONLY. Credentials only from protected admin env
 * (SUNSET_STAGING_PG_ADMIN_USER / SUNSET_STAGING_PG_ADMIN_PASSWORD), populated
 * by the existing locked loader from Key Vault sunset-database-url — never argv,
 * observer DSN, WOLFHOUSE_DATABASE_URL, caller-supplied DSN, file path, output,
 * or evidence.
 *
 * This slice does NOT connect to live Azure/PostgreSQL, does NOT execute live
 * queries, and does NOT add apply/DDL/ledger capability.
 */

const {
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  OBSERVER_DSN_ENV,
  assertNoLeakedDsn,
} = require('./sunset-schema-observer');
const {
  ENV_PG_ADMIN_USER,
  ENV_PG_ADMIN_PASSWORD,
} = require('./sunset-schema-observer-role-provision');
const {
  AUTHORIZED_AGGREGATE_SQL,
  OUTPUT_KEYS,
  authorizeAggregateSql,
  sanitizeError,
  PHASE_D_LIVE_APPLY_ENABLED,
  AGGREGATE_CONTRACT,
} = require('./phase-d-check-preflight');

/** Locked Azure / PostgreSQL target for Sunset staging only. */
const TARGETS = Object.freeze({
  subscriptionId: '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9',
  resourceGroup: 'luna-sunset-staging-rg',
  postgresServer: 'luna-sunset-staging-pg-app',
  postgresHost: EXPECTED_HOST,
  database: EXPECTED_DATABASE,
  sslmode: 'verify-full',
  applicationName: 'wh-sunset-phase-d-preflight',
  port: 5432,
});

/**
 * Hard-disabled in Slice 14B. A later approved slice may flip this to allow
 * a real read-only connect + 14A count-only preflight — never apply/DDL.
 */
const PHASE_D_LIVE_READONLY_CONNECT_ENABLED = false;

/** Dual enable flags — both required before the exact target may be accepted. */
const ENV_LIVE_READONLY = 'SUNSET_PHASE_D_LIVE_READONLY';
const ENV_LIVE_PREFLIGHT = 'SUNSET_PHASE_D_LIVE_PREFLIGHT';
const ENV_SUBSCRIPTION = 'AZURE_SUBSCRIPTION_ID';

/**
 * Protected admin credential env only (same contract as Slice 9 provisioner /
 * load-sunset-staging-pg-admin-env.js). Never observer DSN / file / argv.
 */
const CREDENTIAL_USER_ENV = ENV_PG_ADMIN_USER;
const CREDENTIAL_PASSWORD_ENV = ENV_PG_ADMIN_PASSWORD;
const FORBIDDEN_DSN_ENVS = Object.freeze([
  OBSERVER_DSN_ENV,
  'WOLFHOUSE_DATABASE_URL',
  'SUNSET_PHASE_D_LIVE_DSN_FILE',
  'DATABASE_URL',
]);

const FORBIDDEN_NETWORK_MUTATION_MARKERS = Object.freeze([
  'firewall-rule',
  'firewall rule',
  'vnet-rule',
  'private-endpoint',
  'network-rule',
]);

const REDACTED = '***REDACTED***';

const SCHEMA = 'public';
const TABLE = 'tenant_services';

/** Exact catalog SQL used by Slice 14A schema gates (locked; counts/types only). */
const AUTHORIZED_TABLE_EXISTS_SQL = [
  'SELECT 1',
  'FROM pg_class rel',
  'JOIN pg_namespace n ON n.oid = rel.relnamespace',
  'WHERE n.nspname = $1',
  'AND rel.relname = $2',
  "AND rel.relkind = 'r'",
].join('\n');

const AUTHORIZED_COLUMN_CATALOG_SQL = [
  'SELECT',
  '  a.attname AS name,',
  '  t.typname AS udt_name,',
  '  NOT a.attnotnull AS is_nullable',
  'FROM pg_attribute a',
  'JOIN pg_type t ON t.oid = a.atttypid',
  'JOIN pg_class rel ON rel.oid = a.attrelid',
  'JOIN pg_namespace n ON n.oid = rel.relnamespace',
  'WHERE n.nspname = $1',
  '  AND rel.relname = $2',
  '  AND a.attnum > 0',
  '  AND NOT a.attisdropped',
  '  AND a.attname = ANY($3::text[])',
  'ORDER BY a.attname',
].join('\n');

const AUTHORIZED_SESSION_SQL = Object.freeze([
  'BEGIN READ ONLY',
  'SHOW transaction_read_only',
  'COMMIT',
  'ROLLBACK',
]);

const OUTPUT_COUNT_KEYS = OUTPUT_KEYS;

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function validateTargets(candidate) {
  const errors = [];
  const c = candidate || {};
  const checks = [
    ['subscriptionId', TARGETS.subscriptionId, 'wrong_subscription'],
    ['resourceGroup', TARGETS.resourceGroup, 'wrong_resource_group'],
    ['postgresServer', TARGETS.postgresServer, 'wrong_postgres_server'],
    ['postgresHost', TARGETS.postgresHost, 'wrong_postgres_host'],
    ['database', TARGETS.database, 'wrong_database'],
    ['sslmode', TARGETS.sslmode, 'tls_not_verify_full'],
    ['applicationName', TARGETS.applicationName, 'wrong_application_name'],
  ];
  for (const [key, expected, code] of checks) {
    if (String(c[key] || '') !== expected) {
      errors.push({
        code,
        message: `${key} must be exactly ${expected}`,
        got: c[key] == null ? null : String(c[key]),
      });
    }
  }
  if (/wolfhouse|production|^prod$/i.test(String(c.database || ''))
    && String(c.database || '') !== TARGETS.database) {
    errors.push({ code: 'forbidden_database', message: 'forbidden database name' });
  }
  if (/wh-prod|wh-staging-rg|wolfhouse/i.test(String(c.resourceGroup || ''))) {
    errors.push({ code: 'forbidden_resource_group', message: 'forbidden resource group' });
  }
  return { ok: errors.length === 0, errors };
}

function assertNoNetworkMutation(commandText) {
  const s = String(commandText || '').toLowerCase();
  const hits = [];
  for (const marker of FORBIDDEN_NETWORK_MUTATION_MARKERS) {
    if (s.includes(marker)) hits.push(marker);
  }
  return { ok: hits.length === 0, hits };
}

function assertNoSecretInArgv(argv, secrets) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const list = (secrets || []).filter(Boolean).map(String);
  const leaks = [];
  for (const arg of args) {
    for (const secret of list) {
      if (secret && arg.includes(secret)) {
        leaks.push({ arg: REDACTED, reason: 'secret_in_argv' });
      }
    }
  }
  return { ok: leaks.length === 0, leaks };
}

function redactSecrets(text, secrets) {
  let out = String(text == null ? '' : text);
  const list = (secrets || []).filter(Boolean).map(String).sort((a, b) => b.length - a.length);
  for (const secret of list) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
  }
  out = out.replace(/postgres(?:ql)?:\/\/[^:\s/@]+:[^@\s/]+@/gi, `postgresql://${REDACTED}:`);
  return out;
}

function redactDeep(value, secrets, depth) {
  const d = depth == null ? 0 : depth;
  if (d > 8) return REDACTED;
  if (value == null) return value;
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecrets(value.message, secrets),
      code: value.code,
    };
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets, d + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Redact secret-bearing fields only — not metadata keys like credentialSource.
      if (/^(?:_?(?:password|user|username|dsn|secret)|.*(?:password|secret|dsn))$/i.test(k)
        && typeof v === 'string') {
        out[k] = REDACTED;
      } else {
        out[k] = redactDeep(v, secrets, d + 1);
      }
    }
    return out;
  }
  return value;
}

function shapeCountOnlyResult(row) {
  const out = {
    total_rows: Number(row.total_rows),
    date_window_violations: Number(row.date_window_violations),
    price_unit_violations: Number(row.price_unit_violations),
  };
  for (const k of Object.keys(out)) {
    if (!OUTPUT_COUNT_KEYS.includes(k)) {
      throw Object.assign(new Error('aggregate output shape drift'), {
        code: 'output_shape_drift',
      });
    }
    if (!Number.isFinite(out[k]) || out[k] < 0 || !Number.isInteger(out[k])) {
      throw Object.assign(new Error('aggregate count must be a non-negative integer'), {
        code: 'invalid_aggregate_count',
      });
    }
  }
  return {
    total_rows: out.total_rows,
    date_window_violations: out.date_window_violations,
    price_unit_violations: out.price_unit_violations,
  };
}

function authorizeLiveReadonlySql(sql) {
  const normalized = normalizeSql(sql);
  if (!normalized) {
    throw Object.assign(new Error('empty SQL rejected'), { code: 'unauthorized_sql' });
  }

  for (const session of AUTHORIZED_SESSION_SQL) {
    if (normalized === normalizeSql(session)) {
      return { ok: true, kind: 'session', sql: session };
    }
  }

  if (normalized === normalizeSql(AUTHORIZED_TABLE_EXISTS_SQL)) {
    return { ok: true, kind: 'catalog_table', sql: AUTHORIZED_TABLE_EXISTS_SQL };
  }
  if (normalized === normalizeSql(AUTHORIZED_COLUMN_CATALOG_SQL)) {
    return { ok: true, kind: 'catalog_columns', sql: AUTHORIZED_COLUMN_CATALOG_SQL };
  }

  // Exact 14A aggregate only — delegates to Slice 14A authorizer (predicates unchanged).
  try {
    const locked = authorizeAggregateSql(sql);
    return { ok: true, kind: 'aggregate', sql: locked };
  } catch (e) {
    if (e && e.code === 'unauthorized_sql') {
      throw e;
    }
    throw Object.assign(
      new Error('unauthorized SQL rejected: only 14A catalog + aggregate + session SQL permitted'),
      { code: 'unauthorized_sql' },
    );
  }
}

/**
 * Dual-flag gate. Both env flags must be exactly "1", and subscription env
 * must match the locked Sunset staging subscription.
 */
function evaluateDualEnableFlags(env) {
  const e = env || {};
  const errors = [];
  if (String(e[ENV_LIVE_READONLY] || '') !== '1') {
    errors.push({
      code: 'live_readonly_flag_required',
      message: `env ${ENV_LIVE_READONLY}=1 is required`,
    });
  }
  if (String(e[ENV_LIVE_PREFLIGHT] || '') !== '1') {
    errors.push({
      code: 'live_preflight_flag_required',
      message: `env ${ENV_LIVE_PREFLIGHT}=1 is required`,
    });
  }
  if (String(e[ENV_SUBSCRIPTION] || '') !== TARGETS.subscriptionId) {
    errors.push({
      code: 'subscription_env_mismatch',
      message: `${ENV_SUBSCRIPTION} must equal locked Sunset staging subscription`,
    });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Build connect config for the locked Sunset staging host/database only.
 * Host, database, port, sslmode, and application_name are never caller-supplied.
 * User/password stay on private fields only — never evidence/errors/output.
 */
function buildLockedAdminConnectConfig(user, password) {
  return {
    host: TARGETS.postgresHost,
    port: TARGETS.port,
    database: TARGETS.database,
    sslmode: TARGETS.sslmode,
    application_name: TARGETS.applicationName,
    // Private — never copy into evidence/output/errors.
    _user: String(user),
    _password: String(password),
  };
}

function secretFreeConnectInfo(connectConfig) {
  const c = connectConfig || {};
  return {
    host: c.host,
    port: c.port,
    database: c.database,
    sslmode: c.sslmode,
    application_name: c.application_name,
    hasUser: Boolean(c._user),
    hasPassword: Boolean(c._password),
  };
}

/**
 * Resolve protected admin credentials only.
 * Never accepts caller-supplied DSN, argv credential, observer DSN,
 * WOLFHOUSE_DATABASE_URL, or arbitrary file path.
 * Never returns username/password in the public result — private fields only.
 */
function resolveProtectedAdminCredentials(opts) {
  const options = opts || {};
  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  const errors = [];

  // Reject caller-supplied DSN options immediately.
  if (options.dsn != null || options.connectionString != null
    || options.databaseUrl != null || options.connectConfig != null) {
    errors.push({
      code: 'caller_supplied_dsn_forbidden',
      message: 'caller-supplied DSN / connection config is forbidden',
    });
    return { ok: false, errors, source: null };
  }

  // Reject credential-shaped argv immediately.
  for (const arg of argv) {
    if (/postgres(?:ql)?:\/\//i.test(String(arg))
      || /--(?:dsn|database-url|password|pg-password)=/i.test(String(arg))) {
      errors.push({
        code: 'credential_from_argv_forbidden',
        message: 'credentials must not appear in argv',
      });
      return { ok: false, errors, source: null };
    }
  }

  // Forbidden alternate credential sources — never accept as this boundary's contract.
  for (const name of FORBIDDEN_DSN_ENVS) {
    if (String(env[name] || '').trim()) {
      const code = name === OBSERVER_DSN_ENV
        ? 'observer_dsn_forbidden'
        : name === 'WOLFHOUSE_DATABASE_URL'
          ? 'wolfhouse_database_url_forbidden'
          : name === 'SUNSET_PHASE_D_LIVE_DSN_FILE'
            ? 'credential_file_path_forbidden'
            : 'forbidden_dsn_env';
      errors.push({
        code,
        message: `${name} is not an accepted credential source for Phase D live read-only`,
      });
      return { ok: false, errors, source: null };
    }
  }

  if (options.credentialFilePath || options.readFileSync) {
    errors.push({
      code: 'credential_file_path_forbidden',
      message: 'arbitrary credential file paths are forbidden',
    });
    return { ok: false, errors, source: null };
  }

  const user = String(env[CREDENTIAL_USER_ENV] || '').trim();
  const password = String(env[CREDENTIAL_PASSWORD_ENV] || '').trim();

  if (!user && !password) {
    errors.push({
      code: 'credential_source_missing',
      message: `set ${CREDENTIAL_USER_ENV} and ${CREDENTIAL_PASSWORD_ENV} (via locked Key Vault loader)`,
    });
    return { ok: false, errors, source: null };
  }
  if (!user) {
    errors.push({
      code: 'pg_admin_user_required',
      message: `${CREDENTIAL_USER_ENV} is required`,
    });
    return { ok: false, errors, source: null };
  }
  if (!password) {
    errors.push({
      code: 'pg_admin_password_required',
      message: `${CREDENTIAL_PASSWORD_ENV} is required`,
    });
    return { ok: false, errors, source: null };
  }

  const argvCheck = assertNoSecretInArgv(argv, [user, password]);
  if (!argvCheck.ok) {
    errors.push({
      code: 'credential_from_argv_forbidden',
      message: 'credentials must not appear in argv',
    });
    return { ok: false, errors, source: null };
  }

  const connectConfig = buildLockedAdminConnectConfig(user, password);
  return {
    ok: true,
    errors: [],
    source: 'protected_admin_env',
    userEnv: CREDENTIAL_USER_ENV,
    passwordEnv: CREDENTIAL_PASSWORD_ENV,
    connectInfo: secretFreeConnectInfo(connectConfig),
    // Private — never copy into evidence/output.
    _connectConfig: connectConfig,
    _user: user,
    _password: password,
  };
}

/** @deprecated alias — prefer resolveProtectedAdminCredentials */
function resolveApprovedCredentials(opts) {
  return resolveProtectedAdminCredentials(opts);
}

function assertLockedConnectConfig(connectConfig) {
  const c = connectConfig || {};
  const errors = [];
  if (String(c.host || '') !== TARGETS.postgresHost) {
    errors.push({
      code: 'wrong_host',
      message: `host must be exactly ${TARGETS.postgresHost}`,
    });
  }
  if (String(c.database || '') !== TARGETS.database) {
    errors.push({
      code: 'wrong_database',
      message: `database must be exactly ${TARGETS.database}`,
    });
  }
  if (String(c.sslmode || '') !== 'verify-full') {
    errors.push({
      code: 'tls_not_verify_full',
      message: 'connection must use sslmode=verify-full',
    });
  }
  if (String(c.application_name || '') !== TARGETS.applicationName) {
    errors.push({
      code: 'wrong_application_name',
      message: `application_name must be ${TARGETS.applicationName}`,
    });
  }
  if (Number(c.port) !== TARGETS.port) {
    errors.push({
      code: 'wrong_port',
      message: `port must be exactly ${TARGETS.port}`,
    });
  }
  if (!c._user || !c._password) {
    errors.push({
      code: 'credential_source_missing',
      message: 'protected admin user and password required',
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    connectInfo: secretFreeConnectInfo(c),
  };
}

/** @deprecated alias — DSN paths removed; admin connect config is locked. */
function assertCredentialDsnMatchesLockedTarget() {
  return {
    ok: false,
    errors: [{
      code: 'caller_supplied_dsn_forbidden',
      message: 'caller-supplied DSN is forbidden; use protected admin env only',
    }],
  };
}

/**
 * Verify Azure identity (subscription / RG / Postgres FQDN) via injected
 * adapters — read-only show only. Never mutates firewall/network.
 */
async function verifyLiveAzureTargets(adapters, targets) {
  const t = targets || TARGETS;
  const a = adapters || {};
  const errors = [];

  if (typeof a.getAccount !== 'function'
    || typeof a.getResourceGroup !== 'function'
    || typeof a.getPostgresServer !== 'function') {
    return {
      ok: false,
      errors: [{ code: 'missing_azure_adapters', message: 'live Azure verify adapters required' }],
    };
  }

  const account = await a.getAccount();
  if (!account || String(account.id || account.subscriptionId || '') !== t.subscriptionId) {
    errors.push({
      code: 'wrong_live_subscription',
      message: 'az account subscription must match locked Sunset staging subscription',
    });
  }

  const rg = await a.getResourceGroup(t.resourceGroup, t.subscriptionId);
  if (!rg || String(rg.name || '') !== t.resourceGroup) {
    errors.push({
      code: 'wrong_live_resource_group',
      message: `resource group must be exactly ${t.resourceGroup}`,
    });
  }

  const pg = await a.getPostgresServer(t.resourceGroup, t.postgresServer, t.subscriptionId);
  const fqdn = pg && (pg.fullyQualifiedDomainName || pg.host);
  if (!pg || String(pg.name || '') !== t.postgresServer) {
    errors.push({
      code: 'wrong_live_postgres_server',
      message: `postgres server must be exactly ${t.postgresServer}`,
    });
  }
  if (String(fqdn || '') !== t.postgresHost) {
    errors.push({
      code: 'wrong_live_postgres_fqdn',
      message: `postgres FQDN must be exactly ${t.postgresHost}`,
      got: fqdn == null ? null : String(fqdn),
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Inspect intended DB connect parameters via adapters.connectInfo only.
 * Does not open a connection (Slice 14B never connects).
 */
async function assertConnectInfoBoundary(adapters, targets) {
  const t = targets || TARGETS;
  const a = adapters || {};
  if (typeof a.connectInfo !== 'function') {
    return {
      ok: false,
      errors: [{ code: 'missing_db_adapters', message: 'connectInfo adapter required' }],
    };
  }
  const info = await a.connectInfo();
  const errors = [];
  if (!info || String(info.host || '') !== t.postgresHost) {
    errors.push({
      code: 'wrong_db_connect_host',
      message: `must connect to locked host ${t.postgresHost}`,
      got: info && info.host ? String(info.host) : null,
    });
  }
  if (!info || String(info.sslmode || '').toLowerCase() !== 'verify-full') {
    errors.push({
      code: 'db_tls_not_verify_full',
      message: 'connection must use sslmode=verify-full',
    });
  }
  if (info && info.database != null && String(info.database) !== t.database) {
    errors.push({
      code: 'wrong_db_connect_database',
      message: `database must be exactly ${t.database}`,
      got: String(info.database),
    });
  }
  if (info && info.application_name != null
    && String(info.application_name) !== t.applicationName) {
    errors.push({
      code: 'wrong_application_name',
      message: `application_name must be ${t.applicationName}`,
    });
  }
  return { ok: errors.length === 0, errors };
}

function buildSecretFreePlan(credentialSource) {
  return {
    kind: 'phase-d-live-readonly-boundary-plan',
    targets: { ...TARGETS },
    beginReadOnly: true,
    sslmode: 'verify-full',
    applicationName: TARGETS.applicationName,
    credentialSource,
    authorizedSessionSql: AUTHORIZED_SESSION_SQL.slice(),
    authorizedCatalogSql: [
      AUTHORIZED_TABLE_EXISTS_SQL,
      AUTHORIZED_COLUMN_CATALOG_SQL,
    ],
    authorizedAggregateSql: AUTHORIZED_AGGREGATE_SQL,
    outputKeys: OUTPUT_COUNT_KEYS.slice(),
    returnsRowValues: false,
    returnsIdentifiers: false,
    returnsGuestData: false,
    acceptsArbitrarySql: false,
    mutates: false,
    appliesConstraints: false,
    writesLedger: false,
    firewallMutation: false,
    networkMutation: false,
    liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
    liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true,
    liveQueryExecution: false,
  };
}

/**
 * Evaluate the live read-only boundary. Default path (missing dual flags)
 * makes zero connection calls. Exact target is accepted only when dual flags
 * are set and all locks pass — still hard-disabled for real connect/query.
 *
 * @param {object} opts
 * @param {object} [opts.env]
 * @param {string[]} [opts.argv]
 * @param {object} [opts.targets]
 * @param {object} [opts.azureAdapters]
 * @param {object} [opts.dbAdapters]
 * @param {function} [opts.readFileSync]
 * @param {string[]} [opts.plannedCommands] optional az/command text to scan
 */
async function evaluateLiveReadonlyBoundary(opts) {
  const options = opts || {};
  const env = options.env || {};
  const argv = options.argv || [];
  const targets = options.targets || TARGETS;
  const counters = {
    azureCalls: 0,
    connectInfoCalls: 0,
    connectCalls: 0,
    queryCalls: 0,
  };

  const wrapAzure = wrapCountingAdapters(options.azureAdapters, counters, 'azure');
  const wrapDb = wrapCountingAdapters(options.dbAdapters, counters, 'db');

  const flagGate = evaluateDualEnableFlags(env);
  if (!flagGate.ok) {
    return redactDeep({
      ok: false,
      accepted: false,
      code: 'live_readonly_flags_required',
      errors: flagGate.errors,
      counters,
      liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
      liveQueryExecution: false,
      liveMutation: false,
    }, []);
  }

  const targetGate = validateTargets(targets);
  if (!targetGate.ok) {
    return redactDeep({
      ok: false,
      accepted: false,
      code: 'wrong_target',
      errors: targetGate.errors,
      counters,
      liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
      liveQueryExecution: false,
      liveMutation: false,
    }, []);
  }

  for (const cmd of options.plannedCommands || []) {
    const net = assertNoNetworkMutation(cmd);
    if (!net.ok) {
      return redactDeep({
        ok: false,
        accepted: false,
        code: 'network_mutation_forbidden',
        errors: [{ code: 'network_mutation_forbidden', hits: net.hits }],
        counters,
        liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
        liveQueryExecution: false,
        liveMutation: false,
      }, []);
    }
  }

  const creds = resolveProtectedAdminCredentials({
    env,
    argv,
    dsn: options.dsn,
    connectionString: options.connectionString,
    databaseUrl: options.databaseUrl,
    connectConfig: options.connectConfig,
    credentialFilePath: options.credentialFilePath,
    readFileSync: options.readFileSync,
  });
  const secrets = [creds._user, creds._password].filter(Boolean);
  if (!creds.ok) {
    return redactDeep({
      ok: false,
      accepted: false,
      code: 'credential_source_rejected',
      errors: creds.errors,
      counters,
      liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
      liveQueryExecution: false,
      liveMutation: false,
    }, secrets);
  }

  const configGate = assertLockedConnectConfig(creds._connectConfig);
  if (!configGate.ok) {
    return redactDeep({
      ok: false,
      accepted: false,
      code: 'credential_target_rejected',
      errors: configGate.errors,
      counters,
      liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
      liveQueryExecution: false,
      liveMutation: false,
    }, secrets);
  }

  // Azure identity verify (read-only) — before any connect.
  if (wrapAzure) {
    const azure = await verifyLiveAzureTargets(wrapAzure, targets);
    if (!azure.ok) {
      return redactDeep({
        ok: false,
        accepted: false,
        code: 'azure_target_rejected',
        errors: azure.errors,
        counters,
        liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
        liveQueryExecution: false,
        liveMutation: false,
      }, secrets);
    }
  }

  // connectInfo only — never connect/query in this slice.
  if (wrapDb) {
    const infoGate = await assertConnectInfoBoundary(wrapDb, targets);
    if (!infoGate.ok) {
      return redactDeep({
        ok: false,
        accepted: false,
        code: 'db_connect_info_rejected',
        errors: infoGate.errors,
        counters,
        liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
        liveQueryExecution: false,
        liveMutation: false,
      }, secrets);
    }
  }

  // Hard-disabled connect: even with dual flags + exact target, refuse connect.
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) {
    const plan = buildSecretFreePlan(creds.source);
    return redactDeep({
      ok: true,
      accepted: true,
      code: 'target_accepted_connect_hard_disabled',
      plan,
      counters,
      liveReadonlyConnectEnabled: false,
      liveQueryExecution: false,
      liveMutation: false,
      appliesConstraints: false,
      writesLedger: false,
      note: 'Exact target accepted under dual flags; live connect/query remains hard-disabled in Slice 14B',
    }, secrets);
  }

  // Future path (not reachable while hard-disabled): would connect + run 14A.
  return redactDeep({
    ok: false,
    accepted: false,
    code: 'live_readonly_connect_not_implemented',
    errors: [{
      code: 'live_readonly_connect_not_implemented',
      message: 'live connect path is reserved for a later approved slice',
    }],
    counters,
    liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
    liveQueryExecution: false,
    liveMutation: false,
  }, secrets);
}

function wrapCountingAdapters(adapters, counters, kind) {
  if (!adapters) return null;
  const out = {};
  for (const [name, fn] of Object.entries(adapters)) {
    if (typeof fn !== 'function') {
      out[name] = fn;
      continue;
    }
    out[name] = async (...args) => {
      if (kind === 'azure') counters.azureCalls += 1;
      if (kind === 'db' && name === 'connectInfo') counters.connectInfoCalls += 1;
      if (kind === 'db' && name === 'connect') counters.connectCalls += 1;
      if (kind === 'db' && name === 'query') counters.queryCalls += 1;
      return fn(...args);
    };
  }
  return out;
}

/**
 * Default entry: evaluate with process env. Makes zero connection calls when
 * dual flags are unset (the normal operator path).
 */
async function defaultLiveReadonlyBoundaryPath(opts) {
  return evaluateLiveReadonlyBoundary({
    ...(opts || {}),
    env: (opts && opts.env) || process.env,
    argv: (opts && opts.argv) || process.argv.slice(0, 2), // never scan secrets from argv
  });
}

function assertNoLiveApply() {
  if (PHASE_D_LIVE_APPLY_ENABLED) {
    throw Object.assign(new Error('live apply must remain disabled'), {
      code: 'live_apply_forbidden',
    });
  }
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED) {
    // Connect may be enabled in a later slice; apply must still be false.
  }
}

function assertSecretFreeText(text, secrets) {
  const hits = assertNoLeakedDsn(text, (secrets || [])[0] || null);
  const leaked = [];
  for (const s of secrets || []) {
    if (s && String(text || '').includes(s)) leaked.push('raw_secret');
  }
  return { ok: hits.length === 0 && leaked.length === 0, hits: [...hits, ...leaked] };
}

module.exports = {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  CREDENTIAL_USER_ENV,
  CREDENTIAL_PASSWORD_ENV,
  FORBIDDEN_DSN_ENVS,
  OBSERVER_DSN_ENV,
  FORBIDDEN_NETWORK_MUTATION_MARKERS,
  REDACTED,
  AUTHORIZED_AGGREGATE_SQL,
  AUTHORIZED_TABLE_EXISTS_SQL,
  AUTHORIZED_COLUMN_CATALOG_SQL,
  AUTHORIZED_SESSION_SQL,
  OUTPUT_COUNT_KEYS,
  SCHEMA,
  TABLE,
  AGGREGATE_CONTRACT,
  validateTargets,
  evaluateDualEnableFlags,
  resolveProtectedAdminCredentials,
  resolveApprovedCredentials,
  buildLockedAdminConnectConfig,
  secretFreeConnectInfo,
  assertLockedConnectConfig,
  assertCredentialDsnMatchesLockedTarget,
  authorizeLiveReadonlySql,
  authorizeAggregateSql,
  shapeCountOnlyResult,
  sanitizeError,
  assertNoNetworkMutation,
  assertNoSecretInArgv,
  assertSecretFreeText,
  redactSecrets,
  redactDeep,
  verifyLiveAzureTargets,
  assertConnectInfoBoundary,
  buildSecretFreePlan,
  evaluateLiveReadonlyBoundary,
  defaultLiveReadonlyBoundaryPath,
  assertNoLiveApply,
  normalizeSql,
};
