'use strict';

/**
 * Sunset staging ledger reconcile — Email 2F-C3-b1.
 *
 * One atomic, approval-gated transaction for the known split:
 *   ledger contiguous through 055; 056+060 schema pre-applied out-of-band; 057–059 absent.
 *
 * Final ledger (manifest orders 54–58):
 *   056 + 060 → verified_structural_baseline (no DDL re-execution)
 *   057 + 058 + 059 → executed_by_canonical_runner (canonical SQL + ledger)
 *
 * Hard-locked to Sunset staging only. Does not broaden Wolfhouse staging-ledger-recovery.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  LEDGER_SELECT_COLUMNS,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  reconcileLedger,
  prepareMigrationBody,
  checksumMigrationFile,
  buildExecutedByCanonicalRunnerProvenance,
  SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET,
  assertSafeDatabaseTarget,
} = require('./migration-integrity');
const { scanSecretValues } = require('./sunset-staging-iac-drift');

const SLICE_ID = 'sunset-staging-ledger-reconcile-056-060';
const EVIDENCE_KIND = 'sunset-staging-ledger-reconcile-evidence-v1';
const APPLICATION_NAME = 'wh-sunset-ledger-reconcile-056-060';

const ENV_ENABLED = 'SUNSET_STAGING_LEDGER_RECONCILE';
const ENV_TOKEN = 'SUNSET_STAGING_LEDGER_RECONCILE_APPROVAL_TOKEN';
const ENV_EMAIL_COMPOSITION = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED';

const CLI_DRY_RUN = '--dry-run';
const CLI_APPLY = '--apply-sunset-ledger-reconcile';
const CLI_APPROVE = '--approve-sunset-ledger-reconcile';
const CLI_EVIDENCE = '--evidence';

const APPROVAL_PREFIX = 'APPROVE-SUNSET-056060-';

const RECONCILE_TARGET = Object.freeze({
  environment: 'staging',
  subscriptionId: '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9',
  resourceGroup: 'luna-sunset-staging-rg',
  postgresServer: 'luna-sunset-staging-pg-app',
  postgresHost: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.host,
  database: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.database,
  port: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.port,
  sslmode: 'verify-full',
  applicationName: APPLICATION_NAME,
});

const LOCKED_MIGRATION_IDS = Object.freeze([
  '056_booking_refund_records',
  '057_tenant_locations_and_channel_endpoints',
  '058_tenant_channel_endpoint_identity',
  '059_tenant_email_delegated_grants',
  '060_bookings_hidden',
]);

const BASELINE_IDS = new Set([
  '056_booking_refund_records',
  '060_bookings_hidden',
]);

const RUNNER_IDS = new Set([
  '057_tenant_locations_and_channel_endpoints',
  '058_tenant_channel_endpoint_identity',
  '059_tenant_email_delegated_grants',
]);

const PREFIX_END_ORDER = 53;
const PREFIX_END_ID = '055_tenant_rental_offering_stock';
const TIP_ORDER = 58;

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_DRY_RUN,
  CLI_APPLY,
  CLI_APPROVE,
  CLI_EVIDENCE,
  '--subscription',
  '--resource-group',
  '--postgres-server',
  '--database',
  '--help',
  '-h',
]);

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
  '--force',
  '--repair',
  '--migrate',
  '--run-migrations',
  '--apply-ledger-baseline',
  '--apply-ledger-recovery',
]);

const SET_LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5000ms'";
const SET_STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '30000ms'";
const SET_IDLE_TIMEOUT_SQL = "SET LOCAL idle_in_transaction_session_timeout = '60000ms'";
const ADVISORY_XACT_LOCK_SQL = 'SELECT pg_advisory_xact_lock($1, $2)';
const LEDGER_TXN_TS_SQL = 'SELECT NOW() AS ledger_txn_ts';

const LEDGER_SELECT_SQL = [
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

const SAFE_OUTPUT_KEYS = Object.freeze([
  'ok', 'code', 'slice', 'dryRun', 'requestApply', 'certified', 'liveMutation',
  'ledgerWritten', 'schemaMutation', 'dataMutation', 'rolledBack', 'committed',
  'errors', 'message', 'note', 'evidenceDigest', 'planDigest',
  'target', 'manifestDigest', 'catalogFingerprint', 'ledgerRowCount', 'reconcileOk',
  'appliedIds', 'steps', 'queryCalls', 'clientsInstantiated',
]);

let reconcileQueryCallCount = 0;

function resetReconcileCounters() {
  reconcileQueryCallCount = 0;
}

function getReconcileCounters() {
  return { queryCalls: reconcileQueryCallCount };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function digestEvidencePayload(evidence) {
  const copy = { ...(evidence || {}) };
  delete copy.evidenceDigest;
  return sha256Text(stableStringify(copy));
}

function digestPlan(entries) {
  return sha256Text(stableStringify((entries || []).map((e) => ({
    id: e.id,
    order: e.order,
    filename: e.filename,
    sha256: e.sha256,
    applyKind: BASELINE_IDS.has(e.id)
      ? APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE
      : APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  }))));
}

function deriveApprovalToken(evidenceDigestValue, planDigestValue) {
  return `${APPROVAL_PREFIX}${sha256Text(`${evidenceDigestValue}:${planDigestValue}`).slice(0, 32)}`;
}

function truthyEnv(v) {
  return /^(1|true|yes)$/i.test(String(v || '').trim());
}

function assertSecretFree(payload, label) {
  const hits = scanSecretValues(payload);
  if (hits.length) {
    return {
      ok: false,
      code: 'secret_material_refused',
      message: `${label || 'payload'} contains forbidden secret material`,
    };
  }
  return { ok: true };
}

function publicResult(result) {
  const out = {};
  for (const key of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(result, key) && result[key] !== undefined) {
      out[key] = result[key];
    }
  }
  const gate = assertSecretFree(out, 'output');
  if (!gate.ok) return { ok: false, code: gate.code, errors: [gate] };
  return out;
}

function parseArgvFlags(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const flags = new Set();
  const values = {};
  const errors = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a === '-h' || a === '--help') {
      flags.add(a);
      continue;
    }
    if (!a.startsWith('--')) {
      errors.push({ code: 'positional_argv_refused', message: 'positional argv refused' });
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      const flag = a.slice(0, eq);
      flags.add(flag);
      values[flag] = a.slice(eq + 1);
      continue;
    }
    flags.add(a);
    const next = args[i + 1];
    if (next && !String(next).startsWith('-')) {
      values[a] = String(next);
      i += 1;
    }
  }
  return { flags, values, errors };
}

function assertLockedTarget(candidate) {
  return assertLockedTargetInternal(candidate);
}

function assertLockedTargetInternal(candidate) {
  const errors = [];
  const t = candidate || {};
  const checks = [
    ['environment', RECONCILE_TARGET.environment],
    ['subscriptionId', RECONCILE_TARGET.subscriptionId],
    ['resourceGroup', RECONCILE_TARGET.resourceGroup],
    ['postgresServer', RECONCILE_TARGET.postgresServer],
    ['postgresHost', RECONCILE_TARGET.postgresHost],
    ['database', RECONCILE_TARGET.database],
    ['port', String(RECONCILE_TARGET.port)],
    ['applicationName', RECONCILE_TARGET.applicationName],
  ];
  for (const [key, want] of checks) {
    if (String(t[key] ?? '') !== String(want)) {
      errors.push({ code: `target_${key}_mismatch`, message: `${key} must match locked Sunset staging target` });
    }
  }
  const safe = assertSafeDatabaseTarget(
    { host: t.postgresHost, database: t.database, port: Number(t.port) },
    { allowSunsetStagingCanonicalRunnerNoop: true },
  );
  if (!safe.ok) errors.push(...safe.errors);
  return { ok: errors.length === 0, errors };
}

function lockedMigrationEntries(manifest) {
  const forward = forwardEntries(manifest);
  const byId = new Map(forward.map((e) => [e.id, e]));
  const entries = LOCKED_MIGRATION_IDS.map((id) => byId.get(id));
  if (entries.some((e) => !e)) {
    throw Object.assign(new Error('manifest missing locked migration id'), { code: 'manifest_scope_mismatch' });
  }
  const orders = entries.map((e) => Number(e.order));
  if (orders.join(',') !== '54,55,56,57,58') {
    throw Object.assign(new Error('locked migrations must be manifest orders 54..58'), { code: 'manifest_order_mismatch' });
  }
  for (const e of entries) {
    const abs = path.join(MIGRATIONS_DIR, e.filename);
    const live = checksumMigrationFile(abs, CHECKSUM_MODE_CANONICAL_LF_V1);
    if (!live.ok || live.sha256 !== e.sha256) {
      throw Object.assign(new Error(`disk/manifest checksum mismatch: ${e.id}`), { code: 'checksum_mismatch' });
    }
  }
  return entries;
}

function loadManifestContext(manifestPath) {
  const manifest = loadManifest(manifestPath || MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) {
    throw Object.assign(new Error('manifest integrity failed'), { code: 'manifest_integrity_failed', errors: integrity.errors });
  }
  const forward = forwardEntries(manifest);
  const entries = lockedMigrationEntries(manifest);
  const manifestDigest = sha256Text(stableStringify(entries.map((e) => ({
    id: e.id, order: e.order, filename: e.filename, sha256: e.sha256,
  }))));
  return { manifest, forward, entries, manifestDigest, integrity };
}

function evaluateReconcileGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const parsed = parseArgvFlags(options.argv || []);
  const errors = parsed.errors.slice();
  const requestApply = parsed.flags.has(CLI_APPLY);
  const dryRun = parsed.flags.has(CLI_DRY_RUN);

  for (const f of parsed.flags) {
    if (FORBIDDEN_ARGV_FLAGS.includes(f)) {
      errors.push({ code: 'forbidden_argv', message: `forbidden argv ${f}`, flag: f });
    } else if (!ALLOWED_ARGV_FLAGS.includes(f)) {
      errors.push({ code: 'unknown_argv', message: `unknown argv ${f}`, flag: f });
    }
  }

  if (String(env[ENV_ENABLED] || '') !== '1') {
    errors.push({ code: 'reconcile_env_required', message: `${ENV_ENABLED}=1 is required` });
  }

  if (truthyEnv(env[ENV_EMAIL_COMPOSITION])) {
    errors.push({ code: 'email_composition_enabled_refused', message: 'email runtime composition must remain off' });
  }

  if ((requestApply && dryRun) || (!requestApply && !dryRun)) {
    errors.push({ code: 'exactly_one_mode_required', message: 'exactly one of --dry-run or --apply-sunset-ledger-reconcile is required' });
  }

  if (!parsed.flags.has(CLI_APPROVE)) {
    errors.push({ code: 'approval_flag_required', message: `${CLI_APPROVE} is required` });
  }

  const token = String(env[ENV_TOKEN] || '');
  if (!token) {
    errors.push({ code: 'approval_token_required', message: `${ENV_TOKEN} is required` });
  } else if (!token.startsWith(APPROVAL_PREFIX) || token.length !== APPROVAL_PREFIX.length + 32) {
    errors.push({ code: 'approval_token_malformed', message: 'approval token format invalid' });
  }

  const evidencePath = parsed.values[CLI_EVIDENCE] || options.evidencePath || null;
  if (!evidencePath && !options.evidence) {
    errors.push({ code: 'evidence_required', message: `${CLI_EVIDENCE} <path> or injected evidence is required` });
  }

  const target = {
    ...RECONCILE_TARGET,
    subscriptionId: parsed.values['--subscription'] || RECONCILE_TARGET.subscriptionId,
    resourceGroup: parsed.values['--resource-group'] || RECONCILE_TARGET.resourceGroup,
    postgresServer: parsed.values['--postgres-server'] || RECONCILE_TARGET.postgresServer,
    database: parsed.values['--database'] || RECONCILE_TARGET.database,
    postgresHost: RECONCILE_TARGET.postgresHost,
    port: RECONCILE_TARGET.port,
    applicationName: RECONCILE_TARGET.applicationName,
    environment: RECONCILE_TARGET.environment,
  };
  const targetGate = assertLockedTargetInternal(target);
  if (!targetGate.ok) errors.push(...targetGate.errors);

  let evidenceDigest = null;
  let planDigestValue = null;
  let expectedToken = null;
  if (options.evidence && errors.length === 0) {
    try {
      const ctx = options.context || loadManifestContext(options.manifestPath);
      const evGate = validateEvidenceArtifact(options.evidence, ctx);
      if (!evGate.ok) errors.push(...evGate.errors);
      else {
        evidenceDigest = evGate.evidenceDigest;
        planDigestValue = digestPlan(ctx.entries);
        expectedToken = deriveApprovalToken(evidenceDigest, planDigestValue);
        if (token && expectedToken && token !== expectedToken) {
          errors.push({ code: 'approval_token_mismatch', message: 'approval token does not match evidence+plan digest' });
        }
        if (options.evidence.planDigest && options.evidence.planDigest !== planDigestValue) {
          errors.push({ code: 'plan_digest_mismatch', message: 'sealed planDigest mismatch' });
        }
      }
    } catch (e) {
      errors.push({ code: e.code || 'evidence_validation_failed', message: String(e.message || e).slice(0, 200) });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    requestApply,
    dryRun,
    parsed,
    target,
    evidencePath,
    evidenceDigest,
    planDigest: planDigestValue,
    expectedToken,
  };
}

function validateEvidenceArtifact(evidence, ctx) {
  const errors = [];
  if (!evidence || evidence.kind !== EVIDENCE_KIND) {
    errors.push({ code: 'evidence_kind_mismatch', message: 'evidence kind must be sunset-staging-ledger-reconcile-evidence-v1' });
  }
  if (!evidence || evidence.immutable !== true) {
    errors.push({ code: 'evidence_not_immutable', message: 'evidence must be immutable' });
  }
  if ((evidence || {}).checksumMode !== CHECKSUM_MODE_CANONICAL_LF_V1) {
    errors.push({ code: 'checksum_mode_mismatch', message: 'checksumMode must be canonical_lf_v1' });
  }
  const digest = digestEvidencePayload(evidence);
  if (!evidence || evidence.evidenceDigest !== digest) {
    errors.push({ code: 'evidence_digest_mismatch', message: 'evidenceDigest mismatch' });
  }
  if (!evidence || evidence.manifestDigest !== ctx.manifestDigest) {
    errors.push({ code: 'manifest_digest_mismatch', message: 'manifestDigest mismatch' });
  }
  const targetGate = assertLockedTargetInternal((evidence || {}).target);
  if (!targetGate.ok) errors.push(...targetGate.errors);
  const fp = String((evidence || {}).catalogFingerprint || '');
  if (!/^[0-9a-f]{64}$/.test(fp)) {
    errors.push({ code: 'catalog_fingerprint_missing', message: 'catalogFingerprint required' });
  }
  const rows = (evidence || {}).ledgerRows || [];
  if (rows.length !== PREFIX_END_ORDER) {
    errors.push({ code: 'ledger_prefix_count_mismatch', message: `ledgerRows must contain exactly ${PREFIX_END_ORDER} rows` });
  }
  for (let i = 0; i < rows.length; i += 1) {
    if (Number(rows[i].apply_order) !== i + 1) {
      errors.push({ code: 'ledger_prefix_not_contiguous', message: 'ledgerRows must be contiguous from order 1' });
      break;
    }
  }
  if (rows.length && String(rows[rows.length - 1].id) !== PREFIX_END_ID) {
    errors.push({ code: 'ledger_prefix_end_mismatch', message: `ledger must end at ${PREFIX_END_ID}` });
  }
  for (const id of LOCKED_MIGRATION_IDS) {
    if (rows.some((r) => r.id === id)) {
      errors.push({ code: 'pending_migration_already_ledgered', message: `${id} must not be present in pre-apply ledger` });
    }
  }
  return { ok: errors.length === 0, errors, evidenceDigest: digest };
}

function sealEvidence(evidence) {
  const copy = {
    ...(evidence || {}),
    kind: EVIDENCE_KIND,
    immutable: true,
    checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
    target: { ...RECONCILE_TARGET },
  };
  delete copy.evidenceDigest;
  if (!copy.planDigest && copy._planDigest) copy.planDigest = copy._planDigest;
  copy.evidenceDigest = digestEvidencePayload(copy);
  return copy;
}

const STRUCTURAL_PROBE_SQL = `
SELECT
  to_regclass('public.booking_refund_records') IS NOT NULL AS has_056_table,
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='bookings_id_client_id_uidx') AS has_056_bookings_uidx,
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='booking_refund_records_client_idempotency_uidx') AS has_056_idem_uidx,
  (SELECT COUNT(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='booking_refund_records' AND NOT t.tgisinternal) AS refund_trigger_count,
  to_regclass('public.tenant_locations') IS NOT NULL AS has_057_locations,
  to_regclass('public.tenant_channel_endpoints') IS NOT NULL AS has_057_endpoints,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tenant_channel_endpoints' AND column_name='connector_mode') AS has_058_connector_mode,
  to_regclass('public.tenant_email_delegated_grants') IS NOT NULL AS has_059_grants,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tenant_channel_endpoints_client_id_id_uq') AS has_059_endpoint_uq,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bookings' AND column_name='hidden') AS has_060_hidden,
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='bookings_hidden_true_idx') AS has_060_hidden_idx
`;

function catalogFingerprintFromProbe(row) {
  return sha256Text(stableStringify(row || {}));
}

function assertPreApplyStructural(row) {
  const errors = [];
  if (!row.has_056_table) errors.push({ code: 'structural_056_table_missing' });
  if (!row.has_056_bookings_uidx) errors.push({ code: 'structural_056_bookings_uidx_missing' });
  if (!row.has_056_idem_uidx) errors.push({ code: 'structural_056_idem_uidx_missing' });
  if (Number(row.refund_trigger_count) < 2) errors.push({ code: 'structural_056_triggers_missing' });
  if (!row.has_060_hidden) errors.push({ code: 'structural_060_hidden_missing' });
  if (!row.has_060_hidden_idx) errors.push({ code: 'structural_060_hidden_idx_missing' });
  if (row.has_057_locations || row.has_057_endpoints) errors.push({ code: 'structural_057_unexpected' });
  if (row.has_058_connector_mode) errors.push({ code: 'structural_058_unexpected' });
  if (row.has_059_grants || row.has_059_endpoint_uq) errors.push({ code: 'structural_059_unexpected' });
  return { ok: errors.length === 0, errors };
}

function assertPostApplyStructural(row) {
  const errors = [];
  if (!row.has_057_locations || !row.has_057_endpoints) errors.push({ code: 'structural_057_missing' });
  if (!row.has_058_connector_mode) errors.push({ code: 'structural_058_missing' });
  if (!row.has_059_grants || !row.has_059_endpoint_uq) errors.push({ code: 'structural_059_missing' });
  return { ok: errors.length === 0, errors };
}

async function probeStructuralState(client) {
  reconcileQueryCallCount += 1;
  const res = await client.query(STRUCTURAL_PROBE_SQL);
  const row = (res.rows && res.rows[0]) || {};
  return { row, fingerprint: catalogFingerprintFromProbe(row) };
}

async function loadLedgerRows(client) {
  reconcileQueryCallCount += 1;
  const res = await client.query(LEDGER_SELECT_SQL);
  return res.rows || [];
}

function assertLedgerPrefix(rows) {
  const errors = [];
  if (!Array.isArray(rows) || rows.length !== PREFIX_END_ORDER) {
    errors.push({ code: 'ledger_prefix_count_mismatch', message: `expected ${PREFIX_END_ORDER} ledger rows` });
    return { ok: false, errors };
  }
  for (let i = 0; i < rows.length; i += 1) {
    if (Number(rows[i].apply_order) !== i + 1) {
      errors.push({ code: 'ledger_prefix_not_contiguous', message: 'ledger apply_order gap' });
      break;
    }
  }
  if (String(rows[rows.length - 1].id) !== PREFIX_END_ID) {
    errors.push({ code: 'ledger_prefix_end_mismatch', message: `last row must be ${PREFIX_END_ID}` });
  }
  for (const id of LOCKED_MIGRATION_IDS) {
    if (rows.some((r) => r.id === id)) {
      errors.push({ code: 'pending_migration_already_ledgered', message: `${id} already in ledger` });
    }
  }
  return { ok: errors.length === 0, errors };
}

async function insertBaselineLedgerRow(client, entry, txnTs, evidenceDigestValue, suffix) {
  reconcileQueryCallCount += 1;
  await client.query(LEDGER_INSERT_SQL, [
    entry.id,
    entry.filename,
    entry.sha256,
    entry.order,
    APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
    CHECKSUM_MODE_CANONICAL_LF_V1,
    `sunset-reconcile:${evidenceDigestValue}:${suffix}`,
    'verified_structural_baseline: DDL applied out-of-band before reconcile; not re-executed',
    txnTs,
  ]);
}

async function applyMigrationInTransaction(client, entry, migrationsDir, txnTs) {
  const abs = path.join(migrationsDir || MIGRATIONS_DIR, entry.filename);
  const live = checksumMigrationFile(abs, CHECKSUM_MODE_CANONICAL_LF_V1);
  if (!live.ok || live.sha256 !== entry.sha256) {
    throw Object.assign(new Error(`checksum mismatch: ${entry.id}`), { code: 'checksum_mismatch' });
  }
  const prepared = prepareMigrationBody(fs.readFileSync(abs, 'utf8'));
  if (!prepared.ok) {
    throw Object.assign(new Error(prepared.message || 'txn prepare failed'), { code: prepared.code || 'txn_prepare_failed' });
  }
  reconcileQueryCallCount += 1;
  await client.query(prepared.body);
  const provenance = buildExecutedByCanonicalRunnerProvenance(entry);
  reconcileQueryCallCount += 1;
  await client.query(LEDGER_INSERT_SQL, [
    entry.id,
    entry.filename,
    entry.sha256,
    entry.order,
    provenance.apply_kind,
    provenance.checksum_mode,
    provenance.evidence_ref,
    provenance.provenance_notes,
    txnTs,
  ]);
}

async function executeReconcileDryRun(options) {
  const gates = evaluateReconcileGates(options);
  if (!gates.ok) {
    return publicResult({
      ok: false, code: gates.errors[0]?.code || 'gate_refused', dryRun: true,
      requestApply: false, errors: gates.errors, liveMutation: false, ledgerWritten: false,
    });
  }
  const ctx = options.context || loadManifestContext(options.manifestPath);
  let evidence = options.evidence;
  if (!evidence && gates.evidencePath) evidence = JSON.parse(fs.readFileSync(gates.evidencePath, 'utf8'));
  const ev = validateEvidenceArtifact(evidence, ctx);
  if (!ev.ok) {
    return publicResult({
      ok: false, code: ev.errors[0].code, dryRun: true, errors: ev.errors, certified: false,
    });
  }
  const planDigestValue = digestPlan(ctx.entries);
  const approvalToken = deriveApprovalToken(ev.evidenceDigest, planDigestValue);
  if (String(options.env?.[ENV_TOKEN] || '') !== approvalToken) {
    return publicResult({
      ok: false, code: 'approval_token_mismatch', dryRun: true, errors: [{ code: 'approval_token_mismatch' }],
    });
  }
  if (!options.client) {
    return publicResult({
      ok: true, code: 'sunset_ledger_reconcile_dry_run_certified', dryRun: true, certified: true,
      evidenceDigest: ev.evidenceDigest, planDigest: planDigestValue, approvalToken,
      target: RECONCILE_TARGET, manifestDigest: ctx.manifestDigest,
      note: 'Gate+evidence certified; inject client for live structural readback before apply',
      liveMutation: false, ledgerWritten: false, schemaMutation: false,
    });
  }
  const client = options.client;
  const structural = await probeStructuralState(client);
  if (structural.fingerprint !== evidence.catalogFingerprint) {
    return publicResult({
      ok: false, code: 'catalog_fingerprint_mismatch', dryRun: true,
      errors: [{ code: 'catalog_fingerprint_mismatch' }],
    });
  }
  const structGate = assertPreApplyStructural(structural.row);
  if (!structGate.ok) {
    return publicResult({ ok: false, code: structGate.errors[0].code, dryRun: true, errors: structGate.errors });
  }
  const ledgerRows = await loadLedgerRows(client);
  const ledgerGate = assertLedgerPrefix(ledgerRows);
  if (!ledgerGate.ok) {
    return publicResult({ ok: false, code: ledgerGate.errors[0].code, dryRun: true, errors: ledgerGate.errors });
  }
  return publicResult({
    ok: true, code: 'sunset_ledger_reconcile_dry_run_ok', dryRun: true, certified: true,
    evidenceDigest: ev.evidenceDigest, planDigest: planDigestValue, approvalToken,
    catalogFingerprint: structural.fingerprint, ledgerRowCount: ledgerRows.length,
    reconcileOk: true, liveMutation: false, ledgerWritten: false, schemaMutation: false,
    target: RECONCILE_TARGET,
  });
}

async function executeReconcileMutation(options) {
  const gates = evaluateReconcileGates({ ...options, evidence: options.evidence });
  if (!gates.ok || !gates.requestApply) {
    return publicResult({
      ok: false, code: gates.errors[0]?.code || 'gate_refused', requestApply: gates.requestApply,
      errors: gates.errors, liveMutation: false,
    });
  }
  const ctx = options.context || loadManifestContext(options.manifestPath);
  let evidence = options.evidence;
  if (!evidence && gates.evidencePath) evidence = JSON.parse(fs.readFileSync(gates.evidencePath, 'utf8'));
  const ev = validateEvidenceArtifact(evidence, ctx);
  if (!ev.ok) {
    return publicResult({ ok: false, code: ev.errors[0].code, errors: ev.errors, certified: false });
  }
  const planDigestValue = digestPlan(ctx.entries);
  const approvalToken = deriveApprovalToken(ev.evidenceDigest, planDigestValue);
  if (String(options.env?.[ENV_TOKEN] || '') !== approvalToken) {
    return publicResult({ ok: false, code: 'approval_token_mismatch', errors: [{ code: 'approval_token_mismatch' }] });
  }
  if (!options.client || typeof options.client.query !== 'function') {
    return publicResult({
      ok: false, code: 'db_client_required',
      note: 'Apply requires injected client bound to locked Sunset target after live structural evidence collection',
      certified: true, evidenceDigest: ev.evidenceDigest, planDigest: planDigestValue,
    });
  }

  const client = options.client;
  let began = false;
  const steps = [];
  try {
    reconcileQueryCallCount += 1;
    await client.query('BEGIN');
    began = true;
    steps.push('BEGIN');
    await client.query(SET_LOCK_TIMEOUT_SQL);
    await client.query(SET_STATEMENT_TIMEOUT_SQL);
    await client.query(SET_IDLE_TIMEOUT_SQL);
    reconcileQueryCallCount += 1;
    await client.query(ADVISORY_XACT_LOCK_SQL, [ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2]);
    steps.push('advisory_xact_lock');

    const structural = await probeStructuralState(client);
    if (structural.fingerprint !== evidence.catalogFingerprint) {
      throw Object.assign(new Error('catalog fingerprint mismatch inside transaction'), { code: 'catalog_fingerprint_mismatch' });
    }
    const structGate = assertPreApplyStructural(structural.row);
    if (!structGate.ok) {
      const err = new Error('pre-apply structural assertion failed');
      err.code = structGate.errors[0].code;
      err.errors = structGate.errors;
      throw err;
    }

    const ledgerBefore = await loadLedgerRows(client);
    const ledgerGate = assertLedgerPrefix(ledgerBefore);
    if (!ledgerGate.ok) {
      const err = new Error('ledger prefix invalid');
      err.code = ledgerGate.errors[0].code;
      throw err;
    }

    reconcileQueryCallCount += 1;
    const tsRes = await client.query(LEDGER_TXN_TS_SQL);
    const txnTs = tsRes.rows[0].ledger_txn_ts;
    steps.push('capture_txn_ts');

    const [e056, e057, e058, e059, e060] = ctx.entries;
    await insertBaselineLedgerRow(client, e056, txnTs, ev.evidenceDigest, '056');
    steps.push('ledger_056_baseline');
    await applyMigrationInTransaction(client, e057, options.migrationsDir, txnTs);
    steps.push('apply_057');
    await applyMigrationInTransaction(client, e058, options.migrationsDir, txnTs);
    steps.push('apply_058');
    await applyMigrationInTransaction(client, e059, options.migrationsDir, txnTs);
    steps.push('apply_059');
    await insertBaselineLedgerRow(client, e060, txnTs, ev.evidenceDigest, '060');
    steps.push('ledger_060_baseline');

    const ledgerAfter = await loadLedgerRows(client);
    const recon = reconcileLedger(ctx.forward, ledgerAfter);
    if (!recon.ok || ledgerAfter.length !== TIP_ORDER) {
      throw Object.assign(new Error('post-write reconcile failed'), {
        code: 'post_reconcile_failed',
        reconcileErrors: recon.errors,
      });
    }

    const postStruct = await probeStructuralState(client);
    const postGate = assertPostApplyStructural(postStruct.row);
    if (!postGate.ok) {
      throw Object.assign(new Error('post-apply structural missing'), { code: postGate.errors[0].code });
    }

    reconcileQueryCallCount += 1;
    await client.query('COMMIT');
    steps.push('COMMIT');
    began = false;

    return publicResult({
      ok: true,
      code: 'sunset_ledger_reconcile_applied',
      requestApply: true,
      dryRun: false,
      certified: true,
      committed: true,
      rolledBack: false,
      liveMutation: true,
      ledgerWritten: true,
      schemaMutation: true,
      evidenceDigest: ev.evidenceDigest,
      planDigest: planDigestValue,
      approvalToken,
      catalogFingerprint: structural.fingerprint,
      ledgerRowCount: ledgerAfter.length,
      reconcileOk: recon.ok,
      appliedIds: LOCKED_MIGRATION_IDS.slice(),
      steps,
      target: RECONCILE_TARGET,
      slice: SLICE_ID,
    });
  } catch (e) {
    if (began) {
      try {
        reconcileQueryCallCount += 1;
        await client.query('ROLLBACK');
        steps.push('ROLLBACK');
      } catch (_) { /* ignore */ }
    }
    return publicResult({
      ok: false,
      code: e.code || 'reconcile_failed',
      message: String(e.message || e).slice(0, 240),
      errors: e.errors || [{ code: e.code, message: String(e.message || e).slice(0, 200) }],
      rolledBack: began,
      committed: false,
      steps,
      liveMutation: false,
      ledgerWritten: false,
    });
  }
}

