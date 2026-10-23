'use strict';

const assert = require('node:assert/strict');
const api = require('./index');

function memory(seed = {}) {
  const tables = structuredClone(seed);
  return {
    async read(table, filter) { return (tables[table] || []).filter((row) => !filter || Object.entries(filter).every(([k, v]) => row[k] === v)).map((row) => structuredClone(row)); },
    async write(table, row) { tables[table] ||= []; const saved = { id: row.id || `${table}-${tables[table].length + 1}`, ...structuredClone(row) }; tables[table].push(saved); return structuredClone(saved); },
    async update(table, id, patch) { const row = (tables[table] || []).find((item) => item.id === id); if (!row) return null; Object.assign(row, structuredClone(patch)); return structuredClone(row); },
    tables,
  };
}

async function main() {
  const names = ['checkAvailability', 'findRooms', 'getPricingCatalog', 'quote', 'holdBeds', 'book', 'getBooking', 'recoverOperation', 'releaseHold', 'handoffToHuman'];
  names.forEach((name) => assert.equal(typeof api[name], 'function', name));

  const pg = memory({
    beds: [{ id: 'a', roomId: 'r10', available: true }, { id: 'b', roomId: 'r10', available: true }],
    rooms: [{ id: 'r10', beds: ['a', 'b'] }], pricing: [{ totalCents: 20000, depositCents: 8000, source: 'staff_pricing' }],
    catalog: [{ id: 'surf', totalCents: 20000 }], sessions: [{ id: 'luna-v3:s1', tenant_id: 'wolfhouse-somo', guest: 'A' }],
    authority: [{ totalCents: 20000, depositCents: 8000 }], holds: [], bookings: [], operations: [], handoffs: [], sends: [],
  });
  assert.equal((await api.checkAvailability(pg, {})).availableCount, 2);
  assert.deepEqual((await api.findRooms(pg, {})).roomIds, ['r10']);
  assert.equal((await api.quote(pg, {})).totalCents, 20000);
  await assert.rejects(() => api.quote(pg, { selection: { totalCents: 1 } }), /authority/);

  const held = await api.holdBeds(pg, { requestedBeds: ['a', 'b'], assignments: [{ bedId: 'a' }, { bedId: 'b' }], operation_key: 'hold-1', session_id: 'luna-v3:s1' });
  assert.equal(held.held, true); assert.equal(pg.tables.holds.length, 1);
  assert.deepEqual(await api.holdBeds(pg, { requestedBeds: ['a', 'b'], assignments: [{ bedId: 'a' }, { bedId: 'b' }], operation_key: 'hold-1', session_id: 'luna-v3:s1' }), held);
  const booked = await api.book(pg, { holdId: held.holdId, operation_key: 'book-1', session_id: 'luna-v3:s1' });
  assert.equal(booked.status, 'confirmed'); assert.equal(booked.paymentStatus, 'unpaid'); assert.equal(pg.tables.bookings.length, 1);
  assert.equal((await api.getBooking(pg, { session_id: 'luna-v3:s1' })).bookingId, booked.bookingId);
  const handoff = await api.handoffToHuman(pg, { reason: 'help', operation_key: 'human-1', session_id: 'luna-v3:s1' });
  assert.equal(handoff.sent, false); assert.equal(handoff.staffAlertAllowed, false); assert.equal(pg.tables.sends.length, 0);
  console.log('V3 phase-1 operation proofs passed (10 cards)');
}
main().catch((error) => { console.error(error.stack || error); process.exit(1); });
