'use strict';
/** Stage 27w.11 — apply Stripe payment truth for paid simulator checkout. Temp — do not commit. */
const { execSync } = require('child_process');
const { Client } = require('pg');
const { runGuestStripePaymentTruthApplyApproved } = require('./scripts/lib/luna-guest-stripe-payment-truth-apply');

const BOOKING_CODE = 'WH-G27-A04DAA0AAE';
const BOOKING_ID = 'ecea9a10-23a7-4f09-8055-09d020d5ff6f';
const PAYMENT_DRAFT_ID = 'ccb4e914-a6fd-49fc-a5b9-1814b9ebec7b';
const HOST = 'staff-staging.lunafrontdesk.com';

function azSecret(name) {
  return execSync(
    `az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name ${name} --query value -o tsv`,
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  ).trim();
}

async function fetchBefore(pg) {
  const r = await pg.query(
    `SELECT p.id, p.status::text AS payment_status, p.amount_due_cents, p.amount_paid_cents,
            p.stripe_checkout_session_id, p.checkout_url IS NOT NULL AS has_checkout_url,
            b.booking_code, b.id::text AS booking_id, b.payment_status::text AS booking_payment_status,
            b.amount_paid_cents AS bk_amount_paid, b.balance_due_cents AS bk_balance,
            b.total_amount_cents AS bk_total, b.metadata->'confirmation_draft' AS confirmation_draft
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE p.id = $1::uuid`,
    [PAYMENT_DRAFT_ID],
  );
  return r.rows[0] || null;
}

async function fetchAfter(pg) {
  const r = await pg.query(
    `SELECT p.status::text AS payment_status, p.amount_paid_cents,
            b.payment_status::text AS booking_payment_status,
            b.amount_paid_cents AS bk_amount_paid, b.balance_due_cents AS bk_balance,
            b.metadata->'confirmation_draft' AS confirmation_draft
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE p.id = $1::uuid`,
    [PAYMENT_DRAFT_ID],
  );
  return r.rows[0] || null;
}

(async () => {
  const dbUrl = azSecret('wolfhouse-database-url');
  const stripeKey = azSecret('stripe-secret-key');
  if (!stripeKey.startsWith('sk_test_')) {
    console.error('FAIL — Stripe key is not sk_test_');
    process.exit(1);
  }

  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const before = await fetchBefore(pg);
  if (!before) {
    console.error('FAIL — payment not found');
    process.exit(1);
  }
  if (before.booking_code !== BOOKING_CODE || before.booking_id !== BOOKING_ID) {
    console.error('FAIL — booking mismatch', { got: before.booking_code, id: before.booking_id });
    process.exit(1);
  }

  const sessionId = before.stripe_checkout_session_id;
  if (!sessionId) {
    console.error('FAIL — no stripe_checkout_session_id on payment');
    process.exit(1);
  }

  const stripe = require('stripe')(stripeKey);
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const stripePaid = session.payment_status === 'paid' && session.status === 'complete';

  const env = {
    NODE_ENV: 'staging',
    STRIPE_SECRET_KEY: stripeKey,
    WHATSAPP_DRY_RUN: 'true',
  };

  const applyInput = {
    payment_draft_id: PAYMENT_DRAFT_ID,
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    stripe_session: session,
    stripe_event: {
      id: `evt_stage27w11_proof_${Date.now()}`,
      type: 'checkout.session.completed',
      livemode: false,
      data: { object: session },
    },
    source: 'luna_guest_simulator_27w11_proof',
    staff_operator: 'stage27w11-proof',
  };

  const result = await runGuestStripePaymentTruthApplyApproved(applyInput, {
    confirm_payment_truth: true,
    env,
    host_header: HOST,
    pg,
  });

  const after = await fetchAfter(pg);
  await pg.end();

  const out = {
    result: result.success && result.payment_truth_recorded ? 'PASS' : (result.idempotent_replay ? 'PASS' : 'FAIL'),
    booking_code: BOOKING_CODE,
    payment_draft_id: PAYMENT_DRAFT_ID,
    stripe_session_id: sessionId,
    stripe_session_paid: stripePaid,
    stripe_livemode: session.livemode,
    payment_status_before: before.payment_status,
    booking_payment_status_before: before.booking_payment_status,
    payment_status_after: after && after.payment_status,
    booking_payment_status_after: after && after.booking_payment_status,
    amount_paid_cents: result.amount_paid_cents ?? (after && after.amount_paid_cents),
    balance_due_cents: result.balance_due_cents ?? (after && after.bk_balance),
    booking_amount_paid_cents: result.booking_amount_paid_cents ?? (after && after.bk_amount_paid),
    next_safe_step: result.next_safe_step,
    payment_truth_recorded: result.payment_truth_recorded,
    confirmation_draft_exists: !!(after && after.confirmation_draft),
    confirmation_sent: result.confirmation_sent,
    sends_whatsapp: result.sends_whatsapp,
    live_send_blocked: result.live_send_blocked,
    idempotent_replay: result.idempotent_replay,
    block_reasons: result.block_reasons || null,
    error: result.error || null,
  };

  if (!stripePaid) out.result = 'FAIL';
  if (!result.payment_truth_recorded) out.result = 'FAIL';
  if (result.next_safe_step !== 'ready_for_confirmation_dry_run') out.result = out.result === 'PASS' ? 'PARTIAL' : out.result;
  if (after && after.booking_payment_status !== 'deposit_paid' && after.booking_payment_status !== 'paid') {
    out.result = out.result === 'PASS' ? 'PARTIAL' : out.result;
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error('FAIL —', e.message);
  process.exit(1);
});
