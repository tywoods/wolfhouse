'use strict';

/**
 * run-phase-d-identifier-truncation-normalization — FOUNDATION Slice 14X
 *
 * Default-disabled operator CLI: merged target authority + one read-only
 * observer session proving the exact NAMEDATALEN truncated NOT NULL
 * identifier under azure_flexible_server_v1 + postgresql_15.
 *
 * DEFAULT: refused (zero ARM / zero KV / zero PostgreSQL Clients).
 * Never prints/persists DSN, passwords, tokens, or secret versions.
 */

const fs = require('fs');
const path = require('path');
const {
  evaluateIdentifierTruncationNormalizationGates,
  executeIdentifierTruncationNormalization,
  printCliHelp,
  resetIdentifierTruncationNormalizationCounters,
  getIdentifierTruncationNormalizationCounters,
  CLI_PROVE_IDENTIFIER_TRUNCATION_NORMALIZATION,
  PHASE_D_IDENTIFIER_TRUNCATION_NORMALIZATION_LIVE_ENABLED,
  APPLICATION_NAME,
  IDENTIFIER_TRUNCATION_LOCKS,
  BASELINE_MISMATCH_COUNT,
} = require('./lib/phase-d-identifier-truncation-normalization');
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
    identifierTruncationNormalizationLiveEnabled:
      PHASE_D_IDENTIFIER_TRUNCATION_NORMALIZATION_LIVE_ENABLED === true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    note: 'Default path refused — zero ARM / zero KV / zero pg Clients',
    applicationName: APPLICATION_NAME,
    baselineMismatchCountExpected: BASELINE_MISMATCH_COUNT,
    subscriptionId: IDENTIFIER_TRUNCATION_LOCKS.subscriptionId,
    resourceGroup: IDENTIFIER_TRUNCATION_LOCKS.resourceGroup,
    containerAppName: IDENTIFIER_TRUNCATION_LOCKS.containerAppName,
    postgresHost: IDENTIFIER_TRUNCATION_LOCKS.postgresHost,
    database: IDENTIFIER_TRUNCATION_LOCKS.database,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${printCliHelp()}\n`);
    process.exit(0);
  }

  resetIdentifierTruncationNormalizationCounters();
  const gate = evaluateIdentifierTruncationNormalizationGates({ env: process.env, argv });
  if (!gate.ok) {
    const out = {
      ...defaultRefuseOutput(),
      code: (gate.errors[0] && gate.errors[0].code) || 'gates_rejected',
      errors: gate.errors,
      ...getIdentifierTruncationNormalizationCounters(),
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
  const result = await executeIdentifierTruncationNormalization({
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
    observerBefore: result.observerBefore || null,
    observerAfter: result.observerAfter || null,
    baseline: result.baseline || null,
    baselineMismatchCount: result.baselineMismatchCount != null
      ? result.baselineMismatchCount
      : null,
    renameAliasesNormalized: result.renameAliasesNormalized != null
      ? result.renameAliasesNormalized
      : null,
    identifierTruncationsNormalized: result.identifierTruncationsNormalized != null
      ? result.identifierTruncationsNormalized
      : null,
    remainingMismatchCount: result.remainingMismatchCount != null
      ? result.remainingMismatchCount
      : null,
    remainingKeys: Array.isArray(result.remainingKeys) ? result.remainingKeys : [],
    accountingOk: result.accountingOk === true,
    migration002Sha256: result.migration002Sha256 || null,
    provenanceCount: result.provenanceCount != null ? result.provenanceCount : null,
    provenanceTuples: result.provenanceTuples || null,
    lockedTuple: result.lockedTuple || null,
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
