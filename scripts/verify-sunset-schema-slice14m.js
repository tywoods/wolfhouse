'use strict';

/**
 * verify:sunset-schema-slice14m — FOUNDATION Slice 14M RED→GREEN
 * Phase D live read-only counts (offline gates + live evidence).
 * Does NOT re-run live credential-preflight or live count.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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
  AUTHORIZED_AGGREGATE_SQL,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_EXECUTE_COUNT_ONLY,
  CLI_EXECUTE_COUNT_ONLY,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
} = require('./lib/phase-d-live-readonly-boundary');
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
const {
  AUTHORIZED_SEQUENCE,
  executePhaseDLiveReadonlyPgAdapter,
  createScriptedFakePgClientFactory,
  getPgClientInstantiateCount,
  resetPgClientInstantiateCount,
  classifyConnectError,
  CONNECT_FAILED_SAFE_MESSAGE,
  CONNECT_DRIVER_CODE_CATEGORY,
  CONNECT_MESSAGE_SYNTHETIC_CODE,
  CONNECT_MESSAGE_PROBE_MAX_LEN,
  CONNECT_CATEGORIES,
} = require('./lib/phase-d-live-readonly-pg-adapter');
const {
  evaluatePhaseDLiveReadonlyCliGates,
} = require('./lib/phase-d-live-readonly-cli');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  MI_LOADER_LOCKS,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
} = require('./lib/phase-d-managed-identity-credential-loader');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '45203b370997917fc8c3a39cf87948f46d9e5b5a';
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
  'missing_execute_gate_zero_clients',
  'wrong_or_forbidden_cli_args_zero_clients',
  'managed_identity_requires_env_and_argv',
  'connect_classifier_secret_messages_sanitize',
];

const REQUIRED_GREEN = [
  'injected_http_success_exact_count_sequence',
  'cli_gates_managed_identity_exact_targets',
  'count_only_cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'apply_disabled_connect_and_http_enabled',
  'connect_classifier_category_mappings',
];

const FAKE_USER = 'verify-slice14m-admin-user';
const FAKE_PASSWORD = 'verify-slice14m-admin-password';
const FAKE_TOKEN = 'verify-slice14m-imds-token';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function miEnv(extra) {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    [ENV_EXECUTE_COUNT_ONLY]: '1',
    [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ...(extra || {}),
  };
}

function miArgv() {
  return [
    CLI_EXECUTE_COUNT_ONLY,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

async function main() {
  console.log('verify:sunset-schema-slice14m — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14m-phase-d-live-readonly-counts-evidence.json');
  const contractPath = path.join(FIX, 'slice14m-phase-d-live-readonly-counts-contract.json');
  const findingsPath = path.join(FIX, 'slice14m-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14m-phase-d-live-readonly-counts.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14m.js');
  const countCliPath = path.join(ROOT, 'scripts', 'run-phase-d-live-readonly-count-only.js');
  const preflightCliPath = path.join(ROOT, 'scripts', 'run-phase-d-credential-preflight.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, countCliPath, preflightCliPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
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

  pass('connect-http-activated-apply-disabled',
    PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true
    && PHASE_D_LIVE_APPLY_ENABLED === false
    && PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true
    && evidence.liveHttpEnabled === true
    && evidence.liveApplyEnabled === false
    && contract.liveApplyCapability === false
    && contract.mutates === false);

  pass('command-contract',
    contract.commandContract.countOnly.script === 'scripts/run-phase-d-live-readonly-count-only.js'
    && contract.commandContract.countOnly.npm === 'phase-d:live-readonly-count-only'
    && contract.commandContract.credentialPreflight.script === 'scripts/run-phase-d-credential-preflight.js'
    && contract.dualEnableFlagsRequired === true
    && contract.executeCountOnlyGateRequired === true
    && contract.managedIdentityCredentialSourceFlagRequired === true
    && contract.credentialPreflightRequiredBeforeLiveCount === true
    && contract.existingCliGatesUnchanged === true
    && contract.defaultEnabled === false);

  pass('locks-exact',
    MI_LOADER_LOCKS.managedIdentityName === 'wh-staging-identity'
    && MI_LOADER_LOCKS.keyVaultName === 'luna-sunset-staging-kv'
    && MI_LOADER_LOCKS.secretName === 'sunset-database-url'
    && MI_LOADER_LOCKS.sslmode === 'verify-full'
    && TARGETS.applicationName === 'wh-sunset-phase-d-preflight'
    && TARGETS.postgresHost === 'luna-sunset-staging-pg-app.postgres.database.azure.com'
    && contract.managedIdentityLocks.managedIdentityName === 'wh-staging-identity'
    && contract.managedIdentityLocks.applicationName === 'wh-sunset-phase-d-preflight');

  const redNames = (evidence.redCases || []).map((c) => c.name);
  const greenNames = (evidence.greenCases || []).map((c) => c.name);
  pass('red-cases-present', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('green-cases-present', REQUIRED_GREEN.every((n) => greenNames.includes(n)));

  const preflight = evidence.credentialPreflightOutcome || {};
  const liveCount = evidence.liveCountOutcome;
  const attempt1 = evidence.liveCountAttempt1;
  const attempt2 = evidence.liveCountDiagnosticAttempt2;
  const attempt3 = evidence.liveCountDiagnosticAttempt3;
  pass('offline-gates',
    evidence.offlineGates.defaultPathZeroHttpAndClients === true
    && evidence.offlineGates.injectedHttpSuccessExactCountSequence === true
    && evidence.offlineGates.countOnlyCliDefaultDisabled === true
    && evidence.offlineGates.applyDisabledConnectAndHttpEnabled === true
    && evidence.offlineGates.connectClassifierSecretMessagesSanitize === true
    && evidence.offlineGates.connectClassifierCategoryMappings === true
    && evidence.liveMutation === false
    && evidence.stillProductSchemaDiffers === true
    && evidence.existingCliGatesUnchanged === true
    && evidence.connectErrorClassifierApplied === true
    && evidence.connectMessageClassifierApplied === true
    && evidence.diagnosticAttempt2Authorized === true
    && evidence.diagnosticAttempt3Authorized === true
    && contract.connectErrorClassifierRequired === true
    && contract.connectMessageClassifierRequired === true
    && contract.diagnosticAttempt2Authorized === true
    && contract.diagnosticAttempt3Authorized === true);

  pass('live-evidence-recorded',
    evidence.credentialPreflightAttemptCount === 3
    && evidence.liveCountAttemptCount === 3
    && typeof evidence.outcome === 'string'
    && evidence.outcome.startsWith('phase_d_live_readonly_counts_')
    && preflight.liveMutation === false
    && preflight.realPostgresCall === false
    && Number.isFinite(preflight.exitCode)
    && attempt1
    && attempt1.attempt === 1
    && attempt1.diagnostic === false
    && attempt1.classifierApplied === false
    && attempt1.code === 'connect_failed'
    && attempt1.blocker === 'connect_failed'
    && attempt2
    && attempt2.attempt === 2
    && attempt2.diagnostic === true
    && attempt2.classifierApplied === true
    && attempt2.code === 'unknown'
    && attempt2.connectCategory === 'unknown'
    && attempt3
    && attempt3.attempt === 3
    && attempt3.diagnostic === true
    && attempt3.classifierApplied === true
    && attempt3.messageClassifierStage === true
    && liveCount
    && liveCount.liveMutation === false
    && typeof liveCount.code === 'string'
    && Number.isFinite(liveCount.exitCode));

  pass('live-outcome-consistency',
    (evidence.outcome === 'phase_d_live_readonly_counts_ok'
      && preflight.ok === true
      && liveCount
      && liveCount.ok === true
      && liveCount.blocker === null
      && evidence.safeCounts != null
      && Number.isFinite(evidence.safeCounts.total_rows)
      && Number.isFinite(evidence.safeCounts.date_window_violations)
      && Number.isFinite(evidence.safeCounts.price_unit_violations))
    || (evidence.outcome === 'phase_d_live_readonly_counts_blocked_at_credential_preflight'
      && preflight.ok === false
      && evidence.safeCounts === null)
    || (evidence.outcome === 'phase_d_live_readonly_counts_blocked'
      && preflight.ok === true
      && liveCount
      && liveCount.ok === false
      && liveCount.blocker != null
      && evidence.safeCounts === null
      && (liveCount.connectCategory == null
        || (CONNECT_CATEGORIES.includes(liveCount.connectCategory)
          && liveCount.message === CONNECT_FAILED_SAFE_MESSAGE))));

  pass('attempt-history-retained',
    evidence.liveCountAttempt1.code === 'connect_failed'
    && evidence.liveCountDiagnosticAttempt2
    && evidence.liveCountDiagnosticAttempt3
    && evidence.liveCountOutcome
    && evidence.liveCountDiagnosticAttempt2.attempt === 2
    && evidence.liveCountDiagnosticAttempt2.code === 'unknown'
    && evidence.liveCountDiagnosticAttempt2.connectCategory === 'unknown'
    && evidence.liveCountDiagnosticAttempt3.attempt === 3
    && evidence.liveCountOutcome.attempt === 3
    && evidence.liveCountDiagnosticAttempt3.code === evidence.liveCountOutcome.code
    && evidence.liveCountDiagnosticAttempt3.blocker === evidence.liveCountOutcome.blocker
    && evidence.clientCallCounts.liveCountAttempt1ClientsInstantiated === 1
    && evidence.clientCallCounts.liveCountAttempt1ConnectCalls === 1
    && evidence.clientCallCounts.liveCountAttempt1QueryCalls === 0
    && evidence.clientCallCounts.liveCountAttempt1EndCalls === 1
    && evidence.clientCallCounts.liveCountAttempt2ClientsInstantiated === 1
    && evidence.clientCallCounts.liveCountAttempt2ConnectCalls === 1
    && evidence.clientCallCounts.liveCountAttempt2QueryCalls === 0
    && evidence.clientCallCounts.liveCountAttempt2EndCalls === 1);

  pass('call-counts-evidence',
    evidence.redCaseCount === REQUIRED_RED.length
    && evidence.greenCaseCount === REQUIRED_GREEN.length
    && evidence.httpCallCounts.successPathHttpRequestCount === 2
    && evidence.httpCallCounts.defaultPathHttpRequestCount === 0
    && evidence.clientCallCounts.successPathClientsInstantiated === 1
    && evidence.clientCallCounts.successPathQueryCalls === AUTHORIZED_SEQUENCE.length
    && evidence.clientCallCounts.defaultPathClientsInstantiated === 0);

  // Runtime offline only — never spawn live CLIs with approval env
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const def = await executePhaseDLiveReadonlyPgAdapter({ env: {}, argv: [] });
  pass('runtime-default-zero-http-clients',
    getManagedIdentityHttpCounters().httpRequestCount === 0
    && getPgClientInstantiateCount() === 0
    && def.liveQueryExecution !== true);

  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const secretValue = buildOfflineProofSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD);
  const FakeOk = createScriptedFakePgClientFactory({
    responses: {
      aggregate: {
        rows: [{
          total_rows: 3,
          date_window_violations: 0,
          price_unit_violations: 0,
        }],
        rowCount: 1,
      },
    },
  });
  const ok = await executePhaseDLiveReadonlyPgAdapter({
    env: miEnv(),
    argv: ['node', 'verify-14m', ...miArgv()],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_TOKEN,
      defaultSecretValue: secretValue,
    }),
    Client: FakeOk,
  });
  const probe = JSON.stringify(ok);
  pass('runtime-injected-mi-count-sequence',
    ok.ok === true
    && ok.credentialSource === 'managed_identity'
    && JSON.stringify(ok.steps) === JSON.stringify(AUTHORIZED_SEQUENCE)
    && ok.clientsInstantiated === 1
    && ok.counters.httpRequestCount === 2
    && ok.counters.queryCalls === AUTHORIZED_SEQUENCE.length
    && ok.closed === true
    && !probe.includes(FAKE_PASSWORD)
    && !probe.includes(FAKE_USER)
    && !probe.includes(FAKE_TOKEN)
    && !probe.includes(secretValue));

  const cliDefault = spawnSync(process.execPath, [countCliPath], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  pass('runtime-cli-default-disabled',
    cliDefault.status !== 0
    && /default_disabled|Default path refused/i.test(`${cliDefault.stdout}${cliDefault.stderr}`));

  const gates = evaluatePhaseDLiveReadonlyCliGates({
    env: miEnv(),
    argv: miArgv(),
  });
  pass('runtime-cli-gates',
    gates.ok === true
    && gates.managedIdentityCredentialSource === true
    && ENV_CREDENTIAL_SOURCE === 'SUNSET_PHASE_D_CREDENTIAL_SOURCE'
    && CLI_CREDENTIAL_SOURCE === '--credential-source');

  // Offline connect classifier — never re-run live
  const evil = 'verify-slice14m-classifier-secret-never-commit';
  const evilDsn = 'postgresql://u:p@h/db';
  const evilCert = 'MIIEverifyPemBody';
  const evilIp = '203.0.113.77';
  const secretTail = ` password=${evil} DSN=${evilDsn} Bearer tokencert=${evilCert} host=leaked.host ip=${evilIp}`;
  const clsUnknown = classifyConnectError(Object.assign(
    new Error(`unclassified boom${secretTail}`),
    { code: 'NOT_ALLOWLISTED', detail: 'x', hostname: 'leaked.host' },
  ));
  const clsDns = classifyConnectError(Object.assign(
    new Error(`ENOTFOUND leaked.host password=${evil}`),
    { code: 'ENOTFOUND' },
  ));
  const clsConn = classifyConnectError({ code: '08006' });
  const clsMsgTls = classifyConnectError(Object.assign(
    new Error(`self-signed certificate SSL/TLS hostname verification${secretTail}`),
    { code: 'ZZ_UNKNOWN' },
  ));
  const clsMsgAuth = classifyConnectError(Object.assign(
    new Error(`password authentication failed SASL SCRAM${secretTail}`),
    { code: 'ZZ_UNKNOWN' },
  ));
  const clsMsgFw = classifyConnectError(Object.assign(
    new Error(`no pg_hba.conf entry; firewall; client IP not allowed to connect${secretTail}`),
    { code: 'ZZ_UNKNOWN' },
  ));
  const clsMsgDns = classifyConnectError(Object.assign(
    new Error(`getaddrinfo name resolution failed${secretTail}`),
    { code: 'ZZ_UNKNOWN' },
  ));
  const clsMsgTimeout = classifyConnectError(Object.assign(
    new Error(`connection timed out${secretTail}`),
    { code: 'ZZ_UNKNOWN' },
  ));
  const clsMsgDb = classifyConnectError(Object.assign(
    new Error(`database "x" does not exist${secretTail}`),
    { code: 'ZZ_UNKNOWN' },
  ));
  const clsMsgCfg = classifyConnectError(Object.assign(
    new Error(`password must be a string${secretTail}`),
    { code: 'ZZ_UNKNOWN', name: 'TypeError' },
  ));
  const clsPrecedence = classifyConnectError(Object.assign(
    new Error(`password authentication certificate pg_hba timed out${secretTail}`),
    { code: 'ENOTFOUND' },
  ));
  const clsProbe = JSON.stringify([
    clsUnknown, clsDns, clsConn, clsMsgTls, clsMsgAuth, clsMsgFw, clsMsgDns,
    clsMsgTimeout, clsMsgDb, clsMsgCfg, clsPrecedence,
  ]);
  pass('runtime-connect-classifier',
    clsUnknown.category === 'unknown'
    && clsUnknown.code === 'unknown'
    && clsUnknown.message === CONNECT_FAILED_SAFE_MESSAGE
    && clsDns.category === 'dns'
    && clsDns.code === 'ENOTFOUND'
    && clsConn.category === 'connection'
    && clsConn.code === '08006'
    && clsMsgTls.category === 'tls'
    && clsMsgTls.code === CONNECT_MESSAGE_SYNTHETIC_CODE.tls
    && clsMsgAuth.category === 'auth'
    && clsMsgAuth.code === CONNECT_MESSAGE_SYNTHETIC_CODE.auth
    && clsMsgFw.category === 'firewall'
    && clsMsgFw.code === CONNECT_MESSAGE_SYNTHETIC_CODE.firewall
    && clsMsgDns.category === 'dns'
    && clsMsgDns.code === CONNECT_MESSAGE_SYNTHETIC_CODE.dns
    && clsMsgTimeout.category === 'timeout'
    && clsMsgTimeout.code === CONNECT_MESSAGE_SYNTHETIC_CODE.timeout
    && clsMsgDb.category === 'database'
    && clsMsgDb.code === CONNECT_MESSAGE_SYNTHETIC_CODE.database
    && clsMsgCfg.category === 'client_config'
    && clsMsgCfg.code === CONNECT_MESSAGE_SYNTHETIC_CODE.client_config
    && clsPrecedence.category === 'dns'
    && clsPrecedence.code === 'ENOTFOUND'
    && !clsProbe.includes(evil)
    && !clsProbe.includes('leaked.host')
    && !clsProbe.includes(evilIp)
    && !clsProbe.includes(evilCert)
    && !/postgresql:\/\//i.test(clsProbe)
    && !clsProbe.includes('password authentication')
    && !clsProbe.includes('getaddrinfo')
    && Object.keys(CONNECT_DRIVER_CODE_CATEGORY).length >= 15
    && CONNECT_CATEGORIES.includes('tls')
    && CONNECT_CATEGORIES.includes('auth')
    && CONNECT_CATEGORIES.includes('firewall')
    && CONNECT_CATEGORIES.includes('client_config')
    && CONNECT_MESSAGE_PROBE_MAX_LEN === 512
    && contract.connectErrorClassifier.safeMessage === CONNECT_FAILED_SAFE_MESSAGE
    && contract.connectErrorClassifier.codeFirstPrecedence === true
    && contract.connectErrorClassifier.messageSyntheticCodes.tls === 'MSG_TLS');

  pass('source-forbids-live-mutation',
    !/\baz\s+keyvault\b/i.test(proveSrc)
    && !/\baz\s+postgres\b/i.test(proveSrc)
    && !/--apply\b/.test(proveSrc)
    && !/ADD\s+CONSTRAINT\s+tenant_services_date_window/i.test(proveSrc)
    && !/schema_migration_ledger/.test(proveSrc)
    && !/INSERT\s+INTO/i.test(proveSrc)
    && evidence.stillProductSchemaDiffers === true);

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14m-phase-d-live-readonly-counts']
      === 'node scripts/prove-sunset-schema-slice14m-phase-d-live-readonly-counts.js'
    && pkg.scripts['verify:sunset-schema-slice14m']
      === 'node scripts/verify-sunset-schema-slice14m.js'
    && pkg.scripts['phase-d:live-readonly-count-only']
      === 'node scripts/run-phase-d-live-readonly-count-only.js'
    && pkg.scripts['phase-d:credential-preflight']
      === 'node scripts/run-phase-d-credential-preflight.js');

  pass('findings-non-claim',
    /Do not claim/i.test(findings)
    && /Zero DB mutation/i.test(findings)
    && /wh-staging-identity/.test(findings)
    && /live read-only counts/i.test(findings)
    && !/Sunset is repaired/i.test(findings.replace(/Do not claim[\s\S]*?repaired/i, '')));

  const artifactText = `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`;
  pass('no-secret-tokens-in-artifacts',
    !/slice14m-proof-admin-password|verify-slice14m-admin-password|slice14m-proof-imds-token/i.test(artifactText)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(artifactText)
    && !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(artifactText));

  pass('master-basis',
    evidence.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER);

  pass('verify-is-offline-only',
    !/credentialPreflightEnv\(\)/.test(verifySrc)
    && !/exactCredentialPreflightArgv\(\)/.test(verifySrc)
    && !/spawnSync\(process\.execPath,\s*\[preflightCliPath/.test(verifySrc)
    && !/spawnSync\(process\.execPath,\s*\[countCliPath,\s*\.\.\./.test(verifySrc)
    && /createInjectedManagedIdentityHttp/.test(verifySrc)
    && /createScriptedFakePgClientFactory/.test(verifySrc)
    && /Does NOT re-run live/.test(verifySrc));

  pass('prove-one-diagnostic-live-count-max',
    /Live section 2\/2/.test(proveSrc)
    && /diagnostic attempt 3/.test(proveSrc)
    && /loadLiveCountAttempt1History/.test(proveSrc)
    && /loadLiveCountAttempt2History/.test(proveSrc)
    && /countAttempted = true/.test(proveSrc)
    && /credentialPreflightAttemptCount: 3/.test(proveSrc)
    && /liveCountAttempt1/.test(proveSrc)
    && /liveCountDiagnosticAttempt2/.test(proveSrc)
    && /liveCountDiagnosticAttempt3/.test(proveSrc)
    && /messageClassifierStage: true/.test(proveSrc)
    && /CONNECT_MESSAGE_SYNTHETIC_CODE/.test(proveSrc)
    && (proveSrc.match(/spawnSync\(/g) || []).length === 3);

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14m FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14m GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
