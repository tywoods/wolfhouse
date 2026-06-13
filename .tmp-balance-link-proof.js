'use strict';
const https = require('https');

const payload = {
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: '1152900101233109' },
        contacts: [{ profile: { name: 'Ty' }, wa_id: '491726422307' }],
        messages: [{
          from: '491726422307',
          id: `wamid.bal_${Date.now()}`,
          timestamp: Math.floor(Date.now() / 1000).toString(),
          type: 'text',
          text: { body: 'can you send the full payment link?' },
        }],
      },
      field: 'messages',
    }],
  }],
};

const body = JSON.stringify(payload);
const req = https.request({
  hostname: 'staff-staging.lunafrontdesk.com',
  path: '/staff/meta/whatsapp/webhook',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, (res) => {
  let data = '';
  res.on('data', (d) => { data += d; });
  res.on('end', () => {
    const j = JSON.parse(data);
    const r = j.open_demo_result || {};
    console.log('success:', j.success);
    console.log('whatsapp_sent:', j.whatsapp_sent || j.sends_whatsapp);
    console.log('balance_due:', r.balance_due_cents || (j.send_result && j.send_result.suggested_reply));
    console.log('open_demo balance link:', r.stripe_link_created, r.payment_link_sent);
    if (j.open_demo_result) {
      console.log('effective_flags:', JSON.stringify(r.effective_flags));
    }
    if (j.send_result) console.log('send_reply:', (j.send_result.suggested_reply || j.suggested_reply || '').substring(0, 120));
    if (j.open_demo_result && j.open_demo_result.proposed_next_action) console.log('next:', j.open_demo_result.proposed_next_action);
    const sr = j.send_result || {};
    if (sr.suggested_reply) console.log('payment msg:', sr.suggested_reply.substring(0, 150));
    console.log('FULL:', JSON.stringify(j, null, 2).substring(0, 3000));
  });
});
req.on('error', (e) => console.error(e.message));
req.setTimeout(45000, () => { console.log('TIMEOUT'); req.destroy(); });
req.write(body);
req.end();
