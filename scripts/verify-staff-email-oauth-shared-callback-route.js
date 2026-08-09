'use strict';
/** Gate 3 B3a2b focused production-router verifier (offline). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const v8 = require('node:v8');
const Module = require('node:module');
const url = require('node:url');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const {
  OAUTH_CALLBACK_PATH, OAUTH_START_PATH, OAUTH_REAUTHORIZE_PATH,
  PHASE_A_CALLBACK_ENABLED_ENV, PHASE_B_CALLBACK_ENABLED_ENV,
  SHARED_CALLBACK_GATE_ENV_KEYS, PHASE_B_CALLBACK_RUNTIME_ENV_KEYS,
  isSharedOauthCallbackRouteEnabled, isSharedOauthCallbackCallerIdentityValid,
  snapshotSharedOauthCallbackGateEnv, snapshotSharedCallbackDispatchEnv,
  snapshotPhaseBCallbackRuntimeEnv, createStaffEmailOAuthRoutes,
} = require('./lib/staff-email-oauth-routes');
const {
  createMicrosoftOauthSharedCallbackDispatch,
  EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_IMPORT_INERT,
  EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_RUNTIME_WIRED,
  EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_DEFERRED_ACTIVATION,
  EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_SAFE_FOR_RUNTIME_ROUTE,
  PUBLIC_STATUS_RECEIVED, PUBLIC_STATUS_DECLINED, PUBLIC_STATUS_INVALID,
  PUBLIC_STATUS_UNAVAILABLE, PUBLIC_STATUS_OUTCOME_UNKNOWN, ERROR_CODE,
} = require('./lib/email-microsoft-oauth-shared-callback-dispatch');
const {
  EMAIL_MS_PHASE_B_CALLBACK_RUNTIME_WIRED, EMAIL_MS_PHASE_B_CALLBACK_DEFERRED_ACTIVATION,
  EMAIL_MS_PHASE_B_CALLBACK_SAFE_FOR_RUNTIME_ROUTE,
} = require('./lib/email-microsoft-phase-b-oauth-sunset-staging-runtime-composition');
const {
  SCOPES: PHASE_A_SCOPES, SQL_CONSUME_TRANSACTION: PHASE_A_SQL,
  createPostgresOAuthTransactionRepository,
} = require('./lib/email-microsoft-oauth-transaction-service');
const {
  SQL_CONSUME_PHASE_B_TRANSACTION: PHASE_B_SQL,
  createPostgresPhaseBOauthTransactionConsumer,
  createMicrosoftPhaseBOauthCallbackCompletionService,
} = require('./lib/email-microsoft-phase-b-oauth-callback-completion');
const {
  createMicrosoftOAuthCallbackCompletionService,
} = require('./lib/email-microsoft-oauth-callback-completion');
const {
  ENV_COMPOSITION_ENABLED, ENV_TRUSTED_HOST, ENV_VERSIONED_KEY_ID,
  SUNSET_STAGING_TRUSTED_HOST, SUNSET_STAGING_VERSIONED_KEY_ID,
} = require('./lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const ROOT = path.join(__dirname, '..');
const SLICE_BASE = '5e4ee41fccf44e5dfcd0643713b96ecea75708cc';
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STATE = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const CODE = 'AuthCode-printable-B3a2b-1';
const SECRET = 'NEVER_LEAK_secret_material_b3a2b_xyz';
const APP = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const EXPECTED_PATHS = Object.freeze([
  'package.json',
  'scripts/lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js',
  'scripts/lib/email-microsoft-oauth-shared-callback-dispatch.js',
  'scripts/lib/email-microsoft-phase-b-oauth-sunset-staging-runtime-composition.js',
  'scripts/lib/staff-email-oauth-routes.js',
  'scripts/prove-email-microsoft-oauth-transactions-pglite.js',
  'scripts/staff-query-api.js',
  'scripts/verify-email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js',
  'scripts/verify-email-microsoft-oauth-runtime-wiring.js',
  'scripts/verify-email-microsoft-oauth-shared-callback-dispatch.js',
  'scripts/verify-email-microsoft-phase-b-oauth-runtime-composition.js',
  'scripts/verify-staff-email-oauth-phase-b-reauthorize-route.js',
  'scripts/verify-staff-email-oauth-shared-callback-route.js',
]);
const nSql = (s) => String(s).replace(/\s+/g, ' ').trim();
function statefulTxnDb() {
  const rows = []; const sqlLog = [];
  return {
    rows, sqlLog,
    async query(sql, params) {
      const s = nSql(sql); sqlLog.push(s);
      if (/^\s*SELECT\b/i.test(s)) throw new Error('preliminary_select_forbidden');
      const isA = s === nSql(PHASE_A_SQL); const isB = s === nSql(PHASE_B_SQL);
      if (!isA && !isB) throw new Error(`unexpected_sql:${s.slice(0, 80)}`);
      const [stateHash, clientId, authSessionId, now] = params;
      const hit = rows.find((r) => r.state_hash.equals(stateHash) && r.client_id === clientId
        && r.auth_session_id === authSessionId && r.consumed_at == null && r.expires_at > now
        && (isA
          ? r.authorization_intent === 'initial_connect' && r.scope_version === 'phase_a_v2'
            && r.prior_grant_generation == null
          : r.authorization_intent === 'phase_b_reauthorization' && r.scope_version === 'phase_b_v1'
            && r.prior_grant_generation != null && r.prior_grant_generation >= 1));
      if (!hit) return { rows: [] };
      hit.consumed_at = now;
      const base = {
        id: hit.id, location_id: hit.location_id, staff_user_id: hit.staff_user_id,
        code_verifier: hit.code_verifier, nonce: hit.nonce, endpoint_id: hit.endpoint_id,
      };
      return isA ? { rows: [base] } : {
        rows: [{
          ...base, authorization_intent: hit.authorization_intent,
          scope_version: hit.scope_version, prior_grant_generation: hit.prior_grant_generation,
        }],
      };
    },
    plant(hash, intent, scope, prior) {
      rows.push({
        id: crypto.randomUUID(), client_id: CLIENT, location_id: CLIENT, staff_user_id: CLIENT,
        auth_session_id: SESSION, endpoint_id: CLIENT, state_hash: hash, code_verifier: 'v'.repeat(43),
        nonce: 'n'.repeat(43), expires_at: new Date('2099-01-01T00:00:00Z'), consumed_at: null,
        authorization_intent: intent, scope_version: scope, prior_grant_generation: prior,
      });
    },
  };
}
function pinConsume(repo) {
  const fn = repo.consume.bind(repo);
  return Object.freeze({ async consume(...a) { return fn(...a); } });
}
function completionStub(ctr, key) {
  return Object.freeze({ async completeAuthorization() {
    ctr[key] += 1; return Object.freeze({ status: 'completed' });
  } });
}
function realAFactory(db, ctr) {
  return ({ stageTelemetry }) => createMicrosoftOAuthCallbackCompletionService(Object.freeze({
    repository: pinConsume(createPostgresOAuthTransactionRepository(db)),
    completion: completionStub(ctr, 'a'),
    env: { LUNA_DEPLOYMENT: 'sunset-staging', LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true', LUNA_EMAIL_OAUTH_CLIENT_ID: APP },
    clock: Object.freeze({ now() { return new Date(); } }),
    stageTelemetry,
  }));
}
function realBFactory(db, ctr) {
  return ({ stageTelemetry }) => createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze({
    repository: pinConsume(createPostgresPhaseBOauthTransactionConsumer(db)),
    completion: completionStub(ctr, 'b'),
    env: { LUNA_DEPLOYMENT: 'sunset-staging', LUNA_EMAIL_OAUTH_CLIENT_ID: APP, [PHASE_B_CALLBACK_ENABLED_ENV]: 'true' },
    clock: Object.freeze({ now() { return new Date(); } }),
    stageTelemetry,
  }));
}
function fullEnv(a, b) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    [PHASE_A_CALLBACK_ENABLED_ENV]: a ? 'true' : 'false', [PHASE_B_CALLBACK_ENABLED_ENV]: b ? 'true' : 'false',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP, LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET,
    [ENV_COMPOSITION_ENABLED]: 'true', [ENV_TRUSTED_HOST]: SUNSET_STAGING_TRUSTED_HOST,
    [ENV_VERSIONED_KEY_ID]: SUNSET_STAGING_VERSIONED_KEY_ID,
  };
}
let pass = 0; let fail = 0;
function ok(n, c, d) {
  if (c) { pass += 1; console.log(`  PASS  ${n}`); return true; }
  fail += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); return false;
}
function fr(o, keys) { const x = {}; for (const k of keys) x[k] = o[k]; return Object.freeze(x); }
function q(over) { return fr({ state: STATE, code: CODE, ...over }, Object.keys({ state: 1, code: 1, ...over })); }
function admin(over = {}) {
  return {
    client_slug: over.client_slug != null ? over.client_slug : 'sunset',
    client_id: over.client_id != null ? over.client_id : CLIENT,
    session_id: over.session_id != null ? over.session_id : SESSION,
    staff_user_id: over.staff_user_id != null ? over.staff_user_id : CLIENT, role: 'admin', status: 'active',
  };
}
function env(a, b, over = {}) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging', [PHASE_A_CALLBACK_ENABLED_ENV]: a ? 'true' : 'false',
    [PHASE_B_CALLBACK_ENABLED_ENV]: b ? 'true' : 'false',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP, LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET, ...over,
  };
}
function resCap() {
  return { statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = v; } };
}
function noLeak(blob) {
  const s = typeof blob === 'string' ? blob : (() => { try { return JSON.stringify(blob); } catch { return String(blob); } })();
  return !s.includes(SECRET) && !s.includes(CODE) && !s.includes(STATE)
    && !s.includes('access_token') && !s.includes('refresh_token');
}
function svc(impl) { return Object.freeze({ async accept(i, o) { return impl(i, o); } }); }
function loanTracker() {
  const t = { acquire: 0, release: 0, inFlight: 0, maxInFlight: 0, clients: [] };
  async function withPgClient(fn) {
    t.acquire += 1; t.inFlight += 1; t.maxInFlight = Math.max(t.maxInFlight, t.inFlight);
    const pg = { query: async () => ({ rows: [] }), _id: crypto.randomUUID() };
    t.clients.push(pg);
    try { return await fn(pg); } finally { t.inFlight -= 1; t.release += 1; }
  }
  return { t, withPgClient };
}
function routesFor(opts) {
  const loan = loanTracker();
  const counters = { aFactory: 0, bFactory: 0, aAccept: 0, bAccept: 0, dispatchCreate: 0, dispatchers: [] };
  const r = createStaffEmailOAuthRoutes({
    runtimeEnv: opts.env || env(true, false),
    sendJSON() { throw new Error('unexpected_json'); },
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: opts.withPgClient || loan.withPgClient,
    createPhaseACallbackFactory: opts.aFactory || (({ pgClient }) => {
      counters.aFactory += 1;
      return svc(async (input, owner) => {
        counters.aAccept += 1;
        if (opts.aThrow) throw new Error(SECRET);
        if (opts.onA) opts.onA({ input, owner, pgClient, counters });
        return opts.aResult !== undefined ? opts.aResult : PUBLIC_STATUS_RECEIVED;
      });
    }),
    createPhaseBCallbackFactory: opts.bFactory || (({ pgClient }) => {
      counters.bFactory += 1;
      return svc(async (input, owner) => {
        counters.bAccept += 1;
        if (opts.bThrow) throw new Error(SECRET);
        if (opts.onB) opts.onB({ input, owner, pgClient, counters });
        return opts.bResult !== undefined ? opts.bResult : PUBLIC_STATUS_RECEIVED;
      });
    }),
    createSharedCallbackDispatch: opts.createDispatch || ((deps) => {
      counters.dispatchCreate += 1;
      const d = createMicrosoftOauthSharedCallbackDispatch(deps);
      counters.dispatchers.push(d);
      return d;
    }),
  });
  return { routes: r, counters, loan };
}
async function call(routes, query, user) {
  const res = resCap();
  await routes.handleCallback(query, null, res, user);
  return res;
}
function isTerminal(res, code, needle) {
  return res.statusCode === code && typeof res.body === 'string'
    && /text\/html/.test(res.headers['Content-Type'] || '')
    && /default-src 'none'/.test(res.headers['Content-Security-Policy'] || '')
    && res.headers['Cache-Control'] === 'no-store'
    && (needle == null || res.body.includes(needle)) && noLeak(res.body);
}
async function main() {
  console.log('\n== B3a2b shared OAuth callback production route ==');

  // Genuine emitted production HTTP listener/router boundary. Native
  // IncomingMessage, cookie header, url.parse, outer auth, Staff OAuth route,
  // shared dispatcher, and real A/B transaction consumers remain real. Exact
  // offline seam: callback completion factories replace hard Azure/provider
  // construction; session/ACL/PG use the existing dual-gated harness.
  {
    const saved = {};
    for (const [k, v] of Object.entries({
      NODE_ENV: 'test', STAFF_RUNTIME_PROFILE: 'test', STAFF_API_FORTRESS_OFFLINE_LISTENER: '1',
      STAFF_AUTH_REQUIRED: 'true', STAFF_AUTH_HTTPS: 'false',
      LUNA_DEPLOYMENT: 'sunset-staging', LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true',
      LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED: 'true', LUNA_EMAIL_OAUTH_CLIENT_ID: APP,
      LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET, LUNA_BOT_INTERNAL_TOKEN: 'offline_gate3_listener_token_123456',
      [ENV_COMPOSITION_ENABLED]: 'true', [ENV_TRUSTED_HOST]: SUNSET_STAGING_TRUSTED_HOST,
      [ENV_VERSIONED_KEY_ID]: SUNSET_STAGING_VERSIONED_KEY_ID,
    })) { saved[k] = process.env[k]; process.env[k] = v; }
    let api; let server;
    try {
      const realLoad = Module._load;
      Module._load = function loadWithOfflineCallbackCompletion(request, parent, isMain) {
        const loaded = realLoad(request, parent, isMain);
        if (!(parent && /staff-query-api\.js$/.test(parent.filename)
            && /staff-email-oauth-routes/.test(String(request)))) return loaded;
        return Object.freeze({ ...loaded,
          createStaffEmailOAuthRoutes(deps) {
            return loaded.createStaffEmailOAuthRoutes({ ...deps,
              createPhaseACallbackFactory: ({ pgClient, stageTelemetry }) => realAFactory(pgClient, { a: 0, b: 0 })({ stageTelemetry }),
              createPhaseBCallbackFactory: ({ pgClient, stageTelemetry }) => realBFactory(pgClient, { a: 0, b: 0 })({ stageTelemetry }),
            });
          },
        });
      };
      try { api = require('./staff-query-api'); } finally { Module._load = realLoad; }
      let auth = 0; let aConsume = 0; let bConsume = 0;
      api.setFortress15j3OfflineSeams({
        resolveSessionUser(req) {
          auth += 1;
          assert.match(String(req.headers.cookie || ''), /staff_session=gate3-real-cookie/);
          return admin();
        },
        canAccessClient() { return true; },
        withPgClient: async (fn) => fn(Object.freeze({
          async query(sql) {
            if (nSql(sql) === nSql(PHASE_A_SQL)) { aConsume += 1; return { rows: [] }; }
            if (nSql(sql) === nSql(PHASE_B_SQL)) {
              bConsume += 1;
              return { rows: [{
                id: CLIENT, location_id: CLIENT, staff_user_id: CLIENT,
                code_verifier: 'v'.repeat(43), nonce: 'n'.repeat(43), endpoint_id: CLIENT,
                authorization_intent: 'phase_b_reauthorization', scope_version: 'phase_b_v1',
                prior_grant_generation: '7',
              }] };
            }
            throw new Error('unexpected_sql');
          },
        })),
      });
      server = api.createStaffQueryApiHttpServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const port = server.address().port;
      const target = `${OAUTH_CALLBACK_PATH}?error=access_denied&state=${encodeURIComponent(STATE)}`;
      const response = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: target, method: 'GET', headers: { Cookie: 'staff_session=gate3-real-cookie' } }, (res) => {
          const chunks = []; res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject); req.end();
      });
      ok('outer production listener: cookie auth + native query + A fallthrough + B consume once + declined terminal',
        auth === 1 && aConsume === 1 && bConsume === 1
        && response.status === 200 && /Authorization was declined/.test(response.body)
        && noLeak(response.body));
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (api) api.setFortress15j3OfflineSeams(null);
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }
  ok('path/readiness/scopes/flags',
    OAUTH_CALLBACK_PATH === '/staff/email/oauth/microsoft/callback'
    && OAUTH_CALLBACK_PATH !== OAUTH_START_PATH && OAUTH_CALLBACK_PATH !== OAUTH_REAUTHORIZE_PATH
    && EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_IMPORT_INERT === true
    && EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_RUNTIME_WIRED === true
    && EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_DEFERRED_ACTIVATION === true
    && EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_SAFE_FOR_RUNTIME_ROUTE === true
    && EMAIL_MS_PHASE_B_CALLBACK_RUNTIME_WIRED === true
    && EMAIL_MS_PHASE_B_CALLBACK_DEFERRED_ACTIVATION === true
    && EMAIL_MS_PHASE_B_CALLBACK_SAFE_FOR_RUNTIME_ROUTE === true
    && PHASE_A_SCOPES === 'openid profile offline_access User.Read Mail.ReadBasic'
    && [...SHARED_CALLBACK_GATE_ENV_KEYS].join(',')
      === `LUNA_DEPLOYMENT,${PHASE_A_CALLBACK_ENABLED_ENV},${PHASE_B_CALLBACK_ENABLED_ENV}`
    && PHASE_A_CALLBACK_ENABLED_ENV === 'LUNA_EMAIL_OAUTH_CALLBACK_ENABLED'
    && PHASE_B_CALLBACK_ENABLED_ENV === 'LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED');
  ok('gate matrix: neither/A/B/both + non-exact truthy/deployment',
    isSharedOauthCallbackRouteEnabled(env(false, false)) === false
    && isSharedOauthCallbackRouteEnabled(env(true, false)) === true
    && isSharedOauthCallbackRouteEnabled(env(false, true)) === true
    && isSharedOauthCallbackRouteEnabled(env(true, true)) === true
    && isSharedOauthCallbackRouteEnabled({ LUNA_DEPLOYMENT: 'sunset-staging', [PHASE_A_CALLBACK_ENABLED_ENV]: 'TRUE' }) === false
    && isSharedOauthCallbackRouteEnabled({ LUNA_DEPLOYMENT: 'sunset-staging', [PHASE_A_CALLBACK_ENABLED_ENV]: '1' }) === false
    && isSharedOauthCallbackRouteEnabled({ LUNA_DEPLOYMENT: 'production', [PHASE_A_CALLBACK_ENABLED_ENV]: 'true' }) === false);
  {
    const acc = {};
    Object.defineProperty(acc, 'LUNA_DEPLOYMENT', { get() { return 'sunset-staging'; }, enumerable: true });
    Object.defineProperty(acc, PHASE_A_CALLBACK_ENABLED_ENV, { get() { return 'true'; }, enumerable: true });
    ok('accessor/proxy/null gate rejected',
      isSharedOauthCallbackRouteEnabled(acc) === false
      && isSharedOauthCallbackRouteEnabled(new Proxy(env(true, false), {})) === false
      && isSharedOauthCallbackRouteEnabled(null) === false
      && isSharedOauthCallbackRouteEnabled([]) === false);
  }
  ok('snapshots + caller identity',
    Object.keys(snapshotSharedOauthCallbackGateEnv(null)).length === 0
    && (() => { const s = snapshotSharedCallbackDispatchEnv(env(true, false));
      return s && s[PHASE_A_CALLBACK_ENABLED_ENV] === 'true' && s[PHASE_B_CALLBACK_ENABLED_ENV] === 'false' && Object.isFrozen(s); })()
    && snapshotPhaseBCallbackRuntimeEnv(env(false, true)) === null
    && isSharedOauthCallbackCallerIdentityValid(admin()) === true
    && isSharedOauthCallbackCallerIdentityValid(admin({ client_slug: 'wolfhouse' })) === false
    && isSharedOauthCallbackCallerIdentityValid(null) === false);
  {
    let acquired = 0; let aF = 0; let bF = 0;
    const { routes } = routesFor({
      env: env(false, false),
      withPgClient: async (fn) => { acquired += 1; return fn({ query: async () => ({ rows: [] }) }); },
      aFactory: () => { aF += 1; return svc(async () => PUBLIC_STATUS_RECEIVED); },
      bFactory: () => { bF += 1; return svc(async () => PUBLIC_STATUS_RECEIVED); },
    });
    const res = await call(routes, q(), admin());
    ok('gate-off: 404 conceal, zero loan/factory',
      isTerminal(res, 404, 'could not be accepted') && acquired === 0 && aF === 0 && bF === 0);
  }
  {
    let acquired = 0;
    const { routes } = routesFor({
      env: env(true, false),
      withPgClient: async (fn) => { acquired += 1; return fn({ query: async () => ({ rows: [] }) }); },
    });
    ok('unauth/non-sunset/bad-uuid after gate: 400, no loan',
      isTerminal(await call(routes, q(), null), 400, 'could not be accepted')
      && isTerminal(await call(routes, q(), admin({ client_slug: 'other' })), 400, 'could not be accepted')
      && isTerminal(await call(routes, q(), admin({ session_id: 'not-a-uuid' })), 400, 'could not be accepted')
      && acquired === 0);
  }
  {
    const { routes, counters, loan } = routesFor({ env: env(true, false), aResult: PUBLIC_STATUS_RECEIVED });
    ok('A-only received → 200, A once, B never',
      isTerminal(await call(routes, q(), admin()), 200, 'Authorization response received')
      && counters.aFactory === 1 && counters.aAccept === 1
      && counters.bFactory === 0 && counters.bAccept === 0
      && loan.t.acquire === 1 && loan.t.release === 1);
  }
  {
    const { routes, counters, loan } = routesFor({ env: env(true, false), aResult: PUBLIC_STATUS_INVALID });
    ok('A-only invalid → 400, B never (B gate off)',
      isTerminal(await call(routes, q(), admin()), 400, 'could not be accepted')
      && counters.aFactory === 1 && counters.bFactory === 0 && loan.t.release === 1);
  }
  {
    const { routes, counters, loan } = routesFor({ env: env(false, true), bResult: PUBLIC_STATUS_RECEIVED });
    ok('B-only received → 200, A never, B once',
      isTerminal(await call(routes, q(), admin()), 200, 'Authorization response received')
      && counters.aFactory === 0 && counters.bFactory === 1 && counters.bAccept === 1
      && loan.t.acquire === 1 && loan.t.release === 1);
  }
  {
    const { routes, counters, loan } = routesFor({
      env: env(true, true), aResult: PUBLIC_STATUS_INVALID, bResult: PUBLIC_STATUS_RECEIVED,
    });
    ok('A-invalid → B once received',
      isTerminal(await call(routes, q(), admin()), 200, 'Authorization response received')
      && counters.aFactory === 1 && counters.bFactory === 1
      && counters.aAccept === 1 && counters.bAccept === 1
      && loan.t.acquire === 1 && loan.t.release === 1 && loan.t.maxInFlight === 1);
  }
  {
    let blockOk = true;
    for (const [st, code, needle] of [
      [PUBLIC_STATUS_RECEIVED, 200, 'Authorization response received'],
      [PUBLIC_STATUS_DECLINED, 200, 'Authorization was declined'],
      [PUBLIC_STATUS_UNAVAILABLE, 200, 'could not be accepted'],
      [PUBLIC_STATUS_OUTCOME_UNKNOWN, 200, 'could not be accepted'],
    ]) {
      const { routes, counters } = routesFor({
        env: env(true, true), aResult: st, bResult: PUBLIC_STATUS_RECEIVED,
      });
      if (!(isTerminal(await call(routes, q(), admin()), code, needle)
          && counters.aFactory === 1 && counters.bFactory === 0)) blockOk = false;
    }
    ok('A received/declined/unavailable/unknown blocks B', blockOk);
  }
  {
    const { routes, counters, loan } = routesFor({
      env: env(true, true), aThrow: true, bResult: PUBLIC_STATUS_RECEIVED,
    });
    const res = await call(routes, q(), admin());
    ok('A throw blocks B; 400 no leak; DB released',
      isTerminal(res, 400, 'could not be accepted') && noLeak(res.body)
      && counters.bFactory === 0 && loan.t.release === 1);
  }
  {
    const { routes, counters, loan } = routesFor({ env: env(true, false) });
    const rejected = [
      { state: STATE, code: CODE, extra: 'x' },
      new Proxy({ state: STATE, code: CODE }, {}),
      (() => { const o = { state: STATE, code: CODE }; Object.defineProperty(o, 'code', { get() { return CODE; }, enumerable: true }); return o; })(),
      (() => { const o = { state: STATE, code: CODE }; o[Symbol('x')] = 1; return o; })(),
      { state: STATE, code: CODE, error: 'x' }, { state: STATE },
      { state: STATE, code: CODE, session_state: 'x', extra: 1 }, null, 'string', [],
    ];
    let bad = 0;
    for (const h of rejected) {
      const res = await call(routes, h, admin());
      if (!(isTerminal(res, 400, 'could not be accepted') && noLeak(res.body))) bad += 1;
    }
    const resOrder = await call(routes, { code: CODE, state: STATE }, admin());
    const resNull = await call(routes, Object.assign(Object.create(null), { state: STATE, code: CODE }), admin());
    ok('hostile query fail-closed; order/null-proto ok; B never',
      bad === 0 && isTerminal(resOrder, 200, 'Authorization response received')
      && isTerminal(resNull, 200, 'Authorization response received')
      && loan.t.release === loan.t.acquire && counters.bFactory === 0);
  }
  {
    const { routes } = routesFor({ env: env(true, false) });
    let okU = true;
    for (const u of [
      admin({ client_id: OTHER.toUpperCase() }),
      admin({ client_id: 'not-uuid' }), admin({ session_id: '' }),
      admin({ client_slug: 'Sunset' }), { client_slug: 'sunset' },
    ]) {
      const res = await call(routes, q(), u);
      const valid = u.client_id && /^[0-9a-f-]{36}$/i.test(u.client_id)
        && u.client_slug === 'sunset' && u.session_id && /^[0-9a-f-]{36}$/i.test(u.session_id);
      if (valid) { if (!isTerminal(res, 200, 'Authorization response received')) okU = false; }
      else if (!isTerminal(res, 400, 'could not be accepted')) okU = false;
    }
    ok('owner/session hostile matrix', okU);
  }
  {
    const counters = { dispatchCreate: 0, dispatchers: [] };
    const loan = loanTracker();
    const routes = createStaffEmailOAuthRoutes({
      runtimeEnv: env(true, false), sendJSON() {},
      assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: loan.withPgClient,
      createPhaseACallbackFactory: () => svc(async () => PUBLIC_STATUS_RECEIVED),
      createPhaseBCallbackFactory: () => svc(async () => PUBLIC_STATUS_RECEIVED),
      createSharedCallbackDispatch(deps) {
        counters.dispatchCreate += 1;
        const d = createMicrosoftOauthSharedCallbackDispatch(deps);
        counters.dispatchers.push(d); return d;
      },
    });
    const results = await Promise.all([call(routes, q(), admin()), call(routes, q(), admin()), call(routes, q(), admin())]);
    ok('concurrent: 3 distinct dispatchers, 3 loans released',
      results.every((r) => isTerminal(r, 200, 'Authorization response received'))
      && counters.dispatchCreate === 3 && new Set(counters.dispatchers).size === 3
      && loan.t.acquire === 3 && loan.t.release === 3);
  }
  {
    const hash = crypto.createHash('sha256').update(STATE, 'ascii').digest();
    {
      const db = statefulTxnDb();
      db.plant(hash, 'initial_connect', 'phase_a_v2', null);
      const ctr = { a: 0, b: 0 };
      const { routes } = routesFor({
        env: env(true, false), withPgClient: async (fn) => fn(db),
        aFactory: realAFactory(db, ctr), bFactory: realBFactory(db, ctr),
      });
      const r1 = await call(routes, q(), admin());
      const r2 = await call(routes, q(), admin());
      ok('A-only real replay: complete once; replay invalid; UPDATE-only SQL',
        isTerminal(r1, 200, 'Authorization response received')
        && isTerminal(r2, 400, 'could not be accepted')
        && ctr.a === 1 && ctr.b === 0 && db.rows[0].consumed_at != null
        && db.sqlLog.every((s) => /^UPDATE\b/i.test(s))
        && !db.sqlLog.some((s) => /^\s*SELECT\b/i.test(s)));
    }
    {
      const db = statefulTxnDb();
      db.plant(hash, 'phase_b_reauthorization', 'phase_b_v1', 7);
      const ctr = { a: 0, b: 0 };
      const { routes } = routesFor({
        env: env(true, true), withPgClient: async (fn) => fn(db),
        aFactory: realAFactory(db, ctr), bFactory: realBFactory(db, ctr),
      });
      const logs = [];
      const originalLog = console.log;
      let r1;
      try {
        console.log = (line) => { logs.push(line); };
        const nativeQuery = url.parse(
          `/staff/email/oauth/microsoft/callback?code=${encodeURIComponent(CODE)}&state=${encodeURIComponent(STATE)}&session_state=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
          true,
        ).query;
        r1 = await call(routes, nativeQuery, admin());
      } finally { console.log = originalLog; }
      const events = logs.map((line) => JSON.parse(line));
      const expectedPreconsume = [
        'callback_route_accepted', 'callback_owner_authenticated', 'callback_query_validated',
        'callback_pg_acquired', 'callback_dispatch_constructed', 'phase_a_started',
        'phase_a_invalid', 'phase_b_runtime_constructed', 'phase_b_started',
        'phase_b_owner_validated', 'phase_b_input_validated', 'phase_b_state_hashed',
        'phase_b_clock_validated', 'phase_b_consume_started', 'phase_b_consume_returned', 'phase_b_consume_matched',
        'phase_b_row_validated', 'callback_consumed',
      ];
      const r2 = await call(routes, q(), admin());
      ok('both+B-intent: native url.parse query reaches Phase B with exact sanitized stages',
        isTerminal(r1, 200, 'Authorization response received')
        && events.map((e) => e.stage).join(',') === expectedPreconsume.join(',')
        && new Set(events.map((e) => e.request_id)).size === 1
        && events.every((e) => Reflect.ownKeys(e).join(',') === 'event,stage,request_id')
        && noLeak(events));
      ok('both+B-intent: B completes once; replay terminal; intent-disjoint',
        isTerminal(r1, 200, 'Authorization response received')
        && isTerminal(r2, 400, 'could not be accepted')
        && ctr.a === 0 && ctr.b === 1
        && db.sqlLog.some((s) => s === nSql(PHASE_A_SQL))
        && db.sqlLog.some((s) => s === nSql(PHASE_B_SQL))
        && !db.sqlLog.some((s) => /^\s*SELECT\b/i.test(s)));
    }
    {
      const db = statefulTxnDb();
      db.plant(hash, 'initial_connect', 'phase_a_v2', null);
      const ctr = { a: 0, b: 0 };
      const { routes } = routesFor({
        env: env(true, true), withPgClient: async (fn) => fn(db),
        aFactory: realAFactory(db, ctr), bFactory: realBFactory(db, ctr),
      });
      const r1 = await call(routes, q(), admin());
      const r2 = await call(routes, q(), admin());
      ok('both+A-intent: A once; replay cannot invoke B provider',
        isTerminal(r1, 200, 'Authorization response received')
        && isTerminal(r2, 400, 'could not be accepted') && ctr.a === 1 && ctr.b === 0);
    }
  }
  {
    let allOk = true;
    for (const c of [
      { aResult: PUBLIC_STATUS_RECEIVED }, { aResult: PUBLIC_STATUS_INVALID }, { aThrow: true },
      { env: env(true, true), aResult: PUBLIC_STATUS_INVALID, bResult: PUBLIC_STATUS_RECEIVED },
      { env: env(true, true), aResult: PUBLIC_STATUS_INVALID, bThrow: true },
    ]) {
      const { routes, loan } = routesFor({
        env: c.env || env(true, false), aResult: c.aResult, bResult: c.bResult,
        aThrow: c.aThrow, bThrow: c.bThrow,
      });
      await call(routes, q(), admin());
      if (!(loan.t.acquire === 1 && loan.t.release === 1 && loan.t.inFlight === 0)) allOk = false;
    }
    ok('DB loan release exactly once on every path', allOk);
  }
  {
    let preQuery = 0;
    await call(routesFor({
      env: env(true, true), aResult: PUBLIC_STATUS_INVALID, bResult: PUBLIC_STATUS_RECEIVED,
      withPgClient: async (fn) => fn({ query: async () => { preQuery += 1; return { rows: [] }; } }),
      aFactory: () => svc(async () => PUBLIC_STATUS_INVALID),
      bFactory: () => svc(async () => PUBLIC_STATUS_RECEIVED),
    }).routes, q(), admin());
    ok('no pre-SELECT before/during factory (zero pg.query)', preQuery === 0);
  }
  {
    // Fresh child: genuine production accept — no Module._load; parent validates evidence.
    const A_SQL_N = nSql(PHASE_A_SQL); const B_SQL_N = nSql(PHASE_B_SQL);
    const expectedRoutesPath = path.resolve(ROOT, 'scripts/lib/staff-email-oauth-routes.js');
    const expectedPhaseAPath = path.resolve(ROOT, 'scripts/lib/email-microsoft-oauth-sunset-staging-runtime-composition.js');
    const expectedPhaseBPath = path.resolve(ROOT, 'scripts/lib/email-microsoft-phase-b-oauth-sunset-staging-runtime-composition.js');
    const expectedDispatchPath = path.resolve(ROOT, 'scripts/lib/email-microsoft-oauth-shared-callback-dispatch.js');
    const expectedRouteHash = crypto.createHash('sha256').update(fs.readFileSync(expectedRoutesPath)).digest('hex');
    const expectedStateHash = crypto.createHash('sha256').update(STATE, 'ascii').digest();
    const nodePathParts = [path.join(ROOT, 'node_modules'), '/opt/data/wolfhouse-agent/node_modules',
      '/opt/data/sunset-email-gate3-composition/node_modules', '/opt/wolfhouse/WH/node_modules',
      process.env.NODE_PATH || ''].filter(Boolean);
    let azureIdentityPath = null; let azureKvPath = null; let azureAbsent = null;
    try {
      azureIdentityPath = require.resolve('@azure/identity', { paths: nodePathParts });
      azureKvPath = require.resolve('@azure/keyvault-keys', { paths: nodePathParts });
    } catch (e) { azureAbsent = String(e && e.message ? e.message : e); }
    const expectedMicDeep = azureIdentityPath ? path.join(path.dirname(azureIdentityPath), 'credentials', 'managedIdentityCredential', 'index.js') : null;
    const expectedCcDeep = azureKvPath ? path.join(path.dirname(azureKvPath), 'cryptographyClient.js') : null;
    const tmp = path.join('/opt/data', `b3a2b-genuine-accept-${process.pid}-${Date.now()}.js`);
    const childSrc = `'use strict';
const path=require('path'),crypto=require('crypto'),fs=require('fs'),v8=require('v8');
const https=require('https'),http=require('http'),net=require('net'),tls=require('tls');
const ROOT=${JSON.stringify(ROOT)},PHASE_A=${JSON.stringify(PHASE_A_CALLBACK_ENABLED_ENV)},PHASE_B=${JSON.stringify(PHASE_B_CALLBACK_ENABLED_ENV)};
const CLIENT=${JSON.stringify(CLIENT)},SESSION=${JSON.stringify(SESSION)},STATE=${JSON.stringify(STATE)},CODE=${JSON.stringify(CODE)},APP=${JSON.stringify(APP)},SECRET=${JSON.stringify(SECRET)};
const ENV_COMP=${JSON.stringify(ENV_COMPOSITION_ENABLED)},ENV_HOST=${JSON.stringify(ENV_TRUSTED_HOST)},ENV_KID=${JSON.stringify(ENV_VERSIONED_KEY_ID)};
const HOST_V=${JSON.stringify(SUNSET_STAGING_TRUSTED_HOST)},KID_V=${JSON.stringify(SUNSET_STAGING_VERSIONED_KEY_ID)};
const A_SQL_N=${JSON.stringify(A_SQL_N)},B_SQL_N=${JSON.stringify(B_SQL_N)};
const fullEnv=(a,b)=>({LUNA_DEPLOYMENT:'sunset-staging',[PHASE_A]:a?'true':'false',[PHASE_B]:b?'true':'false',LUNA_EMAIL_OAUTH_CLIENT_ID:APP,LUNA_EMAIL_OAUTH_CLIENT_SECRET:SECRET,[ENV_COMP]:'true',[ENV_HOST]:HOST_V,[ENV_KID]:KID_V});
const nSql=(s)=>String(s).replace(/\\s+/g,' ').trim();
const clsSql=(sql)=>{const s=nSql(sql);return s===A_SQL_N?'phase_a_consume':s===B_SQL_N?'phase_b_consume':/^\\s*SELECT\\b/i.test(s)?'select':'other';};
const netC={httpsRequest:0,httpRequest:0,fetch:0,netConnect:0,netCreateConnection:0,tlsConnect:0,totalNetwork:0};
const bump=(k)=>{netC[k]+=1;netC.totalNetwork+=1;throw Object.assign(new Error('network_blocked:'+k),{code:'NETWORK_BLOCKED'});};
const wrapFF=(obj,key,tag)=>{if(typeof obj[key]==='function')obj[key]=function(){bump(tag);};};
wrapFF(https,'request','httpsRequest');wrapFF(http,'request','httpRequest');wrapFF(net,'connect','netConnect');
wrapFF(net,'createConnection','netCreateConnection');wrapFF(tls,'connect','tlsConnect');
if(typeof globalThis.fetch==='function')globalThis.fetch=function(){bump('fetch');};
// Real Azure via NODE_PATH — no Module._load, no require.cache reshape; production deep paths only.
let azureIdentityResolved=null,azureKvResolved=null,azureResolveErr=null;
let azureMicDeepResolved=null,azureCcDeepResolved=null,azureRootIdCached=null,azureRootKvCached=null;
try{
  azureIdentityResolved=require.resolve('@azure/identity');
  azureKvResolved=require.resolve('@azure/keyvault-keys');
  azureMicDeepResolved=path.join(path.dirname(azureIdentityResolved),'credentials','managedIdentityCredential','index.js');
  azureCcDeepResolved=path.join(path.dirname(azureKvResolved),'cryptographyClient.js');
}catch(e){azureResolveErr=String(e&&e.message?e.message:e);}
const routesPath=path.resolve(ROOT,'scripts/lib/staff-email-oauth-routes.js');
const phaseAPath=path.resolve(ROOT,'scripts/lib/email-microsoft-oauth-sunset-staging-runtime-composition.js');
const phaseBPath=path.resolve(ROOT,'scripts/lib/email-microsoft-phase-b-oauth-sunset-staging-runtime-composition.js');
const dispatchPath=path.resolve(ROOT,'scripts/lib/email-microsoft-oauth-shared-callback-dispatch.js');
const {createStaffEmailOAuthRoutes}=require(routesPath);
const phaseAMod=require(phaseAPath),phaseBMod=require(phaseBPath);
const {PUBLIC_STATUS_RECEIVED}=require(dispatchPath);
const routeHash=crypto.createHash('sha256').update(fs.readFileSync(routesPath)).digest('hex');
const resCap=()=>({statusCode:null,body:null,headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=v;}});
const admin=()=>({client_slug:'sunset',client_id:CLIENT,session_id:SESSION,staff_user_id:CLIENT,role:'admin',status:'active'});
const q=()=>Object.freeze({state:STATE,code:CODE});
const serParams=(params)=>v8.serialize(params==null?null:params).toString('base64');
async function run(a,b){
  for(const k of Object.keys(netC))netC[k]=0;
  const sqlLog=[];const pg={_id:crypto.randomUUID(),async query(sql,params){sqlLog.push({cls:clsSql(sql),sqlText:String(sql),sqlNorm:nSql(sql),paramsB64:serParams(params)});return{rows:[]};}};
  let acquire=0,release=0;
  const routes=createStaffEmailOAuthRoutes({runtimeEnv:fullEnv(a,b),sendJSON(){},assertStaffClientAccess(){return true;},authorizeAuthenticatedStaffRoute(){return{ok:true};},
    withPgClient:async(fn)=>{acquire+=1;try{return await fn(pg);}finally{release+=1;}}});
  const res=resCap();await routes.handleCallback(q(),null,res,admin());
  const aRows=sqlLog.filter(x=>x.cls==='phase_a_consume'),bRows=sqlLog.filter(x=>x.cls==='phase_b_consume');
  return{status:res.statusCode,body:String(res.body||''),contentType:String(res.headers['Content-Type']||''),acquire,release,pgId:pg._id,
    sql:{total:sqlLog.length,phaseACount:aRows.length,phaseBCount:bRows.length,selectCount:sqlLog.filter(x=>x.cls==='select').length,otherCount:sqlLog.filter(x=>x.cls==='other').length,order:sqlLog.map(x=>x.cls),
      aSignature:aRows[0]?aRows[0].sqlNorm:null,bSignature:bRows[0]?bRows[0].sqlNorm:null,aSqlText:aRows[0]?aRows[0].sqlText:null,bSqlText:bRows[0]?bRows[0].sqlText:null,
      aParamsB64:aRows[0]?aRows[0].paramsB64:null,bParamsB64:bRows[0]?bRows[0].paramsB64:null},
    net:{httpsRequest:netC.httpsRequest,httpRequest:netC.httpRequest,fetch:netC.fetch,netConnect:netC.netConnect,netCreateConnection:netC.netCreateConnection,tlsConnect:netC.tlsConnect,totalNetwork:netC.totalNetwork}};
}
(async()=>{
  const aOnly=await run(true,false),bOnly=await run(false,true),both=await run(true,true);
  azureRootIdCached=!!(azureIdentityResolved&&require.cache[azureIdentityResolved]);
  azureRootKvCached=!!(azureKvResolved&&require.cache[azureKvResolved]);
  const deepCached=!!(azureMicDeepResolved&&require.cache[azureMicDeepResolved])&&!!(azureCcDeepResolved&&require.cache[azureCcDeepResolved]);
  const hostile={};Object.defineProperty(hostile,'LUNA_DEPLOYMENT',{get(){return'sunset-staging';},enumerable:true});
  Object.defineProperty(hostile,PHASE_A,{get(){return'true';},enumerable:true});
  let acqH=0;const routesH=createStaffEmailOAuthRoutes({runtimeEnv:hostile,sendJSON(){},assertStaffClientAccess(){return true;},authorizeAuthenticatedStaffRoute(){return{ok:true};},withPgClient:async(fn)=>{acqH+=1;return fn({query:async()=>({rows:[]})});}});
  const resH=resCap();await routesH.handleCallback(q(),null,resH,admin());
  let traps=0;const proxy=new Proxy(fullEnv(true,false),{get(t,p,r){traps+=1;return Reflect.get(t,p,r);}});
  let acqP=0;const routesP=createStaffEmailOAuthRoutes({runtimeEnv:proxy,sendJSON(){},assertStaffClientAccess(){return true;},authorizeAuthenticatedStaffRoute(){return{ok:true};},withPgClient:async(fn)=>{acqP+=1;return fn({query:async()=>({rows:[]})});}});
  const resP=resCap();await routesP.handleCallback(q(),null,resP,admin());
  const mapRoutes=createStaffEmailOAuthRoutes({runtimeEnv:fullEnv(true,false),sendJSON(){},assertStaffClientAccess(){return true;},authorizeAuthenticatedStaffRoute(){return{ok:true};},withPgClient:async(fn)=>fn({query:async()=>({rows:[]})}),
    createPhaseACallbackFactory:()=>Object.freeze({async accept(){return PUBLIC_STATUS_RECEIVED;}})});
  const resM=resCap();await mapRoutes.handleCallback(q(),null,resM,admin());
  process.stdout.write(JSON.stringify({routesPath,routeHash,phaseAPath,phaseBPath,dispatchPath,azureIdentityResolved,azureKvResolved,azureResolveErr,
    azureMicDeepResolved,azureCcDeepResolved,azureRootIdCached,azureRootKvCached,deepCached,
    phaseAExportName:typeof phaseAMod.createSunsetStagingMicrosoftOAuthCallbackRuntime==='function'?phaseAMod.createSunsetStagingMicrosoftOAuthCallbackRuntime.name:null,
    phaseBExportName:typeof phaseBMod.createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime==='function'?phaseBMod.createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime.name:null,
    aOnly,bOnly,both,hostile:{status:resH.statusCode,body:String(resH.body||''),acq:acqH},proxy:{status:resP.statusCode,body:String(resP.body||''),acq:acqP,traps},
    mapping:{status:resM.statusCode,body:String(resM.body||''),label:'fake_mapping_not_authenticity'}}));
})().catch(e=>{console.error(e&&e.stack?e.stack:e);process.exit(2);});
`;
    fs.writeFileSync(tmp, childSrc);
    try {
      const r = spawnSync(process.execPath, [tmp], {
        cwd: ROOT, encoding: 'utf8', timeout: 120000,
        env: { ...process.env, NODE_PATH: nodePathParts.join(path.delimiter) },
      });
      let out = null;
      try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) { out = null; }
      const failDetail = r.status !== 0 ? (r.stderr || r.stdout || '').slice(0, 400) : '';
      const ROOT_KEYS = ['routesPath', 'routeHash', 'phaseAPath', 'phaseBPath', 'dispatchPath', 'azureIdentityResolved',
        'azureKvResolved', 'azureResolveErr', 'azureMicDeepResolved', 'azureCcDeepResolved',
        'azureRootIdCached', 'azureRootKvCached', 'deepCached', 'phaseAExportName', 'phaseBExportName',
        'aOnly', 'bOnly', 'both', 'hostile', 'proxy', 'mapping'];
      const RUN_KEYS = ['status', 'body', 'contentType', 'acquire', 'release', 'pgId', 'sql', 'net'];
      const SQL_KEYS = ['total', 'phaseACount', 'phaseBCount', 'selectCount', 'otherCount', 'order',
        'aSignature', 'bSignature', 'aSqlText', 'bSqlText', 'aParamsB64', 'bParamsB64'];
      const NET_KEYS = ['httpsRequest', 'httpRequest', 'fetch', 'netConnect', 'netCreateConnection', 'tlsConnect', 'totalNetwork'];
      const exactKeys = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o)
        && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
      const frozenOut = out && typeof out === 'object' ? Object.freeze({ ...out }) : null;
      const schemaOk = frozenOut && exactKeys(frozenOut, ROOT_KEYS)
        && [frozenOut.aOnly, frozenOut.bOnly, frozenOut.both].every((run) => exactKeys(run, RUN_KEYS)
          && exactKeys(run.sql, SQL_KEYS) && exactKeys(run.net, NET_KEYS));
      const pathHashOk = frozenOut && frozenOut.routesPath === expectedRoutesPath && frozenOut.routeHash === expectedRouteHash
        && frozenOut.phaseAPath === expectedPhaseAPath && frozenOut.phaseBPath === expectedPhaseBPath
        && frozenOut.dispatchPath === expectedDispatchPath
        && frozenOut.phaseAExportName === 'createSunsetStagingMicrosoftOAuthCallbackRuntime'
        && frozenOut.phaseBExportName === 'createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime';
      const azurePathOk = !azureAbsent && frozenOut && frozenOut.azureIdentityResolved === azureIdentityPath
        && frozenOut.azureKvResolved === azureKvPath && frozenOut.azureResolveErr == null
        && frozenOut.azureMicDeepResolved === expectedMicDeep
        && frozenOut.azureCcDeepResolved === expectedCcDeep
        && frozenOut.azureRootIdCached === false && frozenOut.azureRootKvCached === false
        && frozenOut.deepCached === true;
      ok(azureAbsent ? 'fresh-process Azure SDK environmental absence (not claiming untouched load)'
        : 'fresh-process real Azure deep constructors (no Module._load; no cache reshape)',
        !azureAbsent && r.status === 0 && azurePathOk && pathHashOk,
        azureAbsent || failDetail || (frozenOut
          ? `rootCached=${frozenOut.azureRootIdCached}/${frozenOut.azureRootKvCached} deep=${frozenOut.deepCached}`
          : 'no JSON'));
      const zeroNet = (n) => n && NET_KEYS.every((k) => n[k] === 0);
      const parentParamsOk = (b64) => {
        if (typeof b64 !== 'string' || !b64) return false;
        let p; try { p = v8.deserialize(Buffer.from(b64, 'base64')); } catch (_) { return false; }
        return Array.isArray(p) && p.length === 4 && Buffer.isBuffer(p[0]) && p[0].length === 32
          && p[0].equals(expectedStateHash) && p[1] === CLIENT && p[2] === SESSION
          && p[3] instanceof Date && !Number.isNaN(p[3].getTime());
      };
      const terminal400 = (run) => run && run.status === 400 && typeof run.body === 'string'
        && /could not be accepted/.test(run.body) && /text\/html/.test(run.contentType || '');
      const aSqlOk = (sql) => sql && sql.phaseACount === 1 && sql.phaseBCount === 0 && sql.selectCount === 0
        && sql.otherCount === 0 && sql.total === 1 && Array.isArray(sql.order) && sql.order.join(',') === 'phase_a_consume'
        && sql.aSignature === A_SQL_N && /authorization_intent='initial_connect'/.test(sql.aSignature)
        && /scope_version='phase_a_v2'/.test(sql.aSignature) && /prior_grant_generation IS NULL/.test(sql.aSignature)
        && !/phase_b_reauthorization/.test(sql.aSignature) && parentParamsOk(sql.aParamsB64);
      const bSqlOk = (sql) => sql && sql.phaseACount === 0 && sql.phaseBCount === 1 && sql.selectCount === 0
        && sql.otherCount === 0 && sql.total === 1 && Array.isArray(sql.order) && sql.order.join(',') === 'phase_b_consume'
        && sql.bSignature === B_SQL_N && /authorization_intent='phase_b_reauthorization'/.test(sql.bSignature)
        && /scope_version='phase_b_v1'/.test(sql.bSignature) && /prior_grant_generation IS NOT NULL/.test(sql.bSignature)
        && !/initial_connect/.test(sql.bSignature) && parentParamsOk(sql.bParamsB64);
      const bothSqlOk = (sql) => sql && sql.phaseACount === 1 && sql.phaseBCount === 1 && sql.selectCount === 0
        && sql.otherCount === 0 && sql.total === 2 && Array.isArray(sql.order)
        && sql.order.join(',') === 'phase_a_consume,phase_b_consume' && sql.aSignature === A_SQL_N
        && sql.bSignature === B_SQL_N && parentParamsOk(sql.aParamsB64) && parentParamsOk(sql.bParamsB64);
      const a = frozenOut && frozenOut.aOnly; const b = frozenOut && frozenOut.bOnly; const both = frozenOut && frozenOut.both;
      ok('fresh-process schema allowlist + parent path/hash equality',
        r.status === 0 && schemaOk && pathHashOk, failDetail || (frozenOut ? 'schema/path mismatch' : 'no child JSON'));
      ok('fresh-process genuine A-only: parent-validated SQL A once, zero net, loan once',
        a && terminal400(a) && a.acquire === 1 && a.release === 1 && aSqlOk(a.sql) && zeroNet(a.net),
        a ? `st=${a.status} t=${a.sql && a.sql.total}` : 'no aOnly');
      ok('fresh-process genuine B-only: parent-validated SQL B once, zero net',
        b && terminal400(b) && b.acquire === 1 && b.release === 1 && bSqlOk(b.sql) && zeroNet(b.net));
      ok('fresh-process genuine both: A then B on one PG loan; zero net (parent counters)',
        both && terminal400(both) && both.acquire === 1 && both.release === 1 && bothSqlOk(both.sql) && zeroNet(both.net));
      ok('fresh-process hostile accessor/proxy: parent status 404 zero loan/traps',
        frozenOut && frozenOut.hostile && frozenOut.hostile.status === 404 && frozenOut.hostile.acq === 0
        && frozenOut.proxy && frozenOut.proxy.status === 404 && frozenOut.proxy.acq === 0 && frozenOut.proxy.traps === 0);
      ok('HTTP mapping only (labeled fake, not authenticity): parent status/body 200 received',
        frozenOut && frozenOut.mapping && frozenOut.mapping.label === 'fake_mapping_not_authenticity'
        && frozenOut.mapping.status === 200 && /Authorization response received/.test(frozenOut.mapping.body || ''));
    } finally { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } }
  }
  {
    let seenOwner = null;
    const { routes } = routesFor({
      env: env(true, false),
      aFactory: () => svc(async (input, owner) => { seenOwner = owner; return PUBLIC_STATUS_RECEIVED; }),
    });
    ok('query owner fields rejected (extras)',
      isTerminal(await call(routes, { state: STATE, code: CODE, clientId: OTHER, authSessionId: OTHER }, admin()), 400, 'could not be accepted'));
    const res = await call(routes, q(), admin({ client_id: CLIENT, session_id: SESSION }));
    ok('owner from session UUIDs only',
      isTerminal(res, 200, 'Authorization response received')
      && seenOwner && seenOwner.clientId === CLIENT && seenOwner.authSessionId === SESSION);
  }
  {
    const seen = [];
    const loan = loanTracker();
    const routes = createStaffEmailOAuthRoutes({
      runtimeEnv: env(true, true), sendJSON() {},
      assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: loan.withPgClient,
      createPhaseACallbackFactory: ({ pgClient }) => {
        seen.push(['A', pgClient]); return svc(async () => PUBLIC_STATUS_INVALID);
      },
      createPhaseBCallbackFactory: ({ pgClient }) => {
        seen.push(['B', pgClient]); return svc(async () => PUBLIC_STATUS_RECEIVED);
      },
    });
    await call(routes, q(), admin());
    ok('A and B factories share one request PG loan',
      seen.length === 2 && seen[0][1] === seen[1][1]
      && loan.t.acquire === 1 && loan.t.release === 1);
  }
  {
    const withAcc = {};
    for (const k of PHASE_B_CALLBACK_RUNTIME_ENV_KEYS) {
      Object.defineProperty(withAcc, k, { get() { return 'true'; }, enumerable: true });
    }
    ok('B runtime env incomplete/accessors → null',
      snapshotPhaseBCallbackRuntimeEnv({
        LUNA_DEPLOYMENT: 'sunset-staging', LUNA_EMAIL_OAUTH_CLIENT_ID: APP,
        [PHASE_B_CALLBACK_ENABLED_ENV]: 'true',
      }) === null && snapshotPhaseBCallbackRuntimeEnv(withAcc) === null);
  }
  {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-oauth-routes.js'), 'utf8');
    const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
    ok('source wires B3a1+B2b; no alternate path/intent discriminator',
      /createMicrosoftOauthSharedCallbackDispatch/.test(src)
      && /createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime/.test(src)
      && /buildCallbackRuntime\(env, pg, stageTelemetry\)/.test(src)
      && !/OAUTH_CALLBACK_PATH_B|OAUTH_PHASE_B_CALLBACK_PATH/.test(src)
      && !/browser_intent|intent_hint|oauth_intent_query/.test(src));
    ok('API outer gate A|B exact true + pre-parse classifier before url.parse', (() => {
      const cls = apiSrc.indexOf('function classifyOauthCallbackRawTarget');
      const ri = apiSrc.indexOf('async function router(req, res)');
      const pi = apiSrc.indexOf('url.parse(req.url, true)', ri);
      const pre = apiSrc.indexOf('Gate 3 B3a2b pre-parse', ri);
      return cls !== -1 && pre !== -1 && pi !== -1 && cls < ri && pre < pi
        && /kind === 'hostile'/.test(apiSrc)
        && /kind === 'canonical'/.test(apiSrc)
        && /LUNA_EMAIL_OAUTH_CALLBACK_ENABLED === 'true'/.test(apiSrc)
        && /LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED === 'true'/.test(apiSrc)
        && /%\(\?:25\)\+/.test(apiSrc) && /OAUTH_CALLBACK_RAW_TARGET_MAX/.test(apiSrc)
        && !/for\s*\(\s*let\s+pass\s*=\s*0;\s*pass\s*<\s*3\s*;/.test(apiSrc);
    })());
  }
  {
    ok('Phase A/B consume intent-disjoint SQL',
      /authorization_intent='initial_connect'/.test(PHASE_A_SQL)
      && /scope_version='phase_a_v2'/.test(PHASE_A_SQL)
      && /prior_grant_generation IS NULL/.test(PHASE_A_SQL)
      && /phase_b_reauthorization/.test(PHASE_B_SQL)
      && !/phase_b_reauthorization/.test(PHASE_A_SQL));
  }
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    ok('package script registered',
      pkg.scripts['verify:staff-email-oauth-shared-callback-route']
        === 'node scripts/verify-staff-email-oauth-shared-callback-route.js');
    const baseline = path.join(ROOT, 'config/clients/sunset.baseline.json');
    if (fs.existsSync(baseline)) {
      const b = fs.readFileSync(baseline, 'utf8');
      ok('baseline does not enable A/B callback flags',
        !b.includes(`"${PHASE_A_CALLBACK_ENABLED_ENV}": "true"`)
        && !b.includes(`"${PHASE_B_CALLBACK_ENABLED_ENV}": "true"`));
    } else ok('baseline absent (skip flag check)', true);
    const vLoc = fs.readFileSync(__filename, 'utf8').split(/\r?\n/).length;
    ok(`verifier lines ${vLoc} <= 1080`, vLoc <= 1080);
    // Full-path budget vs slice base: working tree (includes uncommitted amend work).
    const num = spawnSync('git', ['diff', '--numstat', SLICE_BASE], {
      cwd: ROOT, encoding: 'utf8',
    });
    const cached = spawnSync('git', ['diff', '--numstat', '--cached', SLICE_BASE], {
      cwd: ROOT, encoding: 'utf8',
    });
    // Prefer combined unstaged+HEAD-from-base via `git diff SLICE_BASE` which covers
    // committed slice + working tree when SLICE_BASE is ancestor of HEAD.
    const lines = (num.stdout || '').trim().split('\n').filter(Boolean);
    let add = 0; let del = 0; const files = []; let parseOk = num.status === 0 && lines.length > 0;
    for (const line of lines) {
      const m = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!m) { parseOk = false; break; }
      add += Number(m[1]); del += Number(m[2]); files.push(m[3]);
    }
    const churn = add + del;
    console.log(`full delta files=${files.length} +${add}/-${del} churn=${churn}`);
    const sorted = [...files].sort(); const expected = [...EXPECTED_PATHS].sort();
    ok('full git budget + exact path set',
      parseOk && files.length <= 13 && add <= 1780 && del <= 230 && churn <= 2010
      && sorted.length === expected.length && sorted.every((p, i) => p === expected[i]),
      `got files=${files.length} +${add}/-${del} paths=${sorted.join(',')}`);
    void cached;
  }
  {
    const dotenvRoots = [
      path.join(ROOT, 'node_modules'),
      '/opt/data/wolfhouse-agent/node_modules',
      '/opt/wolfhouse/WH/node_modules',
    ].filter((d) => fs.existsSync(path.join(d, 'dotenv')));
    const nodePath = [...dotenvRoots, path.join(ROOT, 'node_modules'), process.env.NODE_PATH || '']
      .filter(Boolean).join(path.delimiter);
    function probe(envMap, reqPath) {
      // Raw request-line write preserves absolute-form / fragment / backslash targets
      // that http.request would normalize or reject.
      const body = `const Module=require('module');const net=require('net');
let parseN=0,authN=0,dbN=0;const real=Module._load;
Module._load=function(r,p,m){const exp=real(r,p,m);if(r==='url'||r==='node:url'){const op=exp.parse;
return Object.assign(Object.create(Object.getPrototypeOf(exp)),exp,{parse(...a){parseN+=1;return op.apply(exp,a);}});}return exp;};
process.env.NODE_ENV='test';process.env.STAFF_RUNTIME_PROFILE='test';process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER='1';
process.env.STAFF_AUTH_REQUIRED='true';process.env.STAFF_AUTH_HTTPS='false';process.env.STAFF_QUERY_API_HOST='127.0.0.1';
process.env.LUNA_BOT_INTERNAL_TOKEN='preparse_offline_token_b3a2b01_xx';
for(const k of ['LUNA_DEPLOYMENT','LUNA_EMAIL_OAUTH_CALLBACK_ENABLED','LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED']) delete process.env[k];
Object.assign(process.env,${JSON.stringify(envMap)});
const api=require(${JSON.stringify(path.join(ROOT, 'scripts/staff-query-api.js'))});
api.setFortress15j3OfflineSeams({withPgClient:async()=>{dbN+=1;throw new Error('db');},
resolveSessionUser(){authN+=1;return null;},canAccessClient(){return true;}});
const s=api.createStaffQueryApiHttpServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));
const port=s.address().port;const target=${JSON.stringify(reqPath)};
const out=await new Promise((resolve,reject)=>{
  const sock=net.connect(port,'127.0.0.1',()=>{
    sock.write('GET '+target+' HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n');
  });
  let buf='';sock.on('data',c=>buf+=c);sock.on('error',reject);
  sock.on('end',()=>{
    const sp=buf.indexOf('\\r\\n\\r\\n');
    const head=sp===-1?buf:buf.slice(0,sp);
    const body=sp===-1?'':buf.slice(sp+4);
    const m=/^HTTP\\/1\\.\\d\\s+(\\d+)/.exec(head);
    resolve({status:m?Number(m[1]):0,body});
  });
});
await new Promise(r=>s.close(()=>r()));
process.stdout.write(JSON.stringify({status:out.status,body:out.body,parseN,authN,dbN}));`;
      const r = spawnSync(process.execPath, ['-e', `(async()=>{${body}})().catch(e=>{console.error(e);process.exit(2)})`], {
        cwd: ROOT, encoding: 'utf8', timeout: 90000, env: { ...process.env, NODE_PATH: nodePath },
      });
      if (r.status !== 0) return { ok: false, err: (r.stderr || r.stdout || '').slice(0, 240) };
      try { return { ok: true, ...JSON.parse((r.stdout || '').trim().split('\n').pop()) }; }
      catch (e) { return { ok: false, err: String(e) }; }
    }
    const cb = `${OAUTH_CALLBACK_PATH}?state=${STATE}&code=${CODE}`;
    const flagSets = [
      { name: 'flags-off', env: { LUNA_DEPLOYMENT: 'sunset-staging', LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'false', LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED: 'false' } },
      { name: 'non-Sunset-on', env: { LUNA_DEPLOYMENT: 'production', LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true', LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED: 'true' } },
      { name: 'Sunset-on', env: { LUNA_DEPLOYMENT: 'sunset-staging', LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true', LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED: 'true' } },
    ];
    const nest10c = `%${'25'.repeat(10)}63allback`;
    const hostile = [
      `${OAUTH_CALLBACK_PATH}#frag`, `${OAUTH_CALLBACK_PATH}?code=x#frag`,
      `http://host${OAUTH_CALLBACK_PATH}`, `https://evil.com${OAUTH_CALLBACK_PATH}?code=1`,
      `//host${OAUTH_CALLBACK_PATH}`, `${OAUTH_CALLBACK_PATH}/`, `${OAUTH_CALLBACK_PATH};x`,
      '/staff/email/oauth/microsoft/%63allback', '/staff/email/oauth/microsoft/%2563allback',
      '/staff/email/oauth/microsoft/%252563allback', '/staff/email/oauth/microsoft/%25%36%33allback',
      '/staff/email/oauth/microsoft/callbac%k', '/staff/email/oauth/microsoft/%zzallback',
      '/staff/email/oauth/microsoft/foo/../callback',
      '/staff/email/oauth//microsoft/callback', `/staff\\email\\oauth\\microsoft\\callback`,
      '/staff%5cemail%5coauth%5cmicrosoft%5ccallback', '/staff%5Cemail%5Coauth%5Cmicrosoft%5Ccallback',
      '/staff/email/oauth/microsoft/callback%3Bx', '/staff/email/oauth/microsoft/callback%3bx',
      '/staff%255cemail%255coauth%255cmicrosoft%255ccallback', '/staff%255Cemail%255Coauth%255Cmicrosoft%255Ccallback',
      '/staff/email/oauth/microsoft/callback%253Bx', '/staff/email/oauth/microsoft/callback%253bx',
      '/staff%5cemail/oauth%2fmicrosoft%5ccallback', `${OAUTH_CALLBACK_PATH}%3Bextra`,
      '/st%2525252561ff/email/oauth/microsoft/callback','/staff/em%2525252561il/oauth/microsoft/callback',
      '/staff/email/oauth/micros%252525256fft/callback','/staff/email/oauth/micros%252525256Fft/callback',
      '/staff/email/%252525256fauth/microsoft/callback',
      `/staff/email/oauth/microsoft/${nest10c}`,'/staff/email/oauth/microsoft/%2525252563allback',
      '/staff%25252Femail%25252Foauth%25252Fmicrosoft%25252Fcallback',
      '/staff%25252femail%25252foauth%25252fmicrosoft%25252fcallback',
    ];
    let hostileOk = true; let hostileDetail = '';
    for (const flagSet of flagSets) {
      for (const h of hostile) {
        const p = probe(flagSet.env, h);
        if (!(p.ok && p.status === 404 && /not_found/.test(p.body || '')
            && p.parseN === 0 && p.authN === 0 && p.dbN === 0)) {
          hostileOk = false;
          hostileDetail = `${flagSet.name} ${h} → ${JSON.stringify(p).slice(0, 180)}`;
          break;
        }
      }
      if (!hostileOk) break;
    }
    ok('pre-parse hostile forms always 404 zero parse/auth/DB (flags off|non-Sunset|Sunset on)',
      hostileOk, hostileDetail);
    const ns = probe(flagSets[1].env, cb);
    ok('pre-parse non-Sunset A/B true canonical: 404 zero url.parse/auth/DB',
      ns.ok && ns.status === 404 && /not_found/.test(ns.body || '')
      && ns.parseN === 0 && ns.authN === 0 && ns.dbN === 0, ns.err);
    const off = probe(flagSets[0].env, cb);
    ok('pre-parse disabled flags canonical: 404 zero parse/auth/DB',
      off.ok && off.status === 404 && off.parseN === 0 && off.authN === 0 && off.dbN === 0, off.err);
    const onCanon = probe(flagSets[2].env, cb);
    ok('pre-parse Sunset flags on exact origin+query: proceeds past pre-parse (url.parse>=1)',
      onCanon.ok && onCanon.parseN >= 1, onCanon.err);
    const other = probe({ LUNA_DEPLOYMENT: 'production', LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true' }, '/staff/auth/session');
    ok('unrelated route still parses normally', other.ok && other.parseN >= 1, other.err);
    // Query-literal / path-prefix / path-suffix must NOT conceal as callback.
    // Under every deployment/flag set, proceed to normal parser (url.parse>=1).
    const unrelatedTargets = [
      `/staff/auth/session?note=${OAUTH_CALLBACK_PATH}`,
      `/staff/auth/session?note=${encodeURIComponent(OAUTH_CALLBACK_PATH)}`,
      `/staff/auth/session?note=%2563allback`,
      `/staff/auth/session?note=${'x'.repeat(2050)}callback${OAUTH_CALLBACK_PATH}`,
      `/prefix${OAUTH_CALLBACK_PATH}`,
      `${OAUTH_CALLBACK_PATH}/extra`,
      `/staff/auth/session${OAUTH_CALLBACK_PATH}`,
      `/staff/email/oauth/microsoft/callbackish`,
      `/staff/email/oauth/other/%2563allback`,
      `/staff/%2563allback`,
    ];
    let unrelatedOk = true; let unrelatedDetail = '';
    for (const flagSet of flagSets) {
      for (const t of unrelatedTargets) {
        const p = probe(flagSet.env, t);
        if (!(p.ok && p.parseN >= 1)) {
          unrelatedOk = false;
          unrelatedDetail = `${flagSet.name} ${t} → ${JSON.stringify(p).slice(0, 180)}`;
          break;
        }
      }
      if (!unrelatedOk) break;
    }
    ok('unrelated query-literal/path-prefix/suffix/encoded never pre-parse concealed',
      unrelatedOk, unrelatedDetail);
  }
  {
    // Real PGlite database-boundary proof (or fake fallback) — execute, not regex-only.
    const pr = spawnSync(process.execPath, [path.join(ROOT, 'scripts/prove-email-microsoft-oauth-transactions-pglite.js')], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000,
      env: {
        ...process.env,
        NODE_PATH: [
          path.join(ROOT, 'node_modules'),
          '/opt/data/wolfhouse-agent/node_modules',
          '/opt/wolfhouse/WH/node_modules',
          process.env.NODE_PATH || '',
        ].filter(Boolean).join(path.delimiter),
      },
    });
    const out = `${pr.stdout || ''}${pr.stderr || ''}`;
    ok('prove:email-microsoft-oauth-transactions-pglite executes PASS',
      pr.status === 0 && /PASS/.test(out) && !/42703/.test(out),
      out.slice(0, 240));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    ok('package prove script registered',
      pkg.scripts['prove:email-microsoft-oauth-transactions-pglite']
        === 'node scripts/prove-email-microsoft-oauth-transactions-pglite.js');
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack : e);
  process.exit(1);
});
