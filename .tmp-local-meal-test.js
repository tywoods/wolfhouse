'use strict';
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');

const priorCtx = {
  booking_id: '30fe5e93-36df-4c3a-a879-4f69d2ac1635',
  booking_code: 'WH-G27-366C4FD9A2',
  active_thread: 'post_booking',
  detected_language: 'en',
  contact_name: 'Ty',
  client_slug: 'wolfhouse-somo',
  hold_created: true,
  payment_received: true,
  payment_link_sent: true,
  stripe_link_created: true,
  confirmation_sent: true,
  result: {
    message_lane: 'new_booking_inquiry',
    booking_intake_ready: true,
    extracted_fields: { check_in: '2026-08-10', check_out: '2026-08-15', guest_count: 2 },
  },
  quote: {
    quote_status: 'ready',
    total_amount_cents: 50000,
    deposit_amount_cents: 15000,
    payment_choice_needed: false,
  },
};

(async () => {
  const out = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    guest_phone: '+491726422307',
    message_text: 'i would like to add a meal to my booking',
    guest_context: priorCtx,
    reference_date: '2026-06-12',
  }, {
    dry_run: true,
    guest_phone: '+491726422307',
    // No pg — skip DB operations
  });

  const r = out.result || {};
  console.log('meals_status:', r.meals_status);
  console.log('meals_request:', JSON.stringify(r.extracted_fields && r.extracted_fields.meals_request));
  const plan = r.guest_gpt_write_tool_planner;
  console.log('planner_rationale:', plan && plan.gpt_write_tool_planner_rationale);
  console.log('planned_tools:', plan && (plan.gpt_write_tool_planner_planned_tools || []).join(','));
  console.log('context_chain.booking_id:', out.guest_context_chain && out.guest_context_chain.booking_id);
  console.log('message_lane:', r.message_lane);
  console.log('--- REPLY ---');
  console.log(out.proposed_luna_reply);
})().catch(console.error);
