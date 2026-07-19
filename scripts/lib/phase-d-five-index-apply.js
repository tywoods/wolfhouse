'use strict';

/**
 * phase-d-five-index-apply — FOUNDATION Slice 14Y
 *
 * Default-disabled exact-gated managed-identity live adapter that applies
 * exactly FIVE missing canonical residual indexes on Sunset staging
 * `sunset_staging`. No other objects. No DML/DROP/ALTER/FK/trigger/function/
 * extension/ownership/ACL/ledger/KV/RBAC/network/deploy. No migration file
 * changes. No CONCURRENTLY. On any error ROLLBACK, no retry.
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

/** Capability flag for Slice 14Y — still default-disabled via env+argv gates. */
const PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED = true;

const ENV_FIVE_INDEX_APPLY = 'SUNSET_PHASE_D_FIVE_INDEX_APPLY';
const CLI_APPLY_FIVE_INDEXES = '--apply-five-indexes';

const APPLICATION_NAME = 'wh-sunset-five-index-apply';

/** Fixed transaction-scoped advisory lock (not the canonical migration runner pair). */
const ADVISORY_LOCK_KEY1 = 0x57485059; // WHPY
const ADVISORY_LOCK_KEY2 = 0x49445835; // IDX5

const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 30000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60000;
const CONNECTION_TIMEOUT_MS = 20000;

const SCHEMA = 'public';

/** Post-14X residual baseline (exactly 11 mismatches; 5 are indexes). */
const BASELINE_MISMATCH_COUNT = 11;
const BASELINE_MISMATCH_SECTIONS = Object.freeze({
  constraints: 1,
  indexes: 5,
  functions: 1,
  triggers: 1,
  ownership: 1,
  acls: 1,
  extensions: 1,
});
const EXPECTED_REDUCTION = 5;
const EXPECTED_REMAINING_MISMATCH_COUNT = 6;
/** Sorted unique-stable list matching 14X after removing the five index keys. */
const EXPECTED_REMAINING_KEYS = Object.freeze([
  'function:public.fips_mode()',
  'function:public.fips_mode()',
  'pgcrypto',
  'public.fips_mode()',
  'tenant_surf_pack_rules.tenant_surf_pack_rules_updated_at',
  'tenant_surf_pack_rules.tenant_surf_pack_rules_updated_by_fkey.FOREIGN KEY',
]);

const CREATE_SQL_TENANT_SURF = 'CREATE INDEX idx_tenant_surf_pack_client_loc ON public.tenant_surf_pack_rules USING btree (client_slug, location_id) WHERE (active = true)';
const CREATE_SQL_CNE_CLIENT = 'CREATE INDEX idx_client_notification_events_client_created ON public.client_notification_events USING btree (client_slug, created_at DESC)';
const CREATE_SQL_CNE_CONV = 'CREATE INDEX idx_client_notification_events_conversation ON public.client_notification_events USING btree (conversation_id, notification_type)';
const CREATE_SQL_CNS_CLIENT = 'CREATE INDEX idx_client_notification_settings_client ON public.client_notification_settings USING btree (client_slug, location_id)';
const CREATE_SQL_CMT_ACTIVE = 'CREATE INDEX idx_customer_message_templates_client_active ON public.customer_message_templates USING btree (client_id, active, updated_at DESC)';

/**
 * Five indexes in deterministic migration-dependency order
 * (owner migration ascending, then alphabetical index name within owner).
 */
