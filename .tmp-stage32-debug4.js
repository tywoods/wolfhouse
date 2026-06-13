'use strict';
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');
const { normalizeGuestContextForChain } = require('./scripts/lib/luna-guest-context-merge');

(async () => {
  let ctx = {};
  for (const m of ['July 1-5 for 1 guest', 'Marco']) {
    const out = await runGuestAutomationOrchestratorDryRun({ client_slug: 'wolfhouse-somo', channel: 'dry_run', message_text: m, guest_phone: '+491726422399', guest_context: ctx, reference_date: '2026-06-10' });
    ctx = normalizeGuestContextForChain({ result: out.result, availability: out.availability, quote: out.quote, payment_choice: out.payment_choice, extracted_fields: out.result.extracted_fields });
    console.log(m, out.quote && out.quote.quote_status);
  }
  const out = await runGuestAutomationOrchestratorDryRun({ client_slug: 'wolfhouse-somo', channel: 'dry_run', message_text: 'I land in Santander at 14:30', guest_phone: '+491726422399', guest_context: ctx, reference_date: '2026-06-10' });
  console.log('transfer fields', out.result.extracted_fields && out.result.extracted_fields.transfer_info);
  console.log('obs', out.result.transfer_airport, out.result.transfer_info_status);
})();
