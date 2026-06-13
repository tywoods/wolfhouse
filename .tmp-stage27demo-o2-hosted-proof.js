'use strict';
/** Stage 27demo-o.2 — confirmation send go/no-go dry-run proof. Temp — do not commit. */
const { execSync } = require('child_process');
const { Client } = require('pg');
const { runGuestConfirmationPreviewDryRun } = require('./scripts/lib/luna-guest-confirmation-preview-dry-run');
const { runGuestConfirmationSendGoNoGo } = require('./scripts/lib/luna-guest-confirmation-send-go-no-go');

const HOST = 'staff-staging.lunafrontdesk.com';
const BOOKING_CODE = 'WH-G27-0ECC1D9B57';
const BOOKING_ID = '0ade1b48-2087-4ac1-8019-d3e651ab2c2b';
const CLIENT = 'wolfhouse-somo';
const TO_PHONE = '+34600995557';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return { name: a.name, health: a.properties.healthState, image: a.properties?.template?.containers?.[0]?.image };
}

function azSecret(name) {
  return az(`az keyvault secret show --vault-name wh-staging-kv --name ${name} --query value -o tsv`);
}

function azEnv(names) {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? (e.secretRef ? `(secret:${e.secretRef})` : e.value) : null;
  }
  return out;
}

async function bookingSnapshot(pg, since) {
  const bk = await pg.query(
    `SELECT b.booking_code, b.status::text AS booking_status,
            b.payment_status::text, b.amount_paid_cents, b.balance_due_cents,
            b.confirmation_sent_at,
            (SELECT string_agg(bb.bed_code, ', ' ORDER BY bb.bed_code)
               FROM booking_beds bb WHERE bb.booking_id = b.id) AS bed_codes
       FROM bookings b WHERE b.booking_code = $1`,
    [BOOKING_CODE],
  );

  const pays = await pg.query(
    `SELECT p.id::text, p.status::text, p.amount_paid_cents, p.stripe_checkout_session_id
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE b.booking_code = $1`,
    [BOOKING_CODE],
  );

  const sends = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE to_phone = $1 AND created_at >= $2::timestamptz`,
    [TO_PHONE, since],
  );

  return { booking: bk.rows[0] || null, payments: pays.rows, guest_sends: sends.rows[0].n };
}

(async () => {
  const proofStart = new Date().toISOString();
  const out = {
    stage: '27demo-o.2',
    booking_code: BOOKING_CODE,
    guest_phone: TO_PHONE,
    proof_start: proofStart,
    deploy_needed: false,
    code_changed: false,
  };

  try {
    out.healthz = Number(execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim());
    out.revision = activeRevision();
    out.gates = azEnv([
      'WHATSAPP_DRY_RUN',
      'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
      'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
      'OPEN_DEMO_BOOKING_WRITES_ENABLED',
      'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
    ]);

    const pg = new Client({ connectionString: azSecret('wolfhouse-database-url'), ssl: { rejectUnauthorized: false } });
    await pg.connect();

    out.pre = await bookingSnapshot(pg, proofStart);
    if (!out.pre.booking) throw new Error('booking_not_found');

    const env = {
      NODE_ENV: 'staging',
      WHATSAPP_DRY_RUN: 'true',
      OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
      LUNA_AUTO_SEND_ENABLED: 'true',
    };

    const preview1 = await runGuestConfirmationPreviewDryRun(
      { booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: CLIENT, language_hint: 'en' },
      { pg, env, host_header: HOST },
    );

    const goNoGo1 = await runGuestConfirmationSendGoNoGo(
      {
        confirmation_preview_result: preview1,
        confirm_send: false,
        to: TO_PHONE,
        idempotency_key: `open-demo:27demo-o2:${BOOKING_CODE}:not-approved`,
        client_slug: CLIENT,
        booking_id: BOOKING_ID,
        booking_code: BOOKING_CODE,
      },
      { pg, env },
    );

    const preview2 = await runGuestConfirmationPreviewDryRun(
      { booking_id: BOOKING_ID, booking_code: BOOKING_CODE, client_slug: CLIENT, language_hint: 'en' },
      { pg, env, host_header: HOST },
    );

    const goNoGo2 = await runGuestConfirmationSendGoNoGo(
      {
        confirmation_preview_result: preview2,
        confirm_send: false,
        to: TO_PHONE,
        idempotency_key: `open-demo:27demo-o2:${BOOKING_CODE}:not-approved-rerun`,
        client_slug: CLIENT,
        booking_id: BOOKING_ID,
        booking_code: BOOKING_CODE,
      },
      { pg, env },
    );

    out.post = await bookingSnapshot(pg, proofStart);
    await pg.end();

    const msg = preview1.proposed_confirmation_message || '';
    out.preview = {
      confirmation_preview_ready: preview1.confirmation_preview_ready,
      confirmation_send_allowed: preview1.confirmation_send_allowed,
      next_safe_step: preview1.next_safe_step,
      room_label: preview1.room_label,
      payment_status: preview1.payment_status,
      balance_due_cents: preview1.balance_due_cents,
      message_available: msg.length > 0,
      message_excerpt: msg.slice(0, 400),
    };

    out.go_no_go_1 = {
      success: goNoGo1.success,
      send_status: goNoGo1.send_status,
      next_safe_step: goNoGo1.next_safe_step,
      send_attempted: goNoGo1.send_attempted,
      sends_whatsapp: goNoGo1.sends_whatsapp,
      live_send_blocked: goNoGo1.live_send_blocked,
      confirmation_sent: goNoGo1.confirmation_sent,
      block_reasons: goNoGo1.block_reasons,
      provider_message_id: goNoGo1.provider_message_id || goNoGo1.message_id || null,
      preview_regenerated: goNoGo1.preview_regenerated,
      proposed_confirmation_message: goNoGo1.proposed_confirmation_message ? '(present)' : null,
      staff_notice: goNoGo1.staff_notice,
    };

    out.go_no_go_2 = {
      send_status: goNoGo2.send_status,
      send_attempted: goNoGo2.send_attempted,
      sends_whatsapp: goNoGo2.sends_whatsapp,
      confirmation_sent: goNoGo2.confirmation_sent,
      block_reasons: goNoGo2.block_reasons,
    };

    out.idempotency = {
      preview_messages_match: preview2.proposed_confirmation_message === preview1.proposed_confirmation_message,
      go_no_go_rerun_status: goNoGo2.send_status,
      go_no_go_rerun_blocked: goNoGo2.send_attempted !== true && goNoGo2.sends_whatsapp !== true,
    };

    const allowedNextSteps = new Set([
      'awaiting_confirmation_send_go_no_go',
      'ready_for_confirmation_send_go_no_go',
      'blocked_waiting_for_explicit_send_approval',
    ]);

    out.checks = {
      healthz_200: out.healthz === 200,
      preview_ready: preview1.confirmation_preview_ready === true,
      preview_next_step: preview1.next_safe_step === 'ready_for_confirmation_send_go_no_go',
      preview_send_allowed_false: preview1.confirmation_send_allowed === false,
      message_available: msg.length > 0,
      room_in_message: /DEMO-R2/i.test(msg),
      send_blocked_not_approved: goNoGo1.send_status === 'not_approved',
      send_not_attempted: goNoGo1.send_attempted !== true,
      sends_whatsapp_false: goNoGo1.sends_whatsapp !== true,
      live_send_blocked: goNoGo1.live_send_blocked === true,
      confirmation_sent_false: goNoGo1.confirmation_sent !== true,
      no_provider_message_id: !goNoGo1.provider_message_id && !goNoGo1.message_id,
      block_reason_confirm_send: (goNoGo1.block_reasons || []).includes('confirm_send_required'),
      next_safe_step_blocked: allowedNextSteps.has(goNoGo1.next_safe_step),
      confirm_sent_at_null: out.post.booking.confirmation_sent_at == null,
      payment_status_unchanged: out.pre.booking.payment_status === out.post.booking.payment_status,
      amount_paid_unchanged: Number(out.pre.booking.amount_paid_cents) === Number(out.post.booking.amount_paid_cents),
      balance_unchanged: Number(out.pre.booking.balance_due_cents) === Number(out.post.booking.balance_due_cents),
      booking_status_unchanged: out.pre.booking.booking_status === out.post.booking.booking_status,
      no_whatsapp_sends: out.post.guest_sends === out.pre.guest_sends,
      no_payment_mutation: JSON.stringify(out.pre.payments) === JSON.stringify(out.post.payments),
      idempotent_gate: goNoGo2.send_status === 'not_approved' && goNoGo2.send_attempted !== true,
      whatsapp_dry_run_env: env.WHATSAPP_DRY_RUN === 'true',
    };

    const failures = Object.entries(out.checks).filter(([, ok]) => !ok).map(([k]) => k);
    out.failures = failures;
    out.verdict = failures.length === 0 ? 'PASS' : failures.length <= 2 ? 'PARTIAL' : 'FAIL';
    out.recommended_next = failures.length === 0
      ? 'Stage 27demo-i optional live confirmation send (27s allowlist + confirm_send:true) — not in o.2 scope'
      : `Fix: ${failures.join(', ')}`;
  } catch (err) {
    out.error = err.message;
    out.verdict = 'FAIL';
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.verdict === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
