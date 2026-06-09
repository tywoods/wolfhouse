/**
 * Stage 27demo-j — Verifier for n8n open demo WhatsApp inbound review pipe docs + workflow export.
 *
 * Usage:
 *   npm run verify:stage27demo-j-n8n-review-pipe
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-27DEMO-J-N8N-INBOUND-REVIEW-PIPE.md');
const WF = path.join(ROOT, 'n8n', 'Luna Open Demo WhatsApp Inbound Review Pipe.json');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27demo-j-n8n-review-pipe';
const DEMO_PHONE_ID = '1152900101233109';
const OPEN_DEMO_ROUTE = '/staff/bot/open-demo-whatsapp-inbound-dry-run';

const FORBIDDEN_BODY_FLAGS = [
  'send_live_reply_confirmed',
  'create_demo_hold_draft_confirmed',
  'assign_demo_bed_confirmed',
  'create_stripe_test_link_confirmed',
  'send_payment_link_whatsapp_confirmed',
];

const REQUIRED_GATES = [
  'WHATSAPP_DRY_RUN=true',
  'OPEN_DEMO_WHATSAPP_ENABLED=true',
  'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false',
  'OPEN_DEMO_BOOKING_WRITES_ENABLED=false',
  'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false',
  `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID=${DEMO_PHONE_ID}`,
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27demo-j-n8n-review-pipe.js  (Stage 27demo-j)\n');

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

if (fs.existsSync(DOC)) pass('A1', 'STAGE-27DEMO-J doc exists');
else fail('A1', 'doc missing');

if (/n8n.*pipe|pipe only/i.test(doc) && /Staff API.*brain|brain/i.test(doc)) {
  pass('A2', 'docs state n8n pipe / Staff API brain');
} else {
  fail('A2', 'architecture docs incomplete');
}

for (const flag of FORBIDDEN_BODY_FLAGS) {
  const id = `A3-${flag}`;
  if (doc.includes(flag) && /must not|do not|absent|false/i.test(doc)) {
    pass(id, `docs mention no ${flag}`);
  } else {
    fail(id, `docs missing no-send/write flag guidance for ${flag}`);
  }
}

for (const gate of REQUIRED_GATES) {
  const id = `A4-${gate.split('=')[0]}`;
  if (doc.includes(gate.split('=')[0])) pass(id, `docs list ${gate.split('=')[0]}`);
  else fail(id, `docs missing gate ${gate.split('=')[0]}`);
}

if (doc.includes(DEMO_PHONE_ID)) pass('A5', 'docs include demo phone_number_id');
else fail('A5', 'phone_number_id missing from docs');

if (/rollback|disable|deactivate|inactive/i.test(doc)) pass('A6', 'docs include rollback/disable');
else fail('A6', 'rollback steps missing');

if (/no live send|no write|no Stripe|sends_whatsapp:\s*false|live_send_blocked:\s*true/i.test(doc)) {
  pass('A7', 'docs include expected no-send/no-write/no-Stripe proof');
} else {
  fail('A7', 'expected safety proof missing from docs');
}

if (/27demo-k|live reply through n8n/i.test(doc)) pass('A8', 'docs mention next step 27demo-k');
else fail('A8', 'next step 27demo-k missing');

if (/What are the packages/i.test(doc)) pass('A9', 'docs include proof message');
else fail('A9', 'proof message missing');

if (doc.includes('Luna Open Demo WhatsApp Inbound Review Pipe')) {
  pass('A10', 'docs name n8n workflow');
} else {
  fail('A10', 'workflow name missing from docs');
}

section('B. n8n workflow export');

if (fs.existsSync(WF)) pass('B1', 'n8n workflow JSON exists');
else fail('B1', 'workflow JSON missing');

if (wf && wf.name === 'Luna Open Demo WhatsApp Inbound Review Pipe') {
  pass('B2', 'workflow name matches stage doc');
} else {
  fail('B2', 'workflow name mismatch');
}

if (wf && wf.active === false) pass('B3', 'workflow active:false in repo');
else fail('B3', 'workflow must be inactive in repo');

const nodeBlob = wf ? JSON.stringify(wf.nodes) : '';
if (wf && !/graph\.facebook\.com/i.test(nodeBlob)) pass('B4', 'no graph.facebook.com in workflow');
else fail('B4', 'forbidden Graph API node/url in workflow');

if (wf && !/api\.stripe\.com/i.test(nodeBlob)) pass('B5', 'no api.stripe.com in workflow');
else fail('B5', 'forbidden Stripe URL in workflow');

if (wf && wf.nodes.some((n) => n.type === 'n8n-nodes-base.httpRequest'
  && String(n.parameters?.url || '').includes(OPEN_DEMO_ROUTE))) {
  pass('B6', 'HTTP node targets open-demo inbound dry-run endpoint');
} else {
  fail('B6', 'open-demo Staff API endpoint missing');
}

for (const flag of FORBIDDEN_BODY_FLAGS) {
  if (!nodeBlob.includes(flag)) pass(`B7-${flag}`, `workflow body omits ${flag}`);
  else fail(`B7-${flag}`, `workflow must not include ${flag}`);
}

if (nodeBlob.includes(DEMO_PHONE_ID)) pass('B8', 'workflow guards demo phone_number_id');
else fail('B8', 'phone_number_id guard missing');

if (wf && wf.nodes.every((n) => n.type !== 'n8n-nodes-base.httpRequest'
  || n.credentials?.httpHeaderAuth?.name === 'Luna Bot Internal Token (staging)')) {
  pass('B9', 'HTTP nodes use Luna Bot Internal Token (staging) credential placeholder');
} else {
  fail('B9', 'HTTP credential placeholder missing or wrong');
}

try {
  execSync(`node --check "${WF.replace('.json', '.json')}"`, { stdio: 'pipe' });
} catch { /* json not js */ }

section('C. package.json');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('C1', `${SCRIPT} npm script`);
else fail('C1', `${SCRIPT} npm script missing`);

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
