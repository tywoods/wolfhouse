'use strict';

/**
 * verify:sunset-schema-slice14a — FOUNDATION Slice 14A RED→GREEN
 * Phase D CHECK aggregate preflight (source-only / disposable proof).
 * Offline gates + evidence. No Azure / live mutation.
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
  MIG_028,
  EXPECTED_028_SHA256,
  PHASE_D_LIVE_APPLY_ENABLED,
  DEFAULT_PHASE_D_PREFLIGHT_ENABLED,
  AUTHORIZED_AGGREGATE_SQL,
  OUTPUT_KEYS,
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
  AGGREGATE_CONTRACT,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
  authorizeAggregateSql,
} = require('./lib/phase-d-check-preflight');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '935d278b01c49344ed6e6ef729ac36de5b7d5400';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const REQUIRED_CASES = [
  'zero_violations',
  'date_window_violation_class',
  'price_unit_violation_class',
  'null_semantics',
  'mixed_rows',
  'wrong_schema_type_fail_closed',
  'read_only_transaction_session',
  'exact_aggregate_query_authorization',
  'no_data_leakage',
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
  console.log('verify:sunset-schema-slice14a — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14a-phase-d-preflight-evidence.json');
  const contractPath = path.join(FIX, 'slice14a-phase-d-preflight-contract.json');
  const findingsPath = path.join(FIX, 'slice14a-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14a-phase-d-preflight.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14a.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-check-preflight.js');
  const rehearsalContractPath = path.join(FIX, 'slice13b-slice13c-rehearsal-contract.json');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, libPath, rehearsalContractPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const libSrc = fs.readFileSync(libPath, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const expectedBytes = fs.readFileSync(expectedPath);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);

  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, MIG_028));
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));

  pass('manifest-integrity', integrity.ok, JSON.stringify((integrity.errors || []).slice(0, 3)));
  pass('forward-count-unchanged-39',
    forward.length === 39
    && expected.forwardCount === 39
    && evidence.forwardCountUnchanged === 39
    && evidence.newForwardMigration === false);

  pass('locked-hashes-unchanged',
    live028 === LOCKED_13C_SHA['028']
    && live035 === LOCKED_13C_SHA['035']
    && live040 === LOCKED_13C_SHA['040']
    && live041 === LOCKED_13C_SHA['041']
    && manifestHash === MANIFEST_HASH
    && expectedHash === EXPECTED_BYTE_SHA
    && expected.productFingerprint === CANON_FP
    && evidence.migrationHashes['028'] === LOCKED_13C_SHA['028']
    && evidence.migrationHashes['035'] === LOCKED_13C_SHA['035']
    && evidence.migrationHashes['040'] === LOCKED_13C_SHA['040']
    && evidence.migrationHashes['041'] === LOCKED_13C_SHA['041']
    && evidence.manifestHashUnchanged === MANIFEST_HASH
    && evidence.productFingerprintUnchanged === CANON_FP
    && evidence.expectedProductSchemaByteSha256 === EXPECTED_BYTE_SHA
    && assertMigration028ByteIntegrity() === EXPECTED_028_SHA256
    && assert028PredicatesPresentInSource() === true);

  pass('master-sha-basis',
    evidence.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER
    && /935d278b01c49344ed6e6ef729ac36de5b7d5400/.test(findings));

  pass('default-disabled-no-live-apply',
    PHASE_D_LIVE_APPLY_ENABLED === false
    && DEFAULT_PHASE_D_PREFLIGHT_ENABLED === false
    && evidence.defaultDisabled === true
    && evidence.liveApplyEnabled === false
    && contract.defaultEnabled === false
    && contract.liveApplyCapability === false
    && evidence.phaseDConstraintsApplied === false
    && evidence.liveMutation === false
    && evidence.azureConnectivity === false
    && evidence.firewallAction === false
    && evidence.migrationAdded === false
    && evidence.ledgerWritten === false
    && evidence.applyFlagPresent === false);

  pass('aggregate-contract-locked',
    contract.aggregateContract.authorizedAggregateSql === AUTHORIZED_AGGREGATE_SQL
    && evidence.aggregateContract.authorizedAggregateSql === AUTHORIZED_AGGREGATE_SQL
    && contract.predicates.date_window === DATE_WINDOW_PREDICATE
    && contract.predicates.price_unit === PRICE_UNIT_PREDICATE
    && OUTPUT_KEYS.every((k) => contract.outputKeys.includes(k))
    && contract.aggregateContract.returnsRowValues === false
    && contract.aggregateContract.acceptsArbitrarySql === false
    && AGGREGATE_CONTRACT.mutates === false
    && AGGREGATE_CONTRACT.appliesConstraints === false
    && /end_date IS NULL OR start_date IS NULL OR end_date >= start_date/.test(AUTHORIZED_AGGREGATE_SQL)
    && /price_unit IN \('per_day', 'per_week', 'per_stay', 'one_off'\)/.test(AUTHORIZED_AGGREGATE_SQL));

  let authOk = false;
  let authBad = false;
  try {
    authorizeAggregateSql(AUTHORIZED_AGGREGATE_SQL);
    authOk = true;
  } catch (_) { authOk = false; }
  try {
    authorizeAggregateSql('SELECT * FROM tenant_services');
  } catch (e) {
    authBad = e.code === 'unauthorized_sql';
  }
  pass('exact-aggregate-query-authorization', authOk && authBad);

  const caseNames = (evidence.disposableProofCases || []).map((c) => c.name);
  pass('disposable-proof-matrix',
    REQUIRED_CASES.every((n) => caseNames.includes(n))
    && (evidence.disposableProofCases || []).every((c) => c.ok === true)
    && evidence.offlineGates.defaultDisabledRejected === true
    && evidence.offlineGates.unauthorizedSqlRejected === true
    && evidence.offlineGates.nonLoopbackRejected === true
    && evidence.offlineGates.azureTargetFailClosed === true);

  const zero = (evidence.disposableProofCases || []).find((c) => c.name === 'zero_violations');
  const mixed = (evidence.disposableProofCases || []).find((c) => c.name === 'mixed_rows');
  const leak = (evidence.disposableProofCases || []).find((c) => c.name === 'no_data_leakage');
  const ro = (evidence.disposableProofCases || []).find((c) => c.name === 'read_only_transaction_session');
  pass('proof-counts-and-leak-guards',
    zero
    && zero.counts.total_rows === 4
    && zero.counts.date_window_violations === 0
    && zero.counts.price_unit_violations === 0
    && mixed
    && mixed.counts.date_window_violations === 2
    && mixed.counts.price_unit_violations === 2
    && leak
    && leak.outputKeysOnly === true
    && ro
    && ro.preflightReadOnly === true
    && ro.writeRejectedInReadOnlyTxn === true);

  pass('source-forbids-live-mutation-paths',
    !/LIVE_APPLY_ENABLED\s*=\s*true/.test(libSrc)
    && !/PHASE_D_LIVE_APPLY_ENABLED\s*=\s*true/.test(libSrc)
    && !/\baz\s+postgres\b/i.test(proveSrc)
    && !/\baz\s+network\b/i.test(proveSrc)
    && !/--apply\b/.test(libSrc)
    && !/liveApply\s*:\s*true/.test(libSrc)
    && !/ADD\s+CONSTRAINT\s+tenant_services_date_window/i.test(libSrc)
    && !/ADD\s+CONSTRAINT\s+tenant_services_price_unit/i.test(libSrc)
    && !/schema_migration_ledger/.test(libSrc)
    && /BEGIN READ ONLY/.test(libSrc)
    && /unauthorized_sql/.test(libSrc)
    && /assertSafeDatabaseTarget/.test(libSrc)
    && /non_disposable_dsn|non-loopback/.test(libSrc + proveSrc)
    && evidence.stillProductSchemaDiffers === true
    // Rejection probes may mention Azure hostnames; they must fail closed, never connect.
    && /sunset-staging\.postgres\.database\.azure\.com/.test(proveSrc)
    && /nonLoopbackRejected|non_disposable_dsn/.test(proveSrc));

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14a-phase-d-preflight']
      === 'node scripts/prove-sunset-schema-slice14a-phase-d-preflight.js'
    && pkg.scripts['verify:sunset-schema-slice14a']
      === 'node scripts/verify-sunset-schema-slice14a.js');

  pass('findings-non-claim',
    /Do not claim/i.test(findings)
    && /Phase D/.test(findings)
    && /Zero live\/Azure mutation/i.test(findings)
    && /ADD CONSTRAINT/i.test(findings)
    && !/Sunset is repaired/i.test(findings.replace(/Do not claim[\s\S]*?repaired/i, '')));

  pass('no-secret-tokens-in-artifacts',
    !/GUEST_SECRET_|evil@example\.com|notes-should-never-leak/.test(
      `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`,
    ));

  pass('verify-is-offline-only',
    !/require\(['"]\.\/lib\/disposable-postgres-harness['"]\)/.test(verifySrc)
    && !/require\(['"]pg['"]\)/.test(verifySrc)
    && !/host:\s*['"][^'"]*azure/i.test(verifySrc)
    && !/Client\s*\(\s*\{/.test(verifySrc));

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14a FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14a GREEN');
}

main();
