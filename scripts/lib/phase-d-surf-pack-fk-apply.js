'use strict';

/**
 * phase-d-surf-pack-fk-apply — FOUNDATION Slice 14Z
 *
 * Default-disabled exact-gated managed-identity live adapter that applies
 * exactly ONE missing canonical FK on Sunset staging `sunset_staging`:
 *   tenant_surf_pack_rules_updated_by_fkey
 *
 * No other objects. No DML/DROP/extra ALTER/index/trigger/function/
 * extension/ownership/ACL/ledger/KV/RBAC/network/deploy. No migration file
 * changes. On any error ROLLBACK, no retry.
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
  AUTHORIZED_TABLE_EXISTS_SQL,
  AUTHORIZED_COLUMN_CATALOG_SQL,
} = require('./phase-d-live-readonly-boundary');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
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
const { MIGRATIONS_DIR, sha256CanonicalLfV1File } = require('./migration-integrity');

/** Capability flag for Slice 14Z — still default-disabled via env+argv gates. */
const PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED = true;

const ENV_SURF_PACK_FK_APPLY = 'SUNSET_PHASE_D_SURF_PACK_FK_APPLY';
const CLI_APPLY_SURF_PACK_FK = '--apply-surf-pack-fk';

const APPLICATION_NAME = 'wh-sunset-surf-pack-fk-apply';

/** Fixed transaction-scoped advisory lock (WHPZ / SPFK — distinct from 14Y). */
const ADVISORY_LOCK_KEY1 = 0x5748505A; // WHPZ
const ADVISORY_LOCK_KEY2 = 0x5350464B; // SPFK

const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 30000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60000;
const CONNECTION_TIMEOUT_MS = 20000;

const SCHEMA = 'public';

/** Post-14Y residual baseline (exactly 6 mismatches; 1 is this FK). */
const BASELINE_MISMATCH_COUNT = 6;
const BASELINE_MISMATCH_SECTIONS = Object.freeze({
  constraints: 1,
  triggers: 1,
  functions: 1,
  ownership: 1,
  acls: 1,
  extensions: 1,
});
const EXPECTED_REDUCTION = 1;
const EXPECTED_REMAINING_MISMATCH_COUNT = 5;
const EXPECTED_REMAINING_KEYS = Object.freeze([
  'function:public.fips_mode()',
  'function:public.fips_mode()',
  'pgcrypto',
  'public.fips_mode()',
  'tenant_surf_pack_rules.tenant_surf_pack_rules_updated_at',
]);

const TABLE = 'tenant_surf_pack_rules';
const REF_TABLE = 'staff_users';
const CONSTRAINT_NAME = 'tenant_surf_pack_rules_updated_by_fkey';
const SRC_COLUMN = 'updated_by';
const REF_COLUMN = 'id';
const OBSERVER_KEY = 'tenant_surf_pack_rules.tenant_surf_pack_rules_updated_by_fkey.FOREIGN KEY';

const OWNER_MIGRATION = '026_tenant_surf_pack_rules';
const OWNER_MIGRATION_SHA256 = '8923551f385bda87e649b567fd47153ed94014029ac5138176beff7e58512496';
const APPROVED_ROW_COUNT = 36;

const EXPECTED_CONDEF = 'FOREIGN KEY (updated_by) REFERENCES staff_users(id) ON DELETE SET NULL';

const ADD_FK_DIRECT_SQL = [
  'ALTER TABLE public.tenant_surf_pack_rules',
  '  ADD CONSTRAINT tenant_surf_pack_rules_updated_by_fkey',
  '  FOREIGN KEY (updated_by) REFERENCES staff_users(id) ON DELETE SET NULL',
].join('\n');

const ADD_FK_NOT_VALID_SQL = [
  'ALTER TABLE public.tenant_surf_pack_rules',
  '  ADD CONSTRAINT tenant_surf_pack_rules_updated_by_fkey',
  '  FOREIGN KEY (updated_by) REFERENCES staff_users(id) ON DELETE SET NULL NOT VALID',
].join('\n');

const VALIDATE_FK_SQL = 'ALTER TABLE public.tenant_surf_pack_rules VALIDATE CONSTRAINT tenant_surf_pack_rules_updated_by_fkey';

const ADD_FK_DIRECT_SHA256 = crypto.createHash('sha256').update(ADD_FK_DIRECT_SQL, 'utf8').digest('hex');
const ADD_FK_NOT_VALID_SHA256 = crypto.createHash('sha256').update(ADD_FK_NOT_VALID_SQL, 'utf8').digest('hex');
const VALIDATE_FK_SHA256 = crypto.createHash('sha256').update(VALIDATE_FK_SQL, 'utf8').digest('hex');

const FK_SPEC = Object.freeze({
  constraintName: CONSTRAINT_NAME,
  table: TABLE,
  refTable: REF_TABLE,
  srcColumn: SRC_COLUMN,
  refColumn: REF_COLUMN,
  ownerMigration: OWNER_MIGRATION,
  ownerMigrationSha256: OWNER_MIGRATION_SHA256,
  key: OBSERVER_KEY,
  approvedRowCount: APPROVED_ROW_COUNT,
  expectedCondef: EXPECTED_CONDEF,
  addDirectSql: ADD_FK_DIRECT_SQL,
  addNotValidSql: ADD_FK_NOT_VALID_SQL,
  validateSql: VALIDATE_FK_SQL,
  addDirectSqlSha256: ADD_FK_DIRECT_SHA256,
  addNotValidSqlSha256: ADD_FK_NOT_VALID_SHA256,
  validateSqlSha256: VALIDATE_FK_SHA256,
});

const ROW_COUNT_SQL = 'SELECT count(*)::bigint AS table_total FROM public.tenant_surf_pack_rules';

