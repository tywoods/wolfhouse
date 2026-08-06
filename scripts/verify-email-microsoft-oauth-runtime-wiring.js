'use strict';

/**
 * Hostile offline gate for Stage 6 Sunset-staging Microsoft OAuth runtime wiring.
 *
 * Proves exact DI/config shapes; full route E2E with fake HTTPS (token + OIDC
 * JWKS + Graph) via Module._load intercept of node:https before re-requiring the
 * production staff route (no injectable native route dependency substitution) and
 * production Azure KV envelope path via Module._load SDK mocks (no
 * envelopeProvider production DI / DEPENDENCY_KEYS_WITH_ENVELOPE bypass);
 * stateful transaction+installer SQL; start body exact {location_id,endpoint_id}
 * via snapshotStartBody once; callback consume→exchange→identity→seal→atomic
 * install; public authorization_received only after commit. Failure matrix keeps
 * fixed terminal HTML, no false success, consumed semantics, no partial DB, no
 * raw token persistence/logs. Asserts network order and no DB BEGIN across
 * external I/O. Disabled routes construct zero completing runtime deps.
 *
 * Standalone runtime factory retains exact controlled native deps as its
 * composition contract; production route always wraps node natives itself.
 *
 * No Azure/Microsoft live network. No activation/deploy/migration apply.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { EventEmitter } = require('events');

const {
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  DEPENDENCY_KEYS,
  createSunsetStagingMicrosoftOAuthCallbackRuntime,
} = require('./lib/email-microsoft-oauth-sunset-staging-runtime-composition');
const {
  createStaffEmailOAuthRoutes,
  OAUTH_START_PATH,
  OAUTH_CALLBACK_PATH,
  SQL_RESOLVE_START_BINDING,
  START_BODY_KEYS,
  validBody,
} = require('./lib/staff-email-oauth-routes');
const {
  SQL_CREATE_TRANSACTION,
  SQL_CONSUME_TRANSACTION,
  INPUT_KEYS,
  REDIRECT_URI,
  isStartEnabled,
  isCallbackEnabled,
} = require('./lib/email-microsoft-oauth-transaction-service');
const {
  TOKEN_HOST,
  TOKEN_PATH,
} = require('./lib/email-microsoft-token-http-transport');
const {
  SUNSET_STAGING_TRUSTED_HOST,
  SUNSET_STAGING_VERSIONED_KEY_ID,
  SUNSET_STAGING_MI_CLIENT_ID,
  SUNSET_STAGING_KEK_KEY_NAME,
  SUNSET_STAGING_KEK_KEY_VERSION,
  ENV_COMPOSITION_ENABLED,
  ENV_TRUSTED_HOST,
  ENV_VERSIONED_KEY_ID,
} = require('./lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const LIB_REL = 'scripts/lib/email-microsoft-oauth-sunset-staging-runtime-composition.js';
const ROUTES_REL = 'scripts/lib/staff-email-oauth-routes.js';
const VERIFY_REL = 'scripts/verify-email-microsoft-oauth-runtime-wiring.js';

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const LOCATION_UUID = '22222222-2222-2222-2222-222222222222';
const ENDPOINT_ID = '55555555-5555-5555-5555-555555555555';
const OTHER_ENDPOINT_ID = '66666666-6666-6666-6666-666666666666';
const STAFF_ID = '33333333-3333-3333-3333-333333333333';
const SESSION_ID = '44444444-4444-4444-4444-444444444444';
const APP_CLIENT_ID = '55555555-5555-5555-5555-555555555555';
const TID = '01234567-89ab-4def-8123-456789abcdef';
const PRINCIPAL = '01234567-89ab-4def-9123-456789abcdef';
const MAILBOX = 'ada@example.com';
const DISPLAY = 'Ada Lovelace';
const LOCATION_SLUG = 'sunset-somo';
const SECRET = 'client-secret-NEVER_LOG';
const ACCESS = 'ACCESS_SECRET_NEVER_LEAK_9c2b';
const REFRESH = 'REFRESH_SECRET_NEVER_LEAK_3d4e';
const GOOD_SCOPE = 'openid profile offline_access User.Read Mail.ReadBasic';
const CODE = 'provider-auth-code+/%?=opaque';
const LEAK = 'RUNTIME-WIRING-SECRET-DO-NOT-LEAK';
const KID = 'runtime-wiring-kid-1';

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const exportedJwk = pair.publicKey.export({ format: 'jwk' });

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

function frozenRecord(object) {
  return Object.freeze(object);
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createIdToken(claimsPatch = {}, headerPatch = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: KID, typ: 'JWT', ...headerPatch };
  const claims = {
    tid: TID,
    oid: PRINCIPAL,
    sub: 'subject-1',
    aud: APP_CLIENT_ID,
    nonce: 'n'.repeat(43),
    iss: `https://login.microsoftonline.com/${TID}/v2.0`,
    exp: now + 600,
    iat: now - 1,
    nbf: now - 1,
    ...claimsPatch,
  };
  const encodedHeader = encodeJson(header);
  const encodedClaims = encodeJson(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), pair.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function validJwks() {
  return JSON.stringify({
    keys: [{ ...exportedJwk, kid: KID, use: 'sig', alg: 'RS256' }],
  });
}

function goodTokenBody(patch = {}) {
  return {
    token_type: 'Bearer',
    expires_in: 3600,
    scope: GOOD_SCOPE,
    access_token: ACCESS,
    refresh_token: REFRESH,
    id_token: createIdToken(),
    ...patch,
  };
}

function azureEnvPatch() {
  return {
    [ENV_COMPOSITION_ENABLED]: 'true',
    [ENV_TRUSTED_HOST]: SUNSET_STAGING_TRUSTED_HOST,
    [ENV_VERSIONED_KEY_ID]: SUNSET_STAGING_VERSIONED_KEY_ID,
  };
}

function goodEnv(patch = {}) {
  return {
    LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_START_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID,
    LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET,
    ...azureEnvPatch(),
    ...patch,
  };
}

function startBody(overrides = {}) {
  const body = {};
  body.location_id = Object.prototype.hasOwnProperty.call(overrides, 'location_id')
    ? overrides.location_id
    : LOCATION_SLUG;
  body.endpoint_id = Object.prototype.hasOwnProperty.call(overrides, 'endpoint_id')
    ? overrides.endpoint_id
    : ENDPOINT_ID;
  return body;
}

function user(patch = {}) {
  return {
    client_slug: 'sunset',
    client_id: CLIENT_ID,
    staff_user_id: STAFF_ID,
    session_id: SESSION_ID,
    ...patch,
  };
}

function resCapture() {
  return {
    status: null,
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(v) { this.body = v; },
  };
}

function sendJSON(r, s, b) {
  r.status = s;
  r.statusCode = s;
  r.body = b;
  return b;
}

function assertNoSensitive(blob) {
  const s = typeof blob === 'string' ? blob : (() => {
    try { return JSON.stringify(blob); } catch { return String(blob); }
  })();
  assert.equal(s.includes(LEAK), false);
  assert.equal(s.includes(SECRET), false);
  assert.equal(s.includes(ACCESS), false);
  assert.equal(s.includes(REFRESH), false);
  assert.equal(s.includes(CODE), false);
}

function failSanitized(error) {
  return error
    && error.name === 'MicrosoftOAuthRuntimeCompositionError'
    && error.code === ERROR_CODE
    && error.message === ERROR_MESSAGE
    && Object.isFrozen(error)
    && !String(error.message).includes(SECRET)
    && !String(error.stack || '').includes(SECRET);
}

/**
 * Module._load intercept for @azure/* — same pattern as Azure envelope composition
 * verifier. Production factory has no envelopeProvider DI.
 */
