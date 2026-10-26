'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCheckQuoteBook, replyShowsPrice, replyShowsAuthoritativeTerms } = require('./lib/model-led-luna/v3-booking-flow');
const { LUNA_V3_ROUTE_TO_TOOL } = require('./lib/model-led-luna/staff-routes');
const { assertSafeToolRequest } = require('./lib/model-led-luna/contracts');

const context = { sessionId: 'luna-v3:aaaaaaaaaaaaaaaaaaaaaaaa', principalId: 'p', turnId: 'turn:cap-fix-1',
  authenticatedInboundEventId: '11111111-1111-4111-8111-111111111111' };
const input = {
  action: 'prepare', purpose: 'offer', check_in: '2027-03-01', check_out: '2027-03-08',
  guests: [{ name: 'A', explicit_gender: 'female' }], room: { kind: 'women_only', beds: ['BED-1'], together: 'not_required' },
  package: { name: 'Malibu' },
  add_ons: [{ code: 'board', quantity: 3, requested_dates: ['2027-03-02'] }],
  payment: { arrangement: 'separately' },
};

let observedPreferences;
let observedAddOns;
function withAttemptLifecycle(inner) {
  let attempt;
  return { async query(sql, params = []) {
    if (/INSERT INTO luna_v3_prepare_attempts/.test(sql)) {
      attempt = { id: 'attempt-1', request_fingerprint: params[3], outcome: 'started', receipt: null,
        lease_expires_at: '2999-01-01T00:00:00Z' };
      return { rows: [attempt] };
    }
    if (/UPDATE luna_v3_prepare_attempts/.test(sql)) {
      if (/lease_expires_at=now\(\)\+interval/.test(sql)) return { rows: [{ id: attempt.id }] };
      if (/SET owner_released_at=COALESCE/.test(sql)) return { rows: [] };
      attempt.receipt = JSON.parse(params[1]); attempt.outcome = /outcome='applied'/.test(sql) ? 'applied' : params[2];
      return { rows: [{ id: attempt.id, receipt: attempt.receipt }] };
    }
    return inner.query(sql, params);
  } };
}
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
  const pg = withAttemptLifecycle({ async query(sql) {
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (/SELECT h.expires_at,h.state,sel.quote/.test(sql)) return { rows: [] };
    if (/SELECT s.id,s.client_id/.test(sql)) return { rows: [{ id: 'session-db', client_id: 'client-db' }] };
    if (/UPDATE luna_v3_holds/.test(sql) || /UPDATE luna_v3_selections/.test(sql)) return { rows: [{ id: 'hold-db' }] };
    if (/INSERT INTO luna_v3_offer_turns/.test(sql)) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  } });
  const result = await createCheckQuoteBook(deps())(pg, input, context);
  assert.equal(result.quote.totalCents, 12345);
  assert.equal(result.quote.currency, 'EUR');
  assert.equal(result.guests[0].bed, 'BED-1');
  assert.equal(result.guests[0].package, 'malibu');
  assert.deepEqual(result.package_details, { code: 'malibu', name: 'Malibu', description: 'Stay and surf', includes: ['bed', 'lessons'], terms: [] });
  assert.deepEqual(observedPreferences, { room_type: 'female', room_preference: undefined, keep_together: false,
    group_gender: 'female', guests: [{ name: 'A', explicit_gender: 'female' }] });
  assert.deepEqual(observedAddOns, [{ code: 'board', dates: ['2027-03-02'], days: 1, quantity: 3 }]);
}

