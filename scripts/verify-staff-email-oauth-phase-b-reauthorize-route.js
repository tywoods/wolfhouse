'use strict';
/** Offline verifier: Phase B reauth start (B3a2a). Production router + faked PG/session. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('node:module');
const {
  OAUTH_REAUTHORIZE_PATH, OAUTH_START_PATH, OAUTH_CALLBACK_PATH, OAUTH_PREPARE_PATH,
  OAUTH_REFRESH_HEALTH_PATH, OAUTH_READ_HEALTH_PATH, OAUTH_INBOUND_DIAGNOSTIC_PATH,
  OAUTH_INBOUND_CAPTURE_PATH, REAUTHORIZE_BODY_KEYS, REAUTHORIZE_SUCCESS_KEYS,
  REAUTHORIZE_RESOLVE_ROW_KEYS, REAUTHORIZE_ERROR, SQL_RESOLVE_REAUTHORIZE_BINDING,
  PHASE_B_REAUTH_START_ENABLED_ENV, PHASE_B_REAUTH_URL_QUERY_KEYS, PHASE_B_REAUTH_B64URL_32_RE,
  PHASE_B_REAUTH_B1_DTO_KEYS,
  isPhaseBReauthStartEnabled, snapshotPhaseBReauthGateEnv, isPhaseBReauthCallerIdentityValid,
  snapshotReauthorizeBody, snapshotReauthorizeResolveQueryResult, buildReauthorizeSuccessJson,
  createStaffEmailOAuthRoutes,
} = require('./lib/staff-email-oauth-routes');
const {
  createMicrosoftPhaseBReauthorizationTransactionService,
  createPostgresPhaseBReauthTransactionRepository, SQL_CREATE_PHASE_B_REAUTH,
  INPUT_KEYS: B1_INPUT_KEYS, asCanonGen, START_ENABLED_ENV,
} = require('./lib/email-microsoft-phase-b-reauthorization-transaction-service');
const {
  EMAIL_MS_PHASE_B_CALLBACK_RUNTIME_WIRED, EMAIL_MS_PHASE_B_CALLBACK_DEFERRED_ACTIVATION,
  EMAIL_MS_PHASE_B_CALLBACK_SAFE_FOR_RUNTIME_ROUTE,
} = require('./lib/email-microsoft-phase-b-oauth-sunset-staging-runtime-composition');
const { PHASE_B_CALLBACK_ENABLED_ENV } = require('./lib/email-microsoft-oauth-shared-callback-dispatch');

const ROOT = path.join(__dirname, '..');
const LOCATION = 'sunset-somo';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLIENT_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STAFF = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const APP_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const HUGE_GEN = '9007199254740993';
const PLANTED_TOKEN = 'ya29.REAUTH_TOKEN_MUST_NOT_LEAK';
const SESSION_COOKIE = 'reauth-offline-session-token';
// Verifier-owned independent contract (do not import B1/route constants).
const CANON_AUTH = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize';
const CANON_REDIR = 'https://sunset-staging.lunafrontdesk.com/staff/email/oauth/microsoft/callback';
const CANON_SCOPES = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';
const CANON_TTL = 600;
const PINNED = new Date('2030-01-01T00:00:00.000Z');
const PINNED_EXP = new Date(PINNED.getTime() + CANON_TTL * 1000).toISOString();
const b64 = () => crypto.randomBytes(32).toString('base64url');

function sendCap() {
  const calls = [];
  return { calls, sendJSON(_r, s, b) { calls.push({ status: s, body: b && typeof b === 'object' ? { ...b } : b }); return b; } };
}
function body(o = {}) {
  return { location_id: o.location_id != null ? o.location_id : LOCATION, endpoint_id: o.endpoint_id != null ? o.endpoint_id : ENDPOINT };
}
function row(o = {}) {
  return { client_id: o.client_id || CLIENT_UUID, location_id: o.location_id || LOCATION_UUID, endpoint_id: o.endpoint_id || ENDPOINT, grant_generation: o.grant_generation != null ? o.grant_generation : HUGE_GEN };
}
function env(extra = {}) {
  return { LUNA_DEPLOYMENT: 'sunset-staging', [PHASE_B_REAUTH_START_ENABLED_ENV]: 'true', LUNA_EMAIL_OAUTH_CLIENT_ID: APP_ID, ...extra };
}
function admin(o = {}) {
  return { staff_user_id: o.staff_user_id || STAFF, session_id: o.session_id || SESSION, client_id: o.client_id || CLIENT_UUID, client_slug: o.client_slug || 'sunset', role: o.role || 'admin', status: 'active', email: 'a@s.test', display_name: 'A' };
}
function authUrl(state, nonce, challenge, mut) {
  const u = new URL(CANON_AUTH);
  for (const [k, v] of [['client_id', APP_ID], ['response_type', 'code'], ['redirect_uri', CANON_REDIR],
    ['response_mode', 'query'], ['scope', CANON_SCOPES], ['state', state], ['nonce', nonce],
    ['code_challenge', challenge], ['code_challenge_method', 'S256'], ['prompt', 'consent']]) u.searchParams.set(k, v);
  if (typeof mut === 'function') mut(u);
  return u.toString();
}
function goodUrl() { return authUrl(b64(), b64(), b64()); }
function trusted(o = {}) {
  return Object.freeze({
    expectedPriorGrantGeneration: o.gen != null ? o.gen : HUGE_GEN,
    applicationClientId: o.appId != null ? o.appId : APP_ID,
    pinnedNowMs: o.nowMs != null ? o.nowMs : PINNED.getTime(),
  });
}
function b1Dto(url, o = {}) {
  return Object.freeze({
    authorization_url: url,
    expires_at: Object.prototype.hasOwnProperty.call(o, 'exp') ? o.exp : PINNED_EXP,
    authorization_intent: Object.prototype.hasOwnProperty.call(o, 'intent') ? o.intent : 'phase_b_reauthorization',
    scope_version: Object.prototype.hasOwnProperty.call(o, 'ver') ? o.ver : 'phase_b_v1',
    prior_grant_generation: Object.prototype.hasOwnProperty.call(o, 'gen') ? o.gen : HUGE_GEN,
  });
}
function pubOk(url, o = {}) { return buildReauthorizeSuccessJson(b1Dto(url, o), trusted(o)); }
function exactMutable(url) {
  return { authorization_url: url, expires_at: PINNED_EXP, authorization_intent: 'phase_b_reauthorization', scope_version: 'phase_b_v1', prior_grant_generation: HUGE_GEN };
}
function isInsert(s) { return s.includes('INSERT INTO tenant_email_oauth_transactions') || s.includes("'phase_b_reauthorization'"); }
function isResolve(s) { return s === SQL_RESOLVE_REAUTHORIZE_BINDING || s.includes('grant_generation::text AS grant_generation'); }
function insertOk(expDate) {
  return { rows: [{ expires_at: expDate || new Date(Date.now() + 600000), prior_grant_generation: HUGE_GEN, authorization_intent: 'phase_b_reauthorization', scope_version: 'phase_b_v1' }] };
}
function ensureDotenv() {
  try { require.resolve('dotenv'); } catch {
    const c = [path.join(ROOT, 'node_modules'), '/opt/data/wolfhouse-agent/node_modules'].find((x) => fs.existsSync(path.join(x, 'dotenv')));
    if (c) { process.env.NODE_PATH = c + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : ''); Module._initPaths(); }
  }
}
function clearCache() {
  for (const k of Object.keys(require.cache)) {
    if (/staff-query-api\.js$|staff-auth-config|staff-portal-clients|pg-connect|staff-email-oauth-routes|phase-b-reauthorization-transaction/.test(k)) delete require.cache[k];
  }
}
function installBodyCounters() {
  const recovery = require('./lib/staff-email-delta-operator-recovery-routes');
  if (!recovery.__b3a2aCounters) {
    const c = { ct: 0, body: 0 };
    const oCt = recovery.validateOperatorRecoveryJsonContentType;
    const oBody = recovery.readOperatorRecoveryStrictJsonBody;
    recovery.validateOperatorRecoveryJsonContentType = (req) => { c.ct += 1; return oCt(req); };
    recovery.readOperatorRecoveryStrictJsonBody = (req) => { c.body += 1; return oBody(req); };
    recovery.__b3a2aCounters = c;
  }
  recovery.__b3a2aCounters.ct = 0; recovery.__b3a2aCounters.body = 0; return recovery.__b3a2aCounters;
}
function listen(s) { return new Promise((r, j) => { s.listen(0, '127.0.0.1', () => r(s.address().port)); s.on('error', j); }); }
function close(s) { return new Promise((r) => s.close(() => r())); }
function request(port, opts) {
  return new Promise((resolve, reject) => {
    const payload = opts.body == null ? null : Buffer.from(opts.body);
    const headers = { ...(opts.headers || {}) };
    if (payload) headers['content-length'] = payload.length;
    const req = http.request({ hostname: '127.0.0.1', port, path: opts.path || OAUTH_REAUTHORIZE_PATH, method: opts.method || 'POST', headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let b = raw; try { b = JSON.parse(raw); } catch { /* */ } resolve({ status: res.statusCode, body: b, raw }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}

