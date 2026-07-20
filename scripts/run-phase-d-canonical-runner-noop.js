'use strict';

/**
 * run-phase-d-canonical-runner-noop — FOUNDATION Slice 14AE
 *
 * Default-disabled operator CLI that invokes merged runCanonicalMigrations
 * exactly once against Sunset staging and proves zero-apply no-op.
 *
 * DEFAULT: refused (zero pg Clients / zero HTTP / zero runner invocations).
 * No migration SQL. No ledger INSERT. No retry.
 */

const {
  evaluateCanonicalRunnerNoopGates,
  executePhaseDCanonicalRunnerNoop,
  renderCanonicalRunnerNoopUsage,
  pickSafeCanonicalRunnerNoopOutput,
  resetCanonicalRunnerNoopCounters,
  getCanonicalRunnerNoopCounters,
  CLI_PROVE_CANONICAL_RUNNER_NOOP,
  PHASE_D_CANONICAL_RUNNER_NOOP_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  NOOP_LOCKS,
  APPLICATION_NAME,
} = require('./lib/phase-d-canonical-runner-noop');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
} = require('./lib/phase-d-managed-identity-credential-loader');

function renderFailClosedCatch(err) {
  return pickSafeCanonicalRunnerNoopOutput({
    ok: false,
    code: 'canonical_runner_noop_unhandled',
    proveCanonicalRunnerNoop: false,
    liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
    canonicalRunnerNoopLiveEnabled: PHASE_D_CANONICAL_RUNNER_NOOP_LIVE_ENABLED === true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    executesMigrations: false,
    liveRunnerInvocationCount: getCanonicalRunnerNoopCounters().liveRunnerInvocationCount,
    clientsInstantiated: getCanonicalRunnerNoopCounters().clientsInstantiated,
    httpRequestCount: getCanonicalRunnerNoopCounters().httpRequestCount,
    message: String((err && err.message) || err || 'unhandled').slice(0, 240),
    privateRefsZeroed: true,
    applicationName: APPLICATION_NAME,
  });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderCanonicalRunnerNoopUsage());
    process.exit(0);
  }

  resetCanonicalRunnerNoopCounters();

  if (!argv.includes(CLI_PROVE_CANONICAL_RUNNER_NOOP) && argv.length === 0) {
    console.log(renderCanonicalRunnerNoopUsage());
    console.log('');
    console.log(JSON.stringify(pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: 'default_disabled',
      proveCanonicalRunnerNoop: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      canonicalRunnerNoopLiveEnabled: PHASE_D_CANONICAL_RUNNER_NOOP_LIVE_ENABLED === true,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      executesMigrations: false,
      liveRunnerInvocationCount: 0,
      clientsInstantiated: 0,
      httpRequestCount: 0,
      note: 'Default path refused — zero pg Clients / zero HTTP / zero runner invocations',
      privateRefsZeroed: true,
      applicationName: NOOP_LOCKS.applicationName,
      subscriptionId: NOOP_LOCKS.subscriptionId,
      resourceGroup: NOOP_LOCKS.resourceGroup,
      postgresServer: NOOP_LOCKS.postgresServer,
      database: NOOP_LOCKS.database,
    }), null, 2));
    process.exit(2);
  }

  const gates = evaluateCanonicalRunnerNoopGates({ env: process.env, argv });
  if (!gates.ok) {
    console.log(JSON.stringify(pickSafeCanonicalRunnerNoopOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'canonical_runner_noop_gates_rejected',
      proveCanonicalRunnerNoop: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      canonicalRunnerNoopLiveEnabled: PHASE_D_CANONICAL_RUNNER_NOOP_LIVE_ENABLED === true,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      executesMigrations: false,
      liveRunnerInvocationCount: 0,
      clientsInstantiated: 0,
      httpRequestCount: 0,
      errors: gates.errors,
      privateRefsZeroed: true,
      applicationName: APPLICATION_NAME,
    }), null, 2));
    process.exit(2);
  }

  try {
    const result = await executePhaseDCanonicalRunnerNoop({
      env: process.env,
      argv,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.log(JSON.stringify(renderFailClosedCatch(err), null, 2));
    process.exit(1);
  }
}

main();
