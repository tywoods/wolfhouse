'use strict';

/**
 * run-phase-d-reconcile-decision — FOUNDATION Slice 14R
 *
 * Default-disabled operator CLI for live reconcile decision (read-only).
 */

const fs = require('fs');
const path = require('path');
const {
  evaluateReconcileDecisionGates,
  executeReconcileDecision,
  printCliHelp,
  resetReconcileDecisionCounters,
  getReconcileDecisionCounters,
  CLI_PROVE_RECONCILE_DECISION,
  PHASE_D_RECONCILE_DECISION_LIVE_ENABLED,
  APPLICATION_NAME,
  RECONCILE_LOCKS,
} = require('./lib/phase-d-reconcile-decision');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
} = require('./lib/phase-d-managed-identity-credential-loader');

const ROOT = path.join(__dirname, '..');
const EXPECTED_PATH = path.join(
  ROOT,
  'fixtures',
  'sunset-schema-observer',
  'expected-product-schema.json',
);

function defaultRefuseOutput() {
  return {
    ok: false,
    code: 'default_disabled',
    sameTarget: false,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    kvMutation: false,
    clientsInstantiated: 0,
    httpRequestCount: 0,
    liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
    reconcileDecisionLiveEnabled: PHASE_D_RECONCILE_DECISION_LIVE_ENABLED === true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    note: 'Default path refused — zero ARM / zero KV / zero pg Clients',
    applicationName: APPLICATION_NAME,
    subscriptionId: RECONCILE_LOCKS.subscriptionId,
    resourceGroup: RECONCILE_LOCKS.resourceGroup,
    containerAppName: RECONCILE_LOCKS.containerAppName,
    postgresHost: RECONCILE_LOCKS.postgresHost,
    database: RECONCILE_LOCKS.database,
  };
}

function failClosedCatch(err) {
  return {
    ok: false,
    code: 'reconcile_decision_unhandled',
    sameTarget: false,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    kvMutation: false,
    clientsInstantiated: getReconcileDecisionCounters().clientsInstantiated,
    httpRequestCount: getReconcileDecisionCounters().httpRequestCount,
    liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
    reconcileDecisionLiveEnabled: PHASE_D_RECONCILE_DECISION_LIVE_ENABLED === true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    message: String((err && err.message) || err || 'unhandled').slice(0, 240),
    applicationName: APPLICATION_NAME,
  };
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(printCliHelp());
    process.exit(0);
  }

  resetReconcileDecisionCounters();

  if (!argv.includes(CLI_PROVE_RECONCILE_DECISION) && argv.length === 0) {
    console.log(printCliHelp());
    console.log('');
    console.log(JSON.stringify(defaultRefuseOutput(), null, 2));
    process.exit(2);
  }

  const gates = evaluateReconcileDecisionGates({ env: process.env, argv });
  if (!gates.ok) {
    console.log(JSON.stringify({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'reconcile_decision_gates_rejected',
      sameTarget: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      clientsInstantiated: 0,
      httpRequestCount: 0,
      errors: gates.errors,
      message: 'reconcile decision gates rejected — zero ARM / zero KV / zero pg Clients',
      applicationName: APPLICATION_NAME,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      reconcileDecisionLiveEnabled: PHASE_D_RECONCILE_DECISION_LIVE_ENABLED === true,
    }, null, 2));
    process.exit(2);
  }

  const expectedContract = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));

  const result = await executeReconcileDecision({
    env: process.env,
    argv,
    expectedContract,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(JSON.stringify(failClosedCatch(err), null, 2));
  process.exit(1);
});
