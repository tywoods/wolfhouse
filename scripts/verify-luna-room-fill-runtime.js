'use strict';
// Real offline SQL, Staff save/readback and canonical Luna availability. No server or network.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
const { createRoomFillRoutes } = require('./lib/staff-room-fill-routes');
const { buildWolfhouseAvailabilityCommand, executeWolfhouseAvailabilityCheck } = require('./lib/luna-front-desk-accommodation-availability-service');
const quoteConfig = require('./lib/wolfhouse-quote-calculator').loadConfig();
const deny = () => { throw new Error('Network forbidden by offline room-fill regression'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
for (const transport of ['node:http', 'node:https']) {
  require(transport).request = deny; require(transport).get = deny;
}
globalThis.fetch = deny;

async function fixture() {
  const db = new PGlite();
  await seedOfflineBookingDb(db, { phone: '+999****001', guest_name: 'Offline Fill' });
  await db.exec(`ALTER TABLE clients ADD settings jsonb DEFAULT '{}';
    UPDATE rooms SET active = room_code IN ('R1','R2');
    UPDATE rooms SET room_type='mixed', gender_strategy='Flexible', capacity=2,
      can_be_matrimonial=false, often_used_by_operator=false, selling_mode='shared',
      fill_priority=CASE room_code WHEN 'R1' THEN 1 ELSE 2 END WHERE active;
    UPDATE beds SET active=bed_number<=2 WHERE room_id IN (SELECT id FROM rooms WHERE active);`);
  const user = { ...(await db.query("SELECT id AS client_id, slug AS client_slug FROM clients WHERE slug='wolfhouse-somo'")).rows[0], role: 'operator', staff_user_id: 'offline' };
  const routes = createRoomFillRoutes({ withPgClient: fn => fn(db), readBody: async req => JSON.stringify(req.body), appendAuditLog: () => {}, sendJSON: (_res, status, body) => ({ status, body }) });
  const req = body => ({ headers: { host: 'staff.invalid', origin: 'https://staff.invalid' }, body });
  async function get() {
    const result = await routes.handleRoomFillGet({}, {}, {}, user);
    assert.equal(result.status, 200, JSON.stringify(result)); return result.body;
  }
  async function save(mode, first = ['R1', 'R2']) {
    const before = await get();
    const ids = new Map(before.catalogue.map(room => [room.roomCode, room.roomId]));
    const order = [...first.map(code => ids.get(code)), ...before.catalogue.filter(room => !first.includes(room.roomCode)).map(room => room.roomId)];
    const result = await routes.handleRoomFillPut({}, req({ contractVersion: 1, fillMode: mode, roomPrioritySource: 'custom', roomPriority: order, expectedSettingsRevision: before.settingsRevision, expectedCatalogRevision: before.catalogRevision }), {}, user);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal((await get()).policy.fillMode, mode);
    return result.body;
  }
  async function preview() {
    const saved = await get();
    const result = await routes.handleRoomFillPreview({}, req({ policySource: 'saved', expectedSettingsRevision: saved.settingsRevision, expectedCatalogRevision: saved.catalogRevision, checkIn: '2026-07-06', checkOut: '2026-07-09', partySize: 1, groupGender: 'mixed', roomPreference: 'shared' }), {}, user);
    assert.equal(result.status, 200, JSON.stringify(result)); return result.body;
  }
  async function place(assignmentMode, extra = {}, options = {}) {
    const built = buildWolfhouseAvailabilityCommand({ channel: assignmentMode ? 'booking_preflight' : 'bot_http', trustedClientSlug: options.clientSlug || 'wolfhouse-somo', assignmentMode, demoCalendarEnrichment: options.demoCalendarEnrichment === true, quoteConfig, transportBody: { check_in: '2026-07-06', check_out: '2026-07-09', guest_count: 1, room_type: 'shared', room_preference: 'shared', group_gender: 'mixed', ...extra } });
    assert.equal(built.ok, true);
    return executeWolfhouseAvailabilityCheck(db, built.command);
  }
  async function occupy(code = 'R1-B1', start = '2026-07-06', end = '2026-07-09', type = 'guest') {
    const booking = (await db.query("INSERT INTO bookings(client_id,booking_code,status,check_in,check_out) VALUES($1,$2,'confirmed',$3,$4) RETURNING id", [user.client_id, `OFFLINE-${code}-${start}`, start, end])).rows[0];
    await db.query(`INSERT INTO booking_beds(client_id,booking_id,bed_id,bed_code,room_code,assignment_start_date,assignment_end_date,assignment_type)
      SELECT client_id,$1,id,bed_code,(SELECT room_code FROM rooms WHERE id=beds.room_id),$3,$4,$5 FROM beds WHERE bed_code=$2`, [booking.id, code, start, end, type]);
  }
  return { db, user, get, save, preview, place, occupy };
}

test('saved Fill House chooses the emptier room in capacity and booking assignment, matching Staff preview', async () => {
  const f = await fixture();
  try {
    await f.occupy(); await f.save('house');
    assert.equal((await f.preview()).decision.selected[0].roomCode, 'R2');
    for (const assignmentMode of [false, true]) {
      const result = await f.place(assignmentMode);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.body.date_rule_ok, true);
      assert.equal(result.body.selected_room_code, 'R2', `saved House must change real placement (assignment=${assignmentMode})`);
    }
  } finally { await f.db.close(); }
});

for (const mode of ['room', 'house']) test(`saved ${mode}: changed priority wins before old ranking`, async () => {
  const f = await fixture();
  try {
    if (mode === 'room') await f.occupy();
    for (const first of ['R1', 'R2']) {
      await f.save(mode, first === 'R1' ? ['R1','R2'] : ['R2','R1']);
      assert.equal((await f.preview()).decision.selected[0].roomCode, first);
      for (const assignment of [false, true]) assert.equal((await f.place(assignment)).body.selected_room_code, first);
    }
  } finally { await f.db.close(); }
});

test('ordinary enrichment cannot resurrect inactive/CSV rooms under a saved policy', async () => {
  const f = await fixture();
  try {
    await f.occupy(); await f.save('house');
    for (const assignment of [false, true]) {
      const result = await f.place(assignment, {}, { demoCalendarEnrichment: true });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.body.selected_room_code, 'R2');
      assert.equal(result.body.available_count, 3);
    }
  } finally { await f.db.close(); }
});