async function main() {
  assert.equal(OAUTH_REAUTHORIZE_PATH, '/staff/admin/email-settings/oauth/microsoft/reauthorize');
  for (const p of [OAUTH_START_PATH, OAUTH_CALLBACK_PATH, OAUTH_PREPARE_PATH, OAUTH_REFRESH_HEALTH_PATH,
    OAUTH_READ_HEALTH_PATH, OAUTH_INBOUND_DIAGNOSTIC_PATH, OAUTH_INBOUND_CAPTURE_PATH]) assert.notEqual(OAUTH_REAUTHORIZE_PATH, p);
  assert.deepEqual([...REAUTHORIZE_BODY_KEYS], ['location_id', 'endpoint_id']);
  assert.deepEqual([...REAUTHORIZE_SUCCESS_KEYS], ['authorization_url', 'expires_at']);
  assert.deepEqual([...REAUTHORIZE_RESOLVE_ROW_KEYS], ['client_id', 'location_id', 'endpoint_id', 'grant_generation']);
  assert.deepEqual([...PHASE_B_REAUTH_B1_DTO_KEYS], [
    'authorization_url', 'expires_at', 'authorization_intent', 'scope_version', 'prior_grant_generation',
  ]);
  assert.equal(REAUTHORIZE_ERROR, 'oauth_reauthorization_unavailable');
  assert.equal(PHASE_B_REAUTH_START_ENABLED_ENV, START_ENABLED_ENV);
  assert.equal(PHASE_B_REAUTH_START_ENABLED_ENV, 'LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED');
  assert.equal(CANON_TTL, 600);
  assert.deepEqual([...PHASE_B_REAUTH_URL_QUERY_KEYS], [
    'client_id', 'response_type', 'redirect_uri', 'response_mode', 'scope',
    'state', 'nonce', 'code_challenge', 'code_challenge_method', 'prompt',
  ]);
  assert.deepEqual([...B1_INPUT_KEYS], [
    'clientId', 'locationId', 'endpointId', 'staffUserId', 'authSessionId', 'expectedPriorGrantGeneration',
  ]);
  for (const f of ['authorization_intent', 'scope_version', 'prior_grant_generation', 'grant_generation', 'state', 'nonce', 'success', 'client_id']) assert.equal(REAUTHORIZE_SUCCESS_KEYS.includes(f), false);

  assert.equal(isPhaseBReauthStartEnabled(null), false);
  assert.equal(isPhaseBReauthStartEnabled({ LUNA_DEPLOYMENT: 'sunset-staging' }), false);
  assert.equal(isPhaseBReauthStartEnabled({ LUNA_DEPLOYMENT: 'sunset-staging', [PHASE_B_REAUTH_START_ENABLED_ENV]: 'TRUE' }), false);
  assert.equal(isPhaseBReauthStartEnabled({ LUNA_DEPLOYMENT: 'production', [PHASE_B_REAUTH_START_ENABLED_ENV]: 'true' }), false);
  assert.equal(isPhaseBReauthStartEnabled(env()), true);
  assert.equal(isPhaseBReauthCallerIdentityValid(admin()), true);
  assert.equal(isPhaseBReauthCallerIdentityValid(admin({ client_slug: 'wolfhouse' })), false);
  assert.equal(isPhaseBReauthCallerIdentityValid(admin({ staff_user_id: 'nope' })), false);
  const acc = {};
  Object.defineProperty(acc, 'LUNA_DEPLOYMENT', { get() { return 'sunset-staging'; }, enumerable: true });
  Object.defineProperty(acc, PHASE_B_REAUTH_START_ENABLED_ENV, { get() { return 'true'; }, enumerable: true });
  assert.equal(isPhaseBReauthStartEnabled(acc), false);
  assert.equal(isPhaseBReauthStartEnabled(snapshotPhaseBReauthGateEnv(env())), true);
  assert.equal(EMAIL_MS_PHASE_B_CALLBACK_RUNTIME_WIRED, false);
  assert.equal(EMAIL_MS_PHASE_B_CALLBACK_SAFE_FOR_RUNTIME_ROUTE, false);
  assert.equal(EMAIL_MS_PHASE_B_CALLBACK_DEFERRED_ACTIVATION, true);
  assert.equal(PHASE_B_CALLBACK_ENABLED_ENV, 'LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED');
  assert.equal(isPhaseBReauthStartEnabled({
    LUNA_DEPLOYMENT: 'sunset-staging', LUNA_EMAIL_OAUTH_START_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true', LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED: 'true',
  }), false);
  assert.ok(snapshotReauthorizeBody(body()));
  assert.equal(snapshotReauthorizeBody({ endpoint_id: ENDPOINT, location_id: LOCATION }), null);
  assert.equal(snapshotReauthorizeBody({ location_id: LOCATION, endpoint_id: ENDPOINT, extra: 1 }), null);
  assert.equal(snapshotReauthorizeBody({ location_id: LOCATION, endpoint_id: ENDPOINT.toUpperCase() }), null);

  const sql = SQL_RESOLVE_REAUTHORIZE_BINDING;
  for (const frag of [
    "c.slug='sunset'", 'l.active=true', "e.provider='microsoft_graph'",
    "e.auth_mode='delegated_authorization_code'", "e.connector_mode='microsoft_delegated_oauth'",
    "e.binding_status='verified'", "g.scope_version='phase_a_v2'", "g.grant_status='active'",
    "g.reconcile_state='clean'", 'g.grant_lease_token IS NULL', 'g.grant_lease_owner IS NULL',
    'g.grant_lease_until IS NULL', 'g.grant_generation::text AS grant_generation', 'g.grant_generation>=1',
  ]) assert.ok(sql.includes(frag), frag);
  assert.equal(/client_slug|staff_user|session_id|phase_b_v1/.test(sql), false);
  assert.equal(asCanonGen(HUGE_GEN), HUGE_GEN);
  assert.equal(asCanonGen(9007199254740993), null);
  assert.equal(snapshotReauthorizeResolveQueryResult({ rows: [row({ grant_generation: HUGE_GEN })] }).kind, 'one');
  assert.equal(snapshotReauthorizeResolveQueryResult({ rows: [row({ grant_generation: 9007199254740993 })] }).kind, 'invalid');
  assert.equal(snapshotReauthorizeResolveQueryResult({ rows: [] }).kind, 'empty');

  // Exact B1 DTO owner + URL + exact TTL + hostiles (production owner path)
  const good = goodUrl();
  const okDto = pubOk(good);
  assert.ok(okDto);
  assert.deepEqual(Reflect.ownKeys(okDto), ['authorization_url', 'expires_at']);
  assert.equal(JSON.stringify(okDto).includes('phase_b'), false);
  assert.ok(PHASE_B_REAUTH_B64URL_32_RE.test(new URL(good).searchParams.get('state')));
  const rej = (label, url, o) => { assert.equal(pubOk(url, o), null, label); };
  const mut = (fn) => { const u = new URL(good); fn(u); return u.toString(); };
  for (const [l, u] of [
    ['http', good.replace('https:', 'http:')], ['evil', good.replace('login.microsoftonline.com', 'evil.example')],
    ['port', good.replace('login.microsoftonline.com', 'login.microsoftonline.com:8443')],
    ['userinfo', good.replace('https://', 'https://user:pass@')], ['hash', `${good}#x`],
    ['path', good.replace('/organizations/', '/common/')],
    ['scope', mut((x) => x.searchParams.set('scope', 'openid'))],
    ['client', mut((x) => x.searchParams.set('client_id', '00000000-0000-4000-8000-000000000000'))],
    ['redirect', mut((x) => x.searchParams.set('redirect_uri', 'https://evil.example/cb'))],
    ['prompt', mut((x) => x.searchParams.set('prompt', 'login'))],
    ['method', mut((x) => x.searchParams.set('code_challenge_method', 'plain'))],
    ['state', mut((x) => x.searchParams.set('state', 'short'))],
    ['extra', mut((x) => x.searchParams.append('extra', '1'))],
    ['missing', mut((x) => x.searchParams.delete('prompt'))],
    ['dup', good.replace('prompt=consent', 'prompt=consent&prompt=consent')],
  ]) rej(l, u);
  rej('appId', good, { appId: '00000000-0000-4000-8000-000000000001' });
  for (const exp of ['1', String(PINNED.getTime() + 600000), PINNED_EXP.replace('T', ' '),
    new Date(PINNED.getTime() + 1).toISOString(), new Date(PINNED.getTime() + 599999).toISOString(),
    new Date(PINNED.getTime() + 600001).toISOString(), new Date(PINNED.getTime() + 601000).toISOString()]) {
    rej(`exp:${exp}`, good, { exp });
  }
  assert.equal(buildReauthorizeSuccessJson(Object.freeze({ authorization_url: good, expires_at: PINNED_EXP }), trusted()), null);
  rej('intent', good, { intent: 'phase_a_onboarding' });
  rej('ver', good, { ver: 'phase_a_v2' });
  assert.equal(buildReauthorizeSuccessJson(b1Dto(good, { gen: '7' }), trusted({ gen: HUGE_GEN })), null);
  assert.equal(buildReauthorizeSuccessJson(b1Dto(good, { gen: HUGE_GEN }), trusted({ gen: '7' })), null);
  assert.ok(buildReauthorizeSuccessJson(b1Dto(good, { gen: '7' }), trusted({ gen: '7' })));
  for (const gen of [0, '0', '01', '7.0', '9223372036854775808', '', null, 7]) {
    assert.equal(buildReauthorizeSuccessJson(b1Dto(good, { gen }), trusted({ gen: HUGE_GEN })), null, String(gen));
  }
  {
    const raw = exactMutable(good);
    assert.equal(Object.isFrozen(raw), false);
    assert.equal(buildReauthorizeSuccessJson(raw, trusted()), null); // freeze gate
    assert.equal(buildReauthorizeSuccessJson(Object.freeze({ ...raw, extra: 1 }), trusted()), null);
    assert.equal(buildReauthorizeSuccessJson(Object.freeze({
      expires_at: PINNED_EXP, authorization_url: good, authorization_intent: 'phase_b_reauthorization',
      scope_version: 'phase_b_v1', prior_grant_generation: HUGE_GEN,
    }), trusted()), null);
    const ac = {};
    for (const [k, v] of Object.entries(raw)) Object.defineProperty(ac, k, { get() { return v; }, enumerable: true });
    assert.equal(buildReauthorizeSuccessJson(ac, trusted()), null);
    assert.equal(buildReauthorizeSuccessJson(new Proxy(raw, { get: (t, p) => t[p] }), trusted()), null);
    for (const [l, u, o] of [
      ['auth', authUrl(b64(), b64(), b64(), (x) => { x.pathname = '/common/oauth2/v2.0/authorize'; }), {}],
      ['redir', authUrl(b64(), b64(), b64(), (x) => { x.searchParams.set('redirect_uri', 'https://evil.example/cb'); }), {}],
      ['scope', authUrl(b64(), b64(), b64(), (x) => { x.searchParams.set('scope', 'openid profile offline_access User.Read'); }), {}],
      ['ttl', good, { exp: new Date(PINNED.getTime() + 601000).toISOString() }],
    ]) assert.equal(buildReauthorizeSuccessJson(b1Dto(u, o), trusted(o)), null, l);
  }
  {
    const real = await createMicrosoftPhaseBReauthorizationTransactionService({
      repository: createPostgresPhaseBReauthTransactionRepository({
        async query(sqlQ, params) {
          assert.match(String(sqlQ), /phase_b_reauthorization/);
          assert.equal(asCanonGen(params[10]), '7');
          return { rows: [{ expires_at: new Date(PINNED.getTime() + 600000), prior_grant_generation: '7',
            authorization_intent: 'phase_b_reauthorization', scope_version: 'phase_b_v1' }] };
        },
      }), env: env(), now: () => PINNED,
    }).start(Object.freeze({
      clientId: CLIENT_UUID, locationId: LOCATION_UUID, endpointId: ENDPOINT,
      staffUserId: STAFF, authSessionId: SESSION, expectedPriorGrantGeneration: '7',
    }));
    assert.ok(Object.isFrozen(real));
    assert.deepEqual(Reflect.ownKeys(real), [...PHASE_B_REAUTH_B1_DTO_KEYS]);
    const t = trusted({ gen: '7' }); const pub = buildReauthorizeSuccessJson(real, t);
    assert.ok(pub); assert.deepEqual(Reflect.ownKeys(pub), ['authorization_url', 'expires_at']);
    assert.equal(pub.expires_at, PINNED_EXP);
    const mu = new URL(real.authorization_url); mu.searchParams.set('prompt', 'none');
    assert.equal(buildReauthorizeSuccessJson(Object.freeze({ ...real, authorization_url: mu.toString() }), t), null);
    assert.equal(buildReauthorizeSuccessJson(Object.freeze({ ...real, expires_at: '1' }), t), null);
    const exp2 = new Date(PINNED.getTime() + 1000 + 600000).toISOString();
    assert.ok(pubOk(goodUrl(), { gen: HUGE_GEN, exp: exp2, nowMs: PINNED.getTime() + 1000 }));
    assert.equal(pubOk(goodUrl(), { gen: HUGE_GEN, exp: PINNED_EXP, nowMs: PINNED.getTime() + 1000 }), null);
    assert.match(SQL_CREATE_PHASE_B_REAUTH, /g\.grant_generation=\$11::bigint/);
  }

  {
    const s = sendCap(); let db = 0;
    const r = createStaffEmailOAuthRoutes({
      runtimeEnv: env(), sendJSON: s.sendJSON, assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: async () => { db += 1; throw new Error('no'); }, now: () => PINNED,
    });
    await r.handleReauthorize(body(), {}, {}, admin(), {
      LUNA_DEPLOYMENT: 'production', [PHASE_B_REAUTH_START_ENABLED_ENV]: 'true',
    });
    assert.equal(s.calls[0].status, 404);
    assert.deepEqual(s.calls[0].body, { success: false, error: 'not_found' });
    assert.equal(db, 0);
    await r.handleReauthorize(body(), {}, {}, admin({ client_slug: 'wolfhouse' }), env());
    assert.equal(s.calls[1].status, 403); assert.equal(db, 0);
  }
  {
    const s = sendCap(); let seen = null; let ins = 0;
    const r = createStaffEmailOAuthRoutes({
      runtimeEnv: env(), sendJSON: s.sendJSON, assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute(a) {
        assert.equal(a.pathname, OAUTH_REAUTHORIZE_PATH);
        assert.equal(a.clientSlug, 'sunset'); assert.equal(a.method, 'POST');
        return { ok: true };
      },
      now: () => PINNED,
      withPgClient: async (fn) => fn({
        async query(sql, params) {
          const q = String(sql || '');
          if (isInsert(q)) {
            ins += 1; assert.equal(asCanonGen(params[10]), HUGE_GEN);
            assert.equal(params[0], CLIENT_UUID); assert.equal(params[1], LOCATION_UUID);
            assert.equal(params[4], ENDPOINT);
            assert.equal(String(params[2]).toLowerCase(), STAFF);
            assert.equal(String(params[3]).toLowerCase(), SESSION);
            return insertOk(new Date(PINNED.getTime() + 600000));
          }
          if (isResolve(q)) { seen = params; return { rows: [row({ grant_generation: HUGE_GEN })] }; }
          throw new Error(`unexpected:${q.slice(0, 60)}`);
        },
      }),
    });
    await r.handleReauthorize(body(), {}, {}, admin(), env());
    assert.equal(s.calls[0].status, 200);
    const b0 = s.calls[0].body;
    assert.deepEqual(Reflect.ownKeys(b0), ['authorization_url', 'expires_at']);
    const u = new URL(b0.authorization_url);
    assert.equal(u.searchParams.get('scope'), CANON_SCOPES);
    assert.equal(u.searchParams.get('client_id'), APP_ID);
    assert.equal(u.searchParams.get('redirect_uri'), CANON_REDIR);
    assert.equal(u.origin + u.pathname, CANON_AUTH);
    assert.equal(u.searchParams.get('prompt'), 'consent');
    assert.ok(PHASE_B_REAUTH_B64URL_32_RE.test(u.searchParams.get('state')));
    assert.equal(JSON.stringify(b0).includes(HUGE_GEN), false);
    assert.deepEqual(seen, [LOCATION, ENDPOINT]); assert.equal(ins, 1);
    await r.handleReauthorize(body(), {}, {}, admin(), env());
    assert.equal(s.calls[1].status, 200);
    assert.notEqual(s.calls[0].body.authorization_url, s.calls[1].body.authorization_url);
    assert.equal(ins, 2);
  }
  {
    const s = sendCap();
    await createStaffEmailOAuthRoutes({
      runtimeEnv: env(), sendJSON: s.sendJSON, assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: async (fn) => fn({ async query() { return { rows: [] }; } }),
    }).handleReauthorize(body(), {}, {}, admin(), env());
    assert.deepEqual(s.calls[0], { status: 404, body: { success: false, error: 'endpoint_not_found' } });
    s.calls.length = 0;
    await createStaffEmailOAuthRoutes({
      runtimeEnv: env(), sendJSON: s.sendJSON, assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: async (fn) => fn({ async query(sql) {
        const q = String(sql || '');
        if (isInsert(q)) throw new Error(`phase_b_reauth_start_endpoint_unavailable ${PLANTED_TOKEN}`);
        if (isResolve(q)) return { rows: [row()] }; throw new Error('x');
      } }),
    }).handleReauthorize(body(), {}, {}, admin(), env());
    assert.equal(s.calls[0].status, 503);
    assert.deepEqual(s.calls[0].body, { success: false, error: REAUTHORIZE_ERROR });
    assert.equal(JSON.stringify(s.calls[0].body).includes(PLANTED_TOKEN), false);
  }
  // Mutant inject (mutable exact + shape/expiry) → fixed 503, zero public projection
  {
    const s = sendCap();
    const pg = async (fn) => fn({ async query(sqlQ) {
      if (isResolve(String(sqlQ || ''))) return { rows: [row({ grant_generation: HUGE_GEN })] };
      throw new Error('no_insert');
    } });
    for (const mutant of [
      Object.freeze({ authorization_url: goodUrl(), expires_at: PINNED_EXP }),
      Object.freeze({ authorization_url: goodUrl(), expires_at: PINNED_EXP, authorization_intent: 'phase_b_reauthorization', scope_version: 'phase_b_v1', prior_grant_generation: '1' }),
      Object.freeze({ authorization_url: goodUrl(), expires_at: new Date(PINNED.getTime() + 600001).toISOString(), authorization_intent: 'phase_b_reauthorization', scope_version: 'phase_b_v1', prior_grant_generation: HUGE_GEN }),
      exactMutable(goodUrl()),
    ]) {
      s.calls.length = 0;
      await createStaffEmailOAuthRoutes({
        runtimeEnv: env(), sendJSON: s.sendJSON, assertStaffClientAccess() { return true; },
        authorizeAuthenticatedStaffRoute() { return { ok: true }; }, now: () => PINNED,
        withPgClient: pg, phaseBReauthStartResult: async () => mutant,
      }).handleReauthorize(body(), {}, {}, admin(), env());
      assert.equal(s.calls[0].status, 503);
      assert.deepEqual(s.calls[0].body, { success: false, error: REAUTHORIZE_ERROR });
      assert.equal(JSON.stringify(s.calls[0].body).includes('phase_b') || JSON.stringify(s.calls[0].body).includes(HUGE_GEN), false);
    }
  }

  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const hi = apiSrc.indexOf("pathname === OAUTH_REAUTHORIZE_PATH && method === 'POST'");
  const block = apiSrc.slice(hi, hi + 2200);
  const ord = ['isPhaseBReauthStartEnabled', 'requireAuth', 'isPhaseBReauthCallerIdentityValid', 'assertStaffClientAccess', 'authorizeAuthenticatedStaffRoute', 'validateOperatorRecoveryJsonContentType', 'readOperatorRecoveryStrictJsonBody'];
  for (let i = 1; i < ord.length; i += 1) assert.ok(block.indexOf(ord[i - 1]) < block.indexOf(ord[i]), ord[i]);
  const routesSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-oauth-routes.js'), 'utf8');
  assert.match(routesSrc, /createMicrosoftPhaseBReauthorizationTransactionService/);
  for (const re of [/PHASE_B_REAUTH_B1_DTO_KEYS/, /pinnedNowMs/, /Object\.isFrozen\(serviceDto\) !== true/,
    /PHASE_B_REAUTH_ROUTE_AUTHORITY =\s*'https:\/\/login\.microsoftonline\.com\/organizations\/oauth2\/v2\.0\/authorize'/,
    /PHASE_B_REAUTH_ROUTE_REDIRECT_URI =\s*'https:\/\/sunset-staging\.lunafrontdesk\.com\/staff\/email\/oauth\/microsoft\/callback'/,
    /PHASE_B_REAUTH_ROUTE_SCOPES =\s*'openid profile offline_access User\.Read Mail\.ReadWrite Mail\.Send'/,
    /PHASE_B_REAUTH_ROUTE_TTL_SECONDS = 600/]) assert.match(routesSrc, re);
  for (const bad of ['AUTHORITY: PHASE_B_REAUTH_AUTHORITY', 'REDIRECT_URI: PHASE_B_REAUTH_REDIRECT_URI',
    'PHASE_B_SCOPES: PHASE_B_REAUTH_SCOPES', 'TTL_SECONDS: PHASE_B_REAUTH_TTL_SECONDS',
    'PHASE_B_REAUTH_EXPIRES_TOLERANCE_MS']) assert.equal(routesSrc.includes(bad), false);
  // Module._load: mutated producer + independent validator reject authority/redirect/scope/TTL
  await assertMutatedProducerRejected();
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/lib/email-microsoft-phase-b-oauth-sunset-staging-runtime-composition.js'), 'utf8'),
    /EMAIL_MS_PHASE_B_CALLBACK_RUNTIME_WIRED = false/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['verify:staff-email-oauth-phase-b-reauthorize-route'],
    'node scripts/verify-staff-email-oauth-phase-b-reauthorize-route.js');
  const baseline = path.join(ROOT, 'config/clients/sunset.baseline.json');
  if (fs.existsSync(baseline)) {
    assert.equal(fs.readFileSync(baseline, 'utf8').includes(PHASE_B_REAUTH_START_ENABLED_ENV), false);
  }

  await assertRouter();
  console.log('verify:staff-email-oauth-phase-b-reauthorize-route: ok');
}

