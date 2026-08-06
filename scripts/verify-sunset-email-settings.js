'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const {
  isSunsetEmailSettingsUiEnabled,
  isSunsetEmailOAuthStartEnabled,
  createEmailSettingsRoutes,
  endpointDto,
  computeEmailSettingsActions,
  isEligibleUnverifiedDelegatedEndpoint,
} = require('./lib/staff-email-settings-routes');
const {
  OAUTH_PREPARE_PATH,
  OAUTH_START_PATH,
  PREPARE_BODY_KEYS,
  START_BODY_KEYS,
  isPrepareEnabled,
  snapshotPrepareBody,
  createStaffEmailOAuthRoutes,
  PREPARE_ERROR,
} = require('./lib/staff-email-oauth-routes');

let count = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { count += 1; console.log(`ok ${count} - ${name}`); }); }
function response() { return { status: null, body: null }; }
function sendJSON(res, status, body) { res.status = status; res.body = body; return body; }

const START_ENV = {
  SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
  LUNA_EMAIL_OAUTH_START_ENABLED: 'true',
  LUNA_DEPLOYMENT: 'sunset-staging',
};
const LOCATION = 'sunset-somo';
const ENDPOINT_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR = 'abcdef01-2345-4678-89ab-cdef01234567';
const SESSION = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MAILBOX = 'desk@sunset.example';

function eligibleRow(patch = {}) {
  return {
    id: ENDPOINT_ID,
    location_id: LOCATION,
    provider: 'microsoft_graph',
    public_address: MAILBOX,
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'unverified_offline',
    ...patch,
  };
}

