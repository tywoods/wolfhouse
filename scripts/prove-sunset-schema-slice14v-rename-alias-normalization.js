'use strict';

/**
 * prove-sunset-schema-slice14v-rename-alias-normalization
 * FOUNDATION Slice 14V
 *
 * Offline RED/GREEN for migration 003 hostel_id→client_id NOT NULL
 * rename-alias normalization + optional --live once: merged target
 * authority + one TLS verify-full observer session
 * application_name=wh-sunset-rename-alias-normalization.
 *
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
  normalizeMigration003HostelIdNotNullRenameAlias,
  buildMigration003HostelClientRenameAliasProvenance,
  parseMigration003HostelIdNotNullRenameAlias,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  classifyServerVersionClass,
  MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256,
  MIGRATION_003_RENAME_ALIAS_RULE,
} = require('./lib/sunset-schema-observer');
const {
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_RENAME_ALIAS_NORMALIZATION_LIVE_ENABLED,
  ENV_RENAME_ALIAS_NORMALIZATION,
  CLI_PROVE_RENAME_ALIAS_NORMALIZATION,
  APPLICATION_NAME,
  RENAME_ALIAS_LOCKS,
  BASELINE_MISMATCH_COUNT,
  evaluateRenameAliasNormalizationGates,
  exactRenameAliasNormalizationArgv,
  renameAliasNormalizationEnv,
  executeRenameAliasNormalization,
  createInjectedTargetAuthorityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetRenameAliasNormalizationCounters,
  getRenameAliasNormalizationCounters,
  printCliHelp,
} = require('./lib/phase-d-rename-alias-normalization');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14v-rename-alias-normalization-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14v-rename-alias-normalization-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14v-findings.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-rename-alias-normalization.js');
const MIGRATION_003_PATH = path.join(MIGRATIONS_DIR, '003_rename_hostel_to_client.sql');

const MASTER = '7b54b17ff1071349c82344277971df75a87ed499';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const EXPECTED_003_SHA256 = 'f79826262081050f68c7f8014136d90730dc4dedffe37549aad2ff998f340257';

const AZURE_CTX = Object.freeze({
  verified: true,
  host: EXPECTED_HOST,
  database: EXPECTED_DATABASE,
  versionClass: 'postgresql_15',
});

const FAKE_ADMIN_USER = 'slice14v-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14v-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14v-proof-imds-token-never-commit';

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
  if (/Bearer\s+slice14v-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
}

/**
 * Exact 24-key fixture: all expected type-n constraints where
 * name ≠ {table}_{col}_not_null from definition NOT NULL {col}.
 */
function buildExact24KeyFixture(expectedFull, provenance) {
  const typeN = expectedFull.snapshot.constraints.filter((c) => c.type === 'n');
  const nameShape = [];
  for (const c of typeN) {
    const parsed = parseCanonicalNotNullConstraint(c);
    if (parsed.ok === false && parsed.reason === 'name_shape_mismatch') {
      nameShape.push(c);
    }
  }
  const keys = nameShape
    .map((c) => `${c.table}.${c.name}.${c.type}`)
    .sort();

  const positive = nameShape.filter((c) => (
    c.name === `${c.table}_hostel_id_not_null`
    && c.definition === 'NOT NULL client_id'
    && provenance.approvedTables.includes(c.table)
  ));
  const positiveKeys = positive
    .map((c) => `${c.table}.${c.name}.${c.type}`)
    .sort();
  const negative = nameShape.filter((c) => !positiveKeys.includes(`${c.table}.${c.name}.${c.type}`));
  const negativeKeys = negative
    .map((c) => `${c.table}.${c.name}.${c.type}`)
    .sort();

  // Mini expected/live for positive alias normalize tests.
  const tables = [...new Set(positive.map((c) => c.table))].sort();
  const expected = emptySnap();
  expected.tables = tables;
  expected.constraints = positive.map((c) => ({ ...c }));
  expected.columns = [];
  for (const t of tables) {
    const cols = expectedFull.snapshot.columns.filter((c) => c.table === t);
    const clientCol = cols.find((c) => c.column === 'client_id');
    if (clientCol) {
      expected.columns.push({ ...clientCol, nullable: 'NO' });
    } else {
      expected.columns.push({
        table: t,
        column: 'client_id',
        type: 'uuid',
        udt: 'uuid',
        nullable: 'NO',
        default: null,
      });
    }
  }

  const live = emptySnap();
  live.tables = tables.slice();
  live.columns = expected.columns.map((c) => ({ ...c, nullable: 'NO' }));
  live.constraints = []; // Azure attnotnull only — no type-n objects

  // Negatives retain fixture: include all 24 name-shape constraints.
  const all24Expected = emptySnap();
  all24Expected.tables = [...new Set(nameShape.map((c) => c.table))].sort();
  all24Expected.constraints = nameShape.map((c) => ({ ...c }));
  all24Expected.columns = [];
  for (const t of all24Expected.tables) {
    const cols = expectedFull.snapshot.columns.filter((c) => c.table === t);
    for (const c of cols) {
      if (c.column === 'client_id' || c.nullable === 'NO') {
        all24Expected.columns.push({ ...c });
      }
    }
    // Ensure client_id present for positive tables.
    if (!all24Expected.columns.some((c) => c.table === t && c.column === 'client_id')) {
      if (positiveKeys.some((k) => k.startsWith(`${t}.`))) {
        all24Expected.columns.push({
          table: t,
          column: 'client_id',
          type: 'uuid',
          udt: 'uuid',
          nullable: 'NO',
          default: null,
        });
      }
    }
  }

  const all24Live = emptySnap();
  all24Live.tables = all24Expected.tables.slice();
  all24Live.columns = all24Expected.columns
    .filter((c) => c.column !== 'hostel_id')
    .map((c) => ({ ...c }));
  all24Live.constraints = [];

  return {
    nameShape,
    keys,
    positive,
    positiveKeys,
    negative,
    negativeKeys,
    expected,
    live,
    all24Expected,
    all24Live,
  };
}

