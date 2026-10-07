'use strict';

const crypto = require('crypto');
const { roomGenderEditable, catalogRevisionFor, UUID_RE } = require('./staff-room-fill-policy');

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

function parseCreateShape(body) {
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
  return {
    ok: true,
    operationId,
    roomNumber,
    bedCount,
    gender: body.gender,
    mapped: gender,
    fillMode: body.fillMode,
    roomPriority: body.roomPriority.slice(),
    expectedCatalogRevision: body.expectedCatalogRevision,
    expectedSettingsRevision: body.expectedSettingsRevision == null ? null : body.expectedSettingsRevision,
    fingerprint: payloadFingerprint({
      roomNumber,
      bedCount,
      gender: body.gender,
      fillMode: body.fillMode,
      roomPriority: body.roomPriority,
    }),
  };
}

function assertFreshOrder(parsed, rooms, revisions) {
  const currentIds = rooms.map((room) => room.roomId);
  if (!sameIdOrder(parsed.roomPriority.slice().sort(), currentIds.slice().sort())) return fail(400, 'invalid_order');
  if (parsed.expectedCatalogRevision !== revisions.catalogRevision) return fail(409, 'stale_catalog');
  if (parsed.expectedSettingsRevision !== revisions.settingsRevision) return fail(409, 'stale_settings');
  return { ok: true };
}

function parseCreateRequest(body, rooms, storedPolicy, revisions) {
  const parsed = parseCreateShape(body);
  if (!parsed.ok && parsed.status) return parsed;
  const fresh = assertFreshOrder(parsed, rooms, revisions);
  if (!fresh.ok && fresh.status) return fresh;
  return parsed;
}

async function createRoomFillInventory(pg, input) {
  const parsed = parseCreateShape(input.body);
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
    let rooms = input.rooms || [];
    let revisions = input.revisions || {};
    if (typeof input.readLockedState === 'function') {
      const freshState = await input.readLockedState(pg);
      rooms = freshState.rooms;
      revisions = freshState.revisions;
    }
    const fresh = assertFreshOrder(parsed, rooms, revisions);
    if (!fresh.ok && fresh.status) {
      await pg.query('ROLLBACK');
      throw fresh;
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

function parseGenderRequest(roomId, body) {
  if (!UUID_RE.test(roomId || '')) throw fail(400, 'invalid_room_id');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'invalid_json');
  if (Object.keys(body).some(key => !['gender', 'expectedCatalogRevision'].includes(key))) throw fail(400, 'invalid_gender_request');
  if (typeof body.gender !== 'string' || !Object.hasOwn(GENDER_SAVE, body.gender)) throw fail(400, 'invalid_gender');
  if (typeof body.expectedCatalogRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedCatalogRevision)) throw fail(400, 'missing_catalog_revision');
  return GENDER_SAVE[body.gender];
}

async function updateRoomFillGender(pg, input) {
  const mapped = parseGenderRequest(input.roomId, input.body);
  await pg.query('BEGIN');
  try {
    // All room-fill writers lock client first; row locks also fence ordinary
    // inventory writers. No bed, assignment, priority or settings mutations.
    await pg.query(input.lockSql, [input.clientId]);
    await pg.query('SELECT id FROM rooms WHERE client_id = $1::uuid ORDER BY id FOR UPDATE', [input.clientId]);
    await pg.query('SELECT id FROM beds WHERE client_id = $1::uuid ORDER BY id FOR SHARE', [input.clientId]);
    const before = await input.readLockedState(pg);
    const room = before.rooms.find(r => r.roomId === input.roomId);
    if (!room) throw fail(404, 'room_not_found');
    if (!roomGenderEditable(room)) throw fail(422, 'room_gender_read_only');
    const unchanged = room.roomType === mapped.roomType && room.genderStrategy === mapped.genderStrategy;
    // Lost-response retries may read the already-current value, but may never
    // mutate using an obsolete catalogue. Special rooms were rejected above.
    if (!unchanged && catalogRevisionFor(before.rooms) !== input.body.expectedCatalogRevision) throw fail(409, 'catalogue_changed');
    if (!unchanged) {
      const updated = await pg.query(`UPDATE rooms SET room_type = $3, gender_strategy = $4
        WHERE client_id = $1::uuid AND id = $2::uuid RETURNING id
        /* room-fill-gender-update */`, [input.clientId, input.roomId, mapped.roomType, mapped.genderStrategy]);
      if (updated.rows.length !== 1) throw fail(409, 'room_changed');
    }
    const after = await input.readLockedState(pg);
    const saved = after.rooms.find(r => r.roomId === input.roomId);
    if (!saved || saved.roomType !== mapped.roomType || saved.genderStrategy !== mapped.genderStrategy) throw fail(503, 'gender_readback_failed');
    await pg.query('COMMIT');
    return { ...after, unchanged, roomId: input.roomId,
      old: { roomType: room.roomType, genderStrategy: room.genderStrategy }, new: { ...mapped } };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* connection already closed */ }
    throw err;
  }
}

module.exports = {
  updateRoomFillGender,
  parseGenderRequest,
  BED_IDS_SQL,
  GENDER_SAVE,
  createRoomFillInventory,
  normalizeRoomNumber,
  parseCreateRequest,
  parseCreateShape,
  payloadFingerprint,
};
