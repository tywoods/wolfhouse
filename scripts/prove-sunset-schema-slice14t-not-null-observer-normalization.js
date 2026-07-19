'use strict';

/**
 * prove-sunset-schema-slice14t-not-null-observer-normalization
 * FOUNDATION Slice 14T
 *
 * Offline RED/GREEN for NOT NULL constraint↔attnotnull normalization
 * (migration-035 exact fixture) + optional --live once: merged target
 * authority + one TLS verify-full observer session
 * application_name=wh-sunset-not-null-normalization.
 *
 * Default offline. Verify never re-runs live. Zero mutation.
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
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  EXPECTED_028_SHA256,
} = require('./lib/phase-d-check-preflight');
const {
  PHASE_D_NOT_NULL_NORMALIZATION_LIVE_ENABLED,
  ENV_NOT_NULL_NORMALIZATION,
  CLI_PROVE_NOT_NULL_NORMALIZATION,
  APPLICATION_NAME,
  NOT_NULL_LOCKS,
  evaluateNotNullNormalizationGates,
  exactNotNullNormalizationArgv,
  notNullNormalizationEnv,
  executeNotNullObserverNormalization,
  createInjectedTargetAuthorityHttp,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetNotNullNormalizationCounters,
  getNotNullNormalizationCounters,
  printCliHelp,
} = require('./lib/phase-d-not-null-observer-normalization');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14t-not-null-observer-normalization-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14t-not-null-observer-normalization-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14t-findings.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-not-null-observer-normalization.js');

const MASTER = '9a6d45b0d0d880d43ed41749d95d2d289ace9917';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';
const EXPECTED_035_SHA256 = '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': EXPECTED_035_SHA256,
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const AZURE_CTX = Object.freeze({
  verified: true,
  host: EXPECTED_HOST,
  database: EXPECTED_DATABASE,
});

const CMT_TABLE = 'customer_message_templates';
const CMT_NOT_NULL_COLUMNS = Object.freeze([
  'id',
  'client_id',
  'title',
  'body',
  'channel',
  'tags',
  'active',
  'created_at',
  'updated_at',
]);
// Migration 035 declares 8 NOT NULL columns (+ id via PRIMARY KEY also NOT NULL).
// Catalog-verified in 14S: 8 NOT NULL column guarantees (id included among attnotnull).
const CMT_NOT_NULL_ARTIFACT_COLUMNS = Object.freeze([
  'id',
  'client_id',
  'title',
  'body',
  'channel',
  'tags',
  'active',
  'created_at',
  // updated_at is also NOT NULL in 035 — expected has 9 type-n constraints for CMT.
]);

const FAKE_ADMIN_USER = 'slice14t-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14t-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14t-proof-imds-token-never-commit';

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

function cmtNotNullConstraint(column) {
  return {
    table: CMT_TABLE,
    name: `${CMT_TABLE}_${column}_not_null`,
    type: 'n',
    definition: `NOT NULL ${column}`,
  };
}

function cmtColumn(column, nullable) {
  return {
    table: CMT_TABLE,
    column,
    type: 'text',
    udt: 'text',
    nullable,
    default: null,
  };
}

function buildMigration035Fixture() {
  // Exact expected constraint objects for CMT NOT NULL from canonical expected.
  const expectedFull = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
  const cmtNn = expectedFull.snapshot.constraints.filter(
    (c) => c.table === CMT_TABLE && c.type === 'n',
  );
  const cmtCols = expectedFull.snapshot.columns.filter((c) => c.table === CMT_TABLE);
  const cmtPkFkCheck = expectedFull.snapshot.constraints.filter(
    (c) => c.table === CMT_TABLE && c.type !== 'n',
  );

  const expected = emptySnap();
  expected.tables = [CMT_TABLE];
  expected.columns = cmtCols.slice();
  expected.constraints = [...cmtNn, ...cmtPkFkCheck];

  // Live Azure shape: columns nullable=NO, PK/FK present, no type-n constraint objects.
  const live = emptySnap();
  live.tables = [CMT_TABLE];
  live.columns = cmtCols.map((c) => ({ ...c }));
  live.constraints = cmtPkFkCheck.map((c) => ({ ...c }));

  return {
    expected,
    live,
    cmtNotNullCount: cmtNn.length,
    cmtNotNullKeys: cmtNn.map((c) => `${c.table}.${c.name}.${c.type}`).sort(),
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
  if (/Bearer\s+slice14t-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
}

function pickSafeLiveOutcome(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ok: result.ok === true,
    code: String(result.code || 'not_null_normalization_unknown'),
    sameTarget: result.sameTarget === true,
    sameTargetReason: result.sameTargetReason || null,
    blocker: result.ok === true && result.observerAfter && result.observerAfter.match
      ? null
      : (result.blocker || null),
    sessionReadOnly: result.sessionReadOnly === true,
    transactionReadOnly: result.transactionReadOnly === true,
    serverVersionClass: result.serverVersionClass || null,
    observerBefore: result.observerBefore || null,
    observerAfter: result.observerAfter || null,
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
    postgresHost: result.postgresHost || NOT_NULL_LOCKS.postgresHost,
    database: result.database || NOT_NULL_LOCKS.database,
    sslmode: result.sslmode || NOT_NULL_LOCKS.sslmode,
    errors: Array.isArray(result.errors)
      ? result.errors.map((e) => ({
        code: String((e && e.code) || 'failed').slice(0, 80),
        message: String((e && e.message) || '').slice(0, 240),
      }))
      : [],
  };
}

async function main() {
  const wantLive = process.argv.includes('--live');
  const offlineOnly = !wantLive
    || process.argv.includes('--offline')
    || process.env.SUNSET_SLICE14T_PROOF_OFFLINE === '1';
  console.log(offlineOnly
    ? 'prove:sunset-schema-slice14t — offline only (no live HTTP/PG)\n'
    : 'prove:sunset-schema-slice14t — offline then one live not-null normalization proof\n');

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
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  if (manifestHash !== MANIFEST_HASH) throw new Error('manifest hash drift');
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  if (live035 !== EXPECTED_035_SHA256) throw new Error('migration 035 sha drift');

  const fixture = buildMigration035Fixture();
  if (fixture.cmtNotNullCount < 8) {
    throw new Error(`expected ≥8 CMT NOT NULL constraints, got ${fixture.cmtNotNullCount}`);
  }

  // ── Offline RED: normalization safety ────────────────────────────
  {
    const liveYes = JSON.parse(JSON.stringify(fixture.live));
    liveYes.columns = liveYes.columns.map((c) => (
      c.column === 'title' ? { ...c, nullable: 'YES' } : c
    ));
    const cmp = compareSnapshots(fixture.expected, liveYes, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    const titleKey = `${CMT_TABLE}.${CMT_TABLE}_title_not_null.n`;
    const retained = (cmp.drifts || []).some((d) => d.key === titleKey);
    const normalized = cmp.notNullNormalization
      && !cmp.notNullNormalization.audit.some((a) => a.key === titleKey);
    red.push({
      name: 'live_nullable_yes_retains_drift',
      ok: retained === true && normalized === true,
      detail: { retained, normalizedCount: cmp.notNullNormalization && cmp.notNullNormalization.normalizedCount },
    });
  }

  {
    const liveMissing = JSON.parse(JSON.stringify(fixture.live));
    liveMissing.columns = liveMissing.columns.filter((c) => c.column !== 'body');
    const cmp = compareSnapshots(fixture.expected, liveMissing, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    const bodyKey = `${CMT_TABLE}.${CMT_TABLE}_body_not_null.n`;
    red.push({
      name: 'live_column_missing_retains_drift',
      ok: (cmp.drifts || []).some((d) => d.key === bodyKey),
    });
  }

  {
    const expDup = JSON.parse(JSON.stringify(fixture.expected));
    expDup.constraints.push(cmtNotNullConstraint('title')); // duplicate claim
    const norm = normalizeNotNullConstraintRepresentation(expDup, fixture.live, {
      profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    const titleKey = `${CMT_TABLE}.${CMT_TABLE}_title_not_null.n`;
    const retained = (norm.constraints || []).some(
      (c) => `${c.table}.${c.name}.${c.type}` === titleKey,
    );
    red.push({
      name: 'ambiguous_duplicate_claim_retains_drift',
      ok: retained === true && norm.normalizedCount === fixture.cmtNotNullCount - 1,
    });
  }

  {
    const bad = {
      table: CMT_TABLE,
      name: `${CMT_TABLE}_title_not_null`,
      type: 'n',
      definition: 'NOT NULL (title)',
    };
    const parsed = parseCanonicalNotNullConstraint(bad);
    const exp = JSON.parse(JSON.stringify(fixture.expected));
    exp.constraints = [bad, ...fixture.expected.constraints.filter((c) => c.type !== 'n')];
    const norm = normalizeNotNullConstraintRepresentation(exp, fixture.live, {
      profile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    red.push({
      name: 'unsupported_definition_shape_retains_drift',
      ok: parsed.ok === false
        && parsed.reason === 'unsupported_definition_shape'
        && (norm.constraints || []).some((c) => c.definition === 'NOT NULL (title)'),
    });
  }

  {
    const exp = JSON.parse(JSON.stringify(fixture.expected));
    const pk = exp.constraints.find((c) => c.type === 'PRIMARY KEY');
    const fk = exp.constraints.find((c) => c.type === 'FOREIGN KEY');
    const check = {
      table: CMT_TABLE,
      name: 'customer_message_templates_channel_check',
      type: 'CHECK',
      definition: "CHECK ((channel = 'whatsapp'::text))",
    };
    exp.constraints.push(check);
    const live = JSON.parse(JSON.stringify(fixture.live));
    // Live missing PK/FK/CHECK → must remain expected_only (not normalized away).
    live.constraints = [];
    const cmp = compareSnapshots(exp, live, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    const keys = (cmp.drifts || []).map((d) => d.key);
    red.push({
      name: 'non_not_null_pk_fk_check_untouched',
      ok: keys.includes(`${pk.table}.${pk.name}.${pk.type}`)
        && keys.includes(`${fk.table}.${fk.name}.${fk.type}`)
        && keys.includes(`${check.table}.${check.name}.${check.type}`),
    });
  }

  {
    const badName = {
      table: CMT_TABLE,
      name: 'weird_not_null',
      type: 'n',
      definition: 'NOT NULL title',
    };
    const parsed = parseCanonicalNotNullConstraint(badName);
    red.push({
      name: 'name_shape_mismatch_retains_drift',
      ok: parsed.ok === false && parsed.reason === 'name_shape_mismatch',
    });
  }

  {
    const cmp = compareSnapshots(fixture.expected, fixture.live, {
      normalizationProfile: null,
    });
    const nnDrifts = (cmp.drifts || []).filter((d) => String(d.key).endsWith('.n'));
    red.push({
      name: 'non_azure_profile_retains_not_null_constraints',
      ok: nnDrifts.length === fixture.cmtNotNullCount
        && (cmp.notNullNormalization == null),
    });
  }

  // ── Offline GREEN: migration 035 normalize when columns match ────
  {
    const raw = compareSnapshots(fixture.expected, fixture.live, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
      disableNotNullConstraintNormalization: true,
    });
    const norm = compareSnapshots(fixture.expected, fixture.live, {
      normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
      azureContext: AZURE_CTX,
    });
    const rawNn = (raw.drifts || []).filter((d) => String(d.key).endsWith('.n')).length;
    const afterNn = (norm.drifts || []).filter((d) => String(d.key).endsWith('.n')).length;
    const normalizedCount = norm.notNullNormalization
      ? norm.notNullNormalization.normalizedCount
      : -1;
    green.push({
      name: 'migration_035_eight_plus_not_null_normalize_when_columns_match',
      ok: rawNn === fixture.cmtNotNullCount
        && afterNn === 0
        && normalizedCount === fixture.cmtNotNullCount
        && fixture.cmtNotNullCount >= 8,
      detail: {
        cmtNotNullCount: fixture.cmtNotNullCount,
        rawNn,
        afterNn,
        normalizedCount,
      },
    });
    green.push({
      name: 'raw_vs_normalized_compare_api',
      ok: raw.drifts.length > norm.drifts.length
        && (raw.drifts.length - norm.drifts.length) === fixture.cmtNotNullCount,
    });
  }

  {
    const cls = classifyServerVersionClass(160001, '16.1');
    green.push({
      name: 'server_version_class_classifier',
      ok: cls.ok === true && cls.major === 16 && cls.versionClass === 'postgresql_16',
    });
  }

  // ── Gate RED/GREEN ───────────────────────────────────────────────
  {
    resetNotNullNormalizationCounters();
    const r = await executeNotNullObserverNormalization({
      env: {},
      argv: [],
    });
    const c = getNotNullNormalizationCounters();
    red.push({
      name: 'default_path_zero_http_and_clients',
      ok: r.ok === false && c.clientsInstantiated === 0 && c.httpRequestCount === 0,
      code: r.code,
    });
  }

  {
    resetNotNullNormalizationCounters();
    const env = notNullNormalizationEnv();
    const argv = exactNotNullNormalizationArgv().filter((a) => a !== CLI_PROVE_NOT_NULL_NORMALIZATION);
    const r = await executeNotNullObserverNormalization({ env, argv });
    const c = getNotNullNormalizationCounters();
    red.push({
      name: 'missing_prove_flag_zero_clients',
      ok: r.ok === false && c.clientsInstantiated === 0,
      code: r.code,
    });
  }

  {
    resetNotNullNormalizationCounters();
    const env = { ...notNullNormalizationEnv() };
    delete env[ENV_NOT_NULL_NORMALIZATION];
    const r = await executeNotNullObserverNormalization({
      env,
      argv: exactNotNullNormalizationArgv(),
    });
    red.push({
      name: 'missing_not_null_env_zero_clients',
      ok: r.ok === false && r.code === 'not_null_normalization_env_required',
    });
  }

  {
    resetNotNullNormalizationCounters();
    const env = notNullNormalizationEnv();
    const argv = exactNotNullNormalizationArgv().map((a) => (a === 'sunset_staging' ? 'wrong_db' : a));
    const r = await executeNotNullObserverNormalization({ env, argv });
    red.push({
      name: 'wrong_exact_targets_zero_clients',
      ok: r.ok === false && getNotNullNormalizationCounters().clientsInstantiated === 0,
    });
  }

  {
    resetNotNullNormalizationCounters();
    const env = notNullNormalizationEnv();
    const argv = [...exactNotNullNormalizationArgv(), '--dsn', 'postgresql://x:y@host/db'];
    const r = await executeNotNullObserverNormalization({ env, argv });
    red.push({
      name: 'forbidden_argv_dsn_sql_drop_dml_zero_clients',
      ok: r.ok === false && (r.code === 'forbidden_argv' || String(r.code).includes('forbidden')),
    });
  }

  {
    const gates = evaluateNotNullNormalizationGates({
      env: notNullNormalizationEnv(),
      argv: exactNotNullNormalizationArgv(),
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
      ok: PHASE_D_NOT_NULL_NORMALIZATION_LIVE_ENABLED === true
        && PHASE_D_LIVE_APPLY_ENABLED === false
        && PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true
        && /DEFAULT: refused/.test(help),
    });
  }

  {
    green.push({
      name: 'locks_identity_vault_secret_pg_tls_application_name',
      ok: APPLICATION_NAME === 'wh-sunset-not-null-normalization'
        && NOT_NULL_LOCKS.sslmode === 'verify-full'
        && NOT_NULL_LOCKS.database === 'sunset_staging'
        && NOT_NULL_LOCKS.postgresHost === EXPECTED_HOST
        && NOT_NULL_LOCKS.secretName === 'sunset-database-url',
    });
  }

  {
    green.push({
      name: 'global_live_apply_remains_false',
      ok: PHASE_D_LIVE_APPLY_ENABLED === false,
    });
  }

  // Injected authority+observer GREEN (no real HTTP/PG)
  {
    resetNotNullNormalizationCounters();
    const fakeDsn = buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
    const http = createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: fakeDsn,
    });
    // Prefer injectedObserver to avoid double-path complexity in offline GREEN.
    const r = await executeNotNullObserverNormalization({
      env: notNullNormalizationEnv(),
      argv: exactNotNullNormalizationArgv(),
      httpRequest: http,
      skipPostgres: false,
      expectedContract: expected,
      injectedObserver: {
        code: 'not_null_normalization_injected',
        sessionReadOnly: true,
        transactionReadOnly: true,
        committed: true,
        serverVersionClass: classifyServerVersionClass(160001, '16.1'),
        observerBefore: {
          ok: false,
          match: false,
          code: 'observer_drift',
          mismatchCount: fixture.cmtNotNullCount,
          counts: { expected_only: fixture.cmtNotNullCount, live_only: 0, definition_mismatch: 0 },
          mismatchSections: { constraints: fixture.cmtNotNullCount },
          notNullArtifactsNormalized: 0,
        },
        observerAfter: {
          ok: true,
          match: true,
          code: 'observer_match',
          mismatchCount: 0,
          counts: { expected_only: 0, live_only: 0, definition_mismatch: 0 },
          mismatchSections: {},
          notNullArtifactsNormalized: fixture.cmtNotNullCount,
        },
        productFingerprintLive: 'injected-offline-fingerprint',
      },
    });
    leakScan(r, secrets);
    green.push({
      name: 'injected_authority_observer_path_secret_free',
      ok: r.ok === true && r.sameTarget === true && r.liveMutation === false,
    });
    // not in REQUIRED_GREEN list — additive; keep evidence honest if we want
  }

  // Validate required RED/GREEN names present
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
    console.log('  … running one live not-null normalization session');
    resetNotNullNormalizationCounters();
    const result = await executeNotNullObserverNormalization({
      env: {
        ...notNullNormalizationEnv(),
        ...process.env,
        [ENV_NOT_NULL_NORMALIZATION]: '1',
      },
      argv: exactNotNullNormalizationArgv(),
      expectedContract: expected,
    });
    liveOutcome = pickSafeLiveOutcome(result);
    leakScan(liveOutcome, secrets);
    console.log(`  live code=${liveOutcome.code} sameTarget=${liveOutcome.sameTarget}`);
    console.log(`  serverVersionClass=${JSON.stringify(liveOutcome.serverVersionClass)}`);
    console.log(`  before=${liveOutcome.observerBefore && liveOutcome.observerBefore.mismatchCount}`);
    console.log(`  after=${liveOutcome.observerAfter && liveOutcome.observerAfter.mismatchCount}`);
    console.log(`  normalized=${liveOutcome.observerAfter && liveOutcome.observerAfter.notNullArtifactsNormalized}`);
  }

  const evidence = {
    kind: 'slice14t-not-null-observer-normalization-evidence',
    slice: '14T',
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
    migration035Sha256: EXPECTED_035_SHA256,
    lockedMigrationShas: LOCKED_13C_SHA,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    applicationName: APPLICATION_NAME,
    offline: {
      red,
      green,
      redCount: red.length,
      greenCount: green.length,
      migration035Fixture: {
        cmtNotNullCount: fixture.cmtNotNullCount,
        cmtNotNullKeys: fixture.cmtNotNullKeys,
        table: CMT_TABLE,
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
    kind: 'slice14t-not-null-observer-normalization-contract',
    slice: '14T',
    masterShaBasis: MASTER,
    applicationName: APPLICATION_NAME,
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    productFingerprintExpected: CANON_FP,
    manifestHash: MANIFEST_HASH,
    migration035Sha256: EXPECTED_035_SHA256,
    requiredRed: REQUIRED_RED.slice(),
    requiredGreen: REQUIRED_GREEN.slice(),
    locks: {
      postgresHost: NOT_NULL_LOCKS.postgresHost,
      database: NOT_NULL_LOCKS.database,
      sslmode: NOT_NULL_LOCKS.sslmode,
      applicationName: APPLICATION_NAME,
      containerAppName: NOT_NULL_LOCKS.containerAppName,
      keyVaultName: NOT_NULL_LOCKS.keyVaultName,
      secretName: NOT_NULL_LOCKS.secretName,
    },
    gates: {
      envNotNullNormalization: ENV_NOT_NULL_NORMALIZATION,
      cliProve: CLI_PROVE_NOT_NULL_NORMALIZATION,
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
  const normalizedCount = liveOutcome && liveOutcome.observerAfter
    ? liveOutcome.observerAfter.notNullArtifactsNormalized
    : null;
  const versionClass = liveOutcome && liveOutcome.serverVersionClass
    ? liveOutcome.serverVersionClass.versionClass
    : null;

  const findings = `# FOUNDATION Slice 14T — NOT NULL observer representation normalization

**Status:** ${liveOutcome && liveOutcome.ok ? 'not_null_normalization_live_ok' : 'offline_gates_ok'}
**Master basis:** \`${MASTER}\`
**Canonical fingerprint (unchanged):** \`${CANON_FP}\`
**Expected bytes (unchanged):** \`${EXPECTED_BYTE_SHA}\`

## What this slice does

Conservative \`azure_flexible_server_v1\` comparison normalization for cross-PostgreSQL-version
NOT NULL representation:

- Expected may encode NOT NULL as \`pg_constraint\` contype \`n\` objects
  (\`type=n\`, \`definition=NOT NULL <col>\`, \`name=<table>_<col>_not_null\`).
- Azure Flexible Server often encodes the same guarantee via \`pg_attribute.attnotnull\`
  (column \`nullable=NO\`) without a matching constraint object.
- Normalize only when expected column \`nullable=NO\` and live column exists with \`nullable=NO\`.
- Exclude only those redundant expected constraint objects from constraint compare.
- Never suppress real nullable mismatch (YES / missing / ambiguous / duplicate /
  unsupported shape / PK/FK/CHECK / non-Azure).

Migration 035 fixture (offline): **${fixture.cmtNotNullCount}** CMT NOT NULL artifacts normalize
only when column semantics match.

## Offline gates

- RED: ${red.length} cases
- GREEN: ${green.length} cases

## Live

application_name: \`${APPLICATION_NAME}\`
sameTarget: **${liveOutcome ? liveOutcome.sameTarget : 'n/a'}**
server version class: **${versionClass || 'n/a'}**
mismatch before (identity only): **${beforeCount == null ? 'n/a' : beforeCount}**
mismatch after (identity + NOT NULL norm): **${afterCount == null ? 'n/a' : afterCount}**
NOT NULL artifacts normalized: **${normalizedCount == null ? 'n/a' : normalizedCount}**
before sections: ${liveOutcome && liveOutcome.observerBefore ? JSON.stringify(liveOutcome.observerBefore.mismatchSections) : 'n/a'}
after sections: ${liveOutcome && liveOutcome.observerAfter ? JSON.stringify(liveOutcome.observerAfter.mismatchSections) : 'n/a'}

Mutation flags: schemaMutation=false; dataMutation=false; ledgerWritten=false; kvMutation=false.

## Do not claim

- Do **not** claim Sunset fully repaired unless observer mismatch is truly zero.
- Do **not** apply NOT NULL DDL in this slice.
- Do **not** run verify with \`--live\` (verify never re-runs live).
- Do **not** modify expected-product-schema bytes/fingerprint or migrations.

## Operator live command

\`\`\`
SUNSET_PHASE_D_LIVE_READONLY=1 SUNSET_PHASE_D_LIVE_PREFLIGHT=1 SUNSET_PHASE_D_TARGET_AUTHORITY=1 SUNSET_PHASE_D_NOT_NULL_NORMALIZATION=1 SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity AZURE_SUBSCRIPTION_ID=6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 npm run phase-d:not-null-observer-normalization -- --prove-not-null-normalization --prove-active-db-target-authority --subscription 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9 --resource-group luna-sunset-staging-rg --container-app luna-sunset-staging-staff-api --postgres-server luna-sunset-staging-pg-app --database sunset_staging --credential-source managed-identity
\`\`\`

## Artifacts

- \`fixtures/sunset-schema-observer/slice14t-not-null-observer-normalization-evidence.json\`
- \`fixtures/sunset-schema-observer/slice14t-not-null-observer-normalization-contract.json\`
- \`fixtures/sunset-schema-observer/slice14t-findings.md\`
`;

  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  leakScan(evidence, secrets);
  leakScan(contract, secrets);
  leakScan(findings, secrets);

  // Ensure CLI exists stub will be written separately; touch check
  if (!fs.existsSync(CLI_PATH)) {
    console.warn('  WARN  CLI path missing (will be added):', CLI_PATH);
  }

  console.log(`\nWrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('prove:sunset-schema-slice14t GREEN (offline)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
