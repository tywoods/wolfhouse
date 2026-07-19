'use strict';

/**
 * verify:sunset-schema-slice14w — FOUNDATION Slice 14W RED→GREEN
 * final NOT NULL rename-provenance observer normalization.
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
  EXPECTED_DATABASE,
  compareSnapshots,
  parseCanonicalNotNullConstraint,
  buildFinalNotNullRenameProvenance,
  normalizeFinalNotNullRenameProvenance,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  MIGRATION_002_PACKAGE_PRICING_SHA256,
  MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256,
  MIGRATION_004_PAYMENT_SCHEMA_SHA256,
  MIGRATION_003_TABLE_RENAME_APPROVED_COLUMNS,
} = require('./lib/sunset-schema-observer');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_FINAL_RENAME_NORMALIZATION_LIVE_ENABLED,
  APPLICATION_NAME,
  FINAL_RENAME_LOCKS,
  BASELINE_MISMATCH_COUNT,
  evaluateFinalRenameNormalizationGates,
  exactFinalRenameNormalizationArgv,
  finalRenameNormalizationEnv,
  ENV_FINAL_RENAME_NORMALIZATION,
  CLI_PROVE_FINAL_RENAME_NORMALIZATION,
} = require('./lib/phase-d-final-rename-normalization');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = 'c0efa35ae818cb3c723dc81f79eee57e3041af70';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const EXPECTED_002_SHA256 = '3caa9c743252bd058c7eb8cb9bdbd39686b3970249c9d5c051e6971ebf476748';
const EXPECTED_003_SHA256 = 'f79826262081050f68c7f8014136d90730dc4dedffe37549aad2ff998f340257';
const EXPECTED_004_SHA256 = 'c82718b6417ffa8c594227bb8873b8d89d65d567caf4489e108f1b86485f22c1';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function main() {
  console.log('verify:sunset-schema-slice14w — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14w-final-rename-normalization-evidence.json');
  const contractPath = path.join(FIX, 'slice14w-final-rename-normalization-contract.json');
  const findingsPath = path.join(FIX, 'slice14w-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14w-final-rename-normalization.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14w.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-final-rename-normalization.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-final-rename-normalization.js');
  const observerPath = path.join(ROOT, 'scripts', 'lib', 'sunset-schema-observer.js');

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

  const live002 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '002_package_pricing.sql'));
  const live003 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '003_rename_hostel_to_client.sql'));
  const live004 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '004_payment_schema_phase2.sql'));
  pass('migration-002-unchanged', live002 === EXPECTED_002_SHA256
    && live002 === MIGRATION_002_PACKAGE_PRICING_SHA256);
  pass('migration-003-unchanged', live003 === EXPECTED_003_SHA256
    && live003 === MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256);
  pass('migration-004-unchanged', live004 === EXPECTED_004_SHA256
    && live004 === MIGRATION_004_PAYMENT_SCHEMA_SHA256);

  pass('master-basis', evidence.masterShaBasis === MASTER && contract.masterShaBasis === MASTER);
  pass('application-name', evidence.applicationName === APPLICATION_NAME
    && APPLICATION_NAME === 'wh-sunset-final-rename-normalization');
  pass('profile-azure-flexible-server-v1',
    evidence.normalizationProfile === NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1
    && /normalizeFinalNotNullRenameProvenance/.test(observerSrc)
    && /enableFinalRenameNormalization/.test(observerSrc));

  pass('safety-flags',
    evidence.secretFree === true
    && evidence.liveMutation === false
    && evidence.schemaMutation === false
    && evidence.dataMutation === false
    && evidence.ledgerWritten === false
    && evidence.kvMutation === false
    && PHASE_D_LIVE_APPLY_ENABLED === false
    && PHASE_D_FINAL_RENAME_NORMALIZATION_LIVE_ENABLED === true);

  pass('verify-never-reruns-live',
    evidence.verifyNeverRerunsLive === true
    && contract.verifyNeverRerunsLive === true
    && !/process\.argv\.includes\('--live'\)/.test(verifySrc)
    && !/executeFinalRenameNormalization\(/.test(verifySrc)
    && /Does NOT re-run live/i.test(verifySrc));

  const provenance = buildFinalNotNullRenameProvenance();
  pass('provenance-ok', provenance.ok === true && provenance.provenanceCount === 4);
  pass('provenance-hashes',
    provenance.migration002Sha256 === EXPECTED_002_SHA256
    && provenance.migration003Sha256 === EXPECTED_003_SHA256
    && provenance.migration004Sha256 === EXPECTED_004_SHA256);
  pass('approved-nine-columns',
    MIGRATION_003_TABLE_RENAME_APPROVED_COLUMNS.length === 9
    && provenance.tableRenameApprovedColumns.length === 9);

  pass('offline-red-green-complete',
    Array.isArray(evidence.offline && evidence.offline.red)
    && Array.isArray(evidence.offline && evidence.offline.green)
    && evidence.offline.red.every((r) => r.ok === true)
    && evidence.offline.green.every((g) => g.ok === true)
    && evidence.offline.red.length >= 18
    && evidence.offline.green.length >= 11);

  pass('exact-12-positives',
    Array.isArray(evidence.offline.positiveKeys)
    && evidence.offline.positiveKeys.length === 12);

  pass('fourteen-t-unchanged', (() => {
    const p = parseCanonicalNotNullConstraint({
      table: 'clients',
      name: 'hostels_created_at_not_null',
      type: 'n',
      definition: 'NOT NULL created_at',
    });
    return p.ok === false && p.reason === 'name_shape_mismatch';
  })());

  pass('final-rename-default-off', !/enableFinalRenameNormalization:\s*true/.test(
    fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'phase-d-rename-alias-normalization.js'), 'utf8'),
  ));

  pass('package-scripts',
    pkg.scripts['prove:sunset-schema-slice14w-final-rename-normalization']
    && pkg.scripts['verify:sunset-schema-slice14w']
    && pkg.scripts['phase-d:final-rename-normalization']);

  pass('cli-gates', (() => {
    const ok = evaluateFinalRenameNormalizationGates({
      env: finalRenameNormalizationEnv(),
      argv: exactFinalRenameNormalizationArgv(),
    });
    const bad = evaluateFinalRenameNormalizationGates({ env: {}, argv: [] });
    return ok.ok === true && bad.ok === false
      && ENV_FINAL_RENAME_NORMALIZATION === 'SUNSET_PHASE_D_FINAL_RENAME_NORMALIZATION'
      && CLI_PROVE_FINAL_RENAME_NORMALIZATION === '--prove-final-rename-normalization';
  })());

  pass('locks',
    FINAL_RENAME_LOCKS.postgresHost === EXPECTED_HOST
    && FINAL_RENAME_LOCKS.database === EXPECTED_DATABASE
    && FINAL_RENAME_LOCKS.sslmode === 'verify-full'
    && FINAL_RENAME_LOCKS.applicationName === APPLICATION_NAME
    && contract.baselineMismatchCount === BASELINE_MISMATCH_COUNT
    && BASELINE_MISMATCH_COUNT === 23);

  pass('findings-no-complete-claim',
    !/complete\s+product\s+schema\s+equivalence/i.test(findings)
    && /Do \*\*not\*\* claim Sunset fully repaired/.test(findings)
    && /wh-sunset-final-rename-normalization/.test(findings));

  const live = evidence.liveOutcome;
  if (live) {
    pass('live-outcome-present', live.ok === true && live.sameTarget === true);
    pass('live-baseline-23', live.baselineMismatchCount === 23);
    pass('live-accounting',
      live.accountingOk === true
      && Number(live.baselineMismatchCount)
        === Number(live.finalRenamesNormalized) + Number(live.remainingMismatchCount));
    pass('live-application-name', live.applicationName === APPLICATION_NAME);
    pass('live-zero-mutation',
      live.liveMutation === false
      && live.schemaMutation === false
      && live.dataMutation === false
      && live.ledgerWritten === false
      && live.kvMutation === false);
    pass('live-tls-verify-full', live.sslmode === 'verify-full');
    pass('live-hashes',
      live.migration002Sha256 === EXPECTED_002_SHA256
      && live.migration003Sha256 === EXPECTED_003_SHA256
      && live.migration004Sha256 === EXPECTED_004_SHA256);
    pass('live-normalized-captured',
      live.finalRenamesNormalized != null
      && Array.isArray(live.remainingKeys));
  } else {
    pass('live-outcome-optional-offline', true);
  }

  // Recompute: truncated name still retained by normalizer.
  {
    const truncated = {
      table: 'package_price_rules',
      name: 'package_price_rules_double_supplement_per_person_per_n_not_null',
      type: 'n',
      definition: 'NOT NULL double_supplement_per_person_per_night_cents',
    };
    const exp = {
      tables: ['package_price_rules'],
      columns: [{
        table: 'package_price_rules',
        column: 'double_supplement_per_person_per_night_cents',
        type: 'integer',
        udt: 'int4',
        nullable: 'NO',
        default: null,
      }],
      constraints: [truncated],
    };
    const liveSnap = {
      tables: ['package_price_rules'],
      columns: exp.columns.map((c) => ({ ...c })),
      constraints: [],
    };
    const norm = normalizeFinalNotNullRenameProvenance(exp, liveSnap, {
      profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: {
        verified: true,
        host: EXPECTED_HOST,
        database: EXPECTED_DATABASE,
        versionClass: 'postgresql_15',
      },
      serverVersionClass: 'postgresql_15',
      provenance,
    });
    pass('truncated-retains',
      norm.ok === true && norm.normalizedCount === 0
      && norm.constraints.some((c) => c.name === truncated.name));
  }

  // Default-off: compare without enableFinalRenameNormalization keeps hostels_*.
  {
    const hostels = expected.snapshot.constraints.filter((c) => (
      c.type === 'n' && c.table === 'clients' && String(c.name).startsWith('hostels_')
    ));
    const exp = {
      tables: ['clients'],
      columns: expected.snapshot.columns.filter((c) => c.table === 'clients'),
      constraints: hostels,
    };
    const liveSnap = {
      tables: ['clients'],
      columns: exp.columns.map((c) => ({ ...c })),
      constraints: [],
    };
    const cmp = compareSnapshots(exp, liveSnap, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: {
        verified: true,
        host: EXPECTED_HOST,
        database: EXPECTED_DATABASE,
        versionClass: 'postgresql_15',
      },
      serverVersionClass: 'postgresql_15',
    });
    pass('default-off-retains-hostels-prefix',
      cmp.finalRenameNormalization == null
      && (cmp.drifts || []).filter((d) => String(d.key).includes('hostels_')).length >= 9);
  }

  pass('lib-mentions-final-rename',
    /enableFinalRenameNormalization/.test(libSrc)
    && /wh-sunset-final-rename-normalization/.test(libSrc));

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14w FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14w OK');
}

main();
