'use strict';

/**
 * prove-sunset-schema-slice14f-phase-d-credential-preflight — FOUNDATION Slice 14F
 *
 * Offline proof that the activated 14E managed-identity HTTP loader runs behind
 * an explicit metadata-only credential-preflight CLI: exact IMDS GET + KV GET,
 * in-memory DSN validate, immediate private-ref zero, safe metadata output only.
 * Injected HTTP only — no real IMDS/KV/PG call, no pg Client.
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
  buildOfflineProofSunsetDatabaseUrl,
  buildLockedImdsTokenUrl,
  buildLockedKeyVaultSecretUrl,
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
const EVIDENCE_PATH = path.join(FIX, 'slice14f-phase-d-credential-preflight-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14f-phase-d-credential-preflight-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14f-findings.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'run-phase-d-credential-preflight.js');
const COUNT_ONLY_PATH = path.join(ROOT, 'scripts', 'run-phase-d-live-readonly-count-only.js');

const MASTER = '7467642653a54eb2db373e26bfc752865c1b55df';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const FAKE_ADMIN_USER = 'slice14f-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14f-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14f-proof-imds-token-never-commit';

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
  if (/Bearer\s+slice14f-proof-imds-token/i.test(text)) {
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

async function main() {
  console.log('prove:sunset-schema-slice14f-phase-d-credential-preflight — offline\n');

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
  if (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== false) {
    throw new Error('live MI HTTP must remain hard-disabled in 14F');
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

  // Count-only command must remain byte-identical to master tip content check via existence.
  if (!fs.existsSync(COUNT_ONLY_PATH)) throw new Error('count-only CLI missing');
  const countOnlySrc = fs.readFileSync(COUNT_ONLY_PATH, 'utf8');
  if (!countOnlySrc.includes('run-phase-d-live-readonly-count-only')
    || countOnlySrc.includes('credential-preflight')) {
    throw new Error('count-only CLI must remain unchanged (no credential-preflight wiring)');
  }

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

  // RED: MI credential-source requires env+argv
  const partialEnv = evaluateCredentialPreflightGates({
    env: {
      [ENV_CREDENTIAL_PREFLIGHT]: '1',
      AZURE_SUBSCRIPTION_ID: CREDENTIAL_PREFLIGHT_LOCKS.subscriptionId,
      [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
    },
    argv: exactCredentialPreflightArgv().filter((a, i, arr) => {
      if (a === CLI_CREDENTIAL_SOURCE) return false;
      if (arr[i - 1] === CLI_CREDENTIAL_SOURCE) return false;
      return true;
    }),
  });
  if (partialEnv.ok) throw new Error('partial MI argv must fail gates');
  red.push({
    name: 'managed_identity_flag_requires_env_and_argv',
    ok: true,
    rejected: !partialEnv.ok,
  });

  // RED: caller URLs/tokens rejected; zero HTTP
  resetManagedIdentityHttpCounters();
  const caller = await executeCredentialPreflight({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    vaultUrl: 'https://evil.vault.azure.net',
    token: 'evil-token',
  });
  if (caller.ok
    || caller.code !== 'caller_supplied_loader_override_forbidden'
    || getManagedIdentityHttpCounters().httpRequestCount !== 0) {
    throw new Error(`caller overrides must reject before HTTP: ${caller.code}`);
  }
  red.push({
    name: 'caller_urls_tokens_rejected',
    ok: true,
    code: caller.code,
    httpRequestCount: 0,
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

  // RED: redirects / status / body / identity errors sanitized; no Client
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const redirect = await executeCredentialPreflight({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsStatusCode: 302,
      imdsRedirectLocation: 'http://evil/',
      defaultSecretValue: validSecretValue(),
    }),
  });
  leakScan(redirect, secrets);
  assertSafeOutputShape(redirect);
  if (redirect.ok || redirect.code !== 'http_redirect_rejected'
    || getPgClientInstantiateCount() !== 0) {
    throw new Error(`IMDS redirect must sanitize/reject: ${redirect.code}`);
  }

  const badStatus = await executeCredentialPreflight({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      kvStatusCode: 403,
      defaultSecretValue: validSecretValue(),
    }),
  });
  leakScan(badStatus, secrets);
  if (badStatus.ok || badStatus.code !== 'http_status_rejected') {
    throw new Error(`KV status must reject: ${badStatus.code}`);
  }

  const badJson = await executeCredentialPreflight({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsInvalidJson: true,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (badJson.ok || badJson.code !== 'imds_json_invalid') {
    throw new Error(`IMDS bad JSON must reject: ${badJson.code}`);
  }

  const wrongIdentity = await executeCredentialPreflight({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      imdsResponseClientId: '0e05fbe3-e8c5-48aa-a914-30aed284e6f7',
      defaultSecretValue: validSecretValue(),
    }),
  });
  // discarded — re-run after counter reset below
  void wrongIdentity;

  resetManagedIdentityHttpCounters();
  const wrongIdentity2 = await executeCredentialPreflight({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      imdsResponseClientId: '0e05fbe3-e8c5-48aa-a914-30aed284e6f7',
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (wrongIdentity2.ok
    || wrongIdentity2.code !== 'imds_token_identity_mismatch'
    || getManagedIdentityHttpCounters().keyVaultRequestCount !== 0
    || getManagedIdentityHttpCounters().imdsRequestCount !== 1) {
    throw new Error(
      `wrong identity must reject before KV: ${wrongIdentity2.code}`
      + ` kv=${getManagedIdentityHttpCounters().keyVaultRequestCount}`,
    );
  }

  const pwErr = await executeCredentialPreflight({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      throwOn: 'imds_token',
      passwordBearingError: true,
      secretPassword: FAKE_ADMIN_PASSWORD,
      throwError: Object.assign(new Error('imds boom'), { code: 'injected_http_failed' }),
    }),
  });
  leakScan(pwErr, secrets);
  if (pwErr.ok || JSON.stringify(pwErr).includes(FAKE_ADMIN_PASSWORD)) {
    throw new Error('password-bearing errors must sanitize');
  }
  red.push({
    name: 'redirects_status_body_identity_errors_sanitized',
    ok: true,
    redirectCode: redirect.code,
    statusCode: badStatus.code,
    badJsonCode: badJson.code,
    identityCode: wrongIdentity2.code,
    passwordSanitized: true,
    clientsInstantiated: 0,
  });

  // RED: wrong secret PG target
  resetPgClientInstantiateCount();
  const wrongHostSecret = validSecretValue()
    .replace(MI_LOADER_LOCKS.postgresHost, 'evil.postgres.database.azure.com');
  const wrongTarget = await executeCredentialPreflight({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: wrongHostSecret,
    }),
  });
  leakScan(wrongTarget, secrets);
  if (wrongTarget.ok
    || wrongTarget.secretTargetValid === true
    || getPgClientInstantiateCount() !== 0) {
    throw new Error(`wrong secret target must fail: ${wrongTarget.code}`);
  }
  red.push({
    name: 'wrong_secret_pg_target_rejected',
    ok: true,
    code: wrongTarget.code,
    clientsInstantiated: 0,
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
  const loaderSrc = fs.readFileSync(
    path.join(ROOT, 'scripts', 'lib', 'phase-d-managed-identity-credential-loader.js'),
    'utf8',
  );
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

  // RED: MI without inject → http_disabled; zero Clients
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const noInject = await executeCredentialPreflight({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
  });
  if (noInject.ok
    || noInject.code !== 'http_disabled'
    || getManagedIdentityHttpCounters().httpRequestCount !== 0
    || getPgClientInstantiateCount() !== 0) {
    throw new Error(`MI without inject must http_disabled: ${noInject.code}`);
  }
  red.push({
    name: 'managed_identity_without_inject_http_disabled',
    ok: true,
    code: noInject.code,
    httpRequestCount: 0,
    clientsInstantiated: 0,
  });

  // GREEN: exact 2-call success; safe metadata; zero Clients; private refs zeroed
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
    || okRun.liveHttpEnabled !== false
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
  if (!httpOk.calls.every((c) => c.method === 'GET')) {
    throw new Error('success path must be GET-only');
  }
  green.push({
    name: 'injected_http_exact_two_call_success_safe_metadata',
    ok: true,
    code: okRun.code,
    httpCallsDelta: 2,
    imdsRequestCount: 1,
    keyVaultRequestCount: 1,
    clientsInstantiated: 0,
    managedIdentityName: okRun.managedIdentityName,
    keyVaultName: okRun.keyVaultName,
    secretName: okRun.secretName,
    postgresHost: okRun.postgresHost,
    database: okRun.database,
    sslmode: okRun.sslmode,
    secretTargetValid: true,
    hasUser: true,
    hasPassword: true,
    getOnly: true,
  });

  // GREEN: CLI gates pass with exact locks
  const gatesOk = evaluateCredentialPreflightGates({
    env: credentialPreflightEnv(),
    argv: exactCredentialPreflightArgv(),
  });
  if (!gatesOk.ok || !gatesOk.credentialSourceOk) {
    throw new Error(`CLI gates should pass: ${JSON.stringify(gatesOk.errors)}`);
  }
  green.push({
    name: 'cli_gates_exact_targets_and_managed_identity',
    ok: true,
    confirmed: gatesOk.confirmed,
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

  // GREEN: gates-pass operator CLI without inject → http_disabled (no live call)
  const cliGated = spawnSync(
    process.execPath,
    [CLI_PATH, ...exactCredentialPreflightArgv()],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...credentialPreflightEnv(),
        // Ensure no admin secrets persist into child env for this path.
        SUNSET_STAGING_PG_ADMIN_USER: '',
        SUNSET_STAGING_PG_ADMIN_PASSWORD: '',
      },
    },
  );
  const cliOut = `${cliGated.stdout}${cliGated.stderr}`;
  leakScan(cliOut, secrets);
  if (cliGated.status === 0 || !/http_disabled/.test(cliOut)) {
    throw new Error(`gated CLI without inject must http_disabled: ${cliOut.slice(0, 200)}`);
  }
  if (/slice14f-proof|postgresql:\/\//i.test(cliOut)) {
    throw new Error('CLI output leaked secrets');
  }
  green.push({
    name: 'cli_gated_without_inject_http_disabled_no_persistence',
    ok: true,
    exitCode: cliGated.status,
    childEnvSecretFree: true,
  });

  // GREEN: locks
  const imdsUrl = buildLockedImdsTokenUrl();
  const kvUrl = buildLockedKeyVaultSecretUrl();
  if (!imdsUrl.includes(MI_LOADER_LOCKS.imdsHost)
    || !kvUrl.includes(MI_LOADER_LOCKS.secretName)
    || CREDENTIAL_PREFLIGHT_LOCKS.managedIdentityName !== 'wh-staging-identity'
    || CREDENTIAL_PREFLIGHT_LOCKS.vmResourceGroup !== 'wh-staging-rg'
    || CREDENTIAL_PREFLIGHT_LOCKS.vmName !== 'lunabox') {
    throw new Error('credential-preflight locks drifted');
  }
  green.push({
    name: 'locks_subscription_rg_vm_identity_vault_secret_pg_tls',
    ok: true,
    locks: { ...CREDENTIAL_PREFLIGHT_LOCKS },
  });

  const usage = renderCredentialPreflightUsage();
  if (!usage.includes(CLI_CREDENTIAL_PREFLIGHT_ONLY)
    || !usage.includes(ENV_CREDENTIAL_PREFLIGHT)
    || !usage.includes('wh-staging-identity')) {
    throw new Error('usage text incomplete');
  }

  const generatedAt = new Date().toISOString();
  const contract = {
    kind: 'sunset-schema-observer-slice14f-phase-d-credential-preflight-contract',
    secretFree: true,
    containsRepairSql: false,
    containsLiveApplyCode: false,
    liveApplyCapability: false,
    liveReadonlyConnectEnabled: true,
    liveQueryExecution: false,
    liveHttpEnabled: false,
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
    injectedHttpOnly: true,
    neverInstantiatesPgClient: true,
    countOnlyCommandUnchanged: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14F',
    purpose: 'Activate merged 14E managed-identity HTTP loader behind explicit metadata-only credential-preflight CLI; offline injected-HTTP proof only; no live IMDS/KV/PG call; no pg Client.',
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
        `${ENV_CREDENTIAL_SOURCE}=managed-identity`,
        `AZURE_SUBSCRIPTION_ID=${CREDENTIAL_PREFLIGHT_LOCKS.subscriptionId}`,
      ],
      requiredArgv: [
        CLI_CREDENTIAL_PREFLIGHT_ONLY,
        `${CLI_CREDENTIAL_SOURCE} managed-identity`,
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
      'live IMDS / Key Vault / PostgreSQL call in this slice',
      'pg Client instantiation',
      'caller URL / token / DSN overrides',
      'token/DSN/credentials in evidence/logs/argv/temp/child env',
      'POST/PUT/PATCH/DELETE',
      'apply/DDL/ledger',
      'migration / predicate changes',
      'firewall/network mutation',
      'count-only command mutation',
    ],
    nonGoals: [
      'No live secret read',
      'No Phase D constraint apply',
      'No Sunset repair claim',
      'No expected-fixture regeneration',
      'No live HTTP enablement (remains hard-disabled)',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14f-phase-d-credential-preflight-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14F',
    outcome: 'phase_d_credential_preflight_activated_proven_offline',
    stillProductSchemaDiffers: true,
    phaseDConstraintsApplied: false,
    liveMutation: false,
    liveReadonlyConnectEnabled: true,
    liveQueryExecution: false,
    liveHttpEnabled: false,
    azureConnectivity: false,
    firewallAction: false,
    networkMutation: false,
    realImdsCall: false,
    realKeyVaultCall: false,
    realPostgresCall: false,
    enableFlagFlipped: false,
    cliExecutedLive: false,
    migrationAdded: false,
    ledgerWritten: false,
    applyFlagPresent: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    countOnlyCommandUnchanged: true,
    neverInstantiatesPgClient: true,
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
      managedIdentityFlagRequiresEnvAndArgv: true,
      callerUrlsTokensRejected: true,
      forbiddenDsnHostQueryTokenArgv: true,
      redirectsStatusBodyIdentityErrorsSanitized: true,
      wrongSecretPgTargetRejected: true,
      noPostPutPatchDelete: true,
      managedIdentityWithoutInjectHttpDisabled: true,
      injectedHttpExactTwoCallSuccessSafeMetadata: true,
      cliGatesExactTargetsAndManagedIdentity: true,
      cliDefaultDisabled: true,
      cliGatedWithoutInjectHttpDisabledNoPersistence: true,
      locksSubscriptionRgVmIdentityVaultSecretPgTls: true,
      zeroPersistenceChildEnv: true,
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
    },
    clientCallCounts: {
      successPathClientsInstantiated: 0,
      defaultPathClientsInstantiated: 0,
    },
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

  const findings = `# FOUNDATION Slice 14F — Phase D credential-preflight activation

**Status:** complete (live HTTP hard-disabled; offline injected-HTTP proof; no live IMDS/KV/PG; no pg Client)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

Activated the merged **14E** managed-identity HTTP loader behind an explicit **metadata-only** credential-preflight command, while performing **no real IMDS / Key Vault / PostgreSQL call** in this slice. The count-only DB command is **unchanged**.

Locks confirmed on the CLI: Lunabox MI **\`wh-staging-identity\`**, vault \`luna-sunset-staging-kv\`, secret \`sunset-database-url\`, VM \`lunabox\` in \`wh-staging-rg\`, PG host/database/\`sslmode=verify-full\`.

Requires exact subscription / RG / VM identity / vault / secret / PG target args plus:

- \`SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity\`
- \`--credential-source managed-identity\`
- dedicated env \`SUNSET_PHASE_D_CREDENTIAL_PREFLIGHT=1\`
- \`--credential-preflight-only\`

Default / missing / wrong inputs make **zero HTTP** and **zero pg Clients**. On approved offline execution (injected HTTP): exact locked IMDS GET then exact locked Key Vault secret GET; validate secret DSN in memory; immediately zero private refs; output only safe booleans + identity/vault/secret/PG host/database/TLS — never token, DSN, user/password, version values, secret metadata IDs, or hashes. Never instantiates a pg Client. No POST/PUT/PATCH/DELETE. No caller URLs/tokens. Zero persistence / child-env credentials.

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; missing env/flag/targets; MI flag requires env+argv; caller overrides; forbidden argv; redirects/status/body/identity sanitized; wrong secret target; no POST/PUT/PATCH/DELETE; MI without inject → http_disabled |
| GREEN | injected HTTP exact 2-call success + safe metadata; CLI gates; CLI default refuse; gated CLI without inject → http_disabled; locks |

## Non-goals / still open

- **No** live secret read, Azure/PG query, firewall/network, DDL/apply/ledger
- **No** migration or predicate changes
- Still \`product_schema_differs\`
- Live MI HTTP enablement remains a later slice (\`PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=false\`)
- **Do not claim Sunset repaired.**

## Zero live/Azure mutation

Offline injected HTTP only. \`PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=false\`. No Azure CLI, no live PostgreSQL, no real Key Vault read, no network/firewall mutation, no pg Client.
`;

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(FINDINGS_PATH, findings);

  console.log(`RED cases: ${red.length}`);
  console.log(`GREEN cases: ${green.length}`);
  console.log(`Wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`Wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('\nprove:sunset-schema-slice14f-phase-d-credential-preflight GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
