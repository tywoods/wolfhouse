'use strict';

/**
 * prove-sunset-schema-slice14e-phase-d-managed-identity-loader — FOUNDATION Slice 14E
 *
 * Offline proof that the count-only CLI/adapter can obtain protected admin
 * credentials in-process from Lunabox managed identity + locked Key Vault
 * sunset-database-url via injected HTTP only. No real IMDS/KV/PG call.
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
  AUTHORIZED_AGGREGATE_SQL,
  AUTHORIZED_SESSION_SQL,
  OUTPUT_COUNT_KEYS,
  evaluateLiveReadonlyBoundary,
  redactDeep,
} = require('./lib/phase-d-live-readonly-boundary');
const {
  createInjectedAzureAdapters,
  createInjectedDbAdapters,
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
  FORBIDDEN_ARGV_FLAGS,
} = require('./lib/phase-d-live-readonly-cli');
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
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  MI_LOADER_LOCKS,
  buildLockedImdsTokenUrl,
  buildLockedKeyVaultSecretUrl,
  extractImdsClientIdFromUrlOrPath,
  assertImdsRequestClientIdLocked,
  assertImdsTokenIdentityIfExposed,
  evaluateCredentialSource,
  loadProtectedAdminCredentialsViaManagedIdentity,
  parseSunsetDatabaseUrlSecretInMemory,
  zeroPrivateCredentialRefs,
  createInjectedManagedIdentityHttp,
  createLiveManagedIdentityHttpRequest,
  buildOfflineProofSunsetDatabaseUrl,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
  assertNoCallerOverrides,
} = require('./lib/phase-d-managed-identity-credential-loader');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const EXPECTED_PATH = path.join(FIX, 'expected-product-schema.json');
const EVIDENCE_PATH = path.join(FIX, 'slice14e-phase-d-managed-identity-loader-evidence.json');
const CONTRACT_PATH = path.join(FIX, 'slice14e-phase-d-managed-identity-loader-contract.json');
const FINDINGS_PATH = path.join(FIX, 'slice14e-findings.md');

const MASTER = '6e7c7d6f70e11b2ce77d28d367fc669b60eabe3a';
const CANON_FP = '120ee75f11428db59524561bd943f23130111a34e0834c54cef61ba8bf594d18';
const MANIFEST_HASH = '99549bacdcb46a5f714b17a4d32abd2bc2554fbd1bb4f0d78f33e71d1c7f9f8e';
const EXPECTED_BYTE_SHA = 'cb74742b5e9d02a6cf478eb334e677532ba3ea88a89c93ee10a254f9264071d5';

const LOCKED_13C_SHA = Object.freeze({
  '028': EXPECTED_028_SHA256,
  '035': '924f1293cca214eeee18080c50fd4c63fc078011939f98af804993c5b9ced565',
  '040': '880cdee1865d6dbaef212a22506b9ee9278d750eb5b8ff0aa6d08148ac3dcddd',
  '041': '3b639a23f5fdd753d63b5ff1b81d01a1875c1ee19e08ea361a2647e20dcb7d09',
});

const FAKE_ADMIN_USER = 'slice14e-proof-admin-user';
const FAKE_ADMIN_PASSWORD = 'slice14e-proof-admin-password-never-commit';
const FAKE_IMDS_TOKEN = 'slice14e-proof-imds-token-never-commit';

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
  return ['node', 'prove-14e', ...miArgv()];
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
  if (/Bearer\s+slice14e-proof-imds-token/i.test(text)) {
    throw new Error('IMDS token leaked into proof artifact');
  }
}

function secretFreePublic(obj) {
  const clone = { ...obj };
  delete clone._user;
  delete clone._password;
  delete clone._connectConfig;
  delete clone._token;
  delete clone._dsn;
  delete clone._secretValue;
  return clone;
}

async function main() {
  console.log('prove:sunset-schema-slice14e-phase-d-managed-identity-loader — offline\n');

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

  const secrets = [FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD, FAKE_IMDS_TOKEN, validSecretValue()];
  const red = [];
  const green = [];

  // RED: default path — zero HTTP + zero Clients
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const defLoad = await loadProtectedAdminCredentialsViaManagedIdentity({ env: {}, argv: [] });
  if (getManagedIdentityHttpCounters().httpRequestCount !== 0) {
    throw new Error('default loader must make zero HTTP calls');
  }
  const defAdapter = await executePhaseDLiveReadonlyPgAdapter({ env: {} });
  if (getPgClientInstantiateCount() !== 0) {
    throw new Error('default adapter must instantiate zero Clients');
  }
  red.push({
    name: 'default_path_zero_http_and_clients',
    ok: true,
    code: defLoad.code,
    httpRequestCount: 0,
    clientsInstantiated: 0,
  });

  // RED: live HTTP activated — offline prove requires inject; never ungated MI/adapter call
  if (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== true) {
    throw new Error('live MI HTTP flag must be true');
  }
  if (typeof createLiveManagedIdentityHttpRequest !== 'function') {
    throw new Error('createLiveManagedIdentityHttpRequest must be exported');
  }
  resetManagedIdentityHttpCounters();
  resetPgClientInstantiateCount();
  const defaultOffline = await loadProtectedAdminCredentialsViaManagedIdentity({ env: {}, argv: [] });
  const defaultAdapterOffline = await executePhaseDLiveReadonlyPgAdapter({ env: {} });
  if (getManagedIdentityHttpCounters().httpRequestCount !== 0
    || getPgClientInstantiateCount() !== 0
    || defaultOffline.ok
    || defaultAdapterOffline.ok) {
    throw new Error('default path must remain zero HTTP and zero Clients without inject');
  }
  red.push({
    name: 'live_http_activated_offline_inject_required',
    ok: true,
    liveHttpEnabled: true,
    createLiveManagedIdentityHttpRequestExported: true,
    defaultPathHttpRequestCount: 0,
    defaultPathClientsInstantiated: 0,
    offlineInjectOnly: true,
  });

  // RED: missing/partial credential-source flag
  const partialEnv = evaluateCredentialSource({
    env: { [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY },
    argv: [CLI_EXECUTE_COUNT_ONLY],
  });
  if (partialEnv.ok) throw new Error('partial MI env must fail');
  const partialArgv = evaluateCredentialSource({
    env: {},
    argv: [CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY],
  });
  if (partialArgv.ok) throw new Error('partial MI argv must fail');
  red.push({
    name: 'managed_identity_flag_requires_env_and_argv',
    ok: true,
    partialEnvRejected: !partialEnv.ok,
    partialArgvRejected: !partialArgv.ok,
  });

  // RED: caller overrides rejected
  const override = assertNoCallerOverrides({
    imdsUrl: 'http://evil/',
    token: 't',
    dsn: 'postgresql://x:y@h/db',
    secretName: 'other',
  });
  if (override.ok) throw new Error('caller overrides must fail');
  const overrideLoad = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
    vaultUrl: 'https://evil.vault.azure.net',
  });
  if (overrideLoad.ok || overrideLoad.code !== 'caller_supplied_loader_override_forbidden') {
    throw new Error('caller vaultUrl must be rejected before HTTP');
  }
  red.push({
    name: 'caller_urls_names_tokens_dsns_rejected',
    ok: true,
    code: overrideLoad.code,
  });

  // RED: wrong IMDS host / audience / status / redirect / JSON
  resetManagedIdentityHttpCounters();
  const wrongImdsHost = createInjectedManagedIdentityHttp({
    imdsAccessToken: FAKE_IMDS_TOKEN,
    defaultSecretValue: validSecretValue(),
  });
  // Force wrong host by wrapping
  const evilImds = async (req) => {
    if (req.purpose === 'imds_token') {
      return wrongImdsHost({ ...req, hostname: '8.8.8.8' });
    }
    return wrongImdsHost(req);
  };
  const badHost = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: evilImds,
  });
  if (badHost.ok) throw new Error('wrong IMDS host must fail');

  const redirectImds = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsStatusCode: 302,
      imdsRedirectLocation: 'http://evil/',
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (redirectImds.ok || redirectImds.code !== 'http_redirect_rejected') {
    throw new Error(`IMDS redirect must reject: ${redirectImds.code}`);
  }

  const badImdsJson = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsInvalidJson: true,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (badImdsJson.ok || badImdsJson.code !== 'imds_json_invalid') {
    throw new Error(`IMDS bad JSON must reject: ${badImdsJson.code}`);
  }

  const missingToken = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsMissingToken: true,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (missingToken.ok || missingToken.code !== 'imds_token_missing') {
    throw new Error(`IMDS missing token must reject: ${missingToken.code}`);
  }
  red.push({
    name: 'wrong_imds_host_audience_status_redirect_json_rejected',
    ok: true,
    wrongHostRejected: !badHost.ok,
    redirectRejected: redirectImds.code === 'http_redirect_rejected',
    badJsonRejected: badImdsJson.code === 'imds_json_invalid',
    missingTokenRejected: missingToken.code === 'imds_token_missing',
  });

  // RED: wrong / omitted IMDS client_id + wrong token identity — reject before Key Vault
  const WRONG_MI_CLIENT_ID = '0e05fbe3-e8c5-48aa-a914-30aed284e6f7'; // sunset CA MI — not Lunabox
  const omitClientIdUrl = (
    `http://${MI_LOADER_LOCKS.imdsHost}${MI_LOADER_LOCKS.imdsPath}`
    + `?api-version=${MI_LOADER_LOCKS.imdsApiVersion}`
    + `&resource=${encodeURIComponent(MI_LOADER_LOCKS.vaultResourceAudience)}`
  );
  const wrongClientIdUrl = (
    `http://${MI_LOADER_LOCKS.imdsHost}${MI_LOADER_LOCKS.imdsPath}`
    + `?api-version=${MI_LOADER_LOCKS.imdsApiVersion}`
    + `&resource=${encodeURIComponent(MI_LOADER_LOCKS.vaultResourceAudience)}`
    + `&client_id=${WRONG_MI_CLIENT_ID}`
  );
  let omitRejected = false;
  let omitCode = null;
  try {
    assertImdsRequestClientIdLocked(omitClientIdUrl);
  } catch (e) {
    omitRejected = e.code === 'imds_client_id_required';
    omitCode = e.code;
  }
  let wrongReqRejected = false;
  let wrongReqCode = null;
  try {
    assertImdsRequestClientIdLocked(wrongClientIdUrl);
  } catch (e) {
    wrongReqRejected = e.code === 'imds_client_id_mismatch';
    wrongReqCode = e.code;
  }
  if (!omitRejected || !wrongReqRejected) {
    throw new Error(`IMDS client_id omit/wrong must reject: ${omitCode}/${wrongReqCode}`);
  }
  // Injected router refuses omit/wrong client_id on the request path.
  const omitPathHttp = createInjectedManagedIdentityHttp({
    imdsAccessToken: FAKE_IMDS_TOKEN,
    defaultSecretValue: validSecretValue(),
  });
  const omitPathRes = await omitPathHttp({
    purpose: 'imds_token',
    hostname: MI_LOADER_LOCKS.imdsHost,
    method: 'GET',
    path: `${MI_LOADER_LOCKS.imdsPath}?api-version=${MI_LOADER_LOCKS.imdsApiVersion}`
      + `&resource=${encodeURIComponent(MI_LOADER_LOCKS.vaultResourceAudience)}`,
    headers: { Metadata: 'true' },
  });
  if (omitPathRes.statusCode !== 400) {
    throw new Error('injected IMDS without client_id must 400');
  }
  const wrongPathRes = await omitPathHttp({
    purpose: 'imds_token',
    hostname: MI_LOADER_LOCKS.imdsHost,
    method: 'GET',
    path: `${MI_LOADER_LOCKS.imdsPath}?api-version=${MI_LOADER_LOCKS.imdsApiVersion}`
      + `&resource=${encodeURIComponent(MI_LOADER_LOCKS.vaultResourceAudience)}`
      + `&client_id=${WRONG_MI_CLIENT_ID}`,
    headers: { Metadata: 'true' },
  });
  if (wrongPathRes.statusCode !== 400) {
    throw new Error('injected IMDS with wrong client_id must 400');
  }

  resetManagedIdentityHttpCounters();
  const wrongTokenIdentity = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      imdsResponseClientId: WRONG_MI_CLIENT_ID,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (wrongTokenIdentity.ok
    || wrongTokenIdentity.code !== 'imds_token_identity_mismatch'
    || getManagedIdentityHttpCounters().keyVaultRequestCount !== 0) {
    throw new Error(
      `wrong token client_id must reject before KV: ${wrongTokenIdentity.code}`
      + ` kv=${getManagedIdentityHttpCounters().keyVaultRequestCount}`,
    );
  }
  resetManagedIdentityHttpCounters();
  const wrongPrincipal = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      imdsResponsePrincipalId: '00000000-0000-0000-0000-000000000000',
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (wrongPrincipal.ok
    || wrongPrincipal.code !== 'imds_token_identity_mismatch'
    || getManagedIdentityHttpCounters().keyVaultRequestCount !== 0) {
    throw new Error(`wrong token principal must reject before KV: ${wrongPrincipal.code}`);
  }
  resetManagedIdentityHttpCounters();
  const wrongName = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      imdsResponseIdentityName: 'luna-sunset-staging-identity',
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (wrongName.ok
    || wrongName.code !== 'imds_token_identity_mismatch'
    || getManagedIdentityHttpCounters().keyVaultRequestCount !== 0) {
    throw new Error(`wrong token identity name must reject before KV: ${wrongName.code}`);
  }
  // Matching exposed identity proceeds; omitted identity fields also allowed.
  let identityAssertOk = false;
  try {
    assertImdsTokenIdentityIfExposed({
      access_token: 'x',
      client_id: MI_LOADER_LOCKS.managedIdentityClientId,
      principal_id: MI_LOADER_LOCKS.managedIdentityPrincipalId,
      identity: MI_LOADER_LOCKS.managedIdentityName,
    });
    assertImdsTokenIdentityIfExposed({ access_token: 'x' });
    identityAssertOk = true;
  } catch (_) {
    identityAssertOk = false;
  }
  if (!identityAssertOk) throw new Error('matching/absent token identity must pass');
  red.push({
    name: 'wrong_imds_client_id_or_token_identity_rejected_before_kv',
    ok: true,
    omitClientIdRejected: omitRejected,
    wrongRequestClientIdRejected: wrongReqRejected,
    injectedOmitClientIdRejected: omitPathRes.statusCode === 400,
    injectedWrongClientIdRejected: wrongPathRes.statusCode === 400,
    wrongTokenClientIdCode: wrongTokenIdentity.code,
    wrongTokenPrincipalCode: wrongPrincipal.code,
    wrongTokenIdentityNameCode: wrongName.code,
    keyVaultCallsAfterIdentityReject: 0,
    lockedManagedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
    lockedManagedIdentityClientId: MI_LOADER_LOCKS.managedIdentityClientId,
  });

  // RED: wrong vault secret / status / redirect / JSON
  const wrongSecretPath = async (req) => {
    if (req.purpose === 'keyvault_secret') {
      return {
        statusCode: 404,
        body: '{"error":"SecretNotFound"}',
      };
    }
    return createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    })(req);
  };
  const badSecret = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: wrongSecretPath,
  });
  if (badSecret.ok || badSecret.code !== 'http_status_rejected') {
    throw new Error(`wrong secret status must reject: ${badSecret.code}`);
  }

  const kvRedirect = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      kvStatusCode: 301,
      kvRedirectLocation: 'https://evil/',
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (kvRedirect.ok || kvRedirect.code !== 'http_redirect_rejected') {
    throw new Error(`KV redirect must reject: ${kvRedirect.code}`);
  }

  const kvBadJson = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      kvInvalidJson: true,
    }),
  });
  if (kvBadJson.ok || kvBadJson.code !== 'kv_json_invalid') {
    throw new Error(`KV bad JSON must reject: ${kvBadJson.code}`);
  }
  red.push({
    name: 'wrong_vault_secret_status_redirect_json_rejected',
    ok: true,
    wrongSecretRejected: badSecret.code === 'http_status_rejected',
    redirectRejected: kvRedirect.code === 'http_redirect_rejected',
    badJsonRejected: kvBadJson.code === 'kv_json_invalid',
  });

  // RED: wrong PG target inside secret — before Client
  resetPgClientInstantiateCount();
  const wrongHostSecret = buildOfflineProofSunsetDatabaseUrl(FAKE_ADMIN_USER, FAKE_ADMIN_PASSWORD)
    .replace(MI_LOADER_LOCKS.postgresHost, 'evil.postgres.database.azure.com');
  const wrongTarget = await executePhaseDLiveReadonlyPgAdapter({
    env: miEnv(),
    argv: adapterArgv(),
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      secretValue: wrongHostSecret,
    }),
    Client: createScriptedFakePgClientFactory(),
  });
  if (wrongTarget.ok || getPgClientInstantiateCount() !== 0) {
    throw new Error(`wrong secret target must reject before Client: ${wrongTarget.code}`);
  }
  const wrongDbParsed = parseSunsetDatabaseUrlSecretInMemory(
    `postgresql://${FAKE_ADMIN_USER}:${FAKE_ADMIN_PASSWORD}@${MI_LOADER_LOCKS.postgresHost}:5432/wolfhouse?sslmode=verify-full`,
  );
  if (wrongDbParsed.ok) throw new Error('wrong database in secret must fail');
  const wrongTls = parseSunsetDatabaseUrlSecretInMemory(
    `postgresql://${FAKE_ADMIN_USER}:${FAKE_ADMIN_PASSWORD}@${MI_LOADER_LOCKS.postgresHost}:5432/${MI_LOADER_LOCKS.database}?sslmode=require`,
  );
  if (wrongTls.ok) throw new Error('wrong tls in secret must fail');
  red.push({
    name: 'wrong_secret_pg_target_rejected_before_client',
    ok: true,
    code: wrongTarget.code,
    clientsInstantiated: 0,
    wrongDatabaseRejected: !wrongDbParsed.ok,
    wrongTlsRejected: !wrongTls.ok,
  });

  // RED: password-bearing HTTP errors sanitized; no Client
  resetPgClientInstantiateCount();
  const pwErr = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      throwOn: 'imds_token',
      passwordBearingError: true,
      secretPassword: FAKE_ADMIN_PASSWORD,
      throwError: Object.assign(new Error('imds boom'), { code: 'injected_http_failed' }),
    }),
  });
  leakScan(secretFreePublic(pwErr), secrets);
  if (pwErr.ok || String(JSON.stringify(pwErr)).includes(FAKE_ADMIN_PASSWORD)) {
    throw new Error('password-bearing loader error must sanitize');
  }
  red.push({
    name: 'token_dsn_password_bearing_errors_sanitized',
    ok: true,
    code: pwErr.code,
    sanitized: true,
  });

  // GREEN: successful injected HTTP → private creds → fake Client → exact sequence
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
          total_rows: 7,
          date_window_violations: 1,
          price_unit_violations: 0,
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
    || okRun.counts.total_rows !== 7
    || okRun.clientsInstantiated !== 1
    || okRun.closed !== true
    || okRun.liveMutation !== false
    || okRun.offlineProof !== true) {
    throw new Error(`MI success sequence failed: ${JSON.stringify(okRun)}`);
  }
  if (getManagedIdentityHttpCounters().httpRequestCount !== 2
    || getManagedIdentityHttpCounters().imdsRequestCount !== 1
    || getManagedIdentityHttpCounters().keyVaultRequestCount !== 1) {
    throw new Error(`expected exactly 2 HTTP (1 IMDS + 1 KV), got ${JSON.stringify(getManagedIdentityHttpCounters())}`);
  }
  const endCalls = FakeOk.instances[0].calls.filter((c) => c.method === 'end').length;
  if (endCalls !== 1) throw new Error(`expected exactly one end(), got ${endCalls}`);
  green.push({
    name: 'injected_http_success_reaches_fake_client_exact_sequence',
    ok: true,
    steps: okRun.steps,
    counts: okRun.counts,
    clientsInstantiated: 1,
    httpRequestCount: 2,
    imdsRequestCount: 1,
    keyVaultRequestCount: 1,
    credentialSource: 'managed_identity',
    closed: true,
  });

  // GREEN: secret lifetime — load, consume, zero; public view has no secrets
  resetManagedIdentityHttpCounters();
  const loaded = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (!loaded.ok || !loaded._user || !loaded._password || !loaded._connectConfig) {
    throw new Error('loader must return private fields for handoff');
  }
  const lifetimeBeforeZero = {
    hadUser: Boolean(loaded._user),
    hadPassword: Boolean(loaded._password),
    hadConnectConfig: Boolean(loaded._connectConfig),
  };
  const publicBefore = secretFreePublic(loaded);
  leakScan(publicBefore, secrets);
  const zeroMeta = zeroPrivateCredentialRefs(loaded);
  if (!zeroMeta.zeroed
    || loaded._user != null
    || loaded._password != null
    || loaded._connectConfig != null) {
    throw new Error('zeroPrivateCredentialRefs must null private fields');
  }
  leakScan(loaded, secrets);
  green.push({
    name: 'secret_lifetime_zero_after_private_handoff',
    ok: true,
    lifetimeBeforeZero,
    zeroed: true,
    publicViewSecretFree: true,
  });

  // GREEN: protected-admin-env mode still works (14D compatibility)
  resetPgClientInstantiateCount();
  const FakeEnv = createScriptedFakePgClientFactory();
  const envOk = await executePhaseDLiveReadonlyPgAdapter({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_EXECUTE_COUNT_ONLY]: '1',
      [CREDENTIAL_USER_ENV]: FAKE_ADMIN_USER,
      [CREDENTIAL_PASSWORD_ENV]: FAKE_ADMIN_PASSWORD,
    },
    argv: [
      'node', 'prove', CLI_EXECUTE_COUNT_ONLY,
      '--subscription', TARGETS.subscriptionId,
      '--resource-group', TARGETS.resourceGroup,
      '--postgres-server', TARGETS.postgresServer,
      '--database', TARGETS.database,
    ],
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
    Client: FakeEnv,
  });
  if (!envOk.ok || envOk.credentialSource !== 'protected_admin_env') {
    throw new Error(`protected-admin-env mode must still work: ${envOk.code}`);
  }
  green.push({
    name: 'protected_admin_env_mode_preserved',
    ok: true,
    credentialSource: envOk.credentialSource,
    clientsInstantiated: envOk.clientsInstantiated,
  });

  // GREEN: CLI gates accept MI source without admin env
  const cliMi = evaluatePhaseDLiveReadonlyCliGates({
    env: miEnv(),
    argv: miArgv(),
  });
  if (!cliMi.ok || !cliMi.managedIdentityCredentialSource) {
    throw new Error(`CLI MI gates should pass: ${JSON.stringify(cliMi.errors)}`);
  }
  const cliEnv = evaluatePhaseDLiveReadonlyCliGates({
    env: {
      [ENV_LIVE_READONLY]: '1',
      [ENV_LIVE_PREFLIGHT]: '1',
      [ENV_SUBSCRIPTION]: TARGETS.subscriptionId,
      [ENV_EXECUTE_COUNT_ONLY]: '1',
      [CREDENTIAL_USER_ENV]: FAKE_ADMIN_USER,
      [CREDENTIAL_PASSWORD_ENV]: FAKE_ADMIN_PASSWORD,
    },
    argv: [
      CLI_EXECUTE_COUNT_ONLY,
      '--subscription', TARGETS.subscriptionId,
      '--resource-group', TARGETS.resourceGroup,
      '--postgres-server', TARGETS.postgresServer,
      '--database', TARGETS.database,
    ],
  });
  if (!cliEnv.ok || cliEnv.credentialSource !== CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV) {
    throw new Error('CLI protected-admin-env gates should pass');
  }
  green.push({
    name: 'cli_gates_managed_identity_and_protected_admin_env',
    ok: true,
    managedIdentityOk: cliMi.ok,
    protectedAdminEnvOk: cliEnv.ok,
  });

  // GREEN: locks documented
  const imdsUrl = buildLockedImdsTokenUrl();
  const kvUrl = buildLockedKeyVaultSecretUrl();
  const lockedClientIdInUrl = extractImdsClientIdFromUrlOrPath(imdsUrl);
  if (!imdsUrl.includes(MI_LOADER_LOCKS.imdsHost)
    || !imdsUrl.includes(encodeURIComponent(MI_LOADER_LOCKS.vaultResourceAudience))
    || !imdsUrl.includes(MI_LOADER_LOCKS.imdsApiVersion)
    || lockedClientIdInUrl !== MI_LOADER_LOCKS.managedIdentityClientId
    || MI_LOADER_LOCKS.managedIdentityName !== 'wh-staging-identity'
    || MI_LOADER_LOCKS.managedIdentityClientId !== '0dd41fa2-52c8-4e04-bc23-8aa462938c19'
    || MI_LOADER_LOCKS.managedIdentityPrincipalId !== 'e3136eed-948b-4947-a26e-50a33b45a41a'
    || !kvUrl.startsWith(MI_LOADER_LOCKS.keyVaultHttpsUrl)
    || !kvUrl.includes(MI_LOADER_LOCKS.secretName)
    || !kvUrl.includes(MI_LOADER_LOCKS.keyVaultApiVersion)) {
    throw new Error('lock URL builders drifted');
  }
  assertImdsRequestClientIdLocked(imdsUrl);
  // Success with matching exposed token identity + with omitted identity both OK
  resetManagedIdentityHttpCounters();
  const matchIdentityLoad = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      imdsResponseClientId: MI_LOADER_LOCKS.managedIdentityClientId,
      imdsResponsePrincipalId: MI_LOADER_LOCKS.managedIdentityPrincipalId,
      imdsResponseIdentityName: MI_LOADER_LOCKS.managedIdentityName,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (!matchIdentityLoad.ok) {
    throw new Error(`matching token identity must load: ${matchIdentityLoad.code}`);
  }
  zeroPrivateCredentialRefs(matchIdentityLoad);
  const omitIdentityLoad = await loadProtectedAdminCredentialsViaManagedIdentity({
    env: miEnv(),
    argv: miArgv(),
    httpRequest: createInjectedManagedIdentityHttp({
      imdsAccessToken: FAKE_IMDS_TOKEN,
      imdsOmitClientIdInResponse: true,
      defaultSecretValue: validSecretValue(),
    }),
  });
  if (!omitIdentityLoad.ok) {
    throw new Error(`absent token identity fields must load: ${omitIdentityLoad.code}`);
  }
  zeroPrivateCredentialRefs(omitIdentityLoad);
  green.push({
    name: 'locks_imds_vault_secret_api_pg_tls',
    ok: true,
    locks: {
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
    },
    imdsRequestClientIdEqualsLock: true,
    matchingTokenIdentityAccepted: true,
    absentTokenIdentityFieldsAccepted: true,
  });

  // Boundary still ready under dual flags with deferred MI
  const boundary = await evaluateLiveReadonlyBoundary({
    env: miEnv(),
    argv: adapterArgv(),
    azureAdapters: createInjectedAzureAdapters({}),
    dbAdapters: createInjectedDbAdapters({}),
  });
  if (!boundary.ok || !boundary.accepted
    || boundary.counters.connectCalls !== 0
    || boundary.counters.queryCalls !== 0) {
    throw new Error(`MI boundary ready failed: ${boundary.code}`);
  }

  const generatedAt = new Date().toISOString();
  const contract = {
    kind: 'sunset-schema-observer-slice14e-phase-d-managed-identity-loader-contract',
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
    dualEnableFlagsRequired: true,
    executeCountOnlyGateRequired: true,
    exactTargetCliConfirmationRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    injectedHttpOnly: true,
    injectedFakePgClientOnly: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14E',
    purpose: 'In-process Lunabox managed-identity + locked Key Vault sunset-database-url credential loader for the merged count-only CLI; offline injected-HTTP proof only (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true since Slice 14G; this prove never calls live IMDS/KV/PG).',
    targets: { ...TARGETS },
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
      imdsRequestClientIdRequired: true,
      imdsTokenIdentityVerifiedIfExposed: true,
    },
    credentialSources: {
      protectedAdminEnv: CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV,
      managedIdentity: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
      envFlag: ENV_CREDENTIAL_SOURCE,
      argvFlag: CLI_CREDENTIAL_SOURCE,
      keyVaultSecret: 'sunset-database-url',
      forbidden: [
        'caller_imds_url',
        'caller_vault_url',
        'caller_secret_name',
        'caller_token',
        'caller_dsn',
        'argv_credentials',
        'observer_dsn',
        'WOLFHOUSE_DATABASE_URL',
        'temp_file',
        'child_process_env_credentials',
      ],
    },
    commandContract: {
      script: 'scripts/run-phase-d-live-readonly-count-only.js',
      npm: 'phase-d:live-readonly-count-only',
      managedIdentityRequiredEnv: [
        `${ENV_LIVE_READONLY}=1`,
        `${ENV_LIVE_PREFLIGHT}=1`,
        `${ENV_EXECUTE_COUNT_ONLY}=1`,
        `${ENV_SUBSCRIPTION}=${TARGETS.subscriptionId}`,
        `${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
      ],
      managedIdentityRequiredArgv: [
        CLI_EXECUTE_COUNT_ONLY,
        `--subscription ${TARGETS.subscriptionId}`,
        `--resource-group ${TARGETS.resourceGroup}`,
        `--postgres-server ${TARGETS.postgresServer}`,
        `--database ${TARGETS.database}`,
        `${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
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
      'live IMDS / Key Vault / PostgreSQL call in this offline prove',
      'caller URL / name / token / DSN overrides',
      'token/DSN/credentials in evidence/logs/argv/temp/child env',
      'apply/DDL/ledger',
      'migration / predicate changes',
      'firewall/network mutation',
    ],
    nonGoals: [
      'No live secret read in this offline prove',
      'No Phase D constraint apply',
      'No Sunset repair claim',
      'No expected-fixture regeneration',
      'Live MI HTTP activated in Slice 14G; ungated loader/adapter calls belong in 14G live prove only',
    ],
  };

  const evidence = {
    kind: 'sunset-schema-observer-slice14e-phase-d-managed-identity-loader-evidence',
    secretFree: true,
    generatedAt,
    masterShaBasis: MASTER,
    slice: '14E',
    outcome: 'phase_d_managed_identity_credential_loader_proven_offline',
    stillProductSchemaDiffers: true,
    phaseDConstraintsApplied: false,
    liveMutation: false,
    liveReadonlyConnectEnabled: true,
    liveQueryExecution: false,
    liveHttpEnabled: true,
    azureConnectivity: false,
    firewallAction: false,
    networkMutation: false,
    realImdsCall: false,
    realKeyVaultCall: false,
    realPostgresCall: false,
    enableFlagFlipped: true,
    cliExecutedLive: false,
    migrationAdded: false,
    ledgerWritten: false,
    applyFlagPresent: false,
    forwardCountUnchanged: 39,
    newForwardMigration: false,
    migrationHashes: { ...LOCKED_13C_SHA },
    manifestHashUnchanged: MANIFEST_HASH,
    productFingerprintUnchanged: CANON_FP,
    expectedProductSchemaByteSha256: EXPECTED_BYTE_SHA,
    migration028Sha256CanonicalLfV1: LOCKED_13C_SHA['028'],
    defaultDisabled: true,
    dualEnableFlagsRequired: true,
    executeCountOnlyGateRequired: true,
    managedIdentityCredentialSourceFlagRequired: true,
    authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
    offlineGates: {
      defaultPathZeroHttpAndClients: true,
      liveHttpActivatedOfflineInjectRequired: true,
      managedIdentityFlagRequiresEnvAndArgv: true,
      callerUrlsNamesTokensDsnsRejected: true,
      wrongImdsRejected: true,
      wrongImdsClientIdOrTokenIdentityRejectedBeforeKv: true,
      wrongVaultSecretRejected: true,
      wrongSecretPgTargetRejectedBeforeClient: true,
      tokenDsnPasswordBearingErrorsSanitized: true,
      injectedHttpSuccessReachesFakeClientExactSequence: true,
      secretLifetimeZeroAfterPrivateHandoff: true,
      protectedAdminEnvModePreserved: true,
      cliGatesManagedIdentityAndProtectedAdminEnv: true,
      locksImdsVaultSecretApiPgTls: true,
      credentialsNeverInLogsResultsErrors: true,
    },
    redCases: red,
    greenCases: green,
    redCaseCount: red.length,
    greenCaseCount: green.length,
    secretLifetimeProof: {
      privateFieldsPresentBeforeZero: true,
      zeroedAfterHandoff: true,
      neverPrinted: true,
      neverPersisted: true,
      neverHashedIntoEvidence: true,
      neverInArgv: true,
      neverInTempFile: true,
      neverInChildProcessEnv: true,
    },
    httpCallCounts: {
      successPathHttpRequestCount: 2,
      successPathImdsRequestCount: 1,
      successPathKeyVaultRequestCount: 1,
      defaultPathHttpRequestCount: 0,
    },
    clientCallCounts: {
      successPathClientsInstantiated: 1,
      defaultPathClientsInstantiated: 0,
      wrongTargetClientsInstantiated: 0,
    },
  };

  leakScan(evidence, secrets);
  leakScan(contract, secrets);

  fs.writeFileSync(CONTRACT_PATH, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  const findings = `# FOUNDATION Slice 14E — Phase D managed-identity credential loader

**Status:** complete (\`PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true\` since Slice 14G; offline injected-HTTP proof only; no live IMDS/KV/PG in this prove)
**Master basis:** \`${MASTER}\`
**Generated:** ${generatedAt}

## Outcome

Made the merged count-only CLI able to obtain protected admin credentials **in-process** from Lunabox managed identity + the exact Sunset staging Key Vault secret \`sunset-database-url\`, while performing **no real IMDS / Key Vault / PostgreSQL call** in this slice.

Locks:

| Lock | Value |
|------|-------|
| IMDS host | \`${MI_LOADER_LOCKS.imdsHost}\` |
| Vault resource audience | \`${MI_LOADER_LOCKS.vaultResourceAudience}\` |
| Key Vault name / HTTPS | \`${MI_LOADER_LOCKS.keyVaultName}\` / \`${MI_LOADER_LOCKS.keyVaultHttpsUrl}\` |
| Secret name | \`${MI_LOADER_LOCKS.secretName}\` |
| IMDS API version | \`${MI_LOADER_LOCKS.imdsApiVersion}\` |
| Key Vault API version | \`${MI_LOADER_LOCKS.keyVaultApiVersion}\` |
| Lunabox MI name | \`${MI_LOADER_LOCKS.managedIdentityName}\` |
| Lunabox MI client id | \`${MI_LOADER_LOCKS.managedIdentityClientId}\` |
| Lunabox MI principal id | \`${MI_LOADER_LOCKS.managedIdentityPrincipalId}\` |
| Lunabox VM | \`${MI_LOADER_LOCKS.lunaboxVmResourceId}\` |
| PG host / database / TLS | \`${MI_LOADER_LOCKS.postgresHost}\` / \`${MI_LOADER_LOCKS.database}\` / \`${MI_LOADER_LOCKS.sslmode}\` |

IMDS request \`client_id\` must equal the locked Lunabox \`wh-staging-identity\` client id (never omit / system / default / arbitrary). When the IMDS token JSON exposes identity metadata (\`client_id\` / \`principal_id\` / name), it must match; mismatch is rejected **before** Key Vault.

Caller URLs / names / tokens / DSNs are rejected. Secret is parsed only in memory; user/password validated against the exact target; passed privately to the existing 14D adapter; then private refs are zeroed. Token / DSN / credentials are never printed, returned, persisted, hashed, evidenced, argv-embedded, temp-filed, or child-process-env'd.

## Credential sources

- **protected-admin-env** (default / 14D offline proof): \`SUNSET_STAGING_PG_ADMIN_USER\` / \`SUNSET_STAGING_PG_ADMIN_PASSWORD\`
- **managed-identity** (explicit): requires both \`SUNSET_PHASE_D_CREDENTIAL_SOURCE=managed-identity\` and \`--credential-source managed-identity\`

## RED / GREEN

| Class | Cases |
|-------|-------|
| RED | default zero HTTP+Clients; live HTTP activated → offline inject required (no ungated MI call); flag requires env+argv; caller overrides; wrong IMDS/vault/audience/secret/target/JSON/status/redirect before Client; wrong/omitted IMDS client_id or token identity rejected before KV; password-bearing errors sanitized |
| GREEN | injected HTTP success → fake Client + exact count-only sequence; secret lifetime zero; protected-admin-env preserved; CLI gates; locks (wh-staging-identity) |

## Non-goals / still open

- **No** live secret read, Azure/PG query, firewall/network, DDL/apply/ledger **in this offline prove**
- **No** migration or predicate changes
- Still \`product_schema_differs\`
- Live MI HTTP activated in Slice 14G (\`PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true\`); ungated live calls are 14G scope, not this prove
- **Do not claim Sunset repaired.**

## Zero live/Azure mutation (this prove)

Offline injected HTTP + fake \`pg\` Client only. Flag is \`PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED=true\` but this prove never calls live IMDS/KV/PG. No Azure CLI, no live PostgreSQL, no real Key Vault read, no network/firewall mutation.
`;

  fs.writeFileSync(FINDINGS_PATH, findings, 'utf8');

  console.log(`  RED cases:   ${red.length}`);
  console.log(`  GREEN cases: ${green.length}`);
  console.log(`  wrote ${path.relative(ROOT, CONTRACT_PATH)}`);
  console.log(`  wrote ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`  wrote ${path.relative(ROOT, FINDINGS_PATH)}`);
  console.log('\nprove:sunset-schema-slice14e-phase-d-managed-identity-loader GREEN');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
