'use strict';
// Exact router branch + production handler in a VM, real SQL in isolated PGlite.
// Auth/session and ACL adapter are explicit doubles. No app server or network.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const ROOT=path.resolve(__dirname,'..'),OUT=path.resolve(process.argv[2]||'tmp/mobile-evidence/sql');
const CAPTURE=process.argv[3]&&path.resolve(process.argv[3]);
const source=fs.readFileSync(path.join(ROOT,'scripts/staff-query-api.js'),'utf8');
function fn(name,optional=false){const match=new RegExp('(?:async )?function '+name+'\\(').exec(source);if(!match){if(optional)return '';throw Error('Missing source function '+name);}const end=source.indexOf('\n}',match.index);assert(end>match.index);return source.slice(match.index,end+2);}
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OTHER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',TENANT='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac';
const G1='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',G2='cccccccc-cccc-4ccc-8ccc-cccccccccccc',G3='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
async function main(){
 fs.mkdirSync(OUT,{recursive:true});const db=new PGlite();const ledger=[],audits=[],cases=[],sqlErrors=[];
 await db.exec(`CREATE TABLE clients(id uuid PRIMARY KEY,slug text UNIQUE NOT NULL);
 CREATE TABLE bookings(id uuid PRIMARY KEY,client_id uuid REFERENCES clients(id),booking_code text,guest_name text,total_amount_cents int,amount_paid_cents int,balance_due_cents int,metadata jsonb DEFAULT '{}');
 CREATE TABLE payments(id uuid PRIMARY KEY,booking_id uuid,amount_paid_cents int);
 CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
 INSERT INTO clients VALUES ('11111111-1111-4111-8111-111111111111','wolfhouse-somo'),('22222222-2222-4222-8222-222222222222','sunset');
 INSERT INTO bookings VALUES ('${ID}','11111111-1111-4111-8111-111111111111','WH-NAMES-TEST','Lead',90000,9000,81000,'{"unchanged":true}'),('${OTHER}','11111111-1111-4111-8111-111111111111','OTHER','Other',10000,0,10000,'{}'),('${TENANT}','22222222-2222-4222-8222-222222222222','TENANT','Tenant',20000,0,20000,'{}');
 INSERT INTO payments VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','${ID}',9000);`);
 await db.exec(fs.readFileSync(path.join(ROOT,'database/migrations/024_booking_guests.sql'),'utf8'));
 await db.query(`INSERT INTO booking_guests(id,client_id,booking_id,guest_number,guest_name,assigned_bed_code,deposit_amount_cents,amount_paid_cents,payment_status,metadata) VALUES ($1,$4,$5,1,'Lead','R1-B1',9000,0,'not_requested','{"subtotal_cents":30000}'),($2,$4,$5,2,'Second','R1-B2',9000,9000,'paid','{"subtotal_cents":30000}'),($3,$4,$5,3,'','R1-B3',9000,0,'not_requested','{"subtotal_cents":30000}')`,[G1,G2,G3,'11111111-1111-4111-8111-111111111111',ID]);
 const pg={query:async(sql,params)=>{ledger.push({sql,params});try{return await db.query(sql,params);}catch(e){sqlErrors.push(e.message);throw e;}}};
 const sandbox={console,Date,JSON,Set,Map,STAFF_ACTIONS_ENABLED:true,STAFF_AUTH_REQUIRED:true,DEFAULT_CLIENT:'wolfhouse-somo',SQL_INJECT_RE:/[';]|--/,UUID_VALIDATE_RE:/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  readBody:async req=>req.raw,sendJSON:(res,status,data)=>{res.status=status;res.body=JSON.parse(JSON.stringify(data));},send400:(res,error)=>{res.status=400;res.body={success:false,error};},appendAuditLog:a=>audits.push(a),withPgClient:f=>f(pg),staffClientAccessAllowed:(u,c)=>u.clients.includes(c),requireAuth:async(req,res,role)=>{assert.equal(role,'operator');if(req.denied){res.status=403;return {ok:false};}return {ok:true,user:{staff_user_id:'offline-operator',role:'operator',clients:['wolfhouse-somo','sunset']}};}};
 vm.createContext(sandbox);
 const constants=source.match(/^const EDIT_WRITE_SUPPORTED_TYPES = .*;$/m)[0];
 const routeStart=source.indexOf("  if (pathname === '/staff/bookings/edit') {");const routeEnd=source.indexOf('\n  }',routeStart)+4;
 vm.runInContext(constants+'\n'+fn('assertStaffClientAccess')+'\n'+fn('handleBookingEditWriteGuestNames',true)+'\n'+fn('handleBookingEditWrite')+'\nasync function route(req,res){const pathname="/staff/bookings/edit",method=req.method;'+source.slice(routeStart,routeEnd)+'\n}',sandbox);
 async function call(patch={},options={}){const body={client_slug:'wolfhouse-somo',booking_id:ID,booking_code:'WH-NAMES-TEST',edit_type:'guest_names',idempotency_key:'names-test-1',guest_names:[{booking_guest_id:G2,guest_name:'Zoë & <Second>'}],...patch};const res={writeHead(s){this.status=s;},end(s){this.body=JSON.parse(s);}};await sandbox.route({method:options.method||'POST',raw:options.raw===undefined?JSON.stringify(body):options.raw,denied:options.denied},res);return res;}
 async function snapshot(){return {bookings:(await db.query('SELECT * FROM bookings ORDER BY id')).rows,guests:(await db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows,payments:(await db.query('SELECT * FROM payments ORDER BY id')).rows};}
 let failure=null;
 try{
  const before=await snapshot(),result=await call();
  assert.equal(result.status,200,'guest_names route accepts a valid durable non-lead edit: '+JSON.stringify(result.body));
  assert.equal(result.body.success,true);
  const after=await snapshot();assert.equal(after.guests[1].guest_name,'Zoë & <Second>','independent committed SQL readback');
  const invariant=s=>({...s,guests:s.guests.map(g=>{const {guest_name,updated_at,...rest}=g;return rest;})});
  assert.deepEqual(invariant(after),invariant(before),'name-only write leaves bookings, payments, guest IDs/beds/money/metadata unchanged');
  assert(audits.some(a=>a.success&&a.updated),'successful edit audited');cases.push('non-lead-durable-write-invariants-audit');
  const allBefore=await snapshot();
  const all=await call({guest_names:[{booking_guest_id:G3,guest_name:'  Same Name  '},{booking_guest_id:G1,guest_name:'New Lead'},{booking_guest_id:G2,guest_name:'Same Name'}]});
  assert.equal(all.status,200);
  const allAfter=await snapshot();
  assert.deepEqual(allAfter.guests.map(g=>g.guest_name),['New Lead','Same Name','Same Name'],'blank slots and duplicate names preserve durable identity');
  assert.equal(allAfter.bookings[0].guest_name,'New Lead','lead name updates booking contact projection atomically');
  const money=s=>({...invariant(s),bookings:s.bookings.map(b=>{const {guest_name,...rest}=b;return rest;})});
  assert.deepEqual(money(allAfter),money(allBefore),'all guest IDs, beds, financial fields and payments preserved');
  cases.push('all-names-lead-projection-blank-slot-duplicate-names');
  const replayBefore=await snapshot(),replayStart=ledger.length;
  const replay=await call({guest_names:all.body.after});
  assert.equal(replay.status,200);assert.equal(replay.body.updated,false);assert.equal(replay.body.idempotent,true);
  assert.deepEqual(await snapshot(),replayBefore);assert.equal(ledger.slice(replayStart).filter(q=>/^UPDATE/i.test(q.sql)).length,0);
  cases.push('same-values-retry-no-update');
  async function reject(label,patch,status=400,options={}){const b=await snapshot();const r=await call(patch,options);assert.equal(r.status,status,label+': '+JSON.stringify(r.body));assert.deepEqual(await snapshot(),b,label+' unchanged SQL');cases.push(label);}
  for(const guest_names of [null,{},[],[null],[{}],[{booking_guest_id:'bad',guest_name:'Name'}],[{booking_guest_id:G2,guest_name:null}],[{booking_guest_id:G2,guest_name:42}],[{booking_guest_id:G2,guest_name:'  '}],[{booking_guest_id:G2,guest_name:'x'.repeat(201)}],[{booking_guest_id:G2,guest_name:'A'},{booking_guest_id:G2.toUpperCase(),guest_name:'B'}]])await reject('malformed-names-'+cases.length,{guest_names});
  await reject('missing-idempotency-key',{idempotency_key:''});
  await reject('malformed-json',{},400,{raw:'{'});
  await reject('cross-booking-guest-id',{booking_id:OTHER,booking_code:'OTHER'},404);
  await reject('cross-tenant-guest-id',{client_slug:'sunset',booking_id:TENANT,booking_code:'TENANT'},404);
  await reject('tenant-booking-mismatch',{client_slug:'sunset'},404);
  await reject('booking-code-id-mismatch',{booking_code:'OTHER'},404);
  await reject('conflicting-client-alias',{client:'sunset'});
  const noSql=ledger.length;sandbox.STAFF_ACTIONS_ENABLED=false;await reject('write-disabled',{},403);sandbox.STAFF_ACTIONS_ENABLED=true;
  const acl=sandbox.staffClientAccessAllowed;sandbox.staffClientAccessAllowed=()=>false;await reject('acl-denied',{},403);sandbox.staffClientAccessAllowed=acl;
  await reject('router-auth-denied',{},403,{denied:true});await reject('router-method',{},405,{method:'GET'});
  assert.equal(ledger.length,noSql,'write/auth/method guards precede all SQL');
  await db.exec("ALTER TABLE booking_guests ADD CONSTRAINT test_name_failure CHECK (guest_name <> 'ROLLBACK')");
  await reject('real-second-guest-SQL-failure-rolls-back-first',{guest_names:[{booking_guest_id:G1,guest_name:'Must roll back'},{booking_guest_id:G2,guest_name:'ROLLBACK'}]},500);
  assert.match(sqlErrors.at(-1),/test_name_failure/);
  await db.exec("ALTER TABLE bookings ADD CONSTRAINT test_lead_failure CHECK (guest_name <> 'BLOCK-LEAD')");
  await reject('real-lead-projection-failure-rolls-back-all-guests',{guest_names:[{booking_guest_id:G2,guest_name:'Must roll back too'},{booking_guest_id:G1,guest_name:'BLOCK-LEAD'}]},500);
  assert.match(sqlErrors.at(-1),/test_lead_failure/);assert.equal(sqlErrors.length,2,'only intentional SQL failures');
  assert(audits.filter(a=>a.success===false).length>=2,'rollback failures audited');
  if(CAPTURE){
   const raw=fs.readFileSync(CAPTURE,'utf8'),payload=JSON.parse(raw),beforeReplay=await snapshot();
   assert.equal(payload.edit_type,'guest_names');assert.equal(payload.booking_id,ID);
   assert.equal(payload.guest_names.length,3,'browser bridge covers every durable slot');
   const replay=await call({}, {raw}); // Exact captured request bytes, no fixture repair or reserialization.
   assert.equal(replay.status,200,JSON.stringify(replay.body));
   const committed=await snapshot();
   for(const edit of payload.guest_names)assert.equal(committed.guests.find(g=>g.id===edit.booking_guest_id).guest_name,edit.guest_name);
   assert.equal(committed.bookings[0].guest_name,payload.guest_names.find(g=>g.booking_guest_id===G1).guest_name);
   assert.deepEqual(money(committed),money(beforeReplay),'browser payload preserves all non-name SQL fields');
   fs.writeFileSync(path.join(OUT,'replayed-browser-payload.json'),raw);
   cases.push('unchanged-captured-browser-payload-real-SQL-readback');
  }
  fs.writeFileSync(path.join(OUT,'committed-readback.json'),JSON.stringify(await snapshot(),null,2));
 }catch(e){failure=e;console.error(e.stack);}
 finally{fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify({passed:!failure,cases,ledger,audits,sqlErrors,failure:failure&&failure.stack},null,2));await db.close();}
 if(failure)process.exitCode=1;else console.log('PASS '+cases.length+' real SQL guest-name groups; '+OUT);
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
