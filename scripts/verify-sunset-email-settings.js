'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const {
  isSunsetEmailSettingsUiEnabled, createEmailSettingsRoutes, endpointDto,
} = require('./lib/staff-email-settings-routes');

let count = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { count += 1; console.log(`ok ${count} - ${name}`); }); }
function response() { return { status: null, body: null }; }
function sendJSON(res, status, body) { res.status = status; res.body = body; return body; }

(async () => {
  await test('flag defaults off and accepts only true', () => {
    assert.strictEqual(isSunsetEmailSettingsUiEnabled({}), false);
    assert.strictEqual(isSunsetEmailSettingsUiEnabled({ SUNSET_EMAIL_SETTINGS_UI_ENABLED: '1' }), false);
    assert.strictEqual(isSunsetEmailSettingsUiEnabled({ SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true' }), true);
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
    assert.deepStrictEqual(res.body.actions,{connect:false,disconnect:false});
    assert.strictEqual(res.body.endpoints[0].connection_state,'connected_health');
    assert.strictEqual(res.body.endpoints[0].endpoint_active,false); assert.strictEqual(res.body.endpoints[0].inbound_enabled,false); assert.strictEqual(res.body.endpoints[0].outbound_enabled,false); assert.strictEqual(res.body.endpoints[0].automation_enabled,false);
    const text=JSON.stringify(res.body); for (const forbidden of ['secret_ref','provider_tenant_id','client_id','has_active_lease','ciphertext','wrapped_dek','oauth']) assert.ok(!text.includes(forbidden), forbidden);
    assert.deepStrictEqual(queries[0][1],['sunset']);
  });
  await test('public state covers reauth, revoked and registered states', () => {
    assert.strictEqual(endpointDto({id:'e',location_id:'l'}, {grant_present:false}).connection_state,'registered_not_connected');
    assert.strictEqual(endpointDto({id:'e',location_id:'l'}, {grant_present:true,grant_status:'reauthorization_required'}).connection_state,'reauth_required');
    assert.strictEqual(endpointDto({id:'e',location_id:'l'}, {grant_present:true,grant_status:'revoked'}).connection_state,'revoked');
  });
  await test('browser panel has all inert states and no connect/disconnect controls', () => {
    const src=fs.readFileSync(require.resolve('./browser/sunset-admin-email-settings-ui.js'),'utf8');
    for(const state of ['unavailable','loading','disconnected','registered_not_connected','connected_health','reauth_required','revoked','error']) assert.ok(src.includes(state));
    assert.ok(!/<button[^>]*connect/i.test(src)); assert.ok(!/method\s*:\s*['"]POST/i.test(src));
    new vm.Script(src);
  });
  await test('startup sources and i18n load safely', () => {
    const source=require('./lib/sunset-admin-browser-source').getSunsetAdminUiBrowserSource(); assert.ok(source.includes('loadAdminEmailSettings'));
    require('./lib/staff-portal-i18n'); require('./lib/staff-portal-i18n-es-sunset');
  });
  console.log(`PASS ${count} tests`);
})().catch((e)=>{ console.error(e); process.exitCode=1; });
