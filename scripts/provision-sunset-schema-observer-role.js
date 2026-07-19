'use strict';

/**
 * provision-sunset-schema-observer-role — FOUNDATION Slice 7–9
 *
 * Fail-closed, convergent tooling to provision the dedicated Sunset staging
 * schema-observer PostgreSQL role and Key Vault DSN secret.
 *
 * DEFAULT: dry-run (no mutations).
 * Live apply (Slice 9): requires --apply, SUNSET_SCHEMA_OBSERVER_ROLE_APPLY=1,
 * exact AZURE_SUBSCRIPTION_ID, and protected PostgreSQL admin credentials.
 *
 * Does not: create/alter firewall rules, deploy images, create/run the
 * Container Apps Job, or touch Wolfhouse/prod.
 *
 * Usage:
 *   node scripts/provision-sunset-schema-observer-role.js
 *   node scripts/provision-sunset-schema-observer-role.js --dry-run
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
  redactDeep,
} = require('./lib/sunset-schema-observer-role-provision');
const { buildLiveProvisionAdapters } = require('./lib/sunset-schema-observer-role-live-adapters');

async function main() {
  const argv = process.argv.slice(2);
  const applyRequested = argv.includes('--apply');
  if (argv.includes('--dry-run') && applyRequested) {
    console.error('REFUSED: pass either --dry-run (default) or --apply, not both');
    process.exit(2);
  }

  if (!applyRequested) {
    const plan = buildProvisionPlan(TARGETS);
    const report = renderDryRunReport(plan);
    console.log(report.text);
    console.log('');
    console.log(`apply command (LIVE_APPLY_ENABLED=${LIVE_APPLY_ENABLED}):`);
    console.log(`  ${futureApplyCommand()}`);
    process.exit(report.ok ? 0 : 2);
  }

  const gate = evaluateApplyGate({ applyRequested: true, env: process.env });
  if (!gate.ok) {
    console.error(`APPLY REFUSED: ${gate.errors.map((e) => e.code).join(',')}`);
    for (const e of gate.errors) {
      console.error(`  - ${e.code}: ${safeTopLevelErrorMessage(e.message)}`);
    }
    process.exit(2);
  }

  let adapters;
  try {
    adapters = buildLiveProvisionAdapters(process.env);
  } catch (err) {
    console.error('APPLY REFUSED: adapter_init_failed');
    console.error(`  - ${safeTopLevelErrorMessage(err)}`);
    process.exit(2);
  }

  const result = await runProvision({
    applyRequested: true,
    env: process.env,
    targets: TARGETS,
    ...adapters,
  });

  const safe = redactDeep(result, []);
  console.log(JSON.stringify({
    ok: safe.ok,
    mode: safe.mode,
    action: safe.action,
    refused: safe.refused,
    counters: safe.counters,
    text: safe.text,
    errors: safe.errors,
  }, null, 2));

  if (!result.ok) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(
    'provision-sunset-schema-observer-role failed:',
    safeTopLevelErrorMessage(err),
  );
  process.exit(1);
});
