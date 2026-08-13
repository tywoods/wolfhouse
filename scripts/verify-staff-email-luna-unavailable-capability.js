'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createStaffEmailLunaDraftRoute, snapshotEmailLunaGenerateGateEnv,
  EMAIL_LUNA_GENERATION_UNAVAILABLE_ERROR, EMAIL_LUNA_GENERATION_UNAVAILABLE_REASON,
} = require('./lib/staff-email-luna-draft-route');
const C='11111111-1111-4111-8111-111111111111', L='22222222-2222-4222-8222-222222222222';
const E='33333333-3333-4333-8333-333333333333', V='44444444-4444-4444-8444-444444444444';
const A='55555555-5555-4555-8555-555555555555', M='66666666-6666-4666-8666-666666666666';
const MAILBOX='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ORIGIN='https://staff.sunset.test';
function request(){const req=new EventEmitter();req.headers={'content-type':'application/json',origin:ORIGIN};process.nextTick(()=>{req.emit('data',Buffer.from(JSON.stringify({conversation_id:V})));req.emit('end');});return req;}
(async()=>{
  console.log('verify:staff-email-luna-unavailable-capability');
  const actions={db:0,runtime:0,model:0,save:0,approval:0,send:0,provider:0,journal:0}; let response;
  const route=createStaffEmailLunaDraftRoute({
    sendJSON(_res,status,body){response={status,body};},
    runtimeEnv:{LUNA_DEPLOYMENT:'sunset-staging',STAFF_PORTAL_ORIGIN:ORIGIN,EMAIL_STAFF_LUNA_DRAFT_ENABLED:'true',EMAIL_LUNA_DRAFT_RUNTIME_ENABLED:'true'},
    withPgClient:async(fn)=>fn({query:async()=>{actions.db++;return {rows:[{client_id:C,client_slug:'sunset',location_id:L,location_key:'sunset-somo',endpoint_id:E,conversation_id:V,inbound_message_id:M,channel:'email',provider:'microsoft_graph',provider_mailbox_id:MAILBOX,provider_source_message_id:'graph-message-v1',endpoint_provider_mailbox_id:MAILBOX,event_location_id:L,subject:'Policy?',body_text:'',quoted_history:'',from_display_name:'Ana',from_address:'ana@example.test',conversation_deleted_at:null,conversation_status:'open',latest_message_id:M,luna_draft_enabled:true}]};}}),
    createLunaRuntime(){actions.runtime++;return {authorDraft(){actions.model++;}};},
    saveDraftThroughStaffOwner(){actions.save++;}, approveDraft(){actions.approval++;},
    dispatchApprovedOutbound(){actions.send++;}, callProvider(){actions.provider++;}, appendOutboundJournal(){actions.journal++;},
  });
  await route.handleGenerateLunaDraft(request(),{},Object.freeze(Object.assign(Object.create(null),{staff_user_id:A,client_id:C,role:'operator'})),snapshotEmailLunaGenerateGateEnv(route.runtimeEnv));
  assert.equal(actions.db,1,'authenticated authority is reloaded');
  assert.deepEqual(response,{status:503,body:{success:false,error:EMAIL_LUNA_GENERATION_UNAVAILABLE_ERROR,reason:EMAIL_LUNA_GENERATION_UNAVAILABLE_REASON}});
  assert.equal(EMAIL_LUNA_GENERATION_UNAVAILABLE_ERROR,'luna_email_generation_capability_unavailable');
  assert.equal(EMAIL_LUNA_GENERATION_UNAVAILABLE_REASON,'authoritative_content_and_grounded_policy_not_configured');
  assert.deepEqual({...actions,db:0},{db:0,runtime:0,model:0,save:0,approval:0,send:0,provider:0,journal:0});
  console.log('PASS explicit unavailable capability; zero runtime/model/write/send side effects');
})().catch(e=>{console.error(e);process.exit(1);});
