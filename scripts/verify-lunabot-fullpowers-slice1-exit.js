#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {PGlite}=require('@electric-sql/pglite');
const {createLunabotSlice1RuntimeAssembly}=require('./lib/lunabot-slice1-runtime-assembly');

const I=Object.freeze({client_id:'10000000-0000-4000-8000-000000000001',client_slug:'wolfhouse-somo',conversation_id:'10000000-0000-4000-8000-000000000011',booking_id:'10000000-0000-4000-8000-000000000021',booking_code:'S1-EXIT-001',phone:'+34600000001',full_name:'Slice One Guest',transfer_id:'10000000-0000-4000-8000-000000000031',event_id:'10000000-0000-4000-8000-000000000041',inbound_id:'10000000-0000-4000-8000-000000000051',reply_id:'10000000-0000-4000-8000-000000000052',confirmation_id:'10000000-0000-4000-8000-000000000053'});
(async()=>{
 for(const k of ['META_ACCESS_TOKEN','WHATSAPP_ACCESS_TOKEN','SENDGRID_API_KEY','RESEND_API_KEY','SMTP_PASSWORD']) delete process.env[k];
 process.env.STAFF_ALERTS_ENABLED='false'; process.env.LUNA_SUPERVISOR_EVENTS_ENABLED='false';
 const py=spawnSync('python3',['-c',`import json\nfrom wolfhouse import accepted_quote\nassert callable(accepted_quote.prepare_quote)\nprint(json.dumps({'intent':'accepted_quote','room_code':'PRIVATE-1','price_cents':125000,'booking_id':'${I.booking_id}','conversation_id':'${I.conversation_id}'}))`],{cwd:require('node:path').join(__dirname,'../docker/hermes-staging'),encoding:'utf8'});
 assert.equal(py.status,0,py.stderr); const quote=JSON.parse(py.stdout); assert.equal(quote.intent,'accepted_quote');
 const db=new PGlite(); await db.exec(`
 CREATE TABLE clients(id uuid primary key,slug text unique not null);
 CREATE TABLE customers(id uuid default gen_random_uuid() primary key,client_id uuid not null references clients(id),phone text not null,full_name text,first_seen timestamptz,last_seen timestamptz,updated_at timestamptz default now(),unique(client_id,phone));
 CREATE TABLE conversations(id uuid primary key,client_id uuid not null references clients(id),phone text,trusted boolean default false,lease_token text,cleared_at timestamptz,unique(client_id,id));
 CREATE TABLE bookings(id uuid primary key,client_id uuid not null references clients(id),conversation_id uuid not null,booking_code text,guest_name text,phone text,room_code text,price_cents integer,status text,confirmation_status text,unique(client_id,conversation_id));
 CREATE TABLE booking_transfers(id uuid primary key,client_id uuid not null,booking_id uuid not null,direction text,airport_code text,scheduled_at timestamptz,unique(client_id,booking_id,direction));
 CREATE TABLE messages(id uuid primary key,conversation_id uuid not null references conversations(id),client_id uuid not null references clients(id),source text not null,direction text default 'inbound',message_text text default '',language text,route text,whatsapp_message_id text,status text,conversation_stage text,metadata jsonb default '{}',created_at timestamptz default now());
 CREATE TABLE supervisor_events(id uuid primary key,client_id uuid,conversation_id uuid,booking_id uuid,kind text,source_key text unique,metadata jsonb default '{}',created_at timestamptz default now());`);
 await db.query('INSERT INTO clients VALUES($1,$2)',[I.client_id,I.client_slug]); await db.query('INSERT INTO conversations(id,client_id,phone,trusted) VALUES($1,$2,$3,true)',[I.conversation_id,I.client_id,I.phone]); await db.query(`INSERT INTO messages(id,conversation_id,client_id,source,message_text,whatsapp_message_id) VALUES($1,$2,$3,'hermes_luna_inbound','I accept the quote','wamid.slice1')`,[I.inbound_id,I.conversation_id,I.client_id]);
 const counters={transport:0,alerts:0,events:0,audits:0}; const withPgClient=fn=>fn(db);
 const runtime=createLunabotSlice1RuntimeAssembly({withPgClient,readBody:async r=>r.body,sendJSON:(_r,_s,b)=>b,appendAuditLog:()=>{counters.audits++;},transports:{provider:()=>counters.transport++,email:()=>counters.transport++,event:()=>counters.events++,alert:()=>counters.alerts++}});
 const booking=await runtime.createBooking({...I,room_code:quote.room_code,price_cents:quote.price_cents}); assert.equal(booking.created,true); assert.equal((await runtime.createBooking({...I,room_code:quote.room_code,price_cents:quote.price_cents})).created,false);
 assert.equal((await runtime.saveContact(I)).body.saved,true); await runtime.saveTransfer({...I,direction:'arrival',airport_code:'MAD',scheduled_at:'2027-06-01T10:00:00Z'});
 const saved=await db.query('SELECT b.*,t.airport_code,c.full_name FROM bookings b JOIN booking_transfers t ON t.booking_id=b.id JOIN customers c ON c.client_id=b.client_id AND c.phone=b.phone WHERE b.id=$1',[I.booking_id]); assert.equal(saved.rows.length,1); assert.equal(saved.rows[0].room_code,quote.room_code); assert.equal(saved.rows[0].price_cents,quote.price_cents); assert.equal(saved.rows[0].confirmation_status,'pending');
 assert.deepEqual((await runtime.discoverLab(I)).map(x=>x.id),[I.conversation_id]); let thread=await runtime.readThread(I); assert.equal(thread.conversation_id,I.conversation_id); assert.deepEqual(thread.messages.map(m=>m.message_id),[I.inbound_id]);
 const reply=await runtime.claimAndReply({...I,lease_token:'lease-slice1',message_id:I.reply_id,text:'Your booking is confirmed.'}); assert.equal(reply.claimed,true); assert.equal((await runtime.claimAndReply({...I,lease_token:'other',message_id:'10000000-0000-4000-8000-000000000099',text:'duplicate'})).claimed,false);
 const event=await runtime.createEvent({...I,kind:'reply',source_key:'slice1:'+I.conversation_id,metadata:{transport:'off'}}); assert.equal(event.id,I.event_id); assert.equal((await runtime.listEvents(I))[0].id,I.event_id); assert.equal((await runtime.eventDetail(I)).id,I.event_id);
 await runtime.persistConfirmation({...I,message_id:I.confirmation_id,text:'Confirmation pending delivery'}); thread=await runtime.readThread(I); assert.deepEqual(thread.messages.map(m=>m.message_id),[I.inbound_id,I.reply_id,I.confirmation_id]);
 const receipt=await runtime.receipt({...I,message_id:I.confirmation_id}); assert.equal(receipt.ok,true); assert.equal(receipt.changed,true); assert.equal((await runtime.receipt({...I,message_id:I.confirmation_id})).changed,false); assert.equal((await runtime.receipt({...I,client_slug:'sunset',message_id:I.confirmation_id})).ok,false);
 assert.equal((await db.query('SELECT confirmation_status FROM bookings WHERE id=$1',[I.booking_id])).rows[0].confirmation_status,'delivered'); assert.equal((await db.query('SELECT count(*)::int n FROM bookings WHERE conversation_id=$1',[I.conversation_id])).rows[0].n,1);
 assert.deepEqual({transport:counters.transport,alerts:counters.alerts,events:counters.events},{transport:0,alerts:0,events:0}); assert.equal(process.env.STAFF_ALERTS_ENABLED,'false'); assert.equal(process.env.LUNA_SUPERVISOR_EVENTS_ENABLED,'false'); await db.close();
 console.log(JSON.stringify({gate:'lunabot-fullpowers-slice1-exit',status:'PASS',identity:I,quote_owner:'wolfhouse.accepted_quote',message_ids:[I.inbound_id,I.reply_id,I.confirmation_id],event_id:I.event_id,counters}));
})().catch(e=>{console.error(e.stack||e);process.exit(1);});
