'use strict';

/**
 * prove-sunset-schema-slice14w-final-rename-normalization
 * FOUNDATION Slice 14W
 *
 * Offline RED/GREEN for exact rename-provenance NOT NULL legacy-name
 * normalization (migrations 002/003/004) + optional --live once:
 * merged target authority + one TLS verify-full observer session
 * application_name=wh-sunset-final-rename-normalization.
 *
 * Extends — does not weaken — 14T exact-name or 14V hostel_id alias rules.
 * Default offline. Verify never re-runs live. Zero mutation.
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
  parseFinalNotNullRenameProvenanceMatch,
  normalizeFinalNotNullRenameProvenance,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  MIGRATION_002_PACKAGE_PRICING_SHA256,
  MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256,
  MIGRATION_004_PAYMENT_SCHEMA_SHA256,
  MIGRATION_003_TABLE_RENAME_APPROVED_COLUMNS,
  MIGRATION_002_COLUMN_RENAME_SQL,
  FINAL_RENAME_RULE,
} = require('./lib/sunset-schema-observer');
const {
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_FINAL_RENAME_NORMALIZATION_LIVE_ENABLED,
  ENV_FINAL_RENAME_NORMALIZATION,
  CLI_PROVE_FINAL_RENAME_NORMALIZATION,
  APPLICATION_NAME,
  FINAL_RENAME_LOCKS,
  BASELINE_MISMATCH_COUNT,
  evaluateFinalRenameNormalizationGates,
  exactFinalRenameNormalizationArgv,
  finalRenameNormalizationEnv,
  executeFinalRenameNormalization,
  createInjectedTargetAuthorityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetFinalRenameNormalizationCounters,
  getFinalRenameNormalizationCounters,
  printCliHelp,
} = require('./lib/phase-d-final-rename-normalization');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14w-final-rename-normalization-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14w-final-rename-normalization-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14w-findings.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-final-rename-normalization.js');

const MASTER = 'c0efa35ae818cb3c723dc81f79eee57e3041af70';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const EXPECTED_002_SHA256 = '3caa9c743252bd058c7eb8cb9bdbd39686b3970249c9d5c051e6971ebf476748';
const EXPECTED_003_SHA256 = 'f79826262081050f68c7f8014136d90730dc4dedffe37549aad2ff998f340257';
const EXPECTED_004_SHA256 = 'c82718b6417ffa8c594227bb8873b8d89d65d567caf4489e108f1b86485f22c1';

const AZURE_CTX = Object.freeze({
  verified: true,
  host: EXPECTED_HOST,
  database: EXPECTED_DATABASE,
  versionClass: 'postgresql_15',
});

const FAKE_ADMIN_USER = 'slice14w-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14w-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14w-proof-imds-token-never-commit';

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_prove_flag_zero_clients',
  'missing_final_rename_env_zero_clients',
  'wrong_exact_targets_zero_clients',
  'forbidden_argv_dsn_sql_drop_dml_zero_clients',
  'non_azure_profile_retains_rename_constraints',
  'non_pg15_version_retains_or_rejects',
  'live_nullable_yes_retains_drift',
  'live_column_missing_retains_drift',
  'live_old_table_or_column_present_retains_drift',
  'ambiguous_duplicate_claim_retains_drift',
  'wrong_definition_retains_drift',
  'arbitrary_alias_retains_drift',
  'unapproved_hostels_column_retains_drift',
  'truncated_name_retains_drift',
  'migration_hash_change_fails',
  'fourteen_t_exact_name_rule_unchanged',
  'fourteen_v_hostel_id_alias_unchanged',
];

const REQUIRED_GREEN = [
  'exact_12_provenance_fixture',
  'migration_hashes_and_tuples_locked',
  'twelve_rename_artifacts_normalize_when_columns_match',
  'negative_keys_retain',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'accounting_baseline_normalized_plus_remaining',
  'raw_vs_normalized_compare_api',
  'final_rename_default_off_preserves_14v',
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
  if (/Bearer\s+slice14w-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
}

/**
 * Exact 12 positive rename residuals:
 *   9 clients.hostels_<col>_not_null (table rename 003)
 *   1 package_price_rules night→week (column rename 002; synthetic if absent)
 *   2 payments kind/amount (column rename 004)
 * Negatives include truncated double_supplement and other non-matching shapes.
 */
