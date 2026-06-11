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
const bookingStackJs = src.match(/function renderInboxBookingStackItemHtml[\s\S]*?\n\}/)?.[0] || '';
const openConvJs = src.match(/function bcOpenOrStartConversationFromBooking[\s\S]*?\n\}/)?.[0] || '';

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

if (/Open Booking in Calendar/.test(bookingStackJs + loadDetailJs)) pass('C1', 'Open Booking in Calendar text');
else fail('C1', 'new calendar link text missing');

if (!/Open in Booking Calendar/.test(loadDetailJs)) pass('C2', 'old calendar link text removed');
else fail('C2', 'old Open in Booking Calendar still present');

if (!/<h3>Reply<\/h3>/.test(loadDetailJs)) pass('C3', 'Reply heading removed');
else fail('C3', 'Reply h3 still present');

if (/Reply:/.test(loadDetailJs) && !/Review and send reply/.test(loadDetailJs)) {
  pass('C4', 'Reply label retained');
} else fail('C4', 'Reply label missing or old text remains');
if (!/No Luna draft yet/.test(loadDetailJs)) pass('C4b', 'empty draft hint removed');
else fail('C4b', 'No Luna draft hint still present');

section('D. Booking Calendar Open Conversation');

if (/id=["']bc-open-conversation-toolbar["']/.test(src)) pass('D1', 'toolbar Open Conversation button');
else fail('D1', 'toolbar button missing');

if (/btn-success-light/.test(htmlSrc) && /Open Conversation/.test(src)) pass('D2', 'soft green Open Conversation style');
else fail('D2', 'btn-success-light / label missing');

if (/function bcOpenOrStartConversationFromBooking/.test(src) && /openInboxToConversation/.test(openConvJs)) {
  pass('D3', 'opens Inbox conversation path');
} else fail('D3', 'Inbox open path missing');

const footerFn = src.match(/function bcRenderBookingDrawerFooterHtml\([\s\S]*?\n\}/)?.[0] || '';

if (/Could not start conversation|bcShowOpenConversationStatus|Start Conversation/.test(src) &&
    /bcOpenOrStartConversationFromBooking/.test(src)) {
  pass('D4', 'conversation start/open status handling present');
} else fail('D4', 'not-found message missing');

if (/id=["']bc-open-conv-btn["']/.test(footerFn) || /id=["']bc-new-conversation-btn["']/.test(footerFn)) {
  pass('D5', 'footer uses Open/New Conversation button');
} else fail('D5', 'footer conversation button missing');

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

section('G. Inbox card badges');

const convListPillMatch = src.match(/function convListPill\([\s\S]*?\n\}/);
const convListPillJs = convListPillMatch ? convListPillMatch[0] : '';
if (!/URGENT/.test(convListPillJs) && !/HANDOFF/.test(convListPillJs)) {
  pass('G1', 'URGENT/HANDOFF badges not rendered in conv cards');
} else fail('G1', 'URGENT or HANDOFF still in convListPill');
if (/Needs Human/.test(convListPillJs) && /convSourcePill|pill-luna/.test(convListPillJs)) {
  pass('G2', 'Needs Human + Luna/Staff badges in list');
} else fail('G2', 'convListPill missing Needs Human or Luna/Staff');
if (/needs-human|setInboxFilter\s*\(\s*['"]needs-human['"]/.test(src)) pass('G3', 'Needs human filter retained');
else fail('G3', 'Needs human filter missing');

section('H. Matching Open/New Conversation buttons');

if (/btn-success-light[\s\S]{0,200}bc-open-conv-btn/.test(footerFn) ||
    /btn-success-light[\s\S]{0,200}bc-new-conversation-btn/.test(footerFn)) {
  pass('H1', 'Open/New Conversation uses btn-success-light in footer');
} else fail('H1', 'Open Conversation style mismatch');
if (/btn-success-light[\s\S]{0,200}bc-new-conversation-btn/.test(footerFn) ||
    /btn-success-light[\s\S]{0,200}bc-open-conv-btn/.test(footerFn)) {
  pass('H2', 'footer conversation button uses btn-success-light');
} else fail('H2', 'New Conversation style mismatch');
if (!/btn-bc-create-soft[\s\S]{0,200}bc-new-conversation-btn/.test(footerFn)) {
  pass('H3', 'legacy btn-bc-create-soft removed from footer');
} else fail('H3', 'New Conversation still uses btn-bc-create-soft');

section('L. Inbox Luna/Staff pebble + drawer footer layout');

if (/function inboxLunaStaffPill/.test(src) && /\.pill-luna\{/.test(htmlSrc) && /\.pill-staff-source\{/.test(htmlSrc)) {
  pass('L1', 'Inbox Luna/Staff pebble styles');
} else fail('L1', 'Inbox pebble styles missing');
if (/convHeaderStatusPillsHtml\(c,\s*lunaGuestPaused\)/.test(loadDetailJs)) {
  pass('L2', 'Inbox header uses pause state for pebble');
} else fail('L2', 'convHeaderStatusPillsHtml not wired in detail load');
if (/detail-header-pills/.test(src.match(/function updateLunaPauseUiInPlace[\s\S]*?\n\}/)?.[0] || '')) {
  pass('L3', 'Pause Luna toggle updates pebble in place');
} else fail('L3', 'pebble in-place update missing');

const drawerJs = src.match(/function renderBookingContextDrawer\([\s\S]*?^function toGetClient/m)?.[0] || '';
if (/id="bc-move-bed"/.test(drawerJs) &&
    /bcRenderServicesTabHtml/.test(drawerJs) &&
    /bcRenderAddServicePanelHtml/.test(src) &&
    /bcRenderRunningInvoiceHtml/.test(drawerJs) &&
    /id="bc-drawer-tab-payments"/.test(drawerJs)) {
  pass('L4', 'Move bed on overview; add-ons in Services tab; invoice in Payments tab');
} else fail('L4', 'section order incorrect');
if (/Cancel Booking/.test(footerFn) && /bc-drawer-footer-right/.test(footerFn)) {
  pass('L5', 'footer has Cancel Booking on drawer bottom right');
} else fail('L5', 'drawer footer cancel missing');
if (/bc-drawer-footer-left/.test(footerFn) && /bc-drawer-footer-right/.test(footerFn)) {
  pass('L6', 'footer left/right conversation and cancel layout');
} else fail('L6', 'footer alignment layout missing');

section('I. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:staff-inbox-calendar-ui-polish']) pass('I1', 'npm script registered');
else fail('I1', 'npm script missing');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
