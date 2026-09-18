'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const {
  decideStripeHoldPromote,
  applyStripeBookingPaymentTruthWrites,
} = require('./lib/stripe-hold-promote-policy');
const { tryAutoSendBookingConfirmation } = require('./lib/luna-guest-confirmation-auto-send');
const { runGuestConfirmationPreviewDryRun } = require('./lib/luna-guest-confirmation-preview-dry-run');
const { CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE } = require('./lib/luna-staff-inbox-thread-message');

const BOOKING = '11111111-1111-1111-1111-111111111111';
const CONVERSATION = '22222222-2222-2222-2222-222222222222';
const CLIENT = '33333333-3333-3333-3333-333333333333';
const PHONE = '+9990000001';
const ENV = {
  NODE_ENV: 'staging', LUNA_DEPLOYMENT: 'sunset-staging', DEFAULT_CLIENT_SLUG: 'sunset',
  LUNA_AUTO_SEND_ENABLED: 'false', WHATSAPP_DRY_RUN: 'false',
};

function makeAlreadyPaidPendingPg() {
  let bookingStatus = 'payment_pending';
  const calls = [];
  return {
    calls,
    get bookingStatus() { return bookingStatus; },
    async query(sql, params = []) {
      calls.push({ sql, params });
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (flat.includes('FROM bookings') && flat.endsWith('FOR UPDATE')) {
        return { rows: [{ booking_id: BOOKING, booking_status: bookingStatus,
          hold_expires_at: null, hold_expired_by_db: false, bk_total: 14000,
          bk_amount_paid: 14000, bk_balance: 0, bk_deposit: 14000 }] };
      }
      if (flat.includes('FROM payments') && flat.endsWith('FOR UPDATE')) {
        return { rows: [{ payment_id: '44444444-4444-4444-4444-444444444444',
          booking_id: BOOKING, client_id: CLIENT, payment_status: 'paid',
          payment_kind: 'full', amount_due_cents: 14000, amount_paid_cents: 14000,
          currency: 'EUR', stripe_checkout_session_id: 'cs_sunset_paid' }] };
      }
      if (flat.startsWith('UPDATE bookings') && flat.includes("status = 'confirmed'::booking_status")) {
        assert.deepEqual(params, [BOOKING, CLIENT]);
        if (bookingStatus === 'payment_pending') bookingStatus = 'confirmed';
        return { rowCount: 1, rows: [{ booking_status: bookingStatus }] };
      }
      throw new Error(`unexpected already-paid SQL: ${flat}`);
    },
  };
}

