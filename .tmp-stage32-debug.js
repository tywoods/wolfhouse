'use strict';
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');
const { composeLunaGuestReply } = require('./scripts/lib/luna-guest-reply-composer');
const { normalizeGuestContextForChain } = require('./scripts/lib/luna-guest-context-merge');

async function runTurn(message, prior) {
  const out = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo', channel: 'dry_run', message_text: message,
    guest_phone: '+491726422399', guest_context: prior || {}, reference_date: '2026-06-10',
  });
  const review = { result: out.result, availability: out.availability, quote: out.quote, payment_choice: out.payment_choice, hold_payment_draft_plan: out.hold_payment_draft_plan, proposed_luna_reply: out.proposed_luna_reply };
  const composed = composeLunaGuestReply({ payload: review, message_text: message, prior_guest_context: prior || {}, brain_decision: out.result && out.result.conversation_brain });
  return { out, reply: composed && composed.reply || out.proposed_luna_reply, ctx: normalizeGuestContextForChain({ result: out.result, availability: out.availability, quote: out.quote, payment_choice: out.payment_choice, extracted_fields: out.result.extracted_fields }) };
}

(async () => {
  let ctx = {};
  for (const m of ['hi', 'book a stay', 'July 6-10 for 1 guest', 'Marco']) { const r = await runTurn(m, ctx); ctx = r.ctx; }
  const b = await runTurn('Do you rent boards?', ctx);
  console.log('D6 reply:', b.reply);
  const w = await runTurn('wetsuit and lessons', ctx);
  console.log('D9 addons_requested', w.out.result.addons_requested, 'total', w.out.quote && w.out.quote.quote_total_cents, 'si', w.out.result.extracted_fields && w.out.result.extracted_fields.service_interest);
  let p = await runTurn('July 10-17 for 1 guest', {});
  p = await runTurn('Marco', p.ctx);
  p = await runTurn('Malibu', p.ctx);
  console.log('D12 reply', p.reply && p.reply.slice(0, 250));
  const t = await runTurn('I will send flight times later', p.ctx);
  console.log('D13 transfer', t.out.result.transfer_info_status, t.out.result.extracted_fields.transfer_info);
  let a = await runTurn('July 1-5 for 1', {});
  a = await runTurn('Marco', a.ctx);
  const tr = await runTurn('I land in Santander at 14:30', a.ctx);
  console.log('D15', tr.out.result.transfer_airport, tr.out.result.extracted_fields.transfer_info);
})();
