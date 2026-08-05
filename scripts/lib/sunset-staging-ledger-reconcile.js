'use strict';

/**
 * One-purpose Sunset staging ledger reconciliation.  This is deliberately
 * separate from staging-ledger-recovery: it only handles the known 056..060
 * split and never accepts a caller supplied target, SQL, or migration range.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  loadManifest, forwardEntries, reconcileLedger, prepareMigrationBody,
  checksumMigrationFile, CHECKSUM_MODE_CANONICAL_LF_V1,
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER, LEDGER_SELECT_COLUMNS,
  ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2,
  buildExecutedByCanonicalRunnerProvenance,
  SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET, assertSafeDatabaseTarget,
  MIGRATIONS_DIR, MANIFEST_PATH, schemaFingerprintRows,
} = require('./migration-integrity');

const SLICE_ID = 'sunset-staging-ledger-reconcile-056-060';
const APPLICATION_NAME = 'wh-sunset-ledger-reconcile-056-060';
const ENV_ENABLED = 'SUNSET_STAGING_LEDGER_RECONCILE';
const ENV_TOKEN = 'SUNSET_STAGING_LEDGER_RECONCILE_APPROVAL_TOKEN';
const ENV_EMAIL_OFF = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED';
const APPROVAL_PREFIX = 'APPROVE-SUNSET-056060-';
const TARGET = Object.freeze({
  environment: 'staging',
  subscriptionId: '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9',
  resourceGroup: 'luna-sunset-staging-rg',
  postgresServer: 'luna-sunset-staging-pg-app',
  postgresHost: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.host,
  database: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.database,
  port: 5432,
  applicationName: APPLICATION_NAME,
});
const IDS = Object.freeze([
  '056_booking_refund_records',
  '057_tenant_locations_and_channel_endpoints',
  '058_tenant_channel_endpoint_identity',
  '059_tenant_email_delegated_grants',
  '060_bookings_hidden',
]);
const BASELINE_IDS = new Set([IDS[0], IDS[4]]);
const RUNNER_IDS = new Set(IDS.slice(1, 4));
const ALLOWED_FLAGS = new Set([
  '--dry-run', '--apply-sunset-ledger-reconcile', '--approve-sunset-ledger-reconcile',
  '--evidence', '--subscription', '--resource-group', '--postgres-server', '--database', '--help',
]);
const VALUE_FLAGS = new Set(['--evidence', '--subscription', '--resource-group', '--postgres-server', '--database']);
const FORBIDDEN_FLAGS = /^(--(?:dsn|host|port|user|username|password|connection-string|database-url|sql|query|force|repair|migrate)|--.+(?:dsn|password|sql).*)$/i;
const LEDGER_SQL = `SELECT ${LEDGER_SELECT_COLUMNS.join(', ')} FROM schema_migration_ledger ORDER BY apply_order ASC`;
const INSERT_SQL = `INSERT INTO schema_migration_ledger (
  id, filename, checksum_sha256, apply_order, apply_kind, checksum_mode,
  evidence_ref, provenance_notes, applied_at, ledger_recorded_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`;
/* Catalog output is intentionally generic and read-only, so a sealed evidence
 * fingerprint detects both missing expected objects and unexpected drift. */
