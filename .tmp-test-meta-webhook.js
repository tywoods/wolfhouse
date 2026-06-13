'use strict';
const https = require('https');

// Real Meta webhook payload format
const payload = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WH_TEST_ENTRY',
    changes: [{
      value: {
        messaging_product: 'whatsapp',
        metadata: {
          display_phone_number: '15556781234',
          phone_number_id: '1152900101233109'
        },
        contacts: [{
          profile: { name: 'Test User' },
          wa_id: '491726422307'
        }],
        messages: [{
          from: '491726422307',
          id: `wamid.test_${Date.now()}`,
          timestamp: Math.floor(Date.now() / 1000).toString(),
          type: 'text',
          text: { body: 'Hello!' }
        }]
      },
      field: 'messages'
    }]
  }]
};

const body = JSON.stringify(payload);
const options = {
  hostname: 'staff-staging.lunafrontdesk.com',
  path: '/staff/meta/whatsapp/webhook',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (d) => { data += d; });
  res.on('end', () => {
    console.log('status:', res.statusCode);
    try {
      const j = JSON.parse(data);
      console.log('success:', j.success);
      console.log('open_demo_route:', j.open_demo_route);
      console.log('whatsapp_sent:', j.whatsapp_sent || j.sends_whatsapp);
      console.log('live_send_blocked:', j.live_send_blocked);
      if (j.open_demo_result) {
        console.log('gate_status:', j.open_demo_result.live_reply_gate_code || 'passed');
        console.log('proposed_reply:', (j.open_demo_result.proposed_next_action || ''));
      }
      if (j.draft) {
        console.log('draft suggested_reply:', (j.draft.suggested_reply || '').substring(0, 100));
      }
      if (j.error) console.log('error:', j.error);
    } catch(e) {
      console.log('raw:', data.substring(0, 300));
    }
  });
});
req.on('error', (e) => console.error('request error:', e.message));
req.setTimeout(30000, () => { console.log('TIMEOUT'); req.destroy(); });
req.write(body);
req.end();
