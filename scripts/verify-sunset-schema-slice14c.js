'use strict';

/**
 * verify:sunset-schema-slice14c — FOUNDATION Slice 14C RED→GREEN
 * Phase D live read-only PostgreSQL adapter (hard-disabled; offline fake Client).
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
  CREDENTIAL_USER_ENV,
  CREDENTIAL_PASSWORD_ENV,
  AUTHORIZED_AGGREGATE_SQL,
  AUTHORIZED_SESSION_SQL,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  createLiveReadonlyAdapters,
} = require('./lib/phase-d-live-readonly-adapters');
const {
  AUTHORIZED_SEQUENCE,
  STATEMENT_TIMEOUT_MS,
  buildVerifiedTlsSslConfig,
  executePhaseDLiveReadonlyPgAdapter,
  createScriptedFakePgClientFactory,
  getPgClientInstantiateCount,
  resetPgClientInstantiateCount,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED: PG_FLAG,
} = require('./lib/phase-d-live-readonly-pg-adapter');
const {
  EXPECTED_028_SHA256,
  AUTHORIZED_AGGREGATE_SQL: AGG_14A,
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');
const {
  createInjectedAzureAdapters,
  createInjectedDbAdapters,
} = require('./lib/phase-d-live-readonly-adapters');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = 'ff136a18c1582e7749220ed00dcb1a7d51c0b999';
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
  'default_path_zero_clients',
  'caller_supplied_dsn_forbidden',
  'caller_supplied_host_forbidden',
  'observer_dsn_forbidden_zero_clients',
  'wrong_reordered_extra_sql_rejected',
  'connect_failure_sanitized_close_occurs',
  'query_failure_rollback_and_close',
  'commit_failure_rollback_and_close',
  'close_failure_sanitized',
];

const REQUIRED_GREEN = [
  'live_disabled_exact_target_zero_clients',
  'exact_sequence_count_only_success',
];

const FAKE_USER = 'verify-slice14c-admin-user';
const FAKE_PASSWORD = 'verify-slice14c-admin-password';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14c — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14c-phase-d-pg-adapter-evidence.json');
  const contractPath = path.join(FIX, 'slice14c-phase-d-pg-adapter-contract.json');
  const findingsPath = path.join(FIX, 'slice14c-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14c-phase-d-pg-adapter.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14c.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-live-readonly-pg-adapter.js');
  const boundaryPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-live-readonly-boundary.js');
  const adaptersPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-live-readonly-adapters.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, libPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const libSrc = fs.readFileSync(libPath, 'utf8');
  const boundarySrc = fs.readFileSync(boundaryPath, 'utf8');
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

  pass('manifest-integrity', integrity.ok === true);
  pass('forward-count-39', forward.length === 39);
  pass('manifest-hash-preserved', manifestHash === MANIFEST_HASH
    && evidence.manifestHashUnchanged === MANIFEST_HASH);
  pass('expected-byte-sha-preserved', expectedHash === EXPECTED_BYTE_SHA
    && evidence.expectedProductSchemaByteSha256 === EXPECTED_BYTE_SHA);
  pass('product-fingerprint-preserved', expected.productFingerprint === CANON_FP
    && evidence.productFingerprintUnchanged === CANON_FP);
  pass(
    '13c-hashes-preserved',
    live028 === LOCKED_13C_SHA['028']
    && live035 === LOCKED_13C_SHA['035']
    && live040 === LOCKED_13C_SHA['040']
    && live041 === LOCKED_13C_SHA['041']
    && evidence.migrationHashes['028'] === LOCKED_13C_SHA['028']
    && evidence.migrationHashes['035'] === LOCKED_13C_SHA['035']
    && evidence.migrationHashes['040'] === LOCKED_13C_SHA['040']
    && evidence.migrationHashes['041'] === LOCKED_13C_SHA['041'],
  );
  pass('028-predicates-unchanged', assert028PredicatesPresentInSource() === true
    && assertMigration028ByteIntegrity() === EXPECTED_028_SHA256
    && AUTHORIZED_AGGREGATE_SQL === AGG_14A
    && contract.predicatesUnchangedFrom14A.date_window === DATE_WINDOW_PREDICATE
    && contract.predicatesUnchangedFrom14A.price_unit === PRICE_UNIT_PREDICATE);

  pass('hard-disabled-flags',
    PHASE_D_LIVE_READONLY_CONNECT_ENABLED === false
    && PG_FLAG === false
    && PHASE_D_LIVE_APPLY_ENABLED === false
    && /PHASE_D_LIVE_READONLY_CONNECT_ENABLED\s*=\s*false/.test(boundarySrc)
    && !/PHASE_D_LIVE_READONLY_CONNECT_ENABLED\s*=\s*true/.test(boundarySrc)
    && !/PHASE_D_LIVE_APPLY_ENABLED\s*=\s*true/.test(libSrc));

  pass('authorized-sequence-locked',
    JSON.stringify(AUTHORIZED_SEQUENCE) === JSON.stringify([
      'BEGIN READ ONLY',
      'SHOW transaction_read_only',
      'catalog_table',
      'catalog_columns',
      'aggregate',
      'COMMIT',
    ])
    && JSON.stringify(evidence.authorizedSequence) === JSON.stringify(AUTHORIZED_SEQUENCE)
    && AUTHORIZED_SESSION_SQL.includes('BEGIN READ ONLY')
    && AUTHORIZED_SESSION_SQL.includes('ROLLBACK'));

  pass('tls-and-timeout-contract',
    buildVerifiedTlsSslConfig().rejectUnauthorized === true
    && buildVerifiedTlsSslConfig().servername === TARGETS.postgresHost
    && STATEMENT_TIMEOUT_MS === 30000
    && contract.tls.rejectUnauthorized === true
    && contract.tls.statementTimeoutMs === 30000
    && /rejectUnauthorized:\s*true/.test(libSrc)
    && /statement_timeout/.test(libSrc));

  pass('credential-contract',
    CREDENTIAL_USER_ENV === 'SUNSET_STAGING_PG_ADMIN_USER'
    && CREDENTIAL_PASSWORD_ENV === 'SUNSET_STAGING_PG_ADMIN_PASSWORD'
    && /caller_supplied_connect_forbidden/.test(libSrc)
    && /protected admin env/i.test(libSrc)
    && !/options\.dsn/.test(libSrc.replace(/dsn != null/g, '')));

  const redNames = (evidence.redCases || []).map((c) => c.name);
  const greenNames = (evidence.greenCases || []).map((c) => c.name);
  pass('red-cases-present', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('green-cases-present', REQUIRED_GREEN.every((n) => greenNames.includes(n)));
  pass('offline-gates',
    evidence.offlineGates.defaultPathZeroClients === true
    && evidence.offlineGates.liveDisabledExactTargetZeroClients === true
    && evidence.offlineGates.exactSequenceCountOnlySuccess === true
    && evidence.offlineGates.wrongReorderedExtraSqlRejected === true
    && evidence.offlineGates.connectFailureSanitizedCloseOccurs === true
    && evidence.offlineGates.queryFailureRollbackAndClose === true
    && evidence.offlineGates.commitFailureRollbackAndClose === true
    && evidence.offlineGates.closeFailureSanitized === true
    && evidence.offlineGates.credentialsNeverInLogsResultsErrors === true);

  pass('no-live-mutation-claims',
    evidence.liveMutation === false
    && evidence.liveQueryExecution === false
    && evidence.liveReadonlyConnectEnabled === false
    && evidence.azureConnectivity === false
    && evidence.firewallAction === false
    && evidence.credentialLoading === false
    && evidence.enableFlagFlipped === false
    && evidence.migrationAdded === false
    && evidence.ledgerWritten === false
    && evidence.stillProductSchemaDiffers === true
    && contract.liveQueryExecution === false
    && contract.mutates === false);

  // Runtime: default path zero clients
  resetPgClientInstantiateCount();
  const def = await executePhaseDLiveReadonlyPgAdapter({ env: {} });
  pass('runtime-default-zero-clients',
    def.ok === false
    && (def.clientsInstantiated || 0) === 0
    && getPgClientInstantiateCount() === 0);

  // Runtime: live-disabled accepted target zero clients
  resetPgClientInstantiateCount();
  const disabled = await executePhaseDLiveReadonlyPgAdapter({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [CREDENTIAL_USER_ENV]: FAKE_USER,
      [CREDENTIAL_PASSWORD_ENV]: FAKE_PASSWORD,
    },
    argv: ['node', 'verify'],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
  });
  pass('runtime-live-disabled-zero-clients',
    disabled.ok === true
    && disabled.code === 'target_accepted_pg_adapter_hard_disabled'
    && disabled.clientsInstantiated === 0
    && getPgClientInstantiateCount() === 0);

  // Runtime: fake Client exact sequence
  resetPgClientInstantiateCount();
  const Fake = createScriptedFakePgClientFactory();
  const ok = await executePhaseDLiveReadonlyPgAdapter({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [CREDENTIAL_USER_ENV]: FAKE_USER,
      [CREDENTIAL_PASSWORD_ENV]: FAKE_PASSWORD,
    },
    argv: ['node', 'verify'],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    Client: Fake,
  });
  const artifactProbe = JSON.stringify(ok);
  pass('runtime-exact-sequence-success',
    ok.ok === true
    && JSON.stringify(ok.steps) === JSON.stringify(AUTHORIZED_SEQUENCE)
    && ok.closed === true
    && ok.clientsInstantiated === 1
    && !artifactProbe.includes(FAKE_PASSWORD)
    && !artifactProbe.includes(FAKE_USER));

  let liveFactoryDisabled = false;
  try {
    createLiveReadonlyAdapters();
  } catch (e) {
    liveFactoryDisabled = e && e.code === 'live_readonly_connect_disabled';
  }
  pass('live-adapter-factory-hard-disabled', liveFactoryDisabled);

  pass('source-forbids-live-mutation-paths',
    /PHASE_D_LIVE_READONLY_CONNECT_ENABLED\s*=\s*false/.test(boundarySrc)
    && !/\baz\s+postgres\b/i.test(proveSrc)
    && !/\baz\s+network\b/i.test(proveSrc)
    && !/--apply\b/.test(libSrc)
    && !/ADD\s+CONSTRAINT\s+tenant_services_date_window/i.test(libSrc)
    && !/schema_migration_ledger/.test(libSrc)
    && /BEGIN READ ONLY/.test(libSrc)
    && /unauthorized_sql/.test(libSrc)
    && /createScriptedFakePgClient/.test(libSrc)
    && /live_readonly_connect_disabled/.test(adaptersSrc)
    && evidence.stillProductSchemaDiffers === true);

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14c-phase-d-pg-adapter']
      === 'node scripts/prove-sunset-schema-slice14c-phase-d-pg-adapter.js'
    && pkg.scripts['verify:sunset-schema-slice14c']
      === 'node scripts/verify-sunset-schema-slice14c.js');

  pass('findings-non-claim',
    /Do not claim/i.test(findings)
    && /Phase D/.test(findings)
    && /Zero live\/Azure mutation/i.test(findings)
    && /hard-disabled/i.test(findings)
    && !/Sunset is repaired/i.test(findings.replace(/Do not claim[\s\S]*?repaired/i, '')));

  const artifactText = `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`;
  pass('no-secret-tokens-in-artifacts',
    !/slice14c-proof-admin-password|slice14c-observer-password|verify-slice14c-admin-password/i.test(artifactText)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(artifactText)
    && !new RegExp(FAKE_USER).test(artifactText)
    && !new RegExp(FAKE_PASSWORD).test(artifactText));

  pass('master-basis',
    evidence.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER);

  pass('verify-is-offline-only',
    !/require\(['"]\.\/lib\/disposable-postgres-harness['"]\)/.test(verifySrc)
    && !/require\(['"]pg['"]\)/.test(verifySrc)
    && !/execSync\s*\(/.test(verifySrc)
    && !/require\(['"].*load-sunset-staging-pg-admin-env['"]\)/.test(verifySrc));

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14c FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14c GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
