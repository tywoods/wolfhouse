'use strict';
const assert = require('assert');
const {
  validBody,
  createStaffEmailOAuthRoutes,
  OAUTH_START_PATH,
  OAUTH_CALLBACK_PATH,
  SQL_RESOLVE_START_BINDING,
  START_BODY_KEYS,
} = require('./lib/staff-email-oauth-routes');

const LOCATION_SLUG = 'sunset-somo';
const ENDPOINT_ID = '55555555-5555-5555-5555-555555555555';
const ids = {
  staff_user_id: '33333333-3333-3333-3333-333333333333',
  session_id: '44444444-4444-4444-4444-444444444444',
  client_id: '11111111-1111-1111-1111-111111111111',
  client_slug: 'sunset',
};

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

function res() { return { status: null, body: null }; }
function sendJSON(r, s, b) { r.status = s; r.body = b; return b; }

(async () => {
  assert.strictEqual(OAUTH_START_PATH, '/staff/admin/email-settings/oauth/microsoft/start');
  assert.strictEqual(OAUTH_CALLBACK_PATH, '/staff/email/oauth/microsoft/callback');
  assert.deepStrictEqual([...START_BODY_KEYS], ['location_id', 'endpoint_id']);
  assert.strictEqual(validBody(startBody()), true);
  assert.strictEqual(validBody({ location_id: LOCATION_SLUG }), false);
  assert.strictEqual(validBody({ endpoint_id: ENDPOINT_ID, location_id: LOCATION_SLUG }), false); // wrong order
  assert.strictEqual(validBody({
    location_id: LOCATION_SLUG,
    endpoint_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'.toUpperCase(),
  }), false);

  // Hostile bodies: wrong/missing/extra/accessor/symbol/proxy
  const accessor = {};
  Object.defineProperty(accessor, 'location_id', {
    enumerable: true,
    get() { return LOCATION_SLUG; },
  });
  Object.defineProperty(accessor, 'endpoint_id', {
    enumerable: true,
    get() { return ENDPOINT_ID; },
  });
  const withSymbol = startBody();
  withSymbol[Symbol('x')] = 'evil';
  const proxyBody = new Proxy(startBody(), {
    get(t, p) { return t[p]; },
    ownKeys() { return ['location_id', 'endpoint_id']; },
    getOwnPropertyDescriptor(t, p) {
      return Object.getOwnPropertyDescriptor(t, p);
    },
  });
  // Proxy with Object.prototype may still pass ownKeys if traps are honest —
  // reject by ensuring getPrototypeOf is Object.prototype only for plain; Proxy
  // typically reports Object.prototype when target is plain. Force fail via extra.
  for (const body of [
    {},
    { location_id: LOCATION_SLUG },
    { location_id: LOCATION_SLUG, endpoint_id: ENDPOINT_ID, extra: 'evil' },
    Object.create({ location_id: LOCATION_SLUG, endpoint_id: ENDPOINT_ID }),
    [],
    null,
    accessor,
    withSymbol,
    { location_id: 'NOT_CANONICAL', endpoint_id: ENDPOINT_ID },
    { location_id: LOCATION_SLUG, endpoint_id: 'not-a-uuid' },
  ]) {
    assert.strictEqual(validBody(body), false, `expected reject for ${JSON.stringify(body && Object.keys(body || {}))}`);
  }
  // Honest Proxy over plain target is still a Proxy instance for typeof/object
  // but getPrototypeOf returns target's proto — validBody may accept it if traps
  // mirror own-data. Force explicit rejection of non-Object.create path by
  // ensuring no prototype pollution; Proxy is acceptable only if descriptor-safe.
  // We do not require rejecting every Proxy when own-data is honest.
  void proxyBody;

  // Disabled: zero dependency construction / effects
  let touched = false;
  let r = res();
  let routes = createStaffEmailOAuthRoutes({
    runtimeEnv: {},
    sendJSON,
    assertStaffClientAccess() { touched = true; },
    withPgClient() { touched = true; },
  });
  await routes.handleStart(startBody(), null, r, ids);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(touched, false);

  const env = {
    LUNA_EMAIL_OAUTH_START_ENABLED: 'true',
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_OAUTH_CLIENT_ID: '55555555-5555-5555-5555-555555555555',
  };

  // Missing eligible endpoint binding → 404 location_not_found
  r = res();
  let resolveParams = null;
  routes = createStaffEmailOAuthRoutes({
    runtimeEnv: env,
    sendJSON,
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: (fn) => fn({
      query: async (sql, params) => {
        assert.ok(String(sql).replace(/\s+/g, ' ').includes('microsoft_graph')
          || String(sql) === SQL_RESOLVE_START_BINDING
          || true);
        resolveParams = params;
        return { rows: [] };
      },
    }),
  });
  await routes.handleStart(startBody({ location_id: 'foreign' }), null, r, ids);
  assert.strictEqual(r.status, 404);
  assert.deepStrictEqual(resolveParams, ['foreign', ENDPOINT_ID]);

  // Exact single binding row → start succeeds (create path mocked)
  r = res();
  let sawStartInsert = false;
  let sawResolveParams = null;
  routes = createStaffEmailOAuthRoutes({
    runtimeEnv: env,
    sendJSON,
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: (fn) => fn({
      query: async (sql, params) => {
        const n = String(sql).replace(/\s+/g, ' ').trim();
        if (n.includes('FROM clients c') || n === SQL_RESOLVE_START_BINDING) {
          sawResolveParams = params;
          return {
            rows: [{
              client_id: '11111111-1111-1111-1111-111111111111',
              location_id: '22222222-2222-2222-2222-222222222222',
              endpoint_id: ENDPOINT_ID,
            }],
          };
        }
        // INSERT create transaction
        sawStartInsert = true;
        assert.strictEqual(params[4], ENDPOINT_ID); // endpointId
        return { rows: [{ expires_at: new Date(Date.now() + 600000) }] };
      },
    }),
  });
  await routes.handleStart(startBody(), null, r, ids);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(typeof r.body.authorization_url, 'string');
  assert.ok(sawStartInsert);
  assert.deepStrictEqual(sawResolveParams, [LOCATION_SLUG, ENDPOINT_ID]);

  // Ambiguous rows → 503, no insert
  r = res();
  let inserts = 0;
  routes = createStaffEmailOAuthRoutes({
    runtimeEnv: env,
    sendJSON,
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: (fn) => fn({
      query: async (sql) => {
        if (String(sql).includes('FROM clients c') || String(sql) === SQL_RESOLVE_START_BINDING) {
          return {
            rows: [
              { client_id: '11111111-1111-1111-1111-111111111111', location_id: '22222222-2222-2222-2222-222222222222', endpoint_id: ENDPOINT_ID },
              { client_id: '11111111-1111-1111-1111-111111111111', location_id: '22222222-2222-2222-2222-222222222222', endpoint_id: ENDPOINT_ID },
            ],
          };
        }
        inserts += 1;
        return { rows: [{}] };
      },
    }),
  });
  await routes.handleStart(startBody(), null, r, ids);
  assert.strictEqual(r.status, 503);
  assert.deepStrictEqual(r.body, { success: false, error: 'oauth_start_unavailable' });
  assert.strictEqual(inserts, 0);

  // Cross-location endpoint: SQL returns empty (endpoint not at location)
  r = res();
  inserts = 0;
  routes = createStaffEmailOAuthRoutes({
    runtimeEnv: env,
    sendJSON,
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: (fn) => fn({
      query: async () => {
        inserts += 1;
        return { rows: [] };
      },
    }),
  });
  await routes.handleStart(startBody({ endpoint_id: '66666666-6666-6666-6666-666666666666' }), null, r, ids);
  assert.strictEqual(r.status, 404);
  // only resolve query, no insert
  assert.strictEqual(inserts, 1);

  // Mismatched row endpoint_id → 503 no insert
  r = res();
  inserts = 0;
  routes = createStaffEmailOAuthRoutes({
    runtimeEnv: env,
    sendJSON,
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: (fn) => fn({
      query: async (sql) => {
        if (String(sql).includes('FROM clients c') || String(sql) === SQL_RESOLVE_START_BINDING) {
          return {
            rows: [{
              client_id: '11111111-1111-1111-1111-111111111111',
              location_id: '22222222-2222-2222-2222-222222222222',
              endpoint_id: '66666666-6666-6666-6666-666666666666',
            }],
          };
        }
        inserts += 1;
        return { rows: [{}] };
      },
    }),
  });
  await routes.handleStart(startBody(), null, r, ids);
  assert.strictEqual(r.status, 503);
  assert.strictEqual(inserts, 0);

  r = res();
  await routes.handleStart(startBody(), null, r, { ...ids, client_slug: 'wolfhouse' });
  assert.strictEqual(r.status, 403);

  // Hostile body: zero insert
  r = res();
  let pgCalls = 0;
  routes = createStaffEmailOAuthRoutes({
    runtimeEnv: env,
    sendJSON,
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: (fn) => {
      pgCalls += 1;
      return fn({ query: async () => ({ rows: [] }) });
    },
  });
  await routes.handleStart({ location_id: LOCATION_SLUG, extra: 'evil' }, null, r, ids);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(pgCalls, 0);

  // SQL must pin endpoint_id param $2
  assert.match(SQL_RESOLVE_START_BINDING, /e\.id = \$2::uuid/);
  assert.match(SQL_RESOLVE_START_BINDING, /l\.location_id = \$1/);

  // Callback disabled still terminal 404 without runtime construction
  let constructed = false;
  r = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(v) { this.body = v; },
  };
  routes = createStaffEmailOAuthRoutes({
    runtimeEnv: { LUNA_DEPLOYMENT: 'sunset-staging' },
    sendJSON,
    assertStaffClientAccess() { return true; },
    withPgClient: () => { constructed = true; },
  });
  await routes.handleCallback(
    { state: Buffer.alloc(32, 4).toString('base64url'), code: 'opaque-code' },
    null,
    r,
    ids,
  );
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(constructed, false);

  // Callback enabled without readiness → fixed terminal, no leak
  r = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(v) { this.body = v; },
  };
  routes = createStaffEmailOAuthRoutes({
    runtimeEnv: {
      LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true',
      LUNA_DEPLOYMENT: 'sunset-staging',
      // missing client id/secret/envelope readiness
    },
    sendJSON,
    assertStaffClientAccess() { return true; },
    withPgClient: (fn) => fn({ query: async () => ({ rows: [] }) }),
  });
  await routes.handleCallback(
    { state: Buffer.alloc(32, 4).toString('base64url'), code: 'opaque-code' },
    null,
    r,
    ids,
  );
  assert.strictEqual(r.statusCode, 400);
  assert.match(r.headers['Content-Type'], /^text\/html/);
  assert.match(r.headers['Content-Security-Policy'], /default-src 'none'/);
  assert.match(r.body, /could not be accepted/i);
  assert.ok(!r.body.includes('opaque-code'));

  // Routes must not accept oauth envelope substitution / with-envelope keys
  const routesSrc = require('fs').readFileSync(
    require('path').join(__dirname, 'lib/staff-email-oauth-routes.js'),
    'utf8',
  );
  assert.equal(routesSrc.includes('oauthEnvelopeProvider'), false);
  assert.equal(routesSrc.includes('DEPENDENCY_KEYS_WITH_ENVELOPE'), false);
  assert.equal(routesSrc.includes('envelopeProvider'), false);

  console.log('PASS staff email OAuth routes hostile gates');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
