'use strict';

/**
 * provision-sunset-schema-observer-role — FOUNDATION Slice 7/8
 *
 * Fail-closed, convergent tooling to provision the dedicated Sunset staging
 * schema-observer PostgreSQL role and Key Vault DSN secret.
 *
 * DEFAULT: dry-run (no mutations).
 * --apply is required for mutations, but LIVE_APPLY_ENABLED remains false —
 * apply always refuses before touching Azure PostgreSQL or Key Vault.
 *
 * Does not: create/alter firewall rules, deploy images, create/run the
 * Container Apps Job, or touch Wolfhouse/prod.
 *
 * Usage:
 *   node scripts/provision-sunset-schema-observer-role.js
 *   node scripts/provision-sunset-schema-observer-role.js --dry-run
 *   # Future approved slice (live apply currently disabled):
 *   SUNSET_SCHEMA_OBSERVER_ROLE_APPLY=1 AZURE_SUBSCRIPTION_ID=... \
 *     SUNSET_STAGING_PG_ADMIN_USER=... SUNSET_STAGING_PG_ADMIN_PASSWORD=... \
 *     node scripts/provision-sunset-schema-observer-role.js --apply
 */

const {
  LIVE_APPLY_ENABLED,
  ENV_APPLY_FLAG,
  ENV_SUBSCRIPTION,
  ENV_PG_ADMIN_USER,
  ENV_PG_ADMIN_PASSWORD,
  TARGETS,
  buildProvisionPlan,
  renderDryRunReport,
  runProvision,
  futureApplyCommand,
  evaluateApplyGate,
  safeTopLevelErrorMessage,
} = require('./lib/sunset-schema-observer-role-provision');

async function main() {
  const argv = process.argv.slice(2);
  const applyRequested = argv.includes('--apply');
  if (argv.includes('--dry-run') && applyRequested) {
    console.error('REFUSED: pass either --dry-run (default) or --apply, not both');
    process.exit(2);
  }

  const result = await runProvision({
    applyRequested,
    env: process.env,
    targets: TARGETS,
  });

  if (!applyRequested) {
    const plan = buildProvisionPlan(TARGETS);
    const report = renderDryRunReport(plan);
    console.log(report.text);
    console.log('');
    console.log(`future apply (LIVE_APPLY_ENABLED=${LIVE_APPLY_ENABLED}):`);
    console.log(`  ${futureApplyCommand()}`);
    process.exit(report.ok ? 0 : 2);
  }

  console.error(safeTopLevelErrorMessage(result.text || 'APPLY REFUSED'));
  if (result.errors && result.errors.length) {
    for (const e of result.errors) {
      console.error(`  - ${e.code}: ${safeTopLevelErrorMessage(e.message)}`);
    }
  }
  const gate = evaluateApplyGate({ applyRequested: true, env: process.env });
  if (!gate.ok && gate.errors.some((e) => e.code === 'live_apply_disabled')) {
    console.error('');
    console.error('Live Azure/Postgres/KV mutation is disabled (LIVE_APPLY_ENABLED=false).');
    console.error(`Required later: flip LIVE_APPLY_ENABLED and set ${ENV_APPLY_FLAG}=1`);
    console.error(`plus ${ENV_SUBSCRIPTION}, ${ENV_PG_ADMIN_USER}, ${ENV_PG_ADMIN_PASSWORD}.`);
  }
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(
    'provision-sunset-schema-observer-role failed:',
    safeTopLevelErrorMessage(err),
  );
  process.exit(1);
});
