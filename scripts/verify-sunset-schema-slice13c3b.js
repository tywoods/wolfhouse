'use strict';

/**
 * verify:sunset-schema-slice13c3b — FOUNDATION Slice 13C.3b RED→GREEN
 * Rehearse immutable migration 035 on disposable Phase-C drift pre-state.
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

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = 'b3b2cede917f588d3a7d6e322b28a7f377b8cd96';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '427206aeeed1890c3a1fa2f666d11b66411333811b071fb1af5986126d8d12eb';
const MIG_035 = '035_customer_message_templates.sql';
const MIG_035_ID = '035_customer_message_templates';
const EXPECTED_SHA = '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565';

const CMT_OWNED_KEYS = [
  'expected_only|acls|relation:customer_message_templates',
  'expected_only|columns|customer_message_templates.active',
  'expected_only|columns|customer_message_templates.body',
  'expected_only|columns|customer_message_templates.channel',
  'expected_only|columns|customer_message_templates.client_id',
  'expected_only|columns|customer_message_templates.created_at',
  'expected_only|columns|customer_message_templates.id',
  'expected_only|columns|customer_message_templates.tags',
  'expected_only|columns|customer_message_templates.title',
  'expected_only|columns|customer_message_templates.updated_at',
  'expected_only|constraints|customer_message_templates.customer_message_templates_client_id_fkey.FOREIGN KEY',
  'expected_only|constraints|customer_message_templates.customer_message_templates_pkey.PRIMARY KEY',
  'expected_only|indexes|customer_message_templates.customer_message_templates_pkey',
  'expected_only|indexes|customer_message_templates.idx_customer_message_templates_client_active',
  'expected_only|ownership|relation:customer_message_templates',
  'expected_only|rlsFlags|customer_message_templates',
  'expected_only|tables|customer_message_templates',
];

const MUST_REMAIN_KEYS = [
  'expected_only|constraints|tenant_services.tenant_services_date_window.CHECK',
  'expected_only|constraints|tenant_services.tenant_services_price_unit.CHECK',
  'expected_only|constraints|tenant_surf_pack_rules.tenant_surf_pack_rules_updated_by_fkey.FOREIGN KEY',
  'expected_only|indexes|client_notification_events.idx_client_notification_events_client_created',
  'expected_only|indexes|client_notification_events.idx_client_notification_events_conversation',
  'expected_only|indexes|client_notification_settings.idx_client_notification_settings_client',
  'expected_only|indexes|tenant_surf_pack_rules.idx_tenant_surf_pack_client_loc',
  'expected_only|triggers|tenant_surf_pack_rules.tenant_surf_pack_rules_updated_at',
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
  console.log('verify:sunset-schema-slice13c3b — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice13c3b-migration-035-rehearsal-evidence.json');
  const mismatchPath = path.join(FIX, 'slice13c3b-mismatch-25-to-8-evidence.json');
  const keyMapPath = path.join(FIX, 'slice13c3b-migration-035-owned-key-map.json');
  const findingsPath = path.join(FIX, 'slice13c3b-findings.md');
  const contractPath = path.join(FIX, 'slice13b-slice13c-rehearsal-contract.json');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice13c3b-migration-035-rehearsal.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice13c3b.js');
  const harnessPath = path.join(ROOT, 'scripts', 'lib', 'rehearse-migration-035-disposable.js');
  const migPath = path.join(MIGRATIONS_DIR, MIG_035);

  pass(
    'artifacts-exist',
    [evidencePath, mismatchPath, keyMapPath, findingsPath, contractPath, expectedPath, provePath, harnessPath, migPath]
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
  const harnessSrc = fs.readFileSync(harnessPath, 'utf8');
  const migSql = fs.readFileSync(migPath, 'utf8');
  const migBuf = fs.readFileSync(migPath);

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  const entry035 = forward.find((e) => e.id === MIG_035_ID);
  const liveHash = sha256CanonicalLfV1File(migPath);
  const expectedByteSha = crypto.createHash('sha256').update(fs.readFileSync(expectedPath)).digest('hex');

  pass('manifest-integrity', integrity.ok, JSON.stringify((integrity.errors || []).slice(0, 3)));

  pass('migration-035-byte-identical',
    liveHash === EXPECTED_SHA
    && entry035
    && entry035.sha256 === EXPECTED_SHA
    && evidence.migration.sha256CanonicalLfV1 === EXPECTED_SHA
    && evidence.migration.byteIdentical === true
    && /CREATE TABLE IF NOT EXISTS customer_message_templates/i.test(migSql)
    && /CREATE INDEX IF NOT EXISTS idx_customer_message_templates_client_active/i.test(migSql)
    && !/ALTER TABLE customer_message_templates/i.test(migSql));

  pass('no-new-forward-migration',
    forward.length === 38
    && evidence.migration.newForwardMigration === false
    && evidence.forwardCountUnchanged === 38
    && expected.forwardCount === 38
    && !fs.existsSync(path.join(MIGRATIONS_DIR, '041_*.sql'.replace('*', 'x')))
    && !fs.readdirSync(MIGRATIONS_DIR).some((f) => /^041_/.test(f)));

  pass('canonical-hashes-unchanged',
    expected.productFingerprint === CANON_FP
    && expected.manifestHash === MANIFEST_HASH
    && manifestHash === MANIFEST_HASH
    && evidence.productFingerprintUnchanged === CANON_FP
    && evidence.manifestHashUnchanged === MANIFEST_HASH
    && mismatchEv.fingerprints
    && mismatchEv.fingerprints.canonicalUnchanged === CANON_FP
    && evidence.expectedProductSchemaByteSha256 === expectedByteSha);

  pass('owned-key-map-exact-17',
    keyMap.ownedKeyCount === 17
    && Array.isArray(keyMap.keys)
    && keyMap.keys.length === 17
    && CMT_OWNED_KEYS.every((k) => keyMap.keys.some((e) => e.stableKey === k))
    && keyMap.keys.every((e) => e.object && e.type && e.expectedAction));

  pass('harness-disabled-no-ledger-provenance',
    /REHEARSAL_LIVE_APPLY_ENABLED\s*=\s*false/.test(harnessSrc)
    && /DEFAULT_DISPOSABLE_REHEARSAL_ENABLED\s*=\s*false/.test(harnessSrc)
    && /claimsCanonicalRunnerProvenance:\s*false/.test(harnessSrc)
    && /wroteSchemaMigrationLedger:\s*false/.test(harnessSrc)
    && evidence.harness
    && evidence.harness.defaultDisabled === true
    && evidence.harness.liveApplyEnabled === false
    && evidence.harness.claimsCanonicalRunnerProvenance === false
    && evidence.harness.wroteSchemaMigrationLedger === false
    && /assertSafeDatabaseTarget/.test(harnessSrc)
    && /preflightCustomerMessageTemplatesCompat/.test(harnessSrc));

  pass('catalog-preflight-not-035-rewrite',
    !/pg_attribute|attgenerated|preflight/i.test(migSql)
    && /pg_attribute|attgenerated|catalog/i.test(String(evidence.harness.catalogPreflight || ''))
    && Buffer.compare(migBuf, fs.readFileSync(migPath)) === 0);

  pass('path-a-absent-cluster',
    evidence.pathA
    && evidence.pathA.ok === true
    && evidence.pathA.absentClusterCreated === true
    && evidence.pathA.cmtClusterMatchesExpected === true
    && evidence.pathA.secondApplyPreserveNoOp === true
    && evidence.pathA.canonicalOutOfSequenceDoesNotRecreateCmt === true);

  pass('path-b-compatible-preserve',
    evidence.pathB
    && evidence.pathB.ok === true
    && evidence.pathB.exactCompatiblePreseed === true
    && evidence.pathB.preserveNoOp === true
    && evidence.pathB.attnumStable === true
    && evidence.pathB.secondApplyNoOp === true);

  const redNames = (evidence.redFailures || []).map((r) => r.name);
  const requiredRed = [
    'incompatible_column_type',
    'incompatible_column_default',
    'incompatible_column_nullability',
    'incompatible_generated_column',
    'incompatible_pk',
    'incompatible_fk',
    'incompatible_index',
    'incompatible_rls_enabled',
    'missing_clients_parent',
  ];
  pass('red-fail-closed-cases',
    evidence.redFailures
    && evidence.redFailures.length >= requiredRed.length
    && evidence.redFailures.every((r) => r.failedClosed === true)
    && requiredRed.every((n) => redNames.includes(n)));

  pass('green-dsn-and-disabled-gates',
    evidence.greenCases
    && evidence.greenCases.every((g) => g.ok === true)
    && evidence.greenCases.some((g) => g.name === 'non_disposable_dsn_rejected')
    && evidence.greenCases.some((g) => g.name === 'harness_disabled_by_default'));

  pass('mismatch-trajectory-25-to-8',
    mismatchEv.previousRemainingAfter13c3a === 25
    && mismatchEv.resolvedMigration035OwnedKeys === 17
    && mismatchEv.remainingGenuineDriftKeys === 8
    && mismatchEv.trajectory === '25 → 8'
    && mismatchEv.trajectoryFrom25Exact
    && mismatchEv.trajectoryFrom25Exact.before === 25
    && mismatchEv.trajectoryFrom25Exact.after === 8
    && mismatchEv.match === false
    && mismatchEv.code === 'product_schema_differs'
    && (mismatchEv.migration035OwnedKeysResolved || []).length === 17
    && (mismatchEv.remainingKeys || []).length === 8
    && CMT_OWNED_KEYS.every((k) => mismatchEv.migration035OwnedKeysResolved.includes(k))
    && MUST_REMAIN_KEYS.every((k) => (mismatchEv.remainingKeys || []).includes(k))
    && mismatchEv.noNotificationSurfPackOrPhaseDResolution === true
    && mismatchEv.remainingByClassification
    && mismatchEv.remainingByClassification.genuine_database_drift === 8);

  pass('slice13c-contract-phase-c-cmt-rehearsal',
    contract.phaseStatus
    && contract.phaseStatus.A === 'complete_offline_identity_normalization'
    && contract.phaseStatus.B === 'complete_location_model_promotion'
    && contract.phaseStatus.C === 'partial_cmt_035_rehearsal_complete'
    && contract.phaseStatus.D === 'pending'
    && contract.slice13c3bPhaseC
    && contract.slice13c3bPhaseC.migrationId === MIG_035_ID
    && contract.slice13c3bPhaseC.newForwardMigration === false
    && contract.slice13c3aPhaseC
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
    !/\bLIVE_APPLY_ENABLED\s*=\s*true\b/.test(proveSrc)
    && !/\bREHEARSAL_LIVE_APPLY_ENABLED\s*=\s*true\b/.test(harnessSrc)
    && !/az\s+postgres/i.test(proveSrc)
    && /database:\s*'sunset_staging'/.test(proveSrc) // only as rejected RED fixture DSN
    && /non-disposable DSN/.test(proveSrc)
    && !/CREATE DATABASE sunset_staging/i.test(proveSrc)
    && /disposable/i.test(proveSrc)
    && !/writeFileSync\([^)]*expected-product-schema/i.test(proveSrc)
    && !/writeFileSync\([^)]*expected-product-schema/i.test(verifySrc));

  pass('master-sha-basis',
    evidence.masterShaBasis === MASTER
    && mismatchEv.masterShaBasis === MASTER
    && /b3b2cede917f588d3a7d6e322b28a7f377b8cd96/.test(findings));

  pass('findings-document-trajectory-and-zero-live',
    /25\s*→\s*8/.test(findings)
    && /924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565/.test(findings)
    && /zero live mutation/i.test(findings)
    && /do not claim/i.test(findings)
    && /byte-identical/i.test(findings));

  console.log(`\n── verify:sunset-schema-slice13c3b ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
  process.exit(failed ? 1 : 0);
}

main();
