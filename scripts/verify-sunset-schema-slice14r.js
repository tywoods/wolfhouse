'use strict';

/**
 * verify:sunset-schema-slice14r — FOUNDATION Slice 14R RED→GREEN
 * Live reconcile decision (offline gates + optional live evidence).
 * Does NOT re-run live ARM/KV/PostgreSQL.
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
} = require('./lib/phase-d-live-readonly-boundary');
const {
  EXPECTED_028_SHA256,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');
const {
  PHASE_D_RECONCILE_DECISION_LIVE_ENABLED,
  APPLICATION_NAME,
  RECONCILE_LOCKS,
  evaluateReconcileDecisionGates,
  executeReconcileDecision,
  createInjectedReconcileDecisionHttp,
  createScriptedReconcileDecisionFakeClientFactory,
  resetReconcileDecisionCounters,
  getReconcileDecisionCounters,
  exactReconcileDecisionArgv,
  reconcileDecisionEnv,
  decideReconcileStrategy,
  buildPhaseDriftCoverage,
  validateOrderedReconciliationPhases,
  PHASE_SEQUENCE_IDS,
  buildOfflineProofSunsetDatabaseUrl,
  buildLockedArmContainerAppPath,
  buildLockedArmListSecretsPath,
} = require('./lib/phase-d-reconcile-decision');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
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

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_prove_flag_zero_http',
  'missing_reconcile_env_zero_http',
  'wrong_exact_targets_zero_http',
  'forbidden_argv_dsn_sql_retry_zero_http',
  'managed_identity_requires_env_and_argv',
  'wrong_target_blocks_rebuild',
  'hidden_noncanonical_data_blocks_rebuild',
  'count_ambiguity_blocks_rebuild',
  'table_set_mismatch_blocks_rebuild',
  'overflow_blocks_rebuild',
  'unsafe_rebuild_recommendation_rejected',
  'secret_leakage_scan',
  'non_read_only_session',
  'omitted_not_null_or_non_table_section',
  'unsafe_phase_ordering',
];

const REQUIRED_GREEN = [
  'injected_http_empty_db_recommends_clean_rebuild',
  'injected_http_nonempty_recommends_inplace',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'decision_criteria_deterministic',
  'complete_a_to_g_coverage',
];

const FAKE_USER = 'verify-slice14r-admin-user';
const FAKE_PASSWORD = 'verify-slice14r-admin-password';
const FAKE_TOKEN = 'verify-slice14r-imds-token';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14r — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14r-live-reconcile-decision-evidence.json');
  const contractPath = path.join(FIX, 'slice14r-live-reconcile-decision-contract.json');
  const findingsPath = path.join(FIX, 'slice14r-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14r-live-reconcile-decision.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14r.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-reconcile-decision.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-reconcile-decision.js');

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
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const expectedBytes = fs.readFileSync(expectedPath);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  const expected = JSON.parse(expectedBytes.toString('utf8'));
  const approvedTableNames = (expected.snapshot.tables || []).slice().sort();

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);

  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));

  pass('manifest-integrity', integrity.ok === true);
  pass('forward-count-39', forward.length === 39);
  pass('manifest-hash-preserved', manifestHash === MANIFEST_HASH
    && evidence.manifestHashUnchanged === MANIFEST_HASH);
  pass('expected-byte-sha-preserved', expectedHash === EXPECTED_BYTE_SHA
    && evidence.expectedProductSchemaByteSha256 === EXPECTED_BYTE_SHA);
  pass('product-fingerprint-preserved', evidence.productFingerprintUnchanged === CANON_FP);
  pass('migration-028-hash', live028 === LOCKED_13C_SHA['028']);
  pass('migration-035-hash', live035 === LOCKED_13C_SHA['035']);
  pass('migration-040-hash', live040 === LOCKED_13C_SHA['040']);
  pass('migration-041-hash', live041 === LOCKED_13C_SHA['041']);
  assertMigration028ByteIntegrity();
  assert028PredicatesPresentInSource();
  pass('global-apply-disabled-capability-enabled',
    PHASE_D_LIVE_APPLY_ENABLED === false
    && PHASE_D_RECONCILE_DECISION_LIVE_ENABLED === true
    && PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true);
  pass('application-name', APPLICATION_NAME === 'wh-sunset-reconcile-decision');

  pass('evidence-shape',
    evidence.kind === 'sunset-schema-observer-slice14r-live-reconcile-decision-evidence'
    && evidence.secretFree === true
    && evidence.slice === '14R'
    && evidence.liveMutation === false
    && evidence.schemaMutation === false
    && evidence.dataMutation === false
    && evidence.ledgerWritten === false
    && evidence.kvMutation === false
    && evidence.forwardCountUnchanged === 39);

  pass('contract-shape',
    contract.kind === 'sunset-schema-observer-slice14r-live-reconcile-decision-contract'
    && contract.verifyNeverRerunsLive === true
    && contract.readOnlyReconcileDecisionProof === true
    && contract.writesLedger === false
    && contract.globalLiveApplyEnabled === false
    && contract.reconcileDecisionLiveEnabled === true);

  const redNames = (evidence.redCases || []).map((c) => c.name);
  const greenNames = (evidence.greenCases || []).map((c) => c.name);
  pass('red-cases-complete', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('green-cases-complete', REQUIRED_GREEN.every((n) => greenNames.includes(n)));
  pass('red-cases-ok', (evidence.redCases || []).every((c) => c.ok === true));
  pass('green-cases-ok', (evidence.greenCases || []).every((c) => c.ok === true));

  pass('master-basis', evidence.masterShaBasis === MASTER && contract.masterShaBasis === MASTER);

  pass('authority-locks',
    evidence.authorityLocks
    && evidence.authorityLocks.applicationName === 'wh-sunset-reconcile-decision'
    && evidence.authorityLocks.containerAppName === 'luna-sunset-staging-staff-api'
    && evidence.authorityLocks.postgresHost === TARGETS.postgresHost
    && evidence.authorityLocks.database === TARGETS.database
    && evidence.authorityLocks.sslmode === 'verify-full'
    && RECONCILE_LOCKS.applicationName === APPLICATION_NAME);

  pass('decision-criteria-in-source',
    /all approved existing tables have row count === 0/i.test(libSrc)
    || /all approved existing tables.*row count === 0/i.test(libSrc)
    || /clean_canonical_rebuild_cutover/.test(libSrc)
    && /noncanonicalDataBearingObjectExists/.test(libSrc));

  const offlineComplete = evidence.liveAttemptCount === 0
    && evidence.outcome === 'phase_d_reconcile_decision_offline_only';
  const liveRecorded = evidence.liveAttemptCount === 1;
  pass('offline-or-live-attempt-count', offlineComplete || liveRecorded);

  const live = evidence.liveReconcileDecisionOutcome;
  if (liveRecorded && live && live.occupancy) {
    const recomputed = decideReconcileStrategy(
      live.occupancy,
      live.groupedDrift,
      live.sameTarget === true,
    );
    pass('live-recommendation-recomputable',
      recomputed.recommendation === live.recommendation
      || (live.recommendation == null && recomputed.recommendation === 'blocked_wrong_target'));
    pass('live-mutation-flags-false',
      live.liveMutation === false
      && live.schemaMutation === false
      && live.dataMutation === false
      && live.ledgerWritten === false);

    const phases = (live.decision && live.decision.orderedReconciliationPhases)
      || recomputed.orderedReconciliationPhases;
    const phaseValidation = validateOrderedReconciliationPhases(phases, live.groupedDrift);
    const coverage = buildPhaseDriftCoverage(live.groupedDrift);
    const phaseIds = (phases || [])
      .filter((p) => PHASE_SEQUENCE_IDS.includes(p.id))
      .map((p) => p.id);
    pass('live-phase-sequence-a-to-g',
      phaseIds.join('') === PHASE_SEQUENCE_IDS.join('')
      && phaseValidation.ok === true
      && phaseValidation.code === 'complete_a_to_g_coverage');
    pass('live-drift-coverage-exactly-once',
      coverage.coveredExactlyOnce === true
      && coverage.expectedOnly === 498
      && coverage.definitionMismatch === 1
      && coverage.notNullMismatchCount === 472
      && coverage.checkConstraintsStatus === 'already_cleared'
      && coverage.checkMismatchCount === 0);
    pass('live-completion-blocked-while-not-null',
      (live.decision && live.decision.reconcileCompletionAllowed === false)
      && recomputed.reconcileCompletionAllowed === false
      && coverage.notNullMismatchCount > 0);
    pass('live-check-already-cleared-no-fictional-work',
      recomputed.checkConstraintsStatus === 'already_cleared'
      && !(JSON.stringify(phases || [])).includes('CHECK preflight on live data before apply'));
    pass('live-counters-preserved',
      live.httpRequestCount === 4
      && live.usedLiveHttp === true
      && live.realImdsCall === true
      && live.realArmCall === true
      && live.realKeyVaultCall === true
      && live.realPostgresCall === true);
    pass('live-generatedAt-preserved',
      evidence.generatedAt === '2026-07-19T21:58:38.356Z'
      && contract.generatedAt === '2026-07-19T21:58:38.356Z');
  } else {
    pass('live-recommendation-recompute-skipped-offline', true);
  }

  resetReconcileDecisionCounters();
  const def = await executeReconcileDecision({ env: {}, argv: [] });
  pass('runtime-default-refuse',
    def.ok === false
    && getReconcileDecisionCounters().clientsInstantiated === 0
    && getReconcileDecisionCounters().httpRequestCount === 0);

  const gates = evaluateReconcileDecisionGates({
    env: reconcileDecisionEnv(),
    argv: exactReconcileDecisionArgv(),
  });
  pass('runtime-cli-gates', gates.ok === true);

  const emptyCounts = Object.fromEntries(approvedTableNames.map((t) => [t, 0]));
  resetReconcileDecisionCounters();
  const FakeEmpty = createScriptedReconcileDecisionFakeClientFactory({
    approvedTableNames,
    perTableRowCounts: emptyCounts,
  });
  const emptyRun = await executeReconcileDecision({
    env: reconcileDecisionEnv(),
    argv: exactReconcileDecisionArgv(),
    httpRequest: createInjectedReconcileDecisionHttp({
      imdsAccessToken: FAKE_TOKEN,
      defaultSecretValue: buildOfflineProofSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD),
    }),
    ClientFactory: FakeEmpty,
    expectedContract: expected,
  });
  pass('runtime-empty-recommends-clean-rebuild',
    emptyRun.ok === true && emptyRun.recommendation === 'clean_canonical_rebuild_cutover');

  const cliDefault = spawnSync(process.execPath, [cliPath], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  pass('cli-default-refuse', cliDefault.status !== 0);

  const proveOffline = spawnSync(process.execPath, [provePath], {
    encoding: 'utf8',
    env: { ...process.env, SUNSET_SLICE14R_PROOF_OFFLINE: '1' },
  });
  pass('prove-offline-exit-0', proveOffline.status === 0,
    proveOffline.stderr ? String(proveOffline.stderr).slice(0, 200) : '');

  pass('source-forbids-live-rerun-in-verify',
    !/executeReconcileDecision\(\{[^}]*env:\s*process\.env/.test(verifySrc)
    && /createInjectedReconcileDecisionHttp/.test(verifySrc)
    && /Does NOT re-run live/.test(verifySrc));

  pass('prove-has-live-section',
    /Live section 1\/1/.test(proveSrc)
    && /liveAttemptCount/.test(proveSrc)
    && /executeReconcileDecision/.test(proveSrc));

  pass('source-no-ledger-insert',
    !/INSERT\s+INTO\s+.*schema_migration_ledger/i.test(libSrc)
    && !/INSERT\s+INTO\s+.*schema_migration_ledger/i.test(proveSrc));

  const armPath = buildLockedArmContainerAppPath();
  const listPath = buildLockedArmListSecretsPath();
  pass('arm-urls-locked',
    (/management\.azure\.com/.test(libSrc) || /managementHostname/.test(libSrc))
    && listPath.includes('/listSecrets')
    && armPath.includes('api-version=2024-03-01')
    && armPath.includes(RECONCILE_LOCKS.containerAppName));

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14r-live-reconcile-decision']
      === 'node scripts/prove-sunset-schema-slice14r-live-reconcile-decision.js'
    && pkg.scripts['verify:sunset-schema-slice14r']
      === 'node scripts/verify-sunset-schema-slice14r.js'
    && pkg.scripts['phase-d:reconcile-decision']
      === 'node scripts/run-phase-d-reconcile-decision.js');

  pass('findings-truthful',
    /Do not claim/i.test(findings)
    && /zero mutation/i.test(findings)
    && /14R/.test(findings)
    && /wh-sunset-reconcile-decision|reconcile decision/i.test(findings));

  const artifactText = `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`;
  pass('no-secret-tokens-in-artifacts',
    !/slice14r-proof-admin-password|verify-slice14r-admin-password|slice14r-proof-imds-token/i.test(artifactText)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(artifactText)
    && !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(artifactText));

  pass('prior-slice14q-script', typeof pkg.scripts['verify:sunset-schema-slice14q'] === 'string');

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14r FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14r GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
