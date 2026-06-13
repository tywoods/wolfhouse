'use strict';
/** Stage 45i.6 recovery — quote-only smoke, no redeploy. */

const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');

const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const DEMO_PHONE_ID = '1152900101233109';
const GUEST_PHONE = '+34600995566';

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

function buildPayload(msg, ctx, i) {
  const wamid = `wamid.45i6r-${Date.now()}-t${i + 1}`;
  return {
    source: 'n8n_open_demo_whatsapp_harness', client_slug: CLIENT, channel: 'whatsapp',
    phone_number_id: DEMO_PHONE_ID, guest_phone: GUEST_PHONE,
    guest_email: 'open-demo+34600995566@example.test', contact_name: 'Alex Stage45i6',
    message_text: msg, wamid, inbound_message_id: wamid,
    received_at: new Date().toISOString(), reference_date: '2026-06-08',
    ...(ctx ? { guest_context: ctx } : {}),
  };
}

(async () => {
  const rev = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json')).find((r) => r.properties.trafficWeight === 100);
  const envRaw = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json'));
  const pick = (n) => { const e = envRaw.find((x) => x.name === n); return e?.secretRef ? `(secret:${e.secretRef})` : e?.value ?? null; };

  const proofStart = new Date().toISOString();
  const msgs = ['Hi, we are 2 people interested in the Malibu package', 'August 18 to August 25'];
  let ctx = null;
  const turns = [];
  for (let i = 0; i < msgs.length; i++) {
    const body = await post(buildPayload(msgs[i], ctx, i));
    turns.push({
      turn: i + 1,
      quote_status: body.review?.quote?.quote_status,
      payment_choice_needed: body.review?.quote?.payment_choice_needed,
      addons_pending: body.review?.quote?.addons_pending_after_quote,
      write_status: body.write_status,
      booking_code: body.booking_code,
      reply: String(body.review?.proposed_luna_reply || body.proposed_luna_reply || ''),
    });
    ctx = body.slim_guest_context_for_next_turn || ctx;
    await new Promise((r) => setTimeout(r, 2500));
  }

  const t2 = turns[1]?.reply || '';
  let sends = [];
  try {
    const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
    const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
    await pg.connect();
    const phoneRaw = GUEST_PHONE.replace(/^\+/, '');
    sends = (await pg.query(
      `SELECT status, to_phone FROM guest_message_sends WHERE created_at >= $1::timestamptz
         AND (to_phone = $2 OR to_phone = $3 OR to_phone = $4)`,
      [proofStart, GUEST_PHONE, phoneRaw, `+${phoneRaw}`])).rows;
    await pg.end();
  } catch (dbErr) {
    sends = [{ error: dbErr.message }];
  }

  console.log(JSON.stringify({
    deploy: { revision: rev?.name, health: rev?.properties?.healthState, image: rev?.properties?.template?.containers?.[0]?.image },
    env: {
      OPEN_DEMO_BOOKING_WRITES_ENABLED: pick('OPEN_DEMO_BOOKING_WRITES_ENABLED'),
      OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: pick('OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED'),
      WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
      OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: pick('OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED'),
      LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: pick('LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST'),
    },
    turns,
    turn2_copy: {
      has_total: /€698|698/.test(t2),
      asks_deposit_or_full: /deposit|full/i.test(t2),
      optional_addons_later: /lessons|rentals/i.test(t2) && /later|if you want/i.test(t2),
      no_just_the_stay: !/just the stay/i.test(t2),
      no_stripe_link: !/stripe link/i.test(t2),
    },
    safety: {
      no_booking_from_api: !turns[1]?.booking_code && !turns[1]?.write_status,
      live_sends: sends.filter((s) => s.status === 'sent').length,
      sends,
    },
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
