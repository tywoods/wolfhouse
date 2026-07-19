'use strict';

/**
 * run-phase-d-surf-pack-trigger-apply — FOUNDATION Slice 14AA
 *
 * Default-disabled operator CLI that applies exactly one missing canonical
 * trigger on Sunset staging behind exact env+argv gates + managed-identity credentials.
 *
 * DEFAULT: refused (zero pg Clients / zero HTTP).
 * Never writes ledger. Never DROP/DML. No retry.
 */

const {
  evaluateSurfPackTriggerApplyGates,
  executePhaseDSurfPackTriggerApply,
  renderSurfPackTriggerApplyUsage,
  pickSafeSurfPackTriggerApplyOutput,
  resetSurfPackTriggerApplyCounters,
  getSurfPackTriggerApplyCounters,
  CLI_APPLY_SURF_PACK_TRIGGER,
  PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  APPLY_LOCKS,
} = require('./lib/phase-d-surf-pack-trigger-apply');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
} = require('./lib/phase-d-managed-identity-credential-loader');

function renderFailClosedCatch(err) {
  return pickSafeSurfPackTriggerApplyOutput({
    ok: false,
    code: 'surf_pack_trigger_apply_unhandled',
    applySurfPackTrigger: false,
    liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
    surfPackTriggerApplyLiveEnabled: PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED === true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    clientsInstantiated: getSurfPackTriggerApplyCounters().clientsInstantiated,
    httpRequestCount: getSurfPackTriggerApplyCounters().httpRequestCount,
    message: String((err && err.message) || err || 'unhandled').slice(0, 240),
    privateRefsZeroed: true,
    applicationName: APPLY_LOCKS.applicationName,
  });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderSurfPackTriggerApplyUsage());
    process.exit(0);
  }

  resetSurfPackTriggerApplyCounters();

  if (!argv.includes(CLI_APPLY_SURF_PACK_TRIGGER) && argv.length === 0) {
    console.log(renderSurfPackTriggerApplyUsage());
    console.log('');
    console.log(JSON.stringify(pickSafeSurfPackTriggerApplyOutput({
      ok: false,
      code: 'default_disabled',
      applySurfPackTrigger: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      surfPackTriggerApplyLiveEnabled: PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED === true,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      httpRequestCount: 0,
      note: 'Default path refused — zero pg Clients / zero HTTP',
      privateRefsZeroed: true,
      applicationName: APPLY_LOCKS.applicationName,
      subscriptionId: APPLY_LOCKS.subscriptionId,
      resourceGroup: APPLY_LOCKS.resourceGroup,
      postgresServer: APPLY_LOCKS.postgresServer,
      database: APPLY_LOCKS.database,
    }), null, 2));
    process.exit(2);
  }

  const gates = evaluateSurfPackTriggerApplyGates({ env: process.env, argv });
  if (!gates.ok) {
    console.log(JSON.stringify(pickSafeSurfPackTriggerApplyOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'surf_pack_trigger_apply_gates_rejected',
      applySurfPackTrigger: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      surfPackTriggerApplyLiveEnabled: PHASE_D_SURF_PACK_TRIGGER_APPLY_LIVE_ENABLED === true,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      httpRequestCount: 0,
      errors: gates.errors,
      message: 'surf pack trigger apply gates rejected — zero pg Clients',
      privateRefsZeroed: true,
      applicationName: APPLY_LOCKS.applicationName,
    }), null, 2));
    process.exit(2);
  }

  const result = await executePhaseDSurfPackTriggerApply({
    env: process.env,
    argv,
  });
  console.log(JSON.stringify(pickSafeSurfPackTriggerApplyOutput(result), null, 2));
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(JSON.stringify(renderFailClosedCatch(err), null, 2));
  process.exit(1);
});
