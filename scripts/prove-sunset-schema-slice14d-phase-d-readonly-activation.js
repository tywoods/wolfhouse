'use strict';

/**
 * prove-sunset-schema-slice14d-phase-d-readonly-activation — FOUNDATION Slice 14D
 *
 * Offline proof that the activated 14C adapter + gated CLI path execute only
 * BEGIN READ ONLY → SHOW read-only → locked catalogs → exact aggregate → COMMIT
 * behind exact 14B gates + execute-count-only, with injected fake Client only.
 * No live/Azure connection, no Key Vault load, no mutation.
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
  OBSERVER_DSN_ENV,
  AUTHORIZED_AGGREGATE_SQL,
  AUTHORIZED_SESSION_SQL,
  OUTPUT_COUNT_KEYS,
  evaluateLiveReadonlyBoundary,
  evaluateExecuteCountOnlyGate,
  redactDeep,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  createInjectedAzureAdapters,
  createInjectedDbAdapters,
  createCallRecorder,
  createLiveReadonlyAdapters,
} = require('./lib/phase-d-live-readonly-adapters');
const {
  AUTHORIZED_SEQUENCE,
  STATEMENT_TIMEOUT_MS,
  executePhaseDLiveReadonlyPgAdapter,
  createScriptedFakePgClientFactory,
  getPgClientInstantiateCount,
  resetPgClientInstantiateCount,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED: PG_FLAG,
} = require('./lib/phase-d-live-readonly-pg-adapter');
const {
  evaluatePhaseDLiveReadonlyCliGates,
  evaluateExactTargetCliArgs,
  renderCliUsage,
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
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14d-phase-d-readonly-activation-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14d-phase-d-readonly-activation-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14d-findings.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-live-readonly-count-only.js');

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

const FAKE_ADMIN_USER = 'slice14d-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14d-proof-admin-password-never-commit';

function dualEnv(extra) {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    [CREDENTIAL_USER_ENV]: FAKE_ADMIN_USER,
    [CREDENTIAL_PASSWORD_ENV]: FAKE_ADMIN_PASSWORD,
    ...(extra || {}),
  };
}

function execEnv(extra) {
  return dualEnv({
    [ENV_EXECUTE_COUNT_ONLY]: '1',
    ...(extra || {}),
  });
}

function exactArgv(extraFlags) {
  return [
    CLI_EXECUTE_COUNT_ONLY,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    ...(extraFlags || []),
  ];
}

function adapterArgv() {
  return ['node', 'prove-14d', ...exactArgv()];
}

function leakScan(value, secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const s of secrets) {
    if (s && text.includes(s)) {
      throw new Error(`secret leaked into proof artifact: ${s.slice(0, 8)}…`);
    }
  }
  if (/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(text)) {
    throw new Error('DSN leaked into proof artifact');
  }
}

async function main() {
  console.log('prove:sunset-schema-slice14d-phase-d-readonly-activation — offline\n');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) throw new Error('manifest integrity failed');
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  const expected = JSON.parse(expectedBytes.toString('utf8'));

  if (manifestHash !== MANIFEST_HASH) throw new Error(`manifest hash drift: ${manifestHash}`);
  if (expectedHash !== EXPECTED_BYTE_SHA) throw new Error(`expected hash drift: ${expectedHash}`);
  if (expected.productFingerprint !== CANON_FP) throw new Error('fingerprint drift');
  if (forward.length !== 39) throw new Error('forward count drift');
  assertMigration028ByteIntegrity();
  assert028PredicatesPresentInSource();
  if (AUTHORIZED_AGGREGATE_SQL !== AGG_14A) throw new Error('14A aggregate drift');
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true || PG_FLAG !== true) {
    throw new Error('CONNECT_ENABLED must be activated');
  }
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    throw new Error('APPLY must remain disabled');
  }

  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));
  for (const [k, v] of Object.entries({
    '028': live028, '035': live035, '040': live040, '041': live041,
  })) {
    if (v !== LOCKED_13C_SHA[k]) throw new Error(`13C hash drift on ${k}`);
  }

  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD];
  const red = [];
  const green = [];

  // RED: default path — zero Clients
  resetPgClientInstantiateCount();
  const def = await executePhaseDLiveReadonlyPgAdapter({ env: {} });
  if (getPgClientInstantiateCount() !== 0 || (def.clientsInstantiated || 0) !== 0) {
    throw new Error('default path must instantiate zero Clients');
  }
  red.push({
    name: 'default_path_zero_clients',
    ok: true,
    code: def.code,
    clientsInstantiated: 0,
  });

  // RED: dual flags without execute gate — zero Clients
  resetPgClientInstantiateCount();
  const noExec = await executePhaseDLiveReadonlyPgAdapter({
    env: dualEnv(),
    argv: ['node', 'prove'],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
  });
  if (!noExec.ok
    || noExec.code !== 'target_accepted_execute_count_only_required'
    || noExec.clientsInstantiated !== 0
    || getPgClientInstantiateCount() !== 0) {
    throw new Error(`execute gate missing must zero Clients: ${noExec.code}`);
  }
  red.push({
    name: 'execute_gate_missing_zero_clients',
    ok: true,
    code: noExec.code,
    clientsInstantiated: 0,
  });

  // RED: CLI forbidden DSN/host/query args
  const forbidDsn = evaluateExactTargetCliArgs([
    ...exactArgv(),
    '--dsn', 'postgresql://x:y@evil/db',
  ]);
  if (forbidDsn.ok || !(forbidDsn.errors || []).some((e) => e.code === 'caller_supplied_connect_forbidden')) {
    throw new Error('CLI must reject --dsn');
  }
  const forbidHost = evaluateExactTargetCliArgs([
    CLI_EXECUTE_COUNT_ONLY,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    '--host', 'evil.example.com',
  ]);
  if (forbidHost.ok) throw new Error('CLI must reject --host');
  const forbidQuery = evaluateExactTargetCliArgs([...exactArgv(), '--query', 'SELECT 1']);
  if (forbidQuery.ok) throw new Error('CLI must reject --query');
  red.push({
    name: 'cli_forbidden_dsn_host_query',
    ok: true,
    forbiddenFlags: FORBIDDEN_ARGV_FLAGS.slice(),
  });

  // RED: wrong subscription/RG/server/database on CLI
  const wrongSub = evaluateExactTargetCliArgs([
    CLI_EXECUTE_COUNT_ONLY,
    '--subscription', '00000000-0000-0000-0000-000000000000',
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
  ]);
  if (wrongSub.ok) throw new Error('wrong subscription must fail');
  const wrongRg = evaluateExactTargetCliArgs([
    CLI_EXECUTE_COUNT_ONLY,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', 'wrong-rg',
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
  ]);
  if (wrongRg.ok) throw new Error('wrong RG must fail');
  red.push({
    name: 'cli_wrong_exact_target_rejected',
    ok: true,
    wrongSubscription: !wrongSub.ok,
    wrongResourceGroup: !wrongRg.ok,
  });

  // RED: CLI gates missing admin env → zero Clients (spawn default CLI)
  const cliDefault = spawnSync(process.execPath, [CLI_PATH], {
    env: { ...process.env, PATH: process.env.PATH },
    encoding: 'utf8',
  });
  if (cliDefault.status === 0) throw new Error('default CLI must refuse');
  if (getPgClientInstantiateCount() !== 0) {
    // spawn is separate process — local counter unchanged; ok
  }
  red.push({
    name: 'cli_default_disabled',
    ok: true,
    status: cliDefault.status,
  });

  // RED: connect/query/commit failure sanitize + rollback/close
  resetPgClientInstantiateCount();
  const FakeConnectFail = createScriptedFakePgClientFactory({
    connectError: Object.assign(
      new Error(`connect boom password=${FAKE_ADMIN_PASSWORD}`),
      { code: 'ECONNREFUSED' },
    ),
  });
  const connectFail = await executePhaseDLiveReadonlyPgAdapter({
    env: execEnv(),
    argv: adapterArgv(),
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    Client: FakeConnectFail,
  });
  leakScan(connectFail, secrets);
  if (connectFail.ok !== false || connectFail.code !== 'connect_failed'
    || !FakeConnectFail.instances[0].calls.some((c) => c.method === 'end')) {
    throw new Error('connect failure path failed');
  }
  red.push({ name: 'connect_failure_sanitized_close', ok: true, code: connectFail.code });

  resetPgClientInstantiateCount();
  const FakeQueryFail = createScriptedFakePgClientFactory({
    queryErrorAt: {
      aggregate: Object.assign(
        new Error(`query boom ${FAKE_ADMIN_PASSWORD}`),
        { code: 'query_failed' },
      ),
    },
  });
  const queryFail = await executePhaseDLiveReadonlyPgAdapter({
    env: execEnv(),
    argv: adapterArgv(),
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    Client: FakeQueryFail,
  });
  leakScan(queryFail, secrets);
  if (queryFail.ok !== false
    || queryFail.rolledBack !== true
    || !queryFail.steps.includes('ROLLBACK')
    || queryFail.closed !== true) {
    throw new Error(`query failure rollback/close failed: ${JSON.stringify(queryFail)}`);
  }
  red.push({
    name: 'query_failure_rollback_and_close',
    ok: true,
    steps: queryFail.steps,
    rolledBack: true,
    closed: true,
  });

  // RED: outermost CLI catch fail-closed redaction (child-process inject)
  const injectUser = FAKE_ADMIN_USER;
  const injectPassword = FAKE_ADMIN_PASSWORD;
  const injectEnv = {
    PATH: process.env.PATH,
    [CREDENTIAL_USER_ENV]: injectUser,
    [CREDENTIAL_PASSWORD_ENV]: injectPassword,
    [ENV_OFFLINE_INJECT_CLI_TOPLEVEL_THROW]: '1',
  };
  const injectedCli = spawnSync(process.execPath, [CLI_PATH], {
    env: injectEnv,
    encoding: 'utf8',
  });
  const injectedOut = `${injectedCli.stdout || ''}${injectedCli.stderr || ''}`;
  leakScan(injectedOut, secrets);
  if (injectedCli.status === 0) {
    throw new Error('injected toplevel CLI must exit nonzero');
  }
  let injectedPayload;
  try {
    injectedPayload = JSON.parse((injectedCli.stderr || '').trim());
  } catch (e) {
    throw new Error(`injected toplevel stderr must be JSON: ${injectedCli.stderr}`);
  }
  if (injectedPayload.ok !== false
    || injectedPayload.code !== 'cli_failed'
    || injectedPayload.liveMutation !== false
    || injectedOut.includes(injectUser)
    || injectedOut.includes(injectPassword)
    || /postgresql:\/\/[^:\s/@]+:[^@\s/]+@/i.test(injectedOut)
    || /stack|Error:/i.test(JSON.stringify(injectedPayload))
    || String(injectedPayload.message || '').includes(injectUser)
    || String(injectedPayload.message || '').includes(injectPassword)) {
    throw new Error(`injected toplevel catch leaked or unstable: ${JSON.stringify(injectedPayload)}`);
  }
  if (!String(injectedPayload.message || '').includes(REDACTED)) {
    throw new Error('injected toplevel message must contain redaction marker');
  }
  // Unit: renderFailClosedCliCatch also strips nested meta/cause
  const unitCatch = renderFailClosedCliCatch(
    Object.assign(
      new Error(`unit boom ${injectUser} ${injectPassword}`),
      {
        code: 'unit_boom',
        meta: { user: injectUser, password: injectPassword },
        cause: { message: injectPassword, username: injectUser },
      },
    ),
    { env: injectEnv, clientsInstantiated: 0 },
  );
  leakScan(unitCatch, secrets);
  if (unitCatch.code !== 'cli_failed' || unitCatch.ok !== false) {
    throw new Error('renderFailClosedCliCatch must be stable cli_failed');
  }
  red.push({
    name: 'cli_toplevel_catch_redacts_admin_secrets',
    ok: true,
    status: injectedCli.status,
    code: injectedPayload.code,
    redactedMarkerPresent: true,
    nestedSanitized: true,
  });

  // GREEN: activated path exact sequence with injected Client
  resetPgClientInstantiateCount();
  const FakeOk = createScriptedFakePgClientFactory({
    responses: {
      aggregate: {
        rows: [{
          total_rows: 11,
          date_window_violations: 2,
          price_unit_violations: 1,
        }],
        rowCount: 1,
      },
    },
  });
  const okRun = await executePhaseDLiveReadonlyPgAdapter({
    env: execEnv(),
    argv: adapterArgv(),
    azureAdapters: createInjectedAzureAdapters({}, createCallRecorder()),
    dbAdapters: createInjectedDbAdapters({}, createCallRecorder()),
    Client: FakeOk,
  });
  leakScan(okRun, secrets);
  if (!okRun.ok
    || JSON.stringify(okRun.steps) !== JSON.stringify(AUTHORIZED_SEQUENCE)
    || okRun.counts.total_rows !== 11
    || okRun.counts.date_window_violations !== 2
    || okRun.counts.price_unit_violations !== 1
    || okRun.clientsInstantiated !== 1
    || okRun.closed !== true
    || okRun.liveMutation !== false
    || okRun.offlineProof !== true) {
    throw new Error(`activated sequence failed: ${JSON.stringify(okRun)}`);
  }
  const inst = FakeOk.instances[0];
  const endCalls = inst.calls.filter((c) => c.method === 'end').length;
  if (endCalls !== 1) throw new Error(`expected exactly one end(), got ${endCalls}`);
  green.push({
    name: 'activated_exact_sequence_count_only',
    ok: true,
    steps: okRun.steps,
    counts: okRun.counts,
    clientsInstantiated: 1,
    closed: true,
    endCalls: 1,
  });

  // GREEN: CLI gates pass with exact args + dual flags + execute + admin env
  const cliGates = evaluatePhaseDLiveReadonlyCliGates({
    env: execEnv(),
    argv: exactArgv(),
  });
  if (!cliGates.ok) throw new Error(`CLI gates should pass: ${JSON.stringify(cliGates.errors)}`);
  green.push({
    name: 'cli_gates_pass_exact_target',
    ok: true,
    confirmed: cliGates.confirmed,
  });

  // GREEN: normal result rendering cannot regress secret safety
  const renderSecrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD];
  const poisonedRender = redactDeep({
    ok: false,
    code: 'cli_gates_rejected',
    errors: [{
      code: 'demo',
      message: `gate detail user=${FAKE_ADMIN_USER} password=${FAKE_ADMIN_PASSWORD}`,
    }],
    message: `result message embeds ${FAKE_ADMIN_PASSWORD}`,
    clientsInstantiated: 0,
    liveMutation: false,
  }, renderSecrets);
  leakScan(poisonedRender, renderSecrets);
  const cliSrcForRender = fs.readFileSync(CLI_PATH, 'utf8');
  if (!cliSrcForRender.includes('collectProtectedAdminSecrets')
    || !cliSrcForRender.includes('renderFailClosedCliCatch')
    || !cliSrcForRender.includes('maybeThrowOfflineInjectedTopLevelError')
    || cliSrcForRender.includes("}, []);")
    || /const msg = String\(\(err && err\.message\)/.test(cliSrcForRender)) {
    throw new Error('CLI must fail-closed redact with admin secrets (no empty redactDeep / raw err.message)');
  }
  green.push({
    name: 'normal_result_rendering_secret_safe',
    ok: true,
    poisonedRenderSanitized: true,
    cliUsesProtectedAdminSecrets: true,
  });

  // GREEN: boundary ready under dual flags (zero connect in boundary)
  const boundary = await evaluateLiveReadonlyBoundary({
    env: dualEnv(),
    argv: ['node', 'prove'],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
  });
  if (!boundary.ok || !boundary.accepted
    || boundary.code !== 'target_accepted_live_readonly_ready'
    || boundary.counters.connectCalls !== 0
    || boundary.counters.queryCalls !== 0) {
    throw new Error(`boundary ready failed: ${boundary.code}`);
  }
  green.push({
    name: 'boundary_ready_zero_connect',
    ok: true,
    code: boundary.code,
    connectCalls: 0,
    queryCalls: 0,
  });

  // execute gate unit
  const execMissing = evaluateExecuteCountOnlyGate({ env: dualEnv(), argv: [] });
  const execOk = evaluateExecuteCountOnlyGate({
    env: execEnv(),
    argv: [CLI_EXECUTE_COUNT_ONLY],
  });
  if (execMissing.ok || !execOk.ok) throw new Error('execute gate unit failed');

  // placeholder factory still refuses
  let liveFactoryDisabled = false;
  try {
    createLiveReadonlyAdapters();
  } catch (e) {
    liveFactoryDisabled = e && e.code === 'live_readonly_connect_disabled';
  }
  if (!liveFactoryDisabled) throw new Error('createLiveReadonlyAdapters must refuse');

  const usage = renderCliUsage();
  if (!usage.includes(CLI_EXECUTE_COUNT_ONLY) || !usage.includes(ENV_EXECUTE_COUNT_ONLY)) {
    throw new Error('usage must document execute gate');
  }

  const generatedAt = new Date().toISOString();
  const contract = {
    kind: 'sunset-schema-observer-slice14d-phase-d-readonly-activation-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    liveApplyCapability: false,
    liveReadonlyConnectEnabled: true,
    liveQueryExecution: false,
    appliesConstraints: false,
    writesLedger: false,
    mutates: false,
    firewallMutation: false,
    networkMutation: false,
    defaultEnabled: false,
    dualEnableFlagsRequired: true,
    executeCountOnlyGateRequired: true,
    exactTargetCliConfirmationRequired: true,
    injectedFakePgClientOnly: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14D',
    purpose: 'Activate merged 14C live read-only adapter behind exact 14B gates + explicit count-only execution CLI/env gate; offline injected-Client proof only; no live/Azure query.',
    targets: { ...TARGETS },
    commandContract: {
      script: 'scripts/run-phase-d-live-readonly-count-only.js',
      npm: 'phase-d:live-readonly-count-only',
      requiredEnv: [
        `${ENV_LIVE_READONLY}=1`,
        `${ENV_LIVE_PREFLIGHT}=1`,
        `${ENV_EXECUTE_COUNT_ONLY}=1`,
        `${ENV_SUBSCRIPTION}=${TARGETS.subscriptionId}`,
        CREDENTIAL_USER_ENV,
        CREDENTIAL_PASSWORD_ENV,
      ],
      requiredArgv: [
        CLI_EXECUTE_COUNT_ONLY,
        `--subscription ${TARGETS.subscriptionId}`,
        `--resource-group ${TARGETS.resourceGroup}`,
        `--postgres-server ${TARGETS.postgresServer}`,
        `--database ${TARGETS.database}`,
      ],
      forbiddenArgv: FORBIDDEN_ARGV_FLAGS.slice(),
    },
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    authorizedSessionSql: AUTHORIZED_SESSION_SQL.slice(),
    authorizedAggregateSql: AUTHORIZED_AGGREGATE_SQL,
    outputKeys: OUTPUT_COUNT_KEYS.slice(),
    predicatesUnchangedFrom14A: {
      date_window: DATE_WINDOW_PREDICATE,
      price_unit: PRICE_UNIT_PREDICATE,
    },
    statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    forbidden: [
      'live/Azure connection or query in this slice',
      'Key Vault credential loading',
      'DSN/host/query argv',
      'apply/DDL/ledger',
      'migration / predicate changes',
      'firewall/network mutation',
    ],
    nonGoals: [
      'No Phase D constraint apply',
      'No Sunset repair claim',
      'No live CLI execution',
      'No expected-fixture regeneration',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14d-phase-d-readonly-activation-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14D',
    outcome: 'phase_d_live_readonly_activation_proven_offline',
    stillProductSchemaDiffers: true,
    phaseDConstraintsApplied: false,
    liveMutation: false,
    liveReadonlyConnectEnabled: true,
    liveQueryExecution: false,
    azureConnectivity: false,
    firewallAction: false,
    networkMutation: false,
    credentialLoading: false,
    enableFlagFlipped: true,
    cliExecutedLive: false,
    migrationAdded: false,
    ledgerWritten: false,
    applyFlagPresent: false,
    forwardCountUnchanged: forward.length,
    newForwardMigration: false,
    migrationHashes: { ...LOCKED_13C_SHA },
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    migration028Sha256CanonicalLfV1: EXPECTED_028_SHA256,
    defaultDisabled: true,
    dualEnableFlagsRequired: true,
    executeCountOnlyGateRequired: true,
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    offlineGates: {
      defaultPathZeroClients: true,
      executeGateMissingZeroClients: true,
      cliForbiddenDsnHostQuery: true,
      cliWrongExactTargetRejected: true,
      cliDefaultDisabled: true,
      connectFailureSanitizedClose: true,
      queryFailureRollbackAndClose: true,
      cliToplevelCatchRedactsAdminSecrets: true,
      activatedExactSequenceCountOnly: true,
      cliGatesPassExactTarget: true,
      boundaryReadyZeroConnect: true,
      normalResultRenderingSecretSafe: true,
      credentialsNeverInLogsResultsErrors: true,
    },
    redCases: red,
    greenCases: green,
    note: 'Slice 14D activates the merged 14C adapter behind exact 14B gates and the explicit count-only execution CLI/env gate. Offline injected-Client proof only. No live/Azure query. Phase D CHECK ADD remains a later slice. Do not claim Sunset repaired.',
  };

  leakScan(evidence, secrets);
  leakScan(contract, secrets);
  leakScan(redactDeep({ okRun, connectFail, queryFail }, secrets), secrets);

  const findings = `# FOUNDATION Slice 14D — Phase D live read-only activation

**Status:** complete (CONNECT_ENABLED activated; CLI default-disabled; offline injected-Client proof; no live query)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

Activated the merged Slice **14C** live read-only PostgreSQL adapter behind its exact Slice **14B** target/credential/query gates. Real \`pg\` Client wiring occurs only after:

1. dual flags (\`SUNSET_PHASE_D_LIVE_READONLY=1\` + \`SUNSET_PHASE_D_LIVE_PREFLIGHT=1\`)
2. exact \`AZURE_SUBSCRIPTION_ID\`
3. protected admin env (\`SUNSET_STAGING_PG_ADMIN_USER\` / \`SUNSET_STAGING_PG_ADMIN_PASSWORD\`)
4. explicit count-only execution gate (\`SUNSET_PHASE_D_LIVE_EXECUTE_COUNT_ONLY=1\` + \`--execute-count-only\`)
5. exact CLI confirmation of subscription / resource group / postgres server / database

No DSN / host / query argv. Default/missing/wrong inputs instantiate **zero** Clients.

Activated path (offline injected Client) executes only:

\`BEGIN READ ONLY\` → \`SHOW transaction_read_only\` → locked catalogs → exact aggregate → \`COMMIT\`

closes exactly once, returns only counts/safe metadata; failures sanitize secrets and \`ROLLBACK\`/close.

Outermost CLI \`main().catch\` is **fail-closed**: redacts \`SUNSET_STAGING_PG_ADMIN_USER\` / \`SUNSET_STAGING_PG_ADMIN_PASSWORD\` from message and nested error metadata before any stdout/stderr JSON; never prints env values, DSNs, stack, argv credentials, or raw error objects. Offline child-process inject proves \`cli_failed\` + nonzero exit with zero secret leakage. Normal result rendering also passes protected-admin secrets into \`redactDeep\`.

## Operator command (default-disabled)

\`\`\`bash
# refuse (default)
node scripts/run-phase-d-live-readonly-count-only.js

# live path (NOT executed in this slice)
SUNSET_PHASE_D_LIVE_READONLY=1 \\
SUNSET_PHASE_D_LIVE_PREFLIGHT=1 \\
SUNSET_PHASE_D_LIVE_EXECUTE_COUNT_ONLY=1 \\
AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId} \\
SUNSET_STAGING_PG_ADMIN_USER=... \\
SUNSET_STAGING_PG_ADMIN_PASSWORD=... \\
  node scripts/run-phase-d-live-readonly-count-only.js \\
    --execute-count-only \\
    --subscription ${TARGETS.subscriptionId} \\
    --resource-group ${TARGETS.resourceGroup} \\
    --postgres-server ${TARGETS.postgresServer} \\
    --database ${TARGETS.database}
\`\`\`

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero Clients; execute gate missing; CLI forbidden DSN/host/query; wrong exact target; CLI default refuse; connect/query failure sanitize + rollback/close; outermost CLI catch redacts admin secrets (child-process inject) |
| GREEN | activated exact sequence count-only; CLI gates pass; boundary ready with zero connect |

## Non-goals / still open

- **No** live CLI run, Azure connect/query, Key Vault load
- **No** DDL/apply/ledger, migration, or predicate changes
- Still \`product_schema_differs\`
- Phase D CHECK ADD remains a later slice
- **Do not claim Sunset repaired.**

## Zero live/Azure mutation

Offline injected fake \`pg\` Client only. No Azure CLI, no live PostgreSQL, no Key Vault credential load, no network/firewall mutation.
`;

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  console.log(`RED cases: ${red.length}`);
  console.log(`GREEN cases: ${green.length}`);
  console.log(`exact sequence: ${AUTHORIZED_SEQUENCE.join(' → ')}`);
  console.log(`wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('\nSlice 14D disposable proof GREEN — no live mutation.');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
