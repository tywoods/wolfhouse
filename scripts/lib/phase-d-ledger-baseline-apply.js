'use strict';

/**
 * phase-d-ledger-baseline-apply — FOUNDATION Slice 14AD
 *
 * Default-disabled exact-gated managed-identity live adapter that creates the
 * provenance-aware schema_migration_ledger on Sunset staging and atomically
 * records exactly the 39 Slice-14AC-proven baseline rows.
 *
 * No migration SQL execution. No product DDL/DML. No KV/RBAC/network/deploy.
 * On any error ROLLBACK, no retry.
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
const {
  MIGRATIONS_DIR,
  MANIFEST_PATH,
  LEDGER_DDL,
  LEDGER_LEGACY_UPGRADE_DDL,
  LEDGER_TIMESTAMP_SEMANTICS,
  LEDGER_SELECT_COLUMNS,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  APPLY_KINDS,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  reconcileLedger,
  buildExecutedByCanonicalRunnerProvenance,
} = require('./migration-integrity');

/** Capability flag for Slice 14AD — still default-disabled via env+argv gates. */
const PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED = true;

const ENV_LEDGER_BASELINE_APPLY = 'SUNSET_PHASE_D_LEDGER_BASELINE_APPLY';
const CLI_APPLY_LEDGER_BASELINE = '--apply-ledger-baseline';

const APPLICATION_NAME = 'wh-sunset-ledger-baseline-apply';

const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 30000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60000;
const CONNECTION_TIMEOUT_MS = 20000;

const BASELINE_ROW_COUNT = 39;
const STRUCTURAL_BASELINE_COUNT = 34;
const CURRENT_STATE_BASELINE_COUNT = 5;

const MASTER_SHA_BASIS = 'd6834dbbecc2aa0a8b0ecbdfa2ad1402210a6657';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const PROPOSED_LEDGER_ROWS_SHA256 = 'c136abccd8d61b723fddc61b1971b4553b0256306bbe546c01d672a63e1e5226';
const SLICE14AC_EVIDENCE_FILE_SHA256 = '45219e7b6738d847f9dc066db27b92caf271e0ee305e7c6e643f27519033ff96';

const SLICE14AC_EVIDENCE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'sunset-schema-observer',
  'slice14ac-ledger-eligibility-matrix-evidence.json',
);

const SET_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`;
const SET_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`;
const SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL = `SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT_MS}ms'`;
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1, $2)';

const LEDGER_ABSENT_SQL = [
  'SELECT COUNT(*)::int AS cnt',
  'FROM information_schema.tables t',
  "WHERE t.table_schema = 'public'",
  "  AND t.table_name = 'schema_migration_ledger'",
].join('\n');

const LEDGER_RELKIND_SQL = [
  'SELECT c.relkind, c.relname, n.nspname AS schema_name',
  'FROM pg_catalog.pg_class c',
  'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
  "WHERE n.nspname = 'public'",
  "  AND c.relname = 'schema_migration_ledger'",
].join('\n');

const LEDGER_COLUMNS_SQL = [
  'SELECT column_name',
  'FROM information_schema.columns',
  "WHERE table_schema = 'public'",
  "  AND table_name = 'schema_migration_ledger'",
  'ORDER BY ordinal_position',
].join('\n');

const LEDGER_TXN_TS_SQL = 'SELECT NOW() AS ledger_txn_ts';

const LEDGER_INSERT_SQL = [
  'INSERT INTO schema_migration_ledger (',
  '  id, filename, checksum_sha256, apply_order,',
  '  apply_kind, checksum_mode, evidence_ref, provenance_notes,',
  '  applied_at, ledger_recorded_at',
  ') VALUES (',
  '  $1, $2, $3, $4,',
  '  $5, $6, $7, $8,',
  '  $9, $9',
  ')',
].join('\n');

const LEDGER_COUNT_SQL = 'SELECT count(*)::int AS cnt FROM schema_migration_ledger';

const LEDGER_SELECT_ALL_SQL = [
  'SELECT',
  `  ${LEDGER_SELECT_COLUMNS.join(', ')}`,
  'FROM schema_migration_ledger',
  'ORDER BY apply_order ASC',
].join('\n');

const LEDGER_TIMESTAMP_UNIFORMITY_SQL = [
  'SELECT',
  '  count(DISTINCT applied_at)::int AS distinct_applied,',
  '  count(DISTINCT ledger_recorded_at)::int AS distinct_recorded,',
  '  min(applied_at) AS min_applied,',
  '  max(applied_at) AS max_applied',
  'FROM schema_migration_ledger',
].join('\n');

const LEDGER_KIND_COUNTS_SQL = [
  'SELECT apply_kind, count(*)::int AS cnt',
  'FROM schema_migration_ledger',
  'GROUP BY apply_kind',
  'ORDER BY apply_kind',
].join('\n');

const REQUIRED_LEDGER_COLUMNS = Object.freeze([
  'id',
  'filename',
  'checksum_sha256',
  'apply_order',
  'applied_at',
  'apply_kind',
  'checksum_mode',
  'evidence_ref',
  'provenance_notes',
  'ledger_recorded_at',
]);

