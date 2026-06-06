/**
 * Staff Inbox UI controls — Bot State switches, left scroll, Enter-to-send.
 *
 * Usage:
 *   npm run verify:staff-inbox-ui-controls
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(ROOT, 'package.json');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-staff-inbox-ui-controls.js\n');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api.js passes node --check');
} catch {
  fail('0', 'staff-query-api.js syntax error');
}

const src = fs.readFileSync(API_FILE, 'utf8');
const htmlMatch = src.match(/function buildUiHtml\(port\)\s*\{([\s\S]*?)^function handleUI/m);
const htmlSrc = htmlMatch ? htmlMatch[1] : src;

const loadDetailMatch = src.match(/function loadConvDetail\(convId[\s\S]*?function wireNeedsHumanToggle\(/);
const loadDetailJs = loadDetailMatch ? loadDetailMatch[0] : '';

const sendJsMatch = src.match(/function performInboxSend\([\s\S]*?function wireInboxSendReply\([\s\S]*?function loadConvDetail\(/);
const sendJs = sendJsMatch ? sendJsMatch[0] : '';

const pauseSwitchMatch = src.match(/function wireLunaPauseSwitch\([\s\S]*?\n\}/);
const pauseSwitchJs = pauseSwitchMatch ? pauseSwitchMatch[0] : '';

const nhToggleMatch = src.match(/function wireNeedsHumanToggle\([\s\S]*?\n\}/);
const nhToggleJs = nhToggleMatch ? nhToggleMatch[0] : '';

section('A. Top-right Needs human control removed');

if (!/nh-toggle-wrap/.test(src)) pass('A1', 'nh-toggle-wrap removed');
else fail('A1', 'nh-toggle-wrap still present');

if (!loadDetailJs.includes('conv-needs-human-wrap')) pass('A2', 'header floating needs-human wrap removed');
else fail('A2', 'conv-needs-human-wrap still in detail header');

section('B. Bot State switches');

if (/bot-state-switches/.test(loadDetailJs)) pass('B1', 'bot-state-switches block in Bot State card');
else fail('B1', 'bot-state-switches missing');

if (/id=["']conv-needs-human-toggle["']/.test(loadDetailJs) && /inbox-switch-orange/.test(loadDetailJs)) {
  pass('B2', 'Needs human switch in Bot State with orange styling');
} else fail('B2', 'Needs human orange switch missing from Bot State');

if (/id=["']luna-pause-switch["']/.test(loadDetailJs) && /inbox-switch-red/.test(loadDetailJs)) {
  pass('B3', 'Pause Luna switch in Bot State with red styling');
} else fail('B3', 'Pause Luna red switch missing from Bot State');

if (/Needs human/.test(loadDetailJs) && /Pause Luna/.test(loadDetailJs)) {
  pass('B4', 'switch labels present');
} else fail('B4', 'switch labels missing');

if (!/btn-luna-pause|btn-luna-resume/.test(loadDetailJs)) {
  pass('B5', 'pause/resume buttons removed from Bot State');
} else fail('B5', 'legacy pause/resume buttons still present');

section('C. Switch wiring');

if (/function wireLunaPauseSwitch/.test(src)) pass('C1', 'wireLunaPauseSwitch helper present');
else fail('C1', 'wireLunaPauseSwitch missing');

if (pauseSwitchJs.includes('/staff/bot/pause') && pauseSwitchJs.includes('/staff/bot/resume')) {
  pass('C2', 'pause switch uses pause/resume routes');
} else fail('C2', 'pause switch route wiring missing');

if (nhToggleJs.includes('/needs-human')) pass('C3', 'needs human switch uses needs-human route');
else fail('C3', 'needs human route missing');

if (!pauseSwitchJs.includes('send-reply') && !nhToggleJs.includes('send-reply')) {
  pass('C4', 'switches not tied to send action');
} else fail('C4', 'switch incorrectly wired to send');

section('D. Left panel title + scroll');

if (!/<h2>\s*Inbox\s*<\/h2>/.test(htmlSrc) && !/inbox-left-toolbar[\s\S]{0,200}<h2>Inbox/.test(htmlSrc)) {
  pass('D1', 'Inbox left title removed');
} else fail('D1', 'Inbox h2 title still present');

if (/\.inbox-left-scroll\{[^}]*flex:\s*1/.test(htmlSrc)) pass('D2', 'inbox-left-scroll flex grow');
else fail('D2', 'inbox-left-scroll wrapper missing');

if (/\.conv-list\{[^}]*overflow-y:\s*auto/.test(htmlSrc)) pass('D3', 'conv-list overflow-y auto');
else fail('D3', 'conv-list scroll missing');

if (/\.inbox-left\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/.test(htmlSrc)) {
  pass('D4', 'inbox-left flex column');
} else fail('D4', 'inbox-left flex column missing');

section('E. Center thread scroll retained');

if (/\.thread\{[^}]*overflow-y:\s*auto/.test(htmlSrc)) pass('E1', 'thread overflow-y auto retained');
else fail('E1', 'thread scroll missing');

if (/\.draft-panel\{[^}]*flex-shrink:\s*0/.test(htmlSrc)) pass('E2', 'draft panel pinned');
else fail('E2', 'draft panel flex-shrink missing');

section('F. Enter-to-send');

if (sendJs.includes('performInboxSend')) pass('F1', 'performInboxSend helper extracted');
else fail('F1', 'performInboxSend missing');

if (/keydown/.test(sendJs) && /ev\.key\s*!==\s*['"]Enter['"]/.test(sendJs)) {
  pass('F2', 'Enter keydown handler on textarea');
} else fail('F2', 'Enter keydown handler missing');

if (/ev\.shiftKey/.test(sendJs) && /preventDefault/.test(sendJs)) {
  pass('F3', 'Shift+Enter newline; Enter preventDefault');
} else fail('F3', 'Shift+Enter / preventDefault missing');

if (/performInboxSend\(/.test(sendJs)) pass('F4', 'Enter triggers performInboxSend');
else fail('F4', 'Enter does not call send handler');

if (/sendBtn\.disabled/.test(sendJs) && /\.trim\(\)/.test(sendJs)) {
  pass('F5', 'guards for in-flight send and empty textarea');
} else fail('F5', 'send guards missing');

if (!/DOMContentLoaded[\s\S]{0,400}performInboxSend/.test(src) && !/loadConvDetail[\s\S]{0,120}performInboxSend/.test(src)) {
  pass('F6', 'no send on page load');
} else fail('F6', 'possible auto-send on load');

section('G. Send route safety');

if (sendJs.includes('/staff/inbox/send-reply')) pass('G1', '/staff/inbox/send-reply still used');
else fail('G1', 'send route missing');

if (!sendJs.includes('/staff/bot/guest-reply-send')) pass('G2', 'no direct guest-reply-send from UI');
else fail('G2', 'guest-reply-send found in UI send path');

if (!/api\.stripe\.com/.test(htmlSrc) && !/graph\.facebook\.com/.test(htmlSrc)) {
  pass('G3', 'no Stripe/Graph in inbox UI');
} else fail('G3', 'Stripe or Graph found');

if (!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(htmlSrc))) {
  pass('G4', 'no n8n fetch in inbox UI');
} else fail('G4', 'n8n fetch found');

section('H. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:staff-inbox-ui-controls']) {
  pass('H1', 'npm script registered');
} else fail('H1', 'npm script missing');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
