/**
 * Staff Inbox UI polish — scroll, in-place switches, booking calendar link.
 *
 * Usage:
 *   npm run verify:staff-inbox-ui-polish
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

console.log('\nverify-staff-inbox-ui-polish.js\n');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api.js passes node --check');
} catch {
  fail('0', 'staff-query-api.js syntax error');
}

const src = fs.readFileSync(API_FILE, 'utf8');
const htmlMatch = src.match(/function buildUiHtml\(port\)\s*\{([\s\S]*?)^function handleUI/m);
const htmlSrc = htmlMatch ? htmlMatch[1] : src;

const nhToggleMatch = src.match(/function wireNeedsHumanToggle\([\s\S]*?\n\}/);
const nhToggleJs = nhToggleMatch ? nhToggleMatch[0] : '';

const pauseSwitchMatch = src.match(/function wireLunaPauseSwitch\([\s\S]*?\n\}/);
const pauseSwitchJs = pauseSwitchMatch ? pauseSwitchMatch[0] : '';

const loadDetailMatch = src.match(/function loadConvDetail\(convId[\s\S]*?function wireNeedsHumanToggle\(/);
const loadDetailJs = loadDetailMatch ? loadDetailMatch[0] : '';

section('A. Left conversation list scroll');

if (/id=["']conv-list["'][^>]*class=["'][^"']*conv-list/.test(htmlSrc)) {
  pass('A1', 'conv-list element has conv-list class');
} else fail('A1', 'conv-list class missing on #conv-list');

if (/\.inbox-left-rows\{[^}]*overflow-y:\s*auto/.test(htmlSrc)) {
  pass('A2', 'inbox-left-rows scroll container');
} else fail('A2', 'inbox-left-rows overflow missing');

if (/\.inbox-left\{[^}]*min-height:\s*0/.test(htmlSrc)) pass('A3', 'inbox-left min-height 0');
else fail('A3', 'inbox-left min-height missing');

if (/\.inbox-left-toolbar\{[^}]*flex-shrink:\s*0/.test(htmlSrc)) {
  pass('A4', 'toolbar stays outside scroll area');
} else fail('A4', 'toolbar flex-shrink missing');

if (/#tab-conversations\.active #wrap\{[^}]*min-height:\s*0/.test(htmlSrc)) {
  pass('A5', 'inbox wrap flex height chain');
} else fail('A5', 'tab-conversations #wrap min-height missing');

section('B. Switch handlers avoid full reload');

if (!pauseSwitchJs.includes('loadConvDetail')) pass('B1', 'Pause Luna switch does not reload conversation detail');
else fail('B1', 'Pause Luna still calls loadConvDetail');

if (pauseSwitchJs.includes('updateLunaPauseUiInPlace')) pass('B2', 'Pause Luna updates UI in place');
else fail('B2', 'updateLunaPauseUiInPlace missing');

if (!nhToggleJs.includes('loadConvDetail') && !nhToggleJs.includes('loadInbox')) {
  pass('B3', 'Needs human switch does not reload detail/inbox fetch');
} else fail('B3', 'Needs human still triggers full reload');

if (!nhToggleJs.includes('location.reload') && !pauseSwitchJs.includes('location.reload')) {
  pass('B4', 'no location.reload in switch handlers');
} else fail('B4', 'location.reload found');

if (nhToggleJs.includes('updateNeedsHumanBadgeInPlace') || nhToggleJs.includes('updateInboxConvCardNeedsHuman')) {
  pass('B5', 'Needs human updates badges/list in place');
} else fail('B5', 'in-place needs human update missing');

if (nhToggleJs.includes('preserveDetail') || nhToggleJs.includes('refreshInboxListPreserveDetail')) {
  pass('B6', 'targeted inbox list refresh supported');
} else fail('B6', 'preserveDetail list refresh missing');

section('C. Bot State switches retained');

if (/bot-state-switches/.test(loadDetailJs)) pass('C1', 'Bot State switches present');
else fail('C1', 'bot-state-switches missing');

if (/inbox-switch-orange/.test(loadDetailJs) && /inbox-switch-red/.test(loadDetailJs)) {
  pass('C2', 'orange/red switch styling retained');
} else fail('C2', 'switch color classes missing');

section('D. Booking Calendar deep link');

if (/Open in Booking Calendar/.test(loadDetailJs)) pass('D1', 'booking card link label present');
else fail('D1', 'Open in Booking Calendar missing');

if (/id=["']inbox-open-booking-cal["']/.test(loadDetailJs)) pass('D2', 'link button id present');
else fail('D2', 'inbox-open-booking-cal missing');

if (/function openBookingInCalendar/.test(src)) pass('D3', 'openBookingInCalendar helper');
else fail('D3', 'openBookingInCalendar missing');

if (/openBookingInCalendar\s*\(\s*\{[\s\S]*booking_(id|code)/.test(loadDetailJs)) {
  pass('D4', 'link passes booking_id/booking_code');
} else fail('D4', 'booking identifiers not passed');

if (/switchToTabOnly\s*\(\s*['"]bed-calendar['"]\)/.test(src.match(/function openBookingInCalendar[\s\S]*?\n\}/)?.[0] || '')) {
  pass('D5', 'switches to Booking Calendar tab');
} else fail('D5', 'bed-calendar tab switch missing');

if (/showBlockDetail/.test(src.match(/function openBookingInCalendar[\s\S]*?\n\}/)?.[0] || '')) {
  pass('D6', 'attempts to open booking block/detail');
} else fail('D6', 'showBlockDetail not used');

const openCalJs = src.match(/function openBookingInCalendar\([\s\S]*?\n\}/)?.[0] || '';

section('E. Safety');

if (!openCalJs.includes('/staff/bot/guest-reply-send') && !loadDetailJs.includes('/staff/bot/guest-reply-send')) {
  pass('E1', 'no guest-reply-send in inbox UI paths');
} else fail('E1', 'guest-reply-send found in inbox UI');

if (!/api\.stripe\.com/.test(htmlSrc) && !/graph\.facebook\.com/.test(htmlSrc)) {
  pass('E2', 'no Stripe/Graph in inbox UI');
} else fail('E2', 'Stripe or Graph found');

if (!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(htmlSrc))) {
  pass('E3', 'no n8n fetch in inbox UI');
} else fail('E3', 'n8n fetch found');

section('F. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:staff-inbox-ui-polish']) {
  pass('F1', 'npm script registered');
} else fail('F1', 'npm script missing');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
