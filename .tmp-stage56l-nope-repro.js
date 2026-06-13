'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');

const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const GUEST_PHONE = '+491726422307';

function az(c) { return execSync(c, { encoding: 'utf8' }).trim(); }
function token() {
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
}
function post(p) {
  return new Promise((res, rej) => {
    const b = JSON.stringify(p);
    const r = https.request({
      hostname: STAFF_HOST, path: OPEN_DEMO_WHATSAPP_ROUTE, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), Authorization: `Bearer ${token()}` },
    }, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => res(JSON.parse(d))); });
    r.on('error', rej); r.write(b); r.end();
  });
}
async function turn(msg, ctx, i) {
  const j = await post({
    source: 'n8n_open_demo_whatsapp_harness', client_slug: 'wolfhouse-somo', channel: 'whatsapp',
    phone_number_id: '1152900101233109', guest_phone: GUEST_PHONE, message_text: msg,
    wamid: `wamid.nope-${Date.now()}-${i}`, inbound_message_id: `wamid.nope-${Date.now()}-${i}`,
    received_at: new Date().toISOString(), reference_date: '2026-06-12',
    ...(ctx ? { guest_context: ctx } : {}),
  });
  const body = j.body || j;
  const rv = body.review || {};
  const r = rv.result || {};
  const pc = rv.payment_choice || {};
  return {
    lane: r.message_lane,
    handoff: r.safe_handoff_required,
    composer: rv.composer_state,
    pc: pc.payment_choice,
    pcReady: pc.payment_choice_ready,
    readyProceed: r.extracted_fields && r.extracted_fields.booking_ready_to_proceed,
    quote: rv.quote && rv.quote.quote_status,
    reply: (rv.proposed_luna_reply || '').slice(0, 220),
    next: body.slim_guest_context_for_next_turn,
  };
}
(async () => {
  const steps = [
    'Let book please',
    'sept 1st to the 15th',
    'just 2 of us',
    'malibu please',
    'yes transfer please from and to santander',
    'We arrive at noon and leave at noon',
    'nope, thats it',
  ];
  let ctx = null;
  for (let i = 0; i < steps.length; i++) {
    const t = await turn(steps[i], ctx, i);
    console.log(JSON.stringify({ i, msg: steps[i], ...t }, null, 2));
    ctx = t.next || ctx;
  }
})().catch((e) => { console.error(e); process.exit(1); });
