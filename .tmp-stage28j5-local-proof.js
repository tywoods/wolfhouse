'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const { withPgClient } = require('./scripts/lib/pg-connect');
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');
const { normalizeGuestContextForChain } = require('./scripts/lib/luna-guest-context-merge');
const { executeOpenDemoWhatsAppInbound } = require('./scripts/lib/open-demo-whatsapp-inbound-execute');
const {
  buildMetaOpenDemoWriteConfirmFlags,
} = require('./scripts/lib/meta-open-demo-inbound-adapter');
const {
  OPEN_DEMO_PAYMENT_CHOICE_DEFERRED_DRY_RUN_RE,
  buildOpenDemoPaymentChoiceLiveReply,
  shouldDeferOpenDemoPaymentChoiceReviewReply,
} = require('./scripts/lib/open-demo-whatsapp-gate');

const CLIENT = 'wolfhouse-somo';
const PHONE_ID = '1152900101233109';
const DEMO_PHONE = `+34600${String(Date.now()).slice(-8)}`;

const PLAYGROUND_ENV = {
  ...process.env,
  NODE_ENV: 'development',
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
  WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
};

function guestContextFromOrch(orchOut) {
  return normalizeGuestContextForChain({
    message_lane: orchOut.result && orchOut.result.message_lane,
    intake_state: orchOut.result && orchOut.result.intake_state,
    readiness_state: orchOut.result && orchOut.result.readiness_state,
    booking_intake_ready: orchOut.result && orchOut.result.booking_intake_ready,
    extracted_fields: orchOut.result && orchOut.result.extracted_fields,
    result: orchOut.result,
    availability: orchOut.availability,
    quote: orchOut.quote,
    payment_choice: orchOut.payment_choice,
    hold_payment_draft_plan: orchOut.hold_payment_draft_plan,
    detected_language: orchOut.result && orchOut.result.detected_language,
  });
}

async function buildShortStayDepositContext(pg) {
  const turns = ['hi', 'book a stay', 'July 1-5', '1', 'no add nothing'];
  let guestContext = null;
  let last = null;
  for (const msg of turns) {
    last = await runGuestAutomationOrchestratorDryRun({
      client_slug: CLIENT,
      message_text: msg,
      guest_phone: DEMO_PHONE,
      guest_context: guestContext,
      automation_gate_context: {
        public_guest_automation_enabled: true,
        whatsapp_dry_run: true,
        live_send_allowed: false,
        open_demo_whatsapp: true,
      },
    }, { pg, guest_phone: DEMO_PHONE });
    guestContext = guestContextFromOrch(last);
  }
  return { guestContext, orchBeforeDeposit: last };
}

async function main() {
  await withPgClient(async (pg) => {
    const { guestContext, orchBeforeDeposit } = await buildShortStayDepositContext(pg);

    const depositBody = {
      source: 'stage28j5_local_proof',
      client_slug: CLIENT,
      channel: 'whatsapp',
      phone_number_id: PHONE_ID,
      guest_phone: DEMO_PHONE,
      guest_name: 'Stage28j5 Proof',
      guest_email: `open-demo+${DEMO_PHONE.replace(/\D/g, '')}@example.test`,
      message_text: 'deposit',
      wamid: 'wamid.stage28j5.deposit',
      inbound_message_id: 'wamid.stage28j5.deposit',
      send_live_reply_confirmed: true,
      guest_context: guestContext,
    };

    const last = await executeOpenDemoWhatsAppInbound(pg, depositBody, PLAYGROUND_ENV, {
      actorId: 'stage28j5-local-proof',
      resolveWriteFlagsAfterReview: (review) => buildMetaOpenDemoWriteConfirmFlags(
        PLAYGROUND_ENV,
        review,
        depositBody,
      ),
    });

    const review = last.reviewOutcome.body.review || {};
    const bw = last.bookingWrite || {};
    const stripe = last.stripeLink || {};
    const pl = last.paymentLinkSend || {};
    const deferred = shouldDeferOpenDemoPaymentChoiceReviewReply(
      depositBody,
      PLAYGROUND_ENV,
      review,
      last.effectiveFlags,
    );
    const bridgeReply = deferred
      ? buildOpenDemoPaymentChoiceLiveReply(review, {
        bookingWrite: bw,
        stripeLink: stripe,
        paymentLinkSend: pl,
      })
      : null;
    const liveText = bridgeReply || review.proposed_luna_reply;

    const holdOk = bw.write_status === 'created' || bw.write_status === 'reused_existing';
    const pcReady = (review.payment_choice || {}).payment_choice_ready === true;

    const report = {
      result: holdOk && pcReady && !OPEN_DEMO_PAYMENT_CHOICE_DEFERRED_DRY_RUN_RE.test(String(liveText))
        ? 'PASS'
        : (pcReady ? 'PARTIAL' : 'FAIL'),
      note: 'Turns 1–5 via orchestrator with deterministic "no add nothing"; deposit via execute + write bridge',
      orch_before_deposit: {
        payment_choice_needed: orchBeforeDeposit.quote && orchBeforeDeposit.quote.payment_choice_needed,
        short_stay_addons_pending: orchBeforeDeposit.quote && orchBeforeDeposit.quote.short_stay_addons_pending,
        quote_status: orchBeforeDeposit.quote && orchBeforeDeposit.quote.quote_status,
        quote_total_cents: orchBeforeDeposit.quote && orchBeforeDeposit.quote.quote_total_cents,
      },
      review_reply_after_deposit: review.proposed_luna_reply,
      live_reply_after_deposit: liveText,
      forbidden_dry_run_in_live: OPEN_DEMO_PAYMENT_CHOICE_DEFERRED_DRY_RUN_RE.test(String(liveText)),
      booking_hold_created: holdOk,
      booking_code: bw.booking_code || null,
      payment_draft_id: bw.payment_draft_id || null,
      write_status: bw.write_status || null,
      payment_amount_cents: (review.hold_payment_draft_plan || {}).payment_amount_cents || null,
      stripe_test_checkout_created: !!(stripe && (stripe.stripe_link_created || stripe.stripe_link_reused)),
      whatsapp_payment_link_sent: !!(pl && pl.payment_link_sent),
      confirmation_sent: false,
      payment_choice_ready: pcReady,
      effective_flags: last.effectiveFlags,
      guest_phone: DEMO_PHONE,
    };

    console.log(JSON.stringify(report, null, 2));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
