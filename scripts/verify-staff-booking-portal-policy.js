'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveWolfhouseAutomaticBookingAdmission,
  SQL_WOLFHOUSE_AUTOMATIC_BOOKING_ADMISSION,
} = require('./lib/staff-booking-portal-policy');
const { pauseConversation } = require('./lib/staff-bot-pause-sql');

const root = path.resolve(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'scripts/lib/luna-front-desk-accommodation-booking-create-service.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'scripts/lib/staff-bot-v2-routes.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
const plugin = fs.readFileSync(path.join(root, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'), 'utf8');

function pgRow(row) {
  let locked = false;
  return { query: async (sql) => {
    if (/^LOCK TABLE bot_pause_states IN SHARE MODE$/.test(sql)) {
      locked = true;
      return { rows: [] };
    }
    assert.equal(locked, true, 'pause policy table must be locked before final admission read');
    assert.equal(sql, SQL_WOLFHOUSE_AUTOMATIC_BOOKING_ADMISSION);
    return { rows: row ? [row] : [] };
  } };
}
const base = {
  client_id: 'client-1', whatsapp_mode: 'auto', conversation_id: 'conversation-1',
  match_count: 1, needs_human: false, global_paused: false, conversation_paused: false,
  simulator_synthetic: false, luna_handoff_paused: false, staff_conversation_paused: false,
};

function pauseStatePg() {
  let pause = null;
  return {
    async query(sql, params) {
      if (/SELECT conv\.phone/.test(sql)) return { rows: [{ phone: '+999****0001' }] };
      if (/SELECT[\s\S]*FROM bot_pause_states/.test(sql) && !/INSERT|UPDATE/.test(sql)) {
        return { rows: pause ? [{ ...pause }] : [] };
      }
      if (/INSERT INTO bot_pause_states/.test(sql)) {
        pause = { id: '11111111-1111-4111-8111-111111111111',
          client_slug: params[0], guest_phone: params[1],
          conversation_id: params[2], paused: true, pause_reason: params[5],
          paused_by: params[6] };
        return { rows: [{ ...pause }] };
      }
      if (/UPDATE bot_pause_states/.test(sql)) {
        pause = { ...pause, pause_reason: params[1], paused_by: params[2] };
        return { rows: [{ ...pause }] };
      }
      throw new Error(`unexpected pause SQL: ${sql}`);
    },
    row() { return pause && { ...pause }; },
  };
}

function pauseInsertRacePg(scope) {
  let pause = null;
  let selectCount = 0;
  return {
    async query(sql, params) {
      if (/SELECT conv\.phone/.test(sql)) return { rows: [{ phone: '+999****0001' }] };
      if (/SELECT[\s\S]*FROM bot_pause_states/.test(sql) && !/INSERT|UPDATE/.test(sql)) {
        if (params && params[1] === '__luna_global_pause__') return { rows: [] };
        selectCount += 1;
        if (selectCount === 1) return { rows: [] };
        return { rows: pause ? [{ ...pause }] : [] };
      }
      if (/INSERT INTO bot_pause_states/.test(sql)) {
        pause = {
          id: '22222222-2222-4222-8222-222222222222', client_slug: params[0],
          guest_phone: params[1], conversation_id: params[2], paused: true,
          pause_reason: 'Luna handoff', paused_by: 'luna_flag_needs_human',
        };
        const conflict = new Error('duplicate key');
        conflict.code = '23505';
        throw conflict;
      }
      if (/UPDATE bot_pause_states/.test(sql)) {
        pause = { ...pause, pause_reason: params[1], paused_by: params[2] };
        return { rows: [{ ...pause }] };
      }
      throw new Error(`unexpected pause SQL: ${sql}`);
    },
    row() { return pause && { ...pause }; },
  };
}

(async () => {
  const input = { client_slug: 'wolfhouse-somo', guest_phone: '+999100000000001' };
  const allowed = await resolveWolfhouseAutomaticBookingAdmission(pgRow(base), input);
  assert.equal(allowed.allowed, true);
  for (const [name, patch, reason, unavailable] of [
    ['missing mode', { whatsapp_mode: null }, 'booking_channel_unconfigured', true],
    ['invalid mode', { whatsapp_mode: 'maybe' }, 'booking_channel_invalid', true],
    ['draft', { whatsapp_mode: 'draft' }, 'booking_channel_draft', false],
    ['off', { whatsapp_mode: 'off' }, 'booking_channel_off', false],
    ['global pause', { global_paused: true }, 'booking_global_paused', false],
    ['thread pause', { conversation_paused: true }, 'booking_conversation_paused', false],
    ['needs human', { needs_human: true }, 'booking_needs_human', false],
    ['missing binding', { match_count: 0, conversation_id: null }, 'booking_context_unbound', false],
    ['ambiguous binding', { match_count: 2, conversation_id: null }, 'booking_context_unbound', false],
  ]) {
    const got = await resolveWolfhouseAutomaticBookingAdmission(pgRow({ ...base, ...patch }), input);
    assert.equal(got.allowed, false, name);
    assert.equal(got.reason, reason, name);
    assert.equal(got.unavailable, unavailable, name);
  }
  const resumedSimulator = await resolveWolfhouseAutomaticBookingAdmission(pgRow({
    ...base,
    needs_human: true,
    conversation_paused: true,
    simulator_synthetic: true,
    luna_handoff_paused: true,
  }), input);
  assert.equal(resumedSimulator.allowed, true,
    'a durably authenticated synthetic simulator conversation may save after its prior handoff');
  const resumedSimulatorFromPgTextBool = await resolveWolfhouseAutomaticBookingAdmission(pgRow({
    ...base,
    needs_human: true,
    conversation_paused: true,
    simulator_synthetic: 'true',
    luna_handoff_paused: 't',
  }), input);
  assert.equal(resumedSimulatorFromPgTextBool.allowed, true,
    'the authenticated synthetic hold exception survives text-normalized SQL booleans');
  assert.equal((await resolveWolfhouseAutomaticBookingAdmission(pgRow({
    ...base,
    needs_human: true,
    conversation_paused: true,
    simulator_synthetic: false,
  }), { ...input, simulator_synthetic_resume: true })).allowed, false,
  'request metadata cannot bypass a hold on an ordinary conversation');
  assert.equal((await resolveWolfhouseAutomaticBookingAdmission(pgRow({
    ...base,
    needs_human: true,
    conversation_paused: true,
    simulator_synthetic: true,
    luna_handoff_paused: true,
    staff_conversation_paused: true,
  }), input)).reason, 'booking_conversation_paused',
  'a Staff Pause always wins over Luna own-handoff recovery in the simulator');
  assert.equal((await resolveWolfhouseAutomaticBookingAdmission(pgRow({
    ...base,
    needs_human: true,
    conversation_paused: true,
    simulator_synthetic: true,
    luna_handoff_paused: false,
  }), input)).reason, 'booking_conversation_paused',
  'a simulator cannot bypass a pause that was not created by Luna handoff');
  assert.equal((await resolveWolfhouseAutomaticBookingAdmission(pgRow({
    ...base,
    needs_human: true,
    conversation_paused: true,
    simulator_synthetic: true,
    global_paused: true,
  }), input)).allowed, false,
  'tenant-global Pause remains authoritative for simulator turns');

  const pausePg = pauseStatePg();
  const pauseInput = { client_slug: 'wolfhouse-somo', conversation_id: 'conversation-1' };
  await pauseConversation(pausePg, {
    ...pauseInput, paused_by: 'luna_flag_needs_human', pause_reason: 'Luna handoff',
  });
  const pureLunaPause = pausePg.row();
  assert.equal((await resolveWolfhouseAutomaticBookingAdmission(pgRow({
    ...base, needs_human: true, conversation_paused: true,
    simulator_synthetic: true,
    luna_handoff_paused: pureLunaPause.paused_by === 'luna_flag_needs_human',
    staff_conversation_paused: pureLunaPause.paused_by !== 'luna_flag_needs_human',
  }), input)).allowed, true, 'trusted simulator bypass applies to a pure Luna handoff pause');
  await pauseConversation(pausePg, {
    ...pauseInput, paused_by: 'staff', pause_reason: 'Staff Pause',
  });
  const staffPause = pausePg.row();
  assert.equal(staffPause.paused_by, 'staff', 'Staff Pause takes ownership from Luna handoff');
  const afterStaffPause = await resolveWolfhouseAutomaticBookingAdmission(pgRow({
    ...base, needs_human: true, conversation_paused: true,
    simulator_synthetic: true,
    luna_handoff_paused: staffPause.paused_by === 'luna_flag_needs_human',
    staff_conversation_paused: staffPause.paused_by !== 'luna_flag_needs_human',
  }), input);
  assert.equal(afterStaffPause.allowed, false, 'Staff Pause blocks booking after Luna handoff');
  assert.equal(afterStaffPause.reason, 'booking_conversation_paused');

  for (const scope of ['conversation', 'phone']) {
    const racePg = pauseInsertRacePg(scope);
    const racedInput = scope === 'conversation'
      ? { client_slug: 'wolfhouse-somo', conversation_id: 'conversation-race' }
      : { client_slug: 'wolfhouse-somo', guest_phone: '+999****0001' };
    const raced = await pauseConversation(racePg, {
      ...racedInput, paused_by: 'staff', pause_reason: 'Staff Pause',
    });
    assert.equal(raced.row.paused_by, 'staff',
      `${scope} conflict recovery must take Staff ownership from Luna handoff`);
    assert.equal(raced.idempotent, false,
      `${scope} conflict recovery ownership transfer is not idempotent`);
    const durable = racePg.row();
    const admission = await resolveWolfhouseAutomaticBookingAdmission(pgRow({
      ...base, needs_human: true, conversation_paused: true,
      simulator_synthetic: true,
      luna_handoff_paused: durable.paused_by === 'luna_flag_needs_human',
      staff_conversation_paused: durable.paused_by !== 'luna_flag_needs_human',
    }), input);
    assert.equal(admission.allowed, false,
      `${scope} Staff Pause conflict recovery must block booking`);
    assert.equal(admission.reason, 'booking_conversation_paused');
  }

  const failed = await resolveWolfhouseAutomaticBookingAdmission({ query: async () => { throw Error('db'); } }, input);
  assert.equal(failed.reason, 'booking_policy_unavailable');
  assert.equal(failed.unavailable, true);

  process.env.BOT_BOOKING_ENABLED = 'false';
  assert.equal((await resolveWolfhouseAutomaticBookingAdmission(pgRow(base), input)).allowed, true);
  process.env.BOT_BOOKING_ENABLED = 'true';
  assert.equal((await resolveWolfhouseAutomaticBookingAdmission(pgRow({ ...base, whatsapp_mode: 'off' }), input)).allowed, false);

  assert.match(service, /BEGIN[\s\S]*authorizeAutomaticBooking[\s\S]*ROLLBACK/);
  assert.match(SQL_WOLFHOUSE_AUTOMATIC_BOOKING_ADMISSION, /FOR SHARE/);
  assert.match(SQL_WOLFHOUSE_AUTOMATIC_BOOKING_ADMISSION, /paused_by='luna_flag_needs_human'/);
  assert.match(SQL_WOLFHOUSE_AUTOMATIC_BOOKING_ADMISSION, /FOR UPDATE|FOR SHARE/);
  assert.match(api, /authorizeAutomaticBooking:[\s\S]*resolveWolfhouseAutomaticBookingAdmission/);
  assert.doesNotMatch(routes.slice(routes.indexOf('async function handleBotBookingCreateFromPlan'), routes.indexOf('async function handleBotBookingCreateFromPlan') + 1200), /BOT_BOOKING_ENABLED/);
  assert.match(routes, /makeInMemoryBotReq\(bodyObj, headers/);
  assert.match(routes, /makeInMemoryBotReq\(body,\s*req\.headers\)/);
  const lower = api.slice(api.indexOf('async function handleBotBookingCreate('), api.indexOf('async function handleManualBookingCreate('));
  assert.doesNotMatch(lower, /BOT_BOOKING_ENABLED/);
  assert.match(plugin, /["']X-Luna-Guest-Phone["']\s*:\s*_session_guest_phone\(\)/);
  assert.match(lower, /authMode\s*===\s*['"]bot_token['"][\s\S]{0,500}x-luna-guest-phone/);
  assert.match(lower, /guest_phone:\s*trustedGuestPhone/);
  console.log('verify-staff-booking-portal-policy PASS');
})().catch((err) => { console.error(err); process.exit(1); });