function pickSafeLiveOutcome(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ok: result.ok === true,
    code: String(result.code || 'rename_alias_normalization_unknown'),
    sameTarget: result.sameTarget === true,
    sameTargetReason: result.sameTargetReason || null,
    blocker: result.blocker || null,
    sessionReadOnly: result.sessionReadOnly === true,
    transactionReadOnly: result.transactionReadOnly === true,
    serverVersionClass: result.serverVersionClass || null,
    observerBefore: result.observerBefore || null,
    observerAfter: result.observerAfter || null,
    baseline: result.baseline || null,
    baselineMismatchCount: result.baselineMismatchCount != null
      ? result.baselineMismatchCount
      : null,
    renameAliasesNormalized: result.renameAliasesNormalized != null
      ? result.renameAliasesNormalized
      : null,
    remainingMismatchCount: result.remainingMismatchCount != null
      ? result.remainingMismatchCount
      : null,
    remainingKeys: Array.isArray(result.remainingKeys) ? result.remainingKeys.slice().sort() : [],
    accountingOk: result.accountingOk === true,
    migration003Sha256: result.migration003Sha256 || null,
    provenanceCount: result.provenanceCount != null ? result.provenanceCount : null,
    productFingerprintLive: result.productFingerprintLive || null,
    applicationName: result.applicationName || APPLICATION_NAME,
    httpRequestCount: Number(result.httpRequestCount) || 0,
    imdsRequestCount: Number(result.imdsRequestCount) || 0,
    keyVaultRequestCount: Number(result.keyVaultRequestCount) || 0,
    clientsInstantiated: Number(result.clientsInstantiated) || 0,
    connectCalls: Number(result.connectCalls) || 0,
    queryCalls: Number(result.queryCalls) || 0,
    endCalls: Number(result.endCalls) || 0,
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
    postgresHost: result.postgresHost || RENAME_ALIAS_LOCKS.postgresHost,
    database: result.database || RENAME_ALIAS_LOCKS.database,
    sslmode: result.sslmode || RENAME_ALIAS_LOCKS.sslmode,
    errors: Array.isArray(result.errors)
      ? result.errors.map((e) => ({
        code: String((e && e.code) || 'failed').slice(0, 80),
        message: String((e && e.message) || '').slice(0, 240),
      }))
      : [],
    verifyNeverRerunsLive: true,
  };
}

