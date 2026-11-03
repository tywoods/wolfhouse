#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('node:fs');
const { createInboxRoutes } = require('./lib/staff-inbox-routes');

const CONV = '11111111-1111-4111-8111-111111111111';
const MSG = '22222222-2222-4222-8222-222222222222';

async function run(metadata, channel = 'whatsapp', userClientSlug = 'wolfhouse-somo') {
  let provider = 0;
  let persisted = 0;
  const pg = { query: async () => ({ rows: [{ conversation_id: CONV, phone: '+15550000001', channel, metadata, owner_client_slug: 'wolfhouse-somo' }] }) };
  const routes = createInboxRoutes({
    sendJSON(_res, status, body) { return { status, body }; },
    send400(_res, error) { return { status: 400, body: { error } }; },
    readBody: async (req) => JSON.stringify(req.body), appendAuditLog() {}, SQL_INJECT_RE: /$a/,
    withPgClient: async (fn) => fn(pg),
    canAccessClient: (user, ownerSlug) => user.client_slug === ownerSlug,
    evaluateGuestReplySendRouteWithPause: async () => { provider += 1; return { result: { success: true, send_performed: true, whatsapp_message_id: 'wamid.real' } }; },
    persistStaffInboxSentThreadMessage: async () => { persisted += 1; return { persisted: true, message_id: MSG }; },
  });
  const response = await routes.handleInboxSendReply({ body: { client_slug: 'wolfhouse-somo', conversation_id: CONV, to: '+15550000001', message_text: 'Supervisor here' }, headers: {} }, {}, { staff_user_id: 'human', role: 'operator', client_slug: userClientSlug });
  return { response, provider, persisted };
}

(async () => {
  const synthetic = await run({ simulator_synthetic: true, open_phone_testing: true, source_owner: 'crowsnest-guest-door' });
  assert.equal(synthetic.provider, 0, 'synthetic Lab send never reaches provider owner');
  assert.equal(synthetic.persisted, 1, 'synthetic intervention uses the established Staff transcript owner');
  assert.equal(synthetic.response.status, 200);
  assert.equal(synthetic.response.body.message_id, MSG);
  assert.equal(synthetic.response.body.external_delivery, false);
  assert.equal(synthetic.response.body.provider_send_performed, false);

  const hermesLab = await run({ open_phone_testing: true, guest_tester_class: 'Simulator' });
  assert.equal(hermesLab.provider, 0, 'Hermes-path Lab chat missing legacy synthetic/source flags never reaches provider');
  assert.equal(hermesLab.persisted, 1, 'Hermes-path Lab intervention persists in the simulator transcript');
  assert.equal(hermesLab.response.status, 200);
  assert.equal(hermesLab.response.body.provider_send_performed, false);
  assert.equal(hermesLab.response.body.external_delivery, false);

  const real = await run({});
  assert.equal(real.provider, 1, 'real WhatsApp retains provider behavior');
  assert.equal(real.persisted, 1);

  const crossTenant = await run({}, 'whatsapp', 'sunset');
  assert.equal(crossTenant.response.status, 403, 'authenticated actor must own the conversation tenant');
  assert.equal(crossTenant.provider, 0, 'cross-tenant actor never reaches the provider');
  assert.equal(crossTenant.persisted, 0, 'cross-tenant actor never writes the transcript');

  const denied = await run({ simulator_synthetic: true, source_owner: 'attacker' });
  assert.equal(denied.provider, 0);
  assert.equal(denied.persisted, 0);
  assert.equal(denied.response.status, 409, 'untrusted synthetic identity fails explicitly');

  const threadSource = fs.readFileSync(require.resolve('./lib/luna-staff-inbox-thread-message'), 'utf8');
  assert.match(threadSource, /deterministicThreadMessageId/);
  assert.match(threadSource, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(threadSource, /idempotency_key: idemKey/);
  console.log('PASS Slice 1C channel-aware intervention: synthetic persists, provider zero, real provider unchanged');
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
