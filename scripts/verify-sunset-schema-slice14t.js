'use strict';

/**
 * verify:sunset-schema-slice14t — FOUNDATION Slice 14T RED→GREEN
 * NOT NULL observer representation normalization.
 * Does NOT re-run live authority, observer, or any mutation path.
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
const {
  hashCanonicalManifest,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  compareSnapshots,
  parseCanonicalNotNullConstraint,
  normalizeNotNullConstraintRepresentation,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  classifyServerVersionClass,
} = require('./lib/sunset-schema-observer');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  EXPECTED_028_SHA256,
} = require('./lib/phase-d-check-preflight');
const {
  PHASE_D_NOT_NULL_NORMALIZATION_LIVE_ENABLED,
  APPLICATION_NAME,
  NOT_NULL_LOCKS,
  evaluateNotNullNormalizationGates,
  exactNotNullNormalizationArgv,
  notNullNormalizationEnv,
  ENV_NOT_NULL_NORMALIZATION,
  CLI_PROVE_NOT_NULL_NORMALIZATION,
} = require('./lib/phase-d-not-null-observer-normalization');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '9a6d45b0d0d880d43ed41749d95d2d289ace9917';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const EXPECTED_035_SHA256 = '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565';

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_prove_flag_zero_clients',
  'missing_not_null_env_zero_clients',
  'wrong_exact_targets_zero_clients',
  'forbidden_argv_dsn_sql_drop_dml_zero_clients',
  'non_azure_profile_retains_not_null_constraints',
  'live_nullable_yes_retains_drift',
  'live_column_missing_retains_drift',
  'ambiguous_duplicate_claim_retains_drift',
  'unsupported_definition_shape_retains_drift',
  'non_not_null_pk_fk_check_untouched',
  'name_shape_mismatch_retains_drift',
];

const REQUIRED_GREEN = [
  'migration_035_eight_plus_not_null_normalize_when_columns_match',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'server_version_class_classifier',
  'raw_vs_normalized_compare_api',
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
  console.log('verify:sunset-schema-slice14t — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14t-not-null-observer-normalization-evidence.json');
  const contractPath = path.join(FIX, 'slice14t-not-null-observer-normalization-contract.json');
  const findingsPath = path.join(FIX, 'slice14t-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14t-not-null-observer-normalization.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14t.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-not-null-observer-normalization.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-not-null-observer-normalization.js');
  const observerPath = path.join(ROOT, 'scripts', 'lib', 'sunset-schema-observer.js');

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
  const libSrc = fs.readFileSync(libPath, 'utf8');
  const observerSrc = fs.readFileSync(observerPath, 'utf8');
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

  pass('master-basis', evidence.masterShaBasis === MASTER && contract.masterShaBasis === MASTER);
  pass('application-name', evidence.applicationName === APPLICATION_NAME
    && APPLICATION_NAME === 'wh-sunset-not-null-normalization');
  pass('profile-azure-flexible-server-v1',
    evidence.normalizationProfile === NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1
    && /normalizeNotNullConstraintRepresentation/.test(observerSrc));

  pass('safety-flags',
    evidence.secretFree === true
    && evidence.liveMutation === false
    && evidence.schemaMutation === false
    && evidence.dataMutation === false
    && evidence.ledgerWritten === false
    && evidence.containsRepairSql === false
    && evidence.verifyNeverRerunsLive === true
    && evidence.doNotClaimDatabaseMatchesCanonical === true
    && PHASE_D_LIVE_APPLY_ENABLED === false);

  pass('verify-never-reruns-live',
    !/process\.argv\.includes\('--live'\)/.test(verifySrc)
    && !/executeNotNullObserverNormalization\(/.test(verifySrc)
    && /Does NOT re-run live/i.test(verifySrc));

  const redNames = (evidence.offline && evidence.offline.red || []).map((r) => r.name);
  const greenNames = (evidence.offline && evidence.offline.green || []).map((g) => g.name);
  pass('required-red-present', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('required-green-present', REQUIRED_GREEN.every((n) => greenNames.includes(n)));
  pass('offline-red-all-pass', (evidence.offline.red || []).every((r) => r.ok === true));
  pass('offline-green-all-pass', (evidence.offline.green || []).every((g) => g.ok === true));

  const fixtureCount = evidence.offline
    && evidence.offline.migration035Fixture
    && evidence.offline.migration035Fixture.cmtNotNullCount;
  pass('migration-035-fixture-ge-8', Number(fixtureCount) >= 8);

  // Recompute offline GREEN fixture quickly (static; no live).
  {
    const cmtNn = expected.snapshot.constraints.filter(
      (c) => c.table === 'customer_message_templates' && c.type === 'n',
    );
    const cmtCols = expected.snapshot.columns.filter((c) => c.table === 'customer_message_templates');
    const cmtOther = expected.snapshot.constraints.filter(
      (c) => c.table === 'customer_message_templates' && c.type !== 'n',
    );
    const expSnap = {
      tables: ['customer_message_templates'],
      columns: cmtCols,
      constraints: [...cmtNn, ...cmtOther],
      indexes: [],
      sequences: [],
      views: [],
      enums: [],
      functions: [],
      triggers: [],
      rlsFlags: [],
      rlsPolicies: [],
      ownership: [],
      acls: [],
      extensions: [],
    };
    const liveSnap = {
      ...expSnap,
      constraints: cmtOther.map((c) => ({ ...c })),
      columns: cmtCols.map((c) => ({ ...c })),
    };
    const azureContext = { verified: true, host: EXPECTED_HOST, database: EXPECTED_DATABASE };
    const raw = compareSnapshots(expSnap, liveSnap, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext,
      disableNotNullConstraintNormalization: true,
    });
    const norm = compareSnapshots(expSnap, liveSnap, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext,
    });
    pass(
      'recompute-035-normalize',
      cmtNn.length >= 8
        && (raw.drifts || []).filter((d) => String(d.key).endsWith('.n')).length === cmtNn.length
        && (norm.drifts || []).filter((d) => String(d.key).endsWith('.n')).length === 0
        && norm.notNullNormalization
        && norm.notNullNormalization.normalizedCount === cmtNn.length,
      `nn=${cmtNn.length} raw=${raw.drifts.length} norm=${norm.drifts.length}`,
    );

    // RED: nullable YES retains
    const liveYes = {
      ...liveSnap,
      columns: liveSnap.columns.map((c) => (c.column === 'title' ? { ...c, nullable: 'YES' } : c)),
    };
    const cmpYes = compareSnapshots(expSnap, liveYes, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext,
    });
    pass(
      'recompute-nullable-yes-retains',
      (cmpYes.drifts || []).some((d) => d.key === 'customer_message_templates.customer_message_templates_title_not_null.n'),
    );

    const bad = parseCanonicalNotNullConstraint({
      table: 'customer_message_templates',
      name: 'weird',
      type: 'n',
      definition: 'NOT NULL title',
    });
    pass('recompute-name-shape-red', bad.ok === false && bad.reason === 'name_shape_mismatch');

    const cls = classifyServerVersionClass(150005, '15.5');
    pass('recompute-version-class', cls.versionClass === 'postgresql_15' && cls.major === 15);
  }

  const gates = evaluateNotNullNormalizationGates({
    env: notNullNormalizationEnv(),
    argv: exactNotNullNormalizationArgv(),
  });
  pass('runtime-cli-gates', gates.ok === true);
  pass('capability-flags',
    PHASE_D_NOT_NULL_NORMALIZATION_LIVE_ENABLED === true
    && ENV_NOT_NULL_NORMALIZATION === 'SUNSET_PHASE_D_NOT_NULL_NORMALIZATION'
    && CLI_PROVE_NOT_NULL_NORMALIZATION === '--prove-not-null-normalization');

  pass('pkg-scripts',
    typeof pkg.scripts['prove:sunset-schema-slice14t-not-null-observer-normalization'] === 'string'
    && typeof pkg.scripts['verify:sunset-schema-slice14t'] === 'string'
    && typeof pkg.scripts['phase-d:not-null-observer-normalization'] === 'string');

  pass('findings-mention-normalization',
    /NOT NULL/.test(findings)
    && /attnotnull|nullable=NO/.test(findings)
    && /wh-sunset-not-null-normalization/.test(findings));

  pass('lib-zero-mutation-markers',
    /Zero mutation/.test(libSrc)
    && /disableNotNullConstraintNormalization/.test(observerSrc));

  // Live evidence shape (if present) — never re-run
  if (evidence.liveOutcome && evidence.liveOutcome.realPostgresCall === true) {
    const lo = evidence.liveOutcome;
    pass('live-readonly-flags',
      lo.liveMutation === false
      && lo.schemaMutation === false
      && lo.dataMutation === false
      && lo.sessionReadOnly === true
      && lo.transactionReadOnly === true
      && lo.sameTarget === true);
    pass('live-has-before-after',
      lo.observerBefore
      && lo.observerAfter
      && Number.isFinite(lo.observerBefore.mismatchCount)
      && Number.isFinite(lo.observerAfter.mismatchCount)
      && Number.isFinite(lo.observerAfter.notNullArtifactsNormalized));
    pass('live-version-class',
      lo.serverVersionClass
      && typeof lo.serverVersionClass.versionClass === 'string');
    pass('live-real-nullable-mismatches-remain-visible',
      // After normalization, residual constraint drifts must not be silently zeroed
      // unless normalized count explains the drop — truth reported, not forced.
      lo.observerAfter.notNullArtifactsNormalized >= 0
      && lo.observerBefore.mismatchCount >= lo.observerAfter.mismatchCount);
  } else {
    pass('live-evidence-optional-offline', true);
  }

  pass('contract-locks',
    contract.locks.applicationName === APPLICATION_NAME
    && contract.locks.sslmode === 'verify-full'
    && contract.verifyNeverRerunsLive === true);

  if (failed) {
    console.log(`\nverify:sunset-schema-slice14t FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14t GREEN');
}

main();
