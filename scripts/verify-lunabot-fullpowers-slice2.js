#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const d = require('./lib/luna-supervisor-lookout-detectors');
const e = require('./lib/staff-supervisor-events');
const { createStaffSupervisorRoutes } = require('./lib/staff-supervisor-routes');
const { captureFailedWhatsAppDeliveryStatus } = require('./lib/luna-supervisor-event-emitter');
const inboxSend = require('./lib/luna-staff-inbox-send-reply');
const conversationQueries = require('./lib/staff-conversation-queries');
const threadMessages = require('./lib/luna-staff-inbox-thread-message');

const UUID = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const USER = { staff_user_id: '33333333-3333-4333-8333-333333333333', role: 'admin', client_slug: 'wolfhouse-somo' };

async function main() {
  const detailSql = conversationQueries.getConversationDetailQuery();
  assert.match(detailSql, /conv\.metadata\s+AS metadata/i,
    'shared lookup returns durable conversation metadata');
  assert.match(detailSql, /c\.slug = \$1[\s\S]*location_id[\s\S]*= \$1/i,
    'shared lookup honors tenant-owner or tenant-location scope');
  assert.match(detailSql, /c\.slug = 'sunset'[\s\S]*location_id[\s\S]*= \$1/i,
    'location aliases remain bound to the Sunset owning tenant');
  let duplicateSql = '';
  const duplicate = await threadMessages.findStaffInboxThreadMessage({
    async query(sql) { duplicateSql = sql; return { rows: [{ message_id: 'm-existing' }] }; },
  }, 'sunset-somo', CONV, { idempotency_key: 'idem-existing' });
  assert.equal(duplicate.message_id, 'm-existing');
  assert.match(duplicateSql, /c\.slug = 'sunset'[\s\S]*location_id[\s\S]*= \$1/i,
    'location-scoped idempotent replay uses the same tenant-bound lookup contract');
  assert.equal(inboxSend.isTrustedSimulatorConversation({
    open_phone_testing: true, guest_tester_class: 'Simulator',
  }), true, 'durable Lab identity routes Hermes-path chats without caller claims');
  assert.equal(inboxSend.isTrustedSimulatorConversation({
    simulator_synthetic: true, source_owner: 'crowsnest-guest-door',
  }), false, 'caller-shaped synthetic flags alone are not trusted Lab identity');
  const labTarget = await inboxSend.resolveAuthoritativeInboxSendTarget({
    async query() { return { rows: [{
      conversation_id: CONV, phone: '+999123456789012', channel: 'whatsapp',
      owner_client_slug: 'sunset',
      metadata: { open_phone_testing: true, guest_tester_class: 'Simulator' },
    }] }; },
  }, 'sunset-somo', CONV, '');
  assert.equal(labTarget.synthetic_lab, true);
  assert.deepEqual(inboxSend.normalizeInboxSendResult({
    success: true, live_send_blocked: true, guest_message_send_status: 'blocked',
  }), {
    success: false, accepted: false, blocked: true, live_send_blocked: true,
    guest_message_send_status: 'blocked', send_performed: false,
    provider_send_performed: false,
  }, 'paused/handoff result is blocked, never accepted');
  assert.match(d.SILENCE_SQL, /message_text[\s\S]*<> '\/new'/i, 'silence excludes staff-runtime /new control input');
  assert.match(d.SILENCE_SQL, /source[^\n]+staff_runtime/i, 'silence excludes staff-runtime synthetic input at its message owner');
  assert.match(d.OWED_HINT_SQL, /confirmation_sent_at IS NULL/i, 'sent confirmations do not become owed alerts');
  assert.match(d.OWED_HINT_SQL, /provider_message_id IS NULL/i, 'provider ACK evidence suppresses false owed alerts');

  const recheckQueries = [];
  const stale = await d.reevaluateLookoutEvent({
    pin: d.CANONICAL_PIN,
    event: { kind: d.KIND_SILENCE, conversation_id: CONV, metadata: { guest_message_id: UUID } },
    pg: { async query(sql) { recheckQueries.push(sql); return { rows: [{ still_active: false, luna_mode: 'auto' }] }; } },
  });
  assert.equal(stale.resolved, true);
  assert.match(recheckQueries[0], /newer_guest/i, 'recheck proves source is still newest, not merely old');

  const store = e.createMemorySupervisorStore();
  const captured = await e.captureSupervisorEvent(store, { id: UUID, source_key: 'x', kind: 'silence', obligation: 'silence', conversation_id: CONV });
  await e.recordSupervisorLifecycle(store, { event_id: captured.row.id, conversation_id: CONV, user: USER, env: { LUNA_SUPERVISOR_STAFF_USER_ID: USER.staff_user_id }, kind: 'stayed_out', payload: { reason: 'late_human_pause' } });
  const terminal = await store.getEvent(captured.row.id);
  assert.equal(terminal.delivery_status, 'stayed_out');
  assert.equal(terminal.outcome, 'late_human_pause');
  assert.equal((await store.listDueEvents(new Date(), { limit: 10 })).length, 0, 'terminal stayed-out event stops retrying');

  const staleStore = e.createMemorySupervisorStore();
  await e.captureSupervisorEvent(staleStore, { source_key: 'stale', kind: 'silence', obligation: 'silence', conversation_id: CONV });
  await e.catchUpSupervisorSources(staleStore, [], { reenable: true, currentState: async () => ({ resolved: true, reason: 'silence_resolved' }) });
  assert.equal(staleStore.events[0].delivery_status, 'stale_resolved');
  assert.equal((await staleStore.listDueEvents(new Date(), { limit: 10 })).length, 0);

  const bound = e.bindCompleteDispatchParams(UUID, 'w', { delivery_status: 'failed' }, new Date());
  assert.match(bound.sql, /delivery_status = 'dispatched'/i, 'watchdog can only complete the currently dispatched attempt');
  const ackStore = e.createMemorySupervisorStore();
  const ack = await e.captureSupervisorEvent(ackStore, { source_key: 'ack', kind: 'silence', obligation: 'silence', conversation_id: CONV });
  await ackStore.updateEvent(ack.row.id, { delivery_status: 'acked', acked_at: new Date().toISOString(), dispatch_worker_id: 'w', dispatch_lease_until: new Date(Date.now()+60000).toISOString() });
  assert.equal(await ackStore.completeDispatch(ack.row.id, 'w', { delivery_status: 'failed' }, new Date()), null);
  assert.equal((await ackStore.getEvent(ack.row.id)).delivery_status, 'acked');

  let response;
  const routes = createStaffSupervisorRoutes({ sendJSON(_r, status, body) { response = { status, body }; }, withPgClient: async (fn) => fn({ query: async (sql) => /SELECT \*/.test(sql) ? { rows: [{ id: UUID, conversation_id: CONV }] } : { rows: [] } }) });
  await routes.handleLifecycle({}, {}, { ...USER, role: 'staff' }, UUID, { conversation_id: CONV, kind: 'stayed_out' });
  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'account_mismatch');

  let mutated = false;
  const delivery = await captureFailedWhatsAppDeliveryStatus({ async query(sql) { if (/WITH target/.test(sql)) { mutated = true; return { rows: [] }; } throw new Error('unexpected'); } }, {
    provider_message_id: 'wamid.acked', client_slug: 'wolfhouse-somo', phone_number_id: 'wh-phone-id', delivery_status: 'delivered',
  }, { env: { NODE_ENV: 'staging', STAFF_API_INGRESS_TENANT_SLUG: 'wolfhouse-somo', SUPERVISOR_EVENT_SOURCE_ENVIRONMENT: 'france-wolfhouse-staging', WHATSAPP_PHONE_NUMBER_ID: 'wh-phone-id' } });
  assert.equal(delivery.skipped, 'non_failed_delivery_status');
  assert.equal(mutated, false, 'ACK callback cannot enter failed-status owner');
  console.log('ok Slice 2 event lifecycle');
}
main().catch((err) => { console.error(err.stack || err); process.exit(1); });