test('Fill House balances an unavoidable split; Fill Room fills in priority order', async () => {
  const f = await fixture();
  try {
    await f.db.exec("UPDATE rooms SET active=true,room_type='mixed',gender_strategy='Flexible',capacity=2,can_be_matrimonial=false,often_used_by_operator=false WHERE room_code='R3'; UPDATE beds SET active=bed_number<=2 WHERE room_id=(SELECT id FROM rooms WHERE room_code='R3')");
    for (const mode of ['house', 'room']) {
      await f.save(mode, ['R2','R1','R3']);
      for (const assignment of [false, true]) {
        const result = await f.place(assignment, { guest_count: 4 });
        assert.equal(result.ok, true, JSON.stringify(result));
        const counts = Object.fromEntries(['R1','R2','R3'].map(code => [code, result.body.selected_bed_codes.filter(bed => bed.startsWith(code + '-')).length]));
        assert.deepEqual(counts, mode === 'house' ? { R1:1,R2:2,R3:1 } : { R1:2,R2:2,R3:0 }, `mode=${mode} assignment=${assignment}`);
      }
    }
  } finally { await f.db.close(); }
});

test('policy cannot override gender, private conversion, whole-stay blocks or party-together constraints', async () => {
  const f = await fixture();
  try {
    await f.save('room'); await f.occupy();
    for (const assignment of [false,true]) assert.equal((await f.place(assignment, { guest_count: 2 })).body.selected_room_code, 'R2');
    await f.db.exec("UPDATE rooms SET room_type='female_only',gender_strategy='female_only' WHERE room_code='R1'");
    assert.equal((await f.place(true, { group_gender: 'male' })).body.selected_room_code, 'R2');
    await f.db.exec("UPDATE rooms SET room_type='mixed',gender_strategy='Flexible',selling_mode='private' WHERE room_code='R1'");
    for (const assignment of [false,true]) assert.equal((await f.place(assignment)).body.selected_room_code, 'R2');
    await f.db.exec("UPDATE rooms SET selling_mode='private_optional' WHERE room_code='R1'");
    for (const assignment of [false,true]) {
      assert.equal((await f.place(assignment)).body.selected_room_code, 'R1');
      assert.notEqual((await f.place(assignment, { room_type: 'private', room_preference: 'private' })).body.selected_room_code, 'R1');
    }
    await f.occupy('R1-B2','2026-07-07','2026-07-08','operator_block');
    for (const assignment of [false,true]) assert.equal((await f.place(assignment)).body.selected_room_code, 'R2');
  } finally { await f.db.close(); }
});

