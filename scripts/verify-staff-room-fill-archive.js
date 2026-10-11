'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { startDisposablePostgresHarness } = require('./lib/disposable-postgres-harness');
const { archiveRoomFillRoom, checkRoomArchive, restoreRoomFillRoom, LOCK_ORDER } = require('./lib/staff-room-fill-archive');
const { catalogRevisionFor, settingsRevisionFor } = require('./lib/staff-room-fill-policy');
const { resolveBedCalendarRoomRows } = require('./lib/wolfhouse-inventory-source');
const { createRoomFillRoutes } = require('./lib/staff-room-fill-routes');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const R11 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01';
const B2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccc01';
const BOOKING = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01';

const SCHEMA = `
CREATE TABLE clients (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE rooms (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id),
  room_code TEXT NOT NULL,
  name TEXT,
  capacity INTEGER,
  gender_strategy TEXT,
  room_type TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  can_be_matrimonial BOOLEAN NOT NULL DEFAULT FALSE,
  often_used_by_operator BOOLEAN NOT NULL DEFAULT FALSE,
  house TEXT,
  fill_priority INTEGER,
  sort_order INTEGER,
  UNIQUE (client_id, room_code)
);
CREATE TABLE beds (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id),
  room_id UUID NOT NULL REFERENCES rooms(id),
  bed_code TEXT NOT NULL,
  bed_number INTEGER,
  bed_label TEXT,
  planning_row_label TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sellable BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE bookings (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id),
  booking_code TEXT NOT NULL,
  status TEXT NOT NULL,
  assignment_status TEXT,
  block_type TEXT,
  check_in DATE,
  check_out DATE,
  room_to_block_id UUID,
  primary_room_code TEXT,
  hold_expires_at TIMESTAMPTZ
);
CREATE TABLE booking_beds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  booking_id UUID NOT NULL REFERENCES bookings(id),
  bed_id UUID,
  assignment_start_date DATE,
  assignment_end_date DATE,
  assignment_type TEXT
);
CREATE OR REPLACE FUNCTION public.booking_occupancy_lock_key(p_kind text, p_id uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT ('x' || substr(md5(p_kind || ':' || p_id::text), 1, 16))::bit(64)::bigint;
$$;
`;

function policyFor(ids) {
  return {
    contractVersion: 1,
    fillMode: 'house',
    roomPriority: ids,
    roomPrioritySource: 'custom',
    other_setting: 'keep',
  };
}

function rooms() {
  return [
    { roomId: R11, roomCode: 'R11', roomNumber: 11, active: true, capacity: 1, beds: [{ bedId: B1, active: true, sellable: false }] },
    { roomId: R2, roomCode: 'R2', roomNumber: 2, active: true, capacity: 1, beds: [{ bedId: B2, active: true, sellable: true }] },
  ];
}

function input(body, extra) {
  return {
    clientId: CLIENT,
    roomId: R11,
    user: { client_id: CLIENT, client_slug: 'wolfhouse-somo', role: 'operator', staff_user_id: 'staff-1' },
    body,
    lockSql: 'SELECT id FROM clients WHERE id = $1::uuid FOR UPDATE',
    saveSql: `UPDATE clients SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{luna_room_fill_policy}', $2::jsonb, true) WHERE id = $1::uuid`,
    readLockedState: async () => ({
      rooms: rooms().filter((room) => room.roomId !== (extra && extra.omit)),
      policy: extra && extra.policy,
      revisions: extra && extra.revisions,
    }),
    ...extra,
  };
}

