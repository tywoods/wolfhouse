#!/usr/bin/env node
'use strict';

/**
 * Deckhand Lunabot lane — durable supervisor_events intake, catch-up,
 * dispatch, claim, admission. Kill switch off. Signing pluggable/off.
 * Never resends from an owed hint. Luna/ordinary staff get no new blocks.
 */
const assert = require('assert');
const {
  sourceKey,
  createMemorySupervisorStore,
  captureSupervisorEvent,
  catchUpSupervisorSources,
  dispatchDueEvents,
  createWebhookSender,
  isSupervisorEventsEnabled,
  isWebhookSigningEnabled,
  claimSupervisorIncident,
  renewSupervisorClaim,
  admitSupervisorBusinessAction,
  recordSupervisorLifecycle,
  recordSupervisorOutcome,
  evaluateSendWithSupervisorPermit,
  isSupervisorAccount,
  operationKey,
} = require('./lib/staff-supervisor-events');

const SUPERVISOR_ID = '11111111-1111-4111-8111-111111111111';
process.env.LUNA_SUPERVISOR_STAFF_USER_ID = SUPERVISOR_ID;

function fail(msg) {
  console.error('FAIL', msg);
  process.exit(1);
}

async function testSourceKeyRevisionDedupe() {
  const store = createMemorySupervisorStore();
  const key1 = sourceKey({
    environment: 'france-wolfhouse-staging',
    runtime: 'staff',
    kind: 'needs_human',
    rowId: 'trans-1',
    revision: '1',
  });
  const first = await captureSupervisorEvent(store, {
    source_key: key1,
    kind: 'needs_human',
    obligation: 'handoff',
    client_id: 'client-1',
    conversation_id: 'conv-1',
    reason: 'human_requested',
    booking_code: 'WH-1',
  });
  const dup = await captureSupervisorEvent(store, {
    source_key: key1,
    kind: 'needs_human',
    obligation: 'handoff',
    client_id: 'client-1',
    conversation_id: 'conv-1',
    reason: 'human_requested',
  });
  assert.strictEqual(first.inserted, true);
  assert.strictEqual(dup.inserted, false, 'same revision must not duplicate work');

  const key2 = sourceKey({
    environment: 'france-wolfhouse-staging',
    runtime: 'staff',
    kind: 'needs_human',
    rowId: 'trans-1',
    revision: '2',
  });
  const newer = await captureSupervisorEvent(store, {
    source_key: key2,
    kind: 'needs_human',
    obligation: 'handoff',
    client_id: 'client-1',
    conversation_id: 'conv-1',
    reason: 'whatsapp_send_failed:WH-2',
    booking_code: 'WH-2',
  });
  assert.strictEqual(newer.inserted, true, 'newer revision is a new occurrence');
  assert.strictEqual(store.events.length, 2);
}

async function testCatchUpCheckpointNotTimeAbandon() {
  const store = createMemorySupervisorStore();
  const rows = [];
  for (let i = 0; i < 3; i += 1) {
    rows.push({
      cursor: String(100 + i),
      source_key: sourceKey({
        environment: 'france-wolfhouse-staging',
        runtime: 'staff',
        kind: 'inbox_send_failed',
        rowId: `row-${i}`,
        revision: '1',
      }),
      kind: 'inbox_send_failed',
      obligation: 'confirmation',
      client_id: 'client-1',
      conversation_id: 'conv-1',
      created_at: new Date(Date.now() - (48 + i) * 3600 * 1000).toISOString(),
    });
  }
  let calls = 0;
  const adapter = {
    name: 'inbox_send_failed',
    async listSince(cursor, batchSize) {
      calls += 1;
      const start = cursor ? rows.findIndex((r) => r.cursor > cursor) : 0;
      const from = start < 0 ? rows.length : start;
      return rows.slice(from, from + batchSize);
    },
  };
  await catchUpSupervisorSources(store, [adapter], { batchSize: 2 });
  assert.strictEqual(store.events.length, 2);
  await catchUpSupervisorSources(store, [adapter], { batchSize: 2 });
  assert.strictEqual(store.events.length, 3, 'checkpoint resumes; 24h is not the recovery boundary');
  assert.ok(calls >= 2);
  assert.strictEqual(store.checkpoints.inbox_send_failed, '102');
}

