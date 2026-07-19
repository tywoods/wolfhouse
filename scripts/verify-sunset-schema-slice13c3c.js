'use strict';

/**
 * verify:sunset-schema-slice13c3c — FOUNDATION Slice 13C.3c RED→GREEN
 * Converge six Phase C notification/surf-pack keys via one forward migration 041.
 * Offline gates + disposable-proof evidence. No Azure / live mutation.
 */

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

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = 'a90e91812eadcb0ad799fbddfc4333ba5821a9df';
const PREV_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const PREV_MANIFEST_HASH = '427206aeeed1890c3a1fa2f666d11b66411333811b071fb1af5986126d8d12eb';
const MIG_041 = '041_notification_surfpack_convergence.sql';
const MIG_041_ID = '041_notification_surfpack_convergence';

const PHASE_C_SIX_KEYS = [
  'expected_only|constraints|tenant_surf_pack_rules.tenant_surf_pack_rules_updated_by_fkey.FOREIGN KEY',
  'expected_only|indexes|client_notification_events.idx_client_notification_events_client_created',
  'expected_only|indexes|client_notification_events.idx_client_notification_events_conversation',
  'expected_only|indexes|client_notification_settings.idx_client_notification_settings_client',
  'expected_only|indexes|tenant_surf_pack_rules.idx_tenant_surf_pack_client_loc',
  'expected_only|triggers|tenant_surf_pack_rules.tenant_surf_pack_rules_updated_at',
];

