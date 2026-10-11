'use strict';

/**
 * Wolfhouse room archive / restore.
 *
 * Lock order inside the client-row transaction:
 *   1. clients row FOR UPDATE (same as other room-fill writers)
 *   2. each affected bed via booking_occupancy_lock_key('bed', id), bed id order
 * Admission triggers lock booking, then bed. This service does not lock a
 * booking id, so it cannot invert that order.
 */

const crypto = require('crypto');
const { numericRoomOrder, roomNumberFromCode, UUID_RE } = require('./staff-room-fill-policy');

const LOCK_ORDER = Object.freeze(['client_row', 'bed_advisory']);
const OPERATION_RE = /^[A-Za-z0-9._:-]{8,80}$/;
const ROLES = Object.freeze(['operator', 'admin', 'owner']);

function fail(status, error, extra) {
  return Object.assign(new Error(error), { status, error }, extra || {});
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function wolfhouseBusinessDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function requestHash(action, roomId, body) {
  return sha256({
    action,
    roomId,
    expectedCatalogRevision: body.expectedCatalogRevision,
    expectedSettingsRevision: body.expectedSettingsRevision == null ? null : body.expectedSettingsRevision,
    expectedArchiveOperationId: body.expectedArchiveOperationId || null,
  });
}

function parseMutation(action, roomId, body) {
  if (!UUID_RE.test(roomId || '')) throw fail(400, 'invalid_room_id');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'invalid_json');
  const allowed = action === 'restore'
    ? ['operationId', 'expectedSettingsRevision', 'expectedCatalogRevision', 'expectedArchiveOperationId']
    : ['operationId', 'expectedSettingsRevision', 'expectedCatalogRevision'];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw fail(400, 'invalid_archive_request');
  if (body.client_id || body.client_slug) throw fail(400, 'caller_identity_rejected');
  const operationId = String(body.operationId || '').trim();
  if (!OPERATION_RE.test(operationId)) throw fail(400, 'invalid_operation');
  if (typeof body.expectedCatalogRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedCatalogRevision)) {
    throw fail(400, 'missing_catalog_revision');
  }
  if (action === 'restore') {
    const expected = String(body.expectedArchiveOperationId || '').trim();
    if (!OPERATION_RE.test(expected)) throw fail(400, 'invalid_archive_operation');
  }
  return {
    operationId,
    expectedCatalogRevision: body.expectedCatalogRevision,
    expectedSettingsRevision: body.expectedSettingsRevision == null ? null : body.expectedSettingsRevision,
    expectedArchiveOperationId: body.expectedArchiveOperationId || null,
    hash: requestHash(action, roomId, body),
  };
}

function assertRole(user) {
  if (!user || !user.client_id) throw fail(401, 'authentication_required');
  if (!ROLES.includes(user.role)) throw fail(403, 'forbidden');
}

async function lockBeds(pg, bedIds) {
  const ordered = bedIds.slice().sort();
  for (const bedId of ordered) {
    await pg.query(
      `SELECT pg_advisory_xact_lock(public.booking_occupancy_lock_key('bed', $1::uuid))
       /* room-archive-bed-lock */`,
      [bedId],
    );
  }
}

function blocksStay(row, businessDate) {
  const status = String(row.status || '');
  if (status === 'cancelled' || status === 'expired') return false;
  if (status === 'hold' || status === 'checked_in') return true;
  if (String(row.assignment_status || '') === 'checked_in') return true;
  const end = row.assignment_end_date || row.check_out;
  return !!end && String(end) > businessDate;
}

function publicBlocker(row) {
  return {
    kind: row.kind,
    reference: row.reference || null,
    status: row.status || null,
    blockType: row.block_type || row.blockType || null,
    assignmentType: row.assignment_type || row.assignmentType || null,
    start: row.start || row.assignment_start_date || row.check_in || null,
    end: row.end || row.assignment_end_date || row.check_out || null,
    scheduleHref: '#tab-bed-calendar',
  };
}

