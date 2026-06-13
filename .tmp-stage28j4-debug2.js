'use strict';
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');

async function turn(ctx, msg) {
  const o = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo', channel: 'whatsapp', message_text: msg,
    guest_context: ctx, reference_date: '2026-06-10',
    automation_gate_context: { public_guest_automation_enabled: true },
  }, { dry_run: true, reference_date: '2026-06-10' });
  const next = o.result ? {
    ...ctx, ...o.result, result: o.result,
    quote: o.quote, availability: o.availability, payment_choice: o.payment_choice,
  } : ctx;
  return { o, next };
}

(async () => {
  let ctx = {};
  for (const m of ['hi', 'book a stay', 'July 1-5', '1', 'no add nothing']) {
    const { o, next } = await turn(ctx, m);
    ctx = next;
    if (m === 'no add nothing') {
      console.log(JSON.stringify({
        router: o.result && o.result.proposed_luna_reply,
        payment: o.payment_choice,
        quote_pc: o.quote && o.quote.payment_choice_needed,
        addons_pending: o.quote && o.quote.short_stay_addons_pending,
        brain: o.result && o.result.brain_decision,
      }, null, 2));
    }
  }
})();
