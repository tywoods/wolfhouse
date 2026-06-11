/**
 * Stage 45b — Luna open phone testing (inbound only).
 *
 * Usage:
 *   npm run verify:stage45b-luna-open-phone-testing
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GATE = path.join(__dirname, 'lib', 'luna-open-phone-testing-gate.js');
const OPEN_DEMO = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const META_PROC = path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js');
const META_ADAPTER = path.join(__dirname, 'lib', 'meta-open-demo-inbound-adapter.js');
const LIVE_REPLY = path.join(__dirname, 'lib', 'luna-guest-reply-send-route.js');
const PKG = path.join(ROOT, 'package.json');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage45b-luna-open-phone-testing.js  (Stage 45b)\n');

section('A. Syntax');
for (const f of [GATE, OPEN_DEMO, META_PROC, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('A0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('A0', `${path.basename(f)} syntax error`);
  }
}

const gateSrc = fs.readFileSync(GATE, 'utf8');
const openDemoSrc = fs.readFileSync(OPEN_DEMO, 'utf8');
const metaProcSrc = fs.readFileSync(META_PROC, 'utf8');
const liveReplySrc = fs.readFileSync(LIVE_REPLY, 'utf8');

section('B. Flag + wiring');
check('B1', gateSrc.includes('LUNA_OPEN_PHONE_TESTING'),
  'LUNA_OPEN_PHONE_TESTING env key defined');
check('B2', gateSrc.includes("=== 'true'") && gateSrc.includes('isLunaOpenPhoneTestingEnabled'),
  'flag defaults off unless explicitly true');
check('B3', openDemoSrc.includes('evaluateGuestInboundPhoneGate'),
  'open-demo inbound gate calls phone gate');
check('B4', metaProcSrc.includes('shouldBlockMetaGuestInboundAfterOpenDemo'),
  'Meta inbound blocks fallthrough when phone gate fails');
check('B5', gateSrc.includes('external_open_testing'),
  'external tester metadata class present');
check('B6', gateSrc.includes('wolfhouse-somo'),
  'gate scoped to wolfhouse-somo');

section('C. Gate unit tests');
const phoneGate = require('./lib/luna-open-phone-testing-gate');
const openDemoGate = require('./lib/open-demo-whatsapp-gate');

const baseEnv = {
  NODE_ENV: 'staging',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: 'demo-staging',
};

const unknownBody = {
  client_slug: 'wolfhouse-somo',
  guest_phone: '+15551234567',
  phone_number_id: 'demo-staging',
  channel: 'whatsapp',
  message_text: 'hi',
  inbound_message_id: 'wamid.test45b',
};

const blockedDefault = phoneGate.evaluateGuestInboundPhoneGate(unknownBody, baseEnv);
check('C1', blockedDefault.ok === false && blockedDefault.code === 'guest_phone_not_allowlisted',
  'default mode blocks unknown wolfhouse guest phone');

const openEnv = { ...baseEnv, LUNA_OPEN_PHONE_TESTING: 'true' };
const openAllowed = phoneGate.evaluateGuestInboundPhoneGate(unknownBody, openEnv);
check('C2', openAllowed.ok === true && openAllowed.guest_tester_class === 'external_open_testing',
  'open-testing mode accepts unknown phone');

const proofPhone = '+491726422307';
const proofAllowed = phoneGate.evaluateGuestInboundPhoneGate(
  { ...unknownBody, guest_phone: proofPhone },
  baseEnv,
);
check('C3', proofAllowed.ok === true && proofAllowed.guest_tester_class === 'allowlisted_test',
  'known proof phone still allowed when open-testing off');

const allowlistEnv = {
  ...baseEnv,
  LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: '+34629801234',
};
const allowlisted = phoneGate.evaluateGuestInboundPhoneGate(
  { ...unknownBody, guest_phone: '+34629801234' },
  allowlistEnv,
);
check('C4', allowlisted.ok === true && allowlisted.guest_tester_class === 'allowlisted_test',
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST inbound still works');

const otherClient = phoneGate.evaluateGuestInboundPhoneGate(
  { ...unknownBody, client_slug: 'other-client' },
  baseEnv,
);
check('C5', otherClient.ok === true && otherClient.applies === false,
  'non-wolfhouse clients unchanged');

const openDemoBlocked = openDemoGate.evaluateOpenDemoWhatsAppGate(unknownBody, baseEnv);
check('C6', openDemoBlocked.ok === false && openDemoBlocked.code === 'guest_phone_not_allowlisted',
  'evaluateOpenDemoWhatsAppGate blocks unknown phone by default');

const openDemoOpen = openDemoGate.evaluateOpenDemoWhatsAppGate(unknownBody, openEnv);
check('C7', openDemoOpen.ok === true,
  'evaluateOpenDemoWhatsAppGate passes unknown phone when open-testing on');

section('D. Live send remains separately gated');
const liveBlocked = openDemoGate.evaluateOpenDemoWhatsAppLiveReplyGate(unknownBody, openEnv);
check('D1', liveBlocked.ok === false,
  'live reply gate still closed with only LUNA_OPEN_PHONE_TESTING');
check('D2', !gateSrc.includes('OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED'),
  'open-phone gate does not enable live replies env');
check('D3', liveReplySrc.includes('bot_paused') || liveReplySrc.includes('evaluateGuestReplySendRouteWithPause'),
  'guest reply route still references bot pause path');

section('E. No Stripe / payment side effects in gate');
check('E1', !gateSrc.includes('STRIPE') && !gateSrc.includes('stripe'),
  'phone gate module has no Stripe calls');
check('E2', !gateSrc.includes('create_stripe') && !openDemoSrc.includes('LUNA_OPEN_PHONE_TESTING'),
  'open-demo Stripe gates not tied to open-phone flag');

section('F. Meta fallthrough safety');
const fallthrough = phoneGate.shouldBlockMetaGuestInboundAfterOpenDemo(baseEnv, {
  supported: true,
  message_text: 'hello',
  from: '15551234567',
  client_slug: 'wolfhouse-somo',
  phone_number_id: 'demo-staging',
});
check('F1', fallthrough.block === true,
  'Meta path blocked when open demo on but phone not allowlisted');

const fallthroughOpen = phoneGate.shouldBlockMetaGuestInboundAfterOpenDemo(openEnv, {
  supported: true,
  message_text: 'hello',
  from: '15551234567',
  client_slug: 'wolfhouse-somo',
  phone_number_id: 'demo-staging',
});
check('F2', fallthroughOpen.block === false,
  'Meta path open when LUNA_OPEN_PHONE_TESTING enabled');

section('G. Package script');
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
check('G1', pkg.scripts && pkg.scripts['verify:stage45b-luna-open-phone-testing'],
  'npm script verify:stage45b-luna-open-phone-testing registered');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