const PHASE_D_REMAINING_KEYS = [
  'expected_only|constraints|tenant_services.tenant_services_date_window.CHECK',
  'expected_only|constraints|tenant_services.tenant_services_price_unit.CHECK',
];

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function main() {
  console.log('verify:sunset-schema-slice13c3c — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice13c3c-notification-surfpack-evidence.json');
  const mismatchPath = path.join(FIX, 'slice13c3c-mismatch-8-to-2-evidence.json');
  const keyMapPath = path.join(FIX, 'slice13c3c-six-key-map.json');
  const findingsPath = path.join(FIX, 'slice13c3c-findings.md');
  const contractPath = path.join(FIX, 'slice13b-slice13c-rehearsal-contract.json');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice13c3c-notification-surfpack.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice13c3c.js');
  const migPath = path.join(MIGRATIONS_DIR, MIG_041);

  pass(
    'artifacts-exist',
    [evidencePath, mismatchPath, keyMapPath, findingsPath, contractPath, expectedPath, provePath, migPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const mismatchEv = JSON.parse(fs.readFileSync(mismatchPath, 'utf8'));
  const keyMap = JSON.parse(fs.readFileSync(keyMapPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const migSql = fs.readFileSync(migPath, 'utf8');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  const entry041 = forward.find((e) => e.id === MIG_041_ID);
  const liveHash = sha256CanonicalLfV1File(migPath);
  const NEW_FP = expected.productFingerprint;

  pass('manifest-integrity', integrity.ok, JSON.stringify((integrity.errors || []).slice(0, 3)));
  pass('exactly-one-new-forward-041',
    forward.length === 39
    && Boolean(entry041)
    && entry041.order === 39
    && entry041.classification === 'canonical_forward'
    && entry041.inForwardChain === true
    && liveHash === entry041.sha256
    && evidence.migration.sha256CanonicalLfV1 === liveHash);

  pass('forward-count-38-to-39',
    evidence.forwardCount.before === 38
    && evidence.forwardCount.after === 39
    && expected.forwardCount === 39
    && manifestHash === evidence.manifestHash.after
    && evidence.manifestHash.before === PREV_MANIFEST_HASH);

  pass('product-fingerprint-unchanged',
    expected.productFingerprint === PREV_FP
    && evidence.productFingerprint.after === PREV_FP
    && evidence.productFingerprint.before === PREV_FP
    && evidence.productFingerprint.unchanged === true
    && NEW_FP === PREV_FP
    && expected.manifestHash === evidence.manifestHash.after
    && expected.checksumMode === 'canonical_lf_v1'
    && expected.generatedFromMaster === MASTER
    && /not derived from live/i.test(String(expected.slice13c3cNote || ''))
    && /unchanged/i.test(String(expected.slice13c3cNote || '')));

  pass('six-key-map-complete',
    keyMap.keys
    && keyMap.keys.length === 6
    && PHASE_C_SIX_KEYS.every((k) => keyMap.keys.some((e) => e.stableKey === k))
    && keyMap.keys.every((e) => e.historicalOwner && e.canonicalDefinition && e.catalogContract)
    && keyMap.keys.filter((e) => e.historicalOwner === '032_client_notification_settings.sql').length === 3
    && keyMap.keys.filter((e) => e.historicalOwner === '026_tenant_surf_pack_rules.sql').length === 3);

  pass('domain-scope-six-objects-only',
    (evidence.objectsConverged || []).length === 6
    && !/ADD\s+CONSTRAINT\s+tenant_services_date_window/i.test(migSql)
    && !/ADD\s+CONSTRAINT\s+tenant_services_price_unit/i.test(migSql)
    && !/035_customer_message_templates/i.test(migSql)
    && !/ALTER\s+TABLE\s+tenant_services\b/i.test(migSql)
    && !/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?schema_migration_ledger\b/i.test(migSql)
    && !/OWNER\s+TO\b/i.test(migSql)
    && !/GRANT\b/i.test(migSql)
    && evidence.objectsExcluded.includes('tenant_services_date_window CHECK')
    && evidence.objectsExcluded.includes('customer_message_templates / 035'));

  pass('catalog-fail-closed-helpers-present',
    /wh041_ensure_target_index/.test(migSql)
    && /wh041_ensure_fk/.test(migSql)
    && /wh041_ensure_trigger/.test(migSql)
    && /wh041_assert_set_updated_at_compatible/.test(migSql)
    && /pg_get_indexdef/.test(migSql)
    && /refuse drop\/replace/i.test(migSql)
    && /prosecdef/.test(migSql)
    && /provolatile/.test(migSql)
    && /proconfig/.test(migSql)
    && /proisstrict/.test(migSql)
    && /proleakproof/.test(migSql)
    && /proparallel/.test(migSql)
    && evidence.catalogValidation
    && /pg_catalog/i.test(String(evidence.catalogValidation.approach || ''))
    && evidence.catalogValidation.setUpdatedAtContract
    && evidence.catalogValidation.setUpdatedAtContract.prosecdef === false
    && evidence.catalogValidation.setUpdatedAtContract.provolatile === 'v'
    && evidence.catalogValidation.setUpdatedAtContract.proconfig === ''
    && evidence.catalogValidation.setUpdatedAtContract.proisstrict === false
    && evidence.catalogValidation.setUpdatedAtContract.proleakproof === false
    && evidence.catalogValidation.setUpdatedAtContract.proparallel === 'u'
    && evidence.catalogValidation.setUpdatedAtContract.mutateFunction === false);

  const triggerKey = (keyMap.keys || []).find(
    (e) => e.stableKey === 'expected_only|triggers|tenant_surf_pack_rules.tenant_surf_pack_rules_updated_at',
  );
  const fnContract = triggerKey && triggerKey.catalogContract && triggerKey.catalogContract.functionCatalogContract;
  pass('set-updated-at-function-catalog-contract',
    Boolean(fnContract)
    && fnContract.identity === 'public.set_updated_at()'
    && fnContract.returnType === 'trigger'
    && fnContract.language === 'plpgsql'
    && fnContract.prosecdef === false
    && fnContract.security === 'INVOKER'
    && fnContract.provolatile === 'v'
    && fnContract.volatility === 'VOLATILE'
    && fnContract.proconfig === ''
    && fnContract.proisstrict === false
    && fnContract.proleakproof === false
    && fnContract.proparallel === 'u'
    && fnContract.parallel === 'UNSAFE'
    && fnContract.mutateFunction === false
    && /prosecdef=false/i.test(findings)
    && /INVOKER/i.test(findings)
    && /provolatile=v/i.test(findings)
    && /VOLATILE/i.test(findings)
    && /never mutated/i.test(findings));

  pass('path-a-fresh-canonical',
    evidence.pathA
    && evidence.pathA.ok === true
    && evidence.pathA.appliedCount === 39
    && evidence.pathA.secondApplyNoOp === true
    && evidence.pathA.observerSelfMatch === true
    && evidence.pathA.sixObjectsPresent === true
    && evidence.pathA.oidStableAcross041 === true
    && evidence.pathA.phaseDChecksUnchanged === true
    && evidence.pathA.productFingerprint === PREV_FP);

  pass('path-b-8-to-2-and-idempotency',
    evidence.pathB
    && evidence.pathB.ok === true
    && evidence.pathB.pre041Applied === 38
    && evidence.pathB.prestateDroppedSixPlusPhaseDChecks === true
    && (evidence.pathB.prestateEightKeys || []).length === 8
    && (evidence.pathB.after041RemainingAmongEight || []).length === 2
    && PHASE_D_REMAINING_KEYS.every((k) => evidence.pathB.after041RemainingAmongEight.includes(k))
    && PHASE_C_SIX_KEYS.every((k) => !evidence.pathB.after041RemainingAmongEight.includes(k))
    && evidence.pathB.second041Idempotent === true
    && evidence.pathB.oidStable === true);

  const redNames = (evidence.redFailures || []).map((r) => r.name);
  const requiredRed = [
    'wrong_index_table',
    'wrong_index_order',
    'wrong_index_predicate',
    'wrong_index_unique',
    'wrong_index_include',
    'constraint_owned_index',
    'missing_fk_prerequisite_staff_users',
    'wrong_fk_target',
    'wrong_fk_action',
    'wrong_fk_deferrability',
    'incompatible_trigger_function',
    'wrong_trigger_timing',
    'wrong_trigger_events',
    'wrong_trigger_enabled',
    'wrong_trigger_args',
    'wrong_set_updated_at_security_definer',
    'wrong_set_updated_at_stable',
    'wrong_set_updated_at_immutable',
    'wrong_set_updated_at_proconfig',
    'wrong_set_updated_at_strict',
    'wrong_set_updated_at_parallel_safe',
    'partial_conflict_rolls_back_earlier_creates',
    'missing_parent_notification_tables',
  ];
  const leakproofProbe = evidence.catalogValidation && evidence.catalogValidation.leakproofRedProbe;
  const leakproofOk = Boolean(leakproofProbe)
    && (
      (leakproofProbe.skipped === true && Boolean(leakproofProbe.skipReason))
      || (
        leakproofProbe.skipped === false
        && leakproofProbe.failedClosed === true
        && leakproofProbe.hitIntendedGuard === true
        && redNames.includes('wrong_set_updated_at_leakproof')
      )
    );
  pass('red-fail-closed-cases',
    evidence.redFailures
    && evidence.redFailures.length >= requiredRed.length
    && evidence.redFailures.every((r) => r.failedClosed === true)
    && evidence.redFailures.every((r) => r.hitIntendedGuard === true)
    && requiredRed.every((n) => redNames.includes(n))
    && leakproofOk);

  pass('green-preserve-and-non-disposable',
    evidence.greenCases
    && evidence.greenCases.every((g) => g.ok === true)
    && evidence.greenCases.some((g) => g.name === 'non_disposable_dsn_rejected')
    && evidence.greenCases.some((g) => g.name === 'product_fingerprint_unchanged')
    && evidence.greenCases.some((g) => g.name === 'exact_set_updated_at_canonical_preserves'));

  pass('mismatch-trajectory-8-to-2',
    mismatchEv.previousRemainingAfter13c3b === 8
    && mismatchEv.resolvedPhaseCNotificationSurfPackKeys === 6
    && mismatchEv.remainingGenuineDriftKeys === 2
    && mismatchEv.trajectory === '8 → 2'
    && mismatchEv.match === false
    && mismatchEv.code === 'product_schema_differs'
    && mismatchEv.noPhaseDCheckResolution === true
    && (mismatchEv.phaseCNotificationSurfPackKeysResolved || []).length === 6
    && (mismatchEv.remainingKeys || []).length === 2
    && PHASE_C_SIX_KEYS.every((k) => mismatchEv.phaseCNotificationSurfPackKeysResolved.includes(k))
    && PHASE_D_REMAINING_KEYS.every((k) => (mismatchEv.remainingKeys || []).includes(k))
    && mismatchEv.remainingByClassification
    && mismatchEv.remainingByClassification.genuine_database_drift === 2);

  pass('do-not-claim-sunset-repaired',
    mismatchEv.match === false
    && /product_schema_differs/.test(findings)
    && /do not claim/i.test(findings)
    && /8\s*→\s*2/.test(findings));

  pass('slice13c-contract-phase-c-complete',
    contract.phaseStatus
    && contract.phaseStatus.A === 'complete_offline_identity_normalization'
    && contract.phaseStatus.B === 'complete_location_model_promotion'
    && (contract.phaseStatus.C === 'complete_notification_surfpack_convergence'
      || contract.phaseStatus.C === 'complete_integrated_phase_c_disposable_proof')
    && contract.phaseStatus.D === 'pending'
    && contract.slice13c3cPhaseC
    && contract.slice13c3cPhaseC.migrationId === MIG_041_ID
    && contract.liveApplyCapability === false
    && contract.requirements.disposablePostgreSQLOnly === true);

  pass('design-safety-flags',
    evidence.secretFree === true
    && evidence.containsRepairSql === false
    && evidence.containsLiveApplyCode === false
    && evidence.liveMutation === false
    && evidence.azureMutation === false
    && evidence.disposablePostgreSQLOnly === true
    && mismatchEv.blessesLiveAsCanonical === false
    && mismatchEv.containsLiveApplyCode === false);

  pass('no-live-apply-path-in-tooling',
    !/\bLIVE_APPLY_ENABLED\b/.test(proveSrc)
    && !/az\s+postgres/i.test(proveSrc)
    && !/writeFileSync\([^)]*expected-product-schema/i.test(verifySrc)
    && /disposablePostgreSQLOnly|Disposable PostgreSQL only/i.test(proveSrc)
    // Forbidden-target RED probe may mention sunset_staging as a rejected name only.
    && !/LIVE_APPLY_ENABLED\s*=\s*true/.test(proveSrc)
    && !/provision-sunset-schema-observer-role/.test(proveSrc));

  pass('historical-owners-immutable',
    !/026_tenant_surf_pack_rules\.sql/.test(migSql) === false // comment may mention
    && fs.existsSync(path.join(MIGRATIONS_DIR, '026_tenant_surf_pack_rules.sql'))
    && fs.existsSync(path.join(MIGRATIONS_DIR, '032_client_notification_settings.sql'))
    && /Historical owners/i.test(migSql));

  pass('findings-document-objects-and-gates',
    /041_notification_surfpack_convergence/.test(findings)
    && /zero live mutation/i.test(findings)
    && PREV_FP.slice(0, 8).length === 8);

  console.log(`\n── verify:sunset-schema-slice13c3c ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
  process.exit(failed ? 1 : 0);
}

main();
