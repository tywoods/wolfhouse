'use strict';

/**
 * verify:sunset-schema-slice13c3a — FOUNDATION Slice 13C.3a RED→GREEN
 * Promote approved tenant_services live-only columns into one canonical forward migration.
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
const MASTER = '5158320585f0a894329d8ff017fa658d86d041bf';
const PREV_FP = '553d21d3dca91b60a1b9e09799f677051be63d491792fd68e12b5f6652c220f1';
const PREV_MANIFEST_HASH = '7ac14e1637b7e58f28bda8f494f8556dd0f03c27c00a04340ebf941f19e7beb0';
const MIG_040 = '040_tenant_services_saas_catalog_columns.sql';
const MIG_040_ID = '040_tenant_services_saas_catalog_columns';

const PHASE_C_TENANT_SERVICES_COLUMN_KEYS = [
  'live_only|columns|tenant_services.block_rooms_enabled',
  'live_only|columns|tenant_services.blocked_room_codes',
  'live_only|columns|tenant_services.room_block_booking_ids',
  'live_only|columns|tenant_services.weekdays',
];

const MUST_REMAIN_KEYS = [
  'expected_only|constraints|tenant_services.tenant_services_date_window.CHECK',
  'expected_only|constraints|tenant_services.tenant_services_price_unit.CHECK',
  'expected_only|tables|customer_message_templates',
  'expected_only|indexes|client_notification_events.idx_client_notification_events_client_created',
  'expected_only|indexes|tenant_surf_pack_rules.idx_tenant_surf_pack_client_loc',
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
  console.log('verify:sunset-schema-slice13c3a — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice13c3a-tenant-services-promotion-evidence.json');
  const mismatchPath = path.join(FIX, 'slice13c3a-mismatch-29-to-25-evidence.json');
  const findingsPath = path.join(FIX, 'slice13c3a-findings.md');
  const contractPath = path.join(FIX, 'slice13b-slice13c-rehearsal-contract.json');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const classPath = path.join(FIX, 'slice13a-mismatch-classification-report.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice13c3a-tenant-services-promotion.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice13c3a.js');
  const migPath = path.join(MIGRATIONS_DIR, MIG_040);

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
  const entry040 = forward.find((e) => e.id === MIG_040_ID);
  const liveHash = sha256CanonicalLfV1File(migPath);
  const NEW_FP = expected.productFingerprint;

  pass('manifest-integrity', integrity.ok, JSON.stringify((integrity.errors || []).slice(0, 3)));
  pass('exactly-one-new-forward-040',
    forward.length === 38
    && Boolean(entry040)
    && entry040.order === 38
    && entry040.classification === 'canonical_forward'
    && entry040.inForwardChain === true
    && liveHash === entry040.sha256
    && evidence.migration.sha256CanonicalLfV1 === liveHash);

  pass('forward-count-37-to-38',
    evidence.forwardCount.before === 37
    && evidence.forwardCount.after === 38
    && expected.forwardCount === 38
    && manifestHash === evidence.manifestHash.after);

  pass('product-fingerprint-regenerated',
    expected.productFingerprint === evidence.productFingerprint.after
    && expected.previousProductFingerprint === PREV_FP
    && evidence.productFingerprint.before === PREV_FP
    && expected.manifestHash === evidence.manifestHash.after
    && expected.checksumMode === 'canonical_lf_v1'
    && expected.generatedFromMaster === MASTER
    && /not derived from live/i.test(String(expected.slice13c3aNote || '')));

  pass('domain-scope-tenant-services-columns-only',
    (evidence.objectsPromoted || []).length === 4
    && evidence.objectsPromoted.every((c) => c.startsWith('tenant_services.'))
    && evidence.fieldMatrix
    && evidence.fieldMatrix.length === 4
    && evidence.fieldMatrix.every((r) => r.decision === 'promote'));

  pass('no-phase-d-checks-or-other-phase-c-bundled',
    !/ADD\s+CONSTRAINT\s+tenant_services_date_window/i.test(migSql)
    && !/ADD\s+CONSTRAINT\s+tenant_services_price_unit/i.test(migSql)
    && !/ALTER\s+TABLE\s+customer_message_templates\b/i.test(migSql)
    && !/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?schema_migration_ledger\b/i.test(migSql)
    && !/035_customer_message_templates/i.test(migSql)
    && !/tenant_surf_pack_rules/i.test(migSql)
    && !/client_notification_/i.test(migSql)
    && evidence.objectsExcluded.includes('tenant_services_date_window CHECK')
    && evidence.objectsExcluded.includes('customer_message_templates'));

  pass('path-a-fresh-canonical',
    evidence.pathA
    && evidence.pathA.ok === true
    && evidence.pathA.appliedCount === 38
    && evidence.pathA.secondApplyNoOp === true
    && evidence.pathA.observerSelfMatch === true
    && evidence.pathA.promotedColumnsPresent === true
    && evidence.pathA.phaseDChecksUnchanged === true
    && evidence.pathA.productFingerprint === NEW_FP);

  pass('path-b-convergence-and-idempotency',
    evidence.pathB
    && evidence.pathB.ok === true
    && evidence.pathB.pre040Applied === 37
    && evidence.pathB.ensureLiveDdlApplied === true
    && evidence.pathB.convergedWithPathA === true
    && evidence.pathB.second040Idempotent === true
    && evidence.pathB.after040Fingerprint === NEW_FP
    && evidence.pathB.exactColumnsPreservedByAttnum === true);

  const redNames = (evidence.redFailures || []).map((r) => r.name);
  const requiredRed = [
    'incompatible_weekdays_type',
    'incompatible_block_rooms_enabled_type',
    'incompatible_blocked_room_codes_nullable',
    'incompatible_room_block_booking_ids_default',
    'missing_parent_tenant_services_table',
    'generated_weekdays_column',
  ];
  pass('red-fail-closed-cases',
    evidence.redFailures
    && evidence.redFailures.length >= requiredRed.length
    && evidence.redFailures.every((r) => r.failedClosed === true)
    && requiredRed.every((n) => redNames.includes(n)));

  {
    const genRed = (evidence.redFailures || []).find((r) => r.name === 'generated_weekdays_column');
    pass('red-generated-weekdays-hits-attgenerated',
      Boolean(genRed)
      && genRed.failedClosed === true
      && /is a generated column/i.test(String(genRed.message || ''))
      && /weekdays SMALLINT\[] NOT NULL GENERATED ALWAYS AS/i.test(proveSrc));
  }

  pass('green-preserve-exact-columns',
    evidence.greenCases
    && evidence.greenCases.every((g) => g.ok === true)
    && evidence.catalogValidation
    && /pg_attribute|attgenerated|catalog/i.test(String(evidence.catalogValidation.approach || '')));

  pass('mismatch-trajectory-29-to-25',
    mismatchEv.previousRemainingAfter13c2 === 29
    && mismatchEv.resolvedPhaseCTenantServicesColumnKeys === 4
    && mismatchEv.remainingGenuineDriftKeys === 25
    && mismatchEv.trajectory === '29 → 25'
    && mismatchEv.match === false
    && mismatchEv.code === 'product_schema_differs'
    && mismatchEv.noOtherPhaseCAccidentalResolution === true
    && (mismatchEv.phaseCTenantServicesColumnKeysResolved || []).length === 4
    && (mismatchEv.remainingKeys || []).length === 25
    && PHASE_C_TENANT_SERVICES_COLUMN_KEYS.every((k) => mismatchEv.phaseCTenantServicesColumnKeysResolved.includes(k))
    && MUST_REMAIN_KEYS.every((k) => (mismatchEv.remainingKeys || []).includes(k))
    && mismatchEv.remainingByClassification
    && mismatchEv.remainingByClassification.genuine_database_drift === 25);

  {
    const classifications = classReport.classifications || [];
    const phaseCSet = new Set(PHASE_C_TENANT_SERVICES_COLUMN_KEYS);
    const genuine = classifications.filter((c) => c.classification === 'genuine_database_drift');
    const phaseC = classifications.filter((c) => phaseCSet.has(c.stableKey));
    pass('classification-sets-4-and-29', phaseC.length === 4 && genuine.length === 29);
    pass('do-not-claim-sunset-repaired',
      mismatchEv.match === false
      && /product_schema_differs/.test(findings)
      && /do not claim/i.test(findings)
      && /29\s*→\s*25/.test(findings));
  }

  pass('slice13c-contract-phase-c-partial',
    contract.phaseStatus
    && contract.phaseStatus.A === 'complete_offline_identity_normalization'
    && contract.phaseStatus.B === 'complete_location_model_promotion'
    && contract.phaseStatus.C === 'partial_tenant_services_columns_complete'
    && contract.slice13c3aPhaseC
    && contract.slice13c3aPhaseC.migrationId === MIG_040_ID
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
    && evidence.manifestHash.before === PREV_MANIFEST_HASH
    && evidence.manifestHash.after !== PREV_MANIFEST_HASH);

  pass('findings-document-objects-and-gates',
    /040_tenant_services_saas_catalog_columns/.test(findings)
    && NEW_FP.slice(0, 8).length === 8
    && /zero live mutation/i.test(findings));

  console.log(`\n── verify:sunset-schema-slice13c3a ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
  process.exit(failed ? 1 : 0);
}

main();
