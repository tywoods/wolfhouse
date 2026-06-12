/**
 * Stage 27demo-m — Verifier for n8n open demo Stripe TEST link pipe.
 *
 * Usage:
 *   npm run verify:stage27demo-m-n8n-stripe-test-link
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-27DEMO-M-N8N-STRIPE-TEST-LINK.md');
const WF = path.join(ROOT, 'n8n', 'Luna Open Demo WhatsApp Stripe Test Link Pipe.json');
const API = path.join(__dirname, 'staff-query-api.js');
const GATE = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const STRIPE = path.join(__dirname, 'lib', 'luna-guest-stripe-test-link-create.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27demo-m-n8n-stripe-test-link';
const DEMO_PHONE_ID = '1152900101233109';
const OPEN_DEMO_ROUTE = '/staff/bot/open-demo-whatsapp-inbound-dry-run';

const REQUIRED_FLAG = 'create_stripe_test_link_confirmed';

const FORBIDDEN_FLAGS = [
  'send_live_reply_confirmed',
  'send_payment_link_whatsapp_confirmed',
  'create_demo_hold_draft_confirmed',
  'assign_demo_bed_confirmed',
];

const REQUIRED_ENV_GATES = [
  'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
  'STRIPE_LINKS_ENABLED',
  'STAFF_ACTIONS_ENABLED',
];

const RESPONSE_FIELDS = [
  'stripe_link_attempted',
  'stripe_link_created',
  'stripe_link_reused',
  'stripe_mode',
  'payment_link_sent',
  'confirmation_sent',
  'payment_truth_applied',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27demo-m-n8n-stripe-test-link.js  (Stage 27demo-m)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
const gateSrc = fs.existsSync(GATE) ? fs.readFileSync(GATE, 'utf8') : '';
const stripeSrc = fs.existsSync(STRIPE) ? fs.readFileSync(STRIPE, 'utf8') : '';
const apiSrc = fs.existsSync(API) ? fs.readFileSync(API, 'utf8') : '';

let wf = null;
try {
  wf = fs.existsSync(WF) ? JSON.parse(fs.readFileSync(WF, 'utf8')) : null;
} catch {
  wf = null;
}

const handlerStart = apiSrc.indexOf('async function handleBotOpenDemoWhatsAppInboundDryRun(');
const handlerEnd = apiSrc.indexOf('\nfunction parseGuestSimulatorChain(', handlerStart);
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';

section('A. Docs');

if (fs.existsSync(DOC)) pass('A1', 'STAGE-27DEMO-M doc exists');
else fail('A1', 'doc missing');

if (/n8n.*pipe|pipe only/i.test(doc) && /Staff API.*brain|brain/i.test(doc)) {
  pass('A2', 'docs state n8n pipe / Staff API brain');
} else {
  fail('A2', 'architecture docs incomplete');
}

if (doc.includes(REQUIRED_FLAG)) pass('A3', `docs include ${REQUIRED_FLAG}`);
else fail('A3', `docs missing ${REQUIRED_FLAG}`);

for (const flag of FORBIDDEN_FLAGS) {
  if (doc.includes(flag) && /forbid|do not|must not|not required|not include/i.test(doc)) {
    pass(`A4-${flag}`, `docs forbid or exclude ${flag}`);
  } else {
    fail(`A4-${flag}`, `docs missing forbid guidance for ${flag}`);
  }
}

for (const gate of REQUIRED_ENV_GATES) {
  if (doc.includes(gate)) pass(`A5-${gate}`, `docs list ${gate}`);
  else fail(`A5-${gate}`, `docs missing ${gate}`);
}

if (/rollback|restore|deactivate/i.test(doc)) pass('A6', 'docs include rollback');
else fail('A6', 'rollback missing');

if (/stripe_link_created|stripe_checkout_url|stripe_link_reused/i.test(doc)) {
  pass('A7', 'docs include stripe link proof expectations');
} else {
  fail('A7', 'stripe link proof expectations missing');
}

if (/27demo-n|webhook.*truth|payment truth/i.test(doc)) {
  pass('A8', 'docs mention next step 27demo-n');
} else {
  fail('A8', 'next step 27demo-n missing');
}

if (doc.includes('open-demo-whatsapp-stripe-test-link-27m')) pass('A9', 'docs include webhook path');
else fail('A9', 'webhook path missing');

section('B. Staff API + gates');

if (gateSrc.includes('evaluateOpenDemoStripeTestLinkGate')) pass('B1', 'stripe test link gate evaluator');
else fail('B1', 'evaluateOpenDemoStripeTestLinkGate missing');

if (gateSrc.includes('production_blocked') && gateSrc.includes('evaluateOpenDemoStripeTestLinkGate')) {
  pass('B2', 'production block on stripe gate');
} else {
  fail('B2', 'production block missing');
}

if (gateSrc.includes('sk_test_') || gateSrc.includes('isStripeTestSecretKey')) {
  pass('B3', 'test-mode Stripe guard');
} else {
  fail('B3', 'test mode guard missing');
}

if (gateSrc.includes('wantsCreateStripeTestLinkConfirmed')) pass('B4', 'explicit body flag helper');
else fail('B4', 'wantsCreateStripeTestLinkConfirmed missing');

if (handler.includes('wantsCreateStripeTestLinkConfirmed')) pass('B5', 'handler checks create_stripe_test_link_confirmed');
else fail('B5', 'handler flag check missing');

if (handler.includes('runGuestStripeTestLinkCreateApproved')) pass('B6', 'handler calls Stripe TEST link helper');
else fail('B6', 'Stripe link helper not called');

if (!handler.includes('runGuestStripePaymentTruthApplyApproved')) {
  pass('B7', 'no payment truth apply in open demo handler');
} else {
  fail('B7', 'payment truth apply must not run from open demo inbound');
}

if (!handler.includes('runGuestConfirmation') && !handler.includes('confirmation_send')) {
  pass('B8', 'no confirmation send in open demo handler');
} else {
  fail('B8', 'confirmation send referenced');
}

if (gateSrc.includes('payment_truth_applied')) pass('B9', 'response includes payment_truth_applied');
else fail('B9', 'payment_truth_applied missing from gate formatter');

if (stripeSrc.includes('payment_truth_recorded: false')) pass('B10', 'Stripe helper sets payment_truth_recorded false');
else fail('B10', 'LINK_SAFETY payment_truth_recorded missing');

section('C. n8n workflow');

if (fs.existsSync(WF)) pass('C1', 'workflow JSON exists');
else fail('C1', 'workflow missing');

if (wf && wf.name === 'Luna Open Demo WhatsApp Stripe Test Link Pipe') pass('C2', 'workflow name');
else fail('C2', 'workflow name mismatch');

if (wf && wf.active === false) pass('C3', 'active:false in repo');
else fail('C3', 'must be inactive in repo');

const nodeBlob = wf ? JSON.stringify(wf.nodes) : '';

if (!/graph\.facebook\.com/i.test(nodeBlob)) pass('C4', 'no graph.facebook.com');
else fail('C4', 'forbidden Graph API');

if (!/api\.stripe\.com/i.test(nodeBlob)) pass('C5', 'no api.stripe.com in n8n');
else fail('C5', 'n8n must not call Stripe directly');

if (nodeBlob.includes(REQUIRED_FLAG)) pass('C6', `workflow includes ${REQUIRED_FLAG}`);
else fail('C6', `workflow missing ${REQUIRED_FLAG}`);

for (const flag of FORBIDDEN_FLAGS) {
  if (!nodeBlob.includes(flag)) pass(`C7-${flag}`, `workflow omits ${flag}`);
  else fail(`C7-${flag}`, `workflow must not include ${flag}`);
}

if (nodeBlob.includes(DEMO_PHONE_ID)) pass('C8', 'phone_number_id guard');
else fail('C8', 'phone_number_id guard missing');

if (wf && wf.nodes.some((n) => String(n.parameters?.url || '').includes(OPEN_DEMO_ROUTE))) {
  pass('C9', 'HTTP targets open-demo endpoint');
} else {
  fail('C9', 'open-demo endpoint missing');
}

for (const field of RESPONSE_FIELDS) {
  if (nodeBlob.includes(field)) pass(`C10-${field}`, `workflow maps ${field}`);
  else fail(`C10-${field}`, `workflow missing ${field} in response mapper`);
}

section('D. package.json');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('D1', `${SCRIPT} npm script`);
else fail('D1', `${SCRIPT} missing`);

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
