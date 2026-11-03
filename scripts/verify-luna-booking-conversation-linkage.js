#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  resolveBookingConversationProvenance,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { createStaffSupervisorRoutes } = require('./lib/staff-supervisor-routes');

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONV = '11111111-1111-4111-8111-111111111111';
const OTHER_CONV = '22222222-2222-4222-8222-222222222222';
const B1 = '33333333-3333-4333-8333-333333333331';
const B2 = '33333333-3333-4333-8333-333333333332';
const LEGACY = '33333333-3333-4333-8333-333333333333';
const UNRELATED = '33333333-3333-4333-8333-333333333334';
const FOREIGN = '33333333-3333-4333-8333-333333333335';
const DUP1 = '33333333-3333-4333-8333-333333333336';
const DUP2 = '33333333-3333-4333-8333-333333333337';

const conversations = [
  { id: CONV, client_id: TENANT, client_slug: 'wolfhouse-somo', phone: '+34111111111', current_hold_booking_id: LEGACY },
  { id: OTHER_CONV, client_id: OTHER_TENANT, client_slug: 'other-tenant', phone: '+34999999999', current_hold_booking_id: null },
];
const bookings = [
  { id: B1, code: 'WH-ONE', client_id: TENANT, conversation_id: CONV },
  { id: B2, code: 'WH-TWO', client_id: TENANT, conversation_id: CONV },
  { id: LEGACY, code: 'WH-LEGACY', client_id: TENANT, conversation_id: null },
  { id: UNRELATED, code: 'WH-UNRELATED', client_id: TENANT, conversation_id: null },
  { id: FOREIGN, code: 'FOREIGN', client_id: OTHER_TENANT, conversation_id: OTHER_CONV },
  { id: DUP1, code: 'WH-DUP', client_id: TENANT, conversation_id: CONV },
  { id: DUP2, code: 'WH-DUP', client_id: TENANT, conversation_id: CONV },
];

function linked(booking, conversation) {
  return booking.client_id === conversation.client_id
    && (conversation.current_hold_booking_id === booking.id || booking.conversation_id === conversation.id);
}

function fakePg(trace) {
  return {
    async query(sql, params = []) {
      trace.push({ sql, params });
      if (/SELECT c\.id::text AS conversation_id, b\.id::text AS booking_id/.test(sql)) {
        const [id, code, trustedId, trustedSlug] = params;
        const rows = [];
        for (const booking of bookings) {
          const conversation = conversations.find((c) => linked(booking, c));
          if (!conversation) continue;
          if (trustedId ? booking.client_id !== trustedId : conversation.client_slug !== trustedSlug) continue;
          if (id && booking.id !== id) continue;
          if (code && booking.code !== code) continue;
          rows.push({ conversation_id: conversation.id, booking_id: booking.id, booking_code: booking.code });
        }
        return { rows, rowCount: rows.length };
      }
      if (/SELECT b\.id::text AS booking_id, b\.booking_code/.test(sql)) {
        const [conversationId, id, code] = params;
        const rows = bookings.filter((booking) => {
          const conversation = conversations.find((c) => c.id === conversationId);
          return conversation && linked(booking, conversation)
            && (!id || booking.id === id) && (!code || booking.code === code);
        }).map((booking) => ({ booking_id: booking.id, booking_code: booking.code }));
        return { rows, rowCount: rows.length };
      }
      if (/FROM conversations c\s+JOIN clients cl/.test(sql)) {
        const conversation = conversations.find((c) => c.id === params[0]);
        return { rows: conversation ? [{ ...conversation, last_staff_reply_at: null, metadata: {}, needs_human_transition_id: null }] : [], rowCount: conversation ? 1 : 0 };
      }
      if (/settings->'inbox_channel_modes'/.test(sql)) return { rows: [{ whatsapp_mode: 'auto' }], rowCount: 1 };
      // Pause-state lookups: no pause is present.
      return { rows: [], rowCount: 0 };
    },
  };
}

async function admit(body, user = { staff_user_id: 'human', role: 'operator', client_id: TENANT, client_slug: 'wolfhouse-somo' }, action = 'booking_edit') {
  const trace = [];
  const pg = fakePg(trace);
  const routes = createStaffSupervisorRoutes({
    sendJSON: () => { throw new Error('not used'); },
    withPgClient: async (fn) => fn(pg),
  });
  const result = await routes.admitFromRequest({ headers: {} }, user, {
    action, body: { ...body }, query: {}, step: 'route-regression',
  });
  return { result, trace };
}

