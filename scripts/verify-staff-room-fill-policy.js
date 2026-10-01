'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  numericRoomOrder,
  projectCatalogueRows,
  roomNumberFromCode,
  suggestedPolicy,
  validatePolicyShape,
} = require('./lib/staff-room-fill-policy');
const { previewRoomFill } = require('./lib/staff-room-fill-preview');

function room(id, code, capacity, extras) {
  const beds = [];
  for (let i = 0; i < capacity; i += 1) {
    beds.push({
      bedId: `${id.slice(0, -2)}${String(i + 1).padStart(2, '0')}`,
      bedCode: `${code}-B${i + 1}`,
      bedNumber: i + 1,
      active: true,
      sellable: true,
    });
  }
  return {
    roomId: id,
    roomCode: code,
    roomNumber: roomNumberFromCode(code),
    roomName: code,
    house: 'somo',
    roomType: 'mixed',
    genderStrategy: 'mixed',
    canBeMatrimonial: false,
    oftenUsedByOperator: false,
    active: true,
    capacity,
    beds,
    ...(extras || {}),
  };
}

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const R10 = '10101010-1010-4010-8010-101010101010';

test('numeric order is R1, R2, R10, then nonnumeric', () => {
  const rooms = [
    room(R10, 'R10', 4),
    room(R2, 'R2', 4),
    room('33333333-3333-4333-8333-333333333333', 'LOFT', 2),
    room(R1, 'R1', 4),
  ];
  assert.deepEqual(numericRoomOrder(rooms), [R1, R2, R10, '33333333-3333-4333-8333-333333333333']);
  assert.equal(roomNumberFromCode('LOFT'), null);
  assert.equal(roomNumberFromCode('R2A'), null);
});

test('default source must match the server numeric order', () => {
  const rooms = [room(R1, 'R1', 4), room(R2, 'R2', 4), room(R10, 'R10', 4)];
  const bad = validatePolicyShape({
    contractVersion: 1,
    fillMode: 'house',
    roomPriority: [R10, R2, R1],
    roomPrioritySource: 'default_numeric',
  }, rooms);
  assert.equal(bad.ok, false);
  const good = validatePolicyShape({ ...suggestedPolicy(rooms) }, rooms);
  assert.equal(good.ok, true);
});

test('null room ids are rejected and never replaced', () => {
  const projected = projectCatalogueRows([{ room_id: null, room_code: 'R1', room_active: true }]);
  assert.equal(projected.ok, false);
  assert.equal(projected.error, 'missing_canonical_room_id');
});

function place(mode, order, occupancy, partySize, extras) {
  const rooms = [room(R1, 'R1', 4), room(R2, 'R2', 4), room(R10, 'R10', 4)];
  return previewRoomFill({
    catalogue: rooms,
    occupancy: occupancy || [],
    policy: { contractVersion: 1, fillMode: mode, roomPriority: order, roomPrioritySource: 'custom' },
    request: { checkIn: '2026-10-10', checkOut: '2026-10-11', partySize, groupGender: 'unknown', ...(extras || {}) },
  });
}

function occ(roomId, count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      bedId: `${roomId.slice(0, -2)}${String(i + 1).padStart(2, '0')}`,
      roomId,
      start: '2026-10-10',
      end: '2026-10-11',
      assignmentType: 'guest',
    });
  }
  return rows;
}

test('O1 house balances and room packs the first room', () => {
  let houseOcc = [];
  const house = [];
  for (let i = 0; i < 4; i += 1) {
    const result = place('house', [R1, R2, R10], houseOcc, 1);
    assert.equal(result.decision.status, 'placed');
    const id = result.decision.selected[0].roomId;
    house.push(id);
    houseOcc = houseOcc.concat(occ(id, 1));
  }
  assert.deepEqual(house, [R1, R2, R10, R1]);
  let roomOcc = [];
  const packed = [];
  for (let i = 0; i < 4; i += 1) {
    const result = place('room', [R1, R2, R10], roomOcc, 1);
    packed.push(result.decision.selected[0].roomId);
    roomOcc = roomOcc.concat(occ(R1, 1));
  }
  assert.deepEqual(packed, [R1, R1, R1, R1]);
});

test('O2 and O3 discriminate house from room', () => {
  const o2house = place('house', [R1, R2, R10], occ(R1, 3), 1);
  const o2room = place('room', [R1, R2, R10], occ(R1, 3), 1);
  assert.equal(o2house.decision.selected[0].roomId, R2);
  assert.equal(o2room.decision.selected[0].roomId, R1);
  const small = [room(R1, 'R1', 2), room(R2, 'R2', 6)];
  const o3 = previewRoomFill({
    catalogue: small,
    occupancy: [],
    policy: { contractVersion: 1, fillMode: 'house', roomPriority: [R1, R2], roomPrioritySource: 'custom' },
    request: { checkIn: '2026-10-10', checkOut: '2026-10-11', partySize: 1, groupGender: 'unknown' },
  });
  const o3room = previewRoomFill({
    catalogue: small,
    occupancy: [],
    policy: { contractVersion: 1, fillMode: 'room', roomPriority: [R1, R2], roomPrioritySource: 'custom' },
    request: { checkIn: '2026-10-10', checkOut: '2026-10-11', partySize: 1, groupGender: 'unknown' },
  });
  assert.equal(o3.decision.selected[0].roomId, R2);
  assert.equal(o3room.decision.selected[0].roomId, R1);
});

test('O4 tie uses custom priority in both modes', () => {
  for (const mode of ['house', 'room']) {
    const result = place(mode, [R10, R2, R1], [], 1);
    assert.equal(result.decision.selected[0].roomId, R10);
  }
});

