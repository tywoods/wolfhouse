'use strict';

/**
 * verify:sunset-schema-slice13c3d — FOUNDATION Slice 13C.3d RED→GREEN
 * Integrated disposable Phase C proof (040 → 035 → 041) 29→2.
 * Offline gates + disposable-proof evidence. No Azure / live mutation.
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
const { hashCanonicalManifest } = require('./lib/sunset-schema-observer');
const {
  LOCKED_SHA,
  PRESTATE_29_KEYS,
  AFTER_040_KEYS,
  AFTER_035_KEYS,
  AFTER_041_KEYS,
  PHASE_D_REMAINING_KEYS,
  MIG_035,
  MIG_040,
  MIG_041,
} = require('./lib/phase-c-integrated-disposable');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = 'd68d03500f4449185c4247a2ddec126c54c13d9c';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sameKeys(a, b) {
  const x = (a || []).slice().sort();
  const y = (b || []).slice().sort();
  if (x.length !== y.length) return false;
  return x.every((k, i) => k === y[i]);
}

function main() {
  console.log('verify:sunset-schema-slice13c3d — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice13c3d-integrated-phase-c-evidence.json');
  const mismatchPath = path.join(FIX, 'slice13c3d-mismatch-29-to-2-evidence.json');
  const checkpointPath = path.join(FIX, 'slice13c3d-checkpoint-key-sets.json');
  const findingsPath = path.join(FIX, 'slice13c3d-findings.md');
  const contractPath = path.join(FIX, 'slice13b-slice13c-rehearsal-contract.json');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice13c3d-integrated-phase-c.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice13c3d.js');
  const orchPath = path.join(ROOT, 'scripts', 'lib', 'phase-c-integrated-disposable.js');

  pass(
    'artifacts-exist',
    [evidencePath, mismatchPath, checkpointPath, findingsPath, contractPath, expectedPath, provePath, orchPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const mismatchEv = JSON.parse(fs.readFileSync(mismatchPath, 'utf8'));
  const checkpoints = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const orchSrc = fs.readFileSync(orchPath, 'utf8');

  const expectedBytes = fs.readFileSync(expectedPath);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);

  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, MIG_035));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, MIG_040));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, MIG_041));

  pass('manifest-integrity', integrity.ok, JSON.stringify((integrity.errors || []).slice(0, 3)));
  pass('forward-count-unchanged-39',
    forward.length === 39
    && expected.forwardCount === 39
    && evidence.forwardCountUnchanged === 39
    && evidence.newForwardMigration === false);

  pass('locked-hashes-unchanged',
    live035 === LOCKED_SHA['035']
    && live040 === LOCKED_SHA['040']
    && live041 === LOCKED_SHA['041']
    && manifestHash === MANIFEST_HASH
    && expectedHash === EXPECTED_BYTE_SHA
    && expected.productFingerprint === CANON_FP
    && evidence.migrationHashes['035'] === LOCKED_SHA['035']
    && evidence.migrationHashes['040'] === LOCKED_SHA['040']
    && evidence.migrationHashes['041'] === LOCKED_SHA['041']
    && evidence.manifestHashUnchanged === MANIFEST_HASH
    && evidence.productFingerprintUnchanged === CANON_FP
    && evidence.expectedProductSchemaByteSha256 === EXPECTED_BYTE_SHA
    && mismatchEv.expectedProductSchemaByteSha256 === EXPECTED_BYTE_SHA);

  pass('checkpoint-key-sets-exact',
    checkpoints.trajectory === '29 → 25 → 8 → 2'
    && checkpoints.claimsAllThreeAtomicity === false
    && checkpoints.checkpoints.before.count === 29
    && checkpoints.checkpoints.after040.count === 25
    && checkpoints.checkpoints.after035.count === 8
    && checkpoints.checkpoints.after041.count === 2
    && sameKeys(checkpoints.checkpoints.before.keys, PRESTATE_29_KEYS)
    && sameKeys(checkpoints.checkpoints.after040.keys, AFTER_040_KEYS)
    && sameKeys(checkpoints.checkpoints.after035.keys, AFTER_035_KEYS)
    && sameKeys(checkpoints.checkpoints.after041.keys, AFTER_041_KEYS)
    && sameKeys(checkpoints.phaseDRemaining, PHASE_D_REMAINING_KEYS));

  pass('mismatch-trajectory-29-to-2',
    mismatchEv.previousRemainingAfter13c2 === 29
    && mismatchEv.trajectory === '29 → 25 → 8 → 2'
    && mismatchEv.match === false
    && mismatchEv.code === 'product_schema_differs'
    && mismatchEv.finalObserverMismatchOnlyPhaseDChecks === true
    && mismatchEv.noPhaseDCheckImplementation === true
    && sameKeys(mismatchEv.beforeKeys, PRESTATE_29_KEYS)
    && sameKeys(mismatchEv.after040Keys, AFTER_040_KEYS)
    && sameKeys(mismatchEv.after035Keys, AFTER_035_KEYS)
    && sameKeys(mismatchEv.remainingKeys, AFTER_041_KEYS)
    && mismatchEv.remainingByClassification
    && mismatchEv.remainingByClassification.genuine_database_drift === 2);

  pass('fresh-and-integrated-green',
    evidence.fresh39Forward
    && evidence.fresh39Forward.ok === true
    && evidence.fresh39Forward.appliedCount === 39
    && evidence.fresh39Forward.secondApplyNoOp === true
    && evidence.fresh39Forward.observerSelfMatch === true
    && evidence.fresh39Forward.productFingerprint === CANON_FP
    && evidence.integrated
    && evidence.integrated.ok === true
    && evidence.integrated.checkpoints.before === 29
    && evidence.integrated.checkpoints.after040 === 25
    && evidence.integrated.checkpoints.after035 === 8
    && evidence.integrated.checkpoints.after041 === 2
    && sameKeys(evidence.integrated.finalKeys, AFTER_041_KEYS)
    && evidence.secondFullSequenceNoOp
    && evidence.secondFullSequenceNoOp.ok === true);

  pass('fail-stop-resume',
    evidence.failStopResume
    && evidence.failStopResume.ok === true
    && evidence.failStopResume.preflight035Failure
    && evidence.failStopResume.preflight035Failure.failedClosed === true
    && sameKeys(evidence.failStopResume.preflight035Failure.completedCheckpointsRemain, ['040'])
    && evidence.failStopResume.preflight035Failure.resume035Deterministic === true
    && evidence.failStopResume.conflict041After040035
    && evidence.failStopResume.conflict041After040035.failedClosed === true
    && sameKeys(evidence.failStopResume.conflict041After040035.completedCheckpointsRemain, ['040', '035'])
    && evidence.failStopResume.conflict041After040035.partial041RolledBack === true
    && evidence.failStopResume.conflict041After040035.resume041ConvergedToTwo === true
    && evidence.claimsAllThreeAtomicity === false);

  const redNames = (evidence.redFailures || []).map((r) => r.name);
  const requiredRed = [
    'orchestrator_disabled_by_default',
    'non_disposable_dsn_rejected',
    'sequence_reorder_rejected',
    'wrong_prestate_key_set_rejected',
    'wrong_base_hashes_locked',
    '035_preflight_conflict_fail_stop',
    '041_conflict_rolls_back_partial_only',
  ];
  pass('red-fail-closed-cases',
    evidence.redFailures
    && evidence.redFailures.length >= requiredRed.length
    && evidence.redFailures.every((r) => r.failedClosed === true)
    && requiredRed.every((n) => redNames.includes(n)));

  pass('green-cases',
    evidence.greenCases
    && evidence.greenCases.every((g) => g.ok === true)
    && evidence.greenCases.some((g) => g.name === 'exact_29_prestate')
    && evidence.greenCases.some((g) => g.name === 'checkpoints_29_25_8_2')
    && evidence.greenCases.some((g) => g.name === 'final_two_phase_d_checks_only'));

  pass('design-safety-flags',
    evidence.secretFree === true
    && evidence.containsRepairSql === false
    && evidence.containsLiveApplyCode === false
    && evidence.liveMutation === false
    && evidence.azureMutation === false
    && evidence.disposablePostgreSQLOnly === true
    && evidence.wroteSchemaMigrationLedger === false
    && evidence.claimsCanonicalRunnerProvenance === false
    && evidence.liveApplyEnabled === false
    && mismatchEv.blessesLiveAsCanonical === false
    && mismatchEv.containsLiveApplyCode === false
    && contract.liveApplyCapability === false);

  pass('no-live-apply-path-in-tooling',
    !/\bLIVE_APPLY_ENABLED\b/.test(proveSrc)
    && !/LIVE_APPLY_ENABLED\s*=\s*true/.test(orchSrc)
    && !/az\s+postgres/i.test(proveSrc)
    && !/writeFileSync\([^)]*expected-product-schema/i.test(proveSrc)
    && !/writeFileSync\([^)]*expected-product-schema/i.test(verifySrc)
    && /disposablePostgreSQLOnly|Disposable PostgreSQL only/i.test(proveSrc)
    && /phaseCIntegratedEnabled/.test(orchSrc)
    && /PHASE_C_LIVE_APPLY_ENABLED = false/.test(orchSrc)
    && !/provision-sunset-schema-observer-role/.test(proveSrc));

  pass('no-new-forward-migration-or-phase-d',
    evidence.newForwardMigration === false
    && /New forward migration:\*\* none/i.test(findings)
    && /Phase D CHECKs remain/i.test(findings)
    && /unimplemented/i.test(findings));

  pass('slice13c-contract-phase-c-integrated',
    contract.phaseStatus
    && contract.phaseStatus.C === 'complete_integrated_phase_c_disposable_proof'
    && contract.phaseStatus.D === 'pending'
    && contract.slice13c3dPhaseC
    && contract.slice13c3dPhaseC.newForwardMigration === false
    && contract.slice13c3dPhaseC.claimsAllThreeAtomicity === false
    && contract.slice13c3dPhaseC.trajectory === '29 → 25 → 8 → 2'
    && contract.slice13c3dPhaseC.masterShaBasis === MASTER
    && contract.requirements.disposablePostgreSQLOnly === true);

  pass('do-not-claim-sunset-repaired',
    mismatchEv.match === false
    && /product_schema_differs/.test(findings)
    && /do not claim/i.test(findings)
    && /29\s*→\s*25\s*→\s*8\s*→\s*2/.test(findings)
    && /zero live mutation/i.test(findings));

  pass('master-basis',
    evidence.masterShaBasis === MASTER
    && mismatchEv.masterShaBasis === MASTER
    && checkpoints.masterShaBasis === MASTER);

  console.log(`\n── verify:sunset-schema-slice13c3d ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
  process.exit(failed ? 1 : 0);
}

main();
