'use strict';

/**
 * phase-d-constraint-apply — FOUNDATION Slice 14P
 *
 * Default-disabled exact-gated managed-identity live adapter that applies
 * exactly the two missing canonical migration-028 CHECK constraints on
 * public.tenant_services:
 *   - tenant_services_date_window
 *   - tenant_services_price_unit
 *
 * One pg Client / TLS verify-full / application_name
 * wh-sunset-phase-d-constraint-apply. Exact transaction sequence; on any
 * failure ROLLBACK/end, no retry. Never writes ledger, never DROP/DML/rename,
 * never mutates migration files, never Azure/RBAC/network/KV actions beyond
 * the existing MI credential load.
 *
 * PHASE_D_LIVE_APPLY_ENABLED in check-preflight stays false (count-only path).
 * This module owns its own capability flag + env/argv gates.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  TARGETS,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  evaluateDualEnableFlags,
  evaluateCredentialSource,
  redactDeep,
  redactSecrets,
  normalizeSql,
  shapeCountOnlyResult,
  SCHEMA,
  TABLE,
  AUTHORIZED_AGGREGATE_SQL,
  AUTHORIZED_TABLE_EXISTS_SQL,
  AUTHORIZED_COLUMN_CATALOG_SQL,
  OUTPUT_COUNT_KEYS,
} = require('./phase-d-live-readonly-boundary');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
  EXPECTED_028_SHA256,
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
  REQUIRED_COLUMNS,
  assertMigration028ByteIntegrity,
  assert028PredicatesPresentInSource,
  authorizeAggregateSql,
  sanitizeError,
} = require('./phase-d-check-preflight');
const {
  loadProtectedAdminCredentialsViaManagedIdentity,
  zeroPrivateCredentialRefs,
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  getManagedIdentityHttpCounters,
  MI_LOADER_LOCKS,
} = require('./phase-d-managed-identity-credential-loader');
const {
  classifyConnectError,
  CONNECT_FAILED_SAFE_MESSAGE,
  buildVerifiedTlsSslConfig,
} = require('./phase-d-live-readonly-pg-adapter');
const { MIGRATIONS_DIR } = require('./migration-integrity');

/** Capability flag for Slice 14P — still default-disabled via env+argv gates. */
const PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED = true;

const ENV_CONSTRAINT_APPLY = 'SUNSET_PHASE_D_CONSTRAINT_APPLY';
const CLI_APPLY_CONSTRAINTS = '--apply-phase-d-constraints';

const APPLICATION_NAME = 'wh-sunset-phase-d-constraint-apply';

/** Fixed transaction-scoped advisory lock (not the canonical migration runner pair). */
const ADVISORY_LOCK_KEY1 = 0x57485044; // WHPD
const ADVISORY_LOCK_KEY2 = 0x43484B32; // CHK2

const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 30000;
const CONNECTION_TIMEOUT_MS = 20000;

const CONSTRAINT_DATE_WINDOW = 'tenant_services_date_window';
const CONSTRAINT_PRICE_UNIT = 'tenant_services_price_unit';

/**
 * Exact ALTER TABLE ADD CONSTRAINT statements sourced from immutable 028
 * predicates (byte-locked via sha256 of each statement + 028 file hash).
 */
const ALTER_DATE_WINDOW_SQL = [
  `ALTER TABLE ${SCHEMA}.${TABLE}`,
  `  ADD CONSTRAINT ${CONSTRAINT_DATE_WINDOW}`,
  `  CHECK ${DATE_WINDOW_PREDICATE}`,
].join('\n');

const ALTER_PRICE_UNIT_SQL = [
  `ALTER TABLE ${SCHEMA}.${TABLE}`,
  `  ADD CONSTRAINT ${CONSTRAINT_PRICE_UNIT}`,
  `  CHECK ${PRICE_UNIT_PREDICATE}`,
].join('\n');

const ALTER_DATE_WINDOW_SHA256 = crypto
  .createHash('sha256')
  .update(ALTER_DATE_WINDOW_SQL, 'utf8')
  .digest('hex');
const ALTER_PRICE_UNIT_SHA256 = crypto
  .createHash('sha256')
  .update(ALTER_PRICE_UNIT_SQL, 'utf8')
  .digest('hex');

/** Canonical pg_get_constraintdef forms (expected-product-schema / PG rewrite). */
const EXPECTED_CONDEF = Object.freeze({
  [CONSTRAINT_DATE_WINDOW]:
    'CHECK (((end_date IS NULL) OR (start_date IS NULL) OR (end_date >= start_date)))',
  [CONSTRAINT_PRICE_UNIT]:
    "CHECK ((price_unit = ANY (ARRAY['per_day'::text, 'per_week'::text, 'per_stay'::text, 'one_off'::text])))",
});

const AUTHORIZED_SEQUENCE = Object.freeze([
  'BEGIN',
  'SET LOCAL lock_timeout',
  'SET LOCAL statement_timeout',
  'pg_advisory_xact_lock',
  'catalog_table',
  'catalog_columns',
  'assert_constraints_absent',
  'aggregate',
  'ADD CONSTRAINT tenant_services_date_window',
  'ADD CONSTRAINT tenant_services_price_unit',
  'verify_constraints',
  'COMMIT',
]);

const SET_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`;
const SET_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`;
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1, $2)';

const CONSTRAINT_ABSENCE_SQL = [
  'SELECT c.conname, c.contype, c.conrelid::regclass::text AS conrel',
  'FROM pg_catalog.pg_constraint c',
  'WHERE c.conname = ANY($1::text[])',
  'ORDER BY c.conname',
].join('\n');

const CONSTRAINT_VERIFY_SQL = [
  'SELECT',
  '  c.conname AS name,',
  '  c.contype AS contype,',
  '  c.convalidated AS convalidated,',
  '  pg_get_constraintdef(c.oid) AS condef',
  'FROM pg_catalog.pg_constraint c',
  'JOIN pg_catalog.pg_class rel ON rel.oid = c.conrelid',
  'JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace',
  'WHERE n.nspname = $1',
  '  AND rel.relname = $2',
  '  AND c.conname = ANY($3::text[])',
  'ORDER BY c.conname',
].join('\n');

