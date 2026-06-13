'use strict';
/**
 * Stage 8.8.26 — hosted bot addon-request-preview proof
 */
const https = require('https');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const BASE = 'https://staff-staging.lunafrontdesk.com';
const BOOKING_CODE = 'MB-WOLFHO-20260901-cb4799';
const TOKEN = process.env.LUNA_BOT_INTERNAL_TOKEN;
const BOOKING_ID = 'e15b7554-c766-4357-beb3-d23262e3b7b8';

if (!TOKEN) {
  console.error('LUNA_BOT_INTERNAL_TOKEN required');
  process.exit(1);
}

function post(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'staff-staging.lunafrontdesk.com',
      path: '/staff/bot/addon-request-preview',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Luna-Bot-Token': TOKEN,
      },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function dbCounts() {
  const c = new Client({
    connectionString: process.env.WOLFHOUSE_DATABASE_URL,
    ssl: process.env.WOLFHOUSE_DATABASE_URL?.includes('azure') ? { rejectUnauthorized: false } : undefined,
  });
  await c.connect();
  try {
    const svc = await c.query(
      'SELECT COUNT(*)::int AS n FROM booking_service_records WHERE booking_id = $1',
      [BOOKING_ID],
    );
    const pm = await c.query(
      'SELECT COUNT(*)::int AS n FROM payments WHERE booking_id = $1',
      [BOOKING_ID],
    );
    const checkout = await c.query(
      `SELECT COUNT(*)::int AS n FROM payments
        WHERE booking_id = $1 AND stripe_checkout_session_id IS NOT NULL`,
      [BOOKING_ID],
    );
    return {
      service_records: svc.rows[0].n,
      payments: pm.rows[0].n,
      payments_with_checkout: checkout.rows[0].n,
    };
  } finally {
    await c.end();
  }
}

const base = {
  client_slug: 'wolfhouse-somo',
  booking_code: BOOKING_CODE,
  source: 'luna_whatsapp',
};

const cases = [
  {
    id: 'A',
    body: { ...base, service_type: 'wetsuit', quantity: 1 },
    check: (b) => b.next_action === 'ask_service_date' && b.preview_only === true && b.no_write_performed === true,
  },
  {
    id: 'B',
    body: { ...base, service_type: 'wetsuit', service_date: '2026-09-01', quantity: 0 },
    check: (b) => b.next_action === 'ask_quantity',
  },
  {
    id: 'C',
    body: { ...base, service_type: 'meal', service_date: '2026-09-01', quantity: 1, payment_choice: 'pay_now' },
    check: (b) => b.payment_preview?.payment_required === false
      && b.payment_preview?.reason === 'meal_on_site_only'
      && b.next_action === 'ready_for_record_only'
      && b.creates_payment === false
      && b.creates_stripe_link === false,
  },
  {
    id: 'D',
    body: { ...base, service_type: 'wetsuit', service_date: '2026-09-01', quantity: 1, payment_choice: 'pay_now' },
    check: (b) => b.next_action === 'ready_for_addon_create_dry_run'
      && b.payment_preview?.payment_required === true
      && b.service_record_preview
      && b.payment_preview
      && b.creates_service_record === false
      && b.creates_payment === false
      && b.creates_stripe_link === false
      && b.amount_due_cents === 500,
  },
  {
    id: 'E',
    body: { ...base, service_type: 'surf_lesson', service_date: '2026-09-01', quantity: 2, payment_choice: 'pay_now' },
    check: (b) => b.payment_preview?.payment_required === true
      && b.amount_due_cents === 6000
      && b.pricing_addon_code === 'surf_lesson_multi'
      && b.creates_service_record === false
      && b.creates_payment === false
      && b.creates_stripe_link === false,
  },
];

async function main() {
  console.log('=== DB BEFORE ===');
  const before = await dbCounts();
  console.log(JSON.stringify(before, null, 2));

  let passed = 0;
  let failed = 0;
  for (const tc of cases) {
    const r = await post(tc.body);
    const ok = r.status === 200 && tc.check(r.body);
    console.log(`\n=== CASE ${tc.id} ${ok ? 'PASS' : 'FAIL'} (${r.status}) ===`);
    console.log(JSON.stringify(r.body, null, 2));
    if (ok) passed++; else failed++;
  }

  console.log('\n=== DB AFTER ===');
  const after = await dbCounts();
  console.log(JSON.stringify(after, null, 2));
  const dbOk = before.service_records === after.service_records
    && before.payments === after.payments
    && before.payments_with_checkout === after.payments_with_checkout;
  console.log(`\nDB NO-WRITE: ${dbOk ? 'PASS' : 'FAIL'}`);
  console.log(`API CASES: ${passed}/${cases.length} PASS`);
  process.exit(failed > 0 || !dbOk ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
