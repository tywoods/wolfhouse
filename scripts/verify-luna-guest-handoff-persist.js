#!/usr/bin/env node
'use strict';

/**
 * Staff producer for Skip's ordinary handoff:
 * pause_id / created / existing_staff_owned, and record send-failure
 * reason + booking even when already needs-human.
 */
const assert = require('node:assert/strict');
const { markConversationNeedsHuman } = require('../scripts/lib/luna-guest-handoff-persist');

const CONV_ID = '11111111-1111-4111-8111-111111111111';
const REASON = 'whatsapp_send_failed:WH-20270310-13389959';
const BOOKING = 'WH-20270310-13389959';

function makePg(opts) {
  const existingPause = opts && opts.existingPause;
  const alreadyNeedsHuman = !!(opts && opts.alreadyNeedsHuman);
  const existingHandoff = opts && opts.existingHandoff;
  const openHandoffs = (opts && opts.openHandoffs) || (existingHandoff ? [existingHandoff] : []);
  const handoffWriteFail = !!(opts && opts.handoffWriteFail);
  const calls = { updates: [], inserts: [], pauseInserts: [], handoffUpdates: [], pauseClaims: [] };
  return {
    calls,
    query: async (sql, params) => {
      const s = String(sql);
      if (/SELECT[\s\S]*FROM conversations/i.test(s) && /JOIN clients/i.test(s) && !/UPDATE/i.test(s) && !/bot_pause_states/i.test(s) && !/staff_handoffs/i.test(s)) {
        return {
          rows: [{
            conversation_id: CONV_ID,
            needs_human: alreadyNeedsHuman,
            phone: '+491****9289',
            display_name: 'Kathi',
            metadata: alreadyNeedsHuman
              ? { needs_human_reason: 'human_requested', luna_handoff_reason: 'human_requested' }
              : {},
          }],
        };
      }
      if (/UPDATE conversations[\s\S]*needs_human\s*=\s*TRUE/i.test(s)) {
        if (alreadyNeedsHuman && /needs_human = FALSE/.test(s)) {
          return { rows: [] };
        }
        calls.updates.push({ sql: s, params: params ? [...params] : [] });
        return {
          rows: [{
            conversation_id: CONV_ID,
            needs_human: true,
            phone: '+491****9289',
            display_name: 'Kathi',
            metadata: {
              needs_human_reason: params[2],
              luna_handoff_reason: params[2],
              handoff_booking_code: params[4] || null,
            },
          }],
        };
      }
      if (/UPDATE bot_pause_states/i.test(s)) {
        calls.pauseClaims.push({ sql: s, params: params ? [...params] : [] });
        return {
          rows: [{
            id: existingPause && existingPause.id,
            conversation_id: CONV_ID,
            guest_phone: existingPause && existingPause.guest_phone,
            paused: true,
            pause_reason: params[1],
            paused_by: params[2],
          }],
        };
      }
      if (/FROM bot_pause_states/i.test(s) && /SELECT/i.test(s) && !/INSERT/i.test(s)) {
        return { rows: existingPause ? [existingPause] : [] };
      }
      if (/INSERT INTO bot_pause_states/i.test(s)) {
        calls.pauseInserts.push({ sql: s, params: params ? [...params] : [] });
        return {
          rows: [{
            id: 'pause-created-1',
            conversation_id: CONV_ID,
            guest_phone: params[1] || null,
            paused: true,
            pause_reason: params[5],
            paused_by: params[6] || 'luna_flag_needs_human',
          }],
        };
      }
      if (/UPDATE staff_handoffs/i.test(s)) {
        if (handoffWriteFail) {
          const err = new Error('staff_handoffs write failed');
          err.code = '23505';
          throw err;
        }
        const targetId = params[1];
        const newReason = params[2];
        const others = openHandoffs.filter((h) => h.id !== targetId);
        if (others.some((h) => h.reason_code === newReason)) {
          const err = new Error('duplicate key value violates unique constraint "uq_staff_handoffs_conv_reason_open"');
          err.code = '23505';
          throw err;
        }
        calls.handoffUpdates.push({ sql: s, params: params ? [...params] : [] });
        return { rows: [{ id: targetId || (existingHandoff && existingHandoff.id) || 'handoff-1', reason_code: newReason, status: 'open' }] };
      }
      if (/FROM staff_handoffs/i.test(s) && /SELECT/i.test(s)) {
        return { rows: openHandoffs.slice() };
      }
      if (/INSERT INTO staff_handoffs/i.test(s)) {
        if (handoffWriteFail) {
          const err = new Error('staff_handoffs write failed');
          err.code = '23505';
          throw err;
        }
        calls.inserts.push({ sql: s, params: params ? [...params] : [] });
        return { rows: [{ id: 'handoff-1', reason_code: params[3], status: 'open' }] };
      }
      return { rows: [] };
    },
  };
}

