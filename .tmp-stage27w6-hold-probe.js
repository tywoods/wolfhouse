'use strict';
const https = require('https');
const { execSync } = require('child_process');
const { runLunaGuestMessageRouterDryRun } = require('./scripts/lib/luna-guest-message-router');
const { runGuestQuoteProposalDryRun } = require('./scripts/lib/luna-guest-quote-proposal-dry-run');
const { runGuestPaymentChoiceDryRun } = require('./scripts/lib/luna-guest-payment-choice-dry-run');
const { runGuestHoldPaymentDraftPlannerDryRun } = require('./scripts/lib/luna-guest-hold-payment-draft-planner');
const { buildHoldPaymentDraftPlannerChain } = require('./scripts/lib/luna-guest-context-merge');

const HOST = 'staff-staging.lunafrontdesk.com';
const token = process.env.TOKEN || execSync(
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
        let body = null;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ status: res.statusCode, body, raw });
      });
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

const av = { availability_check_attempted: true, availability_status: 'available' };
const result = runLunaGuestMessageRouterDryRun(
  { message_text: "Hi, we're 2 people looking to stay from July 10 to July 17, interested in the Malibu package" },
  { reference_date: '2026-06-08' },
);
const quote = runGuestQuoteProposalDryRun(result, av, {});
const payment_choice = runGuestPaymentChoiceDryRun(
  { message_text: 'Deposit is fine' },
  { message_lane: result.message_lane, quote, payment_choice_needed: quote.payment_choice_needed },
);
const guestContext = {
  message_lane: result.message_lane,
  booking_intake_ready: result.booking_intake_ready,
  readiness_state: result.readiness_state,
  extracted_fields: result.extracted_fields,
  result,
  availability: av,
  quote,
  payment_choice,
};
const chain = buildHoldPaymentDraftPlannerChain(guestContext, {
  result,
  payment_choice,
  availability: av,
  quote,
});
const planner = runGuestHoldPaymentDraftPlannerDryRun(chain, {});

(async () => {
  const slimPlanner = {
    plan_status: planner.plan_status,
    would_create_hold: planner.would_create_hold,
    would_create_payment_draft: planner.would_create_payment_draft,
    would_create_stripe_link: planner.would_create_stripe_link,
    payment_kind: planner.payment_kind,
    payment_amount_cents: planner.payment_amount_cents,
    balance_due_after_payment_cents: planner.balance_due_after_payment_cents,
    idempotency_key_preview: planner.idempotency_key_preview,
  };
  const hold = await post('/staff/bot/guest-simulator-create-hold-draft', {
    source: 'luna_guest_simulator',
    confirm_simulator_write: true,
    confirm_write: true,
    client_slug: 'wolfhouse-somo',
    guest_name: 'Staging Test Guest',
    guest_email: 'staging-test@wolfhouse.test',
    guest_phone: '+34600999997',
    guest_context: guestContext,
    hold_payment_draft_plan: slimPlanner,
    chain: {
      result: chain.result,
      availability: chain.availability,
      quote: chain.quote,
      payment_choice: chain.payment_choice,
    },
  });
  console.log(JSON.stringify({
    planner_status: planner.plan_status,
    hold_status: hold.status,
    success: hold.body && hold.body.success,
    write_status: hold.body && hold.body.write_status,
    write_block_reasons: hold.body && hold.body.write_block_reasons,
    booking_id: hold.body && hold.body.booking_id,
    booking_code: hold.body && hold.body.booking_code,
    payment_draft_id: hold.body && hold.body.payment_draft_id,
    next_safe_step: hold.body && hold.body.next_safe_step,
    stripe_link_created: hold.body && hold.body.stripe_link_created,
    sends_whatsapp: hold.body && hold.body.sends_whatsapp,
    live_send_blocked: hold.body && hold.body.live_send_blocked,
    error: hold.body && hold.body.error,
  }, null, 2));
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
