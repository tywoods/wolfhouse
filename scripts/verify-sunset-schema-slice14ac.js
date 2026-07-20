'use strict';

/**
 * verify:sunset-schema-slice14ac — FOUNDATION Slice 14AC RED→GREEN
 * Ledger bootstrap eligibility matrix.
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
const { hashCanonicalManifest } = require('./lib/sunset-schema-observer');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_LEDGER_ELIGIBILITY_LIVE_ENABLED,
  APPLICATION_NAME,
  LEDGER_LOCKS,
  EXPECTED_FORWARD_COUNT,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  ENV_LEDGER_ELIGIBILITY,
  CLI_PROVE_LEDGER_ELIGIBILITY,
  evaluateLedgerEligibilityGates,
  exactLedgerEligibilityArgv,
  ledgerEligibilityEnv,
} = require('./lib/phase-d-ledger-eligibility');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '0b92b7eff718f928ccb590d287830d4d104c37c4';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_prove_flag_zero_clients',
  'missing_ledger_eligibility_env_zero_clients',
  'wrong_exact_targets_zero_clients',
  'forbidden_argv_dsn_sql_drop_dml_zero_clients',
  'zero_drift_missing_fails',
  'ledger_present_fails',
  'checksum_drift_fails',
  'partial_ambiguous_effect_fails',
  'unproven_dml_fails',
  'unproven_comment_fails',
  'unproven_rename_fails',
  'dec006_failures_fail_closed',
  'gap_noncontiguous_prefix_fails',
  'mislabel_executed_runner_fails',
  'expected_bytes_change_fails',
  'dec006_020_applicable_mismatch_blocked',
  'dec006_020_duplicate_slug_blocked',
  'dec006_020_wrong_values_blocked',
];

const REQUIRED_GREEN = [
  'forward_count_39_canonical_lf_v1',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'never_labels_executed_by_canonical_runner',
  'design_ledger_ddl_extensions_additive_only',
  'contiguous_prefix_algorithm',
  'dec006_018_019_pass_with_metadata',
  'dec006_020_zero_applicable_vacuously_complete',
  'dec006_020_all_positive_matching_eligible',
  'offline_injected_authority_same_target',
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
  console.log('verify:sunset-schema-slice14ac — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14ac-ledger-eligibility-matrix-evidence.json');
  const contractPath = path.join(FIX, 'slice14ac-ledger-eligibility-matrix-contract.json');
  const findingsPath = path.join(FIX, 'slice14ac-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14ac-ledger-eligibility-matrix.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14ac.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-ledger-eligibility.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-ledger-eligibility.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, verifyPath, cliPath, libPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const expectedBytes = fs.readFileSync(expectedPath);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);

  pass('manifest-integrity', integrity.ok === true);
  pass('forward-count-39', forward.length === EXPECTED_FORWARD_COUNT);
  pass('manifest-hash-preserved', manifestHash === MANIFEST_HASH
    && evidence.manifestHash === MANIFEST_HASH);
  pass('expected-byte-sha-preserved', expectedHash === EXPECTED_BYTE_SHA
    && evidence.expectedProductSchemaByteSha256 === EXPECTED_BYTE_SHA);
  pass('product-fingerprint-preserved', evidence.productFingerprintExpected === CANON_FP
    && evidence.productFingerprintUnchanged === CANON_FP);
  pass('master-sha-basis', contract.masterShaBasis === MASTER
    && evidence.masterShaBasis === MASTER);
  pass('checksum-mode-canonical-lf-v1', contract.checksumMode === CHECKSUM_MODE_CANONICAL_LF_V1
    && evidence.checksumMode === CHECKSUM_MODE_CANONICAL_LF_V1);

  pass('required-red-covered', REQUIRED_RED.every((n) => evidence.offline.red.some((r) => r.name === n && r.ok)));
  pass('required-green-covered', REQUIRED_GREEN.every((n) => evidence.offline.green.some((g) => g.name === n && g.ok)));

  pass('secret-free-evidence', evidence.secretFree === true && evidence.secretHandlingProof.leakScanPassed === true);
  pass('zero-mutation-flags', evidence.liveMutation === false
    && evidence.schemaMutation === false
    && evidence.dataMutation === false
    && evidence.ledgerWritten === false);

  pass('global-live-apply-false', PHASE_D_LIVE_APPLY_ENABLED === false
    && contract.gates.liveApplyRemainsFalse === true);

  pass('application-name-locked', APPLICATION_NAME === 'wh-sunset-ledger-eligibility'
    && contract.applicationName === APPLICATION_NAME
    && LEDGER_LOCKS.applicationName === APPLICATION_NAME);

  pass('env-cli-gates-documented', contract.gates.envLedgerEligibility
    === ENV_LEDGER_ELIGIBILITY
    && contract.gates.cliProve === CLI_PROVE_LEDGER_ELIGIBILITY);

  pass('evidence-eligibility-summary', evidence.eligibilitySummary != null
    && evidence.proposedLedgerRows != null
    && Array.isArray(evidence.proposedLedgerRows)
    && evidence.ledgerDdlDesign != null
    && evidence.ledgerDdlDesign.designOnly === true);

  pass('verify-never-reruns-live',
    evidence.verifyNeverRerunsLive === true
    && contract.verifyNeverRerunsLive === true
    && !/process\.argv\.includes\('--live'\)/.test(verifySrc)
    && !/executeLedgerEligibility\(/.test(verifySrc)
    && /Does NOT re-run live/i.test(verifySrc));

  pass('package-scripts-present', Boolean(pkg.scripts['prove:sunset-schema-slice14ac-ledger-eligibility-matrix'])
    && Boolean(pkg.scripts['verify:sunset-schema-slice14ac'])
    && Boolean(pkg.scripts['phase-d:ledger-eligibility']));

  pass('prove-offline-ran', evidence.offline.red.length >= 19 && evidence.offline.green.length >= 12);

  const proveRun = spawnSync('node', [provePath], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SUNSET_SLICE14AC_PROOF_OFFLINE: '1' },
  });
  pass('prove-replay-exit-0', proveRun.status === 0, proveRun.stderr || proveRun.stdout);

  const gateOk = evaluateLedgerEligibilityGates({
    env: ledgerEligibilityEnv(),
    argv: exactLedgerEligibilityArgv(),
  });
  pass('cli-gates-still-valid', gateOk.ok === true);

  pass('capability-live-enabled', PHASE_D_LEDGER_ELIGIBILITY_LIVE_ENABLED === true);

  pass('findings-mentions-slice', findings.includes('14AC') && findings.includes('ledger'));

  pass('prove-has-offline-env-guard', proveSrc.includes('SUNSET_SLICE14AC_PROOF_OFFLINE'));

  const libSrc = fs.readFileSync(libPath, 'utf8');
  pass('020-tenant-scoped-dml-sql',
    libSrc.includes('020-tenant-scoped-dml-rows')
    && libSrc.includes('applicable_rows')
    && libSrc.includes('mismatching_rows')
    && libSrc.includes('tenant_scoped_dml_vacuously_complete')
    && !libSrc.includes('020-aggregate-population-optional'));
  pass('020-eval-uses-vacuous-reason',
    /tenant_scoped_dml_vacuously_complete/.test(libSrc)
    && /evaluate020TenantScopedDml/.test(libSrc));
  pass('020-no-zero-aggregate-assignment',
    !/blockedReason\s*=\s*'unproven_dml_zero_aggregate'/.test(libSrc));

  const live = evidence.liveOutcome;
  if (live) {
    pass('live-same-target-readonly', live.ok === true
      && live.sameTarget === true
      && live.sessionReadOnly === true
      && live.realPostgresCall === true);
    pass('live-zero-drift', live.remainingMismatchCount === 0);
    pass('live-ledger-absent', live.ledgerAbsent === true
      || (live.ledgerGate && live.ledgerGate.ok === true && !live.ledgerGate.ledgerPresent));
    pass('live-matrix-forward-39', live.eligibilityMatrix
      && live.eligibilityMatrix.forwardCount === EXPECTED_FORWARD_COUNT);
    pass('findings-live-zero-drift', findings.includes('remaining mismatch: **0**')
      || findings.includes('ledger_eligibility_matrix_live_ok_zero_drift'));
    if (live.migration020) {
      pass('live-020-vacuous-or-matched',
        (live.migration020.applicable_rows === 0
          && live.migration020.mismatching_rows === 0
          && live.migration020.eligibilityReason === 'tenant_scoped_dml_vacuously_complete')
        || (live.migration020.applicable_rows > 0
          && live.migration020.mismatching_rows === 0
          && live.migration020.eligibilityReason === 'tenant_scoped_dml_matched'));
    }
  }

  if (evidence.superseded14acCapture) {
    pass('superseded-capture-recorded',
      evidence.superseded14acCapture.generatedAt != null
      && evidence.superseded14acCapture.result != null
      && String(evidence.superseded14acCapture.correctionReason || '').includes('applicable_rows'));
  }

  if (failed > 0) {
    console.log(`\n${failed} verify failure(s)`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14ac — all checks passed');
}

main();
