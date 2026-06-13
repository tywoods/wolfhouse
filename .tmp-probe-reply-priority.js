'use strict';
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');

(async () => {
  const guest_context = {
    message_lane: 'new_booking_inquiry',
    booking_intake_ready: false,
    readiness_state: 'collecting_required_details',
    extracted_fields: { guest_count: 2, package_interest: 'malibu' },
    quote: { quote_status: 'not_ready', payment_choice_needed: false },
    result: {
      message_lane: 'new_booking_inquiry',
      booking_intake_ready: false,
      readiness_state: 'collecting_required_details',
      proposed_luna_reply: "Hi! I'm Luna from Wolfhouse 🌊 — What dates would you like to stay?",
      missing_required_fields: ['check_in', 'check_out'],
    },
  };
  const o = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    message_text: 'Deposit is fine',
    dry_run: true,
    reference_date: '2026-06-08',
    guest_context,
    automation_gate_context: { public_guest_automation_enabled: false, whatsapp_dry_run: true },
  }, {});
  console.log(JSON.stringify({
    lane: o.result && o.result.message_lane,
    ready: o.result && o.result.booking_intake_ready,
    quote: o.quote && o.quote.quote_status,
    pc_attempt: o.payment_choice && o.payment_choice.payment_choice_capture_attempted,
    pc_detected: o.payment_choice && o.payment_choice.payment_choice_detected,
    pc_reply: o.payment_choice && o.payment_choice.proposed_luna_reply,
    result_reply: o.result && o.result.proposed_luna_reply,
    top: o.proposed_luna_reply,
  }, null, 2));
})();
