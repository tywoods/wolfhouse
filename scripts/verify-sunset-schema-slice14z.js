'use strict';

/**
 * verify:sunset-schema-slice14z — FOUNDATION Slice 14Z RED→GREEN
 * Apply one residual FK (offline gates + optional live evidence).
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
  PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED,
  APPLICATION_NAME,
  AUTHORIZED_SEQUENCE,
  SUCCESS_PATH_QUERY_COUNT,
  APPLY_LOCKS,
  FK_SPEC,
  OBSERVER_KEY,
  APPROVED_ROW_COUNT,
  BASELINE_MISMATCH_COUNT,
  BASELINE_MISMATCH_SECTIONS,
  EXPECTED_REDUCTION,
  EXPECTED_REMAINING_MISMATCH_COUNT,
  EXPECTED_REMAINING_KEYS,
  evaluateSurfPackFkApplyGates,
  executePhaseDSurfPackFkApply,
  createScriptedSurfPackFkApplyFakeClientFactory,
  resetSurfPackFkApplyCounters,
  getSurfPackFkApplyCounters,
  exactSurfPackFkApplyArgv,
  surfPackFkApplyEnv,
  assertFkAlterStatementsByteLocked,
} = require('./lib/phase-d-surf-pack-fk-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = 'da67cf2c229f80d0cf118f7e361d95902cb6d32d';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const REQUIRED_RED = [
  'orphan_present_refuse',
  'type_mismatch_refuse',
  'baseline_drift_mismatch',
  'duplicate_or_incompatible_fk_refuse',
  'owner_hash_drift_fails',
  'extra_unauthorized_sql_refuse',
  'partial_rollback_no_retry',
  'invalid_or_unvalidated_result_refuse',
  'default_path_zero_http_and_clients',
  'missing_apply_flag_or_env',
  'wrong_or_forbidden_argv',
  'managed_identity_requires_env_and_argv',
  'global_live_apply_remains_false',
];

const REQUIRED_GREEN = [
  'null_semantics_ok_orphan_zero',
  'injected_http_success_exact_sequence',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'alter_statements_byte_locked',
  'fk_spec_maps_to_owner_hash_def',
  'row_count_bound_or_capture_locked',
  'direct_add_fallback_path_authorized',
];

const FAKE_USER = 'verify-slice14z-admin-user';
const FAKE_PASSWORD = 'verify-slice14z-admin-password';
const FAKE_TOKEN = 'verify-slice14z-imds-token';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14z — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14z-surf-pack-fk-apply-evidence.json');
  const contractPath = path.join(FIX, 'slice14z-surf-pack-fk-apply-contract.json');
  const findingsPath = path.join(FIX, 'slice14z-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14z-surf-pack-fk-apply.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14z.js');
  const applyCliPath = path.join(ROOT, 'scripts', 'run-phase-d-surf-pack-fk-apply.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-surf-pack-fk-apply.js');

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
    && PHASE_D_SURF_PACK_FK_APPLY_LIVE_ENABLED === true
    && PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true);

  pass('evidence-shape',
    evidence.kind === 'sunset-schema-observer-slice14z-surf-pack-fk-apply-evidence'
    && evidence.secretFree === true
    && evidence.slice === '14Z'
    && evidence.dataMutation === false
    && evidence.ledgerWritten === false
    && evidence.forwardCountUnchanged === 39
    && evidence.claimsZeroDrift === false
    && evidence.claimsFullRepair === false
    && evidence.stillProductSchemaDiffers === true);

  pass('contract-shape',
    contract.kind === 'sunset-schema-observer-slice14z-surf-pack-fk-apply-contract'
    && contract.verifyNeverRerunsLive === true
    && contract.containsLiveApplyCode === true
    && contract.appliesFk === true
    && contract.writesLedger === false
    && contract.dataMutation === false
    && contract.globalLiveApplyEnabled === false
    && contract.surfPackFkApplyLiveEnabled === true
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
    && APPLICATION_NAME === 'wh-sunset-surf-pack-fk-apply'
    && APPLY_LOCKS.applicationName === APPLICATION_NAME);

  const alterLock = assertFkAlterStatementsByteLocked();
  pass('alter-sql-sha256-locked',
    alterLock.alterStatementsSha256.addNotValid === FK_SPEC.addNotValidSqlSha256
    && alterLock.alterStatementsSha256.addDirect === FK_SPEC.addDirectSqlSha256
    && alterLock.alterStatementsSha256.validate === FK_SPEC.validateSqlSha256
    && JSON.stringify(evidence.alterStatementsSha256)
      === JSON.stringify(alterLock.alterStatementsSha256));

  const liveOwner = sha256CanonicalLfV1File(
    path.join(MIGRATIONS_DIR, `${FK_SPEC.ownerMigration}.sql`),
  );
  pass('owner-migration-hash-026',
    liveOwner === FK_SPEC.ownerMigrationSha256
    && evidence.ownerMigrationSha256[FK_SPEC.ownerMigration] === FK_SPEC.ownerMigrationSha256);

  pass('baseline-locks',
    evidence.baselineMismatchCount === BASELINE_MISMATCH_COUNT
    && evidence.expectedReduction === EXPECTED_REDUCTION
    && evidence.expectedRemainingMismatchCount === EXPECTED_REMAINING_MISMATCH_COUNT
    && JSON.stringify(evidence.baselineMismatchSections)
      === JSON.stringify(BASELINE_MISMATCH_SECTIONS)
    && JSON.stringify(evidence.expectedRemainingKeys)
      === JSON.stringify(EXPECTED_REMAINING_KEYS.slice()));

  pass('authorized-sequence-21',
    AUTHORIZED_SEQUENCE.length === SUCCESS_PATH_QUERY_COUNT
    && SUCCESS_PATH_QUERY_COUNT === 21
    && Array.isArray(evidence.authorizedSequence)
    && evidence.authorizedSequence.length === 21);

  pass('advisory-locks-whpz-spfk',
    APPLY_LOCKS.advisoryLockKey1 === 0x5748505A
    && APPLY_LOCKS.advisoryLockKey2 === 0x5350464B
    && contract.applyLocks.advisoryLockLabels
    && contract.applyLocks.advisoryLockLabels[0] === 'WHPZ'
    && contract.applyLocks.advisoryLockLabels[1] === 'SPFK');

  pass('observer-key',
    evidence.fkSpec.observerKey === OBSERVER_KEY
    && contract.applyLocks.observerKey === OBSERVER_KEY);

  pass('verify-never-reruns-live',
    evidence.verifyNeverRerunsLive === true
    && contract.verifyNeverRerunsLive === true
    && !/process\.argv\.includes\('--live'\)/.test(verifySrc)
    && !/spawnSync\(process\.execPath,\s*\[applyCliPath,\s*\.\.\.exactSurfPackFkApplyArgv/.test(verifySrc)
    && !/env:\s*process\.env/.test(verifySrc)
    && /createInjectedManagedIdentityHttp/.test(verifySrc)
    && /createScriptedSurfPackFkApplyFakeClientFactory/.test(verifySrc)
    && /Does NOT re-run live/i.test(verifySrc));

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14z-surf-pack-fk-apply']
      === 'node scripts/prove-sunset-schema-slice14z-surf-pack-fk-apply.js'
    && pkg.scripts['verify:sunset-schema-slice14z']
      === 'node scripts/verify-sunset-schema-slice14z.js'
    && pkg.scripts['phase-d:surf-pack-fk-apply']
      === 'node scripts/run-phase-d-surf-pack-fk-apply.js');

  pass('phase-d-live-apply-enabled-false',
    PHASE_D_LIVE_APPLY_ENABLED === false
    && evidence.offlineGates
    && evidence.offlineGates.globalLiveApplyRemainsFalse === true);

  resetSurfPackFkApplyCounters();
  resetManagedIdentityHttpCounters();
  const def = await executePhaseDSurfPackFkApply({ env: {}, argv: [] });
  pass('runtime-default-refuse',
    def.ok === false
    && getSurfPackFkApplyCounters().clientsInstantiated === 0
    && getManagedIdentityHttpCounters().httpRequestCount === 0);

  resetSurfPackFkApplyCounters();
  resetManagedIdentityHttpCounters();
  const FakeOk = createScriptedSurfPackFkApplyFakeClientFactory({});
  const okRun = await executePhaseDSurfPackFkApply({
    env: surfPackFkApplyEnv(),
    argv: exactSurfPackFkApplyArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_TOKEN,
      defaultSecretValue: buildOfflineProofSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD),
    }),
    Client: FakeOk,
  });
  pass('runtime-injected-fk-sequence',
    okRun.ok === true
    && okRun.clientsInstantiated === 1
    && okRun.queryCalls === 21
    && getManagedIdentityHttpCounters().httpRequestCount === 2
    && JSON.stringify(okRun.steps) === JSON.stringify(AUTHORIZED_SEQUENCE)
    && okRun.schemaMutation === true
    && okRun.dataMutation === false
    && okRun.ledgerWritten === false);

  const gates = evaluateSurfPackFkApplyGates({
    env: surfPackFkApplyEnv(),
    argv: exactSurfPackFkApplyArgv(),
  });
  pass('runtime-cli-gates', gates.ok === true && gates.applySurfPackFk === true);

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
    && /exactSurfPackFkApplyArgv/.test(proveSrc)
    && /executePhaseDSurfPackFkApply/.test(proveSrc)
    && /enableFinalRenameNormalization:\s*true/.test(proveSrc)
    && /enableIdentifierTruncationNormalization:\s*true/.test(proveSrc));

  pass('findings-truthful',
    /Do not claim/i.test(findings)
    && /zero remaining drift|fully repaired|matches canonical/i.test(findings)
    && /tenant_surf_pack_rules_updated_by_fkey/.test(findings)
    && /WHPZ/.test(findings)
    && /SPFK/.test(findings)
    && new RegExp(`RED: ${REQUIRED_RED.length}`).test(findings)
    && new RegExp(`GREEN: ${REQUIRED_GREEN.length}`).test(findings));

  const offlineComplete = evidence.liveApplyAttemptCount === 0
    && evidence.outcome === 'phase_d_surf_pack_fk_apply_offline_only';
  const liveRecorded = evidence.liveApplyAttemptCount === 1;
  pass('offline-or-live-attempt-count', offlineComplete || liveRecorded);

  if (liveRecorded && evidence.liveOutcome && evidence.liveOutcome.ok === true) {
    pass('live-reduction-shape',
      evidence.liveOutcome.reducedByExactlyOne === true
      && evidence.liveOutcome.fkKeyAbsentFromRemaining === true
      && evidence.liveOutcome.mismatchCountBefore === 6
      && evidence.liveOutcome.mismatchCountAfter === 5
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
    !/slice14z-proof-admin-password|verify-slice14z-admin-password|slice14z-proof-imds-token/i.test(artifactText)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(artifactText)
    && !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(artifactText));

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14z FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14z GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
