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

async function exportFromReadOnlyTest(client) {
  const mode = await client.query('SHOW default_transaction_read_only');
  const flag = String((mode.rows && mode.rows[0] && (mode.rows[0].default_transaction_read_only || mode.rows[0].show)) || '');
  if (flag !== 'on') {
    const err = new Error('test_not_read_only');
    err.code = 'test_not_read_only';
    throw err;
  }
  const adapter = new contract.SqlConfigAdapter(client);
  const envelope = await contract.exportConfig(adapter);
  assertNoOperationalRows(envelope);
  return envelope;
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
