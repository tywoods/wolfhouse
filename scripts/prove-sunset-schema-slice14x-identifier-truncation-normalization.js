'use strict';

/**
 * prove-sunset-schema-slice14x-identifier-truncation-normalization
 * FOUNDATION Slice 14X
 *
 * Offline RED/GREEN for exact NAMEDATALEN auto NOT NULL truncation
 * normalization (migration 002 locked tuple) + optional --live once:
 * merged target authority + one TLS verify-full observer session
 * application_name=wh-sunset-identifier-truncation-normalization.
 *
 * Extends — does not weaken — 14T/14V/14W. Default offline.
 * Verify never re-runs live. Zero mutation.
 * Never claim database matches canonical.
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
  buildFinalNotNullRenameProvenance,
  normalizeFinalNotNullRenameProvenance,
  buildIdentifierTruncationNotNullProvenance,
  parseIdentifierTruncationNotNullMatch,
  normalizeIdentifierTruncationNotNull,
  derivePgAutoNotNullConstraintName,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  MIGRATION_002_PACKAGE_PRICING_SHA256,
  IDENTIFIER_TRUNCATION_LOCKED_TUPLE,
  IDENTIFIER_TRUNCATION_RULE,
  PG_MAX_IDENTIFIER_BYTES,
} = require('./lib/sunset-schema-observer');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_IDENTIFIER_TRUNCATION_NORMALIZATION_LIVE_ENABLED,
  ENV_IDENTIFIER_TRUNCATION_NORMALIZATION,
  CLI_PROVE_IDENTIFIER_TRUNCATION_NORMALIZATION,
  APPLICATION_NAME,
  IDENTIFIER_TRUNCATION_LOCKS,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  evaluateIdentifierTruncationNormalizationGates,
  exactIdentifierTruncationNormalizationArgv,
  identifierTruncationNormalizationEnv,
  executeIdentifierTruncationNormalization,
  createInjectedTargetAuthorityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetIdentifierTruncationNormalizationCounters,
  getIdentifierTruncationNormalizationCounters,
  printCliHelp,
} = require('./lib/phase-d-identifier-truncation-normalization');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14x-identifier-truncation-normalization-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14x-identifier-truncation-normalization-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14x-findings.md');

const MASTER = 'a093f0ddbc3ed84bc57c04b5175f7385c9775171';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const EXPECTED_002_SHA256 = '3caa9c743252bd058c7eb8cb9bdbd39686b3970249c9d5c051e6971ebf476748';

const AZURE_CTX = Object.freeze({
  verified: true,
  host: EXPECTED_HOST,
  database: EXPECTED_DATABASE,
  versionClass: 'postgresql_15',
});

const FAKE_ADMIN_USER = 'slice14x-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14x-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14x-proof-imds-token-never-commit';

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_prove_flag_zero_clients',
  'missing_truncation_env_zero_clients',
  'wrong_exact_targets_zero_clients',
  'forbidden_argv_dsn_sql_drop_dml_zero_clients',
  'non_azure_profile_retains_truncation_constraint',
  'non_pg15_version_retains_or_rejects',
  'live_nullable_yes_retains_drift',
  'live_column_missing_retains_drift',
  'ambiguous_duplicate_claim_retains_drift',
  'wrong_definition_retains_drift',
  'wrong_table_retains_drift',
  'naive_truncate_near_collision_retains',
  'untruncated_full_name_retains',
  'wrong_length_near_collision_retains',
  'fuzzy_prefix_not_implemented_retains',
  'migration_hash_change_fails',
  'fourteen_t_exact_name_rule_unchanged',
  'fourteen_w_still_retains_truncation',
];

const REQUIRED_GREEN = [
  'exact_one_locked_tuple_fixture',
  'migration_hash_and_derived_name_locked',
  'namedatalen_derivation_matches_locked',
  'one_truncation_normalizes_when_column_matches',
  'negative_near_collisions_retain',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'accounting_baseline_normalized_plus_remaining',
  'raw_vs_normalized_compare_api',
  'truncation_default_off_preserves_14w',
];

function emptySnap() {
  return {
    tables: [],
    columns: [],
    constraints: [],
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
}

function leakScan(value, secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const s of secrets) {
    if (s && text.includes(s)) {
      throw new Error(`secret leaked into proof artifact: ${s.slice(0, 8)}…`);
    }
  }
  if (/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(text)) {
    throw new Error('DSN leaked into proof artifact');
  }
  if (/Bearer\s+slice14x-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
}

function lockedConstraint() {
  return {
    table: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table,
    name: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name,
    type: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.type,
    definition: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.definition,
  };
}

function lockedColumn(nullable) {
  return {
    table: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table,
    column: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.column,
    type: 'integer',
    udt: 'int4',
    nullable,
    default: '1000',
  };
}

/** One positive locked truncation + near-collision negatives. */
function buildExactOneFixture(expectedFull, provenance) {
  const positive = lockedConstraint();
  const fromExpected = expectedFull.snapshot.constraints.find((c) => (
    c.table === positive.table
    && c.name === positive.name
    && c.type === positive.type
  ));
  if (!fromExpected || fromExpected.definition !== positive.definition) {
    throw new Error('canonical expected snapshot missing locked truncation tuple');
  }
  const parsed = parseIdentifierTruncationNotNullMatch(positive, provenance);
  if (!parsed.ok) throw new Error(`locked tuple must match: ${parsed.reason}`);

  const positiveKey = `${positive.table}.${positive.name}.${positive.type}`;
  const positives = [positive];
  const positiveKeys = [positiveKey];

  const naiveTruncate = Buffer.from(
    `${IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table}_`
    + `${IDENTIFIER_TRUNCATION_LOCKED_TUPLE.column}_not_null`,
  ).subarray(0, PG_MAX_IDENTIFIER_BYTES).toString('utf8');
  // Near-collision: full auto name is 14T-canonical shape, so use a
  // non-canonical overlong sibling instead of the true untruncated form.
  const overlongSibling = `${IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table}_`
    + `${IDENTIFIER_TRUNCATION_LOCKED_TUPLE.column}_not_null_x`;
  const shortName = IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name.slice(0, -1);
  const negatives = [
    {
      table: positive.table,
      name: naiveTruncate,
      type: 'n',
      definition: positive.definition,
    },
    {
      table: positive.table,
      name: overlongSibling,
      type: 'n',
      definition: positive.definition,
    },
    {
      table: positive.table,
      name: shortName,
      type: 'n',
      definition: positive.definition,
    },
    {
      table: positive.table,
      name: 'package_price_rules_double_supplement_per_person_per_n',
      type: 'n',
      definition: positive.definition,
    },
    {
      table: 'other_price_rules',
      name: positive.name,
      type: 'n',
      definition: positive.definition,
    },
  ];
  const negativeKeys = negatives
    .map((c) => `${c.table}.${c.name}.${c.type}`)
    .sort();

  const expected = emptySnap();
  expected.tables = [positive.table];
  expected.constraints = [{ ...positive }];
  expected.columns = [lockedColumn('NO')];

  const live = emptySnap();
  live.tables = expected.tables.slice();
  live.columns = expected.columns.map((c) => ({ ...c }));
  live.constraints = [];

  const allExpected = emptySnap();
  allExpected.tables = [positive.table, 'other_price_rules'];
  allExpected.constraints = [
    { ...positive },
    ...negatives.map((c) => ({ ...c })),
  ];
  allExpected.columns = [
    lockedColumn('NO'),
    {
      table: 'other_price_rules',
      column: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.column,
      type: 'integer',
      udt: 'int4',
      nullable: 'NO',
      default: null,
    },
  ];

  const allLive = emptySnap();
  allLive.tables = allExpected.tables.slice();
  allLive.columns = allExpected.columns.map((c) => ({ ...c }));
  allLive.constraints = [];

  return {
    positives,
    positiveKeys,
    negatives,
    negativeKeys,
    expected,
    live,
    allExpected,
    allLive,
    naiveTruncate,
    untruncated: `${IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table}_`
      + `${IDENTIFIER_TRUNCATION_LOCKED_TUPLE.column}_not_null`,
    overlongSibling,
  };
}