const CATALOG_SQL = `SELECT kind, name, detail FROM (
  SELECT 'table' kind, c.relname name, COALESCE(string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid,a.atttypmod), ',' ORDER BY a.attnum),'') detail
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('booking_refund_records','tenant_locations','tenant_channel_endpoints','tenant_email_delegated_grants','bookings')
  GROUP BY c.relname
  UNION ALL
  SELECT 'index', i.relname, pg_get_indexdef(i.oid) FROM pg_catalog.pg_class i JOIN pg_catalog.pg_namespace n ON n.oid=i.relnamespace
  WHERE n.nspname='public' AND i.relkind='i'
  UNION ALL
  SELECT 'constraint', con.conname, pg_get_constraintdef(con.oid) FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_namespace n ON n.oid=con.connamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'trigger', t.tgname, pg_get_triggerdef(t.oid) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
) q ORDER BY kind,name`;

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}
function sha(text) { return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex'); }
function evidenceDigest(evidence) { const x = { ...(evidence || {}) }; delete x.evidenceDigest; return sha(stable(x)); }
function truthy(v) { return /^(1|true|yes)$/i.test(String(v || '')); }
function expectedEntries(manifest) {
  const byId = new Map(forwardEntries(manifest).map((e) => [e.id, e]));
  const entries = IDS.map((id) => byId.get(id));
  if (entries.some((entry) => !entry) || entries.map((e) => e.order).join(',') !== '54,55,56,57,58') {
    throw Object.assign(new Error('canonical manifest does not contain locked 056..060 orders 54..58'), { code: 'manifest_scope_mismatch' });
  }
  return entries;
}
function manifestContext(manifestPath) {
  const manifest = loadManifest(manifestPath || MANIFEST_PATH);
  const entries = expectedEntries(manifest);
  for (const e of entries) {
    const r = checksumMigrationFile(path.join(MIGRATIONS_DIR, e.filename), CHECKSUM_MODE_CANONICAL_LF_V1);
    if (!r.ok || r.sha256 !== e.sha256) throw Object.assign(new Error(`manifest checksum mismatch: ${e.id}`), { code: 'checksum_mismatch' });
  }
  return { manifest, forward: forwardEntries(manifest), entries, manifestDigest: sha(stable(entries.map((e) => ({ id: e.id, order: e.order, sha256: e.sha256 })))) };
}
function planDigest(entries) {
  return sha(stable(entries.map((e) => ({ id: e.id, filename: e.filename, order: e.order, sha256: e.sha256,
    applyKind: BASELINE_IDS.has(e.id) ? APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE : APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER }))));
}
function deriveApprovalToken(evidenceDigestValue, planDigestValue) {
  return `${APPROVAL_PREFIX}${sha(`${evidenceDigestValue}:${planDigestValue}`).slice(0, 32)}`;
}
function targetErrors(t) {
  const x = t || {}; const errors = [];
  for (const [key, want] of Object.entries(TARGET)) if (String(x[key]) !== String(want)) errors.push({ code: `target_${key}_mismatch`, message: `${key} must match locked Sunset staging target` });
  const safe = assertSafeDatabaseTarget({ host: x.postgresHost, database: x.database, port: Number(x.port) }, { allowSunsetStagingCanonicalRunnerNoop: true });
  if (!safe.ok) errors.push(...safe.errors);
  return errors;
}
function parseArgs(argv) {
  const values = {}; const flags = new Set(); const errors = [];
  for (let i = 0; i < (argv || []).length; i += 1) {
    const a = String(argv[i]); const [flag, inline] = a.split(/=(.*)/s);
    if (!a.startsWith('--')) { errors.push({ code: 'positional_argv_refused' }); continue; }
    if (FORBIDDEN_FLAGS.test(flag)) { errors.push({ code: 'forbidden_argv', flag }); continue; }
    if (!ALLOWED_FLAGS.has(flag)) { errors.push({ code: 'unknown_argv', flag }); continue; }
    flags.add(flag);
    if (VALUE_FLAGS.has(flag)) { const value = inline === undefined ? argv[++i] : inline; if (!value || String(value).startsWith('--')) errors.push({ code: 'argv_value_required', flag }); else values[flag] = String(value); }
  }
  return { flags, values, errors };
}
function evaluateGates({ env = {}, argv = [], evidence }) {
  const parsed = parseArgs(argv); const apply = parsed.flags.has('--apply-sunset-ledger-reconcile');
  const dry = parsed.flags.has('--dry-run'); const errors = parsed.errors.slice();
  if (truthy(env[ENV_EMAIL_OFF])) errors.push({ code: 'email_composition_enabled_refused' });
  if (String(env[ENV_ENABLED]) !== '1') errors.push({ code: 'reconcile_env_required' });
  if ((apply && dry) || (!apply && !dry)) errors.push({ code: 'exactly_one_mode_required' });
  if (!parsed.flags.has('--approve-sunset-ledger-reconcile')) errors.push({ code: 'approval_flag_required' });
  if (!evidence && !parsed.values['--evidence']) errors.push({ code: 'evidence_required' });
  if (evidence) {
    try {
      const ctx = manifestContext();
      const ev = validateEvidence(evidence, ctx);
      const expected = deriveApprovalToken(ev.digest, planDigest(ctx.entries));
      if (String(env[ENV_TOKEN] || '') !== expected) errors.push({ code: 'approval_token_mismatch' });
    } catch (error) {
      errors.push({ code: error.code || 'approval_context_failed' });
    }
  }
  const t = {
    ...TARGET,
    subscriptionId: parsed.values['--subscription'] || TARGET.subscriptionId,
    resourceGroup: parsed.values['--resource-group'] || TARGET.resourceGroup,
    postgresServer: parsed.values['--postgres-server'] || TARGET.postgresServer,
    database: parsed.values['--database'] || TARGET.database,
  };
  errors.push(...targetErrors(t));
  return { ok: errors.length === 0, errors, apply, dryRun: dry, parsed };
}
function validateEvidence(evidence, ctx) {
  const errors = [];
  if (!evidence || evidence.kind !== 'sunset-staging-ledger-reconcile-evidence-v1' || evidence.immutable !== true) errors.push({ code: 'evidence_invalid' });
  if ((evidence || {}).checksumMode !== CHECKSUM_MODE_CANONICAL_LF_V1) errors.push({ code: 'checksum_mode_mismatch' });
  errors.push(...targetErrors((evidence || {}).target));
  const digest = evidenceDigest(evidence);
  if (!evidence || evidence.evidenceDigest !== digest) errors.push({ code: 'evidence_digest_mismatch' });
  if (!evidence || evidence.manifestDigest !== ctx.manifestDigest) errors.push({ code: 'manifest_digest_mismatch' });
  const ledger = (evidence || {}).ledgerRows || [];
  if (ledger.length !== 53 || ledger.some((r, i) => Number(r.apply_order) !== i + 1) || ledger.some((r) => IDS.includes(r.id))) errors.push({ code: 'ledger_shape_refused' });
  if (!evidence || !/^[0-9a-f]{64}$/.test(String(evidence.catalogFingerprint || ''))) errors.push({ code: 'catalog_fingerprint_missing' });
  return { ok: errors.length === 0, errors, digest };
}
function certify(input) {
  const ctx = input.context || manifestContext(input.manifestPath);
  const ev = validateEvidence(input.evidence, ctx);
  const p = planDigest(ctx.entries);
  return { ok: ev.ok, errors: ev.errors, entries: ctx.entries, forward: ctx.forward, evidenceDigest: ev.digest, planDigest: p, approvalToken: deriveApprovalToken(ev.digest, p), target: TARGET };
}
async function probeCatalog(client) {
  const r = await client.query(CATALOG_SQL);
  return { rows: r.rows || [], fingerprint: schemaFingerprintRows(r.rows || []) };
}
function assertExpectedCatalog(rows, phase) {
  const text = (rows || []).map((r) => `${r.kind}|${r.name}|${r.detail}`).join('\n');
  const wants = phase === 'before'
    ? [
      'booking_refund_records', 'booking_refund_records_client_idempotency_uidx',
      'booking_refund_records_booking_idx', 'booking_refund_records_client_location_idx',
      'booking_refund_records_client_created_idx', 'booking_refund_records_booking_client_fk',
      'booking_refund_records_client_fk', 'booking_refund_records_no_update',
      'booking_refund_records_no_delete', 'bookings|hidden:boolean', 'bookings_hidden_true_idx',
    ]
    : ['tenant_locations', 'tenant_channel_endpoints', 'tenant_email_delegated_grants'];
  if (!wants.every((x) => text.includes(x))) throw Object.assign(new Error(`catalog does not match expected ${phase} split state`), { code: 'catalog_expectation_mismatch' });
  if (phase === 'before' && ['tenant_locations', 'tenant_channel_endpoints', 'tenant_email_delegated_grants'].some((x) => text.includes(x))) throw Object.assign(new Error('057..059 objects already present'), { code: 'catalog_unexpected_objects' });
}
async function insertBaselineLedgerRow(client, entry, txnTs, evidenceRef) {
  return client.query(INSERT_SQL, [entry.id, entry.filename, entry.sha256, entry.order,
    APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE, CHECKSUM_MODE_CANONICAL_LF_V1, evidenceRef,
    'verified structural baseline; DDL was applied out-of-band and was not re-executed', txnTs]);
}
async function applyMigrationInTransaction(client, entry, migrationsDir) {
  const abs = path.join(migrationsDir || MIGRATIONS_DIR, entry.filename);
  const checksum = checksumMigrationFile(abs, CHECKSUM_MODE_CANONICAL_LF_V1);
  if (!checksum.ok || checksum.sha256 !== entry.sha256) throw Object.assign(new Error(`checksum mismatch ${entry.id}`), { code: 'checksum_mismatch' });
  const prepared = prepareMigrationBody(fs.readFileSync(abs, 'utf8'));
  if (!prepared.ok) throw Object.assign(new Error(prepared.message), { code: prepared.code });
  await client.query(prepared.body);
  const provenance = buildExecutedByCanonicalRunnerProvenance(entry);
  await client.query(INSERT_SQL, [entry.id, entry.filename, entry.sha256, entry.order, provenance.apply_kind,
    provenance.checksum_mode, provenance.evidence_ref, provenance.provenance_notes, new Date()]);
}
async function executeReconcileMutation(input) {
  const options = input || {};
  const gates = evaluateGates({ env: options.env, argv: options.argv, evidence: options.evidence });
  if (!gates.ok || !gates.apply) return { ok: false, code: (gates.errors[0] || {}).code || 'gate_refused', errors: gates.errors };
  const cert = certify(options);
  if (!cert.ok) return { ok: false, code: cert.errors[0].code, errors: cert.errors };
  if (String(options.env[ENV_TOKEN] || '') !== cert.approvalToken) return { ok: false, code: 'approval_token_mismatch' };
  if (!options.client || typeof options.client.query !== 'function') return { ok: false, code: 'db_client_required' };
  const client = options.client; let began = false;
  try {
    await client.query('BEGIN'); began = true;
    await client.query("SET LOCAL application_name = 'wh-sunset-ledger-reconcile-056-060'");
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2]);
    const before = await probeCatalog(client);
    if (before.fingerprint !== options.evidence.catalogFingerprint) throw Object.assign(new Error('catalog fingerprint changed after evidence seal'), { code: 'catalog_fingerprint_mismatch' });
    assertExpectedCatalog(before.rows, 'before');
    const existing = (await client.query(LEDGER_SQL)).rows || [];
    if (existing.length !== 53 || existing.some((r, i) => Number(r.apply_order) !== i + 1)) throw Object.assign(new Error('ledger must be contiguous through 055'), { code: 'ledger_shape_refused' });
    const ts = (await client.query('SELECT NOW() AS ledger_txn_ts')).rows[0].ledger_txn_ts;
    await insertBaselineLedgerRow(client, cert.entries[0], ts, `sunset-reconcile:${cert.evidenceDigest}:056`);
    for (const entry of cert.entries.slice(1, 4)) await applyMigrationInTransaction(client, entry, options.migrationsDir);
    await insertBaselineLedgerRow(client, cert.entries[4], ts, `sunset-reconcile:${cert.evidenceDigest}:060`);
    const rows = (await client.query(LEDGER_SQL)).rows || [];
    const recon = reconcileLedger(cert.forward, rows);
    if (!recon.ok || rows.length !== 58) throw Object.assign(new Error('post-write ledger reconciliation failed'), { code: 'post_reconcile_failed' });
    await client.query('COMMIT');
    return { ok: true, code: 'sunset_ledger_reconcile_applied', applied: IDS.slice(), committed: true, catalogFingerprint: before.fingerprint };
  } catch (error) {
    if (began) try { await client.query('ROLLBACK'); } catch (_) { /* best effort */ }
    return { ok: false, code: error.code || 'reconcile_failed', message: error.message, rolledBack: began };
  }
}
function sealEvidence(evidence) {
  const copy = { ...(evidence || {}), kind: 'sunset-staging-ledger-reconcile-evidence-v1', immutable: true, checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1 };
  delete copy.evidenceDigest; copy.evidenceDigest = evidenceDigest(copy); return copy;
}

module.exports = {
  SLICE_ID, APPLICATION_NAME, TARGET, IDS, ENV_ENABLED, ENV_TOKEN, ENV_EMAIL_OFF, APPROVAL_PREFIX,
  CATALOG_SQL, LEDGER_SQL, INSERT_SQL, parseArgs, evaluateGates, manifestContext, planDigest,
  evidenceDigest, deriveApprovalToken, validateEvidence, certify, probeCatalog, assertExpectedCatalog,
  insertBaselineLedgerRow, applyMigrationInTransaction, executeReconcileMutation, sealEvidence,
  ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2,
};