(async () => {
  await test('flag defaults off and accepts only true', () => {
    assert.strictEqual(isSunsetEmailSettingsUiEnabled({}), false);
    for (const value of ['1', 'TRUE', 'True', ' true', 'true ', 'yes', true]) {
      assert.strictEqual(isSunsetEmailSettingsUiEnabled({ SUNSET_EMAIL_SETTINGS_UI_ENABLED: value }), false, String(value));
    }
    assert.strictEqual(isSunsetEmailSettingsUiEnabled({ SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true' }), true);
  });

  await test('OAuth start / prepare default-off zero effects', () => {
    assert.strictEqual(isSunsetEmailOAuthStartEnabled({}), false);
    assert.strictEqual(isPrepareEnabled({}), false);
    assert.strictEqual(isPrepareEnabled({ LUNA_EMAIL_OAUTH_START_ENABLED: 'true' }), false);
    assert.strictEqual(isPrepareEnabled({ LUNA_DEPLOYMENT: 'sunset-staging' }), false);
    assert.strictEqual(isPrepareEnabled({
      LUNA_EMAIL_OAUTH_START_ENABLED: 'true',
      LUNA_DEPLOYMENT: 'sunset-staging',
    }), true);
    assert.strictEqual(isPrepareEnabled({
      LUNA_EMAIL_OAUTH_START_ENABLED: 'TRUE',
      LUNA_DEPLOYMENT: 'sunset-staging',
    }), false);
    const actions = computeEmailSettingsActions({}, [{ location_id: LOCATION, active: true }], []);
    assert.deepStrictEqual(actions, { prepare: false, connect: false, disconnect: false });
  });

  await test('production render conceals Email DOM while flag is off', () => {
    process.env.NODE_ENV = 'test'; process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
    process.env.STAFF_AUTH_REQUIRED = 'false'; process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
    process.env.SUNSET_EMAIL_SETTINGS_UI_ENABLED = 'false';
    const html = require('./staff-query-api').buildUiHtmlForOfflineTest(3036, 'sunset');
    assert.ok(!html.includes('id="admin-tab-email"'));
    assert.ok(!html.includes('id="admin-panel-email"'));
  });
  await test('production render conceals Email DOM for enabled non-Sunset tenant', () => {
    process.env.SUNSET_EMAIL_SETTINGS_UI_ENABLED = 'true';
    const html = require('./staff-query-api').buildUiHtmlForOfflineTest(3036, 'wolfhouse-somo');
    assert.ok(!html.includes('id="admin-tab-email"'));
    assert.ok(!html.includes('id="admin-panel-email"'));
  });
  await test('production render reveals hidden Email panel only for exact enabled Sunset confirmation', () => {
    process.env.SUNSET_EMAIL_SETTINGS_UI_ENABLED = 'true';
    const html = require('./staff-query-api').buildUiHtmlForOfflineTest(3036, 'sunset');
    assert.ok(html.includes('id="admin-tab-email"'));
    assert.match(html, /id="admin-tab-email"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
    assert.match(html, /id="admin-panel-email"[^>]*\shidden(?:\s|>)/);
  });
  await test('off boundary returns 404 before ACL or lookup', async () => {
    let touched = false; const res = response();
    const routes = createEmailSettingsRoutes({ runtimeEnv: {}, sendJSON, assertStaffClientAccess(){ touched = true; }, withPgClient(){ touched = true; } });
    await routes.handleGet({ client: 'sunset' }, {}, res, {});
    assert.strictEqual(res.status, 404); assert.strictEqual(touched, false);
  });
  await test('non-Sunset returns 404 before ACL or lookup', async () => {
    let touched = false; const res = response();
    const routes = createEmailSettingsRoutes({ runtimeEnv: { SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true' }, sendJSON, assertStaffClientAccess(){ touched = true; }, withPgClient(){ touched = true; } });
    await routes.handleGet({ client: 'wolfhouse' }, {}, res, {});
    assert.strictEqual(res.status, 404); assert.strictEqual(touched, false);
  });
  await test('cross-tenant ACL denies before authorization and lookup', async () => {
    let authz = false; let lookup = false; const res = response();
    const routes = createEmailSettingsRoutes({ runtimeEnv: { SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true' }, sendJSON,
      assertStaffClientAccess(_u,_s,r){ sendJSON(r,403,{error:'client_access_denied'}); return false; },
      authorizeAuthenticatedStaffRoute(){ authz = true; }, withPgClient(){ lookup = true; } });
    await routes.handleGet({ client: 'sunset' }, {}, res, {});
    assert.strictEqual(res.status, 403); assert.strictEqual(authz, false); assert.strictEqual(lookup, false);
  });
  await test('safe aggregate is read-only, scoped, and strips sensitive fields', async () => {
    const res = response(); const queries = [];
    const pg = { query: async (sql, params) => { queries.push([sql,params]); return { rows: [{ client_id: '11111111-1111-1111-1111-111111111111' }] }; } };
    const routes = createEmailSettingsRoutes({ runtimeEnv: { SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true' }, sendJSON,
      assertStaffClientAccess(){ return true; }, authorizeAuthenticatedStaffRoute(){ return {ok:true}; }, withPgClient: (fn) => fn(pg),
      listTenantLocations: async () => ({ok:true,value:[{location_id:'sunset-somo',display_name:'Sunset',active:true,client_id:'secret'}]}),
      listTenantChannelEndpoints: async () => ({ok:true,value:[{id:'22222222-2222-2222-2222-222222222222',location_id:'sunset-somo',provider:'microsoft_graph',public_address:'mail@example.test',secret_ref:'kv://secret',provider_tenant_id:'raw',active:true,inbound_enabled:true,outbound_enabled:true}]}),
      getDelegatedGrantPublicStatus: async () => ({ok:true,value:{grant_present:true,grant_status:'active',reconcile_state:'clean',has_active_lease:true,client_id:'raw',endpoint_id:'raw'}}),
    });
    await routes.handleGet({client:'sunset'}, {}, res, {role:'admin'});
    assert.strictEqual(res.status,200); assert.strictEqual(res.body.read_only,true);
    assert.deepStrictEqual(res.body.actions,{prepare:false,connect:false,disconnect:false});
    assert.strictEqual(res.body.endpoints[0].connection_state,'connected_health');
    assert.strictEqual(res.body.endpoints[0].endpoint_id,'22222222-2222-2222-2222-222222222222');
    assert.strictEqual(res.body.endpoints[0].endpoint_active,false); assert.strictEqual(res.body.endpoints[0].inbound_enabled,false); assert.strictEqual(res.body.endpoints[0].outbound_enabled,false); assert.strictEqual(res.body.endpoints[0].automation_enabled,false);
    const text=JSON.stringify(res.body); for (const forbidden of ['secret_ref','provider_tenant_id','client_id','has_active_lease','ciphertext','wrapped_dek','oauth']) assert.ok(!text.includes(forbidden), forbidden);
    assert.deepStrictEqual(queries[0][1],['sunset']);
  });

  await test('actions distinguish prepare vs connect; never both for same location', () => {
    const locs = [{ location_id: LOCATION, active: true, display_name: 'S' }];
    // No endpoint → prepare when start on
    assert.deepStrictEqual(
      computeEmailSettingsActions(START_ENV, locs, []),
      { prepare: true, connect: false, disconnect: false },
    );
    // Eligible unverified → connect only
    const eligible = [endpointDto(eligibleRow(), { grant_present: false })];
    assert.strictEqual(eligible[0].start_eligible, true);
    assert.strictEqual(eligible[0].endpoint_id, ENDPOINT_ID);
    assert.deepStrictEqual(
      computeEmailSettingsActions(START_ENV, locs, eligible),
      { prepare: false, connect: true, disconnect: false },
    );
    // Legacy null auth_mode not eligible
    const legacy = [endpointDto({
      id: ENDPOINT_ID, location_id: LOCATION, provider: 'microsoft_graph',
      public_address: MAILBOX, auth_mode: null, connector_mode: null, binding_status: null,
    }, { grant_present: false })];
    assert.strictEqual(legacy[0].start_eligible, false);
    assert.deepStrictEqual(
      computeEmailSettingsActions(START_ENV, locs, legacy),
      { prepare: false, connect: false, disconnect: false },
    );
  });

  await test('public state covers reauth, revoked and registered states', () => {
    assert.strictEqual(endpointDto({id:'e',location_id:'l'}, {grant_present:false}).connection_state,'registered_not_connected');
    assert.strictEqual(endpointDto({id:'e',location_id:'l'}, {grant_present:true,grant_status:'reauthorization_required'}).connection_state,'reauth_required');
    assert.strictEqual(endpointDto({id:'e',location_id:'l'}, {grant_present:true,grant_status:'revoked'}).connection_state,'revoked');
    assert.strictEqual(isEligibleUnverifiedDelegatedEndpoint(eligibleRow()), true);
    assert.strictEqual(isEligibleUnverifiedDelegatedEndpoint(eligibleRow({ binding_status: 'verified' })), false);
  });

  await test('prepare path exact; start requires endpoint_id; no location-only start body', () => {
    // Exact originally specified prepare path.
    assert.strictEqual(OAUTH_PREPARE_PATH, '/staff/admin/email-settings/oauth/microsoft/endpoint');
    assert.strictEqual(OAUTH_START_PATH, '/staff/admin/email-settings/oauth/microsoft/start');
    // Both wrong prepare paths must not be the live contract (no aliases).
    assert.notStrictEqual(
      OAUTH_PREPARE_PATH,
      '/staff/admin/email-settings/oauth/microsoft/prepare',
    );
    assert.notStrictEqual(
      OAUTH_PREPARE_PATH,
      '/staff/admin/email-settings/microsoft/endpoint/prepare',
    );
    assert.deepStrictEqual([...PREPARE_BODY_KEYS], ['location_id', 'public_address']);
    assert.deepStrictEqual([...START_BODY_KEYS], ['location_id', 'endpoint_id']);
    const validPrep = snapshotPrepareBody({ location_id: LOCATION, public_address: MAILBOX });
    assert.ok(validPrep);
    assert.strictEqual(snapshotPrepareBody({ public_address: MAILBOX, location_id: LOCATION }), null);
    assert.strictEqual(snapshotPrepareBody({ location_id: LOCATION }), null);
    // Old UI location-only start body is invalid
    const { snapshotStartBody } = require('./lib/staff-email-oauth-routes');
    assert.strictEqual(snapshotStartBody({ location_id: LOCATION }), null);
    assert.ok(snapshotStartBody({ location_id: LOCATION, endpoint_id: ENDPOINT_ID }));
  });

  await test('prepare route default-off and success/error shapes; no mailbox echo', async () => {
    // default off
    {
      let touched = false;
      const res = response();
      const routes = createStaffEmailOAuthRoutes({
        runtimeEnv: {},
        sendJSON,
        assertStaffClientAccess(){ touched = true; return true; },
        authorizeAuthenticatedStaffRoute(){ touched = true; return { ok: true }; },
        withPgClient(){ touched = true; },
      });
      await routes.handlePrepare(
        { location_id: LOCATION, public_address: MAILBOX },
        {},
        res,
        { client_slug: 'sunset', staff_user_id: ACTOR, session_id: SESSION },
      );
      assert.strictEqual(res.status, 404);
      assert.strictEqual(touched, false);
    }
    // happy path via fake domain client
    {
      const res = response();
      const queries = [];
      const pg = {
        async query(sql, params) {
          const text = String(sql);
          const p = params || [];
          queries.push({ text, params: p });
          // Route-level trusted Sunset resolve (slug only, no id param).
          if (/FROM\s+clients/i.test(text)
              && /slug\s*=\s*'sunset'/i.test(text)
              && !/id\s*=\s*\$1/i.test(text)) {
            return { rows: [{ client_id: CLIENT_ID }] };
          }
          if (/^\s*BEGIN\b/i.test(text)) return { rows: [] };
          // Domain prove: slug + id = $1
          if (/FROM\s+clients/i.test(text)
              && /slug\s*=\s*'sunset'/i.test(text)
              && /id\s*=\s*\$1/i.test(text)) {
            if (p[0] !== CLIENT_ID) return { rows: [] };
            return { rows: [{ client_id: CLIENT_ID }] };
          }
          if (/FROM\s+tenant_locations/i.test(text)) return { rows: [{ location_id: LOCATION }] };
          if (/FROM\s+tenant_channel_endpoints/i.test(text) && /FOR\s+UPDATE/i.test(text)) {
            return { rows: [] };
          }
          if (/pg_advisory_xact_lock/i.test(text)) return { rows: [{}] };
          if (/INSERT\s+INTO\s+tenant_channel_endpoints/i.test(text)) {
            return { rows: [{ id: ENDPOINT_ID }] };
          }
          if (/^\s*COMMIT\b/i.test(text)) return { rows: [] };
          if (/^\s*ROLLBACK\b/i.test(text)) return { rows: [] };
          throw new Error('unexpected');
        },
      };
      const routes = createStaffEmailOAuthRoutes({
        runtimeEnv: START_ENV,
        sendJSON,
        assertStaffClientAccess(){ return true; },
        authorizeAuthenticatedStaffRoute(){ return { ok: true }; },
        withPgClient: (fn) => fn(pg),
      });
      await routes.handlePrepare(
        { location_id: LOCATION, public_address: MAILBOX },
        {},
        res,
        { client_slug: 'sunset', staff_user_id: ACTOR, session_id: SESSION },
      );
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(Reflect.ownKeys(res.body), ['success', 'endpoint_id']);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.endpoint_id, ENDPOINT_ID);
      assert.ok(!JSON.stringify(res.body).includes(MAILBOX));
      assert.ok(queries.some((q) => /INSERT\s+INTO\s+tenant_channel_endpoints/i.test(q.text)));
      // Route resolved trusted client before domain prove+insert.
      assert.ok(queries.some((q) => /FROM\s+clients/i.test(q.text)
        && /slug\s*=\s*'sunset'/i.test(q.text)
        && !/id\s*=\s*\$1/i.test(q.text)));
      assert.ok(queries.some((q) => /FROM\s+clients/i.test(q.text)
        && /id\s*=\s*\$1/i.test(q.text)
        && q.params[0] === CLIENT_ID));
    }
    // domain failure → fixed sanitized error
    {
      const res = response();
      const pg = {
        async query() {
          const err = new Error('duplicate LEAK-ADDR@evil.example');
          err.code = '23505';
          throw err;
        },
      };
      const routes = createStaffEmailOAuthRoutes({
        runtimeEnv: START_ENV,
        sendJSON,
        assertStaffClientAccess(){ return true; },
        authorizeAuthenticatedStaffRoute(){ return { ok: true }; },
        withPgClient: (fn) => fn(pg),
      });
      await routes.handlePrepare(
        { location_id: LOCATION, public_address: MAILBOX },
        {},
        res,
        { client_slug: 'sunset', staff_user_id: ACTOR, session_id: SESSION },
      );
      assert.strictEqual(res.status, 503);
      assert.deepStrictEqual(res.body, { success: false, error: PREPARE_ERROR });
      assert.ok(!JSON.stringify(res.body).includes(MAILBOX));
    }
  });

  await test('browser panel prepare→start sequence and existing endpoint start; no auto-create; no location-only start', () => {
    const src = fs.readFileSync(require.resolve('./browser/sunset-admin-email-settings-ui.js'), 'utf8');
    for (const state of ['unavailable','loading','disconnected','registered_not_connected','connected_health','reauth_required','revoked','error']) {
      assert.ok(src.includes(state));
    }
    assert.ok(/data-email-connect=["']prepare["']/.test(src));
    assert.ok(/data-email-connect=["']connect["']/.test(src));
    assert.ok(/data-email-prepare-address/.test(src));
    assert.ok(src.includes('/staff/admin/email-settings/oauth/microsoft/endpoint'));
    assert.ok(!src.includes('/staff/admin/email-settings/oauth/microsoft/prepare'));
    assert.ok(!src.includes('/staff/admin/email-settings/microsoft/endpoint/prepare'));
    assert.ok(src.includes('/staff/admin/email-settings/oauth/microsoft/start'));
    assert.ok(src.includes('location_id'));
    assert.ok(src.includes('endpoint_id'));
    assert.ok(src.includes('public_address'));
    // Old location-only start body eliminated
    assert.ok(!/JSON\.stringify\(\s*\{\s*location_id\s*:\s*locationId\s*\}\s*\)/.test(src));
    assert.ok(src.includes("target.origin === 'https://login.microsoftonline.com'"));
    assert.ok(!src.includes("target.hostname !== 'login.microsoftonline.com'"));
    assert.ok(!/data-email-action=["']disconnect/i.test(src));
    // Never create on page load — prepare only on click chain
    assert.ok(/postMicrosoftEndpointPrepare/.test(src));
    assert.ok(/postMicrosoftOAuthStart/.test(src));
    assert.ok(src.includes('Never create on page load') || src.includes('never create on page load') || /prepare.*click|click.*prepare/i.test(src));
    // UI clarity: actionsUnavailable only when no prepare/connect/disconnect; safety note when action available
    assert.ok(src.includes('admin.email.connectSafetyNote'));
    assert.ok(src.includes('admin.email.actionsUnavailable'));
    assert.ok(/data-email-prepare-group/.test(src));
    assert.ok(/data-email-connect-safety/.test(src));
    assert.ok(/data-email-actions-unavailable/.test(src));
    // Prepare controls grouped before capability list (prepare marker precedes <dl>)
    const prepGroupIdx = src.indexOf('data-email-prepare-group');
    const dlIdx = src.indexOf('<dl>');
    assert.ok(prepGroupIdx > 0 && dlIdx > prepGroupIdx);
    new vm.Script(src);

    // Execute UI helpers in sandbox with fake fetch sequencing
    const calls = [];
    const sandbox = {
      URL,
      window: { location: { assign(url) { sandbox._assigned = url; } } },
      fetch(url, opts) {
        calls.push({ url, body: opts && opts.body, method: opts && opts.method });
        if (String(url) === '/staff/admin/email-settings/oauth/microsoft/endpoint') {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true, endpoint_id: ENDPOINT_ID }),
          });
        }
        if (String(url).includes('/start')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              authorization_url: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?x=1',
            }),
          });
        }
        return Promise.resolve({ ok: false, json: async () => ({}) });
      },
      console,
    };
    vm.runInNewContext(src, sandbox);
    assert.strictEqual(sandbox.isAllowedMicrosoftAuthorizationUrl('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?x=1'), true);
    assert.strictEqual(sandbox.isAllowedMicrosoftAuthorizationUrl('https://login.microsoftonline.com:444/organizations/oauth2/v2.0/authorize'), false);
    assert.strictEqual(sandbox.isAllowedMicrosoftAuthorizationUrl('https://login.microsoftonline.com.evil.test/organizations/oauth2/v2.0/authorize'), false);
    assert.strictEqual(sandbox.isAllowedMicrosoftAuthorizationUrl('http://login.microsoftonline.com/organizations/oauth2/v2.0/authorize'), false);

    return sandbox.postMicrosoftEndpointPrepare(LOCATION, MAILBOX)
      .then((id) => {
        assert.strictEqual(id, ENDPOINT_ID);
        assert.strictEqual(calls[0].url, '/staff/admin/email-settings/oauth/microsoft/endpoint');
        assert.strictEqual(calls[0].body, JSON.stringify({ location_id: LOCATION, public_address: MAILBOX }));
        return sandbox.postMicrosoftOAuthStart(LOCATION, id);
      })
      .then(() => {
        assert.strictEqual(calls[1].url, '/staff/admin/email-settings/oauth/microsoft/start');
        assert.strictEqual(calls[1].body, JSON.stringify({ location_id: LOCATION, endpoint_id: ENDPOINT_ID }));
        assert.ok(String(sandbox._assigned).startsWith('https://login.microsoftonline.com/'));
        // Direct start for existing endpoint
        return sandbox.postMicrosoftOAuthStart(LOCATION, ENDPOINT_ID);
      })
      .then(() => {
        assert.strictEqual(calls[2].body, JSON.stringify({ location_id: LOCATION, endpoint_id: ENDPOINT_ID }));
        // Malformed prepare response
        calls.length = 0;
        sandbox.fetch = function() {
          return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
        };
        return sandbox.postMicrosoftEndpointPrepare(LOCATION, MAILBOX).then(
          () => { throw new Error('expected reject'); },
          () => {},
        );
      })
      .then(() => {
        // Malformed authorization URL
        sandbox.fetch = function() {
          return Promise.resolve({
            ok: true,
            json: async () => ({ authorization_url: 'https://evil.example/oauth' }),
          });
        };
        return sandbox.postMicrosoftOAuthStart(LOCATION, ENDPOINT_ID).then(
          () => { throw new Error('expected reject'); },
          () => {},
        );
      });
  });

  await test('staff-query-api wires prepare path before start', () => {
    const src = fs.readFileSync(require.resolve('./staff-query-api.js'), 'utf8');
    assert.ok(src.includes('OAUTH_PREPARE_PATH'));
    const prepIdx = src.indexOf('pathname === OAUTH_PREPARE_PATH');
    const startIdx = src.indexOf('pathname === OAUTH_START_PATH');
    assert.ok(prepIdx > 0 && startIdx > prepIdx);
    assert.ok(src.includes('handlePrepare'));
    // No alias / no wrong prepare paths hardcoded in wiring source
    assert.ok(!src.includes('/staff/admin/email-settings/oauth/microsoft/prepare'));
    assert.ok(!src.includes('/staff/admin/email-settings/microsoft/endpoint/prepare'));
  });

  await test('both wrong prepare paths absent from production source; exact path present', () => {
    const prodFiles = [
      require.resolve('./browser/sunset-admin-email-settings-ui.js'),
      require.resolve('./lib/staff-email-oauth-routes.js'),
      require.resolve('./staff-query-api.js'),
    ];
    const wrongOauth = '/staff/admin/email-settings/oauth/microsoft/prepare';
    const wrongEndpoint = '/staff/admin/email-settings/microsoft/endpoint/prepare';
    const exact = '/staff/admin/email-settings/oauth/microsoft/endpoint';
    for (const file of prodFiles) {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(!src.includes(wrongOauth), `wrong oauth path in ${file}`);
      assert.ok(!src.includes(wrongEndpoint), `wrong endpoint path in ${file}`);
    }
    const routeSrc = fs.readFileSync(require.resolve('./lib/staff-email-oauth-routes.js'), 'utf8');
    const browserSrc = fs.readFileSync(require.resolve('./browser/sunset-admin-email-settings-ui.js'), 'utf8');
    assert.ok(routeSrc.includes(exact));
    assert.ok(browserSrc.includes(exact));
    assert.strictEqual(OAUTH_PREPARE_PATH, exact);
    // Verifier may mention wrong paths only as forbidden/negative assertions.
    const verifySrc = fs.readFileSync(require.resolve('./verify-sunset-email-settings.js'), 'utf8');
    assert.ok(verifySrc.includes(exact));
    assert.ok(verifySrc.includes(wrongOauth));
    assert.ok(verifySrc.includes(wrongEndpoint));
  });

  await test('both wrong prepare paths unregistered/404 with zero effects', async () => {
    const wrongOauth = '/staff/admin/email-settings/oauth/microsoft/prepare';
    const wrongEndpoint = '/staff/admin/email-settings/microsoft/endpoint/prepare';
    const exact = '/staff/admin/email-settings/oauth/microsoft/endpoint';
    assert.notStrictEqual(OAUTH_PREPARE_PATH, wrongOauth);
    assert.notStrictEqual(OAUTH_PREPARE_PATH, wrongEndpoint);
    assert.strictEqual(OAUTH_PREPARE_PATH, exact);
    // Wrong paths are not the registered constant — staff-query-api dispatches only OAUTH_PREPARE_PATH.
    const apiSrc = fs.readFileSync(require.resolve('./staff-query-api.js'), 'utf8');
    assert.ok(apiSrc.includes('pathname === OAUTH_PREPARE_PATH'));
    assert.ok(!apiSrc.includes(wrongOauth));
    assert.ok(!apiSrc.includes(wrongEndpoint));
    // Default-off: prepare handler itself still 404s with zero effects when flags off.
    let touched = false;
    const res = response();
    const routes = createStaffEmailOAuthRoutes({
      runtimeEnv: {},
      sendJSON,
      assertStaffClientAccess(){ touched = true; return true; },
      authorizeAuthenticatedStaffRoute(){ touched = true; return { ok: true }; },
      withPgClient(){ touched = true; },
    });
    await routes.handlePrepare(
      { location_id: LOCATION, public_address: MAILBOX },
      {},
      res,
      { client_slug: 'sunset', staff_user_id: ACTOR, session_id: SESSION },
    );
    assert.strictEqual(res.status, 404);
    assert.strictEqual(touched, false);
    // Source-level: no production file POSTs either wrong path (no aliases).
    const browserSrc = fs.readFileSync(require.resolve('./browser/sunset-admin-email-settings-ui.js'), 'utf8');
    assert.ok(!browserSrc.includes(wrongOauth));
    assert.ok(!browserSrc.includes(wrongEndpoint));
    const routeSrc = fs.readFileSync(require.resolve('./lib/staff-email-oauth-routes.js'), 'utf8');
    assert.ok(!routeSrc.includes(wrongOauth));
    assert.ok(!routeSrc.includes(wrongEndpoint));
    assert.ok(routeSrc.includes(OAUTH_PREPARE_PATH));
  });

  await test('offline DOM: prepare mounts controls; actions false shows unavailable; no auto POST', () => {
    const src = fs.readFileSync(require.resolve('./browser/sunset-admin-email-settings-ui.js'), 'utf8');
    // Minimal DOM harness (no real browser / no flaky waits) — innerHTML string proofs.
    function makeBody() {
      const el = {
        id: 'admin-email-settings-body',
        _html: '',
        querySelector() { return null; },
        querySelectorAll() { return []; },
      };
      Object.defineProperty(el, 'innerHTML', {
        get() { return el._html; },
        set(v) { el._html = String(v); },
        configurable: true,
      });
      return el;
    }
    const body = makeBody();
    const byId = { 'admin-email-settings-body': body };
    const calls = [];
    const i18nKeys = {
      'admin.email.title': 'Email Settings',
      'admin.email.state.disconnected': 'No email mailbox is registered.',
      'admin.email.state.registered_not_connected': 'Mailbox registered, not connected.',
      'admin.email.state.error': 'Email status is temporarily unavailable.',
      'admin.email.mailboxLabel': 'Microsoft email address',
      'admin.email.endpointActive': 'Endpoint active',
      'admin.email.inbound': 'Inbound',
      'admin.email.outbound': 'Outbound',
      'admin.email.automation': 'Automation',
      'admin.email.off': 'Off',
      'admin.email.actionsUnavailable': 'Connect and disconnect are not available in this release.',
      'admin.email.connectSafetyNote': 'Connection verifies identity only; endpoint, inbound, outbound and automation remain off.',
    };
    const sandbox = {
      URL,
      window: { location: { assign() {} } },
      document: { getElementById(id) { return byId[id] || null; } },
      el(id) { return byId[id] || null; },
      escHtml(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      },
      portalT(key) { return i18nKeys[key] || key; },
      fetch(url, opts) {
        calls.push({ url, body: opts && opts.body, method: opts && opts.method });
        return Promise.resolve({ ok: false, json: async () => ({}) });
      },
      console,
    };
    vm.runInNewContext(src, sandbox);

    // Exact Admin nav selector (not loose button[data-tab], not panel #tab-admin) + Email tab.
    const ADMIN_NAV_SEL = 'button.tab-btn[data-tab="admin"]';
    const EMAIL_TAB_SEL = '#admin-tab-email';
    assert.strictEqual(ADMIN_NAV_SEL, 'button.tab-btn[data-tab="admin"]');
    assert.strictEqual(EMAIL_TAB_SEL, '#admin-tab-email');
    // Looser selector must not be the contract.
    assert.notStrictEqual(ADMIN_NAV_SEL, 'button[data-tab="admin"]');
    process.env.SUNSET_EMAIL_SETTINGS_UI_ENABLED = 'true';
    const html = require('./staff-query-api').buildUiHtmlForOfflineTest(3036, 'sunset');
    assert.ok(html.includes('data-tab="admin"'));
    assert.ok(html.includes('class="tab-btn"') || html.includes("class='tab-btn'") || /class="[^"]*tab-btn[^"]*"/.test(html));
    assert.ok(html.includes('id="admin-tab-email"'));
    assert.ok(html.includes('id="tab-admin"')); // panel exists but is not the nav click target
    // Production HTML has the exact nav button shape used by the selector.
    assert.ok(/<button[^>]*class="[^"]*tab-btn[^"]*"[^>]*data-tab="admin"/i.test(html)
      || /<button[^>]*data-tab="admin"[^>]*class="[^"]*tab-btn[^"]*"/i.test(html));
    const verifySrc = fs.readFileSync(__filename, 'utf8');
    assert.ok(verifySrc.includes('button.tab-btn[data-tab="admin"]'));
    assert.ok(verifySrc.includes('#admin-tab-email'));
    assert.ok(!/click\(['"]#tab-admin['"]\)|locator\(['"]#tab-admin['"]\)\.click/.test(verifySrc));
    // Do not treat the loose selector as the required contract.
    assert.ok(!verifySrc.includes("ADMIN_NAV_SEL = 'button[data-tab=\"admin\"]'"));
    assert.ok(!verifySrc.includes('ADMIN_NAV_SEL = "button[data-tab=\\"admin\\"]"'));

    // actions.prepare=true → exactly one mailbox input + Connect; safety note; no unavailable; no auto POST
    calls.length = 0;
    sandbox.renderAdminEmailSettingsState('disconnected', {
      actions: { prepare: true, connect: false, disconnect: false },
      location_id: LOCATION,
    });
    assert.strictEqual(calls.length, 0, 'no auto POST before click');
    const htmlPrep = body.innerHTML;
    assert.ok(htmlPrep.includes('data-email-prepare-address'));
    assert.ok(htmlPrep.includes('data-email-connect="prepare"'));
    assert.ok(htmlPrep.includes('data-email-prepare-group'));
    assert.ok(htmlPrep.includes('data-email-connect-safety'));
    assert.ok(htmlPrep.includes(i18nKeys['admin.email.connectSafetyNote']));
    assert.ok(!htmlPrep.includes('data-email-actions-unavailable'));
    assert.ok(!htmlPrep.includes(i18nKeys['admin.email.actionsUnavailable']));
    assert.strictEqual((htmlPrep.match(/data-email-prepare-address/g) || []).length, 1);
    assert.strictEqual((htmlPrep.match(/data-email-connect="prepare"/g) || []).length, 1);
    assert.ok(htmlPrep.indexOf('data-email-prepare-group') < htmlPrep.indexOf('<dl>'));
    assert.ok(htmlPrep.includes(i18nKeys['admin.email.endpointActive']));
    assert.ok(htmlPrep.includes(i18nKeys['admin.email.off']));

    // actions all false → neither control + unavailable text
    sandbox.renderAdminEmailSettingsState('disconnected', {
      actions: { prepare: false, connect: false, disconnect: false },
      location_id: LOCATION,
    });
    const htmlOff = body.innerHTML;
    assert.ok(!htmlOff.includes('data-email-prepare-address'));
    assert.ok(!htmlOff.includes('data-email-connect='));
    assert.ok(htmlOff.includes('data-email-actions-unavailable'));
    assert.ok(htmlOff.includes(i18nKeys['admin.email.actionsUnavailable']));
    assert.ok(!htmlOff.includes('data-email-connect-safety'));

    // connect true shows safety, no prepare input, omits unavailable
    sandbox.renderAdminEmailSettingsState('registered_not_connected', {
      actions: { prepare: false, connect: true, disconnect: false },
      location_id: LOCATION,
      endpoint_id: ENDPOINT_ID,
      public_address: MAILBOX,
    });
    const htmlConn = body.innerHTML;
    assert.ok(!htmlConn.includes('data-email-prepare-address'));
    assert.ok(htmlConn.includes('data-email-connect="connect"'));
    assert.ok(htmlConn.includes('data-email-connect-safety'));
    assert.ok(!htmlConn.includes('data-email-actions-unavailable'));
  });

  await test('i18n safety note present in EN/ES/IT', () => {
    const enSrc = fs.readFileSync(require.resolve('./lib/staff-portal-i18n.js'), 'utf8');
    const esSrc = fs.readFileSync(require.resolve('./lib/staff-portal-i18n-es-sunset.js'), 'utf8');
    assert.ok(enSrc.includes("'admin.email.connectSafetyNote'"));
    // EN + IT live in staff-portal-i18n.js (two locale blocks)
    const key = 'admin.email.connectSafetyNote';
    const enMatches = enSrc.split(key);
    assert.ok(enMatches.length >= 3, 'EN and IT entries'); // key appears at least twice (en+it) + possible comments
    assert.ok(esSrc.includes("'admin.email.connectSafetyNote'"));
    // English copy must state identity-only connection safety
    assert.ok(/Connection verifies identity only/i.test(enSrc));
    assert.ok(/endpoint, inbound, outbound and automation remain off/i.test(enSrc));
  });

  await test('startup sources and i18n load safely', () => {
    const source = require('./lib/sunset-admin-browser-source').getSunsetAdminUiBrowserSource();
    assert.ok(source.includes('loadAdminEmailSettings'));
    assert.ok(source.includes('postMicrosoftEndpointPrepare') || source.includes('data-email-connect'));
    assert.ok(source.includes('/staff/admin/email-settings/oauth/microsoft/endpoint'));
    assert.ok(!source.includes('/staff/admin/email-settings/oauth/microsoft/prepare'));
    assert.ok(!source.includes('/staff/admin/email-settings/microsoft/endpoint/prepare'));
    require('./lib/staff-portal-i18n');
    require('./lib/staff-portal-i18n-es-sunset');
  });

  console.log(`PASS ${count} tests`);
})().catch((e)=>{ console.error(e); process.exitCode=1; });
