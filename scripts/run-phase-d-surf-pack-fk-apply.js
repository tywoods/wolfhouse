'use strict';

/**
 * run-phase-d-surf-pack-fk-apply — FOUNDATION Slice 14Z
 *
 * Default-disabled operator CLI that applies exactly one missing canonical
 * FK on Sunset staging behind exact env+argv gates + managed-identity credentials.
 *
 * DEFAULT: refused (zero pg Clients / zero HTTP).
 * Never writes ledger. Never DROP/DML. No retry.
 */

const {
  evaluateSurfPackFkApplyGates,
  executePhaseDSurfPackFkApply,
  renderSurfPackFkApplyUsage,
  pickSafeSurfPackFkApplyOutput,
  resetSurfPackFkApplyCounters,
  getSurfPackFkApplyCounters,
  CLI_APPLY_SURF_PACK_FK,
  PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  APPLY_LOCKS,
} = require('./lib/phase-d-surf-pack-fk-apply');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
} = require('./lib/phase-d-managed-identity-credential-loader');

function renderFailClosedCatch(err) {
  return pickSafeSurfPackFkApplyOutput({
    ok: false,
    code: 'surf_pack_fk_apply_unhandled',
    applySurfPackFk: false,
    liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
    surfPackFkApplyLiveEnabled: PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED === true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    clientsInstantiated: getSurfPackFkApplyCounters().clientsInstantiated,
    httpRequestCount: getSurfPackFkApplyCounters().httpRequestCount,
    message: String((err && err.message) || err || 'unhandled').slice(0, 240),
    privateRefsZeroed: true,
    applicationName: APPLY_LOCKS.applicationName,
  });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderSurfPackFkApplyUsage());
    process.exit(0);
  }

  resetSurfPackFkApplyCounters();

  if (!argv.includes(CLI_APPLY_SURF_PACK_FK) && argv.length === 0) {
    console.log(renderSurfPackFkApplyUsage());
    console.log('');
    console.log(JSON.stringify(pickSafeSurfPackFkApplyOutput({
      ok: false,
      code: 'default_disabled',
      applySurfPackFk: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      surfPackFkApplyLiveEnabled: PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED === true,
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

  const gates = evaluateSurfPackFkApplyGates({ env: process.env, argv });
  if (!gates.ok) {
    console.log(JSON.stringify(pickSafeSurfPackFkApplyOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'surf_pack_fk_apply_gates_rejected',
      applySurfPackFk: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      surfPackFkApplyLiveEnabled: PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED === true,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      httpRequestCount: 0,
      errors: gates.errors,
      message: 'surf pack fk apply gates rejected — zero pg Clients',
      privateRefsZeroed: true,
      applicationName: APPLY_LOCKS.applicationName,
    }), null, 2));
    process.exit(2);
  }

  const result = await executePhaseDSurfPackFkApply({
    env: process.env,
    argv,
  });
  console.log(JSON.stringify(pickSafeSurfPackFkApplyOutput(result), null, 2));
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(JSON.stringify(renderFailClosedCatch(err), null, 2));
  process.exit(1);
});
