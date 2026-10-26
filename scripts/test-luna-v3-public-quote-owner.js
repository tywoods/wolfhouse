'use strict';
// Executable bridge: obtain public results through the real prepare owner path.
const { createCheckQuoteBook } = require('./lib/model-led-luna/v3-booking-flow');

function pgForPrepare() {
  let attempt;
  return { async query(sql, params = []) {
    if (/INSERT INTO luna_v3_prepare_attempts/.test(sql)) {
      attempt = { id: `attempt-${Math.random()}`, request_fingerprint: params[3], outcome: 'started', receipt: null,
        lease_expires_at: '2999-01-01T00:00:00Z' };
      return { rows: [attempt] };
    }
    if (/UPDATE luna_v3_prepare_attempts/.test(sql)) {
      if (/lease_expires_at=now\(\)\+interval/.test(sql)) return { rows: [{ id: attempt.id }] };
      if (/SET owner_released_at=COALESCE/.test(sql)) return { rows: [] };
      attempt.receipt = JSON.parse(params[1]);
      return { rows: [{ id: attempt.id, receipt: attempt.receipt }] };
    }
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  } };
}

const catalog = { ok: true, items: [
  { item_type: 'package', item_code: 'malibu', label: 'Malibu', description: 'Stay and surf',
    metadata: { includes: ['bed', 'breakfast'], terms: ['lessons subject to availability'] } },
  { item_type: 'rental', item_code: 'board', label: 'Board rental' },
  { item_type: 'service', item_code: 'group_lesson', label: 'Group lesson' },
] };
function deps(input, totalCents) {
  return {
    getPricingCatalog: async () => catalog,
    findRooms: async () => ({ ok: true, rooms: [{ roomId: 'R1', bedOptions: input.guests.map((_, i) => ({ code: `BED-${i + 1}` })) }] }),
    quote: async (_pg, quoteInput) => ({ ok: true, totalCents, depositCents: 10000, remainingCents: totalCents - 10000,
      currency: 'EUR', lineItems: [{ code: 'stay', amountCents: totalCents }], perPerson: [], quoteInput }),
  };
}
async function prepare(input, suffix, total) {
  const context = { sessionId: `luna-v3:${'a'.repeat(23)}${suffix}`, principalId: 'p', turnId: `turn:${suffix}`,
    authenticatedInboundEventId: `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}` };
  return createCheckQuoteBook(deps(input, total))(pgForPrepare(), input, context);
}
(async () => {
  const singleInput = { action: 'prepare', purpose: 'quote', check_in: '2027-06-01', check_out: '2027-06-08',
    guests: [{ name: 'Alex' }], room: { kind: 'shared' }, package: { code: 'package_none' }, add_ons: [] };
  const multiInput = { action: 'prepare', purpose: 'quote', check_in: '2027-06-01', check_out: '2027-06-08',
    guests: [{ name: 'Alex' }, { name: 'Sam' }], room: { kind: 'shared' },
    package: { per_guest: [{ guest: 1, code: 'malibu' }, { guest: 2, code: 'package_none' }] },
    add_ons: [{ code: 'board', quantity: 1, people: ['Alex'], dates: ['2027-06-02'] },
      { code: 'group_lesson', quantity: 2, days: 1, people: ['Alex', 'Sam'], requested_dates: ['2027-06-03'] }] };
  process.stdout.write(JSON.stringify({
    single: { input: singleInput, result: await prepare(singleInput, '1', 12345) },
    multi: { input: multiInput, result: await prepare(multiInput, '2', 30000) },
  }));
})().catch((error) => { console.error(error); process.exit(1); });