async function testKillSwitchAndSigningOff() {
  assert.strictEqual(isSupervisorEventsEnabled({}), false);
  assert.strictEqual(isSupervisorEventsEnabled({ SUPERVISOR_EVENTS_ENABLED: 'true' }), false);
  assert.strictEqual(isSupervisorEventsEnabled({ SUPERVISOR_EVENTS_ENABLED: '1' }), true);
  assert.strictEqual(isWebhookSigningEnabled({}), false);
  assert.strictEqual(isWebhookSigningEnabled({ SUPERVISOR_WEBHOOK_SIGNING: '1' }), true);

  const store = createMemorySupervisorStore();
  await captureSupervisorEvent(store, {
    source_key: 'stg:staff:silence:m1:1',
    kind: 'silence',
    obligation: 'silence',
    client_id: 'c',
    conversation_id: 'conv',
  });
  let posts = 0;
  const sender = createWebhookSender({
    fetch: async () => {
      posts += 1;
      return { status: 200 };
    },
    signingEnabled: false,
  });
  const off = await dispatchDueEvents(store, sender, {
    enabled: false,
    now: new Date(),
    workerId: 'w1',
  });
  assert.strictEqual(off.skipped, 'disabled');
  assert.strictEqual(posts, 0);

  const unsigned = await dispatchDueEvents(store, sender, {
    enabled: true,
    now: new Date(),
    workerId: 'w1',
  });
  assert.strictEqual(unsigned.skipped, 'signing_unconfirmed');
  assert.strictEqual(posts, 0);
  assert.strictEqual(store.events[0].delivery_status, 'pending');
  assert.strictEqual(store.events[0].last_error, 'signing_unconfirmed');
}

async function testDispatchClaimRetrySameEventId() {
  const store = createMemorySupervisorStore();
  const ev = await captureSupervisorEvent(store, {
    source_key: 'stg:staff:send_failed:s1:1',
    kind: 'whatsapp_status_failed',
    obligation: 'confirmation',
    client_id: 'c',
    conversation_id: 'conv',
    booking_code: 'WH-9',
  });
  const seen = [];
  const sender = createWebhookSender({
    fetch: async (_url, init) => {
      seen.push(JSON.parse(init.body).event_id);
      if (seen.length === 1) return { status: 500 };
      return { status: 202 };
    },
    signingEnabled: true,
    sign: (body, secret) => ({ 'x-supervisor-signature': `t=1,v1=${secret || 'x'}` }),
    webhookUrl: 'http://127.0.0.1/supervisor',
    secret: 'not-a-real-secret',
  });
  await dispatchDueEvents(store, sender, { enabled: true, now: new Date(), workerId: 'w1' });
  store.events[0].delivery_status = 'dispatched';
  store.events[0].dispatch_worker_id = 'crashed';
  store.events[0].dispatch_lease_until = new Date(Date.now() - 1000).toISOString();
  store.events[0].next_retry_at = null;
  await dispatchDueEvents(store, sender, { enabled: true, now: new Date(), workerId: 'w2' });
  assert.deepStrictEqual(seen, [ev.row.id, ev.row.id], 'retry uses the same event id');
  assert.strictEqual(store.events[0].delivery_status, 'acked');
}

async function testRecursiveCauseNeverWakes() {
  const store = createMemorySupervisorStore();
  await captureSupervisorEvent(store, {
    source_key: 'stg:staff:send_failed:sup1:1',
    kind: 'supervisor_send_failed',
    obligation: 'confirmation',
    client_id: 'c',
    conversation_id: 'conv',
    cause_incident_id: 'inc-1',
    reason: 'supervisor send failed',
  });
  let posts = 0;
  const sender = createWebhookSender({
    fetch: async () => {
      posts += 1;
      return { status: 200 };
    },
    signingEnabled: true,
    sign: () => ({ sig: '1' }),
    webhookUrl: 'http://127.0.0.1/supervisor',
    secret: 'x',
  });
  const out = await dispatchDueEvents(store, sender, { enabled: true, now: new Date(), workerId: 'w1' });
  assert.strictEqual(posts, 0);
  assert.strictEqual(store.events[0].delivery_status, 'suppressed_recursive');
  assert.ok(out.suppressed >= 1);
}

