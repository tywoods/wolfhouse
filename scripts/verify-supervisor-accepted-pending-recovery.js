'use strict';
// Offline Gap B regression: actual bind, claim and admission; no send/unpause.
const assert = require('node:assert/strict');
const { createMemorySupervisorStore, captureSupervisorEvent, bindLunaPausePermit,
  claimSupervisorIncident, admitSupervisorBusinessAction } = require('./lib/staff-supervisor-events');
(async () => {
  const user = { staff_user_id: 'supervisor-fixture', role: 'admin' };
  const env = { LUNA_SUPERVISOR_STAFF_USER_ID: user.staff_user_id };
  for (const reason of ['accepted_pending_unknown', 'acked_never_delivered']) {
    const store = createMemorySupervisorStore();
    const event = await captureSupervisorEvent(store, { source_key: `gap-b:${reason}`,
      client_id: 'fixture', conversation_id: 'fresh-chat', kind: 'silence', obligation: 'guest_message' });
    const pause = { id: 'pause-fixture', paused: true, owner: 'staff',
      paused_by: 'supervisor_watchdog', pause_reason: `needs_human:${reason}` };
    let writes = 0;
    const pg = { query: async (sql, params) => {
      assert.match(sql, /UPDATE bot_pause_states/);
      assert.doesNotMatch(sql, /SET paused|paused = FALSE/i);
      assert.equal(params[0], pause.id);
      pause.needs_human_transition_id = params[1];
      writes++;
      return { rowCount: 1 };
    } };
    assert.equal((await bindLunaPausePermit(pg, pause, 'transition-fixture')).ok, true,
      `${reason}: watchdog pause must bind its scoped permit`);
    assert.equal(writes, 1);
    const claim = await claimSupervisorIncident(store, { user, conversation_id: 'fresh-chat',
      event_id: event.row.id, pause_permit_transition_id: pause.needs_human_transition_id });
    assert.equal(claim.ok, true);
    assert.equal(claim.joined, false);
    const input = { user, env, action: 'send', conversation_id: 'fresh-chat',
      incident_id: claim.incident.id, lease_token: claim.incident.lease_token,
      step: 'reply', factsLoaded: true, lunaMode: 'auto', pause };
    assert.equal((await admitSupervisorBusinessAction(store, input)).ok, true);
    assert.equal(pause.paused, true);
    assert.equal((await admitSupervisorBusinessAction(store, { ...input, lease_token: 'wrong' })).ok, false);
    assert.equal((await admitSupervisorBusinessAction(store, { ...input,
      pause: { ...pause, needs_human_transition_id: 'other-transition' } })).error, 'stayed_out');
    const staffPause = { ...pause, paused_by: 'staff_portal', pause_reason: 'staff_manual_handoff' };
    assert.equal((await bindLunaPausePermit(pg, staffPause, 'transition-fixture')).ok, false);
    assert.equal(writes, 1);
    assert.equal((await admitSupervisorBusinessAction(store, { ...input, pause: staffPause })).error, 'stayed_out');
  }
  console.log('PASS GapB: scoped watchdog recovery admits fresh claim; staff pauses, transition and lease checks preserved');
})().catch(err => { console.error(err); process.exitCode = 1; });
