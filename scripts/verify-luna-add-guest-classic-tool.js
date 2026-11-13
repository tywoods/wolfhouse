'use strict';

/**
 * Classic Luna add-guest tool: registered, bed assigned, invoice updated,
 * retry is idempotent, no free bed → needs-human without mutating the original save.
 * No Stripe, no WhatsApp, no live Staff.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { addGuestToBooking } = require('./lib/luna-guest-addguest-attach');
const { handleBotBookingAddGuests } = require('./lib/luna-bot-booking-add-guests');

let passes = 0;
let failures = 0;
function ok(name, cond) {
  if (cond) {
    console.log(`  PASS  ${name}`);
    passes += 1;
  } else {
    console.error(`  FAIL  ${name}`);
    failures += 1;
  }
}

const ROOT = path.join(__dirname, '..');
const pluginSrc = fs.readFileSync(
  path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'),
  'utf8',
);
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

console.log('\nverify-luna-add-guest-classic-tool.js\n');

ok('classic plugin registers add_guests_to_booking',
  /def add_guests_to_booking\(/.test(pluginSrc)
  && /\("add_guests_to_booking"/.test(pluginSrc));
ok('classic tool posts /booking-add-guests',
  pluginSrc.includes('_post_bot("/booking-add-guests"'));
ok('classic tool tells the model never to say dorm',
  /add_guests_to_booking[\s\S]{0,700}never say dorm/.test(pluginSrc));
ok('staff-query-api dispatches POST /staff/bot/booking-add-guests',
  apiSrc.includes("pathname === '/staff/bot/booking-add-guests'"));
ok('handoff reason no_bed_for_added_guest is explicit',
  pluginSrc.includes('"no_bed_for_added_guest"'));

const CLIENT = '00000000-0000-4000-8000-000000000001';
const SAM = '00000000-0000-4000-8000-0000000000aa';
const BED_A = '00000000-0000-4000-8000-0000000000b1';
const BED_B = '00000000-0000-4000-8000-0000000000b2';
const BED_C = '00000000-0000-4000-8000-0000000000b3';
const BOOKING_BED_SAM = '00000000-0000-4000-8000-0000000000c1';

async function schema(db) {
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE);
    CREATE TABLE bookings (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL REFERENCES clients(id),
      booking_code text NOT NULL,
      guest_name text,
      guest_count integer NOT NULL,
      payment_status text NOT NULL,
      status text NOT NULL DEFAULT 'confirmed',
      phone text,
      check_in date NOT NULL,
      check_out date NOT NULL,
      package_code text,
      total_amount_cents integer,
      amount_paid_cents integer,
      balance_due_cents integer,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE payments (
      id uuid PRIMARY KEY,
      booking_id uuid NOT NULL REFERENCES bookings(id),
      payment_kind text,
      status text,
      amount_due_cents integer,
      amount_paid_cents integer
    );
    CREATE TABLE booking_guests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid NOT NULL REFERENCES clients(id),
      booking_id uuid NOT NULL REFERENCES bookings(id),
      guest_number integer NOT NULL,
      guest_name text NOT NULL,
      assigned_room_code text,
      assigned_bed_code text,
      deposit_amount_cents integer NOT NULL DEFAULT 0,
      amount_paid_cents integer NOT NULL DEFAULT 0,
      payment_status text NOT NULL DEFAULT 'not_requested',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE beds (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL,
      bed_code text NOT NULL,
      room_code text,
      active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE booking_beds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid NOT NULL,
      booking_id uuid NOT NULL,
      bed_id uuid NOT NULL,
      bed_code text,
      room_code text,
      assignment_start_date date,
      assignment_end_date date,
      assignment_type text,
      assignment_notes text,
      guest_name text
    );
  `);
  await db.query(`INSERT INTO clients (id, slug) VALUES ($1::uuid, 'wolfhouse-somo')`, [CLIENT]);
  await db.query(
    `INSERT INTO bookings (
       id, client_id, booking_code, guest_name, guest_count, payment_status, status, phone,
       check_in, check_out, package_code, total_amount_cents, amount_paid_cents, balance_due_cents
     ) VALUES (
       $1::uuid, $2::uuid, 'WH-20270920-14052366', 'Sam', 1, 'pending', 'confirmed', '+99900001111',
       '2027-09-20', '2027-09-23', 'no_package', 30000, 0, 30000
     )`,
    [SAM, CLIENT],
  );
  await db.query(
    `INSERT INTO booking_guests (
       client_id, booking_id, guest_number, guest_name, assigned_room_code, assigned_bed_code
     ) VALUES ($1::uuid, $2::uuid, 1, 'Sam', 'R4', 'R4-1')`,
    [CLIENT, SAM],
  );
  await db.query(
    `INSERT INTO beds (id, client_id, bed_code, room_code, active) VALUES
     ($1::uuid, $4::uuid, 'R4-1', 'R4', true),
     ($2::uuid, $4::uuid, 'R4-2', 'R4', true),
     ($3::uuid, $4::uuid, 'R5-1', 'R5', true)`,
    [BED_A, BED_B, BED_C, CLIENT],
  );
  await db.query(
    `INSERT INTO booking_beds (
       id, client_id, booking_id, bed_id, bed_code, room_code,
       assignment_start_date, assignment_end_date, assignment_type, guest_name
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'R4-1', 'R4',
       '2027-09-20', '2027-09-23', 'Auto Assigned', 'Sam'
     )`,
    [BOOKING_BED_SAM, CLIENT, SAM, BED_A],
  );
}

(async () => {
  let db;
  try {
    const { PGlite } = require('@electric-sql/pglite');
    db = new PGlite();
    await schema(db);
    const avail = async () => ({ available: true, status: 'available', detail: {} });

    const added = await addGuestToBooking(db, {
      classicBot: true,
      clientSlug: 'wolfhouse-somo',
      bookingCode: 'WH-20270920-14052366',
      newGuestNames: ['Max'],
      availabilityChecker: avail,
    });
    ok('classic add Max status ok', added.status === 'ok' && added.write_performed === true);
    ok('classic add Max assigned a free bed',
      added.inserted_booking_guests
      && added.inserted_booking_guests[0]
      && added.inserted_booking_guests[0].assigned_bed_code
      && added.inserted_booking_guests[0].assigned_bed_code !== 'R4-1');
    ok('classic add Max bed_label is shared room not dorm',
      added.inserted_booking_guests[0].bed_label
      && /shared room/i.test(added.inserted_booking_guests[0].bed_label)
      && !/dorm/i.test(added.inserted_booking_guests[0].bed_label));
    ok('classic add Max asks deposit or full, no payment link',
      added.ask_deposit_or_full === true && added.payment_draft_id == null);

    const guests = await db.query(
      `SELECT guest_name, assigned_bed_code, assigned_room_code
         FROM booking_guests WHERE booking_id = $1::uuid ORDER BY guest_number`,
      [SAM],
    );
    ok('SQL read-back has Sam and Max with beds',
      guests.rows.length === 2
      && guests.rows[0].guest_name === 'Sam'
      && guests.rows[1].guest_name === 'Max'
      && guests.rows[1].assigned_bed_code);

    const beds = await db.query(
      `SELECT guest_name, bed_code FROM booking_beds WHERE booking_id = $1::uuid ORDER BY bed_code`,
      [SAM],
    );
    ok('booking_beds has Max assignment',
      beds.rows.some((r) => r.guest_name === 'Max' && r.bed_code));

    const booking = await db.query(
      `SELECT guest_count, guest_name FROM bookings WHERE id = $1::uuid`,
      [SAM],
    );
    ok('booking guest_count is 2 after Max',
      Number(booking.rows[0].guest_count) === 2
      && String(booking.rows[0].guest_name).includes('Max'));

    const retry = await addGuestToBooking(db, {
      classicBot: true,
      clientSlug: 'wolfhouse-somo',
      bookingCode: 'WH-20270920-14052366',
      newGuestNames: ['Max'],
      availabilityChecker: avail,
    });
    ok('retry does not insert Max twice',
      retry.status === 'ok' && retry.already_added === true && retry.write_performed === false);
    const guestsAfter = await db.query(
      `SELECT COUNT(*)::int AS c FROM booking_guests WHERE booking_id = $1::uuid`,
      [SAM],
    );
    ok('retry guest count still 2', Number(guestsAfter.rows[0].c) === 2);

    await db.query(
      `INSERT INTO booking_beds (
         client_id, booking_id, bed_id, bed_code, room_code,
         assignment_start_date, assignment_end_date, assignment_type, guest_name
       ) VALUES
       ($1::uuid, $2::uuid, $3::uuid, 'R4-2', 'R4', '2027-09-20', '2027-09-23', 'Auto Assigned', 'Occ2'),
       ($1::uuid, $2::uuid, $4::uuid, 'R5-1', 'R5', '2027-09-20', '2027-09-23', 'Auto Assigned', 'Occ3')`,
      [CLIENT, SAM, BED_B, BED_C],
    );
    const noBed = await addGuestToBooking(db, {
      classicBot: true,
      clientSlug: 'wolfhouse-somo',
      bookingCode: 'WH-20270920-14052366',
      newGuestNames: ['Pia'],
      availabilityChecker: avail,
    });
    ok('no free bed returns no_availability + needs-human, no save of Pia',
      noBed.status === 'no_availability'
      && noBed.handoff_reason === 'no_bed_for_added_guest'
      && noBed.staff_review_needed === true);
    const pia = await db.query(
      `SELECT COUNT(*)::int AS c FROM booking_guests WHERE booking_id = $1::uuid AND guest_name = 'Pia'`,
      [SAM],
    );
    ok('original booking not failed: Pia not inserted', Number(pia.rows[0].c) === 0);

    const captured = [];
    const fakeRes = {};
    await handleBotBookingAddGuests(
      {
        headers: { 'x-luna-guest-phone': '+99900001111' },
      },
      fakeRes,
      { id: 'bot' },
      'bot',
      {
        DEFAULT_CLIENT: 'wolfhouse-somo',
        boundClientSlug: 'wolfhouse-somo',
        readBody: async () => JSON.stringify({
          booking_code: 'WH-20270920-14052366',
          guest_name: 'Max',
        }),
        send400: (_res, msg) => captured.push({ status: 400, body: { error: msg } }),
        sendJSON: (_res, status, body) => captured.push({ status, body }),
        withPgClient: async (fn) => fn(db),
      },
    );
    ok('bot handler retry is success already_added',
      captured[0]
      && captured[0].status === 200
      && captured[0].body.success === true
      && captured[0].body.already_added === true
      && captured[0].body.ask_deposit_or_full === true);
  } catch (err) {
    ok(`PGlite classic add-guest proof (${err && err.message ? err.message : err})`, false);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
