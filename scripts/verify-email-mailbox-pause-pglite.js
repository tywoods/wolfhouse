#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {PGlite} = require('@electric-sql/pglite');
const {SQL_SET_PAUSE} = require('./lib/email-mailbox-pause');
async function main(){
 const db=new PGlite();
 try {
 await db.exec(`CREATE TABLE clients(id uuid PRIMARY KEY, slug text);
 CREATE TABLE tenant_channel_endpoints(id uuid PRIMARY KEY,client_id uuid,location_id text,channel text,provider text,provider_resource_id text,active boolean,inbound_enabled boolean,outbound_enabled boolean,default_automation_mode text,secret_ref text,updated_at timestamptz,updated_by uuid);
 INSERT INTO clients VALUES('11111111-1111-4111-8111-111111111111','sunset');
 INSERT INTO tenant_channel_endpoints VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','sunset-somo','email','microsoft_graph','mailbox',true,true,false,'off','secret-ref:preserved',NULL,NULL);`);
 await db.exec(`CREATE FUNCTION set_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at:=NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
 CREATE TRIGGER tenant_channel_endpoints_updated_at BEFORE UPDATE ON tenant_channel_endpoints FOR EACH ROW EXECUTE FUNCTION set_updated_at();`);
 const migration=path.join(__dirname,'../database/migrations/105_email_mailbox_pause.sql');
 assert.ok(fs.existsSync(migration),'durable mailbox pause migration exists');
 await db.exec(fs.readFileSync(migration,'utf8')); await db.exec(fs.readFileSync(migration,'utf8'));
 const before=(await db.query('SELECT * FROM tenant_channel_endpoints')).rows[0];
 assert.equal(before.mail_flow_paused,false);
 const args=['sunset','sunset-somo',before.id,true,'33333333-3333-4333-8333-333333333333'];
 assert.equal((await db.query(SQL_SET_PAUSE,args)).rows[0].mail_flow_paused,true);
 const after=(await db.query('SELECT * FROM tenant_channel_endpoints')).rows[0];
 for(const key of ['active','inbound_enabled','outbound_enabled','default_automation_mode','secret_ref','provider_resource_id','updated_at','updated_by'])assert.deepEqual(after[key],before[key],key+' preserved (pause cannot reorder sender preference)');
 assert.ok(after.mail_flow_pause_updated_at,'pause has separate audit time');
 assert.equal(after.mail_flow_pause_updated_by,args[4]);
 for(const bad of [['wolfhouse-somo',args[1],args[2]],['sunset','other',args[2]],['sunset',args[1],'44444444-4444-4444-8444-444444444444']])assert.equal((await db.query(SQL_SET_PAUSE,[...bad,false,args[4]])).rows.length,0);
 args[3]=false;assert.equal((await db.query(SQL_SET_PAUSE,args)).rows[0].mail_flow_paused,false);
 await db.exec(`ALTER TABLE tenant_channel_endpoints ADD COLUMN binding_status text DEFAULT 'verified';
 CREATE TABLE tenant_locations(id uuid,client_id uuid,location_id text);
 CREATE TABLE tenant_email_delegated_grants(client_id uuid,endpoint_id uuid,grant_status text,reconcile_state text,grant_lease_owner text,grant_lease_token uuid,grant_lease_until timestamptz);
 INSERT INTO tenant_locations VALUES ('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','sunset-somo');
 INSERT INTO tenant_email_delegated_grants VALUES ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','active','clean',NULL,NULL,NULL);`);
 const {createEmailDeltaSunsetStagingWorker,ACTIVATION_BOUNDARY_SQL,UNPROJECTED_SQL}=require('./lib/email-delta-sunset-staging-worker');
 let pages=0;
 const worker=createEmailDeltaSunsetStagingWorker({query:(sql,p)=>sql===ACTIVATION_BOUNDARY_SQL?{rows:[{activation_watermark:'2026-09-22T00:00:00.000Z'}]}:sql===UNPROJECTED_SQL?{rows:[]}:db.query(sql,p),runPage:async()=>{pages++;},projectEvent:async()=>{},timers:{setTimeout,clearTimeout},intervalMs:60000});
 assert.equal((await worker.tick()).status,'completed');assert.equal(pages,1);
 args[3]=true;await db.query(SQL_SET_PAUSE,args);
 assert.equal((await worker.tick()).status,'ineligible','paused mailbox never starts provider read');assert.equal(pages,1);
 args[3]=false;await db.query(SQL_SET_PAUSE,args);await worker.tick();assert.equal(pages,2,'resume preserves existing inbound permission');
 console.log('PASS real delta worker + embedded SQL: Off starts no provider page; On resumes');
 await db.exec(`UPDATE tenant_channel_endpoints SET default_automation_mode='draft';`);
 assert.notDeepEqual((await db.query('SELECT updated_at FROM tenant_channel_endpoints')).rows[0].updated_at,before.updated_at,'normal config update retains timestamp trigger');
 console.log('PASS embedded PostgreSQL: migration twice, default unchanged, pause/resume, tenant/location/endpoint isolation, secrets and permissions preserved');
 }finally{await db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
