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
 * Add-on service readback uses committed migrations 010 and 018 (unscheduled dates).
 * Inventory is seeded from the committed CSV, not current/live availability.
 * No payment is collected: the ordinary create path writes a draft payment only.
 * Bed mapping is checked against the accepted input order, independently of
 * booking_beds row order (created_at ties are not guaranteed by PostgreSQL).
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
-- Explicit empty Admin pricing fixture: this harness tests occupant/service
-- persistence using the production fallback pricing contract, not live prices.
CREATE TABLE wh_pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_slug text, item_type text,
  item_code text, season_code text, unit text, amount_cents int, currency text, active boolean
);
CREATE TABLE wh_pricing_seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_slug text NOT NULL,
  code text NOT NULL, label text NOT NULL, priority int NOT NULL DEFAULT 0,
  bookable boolean NOT NULL DEFAULT true, active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0
);
CREATE TABLE wh_pricing_season_ranges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES wh_pricing_seasons(id) ON DELETE CASCADE,
  client_slug text NOT NULL, start_month smallint NOT NULL, start_day smallint NOT NULL,
  end_month smallint NOT NULL, end_day smallint NOT NULL, sort_order int NOT NULL DEFAULT 0
);
CREATE TABLE wh_pricing_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_slug text, item_type text,
  item_code text, label text, description text, metadata jsonb, active boolean, sort_order int
);
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
  metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz DEFAULT now()
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
  ['pricing_seasons_read', `SELECT s.id, s.code, s.label, s.priority, s.bookable, s.active, s.sort_order,
            COALESCE(
              json_agg(
                json_build_object(
                  'start_month', rg.start_month, 'start_day', rg.start_day,
                  'end_month', rg.end_month, 'end_day', rg.end_day
                ) ORDER BY rg.sort_order, rg.start_month, rg.start_day
              ) FILTER (WHERE rg.id IS NOT NULL), '[]'
            ) AS ranges
       FROM wh_pricing_seasons s
       LEFT JOIN wh_pricing_season_ranges rg ON rg.season_id = s.id
      WHERE s.client_slug = $1 AND s.active = true
      GROUP BY s.id
      ORDER BY s.priority DESC, s.sort_order, s.code`],
  ['pricing_items_read', `SELECT id, item_type, item_code, label, description,
    metadata, active, sort_order FROM wh_pricing_items
    WHERE client_slug = $1 AND active = true ORDER BY item_type, sort_order, label`],
  ['pricing_read', `SELECT id, item_type, item_code, season_code, unit,
    amount_cents, currency, active FROM wh_pricing_rules
    WHERE client_slug = $1 AND active = true
    ORDER BY item_type, item_code, season_code NULLS FIRST`],
  ['offer_idempotency_lookup', `/* offer_idempotency_lookup */
    SELECT bk.id AS booking_id, bk.booking_code, bk.status, bk.metadata,
           bk.check_in::text AS check_in, bk.check_out::text AS check_out,
           bk.guest_name, bk.guest_count, bk.package_code,
           (SELECT p.id FROM payments p WHERE p.booking_id = bk.id ORDER BY p.created_at LIMIT 1) AS payment_id
      FROM bookings bk
      JOIN clients c ON c.id = bk.client_id
     WHERE c.slug = $1 AND bk.metadata->>'idempotency_key' = $2
     LIMIT 1`],
  ['selling_mode_lock', `SELECT r.id, r.selling_mode FROM rooms r JOIN clients c ON c.id=r.client_id
          WHERE c.slug=$1 AND r.id IN (
            SELECT bd.room_id FROM beds bd WHERE bd.client_id=c.id AND bd.bed_code=ANY($2::text[])
          ) ORDER BY r.id FOR UPDATE OF r`],
  ['offer_season_lock', `/* offer_season_lock */ SELECT id FROM wh_pricing_seasons WHERE client_slug = $1 FOR UPDATE`],
  ['offer_price_rule_lock', `/* offer_price_lock */ SELECT id FROM wh_pricing_rules WHERE client_slug = $1 FOR UPDATE`],
  ['offer_price_item_lock', `/* offer_price_lock */ SELECT id FROM wh_pricing_items WHERE client_slug = $1 FOR UPDATE`],
  ['offer_room_lock', `/* offer_room_lock */
    SELECT bd.id
      FROM beds bd
      JOIN rooms r ON r.id = bd.room_id AND r.client_id = bd.client_id
      JOIN clients c ON c.id = bd.client_id
     WHERE c.slug = $1 AND bd.bed_code = ANY($2::text[])
     FOR UPDATE OF bd, r`],
  ['room_archive_codes', `SELECT r.room_code
       FROM rooms r
       INNER JOIN clients c ON c.id = r.client_id
       WHERE c.slug = $1
         AND COALESCE(to_jsonb(r)->>'archived_at', '') <> ''
       /* room-archive-codes */`],
  ['inventory_read', getBedCalendarRoomsQuery()],
  ['offer_commit_reread', `/* offer_commit_reread */\n${getBedCalendarRoomsQuery()}`],
  ['availability_read', getBedCalendarBlocksQuery()],
  ['offer_commit_blocks', `/* offer_commit_reread */\n${getBedCalendarBlocksQuery()}`],
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
  ['service_insert', `INSERT INTO booking_service_records (
    client_slug, booking_id, booking_code, guest_name,
    service_type, service_date, quantity, status,
    amount_due_cents, amount_paid_cents, payment_status, source, notes, metadata
    ) VALUES ( $1, $2::uuid, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13, $14::jsonb )`],
  ['begin', 'BEGIN'], ['commit', 'COMMIT'], ['rollback', 'ROLLBACK'],
].map(([kind, sql]) => [normalizeSql(sql), kind]));