const ORPHAN_SQL = [
  'SELECT count(*)::bigint AS orphan_count FROM public.tenant_surf_pack_rules c',
  'LEFT JOIN public.staff_users p ON c.updated_by = p.id',
  'WHERE c.updated_by IS NOT NULL AND p.id IS NULL',
].join('\n');

const ORPHAN_SQL_SHA256 = crypto.createHash('sha256').update(ORPHAN_SQL, 'utf8').digest('hex');

const TYPE_COMPAT_SQL = [
  'SELECT',
  '  (SELECT t.typname FROM pg_attribute a',
  '   JOIN pg_class c ON c.oid = a.attrelid',
  '   JOIN pg_namespace n ON n.oid = c.relnamespace',
  '   JOIN pg_type t ON t.oid = a.atttypid',
  "   WHERE n.nspname = 'public' AND c.relname = 'tenant_surf_pack_rules'",
  "     AND a.attname = 'updated_by' AND a.attnum > 0 AND NOT a.attisdropped) AS src_udt,",
  '  (SELECT t.typname FROM pg_attribute a',
  '   JOIN pg_class c ON c.oid = a.attrelid',
  '   JOIN pg_namespace n ON n.oid = c.relnamespace',
  '   JOIN pg_type t ON t.oid = a.atttypid',
  "   WHERE n.nspname = 'public' AND c.relname = 'staff_users'",
  "     AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped) AS ref_udt",
].join('\n');

const AUTHORIZED_SEQUENCE = Object.freeze([
  'BEGIN',
  'SET LOCAL lock_timeout',
  'SET LOCAL statement_timeout',
  'SET LOCAL idle_in_transaction_session_timeout',
  'pg_advisory_xact_lock',
  'catalog_table_tenant_surf_pack_rules',
  'catalog_columns_tenant_surf_pack_rules',
  'catalog_table_staff_users',
  'catalog_columns_staff_users',
  'assert_compatible_types',
  'row_count_before_tenant_surf_pack_rules',
  'assert_fk_absent',
  'assert_no_semantic_duplicate_fk',
  'assert_no_incompatible_same_name',
  'assert_orphan_count_zero',
  'ADD CONSTRAINT NOT VALID',
  'verify_constraint_after_not_valid',
  'VALIDATE CONSTRAINT',
  'verify_constraint_final',
  'row_count_after_tenant_surf_pack_rules',
  'COMMIT',
]);

const SUCCESS_PATH_QUERY_COUNT = AUTHORIZED_SEQUENCE.length;

const SET_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`;
const SET_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`;
const SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL = `SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT_MS}ms'`;
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1, $2)';

const CONSTRAINT_VERIFY_SQL = [
  'SELECT',
  '  c.conname AS name,',
  '  c.contype AS contype,',
  '  c.convalidated AS convalidated,',
  '  pg_get_constraintdef(c.oid) AS condef',
  'FROM pg_catalog.pg_constraint c',
  'JOIN pg_catalog.pg_class rel ON rel.oid = c.conrelid',
  'JOIN pg_namespace n ON n.oid = rel.relnamespace',
  'WHERE n.nspname = $1',
  '  AND rel.relname = $2',
  '  AND c.conname = ANY($3::text[])',
  'ORDER BY c.conname',
].join('\n');

const TABLE_FOREIGN_KEYS_SQL = [
  'SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS condef',
  'FROM pg_catalog.pg_constraint c',
  'JOIN pg_catalog.pg_class rel ON rel.oid = c.conrelid',
  'JOIN pg_namespace n ON n.oid = rel.relnamespace',
  'WHERE n.nspname = $1 AND rel.relname = $2 AND c.contype = \'f\'',
  'ORDER BY c.conname',
].join('\n');

const CONSTRAINT_NAME_LOOKUP_SQL = [
  'SELECT c.conname AS name, c.contype AS contype, c.conrelid::regclass::text AS conrel',
  'FROM pg_catalog.pg_constraint c',
  'JOIN pg_namespace n ON n.oid = c.connamespace',
  'WHERE c.conname = $1',
  'ORDER BY c.conname',
].join('\n');

const EXPECTED_SCHEMA_PATH = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'sunset-schema-observer',
  'expected-product-schema.json',
);

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
  idleInTransactionTimeoutMs: IDLE_IN_TRANSACTION_TIMEOUT_MS,
  constraintName: CONSTRAINT_NAME,
  observerKey: OBSERVER_KEY,
  alterSqlSha256: Object.freeze({
    addDirect: ADD_FK_DIRECT_SHA256,
    addNotValid: ADD_FK_NOT_VALID_SHA256,
    validate: VALIDATE_FK_SHA256,
    orphan: ORPHAN_SQL_SHA256,
  }),
  baselineMismatchCount: BASELINE_MISMATCH_COUNT,
  expectedReduction: EXPECTED_REDUCTION,
  expectedRemainingMismatchCount: EXPECTED_REMAINING_MISMATCH_COUNT,
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
  '--concurrently',
  '--alter',
  '--truncate',
]);

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_APPLY_SURF_PACK_FK,
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
  'applySurfPackFk',
  'liveApplyEnabled',
  'surfPackFkApplyLiveEnabled',
  'liveHttpEnabled',
  'liveMutation',
  'schemaMutation',
  'dataMutation',
  'ledgerWritten',
  'appliesFk',
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
  'beforeConstraint',
  'afterConstraint',
  'constraintVerification',
  'rowCountsBefore',
  'rowCountsAfter',
  'capturedRowCount',
  'alterStatementsSha256',
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
  'errors',
  'message',
  'note',
  'blocker',
  'connectCategory',
  'privateRefsZeroed',
  'baselineMismatchCount',
  'expectedRemainingMismatchCount',
  'expectedRemainingKeys',
  'orphanCount',
]);

let applyPgClientInstantiateCount = 0;
let applyQueryCallCount = 0;

