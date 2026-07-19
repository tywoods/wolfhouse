'use strict';

/**
 * FOUNDATION Slice 14B — Phase D live read-only connection boundary
 *
 * Hard-disabled boundary that can later run the merged Slice 14A count-only
 * preflight against the exact Sunset staging PostgreSQL/database.
 *
 * Locks: subscription, resource group, server FQDN, database, TLS verify-full,
 * application_name, BEGIN READ ONLY. Credentials only from approved env/file
 * path — never argv, output, evidence, or committed files.
 *
 * This slice does NOT connect to live Azure/PostgreSQL, does NOT execute live
 * queries, and does NOT add apply/DDL/ledger capability.
 */

const fs = require('fs');
const path = require('path');
const {
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  OBSERVER_DSN_ENV,
  parseDatabaseUrl,
  assertObserverTarget,
  assertNoLeakedDsn,
} = require('./sunset-schema-observer');
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

/** Approved credential sources only (never argv / evidence / committed files). */
const CREDENTIAL_ENV = OBSERVER_DSN_ENV; // SUNSET_SCHEMA_OBSERVER_DATABASE_URL
const CREDENTIAL_FILE_ENV = 'SUNSET_PHASE_D_LIVE_DSN_FILE';

const APPROVED_CREDENTIAL_FILE_PREFIXES = Object.freeze([
  '/run/secrets/',
  '/var/run/secrets/',
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
      if (/password|secret|dsn|credential/i.test(k) && typeof v === 'string') {
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

function isPathInsideRepo(absPath) {
  const root = path.resolve(path.join(__dirname, '..', '..'));
  const resolved = path.resolve(absPath);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

/**
 * Resolve credentials from approved env or approved file path only.
 * Never reads argv. Never returns the secret in the public result — callers
 * that need the DSN for a later connect receive it only via private field
 * when connect is enabled (not in Slice 14B evidence).
 */
function resolveApprovedCredentials(opts) {
  const options = opts || {};
  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  const errors = [];

  // Reject credential-shaped argv immediately.
  for (const arg of argv) {
    if (/postgres(?:ql)?:\/\//i.test(String(arg))) {
      errors.push({
        code: 'credential_from_argv_forbidden',
        message: 'credentials must not appear in argv',
      });
      return { ok: false, errors, source: null };
    }
  }

  const filePathRaw = String(env[CREDENTIAL_FILE_ENV] || '').trim();
  const envDsn = String(env[CREDENTIAL_ENV] || '').trim();

  if (filePathRaw) {
    if (!path.isAbsolute(filePathRaw)) {
      errors.push({
        code: 'credential_file_not_absolute',
        message: `${CREDENTIAL_FILE_ENV} must be an absolute path`,
      });
      return { ok: false, errors, source: null };
    }
    const approvedPrefix = APPROVED_CREDENTIAL_FILE_PREFIXES.some((p) => filePathRaw.startsWith(p));
    if (!approvedPrefix) {
      errors.push({
        code: 'credential_file_path_not_approved',
        message: `${CREDENTIAL_FILE_ENV} path is outside approved prefixes`,
      });
      return { ok: false, errors, source: null };
    }
    if (isPathInsideRepo(filePathRaw)) {
      errors.push({
        code: 'credential_from_committed_file_forbidden',
        message: 'credentials must not come from committed repository files',
      });
      return { ok: false, errors, source: null };
    }

    let dsn;
    try {
      if (typeof options.readFileSync === 'function') {
        dsn = String(options.readFileSync(filePathRaw, 'utf8')).trim();
      } else {
        dsn = fs.readFileSync(filePathRaw, 'utf8').trim();
      }
    } catch (_) {
      errors.push({
        code: 'credential_file_unreadable',
        message: 'approved credential file could not be read',
      });
      return { ok: false, errors, source: null };
    }
    if (!dsn) {
      errors.push({
        code: 'credential_file_empty',
        message: 'approved credential file is empty',
      });
      return { ok: false, errors, source: null };
    }
    const argvCheck = assertNoSecretInArgv(argv, [dsn]);
    if (!argvCheck.ok) {
      errors.push({
        code: 'credential_from_argv_forbidden',
        message: 'credentials must not appear in argv',
      });
      return { ok: false, errors, source: null };
    }
    return {
      ok: true,
      errors: [],
      source: 'approved_file',
      fileEnv: CREDENTIAL_FILE_ENV,
      // Private — never copy into evidence/output.
      _dsn: dsn,
    };
  }

  if (!envDsn) {
    errors.push({
      code: 'credential_source_missing',
      message: `set ${CREDENTIAL_ENV} or ${CREDENTIAL_FILE_ENV}`,
    });
    return { ok: false, errors, source: null };
  }

  const argvCheck = assertNoSecretInArgv(argv, [envDsn]);
  if (!argvCheck.ok) {
    errors.push({
      code: 'credential_from_argv_forbidden',
      message: 'credentials must not appear in argv',
    });
    return { ok: false, errors, source: null };
  }

  return {
    ok: true,
    errors: [],
    source: 'approved_env',
    envName: CREDENTIAL_ENV,
    _dsn: envDsn,
  };
}

function assertCredentialDsnMatchesLockedTarget(dsn) {
  const parsed = parseDatabaseUrl(dsn);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.errors && parsed.errors.length
        ? parsed.errors
        : [{ code: 'dsn_parse_failed', message: 'DSN is not a valid URL' }],
    };
  }
  const target = assertObserverTarget(parsed.parsed, { allowLocalEphemeral: false });
  if (!target.ok) {
    return { ok: false, errors: target.errors };
  }
  if (String(parsed.parsed.sslmode || '') !== 'verify-full') {
    return {
      ok: false,
      errors: [{
        code: 'tls_not_verify_full',
        message: 'DSN must use sslmode=verify-full',
      }],
    };
  }
  if (String(parsed.parsed.host || '') !== TARGETS.postgresHost) {
    return {
      ok: false,
      errors: [{
        code: 'wrong_host',
        message: `host must be exactly ${TARGETS.postgresHost}`,
      }],
    };
  }
  if (String(parsed.parsed.database || '') !== TARGETS.database) {
    return {
      ok: false,
      errors: [{
        code: 'wrong_database',
        message: `database must be exactly ${TARGETS.database}`,
      }],
    };
  }
  return {
    ok: true,
    errors: [],
    parsed: {
      host: parsed.parsed.host,
      database: parsed.parsed.database,
      sslmode: parsed.parsed.sslmode,
      port: parsed.parsed.port,
      user: parsed.parsed.user,
      hasPassword: parsed.parsed.hasPassword,
      // never include password
    },
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

  const creds = resolveApprovedCredentials({
    env,
    argv,
    readFileSync: options.readFileSync,
  });
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
    }, []);
  }

  const dsnGate = assertCredentialDsnMatchesLockedTarget(creds._dsn);
  const secrets = [creds._dsn];
  if (!dsnGate.ok) {
    return redactDeep({
      ok: false,
      accepted: false,
      code: 'credential_target_rejected',
      errors: dsnGate.errors,
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
  CREDENTIAL_ENV,
  CREDENTIAL_FILE_ENV,
  APPROVED_CREDENTIAL_FILE_PREFIXES,
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
  resolveApprovedCredentials,
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
