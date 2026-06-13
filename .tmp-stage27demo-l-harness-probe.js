'use strict';
const https = require('https');
require('dotenv').config({ path: require('path').join(__dirname, 'infra', '.env') });

const TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN;

function buildPayload(opts, messageText, guestContext, turnIndex, isLastTurn) {
  const wamid = `wamid.demo-${Date.now()}-turn${turnIndex + 1}`;
  const payload = {
    source: 'harness_probe',
    client_slug: opts.clientSlug,
    channel: 'whatsapp',
    phone_number_id: opts.phoneNumberId,
    guest_phone: opts.guestPhone,
    message_text: messageText,
    wamid,
    inbound_message_id: wamid,
    received_at: new Date().toISOString(),
    reference_date: opts.referenceDate,
    guest_email: opts.guestEmail,
  };
  if (guestContext) payload.guest_context = guestContext;
  if (isLastTurn) {
    payload.create_demo_hold_draft_confirmed = true;
    payload.assign_demo_bed_confirmed = true;
  }
  return payload;
}

const opts = {
  clientSlug: 'wolfhouse-somo',
  phoneNumberId: '1152900101233109',
  guestPhone: '+34600995557',
  guestEmail: 'open-demo+34600995557@example.test',
  referenceDate: '2026-06-08',
  createDemoHoldDraftConfirmed: true,
  assignDemoBedConfirmed: true,
};
const turns = [
  'Hi, we are 2 people interested in the Malibu package',
  'August 26 to September 2',
  'Deposit is fine',
];

function post(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: 'staff-staging.lunafrontdesk.com',
      path: '/staff/bot/open-demo-whatsapp-inbound-dry-run',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Luna-Bot-Token': TOKEN,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(JSON.parse(buf)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  let ctx = null;
  for (let i = 0; i < turns.length; i++) {
    const isLast = i === turns.length - 1;
    const payload = buildPayload(opts, turns[i], ctx, i, isLast);
    const body = await post(payload);
    console.log(JSON.stringify({
      turn: i + 1,
      write_status: body.write_status,
      assignment_write_status: body.assignment_write_status,
      booking_code: body.booking_code,
      intake_state: body.slim_guest_context_for_next_turn?.intake_state,
      booking_intake_ready: body.slim_guest_context_for_next_turn?.booking_intake_ready,
      message_lane: body.slim_guest_context_for_next_turn?.message_lane,
    }));
    ctx = body.slim_guest_context_for_next_turn || ctx;
  }
})().catch((e) => { console.error(e); process.exit(1); });