function installAzureSdkSpies() {
  const counters = {
    mic: 0,
    cc: 0,
    wrap: 0,
    unwrap: 0,
    idLoad: 0,
    kvLoad: 0,
    dac: 0,
    keyClient: 0,
    micClientId: null,
    ccKeyId: null,
    ccOptions: null,
  };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const wrapOpts = {
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  };
  const unwrapOpts = {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  };

  function makeClient(keyId) {
    class PrototypeCryptographyClient {
      constructor() {
        this.keyId = keyId;
        this.marker = { keyId };
      }

      async wrapKey(algorithm, key) {
        counters.wrap += 1;
        if (this.marker.keyId !== keyId) throw new Error('wrap this lost');
        return {
          result: crypto.publicEncrypt(wrapOpts, Buffer.isBuffer(key) ? key : Buffer.from(key)),
          algorithm,
          keyID: keyId,
        };
      }

      async unwrapKey(algorithm, encryptedKey) {
        counters.unwrap += 1;
        if (this.marker.keyId !== keyId) throw new Error('unwrap this lost');
        return {
          result: crypto.privateDecrypt(unwrapOpts, Buffer.isBuffer(encryptedKey)
            ? encryptedKey
            : Buffer.from(encryptedKey)),
          algorithm,
          keyID: keyId,
        };
      }
    }
    return new PrototypeCryptographyClient();
  }

  function ManagedIdentityCredential(clientId) {
    counters.mic += 1;
    counters.micClientId = clientId;
    return Object.freeze({ kind: 'spy-mic', clientId });
  }
  function CryptographyClient(keyId, credential, options) {
    counters.cc += 1;
    counters.ccKeyId = keyId;
    counters.ccOptions = options;
    return makeClient(keyId);
  }
  function DefaultAzureCredential() {
    counters.dac += 1;
    throw new Error('DAC forbidden');
  }
  function KeyClient() {
    counters.keyClient += 1;
    throw new Error('KeyClient forbidden');
  }

  const realLoad = Module._load;
  Module._load = function interceptAzure(request, parent, isMain) {
    if (request === '@azure/identity') {
      counters.idLoad += 1;
      return { ManagedIdentityCredential, DefaultAzureCredential };
    }
    if (request === '@azure/keyvault-keys') {
      counters.kvLoad += 1;
      return { CryptographyClient, KeyClient };
    }
    if (typeof request === 'string' && request.startsWith('@azure/')) {
      throw new Error(`unexpected ${request}`);
    }
    return realLoad(request, parent, isMain);
  };

  // Drop cached real Azure modules if any so intercept wins.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}@azure${path.sep}`) || key.includes('/@azure/')) {
      delete require.cache[key];
    }
  }

  return {
    counters,
    restore() {
      Module._load = realLoad;
    },
  };
}

/**
 * Stateful SQL fake covering OAuth create/consume + installer TX.
 * Tracks BEGIN across external I/O via timeline.
 */
function createStatefulDb(spec = {}) {
  const timeline = [];
  const endpoints = [{
    id: ENDPOINT_ID,
    client_id: CLIENT_ID,
    location_id: LOCATION_SLUG,
    provider: 'microsoft_graph',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: spec.bindingStatus || 'unverified_offline',
    public_address: MAILBOX,
  }];
  if (spec.extraEndpoint) {
    endpoints.push(spec.extraEndpoint);
  }
  const locations = [{
    id: LOCATION_UUID,
    client_id: CLIENT_ID,
    location_id: LOCATION_SLUG,
    active: true,
  }];
  if (spec.extraLocation) {
    locations.push(spec.extraLocation);
  }
  const clients = [{ id: CLIENT_ID, slug: 'sunset' }];
  const txns = [];
  const grants = [];
  let began = false;

  function norm(sql) {
    return String(sql).replace(/\s+/g, ' ').trim();
  }

  const client = {
    async query(sql, params = []) {
      const n = norm(sql);
      timeline.push({ kind: 'sql', sql: n, params, began });

      if (n === 'BEGIN') {
        began = true;
        return { rows: [] };
      }
      if (n === 'COMMIT') {
        began = false;
        return { rows: [] };
      }
      if (n === 'ROLLBACK') {
        began = false;
        return { rows: [] };
      }

      if (n === norm(SQL_RESOLVE_START_BINDING)) {
        const slug = params[0];
        const endpointId = params[1];
        const rows = [];
        for (const c of clients) {
          if (c.slug !== 'sunset') continue;
          for (const l of locations) {
            if (l.client_id !== c.id || l.location_id !== slug || !l.active) continue;
            for (const e of endpoints) {
              if (e.client_id !== c.id || e.location_id !== l.location_id) continue;
              if (e.id !== endpointId) continue;
              if (e.provider !== 'microsoft_graph') continue;
              if (e.auth_mode !== 'delegated_authorization_code') continue;
              if (e.connector_mode !== 'microsoft_delegated_oauth') continue;
              if (e.binding_status !== 'unverified_offline'
                  && e.binding_status !== 'pending_manual_validation') continue;
              if (!e.public_address) continue;
              rows.push({
                client_id: c.id,
                location_id: l.id,
                endpoint_id: e.id,
              });
            }
          }
        }
        if (spec.duplicateStartRows) {
          return { rows: rows.concat(rows) };
        }
        return { rows };
      }

      if (n === norm(SQL_CREATE_TRANSACTION)) {
        const [clientId, locationId, staffUserId, authSessionId, endpointId,
          stateHash, codeVerifier, nonce, issuedAt, expiresAt] = params;
        const ep = endpoints.find((e) => e.id === endpointId && e.client_id === clientId
          && e.provider === 'microsoft_graph'
          && e.auth_mode === 'delegated_authorization_code'
          && e.connector_mode === 'microsoft_delegated_oauth'
          && (e.binding_status === 'unverified_offline' || e.binding_status === 'pending_manual_validation'));
        const tl = locations.find((l) => l.id === locationId && l.client_id === clientId
          && ep && l.location_id === ep.location_id);
        if (!ep || !tl) return { rows: [] };
        const row = {
          id: crypto.randomUUID(),
          client_id: clientId,
          location_id: locationId,
          staff_user_id: staffUserId,
          auth_session_id: authSessionId,
          endpoint_id: endpointId,
          state_hash: stateHash,
          code_verifier: codeVerifier,
          nonce,
          issued_at: issuedAt,
          expires_at: expiresAt,
          consumed_at: null,
        };
        txns.push(row);
        return { rows: [{ expires_at: expiresAt }] };
      }

      if (n === norm(SQL_CONSUME_TRANSACTION)) {
        const [stateHash, clientId, authSessionId, now] = params;
        const hit = txns.find((r) => Buffer.isBuffer(r.state_hash)
          && r.state_hash.equals(stateHash)
          && r.client_id === clientId
          && r.auth_session_id === authSessionId
          && r.consumed_at == null
          && r.expires_at > now);
        if (!hit) return { rows: [] };
        hit.consumed_at = now;
        return {
          rows: [{
            id: hit.id,
            location_id: hit.location_id,
            staff_user_id: hit.staff_user_id,
            code_verifier: hit.code_verifier,
            nonce: hit.nonce,
            endpoint_id: hit.endpoint_id,
          }],
        };
      }

      if (n.includes('FOR UPDATE') && n.includes('tenant_channel_endpoints')) {
        const [clientId, endpointId] = params;
        const ep = endpoints.find((e) => e.id === endpointId && e.client_id === clientId);
        if (!ep) return { rows: [] };
        return {
          rows: [{
            id: ep.id,
            client_id: ep.client_id,
            provider: ep.provider,
            auth_mode: ep.auth_mode,
            connector_mode: ep.connector_mode,
            binding_status: ep.binding_status,
            public_address: ep.public_address,
          }],
        };
      }

      if (n.startsWith('INSERT INTO tenant_email_delegated_grants')) {
        if (spec.failInsert) return { rows: [] };
        const [clientId, endpointId, operationId] = params;
        grants.push({
          client_id: clientId,
          endpoint_id: endpointId,
          grant_generation: 1,
          grant_status: 'active',
          reconcile_state: 'clean',
          last_operation_id: operationId,
          envelope_version: params[3],
          has_refresh_raw: false,
        });
        return {
          rows: [{
            client_id: clientId,
            endpoint_id: endpointId,
            grant_generation: 1,
            grant_status: 'active',
            reconcile_state: 'clean',
          }],
        };
      }

      if (n.startsWith('UPDATE tenant_channel_endpoints')) {
        if (spec.failUpdate) return { rows: [] };
        const [clientId, endpointId, tenantId, principalOid, resourceId, , bindingCas, mailbox] = params;
        const ep = endpoints.find((e) => e.id === endpointId && e.client_id === clientId);
        if (!ep || ep.binding_status !== bindingCas || ep.public_address !== mailbox) {
          return { rows: [] };
        }
        ep.binding_status = 'verified';
        ep.provider_tenant_id = tenantId;
        ep.provider_principal_oid = principalOid;
        ep.provider_resource_id = resourceId;
        ep.mailbox_kind = 'user';
        ep.mailbox_access_kind = 'own_user';
        return {
          rows: [{
            id: ep.id,
            client_id: ep.client_id,
            binding_status: 'verified',
            provider_tenant_id: tenantId,
            provider_principal_oid: principalOid,
            provider_resource_id: resourceId,
            mailbox_kind: 'user',
            mailbox_access_kind: 'own_user',
            public_address: ep.public_address,
          }],
        };
      }

      return { rows: [] };
    },
  };

  return {
    client,
    timeline,
    endpoints,
    locations,
    txns,
    grants,
    isBegan: () => began,
  };
}

