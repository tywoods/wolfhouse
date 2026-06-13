'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');

const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const GUEST_PHONE = '+491726422307';

function az(cmdStr) {
  return execSync(cmdStr, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function token() {
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
}
function postJson(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: STAFF_HOST,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${token()}`,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, json: { raw } }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function turn(msg, ctx, i, flags = {}) {
  const wamid = `wamid.s56k-repro-${Date.now()}-t${i}`;
  const payload = {
    source: 'n8n_open_demo_whatsapp_harness',
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    phone_number_id: '1152900101233109',
    guest_phone: GUEST_PHONE,
    guest_email: 'open-demo+491726422307@example.test',
    message_text: msg,
    wamid,
    inbound_message_id: wamid,
    received_at: new Date().toISOString(),
    reference_date: '2026-06-12',
    ...(ctx ? { guest_context: ctx } : {}),
    ...(flags.hold ? { create_demo_hold_draft_confirmed: true } : {}),
    ...(flags.bed ? { assign_demo_bed_confirmed: true } : {}),
    ...(flags.stripe ? { create_stripe_test_link_confirmed: true } : {}),
    ...(flags.live ? { send_live_reply_confirmed: true } : {}),
  };
  const { status, json } = await postJson(OPEN_DEMO_WHATSAPP_ROUTE, payload);
  const body = json.body || json;
  const review = body.review || {};
  const result = review.result || {};
  const pc = review.payment_choice || {};
  const plan = review.hold_payment_draft_plan || {};
  return {
    status,
    lane: result.message_lane,
    composer: review.composer_state,
    pc: pc.payment_choice,
    pcReady: pc.payment_choice_ready,
    handoff: result.safe_handoff_required,
    fields: result.extracted_fields || {},
    quote: review.quote,
    planKind: plan.payment_kind,
    planCents: plan.payment_amount_cents,
    stripe: body.stripeLink || body.stripe_link,
    bookingWrite: body.bookingWrite,
    reply: (review.proposed_luna_reply || '').slice(0, 280),
    next: body.slim_guest_context_for_next_turn,
  };
}

(async () => {
  const steps = [
    'I would like to book from Sept 1st to the 15th for 2 people',
    'Malibu please',
    'Deposit and yes transfer to and from Santander',
    'Arrive day of checkin at noon and leave day of checkout at noon also',
    'Deposit please!',
    'Yes please send the link',
    'No the deposit link',
    'Ok im ready',
  ];
  let ctx = null;
  const report = [];
  for (let i = 0; i < steps.length; i++) {
    const flags = (i === 5) ? { hold: true, bed: true, stripe: true } : {};
    const t = await turn(steps[i], ctx, i, flags);
    report.push({ step: i, msg: steps[i], ...t });
    ctx = t.next || ctx;
    console.log(JSON.stringify({
      i,
      msg: steps[i].slice(0, 40),
      composer: t.composer,
      pc: t.pc,
      pcReady: t.pcReady,
      planKind: t.planKind,
      planCents: t.planCents,
      quote: t.quote && { status: t.quote.quote_status, total: t.quote.quote_total_cents, dep: t.quote.deposit_options },
      reply: t.reply,
    }, null, 2));
  }
  require('fs').writeFileSync('.tmp-stage56k-payment-flow-repro.json', JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
