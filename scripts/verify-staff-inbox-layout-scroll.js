/**
 * Staff Inbox layout scroll — static CSS/HTML verifier.
 *
 * Usage:
 *   npm run verify:staff-inbox-layout-scroll
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

console.log('\nverify-staff-inbox-layout-scroll.js\n');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api.js passes node --check');
} catch {
  fail('0', 'staff-query-api.js syntax error');
}

const src = fs.readFileSync(API_FILE, 'utf8');
const htmlMatch = src.match(/function buildUiHtml\(port\)\s*\{([\s\S]*?)^function handleUI/m);
const htmlSrc = htmlMatch ? htmlMatch[1] : src;

section('A. Left conversation list scroll');

if (/\.conv-list\{[^}]*overflow-y:\s*auto/.test(htmlSrc)) pass('A1', 'conv-list overflow-y auto');
else fail('A1', 'conv-list scroll missing');

if (/\.conv-list\{[^}]*min-height:\s*0/.test(htmlSrc)) pass('A2', 'conv-list min-height 0 for flex scroll');
else fail('A2', 'conv-list min-height 0 missing');

if (/\.inbox-left-toolbar\{[^}]*flex-shrink:\s*0/.test(htmlSrc)) pass('A3', 'inbox toolbar stays fixed');
else fail('A3', 'inbox toolbar flex-shrink missing');

section('B. Center pane flex column');

if (/#conv-detail\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/.test(htmlSrc)) {
  pass('B1', 'conv-detail flex column');
} else fail('B1', 'conv-detail flex column missing');

if (/#detail-content\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/.test(htmlSrc)) {
  pass('B2', 'detail-content flex column');
} else fail('B2', 'detail-content flex column missing');

if (/\.detail-main\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/.test(htmlSrc)) {
  pass('B3', 'detail-main flex column');
} else fail('B3', 'detail-main flex column missing');

if (/\.detail-layout\{[^}]*flex:\s*1/.test(htmlSrc)) pass('B4', 'detail-layout fills available height');
else fail('B4', 'detail-layout flex grow missing');

section('C. Thread scroll + reply composer pinned');

if (/\.thread-section\{[^}]*flex:\s*1/.test(htmlSrc)) pass('C1', 'thread-section grows');
else fail('C1', 'thread-section flex missing');

if (/\.thread\{[^}]*overflow-y:\s*auto/.test(htmlSrc)) pass('C2', 'thread overflow-y auto');
else fail('C2', 'thread scroll missing');

if (!/\.thread\{[^}]*max-height:\s*420px/.test(htmlSrc)) {
  pass('C3', 'fixed 420px thread cap removed');
} else fail('C3', 'thread still capped at 420px');

if (/\.draft-panel\{[^}]*flex-shrink:\s*0/.test(htmlSrc)) pass('C4', 'draft panel pinned at bottom');
else fail('C4', 'draft panel flex-shrink missing');

section('D. Sidebar + workspace height');

if (/\.detail-sidebar\{[^}]*overflow-y:\s*auto/.test(htmlSrc)) pass('D1', 'sidebar can scroll independently');
else fail('D1', 'sidebar scroll missing');

if (/#wrap\{[^}]*height:\s*calc\(100vh/.test(htmlSrc)) pass('D2', 'inbox wrap uses viewport height');
else fail('D2', 'viewport height on #wrap missing');

if (/\.inbox-two-col\{[^}]*min-height:\s*0/.test(htmlSrc)) pass('D3', 'inbox-two-col min-height 0');
else fail('D3', 'inbox-two-col min-height missing');

section('E. Send route + debug panels unchanged');

const inboxJsMatch = src.match(/function wireInboxSendReply\([\s\S]*?function loadConvDetail\(/);
const inboxJs = inboxJsMatch ? inboxJsMatch[0] : '';

if (inboxJs.includes('/staff/inbox/send-reply')) pass('E1', 'send route unchanged');
else fail('E1', 'send route missing');

if (/btn-send-reply|Send reply/.test(src)) pass('E2', 'send button still present');
else fail('E2', 'send button missing');

if (/inbox-bottom-debug-panels[\s\S]*display:\s*none/.test(htmlSrc)) {
  pass('E3', 'bottom debug panels remain hidden');
} else fail('E3', 'debug panel hide CSS missing');

if (!/#conv-detail\{[^}]*overflow-y:\s*auto/.test(htmlSrc)) {
  pass('E4', 'conv-detail no longer scrolls whole pane');
} else fail('E4', 'conv-detail still uses overflow-y auto on whole pane');

section('F. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:staff-inbox-layout-scroll']) {
  pass('F1', 'npm script registered');
} else fail('F1', 'npm script missing');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
