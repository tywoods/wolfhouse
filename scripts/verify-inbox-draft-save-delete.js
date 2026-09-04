#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const wa = require('./lib/staff-inbox-whatsapp-draft-routes');
const email = require('./lib/staff-email-inbox-routes');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const wai = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-whatsapp-draft.js'), 'utf8');
const en = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const es = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es.js'), 'utf8');
const U='11111111-1111-4111-8111-111111111111';
const C='22222222-2222-4222-8222-222222222222';
const A='abcdefab-cdef-4abc-8def-abcdefabcdef';
const REPLACEMENT='33333333-3333-4333-8333-333333333333';
const user={staff_user_id:U,client_id:U,role:'operator',client_slug:'sunset'};
function response(){return {status:null,body:null};}
function sendJSON(res,status,body){res.status=status;res.body=body;return body;}
function makeRoutes(withPgClient){return wa.createWhatsAppDraftRoutes({sendJSON,send400:(res)=>sendJSON(res,400,{success:false,error:'invalid_request'}),withPgClient,assertStaffClientAccess:()=>true,DEFAULT_CLIENT:'sunset',SQL_INJECT_RE:/[;'"\\]/,evaluateGuestReplySendRouteWithPause:async()=>({}) ,runtimeEnv:{STAFF_PORTAL_ORIGIN:'https://staff.example'}});}
async function invoke(query,headers,withPgClient,actor=user){const res=response();await makeRoutes(withPgClient).handleWhatsAppDraftDelete(query,{headers},res,actor);return res;}
async function waOriginCase(name,headers){let db=0;const res=await invoke({conversation_id:C,approval_id:A},headers,async()=>{db++;throw new Error('DB touched');});assert.equal(res.status,403,name);assert.equal(db,0,name+' zero DB');}
async function emailOriginCase(name,headers){let db=0;const routes=email.createStaffEmailInboxRoutes({sendJSON,withPgClient:async()=>{db++;throw new Error('DB touched');},runtimeEnv:{EMAIL_STAFF_EMAIL_DRAFTS_ENABLED:'true',STAFF_PORTAL_ORIGIN:'https://staff.example'}});const res=response();await routes.handleDeleteDraft({conversation_id:C,approval_id:A},{headers},res,user);assert.equal(res.status,403,name);assert.equal(db,0,name+' zero DB');}
function ownedRow(){return {conversation_id:C,client_id:U,channel:'whatsapp',phone:'+15555550123'};}
async function transactionCase({name,resolveRows=[ownedRow()],deleteRows=[],throwDelete=false}){
  const calls=[];
  const pg={query:async(sql,params)=>{calls.push({sql,params});if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[]};if(sql===wa.SQL_RESOLVE_FOR_UPDATE)return {rows:resolveRows};if(sql===wa.SQL_DELETE_PENDING){if(throwDelete)throw new Error('delete boom');return {rows:deleteRows};}throw new Error('unexpected SQL '+sql);}};
  const res=await invoke({conversation_id:C,approval_id:A},{origin:'https://staff.example'},async fn=>fn(pg));
  return {name,res,calls};
}
(async()=>{
  assert.equal(wa.WHATSAPP_DRAFT_ROUTE_TABLE.find(r=>r.method==='DELETE').path,wa.WHATSAPP_DRAFT_PATH);
  assert.match(wa.SQL_DELETE_PENDING,/client_id = \$1::uuid/);assert.match(wa.SQL_DELETE_PENDING,/conversation_id = \$2::uuid/);assert.match(wa.SQL_DELETE_PENDING,/id = \$3::uuid/);assert.match(wa.SQL_DELETE_PENDING,/channel = 'whatsapp'/);assert.match(wa.SQL_DELETE_PENDING,/status = 'pending'/);assert.doesNotMatch(wa.SQL_DELETE_PENDING,/status.*approved|status.*sent/);
  for(const [name,headers] of [['missing origin',{}],['foreign origin',{origin:'https://evil.example'}],['malformed origin',{origin:'%%%'}]]){await waOriginCase(name,headers);await emailOriginCase(name,headers);}
  for(const [name,query] of [['missing approval',{conversation_id:C}],['uppercase approval',{conversation_id:C,approval_id:A.toUpperCase()}],['malformed approval',{conversation_id:C,approval_id:'nope'}]]){let db=0;const res=await invoke(query,{origin:'https://staff.example'},async()=>{db++;});assert.equal(res.status,400,name);assert.equal(db,0,name+' before DB');}
  const ok=await transactionCase({name:'success',deleteRows:[{approval_id:A}]});assert.equal(ok.res.status,200);assert.deepEqual(ok.res.body,{success:true,conversation_id:C,channel:'whatsapp',deleted:true});assert.deepEqual(ok.calls.map(x=>x.sql),['BEGIN',wa.SQL_RESOLVE_FOR_UPDATE,wa.SQL_DELETE_PENDING,'COMMIT']);assert.deepEqual(ok.calls[2].params,[U,C,A]);
  const stale=await transactionCase({name:'stale replacement',deleteRows:[]});assert.deepEqual(stale.res.body,{success:true,conversation_id:C,channel:'whatsapp',deleted:false});assert.deepEqual(stale.calls[2].params,[U,C,A]);assert.notEqual(stale.calls[2].params[2],REPLACEMENT);assert.equal(stale.calls.at(-1).sql,'COMMIT');
  const denied=await transactionCase({name:'authority denied',resolveRows:[]});assert.equal(denied.res.status,404);assert.deepEqual(denied.calls.map(x=>x.sql),['BEGIN',wa.SQL_RESOLVE_FOR_UPDATE,'ROLLBACK']);
  const errored=await transactionCase({name:'delete error',throwDelete:true});assert.equal(errored.res.status,500);assert.equal(errored.calls.at(-1).sql,'ROLLBACK');
  assert.equal(email.EMAIL_DELETE_DRAFT_PATH,'/staff/inbox/email/draft');assert.match(email.SQL_DELETE_DRAFT,/approval_id=\$3::uuid/);
  assert.match(api,/handleWhatsAppDraftDelete\(parsed\.query, req, res/);assert.match(api,/handleDeleteDraft\(parsed\.query, req, res/);
  assert.match(ui,/approval_id='\+encodeURIComponent\(approval\)/);assert.match(ui,/EMAIL_DELETE_OK_KEYS/);assert.match(ui,/acceptEmailDeleteSuccess/);assert.match(ui,/accepted\.deleted===true&&ta\.value===exact&&st\.approvalId===approval/);
  assert.match(wai,/WHATSAPP_DELETE_OK_KEYS/);assert.match(wai,/acceptWhatsAppDeleteSuccess/);assert.match(wai,/approval_id='\+encodeURIComponent\(approval\)/);assert.match(wai,/whatsappDraftCanonicalUuid\(st\.approvalId\)/);assert.match(wai,/setWhatsAppComposerLocked\(targetEl,true\)/);assert.match(wai,/if \(st\.inFlight\)/);assert.match(wai,/accepted\.deleted===true&&ta\.value===exact&&st\.approvalId===approval/);assert.doesNotMatch(wai,/catch\([^)]*\).*ta\.value=(exact|text)/s);
  assert.match(en,/inbox\.detail\.reply\.saveDraft/);assert.match(en,/inbox\.detail\.reply\.deleteDraft/);assert.match(es,/inbox\.detail\.reply\.saveDraft/);assert.match(es,/inbox\.detail\.reply\.deleteDraft/);
  assert.match(wai,/mount\.hidden = true/);assert.match(wai,/mount\.innerHTML = ''/);assert.equal((ui.match(/id=\\?"btn-delete-draft\\?"/g)||[]).length>=1,true);assert.match(ui,/String\(ta\.value==null\?'':ta\.value\)/);
  assert.match(api,/#inbox-shell \.btn-email-approve-send,#inbox-shell \.btn-delete-draft\{/);assert.doesNotMatch(api,/(^|\n)\.btn-delete-draft(?=[:,{])/m);
  console.log('verify:inbox-draft-save-delete PASSED (executable WA origin/validation/transaction/exact CAS, DTO, UI authority, scoped CSS)');
})().catch(e=>{console.error(e);process.exit(1);});
