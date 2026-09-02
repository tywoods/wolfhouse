'use strict';

/**
 * verify:sunset-booking-truth
 *
 * Hernan booking-contradiction defect: Luna confirms Kyle/George bookings, then
 * later says nothing is booked. Sunset had no Staff API list tool, and SOUL's
 * take_request "nothing is booked yet" copy leaked onto successful creates.
 *
 * Fail closed:
 *   - After create_sunset_booking success or a list with rows, never deny.
 *   - If list/create truth is missing or failed, ask — do not contradict.
 *   - "Nothing is booked yet" is only for take_request with no create success.
 * Tenant isolation + no-send preserved.
 *
 * Offline. No WhatsApp send. No live staging proof.
 *
 * Run: node scripts/verify-sunset-booking-truth.js
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const {
  evaluateSunsetBookingTruthClaim,
  authoritativeSunsetBookingsExist,
} = require('./lib/sunset-booking-truth');
const {
  resolveSunsetListScope,
  phoneMatchSuffix,
  projectSunsetBookingListRow,
} = require('./lib/sunset-bot-bookings-by-phone');

const SOUL = fs.readFileSync(path.join(ROOT, 'docker', 'hermes-sunset', 'SOUL.md'), 'utf8');
const PLUGIN = fs.readFileSync(
  path.join(ROOT, 'docker', 'hermes-staging', 'plugins', 'wolfhouse_staff_api', '__init__.py'),
  'utf8',
);
const STAFF = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const LIST_LIB = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'sunset-bot-bookings-by-phone.js'), 'utf8');
const OUTPUT_GUARD = fs.readFileSync(
  path.join(ROOT, 'docker', 'hermes-staging', 'wolfhouse', 'output_guard.py'),
  'utf8',
);
const SIM_GUARDS = fs.readFileSync(
  path.join(ROOT, 'docker', 'hermes-staging', 'wolfhouse', 'simulate_write_guards.py'),
  'utf8',
);
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function ok(label, cond, detail) {
  if (!cond) {
    const err = new Error(label + (detail ? ' — ' + detail : ''));
    err.label = label;
    throw err;
  }
  console.log('  PASS  ' + label);
}

console.log('verify:sunset-booking-truth\n');

console.log('[Policy — Hernan Kyle/George contradiction]');
{
  const createOk = {
    create: { success: true, tool: 'create_sunset_booking', booking_code: 'SUNSET-KYLE', guest_name: 'Kyle' },
  };
  const deny = 'Nothing is booked yet — a human from the Sunset team is coming into the chat.';
  const confirm = "You're booked Kyle! Here's the secure €315 payment link.";
  const ask = "I want to double-check what's already booked for this number — one moment.";

  ok('create success + deny is blocked',
    evaluateSunsetBookingTruthClaim({ toolResults: [createOk.create], replyText: deny }).ok === false);
  ok('create success + confirm is allowed',
    evaluateSunsetBookingTruthClaim({ toolResults: [createOk.create], replyText: confirm }).ok === true);
  ok('create success + ask is allowed',
    evaluateSunsetBookingTruthClaim({ toolResults: [createOk.create], replyText: ask }).ok === true);

  const listKyleGeorge = {
    success: true,
    tool: 'list_sunset_bookings',
    count: 2,
    bookings: [
      { booking_code: 'SUNSET-KYLE', guest_name: 'Kyle' },
      { booking_code: 'SUNSET-GEORGE', guest_name: 'George' },
    ],
  };
  ok('list with rows + deny is blocked',
    evaluateSunsetBookingTruthClaim({ toolResults: [listKyleGeorge], replyText: deny }).ok === false);
  ok('authoritative bookings exist from list',
    authoritativeSunsetBookingsExist([listKyleGeorge]) === true);
  ok('authoritative bookings exist from create',
    authoritativeSunsetBookingsExist([createOk.create]) === true);

  const takeRequest = {
    success: true,
    tool: 'get_sunset_lesson_availability',
    take_request: true,
  };
  ok('take_request without create may say nothing booked',
    evaluateSunsetBookingTruthClaim({ toolResults: [takeRequest], replyText: deny }).ok === true);
  ok('take_request after create success may NOT deny',
    evaluateSunsetBookingTruthClaim({
      toolResults: [createOk.create, takeRequest],
      replyText: deny,
    }).ok === false);

  const listFailed = { success: false, tool: 'list_sunset_bookings', error: 'booking lookup failed' };
  ok('unclear list + deny is blocked (ask, do not contradict)',
    evaluateSunsetBookingTruthClaim({ toolResults: [listFailed], replyText: deny }).ok === false);
  ok('unclear list + ask is allowed',
    evaluateSunsetBookingTruthClaim({ toolResults: [listFailed], replyText: ask }).ok === true);

  const listEmpty = { success: true, tool: 'list_sunset_bookings', count: 0, bookings: [] };
  ok('empty successful list may say nothing booked',
    evaluateSunsetBookingTruthClaim({ toolResults: [listEmpty], replyText: deny }).ok === true);
}

console.log('\n[SOUL — authoritative list + never deny after create]');
ok('SOUL names list_sunset_bookings', /list_sunset_bookings/.test(SOUL));
ok('SOUL says Staff API booking list is truth',
  /list_sunset_bookings/.test(SOUL)
  && /authoritative/i.test(SOUL)
  && /never deny|never say nothing is booked/i.test(SOUL));
ok('SOUL take_request copy is scoped (not after a successful create)',
  /take_request/.test(SOUL)
  && /nothing is booked yet/.test(SOUL)
  && /successful create|create_sunset_booking succeeds|already created/i.test(SOUL));
ok('SOUL fail-closed ask when list is unclear',
  /if (authoritative state is )?unclear|ask rather than contradict|do not contradict/i.test(SOUL));

console.log('\n[Plugin — sunset-only list tool]');
ok('plugin defines list_sunset_bookings', /def list_sunset_bookings\(/.test(PLUGIN));
ok('plugin posts /sunset/bookings-by-phone', /\/sunset\/bookings-by-phone/.test(PLUGIN));
ok('list tool registered on sunset read tools',
  /_sunset_tools\([\s\S]*?list_sunset_bookings/.test(PLUGIN)
  || /"list_sunset_bookings"[\s\S]{0,400}_sunset_tools/.test(PLUGIN)
  || /("list_sunset_bookings"[\s\S]{0,200}List the guest)/.test(PLUGIN));
ok('list tool is not a Wolfhouse accommodation list',
  !/def list_sunset_bookings[\s\S]{0,800}\/bookings\/by-phone/.test(PLUGIN));

console.log('\n[List scope — tenant isolation]');
ok('wolfhouse client is unsupported_client',
  resolveSunsetListScope({ clientSlug: 'wolfhouse-somo' }).ok === false
  && resolveSunsetListScope({ clientSlug: 'wolfhouse-somo' }).error === 'unsupported_client');
ok('sunset slug is accepted', resolveSunsetListScope({ clientSlug: 'sunset' }).ok === true);
ok('unknown location fails closed',
  resolveSunsetListScope({ clientSlug: 'sunset', locationId: 'wolfhouse-somo' }).ok === false);
ok('phone suffix is last 9 digits', phoneMatchSuffix('+5491122676249') === '122676249');
ok('projected row keeps guest_name',
  projectSunsetBookingListRow({ booking_code: 'SUNSET-KYLE', guest_name: 'Kyle' }).guest_name === 'Kyle');

console.log('\n[Staff API — tenant-forced read, no send]');
ok('route /staff/bot/sunset/bookings-by-phone exists',
  STAFF.includes("pathname === '/staff/bot/sunset/bookings-by-phone'"));
ok('handler is POST-only + bot auth + sunset tenant dispatch', (() => {
  const idx = STAFF.indexOf("pathname === '/staff/bot/sunset/bookings-by-phone'");
  const block = STAFF.slice(idx, idx + 800);
  return /requireBotAuth\(req, res\)/.test(block)
    && /dispatchBotRouteWithEffectiveTenant\s*\(\s*auth\s*,\s*res\s*,\s*SUNSET_CLIENT_SLUG/.test(block)
    && /Method not allowed — use POST/.test(block);
})());
ok('list lib forces sunset client slug',
  /SUNSET_CLIENT_SLUG/.test(LIST_LIB) && /wolfhouse-somo/.test(LIST_LIB) === false
    ? /clientSlug !== SUNSET_CLIENT_SLUG|unsupported_client|tenant/.test(LIST_LIB)
    : /SUNSET_CLIENT_SLUG/.test(LIST_LIB));
ok('list lib never sends WhatsApp',
  /no_whatsapp/.test(LIST_LIB) || /no WhatsApp/.test(LIST_LIB));
ok('cancelled bookings excluded', /cancelled/.test(LIST_LIB));

console.log('\n[Output guard + simulate no-write]');
ok('output guard detects booking denial contradiction',
  /booking_denial_contradiction|find_booking_denial/.test(OUTPUT_GUARD));
ok('simulate maps bookings-by-phone to list_sunset_bookings',
  SIM_GUARDS.includes('sunset/bookings-by-phone')
  && SIM_GUARDS.includes('list_sunset_bookings'));
ok('simulate does not block the list path as a write',
  !/blocked_sunset_booking[\s\S]{0,80}bookings-by-phone/.test(SIM_GUARDS));

console.log('\n[Package script]');
ok('npm script registered',
  PKG.scripts['verify:sunset-booking-truth'] === 'node scripts/verify-sunset-booking-truth.js');

console.log('\n[Plugin unit — sunset list, wolfhouse isolation]');
{
  const py = spawnSync(process.execPath.replace(/node$/, 'python3') && 'python3', [
    path.join(ROOT, 'docker', 'hermes-staging', 'plugins', 'wolfhouse_staff_api', 'test_sunset_booking_truth.py'),
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LUNA_CLIENT_SLUG: 'sunset' },
  });
  if (py.stdout) process.stdout.write(py.stdout);
  if (py.stderr) process.stderr.write(py.stderr);
  ok('python plugin booking-truth tests exit 0', py.status === 0, py.stderr || py.stdout);
}

console.log('\n── verify:sunset-booking-truth PASSED ──');