const FIVE_INDEX_SPECS = Object.freeze([
  Object.freeze({
    indexName: 'idx_tenant_surf_pack_client_loc',
    table: 'tenant_surf_pack_rules',
    ownerMigration: '026_tenant_surf_pack_rules',
    ownerMigrationSha256: '8923551f385bda87e649b567fd47153ed94014029ac5138176beff7e58512496',
    key: 'tenant_surf_pack_rules.idx_tenant_surf_pack_client_loc',
    columns: Object.freeze(['client_slug', 'location_id', 'active']),
    approvedRowCount: 36,
    createSql: CREATE_SQL_TENANT_SURF,
    createSqlSha256: 'b832bfd1db8a4ecd8f1195facf0e0c6c2653626c8a7b3009bcdc206da07af671',
    expectedIndexdef: CREATE_SQL_TENANT_SURF,
  }),
  Object.freeze({
    indexName: 'idx_client_notification_events_client_created',
    table: 'client_notification_events',
    ownerMigration: '032_client_notification_settings',
    ownerMigrationSha256: 'b3788bd58ce6c6e158857dd56237fa5ff3be0fe4d1afe0f1e5f5c1acdbc4995d',
    key: 'client_notification_events.idx_client_notification_events_client_created',
    columns: Object.freeze(['client_slug', 'created_at']),
    approvedRowCount: 0,
    createSql: CREATE_SQL_CNE_CLIENT,
    createSqlSha256: '779136efe4d82cea17b808ab92cdcc76fc64923138ff129b34a05da05e6a6387',
    expectedIndexdef: CREATE_SQL_CNE_CLIENT,
  }),
  Object.freeze({
    indexName: 'idx_client_notification_events_conversation',
    table: 'client_notification_events',
    ownerMigration: '032_client_notification_settings',
    ownerMigrationSha256: 'b3788bd58ce6c6e158857dd56237fa5ff3be0fe4d1afe0f1e5f5c1acdbc4995d',
    key: 'client_notification_events.idx_client_notification_events_conversation',
    columns: Object.freeze(['conversation_id', 'notification_type']),
    approvedRowCount: 0,
    createSql: CREATE_SQL_CNE_CONV,
    createSqlSha256: '99670a6b79936008d803055e54bceb2d3821b817adb9ae2b7d25007d13cd264b',
    expectedIndexdef: CREATE_SQL_CNE_CONV,
  }),
  Object.freeze({
    indexName: 'idx_client_notification_settings_client',
    table: 'client_notification_settings',
    ownerMigration: '032_client_notification_settings',
    ownerMigrationSha256: 'b3788bd58ce6c6e158857dd56237fa5ff3be0fe4d1afe0f1e5f5c1acdbc4995d',
    key: 'client_notification_settings.idx_client_notification_settings_client',
    columns: Object.freeze(['client_slug', 'location_id']),
    approvedRowCount: 0,
    createSql: CREATE_SQL_CNS_CLIENT,
    createSqlSha256: 'd68979a53470a6f3a283d64939f80e4bbd508f55b7890c51403e9188fef6c1a8',
    expectedIndexdef: CREATE_SQL_CNS_CLIENT,
  }),
  Object.freeze({
    indexName: 'idx_customer_message_templates_client_active',
    table: 'customer_message_templates',
    ownerMigration: '035_customer_message_templates',
    ownerMigrationSha256: '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
    key: 'customer_message_templates.idx_customer_message_templates_client_active',
    columns: Object.freeze(['client_id', 'active', 'updated_at']),
    approvedRowCount: 0,
    createSql: CREATE_SQL_CMT_ACTIVE,
    createSqlSha256: '8f0c7d88b3b55dfb1396dd1a7146d8d0a5cc9fc95e07c80f08067d7df735e134',
    expectedIndexdef: CREATE_SQL_CMT_ACTIVE,
  }),
]);

/** Unique tables in order of first appearance in FIVE_INDEX_SPECS. */
const UNIQUE_TABLES = Object.freeze([
  'tenant_surf_pack_rules',
  'client_notification_events',
  'client_notification_settings',
  'customer_message_templates',
]);

const APPROVED_ROW_COUNT_BY_TABLE = Object.freeze({
  tenant_surf_pack_rules: 36,
  client_notification_events: 0,
  client_notification_settings: 0,
  customer_message_templates: 0,
});

/** Frozen exact row-count SQL strings — no dynamic SQL in authorize. */
const ROW_COUNT_SQL_BY_TABLE = Object.freeze({
  tenant_surf_pack_rules:
    'SELECT count(*)::bigint AS table_total FROM public.tenant_surf_pack_rules',
  client_notification_events:
    'SELECT count(*)::bigint AS table_total FROM public.client_notification_events',
  client_notification_settings:
    'SELECT count(*)::bigint AS table_total FROM public.client_notification_settings',
  customer_message_templates:
    'SELECT count(*)::bigint AS table_total FROM public.customer_message_templates',
});

const AUTHORIZED_SEQUENCE = Object.freeze([
  'BEGIN',
  'SET LOCAL lock_timeout',
  'SET LOCAL statement_timeout',
  'SET LOCAL idle_in_transaction_session_timeout',
  'pg_advisory_xact_lock',
  'catalog_table_tenant_surf_pack_rules',
  'catalog_columns_tenant_surf_pack_rules',
  'row_count_before_tenant_surf_pack_rules',
  'catalog_table_client_notification_events',
  'catalog_columns_client_notification_events',
  'row_count_before_client_notification_events',
  'catalog_table_client_notification_settings',
  'catalog_columns_client_notification_settings',
  'row_count_before_client_notification_settings',
  'catalog_table_customer_message_templates',
  'catalog_columns_customer_message_templates',
  'row_count_before_customer_message_templates',
  'assert_index_absent_idx_tenant_surf_pack_client_loc',
  'assert_no_semantic_duplicate_idx_tenant_surf_pack_client_loc',
  'assert_no_incompatible_name_idx_tenant_surf_pack_client_loc',
  'assert_index_absent_idx_client_notification_events_client_created',
  'assert_no_semantic_duplicate_idx_client_notification_events_client_created',
  'assert_no_incompatible_name_idx_client_notification_events_client_created',
  'assert_index_absent_idx_client_notification_events_conversation',
  'assert_no_semantic_duplicate_idx_client_notification_events_conversation',
  'assert_no_incompatible_name_idx_client_notification_events_conversation',
  'assert_index_absent_idx_client_notification_settings_client',
  'assert_no_semantic_duplicate_idx_client_notification_settings_client',
  'assert_no_incompatible_name_idx_client_notification_settings_client',
  'assert_index_absent_idx_customer_message_templates_client_active',
  'assert_no_semantic_duplicate_idx_customer_message_templates_client_active',
  'assert_no_incompatible_name_idx_customer_message_templates_client_active',
  'CREATE INDEX idx_tenant_surf_pack_client_loc',
  'CREATE INDEX idx_client_notification_events_client_created',
  'CREATE INDEX idx_client_notification_events_conversation',
  'CREATE INDEX idx_client_notification_settings_client',
  'CREATE INDEX idx_customer_message_templates_client_active',
  'verify_indexes',
  'row_count_after_tenant_surf_pack_rules',
  'row_count_after_client_notification_events',
  'row_count_after_client_notification_settings',
  'row_count_after_customer_message_templates',
  'COMMIT',
]);

