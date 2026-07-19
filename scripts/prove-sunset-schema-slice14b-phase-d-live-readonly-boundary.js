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
  CREDENTIAL_ENV,
  CREDENTIAL_FILE_ENV,
  APPROVED_CREDENTIAL_FILE_PREFIXES,
  AUTHORIZED_AGGREGATE_SQL,
  AUTHORIZED_TABLE_EXISTS_SQL,
  AUTHORIZED_COLUMN_CATALOG_SQL,
  AUTHORIZED_SESSION_SQL,
  OUTPUT_COUNT_KEYS,
  validateTargets,
  evaluateDualEnableFlags,
  resolveApprovedCredentials,
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

const FAKE_PASSWORD = 'slice14b-proof-password-never-commit';
const GOOD_DSN = [
  'postgresql://sunset_schema_observer:',
  encodeURIComponent(FAKE_PASSWORD),
  `@${TARGETS.postgresHost}:5432/${TARGETS.database}?sslmode=verify-full`,
].join('');

function dualEnv(extra) {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    [CREDENTIAL_ENV]: GOOD_DSN,
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
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== false) {
    throw new Error('live readonly connect must be hard-disabled');
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
    env: { [CREDENTIAL_ENV]: GOOD_DSN, [ENV_SUBSCRIPTION]: TARGETS.subscriptionId },
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
  })));
  redCases.push(await runRed('single_flag_readonly_only', async () => evaluateLiveReadonlyBoundary({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [CREDENTIAL_ENV]: GOOD_DSN,
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
    env: dualEnv({
      [CREDENTIAL_ENV]: GOOD_DSN.replace(TARGETS.database, 'wolfhouse_staging'),
    }),
    argv: ['node', 'prove'],
    targets: { ...TARGETS, database: 'wolfhouse_staging' },
    azureAdapters: goodAzure(),
    dbAdapters: createInjectedDbAdapters({ database: 'wolfhouse_staging' }),
  })));
  redCases.push(await runRed('wrong_tls', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv({
      [CREDENTIAL_ENV]: GOOD_DSN.replace('sslmode=verify-full', 'sslmode=require'),
    }),
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: createInjectedDbAdapters({ sslmode: 'require' }),
  })));
  redCases.push(await runRed('credential_from_argv', async () => {
    const env = {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      // no env/file credential
    };
    return evaluateLiveReadonlyBoundary({
      env,
      argv: ['node', 'prove', `--dsn=${GOOD_DSN}`],
      azureAdapters: goodAzure(),
      dbAdapters: goodDb(),
    });
  }));
  redCases.push(await runRed('credential_file_not_approved', async () => evaluateLiveReadonlyBoundary({
    env: dualEnv({
      [CREDENTIAL_ENV]: '',
      [CREDENTIAL_FILE_ENV]: path.join(FIX, 'slice14b-fake-dsn.txt'),
    }),
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
    readFileSync: () => GOOD_DSN,
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

  // GREEN: exact target + dual flags → accepted, still zero connect/query
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
    if (r.liveReadonlyConnectEnabled !== false) {
      throw new Error('connect must remain hard-disabled');
    }
    return { ok: true, ...r, azureCalls: greenAzureRec.total(), dbConnectInfoCalls: greenDbRec.count('connectInfo') };
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

  const leakScan = assertSecretFreeText(
    JSON.stringify({ green: redactDeep(green, [GOOD_DSN, FAKE_PASSWORD]), redCases }),
    [GOOD_DSN, FAKE_PASSWORD],
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
  if (assertNoSecretInArgv(['--dsn', GOOD_DSN], [GOOD_DSN]).ok !== false) {
    throw new Error('argv secret must be detected');
  }

  // Approved file path (injected read) GREEN source
  const fileGreen = await evaluateLiveReadonlyBoundary({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [CREDENTIAL_FILE_ENV]: `${APPROVED_CREDENTIAL_FILE_PREFIXES[0]}sunset-schema-observer-database-url`,
    },
    argv: ['node', 'prove'],
    azureAdapters: goodAzure(),
    dbAdapters: goodDb(),
    readFileSync: () => GOOD_DSN,
  });
  if (!fileGreen.accepted || fileGreen.counters.connectCalls !== 0) {
    throw new Error('approved file credential path must accept without connect');
  }

  const generatedAt = new Date().toISOString();

  const contract = {
    kind: 'sunset-schema-observer-slice14b-phase-d-live-readonly-boundary-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    liveApplyCapability: false,
    liveReadonlyConnectEnabled: false,
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
      'Hard-disabled live read-only connection boundary that can later run the merged 14A count-only preflight against exact Sunset staging PostgreSQL/database. Offline injected-adapter proof only in this slice.',
    targets: { ...TARGETS },
    credentialSources: {
      approvedEnv: CREDENTIAL_ENV,
      approvedFileEnv: CREDENTIAL_FILE_ENV,
      approvedFilePrefixes: APPROVED_CREDENTIAL_FILE_PREFIXES.slice(),
      forbidden: ['argv', 'output', 'evidence', 'committed_files'],
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
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14b-phase-d-live-readonly-boundary-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14B',
    outcome: 'phase_d_live_readonly_boundary_proven_offline_hard_disabled',
    stillProductSchemaDiffers: true,
    phaseDConstraintsApplied: false,
    liveMutation: false,
    liveReadonlyConnectEnabled: false,
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
      credentialFileNotApprovedRejected: true,
      firewallNetworkMutationRejected: true,
      unauthorizedSqlRejected: true,
      authorized14aCatalogAndAggregateOnly: true,
      countOnlySecretFree: true,
      liveAdapterFactoryHardDisabled: true,
      approvedFileCredentialAcceptedWithoutConnect: true,
    },
    redCases,
    greenCases: [
      {
        name: 'exact_target_dual_flags',
        ok: true,
        accepted: true,
        connectCalls: 0,
        queryCalls: 0,
        liveReadonlyConnectEnabled: false,
        code: green.code,
      },
      {
        name: 'approved_file_credential',
        ok: true,
        accepted: true,
        connectCalls: 0,
        queryCalls: 0,
        credentialSource: 'approved_file',
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
      'Slice 14B proves the hard-disabled live read-only boundary only. No live connect/query. Phase D CHECK ADD remains a later slice. Do not claim Sunset repaired.',
  };

  // Final secret scan on artifacts about to be written
  const artifactBlob = `${JSON.stringify(evidence)}${JSON.stringify(contract)}`;
  const finalScan = assertSecretFreeText(artifactBlob, [GOOD_DSN, FAKE_PASSWORD]);
  if (!finalScan.ok) throw new Error('evidence/contract would leak secrets');

  const findings = `# FOUNDATION Slice 14B — Phase D live read-only connection boundary

**Status:** complete (hard-disabled boundary; offline injected-adapter proof)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

Added a **hard-disabled** live read-only connection boundary that can later run the merged Slice **14A** count-only preflight against the exact Sunset staging PostgreSQL/database.

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

Credentials may come **only** from:

- approved env \`${CREDENTIAL_ENV}\`
- approved file path via \`${CREDENTIAL_FILE_ENV}\` under \`${APPROVED_CREDENTIAL_FILE_PREFIXES.join('` / `')}\`

Never from argv, output, evidence, or committed repository files.

### Query boundary

Only Slice **14A** catalog queries + its exact aggregate (plus session \`BEGIN READ ONLY\` / \`SHOW transaction_read_only\` / \`COMMIT\` / \`ROLLBACK\`) are authorized. Results/errors remain **count-only** and **secret-free**. 14A predicates are **unchanged**.

## Offline proof matrix (injected adapters)

| Case | Result |
|------|--------|
| Default path (no dual flags) | RED — zero connection calls |
| Exact target + dual flags | GREEN accept — connect still hard-disabled (0 connect/query) |
| Wrong subscription / RG / host / database / TLS | RED before connect |
| Credential from argv / non-approved file | RED before connect |
| Firewall/network mutation planned | RED |
| Unauthorized SQL | RED |
| 14A catalog + aggregate + session SQL | GREEN authorize |
| Live adapter factory | RED hard-disabled |

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

**Do not claim** Sunset is repaired. Phase D \`ADD CONSTRAINT\` is **not** implemented. Live connect/query against Sunset staging is **hard-disabled** in 14B. Zero live/Azure mutation. No firewall, ledger, migration, apply flag, or live evidence.

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
  const credSelf = resolveApprovedCredentials({ env: dualEnv(), argv: ['node'] });
  if (!credSelf.ok || credSelf.source !== 'approved_env') throw new Error('credential self-check failed');

  console.log('  PASS  default-path-zero-calls');
  console.log(`  PASS  red-cases (${redCases.length})`);
  console.log('  PASS  green-exact-target-dual-flags (connect hard-disabled)');
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
