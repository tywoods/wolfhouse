#!/usr/bin/env node
'use strict';

/**
 * Staff handoff persist must return the real pause row and store Skip's
 * concrete cause + booking reference — not a generic reason plus phone.
 */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { markConversationNeedsHuman } = require('./lib/luna-guest-handoff-persist');

const ROOT = path.join(__dirname, '..');
const CONV_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const persistSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/luna-guest-handoff-persist.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

function makePg(opts) {
  const existing = opts && opts.existingPause;
  const calls = { updates: [], inserts: [], pauseInserts: [] };
  return {
    calls,
    query: async (sql, params) => {
      const s = String(sql);
      if (/SELECT[\s\S]*needs_human[\s\S]*FROM conversations/i.test(s)
        && /JOIN clients/i.test(s) && !/UPDATE/i.test(s) && !/bot_pause_states/i.test(s)) {
        return {
          rows: [{
            id: CONV_ID,
            conversation_id: CONV_ID,
            needs_human: false,
            phone: '+4912345679289',
            display_name: 'Kathi',
            metadata: {},
          }],
        };
      }
      if (/UPDATE conversations[\s\S]*needs_human\s*=\s*TRUE/i.test(s)) {
        calls.updates.push({ sql: s, params: params ? [...params] : [] });
        return { rows: [{ conversation_id: CONV_ID, needs_human: true }] };
      }
      if (/FROM staff_handoffs/i.test(s) && /SELECT/i.test(s)) return { rows: [] };
      if (/INSERT INTO staff_handoffs/i.test(s)) {
        calls.inserts.push({ sql: s, params: params ? [...params] : [] });
        return { rows: [{ id: 'handoff-1', reason_code: params[3], status: 'open' }] };
      }
      if (/INSERT INTO bot_pause_states/i.test(s)) {
        calls.pauseInserts.push({ params: params ? [...params] : [] });
        return {
          rows: [{
            id: 'pause-created-1',
            client_slug: params[0],
            guest_phone: params[1],
            conversation_id: params[2],
            booking_id: params[3],
            booking_code: params[4],
            paused: true,
            pause_reason: params[5],
            paused_by: params[6],
            paused_at: new Date().toISOString(),
          }],
        };
      }
      if (/FROM bot_pause_states/i.test(s)) {
        return { rows: existing ? [existing] : [] };
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
    reason: 'saved_booking_confirmation_blocked:confirmation_delivery_blocked',
    booking_code: 'WH-20270310-13389959',
    booking_id: 'booking-uuid-1',
  }, { skip_notify: true });

  const ps = created.pause_state || {};
  assert.equal(ps.id, 'pause-created-1', 'pause row id');
  assert.equal(ps.conversation_id, CONV_ID);
  assert.equal(ps.paused_by, 'luna_flag_needs_human');
  assert.match(String(ps.pause_reason || ''), /saved_booking_confirmation_blocked:confirmation_delivery_blocked/);
  assert.equal(ps.created, true, 'this call created the row');
  assert.equal(ps.existing_staff_owned, false);
  assert.equal(ps.idempotent, false);

  const staffPg = makePg({
    existingPause: {
      id: 'pause-staff-9',
      conversation_id: CONV_ID,
      guest_phone: '+4912345679289',
      paused: true,
      pause_reason: 'manual staff pause',
      paused_by: 'staff-anna',
    },
  });
  const existing = await markConversationNeedsHuman(staffPg, {
    conversation_id: CONV_ID,
    client_slug: 'wolfhouse-somo',
    reason: 'human_requested',
  }, { skip_notify: true });
  const es = existing.pause_state || {};
  assert.equal(es.id, 'pause-staff-9');
  assert.equal(es.paused_by, 'staff-anna');
  assert.equal(es.pause_reason, 'manual staff pause');
  assert.equal(es.created, false, 'did not create a new pause over Staff');
  assert.equal(es.existing_staff_owned, true);
  assert.equal(staffPg.calls.pauseInserts.length, 0, 'must not overwrite Staff-owned pause');

  const updateSql = createdPg.calls.updates[0].sql;
  assert.match(updateSql, /handoff_booking_code/);
  const updateParams = createdPg.calls.updates[0].params;
  assert.ok(updateParams.some((p) => String(p).includes('saved_booking_confirmation_blocked:confirmation_delivery_blocked')));
  assert.ok(updateParams.some((p) => p === 'WH-20270310-13389959'));

  const handoffInsert = createdPg.calls.inserts[0];
  const joined = JSON.stringify(handoffInsert);
  assert.match(joined, /WH-20270310-13389959/);
  assert.match(joined, /saved_booking_confirmation_blocked:confirmation_delivery_blocked/);

  assert.match(persistSrc, /existing_staff_owned/);
  assert.match(persistSrc, /pause_state[\s\S]{0,400}paused_by/);
  const botHandler = apiSrc.slice(
    apiSrc.indexOf('async function handleBotConversationNeedsHuman'),
    apiSrc.indexOf('async function handleBotConversationNeedsHuman') + 2500,
  );
  assert.match(botHandler, /booking_code/);
  assert.match(botHandler, /body\.booking_id|booking_id/);

  console.log('ok staff handoff pause row fields and concrete recovery cause');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
