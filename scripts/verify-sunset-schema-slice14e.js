'use strict';

/**
 * verify:sunset-schema-slice14e — FOUNDATION Slice 14E RED→GREEN
 * Phase D managed-identity credential loader (offline injected HTTP).
 * Offline gates + evidence. No Azure / live mutation / live secret read.
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
  ENV_EXECUTE_COUNT_ONLY,
  CLI_EXECUTE_COUNT_ONLY,
  CREDENTIAL_USER_ENV,
  CREDENTIAL_PASSWORD_ENV,
  AUTHORIZED_AGGREGATE_SQL,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  createInjectedAzureAdapters,
  createInjectedDbAdapters,
} = require('./lib/phase-d-live-readonly-adapters');
const {
  AUTHORIZED_SEQUENCE,
  executePhaseDLiveReadonlyPgAdapter,
  createScriptedFakePgClientFactory,
  getPgClientInstantiateCount,
  resetPgClientInstantiateCount,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED: PG_FLAG,
} = require('./lib/phase-d-live-readonly-pg-adapter');
const {
  evaluatePhaseDLiveReadonlyCliGates,
} = require('./lib/phase-d-live-readonly-cli');
const {
  EXPECTED_028_SHA256,
  AUTHORIZED_AGGREGATE_SQL: AGG_14A,
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  MI_LOADER_LOCKS,
  loadProtectedAdminCredentialsViaManagedIdentity,
  zeroPrivateCredentialRefs,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
} = require('./lib/phase-d-managed-identity-credential-loader');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '6e7c7d6f70e11b2ce77d28d367fc669b60eabe3a';
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
  'default_path_zero_http_and_clients',
  'managed_identity_without_inject_http_disabled',
  'managed_identity_flag_requires_env_and_argv',
  'caller_urls_names_tokens_dsns_rejected',
  'wrong_imds_host_audience_status_redirect_json_rejected',
  'wrong_vault_secret_status_redirect_json_rejected',
  'wrong_secret_pg_target_rejected_before_client',
  'token_dsn_password_bearing_errors_sanitized',
];

const REQUIRED_GREEN = [
  'injected_http_success_reaches_fake_client_exact_sequence',
  'secret_lifetime_zero_after_private_handoff',
  'protected_admin_env_mode_preserved',
  'cli_gates_managed_identity_and_protected_admin_env',
  'locks_imds_vault_secret_api_pg_tls',
];

const FAKE_USER = 'verify-slice14e-admin-user';
const FAKE_PASSWORD = 'verify-slice14e-admin-password';
const FAKE_TOKEN = 'verify-slice14e-imds-token';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14e — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14e-phase-d-managed-identity-loader-evidence.json');
  const contractPath = path.join(FIX, 'slice14e-phase-d-managed-identity-loader-contract.json');
  const findingsPath = path.join(FIX, 'slice14e-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14e-phase-d-managed-identity-loader.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14e.js');
  const loaderPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-managed-identity-credential-loader.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-live-readonly-count-only.js');
  const adapterPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-live-readonly-pg-adapter.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, loaderPath, cliPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const loaderSrc = fs.readFileSync(loaderPath, 'utf8');
  const adapterSrc = fs.readFileSync(adapterPath, 'utf8');
  const cliSrc = fs.readFileSync(cliPath, 'utf8');
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
    && live041 === LOCKED_13C_SHA['041'],
  );
  pass('028-predicates-unchanged', assert028PredicatesPresentInSource() === true
    && assertMigration028ByteIntegrity() === EXPECTED_028_SHA256
    && AUTHORIZED_AGGREGATE_SQL === AGG_14A
    && contract.predicatesUnchangedFrom14A.date_window === DATE_WINDOW_PREDICATE
    && contract.predicatesUnchangedFrom14A.price_unit === PRICE_UNIT_PREDICATE);

  pass('connect-activated-apply-disabled-http-disabled',
    PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true
    && PG_FLAG === true
    && PHASE_D_LIVE_APPLY_ENABLED === false
    && PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === false
    && /PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED\s*=\s*false/.test(loaderSrc)
    && evidence.liveHttpEnabled === false
    && contract.liveHttpEnabled === false);

  pass('locks-exact',
    MI_LOADER_LOCKS.imdsHost === '169.254.169.254'
    && MI_LOADER_LOCKS.vaultResourceAudience === 'https://vault.azure.net'
    && MI_LOADER_LOCKS.keyVaultName === 'luna-sunset-staging-kv'
    && MI_LOADER_LOCKS.keyVaultHttpsUrl === 'https://luna-sunset-staging-kv.vault.azure.net'
    && MI_LOADER_LOCKS.secretName === 'sunset-database-url'
    && MI_LOADER_LOCKS.imdsApiVersion === '2018-02-01'
    && MI_LOADER_LOCKS.keyVaultApiVersion === '7.4'
    && MI_LOADER_LOCKS.managedIdentityClientId === '0e05fbe3-e8c5-48aa-a914-30aed284e6f7'
    && MI_LOADER_LOCKS.postgresHost === TARGETS.postgresHost
    && MI_LOADER_LOCKS.database === TARGETS.database
    && MI_LOADER_LOCKS.sslmode === 'verify-full'
    && contract.managedIdentityLocks.secretName === 'sunset-database-url');

  pass('credential-source-flags',
    ENV_CREDENTIAL_SOURCE === 'SUNSET_PHASE_D_CREDENTIAL_SOURCE'
    && CLI_CREDENTIAL_SOURCE === '--credential-source'
    && CREDENTIAL_SOURCE_MANAGED_IDENTITY === 'managed-identity'
    && CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV === 'protected-admin-env'
    && contract.managedIdentityCredentialSourceFlagRequired === true
    && /credential-source managed-identity/.test(findings)
    && cliSrc.includes('credential-source'));

  const redNames = (evidence.redCases || []).map((c) => c.name);
  const greenNames = (evidence.greenCases || []).map((c) => c.name);
  pass('red-cases-present', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('green-cases-present', REQUIRED_GREEN.every((n) => greenNames.includes(n)));
  pass('offline-gates',
    evidence.offlineGates.defaultPathZeroHttpAndClients === true
    && evidence.offlineGates.injectedHttpSuccessReachesFakeClientExactSequence === true
    && evidence.offlineGates.secretLifetimeZeroAfterPrivateHandoff === true
    && evidence.offlineGates.protectedAdminEnvModePreserved === true
    && evidence.realImdsCall === false
    && evidence.realKeyVaultCall === false
    && evidence.realPostgresCall === false
    && evidence.liveMutation === false
    && evidence.stillProductSchemaDiffers === true);

  pass('secret-lifetime-evidence',
    evidence.secretLifetimeProof.privateFieldsPresentBeforeZero === true
    && evidence.secretLifetimeProof.zeroedAfterHandoff === true
    && evidence.secretLifetimeProof.neverPrinted === true
    && evidence.secretLifetimeProof.neverPersisted === true
    && evidence.secretLifetimeProof.neverHashedIntoEvidence === true
    && evidence.secretLifetimeProof.neverInArgv === true
    && evidence.secretLifetimeProof.neverInTempFile === true
    && evidence.secretLifetimeProof.neverInChildProcessEnv === true);

  pass('call-counts-evidence',
    evidence.redCaseCount === REQUIRED_RED.length
    && evidence.greenCaseCount === REQUIRED_GREEN.length
    && evidence.httpCallCounts.successPathHttpRequestCount === 2
    && evidence.httpCallCounts.defaultPathHttpRequestCount === 0
    && evidence.clientCallCounts.successPathClientsInstantiated === 1
    && evidence.clientCallCounts.defaultPathClientsInstantiated === 0);

  // Runtime: default zero HTTP
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const def = await loadProtectedAdminCredentialsViaManagedIdentity({ env: {}, argv: [] });
  pass('runtime-default-zero-http',
    def.ok === false
    && getManagedIdentityHttpCounters().httpRequestCount === 0);

  // Runtime: MI success with injected HTTP + fake Client
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const secretValue = buildOfflineProofSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD);
  const Fake = createScriptedFakePgClientFactory();
  const ok = await executePhaseDLiveReadonlyPgAdapter({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_EXECUTE_COUNT_ONLY]: '1',
      [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    },
    argv: [
      'node', 'verify', CLI_EXECUTE_COUNT_ONLY,
      '--subscription', TARGETS.subscriptionId,
      '--resource-group', TARGETS.resourceGroup,
      '--postgres-server', TARGETS.postgresServer,
      '--database', TARGETS.database,
      CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_TOKEN,
      defaultSecretValue: secretValue,
    }),
    Client: Fake,
  });
  const probe = JSON.stringify(ok);
  pass('runtime-mi-injected-sequence',
    ok.ok === true
    && ok.credentialSource === 'managed_identity'
    && JSON.stringify(ok.steps) === JSON.stringify(AUTHORIZED_SEQUENCE)
    && ok.clientsInstantiated === 1
    && getManagedIdentityHttpCounters().httpRequestCount === 2
    && !probe.includes(FAKE_PASSWORD)
    && !probe.includes(FAKE_USER)
    && !probe.includes(FAKE_TOKEN)
    && !probe.includes(secretValue));

  // Runtime: secret lifetime zero
  const loaded = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: {
      [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    },
    argv: [CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY],
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_TOKEN,
      defaultSecretValue: secretValue,
    }),
  });
  pass('runtime-secret-lifetime',
    loaded.ok === true
    && Boolean(loaded._user)
    && Boolean(loaded._password)
    && zeroPrivateCredentialRefs(loaded).zeroed === true
    && loaded._user == null
    && loaded._password == null
    && loaded._connectConfig == null);

  // Runtime: protected-admin-env preserved
  resetPgClientInstantiateCount();
  const envMode = await executePhaseDLiveReadonlyPgAdapter({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_EXECUTE_COUNT_ONLY]: '1',
      [CREDENTIAL_USER_ENV]: FAKE_USER,
      [CREDENTIAL_PASSWORD_ENV]: FAKE_PASSWORD,
    },
    argv: [
      'node', 'verify', CLI_EXECUTE_COUNT_ONLY,
      '--subscription', TARGETS.subscriptionId,
      '--resource-group', TARGETS.resourceGroup,
      '--postgres-server', TARGETS.postgresServer,
      '--database', TARGETS.database,
    ],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    Client: createScriptedFakePgClientFactory(),
  });
  pass('runtime-protected-admin-env-preserved',
    envMode.ok === true && envMode.credentialSource === 'protected_admin_env');

  const cliMi = evaluatePhaseDLiveReadonlyCliGates({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_EXECUTE_COUNT_ONLY]: '1',
      [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    },
    argv: [
      CLI_EXECUTE_COUNT_ONLY,
      '--subscription', TARGETS.subscriptionId,
      '--resource-group', TARGETS.resourceGroup,
      '--postgres-server', TARGETS.postgresServer,
      '--database', TARGETS.database,
      CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ],
  });
  pass('runtime-cli-mi-gates', cliMi.ok === true && cliMi.managedIdentityCredentialSource === true);

  pass('source-forbids-live-mutation',
    !/\baz\s+keyvault\b/i.test(proveSrc)
    && !/\baz\s+postgres\b/i.test(proveSrc)
    && !/--apply\b/.test(adapterSrc)
    && !/ADD\s+CONSTRAINT\s+tenant_services_date_window/i.test(adapterSrc)
    && !/schema_migration_ledger/.test(adapterSrc)
    && /PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED\s*=\s*false/.test(loaderSrc)
    && evidence.stillProductSchemaDiffers === true);

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14e-phase-d-managed-identity-loader']
      === 'node scripts/prove-sunset-schema-slice14e-phase-d-managed-identity-loader.js'
    && pkg.scripts['verify:sunset-schema-slice14e']
      === 'node scripts/verify-sunset-schema-slice14e.js');

  pass('findings-non-claim',
    /Do not claim/i.test(findings)
    && /Zero live\/Azure mutation/i.test(findings)
    && /managed-identity/i.test(findings)
    && !/Sunset is repaired/i.test(findings.replace(/Do not claim[\s\S]*?repaired/i, '')));

  const artifactText = `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`;
  pass('no-secret-tokens-in-artifacts',
    !/slice14e-proof-admin-password|verify-slice14e-admin-password|slice14e-proof-imds-token/i.test(artifactText)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(artifactText));

  pass('master-basis',
    evidence.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER);

  pass('verify-is-offline-only',
    !/require\(['"]pg['"]\)/.test(verifySrc)
    && !/require\(['"].*load-sunset-staging-pg-admin-env['"]\)/.test(verifySrc)
    && /createInjectedManagedIdentityHttp/.test(verifySrc));

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14e FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14e GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
