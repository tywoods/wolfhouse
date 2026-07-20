'use strict';

/**
 * verify:sunset-schema-slice14ad — FOUNDATION Slice 14AD RED→GREEN
 * Ledger baseline apply (offline gates + optional live evidence).
 * STATIC ONLY — never spawns --live or calls executePhaseDLedgerBaselineApply live.
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
} = require('./lib/migration-integrity');
const { hashCanonicalManifest } = require('./lib/sunset-schema-observer');
const {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetManagedIdentityHttpCounters,
  getManagedIdentityHttpCounters,
  MI_LOADER_LOCKS,
} = require('./lib/phase-d-managed-identity-credential-loader');
const {
  PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED,
  APPLICATION_NAME,
  AUTHORIZED_SEQUENCE,
  SUCCESS_PATH_QUERY_COUNT,
  APPLY_LOCKS,
  BASELINE_ROW_COUNT,
  STRUCTURAL_BASELINE_COUNT,
  CURRENT_STATE_BASELINE_COUNT,
  MASTER_SHA_BASIS,
  CANON_FP,
  MANIFEST_HASH,
  EXPECTED_BYTE_SHA,
  PROPOSED_LEDGER_ROWS_SHA256,
  SLICE14AC_EVIDENCE_FILE_SHA256,
  LEDGER_DDL,
  LEDGER_TIMESTAMP_SEMANTICS,
  evaluateLedgerBaselineApplyGates,
  executePhaseDLedgerBaselineApply,
  createScriptedLedgerBaselineApplyFakeClientFactory,
  resetLedgerBaselineApplyCounters,
  getLedgerBaselineApplyCounters,
  exactLedgerBaselineApplyArgv,
  ledgerBaselineApplyEnv,
  assertSlice14acEvidenceByteLocked,
  hashProposedLedgerRows,
} = require('./lib/phase-d-ledger-baseline-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');

const REQUIRED_RED = [
  'eligibility_hash_drift',
  'ledger_present_refuse',
  'incompatible_ledger_relation_refuse',
  'extra_unauthorized_sql_refuse',
  'partial_insert_rollback_no_retry',
  'wrong_kind_mode_checksum_order_refuse',
  'fabricated_historical_timestamp_refuse',
  'future_runner_mislabel_refuse',
  'legacy_upgrade_null_kind_reconcile_fails',
  'default_path_zero_http_and_clients',
  'missing_apply_flag_or_env',
  'wrong_or_forbidden_argv',
  'managed_identity_requires_env_and_argv',
  'global_live_apply_remains_false',
];

const REQUIRED_GREEN = [
  'forward_count_39_hash_locks',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'injected_http_success_exact_sequence',
  'runner_reconcile_baseline_kinds_ok',
  'runner_reconcile_null_kind_fails',
  'executed_runner_provenance_shape',
  'timestamp_semantics_documented',
];

const FAKE_USER = 'verify-slice14ad-admin-user';
const FAKE_PASSWORD = 'verify-slice14ad-admin-password';
const FAKE_TOKEN = 'verify-slice14ad-imds-token';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14ad — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14ad-ledger-baseline-apply-evidence.json');
  const contractPath = path.join(FIX, 'slice14ad-ledger-baseline-apply-contract.json');
  const findingsPath = path.join(FIX, 'slice14ad-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const slice14acPath = path.join(FIX, 'slice14ac-ledger-eligibility-matrix-evidence.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14ad-ledger-baseline-apply.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14ad.js');
  const applyCliPath = path.join(ROOT, 'scripts', 'run-phase-d-ledger-baseline-apply.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-ledger-baseline-apply.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, slice14acPath, provePath, verifyPath, applyCliPath, libPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const expectedBytes = fs.readFileSync(expectedPath);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  const slice14acBytes = fs.readFileSync(slice14acPath);
  const slice14acHash = crypto.createHash('sha256').update(slice14acBytes).digest('hex');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  const evidenceLock = assertSlice14acEvidenceByteLocked();

  pass('manifest-integrity', integrity.ok === true);
  pass('forward-count-39', forward.length === 39);
  pass('manifest-hash-preserved', manifestHash === MANIFEST_HASH
    && evidence.manifestHashUnchanged === MANIFEST_HASH);
  pass('expected-byte-sha-preserved', expectedHash === EXPECTED_BYTE_SHA
    && evidence.expectedProductSchemaByteSha256 === EXPECTED_BYTE_SHA);
  pass('product-fingerprint-preserved', evidence.productFingerprintUnchanged === CANON_FP);
  pass('slice14ac-evidence-hash', slice14acHash === SLICE14AC_EVIDENCE_FILE_SHA256
    && evidence.slice14acEvidenceFileSha256 === SLICE14AC_EVIDENCE_FILE_SHA256);
  pass('proposed-rows-hash', evidenceLock.rowsSha === PROPOSED_LEDGER_ROWS_SHA256
    && evidence.proposedLedgerRowsSha256 === PROPOSED_LEDGER_ROWS_SHA256);

  pass('global-apply-disabled-capability-enabled',
    PHASE_D_LIVE_APPLY_ENABLED === false
    && PHASE_D_LEDGER_BASELINE_APPLY_LIVE_ENABLED === true
    && PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true);

  pass('evidence-shape',
    evidence.kind === 'sunset-schema-observer-slice14ad-ledger-baseline-apply-evidence'
    && evidence.secretFree === true
    && evidence.slice === '14AD'
    && evidence.dataMutation === false
    && evidence.forwardCountUnchanged === 39
    && evidence.baselineRowCount === BASELINE_ROW_COUNT
    && evidence.verifyNeverRerunsLive === true);

  pass('contract-shape',
    contract.kind === 'sunset-schema-observer-slice14ad-ledger-baseline-apply-contract'
    && contract.verifyNeverRerunsLive === true
    && contract.containsLiveApplyCode === true
    && contract.writesLedger === true
    && contract.executesMigrations === false
    && contract.dataMutation === false
    && contract.schemaMutation === 'ledger_only'
    && contract.globalLiveApplyEnabled === false
    && contract.ledgerBaselineApplyLiveEnabled === true);

  const redNames = (evidence.redCases || []).map((c) => c.name);
  const greenNames = (evidence.greenCases || []).map((c) => c.name);
  pass('red-cases-complete', REQUIRED_RED.every((n) => redNames.includes(n)),
    REQUIRED_RED.filter((n) => !redNames.includes(n)).join(','));
  pass('green-cases-complete', REQUIRED_GREEN.every((n) => greenNames.includes(n)),
    REQUIRED_GREEN.filter((n) => !greenNames.includes(n)).join(','));

  pass('master-basis',
    evidence.masterShaBasis === MASTER_SHA_BASIS
    && contract.masterShaBasis === MASTER_SHA_BASIS);

  pass('application-name',
    evidence.applicationName === APPLICATION_NAME
    && APPLICATION_NAME === 'wh-sunset-ledger-baseline-apply'
    && APPLY_LOCKS.applicationName === APPLICATION_NAME);

  pass('baseline-counts',
    evidence.structuralBaselineCount === STRUCTURAL_BASELINE_COUNT
    && evidence.currentStateBaselineCount === CURRENT_STATE_BASELINE_COUNT);

  pass(`authorized-sequence-${SUCCESS_PATH_QUERY_COUNT}`,
    AUTHORIZED_SEQUENCE.length === SUCCESS_PATH_QUERY_COUNT
    && evidence.authorizedSequence.length === SUCCESS_PATH_QUERY_COUNT);

  pass('advisory-locks-wh-mig1',
    APPLY_LOCKS.advisoryLockKey1 === 0x57480001
    && APPLY_LOCKS.advisoryLockKey2 === 0x4d494731
    && contract.applyLocks.advisoryLockLabels[0] === 'WH'
    && contract.applyLocks.advisoryLockLabels[1] === 'MIG1');

  const ddl = String(LEDGER_DDL);
  pass('ledger-ddl-required-columns',
    contract.ledgerDdlContains.every((col) => ddl.includes(col)),
    contract.ledgerDdlContains.filter((col) => !ddl.includes(col)).join(','));

  pass('verify-never-reruns-live',
    evidence.verifyNeverRerunsLive === true
    && contract.verifyNeverRerunsLive === true
    && !/process\.argv\.includes\('--live'\)/.test(verifySrc)
    && !/spawnSync\(process\.execPath,\s*\[applyCliPath,\s*\.\.\.exactLedgerBaselineApplyArgv/.test(verifySrc)
    && /createInjectedManagedIdentityHttp/.test(verifySrc)
    && /createScriptedLedgerBaselineApplyFakeClientFactory/.test(verifySrc)
    && /Does NOT re-run live|STATIC ONLY/i.test(verifySrc));

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14ad-ledger-baseline-apply']
      === 'node scripts/prove-sunset-schema-slice14ad-ledger-baseline-apply.js'
    && pkg.scripts['verify:sunset-schema-slice14ad']
      === 'node scripts/verify-sunset-schema-slice14ad.js'
    && pkg.scripts['phase-d:ledger-baseline-apply']
      === 'node scripts/run-phase-d-ledger-baseline-apply.js');

  pass('timestamp-semantics',
    LEDGER_TIMESTAMP_SEMANTICS.neverHistoricalExecutionTime === true
    && evidence.timestampSemantics
    && evidence.timestampSemantics.neverHistoricalExecutionTime === true);

  resetLedgerBaselineApplyCounters();
  resetManagedIdentityHttpCounters();
  const def = await executePhaseDLedgerBaselineApply({ env: {}, argv: [] });
  pass('runtime-default-refuse',
    def.ok === false
    && getLedgerBaselineApplyCounters().clientsInstantiated === 0
    && getManagedIdentityHttpCounters().httpRequestCount === 0);

  resetLedgerBaselineApplyCounters();
  resetManagedIdentityHttpCounters();
  const okRun = await executePhaseDLedgerBaselineApply({
    env: ledgerBaselineApplyEnv(),
    argv: exactLedgerBaselineApplyArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_TOKEN,
      defaultSecretValue: buildOfflineProofSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD),
    }),
    Client: createScriptedLedgerBaselineApplyFakeClientFactory({}),
  });
  pass('runtime-injected-ledger-sequence',
    okRun.ok === true
    && okRun.clientsInstantiated === 1
    && okRun.queryCalls === SUCCESS_PATH_QUERY_COUNT
    && getManagedIdentityHttpCounters().httpRequestCount === 2
    && JSON.stringify(okRun.steps) === JSON.stringify(AUTHORIZED_SEQUENCE)
    && okRun.ledgerWritten === true
    && okRun.dataMutation === false
    && okRun.schemaMutation === 'ledger_only'
    && okRun.insertedRowCount === BASELINE_ROW_COUNT);

  const gates = evaluateLedgerBaselineApplyGates({
    env: ledgerBaselineApplyEnv(),
    argv: exactLedgerBaselineApplyArgv(),
  });
  pass('runtime-cli-gates', gates.ok === true && gates.applyLedgerBaseline === true);

  const cliDefault = spawnSync(process.execPath, [applyCliPath], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  pass('apply-cli-default-refuse', cliDefault.status !== 0);

  pass('apply-locks-identity',
    APPLY_LOCKS.managedIdentityName === MI_LOADER_LOCKS.managedIdentityName
    && MI_LOADER_LOCKS.keyVaultName === 'luna-sunset-staging-kv'
    && APPLY_LOCKS.sslmode === 'verify-full'
    && APPLY_LOCKS.postgresHost === TARGETS.postgresHost);

  pass('prove-has-live-apply-section',
    /Live section 3\/4/.test(proveSrc)
    && /Live section 4\/4/.test(proveSrc)
    && /exactLedgerBaselineApplyArgv/.test(proveSrc)
    && /buildObserverCompareOptions/.test(proveSrc));

  pass('findings-truthful',
    /Do not claim/i.test(findings)
    && /ledger baseline/i.test(findings)
    && /WH/.test(findings)
    && /MIG1/.test(findings)
    && new RegExp(`RED: ${REQUIRED_RED.length}`).test(findings)
    && new RegExp(`GREEN: ${REQUIRED_GREEN.length}`).test(findings));

  const tampered = evidenceLock.rows.slice();
  tampered[0] = { ...tampered[0], checksum_sha256: 'f'.repeat(64) };
  pass('hash-lock-detects-drift', hashProposedLedgerRows(tampered) !== PROPOSED_LEDGER_ROWS_SHA256);

  const offlineComplete = evidence.liveExecutionCount === 0
    && evidence.outcome === 'phase_d_ledger_baseline_apply_offline_only';
  const liveRecorded = evidence.liveExecutionCount === 1
    && evidence.liveOutcome
    && evidence.liveOutcome.ok === true;
  pass('offline-or-live-attempt-count', offlineComplete || liveRecorded);

  const artifactText = `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`;
  pass('no-secret-tokens-in-artifacts',
    !/slice14ad-proof-admin-password|verify-slice14ad-admin-password|slice14ad-proof-imds-token/i.test(artifactText)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(artifactText));

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14ad FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14ad GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
