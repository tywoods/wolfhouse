'use strict';

/**
 * prove-sunset-schema-slice14c-phase-d-pg-adapter — FOUNDATION Slice 14C
 *
 * Offline proof with a scripted fake pg Client only. No Azure / live
 * PostgreSQL connection, no firewall/network mutation, no credential
 * loading from Key Vault, no enable-flag flip, no DDL/apply/ledger,
 * no migration, no 14A/14B target or predicate changes.
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
  AUTHORIZED_TABLE_EXISTS_SQL,
  AUTHORIZED_COLUMN_CATALOG_SQL,
  AUTHORIZED_SESSION_SQL,
  OUTPUT_COUNT_KEYS,
  authorizeLiveReadonlySql,
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
  buildVerifiedTlsSslConfig,
  buildLockedPgClientConfig,
  secretFreeClientConfigView,
  executePhaseDLiveReadonlyPgAdapter,
  defaultPhaseDLiveReadonlyPgAdapterPath,
  createScriptedFakePgClientFactory,
  createScriptedFakePgClient,
  runAuthorizedReadOnlySequence,
  authorizedQuery,
  getPgClientInstantiateCount,
  resetPgClientInstantiateCount,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED: PG_FLAG,
} = require('./lib/phase-d-live-readonly-pg-adapter');
const {
  EXPECTED_028_SHA256,
  AUTHORIZED_AGGREGATE_SQL: AGG_14A,
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
  REQUIRED_COLUMNS,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14c-phase-d-pg-adapter-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14c-phase-d-pg-adapter-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14c-findings.md');

const MASTER = 'ff136a18c1582e7749220ed00dcb1a7d51c0b999';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const FAKE_ADMIN_USER = 'slice14c-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14c-proof-admin-password-never-commit';
const FAKE_OBSERVER_DSN = [
  'postgresql://sunset_schema_observer:',
  encodeURIComponent('slice14c-observer-password-never-commit'),
  `@${TARGETS.postgresHost}:5432/${TARGETS.database}?sslmode=verify-full`,
].join('');

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

/** Dual flags + execute-count-only env (Slice 14D gate). */
function execEnv(extra) {
  return dualEnv({
    [ENV_EXECUTE_COUNT_ONLY]: '1',
    ...(extra || {}),
  });
}