function makeProductionShapedPg({ simulator = true, failInsertOnce = false, failTimestampOnce = false,
  durablePhone = PHONE, columnPhone = null, simulatorRows = null } = {}) {
  const messages = [];
  const calls = [];
  let confirmationSentAt = null;
  return {
    calls,
    messages,
    get confirmationSentAt() { return confirmationSentAt; },
    async query(sql, params = []) {
      calls.push({ sql, params });
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (flat.includes('FROM bookings b INNER JOIN clients c') && flat.includes('confirmation_sent_at')) {
        return { rows: [{ id: BOOKING, booking_code: 'SUN-001', booking_status: 'confirmed',
          payment_status: 'deposit_paid',
          confirmation_sent_at: confirmationSentAt, guest_phone_meta: durablePhone,
          guest_phone_column: columnPhone, guest_name_meta: 'Sim Guest' }] };
      }
      if (flat.includes('LEFT JOIN LATERAL') && flat.includes('FROM payments')) {
        return { rows: [{ amount_paid_cents: 10000, payment_record_status: 'paid',
          booking_payment_status: 'deposit_paid' }] };
      }
      if (flat.includes('FROM conversations conv') && flat.includes("metadata->>'simulator_synthetic' = 'true'")) {
        const candidates = params[1];
        const available = simulatorRows || [{ conversation_id: CONVERSATION, phone: durablePhone,
          location_id: 'sunset-somo', simulator_source_phone: '+346****1222' }];
        const rows = simulator && Array.isArray(candidates)
          ? available.filter((row) => candidates.includes(row.phone)) : [];
        return { rows };
      }
      if (flat === 'SELECT id FROM clients WHERE slug = $1 LIMIT 1') return { rows: [{ id: CLIENT }] };
      if (flat.includes('FROM conversations WHERE client_id = $1 AND phone = $2')) {
        return { rows: [{ conversation_id: CONVERSATION }] };
      }
      if (flat.startsWith('INSERT INTO conversations')) return { rows: [{ conversation_id: CONVERSATION }] };
      if (flat.includes('INSERT INTO customers') || flat.includes('UPDATE customers')
        || flat.includes('SELECT id') && flat.includes('FROM customers')) return { rows: [] };
      if (flat.includes('lower(btrim(COALESCE') && flat.includes('FROM clients c')) {
        return { rows: [{ client_id: CLIENT, whatsapp_mode: 'auto' }] };
      }
      if (flat.startsWith('SELECT pg_advisory_')) return { rows: [{}] };
      if (flat.includes('FROM messages m') && flat.includes("metadata->>'idempotency_key'")) {
        const found = messages.find((m) => m.idempotency_key === params[2]);
        return { rows: found ? [{ message_id: found.id, source: found.source,
          direction: 'outbound', whatsapp_message_id: null }] : [] };
      }
      if (flat.includes('FROM conversations conv') && flat.includes('c.slug = $1 AND conv.id = $2::uuid')) {
        return { rows: [{ id: CONVERSATION, client_id: CLIENT }] };
      }
      if (flat.startsWith('INSERT INTO messages')) {
        if (failInsertOnce) {
          failInsertOnce = false;
          throw new Error('injected post-commit Inbox failure');
        }
        const metadata = JSON.parse(params[4]);
        const row = { id: `m-${messages.length + 1}`, source: params[3],
          idempotency_key: metadata.idempotency_key, whatsapp_message_id: null };
        messages.push(row);
        return { rows: [{ message_id: row.id, source: row.source, direction: 'outbound' }], rowCount: 1 };
      }
      if (flat.startsWith('UPDATE bookings b') && flat.includes('confirmation_sent_at = NOW()')) {
        assert.equal(messages.length, 1, 'timestamp can only be written after Inbox persistence');
        if (failTimestampOnce) {
          failTimestampOnce = false;
          throw new Error('injected post-Inbox timestamp failure');
        }
        confirmationSentAt = confirmationSentAt || '2026-09-18T12:00:00Z';
        return { rows: [{ confirmation_sent_at: confirmationSentAt }], rowCount: 1 };
      }
      if (flat.includes('SELECT b.confirmation_sent_at') || flat.includes('SELECT confirmation_sent_at')) {
        return { rows: confirmationSentAt ? [{ confirmation_sent_at: confirmationSentAt }] : [] };
      }
      throw new Error(`unexpected SQL: ${flat}`);
    },
  };
}

async function attempt(pg, overrides = {}, env = ENV, sendCounter = { count: 0 }, contextOverrides = {}) {
  return tryAutoSendBookingConfirmation({
    booking_id: BOOKING, booking_code: 'SUN-001', to: PHONE, client_slug: 'sunset',
    idempotency_key: 'confirmation:auto:webhook:SUN-001:evt_1', ...overrides,
  }, {
    pg, env,
    runGuestConfirmationPreviewDryRun: async () => ({ confirmation_preview_ready: true,
      message_preview: 'Payment received — SUN-001 is confirmed.' }),
    sendMessage: async () => { sendCounter.count += 1; throw new Error('provider forbidden'); },
    ...contextOverrides,
  });
}

