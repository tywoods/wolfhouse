'use strict';

/**
 * phase-d-surf-pack-trigger-apply — FOUNDATION Slice 14AA
 *
 * Default-disabled exact-gated managed-identity live adapter that applies
 * exactly ONE missing canonical trigger on Sunset staging `sunset_staging`:
 *   tenant_surf_pack_rules_updated_at
 *
 * No other objects. No DML/DROP/extra ALTER/index/function/
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

/** Capability flag for Slice 14AA — still default-disabled via env+argv gates. */
const PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED = true;

const ENV_SURF_PACK_TRIGGER_APPLY = 'SUNSET_PHASE_D_SURF_PACK_TRIGGER_APPLY';
const CLI_APPLY_SURF_PACK_TRIGGER = '--apply-surf-pack-trigger';

const APPLICATION_NAME = 'wh-sunset-surf-pack-trigger-apply';

/** Fixed transaction-scoped advisory lock (WHPA / SPTG — distinct from 14Z). */
const ADVISORY_LOCK_KEY1 = 0x57485041; // WHPA
const ADVISORY_LOCK_KEY2 = 0x53505447; // SPTG

const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 30000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60000;
const CONNECTION_TIMEOUT_MS = 20000;

const SCHEMA = 'public';

/** Post-14Z residual baseline (exactly 5 mismatches; 1 is this trigger). */
const BASELINE_MISMATCH_COUNT = 5;
const BASELINE_MISMATCH_SECTIONS = Object.freeze({
  triggers: 1,
  functions: 1,
  ownership: 1,
  acls: 1,
  extensions: 1,
});
const EXPECTED_REDUCTION = 1;
const EXPECTED_REMAINING_MISMATCH_COUNT = 4;
const EXPECTED_REMAINING_KEYS = Object.freeze([
  'function:public.fips_mode()',
  'function:public.fips_mode()',
  'pgcrypto',
  'public.fips_mode()',
]);

const TABLE = 'tenant_surf_pack_rules';
const TRIGGER_NAME = 'tenant_surf_pack_rules_updated_at';
const PRIOR_FK_NAME = 'tenant_surf_pack_rules_updated_by_fkey';
const PRIOR_INDEX_NAME = 'idx_tenant_surf_pack_client_loc';
const OBSERVER_KEY = 'tenant_surf_pack_rules.tenant_surf_pack_rules_updated_at';

const OWNER_MIGRATION = '026_tenant_surf_pack_rules';
const OWNER_MIGRATION_SHA256 = '8923551f385bda87e649b567fd47153ed94014029ac5138176beff7e58512496';
const APPROVED_ROW_COUNT = 36;

const EXPECTED_PRIOR_FK_CONDEF = 'FOREIGN KEY (updated_by) REFERENCES staff_users(id) ON DELETE SET NULL';

const CREATE_TRIGGER_SQL = 'CREATE TRIGGER tenant_surf_pack_rules_updated_at BEFORE UPDATE ON public.tenant_surf_pack_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at()';

const CREATE_TRIGGER_SHA256 = crypto.createHash('sha256').update(CREATE_TRIGGER_SQL, 'utf8').digest('hex');

const EXPECTED_TGDEF = CREATE_TRIGGER_SQL;

const EXPECTED_FUNCTION_IDENTITY = 'public.set_updated_at()';
const EXPECTED_FUNCTION_BODY = 'BEGIN NEW.updated_at = NOW(); RETURN NEW; END;';

const COLUMN_NAMES = Object.freeze(['updated_at', 'updated_by']);

const TRIGGER_SPEC = Object.freeze({
  triggerName: TRIGGER_NAME,
  table: TABLE,
  ownerMigration: OWNER_MIGRATION,
  ownerMigrationSha256: OWNER_MIGRATION_SHA256,
  key: OBSERVER_KEY,
  approvedRowCount: APPROVED_ROW_COUNT,
  createTriggerSql: CREATE_TRIGGER_SQL,
  createTriggerSqlSha256: CREATE_TRIGGER_SHA256,
  expectedTgdef: EXPECTED_TGDEF,
  priorFkName: PRIOR_FK_NAME,
  priorFkCondef: EXPECTED_PRIOR_FK_CONDEF,
  priorIndexName: PRIOR_INDEX_NAME,
  functionIdentity: EXPECTED_FUNCTION_IDENTITY,
});

const ROW_COUNT_SQL = 'SELECT count(*)::bigint AS table_total FROM public.tenant_surf_pack_rules';

const FUNCTION_PROBE_SQL = [
  'SELECT',
  "  n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS identity,",
  '  format_type(p.prorettype, NULL) AS rettype,',
  '  l.lanname AS lanname,',
  '  p.prosecdef AS prosecdef,',
  '  p.provolatile AS provolatile,',
  '  COALESCE(array_to_string(p.proconfig, \',\'), \'\') AS proconfig,',
  '  p.proisstrict AS proisstrict,',
  '  p.proleakproof AS proleakproof,',
  '  p.proparallel AS proparallel,',
  '  p.prosrc AS prosrc,',
  '  p.oid AS oid',
  'FROM pg_proc p',
  'JOIN pg_namespace n ON n.oid = p.pronamespace',
  'JOIN pg_language l ON l.oid = p.prolang',
  "WHERE n.nspname = 'public'",
  "  AND p.proname = 'set_updated_at'",
  "  AND pg_get_function_identity_arguments(p.oid) = ''",
].join('\n');

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

