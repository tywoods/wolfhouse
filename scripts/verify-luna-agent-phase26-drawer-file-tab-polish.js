/**
 * Phase 26g.2 — Verifier for file-folder drawer tabs + transfer breathing room.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-drawer-file-tab-polish
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26g-2-DRAWER-FILE-TAB-POLISH.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-drawer-file-tab-polish';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const UPSTREAM = [
  'verify:luna-agent-phase26-drawer-ui-polish',
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

console.log('\nverify-luna-agent-phase26-drawer-file-tab-polish.js  (Phase 26g.2)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api passes node --check');
} catch {
  fail('0', 'syntax check failed');
}

const apiSrc = readOrEmpty(API);
const drawerSlice = (apiSrc.match(/function renderBookingContextDrawer[\s\S]{0,16000}/) || [''])[0];
const servicesSlice = (apiSrc.match(/function bcRenderServicesTabHtml[\s\S]{0,1200}/) || [''])[0];
const transferSlice = (apiSrc.match(/function bcRenderTransferDetailsShell[\s\S]{0,800}/) || [''])[0];
const invoiceSlice = (apiSrc.match(/function bcRenderRunningInvoiceHtml[\s\S]{0,1200}/) || [''])[0];
const tabInitSlice = (apiSrc.match(/function bcInitDrawerTabs[\s\S]{0,2200}/) || [''])[0];

section('A. File-folder tabs');

for (const [id, label] of [['A1', 'Overview'], ['A2', 'Services'], ['A3', 'Transfers'], ['A4', 'Payments']]) {
  if (new RegExp(`bcDrawerTabBtn\\('${label.toLowerCase()}', '${label}'`).test(apiSrc)) {
    pass(id, `${label} tab label`);
  } else fail(id, `${label} tab missing`);
}
if (/bc-drawer-file-tabs/.test(apiSrc) && /bc-drawer-tab-content-panel/.test(apiSrc)) {
  pass('A5', 'file-tab shell + connected content panel');
} else fail('A5', 'file-tab structure');
if (/\.bc-drawer-tab\.is-active[\s\S]{0,260}var\(--surface-soft\)/.test(apiSrc)) {
  pass('A6', 'active tab blends into panel background');
} else fail('A6', 'active tab panel blend');
if (/border-radius:10px 10px 0 0/.test(apiSrc) && /margin-bottom:-1px/.test(apiSrc)) {
  pass('A7', 'file-folder tab corner + connect styling');
} else fail('A7', 'folder tab CSS');

section('B. Unified panel + Overview colors');

if (/\.bc-drawer-tab-content-panel[\s\S]{0,220}background:var\(--surface-soft\)/.test(apiSrc)) {
  pass('B1', 'unified soft panel background');
} else fail('B1', 'panel background');
if (/min-height:680px/.test(apiSrc)) pass('B2', 'content panel min-height against collapse');
else fail('B2', 'panel min-height');
if (/\.bc-drawer-overview-card[\s\S]{0,180}background:var\(--surface\)/.test(apiSrc)) {
  pass('B3', 'Overview cards use softer cream, not dark tan');
} else fail('B3', 'overview card colors');
if (!/\.bc-drawer-overview-card[\s\S]{0,120}#F8F0E2/.test(apiSrc)) {
  pass('B4', 'old dark tan overview card color removed');
} else fail('B4', 'dark tan still present');

section('C. Duplicate titles removed');

if (!/<h3>Services<\/h3>/.test(servicesSlice)) pass('C1', 'duplicate Services h3 removed');
else fail('C1', 'Services h3 remains');
if (!/Flight \/ Transfer Details/.test(transferSlice)) pass('C2', 'Flight / Transfer Details removed from body');
else fail('C2', 'transfer header remains');
if (!/Lookup uses booking check-in\/check-out dates/.test(transferSlice)) {
  pass('C3', 'lookup helper sentence removed');
} else fail('C3', 'lookup helper remains');
if (!/<h3>Payment<\/h3>/.test(invoiceSlice)) pass('C4', 'duplicate PAYMENT h3 removed');
else fail('C4', 'Payment h3 remains');

section('D. Kept subsections');

if (/Arrival transfer|bcRenderTransferCard\('arrival'/.test(apiSrc)) pass('D1', 'Arrival transfer heading');
else fail('D1', 'arrival heading');
if (/Departure transfer|bcRenderTransferCard\('departure'/.test(apiSrc)) pass('D2', 'Departure transfer heading');
else fail('D2', 'departure heading');
if (/Payment history|ctx-inv-subtitle">Payment history/.test(apiSrc)) pass('D3', 'Payment history subsection');
else fail('D3', 'payment history');
if (/Service schedule|bc-svc-schedule-section/.test(apiSrc)) pass('D4', 'Service schedule section');
else fail('D4', 'service schedule');
if (/Unscheduled services|bc-svc-unscheduled/.test(apiSrc)) pass('D5', 'Unscheduled services section');
else fail('D5', 'unscheduled section');

section('E. Transfers tab breathing room');

if (/bc-transfer-tab-spacer/.test(transferSlice) && /height:280px/.test(apiSrc)) {
  pass('E1', 'transfer tab bottom spacer (~280px)');
} else fail('E1', 'spacer missing');
if (/background:transparent/.test(apiSrc.match(/\.bc-transfer-tab-spacer[\s\S]{0,120}/)?.[0] || '')) {
  pass('E2', 'spacer uses transparent fill inside beige panel');
} else fail('E2', 'spacer background');
if (transferSlice.indexOf('bc-transfer-tab-spacer') > transferSlice.indexOf('bc-transfer-cards')) {
  pass('E3', 'spacer sits below transfer cards');
} else fail('E3', 'spacer placement');
if (!/bc-transfer-tab-spacer[\s\S]{0,80}border:/.test(apiSrc)) {
  pass('E4', 'spacer has no debug/border styling');
} else fail('E4', 'spacer border');
if (/data-tab="transfers"[\s\S]{0,120}min-height:640px/.test(apiSrc)) {
  pass('E5', 'transfers panel min-height');
} else fail('E5', 'transfers min-height');

section('F. Tab no-jump behavior');

if (/mousedown[\s\S]{0,80}preventDefault/.test(tabInitSlice) && /scrollTo\(0, winY\)/.test(tabInitSlice)) {
  pass('F1', '26g.1 scroll preservation still wired');
} else fail('F1', 'scroll fix');

section('G. Docs + npm');

const doc = readOrEmpty(DOC);
if (/file-folder|file folder/i.test(doc) && /content panel/i.test(doc)) pass('G1', 'doc file tabs');
else fail('G1', 'doc tabs');
if (/duplicate|removed/i.test(doc) && /Transfers tab bottom|breathing room/i.test(doc)) {
  pass('G2', 'doc titles + spacer');
} else fail('G2', 'doc content');

const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('G3', 'npm script registered');
else fail('G3', 'npm script');

section('H. Safety');

if (!/handleGetBookingServices|dispatchBookingServicesRoute/.test(
  apiSrc.match(/Phase 26g\.2[\s\S]{0,4000}/)?.[0] || '',
)) {
  pass('H1', 'no new backend route changes in polish slice');
} else fail('H1', 'backend touched');
if (!/handlePostBookingService|upsertBookingService/.test(
  apiSrc.match(/bc-drawer-file-tabs[\s\S]{0,8000}/)?.[0] || '',
)) pass('H2', 'no service write handlers');
else fail('H2', 'service writes');

for (const f of GUEST_UNTOUCHED) {
  const base = path.basename(f);
  const src = readOrEmpty(f);
  if (!/bc-drawer-file-tabs|bc-transfer-tab-spacer/.test(src)) pass(`H.${base}`, `${base} unchanged`);
  else fail(`H.${base}`, `${base} touched`);
}

section('I. Upstream verifiers');

for (const script of UPSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 180000 });
    pass('I.' + script, `${script} still passes`);
  } catch {
    fail('I.' + script, `${script} failed`);
  }
}

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
