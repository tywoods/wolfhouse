#!/usr/bin/env node
'use strict';
const assert=require('assert');
const {createInboxViewRoutes}=require('./lib/staff-inbox-view-routes');
const {createInboxThreadCompositeRoutes}=require('./lib/staff-inbox-thread-composite');
const helpers=require('./lib/staff-inbox-helpers');
const LAB='11111111-1111-4111-8111-111111111111', TENANT='wolfhouse-somo';
const labRow={conversation_id:LAB,phone:'lab-phone',owner_lab:true,display_name:'Lab guest',channel:'whatsapp',last_activity:new Date().toISOString(),needs_human:false,needs_attention:false,status:'open',unread_count:0};
function sink(){const s={status:null,body:null};return {s,sendJSON(_r,status,body){s.status=status;s.body=body;return body;}};}
async function list(view){const out=sink();let executed=false;const routes=createInboxViewRoutes({sendJSON:out.sendJSON,send400(_r,e){throw Error(e);},assertStaffClientAccess:()=>true,appendAuditLog(){},DEFAULT_CLIENT:TENANT,SQL_INJECT_RE:/$a/,withPgClient:async fn=>fn({query:async(sql,params)=>{executed=typeof sql==='string'&&params[0]===TENANT;return {rows:view==='owner_lab'?[labRow]:[]};}})});await routes.handleInboxList({client:TENANT,view}, {}, {staff_user_id:'viewer'});assert.ok(executed,`${view} executes its production query with tenant binding`);return out.s;}
function composite(owned){const out=sink();const pg={async query(sql,params=[]){
 if(/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql.trim()))return {rows:[]};
 if(/FROM conversations c/i.test(sql)){if(owned&&params[0]===TENANT&&params[1]===LAB)return {rows:[{conversation_id:LAB,id:LAB,phone:labRow.phone,channel:'whatsapp',status:'open',metadata:{},client_slug:TENANT}]};return {rows:[]};}
 return {rows:[]};}};
 const routes=createInboxThreadCompositeRoutes({sendJSON:out.sendJSON,send400(_r,e){out.sendJSON({},400,{error:e});},send404(){return out.sendJSON({},404,{success:false,error:'Not found'});},assertStaffClientAccess:()=>true,appendAuditLog(){},withPgClient:async fn=>fn(pg),DEFAULT_CLIENT:TENANT,SQL_INJECT_RE:/$a/,resolveSunsetConversationScope:()=>({scoped:false,locationId:null,queryOpts:{}}),conversationDetailQueryParams:(c,id)=>[c,id],sanitizeConversationContextForInbox:helpers.sanitizeConversationContextForInbox,filterActiveInboxBookings:helpers.filterActiveInboxBookings,buildPausedStateResponse:helpers.buildPausedStateResponse,buildDefaultActivePauseResponse:helpers.buildDefaultActivePauseResponse});
 return routes.handleInboxThreadComposite(LAB,{client:TENANT},{},{staff_user_id:'viewer'}).then(()=>out.s);
}
(async()=>{const lab=await list('owner_lab');assert.strictEqual(lab.status,200);assert.deepStrictEqual(lab.body.rows.map(r=>r.conversation_id),[LAB]);for(const v of ['all','whatsapp'])assert.deepStrictEqual((await list(v)).body.rows,[],`${v} excludes Lab`);const id=lab.body.rows[0].conversation_id;assert.strictEqual(id,LAB);const opened=await composite(true);assert.strictEqual(opened.status,200,'discovered Lab id opens through actual composite owner');assert.strictEqual(opened.body.conversation_id,LAB);const wrong=await composite(false);assert.strictEqual(wrong.status,404,'wrong tenant/unowned id fails closed');console.log('verify:slice1c-lab-discovery-thread PASSED');})().catch(e=>{console.error(e);process.exit(1);});
