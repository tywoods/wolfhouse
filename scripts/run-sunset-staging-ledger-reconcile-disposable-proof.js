'use strict';

const { runDisposableProofCli } = require('./lib/sunset-staging-ledger-reconcile-disposable-runner');
const { sanitizeReconcileError, sanitizePublicPayload } = require('./lib/sunset-staging-ledger-reconcile-redact');
const { renderUsage } = require('./lib/sunset-staging-ledger-reconcile');

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderUsage());
    return;
  }

  try {
    const outcome = await runDisposableProofCli({ env: process.env, argv });
    const payload = sanitizePublicPayload(outcome.result, process.env);
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = outcome.result.ok ? 0 : 1;
  } catch (err) {
    console.log(JSON.stringify(sanitizeReconcileError(err, process.env), null, 2));
    process.exitCode = 1;
  }
}

main();
