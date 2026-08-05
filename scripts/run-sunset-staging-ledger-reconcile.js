'use strict';

const fs = require('fs');
const { Client } = require('pg');
const reconcile = require('./lib/sunset-staging-ledger-reconcile');

function help() {
  return [
    'Usage: node scripts/run-sunset-staging-ledger-reconcile.js --dry-run|--apply-sunset-ledger-reconcile',
    '  --approve-sunset-ledger-reconcile --evidence <sealed-evidence.json>',
    '  --subscription <locked> --resource-group <locked> --postgres-server <locked> --database <locked>',
    'Apply obtains credentials only from SUNSET_STAGING_LEDGER_RECONCILE_PG_USER and',
    'SUNSET_STAGING_LEDGER_RECONCILE_PG_PASSWORD; target host/database are compiled locks.',
  ].join('\n');
}
async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help')) return { ok: true, help: help() };
  const parsed = reconcile.parseArgs(argv);
  const evidencePath = parsed.values['--evidence'];
  let evidence = null;
  try { if (evidencePath) evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')); } catch (e) {
    return { ok: false, code: 'evidence_read_failed', message: String(e.message).slice(0, 200) };
  }
  const gates = reconcile.evaluateGates({ env, argv, evidence });
  if (!gates.ok) return { ok: false, code: gates.errors[0].code, errors: gates.errors };
  const certified = reconcile.certify({ evidence });
  if (!certified.ok) return { ok: false, code: certified.errors[0].code, errors: certified.errors };
  if (gates.dryRun) return {
    ok: true, code: 'sunset_ledger_reconcile_dry_run_certified',
    evidenceDigest: certified.evidenceDigest, planDigest: certified.planDigest,
    approvalToken: certified.approvalToken, target: reconcile.TARGET, mutates: false,
  };
  const user = env.SUNSET_STAGING_LEDGER_RECONCILE_PG_USER;
  const password = env.SUNSET_STAGING_LEDGER_RECONCILE_PG_PASSWORD;
  if (!user || !password) return { ok: false, code: 'locked_credentials_required', message: 'locked credential environment variables are required for apply' };
  const client = new Client({
    host: reconcile.TARGET.postgresHost, port: reconcile.TARGET.port, database: reconcile.TARGET.database,
    user, password, ssl: { rejectUnauthorized: true }, application_name: reconcile.APPLICATION_NAME,
  });
  try {
    await client.connect();
    return await reconcile.executeReconcileMutation({ env, argv, evidence, client });
  } finally {
    try { await client.end(); } catch (_) { /* ignored */ }
  }
}
if (require.main === module) main().then((r) => {
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  process.exit(r.ok ? 0 : 1);
}).catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
module.exports = { main, help };
