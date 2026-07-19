'use strict';

/**
 * FOUNDATION Slice 14E — Phase D managed-identity credential loader
 *
 * In-process loader that obtains protected admin credentials from Lunabox
 * managed identity + the exact Sunset staging Key Vault secret
 * `sunset-database-url`, then hands user/password privately to the 14D
 * adapter path.
 *
 * This slice keeps live HTTP hard-disabled: only an injected `httpRequest`
 * may run (offline proof). No real IMDS / Key Vault / PostgreSQL call.
 *
 * Never prints, returns, persists, hashes, evidences, argv-embeds, temp-files,
 * or child-process-envs the IMDS token, DSN, or credentials.
 */

const {
  TARGETS,
  buildLockedAdminConnectConfig,
  secretFreeConnectInfo,
  assertLockedConnectConfig,
  redactSecrets,
  redactDeep,
  REDACTED,
} = require('./phase-d-live-readonly-boundary');
const { parseDatabaseUrl } = require('./sunset-schema-observer');

/** Live IMDS/KV HTTP remains hard-disabled in Slice 14E. */
const PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED = false;

const CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV = 'protected-admin-env';
const CREDENTIAL_SOURCE_MANAGED_IDENTITY = 'managed-identity';

const ENV_CREDENTIAL_SOURCE = 'SUNSET_PHASE_D_CREDENTIAL_SOURCE';
const CLI_CREDENTIAL_SOURCE = '--credential-source';

/** Locked IMDS / Key Vault / secret / audience / API versions. */
const MI_LOADER_LOCKS = Object.freeze({
  imdsHost: '169.254.169.254',
  imdsScheme: 'http',
  imdsPath: '/metadata/identity/oauth2/token',
  imdsApiVersion: '2018-02-01',
  vaultResourceAudience: 'https://vault.azure.net',
  keyVaultName: 'luna-sunset-staging-kv',
  keyVaultHttpsUrl: 'https://luna-sunset-staging-kv.vault.azure.net',
  secretName: 'sunset-database-url',
  keyVaultApiVersion: '7.4',
  /** User-assigned MI client id for luna-sunset-staging-identity (not a secret). */
  managedIdentityClientId: '0e05fbe3-e8c5-48aa-a914-30aed284e6f7',
  postgresHost: TARGETS.postgresHost,
  database: TARGETS.database,
  sslmode: TARGETS.sslmode,
  port: TARGETS.port,
});

/** Process-local counters — prove default path makes zero HTTP calls. */
let httpRequestCount = 0;
let imdsRequestCount = 0;
let keyVaultRequestCount = 0;

function getManagedIdentityHttpCounters() {
  return {
    httpRequestCount,
    imdsRequestCount,
    keyVaultRequestCount,
  };
}

function resetManagedIdentityHttpCounters() {
  httpRequestCount = 0;
  imdsRequestCount = 0;
  keyVaultRequestCount = 0;
}

function buildLockedImdsTokenUrl() {
  const q = new URLSearchParams({
    'api-version': MI_LOADER_LOCKS.imdsApiVersion,
    resource: MI_LOADER_LOCKS.vaultResourceAudience,
    client_id: MI_LOADER_LOCKS.managedIdentityClientId,
  });
  return (
    `${MI_LOADER_LOCKS.imdsScheme}://${MI_LOADER_LOCKS.imdsHost}`
    + `${MI_LOADER_LOCKS.imdsPath}?${q.toString()}`
  );
}

function buildLockedKeyVaultSecretUrl() {
  return (
    `${MI_LOADER_LOCKS.keyVaultHttpsUrl}/secrets/`
    + `${encodeURIComponent(MI_LOADER_LOCKS.secretName)}`
    + `?api-version=${MI_LOADER_LOCKS.keyVaultApiVersion}`
  );
}

function parseArgvCredentialSource(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === CLI_CREDENTIAL_SOURCE) {
      return i + 1 < args.length ? String(args[i + 1]) : '';
    }
    if (a.startsWith(`${CLI_CREDENTIAL_SOURCE}=`)) {
      return a.slice(CLI_CREDENTIAL_SOURCE.length + 1);
    }
  }
  return null;
}

/**
 * Resolve credential source.
 * managed-identity requires BOTH env and argv exactly equal to managed-identity.
 * Missing both → protected-admin-env (legacy 14D injected/offline proof path).
 * Mismatch / unknown → rejected.
 */
