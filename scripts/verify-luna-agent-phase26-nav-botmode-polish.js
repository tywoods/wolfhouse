/**
 * Phase 26h.10 — Nav labels + bot mode pebble refresh verifier.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-nav-botmode-polish
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26h-10-NAV-BOTMODE-POLISH.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-nav-botmode-polish';

const UPSTREAM = [
  'verify:luna-agent-phase26-service-add-schedule-modes',
  'verify:luna-agent-phase26-inplace-actions-transfer-final-polish',
  'verify:luna-agent-phase26-service-pebbles-transfer-payment-polish',
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

console.log('\nverify-luna-agent-phase26-nav-botmode-polish.js  (Phase 26h.10)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api passes node --check');
} catch {
  fail('0', 'syntax check failed');
}

const apiSrc = readOrEmpty(API);
const doc = readOrEmpty(DOC);
const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
const navSlice = (apiSrc.match(/id="tabs"[\s\S]{0,500}/) || [''])[0];
const pauseSlice = (apiSrc.match(/function wireLunaPauseSwitch[\s\S]{0,2200}/) || [''])[0];
const drawerConvSlice = (apiSrc.match(/function bcDrawerConvModeRowHtml[\s\S]{0,600}/) || [''])[0];
const updateSlice = (apiSrc.match(/function bcUpdateDrawerConvBotModePebble[\s\S]{0,900}/) || [''])[0];
const pauseDetectSlice = (apiSrc.match(/function isLunaGuestAutomationPaused[\s\S]{0,600}/) || [''])[0];

section('A. Navigation labels');

if (/data-tab="conversations">WhatsApp</.test(navSlice)) {
  pass('A1', 'WhatsApp nav label on conversations tab');
} else fail('A1', 'WhatsApp label');
if (/data-tab="ask-luna">Luna Staff</.test(navSlice)) {
  pass('A2', 'Luna Staff nav label on ask-luna tab');
} else fail('A2', 'Luna Staff label');
if (!/data-tab="conversations">Inbox</.test(navSlice) && !/data-tab="ask-luna">Command Center</.test(navSlice)) {
  pass('A3', 'old Inbox / Command Center nav labels removed from tabs');
} else fail('A3', 'old nav labels still present');
if (/data-tab="conversations"/.test(navSlice) && /data-tab="ask-luna"/.test(navSlice)) {
  pass('A4', 'underlying tab ids/routes retained');
} else fail('A4', 'tab routes');

section('B. Conversation / Handoff pebble refresh');

if (/function bcDrawerConvModeRowHtml/.test(drawerConvSlice) && /inboxLunaStaffPill/.test(drawerConvSlice)) {
  pass('B1', 'drawer Conversation card uses bot/staff pebble render');
} else fail('B1', 'pebble render');
if (/function bcUpdateDrawerConvBotModePebble/.test(updateSlice) && /bc-drawer-conv-bot-mode-v/.test(updateSlice)) {
  pass('B2', 'in-place drawer pebble update helper');
} else fail('B2', 'update helper');
if (/bcUpdateDrawerConvBotModePebble/.test(pauseSlice)) {
  pass('B3', 'Pause/Resume handler refreshes drawer pebble');
} else fail('B3', 'pause handler wiring');
if (/pill-staff-source/.test(apiSrc.match(/function inboxLunaStaffPill[\s\S]{0,400}/)?.[0] || '') &&
    /pill-luna/.test(apiSrc.match(/function inboxLunaStaffPill[\s\S]{0,400}/)?.[0] || '')) {
  pass('B4', 'Staff green + Luna blue pebble classes');
} else fail('B4', 'pebble classes');
if (/luna_paused/.test(pauseDetectSlice)) {
  pass('B5', 'pause detection honors luna_paused on context payload');
} else fail('B5', 'luna_paused detection');
if (!/bcRestoreActiveDrawerTab\('overview'\)/.test(updateSlice) &&
    !/loadBlockDetail/.test(updateSlice)) {
  pass('B6', 'pebble update does not force drawer reload/tab reset');
} else fail('B6', 'tab reset on pebble update');

section('C. Safety');

if (!/INSERT INTO payments/.test(pauseSlice) && !/whatsapp.*send|meta.*webhook|n8n/i.test(pauseSlice)) {
  pass('C1', 'no payment/Meta/n8n in pause refresh slice');
} else fail('C1', 'safety');

section('D. Docs + npm');

if (/WhatsApp/.test(doc) && /Luna Staff/.test(doc) && /bcUpdateDrawerConvBotModePebble/.test(doc)) {
  pass('D1', 'doc covers nav + pebble refresh');
} else fail('D1', 'doc');
if (/WHATSAPP_DRY_RUN|no live WhatsApp/i.test(doc)) pass('D2', 'doc staging safety');
else fail('D2', 'doc safety');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('D3', 'npm script registered');
else fail('D3', 'npm script');

section('E. Upstream verifiers');

for (const up of UPSTREAM) {
  try {
    execSync(`npm run ${up}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass(`E-${up}`, `${up} PASS`);
  } catch (e) {
    const out = String(e.stdout || e.stderr || e.message).slice(0, 240);
    fail(`E-${up}`, `${up} FAIL: ${out}`);
  }
}

console.log(`\n── Summary ──`);
console.log(`  PASS: ${passes}`);
console.log(`  FAIL: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
