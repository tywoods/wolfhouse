'use strict';

/**
 * Staging ledger recovery — one-time plan/certification contract.
 *
 * Context: Sunset staging schema_migration_ledger may contain only 042 while the
 * canonical forward chain has older migrations, so reconcileLedger correctly
 * fails closed with ledger_partial_history.
 *
 * This slice owns repository tooling that can certify a contiguous baseline
 * recovery plan ONLY after an immutable evidence artifact supplies explicit
 * structural assertions for every applicable historical migration.
 *
 * Hard rules for this slice:
 * - Dry-run / plan-only by default
 * - Executable mutation mode remains DISABLED (later separately-approved slice)
 * - Never invent historical provenance
 * - Never label recovery rows executed_by_canonical_runner
 * - Never print secrets/DSN
 * - Never accept generic arbitrary SQL
 * - Staging-only target lock; refuse production
 * - Fail closed on partial/incomplete evidence, checksum/target mismatch,
 *   missing assertions/approval, or non-contiguous projected baseline
 *
 * Reuses migration-integrity terminology (apply_kind, checksumMode,
 * reconcileLedger, ledger_partial_history). Does not weaken reconciliation.
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
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  reconcileLedger,
  sha256Buffer,
} = require('./migration-integrity');
const { hashCanonicalManifest, EXPECTED_HOST, EXPECTED_DATABASE } = require('./sunset-schema-observer');
const { TARGETS } = require('./phase-d-live-readonly-boundary');
const { scanSecretValues } = require('./sunset-staging-iac-drift');

/** Hard-disabled for this slice. A later approved slice must flip this explicitly. */
const STAGING_LEDGER_RECOVERY_MUTATION_ENABLED = false;

const EVIDENCE_KIND = 'staging-ledger-recovery-evidence-v1';
const SLICE_ID = 'staging-ledger-recovery';
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

const FORBIDDEN_ARGV_FLAGS = Object.freeze([
  CLI_APPLY_MUTATION,
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
]);

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

  if (!flags.has(CLI_PLAN_ONLY)) {
    errors.push({
      code: 'plan_only_required',
      message: `${CLI_PLAN_ONLY} is required (dry-run default; mutation disabled)`,
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

  if (flags.has(CLI_APPLY_MUTATION) || options.requestMutation === true) {
    errors.push({
      code: 'mutation_disabled',
      message: 'executable mutation mode is disabled in this slice',
    });
  }

  if (STAGING_LEDGER_RECOVERY_MUTATION_ENABLED !== false) {
    errors.push({
      code: 'mutation_flag_corrupt',
      message: 'STAGING_LEDGER_RECOVERY_MUTATION_ENABLED must remain false in this slice',
    });
  }

  const evidencePath = values[CLI_EVIDENCE] || options.evidencePath || null;

  return {
    ok: errors.length === 0,
    errors,
    planOnly: true,
    dryRun: true,
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
      ? 'Dry-run certification only. Mutation remains disabled until a later approved slice.'
      : undefined,
  };
}

function buildRecoveryPlan(input) {
  const options = input || {};
  const gateInput = options.gates || {
    env: options.env,
    argv: options.argv,
    evidencePath: options.evidencePath,
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

/**
 * Executable mutation mode — hard-disabled in this slice.
 * Always refuses; does not connect to any database.
 */
function executeRecoveryMutation() {
  return {
    ok: false,
    code: 'mutation_disabled',
    certified: false,
    planOnly: true,
    dryRun: true,
    mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
    liveMutation: false,
    errors: [{
      code: 'mutation_disabled',
      message:
        'staging ledger recovery mutation is disabled until a later separately-approved slice enables it',
    }],
    message: 'mutation_disabled',
  };
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
      'Mutation disabled in this slice',
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
  RECOVERY_TARGET,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  ALLOWED_RECOVERY_APPLY_KINDS,
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  BASELINE_APPLY_KINDS,
  CHECKSUM_MODE_CANONICAL_LF_V1,
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
  publicResult,
  sealEvidence,
  buildFixtureEvidence,
  exactRecoveryPlanArgv,
  recoveryPlanEnv,
  forwardEntries,
  reconcileLedger,
};
