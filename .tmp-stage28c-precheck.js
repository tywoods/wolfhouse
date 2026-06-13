'use strict';
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const N8N = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const STAFF = 'staff-staging.lunafrontdesk.com';
const N8N_CLOUD = 'tywoods.app.n8n.cloud';
const VERIFY = 'wolfhouse_verify_token';
const CHALLENGE = 'stage28c123';
const ORIGINAL_CALLBACK = 'https://tywoods.app.n8n.cloud/webhook/booking-assistant';
const STAGING_WRITE_CALLBACK = `https://${N8N}/webhook/open-demo-whatsapp-booking-write-27l`;

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }).trim();
}

function httpsGet(host, path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: host, path }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ host, status: res.statusCode, body: buf.slice(0, 300) }));
    }).on('error', reject);
  });
}

function graphGet(path, token) {
  return new Promise((resolve, reject) => {
    const url = `https://graph.facebook.com/v21.0${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
    https.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const q = `hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=${CHALLENGE}`;
  const n8nVerify = await httpsGet(N8N, `/webhook/open-demo-whatsapp-booking-write-27l?${q}`);
  const staffVerify = await httpsGet(STAFF, `/staff/meta/whatsapp/webhook?${q}`);
  const cloudProbe = await httpsGet(N8N_CLOUD, '/webhook/booking-assistant');

  const token = az('az keyvault secret show --vault-name wh-staging-kv --name meta-whatsapp-token --query value -o tsv');
  const debug = await graphGet(`/debug_token?input_token=${encodeURIComponent(token)}`, token);
  const appId = debug.body?.data?.app_id;
  let subs = null;
  if (appId) subs = await graphGet(`/${appId}/subscriptions`, token);

  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const beds = await pg.query("SELECT bed_code FROM beds WHERE bed_code LIKE 'DEMO-%' ORDER BY bed_code");
  const windows = [
    { in: '2026-10-06', out: '2026-10-13', label: 'Oct6-13' },
    { in: '2026-10-20', out: '2026-10-27', label: 'Oct20-27' },
    { in: '2026-11-03', out: '2026-11-10', label: 'Nov3-10' },
    { in: '2026-11-10', out: '2026-11-17', label: 'Nov10-17' },
  ];
  const availability = [];
  for (const w of windows) {
    const occ = await pg.query(`
      SELECT bb.bed_code, b.booking_code
        FROM booking_beds bb
        JOIN bookings b ON b.id = bb.booking_id
        JOIN clients cl ON cl.id = b.client_id
       WHERE cl.slug = 'wolfhouse-somo'
         AND bb.bed_code LIKE 'DEMO-%'
         AND bb.assignment_start_date < $2::date
         AND bb.assignment_end_date > $1::date
         AND b.status NOT IN ('cancelled', 'expired')`, [w.in, w.out]);
    const occupied = new Set(occ.rows.map((r) => r.bed_code));
    const free = beds.rows.filter((b) => !occupied.has(b.bed_code));
    availability.push({
      ...w,
      free_beds: free.length,
      free_codes: free.map((b) => b.bed_code),
      conflicts: occ.rows,
    });
  }
  const wf = await pg.end();

  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (n) => {
    const e = env.find((x) => x.name === n);
    return e ? (e.secretRef ? `(secret:${e.secretRef})` : e.value) : null;
  };

  const revRows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const active = revRows.find((x) => x.properties.trafficWeight === 100) || {};

  console.log(JSON.stringify({
    healthz: Number(execSync('curl.exe -s -o NUL -w "%{http_code}" https://staff-staging.lunafrontdesk.com/healthz', { encoding: 'utf8' }).trim()),
    revision: { name: active.name, image: active.properties?.template?.containers?.[0]?.image },
    gates_before: {
      WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
      OPEN_DEMO_WHATSAPP_ENABLED: pick('OPEN_DEMO_WHATSAPP_ENABLED'),
      OPEN_DEMO_BOOKING_WRITES_ENABLED: pick('OPEN_DEMO_BOOKING_WRITES_ENABLED'),
      OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: pick('OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED'),
      OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: pick('OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED'),
      LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: pick('LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST'),
      OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: pick('OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID'),
    },
    meta: {
      app_id: appId || null,
      subscriptions: subs?.body?.data?.map((s) => ({ object: s.object, callback_url: s.callback_url, active: s.active })) || subs,
      original_callback: ORIGINAL_CALLBACK,
      staging_write_callback: STAGING_WRITE_CALLBACK,
      n8n_hub_verify: n8nVerify,
      staff_hub_verify: staffVerify,
      n8n_cloud_probe: cloudProbe,
    },
    demo_whatsapp_number: '+34 663 43 94 19',
    demo_phone_number_id: '1152900101233109',
    availability,
    recommended_dates: availability.find((w) => w.free_beds >= 2) || null,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
