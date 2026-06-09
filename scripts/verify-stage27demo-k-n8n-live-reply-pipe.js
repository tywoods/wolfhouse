/**
 * Stage 27demo-k — Verifier for n8n open demo live reply pipe docs + workflow export.
 *
 * Usage:
 *   npm run verify:stage27demo-k-n8n-live-reply-pipe
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-27DEMO-K-N8N-LIVE-REPLY-PIPE.md');
const WF = path.join(ROOT, 'n8n', 'Luna Open Demo WhatsApp Inbound Live Reply Pipe.json');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27demo-k-n8n-live-reply-pipe';
const DEMO_PHONE_ID = '1152900101233109';
const OPEN_DEMO_ROUTE = '/staff/bot/open-demo-whatsapp-inbound-dry-run';

const FORBIDDEN_BODY_FLAGS = [
  'create_demo_hold_draft_confirmed',
  'assign_demo_bed_confirmed',
  'create_stripe_test_link_confirmed',
  'send_payment_link_whatsapp_confirmed',
];

const REQUIRED_GATES = [
  'WHATSAPP_DRY_RUN',
  'OPEN_DEMO_WHATSAPP_ENABLED',
  'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
  'OPEN_DEMO_BOOKING_WRITES_ENABLED',
  'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
  'OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27demo-k-n8n-live-reply-pipe.js  (Stage 27demo-k)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
const wfRaw = fs.existsSync(WF) ? fs.readFileSync(WF, 'utf8') : '';
let wf = null;
try {
  wf = wfRaw ? JSON.parse(wfRaw) : null;
} catch {
  wf = null;
}

section('A. Docs');

if (fs.existsSync(DOC)) pass('A1', 'STAGE-27DEMO-K doc exists');
else fail('A1', 'doc missing');

if (/n8n.*pipe|pipe only/i.test(doc) && /Staff API.*brain|brain/i.test(doc)) {
  pass('A2', 'docs state n8n pipe / Staff API brain');
} else {
  fail('A2', 'architecture docs incomplete');
}

if (doc.includes('send_live_reply_confirmed') && /live proof|live-send|live reply/i.test(doc)) {
  pass('A3', 'docs include send_live_reply_confirmed for live proof');
} else {
  fail('A3', 'send_live_reply_confirmed live proof docs missing');
}

for (const flag of FORBIDDEN_BODY_FLAGS) {
  const id = `A4-${flag}`;
  if (doc.includes(flag) && /must not|do not|forbid|absent/i.test(doc)) {
    pass(id, `docs forbid ${flag}`);
  } else {
    fail(id, `docs missing forbid guidance for ${flag}`);
  }
}

for (const gate of REQUIRED_GATES) {
  if (doc.includes(gate)) pass(`A5-${gate}`, `docs list ${gate}`);
  else fail(`A5-${gate}`, `docs missing ${gate}`);
}

if (/rollback|restore|deactivate|inactive/i.test(doc)) pass('A6', 'docs include rollback');
else fail('A6', 'rollback steps missing');

if (/pre-live|blocked proof|live_send_blocked:\s*true/i.test(doc)) pass('A7', 'docs include pre-live blocked proof');
else fail('A7', 'pre-live blocked proof missing');

if (/whatsapp_sent:\s*true|live_send_blocked:\s*false|guest_message_send_status/i.test(doc)) {
  pass('A8', 'docs include live-send proof expectations');
} else {
  fail('A8', 'live-send proof expectations missing');
}

if (/no booking|no Stripe|no confirmation/i.test(doc)) pass('A9', 'docs include no booking/Stripe/confirmation proof');
else fail('A9', 'safety proof expectations missing');

if (/27demo-l|booking write through n8n/i.test(doc)) pass('A10', 'docs mention next step 27demo-l');
else fail('A10', 'next step 27demo-l missing');

if (doc.includes('Luna Open Demo WhatsApp Inbound Live Reply Pipe')) pass('A11', 'docs name n8n workflow');
else fail('A11', 'workflow name missing from docs');

section('B. n8n workflow export');

if (fs.existsSync(WF)) pass('B1', 'n8n workflow JSON exists');
else fail('B1', 'workflow JSON missing');

if (wf && wf.name === 'Luna Open Demo WhatsApp Inbound Live Reply Pipe') {
  pass('B2', 'workflow name matches stage doc');
} else {
  fail('B2', 'workflow name mismatch');
}

if (wf && wf.active === false) pass('B3', 'workflow active:false in repo');
else fail('B3', 'workflow must be inactive in repo');

const nodeBlob = wf ? JSON.stringify(wf.nodes) : '';

if (wf && !/graph\.facebook\.com/i.test(nodeBlob)) pass('B4', 'no graph.facebook.com in workflow');
else fail('B4', 'forbidden Graph API in workflow');

if (wf && !/api\.stripe\.com/i.test(nodeBlob)) pass('B5', 'no api.stripe.com in workflow');
else fail('B5', 'forbidden Stripe URL in workflow');

if (wf && nodeBlob.includes('send_live_reply_confirmed')) pass('B6', 'workflow includes send_live_reply_confirmed');
else fail('B6', 'send_live_reply_confirmed missing from workflow');

for (const flag of FORBIDDEN_BODY_FLAGS) {
  if (!nodeBlob.includes(flag)) pass(`B7-${flag}`, `workflow body omits ${flag}`);
  else fail(`B7-${flag}`, `workflow must not include ${flag}`);
}

if (nodeBlob.includes(DEMO_PHONE_ID)) pass('B8', 'workflow guards demo phone_number_id');
else fail('B8', 'phone_number_id guard missing');

if (wf && wf.nodes.some((n) => n.type === 'n8n-nodes-base.httpRequest'
  && String(n.parameters?.url || '').includes(OPEN_DEMO_ROUTE))) {
  pass('B9', 'HTTP node targets open-demo endpoint');
} else {
  fail('B9', 'open-demo endpoint missing');
}

section('C. package.json');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('C1', `${SCRIPT} npm script`);
else fail('C1', `${SCRIPT} npm script missing`);

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