const PREFIX_SEQUENCE = Object.freeze([
  'BEGIN',
  'SET LOCAL lock_timeout',
  'SET LOCAL statement_timeout',
  'SET LOCAL idle_in_transaction_session_timeout',
  'pg_advisory_xact_lock',
  'assert_ledger_absent',
  'assert_no_incompatible_ledger_relation',
  'assert_no_incompatible_ledger_columns',
  'create_ledger_ddl',
  'capture_ledger_txn_ts',
]);

const SUFFIX_SEQUENCE = Object.freeze([
  'verify_ledger_count',
  'verify_ledger_rows',
  'verify_ledger_timestamps',
  'verify_ledger_kind_counts',
  'COMMIT',
]);

function buildAuthorizedSequence(rowCount) {
  const n = Number(rowCount) || BASELINE_ROW_COUNT;
  return [
    ...PREFIX_SEQUENCE,
    ...Array(n).fill('insert_ledger_row'),
    ...SUFFIX_SEQUENCE,
  ];
}

const AUTHORIZED_SEQUENCE = buildAuthorizedSequence(BASELINE_ROW_COUNT);
const SUCCESS_PATH_QUERY_COUNT = AUTHORIZED_SEQUENCE.length;

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
  baselineRowCount: BASELINE_ROW_COUNT,
  structuralBaselineCount: STRUCTURAL_BASELINE_COUNT,
  currentStateBaselineCount: CURRENT_STATE_BASELINE_COUNT,
  proposedLedgerRowsSha256: PROPOSED_LEDGER_ROWS_SHA256,
  slice14acEvidenceFileSha256: SLICE14AC_EVIDENCE_FILE_SHA256,
  masterShaBasis: MASTER_SHA_BASIS,
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
  '--repair',
  '--dml',
  '--concurrently',
  '--alter',
  '--truncate',
  '--migrate',
  '--run-migrations',
]);

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_APPLY_LEDGER_BASELINE,
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
  'applyLedgerBaseline',
  'liveApplyEnabled',
  'ledgerBaselineApplyLiveEnabled',
  'liveHttpEnabled',
  'liveMutation',
  'schemaMutation',
  'dataMutation',
  'ledgerWritten',
  'writesLedger',
  'executesMigrations',
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
  'baselineRowCount',
  'structuralBaselineCount',
  'currentStateBaselineCount',
  'proposedLedgerRowsSha256',
  'ledgerTxnTs',
  'insertedRowCount',
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
  'timestampSemantics',
]);

let applyPgClientInstantiateCount = 0;
let applyQueryCallCount = 0;

function getLedgerBaselineApplyCounters() {
  return {
    clientsInstantiated: applyPgClientInstantiateCount,
    queryCalls: applyQueryCallCount,
    httpRequestCount: getManagedIdentityHttpCounters().httpRequestCount,
    imdsRequestCount: getManagedIdentityHttpCounters().imdsRequestCount,
    keyVaultRequestCount: getManagedIdentityHttpCounters().keyVaultRequestCount,
  };
}

function resetLedgerBaselineApplyCounters() {
  applyPgClientInstantiateCount = 0;
  applyQueryCallCount = 0;
}

function hashProposedLedgerRows(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function loadSlice14acEvidence() {
  const raw = fs.readFileSync(SLICE14AC_EVIDENCE_PATH, 'utf8');
  const fileSha = crypto.createHash('sha256').update(raw).digest('hex');
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed.proposedLedgerRows) ? parsed.proposedLedgerRows : [];
  return { raw, fileSha, parsed, rows };
}

function validateProposedLedgerRows(rows) {
  if (!Array.isArray(rows) || rows.length !== BASELINE_ROW_COUNT) {
    throw Object.assign(new Error(`expected ${BASELINE_ROW_COUNT} proposed rows`), {
      code: 'proposed_ledger_row_count_drift',
      got: Array.isArray(rows) ? rows.length : 0,
    });
  }
  let structural = 0;
  let currentState = 0;
  for (const row of rows) {
    if (row.apply_kind === APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE) structural += 1;
    if (row.apply_kind === APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE) currentState += 1;
    if (row.apply_kind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER) {
      throw Object.assign(new Error(`proposed row ${row.id} mislabels executed_by_canonical_runner`), {
        code: 'mislabel_executed_runner',
        id: row.id,
      });
    }
    if (!APPLY_KINDS.includes(row.apply_kind)) {
      throw Object.assign(new Error(`proposed row ${row.id} unknown apply_kind`), {
        code: 'unknown_apply_kind',
        id: row.id,
      });
    }
    if (row.checksum_mode !== CHECKSUM_MODE_CANONICAL_LF_V1) {
      throw Object.assign(new Error(`proposed row ${row.id} checksum_mode drift`), {
        code: 'checksum_mode_drift',
        id: row.id,
      });
    }
  }
  if (structural !== STRUCTURAL_BASELINE_COUNT || currentState !== CURRENT_STATE_BASELINE_COUNT) {
    throw Object.assign(new Error('baseline kind counts drift'), {
      code: 'baseline_kind_count_drift',
      structural,
      currentState,
    });
  }
  for (let i = 0; i < rows.length; i += 1) {
    if (Number(rows[i].apply_order) !== i + 1) {
      throw Object.assign(new Error(`non-contiguous apply_order at index ${i}`), {
        code: 'ledger_order_drift',
      });
    }
  }
  const rowsSha = hashProposedLedgerRows(rows);
  if (rowsSha !== PROPOSED_LEDGER_ROWS_SHA256) {
    throw Object.assign(new Error('proposedLedgerRows canonical sha256 drift'), {
      code: 'proposed_ledger_rows_hash_drift',
      got: rowsSha,
    });
  }
  return {
    rows: rows.slice(),
    rowsSha,
    structuralBaselineCount: structural,
    currentStateBaselineCount: currentState,
  };
}

