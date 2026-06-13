'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const PHONE = '+34600995555';
const BOOKING_ID = 'a3bdf2bf-3b00-4127-b4c2-587543163f89';
const BOOKING_CODE = 'WH-G27-0BB996236D';
const PAY_ID = 'b5b4122e-e1dd-431f-b42c-e8347976cce6';

function az(c) { return execSync(c, { encoding: 'utf8', maxBuffer: 20e6 }).trim(); }

function req(method, p, body, h = {}) {
  return new Promise((res, rej) => {
    const d = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path: p, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(h.cookie ? { Cookie: h.cookie } : {}),
        ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}),
      },
    }, (x) => {
      let raw = '';
      x.on('data', (c) => { raw += c; });
      x.on('end', () => {
        let b = raw;
        try { b = JSON.parse(raw); } catch { /* keep */ }
        res({ status: x.statusCode, body: b, headers: x.headers });
      });
    });
    r.on('error', rej);
    if (d) r.write(d);
    r.end();
  });
}

function envPick(names) {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? e.value : null;
  }
  return out;
}

(async () => {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const rev = rows.find((x) => x.properties.trafficWeight === 100);
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const cal = await req('GET', `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=2026-07-01&end=2026-07-31`, null, { cookie });
  const blocks = (cal.body && cal.body.blocks) || [];
  const m = blocks.find((b) => b.booking_id === BOOKING_ID || b.booking_code === BOOKING_CODE);

  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const sends = await pg.query(
    "SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE to_phone = $1 AND created_at > NOW() - INTERVAL '2 hours'",
    [PHONE],
  );
  const pay = await pg.query(
    'SELECT id::text, status::text, checkout_url, stripe_checkout_session_id, amount_paid_cents, payment_kind::text FROM payments WHERE id = $1::uuid',
    [PAY_ID],
  );
  const bk = await pg.query(
    'SELECT booking_code, phone, check_in::text, check_out::text, status::text, total_amount_cents FROM bookings WHERE id = $1::uuid',
    [BOOKING_ID],
  );
  await pg.end();

  const env = envPick([
    'OPEN_DEMO_BOOKING_WRITES_ENABLED',
    'WHATSAPP_DRY_RUN',
    'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
    'OPEN_DEMO_WHATSAPP_ENABLED',
  ]);

  const payment = pay.rows[0];
  const out = {
    revision: {
      name: rev.name,
      health: rev.properties.healthState,
      traffic: rev.properties.trafficWeight,
      image: rev.properties.template.containers[0].image,
    },
    healthz: (await req('GET', '/healthz')).status,
    ui: (await req('GET', '/staff/ui', null, { cookie })).status,
    env_after: env,
    calendar: {
      http: cal.status,
      blocks_count: blocks.length,
      matched: !!m,
      booking_code: m && m.booking_code,
      check_in: m && m.check_in,
      check_out: m && m.check_out,
      status: m && m.status,
      guest_name: m && m.guest_name,
    },
    db: {
      guest_message_sends_2h: sends.rows[0].n,
      payment,
      booking: bk.rows[0],
    },
    pass: !!m
      && String(m.check_in || '').includes('2026-07-10')
      && String(m.check_out || '').includes('2026-07-17')
      && payment.status === 'draft'
      && !payment.stripe_checkout_session_id
      && !payment.checkout_url
      && payment.amount_paid_cents === 0
      && sends.rows[0].n === 0
      && env.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false',
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
