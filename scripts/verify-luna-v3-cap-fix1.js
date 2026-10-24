'use strict';
const assert = require('node:assert/strict');
const { createCheckQuoteBook, replyShowsPrice } = require('./lib/model-led-luna/v3-booking-flow');
const { LUNA_V3_ROUTE_TO_TOOL } = require('./lib/model-led-luna/staff-routes');
const { assertSafeToolRequest } = require('./lib/model-led-luna/contracts');

const context = { sessionId: 'luna-v3:aaaaaaaaaaaaaaaaaaaaaaaa', principalId: 'p', turnId: 'turn:cap-fix-1' };
const input = {
  action: 'prepare', purpose: 'offer', check_in: '2027-03-01', check_out: '2027-03-08',
  guests: [{ name: 'A', explicit_gender: 'female' }], room: { kind: 'women_only', beds: ['BED-1'], together: 'not_required' },
  package: { name: 'Malibu' },
  add_ons: [{ code: 'board', quantity: 3, requested_dates: ['2027-03-02'] }],
  payment: { arrangement: 'separately' },
};

let observedPreferences;
let observedAddOns;
function deps(overrides = {}) {
  return {
    findRooms: async (_pg, args) => { observedPreferences = args.preferences; return { ok: true, rooms: [{ roomId: 'R1', bedOptions: [{ code: 'BED-1' }] }] }; },
    getPricingCatalog: async () => ({ ok: true, items: [
      { item_type: 'package', item_code: 'malibu', label: 'Malibu', description: 'Stay and surf', metadata: { includes: ['bed', 'lessons'] } },
      { item_type: 'rental', item_code: 'board', label: 'Board rental' },
    ] }),
    quote: async (_pg, args) => { observedAddOns = args.add_ons; return { ok: true, totalCents: 12345, depositCents: 3000, remainingCents: 9345, currency: 'EUR',
      lineItems: [{ code: 'malibu', amountCents: 12345 }], perPerson: [{ guest_number: 1, total_cents: 12345 }],
      holdInput: { check_in: input.check_in, check_out: input.check_out, guests: input.guests,
        assignments: [{ bed_code: 'BED-1', guest_name: 'A', package_code: 'malibu' }], quoted_selection: 'quote-rev' } }; },
    holdBeds: async () => ({ ok: true, holdId: '11111111-1111-4111-8111-111111111111', expiresAt: '2027-03-01T12:15:00Z',
      assignments: [{ bed_code: 'BED-1', guest_name: 'A', package_code: 'malibu' }] }),
    releaseHold: async () => ({ ok: true }),
    book: async () => ({ ok: true, bookingCode: 'WH-TEST', status: 'confirmed', paymentStatus: 'unpaid' }),
    ...overrides,
  };
}

async function testCompleteOffer() {
  const pg = { async query(sql) {
    if (sql.startsWith('BEGIN') || ['COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (/SELECT s.id,s.client_id/.test(sql)) return { rows: [{ id: 'session-db', client_id: 'client-db' }] };
    if (/UPDATE luna_v3_holds/.test(sql)) return { rows: [{ id: 'hold-db' }] };
    if (/INSERT INTO luna_v3_offer_turns/.test(sql)) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  const result = await createCheckQuoteBook(deps())(pg, input, context);
  assert.equal(result.quote.totalCents, 12345);
  assert.equal(result.quote.currency, 'EUR');
  assert.equal(result.guests[0].bed, 'BED-1');
  assert.equal(result.guests[0].package, 'malibu');
  assert.deepEqual(result.package_details, { code: 'malibu', name: 'Malibu', description: 'Stay and surf', includes: ['bed', 'lessons'] });
  assert.deepEqual(observedPreferences, { room_type: 'female', room_preference: undefined, keep_together: false,
    group_gender: 'female', guests: [{ name: 'A', explicit_gender: 'female' }] });
  assert.deepEqual(observedAddOns, [{ code: 'board', dates: ['2027-03-02'], days: 1, quantity: 3 }]);
}

async function testFailedOfferWriteRollsBackHold() {
  let released = 0;
  const pg = { async query(sql) {
    if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') return { rows: [] };
    if (/SELECT s.id,s.client_id/.test(sql)) return { rows: [{ id: 'session-db', client_id: 'client-db' }] };
    if (/UPDATE luna_v3_holds/.test(sql)) return { rows: [{ id: 'hold-db' }] };
    if (/INSERT INTO luna_v3_offer_turns/.test(sql)) throw new Error('offer write failed');
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  await assert.rejects(() => createCheckQuoteBook(deps({ releaseHold: async () => { released += 1; return { ok: true }; } }))(pg, input, context), /offer write failed/);
  assert.equal(released, 0, 'same-transaction hold needs no fallible compensation call');
}

async function main() {
  assert.equal(replyShowsPrice('The offer is €123.45.', 12345, 'EUR'), true);
  assert.equal(replyShowsPrice('An unrelated larger amount is €1123.45.', 12345, 'EUR'), false);
  assert.equal(LUNA_V3_ROUTE_TO_TOOL['/staff/bot/luna-v3/book'], undefined, 'legacy public book route must be closed');
  assert.doesNotThrow(() => assertSafeToolRequest('check_quote_book', input));
  await testCompleteOffer();
  await testFailedOfferWriteRollsBackHold();
  console.log('luna v3 Cap FIX1 focused regressions: PASS');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
