'use strict';

/**
 * run-phase-d-residual-drift-preflight — FOUNDATION Slice 14U
 *
 * Default-disabled operator CLI: merged target authority + one read-only
 * session classifying/preflighting the exact 35 residual drifts after 14T.
 *
 * DEFAULT: refused (zero ARM / zero KV / zero PostgreSQL Clients).
 * Never prints/persists DSN, passwords, tokens, or secret versions.
 */

const fs = require('fs');
const path = require('path');
const {
  evaluateResidualDriftPreflightGates,
  executeResidualDriftPreflight,
  printCliHelp,
  resetResidualDriftPreflightCounters,
  getResidualDriftPreflightCounters,
  CLI_PROVE_RESIDUAL_DRIFT_PREFLIGHT,
  PHASE_D_RESIDUAL_DRIFT_PREFLIGHT_LIVE_ENABLED,
  APPLICATION_NAME,
  RESIDUAL_LOCKS,
  BASELINE_MISMATCH_COUNT,
} = require('./lib/phase-d-residual-drift-preflight');
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
    residualDriftPreflightLiveEnabled: PHASE_D_RESIDUAL_DRIFT_PREFLIGHT_LIVE_ENABLED === true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    note: 'Default path refused — zero ARM / zero KV / zero pg Clients',
    applicationName: APPLICATION_NAME,
    baselineMismatchCountExpected: BASELINE_MISMATCH_COUNT,
    subscriptionId: RESIDUAL_LOCKS.subscriptionId,
    resourceGroup: RESIDUAL_LOCKS.resourceGroup,
    containerAppName: RESIDUAL_LOCKS.containerAppName,
    postgresHost: RESIDUAL_LOCKS.postgresHost,
    database: RESIDUAL_LOCKS.database,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${printCliHelp()}\n`);
    process.exit(0);
  }

  resetResidualDriftPreflightCounters();
  const gate = evaluateResidualDriftPreflightGates({ env: process.env, argv });
  if (!gate.ok) {
    const out = {
      ...defaultRefuseOutput(),
      code: (gate.errors[0] && gate.errors[0].code) || 'gates_rejected',
      errors: gate.errors,
      ...getResidualDriftPreflightCounters(),
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(2);
  }

  if (!fs.existsSync(EXPECTED_PATH)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      code: 'expected_contract_missing',
      liveMutation: false,
    })}\n`);
    process.exit(2);
  }

  const expectedContract = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
  const result = await executeResidualDriftPreflight({
    env: process.env,
    argv,
    expectedContract,
  });

  const safe = {
    ok: result.ok === true,
    code: result.code,
    sameTarget: result.sameTarget === true,
    sameTargetReason: result.sameTargetReason || null,
    blocker: result.blocker || null,
    sessionReadOnly: result.sessionReadOnly === true,
    transactionReadOnly: result.transactionReadOnly === true,
    serverVersionClass: result.serverVersionClass || null,
    observerAfter: result.observerAfter || null,
    baseline: result.baseline || null,
    inventory: result.inventory
      ? {
        count: result.inventory.count,
        // Secret-free: keys/sections/ranks only — no row values.
        items: Array.isArray(result.inventory.items)
          ? result.inventory.items.map((i) => ({
            key: i.key,
            section: i.section,
            kind: i.kind,
            constraintCategory: i.constraintCategory || null,
            ownerMigrationId: i.ownerMigrationId || null,
            dependencyOrderRank: i.dependencyOrderRank,
            missingOwner: i.missingOwner === true,
          }))
          : [],
      }
      : null,
    preflightResults: Array.isArray(result.preflightResults)
      ? result.preflightResults.map((p) => ({
        key: p.key,
        section: p.section,
        kind: p.kind,
        category: p.category || null,
        outcomeClass: p.outcomeClass || null,
        code: p.code || null,
        null_count: p.null_count != null ? Number(p.null_count) : undefined,
        table_total: p.table_total != null ? Number(p.table_total) : undefined,
        duplicate_count: p.duplicate_count != null ? Number(p.duplicate_count) : undefined,
        orphan_count: p.orphan_count != null ? Number(p.orphan_count) : undefined,
        violation_count: p.violation_count != null ? Number(p.violation_count) : undefined,
        execute: false,
      }))
      : null,
    mutationBatches: result.mutationBatches || null,
    coverage: result.coverage || null,
    productFingerprintLive: result.productFingerprintLive || null,
    applicationName: result.applicationName || APPLICATION_NAME,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    kvMutation: false,
    rbacMutation: false,
    networkMutation: false,
    clientsInstantiated: result.clientsInstantiated || 0,
    connectCalls: result.connectCalls || 0,
    queryCalls: result.queryCalls || 0,
    endCalls: result.endCalls || 0,
    httpRequestCount: result.httpRequestCount || 0,
    imdsRequestCount: result.imdsRequestCount || 0,
    keyVaultRequestCount: result.keyVaultRequestCount || 0,
    closed: result.closed === true,
    committed: result.committed === true,
    rolledBack: result.rolledBack === true,
    execute: false,
    errors: result.errors || [],
  };

  process.stdout.write(`${JSON.stringify(safe)}\n`);
  process.exit(result.ok === true ? 0 : 4);
}

main().catch((e) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    code: e.code || 'cli_failed',
    message: String(e.message || e).slice(0, 240),
    liveMutation: false,
  })}\n`);
  process.exit(1);
});
