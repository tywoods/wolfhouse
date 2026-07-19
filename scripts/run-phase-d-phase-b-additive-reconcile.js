'use strict';

/**
 * run-phase-d-phase-b-additive-reconcile — FOUNDATION Slice 14S Phase B
 *
 * Default-disabled operator CLI that creates public.customer_message_templates
 * from byte-locked migration 035 behind exact env+argv gates + managed-identity.
 *
 * DEFAULT: refused (zero pg Clients / zero HTTP).
 * Never writes ledger. Never DROP/DML/CREATE INDEX/COMMENT. No retry.
 *
 * Usage (default refuse):
 *   node scripts/run-phase-d-phase-b-additive-reconcile.js
 */

const {
  evaluatePhaseBAdditiveGates,
  executePhaseBAdditiveReconcile,
  renderPhaseBAdditiveUsage,
  pickSafePhaseBAdditiveOutput,
  resetPhaseBAdditiveCounters,
  getPhaseBAdditiveCounters,
  CLI_APPLY_PHASE_B_ADDITIVE,
  PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  APPLY_LOCKS,
} = require('./lib/phase-d-phase-b-additive-reconcile');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
} = require('./lib/phase-d-managed-identity-credential-loader');

function renderFailClosedCatch(err) {
  return pickSafePhaseBAdditiveOutput({
    ok: false,
    code: 'phase_b_additive_unhandled',
    applyPhaseBAdditive: false,
    liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
    phaseBAdditiveLiveEnabled: PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED === true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    clientsInstantiated: getPhaseBAdditiveCounters().clientsInstantiated,
    httpRequestCount: getPhaseBAdditiveCounters().httpRequestCount,
    message: String((err && err.message) || err || 'unhandled').slice(0, 240),
    privateRefsZeroed: true,
    applicationName: APPLY_LOCKS.applicationName,
  });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderPhaseBAdditiveUsage());
    process.exit(0);
  }

  resetPhaseBAdditiveCounters();

  if (!argv.includes(CLI_APPLY_PHASE_B_ADDITIVE) && argv.length === 0) {
    console.log(renderPhaseBAdditiveUsage());
    console.log('');
    console.log(JSON.stringify(pickSafePhaseBAdditiveOutput({
      ok: false,
      code: 'default_disabled',
      applyPhaseBAdditive: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      phaseBAdditiveLiveEnabled: PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED === true,
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

  const gates = evaluatePhaseBAdditiveGates({ env: process.env, argv });
  if (!gates.ok) {
    console.log(JSON.stringify(pickSafePhaseBAdditiveOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'phase_b_additive_gates_rejected',
      applyPhaseBAdditive: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      phaseBAdditiveLiveEnabled: PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED === true,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      httpRequestCount: 0,
      errors: gates.errors,
      message: 'phase B additive gates rejected — zero pg Clients',
      privateRefsZeroed: true,
      applicationName: APPLY_LOCKS.applicationName,
    }), null, 2));
    process.exit(2);
  }

  const result = await executePhaseBAdditiveReconcile({
    env: process.env,
    argv,
  });
  console.log(JSON.stringify(pickSafePhaseBAdditiveOutput(result), null, 2));
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(JSON.stringify(renderFailClosedCatch(err), null, 2));
  process.exit(1);
});