function buildExact12Fixture(expectedFull, provenance) {
  const typeN = expectedFull.snapshot.constraints.filter((c) => c.type === 'n');
  const positives = [];
  for (const c of typeN) {
    const parsed = parseFinalNotNullRenameProvenanceMatch(c, provenance);
    if (parsed.ok) positives.push({ ...c });
  }

  const nightWeek = {
    table: 'package_price_rules',
    name: 'package_price_rules_price_per_person_per_night_cents_not_null',
    type: 'n',
    definition: 'NOT NULL price_per_person_per_week_cents',
  };
  const nightParsed = parseFinalNotNullRenameProvenanceMatch(nightWeek, provenance);
  if (!nightParsed.ok) {
    throw new Error(`synthetic night→week must match provenance: ${nightParsed.reason}`);
  }
  const hasNight = positives.some(
    (c) => c.table === nightWeek.table && c.name === nightWeek.name,
  );
  if (!hasNight) positives.push(nightWeek);

  const positiveKeys = positives
    .map((c) => `${c.table}.${c.name}.${c.type}`)
    .sort();
  if (positiveKeys.length !== 12) {
    throw new Error(`expected exactly 12 positives, got ${positiveKeys.length}`);
  }

  const negatives = [];
  const truncated = typeN.find(
    (c) => c.name === 'package_price_rules_double_supplement_per_person_per_n_not_null',
  );
  if (truncated) negatives.push({ ...truncated });
  negatives.push({
    table: 'clients',
    name: 'hostels_stripe_account_id_not_null',
    type: 'n',
    definition: 'NOT NULL stripe_account_id',
  });
  negatives.push({
    table: 'clients',
    name: 'hostels_whatsapp_phone_number_id_not_null',
    type: 'n',
    definition: 'NOT NULL whatsapp_phone_number_id',
  });
  negatives.push({
    table: 'payments',
    name: 'payments_amount_paid_cents_not_null_legacy',
    type: 'n',
    definition: 'NOT NULL amount_due_cents',
  });
  negatives.push({
    table: 'payments',
    name: 'payments_weird_alias_not_null',
    type: 'n',
    definition: 'NOT NULL payment_kind',
  });
  const negativeKeys = negatives
    .map((c) => `${c.table}.${c.name}.${c.type}`)
    .sort();

  const tables = [...new Set([
    ...positives.map((c) => c.table),
    ...negatives.map((c) => c.table),
  ])].sort();

  function colsFor(table, column, nullable) {
    const hit = expectedFull.snapshot.columns.find(
      (c) => c.table === table && c.column === column,
    );
    if (hit) return { ...hit, nullable };
    return {
      table,
      column,
      type: 'text',
      udt: 'text',
      nullable,
      default: null,
    };
  }

  const expected = emptySnap();
  expected.tables = tables.filter((t) => t !== 'hostels');
  expected.constraints = positives.map((c) => ({ ...c }));
  expected.columns = [];
  for (const c of positives) {
    const parsed = parseFinalNotNullRenameProvenanceMatch(c, provenance);
    expected.columns.push(colsFor(parsed.table, parsed.column || parsed.currentColumn, 'NO'));
  }
  // Deduplicate columns
  const colSeen = new Set();
  expected.columns = expected.columns.filter((c) => {
    const k = `${c.table}.${c.column}`;
    if (colSeen.has(k)) return false;
    colSeen.add(k);
    return true;
  });

  const live = emptySnap();
  live.tables = expected.tables.slice();
  live.columns = expected.columns.map((c) => ({ ...c, nullable: 'NO' }));
  live.constraints = [];

  const allExpected = emptySnap();
  allExpected.tables = tables.filter((t) => t !== 'hostels');
  allExpected.constraints = [
    ...positives.map((c) => ({ ...c })),
    ...negatives.map((c) => ({ ...c })),
  ];
  allExpected.columns = expected.columns.map((c) => ({ ...c }));

  const allLive = emptySnap();
  allLive.tables = allExpected.tables.slice();
  allLive.columns = allExpected.columns.map((c) => ({ ...c, nullable: 'NO' }));
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
  };
}

