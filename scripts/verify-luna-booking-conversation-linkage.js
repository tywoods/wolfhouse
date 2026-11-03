#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  resolveBookingConversationProvenance,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');

const base = {
  clientSlug: 'wolfhouse-somo',
  phone: '+999600111555',
  transportBody: {
    conversation_id: '11111111-1111-4111-8111-111111111111',
    location_id: 'sunset-somo', // untrusted and deliberately wrong
  },
};

async function run() {
  let captured;
  const good = await resolveBookingConversationProvenance({
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ conversation_id: params[0], location_id: 'wolfhouse-somo' }] };
    },
  }, base);
  assert.deepStrictEqual(good, {
    ok: true,
    conversationId: base.transportBody.conversation_id,
    locationId: 'wolfhouse-somo',
  });
  assert.match(captured.sql, /JOIN clients cl ON cl\.id = c\.client_id/);
  assert.match(captured.sql, /cl\.slug = \$2/);
  assert.match(captured.sql, /c\.phone = \$3/);
  assert.deepStrictEqual(captured.params, [
    base.transportBody.conversation_id, 'wolfhouse-somo', '+999600111555',
  ]);

  for (const rows of [[], [{ conversation_id: base.transportBody.conversation_id, location_id: 'sunset-somo' }]]) {
    const rejected = await resolveBookingConversationProvenance({ query: async () => ({ rows }) }, base);
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.body.reason_code, 'booking_conversation_location_mismatch');
    assert.strictEqual(rejected.body.write_performed, false);
  }

  const absent = await resolveBookingConversationProvenance({
    query: async () => { throw new Error('must not query'); },
  }, { ...base, transportBody: {} });
  assert.deepStrictEqual(absent, { ok: true, conversationId: '', locationId: '' });
  console.log('verify:luna-booking-conversation-linkage PASSED');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
