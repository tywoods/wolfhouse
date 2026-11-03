#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { createStaffSupervisorRoutes } = require('./lib/staff-supervisor-routes');
const { createInboxRoutes } = require('./lib/staff-inbox-routes');
const { isSupervisorAccount } = require('./lib/staff-supervisor-events');

const TENANT='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONV='11111111-1111-4111-8111-111111111111';
const WRONG='22222222-2222-4222-8222-222222222222';
const INCIDENT='33333333-3333-4333-8333-333333333333';
const TOKEN='lease-live-token';
process.env.LUNA_SUPERVISOR_STAFF_USER_ID='luna-supervisor';
const supervisor={staff_user_id:'luna-supervisor',role:'admin',client_id:TENANT,client_slug:'wolfhouse-somo'};
const human={staff_user_id:'human',role:'operator',client_id:TENANT,client_slug:'wolfhouse-somo'};
let incident;
function pg(){ return { async query(sql,params=[]){
  if (/FROM conversations c\s+JOIN clients cl/.test(sql)) return params[0]===CONV?{rows:[{id:CONV,phone:'+34123456789',last_staff_reply_at:null,current_hold_booking_id:null,needs_human_transition_id:null,metadata:{},client_id:TENANT,client_slug:'wolfhouse-somo'}]}:{rows:[]};
  if (/settings->'inbox_channel_modes'/.test(sql)) return {rows:[{whatsapp_mode:'auto'}]};
  if (/FROM supervisor_incidents[\s\S]*conversation_id/.test(sql)) return {rows:incident&&incident.conversation_id===params[0]?[incident]:[]};
  if (/SELECT \* FROM supervisor_incidents WHERE id/.test(sql)) return {rows:incident&&incident.id===params[0]?[incident]:[]};
  return {rows:[],rowCount:0};
}};}
const routes=createStaffSupervisorRoutes({sendJSON(){},withPgClient:async fn=>fn(pg())});
function shape(kind,token=TOKEN){
  if(kind==='header') return {req:{headers:{'x-supervisor-lease-token':token}},body:{conversation_id:CONV}};
  if(kind==='lease_token') return {req:{headers:{}},body:{conversation_id:CONV,lease_token:token}};
  if(kind==='lease') return {req:{headers:{}},body:{conversation_id:CONV,lease:{token}}};
  if(kind==='supervisor_lease') return {req:{headers:{}},body:{conversation_id:CONV,supervisor_lease:{lease_token:token}}};
  return {req:{headers:{}},body:{conversation_id:CONV,supervisor_leases:[{token}]}};
}
async function admit(s,user=supervisor){return routes.admitFromRequest(s.req,user,{action:'guest_message_send',body:s.body,step:'send'});}
async function matrix(){
  incident={id:INCIDENT,status:'open',conversation_id:CONV,staff_user_id:supervisor.staff_user_id,lease_token:TOKEN,lease_until:new Date(Date.now()+60000).toISOString()};
  for(const k of ['header','lease_token','lease','supervisor_lease','supervisor_leases']) assert.strictEqual((await admit(shape(k))).ok,true,k);
  let s=shape('lease'); s.req.headers['x-supervisor-lease-token']=TOKEN; assert.strictEqual((await admit(s)).ok,true,'matching header/body');
  s=shape('lease'); s.req.headers['x-supervisor-lease-token']='conflict'; assert.strictEqual((await admit(s)).error,'lease_token_conflict');
  assert.strictEqual((await admit({req:{headers:{}},body:{conversation_id:CONV}})).error,'lease_token_required');
  assert.strictEqual((await admit(shape('header','wrong'))).error,'claim_expired');
  assert.strictEqual((await admit({...shape('header'),body:{conversation_id:WRONG}})).error,'admission_facts_required');
  incident={...incident,lease_until:new Date(Date.now()-1000).toISOString()}; assert.strictEqual((await admit(shape('header'))).error,'claim_expired');
  const ordinary=await admit({req:{headers:{}},body:{conversation_id:CONV}},human); assert.deepStrictEqual({ok:ordinary.ok,skipped:ordinary.skipped},{ok:true,skipped:'not_supervisor'});
}
async function sendReplyProof(){
  const captures=[]; let evaluated=0;
  const inbox=createInboxRoutes({
    sendJSON(_r,status,body){return {status,body};}, send400(_r,error){return {status:400,body:{error}};},
    readBody:async req=>JSON.stringify(req.body), appendAuditLog(){}, SQL_INJECT_RE:/$a/,
    withPgClient:async fn=>fn({query:async()=>({rows:[{conversation_id:CONV,phone:'+1234',channel:'whatsapp'}]})}),
    evaluateGuestReplySendRouteWithPause:async()=>{evaluated++; throw new Error('proof_stop_after_gate');},
    isSupervisorAccount, admitFromRequest:async(req,user,extra)=>{captures.push({req,user,extra});return {ok:false,error:'proof_stop',status:409};}
  });
  const base={client_slug:'wolfhouse-somo',conversation_id:CONV,to:'+1234',message_text:'hello'};
  for(const [kind,claim] of [['header',{}],['lease_token',{lease_token:TOKEN}],['lease',{lease:{token:TOKEN}}],['supervisor_lease',{supervisor_lease:{token:TOKEN}}],['supervisor_leases',{supervisor_leases:[{token:TOKEN}]}]]){
    const req={headers:kind==='header'?{'x-supervisor-lease-token':TOKEN}:{},body:{...base,...claim}};
    await inbox.handleInboxSendReply(req,{},supervisor);
    const c=captures.at(-1); assert.strictEqual(c.extra.body.conversation_id,CONV); assert.strictEqual(c.extra.body.client_slug,'wolfhouse-somo');
    if(kind!=='header') assert.deepStrictEqual(c.extra.body[kind],claim[kind],kind);
  }
  const conflict={headers:{'x-supervisor-lease-token':'other'},body:{...base,lease_token:TOKEN}}; await inbox.handleInboxSendReply(conflict,{},supervisor);
  assert.strictEqual(captures.at(-1).req.headers['x-supervisor-lease-token'],'other'); assert.strictEqual(captures.at(-1).extra.body.lease_token,TOKEN);
  const before=captures.length; await inbox.handleInboxSendReply({headers:{},body:base},{},human); assert.strictEqual(captures.length,before,'ordinary human skips supervisor gate'); assert.strictEqual(evaluated,1,'ordinary human reaches established send owner');
}
(async()=>{await matrix();await sendReplyProof();console.log('verify:slice1c-lease-send-reply PASSED');})().catch(e=>{console.error(e);process.exit(1);});