async function testCreateProvenance() {
  const base = {
    clientSlug: 'wolfhouse-somo', phone: '+999****1555',
    transportBody: { conversation_id: CONV, location_id: 'sunset-somo' },
  };
  let captured;
  const good = await resolveBookingConversationProvenance({ query: async (sql, params) => {
    captured = { sql, params };
    return { rows: [{ conversation_id: params[0], location_id: 'wolfhouse-somo' }] };
  } }, base);
  assert.deepStrictEqual(good, { ok: true, conversationId: CONV, locationId: 'wolfhouse-somo' });
  assert.match(captured.sql, /JOIN clients cl ON cl\.id = c\.client_id/);
  assert.match(captured.sql, /cl\.slug = \$2/);
  assert.match(captured.sql, /c\.phone = \$3/);
  assert.deepStrictEqual(captured.params, [CONV, 'wolfhouse-somo', '+999****1555']);
  for (const rows of [[], [{ conversation_id: CONV, location_id: 'sunset-somo' }]]) {
    const rejected = await resolveBookingConversationProvenance({ query: async () => ({ rows }) }, base);
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.body.reason_code, 'booking_conversation_location_mismatch');
    assert.strictEqual(rejected.body.write_performed, false);
  }
  const absent = await resolveBookingConversationProvenance({
    query: async () => { throw new Error('must not query'); },
  }, { ...base, transportBody: {} });
  assert.deepStrictEqual(absent, { ok: true, conversationId: '', locationId: '' });
}

async function run() {
  await testCreateProvenance();

  for (const claim of [
    { booking_id: B1 }, // exact id + metadata linkage
    { booking_code: 'WH-ONE' }, // exact code
    { booking_id: LEGACY }, // legacy current_hold linkage
    { booking_id: B2 }, // second booking sharing the same conversation
  ]) {
    const { result } = await admit(claim);
    assert.strictEqual(result.ok, true, JSON.stringify({ claim, result }));
    assert.strictEqual(result.skipped, 'not_supervisor');
  }

  const transferOnFirst = await admit({ booking_id: B1 }, undefined, 'booking_transfer_save');
  const contactOnSecond = await admit({ booking_id: B2 }, undefined, 'booking_contact_update');
  assert.strictEqual(transferOnFirst.result.ok, true, 'transfer action admitted for first durable linkage');
  assert.strictEqual(contactOnSecond.result.ok, true, 'contact action admitted for second booking in same conversation');

  const unrelated = await admit({ booking_id: UNRELATED });
  assert.strictEqual(unrelated.result.ok, false);
  assert.strictEqual(unrelated.result.error, 'booking_conversation_mismatch');

  const spoofed = await admit({ booking_id: FOREIGN, client_slug: 'other-tenant' });
  assert.strictEqual(spoofed.result.ok, false, 'body tenant spoof must not grant authority');
  assert.strictEqual(spoofed.result.error, 'booking_conversation_mismatch');
  const lookup = spoofed.trace.find((q) => /SELECT c\.id::text AS conversation_id/.test(q.sql));
  assert.deepStrictEqual(lookup.params.slice(2), [TENANT, 'wolfhouse-somo']);

  const mismatch = await admit({ booking_id: B1, booking_code: 'WH-TWO' });
  assert.strictEqual(mismatch.result.ok, false, 'id and code are conjunctive claims');
  assert.strictEqual(mismatch.result.error, 'booking_conversation_mismatch');

  const ambiguous = await admit({ booking_code: 'WH-DUP' });
  assert.strictEqual(ambiguous.result.ok, false, 'ambiguous exact code must fail closed');
  assert.strictEqual(ambiguous.result.error, 'booking_conversation_mismatch');

  const noPhoneGuess = await admit({ booking_code: 'WH-ONE', phone: '+34999999999' });
  assert.strictEqual(noPhoneGuess.result.ok, true, 'booking resolution must not guess by phone');
  const bookingQueries = noPhoneGuess.trace.filter((q) => /FROM bookings b|JOIN bookings b/.test(q.sql));
  assert.ok(bookingQueries.length >= 2);
  assert.ok(bookingQueries.every((q) => !/phone/i.test(q.sql)), 'booking linkage SQL contains no phone predicate');
  assert.ok(bookingQueries[0].sql.includes("($1::text <> '' OR $2::text <> '')"), 'empty identifier guard is mandatory');
  assert.ok(bookingQueries[0].sql.includes('ORDER BY b.id::text, c.id::text'), 'ambiguity ordering is deterministic');

  const wrongClaimOnTrustedConversation = await admit({ conversation_id: CONV, booking_id: B1, client_slug: 'other-tenant' });
  assert.strictEqual(wrongClaimOnTrustedConversation.result.ok, false);
  assert.strictEqual(wrongClaimOnTrustedConversation.result.error, 'admission_facts_required');

  console.log('verify:luna-booking-conversation-linkage PASSED');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
