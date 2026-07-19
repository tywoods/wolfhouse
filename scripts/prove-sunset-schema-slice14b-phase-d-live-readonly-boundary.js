'use strict';

/**
 * prove-sunset-schema-slice14b-phase-d-live-readonly-boundary — FOUNDATION Slice 14B
 *
 * Offline proof with injected adapters only. No Azure / live PostgreSQL
 * connection, no query execution against live, no firewall/network mutation,
 * no apply/DDL/ledger, no migration, no 14A predicate changes.
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
  CREDENTIAL_USER_ENV,
  CREDENTIAL_PASSWORD_ENV,
  OBSERVER_DSN_ENV,
  AUTHORIZED_AGGREGATE_SQL,
  AUTHORIZED_TABLE_EXISTS_SQL,
  AUTHORIZED_COLUMN_CATALOG_SQL,
  AUTHORIZED_SESSION_SQL,
  OUTPUT_COUNT_KEYS,
  validateTargets,
  evaluateDualEnableFlags,
  resolveProtectedAdminCredentials,
  authorizeLiveReadonlySql,
  assertNoNetworkMutation,
  assertNoSecretInArgv,
  assertSecretFreeText,
  evaluateLiveReadonlyBoundary,
  defaultLiveReadonlyBoundaryPath,
  shapeCountOnlyResult,
  redactDeep,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  createInjectedAzureAdapters,
  createInjectedDbAdapters,
  createCallRecorder,
  createLiveReadonlyAdapters,
} = require('./lib/phase-d-live-readonly-adapters');
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
const EVIDENCE_PATH = path.join(FIX, 'slice14b-phase-d-live-readonly-boundary-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14b-phase-d-live-readonly-boundary-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14b-findings.md');

const MASTER = '8905be445fcce5d23e813f66d339c48580c5ecd9';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const FAKE_ADMIN_USER = 'slice14b-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14b-proof-admin-password-never-commit';
const FAKE_OBSERVER_DSN = [
  'postgresql://sunset_schema_observer:',
  encodeURIComponent('slice14b-observer-password-never-commit'),
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

function goodAzure(rec) {
  return createInjectedAzureAdapters({}, rec || createCallRecorder());
}

function goodDb(rec) {
  return createInjectedDbAdapters({}, rec || createCallRecorder());
}

async function runCase(name, fn) {
  const result = await fn();
  if (!result || result.ok !== true) {
    throw new Error(`case ${name} failed: ${JSON.stringify(result && result.code)}`);
  }
  return { name, ...result };
}

async function runRed(name, fn) {
  const result = await fn();
  if (!result || result.ok !== false) {
    throw new Error(`RED case ${name} unexpectedly passed`);
  }
  if ((result.counters && result.counters.connectCalls) > 0
    || (result.counters && result.counters.queryCalls) > 0) {
    throw new Error(`RED case ${name} performed connect/query`);
  }
  return {
    name,
    ok: true,
    rejected: true,
    code: result.code,
    errorCodes: (result.errors || []).map((e) => e.code),
    connectCalls: result.counters ? result.counters.connectCalls : 0,
    queryCalls: result.counters ? result.counters.queryCalls : 0,
  };
}

async function main() {
  console.log('prove:sunset-schema-slice14b-phase-d-live-readonly-boundary — offline\n');

  const manifest = loadManifest(MANIFEST_PATH);
  const integrity = validateManifestIntegrity(manifest);
  if (!integrity.ok) throw new Error('manifest integrity failed');
  const forward = forwardEntries(manifest);
  const { manifestHash } = hashCanonicalManifest(manifest);
  const expectedBytes = fs.readFileSync(EXPECTED_PATH);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  const expected = JSON.parse(expectedBytes.toString('utf8'));

  const live028 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '028_tenant_services.sql'));
  const live035 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '035_customer_message_templates.sql'));
  const live040 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '040_tenant_services_saas_catalog_columns.sql'));
  const live041 = sha256CanonicalLfV1File(path.join(MIGRATIONS_DIR, '041_notification_surfpack_convergence.sql'));

  if (live028 !== LOCKED_13C_SHA['028']) throw new Error('028 hash drift');
  if (live035 !== LOCKED_13C_SHA['035']) throw new Error('035 hash drift');
  if (live040 !== LOCKED_13C_SHA['040']) throw new Error('040 hash drift');
  if (live041 !== LOCKED_13C_SHA['041']) throw new Error('041 hash drift');
  if (manifestHash !== MANIFEST_HASH) throw new Error('manifest hash drift');
  if (expectedHash !== EXPECTED_BYTE_SHA) throw new Error('expected fixture byte drift');
  if (expected.productFingerprint !== CANON_FP) throw new Error('product fingerprint drift');
  if (forward.length !== 39) throw new Error('forward count drift');
  if (AUTHORIZED_AGGREGATE_SQL !== AGG_14A) throw new Error('14A aggregate SQL drift');
  assertMigration028ByteIntegrity();
  assert028PredicatesPresentInSource();
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) {
    throw new Error('live readonly connect must be activated (Slice 14D)');
  }
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    throw new Error('live apply must remain false');
  }

  // Default path: zero connection calls.
  const defaultResult = await defaultLiveReadonlyBoundaryPath({
    env: {},
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
  });
  if (defaultResult.ok || defaultResult.accepted) {
    throw new Error('default path must reject without dual flags');
  }
  if (defaultResult.counters.connectCalls !== 0
    || defaultResult.counters.queryCalls !== 0
    || defaultResult.counters.azureCalls !== 0
    || defaultResult.counters.connectInfoCalls !== 0) {
    throw new Error('default path must make zero connection/azure calls');
  }

  const redCases = [];
  redCases.push(await runRed('missing_dual_flags', async () => evaluateLiveReadonlyBoundary({
    env: {
      [CREDENTIAL_USER_ENV]: FAKE_ADMIN_USER,
      [CREDENTIAL_PASSWORD_ENV]: FAKE_ADMIN_PASSWORD,
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    },
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
  })));
  redCases.push(await runRed('single_flag_readonly_only', async () => evaluateLiveReadonlyBoundary({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [CREDENTIAL_USER_ENV]: FAKE_ADMIN_USER,
      [CREDENTIAL_PASSWORD_ENV]: FAKE_ADMIN_PASSWORD,
    },
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
  })));
  redCases.push(await runRed('wrong_subscription', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv({ [ENV_SUBSCRIPTION]: '00000000-0000-0000-0000-000000000000' }),
    argv: ['node', 'prove'],
    targets: { ...TARGETS, subscriptionId: '00000000-0000-0000-0000-000000000000' },
    azureAdapters: createInjectedAzureAdapters({
      subscriptionId: '00000000-0000-0000-0000-000000000000',
    }),
    dbAdapters: goodDb(),
  })));
  redCases.push(await runRed('wrong_resource_group', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv(),
    argv: ['node', 'prove'],
    targets: { ...TARGETS, resourceGroup: 'wh-staging-rg' },
    azureAdapters: createInjectedAzureAdapters({ resourceGroup: 'wh-staging-rg' }),
    dbAdapters: goodDb(),
  })));
  redCases.push(await runRed('wrong_host', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv(),
    argv: ['node', 'prove'],
    targets: { ...TARGETS, postgresHost: 'evil.example.com' },
    azureAdapters: createInjectedAzureAdapters({ postgresHost: 'evil.example.com' }),
    dbAdapters: createInjectedDbAdapters({ host: 'evil.example.com' }),
  })));
  redCases.push(await runRed('wrong_database', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv(),
    argv: ['node', 'prove'],
    targets: { ...TARGETS, database: 'wolfhouse_staging' },
    azureAdapters: goodAzure(),
    dbAdapters: createInjectedDbAdapters({ database: 'wolfhouse_staging' }),
  })));
  redCases.push(await runRed('wrong_tls', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv(),
    argv: ['node', 'prove'],
    targets: { ...TARGETS, sslmode: 'require' },
    azureAdapters: goodAzure(),
    dbAdapters: createInjectedDbAdapters({ sslmode: 'require' }),
  })));
  redCases.push(await runRed('credential_from_argv', async () => evaluateLiveReadonlyBoundary({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    },
    argv: ['node', 'prove', `--dsn=${FAKE_OBSERVER_DSN}`],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
  })));
  redCases.push(await runRed('observer_credentials_forbidden', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv({
      [CREDENTIAL_USER_ENV]: '',
      [CREDENTIAL_PASSWORD_ENV]: '',
      [OBSERVER_DSN_ENV]: FAKE_OBSERVER_DSN,
    }),
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
  })));
  redCases.push(await runRed('missing_admin_credentials', async () => evaluateLiveReadonlyBoundary({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    },
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
  })));
  redCases.push(await runRed('partial_admin_user_only', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv({ [CREDENTIAL_PASSWORD_ENV]: '' }),
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
  })));
  redCases.push(await runRed('partial_admin_password_only', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv({ [CREDENTIAL_USER_ENV]: '' }),
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
  })));
  redCases.push(await runRed('wolfhouse_database_url_forbidden', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv({
      [CREDENTIAL_USER_ENV]: '',
      [CREDENTIAL_PASSWORD_ENV]: '',
      WOLFHOUSE_DATABASE_URL: FAKE_OBSERVER_DSN,
    }),
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
  })));
  redCases.push(await runRed('credential_file_path_forbidden', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv({
      [CREDENTIAL_USER_ENV]: '',
      [CREDENTIAL_PASSWORD_ENV]: '',
      SUNSET_PHASE_D_LIVE_DSN_FILE: '/run/secrets/fake-dsn',
    }),
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
  })));
  redCases.push(await runRed('caller_supplied_dsn_forbidden', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv(),
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
    dsn: FAKE_OBSERVER_DSN,
  })));
  redCases.push(await runRed('firewall_mutation_planned', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv(),
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
    plannedCommands: ['flexible-server firewall-rule create -g x'],
  })));

  // Unauthorized SQL
  let unauthorizedRejected = false;
  try {
    authorizeLiveReadonlySql('SELECT * FROM tenant_services');
  } catch (e) {
    unauthorizedRejected = e && e.code === 'unauthorized_sql';
  }
  if (!unauthorizedRejected) throw new Error('unauthorized SQL must be rejected');

  let aggregateOk = false;
  try {
    authorizeLiveReadonlySql(AUTHORIZED_AGGREGATE_SQL);
    authorizeLiveReadonlySql(AUTHORIZED_TABLE_EXISTS_SQL);
    authorizeLiveReadonlySql(AUTHORIZED_COLUMN_CATALOG_SQL);
    for (const s of AUTHORIZED_SESSION_SQL) authorizeLiveReadonlySql(s);
    aggregateOk = true;
  } catch (e) {
    throw new Error(`authorized SQL rejected: ${e.message}`);
  }
  if (!aggregateOk) throw new Error('authorized SQL must pass');

  // GREEN: exact target + dual flags + protected admin env → accepted, still zero connect/query
  const greenAzureRec = createCallRecorder();
  const greenDbRec = createCallRecorder();
  const green = await runCase('exact_target_dual_flags', async () => {
    const r = await evaluateLiveReadonlyBoundary({
      env: dualEnv(),
      argv: ['node', 'prove'],
      azureAdapters: createInjectedAzureAdapters({}, greenAzureRec),
      dbAdapters: createInjectedDbAdapters({}, greenDbRec),
    });
    if (!r.accepted) throw new Error('exact target not accepted');
    if (r.counters.connectCalls !== 0 || r.counters.queryCalls !== 0) {
      throw new Error('GREEN path must not connect/query');
    }
    if (r.liveReadonlyConnectEnabled !== true) {
      throw new Error('connect readiness must be activated (Slice 14D)');
    }
    if (r.code !== 'target_accepted_live_readonly_ready') {
      throw new Error(`expected target_accepted_live_readonly_ready, got ${r.code}`);
    }
    if (!r.plan || r.plan.credentialSource !== 'protected_admin_env') {
      throw new Error('GREEN must record protected_admin_env credential source');
    }
    return {
      ok: true,
      ...r,
      azureCalls: greenAzureRec.total(),
      dbConnectInfoCalls: greenDbRec.count('connectInfo'),
    };
  });

  // Count-only shaping + secret-free
  const counts = shapeCountOnlyResult({
    total_rows: 10,
    date_window_violations: 2,
    price_unit_violations: 1,
  });
  if (Object.keys(counts).sort().join(',') !== OUTPUT_COUNT_KEYS.slice().sort().join(',')) {
    throw new Error('count-only shape drift');
  }

  const leakSecrets = [
    FAKE_ADMIN_USER,
    FAKE_ADMIN_PASSWORD,
    FAKE_OBSERVER_DSN,
    'slice14b-observer-password-never-commit',
  ];
  const leakScan = assertSecretFreeText(
    JSON.stringify({ green: redactDeep(green, leakSecrets), redCases }),
    leakSecrets,
  );
  if (!leakScan.ok) throw new Error(`secret leak in proof payload: ${leakScan.hits.join(',')}`);

  // Live adapter factory refuses
  let liveFactoryDisabled = false;
  try {
    createLiveReadonlyAdapters();
  } catch (e) {
    liveFactoryDisabled = e && e.code === 'live_readonly_connect_disabled';
  }
  if (!liveFactoryDisabled) throw new Error('live adapter factory must refuse');

  // Network mutation helper
  if (assertNoNetworkMutation('az group show').ok !== true) {
    throw new Error('benign command wrongly blocked');
  }
  if (assertNoNetworkMutation('firewall-rule create').ok !== false) {
    throw new Error('firewall mutation must be blocked');
  }

  // Credential argv helper
  if (assertNoSecretInArgv(['--dsn', FAKE_OBSERVER_DSN], [FAKE_OBSERVER_DSN]).ok !== false) {
    throw new Error('argv secret must be detected');
  }

  const generatedAt = new Date().toISOString();

  const contract = {
    kind: 'sunset-schema-observer-slice14b-phase-d-live-readonly-boundary-contract',
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
    disposablePostgreSQLOnly: false,
    injectedAdaptersOnly: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14B',
    purpose:
      'Live read-only connection boundary (CONNECT_ENABLED activated in 14D). Gates merged 14A count-only preflight against exact Sunset staging PostgreSQL/database. Boundary itself never connects/queries. Credentials from protected admin env only. Offline injected-adapter proof only in this slice.',
    targets: { ...TARGETS },
    credentialSources: {
      approvedUserEnv: CREDENTIAL_USER_ENV,
      approvedPasswordEnv: CREDENTIAL_PASSWORD_ENV,
      loader: 'scripts/load-sunset-staging-pg-admin-env.js',
      keyVaultSecret: 'sunset-database-url',
      connectConfig: {
        host: TARGETS.postgresHost,
        port: TARGETS.port,
        database: TARGETS.database,
        sslmode: 'verify-full',
        application_name: TARGETS.applicationName,
      },
      forbidden: [
        'argv',
        'output',
        'evidence',
        'committed_files',
        'caller_supplied_dsn',
        OBSERVER_DSN_ENV,
        'WOLFHOUSE_DATABASE_URL',
        'SUNSET_PHASE_D_LIVE_DSN_FILE',
        'arbitrary_file_path',
      ],
    },
    dualEnableFlags: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    },
    session: {
      beginReadOnly: true,
      applicationName: TARGETS.applicationName,
      sslmode: 'verify-full',
      authorizedSessionSql: AUTHORIZED_SESSION_SQL.slice(),
    },
    queryAuthorization: {
      authorizedCatalogSql: [
        AUTHORIZED_TABLE_EXISTS_SQL,
        AUTHORIZED_COLUMN_CATALOG_SQL,
      ],
      authorizedAggregateSql: AUTHORIZED_AGGREGATE_SQL,
      outputKeys: OUTPUT_COUNT_KEYS.slice(),
      returnsRowValues: false,
      returnsIdentifiers: false,
      returnsGuestData: false,
      acceptsArbitrarySql: false,
      predicatesUnchangedFrom14A: {
        date_window: DATE_WINDOW_PREDICATE,
        price_unit: PRICE_UNIT_PREDICATE,
      },
    },
    forbidden: [
      'live connect/query execution (Slice 14B)',
      'firewall/network mutation',
      'apply/DDL/ledger',
      'migration',
      'Azure mutation',
      'credential in argv/output/evidence/committed files',
      'observer DSN / WOLFHOUSE_DATABASE_URL / caller-supplied DSN / file path credentials',
      'username/password in evidence/errors',
      'row payloads',
      'arbitrary SQL',
      '14A predicate alteration',
    ],
    nonGoals: [
      'No Phase D constraint apply',
      'No Sunset repair claim',
      'No live evidence capture',
      'No live observer job',
      'No expected-fixture regeneration',
      'No observer role/grant changes',
      'No Key Vault loader changes',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14b-phase-d-live-readonly-boundary-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14B',
    outcome: 'phase_d_live_readonly_boundary_proven_offline_activated_gated',
    stillProductSchemaDiffers: true,
    phaseDConstraintsApplied: false,
    liveMutation: false,
    liveReadonlyConnectEnabled: true,
    liveQueryExecution: false,
    azureConnectivity: false,
    firewallAction: false,
    networkMutation: false,
    migrationAdded: false,
    ledgerWritten: false,
    applyFlagPresent: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    migrationHashes: { ...LOCKED_13C_SHA },
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    migration028Sha256CanonicalLfV1: EXPECTED_028_SHA256,
    defaultDisabled: true,
    dualEnableFlagsRequired: true,
    credentialContract: {
      source: 'protected_admin_env',
      userEnv: CREDENTIAL_USER_ENV,
      passwordEnv: CREDENTIAL_PASSWORD_ENV,
      observerDsnAccepted: false,
      callerSuppliedDsnAccepted: false,
      filePathAccepted: false,
      usernamePasswordInEvidence: false,
    },
    offlineGates: {
      defaultPathZeroConnectionCalls: true,
      dualFlagsRequired: true,
      exactTargetAcceptedOnlyWithDualFlags: true,
      wrongSubscriptionRejectedBeforeConnect: true,
      wrongResourceGroupRejectedBeforeConnect: true,
      wrongHostRejectedBeforeConnect: true,
      wrongDatabaseRejectedBeforeConnect: true,
      wrongTlsRejectedBeforeConnect: true,
      credentialFromArgvRejected: true,
      observerCredentialsRejectedBeforeConnect: true,
      missingAdminCredentialsRejectedBeforeConnect: true,
      partialAdminCredentialsRejectedBeforeConnect: true,
      wolfhouseDatabaseUrlRejectedBeforeConnect: true,
      credentialFilePathRejectedBeforeConnect: true,
      callerSuppliedDsnRejectedBeforeConnect: true,
      firewallNetworkMutationRejected: true,
      unauthorizedSqlRejected: true,
      authorized14aCatalogAndAggregateOnly: true,
      countOnlySecretFree: true,
      liveAdapterFactoryHardDisabled: true,
      protectedAdminEnvAcceptedWithoutConnect: true,
    },
    redCases,
    greenCases: [
      {
        name: 'exact_target_dual_flags',
        ok: true,
        accepted: true,
        connectCalls: 0,
        queryCalls: 0,
        liveReadonlyConnectEnabled: true,
        credentialSource: 'protected_admin_env',
        code: green.code,
      },
    ],
    queryAuthorization: {
      outputKeys: OUTPUT_COUNT_KEYS.slice(),
      authorizedAggregateSql: AUTHORIZED_AGGREGATE_SQL,
      authorizedSessionSql: AUTHORIZED_SESSION_SQL.slice(),
      returnsRowValues: false,
      acceptsArbitrarySql: false,
      sampleCountOnlyShape: counts,
    },
    targets: { ...TARGETS },
    note:
      'Slice 14B proves the live read-only boundary gates (exact target + dual flags + protected admin env). CONNECT_ENABLED activated in 14D; boundary itself still makes zero connect/query calls. Phase D CHECK ADD remains a later slice. Do not claim Sunset repaired.',
  };

  // Final secret scan on artifacts about to be written
  const artifactBlob = `${JSON.stringify(evidence)}${JSON.stringify(contract)}`;
  const finalScan = assertSecretFreeText(artifactBlob, leakSecrets);
  if (!finalScan.ok) throw new Error('evidence/contract would leak secrets');

  const findings = `# FOUNDATION Slice 14B — Phase D live read-only connection boundary

**Status:** complete (boundary gates; CONNECT_ENABLED activated in 14D; offline injected-adapter proof; boundary never connects)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

Added a live read-only connection boundary that gates the merged Slice **14A** count-only preflight against the exact Sunset staging PostgreSQL/database. Slice **14D** activates \`PHASE_D_LIVE_READONLY_CONNECT_ENABLED\`; this boundary still never opens sockets.

### Locked target

| Lock | Value |
|------|-------|
| Subscription | \`${TARGETS.subscriptionId}\` |
| Resource group | \`${TARGETS.resourceGroup}\` |
| Server | \`${TARGETS.postgresServer}\` |
| FQDN | \`${TARGETS.postgresHost}\` |
| Database | \`${TARGETS.database}\` |
| TLS | \`sslmode=verify-full\` |
| application_name | \`${TARGETS.applicationName}\` |
| Transaction | \`BEGIN READ ONLY\` |

### Credential boundary

Credentials may come **only** from protected admin env populated by the existing locked loader (\`scripts/load-sunset-staging-pg-admin-env.js\` → Key Vault \`sunset-database-url\`):

- \`${CREDENTIAL_USER_ENV}\`
- \`${CREDENTIAL_PASSWORD_ENV}\`

Connection config is constructed **only** for the locked host/database (\`sslmode=verify-full\`, \`application_name=${TARGETS.applicationName}\`).

**Never** accepted: caller-supplied DSN, argv credential, \`${OBSERVER_DSN_ENV}\` (CONNECT-only / no SELECT), \`WOLFHOUSE_DATABASE_URL\`, or arbitrary file path.

Username/password are **never** printed, persisted, returned, hashed, or included in evidence/errors.

### Query boundary

Only Slice **14A** catalog queries + its exact aggregate (plus session \`BEGIN READ ONLY\` / \`SHOW transaction_read_only\` / \`COMMIT\` / \`ROLLBACK\`) are authorized. Results/errors remain **count-only** and **secret-free**. 14A predicates are **unchanged**.

## Offline proof matrix (injected adapters)

| Case | Result |
|------|--------|
| Default path (no dual flags) | RED — zero connection calls |
| Exact target + dual flags + protected admin env | GREEN accept — ready (0 connect/query in boundary) |
| Wrong subscription / RG / host / database / TLS | RED before connect |
| Observer DSN / missing / partial admin credentials | RED before connect |
| Caller-supplied DSN / argv / WOLFHOUSE_DATABASE_URL / file path | RED before connect |
| Firewall/network mutation planned | RED |
| Unauthorized SQL | RED |
| 14A catalog + aggregate + session SQL | GREEN authorize |
| Live adapter factory placeholder | RED refused (CLI/adapter is live entry) |

## Unchanged hashes (byte-identical)

| Artifact | Hash |
|----------|------|
| Migration 028 | \`${LOCKED_13C_SHA['028']}\` |
| Migration 035 | \`${LOCKED_13C_SHA['035']}\` |
| Migration 040 | \`${LOCKED_13C_SHA['040']}\` |
| Migration 041 | \`${LOCKED_13C_SHA['041']}\` |
| Manifest | \`${MANIFEST_HASH}\` |
| Product fingerprint | \`${CANON_FP}\` |
| expected-product-schema.json bytes | \`${EXPECTED_BYTE_SHA}\` |
| Forward count | **39** (unchanged) |

## Non-claims

**Do not claim** Sunset is repaired. Phase D \`ADD CONSTRAINT\` is **not** implemented. Boundary connect/query remains **zero** in 14B proof; Client wiring is gated in 14D. Zero live/Azure mutation. No firewall, ledger, migration, apply flag, or live evidence. No observer role/grant or Key Vault loader changes.

## Commands

\`\`\`bash
npm run prove:sunset-schema-slice14b-phase-d-live-readonly-boundary
npm run verify:sunset-schema-slice14b
\`\`\`
`;

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  // Touch validateTargets green for completeness
  if (!validateTargets(TARGETS).ok) throw new Error('TARGETS self-validate failed');
  if (evaluateDualEnableFlags(dualEnv()).ok !== true) throw new Error('dual flags self-check failed');
  const credSelf = resolveProtectedAdminCredentials({ env: dualEnv(), argv: ['node'] });
  if (!credSelf.ok || credSelf.source !== 'protected_admin_env') {
    throw new Error('credential self-check failed');
  }
  if (credSelf.connectInfo.host !== TARGETS.postgresHost
    || credSelf.connectInfo.database !== TARGETS.database
    || credSelf.connectInfo.sslmode !== 'verify-full') {
    throw new Error('locked connect info self-check failed');
  }

  console.log('  PASS  default-path-zero-calls');
  console.log(`  PASS  red-cases (${redCases.length})`);
  console.log('  PASS  green-exact-target-protected-admin-env (boundary zero connect)');
  console.log('  PASS  query-authorization + count-only + secret-free');
  console.log('  PASS  canonical-hashes-unchanged');
  console.log('\nArtifacts written:');
  console.log(`  ${CONTRACT_PATH}`);
  console.log(`  ${EVIDENCE_PATH}`);
  console.log(`  ${FINDINGS_PATH}`);
  console.log('\nprove:sunset-schema-slice14b-phase-d-live-readonly-boundary GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
