'use strict';
// Exact API source owners + real offline SQL. Never starts HTTP or contacts a DB.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite'), acorn = require('acorn');
const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
const { createRoomFillRoutes } = require('./lib/staff-room-fill-routes');
const { buildWolfhouseBookingCreateCommand, executeWolfhouseBookingCreate } = require('./lib/luna-front-desk-accommodation-booking-create-service');
const deny = () => { throw new Error('Network forbidden by offline move verifier'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
for (const t of ['node:http','node:https']) { require(t).request = deny; require(t).get = deny; }
globalThis.fetch = deny;
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[3] || path.join(root, 'tmp/room-selling-move'));
fs.mkdirSync(out, {recursive:true});
const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const nodes = new Map();
for (const n of acorn.parse(api,{ecmaVersion:'latest'}).body) {
  if (n.type === 'FunctionDeclaration') nodes.set(n.id.name, api.slice(n.start,n.end));
  if (n.type === 'VariableDeclaration') for (const d of n.declarations) {
    if (d.id.type === 'Identifier') nodes.set(d.id.name, 'const '+api.slice(d.start,d.end)+';');
  }
}
const stay = {check_in:'2026-10-16',check_out:'2026-10-19'};
function handlers(deps) {
  const ctx = vm.createContext({...deps, require, Date, console, DEFAULT_CLIENT:'wolfhouse-somo',
    BOOKING_MOVE_WRITE_ENABLED:true, SQL_INJECT_RE:/[;'"\\]/, UUID_VALIDATE_RE:/^[0-9a-f-]{36}$/i, DATE_RE:/^\d{4}-\d{2}-\d{2}$/});
  const loaded = new Set(Object.keys(ctx));
  function load(name) {
    if (loaded.has(name) || !nodes.has(name)) return;
    loaded.add(name);
    const text = nodes.get(name);
    for (const [word] of text.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
      if (word.startsWith('move') || word.startsWith('MOVE_') || word === 'parseCalendarDate') load(word);
    }
    vm.runInContext(text,ctx);
  }
  for (const name of ['handleBookingMoveWrite','handleBookingMovePreview','handleBookingMoveTargets']) load(name);
  return ctx;
}
async function state(db) {
  const result = {};
  for (const table of ['bookings','booking_beds','booking_guests','payments','booking_service_records']) {
    result[table] = (await db.query('SELECT * FROM '+table+' ORDER BY id')).rows;
  }
  return result;
}
const mutation = c => /\b(?:UPDATE|INSERT|DELETE)\s+(?:bookings|booking_beds|booking_guests)\b/i.test(c.sql);
async function shared(f, code='SHARED', bed='R4-B1') {
  const id = (await f.db.query(`INSERT INTO bookings(client_id,booking_code,guest_name,status,check_in,check_out,guest_count,requested_room_type)
    VALUES($1,$2,$2,'confirmed',$3,$4,1,'shared') RETURNING id`,[f.user.client_id,code,stay.check_in,stay.check_out])).rows[0].id;
  await f.db.query(`INSERT INTO booking_beds(client_id,booking_id,bed_id,bed_code,room_code,assignment_start_date,assignment_end_date,assignment_type)
    SELECT client_id,$1,id,bed_code,'R4',$3,$4,'guest' FROM beds WHERE bed_code=$2`,[id,bed,stay.check_in,stay.check_out]);
  return id;
}
async function savePrivate(f) {
  const before = await f.routes.handleRoomFillGet({},null,null,f.user);
  const room = before.body.catalogue.find(r=>r.roomCode==='R2');
  const result = await f.routes.handleRoomFillGenderPut(room.roomId,{},f.req({sellingMode:'private',expectedCatalogRevision:before.body.catalogRevision}),null,f.user);
  assert.equal(result.status,200,JSON.stringify(result));
}
async function privateReservation(f) {
  await f.db.query("UPDATE rooms SET selling_mode='private_optional' WHERE room_code='R1'");
  const payload = {...stay,confirm:true,client_slug:'wolfhouse-somo',guest_count:2,guest_name:'Offline A',guests:[{name:'Offline A'},{name:'Offline B'}],phone:'+999****001',package_code:'package_none',room_type:'double',room_preference:'private',payment_choice:'full',selected_bed_codes:['R1-B2','R1-B1'],warnings_acknowledged:true};
  const built = await buildWolfhouseBookingCreateCommand({channel:'luna_whatsapp',trustedClientSlug:'wolfhouse-somo',transportBody:payload,pgClient:f.pg});
  assert.equal(built.ok,true,JSON.stringify(built));
  const result = await executeWolfhouseBookingCreate(f.pg,built.command,{stripeConfig:{stripeLinksEnabled:false}});
  assert.equal(result.ok,true,JSON.stringify(result));
  const id = result.body.booking_id;
  assert.ok((await state(f.db)).bookings.some(b=>b.metadata?.private_room_parent_booking_id===id),'actual creator must create companion reservations');
  return id;
}
async function command(f,id,target) {
  return {...stay,client_slug:'wolfhouse-somo',booking_id:id,
    booking_bed_id:(await f.db.query('SELECT id FROM booking_beds WHERE booking_id=$1 ORDER BY bed_code LIMIT 1',[id])).rows[0].id,
    target_bed_id:(await f.db.query('SELECT id FROM beds WHERE bed_code=$1',[target])).rows[0].id,idempotency_key:'offline-move-'+id};
}
async function refuse(f,body,label) {
  const before = await state(f.db), start = f.calls.length;
  const response = await f.handlers.handleBookingMoveWrite(f.req(body),null,f.user);
  const after = await state(f.db), sql = f.calls.slice(start);
  fs.writeFileSync(path.join(out,label+'-state.json'),JSON.stringify({response,before,after,sql},null,2));
  assert.equal(response.status,409,JSON.stringify(response));
  assert.equal(response.body.error,'private_room_reservation_requires_review');
  assert.equal(response.body.moved,false);
  assert.equal(response.body.would_mutate,false);
  assert.deepEqual(after,before,'refusal preserves parent, companions, assignments, guests, payments and services');
  assert.ok(!sql.some(mutation),'refusal before mutation, not just rollback');
  const begin = sql.findIndex(c=>c.sql==='BEGIN');
  const lock = sql.findIndex(c=>/FOR UPDATE OF bed/.test(c.sql));
  assert.ok(begin>=0 && lock>begin,'inventory must be locked within transaction');
}
const tests = {};
tests.into_private = async f => {
  await savePrivate(f);
  for (let i=1;i<=2;i++) {
    const id = await shared(f,'GROUP-'+i,'R4-B'+i);
    await refuse(f,await command(f,id,'R2-B'+i),'into-private-'+i);
  }
};
tests.out_of_private_optional = async f => {
  const id = await privateReservation(f);
  await refuse(f,await command(f,id,'R4-B1'),'out-of-private-optional');
};
tests.shared_and_noop = async f => {
  const id = await shared(f), body = await command(f,id,'R2-B1');
  const response = await f.handlers.handleBookingMoveWrite(f.req(body),null,f.user);
  assert.equal(response.status,200,JSON.stringify(response));
  assert.equal(response.body.moved,true,JSON.stringify(response));
  assert.equal((await f.db.query('SELECT bed_code FROM booking_beds WHERE booking_id=$1',[id])).rows[0].bed_code,'R2-B1');
  const before = await state(f.db), start = f.calls.length;
  const noop = await f.handlers.handleBookingMoveWrite(f.req(body),null,f.user);
  assert.equal(noop.body.idempotent,true,JSON.stringify(noop));
  assert.equal(noop.body.moved,false);
  assert.deepEqual(await state(f.db),before);
  assert.ok(!f.calls.slice(start).some(mutation));
  fs.writeFileSync(path.join(out,'shared-state.json'),JSON.stringify({response,noop,before,after:await state(f.db)},null,2));
};
tests.optional_shared = async f => {
  await f.db.query("UPDATE rooms SET selling_mode='private_optional' WHERE room_code='R2'");
  await tests.shared_and_noop(f);
};
tests.private_noop = async f => {
  const id = await privateReservation(f), body = await command(f,id,'R1-B1');
  const before = await state(f.db), start = f.calls.length;
  const response = await f.handlers.handleBookingMoveWrite(f.req(body),null,f.user);
  assert.equal(response.status,200,JSON.stringify(response));
  assert.equal(response.body.idempotent,true);
  assert.equal(response.body.moved,false);
  assert.deepEqual(await state(f.db),before);
  assert.ok(!f.calls.slice(start).some(mutation));
};
tests.private_offers = async f => {
  await savePrivate(f);
  const id = await shared(f), body = await command(f,id,'R2-B1');
  const preview = await f.handlers.handleBookingMovePreview(f.req(body),null,f.user);
  const targets = await f.handlers.handleBookingMoveTargets(f.req(body),null,f.user);
  fs.writeFileSync(path.join(out,'private-offers.json'),JSON.stringify({preview,targets},null,2));
  assert.equal(preview.body.can_move,false,JSON.stringify(preview));
  assert.equal(preview.body.reason,'private_room_reservation_requires_review');
  assert.ok(targets.body.targets.filter(t=>t.room_code==='R2').every(t=>!t.available));
  const sharedPreview = await f.handlers.handleBookingMovePreview(f.req(await command(f,id,'R4-B2')),null,f.user);
  assert.equal(sharedPreview.body.can_move,true,JSON.stringify(sharedPreview));
  const privateId = await privateReservation(f), privateBody = await command(f,privateId,'R4-B2');
  const privatePreview = await f.handlers.handleBookingMovePreview(f.req(privateBody),null,f.user);
  const privateTargets = await f.handlers.handleBookingMoveTargets(f.req(privateBody),null,f.user);
  assert.equal(privatePreview.body.can_move,false,JSON.stringify(privatePreview));
  assert.equal(privatePreview.body.reason,'private_room_reservation_requires_review');
  assert.ok(privateTargets.body.targets.every(t=>!t.available));
  const noop = await f.handlers.handleBookingMovePreview(f.req(await command(f,privateId,'R1-B1')),null,f.user);
  assert.equal(noop.body.idempotent,true);
};
tests.fresh_policy = async f => {
  const id = await shared(f), body = await command(f,id,'R2-B1');
  const query = f.pg.query;
  let changed = false;
  f.pg.query = async (sql,args) => {
    // Deterministic committed policy change between preflight and BEGIN, not a
    // concurrency proof: all reads/writes still execute against real PGlite.
    if (sql==='BEGIN' && !changed) {
      changed = true;
      await f.db.query("UPDATE rooms SET selling_mode='private' WHERE room_code='R2'");
    }
    return query(sql,args);
  };
  await refuse(f,body,'fresh-policy');
  assert.equal(changed,true);
};
(async () => {
  const results = [];
  const names = process.argv[2] && process.argv[2]!=='all' ? [process.argv[2]] : Object.keys(tests);
  for (const name of names) {
    assert.equal(typeof tests[name],'function','Unknown case '+name);
    const db = new PGlite(), calls = [];
    const pg = {query:async(sql,args)=>{ calls.push({sql,args}); return db.query(sql,args); }};
    try {
      await seedOfflineBookingDb(db,stay);
      await db.exec("ALTER TABLE payments ADD created_at timestamptz DEFAULT now(); ALTER TYPE booking_status ADD VALUE 'blocked'; ALTER TABLE bookings ADD room_preference text; ALTER TABLE bookings ADD room_to_block_id uuid; ALTER TABLE bookings ADD block_type text; ALTER TABLE clients ADD settings jsonb DEFAULT '{}'; ALTER TABLE rooms ADD private_priority int DEFAULT 0; ALTER TABLE booking_beds ADD updated_at timestamptz DEFAULT now();");
      // Shared seedOfflineBookingDb applies migration 111 once.
      const user = {client_slug:'wolfhouse-somo',client_id:(await db.query('SELECT id FROM clients LIMIT 1')).rows[0].id,role:'operator',staff_user_id:'offline'};
      const deps = {withPgClient:async f=>f(pg),sendJSON:(_r,status,body)=>({status,body}),send400:(_r,error)=>({status:400,body:{error}}),readBody:async r=>JSON.stringify(r.body),appendAuditLog:()=>{}};
      await tests[name]({db,pg,calls,user,req:body=>({body,headers:{'content-type':'application/json'}}),handlers:handlers(deps),routes:createRoomFillRoutes(deps)});
      results.push({name,passed:true}); console.log('PASS',name);
    } catch (e) {
      results.push({name,passed:false,error:e.stack}); console.error('FAIL',name,e); process.exitCode=1;
    } finally {
      fs.writeFileSync(path.join(out,name+'-sql.json'),JSON.stringify(calls,null,2));
      await db.close();
    }
  }
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({apiSha256:crypto.createHash('sha256').update(api).digest('hex'),results},null,2));
  process.exitCode = results.some(r=>!r.passed) ? 1 : 0;
})().catch(e=>{console.error(e);process.exitCode=1;});
