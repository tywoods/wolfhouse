'use strict';
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');
const { normalizeGuestContextForChain } = require('./scripts/lib/luna-guest-context-merge');

(async () => {
  let ctx = {};
  for (const m of ['hi', 'book a stay', 'July 6-10 for 1 guest', 'Marco']) {
    const out = await runGuestAutomationOrchestratorDryRun({ client_slug: 'wolfhouse-somo', channel: 'dry_run', message_text: m, guest_phone: '+491726422399', guest_context: ctx, reference_date: '2026-06-10' });
    ctx = normalizeGuestContextForChain({ result: out.result, availability: out.availability, quote: out.quote, payment_choice: out.payment_choice, extracted_fields: out.result.extracted_fields });
  }
  const out = await runGuestAutomationOrchestratorDryRun({ client_slug: 'wolfhouse-somo', channel: 'dry_run', message_text: 'wetsuit and lessons', guest_phone: '+491726422399', guest_context: ctx, reference_date: '2026-06-10' });
  console.log('lane', out.result.message_lane);
  console.log('fields', out.result.extracted_fields);
  console.log('quote', out.quote && out.quote.quote_status, out.quote && out.quote.quote_total_cents);
  console.log('addons', out.result.addons_requested);
})();