/** Deterministic success-path query step count (= AUTHORIZED_SEQUENCE length). */
const SUCCESS_PATH_QUERY_COUNT = AUTHORIZED_SEQUENCE.length;

const SET_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`;
const SET_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`;
const SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL = `SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT_MS}ms'`;
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1, $2)';

const INDEX_NAME_LOOKUP_SQL = [
  'SELECT c.relname AS name, i.indisvalid, i.indisready, i.indisunique,',
  '  am.amname AS am, pg_get_indexdef(c.oid) AS indexdef',
  'FROM pg_class c',
  'JOIN pg_namespace n ON n.oid = c.relnamespace',
  'JOIN pg_index i ON i.indexrelid = c.oid',
  'JOIN pg_am am ON am.oid = c.relam',
  'WHERE n.nspname = $1 AND c.relname = ANY($2::text[])',
  'ORDER BY c.relname',
].join('\n');

const TABLE_INDEXES_SQL = [
  'SELECT c.relname AS name, pg_get_indexdef(c.oid) AS indexdef',
  'FROM pg_class c',
  'JOIN pg_namespace n ON n.oid = c.relnamespace',
  'JOIN pg_index i ON i.indexrelid = c.oid',
  'JOIN pg_class t ON t.oid = i.indrelid',
  'WHERE n.nspname = $1 AND t.relname = $2',
  'ORDER BY c.relname',
].join('\n');

const RELKIND_LOOKUP_SQL = [
  'SELECT rel.relkind',
  'FROM pg_class rel',
  'JOIN pg_namespace n ON n.oid = rel.relnamespace',
  'WHERE n.nspname = $1 AND rel.relname = $2',
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
  indexNames: Object.freeze(FIVE_INDEX_SPECS.map((s) => s.indexName)),
  indexKeys: Object.freeze(FIVE_INDEX_SPECS.map((s) => s.key)),
  createSqlSha256: Object.freeze(FIVE_INDEX_SPECS.map((s) => s.createSqlSha256)),
  uniqueTables: UNIQUE_TABLES,
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
  CLI_APPLY_FIVE_INDEXES,
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
  'applyFiveIndexes',
  'liveApplyEnabled',
  'fiveIndexApplyLiveEnabled',
  'liveHttpEnabled',
  'liveMutation',
  'schemaMutation',
  'dataMutation',
  'ledgerWritten',
  'appliesIndexes',
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
  'beforeIndexes',
  'afterIndexes',
  'indexVerification',
  'rowCountsBefore',
  'rowCountsAfter',
  'createStatementsSha256',
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
]);

let applyPgClientInstantiateCount = 0;
let applyQueryCallCount = 0;

function getFiveIndexApplyCounters() {
  return {
    clientsInstantiated: applyPgClientInstantiateCount,
    queryCalls: applyQueryCallCount,
    httpRequestCount: getManagedIdentityHttpCounters().httpRequestCount,
    imdsRequestCount: getManagedIdentityHttpCounters().imdsRequestCount,
    keyVaultRequestCount: getManagedIdentityHttpCounters().keyVaultRequestCount,
  };
}

