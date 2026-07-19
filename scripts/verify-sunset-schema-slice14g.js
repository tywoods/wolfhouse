'use strict';

/**
 * verify:sunset-schema-slice14g — FOUNDATION Slice 14G RED→GREEN
 * Phase D live metadata-only credential-preflight (offline gates + live evidence).
 * Does NOT re-run live CLI.
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
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  MI_LOADER_LOCKS,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
} = require('./lib/phase-d-managed-identity-credential-loader');
const {
  ENV_CREDENTIAL_PREFLIGHT,
  CLI_CREDENTIAL_PREFLIGHT_ONLY,
  CREDENTIAL_PREFLIGHT_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  evaluateCredentialPreflightGates,
  executeCredentialPreflight,
  exactCredentialPreflightArgv,
  credentialPreflightEnv,
  resetPgClientInstantiateCount,
  resetManagedIdentityHttpCounters,
  getPgClientInstantiateCount,
  getManagedIdentityHttpCounters,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
} = require('./lib/phase-d-credential-preflight');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = 'cbd5512afbf73b0a84ead6113d6d919de7b2b411';
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
  'missing_env_approval_zero_http',
  'missing_or_wrong_exact_targets_zero_http',
  'live_http_activated_offline_inject_required',
  'forbidden_dsn_host_query_token_argv',
  'no_post_put_patch_delete',
];

const REQUIRED_GREEN = [
  'injected_http_exact_two_call_success_safe_metadata',
  'cli_gates_exact_targets_and_managed_identity',
  'cli_default_disabled',
  'locks_subscription_rg_vm_identity_vault_secret_pg_tls',
  'live_http_transport_present_in_loader_source',
];

const FAKE_USER = 'verify-slice14g-admin-user';
const FAKE_PASSWORD = 'verify-slice14g-admin-password';
const FAKE_TOKEN = 'verify-slice14g-imds-token';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14g — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14g-phase-d-live-credential-preflight-evidence.json');
  const contractPath = path.join(FIX, 'slice14g-phase-d-live-credential-preflight-contract.json');
  const findingsPath = path.join(FIX, 'slice14g-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14g-phase-d-live-credential-preflight.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14g.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-credential-preflight.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-credential-preflight.js');
  const loaderPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-managed-identity-credential-loader.js');
  const countOnlyPath = path.join(ROOT, 'scripts', 'run-phase-d-live-readonly-count-only.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, cliPath, libPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const cliSrc = fs.readFileSync(cliPath, 'utf8');
  const libSrc = fs.readFileSync(libPath, 'utf8');
  const loaderSrc = fs.readFileSync(loaderPath, 'utf8');
  const countOnlySrc = fs.readFileSync(countOnlyPath, 'utf8');
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

  pass('connect-activated-apply-disabled-http-activated',
    PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true
    && PHASE_D_LIVE_APPLY_ENABLED === false
    && PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true
    && /PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED\s*=\s*true/.test(loaderSrc)
    && evidence.liveHttpEnabled === true
    && evidence.enableFlagFlipped === true
    && contract.liveHttpEnabled === true
    && contract.neverInstantiatesPgClient === true);

  pass('command-contract',
    contract.commandContract.script === 'scripts/run-phase-d-credential-preflight.js'
    && contract.commandContract.npm === 'phase-d:credential-preflight'
    && contract.credentialPreflightEnvRequired === true
    && contract.credentialPreflightFlagRequired === true
    && contract.managedIdentityCredentialSourceFlagRequired === true
    && contract.exactTargetCliConfirmationRequired === true
    && contract.neverInstantiatesPgClient === true
    && contract.countOnlyCommandUnchanged === true
    && contract.defaultEnabled === false
    && ENV_CREDENTIAL_PREFLIGHT === 'SUNSET_PHASE_D_CREDENTIAL_PREFLIGHT'
    && CLI_CREDENTIAL_PREFLIGHT_ONLY === '--credential-preflight-only'
    && FORBIDDEN_ARGV_FLAGS.every((f) => contract.commandContract.forbiddenArgv.includes(f))
    && SAFE_OUTPUT_KEYS.every((k) => contract.commandContract.safeOutputKeys.includes(k))
    && cliSrc.includes(CLI_CREDENTIAL_PREFLIGHT_ONLY)
    && libSrc.includes('executeCredentialPreflight'));

  pass('locks-exact',
    CREDENTIAL_PREFLIGHT_LOCKS.managedIdentityName === 'wh-staging-identity'
    && CREDENTIAL_PREFLIGHT_LOCKS.keyVaultName === 'luna-sunset-staging-kv'
    && CREDENTIAL_PREFLIGHT_LOCKS.secretName === 'sunset-database-url'
    && CREDENTIAL_PREFLIGHT_LOCKS.vmResourceGroup === 'wh-staging-rg'
    && CREDENTIAL_PREFLIGHT_LOCKS.vmName === 'lunabox'
    && CREDENTIAL_PREFLIGHT_LOCKS.postgresHost === TARGETS.postgresHost
    && CREDENTIAL_PREFLIGHT_LOCKS.database === TARGETS.database
    && CREDENTIAL_PREFLIGHT_LOCKS.sslmode === 'verify-full'
    && MI_LOADER_LOCKS.managedIdentityClientId === '0dd41fa2-52c8-4e04-bc23-8aa462938c19'
    && contract.credentialPreflightLocks.managedIdentityName === 'wh-staging-identity');

  pass('count-only-unchanged',
    evidence.countOnlyCommandUnchanged === true
    && !countOnlySrc.includes('credential-preflight')
    && !countOnlySrc.includes('SUNSET_PHASE_D_CREDENTIAL_PREFLIGHT')
    && countOnlySrc.includes('--execute-count-only'));

  const redNames = (evidence.redCases || []).map((c) => c.name);
  const greenNames = (evidence.greenCases || []).map((c) => c.name);
  pass('red-cases-present', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('green-cases-present', REQUIRED_GREEN.every((n) => greenNames.includes(n)));

  const live = evidence.liveOutcome || {};
  pass('offline-gates',
    evidence.offlineGates.defaultPathZeroHttpAndClients === true
    && evidence.offlineGates.liveHttpActivatedOfflineInjectRequired === true
    && evidence.offlineGates.injectedHttpExactTwoCallSuccessSafeMetadata === true
    && evidence.offlineGates.noPostPutPatchDelete === true
    && evidence.offlineGates.cliDefaultDisabled === true
    && evidence.offlineGates.liveHttpTransportPresentInLoaderSource === true
    && evidence.realPostgresCall === false
    && evidence.liveMutation === false
    && evidence.stillProductSchemaDiffers === true
    && evidence.neverInstantiatesPgClient === true);

  pass('live-evidence-recorded',
    evidence.cliExecutedLive === true
    && evidence.liveCallAttemptCount === 1
    && (evidence.outcome === 'phase_d_live_credential_preflight_ok'
      || evidence.outcome === 'phase_d_live_credential_preflight_blocked')
    && live.realPostgresCall === false
    && live.liveMutation === false
    && live.clientsInstantiated === 0
    && evidence.clientCallCounts.liveClientsInstantiated === 0
    && typeof live.code === 'string'
    && Number.isFinite(live.exitCode));

  pass('live-outcome-consistency',
    (live.ok === true && evidence.outcome === 'phase_d_live_credential_preflight_ok' && live.blocker === null)
    || (live.ok === false && evidence.outcome === 'phase_d_live_credential_preflight_blocked' && live.blocker !== null));

  pass('call-counts-evidence',
    evidence.redCaseCount === REQUIRED_RED.length
    && evidence.greenCaseCount === REQUIRED_GREEN.length
    && evidence.httpCallCounts.successPathHttpRequestCount === 2
    && evidence.httpCallCounts.defaultPathHttpRequestCount === 0
    && evidence.clientCallCounts.successPathClientsInstantiated === 0
    && evidence.clientCallCounts.defaultPathClientsInstantiated === 0);

  // Runtime: default zero
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const def = await executeCredentialPreflight({ env: {}, argv: [] });
  pass('runtime-default-zero-http-clients',
    def.ok === false
    && getManagedIdentityHttpCounters().httpRequestCount === 0
    && getPgClientInstantiateCount() === 0);

  // Runtime: success with injected HTTP
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const secretValue = buildOfflineProofSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD);
  const ok = await executeCredentialPreflight({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_TOKEN,
      defaultSecretValue: secretValue,
    }),
  });
  const probe = JSON.stringify(ok);
  pass('runtime-injected-two-call-safe-metadata',
    ok.ok === true
    && ok.code === 'credential_preflight_ok'
    && ok.httpCallsDelta === 2
    && ok.clientsInstantiated === 0
    && getPgClientInstantiateCount() === 0
    && getManagedIdentityHttpCounters().httpRequestCount === 2
    && ok.managedIdentityName === 'wh-staging-identity'
    && ok.keyVaultName === 'luna-sunset-staging-kv'
    && ok.secretName === 'sunset-database-url'
    && ok.secretTargetValid === true
    && ok.hasUser === true
    && ok.hasPassword === true
    && !probe.includes(FAKE_PASSWORD)
    && !probe.includes(FAKE_USER)
    && !probe.includes(FAKE_TOKEN)
    && !probe.includes(secretValue)
    && !Object.prototype.hasOwnProperty.call(ok, 'token')
    && !Object.prototype.hasOwnProperty.call(ok, 'dsn')
    && !Object.prototype.hasOwnProperty.call(ok, 'user')
    && ok.liveHttpEnabled === true
    && ok.realImdsCall === false
    && ok.realKeyVaultCall === false
    && !Object.prototype.hasOwnProperty.call(ok, 'password'));

  // Runtime: CLI default
  const cliDefault = spawnSync(process.execPath, [cliPath], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  pass('runtime-cli-default-disabled',
    cliDefault.status !== 0
    && /default_disabled|Default path refused/i.test(`${cliDefault.stdout}${cliDefault.stderr}`));

  // Runtime: gates
  const gates = evaluateCredentialPreflightGates({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
  });
  pass('runtime-cli-gates',
    gates.ok === true
    && gates.credentialSource === CREDENTIAL_SOURCE_MANAGED_IDENTITY
    && gates.liveHttpEnabled === true
    && ENV_CREDENTIAL_SOURCE === 'SUNSET_PHASE_D_CREDENTIAL_SOURCE'
    && CLI_CREDENTIAL_SOURCE === '--credential-source');

  pass('source-forbids-live-mutation',
    !/\baz\s+keyvault\b/i.test(proveSrc)
    && !/\baz\s+postgres\b/i.test(proveSrc)
    && !/--apply\b/.test(libSrc)
    && !/require\(['"]pg['"]\)/.test(libSrc)
    && !/require\(['"]pg['"]\)/.test(cliSrc)
    && !/ADD\s+CONSTRAINT\s+tenant_services_date_window/i.test(libSrc)
    && !/schema_migration_ledger/.test(libSrc)
    && /PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED\s*=\s*true/.test(loaderSrc)
    && /createLiveManagedIdentityHttpRequest/.test(loaderSrc)
    && /require\(['"]http['"]\)/.test(loaderSrc)
    && /require\(['"]https['"]\)/.test(loaderSrc)
    && /http_method_forbidden/.test(loaderSrc)
    && evidence.stillProductSchemaDiffers === true);

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14g-phase-d-live-credential-preflight']
      === 'node scripts/prove-sunset-schema-slice14g-phase-d-live-credential-preflight.js'
    && pkg.scripts['verify:sunset-schema-slice14g']
      === 'node scripts/verify-sunset-schema-slice14g.js'
    && pkg.scripts['phase-d:credential-preflight']
      === 'node scripts/run-phase-d-credential-preflight.js'
    && pkg.scripts['phase-d:live-readonly-count-only']
      === 'node scripts/run-phase-d-live-readonly-count-only.js');

  pass('findings-non-claim',
    /Do not claim/i.test(findings)
    && /Zero DB mutation/i.test(findings)
    && /credential-preflight/i.test(findings)
    && /wh-staging-identity/.test(findings)
    && /live metadata-only/i.test(findings)
    && !/Sunset is repaired/i.test(findings.replace(/Do not claim[\s\S]*?repaired/i, '')));

  const artifactText = `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`;
  pass('no-secret-tokens-in-artifacts',
    !/slice14g-proof-admin-password|verify-slice14g-admin-password|slice14g-proof-imds-token/i.test(artifactText)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(artifactText));

  pass('master-basis',
    evidence.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER);

  pass('verify-is-offline-only',
    !/require\(['"]pg['"]\)/.test(verifySrc)
    && !/require\(['"].*load-sunset-staging-pg-admin-env['"]\)/.test(verifySrc)
    && /createInjectedManagedIdentityHttp/.test(verifySrc)
    && /executeCredentialPreflight/.test(verifySrc)
    && !/spawnSync\(process\.execPath,\s*\[CLI_PATH,\s*\.\.\.liveArgv\]/.test(verifySrc));

  pass('prove-one-live-spawn',
    /spawnSync\(process\.execPath,\s*\[CLI_PATH,\s*\.\.\.liveArgv\]/.test(proveSrc)
    && !/retry/i.test(proveSrc.replace(/\/\/[^\n]*/g, '')));

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14g FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14g GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