async function seed(client) {
  await client.query(SCHEMA);
  await client.query(fs.readFileSync(path.join(__dirname, '../database/migrations/112_staff_room_archive.sql'), 'utf8'));
  const policy = policyFor([R11, R2]);
  await client.query('INSERT INTO clients (id, slug, settings) VALUES ($1, $2, $3::jsonb)', [CLIENT, 'wolfhouse-somo', JSON.stringify({ other_setting: 'keep', luna_room_fill_policy: policy })]);
  await client.query(`INSERT INTO rooms (id, client_id, room_code, name, capacity, active, gender_strategy, room_type)
    VALUES ($1, $2, 'R11', 'Room 11', 1, TRUE, 'Flexible', 'mixed'), ($3, $2, 'R2', 'Room 2', 1, TRUE, 'Flexible', 'mixed')`, [R11, CLIENT, R2]);
  await client.query(`INSERT INTO beds (id, client_id, room_id, bed_code, bed_number, active, sellable)
    VALUES ($1, $2, $3, 'R11-B1', 1, TRUE, FALSE), ($4, $2, $5, 'R2-B1', 1, TRUE, TRUE)`, [B1, CLIENT, R11, B2, R2]);
  return policy;
}

function bodyFor(policy, operationId) {
  return {
    operationId,
    expectedSettingsRevision: settingsRevisionFor(policy),
    expectedCatalogRevision: catalogRevisionFor(rooms()),
  };
}

