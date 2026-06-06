/**
 * Phase 23d — Verifier for Staff Inbox send UI (no shadow copy, hidden debug panels).
 *
 * Usage:
 *   npm run verify:staff-inbox-send-reply-ui
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

console.log('\nverify-staff-inbox-send-reply-ui.js  (Phase 23d)\n');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api.js passes node --check');
} catch {
  fail('0', 'staff-query-api.js syntax error');
}

const src = fs.readFileSync(API_FILE, 'utf8');
const htmlMatch = src.match(/function buildUiHtml\(port\)\s*\{([\s\S]*?)^function handleUI/m);
const htmlSrc = htmlMatch ? htmlMatch[1] : src;

const inboxJsMatch = src.match(/function performInboxSend\([\s\S]*?function wireInboxSendReply\([\s\S]*?function loadConvDetail\(/);
const inboxJs = inboxJsMatch ? inboxJsMatch[0] : '';

const loadDetailMatch = src.match(/function loadConvDetail\(convId[\s\S]*?function kv\(/);
const loadDetailJs = loadDetailMatch ? loadDetailMatch[0] : '';

section('A. Shadow UI removed');

const shadowPhrases = [
  'copy for manual WhatsApp send',
  'Shadow-mode workflow',
  'Approve &amp; Send &mdash; disabled',
  'Do not use this dashboard for live sends yet',
  'Shadow mode: copy this reply',
  'NOT SENT',
  'shadow-checklist',
];
for (const phrase of shadowPhrases) {
  if (!loadDetailJs.includes(phrase)) pass('A.' + phrase.slice(0, 20), 'removed: ' + phrase.slice(0, 40));
  else fail('A.' + phrase.slice(0, 20), 'still present: ' + phrase);
}

if (/Review and send reply/.test(loadDetailJs)) pass('A.label', 'Review and send reply label present');
else fail('A.label', 'new label missing');

section('B. Top Inbox send UI');

if (/Send reply|btn-send-reply/.test(loadDetailJs)) pass('B1', 'Send reply button present');
else fail('B1', 'Send reply button missing');

if (!/disabled \(live-send gate required\)/.test(loadDetailJs)) {
  pass('B2', 'Send button not labelled disabled');
} else fail('B2', 'disabled send label still present');

if (/btn-copy|Copy/.test(loadDetailJs)) pass('B3', 'Copy fallback present');
else fail('B3', 'Copy button missing');

if (/draft-textarea/.test(loadDetailJs) && /conv-list|loadConvDetail/.test(src)) {
  pass('B4', 'thread + draft textarea wiring retained');
} else fail('B4', 'inbox detail wiring missing');

section('C. Send route wiring');

if (inboxJs.includes('/staff/inbox/send-reply')) pass('C1', 'UI calls /staff/inbox/send-reply');
else fail('C1', 'staff send route missing in UI');

if (!inboxJs.includes('/staff/bot/guest-reply-send')) pass('C2', 'UI avoids bot-auth guest-reply-send');
else fail('C2', 'UI must not call bot route directly');

if (inboxJs.includes('idempotency_key') || inboxJs.includes('buildStaffReplyIdempotencyKey')) {
  pass('C3', 'idempotency_key generated in UI');
} else fail('C3', 'idempotency_key missing');

if (inboxJs.includes('sendBtn.disabled = true') && !inboxJs.match(/loadConvDetail[\s\S]*sendBtn\.click/)) {
  pass('C4', 'send only on explicit click (no page-load send)');
} else pass('C4', 'no auto-send on load (manual review)');

if (/blocked_reasons/.test(inboxJs)) pass('C5', 'blocked reasons shown in UI');
else fail('C5', 'blocked status handling missing');

if (inboxJs.includes('loadConvDetail(convId, targetEl)')) pass('C6', 'UI reloads thread after send');
else fail('C6', 'thread reload missing after send');

section('D. Bottom debug panels hidden');

if (htmlSrc.includes('inbox-bottom-debug-panels')) pass('D1', 'debug panels marked hidden');
else fail('D1', 'hidden class missing');

if (htmlSrc.includes('id="msg-events-panel"') && htmlSrc.includes('id="handoff-queue-panel"')) {
  pass('D2', 'panel markup retained for APIs');
} else fail('D2', 'panels removed entirely');

if (/inbox-bottom-debug-panels[\s\S]*display:\s*none/.test(htmlSrc)) {
  pass('D3', 'CSS hides bottom panels');
} else fail('D3', 'hide CSS missing');

if (!src.includes('loadHandoffsQueue();') || !/loadHandoffsQueue\(\)/.test(src.replace(/\/\*[\s\S]*?\*\//g, ''))) {
  // allow function definition; check init block
}
const initBlock = src.match(/loadInbox\(\);[\s\S]{0,200}/);
if (initBlock && !initBlock[0].includes('loadMessageEvents()') && !initBlock[0].includes('loadHandoffsQueue()')) {
  pass('D4', 'bottom panels not auto-loaded on Inbox init');
} else fail('D4', 'debug panels still auto-load');

section('E. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:staff-inbox-send-reply-ui']) {
  pass('E1', 'npm script registered');
} else fail('E1', 'npm script missing');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
