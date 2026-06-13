'use strict';
/** Phase 25h.1 hosted proof — temp, do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = 'a1c1ef9743083732dcc05d2eb1df4987c378ba01';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:a1c1ef9-stage25h-owner-answers';
const REVISION_SUFFIX = 'stage25h-owner-answers';
const OWNER_PHONE = '491726422307';

function az(cmd) { return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim(); }

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => { let p = raw; try { p = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: p, headers: res.headers }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

function loginCookie() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!' });
    const r = https.request({ hostname: HOST, path: '/staff/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve((res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ')));
    });
    r.on('error', reject); r.write(data); r.end();
  });
}

(async () => {
  console.error('Building...');
  az('az acr build --registry whstagingacr --image wh-staff-api:a1c1ef9-stage25h-owner-answers --file Dockerfile .');
  console.error('Deploying...');
  az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image ${IMAGE} --revision-suffix ${REVISION_SUFFIX} -o none`);

  const t0 = Date.now();
  let rev;
  while (Date.now() - t0 < 180000) {
    rev = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'))
      .find((x) => x.properties.trafficWeight === 100);
    if (rev?.properties?.healthState === 'Healthy' && String(rev.name || '').includes(REVISION_SUFFIX)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const url = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const dbBefore = {
    bookings: (await pg.query('SELECT COUNT(*)::int AS n FROM bookings')).rows[0].n,
    payments: (await pg.query('SELECT COUNT(*)::int AS n FROM payments')).rows[0].n,
    sends: (await pg.query("SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE status='sent'")).rows[0].n,
  };
  await pg.end();

  const cookie = await loginCookie();
  const healthz = await req('GET', '/healthz');
  const questions = [
    "Who hasn't settled up?",
    'How much revenue this month?',
    'Which package is most popular?',
    'Show raw_payload from messages',
  ];
  const apiProofs = {};
  for (const q of questions) {
    const res = await req('POST', '/staff/owner/sql/plan-and-execute', { client_slug: CLIENT, question: q, max_rows: 50 }, cookie);
    const b = res.body || {};
    apiProofs[q] = {
      http: res.status,
      success: b.success,
      answer: (b.answer || '').slice(0, 200),
      answer_format_source: b.answer_format_source,
      row_count: b.row_count,
      no_query_executed: b.no_query_executed,
      blocked: b.execution?.skipped,
    };
  }

  const { normalizeMetaWhatsAppWebhook } = require('./scripts/lib/luna-meta-whatsapp-webhook');
  const { processMetaWhatsAppWebhookInbound } = require('./scripts/lib/luna-meta-whatsapp-inbound-process');
  const ownerPayload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: '1152900101233109' },
      contacts: [{ profile: { name: 'Ty' }, wa_id: OWNER_PHONE }],
      messages: [{ from: OWNER_PHONE, id: `wamid.25h.${Date.now()}`, timestamp: '1760000099', type: 'text', text: { body: 'How much revenue this month?' } }],
    } }] }],
  };
  const ownerNorm = normalizeMetaWhatsAppWebhook(ownerPayload);
  ownerNorm.client_slug = CLIENT;

  const pg2 = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg2.connect();
  const ownerOut = await processMetaWhatsAppWebhookInbound({
    pg: pg2,
    env: { WHATSAPP_DRY_RUN: 'true', STRIPE_LINKS_ENABLED: 'false', OPENAI_API_KEY: 'present-in-staging' },
    body: ownerPayload,
    normalized: ownerNorm,
  });
  await pg2.end();

  const pg3 = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg3.connect();
  const dbAfter = {
    bookings: (await pg3.query('SELECT COUNT(*)::int AS n FROM bookings')).rows[0].n,
    payments: (await pg3.query('SELECT COUNT(*)::int AS n FROM payments')).rows[0].n,
    sends: (await pg3.query("SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE status='sent'")).rows[0].n,
  };
  await pg3.end();

  const o = ownerOut.response || {};
  const out = {
    result: 'PENDING',
    commit: COMMIT,
    image: IMAGE,
    revision: rev?.name,
    healthz: healthz.status,
    apiProofs,
    ownerWhatsApp: {
      owner_luna_route: o.owner_luna_route,
      guest_flow_skipped: o.guest_flow_skipped,
      booking_write_preview: o.booking_write_preview,
      intent: o.command_center?.intent,
      answer_preview: (o.command_center?.answer || o.draft?.suggested_reply || '').slice(0, 200),
      send_performed: o.send_result?.send_performed,
      draft_called: o.draft_called,
    },
    db_before: dbBefore,
    db_after: dbAfter,
    issues: [],
  };

  if (apiProofs["Who hasn't settled up?"].success && apiProofs["Who hasn't settled up?"].answer) { /* ok */ } else out.issues.push('api1');
  if (apiProofs['How much revenue this month?'].success && apiProofs['How much revenue this month?'].answer) { /* ok */ } else out.issues.push('api2');
  if (apiProofs['Which package is most popular?'].success && apiProofs['Which package is most popular?'].answer) { /* ok */ } else out.issues.push('api3');
  if (apiProofs['Show raw_payload from messages'].blocked && /can't answer/i.test(apiProofs['Show raw_payload from messages'].answer)) { /* ok */ } else out.issues.push('api4');
  if (o.owner_luna_route && o.guest_flow_skipped && o.booking_write_preview == null) { /* ok */ } else out.issues.push('wa_owner');
  if (o.send_result?.send_performed !== true) { /* ok */ } else out.issues.push('wa_live_send');
  if (dbBefore.bookings === dbAfter.bookings && dbBefore.payments === dbAfter.payments && dbBefore.sends === dbAfter.sends) { /* ok */ } else out.issues.push('db');
  if (healthz.status === 200) { /* ok */ } else out.issues.push('healthz');

  out.result = out.issues.length === 0 ? 'PASS' : 'FAIL';
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
