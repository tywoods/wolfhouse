'use strict';
/** Stage 45i.6 — deploy 6fbf703 + 2-turn quote-only copy smoke. Temp — do not commit. */

const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');

const COMMIT_SHORT = '6fbf703';
const IMAGE_TAG = `${COMMIT_SHORT}-stage45i-cami-quote-copy`;
const REV_SUFFIX = 'stage45i-cami-quote-copy';
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const DEMO_PHONE_ID = '1152900101233109';
const GUEST_PHONE = '+34600995564';

const ENV_NAMES = [
  'OPEN_DEMO_BOOKING_WRITES_ENABLED',
  'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
  'WHATSAPP_DRY_RUN',
  'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
];

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((r) => r.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties?.healthState,
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

function postInbound(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: STAFF_HOST,
      path: OPEN_DEMO_WHATSAPP_ROUTE,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Luna-Bot-Token': botToken(),
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

function buildPayload(msg, ctx, turnIndex) {
  const wamid = `wamid.45i6-${Date.now()}-t${turnIndex + 1}`;
  return {
    source: 'n8n_open_demo_whatsapp_harness',
    client_slug: CLIENT,
    channel: 'whatsapp',
    phone_number_id: DEMO_PHONE_ID,
    guest_phone: GUEST_PHONE,
    guest_email: 'open-demo+34600995564@example.test',
    contact_name: 'Alex Stage45i6',
    message_text: msg,
    wamid,
    inbound_message_id: wamid,
    received_at: new Date().toISOString(),
    reference_date: '2026-06-08',
    ...(ctx ? { guest_context: ctx } : {}),
  };
}

(async () => {
  const out = {
    phase: 'stage45i6-hosted-proof',
    commit: COMMIT_SHORT,
    deploy: {},
    env: {},
    smoke: { turns: [] },
    turn2_copy: {},
    safety: {},
    result: 'FAIL',
  };

  console.error('[deploy] ACR build...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] container app update...');
  az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image ${IMAGE} --revision-suffix ${REV_SUFFIX} -o none`);
  console.error('[deploy] waiting for healthy...');
  out.deploy.revision = waitForHealthy();
  out.deploy.image = IMAGE;

  const hz = await new Promise((resolve) => {
    https.get(`https://${STAFF_HOST}/healthz`, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ raw: b }); } });
    }).on('error', () => resolve(null));
  });
  out.deploy.healthz = hz;

  out.env = envPick(ENV_NAMES);

  const proofStart = new Date().toISOString();
  const messages = [
    'Hi, we are 2 people interested in the Malibu package',
    'August 18 to August 25',
  ];
  let ctx = null;
  const bodies = [];
  for (let i = 0; i < messages.length; i++) {
    const resp = await postInbound(buildPayload(messages[i], ctx, i));
    bodies.push(resp.body || {});
    ctx = resp.body?.slim_guest_context_for_next_turn || ctx;
    const reply = String(resp.body?.review?.proposed_luna_reply || resp.body?.proposed_luna_reply || '');
    out.smoke.turns.push({
      turn: i + 1,
      message: messages[i],
      quote_status: resp.body?.review?.quote?.quote_status,
      payment_choice_needed: resp.body?.review?.quote?.payment_choice_needed,
      addons_pending: resp.body?.review?.quote?.addons_pending_after_quote,
      write_status: resp.body?.write_status,
      booking_code: resp.body?.booking_code,
      reply,
    });
    await new Promise((r) => setTimeout(r, 2500));
  }

  const t2Reply = out.smoke.turns[1]?.reply || '';
  out.turn2_copy = {
    reply: t2Reply,
    has_total: /€698|698/.test(t2Reply),
    asks_deposit_or_full: /deposit|full/i.test(t2Reply),
    optional_addons_later: /lessons|rentals/i.test(t2Reply) && /later|if you want/i.test(t2Reply),
    no_just_the_stay: !/just the stay/i.test(t2Reply),
    no_stripe_link: !/stripe link/i.test(t2Reply),
  };

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const phoneRaw = GUEST_PHONE.replace(/^\+/, '');
  const bookings = (await pg.query(
    `SELECT booking_code, status::text, created_at::text FROM bookings b
     JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.created_at >= $2::timestamptz
       AND (b.metadata->>'guest_phone' = $3 OR b.metadata->>'phone' = $3 OR EXISTS (
         SELECT 1 FROM conversations cv WHERE cv.id = b.conversation_id AND (cv.phone = $3 OR cv.phone = $4 OR cv.phone = $5)
       ))`,
    [CLIENT, proofStart, GUEST_PHONE, phoneRaw, `+${phoneRaw}`],
  )).rows;
  const payments = (await pg.query(
    'SELECT id::text, status::text, created_at::text FROM payments WHERE created_at >= $1::timestamptz LIMIT 5',
    [proofStart],
  )).rows;
  const sends = (await pg.query(
    `SELECT status, to_phone FROM guest_message_sends WHERE created_at >= $1::timestamptz
       AND (to_phone = $2 OR to_phone = $3 OR to_phone = $4)`,
    [proofStart, GUEST_PHONE, phoneRaw, `+${phoneRaw}`],
  )).rows;
  await pg.end();

  out.safety = {
    bookings_created: bookings,
    payments_created: payments.filter((p) => bookings.length > 0),
    guest_message_sends: sends,
    live_sends: sends.filter((s) => s.status === 'sent').length,
    turn2_write_status: out.smoke.turns[1]?.write_status,
    turn2_booking_code: out.smoke.turns[1]?.booking_code,
  };

  out.result = (
    out.deploy.revision.image?.includes(COMMIT_SHORT)
    && out.deploy.revision.health === 'Healthy'
    && out.deploy.healthz?.status === 'ok'
    && out.env.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'true'
    && out.env.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'true'
    && out.env.WHATSAPP_DRY_RUN === 'true'
    && out.env.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false'
    && out.env.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null
    && out.smoke.turns[1]?.quote_status === 'ready'
    && out.turn2_copy.has_total
    && out.turn2_copy.asks_deposit_or_full
    && out.turn2_copy.optional_addons_later
    && out.turn2_copy.no_just_the_stay
    && out.turn2_copy.no_stripe_link
    && !out.smoke.turns[1]?.booking_code
    && out.safety.bookings_created.length === 0
    && out.safety.live_sends === 0
  ) ? 'PASS' : 'PARTIAL';

  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
