#!/usr/bin/env node
'use strict';

/**
 * Offline regression of the ordinary Luna WhatsApp command -> execute path.
 *   node scripts/verify-luna-create-booking-occupants.js
 *   node scripts/verify-luna-create-booking-occupants.js --payload < payload.json
 *
 * --payload consumes ONE complete transport body, without merging defaults or
 * repairing names; stdout is ONE JSON result, including `occupants` (SQL readback),
 * `contact`, `money`, `sql_calls` (actual parameters), and the service `body`.
 * A rejected create or harness failure exits nonzero and emits JSON in this mode.
 *
 * All application SQL runs unchanged in an in-memory PGlite database. No fake
 * query responses, require-cache substitutions, live PG, Stripe, or HTTP calls.
 * The supporting schema is deliberately minimal, NOT a full migration-stack
 * integration test. Occupants and CRM use the complete committed migrations 024
 * and 031, including real FKs, uniqueness constraints and customer-link triggers.
 * Inventory is seeded from the committed CSV, not current/live availability.
 * No payment is collected: the ordinary create path writes a draft payment only.
 * Bed mapping is checked against the actual booking_beds read order; production
 * orders by created_at only (ties are not guaranteed across PostgreSQL plans).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Defense in depth: this CLI must never fall through to a live transport.
const networkAttempts = [];
function denyNetwork() {
  networkAttempts.push('network transport attempted');
  throw new Error('Offline occupants regression forbids network access');
}
require('node:net').Socket.prototype.connect = denyNetwork;
require('node:tls').connect = denyNetwork;
for (const transport of ['node:http', 'node:https']) {
  require(transport).request = denyNetwork;
  require(transport).get = denyNetwork;
}
globalThis.fetch = denyNetwork;

const { PGlite } = require('@electric-sql/pglite');
const {
  BOOKING_CREATE_CHANNELS,
  buildWolfhouseBookingCreateCommand,
  executeWolfhouseBookingCreate,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { buildManualBookingCreateSql } = require('./lib/staff-manual-booking-create-sql');
const { BOOKING_GUESTS_SELECT_SQL } = require('./lib/booking-guests');
const {
  getBedCalendarRoomsQuery, getBedCalendarBlocksQuery,
} = require('./lib/staff-bed-calendar-queries');
const {
  loadWolfhouseInventoryFromCsv, WOLFHOUSE_CLIENT_SLUG,
} = require('./lib/wolfhouse-inventory-source');

const CLIENT_ID = '00000000-0000-4000-8000-000000000001';
const DEFAULT_PAYLOAD = {
  confirm: true,
  check_in: '2026-07-06',
  check_out: '2026-07-09',
  guest_count: 4,
  guest_name: 'Tom',
  guests: ['Tom', 'Tyler', 'Koa', 'Kathy'].map((name) => ({ name })),
  phone: '+999000000001',
  package_code: 'package_none',
  room_type: 'shared',
  group_gender: 'mixed',
  selected_bed_codes: ['R3-B1', 'R3-B2', 'R3-B3', 'R3-B4'],
  payment_choice: 'full',
};

const SCHEMA = `
CREATE TYPE booking_status AS ENUM ('confirmed', 'hold', 'cancelled', 'expired');
CREATE TYPE payment_status AS ENUM ('not_requested', 'deposit_paid');
CREATE TYPE payment_record_status AS ENUM ('draft');
CREATE TYPE payment_kind AS ENUM ('deposit_only', 'full_amount');
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;
CREATE TABLE clients (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE);
CREATE TABLE rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid REFERENCES clients,
  room_code text UNIQUE, name text, house text, room_type text, capacity int,
  fill_priority int, sort_order int, gender_strategy text, can_be_matrimonial boolean,
  often_used_by_operator boolean, active boolean
);
CREATE TABLE beds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid REFERENCES clients,
  room_id uuid REFERENCES rooms, bed_code text UNIQUE, bed_label text,
  bed_number int, planning_row_label text, active boolean, sellable boolean
);
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid REFERENCES clients,
  booking_code text UNIQUE, guest_name text, phone text, email text, language text,
  status booking_status, payment_status payment_status, assignment_status text,
  check_in date, check_out date, guest_count int, package_code text,
  primary_room_code text, booking_source text, staff_notes text,
  confirmation_sent_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}',
  total_amount_cents int, deposit_required_cents int, balance_due_cents int,
  requested_room_type text, needs_rooming_review boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE booking_beds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid REFERENCES clients,
  booking_id uuid REFERENCES bookings, bed_id uuid REFERENCES beds,
  bed_code text, room_code text, assignment_start_date date, assignment_end_date date,
  assignment_type text, assignment_notes text, guest_name text,
  planning_row_label text, assignment_label text, created_at timestamptz DEFAULT now()
);
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid REFERENCES clients,
  booking_id uuid REFERENCES bookings, status payment_record_status,
  payment_kind payment_kind, currency text, amount_due_cents int,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid REFERENCES clients,
  workflow_name text, node_name text, event_level text, message text,
  booking_id uuid REFERENCES bookings, payload jsonb
);
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid REFERENCES clients,
  phone text, display_name text, email text, language text, internal_staff_notes text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
`;

const normalizeSql = (sql) => String(sql).replace(/\s+/g, ' ').trim();
// Explicit allowlist: new/unexpected SQL fails, even if a production catch would
// otherwise downgrade a missing table or availability error to a warning.
const allowedSql = new Map([
  ['inventory_read', getBedCalendarRoomsQuery()],
  ['availability_read', getBedCalendarBlocksQuery()],
  ['booking_create', buildManualBookingCreateSql()],
  ['booking_update', `UPDATE bookings
    SET total_amount_cents = $1, deposit_required_cents = $2,
        balance_due_cents = $3, requested_room_type = $4,
        metadata = metadata || $5::jsonb
    WHERE id = $6 AND client_id = (SELECT id FROM clients WHERE slug = $7 LIMIT 1)`],
  ['client_read', 'SELECT client_id FROM bookings WHERE id = $1'],
  ['bed_assignment_read', `SELECT bed_code, room_code FROM booking_beds
    WHERE booking_id = $1 ORDER BY created_at ASC`],
  ['occupant_insert', `INSERT INTO booking_guests (
    client_id, booking_id, guest_number, guest_name, assigned_room_code, assigned_bed_code,
    deposit_amount_cents, amount_paid_cents, payment_status, metadata
    ) VALUES ( $1, $2, $3, $4, $5, $6, $7, 0, 'not_requested', $8::jsonb )
    RETURNING id::text AS booking_guest_id, guest_number, guest_name,
    deposit_amount_cents, payment_status`],
  ['payment_update', `UPDATE payments SET payment_kind = $1::payment_kind,
    amount_due_cents = $2, metadata = metadata || $3::jsonb
    WHERE booking_id = $4 AND client_id = (SELECT id FROM clients WHERE slug = $5 LIMIT 1)
    RETURNING id AS payment_id`],
  ['begin', 'BEGIN'], ['commit', 'COMMIT'], ['rollback', 'ROLLBACK'],
].map(([kind, sql]) => [normalizeSql(sql), kind]));

async function seed(db, payload) {
  await db.exec(SCHEMA);
  for (const migration of ['024_booking_guests.sql', '031_customers.sql']) {
    await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations', migration), 'utf8'));
  }
  await db.query('INSERT INTO clients VALUES ($1, $2)', [CLIENT_ID, WOLFHOUSE_CLIENT_SLUG]);
  const inventory = loadWolfhouseInventoryFromCsv();
  assert.ok(inventory.rooms.length >= 10, 'committed inventory must be available');
  for (const room of inventory.rooms) {
    await db.query(`INSERT INTO rooms (client_id, room_code, name, house, room_type,
      capacity, fill_priority, sort_order, gender_strategy, can_be_matrimonial,
      often_used_by_operator, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [CLIENT_ID, room.room_code, room.name, room.house, room.room_type, room.capacity,
      room.fill_priority, room.sort_order, room.gender_strategy, room.can_be_matrimonial,
      room.often_used_by_operator, room.active]);
  }
  for (const bed of inventory.beds) {
    await db.query(`INSERT INTO beds (client_id, room_id, bed_code, bed_label,
      bed_number, planning_row_label, active, sellable)
      VALUES ($1,(SELECT id FROM rooms WHERE room_code=$2),$3,$4,$5,$6,$7,$8)`,
    [CLIENT_ID, bed.room_code, bed.bed_code, bed.bed_label, bed.bed_number,
      bed.planning_row_label, bed.active, bed.sellable]);
  }
  // Existing WhatsApp contact; migration 031, not the harness, creates its CRM row.
  await db.query(`INSERT INTO conversations (client_id, phone, display_name, language)
    VALUES ($1,$2,$3,'en')`, [CLIENT_ID, payload.phone || payload.guest_phone || null,
    payload.guest_name || null]);
}

function makePg(db) {
  const calls = [];
  const errors = [];
  return {
    calls, errors,
    async query(sql, params = []) {
      const normalized = normalizeSql(sql);
      const kind = allowedSql.get(normalized);
      if (!kind) {
        const error = new Error(`Unexpected SQL (offline fail-closed): ${normalized}`);
        errors.push(error.message);
        throw error;
      }
      const call = { kind, params: structuredClone(params) };
      calls.push(call);
      try {
        const result = await db.query(sql, params);
        if (kind === 'bed_assignment_read') call.rows = structuredClone(result.rows);
        return result;
      } catch (error) {
        errors.push(`${kind}: ${error.message}`);
        throw error;
      }
    },
  };
}

function expectedNames(payload) {
  // Independent transport-contract oracle, not production normalization.
  if (Array.isArray(payload.guests) && payload.guests.length) {
    return payload.guests.map((guest) => String(guest.name || guest.guest_name || '').trim().slice(0, 200));
  }
  const count = Number(payload.guest_count);
  const primary = String(payload.guest_name || '').trim();
  return Array.from({ length: count }, (_, i) => count === 1 ? primary : `${primary} (${i + 1})`);
}

function assertOccupants(rows, names, beds) {
  assert.equal(rows.length, names.length, 'one persisted occupant per guest');
  assert.deepEqual(rows.map((row) => row.guest_name), names, 'SQL readback must preserve each occupant name');
  assert.deepEqual(rows.map((row) => row.guest_number), names.map((_, i) => i + 1));
  assert.deepEqual(rows.map((row) => row.assigned_bed_code), beds.map((bed) => bed.bed_code));
  assert.deepEqual(rows.map((row) => row.assigned_room_code), beds.map((bed) => bed.room_code));
  assert.equal(new Set(rows.map((row) => row.assigned_bed_code)).size, names.length,
    'each occupant must occupy a distinct non-null bed slot');
  assert.ok(rows.every((row) => row.assigned_bed_code && row.assigned_room_code));
}

async function runPayload(payload) {
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload), 'payload must be a JSON object');
  const db = new PGlite();
  const pg = makePg(db);
  try {
    await seed(db, payload);
    const before = (await db.query('SELECT id, full_name, phone FROM customers')).rows;
    const built = await buildWolfhouseBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
      trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
      transportBody: payload,
      pgClient: pg,
    });
    assert.deepEqual(pg.errors, [], 'no swallowed SQL failures during command build');
    if (!built.ok || !built.command) {
      return { ok: false, stage: 'build', status: built.status, body: built.body,
        occupants: [], sql_calls: pg.calls };
    }
    const result = await executeWolfhouseBookingCreate(pg, built.command, {
      stripeConfig: { stripeLinksEnabled: false },
    });
    assert.deepEqual(pg.errors, [], 'no swallowed SQL failures during create');
    if (!result.ok) return { ...result, stage: 'execute', occupants: [], sql_calls: pg.calls };
    assert.equal(result.status, 201);
    assert.equal(pg.calls.filter((call) => call.kind === 'commit').length, 1);
    assert.equal(pg.calls.filter((call) => call.kind === 'rollback').length, 0);
    assert.equal(pg.calls.filter((call) => call.kind === 'booking_create').length, 1);
    assert.ok(built.command.availabilityProvenance, 'ordinary DB-backed availability preflight ran');
    assert.ok(pg.calls.filter((call) => call.kind === 'availability_read').length >= 2,
      'ordinary execute rechecked availability');

    // Read committed data independently, with the production tenant-scoped SELECT.
    const occupants = (await db.query(BOOKING_GUESTS_SELECT_SQL,
      [WOLFHOUSE_CLIENT_SLUG, result.body.booking_code])).rows;
    const bedCall = pg.calls.find((call) => call.kind === 'bed_assignment_read');
    assert.ok(bedCall, 'production create read back real booking bed assignments');
    const names = expectedNames(payload);
    assertOccupants(occupants, names, bedCall.rows);
    assert.equal(pg.calls.filter((call) => call.kind === 'occupant_insert').length, names.length);
    assert.deepEqual(pg.calls.filter((call) => call.kind === 'occupant_insert').map((call) => call.params[3]), names);
    assert.deepEqual(result.body._booking_guests.map((row) => row.guest_name), names);
    assert.deepEqual([...bedCall.rows.map((row) => row.bed_code)].sort(),
      [...built.command.assignedBedCodes].sort());

    const bookings = (await db.query(`SELECT id, guest_name, phone, customer_id,
      total_amount_cents, deposit_required_cents, balance_due_cents, metadata FROM bookings`)).rows;
    const customers = (await db.query('SELECT id, full_name, phone FROM customers')).rows;
    const conversations = (await db.query('SELECT customer_id, display_name, phone FROM conversations')).rows;
    assert.equal(bookings.length, 1, 'one group booking, not four bookings');
    assert.equal(customers.length, 1, 'one CRM customer, not one per occupant');
    assert.equal(conversations.length, 1, 'one WhatsApp contact');
    assert.equal(before.length, 1, 'one pre-existing CRM contact');
    assert.equal(customers[0].id, before[0].id, 'existing contact identity is reused');
    assert.equal(bookings[0].customer_id, customers[0].id, 'real customer trigger links the booking');
    assert.equal(conversations[0].customer_id, customers[0].id, 'booking and conversation share customer');
    assert.equal(bookings[0].guest_name, built.command.guestName);
    assert.equal(customers[0].full_name, built.command.guestName);
    assert.equal(customers[0].phone, built.command.phone);
    assert.equal(bookings[0].phone, built.command.phone);

    const payments = (await db.query(`SELECT payment_kind, amount_due_cents, status,
      currency, booking_guest_id, metadata FROM payments`)).rows;
    assert.equal(payments.length, 1, 'create leaves one whole-booking payment, not four links');
    assert.equal(payments[0].booking_guest_id, null);
    assert.equal(payments[0].status, 'draft', 'no payment was collected');
    assert.equal(payments[0].payment_kind, built.command.paymentKind);
    assert.equal(payments[0].amount_due_cents, built.command.paymentLinkAmountCents);
    assert.equal(bookings[0].total_amount_cents, built.command.quote.total_cents);
    assert.equal(bookings[0].deposit_required_cents, built.command.quote.deposit_required_cents);
    assert.equal(bookings[0].balance_due_cents, built.command.quote.balance_due_cents);
    assert.ok(occupants.every((row) => row.amount_paid_cents === 0 && row.payment_id === null));
    assert.deepEqual(networkAttempts, []);
    return {
      ok: true, status: result.status,
      evidence_mode: 'real PGlite SQL; minimal supporting schema; committed migrations 024 + 031',
      limitations: [
        'Supporting schema is a subset, not the complete production migration stack.',
        'Bed mapping follows production booking_beds ORDER BY created_at; ties may reorder input bed codes.',
        'Create-only draft payment coverage; no payment collection, checkout, or messaging.',
      ],
      occupants,
      contact: { crm_customer_count: customers.length, conversation_count: conversations.length,
        customer: customers[0], booking_guest_name: bookings[0].guest_name,
        booking_customer_id: bookings[0].customer_id, reused_existing_identity: true },
      money: { total_cents: bookings[0].total_amount_cents,
        deposit_required_cents: bookings[0].deposit_required_cents,
        balance_due_cents: bookings[0].balance_due_cents,
        payment_link_amount_cents: built.command.paymentLinkAmountCents,
        payment_choice: built.command.paymentChoice, per_guest_payment_links: built.command.perGuestPaymentLinks,
        payments, occupant_deposits_cents: occupants.map((row) => row.deposit_amount_cents) },
      assigned_bed_codes: built.command.assignedBedCodes,
      sql_calls: pg.calls, network_attempts: networkAttempts,
      body: result.body,
    };
  } finally {
    await db.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--payload'),
    'Usage: node scripts/verify-luna-create-booking-occupants.js [--payload]');
  if (args[0] === '--payload') {
    const result = await runPayload(JSON.parse(fs.readFileSync(0, 'utf8')));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  console.log('verify:luna-create-booking-occupants — offline PGlite, real command + execute + SQL');
  const named = await runPayload(structuredClone(DEFAULT_PAYLOAD));
  assert.equal(named.ok, true, JSON.stringify(named));
  assert.deepEqual(named.assigned_bed_codes, DEFAULT_PAYLOAD.selected_bed_codes);
  assert.deepEqual([...named.occupants.map((row) => row.assigned_bed_code)].sort(),
    [...DEFAULT_PAYLOAD.selected_bed_codes].sort(), 'all four requested bed slots are populated');
  console.log('PASS named occupants: ' + named.occupants.map((row) => `${row.guest_name}=${row.assigned_bed_code}`).join(', '));
  const legacyPayload = structuredClone(DEFAULT_PAYLOAD);
  delete legacyPayload.guests;
  const legacy = await runPayload(legacyPayload);
  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  console.log('PASS legacy omission: ' + legacy.occupants.map((row) => `${row.guest_name}=${row.assigned_bed_code}`).join(', '));
  assert.deepEqual(named.money, legacy.money, 'names must not change persisted money or whole-booking payment');
  assert.deepEqual(named.body.quote, legacy.body.quote, 'entire production quote unchanged');
  assert.equal(named.money.payment_choice, 'full');
  assert.equal(named.money.per_guest_payment_links, false);
  console.log('PASS unchanged money: ' + JSON.stringify(named.money));
  console.log('PASS contact: one existing CRM identity shared by one conversation and one group booking; four occupants');
  // A genuine omission must trip the same name oracle (sensitivity control).
  assert.throws(() => assertOccupants(legacy.occupants, expectedNames(DEFAULT_PAYLOAD),
    legacy.sql_calls.find((call) => call.kind === 'bed_assignment_read').rows),
  /SQL readback must preserve each occupant name/);
  console.log('PASS negative control: legacy rows fail the named-occupant assertion');
  const guard = makePg({ query() { throw new Error('must never reach database'); } });
  await assert.rejects(guard.query('SELECT unexpected_sql'), /Unexpected SQL/);
  assert.equal(guard.errors.length, 1);
  console.log('PASS unexpected SQL fails closed; network attempts=0');
  console.log('PASSED: named + legacy ordinary create paths; real occupant insert/readback and customer triggers; no product changes');
}

main().catch((error) => {
  if (process.argv.includes('--payload')) {
    console.log(JSON.stringify({ ok: false, stage: 'harness', error: error.message, occupants: [] }));
  }
  console.error(error.stack || error);
  process.exitCode = 1;
});
