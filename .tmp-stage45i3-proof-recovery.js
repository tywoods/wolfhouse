'use strict';
/** Stage 45i.3 proof recovery — no redeploy. */

const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');

const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const DEMO_PHONE_ID = '1152900101233109';
const GUEST_PHONE = '+34600995563';

function az(c) { return execSync(c, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }).trim(); }
function token() { return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv'); }

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: STAFF_HOST, path: OPEN_DEMO_WHATSAPP_ROUTE, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Luna-Bot-Token': token() },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildPayload(msg, ctx, i, last) {
  const wamid = `wamid.45i3r-${Date.now()}-t${i + 1}`;
  const p = {
    source: 'n8n_open_demo_whatsapp_harness', client_slug: CLIENT, channel: 'whatsapp',
    phone_number_id: DEMO_PHONE_ID, guest_phone: GUEST_PHONE,
    guest_email: 'open-demo+34600995563@example.test', contact_name: 'Alex Stage45i3',
    message_text: msg, wamid, inbound_message_id: wamid,
    received_at: new Date().toISOString(), reference_date: '2026-06-08',
  };
  if (ctx) p.guest_context = ctx;
  if (last) {
    p.create_demo_hold_draft_confirmed = true;
    p.assign_demo_bed_confirmed = true;
    p.create_stripe_test_link_confirmed = true;
  }
  return p;
}

(async () => {
  const proofStart = new Date().toISOString();
  const msgs = [
    'Hi, we are 2 people interested in the Malibu package',
    'August 18 to August 25',
    'Deposit is fine',
  ];
  let ctx = null;
  const turns = [];
  for (let i = 0; i < msgs.length; i++) {
    const body = await post(buildPayload(msgs[i], ctx, i, i === msgs.length - 1));
    turns.push(body);
    ctx = body.slim_guest_context_for_next_turn || ctx;
    await new Promise((r) => setTimeout(r, 2500));
  }
  const t2 = turns[1];
  const t3 = turns[2];
  const t2Reply = String(t2?.review?.proposed_luna_reply || t2?.proposed_luna_reply || '');

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const bookingId = t3?.booking_id;
  let booking = null; let beds = []; let payment = null;
  if (bookingId) {
    booking = (await pg.query(`SELECT booking_code, status::text, payment_status::text, check_in::text, check_out::text, confirmation_sent_at FROM bookings WHERE id=$1::uuid`, [bookingId])).rows[0];
    beds = (await pg.query('SELECT bed_code, room_code FROM booking_beds WHERE booking_id=$1::uuid ORDER BY bed_code', [bookingId])).rows;
    if (t3.payment_draft_id) {
      payment = (await pg.query(`SELECT status::text, currency, amount_due_cents, stripe_checkout_session_id, checkout_url FROM payments WHERE id=$1::uuid`, [t3.payment_draft_id])).rows[0];
    }
  }
  const phoneRaw = GUEST_PHONE.replace(/^\+/, '');
  const conv = (await pg.query(`
    SELECT c.id::text, c.phone, c.metadata->>'open_phone_testing' AS open_phone_testing,
           c.metadata->>'guest_tester_class' AS guest_tester_class
      FROM conversations c INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $4 AND (c.phone = $1 OR c.phone = $2 OR c.phone = $3)
     ORDER BY c.updated_at DESC LIMIT 1`, [GUEST_PHONE, phoneRaw, `+${phoneRaw}`, CLIENT])).rows[0];
  const sends = (await pg.query(
    `SELECT status, to_phone, blocked_reasons FROM guest_message_sends WHERE created_at >= $1::timestamptz AND (to_phone = $2 OR to_phone = $3 OR to_phone = $4)`,
    [proofStart, GUEST_PHONE, phoneRaw, `+${phoneRaw}`])).rows;
  await pg.end();

  const rev = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json')).find((r) => r.properties.trafficWeight === 100);
  const envRaw = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json'));
  const pick = (n) => { const e = envRaw.find((x) => x.name === n); return e?.secretRef ? `(secret:${e.secretRef})` : e?.value ?? null; };
  const sk = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name stripe-secret-key --query value -o tsv');

  console.log(JSON.stringify({
    deploy: { revision: rev?.name, health: rev?.properties?.healthState, image: rev?.properties?.template?.containers?.[0]?.image },
    env: {
      OPEN_DEMO_WHATSAPP_ENABLED: pick('OPEN_DEMO_WHATSAPP_ENABLED'),
      LUNA_OPEN_PHONE_TESTING: pick('LUNA_OPEN_PHONE_TESTING'),
      LUNA_OPEN_PHONE_TESTING_BYPASS_STAFF_ROUTING: pick('LUNA_OPEN_PHONE_TESTING_BYPASS_STAFF_ROUTING'),
      OPEN_DEMO_BOOKING_WRITES_ENABLED: pick('OPEN_DEMO_BOOKING_WRITES_ENABLED'),
      OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: pick('OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED'),
      WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
      OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: pick('OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED'),
      LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: pick('LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST'),
    },
    stripe: { prefix: sk.slice(0, 12), test_mode: sk.startsWith('sk_test_'), live_blocked: sk.startsWith('sk_live_') },
    turns: turns.map((b, i) => ({
      turn: i + 1,
      quote_status: b.review?.quote?.quote_status,
      payment_choice_needed: b.review?.quote?.payment_choice_needed,
      addons_pending: b.review?.quote?.addons_pending_after_quote,
      payment_choice_ready: b.review?.payment_choice?.payment_choice_ready,
      next_safe_step: b.review?.payment_choice?.next_safe_step,
      write_status: b.write_status,
      booking_code: b.booking_code,
      stripe_link_created: b.stripe_link_created,
      reply: String(b.review?.proposed_luna_reply || b.proposed_luna_reply || '').slice(0, 400),
    })),
    quote_copy: {
      turn2_reply: t2Reply,
      asks_deposit_or_full: /deposit|full/i.test(t2Reply),
      addons_optional_later: /later|anytime|if you want/i.test(t2Reply),
      no_just_the_stay: !/just the stay/i.test(t2Reply),
      no_stripe_link: !/stripe link/i.test(t2Reply),
    },
    booking, beds, payment, conversation: conv,
    safety: { sends, live_sent: sends.filter((s) => s.status === 'sent').length, confirmation_sent_at: booking?.confirmation_sent_at },
    cleanup: {
      dry_run: `npm run cleanup:open-demo-booking -- --phone ${GUEST_PHONE} --dry-run`,
      confirm: `npm run cleanup:open-demo-booking -- --phone ${GUEST_PHONE} --confirm-cleanup`,
    },
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