function renderUsage() {
  return [
    'sunset-staging-ledger-reconcile — Email 2F-C3-b1',
    '',
    'Locked target: sunset_staging @ luna-sunset-staging-pg-app.postgres.database.azure.com',
    'Locked migrations: 056..060 only',
    '',
    'Dry-run (zero mutation):',
    `  ${ENV_ENABLED}=1 ${ENV_TOKEN}=<digest-bound-token> npm run sunset-staging-ledger-reconcile:dry-run -- \\`,
    `    ${CLI_DRY_RUN} ${CLI_APPROVE} ${CLI_EVIDENCE} <sealed-evidence.json> \\`,
    `    --subscription ${RECONCILE_TARGET.subscriptionId} \\`,
    `    --resource-group ${RECONCILE_TARGET.resourceGroup} \\`,
    `    --postgres-server ${RECONCILE_TARGET.postgresServer} \\`,
    `    --database ${RECONCILE_TARGET.database}`,
    '',
    'Apply (requires injected live client seam in operator tooling — not self-serve DSN):',
    `  ${ENV_ENABLED}=1 ${ENV_TOKEN}=<digest-bound-token> npm run sunset-staging-ledger-reconcile:apply -- \\`,
    `    ${CLI_APPLY} ${CLI_APPROVE} ${CLI_EVIDENCE} <sealed-evidence.json> ...`,
  ].join('\n');
}

