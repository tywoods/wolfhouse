'use strict';

/**
 * run-phase-d-five-index-apply — FOUNDATION Slice 14Y
 *
 * Default-disabled operator CLI that applies exactly five missing canonical
 * residual indexes on Sunset staging behind exact env+argv gates +
 * managed-identity credentials.
 *
 * DEFAULT: refused (zero pg Clients / zero HTTP).
 * Never writes ledger. Never DROP/DML. No CONCURRENTLY. No retry.
 *
 * Usage (default refuse):
 *   node scripts/run-phase-d-five-index-apply.js
 */

const {
  evaluateFiveIndexApplyGates,
  executePhaseDFiveIndexApply,
  renderFiveIndexApplyUsage,
  pickSafeFiveIndexApplyOutput,
  resetFiveIndexApplyCounters,
  getFiveIndexApplyCounters,
  CLI_APPLY_FIVE_INDEXES,
  PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  APPLY_LOCKS,
} = require('./lib/phase-d-five-index-apply');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
} = require('./lib/phase-d-managed-identity-credential-loader');

function renderFailClosedCatch(err) {
  return pickSafeFiveIndexApplyOutput({
    ok: false,
    code: 'five_index_apply_unhandled',
    applyFiveIndexes: false,
    liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
    fiveIndexApplyLiveEnabled: PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED === true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    clientsInstantiated: getFiveIndexApplyCounters().clientsInstantiated,
    httpRequestCount: getFiveIndexApplyCounters().httpRequestCount,
    message: String((err && err.message) || err || 'unhandled').slice(0, 240),
    privateRefsZeroed: true,
    applicationName: APPLY_LOCKS.applicationName,
  });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderFiveIndexApplyUsage());
    process.exit(0);
  }

  resetFiveIndexApplyCounters();

  if (!argv.includes(CLI_APPLY_FIVE_INDEXES) && argv.length === 0) {
    console.log(renderFiveIndexApplyUsage());
    console.log('');
    console.log(JSON.stringify(pickSafeFiveIndexApplyOutput({
      ok: false,
      code: 'default_disabled',
      applyFiveIndexes: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      fiveIndexApplyLiveEnabled: PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED === true,
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

  const gates = evaluateFiveIndexApplyGates({ env: process.env, argv });
  if (!gates.ok) {
    console.log(JSON.stringify(pickSafeFiveIndexApplyOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'five_index_apply_gates_rejected',
      applyFiveIndexes: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      fiveIndexApplyLiveEnabled: PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED === true,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      httpRequestCount: 0,
      errors: gates.errors,
      message: 'five index apply gates rejected — zero pg Clients',
      privateRefsZeroed: true,
      applicationName: APPLY_LOCKS.applicationName,
    }), null, 2));
    process.exit(2);
  }

  const result = await executePhaseDFiveIndexApply({
    env: process.env,
    argv,
  });
  console.log(JSON.stringify(pickSafeFiveIndexApplyOutput(result), null, 2));
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(JSON.stringify(renderFailClosedCatch(err), null, 2));
  process.exit(1);
});
