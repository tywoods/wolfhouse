'use strict';
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');

async function turn(ctx, msg) {
  return runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo', channel: 'whatsapp', message_text: msg,
    guest_context: ctx, reference_date: '2026-06-10',
    automation_gate_context: { public_guest_automation_enabled: true },
  }, { dry_run: true, reference_date: '2026-06-10' });
}

(async () => {
  let ctx = {};
  for (const m of ['book a stay', 'July 1-5', '1']) {
    const o = await turn(ctx, m);
    ctx = o.result ? { ...ctx, ...o.result, result: o.result, quote: o.quote, availability: o.availability } : ctx;
    console.log(JSON.stringify({
      m,
      lane: o.result && o.result.message_lane,
      ready: o.result && o.result.booking_intake_ready,
      readiness: o.result && o.result.readiness_state,
      handoff: o.result && o.result.safe_handoff_required,
      reasons: o.result && o.result.handoff_reasons,
      missing: o.result && o.result.missing_required_fields,
      fields: o.result && o.result.extracted_fields,
      rule: o.result && o.result.package_night_rule,
      avail: o.availability && { attempted: o.availability.availability_check_attempted, status: o.availability.availability_status, handoff: o.availability.availability_handoff_required },
      quote: o.quote && { status: o.quote.quote_status, attempted: o.quote.quote_proposal_attempted },
      action: o.proposed_next_action,
    }, null, 2));
  }
})();
