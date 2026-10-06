'use strict';

const crypto = require('crypto');

const GENDER_SAVE = Object.freeze({
  female: { genderStrategy: 'Female preferred', roomType: 'female_only' },
  male: { genderStrategy: 'Male preferred', roomType: 'male_only' },
  mixed: { genderStrategy: 'Flexible', roomType: 'mixed' },
});

const RECEIPT_SQL = `
SELECT operation_id, payload_fingerprint, room_id::text AS room_id, bed_ids
FROM staff_room_fill_create_receipts
WHERE client_id = $1::uuid AND operation_id = $2
/* room-fill-receipt-lookup */
`;
const RECEIPT_INSERT_SQL = `
INSERT INTO staff_room_fill_create_receipts
  (client_id, operation_id, payload_fingerprint, room_id, bed_ids)
VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb)
/* room-fill-receipt-insert */
`;
const ROOM_LOOKUP_SQL = `
SELECT id::text AS room_id, room_code, gender_strategy, capacity
FROM rooms
WHERE client_id = $1::uuid AND room_code = $2
LIMIT 1
FOR UPDATE
/* room-fill-room-lookup */
`;
const ROOM_INSERT_SQL = `
INSERT INTO rooms (
  client_id, room_code, name, capacity, gender_strategy, room_type, active,
  can_be_matrimonial, often_used_by_operator
)
VALUES ($1::uuid, $2, $3, $4, $5, $6, TRUE, FALSE, FALSE)
RETURNING id::text AS room_id
/* room-fill-room-insert */
`;
const BED_INSERT_SQL = `
INSERT INTO beds (
  client_id, room_id, bed_code, bed_number, bed_label, planning_row_label, active, sellable
)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, TRUE, TRUE)
RETURNING id::text AS bed_id
/* room-fill-bed-insert */
`;
const BED_IDS_SQL = `
SELECT id::text AS bed_id, bed_code
FROM beds
WHERE client_id = $1::uuid AND room_id = $2::uuid AND active = TRUE
ORDER BY bed_number ASC, bed_code ASC
/* room-fill-bed-ids */
`;

function fail(status, error) {
  return Object.assign(new Error(error), { status, error });
}

function normalizeRoomNumber(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^[0-9]+$/.test(text)) return null;
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1 || number > 9999) return null;
  return number;
}

function payloadFingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify({
    roomNumber: input.roomNumber,
    bedCount: input.bedCount,
    gender: input.gender,
    fillMode: input.fillMode,
    roomPriority: input.roomPriority,
  })).digest('hex');
}

function sameIdOrder(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

function parseCreateRequest(body, rooms, storedPolicy, revisions) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'invalid_json');
  const allowed = ['operationId', 'roomNumber', 'bedCount', 'gender', 'expectedSettingsRevision', 'expectedCatalogRevision', 'fillMode', 'roomPriority'];
  if (Object.keys(body).some((key) => !allowed.includes(key))) return fail(400, 'invalid_room');
  if (body.client_id || body.client_slug || body.roomId || body.bedIds) return fail(400, 'caller_identity_rejected');
  const operationId = String(body.operationId || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(operationId)) return fail(400, 'invalid_operation');
  const roomNumber = normalizeRoomNumber(body.roomNumber);
  const bedCount = Number(body.bedCount);
  const gender = GENDER_SAVE[body.gender];
  if (!roomNumber) return fail(400, 'invalid_room_number');
  if (!Number.isSafeInteger(bedCount) || bedCount < 1 || bedCount > 100) return fail(400, 'invalid_bed_count');
  if (!gender) return fail(400, 'invalid_gender');
  if (!['house', 'room'].includes(body.fillMode)) return fail(400, 'invalid_fill_mode');
  if (!Array.isArray(body.roomPriority) || body.roomPriority.some((id) => typeof id !== 'string')) {
    return fail(400, 'invalid_order');
  }
  const currentIds = rooms.map((room) => room.roomId);
  if (!sameIdOrder(body.roomPriority.slice().sort(), currentIds.slice().sort())) return fail(400, 'invalid_order');
  if (body.expectedCatalogRevision !== revisions.catalogRevision) return fail(409, 'stale_catalog');
  const expectedSettings = body.expectedSettingsRevision == null ? null : body.expectedSettingsRevision;
  if (expectedSettings !== revisions.settingsRevision) return fail(409, 'stale_settings');
  if (storedPolicy && storedPolicy.fillMode && body.fillMode !== storedPolicy.fillMode && body.roomPriority.join() !== storedPolicy.roomPriority.join()) {
    // Current order is accepted; mode must still be one of the two saved choices.
  }
  return {
    ok: true,
    operationId,
    roomNumber,
    bedCount,
    gender: body.gender,
    mapped: gender,
    fillMode: body.fillMode,
    roomPriority: body.roomPriority.slice(),
    fingerprint: payloadFingerprint({
      roomNumber,
      bedCount,
      gender: body.gender,
      fillMode: body.fillMode,
      roomPriority: body.roomPriority,
    }),
  };
}

