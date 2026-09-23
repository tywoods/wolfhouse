#!/usr/bin/env node
'use strict';
// Offline: real PostgreSQL queries and ordinary draft owners; no provider/model network.
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const open=require('./lib/staff-email-luna-draft-open');
const generation=require('./lib/staff-email-luna-draft-route');
const content=require('./lib/email-current-message-content-authority-resolver');
const inbox=require('./lib/staff-email-inbox-routes');
const C='11111111-1111-4111-8111-111111111111',L='22222222-2222-4222-8222-222222222222',E='33333333-3333-4333-8333-333333333333',V='44444444-4444-4444-8444-444444444444',A='55555555-5555-4555-8555-555555555555',M='66666666-6666-4666-8666-666666666666',BOX='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function main(){const db=new PGlite();try{
 await db.exec(`
 CREATE TABLE clients(id uuid,slug text,settings jsonb DEFAULT '{}');
 CREATE TABLE staff_users(id uuid,client_id uuid,status text,role text);
 CREATE TABLE tenant_locations(id uuid,client_id uuid,location_id text);
 CREATE TABLE conversations(id uuid,client_id uuid,phone text,email text DEFAULT 'guest@example.test',status text DEFAULT 'open',needs_human boolean DEFAULT true,staff_reply_draft text,metadata jsonb DEFAULT '{}',updated_at timestamptz);
 CREATE TABLE tenant_channel_endpoints(id uuid,client_id uuid,location_id text,channel text DEFAULT 'email',provider text DEFAULT 'microsoft_graph',auth_mode text DEFAULT 'delegated_authorization_code',connector_mode text DEFAULT 'microsoft_delegated_oauth',mailbox_access_kind text DEFAULT 'own_user',mailbox_kind text DEFAULT 'user',binding_status text DEFAULT 'verified',public_address text DEFAULT 'desk@example.test',provider_resource_id text,mail_flow_paused boolean DEFAULT false,outbound_enabled boolean DEFAULT true);
 CREATE TABLE tenant_email_inbound_events(id uuid,client_id uuid,location_id uuid,endpoint_id uuid,provider text DEFAULT 'microsoft_graph',provider_mailbox_id text,provider_message_id text DEFAULT 'fixture-message',subject text DEFAULT 'Hello',sender_address text DEFAULT 'guest@example.test',sender_display_name text DEFAULT 'Guest',received_at timestamptz DEFAULT now());
 CREATE TABLE tenant_email_inbound_inbox_projections(client_id uuid,conversation_id uuid,inbound_event_id uuid,location_id uuid,endpoint_id uuid,provider text DEFAULT 'microsoft_graph',provider_mailbox_id text,provider_message_id text DEFAULT 'fixture-message');
 CREATE TABLE tenant_email_reply_approvals(approval_id uuid,client_id uuid,conversation_id uuid,source_inbound_event_id uuid,message_text text,state text,subject text,updated_at timestamptz);
 CREATE TABLE bot_pause_states(client_slug text,conversation_id text,paused boolean);
 CREATE TABLE tenant_email_delegated_grants(client_id uuid,endpoint_id uuid,provider text DEFAULT 'microsoft_graph',grant_status text DEFAULT 'active',reconcile_state text DEFAULT 'clean',grant_lease_owner text,grant_lease_token uuid,grant_lease_until timestamptz);
 `);
 await db.query('INSERT INTO clients(id,slug) VALUES($1,$2)',[C,'sunset']);
 await db.query('INSERT INTO staff_users VALUES($1,$2,$3,$4)',[A,C,'active','operator']);
 await db.query('INSERT INTO tenant_locations VALUES($1,$2,$3)',[L,C,'sunset-somo']);
 await db.query('INSERT INTO conversations(id,client_id,phone) VALUES($1,$2,$3)',[V,C,'emailv1:guest@example.test']);
 await db.query('INSERT INTO tenant_channel_endpoints(id,client_id,location_id,provider_resource_id) VALUES($1,$2,$3,$4)',[E,C,'sunset-somo',BOX]);
 await db.query('INSERT INTO tenant_email_inbound_events(id,client_id,location_id,endpoint_id,provider_mailbox_id) VALUES($1,$2,$3,$4,$5)',[M,C,L,E,BOX]);
 await db.query('INSERT INTO tenant_email_inbound_inbox_projections(client_id,conversation_id,inbound_event_id,location_id,endpoint_id,provider_mailbox_id) VALUES($1,$2,$3,$4,$5,$6)',[C,V,M,L,E,BOX]);
 await db.query('INSERT INTO tenant_email_delegated_grants(client_id,endpoint_id) VALUES($1,$2)',[C,E]);
 for(const tenant of ['sunset','wolfhouse-somo']){
  const key=tenant==='sunset'?'sunset-somo':tenant,suffix=tenant==='sunset'?'':'_WOLFHOUSE';
  await db.query('UPDATE clients SET slug=$1',[tenant]);await db.query('UPDATE tenant_locations SET location_id=$1',[key]);await db.query('UPDATE tenant_channel_endpoints SET location_id=$1,mail_flow_paused=false',[key]);
  const actor={staff_user_id:A,client_id:C,client_slug:tenant,role:'operator'};
  const env={LUNA_DEPLOYMENT:tenant==='sunset'?'sunset-staging':'staff-staging',EMAIL_STAFF_LUNA_DRAFT_ENABLED:'true',EMAIL_LUNA_DRAFT_RUNTIME_ENABLED:'true',WOLFHOUSE_EMAIL_LUNA_GENERATE_DRAFT_ENABLED:'true',STAFF_PORTAL_ORIGIN:'https://staff-staging.lunafrontdesk.com'};
  const params=[C,A,V];
  assert.equal((await db.query(open['SQL_LOAD_EMAIL_LUNA_OPEN_CONTEXT'+suffix],params)).rows.length,1);
  assert.equal((await db.query(generation['SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT'+suffix],params)).rows.length,1);
  let claims=0,fetches=0,models=0,pauseOnFetch=false,pauseBeforeLock=false;const errors=[];
  const query=async(sql,args)=>{if(pauseBeforeLock && /FOR UPDATE OF c,p,ev,ep/.test(sql)){pauseBeforeLock=false;await db.query('UPDATE tenant_channel_endpoints SET mail_flow_paused=true');}if(sql===open.SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT||sql===open.SQL_CLAIM_EMAIL_LUNA_CREATE_DRAFT)claims++;try{return await db.query(sql,args);}catch(e){errors.push(e.message);throw e;}};
  const owner=open.createStaffEmailLunaDraftOpen({runtimeEnv:env,withPgClient:fn=>fn({query}),fetchCurrentMessageContent:async()=>{fetches++;if(pauseOnFetch)await db.query('UPDATE tenant_channel_endpoints SET mail_flow_paused=true');return {latest_text:'Hello'};},callModel:async()=>{models++;throw Error('offline model must not run');}});
  await db.query('UPDATE tenant_channel_endpoints SET mail_flow_paused=true');
  await owner.ensureEmailLunaDraftOnOpen({actor,conversation_id:V,gateEnv:env});
  assert.equal(claims,0,tenant+' paused open cannot claim generation');assert.equal(fetches,0);assert.equal(models,0);assert.deepEqual(errors,[]);
  await owner.regenerateEmailLunaDraftOnStaffClick({actor,conversation_id:V,gateEnv:env});
  assert.equal(claims,0,tenant+' paused staff regeneration cannot claim');assert.equal(fetches,0);assert.equal(models,0);assert.deepEqual(errors,[]);
  assert.equal((await db.query(generation['SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT'+suffix],params)).rows.length,0,tenant+' generation context denies new admission');
  // Stored draft visibility is independent of new generation.
  await db.query("UPDATE conversations SET staff_reply_draft='Saved staff draft'");
  const visible=await owner.ensureEmailLunaDraftOnOpen({actor,conversation_id:V,gateEnv:env});
  assert.ok(JSON.stringify(visible).includes('Saved staff draft'),'stored draft remains visible');
  await db.query("UPDATE conversations SET staff_reply_draft=NULL,metadata='{}'");
  await db.query('UPDATE tenant_channel_endpoints SET mail_flow_paused=false');
  await owner.ensureEmailLunaDraftOnOpen({actor,conversation_id:V,gateEnv:env});
  assert.ok(claims>0,tenant+' resumed open actually reaches claim');assert.ok(fetches>0,tenant+' resumed open fetches');assert.deepEqual(errors,[]);
  await db.query("UPDATE conversations SET staff_reply_draft=NULL,metadata='{}'");
  const admittedClaims=claims,admittedFetches=fetches;
  pauseBeforeLock=true;
  await owner.ensureEmailLunaDraftOnOpen({actor,conversation_id:V,gateEnv:env});
  assert.equal(claims,admittedClaims,'pause winning before endpoint lock prevents claim');
  assert.equal(fetches,admittedFetches,'pause winning before endpoint lock prevents fetch');
  await db.query('UPDATE tenant_channel_endpoints SET mail_flow_paused=false');
  pauseOnFetch=true;
  await owner.ensureEmailLunaDraftOnOpen({actor,conversation_id:V,gateEnv:env});
  assert.equal(claims,admittedClaims+1);assert.equal(fetches,admittedFetches+1);assert.deepEqual(errors,[]);
  assert.equal((await db.query('SELECT mail_flow_paused FROM tenant_channel_endpoints')).rows[0].mail_flow_paused,true);
  assert.ok((await db.query('SELECT staff_reply_draft FROM conversations')).rows[0].staff_reply_draft,'already admitted draft can persist after pause');
  await db.query("UPDATE conversations SET staff_reply_draft=NULL,metadata='{}'");
 }
 // Independently callable content authority and recovery identity use actual SQL.
 await db.query("UPDATE clients SET slug='sunset'");await db.query("UPDATE tenant_locations SET location_id='sunset-somo'");await db.query("UPDATE tenant_channel_endpoints SET location_id='sunset-somo',mail_flow_paused=true");
 const resolver=content.createCurrentMessageContentAuthorityResolver({db})(x=>x);
 await assert.rejects(resolver({clientId:C,locationId:L,eventId:M}),/authority_bound_current_message_content_failed/,'paused independent content admission denied');
 assert.equal((await db.query(inbox.SQL_RESOLVE,[C,A,V])).rows.length,0,'new-send authority denied');
 assert.equal((await db.query(inbox.SQL_RESOLVE_RECOVERY,[C,A,V])).rows.length,1,'recovery retains identity while paused');
 await db.query('UPDATE tenant_channel_endpoints SET mail_flow_paused=false');
 assert.ok(await resolver({clientId:C,locationId:L,eventId:M}),'content authority resumes');
 console.log('PASS embedded PostgreSQL + ordinary draft owner: both tenants pause open/regenerate, saved drafts visible, resume works; independent content denied and recovery identity preserved');
}finally{await db.close();}}
main().catch(e=>{console.error(e);process.exitCode=1;});
