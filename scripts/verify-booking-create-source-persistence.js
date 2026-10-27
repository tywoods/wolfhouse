'use strict';

/**
 * Regression: authenticated /staff/bot/booking-create-from-plan attribution
 * must survive the ordinary accommodation create SQL write.  This deliberately
 * uses the PGlite real-command/real-INSERT harness rather than Finance-shaped
 * input fixtures.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stampBookingCreateSource } = require('./lib/booking-create-source-attribution');
const { runPayload } = require('./verify-luna-create-booking-occupants');
const {
  handleBotBookingCreateFromPlan,
  makeInMemoryBotReq,
} = require('./lib/staff-bot-v2-routes');

const apiSource = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

const basePayload = {
  confirm: true,
  check_in: '2026-08-03',
  check_out: '2026-08-06',
  guest_count: 1,
  guest_name: 'Attribution Guest',
  guests: [{ name: 'Attribution Guest' }],
  phone: '+999****1448',
  package_code: 'package_none',
  room_type: 'shared',
  selected_bed_codes: ['R3-B1'],
  payment_choice: 'full',
};

async function createAs(authMode, spoofedSource) {
  const payload = stampBookingCreateSource({ ...basePayload, source: spoofedSource }, authMode);
  return runPayload(payload);
}

async function fromPlanRoutePayload(authMode, spoofedSource) {
  let delegatedBody;
  await handleBotBookingCreateFromPlan(
    { body: JSON.stringify({ ...basePayload, source: spoofedSource }), headers: {} },
    { setHeader() {}, end() {} },
    authMode === 'bot_token' ? null : { staff_user_id: 'staff-1' },
    authMode,
    {
      sendJSON: (_res, _status, body) => body,
      send400: (_res, message) => { throw Error(message); },
      readBody: async (req) => req.body,
      appendAuditLog() {},
      makeInMemoryBotReq,
      DEFAULT_CLIENT: 'wolfhouse-somo',
      STAFF_AUTH_REQUIRED: true,
      handleBotBookingCreate: async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk.toString();
        delegatedBody = JSON.parse(raw);
        res.end(JSON.stringify({ success: true, created: true, write_performed: true, booking_id: 'route-test' }));
      },
    },
  );
  return delegatedBody;
}

async function main() {
  const directHandler = apiSource.slice(
    apiSource.indexOf('async function handleBotBookingCreate(req, res, user, authMode) {'),
    apiSource.indexOf('// ─────────────────────────────────────────────────────────────────────────────\n// Route: POST /staff/bookings/create', apiSource.indexOf('async function handleBotBookingCreate(req, res, user, authMode) {')),
  );
  assert.match(directHandler, /body\s*=\s*stampBookingCreateSource\(body,\s*authMode\)/,
    'direct create route must overwrite body.source from authenticated authMode');

  // Direct route is wired to the same authenticated stamp before the real INSERT.
  const luna = await createAs('bot_token', 'staff');
  assert.equal(luna.ok, true, JSON.stringify(luna.body));
  assert.equal(luna.bookings[0].metadata.source, 'luna_guest',
    'bot_token source is persisted by the real INSERT');
  const lunaInsert = luna.sql_calls.find((call) => call.kind === 'booking_create');
  assert.equal(lunaInsert.params[19], 'luna_guest', 'real create SQL receives trusted Luna source');

  const staff = await createAs('staff_portal', 'luna_guest');
  assert.equal(staff.ok, true, JSON.stringify(staff.body));
  assert.equal(staff.bookings[0].metadata.source, 'staff',
    'staff attribution remains staff despite body spoof');
  const staffInsert = staff.sql_calls.find((call) => call.kind === 'booking_create');
  assert.equal(staffInsert.params[19], 'staff', 'real create SQL receives trusted staff source');

  // This exercises the actual from-plan route and persists the body delegated to
  // the shared create handler through the real PGlite INSERT harness.
  const fromPlanLunaPayload = await fromPlanRoutePayload('bot_token', 'staff');
  assert.equal(fromPlanLunaPayload.source, 'luna_guest', 'from-plan route overwrites spoofed source for bot token');
  const fromPlanLuna = await runPayload(fromPlanLunaPayload);
  assert.equal(fromPlanLuna.bookings[0].metadata.source, 'luna_guest', 'from-plan Luna source persists');

  const fromPlanStaffPayload = await fromPlanRoutePayload('session', 'luna_guest');
  assert.equal(fromPlanStaffPayload.source, 'staff', 'from-plan route overwrites spoofed source for staff session');
  const fromPlanStaff = await runPayload(fromPlanStaffPayload);
  assert.equal(fromPlanStaff.bookings[0].metadata.source, 'staff', 'from-plan staff source persists');

  console.log('PASS verify-booking-create-source-persistence');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});