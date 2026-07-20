'use strict';

/**
 * run-phase-d-ledger-baseline-apply — FOUNDATION Slice 14AD
 *
 * Default-disabled operator CLI that creates schema_migration_ledger and inserts
 * exactly 39 Slice-14AC baseline rows behind exact env+argv gates + MI credentials.
 *
 * DEFAULT: refused (zero pg Clients / zero HTTP).
 * No migration SQL execution. No retry.
 */

const {
  evaluateLedgerBaselineApplyGates,
  executePhaseDLedgerBaselineApply,
  renderLedgerBaselineApplyUsage,
  pickSafeLedgerBaselineApplyOutput,
  resetLedgerBaselineApplyCounters,
  getLedgerBaselineApplyCounters,
  CLI_APPLY_LEDGER_BASELINE,
  PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  APPLY_LOCKS,
} = require('./lib/phase-d-ledger-baseline-apply');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
} = require('./lib/phase-d-managed-identity-credential-loader');

function renderFailClosedCatch(err) {
  return pickSafeLedgerBaselineApplyOutput({
    ok: false,
    code: 'ledger_baseline_apply_unhandled',
    applyLedgerBaseline: false,
    liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
    ledgerBaselineApplyLiveEnabled: PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED === true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    clientsInstantiated: getLedgerBaselineApplyCounters().clientsInstantiated,
    httpRequestCount: getLedgerBaselineApplyCounters().httpRequestCount,
    message: String((err && err.message) || err || 'unhandled').slice(0, 240),
    privateRefsZeroed: true,
    applicationName: APPLY_LOCKS.applicationName,
  });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderLedgerBaselineApplyUsage());
    process.exit(0);
  }

  resetLedgerBaselineApplyCounters();

  if (!argv.includes(CLI_APPLY_LEDGER_BASELINE) && argv.length === 0) {
    console.log(renderLedgerBaselineApplyUsage());
    console.log('');
    console.log(JSON.stringify(pickSafeLedgerBaselineApplyOutput({
      ok: false,
      code: 'default_disabled',
      applyLedgerBaseline: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      ledgerBaselineApplyLiveEnabled: PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED === true,
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

  const gates = evaluateLedgerBaselineApplyGates({ env: process.env, argv });
  if (!gates.ok) {
    console.log(JSON.stringify(pickSafeLedgerBaselineApplyOutput({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'ledger_baseline_apply_gates_rejected',
      applyLedgerBaseline: false,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      ledgerBaselineApplyLiveEnabled: PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED === true,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      clientsInstantiated: 0,
      httpRequestCount: 0,
      errors: gates.errors,
      message: 'ledger baseline apply gates rejected — zero pg Clients',
      privateRefsZeroed: true,
      applicationName: APPLY_LOCKS.applicationName,
    }), null, 2));
    process.exit(2);
  }

  const result = await executePhaseDLedgerBaselineApply({
    env: process.env,
    argv,
  });
  console.log(JSON.stringify(pickSafeLedgerBaselineApplyOutput(result), null, 2));
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(JSON.stringify(renderFailClosedCatch(err), null, 2));
  process.exit(1);
});