(async () => {
  const paid = { newBkPayStatus: 'deposit_paid' };
  assert.equal(decideStripeHoldPromote({ booking_status: 'payment_pending' }, paid).promote_to_confirmed, false);
  assert.equal(decideStripeHoldPromote({ booking_status: 'payment_pending' }, paid,
    { sunset_staging: true }).promote_to_confirmed, true);
  assert.equal(decideStripeHoldPromote({ booking_status: 'hold', hold_expired_by_db: false }, paid)
    .promote_to_confirmed, true, 'existing hold behavior remains unchanged');

  // Live-shaped Sunset state: paid row, €140, course booking still payment_pending.
  const paidPendingPg = makeAlreadyPaidPendingPg();
  const truthInput = {
    pm: { payment_id: '44444444-4444-4444-4444-444444444444', booking_id: BOOKING,
      client_id: CLIENT, client_slug: 'sunset' },
    session: { id: 'cs_sunset_paid', amount_total: 14000, currency: 'eur',
      metadata: { payment_id: '44444444-4444-4444-4444-444444444444' } },
    stripePaidCents: 14000,
    env: ENV,
  };
  const paidPending = await applyStripeBookingPaymentTruthWrites(paidPendingPg, truthInput);
  assert.equal(paidPending.already_paid, true);
  assert.equal(paidPending.decision.promote_to_confirmed, true);
  assert.equal(paidPendingPg.bookingStatus, 'confirmed');
  const exactRetry = await applyStripeBookingPaymentTruthWrites(paidPendingPg, truthInput);
  assert.equal(exactRetry.decision.promote_to_confirmed, false, 'exact retry is idempotent');

  for (const [label, scopedInput] of [
    ['Wolfhouse', { ...truthInput, pm: { ...truthInput.pm, client_slug: 'wolfhouse-somo' } }],
    ['production', { ...truthInput, env: { ...ENV, NODE_ENV: 'production' } }],
  ]) {
    const protectedPg = makeAlreadyPaidPendingPg();
    const protectedResult = await applyStripeBookingPaymentTruthWrites(protectedPg, scopedInput);
    assert.equal(protectedResult.decision.promote_to_confirmed, false, `${label} remains protected`);
    assert.equal(protectedPg.bookingStatus, 'payment_pending', `${label} status is preserved`);
  }

  const noRoomDraft = { booking_code: 'SUNSET-20260918-2283C6', payment_status: 'paid',
    amount_paid_cents: 14000, balance_due_cents: 0, room_number: null,
    gate_code: null, address: null,
    proposed_confirmation_message: 'Your Sunset surf course is confirmed.' };
  const trustedNoRoom = await runGuestConfirmationPreviewDryRun({
    client_slug: 'sunset', booking_code: noRoomDraft.booking_code, payment_status: 'paid',
    confirmation_draft: noRoomDraft,
  }, { use_fixture_pg: true, trusted_crowsnest_sunset_course: true });
  assert.equal(trustedNoRoom.confirmation_preview_ready, true);
  assert.equal(trustedNoRoom.room_label, null);
  assert.equal(trustedNoRoom.gate_code, null);
  const ordinaryNoRoom = await runGuestConfirmationPreviewDryRun({
    client_slug: 'wolfhouse-somo', booking_code: 'WH-NO-ROOM', payment_status: 'paid',
    confirmation_draft: { ...noRoomDraft, booking_code: 'WH-NO-ROOM' },
  }, { use_fixture_pg: true });
  assert.deepEqual(ordinaryNoRoom.block_reasons, ['missing_room_number_or_label']);

  const pg = makeProductionShapedPg();
  const sends = { count: 0 };
  const first = await attempt(pg, {}, ENV, sends);
  assert.equal(first.confirmation_sent, true);
  assert.equal(first.synthetic_inbox_persisted, true);
  assert.equal(first.synthetic_inbox.thread.source, CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE);
  assert.equal(pg.messages.length, 1);
  assert.equal(pg.messages[0].whatsapp_message_id, null, 'synthetic persistence needs no provider ID');
  assert.equal(sends.count, 0, 'provider never called');
  assert.ok(pg.confirmationSentAt, 'timestamp set after persistence');

  // Public projection deliberately points at another trusted conversation. It
  // must not compete with the durable booking identity or receive the bubble.
  const durablePhone = '+999****5143';
  const projectedPhone = '+999****0000';
  const unrelatedConversation = '55555555-5555-5555-5555-555555555555';
  const publicPathPg = makeProductionShapedPg({ durablePhone, simulatorRows: [
    { conversation_id: unrelatedConversation, phone: projectedPhone,
      location_id: 'sunset-somo', simulator_source_phone: '+346****9999' },
    { conversation_id: CONVERSATION, phone: durablePhone,
      location_id: 'sunset-somo', simulator_source_phone: '+346****1222' },
  ] });
  const publicPath = await attempt(publicPathPg, { to: projectedPhone }, ENV, sends);
  assert.equal(publicPath.confirmation_sent, true);
  assert.equal(publicPath.skip_reason, null);
  const trustLookup = publicPathPg.calls.find(({ sql }) => sql.includes('FROM conversations conv')
    && sql.includes("metadata->>'simulator_synthetic' = 'true'"));
  assert.deepEqual(trustLookup.params[1], [durablePhone]);
  assert.equal(trustLookup.sql.includes('LIMIT 1'), false, 'trusted lookup must inspect every match');
  assert.equal(publicPathPg.messages.length, 1);
  assert.equal(sends.count, 0, 'public reconciliation remains provider-free');

  // Conflicting durable metadata/column identities resolving to different
  // trusted conversations fail closed, independent of result ordering.
  const columnPhone = '+999****7777';
  const conflictingPg = makeProductionShapedPg({ durablePhone, columnPhone, simulatorRows: [
    { conversation_id: CONVERSATION, phone: durablePhone, location_id: 'sunset-somo' },
    { conversation_id: unrelatedConversation, phone: columnPhone, location_id: 'sunset-somo' },
  ] });
  const conflicting = await attempt(conflictingPg, { to: projectedPhone }, ENV, sends,
    { simulatorReconciliationOnly: true });
  assert.equal(conflicting.skip_reason, 'not_trusted_sunset_simulator');
  assert.equal(conflictingPg.messages.length, 0);

  // Duplicate query rows are acceptable only when all rows identify the same
  // conversation; distinct conversation IDs for one durable phone are not.
  const duplicateDistinctPg = makeProductionShapedPg({ durablePhone, simulatorRows: [
    { conversation_id: CONVERSATION, phone: durablePhone, location_id: 'sunset-somo' },
    { conversation_id: unrelatedConversation, phone: durablePhone, location_id: 'sunset-somo' },
  ] });
  const duplicateDistinct = await attempt(duplicateDistinctPg, {}, ENV, sends,
    { simulatorReconciliationOnly: true });
  assert.equal(duplicateDistinct.skip_reason, 'not_trusted_sunset_simulator');
  assert.equal(duplicateDistinctPg.messages.length, 0);

  const duplicateSamePg = makeProductionShapedPg({ durablePhone, simulatorRows: [
    { conversation_id: CONVERSATION, phone: durablePhone, location_id: 'sunset-somo' },
    { conversation_id: CONVERSATION, phone: durablePhone, location_id: 'sunset-somo' },
  ] });
  const duplicateSame = await attempt(duplicateSamePg, {}, ENV, sends);
  assert.equal(duplicateSame.confirmation_sent, true);
  assert.equal(duplicateSamePg.messages.length, 1);

  // Exercise the real mirror/persistence owner again: idempotency finds the same bubble.
  const replayPg = makeProductionShapedPg();
  replayPg.messages.push(pg.messages[0]);
  const replay = await attempt(replayPg, {}, ENV, sends);
  assert.equal(replay.synthetic_inbox.thread.duplicate, true);
  assert.equal(replayPg.messages.length, 1);
  assert.equal(sends.count, 0);

  // A committed payment whose post-commit Inbox write failed converges on retry.
  const insertFailurePg = makeProductionShapedPg({ failInsertOnce: true });
  await assert.rejects(attempt(insertFailurePg, {}, ENV, sends), /post-commit Inbox failure/);
  const insertRecovery = await attempt(insertFailurePg, {}, ENV, sends);
  assert.equal(insertRecovery.confirmation_sent, true);
  assert.equal(insertFailurePg.messages.length, 1);
  assert.ok(insertFailurePg.confirmationSentAt);

  // If the bubble committed but timestamping failed, retry finds that same bubble
  // and completes confirmation_sent_at without a provider call or second message.
  const timestampFailurePg = makeProductionShapedPg({ failTimestampOnce: true });
  await assert.rejects(attempt(timestampFailurePg, {}, ENV, sends), /post-Inbox timestamp failure/);
  assert.equal(timestampFailurePg.messages.length, 1);
  assert.equal(timestampFailurePg.confirmationSentAt, null);
  const timestampRecovery = await attempt(timestampFailurePg, {}, ENV, sends);
  assert.equal(timestampRecovery.synthetic_inbox.thread.duplicate, true);
  assert.equal(timestampFailurePg.messages.length, 1);
  assert.ok(timestampFailurePg.confirmationSentAt);
  assert.equal(sends.count, 0);

  const webhookSource = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');
  assert.ok(webhookSource.includes('if (bookingDuplicateClaim) {\n    await reconcileSimulatorConfirmation();'));
  assert.ok(webhookSource.includes('if (paymentTruthResult && paymentTruthResult.already_paid) {\n    const confirmationReconciliation = await reconcileSimulatorConfirmation();'));
  assert.ok(webhookSource.includes('confirmation:auto:webhook:${pm.booking_code}:${pm.payment_id}'));

  const ordinary = await attempt(makeProductionShapedPg({ simulator: false }));
  assert.equal(ordinary.skip_reason, 'luna_auto_send_not_enabled');
  const wrongTenant = await attempt(makeProductionShapedPg(), { client_slug: 'wolfhouse-somo' });
  assert.equal(wrongTenant.skip_reason, 'luna_auto_send_not_enabled');
  const production = await attempt(makeProductionShapedPg(), {}, { ...ENV, NODE_ENV: 'production' });
  assert.equal(production.skip_reason, 'luna_auto_send_not_enabled');
  for (const nodeEnv of [undefined, '', '   ', ' production ', 'development', 'test']) {
    const env = { ...ENV };
    if (nodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = nodeEnv;
    const rejected = await attempt(makeProductionShapedPg(), {}, env);
    assert.equal(rejected.skip_reason, 'luna_auto_send_not_enabled',
      `NODE_ENV=${JSON.stringify(nodeEnv)} must fail closed`);
  }

  console.log('PASS verify-post-pay-confirm-status-001');
})().catch((err) => { console.error(err.stack || err); process.exit(1); });
