'use strict';
const { execSync } = require('child_process');
const https = require('https');
const crypto = require('crypto');

const token = execSync('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv', { encoding: 'utf8' }).trim();
const wamid = `wamid.livehello.${crypto.randomBytes(8).toString('hex')}`;
const body = JSON.stringify({
  source: 'probe_live_hello',
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  phone_number_id: '1152900101233109',
  guest_phone: '+491726422307',
  message_text: 'Hello!',
  wamid,
  inbound_message_id: wamid,
  send_live_reply_confirmed: true,
});

const req = https.request({
  hostname: 'staff-staging.lunafrontdesk.com',
  path: '/staff/bot/open-demo-whatsapp-inbound-dry-run',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Authorization: `Bearer ${token}`,
  },
}, (res) => {
  let raw = '';
  res.on('data', (c) => { raw += c; });
  res.on('end', () => {
    const j = JSON.parse(raw);
    console.log(JSON.stringify({
      status: res.statusCode,
      sends_whatsapp: j.sends_whatsapp,
      whatsapp_sent: j.whatsapp_sent,
      live_send_blocked: j.live_send_blocked,
      proposed_reply: j.review && j.review.proposed_luna_reply && String(j.review.proposed_luna_reply).slice(0, 120),
      next_action: j.review && j.review.proposed_next_action,
      live_reply: j.live_reply,
    }, null, 2));
  });
});
req.write(body);
req.end();
