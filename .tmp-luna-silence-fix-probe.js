'use strict';
const { execSync } = require('child_process');
const https = require('https');
const crypto = require('crypto');

const PHONE = '+491726422307';
const HOST = 'staff-staging.lunafrontdesk.com';

function az(c) { return execSync(c, { encoding: 'utf8' }).trim(); }

const wamid = `wamid.fixprobe.${crypto.randomBytes(8).toString('hex')}`;
const payload = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WH_TEST_ENTRY',
    changes: [{
      value: {
        messaging_product: 'whatsapp',
        metadata: {
          display_phone_number: '15556781234',
          phone_number_id: '1152900101233109',
        },
        contacts: [{ profile: { name: 'Test User' }, wa_id: '491726422307' }],
        messages: [{
          from: '491726422307',
          id: wamid,
          timestamp: Math.floor(Date.now() / 1000).toString(),
          type: 'text',
          text: { body: 'Hello Luna' },
        }],
      },
      field: 'messages',
    }],
  }],
};

const body = JSON.stringify(payload);
const req = https.request({
  hostname: HOST,
  path: '/staff/meta/whatsapp/webhook',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, (res) => {
  let raw = '';
  res.on('data', (c) => { raw += c; });
  res.on('end', () => {
    try {
      const j = JSON.parse(raw);
      console.log(JSON.stringify({
        http_status: res.statusCode,
        open_demo_route: j.open_demo_route,
        send_attempted: j.send_attempted,
        sends_whatsapp: j.sends_whatsapp,
        whatsapp_sent: j.whatsapp_sent,
        live_send_blocked: j.live_send_blocked,
        draft_called: j.draft_called,
        guest_phone_gate_blocked: j.guest_phone_gate_blocked,
        error: j.error,
        gate_code: j.open_demo_result && j.open_demo_result.live_reply_gate_code,
        reply_preview: j.draft && j.draft.suggested_reply
          ? String(j.draft.suggested_reply).slice(0, 120) : null,
        next_action: j.draft && j.draft.next_action,
      }, null, 2));
    } catch {
      console.log('raw:', raw.slice(0, 500));
    }
  });
});
req.on('error', (e) => console.error(e));
req.setTimeout(45000, () => { console.log('TIMEOUT'); req.destroy(); });
req.write(body);
req.end();
