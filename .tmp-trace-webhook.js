'use strict';
const https = require('https');

const msgId = `wamid.trace_${Date.now()}`;
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
        contacts: [{ profile: { name: 'Test User' }, wa_id: '491726422307' }],
        messages: [{
          from: '491726422307',
          id: msgId,
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
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (d) => { data += d; });
  res.on('end', () => {
    console.log('HTTP status:', res.statusCode);
    try {
      const j = JSON.parse(data);
      console.log('Full response:', JSON.stringify(j, null, 2));
    } catch(e) {
      console.log('raw:', data.substring(0, 500));
    }
  });
});
req.on('error', (e) => console.error('error:', e.message));
req.setTimeout(30000, () => { console.log('TIMEOUT'); req.destroy(); });
req.write(body);
req.end();
