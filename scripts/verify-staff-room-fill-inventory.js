'use strict';

const assert = require('node:assert/strict');
const { Client } = require('pg');
const { startDisposablePostgresHarness } = require('./lib/disposable-postgres-harness');
const { createRoomFillInventory } = require('./lib/staff-room-fill-inventory');
const { catalogRevisionFor, projectRoom, roomGenderPresentation, settingsRevisionFor } = require('./lib/staff-room-fill-policy');
const { resolveBedCalendarRoomRows } = require('./lib/wolfhouse-inventory-source');
const { getBedCalendarRoomsQuery } = require('./lib/staff-bed-calendar-queries');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';

function presentationChecks() {
  assert.equal(roomGenderPresentation({ roomType: 'female_only', genderStrategy: 'Female preferred' }).genderLabel, 'Female');
  assert.equal(roomGenderPresentation({ roomType: 'male_only', genderStrategy: 'Male preferred' }).genderLabel, 'Male');
  assert.equal(roomGenderPresentation({ roomType: 'mixed', genderStrategy: 'Flexible' }).genderLabel, 'Mixed');
  assert.equal(roomGenderPresentation({ roomType: 'matrimonial_or_mixed', genderStrategy: 'Flexible' }).genderLabel, 'Mixed');
  const unknown = roomGenderPresentation({ roomType: '', genderStrategy: 'Flexible' });
  assert.equal(unknown.genderLabel, 'Mixed');
  assert.equal(unknown.reviewLabel, null);
  const conflict = roomGenderPresentation({ roomType: 'female_only', genderStrategy: 'Male preferred' });
  assert.equal(conflict.genderLabel, 'Male');
  const operator = roomGenderPresentation({ roomType: 'mixed', genderStrategy: 'Flexible', oftenUsedByOperator: true });
  assert.equal(operator.genderLabel, 'Mixed');
  const operatorRoom = projectRoom({
    roomId: R1, roomCode: 'R7', roomNumber: 7, capacity: 4, active: true,
    roomType: 'operator_surfweek', sellingMode: 'shared', genderStrategy: 'Flexible',
    canBeMatrimonial: false, oftenUsedByOperator: true, staticWarnings: [], beds: [],
  }, 1);
  assert.equal(operatorRoom.genderLabel, 'Mixed');
  assert.equal(operatorRoom.genderReview, null);
  assert.equal(operatorRoom.genderEditable, true);
  assert.equal(operatorRoom.sellingModeEditable, true);
  assert.equal(operatorRoom.restrictionLabel, null);
}

