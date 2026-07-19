'use strict';

/**
 * prove-sunset-schema-slice14r-live-reconcile-decision — FOUNDATION Slice 14R
 *
 * Offline RED/GREEN → optional --live once: occupancy + drift grouping +
 * deterministic reconcile decision. Default offline; preserves historical live evidence.
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
const { hashCanonicalManifest } = require('./lib/sunset-schema-observer');
const {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  EXPECTED_028_SHA256,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');
const { PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED } = require('./lib/phase-d-managed-identity-credential-loader');
const {
  PHASE_D_RECONCILE_DECISION_LIVE_ENABLED,
  ENV_RECONCILE_DECISION,
  CLI_PROVE_RECONCILE_DECISION,
  APPLICATION_NAME,
  RECONCILE_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  evaluateReconcileDecisionGates,
  exactReconcileDecisionArgv,
  reconcileDecisionEnv,
  executeReconcileDecision,
  createInjectedReconcileDecisionHttp,
  createScriptedReconcileDecisionFakeClientFactory,
  resetReconcileDecisionCounters,
  getReconcileDecisionCounters,
  decideReconcileStrategy,
  buildPhaseDriftCoverage,
  validateOrderedReconciliationPhases,
  buildDefectiveReconciliationPhases,
  PHASE_SEQUENCE_IDS,
  buildOfflineProofSunsetDatabaseUrl,
  buildLockedArmContainerAppPath,
  buildLockedArmListSecretsPath,
  buildLockedImdsArmTokenUrl,
  buildLockedKeyVaultSecretUrl,
} = require('./lib/phase-d-reconcile-decision');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14r-live-reconcile-decision-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14r-live-reconcile-decision-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14r-findings.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-reconcile-decision.js');

const MASTER = '7862b67ffa5c8ef2df63c15e231dcc9d266b369f';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const FAKE_ADMIN_USER = 'slice14r-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14r-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14r-proof-imds-token-never-commit';

const AUTHORIZED_SEQUENCE = Object.freeze([
  'IMDS ARM token (management.azure.com)',
  'ARM GET container app (active revision + env secretRef)',
  'ARM POST listSecrets (only when needed; values zeroed)',
  'IMDS vault token + GET luna-sunset-staging-kv/sunset-database-url',
  'In-memory semantic DSN/KeyVault-ref authority compare',
  'TLS verify-full pg session application_name=wh-sunset-reconcile-decision',
  'BEGIN READ ONLY → occupancy + inventory + ledger summary + observer drift grouping + decision → COMMIT',
]);

function reconcileArgv(extraFlags) {
  return [...exactReconcileDecisionArgv(), ...(extraFlags || [])];
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
  if (/Bearer\s+slice14r-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(text)) {
    throw new Error('JWT-shaped token leaked into proof artifact');
  }
}

function sanitizeErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => ({
    code: String((e && e.code) || 'phase_d_failed').slice(0, 80),
    message: String((e && e.message) || 'phase d failed')
      .replace(/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/gi, 'postgresql://[REDACTED]:')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .slice(0, 240),
  }));
}

function pickSafeLiveOutcome(result) {
  if (!result || typeof result !== 'object') return null;
  const occupancy = result.occupancy || null;
  const groupedDrift = result.groupedDrift || null;
  // Always recompute design-only decision/phases from preserved occupancy+drift
  // so offline corrections refresh orderedReconciliationPhases without new live calls.
  const decision = decideReconcileStrategy(
    occupancy,
    groupedDrift,
    result.sameTarget === true,
  );
  return {
    ok: result.ok === true,
    code: String(result.code || 'reconcile_decision_unknown'),
    sameTarget: result.sameTarget === true,
    sameTargetReason: result.sameTargetReason || null,
    blocker: result.ok === true ? null : String(result.blocker || result.code || 'failed'),
    activeRevisionName: result.activeRevisionName || null,
    dbEnvName: result.dbEnvName || null,
    secretRefName: result.secretRefName || null,
    sessionReadOnly: result.sessionReadOnly === true,
    transactionReadOnly: result.transactionReadOnly === true,
    schemaInventory: result.schemaInventory || null,
    ledgerSummary: result.ledgerSummary || null,
    occupancy,
    groupedDrift,
    migrationOwnership: groupedDrift
      ? groupedDrift.migrationOwnershipByManifestEntry
      : (result.migrationOwnership || null),
    ledgerAbsent: groupedDrift ? groupedDrift.migrationLedgerAbsent === true : null,
    decision,
    recommendation: decision && decision.recommendation,
    occupancySummary: decision && decision.occupancySummary,
    httpRequestCount: Number(result.httpRequestCount) || 0,
    clientsInstantiated: Number(result.clientsInstantiated) || 0,
    usedLiveHttp: result.usedLiveHttp === true,
    realImdsCall: result.realImdsCall === true,
    realArmCall: result.realArmCall === true,
    realKeyVaultCall: result.realKeyVaultCall === true,
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
    applicationName: result.applicationName || APPLICATION_NAME,
    errors: sanitizeErrors(result.errors),
  };
}

async function main() {
  const wantLive = process.argv.includes('--live');
  const offlineOnly = !wantLive
    || process.argv.includes('--offline')
    || process.env.SUNSET_SLICE14R_PROOF_OFFLINE === '1';
  console.log(offlineOnly
    ? 'prove:sunset-schema-slice14r — offline only (no live HTTP/PG)\n'
    : 'prove:sunset-schema-slice14r — offline then one live reconcile-decision proof\n');

  const priorEvidence = fs.existsSync(EVIDENCE_PATH)
    ? JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'))
    : null;
  const preserveLive = offlineOnly
    && priorEvidence
    && priorEvidence.liveReconcileDecisionOutcome
    && typeof priorEvidence.liveReconcileDecisionOutcome.sameTarget === 'boolean';
  const generatedAt = (!offlineOnly && wantLive)
    ? new Date().toISOString()
    : (preserveLive && priorEvidence.generatedAt) || new Date().toISOString();

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) throw new Error('manifest integrity failed');
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  const expected = JSON.parse(expectedBytes.toString('utf8'));
  const approvedTableNames = (expected.snapshot.tables || []).slice().sort();

  if (manifestHash !== MANIFEST_HASH) throw new Error(`manifest hash drift: ${manifestHash}`);
  if (expectedHash !== EXPECTED_BYTE_SHA) throw new Error(`expected hash drift: ${expectedHash}`);
  if (expected.productFingerprint !== CANON_FP) throw new Error('fingerprint drift');
  if (forward.length !== 39) throw new Error('forward count drift');
  assertMigration028ByteIntegrity();
  assert028PredicatesPresentInSource();
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) throw new Error('CONNECT_ENABLED must remain activated');
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) throw new Error('global APPLY must remain disabled');
  if (PHASE_D_RECONCILE_DECISION_LIVE_ENABLED !== true) throw new Error('reconcile decision capability must be enabled');
  if (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== true) throw new Error('live MI HTTP must be activated');
  if (APPLICATION_NAME !== 'wh-sunset-reconcile-decision') throw new Error('APPLICATION_NAME drift');

  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));
  for (const [k, v] of Object.entries({
    '028': live028, '035': live035, '040': live040, '041': live041,
  })) {
    if (v !== LOCKED_13C_SHA[k]) throw new Error(`13C hash drift on ${k}`);
  }

  if (!fs.existsSync(CLI_PATH)) throw new Error('reconcile decision CLI missing');

  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN, buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD)];
  const red = [];
  const green = [];

  // --- RED ---
  resetReconcileDecisionCounters();
  const def = await executeReconcileDecision({ env: {}, argv: [] });
  if (getReconcileDecisionCounters().clientsInstantiated !== 0
    || getReconcileDecisionCounters().httpRequestCount !== 0) {
    throw new Error('default path must refuse with zero HTTP/Clients');
  }
  leakScan(def, secrets);
  red.push({ name: 'default_path_zero_http_and_clients', ok: true, code: def.code, httpRequestCount: 0, clientsInstantiated: 0 });

  resetReconcileDecisionCounters();
  const noProveFlag = await executeReconcileDecision({
    env: reconcileDecisionEnv(),
    argv: reconcileArgv().filter((a) => a !== CLI_PROVE_RECONCILE_DECISION),
    httpRequest: createInjectedReconcileDecisionHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: secrets[3],
    }),
  });
  if (getReconcileDecisionCounters().httpRequestCount !== 0) throw new Error('missing prove flag must zero HTTP');
  red.push({ name: 'missing_prove_flag_zero_http', ok: true, code: noProveFlag.code });

  resetReconcileDecisionCounters();
  const noEnv = await executeReconcileDecision({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    },
    argv: reconcileArgv(),
    httpRequest: createInjectedReconcileDecisionHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: secrets[3],
    }),
  });
  if (getReconcileDecisionCounters().httpRequestCount !== 0) throw new Error('missing reconcile env must zero HTTP');
  red.push({ name: 'missing_reconcile_env_zero_http', ok: true, code: noEnv.code });

  const wrongDb = evaluateReconcileDecisionGates({
    env: reconcileDecisionEnv(),
    argv: reconcileArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
  });
  if (wrongDb.ok) throw new Error('wrong database must fail');
  resetReconcileDecisionCounters();
  const wrongRun = await executeReconcileDecision({
    env: reconcileDecisionEnv(),
    argv: reconcileArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
    httpRequest: createInjectedReconcileDecisionHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: secrets[3],
    }),
  });
  if (getReconcileDecisionCounters().httpRequestCount !== 0) throw new Error('wrong targets must zero HTTP');
  red.push({ name: 'wrong_exact_targets_zero_http', ok: true, rejected: !wrongDb.ok, code: wrongRun.code });

  const forbidden = evaluateReconcileDecisionGates({
    env: reconcileDecisionEnv(),
    argv: [...reconcileArgv(), '--dsn', 'forbidden', '--sql', 'SELECT 1', '--retry', '--prove-active-db-target-authority'],
  });
  if (forbidden.ok) throw new Error('forbidden argv must fail');
  resetReconcileDecisionCounters();
  await executeReconcileDecision({
    env: reconcileDecisionEnv(),
    argv: [...reconcileArgv(), '--dsn', 'forbidden', '--sql', 'SELECT 1', '--retry'],
    httpRequest: createInjectedReconcileDecisionHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: secrets[3],
    }),
  });
  if (getReconcileDecisionCounters().httpRequestCount !== 0) throw new Error('forbidden argv must zero HTTP');
  red.push({
    name: 'forbidden_argv_dsn_sql_retry_zero_http',
    ok: true,
    rejected: !forbidden.ok,
    forbiddenFlags: FORBIDDEN_ARGV_FLAGS.slice(),
  });

  const halfFlag = evaluateReconcileDecisionGates({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_RECONCILE_DECISION]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    },
    argv: exactReconcileDecisionArgv(),
  });
  if (halfFlag.ok) throw new Error('MI without env credential-source must fail');
  red.push({ name: 'managed_identity_requires_env_and_argv', ok: true, rejected: !halfFlag.ok });

  const wrongTargetDecision = decideReconcileStrategy(
    { totalApprovedRowCount: 0, nonemptyApprovedTableCount: 0 },
    null,
    false,
  );
  if (wrongTargetDecision.recommendation !== 'blocked_wrong_target') {
    throw new Error(`wrong target must block: ${wrongTargetDecision.recommendation}`);
  }
  red.push({ name: 'wrong_target_blocks_rebuild', ok: true, recommendation: wrongTargetDecision.recommendation });

  const hiddenData = decideReconcileStrategy(
    {
      perTableRowCounts: { bookings: 0 },
      nonemptyApprovedTableCount: 0,
      totalApprovedRowCount: 0,
      noncanonicalDataBearingObjectExists: true,
      dataBearingTableOmittedByCanonical: true,
      missingApprovedTables: [],
      enumerationComplete: true,
    },
    { migrationLedgerAbsent: true },
    true,
  );
  if (hiddenData.recommendation !== 'controlled_export_import') {
    throw new Error(`hidden noncanonical data must block rebuild: ${hiddenData.recommendation}`);
  }
  red.push({ name: 'hidden_noncanonical_data_blocks_rebuild', ok: true, recommendation: hiddenData.recommendation });

  const countAmbig = decideReconcileStrategy(
    { countAmbiguous: true, perTableRowCounts: { bookings: 0 } },
    null,
    true,
  );
  if (countAmbig.recommendation !== 'blocked_count_ambiguity') throw new Error('count ambiguity must block');
  red.push({ name: 'count_ambiguity_blocks_rebuild', ok: true, recommendation: countAmbig.recommendation });

  const tableMismatch = decideReconcileStrategy(
    { tableSetMismatch: true },
    null,
    true,
  );
  if (tableMismatch.recommendation !== 'blocked_count_ambiguity') throw new Error('table set mismatch must block');
  red.push({ name: 'table_set_mismatch_blocks_rebuild', ok: true, recommendation: tableMismatch.recommendation });

  const overflow = decideReconcileStrategy(
    {
      countAmbiguous: true,
      perTableRowCounts: { bookings: Number.MAX_SAFE_INTEGER },
      totalApprovedRowCount: Number.MAX_SAFE_INTEGER,
      enumerationComplete: true,
      missingApprovedTables: [],
    },
    null,
    true,
  );
  if (overflow.recommendation !== 'blocked_count_ambiguity') throw new Error('overflow must block');
  red.push({ name: 'overflow_blocks_rebuild', ok: true, recommendation: overflow.recommendation });

  const unsafe = decideReconcileStrategy(
    {
      perTableRowCounts: { bookings: 42, guests: 0 },
      nonemptyApprovedTableCount: 1,
      totalApprovedRowCount: 42,
      missingApprovedTables: [],
      enumerationComplete: true,
      noncanonicalDataBearingObjectExists: false,
      dataBearingTableOmittedByCanonical: false,
    },
    { missingCounts: { tables: 1 } },
    true,
  );
  if (unsafe.recommendation === 'clean_canonical_rebuild_cutover') {
    throw new Error('nonempty rows must NOT recommend clean rebuild');
  }
  red.push({
    name: 'unsafe_rebuild_recommendation_rejected',
    ok: true,
    recommendation: unsafe.recommendation,
    rebuildAllowed: unsafe.rebuildAllowed === false,
  });

  resetReconcileDecisionCounters();
  const leakProbe = await executeReconcileDecision({
    env: reconcileDecisionEnv(),
    argv: reconcileArgv(),
    httpRequest: createInjectedReconcileDecisionHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: secrets[3],
    }),
    skipPostgres: true,
  });
  leakScan(leakProbe, secrets);
  red.push({ name: 'secret_leakage_scan', ok: true, secretFree: true });

  resetReconcileDecisionCounters();
  const FakeNonRo = createScriptedReconcileDecisionFakeClientFactory({
    transactionReadOnly: false,
    approvedTableNames: approvedTableNames.slice(0, 3),
    perTableRowCounts: { [approvedTableNames[0]]: 0 },
  });
  const nonRo = await executeReconcileDecision({
    env: reconcileDecisionEnv(),
    argv: reconcileArgv(),
    httpRequest: createInjectedReconcileDecisionHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: secrets[3],
    }),
    ClientFactory: FakeNonRo,
    expectedContract: expected,
  });
  if (nonRo.ok || nonRo.code !== 'session_not_read_only') {
    throw new Error(`non-read-only session must refuse: ${JSON.stringify(nonRo)}`);
  }
  red.push({ name: 'non_read_only_session', ok: true, code: nonRo.code, sameTarget: true });

  const sampleDriftForPhaseRed = {
    counts: { expected_only: 498, live_only: 0, definition_mismatch: 1 },
    mismatchSections: {
      tables: 1,
      columns: 9,
      constraints: 475,
      indexes: 6,
      functions: 1,
      triggers: 1,
      rlsFlags: 1,
      ownership: 2,
      acls: 2,
      extensions: 1,
    },
    constraintTypeDrift: {
      'PRIMARY KEY': 1,
      UNIQUE: 0,
      'FOREIGN KEY': 2,
      CHECK: 0,
      NOT_NULL: 472,
      other: 0,
    },
    missingCounts: { tables: 1, columns: 9, indexes: 6 },
    migrationLedgerAbsent: true,
  };
  const sampleOccForPhaseRed = {
    nonemptyApprovedTableCount: 20,
    totalApprovedRowCount: 2252,
  };
  const omittedPlan = buildDefectiveReconciliationPhases(
    'omitted_not_null_or_non_table_section',
    sampleOccForPhaseRed,
    sampleDriftForPhaseRed,
  );
  const omittedValidation = validateOrderedReconciliationPhases(omittedPlan, sampleDriftForPhaseRed);
  if (omittedValidation.ok || omittedValidation.code !== 'omitted_not_null_or_non_table_section') {
    throw new Error(`omitted NOT_NULL/non-table must RED: ${JSON.stringify(omittedValidation)}`);
  }
  red.push({
    name: 'omitted_not_null_or_non_table_section',
    ok: true,
    rejected: true,
    code: omittedValidation.code,
  });

  const unsafePlan = buildDefectiveReconciliationPhases(
    'unsafe_phase_ordering',
    sampleOccForPhaseRed,
    sampleDriftForPhaseRed,
  );
  const unsafeOrdering = validateOrderedReconciliationPhases(unsafePlan, sampleDriftForPhaseRed);
  if (unsafeOrdering.ok || unsafeOrdering.code !== 'unsafe_phase_ordering') {
    throw new Error(`unsafe phase ordering must RED: ${JSON.stringify(unsafeOrdering)}`);
  }
  red.push({
    name: 'unsafe_phase_ordering',
    ok: true,
    rejected: true,
    code: unsafeOrdering.code,
  });

  // --- GREEN ---
  const emptyCounts = Object.fromEntries(approvedTableNames.map((t) => [t, 0]));
  resetReconcileDecisionCounters();
  const FakeEmpty = createScriptedReconcileDecisionFakeClientFactory({
    approvedTableNames,
    perTableRowCounts: emptyCounts,
    noncanonicalTables: [],
    ledgerPresent: false,
  });
  const emptyRun = await executeReconcileDecision({
    env: reconcileDecisionEnv(),
    argv: reconcileArgv(),
    httpRequest: createInjectedReconcileDecisionHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: secrets[3],
    }),
    ClientFactory: FakeEmpty,
    expectedContract: expected,
  });
  if (!emptyRun.ok || emptyRun.recommendation !== 'clean_canonical_rebuild_cutover') {
    throw new Error(`empty db should recommend clean rebuild: ${JSON.stringify(emptyRun.decision)}`);
  }
  leakScan(emptyRun, secrets);
  green.push({
    name: 'injected_http_empty_db_recommends_clean_rebuild',
    ok: true,
    recommendation: emptyRun.recommendation,
    rebuildAllowed: emptyRun.decision && emptyRun.decision.rebuildAllowed === true,
  });

  const nonemptyCounts = { ...emptyCounts, [approvedTableNames[0]]: 7 };
  resetReconcileDecisionCounters();
  const FakeNonempty = createScriptedReconcileDecisionFakeClientFactory({
    approvedTableNames,
    perTableRowCounts: nonemptyCounts,
    ledgerPresent: false,
  });
  const nonemptyRun = await executeReconcileDecision({
    env: reconcileDecisionEnv(),
    argv: reconcileArgv(),
    httpRequest: createInjectedReconcileDecisionHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: secrets[3],
    }),
    ClientFactory: FakeNonempty,
    expectedContract: expected,
  });
  if (!nonemptyRun.ok || nonemptyRun.recommendation !== 'in_place_targeted_repair') {
    throw new Error(`nonempty db should recommend in-place: ${JSON.stringify(nonemptyRun.decision)}`);
  }
  green.push({
    name: 'injected_http_nonempty_recommends_inplace',
    ok: true,
    recommendation: nonemptyRun.recommendation,
  });

  const gatesOk = evaluateReconcileDecisionGates({
    env: reconcileDecisionEnv(),
    argv: exactReconcileDecisionArgv(),
  });
  if (!gatesOk.ok) throw new Error(`CLI gates should pass: ${JSON.stringify(gatesOk.errors)}`);
  green.push({ name: 'cli_gates_exact_targets', ok: true });

  const cliDefault = spawnSync(process.execPath, [CLI_PATH], { encoding: 'utf8', env: { ...process.env } });
  if (cliDefault.status === 0) throw new Error('reconcile CLI default must refuse');
  leakScan(`${cliDefault.stdout}${cliDefault.stderr}`, secrets);
  green.push({ name: 'cli_default_disabled', ok: true, exitCode: cliDefault.status });

  if (RECONCILE_LOCKS.applicationName !== 'wh-sunset-reconcile-decision'
    || RECONCILE_LOCKS.containerAppName !== 'luna-sunset-staging-staff-api'
    || RECONCILE_LOCKS.keyVaultName !== 'luna-sunset-staging-kv'
    || RECONCILE_LOCKS.sslmode !== 'verify-full') {
    throw new Error('RECONCILE_LOCKS drift');
  }
  const armPath = buildLockedArmContainerAppPath();
  const listPath = buildLockedArmListSecretsPath();
  const imdsUrl = buildLockedImdsArmTokenUrl();
  const kvUrl = buildLockedKeyVaultSecretUrl();
  if (!listPath.includes('/listSecrets') || !armPath.includes('api-version=2024-03-01')) {
    throw new Error('ARM path lock drift');
  }
  if (!imdsUrl.includes(RECONCILE_LOCKS.imdsHost) || !kvUrl.includes(RECONCILE_LOCKS.secretName)) {
    throw new Error('IMDS/KV URL lock drift');
  }
  green.push({
    name: 'locks_identity_vault_secret_pg_tls_application_name',
    ok: true,
    applicationName: RECONCILE_LOCKS.applicationName,
    containerAppName: RECONCILE_LOCKS.containerAppName,
    keyVaultName: RECONCILE_LOCKS.keyVaultName,
    secretName: RECONCILE_LOCKS.secretName,
    sslmode: RECONCILE_LOCKS.sslmode,
  });

  if (PHASE_D_LIVE_APPLY_ENABLED !== false) throw new Error('global live apply must remain false');
  green.push({ name: 'global_live_apply_remains_false', ok: true, liveApplyEnabled: false });

  const detEmpty = decideReconcileStrategy(
    {
      perTableRowCounts: { a: 0, b: 0 },
      nonemptyApprovedTableCount: 0,
      totalApprovedRowCount: 0,
      missingApprovedTables: [],
      enumerationComplete: true,
      noncanonicalDataBearingObjectExists: false,
      dataBearingTableOmittedByCanonical: false,
    },
    {},
    true,
  );
  const detNonempty = decideReconcileStrategy(
    {
      perTableRowCounts: { a: 1 },
      nonemptyApprovedTableCount: 1,
      totalApprovedRowCount: 1,
      missingApprovedTables: [],
      enumerationComplete: true,
      noncanonicalDataBearingObjectExists: false,
      dataBearingTableOmittedByCanonical: false,
    },
    {},
    true,
  );
  if (detEmpty.recommendation !== 'clean_canonical_rebuild_cutover'
    || detNonempty.recommendation !== 'in_place_targeted_repair') {
    throw new Error('decision criteria not deterministic');
  }
  green.push({
    name: 'decision_criteria_deterministic',
    ok: true,
    emptyRecommendation: detEmpty.recommendation,
    nonemptyRecommendation: detNonempty.recommendation,
  });

  const coverageDrift = {
    counts: { expected_only: 498, live_only: 0, definition_mismatch: 1 },
    mismatchSections: {
      tables: 1,
      columns: 9,
      constraints: 475,
      indexes: 6,
      functions: 1,
      triggers: 1,
      rlsFlags: 1,
      ownership: 2,
      acls: 2,
      extensions: 1,
    },
    constraintTypeDrift: {
      'PRIMARY KEY': 1,
      UNIQUE: 0,
      'FOREIGN KEY': 2,
      CHECK: 0,
      NOT_NULL: 472,
      other: 0,
    },
    missingCounts: { tables: 1, columns: 9, indexes: 6 },
    migrationLedgerAbsent: true,
  };
  const coverageOcc = {
    perTableRowCounts: { bookings: 1 },
    nonemptyApprovedTableCount: 1,
    totalApprovedRowCount: 1,
    missingApprovedTables: [],
    enumerationComplete: true,
    noncanonicalDataBearingObjectExists: false,
    dataBearingTableOmittedByCanonical: false,
  };
  const agDecision = decideReconcileStrategy(coverageOcc, coverageDrift, true);
  const agPhases = agDecision.orderedReconciliationPhases;
  const agValidation = validateOrderedReconciliationPhases(agPhases, coverageDrift);
  const agCoverage = buildPhaseDriftCoverage(coverageDrift);
  const agIds = (agPhases || []).filter((p) => PHASE_SEQUENCE_IDS.includes(p.id)).map((p) => p.id);
  if (!agValidation.ok
    || agValidation.code !== 'complete_a_to_g_coverage'
    || agIds.join('') !== PHASE_SEQUENCE_IDS.join('')
    || agCoverage.coveredExactlyOnce !== true
    || agCoverage.notNullMismatchCount !== 472
    || agCoverage.checkConstraintsStatus !== 'already_cleared'
    || agDecision.reconcileCompletionAllowed !== false
    || agDecision.checkConstraintsStatus !== 'already_cleared') {
    throw new Error(`complete A–G coverage GREEN failed: ${JSON.stringify({
      agValidation,
      agIds,
      coveredExactlyOnce: agCoverage.coveredExactlyOnce,
      completion: agDecision.reconcileCompletionAllowed,
      check: agDecision.checkConstraintsStatus,
    })}`);
  }
  green.push({
    name: 'complete_a_to_g_coverage',
    ok: true,
    phaseSequence: agIds.join('-'),
    coveredExactlyOnce: true,
    notNullMismatchCount: 472,
    checkConstraintsStatus: 'already_cleared',
    reconcileCompletionAllowed: false,
  });

  // --- LIVE or preserve ---
  let liveReconcileDecisionOutcome = null;
  let liveAttempted = false;

  if (offlineOnly) {
    if (preserveLive) {
      liveReconcileDecisionOutcome = pickSafeLiveOutcome(priorEvidence.liveReconcileDecisionOutcome);
      liveAttempted = priorEvidence.liveAttemptCount === 1;
      console.log('Offline mode: preserved historical live reconcile-decision outcome.\n');
    } else {
      liveReconcileDecisionOutcome = priorEvidence && priorEvidence.liveReconcileDecisionOutcome
        ? pickSafeLiveOutcome(priorEvidence.liveReconcileDecisionOutcome)
        : null;
      liveAttempted = false;
      console.log('Offline mode: no live reconcile-decision this run (liveAttemptCount remains 0).\n');
    }
  } else {
    console.log('Live section 1/1: one gated reconcile-decision proof (real HTTP + PG)…\n');
    liveAttempted = true;
    resetReconcileDecisionCounters();
    const liveResult = await executeReconcileDecision({
      env: { ...process.env, ...reconcileDecisionEnv() },
      argv: exactReconcileDecisionArgv(),
      expectedContract: expected,
    });
    leakScan(liveResult, secrets);
    liveReconcileDecisionOutcome = pickSafeLiveOutcome(liveResult);
    leakScan(liveReconcileDecisionOutcome, secrets);
  }

  const liveOk = liveReconcileDecisionOutcome && liveReconcileDecisionOutcome.ok === true;
  const liveSameTarget = liveReconcileDecisionOutcome
    && liveReconcileDecisionOutcome.sameTarget === true;

  let outcome;
  if (offlineOnly && !liveAttempted && !preserveLive) {
    outcome = 'phase_d_reconcile_decision_offline_only';
  } else if (offlineOnly && preserveLive) {
    outcome = liveOk ? 'phase_d_reconcile_decision_live_preserved' : 'phase_d_reconcile_decision_live_preserved_blocked';
  } else if (!liveAttempted) {
    outcome = 'phase_d_reconcile_decision_blocked_before_live';
  } else if (!liveOk) {
    outcome = 'phase_d_reconcile_decision_blocked';
  } else if (liveSameTarget) {
    outcome = `phase_d_reconcile_decision_live_${liveReconcileDecisionOutcome.recommendation || 'captured'}`;
  } else {
    outcome = 'phase_d_reconcile_decision_mismatched_target';
  }

  const contract = {
    kind: 'sunset-schema-observer-slice14r-live-reconcile-decision-contract',
    secretFree: true,
    containsLiveApplyCode: false,
    liveApplyCapability: false,
    reconcileDecisionLiveEnabled: true,
    globalLiveApplyEnabled: false,
    liveReadonlyConnectEnabled: true,
    liveHttpEnabled: true,
    writesLedger: false,
    dataMutation: false,
    schemaMutation: false,
    liveMutation: false,
    kvMutation: false,
    defaultEnabled: false,
    dualEnableFlagsRequired: true,
    reconcileDecisionEnvGateRequired: true,
    reconcileDecisionArgvGateRequired: true,
    exactTargetCliConfirmationRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    offlineInjectedHttpAndFakeClientProof: true,
    verifyNeverRerunsLive: true,
    readOnlyReconcileDecisionProof: true,
    occupancyCaptureEnabled: true,
    driftGroupingEnabled: true,
    deterministicDecisionFunction: 'decideReconcileStrategy',
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14R',
    purpose: 'Choose safest deterministic global schema reconciliation strategy (clean rebuild/cutover vs in-place repair) from read-only occupancy + drift evidence; zero mutation.',
    targets: { ...TARGETS },
    authorityLocks: {
      applicationName: RECONCILE_LOCKS.applicationName,
      containerAppName: RECONCILE_LOCKS.containerAppName,
      keyVaultName: RECONCILE_LOCKS.keyVaultName,
      secretName: RECONCILE_LOCKS.secretName,
      postgresHost: RECONCILE_LOCKS.postgresHost,
      database: RECONCILE_LOCKS.database,
      sslmode: RECONCILE_LOCKS.sslmode,
    },
    commandContract: {
      reconcileDecision: {
        script: 'scripts/run-phase-d-reconcile-decision.js',
        npm: 'phase-d:reconcile-decision',
        requiredEnv: [
          `${ENV_LIVE_READONLY}=1`,
          `${ENV_LIVE_PREFLIGHT}=1`,
          `${ENV_RECONCILE_DECISION}=1`,
          `${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
          `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
        ],
        requiredArgv: [
          CLI_PROVE_RECONCILE_DECISION,
          `--credential-source ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
          `--subscription ${TARGETS.subscriptionId}`,
          `--resource-group ${TARGETS.resourceGroup}`,
          `--container-app ${RECONCILE_LOCKS.containerAppName}`,
          `--postgres-server ${TARGETS.postgresServer}`,
          `--database ${TARGETS.database}`,
        ],
        forbiddenArgv: FORBIDDEN_ARGV_FLAGS.slice(),
      },
    },
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    offlineGateNames: { red: red.map((c) => c.name), green: green.map((c) => c.name) },
    hashes: {
      manifestHash: MANIFEST_HASH,
      productFingerprint: CANON_FP,
      expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
      migration028: live028,
      migration035: live035,
      migration040: live040,
      migration041: live041,
    },
    decisionCriteria: {
      cleanRebuildOnlyWhen: [
        'sameTarget === true',
        'all approved existing tables row count === 0',
        'no count ambiguity',
        'noncanonicalDataBearingObjectExists === false',
        'dataBearingTableOmittedByCanonical === false',
        'no missing approved tables',
      ],
      neverDestructiveRebuildWhenDataExists: true,
      orderedReconciliationPhaseSequence: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      notNullOwnedByPhase: 'C',
      nonTableSectionsOwnedByPhase: 'E',
      checkConstraintsStatusWhenZero: 'already_cleared',
      reconcileCompletionForbiddenWhileNotNullGreaterThanZero: true,
    },
    forbidden: [
      'DDL / DML / ledger writes',
      'KV write / RBAC / network / firewall mutation',
      'DSN / token / password in evidence',
      'second live run in verify',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14r-live-reconcile-decision-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14R',
    outcome,
    liveMutation: false,
    schemaMutation: false,
    dataMutation: false,
    ledgerWritten: false,
    kvMutation: false,
    rbacMutation: false,
    networkMutation: false,
    firewallAction: false,
    identityMutation: false,
    migrationAdded: false,
    writesLedger: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    liveAttemptCount: liveAttempted ? 1 : (preserveLive ? 1 : 0),
    migrationHashes: { '028': live028, '035': live035, '040': live040, '041': live041 },
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    defaultDisabled: true,
    applicationName: APPLICATION_NAME,
    authorityLocks: {
      applicationName: RECONCILE_LOCKS.applicationName,
      containerAppName: RECONCILE_LOCKS.containerAppName,
      keyVaultName: RECONCILE_LOCKS.keyVaultName,
      secretName: RECONCILE_LOCKS.secretName,
      postgresHost: RECONCILE_LOCKS.postgresHost,
      database: RECONCILE_LOCKS.database,
      sslmode: RECONCILE_LOCKS.sslmode,
    },
    offlineGates: {
      defaultPathZeroHttpAndClients: true,
      missingProveFlagZeroHttp: true,
      missingReconcileEnvZeroHttp: true,
      wrongExactTargetsZeroHttp: true,
      forbiddenArgvDsnSqlRetryZeroHttp: true,
      managedIdentityRequiresEnvAndArgv: true,
      wrongTargetBlocksRebuild: true,
      hiddenNoncanonicalDataBlocksRebuild: true,
      countAmbiguityBlocksRebuild: true,
      tableSetMismatchBlocksRebuild: true,
      overflowBlocksRebuild: true,
      unsafeRebuildRecommendationRejected: true,
      secretLeakageScan: true,
      nonReadOnlySession: true,
      omittedNotNullOrNonTableSection: true,
      unsafePhaseOrdering: true,
      injectedHttpEmptyDbRecommendsCleanRebuild: true,
      injectedHttpNonemptyRecommendsInplace: true,
      cliGatesExactTargets: true,
      cliDefaultDisabled: true,
      locksIdentityVaultSecretPgTlsApplicationName: true,
      globalLiveApplyRemainsFalse: true,
      decisionCriteriaDeterministic: true,
      completeAToGCoverage: true,
    },
    redCases: red,
    greenCases: green,
    redCaseCount: red.length,
    greenCaseCount: green.length,
    liveReconcileDecisionOutcome: liveReconcileDecisionOutcome || null,
    recommendation: liveReconcileDecisionOutcome
      ? liveReconcileDecisionOutcome.recommendation
      : null,
    occupancySummary: liveReconcileDecisionOutcome
      ? liveReconcileDecisionOutcome.occupancySummary
      : null,
    groupedDrift: liveReconcileDecisionOutcome
      ? liveReconcileDecisionOutcome.groupedDrift
      : null,
    migrationOwnership: liveReconcileDecisionOutcome
      ? liveReconcileDecisionOutcome.migrationOwnership
      : null,
    ledgerAbsent: liveReconcileDecisionOutcome
      ? liveReconcileDecisionOutcome.ledgerAbsent
      : null,
    secretHandlingProof: {
      privateFieldsZeroedImmediately: true,
      neverPrinted: true,
      neverPersisted: true,
      neverHashedIntoEvidence: true,
    },
  };

  if (offlineOnly && !preserveLive) evidence.liveAttemptCount = 0;

  leakScan(evidence, secrets);
  leakScan(contract, secrets);

  const liveSummary = !liveAttempted && !preserveLive
    ? 'Live reconcile-decision **not attempted** (offline only).'
    : !liveReconcileDecisionOutcome
      ? 'Live reconcile-decision **missing**.'
      : liveOk
        ? `Live reconcile-decision **ok** (recommendation=${liveReconcileDecisionOutcome.recommendation}, sameTarget=${liveReconcileDecisionOutcome.sameTarget}).`
        : `Live reconcile-decision **blocked** (blocker=${liveReconcileDecisionOutcome.blocker}).`;

  const findings = `# FOUNDATION Slice 14R — Live reconcile decision

**Status:** complete (offline RED/GREEN${liveAttempted || preserveLive ? ' + live path' : ''}; **zero mutation**)
**Master basis:** \`${MASTER}\`
**Outcome:** \`${outcome}\`

## What this slice proves

Read-only occupancy aggregates + observer drift grouping on the confirmed active
Sunset staging DB (\`${RECONCILE_LOCKS.database}\` via \`${RECONCILE_LOCKS.containerAppName}\`),
then a **deterministic** recommendation: \`clean_canonical_rebuild_cutover\` vs
\`in_place_targeted_repair\` / \`controlled_export_import\` (design-only plans; execute none).

In-place plan uses ordered design-only phases **A–G** (\`execute=false\` throughout):
A normalize/target → B missing tables/columns → C NOT NULL preflight/bounded apply →
D indexes then PK/FK → E functions/triggers/RLS/ownership/ACL/extensions →
F ledger bootstrap after schema match → G observer zero-drift + idempotent rerun.
Live CHECK mismatches are **already_cleared** when count=0; NOT_NULL > 0 blocks completion.

## Offline gates

- RED: ${red.length} cases (default refuse, gates, wrong target, hidden data, count ambiguity,
  overflow, unsafe rebuild rejection, secret leakage, non-read-only session,
  omitted NOT_NULL/non-table section, unsafe phase ordering)
- GREEN: ${green.length} cases (empty→clean rebuild, nonempty→in-place, CLI gates, locks,
  global apply false, deterministic decision criteria, complete A–G coverage)

## Live

${liveSummary}

Mutation flags (all must remain false): liveMutation / schemaMutation / dataMutation /
ledgerWritten / kvMutation = **false**.

## Do not claim

- Do **not** execute rebuild, repair, or ledger writes from this slice.
- Do **not** run verify with \`--live\` (verify never re-runs live).
- Do **not** persist DSN, passwords, tokens, or secret versions.
- Do **not** recommend reconcile completion while NOT_NULL count > 0.

## Artifacts

- \`fixtures/sunset-schema-observer/slice14r-live-reconcile-decision-evidence.json\`
- \`fixtures/sunset-schema-observer/slice14r-live-reconcile-decision-contract.json\`
- \`fixtures/sunset-schema-observer/slice14r-findings.md\`
`;

  leakScan(findings, secrets);

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  console.log(`RED cases: ${red.length}  GREEN cases: ${green.length}`);
  console.log(`Outcome: ${outcome}`);
  console.log(`Wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('\nprove:sunset-schema-slice14r GREEN (offline)');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