function resetFiveIndexApplyCounters() {
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
    if (flag === CLI_APPLY_FIVE_INDEXES || flag === '--help' || flag === '-h') {
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

function evaluateFiveIndexApplyGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const argv = Array.isArray(options.argv) ? options.argv.map(String) : [];
  const errors = [];

  if (PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED !== true) {
    errors.push({
      code: 'five_index_apply_capability_disabled',
      message: 'five index apply capability is disabled',
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

  if (String(env[ENV_FIVE_INDEX_APPLY] || '') !== '1') {
    errors.push({
      code: 'five_index_apply_env_required',
      message: `env ${ENV_FIVE_INDEX_APPLY}=1 is required`,
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
  if (!parsed.flags.has(CLI_APPLY_FIVE_INDEXES)) {
    errors.push({
      code: 'five_index_apply_flag_required',
      message: `${CLI_APPLY_FIVE_INDEXES} is required`,
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
    applyFiveIndexes: parsed.flags.has(CLI_APPLY_FIVE_INDEXES)
      && String(env[ENV_FIVE_INDEX_APPLY] || '') === '1',
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

function normalizeIndexdef(def) {
  return String(def || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Semantic equality for index definitions: compares the ON … portion
 * (columns + predicate + access method), ignoring the CREATE INDEX name.
 */
function indexdefSignature(def) {
  const n = normalizeIndexdef(def);
  const onIdx = n.search(/\bon\s+/);
  if (onIdx >= 0) return n.slice(onIdx);
  return n;
}

function semanticIndexdefMatch(expectedDef, liveDef) {
  const a = indexdefSignature(expectedDef);
  const b = indexdefSignature(liveDef);
  if (!a || !b) return false;
  return a === b;
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

function assertCreateIndexStatementsByteLocked() {
  const createStatementsSha256 = {};
  for (const spec of FIVE_INDEX_SPECS) {
    const recomputed = crypto
      .createHash('sha256')
      .update(spec.createSql, 'utf8')
      .digest('hex');
    if (recomputed !== spec.createSqlSha256) {
      throw Object.assign(new Error(`CREATE INDEX sha256 drift for ${spec.indexName}`), {
        code: 'create_index_hash_drift',
        indexName: spec.indexName,
      });
    }
    createStatementsSha256[spec.indexName] = recomputed;

    const migPath = path.join(MIGRATIONS_DIR, `${spec.ownerMigration}.sql`);
    const migSha = sha256CanonicalLfV1File(migPath);
    if (migSha !== spec.ownerMigrationSha256) {
      throw Object.assign(
        new Error(`owner migration sha256 drift for ${spec.ownerMigration}`),
        {
          code: 'owner_migration_checksum_mismatch',
          ownerMigration: spec.ownerMigration,
        },
      );
    }
  }

  const expectedRaw = fs.readFileSync(EXPECTED_SCHEMA_PATH, 'utf8');
  for (const spec of FIVE_INDEX_SPECS) {
    if (!expectedRaw.includes(spec.createSql)) {
      throw Object.assign(
        new Error(`expected-product-schema missing exact indexdef for ${spec.indexName}`),
        {
          code: 'expected_schema_indexdef_missing',
          indexName: spec.indexName,
        },
      );
    }
  }

  return {
    createStatementsSha256,
    ownerMigrationSha256: Object.freeze(
      Object.fromEntries(
        [...new Set(FIVE_INDEX_SPECS.map((s) => s.ownerMigration))].map((m) => {
          const spec = FIVE_INDEX_SPECS.find((s) => s.ownerMigration === m);
          return [m, spec.ownerMigrationSha256];
        }),
      ),
    ),
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
    || /\bALTER\s+TABLE\b/.test(upper)
    || /\bCREATE\s+TABLE\b/.test(upper)
    || /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/.test(upper)
    || /\bCREATE\s+TRIGGER\b/.test(upper)
    || /\bCREATE\s+EXTENSION\b/.test(upper)) {
    throw Object.assign(
      new Error('unauthorized SQL rejected: DROP/DML/ALTER/CONCURRENTLY/extra DDL forbidden'),
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
    INDEX_NAME_LOOKUP_SQL,
    TABLE_INDEXES_SQL,
    RELKIND_LOOKUP_SQL,
    ...Object.values(ROW_COUNT_SQL_BY_TABLE),
    ...FIVE_INDEX_SPECS.map((s) => s.createSql),
  ];
  for (const a of allowed) {
    if (n === normalizeSql(a)) return a;
  }
  throw Object.assign(
    new Error('unauthorized SQL rejected: only locked Phase D five-index-apply SQL permitted'),
    { code: 'unauthorized_sql' },
  );
}

function hasCreateIndexStep(priorSteps) {
  return (priorSteps || []).some((s) => String(s).startsWith('CREATE INDEX '));
}

function classifyCatalogTableStep(params) {
  const table = params && params[1];
  if (UNIQUE_TABLES.includes(table)) return `catalog_table_${table}`;
  return 'unauthorized';
}

function classifyCatalogColumnsStep(params) {
  const table = params && params[1];
  if (UNIQUE_TABLES.includes(table)) return `catalog_columns_${table}`;
  return 'unauthorized';
}

function classifyRowCountStep(sql, priorSteps) {
  const n = normalizeSql(sql);
  for (const table of UNIQUE_TABLES) {
    if (n === normalizeSql(ROW_COUNT_SQL_BY_TABLE[table])) {
      return hasCreateIndexStep(priorSteps)
        ? `row_count_after_${table}`
        : `row_count_before_${table}`;
    }
  }
  return 'unauthorized';
}

function classifyIndexNameLookupStep(params, priorSteps) {
  const names = (params && params[1]) || [];
  const list = Array.isArray(names) ? names : [];
  if (list.length === FIVE_INDEX_SPECS.length
    && FIVE_INDEX_SPECS.every((s) => list.includes(s.indexName))) {
    return 'verify_indexes';
  }
  if (list.length === 1) {
    const name = list[0];
    const spec = FIVE_INDEX_SPECS.find((s) => s.indexName === name);
    if (spec) return `assert_index_absent_${name}`;
  }
  // Fall back: next absent step not yet recorded.
  for (const spec of FIVE_INDEX_SPECS) {
    const step = `assert_index_absent_${spec.indexName}`;
    if (!(priorSteps || []).includes(step) && !hasCreateIndexStep(priorSteps)) {
      return step;
    }
  }
  return 'unauthorized';
}

function classifySemanticDuplicateStep(params, priorSteps) {
  const table = params && params[1];
  for (const spec of FIVE_INDEX_SPECS) {
    if (spec.table !== table) continue;
    const step = `assert_no_semantic_duplicate_${spec.indexName}`;
    if (!(priorSteps || []).includes(step)) return step;
  }
  return 'unauthorized';
}

function classifyIncompatibleNameStep(params, priorSteps) {
  const name = params && params[1];
  const spec = FIVE_INDEX_SPECS.find((s) => s.indexName === name);
  if (spec) return `assert_no_incompatible_name_${name}`;
  for (const s of FIVE_INDEX_SPECS) {
    const step = `assert_no_incompatible_name_${s.indexName}`;
    if (!(priorSteps || []).includes(step)) return step;
  }
  return 'unauthorized';
}

/**
 * Classify an authorized SQL statement into an AUTHORIZED_SEQUENCE step name.
 * Optional params / priorSteps disambiguate shared SQL templates.
 */
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

  for (const spec of FIVE_INDEX_SPECS) {
    if (n === normalizeSql(spec.createSql)) return `CREATE INDEX ${spec.indexName}`;
  }

  if (n === normalizeSql(AUTHORIZED_TABLE_EXISTS_SQL)) {
    return classifyCatalogTableStep(params);
  }
  if (n === normalizeSql(AUTHORIZED_COLUMN_CATALOG_SQL)) {
    return classifyCatalogColumnsStep(params);
  }
  if (Object.values(ROW_COUNT_SQL_BY_TABLE).some((s) => n === normalizeSql(s))) {
    return classifyRowCountStep(sql, priorSteps);
  }
  if (n === normalizeSql(INDEX_NAME_LOOKUP_SQL)) {
    return classifyIndexNameLookupStep(params, priorSteps);
  }
  if (n === normalizeSql(TABLE_INDEXES_SQL)) {
    return classifySemanticDuplicateStep(params, priorSteps);
  }
  if (n === normalizeSql(RELKIND_LOOKUP_SQL)) {
    return classifyIncompatibleNameStep(params, priorSteps);
  }
  return 'unauthorized';
}

function validateColumnsPresent(table, requiredColumns, rows) {
  const byName = new Map((rows || []).map((r) => [r.name, r]));
  for (const col of requiredColumns) {
    if (!byName.has(col)) {
      throw Object.assign(new Error(`missing column ${table}.${col}`), {
        code: 'column_missing',
        table,
        column: col,
      });
    }
  }
  return { ok: true, table: `${SCHEMA}.${table}`, columns: requiredColumns.slice() };
}

function readRowCount(res) {
  if (!res || !res.rows || res.rows.length !== 1) {
    throw Object.assign(new Error('row count must return exactly one row'), {
      code: 'row_count_shape_error',
    });
  }
  return Number(res.rows[0].table_total);
}

async function runAuthorizedFiveIndexApplySequence(client, opts) {
  const options = opts || {};
  const secrets = (options.secrets || []).filter(Boolean);
  const steps = [];
  let began = false;
  let committed = false;
  let rolledBack = false;
  const beforeIndexes = [];
  let afterIndexes = null;
  let indexVerification = null;
  const rowCountsBefore = {};
  const rowCountsAfter = {};
  const schemaByTable = {};

  if (options.sql != null
    || options.query != null
    || options.host != null
    || options.database != null
    || options.dsn != null) {
    throw Object.assign(new Error('caller-supplied SQL / host / database / DSN forbidden'), {
      code: 'caller_supplied_query_forbidden',
    });
  }

  const hashes = assertCreateIndexStatementsByteLocked();

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

    // Per unique table: exists + columns + approved row count bound.
    for (const table of UNIQUE_TABLES) {
      const tableRes = await q(AUTHORIZED_TABLE_EXISTS_SQL, [SCHEMA, table]);
      pushStep(`catalog_table_${table}`);
      if (!tableRes || tableRes.rowCount !== 1) {
        throw Object.assign(new Error(`public.${table} table missing`), {
          code: 'table_missing',
          table,
        });
      }

      const neededCols = [];
      const seen = new Set();
      for (const spec of FIVE_INDEX_SPECS) {
        if (spec.table !== table) continue;
        for (const c of spec.columns) {
          if (!seen.has(c)) {
            seen.add(c);
            neededCols.push(c);
          }
        }
      }

      const colRes = await q(AUTHORIZED_COLUMN_CATALOG_SQL, [SCHEMA, table, neededCols]);
      pushStep(`catalog_columns_${table}`);
      schemaByTable[table] = validateColumnsPresent(table, neededCols, colRes.rows);

      const countRes = await q(ROW_COUNT_SQL_BY_TABLE[table]);
      pushStep(`row_count_before_${table}`);
      const n = readRowCount(countRes);
      rowCountsBefore[table] = n;
      const approved = APPROVED_ROW_COUNT_BY_TABLE[table];
      if (n !== approved) {
        throw Object.assign(
          new Error(`row count bound mismatch for ${table}: got ${n}, approved ${approved}`),
          { code: 'row_count_bound_mismatch', table, got: n, approved },
        );
      }
    }

    // Prestate per index: absent name, no semantic duplicate, no incompatible name.
    for (const spec of FIVE_INDEX_SPECS) {
      const absent = await q(INDEX_NAME_LOOKUP_SQL, [SCHEMA, [spec.indexName]]);
      pushStep(`assert_index_absent_${spec.indexName}`);
      beforeIndexes.push({
        name: spec.indexName,
        present: Boolean(absent && absent.rowCount > 0),
      });
      if (absent && absent.rowCount !== 0) {
        throw Object.assign(
          new Error(`preexisting index ${spec.indexName}`),
          { code: 'index_preexisting', indexName: spec.indexName },
        );
      }

      const tableIdx = await q(TABLE_INDEXES_SQL, [SCHEMA, spec.table]);
      pushStep(`assert_no_semantic_duplicate_${spec.indexName}`);
      const dupes = (tableIdx.rows || []).filter((r) =>
        r.name !== spec.indexName
        && semanticIndexdefMatch(spec.expectedIndexdef, r.indexdef));
      if (dupes.length) {
        throw Object.assign(
          new Error(`semantic duplicate index for ${spec.indexName}`),
          {
            code: 'semantic_duplicate_index',
            indexName: spec.indexName,
            found: dupes.map((d) => d.name),
          },
        );
      }

      const rel = await q(RELKIND_LOOKUP_SQL, [SCHEMA, spec.indexName]);
      pushStep(`assert_no_incompatible_name_${spec.indexName}`);
      if (rel && rel.rowCount > 0) {
        throw Object.assign(
          new Error(`incompatible same-name object for ${spec.indexName}`),
          {
            code: 'incompatible_same_name_object',
            indexName: spec.indexName,
            relkind: rel.rows[0].relkind,
          },
        );
      }
    }

    // CREATE INDEX (no CONCURRENTLY) in locked order.
    for (const spec of FIVE_INDEX_SPECS) {
      await q(spec.createSql);
      pushStep(`CREATE INDEX ${spec.indexName}`);
    }

    const verifyRes = await q(
      INDEX_NAME_LOOKUP_SQL,
      [SCHEMA, FIVE_INDEX_SPECS.map((s) => s.indexName)],
    );
    pushStep('verify_indexes');
    const verified = (verifyRes.rows || []).map((r) => ({
      name: r.name,
      indisvalid: r.indisvalid === true || r.indisvalid === 't',
      indisready: r.indisready === true || r.indisready === 't',
      indisunique: r.indisunique === true || r.indisunique === 't',
      am: r.am,
      indexdef: r.indexdef,
    }));
    if (verified.length !== FIVE_INDEX_SPECS.length) {
      throw Object.assign(new Error('expected exactly five indexes after apply'), {
        code: 'index_verify_count',
        found: verified.length,
      });
    }
    const byName = new Map(verified.map((v) => [v.name, v]));
    for (const spec of FIVE_INDEX_SPECS) {
      const row = byName.get(spec.indexName);
      if (!row) {
        throw Object.assign(new Error(`missing index after apply: ${spec.indexName}`), {
          code: 'index_missing_after_apply',
          indexName: spec.indexName,
        });
      }
      if (row.indisvalid !== true || row.indisready !== true) {
        throw Object.assign(new Error(`index ${spec.indexName} not valid/ready`), {
          code: 'index_not_ready',
          indexName: spec.indexName,
        });
      }
      if (normalizeSql(row.indexdef) !== normalizeSql(spec.expectedIndexdef)
        && !semanticIndexdefMatch(spec.expectedIndexdef, row.indexdef)) {
        throw Object.assign(new Error(`index ${spec.indexName} indexdef mismatch`), {
          code: 'indexdef_mismatch',
          indexName: spec.indexName,
        });
      }
    }
    indexVerification = verified.map((v) => {
      const spec = FIVE_INDEX_SPECS.find((s) => s.indexName === v.name);
      return {
        name: v.name,
        indisvalid: v.indisvalid,
        indisready: v.indisready,
        indexdefMatch: true,
        expectedIndexdef: spec ? spec.expectedIndexdef : null,
      };
    });
    afterIndexes = verified.map((v) => ({
      name: v.name,
      indisvalid: v.indisvalid,
      indisready: v.indisready,
    }));

    for (const table of UNIQUE_TABLES) {
      const countRes = await q(ROW_COUNT_SQL_BY_TABLE[table]);
      pushStep(`row_count_after_${table}`);
      const n = readRowCount(countRes);
      rowCountsAfter[table] = n;
      const before = rowCountsBefore[table];
      const approved = APPROVED_ROW_COUNT_BY_TABLE[table];
      if (n !== before || n !== approved) {
        throw Object.assign(
          new Error(`row count changed for ${table}: before=${before} after=${n} approved=${approved}`),
          { code: 'row_count_changed', table, before, after: n, approved },
        );
      }
    }

    await q('COMMIT');
    committed = true;
    pushStep('COMMIT');

    return redactDeep({
      ok: true,
      code: 'phase_d_five_index_apply_ok',
      steps: steps.slice(),
      authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
      beforeIndexes: beforeIndexes.map((b) => ({ name: b.name, present: false })),
      afterIndexes,
      indexVerification,
      rowCountsBefore: { ...rowCountsBefore },
      rowCountsAfter: { ...rowCountsAfter },
      schemaByTable,
      createStatementsSha256: hashes.createStatementsSha256,
      ownerMigrationSha256: hashes.ownerMigrationSha256,
      baselineMismatchCount: BASELINE_MISMATCH_COUNT,
      expectedRemainingMismatchCount: EXPECTED_REMAINING_MISMATCH_COUNT,
      expectedRemainingKeys: EXPECTED_REMAINING_KEYS.slice(),
      readOnly: false,
      mutates: true,
      schemaMutation: true,
      dataMutation: false,
      appliesIndexes: true,
      writesLedger: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      fiveIndexApplyLiveEnabled: PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED === true,
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
      'row_count_shape_error',
      'row_count_bound_mismatch',
      'row_count_changed',
      'index_preexisting',
      'semantic_duplicate_index',
      'incompatible_same_name_object',
      'index_verify_count',
      'index_missing_after_apply',
      'index_not_ready',
      'indexdef_mismatch',
      'create_index_hash_drift',
      'owner_migration_checksum_mismatch',
      'expected_schema_indexdef_missing',
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
      message: redactSecrets(String(err.message || 'five index apply failed'), secrets),
      steps: steps.slice(),
      rolledBack,
      committed: false,
      beforeIndexes,
      rowCountsBefore,
      mutates: false,
      schemaMutation: false,
      dataMutation: false,
      appliesIndexes: false,
      writesLedger: false,
      liveApplyEnabled: false,
      fiveIndexApplyLiveEnabled: PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED === true,
    }, secrets);
    throw Object.assign(new Error(safe.message), { code: safe.code, result: safe });
  }
}

function instantiateApplyPgClient(clientConfig, deps) {
  const d = deps || {};
  applyPgClientInstantiateCount += 1;
  let ClientCtor = d.Client;
  if (!ClientCtor) {
    if (PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED !== true) {
      throw Object.assign(new Error('five index apply live capability disabled'), {
        code: 'five_index_apply_capability_disabled',
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

function pickSafeFiveIndexApplyOutput(result) {
  const src = result || {};
  const out = {};
  for (const k of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return redactDeep(out, []);
}

function defaultVerifyRows() {
  return FIVE_INDEX_SPECS.map((s) => ({
    name: s.indexName,
    indisvalid: true,
    indisready: true,
    indisunique: false,
    am: 'btree',
    indexdef: s.expectedIndexdef,
  }));
}

/**
 * Scripted fake Client for offline 14Y proof — exact injected transaction sequence.
 */
function createScriptedFiveIndexApplyFakeClient(script) {
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
        || String(kind).startsWith('CREATE INDEX ')) {
        priorSteps.push(kind);
        return { rows: [], rowCount: 0 };
      }

      if (String(kind).startsWith('catalog_table_')) {
        priorSteps.push(kind);
        return responses.catalogTable || { rows: [{ '?column?': 1 }], rowCount: 1 };
      }

      if (String(kind).startsWith('catalog_columns_')) {
        priorSteps.push(kind);
        const table = kind.replace('catalog_columns_', '');
        const cols = [];
        const seen = new Set();
        for (const spec of FIVE_INDEX_SPECS) {
          if (spec.table !== table) continue;
          for (const c of spec.columns) {
            if (!seen.has(c)) {
              seen.add(c);
              cols.push(c);
            }
          }
        }
        const rows = (responses.catalogColumns && responses.catalogColumns[table])
          || cols.map((name) => ({ name, udt_name: 'text', is_nullable: true }));
        return { rows, rowCount: rows.length };
      }

      if (String(kind).startsWith('row_count_before_')
        || String(kind).startsWith('row_count_after_')) {
        priorSteps.push(kind);
        const table = kind
          .replace('row_count_before_', '')
          .replace('row_count_after_', '');
        const n = (responses.rowCounts && responses.rowCounts[table] != null)
          ? responses.rowCounts[table]
          : APPROVED_ROW_COUNT_BY_TABLE[table];
        return { rows: [{ table_total: n }], rowCount: 1 };
      }

      if (String(kind).startsWith('assert_index_absent_')) {
        priorSteps.push(kind);
        return responses.indexAbsence || { rows: [], rowCount: 0 };
      }

      if (String(kind).startsWith('assert_no_semantic_duplicate_')) {
        priorSteps.push(kind);
        return responses.tableIndexes || { rows: [], rowCount: 0 };
      }

      if (String(kind).startsWith('assert_no_incompatible_name_')) {
        priorSteps.push(kind);
        return responses.relkindLookup || { rows: [], rowCount: 0 };
      }

      if (kind === 'verify_indexes') {
        priorSteps.push(kind);
        const rows = responses.verifyIndexes || defaultVerifyRows();
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

function createScriptedFiveIndexApplyFakeClientFactory(script) {
  return function FakeClient() {
    return createScriptedFiveIndexApplyFakeClient(script);
  };
}

async function executePhaseDFiveIndexApply(opts) {
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
    return pickSafeFiveIndexApplyOutput({
      ok: false,
      code: 'caller_supplied_connect_forbidden',
      applyFiveIndexes: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      privateRefsZeroed: true,
    });
  }

  const gates = evaluateFiveIndexApplyGates({
    env: options.env,
    argv: options.argv || [],
  });
  if (!gates.ok) {
    return pickSafeFiveIndexApplyOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'five_index_apply_gates_rejected',
      errors: gates.errors,
      applyFiveIndexes: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      fiveIndexApplyLiveEnabled: PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED === true,
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
      return pickSafeFiveIndexApplyOutput({
        ok: false,
        code: loaded.code || 'managed_identity_loader_failed',
        errors: loaded.errors || [],
        applyFiveIndexes: false,
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
    return pickSafeFiveIndexApplyOutput({
      ok: false,
      code: e.code || 'credential_target_rejected',
      errors: e.errors || [{ code: e.code, message: e.message }],
      applyFiveIndexes: false,
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
      sequence = await runAuthorizedFiveIndexApplySequence(client, { secrets });
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
      code: sequence.code || 'phase_d_five_index_apply_ok',
      applyFiveIndexes: true,
      steps: sequence.steps,
      authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
      beforeIndexes: sequence.beforeIndexes,
      afterIndexes: sequence.afterIndexes,
      indexVerification: sequence.indexVerification,
      rowCountsBefore: sequence.rowCountsBefore,
      rowCountsAfter: sequence.rowCountsAfter,
      createStatementsSha256: sequence.createStatementsSha256,
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
      appliesIndexes: true,
      writesLedger: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      fiveIndexApplyLiveEnabled: true,
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
      beforeIndexes: result && result.beforeIndexes ? result.beforeIndexes : null,
      applyFiveIndexes: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      appliesIndexes: false,
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
      fiveIndexApplyLiveEnabled: true,
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

  return pickSafeFiveIndexApplyOutput(outcome);
}

function exactFiveIndexApplyArgv() {
  return [
    CLI_APPLY_FIVE_INDEXES,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function fiveIndexApplyEnv(extra) {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_FIVE_INDEX_APPLY]: '1',
    [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ...(extra || {}),
  };
}

function renderFiveIndexApplyUsage() {
  return [
    'phase-d:five-index-apply — FOUNDATION Slice 14Y',
    '',
    'Default: refused (zero pg Clients / zero HTTP).',
    '',
    'Required env:',
    `  ${ENV_LIVE_READONLY}=1`,
    `  ${ENV_LIVE_PREFLIGHT}=1`,
    `  ${ENV_FIVE_INDEX_APPLY}=1`,
    `  ${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `  AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
    '',
    'Required argv:',
    `  ${CLI_APPLY_FIVE_INDEXES}`,
    `  --subscription ${TARGETS.subscriptionId}`,
    `  --resource-group ${TARGETS.resourceGroup}`,
    `  --postgres-server ${TARGETS.postgresServer}`,
    `  --database ${TARGETS.database}`,
    `  ${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    '',
    'Applies exactly five residual indexes. No ledger/DML/DROP/CONCURRENTLY.',
  ].join('\n');
}

module.exports = {
  PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_FIVE_INDEX_APPLY,
  CLI_APPLY_FIVE_INDEXES,
  APPLICATION_NAME,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  LOCK_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  FIVE_INDEX_SPECS,
  UNIQUE_TABLES,
  APPROVED_ROW_COUNT_BY_TABLE,
  ROW_COUNT_SQL_BY_TABLE,
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
  INDEX_NAME_LOOKUP_SQL,
  TABLE_INDEXES_SQL,
  RELKIND_LOOKUP_SQL,
  SET_LOCK_TIMEOUT_SQL,
  SET_STATEMENT_TIMEOUT_SQL,
  SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL,
  ADVISORY_LOCK_SQL,
  evaluateFiveIndexApplyGates,
  executePhaseDFiveIndexApply,
  runAuthorizedFiveIndexApplySequence,
  createScriptedFiveIndexApplyFakeClient,
  createScriptedFiveIndexApplyFakeClientFactory,
  getFiveIndexApplyCounters,
  resetFiveIndexApplyCounters,
  pickSafeFiveIndexApplyOutput,
  exactFiveIndexApplyArgv,
  fiveIndexApplyEnv,
  renderFiveIndexApplyUsage,
  assertCreateIndexStatementsByteLocked,
  assertBaselineMismatch,
  authorizeApplySql,
  classifyApplyStep,
  normalizeIndexdef,
  semanticIndexdefMatch,
  buildApplyConnectConfig,
  buildApplyPgClientConfig,
};