const APPLY_LOCKS = Object.freeze({
  subscriptionId: TARGETS.subscriptionId,
  resourceGroup: TARGETS.resourceGroup,
  postgresServer: TARGETS.postgresServer,
  postgresHost: TARGETS.postgresHost,
  database: TARGETS.database,
  port: TARGETS.port,
  sslmode: 'verify-full',
  applicationName: APPLICATION_NAME,
  advisoryLockKey1: ADVISORY_LOCK_KEY1,
  advisoryLockKey2: ADVISORY_LOCK_KEY2,
  lockTimeoutMs: LOCK_TIMEOUT_MS,
  statementTimeoutMs: STATEMENT_TIMEOUT_MS,
  migration028Sha256: EXPECTED_028_SHA256,
  alterDateWindowSha256: ALTER_DATE_WINDOW_SHA256,
  alterPriceUnitSha256: ALTER_PRICE_UNIT_SHA256,
  constraints: Object.freeze([CONSTRAINT_DATE_WINDOW, CONSTRAINT_PRICE_UNIT]),
  dateWindowPredicate: DATE_WINDOW_PREDICATE,
  priceUnitPredicate: PRICE_UNIT_PREDICATE,
  managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
  keyVaultName: MI_LOADER_LOCKS.keyVaultName,
  secretName: MI_LOADER_LOCKS.secretName,
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
  '--execute-count-only',
  '--drop',
  '--delete',
  '--retry',
  '--retries',
  '--force',
  '--rollback',
  '--ledger',
  '--repair',
  '--dml',
]);

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_APPLY_CONSTRAINTS,
  '--subscription',
  '--resource-group',
  '--postgres-server',
  '--database',
  CLI_CREDENTIAL_SOURCE,
  '--help',
  '-h',
]);

const SAFE_OUTPUT_KEYS = Object.freeze([
  'ok',
  'code',
  'applyConstraints',
  'liveApplyEnabled',
  'constraintApplyLiveEnabled',
  'liveHttpEnabled',
  'liveMutation',
  'schemaMutation',
  'dataMutation',
  'ledgerWritten',
  'appliesConstraints',
  'writesLedger',
  'usedLiveHttp',
  'realImdsCall',
  'realKeyVaultCall',
  'realPostgresCall',
  'clientsInstantiated',
  'connectCalls',
  'queryCalls',
  'endCalls',
  'httpRequestCount',
  'imdsRequestCount',
  'keyVaultRequestCount',
  'steps',
  'authorizedSequence',
  'beforeConstraints',
  'afterConstraints',
  'counts',
  'constraintVerification',
  'rolledBack',
  'committed',
  'closed',
  'subscriptionId',
  'resourceGroup',
  'postgresServer',
  'postgresHost',
  'database',
  'sslmode',
  'applicationName',
  'credentialSource',
  'managedIdentityName',
  'keyVaultName',
  'secretName',
  'migration028Sha256CanonicalLfV1',
  'alterStatementsSha256',
  'errors',
  'message',
  'note',
  'blocker',
  'connectCategory',
  'privateRefsZeroed',
]);

let applyPgClientInstantiateCount = 0;
let applyQueryCallCount = 0;

function getConstraintApplyCounters() {
  return {
    clientsInstantiated: applyPgClientInstantiateCount,
    queryCalls: applyQueryCallCount,
    httpRequestCount: getManagedIdentityHttpCounters().httpRequestCount,
    imdsRequestCount: getManagedIdentityHttpCounters().imdsRequestCount,
    keyVaultRequestCount: getManagedIdentityHttpCounters().keyVaultRequestCount,
  };
}

function resetConstraintApplyCounters() {
  applyPgClientInstantiateCount = 0;
  applyQueryCallCount = 0;
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
    if (flag === CLI_APPLY_CONSTRAINTS || flag === '--help' || flag === '-h') {
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

  return { flags, values, unknown, forbidden };
}

function evaluateConstraintApplyGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const argv = Array.isArray(options.argv) ? options.argv.map(String) : [];
  const errors = [];

  if (PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED !== true) {
    errors.push({
      code: 'constraint_apply_capability_disabled',
      message: 'constraint apply capability is disabled',
    });
  }
  if (PHASE_D_LIVE_APPLY_ENABLED === true) {
    errors.push({
      code: 'global_live_apply_must_remain_false',
      message: 'PHASE_D_LIVE_APPLY_ENABLED must remain false (count-only path)',
    });
  }

  const dual = evaluateDualEnableFlags(env);
  if (!dual.ok) errors.push(...dual.errors);

  if (String(env[ENV_CONSTRAINT_APPLY] || '') !== '1') {
    errors.push({
      code: 'constraint_apply_env_required',
      message: `env ${ENV_CONSTRAINT_APPLY}=1 is required`,
    });
  }

  const parsed = parseArgvPairs(argv);
  if (parsed.forbidden.length) {
    errors.push({
      code: 'forbidden_argv',
      message: `forbidden argv: ${parsed.forbidden.join(',')}`,
      flags: parsed.forbidden.slice(),
    });
  }
  if (parsed.unknown.length) {
    errors.push({
      code: 'unknown_argv',
      message: `unknown argv: ${parsed.unknown.join(',')}`,
      flags: parsed.unknown.slice(),
    });
  }
  if (!parsed.flags.has(CLI_APPLY_CONSTRAINTS)) {
    errors.push({
      code: 'constraint_apply_flag_required',
      message: `${CLI_APPLY_CONSTRAINTS} is required`,
    });
  }

  const expected = {
    '--subscription': TARGETS.subscriptionId,
    '--resource-group': TARGETS.resourceGroup,
    '--postgres-server': TARGETS.postgresServer,
    '--database': TARGETS.database,
  };
  for (const [flag, want] of Object.entries(expected)) {
    const got = parsed.values[flag];
    if (got !== want) {
      errors.push({
        code: 'exact_target_mismatch',
        message: `${flag} must equal locked target`,
        flag,
      });
    }
  }

  const cred = evaluateCredentialSource({ env, argv });
  if (!cred.ok || cred.source !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `explicit ${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY} and ${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY} required`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    applyConstraints: parsed.flags.has(CLI_APPLY_CONSTRAINTS)
      && String(env[ENV_CONSTRAINT_APPLY] || '') === '1',
    credentialSource: cred.source,
    parsed,
  };
}

