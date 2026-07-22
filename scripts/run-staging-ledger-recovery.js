'use strict';

/**
 * run-staging-ledger-recovery — CLI for the staging ledger recovery plan.
 *
 * Dry-run / plan-only only. Mutation is hard-disabled in this slice.
 * Never connects to a database. Never prints secrets/DSN.
 */

const {
  buildRecoveryPlan,
  executeRecoveryMutation,
  publicResult,
  evaluateRecoveryGates,
  CLI_APPLY_MUTATION,
  STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
  SLICE_ID,
} = require('./lib/staging-ledger-recovery');

function printHelp() {
  const lines = [
    'staging-ledger-recovery — one-time staging ledger recovery plan (dry-run)',
    '',
    'Required:',
    '  SUNSET_STAGING_LEDGER_RECOVERY=1',
    '  SUNSET_STAGING_LEDGER_RECOVERY_APPROVAL_TOKEN=APPROVE-STAGING-LEDGER-RECOVERY-V1',
    '  --plan-only',
    '  --approve-staging-ledger-recovery',
    '  --evidence <path>',
    '  --subscription --resource-group --postgres-server --database (locked staging)',
    '',
    'Forbidden in this slice:',
    '  --apply-ledger-recovery / --apply / --dsn / --sql / mutation flags',
    '',
    `mutationEnabled=${STAGING_LEDGER_RECOVERY_MUTATION_ENABLED}`,
    `slice=${SLICE_ID}`,
  ];
  console.error(lines.join('\n'));
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (args.includes(CLI_APPLY_MUTATION) || args.includes('--apply') || args.includes('--mutate')) {
    const refused = publicResult(executeRecoveryMutation());
    console.log(JSON.stringify(refused, null, 2));
    process.exit(2);
  }

  const gates = evaluateRecoveryGates({ env: process.env, argv: args });
  if (!gates.ok) {
    const out = publicResult({
      ok: false,
      code: gates.code || 'default_disabled',
      errors: gates.errors,
      planOnly: true,
      dryRun: true,
      mutationEnabled: false,
      liveMutation: false,
      certified: false,
      message: gates.errors && gates.errors[0] ? gates.errors[0].message : 'refused',
    });
    console.log(JSON.stringify(out, null, 2));
    process.exit(2);
  }

  const plan = buildRecoveryPlan({
    gates: { env: process.env, argv: args },
    evidencePath: gates.evidencePath,
  });
  const out = publicResult(plan);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 2);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { main };