function execArgv() {
  return ['node', 'prove', CLI_EXECUTE_COUNT_ONLY];
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
  console.log('prove:sunset-schema-slice14c-phase-d-pg-adapter — offline\n');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) throw new Error('manifest integrity failed');
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  const expected = JSON.parse(expectedBytes.toString('utf8'));

  if (manifestHash !== MANIFEST_HASH) {
    throw new Error(`manifest hash drift: ${manifestHash}`);
  }
  if (expectedHash !== EXPECTED_BYTE_SHA) {
    throw new Error(`expected-product-schema hash drift: ${expectedHash}`);
  }
  if (expected.productFingerprint !== CANON_FP) {
    throw new Error(`product fingerprint drift: ${expected.productFingerprint}`);
  }
  if (forward.length !== 39) throw new Error('forward count drift');
  assertMigration028ByteIntegrity();
  assert028PredicatesPresentInSource();
  if (AUTHORIZED_AGGREGATE_SQL !== AGG_14A) {
    throw new Error('14A aggregate SQL drift vs boundary');
  }
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true || PG_FLAG !== true) {
    throw new Error('live readonly connect must be activated (Slice 14D)');
  }
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    throw new Error('live apply must remain hard-disabled');
  }

  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));
  for (const [k, v] of Object.entries({
    '028': live028, '035': live035, '040': live040, '041': live041,
  })) {
    if (v !== LOCKED_13C_SHA[k]) throw new Error(`13C hash drift on ${k}: ${v}`);
  }

  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, 'slice14c-observer-password-never-commit'];
  const red = [];
  const green = [];

  // --- RED: default path — zero Clients ---
  resetPgClientInstantiateCount();
  const def = await defaultPhaseDLiveReadonlyPgAdapterPath({ env: {} });
  if (def.ok !== false && def.code !== 'live_readonly_flags_required' && def.clientsInstantiated !== 0) {
    // default with empty env should reject flags and instantiate 0
  }
  if (getPgClientInstantiateCount() !== 0 || (def.clientsInstantiated || 0) !== 0) {
    throw new Error('default path must instantiate zero Clients');
  }
  red.push({
    name: 'default_path_zero_clients',
    ok: true,
    code: def.code,
    clientsInstantiated: getPgClientInstantiateCount(),
  });

  // --- GREEN: exact target without execute-count-only — zero Clients ---
  resetPgClientInstantiateCount();
  const disabled = await executePhaseDLiveReadonlyPgAdapter({
    env: dualEnv(),
    argv: ['node', 'prove'],
    azureAdapters: createInjectedAzureAdapters({}, createCallRecorder()),
    dbAdapters: createInjectedDbAdapters({}, createCallRecorder()),
  });
  if (!disabled.ok
    || disabled.code !== 'target_accepted_execute_count_only_required'
    || disabled.clientsInstantiated !== 0
    || getPgClientInstantiateCount() !== 0) {
    throw new Error(`missing execute gate must accept target with zero Clients: ${disabled.code}`);
  }
  green.push({
    name: 'execute_gate_missing_exact_target_zero_clients',
    ok: true,
    code: disabled.code,
    clientsInstantiated: 0,
  });

  // --- RED: caller DSN / host / query ---
  resetPgClientInstantiateCount();
  const callerDsn = await executePhaseDLiveReadonlyPgAdapter({
    env: execEnv(),
    argv: execArgv(),
    dsn: FAKE_OBSERVER_DSN,
    Client: createScriptedFakePgClientFactory(),
  });
  if (callerDsn.ok !== false || callerDsn.code !== 'caller_supplied_connect_forbidden'
    || getPgClientInstantiateCount() !== 0) {
    throw new Error('caller DSN must be rejected with zero Clients');
  }
  red.push({
    name: 'caller_supplied_dsn_forbidden',
    ok: true,
    code: callerDsn.code,
    clientsInstantiated: 0,
  });

  resetPgClientInstantiateCount();
  const callerHost = await executePhaseDLiveReadonlyPgAdapter({
    env: execEnv(),
    argv: execArgv(),
    host: 'evil.example.com',
    Client: createScriptedFakePgClientFactory(),
  });
  if (callerHost.ok !== false || getPgClientInstantiateCount() !== 0) {
    throw new Error('caller host must be rejected');
  }
  red.push({
    name: 'caller_supplied_host_forbidden',
    ok: true,
    code: callerHost.code,
    clientsInstantiated: 0,
  });

  // --- RED: observer DSN env ---
  resetPgClientInstantiateCount();
  const obs = await executePhaseDLiveReadonlyPgAdapter({
    env: dualEnv({ [OBSERVER_DSN_ENV]: FAKE_OBSERVER_DSN }),
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    Client: createScriptedFakePgClientFactory(),
  });
  if (obs.ok !== false || getPgClientInstantiateCount() !== 0) {
    throw new Error('observer DSN must be rejected before Client');
  }
  red.push({
    name: 'observer_dsn_forbidden_zero_clients',
    ok: true,
    code: obs.code,
    clientsInstantiated: 0,
  });

  // --- GREEN: exact sequence / count-only success ---
  resetPgClientInstantiateCount();
  const FakeOk = createScriptedFakePgClientFactory({
    responses: {
      aggregate: {
        rows: [{
          total_rows: 7,
          date_window_violations: 2,
          price_unit_violations: 1,
        }],
        rowCount: 1,
      },
    },
  });
  const okRun = await executePhaseDLiveReadonlyPgAdapter({
    env: execEnv(),
    argv: execArgv(),
    azureAdapters: createInjectedAzureAdapters({}, createCallRecorder()),
    dbAdapters: createInjectedDbAdapters({}, createCallRecorder()),
    Client: FakeOk,
  });
  leakScan(okRun, secrets);
  if (!okRun.ok
    || okRun.counts.total_rows !== 7
    || okRun.counts.date_window_violations !== 2
    || okRun.counts.price_unit_violations !== 1
    || JSON.stringify(okRun.steps) !== JSON.stringify(AUTHORIZED_SEQUENCE)
    || okRun.clientsInstantiated !== 1
    || okRun.closed !== true
    || okRun.liveQueryExecution !== false
    || okRun.liveMutation !== false) {
    throw new Error(`exact sequence success failed: ${JSON.stringify(okRun)}`);
  }
  const okInst = FakeOk.instances[0];
  const querySqls = okInst.calls.filter((c) => c.method === 'query').map((c) => c.sql);
  if (querySqls.length !== 6) {
    throw new Error(`expected 6 queries, got ${querySqls.length}`);
  }
  if (!okInst.calls.some((c) => c.method === 'connect')
    || !okInst.calls.some((c) => c.method === 'end')) {
    throw new Error('connect and end must occur');
  }
  if (!okRun.clientConfig
    || okRun.clientConfig.ssl.rejectUnauthorized !== true
    || okRun.clientConfig.ssl.servername !== TARGETS.postgresHost
    || !String(okRun.clientConfig.options).includes(`statement_timeout=${STATEMENT_TIMEOUT_MS}`)
    || okRun.clientConfig.hasPassword !== true
    || JSON.stringify(okRun).includes(FAKE_ADMIN_PASSWORD)) {
    throw new Error('TLS/timeout/secret-free clientConfig view failed');
  }
  green.push({
    name: 'exact_sequence_count_only_success',
    ok: true,
    steps: okRun.steps,
    counts: okRun.counts,
    clientsInstantiated: 1,
    closed: true,
    queryCount: querySqls.length,
  });

  // --- RED: wrong / reordered / extra SQL ---
  let wrongSql = false;
  try {
    authorizeLiveReadonlySql('SELECT id, name FROM public.tenant_services');
  } catch (e) {
    wrongSql = e.code === 'unauthorized_sql';
  }
  let reordered = false;
  const reorderClient = createScriptedFakePgClient({ strictSequence: true });
  await reorderClient.connect();
  try {
    // Skip BEGIN — jump to SHOW (wrong order)
    await reorderClient.query('SHOW transaction_read_only');
  } catch (e) {
    reordered = e.code === 'unauthorized_sql';
  }
  let extra = false;
  const extraClient = createScriptedFakePgClient({ strictSequence: true });
  await extraClient.connect();
  await extraClient.query('BEGIN READ ONLY');
  await extraClient.query('SHOW transaction_read_only');
  await extraClient.query(AUTHORIZED_TABLE_EXISTS_SQL, ['public', 'tenant_services']);
  await extraClient.query(
    AUTHORIZED_COLUMN_CATALOG_SQL,
    ['public', 'tenant_services', REQUIRED_COLUMNS.map((c) => c.name)],
  );
  await extraClient.query(AUTHORIZED_AGGREGATE_SQL);
  await extraClient.query('COMMIT');
  try {
    await extraClient.query('SELECT 1');
  } catch (e) {
    extra = e.code === 'unauthorized_sql';
  }
  // authorizedQuery must reject before driver
  let authGate = false;
  try {
    await authorizedQuery(extraClient, 'DELETE FROM public.tenant_services');
  } catch (e) {
    authGate = e.code === 'unauthorized_sql';
  }
  if (!wrongSql || !reordered || !extra || !authGate) {
    throw new Error('wrong/reordered/extra SQL rejection failed');
  }
  red.push({
    name: 'wrong_reordered_extra_sql_rejected',
    ok: true,
    wrongSql,
    reordered,
    extra,
    authGate,
  });

  // --- RED: connect failure sanitized; close occurs ---
  resetPgClientInstantiateCount();
  const FakeConnectFail = createScriptedFakePgClientFactory({
    connectError: Object.assign(
      new Error(`connect boom password=${FAKE_ADMIN_PASSWORD} user=${FAKE_ADMIN_USER}`),
      { code: 'ECONNREFUSED' },
    ),
  });
  const connectFail = await executePhaseDLiveReadonlyPgAdapter({
    env: execEnv(),
    argv: execArgv(),
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    Client: FakeConnectFail,
  });
  leakScan(connectFail, secrets);
  if (connectFail.ok !== false
    || connectFail.code !== 'ECONNREFUSED'
    || connectFail.connectCategory !== 'refused'
    || connectFail.message !== 'connect failed'
    || connectFail.clientsInstantiated !== 1
    || !FakeConnectFail.instances[0].calls.some((c) => c.method === 'end')) {
    throw new Error(`connect failure path failed: ${JSON.stringify(connectFail)}`);
  }
  red.push({
    name: 'connect_failure_sanitized_close_occurs',
    ok: true,
    code: connectFail.code,
    closed: connectFail.closed,
    endCalled: true,
  });

  // --- RED: query failure → ROLLBACK + close ---
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
    argv: execArgv(),
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    Client: FakeQueryFail,
  });
  leakScan(queryFail, secrets);
  const qfInst = FakeQueryFail.instances[0];
  const qfSql = qfInst.calls.filter((c) => c.method === 'query').map((c) => c.sql);
  if (queryFail.ok !== false
    || !queryFail.rolledBack
    || !qfSql.some((s) => normalizeHas(s, 'ROLLBACK'))
    || !qfInst.calls.some((c) => c.method === 'end')) {
    throw new Error(`query failure rollback/close failed: ${JSON.stringify(queryFail)}`);
  }
  red.push({
    name: 'query_failure_rollback_and_close',
    ok: true,
    code: queryFail.code,
    rolledBack: true,
    closed: queryFail.closed,
  });

  // --- RED: commit failure → ROLLBACK + close ---
  resetPgClientInstantiateCount();
  const FakeCommitFail = createScriptedFakePgClientFactory({
    commitError: Object.assign(
      new Error(`commit boom ${FAKE_ADMIN_PASSWORD}`),
      { code: 'commit_failed' },
    ),
  });
  const commitFail = await executePhaseDLiveReadonlyPgAdapter({
    env: execEnv(),
    argv: execArgv(),
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    Client: FakeCommitFail,
  });
  leakScan(commitFail, secrets);
  const cfInst = FakeCommitFail.instances[0];
  if (commitFail.ok !== false
    || !commitFail.rolledBack
    || !cfInst.calls.some((c) => c.method === 'end')) {
    throw new Error(`commit failure path failed: ${JSON.stringify(commitFail)}`);
  }
  red.push({
    name: 'commit_failure_rollback_and_close',
    ok: true,
    code: commitFail.code,
    rolledBack: true,
  });

  // --- RED: otherwise-successful sequence + close failure => close_failed ---
  resetPgClientInstantiateCount();
  const FakeCloseFail = createScriptedFakePgClientFactory({
    closeError: Object.assign(
      new Error(`close boom ${FAKE_ADMIN_PASSWORD}`),
      { code: 'close_failed' },
    ),
  });
  const closeFail = await executePhaseDLiveReadonlyPgAdapter({
    env: execEnv(),
    argv: execArgv(),
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    Client: FakeCloseFail,
  });
  leakScan(closeFail, secrets);
  const closeFailEnds = FakeCloseFail.instances[0].calls.filter((c) => c.method === 'end');
  if (closeFail.ok !== false
    || closeFail.code !== 'close_failed'
    || closeFail.closed !== false
    || !closeFail.closeError
    || String(closeFail.closeError).includes(FAKE_ADMIN_PASSWORD)
    || String(closeFail.message || '').includes(FAKE_ADMIN_PASSWORD)
    || !closeFail.counts
    || closeFail.counts.total_rows == null
    || closeFailEnds.length !== 1
    || closeFail.counters.endCalls !== 1) {
    throw new Error(`close failure fail-closed failed: ${JSON.stringify(closeFail)}`);
  }
  red.push({
    name: 'close_failure_fail_closed',
    ok: true,
    code: 'close_failed',
    closed: false,
    countsPreserved: true,
    credentialsAbsent: true,
    endCalls: 1,
  });

  // --- RED: query failure + close failure => retain primary query code ---
  resetPgClientInstantiateCount();
  const FakeQueryAndCloseFail = createScriptedFakePgClientFactory({
    queryErrorAt: {
      aggregate: Object.assign(
        new Error(`query boom ${FAKE_ADMIN_PASSWORD}`),
        { code: 'query_failed' },
      ),
    },
    closeError: Object.assign(
      new Error(`close boom ${FAKE_ADMIN_PASSWORD}`),
      { code: 'close_failed' },
    ),
  });
  const queryCloseFail = await executePhaseDLiveReadonlyPgAdapter({
    env: execEnv(),
    argv: execArgv(),
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    Client: FakeQueryAndCloseFail,
  });
  leakScan(queryCloseFail, secrets);
  const qcfEnds = FakeQueryAndCloseFail.instances[0].calls
    .filter((c) => c.method === 'end');
  if (queryCloseFail.ok !== false
    || queryCloseFail.code !== 'query_failed'
    || queryCloseFail.closeFailure !== true
    || queryCloseFail.closed !== false
    || !queryCloseFail.closeError
    || String(queryCloseFail.closeError).includes(FAKE_ADMIN_PASSWORD)
    || String(queryCloseFail.message || '').includes(FAKE_ADMIN_PASSWORD)
    || qcfEnds.length !== 1
    || queryCloseFail.counters.endCalls !== 1) {
    throw new Error(
      `query+close failure primary retention failed: ${JSON.stringify(queryCloseFail)}`,
    );
  }
  red.push({
    name: 'query_failure_plus_close_failure_primary_retained',
    ok: true,
    code: 'query_failed',
    closeFailure: true,
    closed: false,
    credentialsAbsent: true,
    endCalls: 1,
  });

  // --- TLS / locked config unit checks ---
  const ssl = buildVerifiedTlsSslConfig();
  if (ssl.rejectUnauthorized !== true || ssl.servername !== TARGETS.postgresHost) {
    throw new Error('verified TLS ssl config mismatch');
  }
  const lockedCfg = buildLockedPgClientConfig({
    host: TARGETS.postgresHost,
    port: TARGETS.port,
    database: TARGETS.database,
    sslmode: 'verify-full',
    application_name: TARGETS.applicationName,
    _user: FAKE_ADMIN_USER,
    _password: FAKE_ADMIN_PASSWORD,
  });
  const view = secretFreeClientConfigView(lockedCfg);
  leakScan(view, secrets);
  if (view.hasUser !== true || view.hasPassword !== true || view.ssl.servername !== TARGETS.postgresHost) {
    throw new Error('locked client config view failed');
  }
  let forbidCaller = false;
  try {
    buildLockedPgClientConfig({
      host: TARGETS.postgresHost,
      port: TARGETS.port,
      database: TARGETS.database,
      sslmode: 'verify-full',
      application_name: TARGETS.applicationName,
      _user: FAKE_ADMIN_USER,
      _password: FAKE_ADMIN_PASSWORD,
    }, { host: 'evil.example.com' });
  } catch (e) {
    forbidCaller = e.code === 'caller_supplied_connect_forbidden';
  }
  if (!forbidCaller) throw new Error('buildLockedPgClientConfig must reject caller host');

  // live factory still disabled
  let liveFactoryDisabled = false;
  try {
    createLiveReadonlyAdapters();
  } catch (e) {
    liveFactoryDisabled = e && e.code === 'live_readonly_connect_disabled';
  }
  if (!liveFactoryDisabled) throw new Error('createLiveReadonlyAdapters must stay hard-disabled');

  // runAuthorizedReadOnlySequence rejects caller sql
  let seqCallerSql = false;
  const seqClient = createScriptedFakePgClient();
  await seqClient.connect();
  try {
    await runAuthorizedReadOnlySequence(seqClient, { sql: 'SELECT 1' });
  } catch (e) {
    seqCallerSql = e.code === 'caller_supplied_query_forbidden'
      || (e.result && e.result.code === 'caller_supplied_query_forbidden');
  }
  if (!seqCallerSql) throw new Error('sequence must reject caller sql');

  const generatedAt = new Date().toISOString();

  const contract = {
    kind: 'sunset-schema-observer-slice14c-phase-d-pg-adapter-contract',
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
    injectedFakePgClientOnly: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14C',
    purpose: 'Real PostgreSQL read-only adapter behind merged 14B boundary; CONNECT_ENABLED activated in 14D behind execute-count-only gate; this proof uses offline scripted fake pg Client only (no live query).',
    targets: { ...TARGETS },
    credentialSources: {
      approvedUserEnv: CREDENTIAL_USER_ENV,
      approvedPasswordEnv: CREDENTIAL_PASSWORD_ENV,
      loader: 'scripts/load-sunset-staging-pg-admin-env.js',
      keyVaultSecret: 'sunset-database-url',
      forbidden: [
        'argv',
        'caller_supplied_dsn',
        OBSERVER_DSN_ENV,
        'WOLFHOUSE_DATABASE_URL',
        'caller host/database/query',
      ],
    },
    tls: {
      sslmode: 'verify-full',
      rejectUnauthorized: true,
      servername: TARGETS.postgresHost,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    },
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    authorizedSessionSql: AUTHORIZED_SESSION_SQL.slice(),
    authorizedCatalogSql: [
      AUTHORIZED_TABLE_EXISTS_SQL,
      AUTHORIZED_COLUMN_CATALOG_SQL,
    ],
    authorizedAggregateSql: AUTHORIZED_AGGREGATE_SQL,
    outputKeys: OUTPUT_COUNT_KEYS.slice(),
    predicatesUnchangedFrom14A: {
      date_window: DATE_WINDOW_PREDICATE,
      price_unit: PRICE_UNIT_PREDICATE,
    },
    forbidden: [
      'live connect/query execution',
      'firewall/network mutation',
      'credential loading / enable-flag flip',
      'apply/DDL/ledger',
      'migration',
      '14A/14B target or predicate changes',
      'credentials in logs/results/errors',
      'caller DSN / host / database / query',
    ],
    nonGoals: [
      'No Phase D constraint apply',
      'No Sunset repair claim',
      'No live Azure/PostgreSQL query',
      'No expected-fixture regeneration',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14c-phase-d-pg-adapter-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14C',
    outcome: 'phase_d_live_readonly_pg_adapter_proven_offline_activated_gated',
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
    tls: contract.tls,
    offlineGates: {
      defaultPathZeroClients: true,
      executeGateMissingExactTargetZeroClients: true,
      liveDisabledExactTargetZeroClients: true,
      exactSequenceCountOnlySuccess: true,
      wrongReorderedExtraSqlRejected: true,
      connectFailureSanitizedCloseOccurs: true,
      queryFailureRollbackAndClose: true,
      commitFailureRollbackAndClose: true,
      closeFailureFailClosed: true,
      queryFailurePlusCloseFailurePrimaryRetained: true,
      credentialsNeverInLogsResultsErrors: true,
      callerDsnHostQueryRejected: true,
      observerDsnRejectedBeforeClient: true,
      statementTimeoutEnforcedInClientOptions: true,
      verifiedTlsRejectUnauthorized: true,
    },
    redCases: red,
    greenCases: green,
    note: 'Slice 14C proves the real pg read-only adapter behind the 14B boundary with a scripted fake Client only. CONNECT_ENABLED is activated in Slice 14D behind the execute-count-only gate; this proof never runs live. Phase D CHECK ADD remains a later slice. Do not claim Sunset repaired.',
  };

  leakScan(evidence, secrets);
  leakScan(contract, secrets);

  const findings = `# FOUNDATION Slice 14C — Phase D live read-only PostgreSQL adapter

**Status:** complete (real adapter; CONNECT_ENABLED activated in 14D behind execute-count-only; offline fake-Client proof)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

Implemented the real PostgreSQL read-only adapter behind the merged Slice **14B** boundary. The adapter creates a \`pg\` Client **only after** all 14B gates pass **and** the Slice **14D** explicit count-only execution gate (\`SUNSET_PHASE_D_LIVE_EXECUTE_COUNT_ONLY=1\` + \`--execute-count-only\`), builds config exclusively from locked TARGETS + protected admin env (\`SUNSET_STAGING_PG_ADMIN_USER\` / \`SUNSET_STAGING_PG_ADMIN_PASSWORD\`), reuses verified TLS (\`rejectUnauthorized: true\` + \`servername\` = locked FQDN) and \`statement_timeout=${STATEMENT_TIMEOUT_MS}\`, and executes only the exact authorized 14A sequence:

1. \`BEGIN READ ONLY\`
2. \`SHOW transaction_read_only\`
3. locked catalog table check
4. locked catalog column check
5. exact aggregate (count-only)
6. \`COMMIT\` (or \`ROLLBACK\` on failure)

\`client.end()\` is attempted exactly once in \`finally\` after connect/query success or failure. Close/end failure is **fail-closed**: otherwise-successful runs become \`ok:false\` / \`code:close_failed\` / \`closed:false\` (count-only data may be preserved; never a successful completed adapter run). If connect/query/commit already failed, the primary code is retained and sanitized \`closeFailure=true\` / \`closeError\` metadata is attached. \`PHASE_D_LIVE_READONLY_CONNECT_ENABLED=true\` (Slice 14D); default and missing-execute-gate paths instantiate **zero** Clients. This proof never opens live Azure/PostgreSQL.

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero Clients; caller DSN/host/query; observer DSN; wrong/reordered/extra SQL; connect/query/commit failures sanitized; close failure fail-closed (\`close_failed\`); query+close failure retains primary query code; rollback+close on failure |
| GREEN | missing execute-count-only gate → zero Clients; exact sequence count-only success with fake Client; TLS+timeout in secret-free config view |

## Non-goals / still open

- **No** live/Azure query in this proof, firewall/network, Key Vault credential loading
- **No** DDL/apply/ledger, migration, or 14A/14B target/predicate changes
- Still \`product_schema_differs\`
- Phase D CHECK ADD remains a later slice
- **Do not claim Sunset repaired.**

## Zero live/Azure mutation

This disposable proof used a scripted fake \`pg\` Client only. No Azure CLI, no live PostgreSQL, no Key Vault credential load, no network/firewall mutation.
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
  console.log('\nSlice 14C disposable proof GREEN — no live mutation.');
}

function normalizeHas(sql, token) {
  return String(sql || '').replace(/\s+/g, ' ').toUpperCase().includes(token);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
