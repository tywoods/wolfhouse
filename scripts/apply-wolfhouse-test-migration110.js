'use strict';
/**
 * PR1290 bounded exception: execute ONLY migration110 on the repo-pinned
 * Wolfhouse staging/TEST target. Default is an OFFLINE plan, not a DB probe.
 * Never invokes the chain runner, ensureLedger, or historical recovery.
 * See docs/PR1290-MIGRATION110-TEST-ONLY.md before operator use.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  MIGRATIONS_DIR, CHECKSUM_MODE_CANONICAL_LF_V1, ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2,
  loadManifest, forwardEntries, resolveChecksumMode, checksumMigrationBytes,
  prepareMigrationBody, reconcileLedger, buildExecutedByCanonicalRunnerProvenance,
} = require('./lib/migration-integrity');
const { RECOVERY_TARGET, KNOWN_PARTIAL_SCENARIO } = require('./lib/staging-ledger-recovery');
const { loadLedger } = require('./run-canonical-migrations');

const ID = '110_staff_room_fill_create_receipts';
const FILENAME = `${ID}.sql`;
const SHA256 = '2e74749d1d1eaa9e5f3f7de083820318e092902e94add552cfd5c5c9d2f0e253';
const TARGET = Object.freeze({
  target: 'wolfhouse-staging', host: RECOVERY_TARGET.postgresHost,
  database: RECOVERY_TARGET.database, port: RECOVERY_TARGET.port,
});
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function assertTarget(o) {
  for (const key of Object.keys(TARGET)) requireThat(o[key] === TARGET[key], `${key} target mismatch`);
  requireThat(o.migration === '110', 'migration must be exactly 110 (forward only)');
  requireThat(o.apply == null || typeof o.apply === 'boolean', 'apply must be boolean');
}
function parseArgs(args) {
  const o = { apply: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    requireThat(!seen.has(flag), 'duplicate argument');
    seen.add(flag);
    if (flag === '--apply' || flag === '--dry-run') { o.apply = flag === '--apply'; continue; }
    requireThat(['--target', '--migration', '--host', '--database', '--port'].includes(flag), 'unsupported argument');
    const value = args[++i];
    requireThat(value && !value.startsWith('--'), 'missing argument value');
    if (flag === '--port') requireThat(value === String(TARGET.port), 'port target mismatch');
    o[flag.slice(2)] = flag === '--port' ? Number(value) : value;
  }
  requireThat(!(seen.has('--apply') && seen.has('--dry-run')), 'contradictory mode arguments');
  assertTarget(o);
  return o;
}
function selectedMigration() {
  const manifest = loadManifest();
  const mode = resolveChecksumMode(manifest);
  requireThat(mode.ok && mode.mode === CHECKSUM_MODE_CANONICAL_LF_V1, 'manifest checksum mode mismatch');
  const entries = manifest.entries.filter(e => e.id === ID || e.filename === FILENAME);
  requireThat(entries.length === 1, 'migration110 manifest registration missing or ambiguous');
  const entry = entries[0];
  requireThat(entry.id === ID && entry.filename === FILENAME && entry.classification === 'canonical_forward'
    && entry.inForwardChain === true && Number.isInteger(entry.order) && entry.order > 0
    && entry.sha256 === SHA256, 'migration110 manifest identity/checksum mismatch');
  requireThat(manifest.entries.filter(e => e.inForwardChain && e.order === entry.order).length === 1,
    'migration110 manifest order collision');
  // Read once: hash and execute the same bytes, with canonical helper transaction stripping.
  const bytes = fs.readFileSync(path.join(MIGRATIONS_DIR, FILENAME));
  const checksum = checksumMigrationBytes(bytes, mode.mode);
  requireThat(checksum.ok && checksum.sha256 === entry.sha256, 'migration110 file checksum mismatch');
  const prepared = prepareMigrationBody(bytes.toString('utf8'));
  requireThat(prepared.ok, 'migration110 transaction shape invalid');
  return { entry, body: prepared.body, forward: forwardEntries(manifest) };
}
function assertNarrowLedger(forward, rows) {
  const allowed = [KNOWN_PARTIAL_SCENARIO.soleRowId, ID];
  requireThat(rows.length >= 1 && rows.length <= 2
    && rows.filter(r => r.id === allowed[0]).length === 1
    && rows.every(r => allowed.includes(r.id)), 'ledger must contain only042, optionally110');
  // This explicitly scoped path accepts this known sparse shape, NOT a migrated DB.
  // Keep all canonical row checksum/order/provenance checks. No global policy changes.
  const errors = reconcileLedger(forward, rows).errors.filter(e => e.code !== 'ledger_partial_history');
  requireThat(errors.length === 0, `ledger validation refused: ${errors.map(e => e.code).join(',')}`);
  const applied = rows.find(r => r.id === ID);
  requireThat(!applied || applied.apply_kind === 'executed_by_canonical_runner', 'ledger110 must record execution, not baseline');
  return applied;
}
async function receiptExists(client) {
  return (await client.query("SELECT to_regclass('public.staff_room_fill_create_receipts') AS name")).rows[0].name !== null;
}
async function assertReceiptSchema(client) {
  requireThat(await receiptExists(client), 'receipt schema missing despite ledger110');
  const columns = (await client.query(`SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required, pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.staff_room_fill_create_receipts'::regclass AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY a.attnum`)).rows;
  const expected = [['client_id','uuid'], ['operation_id','text'], ['payload_fingerprint','text'],
    ['room_id','uuid'], ['bed_ids','jsonb'], ['created_at','timestamp with time zone']];
  requireThat(columns.length === expected.length && columns.every((c, i) =>
    c.name === expected[i][0] && c.type === expected[i][1] && c.required === true
    && c.default_value === (c.name === 'created_at' ? 'now()' : null)), 'receipt schema columns drifted');
  const constraints = (await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='public.staff_room_fill_create_receipts'::regclass AND contype IN ('p','f') ORDER BY contype`)).rows;
  requireThat(JSON.stringify(constraints.map(c => c.definition)) === JSON.stringify([
    'FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE', 'PRIMARY KEY (client_id, operation_id)',
  ]), 'receipt schema constraints drifted');
}
async function runMigration110(options) {
  const o = options || {};
  assertTarget(o); // Before pg client construction or any connection.
  const { entry, body, forward } = selectedMigration();
  const result = { target: TARGET, migration: ID, checksumMode: CHECKSUM_MODE_CANONICAL_LF_V1,
    checksumSha256: entry.sha256, applied: [], wholeDatabaseMigrated: false,
    historyReconciled: false, ledgerChecked: false };
  if (o.apply !== true) return { ...result, status: 'offline_plan', wouldApply: [ID] };
  // Deliberately no DSN / PGHOST / PGDATABASE / dotenv / SSL disable fallback.
  const client = new (o.Client || Client)({
    host: TARGET.host, database: TARGET.database, port: TARGET.port,
    user: o.user, password: o.password,
    ssl: { rejectUnauthorized: true, servername: TARGET.host },
    application_name: 'wh-test-migration110-only', connectionTimeoutMillis: 10000,
    statement_timeout: 30000, query_timeout: 35000,
  });
  let inTransaction = false;
  try {
    await client.connect();
    const identity = (await client.query('SELECT current_database() AS database, inet_server_port() AS port')).rows[0];
    requireThat(identity && identity.database === TARGET.database && Number(identity.port) === TARGET.port,
      'server database/port identity mismatch');
    // Host identity is authenticated by verify-full TLS against the pinned hostname.
    await client.query('BEGIN');
    inTransaction = true;
    await client.query("SET LOCAL search_path = public, pg_catalog, pg_temp");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [ADVISORY_LOCK_KEY1, ADVISORY_LOCK_KEY2]);
    // Missing/legacy-incompatible ledger fails here or at SELECT; never create/upgrade it.
    await client.query('LOCK TABLE public.schema_migration_ledger IN SHARE ROW EXCLUSIVE MODE');
    const tenants = (await client.query('SELECT slug FROM public.clients ORDER BY slug')).rows;
    requireThat(tenants.length === 1 && tenants[0].slug === 'wolfhouse-somo', 'tenant identity mismatch');
    const before = await loadLedger(client);
    const applied = assertNarrowLedger(forward, before);
    if (applied) {
      await assertReceiptSchema(client);
      await client.query('COMMIT');
      inTransaction = false;
      return { ...result, status: 'already_applied', ledgerChecked: true };
    }
    requireThat(!(await receiptExists(client)), 'unrecorded receipt table exists; refusing to invent execution provenance');
    await client.query(body);
    await assertReceiptSchema(client);
    const provenance = buildExecutedByCanonicalRunnerProvenance(entry);
    // Same canonical ledger kind/checksum convention, truthful bounded execution notes.
    await client.query(`INSERT INTO public.schema_migration_ledger (
      id, filename, checksum_sha256, apply_order, apply_kind, checksum_mode,
      evidence_ref, provenance_notes, applied_at, ledger_recorded_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`, [
      entry.id, entry.filename, entry.sha256, entry.order, provenance.apply_kind, provenance.checksum_mode,
      `wolfhouse_test_migration110_only:${ID}`,
      'Executed single migration110 only via apply-wolfhouse-test-migration110.js; no backlog, baseline, or whole-database migration claim.',
    ]);
    const after = await loadLedger(client);
    requireThat(assertNarrowLedger(forward, after) && after.length === before.length + 1
      && JSON.stringify(after.filter(r => r.id !== ID)) === JSON.stringify(before), 'ledger postcondition mismatch');
    await client.query('COMMIT');
    inTransaction = false;
    return { ...result, status: 'applied', ledgerChecked: true, applied: [ID] };
  } catch (error) {
    if (inTransaction) { try { await client.query('ROLLBACK'); } catch (_) { /* connection is discarded below */ } }
    throw error;
  } finally { await client.end(); }
}
module.exports = { parseArgs, runMigration110 };
if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.apply) {
      requireThat(process.env.WH_MIG_USER && process.env.WH_MIG_PASSWORD, 'operator credentials required');
      options.user = process.env.WH_MIG_USER;
      options.password = process.env.WH_MIG_PASSWORD;
    }
    console.log(JSON.stringify(await runMigration110(options), null, 2));
  })().catch(() => {
    // Never print arbitrary connection/driver errors: they may contain credentials.
    console.error('Migration110 refused or failed. No success claimed; consult docs/PR1290-MIGRATION110-TEST-ONLY.md.');
    process.exitCode = 1;
  });
}
