'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { proxySimulatorTranscript, LIVE_SIMULATOR_TRANSCRIPT_ROUTE } = require('./lib/crowsnest/crowsnest-live-simulator');

(async () => {
  const token = 's'.repeat(32);
  const env = {
    CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN: 'https://staff.test',
    CROWSNEST_WOLFHOUSE_STAGING_STATUS_TOKEN: token,
  };
  const id = '11111111-1111-4111-8111-111111111111';
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return { ok: true, status: 200, json: async () => ({ success: true, client_slug: 'wolfhouse-somo', conversation_id: id, messages: [
      { message_id: '22222222-2222-4222-8222-222222222222', direction: 'outbound', body: 'hello' },
    ] }) };
  };
  const result = await proxySimulatorTranscript({ tenant: 'wolfhouse', client_slug: 'attacker', conversation_id: id }, { env, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.external_transport, false);
  assert.equal(request.url, `https://staff.test/staff/inbox/simulator-transcript/${id}`);
  assert.equal(request.init.headers['x-crowsnest-status-token'], token);
  assert.equal(request.url.includes('attacker'), false, 'caller tenant claim is never forwarded');
  assert.equal((await proxySimulatorTranscript({ tenant: 'wolfhouse', conversation_id: 'bad' }, { env, fetchImpl })).status, 400);
  assert.equal((await proxySimulatorTranscript({ tenant: 'luna-v3', conversation_id: id }, { env, fetchImpl })).status, 503);

  const page = fs.readFileSync(path.join(__dirname, 'lib/crowsnest/crowsnest-page.js'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, 'crowsnest-api.js'), 'utf8');
  const staff = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  assert.equal(LIVE_SIMULATOR_TRANSCRIPT_ROUTE, '/api/live-simulator/transcript');
  assert.match(api, /isBrowserUiAuthorized[\s\S]*proxySimulatorTranscript/);
  assert.match(page, /Staff is transcript authority/);
  assert.match(page, /new Set\(state\.messages\.map/);
  assert.ok(page.indexOf("thread.appendChild(wrap)") < page.indexOf('void receiptRendered(item)'), 'receipt follows DOM attachment');
  assert.match(staff, /authorizeCrowsnestStatusRead/);
  assert.match(staff, /open_phone_testing[\s\S]*guest_tester_class/);
  assert.match(staff, /cl\.slug=\$2/);
  assert.match(staff, /external_transport: false/);
  console.log('PASS Slice 1C Staff projection reconnect, UUID dedupe, post-render receipt, tenant/Lab fences, zero transport');
})().catch((err) => { console.error(err); process.exit(1); });
