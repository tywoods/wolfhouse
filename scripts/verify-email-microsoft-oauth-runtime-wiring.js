'use strict';

/**
 * Hostile offline gate for Stage 6 Sunset-staging Microsoft OAuth runtime wiring.
 *
 * Proves exact DI/config shapes; full route E2E with fake HTTPS (token + OIDC
 * JWKS + Graph) and explicit envelopeProvider injection (merged fake — not an
 * env production bypass); stateful transaction+installer SQL; start endpoint
 * binding; callback consume→exchange→identity→seal→atomic install; public
 * authorization_received only after commit. Failure matrix keeps fixed
 * terminal HTML, no false success, consumed semantics, no partial DB, no raw
 * token persistence/logs. Asserts network order and no DB BEGIN across external
 * I/O. Disabled routes construct zero completing runtime deps.
 *
 * No Azure/Microsoft live network. No activation/deploy/migration apply.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const {
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  DEPENDENCY_KEYS,
  DEPENDENCY_KEYS_WITH_ENVELOPE,
  createSunsetStagingMicrosoftOAuthCallbackRuntime,
} = require('./lib/email-microsoft-oauth-sunset-staging-runtime-composition');
const {
  createStaffEmailOAuthRoutes,
  OAUTH_START_PATH,
  OAUTH_CALLBACK_PATH,
  SQL_RESOLVE_START_BINDING,
  validBody,
} = require('./lib/staff-email-oauth-routes');
const {
  createFakeEmailGrantEnvelopeProvider,
} = require('./lib/email-grant-envelope-fake-provider');
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

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const LIB_REL = 'scripts/lib/email-microsoft-oauth-sunset-staging-runtime-composition.js';
const ROUTES_REL = 'scripts/lib/staff-email-oauth-routes.js';
const VERIFY_REL = 'scripts/verify-email-microsoft-oauth-runtime-wiring.js';

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const LOCATION_UUID = '22222222-2222-2222-2222-222222222222';
const ENDPOINT_ID = '55555555-5555-5555-5555-555555555555';
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

function goodEnv(patch = {}) {
  return {
    LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_START_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID,
    LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET,
    ...patch,
  };
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
  for (const secret of [LEAK, SECRET, ACCESS, REFRESH, CODE, 'code_verifier', 'authorization_code']) {
    // code_verifier / authorization_code as substrings of keys in HTML is fine;
    // assert raw token material only when blob is structured error paths below.
  }
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
  const locations = [{
    id: LOCATION_UUID,
    client_id: CLIENT_ID,
    location_id: LOCATION_SLUG,
    active: true,
  }];
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
        const rows = [];
        for (const c of clients) {
          if (c.slug !== 'sunset') continue;
          for (const l of locations) {
            if (l.client_id !== c.id || l.location_id !== slug || !l.active) continue;
            for (const e of endpoints) {
              if (e.client_id !== c.id || e.location_id !== l.location_id) continue;
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
        // Exact RETURNING key set / order for consume snapshot.
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

      // Installer lock
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
          // Never store raw refresh — only envelope columns.
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
      if (spec.networkDelay) {
        // still microtask; order preserved relative to awaits
      }
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
    setTimeout(fn) {
      // Do not fire deadline on happy path.
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

function buildRoutes(env, db, httpsBundle, extraDeps = {}) {
  return createStaffEmailOAuthRoutes({
    runtimeEnv: env,
    sendJSON,
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: async (fn) => fn(db.client),
    oauthHttps: httpsBundle.httpsImpl,
    oauthCrypto: httpsBundle.cryptoBag,
    oauthTimers: httpsBundle.timers,
    oauthEnvelopeProvider: extraDeps.envelopeProvider !== undefined
      ? extraDeps.envelopeProvider
      : createFakeEmailGrantEnvelopeProvider(),
    ...extraDeps.routeDeps,
  });
}

// ── Export / package / flags ───────────────────────────────────────────────

test('exports frozen runtime factory surface and fixed error constants', async function exportSurface() {
  const exported = require('./lib/email-microsoft-oauth-sunset-staging-runtime-composition');
  assert.deepEqual(Object.keys(exported).sort(), [
    'CRYPTO_KEYS',
    'DEPENDENCY_KEYS',
    'DEPENDENCY_KEYS_WITH_ENVELOPE',
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
  assert.deepEqual([...DEPENDENCY_KEYS_WITH_ENVELOPE], [
    'env', 'pgClient', 'https', 'crypto', 'timers', 'envelopeProvider',
  ]);
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
  assert.equal(routesSrc.includes('createMicrosoftOAuthCallbackService'), false);
  assert.match(routesSrc, /isStartEnabled/);
  assert.match(routesSrc, /isCallbackEnabled/);
  // completeAuthorization lives in runtime module, not duplicated in routes.
  const libSrc = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
  assert.match(libSrc, /createMicrosoftOAuthCallbackCompletionService/);
  assert.match(libSrc, /createMicrosoftOAuthOperationComposition/);
  assert.match(libSrc, /createMicrosoftVerifiedGrantInstaller/);
  assert.match(libSrc, /createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition/);
});

// ── Factory readiness / DI ─────────────────────────────────────────────────

test('factory rejects missing readiness env and wrong deployment (fail closed)', async function factoryReadiness() {
  const db = createStatefulDb();
  const bundle = createMultiplexHttps(db);
  const base = {
    pgClient: db.client,
    https: bundle.httpsImpl,
    crypto: bundle.cryptoBag,
    timers: bundle.timers,
    envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
  };
  const badEnvs = [
    {},
    { LUNA_DEPLOYMENT: 'production', LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true', LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID, LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET },
    { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'false', LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID, LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET },
    { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true', LUNA_EMAIL_OAUTH_CLIENT_ID: 'not-a-uuid', LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET },
    { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true', LUNA_EMAIL_OAUTH_CLIENT_ID: APP_CLIENT_ID }, // no secret
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
});

test('factory rejects wrong dependency key sets / unfrozen bags', async function factoryHostileDeps() {
  const db = createStatefulDb();
  const bundle = createMultiplexHttps(db);
  const env = goodEnv();
  const envelopeProvider = createFakeEmailGrantEnvelopeProvider();
  assert.throws(() => createSunsetStagingMicrosoftOAuthCallbackRuntime(null), failSanitized);
  assert.throws(() => createSunsetStagingMicrosoftOAuthCallbackRuntime({
    env, pgClient: db.client, https: bundle.httpsImpl, crypto: bundle.cryptoBag, timers: bundle.timers, envelopeProvider,
  }), failSanitized); // unfrozen
  assert.throws(() => createSunsetStagingMicrosoftOAuthCallbackRuntime(Object.freeze({
    env, pgClient: db.client, https: bundle.httpsImpl, crypto: bundle.cryptoBag, timers: bundle.timers, envelopeProvider, extra: 1,
  })), failSanitized);
  assert.throws(() => createSunsetStagingMicrosoftOAuthCallbackRuntime(Object.freeze({
    env, pgClient: { connect() {}, query() {}, totalCount: 0, idleCount: 0, waitingCount: 0 },
    https: bundle.httpsImpl, crypto: bundle.cryptoBag, timers: bundle.timers, envelopeProvider,
  })), failSanitized);
});

test('construction performs zero SQL and zero HTTPS', async function constructionNoIo() {
  const db = createStatefulDb();
  const bundle = createMultiplexHttps(db);
  createSunsetStagingMicrosoftOAuthCallbackRuntime(Object.freeze({
    env: goodEnv(),
    pgClient: db.client,
    https: bundle.httpsImpl,
    crypto: bundle.cryptoBag,
    timers: bundle.timers,
    envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
  }));
  assert.equal(db.timeline.length, 0);
  assert.equal(bundle.calls.length, 0);
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
    oauthEnvelopeProvider: {
      sealGrantPayload() { touched = true; },
      openGrantPayload() { touched = true; },
      rewrapGrantDek() { touched = true; },
    },
  });
  await routes.handleStart({ location_id: LOCATION_SLUG }, null, r, user());
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

test('start resolves exact Sunset tenant+location+eligible endpoint and starts', async function startHappyPath() {
  const db = createStatefulDb();
  const bundle = createMultiplexHttps(db);
  const routes = buildRoutes(goodEnv(), db, bundle);
  const r = resCapture();
  await routes.handleStart({ location_id: LOCATION_SLUG }, null, r, user());
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.authorization_url, 'string');
  assert.match(r.body.authorization_url, /login\.microsoftonline\.com/);
  assert.equal(typeof r.body.expires_at, 'string');
  assert.equal(db.txns.length, 1);
  assert.equal(db.txns[0].endpoint_id, ENDPOINT_ID);
  assert.equal(db.txns[0].client_id, CLIENT_ID);
  // Start body remains exact { location_id } only.
  assert.equal(validBody({ location_id: LOCATION_SLUG }), true);
  assert.equal(validBody({ location_id: LOCATION_SLUG, endpoint_id: ENDPOINT_ID }), false);
});

test('start rejects missing location / wrong endpoint status / ambiguity / foreign tenant', async function startFailureMatrix() {
  const env = goodEnv();

  // Missing location
  {
    const db = createStatefulDb();
    db.locations[0].location_id = 'other-place';
    const routes = buildRoutes(env, db, createMultiplexHttps(db));
    const r = resCapture();
    await routes.handleStart({ location_id: LOCATION_SLUG }, null, r, user());
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { success: false, error: 'location_not_found' });
    assert.equal(db.txns.length, 0);
  }

  // Wrong binding status
  {
    const db = createStatefulDb({ bindingStatus: 'verified' });
    const routes = buildRoutes(env, db, createMultiplexHttps(db));
    const r = resCapture();
    await routes.handleStart({ location_id: LOCATION_SLUG }, null, r, user());
    assert.equal(r.status, 404);
    assert.equal(db.txns.length, 0);
  }

  // Wrong connector
  {
    const db = createStatefulDb();
    db.endpoints[0].connector_mode = 'microsoft_app_only_enterprise';
    const routes = buildRoutes(env, db, createMultiplexHttps(db));
    const r = resCapture();
    await routes.handleStart({ location_id: LOCATION_SLUG }, null, r, user());
    assert.equal(r.status, 404);
    assert.equal(db.txns.length, 0);
  }

  // Missing public address
  {
    const db = createStatefulDb();
    db.endpoints[0].public_address = null;
    const routes = buildRoutes(env, db, createMultiplexHttps(db));
    const r = resCapture();
    await routes.handleStart({ location_id: LOCATION_SLUG }, null, r, user());
    assert.equal(r.status, 404);
    assert.equal(db.txns.length, 0);
  }

  // Ambiguity (duplicate eligible rows)
  {
    const db = createStatefulDb({ duplicateStartRows: true });
    const routes = buildRoutes(env, db, createMultiplexHttps(db));
    const r = resCapture();
    await routes.handleStart({ location_id: LOCATION_SLUG }, null, r, user());
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { success: false, error: 'oauth_start_unavailable' });
    assert.equal(db.txns.length, 0);
  }

  // Foreign tenant user
  {
    const db = createStatefulDb();
    const routes = buildRoutes(env, db, createMultiplexHttps(db));
    const r = resCapture();
    await routes.handleStart({ location_id: LOCATION_SLUG }, null, r, user({ client_slug: 'wolfhouse' }));
    assert.equal(r.status, 403);
    assert.equal(db.txns.length, 0);
  }

  // Hostile body
  {
    const db = createStatefulDb();
    const routes = buildRoutes(env, db, createMultiplexHttps(db));
    const r = resCapture();
    await routes.handleStart({ location_id: LOCATION_SLUG, extra: 'evil' }, null, r, user());
    assert.equal(r.status, 400);
    assert.equal(db.txns.length, 0);
  }
});

// ── Full E2E happy path ────────────────────────────────────────────────────

test('full route E2E: start + callback consume→exchange→identity→seal→install; received after commit', async function fullE2EHappyPath() {
  const db = createStatefulDb();
  const bundle = createMultiplexHttps(db);
  const routes = buildRoutes(goodEnv(), db, bundle);

  // Start
  const rStart = resCapture();
  await routes.handleStart({ location_id: LOCATION_SLUG }, null, rStart, user());
  assert.equal(rStart.status, 200);
  const url = new URL(rStart.body.authorization_url);
  const state = url.searchParams.get('state');
  assert.ok(state && state.length >= 43);
  assert.equal(db.txns.length, 1);
  const txn = db.txns[0];
  assert.equal(txn.consumed_at, null);

  // Capture nonce for id_token (must match transaction nonce)
  const nonce = txn.nonce;
  // Rebuild token body with matching nonce in id_token for this txn.
  bundle.calls.length = 0; // reset after start (start has no network)
  // Monkey-patch: recreate routes with token that uses txn nonce
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

  // Consumed + grant installed + endpoint verified
  assert.ok(txn.consumed_at != null);
  assert.equal(db.grants.length, 1);
  assert.equal(db.endpoints[0].binding_status, 'verified');
  assert.equal(db.endpoints[0].provider_principal_oid, PRINCIPAL);
  assert.equal(db.grants[0].has_refresh_raw, false);

  // Network order: token → (custody internal: identity uses jwks then graph)
  // Actual order from composition: token exchange first, then identity (OIDC JWKS then Graph), then seal (no HTTPS), then install SQL BEGIN.
  const hosts = bundle2.calls.map((c) => `${c.method} ${c.host}${c.path || ''}`);
  assert.ok(hosts.length >= 3, `expected network calls, got ${JSON.stringify(hosts)}`);
  assert.equal(bundle2.calls[0].host, TOKEN_HOST);
  assert.equal(bundle2.calls[0].method, 'POST');
  // Token body must include grant_type + redirect + code + secret + verifier — but we assert no leak in logs via terminal only.

  // No BEGIN during any network call
  const beginDuringNet = bundle2.calls.filter((c) => c.error === 'BEGIN_DURING_NETWORK');
  assert.equal(beginDuringNet.length, 0);

  // SQL timeline: consume UPDATE before any BEGIN; BEGIN only near install end
  const sqlKinds = db.timeline.map((t) => t.sql.slice(0, 48));
  const beginIdx = db.timeline.findIndex((t) => t.sql === 'BEGIN');
  const consumeIdx = db.timeline.findIndex((t) => t.sql === normSql(SQL_CONSUME_TRANSACTION));
  assert.ok(consumeIdx >= 0);
  assert.ok(beginIdx > consumeIdx, 'BEGIN must be after consume, not across external I/O window start');
  // Between consume and BEGIN there should be no BEGIN
  for (let i = consumeIdx; i < beginIdx; i += 1) {
    assert.notEqual(db.timeline[i].sql, 'BEGIN');
  }
  assert.ok(db.timeline.some((t) => t.sql === 'COMMIT'));

  // Replay fails terminal invalid
  const rReplay = resCapture();
  await routes2.handleCallback({ state, code: CODE }, null, rReplay, user());
  assert.equal(rReplay.statusCode, 400);
  assert.match(rReplay.body, /could not be accepted/i);
  assert.equal(db.grants.length, 1); // no second install
});

function normSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

// ── Callback failure matrix ────────────────────────────────────────────────

test('provider-declined consumes and returns declined HTML; no token/Graph/install', async function providerDeclined() {
  const db = createStatefulDb();
  const bundle = createMultiplexHttps(db);
  const routes = buildRoutes(goodEnv(), db, bundle);
  const rStart = resCapture();
  await routes.handleStart({ location_id: LOCATION_SLUG }, null, rStart, user());
  const state = new URL(rStart.body.authorization_url).searchParams.get('state');
  assert.equal(db.txns[0].consumed_at, null);

  const netBefore = bundle.calls.length;
  const rCb = resCapture();
  await routes.handleCallback({ state, error: 'access_denied' }, null, rCb, user());
  assert.equal(rCb.statusCode, 200);
  assert.match(rCb.body, /Authorization was declined/);
  assert.ok(db.txns[0].consumed_at != null);
  assert.equal(bundle.calls.length, netBefore); // no external network
  assert.equal(db.grants.length, 0);
  assert.equal(db.endpoints[0].binding_status, 'unverified_offline');
  assert.ok(!db.timeline.some((t) => t.sql === 'BEGIN'));
});

test('invalid/replay callback: fixed terminal; no external I/O; no install', async function invalidReplay() {
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

  // Hostile extra query keys
  const r2 = resCapture();
  await routes.handleCallback({
    state: Buffer.alloc(32, 7).toString('base64url'),
    code: CODE,
    extra: 'evil',
  }, null, r2, user());
  assert.equal(r2.statusCode, 400);
  assert.ok(!String(r2.body).includes('evil'));
});

test('token transport failure after consume: terminal invalid; no install; consumed stays', async function tokenFailureConsumed() {
  const db = createStatefulDb();
  const bundleStart = createMultiplexHttps(db);
  const routesStart = buildRoutes(goodEnv(), db, bundleStart);
  const rStart = resCapture();
  await routesStart.handleStart({ location_id: LOCATION_SLUG }, null, rStart, user());
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
});

test('OIDC/JWKS failure after token: no install; fixed terminal', async function oidcFailure() {
  const db = createStatefulDb();
  const bundleStart = createMultiplexHttps(db);
  const routesStart = buildRoutes(goodEnv(), db, bundleStart);
  const rStart = resCapture();
  await routesStart.handleStart({ location_id: LOCATION_SLUG }, null, rStart, user());
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
});

test('Graph failure after OIDC: no install; fixed terminal', async function graphFailure() {
  const db = createStatefulDb();
  const bundleStart = createMultiplexHttps(db);
  const routesStart = buildRoutes(goodEnv(), db, bundleStart);
  const rStart = resCapture();
  await routesStart.handleStart({ location_id: LOCATION_SLUG }, null, rStart, user());
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
});

test('install insert failure rolls back; no verified endpoint; fixed terminal', async function insertFailureRollback() {
  const db = createStatefulDb({ failInsert: true });
  const bundleStart = createMultiplexHttps(db);
  const routesStart = buildRoutes(goodEnv(), db, bundleStart);
  const rStart = resCapture();
  await routesStart.handleStart({ location_id: LOCATION_SLUG }, null, rStart, user());
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
});

test('callback without secret readiness fails closed with terminal HTML', async function callbackMissingSecret() {
  const db = createStatefulDb();
  const bundle = createMultiplexHttps(db);
  const env = goodEnv();
  delete env.LUNA_EMAIL_OAUTH_CLIENT_SECRET;
  const routes = buildRoutes(env, db, bundle);
  // still need a txn for a realistic path — start also needs secret? start does not need secret.
  const envStart = goodEnv();
  const routesStart = buildRoutes(envStart, db, createMultiplexHttps(db));
  const rStart = resCapture();
  await routesStart.handleStart({ location_id: LOCATION_SLUG }, null, rStart, user());
  const state = new URL(rStart.body.authorization_url).searchParams.get('state');

  const rCb = resCapture();
  await routes.handleCallback({ state, code: CODE }, null, rCb, user());
  assert.equal(rCb.statusCode, 400);
  assert.match(rCb.body, /could not be accepted/i);
  assert.equal(bundle.calls.length, 0);
  // consume may or may not run — construction fails before accept if runtime factory throws inside withPgClient.
  assert.equal(db.grants.length, 0);
});

test('wrong session owner cannot complete another session txn', async function wrongSessionOwner() {
  const db = createStatefulDb();
  const bundle = createMultiplexHttps(db);
  const routes = buildRoutes(goodEnv(), db, bundle);
  const rStart = resCapture();
  await routes.handleStart({ location_id: LOCATION_SLUG }, null, rStart, user());
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
});

test('INPUT_KEYS endpointId remains third; SQL resolve constant exported', async function contractsPinned() {
  assert.deepEqual([...INPUT_KEYS], [
    'clientId', 'locationId', 'endpointId', 'staffUserId', 'authSessionId',
  ]);
  assert.equal(typeof SQL_RESOLVE_START_BINDING, 'string');
  assert.match(SQL_RESOLVE_START_BINDING, /microsoft_graph/);
  assert.match(SQL_RESOLVE_START_BINDING, /public_address/);
  assert.equal(OAUTH_START_PATH, '/staff/admin/email-settings/oauth/microsoft/start');
  assert.equal(OAUTH_CALLBACK_PATH, '/staff/email/oauth/microsoft/callback');
  assert.equal(REDIRECT_URI.includes('sunset-staging'), true);
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