/**
 * Scripted fake client for offline gate/sequence tests.
 */
function createScriptedReconcileFakeClient(script) {
  const s = script || {};
  let ledger = Array.isArray(s.ledgerRows) ? s.ledgerRows.map((r) => ({ ...r })) : [];
  let structural = { ...(s.structuralRow || {}) };
  let inTxn = false;
  let advisoryHeld = false;
  const calls = [];
  const failOn = s.failOnSubstr || null;

  return {
    calls,
  get ledgerRows() { return ledger; },
  setStructuralRow(row) { structural = { ...row }; },
    async connect() { return undefined; },
    async end() { return undefined; },
    async query(sql, params) {
      const q = String(sql);
      calls.push({ sql: q.slice(0, 120), params: params ? '[redacted]' : null });
      if (failOn && q.includes(failOn)) {
        throw Object.assign(new Error(`injected failure on ${failOn}`), { code: 'injected_failure' });
      }
      if (q === 'BEGIN') { inTxn = true; return { rows: [] }; }
      if (q === 'COMMIT') { inTxn = false; advisoryHeld = false; return { rows: [] }; }
      if (q === 'ROLLBACK') { inTxn = false; advisoryHeld = false; return { rows: [] }; }
      if (q.includes('pg_advisory_xact_lock')) {
        if (s.advisoryBlocked) {
          throw Object.assign(new Error('advisory lock unavailable'), { code: 'advisory_lock_blocked' });
        }
        advisoryHeld = true;
        return { rows: [] };
      }
      if (q.includes('has_056_table') || q.includes('to_regclass')) {
        return { rows: [structural] };
      }
      if (q.startsWith('SELECT') && q.includes('schema_migration_ledger')) {
        return { rows: ledger.slice().sort((a, b) => a.apply_order - b.apply_order) };
      }
      if (q.includes('ledger_txn_ts')) return { rows: [{ ledger_txn_ts: '2026-08-05T00:00:00.000Z' }] };
      if (q.startsWith('INSERT INTO schema_migration_ledger')) {
        ledger.push({
          id: params[0], filename: params[1], checksum_sha256: params[2], apply_order: params[3],
          apply_kind: params[4], checksum_mode: params[5], evidence_ref: params[6], provenance_notes: params[7],
          applied_at: params[8], ledger_recorded_at: params[8],
        });
        return { rows: [] };
      }
      if (q.includes('CREATE TABLE') || q.includes('ALTER TABLE') || q.includes('CREATE UNIQUE INDEX')) {
        if (q.includes('tenant_locations')) structural.has_057_locations = true;
        if (q.includes('tenant_channel_endpoints') && q.includes('CREATE TABLE')) structural.has_057_endpoints = true;
        if (q.includes('connector_mode')) structural.has_058_connector_mode = true;
        if (q.includes('tenant_email_delegated_grants')) structural.has_059_grants = true;
        if (q.includes('tenant_channel_endpoints_client_id_id_uq')) structural.has_059_endpoint_uq = true;
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

module.exports = {
  SLICE_ID,
  EVIDENCE_KIND,
  APPLICATION_NAME,
  RECONCILE_TARGET,
  LOCKED_MIGRATION_IDS,
  BASELINE_IDS,
  RUNNER_IDS,
  PREFIX_END_ORDER,
  PREFIX_END_ID,
  TIP_ORDER,
  ENV_ENABLED,
  ENV_TOKEN,
  ENV_EMAIL_COMPOSITION,
  CLI_DRY_RUN,
  CLI_APPLY,
  CLI_APPROVE,
  CLI_EVIDENCE,
  APPROVAL_PREFIX,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  STRUCTURAL_PROBE_SQL,
  LEDGER_SELECT_SQL,
  parseArgvFlags,
  evaluateReconcileGates,
  loadManifestContext,
  digestEvidencePayload,
  digestPlan,
  deriveApprovalToken,
  validateEvidenceArtifact,
  sealEvidence,
  probeStructuralState,
  assertPreApplyStructural,
  assertPostApplyStructural,
  assertLedgerPrefix,
  assertLockedTarget,
  catalogFingerprintFromProbe,
  insertBaselineLedgerRow,
  applyMigrationInTransaction,
  executeReconcileDryRun,
  executeReconcileMutation,
  renderUsage,
  createScriptedReconcileFakeClient,
  resetReconcileCounters,
  getReconcileCounters,
  publicResult,
};
