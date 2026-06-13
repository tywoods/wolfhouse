'use strict';

const { execSync } = require('child_process');
const https = require('https');

const token = execSync(
  'az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv',
  { encoding: 'utf8' },
).trim();

const body = JSON.stringify({
  client_slug: 'wolfhouse-somo',
  channel: 'staff_review',
  message_text: 'stay only',
  guest_phone: '+346009971001',
  dry_run: true,
  reference_date: '2026-06-08',
  guest_context: {
    extracted_fields: {
      check_in: '2026-08-01',
      check_out: '2026-08-08',
      guest_count: 2,
    },
  },
  automation_gate_context: {
    public_guest_automation_enabled: false,
    whatsapp_dry_run: true,
    live_send_allowed: false,
  },
});

function post(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'staff-staging.lunafrontdesk.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Luna-Bot-Token': token,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

post('/staff/bot/guest-automation-review-dry-run').then((out) => {
  const review = out.body.review || {};
  const result = review.result || {};
  const fields = result.extracted_fields || {};
  console.log(JSON.stringify({
    http: out.status,
    success: out.body.success,
    message_lane: result.message_lane,
    package_interest: fields.package_interest,
    guest_name: fields.guest_name,
    reply_snip: String(review.proposed_luna_reply || '').slice(0, 200),
    error: out.body.error,
  }, null, 2));
  process.exit(out.status === 200 && fields.package_interest === 'malibu' && fields.guest_name !== 'stay only' ? 0 : 1);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
