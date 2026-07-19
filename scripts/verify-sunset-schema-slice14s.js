'use strict';

/**
 * verify:sunset-schema-slice14s — FOUNDATION Slice 14S RED→GREEN
 * Phase B additive reconcile (offline gates + optional live evidence).
 * Does NOT re-run live authority, firewall prestate, credential-preflight, apply, or observer.
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
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  EXPECTED_028_SHA256,
} = require('./lib/phase-d-check-preflight');
const {
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetManagedIdentityHttpCounters,
  getManagedIdentityHttpCounters,
} = require('./lib/phase-d-managed-identity-credential-loader');
const {
  PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED,
  AUTHORIZED_SEQUENCE,
  APPLY_LOCKS,
  CREATE_TABLE_SQL,
  CREATE_TABLE_SHA256,
  EXPECTED_035_SHA256,
  FORBIDDEN_CREATE_INDEX_SQL,
  FORBIDDEN_INDEX_NAME,
  LOCKED_14R_PHASE_B_TABLES,
  LOCKED_14R_PHASE_B_COLUMNS,
  evaluatePhaseBAdditiveGates,
  executePhaseBAdditiveReconcile,
  createScriptedPhaseBFakeClientFactory,
  buildMatching14RPreflight,
  resetPhaseBAdditiveCounters,
  getPhaseBAdditiveCounters,
  exactPhaseBAdditiveArgv,
  phaseBAdditiveEnv,
  assertCreateTableByteLocked,
  authorizeApplySql,
} = require('./lib/phase-d-phase-b-additive-reconcile');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '691025bd4e92ee6d0ea5a6cd214ea10e92ca7d4e';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': EXPECTED_035_SHA256,
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const REQUIRED_RED = [
  'default_path_zero_http_and_clients',
  'missing_apply_flag_zero_clients',
  'missing_phase_b_env_zero_clients',
  'wrong_exact_targets_zero_clients',
  'forbidden_argv_dsn_sql_drop_dml_retry_zero_clients',
  'managed_identity_requires_env_and_argv',
  'set_drift_from_14r_refuse',
  'unsafe_nonempty_not_null_refuse',
  'incompatible_same_name_object_refuse',
  'extra_sql_rejected',
  'dml_or_drop_rejected',
  'partial_failure_rollback',
  'wrong_order_or_gates',
];

const REQUIRED_GREEN = [
  'injected_http_success_exact_create_table_sequence',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'create_table_byte_locked_to_035',
  'phase_b_set_locked_to_14r',
  'no_separate_index_in_authorized_sql',
];

const FAKE_USER = 'verify-slice14s-admin-user';
const FAKE_PASSWORD = 'verify-slice14s-admin-password';
const FAKE_TOKEN = 'verify-slice14s-imds-token';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14s — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14s-phase-b-additive-reconcile-evidence.json');
  const contractPath = path.join(FIX, 'slice14s-phase-b-additive-reconcile-contract.json');
  const findingsPath = path.join(FIX, 'slice14s-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14s-phase-b-additive-reconcile.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14s.js');
  const applyCliPath = path.join(ROOT, 'scripts', 'run-phase-d-phase-b-additive-reconcile.js');
  const preflightCliPath = path.join(ROOT, 'scripts', 'run-phase-d-credential-preflight.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-phase-b-additive-reconcile.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, verifyPath, applyCliPath, preflightCliPath, libPath]
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
  pass('global-apply-disabled-capability-enabled',
    PHASE_D_LIVE_APPLY_ENABLED === false
    && PHASE_D_PHASE_B_ADDITIVE_LIVE_ENABLED === true
    && PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true);

  pass('evidence-shape',
    evidence.kind === 'sunset-schema-observer-slice14s-phase-b-additive-reconcile-evidence'
    && evidence.secretFree === true
    && evidence.slice === '14S'
    && evidence.dataMutation === false
    && evidence.ledgerWritten === false
    && evidence.createIndex === false
    && evidence.commentOn === false
    && evidence.forwardCountUnchanged === 39);

  pass('contract-shape',
    contract.kind === 'sunset-schema-observer-slice14s-phase-b-additive-reconcile-contract'
    && contract.verifyNeverRerunsLive === true
    && contract.containsLiveApplyCode === true
    && contract.appliesPhaseBAdditive === true
    && contract.writesLedger === false
    && contract.dataMutation === false
    && contract.createIndex === false
    && contract.globalLiveApplyEnabled === false
    && contract.phaseBAdditiveLiveEnabled === true);

  const redNames = (evidence.redCases || []).map((c) => c.name);
  const greenNames = (evidence.greenCases || []).map((c) => c.name);
  pass('red-cases-complete', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('green-cases-complete', REQUIRED_GREEN.every((n) => greenNames.includes(n)));

  pass('master-basis',
    evidence.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER);

  const offlineComplete = evidence.liveApplyAttemptCount === 0
    && evidence.outcome === 'phase_b_additive_reconcile_offline_only';
  const liveRecorded = evidence.liveApplyAttemptCount === 1;
  pass('offline-or-live-attempt-count',
    offlineComplete || liveRecorded);

  if (offlineComplete) {
    pass('offline-only-evidence',
      evidence.phaseBAdditiveApplied === false
      && evidence.liveMutation === false
      && evidence.schemaMutation !== true
      && evidence.stillProductSchemaDiffers === true);
  }

  const apply = evidence.liveApplyOutcome;
  if (liveRecorded && apply && apply.ok === true) {
    pass('live-apply-success-shape',
      apply.steps.includes('CREATE TABLE customer_message_templates')
      && apply.steps.includes('COMMIT')
      && apply.committed === true
      && apply.dataMutation === false
      && apply.ledgerWritten === false
      && apply.indexAbsent === true
      && evidence.schemaMutation === true
      && evidence.phaseBAdditiveApplied === true
      && evidence.liveMutation === true);
  } else if (liveRecorded) {
    pass('live-apply-blocked-recorded',
      apply && apply.ok === false && typeof apply.blocker === 'string');
  } else {
    pass('live-apply-skipped-offline', true);
  }

  const obs = evidence.observerOutcome;
  pass('observer-no-false-full-repair-claim',
    !(evidence.stillProductSchemaDiffers === false && obs && obs.mismatchCountAfter !== 0)
    && !(obs && obs.fullRepairClaimed === true && obs.mismatchCountAfter !== 0));

  // Offline runtime re-checks (injected only — never live)
  resetPhaseBAdditiveCounters();
  resetManagedIdentityHttpCounters();
  const def = await executePhaseBAdditiveReconcile({ env: {}, argv: [] });
  pass('runtime-default-refuse',
    def.ok === false
    && getPhaseBAdditiveCounters().clientsInstantiated === 0
    && getManagedIdentityHttpCounters().httpRequestCount === 0);

  resetPhaseBAdditiveCounters();
  resetManagedIdentityHttpCounters();
  const FakeOk = createScriptedPhaseBFakeClientFactory({});
  const okRun = await executePhaseBAdditiveReconcile({
    env: phaseBAdditiveEnv(),
    argv: exactPhaseBAdditiveArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_TOKEN,
      defaultSecretValue: buildOfflineProofSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD),
    }),
    Client: FakeOk,
    injectedPreflight: buildMatching14RPreflight(),
  });
  pass('runtime-injected-create-table-sequence',
    okRun.ok === true
    && okRun.clientsInstantiated === 1
    && okRun.queryCalls === 14
    && getManagedIdentityHttpCounters().httpRequestCount === 2
    && JSON.stringify(okRun.steps) === JSON.stringify(AUTHORIZED_SEQUENCE)
    && okRun.createTableSha256 === CREATE_TABLE_SHA256);

  const gates = evaluatePhaseBAdditiveGates({
    env: phaseBAdditiveEnv(),
    argv: exactPhaseBAdditiveArgv(),
  });
  pass('runtime-cli-gates', gates.ok === true && gates.applyPhaseBAdditive === true);

  const cliDefault = spawnSync(process.execPath, [applyCliPath], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  pass('apply-cli-default-refuse', cliDefault.status !== 0);

  const createLock = assertCreateTableByteLocked();
  pass('runtime-create-table-byte-locked',
    createLock.createTableSha256 === CREATE_TABLE_SHA256
    && createLock.migration035Sha256CanonicalLfV1 === EXPECTED_035_SHA256
    && APPLY_LOCKS.createTableSha256 === CREATE_TABLE_SHA256);

  pass('apply-locks-application-name',
    APPLY_LOCKS.applicationName === 'wh-sunset-phase-b-additive');

  pass('create-table-sql-no-index-or-comment',
    !CREATE_TABLE_SQL.includes('CREATE INDEX')
    && !CREATE_TABLE_SQL.includes('COMMENT')
    && !CREATE_TABLE_SQL.includes(FORBIDDEN_INDEX_NAME));

  let indexRejected = false;
  try {
    authorizeApplySql(FORBIDDEN_CREATE_INDEX_SQL);
  } catch (e) {
    indexRejected = e.code === 'unauthorized_sql';
  }
  pass('index-sql-not-in-authorized-apply-list', indexRejected === true);

  pass('phase-b-set-locked',
    LOCKED_14R_PHASE_B_TABLES.length === 1
    && LOCKED_14R_PHASE_B_TABLES[0] === 'customer_message_templates'
    && LOCKED_14R_PHASE_B_COLUMNS.length === 9);

  pass('source-forbids-live-rerun-in-verify',
    !/executePhaseBAdditiveReconcile\(\{[^}]*env:\s*process\.env/.test(verifySrc)
    && !/spawnSync\(process\.execPath,\s*\[applyCliPath,\s*\.\.\.exactPhaseBAdditiveArgv/.test(verifySrc)
    && /createInjectedManagedIdentityHttp/.test(verifySrc)
    && /createScriptedPhaseBFakeClientFactory/.test(verifySrc)
    && /Does NOT re-run live/.test(verifySrc)
    && !/argv\.includes\(['"]--live['"]\)/.test(verifySrc));

  pass('prove-has-live-apply-section',
    /Live section 1\/5/.test(proveSrc)
    && /Live section 4\/5/.test(proveSrc)
    && /executeActiveDbTargetAuthority/.test(proveSrc)
    && /liveApplyAttemptCount/.test(proveSrc)
    && /executePhaseBAdditiveReconcile/.test(proveSrc));

  pass('prove-offline-spawn-succeeds', (() => {
    const r = spawnSync(process.execPath, [provePath], {
      encoding: 'utf8',
      env: { ...process.env, SUNSET_SLICE14S_PROOF_OFFLINE: '1' },
    });
    return r.status === 0;
  })());

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14s-phase-b-additive-reconcile']
      === 'node scripts/prove-sunset-schema-slice14s-phase-b-additive-reconcile.js'
    && pkg.scripts['verify:sunset-schema-slice14s']
      === 'node scripts/verify-sunset-schema-slice14s.js'
    && pkg.scripts['phase-d:phase-b-additive-reconcile']
      === 'node scripts/run-phase-d-phase-b-additive-reconcile.js');

  pass('findings-truthful',
    /claim Sunset fully repaired/i.test(findings)
    && /customer_message_templates/.test(findings)
    && /14S/.test(findings));

  pass('no-iac-mutation-claims',
    evidence.networkMutation === false
    && evidence.kvMutation === false
    && evidence.rbacMutation === false
    && contract.firewallMutation === false);

  pass('migrations-unchanged-in-lib',
    !/writeFileSync\(.*035_customer_message_templates/.test(libSrc)
    && !/MIGRATIONS_DIR.*writeFileSync/.test(libSrc));

  const artifactText = `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`;
  pass('no-secret-tokens-in-artifacts',
    !/slice14s-proof-admin-password|verify-slice14s-admin-password|slice14s-proof-imds-token/i.test(artifactText)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(artifactText)
    && !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(artifactText));

  for (const slice of ['14a', '14b', '14c', '14d', '14e', '14f', '14g', '14h', '14j', '14k', '14m', '14n', '14o', '14p', '14q', '14r']) {
    const key = `verify:sunset-schema-slice${slice}`;
    pass(`prior-slice-script-${slice}`, typeof pkg.scripts[key] === 'string');
  }

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14s FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14s GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
