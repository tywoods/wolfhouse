'use strict';

/**
 * phase-d-canonical-runner-noop — FOUNDATION Slice 14AE
 *
 * Default-disabled managed-identity / TLS verify-full wrapper that invokes the
 * merged runCanonicalMigrations implementation exactly once against active
 * Sunset staging and proves a true zero-apply no-op over the 39-row provenance
 * baseline ledger.
 *
 * No migration SQL execution. No ledger INSERT. No product DDL/DML.
 * Runner may issue idempotent ledger compatibility DDL + advisory locks with
 * effectiveMutation=false (proven by before/after digest + fingerprint).
 *
 * PHASE_D_LIVE_APPLY_ENABLED stays false. This module owns its capability flag.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { runCanonicalMigrations } = require('../run-canonical-migrations');
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
  normalizeSql,
  redactDeep,
} = require('./phase-d-live-readonly-boundary');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./phase-d-check-preflight');
const {
  loadProtectedAdminCredentialsViaManagedIdentity,
  zeroPrivateCredentialRefs,
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  getManagedIdentityHttpCounters,
  MI_LOADER_LOCKS,
} = require('./phase-d-managed-identity-credential-loader');
const {
  buildVerifiedTlsSslConfig,
} = require('./phase-d-live-readonly-pg-adapter');
const {
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  LEDGER_DDL,
  LEDGER_LEGACY_UPGRADE_DDL,
  LEDGER_SELECT_COLUMNS,
  LEDGER_TIMESTAMP_SEMANTICS,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET,
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  reconcileLedger,
  assertSafeDatabaseTarget,
} = require('./migration-integrity');
const {
  hashCanonicalManifest,
  introspectProductSchema,
  fingerprintProductSchema,
  compareSnapshots,
  verifyLiveSession,
  LEDGER_TABLE,
  buildIdentifierTruncationNotNullProvenance,
  classifyServerVersionClass,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
} = require('./sunset-schema-observer');
const {
  buildObserverCompareOptions,
  summarizeCompare,
  remainingMismatchKeys,
  captureAzurePg15PgcryptoLiveProfile,
} = require('./phase-d-pgcrypto-compatibility-normalization');

/** Capability flag for Slice 14AE — still default-disabled via env+argv gates. */
const PHASE_D_CANONICAL_RUNNER_NOOP_LIVE_ENABLED = true;

const ENV_CANONICAL_RUNNER_NOOP = 'SUNSET_PHASE_D_CANONICAL_RUNNER_NOOP';
const CLI_PROVE_CANONICAL_RUNNER_NOOP = '--prove-canonical-runner-noop';

const APPLICATION_NAME = 'wh-sunset-canonical-runner-noop';
const OBSERVER_APPLICATION_NAME = 'wh-sunset-schema-observer';

const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 30000;
const CONNECTION_TIMEOUT_MS = 20000;

const BASELINE_ROW_COUNT = 39;
const STRUCTURAL_BASELINE_COUNT = 34;
const CURRENT_STATE_BASELINE_COUNT = 5;

const MASTER_SHA_BASIS = '21371079ac5a331d47e7ed5f79351fceeeceefa6';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const PROPOSED_LEDGER_ROWS_SHA256 = 'c136abccd8d61b723fddc61b1971b4553b0256306bbe546c01d672a63e1e5226';
const SLICE14AC_EVIDENCE_FILE_SHA256 = '45219e7b6738d847f9dc066db27b92caf271e0ee305e7c6e643f27519033ff96';
const SLICE14AC_LIVE_PRODUCT_FINGERPRINT = '039b67d034d4bd1eec68cf8a348a1f6fad2b13bcc526f24584127d028d3f0c12';

const SLICE14AC_EVIDENCE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'sunset-schema-observer',
  'slice14ac-ledger-eligibility-matrix-evidence.json',
);

const EXPECTED_PATH = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'sunset-schema-observer',
  'expected-product-schema.json',
);

const NOOP_LOCKS = Object.freeze({
  subscriptionId: TARGETS.subscriptionId,
  resourceGroup: TARGETS.resourceGroup,
  postgresServer: TARGETS.postgresServer,
  postgresHost: TARGETS.postgresHost,
  database: TARGETS.database,
  port: TARGETS.port,
  sslmode: 'verify-full',
  applicationName: APPLICATION_NAME,
  observerApplicationName: OBSERVER_APPLICATION_NAME,
  advisoryLockKey1: ADVISORY_LOCK_KEY1,
  advisoryLockKey2: ADVISORY_LOCK_KEY2,
  baselineRowCount: BASELINE_ROW_COUNT,
  structuralBaselineCount: STRUCTURAL_BASELINE_COUNT,
  currentStateBaselineCount: CURRENT_STATE_BASELINE_COUNT,
  proposedLedgerRowsSha256: PROPOSED_LEDGER_ROWS_SHA256,
  slice14acEvidenceFileSha256: SLICE14AC_EVIDENCE_FILE_SHA256,
  masterShaBasis: MASTER_SHA_BASIS,
  managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
  keyVaultName: MI_LOADER_LOCKS.keyVaultName,
  secretName: MI_LOADER_LOCKS.secretName,
  sunsetNoopTarget: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET,
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
  '--apply-ledger-baseline',
]);

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_PROVE_CANONICAL_RUNNER_NOOP,
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
  'proveCanonicalRunnerNoop',
  'liveApplyEnabled',
  'canonicalRunnerNoopLiveEnabled',
  'liveHttpEnabled',
  'liveMutation',
  'schemaMutation',
  'dataMutation',
  'ledgerWritten',
  'executesMigrations',
  'runnerCompatibilityStatementsIssued',
  'effectiveMutation',
  'usedLiveHttp',
  'realImdsCall',
  'realKeyVaultCall',
  'realPostgresCall',
  'clientsInstantiated',
  'httpRequestCount',
  'imdsRequestCount',
  'keyVaultRequestCount',
  'liveRunnerInvocationCount',
  'runnerResult',
  'queryClassification',
  'preflight',
  'postflight',
  'digestsUnchanged',
  'fingerprintUnchanged',
  'rowCountsUnchanged',
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
  'privateRefsZeroed',
  'dockerUnavailableLimitation',
  'timestampSemantics',
]);

