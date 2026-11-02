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
  runSupervisorDetectorTick,
  shouldStartSupervisorEventsLoop,
  LOOKOUT_PIN,
  persistSupervisorNeedsHuman,
  resolveSupervisorWriteTarget,
  bindCompleteDispatchParams,
  shouldEmitSupervisorSendAudit,
  encodeSupervisorCheckpoint,
  decodeSupervisorCheckpoint,
  classifyPauseOwner,
  stayOutReason,
  shouldRecordSupervisorCompletion,
  buildSupervisorAuditRetryEvent,
  retainFailedSupervisorAudit,
  replaySupervisorAuditRetries,
  reclassifyRetainedNoWake,
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
  store.events[0].whatsapp_message_id = 'wamid.close';
  await recordSupervisorOutcome(store, {
    event_id: captured.row.id,
    conversation_id: 'conv-1',
    incident_id: afterExpiry.incident.id,
    lease_token: afterExpiry.incident.lease_token,
    user: supervisor,
    outcome: 'sent',
    evidence: { provider_message_id: 'wamid.close', delivery_status: 'acked' },
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

async function testLookoutTickRealScanCheckpointAndGaps() {
  const { runLookoutDetectorScan } = require('./lib/luna-supervisor-lookout-detectors');
  assert.strictEqual(typeof runLookoutDetectorScan, 'function');
  assert.strictEqual(typeof shouldStartSupervisorEventsLoop, 'function');
  assert.strictEqual(shouldStartSupervisorEventsLoop({}), false);
  assert.strictEqual(shouldStartSupervisorEventsLoop({ SUPERVISOR_EVENTS_ENABLED: '1' }), false);
  assert.strictEqual(shouldStartSupervisorEventsLoop({
    SUPERVISOR_EVENTS_ENABLED: '1',
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
    NODE_ENV: 'staging',
  }), false);
  assert.strictEqual(shouldStartSupervisorEventsLoop({
    SUPERVISOR_EVENTS_ENABLED: '1',
    NODE_ENV: 'production',
    DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
  }), false);
  assert.strictEqual(shouldStartSupervisorEventsLoop({
    SUPERVISOR_EVENTS_ENABLED: '1',
    NODE_ENV: 'staging',
    DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
    WOLFHOUSE_ENV: 'staging',
  }), true);
  assert.strictEqual(shouldStartSupervisorEventsLoop({
    SUPERVISOR_EVENTS_ENABLED: '1',
    NODE_ENV: 'staging',
    DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
    WOLFHOUSE_ENV: 'staging',
    STAFF_RUNTIME_PROFILE: 'production',
  }), false);
  assert.strictEqual(shouldStartSupervisorEventsLoop({
    SUPERVISOR_EVENTS_ENABLED: '0',
    NODE_ENV: 'staging',
    DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
    WOLFHOUSE_ENV: 'staging',
  }), false);

  const apiSrc = require('fs').readFileSync(require('path').join(__dirname, 'staff-query-api.js'), 'utf8');
  assert.match(apiSrc, /shouldStartSupervisorEventsLoop/);
  assert.match(apiSrc, /if \(shouldStartSupervisorEventsLoop\(process\.env\)\)/);

  const store = createMemorySupervisorStore();
  const now = new Date('2026-11-01T12:00:00.000Z');
  const guestCreated = new Date(now.getTime() - 3 * 60 * 1000).toISOString();
  const silenceRow = {
    conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    client_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    client_slug: LOOKOUT_PIN.client_slug,
    guest_message_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    guest_created_at: guestCreated,
    phone: '+34000',
  };
  const tick = await runSupervisorDetectorTick({
    store,
    enabled: true,
    scan: runLookoutDetectorScan,
    sources: {
      silence: async () => [silenceRow],
      owedHint: async () => [],
      sendFailed: async () => [],
      waFailed: async () => [],
    },
    now,
  });
  assert.notStrictEqual(tick && tick.error, 'checkpoint_only_after_capture');
  assert.strictEqual(tick.ok, true, 'real Lookout scan must succeed after capture');
  assert.ok(store.checkpoints.silence, 'cursor advances after capture');
  assert.ok(store.events.some((e) => e.kind === 'silence'));

  const failStore = createMemorySupervisorStore();
  const origInsert = failStore.insertEvent.bind(failStore);
  failStore.insertEvent = async (input) => {
    if (input && input.kind === 'silence') return { inserted: false, error: 'capture_failed' };
    return origInsert(input);
  };
  const failed = await runSupervisorDetectorTick({
    store: failStore,
    enabled: true,
    scan: runLookoutDetectorScan,
    sources: {
      silence: async () => [silenceRow],
      owedHint: async () => [],
      sendFailed: async () => [],
      waFailed: async () => [],
    },
    now,
  });
  assert.strictEqual(failed.ok, false, 'Lookout ok:false is not a fake success');
  assert.ok(failed.error);
  const gaps = failStore.events.filter((e) => e.kind === 'capture_gap');
  assert.ok(gaps.length >= 1, 'visible capture_gap on failed capture');
  const gapKey = gaps[0].source_key;
  const gapRev = String(gapKey).split(':').pop();
  assert.ok(!/^\d{10,}$/.test(gapRev), 'capture_gap identity is not Date.now()');
  await runSupervisorDetectorTick({
    store: failStore,
    enabled: true,
    scan: runLookoutDetectorScan,
    sources: {
      silence: async () => [silenceRow],
      owedHint: async () => [],
      sendFailed: async () => [],
      waFailed: async () => [],
    },
    now,
  });
  const gapsAgain = failStore.events.filter((e) => e.kind === 'capture_gap');
  assert.strictEqual(gapsAgain.length, gaps.length, 'stable capture_gap identity does not flood');
  assert.ok(gapsAgain.every((e) => e.delivery_status === 'diagnostic'));
  assert.ok(gapsAgain.every((e) => e.metadata && e.metadata.wake_supervisor === false));

  const cursor = { ts: '2026-11-01T12:00:00.000Z', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
  const encoded = encodeSupervisorCheckpoint(cursor);
  assert.strictEqual(typeof encoded, 'string');
  const decoded = decodeSupervisorCheckpoint(encoded);
  assert.strictEqual(decoded.ts, cursor.ts);
  assert.strictEqual(decoded.id, cursor.id);
  const pgLike = { cursor: encoded };
  assert.strictEqual(typeof pgLike.cursor, 'string');
  assert.strictEqual(decodeSupervisorCheckpoint(pgLike.cursor).id, cursor.id);

  const noWake = await captureSupervisorEvent(store, {
    source_key: 'stg:staff:silence:nowake:1',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-nowake',
    metadata: { wake_supervisor: false },
  });
  assert.strictEqual(noWake.row.delivery_status, 'diagnostic');
  const due = await store.listDueEvents(new Date(), { limit: 20 });
  assert.ok(!due.some((e) => e.id === noWake.row.id));

  const descendant = await captureSupervisorEvent(store, {
    source_key: 'stg:staff:silence:nowake-cause:1',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-nowake-cause',
    cause_incident_id: 'inc-parent',
    metadata: { wake_supervisor: false },
  });
  assert.strictEqual(descendant.row.delivery_status, 'failed');
  let human = 0;
  await persistSupervisorNeedsHuman({
    needsHumanWriter: async () => { human += 1; return { ok: true }; },
    store,
  }, descendant.row, 'descendant_failed');
  assert.strictEqual(human, 1);

  const starve = createMemorySupervisorStore();
  for (let i = 0; i < 4; i += 1) {
    starve.events.push({
      id: `gap-${i}`,
      source_key: `gap:${i}`,
      kind: 'capture_gap',
      obligation: 'handoff',
      delivery_status: 'pending',
      metadata: { wake_supervisor: false },
      created_at: new Date().toISOString(),
    });
  }
  await captureSupervisorEvent(starve, {
    source_key: 'stg:staff:silence:real:1',
    kind: 'silence',
    obligation: 'silence',
    conversation_id: 'conv-real',
  });
  await reclassifyRetainedNoWake(starve);
  const dueAfter = await starve.listDueEvents(new Date(), { limit: 4 });
  assert.ok(dueAfter.some((e) => e.kind === 'silence'), 'real obligation is not starved by retained gaps');
  assert.ok(dueAfter.every((e) => e.kind !== 'capture_gap'));
  assert.ok(starve.events.filter((e) => e.kind === 'capture_gap').every((e) => e.delivery_status === 'diagnostic'));
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
  assert.strictEqual(shouldEmitSupervisorSendAudit({ idempotent_replay: true, send_performed: true }), false);
  assert.strictEqual(shouldEmitSupervisorSendAudit({ send_performed: true, whatsapp_message_id: 'wamid.1' }), true);
  assert.strictEqual(shouldEmitSupervisorSendAudit({ success: true, whatsapp_message_id: 'wamid.1', send_performed: false }), false);

  const srcRoutes = require('fs').readFileSync(require('path').join(__dirname, 'lib/staff-supervisor-routes.js'), 'utf8');
  assert.match(srcRoutes, /paused = TRUE/);
  assert.doesNotMatch(srcRoutes, /cleared_at IS NULL/);
  assert.doesNotMatch(srcRoutes, /FROM conversation_messages/);
  assert.doesNotMatch(srcRoutes, /AND direction = 'outbound'/);
  assert.match(srcRoutes, /last_staff_reply_at/);
  assert.match(srcRoutes, /current_hold_booking_id/);
  assert.doesNotMatch(srcRoutes, /FROM bookings[\s\S]*conversation_id/);

  const srcApi = require('fs').readFileSync(require('path').join(__dirname, 'staff-query-api.js'), 'utf8');
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
  assert.ok(shouldRecordSupervisorCompletion({ effect: 'mutated' }));
  assert.ok(shouldRecordSupervisorCompletion({ effect: 'replayed' }));

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

  assert.doesNotMatch(srcApi, /obligation: 'audit'/);
  assert.doesNotMatch(srcApi, /queueSupervisorAuditRetry/);
  assert.match(srcApi, /sendSupervisorCompleted/);
  assert.match(srcApi, /effect: 'mutated'/);
  assert.match(srcApi, /effect: result\.idempotent \? 'replayed' : 'mutated'/);
  assert.doesNotMatch(srcApi, /finishSupervisorBusiness/);
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
  await testLookoutTickRealScanCheckpointAndGaps();
  await testCap1559AdmissionDispatchWatchdog();
  console.log('ok supervisor events intake/dispatch/claim');
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
});
