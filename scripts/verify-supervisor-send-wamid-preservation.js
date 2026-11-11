#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { createInboxRoutes } = require('./lib/staff-inbox-routes');
const { lookupSupervisorDelivery, reconcileSupervisorDeliveries } = require('./lib/staff-supervisor-events');
const CONV = '11111111-1111-4111-8111-111111111111';

(async () => {
  // Exercise the real route; only SQL, transport and audit boundaries are fake.
  for (const existing of ['wamid.original-guest-message', null]) {
    const event = { id: 'event', metadata: { retained: true, guest_delivered: true, ...(existing ? { guest_whatsapp_message_id: existing } : {}) } };
    const routes = createInboxRoutes({
      sendJSON: (_res, status, body) => ({ status, body }),
      send400: (_res, error) => ({ status: 400, body: { error } }),
      readBody: async req => JSON.stringify(req.body),
      appendAuditLog() {}, SQL_INJECT_RE: /$a/,
      withPgClient: async fn => fn({ query: async sql => ({ rows: /FROM conversations/.test(sql)
        ? [{ conversation_id: CONV, phone: '+1234', channel: 'whatsapp' }] : [] }) }),
      isSupervisorAccount: () => true,
      admitFromRequest: async () => ({ ok: true, incident: { id: 'incident', event_id: event.id } }),
      evaluateGuestReplySendRouteWithPause: async () => ({ status: 200, result: {
        success: true, send_performed: true, whatsapp_message_id: 'wamid.supervisor-reply',
      } }),
      persistStaffInboxSentThreadMessage: async () => ({ persisted: true, message_id: 'message', whatsapp_message_id: 'wamid.supervisor-reply' }),
      createPgSupervisorStore: () => ({ getEvent: async () => event, updateEvent: async (_id, patch) => Object.assign(event, patch) }),
    });
    const reply = await routes.handleInboxSendReply({ body: { client_slug: 'wolfhouse-somo', conversation_id: CONV, message_text: 'hello' } }, {}, { staff_user_id: 'supervisor' });
    assert.equal(reply.status, 200);
    assert.equal(event.metadata.guest_whatsapp_message_id, existing || 'wamid.supervisor-reply', 'supervisor send must not overwrite existing guest message id');
    assert.equal(event.metadata.retained, true);
    assert.equal(event.metadata.provider_accepted, true);
    const receipts = new Set(existing ? [existing] : []);
    const lookedUp = [];
    const pg = { query: async (_sql, values) => {
      lookedUp.push(values[0]);
      return { rows: receipts.has(values[0])
        ? [{ provider_message_id: values[0], delivered_at: '2026-11-11T12:00:00Z' }] : [] };
    } };
    const store = {
      listEvents: async () => [event],
      updateEvent: async (_id, patch) => Object.assign(event, patch),
    };
    const reconcile = () => reconcileSupervisorDeliveries(store, {
      deliveryLookup: ev => lookupSupervisorDelivery(pg, ev),
    });
    assert.equal((await reconcile()).reconciled, 0, 'old receipt must not prove supervisor reply delivery');
    assert.equal(event.delivery_status, 'accepted_pending_delivery');
    assert.equal(event.metadata.guest_delivered, false);
    assert.equal(event.metadata.supervisor_outbound_message_id, 'wamid.supervisor-reply');
    assert.equal(event.metadata.supervisor_outbound_incident_id, 'incident');
    receipts.add('wamid.supervisor-reply');
    assert.equal((await reconcile()).reconciled, 1);
    assert.equal(event.delivery_status, 'acked');
    assert.equal(event.metadata.guest_delivered, true);
    assert.deepEqual(lookedUp, ['wamid.supervisor-reply', 'wamid.supervisor-reply']);
    assert.equal(event.metadata.guest_whatsapp_message_id, existing || 'wamid.supervisor-reply');
  }
  console.log('PASS item10: original id retained; only supervisor outbound receipt reconciles its send/incident');
})().catch(err => { console.error(err); process.exitCode = 1; });