async function testQuoteOnlyPricesWithoutHolding() {
  let holdCalls = 0;
  let writeQueries = 0;
  let observedQuoteInput;
  const pg = withAttemptLifecycle({ async query(sql) {
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    writeQueries += 1;
    throw new Error(`quote-only must not write: ${sql}`);
  } });
  const failedConversation = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/luna-v3/regressions/v3-price-contract-20261025-shared-short-stay.json'), 'utf8'));
  const quoteInput = failedConversation.expected_tool.arguments;
  const result = await createCheckQuoteBook(deps({
    findRooms: async () => ({ ok: true, rooms: [{ roomId: 'R1', bedOptions: [{ code: 'BED-1' }, { code: 'BED-2' }] }] }),
    getPricingCatalog: async () => ({ ok: true, items: [{ item_type: 'package', item_code: 'package_none', label: 'Accommodation only' }] }),
    quote: async (_pg, args) => { observedQuoteInput = args; return { ok: true, totalCents: 24690, depositCents: 6000, remainingCents: 18690, currency: 'EUR', lineItems: [], perPerson: [] }; },
    holdBeds: async () => { holdCalls += 1; throw new Error('quote-only must not hold'); },
  }))(pg, quoteInput, { ...context, turnId: 'turn:failed-v3-quote-regression' });
  assert.equal(result.state, 'quote');
  assert.equal(result.reason, 'authoritative_quote_ready');
  assert.equal(result.held, false);
  assert.equal(result.booked, false);
  assert.equal(result.quote.totalCents, 24690);
  assert.equal(result.quote.currency, 'EUR');
  assert.deepEqual(result.guests, [
    { position: 1, bed: 'BED-1', package: 'package_none' },
    { position: 2, bed: 'BED-2', package: 'package_none' },
  ]);
  assert.deepEqual(observedQuoteInput.guests, [
    { name: 'Quote guest 1', explicit_gender: null },
    { name: 'Quote guest 2', explicit_gender: null },
  ]);
  assert.equal(observedQuoteInput.package_id, 'package_none');
  assert.equal(observedQuoteInput.payment, undefined);
  assert.equal(result.payment_arrangement, undefined);
  assert.equal(result.offer_reference, undefined);
  assert.equal(holdCalls, 0);
  assert.equal(writeQueries, 0);
}

async function testReplayNeedsNoFreshCatalog() {
  let catalogCalls = 0;
  const replayQuote = { totalCents: 12345, depositCents: 3000, remainingCents: 9345, currency: 'EUR',
    lineItems: [], perPerson: [], packageDetails: { code: 'malibu', name: 'Original Malibu', description: 'Stored', includes: ['bed'] } };
  const pg = withAttemptLifecycle({ async query(sql) {
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (/SELECT h.expires_at,h.state,sel.quote/.test(sql)) return { rows: [{ state: 'active', expires_at: '2099-03-01T12:15:00Z', quote: replayQuote,
      assignments: [{ bed_code: 'BED-1', package_code: 'malibu' }] }] };
    throw new Error(`unexpected replay SQL: ${sql}`);
  } });
  const result = await createCheckQuoteBook(deps({ getPricingCatalog: async () => { catalogCalls += 1; throw new Error('catalog unavailable'); } }))(pg, input, context);
  assert.equal(catalogCalls, 0);
  assert.equal(result.offer_reference.startsWith('offer_'), true);
  assert.deepEqual(result.package_details, replayQuote.packageDetails);
}

async function testOfferReferenceIsEventAndPayloadScoped() {
  const run = async (turnId, eventId, replay = null) => {
    const pg = withAttemptLifecycle({ async query(sql) {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/SELECT h.expires_at,h.state,sel.quote/.test(sql)) return { rows: replay ? [{ state: 'active', expires_at: '2099-03-01T12:15:00Z', quote: replay.quote,
        assignments: [{ bed_code: 'BED-1', package_code: 'malibu' }] }] : [] };
      if (/SELECT s.id,s.client_id/.test(sql)) return { rows: [{ id: 'session-db', client_id: 'client-db' }] };
      if (/UPDATE luna_v3_holds/.test(sql) || /UPDATE luna_v3_selections/.test(sql)) return { rows: [{ id: 'hold-db' }] };
      if (/INSERT INTO luna_v3_offer_turns/.test(sql)) return { rows: [] };
      throw new Error(`unexpected lifecycle SQL: ${sql}`);
    } });
    return createCheckQuoteBook(deps())(pg, input, { ...context, turnId, authenticatedInboundEventId: eventId });
  };
  const eventA = '11111111-1111-4111-8111-111111111111';
  const a1 = await run('turn:lifecycle-a-1', eventA);
  const a1Replay = await run('turn:lifecycle-a-2', eventA, a1);
  const b = await run('turn:lifecycle-b', '22222222-2222-4222-8222-222222222222');
  const a2 = await run('turn:lifecycle-a-3', '33333333-3333-4333-8333-333333333333');
  assert.equal(a1Replay.offer_reference, a1.offer_reference, 'same-event same-input replay must be stable');
  assert.notEqual(b.offer_reference, a1.offer_reference);
  assert.notEqual(a2.offer_reference, a1.offer_reference, 'A→B→A must start a new offer lifecycle');
  assert.notEqual(a2.offer_reference, b.offer_reference);
}