async function createRoomFillInventory(pg, input) {
  const parsed = parseCreateRequest(input.body, input.rooms, input.storedPolicy, input.revisions);
  if (!parsed.ok && parsed.status) throw parsed;
  await pg.query('BEGIN');
  try {
    await pg.query(input.lockSql, [input.clientId]);
    const prior = await pg.query(RECEIPT_SQL, [input.clientId, parsed.operationId]);
    const receipt = prior.rows && prior.rows[0];
    if (receipt) {
      if (receipt.payload_fingerprint !== parsed.fingerprint) {
        await pg.query('ROLLBACK');
        throw fail(409, 'operation_conflict');
      }
      await pg.query('COMMIT');
      return {
        duplicate: true,
        roomId: receipt.room_id,
        roomCode: `R${parsed.roomNumber}`,
        bedIds: receipt.bed_ids,
        settingsWrite: false,
      };
    }
    const roomCode = `R${parsed.roomNumber}`;
    const existing = await pg.query(ROOM_LOOKUP_SQL, [input.clientId, roomCode]);
    if (existing.rows && existing.rows[0]) {
      await pg.query('ROLLBACK');
      throw fail(409, 'room_exists');
    }
    const inserted = await pg.query(ROOM_INSERT_SQL, [
      input.clientId,
      roomCode,
      `Room ${parsed.roomNumber}`,
      parsed.bedCount,
      parsed.mapped.genderStrategy,
      parsed.mapped.roomType,
    ]);
    const roomId = inserted.rows[0].room_id;
    const bedIds = [];
    for (let index = 1; index <= parsed.bedCount; index += 1) {
      const bedCode = `${roomCode}-B${index}`;
      const bed = await pg.query(BED_INSERT_SQL, [
        input.clientId,
        roomId,
        bedCode,
        index,
        `Bed ${index}`,
        `${roomCode} - Bed ${index}`,
      ]);
      bedIds.push(bed.rows[0].bed_id);
    }
    const nextPolicy = {
      contractVersion: 1,
      fillMode: parsed.fillMode,
      roomPriority: parsed.roomPriority.concat(roomId),
      roomPrioritySource: 'custom',
    };
    await pg.query(input.saveSql, [input.clientId, JSON.stringify(nextPolicy)]);
    await pg.query(RECEIPT_INSERT_SQL, [input.clientId, parsed.operationId, parsed.fingerprint, roomId, JSON.stringify(bedIds)]);
    await pg.query('COMMIT');
    return {
      duplicate: false,
      roomId,
      roomCode,
      bedIds,
      policy: nextPolicy,
      settingsWrite: true,
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* already closed */ }
    throw err;
  }
}

module.exports = {
  BED_IDS_SQL,
  GENDER_SAVE,
  createRoomFillInventory,
  normalizeRoomNumber,
  parseCreateRequest,
  payloadFingerprint,
};
