'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const db = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
(async () => {
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const bookings = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.status::text, b.payment_status::text,
           b.check_in::text, b.check_out::text, b.guest_count, b.package_code,
           b.balance_due_cents, b.confirmation_sent_at::text, b.created_at::text, b.phone
      FROM bookings b JOIN clients c ON c.id = b.client_id
     WHERE c.slug = 'wolfhouse-somo'
       AND REPLACE(COALESCE(b.phone, ''), '+', '') = '491726422307'
     ORDER BY b.created_at DESC LIMIT 5`);
  let payment = null;
  let yoga = [];
  if (bookings.rows[0]) {
    payment = (await pg.query(
      `SELECT id::text, status, checkout_url, stripe_checkout_session_id, created_at::text
         FROM payments WHERE booking_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [bookings.rows[0].booking_id],
    )).rows[0] || null;
    yoga = (await pg.query(
      `SELECT service_type, status, source, metadata FROM booking_service_records
        WHERE booking_id = $1::uuid AND service_type = 'yoga'`,
      [bookings.rows[0].booking_id],
    )).rows;
  }
  const gates = JSON.parse(execSync(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
    { encoding: 'utf8' },
  ));
  const pick = (n) => { const e = gates.find((x) => x.name === n); return e ? (e.secretRef || e.value) : null; };
  console.log(JSON.stringify({
    bookings: bookings.rows,
    payment,
    yoga,
    gates: {
      WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
      WRITES: pick('OPEN_DEMO_BOOKING_WRITES_ENABLED'),
      LIVE: pick('OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED'),
      STRIPE: pick('OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED'),
      ALLOWLIST: pick('LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST'),
    },
  }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
