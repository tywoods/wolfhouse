#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { recordSupervisorOutcome } = require('./lib/staff-supervisor-events');
(async () => {
  const event = { id: 'event', conversation_id: 'conversation', obligation: 'guest_message', outcome: 'stayed_out', metadata: {} };
  const incident = { id: 'incident', event_id: event.id, conversation_id: event.conversation_id, status: 'open', lease_token: 'lease' };
  let writes = 0;
  const store = {
    getEvent: async () => event, getIncident: async () => incident,
    updateEvent: async (_id, patch) => { writes++; Object.assign(event, patch); return event; },
    updateIncident: async (_id, patch) => Object.assign(incident, patch),
  };
  const input = { event_id: event.id, conversation_id: event.conversation_id, incident_id: incident.id, lease_token: 'lease', outcome: 'replied' };
  const refused = await recordSupervisorOutcome(store, input);
  assert.equal(refused.ok, false, 'an agent claim must not record replied without an authoritative delivery receipt');
  assert.equal(refused.error, 'guest_delivery_unconfirmed');
  assert.equal(writes, 0);
  assert.equal(event.outcome, 'stayed_out');
  event.metadata.guest_delivered = true;
  const accepted = await recordSupervisorOutcome(store, input);
  assert.equal(accepted.ok, true);
  assert.equal(event.outcome, 'replied');
  assert.equal(incident.status, 'closed');
  console.log('PASS item4: unconfirmed replied claim refused; authoritative delivery accepted');
})().catch(err => { console.error(err); process.exitCode = 1; });
