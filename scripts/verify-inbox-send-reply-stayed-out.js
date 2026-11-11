'use strict';

// Offline regression: admission denial is a no-send receipt, never a reply.
const assert = require('node:assert/strict');
const { createInboxRoutes } = require('./lib/staff-inbox-routes');
const { admitSupervisorBusinessAction } = require('./lib/staff-supervisor-events');

(async () => {
  const conversationId = '3457baf6-0000-4000-8000-000000000001'; // fixture, not a production UUID
  const user = { staff_user_id: 'supervisor-fixture', role: 'admin' };
  const incident = {
    id: 'incident-fixture', event_id: 'event-fixture', status: 'open',
    conversation_id: conversationId, staff_user_id: user.staff_user_id,
    lease_token: 'fixture-lease', lease_until: '2099-01-01T00:00:00Z',
  };
  const audit = [];
  const response = {};
  let admissions = 0;
  const routes = createInboxRoutes({
    SQL_INJECT_RE: /[';]/,
    readBody: async () => JSON.stringify({
      client_slug: 'wolfhouse-somo', conversation_id: conversationId,
      message_text: 'Offline fixture only', lease_token: incident.lease_token,
    }),
    sendJSON: (res, status, body) => Object.assign(res, { status, body }),
    send400: () => assert.fail('valid fixture must not fail parsing'),
    appendAuditLog: (entry) => audit.push(entry),
    withPgClient: async (fn) => fn({
      query: async () => ({ rows: [{ id: conversationId, phone: '+15555550100', channel: 'whatsapp' }] }),
    }),
    isSupervisorAccount: () => true,
    admitFromRequest: async (req, actor, extra) => {
      admissions += 1;
      return admitSupervisorBusinessAction({ getOpenIncident: async () => incident }, {
        ...extra, user: actor, lease_token: extra.body.lease_token,
        env: { LUNA_SUPERVISOR_STAFF_USER_ID: user.staff_user_id },
        factsLoaded: true, lunaMode: 'draft', pause: { paused: false },
      });
    },
    evaluateGuestReplySendRouteWithPause: async () => assert.fail('must not evaluate or send'),
    persistStaffInboxSentThreadMessage: async () => assert.fail('must not persist a reply'),
    createPgSupervisorStore: () => assert.fail('must not mark provider acceptance'),
  });
  await routes.handlers.send_reply({}, response, user);
  assert.equal(admissions, 1);
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'stayed_out');
  assert.equal(response.body.success, false);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].error, 'stayed_out');
  for (const receipt of [response.body, audit[0]]) {
    assert.equal(receipt.outcome, 'stayed_out');
    assert.equal(receipt.send_performed, false);
    assert.equal(receipt.provider_send_performed, false);
    assert.equal(receipt.external_delivery, false);
  }
  console.log('PASS: stayed_out 409 records and returns an explicit no-send receipt');
})().catch((err) => { console.error(err); process.exitCode = 1; });
