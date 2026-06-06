/**
 * Staff Portal UI product cleanup verifier.
 *
 * Usage:
 *   npm run verify:staff-portal-ui-product-cleanup
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

console.log('\nverify-staff-portal-ui-product-cleanup.js\n');

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
const nhToggleFn = src.match(/function wireNeedsHumanToggle\([\s\S]*?\n\}/)?.[0] || '';
const nhHandlerFn = src.match(/async function handleConversationNeedsHuman\([\s\S]*?\n\}/)?.[0] || '';

section('A. Navigation / default tab');

if (/data-tab="bed-calendar"[^>]*>Booking Calendar/.test(htmlSrc)) {
  pass('A1', 'Booking Calendar nav label present');
} else fail('A1', 'Booking Calendar nav label missing');

if (/data-tab="bed-calendar"[^>]*class="tab-btn active"/.test(htmlSrc)
  || /class="tab-btn active"[^>]*data-tab="bed-calendar"/.test(htmlSrc)) {
  pass('A2', 'Booking Calendar is default active nav tab');
} else fail('A2', 'Booking Calendar not default nav tab');

const navOrder = htmlSrc.match(/<div id="tabs">([\s\S]*?)<\/div>/);
const navBlock = navOrder ? navOrder[1] : '';
const bcIdx = navBlock.indexOf('data-tab="bed-calendar"');
const inboxIdx = navBlock.indexOf('data-tab="conversations"');
if (bcIdx >= 0 && inboxIdx > bcIdx) pass('A3', 'Inbox is second nav tab after Booking Calendar');
else fail('A3', 'Inbox not second in nav');

if (!/data-tab="today"/.test(navBlock)) pass('A4', 'Today removed from main nav');
else fail('A4', 'Today still in main nav');

if (/id="tab-bed-calendar"[^>]*class="tab-panel active"/.test(htmlSrc)) {
  pass('A5', 'Booking Calendar panel active by default');
} else fail('A5', 'Booking Calendar panel not default active');

section('B. Booking Calendar labels + legend');

if (!/>\s*Bed Calendar\s*</.test(htmlSrc)) pass('B1', 'no user-visible Bed Calendar heading');
else fail('B1', 'Bed Calendar text still visible in UI HTML');

if (/>\s*Booking Calendar\s*</.test(htmlSrc)) pass('B2', 'Booking Calendar heading present');
else fail('B2', 'Booking Calendar heading missing');

const legendMatch = htmlSrc.match(/id="bc-legend"[\s\S]*?<\/div>/);
const legend = legendMatch ? legendMatch[0] : '';
const lunaIdx = legend.indexOf('>Luna<');
const staffIdx = legend.indexOf('>Staff<');
const tourIdx = legend.toLowerCase().indexOf('tour operator');
if (lunaIdx >= 0 && staffIdx > lunaIdx && tourIdx > staffIdx) {
  pass('B3', 'legend order Luna → Staff → Tour operator');
} else fail('B3', 'legend order incorrect');

if (!legend.includes('Staff / manual')) pass('B4', 'Staff / manual label removed');
else fail('B4', 'Staff / manual still visible');

section('C. Needs Human UI + route');

if (/conv-needs-human-toggle/.test(loadDetailJs)) pass('C1', 'Needs human toggle in Inbox detail');
else fail('C1', 'Needs human toggle missing');

if (/wireNeedsHumanToggle/.test(src)) pass('C2', 'Needs human toggle wiring present');
else fail('C2', 'toggle wiring missing');

if (/handleConversationNeedsHuman/.test(src)) pass('C3', 'needs-human handler present');
else fail('C3', 'needs-human handler missing');

if (/CONV_NEEDS_HUMAN_RE/.test(src) && /requireAuth\(req, res, 'operator'\)/.test(
  src.slice(src.indexOf('convNeedsHumanMatch'), src.indexOf('convNeedsHumanMatch') + 600),
)) {
  pass('C4', 'needs-human route requires operator auth');
} else fail('C4', 'needs-human operator auth missing');

if (nhToggleFn.includes('/needs-human') && !nhToggleFn.includes('guest-reply-send')) {
  pass('C5', 'toggle uses needs-human route, not guest-reply-send');
} else fail('C5', 'toggle route wiring issue');

if (/UPDATE conversations conv/.test(nhHandlerFn) && !/staff_handoffs/.test(nhHandlerFn)) {
  pass('C6', 'handler updates conversations.needs_human only');
} else fail('C6', 'handler scope unclear');

section('D. Warning copy removed');

if (!htmlSrc.includes('Resolve actions are disabled')) pass('D1', 'resolve-disabled warning removed');
else fail('D1', 'resolve-disabled warning still visible');

if (!htmlSrc.includes('READ-ONLY HANDOFF QUEUE')) pass('D2', 'READ-ONLY HANDOFF QUEUE removed');
else fail('D2', 'READ-ONLY HANDOFF QUEUE still visible');

section('E. Safety unchanged');

if (!nhHandlerFn.includes('graph.facebook.com')) pass('E1', 'no Graph in needs-human handler');
else fail('E1', 'Graph reference in needs-human handler');

if (!nhHandlerFn.includes('api.stripe.com')) pass('E2', 'no Stripe in needs-human handler');
else fail('E2', 'Stripe in needs-human handler');

if (!nhHandlerFn.includes('n8n')) pass('E3', 'no n8n in needs-human handler');
else fail('E3', 'n8n in needs-human handler');

if (htmlSrc.includes('/staff/inbox/send-reply') && htmlSrc.includes('btn-send-reply')) {
  pass('E4', 'Inbox send UI retained');
} else fail('E4', 'Inbox send UI missing');

section('F. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:staff-portal-ui-product-cleanup']) {
  pass('F1', 'npm script registered');
} else fail('F1', 'npm script missing');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
