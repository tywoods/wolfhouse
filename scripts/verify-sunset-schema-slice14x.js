'use strict';

/**
 * verify:sunset-schema-slice14x — FOUNDATION Slice 14X RED→GREEN
 * NOT NULL identifier truncation observer normalization.
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
  buildIdentifierTruncationNotNullProvenance,
  derivePgAutoNotNullConstraintName,
  normalizeIdentifierTruncationNotNull,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  MIGRATION_002_PACKAGE_PRICING_SHA256,
  IDENTIFIER_TRUNCATION_LOCKED_TUPLE,
  PG_MAX_IDENTIFIER_BYTES,
} = require('./lib/sunset-schema-observer');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_IDENTIFIER_TRUNCATION_NORMALIZATION_LIVE_ENABLED,
  APPLICATION_NAME,
  IDENTIFIER_TRUNCATION_LOCKS,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  evaluateIdentifierTruncationNormalizationGates,
  exactIdentifierTruncationNormalizationArgv,
  identifierTruncationNormalizationEnv,
  ENV_IDENTIFIER_TRUNCATION_NORMALIZATION,
  CLI_PROVE_IDENTIFIER_TRUNCATION_NORMALIZATION,
} = require('./lib/phase-d-identifier-truncation-normalization');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = 'a093f0ddbc3ed84bc57c04b5175f7385c9775171';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const EXPECTED_002_SHA256 = '3caa9c743252bd058c7eb8cb9bdbd39686b3970249c9d5c051e6971ebf476748';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function main() {
  console.log('verify:sunset-schema-slice14x — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14x-identifier-truncation-normalization-evidence.json');
  const contractPath = path.join(FIX, 'slice14x-identifier-truncation-normalization-contract.json');
  const findingsPath = path.join(FIX, 'slice14x-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14x-identifier-truncation-normalization.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14x.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-identifier-truncation-normalization.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-identifier-truncation-normalization.js');
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
  pass('migration-002-unchanged', live002 === EXPECTED_002_SHA256
    && live002 === MIGRATION_002_PACKAGE_PRICING_SHA256);

  pass('master-basis', evidence.masterShaBasis === MASTER && contract.masterShaBasis === MASTER);
  pass('application-name', evidence.applicationName === APPLICATION_NAME
    && APPLICATION_NAME === 'wh-sunset-identifier-truncation-normalization');
  pass('profile-azure-flexible-server-v1',
    evidence.normalizationProfile === NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1
    && /normalizeIdentifierTruncationNotNull/.test(observerSrc)
    && /enableIdentifierTruncationNormalization/.test(observerSrc));

  pass('safety-flags',
    evidence.secretFree === true
    && evidence.liveMutation === false
    && evidence.schemaMutation === false
    && evidence.dataMutation === false
    && evidence.ledgerWritten === false
    && evidence.kvMutation === false
    && PHASE_D_LIVE_APPLY_ENABLED === false
    && PHASE_D_IDENTIFIER_TRUNCATION_NORMALIZATION_LIVE_ENABLED === true);

  pass('verify-never-reruns-live',
    evidence.verifyNeverRerunsLive === true
    && contract.verifyNeverRerunsLive === true
    && !/process\.argv\.includes\('--live'\)/.test(verifySrc)
    && !/executeIdentifierTruncationNormalization\(/.test(verifySrc)
    && /Does NOT re-run live/i.test(verifySrc));

  const provenance = buildIdentifierTruncationNotNullProvenance();
  pass('provenance-ok', provenance.ok === true && provenance.provenanceCount === 1);
  pass('provenance-hash', provenance.migration002Sha256 === EXPECTED_002_SHA256);

  const derived = derivePgAutoNotNullConstraintName(
    IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table,
    IDENTIFIER_TRUNCATION_LOCKED_TUPLE.column,
  );
  pass('locked-tuple-exact',
    IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name === derived
    && Buffer.byteLength(derived, 'utf8') === PG_MAX_IDENTIFIER_BYTES
    && evidence.lockedTuple
    && evidence.lockedTuple.name === IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name
    && evidence.lockedTuple.definition === IDENTIFIER_TRUNCATION_LOCKED_TUPLE.definition
    && evidence.lockedTuple.migrationSha256 === EXPECTED_002_SHA256);

  pass('offline-red-green-complete',
    Array.isArray(evidence.offline && evidence.offline.red)
    && Array.isArray(evidence.offline && evidence.offline.green)
    && evidence.offline.red.every((r) => r.ok === true)
    && evidence.offline.green.every((g) => g.ok === true)
    && evidence.offline.red.length >= 19
    && evidence.offline.green.length >= 12);

  pass('exact-one-positive',
    Array.isArray(evidence.offline.positiveKeys)
    && evidence.offline.positiveKeys.length === 1
    && evidence.offline.positiveKeys[0]
      === 'package_price_rules.package_price_rules_double_supplement_per_person_per_n_not_null.n');

  pass('fourteen-t-unchanged', (() => {
    const p = parseCanonicalNotNullConstraint({
      table: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table,
      name: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name,
      type: 'n',
      definition: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.definition,
    });
    return p.ok === false && p.reason === 'name_shape_mismatch';
  })());

  pass('fourteen-w-retains-truncation', (() => {
    const renameProv = buildFinalNotNullRenameProvenance();
    const exp = {
      tables: [IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table],
      columns: [{
        table: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table,
        column: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.column,
        type: 'integer',
        udt: 'int4',
        nullable: 'NO',
        default: null,
      }],
      constraints: [{
        table: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table,
        name: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name,
        type: 'n',
        definition: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.definition,
      }],
    };
    const liveSnap = {
      tables: exp.tables.slice(),
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
      provenance: renameProv,
    });
    return norm.ok === true && norm.normalizedCount === 0
      && norm.constraints.some((c) => c.name === IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name);
  })());

  pass('no-fuzzy-prefix-matching', (() => {
    const truncFn = observerSrc.slice(
      observerSrc.indexOf('function parseIdentifierTruncationNotNullMatch'),
      observerSrc.indexOf('function normalizeIdentifierTruncationNotNull'),
    );
    const codeOnly = truncFn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return /name !== tuple\.name/.test(codeOnly)
      && !/startsWith\(/.test(codeOnly)
      && !/\.includes\(/.test(codeOnly);
  })());

  pass('truncation-default-off', !/enableIdentifierTruncationNormalization:\s*true/.test(
    fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'phase-d-final-rename-normalization.js'), 'utf8'),
  ));

  pass('package-scripts',
    pkg.scripts['prove:sunset-schema-slice14x-identifier-truncation-normalization']
    && pkg.scripts['verify:sunset-schema-slice14x']
    && pkg.scripts['phase-d:identifier-truncation-normalization']);

  pass('cli-gates', (() => {
    const ok = evaluateIdentifierTruncationNormalizationGates({
      env: identifierTruncationNormalizationEnv(),
      argv: exactIdentifierTruncationNormalizationArgv(),
    });
    const bad = evaluateIdentifierTruncationNormalizationGates({ env: {}, argv: [] });
    return ok.ok === true && bad.ok === false
      && ENV_IDENTIFIER_TRUNCATION_NORMALIZATION === 'SUNSET_PHASE_D_IDENTIFIER_TRUNCATION_NORMALIZATION'
      && CLI_PROVE_IDENTIFIER_TRUNCATION_NORMALIZATION === '--prove-identifier-truncation-normalization';
  })());

  pass('locks',
    IDENTIFIER_TRUNCATION_LOCKS.postgresHost === EXPECTED_HOST
    && IDENTIFIER_TRUNCATION_LOCKS.database === EXPECTED_DATABASE
    && IDENTIFIER_TRUNCATION_LOCKS.sslmode === 'verify-full'
    && IDENTIFIER_TRUNCATION_LOCKS.applicationName === APPLICATION_NAME
    && contract.baselineMismatchCount === BASELINE_MISMATCH_COUNT
    && BASELINE_MISMATCH_COUNT === 12
    && BASELINE_MISMATCH_SECTIONS.constraints === 2
    && BASELINE_MISMATCH_SECTIONS.indexes === 5);

  pass('findings-no-complete-claim',
    !/complete\s+product\s+schema\s+equivalence/i.test(findings)
    && /Do \*\*not\*\* claim Sunset fully repaired/.test(findings)
    && /wh-sunset-identifier-truncation-normalization/.test(findings));

  const live = evidence.liveOutcome;
  if (live) {
    pass('live-outcome-present', live.ok === true && live.sameTarget === true);
    pass('live-baseline-12', live.baselineMismatchCount === 12);
    pass('live-baseline-sections', (() => {
      const sections = (live.observerBefore && live.observerBefore.mismatchSections)
        || (live.baseline && live.baseline.mismatchSections)
        || null;
      if (!sections) return false;
      return Number(sections.constraints) === 2
        && Number(sections.indexes) === 5
        && Number(sections.functions) === 1
        && Number(sections.triggers) === 1
        && Number(sections.ownership) === 1
        && Number(sections.acls) === 1
        && Number(sections.extensions) === 1;
    })());
    pass('live-accounting',
      live.accountingOk === true
      && Number(live.baselineMismatchCount)
        === Number(live.identifierTruncationsNormalized) + Number(live.remainingMismatchCount));
    pass('live-normalized-one', live.identifierTruncationsNormalized === 1);
    pass('live-application-name', live.applicationName === APPLICATION_NAME);
    pass('live-zero-mutation',
      live.liveMutation === false
      && live.schemaMutation === false
      && live.dataMutation === false
      && live.ledgerWritten === false
      && live.kvMutation === false);
    pass('live-tls-verify-full', live.sslmode === 'verify-full');
    pass('live-hash', live.migration002Sha256 === EXPECTED_002_SHA256);
    pass('live-remaining-captured',
      live.remainingMismatchCount != null
      && Array.isArray(live.remainingKeys)
      && !live.remainingKeys.includes(
        'package_price_rules.package_price_rules_double_supplement_per_person_per_n_not_null.n',
      ));
  } else {
    pass('live-outcome-optional-offline', true);
  }

  // Recompute: locked truncation normalizes under 14X.
  {
    const trunc = {
      table: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table,
      name: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name,
      type: 'n',
      definition: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.definition,
    };
    const exp = {
      tables: [trunc.table],
      columns: [{
        table: trunc.table,
        column: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.column,
        type: 'integer',
        udt: 'int4',
        nullable: 'NO',
        default: null,
      }],
      constraints: [trunc],
    };
    const liveSnap = {
      tables: exp.tables.slice(),
      columns: exp.columns.map((c) => ({ ...c })),
      constraints: [],
    };
    const norm = normalizeIdentifierTruncationNotNull(exp, liveSnap, {
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
    pass('truncation-normalizes',
      norm.ok === true && norm.normalizedCount === 1
      && !norm.constraints.some((c) => c.name === trunc.name));

    // Near-collision naive truncate retains.
    const naiveName = Buffer.from(
      `${IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table}_`
      + `${IDENTIFIER_TRUNCATION_LOCKED_TUPLE.column}_not_null`,
    ).subarray(0, PG_MAX_IDENTIFIER_BYTES).toString('utf8');
    const naiveExp = {
      ...exp,
      constraints: [{ ...trunc, name: naiveName }],
    };
    const naiveNorm = normalizeIdentifierTruncationNotNull(naiveExp, liveSnap, {
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
    pass('near-collision-retains',
      naiveNorm.ok === true && naiveNorm.normalizedCount === 0
      && naiveNorm.constraints.some((c) => c.name === naiveName)
      && naiveName !== trunc.name);
  }

  // Default-off: compare without enableIdentifierTruncationNormalization retains.
  {
    const trunc = {
      table: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table,
      name: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name,
      type: 'n',
      definition: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.definition,
    };
    const exp = {
      tables: [trunc.table],
      columns: [{
        table: trunc.table,
        column: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.column,
        type: 'integer',
        udt: 'int4',
        nullable: 'NO',
        default: null,
      }],
      constraints: [trunc],
    };
    const liveSnap = {
      tables: exp.tables.slice(),
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
      enableFinalRenameNormalization: true,
    });
    pass('default-off-retains-truncation',
      cmp.identifierTruncationNormalization == null
      && (cmp.drifts || []).some((d) => String(d.key).includes(trunc.name)));
  }

  pass('lib-mentions-identifier-truncation',
    /enableIdentifierTruncationNormalization/.test(libSrc)
    && /wh-sunset-identifier-truncation-normalization/.test(libSrc)
    && /BASELINE_MISMATCH_COUNT = 12/.test(libSrc));

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14x FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14x OK');
}

main();
