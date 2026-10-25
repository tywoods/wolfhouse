"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { Client } = require("pg");
const defaultApi = require("./index");
const v3ops = require("./v3-operations");
const { dispatchLunaV3StaffRoute } = require("./staff-routes");
const { recordStaffManualPayment } = require("../staff-manual-payment");
const url = process.env.V3_TEST_DATABASE_URL;
if (!url) throw new Error("V3_TEST_DATABASE_URL required");
function assertDisposableDatabaseTarget(
  connectionString,
  acknowledgement = process.env.V3_TEST_DATABASE_IS_DISPOSABLE,
) {
  const parsed = new URL(connectionString);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (
    acknowledgement !== "true" ||
    !/(?:test|throwaway|disposable)/i.test(database) ||
    /^(?:postgres|template0|template1|wolfhouse|sunset_staging)$/i.test(
      database,
    )
  )
    throw new Error(
      "refusing destructive public schema reset without an explicit throwaway database target (set V3_TEST_DATABASE_IS_DISPOSABLE=true and use a test/throwaway/disposable database name)",
    );
  return database;
}
assertDisposableDatabaseTarget(url);
const ids = {
  client: "10000000-0000-0000-0000-000000000001",
  room: "20000000-0000-0000-0000-000000000001",
  b1: "30000000-0000-0000-0000-000000000001",
  b2: "30000000-0000-0000-0000-000000000002",
};
const clients = new Set();
async function c() {
  const x = new Client({ connectionString: url });
  await x.connect();
  clients.add(x);
  const end = x.end.bind(x);
  x.end = async () => {
    clients.delete(x);
    return end();
  };
  return x;
}
async function freshProcess(payload) {
  return promisify(execFile)(
    process.execPath,
    [path.join(__dirname, "test-v3-fresh-process.js")],
    {
      env: {
        ...process.env,
        V3_FRESH_PROCESS_PAYLOAD: JSON.stringify(payload),
      },
      timeout: 30000,
    },
  );
}
const base = `CREATE EXTENSION IF NOT EXISTS pgcrypto; DROP SCHEMA public CASCADE; CREATE SCHEMA public;
CREATE TYPE booking_status AS ENUM('hold','confirmed','cancelled','expired'); CREATE TYPE payment_status AS ENUM('not_requested','waiting_payment','deposit_paid','paid'); CREATE TYPE payment_record_status AS ENUM('draft','checkout_created','pending','paid','expired','cancelled','failed'); CREATE TYPE payment_kind AS ENUM('deposit_only','full_amount');
CREATE TABLE clients(id uuid primary key,slug text unique,settings jsonb default '{}');
CREATE TABLE tenant_house_notes(id uuid primary key default gen_random_uuid(),client_slug text not null unique,notes text not null default '',updated_at timestamptz not null default now(),updated_by uuid);
CREATE TABLE rooms(id uuid primary key,client_id uuid references clients,name text,room_code text unique,house text,room_type text default 'shared',capacity int default 2,fill_priority int default 1,sort_order int default 1,gender_strategy text default 'mixed',can_be_matrimonial boolean default false,often_used_by_operator boolean default true,active boolean default true,selling_mode text default 'shared');
CREATE TABLE beds(id uuid primary key,client_id uuid references clients,room_id uuid references rooms,bed_code text unique,bed_label text,bed_number int,planning_row_label text,active boolean default true,sellable boolean default true);
CREATE TABLE bookings(id uuid primary key default gen_random_uuid(),client_id uuid references clients,booking_code text unique,guest_name text,phone text,email text,language text,status booking_status,payment_status payment_status,assignment_status text,check_in date,check_out date,guest_count int,package_code text,primary_room_code text,booking_source text,staff_notes text,confirmation_sent_at timestamptz,metadata jsonb not null default '{}',total_amount_cents int,deposit_required_cents int,amount_paid_cents int default 0,deposit_paid_cents int default 0,balance_due_cents int,requested_room_type text,needs_rooming_review boolean default false,created_at timestamptz default now(),updated_at timestamptz default now());
CREATE TABLE booking_beds(id uuid primary key default gen_random_uuid(),client_id uuid references clients,booking_id uuid references bookings,bed_id uuid references beds,bed_code text,room_code text,guest_name text,assignment_start_date date,assignment_end_date date,assignment_type text,assignment_notes text,planning_row_label text,assignment_label text,created_at timestamptz default now());
CREATE TABLE payments(id uuid primary key default gen_random_uuid(),client_id uuid references clients,booking_id uuid references bookings,status payment_record_status,payment_kind payment_kind,currency text,amount_due_cents int,amount_paid_cents int default 0,metadata jsonb default '{}',created_at timestamptz default now(),paid_at timestamptz,booking_guest_id uuid);
CREATE TABLE booking_guests(id uuid primary key default gen_random_uuid(),client_id uuid references clients,booking_id uuid references bookings,guest_number int,guest_name text,assigned_room_code text,assigned_bed_code text,deposit_amount_cents int,amount_paid_cents int,payment_id uuid references payments,payment_status payment_status,metadata jsonb default '{}',updated_at timestamptz default now(),unique(booking_id,guest_number));
CREATE TABLE workflow_events(id uuid primary key default gen_random_uuid(),client_id uuid references clients,workflow_name text,node_name text,event_level text,message text,booking_id uuid references bookings,payload jsonb);
CREATE TABLE payment_events(id uuid primary key default gen_random_uuid(),client_id uuid references clients,booking_id uuid references bookings,payment_id uuid references payments,event_type text);
CREATE TABLE booking_service_records(id uuid primary key default gen_random_uuid(),client_slug text,booking_id uuid references bookings,amount_due_cents int,status text,metadata jsonb default '{}');
CREATE TABLE booking_transfers(id uuid primary key default gen_random_uuid(),client_slug text not null,booking_id uuid not null references bookings,direction text not null,status text not null default 'requested',airport_code text,airport_label text,flight_number text,lookup_date date,scheduled_at timestamptz,pickup_location text,dropoff_location text,guest_count int,price_cents int,currency text not null default 'EUR',included_in_package boolean,pricing_note text,notes text,source text not null default 'staff',flight_lookup_provider text,flight_lookup_status text,flight_lookup_summary jsonb,created_at timestamptz default now(),updated_at timestamptz default now(),unique(booking_id,direction));
CREATE TABLE wh_pricing_rules(id uuid primary key default gen_random_uuid(),client_slug text,item_type text,item_code text,season_code text,unit text,amount_cents int,currency text,active boolean); CREATE TABLE wh_pricing_items(id uuid primary key default gen_random_uuid(),client_slug text,item_type text,item_code text,label text,description text,metadata jsonb,active boolean,sort_order int); CREATE TABLE wh_pricing_seasons(id uuid primary key default gen_random_uuid(),client_slug text,code text,label text,priority int,bookable boolean,active boolean,sort_order int); CREATE TABLE wh_pricing_season_ranges(id uuid primary key default gen_random_uuid(),season_id uuid references wh_pricing_seasons,start_month smallint,start_day smallint,end_month smallint,end_day smallint,sort_order int);
CREATE TABLE wh_pricing_transfer_rules(id uuid primary key default gen_random_uuid(),client_slug text,airport_code text,label text,aliases jsonb default '[]',requires_package boolean,included_when_package boolean,min_guest_count int,max_guest_count int,unavailable_no_package_message text,unavailable_below_min_group_message text,active boolean,sort_order int);
`;
function ctx(session) {
  return {
    tenantId: "wolfhouse-somo",
    authenticated: true,
    sessionId: session,
    principalId: "staff-api-authenticated",
    writeAllowed: true,
    guestPhone: "+346****0000",
    staffAuthorities: {
      resolveBookingAdmission: async () => ({
        allowed: true,
        source: "test_policy",
      }),
    },
  };
}
async function main(api = defaultApi) {
  const observations = {};
  assert.equal(
    v3ops.madridWallTime("2027-03-28", "01:59"),
    "2027-03-28T01:59:00+01:00",
  );
  assert.equal(
    v3ops.madridWallTime("2027-03-28", "03:00"),
    "2027-03-28T03:00:00+02:00",
  );
  assert.throws(
    () => v3ops.madridWallTime("2027-03-28", "02:30"),
    /nonexistent/,
  );
  assert.equal(
    v3ops.madridWallTime("2027-10-31", "01:59"),
    "2027-10-31T01:59:00+02:00",
  );
  assert.equal(
    v3ops.madridWallTime("2027-10-31", "03:00"),
    "2027-10-31T03:00:00+01:00",
  );
  assert.throws(() => v3ops.madridWallTime("2027-10-31", "02:30"), /ambiguous/);
  const admin = await c();
  try {
    const migration091 = fs.readFileSync(
      path.join(
        __dirname,
        "../../../database/migrations/091_booking_occupancy_serialization.sql",
      ),
      "utf8",
    );
    const migration = fs.readFileSync(
      path.join(
        __dirname,
        "../../../database/migrations/114_luna_v3_staff_operations.sql",
      ),
      "utf8",
    );
    const migration115 = fs.readFileSync(
      path.join(
        __dirname,
        "../../../database/migrations/115_luna_v3_guest_operations.sql",
      ),
      "utf8",
    );
    const migration116 = fs.readFileSync(
      path.join(
        __dirname,
        "../../../database/migrations/116_luna_v3_session_phone_and_hold_invariant.sql",
      ),
      "utf8",
    );
    const migration117 = fs.readFileSync(
      path.join(
        __dirname,
        "../../../database/migrations/117_cancel_unpaid_payment_race_guard.sql",
      ),
      "utf8",
    );
    const migration118 = fs.readFileSync(
      path.join(
        __dirname,
        "../../../database/migrations/118_luna_v3_private_optional_hold_eligibility.sql",
      ),
      "utf8",
    );
    const migration119 = fs.readFileSync(
      path.join(
        __dirname,
        "../../../database/migrations/119_luna_v3_guest_payment_history.sql",
      ),
      "utf8",
    );
    const migration120 = fs.readFileSync(
      path.join(
        __dirname,
        "../../../database/migrations/120_luna_v3_constraint_ownership_and_transfer_decline.sql",
      ),
      "utf8",
    );
    const migration123 = fs.readFileSync(
      path.join(__dirname, "../../../database/migrations/123_luna_v3_one_try_offers.sql"),
      "utf8",
    );
    const migration124 = fs.readFileSync(
      path.join(__dirname, "../../../database/migrations/124_luna_v3_fix2_evidence_and_cancel_guard.sql"),
      "utf8",
    );
    await admin.query(base);
    await admin.query(migration091);
    await admin.query(
      `COMMENT ON FUNCTION booking_beds_reject_overlap() IS 'foreign owner';`,
    );
    const foreignBody = (
      await admin.query(
        `SELECT pg_get_functiondef('booking_beds_reject_overlap()'::regprocedure) body`,
      )
    ).rows[0].body;
    await assert.rejects(
      admin.query(migration),
      /not expected 091-owned definition/,
    );
    await admin.query("ROLLBACK");
    assert.equal(
      (
        await admin.query(
          `SELECT pg_get_functiondef('booking_beds_reject_overlap()'::regprocedure) body`,
        )
      ).rows[0].body,
      foreignBody,
      "foreign function was replaced",
    );
    await admin.query(base);
    await admin.query(migration091);
    await admin.query(
      `COMMENT ON FUNCTION booking_beds_reject_overlap() IS '115_newer_occupancy v1';`,
    );
    const newerBody = (
      await admin.query(
        `SELECT pg_get_functiondef('booking_beds_reject_overlap()'::regprocedure) body`,
      )
    ).rows[0].body;
    await assert.rejects(
      admin.query(migration),
      /not expected 091-owned definition/,
    );
    await admin.query("ROLLBACK");
    assert.equal(
      (
        await admin.query(
          `SELECT pg_get_functiondef('booking_beds_reject_overlap()'::regprocedure) body`,
        )
      ).rows[0].body,
      newerBody,
      "newer function was replaced",
    );
    await admin.query(base);
    await admin.query(migration091);
    await admin.query(migration);
    await admin.query(`CREATE TABLE luna_v3_notes(id uuid)`);
    await assert.rejects(admin.query(migration115), /partial installation/);
    await admin.query("ROLLBACK");
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM pg_class WHERE oid=to_regclass('luna_v3_notes')`,
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT to_regclass('luna_v3_payment_links') IS NULL missing`,
        )
      ).rows[0].missing,
      true,
    );
    await admin.query(base);
    await admin.query(migration091);
    await admin.query(migration);
    await admin.query(migration115);
    await admin.query(`COMMENT ON TABLE luna_v3_notes IS 'foreign owner'`);
    const foreignComments = (
      await admin.query(
        `SELECT relname,obj_description(oid,'pg_class') marker FROM pg_class WHERE relname LIKE 'luna_v3_%' ORDER BY relname`,
      )
    ).rows;
    await assert.rejects(
      admin.query(migration115),
      /foreign\/newer owned objects/,
    );
    await admin.query("ROLLBACK");
    assert.deepEqual(
      (
        await admin.query(
          `SELECT relname,obj_description(oid,'pg_class') marker FROM pg_class WHERE relname LIKE 'luna_v3_%' ORDER BY relname`,
        )
      ).rows,
      foreignComments,
    );
    await admin.query(
      `COMMENT ON TABLE luna_v3_notes IS '115_luna_v3_guest_operations v2'`,
    );
    const newerComments = (
      await admin.query(
        `SELECT relname,obj_description(oid,'pg_class') marker FROM pg_class WHERE relname IN ('luna_v3_notes','luna_v3_payment_links','luna_v3_transfer_requests') ORDER BY relname`,
      )
    ).rows;
    await assert.rejects(
      admin.query(migration115),
      /foreign\/newer owned objects/,
    );
    await admin.query("ROLLBACK");
    assert.deepEqual(
      (
        await admin.query(
          `SELECT relname,obj_description(oid,'pg_class') marker FROM pg_class WHERE relname IN ('luna_v3_notes','luna_v3_payment_links','luna_v3_transfer_requests') ORDER BY relname`,
        )
      ).rows,
      newerComments,
    );
    await admin.query(base);
    await admin.query(migration091);
    await admin.query(migration);
    await admin.query(migration115);
    await admin.query(
      `COMMENT ON FUNCTION luna_v3_hold_beds_reject_overlap() IS 'foreign hold owner'`,
    );
    const foreignHoldBefore = (
      await admin.query(
        `SELECT pg_get_functiondef('luna_v3_hold_beds_reject_overlap()'::regprocedure) body,obj_description('luna_v3_hold_beds_reject_overlap()'::regprocedure,'pg_proc') marker`,
      )
    ).rows[0];
    await assert.rejects(admin.query(migration), /hold invariant ownership is foreign\/newer/);
    await admin.query("ROLLBACK");
    assert.deepEqual(
      (
        await admin.query(
          `SELECT pg_get_functiondef('luna_v3_hold_beds_reject_overlap()'::regprocedure) body,obj_description('luna_v3_hold_beds_reject_overlap()'::regprocedure,'pg_proc') marker`,
        )
      ).rows[0],
      foreignHoldBefore,
      "114 mutated a foreign-owned hold invariant before refusal",
    );
    await admin.query(
      `COMMENT ON FUNCTION luna_v3_hold_beds_reject_overlap() IS '114_luna_v3_staff_operations v2; consolidated 116 and 118'`,
    );
    await admin.query(
      `COMMENT ON TRIGGER luna_v3_hold_beds_reject_overlap_trg ON luna_v3_hold_beds IS 'foreign trigger owner'`,
    );
    const foreignTriggerMarkerBefore = (
      await admin.query(
        `SELECT oid::text,pg_get_triggerdef(oid,false) def,obj_description(oid,'pg_trigger') marker FROM pg_trigger WHERE tgrelid='luna_v3_hold_beds'::regclass AND tgname='luna_v3_hold_beds_reject_overlap_trg' AND NOT tgisinternal`,
      )
    ).rows[0];
    await assert.rejects(admin.query(migration), /hold trigger ownership is foreign\/newer/);
    await admin.query("ROLLBACK");
    assert.deepEqual(
      (
        await admin.query(
          `SELECT oid::text,pg_get_triggerdef(oid,false) def,obj_description(oid,'pg_trigger') marker FROM pg_trigger WHERE tgrelid='luna_v3_hold_beds'::regclass AND tgname='luna_v3_hold_beds_reject_overlap_trg' AND NOT tgisinternal`,
        )
      ).rows[0],
      foreignTriggerMarkerBefore,
      "114 mutated a foreign-owned hold trigger before refusal",
    );
    await admin.query(
      `DROP TRIGGER luna_v3_hold_beds_reject_overlap_trg ON luna_v3_hold_beds; CREATE TRIGGER luna_v3_hold_beds_reject_overlap_trg BEFORE INSERT ON luna_v3_hold_beds FOR EACH ROW EXECUTE FUNCTION luna_v3_hold_beds_reject_overlap()`,
    );
    const foreignTriggerDefinitionBefore = (
      await admin.query(
        `SELECT oid::text,pg_get_triggerdef(oid,false) def,obj_description(oid,'pg_trigger') marker FROM pg_trigger WHERE tgrelid='luna_v3_hold_beds'::regclass AND tgname='luna_v3_hold_beds_reject_overlap_trg' AND NOT tgisinternal`,
      )
    ).rows[0];
    await assert.rejects(admin.query(migration), /hold trigger definition is foreign\/newer/);
    await admin.query("ROLLBACK");
    assert.deepEqual(
      (
        await admin.query(
          `SELECT oid::text,pg_get_triggerdef(oid,false) def,obj_description(oid,'pg_trigger') marker FROM pg_trigger WHERE tgrelid='luna_v3_hold_beds'::regclass AND tgname='luna_v3_hold_beds_reject_overlap_trg' AND NOT tgisinternal`,
        )
      ).rows[0],
      foreignTriggerDefinitionBefore,
      "114 mutated a foreign same-name hold trigger before refusal",
    );
    await admin.query(
      `DROP TRIGGER luna_v3_hold_beds_reject_overlap_trg ON luna_v3_hold_beds; CREATE TRIGGER luna_v3_hold_beds_reject_overlap_trg BEFORE INSERT OR UPDATE OF hold_id,client_id,bed_id ON luna_v3_hold_beds FOR EACH ROW EXECUTE FUNCTION luna_v3_hold_beds_reject_overlap(); COMMENT ON TRIGGER luna_v3_hold_beds_reject_overlap_trg ON luna_v3_hold_beds IS '114_luna_v3_staff_operations v2; consolidated trigger'`,
    );
    await admin.query(
      `COMMENT ON COLUMN luna_v3_sessions.guest_phone IS NULL`,
    );
    const unmarkedPhoneColumnBefore = (
      await admin.query(
        `SELECT attname,atttypid::regtype::text type,col_description('luna_v3_sessions'::regclass,attnum) marker FROM pg_attribute WHERE attrelid='luna_v3_sessions'::regclass AND attname='guest_phone' AND NOT attisdropped`,
      )
    ).rows[0];
    await assert.rejects(admin.query(migration), /existing guest_phone column is unowned/);
    await admin.query("ROLLBACK");
    assert.deepEqual(
      (
        await admin.query(
          `SELECT attname,atttypid::regtype::text type,col_description('luna_v3_sessions'::regclass,attnum) marker FROM pg_attribute WHERE attrelid='luna_v3_sessions'::regclass AND attname='guest_phone' AND NOT attisdropped`,
        )
      ).rows[0],
      unmarkedPhoneColumnBefore,
      "114 adopted an unmarked guest_phone column before refusal",
    );
    await admin.query(
      `COMMENT ON COLUMN luna_v3_sessions.guest_phone IS 'foreign phone column owner'`,
    );
    const foreignPhoneColumnBefore = (
      await admin.query(
        `SELECT col_description('luna_v3_sessions'::regclass,attnum) marker FROM pg_attribute WHERE attrelid='luna_v3_sessions'::regclass AND attname='guest_phone' AND NOT attisdropped`,
      )
    ).rows[0];
    await assert.rejects(admin.query(migration), /guest_phone column ownership is foreign\/newer/);
    await admin.query("ROLLBACK");
    assert.deepEqual(
      (
        await admin.query(
          `SELECT col_description('luna_v3_sessions'::regclass,attnum) marker FROM pg_attribute WHERE attrelid='luna_v3_sessions'::regclass AND attname='guest_phone' AND NOT attisdropped`,
        )
      ).rows[0],
      foreignPhoneColumnBefore,
      "114 mutated a foreign-owned guest_phone column before refusal",
    );
    await admin.query(
      `COMMENT ON COLUMN luna_v3_sessions.guest_phone IS '114 server-owned trusted guest phone; never request-body authority'`,
    );
    await admin.query(
      `COMMENT ON CONSTRAINT luna_v3_sessions_guest_phone_bounded ON luna_v3_sessions IS 'foreign phone owner'`,
    );
    const foreignPhoneMarkerBefore = (
      await admin.query(
        `SELECT oid::text,pg_get_constraintdef(oid,false) def,obj_description(oid,'pg_constraint') marker FROM pg_constraint WHERE conrelid='luna_v3_sessions'::regclass AND conname='luna_v3_sessions_guest_phone_bounded'`,
      )
    ).rows[0];
    await assert.rejects(admin.query(migration), /phone constraint ownership is foreign\/newer/);
    await admin.query("ROLLBACK");
    assert.deepEqual(
      (
        await admin.query(
          `SELECT oid::text,pg_get_constraintdef(oid,false) def,obj_description(oid,'pg_constraint') marker FROM pg_constraint WHERE conrelid='luna_v3_sessions'::regclass AND conname='luna_v3_sessions_guest_phone_bounded'`,
        )
      ).rows[0],
      foreignPhoneMarkerBefore,
      "114 mutated a foreign-owned phone constraint before refusal",
    );
    await admin.query(
      `COMMENT ON CONSTRAINT luna_v3_sessions_guest_phone_bounded ON luna_v3_sessions IS NULL`,
    );
    await admin.query(
      `ALTER TABLE luna_v3_sessions DROP CONSTRAINT luna_v3_sessions_guest_phone_bounded; ALTER TABLE luna_v3_sessions ADD CONSTRAINT luna_v3_sessions_guest_phone_bounded CHECK (guest_phone IS NULL OR octet_length(guest_phone) <= 80)`,
    );
    const foreignPhoneDefinitionBefore = (
      await admin.query(
        `SELECT oid::text,pg_get_constraintdef(oid,false) def,obj_description(oid,'pg_constraint') marker FROM pg_constraint WHERE conrelid='luna_v3_sessions'::regclass AND conname='luna_v3_sessions_guest_phone_bounded'`,
      )
    ).rows[0];
    await assert.rejects(admin.query(migration), /phone constraint definition is foreign\/newer/);
    await admin.query("ROLLBACK");
    assert.deepEqual(
      (
        await admin.query(
          `SELECT oid::text,pg_get_constraintdef(oid,false) def,obj_description(oid,'pg_constraint') marker FROM pg_constraint WHERE conrelid='luna_v3_sessions'::regclass AND conname='luna_v3_sessions_guest_phone_bounded'`,
        )
      ).rows[0],
      foreignPhoneDefinitionBefore,
      "114 mutated a foreign same-name phone constraint before refusal",
    );
    await admin.query(
      `ALTER TABLE luna_v3_sessions DROP CONSTRAINT luna_v3_sessions_guest_phone_bounded; ALTER TABLE luna_v3_sessions ADD CONSTRAINT luna_v3_sessions_guest_phone_bounded CHECK (guest_phone IS NULL OR (octet_length(guest_phone) BETWEEN 3 AND 40 AND guest_phone=btrim(guest_phone)))`,
    );
    const consolidated114Marker = (
      await admin.query(
        `SELECT obj_description('luna_v3_hold_beds_reject_overlap()'::regprocedure,'pg_proc') marker`,
      )
    ).rows[0].marker;
    assert.equal(
      consolidated114Marker,
      "114_luna_v3_staff_operations v2; consolidated 116 and 118",
    );
    await admin.query(
      `CREATE OR REPLACE FUNCTION luna_v3_hold_beds_reject_overlap() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE h luna_v3_holds%ROWTYPE; conflict_row uuid; BEGIN RAISE EXCEPTION 'booking_beds_overlap_conflict'; END$$`,
    );
    await assert.rejects(admin.query(migration116), /foreign\/newer/);
    await admin.query("ROLLBACK");
    await admin.query(migration);
    await assert.rejects(admin.query(migration116), /foreign\/newer/);
    await admin.query("ROLLBACK");
    assert.equal(
      (
        await admin.query(
          `SELECT obj_description('luna_v3_hold_beds_reject_overlap()'::regprocedure,'pg_proc') marker`,
        )
      ).rows[0].marker,
      consolidated114Marker,
      "superseded migration 116 replaced the consolidated 114 invariant",
    );
    await admin.query(migration117);
    await admin.query(
      `INSERT INTO clients(id,slug) VALUES('90000000-0000-0000-0000-000000000001','migration-119-test');INSERT INTO bookings(id,client_id,booking_code,status,payment_status) VALUES('90000000-0000-0000-0000-000000000002','90000000-0000-0000-0000-000000000001','M119','confirmed','not_requested');INSERT INTO booking_guests(id,client_id,booking_id,guest_number,guest_name,amount_paid_cents,payment_status) VALUES('90000000-0000-0000-0000-000000000003','90000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000002',1,'Historical',0,'not_requested');INSERT INTO payments(id,client_id,booking_id,booking_guest_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents) VALUES('90000000-0000-0000-0000-000000000004','90000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000002','90000000-0000-0000-0000-000000000003','draft','deposit_only','EUR',100,0),('90000000-0000-0000-0000-000000000005','90000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000002','90000000-0000-0000-0000-000000000003','draft','deposit_only','EUR',200,0);UPDATE booking_guests SET payment_id='90000000-0000-0000-0000-000000000005' WHERE id='90000000-0000-0000-0000-000000000003';INSERT INTO luna_v3_sessions(id,client_id,session_key,principal_id,write_admitted,selected_booking_id) VALUES('90000000-0000-0000-0000-000000000006','90000000-0000-0000-0000-000000000001','luna-v3:m119-upgrade','test',true,'90000000-0000-0000-0000-000000000002');INSERT INTO luna_v3_operations(id,client_id,session_id,tool,operation_key,request_fingerprint,receipt,outcome,booking_id,completed_at) VALUES('90000000-0000-0000-0000-000000000007','90000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000006','send_payment_link','m119-existing-link',repeat('a',64),'{}','applied','90000000-0000-0000-0000-000000000002',now());INSERT INTO luna_v3_payment_links(client_id,session_id,booking_id,operation_id,payment_id,booking_guest_id,payment_choice,amount_cents,currency,provider_checkout_id,provider_url,provider_livemode,provider_readback) VALUES('90000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000006','90000000-0000-0000-0000-000000000002','90000000-0000-0000-0000-000000000007','90000000-0000-0000-0000-000000000005','90000000-0000-0000-0000-000000000003','deposit',200,'EUR','cs_test_m119_existing','https://checkout.stripe.com/c/pay/m119',false,'{}'::jsonb)`,
    );
    await admin.query(migration119);
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM luna_v3_guest_payments WHERE booking_guest_id='90000000-0000-0000-0000-000000000003'`,
        )
      ).rows[0].n,
      2,
      "119 omitted historical payments.booking_guest_id",
    );
    await admin.query(migration119);
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM luna_v3_guest_payments WHERE booking_guest_id='90000000-0000-0000-0000-000000000003'`,
        )
      ).rows[0].n,
      2,
      "119 replay duplicated history",
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM luna_v3_payment_links WHERE provider_checkout_id='cs_test_m119_existing'`,
        )
      ).rows[0].n,
      1,
      "119 failed upgrade with existing payment link",
    );
    await admin.query(
      `INSERT INTO luna_v3_operations(id,client_id,session_id,tool,operation_key,request_fingerprint,receipt,outcome,booking_id,completed_at) VALUES('90000000-0000-0000-0000-000000000008','90000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000006','save_transfer_request','legacy-declined',repeat('b',64),'{}','applied','90000000-0000-0000-0000-000000000002',now());INSERT INTO luna_v3_transfer_requests(id,client_id,session_id,booking_id,operation_id,decision,travel_details,state,authoritative_transfer_id) VALUES('90000000-0000-0000-0000-000000000009','90000000-0000-0000-0000-000000000001','90000000-0000-0000-0000-000000000006','90000000-0000-0000-0000-000000000002','90000000-0000-0000-0000-000000000008','declined','{}','declined',NULL)`,
    );
    await admin.query(
      `DO $$DECLARE n text;BEGIN SELECT conname INTO n FROM pg_constraint WHERE conrelid='luna_v3_transfer_requests'::regclass AND pg_get_constraintdef(oid,false)='CHECK (((decision = ''requested''::text) = (authoritative_transfer_id IS NOT NULL)))';EXECUTE format('COMMENT ON CONSTRAINT %I ON luna_v3_transfer_requests IS ''foreign legacy constraint owner''',n);END$$`,
    );
    await assert.rejects(
      admin.query(migration120),
      /legacy transfer constraint ownership is foreign\/newer/,
    );
    await admin.query("ROLLBACK");
    assert.equal(
      (
        await admin.query(
          `SELECT obj_description(oid,'pg_constraint') marker FROM pg_constraint WHERE conrelid='luna_v3_transfer_requests'::regclass AND pg_get_constraintdef(oid,false)='CHECK (((decision = ''requested''::text) = (authoritative_transfer_id IS NOT NULL)))'`,
        )
      ).rows[0].marker,
      "foreign legacy constraint owner",
    );
    await admin.query(
      `DO $$DECLARE n text;BEGIN SELECT conname INTO n FROM pg_constraint WHERE conrelid='luna_v3_transfer_requests'::regclass AND pg_get_constraintdef(oid,false)='CHECK (((decision = ''requested''::text) = (authoritative_transfer_id IS NOT NULL)))';EXECUTE format('COMMENT ON CONSTRAINT %I ON luna_v3_transfer_requests IS NULL',n);END$$`,
    );
    await admin.query(
      `COMMENT ON TABLE luna_v3_transfer_requests IS 'foreign transfer owner'`,
    );
    await assert.rejects(
      admin.query(migration120),
      /transfer request table ownership is foreign\/newer/,
    );
    await admin.query("ROLLBACK");
    assert.equal(
      (
        await admin.query(
          `SELECT obj_description('luna_v3_transfer_requests'::regclass,'pg_class') marker`,
        )
      ).rows[0].marker,
      "foreign transfer owner",
    );
    await admin.query(
      `COMMENT ON TABLE luna_v3_transfer_requests IS '115_luna_v3_guest_operations v1'`,
    );
    await admin.query(migration120);
    assert.deepEqual(
      (
        await admin.query(
          `SELECT authoritative_transfer_id,authoritative_link_required FROM luna_v3_transfer_requests WHERE id='90000000-0000-0000-0000-000000000009'`,
        )
      ).rows[0],
      { authoritative_transfer_id: null, authoritative_link_required: false },
    );
    await admin.query(migration120);
    await admin.query(
      `ALTER TABLE luna_v3_transfer_requests ALTER COLUMN authoritative_link_required SET DEFAULT false`,
    );
    await assert.rejects(
      admin.query(migration120),
      /authoritative link marker column is missing, foreign, or newer/,
    );
    await admin.query("ROLLBACK");
    assert.equal(
      (
        await admin.query(
          `SELECT pg_get_expr(d.adbin,d.adrelid) value FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='luna_v3_transfer_requests'::regclass AND a.attname='authoritative_link_required'`,
        )
      ).rows[0].value,
      "false",
    );
    await admin.query(
      `ALTER TABLE luna_v3_transfer_requests ALTER COLUMN authoritative_link_required SET DEFAULT true`,
    );
    await admin.query(
      `ALTER TABLE luna_v3_transfer_requests ALTER COLUMN authoritative_link_required DROP NOT NULL`,
    );
    await assert.rejects(
      admin.query(migration120),
      /authoritative link marker column is missing, foreign, or newer/,
    );
    await admin.query("ROLLBACK");
    assert.equal(
      (
        await admin.query(
          `SELECT attnotnull FROM pg_attribute WHERE attrelid='luna_v3_transfer_requests'::regclass AND attname='authoritative_link_required'`,
        )
      ).rows[0].attnotnull,
      false,
    );
    await admin.query(
      `ALTER TABLE luna_v3_transfer_requests ALTER COLUMN authoritative_link_required SET NOT NULL`,
    );
    await admin.query(
      `COMMENT ON COLUMN luna_v3_transfer_requests.authoritative_link_required IS 'foreign marker column owner'`,
    );
    await assert.rejects(
      admin.query(migration120),
      /authoritative link marker column is missing, foreign, or newer/,
    );
    await admin.query("ROLLBACK");
    assert.equal(
      (
        await admin.query(
          `SELECT col_description('luna_v3_transfer_requests'::regclass,attnum) marker FROM pg_attribute WHERE attrelid='luna_v3_transfer_requests'::regclass AND attname='authoritative_link_required'`,
        )
      ).rows[0].marker,
      "foreign marker column owner",
    );
    await admin.query(
      `COMMENT ON COLUMN luna_v3_transfer_requests.authoritative_link_required IS '120: false only for rows predating authoritative decline linkage; new rows default true'`,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT obj_description(oid,'pg_constraint') marker FROM pg_constraint WHERE conrelid='luna_v3_sessions'::regclass AND conname='luna_v3_sessions_guest_phone_bounded'`,
        )
      ).rows[0].marker,
      "120_luna_v3_constraint_ownership_and_transfer_decline v1",
    );
    assert.equal(
      (
        await admin.query(
          `SELECT obj_description(oid,'pg_constraint') marker FROM pg_constraint WHERE conrelid='luna_v3_transfer_requests'::regclass AND conname='luna_v3_transfer_requests_authoritative_required_120'`,
        )
      ).rows[0].marker,
      "120_luna_v3_constraint_ownership_and_transfer_decline v1",
    );
    await admin.query(
      `COMMENT ON CONSTRAINT luna_v3_sessions_guest_phone_bounded ON luna_v3_sessions IS '120_luna_v3_constraint_ownership_and_transfer_decline v2'`,
    );
    await assert.rejects(
      admin.query(migration120),
      /phone constraint ownership is foreign\/newer/,
    );
    await admin.query("ROLLBACK");
    await admin.query(
      `COMMENT ON CONSTRAINT luna_v3_sessions_guest_phone_bounded ON luna_v3_sessions IS '120_luna_v3_constraint_ownership_and_transfer_decline v1'`,
    );
    await admin.query(
      `DROP TRIGGER luna_v3_preserve_guest_payment_history_trg ON booking_guests`,
    );
    await assert.rejects(admin.query(migration119), /partial installation/);
    await admin.query("ROLLBACK");
    assert.equal(
      (
        await admin.query(
          `SELECT obj_description('luna_v3_guest_payments'::regclass,'pg_class') marker`,
        )
      ).rows[0].marker,
      "119_luna_v3_guest_payment_history v1",
    );
    await admin.query(
      `CREATE TRIGGER luna_v3_preserve_guest_payment_history_trg AFTER INSERT OR UPDATE OF payment_id ON booking_guests FOR EACH ROW EXECUTE FUNCTION luna_v3_preserve_guest_payment_history();COMMENT ON TRIGGER luna_v3_preserve_guest_payment_history_trg ON booking_guests IS '119_luna_v3_guest_payment_history v1'`,
    );
    for (const foreignMarker of [
      "foreign history owner",
      "119_luna_v3_guest_payment_history v2",
    ]) {
      await admin.query(
        `COMMENT ON TABLE luna_v3_guest_payments IS '${foreignMarker}'`,
      );
      await assert.rejects(
        admin.query(migration119),
        /foreign\/newer owned objects/,
      );
      await admin.query("ROLLBACK");
      assert.equal(
        (
          await admin.query(
            `SELECT obj_description('luna_v3_guest_payments'::regclass,'pg_class') marker`,
          )
        ).rows[0].marker,
        foreignMarker,
      );
    }
    await admin.query(
      `COMMENT ON TABLE luna_v3_guest_payments IS '119_luna_v3_guest_payment_history v1'`,
    );
    await admin.query(
      `DELETE FROM luna_v3_transfer_requests WHERE client_id='90000000-0000-0000-0000-000000000001';DELETE FROM luna_v3_payment_links WHERE client_id='90000000-0000-0000-0000-000000000001';DELETE FROM luna_v3_operations WHERE client_id='90000000-0000-0000-0000-000000000001';DELETE FROM luna_v3_sessions WHERE client_id='90000000-0000-0000-0000-000000000001';DELETE FROM luna_v3_guest_payments WHERE client_id='90000000-0000-0000-0000-000000000001';DELETE FROM booking_guests WHERE client_id='90000000-0000-0000-0000-000000000001';DELETE FROM payments WHERE client_id='90000000-0000-0000-0000-000000000001';DELETE FROM bookings WHERE client_id='90000000-0000-0000-0000-000000000001';DELETE FROM clients WHERE id='90000000-0000-0000-0000-000000000001'`,
    );
    await admin.query(
      `COMMENT ON FUNCTION reject_payment_for_cancelled_booking() IS '117_cancel_unpaid_payment_race_guard v2'`,
    );
    const newer117 = (
      await admin.query(
        `SELECT pg_get_functiondef('reject_payment_for_cancelled_booking()'::regprocedure) body`,
      )
    ).rows[0].body;
    await assert.rejects(admin.query(migration117), /foreign\/newer/);
    await admin.query("ROLLBACK");
    assert.equal(
      (
        await admin.query(
          `SELECT pg_get_functiondef('reject_payment_for_cancelled_booking()'::regprocedure) body`,
        )
      ).rows[0].body,
      newer117,
      "117 replaced newer function",
    );
    await admin.query(
      `COMMENT ON FUNCTION reject_payment_for_cancelled_booking() IS '117_cancel_unpaid_payment_race_guard v1'`,
    );
    observations.migration114Ownership = true;
    console.log(
      "PASS V3-MIGRATIONS actual PostgreSQL forward-only 120 ownership; 119 existing-link upgrade/replay/partial/foreign/newer preservation and historical payment backfill",
    );
    console.log(
      "PASS V3-MIGRATION-115-OWNERSHIP initial apply and owned rerun",
    );
    console.log(
      "PASS V3-MADRID-WALL-TIME exact transition offsets; ambiguous/nonexistent refused",
    );
    // Fresh consolidated-114 -> retained-forward-migrations path: an unrelated,
    // independently named phone check must retain its identity and metadata.
    await admin.query(base);
    await admin.query(migration091);
    await admin.query(migration);
    await admin.query(migration115);
    await admin.query(
      `ALTER TABLE luna_v3_sessions ADD COLUMN IF NOT EXISTS guest_phone text; ALTER TABLE luna_v3_sessions ADD CONSTRAINT ext_phone_12 CHECK (guest_phone IS NULL OR octet_length(guest_phone)<=12); COMMENT ON CONSTRAINT ext_phone_12 ON luna_v3_sessions IS 'foreign phone policy';`,
    );
    await admin.query(migration117);
    await admin.query(migration119);
    const foreignPhoneBefore = (
      await admin.query(
        `SELECT oid::text,pg_get_constraintdef(oid,false) def,obj_description(oid,'pg_constraint') comment FROM pg_constraint WHERE conrelid='luna_v3_sessions'::regclass AND conname='ext_phone_12'`,
      )
    ).rows[0];
    await admin.query(migration120);
    const foreignPhoneAfter = (
      await admin.query(
        `SELECT oid::text,pg_get_constraintdef(oid,false) def,obj_description(oid,'pg_constraint') comment FROM pg_constraint WHERE conrelid='luna_v3_sessions'::regclass AND conname='ext_phone_12'`,
      )
    ).rows[0];
    assert.deepEqual(foreignPhoneAfter, foreignPhoneBefore);
    await assert.rejects(
      admin.query(
        `INSERT INTO luna_v3_sessions(client_id,session_key,principal_id,write_admitted,guest_phone) VALUES(gen_random_uuid(),'phone-13','p',true,'1234567890123')`,
      ),
    );
    await admin.query("ROLLBACK");
    // Full FK semantics, not just columns, identify the 115 predecessor.
    await admin.query(base);
    await admin.query(migration091);
    await admin.query(migration);
    await admin.query(migration115);
    await admin.query(migration117);
    const pointerName = (
      await admin.query(
        `SELECT conname FROM pg_constraint WHERE conrelid='luna_v3_payment_links'::regclass AND confrelid='booking_guests'::regclass AND contype='f' AND array_length(conkey,1)=4`,
      )
    ).rows[0].conname;
    await admin.query(
      `ALTER TABLE luna_v3_payment_links DROP CONSTRAINT ${pointerName}; ALTER TABLE luna_v3_payment_links ADD CONSTRAINT altered_pointer_fk FOREIGN KEY(booking_guest_id,payment_id,booking_id,client_id) REFERENCES booking_guests(id,payment_id,booking_id,client_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED`,
    );
    await assert.rejects(
      admin.query(migration119),
      /exact 115 guest pointer constraint missing/,
    );
    await admin.query("ROLLBACK");
    // A late preflight refusal must precede all 120 catalog transfer mutations.
    await admin.query(base);
    await admin.query(migration091);
    await admin.query(migration);
    await admin.query(migration115);
    await admin.query(migration117);
    await admin.query(migration119);
    await admin.query(
      `COMMENT ON TABLE luna_v3_transfer_requests IS 'foreign late preflight canary'`,
    );
    const catalogBefore = (
      await admin.query(
        `SELECT c.oid::text,c.relname,obj_description(c.oid,'pg_class') comment FROM pg_class c WHERE c.relname IN ('luna_v3_sessions','luna_v3_transfer_requests') UNION ALL SELECT c.oid::text,c.conname,obj_description(c.oid,'pg_constraint') FROM pg_constraint c WHERE c.conrelid IN ('luna_v3_sessions'::regclass,'luna_v3_transfer_requests'::regclass) ORDER BY 2`,
      )
    ).rows;
    await assert.rejects(
      admin.query(migration120),
      /transfer request table ownership is foreign/,
    );
    await admin.query("ROLLBACK");
    assert.deepEqual(
      (
        await admin.query(
          `SELECT c.oid::text,c.relname,obj_description(c.oid,'pg_class') comment FROM pg_class c WHERE c.relname IN ('luna_v3_sessions','luna_v3_transfer_requests') UNION ALL SELECT c.oid::text,c.conname,obj_description(c.oid,'pg_constraint') FROM pg_constraint c WHERE c.conrelid IN ('luna_v3_sessions'::regclass,'luna_v3_transfer_requests'::regclass) ORDER BY 2`,
        )
      ).rows,
      catalogBefore,
    );
    await admin.query(
      `COMMENT ON TABLE luna_v3_transfer_requests IS '115_luna_v3_guest_operations v1'`,
    );
    await admin.query(migration120);
    await admin.query(migration123);
    await admin.query(migration124);
    console.log(
      "PASS V3-MIGRATION-FALLBACK consolidated 114 plus retained 115/117/119/120/123 preserves foreign phone constraints, refuses altered FKs, and leaves late-preflight catalogs unchanged",
    );
    await admin.query(
      `INSERT INTO clients(id,slug) VALUES($1,'wolfhouse-somo')`,
      [ids.client],
    );
    await admin.query(
      `INSERT INTO rooms(id,client_id,name,room_code,room_type,selling_mode) VALUES($2,$1,'Room 10','R10','shared','shared')`,
      [ids.client, ids.room],
    );
    await admin.query(
      `INSERT INTO beds(id,client_id,room_id,bed_code,bed_number,active,sellable) VALUES($3,$1,$2,'R10-B1',1,true,true),($4,$1,$2,'R10-B2',2,true,true)`,
      [ids.client, ids.room, ids.b1, ids.b2],
    );
    const sessions = ["luna-v3:a", "luna-v3:b", "luna-v3:foreign"];
    for (const s of sessions)
      await admin.query(
        `INSERT INTO luna_v3_sessions(client_id,session_key,principal_id,write_admitted,guest_phone) VALUES($1,$2,'staff-api-authenticated',true,'+34611111111')`,
        [ids.client, s],
      );
    await admin.query(
      `INSERT INTO wh_pricing_seasons(client_slug,code,label,priority,bookable,active,sort_order) VALUES('wolfhouse-somo','summer','Summer',1,true,true,1);INSERT INTO wh_pricing_season_ranges(season_id,start_month,start_day,end_month,end_day,sort_order) SELECT id,1,1,12,31,1 FROM wh_pricing_seasons;INSERT INTO wh_pricing_items(client_slug,item_type,item_code,label,metadata,active,sort_order) VALUES('wolfhouse-somo','package','malibu','Malibu','{"includes":["stay"],"min_days":7}',true,1),('wolfhouse-somo','service','cap_class','Cap class','{}',true,2);INSERT INTO wh_pricing_rules(client_slug,item_type,item_code,season_code,unit,amount_cents,currency,active) VALUES('wolfhouse-somo','package','malibu','summer','per_person_per_week',50000,'EUR',true),('wolfhouse-somo','service','cap_class',NULL,'per_class',1560,'EUR',true),('wolfhouse-somo','deposit','standard_package',NULL,'per_person',20017,'EUR',true),('wolfhouse-somo','deposit','custom_or_short_stay',NULL,'per_person',60000,'EUR',true),('wolfhouse-somo','transfer','BIO',NULL,'flat',6000,'EUR',true);INSERT INTO wh_pricing_transfer_rules(client_slug,airport_code,label,aliases,requires_package,included_when_package,min_guest_count,active,sort_order) VALUES('wolfhouse-somo','BIO','Bilbao Airport','[]',true,false,4,true,1)`,
    );
    const guests = [{ name: "A" }, { name: "B" }],
      assignments = [
        { bed_code: "R10-B1", guest_name: "A", package_code: "malibu" },
        { bed_code: "R10-B2", guest_name: "B", package_code: "package_none" },
      ];
    const quoteInput = {
      operation_key: "quote-a",
      check_in: "2027-07-01",
      check_out: "2027-07-08",
      guests,
      selection: {
        selected_bed_codes: ["R10-B1", "R10-B2"],
        room_type: "shared",
        keep_together: true,
      },
      package_id: "malibu",
      guest_packages: [
        { guest_number: 1, package_code: "malibu" },
        { guest_number: 2, package_code: "package_none" },
      ],
      add_ons: [],
    };
    const deniedBefore = (
      await admin.query("SELECT count(*)::int n FROM luna_v3_selections")
    ).rows[0].n;
    await assert.rejects(
      api.quote(
        admin,
        { ...quoteInput, operation_key: "quote-denied" },
        { ...ctx("luna-v3:foreign"), writeAllowed: false },
      ),
      /write admission denied/,
    );
    assert.equal(
      (await admin.query("SELECT count(*)::int n FROM luna_v3_selections"))
        .rows[0].n,
      deniedBefore,
      "denied quote persisted selection",
    );
    const q1 = await api.quote(admin, quoteInput, ctx("luna-v3:a"));
    const q2 = await api.quote(
      admin,
      { ...quoteInput, operation_key: "quote-b" },
      ctx("luna-v3:b"),
    );
    assert.equal(q1.ok, true, JSON.stringify(q1));
    assert.equal(q2.ok, true, JSON.stringify(q2));
    assert.equal(
      (await admin.query("SELECT count(*)::int n FROM luna_v3_selections"))
        .rows[0].n,
      2,
    );
    observations.quoteAdmissionPersistence = true;
    console.log(
      "PASS V3-QUOTE-ADMISSION denied zero selections; each admitted quote persisted one server revision",
    );

    // A comparison is a set of independent persisted offers, not mutable "last quote"
    // state. Select the earlier offer only after writing a later, different offer and
    // prove hold creation binds the earlier quote's exact bed and money.
    const comparisonEarlierInput = {
      operation_key: "quote-comparison-earlier",
      check_in: "2028-02-01", check_out: "2028-02-08", guests: [{ name: "Compare" }],
      selection: { selected_bed_codes: ["R10-B1"], room_type: "shared" },
      package_id: "malibu", guest_packages: [{ guest_number: 1, package_code: "malibu" }], add_ons: [],
    };
    const comparisonEarlier = await api.quote(admin, comparisonEarlierInput, ctx("luna-v3:foreign"));
    const comparisonLater = await api.quote(admin, {
      ...comparisonEarlierInput, operation_key: "quote-comparison-later",
      selection: { selected_bed_codes: ["R10-B2"], room_type: "shared" },
      package_id: undefined, guest_packages: [], add_ons: [{ code: "cap_class", quantity: 1 }],
    }, ctx("luna-v3:foreign"));
    assert.equal(comparisonEarlier.ok, true, JSON.stringify(comparisonEarlier));
    assert.equal(comparisonLater.ok, true, JSON.stringify(comparisonLater));
    assert.notEqual(comparisonEarlier.quoteRevision, comparisonLater.quoteRevision);
    assert.notEqual(comparisonEarlier.totalCents, comparisonLater.totalCents);
    const comparisonHold = await api.holdBeds(admin, {
      operation_key: "hold-comparison-earlier", check_in: "2028-02-01", check_out: "2028-02-08",
      guests: [{ name: "Compare" }],
      assignments: [{ bed_code: "R10-B1", guest_name: "Compare", package_code: "malibu" }],
      quoted_selection: comparisonEarlier.quotedSelection,
    }, ctx("luna-v3:foreign"));
    assert.equal(comparisonHold.ok, true, JSON.stringify(comparisonHold));
    const boundComparison = (await admin.query(
      `SELECT s.quote_revision,s.quote->>'totalCents' total_cents,array_agg(hb.bed_code ORDER BY hb.bed_code) bed_codes
         FROM luna_v3_holds h JOIN luna_v3_selections s ON s.id=h.selection_id
         JOIN luna_v3_hold_beds hb ON hb.hold_id=h.id WHERE h.id=$1 GROUP BY h.id,s.id`,
      [comparisonHold.holdId],
    )).rows[0];
    assert.equal(boundComparison.quote_revision, comparisonEarlier.quoteRevision);
    assert.equal(Number(boundComparison.total_cents), comparisonEarlier.totalCents);
    assert.deepEqual(boundComparison.bed_codes, ["R10-B1"]);
    await api.releaseHold(admin, { hold_id: comparisonHold.holdId, operation_key: "release-comparison-earlier" }, ctx("luna-v3:foreign"));
    observations.comparisonOfferBinding = true;
    console.log("PASS V3-COMPARISON-BINDING earlier selected offer retains its exact quote revision, money, and bed after later quote");

    const exactMoneyInput = {
      ...quoteInput,
      operation_key: "quote-db-only-exact",
      guests: [{ name: "Money" }],
      selection: { selected_bed_codes: ["R10-B1"], room_type: "shared" },
      guest_packages: [{ guest_number: 1, package_code: "malibu" }],
      add_ons: [{ code: "cap_class", quantity: 1 }],
    };
    const exactMoney = await api.quote(
      admin,
      exactMoneyInput,
      ctx("luna-v3:foreign"),
    );
    assert.equal(exactMoney.totalCents, 51560);
    assert.equal(exactMoney.depositCents, 20017);
    assert.equal(exactMoney.remainingCents, 31543);
    assert.equal(
      exactMoney.totalCents - exactMoney.depositCents,
      exactMoney.remainingCents,
    );
    await admin.query(
      `UPDATE wh_pricing_rules SET active=false WHERE item_type='deposit' AND item_code='standard_package'`,
    );
    const missingDeposit = await api.quote(
      admin,
      { ...exactMoneyInput, operation_key: "quote-missing-deposit" },
      ctx("luna-v3:foreign"),
    );
    assert.equal(missingDeposit.ok, false);
    assert.equal(missingDeposit.code, "staff_deposit_tier_unavailable");
    await admin.query(
      `UPDATE wh_pricing_rules SET active=true WHERE item_type='deposit' AND item_code='standard_package'`,
    );
    await admin.query(
      `UPDATE wh_pricing_rules SET active=false WHERE item_type='package' AND item_code='malibu'`,
    );
    const partialPricing = await api.quote(
      admin,
      { ...exactMoneyInput, operation_key: "quote-partial-refused" },
      ctx("luna-v3:foreign"),
    );
    assert.equal(partialPricing.ok, false);
    await admin.query(
      `UPDATE wh_pricing_rules SET active=true WHERE item_type='package' AND item_code='malibu'`,
    );
    observations.staffComputedMoney = true;
    console.log(
      "PASS V3-DB-ONLY-PRICING exact 51560/20017/31543; partial DB rows refused with bundled values present",
    );
    const oneGuest = [{ name: "C" }],
      oneAssignments = [
        { bed_code: "R10-B1", guest_name: "C", package_code: "malibu" },
      ];
    const oneQuote = (start, end, key) => ({
      ...quoteInput,
      operation_key: key,
      check_in: start,
      check_out: end,
      guests: oneGuest,
      selection: { selected_bed_codes: ["R10-B1"], room_type: "shared" },
      guest_packages: [{ guest_number: 1, package_code: "malibu" }],
    });
    const availabilityQuote = await api.quote(
      admin,
      oneQuote("2027-10-01", "2027-10-08", "quote-availability"),
      ctx("luna-v3:foreign"),
    );
    assert.equal(availabilityQuote.ok, true);
    const availabilityHold = await api.holdBeds(
      admin,
      {
        operation_key: "hold-availability",
        check_in: "2027-10-01",
        check_out: "2027-10-08",
        guests: oneGuest,
        assignments: oneAssignments,
        quoted_selection: availabilityQuote.quotedSelection,
      },
      ctx("luna-v3:foreign"),
    );
    assert.equal(availabilityHold.ok, true);
    const heldAvailability = await api.checkAvailability(
      admin,
      { check_in: "2027-10-01", check_out: "2027-10-08", party_size: 1 },
      ctx("luna-v3:foreign"),
    );
    const heldRooms = await api.findRooms(
      admin,
      {
        check_in: "2027-10-01",
        check_out: "2027-10-08",
        party_size: 2,
        preferences: { keep_together: true },
      },
      ctx("luna-v3:foreign"),
    );
    assert.equal(heldAvailability.bedIds.includes("R10-B1"), false);
    assert.equal(heldRooms.roomIds.includes("R10"), false);
    await api.releaseHold(
      admin,
      {
        hold_id: availabilityHold.holdId,
        operation_key: "release-availability",
      },
      ctx("luna-v3:foreign"),
    );
    assert.equal(
      (
        await api.checkAvailability(
          admin,
          { check_in: "2027-10-01", check_out: "2027-10-08", party_size: 1 },
          ctx("luna-v3:foreign"),
        )
      ).bedIds.includes("R10-B1"),
      true,
    );
    const expiryHold = await api.holdBeds(
      admin,
      {
        operation_key: "hold-expiry",
        check_in: "2027-10-01",
        check_out: "2027-10-08",
        guests: oneGuest,
        assignments: oneAssignments,
        quoted_selection: availabilityQuote.quotedSelection,
      },
      ctx("luna-v3:foreign"),
    );
    assert.equal(expiryHold.ok, true);
    await admin.query(
      `UPDATE luna_v3_holds SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [expiryHold.holdId],
    );
    assert.equal(
      (
        await api.checkAvailability(
          admin,
          { check_in: "2027-10-01", check_out: "2027-10-08", party_size: 1 },
          ctx("luna-v3:foreign"),
        )
      ).bedIds.includes("R10-B1"),
      true,
    );
    observations.activeHoldAvailabilityLifecycle = true;
    console.log(
      "PASS V3-ACTIVE-HOLD-AVAILABILITY checkAvailability/findRooms exclude committed hold; released/expired bed reappears",
    );
    const stalePriceQuote = await api.quote(
      admin,
      oneQuote("2027-11-01", "2027-11-08", "quote-stale-price"),
      ctx("luna-v3:foreign"),
    );
    await admin.query(
      `UPDATE wh_pricing_rules SET amount_cents=amount_cents+123 WHERE item_type='package' AND item_code='malibu'`,
    );
    const stalePrice = await api.holdBeds(
      admin,
      {
        operation_key: "hold-stale-price",
        check_in: "2027-11-01",
        check_out: "2027-11-08",
        guests: oneGuest,
        assignments: oneAssignments,
        quoted_selection: stalePriceQuote.quotedSelection,
      },
      ctx("luna-v3:foreign"),
    );
    assert.equal(stalePrice.ok, false);
    assert.equal(stalePrice.code, "fresh_agreement_required");
    assert.equal(stalePrice.outcome, "rejected");
    const staleReplay = await api.holdBeds(
      await c(),
      {
        operation_key: "hold-stale-price",
        check_in: "2027-11-01",
        check_out: "2027-11-08",
        guests: oneGuest,
        assignments: oneAssignments,
        quoted_selection: stalePriceQuote.quotedSelection,
      },
      ctx("luna-v3:foreign"),
    );
    assert.deepEqual(staleReplay, stalePrice);
    const staleMismatch = await api.holdBeds(
      admin,
      {
        operation_key: "hold-stale-price",
        check_in: "2027-11-01",
        check_out: "2027-11-09",
        guests: oneGuest,
        assignments: oneAssignments,
        quoted_selection: stalePriceQuote.quotedSelection,
      },
      ctx("luna-v3:foreign"),
    );
    assert.equal(staleMismatch.code, "operation_key_payload_mismatch");
    const staleRecovery = await api.recoverOperation(
      admin,
      { tool: "hold_beds", operation_key: "hold-stale-price" },
      ctx("luna-v3:foreign"),
    );
    assert.equal(staleRecovery.outcome, "rejected");
    assert.deepEqual(staleRecovery.receipt, stalePrice);
    assert.ok(staleRecovery.requestFingerprint);
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM luna_v3_operations WHERE operation_key='hold-stale-price'`,
        )
      ).rows[0].n,
      1,
    );
    observations.stalePricingRefusal = true;
    await admin.query(
      `UPDATE wh_pricing_rules SET amount_cents=amount_cents-123 WHERE item_type='package' AND item_code='malibu'`,
    );
    console.log(
      "PASS V3-DURABLE-REJECTION rejected receipt/fingerprint replay; changed payload mismatch; recovery; one operation",
    );
    console.log(
      "PASS V3-STALE-PRICING-REFUSAL changed Staff Pricing revision refused",
    );
    const optionalQuote = await api.quote(
      admin,
      oneQuote("2027-12-01", "2027-12-08", "quote-private-optional"),
      ctx("luna-v3:foreign"),
    );
    await admin.query(
      `UPDATE rooms SET selling_mode='private_optional' WHERE id=$1`,
      [ids.room],
    );
    const optionalHold = await api.holdBeds(
      admin,
      {
        operation_key: "hold-private-optional",
        check_in: "2027-12-01",
        check_out: "2027-12-08",
        guests: oneGuest,
        assignments: oneAssignments,
        quoted_selection: optionalQuote.quotedSelection,
      },
      ctx("luna-v3:foreign"),
    );
    assert.equal(optionalHold.ok, true);
    await api.releaseHold(
      admin,
      {
        hold_id: optionalHold.holdId,
        operation_key: "release-private-optional",
      },
      ctx("luna-v3:foreign"),
    );
    await admin.query(
      `UPDATE rooms SET selling_mode='shared',room_type='shared' WHERE id=$1`,
      [ids.room],
    );
    const staleRoomQuote = await api.quote(
      admin,
      oneQuote("2027-12-10", "2027-12-17", "quote-stale-room"),
      ctx("luna-v3:foreign"),
    );
    await admin.query(`UPDATE rooms SET active=false WHERE id=$1`, [ids.room]);
    const staleRoom = await api.holdBeds(
      admin,
      {
        operation_key: "hold-stale-room",
        check_in: "2027-12-10",
        check_out: "2027-12-17",
        guests: oneGuest,
        assignments: oneAssignments,
        quoted_selection: staleRoomQuote.quotedSelection,
      },
      ctx("luna-v3:foreign"),
    );
    assert.equal(staleRoom.ok, false);
    await admin.query(`UPDATE rooms SET active=true WHERE id=$1`, [ids.room]);
    observations.privateOptionalHold = true;
    observations.staleRoomRefusal = true;
    console.log(
      "PASS V3-PRIVATE-OPTIONAL-HOLD operation and migration permit private_optional",
    );
    const input = {
      operation_key: "hold-a",
      check_in: "2027-07-01",
      check_out: "2027-07-08",
      guests,
      assignments,
      quoted_selection: q1.quotedSelection,
    };
    const a = await c(),
      b = await c();
    const [h1, h2] = await Promise.all([
      api.holdBeds(a, input, ctx("luna-v3:a")),
      api.holdBeds(
        b,
        {
          ...input,
          operation_key: "hold-b",
          quoted_selection: q2.quotedSelection,
        },
        ctx("luna-v3:b"),
      ),
    ]);
    assert.equal(
      [h1, h2].filter((x) => x.ok).length,
      1,
      "V3-HOLD-RACES v3-v3 one winner",
    );
    const winner = h1.ok ? h1 : h2;
    const ws = h1.ok ? "luna-v3:a" : "luna-v3:b";
    const ordinary = await c();
    await ordinary.query("BEGIN");
    const booking = (
      await ordinary.query(
        `INSERT INTO bookings(client_id,booking_code,status,payment_status,check_in,check_out) VALUES($1,'ordinary','confirmed','not_requested','2027-07-01','2027-07-08') RETURNING id`,
        [ids.client],
      )
    ).rows[0];
    await assert.rejects(
      ordinary.query(
        `INSERT INTO booking_beds(client_id,booking_id,bed_id,bed_code,assignment_start_date,assignment_end_date) VALUES($1,$2,$3,'R10-B1','2027-07-01','2027-07-08')`,
        [ids.client, booking.id, ids.b1],
      ),
      /booking_beds_overlap_conflict/,
    );
    await ordinary.query("ROLLBACK");
    console.log("PASS V3-HOLD-RACES v3-v3 and v3-vs-ordinary");
    // Start an ordinary booking-bed writer while holdBeds is paused after
    // reaching its first hold-bed INSERT. Every actor has an independent client.
    const gate = await c(),
      inFlightHold = await c(),
      inFlightOrdinary = await c(),
      inFlightProbe = await c();
    const gateKey = 14140020;
    await admin.query(
      `CREATE FUNCTION r20_pause_first_hold_bed() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.guest_ordinal=1 THEN PERFORM pg_advisory_xact_lock(${gateKey}); END IF; RETURN NEW; END$$; CREATE TRIGGER r20_pause_first_hold_bed_trg BEFORE INSERT ON luna_v3_hold_beds FOR EACH ROW EXECUTE FUNCTION r20_pause_first_hold_bed()`,
    );
    await gate.query(`SELECT pg_advisory_lock(${gateKey})`);
    const holdPid = (await inFlightHold.query("SELECT pg_backend_pid() pid"))
      .rows[0].pid;
    const ordinaryPid = (
      await inFlightOrdinary.query("SELECT pg_backend_pid() pid")
    ).rows[0].pid;
    const inFlightQuote = await api.quote(
      admin,
      {
        ...quoteInput,
        operation_key: "quote-r20-inflight",
        check_in: "2028-04-01",
        check_out: "2028-04-08",
      },
      ctx("luna-v3:foreign"),
    );
    const holdPending = api.holdBeds(
      inFlightHold,
      {
        ...input,
        operation_key: "hold-r20-inflight",
        quoted_selection: inFlightQuote.quotedSelection,
        check_in: "2028-04-01",
        check_out: "2028-04-08",
      },
      ctx("luna-v3:foreign"),
    );
    const waitFor = async (pid, predicate, label) => {
      for (let i = 0; i < 200; i++) {
        const row = (
          await inFlightProbe.query(
            `SELECT state,wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1`,
            [pid],
          )
        ).rows[0];
        if (row && predicate(row)) return row;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    await waitFor(
      holdPid,
      (r) => r.wait_event === "advisory",
      "hold first-bed gate",
    );
    await inFlightOrdinary.query("BEGIN");
    const inFlightBooking = (
      await inFlightOrdinary.query(
        `INSERT INTO bookings(client_id,booking_code,status,payment_status,check_in,check_out) VALUES($1,'ordinary-r20-inflight','confirmed','not_requested','2028-04-01','2028-04-08') RETURNING id`,
        [ids.client],
      )
    ).rows[0];
    const ordinaryPending = inFlightOrdinary.query(
      `INSERT INTO booking_beds(client_id,booking_id,bed_id,bed_code,assignment_start_date,assignment_end_date) VALUES($1,$2,$3,'R10-B1','2028-04-01','2028-04-08')`,
      [ids.client, inFlightBooking.id, ids.b1],
    );
    await waitFor(
      ordinaryPid,
      (r) => r.wait_event === "advisory",
      "ordinary occupancy lock",
    );
    await gate.query(`SELECT pg_advisory_unlock(${gateKey})`);
    const inFlightResult = await holdPending;
    assert.equal(inFlightResult.ok, true);
    await assert.rejects(ordinaryPending, /booking_beds_overlap_conflict/);
    await inFlightOrdinary.query("ROLLBACK");
    await admin.query(
      "DROP TRIGGER r20_pause_first_hold_bed_trg ON luna_v3_hold_beds; DROP FUNCTION r20_pause_first_hold_bed()",
    );
    await api.releaseHold(
      await c(),
      { hold_id: inFlightResult.holdId, operation_key: "release-r20-inflight" },
      ctx("luna-v3:foreign"),
    );
    await Promise.all([
      gate.end(),
      inFlightHold.end(),
      inFlightOrdinary.end(),
      inFlightProbe.end(),
    ]);
    console.log(
      "PASS V3-INFLIGHT-HOLD-RACE hold paused at first hold-bed insert; independent ordinary writer waited on occupancy lock then lost",
    );
    // Prove the first hold-bed INSERT happened even though the second fails,
    // using a nontransactional sequence, then prove every transactional row rolled back.
    await admin.query(
      `CREATE SEQUENCE r20_first_hold_bed_seen; CREATE FUNCTION r20_fail_second_hold_bed() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.guest_ordinal=1 THEN PERFORM nextval('r20_first_hold_bed_seen'); ELSIF NEW.guest_ordinal=2 THEN RAISE EXCEPTION 'injected_second_hold_bed_failure'; END IF; RETURN NEW; END$$; CREATE TRIGGER r20_fail_second_hold_bed_trg BEFORE INSERT ON luna_v3_hold_beds FOR EACH ROW EXECUTE FUNCTION r20_fail_second_hold_bed()`,
    );
    const sequenceBefore = (
      await admin.query(
        `SELECT last_value::int,is_called FROM r20_first_hold_bed_seen`,
      )
    ).rows[0];
    assert.deepEqual(
      sequenceBefore,
      { last_value: 1, is_called: false },
      "sequence must start unused",
    );
    const rollbackHoldBefore = (
      await admin.query(
        `SELECT (SELECT count(*)::int FROM luna_v3_holds) holds,(SELECT count(*)::int FROM luna_v3_hold_beds) hold_beds,(SELECT count(*)::int FROM luna_v3_operations) operations,(SELECT selected_booking_id FROM luna_v3_sessions WHERE session_key='luna-v3:foreign') selected`,
      )
    ).rows[0];
    const rollbackHoldQuote = await api.quote(
      admin,
      {
        ...quoteInput,
        operation_key: "quote-r20-hold-rollback",
        check_in: "2028-05-01",
        check_out: "2028-05-08",
      },
      ctx("luna-v3:foreign"),
    );
    await assert.rejects(
      api.holdBeds(
        await c(),
        {
          ...input,
          operation_key: "hold-r20-rollback",
          quoted_selection: rollbackHoldQuote.quotedSelection,
          check_in: "2028-05-01",
          check_out: "2028-05-08",
        },
        ctx("luna-v3:foreign"),
      ),
      /injected_second_hold_bed_failure/,
    );
    assert.deepEqual(
      (
        await admin.query(
          `SELECT last_value::int,is_called FROM r20_first_hold_bed_seen`,
        )
      ).rows[0],
      { last_value: 1, is_called: true },
      "first hold-bed insert did not execute",
    );
    const rollbackHoldAfter = (
      await admin.query(
        `SELECT (SELECT count(*)::int FROM luna_v3_holds) holds,(SELECT count(*)::int FROM luna_v3_hold_beds) hold_beds,(SELECT count(*)::int FROM luna_v3_operations) operations,(SELECT selected_booking_id FROM luna_v3_sessions WHERE session_key='luna-v3:foreign') selected`,
      )
    ).rows[0];
    assert.equal(rollbackHoldAfter.holds, rollbackHoldBefore.holds);
    assert.equal(rollbackHoldAfter.hold_beds, rollbackHoldBefore.hold_beds);
    assert.equal(
      rollbackHoldAfter.operations,
      rollbackHoldBefore.operations + 1,
      "only the successful quote operation may persist",
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM luna_v3_operations WHERE operation_key='hold-r20-rollback'`,
        )
      ).rows[0].n,
      0,
    );
    await admin.query(
      "DROP TRIGGER r20_fail_second_hold_bed_trg ON luna_v3_hold_beds; DROP FUNCTION r20_fail_second_hold_bed(); DROP SEQUENCE r20_first_hold_bed_seen",
    );
    console.log(
      "PASS V3-HOLD-ROLLBACK first insert observed nontransactionally; hold, hold-bed and operation rows rolled back",
    );
    const before = (await admin.query("SELECT count(*)::int n FROM bookings"))
      .rows[0].n;
    const rollbackBefore = (
      await admin.query(
        `SELECT (SELECT count(*)::int FROM bookings) bookings,(SELECT count(*)::int FROM booking_beds) beds,(SELECT count(*)::int FROM booking_guests) guests,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM luna_v3_operations) operations,(SELECT selected_booking_id FROM luna_v3_sessions WHERE session_key=$1) selected`,
        [ws],
      )
    ).rows[0];
    await admin.query(
      `CREATE FUNCTION v3_fail_session_bind() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.selected_booking_id IS NOT NULL THEN RAISE EXCEPTION 'injected_session_bind_failure'; END IF; RETURN NEW; END$$; CREATE TRIGGER v3_fail_session_bind_trg BEFORE UPDATE OF selected_booking_id ON luna_v3_sessions FOR EACH ROW EXECUTE FUNCTION v3_fail_session_bind()`,
    );
    await assert.rejects(
      api.book(a, { hold_id: winner.holdId, operation_key: "book-1" }, ctx(ws)),
      /injected_session_bind_failure/,
    );
    assert.equal(
      (await admin.query("SELECT count(*)::int n FROM bookings")).rows[0].n,
      before,
    );
    assert.equal(
      (
        await admin.query("SELECT state FROM luna_v3_holds WHERE id=$1", [
          winner.holdId,
        ])
      ).rows[0].state,
      "active",
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM luna_v3_operations WHERE operation_key='book-1'`,
        )
      ).rows[0].n,
      0,
    );
    const rollbackAfter = (
      await admin.query(
        `SELECT (SELECT count(*)::int FROM bookings) bookings,(SELECT count(*)::int FROM booking_beds) beds,(SELECT count(*)::int FROM booking_guests) guests,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM luna_v3_operations) operations,(SELECT selected_booking_id FROM luna_v3_sessions WHERE session_key=$1) selected`,
        [ws],
      )
    ).rows[0];
    assert.deepEqual(
      rollbackAfter,
      rollbackBefore,
      "failed booking was not all-or-none across authoritative rows and session binding",
    );
    observations.bookingRollbackReadback = true;
    await admin.query(
      "DROP TRIGGER v3_fail_session_bind_trg ON luna_v3_sessions; DROP FUNCTION v3_fail_session_bind()",
    );
    const booked = await api.book(
      a,
      { hold_id: winner.holdId, operation_key: "book-1" },
      ctx(ws),
    );
    assert.equal(booked.status, "confirmed");
    assert.equal(booked.paymentStatus, "unpaid");
    const dupe = await api.book(
      b,
      { hold_id: winner.holdId, operation_key: "book-1" },
      ctx(ws),
    );
    assert.equal(dupe.bookingId, booked.bookingId);
    const persisted = (
      await admin.query(
        `SELECT b.*,jsonb_agg(jsonb_build_object('bed',bb.bed_code,'guest',bb.guest_name) ORDER BY bb.created_at) beds FROM bookings b JOIN booking_beds bb ON bb.booking_id=b.id WHERE b.id=$1 GROUP BY b.id`,
        [booked.bookingId],
      )
    ).rows[0];
    assert.equal(persisted.status, "confirmed");
    assert.equal(persisted.payment_status, "waiting_payment");
    assert.equal(persisted.beds.length, 2);
    assert.equal(
      (await admin.query("SELECT count(*)::int n FROM bookings")).rows[0].n,
      before + 1,
    );
    console.log(
      "PASS V3-BOOK-ONE-CONFIRMED actual Staff authority, exact beds/money, duplicate persisted",
    );
    assert.equal(persisted.total_amount_cents, q1.totalCents);
    assert.equal(persisted.deposit_required_cents, q1.depositCents);
    const persistedGuests = (
      await admin.query(
        `SELECT guest_number,guest_name,assigned_bed_code,metadata->>'package_code' package_code,deposit_amount_cents FROM booking_guests WHERE booking_id=$1 ORDER BY guest_number`,
        [booked.bookingId],
      )
    ).rows;
    assert.deepEqual(
      persistedGuests.map((g) => Number(g.deposit_amount_cents)),
      q1.perPerson.map((g) => g.deposit_cents),
    );
    const independentPersonTotals = [50000, 50000],
      independentDepositRates = [20017, 60000],
      independentPersonDeposits = independentPersonTotals.map((total, i) =>
        Math.min(total, independentDepositRates[i]),
      ),
      independentTotal = independentPersonTotals.reduce((n, x) => n + x, 0),
      independentDeposit = independentPersonDeposits.reduce((n, x) => n + x, 0),
      independentBalance = independentTotal - independentDeposit;
    assert.ok(
      independentDepositRates[1] > independentPersonTotals[1],
      "deposit cap fixture is not binding",
    );
    assert.equal(q1.totalCents, independentTotal);
    assert.equal(q1.depositCents, independentDeposit);
    assert.equal(q1.remainingCents, independentBalance);
    assert.deepEqual(
      q1.lineItems
        .filter((x) => x.guest_number != null)
        .map((x) => [
          Number(x.total_cents),
          independentPersonDeposits[Number(x.guest_number) - 1],
        ]),
      independentPersonTotals.map((total, i) => [
        total,
        independentPersonDeposits[i],
      ]),
    );
    assert.equal(Number(persisted.total_amount_cents), independentTotal);
    assert.equal(Number(persisted.deposit_required_cents), independentDeposit);
    assert.equal(Number(persisted.balance_due_cents), independentTotal);
    assert.deepEqual(
      persistedGuests.map((g) => Number(g.deposit_amount_cents)),
      independentPersonDeposits,
    );
    const persistedTuples = (
      await admin.query(
        `SELECT bg.guest_number,bg.guest_name,bg.assigned_bed_code bed_code,bg.assigned_room_code room_code,bg.metadata->>'package_code' package_code,bb.assignment_start_date,bb.assignment_end_date FROM booking_guests bg JOIN booking_beds bb ON bb.client_id=bg.client_id AND bb.booking_id=bg.booking_id AND bb.bed_code=bg.assigned_bed_code WHERE bg.booking_id=$1 ORDER BY bg.guest_number`,
        [booked.bookingId],
      )
    ).rows.map((r) => [
      Number(r.guest_number),
      r.guest_name,
      r.bed_code,
      r.room_code,
      r.package_code,
      r.assignment_start_date.toISOString().slice(0, 10),
      r.assignment_end_date.toISOString().slice(0, 10),
    ]);
    assert.deepEqual(persistedTuples, [
      [1, "A", "R10-B1", "R10", "malibu", "2027-07-01", "2027-07-08"],
      [2, "B", "R10-B2", "R10", "package_none", "2027-07-01", "2027-07-08"],
    ]);
    assert.deepEqual(
      (
        await admin.query(
          `SELECT bb.bed_id::text,b.room_id::text FROM booking_beds bb JOIN beds b ON b.id=bb.bed_id WHERE bb.booking_id=$1 ORDER BY bb.bed_code`,
          [booked.bookingId],
        )
      ).rows,
      [
        { bed_id: ids.b1, room_id: ids.room },
        { bed_id: ids.b2, room_id: ids.room },
      ],
      "persisted bed/room UUID identity drift",
    );
    console.log(
      "PASS V3-MIXED-PACKAGE full persisted person/bed/room/package/date tuples and independently capped cents",
    );
    await admin.query(
      `UPDATE booking_beds SET guest_name='WRONG NAME' WHERE booking_id=$1`,
      [booked.bookingId],
    );
    const acceptedMapping = assignments.map((a, i) => [
      i + 1,
      a.guest_name,
      a.bed_code,
      a.package_code,
    ]);
    assert.deepEqual(
      booked.assignments.map((a, i) => [
        i + 1,
        a.guest_name,
        a.bed_code,
        a.package_code,
      ]),
      acceptedMapping,
    );
    assert.equal(
      persisted.check_in.toISOString().slice(0, 10),
      quoteInput.check_in,
    );
    assert.equal(
      persisted.check_out.toISOString().slice(0, 10),
      quoteInput.check_out,
    );
    assert.deepEqual(
      persistedGuests.map((g) => g.package_code),
      assignments.map((a) => a.package_code),
    );
    assert.deepEqual(
      persisted.beds.map((x) => x.bed).sort(),
      assignments.map((a) => a.bed_code).sort(),
    );
    assert.equal(Number(persisted.balance_due_cents), q1.totalCents);
    observations.exactPackageBedsDatesMoney = true;
    const read = await api.getBooking(await c(), { booking_reference: booked.bookingCode }, ctx(ws));
    assert.equal(read.bookingReference, booked.bookingCode);
    for (const internal of ["bookingId", "booking_id", "id", "booking_code", "phone", "client_id"])
      assert.equal(Object.hasOwn(read, internal), false, `public get_booking leaked ${internal}`);
    assert.equal(read.totalCents, q1.totalCents);
    assert.equal(read.depositCents, q1.depositCents);
    assert.equal(read.paidCents, 0);
    assert.equal(read.balanceDueCents, q1.totalCents);
    assert.equal(read.status, "confirmed");
    assert.equal(read.paymentStatus, "unpaid");
    assert.deepEqual(
      read.assignments.map((a) => [
        a.guestNumber,
        a.guestName,
        a.bedCode,
        a.packageCode,
      ]),
      acceptedMapping,
    );
    const forged = await api.getBooking(
      await c(),
      { booking_reference: "WH-FORGED" },
      ctx(ws),
    );
    assert.equal(forged.ok, false);
    console.log(
      "PASS V3-BOOKING-BINDING authoritative accepted money and original accepted person-to-bed-to-package mapping readback",
    );
    const recovery = await api.recoverOperation(
      await c(),
      { tool: "book", operation_key: "book-1" },
      ctx(ws),
    );
    assert.equal(recovery.receipt.bookingId, booked.bookingId);
    assert.equal(recovery.status, 200);
    assert.ok(recovery.requestFingerprint);
    const unknown = await api.recoverOperation(
      await c(),
      { tool: "book", operation_key: "none" },
      ctx(ws),
    );
    assert.equal(unknown.status, 200);
    assert.equal(unknown.recoveryStatus, "unknown");
    console.log(
      "PASS V3-TIMEOUT-REPLAY persisted authoritative readback and HTTP-valid unknown",
    );
    const foreignReleaseInput = {
      hold_id: winner.holdId,
      operation_key: "rel-f",
    };
    const foreignRelease = await api.releaseHold(
      await c(),
      foreignReleaseInput,
      ctx("luna-v3:foreign"),
    );
    assert.equal(foreignRelease.ok, false);
    assert.deepEqual(
      await api.releaseHold(
        await c(),
        foreignReleaseInput,
        ctx("luna-v3:foreign"),
      ),
      foreignRelease,
    );
    assert.equal(
      (
        await api.releaseHold(
          await c(),
          {
            ...foreignReleaseInput,
            hold_id: "00000000-0000-0000-0000-000000000000",
          },
          ctx("luna-v3:foreign"),
        )
      ).code,
      "operation_key_payload_mismatch",
    );
    const convertedInput = { hold_id: winner.holdId, operation_key: "rel-c" };
    const converted = await api.releaseHold(await c(), convertedInput, ctx(ws));
    assert.equal(converted.ok, false);
    assert.deepEqual(
      await api.releaseHold(await c(), convertedInput, ctx(ws)),
      converted,
    );
    assert.equal(
      (
        await api.recoverOperation(
          await c(),
          { tool: "release_hold", operation_key: "rel-c" },
          ctx(ws),
        )
      ).receipt.code,
      "hold_not_releasable",
    );
    assert.equal(
      (
        await api.releaseHold(
          await c(),
          {
            ...convertedInput,
            hold_id: "00000000-0000-0000-0000-000000000000",
          },
          ctx(ws),
        )
      ).code,
      "operation_key_payload_mismatch",
    );
    const releaseQuote = await api.quote(
      admin,
      {
        ...quoteInput,
        operation_key: "quote-release",
        check_in: "2027-08-01",
        check_out: "2027-08-08",
      },
      ctx(ws),
    );
    const releaseHold = await api.holdBeds(
      a,
      {
        ...input,
        operation_key: "hold-release",
        quoted_selection: releaseQuote.quotedSelection,
        check_in: "2027-08-01",
        check_out: "2027-08-08",
      },
      ctx(ws),
    );
    const released = await api.releaseHold(
      a,
      { hold_id: releaseHold.holdId, operation_key: "release-own" },
      ctx(ws),
    );
    const releasedReplay = await api.releaseHold(
      b,
      { hold_id: releaseHold.holdId, operation_key: "release-own" },
      ctx(ws),
    );
    assert.equal(released.ok, true);
    assert.equal(releasedReplay.holdId, released.holdId);
    console.log(
      "PASS V3-RELEASE-SCOPE own replay; missing/foreign/converted refusal durable with fingerprint mismatch",
    );
    // Release and conversion must serialize on the same hold row.  Use independent
    // connections so this is a real lock race, not ordered calls on one client.
    const raceQuote = await api.quote(
      admin,
      {
        ...quoteInput,
        operation_key: "quote-release-book-race",
        check_in: "2027-09-10",
        check_out: "2027-09-17",
      },
      ctx(ws),
    );
    const raceHold = await api.holdBeds(
      await c(),
      {
        ...input,
        operation_key: "hold-release-book-race",
        quoted_selection: raceQuote.quotedSelection,
        check_in: "2027-09-10",
        check_out: "2027-09-17",
      },
      ctx(ws),
    );
    assert.equal(raceHold.ok, true);
    const releaseConn = await c(),
      bookConn = await c();
    const beforeRace = (
      await admin.query(
        `SELECT (SELECT count(*)::int FROM bookings) bookings,(SELECT count(*)::int FROM payments) payments`,
      )
    ).rows[0];
    const [releaseRace, bookRace] = await Promise.all([
      api.releaseHold(
        releaseConn,
        { hold_id: raceHold.holdId, operation_key: "release-race" },
        ctx(ws),
      ),
      api.book(
        bookConn,
        { hold_id: raceHold.holdId, operation_key: "book-race" },
        ctx(ws),
      ),
    ]);
    assert.equal(
      [releaseRace, bookRace].filter((x) => x.ok === true).length,
      1,
      "release-vs-book must have exactly one applied outcome",
    );
    const raceState = (
      await admin.query(
        "SELECT state,booking_id FROM luna_v3_holds WHERE id=$1",
        [raceHold.holdId],
      )
    ).rows[0];
    const afterRace = (
      await admin.query(
        `SELECT (SELECT count(*)::int FROM bookings) bookings,(SELECT count(*)::int FROM payments) payments`,
      )
    ).rows[0];
    if (releaseRace.ok) {
      assert.equal(raceState.state, "released");
      assert.equal(raceState.booking_id, null);
      assert.equal(
        Number(afterRace.bookings),
        Number(beforeRace.bookings),
        "winning release mutated bookings",
      );
      assert.equal(
        Number(afterRace.payments),
        Number(beforeRace.payments),
        "winning release mutated payments",
      );
    } else {
      assert.equal(bookRace.ok, true);
      assert.equal(raceState.state, "converted");
      assert.equal(raceState.booking_id, bookRace.bookingId);
      assert.equal(Number(afterRace.bookings), Number(beforeRace.bookings) + 1);
      assert.equal(
        Number(afterRace.payments),
        Number(beforeRace.payments) + 1,
        "winning Staff booking did not persist its payment row",
      );
    }
    await releaseConn.end();
    await bookConn.end();
    console.log(
      "PASS V3-RELEASE-SCOPE release-vs-book serialized exactly one terminal outcome; release did not mutate booking/payment",
    );
    const freshQuote = await api.quote(
      admin,
      {
        ...quoteInput,
        operation_key: "quote-fresh-process",
        check_in: "2028-02-01",
        check_out: "2028-02-08",
      },
      ctx(ws),
    );
    const freshHold = await api.holdBeds(
      await c(),
      {
        ...input,
        operation_key: "hold-fresh-process",
        quoted_selection: freshQuote.quotedSelection,
        check_in: "2028-02-01",
        check_out: "2028-02-08",
      },
      ctx(ws),
    );
    assert.equal(freshHold.ok, true);
    const lostProcess = await freshProcess({
      action: "book",
      sessionId: ws,
      input: { hold_id: freshHold.holdId, operation_key: "book-fresh-process" },
      dropResponse: true,
    });
    assert.equal(
      lostProcess.stdout,
      "",
      "lost-response process leaked its receipt",
    );
    const recoveredProcess = await freshProcess({
      action: "recover",
      sessionId: ws,
      input: { tool: "book", operation_key: "book-fresh-process" },
    });
    const recoveredFresh = JSON.parse(recoveredProcess.stdout);
    assert.equal(recoveredFresh.receipt.consumedHoldId, freshHold.holdId);
    assert.equal(
      (
        await admin.query(`SELECT count(*)::int n FROM bookings WHERE id=$1`, [
          recoveredFresh.receipt.bookingId,
        ])
      ).rows[0].n,
      1,
    );
    observations.responseLossFreshProcess = true;
    console.log(
      "PASS V3-RESPONSE-LOSS-FRESH-PROCESS committed booking response discarded; separately started process recovered one durable receipt/readback",
    );
    const duplicateQuote = await api.quote(
      admin,
      {
        ...quoteInput,
        operation_key: "quote-concurrent-duplicate",
        check_in: "2028-03-01",
        check_out: "2028-03-08",
      },
      ctx(ws),
    );
    const duplicateHold = await api.holdBeds(
      await c(),
      {
        ...input,
        operation_key: "hold-concurrent-duplicate",
        quoted_selection: duplicateQuote.quotedSelection,
        check_in: "2028-03-01",
        check_out: "2028-03-08",
      },
      ctx(ws),
    );
    const duplicateBefore = (
      await admin.query(`SELECT count(*)::int n FROM bookings`)
    ).rows[0].n;
    const [duplicateA, duplicateB] = await Promise.all([
      api.book(
        await c(),
        {
          hold_id: duplicateHold.holdId,
          operation_key: "book-concurrent-duplicate",
        },
        ctx(ws),
      ),
      api.book(
        await c(),
        {
          hold_id: duplicateHold.holdId,
          operation_key: "book-concurrent-duplicate",
        },
        ctx(ws),
      ),
    ]);
    assert.equal(duplicateA.bookingId, duplicateB.bookingId);
    assert.equal(
      (await admin.query(`SELECT count(*)::int n FROM bookings`)).rows[0].n,
      duplicateBefore + 1,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM luna_v3_operations WHERE operation_key='book-concurrent-duplicate' AND receipt IS NOT NULL`,
        )
      ).rows[0].n,
      1,
    );
    observations.concurrentDuplicateBooking = true;
    console.log(
      "PASS V3-CONCURRENT-DUPLICATE-BOOKING independent callers share one operation receipt and persist exactly one booking",
    );
    const hand = await api.handoffToHuman(
      await c(),
      {
        operation_key: "hand-1",
        reason: "guest asks for staff",
        context: { safe: "bounded" },
      },
      ctx(ws),
    );
    const hand2 = await api.handoffToHuman(
      await c(),
      {
        operation_key: "hand-1",
        reason: "guest asks for staff",
        context: { safe: "bounded" },
      },
      ctx(ws),
    );
    assert.equal(hand.handoffId, hand2.handoffId);
    assert.equal(hand.sent, false);
    assert.equal(
      (await admin.query("SELECT count(*)::int n FROM luna_v3_handoffs"))
        .rows[0].n,
      1,
    );
    const rejectedHandoffInput = {
      operation_key: "hand-rejected",
      booking_id: "00000000-0000-0000-0000-000000000000",
      reason: "wrong booking",
      context: { safe: "bounded" },
    };
    const rejectedHandoff = await api.handoffToHuman(
      await c(),
      rejectedHandoffInput,
      ctx(ws),
    );
    assert.equal(rejectedHandoff.status, 403);
    assert.deepEqual(
      await api.handoffToHuman(await c(), rejectedHandoffInput, ctx(ws)),
      rejectedHandoff,
    );
    assert.equal(
      (
        await api.handoffToHuman(
          await c(),
          { ...rejectedHandoffInput, reason: "changed payload" },
          ctx(ws),
        )
      ).code,
      "operation_key_payload_mismatch",
    );
    assert.deepEqual(
      (
        await api.recoverOperation(
          await c(),
          { tool: "handoff_to_human", operation_key: "hand-rejected" },
          ctx(ws),
        )
      ).receipt,
      rejectedHandoff,
    );
    console.log(
      "PASS V3-HANDOFF-NO-ALERT durable applied/rejected replay and identity mismatch, no send/outbox",
    );
    await admin.query(
      `UPDATE luna_v3_sessions SET selected_booking_id=$2 WHERE session_key=$1`,
      [ws, booked.bookingId],
    );
    const selectedBooking = (
      await admin.query(
        `SELECT selected_booking_id id FROM luna_v3_sessions WHERE session_key=$1`,
        [ws],
      )
    ).rows[0].id;
    const truth = await api.getPaymentStatus(
      admin,
      { booking_id: selectedBooking },
      ctx(ws),
    );
    assert.equal(truth.paymentStatus, "unpaid");
    assert.equal(truth.evidenceStatus, "consistent");
    assert.ok(truth.paymentIds.length > 0);
    const groupPaymentRow = truth.paymentIds[0];
    await admin.query(
      `UPDATE payments SET status='paid',amount_due_cents=$2,amount_paid_cents=$2,
         metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('payment_scope','booking') WHERE id=$1`,
      [groupPaymentRow, truth.totalCents],
    );
    await admin.query(
      `UPDATE bookings SET payment_status='paid',amount_paid_cents=total_amount_cents,balance_due_cents=0 WHERE id=$1`,
      [booked.bookingId],
    );
    await admin.query(
      `INSERT INTO payment_events(client_id,booking_id,payment_id,event_type)
       SELECT client_id,id,$2,'checkout.session.completed' FROM bookings WHERE id=$1`,
      [booked.bookingId, groupPaymentRow],
    );
    const groupPaidTruth = await api.getPaymentStatus(
      admin,
      { booking_reference: booked.bookingCode },
      ctx(ws),
    );
    assert.equal(groupPaidTruth.evidenceStatus, "consistent", JSON.stringify(groupPaidTruth));
    assert.equal(groupPaidTruth.paymentStatus, "paid", JSON.stringify(groupPaidTruth));
    await admin.query(`DELETE FROM payment_events WHERE payment_id=$1`, [groupPaymentRow]);
    await admin.query(
      `UPDATE payments SET status='draft',amount_paid_cents=0,metadata=COALESCE(metadata,'{}'::jsonb)-'payment_scope' WHERE id=$1`,
      [groupPaymentRow],
    );
    await admin.query(
      `UPDATE bookings SET payment_status='waiting_payment',amount_paid_cents=0,balance_due_cents=total_amount_cents WHERE id=$1`,
      [booked.bookingId],
    );
    assert.equal(
      (
        await api.getPaymentStatus(
          admin,
          { booking_id: "00000000-0000-0000-0000-000000000000" },
          ctx(ws),
        )
      ).status,
      403,
    );
    await admin.query(
      `UPDATE bookings SET balance_due_cents=balance_due_cents+1 WHERE id=$1`,
      [booked.bookingId],
    );
    assert.equal(
      (
        await api.getPaymentStatus(
          admin,
          { booking_id: booked.bookingId },
          ctx(ws),
        )
      ).evidenceStatus,
      "inconsistent",
    );
    await admin.query(
      `UPDATE bookings SET balance_due_cents=balance_due_cents-1 WHERE id=$1`,
      [booked.bookingId],
    );
    const paymentRow = truth.paymentIds[0];
    await admin.query(
      `ALTER TYPE payment_record_status ADD VALUE IF NOT EXISTS 'paid'`,
    );
    await admin.query(`UPDATE payments SET status='paid' WHERE id=$1`, [
      paymentRow,
    ]);
    assert.equal(
      (
        await api.getPaymentStatus(
          admin,
          { booking_id: booked.bookingId },
          ctx(ws),
        )
      ).evidenceStatus,
      "inconsistent",
    );
    await admin.query(`UPDATE payments SET status='draft' WHERE id=$1`, [
      paymentRow,
    ]);
    await admin.query(`UPDATE payments SET amount_due_cents=-1 WHERE id=$1`, [
      paymentRow,
    ]);
    assert.equal(
      (
        await api.getPaymentStatus(
          admin,
          { booking_id: booked.bookingId },
          ctx(ws),
        )
      ).evidenceStatus,
      "inconsistent",
    );
    await admin.query(`UPDATE payments SET amount_due_cents=$2 WHERE id=$1`, [
      paymentRow,
      truth.payments[0].amount_due_cents,
    ]);
    await admin.query(
      `UPDATE booking_guests SET amount_paid_cents=-1 WHERE booking_id=$1 AND guest_number=1`,
      [booked.bookingId],
    );
    assert.equal(
      (
        await api.getPaymentStatus(
          admin,
          { booking_id: booked.bookingId },
          ctx(ws),
        )
      ).evidenceStatus,
      "inconsistent",
    );
    await admin.query(
      `UPDATE booking_guests SET amount_paid_cents=0 WHERE booking_id=$1 AND guest_number=1`,
      [booked.bookingId],
    );
    console.log(
      "PASS V3-PAYMENT-TRUTH strict reconciliation, nonnegative payment/person evidence and selected booking binding",
    );
    const paymentGuest = (
      await admin.query(
        `SELECT id::text,payment_id::text,guest_number FROM booking_guests WHERE booking_id=$1 ORDER BY guest_number LIMIT 1`,
        [selectedBooking],
      )
    ).rows[0];
    assert.ok(paymentGuest);
    paymentGuest.payment_id = paymentGuest.payment_id || truth.paymentIds[0];
    assert.ok(paymentGuest.payment_id);
    await admin.query(`UPDATE booking_guests SET payment_id=$2 WHERE id=$1`, [
      paymentGuest.id,
      paymentGuest.payment_id,
    ]);
    // Exercise the production manual-payment writer, not hand-built lookalike rows.
    const nativeReceipts = [];
    for (const method of ["cash", "bank_transfer", "in_store"]) {
      const receipt = await recordStaffManualPayment(admin, {
        clientSlug: "wolfhouse-somo",
        bookingId: selectedBooking,
        paymentScope: "guest",
        bookingGuestId: paymentGuest.id,
        amountCents: 1000,
        method,
        idempotencyKey: `r21-native-${method}`,
        actorLabel: "native payment ownership test",
      });
      nativeReceipts.push(receipt);
      assert.equal(receipt.payment.payment_status, "paid");
      assert.equal(receipt.payment.metadata.method, method);
      assert.equal(receipt.payment.metadata.source, `staff_${method}`);
      const methodTruth = await api.getPaymentStatus(
        admin,
        { booking_id: selectedBooking },
        ctx(ws),
      );
      assert.equal(methodTruth.evidenceStatus, "consistent", method);
      assert.equal(methodTruth.paymentStatus, "partial", method);
    }
    const cash = nativeReceipts[0];
    let paidTruth = await api.getPaymentStatus(
      admin,
      { booking_id: selectedBooking },
      ctx(ws),
    );
    await admin.query(
      `UPDATE payments SET metadata=metadata-'source'-'method'-'staff_portal' WHERE id=$1`,
      [cash.payment.payment_id],
    );
    await admin.query(
      `INSERT INTO payment_events(client_id,booking_id,payment_id,event_type) VALUES($1,$2,$3,'checkout.session.async_payment_succeeded')`,
      [ids.client, selectedBooking, cash.payment.payment_id],
    );
    paidTruth = await api.getPaymentStatus(
      admin,
      { booking_id: selectedBooking },
      ctx(ws),
    );
    assert.equal(paidTruth.evidenceStatus, "consistent");
    assert.equal(paidTruth.paymentStatus, "partial");
    // payment says guest B while history says guest A: zero cents must not make the
    // ownership contradiction disappear.
    const secondGuest = (
      await admin.query(
        `SELECT id::text FROM booking_guests WHERE booking_id=$1 ORDER BY guest_number DESC LIMIT 1`,
        [selectedBooking],
      )
    ).rows[0];
    const conflictPayment = (
      await admin.query(
        `INSERT INTO payments(client_id,booking_id,booking_guest_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents) VALUES($1,$2,$3,'draft','deposit_only','EUR',1,0) RETURNING id::text`,
        [ids.client, selectedBooking, secondGuest.id],
      )
    ).rows[0];
    await assert.rejects(
      admin.query(
        `INSERT INTO luna_v3_guest_payments(client_id,booking_id,booking_guest_id,payment_id) VALUES($1,$2,$3,$4)`,
        [ids.client, selectedBooking, paymentGuest.id, conflictPayment.id],
      ),
      /luna_v3_guest_payment_owner_conflict/,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM luna_v3_guest_payments WHERE payment_id=$1`,
          [conflictPayment.id],
        )
      ).rows[0].n,
      0,
    );
    const nativeIds = nativeReceipts.map((x) => x.payment.payment_id);
    await admin.query(
      `DELETE FROM luna_v3_guest_payments WHERE payment_id=ANY($1::uuid[])`,
      [nativeIds],
    );
    await admin.query(`DELETE FROM payment_events WHERE payment_id=$1`, [
      cash.payment.payment_id,
    ]);
    await admin.query(
      `DELETE FROM payments WHERE id=$1 OR id=ANY($2::uuid[])`,
      [conflictPayment.id, nativeIds],
    );
    await admin.query(
      `UPDATE booking_guests SET amount_paid_cents=0,payment_status='not_requested' WHERE booking_id=$1`,
      [selectedBooking],
    );
    await admin.query(
      `UPDATE bookings SET amount_paid_cents=0,balance_due_cents=total_amount_cents,payment_status='not_requested' WHERE id=$1`,
      [selectedBooking],
    );
    console.log(
      "PASS V3-NATIVE-PAYMENT-OWNERSHIP all native Staff method/source pairs accepted; async provider evidence preserved; first contradictory association rejected",
    );
    const providerSessions = new Map(),
      transport = { whatsapp: 0, sms: 0, email: 0, staffAlerts: 0, outbox: 0 };
    let providerCreates = 0,
      lostOnce = true;
    const authorityCalls = [];
    const transportTrap = (name) => async () => {
      transport[name]++;
      throw new Error(`forbidden real transport invoked: ${name}`);
    };
    const providerFor = (args) => {
      let p = providerSessions.get(args.guestId);
      if (!p) {
        providerCreates++;
        p = {
          id: "cs_test_card12_durable",
          url: "https://checkout.stripe.com/c/pay/card12",
          livemode: false,
          status: "open",
          payment_status: "unpaid",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          amount_total: 20017,
          currency: "eur",
          metadata: {
            client_slug: "wolfhouse-somo",
            booking_id: selectedBooking,
            payment_id: paymentGuest.payment_id,
            booking_guest_id: paymentGuest.id,
          },
        };
        providerSessions.set(args.guestId, p);
      }
      return p;
    };
    const authorities = {
      sendWhatsApp: transportTrap("whatsapp"),
      sendSms: transportTrap("sms"),
      sendEmail: transportTrap("email"),
      sendStaffAlert: transportTrap("staffAlerts"),
      enqueueOutbox: transportTrap("outbox"),
      createGuestCheckout: async (args) => {
        const probe = await c();
        try {
          assert.ok(
            Number.isInteger(args.operationConnectionPid),
            "payment operation did not identify its own connection",
          );
          const state = (
            await probe.query(
              `SELECT xact_start FROM pg_stat_activity WHERE pid=$1`,
              [args.operationConnectionPid],
            )
          ).rows[0];
          assert.ok(state, "payment operation connection was not observable");
          assert.equal(
            state.xact_start,
            null,
            "provider authority observed an open payment-operation DB transaction",
          );
          const intent = (
            await probe.query(
              `SELECT operation_key,request_fingerprint,receipt FROM luna_v3_operations WHERE id=$1`,
              [args.operationId],
            )
          ).rows[0];
          assert.deepEqual(
            intent,
            {
              operation_key: args.operationKey,
              request_fingerprint: args.requestFingerprint,
              receipt: null,
            },
            "provider entry could not independently read committed intent",
          );
        } finally {
          await probe.end();
        }
        authorityCalls.push(args);
        const session = providerFor(args);
        if (lostOnce) {
          lostOnce = false;
          const e = new Error("simulated_provider_response_lost");
          e.code = "simulated_provider_response_lost";
          throw e;
        }
        return {
          guest: { booking_id: selectedBooking },
          amount: 20017,
          paymentId: paymentGuest.payment_id,
          currency: "EUR",
          session,
        };
      },
      readGuestCheckout: async (id) =>
        [...providerSessions.values()].find((x) => x.id === id) || null,
    };
    const registry = api.createOperations(async (fn) => {
      const x = await c();
      try {
        return await fn(x);
      } finally {
        await x.end();
      }
    }, authorities);
    const childBookingCanary = await registry.book(
      {
        hold_id: "00000000-0000-0000-0000-000000000000",
        operation_key: "child-book-handler-canary",
      },
      ctx(ws),
    );
    assert.equal(
      childBookingCanary.ok,
      false,
      "selected child booking handler was not exercised",
    );
    assert.notEqual(childBookingCanary.bookingId, "child-only-broken");
    const routeArgs = {
      pathname: "/staff/bot/luna-v3/payment-link",
      method: "POST",
      clientSlug: "wolfhouse-somo",
      authenticatedPrincipal: {
        principalId: "staff-api-authenticated",
        writeAllowed: true,
      },
      resolveSession: async ({ selector, principalId }) =>
        selector === ws && principalId === "staff-api-authenticated"
          ? { sessionId: ws, writeAllowed: true, guestPhone: "+346****1111" }
          : null,
      operations: registry,
    };
    const selectedBookingReference = (await admin.query('SELECT booking_code FROM bookings WHERE id=$1', [selectedBooking])).rows[0].booking_code;
    const linkBody = {
      session_id: ws,
      booking_reference: selectedBookingReference,
      payment_scope: "individual",
      guest_position: Number(paymentGuest.guest_number),
      payment_choice: "deposit",
      operation_key: "card12-link",
      external_send_allowed: false,
      staff_alert_allowed: false,
    };
    const lost = await dispatchLunaV3StaffRoute({
      ...routeArgs,
      body: linkBody,
    });
    assert.equal(lost.status, 503);
    assert.equal(lost.body.recoveryStatus, "ambiguous");
    const durableIntent = (
      await admin.query(
        `SELECT receipt IS NULL pending FROM luna_v3_operations WHERE operation_key='card12-link'`,
      )
    ).rows[0];
    assert.equal(durableIntent.pending, true);
    assert.equal(providerCreates, 1);
    await admin.query(
      `CREATE FUNCTION card12_fail_local() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected_card12_local_failure';END$$;CREATE TRIGGER card12_fail_local_trg BEFORE INSERT ON luna_v3_payment_links FOR EACH ROW EXECUTE FUNCTION card12_fail_local()`,
    );
    const localFailure = await dispatchLunaV3StaffRoute({
      ...routeArgs,
      body: linkBody,
    });
    assert.equal(localFailure.status, 500);
    await admin.query(
      `DROP TRIGGER card12_fail_local_trg ON luna_v3_payment_links;DROP FUNCTION card12_fail_local()`,
    );
    const restartedRegistry = api.createOperations(async (fn) => {
      const x = await c();
      try {
        return await fn(x);
      } finally {
        await x.end();
      }
    }, authorities);
    const recovered = await dispatchLunaV3StaffRoute({
      ...routeArgs,
      operations: restartedRegistry,
      body: linkBody,
    });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.checkoutId, "cs_test_card12_durable");
    assert.equal(recovered.body.sent, false);
    assert.equal(providerCreates, 1);
    const replay = await dispatchLunaV3StaffRoute({
      ...routeArgs,
      operations: restartedRegistry,
      body: linkBody,
    });
    assert.deepEqual(replay.body, recovered.body);
    assert.equal(providerCreates, 1);
    const changed = await dispatchLunaV3StaffRoute({
      ...routeArgs,
      operations: restartedRegistry,
      body: { ...linkBody, payment_choice: "balance" },
    });
    assert.equal(changed.body.code, "operation_key_payload_mismatch");
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM luna_v3_payment_links WHERE provider_checkout_id='cs_test_card12_durable'`,
        )
      ).rows[0].n,
      1,
    );
    assert.deepEqual(transport, {
      whatsapp: 0,
      sms: 0,
      email: 0,
      staffAlerts: 0,
      outbox: 0,
    });
    const routeNegative = async (overrides = {}, top = {}) =>
      dispatchLunaV3StaffRoute({
        ...routeArgs,
        operations: restartedRegistry,
        ...top,
        body: {
          ...linkBody,
          operation_key: `neg-${Math.random()}`,
          ...overrides,
        },
      });
    assert.equal(
      (await routeNegative({}, { clientSlug: "sunset" })).status,
      403,
    );
    assert.equal(
      (await routeNegative({ session_id: "luna-v3:foreign" })).status,
      403,
    );
    assert.equal(
      (await routeNegative({}, { authenticatedPrincipal: null })).status,
      403,
    );
    assert.equal(
      (
        await routeNegative(
          {},
          {
            authenticatedPrincipal: {
              principalId: "staff-api-authenticated",
              writeAllowed: false,
            },
          },
        )
      ).status,
      403,
    );
    assert.equal(
      (await routeNegative({ operation_key: undefined })).status,
      400,
    );
    assert.equal(
      (
        await routeNegative({
          guest_position: 999,
        })
      ).status,
      403,
    );
    const unavailable = await routeNegative(
      {},
      {
        operations: api.createOperations(async (fn) => {
          const x = await c();
          try {
            return await fn(x);
          } finally {
            await x.end();
          }
        }, {}),
      },
    );
    assert.equal(unavailable.status, 503);
    for (const field of ["provider_mode", "destination", "send_sms", "trusted"])
      assert.equal(
        (
          await routeNegative({
            [field]: field === "send_sms" ? true : "forged",
          })
        ).status,
        400,
        field,
      );
    const forgedProvider = {
      ...providerFor({ guestId: "forged" }),
      id: "cs_live_forged",
      url: "https://example.test/fake",
      livemode: true,
    };
    const missingRequiredProvider = {
      ...providerFor({ guestId: "missing-required" }),
      id: "cs_test_missing_required",
      metadata: { ...providerFor({ guestId: "missing-required" }).metadata },
    };
    delete missingRequiredProvider.metadata.payment_id;
    const missingRequiredRegistry = api.createOperations(
      async (fn) => {
        const x = await c();
        try {
          return await fn(x);
        } finally {
          await x.end();
        }
      },
      {
        createGuestCheckout: async () => ({
          amount: 20017,
          paymentId: paymentGuest.payment_id,
          currency: "EUR",
          session: missingRequiredProvider,
        }),
        readGuestCheckout: async () => missingRequiredProvider,
      },
    );
    const missingRequiredResult = await dispatchLunaV3StaffRoute({
      ...routeArgs,
      operations: missingRequiredRegistry,
      body: { ...linkBody, operation_key: "card12-missing-required" },
    });
    assert.equal(missingRequiredResult.status, 409);
    assert.equal(missingRequiredResult.body.code, "provider_readback_mismatch");
    const forgedAuthorities = {
      createGuestCheckout: async () => ({
        amount: 20017,
        paymentId: paymentGuest.payment_id,
        currency: "EUR",
        session: forgedProvider,
      }),
      readGuestCheckout: async () => forgedProvider,
    };
    const forgedRegistry = api.createOperations(async (fn) => {
      const x = await c();
      try {
        return await fn(x);
      } finally {
        await x.end();
      }
    }, forgedAuthorities);
    const forgedResult = await dispatchLunaV3StaffRoute({
      ...routeArgs,
      operations: forgedRegistry,
      body: { ...linkBody, operation_key: "card12-forged" },
    });
    assert.equal(forgedResult.status, 409);
    assert.equal(forgedResult.body.code, "provider_readback_mismatch");
    const zeroAuthorities = {
      createGuestCheckout: async () => ({
        zero: true,
        guest: { booking_id: selectedBooking },
        amount: 0,
      }),
      readGuestCheckout: async () => {
        throw new Error("zero checkout must not read provider");
      },
    };
    const zeroRegistry = api.createOperations(async (fn) => {
      const x = await c();
      try {
        return await fn(x);
      } finally {
        await x.end();
      }
    }, zeroAuthorities);
    const zeroBody = { ...linkBody, operation_key: "card12-zero" };
    const zeroResult = await dispatchLunaV3StaffRoute({
      ...routeArgs,
      operations: zeroRegistry,
      body: zeroBody,
    });
    assert.equal(zeroResult.status, 422);
    assert.equal(zeroResult.body.code, "nothing_payable");
    const zeroRecovery = await api.recoverOperation(
      await c(),
      { tool: "send_payment_link", operation_key: "card12-zero" },
      ctx(ws),
    );
    assert.equal(zeroRecovery.receipt.code, "nothing_payable");
    assert.equal(zeroRecovery.receipt.outcome, "rejected");
    observations.paymentLinkOfflineBoundary = true;
    observations.paymentLinkDurableIntentBeforeProvider = true;
    observations.paymentLinkRestartRecovery = true;
    observations.paymentLinkProviderReadback = true;
    observations.paymentLinkTransportTraps = true;
    console.log(
      "PASS V3-PAYMENT-LINK-OFFLINE-DURABILITY registry route committed intent before provider with no open transaction; lost response + local DB failure recovered after new connections to one checkout",
    );
    console.log(
      "PASS V3-PAYMENT-LINK-READBACK exact Staff guest/payment/money and independent provider identity/url/test/status/expiry/metadata; forged live/url rejected; all transport traps zero",
    );
    console.log(
      "PASS V3-PAYMENT-LINK-ROUTE-NEGATIVES tenant/session/principal/write/key/guest/authority/injected fields refused with numeric HTTP statuses",
    );
    console.log(
      "PENDING payment_link_returned_not_sent: actualSandboxProviderReceipt observation unavailable; offline production-registry recovery proof is not a provider receipt",
    );
    // Card 13: exhaustive authority/refusal, durability and concurrency matrix.
    const setSelected = async (session, id) =>
      admin.query(
        `UPDATE luna_v3_sessions SET selected_booking_id=$2 WHERE session_key=$1`,
        [session, id],
      );
    const makeCancelBooking = async (code, opts = {}) =>
      (
        await admin.query(
          `INSERT INTO bookings(client_id,booking_code,guest_name,phone,status,payment_status,check_in,check_out,guest_count,total_amount_cents,deposit_required_cents,amount_paid_cents,deposit_paid_cents,balance_due_cents) VALUES($1,$2,'Cancel Guest','+34600000001','confirmed',$3,'2028-01-01','2028-01-08',1,10000,3000,$4,$5,$6) RETURNING id`,
          [
            ids.client,
            code,
            opts.paymentStatus || "not_requested",
            opts.paid ?? 0,
            opts.depositPaid ?? 0,
            opts.balance ?? 10000,
          ],
        )
      ).rows[0].id;
    const snapshot = async (id) =>
      (
        await admin.query(
          `SELECT b.status::text status,b.amount_paid_cents,b.deposit_paid_cents,b.balance_due_cents,(SELECT count(*)::int FROM booking_beds WHERE booking_id=b.id) beds,(SELECT count(*)::int FROM payments WHERE booking_id=b.id) payments,(SELECT count(*)::int FROM payment_events WHERE booking_id=b.id) events FROM bookings b WHERE id=$1`,
          [id],
        )
      ).rows[0];
    const cancelAlertsBefore = (
      await admin.query(`SELECT count(*)::int n FROM workflow_events`)
    ).rows[0].n;
    const refusalCases = [
      [
        "draft_zero_row",
        async (id) =>
          admin.query(
            `INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents,metadata) VALUES($1,$2,'draft','deposit_only','EUR',3000,0,'{}')`,
            [ids.client, id],
          ),
        "payment_exists",
      ],
      [
        "partial_payment",
        async (id) =>
          admin.query(
            `UPDATE bookings SET amount_paid_cents=100,balance_due_cents=9900 WHERE id=$1`,
            [id],
          ),
        "payment_evidence_inconsistent",
      ],
      [
        "cash_manual_evidence",
        async (id) =>
          admin.query(
            `INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents,metadata) VALUES($1,$2,'draft','deposit_only','EUR',3000,0,'{"method":"cash","manual":true}')`,
            [ids.client, id],
          ),
        "payment_exists",
      ],
      [
        "paid_event",
        async (id) =>
          admin.query(
            `INSERT INTO payment_events(client_id,booking_id,event_type) VALUES($1,$2,'charge.succeeded')`,
            [ids.client, id],
          ),
        "payment_exists",
      ],
      [
        "unknown_payment_evidence",
        async (id) =>
          admin.query(`UPDATE bookings SET payment_status=NULL WHERE id=$1`, [
            id,
          ]),
        "payment_evidence_unknown",
      ],
      [
        "inconsistent_aggregates",
        async (id) =>
          admin.query(
            `UPDATE bookings SET amount_paid_cents=1,payment_status='not_requested' WHERE id=$1`,
            [id],
          ),
        "payment_evidence_inconsistent",
      ],
    ];
    for (const [name, seed, reason] of refusalCases) {
      const id = await makeCancelBooking(`C13-${name}`);
      await seed(id);
      await setSelected(ws, id);
      const beforeState = await snapshot(id);
      const input = {
        booking_id: id,
        guest_reason: name,
        operation_key: `cancel-${name}`,
      };
      const refusal = await api.cancelUnpaid(await c(), input, ctx(ws));
      assert.equal(refusal.cancelled, false, name);
      assert.equal(refusal.reason, reason, name);
      assert.equal(refusal.outcome, "rejected");
      assert.equal(refusal.sent, false);
      assert.equal(refusal.externalSendAllowed, false);
      assert.equal(refusal.staffAlertAllowed, false);
      assert.ok(refusal.handoffId);
      assert.ok(refusal.handoffOperationKey.startsWith("cancel-refusal:"));
      assert.deepEqual(
        await snapshot(id),
        beforeState,
        `${name} mutated authority evidence`,
      );
      const replay = await api.cancelUnpaid(await c(), input, ctx(ws));
      assert.deepEqual(replay, refusal, `${name} replay`);
      const mismatch = await api.cancelUnpaid(
        await c(),
        { ...input, guest_reason: `${name}-changed` },
        ctx(ws),
      );
      assert.equal(mismatch.code, "operation_key_payload_mismatch");
      const durable = (
        await admin.query(
          `SELECT o.outcome,o.receipt,h.id handoff_id FROM luna_v3_operations o JOIN luna_v3_handoffs h ON h.id=$2 WHERE o.operation_key=$1`,
          [input.operation_key, refusal.handoffId],
        )
      ).rows[0];
      assert.equal(durable.outcome, "rejected");
      assert.equal(durable.handoff_id, refusal.handoffId);
    }
    assert.equal(
      (await admin.query(`SELECT count(*)::int n FROM workflow_events`)).rows[0]
        .n,
      cancelAlertsBefore,
      "refusal emitted an alert/outbox workflow row",
    );
    observations.cancelUnpaidRefusalMatrix = true;
    console.log(
      "PASS V3-CANCEL-REFUSAL-MATRIX draft/zero, partial, cash/manual, paid event, unknown and inconsistent evidence refused unchanged; durable no-alert handoff + replay/mismatch",
    );
    const foreignId = await makeCancelBooking("C13-FOREIGN");
    await setSelected("luna-v3:foreign", foreignId);
    await setSelected(ws, booked.bookingId);
    const cross = await api.cancelUnpaid(
      admin,
      {
        booking_id: foreignId,
        guest_reason: "cross",
        operation_key: "cancel-cross",
      },
      ctx(ws),
    );
    assert.equal(cross.code, "booking_selector_forbidden");
    assert.equal((await snapshot(foreignId)).status, "confirmed");
    observations.cancelUnpaidSelectionAuthority = true;
    console.log(
      "PASS V3-CANCEL-SELECTION-AUTHORITY cross-session/foreign selected booking denied unchanged",
    );
    const rollbackId = await makeCancelBooking("C13-HANDOFF-FAIL");
    await admin.query(
      `INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents) VALUES($1,$2,'draft','deposit_only','EUR',3000,0)`,
      [ids.client, rollbackId],
    );
    await setSelected(ws, rollbackId);
    await admin.query(
      `CREATE FUNCTION c13_fail_handoff() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected_handoff_failure'; END$$;CREATE TRIGGER c13_fail_handoff_trg BEFORE INSERT ON luna_v3_handoffs FOR EACH ROW EXECUTE FUNCTION c13_fail_handoff()`,
    );
    await assert.rejects(
      api.cancelUnpaid(
        await c(),
        {
          booking_id: rollbackId,
          guest_reason: "fail",
          operation_key: "cancel-handoff-fail",
        },
        ctx(ws),
      ),
      /injected_handoff_failure/,
    );
    await admin.query(
      `DROP TRIGGER c13_fail_handoff_trg ON luna_v3_handoffs;DROP FUNCTION c13_fail_handoff()`,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM luna_v3_operations WHERE operation_key='cancel-handoff-fail' AND receipt IS NULL`,
        )
      ).rows[0].n,
      1,
    );
    assert.equal((await snapshot(rollbackId)).status, "confirmed");
    observations.cancelUnpaidHandoffAtomicity = true;
    console.log(
      "PASS V3-CANCEL-HANDOFF-ATOMICITY injected shared handoff persistence failure rolls back cancellation and completed refusal receipt",
    );
    const successId = await makeCancelBooking("C13-SUCCESS");
    await admin.query(
      `INSERT INTO booking_beds(client_id,booking_id,bed_id,bed_code,assignment_start_date,assignment_end_date) VALUES($1,$2,$3,'R10-B1','2028-01-01','2028-01-08')`,
      [ids.client, successId, ids.b1],
    );
    await setSelected(ws, successId);
    const success = await api.cancelUnpaid(
      await c(),
      {
        booking_id: successId,
        guest_reason: "zero",
        operation_key: "cancel-success",
      },
      ctx(ws),
    );
    assert.equal(success.cancelled, true);
    assert.equal(success.releasedBedCount, 1);
    const successState = await snapshot(successId);
    assert.equal(successState.status, "cancelled");
    assert.equal(
      successState.beds,
      1,
      "Staff cancellation preserves assignment history",
    );
    const occupancy = (
      await admin.query(
        `SELECT count(*)::int n FROM booking_beds bb JOIN bookings b ON b.id=bb.booking_id WHERE b.id=$1 AND b.status::text NOT IN ('cancelled','expired')`,
        [successId],
      )
    ).rows[0].n;
    assert.equal(occupancy, 0);
    observations.cancelUnpaidZeroPaymentRelease = true;
    console.log(
      "PASS V3-CANCEL-ZERO-PAYMENT confirmed genuine zero-payment cancellation preserves booking_beds and releases occupancy 1->0",
    );
    const paymentWinsId = await makeCancelBooking("C13-RACE-PAYMENT-WINS");
    await setSelected(ws, paymentWinsId);
    const payWinner = await c(),
      cancelLoser = await c();
    await payWinner.query("BEGIN");
    await payWinner.query(`SELECT id FROM bookings WHERE id=$1 FOR UPDATE`, [
      paymentWinsId,
    ]);
    const cancelWaiting = api.cancelUnpaid(
      cancelLoser,
      {
        booking_id: paymentWinsId,
        guest_reason: "race",
        operation_key: "cancel-race-payment-wins",
      },
      ctx(ws),
    );
    await payWinner.query(
      `INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents) VALUES($1,$2,'draft','deposit_only','EUR',3000,0)`,
      [ids.client, paymentWinsId],
    );
    await payWinner.query("COMMIT");
    const paymentWins = await cancelWaiting;
    assert.equal(paymentWins.cancelled, false);
    assert.equal(paymentWins.reason, "payment_exists");
    assert.equal((await snapshot(paymentWinsId)).status, "confirmed");
    const cancelWinsId = await makeCancelBooking("C13-RACE-CANCEL-WINS");
    await setSelected(ws, cancelWinsId);
    const cancelWinner = await c(),
      latePayment = await c();
    await cancelWinner.query("BEGIN");
    await cancelWinner.query(`SELECT id FROM bookings WHERE id=$1 FOR UPDATE`, [
      cancelWinsId,
    ]);
    const lateInsert = latePayment.query(
      `INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents) VALUES($1,$2,'draft','deposit_only','EUR',3000,0)`,
      [ids.client, cancelWinsId],
    );
    await cancelWinner.query(
      `UPDATE bookings SET status='cancelled' WHERE id=$1`,
      [cancelWinsId],
    );
    await cancelWinner.query("COMMIT");
    await assert.rejects(lateInsert, /payment_for_cancelled_booking/);
    assert.equal((await snapshot(cancelWinsId)).payments, 0);
    observations.cancelUnpaidConcurrency = true;
    console.log(
      "PASS V3-CANCEL-CONCURRENCY deterministic independent connections: payment winner refuses cancellation; cancellation winner rejects late payment evidence",
    );
    await setSelected(ws, booked.bookingId);
    await api.readNotes(admin, {}, ctx(ws));
    assert.equal(
      (
        await admin.query(
          `SELECT to_regclass('tenant_house_notes') IS NOT NULL present`,
        )
      ).rows[0].present,
      true,
    );
    const missingGeneral = await api.readNotes(admin, {}, ctx(ws));
    assert.equal(missingGeneral.generalNotes.available, false);
    await admin.query(
      `INSERT INTO tenant_house_notes(client_slug,notes) VALUES('wolfhouse-somo','Owner bytes: BIO pickup is not policy')`,
    );
    const sharedBefore = (
      await admin.query(
        `SELECT notes FROM tenant_house_notes WHERE client_slug='wolfhouse-somo'`,
      )
    ).rows[0].notes;
    const sessionNote = await api.writeNote(
      await c(),
      {
        text: "session only",
        context: { topic: "session" },
        operation_key: "note-session",
      },
      ctx(ws),
    );
    assert.equal(sessionNote.scope, "session");
    const ninput = {
      text: "Guest says BIO at 14:00",
      context: { topic: "transfer" },
      booking_reference: booked.bookingCode,
      operation_key: "note-1",
    };
    const [n1, n2] = await Promise.all([
      api.writeNote(await c(), ninput, ctx(ws)),
      api.writeNote(await c(), ninput, ctx(ws)),
    ]);
    assert.equal(n1.noteId, n2.noteId);
    assert.equal(n1.scope, "selected-booking");
    const conflict = await api.writeNote(
      admin,
      { ...ninput, text: "changed" },
      ctx(ws),
    );
    assert.equal(conflict.code, "operation_key_payload_mismatch");
    const nr = await api.readNotes(await c(), {}, ctx(ws));
    assert.equal(nr.generalNotes.source, "tenant_house_notes");
    assert.equal(nr.generalNotes.text, sharedBefore);
    assert.ok(nr.generalNotes.version);
    assert.equal(nr.scopedNotes.length, 2);
    assert.deepEqual(
      new Set(nr.scopedNotes.map((n) => n.scope)),
      new Set(["session", "selected-booking"]),
    );
    assert.equal(
      (await api.readNotes(admin, {}, ctx("luna-v3:foreign"))).scopedNotes
        .length,
      0,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT notes FROM tenant_house_notes WHERE client_slug='wolfhouse-somo'`,
        )
      ).rows[0].notes,
      sharedBefore,
    );
    console.log(
      "PASS V3-NOTES-SOURCES + V3-NOTE-DURABLE missing source no DDL; owner bytes/version separate; session and selected-booking scope; restart/concurrent replay; foreign exclusion",
    );
    const moneyBefore = (
      await admin.query(
        `SELECT total_amount_cents,deposit_required_cents,balance_due_cents FROM bookings WHERE id=$1`,
        [booked.bookingId],
      )
    ).rows[0];
    const missingDeclineInput = {
      booking_reference: booked.bookingCode,
      decision: "declined",
      travel_details: { direction: "departure" },
      operation_key: "transfer-decline-missing",
    };
    const missingDecline = await api.saveTransferRequest(
      await c(),
      missingDeclineInput,
      ctx(ws),
    );
    assert.equal(missingDecline.code, "authoritative_transfer_not_found");
    assert.equal(missingDecline.outcome, "rejected");
    assert.deepEqual(
      (
        await api.recoverOperation(
          await c(),
          {
            tool: "save_transfer_request",
            operation_key: "transfer-decline-missing",
          },
          ctx(ws),
        )
      ).receipt,
      missingDecline,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM luna_v3_transfer_requests WHERE operation_id=(SELECT id FROM luna_v3_operations WHERE operation_key='transfer-decline-missing')`,
        )
      ).rows[0].n,
      0,
    );
    const incompleteInput = {
      booking_reference: booked.bookingCode,
      decision: "requested",
      travel_details: { airport: "BIO" },
      operation_key: "transfer-incomplete",
    };
    const incomplete = await api.saveTransferRequest(
      await c(),
      incompleteInput,
      ctx(ws),
    );
    assert.equal(incomplete.code, "transfer_details_incomplete");
    assert.ok(incomplete.question);
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM booking_transfers WHERE booking_id=$1`,
          [booked.bookingId],
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(
      await api.saveTransferRequest(await c(), incompleteInput, ctx(ws)),
      incomplete,
    );
    await admin.query(
      `DELETE FROM wh_pricing_rules WHERE item_type='transfer' AND item_code='BIO'`,
    );
    const unpricedInput = {
      booking_reference: booked.bookingCode,
      decision: "requested",
      travel_details: {
        airport: "BIO",
        date: "2027-07-01",
        time: "14:00",
        passengers: 4,
      },
      operation_key: "transfer-unpriced",
    };
    const unpriced = await api.saveTransferRequest(
      await c(),
      unpricedInput,
      ctx(ws),
    );
    assert.equal(unpriced.code, "staff_transfer_pricing_unavailable");
    assert.equal(unpriced.status, 422);
    assert.deepEqual(
      (
        await api.recoverOperation(
          await c(),
          { tool: "save_transfer_request", operation_key: "transfer-unpriced" },
          ctx(ws),
        )
      ).receipt,
      unpriced,
    );
    await admin.query(
      `INSERT INTO wh_pricing_rules(client_slug,item_type,item_code,season_code,unit,amount_cents,currency,active) VALUES('wolfhouse-somo','transfer','BIO',NULL,'flat',6000,'EUR',true)`,
    );
    await admin.query(
      `ALTER TABLE wh_pricing_transfer_rules RENAME TO wh_pricing_transfer_rules_unavailable`,
    );
    const unavailableInput = {
      ...unpricedInput,
      operation_key: "transfer-pricing-load-failed",
    };
    const transferUnavailable = await api.saveTransferRequest(
      await c(),
      unavailableInput,
      ctx(ws),
    );
    assert.equal(
      transferUnavailable.code,
      "staff_transfer_pricing_unavailable",
    );
    assert.equal(transferUnavailable.status, 503);
    assert.deepEqual(
      (
        await api.recoverOperation(
          await c(),
          {
            tool: "save_transfer_request",
            operation_key: "transfer-pricing-load-failed",
          },
          ctx(ws),
        )
      ).receipt,
      transferUnavailable,
    );
    await admin.query(
      `ALTER TABLE wh_pricing_transfer_rules_unavailable RENAME TO wh_pricing_transfer_rules`,
    );
    const travel = {
      airport: "BIO",
      direction: "pickup",
      date: "2027-07-01",
      time: "14:00",
      passengers: 4,
      boards: 1,
    };
    const [tr, trConcurrent] = await Promise.all([
      api.saveTransferRequest(
        await c(),
        {
          booking_reference: booked.bookingCode,
          decision: "requested",
          travel_details: travel,
          operation_key: "transfer-1",
        },
        ctx(ws),
      ),
      api.saveTransferRequest(
        await c(),
        {
          booking_reference: booked.bookingCode,
          decision: "requested",
          travel_details: travel,
          operation_key: "transfer-1",
        },
        ctx(ws),
      ),
    ]);
    assert.equal(trConcurrent.transferId, tr.transferId);
    assert.deepEqual(tr.travelDetails, travel);
    assert.equal(tr.pricedCents, 6000);
    assert.equal(tr.driverConfirmed, false);
    assert.equal(tr.sent, false);
    const authority = (
      await admin.query(`SELECT * FROM booking_transfers WHERE id=$1`, [
        tr.authoritativeTransferId,
      ])
    ).rows[0];
    assert.equal(authority.airport_code, "BIO");
    assert.equal(
      authority.scheduled_at.toISOString(),
      "2027-07-01T12:00:00.000Z",
    );
    assert.deepEqual(
      (
        await admin.query(
          `SELECT total_amount_cents,deposit_required_cents,balance_due_cents FROM bookings WHERE id=$1`,
          [booked.bookingId],
        )
      ).rows[0],
      moneyBefore,
    );
    const tr2 = await api.saveTransferRequest(
      admin,
      {
        booking_reference: booked.bookingCode,
        decision: "requested",
        travel_details: travel,
        operation_key: "transfer-1",
      },
      ctx(ws),
    );
    assert.equal(tr2.transferId, tr.transferId);
    assert.equal(
      (
        await api.saveTransferRequest(
          admin,
          {
            booking_id: foreignId,
            decision: "requested",
            travel_details: travel,
            operation_key: "transfer-cross",
          },
          ctx(ws),
        )
      ).status,
      403,
    );
    const declined = await api.saveTransferRequest(
      admin,
      {
        booking_reference: booked.bookingCode,
        decision: "declined",
        travel_details: {},
        operation_key: "transfer-declined",
      },
      ctx(ws),
    );
    assert.equal(declined.state, "declined");
    assert.equal(
      (
        await admin.query(`SELECT status FROM booking_transfers WHERE id=$1`, [
          declined.authoritativeTransferId,
        ])
      ).rows[0].status,
      "declined",
    );
    assert.equal(
      (
        await admin.query(
          `SELECT authoritative_transfer_id FROM luna_v3_transfer_requests WHERE id=$1`,
          [declined.transferId],
        )
      ).rows[0].authoritative_transfer_id,
      declined.authoritativeTransferId,
    );
    console.log(
      "PASS V3-TRANSFER-DECISION incomplete durable question/refusal; authoritative Staff row exact BIO/14:00; concurrent/restart replay and cross-session refusal; no booking-money/driver/send mutation",
    );
    const route = await dispatchLunaV3StaffRoute({
      pathname: "/staff/bot/luna-v3/recover-operation",
      method: "POST",
      clientSlug: "wolfhouse-somo",
      body: {
        session_id: ws,
        tool: "book",
        operation_key: "book-1",
        external_send_allowed: false,
        staff_alert_allowed: false,
      },
      authenticatedPrincipal: {
        principalId: "staff-api-authenticated",
        writeAllowed: true,
      },
      resolveSession: async ({ selector, principalId }) =>
        selector === ws && principalId === "staff-api-authenticated"
          ? { sessionId: ws, writeAllowed: true }
          : null,
      operations: api.createOperations((fn) => fn(admin)),
    });
    assert.equal(route.status, 200, JSON.stringify(route));
    assert.equal(route.body.receipt.bookingId, booked.bookingId);
    const denied = await dispatchLunaV3StaffRoute({
      pathname: "/staff/bot/luna-v3/recover-operation",
      method: "POST",
      clientSlug: "wolfhouse-somo",
      body: {
        session_id: "luna-v3:foreign",
        operation_key: "book-1",
        external_send_allowed: false,
        staff_alert_allowed: false,
      },
      authenticatedPrincipal: { principalId: "other" },
      resolveSession: async () => null,
      operations: api.createOperations((fn) => fn(admin)),
    });
    assert.equal(denied.status, 403);
    console.log(
      "PASS route->registry authenticated server-bound composition and cross-principal denial",
    );
    const oneTryContext = { ...ctx("luna-v3:a"), turnId: "turn:one-try-prepare" };
    const activeHoldCount = async () => Number((await admin.query(`SELECT count(*)::int n FROM luna_v3_holds WHERE state='active' AND expires_at>now()`)).rows[0].n);
    const offerTurnCount = async () => Number((await admin.query(`SELECT count(*)::int n FROM luna_v3_offer_turns`)).rows[0].n);
    const beforeInformationHolds = await activeHoldCount();
    const beforeInformationOffers = await offerTurnCount();
    const information = await api.checkQuoteBook(admin, {
      action: "prepare", purpose: "information", check_in: "2035-07-01", check_out: "2035-07-08",
    }, { ...oneTryContext, turnId: "turn:one-try-information" });
    assert.equal(information.state, "information", JSON.stringify(information));
    assert.equal(await activeHoldCount(), beforeInformationHolds);
    assert.equal(await offerTurnCount(), beforeInformationOffers);
    await admin.query(`CREATE FUNCTION reject_v3_offer_turn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced_offer_record_failure'; END $$`);
    await admin.query(`CREATE TRIGGER reject_v3_offer_turn BEFORE INSERT ON luna_v3_offer_turns FOR EACH ROW EXECUTE FUNCTION reject_v3_offer_turn()`);
    const beforeFailedPrepareHolds = await activeHoldCount();
    await assert.rejects(() => api.checkQuoteBook(admin, {
      action: "prepare", purpose: "offer", check_in: "2035-07-01", check_out: "2035-07-08",
      guests: [{ name: "Atomic Try" }], room: { kind: "exact", beds: ["R10-B1"], together: "required" },
      package: { name: "Malibu" }, add_ons: [], payment: { arrangement: "together" },
    }, { ...oneTryContext, turnId: "turn:one-try-atomic-failure" }), /forced_offer_record_failure/);
    await admin.query(`DROP TRIGGER reject_v3_offer_turn ON luna_v3_offer_turns`);
    await admin.query(`DROP FUNCTION reject_v3_offer_turn()`);
    assert.equal(await activeHoldCount(), beforeFailedPrepareHolds, "failed offer record leaked an active hold");
    let prepared = await api.checkQuoteBook(admin, {
      action: "prepare", purpose: "offer", check_in: "2035-07-01", check_out: "2035-07-08",
      guests: [{ name: "One Try" }], room: { kind: "exact", beds: ["R10-B1"], together: "required" },
      package: { name: "Malibu" }, add_ons: [], payment: { arrangement: "together" },
    }, oneTryContext);
    assert.equal(prepared.state, "offer", JSON.stringify(prepared));
    assert.match(prepared.offer_reference, /^offer_/);
    assert.equal(Object.hasOwn(prepared, "holdId"), false);
    assert.equal(prepared.quote.currency, "EUR");
    assert.ok(Number.isSafeInteger(prepared.quote.totalCents) && prepared.quote.totalCents > 0);
    assert.equal(prepared.guests[0].bed, "R10-B1");
    assert.equal(prepared.guests[0].package, "malibu");
    assert.equal(prepared.package_details.name, "Malibu");
    assert.deepEqual(prepared.package_details.includes, ["stay"]);
    const sameTurnPrepared = await api.checkQuoteBook(admin, {
      action: "prepare", purpose: "offer", check_in: "2035-07-01", check_out: "2035-07-08",
      guests: [{ name: "One Try" }], room: { kind: "exact", beds: ["R10-B1"], together: "required" },
      package: { name: "Malibu" }, add_ons: [], payment: { arrangement: "together" },
    }, oneTryContext);
    assert.equal(sameTurnPrepared.offer_reference, prepared.offer_reference, "same-turn prepare did not replay");
    const lifecycleB = await api.checkQuoteBook(admin, {
      action: "prepare", purpose: "offer", check_in: "2035-07-01", check_out: "2035-07-08",
      guests: [{ name: "Lifecycle B" }], room: { kind: "exact", beds: ["R10-B1"], together: "required" },
      package: { name: "Malibu" }, add_ons: [], payment: { arrangement: "together" },
    }, { ...oneTryContext, turnId: "turn:one-try-lifecycle-b" });
    const lifecycleA2 = await api.checkQuoteBook(admin, {
      action: "prepare", purpose: "offer", check_in: "2035-07-01", check_out: "2035-07-08",
      guests: [{ name: "One Try" }], room: { kind: "exact", beds: ["R10-B1"], together: "required" },
      package: { name: "Malibu" }, add_ons: [], payment: { arrangement: "together" },
    }, { ...oneTryContext, turnId: "turn:one-try-lifecycle-a2" });
    assert.notEqual(lifecycleB.offer_reference, prepared.offer_reference);
    assert.notEqual(lifecycleA2.offer_reference, prepared.offer_reference, "A→B→A reused a lifecycle reference");
    assert.notEqual(lifecycleA2.offer_reference, lifecycleB.offer_reference);
    prepared = lifecycleA2;
    const nonPriceRecorded = await api.checkQuoteBook.recordPresented(admin, {
      offer_reference: prepared.offer_reference, assistant_reply: "I have NOT shown you a price.", assistant_event_id: "assistant:event:bad",
    }, { ...oneTryContext, trustedPresentationRecorder: true, turnId: "turn:one-try-presented-bad" });
    assert.equal(nonPriceRecorded.reason, "complete_offer_presentation_required");
    const displayedAmount = (Number(prepared.quote.totalCents) / 100).toFixed(2);
    const misleadingAmount = await api.checkQuoteBook.recordPresented(admin, {
      offer_reference: prepared.offer_reference, assistant_event_id: "assistant:event:misleading",
      assistant_reply: `An unrelated larger amount is €1${displayedAmount}.`,
    }, { ...oneTryContext, trustedPresentationRecorder: true, turnId: "turn:one-try-presented-misleading" });
    assert.equal(misleadingAmount.reason, "complete_offer_presentation_required");
    const depositAmount = (Number(prepared.quote.depositCents) / 100).toFixed(2);
    const swappedAmounts = await api.checkQuoteBook.recordPresented(admin, {
      offer_reference: prepared.offer_reference, assistant_event_id: "assistant:event:swapped",
      assistant_reply: `Total €${depositAmount}; deposit €${displayedAmount}; stay 2035-07-01 to 2035-07-08; guest One Try; bed R10-B1; package malibu.`,
    }, { ...oneTryContext, trustedPresentationRecorder: true, turnId: "turn:one-try-presented-swapped" });
    assert.equal(swappedAmounts.reason, "complete_offer_presentation_required");
    const compoundSwappedAmounts = await api.checkQuoteBook.recordPresented(admin, {
      offer_reference: prepared.offer_reference, assistant_event_id: "assistant:event:compound-swapped",
      assistant_reply: `Total €${depositAmount} and €${displayedAmount} deposit; stay 2035-07-01 to 2035-07-08; guest One Try; bed R10-B1; package malibu.`,
    }, { ...oneTryContext, trustedPresentationRecorder: true, turnId: "turn:one-try-presented-compound-swapped" });
    assert.equal(compoundSwappedAmounts.reason, "complete_offer_presentation_required");
    const afterInvalidPresentationInbound = (await admin.query(`INSERT INTO luna_v3_runtime_events(client_id,session_id,principal_id,direction,content_digest)
      SELECT s.client_id,s.id,s.principal_id,'inbound',repeat('d',64) FROM luna_v3_sessions s JOIN clients c ON c.id=s.client_id
      WHERE c.slug='wolfhouse-somo' AND s.session_key=$1 AND s.principal_id=$2 RETURNING id::text`,
    [oneTryContext.sessionId,oneTryContext.principalId])).rows[0].id;
    const confirmAfterInvalidPresentation = await api.checkQuoteBook(admin, {
      action: "confirm", offer_reference: prepared.offer_reference,
    }, { ...oneTryContext, authenticatedInboundEventId: afterInvalidPresentationInbound, turnId: "turn:one-try-confirm-after-invalid-presentation" });
    assert.equal(confirmAfterInvalidPresentation.reason, "acceptance_required", JSON.stringify(confirmAfterInvalidPresentation));
    const omittedPackage = await api.checkQuoteBook.recordPresented(admin, {
      offer_reference: prepared.offer_reference, assistant_event_id: "assistant:event:omitted-package",
      assistant_reply: `Total €${displayedAmount}; deposit €${depositAmount}; stay 2035-07-01 to 2035-07-08; guest One Try; bed R10-B1.`,
    }, { ...oneTryContext, trustedPresentationRecorder: true, turnId: "turn:one-try-presented-omitted-package" });
    assert.equal(omittedPackage.reason, "complete_offer_presentation_required");
    const presentedInbound = (await admin.query(`INSERT INTO luna_v3_runtime_events(client_id,session_id,principal_id,direction,content_digest)
      SELECT s.client_id,s.id,s.principal_id,'inbound',repeat('a',64) FROM luna_v3_sessions s JOIN clients c ON c.id=s.client_id
      WHERE c.slug='wolfhouse-somo' AND s.session_key=$1 AND s.principal_id=$2 RETURNING id::text`,
    [oneTryContext.sessionId,oneTryContext.principalId])).rows[0].id;
    const assistantEvent = (await admin.query(`INSERT INTO luna_v3_runtime_events(client_id,session_id,principal_id,direction,content_digest,preceding_inbound_event_id)
      SELECT s.client_id,s.id,s.principal_id,'assistant_outbound',repeat('b',64),$3::uuid FROM luna_v3_sessions s JOIN clients c ON c.id=s.client_id
      WHERE c.slug='wolfhouse-somo' AND s.session_key=$1 AND s.principal_id=$2 RETURNING id::text`,
    [oneTryContext.sessionId,oneTryContext.principalId,presentedInbound])).rows[0].id;
    const recorded = await api.checkQuoteBook.recordPresented(admin, {
      offer_reference: prepared.offer_reference, assistant_event_id: assistantEvent,
      assistant_reply: `Total €${displayedAmount}; deposit €${depositAmount}; stay 2035-07-01 to 2035-07-08; guest One Try; bed R10-B1; package malibu.`,
    }, { ...oneTryContext, trustedPresentationRecorder: true, turnId: "turn:one-try-presented" });
    assert.equal(recorded.recorded, true, JSON.stringify(recorded));
    const sameTurnConfirm = await api.checkQuoteBook(admin, {
      action: "confirm", offer_reference: prepared.offer_reference,
    }, { ...oneTryContext, authenticatedInboundEventId: presentedInbound, turnId: "turn:one-try-same-inbound" });
    assert.equal(sameTurnConfirm.reason, "acceptance_required", JSON.stringify(sameTurnConfirm));
    const acceptedInbound = (await admin.query(`INSERT INTO luna_v3_runtime_events(client_id,session_id,principal_id,direction,content_digest,created_at)
      SELECT s.client_id,s.id,s.principal_id,'inbound',repeat('c',64),clock_timestamp()+interval '1 millisecond'
      FROM luna_v3_sessions s JOIN clients c ON c.id=s.client_id
      WHERE c.slug='wolfhouse-somo' AND s.session_key=$1 AND s.principal_id=$2 RETURNING id::text`,
    [oneTryContext.sessionId,oneTryContext.principalId])).rows[0].id;
    const confirmed = await api.checkQuoteBook(admin, {
      action: "confirm", offer_reference: prepared.offer_reference,
    }, { ...oneTryContext, authenticatedInboundEventId: acceptedInbound, turnId: "turn:one-try-confirm" });
    assert.equal(confirmed.state, "booked", JSON.stringify(confirmed));
    assert.equal(Object.hasOwn(confirmed, "bookingId"), false);
    const replayedConfirm = await api.checkQuoteBook(admin, {
      action: "confirm", offer_reference: prepared.offer_reference,
    }, { ...oneTryContext, authenticatedInboundEventId: "inbound:guest:accept-replay", turnId: "turn:one-try-confirm-replay" });
    assert.equal(replayedConfirm.state, "booked", JSON.stringify(replayedConfirm));
    assert.equal(replayedConfirm.booking_reference, confirmed.booking_reference);
    assert.equal((await admin.query(`SELECT count(*)::int n FROM luna_v3_offer_turns WHERE offer_reference=$1 AND presented_at IS NOT NULL AND accepted_at IS NOT NULL`, [prepared.offer_reference])).rows[0].n, 1);
    const freshCancel = await api.cancelUnpaid(admin, {
      booking_reference: confirmed.booking_reference, guest_reason: "plans changed", operation_key: "one-try-fresh-cancel",
    }, { ...oneTryContext, turnId: "turn:one-try-cancel" });
    assert.equal(freshCancel.outcome, "applied", JSON.stringify(freshCancel));
    assert.equal(freshCancel.cancelled, true, JSON.stringify(freshCancel));
    assert.equal((await admin.query(`SELECT count(*)::int n FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.booking_code=$1 AND p.status::text NOT IN ('cancelled','expired','failed')`, [confirmed.booking_reference])).rows[0].n, 0, "cancelled booking retained nonterminal payment rows");
    const freshCancelAgain = await api.cancelUnpaid(admin, {
      booking_reference: confirmed.booking_reference, guest_reason: "repeat", operation_key: "one-try-fresh-cancel-again",
    }, { ...oneTryContext, turnId: "turn:one-try-cancel-again" });
    assert.equal(freshCancelAgain.ok, false);
    console.log("PASS V3-ONE-TRY-POSTGRES public prepare/presentation/confirm/replay and one fresh unpaid cancel");
    observations.holdAllOrNone = true;
    observations.noBedSubstitution = true;
    observations.toolBook = true;
    observations.toolReleaseHold = true;
    observations.toolGetBooking = true;
    observations.timeoutUnknown = true;
    observations.toolHandoffToHuman = true;
    observations.paymentTruth = true;
    observations.paymentLinkOfflineBoundary = true;
    observations.notesSources = true;
    observations.noteDurable = true;
    observations.transferDecision = true;
    const counts = (
      await admin.query(
        `SELECT (SELECT count(*) FROM bookings) bookings,(SELECT count(*) FROM luna_v3_operations WHERE receipt IS NOT NULL) receipts,(SELECT count(*) FROM luna_v3_handoffs) handoffs`,
      )
    ).rows[0];
    console.log("DB READBACK", JSON.stringify(counts));
    await Promise.all([a.end(), b.end(), ordinary.end(), admin.end()]);
    await Promise.all([...clients].map((x) => x.end()));
    return { observations, counts };
  } finally {
    await Promise.allSettled([...clients].map((x) => x.end()));
  }
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
module.exports = { main, assertDisposableDatabaseTarget };
