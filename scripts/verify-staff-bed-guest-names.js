'use strict';
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { getBedCalendarBlocksQuery } = require('./lib/staff-bed-calendar-queries');
const { getBookingRoomingAssignmentsQuery } = require('./lib/staff-booking-detail-queries');
const { getRoomingRosterQuery, getOccupiedBedsQuery } = require('./lib/staff-rooming-queries');
const { annotateCalendarBlocks } = require('./lib/staff-calendar-group-paint');
// Offline PostgreSQL: full production SELECTs, never a live database.
async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE clients (id int PRIMARY KEY, slug text);
      CREATE TABLE bookings (id int PRIMARY KEY, client_id int, booking_code text,
        guest_name text, phone text, guest_count int, package_code text, metadata jsonb,
        check_in date, check_out date, status text, payment_status text,
        assignment_status text, needs_rooming_review boolean, primary_room_code text);
      CREATE TABLE rooms (id int PRIMARY KEY, room_code text, name text, room_type text,
        gender_strategy text, capacity int, can_be_matrimonial boolean);
      CREATE TABLE beds (id int PRIMARY KEY, room_id int);
      CREATE TABLE booking_beds (id int PRIMARY KEY, booking_id int, client_id int,
        bed_id int, room_code text, bed_code text, assignment_start_date date,
        assignment_end_date date, planning_row_label text, assignment_label text,
        assignment_type text, guest_name text);
      CREATE TABLE booking_guests (id int PRIMARY KEY, client_id int, booking_id int,
        guest_number int, guest_name text, assigned_room_code text, assigned_bed_code text);
      INSERT INTO clients VALUES (1, 'wolfhouse-somo'), (2, 'other');
      INSERT INTO rooms VALUES (1,'R1','Shared','shared','mixed',4,false),
        (6,'R6','Double','double','mixed',2,true);
      INSERT INTO beds VALUES (11,1),(12,1),(61,6),(62,6);
      INSERT INTO bookings (id,client_id,booking_code,guest_name,guest_count,check_in,check_out,status,metadata)
        VALUES (1,1,'SHARED','Mia',2,'2026-07-01','2026-07-05','confirmed','{}'),
        (2,1,'DOUBLE','Sofia',2,'2026-07-01','2026-07-05','confirmed','{}');
      INSERT INTO booking_beds (id,booking_id,client_id,bed_id,room_code,bed_code,
        assignment_start_date,assignment_end_date,guest_name) VALUES
        (1,1,1,11,'R1','R1-B1','2026-07-01','2026-07-05','Mia'),
        (2,1,1,12,'R1','R1-B2','2026-07-01','2026-07-05','Mia'),
        (3,2,1,61,'R6','R6-B1','2026-07-01','2026-07-05','Sofia'),
        (4,2,1,62,'R6','R6-B2','2026-07-01','2026-07-05','Sofia');
      INSERT INTO booking_guests VALUES
        (1,1,1,1,'Mia','R1','R1-B1'),(2,1,1,2,'Leon','R1','R1-B2'),
        (3,1,2,1,'Sofia','R6','R6-B1'),(4,1,2,2,'Marco','R6','R6-B2'),
        (5,2,1,1,'Wrong tenant','R1','R1-B2'),
        (6,1,2,3,'Wrong room','R9','R6-B2'),
        (7,1,2,4,'Wrong booking','R1','R1-B2');
    `);
    const range = ['wolfhouse-somo', '2026-07-01', '2026-07-05'];
    const queries = [
      ['calendar', getBedCalendarBlocksQuery(), range],
      ['roster', getRoomingRosterQuery(), range.slice(0, 1)],
      ['occupied', getOccupiedBedsQuery(), range],
      ['shared drawer', getBookingRoomingAssignmentsQuery(), ['wolfhouse-somo', 'SHARED']],
      ['double drawer', getBookingRoomingAssignmentsQuery(), ['wolfhouse-somo', 'DOUBLE']],
    ];
    let failures = 0;
    for (const [name, sql, args] of queries) {
      try {
        const { rows } = await db.query(sql, args);
        const expected = name === 'shared drawer' ? ['Mia', 'Leon']
          : name === 'double drawer' ? ['Sofia', 'Marco'] : ['Mia', 'Leon', 'Sofia', 'Marco'];
        rows.sort((a, b) => Number(a.booking_bed_id) - Number(b.booking_bed_id));
        assert.deepEqual(rows.map(row => row.bed_guest_name), expected);
        if (name === 'calendar') {
          const guests = (await db.query('SELECT * FROM booking_guests WHERE client_id=1 AND guest_number <= 2')).rows;
          assert.deepEqual(annotateCalendarBlocks(rows, guests).map(row => row.bed_guest_name), expected);
        }
        console.log('PASS ' + name + ': assigned names, scoped without duplicate blocks');
      } catch (error) {
        failures += 1;
        console.error('FAIL ' + name + ': ' + error.message);
      }
    }
    assert.equal(failures, 0, 'all bed read surfaces must resolve the assigned guest');
    // Duplicate legacy identity must neither multiply blocks nor pick an arbitrary person.
    await db.exec("INSERT INTO booking_guests VALUES (8,1,1,3,'Ambiguous','R1','R1-B2')");
    const ambiguous = (await db.query(getBedCalendarBlocksQuery(), range)).rows;
    assert.equal(ambiguous.length, 4);
    assert.equal(ambiguous.find(row => row.bed_code === 'R1-B2').bed_guest_name, 'Mia');
    await db.exec('DELETE FROM booking_guests WHERE id=8');
    console.log('PASS ambiguous legacy assignment retains saved label without fan-out');
    await db.exec("DELETE FROM booking_guests WHERE id=2; UPDATE booking_guests SET guest_name='  ' WHERE id=4;");
    const legacy = (await db.query(getBedCalendarBlocksQuery(), range)).rows;
    legacy.sort((a, b) => Number(a.booking_bed_id) - Number(b.booking_bed_id));
    assert.deepEqual(legacy.map(row => row.bed_guest_name), ['Mia', 'Mia', 'Sofia', 'Sofia']);
    const stored = (await db.query('SELECT guest_name FROM booking_beds ORDER BY id')).rows;
    assert.deepEqual(stored.map(row => row.guest_name), ['Mia', 'Mia', 'Sofia', 'Sofia']);
    console.log('PASS legacy fallback; stored assignment names unchanged');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