async function withApi(seams, fn) {
  clearCache();
  const api = require('./staff-query-api');
  api.setFortress15j3OfflineSeams(seams);
  const server = api.createStaffQueryApiHttpServer();
  const port = await listen(server);
  try { return await fn(port, api); }
  finally { await close(server); api.setFortress15j3OfflineSeams(null); clearCache(); }
}

async function assertMutatedProducerRejected() {
  const routesAbs = require.resolve('./lib/staff-email-oauth-routes');
  const b1Abs = require.resolve('./lib/email-microsoft-phase-b-reauthorization-transaction-service');
  const realLoad = Module._load; let mut;
  Module._load = (request, parent, isMain) => {
    const loaded = realLoad(request, parent, isMain);
    if (!(parent && parent.filename === routesAbs && String(request).includes('phase-b-reauthorization-transaction'))) return loaded;
    return Object.freeze({ ...loaded, createMicrosoftPhaseBReauthorizationTransactionService(deps) {
      const inner = loaded.createMicrosoftPhaseBReauthorizationTransactionService(deps);
      return Object.freeze({ async start(input) {
        const d = await inner.start(input);
        if (!mut) return Object.freeze({ ...d, expires_at: new Date(PINNED.getTime() + 601000).toISOString() });
        const u = new URL(d.authorization_url); mut(u);
        return Object.freeze({ ...d, authorization_url: u.toString() });
      } });
    } });
  };
  try {
    delete require.cache[routesAbs]; delete require.cache[b1Abs];
    const { createStaffEmailOAuthRoutes: cr } = require('./lib/staff-email-oauth-routes');
    for (const m of [(u) => { u.pathname = '/common/oauth2/v2.0/authorize'; },
      (u) => { u.searchParams.set('redirect_uri', 'https://evil.example/cb'); },
      (u) => { u.searchParams.set('scope', 'openid profile offline_access User.Read'); }, null]) {
      mut = m; const s = sendCap();
      await cr({
        runtimeEnv: env(), sendJSON: s.sendJSON, assertStaffClientAccess() { return true; },
        authorizeAuthenticatedStaffRoute() { return { ok: true }; }, now: () => PINNED,
        withPgClient: async (fn) => fn({ async query(sqlQ) {
          if (isInsert(String(sqlQ || ''))) return insertOk(new Date(PINNED.getTime() + 600000));
          if (isResolve(String(sqlQ || ''))) return { rows: [row({ grant_generation: HUGE_GEN })] };
          throw new Error('x');
        } }),
      }).handleReauthorize(body(), {}, {}, admin(), env());
      assert.equal(s.calls[0].status, 503);
      assert.deepEqual(s.calls[0].body, { success: false, error: REAUTHORIZE_ERROR });
    }
  } finally {
    Module._load = realLoad; delete require.cache[routesAbs]; delete require.cache[b1Abs];
    require('./lib/staff-email-oauth-routes');
  }
}

