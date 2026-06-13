'use strict';
const { runGuestAutomationOrchestratorDryRun } = require('./scripts/lib/luna-guest-automation-orchestrator-dry-run');

const gateCtx = { public_guest_automation_enabled: true };

function makeSession() {
  let ctxState = null;
  return async function turn(msg) {
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
  };
}

(async () => {
  // C: 7-night → package explainer
  let turn = makeSession();
  await turn('hi'); await turn('book a stay'); await turn('July 10-17');
  let o = await turn('1');
  console.log('C reply:', o.proposed_luna_reply.slice(0, 160));
  console.log('C rule:', o.result.package_night_rule);

  // D: explain the packages during package choice
  o = await turn('explain the packages');
  console.log('D reply head:', o.proposed_luna_reply.slice(0, 120));
  console.log('D lane:', o.result.message_lane, '| preserved fields:', JSON.stringify(o.result.extracted_fields));
  console.log('D handoff:', o.result.safe_handoff_required, '| asks which pkg:', /which package|quale|cuál|welches|quel/i.test(o.proposed_luna_reply));

  // E: Malibu after explainer
  o = await turn('Malibu');
  console.log('E pkg:', o.result.extracted_fields.package_interest, '| action:', o.proposed_next_action, '| handoff(router):', o.result.safe_handoff_required);
  console.log('E reply:', o.proposed_luna_reply.slice(0, 140));

  // F: undecided (fresh session at package question)
  turn = makeSession();
  await turn('book a stay'); await turn('July 10-17'); await turn('1');
  o = await turn("I don't know which package");
  console.log('F reply head:', o.proposed_luna_reply.slice(0, 200));
  console.log('F brain:', o.result.conversation_brain.intent, '| handoff:', o.result.safe_handoff_required);
  console.log('F has waimea rec:', /waimea/i.test(o.proposed_luna_reply), '| beginner:', /beginner|lesson/i.test(o.proposed_luna_reply));

  // G: actually start over (after quote-ish state)
  o = await turn('actually start over');
  console.log('G reply:', o.proposed_luna_reply.slice(0, 140));
  console.log('G action:', o.proposed_next_action, '| reset:', o.result.new_booking_reset === true || o.result.conversation_brain.reset_context);

  // H: dates + just me in one message
  turn = makeSession();
  await turn('I want to book a stay');
  o = await turn('July 1st to 5th. just me');
  console.log('H fields:', JSON.stringify({ ci: o.result.extracted_fields.check_in, co: o.result.extracted_fields.check_out, gc: o.result.extracted_fields.guest_count }));
  console.log('H asks checkout:', /check-?out date/i.test(o.proposed_luna_reply), '| reply:', o.proposed_luna_reply.slice(0, 120));

  // J: what is Uluwatu? during active booking
  turn = makeSession();
  await turn('book a stay'); await turn('July 10-17');
  o = await turn('what is Uluwatu?');
  console.log('J reply head:', o.proposed_luna_reply.slice(0, 140));
  console.log('J handoff:', o.result.safe_handoff_required, '| preserved:', JSON.stringify(o.result.extracted_fields));
})().catch((e) => { console.error(e); process.exit(1); });
