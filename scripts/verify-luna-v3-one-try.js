'use strict';
const assert = require('node:assert/strict');
const { assertSafeToolRequest, TOOL_CONTRACTS } = require('./lib/model-led-luna/contracts');
const { createCheckQuoteBook } = require('./lib/model-led-luna/v3-booking-flow');

assert.equal(TOOL_CONTRACTS.check_quote_book.path, '/staff/bot/luna-v3/check-quote-book');
assert.throws(() => assertSafeToolRequest('check_quote_book', { action: 'confirm', offer_reference: 'not-an-id' }), /valid public/);
assert.throws(() => assertSafeToolRequest('check_quote_book', { action: 'prepare', purpose: 'offer', check_in: '2027-03-01', check_out: '2027-03-08', guests: [{ name: 'A' }, { name: 'B' }], room: { kind: 'private' }, package: { name: 'none' } }), /payment arrangement/);
assert.doesNotThrow(() => assertSafeToolRequest('check_quote_book', {
  action: 'prepare', purpose: 'offer', check_in: '2027-03-01', check_out: '2027-03-08',
  guests: [{ name: 'A', gender: 'female' }], room: { kind: 'exact', beds: ['BED-1'], together: 'required' },
  package: { name: 'none' }, add_ons: [], payment: { arrangement: 'separately' },
}));

const calls = [];
const deps = {
  findRooms: async () => ({ ok: true, rooms: [{ roomId: 'R1', bedOptions: [{ code: 'BED-1' }] }] }),
  getPricingCatalog: async () => ({ ok: true, packages: [{ code: 'package_none', name: 'none' }], services: [], rentals: [] }),
  quote: async (_pg, input) => { calls.push(['quote', input]); return { ok: true, quote: { totalCents: 10000 }, holdInput: { check_in: input.check_in, check_out: input.check_out, guests: input.guests, assignments: [{ bed_code: 'BED-1', guest_name: 'A', package_code: 'package_none' }], quoted_selection: 'quote-rev' } }; },
  holdBeds: async (_pg, input) => { calls.push(['hold', input]); return { ok: true, holdId: '11111111-1111-4111-8111-111111111111', expiresAt: '2027-03-01T12:15:00Z', assignments: [{ bedCode: 'BED-1', packageCode: 'package_none' }] }; },
  releaseHold: async () => ({ ok: true }),
  book: async () => ({ ok: true, bookingCode: 'WH-TEST' }),
};
const pg = { async query(sql) {
  if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
  if (/SELECT h.expires_at,h.state,sel.quote/.test(sql)) return { rows: [] };
  if (/SELECT s.id,s.client_id/.test(sql)) return { rows: [{ id: 'session-db', client_id: 'client-db' }] };
  if (/UPDATE luna_v3_holds/.test(sql) || /UPDATE luna_v3_selections/.test(sql)) return { rows: [{ id: 'hold-db' }] };
  if (/INSERT INTO luna_v3_offer_turns/.test(sql)) return { rows: [] };
  throw new Error(`unexpected SQL: ${sql}`);
} };
const run = createCheckQuoteBook(deps);
(async () => {
  const result = await run(pg, {
    action: 'prepare', purpose: 'offer', check_in: '2027-03-01', check_out: '2027-03-08',
    guests: [{ name: 'A', gender: 'female' }], room: { kind: 'exact', beds: ['BED-1'], together: 'required' },
    package: { name: 'none' }, add_ons: [], payment: { arrangement: 'separately' },
  }, { sessionId: 'luna-v3:aaaaaaaaaaaaaaaaaaaaaaaa', principalId: 'p', turnId: 'turn:00000001' });
  assert.equal(result.state, 'offer');
  assert.match(result.offer_reference, /^offer_/);
  assert.equal('holdId' in result, false, 'internal hold UUID must not cross public result');
  assert.equal(calls.filter(([name]) => name === 'quote').length, 1);
  assert.equal(calls.filter(([name]) => name === 'hold').length, 1);
  assert.equal(calls[0][1].operation_key.startsWith('one-try:'), true);

  // Behaviour: a stay-only guest can add dated board and wetsuit rentals and
  // receive the complete Staff quote on the first prepare attempt.
  const rentalCalls = [];
  const rentalRun = createCheckQuoteBook({
    ...deps,
    getPricingCatalog: async () => ({
      ok: true,
      items: [
        { item_type: 'deposit', item_code: 'custom_or_short_stay', label: 'Custom Or Short Stay' },
        { item_type: 'rental', item_code: 'soft_top', label: 'Soft-top surfboard rental' },
        { item_type: 'rental', item_code: 'wetsuit', label: 'Wetsuit rental' },
      ],
    }),
    quote: async (_pg, input) => {
      rentalCalls.push(input);
      return { ok: true, totalCents: 25000, depositCents: 10000, remainingCents: 15000, currency: 'EUR', lineItems: [], perPerson: [] };
    },
  });
  const rentalDates = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
  const rentalResult = await rentalRun(pg, {
    action: 'prepare', purpose: 'quote', check_in: '2026-11-18', check_out: '2026-11-23',
    guests: [{ name: 'Tom' }], room: { kind: 'shared' }, package: { name: 'stay only' },
    add_ons: [
      { name: 'Soft-top surfboard rental', quantity: 1, days: 5, dates: rentalDates },
      { name: 'Wetsuit rental', quantity: 1, days: 5, dates: rentalDates },
    ],
  }, { sessionId: 'luna-v3:stay-rental-first-try', principalId: 'p', turnId: 'turn:stay-rental-first-try' });
  assert.equal(rentalResult.state, 'quote', JSON.stringify(rentalResult));
  assert.equal(rentalCalls.length, 1, 'stay+rental must quote in one Staff attempt');
  assert.equal(rentalCalls[0].package_id, 'package_none');
  assert.deepEqual(rentalCalls[0].add_ons, [
    { code: 'soft_top', dates: rentalDates, days: 5, quantity: 1 },
    { code: 'wetsuit', dates: rentalDates, days: 5, quantity: 1 },
  ]);
  console.log('luna v3 one-try public flow: PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
