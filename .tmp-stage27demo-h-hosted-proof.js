'use strict';
/** Stage 27demo-h — confirmation send go/no-go proof. Temp — do not commit. */
const { execSync } = require('child_process');
const { Client } = require('pg');
const { runGuestConfirmationPreviewDryRun } = require('./scripts/lib/luna-guest-confirmation-preview-dry-run');
const { runGuestConfirmationSendGoNoGo } = require('./scripts/lib/luna-guest-confirmation-send-go-no-go');

const BOOKING_CODE = 'WH-G27-850FDAFDB9';
const BOOKING_ID = 'ba1a0426-c1c7-469e-a7c4-edf9b89ee12d';
const CLIENT = 'wolfhouse-somo';
const TO_PHONE = '+491726422307';

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

async function paymentSnapshot(pg) {
  const r = await pg.query(
    `SELECT b.booking_code, b.payment_status::text, b.amount_paid_cents, b.balance_due_cents,
            b.confirmation_sent_at,
            p.id::text AS payment_id, p.status::text AS payment_status_row,
            p.amount_paid_cents AS pay_amount_paid
       FROM bookings b
       JOIN payments p ON p.booking_id = b.id
      WHERE b.booking_code = $1
      ORDER BY p.created_at ASC LIMIT 1`,
    [BOOKING_CODE],
  );
  return r.rows[0] || null;
}

async function sendCount(pg, since) {
  const r = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE created_at >= $1::timestamptz`,
    [since],
  );
  return r.rows[0].n;
}

(async () => {
  const proofStart = new Date().toISOString();
  const dbUrl = azSecret('wolfhouse-database-url');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const env = {
    NODE_ENV: 'staging',
    WHATSAPP_DRY_RUN: 'true',
    OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
    LUNA_AUTO_SEND_ENABLED: 'true',
  };

  const beforePay = await paymentSnapshot(pg);
  const sendsBefore = await sendCount(pg, proofStart);

  const preview1 = await runGuestConfirmationPreviewDryRun(
    { booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: CLIENT, language_hint: 'en' },
    { pg, env, host_header: 'staff-staging.lunafrontdesk.com' },
  );

  const goNoGo1 = await runGuestConfirmationSendGoNoGo(
    {
      confirmation_preview_result: preview1,
      confirm_send: false,
      to: TO_PHONE,
      idempotency_key: `open-demo:27demo-h:${BOOKING_CODE}:not-approved`,
      client_slug: CLIENT,
      booking_id: BOOKING_ID,
      booking_code: BOOKING_CODE,
    },
    { pg, env },
  );

  const preview2 = await runGuestConfirmationPreviewDryRun(
    { booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: CLIENT, language_hint: 'en' },
    { pg, env, host_header: 'staff-staging.lunafrontdesk.com' },
  );

  const goNoGo2 = await runGuestConfirmationSendGoNoGo(
    {
      confirmation_preview_result: preview2,
      confirm_send: false,
      to: TO_PHONE,
      idempotency_key: `open-demo:27demo-h:${BOOKING_CODE}:not-approved-rerun`,
      client_slug: CLIENT,
      booking_id: BOOKING_ID,
      booking_code: BOOKING_CODE,
    },
    { pg, env },
  );

  const afterPay = await paymentSnapshot(pg);
  const sendsAfter = await sendCount(pg, proofStart);
  await pg.end();

  const msg = preview1.proposed_confirmation_message || '';
  const checks = {
    preview_ready: preview1.confirmation_preview_ready === true,
    preview_next_step: preview1.next_safe_step === 'ready_for_confirmation_send_go_no_go',
    preview_send_allowed_false: preview1.confirmation_send_allowed === false,
    room_in_message: /DEMO-R2/i.test(msg),
    gate_not_approved: goNoGo1.send_status === 'not_approved',
    gate_no_attempt: goNoGo1.send_attempted !== true,
    gate_no_whatsapp: goNoGo1.sends_whatsapp !== true,
    gate_no_confirm: goNoGo1.confirmation_sent !== true,
    confirm_sent_at_null: afterPay && afterPay.confirmation_sent_at == null,
    payment_unchanged: beforePay && afterPay
      && beforePay.payment_status === afterPay.payment_status
      && Number(beforePay.amount_paid_cents) === Number(afterPay.amount_paid_cents)
      && Number(beforePay.balance_due_cents) === Number(afterPay.balance_due_cents),
    no_whatsapp_rows: sendsAfter === sendsBefore,
    idempotent_preview: preview2.proposed_confirmation_message === preview1.proposed_confirmation_message,
    idempotent_gate: goNoGo2.send_status === 'not_approved',
  };

  const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  const result = failures.length === 0 ? 'PASS' : 'FAIL';

  console.log(JSON.stringify({
    result,
    code_changed: false,
    commit: null,
    local_code_includes: '2d4dfde-room-fallback',
    staging_image: azEnv([]) && execSync(
      'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].image -o tsv',
      { encoding: 'utf8' },
    ).trim(),
    target_booking_code: BOOKING_CODE,
    go_no_go: {
      send_status: goNoGo1.send_status,
      next_safe_step: goNoGo1.next_safe_step,
      send_attempted: goNoGo1.send_attempted,
      sends_whatsapp: goNoGo1.sends_whatsapp,
      confirmation_sent: goNoGo1.confirmation_sent,
      block_reasons: goNoGo1.block_reasons,
    },
    preview: {
      confirmation_preview_ready: preview1.confirmation_preview_ready,
      confirmation_send_allowed: preview1.confirmation_send_allowed,
      next_safe_step: preview1.next_safe_step,
      room_label: preview1.room_label,
      payment_status: preview1.payment_status,
      balance_due_cents: preview1.balance_due_cents,
      message_excerpt: msg.slice(0, 400),
    },
    confirmation_sent_at: afterPay && afterPay.confirmation_sent_at,
    whatsapp_sends_during_proof: sendsAfter - sendsBefore,
    payment_state: {
      before: beforePay,
      after: afterPay,
    },
    idempotency: {
      preview_messages_match: preview2.proposed_confirmation_message === preview1.proposed_confirmation_message,
      go_no_go_rerun_status: goNoGo2.send_status,
    },
    safety: {
      no_live_whatsapp: goNoGo1.sends_whatsapp !== true && sendsAfter === sendsBefore,
      no_confirmation_sent_at: afterPay && afterPay.confirmation_sent_at == null,
      payment_truth_unchanged: checks.payment_unchanged,
      whatsapp_dry_run: env.WHATSAPP_DRY_RUN,
    },
    gates: azEnv([
      'WHATSAPP_DRY_RUN',
      'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
      'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
      'OPEN_DEMO_BOOKING_WRITES_ENABLED',
    ]),
    failures,
    recommended_next_step: result === 'PASS'
      ? 'Stage 27demo-i optional live confirmation send (27s allowlist + explicit GO) or deploy 2d4dfde to staging API'
      : 'Inspect failures; do not enable live send until PASS',
  }, null, 2));

  process.exit(result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(JSON.stringify({ result: 'FAIL', error: e.message }));
  process.exit(1);
});