function assertSlice14acEvidenceByteLocked() {
  const { fileSha, rows } = loadSlice14acEvidence();
  if (fileSha !== SLICE14AC_EVIDENCE_FILE_SHA256) {
    throw Object.assign(new Error('Slice 14AC evidence file sha256 drift'), {
      code: 'slice14ac_evidence_file_hash_drift',
      got: fileSha,
    });
  }
  const validated = validateProposedLedgerRows(rows);
  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) {
    throw Object.assign(new Error('manifest integrity failed'), { code: 'manifest_integrity_failed' });
  }
  const forward = forwardEntries(manifest);
  if (forward.length !== BASELINE_ROW_COUNT) {
    throw Object.assign(new Error('forward count drift'), { code: 'forward_count_drift' });
  }
  return {
    rows: validated.rows,
    rowsSha: validated.rowsSha,
    fileSha,
    structuralBaselineCount: validated.structuralBaselineCount,
    currentStateBaselineCount: validated.currentStateBaselineCount,
    forward,
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
    if (flag === CLI_APPLY_LEDGER_BASELINE || flag === '--help' || flag === '-h') {
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

function evaluateLedgerBaselineApplyGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const argv = Array.isArray(options.argv) ? options.argv.map(String) : [];
  const errors = [];

  if (PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED !== true) {
    errors.push({
      code: 'ledger_baseline_apply_capability_disabled',
      message: 'ledger baseline apply capability is disabled',
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

  if (String(env[ENV_LEDGER_BASELINE_APPLY] || '') !== '1') {
    errors.push({
      code: 'ledger_baseline_apply_env_required',
      message: `env ${ENV_LEDGER_BASELINE_APPLY}=1 is required`,
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
  if (!parsed.flags.has(CLI_APPLY_LEDGER_BASELINE)) {
    errors.push({
      code: 'ledger_baseline_apply_flag_required',
      message: `${CLI_APPLY_LEDGER_BASELINE} is required`,
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
    applyLedgerBaseline: parsed.flags.has(CLI_APPLY_LEDGER_BASELINE)
      && String(env[ENV_LEDGER_BASELINE_APPLY] || '') === '1',
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

function normalizeLedgerDdl() {
  return String(LEDGER_DDL || '').trim();
}

function authorizeApplySql(sql) {
  const n = normalizeSql(sql);
  const ledgerDdl = normalizeSql(normalizeLedgerDdl());

  if (n === ledgerDdl) return normalizeLedgerDdl();

  const upper = n.toUpperCase();
  if (/\bCONCURRENTLY\b/.test(upper)
    || /\bDROP\b/.test(upper)
    || /(^|\s)DELETE\s+FROM\b/.test(upper)
    || /(^|\s)UPDATE\s+\S/.test(upper)
    || /\bTRUNCATE\b/.test(upper)
    || /\bALTER\s+TABLE\b/.test(upper)
    || /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/.test(upper)
    || /\bCREATE\s+EXTENSION\b/.test(upper)
    || /\bCREATE\s+TRIGGER\b/.test(upper)
    || (/\bCREATE\s+TABLE\b/.test(upper) && n !== ledgerDdl)
    || (/\bCREATE\s+INDEX\b/.test(upper) && n !== ledgerDdl)) {
    throw Object.assign(
      new Error('unauthorized SQL rejected: DROP/DML/extra DDL/migration SQL forbidden'),
      { code: 'unauthorized_sql' },
    );
  }

  if (/(^|\s)INSERT\s+INTO\s+(?!schema_migration_ledger\b)/i.test(n)) {
    throw Object.assign(new Error('unauthorized SQL rejected: only ledger INSERT permitted'), {
      code: 'unauthorized_sql',
    });
  }

  const allowed = [
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    SET_LOCK_TIMEOUT_SQL,
    SET_STATEMENT_TIMEOUT_SQL,
    SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL,
    ADVISORY_LOCK_SQL,
    LEDGER_ABSENT_SQL,
    LEDGER_RELKIND_SQL,
    LEDGER_COLUMNS_SQL,
    LEDGER_TXN_TS_SQL,
    LEDGER_INSERT_SQL,
    LEDGER_COUNT_SQL,
    LEDGER_SELECT_ALL_SQL,
    LEDGER_TIMESTAMP_UNIFORMITY_SQL,
    LEDGER_KIND_COUNTS_SQL,
    normalizeLedgerDdl(),
  ];
  for (const a of allowed) {
    if (n === normalizeSql(a)) return a;
  }
  throw Object.assign(
    new Error('unauthorized SQL rejected: only locked Phase D ledger-baseline-apply SQL permitted'),
    { code: 'unauthorized_sql' },
  );
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
  if (n === normalizeSql(LEDGER_ABSENT_SQL)) return 'assert_ledger_absent';
  if (n === normalizeSql(LEDGER_RELKIND_SQL)) return 'assert_no_incompatible_ledger_relation';
  if (n === normalizeSql(LEDGER_COLUMNS_SQL)) return 'assert_no_incompatible_ledger_columns';
  if (n === normalizeSql(normalizeLedgerDdl())) return 'create_ledger_ddl';
  if (n === normalizeSql(LEDGER_TXN_TS_SQL)) return 'capture_ledger_txn_ts';
  if (n === normalizeSql(LEDGER_INSERT_SQL)) return 'insert_ledger_row';
  if (n === normalizeSql(LEDGER_COUNT_SQL)) return 'verify_ledger_count';
  if (n === normalizeSql(LEDGER_SELECT_ALL_SQL)) return 'verify_ledger_rows';
  if (n === normalizeSql(LEDGER_TIMESTAMP_UNIFORMITY_SQL)) return 'verify_ledger_timestamps';
  if (n === normalizeSql(LEDGER_KIND_COUNTS_SQL)) return 'verify_ledger_kind_counts';
  return 'unauthorized';
}

function assertLedgerAbsent(rows) {
  const cnt = Number((rows && rows[0] && rows[0].cnt) || 0);
  if (cnt > 0) {
    throw Object.assign(new Error('schema_migration_ledger already present'), {
      code: 'ledger_preexisting',
    });
  }
}

function assertNoIncompatibleLedgerRelation(relRows, colRows) {
  const rel = (relRows || [])[0];
  if (!rel) return;
  const relkind = String(rel.relkind || '');
  if (relkind && relkind !== 'r') {
    throw Object.assign(new Error('schema_migration_ledger exists with incompatible relkind'), {
      code: 'incompatible_ledger_relation',
      relkind,
    });
  }
  const cols = new Set((colRows || []).map((r) => r.column_name));
  for (const need of REQUIRED_LEDGER_COLUMNS) {
    if (cols.size > 0 && !cols.has(need)) {
      throw Object.assign(new Error(`schema_migration_ledger missing column ${need}`), {
        code: 'incompatible_ledger_relation',
        missing: need,
      });
    }
  }
  if (rel) {
    throw Object.assign(new Error('schema_migration_ledger already present'), {
      code: 'ledger_preexisting',
    });
  }
}

function verifyInsertedLedgerRows(selectedRows, proposedRows, ledgerTxnTs, forward) {
  if (!Array.isArray(selectedRows) || selectedRows.length !== proposedRows.length) {
    throw Object.assign(new Error('ledger row count mismatch after insert'), {
      code: 'ledger_row_count_mismatch',
      got: selectedRows ? selectedRows.length : 0,
      expected: proposedRows.length,
    });
  }
  for (let i = 0; i < proposedRows.length; i += 1) {
    const want = proposedRows[i];
    const got = selectedRows[i];
    if (got.id !== want.id
      || got.filename !== want.filename
      || got.checksum_sha256 !== want.checksum_sha256
      || Number(got.apply_order) !== Number(want.apply_order)
      || got.apply_kind !== want.apply_kind
      || got.checksum_mode !== want.checksum_mode
      || got.evidence_ref !== want.evidence_ref
      || got.provenance_notes !== want.provenance_notes) {
      throw Object.assign(new Error(`ledger row mismatch for ${want.id}`), {
        code: 'ledger_row_mismatch',
        id: want.id,
      });
    }
    if (got.apply_kind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER) {
      throw Object.assign(new Error(`baseline row ${want.id} mislabeled executed_by_canonical_runner`), {
        code: 'mislabel_executed_runner',
        id: want.id,
      });
    }
    const appliedAt = got.applied_at;
    const recordedAt = got.ledger_recorded_at;
    if (!appliedAt || !recordedAt) {
      throw Object.assign(new Error(`ledger row ${want.id} missing timestamps`), {
        code: 'ledger_timestamp_missing',
      });
    }
    if (String(appliedAt) !== String(recordedAt)) {
      throw Object.assign(new Error(`ledger row ${want.id} applied_at !== ledger_recorded_at`), {
        code: 'ledger_timestamp_mismatch',
      });
    }
    if (ledgerTxnTs && String(appliedAt) !== String(ledgerTxnTs)) {
      throw Object.assign(new Error(`ledger row ${want.id} timestamp not txn-stable`), {
        code: 'fabricated_historical_timestamp',
      });
    }
  }
  const recon = reconcileLedger(forward, selectedRows);
  if (!recon.ok) {
    throw Object.assign(new Error('reconcileLedger failed after baseline insert'), {
      code: recon.errors[0] ? recon.errors[0].code : 'ledger_reconcile_failed',
      errors: recon.errors,
    });
  }
}

function verifyKindCounts(rows) {
  const counts = {};
  for (const r of rows || []) {
    if (r.cnt != null && r.apply_kind != null) {
      counts[r.apply_kind] = Number(r.cnt);
    } else {
      counts[r.apply_kind] = (counts[r.apply_kind] || 0) + 1;
    }
  }
  if (counts[APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE] !== STRUCTURAL_BASELINE_COUNT
    || counts[APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE] !== CURRENT_STATE_BASELINE_COUNT
    || counts[APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER]) {
    throw Object.assign(new Error('ledger kind counts mismatch'), {
      code: 'ledger_kind_count_mismatch',
      counts,
    });
  }
}

async function runAuthorizedLedgerBaselineApplySequence(client, opts) {
  const options = opts || {};
  const secrets = (options.secrets || []).filter(Boolean);
  const proposedRows = options.proposedRows || assertSlice14acEvidenceByteLocked().rows;
  const forward = options.forward || assertSlice14acEvidenceByteLocked().forward;
  const expectedSequence = buildAuthorizedSequence(proposedRows.length);
  const steps = [];
  let began = false;
  let committed = false;
  let rolledBack = false;
  let ledgerTxnTs = null;
  let insertedRowCount = 0;

  if (options.sql != null
    || options.query != null
    || options.host != null
    || options.database != null
    || options.dsn != null) {
    throw Object.assign(new Error('caller-supplied SQL / host / database / DSN forbidden'), {
      code: 'caller_supplied_query_forbidden',
    });
  }

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

    const absentRes = await q(LEDGER_ABSENT_SQL);
    pushStep('assert_ledger_absent');
    assertLedgerAbsent(absentRes.rows);

    const relRes = await q(LEDGER_RELKIND_SQL);
    pushStep('assert_no_incompatible_ledger_relation');
    const colRes = await q(LEDGER_COLUMNS_SQL);
    pushStep('assert_no_incompatible_ledger_columns');
    assertNoIncompatibleLedgerRelation(relRes.rows, colRes.rows);

    await q(normalizeLedgerDdl());
    pushStep('create_ledger_ddl');

    const tsRes = await q(LEDGER_TXN_TS_SQL);
    pushStep('capture_ledger_txn_ts');
    ledgerTxnTs = (tsRes.rows && tsRes.rows[0] && tsRes.rows[0].ledger_txn_ts) || null;
    if (!ledgerTxnTs) {
      throw Object.assign(new Error('ledger_txn_ts capture failed'), {
        code: 'ledger_txn_ts_missing',
      });
    }

    for (const row of proposedRows) {
      await q(LEDGER_INSERT_SQL, [
        row.id,
        row.filename,
        row.checksum_sha256,
        row.apply_order,
        row.apply_kind,
        row.checksum_mode,
        row.evidence_ref,
        row.provenance_notes,
        ledgerTxnTs,
      ]);
      pushStep('insert_ledger_row');
      insertedRowCount += 1;
    }

    const countRes = await q(LEDGER_COUNT_SQL);
    pushStep('verify_ledger_count');
    const cnt = Number((countRes.rows && countRes.rows[0] && countRes.rows[0].cnt) || 0);
    if (cnt !== proposedRows.length) {
      throw Object.assign(new Error(`ledger count ${cnt} !== ${proposedRows.length}`), {
        code: 'ledger_row_count_mismatch',
      });
    }

    const selectRes = await q(LEDGER_SELECT_ALL_SQL);
    pushStep('verify_ledger_rows');
    verifyInsertedLedgerRows(selectRes.rows, proposedRows, ledgerTxnTs, forward);

    const tsUniformRes = await q(LEDGER_TIMESTAMP_UNIFORMITY_SQL);
    pushStep('verify_ledger_timestamps');
    const tsRow = (tsUniformRes.rows && tsUniformRes.rows[0]) || {};
    if (Number(tsRow.distinct_applied) !== 1 || Number(tsRow.distinct_recorded) !== 1) {
      throw Object.assign(new Error('ledger timestamps not uniform within transaction'), {
        code: 'ledger_timestamp_not_uniform',
      });
    }

    const kindRes = await q(LEDGER_KIND_COUNTS_SQL);
    pushStep('verify_ledger_kind_counts');
    verifyKindCounts(kindRes.rows);

    await q('COMMIT');
    committed = true;
    pushStep('COMMIT');

    if (JSON.stringify(steps) !== JSON.stringify(expectedSequence)) {
      throw Object.assign(new Error('authorized sequence drift'), {
        code: 'authorized_sequence_drift',
      });
    }

    return redactDeep({
      ok: true,
      code: 'phase_d_ledger_baseline_apply_ok',
      steps: steps.slice(),
      authorizedSequence: expectedSequence.slice(),
      baselineRowCount: proposedRows.length,
      structuralBaselineCount: STRUCTURAL_BASELINE_COUNT,
      currentStateBaselineCount: CURRENT_STATE_BASELINE_COUNT,
      proposedLedgerRowsSha256: PROPOSED_LEDGER_ROWS_SHA256,
      ledgerTxnTs,
      insertedRowCount,
      timestampSemantics: LEDGER_TIMESTAMP_SEMANTICS,
      readOnly: false,
      mutates: true,
      schemaMutation: 'ledger_only',
      dataMutation: false,
      ledgerWritten: true,
      executesMigrations: false,
      writesLedger: true,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      ledgerBaselineApplyLiveEnabled: PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED === true,
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
      'ledger_preexisting',
      'incompatible_ledger_relation',
      'ledger_txn_ts_missing',
      'ledger_row_count_mismatch',
      'ledger_row_mismatch',
      'mislabel_executed_runner',
      'ledger_timestamp_missing',
      'ledger_timestamp_mismatch',
      'fabricated_historical_timestamp',
      'ledger_reconcile_failed',
      'ledger_kind_count_mismatch',
      'ledger_timestamp_not_uniform',
      'proposed_ledger_rows_hash_drift',
      'slice14ac_evidence_file_hash_drift',
      'authorized_sequence_drift',
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
      message: redactSecrets(String(err.message || 'ledger baseline apply failed'), secrets),
      steps: steps.slice(),
      rolledBack,
      committed: false,
      insertedRowCount,
      mutates: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      executesMigrations: false,
      writesLedger: false,
      liveApplyEnabled: false,
      ledgerBaselineApplyLiveEnabled: PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED === true,
    }, secrets);
    throw Object.assign(new Error(safe.message), { code: safe.code, result: safe });
  }
}

function instantiateApplyPgClient(clientConfig, deps) {
  const d = deps || {};
  applyPgClientInstantiateCount += 1;
  let ClientCtor = d.Client;
  if (!ClientCtor) {
    if (PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED !== true) {
      throw Object.assign(new Error('ledger baseline apply live capability disabled'), {
        code: 'ledger_baseline_apply_capability_disabled',
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

function pickSafeLedgerBaselineApplyOutput(result) {
  const src = result || {};
  const out = {};
  for (const k of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return redactDeep(out, []);
}

function createScriptedLedgerBaselineApplyFakeClient(script) {
  const s = script || {};
  const rowCount = Number(s.rowCount) || BASELINE_ROW_COUNT;
  const expected = (s.expectedSteps || buildAuthorizedSequence(rowCount)).slice();
  const proposedRows = s.proposedRows || assertSlice14acEvidenceByteLocked().rows.slice(0, rowCount);
  const calls = [];
  let stepIndex = 0;
  let connected = false;
  let ended = false;
  const responses = s.responses || {};
  const priorSteps = [];
  let capturedTxnTs = responses.ledgerTxnTs || new Date('2026-07-20T00:00:00.000Z');
  let inserted = 0;
  const ledgerStore = [];

  function nextExpected() {
    return expected[stepIndex] || null;
  }

  const client = {
    calls,
    ledgerStore,
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
        || kind === 'create_ledger_ddl') {
        priorSteps.push(kind);
        return { rows: [], rowCount: 0 };
      }

      if (kind === 'assert_ledger_absent') {
        priorSteps.push(kind);
        return responses.ledgerAbsent || { rows: [{ cnt: 0 }], rowCount: 1 };
      }

      if (kind === 'assert_no_incompatible_ledger_relation') {
        priorSteps.push(kind);
        return responses.ledgerRelkind || { rows: [], rowCount: 0 };
      }

      if (kind === 'assert_no_incompatible_ledger_columns') {
        priorSteps.push(kind);
        return responses.ledgerColumns || { rows: [], rowCount: 0 };
      }

      if (kind === 'capture_ledger_txn_ts') {
        priorSteps.push(kind);
        if (responses.captureTxnTsError) {
          throw Object.assign(new Error('txn ts failed'), { code: 'query_failed' });
        }
        return { rows: [{ ledger_txn_ts: capturedTxnTs }], rowCount: 1 };
      }

      if (kind === 'insert_ledger_row') {
        priorSteps.push(kind);
        const useTs = (s.timestampDriftAtIndex != null && inserted === s.timestampDriftAtIndex)
          ? (s.timestampDriftValue || new Date('2019-01-01T00:00:00.000Z'))
          : params[8];
        const row = {
          id: params[0],
          filename: params[1],
          checksum_sha256: params[2],
          apply_order: params[3],
          apply_kind: params[4],
          checksum_mode: params[5],
          evidence_ref: params[6],
          provenance_notes: params[7],
          applied_at: useTs,
          ledger_recorded_at: useTs,
        };
        ledgerStore.push(row);
        inserted += 1;
        return { rows: [], rowCount: 1 };
      }

      if (kind === 'verify_ledger_count') {
        priorSteps.push(kind);
        return { rows: [{ cnt: ledgerStore.length }], rowCount: 1 };
      }

      if (kind === 'verify_ledger_rows') {
        priorSteps.push(kind);
        const rows = ledgerStore.slice().sort((a, b) => a.apply_order - b.apply_order);
        return { rows, rowCount: rows.length };
      }

      if (kind === 'verify_ledger_timestamps') {
        priorSteps.push(kind);
        return {
          rows: [{
            distinct_applied: 1,
            distinct_recorded: 1,
            min_applied: capturedTxnTs,
            max_applied: capturedTxnTs,
          }],
          rowCount: 1,
        };
      }

      if (kind === 'verify_ledger_kind_counts') {
        priorSteps.push(kind);
        const counts = {};
        for (const r of ledgerStore) {
          counts[r.apply_kind] = (counts[r.apply_kind] || 0) + 1;
        }
        const rows = Object.entries(counts).map(([apply_kind, cnt]) => ({ apply_kind, cnt }));
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

function createScriptedLedgerBaselineApplyFakeClientFactory(script) {
  return function FakeClient() {
    return createScriptedLedgerBaselineApplyFakeClient(script);
  };
}

async function executePhaseDLedgerBaselineApply(opts) {
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
    return pickSafeLedgerBaselineApplyOutput({
      ok: false,
      code: 'caller_supplied_connect_forbidden',
      applyLedgerBaseline: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      privateRefsZeroed: true,
    });
  }

  const gates = evaluateLedgerBaselineApplyGates({
    env: options.env,
    argv: options.argv || [],
  });
  if (!gates.ok) {
    return pickSafeLedgerBaselineApplyOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'ledger_baseline_apply_gates_rejected',
      errors: gates.errors,
      applyLedgerBaseline: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      ledgerBaselineApplyLiveEnabled: PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED === true,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      note: 'gates rejected — zero pg Clients',
      privateRefsZeroed: true,
    });
  }

  let evidence;
  try {
    evidence = assertSlice14acEvidenceByteLocked();
  } catch (e) {
    return pickSafeLedgerBaselineApplyOutput({
      ok: false,
      code: e.code || 'slice14ac_evidence_failed',
      message: String(e.message || '14AC evidence lock failed'),
      applyLedgerBaseline: false,
      liveMutation: false,
      clientsInstantiated: 0,
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
      return pickSafeLedgerBaselineApplyOutput({
        ok: false,
        code: loaded.code || 'managed_identity_loader_failed',
        errors: loaded.errors || [],
        applyLedgerBaseline: false,
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
    return pickSafeLedgerBaselineApplyOutput({
      ok: false,
      code: e.code || 'credential_target_rejected',
      errors: e.errors || [{ code: e.code, message: e.message }],
      applyLedgerBaseline: false,
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
      sequence = await runAuthorizedLedgerBaselineApplySequence(client, {
        secrets,
        proposedRows: evidence.rows,
        forward: evidence.forward,
      });
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
      code: sequence.code || 'phase_d_ledger_baseline_apply_ok',
      applyLedgerBaseline: true,
      steps: sequence.steps,
      authorizedSequence: buildAuthorizedSequence(BASELINE_ROW_COUNT),
      baselineRowCount: sequence.baselineRowCount,
      structuralBaselineCount: sequence.structuralBaselineCount,
      currentStateBaselineCount: sequence.currentStateBaselineCount,
      proposedLedgerRowsSha256: sequence.proposedLedgerRowsSha256,
      ledgerTxnTs: sequence.ledgerTxnTs,
      insertedRowCount: sequence.insertedRowCount,
      timestampSemantics: sequence.timestampSemantics,
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
      schemaMutation: 'ledger_only',
      dataMutation: false,
      ledgerWritten: true,
      executesMigrations: false,
      writesLedger: true,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      ledgerBaselineApplyLiveEnabled: true,
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
      insertedRowCount: result ? result.insertedRowCount : 0,
      applyLedgerBaseline: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      executesMigrations: false,
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
      ledgerBaselineApplyLiveEnabled: true,
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

  return pickSafeLedgerBaselineApplyOutput(outcome);
}

function exactLedgerBaselineApplyArgv() {
  return [
    CLI_APPLY_LEDGER_BASELINE,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function ledgerBaselineApplyEnv(extra) {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_LEDGER_BASELINE_APPLY]: '1',
    [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ...(extra || {}),
  };
}

function renderLedgerBaselineApplyUsage() {
  return [
    'phase-d:ledger-baseline-apply — FOUNDATION Slice 14AD',
    '',
    'Default: refused (zero pg Clients / zero HTTP).',
    '',
    'Required env:',
    `  ${ENV_LIVE_READONLY}=1`,
    `  ${ENV_LIVE_PREFLIGHT}=1`,
    `  ${ENV_LEDGER_BASELINE_APPLY}=1`,
    `  ${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `  AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
    '',
    'Required argv:',
    `  ${CLI_APPLY_LEDGER_BASELINE}`,
    `  --subscription ${TARGETS.subscriptionId}`,
    `  --resource-group ${TARGETS.resourceGroup}`,
    `  --postgres-server ${TARGETS.postgresServer}`,
    `  --database ${TARGETS.database}`,
    `  ${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    '',
    'Creates ledger + 39 baseline rows only. No migration SQL execution.',
  ].join('\n');
}

/**
 * Simulate a five-column legacy ledger after LEDGER_LEGACY_UPGRADE_DDL:
 * provenance columns exist but remain NULL (no defaults/backfill).
 */
function simulateLegacyUpgradeReconcileFailure(forward) {
  const rows = [{
    id: forward[0].id,
    filename: forward[0].filename,
    checksum_sha256: forward[0].sha256,
    apply_order: forward[0].order,
    apply_kind: null,
    checksum_mode: null,
    evidence_ref: null,
    provenance_notes: null,
    ledger_recorded_at: null,
    applied_at: new Date().toISOString(),
  }];
  return reconcileLedger(forward, rows);
}

/**
 * RED: legacySha256 stored under checksum_mode=canonical_lf_v1 (false canonical label).
 */
function simulateLegacyHashUnderCanonicalModeFailure(forward) {
  const withLegacy = forward.find((e) => e.legacySha256);
  if (!withLegacy) {
    return { ok: false, errors: [{ code: 'no_legacy_entry' }] };
  }
  const ts = '2026-07-20T00:31:52.213Z';
  const rows = forward.slice(0, withLegacy.order).map((e) => ({
    id: e.id,
    filename: e.filename,
    checksum_sha256: e.id === withLegacy.id ? e.legacySha256 : e.sha256,
    apply_order: e.order,
    apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
    checksum_mode: CHECKSUM_MODE_CANONICAL_LF_V1,
    evidence_ref: 'test',
    provenance_notes: 'mislabeled',
    ledger_recorded_at: ts,
    applied_at: ts,
  }));
  return reconcileLedger(forward, rows);
}

/**
 * GREEN: explicit repair — canonical sha256 + full provenance under canonical_lf_v1.
 */
function simulateCanonicalRepairedRowReconcile(forward) {
  const withLegacy = forward.find((e) => e.legacySha256) || forward[0];
  const ts = '2026-07-20T00:31:52.213Z';
  const rows = [{
    id: withLegacy.id,
    filename: withLegacy.filename,
    checksum_sha256: withLegacy.sha256,
    apply_order: withLegacy.order,
    apply_kind: APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
    checksum_mode: CHECKSUM_MODE_CANONICAL_LF_V1,
    evidence_ref: 'operator_repair:canonical',
    provenance_notes: 'explicit canonical checksum repair',
    ledger_recorded_at: ts,
    applied_at: ts,
  }];
  // Contiguous prefix required: pad 1..order-1 with matching canonical rows.
  const prefix = forward.slice(0, withLegacy.order - 1).map((e) => ({
    id: e.id,
    filename: e.filename,
    checksum_sha256: e.sha256,
    apply_order: e.order,
    apply_kind: APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
    checksum_mode: CHECKSUM_MODE_CANONICAL_LF_V1,
    evidence_ref: 'operator_repair:canonical',
    provenance_notes: 'explicit canonical checksum repair',
    ledger_recorded_at: ts,
    applied_at: ts,
  }));
  return reconcileLedger(forward, [...prefix, ...rows]);
}

/**
 * Assert legacy upgrade DDL adds nullable provenance columns without defaults.
 */
function assertLegacyUpgradeDdlNoDataDefaults() {
  const ddl = String(LEDGER_LEGACY_UPGRADE_DDL);
  const hasNullableCols = /ADD COLUMN IF NOT EXISTS apply_kind TEXT;/.test(ddl)
    && /ADD COLUMN IF NOT EXISTS checksum_mode TEXT;/.test(ddl)
    && /ADD COLUMN IF NOT EXISTS evidence_ref TEXT;/.test(ddl)
    && /ADD COLUMN IF NOT EXISTS provenance_notes TEXT;/.test(ddl)
    && /ADD COLUMN IF NOT EXISTS ledger_recorded_at TIMESTAMPTZ;/.test(ddl);
  const noChecksumDefault = !/checksum_mode TEXT(?:\s+NOT NULL)?\s+DEFAULT/.test(ddl);
  const noRecordedAtNow = !/ledger_recorded_at TIMESTAMPTZ DEFAULT NOW\(\)/.test(ddl);
  return {
    ok: hasNullableCols && noChecksumDefault && noRecordedAtNow,
    hasNullableCols,
    noChecksumDefault,
    noRecordedAtNow,
  };
}


module.exports = {
  PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_LEDGER_BASELINE_APPLY,
  CLI_APPLY_LEDGER_BASELINE,
  APPLICATION_NAME,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  LOCK_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  BASELINE_ROW_COUNT,
  STRUCTURAL_BASELINE_COUNT,
  CURRENT_STATE_BASELINE_COUNT,
  MASTER_SHA_BASIS,
  CANON_FP,
  MANIFEST_HASH,
  EXPECTED_BYTE_SHA,
  PROPOSED_LEDGER_ROWS_SHA256,
  SLICE14AC_EVIDENCE_FILE_SHA256,
  SLICE14AC_EVIDENCE_PATH,
  LEDGER_DDL,
  LEDGER_LEGACY_UPGRADE_DDL,
  LEDGER_TIMESTAMP_SEMANTICS,
  AUTHORIZED_SEQUENCE,
  SUCCESS_PATH_QUERY_COUNT,
  APPLY_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  PREFIX_SEQUENCE,
  SUFFIX_SEQUENCE,
  LEDGER_INSERT_SQL,
  LEDGER_ABSENT_SQL,
  buildAuthorizedSequence,
  hashProposedLedgerRows,
  loadSlice14acEvidence,
  validateProposedLedgerRows,
  assertSlice14acEvidenceByteLocked,
  evaluateLedgerBaselineApplyGates,
  executePhaseDLedgerBaselineApply,
  runAuthorizedLedgerBaselineApplySequence,
  createScriptedLedgerBaselineApplyFakeClient,
  createScriptedLedgerBaselineApplyFakeClientFactory,
  getLedgerBaselineApplyCounters,
  resetLedgerBaselineApplyCounters,
  pickSafeLedgerBaselineApplyOutput,
  exactLedgerBaselineApplyArgv,
  ledgerBaselineApplyEnv,
  renderLedgerBaselineApplyUsage,
  authorizeApplySql,
  classifyApplyStep,
  buildApplyConnectConfig,
  buildApplyPgClientConfig,
  simulateLegacyUpgradeReconcileFailure,
  simulateLegacyHashUnderCanonicalModeFailure,
  simulateCanonicalRepairedRowReconcile,
  assertLegacyUpgradeDdlNoDataDefaults,
  reconcileLedger,
  buildExecutedByCanonicalRunnerProvenance,
};
