'use strict';
require('dotenv').config({ path: require('path').join(__dirname, 'infra', '.env') });
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');
const { normalizeGuestContextForChain } = require('./scripts/lib/luna-guest-context-merge');

async function turn(ctx, msg, contactName) {
  const out = await runGuestAutomationOrchestratorDryRun({
    message_text: msg,
    client_slug: 'wolfhouse-somo',
    guest_context: ctx,
    reference_date: '2026-06-10',
    contact_name: contactName || undefined,
  });
  return { ctx: normalizeGuestContextForChain(out), out };
}

async function flow(name, turns, contactName) {
  let ctx = {};
  console.log('\n===', name, '===');
  for (const msg of turns) {
    const { ctx: nctx, out } = await turn(ctx, msg, contactName);
    ctx = nctx;
    console.log('>', msg);
    console.log('  quote:', out.quote?.quote_status, 'gc:', out.result?.extracted_fields?.guest_count);
    console.log('  stale:', out.result?.previous_quote_invalidated, out.result?.stale_quote_reason);
    console.log('  pc:', out.payment_choice?.payment_choice);
    console.log('  reply:', (out.proposed_luna_reply || '').slice(0, 120));
  }
}

(async () => {
  await flow('cash-en', ['July 1-5 for 1', 'no thanks, I have my own stuff', 'Can I pay cash?']);
  await flow('cash-en2', ["Hey we're 3, julyy 10-17, just the stay", 'cash payment ok?'], 'Emma');
  await flow('cash-it', ['1-5 luglio per 2', 'posso pagare in contanti?']);
  await flow('cash-de', ['1-5 Juli für 2', 'Kann ich bar bezahlen?']);
  await flow('it-corr', ['1-5 luglio per 1', 'no thanks, solo alloggio', 'in realtà siamo 3']);
  await flow('it-scusa', ['🏄 per 1, 10-17 luglio, solo il soggiorno', 'scusa siamo 1']);
})().catch((e) => { console.error(e); process.exit(1); });
