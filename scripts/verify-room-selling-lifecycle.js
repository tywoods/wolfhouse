'use strict';
// Offline real SQL + exact source-extracted API owners; never starts the server.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const acorn = require('acorn');
const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
const { createRoomFillRoutes } = require('./lib/staff-room-fill-routes');
const { buildWolfhouseBookingCreateCommand, executeWolfhouseBookingCreate } = require('./lib/luna-front-desk-accommodation-booking-create-service');
const privateBlocks = require('./lib/staff-private-room-blocks');
const { getBedCalendarBlocksQuery } = require('./lib/staff-bed-calendar-queries');
const deny = () => { throw new Error('Network forbidden by offline lifecycle verifier'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
for (const t of ['node:http','node:https']) { require(t).request = deny; require(t).get = deny; }
globalThis.fetch = deny;
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[3] || path.join(root, 'tmp/room-selling-lifecycle'));
fs.mkdirSync(out, { recursive: true });
const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const ast = acorn.parse(api, { ecmaVersion: 'latest', sourceType: 'script' });
function extract(name) {
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id.name === name) return api.slice(node.start, node.end);
    if (node.type === 'VariableDeclaration') for (const d of node.declarations) {
      if (d.id.name === name) return 'const ' + api.slice(d.start, d.end) + ';';
    }
  }
  throw new Error('Missing API owner ' + name);
}
const payload = { confirm:true, client_slug:'wolfhouse-somo', check_in:'2026-10-16', check_out:'2026-10-19', guest_count:2, guest_name:'Offline A', guests:[{name:'Offline A'},{name:'Offline B'}], phone:'+999****001', package_code:'package_none', room_type:'double', room_preference:'private', payment_choice:'full', selected_bed_codes:['R1-B2','R1-B1'], warnings_acknowledged:true };
// Load the real whole-booking date writer and its local dependencies without
// starting HTTP. Service rows are read from the same offline SQL database.
function dateWriter(pg) {
  const context = vm.createContext({
    require, DATE_RE:/^\d{4}-\d{2}-\d{2}$/,
    EDIT_WRITE_PACKAGE_MIN_NIGHTS:6,
    ...require('./lib/booking-invoice-totals'),
    ...require('./lib/staff-booking-services-schedule'),
    calculateWolfhouseQuote:require('./lib/wolfhouse-quote-calculator').calculateWolfhouseQuote,
    appendAuditLog:()=>{}, withPgClient:async f=>f(pg),
    sendJSON:(_res,status,body)=>({status,body}), send400:(_res,error)=>({status:400,body:{error}}),
    loadBookingServiceRecords:async (client,slug,code)=>({rows:(await client.query(
      'SELECT * FROM booking_service_records WHERE client_slug=$1 AND booking_code=$2',[slug,code])).rows}),
  });
  const functions = new Set(ast.body.filter(n=>n.type==='FunctionDeclaration').map(n=>n.id.name));
  const loaded = new Set(Object.keys(context));
  function load(name) {
    if (loaded.has(name)) return;
    loaded.add(name);
    const text = extract(name);
    for (const [word] of text.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
      if (functions.has(word) || /^[A-Z][A-Z_]+_SQL$/.test(word)) load(word);
    }
    vm.runInContext(text,context);
  }
  load('MOVE_PREVIEW_NON_BLOCKING_STATUSES');
  load('handleBookingEditWriteDates');
  return (id,body)=>context.handleBookingEditWriteDates(null,body,{},Date.now(),'offline','wolfhouse-somo',id,null);
}
async function dateState(db) {
  const state = {};
  for (const table of ['bookings','booking_beds','booking_guests','payments','booking_service_records']) {
    state[table] = (await db.query('SELECT * FROM '+table+' ORDER BY id')).rows;
  }
  return state;
}
const tests = {};
tests.private_dates = async ({db,pg,calls}) => {
  const id = await createPrivate(db,pg);
  await db.exec('ALTER TABLE booking_beds ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()');
  const before = await dateState(db);
  const companions = before.bookings.filter(b=>b.metadata?.private_room_parent_booking_id===id);
  assert.ok(companions.length,'fixture creates actual private companion bookings');
  const start = calls.length;
  const response = await dateWriter(pg)(id,{check_in:'2026-10-20',check_out:'2026-10-23'});
  const after = await dateState(db);
  fs.writeFileSync(path.join(out,'private-dates-state.json'),JSON.stringify({response,before,after},null,2));
  console.log('Disjoint private date response:',JSON.stringify(response));
  assert.equal(response.status,409,'private whole-booking move must not strand original companion locks');
  assert.equal(response.body.error,'private_room_reservation_requires_review');
  assert.equal(response.body.updated,false);
  assert.deepEqual(after,before,'parent, companions, assignments, guests, money and services remain byte-identical');
  assert.ok(!calls.slice(start).some(c=>/\b(?:UPDATE|INSERT|DELETE)\s+(?:bookings|booking_beds|booking_guests)\b/i.test(c.sql)),
    'refusal precedes mutation SQL, not merely rollback');
};
tests.private_date_preservation = async ({db,pg,calls}) => {
  const id = await createPrivate(db,pg);
  const before = await dateState(db);
  const start = calls.length;
  const writer = dateWriter(pg);
  const noop = await writer(id,{check_in:payload.check_in,check_out:payload.check_out});
  assert.equal(noop.status,200,JSON.stringify(noop));
  assert.equal(noop.body.idempotent,true);
  const shrink = await writer(id,{check_in:'2026-10-17',check_out:payload.check_out});
  assert.equal(shrink.body.updated,false,JSON.stringify(shrink));
  const guest = before.booking_guests.find(g=>g.booking_id===id);
  const {editGuestDates} = require('./lib/booking-guest-dates');
  const observations = {noop,shrink,guest:[]};
  for (const [check_in,check_out,error] of [
    ['2026-10-20','2026-10-23','private_room_reservation_requires_review'],
    [payload.check_in,'2026-10-20','private_room_reservation_requires_review'],
    ['2026-10-17',payload.check_out,'date_conflict'],
  ]) {
    const response = await editGuestDates(pg,{client_slug:payload.client_slug,booking_id:id,booking_guest_id:guest.id,
      expected_check_in:payload.check_in,expected_check_out:payload.check_out,check_in,check_out});
    assert.equal(response.status,409,JSON.stringify(response));
    assert.equal(response.body.error,error);
    assert.equal(response.body.updated,false);
    observations.guest.push(response);
  }
  assert.deepEqual(await dateState(db),before,'private no-op and refused shrink/guest changes preserve all rows');
  assert.ok(!calls.slice(start).some(c=>/\b(?:UPDATE|INSERT|DELETE)\s+(?:bookings|booking_beds|booking_guests)\b/i.test(c.sql)));
  fs.writeFileSync(path.join(out,'private-date-preservation.json'),JSON.stringify(observations,null,2));
};
tests.shared_dates = async ({db,pg}) => {
  const shared = {...payload,guest_count:1,guest_name:'Offline Shared',guests:[{name:'Offline Shared'}],
    room_type:'shared',room_preference:'shared',group_gender:'male',payment_choice:'no_payment_yet',
    selected_bed_codes:['R2-B1'],idempotency_key:'date-preservation-shared'};
  const built = await buildWolfhouseBookingCreateCommand({channel:'manual_staff',trustedClientSlug:payload.client_slug,transportBody:shared});
  assert.equal(built.ok,true,JSON.stringify(built));
  const created = await executeWolfhouseBookingCreate(pg,built.command,{stripeConfig:{stripeLinksEnabled:false}});
  assert.equal(created.ok,true,JSON.stringify(created));
  await db.exec('ALTER TABLE booking_beds ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()');
  const before = await dateState(db);
  const id = created.body.booking_id;
  const response = await dateWriter(pg)(id,{check_in:'2026-10-20',check_out:'2026-10-23'});
  assert.equal(response.status,200,JSON.stringify(response));
  assert.equal(response.body.updated,true,JSON.stringify(response));
  const after = await dateState(db);
  const booking = after.bookings.find(b=>b.id===id);
  assert.equal(booking.check_in.toISOString().slice(0,10),'2026-10-20');
  assert.equal(booking.check_out.toISOString().slice(0,10),'2026-10-23');
  const beds = (await db.query('SELECT bed_code,assignment_start_date::text AS start,assignment_end_date::text AS end FROM booking_beds WHERE booking_id=$1',[id])).rows;
  assert.deepEqual(beds,[{bed_code:'R2-B1',start:'2026-10-20',end:'2026-10-23'}]);
  for (const key of ['booking_guests','payments','booking_service_records']) assert.deepEqual(after[key],before[key]);
  assert.equal(booking.total_amount_cents,before.bookings.find(b=>b.id===id).total_amount_cents);
  fs.writeFileSync(path.join(out,'shared-dates-state.json'),JSON.stringify({response,before,after},null,2));
};
tests.placement = async ({db, routes, user, req}) => {
  const get = await routes.handleRoomFillGet({}, null, null, user);
  const room = get.body.catalogue.find(r => r.roomCode === 'R2');
  for (const mode of ['private', 'shared', 'private_optional']) {
    const current = await routes.handleRoomFillGet({}, null, null, user);
    const save = await routes.handleRoomFillGenderPut(room.roomId, {}, req({sellingMode:mode, expectedCatalogRevision:current.body.catalogRevision}), null, user);
    assert.equal(save.status, 200);
    for (const fillMode of ['room', 'house']) {
      const draft = {...save.body.suggestedPolicy, fillMode, roomPrioritySource:'custom', roomPriority:[room.roomId, ...save.body.suggestedPolicy.roomPriority.filter(id => id !== room.roomId)]};
      const response = await routes.handleRoomFillPreview({}, req({expectedCatalogRevision:save.body.catalogRevision, policySource:'draft', draftPolicy:draft, checkIn:payload.check_in, checkOut:payload.check_out, partySize:1, groupGender:'male', roomPreference:'shared', splitPermission:false}), null, user);
      assert.equal(response.status, 200, JSON.stringify(response));
      const selected = response.body.decision.selected.some(r => r.roomCode === 'R2');
      if (mode === 'private' || fillMode === 'room') assert.equal(selected, mode !== 'private', mode + ' / ' + fillMode + ': saved Private must not be offered bed-by-bed');
      const evaluated = response.body.decision.rooms.find(r => r.roomCode === 'R2');
      assert.equal(evaluated.reasons.some(r => r.code === 'protected_private_room'), mode === 'private');
    }
  }
};
tests.manual_create = async ({db,pg}) => {
  const count = async () => (await db.query('SELECT (SELECT count(*) FROM bookings)::int AS bookings,(SELECT count(*) FROM booking_beds)::int AS beds')).rows[0];
  for (const mode of ['private','shared','private_optional']) {
    await db.query('UPDATE rooms SET selling_mode=$1 WHERE room_code=$2',[mode,'R2']);
    for (const [i,bed] of ['R2-B1','R2-B2'].entries()) {
      const p = {...payload, guest_count:1, guest_name:'Offline Shared', guests:[{name:'Offline Shared'}], room_type:'shared', room_preference:'shared', group_gender:'male', payment_choice:'no_payment_yet', selected_bed_codes:[bed], idempotency_key:mode+'-'+i};
      const built = await buildWolfhouseBookingCreateCommand({channel:'manual_staff', trustedClientSlug:'wolfhouse-somo', transportBody:p});
      assert.equal(built.ok,true,JSON.stringify(built));
      const before = await count();
      const result = await executeWolfhouseBookingCreate(pg,built.command,{stripeConfig:{stripeLinksEnabled:false}});
      assert.equal(result.ok,mode !== 'private','Staff shared create in '+mode+': '+JSON.stringify(result));
      if (mode === 'private') { assert.equal(result.status,409); assert.deepEqual(await count(),before,'rejected write leaves no rows'); }
    }
    await db.exec("UPDATE bookings SET status='cancelled';");
  }
};
tests.manual_preview = async ({db,user,req,handlers}) => {
  const {handleManualBookingPreview} = handlers(['handleManualBookingPreview']);
  for (const mode of ['private','shared','private_optional']) {
    await db.query('UPDATE rooms SET selling_mode=$1 WHERE room_code=$2',[mode,'R2']);
    const result = await handleManualBookingPreview(req({...payload,guest_count:1,selected_bed_codes:['R2-B1'],room_preference:'shared',room_type:'shared'}),null,user);
    assert.equal(result.status,200,JSON.stringify(result));
    assert.equal(result.body.availability.is_valid,mode !== 'private','Manual bed preview must reject saved Private: '+JSON.stringify(result));
    if (mode === 'private') assert.ok(result.body.availability.blockers.includes('private_room_requires_private_booking'));
  }
};
async function createPrivate(db,pg) {
  await db.query("UPDATE rooms SET selling_mode='private_optional' WHERE room_code='R1'");
  const built = await buildWolfhouseBookingCreateCommand({channel:'luna_whatsapp',trustedClientSlug:'wolfhouse-somo',transportBody:payload,pgClient:pg});
  assert.equal(built.ok,true,JSON.stringify(built));
  const result = await executeWolfhouseBookingCreate(pg,built.command,{stripeConfig:{stripeLinksEnabled:false}});
  assert.equal(result.ok,true,JSON.stringify(result));
  return result.body.booking_id;
}
tests.cancel = async ({db,pg,user,req,handlers}) => {
  const id = await createPrivate(db,pg);
  const {handleBookingCancel} = handlers(['EDIT_PREVIEW_BOOKING_BY_ID_SQL','EDIT_PREVIEW_BOOKING_BY_CODE_SQL','BOOKING_CANCEL_COUNT_BEDS_SQL','BOOKING_CANCEL_DELETE_BEDS_SQL','BOOKING_CANCEL_UPDATE_STATUS_SQL','bookingStatusIsCancelled','bookingCancelSnapshot','handleBookingCancel']);
  await db.query("INSERT INTO clients(id,slug) VALUES(gen_random_uuid(),'other-tenant')");
  await db.query(`INSERT INTO bookings(client_id,booking_code,status,metadata) VALUES
    ($1,'UNRELATED','blocked',jsonb_build_object('private_room_parent_booking_id','different-parent')),
    ((SELECT id FROM clients WHERE slug='other-tenant'),'OTHER-TENANT','blocked',jsonb_build_object('private_room_parent_booking_id',$2::text))`,[user.client_id,id]);
  const response = await handleBookingCancel(req({client_slug:'wolfhouse-somo',booking_id:id,idempotency_key:'offline-cancel'}),null,user);
  assert.equal(response.status,200,JSON.stringify(response)); assert.equal(response.body.cancelled,true);
  const blocks = (await db.query(getBedCalendarBlocksQuery(),['wolfhouse-somo',payload.check_in,payload.check_out])).rows.filter(r=>r.room_code==='R1');
  assert.equal(blocks.length,0,'ordinary parent cancellation releases its whole private reservation');
  assert.deepEqual((await db.query("SELECT status::text FROM bookings WHERE booking_code IN ('UNRELATED','OTHER-TENANT')")).rows.map(r=>r.status),['blocked','blocked']);
  const retry = await handleBookingCancel(req({client_slug:'wolfhouse-somo',booking_id:id,idempotency_key:'offline-cancel'}),null,user);
  assert.equal(retry.body.idempotent,true);
};
tests.cancel_rollback = async ({db,pg,user,req,handlers}) => {
  const id = await createPrivate(db,pg);
  const {handleBookingCancel} = handlers(['EDIT_PREVIEW_BOOKING_BY_ID_SQL','EDIT_PREVIEW_BOOKING_BY_CODE_SQL','BOOKING_CANCEL_COUNT_BEDS_SQL','BOOKING_CANCEL_DELETE_BEDS_SQL','BOOKING_CANCEL_UPDATE_STATUS_SQL','bookingStatusIsCancelled','bookingCancelSnapshot','handleBookingCancel']);
  await db.exec(`CREATE FUNCTION fail_companion_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.metadata ? 'private_room_parent_booking_id' THEN RAISE EXCEPTION 'offline forced companion failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_companion_cancel BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION fail_companion_cancel();`);
  const response = await handleBookingCancel(req({client_slug:'wolfhouse-somo',booking_id:id,idempotency_key:'rollback-cancel'}),null,user);
  assert.equal(response.status,500);
  assert.equal((await db.query('SELECT status::text FROM bookings WHERE id=$1',[id])).rows[0].status,'confirmed');
  assert.equal((await db.query(getBedCalendarBlocksQuery(),['wolfhouse-somo',payload.check_in,payload.check_out])).rows.filter(r=>r.room_code==='R1').length,5,'parent and companions roll back together');
};
tests.normalized_room = async ({db,pg,user}) => {
  const id = await createPrivate(db,pg);
  await db.query("UPDATE booking_beds SET room_code=' r1 ' WHERE booking_id=$1",[id]);
  const stranger = (await db.query("INSERT INTO bookings(client_id,booking_code,status) VALUES($1,'STRANGER','confirmed') RETURNING id",[user.client_id])).rows[0].id;
  await db.query(`INSERT INTO booking_beds(client_id,booking_id,bed_id,bed_code,room_code,assignment_start_date,assignment_end_date,assignment_type)
    SELECT client_id,$1,id,bed_code,'R1','2026-10-17','2026-10-18','guest' FROM beds WHERE bed_code='R1-B3'`,[stranger]);
  await pg.query('BEGIN');
  const result = await privateBlocks.editWriteSyncPrivateRoomBedBlocks(pg,'wolfhouse-somo',{booking_id:id,check_in:payload.check_in,check_out:payload.check_out},true);
  await pg.query('ROLLBACK');
  assert.equal(result.error,'private_room_room_not_empty','case/whitespace drift must still resolve inventory and reject occupied companion: '+JSON.stringify(result));
  assert.equal(result.conflicts[0].bed_code,'R1-B3');
  assert.equal((await db.query("SELECT status::text FROM bookings WHERE metadata->>'private_room_parent_booking_id'=$1",[id])).rows[0].status,'blocked','rejected conversion keeps old lock');
};
tests.unresolved_room = async ({db,pg}) => {
  const id = await createPrivate(db,pg);
  await db.query("UPDATE booking_beds SET room_code='REMOVED-ROOM' WHERE booking_id=$1",[id]);
  await pg.query('BEGIN');
  const result = await privateBlocks.editWriteSyncPrivateRoomBedBlocks(pg,'wolfhouse-somo',{booking_id:id,check_in:payload.check_in,check_out:payload.check_out},true);
  await pg.query('ROLLBACK');
  assert.equal(result.error,'private_room_inventory_unresolved','empty lookup is not proof of full-room ownership: '+JSON.stringify(result));
  assert.equal((await db.query("SELECT status::text FROM bookings WHERE metadata->>'private_room_parent_booking_id'=$1",[id])).rows[0].status,'blocked');
};
(async () => {
  const names = process.argv[2] && process.argv[2] !== 'all' ? [process.argv[2]] : Object.keys(tests);
  const results = [];
  for (const name of names) {
    assert.equal(typeof tests[name], 'function', 'Unknown case ' + name);
    const db = new PGlite();
    const calls = [];
    const pg = { query:async (sql,args) => { calls.push({sql,args}); return db.query(sql,args); } };
    try {
      await seedOfflineBookingDb(db, payload);
      await db.exec("ALTER TYPE booking_status ADD VALUE 'blocked'; ALTER TABLE bookings ADD room_preference text; ALTER TABLE bookings ADD amount_paid_cents int DEFAULT 0; ALTER TABLE bookings ADD room_to_block_id uuid; ALTER TABLE bookings ADD block_type text; ALTER TABLE payments ADD created_at timestamptz DEFAULT now(); ALTER TABLE clients ADD settings jsonb DEFAULT '{}';");
      // Shared seedOfflineBookingDb applies migration 111 once.
      const user = {client_id:(await db.query("SELECT id FROM clients WHERE slug='wolfhouse-somo'")).rows[0].id, client_slug:'wolfhouse-somo', role:'operator', staff_user_id:'offline'};
      const deps = {sendJSON:(_res,status,body) => ({status,body}), readBody:async r => JSON.stringify(r.body), withPgClient:async f => f(pg), appendAuditLog:() => {}};
      const req = body => ({body,headers:{'content-type':'application/json'}});
      const handlers = names => {
        const context = vm.createContext({...deps, ...privateBlocks, ...require('./lib/staff-manual-booking-preview-queries'), ...require('./lib/staff-manual-booking-availability'), require:require('node:module').createRequire(path.join(__dirname,'staff-query-api.js')), DEFAULT_CLIENT:'wolfhouse-somo', SQL_INJECT_RE:/[;'"\\]/, UUID_VALIDATE_RE:/^[0-9a-f-]{36}$/i, STAFF_ACTIONS_ENABLED:true, MANUAL_BOOKING_ENABLED:true, send400:(_r,error) => ({status:400,body:{error}})});
        vm.runInContext(names.map(extract).join('\n') + '\nglobalThis.handlers={' + names.join(',') + '};', context);
        return context.handlers;
      };
      await tests[name]({db,pg,calls,user,req,handlers,routes:createRoomFillRoutes(deps)});
      results.push({name,passed:true}); console.log('PASS', name);
    } finally {
      fs.writeFileSync(path.join(out,name+'-sql.json'), JSON.stringify(calls,null,2));
      await db.close();
    }
  }
  fs.writeFileSync(path.join(out,'results.json'), JSON.stringify(results,null,2));
})().catch(e => { console.error(e); process.exitCode = 1; });
