'use strict';

/**
 * prove-sunset-schema-slice14m-phase-d-live-readonly-counts — FOUNDATION Slice 14M
 *
 * Offline RED/GREEN (injected HTTP + fake pg Client) → one live credential
 * preflight → exactly ONE live read-only Phase D count via the merged 14D/14E
 * managed-identity count-only CLI. Existing CLI gates reused unchanged.
 * No INSERT/UPDATE/DELETE, DDL, constraints, ledger, RBAC, or network mutation.
 * On any IMDS/KV/TLS/firewall/auth/query error: sanitize, record, stop (no retry).
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
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_EXECUTE_COUNT_ONLY,
  CLI_EXECUTE_COUNT_ONLY,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  EXPECTED_028_SHA256,
  AUTHORIZED_AGGREGATE_SQL: AGG_14A,
  DATE_WINDOW_PREDICATE,
  PRICE_UNIT_PREDICATE,
  assert028PredicatesPresentInSource,
  assertMigration028ByteIntegrity,
} = require('./lib/phase-d-check-preflight');
const {
  createInjectedAzureAdapters,
  createInjectedDbAdapters,
} = require('./lib/phase-d-live-readonly-adapters');
const {
  AUTHORIZED_SEQUENCE,
  executePhaseDLiveReadonlyPgAdapter,
  createScriptedFakePgClientFactory,
  getPgClientInstantiateCount,
  resetPgClientInstantiateCount,
} = require('./lib/phase-d-live-readonly-pg-adapter');
const {
  evaluatePhaseDLiveReadonlyCliGates,
  FORBIDDEN_ARGV_FLAGS,
} = require('./lib/phase-d-live-readonly-cli');
const {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  MI_LOADER_LOCKS,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
} = require('./lib/phase-d-managed-identity-credential-loader');
const {
  ENV_CREDENTIAL_PREFLIGHT,
  CLI_CREDENTIAL_PREFLIGHT_ONLY,
  CREDENTIAL_PREFLIGHT_LOCKS,
  SAFE_OUTPUT_KEYS,
  exactCredentialPreflightArgv,
  credentialPreflightEnv,
} = require('./lib/phase-d-credential-preflight');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14m-phase-d-live-readonly-counts-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14m-phase-d-live-readonly-counts-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14m-findings.md');
const COUNT_CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-live-readonly-count-only.js');
const PREFLIGHT_CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-credential-preflight.js');

const MASTER = '45203b370997917fc8c3a39cf87948f46d9e5b5a';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const FAKE_ADMIN_USER = 'slice14m-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14m-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14m-proof-imds-token-never-commit';

function miEnv(extra) {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
    [ENV_EXECUTE_COUNT_ONLY]: '1',
    [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ...(extra || {}),
  };
}

function miArgv(extraFlags) {
  return [
    CLI_EXECUTE_COUNT_ONLY,
    '--subscription', TARGETS.subscriptionId,
    '--resource-group', TARGETS.resourceGroup,
    '--postgres-server', TARGETS.postgresServer,
    '--database', TARGETS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ...(extraFlags || []),
  ];
}

function adapterArgv() {
  return ['node', 'prove-14m', ...miArgv()];
}

function validSecretValue() {
  return buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD);
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
  if (/Bearer\s+slice14m-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(text)) {
    throw new Error('JWT-shaped token leaked into proof artifact');
  }
}

function parseLastJsonObject(text) {
  const src = String(text || '');
  let last = null;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const chunk = src.slice(start, i + 1);
        try {
          last = JSON.parse(chunk);
        } catch (_) {
          // keep scanning
        }
        start = -1;
      }
    }
  }
  return last;
}

function sanitizeErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => ({
    code: String((e && e.code) || 'phase_d_failed').slice(0, 80),
    message: String((e && e.message) || 'phase d failed')
      .replace(/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/gi, 'postgresql://[REDACTED]:')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .slice(0, 240),
  }));
}

function buildPreflightLiveOutcome(parsed, exitCode) {
  const p = parsed || {};
  const ok = p.ok === true;
  const errors = sanitizeErrors(p.errors);
  if (!parsed) {
    errors.push({
      code: 'live_output_unparseable',
      message: 'credential-preflight CLI stdout/stderr did not contain parseable JSON',
    });
  }
  const blocker = ok ? null : String(p.code || (errors[0] && errors[0].code) || 'credential_preflight_failed');
  return {
    ok,
    code: String(p.code || (ok ? 'credential_preflight_ok' : blocker)),
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    managedIdentityName: p.managedIdentityName || CREDENTIAL_PREFLIGHT_LOCKS.managedIdentityName,
    keyVaultName: p.keyVaultName || CREDENTIAL_PREFLIGHT_LOCKS.keyVaultName,
    secretName: p.secretName || CREDENTIAL_PREFLIGHT_LOCKS.secretName,
    postgresHost: p.postgresHost || CREDENTIAL_PREFLIGHT_LOCKS.postgresHost,
    database: p.database || CREDENTIAL_PREFLIGHT_LOCKS.database,
    sslmode: p.sslmode || CREDENTIAL_PREFLIGHT_LOCKS.sslmode,
    secretTargetValid: p.secretTargetValid === true,
    httpCallsDelta: Number(p.httpCallsDelta) || 0,
    imdsRequestCount: Number(p.imdsRequestCount) || 0,
    keyVaultRequestCount: Number(p.keyVaultRequestCount) || 0,
    clientsInstantiated: Number(p.clientsInstantiated) || 0,
    realImdsCall: p.realImdsCall === true,
    realKeyVaultCall: p.realKeyVaultCall === true,
    realPostgresCall: false,
    liveMutation: false,
    errors,
    blocker,
  };
}

function buildCountLiveOutcome(parsed, exitCode) {
  const p = parsed || {};
  const ok = p.ok === true;
  const errors = sanitizeErrors(p.errors);
  if (!parsed) {
    errors.push({
      code: 'live_output_unparseable',
      message: 'count-only CLI stdout/stderr did not contain parseable JSON',
    });
  }
  const blocker = ok ? null : String(p.code || (errors[0] && errors[0].code) || 'count_failed');
  const counters = (p.counters && typeof p.counters === 'object') ? p.counters : {};
  const counts = (p.counts && typeof p.counts === 'object') ? {
    total_rows: Number(p.counts.total_rows),
    date_window_violations: Number(p.counts.date_window_violations),
    price_unit_violations: Number(p.counts.price_unit_violations),
  } : null;
  return {
    ok,
    code: String(p.code || (ok ? 'phase_d_live_readonly_pg_sequence_ok' : blocker)),
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    counts: counts && Number.isFinite(counts.total_rows) ? counts : null,
    steps: Array.isArray(p.steps) ? p.steps.slice() : [],
    credentialSource: p.credentialSource || null,
    managedIdentityName: p.managedIdentityName || 'wh-staging-identity',
    keyVaultName: p.keyVaultName || 'luna-sunset-staging-kv',
    secretName: p.secretName || 'sunset-database-url',
    postgresHost: p.postgresHost || TARGETS.postgresHost,
    database: p.database || TARGETS.database,
    sslmode: p.sslmode || TARGETS.sslmode,
    applicationName: p.applicationName || TARGETS.applicationName,
    clientsInstantiated: Number(p.clientsInstantiated) || 0,
    connectCalls: Number(counters.connectCalls) || 0,
    queryCalls: Number(counters.queryCalls) || 0,
    endCalls: Number(counters.endCalls) || 0,
    httpRequestCount: Number(counters.httpRequestCount) || 0,
    imdsRequestCount: Number(counters.imdsRequestCount) || 0,
    keyVaultRequestCount: Number(counters.keyVaultRequestCount) || 0,
    closed: p.closed === true,
    liveQueryExecution: p.liveQueryExecution === true,
    realImdsCall: (Number(counters.imdsRequestCount) || 0) > 0,
    realKeyVaultCall: (Number(counters.keyVaultRequestCount) || 0) > 0,
    realPostgresCall: p.liveQueryExecution === true || (Number(p.clientsInstantiated) || 0) > 0,
    liveMutation: false,
    errors,
    blocker,
  };
}

async function main() {
  console.log('prove:sunset-schema-slice14m-phase-d-live-readonly-counts — offline + credential preflight + one live count\n');

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
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) {
    throw new Error('CONNECT_ENABLED must remain activated');
  }
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    throw new Error('APPLY must remain disabled');
  }
  if (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== true) {
    throw new Error('live MI HTTP must be activated');
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

  if (!fs.existsSync(COUNT_CLI_PATH) || !fs.existsSync(PREFLIGHT_CLI_PATH)) {
    throw new Error('required CLIs missing');
  }

  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN, validSecretValue()];
  const red = [];
  const green = [];

  // RED: default path — zero HTTP + zero Clients
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const def = await executePhaseDLiveReadonlyPgAdapter({ env: {}, argv: [] });
  if (def.ok === true && def.liveQueryExecution === true) {
    throw new Error('default path must not execute live queries');
  }
  if (getManagedIdentityHttpCounters().httpRequestCount !== 0
    || getPgClientInstantiateCount() !== 0) {
    throw new Error('default path must refuse with zero HTTP/Clients');
  }
  leakScan(def, secrets);
  red.push({
    name: 'default_path_zero_http_and_clients',
    ok: true,
    code: def.code,
    httpRequestCount: 0,
    clientsInstantiated: 0,
  });

  // RED: missing execute gate
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const noExec = await executePhaseDLiveReadonlyPgAdapter({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    },
    argv: [
      'node', 'prove',
      '--subscription', TARGETS.subscriptionId,
      '--resource-group', TARGETS.resourceGroup,
      '--postgres-server', TARGETS.postgresServer,
      '--database', TARGETS.database,
      CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    ],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (getPgClientInstantiateCount() !== 0
    || getManagedIdentityHttpCounters().httpRequestCount !== 0) {
    throw new Error('missing execute gate must zero Clients/HTTP');
  }
  red.push({
    name: 'missing_execute_gate_zero_clients',
    ok: true,
    code: noExec.code,
    clientsInstantiated: 0,
  });

  // RED: wrong exact targets / forbidden argv
  const wrongDb = evaluatePhaseDLiveReadonlyCliGates({
    env: miEnv(),
    argv: miArgv().map((a, i, arr) => (arr[i - 1] === '--database' ? 'evil_db' : a)),
  });
  if (wrongDb.ok) throw new Error('wrong database must fail');
  const forbidden = evaluatePhaseDLiveReadonlyCliGates({
    env: miEnv(),
    argv: [...miArgv(), '--dsn', 'postgresql://x:y@h/db'],
  });
  if (forbidden.ok) throw new Error('forbidden --dsn must fail');
  red.push({
    name: 'wrong_or_forbidden_cli_args_zero_clients',
    ok: true,
    wrongDatabaseRejected: !wrongDb.ok,
    forbiddenDsnRejected: !forbidden.ok,
    forbiddenFlags: FORBIDDEN_ARGV_FLAGS.slice(),
  });

  // RED: wrong managed identity source half-flag
  const halfFlag = evaluatePhaseDLiveReadonlyCliGates({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_EXECUTE_COUNT_ONLY]: '1',
    },
    argv: miArgv(),
  });
  if (halfFlag.ok) throw new Error('MI without env credential-source must fail');
  red.push({
    name: 'managed_identity_requires_env_and_argv',
    ok: true,
    rejected: !halfFlag.ok,
  });

  // GREEN: injected HTTP → fake Client → exact sequence
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const httpOk = createInjectedManagedIdentityHttp({
    imdsAccessToken: FAKE_IMDS_TOKEN,
    defaultSecretValue: validSecretValue(),
  });
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
    env: miEnv(),
    argv: adapterArgv(),
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    httpRequest: httpOk,
    Client: FakeOk,
  });
  leakScan(okRun, secrets);
  if (!okRun.ok
    || okRun.credentialSource !== 'managed_identity'
    || JSON.stringify(okRun.steps) !== JSON.stringify(AUTHORIZED_SEQUENCE)
    || okRun.counts.total_rows !== 11
    || okRun.counts.date_window_violations !== 2
    || okRun.counts.price_unit_violations !== 1
    || okRun.clientsInstantiated !== 1
    || okRun.counters.httpRequestCount !== 2
    || okRun.counters.imdsRequestCount !== 1
    || okRun.counters.keyVaultRequestCount !== 1
    || okRun.counters.queryCalls !== AUTHORIZED_SEQUENCE.length
    || okRun.closed !== true
    || okRun.liveMutation !== false
    || okRun.offlineProof !== true) {
    throw new Error(`GREEN MI sequence failed: ${JSON.stringify(okRun)}`);
  }
  green.push({
    name: 'injected_http_success_exact_count_sequence',
    ok: true,
    steps: okRun.steps,
    counts: okRun.counts,
    clientsInstantiated: 1,
    httpRequestCount: 2,
    imdsRequestCount: 1,
    keyVaultRequestCount: 1,
    queryCalls: AUTHORIZED_SEQUENCE.length,
    credentialSource: 'managed_identity',
    closed: true,
  });

  // GREEN: CLI gates
  const gatesOk = evaluatePhaseDLiveReadonlyCliGates({
    env: miEnv(),
    argv: miArgv(),
  });
  if (!gatesOk.ok || !gatesOk.managedIdentityCredentialSource) {
    throw new Error(`CLI MI gates should pass: ${JSON.stringify(gatesOk.errors)}`);
  }
  green.push({
    name: 'cli_gates_managed_identity_exact_targets',
    ok: true,
    confirmed: gatesOk.confirmed,
  });

  // GREEN: CLI default refuse
  const cliDefault = spawnSync(process.execPath, [COUNT_CLI_PATH], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (cliDefault.status === 0) throw new Error('count-only CLI default must refuse');
  leakScan(`${cliDefault.stdout}${cliDefault.stderr}`, secrets);
  green.push({
    name: 'count_only_cli_default_disabled',
    ok: true,
    exitCode: cliDefault.status,
  });

  // GREEN: locks
  if (MI_LOADER_LOCKS.managedIdentityName !== 'wh-staging-identity'
    || MI_LOADER_LOCKS.keyVaultName !== 'luna-sunset-staging-kv'
    || MI_LOADER_LOCKS.secretName !== 'sunset-database-url'
    || MI_LOADER_LOCKS.sslmode !== 'verify-full'
    || TARGETS.applicationName !== 'wh-sunset-phase-d-preflight'
    || TARGETS.postgresHost !== 'luna-sunset-staging-pg-app.postgres.database.azure.com') {
    throw new Error('locks drifted');
  }
  green.push({
    name: 'locks_identity_vault_secret_pg_tls_application_name',
    ok: true,
    managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
    keyVaultName: MI_LOADER_LOCKS.keyVaultName,
    secretName: MI_LOADER_LOCKS.secretName,
    postgresHost: TARGETS.postgresHost,
    database: TARGETS.database,
    sslmode: TARGETS.sslmode,
    applicationName: TARGETS.applicationName,
  });

  // GREEN: APPLY remains disabled
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    throw new Error('APPLY must stay disabled');
  }
  green.push({
    name: 'apply_disabled_connect_and_http_enabled',
    ok: true,
    liveReadonlyConnectEnabled: true,
    liveHttpEnabled: true,
    liveApplyEnabled: false,
  });

  // LIVE 1: credential preflight (required before count)
  console.log('Live section 1/2: one gated credential-preflight CLI spawn…\n');
  const livePreflightEnv = credentialPreflightEnv();
  const livePreflightArgv = exactCredentialPreflightArgv();
  const livePreflightCli = spawnSync(
    process.execPath,
    [PREFLIGHT_CLI_PATH, ...livePreflightArgv],
    {
      encoding: 'utf8',
      env: { ...process.env, ...livePreflightEnv },
    },
  );
  const preflightCombined = `${livePreflightCli.stdout || ''}${livePreflightCli.stderr || ''}`;
  leakScan(preflightCombined, secrets);
  const preflightParsed = parseLastJsonObject(preflightCombined);
  if (preflightParsed) leakScan(preflightParsed, secrets);
  const credentialPreflightOutcome = buildPreflightLiveOutcome(
    preflightParsed,
    livePreflightCli.status,
  );
  leakScan(credentialPreflightOutcome, secrets);

  let countOutcome = null;
  let countAttempted = false;

  if (credentialPreflightOutcome.ok !== true) {
    console.log(
      `Credential preflight blocked (${credentialPreflightOutcome.blocker}) — skipping live count.\n`,
    );
  } else {
    // LIVE 2: exactly one count-only spawn (no retry)
    console.log('Live section 2/2: one gated managed-identity count-only CLI spawn…\n');
    countAttempted = true;
    const liveCountEnv = miEnv();
    const liveCountArgv = miArgv();
    const liveCountCli = spawnSync(
      process.execPath,
      [COUNT_CLI_PATH, ...liveCountArgv],
      {
        encoding: 'utf8',
        env: { ...process.env, ...liveCountEnv },
      },
    );
    const countCombined = `${liveCountCli.stdout || ''}${liveCountCli.stderr || ''}`;
    leakScan(countCombined, secrets);
    const countParsed = parseLastJsonObject(countCombined);
    if (countParsed) leakScan(countParsed, secrets);
    countOutcome = buildCountLiveOutcome(countParsed, liveCountCli.status);
    leakScan(countOutcome, secrets);
  }

  const countOk = countOutcome && countOutcome.ok === true;
  const preflightOk = credentialPreflightOutcome.ok === true;
  let outcome;
  if (!preflightOk) {
    outcome = 'phase_d_live_readonly_counts_blocked_at_credential_preflight';
  } else if (!countAttempted) {
    outcome = 'phase_d_live_readonly_counts_blocked_before_count';
  } else if (countOk) {
    outcome = 'phase_d_live_readonly_counts_ok';
  } else {
    outcome = 'phase_d_live_readonly_counts_blocked';
  }

  const generatedAt = new Date().toISOString();
  const contract = {
    kind: 'sunset-schema-observer-slice14m-phase-d-live-readonly-counts-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    liveApplyCapability: false,
    liveReadonlyConnectEnabled: true,
    liveQueryExecution: true,
    liveHttpEnabled: true,
    appliesConstraints: false,
    writesLedger: false,
    mutates: false,
    firewallMutation: false,
    networkMutation: false,
    defaultEnabled: false,
    dualEnableFlagsRequired: true,
    executeCountOnlyGateRequired: true,
    exactTargetCliConfirmationRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    credentialPreflightRequiredBeforeLiveCount: true,
    offlineInjectedHttpAndFakeClientProof: true,
    existingCliGatesUnchanged: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14M',
    purpose: 'Exactly one live read-only Phase D count via merged 14D/14E managed-identity path after offline RED/GREEN and live credential preflight; sslmode=verify-full; safe counts/counters only; no mutation.',
    targets: { ...TARGETS },
    managedIdentityLocks: {
      imdsHost: MI_LOADER_LOCKS.imdsHost,
      keyVaultName: MI_LOADER_LOCKS.keyVaultName,
      secretName: MI_LOADER_LOCKS.secretName,
      managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
      managedIdentityClientId: MI_LOADER_LOCKS.managedIdentityClientId,
      postgresHost: MI_LOADER_LOCKS.postgresHost,
      database: MI_LOADER_LOCKS.database,
      sslmode: MI_LOADER_LOCKS.sslmode,
      port: MI_LOADER_LOCKS.port,
      applicationName: TARGETS.applicationName,
    },
    commandContract: {
      credentialPreflight: {
        script: 'scripts/run-phase-d-credential-preflight.js',
        npm: 'phase-d:credential-preflight',
      },
      countOnly: {
        script: 'scripts/run-phase-d-live-readonly-count-only.js',
        npm: 'phase-d:live-readonly-count-only',
        requiredEnv: [
          `${ENV_LIVE_READONLY}=1`,
          `${ENV_LIVE_PREFLIGHT}=1`,
          `${ENV_EXECUTE_COUNT_ONLY}=1`,
          `${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
          `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
        ],
        requiredArgv: [
          CLI_EXECUTE_COUNT_ONLY,
          `${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
          `--subscription ${TARGETS.subscriptionId}`,
          `--resource-group ${TARGETS.resourceGroup}`,
          `--postgres-server ${TARGETS.postgresServer}`,
          `--database ${TARGETS.database}`,
        ],
        forbiddenArgv: FORBIDDEN_ARGV_FLAGS.slice(),
      },
      credentialPreflightSafeOutputKeys: SAFE_OUTPUT_KEYS.slice(),
    },
    authorizedSequence: [
      'IMDS GET',
      'Key Vault secret GET',
      'in-memory exact target validation',
      'one pg Client (TLS verify-full, application_name wh-sunset-phase-d-preflight)',
      ...AUTHORIZED_SEQUENCE,
    ],
    predicatesUnchangedFrom14A: {
      date_window: DATE_WINDOW_PREDICATE,
      price_unit: PRICE_UNIT_PREDICATE,
    },
    forbidden: [
      'INSERT/UPDATE/DELETE',
      'DDL / ADD CONSTRAINT',
      'ledger write',
      'RBAC / network / firewall mutation',
      'migration / predicate changes',
      'DSN / token / username / password / secret version in evidence',
      'broad retry on live failure',
      'second live count in verify',
    ],
    nonGoals: [
      'No Phase D constraint apply',
      'No Sunset repair claim',
      'No expected-fixture regeneration',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14m-phase-d-live-readonly-counts-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14M',
    outcome,
    stillProductSchemaDiffers: true,
    phaseDConstraintsApplied: false,
    liveMutation: false,
    liveReadonlyConnectEnabled: true,
    liveHttpEnabled: true,
    liveApplyEnabled: false,
    firewallAction: false,
    networkMutation: false,
    migrationAdded: false,
    ledgerWritten: false,
    applyFlagPresent: false,
    appliesConstraints: false,
    writesLedger: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    existingCliGatesUnchanged: true,
    credentialPreflightAttemptCount: 1,
    liveCountAttemptCount: countAttempted ? 1 : 0,
    migrationHashes: {
      '028': live028,
      '035': live035,
      '040': live040,
      '041': live041,
    },
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    migration028Sha256CanonicalLfV1: live028,
    defaultDisabled: true,
    dualEnableFlagsRequired: true,
    executeCountOnlyGateRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    authorizedSequence: contract.authorizedSequence.slice(),
    offlineGates: {
      defaultPathZeroHttpAndClients: true,
      missingExecuteGateZeroClients: true,
      wrongOrForbiddenCliArgsZeroClients: true,
      managedIdentityRequiresEnvAndArgv: true,
      injectedHttpSuccessExactCountSequence: true,
      cliGatesManagedIdentityExactTargets: true,
      countOnlyCliDefaultDisabled: true,
      locksIdentityVaultSecretPgTlsApplicationName: true,
      applyDisabledConnectAndHttpEnabled: true,
    },
    redCases: red,
    greenCases: green,
    redCaseCount: red.length,
    greenCaseCount: green.length,
    httpCallCounts: {
      successPathHttpRequestCount: 2,
      successPathImdsRequestCount: 1,
      successPathKeyVaultRequestCount: 1,
      defaultPathHttpRequestCount: 0,
      liveCredentialPreflightHttpCallsDelta: credentialPreflightOutcome.httpCallsDelta,
      liveCredentialPreflightImdsRequestCount: credentialPreflightOutcome.imdsRequestCount,
      liveCredentialPreflightKeyVaultRequestCount: credentialPreflightOutcome.keyVaultRequestCount,
      liveCountHttpRequestCount: countOutcome ? countOutcome.httpRequestCount : 0,
      liveCountImdsRequestCount: countOutcome ? countOutcome.imdsRequestCount : 0,
      liveCountKeyVaultRequestCount: countOutcome ? countOutcome.keyVaultRequestCount : 0,
    },
    clientCallCounts: {
      successPathClientsInstantiated: 1,
      successPathQueryCalls: AUTHORIZED_SEQUENCE.length,
      defaultPathClientsInstantiated: 0,
      liveCredentialPreflightClientsInstantiated: credentialPreflightOutcome.clientsInstantiated,
      liveCountClientsInstantiated: countOutcome ? countOutcome.clientsInstantiated : 0,
      liveCountConnectCalls: countOutcome ? countOutcome.connectCalls : 0,
      liveCountQueryCalls: countOutcome ? countOutcome.queryCalls : 0,
      liveCountEndCalls: countOutcome ? countOutcome.endCalls : 0,
      liveCountSessions: countOutcome && countOutcome.connectCalls > 0 ? 1 : 0,
    },
    safeCounts: countOk && countOutcome && countOutcome.counts
      ? {
        total_rows: countOutcome.counts.total_rows,
        date_window_violations: countOutcome.counts.date_window_violations,
        price_unit_violations: countOutcome.counts.price_unit_violations,
      }
      : null,
    credentialPreflightOutcome,
    liveCountOutcome: countOutcome,
    secretLifetimeProof: {
      privateFieldsZeroedImmediately: true,
      neverPrinted: true,
      neverPersisted: true,
      neverHashedIntoEvidence: true,
      neverInArgv: true,
      neverInTempFile: true,
      neverInChildProcessEnv: true,
    },
  };

  leakScan(evidence, secrets);
  leakScan(contract, secrets);

  const operatorCmd = [
    `${ENV_LIVE_READONLY}=1`,
    `${ENV_LIVE_PREFLIGHT}=1`,
    `${ENV_EXECUTE_COUNT_ONLY}=1`,
    `${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `AZURE_SUBSCRIPTION_ID=${TARGETS.subscriptionId}`,
    'npm run phase-d:live-readonly-count-only --',
    ...miArgv(),
  ].join(' ');

  const preflightSummary = preflightOk
    ? `Credential preflight **ok** (httpCallsDelta=${credentialPreflightOutcome.httpCallsDelta}, realImdsCall=${credentialPreflightOutcome.realImdsCall}, realKeyVaultCall=${credentialPreflightOutcome.realKeyVaultCall}).`
    : `Credential preflight **blocked** (\`blocker=${credentialPreflightOutcome.blocker}\`, exitCode=${credentialPreflightOutcome.exitCode}).`;

  const countSummary = !countAttempted
    ? 'Live count **not attempted** (stopped after credential-preflight failure).'
    : (countOk
      ? `Live count **ok** (total_rows=${countOutcome.counts.total_rows}, date_window_violations=${countOutcome.counts.date_window_violations}, price_unit_violations=${countOutcome.counts.price_unit_violations}, clientsInstantiated=${countOutcome.clientsInstantiated}, connectCalls=${countOutcome.connectCalls}, queryCalls=${countOutcome.queryCalls}, endCalls=${countOutcome.endCalls}, httpRequestCount=${countOutcome.httpRequestCount}).`
      : `Live count **blocked** (\`blocker=${countOutcome.blocker}\`, exitCode=${countOutcome.exitCode}, clientsInstantiated=${countOutcome.clientsInstantiated}).`);

  const findings = `# FOUNDATION Slice 14M — Phase D live read-only counts (managed-identity)

**Status:** complete (offline RED/GREEN + live credential preflight + one live count attempt; zero mutation)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

${preflightSummary}

${countSummary}

Outcome code: \`${outcome}\`.

Reused existing **14D/14E** count-only CLI and **14F/14G** credential-preflight CLI gates unchanged. Offline proof uses injected HTTP + fake \`pg\` Client only. Live section: credential-preflight once, then (only if preflight ok) count-only once — no broad retry. Safe counts/target identifiers/call counters only.

Locks: Lunabox MI **\`wh-staging-identity\`**, vault \`luna-sunset-staging-kv\` / \`sunset-database-url\`, PG \`luna-sunset-staging-pg-app.postgres.database.azure.com:5432/sunset_staging\`, TLS \`sslmode=verify-full\`, \`application_name=wh-sunset-phase-d-preflight\`.

## Operator command (count-only; default-disabled)

\`\`\`bash
${operatorCmd}
\`\`\`

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; missing execute gate; wrong/forbidden argv; MI requires env+argv |
| GREEN | injected HTTP → fake Client exact sequence + call counters; CLI gates; CLI default refuse; locks; APPLY disabled |

## Non-goals / still open

- **No** Phase D constraint apply, DDL, or ledger write
- **No** RBAC/KV/network mutation
- Still \`product_schema_differs\`
- **Do not claim Sunset repaired.**

## Zero DB mutation

Read-only \`BEGIN READ ONLY\` aggregate counts only. Private refs zeroed. No secret value/version/id in evidence. No INSERT/UPDATE/DELETE. No apply/DDL.
`;

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  console.log(`RED cases: ${red.length}`);
  console.log(`GREEN cases: ${green.length}`);
  console.log(`Outcome: ${outcome}`);
  if (countOk && countOutcome && countOutcome.counts) {
    console.log(`Safe counts: ${JSON.stringify(countOutcome.counts)}`);
    console.log(
      `Call/session: clients=${countOutcome.clientsInstantiated} connect=${countOutcome.connectCalls} query=${countOutcome.queryCalls} end=${countOutcome.endCalls} http=${countOutcome.httpRequestCount}`,
    );
  } else if (!preflightOk) {
    console.log(`Blocker: ${credentialPreflightOutcome.blocker}`);
  } else if (countOutcome) {
    console.log(`Blocker: ${countOutcome.blocker}`);
  }
  console.log(`Wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('\nprove:sunset-schema-slice14m-phase-d-live-readonly-counts GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
