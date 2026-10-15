'use strict';
// Offline only: exact production AST slices, in-memory PGlite and hard-stop provider.
// Never imports Staff API, opens a DB/network connection, creates a real checkout,
// runs a booking owner, sends a message or writes outside this evidence directory.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const crypto=require('node:crypto'),cp=require('node:child_process');
const ROOT=path.resolve(process.argv[2]||process.cwd());
const {createRequire}=require('node:module'), req=createRequire(path.join(ROOT,'package.json'));
const acorn=req('acorn'),{PGlite}=req('@electric-sql/pglite');
let networkAttempts=0;function forbid(){networkAttempts++;throw Error('NETWORK_FORBIDDEN');}
global.fetch=forbid;for(const m of ['http','https']){require('node:'+m).request=forbid;require('node:'+m).get=forbid;}
require('node:net').connect=forbid;require('node:net').Socket.prototype.connect=forbid;
const SHA='68ed91fd179afe88405a82e4506b9e6f2ff53214', extracted=[], sources={}, observations=[];
function git(...args){return cp.execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim();}
function scope(extras={}){return vm.createContext({Buffer,URL,console,process:{env:{}},...extras});}
function load(file,names,ctx){
 const text=fs.readFileSync(path.join(ROOT,file),'utf8'),ast=acorn.parse(text,{ecmaVersion:'latest',sourceType:'script',locations:true});
 const blob=Buffer.from(text);
 sources[file]=crypto.createHash('sha256').update(text).digest('hex');
 for(const name of names){const n=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name||n.type==='VariableDeclaration'&&n.declarations.some(d=>d.id.name===name));assert(n,name);
  extracted.push({file,name,start:n.loc.start.line,end:n.loc.end.line});vm.runInContext(text.slice(n.start,n.end),ctx,{filename:file});}
}
const routes=scope(),policy=scope(),svc=scope({SUNSET_CLIENT_SLUG:'sunset'}),guest=scope(),staff=scope();
load('scripts/lib/booking-guests.js',['trimStr','normalizeBotBookingPaymentChoice','normalizeBookingGuestsInput','mapBotBookingCreateErrorToBlockedReason','splitCentsAcrossGuests','buildPerPersonBreakdown','insertBookingGuestsForBooking'],routes);
load('scripts/lib/staff-bot-v2-routes.js',['makeInMemoryBotReq','requirePortalAutomaticWriteAdmission','evaluateWolfhouseSimulatorEffectBudget','shouldRequireWolfhouseOfferIdentity','mapCreateFromPlanOfferBridge','wolfhouseSimulatorBlock','handleBotBookingCreateFromPlan','handleBotPaymentCreateStripeLink','handleBotCreateBalancePaymentLink','handleBotGuestPaymentCreateLink'],routes);
load('scripts/lib/staff-booking-portal-policy.js',['WOLFHOUSE_CLIENT_SLUG','SQL_WOLFHOUSE_AUTOMATIC_BOOKING_ADMISSION','deny','resolveWolfhouseAutomaticBookingAdmission'],policy);
load('scripts/lib/payment-uuid-callback-tenant-acl.js',['trimSlug','makeSilentAclRes','PAYMENT_TENANT_LOOKUP_SQL','PAYMENT_TENANT_LOOKUP_BOUND_SQL','gateBotPaymentUuidCallbackTenantAcl','gateStaffPaymentUuidCallbackTenantAcl'],routes);
load('scripts/lib/luna-front-desk-payment-link-service.js',['WOLFHOUSE_CLIENT_SLUG','PAYMENT_LINK_CHANNELS','PAYMENT_LINK_OPERATIONS','PAYMENT_LINK_LIFECYCLE','CLIENT_SUPPLIED_AMOUNT_FIELDS','fail','bookingStatusIsCancelled','assertTrustedTenant','rejectClientSuppliedAmounts','assertStripeRuntime','buildPaymentLinkCommand','parsePaymentMetadata','loadPaymentById','createPaymentLink','createDraftPaymentStripeLink'],svc);
for(const name of ['buildPaymentLinkCommand','createPaymentLink','PAYMENT_LINK_CHANNELS','PAYMENT_LINK_OPERATIONS'])routes[name]=vm.runInContext(name,svc);
load('scripts/lib/per-guest-checkout.js',['metadata','amountFor','tx','validUrl','reusableProviderSession','obsoleteProviderSession','blockedProviderSession','definitelyUnpaidObsoleteSession','LOCKED_GUEST_SQL','lockAndLoad','operationFromRow','sameIntent','assertGuestCollectionAllocated','assertTrustedGuestOwnsTarget','createSqlStore','providerParams','recoverProvider','expireIfOpen','run'],guest);
load('scripts/lib/staff-guest-payment-link-auth.js',['bindStaffGuestPaymentClient'],staff);
load('scripts/lib/staff-guest-payment-link-handler.js',['handleStaffGenerateGuestPaymentLink'],staff);
const C1='10000000-0000-4000-8000-000000000001',C2='10000000-0000-4000-8000-000000000002';
const B=[1,2,3].map(n=>'20000000-0000-4000-8000-00000000000'+n),G=[1,2,3].map(n=>'30000000-0000-4000-8000-00000000000'+n),P=[1,2,3].map(n=>'40000000-0000-4000-8000-00000000000'+n);
// Deliberately synthetic +999 identities, never sent anywhere.
const A='+'+[999,123,456,781].join(''),OTHER='+'+[999,123,456,782].join('');let db,trace=[],providerCalls=[],hook=null,ledgerBalances=[1000],providerFailure='definite';
const stripe={checkout:{sessions:{async create(params,options){providerCalls.push({method:'create',params,options});const e=Error('OFFLINE_PROVIDER_STOP');if(providerFailure==='definite'){e.providerBlocked=true;e.httpStatus=409;}else e.code='ECONNRESET';throw e;},async retrieve(){throw Error('UNEXPECTED_PROVIDER_RETRIEVE');},async expire(){throw Error('UNEXPECTED_PROVIDER_EXPIRE');}}}};
routes.require=name=>{if(name==='stripe')return ()=>stripe;if(name==='./per-guest-checkout')return {run:guest.run};throw Error('UNEXPECTED_IMPORT '+name);};
routes.collectPendingTransferEntries=()=>[];
function response(){return {status:null,body:null,writeHead(s){this.status=s;},end(b){this.body=JSON.parse(b);}};}
function sendJSON(res,status,body){res.writeHead(status);res.end(JSON.stringify(body));}
const readBody=async request=>{let raw='';for await(const chunk of request)raw+=chunk;return raw;};
const pg={async query(sql,params){const event={sql,params:params||[]};trace.push(event);try{const r=await db.query(sql,params);event.ok=true;if(hook)await hook(sql,params,r);return {...r,rowCount:r.affectedRows??r.rows.length};}catch(e){event.error={code:e.code,message:e.message};throw e;}}};
let poolReleases=[];pg.release=(discard)=>poolReleases.push({discard:discard===true});
const poolScope=scope({getPool:()=>({connect:async()=>pg})});
load('scripts/lib/pg-connect.js',['PG_CLIENT_DISCARD_REQUIRED','isPgClientDiscardRequired','withPgClient'],poolScope);
const common={sendJSON,send400:(r,e)=>sendJSON(r,400,{success:false,error:e}),readBody,appendAuditLog(){},withPgClient:poolScope.withPgClient,resolveAutomaticBookingAdmission:policy.resolveWolfhouseAutomaticBookingAdmission,
 DEFAULT_CLIENT:'wolfhouse-somo',STAFF_AUTH_REQUIRED:true,STAFF_ACTIONS_ENABLED:true,STRIPE_LINKS_ENABLED:true,STRIPE_SECRET_KEY:'sk_test_OFFLINE_NO_PROVIDER',PUBLIC_PAYMENT_BASE_URL:'',WOLFHOUSE_STRIPE_MODE:'test',
 stripeCheckoutRedirectUrlsConfigured:()=>true,stripeCheckoutSessionSuccessUrl:()=> 'https://invalid.test/success',stripeCheckoutSessionCancelUrl:()=> 'https://invalid.test/cancel',guestPaymentLinkObservability:(_p,url)=>({guest_payment_url:url}),
 loadBookingServiceRecords:async()=>({rows:[]}),listBookingTransfersForBooking:async()=>[],bookingStatusIsCancelled:svc.bookingStatusIsCancelled,
 // Deliberately bounded ledger adapters. Booking selector, ownership, lower single-payment service and guest coordinator are real.
 bookingLedgerBalanceFromRows:()=>({balance_due_cents:ledgerBalances.length>1?ledgerBalances.shift():ledgerBalances[0]}),ledgerActivePaymentLinkRow:rows=>rows.find(r=>r.checkout_url)||null,
 BOOKING_PAYMENTS_LEDGER_SQL:'SELECT p.id::text AS payment_id,p.status::text,p.expires_at,p.checkout_url,p.metadata FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN clients c ON c.id=b.client_id WHERE c.slug=$1 AND b.booking_code=$2',
 UUID_VALIDATE_RE:/^[0-9a-f-]{36}$/,SQL_INJECT_RE:null};
