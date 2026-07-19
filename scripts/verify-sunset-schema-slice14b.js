'use strict';

/**
 * verify:sunset-schema-slice14b — FOUNDATION Slice 14B RED→GREEN
 * Phase D live read-only connection boundary (hard-disabled; offline proof).
 * Offline gates + evidence. No Azure / live mutation.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  loadManifest,
  forwardEntries,
  validateManifestIntegrity,
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  sha256CanonicalLfV1File,
} = require('./lib/migration-integrity');
const { hashCanonicalManifest } = require('./lib/sunset-schema-observer');
const {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  CREDENTIAL_ENV,
  CREDENTIAL_FILE_ENV,
  AUTHORIZED_AGGREGATE_SQL,
  AUTHORIZED_SESSION_SQL,
  OUTPUT_COUNT_KEYS,
  evaluateLiveReadonlyBoundary,
  authorizeLiveReadonlySql,
  assertNoNetworkMutation,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  createInjectedAzureAdapters,
  createInjectedDbAdapters,
  createLiveReadonlyAdapters,
} = require('./lib/phase-d-live-readonly-adapters');
const {
  EXPECTED_028_SHA256,
  AUTHORIZED_AGGREGATE_SQL: AGG_14A,
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '8905be445fcce5d23e813f66d339c48580c5ecd9';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const REQUIRED_RED = [
  'missing_dual_flags',
  'single_flag_readonly_only',
  'wrong_subscription',
  'wrong_resource_group',
  'wrong_host',
  'wrong_database',
  'wrong_tls',
  'credential_from_argv',
  'credential_file_not_approved',
  'firewall_mutation_planned',
];

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14b — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14b-phase-d-live-readonly-boundary-evidence.json');
  const contractPath = path.join(FIX, 'slice14b-phase-d-live-readonly-boundary-contract.json');
  const findingsPath = path.join(FIX, 'slice14b-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14b-phase-d-live-readonly-boundary.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14b.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-live-readonly-boundary.js');
  const adaptersPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-live-readonly-adapters.js');
  const lib14aPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-check-preflight.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, libPath, adaptersPath, lib14aPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const libSrc = fs.readFileSync(libPath, 'utf8');
  const adaptersSrc = fs.readFileSync(adaptersPath, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const expectedBytes = fs.readFileSync(expectedPath);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);

  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));

  pass('manifest-integrity', integrity.ok, JSON.stringify((integrity.errors || []).slice(0, 3)));
  pass('forward-count-unchanged-39',
    forward.length === 39
    && expected.forwardCount === 39
    && evidence.forwardCountUnchanged === 39
    && evidence.newForwardMigration === false);

  pass('locked-hashes-unchanged',
    live028 === LOCKED_13C_SHA['028']
    && live035 === LOCKED_13C_SHA['035']
    && live040 === LOCKED_13C_SHA['040']
    && live041 === LOCKED_13C_SHA['041']
    && manifestHash === MANIFEST_HASH
    && expectedHash === EXPECTED_BYTE_SHA
    && expected.productFingerprint === CANON_FP
    && evidence.migrationHashes['028'] === LOCKED_13C_SHA['028']
    && evidence.migrationHashes['035'] === LOCKED_13C_SHA['035']
    && evidence.migrationHashes['040'] === LOCKED_13C_SHA['040']
    && evidence.migrationHashes['041'] === LOCKED_13C_SHA['041']
    && evidence.manifestHashUnchanged === MANIFEST_HASH
    && evidence.productFingerprintUnchanged === CANON_FP
    && evidence.expectedProductSchemaByteSha256 === EXPECTED_BYTE_SHA
    && assertMigration028ByteIntegrity() === EXPECTED_028_SHA256
    && assert028PredicatesPresentInSource() === true
    && AUTHORIZED_AGGREGATE_SQL === AGG_14A);

  pass('master-sha-basis',
    evidence.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER
    && /8905be445fcce5d23e813f66d339c48580c5ecd9/.test(findings));

  pass('hard-disabled-no-live-connect-or-apply',
    PHASE_D_LIVE_READONLY_CONNECT_ENABLED === false
    && PHASE_D_LIVE_APPLY_ENABLED === false
    && evidence.liveReadonlyConnectEnabled === false
    && evidence.liveQueryExecution === false
    && evidence.liveMutation === false
    && evidence.azureConnectivity === false
    && evidence.firewallAction === false
    && evidence.networkMutation === false
    && evidence.migrationAdded === false
    && evidence.ledgerWritten === false
    && evidence.applyFlagPresent === false
    && evidence.phaseDConstraintsApplied === false
    && contract.liveReadonlyConnectEnabled === false
    && contract.liveApplyCapability === false
    && contract.liveQueryExecution === false
    && contract.defaultEnabled === false);

  pass('locked-targets',
    TARGETS.subscriptionId === '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9'
    && TARGETS.resourceGroup === 'luna-sunset-staging-rg'
    && TARGETS.postgresServer === 'luna-sunset-staging-pg-app'
    && TARGETS.postgresHost === 'luna-sunset-staging-pg-app.postgres.database.azure.com'
    && TARGETS.database === 'sunset_staging'
    && TARGETS.sslmode === 'verify-full'
    && TARGETS.applicationName === 'wh-sunset-phase-d-preflight'
    && contract.targets.subscriptionId === TARGETS.subscriptionId
    && evidence.targets.database === TARGETS.database);

  pass('credential-boundary',
    CREDENTIAL_ENV === 'SUNSET_SCHEMA_OBSERVER_DATABASE_URL'
    && CREDENTIAL_FILE_ENV === 'SUNSET_PHASE_D_LIVE_DSN_FILE'
    && contract.credentialSources.approvedEnv === CREDENTIAL_ENV
    && contract.credentialSources.forbidden.includes('argv')
    && contract.credentialSources.forbidden.includes('committed_files')
    && /never from argv/i.test(findings));

  pass('dual-enable-flags',
    ENV_LIVE_READONLY === 'SUNSET_PHASE_D_LIVE_READONLY'
    && ENV_LIVE_PREFLIGHT === 'SUNSET_PHASE_D_LIVE_PREFLIGHT'
    && ENV_SUBSCRIPTION === 'AZURE_SUBSCRIPTION_ID'
    && contract.dualEnableFlagsRequired === true
    && evidence.dualEnableFlagsRequired === true
    && evidence.offlineGates.exactTargetAcceptedOnlyWithDualFlags === true);

  pass('query-authorization-14a-unchanged',
    contract.queryAuthorization.authorizedAggregateSql === AUTHORIZED_AGGREGATE_SQL
    && evidence.queryAuthorization.authorizedAggregateSql === AUTHORIZED_AGGREGATE_SQL
    && contract.queryAuthorization.predicatesUnchangedFrom14A.date_window === DATE_WINDOW_PREDICATE
    && contract.queryAuthorization.predicatesUnchangedFrom14A.price_unit === PRICE_UNIT_PREDICATE
    && AUTHORIZED_SESSION_SQL.includes('BEGIN READ ONLY')
    && OUTPUT_COUNT_KEYS.every((k) => contract.queryAuthorization.outputKeys.includes(k))
    && contract.queryAuthorization.returnsRowValues === false
    && contract.queryAuthorization.acceptsArbitrarySql === false);

  let authOk = false;
  let authBad = false;
  try {
    authorizeLiveReadonlySql(AUTHORIZED_AGGREGATE_SQL);
    authOk = true;
  } catch (_) { authOk = false; }
  try {
    authorizeLiveReadonlySql('SELECT id, notes_for_luna FROM tenant_services');
  } catch (e) {
    authBad = e.code === 'unauthorized_sql';
  }
  pass('exact-aggregate-and-reject-row-sql', authOk && authBad);

  const redNames = (evidence.redCases || []).map((c) => c.name);
  pass('red-matrix',
    REQUIRED_RED.every((n) => redNames.includes(n))
    && (evidence.redCases || []).every((c) => c.ok === true && c.rejected === true && c.connectCalls === 0)
    && evidence.offlineGates.defaultPathZeroConnectionCalls === true
    && evidence.offlineGates.unauthorizedSqlRejected === true
    && evidence.offlineGates.firewallNetworkMutationRejected === true);

  const green = (evidence.greenCases || []).find((c) => c.name === 'exact_target_dual_flags');
  pass('green-exact-target-hard-disabled-connect',
    green
    && green.ok === true
    && green.accepted === true
    && green.connectCalls === 0
    && green.queryCalls === 0
    && green.liveReadonlyConnectEnabled === false);

  // Live offline re-check: default path zero calls
  const defaultResult = await evaluateLiveReadonlyBoundary({
    env: {},
    argv: ['node', 'verify'],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
  });
  pass('runtime-default-zero-calls',
    defaultResult.ok === false
    && defaultResult.counters.connectCalls === 0
    && defaultResult.counters.queryCalls === 0
    && defaultResult.counters.azureCalls === 0
    && defaultResult.counters.connectInfoCalls === 0);

  const FAKE = 'postgresql://sunset_schema_observer:x@'
    + `${TARGETS.postgresHost}:5432/${TARGETS.database}?sslmode=verify-full`;
  const greenRuntime = await evaluateLiveReadonlyBoundary({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [CREDENTIAL_ENV]: FAKE,
    },
    argv: ['node', 'verify'],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
  });
  pass('runtime-green-accept-no-connect',
    greenRuntime.ok === true
    && greenRuntime.accepted === true
    && greenRuntime.counters.connectCalls === 0
    && greenRuntime.counters.queryCalls === 0
    && greenRuntime.liveReadonlyConnectEnabled === false);

  const redHost = await evaluateLiveReadonlyBoundary({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [CREDENTIAL_ENV]: FAKE,
    },
    argv: ['node', 'verify'],
    targets: { ...TARGETS, postgresHost: 'evil.example.com' },
    azureAdapters: createInjectedAzureAdapters({ postgresHost: 'evil.example.com' }),
    dbAdapters: createInjectedDbAdapters({ host: 'evil.example.com' }),
  });
  pass('runtime-red-wrong-host-before-connect',
    redHost.ok === false
    && redHost.counters.connectCalls === 0
    && redHost.counters.queryCalls === 0);

  let liveFactoryDisabled = false;
  try {
    createLiveReadonlyAdapters();
  } catch (e) {
    liveFactoryDisabled = e && e.code === 'live_readonly_connect_disabled';
  }
  pass('live-adapter-factory-hard-disabled', liveFactoryDisabled);

  pass('no-network-mutation',
    assertNoNetworkMutation('az postgres flexible-server show').ok === true
    && assertNoNetworkMutation('az network private-endpoint create').ok === false
    && evidence.offlineGates.firewallNetworkMutationRejected === true);

  pass('source-forbids-live-mutation-paths',
    /PHASE_D_LIVE_READONLY_CONNECT_ENABLED\s*=\s*false/.test(libSrc)
    && !/PHASE_D_LIVE_READONLY_CONNECT_ENABLED\s*=\s*true/.test(libSrc)
    && !/PHASE_D_LIVE_APPLY_ENABLED\s*=\s*true/.test(libSrc)
    && !/\baz\s+postgres\b/i.test(proveSrc)
    && !/\baz\s+network\b/i.test(proveSrc)
    && !/--apply\b/.test(libSrc)
    && !/ADD\s+CONSTRAINT\s+tenant_services_date_window/i.test(libSrc)
    && !/schema_migration_ledger/.test(libSrc)
    && /BEGIN READ ONLY/.test(libSrc)
    && /unauthorized_sql/.test(libSrc)
    && /createLiveReadonlyAdapters/.test(adaptersSrc)
    && /live_readonly_connect_disabled/.test(adaptersSrc)
    && evidence.stillProductSchemaDiffers === true);

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14b-phase-d-live-readonly-boundary']
      === 'node scripts/prove-sunset-schema-slice14b-phase-d-live-readonly-boundary.js'
    && pkg.scripts['verify:sunset-schema-slice14b']
      === 'node scripts/verify-sunset-schema-slice14b.js');

  pass('findings-non-claim',
    /Do not claim/i.test(findings)
    && /Phase D/.test(findings)
    && /Zero live\/Azure mutation/i.test(findings)
    && /hard-disabled/i.test(findings)
    && !/Sunset is repaired/i.test(findings.replace(/Do not claim[\s\S]*?repaired/i, '')));

  pass('no-secret-tokens-in-artifacts',
    !/slice14b-proof-password|GUEST_SECRET_|evil@example\.com/.test(
      `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`,
    )
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(
      `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`,
    ));

  pass('verify-is-offline-only',
    !/require\(['"]\.\/lib\/disposable-postgres-harness['"]\)/.test(verifySrc)
    && !/require\(['"]pg['"]\)/.test(verifySrc)
    && !/Client\s*\(\s*\{/.test(verifySrc)
    && !/execSync\s*\(/.test(verifySrc));

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14b FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14b GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
