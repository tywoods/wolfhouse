#!/usr/bin/env node
'use strict';
// Actual HTTP router/handler and command builder; PG/provider/auth are declared doubles.
// No real sessions, SQL persistence, checkout creation or sockets. Service SQL proof is separate.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {buildPaymentLinkCommand,PAYMENT_LINK_OPERATIONS,PAYMENT_LINK_CHANNELS}=require('./lib/luna-front-desk-payment-link-service');
const {bindStaffGuestPaymentClient}=require('./lib/staff-guest-payment-link-auth');
let network=0;
const deny=()=>{network++;throw Error('Offline: network forbidden');};
global.fetch=deny;
require('node:http').request=deny;require('node:https').request=deny;require('node:net').Socket.prototype.connect=deny;
const source=fs.readFileSync(path.join(__dirname,'staff-query-api.js'),'utf8');
function fn(name){const start=source.search(new RegExp('^(?:async )?function '+name+'\\(','m'));assert(start>=0);const end=source.indexOf('\n}',start);assert(end>start);return source.slice(start,end+2);}
const marker="  if (pathname === '/staff/bookings/generate-payment-link') {";
const start=source.indexOf(marker),end=source.indexOf('\n  }',start);assert(start>=0&&end>start);assert.equal(source.indexOf(marker,start+1),-1);
const route=source.slice(start,end+4);
const CLIENT='wolfhouse-somo',ID='10000000-0000-4000-8000-000000000001',CODE='OFFLINE-TOTALS';
function harness(options={}){
 const calls={db:0,create:[],auth:[],ledgerReads:0};
 const booking={booking_id:ID,booking_code:CODE,client_id:'20000000-0000-4000-8000-000000000001',guest_name:'Synthetic Guest',status:'confirmed',total_amount_cents:60000,deposit_required_cents:18000,amount_paid_cents:0,metadata:{}};
 const pg={async query(sql){if(sql==='BY_ID'||sql==='BY_CODE')return {rows:[booking]};if(sql==='PAYMENTS')return {rows:[]};throw Error('Unknown SQL fixture: '+sql);}};
 const context=vm.createContext({URL,Date,console,Buffer,fetch:deny,DEFAULT_CLIENT:CLIENT,
 STAFF_AUTH_REQUIRED:true,STAFF_ACTIONS_ENABLED:options.enabled!==false,STRIPE_PAYMENT_LINKS_ENABLED:options.stripe!==false,
 SQL_INJECT_RE:/['";\\]|--|\bDROP\b/i,UUID_VALIDATE_RE:/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
 EDIT_PREVIEW_BOOKING_BY_ID_SQL:'BY_ID',EDIT_PREVIEW_BOOKING_BY_CODE_SQL:'BY_CODE',BOOKING_PAYMENTS_LEDGER_SQL:'PAYMENTS',
 STRIPE_SECRET_KEY:'SYNTHETIC-NOT-A-KEY',stripeCheckoutRedirectUrlsConfigured:()=>true,
 stripeCheckoutSessionSuccessUrl:()=> 'https://example.invalid/success',stripeCheckoutSessionCancelUrl:()=> 'https://example.invalid/cancel',
 loadBookingServiceRecords:async()=>({rows:[]}),listBookingTransfersForBooking:async()=>[],
 bookingLedgerBalanceFromRows:()=>{calls.ledgerReads++;return {invoice_total_cents:60000,balance_due_cents:60000,needs_refund:false};},
 staffActionsGate:()=>options.enabled!==false,stripeLinksGate:()=>options.stripe!==false,gateClientSlug:s=>s||CLIENT,readBody:async req=>req.body,
 sendJSON:(res,status,body)=>{res.status=status;res.body=JSON.parse(JSON.stringify(body));},
 send400:(res,error)=>{res.status=400;res.body={success:false,error};},
 appendAuditLog:()=>{},withPgClient:async cb=>{calls.db++;return cb(pg);},
 bindStaffGuestPaymentClient,getFortress15j3OfflineSeams:()=>({canAccessClient:(user,slug)=>user.client_slug===slug}),
 require(name){if(name==='stripe')return ()=>({checkout:{sessions:{create:deny}}});if(name==='./lib/staff-guest-payment-link-auth')return {bindStaffGuestPaymentClient};throw Error('Unknown module '+name);},
 getClientFeatures:()=>({}),PAYMENT_LINK_OPERATIONS,PAYMENT_LINK_CHANNELS,buildPaymentLinkCommand,
 getGuestPaymentsModule:()=>({loadBookingPaymentLedger:async()=>({invoice_total_cents:60000,balance_due_cents:60000})}),
 bookingContextLoadBillableInvoiceServiceRows:async()=>[],invoiceTransferTotalCents:async()=>0,
 balanceCheckoutInvoiceTotals:()=>({invoiceTotal:60000,balanceDue:60000,needsRefund:false}),
 getStripeKeyForClient:()=> 'SYNTHETIC-NOT-A-KEY',expireStripeCheckoutSession:deny,createStripeCheckoutSession:deny,
 frontDeskFindExistingPaymentByIdempotency:async()=>null,buildBookingPaymentLinkContext:async()=>({}),
 frontDeskLoadPaymentRowsForBooking:async()=>[],frontDeskPaymentContextOptions:()=>({}),
 markBookingPaymentLinkSentState:deny,upsertConversationForPaymentLink:deny,buildGuestPaymentUrl:()=>null,
 enrichGeneratedPaymentLinkResponseWithShortUrl:async(_pg,body)=>body,
 async createPaymentLink(connection,command,opts){
   assert.equal(connection,pg);calls.create.push(JSON.parse(JSON.stringify(command)));
   assert.equal(typeof opts.loadBookingPaymentLedger,'function');
   const before=calls.ledgerReads;
   const fresh=await opts.loadBookingPaymentLedger(pg,booking);
   assert.equal(fresh.invoice_total_cents,60000);assert.equal(calls.ledgerReads,before+1,'adapter executes fresh canonical ledger reader');
   if(options.result)return options.result;
   return {ok:true,status:200,body:{success:true,checkout_url:'https://checkout.stripe.com/c/pay/fixture',amount_due_cents:command.paymentTarget==='deposit'?18000:60000}};
 },
 async requireAuth(req,res,role){calls.auth.push(role);if(options.denied){res.status=401;res.body={success:false};return {ok:false};}return {ok:true,user:{role:'operator',client_slug:options.userTenant||CLIENT}};}
 });
 vm.runInContext(fn('staffClientAccessAllowed')+'\n'+fn('assertStaffClientAccess')+'\n'+fn('bookingStatusIsCancelled')+'\n'+fn('paymentLinkServiceExecOpts')+'\n'+fn('handleBookingGeneratePaymentLink')+'\nthis.dispatch=async function(req,res){const pathname=new URL(req.url,"http://offline.test").pathname;const method=req.method;'+route+'};',context);
 async function request(body={},url='/staff/bookings/generate-payment-link?client='+CLIENT,method='POST'){
 const res={writeHead(status){this.status=status;},end(raw){this.body=raw;}};
 await context.dispatch({method,url,headers:{},body:JSON.stringify({booking_id:ID,booking_code:CODE,idempotency_key:'totals-offline-intent',...body})},res);assert(res.status);return res;
 }
 return {calls,request};
}
(async()=>{
 let count=0;
 for(const target of ['deposit','balance']){
  const h=harness(),res=await h.request({client_slug:CLIENT,payment_target:target,amount_cents:1,deposit_required_cents:1});
  assert.equal(res.status,200,JSON.stringify(res.body));assert.equal(h.calls.create.length,1);assert.equal(h.calls.create[0].paymentTarget,target);
  assert.equal(h.calls.create[0].authoritativeBalanceDueCents,60000,'caller cents cannot change authoritative balance');
  assert.equal(h.calls.ledgerReads,2,'initial handler and service adapter each read invoice');
  count++;
 }
 const legacy=harness();assert.equal((await legacy.request()).status,200);assert.equal(legacy.calls.create[0].paymentTarget,'balance');count++;
 for(const target of ['bad',null,'']){const h=harness();assert.equal((await h.request({payment_target:target})).status,400);assert.equal(h.calls.create.length,0);count++;}
 for(const opts of [{enabled:false},{stripe:false},{denied:true}]){const h=harness(opts);assert((await h.request({payment_target:'deposit'})).status>=400);assert.equal(h.calls.db,0);count++;}
 for(const body of ['deposit','balance'].flatMap(payment_target=>[{payment_target,client_slug:'sunset'},{payment_target,client:'sunset'},{payment_target,client_slug:CLIENT,client:'sunset'}])){const h=harness();assert.equal((await h.request(body)).status,400);assert.equal(h.calls.db,0);count++;}
 const foreign=harness({userTenant:'sunset'});assert.equal((await foreign.request({payment_target:'deposit'})).status,403);assert.equal(foreign.calls.db,0);count++;
 const err=harness({result:{ok:false,status:422,body:{success:false,reason_code:'no_deposit_due',error:'No remaining deposit due.'}}});assert.equal((await err.request({payment_target:'deposit'})).status,422);count++;
 for(const field of ['amount_due_cents','balance_due_cents']){const h=harness();assert.equal((await h.request({payment_target:'deposit',[field]:1})).status,422);assert.equal(h.calls.create.length,0);count++;}
 const get=harness();assert.equal((await get.request({},undefined,'GET')).status,405);assert.equal(get.calls.db,0);count++;
 assert.equal(network,0);console.log(JSON.stringify({cases:count,networkAttempts:network,scope:'exact handler/router + real command builder; auth/PG/provider doubles, no SQL persistence'},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