// Deliberately unreachable from CLI/environment. Registered tests must pass this
// opaque process-local capability; transport JSON cannot enable the fixture.
const sim23Fixtures = new WeakMap();
function createSim23Fixture(registeredCreateBody, scenarioFacts) {
  assert.ok(registeredCreateBody && typeof registeredCreateBody === 'object');
  const offer = registeredCreateBody.accepted_offer;
  assert.ok(offer && offer.availability_checked === true,
    'Sim23 fixture requires the checked registered accepted_offer');
  assert.equal(registeredCreateBody.package_code, 'package_none');
  assert.ok(scenarioFacts && typeof scenarioFacts === 'object',
    'Sim23 fixture requires independent scenario facts');
  assert.ok(Number.isInteger(scenarioFacts.weekly_cents) && scenarioFacts.weekly_cents > 0,
    'Sim23 fixture requires an independent weekly price');
  assert.ok(Number.isInteger(scenarioFacts.deposit_per_guest_cents)
    && scenarioFacts.deposit_per_guest_cents > 0,
  'Sim23 fixture requires an independent deposit');
  assert.ok(Array.isArray(scenarioFacts.rooms) && scenarioFacts.rooms.length,
    'Sim23 fixture requires independent room facts');
  const capability = Object.freeze({});
  sim23Fixtures.set(capability, {
    body: structuredClone(registeredCreateBody),
    weeklyCents: scenarioFacts.weekly_cents,
    depositPerGuestCents: scenarioFacts.deposit_per_guest_cents,
    rooms: structuredClone(scenarioFacts.rooms),
  });
  return capability;
}

