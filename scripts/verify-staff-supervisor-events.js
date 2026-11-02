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
  runSupervisorStaffTick,
  startSupervisorEventsLoop,
  reconcileSupervisorDeliveries,
  persistSupervisorNeedsHuman,
  annotateSupervisorCauseAfterHandoff,
  resolveSupervisorWriteTarget,
  bindCompleteDispatchParams,
  shouldEmitSupervisorSendAudit,
  classifyPauseOwner,
  stayOutReason,
  shouldRecordSupervisorCompletion,
  supervisorAuditIdentity,
  normalizeSupervisorCompletionReceipt,
  projectSupervisorAudit,
  buildSupervisorAuditRetryEvent,
  retainFailedSupervisorAudit,
  replaySupervisorAuditRetries,
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
  assert.strictEqual(store.events.length, 3, 'catch-up continues past the first batch');
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

  store.events[0].delivery_status = 'acked';
  store.events[0].acked_at = new Date().toISOString();
  store.events[0].metadata = { guest_delivered: true };
  await recordSupervisorOutcome(store, {
    event_id: captured.row.id,
    conversation_id: 'conv-1',
    incident_id: afterExpiry.incident.id,
    lease_token: afterExpiry.incident.lease_token,
    user: supervisor,
    outcome: 'sent',
    resolved: true,
  });
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
  let usedWithPause = false;
  const withPause = async () => {
    usedWithPause = true;
    return { result: { blocked_reasons: ['gate_bot_paused'] } };
  };
  const noPause = async () => {
    usedNoPause = true;
    return { result: { send_performed: true, whatsapp_message_id: 'wamid.1' } };
  };
  const out = await evaluateSendWithSupervisorPermit(
    { client_slug: 'wolfhouse-somo', to: '+346****0001' },
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
  assert.strictEqual(usedNoPause, false, 'never skip the send-route pause check');
  assert.strictEqual(usedWithPause, true);
  assert.deepStrictEqual(out.result.blocked_reasons, ['gate_bot_paused']);

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
  await store.updateEvent(captured.row.id, { outcome: 'resolved_by_luna' });
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
  assert.strictEqual(replies[0].status, 409);
  assert.strictEqual(replies[0].body.error, 'emit_from_completion_path');
  assert.strictEqual(entries.length, 0, 'business audit is not a caller claim');

  replies.length = 0;
  await routes.handleAudit(null, {}, user, {
    kind: 'lifecycle',
    lifecycle: 'stopped_halted',
    eventId: EVENT_ID,
    incidentId: INCIDENT_ID,
    conversationId: CONV_ID,
  });
  assert.strictEqual(replies[0].status, 409);
  assert.strictEqual(replies[0].body.error, 'emit_from_lifecycle_path');
  assert.strictEqual(entries.length, 0, 'lifecycle audit is not an unbound caller claim');

  replies.length = 0;
  await routes.handleAudit(null, {}, user, { kind: 'business', action: 'free_form' });
  assert.strictEqual(replies[0].status, 409);
  assert.strictEqual(replies[0].body.error, 'emit_from_completion_path');

  const sinkReplies = [];
  const sinkRoutes = createStaffSupervisorRoutes({
    sendJSON: (_res, status, body) => sinkReplies.push({ status, body }),
    withPgClient: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    appendAuditLog: () => ({ ok: false, error: 'EACCES' }),
    supervisorStaffUserId: SUPERVISOR_ID,
  });
  await sinkRoutes.handleAudit(null, {}, user, {
    kind: 'lifecycle',
    lifecycle: 'stopped_halted',
    eventId: EVENT_ID,
  });
  assert.strictEqual(sinkReplies[0].status, 409);

  const src = require('fs').readFileSync(require('path').join(__dirname, 'lib/staff-supervisor-routes.js'), 'utf8');
  assert.doesNotMatch(src, /501/);
  assert.doesNotMatch(src, /audit_helper_unwired/);
}