async function main() {
  const migration = fs.readFileSync(path.join(__dirname, '../database/migrations/112_staff_room_archive.sql'), 'utf8');
  const admission = migration.slice(migration.indexOf('booking_beds_reject_archived_room'), migration.indexOf('bookings_reject_archived_room_admission'));
  assert.ok(admission.indexOf("booking_occupancy_lock_key('booking'") < admission.indexOf("booking_occupancy_lock_key('bed'"), 'admission locks booking before bed');
  assert.deepEqual(LOCK_ORDER, ['client_row', 'bed_advisory']);
  assert.equal(resolveBedCalendarRoomRows('wolfhouse-somo', [], { archivedRoomCodes: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10'] }).some((row) => row.room_code === 'R1'), false);
  assert.equal(resolveBedCalendarRoomRows('wolfhouse-somo', [], { archiveLookupFailed: true }).length, 0);
  assert.ok(resolveBedCalendarRoomRows('sunset', [{ room_code: 'R1' }], { archivedRoomCodes: ['R1'] }).length === 1);

  const harness = await startDisposablePostgresHarness();
  const client = new Client(harness.admin);
  await client.connect();
  try {
    const policy = await seed(client);
    const revisions = { catalogRevision: catalogRevisionFor(rooms()), settingsRevision: settingsRevisionFor(policy) };
    const occupied = bodyFor(policy, 'op-archive-occupied');
    await client.query(`INSERT INTO bookings (id, client_id, booking_code, status, check_in, check_out, hold_expires_at)
      VALUES ($1, $2, 'H-1', 'hold', CURRENT_DATE - 3, CURRENT_DATE - 1, NOW() - interval '2 days')`, [BOOKING, CLIENT]);
    await client.query(`INSERT INTO booking_beds (client_id, booking_id, bed_id, assignment_start_date, assignment_end_date, assignment_type)
      VALUES ($1, $2, $3, CURRENT_DATE - 3, CURRENT_DATE - 1, 'hold')`, [CLIENT, BOOKING, B1]);
    await assert.rejects(() => archiveRoomFillRoom(client, input(occupied, { policy, revisions })), (err) => err.status === 409 && err.error === 'room_occupied');
    assert.equal((await client.query('SELECT archived_at FROM rooms WHERE id = $1', [R11])).rows[0].archived_at, null);

    await client.query(`UPDATE bookings SET status = 'expired' WHERE id = $1`, [BOOKING]);
    const archived = await archiveRoomFillRoom(client, input(bodyFor(policy, 'op-archive-empty-11'), { policy, revisions }));
    assert.equal(archived.roomId, R11);
    const stored = (await client.query('SELECT active, archived_at IS NOT NULL AS archived, archive_operation_id FROM rooms WHERE id = $1', [R11])).rows[0];
    assert.equal(stored.active, false);
    assert.equal(stored.archived, true);
    assert.equal(stored.archive_operation_id, 'op-archive-empty-11');
    const bed = (await client.query('SELECT active, sellable FROM beds WHERE id = $1', [B1])).rows[0];
    assert.equal(bed.active, false);
    assert.equal(bed.sellable, false);
    const settings = (await client.query('SELECT settings FROM clients WHERE id = $1', [CLIENT])).rows[0].settings;
    assert.equal(settings.other_setting, 'keep');
    assert.deepEqual(settings.luna_room_fill_policy.roomPriority, [R2]);
    const replay = await archiveRoomFillRoom(client, input(bodyFor(policy, 'op-archive-empty-11'), { policy, revisions: { catalogRevision: 'stale', settingsRevision: 'stale' } }));
    assert.equal(replay.duplicate, true);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM staff_room_fill_inventory_operations WHERE operation_id = $1', ['op-archive-empty-11'])).rows[0].n, 1);

    const restored = await restoreRoomFillRoom(client, input({
      operationId: 'op-restore-empty-11',
      expectedArchiveOperationId: 'op-archive-empty-11',
      expectedSettingsRevision: settingsRevisionFor(settings.luna_room_fill_policy),
      expectedCatalogRevision: catalogRevisionFor(rooms().filter((room) => room.roomId !== R11)),
    }, {
      policy: settings.luna_room_fill_policy,
      revisions: {
        settingsRevision: settingsRevisionFor(settings.luna_room_fill_policy),
        catalogRevision: catalogRevisionFor(rooms().filter((room) => room.roomId !== R11)),
      },
      omit: R11,
    }));
    assert.equal(restored.action, 'restore');
    const flags = (await client.query('SELECT active, sellable FROM beds WHERE id = $1', [B1])).rows[0];
    assert.equal(flags.active, true);
    assert.equal(flags.sellable, false);
    assert.equal((await client.query('SELECT archived_at FROM rooms WHERE id = $1', [R11])).rows[0].archived_at, null);

    const currentPolicy = (await client.query('SELECT settings FROM clients WHERE id = $1', [CLIENT])).rows[0].settings.luna_room_fill_policy;
    const again = await archiveRoomFillRoom(client, input(bodyFor(policy, 'op-archive-again'), {
      policy: currentPolicy,
      revisions: {
        catalogRevision: catalogRevisionFor(rooms()),
        settingsRevision: settingsRevisionFor(currentPolicy),
      },
    }));
    assert.equal(again.archiveOperationId, 'op-archive-again');
    const afterAgain = (await client.query('SELECT settings FROM clients WHERE id = $1', [CLIENT])).rows[0].settings.luna_room_fill_policy;
    await assert.rejects(() => restoreRoomFillRoom(client, input({
      operationId: 'op-old-undo',
      expectedArchiveOperationId: 'op-archive-empty-11',
      expectedSettingsRevision: settingsRevisionFor(afterAgain),
      expectedCatalogRevision: catalogRevisionFor(rooms().filter((room) => room.roomId !== R11)),
    }, {
      policy: afterAgain,
      revisions: {
        settingsRevision: settingsRevisionFor(afterAgain),
        catalogRevision: catalogRevisionFor(rooms().filter((room) => room.roomId !== R11)),
      },
      omit: R11,
    })), (err) => err.status === 409);
    await assert.rejects(() => restoreRoomFillRoom(client, input({
      operationId: 'op-restore-empty-11',
      expectedArchiveOperationId: 'op-archive-again',
      expectedSettingsRevision: settingsRevisionFor(afterAgain),
      expectedCatalogRevision: catalogRevisionFor(rooms().filter((room) => room.roomId !== R11)),
    }, {
      policy: afterAgain,
      revisions: {
        settingsRevision: settingsRevisionFor(afterAgain),
        catalogRevision: catalogRevisionFor(rooms().filter((room) => room.roomId !== R11)),
      },
      omit: R11,
    })), (err) => err.error === 'operation_conflict');
    const secondRestore = await restoreRoomFillRoom(client, input({
      operationId: 'op-restore-second-11',
      expectedArchiveOperationId: 'op-archive-again',
      expectedSettingsRevision: settingsRevisionFor(afterAgain),
      expectedCatalogRevision: catalogRevisionFor(rooms().filter((room) => room.roomId !== R11)),
    }, {
      policy: afterAgain,
      revisions: {
        settingsRevision: settingsRevisionFor(afterAgain),
        catalogRevision: catalogRevisionFor(rooms().filter((room) => room.roomId !== R11)),
      },
      omit: R11,
    }));
    assert.equal(secondRestore.action, 'restore');
    const afterSecond = (await client.query('SELECT settings FROM clients WHERE id = $1', [CLIENT])).rows[0].settings.luna_room_fill_policy;
    await archiveRoomFillRoom(client, input({
      operationId: 'op-archive-admission',
      expectedSettingsRevision: settingsRevisionFor(afterSecond),
      expectedCatalogRevision: catalogRevisionFor(rooms()),
    }, {
      policy: afterSecond,
      revisions: {
        catalogRevision: catalogRevisionFor(rooms()),
        settingsRevision: settingsRevisionFor(afterSecond),
      },
    }));

    await assert.rejects(() => client.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [BOOKING]), /archived_room_admission/);
    const live = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01';
    await client.query(`INSERT INTO bookings (id, client_id, booking_code, status, check_in, check_out)
      VALUES ($1, $2, 'C-1', 'confirmed', CURRENT_DATE, CURRENT_DATE + 2)`, [live, CLIENT]);
    await assert.rejects(() => client.query(`INSERT INTO booking_beds (client_id, booking_id, bed_id, assignment_start_date, assignment_end_date, assignment_type)
      VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + 2, 'guest')`, [CLIENT, live, B1]), /archived_room_admission/);
    const coded = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await assert.rejects(() => client.query(`INSERT INTO bookings (id, client_id, booking_code, status, assignment_status, check_in, check_out, primary_room_code)
      VALUES ($1, $2, 'P-1', 'confirmed', 'assigned', CURRENT_DATE, CURRENT_DATE + 3, 'R11')`, [coded, CLIENT]), /archived_room_admission/);
    const dated = '99999999-9999-4999-8999-999999999999';
    await client.query(`INSERT INTO bookings (id, client_id, booking_code, status, assignment_status, check_in, check_out, primary_room_code)
      VALUES ($1, $2, 'D-1', 'confirmed', 'unassigned', CURRENT_DATE - 4, CURRENT_DATE - 1, 'R11')`, [dated, CLIENT]);
    await assert.rejects(() => client.query(`UPDATE bookings SET check_out = CURRENT_DATE + 2 WHERE id = $1`, [dated]), /archived_room_admission/);
    assert.match(migration, /UPDATE OF status, room_to_block_id, primary_room_code, check_in, check_out, assignment_status/);
    assert.match(migration, /BEFORE INSERT OR UPDATE\s+ON booking_beds/);
    const calendar = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
    const historyGate = calendar.indexOf('archivedHistoryRooms && res.data.archivedHistoryRooms.length');
    assert.ok(historyGate > 0, 'last-room history stays on the schedule');
    assert.doesNotMatch(calendar.slice(historyGate, historyGate + 180), /rooms\.push|concat\(res\.data\.archivedHistoryRooms\)/);

    const user = { client_id: CLIENT, client_slug: 'wolfhouse-somo', role: 'operator', staff_user_id: 'staff-1' };
    const routes = createRoomFillRoutes({
      sendJSON(_res, status, body) { return { status, body }; },
      readBody: async (req) => JSON.stringify(req.body || {}),
      withPgClient: (fn) => fn(client),
      appendAuditLog() {},
    });
    const checked = await routes.handleRoomFillArchiveCheck(R2, {}, { headers: {} }, {}, user);
    assert.equal(checked.body.eligible, true);
    const missing = await routes.handleRoomFillArchiveCheck('99999999-9999-4999-8999-999999999999', {}, { headers: {} }, {}, user);
    assert.equal(missing.body.error, 'room_not_found');
    const sunset = await routes.handleRoomFillArchive(R2, {}, { headers: { host: 'staff.test', origin: 'http://staff.test' }, body: {} }, {}, { ...user, client_slug: 'sunset' });
    assert.equal(sunset.body.error, 'unsupported_tenant');
    console.log(JSON.stringify({ ok: true, backend: harness.backend, roomId: R11 }));
  } finally {
    await client.end();
    harness.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
