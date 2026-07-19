'use strict';

/**
 * run-phase-d-kv-secrets-user-rbac-plan — FOUNDATION Slice 14H
 *
 * Default-disabled operator plan CLI for the locked least-privilege Azure RBAC
 * assignment that resolves the Slice 14G Key Vault 403:
 *   wh-staging-identity → Key Vault Secrets User → luna-sunset-staging-kv
 *
 * DEFAULT: refused (zero Azure mutation).
 * With exact env + --plan-only + exact scope/principal/role: emits safe IDs only.
 * Never what-if / deploy / role-assignment create / Key Vault read / PG / network.
 *
 * Usage (default refuse):
 *   node scripts/run-phase-d-kv-secrets-user-rbac-plan.js
 */

const {
  evaluateRbacPlanGates,
  executeRbacPlanOnly,
  renderRbacPlanUsage,
  CLI_PLAN_ONLY,
  resetAzureMutationCounters,
  getAzureMutationCounters,
  PHASE_D_KV_SECRETS_USER_RBAC_LIVE_APPLY_ENABLED,
  SAFE_OUTPUT_KEYS,
} = require('./lib/phase-d-kv-secrets-user-rbac-plan');

function pickSafe(obj) {
  const out = {};
  for (const k of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderRbacPlanUsage());
    process.exit(0);
  }

  resetAzureMutationCounters();

  if (!argv.includes(CLI_PLAN_ONLY) && argv.length === 0) {
    console.log(renderRbacPlanUsage());
    console.log('');
    console.log(JSON.stringify(pickSafe({
      ok: false,
      code: 'default_disabled',
      planOnly: false,
      liveApplyEnabled: PHASE_D_KV_SECRETS_USER_RBAC_LIVE_APPLY_ENABLED === true,
      liveMutation: false,
      azureMutationCount: getAzureMutationCounters().azureMutationCount,
      note: 'Default path refused — zero Azure mutation',
    }), null, 2));
    process.exit(2);
  }

  const gates = evaluateRbacPlanGates({ env: process.env, argv });
  if (!gates.ok) {
    console.log(JSON.stringify(pickSafe({
      ok: false,
      code: gates.code,
      planOnly: argv.includes(CLI_PLAN_ONLY),
      liveApplyEnabled: false,
      liveMutation: false,
      azureMutationCount: getAzureMutationCounters().azureMutationCount,
      errors: gates.errors,
      message: 'RBAC plan gates rejected — zero Azure mutation',
    }), null, 2));
    process.exit(2);
  }

  const result = executeRbacPlanOnly({ env: process.env, argv });
  console.log(JSON.stringify(pickSafe(result), null, 2));
  process.exit(result.ok ? 0 : 2);
}

main();
