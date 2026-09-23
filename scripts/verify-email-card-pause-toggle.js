#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { endpointDto } = require('./lib/staff-email-settings-routes');
const row = { id:'22222222-2222-4222-8222-222222222222', location_id:'sunset-somo', provider:'imap_smtp', public_address:'mail@example.test', active:true, inbound_enabled:true, outbound_enabled:true, default_automation_mode:'automatic', mail_flow_paused:true };
const grant = { smtp_verified:true, imap_verified:true };
const paused = endpointDto(row, grant);
assert.equal(paused.mail_flow_paused, true, 'DTO must expose independent persisted pause');
assert.equal(paused.connection_state, 'connected_health', 'pause must not disconnect');
assert.equal(paused.inbound_enabled, true, 'saved inbound permission retained');
assert.equal(paused.outbound_enabled, true, 'saved outbound permission retained');
assert.equal(paused.automation_enabled, true, 'saved automation permission retained');
assert.equal(endpointDto({...row,mail_flow_paused:false}, grant).mail_flow_paused, false);
console.log('PASS mailbox pause DTO preserves connection and saved permissions');
const { createEmailSettingsRoutes } = require('./lib/staff-email-settings-routes');
async function main() {
  const req = {headers:{origin:'https://staff-staging.lunafrontdesk.com','content-type':'application/json'}};
  const env = { STAFF_PORTAL_ORIGIN:'https://staff-staging.lunafrontdesk.com', LUNA_DEPLOYMENT:'sunset-staging', SUNSET_EMAIL_SETTINGS_UI_ENABLED:'true' };
  let writes = 0;
  const routes = createEmailSettingsRoutes({runtimeEnv:env,
    sendJSON(res,status,body){ Object.assign(res,{status,body}); },
    assertStaffClientAccess(user,slug,res){ if(user.client_slug===slug)return true; Object.assign(res,{status:403}); return false; },
    authorizeAuthenticatedStaffRoute(){return {ok:true};},
    withPgClient: async fn => fn({query:async (sql,args) => {writes++; assert.match(sql,/UPDATE tenant_channel_endpoints/); assert.equal(args[0],'sunset'); assert.equal(args[3],true); return {rows:[{endpoint_id:row.id,mail_flow_paused:true}]};}}),
  });
  assert.equal(typeof routes.handlePausePost,'function','settings routes need a persisted pause handler');
  const body = {client:'sunset',location_id:'sunset-somo',endpoint_id:row.id,paused:true};
  const user = {staff_user_id:'33333333-3333-4333-8333-333333333333',role:'admin',client_slug:'sunset'};
  const res={}; await routes.handlePausePost(body,req,res,user);
  assert.equal(res.status,200); assert.equal(res.body.mail_flow_paused,true); assert.equal(writes,1);
  for(const [input,who,status] of [[{...body,paused:'true'},user,400],[{...body,extra:true},user,400],[body,{...user,role:'staff'},403],[body,{...user,client_slug:'wolfhouse-somo'},403]]) {
    const denied={}; await routes.handlePausePost(input,req,denied,who); assert.equal(denied.status,status); assert.equal(writes,1);
  }
  env.LUNA_DEPLOYMENT='production'; const prod={}; await routes.handlePausePost(body,req,prod,user); assert.equal(prod.status,404); assert.equal(writes,1);
  console.log('PASS staging-only admin scoped pause endpoint, strict body, zero forbidden writes');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
