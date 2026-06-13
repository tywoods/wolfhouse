'use strict';
/** Stage 45i 3-turn staging smoke — temp */
const https = require('https');
const { execSync } = require('child_process');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');

function token() {
  return execSync('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv', { encoding: 'utf8' }).trim();
}
function post(payload) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'staff-staging.lunafrontdesk.com', path: OPEN_DEMO_WHATSAPP_ROUTE, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Luna-Bot-Token': token() },
    }, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
    req.on('error', rej); req.write(body); req.end();
  });
}
function buildPayload(opts, msg, ctx, i, last) {
  const wamid = `wamid.demo-45i-${Date.now()}-t${i + 1}`;
  const p = { source: 'stage45i-smoke', client_slug: 'wolfhouse-somo', channel: 'whatsapp', phone_number_id: '1152900101233109', guest_phone: opts.phone, guest_email: opts.email, message_text: msg, wamid, inbound_message_id: wamid, received_at: new Date().toISOString(), reference_date: '2026-06-08' };
  if (ctx) p.guest_context = ctx;
  if (last) { p.create_demo_hold_draft_confirmed = true; p.assign_demo_bed_confirmed = true; p.create_stripe_test_link_confirmed = true; }
  return p;
}
(async () => {
  const opts = { phone: '+34600995572', email: 'open-demo+34600995572@example.test' };
  const msgs = ['Hi, we are 2 people interested in the Malibu package', 'August 18 to August 25', 'Deposit is fine'];
  let ctx = null;
  const turns = [];
  for (let i = 0; i < msgs.length; i++) {
    const body = await post(buildPayload(opts, msgs[i], ctx, i, i === 2));
    turns.push({ payment_choice_ready: body.review?.payment_choice?.payment_choice_ready, write_status: body.write_status, addons_pending: body.review?.quote?.addons_pending_after_quote, addons_skipped: body.review?.result?.extracted_fields?.addons_skipped, stripe: body.stripe_link_created });
    ctx = body.slim_guest_context_for_next_turn || ctx;
  }
  console.log(JSON.stringify({ turns, final: turns[2] }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
