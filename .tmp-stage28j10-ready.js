'use strict';
/** Stage 28j.10 — preflight + fresh start + post-retest inspect. Temp — do not commit. */
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');
const { resetLunaConversationContext } = require('./scripts/lib/staff-conversation-writes');

const COMMIT = 'c2ed8fd';
const IMAGE_TAG = `${COMMIT}-stage28j9-calendar-payment-link-fix`;
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const WF_ID = 'stage27demoLWrite01';
const PROOF_PHONE = '+491726422307';
const PROOF_PHONE_RAW = '491726422307';
const CONV_ID = '7361e380-1074-4441-a9e1-f92c127a4e76';
const CLIENT = 'wolfhouse-somo';
const RETEST = ['hi', 'book a stay', 'July 6-10', 'just me', 'Just the stay please', 'deposit'];
const SINCE = process.env.SINCE_ISO || new Date().toISOString();

const cmd = process.argv[2] || 'ready';

function az(c, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      return execSync(c, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      last = e;
      if (i < retries - 1) {
        const until = Date.now() + 2000;
        while (Date.now() < until) { /* */ }
      }
    }
  }
  throw last;
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function envPick(names) {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? (e.secretRef ? `(secret:${e.secretRef})` : (e.value ?? null)) : null;
  }
  return out;
}

function healthz() {
  return execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim();
}

async function pgConnect() {
  const db = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: STAFF_HOST, path, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers.cookie ? { Cookie: headers.cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* */ }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function preflight() {
  const rev = activeRevision();
  const gates = envPick([
    'WHATSAPP_DRY_RUN', 'OPEN_DEMO_WHATSAPP_ENABLED', 'OPEN_DEMO_BOOKING_WRITES_ENABLED',
    'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED', 'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
    'STRIPE_LINKS_ENABLED', 'STAFF_ACTIONS_ENABLED', 'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
    'NODE_ENV', 'STRIPE_SECRET_KEY',
  ]);
  const stripeKey = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name stripe-secret-key --query value -o tsv');
  let n8n = { inactive: true };
  try {
    const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
    const nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
    await nc.connect();
    const wf = await nc.query('SELECT active::text FROM workflow_entity WHERE id = $1', [WF_ID]);
    await nc.end();
    n8n = { inactive: wf.rows.every((r) => r.active === 'false') };
  } catch (e) {
    n8n = { error: String(e.message || e) };
  }
  const pass = String(rev.image || '').includes(IMAGE_TAG)
    && rev.health === 'Healthy' && rev.traffic === 100 && healthz() === '200'
    && gates.WHATSAPP_DRY_RUN === 'false'
    && gates.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'true'
    && gates.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'true'
    && gates.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'true'
    && gates.STRIPE_LINKS_ENABLED === 'true'
    && gates.STAFF_ACTIONS_ENABLED === 'true'
    && (gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null || gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST === '')
    && String(stripeKey).startsWith('sk_test_')
    && n8n.inactive !== false;
  return { pass, rev, gates, healthz: healthz(), stripe_test: true, n8n };
}

async function freshStart() {
  const pg = await pgConnect();
  const out = await resetLunaConversationContext(pg, CLIENT, CONV_ID);
  await pg.end();
  return { ok: true, conversation_id: CONV_ID, ...out };
}

async function inspect(sinceIso) {
  const since = sinceIso || SINCE;
  const pg = await pgConnect();

  const messages = await pg.query(
    `SELECT direction::text, message_text, created_at::text, source
       FROM messages WHERE conversation_id = $1::uuid AND created_at >= $2::timestamptz
       ORDER BY created_at ASC`,
    [CONV_ID, since],
  );

  const sends = await pg.query(
    `SELECT id::text, message_text, provider_message_id, idempotency_key, created_at::text
       FROM guest_message_sends
      WHERE client_slug = $1 AND REPLACE(COALESCE(to_phone,''),'+','') = $2
        AND created_at >= $3::timestamptz
      ORDER BY created_at ASC`,
    [CLIENT, PROOF_PHONE_RAW, since],
  );

  const booking = await pg.query(
    `SELECT b.id::text, b.booking_code, b.status::text, b.payment_status::text,
            b.check_in::text, b.check_out::text, b.amount_paid_cents, b.balance_due_cents,
            b.confirmation_sent_at::text, b.created_at::text
       FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND REPLACE(COALESCE(b.phone,''),'+','') = $2
        AND b.check_in = '2026-07-06' AND b.check_out = '2026-07-10'
      ORDER BY b.created_at DESC LIMIT 1`,
    [CLIENT, PROOF_PHONE_RAW],
  );
  const b = booking.rows[0];

  let pay = null;
  let bb = [];
  if (b) {
    const pr = await pg.query(
      `SELECT id::text, status::text, stripe_checkout_session_id, checkout_url
         FROM payments WHERE booking_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [b.id],
    );
    pay = pr.rows[0] || null;
    const beds = await pg.query(
      `SELECT bed_code, room_code FROM booking_beds WHERE booking_id = $1::uuid`,
      [b.id],
    );
    bb = beds.rows;
  }

  await pg.end();

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = ((login.headers && login.headers['set-cookie']) || []).map((x) => x.split(';')[0]).join('; ');
  const cal = await req('GET', '/staff/bed-calendar?client=wolfhouse-somo&start=2026-07-06&end=2026-07-11', null, { cookie });
  const calBlock = b ? (cal.body?.blocks || []).find((x) => x.booking_code === b.booking_code) : null;

  const depositSends = sends.rows.filter((s) =>
    /checkout\.stripe\.com|payment link|held your stay/i.test(s.message_text || ''));
  const duplicateSend = depositSends.length > 1
    || sends.rows.some((s) => /check the secure payment link I just sent/i.test(s.message_text || ''));
  const singleStripeSend = depositSends.length === 1
    && /checkout\.stripe\.com/i.test(depositSends[0].message_text || '');

  const transcript = messages.rows.map((m) => ({
    direction: m.direction,
    text: m.message_text,
    at: m.created_at,
  }));

  const pass = !!b
    && singleStripeSend
    && !duplicateSend
    && b.status === 'hold'
    && ['waiting_payment', 'deposit_paid'].includes(b.payment_status)
    && !b.confirmation_sent_at
    && !!calBlock
    && calBlock.room_code === 'DEMO-R1'
    && bb.length > 0;

  return {
    since,
    pass,
    transcript,
    outbound_sends: sends.rows,
    deposit_stripe_sends: depositSends,
    duplicate_send: duplicateSend,
    single_stripe_send: singleStripeSend,
    booking: b,
    payment: pay,
    booking_beds: bb,
    calendar_block: calBlock,
    calendar_visible: !!calBlock,
    confirmation_sent: !!(b && b.confirmation_sent_at),
  };
}

(async () => {
  if (cmd === 'preflight' || cmd === 'ready') {
    const pf = await preflight();
    const fs = cmd === 'ready' ? await freshStart() : null;
    console.log(JSON.stringify({
      phase: cmd,
      pass: pf.pass,
      preflight: pf,
      fresh_start: fs,
      since_iso: SINCE,
      message: fs ? `Ty: send from ${PROOF_PHONE} to +34 663 43 94 19:` : null,
      retest_sequence: RETEST,
      inspect_after: `SINCE_ISO=${SINCE} node .tmp-stage28j10-ready.js inspect`,
    }, null, 2));
    if (!pf.pass) process.exit(1);
  }
  if (cmd === 'inspect') {
    const r = await inspect(process.env.SINCE_ISO || SINCE);
    console.log(JSON.stringify({ phase: 'inspect', ...r }, null, 2));
    if (!r.pass) process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
