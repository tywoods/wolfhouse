'use strict';

/**
 * Staff-only Fill House / Fill Room policy contract (v1).
 * Validation and ordering only. No inventory writes, no booking placement.
 */

const crypto = require('crypto');

const CONTRACT_VERSION = 1;
const SETTINGS_KEY = 'luna_room_fill_policy';
const SUPPORTED_CLIENT_SLUG = 'wolfhouse-somo';
const ACTIVATION_STATUS = 'connected';
const FILL_MODES = Object.freeze(['house', 'room']);
const PRIORITY_SOURCES = Object.freeze(['default_numeric', 'custom']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_NUMBER_RE = /^(?:R)?(\d+)$/i;

const REASON_TEXT = Object.freeze({
  room_inactive: 'This room is inactive.',
  no_sellable_beds: 'This room has no sellable beds.',
  full_for_stay: 'This room has no bed free for every night of the stay.',
  blocked_for_stay: 'A block covers this room for the stay.',
  no_continuous_beds: 'Beds free on some nights are not free for the whole stay.',
  incompatible_room_type: 'This room does not match the group safety rules.',
  incompatible_group_constraints: 'The room preference does not match this room.',
  protected_private_room: 'This private room is kept for a couple request.',
  operator_restricted: 'Operator rooms are not used by this preview.',
  outside_house_scope: 'This room is outside the property this preview can use.',
  insufficient_party_capacity: 'This room cannot hold the whole party for the stay.',
  split_permission_required: 'No single room fits the party, and splitting was not allowed.',
  safety_tier_precedes_priority: 'Safety rules skipped a higher-ranked room.',
  eligible_not_selected: 'Eligible, not selected.',
  not_evaluated: 'Not evaluated — enter stay details.',
  request_details_missing: 'Stay dates and party size are required.',
  inventory_unavailable: 'Room inventory could not be read.',
  missing_canonical_room_id: 'A room is missing its stable id, so this list cannot be saved.',
  catalogue_changed: 'The room list changed. Review it before saving.',
  unsupported_contract_version: 'This room-placement setting is a version this screen does not understand.',
  preview_policy_not_supported: 'This preview cannot cover that safety case yet.',
  room_priority_first: 'Fill Room used the first safe room in this order.',
  house_lowest_projected_occupancy: 'Fill House chose the room with the lowest projected occupancy.',
  house_priority_tiebreak: 'Equal occupancy was broken by this room order.',
  party_kept_together: 'The party stays together because one safe room fits.',
  split_required: 'The party does not fit in one room, so the preview splits it.',
});

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function roomNumberFromCode(code) {
  const match = ROOM_NUMBER_RE.exec(String(code == null ? '' : code).trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function compareRoomIdentity(a, b) {
  const an = a.roomNumber == null ? null : a.roomNumber;
  const bn = b.roomNumber == null ? null : b.roomNumber;
  if (an != null && bn == null) return -1;
  if (an == null && bn != null) return 1;
  if (an != null && bn != null && an !== bn) return an - bn;
  const ac = String(a.roomCode || '').toLowerCase();
  const bc = String(b.roomCode || '').toLowerCase();
  if (ac < bc) return -1;
  if (ac > bc) return 1;
  const ai = String(a.roomId || '');
  const bi = String(b.roomId || '');
  if (ai < bi) return -1;
  if (ai > bi) return 1;
  return 0;
}

function numericRoomOrder(rooms) {
  return rooms.slice().sort(compareRoomIdentity).map((room) => room.roomId);
}

function canonicalPolicy(policy) {
  return JSON.stringify({
    contractVersion: CONTRACT_VERSION,
    fillMode: policy.fillMode,
    roomPriority: policy.roomPriority.slice(),
    roomPrioritySource: policy.roomPrioritySource,
  });
}

function settingsRevisionFor(policy) {
  return policy ? sha256(canonicalPolicy(policy)) : null;
}

function catalogFingerprint(rooms) {
  const rows = rooms.map((room) => ({
    roomId: room.roomId,
    roomCode: room.roomCode,
    roomName: room.roomName || '',
    house: room.house || '',
    active: room.active === true,
    capacity: room.capacity,
    roomType: room.roomType || '',
    genderStrategy: room.genderStrategy || '',
    canBeMatrimonial: room.canBeMatrimonial === true,
    sellingMode: room.sellingMode || 'shared',
    oftenUsedByOperator: room.oftenUsedByOperator === true,
    beds: (room.beds || []).map((bed) => ({
      bedId: bed.bedId,
      bedCode: bed.bedCode || '',
      bedNumber: bed.bedNumber == null ? null : bed.bedNumber,
      active: bed.active === true,
      sellable: bed.sellable === true,
    })).sort((a, b) => (a.bedId < b.bedId ? -1 : a.bedId > b.bedId ? 1 : 0)),
  })).sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0));
  return JSON.stringify(rows);
}

function catalogRevisionFor(rooms) {
  return sha256(catalogFingerprint(rooms));
}

function displayLabel(room) {
  if (room.roomNumber != null) return `Room ${room.roomNumber}`;
  return room.roomName || room.roomCode || 'Room';
}

function restrictionLabel(room) {
  const labels = [];
  const type = String(room.roomType || '').toLowerCase();
  if (room.canBeMatrimonial === true || type.includes('private') || type.includes('couple')) labels.push('Private/couple');
  if (room.oftenUsedByOperator === true || type.includes('operator')) labels.push('Operator');
  return labels.length ? labels.join(' · ') : null;
}

function roomGenderPresentation(room) {
  const type = String(room.roomType || '').trim().toLowerCase();
  const strategy = String(room.genderStrategy || '').trim().toLowerCase();
  let fromType = null;
  if (type === 'female_only') fromType = 'Female';
  else if (type === 'male_only') fromType = 'Male';
  else if (type === 'mixed' || type === 'matrimonial_or_mixed') fromType = 'Mixed';
  let fromStrategy = null;
  if (strategy.includes('female')) fromStrategy = 'Female';
  else if (strategy.includes('male')) fromStrategy = 'Male';
  else if (strategy === 'flexible' || strategy.includes('mixed')) fromStrategy = 'Mixed';
  const conflict = fromType && fromStrategy && fromType !== fromStrategy;
  if (!fromType || conflict) {
    return { genderLabel: 'Unspecified', reviewLabel: 'Needs review', restrictionLabel: restrictionLabel(room) };
  }
  return { genderLabel: fromType, reviewLabel: null, restrictionLabel: restrictionLabel(room) };
}

function genderLabelFromStrategy(value) {
  return roomGenderPresentation({ roomType: '', genderStrategy: value }).genderLabel;
}

// Deliberately narrow: changing any other type could erase a restriction encoded
// only in its type. Conflicting gender metadata on an ordinary room may be repaired.
function roomGenderEditable(room) {
  return !!room && ['female_only', 'male_only', 'mixed'].includes(room.roomType)
    && room.canBeMatrimonial === false && room.oftenUsedByOperator === false;
}

function projectRoom(room, rank) {
  return {
    roomId: room.roomId,
    roomCode: room.roomCode,
    roomNumber: room.roomNumber,
    roomName: room.roomName || '',
    house: room.house || '',
    capacity: room.capacity,
    active: room.active === true,
    rank: rank == null ? null : rank,
    staticWarnings: room.staticWarnings.slice(),
    label: displayLabel(room),
    numericLabel: room.roomNumber == null ? 'No numeric room number' : null,
    genderStrategy: room.genderStrategy || '',
    genderLabel: roomGenderPresentation(room).genderLabel,
    genderReview: roomGenderPresentation(room).reviewLabel,
    genderEditable: roomGenderEditable(room),
    sellingMode: restrictionLabel(room) || room.roomType === 'matrimonial_or_mixed' ? 'private' : (room.sellingMode || 'shared'),
    sellingModeEditable: roomGenderEditable(room),
    genderEditNote: roomGenderEditable(room) ? null : 'Read-only: special or unrecognized room type; private/couple and operator restrictions are preserved.',
    restrictionLabel: roomGenderPresentation(room).restrictionLabel,
    bedIds: (room.beds || []).map((bed) => bed.bedId),
  };
}

function sellableCapacity(beds) {
  return (beds || []).filter((bed) => bed.active === true && bed.sellable === true && bed.bedId).length;
}

function boolish(value) {
  return value === true || value === 'true' || value === 't' || value === 1;
}

function projectCatalogueRows(rows) {
  const byRoom = new Map();
  for (const row of rows || []) {
    const roomId = row.room_id == null ? '' : String(row.room_id).trim();
    if (!UUID_RE.test(roomId)) {
      return { ok: false, status: 503, error: 'missing_canonical_room_id' };
    }
    if (!byRoom.has(roomId)) {
      const roomCode = String(row.room_code == null ? '' : row.room_code).trim();
      if (!roomCode) return { ok: false, status: 503, error: 'inventory_unavailable' };
      byRoom.set(roomId, {
        roomId,
        roomCode,
        roomNumber: roomNumberFromCode(roomCode),
        roomName: row.room_name == null ? '' : String(row.room_name),
        house: row.house == null ? '' : String(row.house),
        roomType: row.room_type == null ? '' : String(row.room_type),
        sellingMode: row.selling_mode || 'shared',
        genderStrategy: row.gender_strategy == null ? '' : String(row.gender_strategy),
        canBeMatrimonial: boolish(row.can_be_matrimonial),
        oftenUsedByOperator: boolish(row.often_used_by_operator),
        active: boolish(row.room_active),
        beds: [],
        seenBeds: new Set(),
      });
    }
    const room = byRoom.get(roomId);
    if (row.bed_id == null || row.bed_id === '') continue;
    const bedId = String(row.bed_id).trim();
    if (!UUID_RE.test(bedId)) {
      return { ok: false, status: 503, error: 'missing_canonical_room_id' };
    }
    if (room.seenBeds.has(bedId)) continue;
    room.seenBeds.add(bedId);
    const bedNumber = row.bed_number == null || row.bed_number === '' ? null : Number(row.bed_number);
    room.beds.push({
      bedId,
      bedCode: row.bed_code == null ? '' : String(row.bed_code),
      bedNumber: Number.isSafeInteger(bedNumber) ? bedNumber : null,
      active: row.bed_active == null ? true : boolish(row.bed_active),
      sellable: row.bed_sellable == null ? true : boolish(row.bed_sellable),
    });
  }
  const rooms = [...byRoom.values()].map((room) => {
    const capacity = sellableCapacity(room.beds);
    const staticWarnings = [];
    if (!room.active) staticWarnings.push('room_inactive');
    if (capacity < 1) staticWarnings.push('no_sellable_beds');
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      roomNumber: room.roomNumber,
      roomName: room.roomName,
      house: room.house,
      roomType: room.roomType,
      sellingMode: room.sellingMode,
      genderStrategy: room.genderStrategy,
      canBeMatrimonial: room.canBeMatrimonial,
      oftenUsedByOperator: room.oftenUsedByOperator,
      active: room.active,
      capacity,
      beds: room.beds,
      staticWarnings,
    };
  });
  if (!rooms.length) return { ok: false, status: 503, error: 'inventory_unavailable' };
  return { ok: true, rooms };
}

