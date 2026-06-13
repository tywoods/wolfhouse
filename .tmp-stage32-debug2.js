'use strict';
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');
const { normalizeGuestContextForChain } = require('./scripts/lib/luna-guest-context-merge');
const { quoteAwaitingAddonsDecision } = require('./scripts/lib/luna-booking-addons-policy');

(async () => {
  let ctx = {};
  for (const m of ['hi', 'book a stay', 'July 6-10 for 1 guest', 'Marco']) {
    const out = await runGuestAutomationOrchestratorDryRun({ client_slug: 'wolfhouse-somo', channel: 'dry_run', message_text: m, guest_phone: '+491726422399', guest_context: ctx, reference_date: '2026-06-10' });
    ctx = normalizeGuestContextForChain({ result: out.result, availability: out.availability, quote: out.quote, payment_choice: out.payment_choice, extracted_fields: out.result.extracted_fields });
    console.log(m, 'quote pending', quoteAwaitingAddonsDecision(out.quote), out.quote && out.quote.quote_status);
  }
  const out = await runGuestAutomationOrchestratorDryRun({ client_slug: 'wolfhouse-somo', channel: 'dry_run', message_text: 'Do you rent boards?', guest_phone: '+491726422399', guest_context: ctx, reference_date: '2026-06-10' });
  console.log('board lane', out.result.message_lane);
  console.log('board quote pending', quoteAwaitingAddonsDecision(out.quote), out.quote);
  console.log('prior ctx quote pending', quoteAwaitingAddonsDecision(ctx.quote));
})();
