'use strict';
const { execSync } = require('child_process');
const https = require('https');

const token = execSync('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv', { encoding: 'utf8' }).trim();

const body = JSON.stringify({
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  guest_phone: '+491726422307',
  message_text: 'Hello!',
  inbound_message_id: `probe-hello-${Date.now()}`,
});

const req = https.request({
  hostname: 'staff-staging.lunafrontdesk.com',
  path: '/staff/bot/guest-inbound-review-dry-run',
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
    const r = j.review || {};
    const result = r.result || {};
    console.log(JSON.stringify({
      gate_status: r.automation_gate && r.automation_gate.gate_status,
      gate_reasons: r.automation_gate && r.automation_gate.gate_reasons,
      proposed_next_action: r.proposed_next_action,
      proposed_luna_reply: r.proposed_luna_reply,
      message_lane: result.message_lane,
      greeting_only: result.greeting_only,
      safe_handoff_required: result.safe_handoff_required,
      handoff_reasons: result.handoff_reasons,
      intake_state: result.intake_state,
      brain_intent: result.conversation_brain && result.conversation_brain.intent,
    }, null, 2));
  });
});
req.write(body);
req.end();