async function testClaimAndAdmission() {
  const store = createMemorySupervisorStore();
  const captured = await captureSupervisorEvent(store, {
    source_key: 'stg:staff:needs_human:t1:1',
    kind: 'needs_human',
    obligation: 'handoff',
    client_id: 'c',
    conversation_id: 'conv-1',
    reason: 'human_requested',
    booking_code: 'WH-1',
    metadata: { needs_human_transition_id: 't1' },
  });
  const supervisor = { staff_user_id: SUPERVISOR_ID, role: 'admin', client_id: 'c', client_slug: 'wolfhouse' };
  const staff = { staff_user_id: 'human-1', role: 'operator', client_id: 'c' };
  assert.strictEqual(isSupervisorAccount(staff), false);
  assert.strictEqual(isSupervisorAccount(supervisor), true);

  const staffAdmit = await admitSupervisorBusinessAction(store, {
    user: staff,
    action: 'send',
    conversation_id: 'conv-1',
  });
  assert.strictEqual(staffAdmit.ok, true);
  assert.strictEqual(staffAdmit.skipped, 'not_supervisor');

  const claimed = await claimSupervisorIncident(store, {
    user: supervisor,
    conversation_id: 'conv-1',
    event_id: captured.row.id,
    after_message_id: 'msg-1',
    now: new Date(),
  });
  assert.strictEqual(claimed.ok, true);
  assert.ok(claimed.incident.lease_token);
  assert.strictEqual(claimed.incident.pause_permit_transition_id, 't1');

  const second = await claimSupervisorIncident(store, {
    user: supervisor,
    conversation_id: 'conv-1',
    event_id: captured.row.id,
    after_message_id: 'msg-1',
    now: new Date(),
  });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.joined, true, 'second wake joins, does not double-claim');

  const expiredNow = new Date(Date.now() + 4 * 60 * 1000);
  const expired = await admitSupervisorBusinessAction(store, {
    user: supervisor,
    action: 'send',
    conversation_id: 'conv-1',
    incident_id: claimed.incident.id,
    lease_token: claimed.incident.lease_token,
    step: 'send-1',
    now: expiredNow,
    halt: false,
    factsLoaded: true,
    pause: { paused: false },
    lunaMode: 'auto',
    lastStaffReplyAt: null,
  });
  assert.strictEqual(expired.ok, false);
  assert.strictEqual(expired.error, 'claim_expired');

  await renewSupervisorClaim(store, {
    incident_id: claimed.incident.id,
    lease_token: claimed.incident.lease_token,
    now: new Date(),
  });
  const halted = await admitSupervisorBusinessAction(store, {
    user: supervisor,
    action: 'send',
    conversation_id: 'conv-1',
    incident_id: claimed.incident.id,
    lease_token: claimed.incident.lease_token,
    step: 'send-1',
    now: new Date(),
    halt: true,
    factsLoaded: true,
  });
  assert.strictEqual(halted.ok, false);
  assert.strictEqual(halted.error, 'supervisor_halted');

  const life = await recordSupervisorLifecycle(store, {
    event_id: captured.row.id,
    kind: 'stopped_halted',
    halted: true,
    expired: true,
  });
  assert.strictEqual(life.ok, true, 'lifecycle reports accepted even when halted/expired');

  assert.strictEqual(isSupervisorAccount({ account_kind: 'supervisor', role: 'admin' }), false);
  const missingLease = await admitSupervisorBusinessAction(store, {
    user: supervisor,
    action: 'send',
    conversation_id: 'conv-1',
    incident_id: claimed.incident.id,
    factsLoaded: true,
    pause: { paused: false },
    lunaMode: 'auto',
    now: new Date(),
  });
  assert.strictEqual(missingLease.ok, false);
  assert.strictEqual(missingLease.error, 'claim_expired');

  store.incidents[0].lease_until = new Date(Date.now() - 1000).toISOString();
  const afterExpiry = await claimSupervisorIncident(store, {
    user: supervisor,
    conversation_id: 'conv-1',
    event_id: captured.row.id,
    now: new Date(),
  });
  assert.strictEqual(afterExpiry.joined, false);
  assert.strictEqual(store.incidents[0].status, 'expired');
  assert.strictEqual(afterExpiry.incident.status, 'open');

  await recordSupervisorOutcome(store, { event_id: captured.row.id, outcome: 'sent' });
  assert.strictEqual(store.incidents[1].status, 'closed');
}