const INDEX_VERIFY_SQL = [
  'SELECT c.relname AS name, i.indisvalid, i.indisready',
  'FROM pg_class c',
  'JOIN pg_namespace n ON n.oid = c.relnamespace',
  'JOIN pg_index i ON i.indexrelid = c.oid',
  'WHERE n.nspname = $1 AND c.relname = $2',
  'ORDER BY c.relname',
].join('\n');

const TRIGGER_VERIFY_SQL = [
  'SELECT',
  '  t.tgname AS name,',
  '  t.tgenabled AS enabled,',
  '  t.tgisinternal AS is_internal,',
  '  t.tgtype AS tgtype,',
  '  pg_get_triggerdef(t.oid) AS tgdef,',
  "  nsp.nspname || '.' || pfn.proname || '(' || pg_get_function_identity_arguments(pfn.oid) || ')' AS fn_identity,",
  '  pfn.oid AS fn_oid,',
  '  format_type(pfn.prorettype, NULL) AS fn_rettype,',
  '  l.lanname AS fn_lang',
  'FROM pg_trigger t',
  'JOIN pg_class c ON c.oid = t.tgrelid',
  'JOIN pg_namespace n ON n.oid = c.relnamespace',
  'JOIN pg_proc pfn ON pfn.oid = t.tgfoid',
  'JOIN pg_namespace nsp ON nsp.oid = pfn.pronamespace',
  'JOIN pg_language l ON l.oid = pfn.prolang',
  'WHERE n.nspname = $1',
  '  AND c.relname = $2',
  '  AND t.tgname = $3',
  '  AND NOT t.tgisinternal',
].join('\n');

const TABLE_TRIGGERS_SQL = [
  'SELECT',
  '  t.tgname AS name,',
  '  t.tgtype AS tgtype,',
  "  nsp.nspname || '.' || pfn.proname || '(' || pg_get_function_identity_arguments(pfn.oid) || ')' AS fn_identity",
  'FROM pg_trigger t',
  'JOIN pg_class c ON c.oid = t.tgrelid',
  'JOIN pg_namespace n ON n.oid = c.relnamespace',
  'JOIN pg_proc pfn ON pfn.oid = t.tgfoid',
  'JOIN pg_namespace nsp ON nsp.oid = pfn.pronamespace',
  'WHERE n.nspname = $1',
  '  AND c.relname = $2',
  '  AND NOT t.tgisinternal',
  'ORDER BY t.tgname',
].join('\n');

const TRIGGER_NAME_LOOKUP_SQL = [
  'SELECT t.tgname AS name, c.relname AS table_name, n.nspname AS schema_name',
  'FROM pg_trigger t',
  'JOIN pg_class c ON c.oid = t.tgrelid',
  'JOIN pg_namespace n ON n.oid = c.relnamespace',
  'WHERE t.tgname = $1',
  '  AND NOT t.tgisinternal',
  'ORDER BY t.tgname',
].join('\n');

const AUTHORIZED_SEQUENCE = Object.freeze([
  'BEGIN',
  'SET LOCAL lock_timeout',
  'SET LOCAL statement_timeout',
  'SET LOCAL idle_in_transaction_session_timeout',
  'pg_advisory_xact_lock',
  'catalog_table_tenant_surf_pack_rules',
  'catalog_columns_tenant_surf_pack_rules',
  'row_count_before_tenant_surf_pack_rules',
  'assert_prior_fk_present',
  'assert_prior_index_present',
  'assert_set_updated_at_canonical',
  'assert_trigger_absent',
  'assert_no_semantic_duplicate_trigger',
  'assert_no_incompatible_same_name',
  'CREATE TRIGGER',
  'verify_trigger',
  'row_count_after_tenant_surf_pack_rules',
  'COMMIT',
]);

const SUCCESS_PATH_QUERY_COUNT = AUTHORIZED_SEQUENCE.length;

const SET_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`;
const SET_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`;
const SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL = `SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT_MS}ms'`;
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1, $2)';

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
  triggerName: TRIGGER_NAME,
  observerKey: OBSERVER_KEY,
  createTriggerSqlSha256: CREATE_TRIGGER_SHA256,
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
  CLI_APPLY_SURF_PACK_TRIGGER,
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
  'applySurfPackTrigger',
  'liveApplyEnabled',
  'surfPackTriggerApplyLiveEnabled',
  'liveHttpEnabled',
  'liveMutation',
  'schemaMutation',
  'dataMutation',
  'ledgerWritten',
  'appliesTrigger',
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
  'beforeTrigger',
  'afterTrigger',
  'triggerVerification',
  'functionProbe',
  'priorFk',
  'priorIndex',
  'rowCountsBefore',
  'rowCountsAfter',
  'capturedRowCount',
  'createTriggerSqlSha256',
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

function getSurfPackTriggerApplyCounters() {
  return {
    clientsInstantiated: applyPgClientInstantiateCount,
    queryCalls: applyQueryCallCount,
    httpRequestCount: getManagedIdentityHttpCounters().httpRequestCount,
    imdsRequestCount: getManagedIdentityHttpCounters().imdsRequestCount,
    keyVaultRequestCount: getManagedIdentityHttpCounters().keyVaultRequestCount,
  };
}

