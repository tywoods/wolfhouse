'use strict';

/**
 * verify:sunset-schema-slice14y — FOUNDATION Slice 14Y RED→GREEN
 * Apply five residual indexes (offline gates + optional live evidence).
 * Does NOT re-run live authority, apply, or observer.
 * STATIC ONLY — never spawns --live; injected Fake Client only for brief green re-check.
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
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetManagedIdentityHttpCounters,
  getManagedIdentityHttpCounters,
  MI_LOADER_LOCKS,
} = require('./lib/phase-d-managed-identity-credential-loader');
const {
  PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED,
  APPLICATION_NAME,
  AUTHORIZED_SEQUENCE,
  SUCCESS_PATH_QUERY_COUNT,
  APPLY_LOCKS,
  FIVE_INDEX_SPECS,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  EXPECTED_REDUCTION,
  EXPECTED_REMAINING_MISMATCH_COUNT,
  EXPECTED_REMAINING_KEYS,
  evaluateFiveIndexApplyGates,
  executePhaseDFiveIndexApply,
  createScriptedFiveIndexApplyFakeClientFactory,
  resetFiveIndexApplyCounters,
  getFiveIndexApplyCounters,
  exactFiveIndexApplyArgv,
  fiveIndexApplyEnv,
  assertCreateIndexStatementsByteLocked,
} = require('./lib/phase-d-five-index-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = 'ea1e6971a19f57da0ded41eb0d1d28aa165786be';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const REQUIRED_RED = [
  'baseline_drift_mismatch',
  'create_or_owner_hash_drift_fails',
  'duplicate_semantic_index_refuse',
  'incompatible_same_name_object_refuse',
  'missing_column_refuse',
  'extra_unauthorized_sql_refuse',
  'partial_failure_rollback_no_retry',
  'wrong_order_refuse',
  'timeout_advisory_failure_rollback',
  'default_path_zero_http_and_clients',
  'missing_apply_flag_or_env',
  'wrong_or_forbidden_argv',
  'managed_identity_requires_env_and_argv',
  'global_live_apply_remains_false',
];

const REQUIRED_GREEN = [
  'injected_http_success_exact_43_step_sequence',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'create_statements_byte_locked',
  'five_specs_map_to_owners_hashes_defs',
  'row_count_bounds_locked',
];

const FAKE_USER = 'verify-slice14y-admin-user';
const FAKE_PASSWORD = 'verify-slice14y-admin-password';
const FAKE_TOKEN = 'verify-slice14y-imds-token';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14y — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14y-five-index-apply-evidence.json');
  const contractPath = path.join(FIX, 'slice14y-five-index-apply-contract.json');
  const findingsPath = path.join(FIX, 'slice14y-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14y-five-index-apply.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14y.js');
  const applyCliPath = path.join(ROOT, 'scripts', 'run-phase-d-five-index-apply.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-five-index-apply.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, verifyPath, applyCliPath, libPath]
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
  pass('expected-bytes-unchanged', expectedHash === EXPECTED_BYTE_SHA, expectedHash);

  pass('global-apply-disabled-capability-enabled',
    PHASE_D_LIVE_APPLY_ENABLED === false
    && PHASE_D_FIVE_INDEX_APPLY_LIVE_ENABLED === true
    && PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true);

  pass('evidence-shape',
    evidence.kind === 'sunset-schema-observer-slice14y-five-index-apply-evidence'
    && evidence.secretFree === true
    && evidence.slice === '14Y'
    && evidence.dataMutation === false
    && evidence.ledgerWritten === false
    && evidence.forwardCountUnchanged === 39
    && evidence.claimsZeroDrift === false
    && evidence.claimsFullRepair === false
    && evidence.stillProductSchemaDiffers === true);

  pass('contract-shape',
    contract.kind === 'sunset-schema-observer-slice14y-five-index-apply-contract'
    && contract.verifyNeverRerunsLive === true
    && contract.containsLiveApplyCode === true
    && contract.appliesIndexes === true
    && contract.writesLedger === false
    && contract.dataMutation === false
    && contract.globalLiveApplyEnabled === false
    && contract.fiveIndexApplyLiveEnabled === true
    && contract.claimsZeroDrift === false
    && contract.claimsFullRepair === false);

  const redNames = (evidence.redCases || []).map((c) => c.name);
  const greenNames = (evidence.greenCases || []).map((c) => c.name);
  pass('red-cases-complete', REQUIRED_RED.every((n) => redNames.includes(n)),
    REQUIRED_RED.filter((n) => !redNames.includes(n)).join(','));
  pass('green-cases-complete', REQUIRED_GREEN.every((n) => greenNames.includes(n)),
    REQUIRED_GREEN.filter((n) => !greenNames.includes(n)).join(','));

  pass('master-basis',
    evidence.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER);

  pass('application-name',
    evidence.applicationName === APPLICATION_NAME
    && APPLICATION_NAME === 'wh-sunset-five-index-apply'
    && APPLY_LOCKS.applicationName === APPLICATION_NAME);

  const createLock = assertCreateIndexStatementsByteLocked();
  pass('create-sql-sha256-locked',
    FIVE_INDEX_SPECS.every((s) =>
      createLock.createStatementsSha256[s.indexName] === s.createSqlSha256)
    && JSON.stringify(evidence.createStatementsSha256)
      === JSON.stringify(createLock.createStatementsSha256));

  const seenOwners = new Set();
  for (const spec of FIVE_INDEX_SPECS) {
    if (seenOwners.has(spec.ownerMigration)) continue;
    seenOwners.add(spec.ownerMigration);
    const live = sha256CanonicalLfV1File(
      path.join(MIGRATIONS_DIR, `${spec.ownerMigration}.sql`),
    );
    pass(`owner-migration-hash-${spec.ownerMigration}`,
      live === spec.ownerMigrationSha256
      && evidence.ownerMigrationSha256[spec.ownerMigration] === spec.ownerMigrationSha256);
  }

  pass('baseline-locks',
    evidence.baselineMismatchCount === BASELINE_MISMATCH_COUNT
    && evidence.expectedReduction === EXPECTED_REDUCTION
    && evidence.expectedRemainingMismatchCount === EXPECTED_REMAINING_MISMATCH_COUNT
    && JSON.stringify(evidence.baselineMismatchSections)
      === JSON.stringify(BASELINE_MISMATCH_SECTIONS)
    && JSON.stringify(evidence.expectedRemainingKeys)
      === JSON.stringify(EXPECTED_REMAINING_KEYS.slice()));

  pass('authorized-sequence-43',
    AUTHORIZED_SEQUENCE.length === SUCCESS_PATH_QUERY_COUNT
    && SUCCESS_PATH_QUERY_COUNT === 43
    && Array.isArray(evidence.authorizedSequence)
    && evidence.authorizedSequence.length === 43);

  pass('verify-never-reruns-live',
    evidence.verifyNeverRerunsLive === true
    && contract.verifyNeverRerunsLive === true
    && !/process\.argv\.includes\('--live'\)/.test(verifySrc)
    && !/spawnSync\(process\.execPath,\s*\[applyCliPath,\s*\.\.\.exactFiveIndexApplyArgv/.test(verifySrc)
    && !/env:\s*process\.env/.test(verifySrc)
    && /createInjectedManagedIdentityHttp/.test(verifySrc)
    && /createScriptedFiveIndexApplyFakeClientFactory/.test(verifySrc)
    && /Does NOT re-run live/i.test(verifySrc));

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14y-five-index-apply']
      === 'node scripts/prove-sunset-schema-slice14y-five-index-apply.js'
    && pkg.scripts['verify:sunset-schema-slice14y']
      === 'node scripts/verify-sunset-schema-slice14y.js'
    && pkg.scripts['phase-d:five-index-apply']
      === 'node scripts/run-phase-d-five-index-apply.js');

  pass('phase-d-live-apply-enabled-false',
    PHASE_D_LIVE_APPLY_ENABLED === false
    && evidence.offlineGates
    && evidence.offlineGates.globalLiveApplyRemainsFalse === true);

  // Offline runtime re-checks (injected only — never live)
  resetFiveIndexApplyCounters();
  resetManagedIdentityHttpCounters();
  const def = await executePhaseDFiveIndexApply({ env: {}, argv: [] });
  pass('runtime-default-refuse',
    def.ok === false
    && getFiveIndexApplyCounters().clientsInstantiated === 0
    && getManagedIdentityHttpCounters().httpRequestCount === 0);

  resetFiveIndexApplyCounters();
  resetManagedIdentityHttpCounters();
  const FakeOk = createScriptedFiveIndexApplyFakeClientFactory({});
  const okRun = await executePhaseDFiveIndexApply({
    env: fiveIndexApplyEnv(),
    argv: exactFiveIndexApplyArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_TOKEN,
      defaultSecretValue: buildOfflineProofSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD),
    }),
    Client: FakeOk,
  });
  pass('runtime-injected-five-index-sequence',
    okRun.ok === true
    && okRun.clientsInstantiated === 1
    && okRun.queryCalls === 43
    && getManagedIdentityHttpCounters().httpRequestCount === 2
    && JSON.stringify(okRun.steps) === JSON.stringify(AUTHORIZED_SEQUENCE)
    && okRun.schemaMutation === true
    && okRun.dataMutation === false
    && okRun.ledgerWritten === false);

  const gates = evaluateFiveIndexApplyGates({
    env: fiveIndexApplyEnv(),
    argv: exactFiveIndexApplyArgv(),
  });
  pass('runtime-cli-gates', gates.ok === true && gates.applyFiveIndexes === true);

  const cliDefault = spawnSync(process.execPath, [applyCliPath], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  pass('apply-cli-default-refuse', cliDefault.status !== 0);

  pass('apply-locks-identity',
    APPLY_LOCKS.managedIdentityName === MI_LOADER_LOCKS.managedIdentityName
    && MI_LOADER_LOCKS.managedIdentityName === 'wh-staging-identity'
    && MI_LOADER_LOCKS.keyVaultName === 'luna-sunset-staging-kv'
    && MI_LOADER_LOCKS.secretName === 'sunset-database-url'
    && APPLY_LOCKS.sslmode === 'verify-full'
    && APPLY_LOCKS.postgresHost === TARGETS.postgresHost
    && APPLY_LOCKS.database === TARGETS.database);

  pass('prove-has-live-apply-section',
    /Live section 3\/4/.test(proveSrc)
    && /Live section 4\/4/.test(proveSrc)
    && /exactFiveIndexApplyArgv/.test(proveSrc)
    && /executePhaseDFiveIndexApply/.test(proveSrc)
    && /enableFinalRenameNormalization:\s*true/.test(proveSrc)
    && /enableIdentifierTruncationNormalization:\s*true/.test(proveSrc));

  pass('findings-truthful',
    /Do not claim/i.test(findings)
    && /zero remaining drift|fully repaired|matches canonical/i.test(findings)
    && /idx_tenant_surf_pack_client_loc/.test(findings)
    && /idx_client_notification_events_client_created/.test(findings)
    && /idx_customer_message_templates_client_active/.test(findings)
    && new RegExp(`RED: ${REQUIRED_RED.length}`).test(findings)
    && new RegExp(`GREEN: ${REQUIRED_GREEN.length}`).test(findings));

  const offlineComplete = evidence.liveApplyAttemptCount === 0
    && evidence.outcome === 'phase_d_five_index_apply_offline_only';
  const liveRecorded = evidence.liveApplyAttemptCount === 1;
  pass('offline-or-live-attempt-count', offlineComplete || liveRecorded);

  if (liveRecorded && evidence.liveOutcome && evidence.liveOutcome.ok === true) {
    pass('live-reduction-shape',
      evidence.liveOutcome.reducedByExactlyFive === true
      && evidence.liveOutcome.fiveIndexKeysAbsentFromRemaining === true
      && evidence.liveOutcome.mismatchCountBefore === 11
      && evidence.liveOutcome.mismatchCountAfter === 6
      && evidence.liveOutcome.claimsZeroDrift !== true
      && evidence.liveOutcome.schemaMutation === true
      && evidence.liveOutcome.dataMutation === false
      && evidence.liveOutcome.ledgerWritten === false
      && evidence.liveOutcome.rowPreservation
      && evidence.liveOutcome.rowPreservation.preserved === true);
  } else {
    pass('live-reduction-shape-skipped-offline', true);
  }

  const artifactText = `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`;
  pass('no-secret-tokens-in-artifacts',
    !/slice14y-proof-admin-password|verify-slice14y-admin-password|slice14y-proof-imds-token/i.test(artifactText)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(artifactText)
    && !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(artifactText));

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14y FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14y GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