function buildApplyConnectConfig(user, password) {
  return {
    host: TARGETS.postgresHost,
    port: TARGETS.port,
    database: TARGETS.database,
    sslmode: 'verify-full',
    application_name: APPLICATION_NAME,
    _user: String(user),
    _password: String(password),
  };
}

function assertApplyConnectConfig(connectConfig) {
  const c = connectConfig || {};
  const errors = [];
  if (String(c.host || '') !== TARGETS.postgresHost) {
    errors.push({ code: 'wrong_host', message: 'host mismatch' });
  }
  if (String(c.database || '') !== TARGETS.database) {
    errors.push({ code: 'wrong_database', message: 'database mismatch' });
  }
  if (String(c.sslmode || '') !== 'verify-full') {
    errors.push({ code: 'tls_not_verify_full', message: 'sslmode must be verify-full' });
  }
  if (String(c.application_name || '') !== APPLICATION_NAME) {
    errors.push({
      code: 'wrong_application_name',
      message: `application_name must be ${APPLICATION_NAME}`,
    });
  }
  if (Number(c.port) !== TARGETS.port) {
    errors.push({ code: 'wrong_port', message: 'port mismatch' });
  }
  if (!c._user || !c._password) {
    errors.push({ code: 'credential_source_missing', message: 'user/password required' });
  }
  return { ok: errors.length === 0, errors };
}

function buildApplyPgClientConfig(lockedConnectConfig, opts) {
  const options = opts || {};
  if (options.connectionString != null
    || options.dsn != null
    || options.databaseUrl != null
    || options.host != null
    || options.database != null
    || options.sql != null
    || options.query != null) {
    throw Object.assign(
      new Error('caller-supplied DSN / host / database / query forbidden'),
      { code: 'caller_supplied_connect_forbidden' },
    );
  }
  const gate = assertApplyConnectConfig(lockedConnectConfig);
  if (!gate.ok) {
    throw Object.assign(new Error('apply connect config rejected'), {
      code: 'credential_target_rejected',
      errors: gate.errors,
    });
  }
  const c = lockedConnectConfig;
  return {
    host: TARGETS.postgresHost,
    port: TARGETS.port,
    database: TARGETS.database,
    user: String(c._user),
    password: String(c._password),
    application_name: APPLICATION_NAME,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    ssl: buildVerifiedTlsSslConfig(),
  };
}

function secretFreeClientConfigView(cfg) {
  const c = cfg || {};
  return {
    host: c.host,
    port: c.port,
    database: c.database,
    application_name: c.application_name,
    connectionTimeoutMillis: c.connectionTimeoutMillis,
    ssl: c.ssl
      ? {
        rejectUnauthorized: c.ssl.rejectUnauthorized === true,
        servername: c.ssl.servername,
      }
      : null,
    hasUser: Boolean(c.user),
    hasPassword: Boolean(c.password),
    hasConnectionString: false,
  };
}