async function main() {
  const createdPg = makePg();
  const created = await markConversationNeedsHuman(createdPg, {
    conversation_id: CONV_ID,
    client_slug: 'wolfhouse-somo',
    reason: REASON,
    booking_code: BOOKING,
  }, { skip_notify: true });

  assert.equal(created.pause_id, 'pause-created-1');
  assert.equal(created.created, true);
  assert.equal(created.existing_staff_owned, false);
  assert.equal(created.pause_state && created.pause_state.id, 'pause-created-1');
  assert.equal(created.pause_state.created, true);
  assert.equal(created.pause_state.existing_staff_owned, false);
  assert.equal(created.pause_state.paused_by, 'luna_flag_needs_human');
  assert.match(String(created.pause_state.pause_reason || ''), /whatsapp_send_failed/);
  assert.equal(created.handoff_reason, REASON);

  const staffPg = makePg({
    existingPause: {
      id: 'pause-staff-9',
      conversation_id: CONV_ID,
      guest_phone: '+491****9289',
      paused: true,
      pause_reason: 'manual staff pause',
      paused_by: 'staff-anna',
    },
  });
  const existing = await markConversationNeedsHuman(staffPg, {
    conversation_id: CONV_ID,
    client_slug: 'wolfhouse-somo',
    reason: REASON,
    booking_code: BOOKING,
  }, { skip_notify: true });
  assert.equal(existing.pause_id, 'pause-staff-9');
  assert.equal(existing.created, false);
  assert.equal(existing.existing_staff_owned, true);
  assert.equal(existing.pause_state.existing_staff_owned, true);
  assert.equal(staffPg.calls.pauseInserts.length, 0, 'staff-owned pause stays blocking');

  const flaggedPg = makePg({
    alreadyNeedsHuman: true,
    existingHandoff: { id: 'handoff-old', reason_code: 'human_requested', status: 'open' },
  });
  const flagged = await markConversationNeedsHuman(flaggedPg, {
    conversation_id: CONV_ID,
    client_slug: 'wolfhouse-somo',
    reason: REASON,
    booking_code: BOOKING,
  }, { skip_notify: true });
  assert.ok(flaggedPg.calls.updates.length >= 1, 'already-flagged chat still records send-failure');
  assert.ok(flaggedPg.calls.updates[0].params.some((p) => String(p).includes(REASON)));
  assert.ok(flaggedPg.calls.updates[0].params.some((p) => p === BOOKING));
  assert.equal(flaggedPg.calls.handoffUpdates.length, 1);
  assert.match(JSON.stringify(flaggedPg.calls.handoffUpdates[0]), /WH-20270310-13389959/);
  assert.equal(flagged.handoff_reason, REASON, 'echo stored reason, not a stale requested leftover');

  const collidePg = makePg({
    openHandoffs: [
      { id: 'handoff-newest', reason_code: 'human_requested', status: 'open' },
      { id: 'handoff-match', reason_code: REASON, status: 'open' },
    ],
  });
  const reused = await markConversationNeedsHuman(collidePg, {
    conversation_id: CONV_ID,
    client_slug: 'wolfhouse-somo',
    reason: REASON,
    booking_code: BOOKING,
  }, { skip_notify: true });
  assert.equal(reused.ok, true);
  assert.equal(reused.staff_handoff && reused.staff_handoff.id, 'handoff-match');
  assert.equal(collidePg.calls.handoffUpdates.length, 1);
  assert.equal(collidePg.calls.handoffUpdates[0].params[1], 'handoff-match');

  const failPg = makePg({ handoffWriteFail: true });
  const failed = await markConversationNeedsHuman(failPg, {
    conversation_id: CONV_ID,
    client_slug: 'wolfhouse-somo',
    reason: REASON,
    booking_code: BOOKING,
  }, { skip_notify: true });
  assert.equal(failed.ok, false, 'handoff write miss must not fake success');
  assert.equal(failed.staff_handoff && failed.staff_handoff.error, 'staff_handoffs_upsert_failed');

  const claimPg = makePg({
    existingPause: {
      id: 'pause-luna-1',
      conversation_id: CONV_ID,
      guest_phone: '+491****9289',
      paused: true,
      pause_reason: 'needs_human:old',
      paused_by: 'luna_flag_needs_human',
    },
  });
  const claimed = await markConversationNeedsHuman(claimPg, {
    conversation_id: CONV_ID,
    client_slug: 'wolfhouse-somo',
    reason: REASON,
  }, { skip_notify: true, paused_by: 'staff-anna' });
  assert.equal(claimed.created, false, 'staff takeover of a Luna pause is not created');
  assert.equal(claimed.pause_state && claimed.pause_state.created, false);
  assert.equal(claimPg.calls.pauseInserts.length, 0);
  assert.equal(claimPg.calls.pauseClaims.length, 1);

  console.log('ok persist pause identity and already-flagged send-failure record');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
