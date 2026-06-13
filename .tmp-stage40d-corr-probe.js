'use strict';
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');
const { normalizeGuestContextForChain } = require('./scripts/lib/luna-guest-context-merge');
const { detectFieldCorrectionIntent } = require('./scripts/lib/luna-booking-state-transitions');
const { extractGuestCountFromText } = require('./scripts/lib/luna-booking-intake-policy');

const msgs = ['scusa siamo 1', 'in realtà siamo 3', 'siamo in 3 invece', 'no aspetta siamo 2', 'siamo 2 non 1', 'siamo in due', 'alla fine siamo 2'];
for (const m of msgs) {
  console.log(m, 'corr:', detectFieldCorrectionIntent(m), 'gc:', extractGuestCountFromText(m));
}

async function readyCtx(t1) {
  let ctx = {};
  let o = await runGuestAutomationOrchestratorDryRun({
    message_text: t1, client_slug: 'wolfhouse-somo', guest_context: ctx, reference_date: '2026-06-10', contact_name: 'Luca',
  });
  ctx = normalizeGuestContextForChain(o);
  if (o.quote?.quote_status !== 'ready') {
    o = await runGuestAutomationOrchestratorDryRun({
      message_text: 'no thanks, solo alloggio', client_slug: 'wolfhouse-somo', guest_context: ctx, reference_date: '2026-06-10',
    });
    ctx = normalizeGuestContextForChain(o);
  }
  return ctx;
}

(async () => {
  for (const t2 of msgs) {
    const ctx = await readyCtx('10-17 luglio per 1');
    const o = await runGuestAutomationOrchestratorDryRun({
      message_text: t2, client_slug: 'wolfhouse-somo', guest_context: ctx, reference_date: '2026-06-10',
    });
    console.log('->', t2, 'stale', o.result?.previous_quote_invalidated, o.result?.stale_quote_reason,
      'gc', o.result?.extracted_fields?.guest_count, 'quote', o.quote?.quote_status);
  }
})();
