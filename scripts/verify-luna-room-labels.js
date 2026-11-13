'use strict';
const assert = require('node:assert/strict');
const { buildReplyForState } = require('./lib/luna-guest-reply-composer');
const { projectGuestRooms, guestFacingRoomLabel } = require('./lib/staff-guest-room-state');
const { buildWolfhousePaidConfirmationCopy } = require('./lib/luna-guest-confirmation-copy-style');
const fields = { check_in: '2026-11-01', check_out: '2026-11-09', guest_count: 1, package_code: 'malibu' };
function offer(quote, extra = {}, slug = 'wolfhouse-somo') {
  return buildReplyForState('package_quote_ready', { lang: 'en', fields: { ...fields, ...extra }, quote: { quote_total_cents: 40000, ...quote }, plan: {}, pc: {}, result: {}, availability: {}, stripe: {}, facts: {}, client_slug: slug });
}
function confirmation(rooms) {
  return buildWolfhousePaidConfirmationCopy({ ...fields, language: 'en', guest_name: 'Test', booking_code: 'WH-TEST', payment_status: 'paid', amount_paid_cents: 40000, total_amount_cents: 40000, balance_due_cents: 0, assigned_rooms: rooms.map(r => ({ ...r, kind: r.room_kind })) });
}
function safe(text) { assert.doesNotMatch(text, /\bR\d+\b|\bdorm(?:itory)?\b|Secret suite|A bed in a shared room/i); }
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
for (const type of ['mixed', 'female_only', 'male_only']) {
  test(`${type} saved projection, offer and confirmation`, () => {
    const rooms = projectGuestRooms([{ room_code: 'R1' }], { R1: { type, room_name: 'Secret suite' } }, {}, { source: 'saved_booking', private_room_enabled: false, room_codes: ['R1'] });
    const phrase = type === 'mixed' ? 'mixed' : type.split('_')[0];
    assert.equal(rooms[0].type, type);
    for (const text of [offer({ guest_rooms: rooms }), confirmation(rooms)]) {
      assert.ok(text.includes(`Room 1, ${phrase} shared room`), text); safe(text);
    }
  });
}
test('privacy overrides contradictory catalog; missing privacy stays unknown', () => {
  for (const [enabled, type, expected] of [[true, 'female_only', 'private'], [false, 'private', 'shared'], [null, 'mixed', null]]) {
    const rooms = projectGuestRooms([{ room_code: 'R1' }], { R1: { type, capacity: 2 } }, { room_type: 'private' }, { source: 'saved_booking', private_room_enabled: enabled, room_codes: ['R1'] });
    assert.equal(rooms[0].type, expected);
    for (const text of [offer({ guest_rooms: rooms, room_type: 'mixed' }), confirmation(rooms)]) {
      assert.ok(text.includes(expected ? `Room 1, ${expected} room` : 'Room 1'), text);
      if (!expected) assert.doesNotMatch(text, /mixed shared|private room/);
      safe(text);
    }
  }
  assert.equal(guestFacingRoomLabel('R1', 'mixed', 'private'), 'Room 1, private room');
  assert.equal(guestFacingRoomLabel('R1', 'private', 'shared'), 'Room 1, shared room');
});
test('missing facts and request injection', () => {
  assert.ok(offer({ room_type: 'mixed' }).includes('mixed shared room'));
  assert.ok(offer({ room_number: 'R2' }).includes('Room 2'));
  const text = offer({}, { room_number: 'R99', room_type: 'female_only', guest_rooms: [{ number: 'R99' }] });
  assert.doesNotMatch(text, /🛏️|Room 99|female/);
  safe(offer({ room_number: 'SECRET', room_type: 'unknown', room_name: 'Secret suite' }));
});
test('multiple rooms deduplicated in both renderers', () => {
  const rooms = [{ number: 'R1', type: 'mixed' }, { number: 'R2', type: 'female_only' }, { number: 'R1', type: 'mixed' }];
  for (const text of [offer({ guest_rooms: rooms }), confirmation(rooms)]) {
    assert.equal(text.split('Room 1').length, 2); assert.ok(text.includes('Room 2, female shared room')); safe(text);
  }
});
test('Sunset keeps legacy room wording', () => {
  assert.ok(offer({ room_type: 'shared', room_number: 'R1' }, {}, 'sunset'), 'Sunset reply exists');
  assert.equal(offer({ room_type: 'shared', room_number: 'R1' }, {}, 'sunset'), offer({ room_type: 'shared' }, {}, 'sunset'));
});
test('catalog aliases and privacy provenance', () => {
  for (const [type, expected] of [['mixed dorm', 'mixed'], ['Female Shared Room', 'female_only'], ['male-only', 'male_only'], ['unknown mixed suite', 'shared']]) {
    const rooms = projectGuestRooms([{ room_code: 'R1' }], { R1: { type } }, {}, { source: 'saved_booking', private_room_enabled: false, room_codes: ['R1'] });
    assert.equal(rooms[0].type, expected);
  }
  for (const privacy of [{ source: 'request', private_room_enabled: true, room_codes: ['R1'] }, { source: 'saved_booking', private_room_enabled: true, room_codes: ['R2'] }]) {
    const rooms = projectGuestRooms([{ room_code: 'R1' }], { R1: { type: 'mixed' } }, {}, privacy);
    assert.equal(rooms[0].type, null);
    assert.doesNotMatch(offer({ guest_rooms: rooms }), /mixed shared|private room/);
  }
});
const { runGuestQuoteProposalDryRun } = require('./lib/luna-guest-quote-proposal-dry-run');
test('real quote preview producer to composer uses only selected availability inventory', () => {
  const router = { success: true, message_lane: 'new_booking_inquiry', booking_intake_ready: true, readiness_state: 'ready_for_availability_check', detected_language: 'en', extracted_fields: { check_in: '2026-07-05', check_out: '2026-07-12', guest_count: 1, package_interest: 'malibu', room_number: 'R99', room_type: 'shared', guest_rooms: [{ number: 'R99', type: 'female_only' }] } };
  const detail = { client_slug: 'wolfhouse-somo', check_in: '2026-07-05', check_out: '2026-07-12', guest_count: 1, has_enough_beds: true, selected_bed_codes: ['R1-B1'], available_beds: [{ bed_code: 'R1-B1', room_code: 'R1', room_type: 'mixed', room_name: 'Secret suite' }, { bed_code: 'R2-B1', room_code: 'R2', room_type: 'female_only' }] };
  // Offline authoritative Pricing fixture; run the real calculator, not a quote stub.
  const config = require('./lib/wolfhouse-quote-calculator').loadConfig();
  config.seasons = [{ code: 'summer', active: true, bookable: true, ranges: [{ start_month: 7, start_day: 1, end_month: 7, end_day: 31 }] }];
  function produce(d = detail, slug = 'wolfhouse-somo') {
    return runGuestQuoteProposalDryRun(router, { availability_status: 'available', availability_check_attempted: true, availability_detail: d }, { client_slug: slug, quote_config: config });
  }
  const quote = produce();
  assert.equal(quote.quote_status, 'ready');
  assert.equal(quote.quote_detail.quote.success, true);
  assert.ok(quote.quote_total_cents > 0);
  const text = offer(quote, router.extracted_fields);
  assert.ok(text.includes('Room 1, mixed shared room'), text);
  assert.doesNotMatch(text, /Room 2|Room 99|female/); safe(text);
  const privateQuote = produce({ ...detail, available_beds: [{ ...detail.available_beds[0], selected_selling_mode: 'private' }] });
  assert.ok(offer(privateQuote).includes('Room 1, private room'));
  assert.doesNotMatch(offer(privateQuote), /mixed shared/);
  for (const d of [null, { ...detail, client_slug: 'sunset' }, { ...detail, check_in: '2026-07-06' }, { ...detail, selected_bed_codes: [] }]) {
    assert.doesNotMatch(offer(produce(d), router.extracted_fields), /Room 1|Room 99|mixed shared|female/);
  }
  assert.equal(produce(detail, 'sunset').guest_rooms, undefined);
  const unnamed = produce({ ...detail, available_beds: [{ ...detail.available_beds[0], room_type: null }] });
  assert.ok(offer(unnamed).includes('Room 1'));
  assert.doesNotMatch(offer(unnamed), /mixed shared/);
});
test('staff projected label excludes configured proper names', () => {
  const room = projectGuestRooms([{ room_code: 'R1' }], { R1: { type: 'mixed', room_name: 'Secret suite' } }, {}, { source: 'saved_booking', private_room_enabled: false, room_codes: ['R1'] })[0];
  assert.equal(room.room_label, 'Room 1, mixed shared room');
  assert.equal(room.inventory_room_label, 'Secret suite');
});
console.log(`PASS ${checks} room-label contracts`);
