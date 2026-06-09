/**
 * Stage 27demo-l — Verifier for n8n open demo booking write pipe docs + workflow.
 *
 * Usage:
 *   npm run verify:stage27demo-l-n8n-booking-write
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-27DEMO-L-N8N-BOOKING-WRITE-CALENDAR.md');
const WF = path.join(ROOT, 'n8n', 'Luna Open Demo WhatsApp Booking Write Pipe.json');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27demo-l-n8n-booking-write';
const DEMO_PHONE_ID = '1152900101233109';
const OPEN_DEMO_ROUTE = '/staff/bot/open-demo-whatsapp-inbound-dry-run';

const FORBIDDEN_FLAGS = [
  'send_live_reply_confirmed',
  'create_stripe_test_link_confirmed',
  'send_payment_link_whatsapp_confirmed',
];

const REQUIRED_WRITE_FLAGS = [
  'create_demo_hold_draft_confirmed',
  'assign_demo_bed_confirmed',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27demo-l-n8n-booking-write.js  (Stage 27demo-l)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
let wf = null;
try {
  wf = fs.existsSync(WF) ? JSON.parse(fs.readFileSync(WF, 'utf8')) : null;
} catch {
  wf = null;
}

section('A. Docs');

if (fs.existsSync(DOC)) pass('A1', 'STAGE-27DEMO-L doc exists');
else fail('A1', 'doc missing');

if (/n8n.*pipe|pipe only/i.test(doc) && /Staff API.*brain|brain/i.test(doc)) {
  pass('A2', 'docs state n8n pipe / Staff API brain');
} else {
  fail('A2', 'architecture docs incomplete');
}

for (const flag of REQUIRED_WRITE_FLAGS) {
  if (doc.includes(flag)) pass(`A3-${flag}`, `docs include ${flag}`);
  else fail(`A3-${flag}`, `docs missing ${flag}`);
}

for (const flag of FORBIDDEN_FLAGS) {
  if (doc.includes(flag) && /must not|forbid|do not|absent/i.test(doc)) {
    pass(`A4-${flag}`, `docs forbid ${flag}`);
  } else {
    fail(`A4-${flag}`, `docs missing forbid guidance for ${flag}`);
  }
}

if (doc.includes('OPEN_DEMO_BOOKING_WRITES_ENABLED')) pass('A5', 'docs list booking write gate');
else fail('A5', 'booking write gate missing');

if (/rollback|restore|deactivate/i.test(doc)) pass('A6', 'docs include rollback');
else fail('A6', 'rollback missing');

if (/calendar|assigned_bed|booking_code|write_status/i.test(doc)) {
  pass('A7', 'docs include calendar/write proof expectations');
} else {
  fail('A7', 'calendar proof expectations missing');
}

if (/27demo-m|Stripe TEST link through n8n/i.test(doc)) pass('A8', 'docs mention next step 27demo-m');
else fail('A8', 'next step 27demo-m missing');

if (doc.includes('open-demo-whatsapp-booking-write-27l')) pass('A9', 'docs include webhook path');
else fail('A9', 'webhook path missing');

section('B. n8n workflow');

if (fs.existsSync(WF)) pass('B1', 'workflow JSON exists');
else fail('B1', 'workflow missing');

if (wf && wf.name === 'Luna Open Demo WhatsApp Booking Write Pipe') pass('B2', 'workflow name');
else fail('B2', 'workflow name mismatch');

if (wf && wf.active === false) pass('B3', 'active:false in repo');
else fail('B3', 'must be inactive in repo');

const nodeBlob = wf ? JSON.stringify(wf.nodes) : '';

if (!/graph\.facebook\.com/i.test(nodeBlob)) pass('B4', 'no graph.facebook.com');
else fail('B4', 'forbidden Graph API');

if (!/api\.stripe\.com/i.test(nodeBlob)) pass('B5', 'no api.stripe.com');
else fail('B5', 'forbidden Stripe URL');

for (const flag of REQUIRED_WRITE_FLAGS) {
  if (nodeBlob.includes(flag)) pass(`B6-${flag}`, `workflow includes ${flag}`);
  else fail(`B6-${flag}`, `workflow missing ${flag}`);
}

for (const flag of FORBIDDEN_FLAGS) {
  if (!nodeBlob.includes(flag)) pass(`B7-${flag}`, `workflow omits ${flag}`);
  else fail(`B7-${flag}`, `workflow must not include ${flag}`);
}

if (nodeBlob.includes(DEMO_PHONE_ID)) pass('B8', 'phone_number_id guard');
else fail('B8', 'phone_number_id guard missing');

if (nodeBlob.includes('guest_context') && nodeBlob.includes('slim_guest_context_for_next_turn')) {
  pass('B9', 'multi-turn guest_context support');
} else {
  fail('B9', 'guest_context chaining missing');
}

if (wf && wf.nodes.some((n) => String(n.parameters?.url || '').includes(OPEN_DEMO_ROUTE))) {
  pass('B10', 'HTTP targets open-demo endpoint');
} else {
  fail('B10', 'open-demo endpoint missing');
}

section('C. package.json');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('C1', `${SCRIPT} npm script`);
else fail('C1', `${SCRIPT} missing`);

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
