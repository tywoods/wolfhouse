'use strict';

// C22 offline fixture. Real Staff create + required name handler + PGlite SQL.
// Reuses the existing reduced schema/catalog seed (migrations 024/031 are real).
// guest_rooms below is an explicitly synthetic legacy-table shape, not a migration.
// Only HTTP/auth/audit edges are supplied; business SQL and COMMIT are unchanged.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const { seedOfflineBookingDb } = require('../verify-luna-create-booking-occupants');
const {
  BOOKING_CREATE_CHANNELS, buildWolfhouseBookingCreateCommand, executeWolfhouseBookingCreate,
} = require('../lib/luna-front-desk-accommodation-booking-create-service');

async function createNameFixture({ sameName = false, reverseBeds = false } = {}) {
  const db = new PGlite();
  const calls = [], sqlErrors = [], audits = [];
  const pg = { async query(sql, params = []) {
    calls.push(String(sql).replace(/\s+/g, ' ').trim());
    try { return await db.query(sql, params); }
    catch (error) { sqlErrors.push(error.code); throw error; }
  } };
  try {
    const payload = {
      confirm: true, check_in: '2026-07-06', check_out: '2026-07-09',
      guest_count: 2, guest_name: 'Lead Before',
      guests: [{ name: 'Lead Before' }, { name: sameName ? 'Lead Before' : 'Companion Before' }],
      phone: '+999' + '88000001', package_code: 'package_none', room_type: 'shared',
      group_gender: 'mixed', selected_bed_codes: reverseBeds ? ['R3-B2', 'R3-B1'] : ['R3-B1', 'R3-B2'], payment_choice: 'full',
    };
    await seedOfflineBookingDb(db, payload);
    await db.exec(fs.readFileSync(path.join(__dirname,
      '../../database/migrations/136_wolfhouse_package_default_nights.sql'), 'utf8'));
    const built = await buildWolfhouseBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP, trustedClientSlug: 'wolfhouse-somo',
      transportBody: payload, pgClient: pg,
    });
    if (!built.ok) throw new Error('Real create command failed: ' + JSON.stringify(built.body));
    const created = await executeWolfhouseBookingCreate(pg, built.command, {
      stripeConfig: { stripeLinksEnabled: false },
    });
    if (!created.ok) throw new Error('Real create failed: ' + JSON.stringify(created.body));
    const booking = (await db.query('SELECT * FROM bookings')).rows[0];
    const guests = (await db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows;
    if (!booking || guests.length !== 2 || !calls.includes('COMMIT')) {
      throw new Error('Real create did not commit booking and guests');
    }
    const sourcePath = path.join(__dirname, '../staff-query-api.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const start = source.indexOf('async function handleBookingEditWriteGuestNames(');
    const end = source.indexOf('\n}\n', start);
    if (start < 0 || end < start) throw new Error('Required name handler anchor changed');
    const context = vm.createContext({
      require: createRequire(sourcePath), STAFF_ACTIONS_ENABLED: true,
      UUID_VALIDATE_RE: /^[0-9a-f]{8}-[0-9a-f-]{27}$/i,
      assertStaffClientAccess: () => true, withPgClient: work => work(pg),
      appendAuditLog: entry => audits.push(entry),
      send400: (_res, error) => ({ status: 400, body: { error } }),
      sendJSON: (_res, status, body) => ({ status, body }),
      sendSupervisorCompleted: (_res, status, body) => ({ status, body }),
    });
    vm.runInContext(source.slice(start, end + 2), context, { filename: sourcePath });
    return {
      db, pg, booking, guests, calls, sqlErrors, audits,
      async edit(edits) {
        return context.handleBookingEditWriteGuestNames({}, { guest_names: edits }, {}, Date.now(),
          'wolfhouse-somo', booking.id, booking.booking_code, { role: 'admin' });
      },
      async legacyRooms() {
        await db.exec(`CREATE TABLE guest_rooms (booking_id uuid, guest_number int, guest_name text);
          INSERT INTO guest_rooms SELECT booking_id, guest_number, guest_name FROM booking_guests;`);
      },
      async failMirror(target) {
        const config = {
          guest_rooms: ['guest_rooms', 'UPDATE', ''],
          booking_beds: ['booking_beds', 'UPDATE', ''],
          metadata: ['bookings', 'UPDATE OF metadata', ''],
          // The handler writes the authoritative guest once; fail only the redundant copy.
          booking_guests: ['booking_guests', 'UPDATE', 'WHEN (OLD.guest_name = NEW.guest_name)'],
          required_guest: ['booking_guests', 'UPDATE', 'WHEN (OLD.guest_name IS DISTINCT FROM NEW.guest_name)'],
        }[target];
        if (!config) throw new Error('Unknown C22 mirror');
        await db.exec(`CREATE FUNCTION fail_name_mirror() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'synthetic optional mirror failure' USING ERRCODE='P0001'; END; $$;
          CREATE TRIGGER c22_mirror_fault BEFORE ${config[1]} ON ${config[0]}
          FOR EACH ROW ${config[2]} EXECUTE FUNCTION fail_name_mirror();`);
      },
    };
  } catch (error) { await db.close(); throw error; }
}

module.exports = { createNameFixture };