async function testStayOutAndNoOwedResend() {
  const store = createMemorySupervisorStore();
  const captured = await captureSupervisorEvent(store, {
    source_key: 'stg:staff:owed_hint:b1:1',
    kind: 'confirmation_possibly_owed',
    obligation: 'confirmation',
    client_id: 'c',
    conversation_id: 'conv-1',
    booking_code: 'WH-1',
    metadata: { owed_hint: true },
  });
  assert.strictEqual(captured.row.metadata.owed_hint, true);
  assert.notStrictEqual(captured.row.kind, 'resend');

  const supervisor = { staff_user_id: SUPERVISOR_ID, role: 'admin' };
  await claimSupervisorIncident(store, {
    user: supervisor,
    conversation_id: 'conv-1',
    event_id: captured.row.id,
    after_message_id: 'm1',
    now: new Date(),
  });
  const paused = await admitSupervisorBusinessAction(store, {
    user: supervisor,
    action: 'send',
    conversation_id: 'conv-1',
    incident_id: store.incidents[0].id,
    lease_token: store.incidents[0].lease_token,
    step: 'send-1',
    now: new Date(),
    pause: { paused: true, owner: 'staff' },
    lunaMode: 'auto',
    lastStaffReplyAt: null,
    factsLoaded: true,
  });
  assert.strictEqual(paused.ok, false);
  assert.strictEqual(paused.error, 'stayed_out');

  const draft = await admitSupervisorBusinessAction(store, {
    user: supervisor,
    action: 'send',
    conversation_id: 'conv-1',
    incident_id: store.incidents[0].id,
    lease_token: store.incidents[0].lease_token,
    step: 'send-1',
    now: new Date(),
    pause: { paused: false },
    lunaMode: 'draft',
    factsLoaded: true,
  });
  assert.strictEqual(draft.ok, false);
  assert.strictEqual(draft.error, 'stayed_out');
}

async function testPausePermitAndOpKey() {
  assert.strictEqual(operationKey('inc-9', 'send-1'), 'supervisor:inc-9:send-1');
  const store = createMemorySupervisorStore();
  await captureSupervisorEvent(store, {
    source_key: 'stg:staff:needs_human:t9:1',
    kind: 'needs_human',
    obligation: 'handoff',
    client_id: 'c',
    conversation_id: 'conv-9',
    metadata: { needs_human_transition_id: 't9' },
  });
  const supervisor = { staff_user_id: SUPERVISOR_ID, role: 'admin' };
  const claimed = await claimSupervisorIncident(store, {
    user: supervisor,
    conversation_id: 'conv-9',
    event_id: store.events[0].id,
    now: new Date(),
  });
  let usedNoPause = false;
  const withPause = async () => ({ result: { blocked_reasons: ['gate_bot_paused'] } });
  const noPause = async () => {
    usedNoPause = true;
    return { result: { send_performed: true, whatsapp_message_id: 'wamid.1' } };
  };
  const out = await evaluateSendWithSupervisorPermit(
    { client_slug: 'wolfhouse-somo', to: '+34600000001' },
    {
      user: supervisor,
      store,
      incident_id: claimed.incident.id,
      lease_token: claimed.incident.lease_token,
      pause: { paused: true, owner: 'luna', needs_human_transition_id: 't9' },
    },
    withPause,
    noPause,
  );
  assert.strictEqual(usedNoPause, true);
  assert.strictEqual(out.result.send_performed, true);

  const staffPause = await evaluateSendWithSupervisorPermit(
    { client_slug: 'wolfhouse-somo', to: '+34600000001' },
    {
      user: supervisor,
      store,
      incident_id: claimed.incident.id,
      lease_token: claimed.incident.lease_token,
      pause: { paused: true, owner: 'staff', needs_human_transition_id: 't9' },
    },
    withPause,
    noPause,
  );
  assert.deepStrictEqual(staffPause.result.blocked_reasons, ['gate_bot_paused']);
}