async function seed(db, payload, fixtureCapability = null) {
  await db.exec(SCHEMA);
  for (const migration of ['010_booking_service_records.sql', '018_booking_service_records_nullable_service_date.sql', '024_booking_guests.sql', '031_customers.sql', '111_room_selling_mode.sql']) {
    await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations', migration), 'utf8'));
  }
  await db.query('INSERT INTO clients VALUES ($1, $2)', [CLIENT_ID, WOLFHOUSE_CLIENT_SLUG]);
  const season = await db.query(`INSERT INTO wh_pricing_seasons
    (client_slug, code, label, priority, bookable, active, sort_order)
    VALUES ($1, 'all_year', 'All year', 1, true, true, 1) RETURNING id`,
  [WOLFHOUSE_CLIENT_SLUG]);
  await db.query(`INSERT INTO wh_pricing_season_ranges
    (season_id, client_slug, start_month, start_day, end_month, end_day, sort_order)
    VALUES ($1, $2, 1, 1, 12, 31, 1)`, [season.rows[0].id, WOLFHOUSE_CLIENT_SLUG]);
  await db.query(`INSERT INTO wh_pricing_rules
    (client_slug, item_type, item_code, season_code, unit, amount_cents, currency, active)
    VALUES ($1, 'package', 'malibu', 'all_year', 'weekly_per_person', 28000, 'EUR', true)`,
  [WOLFHOUSE_CLIENT_SLUG]);
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
  if (fixtureCapability != null) {
    const fixture = sim23Fixtures.get(fixtureCapability);
    assert.ok(fixture, 'unrecognized test fixture capability');
    assert.deepEqual(payload, fixture.body,
      'fixture is bound to the exact registered /booking-create-from-plan body');
    await db.query(`UPDATE wh_pricing_rules SET amount_cents=$1
      WHERE client_slug=$2 AND item_type='package' AND item_code='malibu'`,
    [fixture.weeklyCents, WOLFHOUSE_CLIENT_SLUG]);
    assert.ok(Number.isInteger(fixture.depositPerGuestCents));
    await db.query(`INSERT INTO wh_pricing_rules
      (client_slug, item_type, item_code, season_code, unit, amount_cents, currency, active)
      VALUES ($1, 'deposit', 'custom_or_short_stay', 'all_year', 'per_person', $2, 'EUR', true)`,
    [WOLFHOUSE_CLIENT_SLUG, fixture.depositPerGuestCents]);
    for (const room of fixture.rooms) {
      await db.query(`UPDATE rooms SET gender_strategy=$1
        WHERE client_id=$2 AND room_code=$3`,
      [room.gender_strategy, CLIENT_ID, room.room_code]);
    }
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

async function runPayload(payload, hooks = {}) {
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload), 'payload must be a JSON object');
  const db = new PGlite();
  const pg = makePg(db);
  try {
    await seed(db, payload, hooks.sim23Fixture || null);
    if (hooks.beforeBuild) await hooks.beforeBuild(db);
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
    if (hooks.beforeExecute) await hooks.beforeExecute(db, built.command);
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
    const orderedBeds = built.command.assignedBedCodes.map(code => bedCall.rows.find(bed => bed.bed_code === code));
    assertOccupants(occupants, names, orderedBeds);
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

    const payments = (await db.query(`SELECT id, payment_kind, amount_due_cents, status,
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
    const services = (await db.query(`SELECT service_type, quantity, amount_due_cents,
      amount_paid_cents, payment_status, metadata FROM booking_service_records
      WHERE booking_id = $1 AND client_slug = $2 ORDER BY service_type`,
    [bookings[0].id, WOLFHOUSE_CLIENT_SLUG])).rows;
    assert.equal(services.length, pg.calls.filter((call) => call.kind === 'service_insert').length);
    assert.deepEqual(networkAttempts, []);
    return {
      ok: true, status: result.status,
      evidence_mode: 'real PGlite SQL; minimal supporting schema; committed migrations 010 + 018 + 024 + 031',
      limitations: [
        'Supporting schema is a subset, not the complete production migration stack.',
        'Occupants are matched to accepted bed-code order, not booking_beds row order.',
        'Create-only draft payment coverage; no payment collection, checkout, or messaging.',
      ],
      occupants, services, bookings,
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
  const stableMoney = money => ({ ...money,
    payments: money.payments.map(({ id: _id, ...payment }) => payment),
  });
  assert.deepEqual(stableMoney(named.money), stableMoney(legacy.money),
    'names must not change persisted money or whole-booking payment');
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
  console.log('PASSED: named + legacy ordinary create paths; real occupant insert/readback and customer triggers');
}

// Reuse this network-fenced, in-memory schema/inventory fixture in handler regressions.
module.exports = { runPayload, seedOfflineBookingDb: seed, createSim23Fixture };

if (require.main === module) main().catch((error) => {
  if (process.argv.includes('--payload')) {
    console.log(JSON.stringify({ ok: false, stage: 'harness', error: error.message, occupants: [] }));
  }
  console.error(error.stack || error);
  process.exitCode = 1;
});