function suggestedPolicy(rooms) {
  return {
    contractVersion: CONTRACT_VERSION,
    fillMode: 'house',
    roomPriority: numericRoomOrder(rooms),
    roomPrioritySource: 'default_numeric',
  };
}

function sameIdSet(left, right) {
  if (left.length !== right.length) return false;
  const want = new Set(right);
  return left.every((id) => want.has(id));
}

function reviewState(stored, rooms) {
  if (!stored) return { requiresReview: false, removedRoomIds: [], unrankedRoomIds: [] };
  const current = new Set(rooms.map((room) => room.roomId));
  const saved = stored.roomPriority;
  const removedRoomIds = saved.filter((id) => !current.has(id));
  const savedSet = new Set(saved);
  const unrankedRoomIds = rooms.map((room) => room.roomId).filter((id) => !savedSet.has(id));
  const numeric = numericRoomOrder(rooms);
  const numericStale = stored.roomPrioritySource === 'default_numeric'
    && removedRoomIds.length === 0
    && unrankedRoomIds.length === 0
    && stored.roomPriority.some((id, index) => id !== numeric[index]);
  return {
    requiresReview: removedRoomIds.length > 0 || unrankedRoomIds.length > 0 || numericStale,
    removedRoomIds,
    unrankedRoomIds,
    numericDefaultStale: numericStale,
  };
}

