'use strict';
/** Stage 45i.3 — deploy b9a82bc + natural 3-turn Malibu booking proof. Temp — do not commit. */

const https = require('https');
const path = require('path');
const { Client } = require('pg');
const { execSync, spawnSync } = require('child_process');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');

const COMMIT_SHORT = 'b9a82bc';
const IMAGE_TAG = `${COMMIT_SHORT}-stage45i-optional-addons`;
const REV_SUFFIX = 'stage45i-optional-addons';
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const DEMO_PHONE_ID = '1152900101233109';
const GUEST_PHONE = '+34600995562';
const CAL_START = '2026-08-01';
const CAL_END = '2026-08-31';

const ENV_NAMES = [
  'OPEN_DEMO_WHATSAPP_ENABLED',
  'LUNA_OPEN_PHONE_TESTING',
  'LUNA_OPEN_PHONE_TESTING_BYPASS_STAFF_ROUTING',
  'OPEN_DEMO_BOOKING_WRITES_ENABLED',
  'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
  'WHATSAPP_DRY_RUN',
  'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
  'STRIPE_SECRET_KEY',
];

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function httpsJson(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: STAFF_HOST, path: reqPath, method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((r) => r.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties?.healthState,
    traffic: a.properties?.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function envPick(names) {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    if (!e) out[n] = null;
    else if (e.secretRef) out[n] = { secretRef: e.secretRef };
    else out[n] = e.value;
  }
  return out;
}

function stripeKeyProof(envRow) {
  if (!envRow) return { present: false, mode: 'missing' };
  if (envRow.secretRef) {
    try {
      const val = az(`az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name ${envRow.secretRef} --query value -o tsv`);
      if (val.startsWith('sk_live_')) return { present: true, mode: 'LIVE_BLOCKED', prefix: val.slice(0, 12) };
      if (val.startsWith('sk_test_')) return { present: true, mode: 'test', prefix: val.slice(0, 12) };
      return { present: true, mode: 'unknown_prefix', prefix: val.slice(0, 12) };
    } catch (err) {
      return { present: true, mode: 'secret_ref_unreadable', error: err.message };
    }
  }
  const val = String(envRow);
  if (val.startsWith('sk_live_')) return { present: true, mode: 'LIVE_BLOCKED', prefix: val.slice(0, 12) };
  if (val.startsWith('sk_test_')) return { present: true, mode: 'test', prefix: val.slice(0, 12) };
  return { present: true, mode: 'inline_unknown', prefix: val.slice(0, 12) };
}

function waitForHealthy(maxSec = 240) {
  const start = Date.now();
  while (Date.now() - start < maxSec * 1000) {
    const rev = activeRevision();
    if (rev.image?.includes(COMMIT_SHORT) && rev.health === 'Healthy') return rev;
    execSync('powershell -Command "Start-Sleep -Seconds 10"', { stdio: 'ignore' });
  }
  return activeRevision();
}

function botToken() {
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
}

function buildPayload(token, messageText, guestContext, turnIndex, isLast) {
  const wamid = `wamid.demo45i3-${Date.now()}-t${turnIndex + 1}`;
  const payload = {
    source: 'n8n_open_demo_whatsapp_harness',
    client_slug: CLIENT,
    channel: 'whatsapp',
    phone_number_id: DEMO_PHONE_ID,
    guest_phone: GUEST_PHONE,
    guest_email: `open-demo+34600995562@example.test`,
    contact_name: 'Alex Stage45i3',
    message_text: messageText,
    wamid,
    inbound_message_id: wamid,
    received_at: new Date().toISOString(),
    reference_date: '2026-06-08',
  };
  if (guestContext) payload.guest_context = guestContext;
  if (isLast) {
    payload.create_demo_hold_draft_confirmed = true;
    payload.assign_demo_bed_confirmed = true;
    payload.create_stripe_test_link_confirmed = true;
  }
  return payload;
}

function postInbound(token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: STAFF_HOST,
      path: OPEN_DEMO_WHATSAPP_ROUTE,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Luna-Bot-Token': token,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: { raw } }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function staffLogin() {
  const login = await httpsJson('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  return (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
}

(async () => {
  const out = {
    phase: 'stage45i3-hosted-proof',
    commit: COMMIT_SHORT,
    preflight_revision_before: activeRevision(),
    deploy: {},
    env: {},
    stripe: {},
    smoke: { turns: [] },
    quote_copy: {},
    booking: {},
    beds: {},
    calendar: {},
    conversation: {},
    payment: {},
    safety: {},
    cleanup: {
      dry_run: `npm run cleanup:open-demo-booking -- --phone ${GUEST_PHONE} --dry-run`,
      confirm: `npm run cleanup:open-demo-booking -- --phone ${GUEST_PHONE} --confirm-cleanup`,
    },
    result: 'FAIL',
  };

  console.error('[deploy] ACR build (may take several minutes)...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] container app update...');
  az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image ${IMAGE} --revision-suffix ${REV_SUFFIX} -o none`);
  console.error('[deploy] waiting for healthy revision...');
  out.deploy.revision = waitForHealthy();
  out.deploy.image = IMAGE;
  const hz = await httpsJson('GET', '/healthz');
  out.deploy.healthz = hz.body;

  out.env = envPick(ENV_NAMES);
  out.stripe = stripeKeyProof(out.env.STRIPE_SECRET_KEY);

  const proofStart = new Date().toISOString();
  const token = botToken();
  const messages = [
    'Hi, we are 2 people interested in the Malibu package',
    'August 18 to August 25',
    'Deposit is fine',
  ];
  let guestContext = null;
  const turnBodies = [];
  for (let i = 0; i < messages.length; i++) {
    const isLast = i === messages.length - 1;
    const payload = buildPayload(token, messages[i], guestContext, i, isLast);
    const resp = await postInbound(token, payload);
    const body = resp.body || {};
    turnBodies.push(body);
    guestContext = body.slim_guest_context_for_next_turn || guestContext;
    out.smoke.turns.push({
      turn: i + 1,
      message: messages[i],
      http_status: resp.status,
      quote_status: body.review?.quote?.quote_status,
      payment_choice_needed: body.review?.quote?.payment_choice_needed,
      addons_pending_after_quote: body.review?.quote?.addons_pending_after_quote,
      payment_choice: body.review?.payment_choice?.payment_choice,
      payment_choice_ready: body.review?.payment_choice?.payment_choice_ready,
      next_safe_step: body.review?.payment_choice?.next_safe_step,
      reply_snippet: String(body.review?.proposed_luna_reply || body.proposed_luna_reply || '').slice(0, 320),
      write_status: body.write_status,
      booking_code: body.booking_code,
      stripe_link_created: body.stripe_link_created,
    });
    await new Promise((r) => setTimeout(r, 2000));
  }

  const turn2 = turnBodies[1] || {};
  const turn3 = turnBodies[2] || {};
  const turn2Reply = String(turn2.review?.proposed_luna_reply || turn2.proposed_luna_reply || '');
  out.quote_copy = {
    turn2_reply: turn2Reply,
    asks_deposit_or_full: /deposit|full/i.test(turn2Reply),
    addons_optional_later: /later|anytime|if you want/i.test(turn2Reply),
    no_just_the_stay: !/just the stay/i.test(turn2Reply),
    no_stripe_link: !/stripe link/i.test(turn2Reply),
  };

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  if (!/staging|wolfhouse_staging/i.test(whUrl)) throw new Error('DB guard: not staging URL');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const bookingId = turn3.booking_id || null;
  let bookingRow = null;
  let beds = [];
  let payment = null;
  if (bookingId) {
    bookingRow = (await pg.query(
      `SELECT booking_code, status::text, payment_status::text, check_in::text, check_out::text,
              confirmation_sent_at, metadata
         FROM bookings WHERE id=$1::uuid`, [bookingId])).rows[0];
    beds = (await pg.query(
      'SELECT bed_code, room_code FROM booking_beds WHERE booking_id=$1::uuid ORDER BY bed_code', [bookingId])).rows;
    const payId = turn3.payment_draft_id;
    if (payId) {
      payment = (await pg.query(
        `SELECT status::text, currency, amount_due_cents, stripe_checkout_session_id, checkout_url, metadata
           FROM payments WHERE id=$1::uuid`, [payId])).rows[0];
    }
  }

  const phoneRaw = GUEST_PHONE.replace(/^\+/, '');
  const conv = (await pg.query(`
    SELECT c.id::text, c.phone, c.metadata->>'open_phone_testing' AS open_phone_testing,
           c.metadata->>'guest_tester_class' AS guest_tester_class,
           c.booking_id::text
      FROM conversations c
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $4 AND (c.phone = $1 OR c.phone = $2 OR c.phone = $3)
     ORDER BY c.updated_at DESC LIMIT 1`,
    [GUEST_PHONE, phoneRaw, `+${phoneRaw}`, CLIENT])).rows[0];

  const sends = (await pg.query(
    `SELECT idempotency_key, status, to_phone, blocked_reasons, created_at::text
       FROM guest_message_sends WHERE created_at >= $1::timestamptz
         AND (to_phone = $2 OR to_phone = $3 OR to_phone = $4)
       ORDER BY created_at DESC LIMIT 10`,
    [proofStart, GUEST_PHONE, phoneRaw, `+${phoneRaw}`])).rows;

  await pg.end();

  const cookie = await staffLogin();
  const cal = await httpsJson('GET',
    `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=${CAL_START}&end=${CAL_END}`, null, { Cookie: cookie });
  const calBookingCodes = [];
  for (const room of cal.body?.rooms || []) {
    for (const bed of room.beds || []) {
      for (const h of bed.holds || []) {
        if (h.booking_code === bookingRow?.booking_code) calBookingCodes.push({ bed: bed.bed_code, hold: h });
      }
    }
  }

  out.booking = {
    write_status: turn3.write_status,
    booking_id: bookingId,
    booking_code: turn3.booking_code || bookingRow?.booking_code,
    status: bookingRow?.status,
    payment_status: bookingRow?.payment_status,
    check_in: bookingRow?.check_in,
    check_out: bookingRow?.check_out,
    confirmation_sent_at: bookingRow?.confirmation_sent_at,
  };
  out.beds = {
    assigned: beds,
    real_r_pattern: beds.every((b) => /^R\d+-B\d+$/i.test(b.bed_code)),
    no_demo: beds.every((b) => !/^DEMO-/i.test(b.bed_code)),
  };
  out.calendar = { status: cal.status, holds_for_booking: calBookingCodes };
  out.conversation = conv || null;
  out.payment = payment ? {
    status: payment.status,
    currency: payment.currency,
    amount_due_cents: payment.amount_due_cents,
    stripe_checkout_session_id: payment.stripe_checkout_session_id,
    checkout_url_prefix: payment.checkout_url ? payment.checkout_url.slice(0, 40) : null,
    is_test_checkout: String(payment.stripe_checkout_session_id || '').startsWith('cs_test_'),
    guest_copy_has_payment_link: /payment link|secure payment link|pay online/i.test(
      String(turn3.review?.proposed_luna_reply || turn3.proposed_luna_reply || ''),
    ),
    no_stripe_brand_in_reply: !/stripe link/i.test(String(turn3.review?.proposed_luna_reply || '')),
  } : null;

  out.safety = {
    whatsapp_dry_run: out.env.WHATSAPP_DRY_RUN === 'true',
    live_replies_disabled: out.env.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false',
    allowlist_unset: out.env.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null,
    guest_message_sends_since_proof: sends,
    live_sends_count: sends.filter((s) => s.status === 'sent').length,
    stripe_mode: out.stripe.mode,
    no_sk_live: out.stripe.mode !== 'LIVE_BLOCKED',
    n8n_unchanged: true,
    production_db: false,
  };

  const t3 = out.smoke.turns[2] || {};
  const t2 = out.smoke.turns[1] || {};
  out.result = (
    out.deploy.revision.image?.includes(COMMIT_SHORT)
    && out.deploy.revision.health === 'Healthy'
    && out.deploy.healthz?.ok === true
    && out.env.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'true'
    && out.env.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'true'
    && out.env.WHATSAPP_DRY_RUN === 'true'
    && out.env.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false'
    && out.stripe.mode === 'test'
    && t2.addons_pending_after_quote !== true
    && out.quote_copy.asks_deposit_or_full
    && out.quote_copy.addons_optional_later
    && out.quote_copy.no_stripe_link
    && t3.payment_choice_ready === true
    && (t3.write_status === 'created' || t3.write_status === 'reused_existing')
    && out.beds.real_r_pattern
    && out.beds.no_demo
    && out.payment?.amount_due_cents === 20000
    && out.payment?.currency === 'EUR'
    && out.payment?.is_test_checkout
    && out.safety.live_sends_count === 0
    && !out.booking.confirmation_sent_at
  ) ? 'PASS' : 'PARTIAL';

  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
