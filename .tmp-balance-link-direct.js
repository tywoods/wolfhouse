'use strict';
process.env.STAFF_ACTIONS_ENABLED = 'true';
process.env.STRIPE_LINKS_ENABLED = 'true';
process.env.STRIPE_CHECKOUT_SUCCESS_URL = 'https://staff-staging.lunafrontdesk.com/staff/payment/success?session_id={CHECKOUT_SESSION_ID}';
process.env.STRIPE_CHECKOUT_CANCEL_URL = 'https://staff-staging.lunafrontdesk.com/staff/payment/cancel';
process.env.PUBLIC_PAYMENT_BASE_URL = 'https://staff-staging.lunafrontdesk.com';
process.env.NODE_ENV = 'staging';

const { runGuestBalancePaymentLinkCreateApproved } = require('./scripts/lib/luna-guest-balance-payment-link-create');

async function main() {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.log('Set STRIPE_SECRET_KEY env to test');
    return;
  }
  const { Client } = require('pg');
  const pg = new Client({ connectionString: process.env.WOLFHOUSE_DATABASE_URL || process.env.DB_URL });
  await pg.connect();
  const out = await runGuestBalancePaymentLinkCreateApproved({
    booking_id: '8c4d5efc-21e6-4d0c-a42c-c0ba4ea30988',
    client_slug: 'wolfhouse-somo',
  }, {
    confirm_balance_payment_link: true,
    env: process.env,
    pg,
  });
  await pg.end();
  console.log(JSON.stringify({
    success: out.success,
    balance: out.balance_due_cents,
    url: out.guest_payment_url || out.stripe_checkout_url,
    blocks: out.stripe_link_block_reasons,
    idempotent: out.idempotent,
  }, null, 2));
}
main().catch(e => console.error(e.message));
