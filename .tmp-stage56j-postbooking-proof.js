'use strict';
/** Post-booking meal schedule + transfer times write proof on staging. */

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');

const HOST = 'staff-staging.lunafrontdesk.com';
const PHONE = '+491726422307';
const BOOKING_ID = '22320584-111c-47ab-94e5-da957220da79';
const BOOKING_CODE = 'WH-G27-E6020FC8BE';

function token() {
  return execSync(
    'az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
}

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: HOST,
      path: OPEN_DEMO_WHATSAPP_ROUTE,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${token()}`,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function basePayload(msg, guestContext) {
  const wamid = `wamid.s56j-post-${Date.now()}`;
  return {
    source: 'n8n_open_demo_whatsapp_harness',
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    phone_number_id: '1152900101233109',
    guest_phone: PHONE,
    guest_email: 'open-demo+491726422307@example.test',
    message_text: msg,
    wamid,
    inbound_message_id: wamid,
    received_at: new Date().toISOString(),
    reference_date: '2026-06-12',
    guest_context: guestContext,
  };
}

(async () => {
  const guestContext = {
    client_slug: 'wolfhouse-somo',
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    check_in: '2026-09-01',
    check_out: '2026-09-09',
    guest_count: 2,
    package_interest: 'malibu',
    payment_status: 'deposit_paid',
    meals_request: { status: 'requested', meal_type: 'dinner' },
    services_pending_manual: ['meal'],
  };

  const sched = await post(basePayload('Please schedule my meal for September 2nd', guestContext));
  const body = sched.body || sched;
  console.log('schedule reply:', (body.review && body.review.proposed_luna_reply || '').slice(0, 200));
  console.log('serviceSchedule:', JSON.stringify(body.serviceSchedule, null, 2));

  const xfer = await post(basePayload('We land at 11am and leave at 2pm', {
    ...guestContext,
    transfer_info: { interested: true, airport_code: 'SDR' },
  }));
  const xbody = xfer.body || xfer;
  console.log('transfer reply:', (xbody.review && xbody.review.proposed_luna_reply || '').slice(0, 200));
  console.log('transferTimesUpdate:', JSON.stringify(xbody.transferTimesUpdate, null, 2));

  const veg = await post(basePayload('I am vegetarian by the way', guestContext));
  const vbody = veg.body || veg;
  console.log('lunaNotes:', JSON.stringify(vbody.lunaNotes, null, 2));

  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const meal = (await pg.query(
    `SELECT service_date::text FROM booking_service_records
      WHERE booking_id = $1::uuid AND service_type = 'meal' ORDER BY created_at DESC LIMIT 1`,
    [BOOKING_ID],
  )).rows[0];
  const tr = (await pg.query(
    `SELECT direction, scheduled_at::text, notes FROM booking_transfers WHERE booking_id = $1::uuid ORDER BY direction`,
    [BOOKING_ID],
  )).rows;
  const meta = (await pg.query('SELECT metadata FROM bookings WHERE id = $1::uuid', [BOOKING_ID])).rows[0];
  await pg.end();

  const report = {
    meal_service_date: meal && meal.service_date,
    transfers: tr,
    luna_notes: meta && meta.metadata && meta.metadata.luna_guest_notes,
    ok: meal && meal.service_date === '2026-09-02',
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
