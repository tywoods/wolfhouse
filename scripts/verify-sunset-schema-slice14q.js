'use strict';

/**
 * verify:sunset-schema-slice14q — FOUNDATION Slice 14Q RED→GREEN
 * Active DB target authority (offline gates + optional live evidence).
 * Does NOT re-run live ARM/KV/PostgreSQL.
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
  EXPECTED_028_SHA256,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');
const {
  PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED,
  APPLICATION_NAME,
  AUTHORITY_LOCKS,
  evaluateTargetAuthorityGates,
  executeActiveDbTargetAuthority,
  createInjectedTargetAuthorityHttp,
  createScriptedTargetAuthorityFakeClientFactory,
  resetTargetAuthorityCounters,
  getTargetAuthorityCounters,
  exactTargetAuthorityArgv,
  targetAuthorityEnv,
  buildOfflineProofSunsetDatabaseUrl,
  buildLockedArmContainerAppPath,
  buildLockedArmListSecretsPath,
  classifyDrift,
} = require('./lib/phase-d-active-db-target-authority');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '85ad38b16146bcc9cbc2abbca8a77fa1471bf3df';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_prove_flag_zero_http',
  'missing_target_authority_env_zero_http',
  'wrong_exact_targets_zero_http',
  'forbidden_argv_dsn_sql_retry_zero_http',
  'managed_identity_requires_env_and_argv',
  'mismatched_app_kv_target',
  'secret_ref_ambiguous',
  'multiple_active_revisions',
  'missing_db_env',
  'malformed_dsn',
  'secret_leakage_scan',
  'non_read_only_session',
  'observer_shape',
];

const REQUIRED_GREEN = [
  'injected_http_same_keyvault_ref_authority',
  'injected_http_value_compare_same_target',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'sparse_vs_wrong_target_classification',
];

const ALLOWED_DRIFT_CODES = new Set([
  'wrong_target',
  'genuinely_sparse_active_runtime_db',
  'observation_defect',
  'observer_match',
  'schema_divergence',
]);

const FAKE_USER = 'verify-slice14q-admin-user';
const FAKE_PASSWORD = 'verify-slice14q-admin-password';
const FAKE_TOKEN = 'verify-slice14q-imds-token';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14q — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14q-active-db-target-authority-evidence.json');
  const contractPath = path.join(FIX, 'slice14q-active-db-target-authority-contract.json');
  const findingsPath = path.join(FIX, 'slice14q-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14q-active-db-target-authority.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14q.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-active-db-target-authority.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-active-db-target-authority.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, verifyPath, cliPath, libPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
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

  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));

  pass('manifest-integrity', integrity.ok === true);
  pass('forward-count-39', forward.length === 39);
  pass('manifest-hash-preserved', manifestHash === MANIFEST_HASH
    && evidence.manifestHashUnchanged === MANIFEST_HASH);
  pass('expected-byte-sha-preserved', expectedHash === EXPECTED_BYTE_SHA
    && evidence.expectedProductSchemaByteSha256 === EXPECTED_BYTE_SHA);
  pass('product-fingerprint-preserved', evidence.productFingerprintUnchanged === CANON_FP);
  pass('migration-028-hash', live028 === LOCKED_13C_SHA['028']);
  pass('migration-035-hash', live035 === LOCKED_13C_SHA['035']);
  pass('migration-040-hash', live040 === LOCKED_13C_SHA['040']);
  pass('migration-041-hash', live041 === LOCKED_13C_SHA['041']);
  assertMigration028ByteIntegrity();
  assert028PredicatesPresentInSource();
  pass('global-apply-disabled-capability-enabled',
    PHASE_D_LIVE_APPLY_ENABLED === false
    && PHASE_D_TARGET_AUTHORITY_LIVE_ENABLED === true
    && PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true);
  pass('application-name', APPLICATION_NAME === 'wh-sunset-target-authority');

  pass('evidence-shape',
    evidence.kind === 'sunset-schema-observer-slice14q-active-db-target-authority-evidence'
    && evidence.secretFree === true
    && evidence.slice === '14Q'
    && evidence.liveMutation === false
    && evidence.schemaMutation === false
    && evidence.dataMutation === false
    && evidence.ledgerWritten === false
    && evidence.kvMutation === false
    && evidence.forwardCountUnchanged === 39);

  pass('contract-shape',
    contract.kind === 'sunset-schema-observer-slice14q-active-db-target-authority-contract'
    && contract.verifyNeverRerunsLive === true
    && contract.readOnlyAuthorityProof === true
    && contract.writesLedger === false
    && contract.dataMutation === false
    && contract.schemaMutation === false
    && contract.liveMutation === false
    && contract.globalLiveApplyEnabled === false
    && contract.targetAuthorityLiveEnabled === true);

  const redNames = (evidence.redCases || []).map((c) => c.name);
  const greenNames = (evidence.greenCases || []).map((c) => c.name);
  pass('red-cases-complete', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('green-cases-complete', REQUIRED_GREEN.every((n) => greenNames.includes(n)));
  pass('red-cases-ok', (evidence.redCases || []).every((c) => c.ok === true));
  pass('green-cases-ok', (evidence.greenCases || []).every((c) => c.ok === true));

  pass('master-basis',
    evidence.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER);

  pass('authority-locks',
    evidence.authorityLocks
    && evidence.authorityLocks.applicationName === 'wh-sunset-target-authority'
    && evidence.authorityLocks.containerAppName === 'luna-sunset-staging-staff-api'
    && evidence.authorityLocks.keyVaultName === AUTHORITY_LOCKS.keyVaultName
    && evidence.authorityLocks.secretName === AUTHORITY_LOCKS.secretName
    && evidence.authorityLocks.postgresHost === TARGETS.postgresHost
    && evidence.authorityLocks.database === TARGETS.database
    && evidence.authorityLocks.sslmode === 'verify-full'
    && evidence.authorityLocks.armApiVersion === '2024-03-01'
    && evidence.authorityLocks.managementHostname === 'management.azure.com'
    && AUTHORITY_LOCKS.applicationName === APPLICATION_NAME);

  const offlineComplete = evidence.liveAttemptCount === 0
    && evidence.outcome === 'phase_d_target_authority_offline_only';
  const liveRecorded = evidence.liveAttemptCount === 1;
  pass('offline-or-live-attempt-count',
    offlineComplete || liveRecorded);

  if (offlineComplete) {
    pass('offline-only-evidence',
      evidence.liveMutation === false
      && evidence.schemaMutation === false
      && evidence.dataMutation === false
      && evidence.ledgerWritten === false
      && evidence.kvMutation === false);
  } else {
    pass('offline-only-evidence-skipped', true);
  }

  const live = evidence.liveTargetAuthorityOutcome;
  if (liveRecorded && live) {
    pass('live-outcome-sameTarget-boolean', typeof live.sameTarget === 'boolean');
    pass('live-outcome-revision-env-secret',
      (live.activeRevisionName == null || typeof live.activeRevisionName === 'string')
      && (live.dbEnvName == null || typeof live.dbEnvName === 'string')
      && (live.secretRefName == null || typeof live.secretRefName === 'string'));
    if (live.driftClassification && live.driftClassification.code) {
      pass('live-drift-code-allowed',
        ALLOWED_DRIFT_CODES.has(live.driftClassification.code));
    } else {
      pass('live-drift-code-allowed-absent-ok', true);
    }
    pass('live-mutation-flags-false',
      live.liveMutation === false
      && live.schemaMutation === false
      && live.dataMutation === false
      && live.ledgerWritten === false
      && live.kvMutation === false);
  } else {
    pass('live-outcome-skipped-offline', true);
  }

  // Offline runtime re-checks (injected only — never live)
  resetTargetAuthorityCounters();
  const def = await executeActiveDbTargetAuthority({ env: {}, argv: [] });
  pass('runtime-default-refuse',
    def.ok === false
    && getTargetAuthorityCounters().clientsInstantiated === 0
    && getTargetAuthorityCounters().httpRequestCount === 0);

  resetTargetAuthorityCounters();
  const okRun = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: exactTargetAuthorityArgv(),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_TOKEN,
      defaultSecretValue: buildOfflineProofSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD),
    }),
    skipPostgres: true,
  });
  pass('runtime-injected-kv-ref-authority',
    okRun.ok === true
    && okRun.sameTarget === true
    && okRun.comparisonMode === 'keyvault_url_ref'
    && okRun.clientsInstantiated === 0
    && getTargetAuthorityCounters().httpRequestCount >= 3);

  const gates = evaluateTargetAuthorityGates({
    env: targetAuthorityEnv(),
    argv: exactTargetAuthorityArgv(),
  });
  pass('runtime-cli-gates', gates.ok === true);

  const FakeSparse = createScriptedTargetAuthorityFakeClientFactory({ publicTables: 2 });
  resetTargetAuthorityCounters();
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const sparseRun = await executeActiveDbTargetAuthority({
    env: targetAuthorityEnv(),
    argv: exactTargetAuthorityArgv(),
    httpRequest: createInjectedTargetAuthorityHttp({
      imdsAccessToken: FAKE_TOKEN,
      defaultSecretValue: buildOfflineProofSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD),
    }),
    ClientFactory: FakeSparse,
    expectedContract: expected,
  });
  pass('runtime-sparse-observer-shape',
    sparseRun.sameTarget === true
    && sparseRun.observerOutcome
    && sparseRun.observerOutcome.counts
    && Object.prototype.hasOwnProperty.call(sparseRun.observerOutcome.counts, 'expected_only')
    && Object.prototype.hasOwnProperty.call(sparseRun.observerOutcome.counts, 'live_only')
    && Object.prototype.hasOwnProperty.call(sparseRun.observerOutcome.counts, 'definition_mismatch'));

  const drift = classifyDrift(
    true,
    { publicTables: 2 },
    { match: false, mismatchCount: 200, counts: { expected_only: 200, live_only: 0, definition_mismatch: 0 } },
  );
  pass('runtime-classify-sparse', drift.code === 'genuinely_sparse_active_runtime_db');
  pass('runtime-classify-wrong-target', classifyDrift(false, null, null).code === 'wrong_target');

  const cliDefault = spawnSync(process.execPath, [cliPath], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  pass('cli-default-refuse', cliDefault.status !== 0);

  const proveOffline = spawnSync(process.execPath, [provePath], {
    encoding: 'utf8',
    env: { ...process.env, SUNSET_SLICE14Q_PROOF_OFFLINE: '1' },
  });
  pass('prove-offline-exit-0', proveOffline.status === 0,
    proveOffline.stderr ? String(proveOffline.stderr).slice(0, 200) : '');

  pass('source-forbids-live-rerun-in-verify',
    !/executeActiveDbTargetAuthority\(\{[^}]*env:\s*process\.env/.test(verifySrc)
    && !/argv:\s*exactTargetAuthorityArgv\(\)/.test(verifySrc.split('spawnSync')[0] || '')
    && /createInjectedTargetAuthorityHttp/.test(verifySrc)
    && /Does NOT re-run live/.test(verifySrc));

  pass('prove-has-live-section',
    /Live section 1\/1/.test(proveSrc)
    && /liveAttemptCount/.test(proveSrc)
    && /executeActiveDbTargetAuthority/.test(proveSrc));

  pass('source-no-ledger-insert',
    !/INSERT\s+INTO\s+.*schema_migration_ledger/i.test(libSrc)
    && !/INSERT\s+INTO\s+.*schema_migration_ledger/i.test(proveSrc)
    && /schema_migration_ledger/.test(libSrc)); // read-only OK

  const armPath = buildLockedArmContainerAppPath();
  const listPath = buildLockedArmListSecretsPath();
  pass('arm-urls-locked',
    /management\.azure\.com/.test(libSrc)
    && /listSecrets/.test(libSrc)
    && /armApiVersion:\s*'2024-03-01'/.test(libSrc)
    && listPath.includes('/listSecrets')
    && listPath.includes('api-version=2024-03-01')
    && armPath.includes('api-version=2024-03-01')
    && armPath.includes(AUTHORITY_LOCKS.containerAppName));

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14q-active-db-target-authority']
      === 'node scripts/prove-sunset-schema-slice14q-active-db-target-authority.js'
    && pkg.scripts['verify:sunset-schema-slice14q']
      === 'node scripts/verify-sunset-schema-slice14q.js'
    && pkg.scripts['phase-d:active-db-target-authority']
      === 'node scripts/run-phase-d-active-db-target-authority.js');

  pass('findings-truthful',
    /Do not claim/i.test(findings)
    && /zero mutation/i.test(findings)
    && /14Q/.test(findings)
    && /wh-sunset-target-authority|target authority/i.test(findings));

  const artifactText = `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`;
  pass('no-secret-tokens-in-artifacts',
    !/slice14q-proof-admin-password|verify-slice14q-admin-password|slice14q-proof-imds-token/i.test(artifactText)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(artifactText)
    && !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(artifactText));

  for (const slice of ['14a', '14b', '14c', '14d', '14e', '14f', '14g', '14h', '14j', '14k', '14m', '14n', '14o', '14p']) {
    const key = `verify:sunset-schema-slice${slice}`;
    pass(`prior-slice-script-${slice}`, typeof pkg.scripts[key] === 'string');
  }

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14q FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14q GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