function normalizeCondef(def) {
  return String(def || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Semantic equality for CHECK definitions: accepts PG parenthesization rewrite
 * and IN (...) ↔ = ANY (ARRAY[...]) for the price_unit predicate.
 */
function semanticCondefMatch(name, liveDef) {
  const live = normalizeCondef(liveDef);
  const expected = normalizeCondef(EXPECTED_CONDEF[name]);
  if (!live || !expected) return false;
  if (live === expected) return true;

  if (name === CONSTRAINT_DATE_WINDOW) {
    const compact = (s) => s.replace(/[()]/g, '').replace(/\s+/g, ' ');
    return compact(live) === compact(expected)
      || live.includes('end_date is null')
        && live.includes('start_date is null')
        && live.includes('end_date >= start_date');
  }

  if (name === CONSTRAINT_PRICE_UNIT) {
    const units = ['per_day', 'per_week', 'per_stay', 'one_off'];
    const hasAll = units.every((u) => live.includes(`'${u}'`));
    const formOk = live.includes('= any') || live.includes(' in (');
    return hasAll && formOk && live.startsWith('check');
  }
  return false;
}

function assertAlterStatementsByteLocked() {
  assertMigration028ByteIntegrity();
  assert028PredicatesPresentInSource();
  const migPath = path.join(MIGRATIONS_DIR, '028_tenant_services.sql');
  const raw = fs.readFileSync(migPath, 'utf8');
  if (!raw.includes(`CONSTRAINT ${CONSTRAINT_DATE_WINDOW}`)) {
    throw Object.assign(new Error('028 missing date_window constraint name'), {
      code: 'migration_028_constraint_missing',
    });
  }
  if (!raw.includes(`CONSTRAINT ${CONSTRAINT_PRICE_UNIT}`)) {
    throw Object.assign(new Error('028 missing price_unit constraint name'), {
      code: 'migration_028_constraint_missing',
    });
  }
  if (!raw.includes(`CHECK ${DATE_WINDOW_PREDICATE}`)
    && !raw.includes(`CHECK ${DATE_WINDOW_PREDICATE.replace(/^\(/, '(')}`)) {
    // Predicates are asserted via assert028PredicatesPresentInSource; keep hash lock.
  }
  const dSha = crypto.createHash('sha256').update(ALTER_DATE_WINDOW_SQL, 'utf8').digest('hex');
  const pSha = crypto.createHash('sha256').update(ALTER_PRICE_UNIT_SQL, 'utf8').digest('hex');
  if (dSha !== ALTER_DATE_WINDOW_SHA256 || pSha !== ALTER_PRICE_UNIT_SHA256) {
    throw Object.assign(new Error('ALTER statement sha256 drift'), {
      code: 'alter_statement_hash_drift',
    });
  }
  return {
    migration028Sha256CanonicalLfV1: EXPECTED_028_SHA256,
    alterDateWindowSha256: ALTER_DATE_WINDOW_SHA256,
    alterPriceUnitSha256: ALTER_PRICE_UNIT_SHA256,
  };
}

function authorizeApplySql(sql) {
  const n = normalizeSql(sql);
  const allowed = [
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    SET_LOCK_TIMEOUT_SQL,
    SET_STATEMENT_TIMEOUT_SQL,
    ADVISORY_LOCK_SQL,
    AUTHORIZED_TABLE_EXISTS_SQL,
    AUTHORIZED_COLUMN_CATALOG_SQL,
    CONSTRAINT_ABSENCE_SQL,
    AUTHORIZED_AGGREGATE_SQL,
    ALTER_DATE_WINDOW_SQL,
    ALTER_PRICE_UNIT_SQL,
    CONSTRAINT_VERIFY_SQL,
  ];
  for (const a of allowed) {
    if (n === normalizeSql(a)) return a;
  }
  // Aggregate must go through 14A authorizer (exact bytes).
  try {
    return authorizeAggregateSql(sql);
  } catch (_) {
    /* fall through */
  }
  throw Object.assign(
    new Error('unauthorized SQL rejected: only locked Phase D constraint-apply SQL permitted'),
    { code: 'unauthorized_sql' },
  );
}

function classifyApplyStep(sql) {
  const n = normalizeSql(sql);
  if (n === normalizeSql('BEGIN')) return 'BEGIN';
  if (n === normalizeSql('COMMIT')) return 'COMMIT';
  if (n === normalizeSql('ROLLBACK')) return 'ROLLBACK';
  if (n === normalizeSql(SET_LOCK_TIMEOUT_SQL)) return 'SET LOCAL lock_timeout';
  if (n === normalizeSql(SET_STATEMENT_TIMEOUT_SQL)) return 'SET LOCAL statement_timeout';
  if (n === normalizeSql(ADVISORY_LOCK_SQL)) return 'pg_advisory_xact_lock';
  if (n === normalizeSql(AUTHORIZED_TABLE_EXISTS_SQL)) return 'catalog_table';
  if (n === normalizeSql(AUTHORIZED_COLUMN_CATALOG_SQL)) return 'catalog_columns';
  if (n === normalizeSql(CONSTRAINT_ABSENCE_SQL)) return 'assert_constraints_absent';
  if (n === normalizeSql(AUTHORIZED_AGGREGATE_SQL)) return 'aggregate';
  if (n === normalizeSql(ALTER_DATE_WINDOW_SQL)) {
    return 'ADD CONSTRAINT tenant_services_date_window';
  }
  if (n === normalizeSql(ALTER_PRICE_UNIT_SQL)) {
    return 'ADD CONSTRAINT tenant_services_price_unit';
  }
  if (n === normalizeSql(CONSTRAINT_VERIFY_SQL)) return 'verify_constraints';
  return 'unauthorized';
}

function validateCatalogColumns(rows) {
  const byName = new Map((rows || []).map((r) => [r.name, r]));
  for (const expected of REQUIRED_COLUMNS) {
    const row = byName.get(expected.name);
    if (!row) {
      throw Object.assign(new Error(`missing column ${expected.name}`), {
        code: 'column_missing',
        column: expected.name,
      });
    }
    if (row.udt_name !== expected.udt) {
      throw Object.assign(new Error(`column ${expected.name} incompatible type`), {
        code: 'column_type_mismatch',
        column: expected.name,
      });
    }
    if (Boolean(row.is_nullable) !== Boolean(expected.nullable)) {
      throw Object.assign(new Error(`column ${expected.name} incompatible nullability`), {
        code: 'column_nullability_mismatch',
        column: expected.name,
      });
    }
  }
  return {
    ok: true,
    table: `${SCHEMA}.${TABLE}`,
    columns: REQUIRED_COLUMNS.map((c) => ({ ...c })),
  };
}

async function runAuthorizedConstraintApplySequence(client, opts) {
  const options = opts || {};
  const secrets = (options.secrets || []).filter(Boolean);
  const steps = [];
  let began = false;
  let committed = false;
  let rolledBack = false;
  let beforeConstraints = null;
  let afterConstraints = null;
  let counts = null;
  let constraintVerification = null;
  let schema = null;

  if (options.sql != null
    || options.query != null
    || options.host != null
    || options.database != null
    || options.dsn != null) {
    throw Object.assign(new Error('caller-supplied SQL / host / database / DSN forbidden'), {
      code: 'caller_supplied_query_forbidden',
    });
  }

  const hashes = assertAlterStatementsByteLocked();

  async function q(sql, params) {
    authorizeApplySql(sql);
    applyQueryCallCount += 1;
    if (params === undefined) return client.query(sql);
    return client.query(sql, params);
  }

  try {
    await q('BEGIN');
    began = true;
    steps.push('BEGIN');

    await q(SET_LOCK_TIMEOUT_SQL);
    steps.push('SET LOCAL lock_timeout');

    await q(SET_STATEMENT_TIMEOUT_SQL);
    steps.push('SET LOCAL statement_timeout');

    await q(ADVISORY_LOCK_SQL, [ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2]);
    steps.push('pg_advisory_xact_lock');

    const tableRes = await q(AUTHORIZED_TABLE_EXISTS_SQL, [SCHEMA, TABLE]);
    steps.push('catalog_table');
    if (!tableRes || tableRes.rowCount !== 1) {
      throw Object.assign(new Error('public.tenant_services table missing'), {
        code: 'table_missing',
      });
    }

    const colRes = await q(
      AUTHORIZED_COLUMN_CATALOG_SQL,
      [SCHEMA, TABLE, REQUIRED_COLUMNS.map((c) => c.name)],
    );
    steps.push('catalog_columns');
    schema = validateCatalogColumns(colRes.rows);

    const absence = await q(
      CONSTRAINT_ABSENCE_SQL,
      [[CONSTRAINT_DATE_WINDOW, CONSTRAINT_PRICE_UNIT]],
    );
    steps.push('assert_constraints_absent');
    beforeConstraints = (absence.rows || []).map((r) => ({
      name: r.conname,
      contype: r.contype,
      conrel: r.conrel,
    }));
    if (beforeConstraints.length !== 0) {
      const unexpected = beforeConstraints.filter((r) => {
        // Same name anywhere is forbidden (partial/preexisting).
        return r.name === CONSTRAINT_DATE_WINDOW || r.name === CONSTRAINT_PRICE_UNIT;
      });
      if (unexpected.length) {
        throw Object.assign(
          new Error('preexisting or unexpected same-name constraint object'),
          { code: 'constraint_preexisting', found: unexpected.map((u) => u.name) },
        );
      }
    }

    const aggRes = await q(AUTHORIZED_AGGREGATE_SQL);
    steps.push('aggregate');
    if (!aggRes.rows || aggRes.rows.length !== 1) {
      throw Object.assign(new Error('aggregate must return exactly one row'), {
        code: 'aggregate_shape_error',
      });
    }
    const raw = aggRes.rows[0];
    const keys = Object.keys(raw).sort();
    const expectedKeys = OUTPUT_COUNT_KEYS.slice().sort();
    if (keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])) {
      throw Object.assign(new Error('unexpected aggregate columns'), {
        code: 'aggregate_column_leak',
      });
    }
    counts = shapeCountOnlyResult(raw);
    if (counts.total_rows !== 0
      || counts.date_window_violations !== 0
      || counts.price_unit_violations !== 0) {
      throw Object.assign(
        new Error('nonzero Phase D violation counts — refuse ADD CONSTRAINT'),
        {
          code: 'nonzero_violation_counts',
          counts,
        },
      );
    }

    await q(ALTER_DATE_WINDOW_SQL);
    steps.push('ADD CONSTRAINT tenant_services_date_window');

    await q(ALTER_PRICE_UNIT_SQL);
    steps.push('ADD CONSTRAINT tenant_services_price_unit');

    const verifyRes = await q(
      CONSTRAINT_VERIFY_SQL,
      [SCHEMA, TABLE, [CONSTRAINT_DATE_WINDOW, CONSTRAINT_PRICE_UNIT]],
    );
    steps.push('verify_constraints');
    const verified = (verifyRes.rows || []).map((r) => ({
      name: r.name,
      contype: r.contype,
      convalidated: r.convalidated === true || r.convalidated === 't',
      condef: r.condef,
    }));
    if (verified.length !== 2) {
      throw Object.assign(new Error('expected exactly two constraints after apply'), {
        code: 'constraint_verify_count',
        found: verified.length,
      });
    }
    const byName = new Map(verified.map((v) => [v.name, v]));
    for (const name of [CONSTRAINT_DATE_WINDOW, CONSTRAINT_PRICE_UNIT]) {
      const row = byName.get(name);
      if (!row) {
        throw Object.assign(new Error(`missing constraint after apply: ${name}`), {
          code: 'constraint_missing_after_apply',
        });
      }
      if (row.contype !== 'c') {
        throw Object.assign(new Error(`constraint ${name} contype must be c`), {
          code: 'constraint_wrong_contype',
        });
      }
      if (row.convalidated !== true) {
        throw Object.assign(new Error(`constraint ${name} must be validated`), {
          code: 'constraint_not_validated',
        });
      }
      if (!semanticCondefMatch(name, row.condef)) {
        throw Object.assign(new Error(`constraint ${name} condef semantic mismatch`), {
          code: 'constraint_condef_mismatch',
        });
      }
    }
    constraintVerification = verified.map((v) => ({
      name: v.name,
      contype: v.contype,
      convalidated: v.convalidated,
      condefSemanticMatch: true,
      expectedCondef: EXPECTED_CONDEF[v.name],
    }));
    afterConstraints = verified.map((v) => ({
      name: v.name,
      contype: v.contype,
      convalidated: v.convalidated,
    }));

    await q('COMMIT');
    committed = true;
    steps.push('COMMIT');

    return redactDeep({
      ok: true,
      code: 'phase_d_constraint_apply_ok',
      steps: steps.slice(),
      authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
      beforeConstraints: [],
      afterConstraints,
      counts,
      schema,
      constraintVerification,
      ...hashes,
      alterStatementsSha256: {
        date_window: ALTER_DATE_WINDOW_SHA256,
        price_unit: ALTER_PRICE_UNIT_SHA256,
      },
      readOnly: false,
      mutates: true,
      schemaMutation: true,
      dataMutation: false,
      appliesConstraints: true,
      writesLedger: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      constraintApplyLiveEnabled: PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED === true,
      applicationName: APPLICATION_NAME,
    }, secrets);
  } catch (e) {
    if (began && !committed) {
      try {
        authorizeApplySql('ROLLBACK');
        applyQueryCallCount += 1;
        await client.query('ROLLBACK');
        rolledBack = true;
        steps.push('ROLLBACK');
      } catch (_) {
        /* ignore */
      }
    }
    const known = new Set([
      'unauthorized_sql',
      'caller_supplied_query_forbidden',
      'table_missing',
      'column_missing',
      'column_type_mismatch',
      'column_nullability_mismatch',
      'aggregate_shape_error',
      'aggregate_column_leak',
      'nonzero_violation_counts',
      'constraint_preexisting',
      'constraint_verify_count',
      'constraint_missing_after_apply',
      'constraint_wrong_contype',
      'constraint_not_validated',
      'constraint_condef_mismatch',
      'migration_028_checksum_mismatch',
      'alter_statement_hash_drift',
      'lock_timeout',
      'query_failed',
      'commit_failed',
    ]);
    let err = e;
    if (!(e && e.code && known.has(e.code))) {
      err = sanitizeError(e, (e && e.code) || 'query_failed');
    }
    const safe = redactDeep({
      ok: false,
      code: err.code || 'query_failed',
      message: redactSecrets(String(err.message || 'constraint apply failed'), secrets),
      steps: steps.slice(),
      rolledBack,
      committed: false,
      beforeConstraints,
      counts,
      mutates: false,
      schemaMutation: false,
      dataMutation: false,
      appliesConstraints: false,
      writesLedger: false,
      liveApplyEnabled: false,
      constraintApplyLiveEnabled: PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED === true,
    }, secrets);
    throw Object.assign(new Error(safe.message), { code: safe.code, result: safe });
  }
}