function fallbackKeepsPgOnlyRoom() {
  const csvLike = [{ room_code: 'R1', room_id: null, bed_id: null, bed_code: 'R1-B1' }];
  const pgRows = [
    { room_code: 'R1', room_id: R1, bed_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01', bed_code: 'R1-B1' },
    { room_code: 'R11', room_id: '33333333-3333-4333-8333-333333333333', bed_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd01', bed_code: 'R11-B1' },
  ];
  const original = resolveBedCalendarRoomRows;
  const rows = original('wolfhouse-somo', pgRows);
  const extra = rows.find((row) => row.room_code === 'R11');
  assert.ok(extra, 'reduced catalogue must keep a Postgres-only room');
  assert.equal(extra.room_id, '33333333-3333-4333-8333-333333333333');
  assert.equal(extra.bed_id, 'dddddddd-dddd-4ddd-8ddd-dddddddddd01');
  assert.equal(rows.filter((row) => row.room_code === 'R11').length, 1);
  assert.equal(csvLike.length, 1);
}

const SCHEMA = `
CREATE TABLE clients (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  room_id UUID NOT NULL REFERENCES rooms(id),
  bed_code TEXT NOT NULL,
  bed_number INTEGER,
  bed_label TEXT,
  planning_row_label TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sellable BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (client_id, bed_code)
);
CREATE TABLE staff_room_fill_create_receipts (
  client_id UUID NOT NULL REFERENCES clients(id),
  operation_id TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  room_id UUID NOT NULL,
  bed_ids JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, operation_id)
);
`;

function rooms() {
  return [
    { roomId: R1, roomCode: 'R1', capacity: 1, roomType: 'mixed', genderStrategy: 'Flexible', active: true, beds: [{ bedId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01', active: true, sellable: true }] },
    { roomId: R2, roomCode: 'R2', capacity: 1, roomType: 'mixed', genderStrategy: 'Flexible', active: true, beds: [{ bedId: 'cccccccc-cccc-4ccc-8ccc-cccccccccc01', active: true, sellable: true }] },
  ];
}

function request(operationId, roomNumber, gender) {
  const catalogue = rooms();
  return {
    operationId,
    roomNumber,
    bedCount: 2,
    gender,
    expectedSettingsRevision: null,
    expectedCatalogRevision: catalogRevisionFor(catalogue),
    fillMode: 'house',
    roomPriority: [R1, R2],
  };
}

async function main() {
  presentationChecks();
  fallbackKeepsPgOnlyRoom();
  const harness = await startDisposablePostgresHarness();
  const client = new Client(harness.admin);
  await client.connect();
  try {
    await client.query(SCHEMA);
    await client.query('INSERT INTO clients (id, slug, settings) VALUES ($1, $2, $3::jsonb)', [CLIENT, 'wolfhouse-somo', '{}']);
    const body = request('op-room-11-female', 11, 'female');
    const created = await createRoomFillInventory(client, {
      clientId: CLIENT,
      body,
      rooms: rooms(),
      storedPolicy: null,
      revisions: { catalogRevision: body.expectedCatalogRevision, settingsRevision: null },
      lockSql: 'SELECT id FROM clients WHERE id = $1::uuid FOR UPDATE',
      saveSql: `UPDATE clients SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{luna_room_fill_policy}', $2::jsonb, true) WHERE id = $1::uuid`,
    });
    assert.equal(created.roomCode, 'R11');
    assert.equal(created.bedIds.length, 2);
    const stored = await client.query(`
      SELECT r.id::text AS room_id, b.id::text AS bed_id, r.room_type, r.gender_strategy
      FROM rooms r JOIN beds b ON b.room_id = r.id
      WHERE r.client_id = $1 AND r.room_code = 'R11'
      ORDER BY b.bed_number
    `, [CLIENT]);
    assert.equal(stored.rows.length, 2);
    assert.equal(stored.rows[0].room_id, created.roomId);
    assert.deepEqual(stored.rows.map((row) => row.bed_id), created.bedIds);
    assert.equal(stored.rows[0].room_type, 'female_only');
    assert.equal(stored.rows[0].gender_strategy, 'Female preferred');
    const policy = (await client.query('SELECT settings FROM clients WHERE id = $1', [CLIENT])).rows[0].settings.luna_room_fill_policy;
    assert.equal(policy.roomPriority.at(-1), created.roomId);
    assert.equal(settingsRevisionFor(policy).length, 64);
    const retry = await createRoomFillInventory(client, {
      clientId: CLIENT,
      body,
      rooms: rooms().concat([{ roomId: created.roomId, roomCode: 'R11' }]),
      storedPolicy: policy,
      revisions: { catalogRevision: 'stale-after-create', settingsRevision: 'stale-after-create' },
      lockSql: 'SELECT id FROM clients WHERE id = $1::uuid FOR UPDATE',
      saveSql: `UPDATE clients SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{luna_room_fill_policy}', $2::jsonb, true) WHERE id = $1::uuid`,
    });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.roomId, created.roomId);
    assert.deepEqual(retry.bedIds, created.bedIds);
    const calendarSql = getBedCalendarRoomsQuery();
    const calendar = await client.query(calendarSql, ['wolfhouse-somo']);
    const reloaded = await client.query(calendarSql, ['wolfhouse-somo']);
    const visible = calendar.rows.filter((row) => row.room_id === created.roomId).map((row) => row.bed_id);
    assert.deepEqual(visible.sort(), created.bedIds.slice().sort());
    assert.deepEqual(reloaded.rows.map((row) => row.bed_id), calendar.rows.map((row) => row.bed_id));
    assert.equal((await client.query('SELECT count(*)::int AS n FROM rooms WHERE room_code = $1', ['R11'])).rows[0].n, 1);
    await assert.rejects(() => createRoomFillInventory(client, {
      clientId: CLIENT,
      body: { ...body, gender: 'male' },
      rooms: rooms(),
      storedPolicy: policy,
      revisions: { catalogRevision: body.expectedCatalogRevision, settingsRevision: null },
      lockSql: 'SELECT id FROM clients WHERE id = $1::uuid FOR UPDATE',
      saveSql: `UPDATE clients SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{luna_room_fill_policy}', $2::jsonb, true) WHERE id = $1::uuid`,
    }), (err) => err.status === 409);
    let bedInserts = 0;
    const wrapped = {
      query(sql, params) {
        if (String(sql).includes('room-fill-bed-insert')) {
          bedInserts += 1;
          if (bedInserts === 2) throw new Error('second bed failed');
        }
        return client.query(sql, params);
      },
    };
    const failedBody = request('op-room-13-mixed', 13, 'mixed');
    await assert.rejects(() => createRoomFillInventory(wrapped, {
      clientId: CLIENT,
      body: failedBody,
      rooms: rooms(),
      storedPolicy: null,
      revisions: { catalogRevision: failedBody.expectedCatalogRevision, settingsRevision: null },
      lockSql: 'SELECT id FROM clients WHERE id = $1::uuid FOR UPDATE',
      saveSql: `UPDATE clients SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{luna_room_fill_policy}', $2::jsonb, true) WHERE id = $1::uuid`,
    }));
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM rooms WHERE room_code = 'R13'`)).rows[0].n, 0);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM staff_room_fill_create_receipts WHERE operation_id = 'op-room-13-mixed'`)).rows[0].n, 0);
    console.log(JSON.stringify({
      ok: true,
      backend: harness.backend,
      roomId: created.roomId,
      bedIds: created.bedIds,
      calendarRoomId: stored.rows[0].room_id,
    }));
  } finally {
    await client.end();
    harness.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
