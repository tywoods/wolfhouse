'use strict';

/**
 * Staging ledger recovery — plan/certification + one-time executable apply.
 *
 * Context: Sunset staging schema_migration_ledger may contain only 042 while the
 * canonical forward chain has older migrations, so reconcileLedger correctly
 * fails closed with ledger_partial_history.
 *
 * Plan mode certifies a contiguous baseline recovery ONLY after an immutable
 * evidence artifact supplies explicit structural assertions for every
 * applicable historical migration (orders 1..39).
 *
 * Apply mode (this slice) may write ONLY those 39 missing
 * verified_structural_baseline rows inside one transaction + advisory lock,
 * preserving the existing 042 row unchanged. It never labels recovery rows
 * executed_by_canonical_runner and never weakens reconcileLedger.
 *
 * Hard rules:
 * - Dry-run / plan-only by default; apply requires explicit flag + approval
 * - Staging-only target lock; refuse production
 * - Never invent historical provenance
 * - Never print secrets/DSN; refuse arbitrary DSN/SQL argv
 * - Fail closed on weak/missing evidence, checksum/target mismatch,
 *   empty/other ledger shapes, or repeated application
 * - Roll back fully on any error
 * - Live DB/secret retrieval is out of band: apply requires an injected
 *   db-client seam (tests) or operator-provided client; this module does not
 *   fetch Key Vault secrets
 */

const fs = require('fs');
const {
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  BASELINE_APPLY_KINDS,
  LEDGER_SELECT_COLUMNS,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  reconcileLedger,
  sha256Buffer,
} = require('./migration-integrity');
const { hashCanonicalManifest, EXPECTED_HOST, EXPECTED_DATABASE } = require('./sunset-schema-observer');
const { TARGETS, normalizeSql } = require('./phase-d-live-readonly-boundary');
const { scanSecretValues } = require('./sunset-staging-iac-drift');

/** Capability enabled for the approved apply slice; still fail-closed via gates. */
const STAGING_LEDGER_RECOVERY_MUTATION_ENABLED = true;

const EVIDENCE_KIND = 'staging-ledger-recovery-evidence-v1';
const SLICE_ID = 'staging-ledger-recovery-apply';
const APPLICATION_NAME = 'wh-staging-ledger-recovery';

const ENV_RECOVERY = 'SUNSET_STAGING_LEDGER_RECOVERY';
const ENV_APPROVAL_TOKEN = 'SUNSET_STAGING_LEDGER_RECOVERY_APPROVAL_TOKEN';
const CLI_PLAN_ONLY = '--plan-only';
const CLI_APPROVE = '--approve-staging-ledger-recovery';
const CLI_EVIDENCE = '--evidence';
const CLI_APPLY_MUTATION = '--apply-ledger-recovery';

/** Operator must present this exact token (env) together with CLI_APPROVE. */
const APPROVAL_TOKEN = 'APPROVE-STAGING-LEDGER-RECOVERY-V1';

/**
 * Locked one-time staging recovery scenario:
 * ledger contains solely migration 042 (order 40) → ledger_partial_history.
 * Historical migrations = forward orders 1..39.
 */
const KNOWN_PARTIAL_SCENARIO = Object.freeze({
  diagnosisCode: 'ledger_partial_history',
  soleRowId: '042_luna_sales_schema',
  soleRowFilename: '042_luna_sales_schema.sql',
  soleRowOrder: 40,
  historicalOrderEnd: 39,
  recoveryTipOrder: 40,
});

const RECOVERY_INSERT_COUNT = KNOWN_PARTIAL_SCENARIO.historicalOrderEnd;

const RECOVERY_TARGET = Object.freeze({
  environment: 'staging',
  subscriptionId: TARGETS.subscriptionId,
  resourceGroup: TARGETS.resourceGroup,
  postgresServer: TARGETS.postgresServer,
  postgresHost: EXPECTED_HOST,
  database: EXPECTED_DATABASE,
  port: TARGETS.port,
  sslmode: 'verify-full',
  applicationName: APPLICATION_NAME,
});

const PRODUCTION_TARGET_PATTERNS = Object.freeze([
  /^prod$/i,
  /^production$/i,
  /wolfhouse(?!-staging)/i,
  /production/i,
]);

const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 30000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60000;

const SET_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`;
const SET_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`;
const SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL = `SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT_MS}ms'`;
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1, $2)';
const LEDGER_TXN_TS_SQL = 'SELECT NOW() AS ledger_txn_ts';
const LEDGER_COUNT_SQL = 'SELECT count(*)::int AS cnt FROM schema_migration_ledger';
const LEDGER_SELECT_ALL_SQL = [
  'SELECT',
  `  ${LEDGER_SELECT_COLUMNS.join(', ')}`,
  'FROM schema_migration_ledger',
  'ORDER BY apply_order ASC',
].join('\n');
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
const LEDGER_KIND_COUNTS_SQL = [
  'SELECT apply_kind, count(*)::int AS cnt',
  'FROM schema_migration_ledger',
  'GROUP BY apply_kind',
  'ORDER BY apply_kind',
].join('\n');

const APPLY_LOCKS = Object.freeze({
  advisoryLockKey1: ADVISORY_LOCK_KEY1,
  advisoryLockKey2: ADVISORY_LOCK_KEY2,
  advisoryLockLabels: Object.freeze(['WH', 'MIG1']),
  applicationName: APPLICATION_NAME,
  postgresHost: RECOVERY_TARGET.postgresHost,
  database: RECOVERY_TARGET.database,
  sslmode: RECOVERY_TARGET.sslmode,
});

function buildAuthorizedRecoveryApplySequence(insertCount) {
  const n = Number(insertCount) || RECOVERY_INSERT_COUNT;
  return Object.freeze([
    'BEGIN',
    'SET LOCAL lock_timeout',
    'SET LOCAL statement_timeout',
    'SET LOCAL idle_in_transaction_session_timeout',
    'pg_advisory_xact_lock',
    'assert_exact_sole_042',
    'capture_ledger_txn_ts',
    ...Array.from({ length: n }, () => 'insert_ledger_row'),
    'verify_ledger_count',
    'verify_ledger_rows',
    'verify_ledger_kind_counts',
    'COMMIT',
  ]);
}

const AUTHORIZED_APPLY_SEQUENCE = buildAuthorizedRecoveryApplySequence(RECOVERY_INSERT_COUNT);
const SUCCESS_PATH_QUERY_COUNT = AUTHORIZED_APPLY_SEQUENCE.length;

const FORBIDDEN_ARGV_FLAGS = Object.freeze([
  '--apply',
  '--mutate',
  '--execute',
  '--live',
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
  '--force',
  '--repair',
  '--migrate',
  '--run-migrations',
]);

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_PLAN_ONLY,
  CLI_APPROVE,
  CLI_EVIDENCE,
  CLI_APPLY_MUTATION,
  '--subscription',
  '--resource-group',
  '--postgres-server',
  '--database',
  '--help',
  '-h',
]);

const SAFE_OUTPUT_KEYS = Object.freeze([
  'ok',
  'code',
  'slice',
  'planOnly',
  'dryRun',
  'mutationEnabled',
  'liveMutation',
  'certified',
  'diagnosisCode',
  'manifestHash',
  'checksumMode',
  'forwardCount',
  'historicalCount',
  'proposedInsertCount',
  'projectedLedgerCount',
  'recoveryTipOrder',
  'evidenceDigest',
  'proposedRowsDigest',
  'target',
  'errors',
  'message',
  'note',
  'blocker',
  'reconcileOk',
  'applyKinds',
  'insertedRowCount',
  'preserved042',
  'steps',
  'authorizedSequence',
  'rolledBack',
  'committed',
  'ledgerWritten',
  'schemaMutation',
  'dataMutation',
  'executesMigrations',
  'writesLedger',
  'requestApply',
  'clientsInstantiated',
  'queryCalls',
  'applicationName',
]);

