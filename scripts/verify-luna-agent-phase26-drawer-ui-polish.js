/**
 * Phase 26g.1 — Verifier for booking drawer tab polish + Overview cards.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-drawer-ui-polish
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26g-1-DRAWER-UI-POLISH.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-drawer-ui-polish';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const UPSTREAM = [
  'verify:luna-agent-phase26-services-tab-schedule',
  'verify:luna-agent-phase26-booking-drawer-tabs-diagnostics',
  'verify:luna-agent-phase26-transfer-ui-cleanup',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase26-drawer-ui-polish.js  (Phase 26g.1)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api passes node --check');
} catch {
  fail('0', 'syntax check failed');
}

const apiSrc = readOrEmpty(API);
const drawerSlice = (apiSrc.match(/function renderBookingContextDrawer[\s\S]{0,14000}/) || [''])[0];
const paymentBriefSlice = (apiSrc.match(/function bcRenderPaymentSummaryBriefHtml[\s\S]{0,1800}/) || [''])[0];
const footerSlice = (apiSrc.match(/function bcRenderBookingDrawerFooterHtml[\s\S]{0,1200}/) || [''])[0];
const tabInitSlice = (apiSrc.match(/function bcInitDrawerTabs[\s\S]{0,2200}/) || [''])[0];

section('A. Tab controls + labels');

if (/function bcDrawerTabBtn[\s\S]{0,200}type="button"/.test(apiSrc)) {
  pass('A1', 'tab controls are buttons, not anchor links');
} else fail('A1', 'tab button type missing');
if (!/<a[^>]+bc-drawer-tab|href="#bc-drawer-tab/.test(apiSrc)) {
  pass('A2', 'no anchor-based drawer tabs');
} else fail('A2', 'anchor tabs found');
for (const [id, label] of [['A3', 'Overview'], ['A4', 'Services'], ['A5', 'Transfers'], ['A6', 'Payments']]) {
  if (new RegExp(`bcDrawerTabBtn\\('${label.toLowerCase()}', '${label}'`).test(apiSrc)) {
    pass(id, `${label} tab label present`);
  } else fail(id, `${label} tab missing`);
}
if (!/bcDrawerTabBtn\('[^']+', 'Add-ons'/.test(apiSrc)) {
  pass('A7', 'Add-ons is not the primary tab label');
} else fail('A7', 'Add-ons tab label');

section('B. Tab styling');

if (/\.bc-drawer-tab[\s\S]{0,180}font-size:14px/.test(apiSrc)) {
  pass('B1', 'larger tab label styling (~14px)');
} else fail('B1', 'tab font size');
if (/\.bc-drawer-tab[\s\S]{0,220}padding:9px 16px/.test(apiSrc)) {
  pass('B2', 'increased tab padding');
} else fail('B2', 'tab padding');
if (/\.bc-drawer-tab\.is-active[\s\S]{0,220}border-color:var\(--tan\)/.test(apiSrc)) {
  pass('B3', 'active tab accent styling');
} else fail('B3', 'active tab styling');
if (/\.bc-drawer-tab:hover/.test(apiSrc)) pass('B4', 'tab hover state');
else fail('B4', 'tab hover');

section('C. Scroll / jump fix');

if (/mousedown[\s\S]{0,80}preventDefault/.test(tabInitSlice) && /click[\s\S]{0,120}preventDefault/.test(tabInitSlice)) {
  pass('C1', 'tab click uses preventDefault');
} else fail('C1', 'preventDefault missing');
if (/window\.scrollY|pageYOffset/.test(tabInitSlice) && /scrollTo\(0, winY\)/.test(tabInitSlice)) {
  pass('C2', 'preserves window scroll on tab switch');
} else fail('C2', 'window scroll preservation');
if (/bc-ctx-body/.test(tabInitSlice) && /ctxScroll/.test(tabInitSlice)) {
  pass('C3', 'preserves drawer body scroll');
} else fail('C3', 'ctx body scroll preservation');
if (!/location\.hash|scrollIntoView/.test(tabInitSlice)) {
  pass('C4', 'tab init avoids hash/scrollIntoView jumps');
} else fail('C4', 'scroll jump helpers in tab init');

section('D. Overview cards');

const cards = [
  ['D1', 'bc-drawer-card-booking', 'Booking details', drawerSlice],
  ['D2', 'bc-payment-summary-brief', 'Payment summary', paymentBriefSlice],
  ['D3', 'bc-move-bed', 'Move bed', drawerSlice],
  ['D4', 'bc-drawer-card-conversation', 'Conversation / Handoff', drawerSlice],
];
for (const [id, elId, title, slice] of cards) {
  if (slice.includes(elId) && slice.includes(title)) pass(id, `${title} card`);
  else fail(id, `${title} card missing`);
}
if (/bc-drawer-overview-card/.test(apiSrc) && /#F8F0E2|#ECDCC4/.test(apiSrc)) {
  pass('D5', 'beige/tan overview card styling');
} else fail('D5', 'card styling');
if (/Full payment history is in the Payments tab/.test(apiSrc)) {
  pass('D6', 'payment summary note in Overview');
} else fail('D6', 'payment summary note');
if (/bc-cancel-reservation-btn/.test(footerSlice) && /bcRenderBookingDrawerFooterHtml/.test(drawerSlice)) {
  pass('D7', 'cancel reservation remains accessible in footer');
} else fail('D7', 'cancel footer');

section('E. Tab placement unchanged');

if (/bcRenderPaymentSummaryBriefHtml/.test(drawerSlice) && /bc-drawer-tab-overview/.test(drawerSlice)) {
  pass('E1', 'brief payment summary stays in Overview');
} else fail('E1', 'overview payment summary');
if (/bcRenderRunningInvoiceHtml/.test(drawerSlice) && /bc-drawer-tab-payments/.test(drawerSlice)) {
  pass('E2', 'full payment section in Payments tab');
} else fail('E2', 'payments tab');
if (/bc-drawer-tab-transfers[\s\S]{0,500}bcRenderTransferDetailsShell/.test(drawerSlice)) {
  pass('E3', 'Flight / Transfer Details in Transfers tab');
} else fail('E3', 'transfers tab');
if (/bcRenderServicesTabHtml/.test(drawerSlice) && /bc-svc-schedule-section|bcInitServicesScheduleShell/.test(apiSrc)) {
  pass('E4', 'Services tab retains 26g schedule sections');
} else fail('E4', 'services tab schedule');

section('F. Docs + npm');

const doc = readOrEmpty(DOC);
if (/tab styling|pill|beige|tan/i.test(doc)) pass('F1', 'doc tab styling');
else fail('F1', 'doc tabs');
if (/scroll jump|no scroll|preserve/i.test(doc)) pass('F2', 'doc scroll behavior');
else fail('F2', 'doc scroll');
if (/Overview cards|Booking details|Payment summary|Move bed|Conversation/i.test(doc)) {
  pass('F3', 'doc overview cards');
} else fail('F3', 'doc cards');
if (/no.*write|UI polish/i.test(doc)) pass('F4', 'doc safety');
else fail('F4', 'doc safety');

const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('F5', 'npm script registered');
else fail('F5', 'npm script');

section('G. Safety');

if (!/handlePostBookingService|upsertBookingService|deleteBookingService/.test(apiSrc.match(/Phase 26g[\s\S]{0,8000}/)?.[0] || '')) {
  pass('G1', 'no new service write handlers in polish slice');
} else fail('G1', 'service writes');
if (!apiSrc.match(/function bcInitDrawerTabs[\s\S]{0,2200}\bstripe\b/i)) {
  pass('G2', 'tab polish has no Stripe');
} else fail('G2', 'Stripe in tab init');

for (const f of GUEST_UNTOUCHED) {
  const base = path.basename(f);
  const src = readOrEmpty(f);
  if (!/bc-drawer-overview-card|bcInitDrawerTabs/.test(src)) pass(`G.${base}`, `${base} unchanged`);
  else fail(`G.${base}`, `${base} touched`);
}

section('H. Upstream verifiers');

for (const script of UPSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 180000 });
    pass('H.' + script, `${script} still passes`);
  } catch {
    fail('H.' + script, `${script} failed`);
  }
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
