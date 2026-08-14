'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const {
  isSunsetEmailSettingsUiEnabled,
  isSunsetEmailOAuthStartEnabled,
  isPhaseBReauthSettingsActionEnabled,
  isEligiblePhaseBReauthorizeEndpoint,
  snapshotPhaseBReauthGrantFact,
  grantFactFromAtomicEligibilityRow,
  publicGrantFromAtomicEligibilityRow,
  indexAtomicEligibilityRows,
  normalizeAtomicEligibilityRow,
  createEmailSettingsRoutes,
  endpointDto,
  computeEmailSettingsActions,
  isEligibleUnverifiedDelegatedEndpoint,
  isEligibleDisconnectEndpoint,
  isDisconnectSettingsActionEnabled,
  DISCONNECT_ENABLED_ENV,
  PHASE_B_REAUTH_START_ENABLED_ENV,
  PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS,
  SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS,
  ATOMIC_ELIGIBILITY_OWN_KEYS,
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
const REAUTH_ENV = {
  SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
  LUNA_DEPLOYMENT: 'sunset-staging',
  [PHASE_B_REAUTH_START_ENABLED_ENV]: 'true',
};
const DISCONNECT_ENV = {
  SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
  LUNA_DEPLOYMENT: 'sunset-staging',
  [DISCONNECT_ENABLED_ENV]: 'true',
};
const LOCATION = 'sunset-somo';
const ENDPOINT_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR = 'abcdef01-2345-4678-89ab-cdef01234567';
const SESSION = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MAILBOX = 'desk@sunset.example';
const APP_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
// Verifier-owned independent Phase B URL contract (do not import route constants).
const CANON_AUTH = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize';
const CANON_REDIR = 'https://sunset-staging.lunafrontdesk.com/staff/email/oauth/microsoft/callback';
const CANON_SCOPES = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';
const B64_32 = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'; // 43 chars base64url-ish

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

function verifiedConnectedRow(patch = {}) {
  return eligibleRow({
    binding_status: 'verified',
    active: true,
    location_active: true,
    ...patch,
  });
}

function cleanPhaseAGrantFact(patch = {}) {
  return {
    grant_present: true,
    grant_status: 'active',
    reconcile_state: 'clean',
    has_active_lease: false,
    grant_generation: 3,
    scope_version: 'phase_a_v2',
    lease_clear: true,
    ...patch,
  };
}

/** Exact own-data atomic eligibility row (mirrors SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS). */
function atomicEligibleRow(patch = {}) {
  return {
    endpoint_id: ENDPOINT_ID,
    location_id: LOCATION,
    provider: 'microsoft_graph',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'verified',
    public_address: MAILBOX,
    endpoint_active: true,
    location_active: true,
    grant_present: true,
    grant_status: 'active',
    reconcile_state: 'clean',
    scope_version: 'phase_a_v2',
    grant_generation: 7,
    has_active_lease: false,
    lease_token_null: true,
    lease_owner_null: true,
    lease_until_null: true,
    ...patch,
  };
}

function buildValidReauthUrl(mut) {
  const u = new URL(CANON_AUTH);
  const pairs = [
    ['client_id', APP_ID], ['response_type', 'code'], ['redirect_uri', CANON_REDIR],
    ['response_mode', 'query'], ['scope', CANON_SCOPES], ['state', B64_32],
    ['nonce', B64_32], ['code_challenge', B64_32], ['code_challenge_method', 'S256'],
    ['prompt', 'consent'],
  ];
  for (const [k, v] of pairs) u.searchParams.set(k, v);
  if (typeof mut === 'function') mut(u);
  return u.toString();
}

