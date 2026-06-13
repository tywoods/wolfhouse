'use strict';
const https = require('https');
const { execSync } = require('child_process');
const path = require('path');
const { Client } = require('pg');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');

function buildPayload(opts, messageText, guestContext, turnIndex, isLastTurn) {
  const wamid = opts.wamid && turnIndex === 0
    ? opts.wamid
    : `wamid.demo-${Date.now()}-turn${turnIndex + 1}`;
  const payload = {
    source: 'n8n_open_demo_whatsapp_harness',
    client_slug: opts.clientSlug,
    channel: 'whatsapp',
    phone_number_id: opts.phoneNumberId,
    guest_phone: opts.guestPhone,
    message_text: messageText,
    wamid,
    inbound_message_id: wamid,
    received_at: new Date().toISOString(),
    reference_date: opts.referenceDate,
  };
  if (opts.contactName) payload.contact_name = opts.contactName;
  if (opts.guestEmail) payload.guest_email = opts.guestEmail;
  if (guestContext) payload.guest_context = guestContext;
  if (opts.createDemoHoldDraftConfirmed && isLastTurn) payload.create_demo_hold_draft_confirmed = true;
  if (opts.assignDemoBedConfirmed && isLastTurn) payload.assign_demo_bed_confirmed = true;
  if (opts.createStripeTestLinkConfirmed && isLastTurn) payload.create_stripe_test_link_confirmed = true;
  return payload;
}

const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const PHONE = '+34600995561';

function az(c) { return execSync(c, { encoding: 'utf8' }).trim(); }
function token() {
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
}

function postJson(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: STAFF_HOST,
      path: OPEN_DEMO_WHATSAPP_ROUTE,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Luna-Bot-Token': token(),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve({ success: false, raw }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runTurn(opts, msg, guestContext, turnIndex, isLast) {
  const payload = buildPayload(opts, msg, guestContext, turnIndex, isLast);
  const body = await postJson(payload);
  return { body, nextContext: body.slim_guest_context_for_next_turn || null };
}

(async () => {
  const proofStart = new Date().toISOString();
  const opts = {
    baseUrl: `https://${STAFF_HOST}`,
    clientSlug: 'wolfhouse-somo',
    phoneNumberId: '1152900101233109',
    guestPhone: PHONE,
    guestEmail: 'open-demo+34600995561@example.test',
    referenceDate: '2026-06-08',
    sendLiveReplyConfirmed: false,
    createDemoHoldDraftConfirmed: false,
    assignDemoBedConfirmed: false,
    createStripeTestLinkConfirmed: false,
    sendPaymentLinkWhatsAppConfirmed: false,
    wamid: null,
    contactName: null,
  };
  const messages = [
    'Hi, we are 2 people interested in the Malibu package',
    'August 18 to August 25',
    'just the stay',
    'Deposit is fine',
  ];
  let guestContext = null;
  const turnBodies = [];
  for (let i = 0; i < messages.length; i++) {
    const isLast = i === messages.length - 1;
    if (isLast) {
      opts.createDemoHoldDraftConfirmed = true;
      opts.assignDemoBedConfirmed = true;
      opts.createStripeTestLinkConfirmed = true;
    }
    const { body, nextContext } = await runTurn(opts, messages[i], guestContext, i, isLast);
    turnBodies.push(body);
    guestContext = nextContext || guestContext;
  }
  const final = turnBodies[3];

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  let payment = null;
  let beds = [];
  let bookingRow = null;
  if (final.booking_id) {
    bookingRow = (await pg.query(
      `SELECT booking_code, status::text, payment_status::text, check_in::text, check_out::text, confirmation_sent_at
         FROM bookings WHERE id=$1::uuid`, [final.booking_id])).rows[0];
    beds = (await pg.query(
      'SELECT bed_code, room_code FROM booking_beds WHERE booking_id=$1::uuid ORDER BY bed_code', [final.booking_id])).rows;
    if (final.payment_draft_id) {
      payment = (await pg.query(
        `SELECT status::text, currency, amount_due_cents, stripe_checkout_session_id, checkout_url
           FROM payments WHERE id=$1::uuid`, [final.payment_draft_id])).rows[0];
    }
  }

  const sends = (await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE created_at >= $1::timestamptz`, [proofStart])).rows[0].n;
  let confirmSends = 0;
  try {
    confirmSends = (await pg.query(
      `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE created_at >= $1::timestamptz AND send_kind ILIKE '%confirm%'`,
      [proofStart])).rows[0].n;
  } catch { confirmSends = 0; }
  await pg.end();

  const reply = String(final.review?.proposed_luna_reply || '');
  console.log(JSON.stringify({
    turns: turnBodies.map((t, i) => ({
      turn: i + 1,
      payment_choice_ready: t.review?.payment_choice?.payment_choice_ready,
      next_safe_step: t.review?.payment_choice?.next_safe_step,
      addons_pending: t.review?.quote?.addons_pending_after_quote,
    })),
    final: {
      write_status: final.write_status,
      booking_code: final.booking_code,
      booking_id: final.booking_id,
      payment_draft_id: final.payment_draft_id,
      assignment_write_status: final.assignment_write_status,
      assigned_bed_label: final.assigned_bed_label,
      assigned_room_label: final.assigned_room_label,
      stripe_link_created: final.stripe_link_created,
      stripe_checkout_url: final.stripe_checkout_url,
      write_block_reasons: final.write_block_reasons,
      open_phone_testing: final.open_phone_testing,
      guest_tester_class: final.guest_tester_class,
      conversation_id: final.conversation_id,
      proposed_luna_reply: reply.slice(0, 280),
    },
    db: { bookingRow, beds, payment },
    copy: {
      says_stripe_link: /stripe link/i.test(reply),
      says_payment_link: /payment link|secure payment/i.test(reply),
      says_secure_payment_link: /secure payment link/i.test(reply),
    },
    safety: { guest_message_sends: sends, confirmation_sends: confirmSends },
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
