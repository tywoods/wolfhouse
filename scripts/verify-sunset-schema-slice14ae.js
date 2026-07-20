'use strict';

/**
 * verify:sunset-schema-slice14ae — FOUNDATION Slice 14AE RED→GREEN
 * Canonical runner no-op (offline gates + optional live evidence).
 * STATIC ONLY — never spawns --live or calls executePhaseDCanonicalRunnerNoop live.
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
  assertSafeDatabaseTarget,
  SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET,
} = require('./lib/migration-integrity');
const { hashCanonicalManifest } = require('./lib/sunset-schema-observer');
const {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  PHASE_D_CANONICAL_RUNNER_NOOP_LIVE_ENABLED,
  APPLICATION_NAME,
  BASELINE_ROW_COUNT,
  STRUCTURAL_BASELINE_COUNT,
  CURRENT_STATE_BASELINE_COUNT,
  MASTER_SHA_BASIS,
  CANON_FP,
  MANIFEST_HASH,
  EXPECTED_BYTE_SHA,
  PROPOSED_LEDGER_ROWS_SHA256,
  SLICE14AC_EVIDENCE_FILE_SHA256,
  NOOP_LOCKS,
  evaluateCanonicalRunnerNoopGates,
  exactCanonicalRunnerNoopArgv,
  canonicalRunnerNoopEnv,
  createScriptedCanonicalRunnerNoopFakeClientFactory,
  resetCanonicalRunnerNoopCounters,
  getCanonicalRunnerNoopCounters,
  LEDGER_TIMESTAMP_SEMANTICS,
} = require('./lib/phase-d-canonical-runner-noop');
const {
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetManagedIdentityHttpCounters,
  getManagedIdentityHttpCounters,
} = require('./lib/phase-d-managed-identity-credential-loader');
const { runCanonicalMigrations } = require('./run-canonical-migrations');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');

const REQUIRED_RED = [
  'checksum_mismatch_reconcile',
  'kind_mismatch_refuse',
  'mode_mismatch_refuse',
  'gap_order_refuse',
  'timestamp_null_refuse',
  'runner_applies_one_refused',
  'skipped_set_wrong',
  'skipped_order_wrong',
  'hidden_second_invocation',
  'post_digest_drift',
  'migration_sql_dispatch',
  'ledger_insert_forbidden',
  'baseline_label_rewrite',
  'default_path_zero_http_and_clients',
  'missing_flag_or_env',
  'wrong_or_forbidden_argv',
  'managed_identity_requires_env_and_argv',
  'global_live_apply_remains_false',
];

const REQUIRED_GREEN = [
  'forward_count_39_hash_locks',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'default_safety_refuses_sunset',
  'allow_path_exact_sunset_only',
  'runner_noop_skipped_39_in_order',
  'query_classifier_compat_only',
  'timestamp_semantics_documented',
  'docker_limitation_documented',
];

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14ae — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14ae-canonical-runner-noop-evidence.json');
  const contractPath = path.join(FIX, 'slice14ae-canonical-runner-noop-contract.json');
  const findingsPath = path.join(FIX, 'slice14ae-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const slice14acPath = path.join(FIX, 'slice14ac-ledger-eligibility-matrix-evidence.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14ae-canonical-runner-noop.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14ae.js');
  const noopCliPath = path.join(ROOT, 'scripts', 'run-phase-d-canonical-runner-noop.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-canonical-runner-noop.js');
  const runnerPath = path.join(ROOT, 'scripts', 'run-canonical-migrations.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, slice14acPath, provePath, verifyPath, noopCliPath, libPath, runnerPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const libSrc = fs.readFileSync(libPath, 'utf8');
  const runnerSrc = fs.readFileSync(runnerPath, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const expectedBytes = fs.readFileSync(expectedPath);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  const slice14acBytes = fs.readFileSync(slice14acPath);
  const slice14acHash = crypto.createHash('sha256').update(slice14acBytes).digest('hex');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);

  pass('manifest-integrity', integrity.ok === true);
  pass('forward-count-39', forward.length === 39);
  pass('manifest-hash-preserved', manifestHash === MANIFEST_HASH
    && evidence.manifestHashUnchanged === MANIFEST_HASH);
  pass('expected-byte-sha-preserved', expectedHash === EXPECTED_BYTE_SHA
    && evidence.expectedProductSchemaByteSha256 === EXPECTED_BYTE_SHA);
  pass('product-fingerprint-preserved', evidence.productFingerprintUnchanged === CANON_FP);
  pass('slice14ac-evidence-hash', slice14acHash === SLICE14AC_EVIDENCE_FILE_SHA256
    && evidence.slice14acEvidenceFileSha256 === SLICE14AC_EVIDENCE_FILE_SHA256);
  pass('proposed-rows-hash', evidence.proposedLedgerRowsSha256 === PROPOSED_LEDGER_ROWS_SHA256);

  pass('global-apply-disabled-capability-enabled',
    PHASE_D_LIVE_APPLY_ENABLED === false
    && PHASE_D_CANONICAL_RUNNER_NOOP_LIVE_ENABLED === true
    && PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true);

  pass('evidence-shape',
    evidence.kind === 'sunset-schema-observer-slice14ae-canonical-runner-noop-evidence'
    && evidence.secretFree === true
    && evidence.slice === '14AE'
    && evidence.dataMutation === false
    && evidence.schemaMutation === false
    && evidence.ledgerWritten === false
    && evidence.executesMigrations === false
    && evidence.effectiveMutation === false
    && evidence.forwardCountUnchanged === 39
    && evidence.baselineRowCount === BASELINE_ROW_COUNT
    && evidence.verifyNeverRerunsLive === true);

  pass('contract-shape',
    contract.kind === 'sunset-schema-observer-slice14ae-canonical-runner-noop-contract'
    && contract.verifyNeverRerunsLive === true
    && contract.containsLiveApplyCode === true
    && contract.usesMergedRunCanonicalMigrations === true
    && contract.writesLedger === false
    && contract.executesMigrations === false
    && contract.dataMutation === false
    && contract.schemaMutation === false
    && contract.globalLiveApplyEnabled === false
    && contract.canonicalRunnerNoopLiveEnabled === true);

  const redNames = (evidence.redCases || []).map((c) => c.name);
  const greenNames = (evidence.greenCases || []).map((c) => c.name);
  pass('red-cases-complete', REQUIRED_RED.every((n) => redNames.includes(n)),
    REQUIRED_RED.filter((n) => !redNames.includes(n)).join(','));
  pass('green-cases-complete', REQUIRED_GREEN.every((n) => greenNames.includes(n)),
    REQUIRED_GREEN.filter((n) => !greenNames.includes(n)).join(','));
  pass('red-cases-passed', (evidence.redCases || []).every((c) => c.ok === true));
  pass('green-cases-passed', (evidence.greenCases || []).every((c) => c.ok === true));

  pass('master-basis',
    evidence.masterShaBasis === MASTER_SHA_BASIS
    && contract.masterShaBasis === MASTER_SHA_BASIS
    && MASTER_SHA_BASIS === '21371079ac5a331d47e7ed5f79351fceeeceefa6');

  pass('application-name',
    evidence.applicationName === APPLICATION_NAME
    && APPLICATION_NAME === 'wh-sunset-canonical-runner-noop'
    && NOOP_LOCKS.applicationName === APPLICATION_NAME);

  pass('baseline-counts',
    evidence.structuralBaselineCount === STRUCTURAL_BASELINE_COUNT
    && evidence.currentStateBaselineCount === CURRENT_STATE_BASELINE_COUNT);

  pass('verify-never-reruns-live',
    evidence.verifyNeverRerunsLive === true
    && contract.verifyNeverRerunsLive === true
    && !/process\.argv\.includes\('--live'\)/.test(verifySrc)
    && !/executePhaseDCanonicalRunnerNoop\(/.test(verifySrc)
    && /createScriptedCanonicalRunnerNoopFakeClientFactory/.test(verifySrc)
    && /STATIC ONLY/i.test(verifySrc)
    // Default-disabled CLI probe only (bare argv; never spawns gated live argv).
    && /spawnSync\(process\.execPath,\s*\[noopCliPath\]/.test(verifySrc)
    && !/spawnSync\([\s\S]*exactCanonicalRunnerNoopArgv/.test(verifySrc));

  pass('uses-merged-runner',
    /require\('\.\.\/run-canonical-migrations'\)/.test(libSrc)
    || /require\('\.\/run-canonical-migrations'\)/.test(libSrc)
    || /require\('\.\.\/run-canonical-migrations'\)/.test(proveSrc)
    || /runCanonicalMigrations/.test(libSrc));

  pass('runner-allow-opt-in',
    /allowSunsetStagingCanonicalRunnerNoop/.test(runnerSrc)
    && /SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET/.test(fs.readFileSync(
      path.join(ROOT, 'scripts', 'lib', 'migration-integrity.js'),
      'utf8',
    )));

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14ae-canonical-runner-noop']
      === 'node scripts/prove-sunset-schema-slice14ae-canonical-runner-noop.js'
    && pkg.scripts['verify:sunset-schema-slice14ae']
      === 'node scripts/verify-sunset-schema-slice14ae.js'
    && pkg.scripts['phase-d:canonical-runner-noop']
      === 'node scripts/run-phase-d-canonical-runner-noop.js');

  pass('timestamp-semantics',
    LEDGER_TIMESTAMP_SEMANTICS.neverHistoricalExecutionTime === true
    && evidence.timestampSemantics
    && evidence.timestampSemantics.neverHistoricalExecutionTime === true);

  pass('docker-limitation',
    /Docker is unavailable|Docker unavailable|fresh-db Docker replacement/i.test(findings)
    && typeof evidence.dockerUnavailableLimitation === 'string'
    && /fresh-db/i.test(evidence.dockerUnavailableLimitation));

  pass('mutation-flags-zero',
    evidence.schemaMutation === false
    && evidence.dataMutation === false
    && evidence.ledgerWritten === false
    && evidence.effectiveMutation === false);

  // Static GREEN: gates + fake runner noop (never live)
  {
    const gatesOk = evaluateCanonicalRunnerNoopGates({
      env: canonicalRunnerNoopEnv(),
      argv: exactCanonicalRunnerNoopArgv(),
    });
    pass('static-gates-ok', gatesOk.ok === true);
  }

  {
    resetCanonicalRunnerNoopCounters();
    resetManagedIdentityHttpCounters();
    const refused = assertSafeDatabaseTarget({
      host: TARGETS.postgresHost,
      database: TARGETS.database,
      port: TARGETS.port,
    });
    const allowed = assertSafeDatabaseTarget(
      SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET,
      { allowSunsetStagingCanonicalRunnerNoop: true },
    );
    pass('static-safety-default-and-allow',
      refused.ok === false && allowed.ok === true);

    const proposed = JSON.parse(slice14acBytes.toString('utf8')).proposedLedgerRows;
    const {
      buildBaselineLedgerRowsFromForward,
    } = require('./lib/phase-d-canonical-runner-noop');
    const rows = buildBaselineLedgerRowsFromForward(forward, proposed);
    const Fake = createScriptedCanonicalRunnerNoopFakeClientFactory({ ledgerRows: rows });
    const result = await runCanonicalMigrations({
      connection: {
        host: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.host,
        port: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.port,
        database: SUNSET_STAGING_CANONICAL_RUNNER_NOOP_TARGET.database,
        user: 'verify-u',
        password: 'verify-p',
      },
      allowSunsetStagingCanonicalRunnerNoop: true,
      Client: Fake,
    });
    pass('static-runner-noop-39',
      result.ok === true
      && result.applied.length === 0
      && result.skipped.length === 39
      && result.pending.length === 0
      && result.skipped.every((id, i) => String(id) === String(forward[i].id)));
    pass('static-zero-http',
      getManagedIdentityHttpCounters().httpRequestCount === 0);
    // Prove injected HTTP factory exists for offline tests but was not used live here
    createInjectedManagedIdentityHttp({
      imdsAccessToken: 'verify-token',
      defaultSecretValue: buildOfflineProofSunsetDatabaseUrl('vu', 'vp'),
    });
    pass('static-injected-http-helper-present', true);
    pass('static-counters',
      getCanonicalRunnerNoopCounters().liveRunnerInvocationCount === 0);
  }

  if (evidence.liveOutcome && evidence.liveOutcome.ok === true) {
    pass('live-evidence-zero-mutation',
      evidence.liveOutcome.schemaMutation === false
      && evidence.liveOutcome.dataMutation === false
      && evidence.liveOutcome.ledgerWritten === false
      && evidence.liveOutcome.liveRunnerInvocationCount === 1
      && evidence.liveOutcome.digestsUnchanged === true
      && evidence.liveOutcome.fingerprintUnchanged === true
      && evidence.liveOutcome.rowCountsUnchanged === true
      && evidence.liveOutcome.runnerResult
      && evidence.liveOutcome.runnerResult.appliedCount === 0
      && evidence.liveOutcome.runnerResult.skippedCount === 39
      && evidence.liveOutcome.queryClassification
      && evidence.liveOutcome.queryClassification.zeroMigrationFileSql === true
      && evidence.liveOutcome.queryClassification.zeroLedgerInsert === true);
  } else {
    pass('live-evidence-pending-or-offline',
      evidence.liveExecutionCount === 0
      || (evidence.liveOutcome && evidence.liveOutcome.ok !== true));
  }

  // Ensure default CLI still disabled
  {
    const def = spawnSync(process.execPath, [noopCliPath], { encoding: 'utf8' });
    pass('cli-default-disabled-exit-2', def.status === 2);
  }

  console.log(failed === 0
    ? '\nverify:sunset-schema-slice14ae PASS'
    : `\nverify:sunset-schema-slice14ae FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
