'use strict';
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');
const { quoteShortStayAccommodation } = require('./scripts/lib/wolfhouse-short-stay-pricing');
const { extractLunaGuestMessageIntake } = require('./scripts/lib/luna-guest-message-intake');

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
  const dates = extractLunaGuestMessageIntake({ message_text: 'July 1-5' }, { reference_date: '2026-06-10' });
  console.log('July 1-5 dates:', dates.check_in, dates.check_out);

  const staff = quoteShortStayAccommodation({
    client_slug: 'wolfhouse-somo', check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1,
  });
  console.log('Staff-style quote:', staff.success, '€' + (staff.total_cents / 100), staff.formula_summary);

  let ctx = {};
  for (const m of ['hi', 'book a stay', 'July 1-5', '1', 'no add nothing']) {
    const { o, next } = await turn(ctx, m);
    ctx = next;
    console.log(`\n=== "${m}" ===`);
    console.log('reply:', o.proposed_luna_reply);
    console.log('action:', o.proposed_next_action);
    console.log('rule:', o.result && o.result.package_night_rule);
    console.log('quote:', o.quote && o.quote.quote_status, o.quote && o.quote.quote_total_cents);
    console.log('pc_needed:', o.quote && o.quote.payment_choice_needed, o.payment_choice && o.payment_choice.payment_choice_ready);
  }
})();
