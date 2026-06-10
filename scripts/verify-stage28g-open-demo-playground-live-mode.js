/**
 * Stage 28g — Verifier for open-demo playground live mode wiring.
 *
 * Usage:
 *   npm run verify:stage28g-open-demo-playground-live-mode
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ADAPTER = path.join(__dirname, 'lib', 'meta-open-demo-inbound-adapter.js');
const EXECUTE = path.join(__dirname, 'lib', 'open-demo-whatsapp-inbound-execute.js');
const GATE = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const META = path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js');
const MODE = path.join(__dirname, 'set-open-demo-playground-mode.js');
const COMMON = path.join(__dirname, 'lib', 'open-demo-playground-common.js');
const DOC = path.join(ROOT, 'docs', 'STAGE-28G-OPEN-DEMO-PLAYGROUND-LIVE-MODE.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28g-open-demo-playground-live-mode';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage28g-open-demo-playground-live-mode.js  (Stage 28g)\n`);

for (const f of [ADAPTER, EXECUTE, GATE, MODE, COMMON, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const adapterSrc = fs.readFileSync(ADAPTER, 'utf8');
const executeSrc = fs.readFileSync(EXECUTE, 'utf8');
const gateSrc = fs.readFileSync(GATE, 'utf8');
const metaSrc = fs.readFileSync(META, 'utf8');
const modeSrc = fs.readFileSync(MODE, 'utf8');
const commonSrc = fs.readFileSync(COMMON, 'utf8');
const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

section('A. Files + package');

if (fs.existsSync(DOC)) pass('A1', 'STAGE-28G doc exists');
else fail('A1', 'doc missing');

if (pkg.scripts[SCRIPT]) pass('A2', 'verifier npm script registered');
else fail('A2', 'verifier script missing');

if (pkg.scripts['playground:open-demo-on'] || pkg.scripts['set:open-demo-playground']) {
  pass('A3', 'playground mode npm script registered');
} else {
  fail('A3', 'playground mode script missing');
}

section('B. Meta live reply wiring');

if (adapterSrc.includes('shouldMetaOpenDemoSendLiveReply')
  && adapterSrc.includes('evaluateOpenDemoWhatsAppLiveReplyGate')) {
  pass('B1', 'Meta adapter gates live reply on env');
} else {
  fail('B1', 'Meta live reply gate wiring missing');
}

if (adapterSrc.includes('executeBody.send_live_reply_confirmed = true')
  || /send_live_reply_confirmed\s*=\s*true/.test(adapterSrc)) {
  pass('B2', 'Meta adapter sets send_live_reply_confirmed when gate passes');
} else {
  fail('B2', 'conditional live reply confirm missing');
}

if (adapterSrc.includes('evaluateGuestReplySendRouteWithPause') || executeSrc.includes('evaluateGuestReplySendRouteWithPause')) {
  pass('B3', 'live reply reuses guest reply send route');
} else {
  fail('B3', 'send route missing');
}

if (gateSrc.includes('whatsapp_dry_run_active') && gateSrc.includes('isWhatsappDryRun')) {
  pass('B4', 'WHATSAPP_DRY_RUN=true blocks live send');
} else {
  fail('B4', 'dry-run block missing');
}

if (gateSrc.includes('OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED')) {
  pass('B5', 'live replies require explicit env flag');
} else {
  fail('B5', 'live reply env gate missing');
}

section('C. Forbidden Meta flags');

const forbidden = [
  'create_stripe_test_link_confirmed',
  'send_payment_link_whatsapp_confirmed',
];
for (const flag of forbidden) {
  if (!adapterSrc.includes(`${flag}: true`) && !adapterSrc.includes(`${flag}=true`)) {
    pass('C', `Meta adapter does not hardcode ${flag}`);
  } else {
    fail('C', `Meta adapter hardcodes ${flag}`);
  }
}

if (!adapterSrc.includes('runGuestConfirmationSend') && !adapterSrc.includes('send-confirmation')) {
  pass('C3', 'no confirmation send in Meta adapter');
} else {
  fail('C3', 'confirmation send in Meta adapter');
}

if (!adapterSrc.includes('runGuestStripeTestLinkCreateApproved')) {
  pass('C4', 'no Stripe checkout create in Meta adapter');
} else {
  fail('C4', 'Stripe create imported in Meta adapter');
}

section('D. Owner + routing');

if (metaSrc.includes('staffPhoneAccess.active') || metaSrc.includes('staffPhoneAccess.found && staffPhoneAccess.active')) {
  pass('D1', 'active owner route preserved');
} else {
  fail('D1', 'owner route check missing');
}

if (metaSrc.indexOf('processOwnerWhatsAppCommandCenter') < metaSrc.indexOf('shouldRouteMetaInboundToOpenDemo')) {
  pass('D2', 'owner checked before open-demo guest route');
} else {
  fail('D2', 'owner/guest route order wrong');
}

if (modeSrc.includes('setGuestPhoneInactive') || commonSrc.includes('setGuestPhoneInactive')) {
  pass('D3', 'playground ON demotes test phone');
} else {
  fail('D3', 'guest phone demotion missing');
}

section('E. Playground mode script');

if (commonSrc.includes('PLAYGROUND_ON_ENV')
  && /WHATSAPP_DRY_RUN:\s*'false'/.test(commonSrc)) {
  pass('E1', 'ON sets WHATSAPP_DRY_RUN=false');
} else {
  fail('E1', 'ON dry-run unset missing');
}

if (commonSrc.includes('PLAYGROUND_ON_ENV') && commonSrc.includes('PLAYGROUND_OFF_ENV')) {
  pass('E2', 'ON/OFF env presets defined');
} else {
  fail('E2', 'env presets missing');
}

if (commonSrc.includes("OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false'")
  || commonSrc.includes('OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: "false"')) {
  pass('E3', 'Stripe test links stay off');
} else {
  fail('E3', 'Stripe off not enforced');
}

if (modeSrc.includes('LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST') || commonSrc.includes('LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST')) {
  pass('E4', 'confirmation allowlist cleared on toggle');
} else {
  fail('E4', 'allowlist cleanup missing');
}

if (modeSrc.includes('assertNotProductionDb')) {
  pass('E5', 'production DB guard on mode script');
} else {
  fail('E5', 'production guard missing');
}

if (!modeSrc.includes('workflow_entity') && !/n8n.*active\s*=\s*true/i.test(modeSrc)) {
  pass('E6', 'no n8n activation in mode script');
} else {
  fail('E6', 'n8n activation detected');
}

section('F. Docs');

if (/turn playground ON|--on/i.test(doc) && /turn playground OFF|--off/i.test(doc)) {
  pass('F1', 'docs cover ON/OFF');
} else {
  fail('F1', 'ON/OFF docs missing');
}

if (/real WhatsApp|replies will send/i.test(doc)) {
  pass('F2', 'docs warn about live WhatsApp');
} else {
  fail('F2', 'live WhatsApp warning missing');
}

if (/poll|wait for Ty|sitting there/i.test(doc)) {
  pass('F3', 'docs explain prior polling workflow was bad');
} else {
  fail('F3', 'prior workflow critique missing');
}

console.log(`\n── Summary ──\n\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