let applyQueryCallCount = 0;
let applyClientInstantiateCount = 0;

function resetRecoveryApplyCounters() {
  applyQueryCallCount = 0;
  applyClientInstantiateCount = 0;
}

function getRecoveryApplyCounters() {
  return {
    queryCalls: applyQueryCallCount,
    clientsInstantiated: applyClientInstantiateCount,
  };
}

const ALLOWED_RECOVERY_APPLY_KINDS = Object.freeze([
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE,
]);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256Text(text) {
  return sha256Buffer(Buffer.from(String(text), 'utf8'));
}

function digestEvidencePayload(evidence) {
  const copy = { ...(evidence || {}) };
  delete copy.evidenceDigest;
  delete copy.digest;
  return sha256Text(stableStringify(copy));
}

function digestProposedRows(rows) {
  return sha256Text(stableStringify(rows || []));
}

function assertSecretFree(payload, label) {
  const hits = scanSecretValues(payload);
  if (hits.length) {
    return {
      ok: false,
      code: 'secret_material_refused',
      message: `${label || 'payload'} contains forbidden secret material`,
      hits: hits.map((h) => h.pattern),
    };
  }
  return { ok: true };
}

function isProductionTarget(target) {
  const env = String((target && target.environment) || '');
  const database = String((target && target.database) || '');
  const host = String((target && target.postgresHost) || (target && target.host) || '');
  if (env === 'production' || env === 'prod') return true;
  if (PRODUCTION_TARGET_PATTERNS.some((re) => re.test(env))) return true;
  if (PRODUCTION_TARGET_PATTERNS.some((re) => re.test(database))) return true;
  if (/prod/i.test(host) && !/staging/i.test(host)) return true;
  if (database === 'wolfhouse' || database === 'production' || database === 'prod') return true;
  return false;
}

function assertStagingOnlyTarget(target) {
  const errors = [];
  const t = target || {};
  if (isProductionTarget(t)) {
    errors.push({ code: 'production_target_refused', message: 'production targets are refused' });
  }
  if (String(t.environment || '') !== 'staging') {
    errors.push({ code: 'target_environment_mismatch', message: 'environment must be staging' });
  }
  if (String(t.postgresHost || '') !== RECOVERY_TARGET.postgresHost) {
    errors.push({ code: 'target_host_mismatch', message: 'postgresHost must match locked staging host' });
  }
  if (String(t.database || '') !== RECOVERY_TARGET.database) {
    errors.push({ code: 'target_database_mismatch', message: 'database must match locked staging database' });
  }
  if (String(t.subscriptionId || '') !== RECOVERY_TARGET.subscriptionId) {
    errors.push({ code: 'target_subscription_mismatch', message: 'subscriptionId mismatch' });
  }
  if (String(t.resourceGroup || '') !== RECOVERY_TARGET.resourceGroup) {
    errors.push({ code: 'target_resource_group_mismatch', message: 'resourceGroup mismatch' });
  }
  if (String(t.postgresServer || '') !== RECOVERY_TARGET.postgresServer) {
    errors.push({ code: 'target_server_mismatch', message: 'postgresServer mismatch' });
  }
  if (Number(t.port) !== RECOVERY_TARGET.port) {
    errors.push({ code: 'target_port_mismatch', message: 'port mismatch' });
  }
  return { ok: errors.length === 0, errors };
}

function parseArgvFlags(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const flags = new Set();
  const values = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (!a.startsWith('--') && a !== '-h') continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      const key = a.slice(0, eq);
      flags.add(key);
      values[key] = a.slice(eq + 1);
      continue;
    }
    flags.add(a);
    const next = args[i + 1];
    if (next && !String(next).startsWith('-')) {
      values[a] = String(next);
      i += 1;
    }
  }
  return { flags, values, args };
}

function evaluateRecoveryGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const argv = options.argv || [];
  const errors = [];
  const { flags, values } = parseArgvFlags(argv);
  const requestApply = flags.has(CLI_APPLY_MUTATION) || options.requestMutation === true;
  const planOnly = flags.has(CLI_PLAN_ONLY);

  for (const f of flags) {
    if (FORBIDDEN_ARGV_FLAGS.includes(f)) {
      errors.push({ code: 'forbidden_argv', message: `forbidden argv flag ${f}`, flag: f });
    } else if (!ALLOWED_ARGV_FLAGS.includes(f)) {
      errors.push({ code: 'unknown_argv', message: `unknown argv flag ${f}`, flag: f });
    }
  }

  if (String(env[ENV_RECOVERY] || '') !== '1') {
    errors.push({
      code: 'env_required',
      message: `${ENV_RECOVERY}=1 is required`,
    });
  }

  if (requestApply && planOnly) {
    errors.push({
      code: 'plan_apply_conflict',
      message: `${CLI_PLAN_ONLY} and ${CLI_APPLY_MUTATION} are mutually exclusive`,
    });
  } else if (!requestApply && !planOnly) {
    errors.push({
      code: 'plan_only_required',
      message: `${CLI_PLAN_ONLY} is required for dry-run (or pass ${CLI_APPLY_MUTATION} for apply)`,
    });
  }

  if (!flags.has(CLI_APPROVE)) {
    errors.push({
      code: 'operator_approval_flag_required',
      message: `${CLI_APPROVE} is required`,
    });
  }

  const token = String(env[ENV_APPROVAL_TOKEN] || '');
  if (!token) {
    errors.push({
      code: 'operator_approval_token_required',
      message: `${ENV_APPROVAL_TOKEN} is required`,
    });
  } else if (token !== APPROVAL_TOKEN) {
    errors.push({
      code: 'operator_approval_token_mismatch',
      message: 'operator approval token mismatch',
    });
  }

  if (requestApply && STAGING_LEDGER_RECOVERY_MUTATION_ENABLED !== true) {
    errors.push({
      code: 'mutation_disabled',
      message: 'executable mutation mode is disabled',
    });
  }

  if (typeof STAGING_LEDGER_RECOVERY_MUTATION_ENABLED !== 'boolean') {
    errors.push({
      code: 'mutation_flag_corrupt',
      message: 'STAGING_LEDGER_RECOVERY_MUTATION_ENABLED must be boolean',
    });
  }

  const evidencePath = values[CLI_EVIDENCE] || options.evidencePath || null;
  if (!evidencePath && !options.evidence) {
    errors.push({
      code: 'evidence_path_required',
      message: `${CLI_EVIDENCE} <path> is required`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    planOnly: !requestApply,
    dryRun: !requestApply,
    requestApply,
    mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
    evidencePath,
    code: errors.length ? (errors[0].code || 'gate_refused') : 'gates_ok',
  };
}

function validateStructuralAssertions(entry) {
  const errors = [];
  const id = entry && entry.id ? String(entry.id) : 'unknown';
  const required = Array.isArray(entry && entry.requiredAssertionIds)
    ? entry.requiredAssertionIds.map(String)
    : [];
  const assertions = Array.isArray(entry && entry.structuralAssertions)
    ? entry.structuralAssertions
    : [];

  if (required.length === 0) {
    errors.push({
      code: 'missing_assertions',
      message: `${id} missing requiredAssertionIds`,
      id,
    });
    return { ok: false, errors };
  }
  if (assertions.length === 0) {
    errors.push({
      code: 'missing_assertions',
      message: `${id} missing structuralAssertions`,
      id,
    });
    return { ok: false, errors };
  }

  const byId = new Map();
  for (const a of assertions) {
    const aid = a && a.id != null ? String(a.id) : '';
    if (!aid) {
      errors.push({ code: 'missing_assertions', message: `${id} assertion missing id`, id });
      continue;
    }
    if (byId.has(aid)) {
      errors.push({ code: 'duplicate_assertion', message: `${id} duplicate assertion ${aid}`, id });
    }
    byId.set(aid, a);
  }

  for (const rid of required) {
    const a = byId.get(rid);
    if (!a) {
      errors.push({
        code: 'missing_assertions',
        message: `${id} missing required assertion ${rid}`,
        id,
        assertionId: rid,
      });
      continue;
    }
    if (a.satisfied !== true) {
      errors.push({
        code: 'assertion_unsatisfied',
        message: `${id} assertion ${rid} not satisfied`,
        id,
        assertionId: rid,
      });
    }
    if (!a.evidenceRef || String(a.evidenceRef).trim() === '') {
      errors.push({
        code: 'missing_evidence',
        message: `${id} assertion ${rid} missing evidenceRef`,
        id,
        assertionId: rid,
      });
    }
    if (a.arbitrarySql != null || a.sql != null || a.query != null) {
      errors.push({
        code: 'arbitrary_sql_refused',
        message: `${id} assertion ${rid} must not embed arbitrary SQL`,
        id,
        assertionId: rid,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateEvidenceArtifact(evidence, opts) {
  const options = opts || {};
  const errors = [];
  const secretGate = assertSecretFree(evidence, 'evidence');
  if (!secretGate.ok) {
    return { ok: false, errors: [secretGate], code: secretGate.code };
  }

  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return {
      ok: false,
      errors: [{ code: 'evidence_missing', message: 'evidence artifact required' }],
      code: 'evidence_missing',
    };
  }
  if (evidence.kind !== EVIDENCE_KIND) {
    errors.push({ code: 'evidence_kind_mismatch', message: `kind must be ${EVIDENCE_KIND}` });
  }
  if (evidence.immutable !== true) {
    errors.push({ code: 'evidence_not_immutable', message: 'evidence.immutable must be true' });
  }
  if (evidence.checksumMode !== CHECKSUM_MODE_CANONICAL_LF_V1) {
    errors.push({
      code: 'checksum_mode_mismatch',
      message: `checksumMode must be ${CHECKSUM_MODE_CANONICAL_LF_V1}`,
    });
  }

  const targetGate = assertStagingOnlyTarget(evidence.target);
  if (!targetGate.ok) errors.push(...targetGate.errors);

  const digest = digestEvidencePayload(evidence);
  if (evidence.evidenceDigest != null && String(evidence.evidenceDigest) !== digest) {
    errors.push({
      code: 'evidence_digest_mismatch',
      message: 'evidenceDigest does not match canonical payload digest',
    });
  }

  const observed = evidence.observedLedger || {};
  const rows = Array.isArray(observed.rows) ? observed.rows : null;
  if (!rows) {
    errors.push({ code: 'missing_evidence', message: 'observedLedger.rows required' });
  } else {
    // Refuse unexpected partial shapes for this one-time recovery.
    if (rows.length !== 1) {
      errors.push({
        code: 'partial_ledger_refused',
        message: 'one-time recovery expects exactly one observed ledger row (042 only)',
      });
    } else {
      const row = rows[0];
      if (String(row.id) !== KNOWN_PARTIAL_SCENARIO.soleRowId
        || Number(row.apply_order) !== KNOWN_PARTIAL_SCENARIO.soleRowOrder) {
        errors.push({
          code: 'partial_ledger_refused',
          message: 'observed ledger is not the locked sole-042 partial scenario',
        });
      }
    }
    if (observed.diagnosisCode !== KNOWN_PARTIAL_SCENARIO.diagnosisCode) {
      errors.push({
        code: 'diagnosis_mismatch',
        message: `observedLedger.diagnosisCode must be ${KNOWN_PARTIAL_SCENARIO.diagnosisCode}`,
      });
    }
  }

  const historical = Array.isArray(evidence.historicalMigrations)
    ? evidence.historicalMigrations
    : null;
  if (!historical) {
    errors.push({ code: 'missing_evidence', message: 'historicalMigrations required' });
  }

  if (options.requireDigest === true && !evidence.evidenceDigest) {
    errors.push({ code: 'missing_evidence', message: 'evidenceDigest required' });
  }

  return {
    ok: errors.length === 0,
    errors,
    digest,
    code: errors.length ? errors[0].code : 'evidence_ok',
  };
}

function loadLiveManifestContext(manifestPath, migrationsDir) {
  const p = manifestPath || MANIFEST_PATH;
  const manifest = loadManifest(p);
  const integrity = validateManifestIntegrity(manifest, {
    migrationsDir: migrationsDir || MIGRATIONS_DIR,
  });
  const { forward, manifestHash } = hashCanonicalManifest(manifest);
  return { manifest, integrity, forward, manifestHash };
}

/**
 * Certify a contiguous baseline recovery plan from immutable evidence.
 * Never mutates a database. Never invents provenance.
 */
function certifyContiguousBaseline(input) {
  const options = input || {};
  const errors = [];
  const evidence = options.evidence;
  const evidenceGate = validateEvidenceArtifact(evidence, { requireDigest: options.requireDigest });
  if (!evidenceGate.ok) {
    return {
      ok: false,
      certified: false,
      code: evidenceGate.code || 'evidence_invalid',
      errors: evidenceGate.errors,
      planOnly: true,
      dryRun: true,
      mutationEnabled: false,
      liveMutation: false,
    };
  }

  const ctx = options.manifestContext || loadLiveManifestContext(options.manifestPath);
  if (!ctx.integrity.ok) {
    return {
      ok: false,
      certified: false,
      code: 'manifest_integrity_failed',
      errors: ctx.integrity.errors.slice(0, 5),
      planOnly: true,
      dryRun: true,
      mutationEnabled: false,
      liveMutation: false,
    };
  }

  const expectedHash = String((evidence.manifest && evidence.manifest.manifestHash) || evidence.manifestHash || '');
  if (!expectedHash || expectedHash !== ctx.manifestHash) {
    errors.push({
      code: 'manifest_hash_mismatch',
      message: 'evidence manifestHash does not match live canonical manifest',
      expected: ctx.manifestHash,
      got: expectedHash || null,
    });
  }
  if (Number((evidence.manifest && evidence.manifest.forwardCount) || evidence.forwardCount) !== ctx.forward.length) {
    errors.push({
      code: 'forward_count_mismatch',
      message: 'evidence forwardCount does not match live forward chain',
    });
  }

  const forwardById = new Map(ctx.forward.map((e) => [e.id, e]));
  const forwardByOrder = new Map(ctx.forward.map((e) => [e.order, e]));
  const historical = evidence.historicalMigrations || [];
  const historicalNeeded = ctx.forward.filter((e) => e.order <= KNOWN_PARTIAL_SCENARIO.historicalOrderEnd);

  if (historical.length !== historicalNeeded.length) {
    errors.push({
      code: 'missing_evidence',
      message: `expected ${historicalNeeded.length} historicalMigrations, got ${historical.length}`,
    });
  }

  const proposedInserts = [];
  const seenOrders = new Set();
  const seenIds = new Set();

  for (const entry of historical) {
    const id = entry && entry.id ? String(entry.id) : '';
    const expected = forwardById.get(id);
    if (!expected) {
      errors.push({ code: 'unknown_migration_id', message: `unknown historical id ${id}`, id });
      continue;
    }
    if (expected.order > KNOWN_PARTIAL_SCENARIO.historicalOrderEnd) {
      errors.push({
        code: 'historical_scope_violation',
        message: `${id} is not in the historical recovery scope`,
        id,
      });
    }
    if (seenIds.has(id)) {
      errors.push({ code: 'duplicate_historical_id', message: `duplicate historical id ${id}`, id });
    }
    seenIds.add(id);
    if (seenOrders.has(expected.order)) {
      errors.push({ code: 'duplicate_historical_order', message: `duplicate order ${expected.order}`, id });
    }
    seenOrders.add(expected.order);

    const gotChecksum = String(entry.checksumSha256 || entry.sha256 || '');
    if (gotChecksum !== expected.sha256) {
      errors.push({
        code: 'checksum_mismatch',
        message: `checksum mismatch for ${id}`,
        id,
      });
    }
    if (entry.filename && String(entry.filename) !== expected.filename) {
      errors.push({ code: 'filename_mismatch', message: `filename mismatch for ${id}`, id });
    }
    if (entry.order != null && Number(entry.order) !== expected.order) {
      errors.push({ code: 'order_mismatch', message: `order mismatch for ${id}`, id });
    }

    const kind = String(entry.applyKind || entry.apply_kind || '');
    if (kind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER) {
      errors.push({
        code: 'executed_runner_label_refused',
        message: `recovery must not label ${id} executed_by_canonical_runner`,
        id,
      });
    } else if (!ALLOWED_RECOVERY_APPLY_KINDS.includes(kind)) {
      errors.push({
        code: 'apply_kind_refused',
        message: `recovery applyKind for ${id} must be a verified baseline kind`,
        id,
      });
    }

    const assertionGate = validateStructuralAssertions(entry);
    if (!assertionGate.ok) errors.push(...assertionGate.errors);

    proposedInserts.push({
      id: expected.id,
      filename: expected.filename,
      checksum_sha256: expected.sha256,
      apply_order: expected.order,
      apply_kind: kind,
      checksum_mode: CHECKSUM_MODE_CANONICAL_LF_V1,
      evidence_ref: `staging-ledger-recovery:${expected.id}`,
      provenance_notes:
        'verified baseline via staging ledger recovery structural evidence; not a canonical-runner apply',
    });
  }

  for (const needed of historicalNeeded) {
    if (!seenIds.has(needed.id)) {
      errors.push({
        code: 'missing_evidence',
        message: `missing historical evidence for ${needed.id}`,
        id: needed.id,
      });
    }
  }

  // Preserve the sole observed 042 row after validating it against the manifest.
  const observedRows = (evidence.observedLedger && evidence.observedLedger.rows) || [];
  const preserved = [];
  if (observedRows.length === 1) {
    const row = observedRows[0];
    const expected042 = forwardByOrder.get(KNOWN_PARTIAL_SCENARIO.soleRowOrder);
    if (!expected042 || String(row.id) !== expected042.id) {
      errors.push({ code: 'target_mismatch', message: 'observed 042 row does not match manifest tip' });
    } else {
      const got = String(row.checksum_sha256 || '');
      if (got !== expected042.sha256) {
        errors.push({ code: 'checksum_mismatch', message: 'observed 042 checksum mismatch' });
      }
      if (String(row.filename || '') !== expected042.filename) {
        errors.push({ code: 'filename_mismatch', message: 'observed 042 filename mismatch' });
      }
      // Preserve observed provenance as-is (do not invent / relabel).
      preserved.push({
        id: expected042.id,
        filename: expected042.filename,
        checksum_sha256: expected042.sha256,
        apply_order: expected042.order,
        apply_kind: row.apply_kind,
        checksum_mode: row.checksum_mode || CHECKSUM_MODE_CANONICAL_LF_V1,
        evidence_ref: row.evidence_ref || null,
        provenance_notes: row.provenance_notes || null,
        ledger_recorded_at: row.ledger_recorded_at || '1970-01-01T00:00:00.000Z',
        applied_at: row.applied_at || row.ledger_recorded_at || '1970-01-01T00:00:00.000Z',
      });
    }
  }

  proposedInserts.sort((a, b) => a.apply_order - b.apply_order);
  for (let i = 0; i < proposedInserts.length; i += 1) {
    if (proposedInserts[i].apply_order !== i + 1) {
      errors.push({
        code: 'non_contiguous_baseline',
        message: `proposed inserts are not a contiguous prefix (gap at order ${i + 1})`,
      });
      break;
    }
  }

  const projected = [
    ...proposedInserts.map((r) => ({
      ...r,
      ledger_recorded_at: '1970-01-01T00:00:00.000Z',
      applied_at: '1970-01-01T00:00:00.000Z',
    })),
    ...preserved,
  ].sort((a, b) => a.apply_order - b.apply_order);

  // Projected ledger must be a contiguous prefix ending at recovery tip (042).
  if (projected.length !== KNOWN_PARTIAL_SCENARIO.recoveryTipOrder) {
    errors.push({
      code: 'non_contiguous_baseline',
      message: `projected ledger must contain exactly orders 1..${KNOWN_PARTIAL_SCENARIO.recoveryTipOrder}`,
    });
  }
  for (let i = 0; i < projected.length; i += 1) {
    if (Number(projected[i].apply_order) !== i + 1) {
      errors.push({
        code: 'non_contiguous_baseline',
        message: `projected ledger gap at order ${i + 1}`,
      });
      break;
    }
  }

  const recon = reconcileLedger(ctx.forward, projected);
  if (!recon.ok) {
    const partial = recon.errors.some((e) => e.code === 'ledger_partial_history');
    errors.push({
      code: partial ? 'non_contiguous_baseline' : 'projected_reconcile_failed',
      message: 'projected ledger failed canonical reconcileLedger',
      reconcileErrors: recon.errors.slice(0, 5),
    });
  }

  // Recovery inserts must never use executed_by_canonical_runner.
  if (proposedInserts.some((r) => r.apply_kind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER)) {
    errors.push({
      code: 'executed_runner_label_refused',
      message: 'proposed recovery inserts include executed_by_canonical_runner',
    });
  }

  const ok = errors.length === 0;
  const applyKinds = {};
  for (const r of proposedInserts) {
    applyKinds[r.apply_kind] = (applyKinds[r.apply_kind] || 0) + 1;
  }

  return {
    ok,
    certified: ok,
    code: ok ? 'contiguous_baseline_certified' : (errors[0].code || 'certify_refused'),
    errors,
    planOnly: true,
    dryRun: true,
    mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
    liveMutation: false,
    diagnosisCode: KNOWN_PARTIAL_SCENARIO.diagnosisCode,
    manifestHash: ctx.manifestHash,
    checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
    forwardCount: ctx.forward.length,
    historicalCount: historicalNeeded.length,
    proposedInsertCount: proposedInserts.length,
    projectedLedgerCount: projected.length,
    recoveryTipOrder: KNOWN_PARTIAL_SCENARIO.recoveryTipOrder,
    evidenceDigest: evidenceGate.digest,
    proposedRowsDigest: digestProposedRows(proposedInserts),
    proposedInserts: ok ? proposedInserts : undefined,
    projectedLedger: ok ? projected : undefined,
    preservedRows: ok ? preserved : undefined,
    reconcileOk: recon.ok,
    applyKinds,
    target: { ...RECOVERY_TARGET },
    note: ok
      ? 'Dry-run certification only. Apply requires --apply-ledger-recovery plus injected db client after real staging structural evidence.'
      : undefined,
  };
}

function buildRecoveryPlan(input) {
  const options = input || {};
  const gateInput = options.gates || {
    env: options.env,
    argv: options.argv,
    evidencePath: options.evidencePath,
    evidence: options.evidence,
    requestMutation: options.requestMutation,
  };
  const gates = evaluateRecoveryGates(gateInput);
  if (!gates.ok) {
    return {
      ok: false,
      code: gates.code,
      errors: gates.errors,
      planOnly: true,
      dryRun: true,
      mutationEnabled: false,
      liveMutation: false,
      certified: false,
    };
  }

  let evidence = options.evidence;
  const evidencePath = gates.evidencePath || options.evidencePath;
  if (!evidence && evidencePath) {
    const raw = fs.readFileSync(evidencePath, 'utf8');
    evidence = JSON.parse(raw);
  }
  const certified = certifyContiguousBaseline({
    evidence,
    manifestPath: options.manifestPath,
    requireDigest: true,
  });

  return {
    ...certified,
    planOnly: true,
    dryRun: true,
    mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
    liveMutation: false,
    slice: SLICE_ID,
  };
}

function authorizeRecoveryApplySql(sql) {
  const n = normalizeSql(sql);
  const allowed = [
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    SET_LOCK_TIMEOUT_SQL,
    SET_STATEMENT_TIMEOUT_SQL,
    SET_IDLE_IN_TRANSACTION_TIMEOUT_SQL,
    ADVISORY_LOCK_SQL,
    LEDGER_TXN_TS_SQL,
    LEDGER_COUNT_SQL,
    LEDGER_SELECT_ALL_SQL,
    LEDGER_INSERT_SQL,
    LEDGER_KIND_COUNTS_SQL,
  ];
  for (const a of allowed) {
    if (n === normalizeSql(a)) return a;
  }
  throw Object.assign(
    new Error('unauthorized SQL rejected: only locked staging ledger recovery apply SQL permitted'),
    { code: 'unauthorized_sql' },
  );
}

function classifyRecoveryApplyStep(sql) {
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
  if (n === normalizeSql(LEDGER_SELECT_ALL_SQL)) {
    return 'assert_or_verify_ledger_rows';
  }
  if (n === normalizeSql(LEDGER_TXN_TS_SQL)) return 'capture_ledger_txn_ts';
  if (n === normalizeSql(LEDGER_INSERT_SQL)) return 'insert_ledger_row';
  if (n === normalizeSql(LEDGER_COUNT_SQL)) return 'verify_ledger_count';
  if (n === normalizeSql(LEDGER_KIND_COUNTS_SQL)) return 'verify_ledger_kind_counts';
  return 'unauthorized';
}

function snapshotLedgerRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    filename: String(row.filename || ''),
    checksum_sha256: String(row.checksum_sha256 || ''),
    apply_order: Number(row.apply_order),
    apply_kind: String(row.apply_kind || ''),
    checksum_mode: String(row.checksum_mode || ''),
    evidence_ref: row.evidence_ref == null ? null : String(row.evidence_ref),
    provenance_notes: row.provenance_notes == null ? null : String(row.provenance_notes),
    applied_at: row.applied_at == null ? null : String(row.applied_at),
    ledger_recorded_at: row.ledger_recorded_at == null ? null : String(row.ledger_recorded_at),
  };
}

function assertExactSole042Ledger(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw Object.assign(new Error('ledger is empty; sole-042 recovery refuses empty ledger'), {
      code: 'empty_ledger_refused',
    });
  }
  if (rows.length !== 1) {
    throw Object.assign(
      new Error('ledger is not the locked sole-042 shape (refusing empty/other/repeated apply)'),
      { code: rows.length > 1 ? 'repeated_application_refused' : 'partial_ledger_refused' },
    );
  }
  const row = rows[0];
  if (String(row.id) !== KNOWN_PARTIAL_SCENARIO.soleRowId
    || Number(row.apply_order) !== KNOWN_PARTIAL_SCENARIO.soleRowOrder) {
    throw Object.assign(new Error('observed ledger is not the locked sole-042 partial scenario'), {
      code: 'partial_ledger_refused',
    });
  }
  return snapshotLedgerRow(row);
}

function assertPreserved042(pre, postRows) {
  const post = (postRows || []).find((r) => String(r.id) === KNOWN_PARTIAL_SCENARIO.soleRowId);
  if (!post) {
    throw Object.assign(new Error('042 row missing after recovery apply'), {
      code: 'preserved_042_missing',
    });
  }
  const got = snapshotLedgerRow(post);
  for (const key of Object.keys(pre)) {
    if (String(got[key]) !== String(pre[key])) {
      throw Object.assign(new Error(`042 row changed at ${key}`), {
        code: 'preserved_042_mutated',
        field: key,
      });
    }
  }
}

function assertStructuralOnlyInserts(proposedInserts) {
  for (const row of proposedInserts || []) {
    if (row.apply_kind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER) {
      throw Object.assign(new Error(`recovery must not label ${row.id} executed_by_canonical_runner`), {
        code: 'executed_runner_label_refused',
        id: row.id,
      });
    }
    if (row.apply_kind !== APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE) {
      throw Object.assign(
        new Error(`recovery apply records only verified_structural_baseline (got ${row.apply_kind})`),
        { code: 'apply_kind_refused', id: row.id },
      );
    }
  }
}

function verifyPostWriteContiguous(selectedRows, proposedInserts, preserved042, forward) {
  const expectedCount = proposedInserts.length + 1;
  if (!Array.isArray(selectedRows) || selectedRows.length !== expectedCount) {
    throw Object.assign(new Error('post-write ledger row count mismatch'), {
      code: 'ledger_row_count_mismatch',
      got: selectedRows ? selectedRows.length : 0,
      expected: expectedCount,
    });
  }
  assertPreserved042(preserved042, selectedRows);

  const byOrder = selectedRows.slice().sort((a, b) => Number(a.apply_order) - Number(b.apply_order));
  for (let i = 0; i < byOrder.length; i += 1) {
    if (Number(byOrder[i].apply_order) !== i + 1) {
      throw Object.assign(new Error(`post-write ledger gap at order ${i + 1}`), {
        code: 'non_contiguous_baseline',
      });
    }
  }

  for (const want of proposedInserts) {
    const got = byOrder.find((r) => String(r.id) === want.id);
    if (!got
      || got.filename !== want.filename
      || got.checksum_sha256 !== want.checksum_sha256
      || Number(got.apply_order) !== Number(want.apply_order)
      || got.apply_kind !== APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE
      || got.checksum_mode !== CHECKSUM_MODE_CANONICAL_LF_V1) {
      throw Object.assign(new Error(`post-write mismatch for ${want.id}`), {
        code: 'ledger_row_mismatch',
        id: want.id,
      });
    }
    if (got.apply_kind === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER) {
      throw Object.assign(new Error(`mislabel executed_by_canonical_runner on ${want.id}`), {
        code: 'executed_runner_label_refused',
        id: want.id,
      });
    }
  }

  const recon = reconcileLedger(forward, byOrder);
  if (!recon.ok) {
    throw Object.assign(new Error('post-write contiguous reconcileLedger failed'), {
      code: recon.errors[0] ? recon.errors[0].code : 'projected_reconcile_failed',
      reconcileErrors: recon.errors.slice(0, 5),
    });
  }
}

function verifyRecoveryKindCounts(rows, preservedApplyKind) {
  const counts = {};
  for (const r of rows || []) {
    if (r.cnt != null && r.apply_kind != null) {
      counts[r.apply_kind] = Number(r.cnt);
    } else {
      counts[r.apply_kind] = (counts[r.apply_kind] || 0) + 1;
    }
  }
  if (counts[APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE] !== RECOVERY_INSERT_COUNT) {
    throw Object.assign(new Error('structural baseline kind count mismatch'), {
      code: 'ledger_kind_count_mismatch',
      counts,
    });
  }
  if (counts[APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER]
    && preservedApplyKind !== APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER) {
    throw Object.assign(new Error('unexpected executed_by_canonical_runner recovery labels'), {
      code: 'executed_runner_label_refused',
      counts,
    });
  }
  const preservedCount = counts[preservedApplyKind] || 0;
  if (preservedApplyKind === APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE) {
    if (counts[APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE] !== RECOVERY_INSERT_COUNT + 1) {
      throw Object.assign(new Error('kind counts mismatch with structural-preserved 042'), {
        code: 'ledger_kind_count_mismatch',
        counts,
      });
    }
  } else if (preservedCount !== 1) {
    throw Object.assign(new Error('preserved 042 apply_kind count mismatch'), {
      code: 'ledger_kind_count_mismatch',
      counts,
    });
  }
}

async function runAuthorizedRecoveryApplySequence(client, opts) {
  const options = opts || {};
  const proposedInserts = options.proposedInserts || [];
  const forward = options.forward;
  const expectedSequence = buildAuthorizedRecoveryApplySequence(proposedInserts.length);
  const steps = [];
  let began = false;
  let committed = false;
  let rolledBack = false;
  let ledgerTxnTs = null;
  let insertedRowCount = 0;
  let preserved042 = null;

  if (options.sql != null
    || options.query != null
    || options.host != null
    || options.database != null
    || options.dsn != null) {
    throw Object.assign(new Error('caller-supplied SQL / host / database / DSN forbidden'), {
      code: 'caller_supplied_query_forbidden',
    });
  }

  assertStructuralOnlyInserts(proposedInserts);

  async function q(sql, params) {
    authorizeRecoveryApplySql(sql);
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

    const preRes = await q(LEDGER_SELECT_ALL_SQL);
    pushStep('assert_exact_sole_042');
    preserved042 = assertExactSole042Ledger(preRes.rows);

    const tsRes = await q(LEDGER_TXN_TS_SQL);
    pushStep('capture_ledger_txn_ts');
    ledgerTxnTs = (tsRes.rows && tsRes.rows[0] && tsRes.rows[0].ledger_txn_ts) || null;
    if (!ledgerTxnTs) {
      throw Object.assign(new Error('ledger_txn_ts capture failed'), {
        code: 'ledger_txn_ts_missing',
      });
    }

    for (const row of proposedInserts) {
      await q(LEDGER_INSERT_SQL, [
        row.id,
        row.filename,
        row.checksum_sha256,
        row.apply_order,
        APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
        CHECKSUM_MODE_CANONICAL_LF_V1,
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
    if (cnt !== proposedInserts.length + 1) {
      throw Object.assign(new Error(`ledger count ${cnt} !== ${proposedInserts.length + 1}`), {
        code: 'ledger_row_count_mismatch',
      });
    }

    const selectRes = await q(LEDGER_SELECT_ALL_SQL);
    pushStep('verify_ledger_rows');
    verifyPostWriteContiguous(selectRes.rows, proposedInserts, preserved042, forward);

    const kindRes = await q(LEDGER_KIND_COUNTS_SQL);
    pushStep('verify_ledger_kind_counts');
    verifyRecoveryKindCounts(kindRes.rows, preserved042.apply_kind);

    await q('COMMIT');
    committed = true;
    pushStep('COMMIT');

    if (JSON.stringify(steps) !== JSON.stringify(expectedSequence)) {
      throw Object.assign(new Error('authorized sequence drift'), {
        code: 'authorized_sequence_drift',
      });
    }

    return {
      ok: true,
      code: 'staging_ledger_recovery_apply_ok',
      steps: steps.slice(),
      authorizedSequence: expectedSequence.slice(),
      insertedRowCount,
      preserved042: true,
      ledgerTxnTs,
      committed: true,
      rolledBack: false,
      liveMutation: true,
      ledgerWritten: true,
      writesLedger: true,
      schemaMutation: 'ledger_only',
      dataMutation: false,
      executesMigrations: false,
      mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
      applicationName: APPLICATION_NAME,
      reconcileOk: true,
    };
  } catch (e) {
    if (began && !committed) {
      try {
        authorizeRecoveryApplySql('ROLLBACK');
        applyQueryCallCount += 1;
        await client.query('ROLLBACK');
        rolledBack = true;
        steps.push('ROLLBACK');
      } catch (_) {
        /* ignore */
      }
    }
    const safe = {
      ok: false,
      code: (e && e.code) || 'query_failed',
      message: String((e && e.message) || 'recovery apply failed').slice(0, 400),
      steps: steps.slice(),
      rolledBack,
      committed: false,
      insertedRowCount,
      preserved042: false,
      liveMutation: false,
      ledgerWritten: false,
      writesLedger: false,
      schemaMutation: false,
      dataMutation: false,
      executesMigrations: false,
      mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
    };
    throw Object.assign(new Error(safe.message), { code: safe.code, result: safe });
  }
}

function createScriptedRecoveryApplyFakeClient(script) {
  const s = script || {};
  const insertCount = Number(s.insertCount) || RECOVERY_INSERT_COUNT;
  const expected = (s.expectedSteps || buildAuthorizedRecoveryApplySequence(insertCount)).slice();
  const calls = [];
  let stepIndex = 0;
  let connected = false;
  let ended = false;
  const responses = s.responses || {};
  let capturedTxnTs = responses.ledgerTxnTs || new Date('2026-07-22T12:00:00.000Z');
  let inserted = 0;
  const ledgerStore = [];
  let selectPhase = 0;

  const sole042 = responses.sole042 || {
    id: KNOWN_PARTIAL_SCENARIO.soleRowId,
    filename: KNOWN_PARTIAL_SCENARIO.soleRowFilename,
    checksum_sha256: responses.sole042Checksum || 'd741bc9aaf385eef81b4864e5ec40b42f2bbc4e0ebfa59b65a16aa684c1c4e1e',
    apply_order: KNOWN_PARTIAL_SCENARIO.soleRowOrder,
    apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
    checksum_mode: CHECKSUM_MODE_CANONICAL_LF_V1,
    evidence_ref: 'observed:042',
    provenance_notes: 'pre-existing sole ledger row; provenance preserved not invented',
    ledger_recorded_at: '2026-07-21T00:00:00.000Z',
    applied_at: '2026-07-21T00:00:00.000Z',
  };

  if (s.initialLedgerRows) {
    for (const r of s.initialLedgerRows) ledgerStore.push({ ...r });
  } else if (s.emptyLedger) {
    /* leave empty */
  } else {
    ledgerStore.push({ ...sole042 });
  }

  function nextExpected() {
    return expected[stepIndex] || null;
  }

  function mapKind(sql) {
    const base = classifyRecoveryApplyStep(sql);
    if (base === 'assert_or_verify_ledger_rows') {
      selectPhase += 1;
      return selectPhase === 1 ? 'assert_exact_sole_042' : 'verify_ledger_rows';
    }
    return base;
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
      const kind = mapKind(sql);
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
          : Object.assign(new Error(String(qe)), { code: typeof qe === 'object' && qe.code ? qe.code : 'query_failed' });
      }
      if (typeof s.queryErrorAtIndex === 'number' && calls.filter((c) => c.method === 'query').length === s.queryErrorAtIndex) {
        throw Object.assign(new Error(String(s.queryErrorMessage || 'injected failure')), {
          code: s.queryErrorCode || 'query_failed',
        });
      }

      if (kind === 'BEGIN' || kind === 'COMMIT' || kind === 'ROLLBACK'
        || kind === 'SET LOCAL lock_timeout'
        || kind === 'SET LOCAL statement_timeout'
        || kind === 'SET LOCAL idle_in_transaction_session_timeout'
        || kind === 'pg_advisory_xact_lock') {
        return { rows: [], rowCount: 0 };
      }

      if (kind === 'assert_exact_sole_042') {
        return { rows: ledgerStore.slice().sort((a, b) => a.apply_order - b.apply_order), rowCount: ledgerStore.length };
      }

      if (kind === 'capture_ledger_txn_ts') {
        return { rows: [{ ledger_txn_ts: capturedTxnTs }], rowCount: 1 };
      }

      if (kind === 'insert_ledger_row') {
        if (s.failAtInsertIndex != null && inserted === s.failAtInsertIndex) {
          throw Object.assign(new Error('injected insert failure'), { code: 'query_failed' });
        }
        const row = {
          id: params[0],
          filename: params[1],
          checksum_sha256: params[2],
          apply_order: params[3],
          apply_kind: params[4],
          checksum_mode: params[5],
          evidence_ref: params[6],
          provenance_notes: params[7],
          applied_at: params[8],
          ledger_recorded_at: params[8],
        };
        ledgerStore.push(row);
        inserted += 1;
        return { rows: [], rowCount: 1 };
      }

      if (kind === 'verify_ledger_count') {
        return { rows: [{ cnt: ledgerStore.length }], rowCount: 1 };
      }

      if (kind === 'verify_ledger_rows') {
        return {
          rows: ledgerStore.slice().sort((a, b) => a.apply_order - b.apply_order),
          rowCount: ledgerStore.length,
        };
      }

      if (kind === 'verify_ledger_kind_counts') {
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
      ended = true;
      connected = false;
    },
  };
  return client;
}

function createScriptedRecoveryApplyFakeClientFactory(script) {
  return function FakeRecoveryClient() {
    return createScriptedRecoveryApplyFakeClient(script);
  };
}

/**
 * Executable one-time apply for the locked sole-042 partial ledger.
 * Requires an injected db client / Client seam — does not retrieve secrets or
 * open a live staging connection by itself.
 */
async function executeRecoveryMutation(input) {
  const options = input || {};

  if (options.dsn != null
    || options.connectionString != null
    || options.databaseUrl != null
    || options.host != null
    || options.database != null
    || options.sql != null
    || options.query != null) {
    return publicResult({
      ok: false,
      code: 'caller_supplied_connect_forbidden',
      certified: false,
      planOnly: false,
      dryRun: false,
      mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
      liveMutation: false,
      ledgerWritten: false,
      errors: [{
        code: 'caller_supplied_connect_forbidden',
        message: 'arbitrary DSN/host/database/SQL are refused',
      }],
    });
  }

  const gateInput = options.gates || {
    env: options.env,
    argv: options.argv,
    evidencePath: options.evidencePath,
    evidence: options.evidence,
    requestMutation: options.requestMutation != null
      ? options.requestMutation
      : true,
  };
  // Ensure apply flag is represented for gate evaluation when requestMutation is used.
  if (gateInput.requestMutation && Array.isArray(gateInput.argv)
    && !gateInput.argv.includes(CLI_APPLY_MUTATION)
    && !gateInput.argv.includes(CLI_PLAN_ONLY)) {
    gateInput.argv = [...gateInput.argv, CLI_APPLY_MUTATION];
  }

  const gates = evaluateRecoveryGates(gateInput);
  if (!gates.ok || !gates.requestApply) {
    return publicResult({
      ok: false,
      code: gates.code || 'apply_gates_refused',
      errors: gates.errors,
      certified: false,
      planOnly: gates.planOnly,
      dryRun: gates.dryRun,
      requestApply: gates.requestApply,
      mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
      liveMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
    });
  }

  let evidence = options.evidence;
  const evidencePath = gates.evidencePath || options.evidencePath;
  if (!evidence && evidencePath) {
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  }

  const certified = certifyContiguousBaseline({
    evidence,
    manifestPath: options.manifestPath,
    manifestContext: options.manifestContext,
    requireDigest: true,
  });
  if (!certified.ok) {
    return publicResult({
      ...certified,
      planOnly: false,
      dryRun: false,
      requestApply: true,
      liveMutation: false,
      ledgerWritten: false,
      mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
      slice: SLICE_ID,
    });
  }

  const proposedInserts = (certified.proposedInserts || []).map((r) => ({
    ...r,
    apply_kind: APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  }));
  try {
    assertStructuralOnlyInserts(proposedInserts);
  } catch (e) {
    return publicResult({
      ok: false,
      code: e.code || 'apply_kind_refused',
      errors: [{ code: e.code || 'apply_kind_refused', message: e.message }],
      certified: true,
      liveMutation: false,
      ledgerWritten: false,
      mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
      slice: SLICE_ID,
    });
  }

  let client = options.dbClient || null;
  let ownsClient = false;
  if (!client && typeof options.Client === 'function') {
    applyClientInstantiateCount += 1;
    client = new options.Client();
    ownsClient = true;
  }
  if (!client) {
    return publicResult({
      ok: false,
      code: 'db_client_required',
      certified: true,
      planOnly: false,
      dryRun: false,
      requestApply: true,
      mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
      liveMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      errors: [{
        code: 'db_client_required',
        message:
          'apply requires an injected db client seam; this slice does not retrieve DB secrets or open arbitrary DSNs',
      }],
      note: 'Operator must inject a locked-target client after collecting real staging structural evidence.',
      slice: SLICE_ID,
      evidenceDigest: certified.evidenceDigest,
      proposedInsertCount: proposedInserts.length,
    });
  }

  try {
    if (typeof client.connect === 'function') {
      await client.connect();
    }
    const queryBefore = applyQueryCallCount;
    const sequence = await runAuthorizedRecoveryApplySequence(client, {
      proposedInserts,
      forward: (options.manifestContext && options.manifestContext.forward)
        || loadLiveManifestContext(options.manifestPath).forward,
    });
    const out = {
      ...certified,
      ...sequence,
      ok: true,
      code: 'staging_ledger_recovery_apply_ok',
      certified: true,
      planOnly: false,
      dryRun: false,
      requestApply: true,
      mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
      slice: SLICE_ID,
      queryCalls: applyQueryCallCount - queryBefore,
      clientsInstantiated: ownsClient ? 1 : 0,
      proposedInsertCount: proposedInserts.length,
      applyKinds: { [APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE]: proposedInserts.length },
      note: 'One-time staging ledger recovery apply committed via injected client seam (not live-invoked by verifier).',
    };
    return publicResult(out);
  } catch (e) {
    const nested = e && e.result ? e.result : null;
    return publicResult({
      ok: false,
      code: (nested && nested.code) || e.code || 'query_failed',
      message: (nested && nested.message) || String(e.message || 'apply failed'),
      errors: [{
        code: (nested && nested.code) || e.code || 'query_failed',
        message: (nested && nested.message) || String(e.message || 'apply failed'),
      }],
      certified: true,
      planOnly: false,
      dryRun: false,
      requestApply: true,
      mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
      liveMutation: false,
      ledgerWritten: false,
      rolledBack: nested ? nested.rolledBack : undefined,
      steps: nested ? nested.steps : undefined,
      insertedRowCount: nested ? nested.insertedRowCount : 0,
      slice: SLICE_ID,
    });
  } finally {
    if (ownsClient && client && typeof client.end === 'function') {
      try {
        await client.end();
      } catch (_) {
        /* ignore */
      }
    }
  }
}

function publicResult(result) {
  const out = {};
  for (const key of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(result, key) && result[key] !== undefined) {
      out[key] = result[key];
    }
  }
  const secretGate = assertSecretFree(out, 'output');
  if (!secretGate.ok) {
    return {
      ok: false,
      code: 'secret_material_refused',
      planOnly: true,
      dryRun: true,
      mutationEnabled: false,
      liveMutation: false,
      errors: [secretGate],
    };
  }
  return out;
}

function sealEvidence(evidence) {
  const copy = { ...(evidence || {}) };
  delete copy.evidenceDigest;
  delete copy.digest;
  copy.immutable = true;
  copy.kind = EVIDENCE_KIND;
  copy.checksumMode = CHECKSUM_MODE_CANONICAL_LF_V1;
  copy.evidenceDigest = digestEvidencePayload(copy);
  return copy;
}

/**
 * Test/helper: build a minimal structurally-complete evidence artifact for the
 * locked sole-042 scenario. Assertions are explicit placeholders suitable for
 * offline contract tests — live collection belongs to a later slice.
 */
function buildFixtureEvidence(overrides) {
  const opts = overrides || {};
  const ctx = opts.manifestContext || loadLiveManifestContext(opts.manifestPath);
  const historicalNeeded = ctx.forward.filter((e) => e.order <= KNOWN_PARTIAL_SCENARIO.historicalOrderEnd);
  const applyKind = opts.applyKind || APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE;
  const historicalMigrations = historicalNeeded.map((e) => {
    const assertionId = `${e.id}::relation-present`;
    return {
      id: e.id,
      filename: e.filename,
      order: e.order,
      checksumSha256: e.sha256,
      applyKind,
      requiredAssertionIds: [assertionId],
      structuralAssertions: [{
        id: assertionId,
        satisfied: true,
        evidenceRef: `fixture:structural:${e.id}`,
        description: 'offline fixture structural assertion',
      }],
    };
  });

  const expected042 = ctx.forward.find((e) => e.order === KNOWN_PARTIAL_SCENARIO.soleRowOrder);
  const observedRow = {
    id: expected042.id,
    filename: expected042.filename,
    checksum_sha256: expected042.sha256,
    apply_order: expected042.order,
    apply_kind: opts.observedApplyKind || APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
    checksum_mode: CHECKSUM_MODE_CANONICAL_LF_V1,
    evidence_ref: 'observed:042',
    provenance_notes: 'pre-existing sole ledger row; provenance preserved not invented',
    ledger_recorded_at: '2026-07-21T00:00:00.000Z',
    applied_at: '2026-07-21T00:00:00.000Z',
  };

  const base = {
    kind: EVIDENCE_KIND,
    immutable: true,
    slice: SLICE_ID,
    checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
    target: { ...RECOVERY_TARGET },
    manifest: {
      manifestHash: ctx.manifestHash,
      forwardCount: ctx.forward.length,
      checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
    },
    observedLedger: {
      diagnosisCode: KNOWN_PARTIAL_SCENARIO.diagnosisCode,
      rows: [observedRow],
    },
    historicalMigrations,
    operatorApproval: {
      requiredToken: APPROVAL_TOKEN,
      requiredFlag: CLI_APPROVE,
    },
    notes: [
      'One-time staging recovery evidence for sole-042 partial ledger',
      'Does not invent historical runner provenance',
      'Apply records verified_structural_baseline only; never executed_by_canonical_runner',
      'Offline fixture placeholders — operator must collect real staging structural evidence before apply',
    ],
  };

  const merged = {
    ...base,
    ...(opts.evidence || {}),
    target: { ...base.target, ...((opts.evidence && opts.evidence.target) || {}), ...(opts.target || {}) },
    manifest: { ...base.manifest, ...((opts.evidence && opts.evidence.manifest) || {}), ...(opts.manifest || {}) },
    observedLedger: {
      ...base.observedLedger,
      ...((opts.evidence && opts.evidence.observedLedger) || {}),
      ...(opts.observedLedger || {}),
    },
    historicalMigrations: opts.historicalMigrations || base.historicalMigrations,
  };

  if (opts.seal === false) return merged;
  return sealEvidence(merged);
}

function exactRecoveryPlanArgv(evidencePath) {
  const argv = [
    CLI_PLAN_ONLY,
    CLI_APPROVE,
    '--subscription', RECOVERY_TARGET.subscriptionId,
    '--resource-group', RECOVERY_TARGET.resourceGroup,
    '--postgres-server', RECOVERY_TARGET.postgresServer,
    '--database', RECOVERY_TARGET.database,
  ];
  if (evidencePath) argv.push(CLI_EVIDENCE, evidencePath);
  return argv;
}

function exactRecoveryApplyArgv(evidencePath) {
  const argv = [
    CLI_APPLY_MUTATION,
    CLI_APPROVE,
    '--subscription', RECOVERY_TARGET.subscriptionId,
    '--resource-group', RECOVERY_TARGET.resourceGroup,
    '--postgres-server', RECOVERY_TARGET.postgresServer,
    '--database', RECOVERY_TARGET.database,
  ];
  if (evidencePath) argv.push(CLI_EVIDENCE, evidencePath);
  return argv;
}

function recoveryPlanEnv(extra) {
  return {
    [ENV_RECOVERY]: '1',
    [ENV_APPROVAL_TOKEN]: APPROVAL_TOKEN,
    AZURE_SUBSCRIPTION_ID: RECOVERY_TARGET.subscriptionId,
    ...(extra || {}),
  };
}

module.exports = {
  STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
  EVIDENCE_KIND,
  SLICE_ID,
  APPLICATION_NAME,
  ENV_RECOVERY,
  ENV_APPROVAL_TOKEN,
  CLI_PLAN_ONLY,
  CLI_APPROVE,
  CLI_EVIDENCE,
  CLI_APPLY_MUTATION,
  APPROVAL_TOKEN,
  KNOWN_PARTIAL_SCENARIO,
  RECOVERY_INSERT_COUNT,
  RECOVERY_TARGET,
  APPLY_LOCKS,
  AUTHORIZED_APPLY_SEQUENCE,
  SUCCESS_PATH_QUERY_COUNT,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  ALLOWED_RECOVERY_APPLY_KINDS,
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  BASELINE_APPLY_KINDS,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  LEDGER_INSERT_SQL,
  LEDGER_SELECT_ALL_SQL,
  ADVISORY_LOCK_SQL,
  stableStringify,
  digestEvidencePayload,
  digestProposedRows,
  assertSecretFree,
  isProductionTarget,
  assertStagingOnlyTarget,
  evaluateRecoveryGates,
  validateStructuralAssertions,
  validateEvidenceArtifact,
  loadLiveManifestContext,
  certifyContiguousBaseline,
  buildRecoveryPlan,
  executeRecoveryMutation,
  runAuthorizedRecoveryApplySequence,
  createScriptedRecoveryApplyFakeClient,
  createScriptedRecoveryApplyFakeClientFactory,
  buildAuthorizedRecoveryApplySequence,
  resetRecoveryApplyCounters,
  getRecoveryApplyCounters,
  publicResult,
  sealEvidence,
  buildFixtureEvidence,
  exactRecoveryPlanArgv,
  exactRecoveryApplyArgv,
  recoveryPlanEnv,
  forwardEntries,
  reconcileLedger,
};