async function testOutcomeAndStaleOnReenable() {
  const store = createMemorySupervisorStore();
  const captured = await captureSupervisorEvent(store, {
    source_key: 'stg:staff:silence:old:1',
    kind: 'silence',
    obligation: 'silence',
    client_id: 'c',
    conversation_id: 'conv',
  });
  await recordSupervisorOutcome(store, {
    event_id: captured.row.id,
    outcome: 'resolved_by_luna',
  });
  assert.strictEqual(store.events[0].outcome, 'resolved_by_luna');
  const closed = await catchUpSupervisorSources(store, [], { reenable: true, now: new Date() });
  assert.ok(closed.stale === 0 || store.events[0].outcome === 'resolved_by_luna');
}

async function testSeadogAuditWiringDrops501() {
  const {
    createStaffSupervisorRoutes,
  } = require('./lib/staff-supervisor-routes');
  const audit = require('./lib/luna-supervisor-audit');
  assert.ok(audit.BUSINESS_ACTIONS.has('guest_message_send'));
  assert.ok(audit.LIFECYCLE_STATES.has('stopped_halted'));

  const SUPERVISOR_ID = '11111111-1111-4111-8111-111111111111';
  const CONV_ID = '33333333-3333-4333-8333-333333333333';
  const EVENT_ID = '55555555-5555-4555-8555-555555555555';
  const INCIDENT_ID = '22222222-2222-4222-8222-222222222222';
  const entries = [];
  const replies = [];
  const sendJSON = (_res, status, body) => {
    replies.push({ status, body });
    return { status, body };
  };
  const routes = createStaffSupervisorRoutes({
    sendJSON,
    withPgClient: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    appendAuditLog: (entry) => entries.push(entry),
    supervisorStaffUserId: SUPERVISOR_ID,
  });
  const user = {
    staff_user_id: SUPERVISOR_ID,
    role: 'admin',
    client_slug: 'wolfhouse',
    account_kind: 'supervisor',
  };

  await routes.handleAudit(null, {}, user, {
    kind: 'business',
    action: 'guest_message_send',
    incidentId: INCIDENT_ID,
    conversationId: CONV_ID,
    bookingRef: 'WH-42',
  });
  assert.notStrictEqual(replies[0] && replies[0].status, 501, 'audit route must not 501');
  assert.strictEqual(replies[0].status, 200);
  assert.strictEqual(entries[0].category, 'luna_supervisor');
  assert.strictEqual(entries[0].intent, 'action:supervisor:guest_message_send');
  assert.strictEqual(entries[0].booking_ref, 'WH-42');
  assert.strictEqual(Object.hasOwn(entries[0], 'guest_text'), false);

  replies.length = 0;
  await routes.handleAudit(null, {}, user, {
    kind: 'lifecycle',
    lifecycle: 'stopped_halted',
    eventId: EVENT_ID,
    incidentId: INCIDENT_ID,
    conversationId: CONV_ID,
  });
  assert.strictEqual(replies[0].status, 200);
  assert.strictEqual(entries[1].category, 'luna_supervisor_lifecycle');
  assert.strictEqual(entries[1].intent, 'lifecycle:supervisor:stopped_halted');

  replies.length = 0;
  await routes.handleAudit(null, {}, user, { kind: 'business', action: 'free_form' });
  assert.strictEqual(replies[0].status, 400);
  assert.strictEqual(replies[0].body.error, 'supervisor_business_action_invalid');

  const src = require('fs').readFileSync(require('path').join(__dirname, 'lib/staff-supervisor-routes.js'), 'utf8');
  assert.doesNotMatch(src, /501/);
  assert.doesNotMatch(src, /audit_helper_unwired/);
}

async function main() {
  await testSourceKeyRevisionDedupe();
  await testCatchUpCheckpointNotTimeAbandon();
  await testKillSwitchAndSigningOff();
  await testDispatchClaimRetrySameEventId();
  await testRecursiveCauseNeverWakes();
  await testClaimAndAdmission();
  await testStayOutAndNoOwedResend();
  await testPausePermitAndOpKey();
  await testOutcomeAndStaleOnReenable();
  await testSeadogAuditWiringDrops501();
  console.log('ok supervisor events intake/dispatch/claim');
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
});
