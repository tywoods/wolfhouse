/**
 * Staff Inbox + Booking Calendar UI polish verifier.
 *
 * Usage:
 *   npm run verify:staff-inbox-calendar-ui-polish
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

console.log('\nverify-staff-inbox-calendar-ui-polish.js\n');

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

const nhToggleMatch = src.match(/function wireNeedsHumanToggle\([\s\S]*?\n\}/);
const pauseSwitchMatch = src.match(/function wireLunaPauseSwitch\([\s\S]*?\n\}/);

section('A. Left list wheel scroll');

if (/\.inbox-left-rows\{[^}]*overflow-y:\s*auto/.test(htmlSrc)) pass('A1', 'inbox-left-rows overflow-y auto');
else fail('A1', 'inbox-left-rows scroll missing');

if (/function wireInboxLeftListWheel/.test(src)) pass('A2', 'wheel handler helper present');
else fail('A2', 'wireInboxLeftListWheel missing');

if (/wireInboxLeftListWheel\s*\(\s*\)/.test(src)) pass('A3', 'wheel handler wired on init');
else fail('A3', 'wheel handler not initialized');

if (/\.inbox-left-toolbar\{[^}]*flex-shrink:\s*0/.test(htmlSrc)) pass('A4', 'filters outside scroll area');
else fail('A4', 'toolbar flex-shrink missing');

section('B. Conversation detail loading state');

if (/function beginConvDetailLoad/.test(src)) pass('B1', 'beginConvDetailLoad helper');
else fail('B1', 'beginConvDetailLoad missing');

if (!loadDetailJs.includes("innerHTML = '<div class=\"state-msg\">Loading")) {
  pass('B2', 'no full-pane Loading state-msg on switch');
} else fail('B2', 'still replaces pane with Loading state-msg');

if (/convDetailHasLayout/.test(loadDetailJs) && /is-loading-detail/.test(loadDetailJs)) {
  pass('B3', 'preserves layout with loading class');
} else fail('B3', 'layout-preserving load missing');

if (/function buildConvDetailSkeleton/.test(src)) pass('B4', 'skeleton layout for first load');
else fail('B4', 'skeleton missing');

section('C. Inbox labels and links');

if (/Open Booking in Calendar/.test(loadDetailJs)) pass('C1', 'Open Booking in Calendar text');
else fail('C1', 'new calendar link text missing');

if (!/Open in Booking Calendar/.test(loadDetailJs)) pass('C2', 'old calendar link text removed');
else fail('C2', 'old Open in Booking Calendar still present');

if (!/<h3>Reply<\/h3>/.test(loadDetailJs)) pass('C3', 'Reply heading removed');
else fail('C3', 'Reply h3 still present');

if (/Review and send reply/.test(loadDetailJs)) pass('C4', 'Review and send reply retained');
else fail('C4', 'Review and send reply missing');

section('D. Booking Calendar Open Conversation');

if (/id=["']bc-open-conversation-toolbar["']/.test(src)) pass('D1', 'toolbar Open Conversation button');
else fail('D1', 'toolbar button missing');

if (/btn-success-light/.test(htmlSrc) && /Open Conversation/.test(src)) pass('D2', 'soft green Open Conversation style');
else fail('D2', 'btn-success-light / label missing');

if (/function bcOpenConversationFromBooking/.test(src) && /openInboxToConversation/.test(src.match(/function bcOpenConversationFromBooking[\s\S]*?\n\}/)?.[0] || '')) {
  pass('D3', 'opens Inbox conversation path');
} else fail('D3', 'Inbox open path missing');

if (/No conversation found for this booking/.test(src)) pass('D4', 'friendly not-found status');
else fail('D4', 'not-found message missing');

if (/id=["']bc-open-conv-btn["']/.test(src.match(/Conversation \/ Handoff[\s\S]{0,900}/)?.[0] || '')) {
  pass('D5', 'handoff section uses Open Conversation button');
} else fail('D5', 'handoff section button missing');

if (/bcWireOpenConversationButtons/.test(src)) pass('D6', 'shared wiring helper');
else fail('D6', 'bcWireOpenConversationButtons missing');

section('E. Switch handlers unchanged (no reload)');

const pauseJs = pauseSwitchMatch ? pauseSwitchMatch[0] : '';
const nhJs = nhToggleMatch ? nhToggleMatch[0] : '';
if (!pauseJs.includes('loadConvDetail')) pass('E1', 'Pause Luna still in-place');
else fail('E1', 'Pause Luna regressed to loadConvDetail');
if (!nhJs.includes('loadConvDetail') && !nhJs.includes('loadInbox')) pass('E2', 'Needs human still in-place');
else fail('E2', 'Needs human regressed to full reload');

section('F. Safety');

const openCalJs = src.match(/function openBookingInCalendar\([\s\S]*?\n\}/)?.[0] || '';
if (!openCalJs.includes('/staff/bot/guest-reply-send') && !loadDetailJs.includes('/staff/bot/guest-reply-send')) {
  pass('F1', 'no guest-reply-send in inbox UI paths');
} else fail('F1', 'guest-reply-send in UI');

if (!/api\.stripe\.com/.test(htmlSrc) && !/graph\.facebook\.com/.test(htmlSrc)) pass('F2', 'no Stripe/Graph');
else fail('F2', 'Stripe or Graph found');

section('G. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:staff-inbox-calendar-ui-polish']) pass('G1', 'npm script registered');
else fail('G1', 'npm script missing');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
