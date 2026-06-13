'use strict';
const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const token = execSync(
  'az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv',
  { encoding: 'utf8' },
).trim();

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = https.request({
      hostname: HOST,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Luna-Bot-Token': token,
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 180000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, bytes: Buffer.byteLength(data) });
      });
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

function guestContextFromReview(apiBody) {
  const r = (apiBody && apiBody.review) || {};
  return {
    message_lane: r.result && r.result.message_lane,
    booking_intake_ready: r.result && r.result.booking_intake_ready,
    readiness_state: r.result && r.result.readiness_state,
    extracted_fields: r.result && r.result.extracted_fields,
    result: r.result,
    availability: r.availability,
    quote: r.quote,
    payment_choice: r.payment_choice,
    hold_payment_draft_plan: r.hold_payment_draft_plan,
  };
}

function reviewPayload(messageText, guestContext, phone) {
  return {
    client_slug: 'wolfhouse-somo',
    channel: 'staff_review',
    message_text: messageText,
    dry_run: true,
    reference_date: '2026-06-08',
    guest_phone: phone,
    automation_gate_context: { public_guest_automation_enabled: false, whatsapp_dry_run: true },
    guest_context: guestContext || undefined,
  };
}

(async () => {
  const phone = '+34600999994';
  let guestContext = null;
  let lastReview = null;
  for (const msg of [
    'Hi, we are 2 people interested in the Malibu package',
    'July 10 to July 17',
    'Deposit is fine',
  ]) {
    const out = await post('/staff/bot/guest-automation-review-dry-run', reviewPayload(msg, guestContext, phone));
    guestContext = guestContextFromReview(out.body);
    lastReview = out.body.review;
  }

  const r = lastReview;
  const harnessPayload = {
    source: 'luna_guest_simulator',
    confirm_simulator_write: true,
    confirm_write: true,
    client_slug: 'wolfhouse-somo',
    guest_name: 'Staging Test Guest',
    guest_email: 'staging-test@wolfhouse.test',
    guest_phone: phone,
    guest_context: guestContext,
    hold_payment_draft_plan: r.hold_payment_draft_plan,
    chain: {
      result: r.result,
      availability: r.availability,
      quote: r.quote,
      payment_choice: r.payment_choice,
      hold_payment_draft_plan: r.hold_payment_draft_plan,
    },
  };

  const full = await post('/staff/bot/guest-simulator-create-hold-draft', harnessPayload);
  const plan = r.hold_payment_draft_plan;
  const slimPayload = {
    ...harnessPayload,
    hold_payment_draft_plan: {
      plan_status: plan.plan_status,
      would_create_hold: plan.would_create_hold,
      would_create_payment_draft: plan.would_create_payment_draft,
      would_create_stripe_link: plan.would_create_stripe_link,
      payment_kind: plan.payment_kind,
      payment_amount_cents: plan.payment_amount_cents,
      balance_due_after_payment_cents: plan.balance_due_after_payment_cents,
      idempotency_key_preview: plan.idempotency_key_preview,
    },
    chain: {
      result: guestContext.result,
      availability: guestContext.availability,
      quote: guestContext.quote,
      payment_choice: r.payment_choice,
    },
  };
  const ctx2Payload = {
    ...slimPayload,
    guest_context: {
      message_lane: 'new_booking_inquiry',
      booking_intake_ready: true,
      readiness_state: 'ready_for_availability_check',
      extracted_fields: {
        check_in: '2026-07-10',
        check_out: '2026-07-17',
        guest_count: 2,
        package_interest: 'malibu',
      },
      result: guestContext.result,
      availability: guestContext.availability,
      quote: guestContext.quote,
      payment_choice: r.payment_choice,
    },
  };

  const slim = await post('/staff/bot/guest-simulator-create-hold-draft', slimPayload);
  const ctx2 = await post('/staff/bot/guest-simulator-create-hold-draft', ctx2Payload);

  console.log(JSON.stringify({
    harness_bytes: full.bytes,
    full_status: full.status,
    full_write_status: full.body && full.body.write_status,
    full_error: full.body && (full.body.error || full.body.write_block_reasons),
    slim_status: slim.status,
    slim_write_status: slim.body && slim.body.write_status,
    slim_error: slim.body,
    ctx2_status: ctx2.status,
    ctx2_write_status: ctx2.body && ctx2.body.write_status,
    ctx2_error: ctx2.body,
    ctx2_booking_code: ctx2.body && ctx2.body.booking_code,
    ctx2_payment_draft_id: ctx2.body && ctx2.body.payment_draft_id,
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