async function readEligibility(pg, clientId, roomId, businessDate) {
  let occupancy;
  try {
    occupancy = await pg.query(`
      SELECT b.booking_code AS reference, b.status::text AS status, b.block_type::text AS block_type,
             b.assignment_status::text AS assignment_status,
             bb.assignment_start_date::text AS assignment_start_date,
             bb.assignment_end_date::text AS assignment_end_date,
             bb.assignment_type,
             b.check_in::text AS check_in, b.check_out::text AS check_out
        FROM booking_beds bb
        JOIN beds bd ON bd.id = bb.bed_id AND bd.client_id = $2::uuid
        JOIN bookings b ON b.id = bb.booking_id
       WHERE bd.room_id = $1::uuid
         AND b.client_id = $2::uuid
      /* room-archive-occupancy */
    `, [roomId, clientId]);
  } catch (err) {
    if (err && err.code === '42P01') {
      return { ok: false, checkFailed: true, blockers: [publicBlocker({ kind: 'unresolved', reference: 'occupancy' })] };
    }
    throw err;
  }
  const blockers = [];
  for (const row of occupancy.rows || []) {
    if (blocksStay(row, businessDate)) blockers.push(publicBlocker({ ...row, kind: row.assignment_type === 'external_inventory_block' ? 'external_block' : 'booking' }));
  }
  let direct;
  try {
    direct = await pg.query(`
      SELECT b.booking_code AS reference, b.status::text AS status, b.block_type::text AS block_type,
             b.assignment_status::text AS assignment_status,
             b.check_in::text AS start, b.check_out::text AS end, b.check_out::text AS check_out,
             CASE WHEN b.room_to_block_id = $1::uuid THEN 'room_to_block' ELSE 'primary_room' END AS assignment_type
        FROM bookings b
        JOIN rooms r ON r.id = $1::uuid AND r.client_id = b.client_id
       WHERE b.client_id = $2::uuid
         AND b.status::text NOT IN ('cancelled', 'expired')
         AND (
           b.room_to_block_id = $1::uuid
           OR (b.primary_room_code = r.room_code AND b.assignment_status::text IN ('assigned', 'assigning', 'needs_review'))
         )
      /* room-archive-room-ref */
    `, [roomId, clientId]);
  } catch (err) {
    if (err && err.code === '42P01') {
      return { ok: false, checkFailed: true, blockers: [publicBlocker({ kind: 'unresolved', reference: 'room_reference' })] };
    }
    throw err;
  }
  for (const row of direct.rows || []) {
    const unresolved = ['needs_review', 'assigning'].includes(String(row.assignment_status || ''));
    if (blocksStay(row, businessDate) || unresolved) {
      blockers.push(publicBlocker({ ...row, kind: 'room_reference' }));
    }
  }
  let maps = { rows: [] };
  const mapsTable = await pg.query(`SELECT to_regclass('public.external_calendar_unit_maps') AS reg`);
  if (mapsTable.rows[0] && mapsTable.rows[0].reg) {
    maps = await pg.query(`
      SELECT bd.bed_code AS reference
        FROM external_calendar_unit_maps m
        JOIN beds bd ON bd.id = m.bed_id AND bd.client_id = $2::uuid
       WHERE bd.room_id = $1::uuid
         AND m.client_id = $2::uuid
      /* room-archive-external-map */
    `, [roomId, clientId]);
  }
  for (const row of maps.rows || []) {
    blockers.push(publicBlocker({ kind: 'external_mapping', reference: row.reference, status: 'mapped' }));
  }
  const seen = new Set();
  const unique = blockers.filter((row) => {
    const key = `${row.kind}:${row.reference}:${row.start}:${row.end}:${row.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ok: unique.length === 0, checkFailed: false, blockers: unique };
}

async function loadRoom(pg, clientId, roomId, forUpdate) {
  const room = await pg.query(`
    SELECT id::text AS room_id, room_code, name, active, capacity,
           NULLIF(to_jsonb(rooms)->>'archived_at', '') AS archived_at,
           NULLIF(to_jsonb(rooms)->>'archive_operation_id', '') AS archive_operation_id
      FROM rooms
     WHERE client_id = $1::uuid AND id = $2::uuid
     ${forUpdate ? 'FOR UPDATE' : ''}
    /* room-archive-room */
  `, [clientId, roomId]);
  return room.rows && room.rows[0];
}

async function loadBeds(pg, clientId, roomId, forUpdate) {
  const beds = await pg.query(`
    SELECT id::text AS bed_id, bed_code, active, sellable
      FROM beds
     WHERE client_id = $1::uuid AND room_id = $2::uuid
     ORDER BY id
     ${forUpdate ? 'FOR UPDATE' : ''}
    /* room-archive-beds */
  `, [clientId, roomId]);
  return beds.rows || [];
}

function snapshotFor(room, beds, policy, priority) {
  const index = priority.indexOf(room.room_id);
  return {
    roomActive: room.active === true || room.active === 't',
    roomCode: room.room_code,
    beds: beds.map((bed) => ({
      bedId: bed.bed_id,
      active: bed.active === true || bed.active === 't',
      sellable: bed.sellable === true || bed.sellable === 't',
    })),
    predecessorId: index > 0 ? priority[index - 1] : null,
    successorId: index >= 0 && index < priority.length - 1 ? priority[index + 1] : null,
    policyMode: policy ? policy.fillMode : null,
    policySource: policy ? policy.roomPrioritySource : null,
  };
}

function assertSnapshotShape(snapshot, room, beds) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw fail(409, 'snapshot_conflict');
  if (typeof snapshot.roomActive !== 'boolean') throw fail(409, 'snapshot_conflict');
  if (typeof snapshot.roomCode !== 'string' || snapshot.roomCode !== room.room_code) throw fail(409, 'snapshot_conflict');
  if (!Array.isArray(snapshot.beds)) throw fail(409, 'snapshot_conflict');
  const seen = new Set();
  for (const bed of snapshot.beds) {
    if (!bed || typeof bed !== 'object' || Array.isArray(bed)) throw fail(409, 'snapshot_conflict');
    if (typeof bed.bedId !== 'string' || !UUID_RE.test(bed.bedId)) throw fail(409, 'snapshot_conflict');
    if (typeof bed.active !== 'boolean' || typeof bed.sellable !== 'boolean') throw fail(409, 'snapshot_conflict');
    if (seen.has(bed.bedId)) throw fail(409, 'snapshot_conflict');
    seen.add(bed.bedId);
  }
  const currentIds = beds.map((bed) => bed.bed_id).sort();
  const savedIds = snapshot.beds.map((bed) => bed.bedId).sort();
  if (currentIds.length !== savedIds.length || currentIds.some((id, index) => id !== savedIds[index])) {
    throw fail(409, 'snapshot_conflict');
  }
}

function placeRestored(policy, rooms, room, snapshot) {
  const others = (policy.roomPriority || []).filter((id) => id !== room.room_id);
  if (policy.roomPrioritySource === 'default_numeric') {
    return numericRoomOrder(rooms.concat([{
      roomId: room.room_id,
      roomCode: room.room_code,
      roomNumber: roomNumberFromCode(room.room_code),
    }]));
  }
  if (snapshot.predecessorId && others.includes(snapshot.predecessorId)) {
    const next = others.slice();
    next.splice(next.indexOf(snapshot.predecessorId) + 1, 0, room.room_id);
    return next;
  }
  if (snapshot.successorId && others.includes(snapshot.successorId)) {
    const next = others.slice();
    next.splice(next.indexOf(snapshot.successorId), 0, room.room_id);
    return next;
  }
  return others.concat(room.room_id);
}

async function withRetry(work) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      last = err;
      if (!(err && (err.code === '40P01' || err.code === '40001'))) throw err;
    }
  }
  throw last;
}

async function archiveRoomFillRoom(pg, input) {
  assertRole(input.user);
  const parsed = parseMutation('archive', input.roomId, input.body);
  return withRetry(() => archiveOnce(pg, input, parsed));
}

async function archiveOnce(pg, input, parsed) {
  const businessDate = input.businessDate || wolfhouseBusinessDate();
  await pg.query('BEGIN');
  try {
    await pg.query(input.lockSql, [input.clientId]);
    const prior = await pg.query(`
      SELECT operation_id, action, room_id::text AS room_id, request_hash, result, snapshot
        FROM staff_room_fill_inventory_operations
       WHERE client_id = $1::uuid AND operation_id = $2
      /* room-archive-journal-lookup */
    `, [input.clientId, parsed.operationId]);
    const receipt = prior.rows && prior.rows[0];
    if (receipt) {
      if (receipt.request_hash !== parsed.hash || receipt.action !== 'archive') {
        throw fail(409, 'operation_conflict');
      }
      await pg.query('COMMIT');
      return {
        duplicate: true,
        action: 'archive',
        roomId: receipt.room_id,
        archiveOperationId: receipt.operation_id,
        receipt,
        settingsWrite: false,
      };
    }
    const state = await input.readLockedState(pg);
    if (parsed.expectedCatalogRevision !== state.revisions.catalogRevision) throw fail(409, 'stale_catalog');
    if (parsed.expectedSettingsRevision !== state.revisions.settingsRevision) throw fail(409, 'stale_settings');
    const room = await loadRoom(pg, input.clientId, input.roomId, false);
    if (!room) throw fail(404, 'room_not_found');
    if (room.archived_at) throw fail(409, 'room_archived');
    const bedIds = (await loadBeds(pg, input.clientId, input.roomId, false)).map((bed) => bed.bed_id);
    await lockBeds(pg, bedIds);
    const lockedRoom = await loadRoom(pg, input.clientId, input.roomId, true);
    if (!lockedRoom || lockedRoom.archived_at) throw fail(409, 'room_archived');
    const beds = await loadBeds(pg, input.clientId, input.roomId, true);
    const eligibility = await readEligibility(pg, input.clientId, input.roomId, businessDate);
    if (eligibility.checkFailed || !eligibility.ok) {
      throw fail(409, 'room_occupied', { blockers: eligibility.blockers, checkFailed: eligibility.checkFailed === true });
    }
    const policy = state.policy;
    const priority = policy && Array.isArray(policy.roomPriority) ? policy.roomPriority.slice() : [];
    const snapshot = snapshotFor(lockedRoom, beds, policy, priority);
    if (policy) {
      const next = {
        contractVersion: 1,
        fillMode: policy.fillMode,
        roomPriority: priority.filter((id) => id !== room.room_id),
        roomPrioritySource: policy.roomPrioritySource,
      };
      if (policy.roomPrioritySource === 'default_numeric') {
        next.roomPriority = numericRoomOrder((state.rooms || []).filter((item) => item.roomId !== room.room_id));
      }
      await pg.query(input.saveSql, [input.clientId, JSON.stringify(next)]);
    }
    await pg.query(`
      UPDATE rooms
         SET active = FALSE, archived_at = NOW(), archive_operation_id = $3
       WHERE client_id = $1::uuid AND id = $2::uuid
      /* room-archive-mark */
    `, [input.clientId, input.roomId, parsed.operationId]);
    if (beds.length) {
      await pg.query(`
        UPDATE beds
           SET active = FALSE, sellable = FALSE
         WHERE client_id = $1::uuid AND room_id = $2::uuid
        /* room-archive-beds-off */
      `, [input.clientId, input.roomId]);
    }
    await pg.query(`
      INSERT INTO staff_room_fill_inventory_operations
        (client_id, operation_id, action, room_id, request_hash, actor_staff_user_id, result, snapshot)
      VALUES ($1::uuid, $2, 'archive', $3::uuid, $4, $5, 'committed', $6::jsonb)
      /* room-archive-journal-insert */
    `, [input.clientId, parsed.operationId, input.roomId, parsed.hash, input.user.staff_user_id || null, JSON.stringify(snapshot)]);
    if (typeof input.beforeCommit === 'function') await input.beforeCommit(pg);
    await pg.query('COMMIT');
    return {
      duplicate: false,
      action: 'archive',
      roomId: input.roomId,
      roomCode: room.room_code,
      archiveOperationId: parsed.operationId,
      settingsWrite: !!policy,
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* already closed */ }
    throw err;
  }
}

async function restoreRoomFillRoom(pg, input) {
  assertRole(input.user);
  const parsed = parseMutation('restore', input.roomId, input.body);
  return withRetry(() => restoreOnce(pg, input, parsed));
}

async function restoreOnce(pg, input, parsed) {
  await pg.query('BEGIN');
  try {
    await pg.query(input.lockSql, [input.clientId]);
    const prior = await pg.query(`
      SELECT operation_id, action, room_id::text AS room_id, request_hash, result, snapshot
        FROM staff_room_fill_inventory_operations
       WHERE client_id = $1::uuid AND operation_id = $2
      /* room-archive-journal-lookup */
    `, [input.clientId, parsed.operationId]);
    const receipt = prior.rows && prior.rows[0];
    if (receipt) {
      if (receipt.request_hash !== parsed.hash || receipt.action !== 'restore') throw fail(409, 'operation_conflict');
      await pg.query('COMMIT');
      return { duplicate: true, action: 'restore', roomId: receipt.room_id, receipt, settingsWrite: false };
    }
    const state = await input.readLockedState(pg);
    if (parsed.expectedCatalogRevision !== state.revisions.catalogRevision) throw fail(409, 'stale_catalog');
    if (parsed.expectedSettingsRevision !== state.revisions.settingsRevision) throw fail(409, 'stale_settings');
    const room = await loadRoom(pg, input.clientId, input.roomId);
    if (!room || !room.archived_at) throw fail(404, 'room_not_found');
    if (room.archive_operation_id !== parsed.expectedArchiveOperationId) throw fail(409, 'archive_operation_conflict');
    const journal = await pg.query(`
      SELECT snapshot
        FROM staff_room_fill_inventory_operations
       WHERE client_id = $1::uuid AND operation_id = $2 AND action = 'archive'
      /* room-archive-snapshot */
    `, [input.clientId, parsed.expectedArchiveOperationId]);
    const snapshot = journal.rows && journal.rows[0] && journal.rows[0].snapshot;
    const beds = await loadBeds(pg, input.clientId, input.roomId);
    assertSnapshotShape(snapshot, room, beds);
    const currentIds = beds.map((bed) => bed.bed_id);
    await lockBeds(pg, currentIds);
    await pg.query(`SELECT set_config('wolfhouse.room_restore', 'on', true)`);
    await pg.query(`
      UPDATE rooms
         SET active = $3, archived_at = NULL, archive_operation_id = NULL
       WHERE client_id = $1::uuid AND id = $2::uuid
      /* room-archive-restore-room */
    `, [input.clientId, input.roomId, snapshot.roomActive]);
    for (const bed of snapshot.beds) {
      await pg.query(`
        UPDATE beds
           SET active = $3, sellable = $4
         WHERE client_id = $1::uuid AND id = $2::uuid AND room_id = $5::uuid
        /* room-archive-restore-bed */
      `, [input.clientId, bed.bedId, bed.active, bed.sellable, input.roomId]);
    }
    let placedAt = null;
    if (state.policy) {
      const restoredRoom = { room_id: room.room_id, room_code: room.room_code };
      const nextPriority = placeRestored(state.policy, state.rooms || [], restoredRoom, snapshot);
      placedAt = nextPriority.indexOf(room.room_id) + 1;
      const next = {
        contractVersion: 1,
        fillMode: state.policy.fillMode,
        roomPriority: nextPriority,
        roomPrioritySource: state.policy.roomPrioritySource,
      };
      await pg.query(input.saveSql, [input.clientId, JSON.stringify(next)]);
    }
    await pg.query(`
      INSERT INTO staff_room_fill_inventory_operations
        (client_id, operation_id, action, room_id, request_hash, actor_staff_user_id, result, snapshot)
      VALUES ($1::uuid, $2, 'restore', $3::uuid, $4, $5, 'committed', $6::jsonb)
      /* room-archive-journal-insert */
    `, [input.clientId, parsed.operationId, input.roomId, parsed.hash, input.user.staff_user_id || null, JSON.stringify(snapshot)]);
    if (typeof input.beforeCommit === 'function') await input.beforeCommit(pg);
    await pg.query('COMMIT');
    return {
      duplicate: false,
      action: 'restore',
      roomId: input.roomId,
      roomCode: room.room_code,
      placedAt,
      settingsWrite: !!state.policy,
    };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* already closed */ }
    throw err;
  }
}

async function checkRoomArchive(pg, input) {
  assertRole(input.user);
  if (!UUID_RE.test(input.roomId || '')) throw fail(400, 'invalid_room_id');
  const room = await pg.query(`
    SELECT id::text AS room_id
      FROM rooms
     WHERE client_id = $1::uuid AND id = $2::uuid
       AND NULLIF(to_jsonb(rooms)->>'archived_at', '') IS NULL
    /* room-archive-check-room */
  `, [input.clientId, input.roomId]);
  if (!room.rows || !room.rows[0]) throw fail(404, 'room_not_found');
  const eligibility = await readEligibility(pg, input.clientId, input.roomId, input.businessDate || wolfhouseBusinessDate());
  return {
    eligible: eligibility.ok === true && eligibility.checkFailed !== true,
    checkFailed: eligibility.checkFailed === true,
    blockers: eligibility.blockers || [],
  };
}

module.exports = {
  LOCK_ORDER,
  archiveRoomFillRoom,
  checkRoomArchive,
  parseMutation,
  publicBlocker,
  restoreRoomFillRoom,
  wolfhouseBusinessDate,
};
