'use strict';

/**
 * run-staging-ledger-recovery — CLI for staging ledger recovery plan/apply.
 *
 * Plan-only by default path. Apply requires --apply-ledger-recovery and an
 * injected db-client seam (this CLI does not retrieve secrets or open a DSN).
 * Never prints secrets/DSN.
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
    'staging-ledger-recovery — staging ledger recovery plan / one-time apply',
    '',
    'Required:',
    '  WOLFHOUSE_STAGING_LEDGER_RECOVERY=1',
    '  WOLFHOUSE_STAGING_LEDGER_RECOVERY_APPROVAL_TOKEN=APPROVE-STAGING-LEDGER-RECOVERY-V1',
    '  --approve-staging-ledger-recovery',
    '  --evidence <path>',
    '  --subscription --resource-group --postgres-server --database (locked wolfhouse_staging)',
    '',
    'Mode (exactly one):',
    '  --plan-only                 dry-run certification',
    '  --apply-ledger-recovery     one-time apply (requires injected db client seam)',
    '',
    'Forbidden:',
    '  --dsn / --sql / --apply / --mutate / arbitrary connect flags',
    '',
    `mutationEnabled=${STAGING_LEDGER_RECOVERY_MUTATION_ENABLED}`,
    `slice=${SLICE_ID}`,
    '',
    'Apply does not retrieve DB secrets. Without an injected client the apply',
    'path fails closed with db_client_required. Collect real staging structural',
    'evidence before any real invocation (see docs/STAGING-LEDGER-RECOVERY.md).',
  ];
  console.error(lines.join('\n'));
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (args.includes(CLI_APPLY_MUTATION)) {
    const result = await executeRecoveryMutation({
      env: process.env,
      argv: args,
    });
    const out = publicResult(result);
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 2);
  }

  if (args.includes('--apply') || args.includes('--mutate') || args.includes('--execute')) {
    const refused = publicResult({
      ok: false,
      code: 'forbidden_argv',
      planOnly: true,
      dryRun: true,
      mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
      liveMutation: false,
      errors: [{
        code: 'forbidden_argv',
        message: 'use --apply-ledger-recovery (not --apply/--mutate/--execute)',
      }],
    });
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
      mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
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
  main(process.argv).catch((err) => {
    const out = publicResult({
      ok: false,
      code: 'cli_failed',
      message: String((err && err.message) || err).slice(0, 200),
      planOnly: true,
      dryRun: true,
      mutationEnabled: STAGING_LEDGER_RECOVERY_MUTATION_ENABLED,
      liveMutation: false,
    });
    console.log(JSON.stringify(out, null, 2));
    process.exit(2);
  });
}

module.exports = { main };