function evaluateCredentialSource(opts) {
  const options = opts || {};
  const env = options.env || {};
  const argv = options.argv || [];
  const envRaw = String(env[ENV_CREDENTIAL_SOURCE] || '').trim();
  const argvRaw = parseArgvCredentialSource(argv);
  const errors = [];

  if (!envRaw && (argvRaw == null || argvRaw === '')) {
    return {
      ok: true,
      source: CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV,
      explicit: false,
      errors: [],
    };
  }

  if (envRaw === CREDENTIAL_SOURCE_MANAGED_IDENTITY
    && argvRaw === CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    return {
      ok: true,
      source: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
      explicit: true,
      errors: [],
    };
  }

  if (envRaw === CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV
    && (argvRaw == null || argvRaw === '' || argvRaw === CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV)) {
    return {
      ok: true,
      source: CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV,
      explicit: true,
      errors: [],
    };
  }

  if (argvRaw === CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV
    && (!envRaw || envRaw === CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV)) {
    return {
      ok: true,
      source: CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV,
      explicit: true,
      errors: [],
    };
  }

  if (envRaw === CREDENTIAL_SOURCE_MANAGED_IDENTITY
    || argvRaw === CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `managed-identity requires both env ${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY} and ${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
    });
    return { ok: false, source: null, explicit: true, errors };
  }

  errors.push({
    code: 'unknown_credential_source',
    message: `credential source must be ${CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV} or ${CREDENTIAL_SOURCE_MANAGED_IDENTITY}`,
  });
  return { ok: false, source: null, explicit: true, errors };
}

function sanitizeLoaderError(err, secrets) {
  const list = (secrets || []).filter(Boolean).map(String);
  const raw = String((err && err.message) || err || 'managed_identity_loader_failed').slice(0, 240);
  let message = redactSecrets(raw, list)
    .replace(/postgres(?:ql)?:\/\/[^:\s/@]+:[^@\s/]+@/gi, `postgresql://${REDACTED}:`)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g, REDACTED)
    // Generic password-bearing / credential-shaped fragments even before secrets are known.
    .replace(/(password|passwd|pwd)\s*[=:]\s*([^\s&;,"']+)/gi, `$1=${REDACTED}`)
    .replace(/(user(name)?)\s*[=:]\s*([^\s&;,"']+)/gi, `$1=${REDACTED}`)
    .replace(/(access_token|client_secret|token)\s*[=:]\s*([^\s&;,"']+)/gi, `$1=${REDACTED}`);
  return Object.assign(new Error(message), {
    code: (err && err.code) || 'managed_identity_loader_failed',
  });
}

/**
 * Null out private credential / token / DSN references in-place.
 * Does not return secret values.
 */
function zeroPrivateCredentialRefs(bag) {
  if (!bag || typeof bag !== 'object') {
    return { zeroed: false };
  }
  const keys = [
    '_user',
    '_password',
    '_token',
    '_dsn',
    '_secretValue',
    '_accessToken',
    'password',
    'user',
    'token',
    'access_token',
    'value',
  ];
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(bag, k)) {
      try { bag[k] = null; } catch (_) { /* ignore non-writable */ }
    }
  }
  if (bag._connectConfig && typeof bag._connectConfig === 'object') {
    try {
      bag._connectConfig._user = null;
      bag._connectConfig._password = null;
    } catch (_) { /* ignore */ }
    bag._connectConfig = null;
  }
  return { zeroed: true };
}

function assertNoCallerOverrides(opts) {
  const options = opts || {};
  const forbidden = [
    'imdsUrl',
    'imdsHost',
    'vaultUrl',
    'keyVaultUrl',
    'keyVaultName',
    'secretName',
    'resource',
    'vaultResourceAudience',
    'token',
    'accessToken',
    'dsn',
    'connectionString',
    'databaseUrl',
    'user',
    'password',
    'clientId',
    'managedIdentityClientId',
    'apiVersion',
  ];
  const hits = [];
  for (const key of forbidden) {
    if (options[key] != null) hits.push(key);
  }
  if (hits.length > 0) {
    return {
      ok: false,
      errors: [{
        code: 'caller_supplied_loader_override_forbidden',
        message: `caller must not supply ${hits.join(',')}`,
        keys: hits,
      }],
    };
  }
  return { ok: true, errors: [] };
}

/**
 * Parse sunset-database-url secret value in memory only.
 * Extracts user/password, validates exact host/database/tls.
 * Never returns the raw DSN.
 */
function parseSunsetDatabaseUrlSecretInMemory(secretValue) {
  const raw = String(secretValue == null ? '' : secretValue);
  const secretsForRedact = [raw];
  let password = '';
  let user = '';

  try {
    const parsed = parseDatabaseUrl(raw);
    if (!parsed.ok) {
      return {
        ok: false,
        errors: [{
          code: 'secret_dsn_parse_failed',
          message: 'sunset-database-url is not a usable admin DSN shape',
        }],
      };
    }
    if (!parsed.parsed.user || !parsed.parsed.hasPassword) {
      return {
        ok: false,
        errors: [{
          code: 'secret_dsn_credentials_missing',
          message: 'sunset-database-url must include user and password',
        }],
      };
    }
    if (parsed.parsed.host !== MI_LOADER_LOCKS.postgresHost) {
      return {
        ok: false,
        errors: [{
          code: 'secret_wrong_postgres_host',
          message: 'sunset-database-url host is not locked Sunset staging host',
        }],
      };
    }
    if (parsed.parsed.database !== MI_LOADER_LOCKS.database) {
      return {
        ok: false,
        errors: [{
          code: 'secret_wrong_database',
          message: 'sunset-database-url database is not sunset_staging',
        }],
      };
    }
    if (parsed.parsed.sslmode !== MI_LOADER_LOCKS.sslmode) {
      return {
        ok: false,
        errors: [{
          code: 'secret_tls_not_verify_full',
          message: 'sunset-database-url must use sslmode=verify-full',
        }],
      };
    }
    if (Number(parsed.parsed.port) !== MI_LOADER_LOCKS.port) {
      return {
        ok: false,
        errors: [{
          code: 'secret_wrong_port',
          message: `sunset-database-url port must be exactly ${MI_LOADER_LOCKS.port}`,
        }],
      };
    }

    const url = new URL(raw);
    user = decodeURIComponent(url.username || '');
    password = decodeURIComponent(url.password || '');
    secretsForRedact.push(user, password);

    if (!user || !password) {
      return {
        ok: false,
        errors: [{
          code: 'secret_dsn_credentials_missing',
          message: 'sunset-database-url must include user and password',
        }],
      };
    }

    const connectConfig = buildLockedAdminConnectConfig(user, password);
    const gate = assertLockedConnectConfig(connectConfig);
    if (!gate.ok) {
      return {
        ok: false,
        errors: gate.errors,
      };
    }

    return {
      ok: true,
      errors: [],
      source: 'managed_identity',
      connectInfo: secretFreeConnectInfo(connectConfig),
      // Private — never copy into evidence/output/return JSON.
      _user: user,
      _password: password,
      _connectConfig: connectConfig,
    };
  } catch (err) {
    const safe = sanitizeLoaderError(err, secretsForRedact);
    return {
      ok: false,
      errors: [{ code: safe.code, message: safe.message }],
    };
  } finally {
    // Drop local raw DSN reference; caller zeros the result bag after consume.
    secretValue = null;
  }
}

async function invokeInjectedHttp(httpRequest, request) {
  httpRequestCount += 1;
  const res = await httpRequest(request);
  if (!res || typeof res !== 'object') {
    throw Object.assign(new Error('injected http returned no response object'), {
      code: 'http_response_invalid',
    });
  }
  const statusCode = Number(res.statusCode);
  if (!Number.isFinite(statusCode)) {
    throw Object.assign(new Error('injected http missing statusCode'), {
      code: 'http_status_invalid',
    });
  }
  if (statusCode >= 300 && statusCode < 400) {
    throw Object.assign(new Error('http redirect rejected'), {
      code: 'http_redirect_rejected',
    });
  }
  if (statusCode !== 200) {
    throw Object.assign(new Error(`http status ${statusCode} rejected`), {
      code: 'http_status_rejected',
    });
  }
  return res;
}

/**
 * Fetch IMDS token via injected HTTP only (live HTTP hard-disabled).
 * Token stays in memory; never returned on the public result.
 */
async function fetchImdsAccessToken(opts) {
  const options = opts || {};
  const httpRequest = options.httpRequest;
  if (typeof httpRequest !== 'function') {
    if (PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true) {
      throw Object.assign(new Error('live IMDS HTTP not available in this slice'), {
        code: 'live_http_disabled',
      });
    }
    throw Object.assign(new Error('managed-identity HTTP disabled (inject httpRequest for offline proof)'), {
      code: 'http_disabled',
    });
  }

  const url = new URL(buildLockedImdsTokenUrl());
  if (url.hostname !== MI_LOADER_LOCKS.imdsHost) {
    throw Object.assign(new Error('IMDS host lock violated'), { code: 'imds_host_rejected' });
  }
  if (url.searchParams.get('resource') !== MI_LOADER_LOCKS.vaultResourceAudience) {
    throw Object.assign(new Error('IMDS vault audience lock violated'), {
      code: 'imds_audience_rejected',
    });
  }
  if (url.searchParams.get('api-version') !== MI_LOADER_LOCKS.imdsApiVersion) {
    throw Object.assign(new Error('IMDS api-version lock violated'), {
      code: 'imds_api_version_rejected',
    });
  }

  imdsRequestCount += 1;
  const res = await invokeInjectedHttp(httpRequest, {
    purpose: 'imds_token',
    protocol: 'http:',
    hostname: MI_LOADER_LOCKS.imdsHost,
    port: 80,
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    headers: Object.freeze({ Metadata: 'true' }),
  });

  let body;
  try {
    body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
  } catch (_) {
    throw Object.assign(new Error('IMDS response JSON invalid'), {
      code: 'imds_json_invalid',
    });
  }
  if (!body || typeof body !== 'object' || typeof body.access_token !== 'string'
    || !body.access_token) {
    throw Object.assign(new Error('IMDS access_token missing'), {
      code: 'imds_token_missing',
    });
  }
  return body.access_token;
}

/**
 * Fetch Key Vault secret via injected HTTP only.
 * Secret value stays in memory; never returned on the public result.
 */
async function fetchKeyVaultSunsetDatabaseUrl(opts) {
  const options = opts || {};
  const httpRequest = options.httpRequest;
  const token = options._token;
  if (!token) {
    throw Object.assign(new Error('Key Vault token missing'), {
      code: 'kv_token_missing',
    });
  }
  if (typeof httpRequest !== 'function') {
    throw Object.assign(new Error('managed-identity HTTP disabled (inject httpRequest for offline proof)'), {
      code: 'http_disabled',
    });
  }

  const url = new URL(buildLockedKeyVaultSecretUrl());
  if (url.hostname !== `${MI_LOADER_LOCKS.keyVaultName}.vault.azure.net`) {
    throw Object.assign(new Error('Key Vault host lock violated'), {
      code: 'kv_host_rejected',
    });
  }

  keyVaultRequestCount += 1;
  const res = await invokeInjectedHttp(httpRequest, {
    purpose: 'keyvault_secret',
    protocol: 'https:',
    hostname: url.hostname,
    port: 443,
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    headers: Object.freeze({
      Authorization: `Bearer ${token}`,
    }),
  });

  let body;
  try {
    body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
  } catch (_) {
    throw Object.assign(new Error('Key Vault response JSON invalid'), {
      code: 'kv_json_invalid',
    });
  }
  if (!body || typeof body !== 'object' || typeof body.value !== 'string' || !body.value) {
    throw Object.assign(new Error('Key Vault secret value missing'), {
      code: 'kv_secret_missing',
    });
  }
  return body.value;
}

/**
 * Load protected admin credentials via managed identity + locked KV secret.
 * Requires explicit managed-identity credential-source flags.
 * Default / missing injection → zero HTTP.
 *
 * Public return is secret-free except private underscore fields for in-process
 * handoff to the 14D adapter. Caller must zeroPrivateCredentialRefs after use.
 */
async function loadProtectedAdminCredentialsViaManagedIdentity(opts) {
  const options = opts || {};
  const secrets = [];
  const countersBefore = getManagedIdentityHttpCounters();

  const overrideGate = assertNoCallerOverrides(options);
  if (!overrideGate.ok) {
    return redactDeep({
      ok: false,
      code: 'caller_supplied_loader_override_forbidden',
      errors: overrideGate.errors,
      source: null,
      counters: getManagedIdentityHttpCounters(),
      httpCallsDelta: 0,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    }, []);
  }

  const sourceGate = evaluateCredentialSource({
    env: options.env,
    argv: options.argv,
  });
  if (!sourceGate.ok || sourceGate.source !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    return redactDeep({
      ok: false,
      code: sourceGate.ok
        ? 'managed_identity_credential_source_flag_required'
        : (sourceGate.errors[0] && sourceGate.errors[0].code)
          || 'managed_identity_credential_source_flag_required',
      errors: sourceGate.ok
        ? [{
          code: 'managed_identity_credential_source_flag_required',
          message: `explicit ${ENV_CREDENTIAL_SOURCE}=${CREDENTIAL_SOURCE_MANAGED_IDENTITY} and ${CLI_CREDENTIAL_SOURCE} ${CREDENTIAL_SOURCE_MANAGED_IDENTITY} required`,
        }]
        : sourceGate.errors,
      source: sourceGate.source,
      counters: getManagedIdentityHttpCounters(),
      httpCallsDelta: 0,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    }, []);
  }

  if (typeof options.httpRequest !== 'function'
    && PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED !== true) {
    return redactDeep({
      ok: false,
      code: 'http_disabled',
      errors: [{
        code: 'http_disabled',
        message: 'managed-identity live HTTP disabled; inject httpRequest for offline proof only',
      }],
      source: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
      counters: getManagedIdentityHttpCounters(),
      httpCallsDelta: 0,
      liveHttpEnabled: false,
    }, []);
  }

  let token = null;
  let secretValue = null;
  try {
    token = await fetchImdsAccessToken({ httpRequest: options.httpRequest });
    secrets.push(token);
    secretValue = await fetchKeyVaultSunsetDatabaseUrl({
      httpRequest: options.httpRequest,
      _token: token,
    });
    secrets.push(secretValue);

    const parsed = parseSunsetDatabaseUrlSecretInMemory(secretValue);
    // Drop raw secret/token locals before building public view.
    token = null;
    secretValue = null;

    if (!parsed.ok) {
      zeroPrivateCredentialRefs(parsed);
      return redactDeep({
        ok: false,
        code: (parsed.errors[0] && parsed.errors[0].code) || 'secret_target_rejected',
        errors: parsed.errors,
        source: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
        counters: getManagedIdentityHttpCounters(),
        httpCallsDelta: getManagedIdentityHttpCounters().httpRequestCount
          - countersBefore.httpRequestCount,
        liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      }, secrets);
    }

    secrets.push(parsed._user, parsed._password);

    const publicView = {
      ok: true,
      code: 'managed_identity_credentials_loaded',
      source: 'managed_identity',
      connectInfo: parsed.connectInfo,
      counters: getManagedIdentityHttpCounters(),
      httpCallsDelta: getManagedIdentityHttpCounters().httpRequestCount
        - countersBefore.httpRequestCount,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
      // Private in-process handoff only — never serialize to evidence.
      _user: parsed._user,
      _password: parsed._password,
      _connectConfig: parsed._connectConfig,
    };
    // Clear intermediate parsed bag refs that duplicate private fields.
    parsed._user = null;
    parsed._password = null;
    parsed._connectConfig = null;
    return publicView;
  } catch (err) {
    const safe = sanitizeLoaderError(err, secrets);
    return redactDeep({
      ok: false,
      code: safe.code,
      errors: [{ code: safe.code, message: safe.message }],
      source: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
      counters: getManagedIdentityHttpCounters(),
      httpCallsDelta: getManagedIdentityHttpCounters().httpRequestCount
        - countersBefore.httpRequestCount,
      liveHttpEnabled: PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true,
    }, secrets);
  } finally {
    token = null;
    secretValue = null;
  }
}

/**
 * Build an injected HTTP router for offline proof.
 * Only exact locked IMDS + KV URLs succeed; everything else rejects.
 * Never logs token/DSN/password.
 */
function createInjectedManagedIdentityHttp(script) {
  const s = script || {};
  const imdsUrl = new URL(buildLockedImdsTokenUrl());
  const kvUrl = new URL(buildLockedKeyVaultSecretUrl());
  const calls = [];

  async function httpRequest(req) {
    const request = req || {};
    calls.push({
      purpose: request.purpose || null,
      hostname: request.hostname || null,
      path: request.path ? String(request.path).split('?')[0] : null,
      method: request.method || null,
      // Never record Authorization / token / body secrets.
      hasAuthorization: Boolean(
        request.headers && request.headers.Authorization,
      ),
    });

    if (s.throwOn && s.throwOn === request.purpose) {
      const e = s.throwError || new Error('injected http failure');
      if (s.passwordBearingError && s.secretPassword) {
        throw Object.assign(
          new Error(`${e.message} password=${s.secretPassword}`),
          { code: e.code || 'injected_http_failed' },
        );
      }
      throw Object.assign(new Error(e.message), { code: e.code || 'injected_http_failed' });
    }

    if (request.purpose === 'imds_token') {
      if (request.hostname !== MI_LOADER_LOCKS.imdsHost) {
        return { statusCode: 400, body: '{"error":"wrong_imds_host"}' };
      }
      if (request.headers && request.headers.Metadata !== 'true') {
        return { statusCode: 400, body: '{"error":"metadata_header_required"}' };
      }
      const pathFull = String(request.path || '');
      if (!pathFull.startsWith(imdsUrl.pathname)) {
        return { statusCode: 404, body: '{"error":"wrong_imds_path"}' };
      }
      if (s.imdsStatusCode && s.imdsStatusCode !== 200) {
        return {
          statusCode: s.imdsStatusCode,
          headers: s.imdsRedirectLocation
            ? { location: s.imdsRedirectLocation }
            : {},
          body: s.imdsBody || '{"error":"imds_failed"}',
        };
      }
      if (s.imdsInvalidJson) {
        return { statusCode: 200, body: '{not-json' };
      }
      if (s.imdsMissingToken) {
        return { statusCode: 200, body: '{"token_type":"Bearer"}' };
      }
      const token = s.imdsAccessToken || 'slice14e-proof-imds-token-never-commit';
      return {
        statusCode: 200,
        body: JSON.stringify({
          access_token: token,
          expires_in: 3600,
          token_type: 'Bearer',
          resource: MI_LOADER_LOCKS.vaultResourceAudience,
        }),
      };
    }

    if (request.purpose === 'keyvault_secret') {
      if (request.hostname !== kvUrl.hostname) {
        return { statusCode: 400, body: '{"error":"wrong_kv_host"}' };
      }
      const pathFull = String(request.path || '');
      if (!pathFull.startsWith(kvUrl.pathname)) {
        return { statusCode: 404, body: '{"error":"wrong_secret"}' };
      }
      if (s.kvStatusCode && s.kvStatusCode !== 200) {
        return {
          statusCode: s.kvStatusCode,
          headers: s.kvRedirectLocation
            ? { location: s.kvRedirectLocation }
            : {},
          body: s.kvBody || '{"error":"kv_failed"}',
        };
      }
      if (s.kvInvalidJson) {
        return { statusCode: 200, body: '{not-json' };
      }
      if (s.kvMissingValue) {
        return { statusCode: 200, body: '{"attributes":{}}' };
      }
      const value = Object.prototype.hasOwnProperty.call(s, 'secretValue')
        ? s.secretValue
        : s.defaultSecretValue;
      return {
        statusCode: 200,
        body: JSON.stringify({ value, contentType: 'text/plain' }),
      };
    }

    return { statusCode: 400, body: '{"error":"unknown_purpose"}' };
  }

  httpRequest.calls = calls;
  httpRequest.reset = () => { calls.length = 0; };
  return httpRequest;
}

/**
 * Build a valid locked sunset-database-url secret value for offline proof only.
 * Not exported via evidence — proof scripts keep it local and leak-scan.
 */
function buildOfflineProofSunsetDatabaseUrl(user, password) {
  const u = encodeURIComponent(String(user));
  const p = encodeURIComponent(String(password));
  return (
    `postgresql://${u}:${p}@${MI_LOADER_LOCKS.postgresHost}:${MI_LOADER_LOCKS.port}`
    + `/${MI_LOADER_LOCKS.database}?sslmode=${MI_LOADER_LOCKS.sslmode}`
  );
}

module.exports = {
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  CREDENTIAL_SOURCE_PROTECTED_ADMIN_ENV,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  MI_LOADER_LOCKS,
  buildLockedImdsTokenUrl,
  buildLockedKeyVaultSecretUrl,
  evaluateCredentialSource,
  parseArgvCredentialSource,
  parseSunsetDatabaseUrlSecretInMemory,
  loadProtectedAdminCredentialsViaManagedIdentity,
  zeroPrivateCredentialRefs,
  sanitizeLoaderError,
  createInjectedManagedIdentityHttp,
  buildOfflineProofSunsetDatabaseUrl,
  getManagedIdentityHttpCounters,
  resetManagedIdentityHttpCounters,
  assertNoCallerOverrides,
};
