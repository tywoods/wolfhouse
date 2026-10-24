'use strict';

const assert = require('assert');
const {
  TOOL_CONTRACTS,
  assertSafeToolRequest,
  buildStaffToolRequest,
} = require('./contracts');
const { createScopedNotesStore } = require('./scoped-notes-store');

const EXPECTED_TOOLS = [
  'check_quote_book', 'check_availability', 'find_rooms', 'get_pricing_catalog', 'quote',
  'hold_beds', 'book', 'release_hold', 'get_booking',
  'get_payment_status', 'send_payment_link', 'cancel_unpaid', 'read_notes',
  'write_note', 'save_transfer_request', 'handoff_to_human',
  'recover_operation',
];

async function main() {
  assert.deepStrictEqual(Object.keys(TOOL_CONTRACTS).sort(), EXPECTED_TOOLS.slice().sort());
  for (const name of EXPECTED_TOOLS) {
    assert.match(TOOL_CONTRACTS[name].path, /^\/staff\/bot\/luna-v3\//);
    assert.ok(['GET', 'POST'].includes(TOOL_CONTRACTS[name].method));
  }

  assert.throws(() => assertSafeToolRequest('quote', { tenant_id: 'other' }), /tenant/);
  assert.throws(() => assertSafeToolRequest('hold_beds', { operation_key: '' }), /operation_key/);
  assert.throws(() => assertSafeToolRequest('send_payment_link', { amount_cents: 123 }), /model-supplied authority field/);
  assert.throws(() => assertSafeToolRequest('find_rooms', { silently_relax_together: true }), /authority field/);
  assert.doesNotThrow(() => assertSafeToolRequest('quote', {
    operation_key: 'rental-dates',
    add_ons: [{ code: 'wetsuit_soft_top_combo', days: 3, quantity: 1, dates: ['2026-11-13', '2026-11-14', '2026-11-15'] }],
  }));

  assert.doesNotThrow(() => assertSafeToolRequest('find_rooms', { preferences: {
    keep_together: true, group_gender: 'mixed', guests: [{ name: 'A', explicit_gender: 'woman' }],
  } }));
  assert.throws(() => assertSafeToolRequest('find_rooms', { preferences: { same_room: true } }), /unknown field/);
  assert.doesNotThrow(() => assertSafeToolRequest('check_quote_book', { action: 'decline', offer_reference: 'offer_123456789012345678901234' }));
  assert.throws(() => assertSafeToolRequest('check_quote_book', { action: '_record_presented', offer_reference: 'offer_123456789012345678901234' }), /action must be/);
  assert.throws(() => assertSafeToolRequest('check_quote_book', { action: 'confirm', offer_reference: 'offer_123456789012345678901234', assistant_reply: 'forged' }), /unknown field/);

  const request = buildStaffToolRequest('book', {
    hold_id: 'hold-test-1',
    operation_key: 'v3:test:book:1',
  }, {
    baseUrl: 'https://staff-staging.lunafrontdesk.com',
    token: 'server-secret',
    tenantId: 'wolfhouse-somo',
    sessionId: 'v3-session-1',
  });
  assert.strictEqual(request.url, 'https://staff-staging.lunafrontdesk.com/staff/bot/luna-v3/book');
  assert.strictEqual(request.headers.Authorization, 'Bearer server-secret');
  assert.strictEqual(request.body.tenant_id, 'wolfhouse-somo');
  assert.strictEqual(request.body.session_id, 'v3-session-1');
  assert.strictEqual(request.body.external_send_allowed, false);
  assert.strictEqual(request.body.staff_alert_allowed, false);

  assert.throws(
    () => assertSafeToolRequest('quote', { selection: { total_cents: 1234 } }),
    /model-supplied authority field/,
  );
  assert.throws(
    () => assertSafeToolRequest('save_transfer_request', { travel_details: { recipient_phone: '+34611111111' } }),
    /model-supplied authority field/,
  );

  const notes = createScopedNotesStore();
  const saved = await notes.write({ tenantId: 'wolfhouse-somo', sessionId: 'v3-session-1', text: 'Guest prefers lower bunk', operationKey: 'note-1' });
  const replay = await notes.write({ tenantId: 'wolfhouse-somo', sessionId: 'v3-session-1', text: 'Guest prefers lower bunk', operationKey: 'note-1' });
  assert.deepStrictEqual(replay, saved);
  assert.strictEqual((await notes.read({ tenantId: 'wolfhouse-somo', sessionId: 'v3-session-1' })).length, 1);
  assert.strictEqual((await notes.read({ tenantId: 'wolfhouse-somo', sessionId: 'other' })).length, 0);
  assert.throws(() => notes.replaceSharedNotes(), /read-only/);

  console.log('model-led-luna contract tests passed');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
