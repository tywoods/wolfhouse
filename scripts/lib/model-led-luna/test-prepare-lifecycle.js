'use strict';
const assert = require('node:assert/strict');
const { createCheckQuoteBook, publicFailure } = require('./v3-booking-flow');
const { normalizeQuoteRequest } = require('./staff-request-contract');

function harness({ rooms = true, quoteFailure = null, throwCatalog = false } = {}) {
  const attempts = new Map(); let executions = 0;
  const pg = { async query(sql, params = []) {
    if (/INSERT INTO luna_v3_prepare_attempts/.test(sql)) {
      const key = params[2];
      if (attempts.has(key)) return { rows: [] };
      const row = { id: `attempt-${attempts.size + 1}`, request_fingerprint: params[3], outcome: 'started', receipt: null };
      attempts.set(key, row); return { rows: [row] };
    }
    if (/FROM luna_v3_prepare_attempts/.test(sql)) return { rows: [attempts.get(params[2])].filter(Boolean) };
    if (/UPDATE luna_v3_prepare_attempts/.test(sql)) {
      const row = [...attempts.values()].find((value) => value.id === params[0]);
      if (row && row.outcome === 'started') { row.receipt = JSON.parse(params[1]); row.outcome = params[2]; }
      return { rows: [] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  } };
  const deps = {
    async getPricingCatalog() { if (throwCatalog) throw new Error('transport'); return { ok: true, items: [
      { item_type: 'package', item_code: 'package_none', label: 'Accommodation only' },
    ] }; },
    async findRooms() { executions += 1; return rooms ? { ok: true, rooms: [{ roomCode: 'R1', bedOptions: [{ code: 'B1' }] }] } : { ok: true, rooms: [] }; },
    async quote() { return quoteFailure || { ok: true, totalCents: 10000, depositCents: 5000, remainingCents: 5000, currency: 'EUR', lineItems: [], perPerson: [] }; },
  };
  return { flow: createCheckQuoteBook(deps), pg, attempts, executions: () => executions };
}
const input = { action: 'prepare', purpose: 'quote', check_in: '2027-01-01', check_out: '2027-01-03',
  guests: [{}], room: { kind: 'shared' }, package: { code: 'package_none' }, add_ons: [] };
const context = (event) => ({ turnId: `turn:${event}`, sessionId: 'session', principalId: 'principal', authenticatedInboundEventId: event });

async function run() {
  const catalog = { items: [{ item_type: 'package', item_code: 'package_none', label: 'Accommodation only' }] };
  assert.equal(normalizeQuoteRequest({ ...input, guests: [] }, catalog, [], {}).code, 'guests_required', 'missing guest facts refuse specifically');
  assert.equal(publicFailure({ code: 'staff_package_ineligible' }).message,
    'That package is not eligible for the requested stay.', 'ineligible choice is distinguished');
  assert.equal(publicFailure({ code: 'exact_bed_selection_required' }).message,
    'No eligible beds are available for the requested stay.', 'no-bed refusal is specific');
  const execute = async (h, value, event) => h.flow(h.pg, value, context(event));

  const refusal = harness({ rooms: false });
  assert(refusal.pg, 'harness must expose pg');
  const event1 = '11111111-1111-4111-8111-111111111111';
  const r1 = await execute(refusal, input, event1);
  assert.equal(r1.code, 'requested_room_unavailable');
  assert.equal(r1.outcome, 'rejected');
  assert.deepEqual(await execute(refusal, input, event1), r1, 'same request replays refusal');
  const changed = await execute(refusal, { ...input, check_out: '2027-01-04' }, event1);
  assert.equal(changed.code, 'prepare_event_payload_mismatch');
  const r2 = await execute(refusal, input, '22222222-2222-4222-8222-222222222222');
  assert.equal(r2.code, 'requested_room_unavailable', 'new inbound event gets a new attempt');

  const success = harness({});
  const [a, b] = await Promise.all([execute(success, input, event1), execute(success, input, event1)]);
  assert.equal([a, b].filter((row) => row.ok === true).length, 1);
  assert.equal([a, b].some((row) => row.code === 'prepare_event_in_progress'), true, 'parallel second prepare is blocked');
  assert.equal((await execute(success, input, event1)).ok, true, 'completed success replays after restart');

  const unknown = harness({ throwCatalog: true });
  const u1 = await execute(unknown, input, event1);
  assert.equal(u1.outcome, 'unknown');
  assert.deepEqual(await execute(unknown, input, event1), u1, 'unknown is terminal and replays');

  assert.equal(publicFailure({ code: 'staff_pricing_unavailable', message: 'Rental wetsuit has no configured price.',
    field_errors: [{ path: 'add_ons[0]', code: 'staff_pricing_unavailable', message: 'Rental wetsuit has no configured price.' }] }).field_errors[0].message,
  'Rental wetsuit has no configured price.', 'specific missing-price reason is preserved');
  console.log('persisted inbound-event prepare lifecycle tests passed');
}
run().catch((error) => { console.error(error.stack || error); process.exit(1); });
