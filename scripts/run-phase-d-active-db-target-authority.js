'use strict';

/**
 * run-phase-d-active-db-target-authority — FOUNDATION Slice 14Q
 *
 * Default-disabled operator CLI that proves active Staff API ↔ Key Vault admin
 * DB target authority (read-only) behind exact env+argv gates.
 *
 * DEFAULT: refused (zero ARM / zero KV / zero PostgreSQL Clients).
 * Never prints/persists DSN, passwords, tokens, or secret versions.
 *
 * Usage (default refuse):
 *   node scripts/run-phase-d-active-db-target-authority.js
 */

const fs = require('fs');
const path = require('path');
const {
  loadManifest,
  forwardEntries,
  MANIFEST_PATH,
} = require('./lib/migration-integrity');
const {
  evaluateTargetAuthorityGates,
  executeActiveDbTargetAuthority,
  printCliHelp,
  resetTargetAuthorityCounters,
  getTargetAuthorityCounters,
  CLI_PROVE_TARGET_AUTHORITY,
  PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED,
  APPLICATION_NAME,
  AUTHORITY_LOCKS,
} = require('./lib/phase-d-active-db-target-authority');
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

function buildExpectedChecksumById() {
  const manifest = loadManifest(MANIFEST_PATH);
  const forward = forwardEntries(manifest);
  const map = Object.create(null);
  for (const e of forward) {
    if (e && e.id && e.sha256) map[String(e.id)] = String(e.sha256);
  }
  return map;
}

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
    targetAuthorityLiveEnabled: PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED === true,
    liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    note: 'Default path refused — zero ARM / zero KV / zero pg Clients',
    applicationName: APPLICATION_NAME,
    subscriptionId: AUTHORITY_LOCKS.subscriptionId,
    resourceGroup: AUTHORITY_LOCKS.resourceGroup,
    containerAppName: AUTHORITY_LOCKS.containerAppName,
    postgresHost: AUTHORITY_LOCKS.postgresHost,
    database: AUTHORITY_LOCKS.database,
  };
}

function failClosedCatch(err) {
  return {
    ok: false,
    code: 'target_authority_unhandled',
    sameTarget: false,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    kvMutation: false,
    clientsInstantiated: getTargetAuthorityCounters().clientsInstantiated,
    httpRequestCount: getTargetAuthorityCounters().httpRequestCount,
    liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
    targetAuthorityLiveEnabled: PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED === true,
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

  resetTargetAuthorityCounters();

  if (!argv.includes(CLI_PROVE_TARGET_AUTHORITY) && argv.length === 0) {
    console.log(printCliHelp());
    console.log('');
    console.log(JSON.stringify(defaultRefuseOutput(), null, 2));
    process.exit(2);
  }

  const gates = evaluateTargetAuthorityGates({ env: process.env, argv });
  if (!gates.ok) {
    console.log(JSON.stringify({
      ok: false,
      code: gates.errors[0] ? gates.errors[0].code : 'target_authority_gates_rejected',
      sameTarget: false,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      clientsInstantiated: 0,
      httpRequestCount: 0,
      errors: gates.errors,
      message: 'target authority gates rejected — zero ARM / zero KV / zero pg Clients',
      applicationName: APPLICATION_NAME,
      liveApplyEnabled: PHASE_D_LIVE_APPLY_ENABLED === true,
      targetAuthorityLiveEnabled: PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED === true,
    }, null, 2));
    process.exit(2);
  }

  const expectedContract = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
  const expectedChecksumById = buildExpectedChecksumById();

  const result = await executeActiveDbTargetAuthority({
    env: process.env,
    argv,
    expectedContract,
    expectedChecksumById,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(JSON.stringify(failClosedCatch(err), null, 2));
  process.exit(1);
});
