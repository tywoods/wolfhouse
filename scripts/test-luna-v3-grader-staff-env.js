'use strict';
// Runtime test of the preload actually emitted by the TEST owner runner.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const dotenv=require('dotenv'),{Client}=require('pg');
const {config}=require('./lib/model-led-luna/staff-owner-run-plan');
test('required runner patch prevents dotenv from restoring ambient PG settings',()=>{
 const env={NODE_ENV:'test',LUNA_OWNER_TEST_RUN:'true',LUNA_OWNER_ADMIN_URL:'postgresql://offline@127.0.0.1:5432/postgres',LUNA_OWNER_DB:'luna_owner_test_preload',LUNA_OWNER_PORT:'15432',LUNA_OWNER_OUTPUT:path.join(__dirname,'UNUSED'),LUNA_OWNER_RECEIPT_ISSUER_KEY:'offline-unit-test-placeholder-00000000'};
 const cfg=config(env);
 const patch=fs.readFileSync(path.join(__dirname,'run-luna-v3-r7-real-owner.js'),'utf8');
 const match=patch.match(/^ save\('staff-test-preload\.cjs',(".*")\);$/m);assert.ok(match);
 const preload=JSON.parse(match[1]);
 const filename='/offline-fence-synthetic-env';
 const names=['PGHOST','PGOPTIONS','PGSERVICE','NODE_PG_FORCE_NATIVE'];
 const previous=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 const read=fs.readFileSync,originalConfig=dotenv.config,originalConfigDotenv=dotenv.configDotenv;
 let reads=0;
 fs.readFileSync=function(file,...args){if(file===filename){reads++;return Buffer.from('PGHOST=example.invalid\nPGOPTIONS=-c search_path=unsafe\nPGSERVICE=outside\nNODE_PG_FORCE_NATIVE=1\n');}return read.call(this,file,...args);};
 try {
  for(const name of names)delete process.env[name];
  dotenv.config({path:filename,quiet:true});
  assert.equal(reads,1);
  assert.equal(new Client({connectionString:cfg.database}).connectionParameters.options,'-c search_path=unsafe','real dotenv/pg negative control');
  for(const name of names)delete process.env[name];
  vm.runInNewContext(preload,{require});
  dotenv.config({path:filename});dotenv.configDotenv({path:filename});
  assert.equal(reads,1,'preload must prevent env-file reading, not merely override afterwards');
  for(const name of names)assert.equal(process.env[name],undefined);
  const cp=new Client({connectionString:cfg.database}).connectionParameters;
  assert.equal(cp.host,'127.0.0.1');assert.equal(cp.database,env.LUNA_OWNER_DB);assert.ok(!cp.options);
 } finally {
  fs.readFileSync=read;dotenv.config=originalConfig;dotenv.configDotenv=originalConfigDotenv;
  for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}
 }
});
