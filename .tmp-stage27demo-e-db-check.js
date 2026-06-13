'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');

(async () => {
  const dbUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const sk = execSync(
    'az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name stripe-secret-key --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const beds = await pg.query(
    `SELECT b.booking_code, COUNT(*)::int AS n
       FROM booking_beds bb
       JOIN bookings b ON b.id = bb.booking_id
      WHERE b.booking_code IN ('WH-G27-8E83FAD8BB', 'WH-G27-850FDAFDB9')
      GROUP BY b.booking_code`,
  );
  const payments = await pg.query(
    `SELECT b.booking_code, p.status::text, p.stripe_checkout_session_id,
            p.amount_paid_cents, p.checkout_url IS NOT NULL AS has_url
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE b.booking_code IN ('WH-G27-8E83FAD8BB', 'WH-G27-850FDAFDB9')
      ORDER BY b.booking_code`,
  );
  const sends = await pg.query(
    `SELECT to_phone, status::text, send_kind,
            message_text LIKE '%checkout.stripe.com%' AS has_stripe_url,
            provider_message_id
       FROM guest_message_sends
      WHERE to_phone = '+491726422307'
      ORDER BY created_at DESC LIMIT 1`,
  );
  const dryErr = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE status::text LIKE '%LUNA_REVIEW_DRY_RUN_ERROR%'`,
  ).catch(() => ({ rows: [{ n: -1 }] }));
  await pg.end();
  console.log(JSON.stringify({
    stripe_key_prefix: sk.slice(0, 8),
    stripe_key_is_test: sk.startsWith('sk_test_'),
    beds: beds.rows,
    payments: payments.rows,
    whatsapp_send: sends.rows[0] || null,
    dry_run_errors: dryErr.rows[0].n,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
