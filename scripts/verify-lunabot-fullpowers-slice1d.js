'use strict';

const assert = require('assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const create = require('./lib/luna-front-desk-accommodation-booking-create-service');
const owed = require('./lib/staff-booking-confirmation-owed');
const { markBookingConfirmationSent } = require('./lib/luna-booking-confirmation-send');
const {
  persistCrowsnestSyntheticConfirmationThreadMessage,
  receiptCrowsnestSyntheticConfirmationThreadMessage,
} = require('./lib/luna-staff-inbox-thread-message');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const BOOKING = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';

async function setup() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE bookings (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), confirmation_sent_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE booking_confirmation_owed (
      booking_id uuid PRIMARY KEY REFERENCES bookings(id), client_id uuid NOT NULL REFERENCES clients(id), owed_at timestamptz NOT NULL DEFAULT now(),
      provider_message_id text, cleared_at timestamptz, clear_reason text
    );
    CREATE TABLE booking_confirmation_delivery_events (provider_message_id text PRIMARY KEY, delivered_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE conversations (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id));
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL, conversation_id uuid NOT NULL,
      direction text, message_text text, message_type text, source text, whatsapp_message_id text, route text, metadata jsonb NOT NULL DEFAULT '{}'
    );
    INSERT INTO clients VALUES ('${CLIENT}', 'wolfhouse-somo');
    INSERT INTO bookings (id, client_id) VALUES ('${BOOKING}', '${CLIENT}');
    INSERT INTO conversations VALUES ('${CONVERSATION}', '${CLIENT}');
  `);
  return pg;
}

async function row(pg) {
  return (await pg.query('SELECT provider_message_id, cleared_at, clear_reason FROM booking_confirmation_owed WHERE booking_id=$1', [BOOKING])).rows[0];
}

async function main() {
  // Authentic room assignments must be joined to saved guests; labels and types come from configured rows.
  const facts = create.projectStaffReceiptFacts({
    guests: [{ guest_number: 1, guest_name: 'Ada' }],
    assignments: [{ guest_number: 1, bed_code: 'R1-B1', room_code: 'R1' }],
    roomRows: [{ bed_code: 'R1-B1', room_code: 'R1', room_name: null, room_type: 'mixed dorm' }],
    quote: { balance_due_timing: 'seven days before arrival' }, checkIn: '2027-06-10', clientSlug: 'wolfhouse-somo',
  });
  assert.deepEqual(facts.guest_rooms.map(({ room_label, type, number }) => ({ room_label, type, number })), [
    { room_label: 'R1', type: 'mixed dorm', number: 'R1' },
  ]);
  assert.equal(facts.balance_due_timing, 'seven days before arrival');
  assert.equal(facts.balance_due_at, '2027-06-03');

  const pg = await setup();
  await owed.recordConfirmationOwed(pg, { booking_id: BOOKING, client_id: CLIENT });

  // Accepted is a sent milestone, not delivered evidence.
  await markBookingConfirmationSent(pg, { client_slug: 'wolfhouse-somo', booking_id: BOOKING, provider_message_id: 'wamid.one' });
  assert.equal((await row(pg)).cleared_at, null);
  await owed.clearConfirmationOwedOnDelivery(pg, { provider_message_id: 'wamid.one', delivery_status: 'failed' });
  assert.equal((await row(pg)).cleared_at, null);
  assert.equal((await owed.clearConfirmationOwedOnDelivery(pg, { provider_message_id: 'wamid.one', delivery_status: 'delivered' })).cleared, true);
  assert.equal((await owed.clearConfirmationOwedOnDelivery(pg, { provider_message_id: 'wamid.one', delivery_status: 'delivered' })).cleared, false);

  // Simulator acceptance remains owed while disconnected; the authentic visible receipt clears exactly once.
  await pg.exec(`UPDATE bookings SET confirmation_sent_at=NULL, metadata='{}'; DELETE FROM booking_confirmation_owed; DELETE FROM booking_confirmation_delivery_events;`);
  await owed.recordConfirmationOwed(pg, { booking_id: BOOKING, client_id: CLIENT });
  const mirrored = await persistCrowsnestSyntheticConfirmationThreadMessage(pg, {
    client_slug: 'wolfhouse-somo', conversation_id: CONVERSATION, message_text: 'authoritative model copy',
    idempotency_key: 'confirmation:auto:WH-1', booking_id: BOOKING,
  });
  const receiptId = `simulator:${mirrored.message_id}`;
  await markBookingConfirmationSent(pg, {
    client_slug: 'wolfhouse-somo', booking_id: BOOKING, delivery_receipt_id: receiptId,
    confirmation_sent_via: 'staff_inbox_simulator',
  });
  assert.equal((await row(pg)).cleared_at, null);
  const visible = await receiptCrowsnestSyntheticConfirmationThreadMessage(pg, {
    client_slug: 'wolfhouse-somo', conversation_id: CONVERSATION, message_id: mirrored.message_id,
  });
  assert.equal(visible.changed, true);
  assert.equal(visible.confirmation_owed_cleared, true);
  const duplicate = await receiptCrowsnestSyntheticConfirmationThreadMessage(pg, {
    client_slug: 'wolfhouse-somo', conversation_id: CONVERSATION, message_id: mirrored.message_id,
  });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.confirmation_owed_cleared, false);
  assert.equal((await row(pg)).clear_reason, 'delivered');

  // Unrelated message/booking cannot reconcile this obligation.
  const unrelated = await pg.query(`INSERT INTO messages (client_id,conversation_id,direction,message_text,message_type,source,route,metadata)
    VALUES ($1,$2,'outbound','other','text','crowsnest_simulator_confirmation','staff_portal','{}') RETURNING id::text AS id`, [CLIENT, CONVERSATION]);
  const miss = await receiptCrowsnestSyntheticConfirmationThreadMessage(pg, {
    client_slug: 'wolfhouse-somo', conversation_id: CONVERSATION, message_id: unrelated.rows[0].id,
  });
  assert.equal(miss.confirmation_owed_cleared, false);

  await pg.close();
  console.log('verify-lunabot-fullpowers-slice1d: PASS');
}

main().catch((err) => { console.error(err); process.exit(1); });