test('O6 keeps the party together and O7 does not invent a split', () => {
  const rooms = [room(R1, 'R1', 1), room(R2, 'R2', 3)];
  const together = previewRoomFill({
    catalogue: rooms,
    occupancy: [],
    policy: { contractVersion: 1, fillMode: 'room', roomPriority: [R1, R2], roomPrioritySource: 'custom' },
    request: { checkIn: '2026-10-10', checkOut: '2026-10-11', partySize: 2, groupGender: 'mixed', roomPreference: 'mixed' },
  });
  assert.equal(together.decision.selected[0].roomId, R2);
  assert.ok(together.decision.rationale.some((item) => item.code === 'party_kept_together'));
  assert.ok(together.decision.rooms.find((item) => item.roomId === R1).reasons.some((item) => item.code === 'insufficient_party_capacity'));
  const blocked = previewRoomFill({
    catalogue: [room(R1, 'R1', 1), room(R2, 'R2', 1)],
    occupancy: [],
    policy: { contractVersion: 1, fillMode: 'room', roomPriority: [R1, R2], roomPrioritySource: 'custom' },
    request: { checkIn: '2026-10-10', checkOut: '2026-10-11', partySize: 2, groupGender: 'mixed', roomPreference: 'mixed' },
  });
  assert.equal(blocked.decision.status, 'no_fit');
  assert.equal(blocked.decision.selected.length, 0);
  assert.ok(blocked.decision.rationale.some((item) => item.code === 'split_permission_required'));
});

test('O8 uses peak occupancy, not the average alone', () => {
  const rooms = [room(R1, 'R1', 4), room(R2, 'R2', 4)];
  const occupancy = [1, 2, 3].map((n) => ({
    bedId: `${R1.slice(0, -2)}${String(n).padStart(2, '0')}`,
    roomId: R1,
    start: '2026-10-11',
    end: '2026-10-12',
    assignmentType: 'guest',
  })).concat([{
    bedId: `${R2.slice(0, -2)}01`,
    roomId: R2,
    start: '2026-10-10',
    end: '2026-10-12',
    assignmentType: 'guest',
  }]);
  const house = previewRoomFill({
    catalogue: rooms,
    occupancy,
    policy: { contractVersion: 1, fillMode: 'house', roomPriority: [R1, R2], roomPrioritySource: 'custom' },
    request: { checkIn: '2026-10-10', checkOut: '2026-10-12', partySize: 1, groupGender: 'unknown' },
  });
  assert.equal(house.decision.selected[0].roomId, R2);
});

test('O9 does not invent a mid-stay bed switch', () => {
  const id = R1;
  const beds = [
    { bedId: `${id.slice(0, -2)}01`, bedCode: 'R1-B1', bedNumber: 1, active: true, sellable: true },
    { bedId: `${id.slice(0, -2)}02`, bedCode: 'R1-B2', bedNumber: 2, active: true, sellable: true },
  ];
  const one = room(id, 'R1', 0, { beds, capacity: 2 });
  const result = previewRoomFill({
    catalogue: [one, room(R2, 'R2', 2)],
    occupancy: [
      { bedId: beds[0].bedId, roomId: id, start: '2026-10-10', end: '2026-10-11', assignmentType: 'guest' },
      { bedId: beds[1].bedId, roomId: id, start: '2026-10-11', end: '2026-10-12', assignmentType: 'guest' },
    ],
    policy: { contractVersion: 1, fillMode: 'room', roomPriority: [R1, R2], roomPrioritySource: 'custom' },
    request: { checkIn: '2026-10-10', checkOut: '2026-10-12', partySize: 1, groupGender: 'unknown' },
  });
  assert.equal(result.decision.selected[0].roomId, R2);
  assert.ok(result.decision.rooms.find((item) => item.roomId === R1).reasons.some((item) => item.code === 'no_continuous_beds'));
});

test('O10 never selects an incompatible gendered room', () => {
  const female = room(R1, 'R1', 4, { roomType: 'female_only', genderStrategy: 'female' });
  const mixed = room(R2, 'R2', 4, { roomType: 'mixed', genderStrategy: 'mixed' });
  const result = previewRoomFill({
    catalogue: [female, mixed],
    occupancy: [],
    policy: { contractVersion: 1, fillMode: 'room', roomPriority: [R1, R2], roomPrioritySource: 'custom' },
    request: { checkIn: '2026-10-10', checkOut: '2026-10-11', partySize: 1, groupGender: 'male' },
  });
  assert.equal(result.decision.selected[0].roomId, R2);
  assert.ok(result.decision.rooms.find((item) => item.roomId === R1).reasons.some((item) => item.code === 'incompatible_room_type'));
});

test('O11 reversed arrays do not change the decision digest', () => {
  const rooms = [room(R1, 'R1', 4), room(R2, 'R2', 4)];
  const request = { checkIn: '2026-10-10', checkOut: '2026-10-11', partySize: 1, groupGender: 'unknown' };
  const policy = { contractVersion: 1, fillMode: 'house', roomPriority: [R1, R2], roomPrioritySource: 'custom' };
  const forward = previewRoomFill({ catalogue: rooms, occupancy: [], policy, request });
  const reverse = previewRoomFill({
    catalogue: rooms.slice().reverse().map((item) => ({ ...item, beds: item.beds.slice().reverse() })),
    occupancy: [],
    policy,
    request,
  });
  assert.equal(forward.decision.digest, reverse.decision.digest);
  assert.equal(forward.decision.reservationCreated, false);
});
