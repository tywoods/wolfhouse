/**
 * Stage 45d — Open phone testing staff/admin routing bypass (Meta inbound).
 *
 * Usage:
 *   npm run verify:stage45d-luna-open-phone-staff-routing-bypass
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GATE = path.join(__dirname, 'lib', 'luna-open-phone-testing-gate.js');
const META_PROC = path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js');
const OPEN_DEMO = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const LIVE_REPLY = path.join(__dirname, 'lib', 'luna-guest-reply-send-route.js');
const PKG = path.join(ROOT, 'package.json');

const STAFF_HANDSET = '+15559876543';
const MONITOR_HANDSET = '+15551112233';
const UNKNOWN_HANDSET = '+15551234567';
const activeStaffAccess = { found: true, active: true, role: 'owner' };

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage45d-luna-open-phone-staff-routing-bypass.js  (Stage 45d)\n');

section('A. Syntax + wiring');
for (const f of [GATE, META_PROC, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('A0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('A0', `${path.basename(f)} syntax error`);
  }
}

const gateSrc = fs.readFileSync(GATE, 'utf8');
const metaSrc = fs.readFileSync(META_PROC, 'utf8');
const openDemoSrc = fs.readFileSync(OPEN_DEMO, 'utf8');

check('A1', gateSrc.includes('LUNA_OPEN_PHONE_TESTING_BYPASS_STAFF_ROUTING'),
  'bypass staff routing env key defined');
check('A2', gateSrc.includes('LUNA_OPEN_PHONE_TESTING_STAFF_ROUTING_KEEP_ALLOWLIST'),
  'staff monitor keep allowlist env key defined');
check('A3', metaSrc.includes('shouldRouteActiveStaffPhoneToOwnerCommandCenter'),
  'Meta inbound uses staff routing bypass helper');
check('A4', gateSrc.includes('staff_open_testing'),
  'staff guest tester metadata class present');

const gate = require('./lib/luna-open-phone-testing-gate');
const openDemoGate = require('./lib/open-demo-whatsapp-gate');

const baseEnv = {
  NODE_ENV: 'staging',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: 'demo-staging',
};

const staffNormalized = {
  client_slug: 'wolfhouse-somo',
  phone: STAFF_HANDSET,
  from: STAFF_HANDSET.replace(/\D/g, ''),
};

section('B. Staff routing bypass unit tests');

const defaultStaff = gate.evaluateOpenPhoneTestingStaffRoutingBypass(
  baseEnv,
  staffNormalized,
  activeStaffAccess,
);
check('B1', defaultStaff.route_to_owner === true && !defaultStaff.bypass_to_guest_path,
  'default: active staff phone routes to owner command center');

const openOnlyEnv = { ...baseEnv, LUNA_OPEN_PHONE_TESTING: 'true' };
const openOnlyStaff = gate.evaluateOpenPhoneTestingStaffRoutingBypass(
  openOnlyEnv,
  staffNormalized,
  activeStaffAccess,
);
check('B2', openOnlyStaff.route_to_owner === true,
  'open phone testing on, bypass off: staff still routes to owner');

const bypassEnv = {
  ...openOnlyEnv,
  LUNA_OPEN_PHONE_TESTING_BYPASS_STAFF_ROUTING: 'true',
};
const bypassStaff = gate.evaluateOpenPhoneTestingStaffRoutingBypass(
  bypassEnv,
  staffNormalized,
  activeStaffAccess,
);
check('B3', bypassStaff.route_to_owner === false && bypassStaff.bypass_to_guest_path === true,
  'open testing + bypass on: staff phone reaches guest path');
check('B4', bypassStaff.guest_tester_class === 'staff_open_testing',
  'bypassed staff tagged staff_open_testing');

const keepEnv = {
  ...bypassEnv,
  LUNA_OPEN_PHONE_TESTING_STAFF_ROUTING_KEEP_ALLOWLIST: MONITOR_HANDSET,
};
const keepStaff = gate.evaluateOpenPhoneTestingStaffRoutingBypass(
  keepEnv,
  { ...staffNormalized, phone: MONITOR_HANDSET, from: MONITOR_HANDSET.replace(/\D/g, '') },
  activeStaffAccess,
);
check('B5', keepStaff.route_to_owner === true && keepStaff.kept_as_staff_monitor === true,
  'monitor keep allowlist preserves staff/admin routing');

const inactiveStaff = gate.evaluateOpenPhoneTestingStaffRoutingBypass(
  bypassEnv,
  staffNormalized,
  { found: true, active: false },
);
check('B6', inactiveStaff.route_to_owner === false,
  'inactive staff_phone_access row does not route to owner');

check('B7', gate.shouldRouteActiveStaffPhoneToOwnerCommandCenter(
  baseEnv,
  staffNormalized,
  activeStaffAccess,
) === true,
  'shouldRouteActiveStaffPhoneToOwnerCommandCenter true by default');

check('B8', gate.shouldRouteActiveStaffPhoneToOwnerCommandCenter(
  bypassEnv,
  staffNormalized,
  activeStaffAccess,
) === false,
  'shouldRouteActiveStaffPhoneToOwnerCommandCenter false when bypass on');

section('C. Unknown guest phones (45b regression)');

const unknownBody = {
  client_slug: 'wolfhouse-somo',
  guest_phone: UNKNOWN_HANDSET,
  phone_number_id: 'demo-staging',
};
check('C1', gate.evaluateGuestInboundPhoneGate(unknownBody, baseEnv).ok === false,
  'unknown guest blocked when open testing off');
check('C2', gate.evaluateGuestInboundPhoneGate(unknownBody, bypassEnv).ok === true,
  'unknown guest allowed when open testing on');

section('D. Live reply + booking write gates unchanged');

const liveBlocked = openDemoGate.evaluateOpenDemoWhatsAppLiveReplyGate(unknownBody, bypassEnv);
check('D1', liveBlocked.ok === false,
  'live replies blocked with bypass env only');

const writeGate = openDemoGate.evaluateOpenDemoBookingWriteGate(unknownBody, bypassEnv);
check('D2', writeGate.ok === false,
  'booking writes blocked with bypass env only');

check('D3', liveReplySrcIncludesBotPause(),
  'bot pause path still referenced in guest reply route');

function liveReplySrcIncludesBotPause() {
  const liveReplySrc = fs.readFileSync(LIVE_REPLY, 'utf8');
  return liveReplySrc.includes('bot_paused')
    || liveReplySrc.includes('evaluateGuestReplySendRouteWithPause');
}

section('E. No Stripe / production bypass');
check('E1', !gateSrc.includes('STRIPE') && !gateSrc.includes('stripe'),
  'staff bypass module has no Stripe calls');

const prodBypass = gate.evaluateOpenPhoneTestingStaffRoutingBypass(
  { ...bypassEnv, NODE_ENV: 'production' },
  staffNormalized,
  activeStaffAccess,
);
check('E2', prodBypass.route_to_owner === true,
  'production never bypasses staff routing');

section('F. Package script');
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
check('F1', pkg.scripts && pkg.scripts['verify:stage45d-luna-open-phone-staff-routing-bypass'],
  'npm script verify:stage45d-luna-open-phone-staff-routing-bypass registered');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
