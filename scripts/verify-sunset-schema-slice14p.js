'use strict';

/**
 * verify:sunset-schema-slice14p — FOUNDATION Slice 14P RED→GREEN
 * Apply Phase D CHECK constraints (offline gates + optional live evidence).
 * Does NOT re-run live firewall prestate, credential-preflight, apply, or observer.
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
  AUTHORIZED_AGGREGATE_SQL,
  ENV_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  EXPECTED_028_SHA256,
  AUTHORIZED_AGGREGATE_SQL: AGG_14A,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');
const {
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  resetManagedIdentityHttpCounters,
  getManagedIdentityHttpCounters,
} = require('./lib/phase-d-managed-identity-credential-loader');
const {
  PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED,
  AUTHORIZED_SEQUENCE,
  APPLY_LOCKS,
  CONSTRAINT_DATE_WINDOW,
  CONSTRAINT_PRICE_UNIT,
  evaluateConstraintApplyGates,
  executePhaseDConstraintApply,
  createScriptedConstraintApplyFakeClientFactory,
  resetConstraintApplyCounters,
  getConstraintApplyCounters,
  exactConstraintApplyArgv,
  constraintApplyEnv,
  assertAlterStatementsByteLocked,
} = require('./lib/phase-d-constraint-apply');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '51afd90f84a9100afb95c777ce92d27fff164f2c';
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
  'missing_apply_flag_zero_clients',
  'missing_constraint_apply_env_zero_clients',
  'wrong_exact_targets_zero_clients',
  'forbidden_argv_dsn_sql_drop_dml_retry_zero_clients',
  'managed_identity_requires_env_and_argv',
  'nonzero_counts_refuse_rollback',
  'preexisting_constraint_refuse_rollback',
  'wrong_extra_sql_rejected',
  'lock_failure_rollback',
];

const REQUIRED_GREEN = [
  'injected_http_success_exact_constraint_sequence',
  'cli_gates_exact_targets',
  'cli_default_disabled',
  'locks_identity_vault_secret_pg_tls_application_name',
  'global_live_apply_remains_false',
  'alter_statements_byte_locked',
];

const FAKE_USER = 'verify-slice14p-admin-user';
const FAKE_PASSWORD = 'verify-slice14p-admin-password';
const FAKE_TOKEN = 'verify-slice14p-imds-token';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14p — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14p-apply-phase-d-constraints-evidence.json');
  const contractPath = path.join(FIX, 'slice14p-apply-phase-d-constraints-contract.json');
  const findingsPath = path.join(FIX, 'slice14p-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14p-apply-phase-d-constraints.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14p.js');
  const applyCliPath = path.join(ROOT, 'scripts', 'run-phase-d-constraint-apply.js');
  const preflightCliPath = path.join(ROOT, 'scripts', 'run-phase-d-credential-preflight.js');
  const libPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-constraint-apply.js');

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
  pass('14a-aggregate-unchanged', AUTHORIZED_AGGREGATE_SQL === AGG_14A);
  pass('global-apply-disabled-capability-enabled',
    PHASE_D_LIVE_APPLY_ENABLED === false
    && PHASE_D_CONSTRAINT_APPLY_LIVE_ENABLED === true
    && PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true);

  pass('evidence-shape',
    evidence.kind === 'sunset-schema-observer-slice14p-apply-phase-d-constraints-evidence'
    && evidence.secretFree === true
    && evidence.slice === '14P'
    && evidence.dataMutation === false
    && evidence.ledgerWritten === false
    && evidence.forwardCountUnchanged === 39);

  pass('contract-shape',
    contract.kind === 'sunset-schema-observer-slice14p-apply-phase-d-constraints-contract'
    && contract.verifyNeverRerunsLive === true
    && contract.containsLiveApplyCode === true
    && contract.appliesConstraints === true
    && contract.writesLedger === false
    && contract.dataMutation === false
    && contract.globalLiveApplyEnabled === false
    && contract.constraintApplyLiveEnabled === true);

  const redNames = (evidence.redCases || []).map((c) => c.name);
  const greenNames = (evidence.greenCases || []).map((c) => c.name);
  pass('red-cases-complete', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('green-cases-complete', REQUIRED_GREEN.every((n) => greenNames.includes(n)));

  pass('master-basis',
    evidence.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER);

  const offlineComplete = evidence.liveApplyAttemptCount === 0
    && evidence.outcome === 'phase_d_constraint_apply_offline_only';
  const liveRecorded = evidence.liveApplyAttemptCount === 1;
  pass('offline-or-live-attempt-count',
    offlineComplete || liveRecorded);

  if (offlineComplete) {
    pass('offline-only-evidence',
      evidence.phaseDConstraintsApplied === false
      && evidence.liveMutation === false
      && evidence.schemaMutation !== true
      && evidence.stillProductSchemaDiffers === true);
  }

  const apply = evidence.liveApplyOutcome;
  if (liveRecorded && apply && apply.ok === true) {
    pass('live-apply-success-shape',
      Array.isArray(apply.beforeConstraints) && apply.beforeConstraints.length === 0
      && Array.isArray(apply.afterConstraints) && apply.afterConstraints.length === 2
      && apply.afterConstraints.every((c) => c.name === CONSTRAINT_DATE_WINDOW
        || c.name === CONSTRAINT_PRICE_UNIT)
      && apply.counts
      && apply.counts.total_rows === 0
      && apply.counts.date_window_violations === 0
      && apply.counts.price_unit_violations === 0
      && apply.steps.includes('ADD CONSTRAINT tenant_services_date_window')
      && apply.steps.includes('ADD CONSTRAINT tenant_services_price_unit')
      && apply.steps.includes('COMMIT')
      && apply.committed === true
      && apply.dataMutation === false
      && apply.ledgerWritten === false
      && evidence.schemaMutation === true
      && evidence.phaseDConstraintsApplied === true
      && evidence.liveMutation === true
      && evidence.applyFlagPresent === true);
  } else if (liveRecorded) {
    pass('live-apply-blocked-recorded',
      apply && apply.ok === false && typeof apply.blocker === 'string');
  } else {
    pass('live-apply-skipped-offline', true);
  }

  const obs = evidence.observerOutcome;
  if (obs && obs.mismatchReduced2to0 === true) {
    pass('observer-mismatch-reduced-2-to-0',
      obs.observed === true
      && obs.mismatchCountAfter === 0
      && obs.match === true
      && evidence.stillProductSchemaDiffers === false);
  } else {
    pass('observer-no-false-repair-claim',
      !(evidence.stillProductSchemaDiffers === false
        && obs
        && obs.mismatchReduced2to0 !== true));
  }
  if (liveRecorded && apply && apply.ok === true && obs && obs.observed === true) {
    pass('observer-phase-d-check-keys-cleared',
      obs.phaseDCheckKeysCleared === true
      && obs.mismatchReduced2to0 === false
      && evidence.stillProductSchemaDiffers === true
      && Number(obs.mismatchCountAfter) > 0);
  } else {
    pass('observer-phase-d-check-keys-cleared-skipped', true);
  }

  // Offline runtime re-checks (injected only — never live)
  resetConstraintApplyCounters();
  resetManagedIdentityHttpCounters();
  const def = await executePhaseDConstraintApply({ env: {}, argv: [] });
  pass('runtime-default-refuse',
    def.ok === false
    && getConstraintApplyCounters().clientsInstantiated === 0
    && getManagedIdentityHttpCounters().httpRequestCount === 0);

  resetConstraintApplyCounters();
  resetManagedIdentityHttpCounters();
  const FakeOk = createScriptedConstraintApplyFakeClientFactory({});
  const okRun = await executePhaseDConstraintApply({
    env: constraintApplyEnv(),
    argv: exactConstraintApplyArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_TOKEN,
      defaultSecretValue: buildOfflineProofSunsetDatabaseUrl(FAKE_USER, FAKE_PASSWORD),
    }),
    Client: FakeOk,
  });
  pass('runtime-injected-constraint-sequence',
    okRun.ok === true
    && okRun.afterConstraints.length === 2
    && okRun.clientsInstantiated === 1
    && okRun.queryCalls === 12
    && getManagedIdentityHttpCounters().httpRequestCount === 2
    && JSON.stringify(okRun.steps) === JSON.stringify(AUTHORIZED_SEQUENCE));

  const gates = evaluateConstraintApplyGates({
    env: constraintApplyEnv(),
    argv: exactConstraintApplyArgv(),
  });
  pass('runtime-cli-gates', gates.ok === true && gates.applyConstraints === true);

  const cliDefault = spawnSync(process.execPath, [applyCliPath], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  pass('apply-cli-default-refuse', cliDefault.status !== 0);

  const alterLock = assertAlterStatementsByteLocked();
  pass('runtime-alter-byte-locked',
    alterLock.alterDateWindowSha256 === APPLY_LOCKS.alterDateWindowSha256
    && alterLock.alterPriceUnitSha256 === APPLY_LOCKS.alterPriceUnitSha256);

  pass('apply-locks-application-name',
    APPLY_LOCKS.applicationName === 'wh-sunset-phase-d-constraint-apply');

  pass('source-forbids-live-rerun-in-verify',
    !/executePhaseDConstraintApply\(\{[^}]*env:\s*process\.env/.test(verifySrc)
    && !/spawnSync\(process\.execPath,\s*\[applyCliPath,\s*\.\.\.exactConstraintApplyArgv/.test(verifySrc)
    && /createInjectedManagedIdentityHttp/.test(verifySrc)
    && /createScriptedConstraintApplyFakeClientFactory/.test(verifySrc)
    && /Does NOT re-run live/.test(verifySrc));

  pass('prove-has-live-apply-section',
    /Live section 3\/4/.test(proveSrc)
    && /Live section 4\/4/.test(proveSrc)
    && /liveApplyAttemptCount/.test(proveSrc)
    && /executePhaseDConstraintApply/.test(proveSrc));

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14p-apply-phase-d-constraints']
      === 'node scripts/prove-sunset-schema-slice14p-apply-phase-d-constraints.js'
    && pkg.scripts['verify:sunset-schema-slice14p']
      === 'node scripts/verify-sunset-schema-slice14p.js'
    && pkg.scripts['phase-d:constraint-apply']
      === 'node scripts/run-phase-d-constraint-apply.js');

  pass('findings-truthful',
    /Do not claim Sunset repaired/i.test(findings)
    && /ADD CONSTRAINT/i.test(findings)
    && /tenant_services_date_window|tenant_services_price_unit/.test(findings));

  const artifactText = `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`;
  pass('no-secret-tokens-in-artifacts',
    !/slice14p-proof-admin-password|verify-slice14p-admin-password|slice14p-proof-imds-token/i.test(artifactText)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(artifactText)
    && !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(artifactText));

  for (const slice of ['14a', '14b', '14c', '14d', '14e', '14f', '14g', '14h', '14j', '14k', '14m', '14n', '14o']) {
    const key = `verify:sunset-schema-slice${slice}`;
    pass(`prior-slice-script-${slice}`, typeof pkg.scripts[key] === 'string');
  }

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14p FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14p GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
