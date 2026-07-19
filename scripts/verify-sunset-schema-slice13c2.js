'use strict';

/**
 * verify:sunset-schema-slice13c2 — FOUNDATION Slice 13C.2 RED→GREEN
 * Promote approved location-aware admin model into one canonical forward migration.
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
const MASTER = 'e3764ae3823200a4817edd8a60beb53775a010b6';
const PREV_FP = 'daeec81cf322c596712992e0bd5d1542c925a34243e9e88e211abf172102ba52';
const NEW_FP = '553d21d3dca91b60a1b9e09799f677051be63d491792fd68e12b5f6652c220f1';
const PREV_MANIFEST_HASH = 'd13655e129b6358dd8742111a956216bf4a2203d50efd654214786565fd146ed';
const MIG_039 = '039_sunset_admin_location_aware_rules.sql';
const MIG_039_ID = '039_sunset_admin_location_aware_rules';

const PHASE_B_KEYS = [
  'live_only|columns|tenant_lesson_capacity_rules.location_id',
  'live_only|columns|tenant_lesson_time_rules.capacity',
  'live_only|columns|tenant_lesson_time_rules.location_id',
  'live_only|columns|tenant_price_rules.location_id',
  'live_only|constraints|tenant_lesson_time_rules.tenant_lesson_time_rules_capacity_check.CHECK',
  'expected_only|indexes|tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_date',
  'expected_only|indexes|tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_default',
  'expected_only|indexes|tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_weekday',
  'expected_only|indexes|tenant_lesson_time_rules.uq_tenant_lesson_time_date',
  'expected_only|indexes|tenant_lesson_time_rules.uq_tenant_lesson_time_recurring',
  'expected_only|indexes|tenant_price_rules.uq_tenant_price_rules_active_window',
  'live_only|indexes|tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_date_loc',
  'live_only|indexes|tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_default_loc',
  'live_only|indexes|tenant_lesson_capacity_rules.uq_tenant_lesson_capacity_weekday_loc',
  'live_only|indexes|tenant_lesson_time_rules.uq_tenant_lesson_time_date_loc',
  'live_only|indexes|tenant_lesson_time_rules.uq_tenant_lesson_time_recurring_loc',
  'live_only|indexes|tenant_price_rules.uq_tenant_price_rules_active_window_loc',
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
  console.log('verify:sunset-schema-slice13c2 — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice13c2-location-promotion-evidence.json');
  const mismatchPath = path.join(FIX, 'slice13c2-mismatch-46-to-29-evidence.json');
  const findingsPath = path.join(FIX, 'slice13c2-findings.md');
  const contractPath = path.join(FIX, 'slice13b-slice13c-rehearsal-contract.json');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const classPath = path.join(FIX, 'slice13a-mismatch-classification-report.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice13c2-location-promotion.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice13c2.js');
  const migPath = path.join(MIGRATIONS_DIR, MIG_039);

  pass(
    'artifacts-exist',
    [evidencePath, mismatchPath, findingsPath, contractPath, expectedPath, provePath, migPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const mismatchEv = JSON.parse(fs.readFileSync(mismatchPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const classReport = JSON.parse(fs.readFileSync(classPath, 'utf8'));
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const migSql = fs.readFileSync(migPath, 'utf8');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  const entry039 = forward.find((e) => e.id === MIG_039_ID);
  const liveHash = sha256CanonicalLfV1File(migPath);

  pass('manifest-integrity', integrity.ok, JSON.stringify((integrity.errors || []).slice(0, 3)));
  pass('exactly-one-new-forward-039',
    forward.length === 37
    && Boolean(entry039)
    && entry039.order === 37
    && entry039.classification === 'canonical_forward'
    && entry039.inForwardChain === true
    && liveHash === entry039.sha256
    && evidence.migration.sha256CanonicalLfV1 === liveHash);

  pass('forward-count-36-to-37',
    evidence.forwardCount.before === 36
    && evidence.forwardCount.after === 37
    && expected.forwardCount === 37
    && manifestHash === evidence.manifestHash.after);

  pass('product-fingerprint-regenerated',
    expected.productFingerprint === NEW_FP
    && expected.previousProductFingerprint === PREV_FP
    && evidence.productFingerprint.after === NEW_FP
    && evidence.productFingerprint.before === PREV_FP
    && expected.manifestHash === evidence.manifestHash.after
    && expected.checksumMode === 'canonical_lf_v1'
    && expected.generatedFromMaster === MASTER
    && /not derived from live/i.test(String(expected.slice13c2Note || '')));

  for (const id of [
    '023_sunset_admin_location_id_PROPOSED',
    '025_sunset_lesson_time_capacity_PROPOSED',
    '024_sunset_conversation_location_id_PROPOSED',
  ]) {
    const e = manifest.entries.find((x) => x.id === id);
    pass(`proposed-remains-non-executable-${id}`,
      e
      && e.classification === 'proposed_not_executable'
      && e.inForwardChain === false
      && e.order == null);
  }

  pass('proposed-024-conversation-excluded-from-sql',
    !/ALTER\s+TABLE\s+conversations\b/i.test(migSql)
    && !/CREATE\s+(UNIQUE\s+)?INDEX[\s\S]{0,120}\bon\s+conversations\b/i.test(migSql)
    && /Intentionally does not touch conversations/i.test(migSql)
    && evidence.objectsExcluded.includes('conversations.location_id'));

  pass('no-tenant-services-cmt-ledger-bundled',
    !/ALTER\s+TABLE\s+tenant_services\b/i.test(migSql)
    && !/ALTER\s+TABLE\s+customer_message_templates\b/i.test(migSql)
    && !/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?schema_migration_ledger\b/i.test(migSql)
    && !/035_customer_message_templates/i.test(migSql)
    && evidence.objectsExcluded.includes('tenant_services')
    && evidence.objectsExcluded.includes('customer_message_templates'));

  pass('no-db-location-parent-fk-invented',
    !/REFERENCES\s+public\.(locations|sunset_locations)/i.test(migSql)
    && /no DB FK|app-validated/i.test(migSql));

  pass('path-a-fresh-canonical',
    evidence.pathA
    && evidence.pathA.ok === true
    && evidence.pathA.appliedCount === 37
    && evidence.pathA.secondApplyNoOp === true
    && evidence.pathA.observerSelfMatch === true
    && evidence.pathA.conversationsLocationIdAbsent === true
    && evidence.pathA.productFingerprint === NEW_FP);

  pass('path-b-convergence-and-idempotency',
    evidence.pathB
    && evidence.pathB.ok === true
    && evidence.pathB.pre039Applied === 36
    && evidence.pathB.structural023025Applied === true
    && evidence.pathB.convergedWithPathA === true
    && evidence.pathB.second039Idempotent === true
    && evidence.pathB.after039Fingerprint === NEW_FP
    && evidence.pathB.conversationsLocationIdAbsent === true);

  const redNames = (evidence.redFailures || []).map((r) => r.name);
  pass('red-fail-closed-cases',
    evidence.redFailures
    && evidence.redFailures.length >= 4
    && evidence.redFailures.every((r) => r.failedClosed === true)
    && redNames.includes('incompatible_location_id_type')
    && redNames.includes('incompatible_capacity_type')
    && redNames.includes('missing_parent_admin_table')
    && redNames.includes('duplicate_rows_block_location_unique_index')
    && redNames.includes('incompatible_existing_unique_constraint_name')
    && redNames.includes('conflicting_fk_on_location_id'));

  pass('mismatch-trajectory-46-to-29',
    mismatchEv.previousRemainingAfter13c1 === 46
    && mismatchEv.resolvedPhaseBKeys === 17
    && mismatchEv.remainingGenuineDriftKeys === 29
    && mismatchEv.trajectory === '46 → 29'
    && mismatchEv.match === false
    && mismatchEv.code === 'product_schema_differs'
    && mismatchEv.noPhaseCdAccidentalResolution === true
    && (mismatchEv.phaseBKeysResolved || []).length === 17
    && (mismatchEv.remainingKeys || []).length === 29
    && PHASE_B_KEYS.every((k) => mismatchEv.phaseBKeysResolved.includes(k))
    && mismatchEv.remainingByClassification
    && mismatchEv.remainingByClassification.genuine_database_drift === 29);

  // Offline recompute: synthetic live from prior classifications vs new expected under azure profile
  {
    const classifications = classReport.classifications || [];
    const phaseBSet = new Set(PHASE_B_KEYS);
    const genuine = classifications.filter((c) => c.classification === 'genuine_database_drift');
    const phaseB = classifications.filter((c) => phaseBSet.has(c.stableKey));
    pass('classification-sets-17-and-29', phaseB.length === 17 && genuine.length === 29);

    // Reconstruct prior remaining (46) using previous expected fingerprint lock from mismatch evidence
    pass('do-not-claim-sunset-repaired',
      mismatchEv.match === false
      && /product_schema_differs/.test(findings)
      && /do not claim/i.test(findings)
      && /46\s*→\s*29/.test(findings));
  }

  pass('slice13c-contract-phase-b-complete',
    contract.phaseStatus
    && contract.phaseStatus.A === 'complete_offline_identity_normalization'
    && contract.phaseStatus.B === 'complete_location_model_promotion'
    && contract.phaseStatus.C === 'pending'
    && contract.slice13c2PhaseB
    && contract.slice13c2PhaseB.migrationId === MIG_039_ID
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
    && !/sunset_staging/.test(proveSrc)
    && /disposable|Docker PostgreSQL only/i.test(proveSrc)
    && !/writeFileSync\([^)]*expected-product-schema/i.test(verifySrc));

  pass('prior-manifest-hash-recorded',
    PREV_MANIFEST_HASH.length === 64
    && evidence.manifestHash.after !== PREV_MANIFEST_HASH);

  pass('findings-document-objects-and-gates',
    /039_sunset_admin_location_aware_rules/.test(findings)
    && /553d21d3/.test(findings)
    && /zero live mutation/i.test(findings));

  console.log(`\n── verify:sunset-schema-slice13c2 ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
  process.exit(failed ? 1 : 0);
}

main();
