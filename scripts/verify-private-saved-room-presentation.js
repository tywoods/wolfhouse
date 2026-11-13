'use strict';
// Offline PostgreSQL (PGlite), synthetic reconstruction of Chief's incident.
// No production reads, network, writes to operational data, or sends.
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { loadSavedBookingRoomPrivacy, savedBookingPrivateFlag } = require('./lib/staff-booking-room-privacy');
const { projectCreatedGuestRooms } = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { projectGuestRooms } = require('./lib/staff-guest-room-state');
const guests = [1, 2].map(guest_number => ({ guest_number, assigned_room_code: 'R7' }));
const catalog = { R7: { type: 'mixed', capacity: 4, room_name: 'Room 7' } };
const quote = { success: true, room_type: 'shared', line_items: [{ code: 'room_supplement', total_cents: 6000 }] };
async function main() {
  assert.equal(savedBookingPrivateFlag({ room_preference: 'couple_private' }), true);
  assert.equal(savedBookingPrivateFlag({ room_preference: 'mixed', metadata: { quote_snapshot: quote } }), false);
  assert.equal(savedBookingPrivateFlag({ metadata: { quote_snapshot: quote } }), null);
  assert.equal(savedBookingPrivateFlag({ room_preference: 'double', metadata: { private_room_enabled: false } }), false);
  assert.equal(savedBookingPrivateFlag({ metadata: JSON.stringify({ private_room_enabled: true }) }), true);
  const apiSource = require('node:fs').readFileSync(require('node:path').join(__dirname, 'staff-query-api.js'), 'utf8');
  assert.match(apiSource, /function bookingPrivateRoomEnabled\(row\) \{\s*return savedBookingPrivateFlag\(row\) === true;/);
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE clients(id text PRIMARY KEY, slug text);
      CREATE TABLE bookings(id text PRIMARY KEY,client_id text,booking_code text,status text,check_in date,check_out date,room_preference text,requested_room_type text,metadata jsonb);
      CREATE TABLE rooms(id text PRIMARY KEY,client_id text,room_code text);
      CREATE TABLE beds(id text PRIMARY KEY,client_id text,room_id text,bed_code text);
      CREATE TABLE booking_beds(booking_id text,client_id text,bed_code text,room_code text,assignment_start_date date,assignment_end_date date,assignment_type text);
      INSERT INTO clients VALUES ('tenant','wolfhouse-somo'),('other','other');
      INSERT INTO rooms VALUES ('r7','tenant','R7');
      INSERT INTO beds SELECT 'bed'||n,'tenant','r7','R7-B'||n FROM generate_series(1,4) n;
      INSERT INTO bookings VALUES
        ('parent','tenant','WH-20270920-00516771','confirmed','2027-09-20','2027-09-23','couple_private','double','{}'),
        ('block','tenant','PRV-20270920-58F441','blocked','2027-09-20','2027-09-23',NULL,NULL,'{"private_room_parent_booking_id":"parent"}');
      INSERT INTO booking_beds SELECT CASE WHEN n<=2 THEN 'parent' ELSE 'block' END,'tenant','R7-B'||n,'R7','2027-09-20','2027-09-23',CASE WHEN n<=2 THEN 'guest' ELSE 'staff_block' END FROM generate_series(1,4) n;
    `);
    const read = () => loadSavedBookingRoomPrivacy(db, { clientSlug: 'wolfhouse-somo', bookingCode: 'WH-20270920-00516771' });
    let privacy = await read();
    assert.equal(privacy.source, 'saved_booking');
    assert.equal(privacy.private_room_enabled, true);
    assert.deepEqual(privacy.room_codes, ['R7']);
    assert.deepEqual(privacy.blocked_bed_codes, ['R7-B3', 'R7-B4']);
    assert.deepEqual(privacy.block_booking_codes, ['PRV-20270920-58F441']);
    assert.equal(privacy.evidence_complete, true);
    const rooms = projectGuestRooms(guests, catalog, quote, privacy);
    assert.ok(rooms.every(r => r.room_kind === 'private' && r.type === 'private' && r.room_label === 'Room 7, private room' && r.inventory_room_type === 'mixed'));
    assert.equal(rooms.reduce((sum, r) => sum + r.supplement_cents, 0), 6000);
    assert.deepEqual(projectCreatedGuestRooms(guests, [1,2].map(n => ({ guest_number: n, room_code: 'R7', bed_code: `R7-B${n}` })), quote,
      [{ room_code: 'R7', room_type: 'mixed', room_name: 'Room 7', capacity: 4 }], privacy), rooms);
    console.log('PASS incident WH-20270920-00516771 / PRV-20270920-58F441: private R7, B3/B4 protected; create/read projection agrees');
    for (const [name, update, restore] of [
      ['wrong parent', `metadata='{"private_room_parent_booking_id":"unrelated"}'`, `metadata='{"private_room_parent_booking_id":"parent"}'`],
      ['wrong tenant', `client_id='other'`, `client_id='tenant'`],
      ['cancelled', `status='cancelled'`, `status='blocked'`],
      ['short dates', `check_out='2027-09-21'`, `check_out='2027-09-23'`],
    ]) {
      await db.exec(`UPDATE bookings SET ${update} WHERE id='block'`);
      privacy = await read();
      assert.deepEqual(privacy.blocked_bed_codes, [], name);
      assert.equal(privacy.private_room_enabled, true, 'persisted private flag must never become shared');
      assert.equal(privacy.evidence_complete, false);
      assert.ok(privacy.diagnostics.length);
      await db.exec(`UPDATE bookings SET ${restore} WHERE id='block'`);
    }
    for (const [update, restore] of [
      ["room_code='R8'", "room_code='R7'"],
      ["client_id='other'", "client_id='tenant'"],
      ["assignment_end_date='2027-09-21'", "assignment_end_date='2027-09-23'"],
    ]) {
      await db.exec(`UPDATE booking_beds SET ${update} WHERE booking_id='block'`);
      assert.deepEqual((await read()).blocked_bed_codes, []);
      await db.exec(`UPDATE booking_beds SET ${restore} WHERE booking_id='block'`);
    }
    console.log('PASS wrong parent/tenant/cancelled/short dates/wrong room/assignment tenant and date evidence ignored; private flag retained with quiet diagnostic');
    await db.exec("UPDATE bookings SET room_preference='mixed',requested_room_type='shared' WHERE id='parent'");
    privacy = await read();
    assert.equal(privacy.private_room_enabled, false);
    assert.ok(projectGuestRooms(guests, { R7: { type: 'private', capacity: 2 } }, { success: true, room_type: 'double' }, privacy)
      .every(r => r.room_kind === 'shared' && r.type === 'shared' && r.room_label === 'Room 7, shared room'));
    assert.ok(projectGuestRooms(guests, catalog, { success: true, room_type: 'private' }).every(r => r.room_kind === null && r.type === null && !r.room_label.includes('shared')));
    console.log('PASS shared saved booking stays shared despite private catalog/quote; missing privacy never claims shared');
    await db.exec("UPDATE bookings SET room_preference='couple_private',requested_room_type='double' WHERE id='parent'; DELETE FROM booking_beds WHERE booking_id='block'");
    privacy = await read();
    assert.equal(privacy.private_room_enabled, true);
    assert.equal(privacy.evidence_complete, false);
    assert.ok(projectGuestRooms(guests, catalog, quote, privacy).every(r => r.room_kind === 'private'));
    await db.exec("INSERT INTO booking_beds SELECT 'parent','tenant','R7-B'||n,'R7','2027-09-20','2027-09-23','guest' FROM generate_series(3,4) n");
    privacy = await read();
    assert.equal(privacy.evidence_complete, true);
    assert.deepEqual(privacy.diagnostics, []);
    assert.deepEqual(privacy.blocked_bed_codes, []);
    const failed = await loadSavedBookingRoomPrivacy({ query: async () => { throw Error('read unavailable'); } }, { clientSlug: 'wolfhouse-somo', bookingCode: 'saved' });
    assert.equal(failed.private_room_enabled, null);
    assert.ok(failed.diagnostics.includes('privacy_read_unavailable'));
    assert.equal((await loadSavedBookingRoomPrivacy(db, { clientSlug: 'other', bookingCode: 'WH-20270920-00516771' })).private_room_enabled, null);
    console.log('PASS missing PRV warns without relabelling shared; fully occupied private needs no spare PRV; read failure/missing tenant returns unknown without throwing');
  } finally { await db.close(); }
  // Exercise the real create + idempotent recovery service against the existing
  // offline schema, including an actual PostgreSQL read error after the save.
  const fixture = require('./verify-room-selling-booking');
  const { buildWolfhouseBookingCreateCommand, executeWolfhouseBookingCreate } = require('./lib/luna-front-desk-accommodation-booking-create-service');
  for (const [failure, callerManagedTransaction] of [[false, false], [true, false], [true, true]]) {
    const serviceDb = new PGlite();
    try {
      const body = fixture.payload('private', 2, `privacy-${failure}`);
      await fixture.seed(serviceDb, body);
      // Existing offline fixture predates the persisted per-night deposit column.
      await serviceDb.exec('ALTER TABLE wh_pricing_rules ADD COLUMN IF NOT EXISTS per_night_cents integer');
      const sqlCalls = [];
      const pg = { query: async (sql, args) => {
        sqlCalls.push(sql);
        if (failure && sql.includes('WITH parent AS (')) return serviceDb.query('SELECT nonexistent_privacy_column');
        return serviceDb.query(sql, args);
      } };
      const built = await fixture.build(pg, body);
      assert.equal(built.ok, true, JSON.stringify(built));
      if (callerManagedTransaction) await pg.query('BEGIN');
      const created = await executeWolfhouseBookingCreate(pg, built.command, { callerManagedTransaction });
      if (callerManagedTransaction) {
        assert.ok(sqlCalls.includes('ROLLBACK TO SAVEPOINT saved_room_privacy_read'));
        // Real SQL error recovery: this would fail in a poisoned transaction.
        assert.equal((await pg.query('SELECT 1 AS usable')).rows[0].usable, 1);
        await pg.query('COMMIT');
      }
      assert.equal(created.ok, true, JSON.stringify(created));
      assert.equal(created.status, 201);
      assert.equal(created.body.room_privacy.private_room_enabled, failure ? null : true);
      assert.ok(created.body.guest_rooms.length === 2);
      assert.ok(created.body.guest_rooms.every(r => r.room_kind === (failure ? null : 'private')));
      const commit = sqlCalls.indexOf('COMMIT');
      assert.ok(commit >= 0);
      assert.ok(!sqlCalls.slice(commit + 1).includes('ROLLBACK'), 'privacy read error must not roll back a saved booking');
      const recovered = await buildWolfhouseBookingCreateCommand({ channel: 'luna_whatsapp', trustedClientSlug: 'wolfhouse-somo', transportBody: body, pgClient: pg });
      assert.equal(recovered.ok, true, JSON.stringify(recovered));
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.body.booking_id, created.body.booking_id);
      assert.equal(recovered.body.room_privacy.private_room_enabled, failure ? null : true);
      assert.ok(recovered.body.guest_rooms.every(r => r.room_kind === (failure ? null : 'private')));
      console.log(`PASS real create + duplicate recovery, privacy SELECT ${failure ? 'failure preserves success/unknown' : 'reads persisted private flags and blocks'}${callerManagedTransaction ? ' (caller transaction remains usable)' : ''}`);
    } finally { await serviceDb.close(); }
  }
  console.log('PASS offline PGlite saved privacy regression (synthetic incident, not live production evidence)');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
