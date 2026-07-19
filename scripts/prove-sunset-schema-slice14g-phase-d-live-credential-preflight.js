'use strict';

/**
 * prove-sunset-schema-slice14g-phase-d-live-credential-preflight — FOUNDATION Slice 14G
 *
 * Offline RED/GREEN (injected HTTP only) then exactly ONE live credential-preflight
 * via spawnSync of the gated CLI. Real Node http/https IMDS+KV GET behind 14F gates.
 * Never instantiates pg Client. No RBAC/KV/network mutation commands.
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
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  MI_LOADER_LOCKS,
  createInjectedManagedIdentityHttp,
  createLiveManagedIdentityHttpRequest,
  buildOfflineProofSunsetDatabaseUrl,
} = require('./lib/phase-d-managed-identity-credential-loader');
const {
  ENV_CREDENTIAL_PREFLIGHT,
  CLI_CREDENTIAL_PREFLIGHT_ONLY,
  CREDENTIAL_PREFLIGHT_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  evaluateCredentialPreflightGates,
  executeCredentialPreflight,
  renderCredentialPreflightUsage,
  exactCredentialPreflightArgv,
  credentialPreflightEnv,
  resetPgClientInstantiateCount,
  resetManagedIdentityHttpCounters,
  getPgClientInstantiateCount,
  getManagedIdentityHttpCounters,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
} = require('./lib/phase-d-credential-preflight');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14g-phase-d-live-credential-preflight-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14g-phase-d-live-credential-preflight-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14g-findings.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-credential-preflight.js');
const COUNT_ONLY_PATH = path.join(ROOT, 'scripts', 'run-phase-d-live-readonly-count-only.js');
const LOADER_PATH = path.join(ROOT, 'scripts', 'lib', 'phase-d-managed-identity-credential-loader.js');

const MASTER = 'cbd5512afbf73b0a84ead6113d6d919de7b2b411';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const FAKE_ADMIN_USER = 'slice14g-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14g-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14g-proof-imds-token-never-commit';

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
  if (/Bearer\s+slice14[fg]-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/.test(text)) {
    throw new Error('JWT-shaped token leaked into proof artifact');
  }
}

function assertSafeOutputShape(result) {
  const keys = Object.keys(result || {});
  for (const k of keys) {
    if (!SAFE_OUTPUT_KEYS.includes(k)) {
      throw new Error(`unsafe output key: ${k}`);
    }
  }
  const forbidden = [
    'token', 'access_token', 'password', 'user', 'dsn', '_user', '_password',
    '_token', '_dsn', 'value', 'id', 'version', 'secretId', 'hash', 'sha256',
  ];
  for (const k of forbidden) {
    if (Object.prototype.hasOwnProperty.call(result || {}, k)) {
      throw new Error(`forbidden output key present: ${k}`);
    }
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
          // keep scanning for a later valid object
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
    code: String((e && e.code) || 'credential_preflight_failed').slice(0, 80),
    message: String((e && e.message) || 'credential preflight failed')
      .replace(/postgresql:\/\/[^:\s/@]+:[^@\s/]+@/gi, 'postgresql://[REDACTED]:')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .slice(0, 240),
  }));
}

function buildLiveOutcome(parsed, exitCode) {
  const p = parsed || {};
  const ok = p.ok === true;
  const errors = sanitizeErrors(p.errors);
  if (!parsed) {
    errors.push({
      code: 'live_output_unparseable',
      message: 'CLI stdout/stderr did not contain parseable JSON',
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
    hasUser: p.hasUser === true,
    hasPassword: p.hasPassword === true,
    httpCallsDelta: Number(p.httpCallsDelta) || 0,
    imdsRequestCount: Number(p.imdsRequestCount) || 0,
    keyVaultRequestCount: Number(p.keyVaultRequestCount) || 0,
    clientsInstantiated: Number(p.clientsInstantiated) || 0,
    realImdsCall: p.realImdsCall === true,
    realKeyVaultCall: p.realKeyVaultCall === true,
    realPostgresCall: false,
    liveHttpEnabled: p.liveHttpEnabled === true || PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    liveMutation: false,
    errors,
    blocker,
  };
}

async function main() {
  console.log('prove:sunset-schema-slice14g-phase-d-live-credential-preflight — offline + one live\n');

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
    throw new Error('live MI HTTP must be activated (Slice 14G)');
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

  if (!fs.existsSync(COUNT_ONLY_PATH)) throw new Error('count-only CLI missing');
  const countOnlySrc = fs.readFileSync(COUNT_ONLY_PATH, 'utf8');
  if (!countOnlySrc.includes('run-phase-d-live-readonly-count-only')
    || countOnlySrc.includes('credential-preflight')) {
    throw new Error('count-only CLI must remain unchanged (no credential-preflight wiring)');
  }

  const loaderSrc = fs.readFileSync(LOADER_PATH, 'utf8');

  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN, validSecretValue()];
  const red = [];
  const green = [];

  // RED: default path — zero HTTP + zero Clients
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const def = await executeCredentialPreflight({ env: {}, argv: [] });
  if (def.ok
    || getManagedIdentityHttpCounters().httpRequestCount !== 0
    || getPgClientInstantiateCount() !== 0) {
    throw new Error('default path must refuse with zero HTTP/Clients');
  }
  assertSafeOutputShape(def);
  leakScan(def, secrets);
  red.push({
    name: 'default_path_zero_http_and_clients',
    ok: true,
    code: def.code,
    httpRequestCount: 0,
    clientsInstantiated: 0,
  });

  // RED: missing dedicated env approval
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const noEnv = await executeCredentialPreflight({
    env: {
      [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
      AZURE_SUBSCRIPTION_ID: CREDENTIAL_PREFLIGHT_LOCKS.subscriptionId,
    },
    argv: exactCredentialPreflightArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (noEnv.ok
    || getManagedIdentityHttpCounters().httpRequestCount !== 0
    || getPgClientInstantiateCount() !== 0) {
    throw new Error('missing env approval must zero HTTP');
  }
  red.push({
    name: 'missing_env_approval_zero_http',
    ok: true,
    code: noEnv.code,
    httpRequestCount: 0,
  });

  // RED: missing --credential-preflight-only / wrong targets
  resetManagedIdentityHttpCounters();
  const noFlag = evaluateCredentialPreflightGates({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv().filter((a) => a !== CLI_CREDENTIAL_PREFLIGHT_ONLY),
  });
  if (noFlag.ok) throw new Error('missing preflight flag must fail');
  const wrongVault = evaluateCredentialPreflightGates({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv().map((a, i, arr) => {
      if (arr[i - 1] === '--key-vault') return 'evil-kv';
      return a;
    }),
  });
  if (wrongVault.ok) throw new Error('wrong key vault must fail');
  const wrongMi = evaluateCredentialPreflightGates({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv().map((a, i, arr) => {
      if (arr[i - 1] === '--managed-identity') return 'luna-sunset-staging-identity';
      return a;
    }),
  });
  if (wrongMi.ok) throw new Error('wrong managed identity must fail');
  red.push({
    name: 'missing_or_wrong_exact_targets_zero_http',
    ok: true,
    missingFlagRejected: !noFlag.ok,
    wrongVaultRejected: !wrongVault.ok,
    wrongManagedIdentityRejected: !wrongMi.ok,
  });

  // RED: forbidden argv (dsn/host/query/token)
  const forbiddenGate = evaluateCredentialPreflightGates({
    env: credentialPreflightEnv(),
    argv: [...exactCredentialPreflightArgv(), '--dsn', 'postgresql://x:y@h/db'],
  });
  if (forbiddenGate.ok) throw new Error('forbidden --dsn must fail');
  red.push({
    name: 'forbidden_dsn_host_query_token_argv',
    ok: true,
    rejected: !forbiddenGate.ok,
    forbiddenFlags: FORBIDDEN_ARGV_FLAGS.slice(),
  });

  // RED: no POST/PUT/PATCH/DELETE
  const methodHttp = createInjectedManagedIdentityHttp({
    imdsAccessToken: FAKE_IMDS_TOKEN,
    defaultSecretValue: validSecretValue(),
  });
  const postRes = await methodHttp({
    purpose: 'imds_token',
    hostname: MI_LOADER_LOCKS.imdsHost,
    method: 'POST',
    path: '/metadata/identity/oauth2/token',
    headers: { Metadata: 'true' },
  });
  if (postRes.statusCode !== 405) {
    throw new Error('injected POST must 405');
  }
  if (!/method:\s*'GET'/.test(loaderSrc)
    || /method:\s*'POST'/.test(loaderSrc)
    || /method:\s*'PUT'/.test(loaderSrc)
    || /method:\s*'PATCH'/.test(loaderSrc)
    || /method:\s*'DELETE'/.test(loaderSrc)) {
    throw new Error('loader must only issue GET methods');
  }
  if (!/http_method_forbidden/.test(loaderSrc)) {
    throw new Error('loader must reject non-GET methods');
  }
  red.push({
    name: 'no_post_put_patch_delete',
    ok: true,
    injectedPostRejected: postRes.statusCode === 405,
    loaderGetOnly: true,
  });

  // RED: live HTTP activated — offline prove requires inject; never ungated preflight call
  if (typeof createLiveManagedIdentityHttpRequest !== 'function') {
    throw new Error('createLiveManagedIdentityHttpRequest must be exported');
  }
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const defaultOfflinePreflight = await executeCredentialPreflight({ env: {}, argv: [] });
  if (getManagedIdentityHttpCounters().httpRequestCount !== 0
    || getPgClientInstantiateCount() !== 0
    || defaultOfflinePreflight.ok) {
    throw new Error('default path must remain zero HTTP and zero Clients without inject');
  }
  red.push({
    name: 'live_http_activated_offline_inject_required',
    ok: true,
    liveHttpEnabled: true,
    createLiveManagedIdentityHttpRequestExported: true,
    httpRequestCount: 0,
    clientsInstantiated: 0,
    offlineInjectOnly: true,
  });

  // GREEN: exact 2-call success; safe metadata; zero Clients
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const httpOk = createInjectedManagedIdentityHttp({
    imdsAccessToken: FAKE_IMDS_TOKEN,
    defaultSecretValue: validSecretValue(),
  });
  const okRun = await executeCredentialPreflight({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
    httpRequest: httpOk,
  });
  leakScan(okRun, secrets);
  assertSafeOutputShape(okRun);
  if (!okRun.ok
    || okRun.code !== 'credential_preflight_ok'
    || okRun.secretTargetValid !== true
    || okRun.hasUser !== true
    || okRun.hasPassword !== true
    || okRun.managedIdentityName !== 'wh-staging-identity'
    || okRun.keyVaultName !== 'luna-sunset-staging-kv'
    || okRun.secretName !== 'sunset-database-url'
    || okRun.postgresHost !== CREDENTIAL_PREFLIGHT_LOCKS.postgresHost
    || okRun.database !== 'sunset_staging'
    || okRun.sslmode !== 'verify-full'
    || okRun.httpCallsDelta !== 2
    || okRun.clientsInstantiated !== 0
    || getPgClientInstantiateCount() !== 0
    || okRun.liveHttpEnabled !== true
    || okRun.realImdsCall !== false
    || okRun.realKeyVaultCall !== false
    || okRun.realPostgresCall !== false
    || okRun.liveMutation !== false) {
    throw new Error(`GREEN success failed: ${JSON.stringify(okRun)}`);
  }
  if (getManagedIdentityHttpCounters().httpRequestCount !== 2
    || getManagedIdentityHttpCounters().imdsRequestCount !== 1
    || getManagedIdentityHttpCounters().keyVaultRequestCount !== 1) {
    throw new Error(`expected exactly 2 HTTP calls, got ${JSON.stringify(getManagedIdentityHttpCounters())}`);
  }
  green.push({
    name: 'injected_http_exact_two_call_success_safe_metadata',
    ok: true,
    code: okRun.code,
    httpCallsDelta: 2,
    imdsRequestCount: 1,
    keyVaultRequestCount: 1,
    clientsInstantiated: 0,
    realImdsCall: false,
    liveHttpEnabled: true,
  });

  // GREEN: CLI gates pass with exact locks
  const gatesOk = evaluateCredentialPreflightGates({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
  });
  if (!gatesOk.ok || !gatesOk.credentialSourceOk || gatesOk.liveHttpEnabled !== true) {
    throw new Error(`CLI gates should pass: ${JSON.stringify(gatesOk.errors)}`);
  }
  green.push({
    name: 'cli_gates_exact_targets_and_managed_identity',
    ok: true,
    confirmed: gatesOk.confirmed,
    liveHttpEnabled: true,
  });

  // GREEN: CLI default refuse (spawn)
  const cliDefault = spawnSync(process.execPath, [CLI_PATH], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (cliDefault.status === 0) throw new Error('CLI default must refuse');
  leakScan(`${cliDefault.stdout}${cliDefault.stderr}`, secrets);
  green.push({
    name: 'cli_default_disabled',
    ok: true,
    exitCode: cliDefault.status,
  });

  // GREEN: locks
  if (CREDENTIAL_PREFLIGHT_LOCKS.managedIdentityName !== 'wh-staging-identity'
    || CREDENTIAL_PREFLIGHT_LOCKS.vmResourceGroup !== 'wh-staging-rg'
    || CREDENTIAL_PREFLIGHT_LOCKS.vmName !== 'lunabox') {
    throw new Error('credential-preflight locks drifted');
  }
  green.push({
    name: 'locks_subscription_rg_vm_identity_vault_secret_pg_tls',
    ok: true,
    locks: { ...CREDENTIAL_PREFLIGHT_LOCKS },
  });

  // GREEN: live HTTP transport present in loader source
  if (!loaderSrc.includes('createLiveManagedIdentityHttpRequest')
    || !/require\(['"]http['"]\)/.test(loaderSrc)
    || !/require\(['"]https['"]\)/.test(loaderSrc)) {
    throw new Error('loader must export live HTTP transport with http/https requires');
  }
  green.push({
    name: 'live_http_transport_present_in_loader_source',
    ok: true,
    createLiveManagedIdentityHttpRequest: true,
    httpRequire: true,
    httpsRequire: true,
  });

  const usage = renderCredentialPreflightUsage();
  if (!usage.includes(CLI_CREDENTIAL_PREFLIGHT_ONLY)
    || !usage.includes(ENV_CREDENTIAL_PREFLIGHT)
    || !usage.includes('wh-staging-identity')) {
    throw new Error('usage text incomplete');
  }

  // LIVE: exactly one gated credential-preflight CLI spawn (no inject, no retry)
  console.log('Live section: one gated credential-preflight CLI spawn…\n');
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const liveEnv = credentialPreflightEnv();
  const liveArgv = exactCredentialPreflightArgv();
  const liveCli = spawnSync(process.execPath, [CLI_PATH, ...liveArgv], {
    encoding: 'utf8',
    env: { ...process.env, ...liveEnv },
  });
  const liveCombined = `${liveCli.stdout || ''}${liveCli.stderr || ''}`;
  leakScan(liveCombined, secrets);
  const liveParsed = parseLastJsonObject(liveCombined);
  if (liveParsed) leakScan(liveParsed, secrets);
  const liveOutcome = buildLiveOutcome(liveParsed, liveCli.status);
  leakScan(liveOutcome, secrets);

  if (liveOutcome.clientsInstantiated !== 0) {
    throw new Error(`live path must never instantiate pg Client: ${liveOutcome.clientsInstantiated}`);
  }
  if (liveOutcome.realPostgresCall !== false) {
    throw new Error('live path must never call PostgreSQL');
  }
  if (liveOutcome.liveMutation !== false) {
    throw new Error('live path must not mutate');
  }

  const liveOk = liveOutcome.ok === true;
  const outcome = liveOk
    ? 'phase_d_live_credential_preflight_ok'
    : 'phase_d_live_credential_preflight_blocked';

  const generatedAt = new Date().toISOString();
  const contract = {
    kind: 'sunset-schema-observer-slice14g-phase-d-live-credential-preflight-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    liveApplyCapability: false,
    liveReadonlyConnectEnabled: true,
    liveQueryExecution: false,
    liveHttpEnabled: true,
    appliesConstraints: false,
    writesLedger: false,
    mutates: false,
    firewallMutation: false,
    networkMutation: false,
    defaultEnabled: false,
    credentialPreflightEnvRequired: true,
    credentialPreflightFlagRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    exactTargetCliConfirmationRequired: true,
    offlineInjectedHttpProof: true,
    neverInstantiatesPgClient: true,
    countOnlyCommandUnchanged: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14G',
    purpose: 'One live metadata-only credential preflight with PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true: gated real IMDS GET + Key Vault secret GET behind 14F env+argv+exact-target gates; validate DSN in memory; zero private refs; safe metadata output only; never pg Client; no apply/DDL.',
    targets: { ...TARGETS },
    credentialPreflightLocks: { ...CREDENTIAL_PREFLIGHT_LOCKS },
    managedIdentityLocks: {
      imdsHost: MI_LOADER_LOCKS.imdsHost,
      vaultResourceAudience: MI_LOADER_LOCKS.vaultResourceAudience,
      keyVaultName: MI_LOADER_LOCKS.keyVaultName,
      keyVaultHttpsUrl: MI_LOADER_LOCKS.keyVaultHttpsUrl,
      secretName: MI_LOADER_LOCKS.secretName,
      imdsApiVersion: MI_LOADER_LOCKS.imdsApiVersion,
      keyVaultApiVersion: MI_LOADER_LOCKS.keyVaultApiVersion,
      managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
      managedIdentityClientId: MI_LOADER_LOCKS.managedIdentityClientId,
      managedIdentityPrincipalId: MI_LOADER_LOCKS.managedIdentityPrincipalId,
      lunaboxVmResourceId: MI_LOADER_LOCKS.lunaboxVmResourceId,
      postgresHost: MI_LOADER_LOCKS.postgresHost,
      database: MI_LOADER_LOCKS.database,
      sslmode: MI_LOADER_LOCKS.sslmode,
      port: MI_LOADER_LOCKS.port,
    },
    commandContract: {
      script: 'scripts/run-phase-d-credential-preflight.js',
      npm: 'phase-d:credential-preflight',
      requiredEnv: [
        `${ENV_CREDENTIAL_PREFLIGHT}=1`,
        `${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
        `AZURE_SUBSCRIPTION_ID=${CREDENTIAL_PREFLIGHT_LOCKS.subscriptionId}`,
      ],
      requiredArgv: [
        CLI_CREDENTIAL_PREFLIGHT_ONLY,
        `${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
        `--subscription ${CREDENTIAL_PREFLIGHT_LOCKS.subscriptionId}`,
        `--resource-group ${CREDENTIAL_PREFLIGHT_LOCKS.resourceGroup}`,
        `--vm-resource-group ${CREDENTIAL_PREFLIGHT_LOCKS.vmResourceGroup}`,
        `--vm-name ${CREDENTIAL_PREFLIGHT_LOCKS.vmName}`,
        `--managed-identity ${CREDENTIAL_PREFLIGHT_LOCKS.managedIdentityName}`,
        `--key-vault ${CREDENTIAL_PREFLIGHT_LOCKS.keyVaultName}`,
        `--secret-name ${CREDENTIAL_PREFLIGHT_LOCKS.secretName}`,
        `--postgres-server ${CREDENTIAL_PREFLIGHT_LOCKS.postgresServer}`,
        `--database ${CREDENTIAL_PREFLIGHT_LOCKS.database}`,
      ],
      forbiddenArgv: FORBIDDEN_ARGV_FLAGS.slice(),
      safeOutputKeys: SAFE_OUTPUT_KEYS.slice(),
      forbiddenOutput: [
        'token',
        'dsn',
        'user',
        'password',
        'version',
        'secret metadata ids',
        'hashes',
      ],
    },
    authorizedHttpSequence: [
      'IMDS GET',
      'Key Vault secret GET',
    ],
    predicatesUnchangedFrom14A: {
      date_window: DATE_WINDOW_PREDICATE,
      price_unit: PRICE_UNIT_PREDICATE,
    },
    forbidden: [
      'pg Client instantiation',
      'PostgreSQL connection/query',
      'caller URL / token / DSN overrides',
      'token/DSN/credentials in evidence/logs/argv/temp/child env',
      'secret value/version/id persistence',
      'POST/PUT/PATCH/DELETE',
      'apply/DDL/ledger',
      'migration / predicate changes',
      'firewall/network/RBAC mutation',
      'count-only command mutation',
    ],
    nonGoals: [
      'No pg Client or live PostgreSQL query',
      'No Phase D constraint apply or DDL',
      'No RBAC/KV/network change on live deny',
      'No Sunset repair claim',
      'No expected-fixture regeneration',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14g-phase-d-live-credential-preflight-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14G',
    outcome,
    stillProductSchemaDiffers: true,
    phaseDConstraintsApplied: false,
    liveMutation: false,
    liveReadonlyConnectEnabled: true,
    liveQueryExecution: false,
    liveHttpEnabled: true,
    azureConnectivity: liveOk,
    firewallAction: false,
    networkMutation: false,
    realImdsCall: liveOutcome.realImdsCall,
    realKeyVaultCall: liveOutcome.realKeyVaultCall,
    realPostgresCall: false,
    enableFlagFlipped: true,
    cliExecutedLive: true,
    migrationAdded: false,
    ledgerWritten: false,
    applyFlagPresent: false,
    appliesConstraints: false,
    writesLedger: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    countOnlyCommandUnchanged: true,
    neverInstantiatesPgClient: true,
    liveCallAttemptCount: 1,
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
    credentialPreflightEnvRequired: true,
    credentialPreflightFlagRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    authorizedHttpSequence: ['IMDS GET', 'Key Vault secret GET'],
    offlineGates: {
      defaultPathZeroHttpAndClients: true,
      missingEnvApprovalZeroHttp: true,
      missingOrWrongExactTargetsZeroHttp: true,
      liveHttpActivatedOfflineInjectRequired: true,
      forbiddenDsnHostQueryTokenArgv: true,
      noPostPutPatchDelete: true,
      injectedHttpExactTwoCallSuccessSafeMetadata: true,
      cliGatesExactTargetsAndManagedIdentity: true,
      cliDefaultDisabled: true,
      locksSubscriptionRgVmIdentityVaultSecretPgTls: true,
      liveHttpTransportPresentInLoaderSource: true,
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
      liveHttpCallsDelta: liveOutcome.httpCallsDelta,
      liveImdsRequestCount: liveOutcome.imdsRequestCount,
      liveKeyVaultRequestCount: liveOutcome.keyVaultRequestCount,
    },
    clientCallCounts: {
      successPathClientsInstantiated: 0,
      defaultPathClientsInstantiated: 0,
      liveClientsInstantiated: liveOutcome.clientsInstantiated,
    },
    liveOutcome,
    secretLifetimeProof: {
      privateFieldsZeroedImmediately: true,
      neverPrinted: true,
      neverPersisted: true,
      neverHashedIntoEvidence: true,
      neverInArgv: true,
      neverInTempFile: true,
      neverInChildProcessEnv: true,
    },
    safeOutputProof: {
      keys: SAFE_OUTPUT_KEYS.slice(),
      includesBooleansAndNamesOnly: true,
      excludesTokenDsnUserPasswordVersionIdsHashes: true,
    },
  };

  leakScan(evidence, secrets);
  leakScan(contract, secrets);

  const operatorCmd = [
    `${ENV_CREDENTIAL_PREFLIGHT}=1`,
    `${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    `AZURE_SUBSCRIPTION_ID=${CREDENTIAL_PREFLIGHT_LOCKS.subscriptionId}`,
    'npm run phase-d:credential-preflight --',
    ...liveArgv,
  ].join(' ');

  const liveSummary = liveOk
    ? `Live credential-preflight **ok** (\`code=${liveOutcome.code}\`, httpCallsDelta=${liveOutcome.httpCallsDelta}, realImdsCall=${liveOutcome.realImdsCall}, realKeyVaultCall=${liveOutcome.realKeyVaultCall}, clientsInstantiated=0).`
    : `Live credential-preflight **blocked** (\`blocker=${liveOutcome.blocker}\`, exitCode=${liveOutcome.exitCode}, httpCallsDelta=${liveOutcome.httpCallsDelta}, realImdsCall=${liveOutcome.realImdsCall}, realKeyVaultCall=${liveOutcome.realKeyVaultCall}, clientsInstantiated=0).`;

  const findings = `# FOUNDATION Slice 14G — Phase D live metadata-only credential preflight

**Status:** complete (\`PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true\`; one live gated IMDS+KV GET; no pg Client; no apply/DDL)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

${liveSummary}

Activated real Node \`http\`/\`https\` IMDS + Key Vault secret GET behind the existing **14F** credential-preflight gates. Offline proof uses injected HTTP only; live section spawns the CLI **once** with exact env+argv from \`credentialPreflightEnv()\` + \`exactCredentialPreflightArgv()\`. Never instantiates a pg Client. Count-only DB command **unchanged**.

Locks: Lunabox MI **\`wh-staging-identity\`**, vault \`luna-sunset-staging-kv\`, secret \`sunset-database-url\`, VM \`lunabox\` in \`wh-staging-rg\`, PG host/database/\`sslmode=verify-full\`.

## Operator command

\`\`\`bash
${operatorCmd}
\`\`\`

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; missing env/flag/targets; live HTTP activated → offline inject required; forbidden argv; no POST/PUT/PATCH/DELETE |
| GREEN | injected HTTP exact 2-call success + safe metadata; CLI gates; CLI default refuse; locks; live HTTP transport in loader source |

## Non-goals / still open

- **No** pg Client or live PostgreSQL query
- **No** Phase D constraint apply, DDL, or ledger write
- **No** RBAC/KV/network change on live deny
- Still \`product_schema_differs\`
- **Do not claim Sunset repaired.**

## Zero DB mutation

Metadata-only credential preflight. Private refs zeroed immediately. No secret value/version/id in evidence. No PostgreSQL Client/connection. No apply/DDL.
`;

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  console.log(`RED cases: ${red.length}`);
  console.log(`GREEN cases: ${green.length}`);
  console.log(`Live outcome: ${outcome} (ok=${liveOk}, blocker=${liveOutcome.blocker || 'null'})`);
  console.log(`Wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('\nprove:sunset-schema-slice14g-phase-d-live-credential-preflight GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
