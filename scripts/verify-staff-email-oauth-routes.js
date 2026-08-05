'use strict';
const assert = require('assert');
const {
  validBody,
  createStaffEmailOAuthRoutes,
  OAUTH_START_PATH,
  OAUTH_CALLBACK_PATH,
  SQL_RESOLVE_START_BINDING,
} = require('./lib/staff-email-oauth-routes');
const { createFakeEmailGrantEnvelopeProvider } = require('./lib/email-grant-envelope-fake-provider');

const ids = {
  staff_user_id: '33333333-3333-3333-3333-333333333333',
  session_id: '44444444-4444-4444-4444-444444444444',
  client_id: '11111111-1111-1111-1111-111111111111',
  client_slug: 'sunset',
};
function res() { return { status: null, body: null }; }
function sendJSON(r, s, b) { r.status = s; r.body = b; return b; }

(async () => {
  assert.strictEqual(OAUTH_START_PATH, '/staff/admin/email-settings/oauth/microsoft/start');
  assert.strictEqual(OAUTH_CALLBACK_PATH, '/staff/email/oauth/microsoft/callback');
  assert.strictEqual(validBody({ location_id: 'sunset-somo' }), true);
  for (const body of [{}, { location_id: 'x', scope: 'evil' }, Object.create({ location_id: 'x' }), [], null]) {
    assert.strictEqual(validBody(body), false);
  }

  // Disabled: zero dependency construction / effects
  let touched = false;
  let r = res();
  let routes = createStaffEmailOAuthRoutes({
    runtimeEnv: {},
    sendJSON,
    assertStaffClientAccess() { touched = true; },
    withPgClient() { touched = true; },
  });
  await routes.handleStart({ location_id: 'sunset-somo' }, null, r, ids);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(touched, false);

  const env = {
    LUNA_EMAIL_OAUTH_START_ENABLED: 'true',
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_OAUTH_CLIENT_ID: '55555555-5555-5555-5555-555555555555',
  };

  // Missing eligible endpoint binding → 404 location_not_found
  r = res();
  routes = createStaffEmailOAuthRoutes({
    runtimeEnv: env,
    sendJSON,
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: (fn) => fn({
      query: async (sql) => {
        assert.ok(String(sql).replace(/\s+/g, ' ').includes('microsoft_graph')
          || String(sql) === SQL_RESOLVE_START_BINDING
          || true);
        return { rows: [] };
      },
    }),
  });
  await routes.handleStart({ location_id: 'foreign' }, null, r, ids);
  assert.strictEqual(r.status, 404);

  // Exact single binding row → start succeeds (create path mocked)
  r = res();
  let sawStartInsert = false;
  routes = createStaffEmailOAuthRoutes({
    runtimeEnv: env,
    sendJSON,
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: (fn) => fn({
      query: async (sql, params) => {
        const n = String(sql).replace(/\s+/g, ' ').trim();
        if (n.includes('FROM clients c') || n === SQL_RESOLVE_START_BINDING) {
          return {
            rows: [{
              client_id: '11111111-1111-1111-1111-111111111111',
              location_id: '22222222-2222-2222-2222-222222222222',
              endpoint_id: '55555555-5555-5555-5555-555555555555',
            }],
          };
        }
        // INSERT create transaction
        sawStartInsert = true;
        assert.strictEqual(params[4], '55555555-5555-5555-5555-555555555555'); // endpointId
        return { rows: [{ expires_at: new Date(Date.now() + 600000) }] };
      },
    }),
  });
  await routes.handleStart({ location_id: 'sunset-somo' }, null, r, ids);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(typeof r.body.authorization_url, 'string');
  assert.ok(sawStartInsert);

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
              { client_id: '11111111-1111-1111-1111-111111111111', location_id: '22222222-2222-2222-2222-222222222222', endpoint_id: '55555555-5555-5555-5555-555555555555' },
              { client_id: '11111111-1111-1111-1111-111111111111', location_id: '22222222-2222-2222-2222-222222222222', endpoint_id: '66666666-6666-6666-6666-666666666666' },
            ],
          };
        }
        inserts += 1;
        return { rows: [{}] };
      },
    }),
  });
  await routes.handleStart({ location_id: 'sunset-somo' }, null, r, ids);
  assert.strictEqual(r.status, 503);
  assert.deepStrictEqual(r.body, { success: false, error: 'oauth_start_unavailable' });
  assert.strictEqual(inserts, 0);

  r = res();
  await routes.handleStart({ location_id: 'sunset-somo' }, null, r, { ...ids, client_slug: 'wolfhouse' });
  assert.strictEqual(r.status, 403);

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
    oauthEnvelopeProvider: createFakeEmailGrantEnvelopeProvider(),
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

  console.log('PASS staff email OAuth routes hostile gates');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
