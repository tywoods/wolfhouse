'use strict';

/**
 * verify:sunset-schema-slice14ab — FOUNDATION Slice 14AB RED→GREEN
 * Azure PG15 pgcrypto presentation normalization.
 * Does NOT re-run live authority, observer, or any mutation path.
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
} = require('./lib/migration-integrity');
const { hashCanonicalManifest, compareSnapshots, NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1 } = require('./lib/sunset-schema-observer');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_PGCRYPTO_COMPATIBILITY_NORMALIZATION_LIVE_ENABLED,
  APPLICATION_NAME,
  PGCRYPTO_LOCKS,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  evaluatePgcryptoCompatibilityNormalizationGates,
  exactPgcryptoCompatibilityNormalizationArgv,
  pgcryptoCompatibilityNormalizationEnv,
  ENV_PGCRYPTO_COMPATIBILITY_NORMALIZATION,
  CLI_PROVE_PGCRYPTO_COMPATIBILITY_NORMALIZATION,
  buildOfflinePgcryptoLiveProfile,
  buildObserverCompareOptions,
} = require('./lib/phase-d-pgcrypto-compatibility-normalization');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '51578961029ae7c7b53582542f049d53f2952b98';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_prove_flag_zero_clients',
  'missing_pgcrypto_env_zero_clients',
  'wrong_exact_targets_zero_clients',
  'forbidden_argv_dsn_sql_drop_dml_zero_clients',
  'non_azure_profile_retains',
  'non_pg15_retains_or_rejects',
  'wrong_live_version_retains',
  'wrong_namespace_retains',
  'wrong_owner_retains',
  'wrong_relocatable_retains',
  'upgrade_available_1_4_unapplied_fails',
  'missing_gen_random_uuid_capability_retains',
  'gen_random_uuid_not_extension_member_retains',
  'fips_mode_present_differently_retains',
  'extra_unexpected_pgcrypto_member_delta_retains',
  'expected_bytes_change_fails',
];

const REQUIRED_GREEN = [
  'exact_locked_version_pair_normalizes_four',
  'capability_proof_gen_random_uuid',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'accounting_baseline_4_normalized_4_remaining_0',
  'raw_vs_normalized_compare_api',
  'fips_mode_absence_member_delta',
  'prior_14x_rules_still_default_behavior',
];

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function main() {
  console.log('verify:sunset-schema-slice14ab — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14ab-azure-pgcrypto-compat-normalization-evidence.json');
  const contractPath = path.join(FIX, 'slice14ab-azure-pgcrypto-compat-normalization-contract.json');
  const findingsPath = path.join(FIX, 'slice14ab-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14ab-azure-pgcrypto-compat-normalization.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14ab.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-pgcrypto-compatibility-normalization.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-pgcrypto-compatibility-normalization.js');
  const observerPath = path.join(ROOT, 'scripts', 'lib', 'sunset-schema-observer.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, verifyPath, cliPath, libPath, observerPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const observerSrc = fs.readFileSync(observerPath, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const expectedBytes = fs.readFileSync(expectedPath);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);

  pass('manifest-integrity', integrity.ok === true);
  pass('forward-count-39', forward.length === 39);
  pass('manifest-hash-preserved', manifestHash === MANIFEST_HASH
    && evidence.manifestHash === MANIFEST_HASH);
  pass('expected-byte-sha-preserved', expectedHash === EXPECTED_BYTE_SHA
    && evidence.expectedProductSchemaByteSha256 === EXPECTED_BYTE_SHA);
  pass('product-fingerprint-preserved', evidence.productFingerprintExpected === CANON_FP
    && evidence.productFingerprintUnchanged === CANON_FP);
  pass('master-sha-basis', contract.masterShaBasis === MASTER
    && evidence.masterShaBasis === MASTER);

  pass('baseline-mismatch-count-4', contract.baselineMismatchCount === 4
    && evidence.baselineMismatchCountExpected === 4);
  pass('baseline-sections-locked', JSON.stringify(contract.baselineMismatchSections)
    === JSON.stringify(BASELINE_MISMATCH_SECTIONS));

  pass('required-red-covered', REQUIRED_RED.every((n) => evidence.offline.red.some((r) => r.name === n && r.ok)));
  pass('required-green-covered', REQUIRED_GREEN.every((n) => evidence.offline.green.some((g) => g.name === n && g.ok)));

  pass('secret-free-evidence', evidence.secretFree === true && evidence.secretHandlingProof.leakScanPassed === true);
  pass('zero-mutation-flags', evidence.liveMutation === false
    && evidence.schemaMutation === false
    && evidence.dataMutation === false
    && evidence.ledgerWritten === false);

  pass('global-live-apply-false', PHASE_D_LIVE_APPLY_ENABLED === false
    && contract.gates.liveApplyRemainsFalse === true);

  pass('application-name-locked', APPLICATION_NAME === 'wh-sunset-pgcrypto-compatibility'
    && contract.applicationName === APPLICATION_NAME
    && PGCRYPTO_LOCKS.applicationName === APPLICATION_NAME);

  pass('env-cli-gates-documented', contract.gates.envPgcryptoCompatibilityNormalization
    === ENV_PGCRYPTO_COMPATIBILITY_NORMALIZATION
    && contract.gates.cliProve === CLI_PROVE_PGCRYPTO_COMPATIBILITY_NORMALIZATION);

  pass('observer-wired', observerSrc.includes('normalizeAzurePg15PgcryptoCompatibility')
    && observerSrc.includes('enablePgcryptoCompatibilityNormalization'));

  pass('verify-never-reruns-live',
    evidence.verifyNeverRerunsLive === true
    && contract.verifyNeverRerunsLive === true
    && !/process\.argv\.includes\('--live'\)/.test(verifySrc)
    && !/executePgcryptoCompatibilityNormalization\(/.test(verifySrc)
    && /Does NOT re-run live/i.test(verifySrc));

  pass('package-scripts-present', Boolean(pkg.scripts['prove:sunset-schema-slice14ab-azure-pgcrypto-compat-normalization'])
    && Boolean(pkg.scripts['verify:sunset-schema-slice14ab'])
    && Boolean(pkg.scripts['phase-d:pgcrypto-compatibility-normalization']));

  pass('prove-offline-ran', evidence.offline.red.length >= 12 && evidence.offline.green.length >= 10);

  const proveRun = spawnSync('node', [provePath], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SUNSET_SLICE14AB_PROOF_OFFLINE: '1' },
  });
  pass('prove-replay-exit-0', proveRun.status === 0, proveRun.stderr || proveRun.stdout);

  const gateOk = evaluatePgcryptoCompatibilityNormalizationGates({
    env: pgcryptoCompatibilityNormalizationEnv(),
    argv: exactPgcryptoCompatibilityNormalizationArgv(),
  });
  pass('cli-gates-still-valid', gateOk.ok === true);

  pass('capability-live-enabled', PHASE_D_PGCRYPTO_COMPATIBILITY_NORMALIZATION_LIVE_ENABLED === true);

  pass('findings-mentions-slice', findings.includes('14AB') && findings.includes('pgcrypto'));

  const live = evidence.liveOutcome;
  if (live) {
    pass('live-same-target-readonly', live.ok === true
      && live.sameTarget === true
      && live.sessionReadOnly === true
      && live.realPostgresCall === true);
    pass('live-baseline-four', live.baselineMismatchCount === 4);
    pass('live-normalized-four-zero-drift', live.pgcryptoCompatibilitiesNormalized === 4
      && live.remainingMismatchCount === 0
      && Array.isArray(live.remainingKeys) && live.remainingKeys.length === 0
      && live.accountingOk === true);
    pass('live-version-pair-1-4-to-1-3',
      live.liveProfile
      && live.liveProfile.installed
      && live.liveProfile.installed.extversion === '1.3'
      && live.liveProfile.installed.schema === 'public'
      && live.liveProfile.installed.relocatable === true
      && live.liveProfile.availableExtensions
      && live.liveProfile.availableExtensions.default_version === '1.3'
      && live.liveProfile.fipsMode
      && live.liveProfile.fipsMode.present === false);
    pass('live-capability-gen-random-uuid-member',
      live.liveProfile
      && live.liveProfile.capabilityMembership
      && live.liveProfile.capabilityMembership['public.gen_random_uuid()']
      && live.liveProfile.capabilityMembership['public.gen_random_uuid()'].extname === 'pgcrypto');
    pass('findings-live-zero-drift', findings.includes('remaining mismatch: **0**')
      && findings.includes('pgcrypto_compatibility_normalization_live_ok_zero_drift'));
  }

  if (failed > 0) {
    console.log(`\n${failed} verify failure(s)`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14ab — all checks passed');
}

main();
