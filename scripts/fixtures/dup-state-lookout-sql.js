'use strict';

// C19: reuse reduced offline schema + committed inventory/migrations. Business
// create/recovery SQL is unchanged. No live DB, transport or synthetic SQL rows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { seedOfflineBookingDb } = require('../verify-luna-create-booking-occupants');
const service = require('../lib/luna-front-desk-accommodation-booking-create-service');

async function createRoomFixture() {
  const db = new PGlite(), calls = [];
  const pg = { async query(sql, params) {
    calls.push(String(sql).replace(/\s+/g, ' ').trim());
    return db.query(sql, params);
  } };
  try {
    const payload = { confirm: true, check_in: '2026-07-06', check_out: '2026-07-09',
      guest_count: 2, guest_name: 'C19 Lead', guests: [{ name: 'C19 Lead' }, { name: 'C19 Second' }],
      phone: '+999' + '88000319', package_code: 'package_none', room_type: 'shared',
      group_gender: 'mixed', selected_bed_codes: ['R3-B1', 'R1-B1'], payment_choice: 'full' };
    await seedOfflineBookingDb(db, payload);
    await db.exec(fs.readFileSync(path.join(__dirname,
      '../../database/migrations/136_wolfhouse_package_default_nights.sql'), 'utf8'));
    const built = await service.buildWolfhouseBookingCreateCommand({ channel: service.BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
      trustedClientSlug: 'wolfhouse-somo', transportBody: payload, pgClient: pg });
    assert.equal(built.ok, true, JSON.stringify(built.body));
    const created = await service.executeWolfhouseBookingCreate(pg, built.command, { stripeConfig: { stripeLinksEnabled: false } });
    assert.equal(created.ok, true, JSON.stringify(created.body));
    const booking = (await db.query('SELECT * FROM bookings')).rows[0];
    const guests = (await db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows;
    const beds = (await db.query(`SELECT bb.*, r.room_type, r.name AS room_name FROM booking_beds bb
      JOIN rooms r ON r.client_id=bb.client_id AND r.room_code=bb.room_code ORDER BY bb.bed_code`)).rows;
    assert.equal(created.body.booking_id, booking.id);
    assert.ok(calls.includes('COMMIT'));
    assert.equal(calls.includes('ROLLBACK'), false);
    assert.deepEqual(guests.map(g => [g.guest_name, g.assigned_bed_code, g.assigned_room_code]),
      [['C19 Lead', 'R3-B1', 'R3'], ['C19 Second', 'R1-B1', 'R1']]);
    assert.equal(new Set(beds.map(b => String(b.created_at))).size, 1, 'real INSERT timestamps must tie');
    return { db, pg, calls, payload, command: built.command, created, booking, guests, beds,
      async lookup() { return service.lookupSavedWolfhouseCreateById(pg, 'wolfhouse-somo', booking.id); },
      async recover() { return service.executeWolfhouseBookingCreate(pg, built.command, { stripeConfig: { stripeLinksEnabled: false } }); },
      async snapshot() { return {
        bookings: (await db.query('SELECT * FROM bookings ORDER BY id')).rows,
        guests: (await db.query('SELECT * FROM booking_guests ORDER BY id')).rows,
        beds: (await db.query('SELECT * FROM booking_beds ORDER BY id')).rows,
        payments: (await db.query('SELECT * FROM payments ORDER BY id')).rows,
      }; },
    };
  } catch (error) { await db.close(); throw error; }
}
module.exports = { createRoomFixture };
