#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const d = require('./lib/luna-supervisor-lookout-detectors');
const e = require('./lib/staff-supervisor-events');
const { createStaffSupervisorRoutes } = require('./lib/staff-supervisor-routes');
const { captureFailedWhatsAppDeliveryStatus } = require('./lib/luna-supervisor-event-emitter');

const UUID = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const USER = { staff_user_id: '33333333-3333-4333-8333-333333333333', role: 'admin', client_slug: 'wolfhouse-somo' };

async function main() {
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
