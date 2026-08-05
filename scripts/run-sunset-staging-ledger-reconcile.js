'use strict';

const { runSunsetStagingLedgerReconcileCli } = require('./lib/sunset-staging-ledger-reconcile-cli');
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

  let cleanup = null;
  try {
    const outcome = await runSunsetStagingLedgerReconcileCli({ env: process.env, argv });
    cleanup = outcome.cleanup;
    console.log(JSON.stringify(outcome.result, null, 2));
    process.exitCode = outcome.result.ok ? 0 : 1;
  } catch (err) {
    console.log(JSON.stringify({
      ok: false,
      code: 'unhandled',
      message: String(err.message || err).slice(0, 200),
    }));
    process.exitCode = 1;
  } finally {
    if (cleanup) await cleanup();
  }
}

main();
