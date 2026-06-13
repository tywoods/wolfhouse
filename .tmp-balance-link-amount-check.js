'use strict';
const { execSync } = require('child_process');
const { runGuestBalancePaymentLinkCreateApproved } = require('./scripts/lib/luna-guest-balance-payment-link-create');
const { Client } = require('pg');

(async () => {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const bk = await pg.query(
    `SELECT id::text FROM bookings WHERE booking_code = 'WH-G27-5AD46DDF56'`,
  );
  const out = await runGuestBalancePaymentLinkCreateApproved({
    booking_id: bk.rows[0].id,
    client_slug: 'wolfhouse-somo',
    inbound_message_id: 'balance-invoice-fix-check',
  }, {
    confirm_balance_payment_link: true,
    env: {
      STAFF_ACTIONS_ENABLED: 'true',
      STRIPE_LINKS_ENABLED: 'true',
      STRIPE_SECRET_KEY: execSync(
        'az keyvault secret show --vault-name wh-staging-kv --name stripe-secret-key --query value -o tsv',
        { encoding: 'utf8' },
      ).trim(),
      STRIPE_CHECKOUT_SUCCESS_URL: 'https://staff-staging.lunafrontdesk.com/pay/success',
      STRIPE_CHECKOUT_CANCEL_URL: 'https://staff-staging.lunafrontdesk.com/pay/cancel',
      NODE_ENV: 'staging',
    },
    pg,
    host_header: 'staff-staging.lunafrontdesk.com',
  });
  console.log(JSON.stringify({
    success: out.success,
    balance_due_cents: out.balance_due_cents,
    amount_due_cents: out.amount_due_cents,
    idempotent: out.idempotent,
    guest_payment_url: out.guest_payment_url,
  }, null, 2));
  await pg.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