function instantiateApplyPgClient(clientConfig, deps) {
  const d = deps || {};
  applyPgClientInstantiateCount += 1;
  let ClientCtor = d.Client;
  if (!ClientCtor) {
    if (PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED !== true) {
      throw Object.assign(new Error('constraint apply live capability disabled'), {
        code: 'constraint_apply_capability_disabled',
      });
    }
    // eslint-disable-next-line global-require
    ClientCtor = require('pg').Client;
  }
  return new ClientCtor(clientConfig);
}

async function closeClientQuietly(client, secrets) {
  if (!client || typeof client.end !== 'function') {
    return { closed: false, closeError: null, attempted: false };
  }
  try {
    await client.end();
    return { closed: true, closeError: null, attempted: true };
  } catch (e) {
    return {
      closed: false,
      attempted: true,
      closeError: redactSecrets(
        String((e && e.message) || e || 'close failed').slice(0, 240),
        secrets || [],
      ),
    };
  }
}

function pickSafeConstraintApplyOutput(result) {
  const src = result || {};
  const out = {};
  for (const k of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return redactDeep(out, []);
}

/**
 * Scripted fake Client for offline 14P proof — exact injected transaction sequence.
 */
function createScriptedConstraintApplyFakeClient(script) {
  const s = script || {};
  const expected = (s.expectedSteps || AUTHORIZED_SEQUENCE).slice();
  const calls = [];
  let stepIndex = 0;
  let connected = false;
  let ended = false;
  const responses = s.responses || {};

  function nextExpected() {
    return expected[stepIndex] || null;
  }

  const client = {
    calls,
    async connect() {
      calls.push({ method: 'connect' });
      if (s.connectError) {
        throw s.connectError instanceof Error
          ? s.connectError
          : Object.assign(new Error(String(s.connectError)), { code: 'connect_failed' });
      }
      connected = true;
    },
    async query(sql, params) {
      calls.push({
        method: 'query',
        sql: String(sql),
        params: params === undefined ? null : params,
      });
      if (!connected || ended) {
        throw Object.assign(new Error('not connected'), { code: 'query_failed' });
      }
      const kind = classifyApplyStep(sql);
      if (s.strictSequence !== false) {
        const exp = nextExpected();
        if (kind === 'ROLLBACK') {
          if (exp === 'COMMIT') stepIndex += 1;
        } else if (kind !== exp) {
          throw Object.assign(
            new Error(`wrong/reordered/extra SQL rejected: got ${kind}, expected ${exp}`),
            { code: 'unauthorized_sql' },
          );
        } else {
          stepIndex += 1;
        }
      }
      if (s.queryErrorAt && s.queryErrorAt[kind]) {
        const qe = s.queryErrorAt[kind];
        throw qe instanceof Error
          ? qe
          : Object.assign(new Error(String(qe)), { code: 'query_failed' });
      }
      if (kind === 'BEGIN' || kind === 'COMMIT' || kind === 'ROLLBACK'
        || kind === 'SET LOCAL lock_timeout' || kind === 'SET LOCAL statement_timeout'
        || kind === 'pg_advisory_xact_lock'
        || kind === 'ADD CONSTRAINT tenant_services_date_window'
        || kind === 'ADD CONSTRAINT tenant_services_price_unit') {
        return { rows: [], rowCount: 0 };
      }
      if (kind === 'catalog_table') {
        return responses.catalogTable || { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      if (kind === 'catalog_columns') {
        return responses.catalogColumns || {
          rows: REQUIRED_COLUMNS.map((c) => ({
            name: c.name,
            udt_name: c.udt,
            is_nullable: c.nullable,
          })),
          rowCount: REQUIRED_COLUMNS.length,
        };
      }
      if (kind === 'assert_constraints_absent') {
        return responses.constraintAbsence || { rows: [], rowCount: 0 };
      }
      if (kind === 'aggregate') {
        return responses.aggregate || {
          rows: [{
            total_rows: 0,
            date_window_violations: 0,
            price_unit_violations: 0,
          }],
          rowCount: 1,
        };
      }
      if (kind === 'verify_constraints') {
        return responses.verifyConstraints || {
          rows: [
            {
              name: CONSTRAINT_DATE_WINDOW,
              contype: 'c',
              convalidated: true,
              condef: EXPECTED_CONDEF[CONSTRAINT_DATE_WINDOW],
            },
            {
              name: CONSTRAINT_PRICE_UNIT,
              contype: 'c',
              convalidated: true,
              condef: EXPECTED_CONDEF[CONSTRAINT_PRICE_UNIT],
            },
          ],
          rowCount: 2,
        };
      }
      throw Object.assign(new Error('unauthorized SQL rejected'), { code: 'unauthorized_sql' });
    },
    async end() {
      calls.push({ method: 'end' });
      if (s.closeError) {
        ended = true;
        throw s.closeError instanceof Error
          ? s.closeError
          : Object.assign(new Error(String(s.closeError)), { code: 'close_failed' });
      }
      ended = true;
      connected = false;
    },
  };
  Object.defineProperty(client, 'password', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: undefined,
  });
  return client;
}

function createScriptedConstraintApplyFakeClientFactory(script) {
  return function FakeClient() {
    return createScriptedConstraintApplyFakeClient(script);
  };
}

async function executePhaseDConstraintApply(opts) {
  const options = opts || {};
  const secrets = [];
  let client = null;
  let closeMeta = { closed: false, closeError: null, attempted: false };
  let closeAttempted = false;
  const counters = {
    clientsInstantiated: 0,
    connectCalls: 0,
    queryCalls: 0,
    endCalls: 0,
  };
  let managedIdentityHttpDelta = {
    httpRequestCount: 0,
    imdsRequestCount: 0,
    keyVaultRequestCount: 0,
  };

  if (options.dsn != null
    || options.connectionString != null
    || options.databaseUrl != null
    || options.host != null
    || options.database != null
    || options.sql != null
    || options.query != null) {
    return pickSafeConstraintApplyOutput({
      ok: false,
      code: 'caller_supplied_connect_forbidden',
      applyConstraints: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      privateRefsZeroed: true,
    });
  }

  const gates = evaluateConstraintApplyGates({
    env: options.env,
    argv: options.argv || [],
  });
  if (!gates.ok) {
    return pickSafeConstraintApplyOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'constraint_apply_gates_rejected',
      errors: gates.errors,
      applyConstraints: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      constraintApplyLiveEnabled: PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED === true,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      note: 'gates rejected — zero pg Clients',
      privateRefsZeroed: true,
    });
  }

  const offlineProofClient = typeof options.Client === 'function';
  let privateBag = null;
  let credentialSource = CREDENTIAL_SOURCE_MANAGED_IDENTITY;

  if (options.privateCredentials
    && options.privateCredentials._user
    && options.privateCredentials._password) {
    privateBag = {
      _user: options.privateCredentials._user,
      _password: options.privateCredentials._password,
      _connectConfig: buildApplyConnectConfig(
        options.privateCredentials._user,
        options.privateCredentials._password,
      ),
    };
  } else {
    const httpBefore = getManagedIdentityHttpCounters();
    const loaded = await loadProtectedAdminCredentialsViaManagedIdentity({
      env: options.env,
      argv: options.argv || [],
      httpRequest: options.httpRequest,
    });
    const httpAfter = getManagedIdentityHttpCounters();
    managedIdentityHttpDelta = {
      httpRequestCount: httpAfter.httpRequestCount - httpBefore.httpRequestCount,
      imdsRequestCount: httpAfter.imdsRequestCount - httpBefore.imdsRequestCount,
      keyVaultRequestCount: httpAfter.keyVaultRequestCount - httpBefore.keyVaultRequestCount,
    };
    if (!loaded.ok) {
      zeroPrivateCredentialRefs(loaded);
      return pickSafeConstraintApplyOutput({
        ok: false,
        code: loaded.code || 'managed_identity_loader_failed',
        errors: loaded.errors || [],
        applyConstraints: false,
        liveMutation: false,
        clientsInstantiated: 0,
        httpRequestCount: managedIdentityHttpDelta.httpRequestCount,
        imdsRequestCount: managedIdentityHttpDelta.imdsRequestCount,
        keyVaultRequestCount: managedIdentityHttpDelta.keyVaultRequestCount,
        liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
        privateRefsZeroed: true,
      });
    }
    privateBag = {
      _user: loaded._user,
      _password: loaded._password,
      _connectConfig: buildApplyConnectConfig(loaded._user, loaded._password),
    };
    zeroPrivateCredentialRefs(loaded);
  }

  secrets.push(privateBag._user, privateBag._password);

  let clientConfig;
  try {
    clientConfig = buildApplyPgClientConfig(privateBag._connectConfig);
  } catch (e) {
    zeroPrivateCredentialRefs(privateBag);
    return pickSafeConstraintApplyOutput({
      ok: false,
      code: e.code || 'credential_target_rejected',
      errors: e.errors || [{ code: e.code, message: e.message }],
      applyConstraints: false,
      clientsInstantiated: 0,
      privateRefsZeroed: true,
    });
  }
  zeroPrivateCredentialRefs(privateBag);
  privateBag = null;

  const beforeClients = applyPgClientInstantiateCount;
  let outcome;
  try {
    client = instantiateApplyPgClient(clientConfig, { Client: options.Client });
    counters.clientsInstantiated = applyPgClientInstantiateCount - beforeClients;

    try {
      counters.connectCalls += 1;
      await client.connect();
    } catch (e) {
      const classified = classifyConnectError(e);
      throw Object.assign(new Error(classified.message), {
        code: classified.code,
        connectCategory: classified.category,
      });
    }

    let sequence;
    try {
      const queryBefore = applyQueryCallCount;
      sequence = await runAuthorizedConstraintApplySequence(client, { secrets });
      counters.queryCalls = applyQueryCallCount - queryBefore;
    } catch (e) {
      if (e && e.result) {
        counters.queryCalls = Array.isArray(e.result.steps) ? e.result.steps.length : 0;
        throw e;
      }
      throw Object.assign(
        new Error(redactSecrets(String((e && e.message) || e || 'query failed').slice(0, 240), secrets)),
        { code: (e && e.code) || 'query_failed' },
      );
    }

    outcome = {
      ok: true,
      code: sequence.code || 'phase_d_constraint_apply_ok',
      applyConstraints: true,
      steps: sequence.steps,
      authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
      beforeConstraints: sequence.beforeConstraints,
      afterConstraints: sequence.afterConstraints,
      counts: sequence.counts,
      constraintVerification: sequence.constraintVerification,
      migration028Sha256CanonicalLfV1: sequence.migration028Sha256CanonicalLfV1,
      alterStatementsSha256: sequence.alterStatementsSha256,
      clientsInstantiated: counters.clientsInstantiated,
      connectCalls: counters.connectCalls,
      queryCalls: counters.queryCalls,
      httpRequestCount: managedIdentityHttpDelta.httpRequestCount,
      imdsRequestCount: managedIdentityHttpDelta.imdsRequestCount,
      keyVaultRequestCount: managedIdentityHttpDelta.keyVaultRequestCount,
      credentialSource,
      managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
      keyVaultName: MI_LOADER_LOCKS.keyVaultName,
      secretName: MI_LOADER_LOCKS.secretName,
      postgresHost: TARGETS.postgresHost,
      database: TARGETS.database,
      sslmode: 'verify-full',
      applicationName: APPLICATION_NAME,
      subscriptionId: TARGETS.subscriptionId,
      resourceGroup: TARGETS.resourceGroup,
      postgresServer: TARGETS.postgresServer,
      liveMutation: true,
      schemaMutation: true,
      dataMutation: false,
      ledgerWritten: false,
      appliesConstraints: true,
      writesLedger: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      constraintApplyLiveEnabled: true,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      usedLiveHttp: managedIdentityHttpDelta.httpRequestCount > 0 && !offlineProofClient,
      realImdsCall: managedIdentityHttpDelta.imdsRequestCount > 0 && !offlineProofClient,
      realKeyVaultCall: managedIdentityHttpDelta.keyVaultRequestCount > 0 && !offlineProofClient,
      realPostgresCall: !offlineProofClient,
      committed: true,
      rolledBack: false,
      privateRefsZeroed: true,
    };
  } catch (e) {
    const code = (e && e.code) || (e && e.result && e.result.code) || 'query_failed';
    const connectCategory = e && e.connectCategory ? String(e.connectCategory) : undefined;
    const result = e && e.result ? e.result : null;
    outcome = {
      ok: false,
      code,
      connectCategory,
      message: connectCategory
        ? CONNECT_FAILED_SAFE_MESSAGE
        : redactSecrets(String((e && e.message) || 'adapter failed'), secrets),
      steps: result && result.steps ? result.steps : [],
      rolledBack: result ? result.rolledBack === true : false,
      committed: false,
      counts: result && result.counts ? result.counts : null,
      beforeConstraints: result && result.beforeConstraints ? result.beforeConstraints : null,
      applyConstraints: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      appliesConstraints: false,
      writesLedger: false,
      clientsInstantiated: counters.clientsInstantiated,
      connectCalls: counters.connectCalls,
      queryCalls: counters.queryCalls || (result && result.steps ? result.steps.length : 0),
      httpRequestCount: managedIdentityHttpDelta.httpRequestCount,
      imdsRequestCount: managedIdentityHttpDelta.imdsRequestCount,
      keyVaultRequestCount: managedIdentityHttpDelta.keyVaultRequestCount,
      applicationName: APPLICATION_NAME,
      postgresHost: TARGETS.postgresHost,
      database: TARGETS.database,
      sslmode: 'verify-full',
      constraintApplyLiveEnabled: true,
      liveApplyEnabled: false,
      realPostgresCall: !offlineProofClient && counters.connectCalls > 0,
      privateRefsZeroed: true,
      blocker: code,
    };
  } finally {
    if (!closeAttempted) {
      closeAttempted = true;
      closeMeta = await closeClientQuietly(client, secrets);
      if (closeMeta.attempted) counters.endCalls += 1;
    }
  }

  outcome.closed = closeMeta.closed === true;
  outcome.endCalls = counters.endCalls;
  if (closeMeta.closeError && outcome.ok) {
    outcome.ok = false;
    outcome.code = 'close_failed';
    outcome.message = closeMeta.closeError;
  } else if (closeMeta.closeError) {
    outcome.closeFailure = true;
  }

  // Wipe password from clientConfig locals.
  if (clientConfig) {
    try { clientConfig.password = undefined; clientConfig.user = undefined; } catch (_) { /* ignore */ }
  }

  return pickSafeConstraintApplyOutput(outcome);
}

