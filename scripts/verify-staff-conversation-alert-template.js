'use strict';
const assert = require('assert/strict');
const { sendStaffWhatsAppTemplate } = require('./lib/luna-whatsapp-provider');

async function main() {
  const baseEnv = {
    WHATSAPP_DRY_RUN: 'false',
    WHATSAPP_CLOUD_ACCESS_TOKEN: 'synthetic-test-token',
    WHATSAPP_PHONE_NUMBER_ID: 'sender-fixture',
    WHATSAPP_API_BASE_URL: 'https://graph.example.test/v21.0',
  };
  let calls = 0;
  let captured;
  const accepted = await sendStaffWhatsAppTemplate({
    to: '+' + '34900000001', sender_phone_number_id: 'sender-fixture',
    template_name: 'staff_alert_fixture', language_code: 'en',
    components: [{ type: 'body', parameters: [{ type: 'text', text: 'New conversation' }] }],
    idempotency_key: 'fixture-key',
  }, baseEnv, { async fetch(url, init) {
    calls += 1; captured = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, async json() { return { messages: [{ id: 'wamid.fixture' }] }; } };
  } });
  assert.equal(accepted.send_performed, true);
  assert.equal(calls, 1);
  assert.equal(captured.body.type, 'template');
  assert.equal(captured.body.template.name, 'staff_alert_fixture');
  assert.equal(captured.body.template.language.code, 'en');
  assert.deepEqual(captured.body.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'New conversation' }] }]);
  console.log('PASS approved template payload is bound to exact sender/name/language/components');

  calls = 0;
  const wrongSender = await sendStaffWhatsAppTemplate({
    to: '+' + '34900000001', sender_phone_number_id: 'other-sender',
    template_name: 'staff_alert_fixture', language_code: 'en', components: [],
  }, baseEnv, { async fetch() { calls += 1; throw new Error('must not fetch'); } });
  assert.equal(wrongSender.send_performed, false);
  assert.equal(wrongSender.blocked_reason, 'staff_template_sender_mismatch');
  assert.equal(calls, 0);
  console.log('PASS mismatched sender blocks before fetch');

  calls = 0;
  const rejected = await sendStaffWhatsAppTemplate({
    to: '+' + '34900000001', sender_phone_number_id: 'sender-fixture',
    template_name: 'staff_alert_fixture', language_code: 'en', components: [],
  }, baseEnv, { async fetch() {
    calls += 1;
    return { ok: false, status: 400, async json() { return { error: { message: 'fixture reject' } }; } };
  } });
  assert.equal(rejected.send_performed, false);
  assert.equal(rejected.blocked_reason, 'staff_template_provider_rejected');
  assert.equal(rejected.outcome, 'definitive_failure');
  assert.equal(calls, 1);
  console.log('PASS provider rejection never falls back to text or a second request');

  const input = {
    to: '+' + '34900000001', sender_phone_number_id: 'sender-fixture',
    template_name: 'staff_alert_fixture', language_code: 'en', components: [],
  };
  const stalled = await sendStaffWhatsAppTemplate(input, baseEnv, {
    timeout_ms: 10,
    fetch: async () => ({ ok: true, status: 200, json: async () => new Promise(() => {}) }),
  });
  assert.equal(stalled.outcome, 'ambiguous');
  assert.equal(stalled.blocked_reason, 'staff_template_provider_timeout');
  console.log('PASS stalled response body is bounded and ambiguous');

  const malformed = await sendStaffWhatsAppTemplate(input, baseEnv, {
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ messages: [] }) }),
  });
  assert.equal(malformed.outcome, 'ambiguous');
  assert.equal(malformed.send_performed, false);
  console.log('PASS 2xx without Meta message ID is ambiguous');
  console.log('staff conversation alert template: 5/5 passed');
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