async function testStaffTickCatchUpDispatchAndWatchdog() {
  const store = createMemorySupervisorStore();
  const adapter = {
    name: 'silence',
    async listSince() {
      return [{
        source_key: 'stg:staff:silence:tick1:1',
        kind: 'silence',
        obligation: 'silence',
        conversation_id: 'conv-tick',
        booking_code: 'WH-77',
        cursor: 'c1',
      }];
    },
  };
  const needsHuman = [];
  const sender = createWebhookSender({
    fetch: async () => ({ status: 500 }),
    signingEnabled: true,
    sign: () => ({ 'x-supervisor-signature': 'v1=x' }),
    webhookUrl: 'http://127.0.0.1/supervisor',
    secret: 'x',
  });
  const tick = await runSupervisorStaffTick({
    store,
    adapters: [adapter],
    sender,
    enabled: true,
    env: { SUPERVISOR_EVENTS_ENABLED: '1', SUPERVISOR_WEBHOOK_SIGNING: '1' },
    needsHumanWriter: async (row) => {
      needsHuman.push(row);
      return { ok: true };
    },
  });
  assert.ok(tick && tick.ok === true);
  assert.ok(store.events.length >= 1);
  assert.ok(typeof startSupervisorEventsLoop === 'function');
  const apiSrc = require('fs').readFileSync(require('path').join(__dirname, 'staff-query-api.js'), 'utf8');
  assert.match(apiSrc, /runSupervisorStaffTick/);
  assert.match(apiSrc, /startSupervisorEventsLoop/);

  store.events[0].delivery_status = 'failed';
  store.events[0].last_error = 'http_500';
  store.events[0].conversation_id = 'conv-tick';
  store.events[0].booking_code = 'WH-77';
  store.events[0].next_retry_at = null;
  store.events[0].fallback_status = null;
  const rec = await reconcileSupervisorDeliveries(store, {
    needsHumanWriter: async (row) => {
      needsHuman.push(row);
      return { ok: true };
    },
  });
  assert.ok(rec.needsHuman >= 1);
  assert.strictEqual(needsHuman[needsHuman.length - 1].booking_code, 'WH-77');
  assert.ok(needsHuman[needsHuman.length - 1].reason);
  assert.ok(needsHuman[needsHuman.length - 1].cause_incident_id || needsHuman[needsHuman.length - 1].conversation_id);

  const recursive = await captureSupervisorEvent(store, {
    source_key: 'stg:staff:send_failed:sup:1',
    kind: 'supervisor_send_failed',
    obligation: 'confirmation',
    conversation_id: 'conv-tick',
    booking_code: 'WH-77',
    cause_incident_id: 'inc-auth-1',
  });
  await dispatchDueEvents(store, sender, {
    enabled: true,
    now: new Date(),
    workerId: 'w',
    needsHumanWriter: async (row) => {
      needsHuman.push(row);
      return { ok: true };
    },
  });
  assert.strictEqual(recursive.row.cause_incident_id, 'inc-auth-1');
  const suppressed = store.events.find((e) => e.id === recursive.row.id);
  assert.strictEqual(suppressed.delivery_status, 'suppressed_recursive');
  assert.ok(needsHuman.some((n) => n.reason && n.booking_code === 'WH-77'));
}

async function testOutcomeOwnerFenceAndLifecycleBinding() {
  const store = createMemorySupervisorStore();
  const captured = await captureSupervisorEvent(store, {
    source_key: 'stg:staff:silence:fence:1',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-f',
    booking_code: 'WH-2',
  });
  const supervisor = { staff_user_id: SUPERVISOR_ID, role: 'admin' };
  const claimed = await claimSupervisorIncident(store, {
    user: supervisor,
    conversation_id: 'conv-f',
    event_id: captured.row.id,
    now: new Date(),
  });
  const naked = await recordSupervisorOutcome(store, {
    event_id: captured.row.id,
    outcome: 'sent',
  });
  assert.strictEqual(naked.ok, false);
  assert.ok(['claim_expired', 'delivery_evidence_required', 'owner_mismatch', 'conversation_mismatch'].includes(naked.error));

  const bound = await recordSupervisorOutcome(store, {
    event_id: captured.row.id,
    conversation_id: 'conv-f',
    incident_id: claimed.incident.id,
    lease_token: claimed.incident.lease_token,
    user: supervisor,
    outcome: 'sent',
    evidence: { provider_message_id: 'wamid.1', delivery_status: 'acked' },
  });
  assert.strictEqual(bound.ok, true);

  const lifeMissing = await recordSupervisorLifecycle(store, {
    kind: 'stayed_out',
  });
  assert.strictEqual(lifeMissing.ok, false);

  const life = await recordSupervisorLifecycle(store, {
    event_id: captured.row.id,
    conversation_id: 'conv-f',
    user: supervisor,
    kind: 'stayed_out',
  });
  assert.strictEqual(life.ok, true);

  store.events[0].delivery_status = 'pending';
  store.events[0].outcome = 'sent';
  const listed = await store.listEvents();
  assert.ok(listed.length >= 1);
  const re = await catchUpSupervisorSources(store, [], {
    reenable: true,
    currentState: async (ev) => ({ resolved: !!ev.outcome }),
  });
  assert.ok(re.stale >= 1);
}

