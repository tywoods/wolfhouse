'use strict';

/**
 * Operational adapter for docs/prod/wolfhouse-data-contract.md.
 *
 * Export Wolfhouse TEST config (allowlisted tables only) and import into an
 * empty prod-shaped destination. Never copies bookings, guests, payments,
 * messages, or sessions. Staff accounts are excluded; client timezone/currency
 * and pricing/room/bed policy are kept.
 *
 * Default is dry-run. Read-only on TEST. No DNS, WhatsApp, Stripe, or outbound.
 *
 *   node scripts/wolfhouse-prod-data/adapter.js export --dry-run --fixture fixtures/wolfhouse-prod-data/config-only.json
 *   node scripts/wolfhouse-prod-data/adapter.js import --dry-run --envelope <file> --target <file>
 */

const fs = require('fs');
const path = require('path');
const contract = require('./contract');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_FIXTURE = path.join(ROOT, 'fixtures', 'wolfhouse-prod-data', 'config-only.json');
const WRITE_SQL = /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE)\b/i;

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertNoOperationalRows(envelope) {
  contract.validate(envelope);
  for (const key of contract.COUNTS) {
    if (envelope.exportedCounts[key] !== 0) {
      const err = new Error('operational_row_exported');
      err.code = 'operational_row_exported';
      throw err;
    }
  }
  return true;
}

function dryRunExportFromEnvelope(envelope) {
  assertNoOperationalRows(envelope);
  return {
    mode: 'dry-run',
    tenant: envelope.tenant,
    tables: Object.fromEntries(contract.ORDER.map((name) => [name, envelope.tables[name].length])),
    sourceCounts: envelope.sourceCounts,
    exportedCounts: envelope.exportedCounts,
    writes: 0,
    readOnly: true,
  };
}

function dryRunImport(envelope, target) {
  contract.target(target);
  assertNoOperationalRows(envelope);
  return {
    mode: 'dry-run',
    tenant: envelope.tenant,
    wouldUpsert: Object.fromEntries(contract.ORDER.map((name) => [name, envelope.tables[name].length])),
    destinationCounts: envelope.destinationCounts,
    writes: 0,
  };
}

const STRONG_ISOLATION = new Set(['repeatable read', 'serializable']);
const TX_PROBE_SAVEPOINT = 'wolfhouse_prod_data_tx_probe';

function adapterFail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

function normalizeIsolation(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
}

function assertPinnedClient(client) {
  if (!client || typeof client.query !== 'function') adapterFail('client_not_pinned');
  if (
    Number.isInteger(client.totalCount) ||
    Number.isInteger(client.idleCount) ||
    Number.isInteger(client.waitingCount) ||
    (client.constructor && client.constructor.name === 'Pool')
  ) {
    adapterFail('client_must_not_be_pool');
  }
}

function txStatus(client) {
  const status = client && client._txStatus;
  if (status === 'I' || status === 'T' || status === 'E') return status;
  return null;
}

async function isOpenTransaction(client) {
  const status = txStatus(client);
  if (status === 'T' || status === 'E') return true;
  if (status === 'I') return false;
  try {
    await client.query('SAVEPOINT ' + TX_PROBE_SAVEPOINT);
    await client.query('RELEASE SAVEPOINT ' + TX_PROBE_SAVEPOINT);
    return true;
  } catch (err) {
    if (err && err.code === '25P01') return false;
    if (err && err.code === '25P02') return true;
    throw err;
  }
}

async function readEffectiveTxnSettings(client) {
  const result = await client.query(
    "SELECT current_setting('transaction_read_only') AS transaction_read_only, " +
      "current_setting('transaction_isolation') AS transaction_isolation",
  );
  const row = (result && result.rows && result.rows[0]) || {};
  return {
    readOnly: String(row.transaction_read_only || '').toLowerCase() === 'on',
    isolation: normalizeIsolation(row.transaction_isolation),
  };
}

function assertEffectiveSnapshot(settings) {
  if (!settings || !settings.readOnly) adapterFail('test_txn_not_read_only');
  if (!STRONG_ISOLATION.has(settings.isolation)) adapterFail('test_txn_not_repeatable_read');
}

async function exportFromReadOnlyTest(client) {
  assertPinnedClient(client);
  const openBefore = await isOpenTransaction(client);
  let owned = false;
  try {
    if (openBefore) {
      assertEffectiveSnapshot(await readEffectiveTxnSettings(client));
    } else {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      owned = true;
      if (!(await isOpenTransaction(client))) adapterFail('test_txn_not_open');
      assertEffectiveSnapshot(await readEffectiveTxnSettings(client));
    }
    const sqlAdapter = new contract.SqlConfigAdapter(client);
    const envelope = await contract.exportConfig(sqlAdapter);
    assertNoOperationalRows(envelope);
    if (owned) {
      await client.query('COMMIT');
      owned = false;
    }
    return envelope;
  } catch (err) {
    if (owned) {
      try { await client.query('ROLLBACK'); } catch (_) { /* still surface the original error */ }
    }
    throw err;
  }
}

async function applyImport(db, envelope, target) {
  contract.target(target);
  assertNoOperationalRows(envelope);
  return contract.importConfig(db, envelope, target);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--apply') args.apply = true;
    else if (token.startsWith('--')) {
      args[token.slice(2)] = argv[++i];
    } else args._.push(token);
  }
  args.dryRun = !args.apply;
  return args;
}

function sourceHasTestWrites() {
  const src = fs.readFileSync(__filename, 'utf8');
  const exportFn = src.slice(src.indexOf('async function exportFromReadOnlyTest'), src.indexOf('async function applyImport'));
  return WRITE_SQL.test(exportFn);
}

async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || cmd === 'help') {
    process.stdout.write('export|import [--dry-run] [--fixture path] [--envelope path] [--target path]\n');
    return 0;
  }
  if (cmd === 'export') {
    const envelope = loadJson(args.fixture || DEFAULT_FIXTURE);
    const plan = dryRunExportFromEnvelope(envelope);
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return 0;
  }
  if (cmd === 'import') {
    const envelope = loadJson(args.envelope || args.fixture || DEFAULT_FIXTURE);
    const target = args.target ? loadJson(args.target) : null;
    if (!target) {
      throw Object.assign(new Error('missing_target'), { code: 'missing_target' });
    }
    if (args.dryRun !== false && !args.apply) {
      const plan = dryRunImport(envelope, target);
      process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
      return 0;
    }
    throw Object.assign(new Error('apply_requires_reviewed_empty_prod'), { code: 'apply_requires_reviewed_empty_prod' });
  }
  throw Object.assign(new Error('unknown_command'), { code: 'unknown_command' });
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write((err && err.code) || 'adapter_failed');
    process.stderr.write('\n');
    process.exitCode = 1;
  });
}

module.exports = {
  dryRunExportFromEnvelope,
  dryRunImport,
  exportFromReadOnlyTest,
  applyImport,
  parseArgs,
  sourceHasTestWrites,
  DEFAULT_FIXTURE,
};