const wrapper=scope({...common,resolveWolfhouseAutomaticBookingAdmission:policy.resolveWolfhouseAutomaticBookingAdmission,
 _handleBotPaymentCreateStripeLink:routes.handleBotPaymentCreateStripeLink,_handleBotCreateBalancePaymentLink:routes.handleBotCreateBalancePaymentLink,_handleBotGuestPaymentCreateLink:routes.handleBotGuestPaymentCreateLink});
load('scripts/staff-query-api.js',['EDIT_PREVIEW_BOOKING_BY_ID_SQL','EDIT_PREVIEW_BOOKING_BY_CODE_SQL','handleBotPaymentCreateStripeLink','handleBotCreateBalancePaymentLink','handleBotGuestPaymentCreateLink'],wrapper);
common.EDIT_PREVIEW_BOOKING_BY_ID_SQL=vm.runInContext('EDIT_PREVIEW_BOOKING_BY_ID_SQL',wrapper);
const handlerNames=['handleBotPaymentCreateStripeLink','handleBotCreateBalancePaymentLink','handleBotGuestPaymentCreateLink'];
async function invoke(name,{index=0,headers={'x-luna-guest-phone':A},tenant='wolfhouse-somo',body={}}={}){
 const res=response(),request=routes.makeInMemoryBotReq({client_slug:tenant,booking_id:B[index],...body},headers,tenant);
 const args=[request,res,null,'bot_token'];if(name!==handlerNames[1])args.unshift(name===handlerNames[0]?P[index]:G[index]);
 await wrapper[name](...args);return {status:res.status,body:res.body};
}
async function reset(){hook=null;await db.exec('TRUNCATE payments,booking_guests,bookings,clients,conversations,bot_pause_states CASCADE');
 await db.query("INSERT INTO clients VALUES($1,'wolfhouse-somo','{\"inbox_channel_modes\":{\"whatsapp\":\"auto\"}}'),($2,'sunset','{}')",[C1,C2]);
 await db.query("INSERT INTO conversations VALUES('50000000-0000-4000-8000-000000000001',$1,$2,false)",[C1,A]);
 for(let i=0;i<3;i++){const client=i===2?C2:C1,phone=i===1?OTHER:A;
 await db.query('INSERT INTO bookings(id,client_id,booking_code,phone) VALUES($1,$2,$3,$4)',[B[i],client,'OFFLINE-'+i,phone]);
 const normalized=routes.normalizeBookingGuestsInput({guest_count:1,guest_name:'OFFLINE guest',phone});
 const breakdown=routes.buildPerPersonBreakdown({guest_count:1,package_code:'malibu',deposit_required_cents:500,line_items:[{code:'package',total_cents:1000}]},{guest_names:normalized.guests.map(g=>g.guest_name),payment_choice:'deposit'});
 const inserted=await routes.insertBookingGuestsForBooking(pg,{clientId:client,bookingId:B[i],guests:normalized.guests,perPersonBreakdown:breakdown,bedAssignments:[]});G[i]=inserted[0].booking_guest_id;
 await db.query("INSERT INTO payments(id,client_id,booking_id,status,amount_due_cents,checkout_url) VALUES($1,$2,$3,'checkout_created',1000,$4)",[P[i],client,B[i],'https://invalid.test/EXPLICIT-SYNTHETIC-LINK-'+i]);}
 trace=[];providerCalls=[];ledgerBalances=[1000];providerFailure='definite';
}
async function snapshot(){return {payments:(await db.query('SELECT id::text,booking_id::text,booking_guest_id::text,status,metadata FROM payments ORDER BY id')).rows,guests:(await db.query('SELECT id::text,payment_id::text,payment_status FROM booking_guests ORDER BY id')).rows};}
function record(name,response,extra={}){observations.push({case:name,response,trace:JSON.parse(JSON.stringify(trace)),providerBoundaryCalls:JSON.parse(JSON.stringify(providerCalls)),...extra});}
async function main(){
 db=new PGlite();await db.exec(`
 CREATE TYPE payment_record_status AS ENUM('draft','checkout_created','pending','paid','expired','cancelled','failed');CREATE TYPE payment_kind AS ENUM('deposit_only','full_amount');
 CREATE TABLE clients(id uuid PRIMARY KEY,slug text UNIQUE,settings jsonb);
 CREATE TABLE conversations(id uuid PRIMARY KEY,client_id uuid,phone text,needs_human boolean);
 CREATE TABLE bot_pause_states(client_slug text,conversation_id text,guest_phone text,paused boolean);
 CREATE TABLE bookings(id uuid PRIMARY KEY,client_id uuid REFERENCES clients(id),booking_code text,phone text,guest_name text DEFAULT 'OFFLINE',email text,guest_count integer DEFAULT 1,package_code text,check_in date,check_out date,status text DEFAULT 'confirmed',payment_status text DEFAULT 'unpaid',total_amount_cents integer DEFAULT 1000,amount_paid_cents integer DEFAULT 0,balance_due_cents integer DEFAULT 1000,deposit_required_cents integer DEFAULT 500,requested_room_type text,room_preference text,primary_room_code text,metadata jsonb DEFAULT '{}');
 CREATE TABLE payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),client_id uuid REFERENCES clients(id),booking_id uuid REFERENCES bookings(id),status payment_record_status DEFAULT 'draft',payment_kind payment_kind DEFAULT 'full_amount',currency char(3) DEFAULT 'EUR',amount_due_cents integer NOT NULL,amount_paid_cents integer DEFAULT 0,stripe_checkout_session_id text,checkout_url text,expires_at timestamptz,metadata jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());
 CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=NOW();RETURN NEW;END $$;
 `);
 for(const file of ['database/migrations/024_booking_guests.sql','database/migrations/107_per_guest_checkout_authoritative_intent.sql']){const bytes=fs.readFileSync(path.join(ROOT,file));assert.equal(Buffer.compare(bytes,cp.execFileSync('git',['show',SHA+':'+file],{cwd:ROOT})),0);sources[file]=crypto.createHash('sha256').update(bytes).digest('hex');await db.exec(bytes.toString());}
 // Actual SQL engine validates corrected BEGIN/LOCK/COMMIT; Stripe disabled is safe next guard.
 for(const name of handlerNames){await reset();wrapper.STRIPE_LINKS_ENABLED=false;const r=await invoke(name);wrapper.STRIPE_LINKS_ENABLED=true;
 assert.equal(r.status,403);assert.equal(r.body.stripe_links_enabled,false);assert.deepEqual(trace.map(q=>q.sql).filter(q=>q==='BEGIN'||q.startsWith('LOCK TABLE')||q==='COMMIT'),['BEGIN','LOCK TABLE bot_pause_states IN SHARE MODE','COMMIT']);assert(trace.every(q=>q.ok));record('transaction_fixed_'+name,r);}
 // Production resolver and actual wrappers, no synthetic allow decisions.
 for(const name of handlerNames)for(const [label,sql,reason] of [
 ['off',"UPDATE clients SET settings='{\"inbox_channel_modes\":{\"whatsapp\":\"off\"}}' WHERE slug='wolfhouse-somo'",'booking_channel_off'],
 ['draft',"UPDATE clients SET settings='{\"inbox_channel_modes\":{\"whatsapp\":\"draft\"}}' WHERE slug='wolfhouse-somo'",'booking_channel_draft'],
 ['global_pause',"INSERT INTO bot_pause_states VALUES('wolfhouse-somo','__luna_global_pause__',null,true)",'booking_global_paused'],
 ['conversation_pause',`INSERT INTO bot_pause_states VALUES('wolfhouse-somo','50000000-0000-4000-8000-000000000001','${A}',true)`,'booking_conversation_paused'],
 ['needs_human','UPDATE conversations SET needs_human=true','booking_needs_human']]){
 await reset();await db.exec(sql);const before=await snapshot(),r=await invoke(name);assert.equal(r.status,403);assert.equal(r.body.reason_code,reason);assert.equal(r.body.do_not_escalate,true);assert.equal(r.body.staff_review_needed,false);assert.equal(providerCalls.length,0);assert.deepEqual(await snapshot(),before);record('policy_'+label+'_'+name,r);}
 // Real SQL lookup fault: resolver catches the error, helper returns typed unavailable.
 for(const name of handlerNames){await reset();await db.exec('ALTER TABLE conversations RENAME TO conversations_offline_missing');const r=await invoke(name);await db.exec('ALTER TABLE conversations_offline_missing RENAME TO conversations');assert.equal(r.status,503);assert.equal(r.body.reason_code,'booking_policy_unavailable');assert.equal(r.body.policy_source,'portal_policy_lookup');assert.equal(providerCalls.length,0);record('policy_real_sql_lookup_failure_'+name,r);}
 // Caller/target matrix through actual Staff wrappers, production admission and SQL target loads.
 for(const name of handlerNames)for(const variant of ['same_owner','foreign_owner','foreign_tenant','missing_identity','missing_tenant']){
 await reset();const before=await snapshot(),options={index:variant==='foreign_owner'?1:variant==='foreign_tenant'?2:0};if(variant==='missing_identity')options.headers={};if(variant==='missing_tenant')options.tenant=null;
 const r=await invoke(name,options);const positive=variant==='same_owner';
 assert.equal(r.status,positive?(name===handlerNames[2]?409:200):variant.startsWith('missing')?403:name===handlerNames[2]&&variant==='foreign_owner'?403:404,JSON.stringify(r));
 assert.equal(providerCalls.length,positive&&name===handlerNames[2]?1:0);if(!(positive&&name===handlerNames[2]))assert.deepEqual(await snapshot(),before);
 if(!positive)assert(!JSON.stringify(r.body).includes('SYNTHETIC-LINK'));
 record('identity_'+variant+'_'+name,r,{after:await snapshot()});}
 // REAL metadata writer, group members: no synthetic phone fields to manufacture success.
 await reset();await db.query('DELETE FROM booking_guests WHERE booking_id=$1',[B[0]]);
 const normalized=routes.normalizeBookingGuestsInput({guest_count:2,guest_name:'OFFLINE primary',phone:A,guests:[{name:'OFFLINE primary',phone:A},{name:'OFFLINE companion'}]});
 const breakdown=routes.buildPerPersonBreakdown({guest_count:2,package_code:'malibu',deposit_required_cents:500,line_items:[{code:'package',total_cents:2000}]},{guest_names:normalized.guests.map(g=>g.guest_name),payment_choice:'deposit'});
 const inserted=await routes.insertBookingGuestsForBooking(pg,{clientId:C1,bookingId:B[0],guests:normalized.guests,perPersonBreakdown:breakdown,bedAssignments:[]});
 const realMetadata=(await db.query('SELECT guest_number,metadata FROM booking_guests WHERE booking_id=$1 ORDER BY guest_number',[B[0]])).rows;
 assert(realMetadata.every(r=>!r.metadata.phone&&!r.metadata.guest_phone&&!r.metadata.contact_phone));
 for(const row of inserted){G[0]=row.booking_guest_id;trace=[];const r=await invoke(handlerNames[2]);assert.equal(r.status,409);assert.equal(providerCalls.length,row===inserted[0]?1:2);record('FIX_real_writer_group_guest_'+row.guest_number,r,{normalized,realMetadata});}
 // Payment UUIDs allocated to real-writer guests accept the approved booking contact.
 await db.query('UPDATE payments SET booking_guest_id=$2 WHERE id=$1',[P[0],G[0]]);trace=[];
 const allocated=await invoke(handlerNames[0]);assert.equal(allocated.status,200);assert.equal(providerCalls.length,2);record('FIX_real_writer_guest_allocated_payment_UUID',allocated,{realMetadata});
 // Explicit guest metadata remains authoritative; booking contact A cannot act for explicit guest B.
 for(const alias of ['phone','guest_phone','contact_phone']){await reset();await db.query('UPDATE booking_guests SET metadata=$2::jsonb WHERE id=$1',[G[0],JSON.stringify({[alias]:OTHER})]);await db.query('UPDATE payments SET booking_guest_id=$2 WHERE id=$1',[P[0],G[0]]);const before=providerCalls.length;
 const paymentDenied=await invoke(handlerNames[0]);assert.equal(paymentDenied.status,403);assert.equal(providerCalls.length,before);record('FIX_explicit_guest_payment_owner_'+alias,paymentDenied);
 const guestDenied=await invoke(handlerNames[2]);assert.equal(guestDenied.status,403);assert.equal(providerCalls.length,before);record('FIX_explicit_guest_prepare_owner_'+alias,guestDenied);}
 // Inline bridge -> actual Staff wrapper -> actual handler -> SQL admission/coordinator.
 for(const mode of ['auto','off','unbound']){
 await reset();let childBinding,childHeader,childResult;
 const out=response();await routes.handleBotBookingCreateFromPlan(routes.makeInMemoryBotReq({client_slug:'wolfhouse-somo',payment_choice:'per_guest',guests:[{name:'OFFLINE'}]},{'x-luna-guest-phone':A},'wolfhouse-somo'),out,null,'bot_token',{
 ...common,boundClientSlug:mode==='unbound'?null:'wolfhouse-somo',
 async handleBotBookingCreate(_req,res){if(mode==='off')await db.exec("UPDATE clients SET settings='{\"inbox_channel_modes\":{\"whatsapp\":\"off\"}}' WHERE slug='wolfhouse-somo'");sendJSON(res,201,{success:true,write_performed:true,booking_id:B[0],booking_guests:[{booking_guest_id:G[0]}]});},
 async handleBotGuestPaymentCreateLink(id,request,res,user,auth){childBinding=request._botBoundClientSlug;childHeader=request.headers['x-luna-guest-phone'];const original=res.end;res.end=function(b){childResult=JSON.parse(b);original.call(this,b);};return wrapper.handleBotGuestPaymentCreateLink(id,request,res,user,auth);}});
 assert.equal(childHeader,A);assert.equal(childBinding,mode==='unbound'?null:'wolfhouse-somo');assert.equal(out.status,201);assert.equal(out.body.write_performed,true);if(mode==='auto'){assert.equal(childResult.error,'payment_processing_refresh_required');assert.equal(providerCalls.length,1);}else assert.equal(providerCalls.length,0);
 if(mode==='off'){assert.equal(childResult.reason_code,'booking_channel_off');assert(trace.some(q=>q.sql.startsWith('LOCK TABLE')));}if(mode==='unbound'){assert.equal(childResult.reason_code,'booking_context_unbound');assert.equal(trace.length,0);}
 record('inline_child_'+mode,{status:out.status,body:out.body},{childBinding,childHeader,childResult,limit:'Synthetic create receipt only: NO booking acceptance/create owner executed.'});}
 // Old Off-after-preflight defect is corrected: actual final owner rejects before mutation.
 for(const name of handlerNames){await reset();if(name!==handlerNames[2])await db.query("UPDATE payments SET status='draft',checkout_url=null WHERE id=$1",[P[0]]);
 const before=await snapshot();let revoked=false;hook=async sql=>{if(sql==='COMMIT'&&!revoked){revoked=true;await db.exec("UPDATE clients SET settings='{\"inbox_channel_modes\":{\"whatsapp\":\"off\"}}' WHERE slug='wolfhouse-somo'");trace.push({event:'fixture_Off_committed_after_preflight'});}};
 const r=await invoke(name);hook=null;assert(revoked);assert.equal(r.status,403);assert.equal(r.body.reason_code,'booking_channel_off');assert.equal(providerCalls.length,0);assert.deepEqual(await snapshot(),before);record('FIX_Off_after_preflight_'+name,r,{after:await snapshot()});}
 // Direct final single-payment owner must see Off even after the added second route preflight.
 await reset();await db.query("UPDATE payments SET status='draft',checkout_url=null WHERE id=$1",[P[0]]);
 let finalCommits=0;hook=async sql=>{if(sql==='COMMIT'&&++finalCommits===2)await db.exec("UPDATE clients SET settings='{\"inbox_channel_modes\":{\"whatsapp\":\"off\"}}' WHERE slug='wolfhouse-somo'");};
 const finalDenied=await invoke(handlerNames[0]);hook=null;assert.equal(finalDenied.status,403);assert.equal(finalDenied.body.reason_code,'booking_channel_off');assert.equal(providerCalls.length,0);assert.equal(trace.filter(q=>q.sql==='LOCK TABLE bot_pause_states IN SHARE MODE').length,3);assert(trace.some(q=>q.sql==='ROLLBACK'));record('FIX_Off_at_actual_single_payment_owner',finalDenied);
 // Allow an already-committed authoritative intent to precede Off; provider is throw-only.
 for(const name of handlerNames.slice(0,2)){await reset();await db.query("UPDATE payments SET status='draft',checkout_url=null WHERE id=$1",[P[0]]);
 let commits=0,receiptAtOff;hook=async sql=>{if(sql==='COMMIT'&&++commits===(name===handlerNames[0]?3:2)){receiptAtOff=await snapshot();await db.exec("UPDATE clients SET settings='{\"inbox_channel_modes\":{\"whatsapp\":\"off\"}}' WHERE slug='wolfhouse-somo'");trace.push({event:'fixture_Off_after_final_intent_COMMIT'});}};
 const r=await invoke(name);hook=null;assert(receiptAtOff);assert.equal(providerCalls.length,1);assert.equal(r.status,500);
 if(name===handlerNames[0]){assert(receiptAtOff.payments.find(p=>p.id===P[0]).metadata.automatic_admission_receipt);assert.equal(r.body.no_db_write,false);assert.equal(r.body.write_performed,true);}else assert.equal(receiptAtOff.payments.length,4);
 record('ORDER_intent_before_Off_'+name,r,{receiptAtOff,after:await snapshot(),limit:'Already admitted intent precedes Off; NOT a revocation-bypass finding.'});}
 // Single-payment owner rebinds after contact reassignment and refuses the former contact.
 await reset();let reassigned=false;hook=async sql=>{if(sql.includes('b.phone AS booking_phone')&&sql.includes('FROM payments p')&&!reassigned){reassigned=true;await db.query('UPDATE bookings SET phone=$2 WHERE id=$1',[B[0],OTHER]);trace.push({event:'fixture_contact_reassigned_after_owner_SELECT'});}};
 const staleOwner=await invoke(handlerNames[0]);hook=null;assert(reassigned);assert.equal(staleOwner.status,403);assert.equal(staleOwner.body.reason_code,'payment_target_guest_mismatch');assert.equal(providerCalls.length,0);assert.equal((await db.query('SELECT phone FROM bookings WHERE id=$1',[B[0]])).rows[0].phone,OTHER);record('FIX_single_payment_stale_route_owner_check',staleOwner,{persistedOwner:OTHER});
 // Non-Wolfhouse bot missing identity is not manual, but shared checkout treats undefined as manual.
 await reset();const otherMissing=await invoke(handlerNames[2],{index:2,tenant:'sunset',headers:{}});assert.equal(otherMissing.status,409);assert.equal(providerCalls.length,1);record('BUG_non_wolfhouse_bot_missing_identity',otherMissing,{after:await snapshot()});
 await reset();const otherForeign=await invoke(handlerNames[2],{index:2,tenant:'sunset',headers:{'x-luna-guest-phone':OTHER}});assert.equal(otherForeign.status,403);assert.equal(providerCalls.length,0);record('non_wolfhouse_bot_foreign_identity_denied_control',otherForeign);
 // Staff delegate: normal authenticated manual path must ignore automatic Off/missing caller identity, retain tenant/body/provider fences.
 for(const variant of ['normal_off','foreign_tenant_acl','foreign_target','body_tenant_mismatch','stripe_off','full_share_forbidden']){
 await reset();await db.exec("UPDATE clients SET settings='{\"inbox_channel_modes\":{\"whatsapp\":\"off\"}}' WHERE slug='wolfhouse-somo'");let aclCalls=0;
 const r=response(),request=routes.makeInMemoryBotReq({booking_guest_id:variant==='foreign_target'?G[2]:G[0],client_slug:variant==='body_tenant_mismatch'?'sunset':'wolfhouse-somo',payment_target:variant==='full_share_forbidden'?'full_share':'deposit'},{});request.url='/staff/bookings/generate-guest-payment-link?client=wolfhouse-somo';
 await staff.handleStaffGenerateGuestPaymentLink(request,r,{staff_user_id:'OFFLINE-STAFF'},{...common,assertStaffClientAccess(_u,_c,res){aclCalls++;if(variant==='foreign_tenant_acl'){sendJSON(res,403,{success:false,error:'client_access_denied'});return false;}return true;},delegatedHandler:routes.handleBotGuestPaymentCreateLink,delegatedContext:{...common,STRIPE_LINKS_ENABLED:variant!=='stripe_off'}});
 assert.equal(aclCalls,1);assert.equal(r.status,variant==='normal_off'?409:variant==='full_share_forbidden'?400:variant==='foreign_target'?404:403);assert.equal(providerCalls.length,variant==='normal_off'?1:0);assert(!trace.some(q=>q.sql.startsWith('LOCK TABLE')));record('manual_'+variant,{status:r.status,body:r.body},{aclCalls,limit:'Real manual binder/delegator/coordinator; authenticated principal and canonical ACL decision are fixtures, not HTTP authentication proof.'});}
 // Manual single-payment ACL gate no guest phone requirement, and still compares tenant ACL.
 for(const allowed of [true,false]){await reset();let aclCalls=0;const gate=await routes.gateStaffPaymentUuidCallbackTenantAcl({paymentId:P[0],withPgClient:common.withPgClient,user:{staff_user_id:'OFFLINE'},assertStaffClientAccess(_u,slug){aclCalls++;assert.equal(slug,'wolfhouse-somo');return allowed;}});assert.equal(gate.ok,allowed);assert.equal(aclCalls,1);record('manual_payment_acl_'+allowed,gate);}
 // Actual finalizer accepts the approved booking contact used by the real writer.
 await reset();const prepStore=guest.createSqlStore(common.withPgClient,G[0],'wolfhouse-somo','OFFLINE',undefined);const prepared=await prepStore.prepare('deposit');trace=[];
 const finalStore=guest.createSqlStore(common.withPgClient,G[0],'wolfhouse-somo','OFFLINE',A);
 await finalStore.finalize(prepared.operation,{},'deposit',prepared.amount);
 // Real SQL exceptions after final policy admission roll back and leave the pooled client reusable.
 for(const fault of ['receipt_update','payment_lookup']){await reset();await db.query("UPDATE payments SET status='draft',checkout_url=null WHERE id=$1",[P[0]]);
 if(fault==='receipt_update')await db.exec(`CREATE FUNCTION offline_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'OFFLINE_RECEIPT_SQL_FAILURE'; END $$; CREATE TRIGGER offline_fail_receipt BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION offline_fail_receipt();`);
 let locks=0;hook=async sql=>{if(fault==='payment_lookup'&&sql==='LOCK TABLE bot_pause_states IN SHARE MODE'&&++locks===3)await db.exec('ALTER TABLE booking_guests RENAME TO booking_guests_offline_missing');};
 const r=await invoke(handlerNames[0]);hook=null;assert.equal(r.status,500);assert.equal(providerCalls.length,0);assert(trace.some(q=>q.sql==='ROLLBACK'));
 const nextBorrower=await common.withPgClient(p=>p.query('SELECT 1 AS n'));assert.equal(nextBorrower.rows[0].n,1);assert.equal(poolReleases.at(-1).discard,false);record('FIX_rollback_'+fault,r,{nextBorrowerQuery:nextBorrower.rows[0],actualPoolWrapperLastRelease:poolReleases.at(-1)});
 if(fault==='receipt_update')await db.exec('DROP TRIGGER offline_fail_receipt ON payments;DROP FUNCTION offline_fail_receipt();');}
 // Balance owner is rebound after the detached snapshot for both reuse and draft creation.
 for(const mode of ['reuse','new_intent']){await reset();if(mode==='new_intent')await db.query("UPDATE payments SET status='draft',checkout_url=null WHERE id=$1",[P[0]]);
 let changed=false;hook=async sql=>{if(sql===common.EDIT_PREVIEW_BOOKING_BY_ID_SQL&&!changed){changed=true;await db.query('UPDATE bookings SET phone=$2 WHERE id=$1',[B[0],OTHER]);trace.push({event:'fixture_contact_reassigned_after_unlocked_booking_snapshot'});}};
 const r=await invoke(handlerNames[1]);hook=null;assert(changed);assert.equal(r.status,404);assert.equal(providerCalls.length,0);assert.equal((await db.query('SELECT phone FROM bookings WHERE id=$1',[B[0]])).rows[0].phone,OTHER);
 assert(!JSON.stringify(r.body).includes('EXPLICIT-SYNTHETIC-LINK'));assert.equal((await snapshot()).payments.length,3);
 record('FIX_balance_stale_owner_'+mode,r,{persistedOwner:OTHER,after:await snapshot(),limit:'Committed sequential interleaving before final intent transaction; not multi-client PostgreSQL contention.'});}
 // Existing-link disclosure returns the freshly validated amount when link and ledger move together.
 await reset();ledgerBalances=[1000,500];let amountMoved=false;hook=async sql=>{if(sql.includes('FOR UPDATE OF b')&&!amountMoved){amountMoved=true;await db.query('UPDATE payments SET amount_due_cents=500 WHERE id=$1',[P[0]]);}};
 const movedAmountLink=await invoke(handlerNames[1]);hook=null;assert(amountMoved);assert.equal(movedAmountLink.status,200);assert.equal(movedAmountLink.body.amount_due_cents,500);assert.equal(movedAmountLink.body.balance_due_cents,500);record('FIX_balance_existing_link_fresh_response_amount',movedAmountLink);
 // Existing-link disclosure revalidates that the link still matches the locked fresh balance.
 await reset();ledgerBalances=[1000,500];const staleAmountLink=await invoke(handlerNames[1]);assert.equal(staleAmountLink.status,404);assert.equal(providerCalls.length,0);assert(!JSON.stringify(staleAmountLink.body).includes('EXPLICIT-SYNTHETIC-LINK'));record('FIX_balance_existing_link_fresh_amount',staleAmountLink,{persistedLinkAmount:1000,freshBalance:500});
 // The booking lock is also the serialization point for a fresh ledger amount.
 await reset();await db.query("UPDATE payments SET status='draft',checkout_url=null WHERE id=$1",[P[0]]);ledgerBalances=[1000,500];
 const freshBalance=await invoke(handlerNames[1]);assert.equal(freshBalance.status,500);assert.equal(providerCalls.length,1);assert.equal(providerCalls[0].params.line_items[0].price_data.unit_amount,500);
 const freshDraft=(await db.query("SELECT amount_due_cents,metadata FROM payments WHERE metadata->>'source'='luna_bot_balance_payment_link'")).rows[0];assert.equal(freshDraft.amount_due_cents,500);assert.equal(freshDraft.metadata.amount_due_cents,500);record('FIX_balance_recomputed_under_booking_lock',freshBalance,{freshDraft});
 // A request that committed the same local intent while this request waited wins; no second provider call.
 await reset();await db.query("UPDATE payments SET status='draft',checkout_url=null WHERE id=$1",[P[0]]);let injected=false;
 hook=async sql=>{if(sql.includes('FOR UPDATE OF b')&&!injected){injected=true;await db.query("INSERT INTO payments(id,client_id,booking_id,status,amount_due_cents,metadata) VALUES('40000000-0000-4000-8000-000000000099',$1,$2,'draft',1000,$3::jsonb)",[C1,B[0],JSON.stringify({source:'luna_bot_balance_payment_link',idempotency_key:`luna-bot-balance:${B[0]}:1000`})]);}};
 const concurrent=await invoke(handlerNames[1]);hook=null;assert(injected);assert.equal(concurrent.status,409);assert.equal(concurrent.body.error,'payment_link_pending');assert.equal(providerCalls.length,0);assert.equal((await snapshot()).payments.length,3);record('FIX_balance_same_key_rechecked_under_booking_lock',concurrent,{after:await snapshot()});
 // Terminal same-key history is replaceable and cannot masquerade as a live pending intent.
 for(const status of ['failed','expired','cancelled']){await reset();await db.query('UPDATE payments SET status=$2::payment_record_status,checkout_url=null,metadata=$3::jsonb WHERE id=$1',[P[0],status,JSON.stringify({idempotency_key:`luna-bot-balance:${B[0]}:1000`,provider_create_failed:status==='failed'})]);
 const recovered=await invoke(handlerNames[1]);assert.equal(recovered.status,500);assert.equal(providerCalls.length,1);assert.equal(providerCalls[0].options.idempotencyKey,`luna-bot-balance:${B[0]}:1000:${(await db.query("SELECT id::text FROM payments WHERE metadata->>'source'='luna_bot_balance_payment_link' ORDER BY created_at DESC LIMIT 1")).rows[0].id}`);const rows=(await db.query("SELECT status,metadata FROM payments WHERE booking_id=$1 ORDER BY created_at,id",[B[0]])).rows;assert(rows.some(row=>row.metadata&&row.metadata.source==='luna_bot_balance_payment_link'));record('FIX_balance_terminal_same_key_'+status,recovered,{rows});}
 await reset();await db.query("UPDATE payments SET status='checkout_created',checkout_url=null,expires_at=now()-interval '1 hour',metadata=$2::jsonb WHERE id=$1",[P[0],JSON.stringify({idempotency_key:`luna-bot-balance:${B[0]}:1000`})]);const elapsedRecovered=await invoke(handlerNames[1]);assert.equal(elapsedRecovered.status,500);assert.equal(providerCalls.length,1);record('FIX_balance_elapsed_same_key_checkout',elapsedRecovered);
 // The route's own definite failure must become replaceable on the next request.
 await reset();await db.query('DELETE FROM payments WHERE booking_id=$1',[B[0]]);const definiteFirst=await invoke(handlerNames[1]);assert.equal(definiteFirst.status,500);assert.equal(definiteFirst.body.no_checkout_created,true);let routeFailed=(await db.query("SELECT id::text,status::text,metadata FROM payments WHERE booking_id=$1 ORDER BY created_at,id",[B[0]])).rows;assert.equal(routeFailed.length,1);assert.equal(routeFailed[0].status,'failed');assert.equal(routeFailed[0].metadata.provider_create_failed,true);const firstProviderKey=providerCalls[0].options.idempotencyKey;const definiteRetry=await invoke(handlerNames[1]);assert.equal(definiteRetry.status,500);assert.equal(providerCalls.length,2);routeFailed=(await db.query("SELECT id::text,status::text,metadata FROM payments WHERE booking_id=$1 ORDER BY created_at,id",[B[0]])).rows;assert.equal(routeFailed.length,2);assert(routeFailed.every(row=>row.status==='failed'&&row.metadata.provider_create_failed===true));assert.notEqual(providerCalls[1].options.idempotencyKey,firstProviderKey);record('FIX_balance_route_failed_then_retry',definiteRetry,{routeFailed});
 // Ambiguous provider outcomes retain one recoverable draft and block fan-out.
 await reset();await db.query('DELETE FROM payments WHERE booking_id=$1',[B[0]]);providerFailure='uncertain';const uncertainFirst=await invoke(handlerNames[1]);assert.equal(uncertainFirst.status,500);assert.equal(uncertainFirst.body.no_checkout_created,false);assert.equal(uncertainFirst.body.provider_outcome_uncertain,true);assert.equal(uncertainFirst.body.reconciliation_required,true);assert.equal(providerCalls.length,1);const uncertainRows=(await db.query('SELECT status::text,metadata FROM payments WHERE booking_id=$1',[B[0]])).rows;assert.equal(uncertainRows.length,1);assert.equal(uncertainRows[0].status,'draft');assert.equal(uncertainRows[0].metadata.provider_outcome_uncertain,true);
 for(const changedAmount of [500,1500]){await db.query('UPDATE bookings SET total_amount_cents=$2,balance_due_cents=$2 WHERE id=$1',[B[0],changedAmount]);ledgerBalances=[changedAmount];const changedRetry=await invoke(handlerNames[1]);assert.equal(changedRetry.status,409);assert.equal(providerCalls.length,1);assert.equal((await db.query('SELECT count(*)::int AS n FROM payments WHERE booking_id=$1',[B[0]])).rows[0].n,1);record('FIX_balance_uncertain_changed_amount_'+changedAmount,changedRetry);}
 await db.query('UPDATE bookings SET total_amount_cents=1000,balance_due_cents=1000 WHERE id=$1',[B[0]]);ledgerBalances=[1000];const uncertainRetry=await invoke(handlerNames[1]);assert.equal(uncertainRetry.status,409);assert.equal(providerCalls.length,1);record('FIX_balance_uncertain_provider_single_intent',uncertainRetry,{uncertainRows});
 assert.equal(networkAttempts,0);const candidateHead=git('rev-parse','HEAD');await db.close();
 console.log(JSON.stringify({head:candidateHead,base:SHA,networkAttempts,scope:'Exact production AST functions + real in-memory PGlite SQL; synthetic minimal schema/rows/ledger/ACL/booking receipt; inert provider STOP only. No live/real booking or checkout flow.',result:'PASS: all four Captain payment corrections and retained controls matched expectations; NOT product/live acceptance',caseCount:observations.length,sources,extracted,observations},null,2));
}
main().catch(async e=>{console.error(e);try{if(db)await db.close();}catch(_){}process.exitCode=1;});