function compareOpts(extra) {
  return {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: AZURE_CTX,
    serverVersionClass: 'postgresql_15',
    enableFinalRenameNormalization: true,
    enableIdentifierTruncationNormalization: true,
    ...(extra || {}),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${printCliHelp()}\n`);
    process.exit(0);
  }
  const wantLive = argv.includes('--live')
    && !argv.includes('--offline')
    && process.env.SUNSET_SLICE14X_PROOF_OFFLINE !== '1';

  const red = [];
  const green = [];
  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN];

  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedByteSha = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  if (expectedByteSha !== EXPECTED_BYTE_SHA) {
    throw new Error(`expected bytes drift: ${expectedByteSha}`);
  }
  const expected = JSON.parse(expectedBytes.toString('utf8'));
  if (expected.productFingerprint !== CANON_FP) {
    throw new Error('canonical fingerprint drift');
  }
  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) throw new Error('manifest integrity failed');
  forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  if (manifestHash !== MANIFEST_HASH) throw new Error('manifest hash drift');

  const live002 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '002_package_pricing.sql'));
  if (live002 !== EXPECTED_002_SHA256 || live002 !== MIGRATION_002_PACKAGE_PRICING_SHA256) {
    throw new Error('migration 002 sha drift');
  }

  const provenance = buildIdentifierTruncationNotNullProvenance();
  if (!provenance.ok) throw new Error(`provenance failed: ${provenance.code}`);

  const fixture = buildExactOneFixture(expected, provenance);

  green.push({
    name: 'exact_one_locked_tuple_fixture',
    ok: fixture.positiveKeys.length === 1
      && fixture.positives[0].name === IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name
      && fixture.positives[0].definition === IDENTIFIER_TRUNCATION_LOCKED_TUPLE.definition,
    detail: { positiveKeys: fixture.positiveKeys, negative: fixture.negativeKeys.length },
  });

  const derived = derivePgAutoNotNullConstraintName(
    IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table,
    IDENTIFIER_TRUNCATION_LOCKED_TUPLE.column,
  );
  green.push({
    name: 'migration_hash_and_derived_name_locked',
    ok: provenance.ok === true
      && provenance.provenanceCount === 1
      && provenance.migration002Sha256 === EXPECTED_002_SHA256
      && provenance.lockedTuple.name === IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name
      && provenance.lockedTuple.migrationSha256 === EXPECTED_002_SHA256
      && provenance.rule === IDENTIFIER_TRUNCATION_RULE,
    detail: {
      sha002: provenance.migration002Sha256,
      name: provenance.lockedTuple.name,
      derived,
    },
  });

  green.push({
    name: 'namedatalen_derivation_matches_locked',
    ok: derived === IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name
      && Buffer.byteLength(derived, 'utf8') === PG_MAX_IDENTIFIER_BYTES
      && derived !== fixture.naiveTruncate
      && Buffer.byteLength(fixture.untruncated, 'utf8') > PG_MAX_IDENTIFIER_BYTES,
    detail: {
      derived,
      naiveTruncate: fixture.naiveTruncate,
      untruncatedLen: Buffer.byteLength(fixture.untruncated, 'utf8'),
    },
  });

  // ── RED cases ────────────────────────────────────────────────────
  {
    resetIdentifierTruncationNormalizationCounters();
    const gate = evaluateIdentifierTruncationNormalizationGates({ env: {}, argv: [] });
    const c = getIdentifierTruncationNormalizationCounters();
    red.push({
      name: 'default_path_zero_http_and_clients',
      ok: gate.ok === false && c.clientsInstantiated === 0 && c.httpRequestCount === 0,
    });
  }

  {
    resetIdentifierTruncationNormalizationCounters();
    const env = identifierTruncationNormalizationEnv();
    const argvLocal = exactIdentifierTruncationNormalizationArgv().filter(
      (a) => a !== CLI_PROVE_IDENTIFIER_TRUNCATION_NORMALIZATION,
    );
    const gate = evaluateIdentifierTruncationNormalizationGates({ env, argv: argvLocal });
    const c = getIdentifierTruncationNormalizationCounters();
    red.push({
      name: 'missing_prove_flag_zero_clients',
      ok: gate.ok === false
        && gate.errors.some((e) => e.code === 'identifier_truncation_normalization_flag_required')
        && c.clientsInstantiated === 0,
    });
  }

  {
    resetIdentifierTruncationNormalizationCounters();
    const env = { ...identifierTruncationNormalizationEnv() };
    delete env[ENV_IDENTIFIER_TRUNCATION_NORMALIZATION];
    const gate = evaluateIdentifierTruncationNormalizationGates({
      env,
      argv: exactIdentifierTruncationNormalizationArgv(),
    });
    const c = getIdentifierTruncationNormalizationCounters();
    red.push({
      name: 'missing_truncation_env_zero_clients',
      ok: gate.ok === false
        && gate.errors.some((e) => e.code === 'identifier_truncation_normalization_env_required')
        && c.clientsInstantiated === 0,
    });
  }

  {
    resetIdentifierTruncationNormalizationCounters();
    const argvLocal = exactIdentifierTruncationNormalizationArgv().map((a) => (
      a === 'sunset_staging' ? 'wrong_db' : a
    ));
    const gate = evaluateIdentifierTruncationNormalizationGates({
      env: identifierTruncationNormalizationEnv(),
      argv: argvLocal,
    });
    red.push({
      name: 'wrong_exact_targets_zero_clients',
      ok: gate.ok === false && gate.errors.some((e) => e.code === 'exact_target_mismatch'),
    });
  }

  {
    resetIdentifierTruncationNormalizationCounters();
    const argvLocal = [...exactIdentifierTruncationNormalizationArgv(), '--dsn', 'postgresql://x'];
    const gate = evaluateIdentifierTruncationNormalizationGates({
      env: identifierTruncationNormalizationEnv(),
      argv: argvLocal,
    });
    red.push({
      name: 'forbidden_argv_dsn_sql_drop_dml_zero_clients',
      ok: gate.ok === false && gate.errors.some((e) => e.code === 'forbidden_argv'),
    });
  }

  {
    const cmp = compareSnapshots(fixture.expected, fixture.live, {
      normalizationProfile: null,
      enableFinalRenameNormalization: true,
      enableIdentifierTruncationNormalization: true,
      identifierTruncationProvenance: provenance,
    });
    red.push({
      name: 'non_azure_profile_retains_truncation_constraint',
      ok: (cmp.drifts || []).some((d) => d.key === fixture.positiveKeys[0])
        && (cmp.identifierTruncationNormalization == null
          || cmp.identifierTruncationNormalization.applied !== true),
    });
  }

  {
    const reject = normalizeIdentifierTruncationNotNull(
      fixture.expected,
      fixture.live,
      {
        profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
        azureContext: {
          verified: true,
          host: EXPECTED_HOST,
          database: EXPECTED_DATABASE,
          versionClass: 'postgresql_16',
        },
        serverVersionClass: 'postgresql_16',
        provenance,
      },
    );
    const soft = normalizeIdentifierTruncationNotNull(
      fixture.expected,
      fixture.live,
      {
        profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
        azureContext: {
          verified: true,
          host: EXPECTED_HOST,
          database: EXPECTED_DATABASE,
        },
        provenance,
      },
    );
    red.push({
      name: 'non_pg15_version_retains_or_rejects',
      ok: (reject.ok === false && reject.code === 'pg15_context_required')
        && soft.ok === true
        && soft.applied === false
        && soft.normalizedCount === 0,
    });
  }

  {
    const liveYes = JSON.parse(JSON.stringify(fixture.live));
    liveYes.columns = liveYes.columns.map((c) => ({ ...c, nullable: 'YES' }));
    const cmp = compareSnapshots(fixture.expected, liveYes, compareOpts({
      identifierTruncationProvenance: provenance,
    }));
    red.push({
      name: 'live_nullable_yes_retains_drift',
      ok: (cmp.drifts || []).some((d) => d.key === fixture.positiveKeys[0]),
    });
  }

  {
    const liveMissing = JSON.parse(JSON.stringify(fixture.live));
    liveMissing.columns = [];
    const cmp = compareSnapshots(fixture.expected, liveMissing, compareOpts({
      identifierTruncationProvenance: provenance,
    }));
    red.push({
      name: 'live_column_missing_retains_drift',
      ok: (cmp.drifts || []).some((d) => d.key === fixture.positiveKeys[0]),
    });
  }

  {
    const expDup = JSON.parse(JSON.stringify(fixture.expected));
    expDup.constraints.push({ ...fixture.positives[0] });
    const norm = normalizeIdentifierTruncationNotNull(expDup, fixture.live, {
      profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      provenance,
    });
    red.push({
      name: 'ambiguous_duplicate_claim_retains_drift',
      ok: (norm.constraints || []).some((c) => `${c.table}.${c.name}.${c.type}` === fixture.positiveKeys[0])
        && norm.normalizedCount === 0,
    });
  }

  {
    const bad = {
      ...lockedConstraint(),
      definition: 'NOT NULL price_per_person_per_week_cents',
    };
    const parsed = parseIdentifierTruncationNotNullMatch(bad, provenance);
    red.push({
      name: 'wrong_definition_retains_drift',
      ok: parsed.ok === false && parsed.reason === 'wrong_definition',
    });
  }

  {
    const bad = {
      ...lockedConstraint(),
      table: 'other_price_rules',
    };
    const parsed = parseIdentifierTruncationNotNullMatch(bad, provenance);
    red.push({
      name: 'wrong_table_retains_drift',
      ok: parsed.ok === false && parsed.reason === 'wrong_table',
    });
  }

  {
    const naive = {
      table: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table,
      name: fixture.naiveTruncate,
      type: 'n',
      definition: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.definition,
    };
    const parsed = parseIdentifierTruncationNotNullMatch(naive, provenance);
    red.push({
      name: 'naive_truncate_near_collision_retains',
      ok: parsed.ok === false
        && parsed.reason === 'name_not_exact_locked_truncation'
        && fixture.naiveTruncate !== IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name,
    });
  }

  {
    const full = {
      table: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table,
      name: fixture.untruncated,
      type: 'n',
      definition: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.definition,
    };
    const parsed = parseIdentifierTruncationNotNullMatch(full, provenance);
    // True untruncated name is 14T-canonical; 14X must still reject it.
    red.push({
      name: 'untruncated_full_name_retains',
      ok: parsed.ok === false && parsed.reason === 'name_not_exact_locked_truncation',
    });
  }

  {
    const short = {
      ...lockedConstraint(),
      name: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name.slice(0, -1),
    };
    const parsed = parseIdentifierTruncationNotNullMatch(short, provenance);
    red.push({
      name: 'wrong_length_near_collision_retains',
      ok: parsed.ok === false
        && (parsed.reason === 'name_not_exact_locked_truncation'
          || parsed.reason === 'name_length_mismatch'),
    });
  }

  {
    // Prove we do not accept prefix/startsWith matching.
    const prefixOnly = {
      ...lockedConstraint(),
      name: 'package_price_rules_double_supplement_per_person_per_n',
    };
    const parsed = parseIdentifierTruncationNotNullMatch(prefixOnly, provenance);
    const src = fs.readFileSync(
      path.join(ROOT, 'scripts', 'lib', 'sunset-schema-observer.js'),
      'utf8',
    );
    const truncFn = src.slice(
      src.indexOf('function parseIdentifierTruncationNotNullMatch'),
      src.indexOf('function normalizeIdentifierTruncationNotNull'),
    );
    // Strip comments so JSDoc mentioning "fuzzy" cannot false-fail the gate.
    const codeOnly = truncFn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    red.push({
      name: 'fuzzy_prefix_not_implemented_retains',
      ok: parsed.ok === false
        && parsed.reason === 'name_not_exact_locked_truncation'
        && /name !== tuple\.name/.test(codeOnly)
        && !/startsWith\(/.test(codeOnly)
        && !/\.includes\(/.test(codeOnly),
    });
  }

  {
    const bad002 = buildIdentifierTruncationNotNullProvenance({
      expectedMigration002Sha256: '0'.repeat(64),
    });
    red.push({
      name: 'migration_hash_change_fails',
      ok: bad002.ok === false && bad002.code === 'migration_002_hash_mismatch',
    });
  }

  {
    const parsed = parseCanonicalNotNullConstraint(lockedConstraint());
    red.push({
      name: 'fourteen_t_exact_name_rule_unchanged',
      ok: parsed.ok === false && parsed.reason === 'name_shape_mismatch',
    });
  }

  {
    // 14W still retains the truncation artifact (does not normalize it).
    const renameProv = buildFinalNotNullRenameProvenance();
    const norm = normalizeFinalNotNullRenameProvenance(
      fixture.expected,
      fixture.live,
      {
        profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
        azureContext: AZURE_CTX,
        serverVersionClass: 'postgresql_15',
        provenance: renameProv,
      },
    );
    red.push({
      name: 'fourteen_w_still_retains_truncation',
      ok: norm.ok === true
        && norm.normalizedCount === 0
        && (norm.constraints || []).some((c) => c.name === IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name),
    });
  }

  // ── GREEN normalize ──────────────────────────────────────────────
  {
    const raw = compareSnapshots(fixture.expected, fixture.live, compareOpts({
      identifierTruncationProvenance: provenance,
      enableIdentifierTruncationNormalization: false,
    }));
    const norm = compareSnapshots(fixture.expected, fixture.live, compareOpts({
      identifierTruncationProvenance: provenance,
    }));
    const rawNn = (raw.drifts || []).filter((d) => String(d.key).endsWith('.n')).length;
    const afterNn = (norm.drifts || []).filter((d) => String(d.key).endsWith('.n')).length;
    const normalizedCount = norm.identifierTruncationNormalization
      ? norm.identifierTruncationNormalization.normalizedCount
      : -1;
    green.push({
      name: 'one_truncation_normalizes_when_column_matches',
      ok: rawNn === 1
        && afterNn === 0
        && normalizedCount === 1
        && norm.identifierTruncationNormalization
        && norm.identifierTruncationNormalization.provenance
        && norm.identifierTruncationNormalization.provenance.rule === IDENTIFIER_TRUNCATION_RULE,
      detail: { rawNn, afterNn, normalizedCount },
    });
    green.push({
      name: 'raw_vs_normalized_compare_api',
      ok: raw.drifts.length - norm.drifts.length === 1
        && norm.identifierTruncationNormalization.provenance.migration002Sha256 === EXPECTED_002_SHA256,
    });
  }

  {
    const cmp = compareSnapshots(fixture.allExpected, fixture.allLive, compareOpts({
      identifierTruncationProvenance: provenance,
    }));
    const remaining = new Set((cmp.drifts || []).map((d) => d.key));
    green.push({
      name: 'negative_near_collisions_retain',
      ok: fixture.negativeKeys.every((k) => remaining.has(k))
        && fixture.positiveKeys.every((k) => !remaining.has(k))
        && cmp.identifierTruncationNormalization
        && cmp.identifierTruncationNormalization.normalizedCount === 1,
      detail: {
        remainingNegatives: fixture.negativeKeys.filter((k) => remaining.has(k)).length,
      },
    });
  }

  {
    const gateOk = evaluateIdentifierTruncationNormalizationGates({
      env: identifierTruncationNormalizationEnv(),
      argv: exactIdentifierTruncationNormalizationArgv(),
    });
    green.push({
      name: 'cli_gates_exact_targets',
      ok: gateOk.ok === true,
    });
  }

  {
    resetIdentifierTruncationNormalizationCounters();
    const refused = evaluateIdentifierTruncationNormalizationGates({ env: {}, argv: [] });
    green.push({
      name: 'cli_default_disabled',
      ok: refused.ok === false
        && PHASE_D_IDENTIFIER_TRUNCATION_NORMALIZATION_LIVE_ENABLED === true
        && getIdentifierTruncationNormalizationCounters().clientsInstantiated === 0,
    });
  }

  green.push({
    name: 'locks_identity_vault_secret_pg_tls_application_name',
    ok: IDENTIFIER_TRUNCATION_LOCKS.postgresHost === EXPECTED_HOST
      && IDENTIFIER_TRUNCATION_LOCKS.database === EXPECTED_DATABASE
      && IDENTIFIER_TRUNCATION_LOCKS.sslmode === 'verify-full'
      && APPLICATION_NAME === 'wh-sunset-identifier-truncation-normalization'
      && IDENTIFIER_TRUNCATION_LOCKS.applicationName === APPLICATION_NAME
      && IDENTIFIER_TRUNCATION_LOCKS.keyVaultName === 'luna-sunset-staging-kv'
      && IDENTIFIER_TRUNCATION_LOCKS.secretName === 'sunset-database-url',
  });

  green.push({
    name: 'global_live_apply_remains_false',
    ok: PHASE_D_LIVE_APPLY_ENABLED === false,
  });

  {
    const baseline = 1;
    const norm = compareSnapshots(fixture.expected, fixture.live, compareOpts({
      identifierTruncationProvenance: provenance,
    }));
    const normalized = norm.identifierTruncationNormalization.normalizedCount;
    const remaining = (norm.drifts || []).length;
    green.push({
      name: 'accounting_baseline_normalized_plus_remaining',
      ok: baseline === normalized + remaining && normalized === 1 && remaining === 0,
      detail: { baselineCount: baseline, normalized, remaining },
    });
  }

  {
    // Truncation default OFF: 14W-style compare must not apply 14X.
    const cmp = compareSnapshots(fixture.expected, fixture.live, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      enableFinalRenameNormalization: true,
    });
    green.push({
      name: 'truncation_default_off_preserves_14w',
      ok: cmp.identifierTruncationNormalization == null
        && (cmp.drifts || []).some((d) => d.key === fixture.positiveKeys[0]),
    });
  }

  let liveOutcome = null;
  let previousLive = null;
  if (fs.existsSync(EVIDENCE_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'));
      if (prev && prev.liveOutcome) previousLive = prev.liveOutcome;
    } catch (_) { /* ignore */ }
  }

  if (!wantLive) {
    resetIdentifierTruncationNormalizationCounters();
    const fakeDsn = buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
    const http = createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: fakeDsn,
    });
    const inj = await executeIdentifierTruncationNormalization({
      env: identifierTruncationNormalizationEnv(),
      argv: exactIdentifierTruncationNormalizationArgv(),
      httpRequest: http,
      skipPostgres: false,
      expectedContract: expected,
      injectedObserver: {
        code: 'identifier_truncation_normalization_injected',
        sessionReadOnly: true,
        transactionReadOnly: true,
        committed: true,
        serverVersionClass: { versionClass: 'postgresql_15', major: 15 },
        baselineMismatchCount: BASELINE_MISMATCH_COUNT,
        identifierTruncationsNormalized: 1,
        remainingMismatchCount: 11,
        remainingKeys: [
          'client_notification_events.idx_client_notification_events_client_created',
        ],
        accountingOk: BASELINE_MISMATCH_COUNT === 1 + 11,
        migration002Sha256: EXPECTED_002_SHA256,
        provenanceCount: 1,
        lockedTuple: provenance.lockedTuple,
        observerBefore: {
          mismatchCount: BASELINE_MISMATCH_COUNT,
          mismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
        },
        observerAfter: {
          mismatchCount: 11,
        },
        baseline: { ok: true, code: 'baseline_ok', mismatchCount: BASELINE_MISMATCH_COUNT },
        errors: [],
      },
    });
    leakScan(inj, secrets);
    green.push({
      name: 'offline_injected_authority_same_target',
      ok: inj.ok === true && inj.sameTarget === true && inj.realPostgresCall !== true,
      detail: { code: inj.code, sameTarget: inj.sameTarget, blocker: inj.blocker },
    });
  } else {
    resetIdentifierTruncationNormalizationCounters();
    const result = await executeIdentifierTruncationNormalization({
      env: {
        ...identifierTruncationNormalizationEnv(),
        ...process.env,
        [ENV_IDENTIFIER_TRUNCATION_NORMALIZATION]: '1',
      },
      argv: exactIdentifierTruncationNormalizationArgv(),
      expectedContract: expected,
    });
    leakScan(result, secrets);
    liveOutcome = {
      ok: result.ok === true,
      code: result.code,
      sameTarget: result.sameTarget === true,
      sessionReadOnly: result.sessionReadOnly === true,
      transactionReadOnly: result.transactionReadOnly === true,
      serverVersionClass: result.serverVersionClass || null,
      observerBefore: result.observerBefore || null,
      observerAfter: result.observerAfter || null,
      baseline: result.baseline || null,
      baselineMismatchCount: result.baselineMismatchCount,
      identifierTruncationsNormalized: result.identifierTruncationsNormalized,
      remainingMismatchCount: result.remainingMismatchCount,
      remainingKeys: result.remainingKeys || [],
      accountingOk: result.accountingOk === true,
      migration002Sha256: result.migration002Sha256,
      provenanceCount: result.provenanceCount,
      provenanceTuples: result.provenanceTuples || null,
      lockedTuple: result.lockedTuple || null,
      productFingerprintLive: result.productFingerprintLive,
      applicationName: result.applicationName || APPLICATION_NAME,
      httpRequestCount: result.httpRequestCount || 0,
      imdsRequestCount: result.imdsRequestCount || 0,
      keyVaultRequestCount: result.keyVaultRequestCount || 0,
      clientsInstantiated: result.clientsInstantiated || 0,
      connectCalls: result.connectCalls || 0,
      queryCalls: result.queryCalls || 0,
      endCalls: result.endCalls || 0,
      usedLiveHttp: result.usedLiveHttp === true,
      realPostgresCall: result.realPostgresCall === true,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      rbacMutation: false,
      networkMutation: false,
      firewallAction: false,
      committed: result.committed === true,
      rolledBack: result.rolledBack === true,
      closed: result.closed === true,
      postgresHost: IDENTIFIER_TRUNCATION_LOCKS.postgresHost,
      database: IDENTIFIER_TRUNCATION_LOCKS.database,
      sslmode: IDENTIFIER_TRUNCATION_LOCKS.sslmode,
      errors: result.errors || [],
      verifyNeverRerunsLive: true,
    };
    if (!(
      liveOutcome.ok
      && liveOutcome.sameTarget
      && liveOutcome.sessionReadOnly
      && liveOutcome.baselineMismatchCount === BASELINE_MISMATCH_COUNT
      && liveOutcome.accountingOk
      && liveOutcome.identifierTruncationsNormalized === 1
      && liveOutcome.liveMutation === false
    )) {
      throw new Error(`live outcome failed: ${JSON.stringify({
        ok: liveOutcome.ok,
        code: liveOutcome.code,
        baseline: liveOutcome.baselineMismatchCount,
        normalized: liveOutcome.identifierTruncationsNormalized,
        remaining: liveOutcome.remainingMismatchCount,
        accountingOk: liveOutcome.accountingOk,
        errors: liveOutcome.errors,
      })}`);
    }
  }

  const missingRed = REQUIRED_RED.filter((n) => !red.some((r) => r.name === n));
  const missingGreen = REQUIRED_GREEN.filter((n) => !green.some((g) => g.name === n));
  if (missingRed.length || missingGreen.length) {
    throw new Error(`missing cases red=${missingRed} green=${missingGreen}`);
  }
  const failedRed = red.filter((r) => !r.ok);
  const failedGreen = green.filter((g) => !g.ok);
  if (failedRed.length || failedGreen.length) {
    console.error('FAILED RED', failedRed);
    console.error('FAILED GREEN', failedGreen);
    throw new Error(`offline proof failed: red=${failedRed.length} green=${failedGreen.length}`);
  }

  const evidence = {
    kind: 'slice14x-identifier-truncation-normalization-evidence',
    slice: '14X',
    masterShaBasis: MASTER,
    applicationName: APPLICATION_NAME,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintExpected: CANON_FP,
    manifestHash: MANIFEST_HASH,
    migration002Sha256: EXPECTED_002_SHA256,
    baselineMismatchCountExpected: BASELINE_MISMATCH_COUNT,
    baselineMismatchSectionsExpected: { ...BASELINE_MISMATCH_SECTIONS },
    lockedTuple: {
      table: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.table,
      name: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.name,
      type: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.type,
      definition: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.definition,
      column: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.column,
      migrationId: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.migrationId,
      migrationSha256: IDENTIFIER_TRUNCATION_LOCKED_TUPLE.migrationSha256,
      nameByteLength: PG_MAX_IDENTIFIER_BYTES,
      derivedName: derived,
    },
    secretFree: true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    kvMutation: false,
    rbacMutation: false,
    networkMutation: false,
    offline: {
      red,
      green,
      positiveKeys: fixture.positiveKeys,
      negativeKeys: fixture.negativeKeys,
      provenanceTuples: provenance.tuples.map((t) => ({
        kind: t.kind,
        migrationId: t.migrationId,
        migrationSha256: t.migrationSha256,
        table: t.table,
        column: t.column,
        name: t.name,
        definition: t.definition,
        derivedName: t.derivedName,
        untruncatedName: t.untruncatedName,
        nameByteLength: t.nameByteLength,
      })),
    },
    liveOutcome: liveOutcome || previousLive || null,
    secretHandlingProof: {
      neverPrinted: true,
      neverPersisted: true,
      neverHashedIntoEvidence: true,
      neverInArgv: true,
      observerNeverPersistsDsn: true,
    },
    verifyNeverRerunsLive: true,
  };
  leakScan(evidence, secrets);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

  const contract = {
    kind: 'slice14x-identifier-truncation-normalization-contract',
    slice: '14X',
    masterShaBasis: MASTER,
    applicationName: APPLICATION_NAME,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintExpected: CANON_FP,
    manifestHash: MANIFEST_HASH,
    migration002Sha256: EXPECTED_002_SHA256,
    baselineMismatchCount: BASELINE_MISMATCH_COUNT,
    baselineMismatchSections: { ...BASELINE_MISMATCH_SECTIONS },
    lockedTuple: evidence.lockedTuple,
    requiredRed: REQUIRED_RED,
    requiredGreen: REQUIRED_GREEN,
    locks: {
      postgresHost: IDENTIFIER_TRUNCATION_LOCKS.postgresHost,
      database: IDENTIFIER_TRUNCATION_LOCKS.database,
      sslmode: IDENTIFIER_TRUNCATION_LOCKS.sslmode,
      applicationName: APPLICATION_NAME,
      containerAppName: IDENTIFIER_TRUNCATION_LOCKS.containerAppName,
      keyVaultName: IDENTIFIER_TRUNCATION_LOCKS.keyVaultName,
      secretName: IDENTIFIER_TRUNCATION_LOCKS.secretName,
    },
    gates: {
      envIdentifierTruncationNormalization: ENV_IDENTIFIER_TRUNCATION_NORMALIZATION,
      cliProve: CLI_PROVE_IDENTIFIER_TRUNCATION_NORMALIZATION,
      defaultDisabled: true,
      liveApplyRemainsFalse: true,
    },
    verifyNeverRerunsLive: true,
  };
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);

  const liveBlock = liveOutcome || previousLive;
  const findings = [
    '# FOUNDATION Slice 14X — NOT NULL identifier truncation normalization',
    '',
    `**Status:** ${liveBlock && liveBlock.ok ? 'identifier_truncation_normalization_live_ok' : 'offline_ok_awaiting_live'}`,
    `**Master basis:** \`${MASTER}\``,
    `**Canonical fingerprint (unchanged):** \`${CANON_FP}\``,
    `**Expected bytes (unchanged):** \`${EXPECTED_BYTE_SHA}\``,
    `**Migration 002 sha256 (locked):** \`${EXPECTED_002_SHA256}\``,
    '',
    '## What this slice does',
    '',
    'Conservative `azure_flexible_server_v1` + `postgresql_15` comparison normalization for',
    'exactly **one** PostgreSQL auto-generated NOT NULL identifier truncation artifact',
    '(extends 14T/14V/14W; default OFF):',
    '',
    `- application_name: \`${APPLICATION_NAME}\``,
    '',
    '- Locked tuple: `package_price_rules.package_price_rules_double_supplement_per_person_per_n_not_null`',
    '  (exact 63-byte NAMEDATALEN identifier), type=`n`,',
    '  definition=`NOT NULL double_supplement_per_person_per_night_cents`,',
    '  expected/live column nullable=NO; owner migration **002** hash-locked.',
    '- Derives observed name via PostgreSQL `makeObjectName(table_column, NULL, "not_null")`',
    '  label-preserving truncation; rejects every other truncated/near-collision name.',
    '- Does **not** implement fuzzy/general prefix matching.',
    '- Does **not** broaden 14T/14V/14W rules.',
    '',
    '## Offline gates',
    '',
    `- RED: ${REQUIRED_RED.length} cases`,
    `- GREEN: ${REQUIRED_GREEN.length} cases`,
    '- Provenance tuples: **1**',
    '- Positive artifacts: **1**',
    '',
  ];
  if (liveBlock) {
    findings.push(
      '## Live',
      '',
      `application_name: \`${APPLICATION_NAME}\``,
      `sameTarget: **${liveBlock.sameTarget === true}**`,
      `server version class: **${(liveBlock.serverVersionClass && liveBlock.serverVersionClass.versionClass) || 'unknown'}**`,
      `baseline mismatch (identity + 14T + 14V + 14W; truncation off): **${liveBlock.baselineMismatchCount}**`,
      `identifier truncations normalized: **${liveBlock.identifierTruncationsNormalized}**`,
      `remaining mismatch: **${liveBlock.remainingMismatchCount}**`,
      `remaining keys: ${JSON.stringify(liveBlock.remainingKeys || [])}`,
      'accounting: baseline === normalized + remaining (reported; not forced to a constant final count)',
      '',
      'Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.',
      '',
    );
  }
  findings.push(
    '## Do not claim',
    '',
    '- Do **not** claim Sunset fully repaired / database matches canonical.',
    '- Do **not** apply rename/NOT NULL DDL in this slice.',
    '- Do **not** run verify with `--live` (verify never re-runs live).',
    '- Do **not** modify expected-product-schema bytes/fingerprint or migrations.',
    '- Do **not** broaden 14T/14V/14W or add fuzzy prefix matching.',
    '',
    '## Operator live command',
    '',
    '```',
    'SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_IDENTIFIER_TRUNCATION_NORMALIZATION=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:identifier-truncation-normalization -- --prove-identifier-truncation-normalization --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity',
    '```',
    '',
    '## Artifacts',
    '',
    '- `fixtures/sunset-schema-observer/slice14x-identifier-truncation-normalization-evidence.json`',
    '- `fixtures/sunset-schema-observer/slice14x-identifier-truncation-normalization-contract.json`',
    '- `fixtures/sunset-schema-observer/slice14x-findings.md`',
    '',
  );
  fs.writeFileSync(FINDINGS_PATH, `${findings.join('\n')}\n`);

  console.log(`slice14x offline RED=${red.length} GREEN=${green.length} ok`);
  if (wantLive) {
    console.log(`slice14x live ok normalized=${liveOutcome.identifierTruncationsNormalized} remaining=${liveOutcome.remainingMismatchCount}`);
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