/**
 * Multiplexed fake HTTPS: token POST, JWKS GET, Graph /me GET.
 * Records call order and rejects if DB is in BEGIN during network.
 */
function createMultiplexHttps(db, spec = {}) {
  const calls = [];

  function makeIncoming(statusCode, headers, body) {
    const incoming = new EventEmitter();
    incoming.statusCode = statusCode;
    incoming.headers = headers;
    incoming.destroy = () => {};
    queueMicrotask(() => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      incoming.emit('data', Buffer.from(payload));
      incoming.emit('end');
    });
    return incoming;
  }

  const httpsImpl = frozenRecord({
    request(options, callback) {
      if (db && db.isBegan && db.isBegan()) {
        calls.push({ error: 'BEGIN_DURING_NETWORK', options });
      }
      const host = options && (options.hostname || options.host);
      const method = options && options.method;
      const reqPath = options && options.path;
      const call = {
        host,
        method,
        path: reqPath,
        options,
        body: null,
        thisValue: this,
      };
      calls.push(call);

      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = (body) => {
        call.body = body == null ? null : String(body);
        queueMicrotask(() => {
          try {
            if (host === TOKEN_HOST && method === 'POST' && reqPath === TOKEN_PATH) {
              if (spec.tokenError) {
                request.emit('error', new Error(`${LEAK} token`));
                return;
              }
              if (spec.tokenHttpError) {
                callback(makeIncoming(400, { 'content-type': 'application/json; charset=utf-8' }, { error: 'invalid_grant' }));
                return;
              }
              const tokenBody = spec.tokenBody !== undefined
                ? spec.tokenBody
                : goodTokenBody(spec.tokenPatch || {});
              callback(makeIncoming(
                200,
                { 'content-type': 'application/json; charset=utf-8' },
                typeof tokenBody === 'string' ? tokenBody : tokenBody,
              ));
              return;
            }
            if (host === 'login.microsoftonline.com'
                && method === 'GET'
                && String(reqPath).includes('/discovery/v2.0/keys')) {
              if (spec.jwksError) {
                request.emit('error', new Error(`${LEAK} jwks`));
                return;
              }
              callback(makeIncoming(
                200,
                { 'content-type': 'application/json' },
                spec.jwksBody !== undefined ? spec.jwksBody : validJwks(),
              ));
              return;
            }
            if (host === 'graph.microsoft.com' && method === 'GET') {
              if (spec.graphError) {
                request.emit('error', new Error(`${LEAK} graph`));
                return;
              }
              if (spec.graphHttpError) {
                callback(makeIncoming(401, { 'content-type': 'application/json' }, { error: 'denied' }));
                return;
              }
              const graphBody = spec.graphBody !== undefined ? spec.graphBody : {
                id: PRINCIPAL,
                displayName: DISPLAY,
                mail: MAILBOX,
                userPrincipalName: MAILBOX,
              };
              callback(makeIncoming(
                200,
                { 'content-type': 'application/json; charset=utf-8' },
                typeof graphBody === 'string' ? graphBody : graphBody,
              ));
              return;
            }
            request.emit('error', new Error(`unexpected host ${host}`));
          } catch (err) {
            request.emit('error', err);
          }
        });
      };
      return request;
    },
  });

  const timers = frozenRecord({
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
  });

  const cryptoBag = frozenRecord({
    createPublicKey(input) {
      return crypto.createPublicKey(input);
    },
    verify(...args) {
      return crypto.verify(...args);
    },
  });

  return { httpsImpl, timers, cryptoBag, calls };
}

/**
 * Load production staff OAuth routes with Module._load intercept for https
 * (and node:https) BEFORE require — same offline pattern as Azure SDK mocks.
 * Production route has no injectable native dependency keys; it always wraps
 * the module-level require('https') / require('crypto') / global timers.
 * After the route module captures the mock, Module._load is restored.
 */
function loadStaffRoutesWithHttpsMock(httpsImpl) {
  const realLoad = Module._load;
  const routePath = require.resolve('./lib/staff-email-oauth-routes');
  const mockHttps = Object.freeze({
    request(...args) {
      return Reflect.apply(httpsImpl.request, httpsImpl, args);
    },
  });
  Module._load = function interceptHttps(request, parent, isMain) {
    if (request === 'https' || request === 'node:https') {
      return mockHttps;
    }
    return realLoad(request, parent, isMain);
  };
  delete require.cache[routePath];
  try {
    return require('./lib/staff-email-oauth-routes');
  } finally {
    Module._load = realLoad;
  }
}

function buildRoutes(env, db, httpsBundle, extraDeps = {}) {
  // Route tests that need Microsoft network mock the https module via
  // Module._load — never via production route dependency substitution.
  const routesMod = loadStaffRoutesWithHttpsMock(httpsBundle.httpsImpl);
  return routesMod.createStaffEmailOAuthRoutes({
    runtimeEnv: env,
    sendJSON,
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: async (fn) => fn(db.client),
    ...extraDeps.routeDeps,
  });
}

function factoryDeps(env, db, bundle) {
  return Object.freeze({
    env,
    pgClient: db.client,
    https: bundle.httpsImpl,
    crypto: bundle.cryptoBag,
    timers: bundle.timers,
  });
}

// ── Export / package / flags ───────────────────────────────────────────────