let noopPgClientInstantiateCount = 0;
let liveRunnerInvocationCount = 0;

function getCanonicalRunnerNoopCounters() {
  return {
    clientsInstantiated: noopPgClientInstantiateCount,
    liveRunnerInvocationCount,
    httpRequestCount: getManagedIdentityHttpCounters().httpRequestCount,
    imdsRequestCount: getManagedIdentityHttpCounters().imdsRequestCount,
    keyVaultRequestCount: getManagedIdentityHttpCounters().keyVaultRequestCount,
  };
}

function resetCanonicalRunnerNoopCounters() {
  noopPgClientInstantiateCount = 0;
  liveRunnerInvocationCount = 0;
}

function pickSafeCanonicalRunnerNoopOutput(obj) {
  const out = {};
  for (const k of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
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
    if (flag === CLI_PROVE_CANONICAL_RUNNER_NOOP || flag === '--help' || flag === '-h') {
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

function evaluateCanonicalRunnerNoopGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const argv = Array.isArray(options.argv) ? options.argv.map(String) : [];
  const errors = [];

  if (PHASE_D_CANONICAL_RUNNER_NOOP_LIVE_ENABLED !== true) {
    errors.push({
      code: 'canonical_runner_noop_capability_disabled',
      message: 'canonical runner noop capability is disabled',
    });
  }
  if (PHASE_D_LIVE_APPLY_ENABLED === true) {
    errors.push({
      code: 'global_live_apply_must_remain_false',
      message: 'PHASE_D_LIVE_APPLY_ENABLED must remain false',
    });
  }

  const dual = evaluateDualEnableFlags(env);
  if (!dual.ok) errors.push(...dual.errors);

  if (String(env[ENV_CANONICAL_RUNNER_NOOP] || '') !== '1') {
    errors.push({
      code: 'canonical_runner_noop_env_required',
      message: `env ${ENV_CANONICAL_RUNNER_NOOP}=1 is required`,
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
  if (!parsed.flags.has(CLI_PROVE_CANONICAL_RUNNER_NOOP)) {
    errors.push({
      code: 'canonical_runner_noop_flag_required',
      message: `${CLI_PROVE_CANONICAL_RUNNER_NOOP} is required`,
    });
  }

  const expected = {
    '--subscription': TARGETS.subscriptionId,
    '--resource-group': TARGETS.resourceGroup,
    '--postgres-server': TARGETS.postgresServer,
    '--database': TARGETS.database,
  };
  for (const [flag, want] of Object.entries(expected)) {
    if (String(parsed.values[flag] || '') !== want) {
      errors.push({
        code: 'argv_target_mismatch',
        message: `${flag} must equal locked target`,
        flag,
      });
    }
  }

  const cred = evaluateCredentialSource({ env, argv });
  if (!cred.ok) errors.push(...cred.errors);
  if (cred.ok && cred.source !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_required',
      message: 'credential source must be managed-identity',
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    proveCanonicalRunnerNoop: parsed.flags.has(CLI_PROVE_CANONICAL_RUNNER_NOOP)
      && String(env[ENV_CANONICAL_RUNNER_NOOP] || '') === '1',
    credentialSource: cred.source,
    parsed,
  };
}

function exactCanonicalRunnerNoopArgv() {
  return [
    CLI_PROVE_CANONICAL_RUNNER_NOOP,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function canonicalRunnerNoopEnv() {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_CANONICAL_RUNNER_NOOP]: '1',
    [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
  };
}

function renderCanonicalRunnerNoopUsage() {
  return [
    'phase-d:canonical-runner-noop — FOUNDATION Slice 14AE',
    '',
    'Default: refused (zero pg Clients / zero HTTP / zero runner invocations).',
    'Proves runCanonicalMigrations zero-apply no-op over 39-row provenance ledger.',
    'Does NOT execute migration SQL. Does NOT write ledger rows.',
    '',
    'Required env:',
    `  ${ENV_LIVE_READONLY}=1`,
    `  ${ENV_LIVE_PREFLIGHT}=1`,
    `  ${ENV_CANONICAL_RUNNER_NOOP}=1`,
    `  ${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `  ${ENV_SUBSCRIPTION}=${TARGETS.subscriptionId}`,
    '',
    'Required argv:',
    `  ${CLI_PROVE_CANONICAL_RUNNER_NOOP}`,
    `  --subscription ${TARGETS.subscriptionId}`,
    `  --resource-group ${TARGETS.resourceGroup}`,
    `  --postgres-server ${TARGETS.postgresServer}`,
    `  --database ${TARGETS.database}`,
    `  ${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    '',
    `application_name: ${APPLICATION_NAME}`,
  ].join('\n');
}

/**
 * Classify SQL issued by the canonical runner during a no-op proof.
 * Fail-closed on migration-file SQL, ledger INSERT, or product DML/DDL.
 */
function classifyRunnerQuery(sql) {
  const n = normalizeSql(sql);
  const upper = n.toUpperCase();

  if (/^SELECT\s+PG_ADVISORY_LOCK\b/.test(upper)) {
    return { kind: 'advisory_lock', allowed: true, effectiveMutation: false };
  }
  if (/^SELECT\s+PG_ADVISORY_UNLOCK\b/.test(upper)) {
    return { kind: 'advisory_unlock', allowed: true, effectiveMutation: false };
  }

  const ledgerDdlN = normalizeSql(LEDGER_DDL);
  const upgradeN = normalizeSql(LEDGER_LEGACY_UPGRADE_DDL);
  if (n === ledgerDdlN || n === upgradeN
    || (/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+SCHEMA_MIGRATION_LEDGER\b/.test(upper)
      && !/\bINSERT\b/.test(upper))
    || (/ALTER\s+TABLE\s+SCHEMA_MIGRATION_LEDGER\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/.test(upper))
    || (/CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+SCHEMA_MIGRATION_LEDGER_APPLY_ORDER_UIDX\b/.test(upper))
    || (/ADD\s+CONSTRAINT\s+SCHEMA_MIGRATION_LEDGER_/.test(upper) && /IF\s+NOT\s+EXISTS/.test(upper))) {
    return { kind: 'ledger_compat_ddl', allowed: true, effectiveMutation: false };
  }
  // Multi-statement upgrade DDL (DO $upgrade$ ...): treat as compat when it only
  // targets schema_migration_ledger IF NOT EXISTS paths.
  if (/DO\s+\$UPGRADE\$/.test(upper)
    && /SCHEMA_MIGRATION_LEDGER/.test(upper)
    && !/\bINSERT\b/.test(upper)
    && !/\bUPDATE\b/.test(upper)
    && !/\bDELETE\b/.test(upper)) {
    return { kind: 'ledger_compat_ddl', allowed: true, effectiveMutation: false };
  }

  if (/^SELECT\b/.test(upper)
    && /FROM\s+SCHEMA_MIGRATION_LEDGER\b/.test(upper)
    && !/\bFOR\s+UPDATE\b/.test(upper)) {
    return { kind: 'ledger_select', allowed: true, effectiveMutation: false };
  }

  if (/^INSERT\s+INTO\s+SCHEMA_MIGRATION_LEDGER\b/.test(upper)) {
    return { kind: 'ledger_insert', allowed: false, effectiveMutation: true, code: 'ledger_insert_forbidden' };
  }
  if (/^BEGIN\b/.test(upper) || /^COMMIT\b/.test(upper) || /^ROLLBACK\b/.test(upper)) {
    // applyOne txn wrappers — only reached if a migration would apply
    return { kind: 'apply_transaction', allowed: false, effectiveMutation: true, code: 'migration_apply_txn_forbidden' };
  }
  if (/\bINSERT\b/.test(upper) || /\bUPDATE\b/.test(upper) || /\bDELETE\b/.test(upper)
    || /\bTRUNCATE\b/.test(upper) || /\bDROP\b/.test(upper)
    || (/\bCREATE\b/.test(upper) && !/IF\s+NOT\s+EXISTS/.test(upper))
    || (/\bALTER\b/.test(upper) && !/IF\s+NOT\s+EXISTS/.test(upper) && !/ADD\s+CONSTRAINT/.test(upper))) {
    return {
      kind: 'migration_or_product_sql',
      allowed: false,
      effectiveMutation: true,
      code: 'migration_sql_dispatch_forbidden',
    };
  }

  return {
    kind: 'unknown_sql',
    allowed: false,
    effectiveMutation: true,
    code: 'unknown_runner_sql',
  };
}

function createQueryClassificationBag() {
  const events = [];
  const counts = {
    advisory_lock: 0,
    advisory_unlock: 0,
    ledger_compat_ddl: 0,
    ledger_select: 0,
    ledger_insert: 0,
    apply_transaction: 0,
    migration_or_product_sql: 0,
    unknown_sql: 0,
  };
  let migrationSqlDispatch = false;
  let ledgerInsert = false;
  let forbidden = false;
  let forbiddenCode = null;

  return {
    record(sql) {
      const c = classifyRunnerQuery(sql);
      events.push({ kind: c.kind, allowed: c.allowed, effectiveMutation: c.effectiveMutation === true });
      if (counts[c.kind] != null) counts[c.kind] += 1;
      else counts.unknown_sql += 1;
      if (c.kind === 'ledger_insert') ledgerInsert = true;
      if (c.kind === 'migration_or_product_sql' || c.kind === 'apply_transaction') {
        migrationSqlDispatch = true;
      }
      if (!c.allowed) {
        forbidden = true;
        forbiddenCode = c.code || 'forbidden_sql';
        throw Object.assign(new Error(`forbidden runner SQL: ${c.kind}`), {
          code: forbiddenCode,
          classification: c,
        });
      }
      return c;
    },
    snapshot() {
      const runnerCompatibilityStatementsIssued = counts.ledger_compat_ddl > 0
        || counts.advisory_lock > 0
        || counts.advisory_unlock > 0;
      return {
        events: events.slice(),
        counts: { ...counts },
        migrationSqlDispatch,
        ledgerInsert,
        forbidden,
        forbiddenCode,
        zeroMigrationFileSql: migrationSqlDispatch === false,
        zeroLedgerInsert: ledgerInsert === false,
        zeroInsertUpdateDelete: counts.ledger_insert === 0
          && events.every((e) => e.kind !== 'migration_or_product_sql'),
        runnerCompatibilityStatementsIssued,
        effectiveMutation: false,
      };
    },
  };
}

function createInstrumentedClientFactory(BaseClient, bag) {
  const Base = BaseClient || Client;
  return class InstrumentedCanonicalRunnerClient extends Base {
    constructor(config) {
      super(config);
      noopPgClientInstantiateCount += 1;
    }

    query(config, values, callback) {
      const sql = typeof config === 'string' ? config : (config && config.text);
      if (sql) bag.record(sql);
      return super.query(config, values, callback);
    }
  };
}

function hashLedgerRows(rows) {
  const normalized = (rows || []).map((r) => ({
    id: String(r.id),
    filename: String(r.filename),
    checksum_sha256: String(r.checksum_sha256),
    apply_order: Number(r.apply_order),
    applied_at: r.applied_at instanceof Date
      ? r.applied_at.toISOString()
      : String(r.applied_at),
    apply_kind: String(r.apply_kind),
    checksum_mode: String(r.checksum_mode),
    evidence_ref: r.evidence_ref == null ? null : String(r.evidence_ref),
    provenance_notes: r.provenance_notes == null ? null : String(r.provenance_notes),
    ledger_recorded_at: r.ledger_recorded_at instanceof Date
      ? r.ledger_recorded_at.toISOString()
      : String(r.ledger_recorded_at),
  }));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function hashApprovedTableRowCounts(perTableRowCounts) {
  const keys = Object.keys(perTableRowCounts || {}).sort();
  const ordered = {};
  for (const k of keys) ordered[k] = Number(perTableRowCounts[k]);
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function analyzeLedgerRows(rows, forward) {
  const errors = [];
  if (!Array.isArray(rows) || rows.length !== BASELINE_ROW_COUNT) {
    errors.push({
      code: 'ledger_row_count_drift',
      message: `expected ${BASELINE_ROW_COUNT} rows, got ${Array.isArray(rows) ? rows.length : 0}`,
    });
  }
  if (!Array.isArray(forward) || forward.length !== BASELINE_ROW_COUNT) {
    errors.push({ code: 'forward_count_drift', message: 'forward count drift' });
  }

  let structural = 0;
  let currentState = 0;
  let executed = 0;
  let nullUnknown = 0;
  const ids = [];
  const filenames = [];
  const checksums = [];
  const orders = [];
  const appliedAts = [];
  const recordedAts = [];

  const n = Math.min(
    Array.isArray(rows) ? rows.length : 0,
    Array.isArray(forward) ? forward.length : 0,
  );
  for (let i = 0; i < n; i += 1) {
    const row = rows[i];
    const entry = forward[i];
    ids.push(String(row.id));
    filenames.push(String(row.filename));
    checksums.push(String(row.checksum_sha256));
    orders.push(Number(row.apply_order));
    appliedAts.push(row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at));
    recordedAts.push(row.ledger_recorded_at instanceof Date
      ? row.ledger_recorded_at.toISOString()
      : String(row.ledger_recorded_at));

    if (Number(row.apply_order) !== i + 1) {
      errors.push({ code: 'ledger_order_gap', message: `order gap at ${i}` });
    }
    if (String(row.id) !== String(entry.id)
      || String(row.filename) !== String(entry.filename)
      || String(row.checksum_sha256) !== String(entry.sha256)
      || Number(row.apply_order) !== Number(entry.order)) {
      errors.push({
        code: 'ledger_forward_mismatch',
        message: `row/entry mismatch at ${i}`,
        id: String(row.id),
      });
    }
    if (String(row.checksum_mode) !== CHECKSUM_MODE_CANONICAL_LF_V1) {
      errors.push({ code: 'checksum_mode_mismatch', id: String(row.id) });
    }
    if (row.apply_kind == null || row.checksum_mode == null || row.ledger_recorded_at == null) {
      nullUnknown += 1;
      errors.push({ code: 'null_provenance', id: String(row.id) });
    } else if (row.apply_kind === APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE) {
      structural += 1;
    } else if (row.apply_kind === APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE) {
      currentState += 1;
    } else if (row.apply_kind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER) {
      executed += 1;
      errors.push({ code: 'executed_kind_present', id: String(row.id) });
    } else {
      nullUnknown += 1;
      errors.push({ code: 'unknown_apply_kind', id: String(row.id), kind: String(row.apply_kind) });
    }
  }

  if (structural !== STRUCTURAL_BASELINE_COUNT
    || currentState !== CURRENT_STATE_BASELINE_COUNT
    || executed !== 0) {
    errors.push({
      code: 'kind_count_drift',
      structural,
      currentState,
      executed,
    });
  }

  const recon = reconcileLedger(forward, rows || []);
  if (!recon.ok) {
    errors.push(...(recon.errors || []).slice(0, 5));
  }

  const distinctApplied = new Set(appliedAts).size;
  const distinctRecorded = new Set(recordedAts).size;
  const minApplied = appliedAts.length ? appliedAts.slice().sort()[0] : null;
  const maxApplied = appliedAts.length ? appliedAts.slice().sort()[appliedAts.length - 1] : null;
  const minRecorded = recordedAts.length ? recordedAts.slice().sort()[0] : null;
  const maxRecorded = recordedAts.length ? recordedAts.slice().sort()[recordedAts.length - 1] : null;

  return {
    ok: errors.length === 0,
    errors,
    rowCount: Array.isArray(rows) ? rows.length : 0,
    kindCounts: {
      structural,
      currentState,
      executed,
      nullUnknown,
    },
    ids,
    filenames,
    checksums,
    orders,
    ledgerDigest: hashLedgerRows(rows || []),
    timestamps: {
      minAppliedAt: minApplied,
      maxAppliedAt: maxApplied,
      minLedgerRecordedAt: minRecorded,
      maxLedgerRecordedAt: maxRecorded,
      distinctAppliedAtCount: distinctApplied,
      distinctLedgerRecordedAtCount: distinctRecorded,
    },
    reconcileOk: recon.ok === true,
  };
}

async function captureApprovedTableRowCounts(client, approvedTableNames) {
  const approved = [...approvedTableNames].sort();
  const perTableRowCounts = {};
  for (const name of approved) {
    if (name === LEDGER_TABLE) continue;
    const res = await client.query(
      `SELECT COUNT(*)::bigint AS n FROM public.${quoteIdent(name)}`,
    );
    const raw = res.rows[0] && res.rows[0].n;
    perTableRowCounts[name] = typeof raw === 'string' ? Number(raw) : Number(raw || 0);
  }
  return {
    perTableRowCounts,
    approvedTableRowCountDigest: hashApprovedTableRowCounts(perTableRowCounts),
    approvedTableCount: approved.filter((t) => t !== LEDGER_TABLE).length,
  };
}

async function captureNoopState(client, expectedContract, forward) {
  const session = await verifyLiveSession(client);
  if (!session.ok) {
    return {
      ok: false,
      code: 'session_not_read_only',
      errors: session.errors || [],
    };
  }

  let versionClass = 'postgresql_15';
  const verRes = await client.query('SHOW server_version_num');
  const verText = await client.query('SHOW server_version');
  const classified = classifyServerVersionClass(
    Number(verRes.rows[0] && (verRes.rows[0].server_version_num != null
      ? verRes.rows[0].server_version_num
      : Object.values(verRes.rows[0])[0])),
    String(verText.rows[0] && (verText.rows[0].server_version != null
      ? verText.rows[0].server_version
      : Object.values(verText.rows[0])[0] || '')),
  );
  if (!classified || classified.ok !== true) {
    return { ok: false, code: 'server_version_not_pg15' };
  }
  versionClass = classified.versionClass || versionClass;

  const cols = LEDGER_SELECT_COLUMNS.join(', ');
  const ledgerRes = await client.query(
    `SELECT ${cols} FROM schema_migration_ledger ORDER BY apply_order ASC`,
  );
  const ledgerAnalysis = analyzeLedgerRows(ledgerRes.rows, forward);
  if (!ledgerAnalysis.ok) {
    return {
      ok: false,
      code: 'ledger_preflight_failed',
      ledger: ledgerAnalysis,
      errors: ledgerAnalysis.errors,
    };
  }

  const product = await introspectProductSchema(client);
  const productFingerprintLive = fingerprintProductSchema(product.snapshot);
  const truncProv = buildIdentifierTruncationNotNullProvenance();
  const azureContext = {
    verified: true,
    host: EXPECTED_HOST,
    database: EXPECTED_DATABASE,
    versionClass,
  };
  const liveProfile = await captureAzurePg15PgcryptoLiveProfile(client, product.snapshot);
  const compare = compareSnapshots(
    expectedContract.snapshot,
    product.snapshot,
    buildObserverCompareOptions(
      azureContext,
      versionClass,
      truncProv && truncProv.ok ? truncProv : null,
      {
        enablePgcryptoCompatibilityNormalization: true,
        liveProfile,
      },
    ),
  );
  const summary = summarizeCompare(compare);
  const remaining = remainingMismatchKeys(compare.drifts || compare);
  const remainingMismatchCount = summary.mismatchCount != null
    ? summary.mismatchCount
    : remaining.length;

  const approvedTables = (expectedContract.snapshot && expectedContract.snapshot.tables) || [];
  const rowCounts = await captureApprovedTableRowCounts(client, approvedTables);

  return {
    ok: remainingMismatchCount === 0 && ledgerAnalysis.ok === true,
    code: remainingMismatchCount === 0 ? 'capture_ok' : 'normalized_product_drift_nonzero',
    remainingMismatchCount,
    remainingMismatchKeys: remaining.slice(0, 20),
    compareSummary: summary,
    productFingerprintLive,
    fingerprintMatches14acCapture: productFingerprintLive === SLICE14AC_LIVE_PRODUCT_FINGERPRINT,
    versionClass,
    ledger: {
      rowCount: ledgerAnalysis.rowCount,
      kindCounts: ledgerAnalysis.kindCounts,
      ledgerDigest: ledgerAnalysis.ledgerDigest,
      timestamps: ledgerAnalysis.timestamps,
      ids: ledgerAnalysis.ids,
      filenames: ledgerAnalysis.filenames,
      checksums: ledgerAnalysis.checksums,
      orders: ledgerAnalysis.orders,
      reconcileOk: ledgerAnalysis.reconcileOk,
    },
    approvedTableRowCountDigest: rowCounts.approvedTableRowCountDigest,
    approvedTableCount: rowCounts.approvedTableCount,
    // Intentionally omit per-table counts from durable evidence (size); digest only.
  };
}

function buildRunnerConnection(user, password) {
  return {
    host: TARGETS.postgresHost,
    port: TARGETS.port,
    database: TARGETS.database,
    user: String(user),
    password: String(password),
    application_name: APPLICATION_NAME,
    ssl: buildVerifiedTlsSslConfig(),
  };
}

function buildCaptureClientConfig(user, password) {
  return {
    host: TARGETS.postgresHost,
    port: TARGETS.port,
    database: TARGETS.database,
    user: String(user),
    password: String(password),
    application_name: OBSERVER_APPLICATION_NAME,
    options: '-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000',
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    ssl: buildVerifiedTlsSslConfig(),
  };
}

function instantiateCapturePgClient(clientConfig, deps) {
  const Ctor = (deps && deps.Client) || Client;
  noopPgClientInstantiateCount += 1;
  return new Ctor(clientConfig);
}

/**
 * Build a scripted fake Client for offline RED/GREEN of runCanonicalMigrations
 * under the Sunset noop allow path.
 */
function createScriptedCanonicalRunnerNoopFakeClientFactory(script) {
  const s = script || {};
  const ledgerRows = Array.isArray(s.ledgerRows) ? s.ledgerRows : [];
  const applyOneHook = s.onApplyOneQuery || null;
  const bag = s.queryBag || null;
  const forceSecondInvocationDetect = s.forceTrackInvocation === true;

  return function FakeClient() {
    noopPgClientInstantiateCount += 1;
    let ended = false;
    const self = {
      async connect() { return undefined; },
      async end() { ended = true; },
      async query(sql, params) {
        if (ended) throw new Error('query after end');
        const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
        if (bag) bag.record(text);
        const n = normalizeSql(text);
        const upper = n.toUpperCase();

        if (/^SELECT\s+PG_ADVISORY_LOCK\b/.test(upper)
          || /^SELECT\s+PG_ADVISORY_UNLOCK\b/.test(upper)) {
          return { rows: [{ pg_advisory_lock: true }], rowCount: 1 };
        }
        if (/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+SCHEMA_MIGRATION_LEDGER\b/.test(upper)
          || /ALTER\s+TABLE\s+SCHEMA_MIGRATION_LEDGER\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/.test(upper)
          || /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\b/.test(upper)
          || /DO\s+\$UPGRADE\$/.test(upper)
          || n === normalizeSql(LEDGER_DDL)
          || n === normalizeSql(LEDGER_LEGACY_UPGRADE_DDL)) {
          return { rows: [], rowCount: 0 };
        }
        if (/^SELECT\b/.test(upper) && /FROM\s+SCHEMA_MIGRATION_LEDGER\b/.test(upper)) {
          return { rows: ledgerRows.slice(), rowCount: ledgerRows.length };
        }
        if (/^BEGIN\b/.test(upper) || /^COMMIT\b/.test(upper) || /^ROLLBACK\b/.test(upper)) {
          if (typeof applyOneHook === 'function') applyOneHook('txn', n);
          return { rows: [], rowCount: 0 };
        }
        if (/^INSERT\s+INTO\s+SCHEMA_MIGRATION_LEDGER\b/.test(upper)) {
          if (typeof applyOneHook === 'function') applyOneHook('ledger_insert', n, params);
          return { rows: [], rowCount: 1 };
        }
        // Migration body SQL
        if (typeof applyOneHook === 'function') applyOneHook('migration_sql', n);
        if (s.rejectMigrationSql) {
          throw Object.assign(new Error('migration sql dispatched'), {
            code: 'migration_sql_dispatch_forbidden',
          });
        }
        return { rows: [], rowCount: 0 };
      },
    };
    if (forceSecondInvocationDetect) self._script = s;
    return self;
  };
}

function buildBaselineLedgerRowsFromForward(forward, proposedRows) {
  const byId = new Map((proposedRows || []).map((r) => [String(r.id), r]));
  return forward.map((entry, i) => {
    const prop = byId.get(String(entry.id)) || {};
    return {
      id: entry.id,
      filename: entry.filename,
      checksum_sha256: entry.sha256,
      apply_order: entry.order,
      applied_at: prop.applied_at || '2026-07-20T00:31:52.213Z',
      apply_kind: prop.apply_kind || (
        i < STRUCTURAL_BASELINE_COUNT
          ? APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE
          : APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE
      ),
      checksum_mode: CHECKSUM_MODE_CANONICAL_LF_V1,
      evidence_ref: prop.evidence_ref || `slice14ac:${entry.id}`,
      provenance_notes: prop.provenance_notes || 'verified baseline',
      ledger_recorded_at: prop.ledger_recorded_at || '2026-07-20T00:31:52.213Z',
    };
  });
}

async function invokeRunCanonicalMigrationsOnce(opts) {
  if (liveRunnerInvocationCount >= 1 && opts && opts.refuseSecondInvocation !== false) {
    throw Object.assign(new Error('second live runner invocation refused'), {
      code: 'hidden_second_invocation',
    });
  }
  liveRunnerInvocationCount += 1;
  const result = await runCanonicalMigrations(opts);
  return result;
}

async function executePhaseDCanonicalRunnerNoop(opts) {
  const options = opts || {};
  const env = options.env || process.env;
  const argv = Array.isArray(options.argv) ? options.argv : [];

  const gates = evaluateCanonicalRunnerNoopGates({ env, argv });
  if (!gates.ok) {
    return pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'canonical_runner_noop_gates_rejected',
      proveCanonicalRunnerNoop: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      canonicalRunnerNoopLiveEnabled: PHASE_D_CANONICAL_RUNNER_NOOP_LIVE_ENABLED === true,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      executesMigrations: false,
      liveRunnerInvocationCount: 0,
      clientsInstantiated: 0,
      httpRequestCount: 0,
      errors: gates.errors,
      privateRefsZeroed: true,
      applicationName: APPLICATION_NAME,
    });
  }

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) {
    return pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: 'manifest_integrity_failed',
      errors: integrity.errors,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      liveRunnerInvocationCount: 0,
      privateRefsZeroed: true,
    });
  }
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  const expected = JSON.parse(expectedBytes.toString('utf8'));

  if (manifestHash !== MANIFEST_HASH || expectedHash !== EXPECTED_BYTE_SHA) {
    return pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: 'hash_lock_drift',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      liveRunnerInvocationCount: 0,
      privateRefsZeroed: true,
    });
  }

  let loaded = null;
  try {
    loaded = await loadProtectedAdminCredentialsViaManagedIdentity({
      env,
      argv: exactCanonicalRunnerNoopArgv(),
      httpRequest: options.httpRequest,
    });
  } catch (e) {
    return pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: (e && e.code) || 'managed_identity_loader_failed',
      message: String((e && e.message) || e).slice(0, 240),
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      liveRunnerInvocationCount: 0,
      privateRefsZeroed: true,
    });
  }
  if (!loaded || loaded.ok !== true) {
    return pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: (loaded && loaded.code) || 'managed_identity_loader_failed',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      liveRunnerInvocationCount: 0,
      privateRefsZeroed: true,
      httpRequestCount: getManagedIdentityHttpCounters().httpRequestCount,
    });
  }

  const user = loaded._user;
  const password = loaded._password;
  zeroPrivateCredentialRefs(loaded);

  const CaptureClient = options.CaptureClient || options.Client || Client;
  const captureConfig = buildCaptureClientConfig(user, password);
  let captureClient = null;
  let preflight = null;
  try {
    captureClient = instantiateCapturePgClient(captureConfig, { Client: CaptureClient });
    await captureClient.connect();
    preflight = await captureNoopState(captureClient, expected, forward);
  } catch (e) {
    zeroPrivateCredentialRefs({ _user: user, _password: password });
    return pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: (e && e.code) || 'preflight_capture_failed',
      message: String((e && e.message) || e).slice(0, 240),
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      liveRunnerInvocationCount: 0,
      privateRefsZeroed: true,
    });
  } finally {
    try { if (captureClient) await captureClient.end(); } catch (_) { /* ignore */ }
  }

  if (!preflight || preflight.ok !== true) {
    zeroPrivateCredentialRefs({ _user: user, _password: password });
    return pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: (preflight && preflight.code) || 'preflight_failed',
      preflight: redactDeep(preflight, [user, password]),
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      liveRunnerInvocationCount: 0,
      privateRefsZeroed: true,
    });
  }

  const bag = options.queryBag || createQueryClassificationBag();
  const Instrumented = options.InstrumentedClient
    || createInstrumentedClientFactory(options.Client || Client, bag);
  const runnerConnection = buildRunnerConnection(user, password);

  // Safety: default path still refuses; opt-in must be explicit.
  const safetyProbe = assertSafeDatabaseTarget(runnerConnection);
  if (safetyProbe.ok) {
    zeroPrivateCredentialRefs({ _user: user, _password: password });
    return pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: 'default_safety_unexpectedly_allowed',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      liveRunnerInvocationCount: 0,
      privateRefsZeroed: true,
    });
  }

  let runnerResult = null;
  try {
    runnerResult = await invokeRunCanonicalMigrationsOnce({
      connection: runnerConnection,
      allowSunsetStagingCanonicalRunnerNoop: true,
      Client: Instrumented,
      refuseSecondInvocation: true,
    });
  } catch (e) {
    zeroPrivateCredentialRefs({ _user: user, _password: password });
    return pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: (e && e.code) || 'runner_invocation_failed',
      message: String((e && e.message) || e).slice(0, 240),
      queryClassification: bag.snapshot(),
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      executesMigrations: false,
      liveRunnerInvocationCount,
      privateRefsZeroed: true,
    });
  }

  const classification = bag.snapshot();
  if (classification.migrationSqlDispatch || classification.ledgerInsert || classification.forbidden) {
    zeroPrivateCredentialRefs({ _user: user, _password: password });
    return pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: classification.forbiddenCode || 'forbidden_sql_during_noop',
      runnerResult: {
        ok: runnerResult && runnerResult.ok,
        applied: runnerResult && runnerResult.applied,
        skipped: runnerResult && runnerResult.skipped,
        pending: runnerResult && runnerResult.pending,
        errors: runnerResult && runnerResult.errors,
      },
      queryClassification: classification,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: classification.ledgerInsert === true,
      executesMigrations: classification.migrationSqlDispatch === true,
      liveRunnerInvocationCount,
      privateRefsZeroed: true,
    });
  }

  const skippedOk = Array.isArray(runnerResult.skipped)
    && runnerResult.skipped.length === BASELINE_ROW_COUNT
    && runnerResult.skipped.every((id, i) => String(id) === String(forward[i].id));
  const appliedOk = Array.isArray(runnerResult.applied) && runnerResult.applied.length === 0;
  const pendingOk = Array.isArray(runnerResult.pending) && runnerResult.pending.length === 0;
  const runnerOk = runnerResult.ok === true
    && appliedOk
    && skippedOk
    && pendingOk
    && (!runnerResult.errors || runnerResult.errors.length === 0);

  if (!runnerOk) {
    zeroPrivateCredentialRefs({ _user: user, _password: password });
    return pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: 'runner_result_not_noop',
      runnerResult: {
        ok: runnerResult.ok,
        applied: runnerResult.applied,
        skipped: runnerResult.skipped,
        pending: runnerResult.pending,
        errors: runnerResult.errors,
        forwardCount: runnerResult.forwardCount,
        safetyMode: runnerResult.safetyMode,
      },
      queryClassification: classification,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      executesMigrations: false,
      liveRunnerInvocationCount,
      privateRefsZeroed: true,
    });
  }

  // Postflight capture
  let postflight = null;
  let postClient = null;
  try {
    postClient = instantiateCapturePgClient(buildCaptureClientConfig(user, password), {
      Client: CaptureClient,
    });
    await postClient.connect();
    postflight = await captureNoopState(postClient, expected, forward);
  } catch (e) {
    zeroPrivateCredentialRefs({ _user: user, _password: password });
    return pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: (e && e.code) || 'postflight_capture_failed',
      message: String((e && e.message) || e).slice(0, 240),
      runnerResult: {
        ok: true,
        applied: [],
        skipped: runnerResult.skipped,
        pending: [],
      },
      queryClassification: classification,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      liveRunnerInvocationCount,
      privateRefsZeroed: true,
    });
  } finally {
    try { if (postClient) await postClient.end(); } catch (_) { /* ignore */ }
    zeroPrivateCredentialRefs({ _user: user, _password: password });
  }

  const digestsUnchanged = postflight
    && postflight.ledger
    && postflight.ledger.ledgerDigest === preflight.ledger.ledgerDigest
    && postflight.ledger.rowCount === preflight.ledger.rowCount
    && JSON.stringify(postflight.ledger.kindCounts) === JSON.stringify(preflight.ledger.kindCounts)
    && JSON.stringify(postflight.ledger.timestamps) === JSON.stringify(preflight.ledger.timestamps);
  const fingerprintUnchanged = postflight
    && postflight.productFingerprintLive === preflight.productFingerprintLive
    && postflight.remainingMismatchCount === 0;
  const rowCountsUnchanged = postflight
    && postflight.approvedTableRowCountDigest === preflight.approvedTableRowCountDigest;

  const ok = postflight
    && postflight.ok === true
    && digestsUnchanged
    && fingerprintUnchanged
    && rowCountsUnchanged
    && liveRunnerInvocationCount === 1;

  return pickSafeCanonicalRunnerNoopOutput({
    ok,
    code: ok ? 'canonical_runner_noop_ok' : 'canonical_runner_noop_postcheck_failed',
    proveCanonicalRunnerNoop: true,
    liveApplyEnabled: false,
    canonicalRunnerNoopLiveEnabled: true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    executesMigrations: false,
    runnerCompatibilityStatementsIssued: classification.runnerCompatibilityStatementsIssued,
    effectiveMutation: false,
    usedLiveHttp: true,
    realImdsCall: true,
    realKeyVaultCall: true,
    realPostgresCall: true,
    clientsInstantiated: getCanonicalRunnerNoopCounters().clientsInstantiated,
    httpRequestCount: getCanonicalRunnerNoopCounters().httpRequestCount,
    imdsRequestCount: getCanonicalRunnerNoopCounters().imdsRequestCount,
    keyVaultRequestCount: getCanonicalRunnerNoopCounters().keyVaultRequestCount,
    liveRunnerInvocationCount,
    runnerResult: {
      ok: true,
      applied: [],
      appliedCount: 0,
      skipped: runnerResult.skipped.slice(),
      skippedCount: runnerResult.skipped.length,
      pending: [],
      pendingCount: 0,
      errors: [],
      forwardCount: runnerResult.forwardCount,
      safetyMode: runnerResult.safetyMode,
    },
    queryClassification: classification,
    preflight: {
      remainingMismatchCount: preflight.remainingMismatchCount,
      productFingerprintLive: preflight.productFingerprintLive,
      fingerprintMatches14acCapture: preflight.fingerprintMatches14acCapture,
      ledger: preflight.ledger,
      approvedTableRowCountDigest: preflight.approvedTableRowCountDigest,
      manifestHash,
      expectedProductSchemaByteSha256: expectedHash,
      versionClass: preflight.versionClass,
    },
    postflight: {
      remainingMismatchCount: postflight.remainingMismatchCount,
      productFingerprintLive: postflight.productFingerprintLive,
      fingerprintMatches14acCapture: postflight.fingerprintMatches14acCapture,
      ledger: postflight.ledger,
      approvedTableRowCountDigest: postflight.approvedTableRowCountDigest,
    },
    digestsUnchanged,
    fingerprintUnchanged,
    rowCountsUnchanged,
    subscriptionId: TARGETS.subscriptionId,
    resourceGroup: TARGETS.resourceGroup,
    postgresServer: TARGETS.postgresServer,
    postgresHost: TARGETS.postgresHost,
    database: TARGETS.database,
    sslmode: 'verify-full',
    applicationName: APPLICATION_NAME,
    credentialSource: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
    keyVaultName: MI_LOADER_LOCKS.keyVaultName,
    secretName: MI_LOADER_LOCKS.secretName,
    privateRefsZeroed: true,
    dockerUnavailableLimitation:
      'Live no-op is integration proof over existing Sunset staging ledger; '
      + 'not a fresh-db Docker replacement (Docker unavailable on this host).',
    timestampSemantics: LEDGER_TIMESTAMP_SEMANTICS,
    blocker: ok ? null : 'postcheck_failed',
  });
}