function resetSurfPackTriggerApplyCounters() {
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
    if (flag === CLI_APPLY_SURF_PACK_TRIGGER || flag === '--help' || flag === '-h') {
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

function evaluateSurfPackTriggerApplyGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const argv = Array.isArray(options.argv) ? options.argv.map(String) : [];
  const errors = [];

  if (PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED !== true) {
    errors.push({
      code: 'surf_pack_trigger_apply_capability_disabled',
      message: 'surf pack trigger apply capability is disabled',
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

  if (String(env[ENV_SURF_PACK_TRIGGER_APPLY] || '') !== '1') {
    errors.push({
      code: 'surf_pack_trigger_apply_env_required',
      message: `env ${ENV_SURF_PACK_TRIGGER_APPLY}=1 is required`,
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
  if (!parsed.flags.has(CLI_APPLY_SURF_PACK_TRIGGER)) {
    errors.push({
      code: 'surf_pack_trigger_apply_flag_required',
      message: `${CLI_APPLY_SURF_PACK_TRIGGER} is required`,
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
    applySurfPackTrigger: parsed.flags.has(CLI_APPLY_SURF_PACK_TRIGGER)
      && String(env[ENV_SURF_PACK_TRIGGER_APPLY] || '') === '1',
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

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeCondef(def) {
  return normalizeWhitespace(def).toLowerCase();
}

function condefMatchesExpected(liveDef, expected) {
  return normalizeCondef(liveDef) === normalizeCondef(expected);
}

function normalizeProsrc(prosrc) {
  return normalizeWhitespace(prosrc);
}

function tgdefMatchesExpected(liveDef) {
  return normalizeWhitespace(liveDef) === normalizeWhitespace(EXPECTED_TGDEF);
}

function semanticTriggerDuplicateMatch(row) {
  if (!row) return false;
  const tgtype = Number(row.tgtype);
  const fn = String(row.fn_identity || '');
  return tgtype === 19 && fn === EXPECTED_FUNCTION_IDENTITY;
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

function assertTriggerCreateStatementsByteLocked() {
  const createTriggerSqlSha256 = CREATE_TRIGGER_SHA256;
  const recomputed = crypto.createHash('sha256').update(CREATE_TRIGGER_SQL, 'utf8').digest('hex');
  if (recomputed !== CREATE_TRIGGER_SHA256) {
    throw Object.assign(new Error('CREATE TRIGGER sha256 drift'), {
      code: 'create_trigger_hash_drift',
    });
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
  if (!expectedRaw.includes(CREATE_TRIGGER_SQL)) {
    throw Object.assign(
      new Error('expected-product-schema missing exact trigger definition'),
      { code: 'expected_schema_triggerdef_missing' },
    );
  }

  return {
    createTriggerSqlSha256,
    ownerMigrationSha256: { [OWNER_MIGRATION]: OWNER_MIGRATION_SHA256 },
  };
}

function authorizeApplySql(sql) {
  const n = normalizeSql(sql);
  if (n === normalizeSql(CREATE_TRIGGER_SQL)) return CREATE_TRIGGER_SQL;

  const upper = n.toUpperCase();
  if (/\bCONCURRENTLY\b/.test(upper)
    || /\bDROP\b/.test(upper)
    || /(^|\s)DELETE\s+FROM\b/.test(upper)
    || /(^|\s)UPDATE\s+\S/.test(upper)
    || /(^|\s)INSERT\s+INTO\b/.test(upper)
    || /\bTRUNCATE\b/.test(upper)
    || /\bCREATE\s+TABLE\b/.test(upper)
    || /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/.test(upper)
    || /\bCREATE\s+EXTENSION\b/.test(upper)
    || /\bCREATE\s+INDEX\b/.test(upper)
    || /\bALTER\s+TABLE\b/.test(upper)) {
    throw Object.assign(
      new Error('unauthorized SQL rejected: DROP/DML/ALTER/CREATE INDEX/extra DDL forbidden'),
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
    FUNCTION_PROBE_SQL,
    CONSTRAINT_VERIFY_SQL,
    INDEX_VERIFY_SQL,
    TRIGGER_VERIFY_SQL,
    TABLE_TRIGGERS_SQL,
    TRIGGER_NAME_LOOKUP_SQL,
    ROW_COUNT_SQL,
    CREATE_TRIGGER_SQL,
  ];
  for (const a of allowed) {
    if (n === normalizeSql(a)) return a;
  }
  throw Object.assign(
    new Error('unauthorized SQL rejected: only locked Phase D surf-pack-trigger-apply SQL permitted'),
    { code: 'unauthorized_sql' },
  );
}

function classifyTriggerVerifyStep(params, priorSteps) {
  const tgname = params && params[2];
  if (tgname === TRIGGER_NAME) {
    if ((priorSteps || []).includes('CREATE TRIGGER')) {
      return 'verify_trigger';
    }
    return 'assert_trigger_absent';
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
  if (n === normalizeSql(CREATE_TRIGGER_SQL)) return 'CREATE TRIGGER';
  if (n === normalizeSql(ROW_COUNT_SQL)) {
    return (priorSteps || []).includes('CREATE TRIGGER')
      ? 'row_count_after_tenant_surf_pack_rules'
      : 'row_count_before_tenant_surf_pack_rules';
  }
  if (n === normalizeSql(FUNCTION_PROBE_SQL)) return 'assert_set_updated_at_canonical';
  if (n === normalizeSql(AUTHORIZED_TABLE_EXISTS_SQL)) {
    const table = params && params[1];
    return table === TABLE ? 'catalog_table_tenant_surf_pack_rules' : 'unauthorized';
  }
  if (n === normalizeSql(AUTHORIZED_COLUMN_CATALOG_SQL)) {
    const table = params && params[1];
    return table === TABLE ? 'catalog_columns_tenant_surf_pack_rules' : 'unauthorized';
  }
  if (n === normalizeSql(CONSTRAINT_VERIFY_SQL)) {
    const names = (params && params[2]) || [];
    const list = Array.isArray(names) ? names : [];
    if (list.length === 1 && list[0] === PRIOR_FK_NAME) {
      return 'assert_prior_fk_present';
    }
    return 'unauthorized';
  }
  if (n === normalizeSql(INDEX_VERIFY_SQL)) return 'assert_prior_index_present';
  if (n === normalizeSql(TRIGGER_VERIFY_SQL)) {
    return classifyTriggerVerifyStep(params, priorSteps);
  }
  if (n === normalizeSql(TABLE_TRIGGERS_SQL)) {
    return 'assert_no_semantic_duplicate_trigger';
  }
  if (n === normalizeSql(TRIGGER_NAME_LOOKUP_SQL)) {
    return 'assert_no_incompatible_same_name';
  }
  return 'unauthorized';
}

function validateColumnPresent(table, column, rows) {
  const row = (rows || []).find((r) => r.name === column);
  if (!row) {
    throw Object.assign(new Error(`missing column ${table}.${column}`), {
      code: 'column_missing',
      table,
      column,
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

function verifyFunctionRow(row) {
  if (!row) {
    throw Object.assign(new Error('missing function public.set_updated_at()'), {
      code: 'function_missing',
    });
  }
  const identity = String(row.identity || '');
  const rettype = String(row.rettype || '');
  const lanname = String(row.lanname || '');
  const prosecdef = row.prosecdef === true || row.prosecdef === 't';
  const provolatile = String(row.provolatile || '');
  const proconfig = String(row.proconfig || '');
  const proisstrict = row.proisstrict === true || row.proisstrict === 't';
  const proleakproof = row.proleakproof === true || row.proleakproof === 't';
  const proparallel = String(row.proparallel || '');
  const prosrc = normalizeProsrc(row.prosrc);
  const expectedBody = normalizeProsrc(EXPECTED_FUNCTION_BODY);

  if (identity !== EXPECTED_FUNCTION_IDENTITY) {
    throw Object.assign(new Error('function identity mismatch'), {
      code: 'function_identity_mismatch',
      got: identity,
    });
  }
  if (rettype !== 'trigger') {
    throw Object.assign(new Error('function rettype mismatch'), {
      code: 'function_rettype_mismatch',
      got: rettype,
    });
  }
  if (lanname !== 'plpgsql') {
    throw Object.assign(new Error('function language mismatch'), {
      code: 'function_language_mismatch',
      got: lanname,
    });
  }
  if (prosecdef !== false) {
    throw Object.assign(new Error('function must be INVOKER'), {
      code: 'function_prosecdef_mismatch',
    });
  }
  if (provolatile !== 'v') {
    throw Object.assign(new Error('function must be VOLATILE'), {
      code: 'function_provolatile_mismatch',
      got: provolatile,
    });
  }
  if (proconfig !== '') {
    throw Object.assign(new Error('function proconfig must be empty'), {
      code: 'function_proconfig_mismatch',
      got: proconfig,
    });
  }
  if (proisstrict !== false) {
    throw Object.assign(new Error('function must not be STRICT'), {
      code: 'function_proisstrict_mismatch',
    });
  }
  if (proleakproof !== false) {
    throw Object.assign(new Error('function must not be LEAKPROOF'), {
      code: 'function_proleakproof_mismatch',
    });
  }
  if (proparallel !== 'u') {
    throw Object.assign(new Error('function must be PARALLEL UNSAFE'), {
      code: 'function_proparallel_mismatch',
      got: proparallel,
    });
  }
  if (prosrc !== expectedBody) {
    throw Object.assign(new Error('function prosrc body mismatch'), {
      code: 'function_prosrc_mismatch',
      got: prosrc,
    });
  }
  return {
    identity,
    rettype,
    lanname,
    prosecdef: false,
    provolatile,
    proconfig,
    proisstrict: false,
    proleakproof: false,
    proparallel,
    prosrc: row.prosrc,
    oid: row.oid,
  };
}

function verifyTriggerRow(row, capturedFnOid) {
  if (!row) {
    throw Object.assign(new Error(`missing trigger ${TRIGGER_NAME}`), {
      code: 'trigger_missing',
    });
  }
  const isInternal = row.is_internal === true || row.is_internal === 't';
  if (isInternal) {
    throw Object.assign(new Error(`trigger ${TRIGGER_NAME} is internal`), {
      code: 'trigger_internal',
    });
  }
  const enabled = String(row.enabled || '');
  if (enabled !== 'O') {
    throw Object.assign(new Error(`trigger ${TRIGGER_NAME} not enabled`), {
      code: 'trigger_not_enabled',
      got: enabled,
    });
  }
  const tgtype = Number(row.tgtype);
  if (tgtype !== 19) {
    throw Object.assign(new Error(`trigger ${TRIGGER_NAME} tgtype mismatch`), {
      code: 'trigger_tgtype_mismatch',
      got: tgtype,
    });
  }
  if (!tgdefMatchesExpected(row.tgdef)) {
    throw Object.assign(new Error(`trigger ${TRIGGER_NAME} definition mismatch`), {
      code: 'trigger_definition_mismatch',
      got: row.tgdef,
    });
  }
  const fnIdentity = String(row.fn_identity || '');
  if (fnIdentity !== EXPECTED_FUNCTION_IDENTITY) {
    throw Object.assign(new Error(`trigger ${TRIGGER_NAME} fn identity mismatch`), {
      code: 'trigger_fn_identity_mismatch',
      got: fnIdentity,
    });
  }
  const fnOid = Number(row.fn_oid);
  if (capturedFnOid != null && fnOid !== Number(capturedFnOid)) {
    throw Object.assign(new Error(`trigger ${TRIGGER_NAME} fn oid mismatch`), {
      code: 'trigger_fn_oid_mismatch',
      got: fnOid,
      expected: capturedFnOid,
    });
  }
  const fnRettype = String(row.fn_rettype || '');
  if (fnRettype !== 'trigger') {
    throw Object.assign(new Error(`trigger ${TRIGGER_NAME} fn rettype mismatch`), {
      code: 'trigger_fn_rettype_mismatch',
      got: fnRettype,
    });
  }
  const fnLang = String(row.fn_lang || '');
  if (fnLang !== 'plpgsql') {
    throw Object.assign(new Error(`trigger ${TRIGGER_NAME} fn lang mismatch`), {
      code: 'trigger_fn_lang_mismatch',
      got: fnLang,
    });
  }
  if (String(row.name || '') !== TRIGGER_NAME) {
    throw Object.assign(new Error('trigger name mismatch'), {
      code: 'trigger_name_mismatch',
      got: row.name,
    });
  }
  return {
    name: row.name,
    enabled,
    is_internal: false,
    tgtype,
    tgdef: row.tgdef,
    fn_identity: fnIdentity,
    fn_oid: fnOid,
    fn_rettype: fnRettype,
    fn_lang: fnLang,
    tgdefMatch: true,
  };
}

async function runAuthorizedSurfPackTriggerApplySequence(client, opts) {
  const options = opts || {};
  const secrets = (options.secrets || []).filter(Boolean);
  const steps = [];
  let began = false;
  let committed = false;
  let rolledBack = false;
  let beforeTrigger = null;
  let afterTrigger = null;
  let triggerVerification = null;
  let functionProbe = null;
  let priorFk = null;
  let priorIndex = null;
  let capturedFnOid = null;
  const rowCountsBefore = {};
  const rowCountsAfter = {};
  let capturedRowCount = null;

  if (options.sql != null
    || options.query != null
    || options.host != null
    || options.database != null
    || options.dsn != null) {
    throw Object.assign(new Error('caller-supplied SQL / host / database / DSN forbidden'), {
      code: 'caller_supplied_query_forbidden',
    });
  }

  const hashes = assertTriggerCreateStatementsByteLocked();

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

    const colRes = await q(
      AUTHORIZED_COLUMN_CATALOG_SQL,
      [SCHEMA, TABLE, COLUMN_NAMES.slice()],
    );
    pushStep('catalog_columns_tenant_surf_pack_rules');
    for (const col of COLUMN_NAMES) {
      validateColumnPresent(TABLE, col, colRes.rows);
    }

    const countRes = await q(ROW_COUNT_SQL);
    pushStep('row_count_before_tenant_surf_pack_rules');
    const n = readRowCount(countRes);
    rowCountsBefore[TABLE] = n;
    capturedRowCount = n === APPROVED_ROW_COUNT ? APPROVED_ROW_COUNT : n;
    const rowBound = capturedRowCount;

    const fkRes = await q(
      CONSTRAINT_VERIFY_SQL,
      [SCHEMA, TABLE, [PRIOR_FK_NAME]],
    );
    pushStep('assert_prior_fk_present');
    const fkRow = (fkRes.rows || [])[0];
    if (!fkRow) {
      throw Object.assign(new Error(`prior FK ${PRIOR_FK_NAME} missing`), {
        code: 'prior_fk_missing',
      });
    }
    if (!condefMatchesExpected(fkRow.condef, EXPECTED_PRIOR_FK_CONDEF)) {
      throw Object.assign(new Error(`prior FK ${PRIOR_FK_NAME} condef mismatch`), {
        code: 'prior_fk_condef_mismatch',
        got: fkRow.condef,
      });
    }
    priorFk = {
      name: PRIOR_FK_NAME,
      present: true,
      condef: fkRow.condef,
    };

    const indexRes = await q(INDEX_VERIFY_SQL, [SCHEMA, PRIOR_INDEX_NAME]);
    pushStep('assert_prior_index_present');
    const indexRow = (indexRes.rows || [])[0];
    if (!indexRow) {
      throw Object.assign(new Error(`prior index ${PRIOR_INDEX_NAME} missing`), {
        code: 'prior_index_missing',
      });
    }
    const indisvalid = indexRow.indisvalid === true || indexRow.indisvalid === 't';
    if (!indisvalid) {
      throw Object.assign(new Error(`prior index ${PRIOR_INDEX_NAME} not valid`), {
        code: 'prior_index_not_valid',
      });
    }
    priorIndex = {
      name: PRIOR_INDEX_NAME,
      present: true,
      indisvalid: true,
    };

    const fnRes = await q(FUNCTION_PROBE_SQL);
    pushStep('assert_set_updated_at_canonical');
    functionProbe = verifyFunctionRow((fnRes.rows || [])[0]);
    capturedFnOid = functionProbe.oid;

    const absent = await q(
      TRIGGER_VERIFY_SQL,
      [SCHEMA, TABLE, TRIGGER_NAME],
    );
    pushStep('assert_trigger_absent');
    beforeTrigger = {
      name: TRIGGER_NAME,
      present: Boolean(absent && absent.rowCount > 0),
    };
    if (absent && absent.rowCount !== 0) {
      throw Object.assign(
        new Error(`preexisting trigger ${TRIGGER_NAME}`),
        { code: 'trigger_preexisting', triggerName: TRIGGER_NAME },
      );
    }

    const tableTriggers = await q(TABLE_TRIGGERS_SQL, [SCHEMA, TABLE]);
    pushStep('assert_no_semantic_duplicate_trigger');
    const dupes = (tableTriggers.rows || []).filter((r) =>
      r.name !== TRIGGER_NAME && semanticTriggerDuplicateMatch(r));
    if (dupes.length) {
      throw Object.assign(
        new Error(`semantic duplicate trigger for ${TRIGGER_NAME}`),
        {
          code: 'semantic_duplicate_trigger',
          found: dupes.map((d) => d.name),
        },
      );
    }

    const nameLookup = await q(TRIGGER_NAME_LOOKUP_SQL, [TRIGGER_NAME]);
    pushStep('assert_no_incompatible_same_name');
    if (nameLookup && nameLookup.rowCount > 0) {
      throw Object.assign(
        new Error(`incompatible same-name trigger ${TRIGGER_NAME}`),
        {
          code: 'incompatible_same_name_trigger',
          found: nameLookup.rows,
        },
      );
    }

    await q(CREATE_TRIGGER_SQL);
    pushStep('CREATE TRIGGER');

    const verifyRes = await q(
      TRIGGER_VERIFY_SQL,
      [SCHEMA, TABLE, TRIGGER_NAME],
    );
    pushStep('verify_trigger');
    const verifyRow = (verifyRes.rows || [])[0];
    const verified = verifyTriggerRow(verifyRow, capturedFnOid);
    afterTrigger = verified;
    triggerVerification = { final: verified };

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
      code: 'phase_d_surf_pack_trigger_apply_ok',
      steps: steps.slice(),
      authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
      beforeTrigger: { name: TRIGGER_NAME, present: false },
      afterTrigger,
      triggerVerification,
      functionProbe,
      priorFk,
      priorIndex,
      rowCountsBefore: { ...rowCountsBefore },
      rowCountsAfter: { ...rowCountsAfter },
      capturedRowCount,
      createTriggerSqlSha256: hashes.createTriggerSqlSha256,
      ownerMigrationSha256: hashes.ownerMigrationSha256,
      baselineMismatchCount: BASELINE_MISMATCH_COUNT,
      expectedRemainingMismatchCount: EXPECTED_REMAINING_MISMATCH_COUNT,
      expectedRemainingKeys: EXPECTED_REMAINING_KEYS.slice(),
      readOnly: false,
      mutates: true,
      schemaMutation: true,
      dataMutation: false,
      appliesTrigger: true,
      writesLedger: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      surfPackTriggerApplyLiveEnabled: PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED === true,
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
      'row_count_changed',
      'prior_fk_missing',
      'prior_fk_condef_mismatch',
      'prior_index_missing',
      'prior_index_not_valid',
      'function_missing',
      'function_identity_mismatch',
      'function_rettype_mismatch',
      'function_language_mismatch',
      'function_prosecdef_mismatch',
      'function_provolatile_mismatch',
      'function_proconfig_mismatch',
      'function_proisstrict_mismatch',
      'function_proleakproof_mismatch',
      'function_proparallel_mismatch',
      'function_prosrc_mismatch',
      'trigger_preexisting',
      'semantic_duplicate_trigger',
      'incompatible_same_name_trigger',
      'trigger_missing',
      'trigger_internal',
      'trigger_not_enabled',
      'trigger_tgtype_mismatch',
      'trigger_definition_mismatch',
      'trigger_fn_identity_mismatch',
      'trigger_fn_oid_mismatch',
      'trigger_fn_rettype_mismatch',
      'trigger_fn_lang_mismatch',
      'trigger_name_mismatch',
      'create_trigger_hash_drift',
      'owner_migration_checksum_mismatch',
      'expected_schema_triggerdef_missing',
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
      message: redactSecrets(String(err.message || 'surf pack trigger apply failed'), secrets),
      steps: steps.slice(),
      rolledBack,
      committed: false,
      beforeTrigger,
      rowCountsBefore,
      functionProbe,
      priorFk,
      priorIndex,
      mutates: false,
      schemaMutation: false,
      dataMutation: false,
      appliesTrigger: false,
      writesLedger: false,
      liveApplyEnabled: false,
      surfPackTriggerApplyLiveEnabled: PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED === true,
    }, secrets);
    throw Object.assign(new Error(safe.message), { code: safe.code, result: safe });
  }
}

function instantiateApplyPgClient(clientConfig, deps) {
  const d = deps || {};
  applyPgClientInstantiateCount += 1;
  let ClientCtor = d.Client;
  if (!ClientCtor) {
    if (PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED !== true) {
      throw Object.assign(new Error('surf pack trigger apply live capability disabled'), {
        code: 'surf_pack_trigger_apply_capability_disabled',
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

function pickSafeSurfPackTriggerApplyOutput(result) {
  const src = result || {};
  const out = {};
  for (const k of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return redactDeep(out, []);
}

function defaultFunctionProbeRow() {
  return {
    identity: EXPECTED_FUNCTION_IDENTITY,
    rettype: 'trigger',
    lanname: 'plpgsql',
    prosecdef: false,
    provolatile: 'v',
    proconfig: '',
    proisstrict: false,
    proleakproof: false,
    proparallel: 'u',
    prosrc: 'BEGIN\n NEW.updated_at = NOW();\n RETURN NEW;\nEND;\n',
    oid: 12345,
  };
}

function defaultPriorFkRows() {
  return [{
    name: PRIOR_FK_NAME,
    contype: 'f',
    convalidated: true,
    condef: EXPECTED_PRIOR_FK_CONDEF,
  }];
}

function defaultPriorIndexRows() {
  return [{
    name: PRIOR_INDEX_NAME,
    indisvalid: true,
    indisready: true,
  }];
}

function defaultVerifyRowsAfterCreate(fnOid) {
  return [{
    name: TRIGGER_NAME,
    enabled: 'O',
    is_internal: false,
    tgtype: 19,
    tgdef: EXPECTED_TGDEF,
    fn_identity: EXPECTED_FUNCTION_IDENTITY,
    fn_oid: fnOid != null ? fnOid : 12345,
    fn_rettype: 'trigger',
    fn_lang: 'plpgsql',
  }];
}

function createScriptedSurfPackTriggerApplyFakeClient(script) {
  const s = script || {};
  const expected = (s.expectedSteps || AUTHORIZED_SEQUENCE).slice();
  const calls = [];
  let stepIndex = 0;
  let connected = false;
  let ended = false;
  const responses = s.responses || {};
  const priorSteps = [];
  const defaultFn = responses.functionProbe || defaultFunctionProbeRow();
  const defaultFnOid = defaultFn.oid;

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
        || kind === 'CREATE TRIGGER') {
        priorSteps.push(kind);
        return { rows: [], rowCount: 0 };
      }

      if (kind === 'catalog_table_tenant_surf_pack_rules') {
        priorSteps.push(kind);
        return responses.catalogTable || { rows: [{ '?column?': 1 }], rowCount: 1 };
      }

      if (kind === 'catalog_columns_tenant_surf_pack_rules') {
        priorSteps.push(kind);
        const rows = responses.catalogColumns
          || COLUMN_NAMES.map((name) => ({ name, udt_name: name === 'updated_by' ? 'uuid' : 'timestamptz', is_nullable: true }));
        return { rows, rowCount: rows.length };
      }

      if (kind === 'row_count_before_tenant_surf_pack_rules'
        || kind === 'row_count_after_tenant_surf_pack_rules') {
        priorSteps.push(kind);
        const before = (responses.rowCount != null)
          ? responses.rowCount
          : APPROVED_ROW_COUNT;
        const after = (responses.rowCountAfter != null)
          ? responses.rowCountAfter
          : before;
        const total = kind === 'row_count_after_tenant_surf_pack_rules' ? after : before;
        return { rows: [{ table_total: total }], rowCount: 1 };
      }

      if (kind === 'assert_prior_fk_present') {
        priorSteps.push(kind);
        const rows = responses.priorFk || defaultPriorFkRows();
        return { rows, rowCount: rows.length };
      }

      if (kind === 'assert_prior_index_present') {
        priorSteps.push(kind);
        const rows = responses.priorIndex || defaultPriorIndexRows();
        return { rows, rowCount: rows.length };
      }

      if (kind === 'assert_set_updated_at_canonical') {
        priorSteps.push(kind);
        const rows = [defaultFn];
        return { rows, rowCount: 1 };
      }

      if (kind === 'assert_trigger_absent') {
        priorSteps.push(kind);
        return responses.triggerAbsence || { rows: [], rowCount: 0 };
      }

      if (kind === 'assert_no_semantic_duplicate_trigger') {
        priorSteps.push(kind);
        return responses.tableTriggers || { rows: [], rowCount: 0 };
      }

      if (kind === 'assert_no_incompatible_same_name') {
        priorSteps.push(kind);
        return responses.triggerNameLookup || { rows: [], rowCount: 0 };
      }

      if (kind === 'verify_trigger') {
        priorSteps.push(kind);
        const rows = responses.verifyAfterCreate
          || defaultVerifyRowsAfterCreate(defaultFnOid);
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

function createScriptedSurfPackTriggerApplyFakeClientFactory(script) {
  return function FakeClient() {
    return createScriptedSurfPackTriggerApplyFakeClient(script);
  };
}

async function executePhaseDSurfPackTriggerApply(opts) {
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
    return pickSafeSurfPackTriggerApplyOutput({
      ok: false,
      code: 'caller_supplied_connect_forbidden',
      applySurfPackTrigger: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      privateRefsZeroed: true,
    });
  }

  const gates = evaluateSurfPackTriggerApplyGates({
    env: options.env,
    argv: options.argv || [],
  });
  if (!gates.ok) {
    return pickSafeSurfPackTriggerApplyOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'surf_pack_trigger_apply_gates_rejected',
      errors: gates.errors,
      applySurfPackTrigger: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      surfPackTriggerApplyLiveEnabled: PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED === true,
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
      return pickSafeSurfPackTriggerApplyOutput({
        ok: false,
        code: loaded.code || 'managed_identity_loader_failed',
        errors: loaded.errors || [],
        applySurfPackTrigger: false,
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
    return pickSafeSurfPackTriggerApplyOutput({
      ok: false,
      code: e.code || 'credential_target_rejected',
      errors: e.errors || [{ code: e.code, message: e.message }],
      applySurfPackTrigger: false,
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
      sequence = await runAuthorizedSurfPackTriggerApplySequence(client, { secrets });
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
      code: sequence.code || 'phase_d_surf_pack_trigger_apply_ok',
      applySurfPackTrigger: true,
      steps: sequence.steps,
      authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
      beforeTrigger: sequence.beforeTrigger,
      afterTrigger: sequence.afterTrigger,
      triggerVerification: sequence.triggerVerification,
      functionProbe: sequence.functionProbe,
      priorFk: sequence.priorFk,
      priorIndex: sequence.priorIndex,
      rowCountsBefore: sequence.rowCountsBefore,
      rowCountsAfter: sequence.rowCountsAfter,
      capturedRowCount: sequence.capturedRowCount,
      createTriggerSqlSha256: sequence.createTriggerSqlSha256,
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
      appliesTrigger: true,
      writesLedger: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      surfPackTriggerApplyLiveEnabled: true,
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
      beforeTrigger: result && result.beforeTrigger ? result.beforeTrigger : null,
      functionProbe: result && result.functionProbe ? result.functionProbe : null,
      priorFk: result && result.priorFk ? result.priorFk : null,
      priorIndex: result && result.priorIndex ? result.priorIndex : null,
      applySurfPackTrigger: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      appliesTrigger: false,
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
      surfPackTriggerApplyLiveEnabled: true,
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

  return pickSafeSurfPackTriggerApplyOutput(outcome);
}

function exactSurfPackTriggerApplyArgv() {
  return [
    CLI_APPLY_SURF_PACK_TRIGGER,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function surfPackTriggerApplyEnv(extra) {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_SURF_PACK_TRIGGER_APPLY]: '1',
    [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ...(extra || {}),
  };
}

function renderSurfPackTriggerApplyUsage() {
  return [
    'phase-d:surf-pack-trigger-apply — FOUNDATION Slice 14AA',
    '',
    'Default: refused (zero pg Clients / zero HTTP).',
    '',
    'Required env:',
    `  ${ENV_LIVE_READONLY}=1`,
    `  ${ENV_LIVE_PREFLIGHT}=1`,
    `  ${ENV_SURF_PACK_TRIGGER_APPLY}=1`,
    `  ${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `  AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
    '',
    'Required argv:',
    `  ${CLI_APPLY_SURF_PACK_TRIGGER}`,
    `  --subscription ${TARGETS.subscriptionId}`,
    `  --resource-group ${TARGETS.resourceGroup}`,
    `  --postgres-server ${TARGETS.postgresServer}`,
    `  --database ${TARGETS.database}`,
    `  ${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    '',
    'Applies exactly one residual trigger. No ledger/DML/DROP.',
  ].join('\n');
}

module.exports = {
  PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_SURF_PACK_TRIGGER_APPLY,
  CLI_APPLY_SURF_PACK_TRIGGER,
  APPLICATION_NAME,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  LOCK_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  TRIGGER_SPEC,
  TABLE,
  TRIGGER_NAME,
  OBSERVER_KEY,
  APPROVED_ROW_COUNT,
  CREATE_TRIGGER_SQL,
  CREATE_TRIGGER_SHA256,
  EXPECTED_TGDEF,
  EXPECTED_FUNCTION_IDENTITY,
  EXPECTED_FUNCTION_BODY,
  PRIOR_FK_NAME,
  PRIOR_INDEX_NAME,
  EXPECTED_PRIOR_FK_CONDEF,
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
  FUNCTION_PROBE_SQL,
  CONSTRAINT_VERIFY_SQL,
  INDEX_VERIFY_SQL,
  TRIGGER_VERIFY_SQL,
  TABLE_TRIGGERS_SQL,
  TRIGGER_NAME_LOOKUP_SQL,
  SET_LOCK_TIMEOUT_SQL,
  SET_STATEMENT_TIMEOUT_SQL,
  SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL,
  ADVISORY_LOCK_SQL,
  evaluateSurfPackTriggerApplyGates,
  executePhaseDSurfPackTriggerApply,
  runAuthorizedSurfPackTriggerApplySequence,
  createScriptedSurfPackTriggerApplyFakeClient,
  createScriptedSurfPackTriggerApplyFakeClientFactory,
  getSurfPackTriggerApplyCounters,
  resetSurfPackTriggerApplyCounters,
  pickSafeSurfPackTriggerApplyOutput,
  exactSurfPackTriggerApplyArgv,
  surfPackTriggerApplyEnv,
  renderSurfPackTriggerApplyUsage,
  assertTriggerCreateStatementsByteLocked,
  assertBaselineMismatch,
  authorizeApplySql,
  classifyApplyStep,
  normalizeCondef,
  normalizeProsrc,
  tgdefMatchesExpected,
  semanticTriggerDuplicateMatch,
  buildApplyConnectConfig,
  buildApplyPgClientConfig,
  defaultFunctionProbeRow,
  defaultVerifyRowsAfterCreate,
};