test('invalid/stale policies fail closed for auto-selection, not for accepted exact beds; input cannot forge a policy', async () => {
  const f = await fixture();
  try {
    await f.save('room', ['R2','R1']);
    assert.equal((await f.place(true, { room_fill_policy: { fillMode:'room', roomPriority:['R1'] } })).body.selected_room_code, 'R2');
    const explicit = { guest_count: 2, selected_bed_codes: ['R1-B2','R1-B1'] };
    assert.deepEqual((await f.place(false, explicit)).body.selected_bed_codes, explicit.selected_bed_codes);
    const saved = (await f.get()).policy;
    for (const invalid of [{ ...saved, contractVersion:99 }, { ...saved, roomPriority:saved.roomPriority.slice(1) }, { ...saved, roomPriority:saved.roomPriority.map(() => saved.roomPriority[0]) }]) {
      await f.db.query("UPDATE clients SET settings=jsonb_build_object('luna_room_fill_policy',$1::jsonb)", [JSON.stringify(invalid)]);
      const result = await f.place(true);
      assert.equal(result.ok, false); assert.equal(result.status, 409);
      assert.equal(result.body.reason_code, 'room_fill_policy_requires_review');
      assert.deepEqual((await f.place(false, explicit)).body.selected_bed_codes, explicit.selected_bed_codes, 'accepted order is independent of fill settings');
    }
    await f.occupy('R1-B1');
    assert.deepEqual((await f.place(false, explicit)).body.selected_bed_codes, [], 'stale accepted beds reject rather than swap');
    await f.db.exec("UPDATE clients SET settings='{}'");
    assert.equal((await f.place(true)).body.selected_room_code, 'R1', 'no saved policy retains old consolidation');
  } finally { await f.db.close(); }
});

test('all rooms inactive with saved policy never falls back to synthetic CSV inventory', async () => {
  const f = await fixture();
  try {
    await f.save('house'); await f.db.exec('UPDATE rooms SET active=false');
    for (const assignment of [false,true]) {
      const result = await f.place(assignment, {}, { demoCalendarEnrichment: true });
      assert.equal(result.body.available_count, 0, JSON.stringify(result));
      assert.deepEqual(result.body.selected_bed_codes, []);
    }
  } finally { await f.db.close(); }
});

test('House compares peak then mean nightly occupancy, not a union of busy beds', async () => {
  const f = await fixture();
  try {
    await f.save('house',['R2','R1']);
    await f.occupy('R1-B1','2026-07-06','2026-07-07'); await f.occupy('R2-B1');
    assert.equal((await f.preview()).decision.selected[0].roomCode, 'R1');
    for (const assignment of [false,true]) assert.equal((await f.place(assignment)).body.selected_room_code, 'R1');
    await f.db.exec("UPDATE beds SET active=true WHERE room_id=(SELECT id FROM rooms WHERE room_code='R2') AND bed_number<=4; UPDATE rooms SET capacity=4 WHERE room_code='R2'");
    assert.equal((await f.preview()).decision.selected[0].roomCode, 'R2');
    for (const assignment of [false,true]) assert.equal((await f.place(assignment)).body.selected_room_code, 'R2', 'capacity-normalized occupancy before priority');
  } finally { await f.db.close(); }
});