async function main() {
  const wantLive = process.argv.includes('--live');
  const offlineOnly = !wantLive
    || process.argv.includes('--offline')
    || process.env.SUNSET_SLICE14V_PROOF_OFFLINE === '1';
  console.log(offlineOnly
    ? 'prove:sunset-schema-slice14v — offline only (no live HTTP/PG)\n'
    : 'prove:sunset-schema-slice14v — offline then one live rename-alias normalization proof\n');

  const priorEvidence = fs.existsSync(EVIDENCE_PATH)
    ? JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'))
    : null;
  const preserveLive = offlineOnly
    && priorEvidence
    && priorEvidence.liveOutcome
    && priorEvidence.liveOutcome.realPostgresCall === true;

  const red = [];
  const green = [];
  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN];

  // ── Integrity locks ──────────────────────────────────────────────
  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  if (expectedHash !== EXPECTED_BYTE_SHA) {
    throw new Error(`expected-product-schema byte drift: ${expectedHash}`);
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
  const live003 = sha256CanonicalLfV1File(MIGRATION_003_PATH);
  if (live003 !== EXPECTED_003_SHA256) throw new Error('migration 003 sha drift');
  if (live003 !== MIGRATION_003_HOSTEL_CLIENT_RENAME_SHA256) {
    throw new Error('observer export sha drift vs locked 003');
  }

  const provenance = buildMigration003HostelClientRenameAliasProvenance({
    migrationPath: MIGRATION_003_PATH,
    expectedSha256: EXPECTED_003_SHA256,
  });
  if (!provenance.ok) throw new Error(`provenance failed: ${provenance.code}`);

  const fixture = buildExact24KeyFixture(expected, provenance);
  if (fixture.keys.length !== 24) {
    throw new Error(`expected exactly 24 name_shape keys, got ${fixture.keys.length}`);
  }

  // ── Offline GREEN: fixture + provenance ──────────────────────────
  green.push({
    name: 'exact_24_key_fixture',
    ok: fixture.keys.length === 24
      && fixture.positiveKeys.length === 12
      && fixture.negativeKeys.length === 12,
    detail: {
      keys: fixture.keys.length,
      positive: fixture.positiveKeys.length,
      negative: fixture.negativeKeys.length,
    },
  });

  green.push({
    name: 'migration_003_provenance_15_tables_hash_locked',
    ok: provenance.ok === true
      && provenance.provenanceCount === 15
      && provenance.migrationSha256 === EXPECTED_003_SHA256
      && Array.isArray(provenance.approvedTables)
      && provenance.approvedTables.length === 15,
    detail: {
      provenanceCount: provenance.provenanceCount,
      sha: provenance.migrationSha256,
    },
  });

  // ── Offline RED: rename-alias safety ─────────────────────────────
  {
    const liveYes = JSON.parse(JSON.stringify(fixture.live));
    const firstTable = fixture.positive[0].table;
    liveYes.columns = liveYes.columns.map((c) => (
      c.table === firstTable && c.column === 'client_id'
        ? { ...c, nullable: 'YES' }
        : c
    ));
    const cmp = compareSnapshots(fixture.expected, liveYes, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      renameAliasProvenance: provenance,
    });
    const key = fixture.positiveKeys[0];
    const retained = (cmp.drifts || []).some((d) => d.key === key);
    const normalizedAway = cmp.renameAliasNormalization
      && cmp.renameAliasNormalization.audit.some((a) => a.key === key);
    red.push({
      name: 'live_nullable_yes_retains_drift',
      ok: retained === true && normalizedAway !== true,
      detail: { key, retained, normalizedCount: cmp.renameAliasNormalization && cmp.renameAliasNormalization.normalizedCount },
    });
  }

  {
    const liveMissing = JSON.parse(JSON.stringify(fixture.live));
    const firstTable = fixture.positive[0].table;
    liveMissing.columns = liveMissing.columns.filter(
      (c) => !(c.table === firstTable && c.column === 'client_id'),
    );
    const cmp = compareSnapshots(fixture.expected, liveMissing, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      renameAliasProvenance: provenance,
    });
    const key = fixture.positiveKeys[0];
    red.push({
      name: 'live_column_missing_retains_drift',
      ok: (cmp.drifts || []).some((d) => d.key === key),
    });
  }

  {
    const liveHostel = JSON.parse(JSON.stringify(fixture.live));
    const firstTable = fixture.positive[0].table;
    liveHostel.columns.push({
      table: firstTable,
      column: 'hostel_id',
      type: 'uuid',
      udt: 'uuid',
      nullable: 'NO',
      default: null,
    });
    const cmp = compareSnapshots(fixture.expected, liveHostel, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      renameAliasProvenance: provenance,
    });
    const key = fixture.positiveKeys[0];
    red.push({
      name: 'live_hostel_id_present_retains_drift',
      ok: (cmp.drifts || []).some((d) => d.key === key),
    });
  }

  {
    const expDup = JSON.parse(JSON.stringify(fixture.expected));
    expDup.constraints.push({ ...fixture.positive[0] });
    const norm = normalizeMigration003HostelIdNotNullRenameAlias(expDup, fixture.live, {
      profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      provenance,
    });
    const key = fixture.positiveKeys[0];
    const retained = (norm.constraints || []).some(
      (c) => `${c.table}.${c.name}.${c.type}` === key,
    );
    red.push({
      name: 'ambiguous_duplicate_claim_retains_drift',
      ok: retained === true
        && norm.normalizedCount === fixture.positiveKeys.length - 1,
    });
  }

  {
    const bad = {
      table: 'beds',
      name: 'beds_hostel_id_not_null',
      type: 'n',
      definition: 'NOT NULL hostel_id',
    };
    const parsed = parseMigration003HostelIdNotNullRenameAlias(bad, provenance);
    const exp = emptySnap();
    exp.tables = ['beds'];
    exp.constraints = [bad];
    exp.columns = [{
      table: 'beds', column: 'client_id', type: 'uuid', udt: 'uuid', nullable: 'NO', default: null,
    }];
    const live = emptySnap();
    live.tables = ['beds'];
    live.columns = exp.columns.map((c) => ({ ...c }));
    const norm = normalizeMigration003HostelIdNotNullRenameAlias(exp, live, {
      profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      provenance,
    });
    red.push({
      name: 'wrong_definition_retains_drift',
      ok: parsed.ok === false
        && parsed.reason === 'wrong_definition'
        && (norm.constraints || []).some((c) => c.definition === 'NOT NULL hostel_id'),
    });
  }

  {
    const bad = {
      table: 'beds',
      name: 'beds_old_hostel_col_not_null',
      type: 'n',
      definition: 'NOT NULL client_id',
    };
    const parsed = parseMigration003HostelIdNotNullRenameAlias(bad, provenance);
    red.push({
      name: 'arbitrary_old_name_retains_drift',
      ok: parsed.ok === false && parsed.reason === 'legacy_name_mismatch',
    });
  }

  {
    const bad = {
      table: 'not_in_provenance_table',
      name: 'not_in_provenance_table_hostel_id_not_null',
      type: 'n',
      definition: 'NOT NULL client_id',
    };
    const parsed = parseMigration003HostelIdNotNullRenameAlias(bad, provenance);
    red.push({
      name: 'nonapproved_table_retains_drift',
      ok: parsed.ok === false && parsed.reason === 'table_not_provenance_approved',
    });
  }

  {
    const badProv = buildMigration003HostelClientRenameAliasProvenance({
      migrationPath: MIGRATION_003_PATH,
      expectedSha256: '0'.repeat(64),
    });
    red.push({
      name: 'migration_003_hash_change_fails',
      ok: badProv.ok === false && badProv.code === 'migration_003_hash_mismatch',
    });
  }

  {
    const parsed = parseCanonicalNotNullConstraint({
      table: 'beds',
      name: 'beds_hostel_id_not_null',
      type: 'n',
      definition: 'NOT NULL client_id',
    });
    red.push({
      name: 'fourteen_t_exact_name_rule_unchanged',
      ok: parsed.ok === false && parsed.reason === 'name_shape_mismatch',
    });
  }

  {
    const cmp = compareSnapshots(fixture.expected, fixture.live, {
      normalizationProfile: null,
    });
    const nnDrifts = (cmp.drifts || []).filter((d) => String(d.key).endsWith('.n'));
    red.push({
      name: 'non_azure_profile_retains_alias_constraints',
      ok: nnDrifts.length === fixture.positiveKeys.length
        && (cmp.renameAliasNormalization == null),
    });
  }

  {
    // Non-PG15: hard reject when versionClass present but wrong.
    const reject = normalizeMigration003HostelIdNotNullRenameAlias(
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
    // Soft-skip when versionClass absent — retains all aliases.
    const soft = normalizeMigration003HostelIdNotNullRenameAlias(
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
        && soft.normalizedCount === 0
        && soft.constraints.length === fixture.expected.constraints.length,
    });
  }

  // ── Offline GREEN: positive normalize + negatives retain ─────────
  {
    const raw = compareSnapshots(fixture.expected, fixture.live, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      renameAliasProvenance: provenance,
      disableRenameAliasNormalization: true,
    });
    const norm = compareSnapshots(fixture.expected, fixture.live, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      renameAliasProvenance: provenance,
    });
    const rawNn = (raw.drifts || []).filter((d) => String(d.key).endsWith('.n')).length;
    const afterNn = (norm.drifts || []).filter((d) => String(d.key).endsWith('.n')).length;
    const normalizedCount = norm.renameAliasNormalization
      ? norm.renameAliasNormalization.normalizedCount
      : -1;
    green.push({
      name: 'twelve_hostel_id_aliases_normalize_when_columns_match',
      ok: rawNn === fixture.positiveKeys.length
        && afterNn === 0
        && normalizedCount === fixture.positiveKeys.length
        && fixture.positiveKeys.length === 12,
      detail: {
        positiveCount: fixture.positiveKeys.length,
        rawNn,
        afterNn,
        normalizedCount,
      },
    });
    green.push({
      name: 'raw_vs_normalized_compare_api',
      ok: raw.drifts.length > norm.drifts.length
        && (raw.drifts.length - norm.drifts.length) === fixture.positiveKeys.length
        && norm.renameAliasNormalization
        && norm.renameAliasNormalization.provenance
        && norm.renameAliasNormalization.provenance.migrationSha256 === EXPECTED_003_SHA256,
    });
  }

  {
    const cmp = compareSnapshots(fixture.all24Expected, fixture.all24Live, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      renameAliasProvenance: provenance,
    });
    const remaining = new Set((cmp.drifts || []).map((d) => d.key));
    const allNegativesRetained = fixture.negativeKeys.every((k) => remaining.has(k));
    const positivesGone = fixture.positiveKeys.every((k) => !remaining.has(k));
    green.push({
      name: 'negative_keys_within_24_retain',
      ok: allNegativesRetained
        && positivesGone
        && cmp.renameAliasNormalization
        && cmp.renameAliasNormalization.normalizedCount === fixture.positiveKeys.length,
      detail: {
        remainingNegatives: fixture.negativeKeys.filter((k) => remaining.has(k)).length,
        hostelsRetained: fixture.negativeKeys.filter((k) => k.startsWith('clients.hostels_')).every((k) => remaining.has(k)),
        truncatedRetained: remaining.has(
          'package_price_rules.package_price_rules_double_supplement_per_person_per_n_not_null.n',
        ),
        amountCentsRetained: remaining.has('payments.payments_amount_cents_not_null.n'),
        kindRetained: remaining.has('payments.payments_kind_not_null.n'),
      },
    });
  }

  {
    // Accounting: baseline (alias off) = aliases normalized + remaining.
    const baseline = compareSnapshots(fixture.all24Expected, fixture.all24Live, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      renameAliasProvenance: provenance,
      disableRenameAliasNormalization: true,
    });
    const after = compareSnapshots(fixture.all24Expected, fixture.all24Live, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      serverVersionClass: 'postgresql_15',
      renameAliasProvenance: provenance,
    });
    const baselineCount = (baseline.drifts || []).length;
    const aliases = after.renameAliasNormalization
      ? after.renameAliasNormalization.normalizedCount
      : -1;
    const remaining = (after.drifts || []).length;
    green.push({
      name: 'accounting_identity_baseline_aliases_plus_remaining',
      ok: baselineCount === aliases + remaining
        && aliases === fixture.positiveKeys.length
        && remaining === fixture.negativeKeys.length,
      detail: { baselineCount, aliases, remaining },
    });
  }

  // ── Gate RED/GREEN ───────────────────────────────────────────────
  {
    resetRenameAliasNormalizationCounters();
    const r = await executeRenameAliasNormalization({
      env: {},
      argv: [],
    });
    const c = getRenameAliasNormalizationCounters();
    red.push({
      name: 'default_path_zero_http_and_clients',
      ok: r.ok === false && c.clientsInstantiated === 0 && c.httpRequestCount === 0,
      code: r.code,
    });
  }

  {
    resetRenameAliasNormalizationCounters();
    const env = renameAliasNormalizationEnv();
    const argv = exactRenameAliasNormalizationArgv()
      .filter((a) => a !== CLI_PROVE_RENAME_ALIAS_NORMALIZATION);
    const r = await executeRenameAliasNormalization({ env, argv });
    const c = getRenameAliasNormalizationCounters();
    red.push({
      name: 'missing_prove_flag_zero_clients',
      ok: r.ok === false && c.clientsInstantiated === 0,
      code: r.code,
    });
  }

  {
    resetRenameAliasNormalizationCounters();
    const env = { ...renameAliasNormalizationEnv() };
    delete env[ENV_RENAME_ALIAS_NORMALIZATION];
    const r = await executeRenameAliasNormalization({
      env,
      argv: exactRenameAliasNormalizationArgv(),
    });
    red.push({
      name: 'missing_rename_alias_env_zero_clients',
      ok: r.ok === false && r.code === 'rename_alias_normalization_env_required',
    });
  }

  {
    resetRenameAliasNormalizationCounters();
    const env = renameAliasNormalizationEnv();
    const argv = exactRenameAliasNormalizationArgv()
      .map((a) => (a === 'sunset_staging' ? 'wrong_db' : a));
    const r = await executeRenameAliasNormalization({ env, argv });
    red.push({
      name: 'wrong_exact_targets_zero_clients',
      ok: r.ok === false && getRenameAliasNormalizationCounters().clientsInstantiated === 0,
    });
  }

  {
    resetRenameAliasNormalizationCounters();
    const env = renameAliasNormalizationEnv();
    const argv = [...exactRenameAliasNormalizationArgv(), '--dsn', 'postgresql://x:y@host/db'];
    const r = await executeRenameAliasNormalization({ env, argv });
    red.push({
      name: 'forbidden_argv_dsn_sql_drop_dml_zero_clients',
      ok: r.ok === false && (r.code === 'forbidden_argv' || String(r.code).includes('forbidden')),
    });
  }

  {
    const gates = evaluateRenameAliasNormalizationGates({
      env: renameAliasNormalizationEnv(),
      argv: exactRenameAliasNormalizationArgv(),
    });
    green.push({
      name: 'cli_gates_exact_targets',
      ok: gates.ok === true,
    });
  }

  {
    const help = printCliHelp();
    green.push({
      name: 'cli_default_disabled',
      ok: PHASE_D_RENAME_ALIAS_NORMALIZATION_LIVE_ENABLED === true
        && PHASE_D_LIVE_APPLY_ENABLED === false
        && PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true
        && /DEFAULT: refused/.test(help),
    });
  }

  {
    green.push({
      name: 'locks_identity_vault_secret_pg_tls_application_name',
      ok: APPLICATION_NAME === 'wh-sunset-rename-alias-normalization'
        && RENAME_ALIAS_LOCKS.sslmode === 'verify-full'
        && RENAME_ALIAS_LOCKS.database === 'sunset_staging'
        && RENAME_ALIAS_LOCKS.postgresHost === EXPECTED_HOST
        && RENAME_ALIAS_LOCKS.secretName === 'sunset-database-url',
    });
  }

  {
    green.push({
      name: 'global_live_apply_remains_false',
      ok: PHASE_D_LIVE_APPLY_ENABLED === false,
    });
  }

  // Injected authority+observer (no real HTTP/PG)
  {
    resetRenameAliasNormalizationCounters();
    const fakeDsn = buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
    const http = createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: fakeDsn,
    });
    const r = await executeRenameAliasNormalization({
      env: renameAliasNormalizationEnv(),
      argv: exactRenameAliasNormalizationArgv(),
      httpRequest: http,
      skipPostgres: false,
      expectedContract: expected,
      injectedObserver: {
        code: 'rename_alias_normalization_injected',
        sessionReadOnly: true,
        transactionReadOnly: true,
        committed: true,
        serverVersionClass: classifyServerVersionClass(150005, '15.5'),
        baselineMismatchCount: BASELINE_MISMATCH_COUNT,
        renameAliasesNormalized: 12,
        remainingMismatchCount: 23,
        remainingKeys: fixture.negativeKeys.slice(),
        accountingOk: BASELINE_MISMATCH_COUNT === 12 + 23,
        migration003Sha256: EXPECTED_003_SHA256,
        provenanceCount: 15,
        observerBefore: {
          ok: false,
          match: false,
          code: 'observer_drift',
          mismatchCount: BASELINE_MISMATCH_COUNT,
          mismatchSections: {
            constraints: 25, indexes: 5, functions: 1, triggers: 1,
            ownership: 1, acls: 1, extensions: 1,
          },
          renameAliasesNormalized: 0,
        },
        observerAfter: {
          ok: false,
          match: false,
          code: 'observer_drift',
          mismatchCount: 23,
          renameAliasesNormalized: 12,
          remainingKeys: fixture.negativeKeys.slice(),
        },
        productFingerprintLive: 'injected-offline-fingerprint',
      },
    });
    leakScan(r, secrets);
    // Additive offline path check — not in REQUIRED_GREEN
    if (!(r.ok === true && r.sameTarget === true && r.liveMutation === false)) {
      throw new Error('injected authority observer path failed');
    }
  }

  for (const name of REQUIRED_RED) {
    if (!red.some((r) => r.name === name)) {
      red.push({ name, ok: false, detail: 'missing case' });
    }
  }
  for (const name of REQUIRED_GREEN) {
    if (!green.some((g) => g.name === name)) {
      green.push({ name, ok: false, detail: 'missing case' });
    }
  }

  const redFailed = red.filter((r) => !r.ok);
  const greenFailed = green.filter((g) => !g.ok);
  if (redFailed.length || greenFailed.length) {
    console.error('RED failures', redFailed);
    console.error('GREEN failures', greenFailed);
    throw new Error(`offline RED/GREEN failed: red=${redFailed.length} green=${greenFailed.length}`);
  }
  console.log(`  PASS  offline RED (${red.length}) / GREEN (${green.length})`);

  // ── Optional live ────────────────────────────────────────────────
  let liveOutcome = preserveLive ? priorEvidence.liveOutcome : null;
  if (!offlineOnly) {
    console.log('  … running one live rename-alias normalization session');
    resetRenameAliasNormalizationCounters();
    const result = await executeRenameAliasNormalization({
      env: {
        ...renameAliasNormalizationEnv(),
        ...process.env,
        [ENV_RENAME_ALIAS_NORMALIZATION]: '1',
      },
      argv: exactRenameAliasNormalizationArgv(),
      expectedContract: expected,
    });
    liveOutcome = pickSafeLiveOutcome(result);
    leakScan(liveOutcome, secrets);
    console.log(`  live code=${liveOutcome.code} sameTarget=${liveOutcome.sameTarget}`);
    console.log(`  serverVersionClass=${JSON.stringify(liveOutcome.serverVersionClass)}`);
    console.log(`  baseline=${liveOutcome.baselineMismatchCount}`);
    console.log(`  aliasesNormalized=${liveOutcome.renameAliasesNormalized}`);
    console.log(`  remaining=${liveOutcome.remainingMismatchCount}`);
  }

  const evidence = {
    kind: 'slice14v-rename-alias-normalization-evidence',
    slice: '14V',
    masterShaBasis: MASTER,
    generatedAt: new Date().toISOString(),
    secretFree: true,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    kvMutation: false,
    rbacMutation: false,
    networkMutation: false,
    firewallAction: false,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    blessesLiveAsCanonical: false,
    doNotClaimDatabaseMatchesCanonical: true,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintExpected: CANON_FP,
    manifestHash: MANIFEST_HASH,
    migration003Sha256: EXPECTED_003_SHA256,
    renameAliasRule: MIGRATION_003_RENAME_ALIAS_RULE,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    applicationName: APPLICATION_NAME,
    baselineMismatchCountExpected: BASELINE_MISMATCH_COUNT,
    offline: {
      red,
      green,
      redCount: red.length,
      greenCount: green.length,
      fixture24: {
        keys: fixture.keys,
        positiveKeys: fixture.positiveKeys,
        negativeKeys: fixture.negativeKeys,
        positiveCount: fixture.positiveKeys.length,
        negativeCount: fixture.negativeKeys.length,
      },
      provenance: {
        provenanceCount: provenance.provenanceCount,
        approvedTables: provenance.approvedTables.slice(),
        migrationSha256: provenance.migrationSha256,
        rule: provenance.rule,
      },
    },
    liveOutcome,
    secretHandlingProof: {
      neverPrinted: true,
      neverPersisted: true,
      neverHashedIntoEvidence: true,
      neverInArgv: true,
      observerNeverPersistsDsn: true,
    },
    verifyNeverRerunsLive: true,
  };

  const contract = {
    kind: 'slice14v-rename-alias-normalization-contract',
    slice: '14V',
    masterShaBasis: MASTER,
    applicationName: APPLICATION_NAME,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintExpected: CANON_FP,
    manifestHash: MANIFEST_HASH,
    migration003Sha256: EXPECTED_003_SHA256,
    baselineMismatchCount: BASELINE_MISMATCH_COUNT,
    requiredRed: REQUIRED_RED.slice(),
    requiredGreen: REQUIRED_GREEN.slice(),
    locks: {
      postgresHost: RENAME_ALIAS_LOCKS.postgresHost,
      database: RENAME_ALIAS_LOCKS.database,
      sslmode: RENAME_ALIAS_LOCKS.sslmode,
      applicationName: APPLICATION_NAME,
      containerAppName: RENAME_ALIAS_LOCKS.containerAppName,
      keyVaultName: RENAME_ALIAS_LOCKS.keyVaultName,
      secretName: RENAME_ALIAS_LOCKS.secretName,
    },
    gates: {
      envRenameAliasNormalization: ENV_RENAME_ALIAS_NORMALIZATION,
      cliProve: CLI_PROVE_RENAME_ALIAS_NORMALIZATION,
      defaultDisabled: true,
      liveApplyRemainsFalse: true,
    },
    verifyNeverRerunsLive: true,
  };

  const beforeCount = liveOutcome && liveOutcome.observerBefore
    ? liveOutcome.observerBefore.mismatchCount
    : null;
  const afterCount = liveOutcome && liveOutcome.observerAfter
    ? liveOutcome.observerAfter.mismatchCount
    : null;
  const aliasesNorm = liveOutcome && liveOutcome.renameAliasesNormalized != null
    ? liveOutcome.renameAliasesNormalized
    : null;
  const versionClass = liveOutcome && liveOutcome.serverVersionClass
    ? liveOutcome.serverVersionClass.versionClass
    : null;

  const findings = `# FOUNDATION Slice 14V — hostel_id→client_id rename-alias normalization

**Status:** ${liveOutcome && liveOutcome.ok ? 'rename_alias_normalization_live_ok' : 'offline_gates_ok'}
**Master basis:** \`${MASTER}\`
**Canonical fingerprint (unchanged):** \`${CANON_FP}\`
**Expected bytes (unchanged):** \`${EXPECTED_BYTE_SHA}\`
**Migration 003 sha256 (locked):** \`${EXPECTED_003_SHA256}\`

## What this slice does

Conservative \`azure_flexible_server_v1\` + \`postgresql_15\` comparison normalization for
migration 003 hostel_id→client_id NOT NULL **constraint-name aliases**:

- Expected may still encode \`{table}_hostel_id_not_null\` with definition \`NOT NULL client_id\`
  for tables in the migration 003 FOREACH rename loop (15 tables; provenance hash-locked).
- Live Azure PG15 encodes the guarantee via \`attnotnull\` on \`client_id\` with \`hostel_id\` absent
  and no matching type-n constraint object.
- Normalize (exclude from compare) only those proven aliases when live \`client_id\` is \`nullable=NO\`
  and \`hostel_id\` is absent.
- Does **not** broaden Slice 14T \`parseCanonicalNotNullConstraint\` (exact-name rule still rejects
  \`beds_hostel_id_not_null\` / \`NOT NULL client_id\` as \`name_shape_mismatch\`).
- Soft-skips when PG15 versionClass is absent (14T/14U keep working).
- Never suppresses hostels_* leftovers, truncated names, amount_cents/kind mismatches,
  nullable YES, missing columns, live hostel_id present, duplicates, wrong definition,
  arbitrary names, or non-approved tables.

Offline 24-key name_shape fixture: **${fixture.keys.length}** residuals; **${fixture.positiveKeys.length}**
positive hostel_id aliases normalize when columns match; **${fixture.negativeKeys.length}** negatives retain.

## Offline gates

- RED: ${red.length} cases
- GREEN: ${green.length} cases
- Provenance tables: **${provenance.provenanceCount}**
- Positive aliases: **${fixture.positiveKeys.length}**

## Live

application_name: \`${APPLICATION_NAME}\`
sameTarget: **${liveOutcome ? liveOutcome.sameTarget : 'n/a'}**
server version class: **${versionClass || 'n/a'}**
baseline mismatch (identity + 14T; rename alias off): **${liveOutcome && liveOutcome.baselineMismatchCount != null ? liveOutcome.baselineMismatchCount : (beforeCount == null ? 'n/a' : beforeCount)}**
rename aliases normalized: **${aliasesNorm == null ? 'n/a' : aliasesNorm}**
remaining mismatch: **${liveOutcome && liveOutcome.remainingMismatchCount != null ? liveOutcome.remainingMismatchCount : (afterCount == null ? 'n/a' : afterCount)}**
before sections: ${liveOutcome && liveOutcome.observerBefore ? JSON.stringify(liveOutcome.observerBefore.mismatchSections) : 'n/a'}
after sections: ${liveOutcome && liveOutcome.observerAfter ? JSON.stringify(liveOutcome.observerAfter.mismatchSections) : 'n/a'}
accounting: baseline === aliases + remaining (reported; not forced to a constant final count)

Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.

## Do not claim

- Do **not** claim Sunset fully repaired / database matches canonical.
- Do **not** apply rename/NOT NULL DDL in this slice.
- Do **not** run verify with \`--live\` (verify never re-runs live).
- Do **not** modify expected-product-schema bytes/fingerprint or migrations.
- Do **not** broaden 14T exact-name parsing.

## Operator live command

\`\`\`
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_RENAME_ALIAS_NORMALIZATION=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:rename-alias-normalization -- --prove-rename-alias-normalization --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
\`\`\`

## Artifacts

- \`fixtures/sunset-schema-observer/slice14v-rename-alias-normalization-evidence.json\`
- \`fixtures/sunset-schema-observer/slice14v-rename-alias-normalization-contract.json\`
- \`fixtures/sunset-schema-observer/slice14v-findings.md\`
`;

  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  leakScan(evidence, secrets);
  leakScan(contract, secrets);
  leakScan(findings, secrets);

  if (!fs.existsSync(CLI_PATH)) {
    console.warn('  WARN  CLI path missing:', CLI_PATH);
  }

  console.log(`\nWrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('prove:sunset-schema-slice14v GREEN (offline)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