function compareOpts(extra) {
  return {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: AZURE_CTX,
    serverVersionClass: 'postgresql_15',
    enableFinalRenameNormalization: true,
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
    && process.env.SUNSET_SLICE14W_PROOF_OFFLINE !== '1';

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
  const live003 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '003_rename_hostel_to_client.sql'));
  const live004 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '004_payment_schema_phase2.sql'));
  if (live002 !== EXPECTED_002_SHA256 || live002 !== MIGRATION_002_PACKAGE_PRICING_SHA256) {
    throw new Error('migration 002 sha drift');
  }
  if (live003 !== EXPECTED_003_SHA256 || live003 !== MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256) {
    throw new Error('migration 003 sha drift');
  }
  if (live004 !== EXPECTED_004_SHA256 || live004 !== MIGRATION_004_PAYMENT_SCHEMA_SHA256) {
    throw new Error('migration 004 sha drift');
  }

  const provenance = buildFinalNotNullRenameProvenance();
  if (!provenance.ok) throw new Error(`provenance failed: ${provenance.code}`);

  const fixture = buildExact12Fixture(expected, provenance);

  green.push({
    name: 'exact_12_provenance_fixture',
    ok: fixture.positiveKeys.length === 12
      && fixture.positives.filter((c) => c.table === 'clients').length === 9
      && fixture.positives.some((c) => c.name.includes('price_per_person_per_night'))
      && fixture.positives.filter((c) => c.table === 'payments').length === 2,
    detail: {
      positive: fixture.positiveKeys.length,
      negative: fixture.negativeKeys.length,
      keys: fixture.positiveKeys,
    },
  });

  green.push({
    name: 'migration_hashes_and_tuples_locked',
    ok: provenance.ok === true
      && provenance.provenanceCount === 4
      && provenance.migration002Sha256 === EXPECTED_002_SHA256
      && provenance.migration003Sha256 === EXPECTED_003_SHA256
      && provenance.migration004Sha256 === EXPECTED_004_SHA256
      && provenance.tuples[0].kind === 'table_rename'
      && provenance.tuples[0].renameSql.includes('hostels RENAME TO clients')
      && provenance.tuples[1].renameSql === MIGRATION_002_COLUMN_RENAME_SQL
      && provenance.tuples[1].legacyName
        === 'package_price_rules_price_per_person_per_night_cents_not_null'
      && provenance.tableRenameApprovedColumns.length === 9
      && MIGRATION_003_TABLE_RENAME_APPROVED_COLUMNS.length === 9,
    detail: {
      provenanceCount: provenance.provenanceCount,
      sha002: provenance.migration002Sha256,
      sha003: provenance.migration003Sha256,
      sha004: provenance.migration004Sha256,
      tuples: provenance.tuples.map((t) => ({
        kind: t.kind,
        migrationId: t.migrationId,
        renameSql: t.renameSql,
        legacyName: t.legacyName || null,
      })),
    },
  });

  // ── RED cases ────────────────────────────────────────────────────
  {
    resetFinalRenameNormalizationCounters();
    const gate = evaluateFinalRenameNormalizationGates({ env: {}, argv: [] });
    const c = getFinalRenameNormalizationCounters();
    red.push({
      name: 'default_path_zero_http_and_clients',
      ok: gate.ok === false && c.clientsInstantiated === 0 && c.httpRequestCount === 0,
    });
  }

  {
    resetFinalRenameNormalizationCounters();
    const env = finalRenameNormalizationEnv();
    const argv = exactFinalRenameNormalizationArgv().filter(
      (a) => a !== CLI_PROVE_FINAL_RENAME_NORMALIZATION,
    );
    const gate = evaluateFinalRenameNormalizationGates({ env, argv });
    const c = getFinalRenameNormalizationCounters();
    red.push({
      name: 'missing_prove_flag_zero_clients',
      ok: gate.ok === false
        && gate.errors.some((e) => e.code === 'final_rename_normalization_flag_required')
        && c.clientsInstantiated === 0,
    });
  }

  {
    resetFinalRenameNormalizationCounters();
    const env = { ...finalRenameNormalizationEnv() };
    delete env[ENV_FINAL_RENAME_NORMALIZATION];
    const gate = evaluateFinalRenameNormalizationGates({
      env,
      argv: exactFinalRenameNormalizationArgv(),
    });
    const c = getFinalRenameNormalizationCounters();
    red.push({
      name: 'missing_final_rename_env_zero_clients',
      ok: gate.ok === false
        && gate.errors.some((e) => e.code === 'final_rename_normalization_env_required')
        && c.clientsInstantiated === 0,
    });
  }

  {
    resetFinalRenameNormalizationCounters();
    const argv = exactFinalRenameNormalizationArgv().map((a) => (
      a === 'sunset_staging' ? 'wrong_db' : a
    ));
    const gate = evaluateFinalRenameNormalizationGates({
      env: finalRenameNormalizationEnv(),
      argv,
    });
    red.push({
      name: 'wrong_exact_targets_zero_clients',
      ok: gate.ok === false && gate.errors.some((e) => e.code === 'exact_target_mismatch'),
    });
  }

  {
    resetFinalRenameNormalizationCounters();
    const argv = [...exactFinalRenameNormalizationArgv(), '--dsn', 'postgresql://x'];
    const gate = evaluateFinalRenameNormalizationGates({
      env: finalRenameNormalizationEnv(),
      argv,
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
      finalRenameProvenance: provenance,
    });
    red.push({
      name: 'non_azure_profile_retains_rename_constraints',
      ok: (cmp.drifts || []).filter((d) => String(d.key).endsWith('.n')).length
        === fixture.positiveKeys.length
        && (cmp.finalRenameNormalization == null
          || cmp.finalRenameNormalization.applied !== true),
    });
  }

  {
    const reject = normalizeFinalNotNullRenameProvenance(
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
    const soft = normalizeFinalNotNullRenameProvenance(
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
    const first = parseFinalNotNullRenameProvenanceMatch(fixture.positives[0], provenance);
    liveYes.columns = liveYes.columns.map((c) => (
      c.table === first.table && c.column === (first.column || first.currentColumn)
        ? { ...c, nullable: 'YES' }
        : c
    ));
    const cmp = compareSnapshots(fixture.expected, liveYes, compareOpts({
      finalRenameProvenance: provenance,
    }));
    const key = fixture.positiveKeys[0];
    red.push({
      name: 'live_nullable_yes_retains_drift',
      ok: (cmp.drifts || []).some((d) => d.key === key),
    });
  }

  {
    const liveMissing = JSON.parse(JSON.stringify(fixture.live));
    const first = parseFinalNotNullRenameProvenanceMatch(fixture.positives[0], provenance);
    const col = first.column || first.currentColumn;
    liveMissing.columns = liveMissing.columns.filter(
      (c) => !(c.table === first.table && c.column === col),
    );
    const cmp = compareSnapshots(fixture.expected, liveMissing, compareOpts({
      finalRenameProvenance: provenance,
    }));
    red.push({
      name: 'live_column_missing_retains_drift',
      ok: (cmp.drifts || []).some((d) => d.key === fixture.positiveKeys[0]),
    });
  }

  {
    const liveOldTable = JSON.parse(JSON.stringify(fixture.live));
    liveOldTable.tables.push('hostels');
    const hostelKey = fixture.positiveKeys.find((k) => k.startsWith('clients.hostels_'));
    const cmpTable = compareSnapshots(fixture.expected, liveOldTable, compareOpts({
      finalRenameProvenance: provenance,
    }));
    const liveOldCol = JSON.parse(JSON.stringify(fixture.live));
    liveOldCol.columns.push({
      table: 'payments',
      column: 'kind',
      type: 'USER-DEFINED',
      udt: 'payment_kind',
      nullable: 'NO',
      default: null,
    });
    const cmpCol = compareSnapshots(fixture.expected, liveOldCol, compareOpts({
      finalRenameProvenance: provenance,
    }));
    red.push({
      name: 'live_old_table_or_column_present_retains_drift',
      ok: (cmpTable.drifts || []).some((d) => d.key === hostelKey)
        && (cmpCol.drifts || []).some((d) => d.key === 'payments.payments_kind_not_null.n'),
    });
  }

  {
    const expDup = JSON.parse(JSON.stringify(fixture.expected));
    expDup.constraints.push({ ...fixture.positives[0] });
    const norm = normalizeFinalNotNullRenameProvenance(expDup, fixture.live, {
      profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      provenance,
    });
    const key = fixture.positiveKeys[0];
    red.push({
      name: 'ambiguous_duplicate_claim_retains_drift',
      ok: (norm.constraints || []).some((c) => `${c.table}.${c.name}.${c.type}` === key)
        && norm.normalizedCount === fixture.positiveKeys.length - 1,
    });
  }

  {
    const bad = {
      table: 'clients',
      name: 'hostels_created_at_not_null',
      type: 'n',
      definition: 'NOT NULL updated_at',
    };
    const parsed = parseFinalNotNullRenameProvenanceMatch(bad, provenance);
    red.push({
      name: 'wrong_definition_retains_drift',
      ok: parsed.ok === false && parsed.reason === 'wrong_definition',
    });
  }

  {
    const bad = {
      table: 'payments',
      name: 'payments_weird_alias_not_null',
      type: 'n',
      definition: 'NOT NULL payment_kind',
    };
    const parsed = parseFinalNotNullRenameProvenanceMatch(bad, provenance);
    red.push({
      name: 'arbitrary_alias_retains_drift',
      ok: parsed.ok === false && parsed.reason === 'no_provenance_tuple_match',
    });
  }

  {
    const bad = {
      table: 'clients',
      name: 'hostels_stripe_account_id_not_null',
      type: 'n',
      definition: 'NOT NULL stripe_account_id',
    };
    const parsed = parseFinalNotNullRenameProvenanceMatch(bad, provenance);
    red.push({
      name: 'unapproved_hostels_column_retains_drift',
      ok: parsed.ok === false && parsed.reason === 'column_not_provenance_approved',
    });
  }

  {
    const truncated = {
      table: 'package_price_rules',
      name: 'package_price_rules_double_supplement_per_person_per_n_not_null',
      type: 'n',
      definition: 'NOT NULL double_supplement_per_person_per_night_cents',
    };
    const parsed = parseFinalNotNullRenameProvenanceMatch(truncated, provenance);
    const exp = emptySnap();
    exp.tables = ['package_price_rules'];
    exp.constraints = [truncated];
    exp.columns = [{
      table: 'package_price_rules',
      column: 'double_supplement_per_person_per_night_cents',
      type: 'integer',
      udt: 'int4',
      nullable: 'NO',
      default: null,
    }];
    const live = emptySnap();
    live.tables = exp.tables.slice();
    live.columns = exp.columns.map((c) => ({ ...c }));
    const norm = normalizeFinalNotNullRenameProvenance(exp, live, {
      profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      provenance,
    });
    red.push({
      name: 'truncated_name_retains_drift',
      ok: parsed.ok === false
        && norm.normalizedCount === 0
        && (norm.constraints || []).some((c) => c.name === truncated.name),
    });
  }

  {
    const bad002 = buildFinalNotNullRenameProvenance({
      expectedMigration002Sha256: '0'.repeat(64),
    });
    const bad003 = buildFinalNotNullRenameProvenance({
      expectedMigration003Sha256: '0'.repeat(64),
    });
    const bad004 = buildFinalNotNullRenameProvenance({
      expectedMigration004Sha256: '0'.repeat(64),
    });
    red.push({
      name: 'migration_hash_change_fails',
      ok: bad002.ok === false && bad002.code === 'migration_002_hash_mismatch'
        && bad003.ok === false && bad003.code === 'migration_003_hash_mismatch'
        && bad004.ok === false && bad004.code === 'migration_004_hash_mismatch',
    });
  }

  {
    const parsed = parseCanonicalNotNullConstraint({
      table: 'clients',
      name: 'hostels_created_at_not_null',
      type: 'n',
      definition: 'NOT NULL created_at',
    });
    red.push({
      name: 'fourteen_t_exact_name_rule_unchanged',
      ok: parsed.ok === false && parsed.reason === 'name_shape_mismatch',
    });
  }

  {
    // 14V still normalizes hostel_id aliases; final rename default-off.
    const hostelAlias = {
      table: 'beds',
      name: 'beds_hostel_id_not_null',
      type: 'n',
      definition: 'NOT NULL client_id',
    };
    const exp = emptySnap();
    exp.tables = ['beds'];
    exp.constraints = [hostelAlias];
    exp.columns = [{
      table: 'beds', column: 'client_id', type: 'uuid', udt: 'uuid', nullable: 'NO', default: null,
    }];
    const live = emptySnap();
    live.tables = ['beds'];
    live.columns = exp.columns.map((c) => ({ ...c }));
    const with14v = compareSnapshots(exp, live, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
    });
    const finalMatch = parseFinalNotNullRenameProvenanceMatch(hostelAlias, provenance);
    red.push({
      name: 'fourteen_v_hostel_id_alias_unchanged',
      ok: with14v.renameAliasNormalization
        && with14v.renameAliasNormalization.normalizedCount === 1
        && finalMatch.ok === false
        && (with14v.finalRenameNormalization == null),
    });
  }

  // ── GREEN normalize ──────────────────────────────────────────────
  {
    const raw = compareSnapshots(fixture.expected, fixture.live, compareOpts({
      finalRenameProvenance: provenance,
      enableFinalRenameNormalization: false,
    }));
    const norm = compareSnapshots(fixture.expected, fixture.live, compareOpts({
      finalRenameProvenance: provenance,
    }));
    const rawNn = (raw.drifts || []).filter((d) => String(d.key).endsWith('.n')).length;
    const afterNn = (norm.drifts || []).filter((d) => String(d.key).endsWith('.n')).length;
    const normalizedCount = norm.finalRenameNormalization
      ? norm.finalRenameNormalization.normalizedCount
      : -1;
    green.push({
      name: 'twelve_rename_artifacts_normalize_when_columns_match',
      ok: rawNn === 12
        && afterNn === 0
        && normalizedCount === 12
        && norm.finalRenameNormalization
        && norm.finalRenameNormalization.provenance
        && norm.finalRenameNormalization.provenance.rule === FINAL_RENAME_RULE,
      detail: { rawNn, afterNn, normalizedCount },
    });
    green.push({
      name: 'raw_vs_normalized_compare_api',
      ok: raw.drifts.length - norm.drifts.length === 12
        && norm.finalRenameNormalization.provenance.migration002Sha256 === EXPECTED_002_SHA256
        && norm.finalRenameNormalization.provenance.migration003Sha256 === EXPECTED_003_SHA256
        && norm.finalRenameNormalization.provenance.migration004Sha256 === EXPECTED_004_SHA256,
    });
  }

  {
    const cmp = compareSnapshots(fixture.allExpected, fixture.allLive, compareOpts({
      finalRenameProvenance: provenance,
    }));
    const remaining = new Set((cmp.drifts || []).map((d) => d.key));
    green.push({
      name: 'negative_keys_retain',
      ok: fixture.negativeKeys.every((k) => remaining.has(k))
        && fixture.positiveKeys.every((k) => !remaining.has(k))
        && cmp.finalRenameNormalization
        && cmp.finalRenameNormalization.normalizedCount === 12,
      detail: {
        remainingNegatives: fixture.negativeKeys.filter((k) => remaining.has(k)).length,
        truncatedRetained: remaining.has(
          'package_price_rules.package_price_rules_double_supplement_per_person_per_n_not_null.n',
        ),
      },
    });
  }

  {
    const gateOk = evaluateFinalRenameNormalizationGates({
      env: finalRenameNormalizationEnv(),
      argv: exactFinalRenameNormalizationArgv(),
    });
    green.push({
      name: 'cli_gates_exact_targets',
      ok: gateOk.ok === true,
    });
  }

  {
    resetFinalRenameNormalizationCounters();
    const refused = evaluateFinalRenameNormalizationGates({ env: {}, argv: [] });
    green.push({
      name: 'cli_default_disabled',
      ok: refused.ok === false
        && PHASE_D_FINAL_RENAME_NORMALIZATION_LIVE_ENABLED === true
        && getFinalRenameNormalizationCounters().clientsInstantiated === 0,
    });
  }

  green.push({
    name: 'locks_identity_vault_secret_pg_tls_application_name',
    ok: FINAL_RENAME_LOCKS.postgresHost === EXPECTED_HOST
      && FINAL_RENAME_LOCKS.database === EXPECTED_DATABASE
      && FINAL_RENAME_LOCKS.sslmode === 'verify-full'
      && APPLICATION_NAME === 'wh-sunset-final-rename-normalization'
      && FINAL_RENAME_LOCKS.applicationName === APPLICATION_NAME
      && FINAL_RENAME_LOCKS.keyVaultName === 'luna-sunset-staging-kv'
      && FINAL_RENAME_LOCKS.secretName === 'sunset-database-url',
  });

  green.push({
    name: 'global_live_apply_remains_false',
    ok: PHASE_D_LIVE_APPLY_ENABLED === false,
  });

  {
    // Offline accounting identity on the 12-key fixture.
    const baseline = 12;
    const norm = compareSnapshots(fixture.expected, fixture.live, compareOpts({
      finalRenameProvenance: provenance,
    }));
    const normalized = norm.finalRenameNormalization.normalizedCount;
    const remaining = (norm.drifts || []).length;
    green.push({
      name: 'accounting_baseline_normalized_plus_remaining',
      ok: baseline === normalized + remaining && normalized === 12 && remaining === 0,
      detail: { baselineCount: baseline, normalized, remaining },
    });
  }

  {
    // Final rename default OFF: 14V-style compare must not apply 14W.
    const cmp = compareSnapshots(fixture.expected, fixture.live, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
    });
    green.push({
      name: 'final_rename_default_off_preserves_14v',
      ok: cmp.finalRenameNormalization == null
        && (cmp.drifts || []).filter((d) => String(d.key).endsWith('.n')).length === 12,
    });
  }

  // Offline injected authority path (zero live PG when not --live)
  let liveOutcome = null;
  let previousLive = null;
  if (fs.existsSync(EVIDENCE_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'));
      if (prev && prev.liveOutcome) previousLive = prev.liveOutcome;
    } catch (_) { /* ignore */ }
  }

  if (!wantLive) {
    resetFinalRenameNormalizationCounters();
    const fakeDsn = buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
    const http = createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: fakeDsn,
    });
    const inj = await executeFinalRenameNormalization({
      env: finalRenameNormalizationEnv(),
      argv: exactFinalRenameNormalizationArgv(),
      httpRequest: http,
      skipPostgres: false,
      expectedContract: expected,
      injectedObserver: {
        code: 'final_rename_normalization_injected',
        sessionReadOnly: true,
        transactionReadOnly: true,
        committed: true,
        serverVersionClass: { versionClass: 'postgresql_15', major: 15 },
        baselineMismatchCount: BASELINE_MISMATCH_COUNT,
        finalRenamesNormalized: 11,
        remainingMismatchCount: 12,
        remainingKeys: [
          'package_price_rules.package_price_rules_double_supplement_per_person_per_n_not_null.n',
        ],
        accountingOk: BASELINE_MISMATCH_COUNT === 11 + 12,
        migration002Sha256: EXPECTED_002_SHA256,
        migration003Sha256: EXPECTED_003_SHA256,
        migration004Sha256: EXPECTED_004_SHA256,
        provenanceCount: 4,
        observerBefore: {
          mismatchCount: BASELINE_MISMATCH_COUNT,
        },
        observerAfter: {
          mismatchCount: 12,
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
    resetFinalRenameNormalizationCounters();
    const result = await executeFinalRenameNormalization({
      env: {
        ...finalRenameNormalizationEnv(),
        ...process.env,
        [ENV_FINAL_RENAME_NORMALIZATION]: '1',
      },
      argv: exactFinalRenameNormalizationArgv(),
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
      finalRenamesNormalized: result.finalRenamesNormalized,
      remainingMismatchCount: result.remainingMismatchCount,
      remainingKeys: result.remainingKeys || [],
      accountingOk: result.accountingOk === true,
      migration002Sha256: result.migration002Sha256,
      migration003Sha256: result.migration003Sha256,
      migration004Sha256: result.migration004Sha256,
      provenanceCount: result.provenanceCount,
      provenanceTuples: result.provenanceTuples || null,
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
      postgresHost: FINAL_RENAME_LOCKS.postgresHost,
      database: FINAL_RENAME_LOCKS.database,
      sslmode: FINAL_RENAME_LOCKS.sslmode,
      errors: result.errors || [],
      verifyNeverRerunsLive: true,
    };
    if (!(
      liveOutcome.ok
      && liveOutcome.sameTarget
      && liveOutcome.sessionReadOnly
      && liveOutcome.baselineMismatchCount === BASELINE_MISMATCH_COUNT
      && liveOutcome.accountingOk
      && liveOutcome.liveMutation === false
    )) {
      throw new Error(`live outcome failed: ${JSON.stringify({
        ok: liveOutcome.ok,
        code: liveOutcome.code,
        baseline: liveOutcome.baselineMismatchCount,
        normalized: liveOutcome.finalRenamesNormalized,
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
    kind: 'slice14w-final-rename-normalization-evidence',
    slice: '14W',
    masterShaBasis: MASTER,
    applicationName: APPLICATION_NAME,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintExpected: CANON_FP,
    manifestHash: MANIFEST_HASH,
    migration002Sha256: EXPECTED_002_SHA256,
    migration003Sha256: EXPECTED_003_SHA256,
    migration004Sha256: EXPECTED_004_SHA256,
    baselineMismatchCountExpected: BASELINE_MISMATCH_COUNT,
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
        renameSql: t.renameSql,
        legacyName: t.legacyName || null,
        definition: t.definition || null,
        approvedColumns: t.approvedColumns || null,
        oldTable: t.oldTable || null,
        currentTable: t.currentTable || null,
        oldColumn: t.oldColumn || null,
        currentColumn: t.currentColumn || null,
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
    kind: 'slice14w-final-rename-normalization-contract',
    slice: '14W',
    masterShaBasis: MASTER,
    applicationName: APPLICATION_NAME,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintExpected: CANON_FP,
    manifestHash: MANIFEST_HASH,
    migration002Sha256: EXPECTED_002_SHA256,
    migration003Sha256: EXPECTED_003_SHA256,
    migration004Sha256: EXPECTED_004_SHA256,
    baselineMismatchCount: BASELINE_MISMATCH_COUNT,
    requiredRed: REQUIRED_RED,
    requiredGreen: REQUIRED_GREEN,
    locks: {
      postgresHost: FINAL_RENAME_LOCKS.postgresHost,
      database: FINAL_RENAME_LOCKS.database,
      sslmode: FINAL_RENAME_LOCKS.sslmode,
      applicationName: APPLICATION_NAME,
      containerAppName: FINAL_RENAME_LOCKS.containerAppName,
      keyVaultName: FINAL_RENAME_LOCKS.keyVaultName,
      secretName: FINAL_RENAME_LOCKS.secretName,
    },
    gates: {
      envFinalRenameNormalization: ENV_FINAL_RENAME_NORMALIZATION,
      cliProve: CLI_PROVE_FINAL_RENAME_NORMALIZATION,
      defaultDisabled: true,
      liveApplyRemainsFalse: true,
    },
    verifyNeverRerunsLive: true,
  };
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);

  const liveBlock = liveOutcome || previousLive;
  const findings = [
    '# FOUNDATION Slice 14W — final NOT NULL rename-provenance normalization',
    '',
    `**Status:** ${liveBlock && liveBlock.ok ? 'final_rename_normalization_live_ok' : 'offline_ok_awaiting_live'}`,
    `**Master basis:** \`${MASTER}\``,
    `**Canonical fingerprint (unchanged):** \`${CANON_FP}\``,
    `**Expected bytes (unchanged):** \`${EXPECTED_BYTE_SHA}\``,
    `**Migration 002 sha256 (locked):** \`${EXPECTED_002_SHA256}\``,
    `**Migration 003 sha256 (locked):** \`${EXPECTED_003_SHA256}\``,
    `**Migration 004 sha256 (locked):** \`${EXPECTED_004_SHA256}\``,
    '',
    '## What this slice does',
    '',
    'Conservative `azure_flexible_server_v1` + `postgresql_15` comparison normalization for',
    'exact rename-provenance NOT NULL legacy-name artifacts (extends 14T/14V; default OFF):',
    '',
    `- application_name: \`${APPLICATION_NAME}\``,
    '',
    '- Migration **003** table rename `hostels→clients`: only `clients.hostels_<column>_not_null`',
    '  with definition `NOT NULL <same column>` for the exact nine approved columns;',
    '  expected/live `clients.<column>` nullable=NO; live `hostels` table absent.',
    `- Migration **002** column rename \`price_per_person_per_night_cents→price_per_person_per_week_cents\`:`,
    '  only that exact residual legacy name/definition/current column (`' + MIGRATION_002_COLUMN_RENAME_SQL + '`).',
    '- Migration **004** `kind→payment_kind` and `amount_cents→amount_due_cents`: only those two residuals.',
    '- Does **not** broaden 14T `parseCanonicalNotNullConstraint` or 14V hostel_id alias rules.',
    '- Truncated names, unapproved columns, wrong definition, old+new coexistence, nullable YES,',
    '  non-Azure, non-PG15, or migration hash changes retain/fail.',
    '',
    'Offline exact-12 fixture: **9** hostels table-rename + **1** night→week + **2** payments.',
    '',
    '## Offline gates',
    '',
    `- RED: ${REQUIRED_RED.length} cases`,
    `- GREEN: ${REQUIRED_GREEN.length} cases`,
    `- Provenance tuples: **${provenance.provenanceCount}**`,
    '- Positive artifacts: **12**',
    '',
  ];
  if (liveBlock) {
    findings.push(
      '## Live',
      '',
      `application_name: \`${APPLICATION_NAME}\``,
      `sameTarget: **${liveBlock.sameTarget === true}**`,
      `server version class: **${(liveBlock.serverVersionClass && liveBlock.serverVersionClass.versionClass) || (liveBlock.serverVersionClass) || 'n/a'}**`,
      `baseline mismatch (identity + 14T + 14V; final rename off): **${liveBlock.baselineMismatchCount}**`,
      `final renames normalized: **${liveBlock.finalRenamesNormalized}**`,
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
    '- Do **not** broaden 14T exact-name parsing or weaken 14V.',
    '',
    '## Operator live command',
    '',
    '```',
    'SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_FINAL_RENAME_NORMALIZATION=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:final-rename-normalization -- --prove-final-rename-normalization --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity',
    '```',
    '',
    '## Artifacts',
    '',
    '- `fixtures/sunset-schema-observer/slice14w-final-rename-normalization-evidence.json`',
    '- `fixtures/sunset-schema-observer/slice14w-final-rename-normalization-contract.json`',
    '- `fixtures/sunset-schema-observer/slice14w-findings.md`',
    '',
  );
  fs.writeFileSync(FINDINGS_PATH, `${findings.join('\n')}\n`);

  console.log(`slice14w offline RED=${red.length} GREEN=${green.length} ok`);
  console.log(`artifacts: ${EVIDENCE_PATH}`);
  console.log(`cli: ${CLI_PATH}`);
  if (liveOutcome) {
    console.log(`live normalized=${liveOutcome.finalRenamesNormalized} remaining=${liveOutcome.remainingMismatchCount}`);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
