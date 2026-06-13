'use strict';
/** Stage 27demo-f — open demo payment truth proof. Temp — do not commit. */
const { execSync } = require('child_process');
const { Client } = require('pg');
const { runGuestStripePaymentTruthApplyApproved } = require('./scripts/lib/luna-guest-stripe-payment-truth-apply');

const BOOKING_CODE = 'WH-G27-850FDAFDB9';
const BOOKING_ID = 'ba1a0426-c1c7-469e-a7c4-edf9b89ee12d';
const PAYMENT_ID = '70a959f8-7e5c-43b2-b7e4-53497ea7cdec';
const SESSION_ID = 'cs_test_a1CHFkWcUvCPPxbbVNe0HH7eOAxTyuGcFE0InuEk6VDjH0TH7JdqPGgik5';
const HOST = 'staff-staging.lunafrontdesk.com';

function azSecret(name) {
  return execSync(
    `az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name ${name} --query value -o tsv`,
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  ).trim();
}

function azEnv(names) {
  const app = JSON.parse(execSync(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? e.value : null;
  }
  return out;
}

async function snapshot(pg, label) {
  const pay = await pg.query(
    `SELECT p.id::text, p.status::text AS payment_status, p.amount_due_cents, p.amount_paid_cents,
            p.stripe_checkout_session_id, p.paid_at,
            b.booking_code, b.id::text AS booking_id, b.payment_status::text AS booking_payment_status,
            b.amount_paid_cents AS bk_amount_paid, b.balance_due_cents, b.total_amount_cents,
            b.metadata->'confirmation_draft' AS confirmation_draft,
            b.metadata->'confirmation_sent_at' AS confirmation_sent_at
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE p.id = $1::uuid`,
    [PAYMENT_ID],
  );
  const payCount = await pg.query(
    'SELECT COUNT(*)::int AS n FROM payments WHERE booking_id = $1::uuid',
    [BOOKING_ID],
  );
  const sends = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE to_phone = '+491726422307' AND created_at >= NOW() - INTERVAL '30 minutes'`,
  );
  const dryErr = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE status::text = 'failed'
       AND message_text LIKE '%LUNA_REVIEW_DRY_RUN_ERROR%'`,
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return {
    label,
    row: pay.rows[0] || null,
    payment_row_count: payCount.rows[0].n,
    recent_whatsapp_sends: sends.rows[0].n,
    dry_run_errors: dryErr.rows[0].n,
  };
}

function buildFixtureSession(stripeSession) {
  return {
    ...stripeSession,
    livemode: false,
    payment_status: stripeSession.payment_status === 'paid' ? 'paid' : 'paid',
    status: stripeSession.status === 'complete' ? 'complete' : 'complete',
    amount_total: stripeSession.amount_total,
    currency: stripeSession.currency || 'eur',
    metadata: stripeSession.metadata,
    payment_intent: stripeSession.payment_intent || 'pi_test_stage27demo_f_fixture',
  };
}

(async () => {
  const proofStart = new Date().toISOString();
  const dbUrl = azSecret('wolfhouse-database-url');
  const stripeKey = azSecret('stripe-secret-key');
  if (!stripeKey.startsWith('sk_test_')) {
    console.error(JSON.stringify({ result: 'FAIL', error: 'stripe_key_not_test' }));
    process.exit(1);
  }

  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const before = await snapshot(pg, 'before');
  if (!before.row || before.row.booking_code !== BOOKING_CODE) {
    await pg.end();
    console.error(JSON.stringify({ result: 'FAIL', error: 'booking_not_found' }));
    process.exit(1);
  }
  if (before.row.payment_status === 'paid') {
    await pg.end();
    console.log(JSON.stringify({ result: 'PASS', note: 'already_paid', before: before.row }, null, 2));
    process.exit(0);
  }

  const stripe = require('stripe')(stripeKey);
  const liveSession = await stripe.checkout.sessions.retrieve(SESSION_ID);
  const stripeCheckoutPaid = liveSession.payment_status === 'paid' && liveSession.status === 'complete';
  const paymentMethod = stripeCheckoutPaid ? 'real_stripe_test_checkout' : '27p_fixture_from_stripe_session';

  const sessionForApply = stripeCheckoutPaid ? liveSession : buildFixtureSession(liveSession);
  const env = {
    NODE_ENV: 'staging',
    STRIPE_SECRET_KEY: stripeKey,
    WHATSAPP_DRY_RUN: 'true',
    OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
    OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
    OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
  };

  const applyInput = {
    payment_draft_id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    stripe_session: sessionForApply,
    stripe_event: {
      id: `evt_stage27demo_f_${Date.now()}`,
      type: 'checkout.session.completed',
      livemode: false,
      data: { object: sessionForApply },
    },
    source: 'open_demo_whatsapp_payment_truth_27demo-f',
    staff_operator: 'stage27demo-f-proof',
  };

  const apply1 = await runGuestStripePaymentTruthApplyApproved(applyInput, {
    confirm_payment_truth: true,
    env,
    host_header: HOST,
    pg,
  });

  const afterApply1 = await snapshot(pg, 'after_apply1');

  const apply2 = await runGuestStripePaymentTruthApplyApproved(applyInput, {
    confirm_payment_truth: true,
    env,
    host_header: HOST,
    pg,
  });

  const afterReplay = await snapshot(pg, 'after_replay');
  await pg.end();

  const gates = azEnv([
    'WHATSAPP_DRY_RUN',
    'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
    'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
    'OPEN_DEMO_BOOKING_WRITES_ENABLED',
  ]);

  const row = afterReplay.row || afterApply1.row;
  const checks = {
    apply_success: apply1.success === true && apply1.payment_truth_recorded === true,
    payment_paid: row && row.payment_status === 'paid',
    booking_deposit_or_paid: row && (row.booking_payment_status === 'deposit_paid' || row.booking_payment_status === 'paid'),
    amount_paid_correct: row && Number(row.amount_paid_cents) === 20000,
    balance_correct: row && Number(row.balance_due_cents) === 49800,
    bk_amount_paid: row && Number(row.bk_amount_paid) === 20000,
    no_dup_payments: afterReplay.payment_row_count === 1,
    idempotent_replay: apply2.idempotent_replay === true,
    no_whatsapp_delta: afterReplay.recent_whatsapp_sends === before.recent_whatsapp_sends,
    confirmation_sent_false: apply1.confirmation_sent === false && apply2.confirmation_sent === false,
    sends_whatsapp_false: apply1.sends_whatsapp === false,
    stripe_test_mode: liveSession.livemode === false,
    next_safe_step: apply1.next_safe_step === 'ready_for_confirmation_dry_run',
    no_dry_run_errors: afterReplay.dry_run_errors === 0,
  };

  const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  const result = failures.length === 0 ? 'PASS' : 'FAIL';

  const out = {
    result,
    code_changed: false,
    commit: null,
    target_booking_code: BOOKING_CODE,
    payment_id: PAYMENT_ID,
    checkout_session_id: SESSION_ID,
    payment_method: paymentMethod,
    stripe_session_live_paid: stripeCheckoutPaid,
    before: {
      payment_status: before.row.payment_status,
      booking_payment_status: before.row.booking_payment_status,
      amount_paid_cents: before.row.amount_paid_cents,
      balance_due_cents: before.row.balance_due_cents,
      confirmation_draft: before.row.confirmation_draft,
    },
    after: {
      payment_status: row && row.payment_status,
      booking_payment_status: row && row.booking_payment_status,
      amount_paid_cents: row && row.amount_paid_cents,
      balance_due_cents: row && row.balance_due_cents,
      bk_amount_paid_cents: row && row.bk_amount_paid,
      confirmation_draft: row && row.confirmation_draft,
      confirmation_sent_at: row && row.confirmation_sent_at,
    },
    apply1: {
      payment_truth_recorded: apply1.payment_truth_recorded,
      next_safe_step: apply1.next_safe_step,
      confirmation_sent: apply1.confirmation_sent,
      sends_whatsapp: apply1.sends_whatsapp,
      block_reasons: apply1.block_reasons || null,
    },
    idempotency_replay: {
      idempotent_replay: apply2.idempotent_replay,
      payment_truth_recorded: apply2.payment_truth_recorded,
      amount_paid_cents: apply2.amount_paid_cents,
    },
    whatsapp_send_count_30m_before: before.recent_whatsapp_sends,
    whatsapp_send_count_30m_after: afterReplay.recent_whatsapp_sends,
    payment_row_count: afterReplay.payment_row_count,
    gates,
    safety: {
      stripe_key_prefix: 'sk_test_',
      livemode: false,
      no_confirmation_whatsapp: apply1.confirmation_sent === false,
      dry_run_errors: afterReplay.dry_run_errors,
    },
    failures,
    proof_started_at: proofStart,
    recommended_next_step: result === 'PASS'
      ? 'Stage 27demo-g optional confirmation preview/dry-run, or 27q on open-demo booking'
      : 'Fix block_reasons and re-run once; do not blind retry',
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(JSON.stringify({ result: 'FAIL', error: e.message }));
  process.exit(1);
});
