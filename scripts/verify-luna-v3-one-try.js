'use strict';
const assert = require('node:assert/strict');
const { assertSafeToolRequest, TOOL_CONTRACTS } = require('./lib/model-led-luna/contracts');
const { createCheckQuoteBook, publicFailure } = require('./lib/model-led-luna/v3-booking-flow');

const typedPricingFailure = {
  type: 'pricing_failure', price_kind: 'rental',
  choice: { item_type: 'rental', item_code: 'wetsuit_rental', season_code: null },
  recovery_action: 'ask_staff_to_configure_add_on_price',
};
assert.deepEqual(publicFailure({
  code: 'staff_add_on_price_missing', classification: 'configuration',
  next_step: 'ask_staff_to_configure_add_on_price', pricing_failure: typedPricingFailure,
}).pricing_failure, typedPricingFailure);

assert.equal(TOOL_CONTRACTS.check_quote_book.path, '/staff/bot/luna-v3/check-quote-book');
assert.throws(() => assertSafeToolRequest('check_quote_book', { action: 'confirm', offer_reference: 'not-an-id' }), /valid public/);
assert.throws(() => assertSafeToolRequest('check_quote_book', { action: 'prepare', purpose: 'offer', check_in: '2027-03-01', check_out: '2027-03-08', guests: [{ name: 'A' }, { name: 'B' }], room: { kind: 'private' }, package: { name: 'none' }, add_ons: [] }), /payment arrangement/);
assert.doesNotThrow(() => assertSafeToolRequest('check_quote_book', {
  action: 'prepare', purpose: 'offer', check_in: '2027-03-01', check_out: '2027-03-08',
  guests: [{ name: 'A', gender: 'female' }], room: { kind: 'exact', beds: ['BED-1'], together: 'required' },
  package: { name: 'none' }, add_ons: [], payment: { arrangement: 'separately' },
}));

const calls = [];
const deps = {
  findRooms: async () => ({ ok: true, rooms: [{ roomId: 'R1', bedOptions: [{ code: 'BED-1' }] }] }),
  getPricingCatalog: async () => ({ ok: true, items: [{ item_type: 'deposit', item_code: 'custom_or_short_stay', label: 'Custom Or Short Stay' }] }),
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
    package: { name: 'Custom Or Short Stay' }, add_ons: [], payment: { arrangement: 'separately' },
  }, { sessionId: 'luna-v3:aaaaaaaaaaaaaaaaaaaaaaaa', principalId: 'p', turnId: 'turn:00000001' });
  assert.equal(result.state, 'offer');
  assert.match(result.offer_reference, /^offer_/);
  assert.equal('holdId' in result, false, 'internal hold UUID must not cross public result');
  assert.equal(calls.filter(([name]) => name === 'quote').length, 1);
  assert.equal(calls.filter(([name]) => name === 'hold').length, 1);
  assert.equal(calls[0][1].operation_key.startsWith('one-try:'), true);
  console.log('luna v3 one-try public flow: PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
