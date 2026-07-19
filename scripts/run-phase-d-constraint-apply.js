'use strict';

/**
 * run-phase-d-constraint-apply — FOUNDATION Slice 14P
 *
 * Default-disabled operator CLI that applies exactly the two missing canonical
 * migration-028 CHECK constraints on public.tenant_services behind exact
 * env+argv gates + managed-identity credentials.
 *
 * DEFAULT: refused (zero pg Clients / zero HTTP).
 * Never writes ledger. Never DROP/DML. No retry.
 *
 * Usage (default refuse):
 *   node scripts/run-phase-d-constraint-apply.js
 */

const {
  evaluateConstraintApplyGates,
  executePhaseDConstraintApply,
  renderConstraintApplyUsage,
  pickSafeConstraintApplyOutput,
  resetConstraintApplyCounters,
  getConstraintApplyCounters,
  CLI_APPLY_CONSTRAINTS,
  PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  APPLY_LOCKS,
} = require('./lib/phase-d-constraint-apply');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
} = require('./lib/phase-d-managed-identity-credential-loader');

function renderFailClosedCatch(err) {
  return pickSafeConstraintApplyOutput({
    ok: false,
    code: 'constraint_apply_unhandled',
    applyConstraints: false,
    liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
    constraintApplyLiveEnabled: PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED === true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    clientsInstantiated: getConstraintApplyCounters().clientsInstantiated,
    httpRequestCount: getConstraintApplyCounters().httpRequestCount,
    message: String((err && err.message) || err || 'unhandled').slice(0, 240),
    privateRefsZeroed: true,
    applicationName: APPLY_LOCKS.applicationName,
  });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderConstraintApplyUsage());
    process.exit(0);
  }

  resetConstraintApplyCounters();

  if (!argv.includes(CLI_APPLY_CONSTRAINTS) && argv.length === 0) {
    console.log(renderConstraintApplyUsage());
    console.log('');
    console.log(JSON.stringify(pickSafeConstraintApplyOutput({
      ok: false,
      code: 'default_disabled',
      applyConstraints: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      constraintApplyLiveEnabled: PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED === true,
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

  const gates = evaluateConstraintApplyGates({ env: process.env, argv });
  if (!gates.ok) {
    console.log(JSON.stringify(pickSafeConstraintApplyOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'constraint_apply_gates_rejected',
      applyConstraints: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      constraintApplyLiveEnabled: PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED === true,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      httpRequestCount: 0,
      errors: gates.errors,
      message: 'constraint apply gates rejected — zero pg Clients',
      privateRefsZeroed: true,
      applicationName: APPLY_LOCKS.applicationName,
    }), null, 2));
    process.exit(2);
  }

  const result = await executePhaseDConstraintApply({
    env: process.env,
    argv,
  });
  console.log(JSON.stringify(pickSafeConstraintApplyOutput(result), null, 2));
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(JSON.stringify(renderFailClosedCatch(err), null, 2));
  process.exit(1);
});
