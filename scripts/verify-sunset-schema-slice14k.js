'use strict';

/**
 * verify:sunset-schema-slice14k — FOUNDATION Slice 14K RED→GREEN
 * KV DSN verify-full apply activation (gated CLI; offline injected HTTP).
 * Offline gates + evidence. No live IMDS/KV/PG mutation.
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
  EXPECTED_028_SHA256,
  AUTHORIZED_AGGREGATE_SQL: AGG_14A,
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');
const {
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED,
  PHASE_D_KV_DSN_VERIFY_FULL_LIVE_HTTP_ENABLED,
  DSN_PLAN_LOCKS,
  KEY_VAULT_RESOURCE_ID,
  createLiveDsnNormalizeHttpRequest,
  createInjectedDsnNormalizeHttp,
  buildOfflineProofTlsDeficientSunsetDatabaseUrl,
  resetDsnPlanCounters,
  getDsnPlanCounters,
} = require('./lib/phase-d-kv-dsn-verify-full-plan');
const {
  ENV_DSN_APPLY,
  CLI_APPLY_VERIFY_FULL,
  DSN_APPLY_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  evaluateDsnApplyGates,
  executeDsnVerifyFullApply,
  exactDsnApplyArgv,
  dsnApplyEnv,
} = require('./lib/phase-d-kv-dsn-verify-full-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '4cfb610e069bb382f83160064963fd86572ffecb';
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
  'default_path_zero_http_writes',
  'missing_env_zero_http',
  'missing_apply_flag_zero_http',
  'wrong_exact_targets_zero_http',
  'forbidden_value_dsn_url_token_file_argv',
  'adapter_without_http_zero_writes',
  'sanitized_transport_failure',
  'sanitized_put_failure_retains_prior_version_id',
  'sanitized_verify_failure',
  'rollback_hard_disabled_zero_writes',
  'live_transport_rejects_host_method_body_deviations',
];

const REQUIRED_GREEN = [
  'live_http_activated_rollback_disabled',
  'exact_gates_pass',
  'exact_one_put_sequence_injected',
  'live_http_transport_present',
  'cli_default_disabled',
  'cli_missing_env_refuses_zero_http',
  'usage_and_locks',
  'no_pg_client_hashes_preserved',
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
  console.log('verify:sunset-schema-slice14k — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14k-kv-dsn-verify-full-activation-evidence.json');
  const contractPath = path.join(FIX, 'slice14k-kv-dsn-verify-full-activation-contract.json');
  const findingsPath = path.join(FIX, 'slice14k-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14k-kv-dsn-verify-full-activation.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14k.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-kv-dsn-verify-full-apply.js');
  const applyLibPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-kv-dsn-verify-full-apply.js');
  const planLibPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-kv-dsn-verify-full-plan.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, cliPath, applyLibPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const cliSrc = fs.readFileSync(cliPath, 'utf8');
  const applySrc = fs.readFileSync(applyLibPath, 'utf8');
  const planSrc = fs.readFileSync(planLibPath, 'utf8');
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
    && contract.predicatesUnchangedFrom14A.date_window === DATE_WINDOW_PREDICATE
    && contract.predicatesUnchangedFrom14A.price_unit === PRICE_UNIT_PREDICATE
    && evidence.authorizedAggregateSqlUnchanged === AGG_14A);

  pass('live-http-activated-rollback-disabled',
    PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED === true
    && PHASE_D_KV_DSN_VERIFY_FULL_LIVE_HTTP_ENABLED === true
    && PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED === false
    && /PHASE_D_KV_DSN_VERIFY_FULL_LIVE_MUTATE_ENABLED\s*=\s*true/.test(planSrc)
    && /PHASE_D_KV_DSN_VERIFY_FULL_LIVE_HTTP_ENABLED\s*=\s*true/.test(planSrc)
    && /PHASE_D_KV_DSN_VERIFY_FULL_LIVE_ROLLBACK_ENABLED\s*=\s*false/.test(planSrc)
    && evidence.liveMutateEnabled === true
    && evidence.liveHttpEnabled === true
    && evidence.liveRollbackEnabled === false
    && contract.liveMutateEnabled === true
    && contract.liveHttpEnabled === true
    && contract.liveRollbackEnabled === false
    && contract.rollbackHardDisabled === true);

  pass('command-contract',
    contract.commandContract.script === 'scripts/run-phase-d-kv-dsn-verify-full-apply.js'
    && contract.commandContract.npm === 'phase-d:kv-dsn-verify-full-apply'
    && ENV_DSN_APPLY === 'SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_APPLY'
    && CLI_APPLY_VERIFY_FULL === '--apply-verify-full'
    && contract.applyEnvRequired === true
    && contract.applyFlagRequired === true
    && contract.exactTargetCliConfirmationRequired === true
    && pkg.scripts['prove:sunset-schema-slice14k-kv-dsn-verify-full-activation']
      === 'node scripts/prove-sunset-schema-slice14k-kv-dsn-verify-full-activation.js'
    && pkg.scripts['verify:sunset-schema-slice14k']
      === 'node scripts/verify-sunset-schema-slice14k.js'
    && pkg.scripts['phase-d:kv-dsn-verify-full-apply']
      === 'node scripts/run-phase-d-kv-dsn-verify-full-apply.js');

  pass('locks',
    DSN_APPLY_LOCKS.keyVaultName === 'luna-sunset-staging-kv'
    && DSN_APPLY_LOCKS.secretName === 'sunset-database-url'
    && DSN_APPLY_LOCKS.managedIdentityName === 'wh-staging-identity'
    && DSN_APPLY_LOCKS.vmName === 'lunabox'
    && DSN_APPLY_LOCKS.vmResourceGroup === 'wh-staging-rg'
    && DSN_APPLY_LOCKS.targetSslmode === 'verify-full'
    && DSN_APPLY_LOCKS.keyVaultResourceId === KEY_VAULT_RESOURCE_ID
    && DSN_PLAN_LOCKS.port === 5432);

  pass('transport-present',
    typeof createLiveDsnNormalizeHttpRequest === 'function'
    && /createLiveDsnNormalizeHttpRequest/.test(planSrc)
    && /assertLockedDsnNormalizeLiveRequest/.test(planSrc)
    && /http_redirect_rejected/.test(planSrc)
    && /http_retry_rejected/.test(planSrc)
    && contract.redirectsRejected === true
    && contract.retriesForbidden === true
    && contract.metadataPreservationRequired === true);

  pass('invokes-14j-adapter',
    /executeDsnNormalizeAdapter/.test(applySrc)
    && /require\('\.\/phase-d-kv-dsn-verify-full-plan'\)/.test(applySrc)
    && /executeDsnVerifyFullApply/.test(cliSrc));

  pass('no-live-execution-in-prove',
    !/realImdsCall:\s*true/.test(proveSrc)
    && evidence.realImdsCall === false
    && evidence.realKeyVaultCall === false
    && evidence.realPostgresCall === false
    && evidence.zeroLiveMutation === true
    && evidence.offlineInjectedHttpProof === true
    && !/az\s+keyvault|az\s+rest|pg\.Client/.test(proveSrc)
    && !/pg\.Client/.test(applySrc));

  const redNames = (evidence.red || []).map((r) => r.name);
  const greenNames = (evidence.green || []).map((g) => g.name);
  pass('red-cases-complete', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('green-cases-complete', REQUIRED_GREEN.every((n) => greenNames.includes(n)));

  resetDsnPlanCounters();
  const gatesDefault = evaluateDsnApplyGates({ env: {}, argv: [] });
  pass('runtime-default-gates-refuse',
    gatesDefault.ok === false
    && getDsnPlanCounters().httpRequestCount === 0
    && getDsnPlanCounters().kvWriteCount === 0);

  resetDsnPlanCounters();
  const gatesOk = evaluateDsnApplyGates({
    env: dsnApplyEnv(),
    argv: exactDsnApplyArgv(),
  });
  pass('runtime-exact-gates-pass', gatesOk.ok === true);

  resetDsnPlanCounters();
  const inject = createInjectedDsnNormalizeHttp({
    imdsAccessToken: 'verify-14k-token-never-commit',
    currentSecretValue: buildOfflineProofTlsDeficientSunsetDatabaseUrl(
      'verify-14k-user',
      'verify-14k-password-never-commit',
      'require',
    ),
    priorSecretVersionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    newSecretVersionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    secretContentType: 'text/plain',
    secretTags: { env: 'verify' },
    secretAttributes: { enabled: true },
  });
  const applied = await executeDsnVerifyFullApply({
    env: dsnApplyEnv(),
    argv: exactDsnApplyArgv(),
    httpRequest: inject,
  });
  pass('runtime-injected-one-put',
    applied.ok === true
    && applied.httpRequestCount === 4
    && applied.keyVaultPutCount === 1
    && applied.metadataPreserved === true
    && applied.usedLiveHttp === false
    && applied.pgClientInstantiated === 0);

  const cliDefault = spawnSync(process.execPath, [cliPath], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  pass('runtime-cli-default-refuse', cliDefault.status !== 0);

  pass('findings-document-outcome',
    findings.includes('Slice 14K')
    && findings.includes('--apply-verify-full')
    && findings.includes('SUNSET_PHASE_D_KV_DSN_VERIFY_FULL_APPLY')
    && findings.includes('Zero live mutation')
    && findings.includes('rollback'));

  pass('forbidden-argv-includes-credential-smuggle',
    FORBIDDEN_ARGV_FLAGS.includes('--dsn')
    && FORBIDDEN_ARGV_FLAGS.includes('--token')
    && FORBIDDEN_ARGV_FLAGS.includes('--file')
    && FORBIDDEN_ARGV_FLAGS.includes('--body')
    && FORBIDDEN_ARGV_FLAGS.includes('--prior-version-id')
    && SAFE_OUTPUT_KEYS.includes('priorSecretVersionId')
    && SAFE_OUTPUT_KEYS.includes('newSecretVersionId')
    && !SAFE_OUTPUT_KEYS.includes('token')
    && !SAFE_OUTPUT_KEYS.includes('password'));

  pass('master-basis',
    contract.masterShaBasis === MASTER
    && evidence.masterShaBasis === MASTER
    && findings.includes(MASTER));

  console.log(`\n── verify:sunset-schema-slice14k: ${failed ? 'FAILED' : 'PASSED'} ──`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`verify:sunset-schema-slice14k FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
