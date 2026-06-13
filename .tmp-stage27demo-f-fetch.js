'use strict';
/** Temp — fetch open demo booking payment state for 27demo-f proof */
const { execSync } = require('child_process');
const { Client } = require('pg');

const BOOKING_CODES = ['WH-G27-850FDAFDB9', 'WH-G27-8E83FAD8BB'];

(async () => {
  const dbUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const stripeKey = execSync(
    'az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name stripe-secret-key --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const rows = await pg.query(
    `SELECT b.booking_code, b.id::text AS booking_id, b.payment_status::text AS booking_payment_status,
            b.amount_paid_cents AS bk_amount_paid, b.balance_due_cents, b.total_amount_cents,
            b.metadata->'confirmation_draft' AS confirmation_draft,
            p.id::text AS payment_id, p.status::text AS payment_status,
            p.amount_due_cents, p.amount_paid_cents, p.currency,
            p.stripe_checkout_session_id, p.checkout_url,
            (SELECT COUNT(*)::int FROM payments p2 WHERE p2.booking_id = b.id) AS payment_row_count,
            (SELECT COUNT(*)::int FROM guest_message_sends g
              WHERE g.to_phone IN ('+491726422307', '+34600995556')) AS whatsapp_send_count
       FROM bookings b
       JOIN payments p ON p.booking_id = b.id AND p.status IN ('checkout_created', 'pending', 'paid', 'draft')
      WHERE b.booking_code = ANY($1::text[])
      ORDER BY b.booking_code, p.created_at ASC`,
    [BOOKING_CODES],
  );
  await pg.end();

  const stripe = require('stripe')(stripeKey);
  const sessions = {};
  for (const r of rows.rows) {
    if (r.stripe_checkout_session_id && !sessions[r.stripe_checkout_session_id]) {
      try {
        const s = await stripe.checkout.sessions.retrieve(r.stripe_checkout_session_id);
        sessions[r.stripe_checkout_session_id] = {
          id: s.id,
          livemode: s.livemode,
          payment_status: s.payment_status,
          status: s.status,
          amount_total: s.amount_total,
          currency: s.currency,
        };
      } catch (e) {
        sessions[r.stripe_checkout_session_id] = { error: e.message };
      }
    }
  }

  console.log(JSON.stringify({
    stripe_key_prefix: stripeKey.slice(0, 8),
    bookings: rows.rows,
    stripe_sessions: sessions,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
