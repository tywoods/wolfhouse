'use strict';

const { runSunsetStagingLedgerReconcileCli } = require('./lib/sunset-staging-ledger-reconcile-cli');
const { sanitizeReconcileError, sanitizePublicPayload } = require('./lib/sunset-staging-ledger-reconcile-redact');
const { renderUsage, CLI_DRY_RUN, CLI_APPLY } = require('./lib/sunset-staging-ledger-reconcile');

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderUsage());
    return;
  }
  const dry = argv.includes(CLI_DRY_RUN);
  const apply = argv.includes(CLI_APPLY);
  if (!dry && !apply) {
    console.log(renderUsage());
    process.exitCode = 2;
    return;
  }

  try {
    const outcome = await runSunsetStagingLedgerReconcileCli({ env: process.env, argv });
    const payload = sanitizePublicPayload(outcome.result, process.env);
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = outcome.result.ok ? 0 : 1;
  } catch (err) {
    console.log(JSON.stringify(sanitizeReconcileError(err, process.env), null, 2));
    process.exitCode = 1;
  }
}

main();