test('tenant SQL isolates both saved settings and the full room catalogue; connection advertises only the wired capability', async () => {
  const f = await fixture();
  try {
    await f.save('room',['R2','R1']);
    assert.equal((await f.get()).activationStatus, 'connected');
    await f.db.exec("INSERT INTO clients(id,slug,settings) VALUES(gen_random_uuid(),'other-tenant','{\"luna_room_fill_policy\":{\"contractVersion\":99}}'); INSERT INTO rooms(client_id,room_code,name,room_type,capacity,active) SELECT id,'OTHER','Other','mixed',2,true FROM clients WHERE slug='other-tenant'");
    assert.equal((await f.place(true)).body.selected_room_code, 'R2');
    const { getBedCalendarRoomsQuery } = require('./lib/staff-bed-calendar-queries');
    const other = (await f.db.query(getBedCalendarRoomsQuery(), ['other-tenant'])).rows;
    assert.equal(other.length, 1);
    assert.equal(other[0].room_code, 'OTHER');
    assert.equal(other[0].room_fill_policy, null);
    assert.equal(other[0].room_fill_catalogue, null);
  } finally { await f.db.close(); }
});

async function commitOffline(f, extra = {}) {
  const { buildWolfhouseBookingCreateCommand, executeWolfhouseBookingCreate } = require('./lib/luna-front-desk-accommodation-booking-create-service');
  await f.db.exec('ALTER TABLE payments ADD created_at timestamptz DEFAULT now()');
  const payload = { check_in:'2026-07-06', check_out:'2026-07-09', guest_count:1, package_code:'package_none', room_type:'shared', room_preference:'shared', group_gender:'mixed', confirm: true, guest_name: 'Offline Fill A', guests: [{ name: 'Offline Fill A' }], phone: '+999****001', payment_choice: 'full', ...extra };
  const built = await buildWolfhouseBookingCreateCommand({ channel: 'luna_whatsapp', trustedClientSlug: 'wolfhouse-somo', transportBody: payload, pgClient: f.db });
  assert.equal(built.ok, true, JSON.stringify(built));
  const result = await executeWolfhouseBookingCreate(f.db, built.command, { stripeConfig: { stripeLinksEnabled: false } });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (await f.db.query('SELECT guest_name, assigned_bed_code FROM booking_guests WHERE booking_id=$1 ORDER BY guest_number', [result.body.booking_id])).rows;
}

test('ordinary booking command and execute persist the preview choice in all three original cases', async () => {
  for (const scenario of [{ mode:'house', first:['R1','R2'], occupied:true }, { mode:'room', first:['R2','R1'] }, { mode:'house', first:['R2','R1'] }]) {
    const f = await fixture();
    try {
      await f.save(scenario.mode, scenario.first);
      if (scenario.occupied) await f.occupy();
      assert.equal((await f.preview()).decision.selected[0].roomCode, 'R2');
      const guests = await commitOffline(f);
      assert.equal(guests.length, 1);
      assert.equal(guests[0].guest_name, 'Offline Fill A');
      assert.match(guests[0].assigned_bed_code, /^R2-/);
    } finally { await f.db.close(); }
  }
});

test('changed fill priority never replaces or reorders accepted person-to-bed assignments at commit', async () => {
  const f = await fixture();
  try {
    await f.save('room', ['R2','R1']);
    const guests = await commitOffline(f, { guest_count:2, guests:[{name:'Offline Fill A'},{name:'Offline Fill B'}], selected_bed_codes:['R1-B2','R1-B1'] });
    assert.deepEqual(guests, [{guest_name:'Offline Fill A',assigned_bed_code:'R1-B2'},{guest_name:'Offline Fill B',assigned_bed_code:'R1-B1'}]);
  } finally { await f.db.close(); }
});
