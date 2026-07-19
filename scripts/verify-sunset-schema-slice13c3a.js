'use strict';

/**
 * verify:sunset-schema-slice13c3a — FOUNDATION Slice 13C.3a RED→GREEN
 * Promote approved tenant_services columns only. Offline + disposable evidence.
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
const NEW_FP = '2ecbb8ca07dcf21845931655756f98146870672d706ac7eea40f813997660828';
const MIG_040 = '040_tenant_services_catalog_columns.sql';
const MIG_040_ID = '040_tenant_services_catalog_columns';

const PHASE_C_TS_KEYS = [
  'live_only|columns|tenant_services.block_rooms_enabled',
  'live_only|columns|tenant_services.blocked_room_codes',
  'live_only|columns|tenant_services.room_block_booking_ids',
  'live_only|columns|tenant_services.weekdays',
];

const PHASE_D_CHECK_KEYS = [
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
  console.log('verify:sunset-schema-slice13c3a — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice13c3a-tenant-services-columns-evidence.json');
  const mismatchPath = path.join(FIX, 'slice13c3a-mismatch-29-to-25-evidence.json');
  const matrixPath = path.join(FIX, 'slice13c3a-tenant-services-column-matrix.json');
  const findingsPath = path.join(FIX, 'slice13c3a-findings.md');
  const contractPath = path.join(FIX, 'slice13b-slice13c-rehearsal-contract.json');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice13c3a-tenant-services-columns.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice13c3a.js');
  const migPath = path.join(MIGRATIONS_DIR, MIG_040);

  pass(
    'artifacts-exist',
    [evidencePath, mismatchPath, matrixPath, findingsPath, contractPath, expectedPath, provePath, migPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const mismatchEv = JSON.parse(fs.readFileSync(mismatchPath, 'utf8'));
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
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
  const entry040 = forward.find((e) => e.id === MIG_040_ID);
  const liveHash = sha256CanonicalLfV1File(migPath);

  pass('manifest-integrity', integrity.ok);
  pass('exactly-one-new-forward-040',
    forward.length === 38
    && Boolean(entry040)
    && entry040.order === 38
    && liveHash === entry040.sha256
    && evidence.migration.sha256CanonicalLfV1 === liveHash);

  pass('forward-count-37-to-38',
    evidence.forwardCount.before === 37
    && evidence.forwardCount.after === 38
    && expected.forwardCount === 38
    && manifestHash === evidence.manifestHash.after);

  pass('product-fingerprint-regenerated',
    expected.productFingerprint === NEW_FP
    && expected.previousProductFingerprint === PREV_FP
    && evidence.productFingerprint.after === NEW_FP
    && /not derived from live/i.test(String(expected.slice13c3aNote || ''))
    && expected.generatedFromMaster === MASTER);

  pass('matrix-promotes-exactly-four-columns',
    (matrix.columns || []).length === 4
    && matrix.columns.every((c) => c.decision === 'promote')
    && PHASE_C_TS_KEYS.every((k) => matrix.columns.some((c) => k.endsWith(`.${c.name}`))));

  pass('only-tenant-services-approved-columns',
    evidence.columnsPromoted
    && evidence.columnsPromoted.length === 4
    && /weekdays|block_rooms_enabled|blocked_room_codes|room_block_booking_ids/.test(migSql)
    && !/ADD\s+CONSTRAINT\s+tenant_services_date_window/i.test(migSql)
    && !/ADD\s+CONSTRAINT\s+tenant_services_price_unit/i.test(migSql)
    && /does not add Phase D CHECKs/i.test(migSql));

  pass('no-other-phase-c-domains-bundled',
    !/CREATE\s+TABLE\s+customer_message_templates/i.test(migSql)
    && !/035_customer_message_templates/i.test(migSql)
    && !/idx_client_notification/i.test(migSql)
    && !/tenant_surf_pack_rules/i.test(migSql)
    && !/schema_migration_ledger/i.test(migSql)
    && evidence.objectsExcluded.includes('035_customer_message_templates'));

  pass('phase-d-checks-absent-from-040',
    !/ADD\s+CONSTRAINT\s+tenant_services_date_window/i.test(migSql)
    && !/ADD\s+CONSTRAINT\s+tenant_services_price_unit/i.test(migSql)
    && /does not add Phase D CHECKs/i.test(migSql));

  pass('path-a-b-noop-and-preserve',
    evidence.pathA.ok
    && evidence.pathA.appliedCount === 38
    && evidence.pathA.secondApplyNoOp
    && evidence.pathB.ok
    && evidence.pathB.convergedWithPathA
    && evidence.pathB.second040Idempotent
    && evidence.pathB.exactColumnsPreservedByAttnum);

  const redNames = (evidence.redFailures || []).map((r) => r.name);
  pass('red-fail-closed',
    evidence.redFailures.every((r) => r.failedClosed)
    && redNames.includes('incompatible_weekdays_type')
    && redNames.includes('incompatible_block_rooms_nullability')
    && redNames.includes('incompatible_blocked_room_codes_default')
    && redNames.includes('incompatible_room_block_generated')
    && redNames.includes('missing_parent_tenant_services'));

  pass('mismatch-trajectory-29-to-25',
    mismatchEv.previousRemainingAfter13c2 === 29
    && mismatchEv.resolvedPhaseCTenantServicesColumnKeys === 4
    && mismatchEv.remainingGenuineDriftKeys === 25
    && mismatchEv.trajectory === '29 → 25'
    && mismatchEv.match === false
    && mismatchEv.code === 'product_schema_differs'
    && PHASE_C_TS_KEYS.every((k) => mismatchEv.phaseCTenantServicesKeysResolved.includes(k))
    && PHASE_D_CHECK_KEYS.every((k) => mismatchEv.remainingKeys.includes(k))
    && mismatchEv.remainingKeys.length === 25);

  pass('slice13c-contract-phase-c-partial',
    contract.phaseStatus.C === 'partial_tenant_services_columns'
    && contract.slice13c3aPhaseCpartial
    && contract.slice13c3aPhaseCpartial.migrationId === MIG_040_ID
    && contract.liveApplyCapability === false);

  pass('design-safety',
    evidence.secretFree
    && evidence.liveMutation === false
    && evidence.disposablePostgreSQLOnly === true
    && mismatchEv.blessesLiveAsCanonical === false
    && !/\bLIVE_APPLY_ENABLED\b/.test(proveSrc)
    && !/writeFileSync\([^)]*expected-product-schema/i.test(verifySrc)
    && /disposable|Docker PostgreSQL only/i.test(proveSrc));

  pass('findings',
    /040_tenant_services_catalog_columns/.test(findings)
    && /29\s*→\s*25/.test(findings)
    && /zero live mutation/i.test(findings)
    && /2ecbb8ca/.test(findings));

  console.log(`\n── verify:sunset-schema-slice13c3a ${failed ? 'FAILED' : 'PASSED'} (failed=${failed}) ──`);
  process.exit(failed ? 1 : 0);
}

main();
