#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const { createInboxRoutes } = require('./lib/staff-inbox-routes');

const CONV = '11111111-1111-4111-8111-111111111111';
const MSG = '22222222-2222-4222-8222-222222222222';

async function run(metadata, channel = 'whatsapp') {
  let provider = 0;
  let persisted = 0;
  const pg = { query: async () => ({ rows: [{ conversation_id: CONV, phone: '+999000000001', channel, metadata }] }) };
  const routes = createInboxRoutes({
    sendJSON(_res, status, body) { return { status, body }; },
    send400(_res, error) { return { status: 400, body: { error } }; },
    readBody: async (req) => JSON.stringify(req.body), appendAuditLog() {}, SQL_INJECT_RE: /$a/,
    withPgClient: async (fn) => fn(pg),
    evaluateGuestReplySendRouteWithPause: async () => { provider += 1; return { result: { success: true, send_performed: true, whatsapp_message_id: 'wamid.real' } }; },
    persistStaffInboxSentThreadMessage: async () => { persisted += 1; return { persisted: true, message_id: MSG }; },
  });
  const response = await routes.handleInboxSendReply({ body: { client_slug: 'wolfhouse-somo', conversation_id: CONV, to: '+999000000001', message_text: 'Supervisor here' }, headers: {} }, {}, { staff_user_id: 'human', role: 'operator' });
  return { response, provider, persisted };
}

(async () => {
  const synthetic = await run({ simulator_synthetic: true, open_phone_testing: true, source_owner: 'crowsnest-guest-door' });
  assert.equal(synthetic.provider, 0, 'synthetic Lab send never reaches provider owner');
  assert.equal(synthetic.persisted, 1, 'synthetic intervention uses the established Staff transcript owner');
  assert.equal(synthetic.response.status, 200);
  assert.equal(synthetic.response.body.message_id, MSG);
  assert.equal(synthetic.response.body.external_delivery, false);

  const real = await run({});
  assert.equal(real.provider, 1, 'real WhatsApp retains provider behavior');
  assert.equal(real.persisted, 1);

  const denied = await run({ simulator_synthetic: true, source_owner: 'attacker' });
  assert.equal(denied.provider, 0);
  assert.equal(denied.persisted, 0);
  assert.equal(denied.response.status, 409, 'untrusted synthetic identity fails explicitly');
  console.log('PASS Slice 1C channel-aware intervention: synthetic persists, provider zero, real provider unchanged');
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
