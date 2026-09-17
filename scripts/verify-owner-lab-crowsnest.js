'use strict';

const assert = require('assert/strict');
const {
  ensureConversationForGuestPhone,
} = require('./lib/luna-hermes-whatsapp-thread-mirror');
const {
  getConversationInboxQuery,
  getConversationDetailQuery,
} = require('./lib/staff-conversation-queries');
const {
  projectInboxPersonRow,
} = require('./lib/staff-inbox-view-routes');

async function main() {
  const calls = [];
  const pg = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT id FROM clients/.test(sql)) return { rows: [{ id: 'tenant-sunset' }] };
    if (/SELECT id::text AS conversation_id FROM conversations/.test(sql)) return { rows: [] };
    if (/INSERT INTO conversations/.test(sql)) return { rows: [{ conversation_id: 'conv-sim' }] };
    if (/INSERT INTO customers|UPDATE customers|SELECT.*customers/is.test(sql)) return { rows: [] };
    return { rows: [] };
  } };

  const durable = '+999000000000001';
  const source = '+34600111222';
  const ensured = await ensureConversationForGuestPhone(pg, 'sunset', durable, null, 'hello', {
    location_id: 'sunset-somo',
    simulator_synthetic: true,
    source_owner: 'crowsnest-guest-door',
    simulator_source_phone: source,
  });
  assert.equal(ensured.guest_phone, durable, 'durable conversation key remains +999');
  assert.equal(ensured.metadata.open_phone_testing, true);
  assert.equal(ensured.metadata.guest_tester_class, 'Simulator');
  assert.equal(ensured.metadata.simulator_source_phone, source);
  const insert = calls.find((c) => /INSERT INTO conversations/.test(c.sql));
  assert(insert, 'conversation upsert executed');
  assert.equal(insert.params[1], durable, 'never creates a conversation under source phone');

  const inboxSql = getConversationInboxQuery({ ownerLabScoped: true });
  assert.match(inboxSql, /open_phone_testing.*guest_tester_class/s, 'Owner Lab predicate remains OR contract');
  assert.match(inboxSql, /simulator_source_phone/, 'list selects trusted simulator display phone');
  assert.match(inboxSql, /source_owner.*crowsnest-guest-door/s, 'display phone is source-owner scoped');
  const detailSql = getConversationDetailQuery();
  assert.match(detailSql, /simulator_source_phone/, 'header selects trusted simulator display phone');
  assert.match(detailSql, /simulator_synthetic.*true/s, 'header display phone is simulator scoped');

  const projected = projectInboxPersonRow(
    { source: 'conversations', id: 'owner_lab' },
    { conversation_id: 'conv-sim', phone: durable, display_phone: source,
      open_phone_testing: true, guest_tester_class: 'Simulator', last_activity: new Date(0) },
  );
  assert.equal(projected.phone, source, 'list displays staff-typed simulator phone');
  assert.equal(projected.durable_phone, durable, 'DTO retains non-routable durable key');
  assert.equal(projected.guest_tester_class, 'Simulator', 'Owner Lab chip input survives');

  const ordinary = projectInboxPersonRow(
    { source: 'conversations', id: 'whatsapp' },
    { conversation_id: 'conv-wa', phone: '+34600999888', display_phone: null,
      open_phone_testing: false, last_activity: new Date(0) },
  );
  assert.equal(ordinary.phone, '+34600999888', 'ordinary WhatsApp display is unchanged');
  assert.equal(ordinary.durable_phone, '+34600999888');

  console.log('PASS verify-owner-lab-crowsnest: metadata, Owner Lab display, durable identity, ordinary path');
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
