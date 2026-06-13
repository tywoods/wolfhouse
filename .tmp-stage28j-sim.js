'use strict';
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');

(async () => {
  const gateCtx = { public_guest_automation_enabled: true };
  let ctxState = null;
  async function turn(msg) {
    const out = await runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'dry_run',
      message_text: msg,
      guest_context: ctxState,
      automation_gate_context: gateCtx,
      reference_date: '2026-06-10',
    }, {});
    if (out.result) ctxState = { ...(ctxState || {}), ...out.result, result: out.result };
    return out;
  }
  let o;
  o = await turn('hi'); console.log('T1:', o.proposed_luna_reply.slice(0, 90));
  o = await turn('book a stay'); console.log('T2:', o.proposed_luna_reply.slice(0, 90));
  o = await turn('July 1-5'); console.log('T3:', o.proposed_luna_reply.slice(0, 90));
  o = await turn('1'); console.log('T4:', o.proposed_luna_reply.slice(0, 140));
  o = await turn('no add nothing');
  console.log('T5 reply:', o.proposed_luna_reply);
  console.log('T5 brain:', JSON.stringify(o.result.conversation_brain));
  console.log('T5 pkg:', o.result.extracted_fields.package_interest, '| handoff:', o.result.safe_handoff_required, '| action:', o.proposed_next_action);
  o = await turn("you told me they are not available. i'm only staying 5 days");
  console.log('T6 reply:', o.proposed_luna_reply);
  console.log('T6 brain:', JSON.stringify(o.result.conversation_brain));
  console.log('T6 handoff:', o.result.safe_handoff_required, '| action:', o.proposed_next_action, '| lane:', o.result.message_lane);
})().catch((e) => { console.error(e); process.exit(1); });