async function testCap1559AdmissionDispatchWatchdog() {
  assert.strictEqual(typeof resolveSupervisorWriteTarget, 'function');
  const missing = resolveSupervisorWriteTarget({ query: {}, body: {} });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.error, 'conversation_required');
  const queryOnly = resolveSupervisorWriteTarget({ query: { conversation_id: 'q' }, body: {} });
  assert.strictEqual(queryOnly.ok, false);
  assert.strictEqual(queryOnly.error, 'conversation_required');
  const body = resolveSupervisorWriteTarget({ query: { conversation_id: 'q' }, body: { conversation_id: 'b' } });
  assert.strictEqual(body.ok, false);
  assert.strictEqual(body.error, 'conversation_mismatch');
  const ok = resolveSupervisorWriteTarget({ query: { conversation_id: 'c1' }, body: { conversation_id: 'c1' } });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.conversation_id, 'c1');
  const bodyOnly = resolveSupervisorWriteTarget({ body: { conversation_id: 'c2' } });
  assert.strictEqual(bodyOnly.ok, true);
  assert.strictEqual(bodyOnly.conversation_id, 'c2');

  const store = createMemorySupervisorStore();
  const captured = await captureSupervisorEvent(store, {
    source_key: 'stg:staff:silence:cap1559:1',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-1559',
    booking_code: 'WH-59',
  });
  const supervisor = { staff_user_id: SUPERVISOR_ID, role: 'admin' };
  const claimed = await claimSupervisorIncident(store, {
    user: supervisor,
    conversation_id: 'conv-1559',
    event_id: captured.row.id,
    now: new Date(),
  });
  const noCid = await admitSupervisorBusinessAction(store, {
    user: supervisor,
    lease_token: claimed.incident.lease_token,
    factsLoaded: true,
    pause: { paused: false },
    lunaMode: 'auto',
  });
  assert.strictEqual(noCid.ok, false);
  assert.ok(['conversation_required', 'claim_expired'].includes(noCid.error));

  const headerSpoof = await admitSupervisorBusinessAction(store, {
    user: supervisor,
    conversation_id: 'conv-other',
    incident_id: claimed.incident.id,
    lease_token: claimed.incident.lease_token,
    factsLoaded: true,
    pause: { paused: false },
    lunaMode: 'auto',
  });
  assert.strictEqual(headerSpoof.ok, false);

  const ownerRenew = await renewSupervisorClaim(store, {
    incident_id: claimed.incident.id,
    lease_token: claimed.incident.lease_token,
    user: { staff_user_id: '00000000-0000-4000-8000-000000000099', role: 'admin' },
    now: new Date(),
  });
  assert.strictEqual(ownerRenew.ok, false);
  assert.strictEqual(ownerRenew.error, 'owner_mismatch');

  const bind = bindCompleteDispatchParams('evt-1', 'worker-a', { delivery_status: 'acked' }, new Date('2026-11-01T12:00:00Z'));
  assert.ok(bind.sql.includes('dispatch_lease_until >= $3'));
  assert.ok(bind.vals[2] instanceof Date || String(bind.vals[2]).includes('2026-11-01'));
  assert.notStrictEqual(bind.vals[2], 'acked');
  assert.ok(bind.fields.some((f) => f.includes('delivery_status')));

  const failStore = createMemorySupervisorStore();
  const failCap = await captureSupervisorEvent(failStore, {
    source_key: 'stg:staff:silence:cap1559:fail',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-fail',
    booking_code: 'WH-60',
  });
  failStore.events[0].delivery_status = 'failed';
  failStore.events[0].last_error = 'http_500';
  const nh = await persistSupervisorNeedsHuman({
    store: failStore,
    needsHumanWriter: async () => ({ ok: false, error: 'writer_down' }),
  }, failStore.events[0], 'http_500');
  assert.strictEqual(nh.ok, false);
  const after = failStore.events[0];
  assert.ok(String(after.last_error || '').includes('needs_human_pending') || after.delivery_status === 'failed');
  assert.ok(after.next_retry_at, 'watchdog retry scheduled after failed needs-human save');

  const hist = createMemorySupervisorStore();
  await captureSupervisorEvent(hist, {
    source_key: 'stg:staff:silence:old:1',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-old',
  });
  hist.events[0].delivery_status = 'pending';
  hist.events[0].outcome = 'sent';
  const adapter = {
    name: 'silence',
    async listSince() {
      return [{
        source_key: 'stg:staff:silence:hist:2',
        kind: 'silence',
        obligation: 'silence',
        conversation_id: 'conv-hist',
        cursor: 'c-hist',
        outcome: 'already_sent',
      }];
    },
  };
  const order = [];
  const origList = hist.listEvents.bind(hist);
  hist.listEvents = async (filter) => {
    order.push('reeval:' + hist.events.length);
    return origList(filter);
  };
  const catchUp = await catchUpSupervisorSources(hist, [adapter], {
    reenable: true,
    currentState: async (ev) => ({ resolved: !!ev.outcome || ev.outcome === 'already_sent' }),
  });
  assert.ok(order.length >= 1);
  const reevalCount = Number(String(order[0]).split(':')[1]);
  assert.ok(reevalCount >= 2, 're-enable re-evaluates after historical catch-up inserts');
  assert.ok(catchUp.stale >= 1);
  assert.strictEqual(shouldEmitSupervisorSendAudit({ idempotent_replay: true, send_performed: true }), true);
  assert.strictEqual(shouldEmitSupervisorSendAudit({ send_performed: true, whatsapp_message_id: 'wamid.1' }), true);
  assert.strictEqual(shouldEmitSupervisorSendAudit({ success: true, whatsapp_message_id: 'wamid.1', send_performed: false }), false);

  const srcRoutes = require('fs').readFileSync(require('path').join(__dirname, 'lib/staff-supervisor-routes.js'), 'utf8');
  assert.match(srcRoutes, /getPauseState\(/);
  assert.doesNotMatch(srcRoutes, /cleared_at IS NULL/);
  assert.doesNotMatch(srcRoutes, /FROM conversation_messages/);
  assert.doesNotMatch(srcRoutes, /AND direction = 'outbound'/);
  assert.match(srcRoutes, /last_staff_reply_at/);
  assert.match(srcRoutes, /current_hold_booking_id/);
  assert.match(srcRoutes, /booking_code/);

  const srcApi = require('fs').readFileSync(require('path').join(__dirname, 'staff-query-api.js'), 'utf8');
  const srcInbox = require('fs').readFileSync(require('path').join(__dirname, 'lib/staff-inbox-routes.js'), 'utf8');
  assert.doesNotMatch(srcApi, /conversation_id: parsed\.query && parsed\.query\.conversation_id/);
  assert.match(srcApi, /admitSupervisorBodyWrite\(req, res, user, \{/);
  assert.match(srcApi, /conversation_id: convId/);

  const cross = await recordSupervisorOutcome(store, {
    event_id: captured.row.id,
    incident_id: claimed.incident.id,
    conversation_id: 'conv-other',
    user: supervisor,
    lease_token: claimed.incident.lease_token,
    outcome: 'sent',
    evidence: { delivery_status: 'acked' },
  });
  assert.strictEqual(cross.ok, false);

  const expired = await recordSupervisorOutcome(store, {
    event_id: captured.row.id,
    incident_id: claimed.incident.id,
    conversation_id: 'conv-1559',
    user: supervisor,
    lease_token: claimed.incident.lease_token,
    now: new Date(Date.now() + 10 * 60 * 1000),
    outcome: 'sent',
    evidence: { delivery_status: 'acked' },
  });
  assert.strictEqual(expired.ok, false);

  const callerOnly = await recordSupervisorOutcome(store, {
    event_id: captured.row.id,
    incident_id: claimed.incident.id,
    conversation_id: 'conv-1559',
    user: supervisor,
    lease_token: claimed.incident.lease_token,
    obligation: 'owed',
    outcome: 'sent',
    evidence: { delivery_status: 'acked' },
  });
  assert.strictEqual(callerOnly.ok, false);

  const staleStore = createMemorySupervisorStore();
  const staleCap = await captureSupervisorEvent(staleStore, {
    source_key: 'stg:staff:silence:stale:1',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-stale',
  });
  staleStore.completeDispatch = async () => null;
  let unfenced = 0;
  const origUpdate = staleStore.updateEvent.bind(staleStore);
  staleStore.updateEvent = async (id, patch) => {
    if (patch && patch.last_error === 'stale_dispatch_claim') unfenced += 1;
    return origUpdate(id, patch);
  };
  await dispatchDueEvents(staleStore, { post: async () => ({ ok: true }) }, { enabled: true, workerId: 'w1' });
  assert.strictEqual(unfenced, 0, 'stale worker must not unfence-reset a successor');

  const retryStore = createMemorySupervisorStore();
  const retryCap = await captureSupervisorEvent(retryStore, {
    source_key: 'stg:staff:silence:retry:1',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-retry',
  });
  retryStore.events[0].delivery_status = 'failed';
  retryStore.events[0].next_retry_at = new Date(Date.now() + 60 * 1000).toISOString();
  retryStore.events[0].last_error = 'original_http_500';
  retryStore.events[0].cause_incident_id = claimed.incident.id;
  let writerCalls = 0;
  const rec = await reconcileSupervisorDeliveries(retryStore, {
    now: new Date(),
    needsHumanWriter: async () => { writerCalls += 1; return { ok: true }; },
  });
  assert.strictEqual(writerCalls, 0, 'watchdog respects next_retry_at');

  const d6 = createMemorySupervisorStore();
  await captureSupervisorEvent(d6, {
    source_key: 'stg:staff:silence:d6:1',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-d6',
  });
  d6.events[0].delivery_status = 'pending';
  d6.events[0].outcome = 'accepted_looking';
  const d6out = await catchUpSupervisorSources(d6, [], {
    reenable: true,
    currentState: async () => ({ resolved: false }),
  });
  assert.strictEqual(d6out.stale, 0, 'authoritative unresolved must not become stale_on_reenable');

  assert.doesNotMatch(srcApi, /throw new Error\(audit\.error/);
  assert.match(srcApi, /res\._supervisorAudit/);
  assert.match(srcApi, /sendSupervisorCompleted/);
  assert.match(srcRoutes, /const lifecycle = out\.kind/);
  assert.strictEqual(classifyPauseOwner('luna_flag_needs_human'), 'luna');
  assert.strictEqual(classifyPauseOwner(SUPERVISOR_ID), 'staff');
  const lunaHold = stayOutReason({
    pause: { paused: true, owner: classifyPauseOwner('luna_flag_needs_human') },
    lunaMode: 'auto',
    now: new Date(),
  });
  assert.strictEqual(lunaHold, null, 'luna_flag_needs_human is a Luna hold, not unproven stay-out');

  const webhookAcked = createMemorySupervisorStore();
  const capturedAck = await captureSupervisorEvent(webhookAcked, {
    source_key: 'stg:staff:silence:webhook-ack:1',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-ack',
  });
  const claimedAck = await claimSupervisorIncident(webhookAcked, {
    user: supervisor,
    conversation_id: 'conv-ack',
    event_id: capturedAck.row.id,
    now: new Date(),
  });
  webhookAcked.events[0].delivery_status = 'acked';
  webhookAcked.events[0].acked_at = new Date().toISOString();
  const falseComplete = await recordSupervisorOutcome(webhookAcked, {
    event_id: capturedAck.row.id,
    conversation_id: 'conv-ack',
    incident_id: claimedAck.incident.id,
    lease_token: claimedAck.incident.lease_token,
    user: supervisor,
    outcome: 'sent',
  });
  assert.strictEqual(falseComplete.closed, false, 'webhook acked is not guest-delivery proof');
  assert.strictEqual(webhookAcked.incidents[0].status, 'open');

  assert.doesNotMatch(srcRoutes, /AND direction = 'outbound'/);
  assert.match(srcRoutes, /guest_phone/);
  assert.match(srcRoutes, /needs_human_transition_id/);
  assert.match(srcApi, /admitSupervisorBodyWrite\(req, res, user, body, 'add_on_record'\)/);
  assert.match(srcApi, /admitSupervisorBodyWrite\(req, res, user, body, 'add_on_remove'\)/);
  const srcEvents = require('fs').readFileSync(require('path').join(__dirname, 'lib/staff-supervisor-events.js'), 'utf8');
  assert.doesNotMatch(srcEvents, /fallback_status/);
  assert.doesNotMatch(srcEvents, /workerId: opts\.workerId \|\| 'staff-loop'/);

  const retryEvent = buildSupervisorAuditRetryEvent({
    action: 'booking_create',
    operation_key: 'supervisor:inc-1:booking_create',
    conversation_id: 'conv-a',
    booking_code: 'WH-1',
    entry: { intent: 'action:supervisor:booking_create', booking_ref: 'WH-1' },
  });
  assert.strictEqual(retryEvent.obligation, 'handoff');
  assert.strictEqual(retryEvent.kind, 'audit_retry');
  assert.strictEqual(retryEvent.metadata.wake_supervisor, false);
  assert.strictEqual(retryEvent.metadata.audit_entry.booking_ref, 'WH-1');
  assert.ok(!shouldRecordSupervisorCompletion({ effect: 'blocked' }));
  assert.ok(!shouldRecordSupervisorCompletion({ effect: 'noop' }));
  assert.ok(!shouldRecordSupervisorCompletion({ effect: 'replayed' }));
  assert.ok(shouldRecordSupervisorCompletion({ effect: 'mutated' }));
  assert.ok(shouldRecordSupervisorCompletion({ effect: 'replayed', prior_operation_key: 'supervisor:inc-1:booking_edit' }));
  assert.ok(shouldRecordSupervisorCompletion({ effect: 'replayed', operation_key: 'supervisor:inc-1:booking_create' }));
  const datesId = supervisorAuditIdentity({
    operation_key: 'k1', action: 'booking_edit', edit_type: 'dates', booking_id: 'b1',
  });
  const guestsId = supervisorAuditIdentity({
    operation_key: 'k1', action: 'booking_edit', edit_type: 'guests', booking_id: 'b1',
  });
  assert.notStrictEqual(datesId, guestsId);
  const mutatedId = supervisorAuditIdentity({
    operation_key: 'k1', action: 'booking_create', booking_id: 'b1', effect: 'mutated',
  });
  const replayedId = supervisorAuditIdentity({
    prior_operation_key: 'k1', action: 'booking_create', booking_id: 'b1', effect: 'replayed',
  });
  assert.strictEqual(mutatedId, replayedId);
  const noteA = supervisorAuditIdentity({
    operation_key: 'k2', action: 'booking_readback', edit_type: 'note_append', booking_id: 'b1', resource_id: 'n1',
  });
  const noteD = supervisorAuditIdentity({
    operation_key: 'k2', action: 'booking_readback', edit_type: 'note_delete', booking_id: 'b1', resource_id: 'n1',
  });
  assert.notStrictEqual(noteA, noteD);
  const nameA = supervisorAuditIdentity({
    operation_key: 'k3', action: 'booking_edit', edit_type: 'guest_names', booking_id: 'b1',
    resource_id: 'g1=Ada',
  });
  const nameB = supervisorAuditIdentity({
    operation_key: 'k3', action: 'booking_edit', edit_type: 'guest_names', booking_id: 'b1',
    resource_id: 'g2=Bea',
  });
  assert.notStrictEqual(nameA, nameB);
  const filled = normalizeSupervisorCompletionReceipt(
    { effect: 'mutated' },
    { edit_type: 'dates', booking: { booking_id: 'saved-id', booking_code: 'WH-9' } },
  );
  assert.strictEqual(filled.edit_type, 'dates');
  assert.strictEqual(filled.booking_id, 'saved-id');

  const createFresh = normalizeSupervisorCompletionReceipt(
    { effect: 'mutated', booking_id: 'b-create' },
    { booking_id: 'b-create', payment_id: 'pay-fresh' },
  );
  const createDup = normalizeSupervisorCompletionReceipt(
    { effect: 'replayed', booking_id: 'b-create', prior_operation_key: 'k-create' },
    { booking_id: 'b-create' },
  );
  assert.strictEqual(createFresh.resource_id, createDup.resource_id,
    'booking-create payment_id is not a second identity');
  assert.strictEqual(createFresh.resource_id, null);
  const payLinkReceipt = normalizeSupervisorCompletionReceipt(
    { effect: 'mutated', booking_id: 'b1', resource_id: 'pay-owned' },
    { payment_id: 'pay-owned' },
  );
  assert.strictEqual(payLinkReceipt.resource_id, 'pay-owned');
  assert.match(srcApi, /SELECT id::text AS service_record_id, id::text AS id/);
  assert.match(srcApi, /resource_id: \(result\.row && result\.row\.service_record_id\) \|\| null/);

  const auditStore = createMemorySupervisorStore();
  const retained = await retainFailedSupervisorAudit(auditStore, {
    action: 'booking_create',
    operation_key: 'supervisor:inc-1:booking_create',
    conversation_id: 'conv-a',
    booking_code: 'WH-1',
    entry: { intent: 'action:supervisor:booking_create', booking_ref: 'WH-1' },
  });
  assert.strictEqual(retained.ok, true);
  assert.strictEqual(retained.inserted, true);
  const retainedAgain = await retainFailedSupervisorAudit(auditStore, {
    action: 'booking_create',
    operation_key: 'supervisor:inc-1:booking_create',
    conversation_id: 'conv-a',
    booking_code: 'WH-1',
    entry: { intent: 'action:supervisor:booking_create', booking_ref: 'WH-1' },
  });
  assert.strictEqual(retainedAgain.inserted, false);
  const logs = [];
  const firstReplay = await replaySupervisorAuditRetries(auditStore, {
    appendAuditLog: (entry) => { logs.push(entry); return { ok: true }; },
  });
  assert.strictEqual(firstReplay.replayed, 1);
  const secondReplay = await replaySupervisorAuditRetries(auditStore, {
    appendAuditLog: (entry) => { logs.push(entry); return { ok: true }; },
  });
  assert.strictEqual(secondReplay.replayed, 0);
  assert.strictEqual(logs.length, 1);

  const stranded = createMemorySupervisorStore();
  const strandedRow = await retainFailedSupervisorAudit(stranded, {
    action: 'booking_create',
    operation_key: 'supervisor:inc-strand:booking_create',
    conversation_id: 'conv-strand',
    booking_code: 'WH-S',
    entry: { intent: 'action:supervisor:booking_create', booking_ref: 'WH-S' },
  });
  stranded.events[0].metadata.audit_claim = true;
  stranded.events[0].metadata.audit_claim_until = new Date(Date.now() - 1000).toISOString();
  const recovered = [];
  const recover = await replaySupervisorAuditRetries(stranded, {
    appendAuditLog: (entry) => { recovered.push(entry); return { ok: true }; },
    now: new Date(),
  });
  assert.strictEqual(recover.replayed, 1, 'expired audit claim is recoverable');
  assert.strictEqual(recovered.length, 1);

  assert.match(srcApi, /edit_type: 'dates'/);
  assert.match(srcApi, /edit_type: 'note_append'/);
  assert.match(srcApi, /projectSupervisorAudit\(store, appendAuditLog, entry\)/);

  assert.doesNotMatch(srcApi, /obligation: 'audit'/);
  assert.doesNotMatch(srcApi, /queueSupervisorAuditRetry/);
  assert.match(srcApi, /sendSupervisorCompleted/);
  assert.match(srcApi, /effect: 'mutated'/);
  assert.match(srcApi, /effect: result\.idempotent \? 'replayed' : 'mutated'/);
  assert.doesNotMatch(srcApi, /finishSupervisorBusiness/);

  assert.match(srcRoutes, /getPauseState\(/);
  assert.doesNotMatch(srcRoutes, /conversation_id IS NULL AND guest_phone IS NULL/);
  assert.match(srcRoutes, /normalizeWhatsAppMode/);
  assert.match(srcRoutes, /next_retry_at/);
  assert.match(srcApi, /body\.idempotency_key = user\.supervisor_operation_key/);
  assert.match(srcApi, /idempotency_key: \(user && user\.supervisor_operation_key\) \|\| body\.idempotency_key/);
  assert.match(srcEvents, /bindLunaPausePermit/);
  assert.match(srcInbox, /guest_whatsapp_message_id/);
  assert.match(srcInbox, /accepted_pending_delivery/);
  assert.match(srcRoutes, /table_missing/);
  assert.match(srcRoutes, /body.phone \|\| extra.body.guest_phone/);
  assert.doesNotMatch(srcRoutes, /OR \(\$3::text <> '' AND b.booking_code = \$3\)/);
  assert.doesNotMatch(srcEvents, /await bindLunaPausePermit\(pg, loaded\.row/);

  webhookAcked.events[0].metadata = { guest_whatsapp_message_id: 'wamid.1' };
  const stillOpen = await recordSupervisorOutcome(webhookAcked, {
    event_id: capturedAck.row.id,
    conversation_id: 'conv-ack',
    incident_id: claimedAck.incident.id,
    lease_token: claimedAck.incident.lease_token,
    user: supervisor,
    outcome: 'sent',
  });
  assert.strictEqual(stillOpen.closed, false, 'provider acceptance WAMID is not guest delivery');
  assert.strictEqual(webhookAcked.incidents[0].status, 'open');

  const already = createMemorySupervisorStore();
  await captureSupervisorEvent(already, {
    source_key: 'stg:staff:silence:handoff-once:1',
    kind: 'silence',
    obligation: 'handoff',
    conversation_id: 'conv-once',
    cause_incident_id: 'inc-parent',
  });
  already.events[0].delivery_status = 'suppressed_recursive';
  already.events[0].metadata = { handoff_recorded: true };
  let writes = 0;
  const once = await persistSupervisorNeedsHuman({
    store: already,
    needsHumanWriter: async () => { writes += 1; return { ok: true }; },
  }, already.events[0], 'supervisor_recursive_suppressed');
  assert.strictEqual(once.already, true);
  assert.strictEqual(writes, 0, 'successful descendant handoff is not rewritten');

  const late = createMemorySupervisorStore();
  await captureSupervisorEvent(late, {
    source_key: 'stg:staff:silence:backoff:1',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-backoff',
  });
  late.events[0].next_retry_at = new Date(Date.now() + 60 * 1000).toISOString();
  const claimedEarly = await late.claimDispatch(late.events[0].id, 'worker-a', new Date(Date.now() + 30000));
  assert.strictEqual(claimedEarly, null, 'claim must respect next_retry_at');

  const auditRetry = await captureSupervisorEvent(createMemorySupervisorStore(), buildSupervisorAuditRetryEvent({
    action: 'booking_create',
    operation_key: 'supervisor:inc-2:booking_create',
    conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    booking_code: 'WH-2',
    effect: 'mutated',
    entry: { intent: 'action:supervisor:booking_create' },
  }));
  assert.strictEqual(auditRetry.row.delivery_status, 'diagnostic');
  const dueAudit = await createMemorySupervisorStore().listDueEvents(new Date(), { limit: 20 });
  assert.ok(!dueAudit.some((e) => e.kind === 'audit_retry'));
  const contactKey = buildSupervisorAuditRetryEvent({
    operation_key: 'supervisor:inc:booking_edit',
    action: 'booking_edit',
    edit_type: 'contact',
    booking_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    effect: 'mutated',
    entry: { intent: 'action:supervisor:booking_edit' },
  }).source_key;
  const packageKey = buildSupervisorAuditRetryEvent({
    operation_key: 'supervisor:inc:booking_edit',
    action: 'booking_edit',
    edit_type: 'package',
    booking_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    effect: 'mutated',
    entry: { intent: 'action:supervisor:booking_edit' },
  }).source_key;
  assert.notStrictEqual(contactKey, packageKey);
  assert.match(srcApi, /edit_type: 'guest_dates'/);
  assert.match(srcApi, /conversation_id: convId/);
  const busyStore = createMemorySupervisorStore();
  await captureSupervisorEvent(busyStore, {
    source_key: 'stg:staff:silence:busy:1',
    kind: 'silence',
    obligation: 'handoff',
    conversation_id: 'conv-busy',
  });
  busyStore.events[0].metadata = {
    handoff_claim: true,
    handoff_claim_until: new Date(Date.now() + 60 * 1000).toISOString(),
  };
  let busyWrites = 0;
  const busy = await persistSupervisorNeedsHuman({
    store: busyStore,
    needsHumanWriter: async () => { busyWrites += 1; return { ok: true }; },
  }, busyStore.events[0], 'x');
  assert.strictEqual(busy.busy, true);
  assert.strictEqual(busyWrites, 0);

  busyStore.events[0].metadata.handoff_claim_until = new Date(Date.now() - 1000).toISOString();
  const recoveredHandoff = await persistSupervisorNeedsHuman({
    store: busyStore,
    needsHumanWriter: async () => { busyWrites += 1; return { ok: true }; },
  }, busyStore.events[0], 'x');
  assert.strictEqual(recoveredHandoff.ok, true);
  assert.strictEqual(busyWrites, 1);

  const pendingStore = createMemorySupervisorStore();
  await captureSupervisorEvent(pendingStore, {
    source_key: 'stg:staff:silence:accepted:1',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-acc',
  });
  pendingStore.events[0].delivery_status = 'accepted_pending_delivery';
  pendingStore.events[0].updated_at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  pendingStore.events[0].metadata = { guest_whatsapp_message_id: 'wamid.acc' };
  let accWrites = 0;
  const recPending = await reconcileSupervisorDeliveries(pendingStore, {
    now: new Date(),
    needsHumanWriter: async () => { accWrites += 1; return { ok: true }; },
  });
  assert.ok(accWrites === 1, 'accepted-pending unknown reaches human fallback');
  assert.strictEqual(recPending.failedSaves, 0);

  const deliveredStore = createMemorySupervisorStore();
  await captureSupervisorEvent(deliveredStore, {
    source_key: 'stg:staff:silence:deliv:1',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-del',
  });
  deliveredStore.events[0].delivery_status = 'accepted_pending_delivery';
  deliveredStore.events[0].metadata = { guest_whatsapp_message_id: 'wamid.ok' };
  const recDel = await reconcileSupervisorDeliveries(deliveredStore, {
    deliveryLookup: async () => ({ delivered: true, status: 'delivered' }),
  });
  assert.strictEqual(recDel.reconciled, 1);
  assert.strictEqual(deliveredStore.events[0].metadata.guest_delivered, true);

  const fs = require('fs');
  const path = require('path');
  const pauseSrc = fs.readFileSync(path.join(__dirname, 'lib/staff-bot-pause-sql.js'), 'utf8');
  assert.match(pauseSrc, /conversationPausePermitMetadata/);
  assert.match(pauseSrc, /isLunaPauseOwner\(pausedBy\)/);
  assert.match(pauseSrc, /needs_human_transition_id/);
  assert.match(pauseSrc, /luna_handoff_transition_id/);
  assert.match(srcApi, /deliveryLookup: \(ev\) => lookupSupervisorDelivery\(pg, ev\)/);
  assert.match(srcEvents, /booking_confirmation_delivery_events/);
  assert.match(srcEvents, /completeHandoffFallback/);
  assert.match(srcEvents, /handoff_writer_ok/);
  assert.match(srcEvents, /staff_handoff_id/);
  assert.match(srcEvents, /skipped: 'cause_required'/);
  assert.match(srcApi, /annotateSupervisorCauseAfterHandoff/);
  assert.doesNotMatch(pauseSrc, /catch \(_\) \{\s*return \{\};/);

  const noCause = await annotateSupervisorCauseAfterHandoff(null, { ok: true, already: false }, {
    conversation_id: 'c1',
    cause_incident_id: null,
  });
  assert.strictEqual(noCause.ok, true);
  assert.strictEqual(noCause.supervisor_cause_skipped, 'no_cause');

  const writerOkStore = createMemorySupervisorStore();
  await captureSupervisorEvent(writerOkStore, {
    source_key: 'stg:staff:silence:writer-ok:1',
    kind: 'silence',
    obligation: 'handoff',
    conversation_id: 'conv-wok',
  });
  writerOkStore.events[0].metadata = { handoff_writer_ok: true };
  let wokWrites = 0;
  const wok = await persistSupervisorNeedsHuman({
    store: writerOkStore,
    needsHumanWriter: async () => { wokWrites += 1; return { ok: true }; },
  }, writerOkStore.events[0], 'x');
  assert.strictEqual(wokWrites, 0, 'canonical handoff already saved is not rerun');
  assert.ok(wok.ok);
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
  await testStaffTickCatchUpDispatchAndWatchdog();
  await testOutcomeOwnerFenceAndLifecycleBinding();
  await testCap1559AdmissionDispatchWatchdog();
  console.log('ok supervisor events intake/dispatch/claim');
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
});