function getSurfPackFkApplyCounters() {
  return {
    clientsInstantiated: applyPgClientInstantiateCount,
    queryCalls: applyQueryCallCount,
    httpRequestCount: getManagedIdentityHttpCounters().httpRequestCount,
    imdsRequestCount: getManagedIdentityHttpCounters().imdsRequestCount,
    keyVaultRequestCount: getManagedIdentityHttpCounters().keyVaultRequestCount,
  };
}

function resetSurfPackFkApplyCounters() {
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
    if (flag === CLI_APPLY_SURF_PACK_FK || flag === '--help' || flag === '-h') {
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

function evaluateSurfPackFkApplyGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const argv = Array.isArray(options.argv) ? options.argv.map(String) : [];
  const errors = [];

  if (PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED !== true) {
    errors.push({
      code: 'surf_pack_fk_apply_capability_disabled',
      message: 'surf pack fk apply capability is disabled',
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

  if (String(env[ENV_SURF_PACK_FK_APPLY] || '') !== '1') {
    errors.push({
      code: 'surf_pack_fk_apply_env_required',
      message: `env ${ENV_SURF_PACK_FK_APPLY}=1 is required`,
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
  if (!parsed.flags.has(CLI_APPLY_SURF_PACK_FK)) {
    errors.push({
      code: 'surf_pack_fk_apply_flag_required',
      message: `${CLI_APPLY_SURF_PACK_FK} is required`,
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
    applySurfPackFk: parsed.flags.has(CLI_APPLY_SURF_PACK_FK)
      && String(env[ENV_SURF_PACK_FK_APPLY] || '') === '1',
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

function normalizeCondef(def) {
  return String(def || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Strip optional trailing NOT VALID (pg_get_constraintdef after ADD ... NOT VALID). */
function normalizeCondefBody(def) {
  return normalizeCondef(def).replace(/\s+not\s+valid\s*$/i, '').trim();
}

function condefMatchesExpected(liveDef) {
  return normalizeCondef(liveDef) === normalizeCondef(EXPECTED_CONDEF);
}

/** Mid-state after NOT VALID: body must match canonical; trailing NOT VALID allowed. */
function condefMatchesExpectedAllowingNotValidSuffix(liveDef) {
  return normalizeCondefBody(liveDef) === normalizeCondef(EXPECTED_CONDEF);
}

function semanticFkDuplicateMatch(condef) {
  const n = normalizeCondef(condef);
  if (!n) return false;
  return n.includes('(updated_by)')
    && n.includes('references staff_users')
    && n.includes('(id)')
    && n.includes('on delete set null');
}

function assertBaselineMismatch(summary) {
  const s = summary || {};
  const mismatchCount = Number(s.mismatchCount);
  const sections = s.mismatchSections || s.sections || {};
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
  throw Object.assign(
    new Error(
      `expected mismatchCount=${BASELINE_MISMATCH_COUNT} with sections `
      + `${JSON.stringify(expectedSections)}; got mismatchCount=${mismatchCount} `
      + `sections=${JSON.stringify(sections)}`,
    ),
    {
      code: 'baseline_drift_mismatch',
      mismatchCount: Number.isFinite(mismatchCount) ? mismatchCount : null,
      mismatchSections: { ...sections },
      expectedMismatchCount: BASELINE_MISMATCH_COUNT,
      expectedMismatchSections: { ...expectedSections },
    },
  );
}

function assertFkAlterStatementsByteLocked() {
  const alterStatementsSha256 = {
    addDirect: ADD_FK_DIRECT_SHA256,
    addNotValid: ADD_FK_NOT_VALID_SHA256,
    validate: VALIDATE_FK_SHA256,
    orphan: ORPHAN_SQL_SHA256,
  };

  for (const [label, sql, want] of [
    ['addDirect', ADD_FK_DIRECT_SQL, ADD_FK_DIRECT_SHA256],
    ['addNotValid', ADD_FK_NOT_VALID_SQL, ADD_FK_NOT_VALID_SHA256],
    ['validate', VALIDATE_FK_SQL, VALIDATE_FK_SHA256],
    ['orphan', ORPHAN_SQL, ORPHAN_SQL_SHA256],
  ]) {
    const recomputed = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
    if (recomputed !== want) {
      throw Object.assign(new Error(`ALTER sha256 drift for ${label}`), {
        code: 'alter_statement_hash_drift',
        label,
      });
    }
  }

  const migPath = path.join(MIGRATIONS_DIR, `${OWNER_MIGRATION}.sql`);
  const migSha = sha256CanonicalLfV1File(migPath);
  if (migSha !== OWNER_MIGRATION_SHA256) {
    throw Object.assign(
      new Error(`owner migration sha256 drift for ${OWNER_MIGRATION}`),
      {
        code: 'owner_migration_checksum_mismatch',
        ownerMigration: OWNER_MIGRATION,
      },
    );
  }

  const expectedRaw = fs.readFileSync(EXPECTED_SCHEMA_PATH, 'utf8');
  if (!expectedRaw.includes(EXPECTED_CONDEF)) {
    throw Object.assign(
      new Error('expected-product-schema missing exact FK definition'),
      { code: 'expected_schema_fkdef_missing' },
    );
  }

  return {
    alterStatementsSha256,
    ownerMigrationSha256: { [OWNER_MIGRATION]: OWNER_MIGRATION_SHA256 },
  };
}

function authorizeApplySql(sql) {
  const n = normalizeSql(sql);
  const upper = n.toUpperCase();
  if (/\bCONCURRENTLY\b/.test(upper)
    || /\bDROP\b/.test(upper)
    || /(^|\s)DELETE\s+FROM\b/.test(upper)
    || /(^|\s)UPDATE\s+\S/.test(upper)
    || /(^|\s)INSERT\s+INTO\b/.test(upper)
    || /\bTRUNCATE\b/.test(upper)
    || /\bCREATE\s+TABLE\b/.test(upper)
    || /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/.test(upper)
    || /\bCREATE\s+TRIGGER\b/.test(upper)
    || /\bCREATE\s+EXTENSION\b/.test(upper)
    || /\bCREATE\s+INDEX\b/.test(upper)) {
    throw Object.assign(
      new Error('unauthorized SQL rejected: DROP/DML/CREATE INDEX/extra DDL forbidden'),
      { code: 'unauthorized_sql' },
    );
  }

  const allowed = [
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    SET_LOCK_TIMEOUT_SQL,
    SET_STATEMENT_TIMEOUT_SQL,
    SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL,
    ADVISORY_LOCK_SQL,
    AUTHORIZED_TABLE_EXISTS_SQL,
    AUTHORIZED_COLUMN_CATALOG_SQL,
    CONSTRAINT_VERIFY_SQL,
    TABLE_FOREIGN_KEYS_SQL,
    CONSTRAINT_NAME_LOOKUP_SQL,
    ROW_COUNT_SQL,
    ORPHAN_SQL,
    TYPE_COMPAT_SQL,
    ADD_FK_NOT_VALID_SQL,
    ADD_FK_DIRECT_SQL,
    VALIDATE_FK_SQL,
  ];
  for (const a of allowed) {
    if (n === normalizeSql(a)) return a;
  }
  throw Object.assign(
    new Error('unauthorized SQL rejected: only locked Phase D surf-pack-fk-apply SQL permitted'),
    { code: 'unauthorized_sql' },
  );
}

function classifyCatalogTableStep(params) {
  const table = params && params[1];
  if (table === TABLE) return 'catalog_table_tenant_surf_pack_rules';
  if (table === REF_TABLE) return 'catalog_table_staff_users';
  return 'unauthorized';
}

function classifyCatalogColumnsStep(params) {
  const table = params && params[1];
  if (table === TABLE) return 'catalog_columns_tenant_surf_pack_rules';
  if (table === REF_TABLE) return 'catalog_columns_staff_users';
  return 'unauthorized';
}

function classifyConstraintVerifyStep(params, priorSteps) {
  const names = (params && params[2]) || [];
  const list = Array.isArray(names) ? names : [];
  if (list.length === 1 && list[0] === CONSTRAINT_NAME) {
    if ((priorSteps || []).includes('VALIDATE CONSTRAINT')) {
      return 'verify_constraint_final';
    }
    if ((priorSteps || []).includes('ADD CONSTRAINT NOT VALID')) {
      return 'verify_constraint_after_not_valid';
    }
    return 'assert_fk_absent';
  }
  return 'unauthorized';
}

function classifyApplyStep(sql, params, priorSteps) {
  const n = normalizeSql(sql);
  if (n === normalizeSql('BEGIN')) return 'BEGIN';
  if (n === normalizeSql('COMMIT')) return 'COMMIT';
  if (n === normalizeSql('ROLLBACK')) return 'ROLLBACK';
  if (n === normalizeSql(SET_LOCK_TIMEOUT_SQL)) return 'SET LOCAL lock_timeout';
  if (n === normalizeSql(SET_STATEMENT_TIMEOUT_SQL)) return 'SET LOCAL statement_timeout';
  if (n === normalizeSql(SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL)) {
    return 'SET LOCAL idle_in_transaction_session_timeout';
  }
  if (n === normalizeSql(ADVISORY_LOCK_SQL)) return 'pg_advisory_xact_lock';
  if (n === normalizeSql(ADD_FK_NOT_VALID_SQL)) return 'ADD CONSTRAINT NOT VALID';
  if (n === normalizeSql(ADD_FK_DIRECT_SQL)) return 'ADD CONSTRAINT direct';
  if (n === normalizeSql(VALIDATE_FK_SQL)) return 'VALIDATE CONSTRAINT';
  if (n === normalizeSql(ROW_COUNT_SQL)) {
    return (priorSteps || []).some((s) => s === 'ADD CONSTRAINT NOT VALID'
      || s === 'VALIDATE CONSTRAINT'
      || s === 'verify_constraint_final')
      ? 'row_count_after_tenant_surf_pack_rules'
      : 'row_count_before_tenant_surf_pack_rules';
  }
  if (n === normalizeSql(ORPHAN_SQL)) return 'assert_orphan_count_zero';
  if (n === normalizeSql(TYPE_COMPAT_SQL)) return 'assert_compatible_types';
  if (n === normalizeSql(AUTHORIZED_TABLE_EXISTS_SQL)) {
    return classifyCatalogTableStep(params);
  }
  if (n === normalizeSql(AUTHORIZED_COLUMN_CATALOG_SQL)) {
    return classifyCatalogColumnsStep(params);
  }
  if (n === normalizeSql(CONSTRAINT_VERIFY_SQL)) {
    return classifyConstraintVerifyStep(params, priorSteps);
  }
  if (n === normalizeSql(TABLE_FOREIGN_KEYS_SQL)) {
    return 'assert_no_semantic_duplicate_fk';
  }
  if (n === normalizeSql(CONSTRAINT_NAME_LOOKUP_SQL)) {
    return 'assert_no_incompatible_same_name';
  }
  return 'unauthorized';
}

function validateColumnType(table, column, rows, expectedUdt) {
  const row = (rows || []).find((r) => r.name === column);
  if (!row) {
    throw Object.assign(new Error(`missing column ${table}.${column}`), {
      code: 'column_missing',
      table,
      column,
    });
  }
  if (row.udt_name !== expectedUdt) {
    throw Object.assign(new Error(`column ${table}.${column} type mismatch`), {
      code: 'type_mismatch',
      table,
      column,
      got: row.udt_name,
      expected: expectedUdt,
    });
  }
  return row;
}

function readRowCount(res) {
  if (!res || !res.rows || res.rows.length !== 1) {
    throw Object.assign(new Error('row count must return exactly one row'), {
      code: 'row_count_shape_error',
    });
  }
  return Number(res.rows[0].table_total);
}

function readOrphanCount(res) {
  if (!res || !res.rows || res.rows.length !== 1) {
    throw Object.assign(new Error('orphan count must return exactly one row'), {
      code: 'orphan_count_shape_error',
    });
  }
  return Number(res.rows[0].orphan_count);
}

function verifyConstraintRow(row, requireValidated) {
  if (!row) {
    throw Object.assign(new Error(`missing constraint ${CONSTRAINT_NAME}`), {
      code: 'constraint_missing',
    });
  }
  const contype = String(row.contype || '');
  if (contype !== 'f') {
    throw Object.assign(new Error(`constraint ${CONSTRAINT_NAME} wrong contype`), {
      code: 'constraint_wrong_type',
      got: contype,
    });
  }
  const convalidated = row.convalidated === true || row.convalidated === 't';
  // Final (validated): exact canonical observer def — no NOT VALID suffix.
  // Mid (NOT VALID): body must match canonical; PG may append " NOT VALID".
  const defOk = requireValidated === true
    ? condefMatchesExpected(row.condef)
    : condefMatchesExpectedAllowingNotValidSuffix(row.condef);
  if (!defOk) {
    throw Object.assign(new Error(`constraint ${CONSTRAINT_NAME} condef mismatch`), {
      code: 'constraint_condef_mismatch',
      got: row.condef,
    });
  }
  if (requireValidated === true && !convalidated) {
    throw Object.assign(new Error(`constraint ${CONSTRAINT_NAME} not validated`), {
      code: 'constraint_not_validated',
    });
  }
  if (requireValidated === false && convalidated) {
    throw Object.assign(new Error(`constraint ${CONSTRAINT_NAME} already validated`), {
      code: 'constraint_already_validated',
    });
  }
  if (String(row.name || '') !== CONSTRAINT_NAME) {
    throw Object.assign(new Error(`constraint name mismatch`), {
      code: 'constraint_name_mismatch',
      got: row.name,
    });
  }
  return {
    name: row.name,
    contype,
    convalidated,
    condef: row.condef,
    condefMatch: true,
  };
}

async function runAuthorizedSurfPackFkApplySequence(client, opts) {
  const options = opts || {};
  const secrets = (options.secrets || []).filter(Boolean);
  const steps = [];
  let began = false;
  let committed = false;
  let rolledBack = false;
  let beforeConstraint = null;
  let afterConstraint = null;
  let constraintVerification = null;
  const rowCountsBefore = {};
  const rowCountsAfter = {};
  let capturedRowCount = null;
  let orphanCount = 0;

  if (options.sql != null
    || options.query != null
    || options.host != null
    || options.database != null
    || options.dsn != null) {
    throw Object.assign(new Error('caller-supplied SQL / host / database / DSN forbidden'), {
      code: 'caller_supplied_query_forbidden',
    });
  }

  const hashes = assertFkAlterStatementsByteLocked();

  async function q(sql, params) {
    authorizeApplySql(sql);
    applyQueryCallCount += 1;
    if (params === undefined) return client.query(sql);
    return client.query(sql, params);
  }

  function pushStep(kind) {
    steps.push(kind);
  }

  try {
    await q('BEGIN');
    began = true;
    pushStep('BEGIN');

    await q(SET_LOCK_TIMEOUT_SQL);
    pushStep('SET LOCAL lock_timeout');

    await q(SET_STATEMENT_TIMEOUT_SQL);
    pushStep('SET LOCAL statement_timeout');

    await q(SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL);
    pushStep('SET LOCAL idle_in_transaction_session_timeout');

    await q(ADVISORY_LOCK_SQL, [ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2]);
    pushStep('pg_advisory_xact_lock');

    const tableRes = await q(AUTHORIZED_TABLE_EXISTS_SQL, [SCHEMA, TABLE]);
    pushStep('catalog_table_tenant_surf_pack_rules');
    if (!tableRes || tableRes.rowCount !== 1) {
      throw Object.assign(new Error(`public.${TABLE} table missing`), {
        code: 'table_missing',
        table: TABLE,
      });
    }

    const srcColRes = await q(
      AUTHORIZED_COLUMN_CATALOG_SQL,
      [SCHEMA, TABLE, [SRC_COLUMN]],
    );
    pushStep('catalog_columns_tenant_surf_pack_rules');

    const refTableRes = await q(AUTHORIZED_TABLE_EXISTS_SQL, [SCHEMA, REF_TABLE]);
    pushStep('catalog_table_staff_users');
    if (!refTableRes || refTableRes.rowCount !== 1) {
      throw Object.assign(new Error(`public.${REF_TABLE} table missing`), {
        code: 'table_missing',
        table: REF_TABLE,
      });
    }

    const refColRes = await q(
      AUTHORIZED_COLUMN_CATALOG_SQL,
      [SCHEMA, REF_TABLE, [REF_COLUMN]],
    );
    pushStep('catalog_columns_staff_users');

    validateColumnType(TABLE, SRC_COLUMN, srcColRes.rows, 'uuid');
    validateColumnType(REF_TABLE, REF_COLUMN, refColRes.rows, 'uuid');

    const typeCompatRes = await q(TYPE_COMPAT_SQL);
    pushStep('assert_compatible_types');
    if (!typeCompatRes.rows || typeCompatRes.rows.length !== 1) {
      throw Object.assign(new Error('type compat query must return one row'), {
        code: 'type_compat_shape_error',
      });
    }
    const srcUdt = typeCompatRes.rows[0].src_udt;
    const refUdt = typeCompatRes.rows[0].ref_udt;
    if (srcUdt !== 'uuid' || refUdt !== 'uuid') {
      throw Object.assign(new Error('updated_by and staff_users.id must both be uuid'), {
        code: 'type_mismatch',
        srcUdt,
        refUdt,
      });
    }

    const countRes = await q(ROW_COUNT_SQL);
    pushStep('row_count_before_tenant_surf_pack_rules');
    const n = readRowCount(countRes);
    rowCountsBefore[TABLE] = n;
    capturedRowCount = n === APPROVED_ROW_COUNT ? APPROVED_ROW_COUNT : n;
    const rowBound = capturedRowCount;

    const absent = await q(
      CONSTRAINT_VERIFY_SQL,
      [SCHEMA, TABLE, [CONSTRAINT_NAME]],
    );
    pushStep('assert_fk_absent');
    beforeConstraint = {
      name: CONSTRAINT_NAME,
      present: Boolean(absent && absent.rowCount > 0),
    };
    if (absent && absent.rowCount !== 0) {
      throw Object.assign(
        new Error(`preexisting FK ${CONSTRAINT_NAME}`),
        { code: 'fk_preexisting', constraintName: CONSTRAINT_NAME },
      );
    }

    const tableFks = await q(TABLE_FOREIGN_KEYS_SQL, [SCHEMA, TABLE]);
    pushStep('assert_no_semantic_duplicate_fk');
    const dupes = (tableFks.rows || []).filter((r) =>
      r.name !== CONSTRAINT_NAME && semanticFkDuplicateMatch(r.condef));
    if (dupes.length) {
      throw Object.assign(
        new Error(`semantic duplicate FK for ${CONSTRAINT_NAME}`),
        {
          code: 'semantic_duplicate_fk',
          found: dupes.map((d) => d.name),
        },
      );
    }

    const nameLookup = await q(CONSTRAINT_NAME_LOOKUP_SQL, [CONSTRAINT_NAME]);
    pushStep('assert_no_incompatible_same_name');
    if (nameLookup && nameLookup.rowCount > 0) {
      throw Object.assign(
        new Error(`incompatible same-name constraint ${CONSTRAINT_NAME}`),
        {
          code: 'incompatible_same_name_fk',
          found: nameLookup.rows,
        },
      );
    }

    const orphanRes = await q(ORPHAN_SQL);
    pushStep('assert_orphan_count_zero');
    orphanCount = readOrphanCount(orphanRes);
    if (orphanCount > 0) {
      throw Object.assign(
        new Error(`orphan rows present: ${orphanCount}`),
        { code: 'orphan_present', orphanCount },
      );
    }

    await q(ADD_FK_NOT_VALID_SQL);
    pushStep('ADD CONSTRAINT NOT VALID');

    const verifyNotValid = await q(
      CONSTRAINT_VERIFY_SQL,
      [SCHEMA, TABLE, [CONSTRAINT_NAME]],
    );
    pushStep('verify_constraint_after_not_valid');
    const midRow = (verifyNotValid.rows || [])[0];
    const midVerified = verifyConstraintRow(midRow, false);
    constraintVerification = { afterNotValid: midVerified };

    await q(VALIDATE_FK_SQL);
    pushStep('VALIDATE CONSTRAINT');

    const verifyFinal = await q(
      CONSTRAINT_VERIFY_SQL,
      [SCHEMA, TABLE, [CONSTRAINT_NAME]],
    );
    pushStep('verify_constraint_final');
    const finalRow = (verifyFinal.rows || [])[0];
    const finalVerified = verifyConstraintRow(finalRow, true);
    afterConstraint = finalVerified;
    constraintVerification = {
      afterNotValid: midVerified,
      final: finalVerified,
    };

    const countAfterRes = await q(ROW_COUNT_SQL);
    pushStep('row_count_after_tenant_surf_pack_rules');
    const nAfter = readRowCount(countAfterRes);
    rowCountsAfter[TABLE] = nAfter;
    if (nAfter !== rowCountsBefore[TABLE] || nAfter !== rowBound) {
      throw Object.assign(
        new Error(`row count changed: before=${rowCountsBefore[TABLE]} after=${nAfter} bound=${rowBound}`),
        { code: 'row_count_changed', before: rowCountsBefore[TABLE], after: nAfter, bound: rowBound },
      );
    }

    await q('COMMIT');
    committed = true;
    pushStep('COMMIT');

    return redactDeep({
      ok: true,
      code: 'phase_d_surf_pack_fk_apply_ok',
      steps: steps.slice(),
      authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
      beforeConstraint: { name: CONSTRAINT_NAME, present: false },
      afterConstraint,
      constraintVerification,
      rowCountsBefore: { ...rowCountsBefore },
      rowCountsAfter: { ...rowCountsAfter },
      capturedRowCount,
      orphanCount,
      alterStatementsSha256: hashes.alterStatementsSha256,
      ownerMigrationSha256: hashes.ownerMigrationSha256,
      baselineMismatchCount: BASELINE_MISMATCH_COUNT,
      expectedRemainingMismatchCount: EXPECTED_REMAINING_MISMATCH_COUNT,
      expectedRemainingKeys: EXPECTED_REMAINING_KEYS.slice(),
      readOnly: false,
      mutates: true,
      schemaMutation: true,
      dataMutation: false,
      appliesFk: true,
      writesLedger: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      surfPackFkApplyLiveEnabled: PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED === true,
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
      'type_mismatch',
      'row_count_shape_error',
      'row_count_changed',
      'orphan_count_shape_error',
      'orphan_present',
      'fk_preexisting',
      'semantic_duplicate_fk',
      'incompatible_same_name_fk',
      'constraint_missing',
      'constraint_condef_mismatch',
      'constraint_not_validated',
      'constraint_already_validated',
      'alter_statement_hash_drift',
      'owner_migration_checksum_mismatch',
      'expected_schema_fkdef_missing',
      'baseline_drift_mismatch',
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
      message: redactSecrets(String(err.message || 'surf pack fk apply failed'), secrets),
      steps: steps.slice(),
      rolledBack,
      committed: false,
      beforeConstraint,
      rowCountsBefore,
      orphanCount,
      mutates: false,
      schemaMutation: false,
      dataMutation: false,
      appliesFk: false,
      writesLedger: false,
      liveApplyEnabled: false,
      surfPackFkApplyLiveEnabled: PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED === true,
    }, secrets);
    throw Object.assign(new Error(safe.message), { code: safe.code, result: safe });
  }
}

function instantiateApplyPgClient(clientConfig, deps) {
  const d = deps || {};
  applyPgClientInstantiateCount += 1;
  let ClientCtor = d.Client;
  if (!ClientCtor) {
    if (PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED !== true) {
      throw Object.assign(new Error('surf pack fk apply live capability disabled'), {
        code: 'surf_pack_fk_apply_capability_disabled',
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

function pickSafeSurfPackFkApplyOutput(result) {
  const src = result || {};
  const out = {};
  for (const k of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return redactDeep(out, []);
}

function defaultVerifyRowsAfterNotValid() {
  return [{
    name: CONSTRAINT_NAME,
    contype: 'f',
    convalidated: false,
    // Mirror live PG: pg_get_constraintdef appends NOT VALID while convalidated=false.
    condef: `${EXPECTED_CONDEF} NOT VALID`,
  }];
}

function defaultVerifyRowsFinal() {
  return [{
    name: CONSTRAINT_NAME,
    contype: 'f',
    convalidated: true,
    condef: EXPECTED_CONDEF,
  }];
}

function createScriptedSurfPackFkApplyFakeClient(script) {
  const s = script || {};
  const expected = (s.expectedSteps || AUTHORIZED_SEQUENCE).slice();
  const calls = [];
  let stepIndex = 0;
  let connected = false;
  let ended = false;
  const responses = s.responses || {};
  const priorSteps = [];

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
      const kind = classifyApplyStep(sql, params, priorSteps);
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
        || kind === 'SET LOCAL lock_timeout'
        || kind === 'SET LOCAL statement_timeout'
        || kind === 'SET LOCAL idle_in_transaction_session_timeout'
        || kind === 'pg_advisory_xact_lock'
        || kind === 'ADD CONSTRAINT NOT VALID'
        || kind === 'VALIDATE CONSTRAINT') {
        priorSteps.push(kind);
        return { rows: [], rowCount: 0 };
      }

      if (String(kind).startsWith('catalog_table_')) {
        priorSteps.push(kind);
        return responses.catalogTable || { rows: [{ '?column?': 1 }], rowCount: 1 };
      }

      if (kind === 'catalog_columns_tenant_surf_pack_rules') {
        priorSteps.push(kind);
        const rows = responses.catalogColumnsTenant
          || [{ name: SRC_COLUMN, udt_name: 'uuid', is_nullable: true }];
        return { rows, rowCount: rows.length };
      }

      if (kind === 'catalog_columns_staff_users') {
        priorSteps.push(kind);
        const rows = responses.catalogColumnsStaff
          || [{ name: REF_COLUMN, udt_name: 'uuid', is_nullable: false }];
        return { rows, rowCount: rows.length };
      }

      if (kind === 'assert_compatible_types') {
        priorSteps.push(kind);
        const rows = responses.typeCompat || [{ src_udt: 'uuid', ref_udt: 'uuid' }];
        return { rows, rowCount: 1 };
      }

      if (kind === 'row_count_before_tenant_surf_pack_rules'
        || kind === 'row_count_after_tenant_surf_pack_rules') {
        priorSteps.push(kind);
        const n = (responses.rowCount != null)
          ? responses.rowCount
          : APPROVED_ROW_COUNT;
        return { rows: [{ table_total: n }], rowCount: 1 };
      }

      if (kind === 'assert_fk_absent') {
        priorSteps.push(kind);
        return responses.fkAbsence || { rows: [], rowCount: 0 };
      }

      if (kind === 'assert_no_semantic_duplicate_fk') {
        priorSteps.push(kind);
        return responses.tableForeignKeys || { rows: [], rowCount: 0 };
      }

      if (kind === 'assert_no_incompatible_same_name') {
        priorSteps.push(kind);
        return responses.constraintNameLookup || { rows: [], rowCount: 0 };
      }

      if (kind === 'assert_orphan_count_zero') {
        priorSteps.push(kind);
        const orphan = (responses.orphanCount != null) ? responses.orphanCount : 0;
        return { rows: [{ orphan_count: orphan }], rowCount: 1 };
      }

      if (kind === 'verify_constraint_after_not_valid') {
        priorSteps.push(kind);
        const rows = responses.verifyAfterNotValid || defaultVerifyRowsAfterNotValid();
        return { rows, rowCount: rows.length };
      }

      if (kind === 'verify_constraint_final') {
        priorSteps.push(kind);
        const rows = responses.verifyFinal || defaultVerifyRowsFinal();
        return { rows, rowCount: rows.length };
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

function createScriptedSurfPackFkApplyFakeClientFactory(script) {
  return function FakeClient() {
    return createScriptedSurfPackFkApplyFakeClient(script);
  };
}

async function executePhaseDSurfPackFkApply(opts) {
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
    return pickSafeSurfPackFkApplyOutput({
      ok: false,
      code: 'caller_supplied_connect_forbidden',
      applySurfPackFk: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      privateRefsZeroed: true,
    });
  }

  const gates = evaluateSurfPackFkApplyGates({
    env: options.env,
    argv: options.argv || [],
  });
  if (!gates.ok) {
    return pickSafeSurfPackFkApplyOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'surf_pack_fk_apply_gates_rejected',
      errors: gates.errors,
      applySurfPackFk: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      surfPackFkApplyLiveEnabled: PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED === true,
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
      return pickSafeSurfPackFkApplyOutput({
        ok: false,
        code: loaded.code || 'managed_identity_loader_failed',
        errors: loaded.errors || [],
        applySurfPackFk: false,
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
    return pickSafeSurfPackFkApplyOutput({
      ok: false,
      code: e.code || 'credential_target_rejected',
      errors: e.errors || [{ code: e.code, message: e.message }],
      applySurfPackFk: false,
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
      sequence = await runAuthorizedSurfPackFkApplySequence(client, { secrets });
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
      code: sequence.code || 'phase_d_surf_pack_fk_apply_ok',
      applySurfPackFk: true,
      steps: sequence.steps,
      authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
      beforeConstraint: sequence.beforeConstraint,
      afterConstraint: sequence.afterConstraint,
      constraintVerification: sequence.constraintVerification,
      rowCountsBefore: sequence.rowCountsBefore,
      rowCountsAfter: sequence.rowCountsAfter,
      capturedRowCount: sequence.capturedRowCount,
      orphanCount: sequence.orphanCount,
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
      appliesFk: true,
      writesLedger: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      surfPackFkApplyLiveEnabled: true,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      usedLiveHttp: managedIdentityHttpDelta.httpRequestCount > 0 && !offlineProofClient,
      realImdsCall: managedIdentityHttpDelta.imdsRequestCount > 0 && !offlineProofClient,
      realKeyVaultCall: managedIdentityHttpDelta.keyVaultRequestCount > 0 && !offlineProofClient,
      realPostgresCall: !offlineProofClient,
      committed: true,
      rolledBack: false,
      privateRefsZeroed: true,
      baselineMismatchCount: BASELINE_MISMATCH_COUNT,
      expectedRemainingMismatchCount: EXPECTED_REMAINING_MISMATCH_COUNT,
      expectedRemainingKeys: EXPECTED_REMAINING_KEYS.slice(),
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
      rowCountsBefore: result && result.rowCountsBefore ? result.rowCountsBefore : null,
      beforeConstraint: result && result.beforeConstraint ? result.beforeConstraint : null,
      orphanCount: result && result.orphanCount != null ? result.orphanCount : null,
      applySurfPackFk: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      appliesFk: false,
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
      surfPackFkApplyLiveEnabled: true,
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

  if (clientConfig) {
    try { clientConfig.password = undefined; clientConfig.user = undefined; } catch (_) { /* ignore */ }
  }

  return pickSafeSurfPackFkApplyOutput(outcome);
}

function exactSurfPackFkApplyArgv() {
  return [
    CLI_APPLY_SURF_PACK_FK,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function surfPackFkApplyEnv(extra) {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_SURF_PACK_FK_APPLY]: '1',
    [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ...(extra || {}),
  };
}

function renderSurfPackFkApplyUsage() {
  return [
    'phase-d:surf-pack-fk-apply — FOUNDATION Slice 14Z',
    '',
    'Default: refused (zero pg Clients / zero HTTP).',
    '',
    'Required env:',
    `  ${ENV_LIVE_READONLY}=1`,
    `  ${ENV_LIVE_PREFLIGHT}=1`,
    `  ${ENV_SURF_PACK_FK_APPLY}=1`,
    `  ${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `  AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
    '',
    'Required argv:',
    `  ${CLI_APPLY_SURF_PACK_FK}`,
    `  --subscription ${TARGETS.subscriptionId}`,
    `  --resource-group ${TARGETS.resourceGroup}`,
    `  --postgres-server ${TARGETS.postgresServer}`,
    `  --database ${TARGETS.database}`,
    `  ${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    '',
    'Applies exactly one residual FK. No ledger/DML/DROP.',
  ].join('\n');
}

module.exports = {
  PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_SURF_PACK_FK_APPLY,
  CLI_APPLY_SURF_PACK_FK,
  APPLICATION_NAME,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  LOCK_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  FK_SPEC,
  TABLE,
  REF_TABLE,
  CONSTRAINT_NAME,
  OBSERVER_KEY,
  APPROVED_ROW_COUNT,
  ADD_FK_DIRECT_SQL,
  ADD_FK_NOT_VALID_SQL,
  VALIDATE_FK_SQL,
  ORPHAN_SQL,
  ADD_FK_DIRECT_SHA256,
  ADD_FK_NOT_VALID_SHA256,
  VALIDATE_FK_SHA256,
  ORPHAN_SQL_SHA256,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  EXPECTED_REDUCTION,
  EXPECTED_REMAINING_MISMATCH_COUNT,
  EXPECTED_REMAINING_KEYS,
  AUTHORIZED_SEQUENCE,
  SUCCESS_PATH_QUERY_COUNT,
  APPLY_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  CONSTRAINT_VERIFY_SQL,
  TABLE_FOREIGN_KEYS_SQL,
  CONSTRAINT_NAME_LOOKUP_SQL,
  TYPE_COMPAT_SQL,
  SET_LOCK_TIMEOUT_SQL,
  SET_STATEMENT_TIMEOUT_SQL,
  SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL,
  ADVISORY_LOCK_SQL,
  evaluateSurfPackFkApplyGates,
  executePhaseDSurfPackFkApply,
  runAuthorizedSurfPackFkApplySequence,
  createScriptedSurfPackFkApplyFakeClient,
  createScriptedSurfPackFkApplyFakeClientFactory,
  getSurfPackFkApplyCounters,
  resetSurfPackFkApplyCounters,
  pickSafeSurfPackFkApplyOutput,
  exactSurfPackFkApplyArgv,
  surfPackFkApplyEnv,
  renderSurfPackFkApplyUsage,
  assertFkAlterStatementsByteLocked,
  assertBaselineMismatch,
  authorizeApplySql,
  classifyApplyStep,
  normalizeCondef,
  condefMatchesExpected,
  semanticFkDuplicateMatch,
  buildApplyConnectConfig,
  buildApplyPgClientConfig,
};
