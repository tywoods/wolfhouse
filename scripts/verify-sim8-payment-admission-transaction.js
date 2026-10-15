'use strict';
// Actual exported link handlers + actual admission SQL, in-memory PostgreSQL.
// Stripe is OFF; no booking/payment writer or provider is reached.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const root=process.env.REVIEW_ROOT,req=createRequire(path.join(root,'package.json'));
const {PGlite}=req('@electric-sql/pglite');
const routes=req('./scripts/lib/staff-bot-v2-routes');
const policy=req('./scripts/lib/staff-booking-portal-policy');
const PHONE='+'+[999,123,456,789].join('');
(async()=>{
 const db=new PGlite();await db.exec(`
 CREATE TABLE clients(id uuid PRIMARY KEY,slug text,settings jsonb);
 CREATE TABLE conversations(id uuid PRIMARY KEY,client_id uuid,phone text,needs_human boolean);
 CREATE TABLE bot_pause_states(client_slug text,conversation_id text,guest_phone text,paused boolean);
 INSERT INTO clients VALUES('00000000-0000-4000-8000-000000000001','wolfhouse-somo','{"inbox_channel_modes":{"whatsapp":"auto"}}');
 INSERT INTO conversations VALUES('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','${PHONE}',false);
 `);
 const observations=[];
 for(const name of ['handleBotPaymentCreateStripeLink','handleBotCreateBalancePaymentLink','handleBotGuestPaymentCreateLink']){
  const queries=[];let response;
  const pg={query:async(sql,args)=>{try{const r=await db.query(sql,args);queries.push({sql,ok:true});return r;}catch(e){queries.push({sql,ok:false,code:e.code,message:e.message});throw e;}}};
  const ctx={boundClientSlug:'wolfhouse-somo',sendJSON:(_,status,body)=>{response={status,body};return response;},withPgClient:fn=>fn(pg),resolveAutomaticBookingAdmission:policy.resolveWolfhouseAutomaticBookingAdmission,readBody:async()=> '{}',STRIPE_LINKS_ENABLED:false,appendAuditLog:()=>{}};
  const args=[{headers:{'x-luna-guest-phone':PHONE}},{},null,'bot_token',ctx];
  if(name!=='handleBotCreateBalancePaymentLink')args.unshift('20000000-0000-4000-8000-000000000001');
  await routes[name](...args);
  assert.equal(response.status,403);assert.equal(response.body.stripe_links_enabled,false);
  assert.ok(queries.some(q=>q.sql==='BEGIN'&&q.ok));
  assert.ok(queries.some(q=>/LOCK TABLE bot_pause_states/.test(q.sql)&&q.ok));
  assert.ok(queries.some(q=>q.sql==='COMMIT'&&q.ok));
  assert.equal(queries.some(q=>q.code==='25P01'),false);
  observations.push({handler:name,queries,response});
 }
 await db.close();
 console.log('verify-sim8-payment-admission-transaction PASS: all 3 handlers execute policy lock inside BEGIN/COMMIT and reach Stripe-disabled stop.');
})().catch(e=>{console.error(e);process.exit(1);});
