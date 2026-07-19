'use strict';

/**
 * verify:sunset-schema-slice14d — FOUNDATION Slice 14D RED→GREEN
 * Phase D live read-only activation (gated CLI; offline fake Client).
 * Offline gates + evidence. No Azure / live mutation.
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
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_EXECUTE_COUNT_ONLY,
  CLI_EXECUTE_COUNT_ONLY,
  CREDENTIAL_USER_ENV,
  CREDENTIAL_PASSWORD_ENV,
  AUTHORIZED_AGGREGATE_SQL,
  evaluateExecuteCountOnlyGate,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  createInjectedAzureAdapters,
  createInjectedDbAdapters,
  createLiveReadonlyAdapters,
} = require('./lib/phase-d-live-readonly-adapters');
const {
  AUTHORIZED_SEQUENCE,
  executePhaseDLiveReadonlyPgAdapter,
  createScriptedFakePgClientFactory,
  getPgClientInstantiateCount,
  resetPgClientInstantiateCount,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED: PG_FLAG,
} = require('./lib/phase-d-live-readonly-pg-adapter');
const {
  evaluatePhaseDLiveReadonlyCliGates,
  evaluateExactTargetCliArgs,
  renderFailClosedCliCatch,
  ENV_OFFLINE_INJECT_CLI_TOPLEVEL_THROW,
  FORBIDDEN_ARGV_FLAGS,
  REDACTED,
} = require('./lib/phase-d-live-readonly-cli');
const {
  EXPECTED_028_SHA256,
  AUTHORIZED_AGGREGATE_SQL: AGG_14A,
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const MASTER = '6edd63762ea5a28cec764428c176da2118032729';
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
  'default_path_zero_clients',
  'execute_gate_missing_zero_clients',
  'cli_forbidden_dsn_host_query',
  'cli_wrong_exact_target_rejected',
  'cli_default_disabled',
  'connect_failure_sanitized_close',
  'query_failure_rollback_and_close',
  'cli_toplevel_catch_redacts_admin_secrets',
];

const REQUIRED_GREEN = [
  'activated_exact_sequence_count_only',
  'cli_gates_pass_exact_target',
  'normal_result_rendering_secret_safe',
  'boundary_ready_zero_connect',
];

const FAKE_USER = 'verify-slice14d-admin-user';
const FAKE_PASSWORD = 'verify-slice14d-admin-password';

let failed = 0;
function pass(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('verify:sunset-schema-slice14d — RED→GREEN\n');

  const evidencePath = path.join(FIX, 'slice14d-phase-d-readonly-activation-evidence.json');
  const contractPath = path.join(FIX, 'slice14d-phase-d-readonly-activation-contract.json');
  const findingsPath = path.join(FIX, 'slice14d-findings.md');
  const expectedPath = path.join(FIX, 'expected-product-schema.json');
  const provePath = path.join(ROOT, 'scripts', 'prove-sunset-schema-slice14d-phase-d-readonly-activation.js');
  const verifyPath = path.join(ROOT, 'scripts', 'verify-sunset-schema-slice14d.js');
  const cliPath = path.join(ROOT, 'scripts', 'run-phase-d-live-readonly-count-only.js');
  const cliLibPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-live-readonly-cli.js');
  const boundaryPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-live-readonly-boundary.js');
  const adapterPath = path.join(ROOT, 'scripts', 'lib', 'phase-d-live-readonly-pg-adapter.js');

  pass(
    'artifacts-exist',
    [evidencePath, contractPath, findingsPath, expectedPath, provePath, cliPath, cliLibPath]
      .every((p) => fs.existsSync(p)),
  );

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const findings = fs.readFileSync(findingsPath, 'utf8');
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const proveSrc = fs.readFileSync(provePath, 'utf8');
  const verifySrc = fs.readFileSync(verifyPath, 'utf8');
  const cliSrc = fs.readFileSync(cliPath, 'utf8');
  const boundarySrc = fs.readFileSync(boundaryPath, 'utf8');
  const adapterSrc = fs.readFileSync(adapterPath, 'utf8');
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
  pass('product-fingerprint-preserved', expected.productFingerprint === CANON_FP
    && evidence.productFingerprintUnchanged === CANON_FP);
  pass(
    '13c-hashes-preserved',
    live028 === LOCKED_13C_SHA['028']
    && live035 === LOCKED_13C_SHA['035']
    && live040 === LOCKED_13C_SHA['040']
    && live041 === LOCKED_13C_SHA['041'],
  );
  pass('028-predicates-unchanged', assert028PredicatesPresentInSource() === true
    && assertMigration028ByteIntegrity() === EXPECTED_028_SHA256
    && AUTHORIZED_AGGREGATE_SQL === AGG_14A
    && contract.predicatesUnchangedFrom14A.date_window === DATE_WINDOW_PREDICATE
    && contract.predicatesUnchangedFrom14A.price_unit === PRICE_UNIT_PREDICATE);

  pass('connect-activated-apply-disabled',
    PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true
    && PG_FLAG === true
    && PHASE_D_LIVE_APPLY_ENABLED === false
    && /PHASE_D_LIVE_READONLY_CONNECT_ENABLED\s*=\s*true/.test(boundarySrc)
    && ENV_EXECUTE_COUNT_ONLY === 'SUNSET_PHASE_D_LIVE_EXECUTE_COUNT_ONLY'
    && CLI_EXECUTE_COUNT_ONLY === '--execute-count-only'
    && /evaluateExecuteCountOnlyGate/.test(boundarySrc)
    && /evaluateExecuteCountOnlyGate/.test(adapterSrc));

  pass('authorized-sequence-locked',
    JSON.stringify(AUTHORIZED_SEQUENCE) === JSON.stringify([
      'BEGIN READ ONLY',
      'SHOW transaction_read_only',
      'catalog_table',
      'catalog_columns',
      'aggregate',
      'COMMIT',
    ])
    && JSON.stringify(evidence.authorizedSequence) === JSON.stringify(AUTHORIZED_SEQUENCE));

  pass('command-contract',
    contract.commandContract.script === 'scripts/run-phase-d-live-readonly-count-only.js'
    && contract.dualEnableFlagsRequired === true
    && contract.executeCountOnlyGateRequired === true
    && contract.exactTargetCliConfirmationRequired === true
    && contract.defaultEnabled === false
    && FORBIDDEN_ARGV_FLAGS.every((f) => contract.commandContract.forbiddenArgv.includes(f))
    && /no DSN\/host\/query/i.test(cliSrc)
    && cliSrc.includes('Forbidden'));

  const redNames = (evidence.redCases || []).map((c) => c.name);
  const greenNames = (evidence.greenCases || []).map((c) => c.name);
  pass('red-cases-present', REQUIRED_RED.every((n) => redNames.includes(n)));
  pass('green-cases-present', REQUIRED_GREEN.every((n) => greenNames.includes(n)));
  pass('offline-gates',
    evidence.offlineGates.defaultPathZeroClients === true
    && evidence.offlineGates.executeGateMissingZeroClients === true
    && evidence.offlineGates.activatedExactSequenceCountOnly === true
    && evidence.offlineGates.cliDefaultDisabled === true
    && evidence.offlineGates.queryFailureRollbackAndClose === true
    && evidence.offlineGates.cliToplevelCatchRedactsAdminSecrets === true
    && evidence.offlineGates.normalResultRenderingSecretSafe === true
    && evidence.cliExecutedLive === false
    && evidence.liveQueryExecution === false
    && evidence.liveMutation === false
    && evidence.stillProductSchemaDiffers === true);

  // Runtime: default zero
  resetPgClientInstantiateCount();
  const def = await executePhaseDLiveReadonlyPgAdapter({ env: {} });
  pass('runtime-default-zero-clients',
    (def.clientsInstantiated || 0) === 0 && getPgClientInstantiateCount() === 0);

  // Runtime: execute gate missing
  resetPgClientInstantiateCount();
  const noExec = await executePhaseDLiveReadonlyPgAdapter({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [CREDENTIAL_USER_ENV]: FAKE_USER,
      [CREDENTIAL_PASSWORD_ENV]: FAKE_PASSWORD,
    },
    argv: ['node', 'verify'],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
  });
  pass('runtime-execute-gate-missing-zero',
    noExec.code === 'target_accepted_execute_count_only_required'
    && noExec.clientsInstantiated === 0
    && getPgClientInstantiateCount() === 0);

  // Runtime: activated sequence
  resetPgClientInstantiateCount();
  const Fake = createScriptedFakePgClientFactory();
  const ok = await executePhaseDLiveReadonlyPgAdapter({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_EXECUTE_COUNT_ONLY]: '1',
      [CREDENTIAL_USER_ENV]: FAKE_USER,
      [CREDENTIAL_PASSWORD_ENV]: FAKE_PASSWORD,
    },
    argv: [
      'node', 'verify', CLI_EXECUTE_COUNT_ONLY,
      '--subscription', TARGETS.subscriptionId,
      '--resource-group', TARGETS.resourceGroup,
      '--postgres-server', TARGETS.postgresServer,
      '--database', TARGETS.database,
    ],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    Client: Fake,
  });
  const probe = JSON.stringify(ok);
  pass('runtime-activated-sequence',
    ok.ok === true
    && JSON.stringify(ok.steps) === JSON.stringify(AUTHORIZED_SEQUENCE)
    && ok.closed === true
    && ok.clientsInstantiated === 1
    && Fake.instances[0].calls.filter((c) => c.method === 'end').length === 1
    && !probe.includes(FAKE_PASSWORD)
    && !probe.includes(FAKE_USER));

  // CLI gates
  const gatesOk = evaluatePhaseDLiveReadonlyCliGates({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_EXECUTE_COUNT_ONLY]: '1',
      [CREDENTIAL_USER_ENV]: FAKE_USER,
      [CREDENTIAL_PASSWORD_ENV]: FAKE_PASSWORD,
    },
    argv: [
      CLI_EXECUTE_COUNT_ONLY,
      '--subscription', TARGETS.subscriptionId,
      '--resource-group', TARGETS.resourceGroup,
      '--postgres-server', TARGETS.postgresServer,
      '--database', TARGETS.database,
    ],
  });
  pass('runtime-cli-gates-pass', gatesOk.ok === true);

  const gatesDsn = evaluateExactTargetCliArgs([
    CLI_EXECUTE_COUNT_ONLY,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    '--dsn', 'postgresql://x:y@h/db',
  ]);
  pass('runtime-cli-rejects-dsn', gatesDsn.ok === false);

  const execUnit = evaluateExecuteCountOnlyGate({
    env: { [ENV_EXECUTE_COUNT_ONLY]: '1' },
    argv: [CLI_EXECUTE_COUNT_ONLY],
  });
  pass('runtime-execute-gate-unit', execUnit.ok === true);

  const cliDefault = spawnSync(process.execPath, [cliPath], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  pass('runtime-cli-default-refuse', cliDefault.status !== 0);

  // Runtime: outermost catch fail-closed redaction via offline inject child-process
  const injectCli = spawnSync(process.execPath, [cliPath], {
    env: {
      PATH: process.env.PATH,
      [CREDENTIAL_USER_ENV]: FAKE_USER,
      [CREDENTIAL_PASSWORD_ENV]: FAKE_PASSWORD,
      [ENV_OFFLINE_INJECT_CLI_TOPLEVEL_THROW]: '1',
    },
    encoding: 'utf8',
  });
  const injectText = `${injectCli.stdout || ''}${injectCli.stderr || ''}`;
  let injectPayload = null;
  try {
    injectPayload = JSON.parse((injectCli.stderr || '').trim());
  } catch (_e) {
    injectPayload = null;
  }
  pass('runtime-cli-toplevel-catch-redacts',
    injectCli.status !== 0
    && injectPayload
    && injectPayload.ok === false
    && injectPayload.code === 'cli_failed'
    && injectPayload.liveMutation === false
    && !injectText.includes(FAKE_USER)
    && !injectText.includes(FAKE_PASSWORD)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(injectText)
    && String(injectPayload.message || '').includes(REDACTED));

  const unitCatch = renderFailClosedCliCatch(
    Object.assign(new Error(`boom ${FAKE_USER} ${FAKE_PASSWORD}`), {
      meta: { password: FAKE_PASSWORD, user: FAKE_USER },
    }),
    {
      env: {
        [CREDENTIAL_USER_ENV]: FAKE_USER,
        [CREDENTIAL_PASSWORD_ENV]: FAKE_PASSWORD,
      },
      clientsInstantiated: 0,
    },
  );
  const unitText = JSON.stringify(unitCatch);
  pass('runtime-fail-closed-catch-unit',
    unitCatch.code === 'cli_failed'
    && !unitText.includes(FAKE_USER)
    && !unitText.includes(FAKE_PASSWORD));

  pass('cli-source-fail-closed-catch',
    cliSrc.includes('renderFailClosedCliCatch')
    && cliSrc.includes('collectProtectedAdminSecrets')
    && cliSrc.includes('maybeThrowOfflineInjectedTopLevelError')
    && !/const msg = String\(\(err && err\.message\)/.test(cliSrc));

  let liveFactoryDisabled = false;
  try {
    createLiveReadonlyAdapters();
  } catch (e) {
    liveFactoryDisabled = e && e.code === 'live_readonly_connect_disabled';
  }
  pass('live-adapter-factory-refused', liveFactoryDisabled);

  pass('source-forbids-mutation',
    !/\baz\s+postgres\b/i.test(proveSrc)
    && !/\baz\s+network\b/i.test(proveSrc)
    && !/--apply\b/.test(adapterSrc)
    && !/ADD\s+CONSTRAINT\s+tenant_services_date_window/i.test(adapterSrc)
    && !/schema_migration_ledger/.test(adapterSrc)
    && !/load-sunset-staging-pg-admin-env/.test(cliSrc)
    && evidence.stillProductSchemaDiffers === true);

  pass('npm-commands',
    pkg.scripts['prove:sunset-schema-slice14d-phase-d-readonly-activation']
      === 'node scripts/prove-sunset-schema-slice14d-phase-d-readonly-activation.js'
    && pkg.scripts['verify:sunset-schema-slice14d']
      === 'node scripts/verify-sunset-schema-slice14d.js'
    && pkg.scripts['phase-d:live-readonly-count-only']
      === 'node scripts/run-phase-d-live-readonly-count-only.js');

  pass('findings-non-claim',
    /Do not claim/i.test(findings)
    && /Zero live\/Azure mutation/i.test(findings)
    && /execute-count-only/i.test(findings)
    && !/Sunset is repaired/i.test(findings.replace(/Do not claim[\s\S]*?repaired/i, '')));

  const artifactText = `${JSON.stringify(evidence)}${JSON.stringify(contract)}${findings}`;
  pass('no-secret-tokens-in-artifacts',
    !/slice14d-proof-admin-password|verify-slice14d-admin-password/i.test(artifactText)
    && !/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(artifactText));

  pass('master-basis',
    evidence.masterShaBasis === MASTER
    && contract.masterShaBasis === MASTER);

  pass('verify-is-offline-only',
    !/require\(['"]\.\/lib\/disposable-postgres-harness['"]\)/.test(verifySrc)
    && !/require\(['"]pg['"]\)/.test(verifySrc)
    && !/require\(['"].*load-sunset-staging-pg-admin-env['"]\)/.test(verifySrc));

  if (failed > 0) {
    console.log(`\nverify:sunset-schema-slice14d FAILED (${failed})`);
    process.exit(1);
  }
  console.log('\nverify:sunset-schema-slice14d GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
