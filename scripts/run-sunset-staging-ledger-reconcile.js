'use strict';

const fs = require('fs');
const {
  executeReconcileDryRun,
  executeReconcileMutation,
  renderUsage,
  CLI_DRY_RUN,
  CLI_APPLY,
  CLI_EVIDENCE,
  parseArgvFlags,
} = require('./lib/sunset-staging-ledger-reconcile');

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderUsage());
    process.exit(0);
  }
  const dry = argv.includes(CLI_DRY_RUN);
  const apply = argv.includes(CLI_APPLY);
  if (!dry && !apply) {
    console.log(renderUsage());
    process.exit(2);
  }
  const parsed = parseArgvFlags(argv);
  let evidence = null;
  if (parsed.values[CLI_EVIDENCE]) {
    evidence = JSON.parse(fs.readFileSync(parsed.values[CLI_EVIDENCE], 'utf8'));
  }
  const fn = dry ? executeReconcileDryRun : executeReconcileMutation;
  const result = await fn({ env: process.env, argv, evidence, evidencePath: parsed.values[CLI_EVIDENCE] });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, code: 'unhandled', message: String(err.message || err).slice(0, 200) }));
  process.exit(1);
});