async function testFailedOfferWriteRollsBackHold() {
  let released = 0;
  const pg = withAttemptLifecycle({ async query(sql) {
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (/SELECT h.expires_at,h.state,sel.quote/.test(sql)) return { rows: [] };
    if (/SELECT s.id,s.client_id/.test(sql)) return { rows: [{ id: 'session-db', client_id: 'client-db' }] };
    if (/UPDATE luna_v3_holds/.test(sql) || /UPDATE luna_v3_selections/.test(sql)) return { rows: [{ id: 'hold-db' }] };
    if (/INSERT INTO luna_v3_offer_turns/.test(sql)) throw new Error('offer write failed');
    throw new Error(`unexpected SQL: ${sql}`);
  } });
  const failed = await createCheckQuoteBook(deps({ releaseHold: async () => { released += 1; return { ok: true }; } }))(pg, input, context);
  assert.equal(failed.code, 'prepare_outcome_unknown');
  assert.equal(failed.outcome, 'unknown');
  assert.equal(released, 0, 'same-transaction hold needs no fallible compensation call');
}

async function main() {
  assert.equal(replyShowsPrice('The offer is €123.45.', 12345, 'EUR'), true);
  assert.equal(replyShowsPrice('An unrelated larger amount is €1123.45.', 12345, 'EUR'), false);
  const presentationQuote = { totalCents: 12345, depositCents: 3000, currency: 'EUR', quoteInput: {
    check_in: '2027-03-01', check_out: '2027-03-08', guests: [{ name: 'A' }],
    selection: { selected_bed_codes: ['BED-1'] }, guest_packages: [{ package_code: 'malibu' }],
    add_ons: [{ code: 'board', dates: ['2027-03-02'], quantity: 3 }],
  }, packageDetails: { code: 'malibu', includes: ['bed', 'lessons'] } };
  const complete = 'Total €123.45; deposit €30.00; 2027-03-01 to 2027-03-08; A; BED-1; malibu includes bed and lessons; board quantity 3 on 2027-03-02.';
  assert.equal(replyShowsAuthoritativeTerms(complete, presentationQuote), true);
  assert.equal(replyShowsAuthoritativeTerms(`${complete} Correction: the total is €1.00 and the deposit is €1.00.`, presentationQuote), false,
    'later contradictory money must invalidate the presentation');
  assert.equal(replyShowsAuthoritativeTerms(complete.replace('board quantity 3', 'board quantity 2'), presentationQuote), false,
    'selected add-on quantity must be canonical');
  assert.equal(replyShowsAuthoritativeTerms(complete.replace('board quantity 3', 'board quantity 3 and correction quantity 2'), presentationQuote), false,
    'contradictory add-on quantity must invalidate the presentation');
  assert.equal(replyShowsAuthoritativeTerms(complete.replace('includes bed and lessons', 'includes bed, lessons, and wetsuit'), presentationQuote), false,
    'package presentation must not add excluded inclusions');
  assert.equal(replyShowsAuthoritativeTerms(`${complete} It also includes wetsuit.`, presentationQuote), false,
    'a later noncanonical inclusion claim must invalidate the presentation');
  assert.equal(replyShowsAuthoritativeTerms(`${complete} Correction: lessons are excluded.`, presentationQuote), false,
    'a later exclusion of a canonical inclusion must invalidate the presentation');
  assert.equal(replyShowsAuthoritativeTerms(`${complete} Accommodation only, no board included.`, presentationQuote), false,
    'an explicit exclusion of a selected add-on must invalidate the presentation');
  assert.equal(replyShowsAuthoritativeTerms(`${complete} Accommodation only, no malibu package included.`, presentationQuote), false,
    'an explicit exclusion of the selected package must invalidate the presentation');
  assert.equal(replyShowsAuthoritativeTerms(`${complete} No extra charge for board quantity 3.`, presentationQuote), true,
    'a waived add-on fee is not an exclusion of the selected add-on');
  assert.equal(replyShowsAuthoritativeTerms(`${complete} No additional fee for the malibu package.`, presentationQuote), true,
    'a waived package fee is not an exclusion of the selected package');
  assert.equal(replyShowsAuthoritativeTerms(`${complete} Board quantity 3 is not optional.`, presentationQuote), true,
    'a mandatory selected add-on is not an exclusion');
  assert.equal(replyShowsAuthoritativeTerms(complete.replace('Total €123.45; deposit €30.00', 'Total €123.450; deposit €300.00'), presentationQuote), false);
  assert.equal(replyShowsAuthoritativeTerms(complete.replace('Total €123.45; deposit €30.00', 'Total €30.00; deposit €123.45'), presentationQuote), false);
  assert.equal(replyShowsAuthoritativeTerms(complete.replace('Total €123.45; deposit €30.00', 'Total €30.00 and €123.45 deposit'), presentationQuote), false,
    'a second amount before the deposit label must not let swapped money pass');
  assert.equal(replyShowsAuthoritativeTerms(complete.replace('malibu includes bed and lessons; ', ''), presentationQuote), false);
  assert.equal(replyShowsAuthoritativeTerms(complete.replace('board quantity 3 on 2027-03-02', ''), presentationQuote), false);
  const paymentServiceSource = fs.readFileSync(path.join(__dirname, 'lib/luna-front-desk-payment-link-service.js'), 'utf8');
  const lockedCheckoutGuard = paymentServiceSource.slice(
    paymentServiceSource.indexOf("SELECT id FROM bookings WHERE id = $1::uuid AND client_id = $2 FOR UPDATE"),
    paymentServiceSource.indexOf('if (useFreshLedger) {', paymentServiceSource.indexOf("SELECT id FROM bookings WHERE id = $1::uuid AND client_id = $2 FOR UPDATE")),
  );
  assert.match(lockedCheckoutGuard, /booking_guest_id/,
    'booking-coordinated group checkout guard must recheck personal checkout evidence under the booking lock');
  const migration124 = fs.readFileSync(path.join(__dirname, '../database/migrations/124_luna_v3_fix2_evidence_and_cancel_guard.sql'), 'utf8');
  const mixedScopeGuard = migration124.slice(migration124.indexOf('CREATE OR REPLACE FUNCTION reject_mixed_booking_checkout_scope'));
  assert.match(mixedScopeGuard, /checkout_preparation/,
    'migration-124 mixed-scope trigger must treat durable checkout preparation as provider evidence');
  assert.match(mixedScopeGuard, /idempotency_key/,
    'migration-124 mixed-scope trigger must treat durable idempotency metadata as provider evidence');
  assert.equal(LUNA_V3_ROUTE_TO_TOOL['/staff/bot/luna-v3/book'], undefined, 'legacy public book route must be closed');
  assert.doesNotThrow(() => assertSafeToolRequest('check_quote_book', input));
  await testCompleteOffer();
  await testQuoteOnlyPricesWithoutHolding();
  await testReplayNeedsNoFreshCatalog();
  await testOfferReferenceIsEventAndPayloadScoped();
  await testFailedOfferWriteRollsBackHold();
  console.log('luna v3 Cap FIX1 focused regressions: PASS');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