function reject(status, error) {
  return { ok: false, status, error };
}

function parseStoredPolicy(raw) {
  if (raw == null) return { ok: true, policy: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 409, error: 'unsupported_contract_version' };
  }
  if (raw.contractVersion !== CONTRACT_VERSION) {
    return { ok: false, status: 409, error: 'unsupported_contract_version' };
  }
  return validatePolicyShape(raw, null);
}

function validatePolicyShape(body, rooms) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(400, 'invalid_policy');
  if (body.contractVersion !== CONTRACT_VERSION) return reject(400, 'unsupported_contract_version');
  if (!FILL_MODES.includes(body.fillMode)) return reject(400, 'invalid_fill_mode');
  if (!PRIORITY_SOURCES.includes(body.roomPrioritySource)) return reject(400, 'invalid_priority_source');
  if (!Array.isArray(body.roomPriority) || body.roomPriority.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
    return reject(400, 'invalid_room_priority');
  }
  if (new Set(body.roomPriority).size !== body.roomPriority.length) return reject(400, 'duplicate_room_id');
  const policy = {
    contractVersion: CONTRACT_VERSION,
    fillMode: body.fillMode,
    roomPriority: body.roomPriority.slice(),
    roomPrioritySource: body.roomPrioritySource,
  };
  if (!rooms) return { ok: true, policy };
  const ids = rooms.map((room) => room.roomId);
  if (!sameIdSet(policy.roomPriority, ids)) return reject(400, 'incomplete_room_priority');
  if (policy.roomPrioritySource === 'default_numeric') {
    const numeric = numericRoomOrder(rooms);
    if (policy.roomPriority.some((id, index) => id !== numeric[index])) {
      return reject(400, 'source_order_mismatch');
    }
  }
  return { ok: true, policy };
}

function reasonText(code) {
  return REASON_TEXT[code] || code;
}

function reason(code) {
  return { code, text: reasonText(code) };
}

module.exports = {
  ACTIVATION_STATUS,
  CONTRACT_VERSION,
  FILL_MODES,
  PRIORITY_SOURCES,
  REASON_TEXT,
  SETTINGS_KEY,
  SUPPORTED_CLIENT_SLUG,
  UUID_RE,
  canonicalPolicy,
  catalogRevisionFor,
  compareRoomIdentity,
  displayLabel,
  genderLabelFromStrategy,
  roomGenderPresentation,
  roomGenderEditable,
  numericRoomOrder,
  parseStoredPolicy,
  projectCatalogueRows,
  projectRoom,
  reason,
  reasonText,
  reviewState,
  roomNumberFromCode,
  settingsRevisionFor,
  suggestedPolicy,
  validatePolicyShape,
};
