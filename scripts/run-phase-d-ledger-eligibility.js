'use strict';

/**
 * run-phase-d-ledger-eligibility — FOUNDATION Slice 14AC
 *
 * Default-disabled operator CLI: merged target authority + one read-only
 * session proving the migration-ledger bootstrap eligibility matrix.
 * Never creates/writes schema_migration_ledger.
 */

const fs = require('fs');
const path = require('path');
const {
  evaluateLedgerEligibilityGates,
  executeLedgerEligibility,
  printCliHelp,
  resetLedgerEligibilityCounters,
  getLedgerEligibilityCounters,
  APPLICATION_NAME,
  LEDGER_LOCKS,
  EXPECTED_FORWARD_COUNT,
} = require('./lib/phase-d-ledger-eligibility');
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
    ledgerEligibilityLiveEnabled: true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    note: 'Default path refused — zero ARM / zero KV / zero pg Clients',
    applicationName: APPLICATION_NAME,
    expectedForwardCount: EXPECTED_FORWARD_COUNT,
    subscriptionId: LEDGER_LOCKS.subscriptionId,
    resourceGroup: LEDGER_LOCKS.resourceGroup,
    containerAppName: LEDGER_LOCKS.containerAppName,
    postgresHost: LEDGER_LOCKS.postgresHost,
    database: LEDGER_LOCKS.database,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${printCliHelp()}\n`);
    process.exit(0);
  }

  resetLedgerEligibilityCounters();
  const gate = evaluateLedgerEligibilityGates({ env: process.env, argv });
  if (!gate.ok) {
    const out = {
      ...defaultRefuseOutput(),
      code: (gate.errors[0] && gate.errors[0].code) || 'gates_rejected',
      errors: gate.errors,
      ...getLedgerEligibilityCounters(),
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(2);
  }

  const expectedContract = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
  const result = await executeLedgerEligibility({
    env: process.env,
    argv,
    expectedContract,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok === true ? 0 : 1);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