async function assertRouter() {
  ensureDotenv();
  const keys = [
    'NODE_ENV', 'STAFF_API_FORTRESS_OFFLINE_LISTENER', 'STAFF_AUTH_REQUIRED', 'STAFF_AUTH_HTTPS',
    'STAFF_RUNTIME_PROFILE', 'STAFF_QUERY_API_HOST', 'LUNA_BOT_INTERNAL_TOKEN', 'LUNA_DEPLOYMENT',
    'LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED', 'LUNA_EMAIL_OAUTH_CLIENT_ID',
    'LUNA_EMAIL_OAUTH_START_ENABLED', 'LUNA_EMAIL_OAUTH_CALLBACK_ENABLED',
    'LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    NODE_ENV: 'test', STAFF_RUNTIME_PROFILE: 'test', STAFF_API_FORTRESS_OFFLINE_LISTENER: '1',
    STAFF_AUTH_REQUIRED: 'true', STAFF_AUTH_HTTPS: 'false', STAFF_QUERY_API_HOST: '127.0.0.1',
    LUNA_BOT_INTERNAL_TOKEN: 'reauth_router_offline_token_01_xxxxxx',
  });
  const off = [
    { n: 'flag_absent', e: { LUNA_DEPLOYMENT: 'sunset-staging' }, b: JSON.stringify(body()) },
    { n: 'flag_false', e: { LUNA_DEPLOYMENT: 'sunset-staging', LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED: 'false' }, b: '{x' },
    { n: 'production', e: { LUNA_DEPLOYMENT: 'production', LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED: 'true' }, b: JSON.stringify(body()) },
    { n: 'wolfhouse', e: { LUNA_DEPLOYMENT: 'wolfhouse', LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED: 'true' }, b: '[[[' },
    { n: 'TRUE_case', e: { LUNA_DEPLOYMENT: 'sunset-staging', LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED: 'TRUE' }, b: JSON.stringify(body()) },
  ];
  try {
    for (const c of off) {
      delete process.env.LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED;
      process.env.LUNA_DEPLOYMENT = c.e.LUNA_DEPLOYMENT;
      if (c.e.LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED != null) {
        process.env.LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED = c.e.LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED;
      }
      assert.equal(isPhaseBReauthStartEnabled(snapshotPhaseBReauthGateEnv(process.env)), false, c.n);
      const counts = installBodyCounters();
      let db = 0; let auth = 0;
      await withApi({
        withPgClient: async () => { db += 1; throw new Error('gate_db'); },
        resolveSessionUser() { auth += 1; return admin(); }, canAccessClient() { return true; },
      }, async (port) => {
        const res = await request(port, { headers: { 'content-type': 'application/json' }, body: c.b });
        assert.equal(res.status, 404, c.n);
        assert.deepEqual(res.body, { success: false, error: 'not_found' }, c.n);
        assert.equal(db, 0, c.n); assert.equal(auth, 0, c.n);
        assert.equal(counts.ct, 0, c.n); assert.equal(counts.body, 0, c.n);
      });
    }

    process.env.LUNA_DEPLOYMENT = 'sunset-staging';
    process.env.LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED = 'true';
    process.env.LUNA_EMAIL_OAUTH_CLIENT_ID = APP_ID;
    delete process.env.LUNA_EMAIL_OAUTH_START_ENABLED;
    delete process.env.LUNA_EMAIL_OAUTH_CALLBACK_ENABLED;
    delete process.env.LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED;

    for (const caseSpec of [
      { slug: 'wolfhouse', body: '{not-json', expect: (s) => assert.ok(s === 403 || s === 401) },
      { slug: 'sunset', body: '[[[', expect: (s, b) => { assert.equal(s, 403); assert.equal(b && b.error, 'client_access_denied'); } },
    ]) {
      const counts = installBodyCounters(); let db = 0;
      await withApi({
        withPgClient: async () => { db += 1; throw new Error('no'); },
        resolveSessionUser(req) {
          return String((req.headers && req.headers.cookie) || '').includes(SESSION_COOKIE)
            ? admin({ client_slug: caseSpec.slug }) : null;
        },
        canAccessClient() { return false; },
      }, async (port) => {
        const res = await request(port, {
          headers: { 'content-type': 'text/plain', cookie: `luna_staff_session=${SESSION_COOKIE}` },
          body: caseSpec.body,
        });
        caseSpec.expect(res.status, res.body);
        assert.equal(db, 0); assert.equal(counts.ct, 0); assert.equal(counts.body, 0);
      });
    }

    const counts = installBodyCounters();
    let db = 0; let ins = 0; const urls = [];
    await withApi({
      withPgClient: async (fn) => {
        db += 1;
        return fn({
          async query(sqlQ, params) {
            const q = String(sqlQ || '');
            if (isInsert(q)) { ins += 1; assert.equal(asCanonGen(params[10]), HUGE_GEN); return insertOk(); }
            if (isResolve(q)) {
              assert.deepEqual(params, [LOCATION, ENDPOINT]);
              return { rows: [row({ grant_generation: HUGE_GEN })] };
            }
            throw new Error(`unexpected:${q.slice(0, 80)}`);
          },
        });
      },
      resolveSessionUser(req) {
        return String((req.headers && req.headers.cookie) || '').includes(SESSION_COOKIE) ? admin() : null;
      },
      canAccessClient(u, s) { return !!(u && u.client_slug === 'sunset' && s === 'sunset'); },
    }, async (port) => {
      const cookie = `luna_staff_session=${SESSION_COOKIE}`;
      db = 0; counts.ct = 0; counts.body = 0;
      let res = await request(port, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) });
      assert.ok(res.status === 401 || res.status === 403); assert.equal(db, 0);
      assert.equal(counts.ct, 0); assert.equal(counts.body, 0);
      res = await request(port, { headers: { 'content-type': 'text/plain', cookie }, body: JSON.stringify(body()) });
      assert.equal(res.status, 400); assert.deepEqual(res.body, { success: false, error: 'invalid_request' });
      assert.ok(counts.ct >= 1); assert.equal(counts.body, 0);
      for (const bad of [
        `{"location_id":"${LOCATION}","location_id":"other","endpoint_id":"${ENDPOINT}"}`,
        JSON.stringify({ location_id: LOCATION, endpoint_id: ENDPOINT, client_id: CLIENT_UUID }),
      ]) {
        res = await request(port, { headers: { 'content-type': 'application/json', cookie }, body: bad });
        assert.equal(res.status, 400);
      }
      res = await request(port, {
        headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body()),
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(Reflect.ownKeys(res.body), ['authorization_url', 'expires_at']);
      urls.push(res.body.authorization_url);
      assert.equal(JSON.stringify(res.body).includes(HUGE_GEN), false); assert.equal(ins, 1);
      res = await request(port, {
        headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body()),
      });
      assert.equal(res.status, 200); urls.push(res.body.authorization_url);
      assert.notEqual(urls[0], urls[1]); assert.equal(ins, 2);
      const beforeIns = ins;
      const concurrent = await Promise.all([1, 2, 3].map(() => request(port, {
        headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body()),
      })));
      for (const r of concurrent) {
        assert.equal(r.status, 200);
        assert.deepEqual(Reflect.ownKeys(r.body), ['authorization_url', 'expires_at']);
      }
      assert.equal(new Set(concurrent.map((r) => r.body.authorization_url)).size, 3);
      assert.equal(ins, beforeIns + 3);
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    clearCache();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
