'use strict';

/**
 * verify:sunset-schema-slice14v — FOUNDATION Slice 14V RED→GREEN
 * hostel_id→client_id rename-alias observer normalization.
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
  buildMigration003HostelClientRenameAliasProvenance,
  normalizeMigration003HostelIdNotNullRenameAlias,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256,
} = require('./lib/sunset-schema-observer');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_RENAME_ALIAS_NORMALIZATION_LIVE_ENABLED,
  APPLICATION_NAME,
  RENAME_ALIAS_LOCKS,
  BASELINE_MISMATCH_COUNT,
  evaluateRenameAliasNormalizationGates,
  exactRenameAliasNormalizationArgv,
  renameAliasNormalizationEnv,
  ENV_RENAME_ALIAS_NORMALIZATION,
  CLI_PROVE_RENAME_ALIAS_NORMALIZATION,
} = require('./lib/phase-d-rename-alias-normalization');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '7b54b17ff1071349c82344277971df75a87ed499';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const EXPECTED_003_SHA256 = 'f79826262081050f68c7f8014136d90730dc4dedffe37549aad2ff998f340257';
const MIGRATION_003_PATH = path.join(MIGRATIONS_DIR, '003_rename_hostel_to_client.sql');

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_prove_flag_zero_clients',
  'missing_rename_alias_env_zero_clients',
  'wrong_exact_targets_zero_clients',
  'forbidden_argv_dsn_sql_drop_dml_zero_clients',
  'non_azure_profile_retains_alias_constraints',
  'non_pg15_version_retains_or_rejects',
  'live_nullable_yes_retains_drift',
  'live_column_missing_retains_drift',
  'live_hostel_id_present_retains_drift',
  'ambiguous_duplicate_claim_retains_drift',
  'wrong_definition_retains_drift',
  'arbitrary_old_name_retains_drift',
  'nonapproved_table_retains_drift',
  'migration_003_hash_change_fails',
  'fourteen_t_exact_name_rule_unchanged',
];

const REQUIRED_GREEN = [
  'exact_24_key_fixture',
  'migration_003_provenance_15_tables_hash_locked',
  'twelve_hostel_id_aliases_normalize_when_columns_match',
  'negative_keys_within_24_retain',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'accounting_identity_baseline_aliases_plus_remaining',
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
  console.log('verify:sunset-schema-slice14v — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14v-rename-alias-normalization-evidence.json');
  const contractPath = path.join(FIX, 'slice14v-rename-alias-normalization-contract.json');
  const findingsPath = path.join(FIX, 'slice14v-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14v-rename-alias-normalization.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14v.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-rename-alias-normalization.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-rename-alias-normalization.js');
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

  const live003 = sha256CanonicalLfV1File(MIGRATION_003_PATH);
  pass('migration-003-unchanged', live003 === EXPECTED_003_SHA256
    && live003 === MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256);

  pass('master-basis', evidence.masterShaBasis === MASTER && contract.masterShaBasis === MASTER);
  pass('application-name', evidence.applicationName === APPLICATION_NAME
    && APPLICATION_NAME === 'wh-sunset-rename-alias-normalization');
  pass('profile-azure-flexible-server-v1',
    evidence.normalizationProfile === NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1
    && /normalizeMigration003HostelIdNotNullRenameAlias/.test(observerSrc));

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
    && !/executeRenameAliasNormalization\(/.test(verifySrc)
    && /Does NOT re-run live/i.test(verifySrc));

  const redNames = (evidence.offline && evidence.offline.red || []).map((r) => r.name);
  const greenNames = (evidence.offline && evidence.offline.green || []).map((g) => g.name);
  pass('required-red-present', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('required-green-present', REQUIRED_GREEN.every((n) => greenNames.includes(n)));
  pass('offline-red-all-pass', (evidence.offline.red || []).every((r) => r.ok === true));
  pass('offline-green-all-pass', (evidence.offline.green || []).every((g) => g.ok === true));

  const fixture = evidence.offline && evidence.offline.fixture24;
  pass('fixture-24-keys', fixture
    && Array.isArray(fixture.keys)
    && fixture.keys.length === 24
    && fixture.positiveCount === 12
    && fixture.negativeCount === 12);

  const provenance = buildMigration003HostelClientRenameAliasProvenance({
    migrationPath: MIGRATION_003_PATH,
    expectedSha256: EXPECTED_003_SHA256,
  });
  pass('provenance-15-tables', provenance.ok === true && provenance.provenanceCount === 15);

  // Recompute: 14T exact-name still rejects hostel_id alias names.
  {
    const bad = parseCanonicalNotNullConstraint({
      table: 'beds',
      name: 'beds_hostel_id_not_null',
      type: 'n',
      definition: 'NOT NULL client_id',
    });
    pass('fourteen-t-parse-still-rejects-hostel-alias',
      bad.ok === false && bad.reason === 'name_shape_mismatch');
  }

  // Recompute positive normalize offline.
  {
    const positiveKeys = fixture.positiveKeys || [];
    const positiveConstraints = expected.snapshot.constraints.filter((c) => (
      positiveKeys.includes(`${c.table}.${c.name}.${c.type}`)
    ));
    const tables = [...new Set(positiveConstraints.map((c) => c.table))];
    const expSnap = {
      tables,
      columns: tables.map((t) => {
        const col = expected.snapshot.columns.find((c) => c.table === t && c.column === 'client_id');
        return col
          ? { ...col, nullable: 'NO' }
          : {
            table: t, column: 'client_id', type: 'uuid', udt: 'uuid', nullable: 'NO', default: null,
          };
      }),
      constraints: positiveConstraints.map((c) => ({ ...c })),
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
      constraints: [],
      columns: expSnap.columns.map((c) => ({ ...c, nullable: 'NO' })),
    };
    const azureContext = {
      verified: true,
      host: EXPECTED_HOST,
      database: EXPECTED_DATABASE,
      versionClass: 'postgresql_15',
    };
    const raw = compareSnapshots(expSnap, liveSnap, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext,
      serverVersionClass: 'postgresql_15',
      renameAliasProvenance: provenance,
      disableRenameAliasNormalization: true,
    });
    const norm = compareSnapshots(expSnap, liveSnap, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext,
      serverVersionClass: 'postgresql_15',
      renameAliasProvenance: provenance,
    });
    pass(
      'recompute-12-aliases-normalize',
      positiveConstraints.length === 12
        && (raw.drifts || []).filter((d) => String(d.key).endsWith('.n')).length === 12
        && (norm.drifts || []).filter((d) => String(d.key).endsWith('.n')).length === 0
        && norm.renameAliasNormalization
        && norm.renameAliasNormalization.normalizedCount === 12,
      `pos=${positiveConstraints.length} raw=${raw.drifts.length} norm=${norm.drifts.length}`,
    );

    // Accounting check on same mini fixture
    pass(
      'recompute-accounting',
      raw.drifts.length === (norm.renameAliasNormalization.normalizedCount + norm.drifts.length),
    );

    // Soft-skip absent PG15
    const soft = normalizeMigration003HostelIdNotNullRenameAlias(expSnap, liveSnap, {
      profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: { verified: true, host: EXPECTED_HOST, database: EXPECTED_DATABASE },
      provenance,
    });
    pass('recompute-soft-skip-absent-pg15',
      soft.ok === true && soft.applied === false && soft.normalizedCount === 0);
  }

  const gates = evaluateRenameAliasNormalizationGates({
    env: renameAliasNormalizationEnv(),
    argv: exactRenameAliasNormalizationArgv(),
  });
  pass('runtime-cli-gates', gates.ok === true);
  pass('capability-flags',
    PHASE_D_RENAME_ALIAS_NORMALIZATION_LIVE_ENABLED === true
    && ENV_RENAME_ALIAS_NORMALIZATION === 'SUNSET_PHASE_D_RENAME_ALIAS_NORMALIZATION'
    && CLI_PROVE_RENAME_ALIAS_NORMALIZATION === '--prove-rename-alias-normalization'
    && BASELINE_MISMATCH_COUNT === 35);

  pass('pkg-scripts',
    typeof pkg.scripts['prove:sunset-schema-slice14v-rename-alias-normalization'] === 'string'
    && typeof pkg.scripts['verify:sunset-schema-slice14v'] === 'string'
    && typeof pkg.scripts['phase-d:rename-alias-normalization'] === 'string');

  pass('findings-mention-rename-alias',
    /hostel_id|rename.?alias|migration 003/i.test(findings)
    && /wh-sunset-rename-alias-normalization/.test(findings)
    && /do not claim/i.test(findings));

  pass('lib-zero-mutation-markers',
    /Zero mutation/.test(libSrc)
    && /disableRenameAliasNormalization/.test(libSrc)
    && /baseline_drift_mismatch/.test(libSrc)
    && PHASE_D_LIVE_APPLY_ENABLED === false);

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
    pass('live-has-accounting',
      Number.isFinite(lo.baselineMismatchCount)
      && Number.isFinite(lo.renameAliasesNormalized)
      && Number.isFinite(lo.remainingMismatchCount)
      && Array.isArray(lo.remainingKeys)
      && lo.baselineMismatchCount === lo.renameAliasesNormalized + lo.remainingMismatchCount);
    pass('live-has-before-after-sections',
      lo.observerBefore
      && lo.observerAfter
      && lo.observerBefore.mismatchSections
      && lo.observerAfter.mismatchSections);
    pass('live-provenance-fields',
      lo.migration003Sha256 === EXPECTED_003_SHA256
      && Number(lo.provenanceCount) === 15
      && lo.verifyNeverRerunsLive === true);
    pass('live-version-class',
      lo.serverVersionClass
      && lo.serverVersionClass.versionClass === 'postgresql_15');
  } else {
    pass('live-evidence-optional-offline', true);
  }

  pass('contract-locks',
    contract.locks.applicationName === APPLICATION_NAME
    && contract.locks.sslmode === 'verify-full'
    && contract.verifyNeverRerunsLive === true
    && contract.baselineMismatchCount === BASELINE_MISMATCH_COUNT
    && contract.migration003Sha256 === EXPECTED_003_SHA256);

  if (failed) {
    console.log(`\nverify:sunset-schema-slice14v FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14v GREEN');
}

main();
