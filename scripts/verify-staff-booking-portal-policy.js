'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveWolfhouseAutomaticBookingAdmission,
  SQL_WOLFHOUSE_AUTOMATIC_BOOKING_ADMISSION,
} = require('./lib/staff-booking-portal-policy');

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
  simulator_synthetic: false,
};

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
  }), input);
  assert.equal(resumedSimulator.allowed, true,
    'a durably authenticated synthetic simulator conversation may save after its prior handoff');
  const resumedSimulatorFromPgTextBool = await resolveWolfhouseAutomaticBookingAdmission(pgRow({
    ...base,
    needs_human: true,
    conversation_paused: true,
    simulator_synthetic: 'true',
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
    global_paused: true,
  }), input)).allowed, false,
  'tenant-global Pause remains authoritative for simulator turns');
  const failed = await resolveWolfhouseAutomaticBookingAdmission({ query: async () => { throw Error('db'); } }, input);
  assert.equal(failed.reason, 'booking_policy_unavailable');
  assert.equal(failed.unavailable, true);

  process.env.BOT_BOOKING_ENABLED = 'false';
  assert.equal((await resolveWolfhouseAutomaticBookingAdmission(pgRow(base), input)).allowed, true);
  process.env.BOT_BOOKING_ENABLED = 'true';
  assert.equal((await resolveWolfhouseAutomaticBookingAdmission(pgRow({ ...base, whatsapp_mode: 'off' }), input)).allowed, false);

  assert.match(service, /BEGIN[\s\S]*authorizeAutomaticBooking[\s\S]*ROLLBACK/);
  assert.match(SQL_WOLFHOUSE_AUTOMATIC_BOOKING_ADMISSION, /FOR SHARE/);
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
