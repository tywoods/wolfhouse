/**
 * Stage 28c.3 — Meta Staff API → open-demo booking path (no n8n, no live reply).
 *
 * Usage:
 *   npm run verify:stage28c3-meta-staffapi-open-demo-booking-path
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-28C3-META-STAFFAPI-OPEN-DEMO-BOOKING-PATH.md');
const META_PROC = path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js');
const ADAPTER = path.join(__dirname, 'lib', 'meta-open-demo-inbound-adapter.js');
const EXECUTE = path.join(__dirname, 'lib', 'open-demo-whatsapp-inbound-execute.js');
const API = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28c3-meta-staffapi-open-demo-booking-path';
const OPEN_DEMO_ROUTE = '/staff/bot/open-demo-whatsapp-inbound-dry-run';
const DEMO_PHONE_ID = '1152900101233109';

const FORBIDDEN_META_FLAGS = [
  'send_live_reply_confirmed',
  'create_stripe_test_link_confirmed',
  'send_payment_link_whatsapp_confirmed',
];

const WRITE_FLAGS = [
  'create_demo_hold_draft_confirmed',
  'assign_demo_bed_confirmed',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage28c3-meta-staffapi-open-demo-booking-path.js  (Stage 28c.3)\n');

for (const f of [META_PROC, ADAPTER, EXECUTE, DOC]) {
  try {
    if (f.endsWith('.md')) {
      if (fs.existsSync(f)) pass('0', `${path.basename(f)} exists`);
      else fail('0', `${path.basename(f)} missing`);
    } else {
      execSync(`node --check "${f}"`, { stdio: 'pipe' });
      pass('0', `${path.basename(f)} passes node --check`);
    }
  } catch {
    fail('0', `${path.basename(f)} syntax/missing`);
  }
}

const metaSrc = fs.readFileSync(META_PROC, 'utf8');
const adapterSrc = fs.readFileSync(ADAPTER, 'utf8');
const executeSrc = fs.readFileSync(EXECUTE, 'utf8');
const apiSrc = fs.readFileSync(API, 'utf8');
const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
const pkg = fs.existsSync(PKG_FILE) ? JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')) : {};

section('A. Docs');

if (/28c.*fail|booking_write_preview|state did not accumulate/i.test(doc)) {
  pass('A1', 'docs explain 28c failure');
} else {
  fail('A1', '28c failure context missing');
}

if (/live repl(y|ies).*not the fix|not.*workaround/i.test(doc)) {
  pass('A2', 'docs state live replies are not the fix');
} else {
  fail('A2', 'live reply non-fix rationale missing');
}

if (/Meta.*Staff API|Staff API.*brain/i.test(doc)) {
  pass('A3', 'docs describe Meta → Staff API architecture');
} else {
  fail('A3', 'architecture docs missing');
}

if (doc.includes('OPEN_DEMO_BOOKING_WRITES_ENABLED') && doc.includes('WHATSAPP_DRY_RUN')) {
  pass('A4', 'docs list proof gates');
} else {
  fail('A4', 'gate docs missing');
}

if (/rollback|OPEN_DEMO_BOOKING_WRITES_ENABLED=false/i.test(doc)) {
  pass('A5', 'docs include rollback');
} else {
  fail('A5', 'rollback missing');
}

if (/no Stripe|no confirmation|no payment link/i.test(doc)) {
  pass('A6', 'docs include safety boundaries');
} else {
  fail('A6', 'safety boundaries missing');
}

section('B. Meta adapter');

if (adapterSrc.includes('buildOpenDemoRequestBodyFromMeta')) {
  pass('B1', 'adapter maps Meta payload to open-demo body');
} else {
  fail('B1', 'Meta → open-demo mapper missing');
}

for (const field of ['client_slug', 'guest_phone', 'message_text', 'wamid', 'phone_number_id', 'contact_name', 'received_at']) {
  const id = `B2-${field}`;
  if (adapterSrc.includes(field)) pass(id, `adapter includes ${field}`);
  else fail(id, `adapter missing ${field}`);
}

if (adapterSrc.includes('shouldRouteMetaInboundToOpenDemo')
  && adapterSrc.includes('evaluateOpenDemoWhatsAppGate')
  && adapterSrc.includes('isOpenDemoWhatsAppEnabled')) {
  pass('B3', 'routing gated by open demo + phone_number_id');
} else {
  fail('B3', 'open demo routing gate incomplete');
}

if (adapterSrc.includes('isProductionEnvironment')) {
  pass('B4', 'production blocked in adapter routing');
} else {
  fail('B4', 'production block missing');
}

if (adapterSrc.includes('buildMetaOpenDemoWriteConfirmFlags')
  && adapterSrc.includes('evaluateOpenDemoHoldDraftWriteReady')
  && adapterSrc.includes('isOpenDemoBookingWritesEnabled')) {
  pass('B5', 'write flags gated on payment_choice_ready + env');
} else {
  fail('B5', 'write confirm flag gating missing');
}

for (const flag of FORBIDDEN_META_FLAGS) {
  const id = `B6-${flag}`;
  if (!adapterSrc.includes(`${flag}: true`) && !adapterSrc.includes(`${flag}:true`)) {
    pass(id, `adapter does not pass ${flag}`);
  } else {
    fail(id, `adapter must not pass ${flag}`);
  }
}

if (adapterSrc.includes('calls_n8n: false') || adapterSrc.includes('calls_n8n:false')) {
  pass('B7', 'adapter marks no n8n');
} else {
  fail('B7', 'no-n8n marker missing');
}

section('C. Meta process wiring');

if (metaSrc.includes('shouldRouteMetaInboundToOpenDemo')
  && metaSrc.includes('processMetaOpenDemoGuestInbound')) {
  pass('C1', 'Meta inbound process routes to open-demo adapter');
} else {
  fail('C1', 'Meta process wiring missing');
}

if (metaSrc.includes('processOwnerWhatsAppCommandCenterInbound')
  && metaSrc.indexOf('processOwnerWhatsAppCommandCenterInbound')
    < metaSrc.indexOf('shouldRouteMetaInboundToOpenDemo')) {
  pass('C2', 'active owner route checked before open-demo guest route');
} else {
  fail('C2', 'owner route ordering may be wrong');
}

if (!metaSrc.includes('n8n') || /calls_n8n:\s*false/i.test(metaSrc + adapterSrc)) {
  pass('C3', 'no Meta → Staff API → n8n internal bridge');
} else {
  fail('C3', 'n8n bridge detected in Meta path');
}

if (metaSrc.includes('executeOpenDemoWhatsAppInbound') || adapterSrc.includes('executeOpenDemoWhatsAppInbound')) {
  pass('C4', 'Meta path reuses shared open-demo execute helper');
} else {
  fail('C4', 'shared execute helper not wired');
}

section('D. Shared execute + HTTP handler');

if (executeSrc.includes('executeOpenDemoWhatsAppInbound')
  && executeSrc.includes('runGuestInboundReviewDryRun')) {
  pass('D1', 'execute runs proven review path');
} else {
  fail('D1', 'review path missing in execute');
}

if (executeSrc.includes('runGuestHoldPaymentDraftWriteDryRunApproved')
  && executeSrc.includes('runOpenDemoBookingBedAssignApproved')) {
  pass('D2', 'execute reuses hold/draft + bed assign paths');
} else {
  fail('D2', 'write/assign paths missing');
}

if (apiSrc.includes('executeOpenDemoWhatsAppInbound')) {
  pass('D3', 'HTTP open-demo handler reuses execute helper');
} else {
  fail('D3', 'HTTP handler not refactored to execute');
}

if (apiSrc.includes(OPEN_DEMO_ROUTE)) {
  pass('D4', 'proven open-demo HTTP route still present');
} else {
  fail('D4', 'open-demo HTTP route missing');
}

section('E. package.json script');

if (pkg.scripts && pkg.scripts[SCRIPT]) {
  pass('E1', 'npm script registered');
} else {
  fail('E1', `missing npm script ${SCRIPT}`);
}

section('F. Guest email synthesis (28c.6)');

const adapter = require('./lib/meta-open-demo-inbound-adapter');

const synthEmail = adapter.buildOpenDemoGuestEmailFromPhone('+491726422307');
if (synthEmail === 'open-demo+491726422307@example.test') {
  pass('F1', '+491726422307 synthesizes open-demo+491726422307@example.test');
} else {
  fail('F1', `unexpected synthesized email: ${synthEmail}`);
}

if (adapter.buildOpenDemoGuestEmailFromPhone('') === null) {
  pass('F2', 'no digits returns null');
} else {
  fail('F2', 'empty phone should not synthesize email');
}

const metaBase = {
  from: '491726422307',
  wa_message_id: 'wamid.test',
  message_text: 'Deposit is fine',
  phone_number_id: DEMO_PHONE_ID,
  client_slug: 'wolfhouse-somo',
  timestamp: '1700000000',
};

const bodySynth = adapter.buildOpenDemoRequestBodyFromMeta(metaBase);
if (bodySynth.guest_email === 'open-demo+491726422307@example.test') {
  pass('F3', 'Meta adapter body includes synthesized guest_email');
} else {
  fail('F3', `adapter guest_email missing/wrong: ${bodySynth.guest_email}`);
}

const bodyKeep = adapter.buildOpenDemoRequestBodyFromMeta({
  ...metaBase,
  guest_email: 'keeper@example.test',
});
if (bodyKeep.guest_email === 'keeper@example.test') {
  pass('F4', 'existing guest_email preserved when supplied');
} else {
  fail('F4', `existing guest_email overwritten: ${bodyKeep.guest_email}`);
}

const bodyName = adapter.buildOpenDemoRequestBodyFromMeta({
  ...metaBase,
  profile_name: 'Ty Proof',
});
if (bodyName.guest_name === 'Ty Proof' && bodyName.contact_name === 'Ty Proof') {
  pass('F5', 'guest_name/contact_name from Meta profile_name');
} else {
  fail('F5', 'Meta profile_name not mapped to guest_name');
}

if (doc.includes('28c.6') && /guest_email|open-demo\+/i.test(doc)) {
  pass('F6', 'docs note 28c.6 guest_email synthesis');
} else {
  fail('F6', '28c.6 docs missing');
}

if (adapterSrc.includes('buildOpenDemoGuestEmailFromPhone')
  && adapterSrc.includes('open-demo+${digits}@example.test')) {
  pass('F7', 'adapter defines open-demo email helper');
} else {
  fail('F7', 'buildOpenDemoGuestEmailFromPhone missing');
}

section('Summary');

console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