module.exports = {
  PHASE_D_CANONICAL_RUNNER_NOOP_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_CANONICAL_RUNNER_NOOP,
  CLI_PROVE_CANONICAL_RUNNER_NOOP,
  APPLICATION_NAME,
  OBSERVER_APPLICATION_NAME,
  BASELINE_ROW_COUNT,
  STRUCTURAL_BASELINE_COUNT,
  CURRENT_STATE_BASELINE_COUNT,
  MASTER_SHA_BASIS,
  CANON_FP,
  MANIFEST_HASH,
  EXPECTED_BYTE_SHA,
  PROPOSED_LEDGER_ROWS_SHA256,
  SLICE14AC_EVIDENCE_FILE_SHA256,
  SLICE14AC_LIVE_PRODUCT_FINGERPRINT,
  NOOP_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  LEDGER_TIMESTAMP_SEMANTICS,
  evaluateCanonicalRunnerNoopGates,
  executePhaseDCanonicalRunnerNoop,
  exactCanonicalRunnerNoopArgv,
  canonicalRunnerNoopEnv,
  renderCanonicalRunnerNoopUsage,
  pickSafeCanonicalRunnerNoopOutput,
  resetCanonicalRunnerNoopCounters,
  getCanonicalRunnerNoopCounters,
  classifyRunnerQuery,
  createQueryClassificationBag,
  createInstrumentedClientFactory,
  createScriptedCanonicalRunnerNoopFakeClientFactory,
  buildBaselineLedgerRowsFromForward,
  analyzeLedgerRows,
  hashLedgerRows,
  hashApprovedTableRowCounts,
  invokeRunCanonicalMigrationsOnce,
  captureNoopState,
  LOCK_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  MIGRATIONS_DIR,
};