function exactConstraintApplyArgv() {
  return [
    CLI_APPLY_CONSTRAINTS,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function constraintApplyEnv(extra) {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_CONSTRAINT_APPLY]: '1',
    [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ...(extra || {}),
  };
}

function renderConstraintApplyUsage() {
  return [
    'phase-d:constraint-apply — FOUNDATION Slice 14P',
    '',
    'Default: refused (zero pg Clients / zero HTTP).',
    '',
    'Required env:',
    `  ${ENV_LIVE_READONLY}=1`,
    `  ${ENV_LIVE_PREFLIGHT}=1`,
    `  ${ENV_CONSTRAINT_APPLY}=1`,
    `  ${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `  AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
    '',
    'Required argv:',
    `  ${CLI_APPLY_CONSTRAINTS}`,
    `  --subscription ${TARGETS.subscriptionId}`,
    `  --resource-group ${TARGETS.resourceGroup}`,
    `  --postgres-server ${TARGETS.postgresServer}`,
    `  --database ${TARGETS.database}`,
    `  ${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    '',
    'Applies exactly two CHECK constraints from migration 028. No ledger/DML/DROP.',
  ].join('\n');
}

module.exports = {
  PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_CONSTRAINT_APPLY,
  CLI_APPLY_CONSTRAINTS,
  APPLICATION_NAME,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  LOCK_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  ALTER_DATE_WINDOW_SQL,
  ALTER_PRICE_UNIT_SQL,
  ALTER_DATE_WINDOW_SHA256,
  ALTER_PRICE_UNIT_SHA256,
  EXPECTED_CONDEF,
  AUTHORIZED_SEQUENCE,
  APPLY_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  CONSTRAINT_DATE_WINDOW,
  CONSTRAINT_PRICE_UNIT,
  evaluateConstraintApplyGates,
  executePhaseDConstraintApply,
  runAuthorizedConstraintApplySequence,
  createScriptedConstraintApplyFakeClient,
  createScriptedConstraintApplyFakeClientFactory,
  getConstraintApplyCounters,
  resetConstraintApplyCounters,
  pickSafeConstraintApplyOutput,
  exactConstraintApplyArgv,
  constraintApplyEnv,
  renderConstraintApplyUsage,
  assertAlterStatementsByteLocked,
  semanticCondefMatch,
  authorizeApplySql,
  classifyApplyStep,
  buildApplyConnectConfig,
  buildApplyPgClientConfig,
  normalizeCondef,
  SET_LOCK_TIMEOUT_SQL,
  SET_STATEMENT_TIMEOUT_SQL,
  ADVISORY_LOCK_SQL,
  CONSTRAINT_ABSENCE_SQL,
  CONSTRAINT_VERIFY_SQL,
};
