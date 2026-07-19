'use strict';

/**
 * verify:sunset-schema-slice14u — FOUNDATION Slice 14U RED→GREEN
 * Residual drift classify + preflight (exact 35 after 14T).
 * Does NOT re-run live authority, observer, or any mutation path.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  loadManifest,
  validateManifestIntegrity,
  MANIFEST_PATH,
  MIGRATIONS_DIR,
  sha256CanonicalLfV1File,
} = require('./lib/migration-integrity');
const {
  hashCanonicalManifest,
  EXPECTED_HOST,
} = require('./lib/sunset-schema-observer');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  EXPECTED_028_SHA256,
} = require('./lib/phase-d-check-preflight');
const {
  PHASE_D_RESIDUAL_DRIFT_PREFLIGHT_LIVE_ENABLED,
  APPLICATION_NAME,
  RESIDUAL_LOCKS,
  evaluateResidualDriftPreflightGates,
  exactResidualDriftPreflightArgv,
  residualDriftPreflightEnv,
  ENV_RESIDUAL_DRIFT_PREFLIGHT,
  CLI_PROVE_RESIDUAL_DRIFT_PREFLIGHT,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  assertBaselineMismatch,
  DEPENDENCY_ORDER_RANK,
} = require('./lib/phase-d-residual-drift-preflight');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = 'e0db8af748a7d3cc93cb84fc6b09c199dc4fb5e8';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const EXPECTED_035_SHA256 = '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565';

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_prove_flag_zero_clients',
  'missing_residual_env_zero_clients',
  'wrong_exact_targets_zero_clients',
  'forbidden_argv_dsn_sql_drop_dml_zero_clients',
  'baseline_drift_mismatch_stops',
  'nullable_mismatch_with_nonzero_nulls_red',
  'duplicate_orphan_violation_red',
  'unsupported_definition_red',
  'missing_owner_red',
  'incomplete_coverage_red',
  'unsafe_ordering_red',
];

const REQUIRED_GREEN = [
  'baseline_exactly_35_sections_ok',
  'classify_constraint_categories',
  'not_null_sql_aggregate_shape',
  'pk_fk_unique_check_sql_shapes',
  'index_support_proof_shape',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'coverage_complete_35_once',
  'mutation_batches_execute_false_ordered',
  'injected_authority_preflight_path_secret_free',
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
  console.log('verify:sunset-schema-slice14u — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14u-residual-drift-preflight-evidence.json');
  const contractPath = path.join(FIX, 'slice14u-residual-drift-preflight-contract.json');
  const findingsPath = path.join(FIX, 'slice14u-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14u-residual-drift-preflight.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14u.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-residual-drift-preflight.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-residual-drift-preflight.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, verifyPath, cliPath, libPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const libSrc = fs.readFileSync(libPath, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const expectedBytes = fs.readFileSync(expectedPath);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  pass('expected-bytes-unchanged', expectedHash === EXPECTED_BYTE_SHA, expectedHash);

  const expected = JSON.parse(expectedBytes.toString('utf8'));
  pass('canonical-fingerprint-unchanged', expected.productFingerprint === CANON_FP);

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  pass('manifest-integrity', integrity.ok === true);
  pass('manifest-hash', manifestHash === MANIFEST_HASH);

  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  pass('migration-035-unchanged', live035 === EXPECTED_035_SHA256);
  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  pass('migration-028-unchanged', live028 === EXPECTED_028_SHA256);

  pass('master-basis', evidence.masterShaBasis === MASTER && contract.masterShaBasis === MASTER);
  pass('application-name', evidence.applicationName === APPLICATION_NAME
    && APPLICATION_NAME === 'wh-sunset-residual-drift-preflight');

  pass('safety-flags',
    evidence.secretFree === true
    && evidence.liveMutation === false
    && evidence.schemaMutation === false
    && evidence.dataMutation === false
    && evidence.ledgerWritten === false
    && evidence.containsRepairSql === false
    && evidence.verifyNeverRerunsLive === true
    && evidence.doNotClaimDatabaseMatchesCanonical === true
    && evidence.residualInventoryIs35Only === true
    && PHASE_D_LIVE_APPLY_ENABLED === false);

  pass('verify-never-reruns-live',
    !/process\.argv\.includes\('--live'\)/.test(verifySrc)
    && !/executeResidualDriftPreflight\(/.test(verifySrc)
    && /Does NOT re-run live/i.test(verifySrc));

  const redNames = (evidence.offline && evidence.offline.red || []).map((r) => r.name);
  const greenNames = (evidence.offline && evidence.offline.green || []).map((g) => g.name);
  pass('required-red-present', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('required-green-present', REQUIRED_GREEN.every((n) => greenNames.includes(n)));
  pass('offline-red-all-pass', (evidence.offline.red || []).every((r) => r.ok === true));
  pass('offline-green-all-pass', (evidence.offline.green || []).every((g) => g.ok === true));

  pass('baseline-constants',
    BASELINE_MISMATCH_COUNT === 35
    && evidence.baselineMismatchCount === 35
    && contract.baselineMismatchCount === 35
    && JSON.stringify(evidence.baselineMismatchSections) === JSON.stringify(BASELINE_MISMATCH_SECTIONS));

  const baselineOk = assertBaselineMismatch({
    mismatchCount: 35,
    mismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
  });
  const baselineBad = assertBaselineMismatch({
    mismatchCount: 36,
    mismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
  });
  pass('recompute-baseline-gate', baselineOk.ok === true && baselineBad.ok === false);

  pass('no-448-as-residual-inventory',
    evidence.offline.syntheticResidualCount === 35
    && !/"count"\s*:\s*448/.test(JSON.stringify(evidence.inventory || {}))
    && !(evidence.liveOutcome
      && evidence.liveOutcome.inventory
      && evidence.liveOutcome.inventory.count === 448)
    && /Do not.*448|do not carry forward.*448|Residual inventory is \*\*35/i.test(findings));

  const gates = evaluateResidualDriftPreflightGates({
    env: residualDriftPreflightEnv(),
    argv: exactResidualDriftPreflightArgv(),
  });
  pass('runtime-cli-gates', gates.ok === true);
  pass('capability-flags',
    PHASE_D_RESIDUAL_DRIFT_PREFLIGHT_LIVE_ENABLED === true
    && ENV_RESIDUAL_DRIFT_PREFLIGHT === 'SUNSET_PHASE_D_RESIDUAL_DRIFT_PREFLIGHT'
    && CLI_PROVE_RESIDUAL_DRIFT_PREFLIGHT === '--prove-residual-drift-preflight'
    && DEPENDENCY_ORDER_RANK.indexes < DEPENDENCY_ORDER_RANK.FOREIGN_KEY);

  pass('pkg-scripts',
    typeof pkg.scripts['prove:sunset-schema-slice14u-residual-drift-preflight'] === 'string'
    && typeof pkg.scripts['verify:sunset-schema-slice14u'] === 'string'
    && typeof pkg.scripts['phase-d:residual-drift-preflight'] === 'string');

  pass('findings-mention-residual',
    /35/.test(findings)
    && /wh-sunset-residual-drift-preflight/.test(findings)
    && /execute:false|execute=false/i.test(findings));

  pass('lib-zero-mutation-markers',
    /Zero mutation/.test(libSrc)
    && /wh-sunset-residual-drift-preflight/.test(libSrc)
    && /BASELINE_MISMATCH_COUNT = 35/.test(libSrc));

  pass('locks-host', RESIDUAL_LOCKS.postgresHost === EXPECTED_HOST
    && RESIDUAL_LOCKS.sslmode === 'verify-full');

  // Live evidence shape (if present) — never re-run
  if (evidence.liveOutcome && evidence.liveOutcome.realPostgresCall === true) {
    const lo = evidence.liveOutcome;
    pass('live-readonly-flags',
      lo.liveMutation === false
      && lo.schemaMutation === false
      && lo.dataMutation === false
      && lo.ledgerWritten === false
      && lo.kvMutation === false
      && lo.sessionReadOnly === true
      && lo.transactionReadOnly === true
      && lo.sameTarget === true
      && lo.execute === false);
    pass('live-baseline-35',
      lo.baseline
      && lo.baseline.ok === true
      && Number(lo.baseline.mismatchCount) === 35
      && lo.observerAfter
      && Number(lo.observerAfter.mismatchCount) === 35);
    pass('live-inventory-coverage-35',
      lo.inventory
      && lo.inventory.count === 35
      && lo.coverage
      && lo.coverage.ok === true);
    const batches = (lo.mutationBatches && lo.mutationBatches.batches) || [];
    pass('live-batches-execute-false',
      batches.length > 0
      && batches.every((b) => b.execute === false));
    pass('live-version-class',
      lo.serverVersionClass
      && (lo.serverVersionClass.versionClass === 'postgresql_15'
        || Number(lo.serverVersionClass.major) === 15));
  } else {
    pass('live-evidence-optional-offline', true);
  }

  pass('contract-locks',
    contract.locks.applicationName === APPLICATION_NAME
    && contract.locks.sslmode === 'verify-full'
    && contract.verifyNeverRerunsLive === true
    && contract.baselineMismatchCount === 35);

  if (failed) {
    console.log(`\nverify:sunset-schema-slice14u FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14u GREEN');
}

main();