test('exports frozen runtime factory surface and fixed error constants', async function exportSurface() {
  const exported = require('./lib/email-microsoft-oauth-sunset-staging-runtime-composition');
  assert.deepEqual(Object.keys(exported).sort(), [
    'CRYPTO_KEYS',
    'DEPENDENCY_KEYS',
    'ERROR_CODE',
    'ERROR_MESSAGE',
    'HTTPS_KEYS',
    'SUNSET_DEPLOYMENT',
    'TIMERS_KEYS',
    'createSunsetStagingMicrosoftOAuthCallbackRuntime',
  ].sort());
  assert.equal(Object.isFrozen(exported), true);
  assert.equal(ERROR_CODE, 'MICROSOFT_OAUTH_RUNTIME_COMPOSITION_INVALID');
  assert.equal(SUNSET_DEPLOYMENT, 'sunset-staging');
  assert.deepEqual([...DEPENDENCY_KEYS], ['env', 'pgClient', 'https', 'crypto', 'timers']);
  assert.equal(Object.prototype.hasOwnProperty.call(exported, 'DEPENDENCY_KEYS_WITH_ENVELOPE'), false);
});

test('package script registered; defaults remain off', async function packageAndDefaults() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  assert.equal(
    pkg.scripts['verify:email-microsoft-oauth-runtime-wiring'],
    'node scripts/verify-email-microsoft-oauth-runtime-wiring.js',
  );
  assert.equal(isStartEnabled({}), false);
  assert.equal(isCallbackEnabled({}), false);
  assert.equal(isStartEnabled({ LUNA_EMAIL_OAUTH_START_ENABLED: 'true' }), true);
  assert.equal(isCallbackEnabled({ LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true' }), true);
  assert.ok(fs.existsSync(path.join(ROOT, LIB_REL)));
  assert.ok(fs.existsSync(path.join(ROOT, VERIFY_REL)));
});

test('routes wire completing runtime behind callback flag; start binds endpoint', async function routesSourceContracts() {
  const routesSrc = fs.readFileSync(path.join(ROOT, ROUTES_REL), 'utf8');
  assert.match(routesSrc, /createSunsetStagingMicrosoftOAuthCallbackRuntime/);
  assert.match(routesSrc, /SQL_RESOLVE_START_BINDING/);
  assert.match(routesSrc, /microsoft_graph/);
  assert.match(routesSrc, /delegated_authorization_code/);
  assert.match(routesSrc, /microsoft_delegated_oauth/);
  assert.match(routesSrc, /unverified_offline/);
  assert.match(routesSrc, /pending_manual_validation/);
  assert.match(routesSrc, /endpointId/);
  assert.match(routesSrc, /e\.id = \$2::uuid/);
  assert.match(routesSrc, /snapshotStartBody/);
  assert.match(routesSrc, /snapshotResolveQueryResult/);
  assert.match(routesSrc, /productionNativeSurfaces/);
  // Module-init capture of natives; wrappers must not dynamically re-read
  // https.request / crypto methods / bare globals during callback.
  assert.match(routesSrc, /PRODUCTION_HTTPS_REQUEST/);
  assert.match(routesSrc, /PRODUCTION_CRYPTO_CREATE_PUBLIC_KEY/);
  assert.match(routesSrc, /PRODUCTION_CRYPTO_VERIFY/);
  assert.match(routesSrc, /PRODUCTION_SET_TIMEOUT/);
  assert.match(routesSrc, /PRODUCTION_CLEAR_TIMEOUT/);
  assert.match(routesSrc, /Reflect\.apply\(\s*PRODUCTION_HTTPS_REQUEST/);
  assert.match(routesSrc, /Reflect\.apply\(\s*PRODUCTION_CRYPTO_CREATE_PUBLIC_KEY/);
  assert.match(routesSrc, /Reflect\.apply\(\s*PRODUCTION_CRYPTO_VERIFY/);
  assert.match(routesSrc, /Reflect\.apply\(\s*PRODUCTION_SET_TIMEOUT/);
  assert.match(routesSrc, /Reflect\.apply\(\s*PRODUCTION_CLEAR_TIMEOUT/);
  assert.equal(/Reflect\.apply\(\s*https\.request/.test(routesSrc), false);
  assert.equal(/Reflect\.apply\(\s*crypto\.createPublicKey/.test(routesSrc), false);
  assert.equal(/Reflect\.apply\(\s*crypto\.verify/.test(routesSrc), false);
  assert.equal(/Reflect\.apply\(\s*setTimeout\s*,/.test(routesSrc), false);
  assert.equal(/Reflect\.apply\(\s*clearTimeout\s*,/.test(routesSrc), false);
  // Length must be descriptor-snapshotted, never direct-read on rows.
  assert.equal(/rows\.length/.test(routesSrc), false);
  assert.match(routesSrc, /getOwnPropertyDescriptor\(rows,\s*'length'\)/);
  assert.equal(routesSrc.includes('createMicrosoftOAuthCallbackService'), false);
  assert.equal(routesSrc.includes('oauthEnvelopeProvider'), false);
  assert.equal(routesSrc.includes('DEPENDENCY_KEYS_WITH_ENVELOPE'), false);
  assert.equal(routesSrc.includes('envelopeProvider'), false);
  // Production route must not accept native network DI substitution.
  assert.equal(routesSrc.includes('oauthHttps'), false);
  assert.equal(routesSrc.includes('oauthCrypto'), false);
  assert.equal(routesSrc.includes('oauthTimers'), false);
  assert.equal(routesSrc.includes('nativeRuntimeSurfaces'), false);
  assert.equal(routesSrc.includes('readStartBody'), false);
  assert.match(routesSrc, /isStartEnabled/);
  assert.match(routesSrc, /isCallbackEnabled/);
  const libSrc = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
  assert.match(libSrc, /createMicrosoftOAuthCallbackCompletionService/);
  assert.match(libSrc, /createMicrosoftOAuthOperationComposition/);
  assert.match(libSrc, /createMicrosoftVerifiedGrantInstaller/);
  assert.match(libSrc, /createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition/);
  assert.equal(libSrc.includes('DEPENDENCY_KEYS_WITH_ENVELOPE'), false);
  // Production exports and pinDependencies accept only DEPENDENCY_KEYS — no
  // injected envelope bag key on the public factory input surface.
  assert.equal(libSrc.includes('DEPENDENCY_KEYS_WITH_ENVELOPE'), false);
  assert.match(libSrc, /exactOrderedFrozenData\(dependencies, DEPENDENCY_KEYS\)/);
  assert.equal(/ownData\(dependencies,\s*'envelopeProvider'\)/.test(libSrc), false);
  // Offline verifier uses Module._load for https — not route DI keys.
  const verifySrc = fs.readFileSync(path.join(ROOT, VERIFY_REL), 'utf8');
  assert.match(verifySrc, /function loadStaffRoutesWithHttpsMock/);
  assert.match(verifySrc, /loadStaffRoutesWithHttpsMock\(httpsBundle\.httpsImpl\)/);
  assert.equal(/oauthHttps\s*:\s*httpsBundle/.test(verifySrc), false);
  assert.equal(/oauthCrypto\s*:\s*httpsBundle/.test(verifySrc), false);
  assert.equal(/oauthTimers\s*:\s*httpsBundle/.test(verifySrc), false);
});

// ── Factory readiness / DI ─────────────────────────────────────────────────

test('factory rejects missing readiness env and wrong deployment (fail closed)', async function factoryReadiness() {
  const azure = installAzureSdkSpies();
  try {
    const db = createStatefulDb();
    const bundle = createMultiplexHttps(db);
    const base = {
      pgClient: db.client,
      https: bundle.httpsImpl,
      crypto: bundle.cryptoBag,
      timers: bundle.timers,
    };
    const badEnvs = [
      {},
      { LUNA_DEPLOYMENT: 'production', LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true', LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID, LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET, ...azureEnvPatch() },
      { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'false', LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID, LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET, ...azureEnvPatch() },
      { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true', LUNA_EMAIL_OAUTH_CLIENT_ID: 'not-a-uuid', LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET, ...azureEnvPatch() },
      { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true', LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID, ...azureEnvPatch() }, // no secret
      goodEnv({ [ENV_COMPOSITION_ENABLED]: 'false' }), // Azure disabled
      goodEnv({ [ENV_TRUSTED_HOST]: 'wh-staging-kv.vault.azure.net' }), // wrong host
    ];
    for (const env of badEnvs) {
      assert.throws(
        () => createSunsetStagingMicrosoftOAuthCallbackRuntime(Object.freeze({
          env,
          ...base,
        })),
        failSanitized,
      );
    }
  } finally {
    azure.restore();
  }
});

test('factory rejects wrong dependency key sets / unfrozen bags / envelope injection', async function factoryHostileDeps() {
  const azure = installAzureSdkSpies();
  try {
    const db = createStatefulDb();
    const bundle = createMultiplexHttps(db);
    const env = goodEnv();
    assert.throws(() => createSunsetStagingMicrosoftOAuthCallbackRuntime(null), failSanitized);
    assert.throws(() => createSunsetStagingMicrosoftOAuthCallbackRuntime({
      env, pgClient: db.client, https: bundle.httpsImpl, crypto: bundle.cryptoBag, timers: bundle.timers,
    }), failSanitized); // unfrozen
    assert.throws(() => createSunsetStagingMicrosoftOAuthCallbackRuntime(Object.freeze({
      env, pgClient: db.client, https: bundle.httpsImpl, crypto: bundle.cryptoBag, timers: bundle.timers, extra: 1,
    })), failSanitized);
    // envelopeProvider injection rejected (not in DEPENDENCY_KEYS)
    assert.throws(() => createSunsetStagingMicrosoftOAuthCallbackRuntime(Object.freeze({
      env,
      pgClient: db.client,
      https: bundle.httpsImpl,
      crypto: bundle.cryptoBag,
      timers: bundle.timers,
      envelopeProvider: { sealGrantPayload() {}, openGrantPayload() {}, rewrapGrantDek() {} },
    })), failSanitized);
    assert.throws(() => createSunsetStagingMicrosoftOAuthCallbackRuntime(Object.freeze({
      env, pgClient: { connect() {}, query() {}, totalCount: 0, idleCount: 0, waitingCount: 0 },
      https: bundle.httpsImpl, crypto: bundle.cryptoBag, timers: bundle.timers,
    })), failSanitized);
  } finally {
    azure.restore();
  }
});

test('construction: Azure MIC/CC from validated env; zero wrap/SQL/HTTPS before accept', async function constructionNoIo() {
  const azure = installAzureSdkSpies();
  try {
    const db = createStatefulDb();
    const bundle = createMultiplexHttps(db);
    createSunsetStagingMicrosoftOAuthCallbackRuntime(factoryDeps(goodEnv(), db, bundle));
    assert.equal(db.timeline.length, 0);
    assert.equal(bundle.calls.length, 0);
    // Azure clients may construct at composition time; wrap/unwrap must stay lazy.
    assert.ok(azure.counters.idLoad >= 1);
    assert.ok(azure.counters.kvLoad >= 1);
    assert.equal(azure.counters.mic, 1);
    assert.equal(azure.counters.cc, 1);
    assert.equal(azure.counters.micClientId, SUNSET_STAGING_MI_CLIENT_ID);
    assert.equal(azure.counters.ccKeyId, SUNSET_STAGING_VERSIONED_KEY_ID);
    assert.equal(azure.counters.wrap, 0);
    assert.equal(azure.counters.unwrap, 0);
    assert.equal(azure.counters.dac, 0);
    assert.equal(azure.counters.keyClient, 0);
  } finally {
    azure.restore();
  }
});

// ── Disabled routes: zero construction / effects ───────────────────────────

test('disabled start/callback: zero pg, zero runtime construction effects', async function disabledRoutesZeroEffects() {
  let touched = false;
  const r = resCapture();
  const routes = createStaffEmailOAuthRoutes({
    runtimeEnv: {},
    sendJSON,
    assertStaffClientAccess() { touched = true; },
    withPgClient() { touched = true; throw new Error('should not'); },
  });
  await routes.handleStart(startBody(), null, r, user());
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { success: false, error: 'not_found' });
  assert.equal(touched, false);

  const r2 = resCapture();
  await routes.handleCallback({ state: 'x', code: 'y' }, null, r2, user());
  assert.equal(r2.statusCode, 404);
  assert.match(r2.body, /could not be accepted/i);
  assert.equal(touched, false);
});

// ── Start endpoint binding ─────────────────────────────────────────────────

test('start body exact ordered location_id+endpoint_id; rejects hostile shapes', async function startBodyContract() {
  assert.deepEqual([...START_BODY_KEYS], ['location_id', 'endpoint_id']);
  assert.equal(validBody(startBody()), true);
  assert.equal(validBody({ location_id: LOCATION_SLUG }), false);
  assert.equal(validBody({ endpoint_id: ENDPOINT_ID, location_id: LOCATION_SLUG }), false);
  assert.equal(validBody({
    location_id: LOCATION_SLUG,
    endpoint_id: ENDPOINT_ID,
    extra: 1,
  }), false);
  assert.equal(validBody({
    location_id: LOCATION_SLUG,
    endpoint_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'.toUpperCase(),
  }), false);

  const accessor = {};
  Object.defineProperty(accessor, 'location_id', {
    enumerable: true, get() { return LOCATION_SLUG; },
  });
  Object.defineProperty(accessor, 'endpoint_id', {
    enumerable: true, get() { return ENDPOINT_ID; },
  });
  assert.equal(validBody(accessor), false);

  const withSymbol = startBody();
  withSymbol[Symbol('x')] = true;
  assert.equal(validBody(withSymbol), false);

  assert.equal(validBody(Object.create(null)), false);
  const nullProto = Object.create(null);
  nullProto.location_id = LOCATION_SLUG;
  nullProto.endpoint_id = ENDPOINT_ID;
  // null proto is allowed by snapshotExactOrderedOwnData pattern — routes allow
  // Object.prototype or null. Confirm both plain and null-proto ok if ordered.
  assert.equal(validBody(nullProto), true);
});

test('start resolves exact Sunset tenant+location+endpoint and starts', async function startHappyPath() {
  const azure = installAzureSdkSpies();
  try {
    const db = createStatefulDb();
    const bundle = createMultiplexHttps(db);
    const routes = buildRoutes(goodEnv(), db, bundle);
    const r = resCapture();
    await routes.handleStart(startBody(), null, r, user());
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.authorization_url, 'string');
    assert.match(r.body.authorization_url, /login\.microsoftonline\.com/);
    assert.equal(typeof r.body.expires_at, 'string');
    assert.equal(db.txns.length, 1);
    assert.equal(db.txns[0].endpoint_id, ENDPOINT_ID);
    assert.equal(db.txns[0].client_id, CLIENT_ID);
    const resolve = db.timeline.find((t) => t.sql === normSql(SQL_RESOLVE_START_BINDING));
    assert.ok(resolve);
    assert.deepEqual(resolve.params, [LOCATION_SLUG, ENDPOINT_ID]);
  } finally {
    azure.restore();
  }
});

test('start rejects wrong/missing/extra body, cross-location, status, mode, duplicate', async function startFailureMatrix() {
  const azure = installAzureSdkSpies();
  try {
    const env = goodEnv();

    // Missing location
    {
      const db = createStatefulDb();
      db.locations[0].location_id = 'other-place';
      const routes = buildRoutes(env, db, createMultiplexHttps(db));
      const r = resCapture();
      await routes.handleStart(startBody(), null, r, user());
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, { success: false, error: 'location_not_found' });
      assert.equal(db.txns.length, 0);
    }

    // Wrong binding status
    {
      const db = createStatefulDb({ bindingStatus: 'verified' });
      const routes = buildRoutes(env, db, createMultiplexHttps(db));
      const r = resCapture();
      await routes.handleStart(startBody(), null, r, user());
      assert.equal(r.status, 404);
      assert.equal(db.txns.length, 0);
    }

    // Wrong connector / mode
    {
      const db = createStatefulDb();
      db.endpoints[0].connector_mode = 'microsoft_app_only_enterprise';
      const routes = buildRoutes(env, db, createMultiplexHttps(db));
      const r = resCapture();
      await routes.handleStart(startBody(), null, r, user());
      assert.equal(r.status, 404);
      assert.equal(db.txns.length, 0);
    }

    // Wrong auth_mode
    {
      const db = createStatefulDb();
      db.endpoints[0].auth_mode = 'client_credentials';
      const routes = buildRoutes(env, db, createMultiplexHttps(db));
      const r = resCapture();
      await routes.handleStart(startBody(), null, r, user());
      assert.equal(r.status, 404);
      assert.equal(db.txns.length, 0);
    }

    // Missing public address
    {
      const db = createStatefulDb();
      db.endpoints[0].public_address = null;
      const routes = buildRoutes(env, db, createMultiplexHttps(db));
      const r = resCapture();
      await routes.handleStart(startBody(), null, r, user());
      assert.equal(r.status, 404);
      assert.equal(db.txns.length, 0);
    }

    // Cross-location endpoint (endpoint exists only under other location slug)
    {
      const db = createStatefulDb({
        extraLocation: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          client_id: CLIENT_ID,
          location_id: 'sunset-sardinero',
          active: true,
        },
        extraEndpoint: {
          id: OTHER_ENDPOINT_ID,
          client_id: CLIENT_ID,
          location_id: 'sunset-sardinero',
          provider: 'microsoft_graph',
          auth_mode: 'delegated_authorization_code',
          connector_mode: 'microsoft_delegated_oauth',
          binding_status: 'unverified_offline',
          public_address: MAILBOX,
        },
      });
      const routes = buildRoutes(env, db, createMultiplexHttps(db));
      const r = resCapture();
      // Request somo location with sardinero endpoint → zero rows
      await routes.handleStart(startBody({ endpoint_id: OTHER_ENDPOINT_ID }), null, r, user());
      assert.equal(r.status, 404);
      assert.equal(db.txns.length, 0);
    }

    // Ambiguity (duplicate eligible rows)
    {
      const db = createStatefulDb({ duplicateStartRows: true });
      const routes = buildRoutes(env, db, createMultiplexHttps(db));
      const r = resCapture();
      await routes.handleStart(startBody(), null, r, user());
      assert.equal(r.status, 503);
      assert.deepEqual(r.body, { success: false, error: 'oauth_start_unavailable' });
      assert.equal(db.txns.length, 0);
    }

    // Foreign tenant user
    {
      const db = createStatefulDb();
      const routes = buildRoutes(env, db, createMultiplexHttps(db));
      const r = resCapture();
      await routes.handleStart(startBody(), null, r, user({ client_slug: 'wolfhouse' }));
      assert.equal(r.status, 403);
      assert.equal(db.txns.length, 0);
    }

    // Hostile bodies — zero pg / zero insert
    {
      const db = createStatefulDb();
      let pg = 0;
      const routes = createStaffEmailOAuthRoutes({
        runtimeEnv: env,
        sendJSON,
        assertStaffClientAccess() { return true; },
        authorizeAuthenticatedStaffRoute() { return { ok: true }; },
        withPgClient: async (fn) => {
          pg += 1;
          return fn(db.client);
        },
      });
      const cases = [
        { location_id: LOCATION_SLUG, extra: 'evil' },
        { location_id: LOCATION_SLUG },
        { endpoint_id: ENDPOINT_ID, location_id: LOCATION_SLUG },
        (() => {
          const o = {};
          Object.defineProperty(o, 'location_id', { enumerable: true, get() { return LOCATION_SLUG; } });
          Object.defineProperty(o, 'endpoint_id', { enumerable: true, get() { return ENDPOINT_ID; } });
          return o;
        })(),
        (() => {
          const o = startBody();
          o[Symbol('s')] = 1;
          return o;
        })(),
        { location_id: LOCATION_SLUG, endpoint_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'.toUpperCase() },
        { location_id: LOCATION_SLUG, endpoint_id: 'not-a-uuid' },
      ];
      for (const body of cases) {
        const r = resCapture();
        await routes.handleStart(body, null, r, user());
        assert.equal(r.status, 400, `body should 400: ${JSON.stringify(body && Object.keys(body))}`);
        assert.equal(db.txns.length, 0);
      }
      assert.equal(pg, 0);
    }
  } finally {
    azure.restore();
  }
});

// ── Post-route native pin (module-init capture) ─────────────────────────────

test('post-route-construction native replacement uses module-init captured originals only', async function postRouteNativePin() {
  const azure = installAzureSdkSpies();
  const origCreatePublicKey = crypto.createPublicKey;
  const origVerify = crypto.verify;
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const routePath = require.resolve('./lib/staff-email-oauth-routes');

  try {
    const db = createStatefulDb();
    const bundleStart = createMultiplexHttps(db);
    const routesStart = buildRoutes(goodEnv(), db, bundleStart);
    const rStart = resCapture();
    await routesStart.handleStart(startBody(), null, rStart, user());
    assert.equal(rStart.status, 200);
    const url = new URL(rStart.body.authorization_url);
    const state = url.searchParams.get('state');
    assert.ok(state);
    const nonce = db.txns[0].nonce;

    const bundle = createMultiplexHttps(db, {
      tokenBody: goodTokenBody({
        id_token: createIdToken({ nonce, aud: APP_CLIENT_ID }),
      }),
    });

    // Mutable https module surface so post-construction replacement is possible.
    // Capture the impl request once so the Module._load bag does not dynamically
    // re-read httpsImpl.request after production has pinned the bag method.
    const capturedImplRequest = bundle.httpsImpl.request;
    const mockHttps = {
      request(...args) {
        return Reflect.apply(capturedImplRequest, bundle.httpsImpl, args);
      },
    };
    const realLoad = Module._load;
    Module._load = function interceptHttps(request, parent, isMain) {
      if (request === 'https' || request === 'node:https') {
        return mockHttps;
      }
      return realLoad(request, parent, isMain);
    };
    delete require.cache[routePath];
    let routesMod;
    try {
      routesMod = require('./lib/staff-email-oauth-routes');
    } finally {
      Module._load = realLoad;
    }

    const routes = routesMod.createStaffEmailOAuthRoutes({
      runtimeEnv: goodEnv(),
      sendJSON,
      assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: async (fn) => fn(db.client),
    });

    // After route construction: replace every module/global method.
    let hostileHttps = 0;
    let hostileCreateKey = 0;
    let hostileVerify = 0;
    let hostileSet = 0;
    let hostileClear = 0;
    mockHttps.request = function hostileRequest() {
      hostileHttps += 1;
      throw new Error(`${LEAK} hostile https.request`);
    };
    crypto.createPublicKey = function hostileCreatePublicKey() {
      hostileCreateKey += 1;
      throw new Error(`${LEAK} hostile createPublicKey`);
    };
    crypto.verify = function hostileVerifyFn() {
      hostileVerify += 1;
      throw new Error(`${LEAK} hostile verify`);
    };
    globalThis.setTimeout = function hostileSetTimeout() {
      hostileSet += 1;
      throw new Error(`${LEAK} hostile setTimeout`);
    };
    globalThis.clearTimeout = function hostileClearTimeout() {
      hostileClear += 1;
      throw new Error(`${LEAK} hostile clearTimeout`);
    };

    const rCb = resCapture();
    await routes.handleCallback(
      { state, code: CODE },
      null,
      rCb,
      user(),
    );

    assert.equal(rCb.statusCode, 200, 'valid callback still succeeds with replacements installed');
    assert.match(rCb.body, /Authorization response received/);
    assert.equal(hostileHttps, 0, 'replacement https.request zero calls');
    assert.equal(hostileCreateKey, 0, 'replacement createPublicKey zero calls');
    assert.equal(hostileVerify, 0, 'replacement verify zero calls');
    assert.equal(hostileSet, 0, 'replacement setTimeout zero calls');
    assert.equal(hostileClear, 0, 'replacement clearTimeout zero calls');
    // Captured originals ran with original owners (https impl thisValue).
    assert.ok(bundle.calls.length >= 1, 'captured https request invoked');
    assert.equal(bundle.calls[0].thisValue, bundle.httpsImpl);
    assert.equal(db.grants.length, 1);
  } finally {
    crypto.createPublicKey = origCreatePublicKey;
    crypto.verify = origVerify;
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    delete require.cache[routePath];
    azure.restore();
  }
});

// ── Full E2E happy path ────────────────────────────────────────────────────

test('full route E2E: start + callback via production Azure path; wrap only on seal', async function fullE2EHappyPath() {
  const azure = installAzureSdkSpies();
  try {
    const db = createStatefulDb();
    const bundle = createMultiplexHttps(db);
    const routes = buildRoutes(goodEnv(), db, bundle);

    const rStart = resCapture();
    await routes.handleStart(startBody(), null, rStart, user());
    assert.equal(rStart.status, 200);
    const url = new URL(rStart.body.authorization_url);
    const state = url.searchParams.get('state');
    assert.ok(state && state.length >= 43);
    assert.equal(db.txns.length, 1);
    const txn = db.txns[0];
    assert.equal(txn.consumed_at, null);

    const nonce = txn.nonce;
    const wrapBefore = azure.counters.wrap;
    assert.equal(wrapBefore, 0, 'no Key Vault wrap before callback');

    const bundle2 = createMultiplexHttps(db, {
      tokenBody: goodTokenBody({
        id_token: createIdToken({ nonce, aud: APP_CLIENT_ID }),
      }),
    });
    const routes2 = buildRoutes(goodEnv(), db, bundle2);

    const rCb = resCapture();
    await routes2.handleCallback(
      { state, code: CODE },
      null,
      rCb,
      user(),
    );

    assert.equal(rCb.statusCode, 200);
    assert.match(rCb.headers['Content-Type'], /^text\/html/);
    assert.match(rCb.headers['Content-Security-Policy'], /default-src 'none'/);
    assert.match(rCb.body, /Authorization response received/);
    assert.ok(!rCb.body.includes(CODE));
    assert.ok(!rCb.body.includes(ACCESS));
    assert.ok(!rCb.body.includes(REFRESH));
    assert.ok(!rCb.body.includes(SECRET));
    assert.ok(!rCb.body.includes(nonce));
    assert.ok(!rCb.body.includes(ENDPOINT_ID));

    assert.ok(txn.consumed_at != null);
    assert.equal(db.grants.length, 1);
    assert.equal(db.endpoints[0].binding_status, 'verified');
    assert.equal(db.endpoints[0].provider_principal_oid, PRINCIPAL);
    assert.equal(db.grants[0].has_refresh_raw, false);

    // Seal used Azure RSA wrap exactly once on happy path.
    assert.ok(azure.counters.wrap >= 1, 'Key Vault wrap after valid callback seal');
    assert.equal(azure.counters.micClientId, SUNSET_STAGING_MI_CLIENT_ID);
    assert.equal(azure.counters.ccKeyId, SUNSET_STAGING_VERSIONED_KEY_ID);
    assert.ok(azure.counters.ccOptions
      && azure.counters.ccOptions.retryOptions
      && azure.counters.ccOptions.retryOptions.maxRetries === 0);

    const hosts = bundle2.calls.map((c) => `${c.method} ${c.host}${c.path || ''}`);
    assert.ok(hosts.length >= 3, `expected network calls, got ${JSON.stringify(hosts)}`);
    assert.equal(bundle2.calls[0].host, TOKEN_HOST);
    assert.equal(bundle2.calls[0].method, 'POST');

    const beginDuringNet = bundle2.calls.filter((c) => c.error === 'BEGIN_DURING_NETWORK');
    assert.equal(beginDuringNet.length, 0);

    const beginIdx = db.timeline.findIndex((t) => t.sql === 'BEGIN');
    const consumeIdx = db.timeline.findIndex((t) => t.sql === normSql(SQL_CONSUME_TRANSACTION));
    assert.ok(consumeIdx >= 0);
    assert.ok(beginIdx > consumeIdx, 'BEGIN must be after consume, not across external I/O window start');
    for (let i = consumeIdx; i < beginIdx; i += 1) {
      assert.notEqual(db.timeline[i].sql, 'BEGIN');
    }
    assert.ok(db.timeline.some((t) => t.sql === 'COMMIT'));

    const rReplay = resCapture();
    await routes2.handleCallback({ state, code: CODE }, null, rReplay, user());
    assert.equal(rReplay.statusCode, 400);
    assert.match(rReplay.body, /could not be accepted/i);
    assert.equal(db.grants.length, 1);
  } finally {
    azure.restore();
  }
});

function normSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

// ── Callback failure matrix ────────────────────────────────────────────────

test('provider-declined consumes and returns declined HTML; no token/Graph/install', async function providerDeclined() {
  const azure = installAzureSdkSpies();
  try {
    const db = createStatefulDb();
    const bundle = createMultiplexHttps(db);
    const routes = buildRoutes(goodEnv(), db, bundle);
    const rStart = resCapture();
    await routes.handleStart(startBody(), null, rStart, user());
    const state = new URL(rStart.body.authorization_url).searchParams.get('state');
    assert.equal(db.txns[0].consumed_at, null);

    const netBefore = bundle.calls.length;
    const wrapBefore = azure.counters.wrap;
    const rCb = resCapture();
    await routes.handleCallback({ state, error: 'access_denied' }, null, rCb, user());
    assert.equal(rCb.statusCode, 200);
    assert.match(rCb.body, /Authorization was declined/);
    assert.ok(db.txns[0].consumed_at != null);
    assert.equal(bundle.calls.length, netBefore);
    assert.equal(db.grants.length, 0);
    assert.equal(db.endpoints[0].binding_status, 'unverified_offline');
    assert.ok(!db.timeline.some((t) => t.sql === 'BEGIN'));
    assert.equal(azure.counters.wrap, wrapBefore);
  } finally {
    azure.restore();
  }
});

test('invalid/replay callback: fixed terminal; no external I/O; no install', async function invalidReplay() {
  const azure = installAzureSdkSpies();
  try {
    const db = createStatefulDb();
    const bundle = createMultiplexHttps(db);
    const routes = buildRoutes(goodEnv(), db, bundle);

    const r1 = resCapture();
    await routes.handleCallback({
      state: Buffer.alloc(32, 7).toString('base64url'),
      code: CODE,
    }, null, r1, user());
    assert.equal(r1.statusCode, 400);
    assert.match(r1.body, /could not be accepted/i);
    assert.equal(bundle.calls.length, 0);
    assert.equal(db.grants.length, 0);

    const r2 = resCapture();
    await routes.handleCallback({
      state: Buffer.alloc(32, 7).toString('base64url'),
      code: CODE,
      extra: 'evil',
    }, null, r2, user());
    assert.equal(r2.statusCode, 400);
    assert.ok(!String(r2.body).includes('evil'));
  } finally {
    azure.restore();
  }
});

test('token transport failure after consume: terminal invalid; no install; consumed stays', async function tokenFailureConsumed() {
  const azure = installAzureSdkSpies();
  try {
    const db = createStatefulDb();
    const bundleStart = createMultiplexHttps(db);
    const routesStart = buildRoutes(goodEnv(), db, bundleStart);
    const rStart = resCapture();
    await routesStart.handleStart(startBody(), null, rStart, user());
    const state = new URL(rStart.body.authorization_url).searchParams.get('state');

    const bundle = createMultiplexHttps(db, { tokenError: true });
    const routes = buildRoutes(goodEnv(), db, bundle);
    const rCb = resCapture();
    await routes.handleCallback({ state, code: CODE }, null, rCb, user());
    assert.equal(rCb.statusCode, 400);
    assert.match(rCb.body, /could not be accepted/i);
    assert.ok(db.txns[0].consumed_at != null);
    assert.equal(db.grants.length, 0);
    assert.equal(db.endpoints[0].binding_status, 'unverified_offline');
    assertNoSensitive(rCb.body);
  } finally {
    azure.restore();
  }
});

test('OIDC/JWKS failure after token: no install; fixed terminal', async function oidcFailure() {
  const azure = installAzureSdkSpies();
  try {
    const db = createStatefulDb();
    const bundleStart = createMultiplexHttps(db);
    const routesStart = buildRoutes(goodEnv(), db, bundleStart);
    const rStart = resCapture();
    await routesStart.handleStart(startBody(), null, rStart, user());
    const state = new URL(rStart.body.authorization_url).searchParams.get('state');
    const nonce = db.txns[0].nonce;

    const bundle = createMultiplexHttps(db, {
      tokenBody: goodTokenBody({ id_token: createIdToken({ nonce }) }),
      jwksBody: JSON.stringify({ keys: [] }),
    });
    const routes = buildRoutes(goodEnv(), db, bundle);
    const rCb = resCapture();
    await routes.handleCallback({ state, code: CODE }, null, rCb, user());
    assert.equal(rCb.statusCode, 400);
    assert.equal(db.grants.length, 0);
    assert.ok(db.txns[0].consumed_at != null);
  } finally {
    azure.restore();
  }
});

test('Graph failure after OIDC: no install; fixed terminal', async function graphFailure() {
  const azure = installAzureSdkSpies();
  try {
    const db = createStatefulDb();
    const bundleStart = createMultiplexHttps(db);
    const routesStart = buildRoutes(goodEnv(), db, bundleStart);
    const rStart = resCapture();
    await routesStart.handleStart(startBody(), null, rStart, user());
    const state = new URL(rStart.body.authorization_url).searchParams.get('state');
    const nonce = db.txns[0].nonce;

    const bundle = createMultiplexHttps(db, {
      tokenBody: goodTokenBody({ id_token: createIdToken({ nonce }) }),
      graphHttpError: true,
    });
    const routes = buildRoutes(goodEnv(), db, bundle);
    const rCb = resCapture();
    await routes.handleCallback({ state, code: CODE }, null, rCb, user());
    assert.equal(rCb.statusCode, 400);
    assert.equal(db.grants.length, 0);
    assert.ok(db.txns[0].consumed_at != null);
  } finally {
    azure.restore();
  }
});

test('install insert failure rolls back; no verified endpoint; fixed terminal', async function insertFailureRollback() {
  const azure = installAzureSdkSpies();
  try {
    const db = createStatefulDb({ failInsert: true });
    const bundleStart = createMultiplexHttps(db);
    const routesStart = buildRoutes(goodEnv(), db, bundleStart);
    const rStart = resCapture();
    await routesStart.handleStart(startBody(), null, rStart, user());
    const state = new URL(rStart.body.authorization_url).searchParams.get('state');
    const nonce = db.txns[0].nonce;

    const bundle = createMultiplexHttps(db, {
      tokenBody: goodTokenBody({ id_token: createIdToken({ nonce }) }),
    });
    const routes = buildRoutes(goodEnv(), db, bundle);
    const rCb = resCapture();
    await routes.handleCallback({ state, code: CODE }, null, rCb, user());
    assert.equal(rCb.statusCode, 400);
    assert.equal(db.grants.length, 0);
    assert.equal(db.endpoints[0].binding_status, 'unverified_offline');
    assert.ok(db.timeline.some((t) => t.sql === 'ROLLBACK'));
    assert.ok(!db.timeline.some((t) => t.sql === 'COMMIT'));
  } finally {
    azure.restore();
  }
});

test('callback without secret readiness fails closed with terminal HTML', async function callbackMissingSecret() {
  const azure = installAzureSdkSpies();
  try {
    const db = createStatefulDb();
    const bundle = createMultiplexHttps(db);
    const env = goodEnv();
    delete env.LUNA_EMAIL_OAUTH_CLIENT_SECRET;
    const routes = buildRoutes(env, db, bundle);
    const envStart = goodEnv();
    const routesStart = buildRoutes(envStart, db, createMultiplexHttps(db));
    const rStart = resCapture();
    await routesStart.handleStart(startBody(), null, rStart, user());
    const state = new URL(rStart.body.authorization_url).searchParams.get('state');

    const rCb = resCapture();
    await routes.handleCallback({ state, code: CODE }, null, rCb, user());
    assert.equal(rCb.statusCode, 400);
    assert.match(rCb.body, /could not be accepted/i);
    assert.equal(bundle.calls.length, 0);
    assert.equal(db.grants.length, 0);
  } finally {
    azure.restore();
  }
});

test('wrong session owner cannot complete another session txn', async function wrongSessionOwner() {
  const azure = installAzureSdkSpies();
  try {
    const db = createStatefulDb();
    const bundle = createMultiplexHttps(db);
    const routes = buildRoutes(goodEnv(), db, bundle);
    const rStart = resCapture();
    await routes.handleStart(startBody(), null, rStart, user());
    const state = new URL(rStart.body.authorization_url).searchParams.get('state');
    const rCb = resCapture();
    await routes.handleCallback(
      { state, code: CODE },
      null,
      rCb,
      user({ session_id: '99999999-9999-9999-9999-999999999999' }),
    );
    assert.equal(rCb.statusCode, 400);
    assert.equal(db.txns[0].consumed_at, null);
    assert.equal(db.grants.length, 0);
  } finally {
    azure.restore();
  }
});

test('INPUT_KEYS endpointId remains third; SQL resolve pins endpoint $2', async function contractsPinned() {
  assert.deepEqual([...INPUT_KEYS], [
    'clientId', 'locationId', 'endpointId', 'staffUserId', 'authSessionId',
  ]);
  assert.equal(typeof SQL_RESOLVE_START_BINDING, 'string');
  assert.match(SQL_RESOLVE_START_BINDING, /microsoft_graph/);
  assert.match(SQL_RESOLVE_START_BINDING, /public_address/);
  assert.match(SQL_RESOLVE_START_BINDING, /e\.id = \$2::uuid/);
  assert.match(SQL_RESOLVE_START_BINDING, /l\.location_id = \$1/);
  assert.equal(OAUTH_START_PATH, '/staff/admin/email-settings/oauth/microsoft/start');
  assert.equal(OAUTH_CALLBACK_PATH, '/staff/email/oauth/microsoft/callback');
  assert.equal(REDIRECT_URI.includes('sunset-staging'), true);
  assert.equal(SUNSET_STAGING_KEK_KEY_NAME, 'luna-email-grant-kek');
  assert.equal(typeof SUNSET_STAGING_KEK_KEY_VERSION, 'string');
});

// ── Runner ─────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  PASS  ${t.name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${t.name}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  if (failed) {
    console.error(`\nFAIL verify:email-microsoft-oauth-runtime-wiring (${failed}/${tests.length} failed)`);
    process.exit(1);
  }
  console.log(`\nPASS verify:email-microsoft-oauth-runtime-wiring (${tests.length} named offline tests)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