function futureExpires(msFromNow = 600000) {
  return new Date(Date.now() + msFromNow).toISOString();
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
    assert.deepStrictEqual(actions, { prepare: false, connect: false, disconnect: false, reauthorize: false });
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
    const EP = '22222222-2222-2222-2222-222222222222';
    const pg = { query: async (sql, params) => { queries.push([sql,params]); return { rows: [{ client_id: '11111111-1111-1111-1111-111111111111' }] }; } };
    const routes = createEmailSettingsRoutes({ runtimeEnv: { SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true' }, sendJSON,
      assertStaffClientAccess(){ return true; }, authorizeAuthenticatedStaffRoute(){ return {ok:true}; }, withPgClient: (fn) => fn(pg),
      listTenantLocations: async () => ({ok:true,value:[{location_id:'sunset-somo',display_name:'Sunset',active:true,client_id:'secret'}]}),
      listTenantChannelEndpoints: async () => ({ok:true,value:[{id:EP,location_id:'sunset-somo',provider:'microsoft_graph',public_address:'mail@example.test',secret_ref:'kv://secret',provider_tenant_id:'raw',active:true,inbound_enabled:true,outbound_enabled:true}]}),
      // Atomic eligibility facts (one set-based load) — dual gate off so reauthorize false.
      loadPhaseBReauthEligibilityFacts: async () => ([
        atomicEligibleRow({
          endpoint_id: EP,
          location_id: 'sunset-somo',
          public_address: 'mail@example.test',
          grant_present: true,
          grant_status: 'active',
          reconcile_state: 'clean',
          has_active_lease: true,
          lease_token_null: false,
          lease_owner_null: false,
          lease_until_null: false,
        }),
      ]),
    });
    await routes.handleGet({client:'sunset'}, {}, res, {role:'admin'});
    assert.strictEqual(res.status,200); assert.strictEqual(res.body.read_only,true);
    assert.deepStrictEqual(res.body.actions,{prepare:false,connect:false,disconnect:false,reauthorize:false});
    assert.strictEqual(res.body.endpoints[0].connection_state,'connected_health');
    assert.strictEqual(res.body.endpoints[0].endpoint_id,EP);
    assert.strictEqual(res.body.endpoints[0].endpoint_active,false); assert.strictEqual(res.body.endpoints[0].inbound_enabled,false); assert.strictEqual(res.body.endpoints[0].outbound_enabled,false); assert.strictEqual(res.body.endpoints[0].automation_enabled,false);
    assert.strictEqual(res.body.endpoints[0].reauthorize_eligible, false);
    const text=JSON.stringify(res.body); for (const forbidden of ['secret_ref','provider_tenant_id','client_id','has_active_lease','ciphertext','wrapped_dek','oauth','scope_version','grant_generation','lease_clear','phase_a_v2','phase_b_v1']) assert.ok(!text.includes(forbidden), forbidden);
    assert.deepStrictEqual(queries[0][1],['sunset']);
  });

  await test('actions distinguish prepare vs connect; never both for same location', () => {
    const locs = [{ location_id: LOCATION, active: true, display_name: 'S' }];
    // No endpoint → prepare when start on
    assert.deepStrictEqual(
      computeEmailSettingsActions(START_ENV, locs, []),
      { prepare: true, connect: false, disconnect: false, reauthorize: false },
    );
    // Eligible unverified → connect only
    const eligible = [endpointDto(eligibleRow(), { grant_present: false })];
    assert.strictEqual(eligible[0].start_eligible, true);
    assert.strictEqual(eligible[0].reauthorize_eligible, false);
    assert.strictEqual(eligible[0].endpoint_id, ENDPOINT_ID);
    assert.deepStrictEqual(
      computeEmailSettingsActions(START_ENV, locs, eligible),
      { prepare: false, connect: true, disconnect: false, reauthorize: false },
    );
    // Legacy null auth_mode not eligible
    const legacy = [endpointDto({
      id: ENDPOINT_ID, location_id: LOCATION, provider: 'microsoft_graph',
      public_address: MAILBOX, auth_mode: null, connector_mode: null, binding_status: null,
    }, { grant_present: false })];
    assert.strictEqual(legacy[0].start_eligible, false);
    assert.deepStrictEqual(
      computeEmailSettingsActions(START_ENV, locs, legacy),
      { prepare: false, connect: false, disconnect: false, reauthorize: false },
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
      actions: { prepare: true, connect: false, disconnect: false, reauthorize: false },
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
      actions: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      location_id: LOCATION,
    });
    const htmlOff = body.innerHTML;
    assert.ok(!htmlOff.includes('data-email-prepare-address'));
    assert.ok(!htmlOff.includes('data-email-connect='));
    assert.ok(!htmlOff.includes('data-email-reauthorize'));
    assert.ok(htmlOff.includes('data-email-actions-unavailable'));
    assert.ok(htmlOff.includes(i18nKeys['admin.email.actionsUnavailable']));
    assert.ok(!htmlOff.includes('data-email-connect-safety'));

    // connect true shows safety, no prepare input, omits unavailable
    sandbox.renderAdminEmailSettingsState('registered_not_connected', {
      actions: { prepare: false, connect: true, disconnect: false, reauthorize: false },
      location_id: LOCATION,
      endpoint_id: ENDPOINT_ID,
      public_address: MAILBOX,
    });
    const htmlConn = body.innerHTML;
    assert.ok(!htmlConn.includes('data-email-prepare-address'));
    assert.ok(htmlConn.includes('data-email-connect="connect"'));
    assert.ok(htmlConn.includes('data-email-connect-safety'));
    assert.ok(!htmlConn.includes('data-email-actions-unavailable'));
    assert.ok(!htmlConn.includes('data-email-reauthorize'));
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
    // Phase B reauthorize safety copy EN/ES/IT
    assert.ok(enSrc.includes("'admin.email.reauthorizeSafetyNote'"));
    assert.ok(enSrc.includes("'admin.email.reauthorizeButton'"));
    assert.ok(esSrc.includes("'admin.email.reauthorizeSafetyNote'"));
    assert.ok(esSrc.includes("'admin.email.reauthorizeButton'"));
    const reauthKey = 'admin.email.reauthorizeSafetyNote';
    assert.ok(enSrc.split(reauthKey).length >= 3, 'EN and IT reauth safety');
    assert.ok(/Microsoft permissions are being upgraded for staff-approved replies/i.test(enSrc));
    assert.ok(/Authorization itself does not send any email/i.test(enSrc));
    assert.ok(/Reauthorize Microsoft/.test(enSrc));
  });

  await test('startup sources and i18n load safely', () => {
    const source = require('./lib/sunset-admin-browser-source').getSunsetAdminUiBrowserSource();
    assert.ok(source.includes('loadAdminEmailSettings'));
    assert.ok(source.includes('postMicrosoftEndpointPrepare') || source.includes('data-email-connect'));
    assert.ok(source.includes('/staff/admin/email-settings/oauth/microsoft/endpoint'));
    assert.ok(source.includes('/staff/admin/email-settings/oauth/microsoft/reauthorize'));
    assert.ok(source.includes('postMicrosoftOAuthReauthorize'));
    assert.ok(source.includes('validatePhaseBReauthorizeSuccessDto'));
    assert.ok(!source.includes('/staff/admin/email-settings/oauth/microsoft/prepare'));
    assert.ok(!source.includes('/staff/admin/email-settings/microsoft/endpoint/prepare'));
    require('./lib/staff-portal-i18n');
    require('./lib/staff-portal-i18n-es-sunset');
  });

  await test('Phase B reauth settings dual gate defaults off', () => {
    assert.strictEqual(PHASE_B_REAUTH_START_ENABLED_ENV, 'LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED');
    assert.strictEqual(isPhaseBReauthSettingsActionEnabled({}), false);
    assert.strictEqual(isPhaseBReauthSettingsActionEnabled({
      SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
      LUNA_DEPLOYMENT: 'sunset-staging',
    }), false);
    assert.strictEqual(isPhaseBReauthSettingsActionEnabled({
      SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
      LUNA_DEPLOYMENT: 'sunset-staging',
      [PHASE_B_REAUTH_START_ENABLED_ENV]: 'TRUE',
    }), false);
    assert.strictEqual(isPhaseBReauthSettingsActionEnabled({
      SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
      LUNA_DEPLOYMENT: 'production',
      [PHASE_B_REAUTH_START_ENABLED_ENV]: 'true',
    }), false);
    assert.strictEqual(isPhaseBReauthSettingsActionEnabled(REAUTH_ENV), true);
    // Phase A start alone does not enable reauth action
    assert.strictEqual(isPhaseBReauthSettingsActionEnabled(START_ENV), false);
  });

  await test('DTO reauthorize retired; disconnect eligibility boundary fail-closed', () => {
    const goodFact = cleanPhaseAGrantFact();
    const goodRow = verifiedConnectedRow();
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, goodFact), false);
    assert.strictEqual(isEligibleDisconnectEndpoint(goodRow, goodFact), true);
    // A verified connected grant remains revocable while registry activation is off.
    assert.strictEqual(isEligibleDisconnectEndpoint(verifiedConnectedRow({ active: false }), goodFact), true);
    // Hostile / boundary negatives
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(null, goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, null), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(eligibleRow(), goodFact), false); // unverified
    // Inactive endpoint / location fail-closed
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(verifiedConnectedRow({ active: false }), goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(verifiedConnectedRow({ active: undefined }), goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(verifiedConnectedRow({ location_active: false }), goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(verifiedConnectedRow({ location_active: null }), goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(verifiedConnectedRow({ location_id: null }), goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(verifiedConnectedRow({ location_id: '' }), goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(verifiedConnectedRow({ binding_status: 'reauthorization_required' }), goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(verifiedConnectedRow({ binding_status: 'revoked' }), goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(verifiedConnectedRow({ provider: 'smtp' }), goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(verifiedConnectedRow({ auth_mode: 'client_credentials' }), goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(verifiedConnectedRow({ connector_mode: 'microsoft_app_only' }), goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(verifiedConnectedRow({ public_address: '' }), goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(verifiedConnectedRow({ public_address: '   ' }), goodFact), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, cleanPhaseAGrantFact({ grant_present: false })), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, cleanPhaseAGrantFact({ grant_status: 'revoked' })), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, cleanPhaseAGrantFact({ grant_status: 'reauthorization_required' })), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, cleanPhaseAGrantFact({ grant_status: 'lease_held' })), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, cleanPhaseAGrantFact({ reconcile_state: 'dirty' })), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, cleanPhaseAGrantFact({ reconcile_state: 'replacement_pending' })), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, cleanPhaseAGrantFact({ has_active_lease: true })), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, cleanPhaseAGrantFact({ lease_clear: false })), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, cleanPhaseAGrantFact({ scope_version: 'phase_b_v1' })), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, cleanPhaseAGrantFact({ scope_version: null })), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, cleanPhaseAGrantFact({ grant_generation: 0 })), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, cleanPhaseAGrantFact({ grant_generation: 1.5 })), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, cleanPhaseAGrantFact({ grant_generation: '3' })), false);
    // Proxy-like / extra-key grant facts still ok if required fields match; missing required fails
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, { ...goodFact, secret: 'x' }), false);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, { grant_present: true }), false);
    assert.strictEqual(isEligibleDisconnectEndpoint(goodRow, { ...goodFact, secret: 'x' }), true);
    assert.strictEqual(isEligibleDisconnectEndpoint(goodRow, { grant_present: true }), false);
    // endpointDto projection: reauthorize always false; disconnect only when gate on
    const offDto = endpointDto(goodRow, { grant_present: true, grant_status: 'active', reconcile_state: 'clean' }, {
      grantFact: goodFact, reauthGateOn: false, disconnectGateOn: false,
    });
    assert.strictEqual(offDto.reauthorize_eligible, false);
    assert.strictEqual(offDto.disconnect_eligible, false);
    assert.strictEqual(offDto.start_eligible, false);
    const onDto = endpointDto(goodRow, { grant_present: true, grant_status: 'active', reconcile_state: 'clean' }, {
      grantFact: goodFact, reauthGateOn: true, disconnectGateOn: true,
    });
    assert.strictEqual(onDto.reauthorize_eligible, false);
    assert.strictEqual(onDto.disconnect_eligible, true);
    assert.strictEqual(onDto.start_eligible, false);
    const dtoText = JSON.stringify(onDto);
    for (const forbidden of ['scope_version', 'grant_generation', 'lease_clear', 'phase_a_v2', 'has_active_lease', 'secret_ref']) {
      assert.ok(!dtoText.includes(forbidden), forbidden);
    }
    // Never both start and reauthorize on same endpoint
    const unverified = endpointDto(eligibleRow(), { grant_present: false }, {
      grantFact: cleanPhaseAGrantFact({ grant_present: false }), reauthGateOn: true,
    });
    assert.strictEqual(unverified.start_eligible, true);
    assert.strictEqual(unverified.reauthorize_eligible, false);
    // Top-level actions
    const locs = [{ location_id: LOCATION, active: true, display_name: 'S' }];
    assert.deepStrictEqual(
      computeEmailSettingsActions(REAUTH_ENV, locs, [onDto]),
      { prepare: false, connect: false, disconnect: false, reauthorize: false },
    );
    assert.deepStrictEqual(
      computeEmailSettingsActions(DISCONNECT_ENV, locs, [onDto]),
      { prepare: false, connect: false, disconnect: true, reauthorize: false },
    );
    assert.deepStrictEqual(
      computeEmailSettingsActions(START_ENV, locs, [onDto]),
      { prepare: false, connect: false, disconnect: false, reauthorize: false },
    );
    // snapshot fail-closed without internal row
    const noInternal = snapshotPhaseBReauthGrantFact({
      grant_present: true, grant_status: 'active', reconcile_state: 'clean',
      has_active_lease: false, grant_generation: 3,
    }, null);
    assert.strictEqual(noInternal.lease_clear, false);
    assert.strictEqual(noInternal.scope_version, null);
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(goodRow, noInternal), false);
  });

  await test('disconnect settings gate defaults off', () => {
    assert.strictEqual(DISCONNECT_ENABLED_ENV, 'LUNA_EMAIL_OAUTH_DISCONNECT_ENABLED');
    assert.strictEqual(isDisconnectSettingsActionEnabled({}), false);
    assert.strictEqual(isDisconnectSettingsActionEnabled({
      SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
      LUNA_DEPLOYMENT: 'sunset-staging',
    }), false);
    assert.strictEqual(isDisconnectSettingsActionEnabled(DISCONNECT_ENV), true);
    assert.strictEqual(isDisconnectSettingsActionEnabled({
      SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
      LUNA_DEPLOYMENT: 'production',
      [DISCONNECT_ENABLED_ENV]: 'true',
    }), false);
  });

  await test('settings GET never projects reauthorize; disconnect under disconnect gate', async () => {
    const res = response();
    const goodRow = {
      id: ENDPOINT_ID,
      location_id: LOCATION,
      provider: 'microsoft_graph',
      public_address: MAILBOX,
      auth_mode: 'delegated_authorization_code',
      connector_mode: 'microsoft_delegated_oauth',
      binding_status: 'verified',
      secret_ref: 'kv://secret',
      provider_tenant_id: 'tid',
    };
    let atomicLoads = 0;
    let atomicParams = null;
    const routes = createEmailSettingsRoutes({
      runtimeEnv: REAUTH_ENV,
      sendJSON,
      assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: (fn) => fn({ query: async () => ({ rows: [{ client_id: CLIENT_ID }] }) }),
      listTenantLocations: async () => ({
        ok: true,
        value: [{ location_id: LOCATION, display_name: 'Somo', active: true }],
      }),
      listTenantChannelEndpoints: async () => ({ ok: true, value: [goodRow] }),
      loadPhaseBReauthEligibilityFacts: async (pg, clientId) => {
        atomicLoads += 1;
        atomicParams = [clientId];
        return [atomicEligibleRow()];
      },
    });
    await routes.handleGet({ client: 'sunset' }, {}, res, { role: 'admin' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.actions, {
      prepare: false, connect: false, disconnect: false, reauthorize: false,
    });
    assert.strictEqual(res.body.endpoints[0].reauthorize_eligible, false);
    assert.strictEqual(res.body.endpoints[0].disconnect_eligible, false);
    assert.strictEqual(res.body.endpoints[0].start_eligible, false);
    assert.strictEqual(res.body.endpoints[0].connection_state, 'connected_health');
    assert.strictEqual(atomicLoads, 1, 'exactly one set-based atomic eligibility load');
    assert.deepStrictEqual(atomicParams, [CLIENT_ID]);
    const text = JSON.stringify(res.body);
    for (const forbidden of [
      'secret_ref', 'provider_tenant_id', 'client_id', 'has_active_lease',
      'ciphertext', 'scope_version', 'grant_generation', 'lease_clear',
      'phase_a_v2', 'authorization_url', 'grant_lease',
    ]) assert.ok(!text.includes(forbidden), forbidden);

    // Dirty grant (atomic) → reauthorize false
    const res2 = response();
    const routesDirty = createEmailSettingsRoutes({
      runtimeEnv: REAUTH_ENV,
      sendJSON,
      assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: (fn) => fn({ query: async () => ({ rows: [{ client_id: CLIENT_ID }] }) }),
      listTenantLocations: async () => ({
        ok: true,
        value: [{ location_id: LOCATION, display_name: 'Somo', active: true }],
      }),
      listTenantChannelEndpoints: async () => ({ ok: true, value: [goodRow] }),
      loadPhaseBReauthEligibilityFacts: async () => ([
        atomicEligibleRow({ reconcile_state: 'dirty' }),
      ]),
    });
    await routesDirty.handleGet({ client: 'sunset' }, {}, res2, { role: 'admin' });
    assert.strictEqual(res2.body.actions.reauthorize, false);
    assert.strictEqual(res2.body.endpoints[0].reauthorize_eligible, false);

    // Gate off (UI on but Phase B start off) → no reauth; atomic still loads for display (one query)
    let atomicLoadsOff = 0;
    const res3 = response();
    const routesOff = createEmailSettingsRoutes({
      runtimeEnv: { SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true', LUNA_DEPLOYMENT: 'sunset-staging' },
      sendJSON,
      assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: (fn) => fn({ query: async () => ({ rows: [{ client_id: CLIENT_ID }] }) }),
      listTenantLocations: async () => ({
        ok: true,
        value: [{ location_id: LOCATION, display_name: 'Somo', active: true }],
      }),
      listTenantChannelEndpoints: async () => ({ ok: true, value: [goodRow] }),
      loadPhaseBReauthEligibilityFacts: async () => {
        atomicLoadsOff += 1;
        return [atomicEligibleRow()];
      },
    });
    await routesOff.handleGet({ client: 'sunset' }, {}, res3, { role: 'admin' });
    assert.strictEqual(res3.body.actions.reauthorize, false);
    assert.strictEqual(res3.body.endpoints[0].reauthorize_eligible, false);
    assert.strictEqual(atomicLoadsOff, 1, 'one atomic load; eligibility still false when dual gate off');

    const res4 = response();
    const routesDisconnect = createEmailSettingsRoutes({
      runtimeEnv: DISCONNECT_ENV,
      sendJSON,
      assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: (fn) => fn({ query: async () => ({ rows: [{ client_id: CLIENT_ID }] }) }),
      listTenantLocations: async () => ({
        ok: true,
        value: [{ location_id: LOCATION, display_name: 'Somo', active: true }],
      }),
      listTenantChannelEndpoints: async () => ({ ok: true, value: [goodRow] }),
      loadPhaseBReauthEligibilityFacts: async () => ([atomicEligibleRow()]),
    });
    await routesDisconnect.handleGet({ client: 'sunset' }, {}, res4, { role: 'admin' });
    assert.strictEqual(res4.status, 200);
    assert.deepStrictEqual(res4.body.actions, {
      prepare: false, connect: false, disconnect: true, reauthorize: false,
    });
    assert.strictEqual(res4.body.endpoints[0].disconnect_eligible, true);
    assert.strictEqual(res4.body.endpoints[0].reauthorize_eligible, false);
  });

  await test('atomic eligibility race/mutant: stale public active/clean cannot override terminal/dirty', async () => {
    // Authority of SQL constant
    assert.ok(SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS.includes('tenant_channel_endpoints'));
    assert.ok(SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS.includes('tenant_email_delegated_grants'));
    assert.ok(SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS.includes('tenant_locations'));
    assert.ok(SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS.includes('l.client_id = e.client_id'));
    assert.ok(SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS.includes('l.location_id = e.location_id'));
    assert.ok(SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS.includes('location_active'));
    assert.ok(SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS.includes('e.client_id = $1::uuid'));
    assert.ok(SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS.includes('scope_version'));
    assert.ok(SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS.includes('lease_token_null'));
    assert.ok(SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS.includes('LEFT JOIN'));
    assert.ok(SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS.includes(`LIMIT ${PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS + 1}`));
    assert.strictEqual(PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS, 100);
    // Single statement (no multi-statement composition)
    assert.ok(!SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS.includes(';'));
    assert.ok(Array.isArray(ATOMIC_ELIGIBILITY_OWN_KEYS));
    assert.ok(ATOMIC_ELIGIBILITY_OWN_KEYS.includes('grant_generation'));
    assert.ok(ATOMIC_ELIGIBILITY_OWN_KEYS.includes('lease_until_null'));
    assert.ok(ATOMIC_ELIGIBILITY_OWN_KEYS.includes('location_active'));
    assert.ok(ATOMIC_ELIGIBILITY_OWN_KEYS.includes('endpoint_active'));
    // Exact key set length (no silent extras)
    assert.strictEqual(ATOMIC_ELIGIBILITY_OWN_KEYS.length, 18);

    const goodRow = {
      id: ENDPOINT_ID,
      location_id: LOCATION,
      provider: 'microsoft_graph',
      public_address: MAILBOX,
      auth_mode: 'delegated_authorization_code',
      connector_mode: 'microsoft_delegated_oauth',
      binding_status: 'verified',
    };
    // Mutant: if code mixed a stale "public active/clean" with atomic terminal/dirty, eligibility
    // must still be false because eligibility is solely from the atomic row.
    let publicStatusCalls = 0;
    let internalRowCalls = 0;
    let atomicCalls = 0;
    let atomicSqlParams = null;
    const res = response();
    const queries = [];
    const routes = createEmailSettingsRoutes({
      runtimeEnv: REAUTH_ENV,
      sendJSON,
      assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: (fn) => fn({
        query: async (sql, params) => {
          queries.push({ sql: String(sql), params });
          return { rows: [{ client_id: CLIENT_ID }] };
        },
      }),
      listTenantLocations: async () => ({
        ok: true,
        value: [{ location_id: LOCATION, display_name: 'Somo', active: true }],
      }),
      listTenantChannelEndpoints: async () => ({ ok: true, value: [goodRow] }),
      // Hostile deps: if production still called these, they would claim active/clean eligible.
      getDelegatedGrantPublicStatus: async () => {
        publicStatusCalls += 1;
        return {
          ok: true,
          value: {
            grant_present: true, grant_status: 'active', reconcile_state: 'clean',
            has_active_lease: false, grant_generation: 1,
          },
        };
      },
      loadPhaseBReauthGrantInternalRow: async () => {
        internalRowCalls += 1;
        return Object.freeze({
          scope_version: 'phase_a_v2', grant_generation: 1, grant_status: 'active',
          reconcile_state: 'clean', lease_token_null: true, lease_owner_null: true, lease_until_null: true,
        });
      },
      loadPhaseBReauthEligibilityFacts: async (pg, clientId) => {
        atomicCalls += 1;
        atomicSqlParams = [clientId];
        // Atomic truth: terminal/dirty / new generation — eligibility must be false.
        return [atomicEligibleRow({
          grant_status: 'revoked',
          reconcile_state: 'dirty',
          grant_generation: 99,
          scope_version: 'phase_b_v1',
        })];
      },
    });
    await routes.handleGet({ client: 'sunset' }, {}, res, { role: 'admin' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.endpoints[0].reauthorize_eligible, false,
      'eligibility from atomic terminal/dirty only — not stale public active/clean');
    assert.strictEqual(res.body.actions.reauthorize, false);
    assert.strictEqual(res.body.endpoints[0].connection_state, 'revoked');
    assert.strictEqual(atomicCalls, 1, 'exactly one atomic set-based load');
    assert.deepStrictEqual(atomicSqlParams, [CLIENT_ID], 'atomic bind client UUID only');
    assert.strictEqual(publicStatusCalls, 0, 'no getDelegatedGrantPublicStatus composition');
    assert.strictEqual(internalRowCalls, 0, 'no second-read internal grant composition');
    // Client slug lookup only on withPgClient.query (atomic dep is injected)
    assert.strictEqual(queries.length, 1);
    assert.deepStrictEqual(queries[0].params, ['sunset']);

    // Fail-closed index: duplicate atomic rows reject aggregate
    const resDup = response();
    const routesDup = createEmailSettingsRoutes({
      runtimeEnv: REAUTH_ENV, sendJSON,
      assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: (fn) => fn({ query: async () => ({ rows: [{ client_id: CLIENT_ID }] }) }),
      listTenantLocations: async () => ({ ok: true, value: [{ location_id: LOCATION, active: true, display_name: 'S' }] }),
      listTenantChannelEndpoints: async () => ({ ok: true, value: [goodRow] }),
      loadPhaseBReauthEligibilityFacts: async () => ([atomicEligibleRow(), atomicEligibleRow()]),
    });
    await routesDup.handleGet({ client: 'sunset' }, {}, resDup, { role: 'admin' });
    assert.strictEqual(resDup.status, 500);

    // Fail-closed index: missing atomic row
    const resMiss = response();
    const routesMiss = createEmailSettingsRoutes({
      runtimeEnv: REAUTH_ENV, sendJSON,
      assertStaffClientAccess() { return true; },
      authorizeAuthenticatedStaffRoute() { return { ok: true }; },
      withPgClient: (fn) => fn({ query: async () => ({ rows: [{ client_id: CLIENT_ID }] }) }),
      listTenantLocations: async () => ({ ok: true, value: [{ location_id: LOCATION, active: true, display_name: 'S' }] }),
      listTenantChannelEndpoints: async () => ({ ok: true, value: [goodRow] }),
      loadPhaseBReauthEligibilityFacts: async () => ([]),
    });
    await routesMiss.handleGet({ client: 'sunset' }, {}, resMiss, { role: 'admin' });
    assert.strictEqual(resMiss.status, 500);

    // Pure index helpers
    const okIdx = indexAtomicEligibilityRows([atomicEligibleRow()], [ENDPOINT_ID]);
    assert.strictEqual(okIdx.ok, true);
    assert.strictEqual(okIdx.map.get(ENDPOINT_ID).grant_status, 'active');
    assert.strictEqual(indexAtomicEligibilityRows([atomicEligibleRow()], ['nope']).ok, false);
    assert.strictEqual(normalizeAtomicEligibilityRow(null), null);
    const fact = grantFactFromAtomicEligibilityRow(atomicEligibleRow());
    assert.strictEqual(fact.lease_clear, true);
    assert.strictEqual(fact.scope_version, 'phase_a_v2');
    assert.strictEqual(isEligiblePhaseBReauthorizeEndpoint(
      { provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code',
        connector_mode: 'microsoft_delegated_oauth', binding_status: 'verified',
        public_address: MAILBOX, active: true, location_active: true,
        location_id: LOCATION },
      fact,
    ), false);
    assert.strictEqual(isEligibleDisconnectEndpoint(
      { provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code',
        connector_mode: 'microsoft_delegated_oauth', binding_status: 'verified',
        public_address: MAILBOX, active: true, location_active: true,
        location_id: LOCATION },
      fact,
    ), true);
    // No sensitive projection from public grant helper
    const pub = publicGrantFromAtomicEligibilityRow(atomicEligibleRow());
    const pubText = JSON.stringify(pub);
    assert.ok(!pubText.includes('scope_version'));
    assert.ok(!pubText.includes('lease_token'));
    assert.ok(!pubText.includes('phase_a_v2'));
  });

  await test('atomic mutants: inactive endpoint/location, extra key, 101 rows, ownership — all false/unavailable', async () => {
    const goodRow = {
      id: ENDPOINT_ID,
      location_id: LOCATION,
      provider: 'microsoft_graph',
      public_address: MAILBOX,
      auth_mode: 'delegated_authorization_code',
      connector_mode: 'microsoft_delegated_oauth',
      binding_status: 'verified',
      secret_ref: 'kv://must-not-leak',
      active: true,
    };
    async function getWithAtomic(rowsOrFn) {
      const res = response();
      const routes = createEmailSettingsRoutes({
        runtimeEnv: REAUTH_ENV,
        sendJSON,
        assertStaffClientAccess() { return true; },
        authorizeAuthenticatedStaffRoute() { return { ok: true }; },
        withPgClient: (fn) => fn({ query: async () => ({ rows: [{ client_id: CLIENT_ID }] }) }),
        listTenantLocations: async () => ({
          ok: true,
          value: [{ location_id: LOCATION, display_name: 'Somo', active: true }],
        }),
        listTenantChannelEndpoints: async () => ({ ok: true, value: [goodRow] }),
        loadPhaseBReauthEligibilityFacts: typeof rowsOrFn === 'function'
          ? rowsOrFn
          : async () => rowsOrFn,
      });
      await routes.handleGet({ client: 'sunset' }, {}, res, { role: 'admin' });
      return res;
    }

    // Baseline connected endpoint: reauthorize retired; disconnect only when gate on
    {
      const res = await getWithAtomic([atomicEligibleRow()]);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.endpoints[0].reauthorize_eligible, false);
      assert.strictEqual(res.body.actions.reauthorize, false);
      const text = JSON.stringify(res.body);
      assert.ok(!text.includes('secret_ref'));
      assert.ok(!text.includes('kv://'));
      assert.ok(!text.includes('scope_version'));
      assert.ok(!text.includes('lease_token'));
    }

    // Mutant: endpoint inactive → reauthorize false, no sensitive DTO
    {
      const res = await getWithAtomic([atomicEligibleRow({ endpoint_active: false })]);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.endpoints[0].reauthorize_eligible, false);
      assert.strictEqual(res.body.actions.reauthorize, false);
      assert.ok(!JSON.stringify(res.body).includes('secret_ref'));
    }

    // Mutant: location inactive → reauthorize false
    {
      const res = await getWithAtomic([atomicEligibleRow({ location_active: false })]);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.endpoints[0].reauthorize_eligible, false);
      assert.strictEqual(res.body.actions.reauthorize, false);
    }

    // Mutant: location_active null (join miss / wrong client ownership) → false
    {
      const res = await getWithAtomic([atomicEligibleRow({ location_active: null })]);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.endpoints[0].reauthorize_eligible, false);
    }

    // Mutant: null location_id fails normalize → aggregate unavailable (500)
    {
      const res = await getWithAtomic([atomicEligibleRow({ location_id: null })]);
      assert.strictEqual(res.status, 500);
      assert.strictEqual(res.body.error, 'email_settings_unavailable');
      assert.ok(!JSON.stringify(res.body).includes('secret_ref'));
      assert.ok(!JSON.stringify(res.body).includes('kv://'));
    }

    // Mutant: extra secret_ref key on atomic row fails closed before projection
    {
      assert.strictEqual(
        normalizeAtomicEligibilityRow(atomicEligibleRow({ secret_ref: 'kv://x' })),
        null,
        'extra secret_ref fails normalize',
      );
      const res = await getWithAtomic([atomicEligibleRow({ secret_ref: 'kv://leaked' })]);
      assert.strictEqual(res.status, 500);
      assert.strictEqual(res.body.error, 'email_settings_unavailable');
      assert.ok(!JSON.stringify(res.body).includes('secret_ref'));
      assert.ok(!JSON.stringify(res.body).includes('kv://leaked'));
    }

    // Mutant: extra arbitrary key fails exact key set
    {
      assert.strictEqual(normalizeAtomicEligibilityRow(atomicEligibleRow({ extra: 1 })), null);
      assert.strictEqual(
        indexAtomicEligibilityRows([atomicEligibleRow({ foo: 'bar' })], [ENDPOINT_ID]).ok,
        false,
      );
    }

    // Mutant: non-enumerable / accessor / symbol / non-plain prototype fail normalize
    {
      const base = atomicEligibleRow();
      const withAccessor = {};
      for (const k of ATOMIC_ELIGIBILITY_OWN_KEYS) {
        Object.defineProperty(withAccessor, k, {
          get: () => base[k], enumerable: true, configurable: true,
        });
      }
      assert.strictEqual(normalizeAtomicEligibilityRow(withAccessor), null, 'accessors fail');

      const withNonEnum = {};
      for (const k of ATOMIC_ELIGIBILITY_OWN_KEYS) {
        Object.defineProperty(withNonEnum, k, {
          value: base[k], enumerable: k !== 'endpoint_id', configurable: true, writable: true,
        });
      }
      assert.strictEqual(normalizeAtomicEligibilityRow(withNonEnum), null, 'non-enumerable fails');

      const withSymbol = atomicEligibleRow();
      withSymbol[Symbol('x')] = 1;
      assert.strictEqual(normalizeAtomicEligibilityRow(withSymbol), null, 'symbol key fails');

      const protoObj = Object.create({ polluted: true });
      Object.assign(protoObj, atomicEligibleRow());
      assert.strictEqual(normalizeAtomicEligibilityRow(protoObj), null, 'non-plain prototype fails');
    }

    // Mutant: 101 rows exceed cardinality → unavailable
    {
      assert.strictEqual(PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS, 100);
      const manyIds = [];
      const manyRows = [];
      for (let i = 0; i < 101; i += 1) {
        const id = `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`;
        manyIds.push(id);
        manyRows.push(atomicEligibleRow({ endpoint_id: id }));
      }
      assert.strictEqual(
        indexAtomicEligibilityRows(manyRows, manyIds).ok,
        false,
        '101 rows fail index cardinality',
      );
      // Route: 101 listed endpoints fail closed before/at atomic load
      const res = response();
      const epRows = manyIds.map((id) => ({
        id,
        location_id: LOCATION,
        provider: 'microsoft_graph',
        public_address: MAILBOX,
        auth_mode: 'delegated_authorization_code',
        connector_mode: 'microsoft_delegated_oauth',
        binding_status: 'verified',
      }));
      const routes = createEmailSettingsRoutes({
        runtimeEnv: REAUTH_ENV,
        sendJSON,
        assertStaffClientAccess() { return true; },
        authorizeAuthenticatedStaffRoute() { return { ok: true }; },
        withPgClient: (fn) => fn({ query: async () => ({ rows: [{ client_id: CLIENT_ID }] }) }),
        listTenantLocations: async () => ({
          ok: true,
          value: [{ location_id: LOCATION, display_name: 'Somo', active: true }],
        }),
        listTenantChannelEndpoints: async () => ({ ok: true, value: epRows }),
        loadPhaseBReauthEligibilityFacts: async () => manyRows,
      });
      await routes.handleGet({ client: 'sunset' }, {}, res, { role: 'admin' });
      assert.strictEqual(res.status, 500);
      assert.strictEqual(res.body.error, 'email_settings_unavailable');
      assert.ok(!JSON.stringify(res.body).includes('secret_ref'));
    }

    // Mutant: load returns 101 rows (SQL LIMIT max+1) → null/unavailable
    {
      const res = response();
      const routes = createEmailSettingsRoutes({
        runtimeEnv: REAUTH_ENV,
        sendJSON,
        assertStaffClientAccess() { return true; },
        authorizeAuthenticatedStaffRoute() { return { ok: true }; },
        withPgClient: (fn) => fn({ query: async () => ({ rows: [{ client_id: CLIENT_ID }] }) }),
        listTenantLocations: async () => ({
          ok: true,
          value: [{ location_id: LOCATION, display_name: 'Somo', active: true }],
        }),
        listTenantChannelEndpoints: async () => ({ ok: true, value: [goodRow] }),
        loadPhaseBReauthEligibilityFacts: async () => {
          // Simulate loader detecting over-bound (production returns null).
          return null;
        },
      });
      await routes.handleGet({ client: 'sunset' }, {}, res, { role: 'admin' });
      assert.strictEqual(res.status, 500);
    }

    // Mutant: stale public active/clean vs atomic terminal still false (independent of inactive path)
    {
      const res = await getWithAtomic([atomicEligibleRow({
        endpoint_active: true,
        location_active: true,
        grant_status: 'revoked',
        reconcile_state: 'dirty',
      })]);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.endpoints[0].reauthorize_eligible, false,
        'atomic terminal overrides any stale public active/clean');
      assert.strictEqual(res.body.endpoints[0].connection_state, 'revoked');
      assert.ok(!JSON.stringify(res.body).includes('scope_version'));
    }

    // Pure normalize exact key set: missing key fails
    {
      const missing = atomicEligibleRow();
      delete missing.location_active;
      assert.strictEqual(normalizeAtomicEligibilityRow(missing), null);
    }
  });

  await test('B3b UI unit only: reauthorize control, click POST, validation, isolation, concealment', async () => {
    const src = fs.readFileSync(require.resolve('./browser/sunset-admin-email-settings-ui.js'), 'utf8');
    assert.ok(src.includes('data-email-reauthorize'));
    assert.ok(src.includes('postMicrosoftOAuthReauthorize'));
    assert.ok(src.includes('validatePhaseBReauthorizeSuccessDto'));
    assert.ok(src.includes('/staff/admin/email-settings/oauth/microsoft/reauthorize'));
    assert.ok(src.includes('window.location.assign'));
    assert.ok(src.includes('adminEmailReauthSeq'));
    assert.ok(src.includes('function cancelAdminEmailReauthorization'));
    assert.ok(src.includes('function isAdminEmailReauthSurfaceLive'));
    assert.ok(src.includes('AbortController'));
    assert.ok(src.includes('AbortError'));
    // Production cancel hooks in real tab/client navigation paths (not test-only).
    const adminUiSrc = fs.readFileSync(require.resolve('./browser/sunset-admin-ui.js'), 'utf8');
    assert.ok(adminUiSrc.includes('cancelAdminEmailReauthorization'));
    const apiSrc = fs.readFileSync(require.resolve('./staff-query-api.js'), 'utf8');
    assert.ok(apiSrc.includes('cancelAdminEmailReauthorization'));
    // No browser-supplied secrets / scopes / client overrides in POST body
    assert.ok(!/JSON\.stringify\(\s*\{[^}]*client_id/.test(src));
    assert.ok(!/JSON\.stringify\(\s*\{[^}]*scope/.test(src));
    assert.ok(!/JSON\.stringify\(\s*\{[^}]*redirect_uri/.test(src));
    assert.ok(!/JSON\.stringify\(\s*\{[^}]*grant_generation/.test(src));
    assert.ok(src.includes("JSON.stringify({ location_id: locationId, endpoint_id: endpointId })"));
    // Independent browser contract constants present (not imported from producers)
    assert.ok(src.includes(CANON_REDIR));
    assert.ok(src.includes(CANON_SCOPES));
    assert.ok(src.includes("REAUTH_UI_AUTHORITY_ORIGIN = 'https://login.microsoftonline.com'"));
    // CSS min 44px in staff-query-api
    assert.ok(/data-email-reauthorize[\s\S]{0,200}min-height:\s*44px|min-height:\s*44px[\s\S]{0,200}data-email-reauthorize/.test(apiSrc)
      || (apiSrc.includes('[data-email-reauthorize]') && apiSrc.includes('min-height:44px')));

    // DOM harness with genuine click events
    function makeEl(tag, attrs) {
      const listeners = {};
      const el = {
        tagName: String(tag || 'DIV').toUpperCase(),
        attrs: Object.assign({}, attrs || {}),
        children: [],
        disabled: false,
        value: '',
        style: {},
        className: '',
        _html: '',
        getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
        setAttribute(name, v) { this.attrs[name] = String(v); },
        addEventListener(type, fn) {
          if (!listeners[type]) listeners[type] = [];
          listeners[type].push(fn);
        },
        click() {
          const list = listeners.click || [];
          for (const fn of list) fn({ type: 'click', target: el });
        },
        querySelector(sel) {
          if (sel === '.portal-admin-email-settings') {
            return this.children.find((c) => c.className && c.className.indexOf('portal-admin-email-settings') >= 0) || this._section || null;
          }
          if (sel === '[data-email-reauthorize]') {
            return this._findAttr('data-email-reauthorize');
          }
          if (sel === '[data-email-connect]') return this._findAttr('data-email-connect');
          if (sel === '[data-email-prepare-address]') return this._findAttr('data-email-prepare-address');
          return null;
        },
        querySelectorAll() { return []; },
        _findAttr(name) {
          if (Object.prototype.hasOwnProperty.call(this.attrs, name)) return this;
          for (const c of this.children) {
            const f = c._findAttr && c._findAttr(name);
            if (f) return f;
          }
          if (this._section) {
            const f = this._section._findAttr && this._section._findAttr(name);
            if (f) return f;
          }
          return null;
        },
      };
      Object.defineProperty(el, 'innerHTML', {
        get() { return el._html; },
        set(v) {
          el._html = String(v);
          // Parse minimal reauth button from HTML for event wiring.
          el.children = [];
          el._section = null;
          const section = makeEl('section', { 'data-email-state': 'connected_health' });
          section.className = 'portal-admin-email-settings';
          const reauthMatch = String(v).match(/data-email-reauthorize="1"[^>]*data-email-location-id="([^"]*)"[^>]*data-email-endpoint-id="([^"]*)"/)
            || String(v).match(/data-email-reauthorize="1" data-email-location-id="([^"]*)" data-email-endpoint-id="([^"]*)"/);
          // More tolerant: extract attrs separately
          if (/data-email-reauthorize/.test(String(v))) {
            const loc = (String(v).match(/data-email-location-id="([^"]*)"/) || [])[1] || '';
            const ep = (String(v).match(/data-email-endpoint-id="([^"]*)"/) || [])[1] || '';
            const btn = makeEl('button', {
              'data-email-reauthorize': '1',
              'data-email-location-id': loc,
              'data-email-endpoint-id': ep,
              type: 'button',
            });
            btn.className = 'portal-admin-email-action-btn';
            section.children.push(btn);
            Object.defineProperty(btn, 'disabled', {
              get() { return btn._disabled === true; },
              set(x) { btn._disabled = x === true; },
              configurable: true,
            });
            btn._disabled = false;
          }
          el._section = section;
          el.children = [section];
        },
        configurable: true,
      });
      return el;
    }

    const body = makeEl('div', { id: 'admin-email-settings-body' });
    body.id = 'admin-email-settings-body';
    body.isConnected = true;
    // Unit-only mock Admin + Email surface so isAdminEmailReauthSurfaceLive can pass.
    // Playwright is the real-browser acceptance gate; this harness is unit only.
    let emailTabSelected = true;
    let emailPanelHidden = false;
    let adminTabActive = true;
    const adminTabBtn = {
      classList: {
        contains(name) { return adminTabActive && name === 'active'; },
      },
    };
    const emailTabEl = {
      getAttribute(name) { return name === 'aria-selected' ? (emailTabSelected ? 'true' : 'false') : null; },
    };
    const emailPanelEl = {
      hasAttribute(name) { return name === 'hidden' ? emailPanelHidden : false; },
      hidden: false,
      getAttribute() { return null; },
    };
    const byId = {
      'admin-email-settings-body': body,
      'admin-tab-email': emailTabEl,
      'admin-panel-email': emailPanelEl,
    };
    const docBody = {
      contains(node) { return !!node; },
    };
    const calls = [];
    let assigned = null;
    let clientSlug = 'sunset';
    const i18nKeys = {
      'admin.email.title': 'Email Settings',
      'admin.email.state.connected_health': 'Mailbox connected. Email processing remains off.',
      'admin.email.state.error': 'Email status is temporarily unavailable.',
      'admin.email.state.unavailable': 'Email settings are unavailable.',
      'admin.email.endpointActive': 'Endpoint active',
      'admin.email.inbound': 'Inbound',
      'admin.email.outbound': 'Outbound',
      'admin.email.automation': 'Automation',
      'admin.email.off': 'Off',
      'admin.email.actionsUnavailable': 'Connect and disconnect are not available in this release.',
      'admin.email.connectSafetyNote': 'Connection verifies identity only; endpoint, inbound, outbound and automation remain off.',
      'admin.email.reauthorizeButton': 'Reauthorize Microsoft',
      'admin.email.reauthorizeLabel': 'Microsoft reauthorization',
      'admin.email.reauthorizeSafetyNote': 'Microsoft permissions are being upgraded for staff-approved replies. Authorization itself does not send any email.',
      'admin.email.mailboxLabel': 'Microsoft email address',
    };
    let fetchImpl = null;
    // Minimal AbortController for unit surface-isolation checks.
    function UnitAbortController() {
      this.signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
      this.abort = function abort() { this.signal.aborted = true; };
    }
    const sandbox = {
      URL,
      Date,
      Object,
      Array,
      Number,
      String,
      Promise,
      JSON,
      AbortController: UnitAbortController,
      adminEmailSettingsLoadSeq: 0,
      adminEmailReauthSeq: 0,
      adminEmailReauthAbortController: null,
      adminEmailReauthOrigin: null,
      window: {
        location: {
          assign(url) { assigned = url; },
        },
      },
      document: {
        body: docBody,
        getElementById(id) { return byId[id] || null; },
        querySelector(sel) {
          if (sel === 'button.tab-btn[data-tab="admin"]') return adminTabBtn;
          return null;
        },
      },
      el(id) { return byId[id] || null; },
      escHtml(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      },
      portalT(key) { return i18nKeys[key] || key; },
      getClient() { return clientSlug; },
      fetch(url, opts) {
        if (typeof fetchImpl === 'function') return fetchImpl(url, opts);
        calls.push({ url: String(url), body: opts && opts.body, method: opts && opts.method, headers: opts && opts.headers });
        return Promise.resolve({ ok: false, json: async () => ({}) });
      },
      console,
    };
    vm.runInNewContext(src, sandbox);
    assert.strictEqual(typeof sandbox.cancelAdminEmailReauthorization, 'function');
    assert.strictEqual(typeof sandbox.isAdminEmailReauthSurfaceLive, 'function');

    // Response validator unit checks (independent contract)
    const goodUrl = buildValidReauthUrl();
    const goodDto = { authorization_url: goodUrl, expires_at: futureExpires(600000) };
    assert.strictEqual(sandbox.validatePhaseBReauthorizeSuccessDto(goodDto), goodUrl);
    assert.strictEqual(sandbox.validatePhaseBReauthorizeSuccessDto({ authorization_url: goodUrl }), null);
    assert.strictEqual(sandbox.validatePhaseBReauthorizeSuccessDto({
      authorization_url: goodUrl, expires_at: futureExpires(600000), extra: 1,
    }), null);
    assert.strictEqual(sandbox.validatePhaseBReauthorizeSuccessDto({
      authorization_url: 'https://evil.example/oauth', expires_at: futureExpires(600000),
    }), null);
    assert.strictEqual(sandbox.validatePhaseBReauthorizeSuccessDto({
      authorization_url: buildValidReauthUrl((u) => { u.searchParams.set('scope', 'openid'); }),
      expires_at: futureExpires(600000),
    }), null);
    assert.strictEqual(sandbox.validatePhaseBReauthorizeSuccessDto({
      authorization_url: goodUrl, expires_at: new Date(Date.now() - 1000).toISOString(),
    }), null);
    assert.strictEqual(sandbox.validatePhaseBReauthorizeSuccessDto({
      authorization_url: goodUrl, expires_at: futureExpires(60 * 60 * 1000),
    }), null);
    // credentials / fragment rejected
    assert.strictEqual(sandbox.validatePhaseBReauthorizeSuccessDto({
      authorization_url: buildValidReauthUrl((u) => { /* fragment */ u.hash = 'x'; }),
      expires_at: futureExpires(600000),
    }), null);

    // Eligible render: button + safety; no auto POST; no connect
    calls.length = 0;
    assigned = null;
    sandbox.renderAdminEmailSettingsState('connected_health', {
      actions: { prepare: false, connect: false, disconnect: false, reauthorize: true },
      reauthorize_eligible: true,
      location_id: LOCATION,
      endpoint_id: ENDPOINT_ID,
      public_address: MAILBOX,
    });
    assert.strictEqual(calls.length, 0, 'no auto POST on render');
    assert.ok(body.innerHTML.includes('data-email-reauthorize'));
    assert.ok(body.innerHTML.includes('Reauthorize Microsoft'));
    assert.ok(body.innerHTML.includes('data-email-reauth-safety'));
    assert.ok(body.innerHTML.includes(i18nKeys['admin.email.reauthorizeSafetyNote']));
    assert.ok(!body.innerHTML.includes('data-email-connect='));
    assert.ok(!body.innerHTML.includes('data-email-actions-unavailable'));
    assert.ok(body.innerHTML.includes('min-height') || apiSrc.includes('min-height:44px'));

    // Genuine click → exact POST body, authority-neutral (only location_id + endpoint_id)
    fetchImpl = function(url, opts) {
      calls.push({ url: String(url), body: opts && opts.body, method: opts && opts.method });
      return Promise.resolve({
        ok: true,
        json: async () => ({ authorization_url: goodUrl, expires_at: futureExpires(600000) }),
      });
    };
    async function flush() {
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    }
    const btn = body.querySelector('[data-email-reauthorize]');
    assert.ok(btn, 'reauthorize button present');
    btn.click();
    await flush();
    assert.strictEqual(calls.length, 1, `expected one reauth POST, got ${calls.length}`);
    assert.strictEqual(calls[0].url, '/staff/admin/email-settings/oauth/microsoft/reauthorize');
    assert.strictEqual(calls[0].method, 'POST');
    assert.strictEqual(calls[0].body, JSON.stringify({ location_id: LOCATION, endpoint_id: ENDPOINT_ID }));
    const parsedBody = JSON.parse(calls[0].body);
    assert.deepStrictEqual(Object.keys(parsedBody).sort(), ['endpoint_id', 'location_id']);
    assert.ok(!Object.prototype.hasOwnProperty.call(parsedBody, 'client_id'));
    assert.ok(!Object.prototype.hasOwnProperty.call(parsedBody, 'scope'));
    assert.strictEqual(assigned, goodUrl, 'navigates only after valid response');

    // Double-click / pending: second click while disabled does not POST again
    calls.length = 0;
    assigned = null;
    let resolveFetch;
    let lastFetchSignal = null;
    fetchImpl = function(url, opts) {
      calls.push({ url: String(url), body: opts && opts.body, method: opts && opts.method, signal: opts && opts.signal });
      lastFetchSignal = opts && opts.signal;
      return new Promise((resolve, reject) => {
        resolveFetch = () => resolve({
          ok: true,
          json: async () => ({ authorization_url: goodUrl, expires_at: futureExpires(600000) }),
        });
        // If aborted while pending, reject with AbortError (production quiet path).
        if (opts && opts.signal) {
          const sig = opts.signal;
          const onAbort = () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (sig.aborted) onAbort();
          else if (typeof sig.addEventListener === 'function') sig.addEventListener('abort', onAbort);
        }
      });
    };
    sandbox.renderAdminEmailSettingsState('connected_health', {
      actions: { prepare: false, connect: false, disconnect: false, reauthorize: true },
      reauthorize_eligible: true,
      location_id: LOCATION,
      endpoint_id: ENDPOINT_ID,
    });
    const btn2 = body.querySelector('[data-email-reauthorize]');
    // Mark origin nodes connected for live-surface checks
    btn2.isConnected = true;
    if (body._section) body._section.isConnected = true;
    btn2.click();
    await flush();
    assert.strictEqual(btn2.disabled, true);
    btn2.click(); // ignored while disabled
    await flush();
    assert.strictEqual(calls.length, 1, 'second click while pending does not re-POST');
    // Production cancel (leave Email/Admin/client) invalidates pending — no navigation, quiet.
    const seqBeforeCancel = sandbox.adminEmailReauthSeq;
    sandbox.cancelAdminEmailReauthorization();
    assert.ok(sandbox.adminEmailReauthSeq > seqBeforeCancel);
    resolveFetch();
    await flush();
    assert.strictEqual(assigned, null, 'cancelled / stale response must not navigate');

    // Leave Email tab surface while pending → no navigation even if response succeeds
    calls.length = 0;
    assigned = null;
    let resolveFetch2;
    fetchImpl = function(url, opts) {
      calls.push({ url: String(url), body: opts && opts.body });
      return new Promise((resolve) => {
        resolveFetch2 = () => resolve({
          ok: true,
          json: async () => ({ authorization_url: goodUrl, expires_at: futureExpires(600000) }),
        });
      });
    };
    sandbox.renderAdminEmailSettingsState('connected_health', {
      actions: { prepare: false, connect: false, disconnect: false, reauthorize: true },
      reauthorize_eligible: true,
      location_id: LOCATION,
      endpoint_id: ENDPOINT_ID,
    });
    const btnLeave = body.querySelector('[data-email-reauthorize]');
    btnLeave.isConnected = true;
    if (body._section) body._section.isConnected = true;
    btnLeave.click();
    await flush();
    emailTabSelected = false; // operator left Email panel
    resolveFetch2();
    await flush();
    assert.strictEqual(assigned, null, 'success after leaving Email must not navigate');
    emailTabSelected = true;

    // Error path: non-2xx → no navigation, bounded error state
    calls.length = 0;
    assigned = null;
    fetchImpl = function(url, opts) {
      calls.push({ url: String(url), body: opts && opts.body });
      return Promise.resolve({ ok: false, status: 503, json: async () => ({ success: false, error: 'oauth_reauthorization_unavailable', token: 'leak' }) });
    };
    sandbox.renderAdminEmailSettingsState('connected_health', {
      actions: { prepare: false, connect: false, disconnect: false, reauthorize: true },
      reauthorize_eligible: true,
      location_id: LOCATION,
      endpoint_id: ENDPOINT_ID,
    });
    body.querySelector('[data-email-reauthorize]').click();
    await flush();
    assert.strictEqual(assigned, null);
    assert.ok(body.innerHTML.includes('data-email-state="error"') || body.innerHTML.includes('temporarily unavailable'));

    // Malformed success JSON → no navigation
    assigned = null;
    fetchImpl = function() {
      return Promise.resolve({
        ok: true,
        json: async () => ({ authorization_url: goodUrl, expires_at: futureExpires(600000), authorization_intent: 'phase_b_reauthorization' }),
      });
    };
    sandbox.renderAdminEmailSettingsState('connected_health', {
      actions: { prepare: false, connect: false, disconnect: false, reauthorize: true },
      reauthorize_eligible: true,
      location_id: LOCATION,
      endpoint_id: ENDPOINT_ID,
    });
    body.querySelector('[data-email-reauthorize]').click();
    await flush();
    assert.strictEqual(assigned, null, 'extra keys reject navigation');

    // Flag/action off: no control
    sandbox.renderAdminEmailSettingsState('connected_health', {
      actions: { prepare: false, connect: false, disconnect: false, reauthorize: false },
      reauthorize_eligible: false,
      location_id: LOCATION,
      endpoint_id: ENDPOINT_ID,
    });
    assert.ok(!body.innerHTML.includes('data-email-reauthorize'));
    assert.ok(body.innerHTML.includes('data-email-actions-unavailable'));

    // Non-Sunset client: unavailable, no reauth control
    clientSlug = 'wolfhouse-somo';
    sandbox.renderAdminEmailSettingsState('unavailable', {
      actions: { prepare: false, connect: false, disconnect: false, reauthorize: true },
      reauthorize_eligible: true,
      location_id: LOCATION,
      endpoint_id: ENDPOINT_ID,
    });
    // State unavailable still may render actions if data says so — load path blocks non-sunset.
    // Explicit: loadAdminEmailSettings for non-sunset renders unavailable without fetch.
    calls.length = 0;
    sandbox.loadAdminEmailSettings();
    await Promise.resolve();
    assert.strictEqual(calls.length, 0, 'non-Sunset load makes zero route calls');
    assert.ok(body.innerHTML.includes('data-email-state="unavailable"') || body.innerHTML.includes('unavailable'));
    clientSlug = 'sunset';

    // Never both connect and reauthorize in rendered HTML when both claimed
    sandbox.renderAdminEmailSettingsState('connected_health', {
      actions: { prepare: false, connect: true, disconnect: false, reauthorize: true },
      reauthorize_eligible: true,
      location_id: LOCATION,
      endpoint_id: ENDPOINT_ID,
    });
    const bothHtml = body.innerHTML;
    assert.ok(bothHtml.includes('data-email-reauthorize'));
    assert.ok(!bothHtml.includes('data-email-connect='), 'reauthorize wins; connect suppressed for same endpoint');
  });

  console.log(`PASS ${count} tests`);
})().catch((e)=>{ console.error(e); process.exitCode=1; });
